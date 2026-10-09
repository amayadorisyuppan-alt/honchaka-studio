// 絵の色の選び出し(src/images/palette.ts)の検査。画素の並び(RGBA)から作った絵で、純関数だけを測る。
//
// 回し方(ブラウザも dev サーバーも要らない)
//   npx vite build --ssr scripts/palette.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/palette.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { extractPalette, mergePalettes } from '../src/images/palette';

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`落ち: ${name} ${detail}`);
  }
}

type RGBA = [number, number, number, number];
/** 長方形の塊を並べた絵。parts = [割合(0〜1), 色] */
function picture(parts: [number, RGBA][], n = 96 * 96): Uint8ClampedArray {
  const px = new Uint8ClampedArray(n * 4);
  let i = 0;
  for (const [share, c] of parts) {
    const to = Math.min(n, i + Math.round(share * n));
    for (; i < to; i++) px.set(c, i * 4);
  }
  return px;
}
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const near = (hex: string, target: RGBA, tol = 24) => {
  const c = rgb(hex);
  return Math.hypot(c[0] - target[0], c[1] - target[1], c[2] - target[2]) < tol;
};
const has = (list: { hex: string }[], target: RGBA) => list.some((c) => near(c.hex, target));

// ---- はっきり色の違う絵 → その色たちが出る ----
{
  const RED: RGBA = [200, 40, 40, 255];
  const GREEN: RGBA = [40, 160, 70, 255];
  const BLUE: RGBA = [40, 80, 200, 255];
  const YEL: RGBA = [230, 200, 40, 255];
  const p = extractPalette(picture([[0.3, RED], [0.3, GREEN], [0.25, BLUE], [0.15, YEL]]));
  ok(p.length === 4, '4色の絵は4色', JSON.stringify(p));
  ok(has(p, RED) && has(p, GREEN) && has(p, BLUE) && has(p, YEL), '4色とも出る', JSON.stringify(p));
}

// ---- ほぼ単色の絵 → 1〜2色(ノイズでは増えない) ----
{
  const px = new Uint8ClampedArray(96 * 96 * 4);
  for (let i = 0; i < 96 * 96; i++) {
    const j = (i * 7) % 9; // 0〜8 のゆらぎ
    px.set([120 + j, 100 + j, 160 - j, 255], i * 4);
  }
  const p = extractPalette(px);
  ok(p.length >= 1 && p.length <= 2, 'ほぼ単色は1〜2色', String(p.length));
}

// ---- 透明の多い PNG → 透明は数えない ----
{
  const RED: RGBA = [210, 30, 30, 255];
  // 9割が透明(中身の色は黒・白にしてある)。残り1割だけ赤
  const p = extractPalette(picture([[0.45, [0, 0, 0, 0]], [0.45, [255, 255, 255, 0]], [0.1, RED]]));
  ok(p.length === 1 && near(p[0].hex, RED), '透明は数えず、赤だけ', JSON.stringify(p));
  ok(extractPalette(picture([[1, [10, 10, 10, 0]]])).length === 0, 'すべて透明なら空');
  ok(extractPalette(new Uint8ClampedArray(0)).length === 0, '空の絵は空');
}

// ---- 面積と彩度のつり合い: 地の白と黒だけが並ばない ----
{
  const WHITE: RGBA = [255, 255, 255, 255];
  const BLACK: RGBA = [8, 8, 8, 255];
  const ORANGE: RGBA = [240, 120, 20, 255];
  const TEAL: RGBA = [20, 150, 150, 255];
  const p = extractPalette(picture([[0.5, WHITE], [0.3, BLACK], [0.12, ORANGE], [0.08, TEAL]]), 3);
  ok(p.length === 3, '3色まで', String(p.length));
  ok(has(p, ORANGE) && has(p, TEAL), '地の白黒より、絵の色(橙・青緑)を先に選ぶ', JSON.stringify(p));
  // 上限
  const many = extractPalette(picture([[0.2, [200, 30, 30, 255]], [0.2, [30, 200, 30, 255]], [0.2, [30, 30, 200, 255]], [0.2, [200, 200, 30, 255]], [0.2, [30, 200, 200, 255]]]), 4);
  ok(many.length === 4, 'max を超えない', String(many.length));
}

// ---- 近い色をまとめる ----
{
  const p = extractPalette(picture([[0.5, [200, 40, 40, 255]], [0.5, [208, 44, 36, 255]]]));
  ok(p.length === 1, 'ほぼ同じ赤は1色にまとまる', JSON.stringify(p));
}

// ---- 何枚かの絵を混ぜる: 絵ごとに交互に取り、近い色は入れない ----
{
  const m = mergePalettes([['#ff0000', '#00ff00'], ['#fe0101', '#0000ff'], ['#ffff00']], 8);
  ok(m.join() === '#ff0000,#ffff00,#00ff00,#0000ff', '絵ごとに1位 → 2位と交互に取る・近い色は入れない', m.join());
  ok(!m.includes('#fe0101'), '#ff0000 に近い #fe0101 は入れない', m.join());
  ok(mergePalettes([['#ff0000', '#00ff00', '#0000ff']], 2).length === 2, 'max で切る');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
