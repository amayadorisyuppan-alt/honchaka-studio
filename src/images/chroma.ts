// 絵の「色のずれ」(画素ごとの R・G・B の最大−最小)を測る。(2026-10-12 1.1.0。修正リストの 4-6)
//
// カラーの本で、**白黒に見えるのに色の情報を持つ絵**(生成AIの白黒の絵・灰色の写真や模様)と、
// **セピアのような、ごく淡い色の絵**を見分けて知らせるのに使う(判定は models/printColor.ts の colorLookOf)。
// 黙って白黒にはしない(10/10 ユーザー決定「知らせて、利用者に選んでもらう」)。
//
// 速さのため、長い辺を 1024px に縮めてから測る(縮めると、まばらな色の点はならされて少し小さく出る。
// 境目は縮めた値で決めた。10/12 に同梱の絵 101 枚と生成AIの千鳥で測った)。測った値は絵ごとに覚えておく(保存はしない)

export interface ChromaStats {
  /** ずれの平均(0〜255) */
  mean: number;
  /** ずれの 99.9% 点 */
  p999: number;
  /**
   * **入稿用の変換が無彩色と見る絵か**(press/neutral.ts と同じ基準: JPEG は全画素のずれが 2 段まで、ほかは 0)。
   * そういう絵は変換で K だけになるので、「色の情報を持っています」と知らせてはいけない
   * (サンプルの章の途中の千鳥は、灰色ちょうどの JPEG)。縮めた値でずれがほぼ無い絵だけ、元の大きさで測り直す
   */
  neutral: boolean;
}

const MAX_SIDE = 1024;
const stats = new Map<string, ChromaStats>();
const measuring = new Map<string, Promise<void>>();
const failed = new Set<string>();

/** 測った値。まだ測っていない・測れなかったときは undefined */
export function chromaOf(src: string): ChromaStats | undefined {
  return stats.get(src);
}

async function measureOne(src: string): Promise<void> {
  try {
    const blob = await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bmp, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const hist = new Uint32Array(256);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      // 透明な所は刷られないので数えない
      if (px[i + 3] < 128) continue;
      const d = Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]);
      hist[d]++;
      sum += d;
      n++;
    }
    let acc = 0;
    let p999 = 0;
    for (let d = 0; d < 256 && n > 0; d++) {
      acc += hist[d];
      if (acc >= n * 0.999) {
        p999 = d;
        break;
      }
    }
    // ずれがほぼ無い絵だけ、元の大きさで「変換が無彩色と見るか」を測り直す(1画素でも越えたら抜ける)
    let neutral = false;
    if (p999 <= 2) {
      const tol = blob.type === 'image/jpeg' ? 2 : 0;
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      ctx.drawImage(bmp, 0, 0);
      const full = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      neutral = true;
      for (let i = 0; i < full.length; i += 4) {
        if (Math.max(full[i], full[i + 1], full[i + 2]) - Math.min(full[i], full[i + 1], full[i + 2]) > tol) {
          neutral = false;
          break;
        }
      }
    }
    bmp.close();
    canvas.width = 0;
    canvas.height = 0;
    stats.set(src, { mean: n > 0 ? sum / n : 0, p999, neutral });
  } catch (e) {
    console.warn('chroma failed', e);
    failed.add(src);
  }
}

/** まだ測っていない絵を測る。**全部測ってあれば null**。同時に測るのは2枚まで */
export function prepareChroma(srcs: Iterable<string>): Promise<void> | null {
  if (typeof document === 'undefined') return null;
  const todo = [...new Set(srcs)].filter((s) => s && !stats.has(s) && !failed.has(s));
  if (todo.length === 0) return null;
  const queue = [...todo];
  const worker = async () => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      let p = measuring.get(s);
      if (!p) {
        p = measureOne(s).finally(() => measuring.delete(s));
        measuring.set(s, p);
      }
      await p;
    }
  };
  return Promise.all([worker(), worker()]).then(() => undefined);
}
