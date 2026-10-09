// EPUB3 書き出し(docs/typesetting-rules.md §9「リフローEPUBへの適用」準拠)。
//
// 紙(Vivliostyle)側と共有するのは書体系統・行送り倍率(相対)・字下げ・禁則・ルビ・
// 縦中横・見出し階層/改ページ・扉/目次/奥付の構成。文字サイズ絶対値・版面・字詰行数・
// ノンブル・柱は読者環境に委ねるため、EPUB 側では一切指定しない。
//
// src/typeset/html.ts の章立て・扉・奥付の構造(section/h1/h2.chapter-title など)を
// EPUB の制約(XHTML5・spine・nav)に合わせて再構成したもの。段落変換は text.ts を再利用する。

import JSZip from 'jszip';
import {
  columnPageParagraphs,
  isRenderableImage,
  listMarker,
  listStartAttr,
  sceneBreakOf,
  titleWritingModeOf,
} from '../models/project';
import type {
  Block,
  Chapter,
  ColumnPage,
  Manuscript,
  PlateSize,
  ProjectSettings,
  SceneBreakId,
} from '../models/project';
// 場面転換の見た目。**紙と同じ HTML を出す**(typeset/html.ts の sceneBreakHtml)。
// XHTML なので hr だけは自分で閉じる必要があり、そこだけ差し替える
import { sceneBreakHtml } from '../typeset/html';
// 挿絵の大きさは紙と同じ物差しから作る。**別に持つと画面の見本と食い違う**
// (typeset/grid.ts の PLATE_INSET のコメントと同じ理由)
import { PLATE_INSET } from '../typeset/grid';
import { PROFILE_TITLE, authorProfileParagraphs, colophonRows } from '../typeset/matter';
import { escapeHtml, isDialogueStart, paragraphHtml } from '../typeset/text';
// 読む機械の目次・書名のメタデータ・各ページの title には、記法を外した字を渡す
// (2026-09-25 見直し S3-9: ｜親《よみ》 や ** がそのまま出ていた)
import { plainText } from '../models/inlineImages';
import { lightenForEbook } from '../images/optimize';

const OPF_PATH = 'OEBPS/content.opf';

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

// ---- 画像を ZIP 内のファイルにする ----
//
// **data URI のまま <img src> に埋めてはいけない。** EPUB は参照する資源をすべて
// manifest に載せる決まりで、data URI はその外に居る。Kindle の変換器はこれを解決できず、
// 「Kindle 変換で内部エラーが発生しました」(ファイル名・行番号なし)で弾かれる。
// base64 は元データより 33% 大きいうえ、テキストとして ZIP に入るので圧縮も効きにくい。

/**
 * EPUB 3 が同梱を認めている画像形式(コアメディアタイプ)。
 * これ以外は fallback の指定が要るので、そのまま入れると検証に落ちる。
 * ブラウザで表示できる形式(models/project.ts の isRenderableImage)より狭いことに注意 —
 * BMP と AVIF は画面には出るが EPUB には入れられない。
 */
const EPUB_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

interface ImageAsset {
  id: string;
  /** OEBPS からの相対パス */
  file: string;
  mediaType: string;
  bytes: Uint8Array;
}

function decodeDataUri(src: string): { mediaType: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)((?:;[^,]*)*),([\s\S]*)$/.exec(src);
  if (!m) return null;
  const mediaType = m[1].toLowerCase();
  const isBase64 = /;base64/i.test(m[2]);
  const payload = m[3];
  try {
    if (isBase64) {
      const bin = atob(payload);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return { mediaType, bytes: out };
    }
    return { mediaType, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return null;
  }
}

/**
 * 画像の参照先を決める口。**書き出しと画面の下見で差し替える。**
 * 書き出しは ZIP 内のファイルへ移し(ImageCollector)、下見は画面の画像をそのまま指す
 * (previewImageResolver)。どちらも EPUB に入れられない形式は null(図版ごと落とす)
 */
export interface ImageResolver {
  resolve(src: string): string | null;
}

/**
 * 画面の下見用。**ZIP に移さず、渡された関数で画面の画像の URL にする。**
 * EPUB に入れられない形式は書き出しと同じく落とす — 下見と書き出しで絵の有無が食い違わない
 */
export function previewImageResolver(toUrl: (src: string) => string): ImageResolver {
  return {
    resolve(src: string) {
      return isEpubImage(src) ? toUrl(src) : null;
    },
  };
}

/**
 * EPUB に入る絵か。**書き出しでも下見でも、入らない形式(BMP・AVIF・EMF など)は図版ごと落ちる。**
 * 下見で「章の中の何枚目の絵か」を数えるとき、落ちる絵を数えるとずれる(2026-09-24 レビューで発見)
 */
export function isEpubImage(src: string): boolean {
  if (!src) return false;
  const m = /^data:([^;,]+)/.exec(src);
  // WebP・BMP・AVIF は書き出すときに JPEG / PNG へ直して入れる(lightenForEbook。2026-09-26)。
  // 入らないのは、ブラウザが読めない形式(TIFF・HEIC・EMF など)だけ
  return !m || Boolean(EPUB_IMAGE_TYPES[m[1].toLowerCase()]) || /^image\/(avif|bmp)$/i.test(m[1]);
}

/**
 * 原稿に出てくる画像を集めて ZIP 内のファイルに割り当てる。
 * 同じ絵を2か所で使っていれば1ファイルに寄せる(data URI をキーに重複を落とす)。
 */
class ImageCollector implements ImageResolver {
  readonly assets: ImageAsset[] = [];
  private bySrc = new Map<string, string | null>();

  /** 画像の参照先。EPUB に入れられない形式なら null(呼び出し側で図版ごと落とす) */
  resolve(src: string): string | null {
    const known = this.bySrc.get(src);
    if (known !== undefined) return known;

    const decoded = decodeDataUri(src);
    // data URI 以外(相対パスなど)はそのまま通す。現状の取込経路では出てこない
    if (!decoded) {
      this.bySrc.set(src, src);
      return src;
    }
    const ext = EPUB_IMAGE_TYPES[decoded.mediaType];
    if (!ext) {
      this.bySrc.set(src, null);
      return null;
    }
    const n = pad3(this.assets.length + 1);
    const file = `images/img-${n}.${ext}`;
    this.assets.push({ id: `img-${n}`, file, mediaType: decoded.mediaType, bytes: decoded.bytes });
    this.bySrc.set(src, file);
    return file;
  }
}

/** XML 属性値・テキストのエスケープ(& < > " のみで XML として十分) */
const esc = escapeHtml;

// ---- XHTML 共通シェル ----

