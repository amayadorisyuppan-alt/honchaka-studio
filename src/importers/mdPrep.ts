// Markdown 原稿の下ごしらえ。md.ts が行を読む前に、記法の外側の問題を片づける。(2026-10-13 Google ドキュメントの Markdown で本が壊れた件)
//
// ## なぜ在るか
//
// Google ドキュメントの［ファイル］→［ダウンロード］→［Markdown（.md）］で書き出した原稿を取り込むと、本が壊れた:
// - 本に貼った絵が `[image1]: <data:image/png;base64,…>` という 146万字の1行になって末尾に付き、
//   「あとがき」の段落として組版に渡った(紙面ができるまで 75〜80 分の見込み。見張りは importers/guard.ts)
// - 本文の `![][image1]` は字のまま刷られ、絵はどこにも入らなかった
// - 見出しが `# **第1章　雨の日の図書室**` と ** で包まれ、章の番号が読めず、柱に ** が刷られた
// - 書き手が打った記号が `\>` `\*\*\*` のように逃がされ、引用・区切り線にならないうえ `\` ごと刷られた
// 同じ原稿を Word(.docx)で書き出すと正しく取り込めた。
// 利用者には、Google ドキュメントは Word(.docx)でダウンロードするよう案内している(それだけをすすめる。画面・ヘルプ。2026-10-13 ユーザー決定)。
// ここは、それでも .md で持ってきた人のため。
//
// ここでするのは:
// 1. 絵(どの .md も): 定義 `[id]: <data:…>` を集めて行ごと外し、本文の `![][id]`・`![](data:…)`・`<img src="data:…">` を
//    絵のブロックにする。受けるのは JPEG と PNG だけ(種類の名前と、中身の頭のバイトの両方で見る)。ファイルの場所や URL で書いた絵は
//    取りに行かない(このアプリは外のサイトやパソコンのファイルを読みに行かない)。どちらも数を言う。
//    Obsidian の `![[…]]` は、名前が絵のファイル(.png など)のときだけ絵として数える(ほかはノートの埋め込みなので字のまま残す)
// 2. 見出し(どの .md も): `{#…}`・強調の印・`[字](#…)` を外し、中の絵は見出しのすぐあとへ。空の見出しと `# ---` は捨てる。
//    `# ***`・`# * * *` のような記号だけの見出しは、章の切れ目として残す(題の無い章を区切る書き方)
// 3. 逃がし `\X`(X は ASCII の記号): Google の書き出しと見分けたら、構造を見る**前に**外す(打った記法が .txt と同じに効く)。
//    ほかの .md は、このアプリで構造や飾りになる記号(HOLD_PUNCT)の前の `\` だけを外して「その字そのもの」にする
//    (`\#` は見出しにしない。`\` は刷らない)。ほかの記号の前の `\`(顔文字の `\(^o^)/` など)は打ったまま刷る
// 4. Google の段落の空き: 段落のあいだを詰めた文書(段落の後ろに「  」)では、空行1つが書き手の空の段落 = 1行アキ
// 5. 小さなもの: 空の箇条書き・チェックボックス・`- ## x`・`> > ` の入れ子・コードブロックの印・目次の行・U+000B・YAML の見分け
//
// 調べた中身(Google の書き出し 18 本と、ほかの道具の .md 217 本で見分けを確かめた)は、
// 2026-10-13 の調べの記録(Google ドキュメントの Markdown の癖)にある。
//
// 画面にも mammoth にも触らない(md.ts と同じく同期。単体の検査 scripts/mdGdocs.test.ts で回す)。
// 利用者に出す文は、あとで言い回しを直せるように名前を付けて下にまとめてある。

import type { Chapter } from '../models/project';
import { sniffImage } from '../images/imageFile';
import { detectEndAlignLine, detectListLine, detectQuoteLine } from './txt';

// ---- 利用者に出す文 ----

/** JPEG・PNG として読めない絵(GIF・WebP・壊れたデータなど)を外したとき(2026-10-13 言い回しを見直した。「取り込めませんでした」) */
export const mdImageFormatNote = (n: number): string =>
  `原稿の中の画像 ${n}枚は、JPEG か PNG として読み込めなかったため取り込めませんでした。` +
  '［挿絵］から JPEG か PNG の画像を入れてください';

/** ファイルの場所や URL で書かれた絵を外したとき(.md の中に絵そのものが無い) */
export const mdImageLinkedNote = (n: number): string =>
  `ファイルの場所や URL で書かれた画像 ${n}枚は取り込めませんでした（.md の中に画像そのものが入っていないため）。` +
  '［挿絵］から画像を入れてください';

/**
 * Google ドキュメントの Markdown と見分けたとき。**絵が入っていなくても1つだけ言う。**
 * Word(.docx)でのダウンロードをすすめる(画面・ヘルプの案内と同じく、それだけをすすめる。2026-10-13 ユーザー決定)。
 * - 絵を取り込んだときは、**刷るにはきめが足りない**(約 96dpi の PNG)ことも言う
 * - Google の Markdown の書き出しは、「テキストを折り返す」にした画像・図形描画・空の段落で作った場面の区切りを、
 *   黙って落とす(2026-10-13 の調べ。公開の文書で、画像 5枚のうち 2枚が消えた)。絵が1枚も入っていない .md でも、
 *   本当は絵があったのかもしれないので言う
 * 見分けを外すこともあるので「のようです」と言う。
 * 最後の文は 2026-10-13 に言い回しを見直した(見直し済みの文。直すことは「おすすめします」にとどめる。取り込みは止めていないので)。
 * ヘルプの「Word 以外で書いた原稿」(help/content.ts の HELP_SOURCES)でも、Google の Markdown は使わないよう言っている
 */
