// **長い本のどこで時間を食っているか**を測る。
//
// ## なぜ在るか
//
// ユーザー報告(2026-08-21。297ページの実原稿を取り込んで):
//
// > 297頁で3分くらいで画面が見えるようになって、全部が見えるようになるまでに
// > さらに10分以上かかる。タブ移動もできないし、簡単に書体変えたりサイズ変えたりはできない
//
// `rebuild-probe.ts` は**組み直しを繰り返して溜まるもの**(捨てたビューア・窓の監視)を
// 測る道具で、**1冊が長いこと**そのものは測っていない。ここはそちら。
//
// ## 何を分けて測るか
//
// アプリの1回の組み直しは、こういう段でできている:
//
//   0. 取り込み                   parseDocx()          … `?real=1` のときだけ
//   1. 書体を集める               collectFontFaceCss()
//   2. 組版HTMLを作る             manuscriptHtml()
//   3. Blob URL にして食わせる     loadDocument()
//   4. **1ページ目が出る**        readyState → 'interactive'
//   5. 全ページが組み上がる        readyState → 'complete'
//   6. サムネイル                 PageThumbs.sync()
//
// 4 と 5 を分けて測るのが肝。Vivliostyle は**いま見るページだけ先に組んで
// `interactive` を出し、そのあと残り全部を組んで `complete` を出す**
// (node_modules を読んで確認。`renderPagesUpto(pagePosition) → interactive →
//  countEPages → renderAllPages() → complete`)。
// アプリは `complete` しか見ていないので、**1ページ目はとっくに出来ているのに
// 全部組み上がるまで覆いを外さない。**
//
// ## 固まるほうも測る
//
// 秒数だけ見ても「フリーズ」は出てこない。そこで**心拍**を打つ:
// 50ミリ秒ごとに鳴らすはずのタイマーが、実際に何ミリ秒あいたかを数える。
// 250ミリ秒を超えた回数と最大のあきが「押しても返ってこない」の実体。
//
// ## 使い方
//
//   npx vite --port 5199
//   http://localhost:5199/scripts/long-probe.html?scale=1,3,9
//   http://localhost:5199/scripts/long-probe.html?real=1   （to claude/body.docx を測る）
//
// 実原稿はリポジトリの外の非公開の資料フォルダ(資料/body.docx)にある。測るあいだだけ
// `to claude/body.docx` へ写しておく(`to claude/` は .gitignore 済み。終わったら消す)。
//
// `scale` は**サンプル原稿を何回ぶん積むか**。1 = 34ページ、3 = 98ページ、
// 9 = 288ページ(ユーザーの原稿を取り込んだ 348ページと同じくらいの厚み)。
// `all=0` を付けると `renderAllPages` を切って測る(何が壊れるかの確認用)。
// `fonts=0` を付けると @font-face を同梱しないで測る(書体の重さの切り分け用)。
import { CoreViewer, PageViewMode } from '@vivliostyle/core';
import { bookTextOf, longFontFaceCss, longSettings, stackManuscript } from './long-doc';
import { manuscriptHtml } from '../src/typeset/html';
import { sampleManuscript } from '../src/sample';
import { parseDocx } from '../src/importers/docx';
import type { Manuscript } from '../src/models/project';
import { createThumbs } from '../src/preview/PageThumbs';
import { reportProbe } from './probe-report';

// **アプリと同じ書体をぜんぶ読み込む。** collectFontFaceCss は動いているページの
// スタイルシートから @font-face を拾うので、ここが無いと「書体を持たない本」を測る
await import('../src/fontsAll');
await import('../src/app.css');

const params = new URLSearchParams(location.search);
const yoko = params.get('wm') === 'h';
/** 実原稿(`to claude/body.docx`)を測る。git に無いので、手元にあるときだけ */
const REAL = params.get('real') === '1';
/** 何倍の原稿を測るか。カンマ区切りで並べると、そのぶん続けて測る */
const SCALES = (params.get('scale') ?? (REAL ? '' : '1'))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
/** `renderAllPages`。0 を渡すと切って測る */
const RENDER_ALL = params.get('all') !== '0';
/** @font-face を同梱するか。0 を渡すと持たせない */
const WITH_FONTS = params.get('fonts') !== '0';
/** 1冊の組み上がりを待つ上限(ミリ秒) */
const TIMEOUT_MS = Number(params.get('timeout') ?? 900000);
/** サムネイルも測るか。既定は測る(アプリと同じ形にするため) */
const THUMBS = params.get('thumbs') !== '0';

const stage = document.getElementById('probe-stage') as HTMLElement;
const host = document.getElementById('probe-viewport') as HTMLElement;
const strip = document.getElementById('probe-thumbs') as HTMLElement;
host.className = 'preview-viewport';
strip.className = 'thumbs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 心拍。**「操作が返ってこない」を数字にする。**
 *
 * 50ミリ秒ごとに鳴らすタイマーが、実際に何ミリ秒あいたかを見る。
 * 組版が主線を握っているあいだは、ここが伸びる。
 * ------------------------------------------------------------------ */
