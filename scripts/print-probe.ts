// 紙PDFの検査台。組み立ては hero-probe と同じ(サンプル+挿絵・背景)、
// 組版器の立て方は exporters/print.ts → Vivliostyle printHTML と同じ
// ({ viewportElement, window, debug } で CoreViewer を作り loadDocument するだけ)。
// 書体は App.tsx と同じく collectFontFaceCss で @font-face を HTML に埋め込む。
import { CoreViewer } from '@vivliostyle/core';
import '../src/fontsAll';
import { BODY_FONTS, HEADING_FONT_STACK, defaultSettings, tcyStack } from '../src/models/project';
import { manuscriptHtml } from '../src/typeset/html';
import { collectFontFaceCss } from '../src/typeset/fontface';
import { sampleManuscript } from '../src/sample';
import { loadSampleArt } from '../src/sampleArt';

async function main() {
  const ms = sampleManuscript();
  const art = await loadSampleArt(ms.chapters.length);
  const settings = { ...defaultSettings(), ...(art ?? {}) };
  const fontFaceCss = collectFontFaceCss([
    BODY_FONTS[settings.bodyFont].stack,
    tcyStack(settings.bodyFont),
    HEADING_FONT_STACK,
  ]);
  const html = manuscriptHtml(ms, settings, fontFaceCss);
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
