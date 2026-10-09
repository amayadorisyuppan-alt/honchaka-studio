// **生プレビュー(画面のほう)を機械で測る。**
//
// ## なぜ在るか
//
// 署名の行末寄せ(原稿の `>>`)が「紙では効いているのに画面では効いていない」と
// 報告された(2026-08-21)。紙は scripts/check-typeset.py が Vivliostyle CLI で
// PDF にして測れるが、**画面のほうを測る道が無かった**ので、切り分けが目視しかできない。
//
// このページはアプリの生プレビュー(src/preview/VivliostylePreview.tsx)と
// **同じ CoreViewer を同じ引数で立て、同じ組版HTMLを食わせる。**
// 違うのは React とアプリのCSSが乗っていないことだけ。
//
// ## 使い方
//
//   npx vite --port 5199            (開発サーバー)
//   http://localhost:5199/scripts/preview-probe.html?wm=v
//
// 測り終わると document.title が `PROBE-DONE` になり、
// `#probe-result` に JSON が入る。落ちたら `PROBE-FAIL`。
// ふだんは scripts/check-typeset.py が headless Chrome ごと回す。
import { CoreViewer, Navigation, PageViewMode } from '@vivliostyle/core';
import { buildCheckHtml } from './check-doc';
import { reportProbe } from './probe-report';

const params = new URLSearchParams(location.search);
const yoko = params.get('wm') === 'h';
const dense = params.get('dense') === '1';
/** 何ページまで見るか。ページ送りは1枚ずつ組み直すので、上限を切っておく */
const MAX_PAGES = Number(params.get('max') ?? 200);
/** 組み上がりを待つ上限(ミリ秒)。ここを越えたら「止まった」として報告する */
const TIMEOUT_MS = Number(params.get('timeout') ?? 120000);

/**
 * アプリのCSS(src/app.css)を被せて測る。
 *
 * **生プレビューはアプリと同じDOMの中で組まれる。** だからアプリのCSSは
 * 組み上がったページの中まで届く(box-sizing で版面が6割に縮んだ事故と同じ道)。
 * `?appcss=1` を付けると、アプリと同じ入れ子(.preview-viewport > 中身)を作って測る
 */
const withAppCss = params.get('appcss') === '1';

const host = document.getElementById('probe-viewport') as HTMLElement;

// アプリと同じ入れ子にする。VivliostylePreview は .preview-viewport の中に
// 素の div を作り、そこを viewportElement に渡している
let viewport = host;
if (withAppCss) {
  await import('../src/app.css');
  host.className = 'preview-viewport';
  viewport = document.createElement('div');
  viewport.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;overflow:auto;';
  host.appendChild(viewport);
}

interface AlignFinding {
  /** 何ページ目に出たか(1始まり) */
  page: number;
  text: string;
  /** 計算後の text-align。行末寄せなら right か end が入っているはず */
  textAlign: string;
  textAlignLast: string;
  /** 段落の箱の「行末」側の座標(縦組みなら地、横組みなら右) */
  boxEnd: number;
  /** 字の並びの「行末」側の座標 */
  inkEnd: number;
  /** その差。0 に近ければ行末に着いている */
  gap: number;
  /** 段落の箱の「行頭」側から字までの空き。行頭のままなら 0 になる */
  headGap: number;
}

interface ProbeResult {
  ok: boolean;
  writingMode: 'vertical' | 'horizontal';
  /** 実際に見えたページ数 */
  pages: number;
  /** 組み上がりを待つあいだに出た例外(生プレビューは黙って止まるので拾う) */
  errors: string[];
  aligns: AlignFinding[];
  /** アプリのCSSを被せて測ったか */
  appCss: boolean;
  note?: string;
}

const errors: string[] = [];
window.addEventListener('error', (e) => {
  errors.push(`${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`);
});

function finish(r: ProbeResult) {
  reportProbe(r, r.ok);
}

