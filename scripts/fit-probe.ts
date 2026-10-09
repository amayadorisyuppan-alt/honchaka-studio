// **コラムの「収まり判定」(fitColumnPage) をブラウザの実組版と突き合わせる。**
//
// 判定は floor/ceil の目安なので、実際の行折りとずれると
// 「収まっているのにエラー」(2026-09-11〜13 に3回報告) になる。
// 推測で係数をいじるのはやめ、ここで**同じCSSの箱を実際に組んで測る**。
//
// 使い方:
//   npx vite --port 5199
//   http://localhost:5199/scripts/fit-probe.html
// 結果は window.__FIT_RESULT と画面の表に出る。
import { computeLayout, fitColumnPage, COLPAGE_TITLE_SIZE, COLPAGE_TITLE_LINE, COLPAGE_TITLE_GAP } from '../src/typeset/grid';
import { defaultSettings, columnPageParagraphs } from '../src/models/project';
import { isDialogueStart } from '../src/typeset/text';

const PT_TO_MM = 25.4 / 72;

interface Case {
  name: string;
  title: string;
  text: string;
  fontPt: number;
  lineFeedPt: number;
  padXPct: number;
  padYPct: number;
  vertical: boolean;
}

// ---- テスト原稿 --------------------------------------------------------
// スクショ(2026-09-13)の実例に寄せたもの
const CASE_USER = `祖母と縁側で交わした、ある夏の会話です。

「あの青い本、まだあるの」と、祖母が言いました。
「表紙が青いの。あんたに読んで聞かせたでしょう」
「たくさん読んでもらったから、わからないよ」
「じゃあ、忘れたのね」
「忘れてはいないよ。青いのがどれだか、わからないだけ」
「それを忘れたと言うのよ」
「べつに、あんたが覚えていなくてもいいの。読んだことは、こっちが覚えているんだから」
「いいのよ。読み聞かせっていうのは、そういうものなの」

その本は、いまでもどれだかわかりません。
奥付の最後に Printed in Japan と刷ってある、あの手の本です。`;

const KANJI = '雨宿本棚頁栞装丁組版活字余白図書館物語順番約束音散歩枝先計算区切連続長短';
const rand = (() => {
  let s = 42;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
})();
function randPara(): string {
  const len = 4 + Math.floor(rand() * 60);
  let t = '';
  for (let i = 0; i < len; i++) {
    const r = rand();
    if (r < 0.08 && i > 3 && i < len - 2) t += '、';
    else if (r < 0.1 && i > 6 && i < len - 2) t += '。';
    else t += KANJI[Math.floor(rand() * KANJI.length)];
  }
  t += '。';
  if (rand() < 0.4) t = '「' + t.slice(0, -1) + '」';
  return t;
}
function randText(paras: number): string {
  const out: string[] = [];
  for (let i = 0; i < paras; i++) {
    out.push(randPara());
    if (rand() < 0.2) out.push('');
  }
  return out.join('\n');
}

const cases: Case[] = [];
cases.push({ name: 'user-repro', title: '祖母と、青い本のこと', text: CASE_USER, fontPt: 8.5, lineFeedPt: 14.5, padXPct: 8.6, padYPct: 5.5, vertical: false });
for (let i = 0; i < 40; i++) {
  cases.push({
    name: `rand-h-${i}`,
    title: rand() < 0.7 ? (rand() < 0.5 ? 'まだまだ暑い' : 'とても長い見出しで二行に折り返すことを確かめるための見出し') : '',
    text: randText(3 + Math.floor(rand() * 9)),
    fontPt: 8.5,
    lineFeedPt: 14.5,
    padXPct: rand() < 0.5 ? 0 : 5 + rand() * 6,
    padYPct: rand() < 0.5 ? 0 : 4 + rand() * 5,
    vertical: false,
  });
}
for (let i = 0; i < 12; i++) {
  cases.push({
    name: `rand-v-${i}`,
    title: rand() < 0.7 ? '縦のコラム' : '',
    text: randText(3 + Math.floor(rand() * 8)),
    fontPt: 8.5,
    lineFeedPt: 14.5,
    padXPct: rand() < 0.5 ? 0 : 5 + rand() * 6,
    padYPct: rand() < 0.5 ? 0 : 4 + rand() * 5,
    vertical: true,
  });
}

// ---- 実測 --------------------------------------------------------------
const s = defaultSettings();
const layout = computeLayout(s);
const areaW0 = layout.trimW - layout.margins.gutter - layout.margins.fore;
const areaH0 = layout.trimH - layout.margins.top - layout.margins.bottom;

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

interface Row {
  name: string;
  estOver: boolean;
  realOver: boolean;
  usedLines: number;
  linesFloat: number;
  titleLines: number;
  overflowPx: number;
  verdict: string;
}