function xhtmlShell(title: string, bodyInner: string, bodyClass = '', htmlClass = ''): string {
  // lang / xml:lang は両方書く。片方だけだと閲覧環境によって
  // 日本語の行組版(禁則・約物)が当たらないことがある
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja" xml:lang="ja"${htmlClass ? ` class="${htmlClass}"` : ''}>
<head>
<meta charset="UTF-8"/>
<title>${esc(plainText(title) || '無題')}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${bodyInner}
</body>
</html>
`;
}

// ---- 章 ----

/** 章見出しHTML。章番号と章題はワンセット(rules §6, html.ts と同じ構造) */
function chapterHeadingHtml(no: string | undefined, title: string, vertical: boolean): string {
  if (!no && !title) return '';
  const noHtml = no ? `<span class="chapter-no">${esc(no)}</span>` : '';
  const titleHtml = `<span class="ct">${paragraphHtml(title, vertical)}</span>`;
  return `<h2 class="chapter-title">${noHtml}${titleHtml}</h2>`;
}

function blockHtml(
  b: Block,
  vertical: boolean,
  images: ImageResolver,
  scene: SceneBreakId,
): string {
  if (b.type === 'space') return '<p class="line-space">　</p>';
  if (b.type === 'h3') return `<h3>${paragraphHtml(b.text, vertical)}</h3>`;
  // 場面転換。**紙と同じ見た目を選ぶ。**(2026-08-21)
  // XHTML なので空要素は閉じる。閉じないと EPUB の検証で落ちる
  if (b.type === 'hr') {
    return scene === 'rule' ? '<hr/>' : sceneBreakHtml(scene);
  }
  if (b.type === 'quote') return `<blockquote>${paragraphHtml(b.text, vertical)}</blockquote>`;
  if (b.type === 'list') {
    // マーカーは紙と同じく字として置く(listMarker)。list-style に任せると
    // 読む機械ごとに記号が変わり、番号は半角のまま縦組みで寝る
    const items = b.items
      .map((t, i) => `<li>${listMarker(i, b.ordered, b.start)}${paragraphHtml(t, vertical)}</li>`)
      .join('\n');
    return b.ordered
      ? `<ol class="list"${listStartAttr(b)}>\n${items}\n</ol>`
      : `<ul class="list">\n${items}\n</ul>`;
  }
  if (b.type === 'image') {
    const href = images.resolve(b.src);
    // EPUB に入れられない形式(EMF/BMP など)は図版ごと落とす。
    // manifest に載せられない資源を参照すると、変換器がそこで止まる
    if (!href) return '';
    // **1ページを使う大きさの絵は、挿絵ページと同じ箱で出す。**(2026-09-23 レビューで発見)
    // 紙では全面・余白すこし・余白おおめを選んだ絵が1ページを占めるのに、EPUB では
    // ふつうの本文の絵(figure.fig)として流し込まれ、紙と見た目が大きく食い違っていた。
    // 箱(.plate)と大きさの割合は章の切れ目の挿絵ページと共通(下の epubCss)。
    // 前後で改ページするよう頼むが、効くかは読む機械による(リフローにページの約束は無い)
    if (b.full || b.size) {
      return `<div class="plate ${b.full ? 'full' : b.size} in-flow"><img src="${esc(href)}" alt="${esc(b.alt ?? '')}"/></div>`;
    }
    const cap = b.caption ?? b.alt;
    return `<figure class="fig"><img src="${esc(href)}" alt="${esc(b.alt ?? '')}"/>${
      cap ? `<figcaption>${paragraphHtml(cap, vertical)}</figcaption>` : ''
    }</figure>`;
  }
  // 行末寄せ(あとがきの署名・日付)。紙と同じクラス名にして、CSS も同じ考え方で書く
  if (b.align === 'end') return `<p class="align-end">${paragraphHtml(b.text, vertical)}</p>`;
  const cls = isDialogueStart(b.text) ? ' class="no-indent"' : '';
  return `<p${cls}>${paragraphHtml(b.text, vertical)}</p>`;
}

function chapterXhtml(
  ch: Chapter,
  vertical: boolean,
  images: ImageResolver,
  scene: SceneBreakId,
): string {
  const heading = chapterHeadingHtml(ch.no, ch.title, vertical);
  const body = ch.blocks
    .map((b) => blockHtml(b, vertical, images, scene))
    .filter(Boolean)
    .join('\n');
  const inner = `<section epub:type="chapter">
${heading}
${body}
</section>`;
  return xhtmlShell(ch.title, inner);
}

// ---- 扉 ----

// 大扉には書名と著者名だけを置く(版元名は奥付に記載する)。
// titleH = 縦組みの本の書名・著者名を横組みにする(settings.titleWritingMode。2026-10-03)。
// 向きを変えるのは**この1ファイルの html 要素だけ**(class="tp-h")。ほかのページと
// page-progression-direction は本文の向きのまま。html 要素への指定は読む機械が最もよく守る
function titlepageXhtml(ms: Manuscript, vertical: boolean, titleH = false): string {
  // 横組みにするときは縦中横を掛けない(紙の大扉と同じ約束)
  const tv = vertical && !titleH;
  // 書名と著者名は1つの塊として中央に置きたいので、内側にもう1枚かぶせる
  // (中央寄せの手当ては .tp-inner のほうに掛かる。理由は epubCss を参照)
  const inner = `<section epub:type="titlepage" class="titlepage">
<div class="tp-inner">
<h1>${paragraphHtml(ms.title, tv)}</h1>
${ms.author ? `<p class="author">${paragraphHtml(ms.author, tv)}</p>` : ''}
</div>
</section>`;
  // 扉だけは1ページを使い切って中央に置きたいので、body に高さを持たせる
  return xhtmlShell(ms.title, inner, 'full-page', titleH ? 'tp-h' : '');
}

// ---- 目次ページ(読者が本文として読む1ページ) ----
//
// nav.xhtml / toc.ncx とは役割が違う。あちらは読む機械のための索引で、
// spine には linear="no" で置いてある(読み進める流れには出てこない)。
// こちらは紙と同じ「扉の次の目次」で、本文の一部として読まれる。
// 出す・出さないは紙と共通の settings.toc で決める(EPUB 用のスイッチは足さない)。
//
// **ノンブルは書かない。** 紙(typeset/css.ts の section.toc)は leader('・') と
// target-counter() で章題とノンブルを繋いでいるが、EPUB にページという概念は無く、
// 1ページに何行入るかは読者の画面と文字サイズで決まる。書いた数字は必ず嘘になるので、
// 章題だけを並べて、各章へのリンクにする。
//
// 挿絵ページ・コラムページは載せない(nav / NCX と同じ扱い。
// 本文の章とそれ以外が同じ並びに混ざると、章立てが読み取りにくくなる)

/** 目次に載せる章。番号も題も無い章は載せない(紙の tocHtml と同じ) */
function tocEntries(ms: Manuscript, chapterFiles: string[]) {
  return ms.chapters
    .map((ch, i) => ({
      label: [ch.no, ch.title].filter(Boolean).join('　'),
      file: chapterFiles[i],
    }))
    .filter((e) => e.label);
}

function tocPageXhtml(ms: Manuscript, chapterFiles: string[], vertical: boolean): string {
  // 章題は本文と同じ整形を通す(縦組みなら数字が縦中横になる)。
  // nav.xhtml のラベルは読む機械が扱う文字列なので、あちらは素のままにしてある
  const items = tocEntries(ms, chapterFiles)
    .map((e) => `<li><a href="${e.file}">${paragraphHtml(e.label, vertical)}</a></li>`)
    .join('\n');
  const inner = `<section class="toc-page">
<h1>目次</h1>
<ul>
${items}
</ul>
</section>`;
  // 組み方向は本文と同じ(縦組みの本なら html ごと縦になる)。器には何も足さない
  return xhtmlShell('目次', inner);
}

// ---- 挿絵ページ ----

/**
 * 挿絵は1ページ1枚。**紙で選んだ大きさ(全面/余白すこし/余白おおめ)を、
 * 画面に対する割合として渡す。**
 *
 * 以前はどの大きさでも同じ器で出していた(この関数が href しか受け取っていなかった)ので、
 * 3つのどれを選んでも EPUB では同じ大きさで出ていた。
 *
 * **紙と同じ意味の「全面」は作れない。** リフローに用紙は無く、
 * 断裁も塗り足しも無い。作れるのは「読む人の画面のどれだけを使うか」だけなので、
 * 紙の内寸の比(PLATE_INSET)をそのまま画面に対する百分率として渡す
 * (全面=100% / 余白すこし=92% / 余白おおめ=60% / 版面いっぱい=100%)。**割合は保たれるので、
 * 3つの差は必ず出る**が、「紙の端まで届く」ことは約束できない。
 *
 * 器に `full-page` を着せるのは、**高さの百分率を効かせるため**。
 * html/body に高さが無いと `max-height: 100%` は none に落ちて、幅だけが効く。
 * `height: 100%` が実機まで届くことは大扉で実測済み(2026-08-16)。
 * vh は使わない — 届くかどうかを確かめていない値を、確かめた値の代わりに置かない。
 */
function plateXhtml(href: string, size: PlateSize): string {
  return xhtmlShell(
    '挿絵',
    `<div class="plate ${size}"><img src="${esc(href)}" alt=""/></div>`,
    'full-page',
  );
}

// ---- コラムページ ----
//
// **組み方向は切り替えない。本文と同じ向きで、見出し+段落として流す。**
//
// 紙のコラムページは「版面の実寸を width と height で与えて1ページに収める」ことで
// 組み方向を変えている(typeset/css.ts の section.colpage)。EPUB にはページが無く、
// 寸法は読む人の画面と文字サイズで決まるので、その手が使えない。
// 奥付だけは EPUB でも横組みに倒しているが、あれは数行しかないから成り立っている。
// 1ページぶんの文章を逆向きの箱に入れると、紙で 9083px はみ出したのと同じことが
// 読む機械の上で起きる(器の外へ伸びるか、そこだけスクロールを強いるか)。
//
// **読めなくなるより、向きをそろえて読めるほうがよい。** 見出しで別ものと分かるので、
// コラムとしての役割は残る。組み方向の切り替えは紙だけの機能と割り切る。
function colPageXhtml(c: ColumnPage, vertical: boolean): string {
  const title = c.title.trim();
  const head = title ? `<h2 class="colpage-title">${paragraphHtml(title, vertical)}</h2>` : '';
  const body = columnPageParagraphs(c.text)
    .map((t) =>
      // 空行は1行アキ(columnPageParagraphs の '')。章の空行(blockHtml の space)と同じ形で出す。
      // 中身の無い <p></p> は高さが出ず、読む機械でも電子の下見でも潰れる(紙は typeset/html.ts の colpage-aki)
      t === ''
        ? '<p class="line-space">　</p>'
        : `<p${isDialogueStart(t) ? ' class="no-indent"' : ''}>${paragraphHtml(t, vertical)}</p>`,
    )
    .join('\n');
  return xhtmlShell(title || 'コラム', `<section class="colpage">
${head}
${body}
</section>`);
}

// ---- 表紙 ----
//
// KDP は表紙を入稿画面で別に受け取るので、EPUB に入っていなくても通る。
// **楽天Kobo は EPUB の中に求める**(公式スペック)。しかも条件が細かい:
//
// - 表紙画像は**それ専用の XHTML ファイル**に入れる
// - CSS の background-image ではなく `<img>` で置く
// - OPF の metadata に `<meta name="cover" content="(画像のid)"/>` を書く
//
// **この XHTML に他の文字を混ぜてはいけない。** Kobo の eInk 端末は表紙の XHTML を
// 固定レイアウトで表示するので、同じファイルに文章を置くと、そこだけ
// 読者が文字サイズを変えられなくなる。

function coverXhtml(href: string, title: string): string {
  return xhtmlShell(
    title || '表紙',
    `<div class="cover-page"><img src="${esc(href)}" alt="${esc(title)}"/></div>`,
    'full-page',
  );
}

/** 紙と同じ順序(章の前・巻末)で挿絵を並べるための索引 */
function platesBefore(s: ProjectSettings, before: number) {
  return (s.plates ?? []).filter((p) => p.beforeChapter === before && isRenderableImage(p.src));
}

/** コラムページも紙と同じ位置に置く。同じ切れ目では挿絵のあと */
function colPagesBefore(s: ProjectSettings, before: number) {
  return (s.columnPages ?? []).filter(
    (c) => c.beforeChapter === before && (c.title.trim() || c.text.trim()),
  );
}

// ---- 奥付(著者紹介つき) ----
//
// あとがきは本文の章として書いてもらうので、ここには来ない。
// 著者紹介は奥付の上に並べる。
//
// **組み方向は本文と同じ。**(2026-09-24 ユーザー判断「電子書籍だしファイル全体の向きに揃えるで
// いい。箱をつくると入る場所がおかしなことになるので、あえて縦書きの本の中に横書きの奥付を
// 入れる必要はない」)。紙は縦組みの本でも奥付を横組みにする(typeset/css.ts)が、EPUB では
// 縦組みのページの中に横組みの箱を入れていた。これは電書連ガイドが勧めない「組み方向の入れ子」で、
// Apple Books は組み方向を html か body にしか認めない(1ファイル1方向)。向きを変えるなら
// ファイルごと変えるのが筋だが、そこまでして横にする理由も無いので、本文の向きで流す。
// 縦組みでは数字を縦中横にするため、vertical を本文と同じにして通す

function colophonXhtml(ms: Manuscript, vertical: boolean): string {
  const rows = colophonRows(ms)
    .map((t) => `<p class="row">${paragraphHtml(t, vertical)}</p>`)
    .join('\n');
  const profile = authorProfileParagraphs(ms);
  const profileBox = profile.length
    ? `<section class="profile">
<h2>${paragraphHtml(PROFILE_TITLE, vertical)}</h2>
${profile.map((t) => `<p>${paragraphHtml(t, vertical)}</p>`).join('\n')}
</section>
`
    : '';
  const inner = `${profileBox}<section epub:type="colophon" class="colophon">
<h1>${paragraphHtml(ms.title, vertical)}</h1>
${rows}
</section>`;
  return xhtmlShell('奥付', inner);
}

// ---- 目次 (nav.xhtml) ----

function navXhtml(ms: Manuscript, chapterFiles: string[], tocPage: boolean): string {
  const items: string[] = [];
  items.push(`<li><a href="titlepage.xhtml">${esc(plainText(ms.title) || '扉')}</a></li>`);
  ms.chapters.forEach((ch, i) => {
    const label = plainText([ch.no, ch.title].filter(Boolean).join('　')) || `第${i + 1}章`;
    items.push(`<li><a href="${chapterFiles[i]}">${esc(label)}</a></li>`);
  });
  items.push(`<li><a href="colophon.xhtml">奥付</a></li>`);

  // 目印(landmarks)。**読む機械の「目次へ」が飛ぶ先を指す。**
  // 本文中の目次ページ(toc.xhtml)を作ったので、そこを epub:type="toc" として教える。
  // hidden を付けるのは、これが読者向けの一覧ではなく機械向けの索引だから。
  // li が1つも無い landmarks は認められないので、中身があるときだけ書く
  const marks: string[] = [];
  if (tocPage) marks.push(`<li><a epub:type="toc" href="toc.xhtml">目次</a></li>`);
  if (chapterFiles.length) {
    marks.push(`<li><a epub:type="bodymatter" href="${chapterFiles[0]}">本文</a></li>`);
  }
  const landmarks = marks.length
    ? `
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<h1>目印</h1>
<ol>
${marks.join('\n')}
</ol>
</nav>`
    : '';

  const inner = `<nav epub:type="toc" id="toc">
<h1>目次</h1>
<ol>
${items.join('\n')}
</ol>
</nav>${landmarks}`;
  return xhtmlShell('目次', inner);
}

// ---- toc.ncx ----
//
// EPUB3 では nav.xhtml があれば足りるが、Kindle の変換は古い経路(EPUB2 相当)を
// 通ることがあり、そこでは NCX を探しにいく。置いておくぶんには害がない。

function tocNcx(ms: Manuscript, chapterFiles: string[], bookId: string): string {
  const points: string[] = [];
  let order = 1;
  const point = (label: string, src: string) =>
    `    <navPoint id="np-${order}" playOrder="${order++}">
      <navLabel><text>${esc(plainText(label))}</text></navLabel>
      <content src="${src}"/>
    </navPoint>`;

  points.push(point(ms.title || '扉', 'titlepage.xhtml'));
  ms.chapters.forEach((ch, i) => {
    const label = [ch.no, ch.title].filter(Boolean).join('　') || `第${i + 1}章`;
    points.push(point(label, chapterFiles[i]));
  });
  points.push(point('奥付', 'colophon.xhtml'));

  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="ja">
  <head>
    <meta name="dtb:uid" content="${esc(bookId)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(plainText(ms.title) || '無題')}</text></docTitle>
  <navMap>
${points.join('\n')}
  </navMap>
</ncx>
`;
}

