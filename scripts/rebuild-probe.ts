// **組み直しを繰り返しても遅くならないか**を測る。
//
// ## なぜ在るか
//
// 「プレビューが立ち上がるまでに10分以上」「2ページ目でフリーズ」(2026-08-21 ユーザー報告)は、
// まっさらなサンプルでは再現しない(4秒で43ページ)。**溜まって効いてくる型**の不具合なので、
// 1回組んで測っても出てこない。ここでは**アプリと同じ組み直しを何度も回して、
// 1回あたりの秒数・窓に付いた監視の数・JSヒープを並べて出す。**
//
// もうひとつ、**版面が画面に出ていないあいだの組み直し**も測る。
// アプリは表紙・AI・書き出しの工程で `.main[hidden]`(= display:none)にするが、
// プレビューは畳まずに生きたままなので、その状態で組み直しが走ることがある。
//
// ## 使い方
//
//   npx vite --port 5199
//   http://localhost:5199/scripts/rebuild-probe.html?rounds=10&mode=leak
//
// 測り終わると document.title が `PROBE-DONE` になり、`#probe-result` に JSON が入る。
// ふだんは scripts/check-typeset.py が headless Chrome ごと回す(--only-screen)。
import { CoreViewer, Navigation, PageViewMode } from '@vivliostyle/core';
import { buildCheckHtml } from './check-doc';
import { reportProbe } from './probe-report';

const params = new URLSearchParams(location.search);
const yoko = params.get('wm') === 'h';
/** 何回組み直すか。1回 3〜5秒かかるので、既定は控えめに */
const ROUNDS = Number(params.get('rounds') ?? 8);
/**
 * 組み直しのやり方。
 *
 * - `leak`  … いまのアプリと同じ。毎回ビューアを作り、捨てるときは何もしない
 * - `fix`   … 毎回作るが、捨てるときに autoResize を落として聞き耳も外す
 * - `reuse` … **ビューアを1つだけ作り、`loadDocument` で中身を差し替える**
 * - `swap`  … **面を2枚だけ作って交互に使う**(片方で組み、もう片方を見せたまま)。
 *             アプリに入れたのはこれ
 */
const MODE = (['fix', 'reuse', 'swap'].includes(params.get('mode') ?? '')
  ? params.get('mode')
  : 'leak') as 'leak' | 'fix' | 'reuse' | 'swap';
/** 組み直しのあいだに窓の大きさが変わった合図を投げる(autoResize の疑いを潰す) */
const RESIZE = params.get('resize') === '1';
/**
 * **何回目を「版面が画面に出ていないまま」組むか**(`.main[hidden]` の再現)。0 なら試さない。
 * 既定は最後の1回。**途中の回に指すと、そのあと組み直しが戻ってくるかまで測れる**
 */
const HIDDEN_AT = Number(params.get('hiddenAt') ?? (params.get('hidden') === '0' ? 0 : -1));
/** 1回の組み上がりを待つ上限(ミリ秒)。越えたら「止まった」として記録し、次へ進む */
const ROUND_TIMEOUT_MS = Number(params.get('timeout') ?? 90000);

const stage = document.getElementById('probe-stage') as HTMLElement;
const host = document.getElementById('probe-viewport') as HTMLElement;

// アプリのCSSを被せる。**生プレビューはアプリと同じDOMの中で組まれる**ので、
// アプリのCSSは組み上がったページの中まで届く(box-sizing で版面が6割に縮んだ事故と同じ道)
await import('../src/app.css');
host.className = 'preview-viewport';

/* ------------------------------------------------------------------ *
 * 窓に付いた「大きさが変わった」の監視を数える。
 *
 * CoreViewer は autoResize: true のとき window に resize の監視を1つ足す。
 * **外す道はビューア側の後始末には無い**(CoreViewer に destroy が無い)ので、
 * 捨てたビューアがいくつ生き残っているかは、この数で分かる。
 * ビューアを1つも作っていないうちに差し替えておくこと。
 * ------------------------------------------------------------------ */
