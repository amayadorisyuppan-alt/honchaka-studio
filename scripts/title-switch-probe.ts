// **縦組みの本で、書名の向きを切り替えても組み直さず、大扉が紙と同じ位置に出る**ことを、本物の組版器(CoreViewer)で測る。(2026-10-03)
//
// ユーザー報告「タイトル・著者名を横書きにしただけで版下製作が全体で行われるので時間がかかる」への直しの確かめ。
// 下見は組版に「縦のまま」を固定して渡し(preview/paint.ts の paintNeutral)、大扉の規則だけを
// `!important` で重ねて向きを変える。これが本当に紙と同じ位置に出るかを、次の3つで測る。
//
//   A. 紙と同じ: 書名を横書きにした完全な組版(紙の書き出しと同じ HTML)の大扉の、書名・著者名・箱の位置
//   B. 下見(横書き): 縦のまま組んだ HTML(titleBothWays)+ 塗りのパッチ(横書き)の大扉の位置。A と同じこと
//   C. 切り替え: B の組版を**組み直さずに**パッチだけ縦へ → 縦のままの完全な組版(D)と同じ位置、
//      さらに横へ戻す → A と同じ位置。切り替えの間に loadDocument(組版)が 0 回であること
//
// 位置は、大扉のページ(page-container)の幅・高さに対する比で比べる(組み方による拡大の違いを消す)。
// 数字を含む書名(縦中横と全角化が変わる)でも測る。
import { CoreViewer, PageViewMode } from '@vivliostyle/core';
import { defaultSettings } from '../src/models/project';
import type { PrintRules, ProjectSettings } from '../src/models/project';
import { manuscriptHtml } from '../src/typeset/html';
import { sampleManuscript } from '../src/sample';
import { paintNeutral, previewPaintCss } from '../src/preview/paint';
import { reportProbe } from './probe-report';

