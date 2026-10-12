// 絵ごとの刷り色(修正リストの 4-1・4-6。2026-10-12 1.1.0)の検査。src/models/printColor.ts
// - 白黒の本は、挿絵ページと章の途中の絵をすべて写しにする(背景は合成で灰色にしているので写しにしない)
// - カラーの本は、白黒で刷る印のある絵だけ(背景は本文の地を継いでいる面にも効く)
// - 差し替えるものが無ければ、同じ参照を返す(組版の useMemo が組み直さない)
// - 白黒に見える絵・ごく淡い色の絵の判定と、行の鍵
//
// 回し方(ブラウザも dev サーバーも要らない。リポジトリの頭で回す)
//   npx vite build --ssr scripts/printColor.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/printColor.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { defaultSettings } from '../src/models/project';
import type { Manuscript, ProjectSettings } from '../src/models/project';
import { colorLookOf, colorLookRows, grayCopySources, withGrayCopies } from '../src/models/printColor';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}
const j = JSON.stringify;

const A = 'data:image/jpeg;base64,AAAA';
const B = 'data:image/jpeg;base64,BBBB';
const BG = 'data:image/jpeg;base64,GGGG';
const EMF = 'data:image/x-emf;base64,EEEE';
const gray = (src: string) => `blob:gray-${src.slice(-4)}`;

const ms: Manuscript = {
  title: 't',
  author: 'a',
  publisher: '',
  chapters: [
    { title: '一', blocks: [{ type: 'p', text: 'x' }, { type: 'image', src: B }, { type: 'image', src: EMF }] },
  ],
} as unknown as Manuscript;
const base: ProjectSettings = {
  ...defaultSettings(),
  plates: [
    { id: 'p1', src: A, beforeChapter: 0, size: 'full' },
    { id: 'p2', src: '', beforeChapter: 0, size: 'full', blank: true },
  ],
  bodyBg: BG,
  titleBg: { src: A },
} as ProjectSettings;

// 白黒の本
const mono = { ...base, ink: 'mono' } as ProjectSettings;
ok(j(grayCopySources(mono, ms)) === j([A, B]), '白黒の本: 写しは挿絵ページと章の途中の絵(背景・表示できない形式は入れない)', j(grayCopySources(mono, ms)));
const m1 = withGrayCopies(mono, ms, gray);
ok(m1.settings.plates?.[0].src === gray(A) && m1.settings.plates?.[0].grayCopy === true, '白黒の本: 挿絵ページを写しに替えて印を付ける');
ok(m1.settings.bodyBg === BG && m1.settings.titleBg?.src === A, '白黒の本: 背景は替えない');
const fig = m1.manuscript.chapters[0].blocks[1] as { src: string; grayCopy?: boolean };
ok(fig.src === gray(B) && fig.grayCopy === true, '白黒の本: 章の途中の絵も写しに');
const none = withGrayCopies(mono, ms, () => undefined);
ok(none.settings === mono && none.manuscript === ms, '写しがまだ無ければ、同じ参照を返す');

// カラーの本(印なし)
const color = { ...base, ink: 'color' } as ProjectSettings;
ok(grayCopySources(color, ms).length === 0, 'カラーの本: 印が無ければ写しは要らない');
const c0 = withGrayCopies(color, ms, gray);
ok(c0.settings === color && c0.manuscript === ms, 'カラーの本: 印が無ければ同じ参照');

// カラーの本(印あり)
const colorMono = {
  ...color,
  plates: [{ ...color.plates![0], printMono: true }, color.plates![1]],
  bodyBgPrintMono: true,
  titleBg: { src: A, printMono: true },
} as ProjectSettings;
const msMono = { ...ms, chapters: [{ ...ms.chapters[0], blocks: ms.chapters[0].blocks.map((b, i) => (i === 1 ? { ...b, printMono: true } : b)) }] } as Manuscript;
ok(j(grayCopySources(colorMono, msMono).sort()) === j([A, B, BG].sort()), 'カラーの本: 印のある挿絵・章の途中の絵・背景が写しに', j(grayCopySources(colorMono, msMono)));
const c1 = withGrayCopies(colorMono, msMono, gray);
ok(c1.settings.bodyBg === gray(BG), 'カラーの本: 本文の地を写しに(継いでいる面にも効く)');
ok(c1.settings.titleBg?.src === gray(A), 'カラーの本: 印のある面の絵を写しに');
ok(c1.settings.plates?.[1].blank === true && c1.settings.plates?.[1].src === '', '白ページはそのまま');
ok(colorMono.plates?.[0].src === A, '元の設定は書き換えない');

// 判定
ok(colorLookOf({ mean: 0.5, p999: 6 }) === 'gray', '生成AIの白黒の絵(0.5・6)は 白黒に見える');
ok(colorLookOf({ mean: 0.2, p999: 4, neutral: true }) === null, '変換が無彩色と見る絵(灰色ちょうど)は知らせない');
ok(colorLookOf({ mean: 1.8, p999: 46 }) === null, '差し色のある絵(1.8・46)は知らせない');
ok(colorLookOf({ mean: 5.7, p999: 10 }) === 'pale', 'うっすら色がかった絵(5.7・10)は ごく淡い色');
ok(colorLookOf({ mean: 27.4, p999: 117 }) === null, 'クリームの紙(27・117)は知らせない');
const rows = colorLookRows(color, ms, (src) => (src === A ? { mean: 0.5, p999: 6 } : src === BG ? { mean: 5, p999: 10 } : undefined));
ok(j([...rows.entries()].sort()) === j([['bg:body', 'pale'], ['bg:title', 'gray'], ['plate:p1', 'gray']].sort()), '行の鍵(plate:id・bg:面)', j([...rows.entries()]));
ok(colorLookRows(mono, ms, () => ({ mean: 0.5, p999: 6 })).size === 0, '白黒の本では知らせない');
ok(colorLookRows(colorMono, msMono, () => ({ mean: 0.5, p999: 6 })).size === 0, '白黒で刷る印のある絵は知らせない');

console.log(`\n${passed} ok / ${failed} NG`);
process.exit(failed ? 1 : 0);