/**
 * **同じ関数を2回足しても、ブラウザは1つしか持たない。**
 * だから回数ではなく**別々の関数がいくつ生きているか**を数える。
 * (ビューアを使い回すと同じ関数が何度も足されるが、増えてはいない)
 */
const liveResize = new Set<unknown>();
const addEL = window.addEventListener.bind(window);
const removeEL = window.removeEventListener.bind(window);
window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject,
                            opt?: boolean | AddEventListenerOptions) => {
  if (type === 'resize') liveResize.add(fn);
  return addEL(type as keyof WindowEventMap, fn as EventListener, opt);
}) as typeof window.addEventListener;
window.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject,
                               opt?: boolean | EventListenerOptions) => {
  if (type === 'resize') liveResize.delete(fn);
  return removeEL(type as keyof WindowEventMap, fn as EventListener, opt);
}) as typeof window.removeEventListener;

/**
 * JSヒープ(MB)。Chrome にしか無い。取れなければ 0。
 *
 * **回収してから測る。** `usedJSHeapSize` は回収前の値も含むので、
 * そのまま並べると「直したのに減らない」ように見える(実測で踏んだ)。
 * `--js-flags=--expose-gc` を付けて開いたときだけ `gc()` が生える
 */
function heapMB(): number {
  const g = (window as unknown as { gc?: () => void }).gc;
  if (g) { g(); g(); }
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : 0;
}

