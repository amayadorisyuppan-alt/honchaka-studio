// 取り込んだ画像を、刷るのに要る大きさ・形にそろえる。EPUB 用の軽い画像もここで作る。
//
// **紙はくっきり、電子は軽く。**(2026-09-26 ユーザーと決定。見直し S2-17・S2-5・S2-16)
// - 取り込むとき(optimizeImageDataUri): 刷るのに要る大きさまで縮め、高画質の JPEG(品質95)で持つ。
//   カメラの 12000px の写真をそのまま持つと、紙の PDF の書き出しに約3分・保存が 21MB になった。
//   透けている絵(JPEG にすると抜いた部分が黒く潰れる)と、PNG のほうが小さい線画は PNG のまま。
//   もとが JPEG で縮める必要が無ければ、そのまま持つ(描き直すと1回ぶん劣化するだけ)
// - EPUB を書き出すとき(lightenForEbook): 長い辺 1600px・品質82の軽い画像を別に作る。
//   紙用の画像をそのまま入れると重いだけで、KDP の70%ロイヤリティでは1MBごとに配信料がかかる
//   (日本は1MBあたり1円。10MB以上は差し引かない)。WebP・BMP・AVIF もここで JPEG / PNG にする
//   (KDP の対応形式は GIF・PNG・BMP・JPEG、Kobo の検査は WebP を標準外として扱う)
// - **読めない画像は取り込まない。** 拡張子だけ .png のテキストや途中で切れた PNG は、前は何も言わずに
//   入り、紙では白紙や黒塗り、EPUB には画像でない中身がそのまま入っていた。
//   <img> は途中で切れた PNG でも読めたことにするので、createImageBitmap で最後まで読めるかを見る
//
// ブラウザ専用(canvas を使う)。CLI の検証経路はこの入口を通らない。

import { isRenderableImage, imageFormatLabel } from '../models/project';

/** これより小さい PNG は触らない。変換の手間に見合わないうえ、劣化だけが残ることがある */
const MIN_BYTES = 128 * 1024;

/**
 * 紙に刷るのに要る大きさの上限(長い辺の画素)。
 * いちばん大きい判型 A4 の全面(塗り足し込み 213.2×303.4mm。印刷所の四辺3mmなら 216×303mm)を、
 * 出し先の目安に 350ppi を見込んで約 4180px。
 * (2026-10-03 に 3600 から上げた。3600 では 300ppi の A4 全面までしか入らず、350ppi に届かなかった)
 * 上げすぎない: 12Mpx(4200×2900)の絵の読み込みは約 50MB、保存は JPEG 品質95で 3600 のときの約 1.4 倍
 */
export const PRINT_MAX_SIDE = 4200;
/** 表紙の「まるごと1枚」(A4 の表1・背・表4 で、350ppi なら約 6030px(700ページまでの背で約 6140px)。3600 → 4200 と同じ理由で 5400 から上げた) */
export const WRAP_MAX_SIDE = 6200;
/** 刷る画像の JPEG の品質。100 にすると容量が約2倍になるのに、見た目の差は出ない(2026-09-26 実測) */
const PRINT_JPEG_QUALITY = 0.95;
/** EPUB の画像の長い辺。全面の挿絵が端末の画面いっぱいに出る大きさ(Kindle は全面の絵に 1200px 以上を求める) */
const EBOOK_MAX_SIDE = 1600;
const EBOOK_JPEG_QUALITY = 0.82;
/** EPUB で、もとの PNG / JPEG をそのまま使ってよい大きさ(縮める必要も無く、軽いもの) */
const EBOOK_KEEP_BYTES = 400 * 1024;

const UNREADABLE =
  '画像を読み込めませんでした（壊れているか、画像ではないファイルです）。別の画像を選んでください';

/** data URI のおおよそのバイト数(base64 は元データの約 4/3) */
function approxBytes(dataUri: string): number {
  const i = dataUri.indexOf(',');
  return i < 0 ? dataUri.length : Math.floor(((dataUri.length - i - 1) * 3) / 4);
}

function mimeOf(src: string): string {
  return (/^data:([^;,]+)/.exec(src)?.[1] ?? '').toLowerCase();
}

/** 最後まで読める画像か。途中で切れた PNG は <img> では読めたことになるが、こちらは断る */
async function decode(src: string): Promise<ImageBitmap> {
  const blob = await (await fetch(src)).blob();
  return createImageBitmap(blob);
}

