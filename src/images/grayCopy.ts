// 「白黒で刷る」絵の、灰色の写しを作る。(2026-10-12 1.1.0。修正リストの 4-1・4-6)
//
// ## なぜ写しを作るのか
//
// - **4-1(白黒の本)**: 前は紙の組版で `img { filter: grayscale(1) }` を掛けていた。Chrome は CSS の filter を掛けた絵を、
//   PDF にするとき 300dpi で描き直すので、細かい絵は粗くなり、粗い絵は 300dpi に引き伸ばされた(検査で粗さが見えなくなる)。
//   写しを使えば filter が要らず、元の画素のまま PDF に入る
// - **4-6(カラーの本で、絵ごとに白黒で刷る)**: 写しは R=G=B ちょうどの灰色なので、入稿用の変換(press/neutral.ts)が
//   DeviceGray に書き換え、K だけで刷られる。濃さは白黒の本と同じ直し(press/grayTone.ts)を通る
//
// ## 作り方
//
// - 灰色の式は CSS の grayscale(1) と同じ(0.2126・0.7152・0.0722。sRGB の値にそのまま掛ける)。白黒の本の見た目を今と変えない
// - JPEG で書く。**灰色ちょうどの画素は、JPEG にしても R=G=B のまま戻る**(色差の成分がちょうど 128 になる。
//   neutral.ts は JPEG を 2 段までのずれで無彩色と見る)。透明のある絵(PNG の切り抜きなど)は、JPEG にすると透明が黒くなるので PNG
// - 写しは blob URL で持つ(組版の assetUrl はそのまま通す。data URI にすると、組むたびに大きな base64 を作り直す)。
//   同じ絵は1回だけ作る。保存はしない(開き直したら作り直す)
// - ブラウザでしか作れない。node の検査では写しが無く、組版は前と同じ filter に戻る(css.ts の img:not(.gray-copy))

/** 元の絵(data URI など)→ 灰色の写しの blob URL */
const made = new Map<string, string>();
/** 作っている途中のもの */
const making = new Map<string, Promise<void>>();
/** 作れなかった絵(壊れている・読めない)。何度も作り直さない */
const failed = new Set<string>();

/** 灰色の写し。まだ作っていない・作れなかったときは undefined */
export function grayCopyOf(src: string): string | undefined {
  return made.get(src);
}

/** 写しを作れなかった絵か */
export function grayCopyFailed(src: string): boolean {
  return failed.has(src);
}

const JPEG_QUALITY = 0.95;

async function makeOne(src: string): Promise<void> {
  try {
    const blob = await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = img.data;
    let alpha = false;
    for (let i = 0; i < px.length; i += 4) {
      const y = Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
      px[i] = y;
      px[i + 1] = y;
      px[i + 2] = y;
      if (px[i + 3] !== 255) alpha = true;
    }
    ctx.putImageData(img, 0, 0);
    const out = await new Promise<Blob | null>((resolve) =>
      alpha ? canvas.toBlob(resolve, 'image/png') : canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!out) throw new Error('toBlob failed');
    made.set(src, URL.createObjectURL(out));
  } catch (e) {
    console.warn('gray copy failed', e);
    failed.add(src);
  }
}

/**
 * 写しを作る。**全部そろっていれば null を返す**(呼ぶ側は待たずに組める)。
 * 同時に作るのは2枚まで(大きな絵を何枚も一度にほどくと、メモリを食って画面が固まる)
 */
export function prepareGrayCopies(srcs: Iterable<string>): Promise<void> | null {
  if (typeof document === 'undefined') return null;
  const todo = [...new Set(srcs)].filter((s) => s && !made.has(s) && !failed.has(s));
  if (todo.length === 0) return null;
  const queue = [...todo];
  const worker = async () => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      let p = making.get(s);
      if (!p) {
        p = makeOne(s).finally(() => making.delete(s));
        making.set(s, p);
      }
      await p;
    }
  };
  return Promise.all([worker(), worker()]).then(() => undefined);
}