class Pulse {
  private last = 0;
  private timer = 0;
  /** 250ミリ秒を超えたあきの数。**押しても返ってこない瞬間の数** */
  stalls = 0;
  /** いちばん長かったあき(ミリ秒) */
  worst = 0;
  /** あきの合計(ミリ秒)。手が止まっていた時間の目安 */
  stalledMs = 0;

  start() {
    this.stalls = 0;
    this.worst = 0;
    this.stalledMs = 0;
    this.last = performance.now();
    const tick = () => {
      const now = performance.now();
      const gap = now - this.last;
      this.last = now;
      if (gap > 250) {
        this.stalls += 1;
        this.stalledMs += gap;
        if (gap > this.worst) this.worst = gap;
      }
      this.timer = window.setTimeout(tick, 50);
    };
    this.timer = window.setTimeout(tick, 50);
  }

  stop() {
    window.clearTimeout(this.timer);
    return {
      stalls: this.stalls,
      worstMs: Math.round(this.worst),
      stalledSec: Math.round(this.stalledMs / 10) / 100,
    };
  }
}

interface Stage {
  /** 何を測ったか。`x9` のように積んだ倍率か、実原稿なら `body.docx` */
  what: string;
  /** 章の数 */
  chapters: number;
  /** 本に出てくる字の種類 */
  distinctChars: number;
  /** 組版HTMLの字数 */
  htmlChars: number;
  /** そのうち @font-face が占める字数 */
  fontCssChars: number;
  /** 0. 取り込み(秒)。実原稿のときだけ */
  importSec: number;
  /** 1. 書体を集める(秒) */
  fontSec: number;
  /** 2. 組版HTMLを作る(秒) */
  buildSec: number;
  /** 4. 1ページ目が出るまで(秒)。readyState が 'interactive' になるまで */
  firstSec: number;
  /** 4'. DOM にページの箱が1つできるまで(秒) */
  firstBoxSec: number;
  /** 5. 全ページが組み上がるまで(秒)。readyState が 'complete' になるまで */
  allSec: number;
  /** 取り込みから全部組み上がるまでの合計(秒)。**利用者が待たされる時間** */
  totalSec: number;
  /** 組み上がったページ数(DOM から数える) */
  pages: number;
  /** 組版器が言うページ数(getPageSizes) */
  pagesByViewer: number;
  /** nav の報せで来た epageCount(renderAllPages を切ると**当て推量**になる) */
  epageCount: number;
  /** 組み上がりの合図(complete)が来たか */
  done: boolean;
  /** 6. サムネイルを全ページぶん sync するのにかかる時間(ミリ秒) */
  thumbSyncMs: number;
  /** 6'. アプリと同じ 700ms ごとの sync を、組んでいるあいだ何回打ったか */
  thumbSyncs: number;
  /** 6''. その sync の合計(ミリ秒) */
  thumbSyncTotalMs: number;
  /** 心拍。組んでいるあいだ主線がどれだけ埋まっていたか */
  stalls: number;
  worstMs: number;
  stalledSec: number;
  /** この回のあいだに出た例外 */
  errors: string[];
}

const allErrors: string[] = [];
let roundErrors: string[] = [];
function note(msg: string) {
  roundErrors.push(msg);
  allErrors.push(msg);
}
window.addEventListener('error', (e) => note(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) =>
  note(`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`));
const conError = console.error.bind(console);
console.error = (...a: unknown[]) => {
  note(`console.error: ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}`);
  conError(...a);
};

/** 面はアプリと同じ入れ子で1枚だけ作り、以後は loadDocument で中身を替える */
let inner: HTMLElement | null = null;
let viewer: CoreViewer | null = null;

function makeViewer(): CoreViewer {
  inner = document.createElement('div');
  inner.style.cssText =
    'position:absolute;top:0;left:0;right:0;bottom:46px;overflow:auto;opacity:1;';
  host.appendChild(inner);
  return new CoreViewer(
    { viewportElement: inner },
    {
      autoResize: true,
      renderAllPages: RENDER_ALL,
      pageViewMode: PageViewMode.SPREAD,
      fitToScreen: true,
      pageBorderWidth: 1,
      pixelRatio: 0,
    },
  );
}

