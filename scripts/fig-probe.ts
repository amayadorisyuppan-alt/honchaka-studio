// **文中の画像(figure.fig)が、ページのどこに置かれるかを測る。**
//
// 「画像を文中に入れると、最初の行から画像がきれいに入らない」(2026-09-29 ユーザー報告)を
// 数字で見るために作った。アプリの生プレビューと同じ CoreViewer に、
// 絵を1枚はさんだ原稿を食わせ、絵のあるページで
//
//   - 版面の行頭側の端(縦組みなら右)から、絵の端までの空き
//   - 絵の横に立った行が、それぞれ天から何pxのところで始まっているか
//
// を測る。`?at=` で絵を何段落目のあとに置くか、`?w=&h=` で絵の画素数、
// `?css=` で試しに被せる CSS(直し方を比べるため)を渡せる。
import { CoreViewer, Navigation, PageViewMode } from '@vivliostyle/core';
import { defaultSettings, typographyDefaults } from '../src/models/project';
import type { Block, Manuscript, ProjectSettings } from '../src/models/project';
import { manuscriptHtml } from '../src/typeset/html';
import { reportProbe } from './probe-report';

const params = new URLSearchParams(location.search);
const at = Number(params.get('at') ?? 12);
const imgW = Number(params.get('w') ?? 1200);
const imgH = Number(params.get('h') ?? 1040);
const extraCss = params.get('css') ?? '';
const cap = params.get('cap') ?? '';
const yoko = params.get('wm') === 'h';
const columns = Number(params.get('cols') ?? 1);
/** 2枚目の絵を置く段落。続けて置いたときに重ならないかを見る */
const at2 = Number(params.get('at2') ?? -1);
/** その章だけ段組みにする(本は1段のまま)。章ごとの段数の指定を見る */
const chCols = Number(params.get('chcols') ?? 0);
/** 1ページを使う大きさ(full / wide / narrow / print)。無ければ「本文の中」 */
const size = params.get('size') ?? '';
/** その章だけ文字サイズ・行送りを変える(pt)。段の字数が変わるので、絵の上限も変わる */
const chPt = Number(params.get('chpt') ?? 0);
const chLf = Number(params.get('chlf') ?? 0);

const viewport = document.getElementById('probe-viewport') as HTMLElement;

function picture(w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#222';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.fillRect(w / 4, h / 4, w / 2, h / 2);
  return c.toDataURL('image/png');
}

const PARA =
  'このマーキングの真価は、グラフビューという機能で発揮される。グラフビューを開くと、マーキングした言葉たちが点になって、つながりのある点同士が線で結ばれて、画面いっぱいに広がる。';

interface Line {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

async function main() {
  const blocks: Block[] = [];
  for (let i = 0; i < 40; i++) {
    if (i === at || i === at2) {
      const img: Block = { type: 'image', src: picture(imgW, imgH), ...(cap ? { caption: cap } : {}) };
      if (size === 'full') img.full = true;
      else if (size) img.size = size as 'wide' | 'narrow' | 'print';
      blocks.push(img);
    }
    blocks.push({ type: 'p', text: `${i}番。${PARA}` });
  }
  const ms = {
    title: '',
    author: '',
    publisher: '',
    chapters: [{ title: '測る章', blocks }],
  } as Manuscript;
  const t = typographyDefaults('b6', yoko ? 'horizontal' : 'vertical');
  const s: ProjectSettings = {
    ...defaultSettings(),
    trim: 'b6',
    writingMode: yoko ? 'horizontal' : 'vertical',
    fontPt: t.fontPt,
    lineFeedPt: t.lineFeedPt,
    margins: t.margins,
    columns,
    ...(chCols ? { chapterColumns: { 0: chCols } } : {}),
    ...(chPt ? { chapterFontPt: { 0: chPt } } : {}),
    ...(chLf ? { chapterLineFeedPt: { 0: chLf } } : {}),
    toc: false,
  };
  let html = manuscriptHtml(ms, s);
  if (extraCss) html = html.replace('</style>', `${extraCss}\n</style>`);

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
  while (!ready && Date.now() - start < 60000) await new Promise((r) => setTimeout(r, 200));
  const pageCount = viewer.getPageSizes().length;

  const r1 = (n: number) => Math.round(n * 10) / 10;
  const pages: unknown[] = [];
  for (let i = 0; i < Math.min(pageCount, 12); i++) {
    viewer.navigateToPage(Navigation.EPAGE, i);
    await new Promise((r) => setTimeout(r, 50));
    const visible = Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]'),
    ).find((p) => getComputedStyle(p).display !== 'none' && p.offsetWidth > 0);
    if (!visible) continue;
    const pr = visible.getBoundingClientRect();
    // 行ごとの箱。段落の Range から1行ずつ拾う
    const lines: Line[] = [];
    visible.querySelectorAll<HTMLElement>('section.chapter p').forEach((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      for (const rc of Array.from(range.getClientRects())) {
        if (rc.width < 1 || rc.height < 1) continue;
        const hit = lines.find((l) =>
          yoko ? Math.abs(l.top - rc.top) < 3 : Math.abs(l.left - rc.left) < 3,
        );
        if (hit) {
          hit.top = Math.min(hit.top, rc.top);
          hit.bottom = Math.max(hit.bottom, rc.bottom);
          hit.left = Math.min(hit.left, rc.left);
          hit.right = Math.max(hit.right, rc.right);
        } else lines.push({ left: rc.left, right: rc.right, top: rc.top, bottom: rc.bottom });
      }
    });
    const plate = visible.querySelector<HTMLElement>('div.plate, div.fullbleed');
    const figs = Array.from(visible.querySelectorAll<HTMLElement>('figure.fig'));
    const fig = figs[0];
    const img = fig?.querySelector('img');
    const capEl = fig?.querySelector('figcaption');
    const rel = (rc: Line): Line => ({
      left: r1(rc.left - pr.left),
      right: r1(rc.right - pr.left),
      top: r1(rc.top - pr.top),
      bottom: r1(rc.bottom - pr.top),
    });
    pages.push({
      page: i + 1,
      pageW: r1(pr.width),
      pageH: r1(pr.height),
      lineCount: lines.length,
      fig: fig ? rel(fig.getBoundingClientRect()) : null,
      img: img ? rel(img.getBoundingClientRect()) : null,
      cap: capEl ? rel(capEl.getBoundingClientRect()) : null,
      figCount: figs.length,
      plate: plate ? rel(plate.getBoundingClientRect()) : null,
      plateImg: plate?.querySelector('img') ? rel(plate.querySelector('img')!.getBoundingClientRect()) : null,
      nombre: Array.from(visible.querySelectorAll("[data-vivliostyle-page-margin-box]")).some((b) => (b.textContent ?? "").trim() !== ""),
      img2: figs[1] ? rel(figs[1].querySelector('img')!.getBoundingClientRect()) : null,
      lines: lines.sort((a, b) => (yoko ? a.top - b.top : b.left - a.left)).map(rel),
    });
  }
  // 目で見たいページを開いたままにする(写しを撮る側が ?show= で渡す)
  const show = Number(params.get('show') ?? 0);
  if (show > 0) {
    viewer.navigateToPage(Navigation.EPAGE, show - 1);
    await new Promise((r) => setTimeout(r, 300));
  }
  reportProbe(
    { ok: true, pageCount, at, feedPx: r1((s.lineFeedPt * 96) / 72), pages },
    true,
  );
}

void main().catch((e) => reportProbe({ ok: false, error: String(e) }, false));