interface Round {
  /** 何回目か(1始まり) */
  i: number;
  /** その回を「版面が画面に出ていないまま」組んだか */
  hidden: boolean;
  /** 組み上がるまでの秒数 */
  sec: number;
  /** 組み上がったページ数(DOM から数える。組版器に訊くと止まっているときに嘘が出る) */
  pages: number;
  /** 組み上がりの合図が来たか。false なら**止まった** */
  done: boolean;
  /** 窓に残っている resize の監視の数 */
  listeners: number;
  /** JSヒープ(MB) */
  heapMB: number;
  /** 捨てたのに、まだ生きているビューアの数 */
  zombies: number;
  /** 紙面が1枚も無かった時間(ミリ秒)。ちらつきの目安 */
  blankMs: number;
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
// **Vivliostyle は例外をコンソールへ流して黙る。** window の error では拾えないので、
// console.error も見張る(leader() の TypeError はこの道でしか出てこない)
const conError = console.error.bind(console);
console.error = (...a: unknown[]) => {
  note(`console.error: ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}`);
  conError(...a);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** いま画面に残っている誌面(アプリの liveInnerRef と同じ役目) */
let liveInner: HTMLElement | null = null;
/** `reuse` のとき、使い回すビューア */
let liveViewer: CoreViewer | null = null;
/**
 * **捨てたビューアが、まだ生きているか。**
 *
 * 弱い参照で持っておいて、回収を促したあとに数える。
 * ヒープのMBは回収の間合いで揺れるが、この数は揺れない。
 * `--js-flags=--expose-gc` を付けて開いたときだけ意味を持つ
 */
const retired: WeakRef<CoreViewer>[] = [];
function aliveRetired(): number {
  return retired.filter((r) => r.deref()).length;
}

// アプリと同じだけ聞き耳を立てておく(数が効くかもしれない)
const onNav = () => { /* 何もしない */ };
const onHyper = () => { /* 何もしない */ };
const onViewerError = (p: { content?: unknown }) =>
  note(`viewer error: ${JSON.stringify(p?.content ?? p)}`);

/** `swap` で交互に使う面。アプリの Buf と同じ持ちもの */
interface Buf { inner: HTMLElement; viewer: CoreViewer }
const bufs: Buf[] = [];
let turn = 0;

/** 面を1枚作る。**ビューアはここでだけ作る**(以後は loadDocument で中身を替える) */
function makeBuf(): Buf {
  const inner = document.createElement('div');
  inner.style.cssText =
    'position:absolute;top:0;left:0;right:0;bottom:44px;overflow:auto;opacity:0;pointer-events:none;';
  host.appendChild(inner);
  const viewer = new CoreViewer(
    { viewportElement: inner },
    {
      autoResize: true,
      renderAllPages: true,
      pageViewMode: PageViewMode.SPREAD,
      fitToScreen: true,
      pageBorderWidth: 1,
      pixelRatio: 0,
    },
  );
  viewer.addListener('nav', onNav);
  viewer.addListener('hyperlink', onHyper);
  viewer.addListener('error', onViewerError);
  return { inner, viewer };
}

/**
 * アプリ(src/preview/VivliostylePreview.tsx)の組み直しを1回ぶん、そのまま再現する。
 *
 * 引数・リスナー・入れ子・後始末の順まで写している。**ここを勝手に変えると、
 * 測っているものがアプリの画面ではなくなる。**
 */
async function oneRound(i: number, html: string, hide = false): Promise<Round> {
  roundErrors = [];
  stage.hidden = hide;
  const t0 = performance.now();

  let inner = liveInner;
  let viewer = liveViewer;
  let done = false;
  const onReady = () => { if (viewer!.readyState === 'complete') done = true; };

  if (MODE === 'swap') {
    // 面2枚を交互に。**組むのは、いま見せていないほう**
    if (bufs.length < 2) bufs.push(makeBuf());
    const buf = bufs[turn % bufs.length]!;
    turn += 1;
    inner = buf.inner;
    viewer = buf.viewer;
    // **面は外さない。** 外した(=描かれない)木の中で組むと、
    // 目次のリーダー罫で必ず止まる。退かせるのは opacity だけ
    inner.style.opacity = '0';
    inner.style.pointerEvents = 'none';
  } else if (MODE !== 'reuse' || !viewer || !inner) {
    inner = document.createElement('div');
    inner.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:44px;overflow:auto;opacity:0;pointer-events:none;';
    host.appendChild(inner);

    viewer = new CoreViewer(
      { viewportElement: inner },
      {
        autoResize: true,
        renderAllPages: true,
        pageViewMode: PageViewMode.SPREAD,
        fitToScreen: true,
        pageBorderWidth: 1,
        pixelRatio: 0,
      },
    );
    viewer.addListener('nav', onNav);
    viewer.addListener('hyperlink', onHyper);
    viewer.addListener('error', onViewerError);
  }
  viewer.addListener('readystatechange', onReady);

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  viewer.loadDocument({ url }, {}, {
    autoResize: true,
    renderAllPages: true,
    pageViewMode: PageViewMode.SPREAD,
    fitToScreen: true,
  });

  /**
   * **紙面が消えていた時間。**
   *
   * いまのアプリは毎回あたらしい面を作り、組み上がってから古い面を捨てる
   * (2026-08-19 ユーザー指摘「1個作業するたびに読み込みなおしになる」への直し)。
   * ビューアを使い回すと同じ面の中身が差し替わるので、**そのあいだ紙が消えないか**を測る。
   * ここが大きいと、直したとたんにちらつきが戻る
   */
  let blankMs = 0;
  const count = () => inner!.querySelectorAll('[data-vivliostyle-page-container]').length;
  const end = performance.now() + ROUND_TIMEOUT_MS;
  let lastAt = performance.now();
  while (!done && performance.now() < end) {
    await sleep(50);
    const now = performance.now();
    if (count() === 0) blankMs += now - lastAt;
    lastAt = now;
  }
  const sec = Math.round((performance.now() - t0) / 10) / 100;
  const pages = count();

  // ---- 後始末。アプリと同じ順で ----
  viewer.removeListener('readystatechange', onReady);
  if (MODE === 'swap') {
    // 組み上がった面を見せ、前に見せていた面を退かせる
    inner.style.opacity = '1';
    inner.style.pointerEvents = '';
    if (liveInner && liveInner !== inner) {
      liveInner.style.opacity = '0';
      liveInner.style.pointerEvents = 'none';
    }
    liveInner = inner;
    liveViewer = viewer;
  } else if (MODE === 'reuse') {
    liveInner = inner;
    liveViewer = viewer;
  } else {
    if (liveInner && liveInner !== inner) liveInner.remove();
    liveInner = inner;
    if (MODE === 'fix') {
      // **窓の監視を外し、聞き耳も外す。**
      // CoreViewer に destroy は無いが、autoResize を落とせば
      // window から resize の監視が外れる(= 参照が1本切れる)
      viewer.setOptions({ autoResize: false });
      viewer.removeListener('nav', onNav);
      viewer.removeListener('hyperlink', onHyper);
      viewer.removeListener('error', onViewerError);
    }
    retired.push(new WeakRef(viewer));
  }
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  stage.hidden = false;

  const heap = heapMB(); // 先に回収を促す。zombies はそのあとで数える
  return { i, hidden: hide, sec, pages, done, listeners: liveResize.size,
           heapMB: heap, zombies: aliveRetired(),
           blankMs: Math.round(blankMs), errors: roundErrors };
}

/**
 * **画面に戻ったことに気づけるか**を先に確かめる。
 *
 * 直しの側は「版面が画面に出ていないあいだは組まない。出たら組む」という形にした。
 * その「出た」に気づく手段が ResizeObserver なので、**display:none の出し入れで
 * 本当に呼ばれるのか**をここで測っておく(呼ばれなければ、直しは永久に組み直さない)。
 */
async function watchCheck(): Promise<{ onHide: boolean; onShow: boolean }> {
  let hits = 0;
  let onHide = false;
  let onShow = false;
  const ro = new ResizeObserver(() => { hits++; });
  ro.observe(host);
  await sleep(120); // 監視を始めた直後の1回目を捨てる
  hits = 0;
  stage.hidden = true;
  await sleep(200);
  onHide = hits > 0;
  hits = 0;
  stage.hidden = false;
  await sleep(200);
  onShow = hits > 0;
  ro.disconnect();
  return { onHide, onShow };
}

/**
 * **ビューアを作り直さずに、見開き↔1ページと倍率を切り替えられるか。**
 *
 * 「作り直さず `loadDocument` で中身だけ差し替える」を採るなら、ここが効かないと話にならない
 * (いまのアプリは `view` が変わるたびにビューアごと作り直している)。
 * 見えているページの数で測る — Vivliostyle は出していないページに `display: none` を書く。
 */
async function viewSwitchCheck(): Promise<{ spread: number; single: number; back: number;
                                            fitPct: number; zoomPct: number }> {
  const v = liveViewer;
  const el = liveInner;
  if (!v || !el) return { spread: 0, single: 0, back: 0, fitPct: 0, zoomPct: 0 };
  const shown = () =>
    Array.from(el.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]'))
      .filter((p) => p.style.display !== 'none').length;
  /**
   * ページの箱に載っている拡大率(%)。アプリ(fitPct)と同じ測り方で、
   * 描画後の幅と変形前の幅の比を見る
   */
  const pct = () => {
    const box = Array.from(el.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]'))
      .find((b) => b.offsetWidth > 0 && b.getBoundingClientRect().width > 0);
    return box ? Math.round((box.getBoundingClientRect().width / box.offsetWidth) * 100) : 0;
  };
  // **1ページ目では見開きにならない**(大扉は片側だけ)。中ほどへ送ってから数える
  v.navigateToPage(Navigation.EPAGE, 6);
  await sleep(800);
  const spread = shown();
  v.setOptions({ pageViewMode: PageViewMode.SINGLE_PAGE });
  await sleep(800);
  const single = shown();
  v.setOptions({ pageViewMode: PageViewMode.SPREAD });
  await sleep(800);
  const back = shown();
  const fitPct = pct();
  v.setOptions({ fitToScreen: false, zoom: 0.5 });
  await sleep(600);
  const zoomPct = pct();
  v.setOptions({ fitToScreen: true });
  await sleep(600);
  return { spread, single, back, fitPct, zoomPct };
}

/**
 * **原稿を食わせていないビューアなら回収されるのか。**
 *
 * 捨てたビューアが1つも回収されないと分かったので、どこが握っているのかを切り分ける。
 * `loadDocument` を呼ぶと Vivliostyle は**終わらない命令待ちのループ**を
 * 共通の走らせ手(scheduler)の上に立てる。ここが握っているなら、
 * **食わせていないビューアだけは回収される**はず
 */
async function emptyViewerCheck(): Promise<{ made: number; alive: number }> {
  const refs: WeakRef<CoreViewer>[] = [];
  for (let i = 0; i < 3; i++) {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;width:10px;height:10px;opacity:0;';
    host.appendChild(el);
    refs.push(new WeakRef(new CoreViewer({ viewportElement: el }, { autoResize: false })));
    el.remove();
  }
  await sleep(100);
  const g = (window as unknown as { gc?: () => void }).gc;
  if (g) { g(); g(); }
  await sleep(100);
  if (g) { g(); }
  return { made: refs.length, alive: refs.filter((r) => r.deref()).length };
}

/**
 * **目次のリーダー罫を消して組む。**(`?noleader=1`)
 *
 * 「止まるのは本当にリーダー罫のせいか」「消せば避けられるのか」を測るためだけの道。
 * 引き継ぎメモの「ドロップキャップ・段間罫・リンク」に、CSSの機能を諦めて
 * HTML側で作り直した前例があるので、同じ手が使えるかをここで確かめる
 */
function stripLeader(html: string): string {
  return html.replace(
    '</head>',
    '<style>.toc a::after{content:none}</style></head>',
  );
}

async function main() {
  const raw = buildCheckHtml({ yoko });
  const html = params.get('noleader') === '1' ? stripLeader(raw) : raw;
  const empty = await emptyViewerCheck();
  const watch = await watchCheck();
  const rounds: Round[] = [];

  /**
   * **版面が画面に出ていないあいだの組み直し。**
   * アプリは表紙・AI・書き出しの工程で `.main` を display:none にする。
   * プレビューはそのまま生きているので、その状態で設定を触ると組み直しが走る。
   * `hiddenAt` が -1 なら最後に1回だけ足す
   */
  const hideAt = HIDDEN_AT === -1 ? ROUNDS + 1 : HIDDEN_AT;
  // 隠して組む回が最後に足されることもあるので、そのぶんまで回す
  const total = Math.max(ROUNDS, hideAt);

  for (let i = 1; i <= total; i++) {
    if (RESIZE && i > 1) {
      // 窓の大きさが変わった合図。捨てたビューアが生きていれば、ここで全部が組み直しにかかる
      window.dispatchEvent(new Event('resize'));
      await sleep(300);
    }
    rounds.push(await oneRound(i, html, i === hideAt));
  }

  const viewSwitch = MODE === 'reuse' ? await viewSwitchCheck() : null;

  // 見えている回だけで倍率を取る(隠したまま組んだ回は、そもそも組み上がらない)
  const shown = rounds.filter((r) => !r.hidden);
  const first = shown[0];
  const last = shown[shown.length - 1];
  const ratio = first && last && first.sec > 0
    ? Math.round((last.sec / first.sec) * 100) / 100
    : 0;

  reportProbe({
    ok: shown.every((r) => r.done),
    mode: MODE,
    resizeBetween: RESIZE,
    hiddenAt: hideAt <= total ? hideAt : 0,
    writingMode: yoko ? 'horizontal' : 'vertical',
    /** display:none の出し入れに ResizeObserver が気づくか(直しが立っている土台) */
    watch,
    /** 原稿を食わせていないビューアは回収されるか(どこが握っているかの切り分け) */
    empty,
    /** ビューアを作り直さずに見開き↔1ページ・倍率を切り替えられるか(reuse のときだけ) */
    viewSwitch,
    rounds,
    /** 最後の1回が最初の1回の何倍か。**溜まっていれば、ここが伸びる** */
    ratio,
    errors: allErrors,
  }, shown.every((r) => r.done));
}

void main().catch((e) => {
  allErrors.push(String(e));
  reportProbe({ ok: false, mode: MODE, rounds: [], ratio: 0,
                errors: allErrors, note: '測っている途中で落ちた' }, false);
});