// ---- style.css (rules §9: 文字サイズ絶対値・版面は指定しない) ----

/**
 * 挿絵の大きさを、画面に対する百分率にする。
 *
 * 紙は「仕上がり幅の何割を四方から空けるか」(PLATE_INSET)で持っているので、
 * 両側ぶんを引けば絵が占める割合になる。全面=100 / 余白すこし=92 / 余白おおめ=60。
 * 版面いっぱいも 100 — リフローの「画面」は読む機械が余白を取ったあとの版面そのものなので、
 * 紙で「余白の内側いっぱい」だったものは画面いっぱいに当たる(全面と同じ見え方になる)。
 * 紙では天地の内寸を「幅の比」から取っているため縦横で割合が少し違うが、
 * リフローでは画面の縦横比が機械ごとに違うので、そこまでは追わない
 */
function platePct(size: PlateSize): number {
  return Math.round((1 - PLATE_INSET[size] * 2) * 100);
}

function epubCss(s: ProjectSettings): string {
  const vertical = s.writingMode === 'vertical';
  // 絵を白黒にするのは［電子書籍の色］が白黒のとき。**紙の刷り色とは別の値。**(2026-09-24)
  // 以前は「紙が白黒で、書き出しの画面のスイッチ(epubMono)も入っているとき」だけ掛けていたが、欄を
  // ［本のかたちを決める］へ移し、電子書籍を作る本ならいつでも見える・戻せるようにした
  // (見えない指定が効き続けないこと、という前の決まりはこれで満たす)。古い保存の epubMono は
  // 読み込むときに、前に効いていた値で ebookMono へ移す(models/project.ts の migrateEbookMono)
  const mono = s.ebookMono === true;
  /*
   * **書体は固定。本文は明朝(serif)、見出しと太字はゴシック(sans-serif)。**(2026-09-24 ユーザー決定)
   * 書体ファイルは同梱しない(rules §9)ので、紙で選んだ書体名はどのストアでも読む人に届かない。
   * 届くのは明朝かゴシックかの目安だけで、それも読む人が端末の設定で変えられる(Kindle の
   * 現行ガイドラインは本文の書体を固定しないよう求める。電書協ガイドも明朝とゴシックの2つだけで扱う)。
   * 以前は紙の書体に合わせて本文を serif / sans-serif に切り替えていたが、選べるように見えると
   * 「選んだ書体が電子にも出る」と誤解されるので、日本の電子書籍の標準の組み合わせに固定した
   */
  // 縦組みでは block 方向が右→左になる。物理プロパティ(margin-top など)で前後のアキを
  // 作ると、意図と違う辺に付く(紙側の css.ts と同じ方針で組み方向ごとに書き分ける)
  const blockBefore = vertical ? 'margin-right' : 'margin-top';
  const blockAfter = vertical ? 'margin-left' : 'margin-bottom';
  // 行の中のアキ。縦組みでは天地、横組みでは左右になる
  // (引用の字下げ・箇条書きのぶら下げは「行の中」の位置なのでこちら)
  const padLineStart = vertical ? 'padding-top' : 'padding-left';
  const padLineEnd = vertical ? 'padding-bottom' : 'padding-right';
  return `${vertical ? 'html { writing-mode: vertical-rl; -epub-writing-mode: vertical-rl; }\n' : ''}body {
  margin: 0;
  line-height: 1.75;
  text-align: justify;
  font-family: serif;
}
p {
  margin: 0;
  text-indent: 1em;
  line-break: strict;
}
p.no-indent { text-indent: 0; }
p.line-space { text-indent: 0; }
/* ---- 場面転換を字で組むとき(1行アキ / ＊ / ＊　＊　＊) ----
   **電子書籍に版面は無い。** 紙では「ちょうど2行」に収める計算をしているが、
   こちらは行送りが読者の設定で変わるので、アキは行数ではなく em で持つ(rules §9)。
   1行アキは中身の全角空白がそのまま1行になるので、指定は要らない
   (margin を足すと読者の行送りに対して二重にアキが出る)。
   ＊ の前後だけ半行ぶんに当たる 0.5em を置く。**改ページの手当ては書かない** —
   リフローにページの境目という概念が無く、ページを割るのは読む機械の側。

   実測(2026-08-21。書き出した EPUB の chapter-001.xhtml と style.css を
   Chrome に読ませて印刷し、字の位置を測った。既定の 12pt・line-height 1.75 = 行送り 21pt。
   数字は「切れ目の前の行から、あとの行まで」):

   | 見た目 | 送り | 行に直すと | 紙(文庫9pt) |
   |---|---|---|---|
   | 1行アキ | 42.00pt | **2.000行** | 2.000行 |
   | ＊ / ＊　＊　＊ | 54.00pt | 2.571行 | 3.000行 |
   | 罫 | 57.75pt | 2.750行 | 3.000行 |

   **1行アキだけが、紙と電子で同じ「2行」になる。** 行そのものが単位なので、
   読者が字を大きくしても行送りを変えても比が崩れない。
   記号と罫のアキは em(読者の字の大きさ基準)で持つしかなく、
   行送りを広げた読者の画面では相対的に詰まって見える。
   **これは直せない**(リフローに行グリッドが無い)ので、
   一般文芸の作法として既定を1行アキにしたことは、電子側でも都合がよい。
   記号の中央寄せは効いている(実測: 版面の中央から 0.248pt = 0.087mm) */
p.scene-break { text-indent: 0; }
p.scene-break.mark {
  text-align: center;
  margin: 0;
  ${blockBefore}: 0.5em;
  ${blockAfter}: 0.5em;
}
/* 行末寄せ(署名・日付。原稿の >> の行)。**物理の左右で書かない** —
   「行末」は組み方向で変わる(縦組みなら地、横組みなら右)。
   text-align の right / end はどちらも行の向きで決まる論理値なので1つで両方に効く。
   **2つ書くのは読み機のため** — 古い読み機は end を知らないので right で受け止めさせ、
   知っている読み機はあとに書いた end を採る(紙側の css.ts と同じ書き方) */
p.align-end { text-indent: 0; text-align: right; text-align: end; }
.tcy { text-combine-upright: all; -webkit-text-combine: horizontal; }
ruby rt { font-size: 0.5em; }
/* **原稿の太字(**…**)は em で渡している。太く、斜めにしない。**(2026-09-24 に発見)
   紙の css.ts は em を太字にしていたが、ここに決まりが無かったので、読む機械の既定(斜体)で
   出ていた — 電子書籍だけ、太字にしたところが斜めの字になっていた。斜体は i で別に渡している */
em { font-style: normal; font-weight: bold; font-family: sans-serif; }
i { font-style: italic; }
/* 縦組みの「下」は左側。和文の傍線は右に引くので、向きを指定する
   (紙側の css.ts と同じ理由。読む機械が対応していなければ既定の位置に出る)。
   アキも紙とそろえる。**縦と横で基準の線が違う**ので数字も変える —
   縦は仮想ボディの右端が基準なので 0.1em がそのままアキになり、
   横は書体の下線位置(仮想ボディの下端より 0.11em 上)が基準なので 0.2em で 0.09em 空く */
u {
  text-decoration: underline;
  text-underline-offset: ${vertical ? '0.1em' : '0.2em'};${vertical ? ' text-underline-position: right;' : ''}
}
s { text-decoration: line-through; }
/* 本文中のリンク。**電子書籍でだけ飛べる。** 色は読む機械に任せ、
   押せることは下線で示す(紙側の css.ts では逆に見た目を本文へ戻している) */
p a, h3 a { text-decoration: underline; }
/* 傍点(圏点)。読む機械によっては効かないので、**太字などで代替しない**
   (代替すると、効く機械では二重に強調される) */
.boten {
  -webkit-text-emphasis: filled sesame;
  text-emphasis: filled sesame;
  -webkit-text-emphasis-position: over right;
  text-emphasis-position: over right;
}

h2.chapter-title {
  font-family: sans-serif;
  font-weight: 700;
  font-size: 1.5em;
  margin: 2em 0 3em;
}
h2.chapter-title .chapter-no {
  display: block;
  font-size: 0.7em;
  font-weight: 500;
  letter-spacing: 0.5em;
}
h3 {
  font-family: sans-serif;
  font-size: 1em;
  margin: 1.5em 0 0.5em;
}

/* ---- 引用 ----
   紙(typeset/css.ts)と同じ作法。**縦組みでは左に縦罫を入れない** —
   縦罫は横組みの本の作法で、縦組みでは行の進む先に線が立つだけになる。
   和文は天地を1字ずつ空けて行を短くすれば引用と分かる。
   アキを行数で持たないのは、リフローでは行送りが読者の設定で変わるため(rules §9) */
blockquote {
  margin: 0;${
    vertical
      ? ''
      : `
  ${blockBefore}: 1em;
  ${blockAfter}: 1em;`
  }
  ${padLineStart}: 1em;
  ${padLineEnd}: 1em;
  text-indent: ${vertical ? '1em' : '0'};
}

/* ---- 箇条書き ----
   マーカー(・ / １．)は紙と同じく字として置いてある(epub.ts の blockHtml)。
   list-style に任せると、記号が読む機械ごとに変わり、番号は半角のまま縦組みで寝る。
   2行目以降のぶら下げは text-indent の負値で作る */
ul.list, ol.list { margin: 0; padding: 0; list-style: none; }
.list li { ${padLineStart}: 1em; text-indent: -1em; }
ol.list li { ${padLineStart}: 2em; text-indent: -2em; }

/* ---- 区切り線 ----
   ${vertical
     ? '縦組みでは行に沿って立つ短い縦線。天地の中央に置く'
     : '横組みでは行を横切る短い横線。左右の中央に置く'}。
   長さと太さは width/height を組み方向で入れ替えて作る(紙側と同じ考え方)。
   中央寄せは margin auto に任せる — 紙とちがってページの寸法が読む機械の側にあるため */
hr {
  border: none;
  border-${vertical ? 'left' : 'top'}: 1px solid currentColor;
  ${vertical ? 'width: 0; height: 6em; margin: auto 1.5em;' : 'height: 0; width: 6em; margin: 1.5em auto;'}
}

img { max-width: 100%; max-height: 100%; }

/* コラムページ。**組み方向は本文と同じ**(理由は colPageXhtml のコメント)。
   見出しの大きさだけ紙(section.colpage)と揃えて、別ものだと分かるようにする */
.colpage h2.colpage-title {
  font-family: sans-serif;
  font-weight: 700;
  font-size: 1.3em;
  text-indent: 0;
  margin: 0;
  ${blockAfter}: 1.2em;
}

/* 挿絵ページ。紙は用紙寸法で組むが、リフローに用紙は無い。
   **大きさの違いは「画面に対する割合」で渡す**(理由は plateXhtml)。
   器に高さを持たせないと max-height の百分率が効かないので、body ごと full-page にしてある。
   天地の中央寄せはしない — 中央寄せに要る display:table の中では
   百分率の高さが決まらず、大きさの指定のほうが落ちる(大きさを採った)。
   下の1行は大きさの印を読めなかったときの受け皿。落ちても画面に収まる。

   **width: 100% を省いてはいけない(実測)。** 縦組みの本では html が vertical-rl なので、
   その子の器は幅が中身なりに縮む。すると絵の max-width が「縮んだ器の幅」に対して
   もう一度掛かり、割合が二乗になる(372×560 で実測: 余白すこしが 0.92→0.85、
   余白おおめが 0.6→0.36 まで縮んだ)。器を画面いっぱいに固定してから割合を掛ける */
.plate {
  writing-mode: horizontal-tb;
  margin: 0;
  text-align: center;
  width: 100%;
  height: 100%;
}
.plate img { max-width: 100%; max-height: 100%; }
/* 章の途中に置いた1ページの絵。前後で改ページを頼む(効くかは読む機械による) */
.plate.in-flow { page-break-before: always; page-break-after: always; break-before: page; break-after: page; }
${(Object.keys(PLATE_INSET) as PlateSize[])
  .map((k) => `.plate.${k} img { max-width: ${platePct(k)}%; max-height: ${platePct(k)}%; }`)
  .join('\n')}${
  mono
    ? `
/* ［電子書籍の色］に「白黒」を選んだとき。
   **表紙には掛けない** — 紙の本でも表紙はカラーで、本文だけが白黒で刷られる。
   filter は読む機械が解釈するとはかぎらない(効かなければカラーのまま出るだけで、
   絵が消えたり崩れたりはしない)ので、外向きには「読む機械による」と断る */
figure.fig img, .plate img { -webkit-filter: grayscale(1); filter: grayscale(1); }`
    : ''
}

/* 表紙。画面いっぱいに1枚だけ置く。ここに文字を混ぜないこと(理由は coverXhtml を参照) */
.cover-page { writing-mode: horizontal-tb; margin: 0; text-align: center; height: 100%; }
.cover-page img { max-width: 100%; max-height: 100%; }

figure.fig { margin: 0; ${blockBefore}: 1em; ${blockAfter}: 1em; text-indent: 0; }
figure.fig img { max-width: 100%; }
figure.fig figcaption { font-size: 0.85em; text-indent: 0; margin: 0; ${blockBefore}: 0.3em; }

/* ---- 扉 ----
   **縦組みでは block 方向が右→左**なので、ふつうに積むと見出しが右端に貼りつき、
   左の大半が空いて「扉に見えない」。

   **Kindle は flex を無視する。** 最初 flex の中央寄せで実装したが、実機のプレビューでは
   右端に寄ったままだった(2026-08-16 実測)。一方で天地の中央寄せは効いていたので、
   height:100% と text-align は届いていると分かる。そこで flex を使わずに済ませる:

   - 縦組み … **器だけ横組みに倒す**。こうすると左右が inline 軸になり、
     text-align:center がそのまま左右の中央寄せになる。
     中身は inline-block にして縦組みへ戻し、その中の text-align:center が天地中央を作る
   - 横組み … display:table + vertical-align:middle (flex 以前からある中央寄せ)

   **縦組みの器は「組み方向の入れ子」だが、大扉はこのまま残す。**(2026-09-24 ユーザー判断
   「ある程度中央に入っているので、大扉としてある方がいい」)。奥付・著者紹介は同じ入れ子を
   やめて本文の向きで流した(colophonXhtml)が、大扉は中央に置くこと自体が役目なので残す。
   奥付に合わせて外さないこと(外すとタイトルはページの頭から始まる)

   ※このコメントにバッククォートを書くと、外側のテンプレートリテラルが閉じてしまう */
html, body.full-page { height: 100%; width: 100%; }
${
  vertical
    ? `.titlepage {
  height: 100%;
  width: 100%;
  writing-mode: horizontal-tb;
  -epub-writing-mode: horizontal-tb;
  text-align: center;
}
.titlepage .tp-inner {
  display: inline-block;
  /* 行ボックスのベースラインに乗せると下に余分な高さが出る */
  vertical-align: top;
  height: 100%;
  writing-mode: vertical-rl;
  -epub-writing-mode: vertical-rl;
  text-align: center;
}`
    : `.titlepage {
  display: table;
  height: 100%;
  width: 100%;
}
.titlepage .tp-inner {
  display: table-cell;
  vertical-align: middle;
  text-align: center;
}`
}
${
  vertical && titleWritingModeOf(s) === 'horizontal'
    ? `/* 縦組みの本の扉だけ横組み(titleWritingMode)。扉の XHTML の html に tp-h が付く。
   html 要素ごと横組みに戻し、横組みの本と同じ table の中央寄せを、上の縦用より強い指定で重ねる。
   著者名の前のアキは縦組みでは右(margin-right)なので、上(margin-top)へ付け替える */
html.tp-h { writing-mode: horizontal-tb; -epub-writing-mode: horizontal-tb; }
html.tp-h .titlepage {
  display: table;
  height: 100%;
  width: 100%;
  writing-mode: horizontal-tb;
  -epub-writing-mode: horizontal-tb;
}
html.tp-h .titlepage .tp-inner {
  display: table-cell;
  vertical-align: middle;
  height: auto;
  writing-mode: horizontal-tb;
  -epub-writing-mode: horizontal-tb;
  text-align: center;
}
html.tp-h .titlepage .author { margin-right: 0; margin-top: 2.5em; }
`
    : ''
}.titlepage h1 {
  margin: 0;
  text-indent: 0;
  font-size: 2.4em;
  font-weight: 600;
  line-height: 1.6;
  letter-spacing: 0.08em;
}
.titlepage .author {
  margin: 0;
  text-indent: 0;
  font-size: 1.05em;
  ${blockBefore}: 2.5em;
}

/* 奥付は**本文と同じ組み方向**で、細い罫で本文と切る(リフローなので地寄せはしない)。
   組み方向を中の箱だけ変えない(colophonXhtml の頭の説明)。罫とアキは組み方向ごとに書く
   (縦組みの「行の手前」は右、「次の行」は左) */
.colophon {
  font-size: 0.9em;
  border-${vertical ? 'right' : 'top'}: 1px solid currentColor;
  padding-${vertical ? 'right' : 'top'}: 1em;
}
.colophon h1 { font-size: 1.2em; font-weight: 700; margin: 0; ${blockAfter}: 0.8em; text-indent: 0; }
.colophon p.row { text-indent: 0; margin: 0; ${blockBefore}: 0.3em; ${blockAfter}: 0.3em; }
/* 著者紹介。奥付の手前に、同じ向きで小さく置く */
.profile { font-size: 0.85em; margin: 0; ${blockAfter}: 1.4em; }
.profile h2 { font-size: 1em; font-weight: 700; margin: 0; ${blockAfter}: 0.5em; text-indent: 0; }
.profile p { text-indent: 0; margin: 0; ${blockBefore}: 0.3em; ${blockAfter}: 0.3em; }

/* ---- 目次ページ ----
   読者が本文として読む1枚(nav.xhtml とは別物。理由は tocPageXhtml のコメント)。
   **リーダーもノンブルも入れない** — 紙は章題と数字を leader('・') で繋ぐが、
   EPUB にページが無いので繋ぐ先が無い。章題だけを行として並べる。
   行と行のアキは組み方向ごとに書く(縦組みの「次の行」は左側にある) */
.toc-page h1 {
  font-family: sans-serif;
  font-weight: 700;
  font-size: 1.4em;
  margin: 0;
  text-indent: 0;
  ${blockAfter}: 2em;
}
.toc-page ul { margin: 0; padding: 0; list-style: none; }
.toc-page li { text-indent: 0; ${blockAfter}: 0.9em; }
/* 章題は本文の色のまま、下線も引かない。目次は行そのものが飛び先なので、
   全行に線が入ると読みにくい(本文中のリンクは逆に下線で示している) */
.toc-page a { color: inherit; text-decoration: none; }

nav#toc ol { list-style: none; padding: 0; margin: 0; }
nav#toc li { margin: 0.5em 0; }
`;
}

