// 原稿 → 組版済みHTML文書(Vivliostyle に渡す完全なHTML)。

import {
  SCENE_BREAKS,
  columnPageMode,
  columnPageParagraphs,
  hasOwnBg,
  isRenderableImage,
  listMarker,
  listStartAttr,
  sceneBreakOf,
  titleWritingModeOf,
} from '../models/project';
import { imageKey } from '../models/inlineImages';
import { assetUrl } from './blobUrl';
import type {
  Bleed4,
  ColumnPage,
  Manuscript,
  Plate,
  ProjectSettings,
  SceneBreakId,
} from '../models/project';
import { computeLayout } from './grid';
import { clipRunningHead, runningHeadMaxChars, typesetCss } from './css';
import { PROFILE_TITLE, authorProfileParagraphs, colophonRows } from './matter';
import { escapeHtml, isDialogueStart, paragraphHtml, stripInlineMarks, wrapDropCap } from './text';

/**
 * 場面転換(原稿の `---`)。**選ばれた見た目でHTMLごと変える。**
 *
 * CSS だけで切り替えず要素を変えるのは、**EPUB と Word も同じ答えを出すため**。
 * `hr::before` に字を入れる手もあるが、読む機械によって生成内容の扱いが違ううえ、
 * 抜き出した文字列にも残らない(検査で数えられない)。
 *
 * 1行アキの中身は全角空白。**空の `<p></p>` は高さを持たない**ので、
 * それでは1行ぶんのアキにならない(空行 `p.line-space` が全角空白を置くのと同じ理由)
 */
export function sceneBreakHtml(scene: SceneBreakId): string {
  if (scene === 'rule') return '<hr>';
  if (scene === 'blank') return '<p class="scene-break blank">　</p>';
  return `<p class="scene-break mark">${escapeHtml(SCENE_BREAKS[scene].mark)}</p>`;
}

/** 章見出しのHTML。章番号と章題はワンセット(rules §6)。
 * span+text-indent では起こし下げが効かないため、全てブロック要素で組む */
function chapterHeading(
  no: string | undefined,
  title: string,
  vertical: boolean,
  /** 柱に刷れる字数の上限(runningHeadMaxChars)。章題が長いと柱が紙の端へ出るので、越える分は「…」で省く */
  headMax = Infinity,
): string {
  if (!no && !title) return '';
  const noHtml = no ? `<p class="chapter-no">${escapeHtml(no)}</p>` : '';
  // **柱にはルビの読みを出さない。** 柱の文字列は CSS の string-set が拾うが、
  // content() だと <rt> の読みまで連なってしまう(css.ts の .ct を参照)。
  // 読みを外した字を属性で渡し、そちらを拾わせる。
  // **太字などの記法も外す**(stripInlineMarks。前は `**第1章**` の ** が柱に刷られた。2026-10-13)
  const plain = stripInlineMarks(
    title
      .replace(/《《([^》]+)》》/g, '$1')
      .replace(/《[^》]*》/g, '')
      .replace(/[｜|]/g, ''),
  );
  const titleHtml =
    `<h2 class="ct" data-plain="${escapeHtml(clipRunningHead(plain, headMax))}">${paragraphHtml(title, vertical)}</h2>`;
  return `<header class="chapter-title">${noHtml}${titleHtml}</header>`;
}

/** 目次(rules §8)。章題+ノンブルをリーダーで接続する。目次自身は載せない。
 * ページ番号は CSS の target-counter が章の id を引いて入れる */
function tocHtml(ms: Manuscript, vertical: boolean): string {
  const entries = ms.chapters
    .map((ch, i) => ({ label: [ch.no, ch.title].filter(Boolean).join('　'), id: `ch${i + 1}` }))
    .filter((e) => e.label);
  // あとがき・おわりにの類は本文の章なので、上の map で一緒に載る。
  // 著者紹介は奥付の一部として組むので目次には出さない(和書の慣例)
  const items = entries
    .map(({ label, id }) =>
      // ページ番号を a::after に含めると縦書きで横倒しになる。
      // 別要素に切り出して縦中横をかけるため span を置く(中身は CSS が入れる)
      `<li><a href="#${id}">${paragraphHtml(label, vertical)}</a>` +
        `<span class="pn" data-page="#${id}"></span></li>`,
    )
    .join('\n');
  if (!items) return '';
  return `<section class="toc">
<h1>目次</h1>
<ul>
${items}
</ul>
</section>`;
}

