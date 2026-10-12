// 「白黒で刷る」絵の灰色の写し(修正リストの 4-1・4-6。2026-10-12 1.1.0)の検査台。
// 組み立ては print-probe と同じ(サンプル+挿絵・背景)。そのうえで App の紙の書き出し(handlePrintPdf)と同じく、
// grayCopySources → prepareGrayCopies → withGrayCopies を通してから組む。
//
// 開き方: http://localhost:5173/scripts/graycopy-probe.html?ink=mono
//         http://localhost:5173/scripts/graycopy-probe.html?ink=color&mono=plates,figs,bg
//   ink   … mono(白黒の本。絵はすべて写し) / color(カラーの本)
//   mono  … カラーの本で「白黒で刷る」にするもの(plates=挿絵ページ・figs=章の途中の絵・bg=本文の地と面の背景)
// title が PROBE-DONE になったら page.pdf()。window.__probe に写しの点検(灰色ちょうどか)を置く
import { CoreViewer } from '@vivliostyle/core';
import '../src/fontsAll';
import { BODY_FONTS, HEADING_FONT_STACK, defaultSettings, tcyStack } from '../src/models/project';
import type { ProjectSettings } from '../src/models/project';
import { manuscriptHtml } from '../src/typeset/html';
import { collectFontFaceCss } from '../src/typeset/fontface';
import { sampleManuscript } from '../src/sample';
import { loadSampleArt, loadSampleFigs, replaceSampleFigs } from '../src/sampleArt';
import { grayCopySources, withGrayCopies } from '../src/models/printColor';
import { grayCopyOf, prepareGrayCopies } from '../src/images/grayCopy';

/** 写しをほどいて、R・G・B のずれの最大を測る(0 なら灰色ちょうど) */
async function maxChroma(url: string): Promise<{ w: number; h: number; max: number; type: string }> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  let max = 0;
  for (let i = 0; i < px.length; i += 4) {
    const d = Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]);
    if (d > max) max = d;
  }
  return { w: c.width, h: c.height, max, type: blob.type };
}

async function main() {
  const q = new URLSearchParams(location.search);
  const ink = q.get('ink') === 'mono' ? 'mono' : 'color';
  const mono = new Set((q.get('mono') ?? '').split(',').filter(Boolean));
  const ms0 = sampleManuscript();
  const [art, figs] = await Promise.all([loadSampleArt(ms0.chapters.length), loadSampleFigs()]);
  let ms = replaceSampleFigs(ms0, figs) ?? ms0;
  let settings: ProjectSettings = { ...defaultSettings(), ...(art ?? {}), ink };
  if (ink === 'color') {
    if (mono.has('plates')) settings = { ...settings, plates: (settings.plates ?? []).map((p) => ({ ...p, printMono: true })) };
    if (mono.has('bg')) {
      const flag = <T extends object | undefined>(b: T) => (b ? { ...b, printMono: true } : b);
      settings = {
        ...settings,
        bodyBgPrintMono: true,
        titleBg: flag(settings.titleBg),
        tocBg: flag(settings.tocBg),
        colophonBg: flag(settings.colophonBg),
        chapterBg: Object.fromEntries(Object.entries(settings.chapterBg ?? {}).map(([k, v]) => [k, flag(v)])),
        columnPages: (settings.columnPages ?? []).map((c) => ({ ...c, bg: flag(c.bg) })),
      };
    }
    if (mono.has('figs')) {
      ms = { ...ms, chapters: ms.chapters.map((ch) => ({ ...ch, blocks: ch.blocks.map((b) => (b.type === 'image' ? { ...b, printMono: true } : b)) })) };
    }
  }
  const srcs = grayCopySources(settings, ms);
  const t0 = performance.now();
  const wait = prepareGrayCopies(srcs);
  if (wait) await wait;
  const makeMs = Math.round(performance.now() - t0);
  const copies = await Promise.all(
    srcs.map(async (s) => {
      const g = grayCopyOf(s);
      return g ? { ...(await maxChroma(g)), src: s.slice(0, 40) } : { src: s.slice(0, 40), missing: true };
    }),
  );
  (window as unknown as { __probe: unknown }).__probe = { ink, mono: [...mono], sources: srcs.length, makeMs, copies };
  const paper = withGrayCopies(settings, ms, grayCopyOf);
  const fontFaceCss = collectFontFaceCss([
    BODY_FONTS[settings.bodyFont].stack,
    tcyStack(settings.bodyFont),
    HEADING_FONT_STACK,
  ]);
  const html = manuscriptHtml(paper.manuscript, paper.settings, fontFaceCss);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const viewer = new CoreViewer({
    viewportElement: document.body.firstElementChild as HTMLElement,
    window,
    debug: true,
  } as unknown as ConstructorParameters<typeof CoreViewer>[0]);
  viewer.addListener('readystatechange', () => {
    if (viewer.readyState === 'complete') {
      void document.fonts.ready.then(() => {
        document.title = 'PROBE-DONE';
      });
    }
  });
  viewer.addListener('error', () => {
    document.title = 'PROBE-FAIL';
  });
  viewer.loadDocument({ url });
}
void main();
