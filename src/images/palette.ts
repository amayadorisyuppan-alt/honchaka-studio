// 絵から「この絵の色」を数えて選び出す(スポイトの代わり)。**この PC の中だけで数える。外へは送らない。**
//
// 2026-10-03 ユーザー要望:
// 「表1の画像の色を表4で使いたいからスポイトを使おうとすると、マスクがかかっているので色が取れない。
//   挿入した画像に使われている色の一覧が出るようになっていると、タイトル回りの色変えなんかも簡単になる」
//
// 数え方(extractPalette):
//   1. 縮めた絵(長辺 96px 前後)の画素を、各色 5bit(32段)の箱に数える。透明に近い画素(alpha < 128)は数えない
//   2. メディアンカット(いちばん画素の多い・色の幅の広い箱を、いちばん幅の広い色の軸の真ん中で割る)で 14 の箱に分け、
//      箱ごとの平均の色と面積を出す
//   3. 「面積」と「彩度」のつり合いで点をつけて、高い順に選ぶ。
//        点 = √面積 × (0.4 + 彩度) × (極端に暗い・明るいとき 0.4)
//      面積だけで選ぶと、地の白や黒ばかりが並ぶ。彩度だけで選ぶと、ほんの数画素の派手な色が並ぶ。√ で面積を丸めて、
//      彩度で重みを付けるくらいが「見て、この絵の色だ」と感じる並びになる
//   4. すでに選んだ色に近い色(RGB の距離 40 未満)は、まとめて捨てる。ほぼ単色の絵は 1〜2 色になる
//
// 結果は絵ごとに覚える(同じ絵を数え直さない)。数えるのは idle のとき・1枚ずつ。縮めてから数えるので、大きな絵でも固まらない。
// React のフック(useArtPalette)は usePalette.ts。ここは React を使わない(検査が node で回せるように)

export interface PaletteColor {
  /** #rrggbb(小文字) */
  hex: string;
  /** 選ぶときの点(大きいほど、この絵らしい色) */
  score: number;
}

/** 数える画素の長辺。これ以上は縮める */
const SAMPLE_SIDE = 96;
/** メディアンカットで分ける箱の数 */
const BOXES = 14;
/** これより面積の小さい色は、選ばない(ほこり・縁のにじみ) */
const MIN_SHARE = 0.004;
/** 近い色とみなす RGB の距離 */
const MIN_DIST = 40;

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const dist = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 画素(RGBA の並び)から、目立つ色を max 色まで選ぶ。**純関数**(検査はこれだけを呼ぶ) */
export function extractPalette(rgba: ArrayLike<number>, max = 8): PaletteColor[] {
  const SIZE = 32768;
  const cnt = new Uint32Array(SIZE);
  const sr = new Float64Array(SIZE);
  const sg = new Float64Array(SIZE);
  const sb = new Float64Array(SIZE);
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    cnt[k]++;
    sr[k] += r;
    sg[k] += g;
    sb[k] += b;
    total++;
  }
  if (total === 0) return [];

  // 箱 = 使われている小箱の番号の並び
  const used: number[] = [];
  for (let k = 0; k < SIZE; k++) if (cnt[k] > 0) used.push(k);
  const mean = (k: number, ch: 0 | 1 | 2) => (ch === 0 ? sr[k] : ch === 1 ? sg[k] : sb[k]) / cnt[k];
  type Box = { bins: number[]; n: number; ch: 0 | 1 | 2; range: number };
  const measure = (bins: number[]): Box => {
    let n = 0;
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (const k of bins) {
      n += cnt[k];
      for (const ch of [0, 1, 2] as const) {
        const v = mean(k, ch);
        if (v < lo[ch]) lo[ch] = v;
        if (v > hi[ch]) hi[ch] = v;
      }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const ch = (ranges[0] >= ranges[1] && ranges[0] >= ranges[2] ? 0 : ranges[1] >= ranges[2] ? 1 : 2) as 0 | 1 | 2;
    return { bins, n, ch, range: ranges[ch] };
  };
  const boxes: Box[] = [measure(used)];
  while (boxes.length < BOXES) {
    // 割れる(小箱が2つ以上で、色に幅がある)箱のうち、画素 × 幅 がいちばん大きいもの
    let bi = -1;
    let best = 0;
    boxes.forEach((b, i) => {
      if (b.bins.length < 2 || b.range < 1) return;
      const v = b.n * b.range;
      if (v > best) {
        best = v;
        bi = i;
      }
    });
    if (bi < 0) break;
    const b = boxes[bi];
    const sorted = [...b.bins].sort((x, y) => mean(x, b.ch) - mean(y, b.ch));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += cnt[sorted[i]];
      cut = i + 1;
      if (acc >= b.n / 2) break;
    }
    boxes.splice(bi, 1, measure(sorted.slice(0, cut)), measure(sorted.slice(cut)));
  }

  const cands = boxes
    .map((b) => {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (const k of b.bins) {
        r += sr[k];
        g += sg[k];
        bl += sb[k];
      }
      const rgb: [number, number, number] = [r / b.n, g / b.n, bl / b.n];
      const mx = Math.max(...rgb);
      const mn = Math.min(...rgb);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const luma = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      const share = b.n / total;
      const extreme = luma < 0.08 || luma > 0.95 ? 0.4 : 1;
      return { rgb, share, score: Math.sqrt(share) * (0.4 + sat) * extreme };
    })
    .filter((c) => c.share >= MIN_SHARE)
    .sort((a, b) => b.score - a.score);

  const picked: typeof cands = [];
  for (const c of cands) {
    if (picked.length >= max) break;
    if (picked.some((p) => dist(p.rgb, c.rgb) < MIN_DIST)) continue;
    picked.push(c);
  }
  // 小さな箱しか無い(ごく小さな絵)ときも、1色は返す
  if (picked.length === 0 && cands.length === 0) {
    const top = boxes.slice().sort((a, b) => b.n - a.n)[0];
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const k of top.bins) {
      r += sr[k];
      g += sg[k];
      bl += sb[k];
    }
    return [{ hex: toHex(r / top.n, g / top.n, bl / top.n), score: 0 }];
  }
  return picked.map((c) => ({ hex: toHex(c.rgb[0], c.rgb[1], c.rgb[2]), score: c.score }));
}