/**
 * @param fontFaceCss 同梱する @font-face(collectFontFaceCss で作る)。
 *   これが無いと、印刷経路や CLI で書体が閲覧環境のものに置き換わる
 */
/**
 * 組版HTMLに入れる、塗り足しの覚え書き(<meta>)。**下見の仕上がり線が読む。**(2026-10-02)
 *
 * 線の位置は「いま下見に出ている紙面が、どの塗り足しで組まれたか」で決まる。設定のほうを見ると、
 * 組み直している最中(古い紙面がまだ出ている)に、新しい塗り足しの位置へ線を引いてしまう。
 * 組んだ HTML そのものに書いておけば、下見が面を組みはじめるときに読んで、その面に線の位置を持たせられる
 * (VivliostylePreview の boxesOf / applyFaceVars)。組版には影響しない(head の meta)
 */
const BLEED_META = 'studio-bleed';
/**
 * 同じく、版面の余白(仕上がりの端から、天・地・小口・ノド)の覚え書き。**下見の版面の枠が読む。**(2026-10-02)
 * 絵の中の文字が版面の外に出ているとき、全ページに版面の枠を出す(src/textcheck)。枠も、出ている紙面の余白で引く
 */
const AREA_META = 'studio-area';
/**
 * 同じく、中綴じの白いページと共紙の表紙のページの数(「白いページ 表紙のページ」)。(2026-10-03)
 * 下見の組み上がりのページ数から本文だけの数 n0 を引き戻して、白いページがいくつ要るかを決める(App の saddle の収束)。
 * **中綴じの本だけに付く**(無線綴じの組版HTMLは変わらない)。組んだ HTML に書くので、設定のほうを見て古い紙面の数を取り違えない
 */
const PAD_META = 'studio-pad';

/** 組版HTMLから、中綴じの白いページと共紙の表紙のページの数を読む。中綴じの HTML でない・壊れているときは null */
export function padOfHtml(html: string): { pad: number; cover: number } | null {
  const m = new RegExp(`<meta name="${PAD_META}" content="(\\d+) (\\d+)">`).exec(html.slice(0, 700));
  return m ? { pad: Number(m[1]), cover: Number(m[2]) } : null;
}
const bleedMetaContent = (b: Bleed4) => [b.top, b.bottom, b.fore, b.gutter].map((v) => Number(v.toFixed(3))).join(' ');

/** 覚え書きの4つの数(天・地・小口・ノド)を読む。無い・壊れているときは null */
function metaBox(html: string, name: string): Bleed4 | null {
  // 覚え書きは head の先頭にある。本文(数MB になる)を全部は探さない
  const m = new RegExp(`<meta name="${name}" content="([\\d. ]+)">`).exec(html.slice(0, 600));
  if (!m) return null;
  const v = m[1].split(' ').map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return { top: v[0], bottom: v[1], fore: v[2], gutter: v[3] };
}

/** 組版HTMLから、塗り足し(天・地・小口・ノド)を読む。覚え書きが無い・壊れているときは null */
export function bleedOfHtml(html: string): Bleed4 | null {
  return metaBox(html, BLEED_META);
}

/** 組版HTMLから、版面の余白(仕上がりの端から。天・地・小口・ノド)を読む。無い・壊れているときは null */
export function marginsOfHtml(html: string): Bleed4 | null {
  return metaBox(html, AREA_META);
}

/** 下見が面ごとに持つ、紙面の箱(塗り足しと版面の余白)。VivliostylePreview の boxesOf に渡す */
export function pageBoxesOfHtml(html: string): { bleed: Bleed4; margins: Bleed4 | null } | null {
  const bleed = bleedOfHtml(html);
  return bleed ? { bleed, margins: marginsOfHtml(html) } : null;
}