function measure(c: Case): Row {
  const mode = c.vertical ? 'vertical' : 'horizontal';
  const paras = columnPageParagraphs(c.text);
  const fit = fitColumnPage(layout, mode as 'vertical' | 'horizontal', c.title, paras, {
    fontPt: c.fontPt, lineFeedPt: c.lineFeedPt, padXPct: c.padXPct, padYPct: c.padYPct,
  });
  const feed = c.lineFeedPt;
  const padXmm = (areaW0 * c.padXPct) / 100;
  const padYmm = (areaH0 * c.padYPct) / 100;
  const box = document.createElement('section');
  box.style.cssText = [
    `width:${areaW0}mm`, `height:${areaH0}mm`,
    'box-sizing:border-box', `padding:${padYmm}mm ${padXmm}mm`,
    `font-size:${c.fontPt}pt`, `line-height:${feed}pt`,
    "font-family:'IPAGothic'",
    'hanging-punctuation:allow-end', 'line-break:strict', 'word-break:normal',
    'overflow-wrap:break-word', 'text-align:justify',
    c.vertical ? 'writing-mode:vertical-rl' : 'writing-mode:horizontal-tb',
    'position:absolute', 'left:-9999px', 'top:0', 'overflow:visible', 'background:#fff',
  ].join(';');
  const head = c.title.trim()
    ? `<h2 style="margin:0;text-indent:0;font-weight:700;font-family:'IPAGothic';` +
      `font-size:${c.fontPt * COLPAGE_TITLE_SIZE}pt;line-height:${feed * COLPAGE_TITLE_LINE}pt;` +
      (c.vertical ? `margin-left:${feed * COLPAGE_TITLE_GAP}pt;` : `margin-bottom:${feed * COLPAGE_TITLE_GAP}pt;`) +
      `">${esc(c.title)}</h2>`
    : '';
  const body = paras
    .map((t) =>
      t === ''
        ? `<p style="margin:0;text-indent:0">​</p>`
        : `<p style="margin:0;text-indent:${isDialogueStart(t) ? '0' : '1em'}">${esc(t)}</p>`,
    )
    .join('');
  // 中身を丸ごと1つの div に包み、その実寸(BoundingClientRect)で測る。
  // 縦組み(vertical-rl)のあふれは左方向で、scrollWidth が拾わないことがある
  box.innerHTML = `<div id="inner">${head + body}</div>`;
  document.body.appendChild(box);
  const inner = box.querySelector('#inner') as HTMLElement;
  const ib = inner.getBoundingClientRect();
  const cb = box.getBoundingClientRect();
  const padXpx = (box.clientWidth - inner.clientWidth) >= 0 ? 0 : 0; // 参照用ダミー
  const cs = getComputedStyle(box);
  const availW = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const over = c.vertical ? ib.width - availW : ib.height - availH;
  const realOver = over > 1; // 1px はサブピクセル誤差
  const row: Row = {
    name: c.name,
    estOver: fit.over,
    realOver,
    usedLines: fit.usedLines,
    linesFloat: +( (c.vertical ? areaW0 * (1 - 2 * c.padXPct / 100) : areaH0 * (1 - 2 * c.padYPct / 100)) / (feed * PT_TO_MM) ).toFixed(2),
    titleLines: +fit.titleLines.toFixed(2),
    overflowPx: over,
    verdict:
      fit.over === realOver ? 'ok' : fit.over ? 'FALSE-RED(嘘の赤)' : 'MISSED-OVERFLOW(見逃し)',
  };
  document.body.removeChild(box);
  return row;
}

async function main() {
  await (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready;
  const rows = cases.map(measure);
  const bad = rows.filter((r) => r.verdict !== 'ok');
  (window as unknown as { __FIT_RESULT: unknown }).__FIT_RESULT = {
    total: rows.length,
    falseRed: rows.filter((r) => r.verdict.startsWith('FALSE')).length,
    missed: rows.filter((r) => r.verdict.startsWith('MISSED')).length,
    bad,
    rows,
  };
  document.title = 'FIT-PROBE-DONE';
  const el = document.getElementById('out')!;
  el.textContent =
    `total=${rows.length} falseRed=${bad.filter((r) => r.verdict.startsWith('FALSE')).length} ` +
    `missed=${bad.filter((r) => r.verdict.startsWith('MISSED')).length}\n` +
    rows.map((r) => `${r.verdict.padEnd(22)} ${r.name.padEnd(12)} used=${r.usedLines} lines=${r.linesFloat} title=${r.titleLines} ovPx=${r.overflowPx}`).join('\n');
}
void main();