/**
 * 何枚かの絵の色を1つの並びにまとめる。**絵ごとの1位 → 2位 → … と交互に取る**(1枚の絵の色だけで埋まらない)。
 * すでに入った色に近い色は入れない。lists の先頭ほど優先する絵
 */
export function mergePalettes(lists: readonly (readonly string[])[], max = 8): string[] {
  const out: string[] = [];
  const rgbs: [number, number, number][] = [];
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < depth && out.length < max; rank++) {
    for (const l of lists) {
      if (out.length >= max) break;
      const h = l[rank];
      if (!h) continue;
      const rgb = parseHex(h);
      if (rgbs.some((p) => dist(p, rgb) < MIN_DIST)) continue;
      out.push(h);
      rgbs.push(rgb);
    }
  }
  return out;
}

/** 絵 → 色。**絵の中身(src)ごとに覚える**。数え終わった絵が上限を超えたら全部捨てる(data URI は大きい) */
const CACHE_LIMIT = 256;
const cache = new Map<string, string[]>();

/** 同じ時に数えるのは1枚だけ。数えるのは画面が空いたとき(描画のじゃまをしない) */
let queue: Promise<unknown> = Promise.resolve();
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const w = window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(() => resolve(), { timeout: 400 });
    else setTimeout(resolve, 16);
  });
}

function pixelsOf(img: HTMLImageElement): Uint8ClampedArray | null {
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) return null;
  const s = Math.min(1, SAMPLE_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s));
  const h = Math.max(1, Math.round(h0 * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  try {
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // 汚れた画像(他所の絵)は読めない
  }
}

function loadForPalette(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 絵(URL か、読み込み済みの <img>)の色。数えられなければ []。覚えているものはすぐ返る */
export function paletteOf(source: string | HTMLImageElement): Promise<string[]> {
  const key = typeof source === 'string' ? source : source.currentSrc || source.src;
  if (!key) return Promise.resolve([]);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const task = queue.then(async () => {
    const again = cache.get(key);
    if (again) return again;
    await idle();
    const img = typeof source === 'string' ? await loadForPalette(source) : source;
    const px = img ? pixelsOf(img) : null;
    const colors = px ? extractPalette(px).map((c) => c.hex) : [];
    if (cache.size > CACHE_LIMIT) cache.clear();
    cache.set(key, colors);
    return colors;
  });
  queue = task.catch(() => undefined);
  return task;
}

/** すでに数え終わっている絵の色(まだなら undefined) */
export function cachedPalette(source: string | HTMLImageElement): string[] | undefined {
  const key = typeof source === 'string' ? source : source.currentSrc || source.src;
  return key ? cache.get(key) : undefined;
}