/**
 * 段落の「行末」側の空きを測る。
 *
 * **物理の左右で書かない。** 縦組みの行末は地(下)、横組みの行末は右。
 * 字の並びは Range で測る — 段落の箱は行末まで伸びているので、箱だけ見ても分からない。
 */
function measureAlign(p: HTMLElement, vertical: boolean): Omit<AlignFinding, 'page'> {
  const box = p.getBoundingClientRect();
  const range = p.ownerDocument.createRange();
  range.selectNodeContents(p);
  const ink = range.getBoundingClientRect();
  const cs = getComputedStyle(p);
  const boxEnd = vertical ? box.bottom : box.right;
  const inkEnd = vertical ? ink.bottom : ink.right;
  const boxHead = vertical ? box.top : box.left;
  const inkHead = vertical ? ink.top : ink.left;
  return {
    text: (p.textContent ?? '').slice(0, 20),
    textAlign: cs.textAlign,
    textAlignLast: cs.textAlignLast,
    boxEnd: Math.round(boxEnd * 1000) / 1000,
    inkEnd: Math.round(inkEnd * 1000) / 1000,
    gap: Math.round((boxEnd - inkEnd) * 1000) / 1000,
    headGap: Math.round((inkHead - boxHead) * 1000) / 1000,
  };
}

async function main() {
  const html = buildCheckHtml({ yoko, dense });
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);

  // **アプリと同じ引数**(src/preview/VivliostylePreview.tsx)。
  // ここを勝手に変えると、測っているものがアプリの画面ではなくなる
  const viewer = new CoreViewer(
    { viewportElement: viewport },
    {
      autoResize: true,
      renderAllPages: true,
      pageViewMode: PageViewMode.SPREAD,
      fitToScreen: true,
      pageBorderWidth: 1,
      pixelRatio: 0,
    },
  );

  let ready = false;
  viewer.addListener('readystatechange', () => {
    if (viewer.readyState === 'complete') ready = true;
  });
  viewer.addListener('error', (payload) => {
    errors.push(`viewer error: ${JSON.stringify(payload?.content ?? payload)}`);
  });

  viewer.loadDocument({ url }, {}, { renderAllPages: true, pageViewMode: PageViewMode.SPREAD });

  const start = Date.now();
  while (!ready && Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const pageCount = viewer.getPageSizes().length;
  if (!ready) {
    finish({
      ok: false,
      writingMode: yoko ? 'horizontal' : 'vertical',
      pages: pageCount,
      errors,
      aligns: [],
      appCss: withAppCss,
      note: `組み上がらないまま ${TIMEOUT_MS}ms が過ぎた(${pageCount}ページで止まっている)`,
    });
    return;
  }

  // **1ページずつ送って測る。** CoreViewer は見えている見開きしか DOM に置かないので、
  // 全ページを一度に querySelectorAll することはできない
  const aligns: AlignFinding[] = [];
  const seen = new Set<string>();
  const limit = Math.min(pageCount, MAX_PAGES);
  for (let i = 0; i < limit; i++) {
    viewer.navigateToPage(Navigation.EPAGE, i);
    await new Promise((r) => setTimeout(r, 0));
    viewport.querySelectorAll<HTMLElement>('p.align-end').forEach((p) => {
      const m = measureAlign(p, !yoko);
      const key = `${m.text}/${m.inkEnd}`;
      if (seen.has(key)) return;
      seen.add(key);
      aligns.push({ page: i + 1, ...m });
    });
  }

  finish({
    ok: true,
    writingMode: yoko ? 'horizontal' : 'vertical',
    pages: pageCount,
    errors,
    aligns,
    appCss: withAppCss,
  });
}

void main().catch((e) => {
  errors.push(String(e));
  finish({
    ok: false,
    writingMode: yoko ? 'horizontal' : 'vertical',
    pages: 0,
    errors,
    aligns: [],
    appCss: withAppCss,
    note: '測っている途中で落ちた',
  });
});