/** 1冊ぶん測る */
async function oneBook(what: string, load: () => Promise<Manuscript>): Promise<Stage> {
  roundErrors = [];

  // ---- 0. 取り込み ----
  const t0 = performance.now();
  const ms = await load();
  const importSec = Math.round((performance.now() - t0) / 10) / 100;
  const s = longSettings({ yoko });

  // ---- 1. 書体を集める ----
  const t1 = performance.now();
  const fontCss = WITH_FONTS ? longFontFaceCss(ms, s) : '';
  const fontSec = Math.round((performance.now() - t1) / 10) / 100;

  // ---- 2. 組版HTMLを作る ----
  const t2 = performance.now();
  const html = manuscriptHtml(ms, s, fontCss);
  const buildSec = Math.round((performance.now() - t2) / 10) / 100;

  if (!viewer) viewer = makeViewer();
  const v = viewer;
  const el = inner!;

  const pageEls = () =>
    Array.from(el.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]'));

  // ---- サムネイル。アプリと同じ道具を同じように使う ----
  const thumbs = THUMBS ? createThumbs(strip, () => { /* 飛ばさない */ }, {}) : null;
  thumbs?.setBusy(true);

  let firstMs = 0;
  let allMs = 0;
  let firstBoxMs = 0;
  let epageCount = 0;
  let done = false;
  let t3 = 0;

  const onReady = () => {
    const st = v.readyState;
    if (st === 'interactive' && !firstMs) firstMs = performance.now() - t3;
    if (st === 'complete') {
      if (!firstMs) firstMs = performance.now() - t3;
      allMs = performance.now() - t3;
      done = true;
    }
  };
  const onNav = (p: { epageCount?: number }) => {
    if (typeof p.epageCount === 'number' && p.epageCount > 0) epageCount = p.epageCount;
  };
  v.addListener('readystatechange', onReady);
  v.addListener('nav', onNav as never);

  const pulse = new Pulse();
  pulse.start();

  // ---- 3. 食わせる ----
  t3 = performance.now();
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  v.loadDocument({ url }, {}, {
    autoResize: true,
    renderAllPages: RENDER_ALL,
    pageViewMode: PageViewMode.SPREAD,
    fitToScreen: true,
  });

  // ---- 待つあいだ、アプリと同じ 700ms ごとの sync を打つ ----
  let thumbSyncs = 0;
  let thumbSyncTotal = 0;
  let lastSync = performance.now();
  const end = performance.now() + TIMEOUT_MS;
  while (!done && performance.now() < end) {
    await sleep(50);
    if (!firstBoxMs && pageEls().length > 0) firstBoxMs = performance.now() - t3;
    if (performance.now() - lastSync >= 700) {
      lastSync = performance.now();
      const s0 = performance.now();
      thumbs?.sync(pageEls());
      thumbSyncTotal += performance.now() - s0;
      thumbSyncs += 1;
    }
    /**
     * **`renderAllPages` を切ったときは `complete` が来ない。**
     * Vivliostyle は `renderAllPages && setReadyState("complete")` と書いてある
     * (node_modules を読んで確認)。`interactive` で切り上げないと、
     * 上限いっぱいまで待ちぼうけになる
     */
    if (!RENDER_ALL && firstMs) {
      allMs = performance.now() - t3;
      done = true;
    }
  }
  const stall = pulse.stop();
  if (!allMs) allMs = performance.now() - t3;

  // ---- 6. 全ページぶんの sync を1回、まとめて測る ----
  const els = pageEls();
  const s0 = performance.now();
  thumbs?.sync(els);
  const thumbSyncMs = Math.round((performance.now() - s0) * 10) / 10;
  thumbs?.setBusy(false);

  let pagesByViewer = 0;
  try {
    pagesByViewer = v.getPageSizes().length;
  } catch (e) {
    note(`getPageSizes: ${String(e)}`);
  }

  v.removeListener('readystatechange', onReady);
  v.removeListener('nav', onNav as never);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  thumbs?.destroy();

  return {
    what,
    chapters: ms.chapters.length,
    distinctChars: bookTextOf(ms, s).length,
    htmlChars: html.length,
    fontCssChars: fontCss.length,
    importSec,
    fontSec,
    buildSec,
    firstSec: Math.round(firstMs / 10) / 100,
    firstBoxSec: Math.round(firstBoxMs / 10) / 100,
    allSec: Math.round(allMs / 10) / 100,
    totalSec: Math.round((importSec + fontSec + buildSec) * 100 + allMs / 10) / 100,
    pages: els.length,
    pagesByViewer,
    epageCount,
    done,
    thumbSyncMs,
    thumbSyncs,
    thumbSyncTotalMs: Math.round(thumbSyncTotal),
    stalls: stall.stalls,
    worstMs: stall.worstMs,
    stalledSec: stall.stalledSec,
    errors: roundErrors,
  };
}

async function main() {
  const stages: Stage[] = [];
  if (REAL) {
    stages.push(
      await oneBook('body.docx', async () => {
        const res = await fetch('/to claude/body.docx');
        if (!res.ok) throw new Error(`to claude/body.docx が読めない（${res.status}）`);
        // parseDocx は {manuscript, skippedColumnPages} を返す(2026-08-21 に変わった)
    return (await parseDocx(await res.arrayBuffer(), 'body')).manuscript;
      }),
    );
  }
  for (const scale of SCALES) {
    stages.push(await oneBook(`x${scale}`, async () => stackManuscript(sampleManuscript(), scale)));
    await sleep(300);
  }
  stage.hidden = false;
  reportProbe(
    {
      ok: stages.every((s) => s.done),
      kind: 'long',
      renderAllPages: RENDER_ALL,
      withFonts: WITH_FONTS,
      writingMode: yoko ? 'horizontal' : 'vertical',
      thumbs: THUMBS,
      stages,
      errors: allErrors,
    },
    stages.every((s) => s.done),
  );
}

void main().catch((e) => {
  allErrors.push(String(e));
  reportProbe({ ok: false, kind: 'long', stages: [], errors: allErrors,
                note: '測っている途中で落ちた' }, false);
});