export const gdocsMdNote = (images: number): string =>
  'Google ドキュメントから書き出した Markdown（.md）のようです。' +
  (images ? `入っていた画像 ${images}枚は、画面で見るための小さな写しなので、印刷すると粗くなります。` : '') +
  'Markdown の書き出しでは、「テキストを折り返す」にした画像や図形描画、空の行で作った場面の区切りが抜けることがあります。' +
  'Google ドキュメントで「ファイル」→「ダウンロード」→「Microsoft Word（.docx）」として保存し、取り込み直すことをおすすめします（画像も元の細かさで入ります）';

// ---- 逃がし \X ----

/** CommonMark で `\` を前に置いて逃がせる字(ASCII の記号。ちょうど 32 字) */
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

/**
 * 逃がした字の預け先。Unicode の非文字 U+FDD0〜U+FDEF(ちょうど 32 字。文書の中には現れないと決められている字)。
 * 構造や記法を探すあいだ、逃がした字をこれに替えておけば、どの正規表現にも記号として拾われない。
 * 段落にしたあとで restoreEscapes が元の字に戻す
 */
const HOLD_BASE = 0xfdd0;
const HOLD_RE = /[﷐-﷯]/g;
const HAS_HOLD = /[﷐-﷯]/;

/**
 * Google でない .md で、前の `\` を外して「その字そのもの」にする記号。(2026-10-13 見直し)
 * **このアプリで構造や飾りになる字だけ**: 見出し `#`・引用と行末寄せ `>`・箇条書きと線 `- + * _`・強調 `* ~`・
 * 印 `==`・ルビと表 `|`・リンクと絵 `[ ] !`・タグ `< >`・コード `` ` ``・見出しの飛び先 `{ }`・`\` そのもの。
 * ほかの記号(`( ) / ^ : ; , ? @ $ % & ' " .` など)の前の `\` は、打ったまま刷る
 * (前の md.ts と .txt と同じ。顔文字の `\(^o^)/` や、パソコンの場所の `\` が消えないように)。
 * `.` と `)` は、行頭の数字のすぐあと(`1\.` = 番号つきの並びにしない)だけ外す
 */
const HOLD_PUNCT = '\\`*_~[]!|#><-+={}';

/**
 * 1行を左から読み、`\` + ASCII の記号を put(記号) に替える。**コード `…` の中は触らない**
 * (CommonMark でもコードの中の `\` は字のまま。Windows の場所や命令の例が入る)。
 * take を渡すと、take が false を返した `\` は字のまま残す
 */