const params = new URLSearchParams(location.search);
const TIMEOUT_MS = Number(params.get('timeout') ?? 120000);
const PAINT_ID = 'title-switch-probe-paint';
/** 比で比べるときの許容(ページの幅・高さに対する比)。1px = 約 0.002(文庫 105mm を 500px 前後で見るとき) */
const TOL = 0.004;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`));

// 組んだ冊数(loadDocument の呼び出し)を数える。app-probe.tsx と同じ数え方
let loads = 0;
const origLoad = CoreViewer.prototype.loadDocument;
CoreViewer.prototype.loadDocument = function (this: CoreViewer, ...args: unknown[]) {
  loads += 1;
  return (origLoad as (...a: unknown[]) => unknown).apply(this, args);
} as typeof CoreViewer.prototype.loadDocument;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface Shot {
  section: Rect;
  h1: Rect;
  h1Ink: Rect;
  author: Rect | null;
  authorInk: Rect | null;
  h1Mode: string;
  pages: number;
  h1Text: string;
}

const RULES: PrintRules = { bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20 };

function settingsOf(title: 'v' | 'h', press: boolean): ProjectSettings {
  return {
    ...defaultSettings(),
    writingMode: 'vertical',
    ...(title === 'h' ? { titleWritingMode: 'horizontal' as const } : {}),
    ...(press ? { printTarget: 'printshop' as const, printRules: RULES } : {}),
  };
}

function manuscriptOf(titleText: string) {
  const ms = sampleManuscript();
  ms.title = titleText;
  ms.author = '雨宿 時雨';
  // 大扉は1ページ目。短くして速く組む(ページ数の比べは変わらない)
  ms.chapters = ms.chapters.slice(0, 2);
  return ms;
}

/** 1冊を組み、組み上がったら返す。host は `.preview-body` の入れ物(下見と同じ入れ子) */
async function typeset(html: string, tag: string): Promise<{ viewer: CoreViewer; host: HTMLElement; pages: number }> {
  const host = document.createElement('div');
  host.className = 'preview-body';
  host.style.cssText = 'position:absolute;inset:0;overflow:auto;';
  const vp = document.createElement('div');
  vp.style.cssText = 'position:absolute;inset:0;overflow:auto;';
  host.appendChild(vp);
  document.body.appendChild(host);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  // アプリの生プレビューと同じ引数(scripts/preview-probe.ts)
  const viewer = new CoreViewer(
    { viewportElement: vp },
    { autoResize: true, renderAllPages: true, pageViewMode: PageViewMode.SPREAD, fitToScreen: true, pageBorderWidth: 1, pixelRatio: 0 },
  );
  let ready = false;
  viewer.addListener('readystatechange', () => {
    if (viewer.readyState === 'complete') ready = true;
  });
  viewer.addListener('error', (p) => errors.push(`viewer error(${tag}): ${JSON.stringify(p?.content ?? p)}`));
  viewer.loadDocument({ url }, {}, { renderAllPages: true, pageViewMode: PageViewMode.SPREAD });
  const t0 = Date.now();
  while (!ready && Date.now() - t0 < TIMEOUT_MS) await sleep(150);
  if (!ready) throw new Error(`組み上がらない(${tag})`);
  await sleep(200);
  return { viewer, host, pages: viewer.getPageSizes().length };
}

function setPaint(css: string) {
  let el = document.getElementById(PAINT_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = PAINT_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function shot(host: HTMLElement, pages: number): Shot {
  const pc = host.querySelector<HTMLElement>('[data-vivliostyle-page-container]:has(section.titlepage)');
  if (!pc) throw new Error('大扉のページが見つからない');
  const pr = pc.getBoundingClientRect();
  const rel = (r: DOMRect): Rect => ({
    x0: (r.left - pr.left) / pr.width,
    y0: (r.top - pr.top) / pr.height,
    x1: (r.right - pr.left) / pr.width,
    y1: (r.bottom - pr.top) / pr.height,
  });
  const ink = (el: HTMLElement): DOMRect => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect();
  };
  const section = pc.querySelector<HTMLElement>('section.titlepage')!;
  const h1 = section.querySelector<HTMLElement>('h1')!;
  const au = section.querySelector<HTMLElement>('.author');
  return {
    section: rel(section.getBoundingClientRect()),
    h1: rel(h1.getBoundingClientRect()),
    h1Ink: rel(ink(h1)),
    author: au ? rel(au.getBoundingClientRect()) : null,
    authorInk: au ? rel(ink(au)) : null,
    h1Mode: getComputedStyle(h1).writingMode,
    pages,
    // 隠れている字の並び(display:none)は textContent に残るので、描かれているものだけ取る
    h1Text: Array.from(h1.querySelectorAll('.tt-v, .tt-h')).length ? '(両用)' : (h1.textContent ?? ''),
  };
}

function diff(a: Rect | null, b: Rect | null): number {
  if (!a || !b) return a === b ? 0 : 99;
  return Math.max(Math.abs(a.x0 - b.x0), Math.abs(a.y0 - b.y0), Math.abs(a.x1 - b.x1), Math.abs(a.y1 - b.y1));
}
function maxDiff(a: Shot, b: Shot): { worst: number; where: string } {
  const pairs: [string, number][] = [
    ['section', diff(a.section, b.section)],
    ['h1', diff(a.h1, b.h1)],
    ['h1Ink', diff(a.h1Ink, b.h1Ink)],
    ['author', diff(a.author, b.author)],
    ['authorInk', diff(a.authorInk, b.authorInk)],
  ];
  pairs.sort((x, y) => y[1] - x[1]);
  return { worst: +pairs[0][1].toFixed(5), where: pairs[0][0] };
}

const fails: string[] = [];
const rows: unknown[] = [];

async function run(label: string, titleText: string, press: boolean) {
  const ms = manuscriptOf(titleText);
  const sV = settingsOf('v', press);
  const sH = settingsOf('h', press);

  // A: 紙と同じ(書名を横書きにした完全な組版。塗りのパッチは付けない)
  setPaint('');
  const A = await typeset(manuscriptHtml(ms, sH), `${label}/A`);
  const a = shot(A.host, A.pages);
  A.host.remove();

  // D: 縦のままの完全な組版(縦の基準)
  const D = await typeset(manuscriptHtml(ms, sV), `${label}/D`);
  const d = shot(D.host, D.pages);
  D.host.remove();

  // B: 下見の組版(縦のまま固定 + 両用の字の並び)+ 横書きのパッチ
  const html = manuscriptHtml(ms, paintNeutral(sH), '', { titleBothWays: true });
  const sameHtml = html === manuscriptHtml(ms, paintNeutral(sV), '', { titleBothWays: true });
  setPaint(previewPaintCss(sH));
  const B = await typeset(html, `${label}/B`);
  await sleep(300);
  const b = shot(B.host, B.pages);

  // 対照: パッチを外すと縦に戻る(= この測りは、パッチが効いているかどうかを見分けられる)
  setPaint('');
  await sleep(400);
  const ctrl = shot(B.host, B.pages);
  const dCtrl = maxDiff(a, ctrl);
  setPaint(previewPaintCss(sH));
  await sleep(400);

  // C: 同じ組版のまま、パッチだけ縦 → 横へ。**この間に組版(loadDocument)が走らないこと**
  const loadsBefore = loads;
  setPaint(previewPaintCss(sV));
  await sleep(500);
  const cV = shot(B.host, B.pages);
  setPaint(previewPaintCss(sH));
  await sleep(500);
  const cH = shot(B.host, B.pages);
  const switchLoads = loads - loadsBefore;
  B.host.remove();
  setPaint('');

  const dAB = maxDiff(a, b);
  const dV = maxDiff(d, cV);
  const dH = maxDiff(a, cH);
  rows.push({
    label,
    pages: { paperH: a.pages, paperV: d.pages, preview: B.pages },
    modes: { paperH: a.h1Mode, paperV: d.h1Mode, previewH: b.h1Mode, switchedV: cV.h1Mode, switchedBackH: cH.h1Mode },
    previewHtmlSameForBothDirections: sameHtml,
    previewH_vs_paperH: dAB,
    switchedV_vs_paperV: dV,
    switchedBackH_vs_paperH: dH,
    switchLoads,
    control_noPatch_vs_paperH: dCtrl,
    paperH_h1: a.h1Ink,
    paperV_h1: d.h1Ink,
  });
  if (!sameHtml) fails.push(`${label}: 向きを変えると下見の組版HTMLが変わる`);
  if (!/horizontal-tb/.test(a.h1Mode)) fails.push(`${label}: 紙(横書き)の書名が横組みになっていない(${a.h1Mode})`);
  if (!/vertical/.test(d.h1Mode)) fails.push(`${label}: 縦のままの書名が縦組みになっていない(${d.h1Mode})`);
  if (!/horizontal-tb/.test(b.h1Mode)) fails.push(`${label}: 下見(横書き)の書名が横組みになっていない(${b.h1Mode})`);
  if (!/vertical/.test(cV.h1Mode)) fails.push(`${label}: 切り替えて縦にしても書名が縦組みにならない(${cV.h1Mode})`);
  if (!/horizontal-tb/.test(cH.h1Mode)) fails.push(`${label}: 縦から横へ戻しても書名が横組みにならない(${cH.h1Mode})`);
  if (!(a.pages === B.pages && d.pages === B.pages)) fails.push(`${label}: ページ数が向きで変わる(${a.pages}/${d.pages}/${B.pages})`);
  if (dAB.worst > TOL) fails.push(`${label}: 下見(横書き)の大扉が紙とずれる(${dAB.where} ${dAB.worst})`);
  if (dV.worst > TOL) fails.push(`${label}: 切り替えた縦の大扉が、縦のままの組版とずれる(${dV.where} ${dV.worst})`);
  if (dH.worst > TOL) fails.push(`${label}: 縦から戻した横の大扉が紙とずれる(${dH.where} ${dH.worst})`);
  if (dCtrl.worst <= TOL * 5) fails.push(`${label}: 対照(パッチなし)が横の紙と区別できない。測りが効いていない(${dCtrl.worst})`);
  if (switchLoads !== 0) fails.push(`${label}: 向きの切り替えで組版が ${switchLoads} 回走った(0 が正解)`);
  // 向きが本当に変わっていること(縦と横の書名の外形が違う)
  const wA = a.h1Ink.x1 - a.h1Ink.x0;
  const hA = a.h1Ink.y1 - a.h1Ink.y0;
  const wD = d.h1Ink.x1 - d.h1Ink.x0;
  const hD = d.h1Ink.y1 - d.h1Ink.y0;
  if (!(wA > hA)) fails.push(`${label}: 紙(横書き)の書名が横長でない(${wA.toFixed(3)}×${hA.toFixed(3)})`);
  if (!(hD > wD)) fails.push(`${label}: 縦のままの書名が縦長でない(${wD.toFixed(3)}×${hD.toFixed(3)})`);
}

async function main() {
  await import('../src/fontsAll');
  await run('KDP・書名', '青い背表紙', false);
  await run('KDP・数字のある書名', '第12駅で待つ人', false);
  await run('四辺に塗り足し・書名', '青い背表紙', true);
  reportProbe({ ok: fails.length === 0, rows, fails, errors }, fails.length === 0);
}

void main().catch((e) => {
  errors.push(String(e));
  fails.push(`測っている途中で落ちた: ${String(e)}`);
  reportProbe({ ok: false, rows, fails, errors }, false);
});
