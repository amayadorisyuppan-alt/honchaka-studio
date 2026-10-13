// **見本の本の千鳥(第二章の文中の画像)が、判型ごとにどう組まれるかを測る。**(2026-10-12 修正リスト 20)
//
// 千鳥の置き場所(src/sample.ts)を、文庫・B6・A5(どれも縦組み・既定の文字サイズ)で
// 「絵の下(縦組みなら左)に本文が回り込み、絵だけのページにならない」ように選ぶための検査台。
// アプリと同じ書体・同じ CoreViewer で見本の本を組み、ページごとに
//
//   - 本文の行が何行立っているか
//   - 千鳥(figure.fig)がそのページにあるか
//
// を数える。**絵だけのページ**は「図があって本文の行が 0」のページ。
//
// 使い方(開発サーバーは使わず、検査用に組んだ静的ファイルを配って headless Chrome で開く。
// 回し方は scripts/sample-fig-probe-run.mjs の頭):
//   sample-fig-probe.html?trim=bunko&before=<段落の頭の文>
//
// `before` を省くと sampleManuscript() が入れた位置のまま測る(いまの置き場所の確かめ)。
// 渡すと、千鳥をその文で始まる段落の直前へ動かして測る(置き場所の候補を比べるため)。
// `before=none` で千鳥を外した本(総ページ数の基準)を測る。
import { CoreViewer, Navigation, PageViewMode } from '@vivliostyle/core';
import { defaultSettings, typographyDefaults } from '../src/models/project';
import type { ProjectSettings, TrimId } from '../src/models/project';
import { sampleManuscript } from '../src/sample';
import { loadSampleArt } from '../src/sampleArt';
import { SAMPLE_FIG } from '../src/sampleFig';
import { manuscriptHtml } from '../src/typeset/html';
import { longFontFaceCss } from './long-doc';
import { reportProbe } from './probe-report';

// アプリと同じ書体をぜんぶ読み込む(long-probe.ts と同じ理由)
await import('../src/fontsAll');
await import('../src/app.css');

const params = new URLSearchParams(location.search);
const trim = (params.get('trim') ?? 'bunko') as TrimId;
const before = params.get('before');
const host = document.getElementById('probe-viewport') as HTMLElement;
// **入れ子はアプリと同じにする**(.preview-viewport > 素の div)。app.css は組み上がったページの中まで届くので、
// この入れ子を省くと box-sizing で版面が縮み、1ページの行数も総ページ数も実物とずれる(long-probe.ts と同じ)
host.className = 'preview-viewport';
const viewport = document.createElement('div');
viewport.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;overflow:auto;';
host.appendChild(viewport);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ms = sampleManuscript();
  const ch2 = ms.chapters[1]!;
  // 千鳥の入れ場所を動かす。sampleManuscript() が入れた1枚を外して、指定の段落の直前へ挿し直す
  if (before !== null) {
    const i = ch2.blocks.findIndex((b) => b.type === 'image' && b.src === SAMPLE_FIG);
    const [fig] = i >= 0 ? ch2.blocks.splice(i, 1) : [];
    if (fig && before !== 'none') {
      const at = ch2.blocks.findIndex((b) => b.type === 'p' && b.text.startsWith(before));
      if (at < 0) throw new Error('段落が見つからない: ' + before);
      ch2.blocks.splice(at, 0, fig);
    }
  }
  const t = typographyDefaults(trim, 'vertical');
  const s: ProjectSettings = {
    ...defaultSettings(),
    trim,
    fontPt: t.fontPt,
    lineFeedPt: t.lineFeedPt,
    margins: t.margins,
  };
  // 見本を開いたときにアプリが足す設定(章ごとの見た目・挿絵・コラム・背景)。loadSampleArt と同じものを使う
  const art = await loadSampleArt(ms.chapters.length);
  if (art) Object.assign(s, art);
  const html = manuscriptHtml(ms, s, longFontFaceCss(ms, s));

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const viewer = new CoreViewer(
    { viewportElement: viewport },
    {
      autoResize: true,
      renderAllPages: true,
      pageViewMode: PageViewMode.SINGLE_PAGE,
      fitToScreen: false,
      pageBorderWidth: 1,
      pixelRatio: 0,
    },
  );
  let ready = false;
  viewer.addListener('readystatechange', () => {
    if (viewer.readyState === 'complete') ready = true;
  });
  viewer.loadDocument({ url }, {}, { renderAllPages: true, pageViewMode: PageViewMode.SINGLE_PAGE });
  const start = Date.now();
  while (!ready && Date.now() - start < 120000) await sleep(200);
  if (!ready) throw new Error('組み上がらなかった');
  const pageCount = viewer.getPageSizes().length;

  const pages: { page: number; lines: number; fig: boolean; head: string }[] = [];
  for (let i = 0; i < pageCount; i++) {
    viewer.navigateToPage(Navigation.EPAGE, i);
    await sleep(40);
    const visible = Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]'),
    ).find((p) => getComputedStyle(p).display !== 'none' && p.offsetWidth > 0);
    if (!visible) continue;
    // 本文の行: 段落(p)・引用の中の字の箱を1行ずつ拾い、縦組みの行は left がそろうので left で束ねる
    const cols: number[] = [];
    visible.querySelectorAll<HTMLElement>('section.chapter p').forEach((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      for (const rc of Array.from(range.getClientRects())) {
        if (rc.width < 1 || rc.height < 1) continue;
        if (!cols.some((l) => Math.abs(l - rc.left) < 3)) cols.push(rc.left);
      }
    });
    const head = (visible.querySelector('section.chapter p')?.textContent ?? '').slice(0, 14);
    pages.push({
      page: i + 1,
      lines: cols.length,
      fig: visible.querySelector('figure.fig') !== null,
      head,
    });
  }
  const figPages = pages.filter((p) => p.fig);
  reportProbe(
    {
      ok: true,
      trim,
      before: before ?? '(sample.ts のまま)',
      pageCount,
      figPages,
      figOnly: figPages.filter((p) => p.lines === 0).map((p) => p.page),
      pages: pages.map((p) => `${p.page}:${p.lines}${p.fig ? 'F' : ''}`).join(' '),
    },
    true,
  );
}

void main().catch((e) => reportProbe({ ok: false, error: String(e) }, false));