function walkEscapes(line: string, put: (c: string) => string, take?: (c: string, at: number) => boolean): string {
  if (!line.includes('\\')) return line;
  let out = '';
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && ASCII_PUNCT.includes(line[i + 1])) {
      if (take && !take(line[i + 1], i)) {
        out += c;
        i++;
        continue;
      }
      out += put(line[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`') {
      // 同じ数の ` で閉じるところまでがコード(長さの違う ` の並びは飛ばす)。閉じなければ ` はただの字
      let n = 1;
      while (line[i + n] === '`') n++;
      const run = '`'.repeat(n);
      let j = line.indexOf(run, i + n);
      while (j >= 0 && line[j + n] === '`') {
        let k = j;
        while (line[k] === '`') k++;
        j = line.indexOf(run, k);
      }
      if (j >= 0) {
        out += line.slice(i, j + n);
        i = j + n;
        continue;
      }
      out += run;
      i += n;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** `\X` → `X`(Google の書き出しで、構造を見る前に) */
export function unescapeMarkdown(line: string): string {
  return walkEscapes(line, (c) => c);
}

/**
 * `\X` → 預け先の字(ほかの .md で。構造にも記法にも拾われないように)。
 * 預けるのは HOLD_PUNCT の字と、行頭の数字のすぐあとの `.` `)` だけ。ほかの `\` は字のまま
 */
export function holdEscapes(line: string): string {
  return walkEscapes(
    line,
    (c) => String.fromCharCode(HOLD_BASE + ASCII_PUNCT.indexOf(c)),
    (c, at) => HOLD_PUNCT.includes(c) || ((c === '.' || c === ')') && /^\s*\d{1,9}$/.test(line.slice(0, at))),
  );
}

/** 預けた字を元の記号に戻す(`\` は付けない) */
export function restoreEscapes(s: string): string {
  if (!HAS_HOLD.test(s)) return s;
  return s.replace(HOLD_RE, (c) => ASCII_PUNCT[c.charCodeAt(0) - HOLD_BASE]);
}

/** 原稿の中の字をすべて戻す(md.ts が章を組み終えたところで呼ぶ) */
export function restoreEscapesIn(chapters: Chapter[]): void {
  for (const ch of chapters) {
    ch.title = restoreEscapes(ch.title);
    if (ch.no !== undefined) ch.no = restoreEscapes(ch.no);
    for (const b of ch.blocks) {
      if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') b.text = restoreEscapes(b.text);
      else if (b.type === 'list') b.items = b.items.map(restoreEscapes);
    }
  }
}

// ---- Google ドキュメントの書き出しか ----

/** 見分けに使わない長さ(絵のデータなど。正規表現を長い行に当てない) */
const LONG_LINE = 20_000;

/** 見分けの手がかり(検査で、なぜそう見分けたかを見るため) */
export interface GoogleSignals {
  /** `[image1]: <data:image/…>` の定義があった */
  imageDef: boolean;
  /** `![][image1]` があった */
  imageRef: boolean;
  /** `https\://`(Google は自動のリンクを止めるために : を逃がす) */
  escapedScheme: boolean;
  /** `www\.` */
  escapedWww: boolean;
  /** Google の表の区切り行 `| :---- |`(`| ---- |` だけの行は数えない) */
  tableDelim: boolean;
  /** 見出しの ` {#…}` と、本文の `](#…)` の両方 */
  headingAnchor: boolean;
  /** ほかの道具が書かない逃がし(`\!`・`\~`・` \= `・` \- `・` \+ `・`\&字`・`\$`・行の途中の `\>`・`字\#`)の数 */
  oddEscapes: number;
  /** 見出しがどれも ** で包まれている */
  allHeadingsBold: boolean;
  /** 空の見出し `# ` がある */
  emptyHeading: boolean;
  /** 本文の行のうち、後ろに「  」があって次の行へ続く行の割合 */
  tightRatio: number;
  /** その行の数 */
  tightLines: number;
  /** 箇条書きの最後の項目だけ「  」が無い */
  listTrail: boolean;
  /** `\` + 記号がどこかにある */
  anyEscape: boolean;
}

/**
 * Google ドキュメントの［ダウンロード］→［Markdown］で書き出したものか。
 * (2026-10-13 に Google の書き出し 18 本を全部当て、ほかの道具の .md 217 本を1本も当てなかった見分け)
 *
 * - YAML の前付けがあれば Google ではない(Google は書かない。Obsidian や Web クリッパーが書く)。呼び出し側で先に見る
 * - 強い手がかり(1つで足りる): 絵の定義・`![][imageN]`・`https\://`・`www\.`・Google の表の区切り行(`| :---- |` のマスがあるもの)・
 *   見出しの `{#…}` と `](#…)`・ほかの道具が書かない逃がしが2つ以上
 * - 弱い手がかり: 逃がしがあって、そのうえで「見出しがどれも ** で包まれている」「空の見出し」
 *   「本文の3割以上(3行以上)の後ろに「  」(段落を詰めた文書)」「箇条書きの最後だけ「  」が無い」のどれか。
 *   または、段落を詰めた文書であって、そのうえで残りの3つのどれか(**詰めていることだけでは決めない**。
 *   行末の「  」は Markdown のふつうの改行で、詩や小説の .md にもある。2026-10-13 見直し)
 *
 * `lines` はコードブロックの中を除いた行。コード `…` の中は見ない(Windows の場所の `\` を逃がしと見ない)
 */
export function detectGoogleDocs(
  lines: readonly string[],
  imageDef = false,
): { google: boolean; signals: GoogleSignals } {
  const ls = lines
    .filter((l) => l.length < LONG_LINE)
    .map((l) => (l.includes('`') ? l.replace(/`[^`]*`/g, '``') : l));
  const some = (re: RegExp) => ls.some((l) => re.test(l));
  let odd = 0;
  for (const l of ls) {
    if (!l.includes('\\')) continue;
    odd += (l.match(/\\!(?!\[)|\\~|[ \t]\\=|[ \t]\\-[ \t]|[ \t]\\\+|\\&(?=\w)|\\\$|\w\\#/g) ?? []).length;
    // 行の途中の、空白のあとの \>(行頭の \> は書き手の打った引用の印で、ほかの道具も逃がす)
    const first = l.search(/[^\s\\]/);
    for (let p = l.indexOf('\\>'); p >= 0; p = l.indexOf('\\>', p + 2)) {
      if (p > 0 && (l[p - 1] === ' ' || l[p - 1] === '\t') && first >= 0 && first < p - 1) odd++;
    }
  }
  const heads = ls.filter((l) => /^#{1,6}[ \t]+\S/.test(l) && !/^#{1,6}[ \t]+(?:-{3,}|\*{3,})[ \t]*$/.test(l));
  const structural = /^\s*(?:#|[-*+] |\d+[.)] |\||>)/;
  let body = 0;
  let tight = 0;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (!/\S/.test(l) || structural.test(l)) continue;
    body++;
    if (/\S {2}$/.test(l) && i + 1 < ls.length && /\S/.test(ls[i + 1])) tight++;
  }
  const item = /^[ \t]*(?:[-*+]|\d+\.) \S/;
  const s: GoogleSignals = {
    imageDef,
    imageRef: some(/!\[\]\[image\d+\]/),
    escapedScheme: some(/[a-z]\\:\/\//i),
    escapedWww: some(/\bwww\\\./),
    // Google の形だけ: どのマスも `:----` のような 5字前後で、左寄せ(Google の既定)の `:----` のマスがある。
    // `| ---- | ---- |`(Typora・Prettier が短い列に書く。和文2字の見出しでちょうど 4字)は数えない(2026-10-13 見直し)
    tableDelim: ls.some((l) => /^\|(?: :?-{4,5}:? \|)+[ \t]*$/.test(l) && l.includes('| :---- |')),
    headingAnchor: some(/^#{1,6} .*\{#[^}]*\}[ \t]*$/) && some(/\]\(#[^)]+\)/),
    oddEscapes: odd,
    allHeadingsBold: heads.length > 0 && heads.every((h) => /^#{1,6} \*\*\S.*\*\*[ \t]*(?:\{#[^}]*\})?[ \t]*$/.test(h)),
    emptyHeading: some(/^#{1,6} [ \t]*$/),
    tightRatio: body ? Math.round((tight / body) * 100) / 100 : 0,
    tightLines: tight,
    listTrail: ls.some(
      (l, i) =>
        item.test(l) &&
        /\S {2}$/.test(l) &&
        i + 1 < ls.length &&
        item.test(ls[i + 1]) &&
        /\S$/.test(ls[i + 1]) &&
        (i + 2 >= ls.length || ls[i + 2] === ''),
    ),
    anyEscape: some(/\\[!-/:-@[-`{-~]/),
  };
  const strong =
    s.imageDef || s.imageRef || s.escapedScheme || s.escapedWww || s.tableDelim || s.headingAnchor || s.oddEscapes >= 2;
  const isTight = s.tightRatio >= 0.3 && tight >= 3;
  /** 段落を詰めていること以外の弱い手がかりの数 */
  const others = (s.allHeadingsBold ? 1 : 0) + (s.emptyHeading ? 1 : 0) + (s.listTrail ? 1 : 0);
  // **段落を詰めていることは、それだけでは決め手にしない。**(2026-10-13 見直し)
  // 前は「詰めた文書」が前提と弱い手がかりの両方に数えられ、行末に「  」(Markdown のふつうの改行)を
  // 打った詩や小説の .md が Google の書き出しにされ、段落のあいだの空行がすべて1行アキになった
  const google = strong || (s.anyEscape && others + (isTight ? 1 : 0) >= 1) || (isTight && others >= 1);
  return { google, signals: s };
}

/**
 * YAML の前付けの `key: 値` の行らしいか。キーには空白が入ってもよい(Obsidian の Linter の `date created:` など)。
 * `key:` のあとは空白か行の終わり(`https://…` のような字は前付けと見ない)
 */
const YAML_KEY_LINE = /^[^\s:#>*\-[{][^:]{0,60}:(?:[ \t]|$)/;

/**
 * 先頭の YAML の前付け(`---` で囲まれたメタデータ。Obsidian などが付ける)の閉じの `---` の行。無ければ -1。
 *
 * **中身が YAML らしいときだけ。** 前は先頭が `---` なら次の `---` までを黙って捨てていたので、
 * 横線で始まる原稿(Google ドキュメントの扉の横線など)は、扉の書名と著者名が消えた(2026-10-13 に確かめた)。
 * 前付けは `---` のすぐ次の行から書く。Google は横線の前後にかならず空行を書くので、次の行が空なら前付けではない。
 * そのうえで、`# 注釈` を除いた最初の行が `key: 値` の形なら前付けとみなす(2026-10-13 見直し)。
 * 前は全部の行が YAML らしいことを求めていて、キーに空白のある前付け(`date created: …`)や、
 * 行をまたぐ `tags: [` … `]` の前付けが本文に刷られた(前の md.ts は外していた)
 */
export function frontMatterEnd(lines: readonly (string | null)[]): number {
  if (lines[0]?.trim() !== '---' || !lines[1]?.trim()) return -1;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return -1;
  const first = lines.slice(1, end).find((l): l is string => l !== null && l.trim() !== '' && !/^#/.test(l));
  return first !== undefined && YAML_KEY_LINE.test(first) ? end : -1;
}

// ---- 絵 ----

/**
 * 絵のデータ(data URI)を受けるか。**受けるのは JPEG と PNG だけ**(1.2.0 から、利用者が選ぶ絵と同じ)。
 * 種類の名前(image/png など)と、中身の頭のバイト(PNG は 89 50 4E 47、JPEG は FF D8 FF)の両方で見る。
 * 名前と中身が食い違うときは、中身に合わせて名前を直す。受けないときは null
 */
export function acceptImageDataUri(uri: string): string | null {
  const m = /^data:(image\/[a-z0-9.+-]+)((?:;[a-z0-9.+-]+(?:=[^;,]*)?)*);base64,/i.exec(uri.slice(0, 300));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!/^image\/(?:png|jpe?g|pjpeg)$/.test(mime)) return null;
  const payload = uri.slice(m[0].length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  let kind: string;
  try {
    const head = payload.slice(0, Math.min(16, payload.length - (payload.length % 4)));
    const bin = atob(head);
    kind = sniffImage(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  if (kind !== 'png' && kind !== 'jpeg') return null;
  const want = kind === 'png' ? 'image/png' : 'image/jpeg';
  return m[1] === want ? uri : `data:${want}${m[2]};base64,${payload}`;
}

/** 参照の名前をそろえる(CommonMark では大文字小文字と空白の数を区別しない) */
const normId = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** 参照の定義の行 `[id]: 行き先`(行き先は <> で包んでもよい。後ろに題 "…" が付いてもよい) */
const DEF_RE = /^ {0,3}\[([^\]\n]{1,200})\]:[ \t]*(?:<([^>\n]*)>|(\S+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;

/** 絵を参照している名前(`![説明][id]`・`![id][]`)。定義の行を外してよいかを決めるのに使う */
const REF_SCAN = /!\[([^\]\n]*)\]\[([^\]\n]*)\]/g;

/**
 * 本文の中の絵の書き方。
 * 1. `![[ファイル.png]]`(Obsidian の絵の埋め込み。場所なので取れない)。**名前が絵のファイルのときだけ。**
 *    `![[第1章]]` はノートの埋め込み(章の中身を差し込む書き方)なので、絵として数えず字のまま残す
 *    (前の md.ts と同じ。紙面に字が出るので、抜けたことに気づける。2026-10-13 見直し)
 * 2. `![説明][id]`(参照。Google ドキュメントはいつもこれ)
 * 3. `![説明](行き先 "題")`(行き先が data: なら絵そのもの。ほかは場所か URL)
 * 4. `<img src="行き先" …>`(HTML の書き方。Typora は大きさを変えた絵をこう書く。行き先の見方は 3 と同じ。2026-10-13 見直し)
 */
const IMAGE_RE =
  /!\[\[([^\]\n|#]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff?))(?:[|#][^\]\n]*)?\]\]|!\[([^\]\n]*)\]\[([^\]\n]*)\]|!\[([^\]\n]*)\]\([ \t]*(?:<([^>\n]*)>|([^\s)]*))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)|<img\b[^>\n]*?\bsrc[ \t]*=[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'>]+))[^>\n]*>/gi;

/** 行に絵の書き方がありそうか(IMAGE_RE を当てる前の、安い見分け) */
const mayHaveImage = (s: string) => s.includes('![') || /<img\b/i.test(s);

// ---- 見出し ----

/**
 * 見出しの字から強調の印(`***` `**` `*…*` `~~`)を外す。
 * unpaired = true(Google の書き出し)なら、対になっていない ** と ~~ も外す(Google は太字を絵や飛び先の印で切るので、
 * 片方だけ残る)。**ほかの .md では対になったものだけ外す**(`# おまけ~~` の ~~ は書き手が打った字。2026-10-13 見直し)
 */
function stripEmphasis(t: string, unpaired: boolean): string {
  const s = t
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(^|[^*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, '$1$2');
  return unpaired ? s.replace(/\*\*|~~/g, '') : s;
}

/**
 * 見出しの字を整える。後ろの ` {#…}`(Google が付ける飛び先の名前)と閉じの `#`、`[字](#…)` の飛び先を外し、
 * 強調の印を外す(柱と目次と章の番号の読み取りに ** が混ざらないように)。
 * 本文の段落にする h4 以下は強調を残す(段落なら太字で組める)。google は stripEmphasis の unpaired
 */
function cleanHeading(t: string, keepEmphasis: boolean, google: boolean): string {
  let s = t
    .replace(/[ \t]*\{#[^}\n]*\}[ \t]*$/, '')
    .replace(/(?:^|[ \t]+)#+[ \t]*$/, '')
    .replace(/\[([^\]\n]+)\]\(#[^)\n]*\)/g, '$1');
  if (!keepEmphasis) s = stripEmphasis(s, google);
  return s.trim();
}

/**
 * 見出しの字が記号だけの線の形(`***`・`* * *`・`___`・`- - -`)か。
 * こう書いた見出しは、題の無い章の切れ目として打ったもの(前の md.ts は章にしていた)なので、字を崩さずに残す
 */
const isRuleText = (t: string) => /^(?:[-*_][ \t]*){3,}$/.test(t.trim());

/** 捨てる横線の見出し。**Google が見出しの中の横線を書く形 `# ---` だけ**(逃がしを外す前の行で見る。2026-10-13 見直し) */
const GOOGLE_RULE_HEADING = /^#{1,6}[ \t]+-{3,}[ \t]*$/;

// ---- 下ごしらえ ----

/** md.ts へ渡す1行 */
export type MdEntry =
  /** 行(構造はこれから md.ts が見る) */
  | { kind: 'line'; text: string }
  /** 整えた見出し(1 = 章、2〜3 = 小見出し、4〜6 = 本文の段落) */
  | { kind: 'heading'; level: number; text: string }
  /** コードブロックの中の行(そのまま段落にする) */
  | { kind: 'code'; text: string }
  /** 絵(受けた data URI) */
  | { kind: 'image'; src: string };

export interface PreparedMarkdown {
  entries: MdEntry[];
  /** Google ドキュメントの書き出しと見分けた */
  google: boolean;
  /** 段落のあいだを詰めた Google の文書(空行1つ = 1行アキ) */
  tight: boolean;
  signals?: GoogleSignals;
}

/** 中身の無い項目の行(`* `・`1. `) */
const EMPTY_ITEM = /^\s*(?:[-*+]|\d+[.)])[ \t]+$/;
/** 箇条書きの項目の行(中身が無くてもよい)。外した行(null)や原稿の端は項目ではない */
const isItemLine = (l: string | null | undefined): boolean => !!l && /^\s*(?:[-*+]|\d+[.)])[ \t]/.test(l);

const isBlankEntry = (e: MdEntry | null | undefined): boolean =>
  !!e && (e.kind === 'line' || e.kind === 'code') && !e.text.trim();

/** 構造を持たないふつうの段落の行か(段落の空きの見分けに使う) */
function isPlainLine(e: MdEntry | null | undefined): boolean {
  if (!e || e.kind !== 'line') return false;
  const t = e.text;
  return (
    !!t.trim() &&
    !detectListLine(t) &&
    !detectEndAlignLine(t) &&
    !detectQuoteLine(t) &&
    !/^\s*\|/.test(t) &&
    !/^\s*\[\^[^\]]+\]:/.test(t) &&
    !/^\s*(?:[-*_][ \t]*){3,}$/.test(t)
  );
}

/**
 * 外した行(null)を詰める。**外した行の前後が空行なら、空行を1つ減らす**
 * (md.ts は空行2つを1行アキと読むので、外した跡に空行2つを残さない)
 */
function compact(out: (MdEntry | null)[]): MdEntry[] {
  const kept: MdEntry[] = [];
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e) {
      kept.push(e);
      continue;
    }
    while (i + 1 < out.length && out[i + 1] === null) i++;
    const next = out[i + 1];
    if (kept.length && isBlankEntry(kept[kept.length - 1]) && (next === undefined || isBlankEntry(next))) i++;
  }
  return kept;
}

/**
 * Markdown の原稿を、md.ts が1行ずつ読める形にする。言っておくこと(取り込めなかった絵など)は notes に足す
 */
export function prepareMarkdown(source: string, notes: string[] = []): PreparedMarkdown {
  // 預け先の字が原稿に紛れていたら外す(戻すときに記号に化けないように)
  const text = HAS_HOLD.test(source) ? source.replace(HOLD_RE, '') : source;
  const lines: (string | null)[] = text.replace(/\r\n?/g, '\n').split('\n');

  // 1. 絵の定義を集めて、行ごと外す。data: の定義はいつも。場所・URL の定義は、絵が参照しているときだけ
  //    (ほかの定義は、和文の「[注1]: 説明」のような本文かもしれないので残す)
  const used = new Set<string>();
  for (const l of lines) {
    if (l === null || !l.includes('![')) continue;
    for (const m of l.matchAll(REF_SCAN)) used.add(normId(m[2] || m[1]));
  }
  const dataDefs = new Map<string, string>();
  const linkDefs = new Set<string>();
  let googleImageDef = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === null || !l.includes(']:') || !/^ {0,3}\[/.test(l)) continue;
    const m = DEF_RE.exec(l);
    if (!m || m[1].startsWith('^')) continue; // [^1]: は脚注
    const id = normId(m[1]);
    const dest = (m[2] ?? m[3] ?? '').trim();
    if (/^data:/i.test(dest)) {
      if (!dataDefs.has(id)) dataDefs.set(id, dest); // 同じ名前は最初の定義が勝つ(CommonMark)
      if (/^\[image\d+\]: <data:image\//.test(l.slice(0, 40))) googleImageDef = true;
      lines[i] = null;
    } else if (used.has(id)) {
      linkDefs.add(id);
      lines[i] = null;
    }
  }

  // 2. コードブロック(``` で囲んだところ)。印の行は捨て、中は字のまま段落にする。閉じていない ``` は印だけ捨てる
  //    閉じの印になれる行(` だけの行)を先に拾っておき、開きの印ごとに全部の行を見直さない(閉じない印が多くても遅くならない)
  const role: ('fence' | 'code' | undefined)[] = new Array(lines.length);
  const closers: number[] = [];
  lines.forEach((l, i) => {
    if (l !== null && /^ {0,3}`{3,}[ \t]*$/.test(l)) closers.push(i);
  });
  for (let i = 0, c = 0; i < lines.length; i++) {
    const l = lines[i];
    const open = l !== null ? /^ {0,3}(`{3,})[^`]*$/.exec(l) : null;
    if (!open) continue;
    role[i] = 'fence';
    while (c < closers.length && closers[c] <= i) c++;
    let k = c;
    while (k < closers.length && (lines[closers[k]] ?? '').trim().length < open[1].length) k++;
    if (k >= closers.length) continue;
    const close = closers[k];
    for (let j = i + 1; j < close; j++) role[j] = 'code';
    role[close] = 'fence';
    i = close;
  }

  // 3. YAML の前付けと、Google の書き出しの見分け(前付けがあれば Google ではない)
  const fmEnd = frontMatterEnd(lines);
  let google = false;
  let signals: GoogleSignals | undefined;
  if (fmEnd < 0) {
    const plain = lines.filter((l, i): l is string => l !== null && role[i] === undefined);
    const det = detectGoogleDocs(plain, googleImageDef);
    google = det.google;
    signals = det.signals;
  }

  // 4. 1行ずつ
  let accepted = 0;
  let badFormat = 0;
  let linked = 0;
  const seen = new Map<string, string | null>();
  const acceptOnce = (uri: string): MdEntry | null => {
    let src = seen.get(uri);
    if (src === undefined) {
      src = acceptImageDataUri(uri);
      seen.set(uri, src);
    }
    if (src) {
      accepted++;
      return { kind: 'image', src };
    }
    badFormat++;
    return null;
  };
  /** 見つけた絵の書き方を、絵のブロックにする。取れないもの・名前の無い参照は null */
  const resolve = (m: RegExpMatchArray): MdEntry | null => {
    if (m[1] !== undefined) {
      linked++;
      return null;
    }
    if (m[3] !== undefined) {
      const id = normId(m[3] || m[2]);
      const uri = dataDefs.get(id);
      if (uri !== undefined) return acceptOnce(uri);
      if (linkDefs.has(id)) linked++;
      return null; // 定義の無い参照は捨てる(書き出しの途中で切れたものなど)
    }
    // m[5]・m[6] は ![説明](行き先)、m[7]〜m[9] は <img src="行き先">
    const dest = (m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9] ?? '').trim();
    if (!dest) return null;
    if (/^data:/i.test(dest)) return acceptOnce(dest);
    linked++;
    return null;
  };
  /** 字を絵の書き方で切り分ける。pieces は絵のあいだの字(絵の数 + 1)、imgs は絵(取れないものは null) */
  const splitImages = (s: string): { pieces: string[]; imgs: (MdEntry | null)[] } => {
    const pieces: string[] = [];
    const imgs: (MdEntry | null)[] = [];
    let pos = 0;
    for (const m of s.matchAll(IMAGE_RE)) {
      const at = m.index ?? 0;
      pieces.push(s.slice(pos, at));
      imgs.push(resolve(m));
      pos = at + m[0].length;
    }
    pieces.push(s.slice(pos));
    // リンクで包んだ絵 `[![](絵)](飛び先)`(Web クリップに多い)は、包みのリンクごと外す
    for (let k = 0; k + 1 < pieces.length; k++) {
      const wrap = /^\]\([^)\s]*(?:[ \t]+"[^"\n]*")?[ \t]*\)/.exec(pieces[k + 1].trimStart());
      if (wrap && /\[[ \t]*$/.test(pieces[k])) {
        pieces[k] = pieces[k].replace(/\[[ \t]*$/, '');
        pieces[k + 1] = pieces[k + 1].trimStart().slice(wrap[0].length);
      }
    }
    return { pieces, imgs };
  };

  const out: (MdEntry | null)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === null || i <= fmEnd || role[i] === 'fence') {
      out.push(null);
      continue;
    }
    if (role[i] === 'code') {
      out.push({ kind: 'code', text: raw });
      continue;
    }
    // U+000B は Google の表のマスの中の改行
    let line = raw.includes('\u000b') ? raw.replace(/\u000b/g, ' ') : raw;
    line = google ? unescapeMarkdown(line) : holdEscapes(line);

    // 見出し。中の絵は見出しのすぐあとへ。空の見出しと、Google の横線の見出し `# ---` は捨てる
    // # のあとは全角空白でもよい(前の md.ts と同じ。日本語入力のまま打つと全角になる)
    const h = /^(#{1,6})(?:\s+(.*))?$/.exec(line);
    if (h) {
      if (GOOGLE_RULE_HEADING.test(raw)) {
        out.push(null);
        continue;
      }
      const level = h[1].length;
      let body = h[2] ?? '';
      let imgs: MdEntry[] = [];
      if (mayHaveImage(body)) {
        const split = splitImages(body);
        body = split.pieces.join('');
        imgs = split.imgs.filter((e): e is MdEntry => e !== null);
      }
      // `# ***`・`# * * *` のような記号だけの見出しは、強調の印として崩さず、そのまま題にする(章の切れ目を残す。2026-10-13 見直し)
      const bare = cleanHeading(body, true, google);
      const t = isRuleText(bare) ? bare : cleanHeading(body, level >= 4, google);
      if (t) out.push({ kind: 'heading', level, text: t });
      else if (!imgs.length) out.push(null);
      out.push(...imgs);
      continue;
    }
    // 目次(Google の青いリンクの目次は `[見出し](#飛び先)` だけの行)。このアプリは目次を自分で組むので捨てる
    if (line.includes('](#')) {
      if (/^\s*(?:\[[^\]\n]+\]\(#[^)\n]*\)\s*)+$/.test(line)) {
        out.push(null);
        continue;
      }
      line = line.replace(/\[([^\]\n]+)\]\(#[^)\n]*\)/g, '$1');
    }
    // `> > ` の入れ子は1段の引用に。`>>`(空白なし)は行末寄せの印なので触らない。
    // 入れ子の中の箇条書き `> > * 項目`(Google が深く字下げした箇条書きをこう書く)は、ふつうの項目に
    const nest = /^(\s*)>(?:[ \t]+>)+/.exec(line);
    if (nest) {
      line = `${nest[1]}>${line.slice(nest[0].length)}`;
      if (/^\s*>[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/.test(line)) line = line.replace(/^\s*>[ \t]*/, '');
    }
    // チェックボックス `- [ ] ` `- [x] ` は印だけ外す。空の項目(`* ` の行)は、箇条書きの中(前か後ろの行も項目)と、
    // Google の書き出しが書いた空の項目(逃がしの無い `* `)だけ捨てる。
    // 空行に挟まれた `* ` は、場面転換の印かもしれないので残す(後ろの空白は目に見えないので、`*` だけの行と同じに扱う。
    // Obsidian などは行末の空白を残す。2026-10-13 見直し)
    line = line.replace(/^(\s*[-*+][ \t]+)\[[ xX]\](?=[ \t]|$)[ \t]?/, '$1');
    if (EMPTY_ITEM.test(line) && (isItemLine(lines[i - 1]) || isItemLine(lines[i + 1]) || (google && EMPTY_ITEM.test(raw)))) {
      out.push(null);
      continue;
    }
    // 項目の中の見出し `- ## 議題` は、ふつうの項目に
    line = line.replace(/^(\s*(?:[-*+]|\d+[.)])[ \t]+)#{1,6}[ \t]+/, '$1');

    // 絵。前後の字は別々の段落に分ける。絵をはさんで切れた ** と ~~ は、切れ目で閉じて開き直す
    if (mayHaveImage(line)) {
      const lead = /^\s*(?:[-*+][ \t]+|\d+[.)][ \t]+|[>＞]{1,2}[ \t　]?)/.exec(line)?.[0] ?? '';
      const split = splitImages(line.slice(lead.length));
      // 取れない絵(場所・URL・読めない絵・定義の無い参照)は外すだけで、文は切らない
      // (`この![](icon.png)ボタンを押すと…` を1つの段落のままにする。前の md.ts と同じ。2026-10-13 見直し)
      const pieces = [split.pieces[0]];
      const imgs: MdEntry[] = [];
      split.imgs.forEach((img, k) => {
        if (img) {
          imgs.push(img);
          pieces.push(split.pieces[k + 1]);
        } else {
          pieces[pieces.length - 1] += split.pieces[k + 1];
        }
      });
      if (split.imgs.length && !imgs.length) {
        // 取れない絵だけだった。字が残らない(か、印だけが残った)行は、外した行として扱う(跡に空行2つを残さない)
        const rest = pieces[0].trim();
        if (!rest || /^[*_~]+$/.test(rest)) {
          out.push(null);
          continue;
        }
        line = lead + pieces[0];
      } else if (imgs.length) {
        let bold = false;
        let strike = false;
        pieces.forEach((piece, k) => {
          const pre = (bold ? '**' : '') + (strike ? '~~' : '');
          for (const t of piece.matchAll(/\*\*|~~/g)) {
            if (t[0] === '**') bold = !bold;
            else strike = !strike;
          }
          const post = (strike ? '~~' : '') + (bold ? '**' : '');
          const core = piece.trim();
          // 印だけが残ったかけら(`**![][image3]**` の両側の ** など)は捨てる
          if (core && !/^[*_~]+$/.test(core)) {
            const tail = /[ \t]*$/.exec(piece)?.[0] ?? '';
            out.push({ kind: 'line', text: `${k === 0 ? lead : ''}${pre}${core}${post}${tail}` });
          }
          const img = imgs[k];
          if (img) out.push(img);
        });
        continue;
      }
    }
    out.push({ kind: 'line', text: line });
  }

  let entries = compact(out);

  // 5. Google の段落の空き。段落のあいだを詰めた文書では、段落は「  」+改行でつながり、
  //    書き手の空の段落(いくつ続いても)が空行1つになる。これを1行アキに読む(md.ts は空行2つで1行アキ)。
  //    段落のあいだを空けた文書では、空行1つはただの段落の切れ目(書き手の空の段落は書き出しに残らない)
  let tight = false;
  if (google) {
    let tightPairs = 0;
    let spacedPairs = 0;
    for (let i = 0; i + 1 < entries.length; i++) {
      const e = entries[i];
      if (!isPlainLine(e)) continue;
      if (isPlainLine(entries[i + 1]) && / {2}$/.test((e as { text: string }).text)) tightPairs++;
      else if (isBlankEntry(entries[i + 1]) && isPlainLine(entries[i + 2])) spacedPairs++;
    }
    tight = tightPairs > spacedPairs;
    if (tight) {
      const doubled: MdEntry[] = [];
      entries.forEach((e, i) => {
        doubled.push(e);
        if (isBlankEntry(e) && isPlainLine(entries[i - 1]) && isPlainLine(entries[i + 1])) doubled.push({ kind: 'line', text: '' });
      });
      entries = doubled;
    }
  }

  if (badFormat) notes.push(mdImageFormatNote(badFormat));
  if (linked) notes.push(mdImageLinkedNote(linked));
  // Google の書き出しと見分けたら、絵が無くても Word(.docx)をすすめる(絵を取り込んだときは、きめの話も同じ1つの文で)
  if (google) notes.push(gdocsMdNote(accepted));
  return { entries, google, tight, signals };
}