export interface ManuscriptHtmlOptions {
  /**
   * 下見だけ true。縦組みの本の大扉に、書名・著者名を**縦用と横用の両方**で入れる(2026-10-03)。
   * 縦横は下見が CSS の差し替えだけで選ぶ(preview/paint.ts)ので、向きを変えても組み直さない。
   * 縦用と横用で字の並びが変わるのは数字と ！？ だけ(縦中横・全角化)で、変わらないときは1つだけ入れる。
   * 紙の書き出しは付けない: そのときの設定の向きの1つだけが入り、組版HTMLは1バイトも変わらない
   */
  titleBothWays?: boolean;
  /**
   * 中綴じの本だけ渡す(2026-10-03)。**奥付の手前に入れる白いページの枚数**。
   * 中綴じはページ数を 4 の倍数にそろえる(typeset/saddle.ts の saddlePad)。奥付が最後のページに来る。
   * 省略(無線綴じ)は何も足さず、組版HTMLは1バイトも変わらない。0 でも渡すと、覚え書き(studio-pad)は付く
   */
  padPages?: number;
  /**
   * 中綴じの共紙のとき、表紙の表1・表4を本文に入れる。**先頭に 表1・表2(白)、末尾に 表3(白)・表4**(計4ページ)。
   * `{front, back}` は表1・表4の絵(data URI)で、紙の書き出しで使う。`'placeholder'` は下見用の仮の枠
   * (絵は入れず「表1」「表4」と薄く書く。表紙を直すたびに本文を組み直さないため)
   */
  coverFaces?: { front: string; back: string } | 'placeholder';
}

