// トップの「めくれる本」用の撮影台。**サンプル本を CoreViewer で1ページずつ出す。**
//
// 下見(アプリの画面)は「いまの見開きしか DOM に置かない」ので、そのままでは
// 全ページを撮れない。ここでは同じ組版HTML・同じ CoreViewer を単ページ表示で立て、
// 撮影係(scripts/build-hero-pages.mjs)が window.__hero.go(i) でページを送りながら撮る。
//
// 開き方: http://localhost:5173/scripts/hero-probe.html
// 組み上がると document.title が PROBE-DONE になる(流儀は preview-probe と同じ)。
import { CoreViewer, Navigation, PageViewMode } from '@vivliostyle/core';
import '../src/fontsAll';
import { defaultSettings } from '../src/models/project';
import { manuscriptHtml } from '../src/typeset/html';
import { sampleManuscript } from '../src/sample';
import { loadSampleArt } from '../src/sampleArt';
import { reportProbe } from './probe-report';

const host = document.getElementById('probe-viewport') as HTMLElement;
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));

async function main() {
  // **アプリの loadSample と同じ組み立て**(store/useProject.ts)。
  // 素の原稿だけ組むと挿絵も背景も無い別の本になる(31頁 vs 46頁)
  const ms = sampleManuscript();
  const art = await loadSampleArt(ms.chapters.length);
  const settings = { ...defaultSettings(), ...(art ?? {}) };
  // ?ink=color で「カラーで刷る本」として組む。トップの白黒⇄カラー切替は
  // 画像へのフィルタ加工ではなく、この設定違いの実出力を2セット撮って見せる
  // (2026-09-11 ユーザー要望「どっちも作れるのが売り」)
  if (new URLSearchParams(location.search).get('ink') === 'color') settings.ink = 'color';
  const html = manuscriptHtml(ms, settings);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));

  const viewer = new CoreViewer(
    { viewportElement: host },
    {
      autoResize: true,
      renderAllPages: true,
      pageViewMode: PageViewMode.SINGLE_PAGE,
      fitToScreen: true,
      pageBorderWidth: 0,
      pixelRatio: 0,
    },
  );
  let ready = false;
  viewer.addListener('readystatechange', () => {
    if (viewer.readyState === 'complete') ready = true;
  });
  viewer.addListener('error', (payload) => {
    errors.push(`viewer error: ${JSON.stringify((payload as { content?: unknown })?.content ?? payload)}`);
  });
  viewer.loadDocument({ url }, {}, { renderAllPages: true, pageViewMode: PageViewMode.SINGLE_PAGE });

  const t0 = Date.now();
  while (!ready && Date.now() - t0 < 180000) await new Promise((r) => setTimeout(r, 200));
  await document.fonts.ready;

  const pages = viewer.getPageSizes().length;
  (window as unknown as { __hero: unknown }).__hero = {
    pages,
    go: (i: number) => viewer.navigateToPage(Navigation.EPAGE, i),
  };
  reportProbe({ ok: ready, pages, errors }, ready);
}

void main().catch((e) => {
  errors.push(String(e));
  reportProbe({ ok: false, pages: 0, errors }, false);
});