// ---- container.xml ----

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

// ---- content.opf ----

/** 挿絵ページ1件ぶんの EPUB 内の居場所 */
interface PlateDoc {
  id: string;
  file: string;
  /** ZIP 内の画像への相対パス */
  href: string;
  before: number;
  /** 紙で選んだ大きさ。EPUB では画面に対する割合になる(plateXhtml) */
  size: PlateSize;
  /** 並べ替えの順(紙の html.ts と同じ。未指定は末尾) */
  order: number;
  /** 同点のときの元の並び(挿絵はコラムより先) */
  rank: number;
  /** 設定の Plate.id(下見で「この挿絵のページ」を探すのに使う) */
  sourceId: string;
}

/** コラムページ1件ぶんの EPUB 内の居場所 */
interface ColDoc {
  id: string;
  file: string;
  before: number;
  order: number;
  rank: number;
  /** 設定の ColumnPage.id */
  sourceId: string;
}

/**
 * 読む順の1ページ(XHTML 1ファイル)。**書き出しの spine と画面の下見が同じ並びを使う。**
 * 並びを2か所で組むと、下見と書き出したファイルが食い違っていく
 */
export interface EpubSpineDoc {
  /** manifest の id */
  id: string;
  /** OEBPS からの相対パス */
  file: string;
  kind: 'cover' | 'titlepage' | 'toc' | 'chapter' | 'plate' | 'colpage' | 'colophon';
  /** 章の番号(0始まり)。章のときだけ */
  chapter?: number;
  /** 挿絵・コラムの設定の id(Plate.id / ColumnPage.id) */
  sourceId?: string;
}