export function manuscriptHtml(
  ms: Manuscript,
  s: ProjectSettings,
  fontFaceCss = '',
  opts: ManuscriptHtmlOptions = {},
): string {
  const vertical = s.writingMode === 'vertical';
  /** 大扉の書名・著者名の向き。横組みにするときは縦中横を掛けない(著者紹介と同じ約束) */
  const titleVertical = vertical && titleWritingModeOf(s) === 'vertical';
  /** 大扉の1行ぶん。下見(titleBothWays)の縦組みの本は、縦用 .tt-v と横用 .tt-h を並べて入れる */
  const titleText = (raw: string): string => {
    if (!(opts.titleBothWays && vertical)) return paragraphHtml(raw, titleVertical);
    const v = paragraphHtml(raw, true);
    const h = paragraphHtml(raw, false);
    return v === h ? v : `<span class="tt-v">${v}</span><span class="tt-h">${h}</span>`;
  };
  /** 章ごとの指定があればそちら。0 も「使わない」という指定なので ?? で拾う */
  const dropOf = (i: number) =>
    Math.max(0, Math.min(5, Math.round((s.chapterDropCap ?? {})[i] ?? s.dropCap ?? 0)));
  const layout = computeLayout(s);
  /** 柱に刷れる字数の上限。章題が長いときだけ data-plain が切られる(短いときは HTML が変わらない) */
  const headMax = runningHeadMaxChars(s, layout);
  /** 場面転換の見た目。**本1冊でひとつ**(章ごとには持たない) */
  const scene = sceneBreakOf(s);
  const profile = authorProfileParagraphs(ms);
  const rows = ms.title ? colophonRows(ms) : [];
  const css = typesetCss(s, layout, ms.title);
  const parts: string[] = [];

  // 共紙の表紙(中綴じ)。先頭は 表1・表2(白)。末尾の 表3(白)・表4 は奥付のあとに足す(下の coverTail)。
  // 表1・表4 は用紙いっぱいの絵のページ(div.plate.full)。下見の仮の枠('placeholder')は絵を持たない
  const faces = opts.coverFaces;
  const coverFace = (which: 'front' | 'back'): string => {
    if (faces === 'placeholder') {
      const mark = which === 'front' ? '表1（表紙）' : '表4（裏表紙）';
      return `<div class="plate" data-cover="${which}" style="display:flex;align-items:center;justify-content:center;background:#f2f2f2;color:#aaa;font:700 16pt sans-serif;writing-mode:horizontal-tb;">${mark}</div>`;
    }
    const src = faces ? faces[which] : '';
    return src
      ? `<div class="plate full" data-cover="${which}"><img src="${escapeHtml(src)}" alt=""></div>`
      : `<div class="plate blank" data-cover="${which}"></div>`;
  };
  const coverBlank = '<div class="plate blank" data-cover="inside"></div>';
  if (faces) parts.push(coverFace('front'), coverBlank);

  // 大扉。書名と著者名だけを置く(版元名は奥付に記載するので入れない)。
  // 本文と同じ整形(縦中横・数字の全角化)を通す
  if (ms.title) {
    parts.push(`<section class="titlepage">
<h1>${titleText(ms.title)}</h1>
${ms.author ? `<p class="author">${titleText(ms.author)}</p>` : ''}
</section>`);
  }

  // 目次(扉の次・本文の前。rules §8 の構成順)
  if (s.toc) {
    const toc = tocHtml(ms, vertical);
    if (toc) parts.push(toc);
  }

  // 挿絵ページ。章の切れ目にだけ入る(理由は models/project.ts の Plate を参照)
  /**
   * 章の切れ目に挟む1ページ。絵のあるものと、**わざと空けた白ページ**の2種類。
   *
   * 白ページを利用者が置けるようにしたので、**組版側で勝手にページを足さない**。
   * 以前は本文が始まる章の直前だけ挿絵を偶数ページへ寄せていた(奇数起こしと
   * ぶつかって白が挟まるのを、見開きで向かい合う位置へ動かすため)。
   * だが黙ってページが増えるのは説明できない挙動なので、
   * 「置いたものがそのまま出る」に統一した(2026-08-17 ユーザー判断)。
   * 目次のあとに [空白][絵] と2枚置けば、同じ見え方を自分で作れる。
   */
  const plateHtml = (p: Plate) => {
    // **絵をまだ選んでいない挿絵ページも、1ページとして出す。**(2026-08-20)
    // 足してから絵を選ぶ形にしたので、その途中の状態が必ずある。
    // 出さないとページ数が合わず、左の欄の「いま N ページ目」も出せない
    if (p.blank || !p.src) return `<div class="plate blank" data-plate="${escapeHtml(p.id)}"></div>`;
    // 灰色の写しに差し替えた絵(models/printColor.ts)は印を付ける。白黒の本の filter を掛けないため(css.ts の img:not(.gray-copy))
    const img = `<img${p.grayCopy ? ' class="gray-copy"' : ''} src="${escapeHtml(assetUrl(p.src))}" alt="">`;
    // **見開き(2ページ)は、同じ絵を2つの箱に入れる**(2026-10-03)。1つめ(sp-a)が偶数ページ、2つめ(sp-b)が奇数ページ。
    // 切り出しは css.ts の div.plate.spread。data-plate は1つめだけに付ける(2つめは data-plate-b。
    // ページ一覧の「動かせる差し込みページ」は1つめで、2つめは1つめといっしょに動く・消える)
    if (p.size === 'spread') {
      return (
        `<div class="plate spread sp-a" data-plate="${escapeHtml(p.id)}">${img}</div>\n` +
        `<div class="plate spread sp-b" data-plate-b="${escapeHtml(p.id)}">${img}</div>`
      );
    }
    return `<div class="plate ${p.size}" data-plate="${escapeHtml(p.id)}">${img}</div>`;
  };
  /**
   * コラムページ。**そのページ自身の組み方向で整形する。**
   * 縦中横(applyTcy)は縦組みのためのもので、横組みのページに掛けると数字が押し潰される
   * (paragraphHtml の第2引数)。見出しの位置(1ページに収める作り)は
   * css.ts の section.colpage を参照
   */
  const colPageHtml = (c: ColumnPage, i: number) => {
    const pageVertical = columnPageMode(c, s.writingMode) === 'vertical';
    const cls = pageVertical ? 'wm-v' : 'wm-h';
    const title = c.title.trim();
    const head = title ? `<h2>${paragraphHtml(title, pageVertical)}</h2>` : '';
    const body = columnPageParagraphs(c.text)
      .map((t) =>
        // 空行は1行アキ(columnPageParagraphs の '' )。ゼロ幅スペースを入れて
        // 行の高さぶんだけ場所を取らせる(空の <p> は潰れて高さが出ない)
        t === ''
          ? '<p class="colpage-aki no-indent">​</p>'
          : `<p${isDialogueStart(t) ? ' class="no-indent"' : ''}>${paragraphHtml(t, pageVertical)}</p>`,
      )
      .join('\n');
    // 番号のクラスは css.ts のページごとの書体・サイズと対にする。
    // 背景を指定したページには、その専用ページの名前も付ける
    const bgCls = hasOwnBg(c.bg) ? ` colbg${i}` : '';
    return `<section class="colpage ${cls} colp${i}${bgCls}" data-colpage="${escapeHtml(c.id)}">
${head}
${body}
</section>`;
  };

  /**
   * その切れ目に挟むページ。**挿絵とコラムを1つの列にして order で並べる。**
   *
   * もとは「挿絵をぜんぶ → コラムをぜんぶ」の順に出していたので、
   * 同じ切れ目にある挿絵とコラムをひっくり返せなかった(2026-08-20 ユーザー指摘)。
   * order の無いものは末尾へ回し、そこは元の並び(挿絵が先、次にコラム)を保つ。
   * これで、並べ替えたことのない本の見え方は今までと変わらない
   */
  const insertsBefore = (chapter: number) => {
    const LAST = Number.MAX_SAFE_INTEGER;
    const items: { order: number; rank: number; html: string }[] = [];
    (s.plates ?? []).forEach((p, i) => {
      if (p.beforeChapter !== chapter) return;
      // 表示できない形式(Word の EMF/WMF など)は組まない。絵がまだ無いものは通す
      if (p.src && !p.blank && !isRenderableImage(p.src)) return;
      items.push({ order: p.order ?? LAST, rank: i, html: plateHtml(p) });
    });
    (s.columnPages ?? []).forEach((c, i) => {
      if (c.beforeChapter !== chapter) return;
      // **中身が空でも1ページとして出す。**(2026-08-20)
      // 足してから中を書く形にしたので、その途中の状態が必ずある。
      // 出さないとページ数が合わず、足した先へ飛ぶことも光らせることもできない
      // (書き出し側は空を捨てる。刷る段になって白紙が混ざるのは困るため)
      // 挿絵と同点のときは挿絵を先に(元の並びを保つ)ので、大きめの rank を渡す
      items.push({ order: c.order ?? LAST, rank: 1e6 + i, html: colPageHtml(c, i) });
    });
    return items
      .sort((a, b) => a.order - b.order || a.rank - b.rank)
      .map((x) => x.html)
      .join('\n');
  };

  // 本文
  ms.chapters.forEach((ch, i) => {
    /**
     * **その章の組み方向で組む。** 縦中横(applyTcy)は縦組みのためのもので、
     * 横組みの章に掛けると数字が押し潰される。章ごとに切り替える
     */
    const chVertical = vertical;
    // 挿絵は section の「外」に出す。中に入れると章見出しの後ろになり、
    // 挿絵の改ページで見出しだけが前のページに取り残される(実機で発生)
    const beforeSection = insertsBefore(i);
    if (beforeSection) parts.push(beforeSection);

    // ドロップキャップは章の最初の**本文**に付ける(挿絵や空行は飛ばす)
    let firstDone = false;
    const body = ch.blocks
      .map((b, bi) => {
        if (b.type === 'space') return '<p class="line-space">　</p>';
        if (b.type === 'h3') return `<h3>${paragraphHtml(b.text, chVertical)}</h3>`;
        if (b.type === 'hr') return sceneBreakHtml(scene);
        if (b.type === 'quote') return `<blockquote>${paragraphHtml(b.text, chVertical)}</blockquote>`;
        if (b.type === 'list') {
          // マーカーは字として置く。list-style は使わない
          // (縦組みでは行の外に落ちるうえ、番号が半角のまま寝る)。
          // 中身だけ paragraphHtml に通す — マーカーは全角で作ってあるので、
          // 縦中横に掛けると逆に組み直されてしまう
          const items = b.items
            .map(
              (t, i) =>
                `<li>${listMarker(i, b.ordered, b.start)}${paragraphHtml(t, vertical)}</li>`,
            )
            .join('\n');
          return b.ordered
            ? `<ol class="list"${listStartAttr(b)}>\n${items}\n</ol>`
            : `<ul class="list">\n${items}\n</ul>`;
        }
        if (b.type === 'image') {
          // 表示できない形式(Word の EMF/WMF など)は組まない。
          // 空の枠だけが残って版面が崩れるより、無い方がまし。画面側で枚数と理由を出す。
          // AI 用の JSON で戻せなかった画像(src が空)もここで落ちる。枚数は読み込み時に警告済み
          if (!isRenderableImage(b.src)) return '';
          // src は data URI。paragraphHtml を通すと base64 の数字が縦中横に化けるので
          // エスケープのみにとどめる
          const img = `<img${b.grayCopy ? ' class="gray-copy"' : ''} src="${escapeHtml(assetUrl(b.src))}" alt="${escapeHtml(b.alt ?? '')}">`;
          // 組み上がりから「何ページ目に出たか」を読むための目印(［挿絵］の「◯ページ目（見る）」)
          const key = ` data-img="${imageKey(i, bi)}"`;
          // 全面画像は単独ページを占める。キャプションは置けない(余白がないため)
          if (b.full) return `<div class="fullbleed"${key}>${img}</div>`;
          // 余白つきの1ページ。**挿絵ページと同じ箱で組む**(css.ts の div.plate)。
          // 章の途中でも、段組みの中でも、用紙の実寸と break-before/after で1ページを占める。
          // data-plate は付けない — ページ一覧はそれを「動かせる差し込みページ」と読む
          // (見開きは章の途中の絵には無い。保存や AI の JSON から来ても、1ページものにはしない)
          if (b.size && (b.size as string) !== 'spread') return `<div class="plate ${b.size}"${key}>${img}</div>`;
          const cap = b.caption ?? b.alt;
          // キャプションは縦書きだと画像の「左」に積まれる。その1行ぶん画像を細くする
          // 必要があるので、有無をクラスで伝える
          return `<figure class="fig${cap ? ' has-cap' : ''}"${key}>${img}${
            cap ? `<figcaption>${paragraphHtml(cap, chVertical)}</figcaption>` : ''
          }</figure>`;
        }
        // 行末寄せの段落(あとがきの署名・日付)。**ドロップキャップより先に見る** —
        // 章の1つめが署名になることはまず無いが、そうなったときに
        // 「行末に寄った巨大な1文字」が出るのは事故でしかない
        if (b.align === 'end') {
          return `<p class="align-end">${paragraphHtml(b.text, chVertical)}</p>`;
        }
        // 章の最初の段落だけ、先頭のひとかたまりを包む(ドロップキャップ)。
        // 包むのは HTML を作るこちら側。CSS の ::first-letter では、
        // 数字で始まる章(縦中横)に効かなかった
        const firstBody = dropOf(i) > 0 && !firstDone;
        if (firstBody) firstDone = true;
        const cls = isDialogueStart(b.text) ? ' class="no-indent"' : '';
        const inner = paragraphHtml(b.text, chVertical);
        return `<p${cls}>${firstBody ? wrapDropCap(inner) : inner}</p>`;
      })
      .join('\n');
    // 章ごとの背景を指定していれば、その章だけ専用のページ名にする
    // (page はインラインstyleでは効かないので、CSS側のクラスで当てる)
    const bgCls = hasOwnBg((s.chapterBg ?? {})[i]) ? ` chapbg${i}` : '';
    // 章ごとの文字色(本文・章見出し)。背景と同じくクラスで当てる(章を特定できる目印が要る)。
    // 1つのクラスに両方ぶら下げる。@page の名前と結びついている chapbg とは別に持つ
    // 組み方向か書体を上書きする章。CSS 側が section.chmixN に当てる
    const mixCls =
      (s.chapterFont ?? {})[i] ||
      (s.chapterFontPt ?? {})[i] ||
      (s.chapterDropCap ?? {})[i] !== undefined ||
      (s.chapterLineFeedPt ?? {})[i] ||
      (s.chapterColumns ?? {})[i]
        ? ` chmix${i}`
        : '';
    // 章ごとの帯。濃さの指定があれば専用クラスを付ける(0 = 帯なしも指定のうち)
    const plateCls = (s.chapterPlate ?? {})[i] !== undefined ? ` chplate${i}` : '';
    const colorCls =
      (s.chapterTextColor ?? {})[i] ||
      (s.chapterHeadingColor ?? {})[i] ||
      (s.chapterSubheadingColor ?? {})[i]
        ? ` chcol${i}`
        : '';
    parts.push(`<section class="chapter${i === 0 ? ' first' : ''}${bgCls}${colorCls}${mixCls}${plateCls}" id="ch${i + 1}">
${chapterHeading(ch.no, ch.title, chVertical, headMax)}
${body}
</section>`);
  });

  // 巻末の挿絵・コラムページ(最後の章の後・奥付の前)
  const lastPlates = insertsBefore(ms.chapters.length);
  if (lastPlates) parts.push(lastPlates);

  // 中綴じの白いページ(ページ数を 4 の倍数にそろえる)。**奥付の手前**に入れる。奥付が最後のページになる。
  // 自分で置いた挿絵・白ページは上の lastPlates にもう入っているので、そのぶん足す枚数は減る(数えるのは App)。
  // data-plate は付けない — ページ一覧は「動かせる差し込みページ」と読んでしまう(章の途中の絵と同じ扱い)
  const pad = Math.max(0, Math.floor(opts.padPages ?? 0));
  if (pad > 0) parts.push(Array.from({ length: pad }, () => '<div class="plate blank" data-pad></div>').join('\n'));

  // 奥付。地に寄せるため中身を1枚の箱にまとめる(CSS が絶対配置で下端に置く)。
  // 著者紹介は版面の天から流す(奥付とはくっつけない。css.ts の .profile-box)
  const colophonBox = rows.length
    ? `<div class="colophon-box">
<h1>${paragraphHtml(ms.title, false)}</h1>
${
        rows
          // 生テキストのまま埋めると発行年月日の半角数字が寝てしまう
          .map((t) => `<p class="row">${paragraphHtml(t, false)}</p>`)
          .join('\n')
      }
</div>`
    : '';

  // 著者紹介。奥付と同じく横組み固定なので、縦中横は掛けない(vertical=false)
  const profileBox = profile.length
    ? `<div class="profile-box">
<h2>${paragraphHtml(PROFILE_TITLE, false)}</h2>
${profile.map((t) => `<p>${paragraphHtml(t, false)}</p>`).join('\n')}
</div>`
    : '';

  if (colophonBox || profileBox) {
    parts.push(`<section class="colophon">
${[profileBox, colophonBox].filter(Boolean).join('\n')}
</section>`);
  }

  // 共紙の末尾: 表3(白)・表4。奥付(最後の本文ページ)のあとに続く
  if (faces) parts.push(coverBlank, coverFace('back'));

  // 中綴じの本だけ、白いページと表紙のページの数を覚え書きに残す(無線綴じの HTML は変えない)
  const padMeta =
    opts.padPages !== undefined || faces
      ? `\n<meta name="${PAD_META}" content="${pad} ${faces ? 4 : 0}">`
      : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="${BLEED_META}" content="${bleedMetaContent(layout.bleed)}">
<meta name="${AREA_META}" content="${bleedMetaContent(layout.margins)}">${padMeta}
<title>${escapeHtml(ms.title || '無題')}</title>
<style>
${fontFaceCss}
${css}
</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>`;
}