/** 1画素でも透けていれば true。透過が「あるか」ではなく「使われているか」を見る */
function usesTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

/**
 * 長い辺を maxSide までに縮めて描き、透けているかどうかと一緒に返す。
 * 透かしの有無は、透かしを持てる形式(JPEG と BMP 以外)のときだけ調べる
 */
function draw(bmp: ImageBitmap, maxSide: number, mime: string) {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error(UNREADABLE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const alpha =
    mime !== 'image/jpeg' && mime !== 'image/bmp'
      ? usesTransparency(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
      : false;
  return { canvas, ctx, scale, alpha };
}

/** JPEG に alpha は無いので、白い下地を敷いてから書き出す */
function toJpeg(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, quality: number): string {
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * **取り込んだ画像を、刷るのに要る大きさ・形にそろえる。**
 * 読めない画像は、利用者に見せる言葉で例外を投げる(呼び出し側がそのまま画面に出す)。
 * `maxSide` は長い辺の上限(既定は本文の全面ぶん。表紙の「まるごと1枚」は WRAP_MAX_SIDE)
 */
export async function optimizeImageDataUri(src: string, maxSide = PRINT_MAX_SIDE): Promise<string> {
  if (!src.startsWith('data:image/')) return src;
  const mime = mimeOf(src);
  if (mime === 'image/svg+xml') return src; // 線の絵。大きさを持たないので縮めない
  if (!isRenderableImage(src)) {
    throw new Error(
      `${imageFormatLabel(src) || 'この'} 形式の画像は使えません。JPEG か PNG に書き出してから選んでください`,
    );
  }
  let bmp: ImageBitmap;
  try {
    bmp = await decode(src);
  } catch {
    throw new Error(UNREADABLE);
  }
  const bytes = approxBytes(src);
  const bigger = Math.max(bmp.width, bmp.height) > maxSide;
  // 縮める必要が無ければ、JPEG・WebP・AVIF はそのまま持つ(紙は Chrome が刷るので WebP・AVIF でも出る。
  // JPEG に描き直すと、かえって大きくなった: WebP 1.1MB → 2.1MB。EPUB には書き出すときに直す)
  const keep = mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/avif';
  if (!bigger && (keep || (mime === 'image/png' && bytes < MIN_BYTES))) {
    bmp.close();
    return src;
  }
  const { canvas, ctx, alpha } = draw(bmp, maxSide, mime);
  bmp.close();
  const native = mime === 'image/jpeg' || mime === 'image/png';
  let out: string;
  if (alpha) {
    out = canvas.toDataURL('image/png');
  } else {
    const png = mime === 'image/jpeg' ? '' : canvas.toDataURL('image/png');
    const jpeg = toJpeg(canvas, ctx, PRINT_JPEG_QUALITY);
    // 線画や色数の少ない絵は PNG のほうが小さく、くっきりする
    out = png && png.length < jpeg.length ? png : jpeg;
  }
  // 縮めていないのに大きくなったら、もとのままのほうがよい
  return !bigger && native && out.length >= src.length ? src : out;
}

/**
 * **EPUB に入れる軽い画像を作る。** 読めない画像は null(呼び出し側で図版ごと落とし、数を言う)。
 * もとが軽い PNG / JPEG ならそのまま返す
 */
export async function lightenForEbook(src: string): Promise<string | null> {
  if (!src.startsWith('data:image/')) return src;
  const mime = mimeOf(src);
  if (mime === 'image/svg+xml') return src;
  let bmp: ImageBitmap;
  try {
    bmp = await decode(src);
  } catch {
    return null;
  }
  const native = mime === 'image/jpeg' || mime === 'image/png';
  const bigger = Math.max(bmp.width, bmp.height) > EBOOK_MAX_SIDE;
  if (!bigger && native && approxBytes(src) < EBOOK_KEEP_BYTES) {
    bmp.close();
    return src;
  }
  const { canvas, ctx, alpha } = draw(bmp, EBOOK_MAX_SIDE, mime);
  bmp.close();
  const out = alpha ? canvas.toDataURL('image/png') : toJpeg(canvas, ctx, EBOOK_JPEG_QUALITY);
  return !bigger && native && out.length >= src.length ? src : out;
}

/** 複数枚まとめて。1枚ごとの失敗は元の絵を残すだけなので、全体は止めない */
export async function optimizeAll(srcs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of srcs) {
    try {
      out.push(await optimizeImageDataUri(s));
    } catch {
      out.push(s);
    }
  }
  return out;
}