interface OpfParams {
  ms: Manuscript;
  s: ProjectSettings;
  chapterFiles: string[];
  plateDocs: PlateDoc[];
  colDocs: ColDoc[];
  images: ImageAsset[];
  /** 表紙画像の manifest id。表紙が無ければ null */
  coverId: string | null;
  /** cover.xhtml を作って spine に並べたか(出し先による) */
  coverPage: boolean;
  /** 本文中の目次ページ(toc.xhtml)を作ったか。紙と共通の settings.toc で決まる */
  tocPage: boolean;
  /** dc:identifier に入れる値(ISBN があればそれ、無ければ UUID) */
  bookId: string;
  modified: string;
  /** 読む順(buildEpubBook が決めたもの) */
  spine: EpubSpineDoc[];
}

function contentOpf({
  ms,
  s,
  chapterFiles,
  plateDocs,
  colDocs,
  images,
  coverId,
  coverPage,
  tocPage,
  bookId,
  modified,
  spine,
}: OpfParams): string {
  const vertical = s.writingMode === 'vertical';

  const manifestItems = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    // 目次は EPUB3 の nav で足りるが、NCX も置いておく。
    // Kindle の変換は古い経路を通ることがあり、そこでは NCX を見にいく
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    ...(coverPage ? [`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`] : []),
    `<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>`,
    ...(tocPage ? [`<item id="tocpage" href="toc.xhtml" media-type="application/xhtml+xml"/>`] : []),
    ...chapterFiles.map((f, i) => `<item id="chapter-${pad3(i + 1)}" href="${f}" media-type="application/xhtml+xml"/>`),
    ...plateDocs.map((d) => `<item id="${d.id}" href="${d.file}" media-type="application/xhtml+xml"/>`),
    ...colDocs.map((d) => `<item id="${d.id}" href="${d.file}" media-type="application/xhtml+xml"/>`),
    `<item id="colophon" href="colophon.xhtml" media-type="application/xhtml+xml"/>`,
    // 画像は必ず manifest に載せる。載っていない資源を参照すると変換器が止まる。
    // 表紙だけは EPUB3 の properties="cover-image" も付ける
    ...images.map(
      (a) =>
        `<item id="${a.id}" href="${a.file}" media-type="${a.mediaType}"${
          a.id === coverId ? ' properties="cover-image"' : ''
        }/>`,
    ),
  ];

  // 読む順は buildEpubBook が決めてある。nav は linear="no" で、扉(と目次ページ)の次に置く
  const isLead = (d: EpubSpineDoc) => d.kind === 'cover' || d.kind === 'titlepage' || d.kind === 'toc';
  const itemref = (d: EpubSpineDoc) => `<itemref idref="${d.id}"/>`;
  const spineItems = [
    ...spine.filter(isLead).map(itemref),
    `<itemref idref="nav" linear="no"/>`,
    ...spine.filter((d) => !isLead(d)).map(itemref),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <!-- ISBN を持っている本はそれを識別子にする(楽天Kobo は dc:identifier に ISBN を求める) -->
    <dc:identifier id="pub-id">${esc(bookId)}</dc:identifier>
    <dc:title>${esc(plainText(ms.title) || '無題')}</dc:title>
    ${ms.author ? `<dc:creator>${esc(plainText(ms.author))}</dc:creator>` : ''}
    ${ms.publisher ? `<dc:publisher>${esc(plainText(ms.publisher))}</dc:publisher>` : ''}
    <dc:language>ja</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    ${vertical ? `<meta name="primary-writing-mode" content="vertical-rl"/>` : ''}
    ${/* EPUB2 系の書き方。Kobo はこちらを見る */ ''}${
      coverId ? `<meta name="cover" content="${coverId}"/>` : ''
    }
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx"${vertical ? ' page-progression-direction="rtl"' : ''}>
    ${spineItems.join('\n    ')}
  </spine>
</package>
`;
}

// ---- エントリポイント ----

/** 現在の UTC 時刻を dcterms:modified 用の YYYY-MM-DDThh:mm:ssZ 形式で返す */
function modifiedNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 1冊ぶんの中身。**書き出し(ZIP)と画面の下見が同じものを使う** */
export interface EpubBook {
  /** style.css の中身 */
  css: string;
  /** OEBPS からの相対パス → XHTML。nav.xhtml も含む */
  files: Map<string, string>;
  /** 読む順。nav は入らない(linear="no") */
  spine: EpubSpineDoc[];
  chapterFiles: string[];
  plateDocs: PlateDoc[];
  colDocs: ColDoc[];
  /** 表紙画像の参照先。無ければ null */
  coverHref: string | null;
  /** cover.xhtml を作って spine に並べたか(出し先による) */
  coverPage: boolean;
  /** 本文中の目次ページ(toc.xhtml)を作ったか */
  tocPage: boolean;
}

/**
 * 1冊ぶんの XHTML・CSS・読む順を作る。**ZIP には詰めない。**
 *
 * 書き出し(exportEpub)と画面の下見(preview/EbookPreview)が同じ関数を通るので、
 * 下見に映るのは書き出すファイルそのものになる。違うのは画像の参照先だけ(ImageResolver)。
 *
 * **画像を解決する順番を変えないこと。** 書き出しの画像の番号(img-001 …)は解決した順で決まる
 * (表紙 → 挿絵ページ → 章の中の絵)。順が変わると、同じ本でも書き出すたびに中身が変わる
 */
export function buildEpubBook(
  ms: Manuscript,
  s: ProjectSettings,
  images: ImageResolver,
  coverDataUri?: string,
): EpubBook {
  const vertical = s.writingMode === 'vertical';
  const files = new Map<string, string>();
  const chapterFiles = ms.chapters.map((_, i) => `chapter-${pad3(i + 1)}.xhtml`);

  // 表紙。**いちばん最初に解決する**ので、書き出しでは images[0] になり、id も img-001 で安定する。
  //
  // 画像そのものは出し先によらず manifest と metadata に載せる(どちらのストアも要る)。
  // **cover.xhtml を作って spine に並べるかどうかだけが違う** —
  // KDP は「表紙の HTML ページを足すと二重に出るか変換に失敗する」、
  // Kobo は「表紙画像は専用の XHTML に入れること」で、要件が正面から食い違う
  const coverHref = coverDataUri ? images.resolve(coverDataUri) : null;
  const coverPage = Boolean(coverHref) && s.epubTarget === 'reader';
  if (coverHref && coverPage) files.set('cover.xhtml', coverXhtml(coverHref, ms.title));

  // 挿絵ページ。紙と同じ順(章の前 → 巻末)に並べて番号を振る。
  // EPUB に入れられない形式の絵は、そのページごと作らない
  const plateDocs: PlateDoc[] = [];
  for (let before = 0; before <= ms.chapters.length; before++) {
    for (const p of platesBefore(s, before)) {
      const href = images.resolve(p.src);
      if (!href) continue;
      const n = pad3(plateDocs.length + 1);
      // 大きさも一緒に持って行く。紙の3つ(全面/余白すこし/余白おおめ)を
      // 画面に対する割合として渡すため(以前は href だけを渡していて、
      // どれを選んでも同じ大きさで出ていた)。
      // order/rank は紙(html.ts の insertsBefore)と同じ並べ替え用(2026-09-04)
      const rank = (s.plates ?? []).indexOf(p);
      plateDocs.push({
        id: `plate-${n}`,
        file: `plate-${n}.xhtml`,
        href,
        before,
        size: p.size,
        order: p.order ?? Number.MAX_SAFE_INTEGER,
        rank,
        sourceId: p.id,
      });
    }
  }
  for (const d of plateDocs) files.set(d.file, plateXhtml(d.href, d.size));

  // コラムページ。紙と同じ位置に、同じ順(挿絵のあと)で並べる。
  // **目次(nav / NCX)には載せない** — 挿絵ページと同じ扱いにしてある。
  // 本文の章とコラムが同じ並びに混ざると、章立てが読み取りにくくなる
  const colDocs: ColDoc[] = [];
  for (let before = 0; before <= ms.chapters.length; before++) {
    for (const c of colPagesBefore(s, before)) {
      const n = pad3(colDocs.length + 1);
      // rank は挿絵より後ろ(html.ts と同じ 1e6 + 元の並び)。同点なら挿絵が先に来る
      const rank = 1e6 + (s.columnPages ?? []).indexOf(c);
      const doc: ColDoc = {
        id: `colpage-${n}`,
        file: `colpage-${n}.xhtml`,
        before,
        order: c.order ?? Number.MAX_SAFE_INTEGER,
        rank,
        sourceId: c.id,
      };
      colDocs.push(doc);
      files.set(doc.file, colPageXhtml(c, vertical));
    }
  }

  files.set('titlepage.xhtml', titlepageXhtml(ms, vertical, vertical && titleWritingModeOf(s) === 'horizontal'));
  ms.chapters.forEach((ch, i) => {
    files.set(chapterFiles[i], chapterXhtml(ch, vertical, images, sceneBreakOf(s)));
  });
  files.set('colophon.xhtml', colophonXhtml(ms, vertical));

  // 本文中の目次ページ。**紙と共通のスイッチ(settings.toc)で出す。**
  // 載せる章が1つも無ければ、見出しだけの空ページになるので作らない(紙の tocHtml と同じ)
  const tocPage = s.toc && tocEntries(ms, chapterFiles).length > 0;
  if (tocPage) files.set('toc.xhtml', tocPageXhtml(ms, chapterFiles, vertical));

  files.set('nav.xhtml', navXhtml(ms, chapterFiles, tocPage));

  // 読む順。挿絵とコラムページは紙と同じ位置(章の前・巻末)に挟む。
  // **並び順も紙(html.ts の insertsBefore)と揃える** — order で並べ替え、同点は rank。
  // 以前は「挿絵ぜんぶ→コラムぜんぶ」の配列順で、利用者が並べ替えた本は紙とEPUBで順が食い違った
  // (2026-09-04 レビュー指摘)
  const insertsAt = (before: number): EpubSpineDoc[] =>
    [
      ...plateDocs
        .filter((d) => d.before === before)
        .map((d) => ({ sort: d, doc: { id: d.id, file: d.file, kind: 'plate' as const, sourceId: d.sourceId } })),
      ...colDocs
        .filter((d) => d.before === before)
        .map((d) => ({ sort: d, doc: { id: d.id, file: d.file, kind: 'colpage' as const, sourceId: d.sourceId } })),
    ]
      .sort((a, b) => a.sort.order - b.sort.order || a.sort.rank - b.sort.rank)
      .map((x) => x.doc);
  const spine: EpubSpineDoc[] = [];
  if (coverPage) spine.push({ id: 'cover', file: 'cover.xhtml', kind: 'cover' });
  spine.push({ id: 'titlepage', file: 'titlepage.xhtml', kind: 'titlepage' });
  // 目次ページは紙と同じく扉の次
  if (tocPage) spine.push({ id: 'tocpage', file: 'toc.xhtml', kind: 'toc' });
  chapterFiles.forEach((file, i) => {
    spine.push(...insertsAt(i), { id: `chapter-${pad3(i + 1)}`, file, kind: 'chapter', chapter: i });
  });
  spine.push(...insertsAt(chapterFiles.length));
  spine.push({ id: 'colophon', file: 'colophon.xhtml', kind: 'colophon' });

  return {
    css: epubCss(s),
    files,
    spine,
    chapterFiles,
    plateDocs,
    colDocs,
    coverHref,
    coverPage,
    tocPage,
  };
}

/**
 * @param coverDataUri 電子書籍の表紙(data URI)。省略すると表紙なしの EPUB になる。
 *   KDP は入稿画面で表紙を別に受け取るので無くても通るが、
 *   **楽天Kobo など EPUB を配本するストアは中に入っていることを求める**
 */
export async function exportEpub(
  ms: Manuscript,
  s: ProjectSettings,
  coverDataUri?: string,
): Promise<{ blob: Blob; dropped: number }> {
  const zip = new JSZip();

  // mimetype は必ず先頭・無圧縮(EPUB の必須要件)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file('META-INF/container.xml', containerXml());

  /*
   * **EPUB には軽い画像を入れる。**(2026-09-26 ユーザーと決定「紙はくっきり、電子は軽く」)
   * 1回目は中身を作って、使っている画像を集めるだけ。集めた画像を軽くしてから(非同期)、
   * 2回目で本番を作る。表紙(KDP 推奨 1600×2560 で作ってある)は縮めない。
   * 読めない画像は図版ごと落とし、数を返す(呼び出し側が言う)
   */
  const used = new Set<string>();
  buildEpubBook(ms, s, { resolve: (src) => (used.add(src), src) }, coverDataUri);
  const light = new Map<string, string | null>();
  let dropped = 0;
  for (const src of used) {
    const l = src === coverDataUri ? src : await lightenForEbook(src);
    if (l === null) dropped++;
    light.set(src, l);
  }
  // 画像はここで集め、ZIP 内のファイルに移す(data URI のままでは Kindle が変換できない)
  const images = new ImageCollector();
  const book = buildEpubBook(
    ms,
    s,
    {
      resolve: (src) => {
        const l = light.has(src) ? light.get(src) : src;
        return l ? images.resolve(l) : null;
      },
    },
    coverDataUri,
  );
  const coverId = book.coverHref
    ? (images.assets.find((a) => a.file === book.coverHref)?.id ?? null)
    : null;

  /*
   * **壊れた XHTML は書き出さない。**(2026-09-25 見直し S2-4) 前は検査せずに ZIP へ入れていた。
   * 段落のタグは balanceInline で対にしてあるので、ここで引っかかるのは想定の外のものだけ。
   * 黙って壊れた EPUB を渡すより、止めてどのページかを言う
   */
  const broken = [...book.files]
    .filter(([file]) => file.endsWith('.xhtml'))
    .filter(([, xhtml]) =>
      new DOMParser().parseFromString(xhtml, 'application/xhtml+xml').getElementsByTagName('parsererror').length,
    )
    .map(([file]) => {
      const doc = book.spine.find((d) => d.file === file);
      return doc?.chapter !== undefined ? `${doc.chapter + 1}つめの章` : file;
    });
  if (broken.length) {
    throw new Error(
      `EPUB の中の ${broken.join('・')} が、読む端末で読めない形式になりました。` +
        'その章の原稿に、閉じていないタグや特殊な記号がないか確かめてください',
    );
  }
  for (const [file, xhtml] of book.files) zip.file(`OEBPS/${file}`, xhtml);
  zip.file('OEBPS/style.css', book.css);

  // 画像の実体。章と挿絵の両方を集め終えてから書く
  for (const a of images.assets) {
    zip.file(`OEBPS/${a.file}`, a.bytes);
  }

  // 識別子。ISBN を持っている本はそれを使う(Kobo は dc:identifier に ISBN を求める)。
  // 数字とハイフン以外が混ざっているものは ISBN と見なさない
  // ISBN-10 は末尾がチェックディジット X になりうる。ISBN-13 は数字13桁
  // (2026-09-04: 従来は X 終わりを弾いて uuid に落ちていた)
  const isbn = (ms.isbn ?? '').replace(/[\s-]/g, '');
  const bookId = /^(\d{9}[\dXx]|\d{13})$/.test(isbn)
    ? `urn:isbn:${isbn.toUpperCase()}`
    : `urn:uuid:${crypto.randomUUID()}`;
  const modified = modifiedNow();
  zip.file('OEBPS/toc.ncx', tocNcx(ms, book.chapterFiles, bookId));
  zip.file(
    OPF_PATH,
    contentOpf({
      ms, s, chapterFiles: book.chapterFiles, plateDocs: book.plateDocs, colDocs: book.colDocs,
      images: images.assets, coverId, coverPage: book.coverPage, tocPage: book.tocPage,
      bookId, modified, spine: book.spine,
    }),
  );

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
  return { blob, dropped };
}
