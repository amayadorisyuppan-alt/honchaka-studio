// 原稿を組版へ渡す前の見張り。(2026-10-13 Google ドキュメントの Markdown で本が止まった件)
//
// ## なぜ在るか
//
// Google ドキュメントの［ファイル］→［ダウンロード］→［Markdown（.md）］で書き出した原稿を取り込むと、
// 本に貼った絵が `[image1]: <data:image/png;base64,…>` という 146万字の1行になって末尾に付いてくる。
// これが「あとがき」の1段落として組版に渡り、紙面ができあがるまで 75〜80 分かかる見込みになった
// (2026-10-13 実測。本番の組み・Core i9 で 1ページ 2.9 秒、画面は 2〜7 秒ずつ固まる)。
// 取り込みの 0.8 秒後には自動保存がその段落を書くので、開き直しても同じところで止まる。
//
// 重いのは Vivliostyle の組版の中で、アプリの側からは止められない(固まっているあいだは時計も動かない)。
// だから**組版に渡す前に**、ここで取り除くか断る:
//
// 1. 字に置き換えた画像などのデータ(data URI と、base64 らしい長い英数字の並び)は、本文から取り除いて知らせる
// 2. 取り除いたあと、5万字以上の段落があれば取り込まない(改行が抜けたファイル)
// 3. 原稿全体が100万字以上なら取り込まない(1冊に収まらない)。30万字以上なら、組版に数分かかると知らせる
//
// - .txt / .md / .docx のどれにも当てる(importers/load.ts の parseSource。取り込みと［原稿を組み直す］の両方が通る)
// - 保存の .json と自動保存から開くときは、1 の取り除きだけを当てる(project/file.ts の sanitize)。
//   すでに自動保存に残っている本を開けるようにするため。長いだけの本物の段落は、そちらでは断らない・切らない。
//   2 と 3 に当たる本は、開くときに知らせる(sizeNoticeOnOpen。どの章のどんな段落か、どう直すか。2026-10-13 見直し)
// - 原稿全体の字数には、本に残っているコラムページも入れる(取り込み直しても消えずに組まれるので。入口の画面の「◯字」と同じ)
//
// ここは画面の部品にも mammoth にも触らない(単体の検査 scripts/importGuard.test.ts で回す)。
// 利用者に出す文は、あとで言い回しを直せるように名前を付けて下にまとめてある。

import { countBodyChars, type Block, type Chapter, type ColumnPage, type ImageBlock, type Manuscript } from '../models/project';
import { plainText } from '../models/inlineImages';

// ---- しきい値(2026-10-13 実測。本番の組み・Chrome・Core i9・文庫の縦組み) ----

/**
 * 1つの段落(小見出し・引用・箇条書きの1項目・章の題も)の字数の上限。**これ以上の段落があれば取り込まない。**
 *
 * 改行のない日本語の段落は、2万字で 16 秒・6万字で 42 秒・10万字で 94 秒と 2.5GB。
 * 段落が長いほど1ページの手間が増える(200字の段落で 0.07 秒 → 1千字 0.15 秒 → 5千字 0.46 秒 → 1万5千字から 0.55 秒)。
 * 5万字は文庫で約 80 ページぶん改行が無いことになり、ほぼ確実に改行の抜けたファイル。
 * ここでも 35〜40 秒かかり、4倍遅いパソコンなら 2 分半かかる
 */
export const MAX_BLOCK_CHARS = 50_000;

/**
 * 原稿全体の字数の上限。**これ以上は取り込まない。**
 *
 * ふつうの段落で 60万字は、1回目の組版に 130 秒(1,238 ページ)、ノドの組み直しの2回目は 4 分たっても終わらず、
 * 画面が 4.5 秒ずつ固まる。100万字は 2,000 ページを超え、10 分以上かかる見込みで、1冊の本として刷れる量を超えている
 */
export const MAX_TOTAL_CHARS = 1_000_000;

/**
 * 「組版に数分かかる」と知らせる字数。
 * 10万字で 15 秒、30万字はノドの組み直しまで入れて約 3 分(716 ページ・タブが 2.6GB)
 */
export const SLOW_TOTAL_CHARS = 300_000;

/**
 * base64 らしい英数字の並びとみなす長さ。**これ以上つづく [A-Za-z0-9+/=] の並びで、英大文字・小文字・数字を
 * どれも含むもの**を取り除く。
 *
 * base64 の並びは、日本語の長い段落と同じくらい組版が重い(1ページ 0.4〜0.6 秒。30万字を超えると画面が数秒ずつ固まる)うえ、
 * 1万字で意味のない字が 13 ページ刷られる。本物の文と URL は、この長さでこの字だけが続くことはない
 * (英文は空白で、URL は . ? & % : で切れる。顔文字は記号で切れる。「wwww」「8888」は大文字や数字が混ざらない)
 */
export const BASE64_RUN_MIN = 2_000;

/**
 * 空白も和文も挟まずにつづく ASCII の字(記号を含む)を、データとみなす長さ。**これ以上の並びは字の種類を問わず取り除く。**
 * (2026-10-13 見直し。16進の並びや、base64 の変種(`-` `_` を使うもの)は BASE64_RUN_MIN の見分けに掛からず、
 * 5万字の手前まで黙って組版に渡っていた。1ページ 0.4〜0.6 秒かかり、意味のない字が何十ページも刷られる)。
 * 本物の文は1万字も空白なしではつづかない(英文は空白で、和文は和文の字で切れる。URL もこの長さにはならない)
 */
export const ASCII_RUN_MIN = 10_000;

/**
 * 包みの無い data URI(`data:…;base64,中身`・`<data:…>`)を取り除く中身の長さ。**これより短いものは残す。**
 * (2026-10-13 見直し。本の中の説明の例 `data:text/plain;base64,SGVsbG8=` まで消していた。
 * 短いものは組版を重くしない。絵として書いた `![…](data:…)`・`[id]: <data:…>` は長さを問わず取り除く)
 */
export const DATA_URI_BARE_MIN = 256;

/**
 * 行に分けた base64(メールの添付のように 76字ずつなどで折り返したもの)とみなす、1行の長さの範囲と、合わせた長さの下限。
 * 1行ずつは短いので上の見分けに掛からず、.txt では何千もの段落になって組版に渡っていた(2026-10-13 見直し)
 */
const WRAPPED_LINE_MIN = 40;
const WRAPPED_LINE_MAX = 120;

// ---- 利用者に出す文 ----

/** 字数を「5万字」「5.2万字」「146万字」の形で言う(1万字より少なければ「9,999字」) */
export function formatChars(n: number): string {
  if (n < 10_000) return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}字`;
  if (n < 100_000) {
    // 1千字の位まで(切り捨て)。ちょうどの万は小数を付けない
    const tenths = Math.floor(n / 1_000);
    return `${tenths % 10 ? (tenths / 10).toFixed(1) : tenths / 10}万字`;
  }
  return `${Math.floor(n / 10_000)}万字`;
}

/** 取り込みで、字に置き換えた画像などのデータを本文から外したとき */
export const dataBlobsRemovedNote = (n: number): string =>
  `原稿の中に、画像などのデータを英数字の列に置き換えたものが ${n}か所ありました。` +
  '紙面に刷るものではないので、本文から取り除いて取り込みました';

/**
 * 保存の .json・自動保存から開いたときに、同じものを外したとき(project/file.ts の sanitize)。
 * canReparse = 取り込んだ .md が本に残っている。［原稿を組み直す］で読み直せば、いまの取り込み方で
 * 絵が絵として入り、見出しの ** や \ も直る(2026-10-13 に止まった本はこの形。見直しで足した)
 */
export const dataBlobsRemovedOnOpenNotice = (n: number, canReparse = false): string =>
  `本文の中にあった、画像などのデータを英数字の列に置き換えたもの ${n}か所を取り除きました` +
  '（そのままでは紙面ができあがらないため）' +
  (canReparse
    ? '。取り込んだ原稿ファイルから画像を入れ直すには、最初の画面の［原稿を組み直す］を押してください'
    : '');

/*
 * 下の4つの文(longBlockOnOpenNotice・tooLongOnOpenNotice・longBlockError・tooLongError)は、
 * 2026-10-13 に言い回しを見直した(見直し済みの文をそのまま入れた)。
 * 「改行が抜けているようです」と決めつけず「入っていない可能性があります」と言う。「取り込みませんでした」は
 * 「取り込めませんでした」(できないことを言う)。「◯より少ない量まで」は「◯未満」。開くときの知らせは「画面が止まります」と
 * 言い切らず「画面の動きが遅くなる」と言い、直すことは「おすすめします」にとどめた(開くのは止めていないので)
 */

/**
 * 保存の .json・自動保存から開いた本に、組版が止まるほど長い段落があるとき(project/file.ts の sanitize)。
 * 開くのは止めない(止めると本そのものが開けなくなる)。where は「「あとがき」の章」「原稿」など
 */
export const longBlockOnOpenNotice = (where: string, chars: number): string =>
  `${where}に、${formatChars(chars)}つづく段落があります（改行が入っていない可能性があります）。` +
  '紙面ができあがるまで時間がかかり、そのあいだ画面の動きが遅くなることがあります。' +
  '元の原稿の改行を直してから、最初の画面で取り込み直すことをおすすめします';

/** 保存の .json・自動保存から開いた本が、1冊に組める量を超えているとき(開くのは止めない) */
export const tooLongOnOpenNotice = (chars: number): string =>
  `この本は${formatChars(chars)}あります。1冊の本として組めるのは${formatChars(MAX_TOTAL_CHARS)}未満です。` +
  'このままでは紙面ができあがるまでとても時間がかかり、そのあいだ画面の動きが遅くなります。' +
  '何冊かに分けて、1冊ずつ取り込み直すことをおすすめします';

/** 5万字以上の段落があって断るとき。where は「「あとがき」の章」「原稿」など */
export const longBlockError = (where: string, chars: number): string =>
  `${where}に、${formatChars(chars)}つづく段落があります（改行が入っていない可能性があります）。` +
  `1つの段落が${formatChars(MAX_BLOCK_CHARS)}以上あると紙面を組めないため、取り込めませんでした。` +
  '元の原稿の改行を確かめてから、もう一度取り込んでください';

/**
 * 字数を言うときの主語。本に残っているコラムページも数に入れたときは、そう言う
 * (入口の画面の「◯字」と同じ数え方。2026-10-13 見直し)
 */
const amountOf = (withColumns: boolean) => (withColumns ? '原稿とコラムページを合わせて' : '原稿が');

/** 原稿全体が多すぎて断るとき。withColumns = 本に残っているコラムページも数に入れた(2026-10-13 言い回しを見直した。longBlockOnOpenNotice の前の注) */
export const tooLongError = (chars: number, withColumns = false): string =>
  `${amountOf(withColumns)}${formatChars(chars)}あります。1冊の本として組めるのは${formatChars(MAX_TOTAL_CHARS)}未満のため、` +
  '取り込めませんでした。何冊かに分けて、1冊ずつ取り込んでください';

/** 原稿が多くて、組版に時間がかかるとき */
export const slowTypesetNote = (chars: number, withColumns = false): string =>
  `${amountOf(withColumns)}${formatChars(chars)}あります。分量が多いので、紙面ができあがるまで数分かかることがあります` +
  '（そのあいだは画面の動きが遅くなります）';

// ---- 取り除き ----

/** data URI の頭。`data:種類/形式[;引数…];base64,` */
const DATA_URI_HEAD = String.raw`data:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+(?:=[^;,\s<>()"']*)?)*;base64,`;
/** data URI の本体(中身は1字から。中身が空のものは文の中の説明かもしれないので残す)。絵として書いたものに使う */
const DATA_URI_CORE = String.raw`${DATA_URI_HEAD}[A-Za-z0-9+/=]+`;
/**
 * 中身の長い data URI(DATA_URI_BARE_MIN 字から)。包みの無いもの・絵でない包みに使う。
 * 後ろに base64 の字が続かないことを確かめておく(146万字の中身の途中まで戻って、包みの残りを探し直さない)
 */
const DATA_URI_LONG = String.raw`${DATA_URI_HEAD}[A-Za-z0-9+/=]{${DATA_URI_BARE_MIN},}(?![A-Za-z0-9+/=])`;

/**
 * data URI と、それを包む書き方。**包みごと**取り除く(包みだけ紙面に残さない)。
 * 同じ位置から始まるものは前に書いたほうが勝つので、包みを先に並べる
 */
const DATA_URI_RE = new RegExp(
  [
    // ![説明](data:…)・![説明](<data:…> "題")
    String.raw`!\[[^\]\n]{0,500}\]\([ \t]*<?${DATA_URI_CORE}>?(?:[ \t]+"[^"\n]{0,500}")?[ \t]*\)`,
    // [image1]: <data:…>(参照の定義。Google ドキュメントの Markdown が末尾に付ける)
    String.raw`\[[^\]\n]{1,200}\]:[ \t]*<?${DATA_URI_CORE}>?(?:[ \t]+"[^"\n]{0,500}")?`,
    // <img src="data:…" …>(HTML の絵。タグごと取り除く。前は中身だけ取って `<img src="">` が紙面に残った。2026-10-13 見直し)
    String.raw`<img\b[^>\n]{0,500}?\bsrc[ \t]*=[ \t]*["']?${DATA_URI_LONG}["']?[^>\n]{0,500}>`,
    // [字](data:…)(絵でないデータへのリンク。前は `[添付]()` が残った)
    String.raw`\[[^\]\n]{0,500}\]\([ \t]*<?${DATA_URI_LONG}>?(?:[ \t]+"[^"\n]{0,500}")?[ \t]*\)`,
    `<${DATA_URI_LONG}>`,
    DATA_URI_LONG,
  ].join('|'),
  'gi',
);

/**
 * base64 に使う字のひとつづき。長さと字の混ざり方は見つけてから確かめる
 * (`{2000,}` で探すと、短い並びのたびに1字ずつずらして数え直すので、長い原稿で遅くなる)。
 * `-` と `_` は base64 の変種(URL 用)の字(2026-10-13 見直しで足した)
 */
const B64_CHARS_RE = /[A-Za-z0-9+/=_-]+/g;
const looksBase64 = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
/** 空白を挟まない ASCII の字(記号を含む)のひとつづき(ASCII_RUN_MIN) */
const ASCII_CHARS_RE = /[!-~]+/g;

/** 行に分けた base64 の1行らしいか(WRAPPED_LINE_MIN〜MAX 字の base64 の字だけ。最後の行は短くてよいので長さは別に見る) */
const WRAPPED_RE = new RegExp(`^[A-Za-z0-9+/]{1,${WRAPPED_LINE_MAX}}={0,2}$`);

/**
 * 行に分けた base64 のつづき(添付ファイルのように、同じ長さの行で折り返したもの)を探す。
 * 返すのは [始めの行, 終わりの行の次] の並び。
 * - WRAPPED_LINE_MIN〜MAX 字の、同じ長さの行がつづき、最後の1行だけはそれより短くてよい
 * - つないだ字が BASE64_RUN_MIN 字以上で、英大文字・小文字・数字をどれも含む
 * 行は空白の前後を落として見る(段落の頭の字下げなど)
 */
export function wrappedBase64Runs(lines: readonly string[]): [number, number][] {
  const runs: [number, number][] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i].trim();
    const width = first.length;
    if (width < WRAPPED_LINE_MIN || width > WRAPPED_LINE_MAX || !WRAPPED_RE.test(first) || first.endsWith('=')) {
      i++;
      continue;
    }
    let k = i + 1;
    while (k < lines.length) {
      const l = lines[k].trim();
      if (l.length !== width || !WRAPPED_RE.test(l) || l.endsWith('=')) break;
      k++;
    }
    // 最後の1行(短いか、= で終わる)
    let j = k;
    if (j < lines.length) {
      const l = lines[j].trim();
      if (l.length > 0 && l.length <= width && WRAPPED_RE.test(l)) j++;
    }
    const joined = lines.slice(i, j).map((l) => l.trim()).join('');
    if (j - i >= 2 && joined.length >= BASE64_RUN_MIN && looksBase64(joined)) {
      runs.push([i, j]);
      i = j;
    } else {
      // 同じ長さの行の途中から始め直しても、短くなるだけで当たらない
      i = k;
    }
  }
  return runs;
}

const isBlank = (c: string | undefined) => c === ' ' || c === '\t';

/**
 * 1行から、指定の範囲を切り取る。範囲のまわりの半角空白もいっしょに取り、
 * 前後に字が残るときだけ半角空白1つでつなぐ(もとが空白で区切られていたときだけ。和文の「前の文![](…)後の文」は詰める)
 */
function cut(line: string, ranges: [number, number][]): string {
  let out = '';
  let pos = 0;
  let touchedEnd = false;
  for (const [start, end] of ranges) {
    let a = start;
    while (a > pos && isBlank(line[a - 1])) a--;
    let b = end;
    while (b < line.length && isBlank(line[b])) b++;
    out += line.slice(pos, a);
    const spaced = a < start || b > end;
    if (b >= line.length) touchedEnd = true;
    else if (spaced && out !== '' && !isBlank(out[out.length - 1])) out += ' ';
    pos = b;
  }
  out += line.slice(pos);
  return touchedEnd ? out.replace(/[ \t]+$/, '') : out;
}

function stripLine(line: string): { text: string; removed: number } {
  let text = line;
  let removed = 0;
  if (/data:/i.test(text)) {
    const ranges: [number, number][] = [];
    DATA_URI_RE.lastIndex = 0;
    for (let m = DATA_URI_RE.exec(text); m; m = DATA_URI_RE.exec(text)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
    if (ranges.length) {
      text = cut(text, ranges);
      removed += ranges.length;
    }
  }
  if (text.length >= BASE64_RUN_MIN) {
    const ranges: [number, number][] = [];
    B64_CHARS_RE.lastIndex = 0;
    for (let m = B64_CHARS_RE.exec(text); m; m = B64_CHARS_RE.exec(text)) {
      if (m[0].length >= BASE64_RUN_MIN && looksBase64(m[0])) ranges.push([m.index, m.index + m[0].length]);
    }
    if (ranges.length) {
      text = cut(text, ranges);
      removed += ranges.length;
    }
  }
  // 字の種類を問わず、空白なしで1万字以上つづく ASCII の並び(16進など。ASCII_RUN_MIN)
  if (text.length >= ASCII_RUN_MIN) {
    const ranges: [number, number][] = [];
    ASCII_CHARS_RE.lastIndex = 0;
    for (let m = ASCII_CHARS_RE.exec(text); m; m = ASCII_CHARS_RE.exec(text)) {
      if (m[0].length >= ASCII_RUN_MIN) ranges.push([m.index, m.index + m[0].length]);
    }
    if (ranges.length) {
      text = cut(text, ranges);
      removed += ranges.length;
    }
  }
  return { text, removed };
}

/**
 * 字に置き換えた画像などのデータを、文から取り除く。取り除いた数も返す。
 *
 * - `data:種類/形式;base64,中身`。絵として書いたもの(`![…](…)`・参照の定義 `[id]: `)は長さを問わず包みごと。
 *   包みの無いもの・`<…>`・`<img src="…">`・`[字](…)` は、中身が DATA_URI_BARE_MIN 字以上のときだけ包みごと
 *   (本の中の説明の短い例は残す)
 * - 2,000字以上つづく base64 の字の並び(`-` `_` の変種も)で、英大文字・小文字・数字をどれも含むもの(BASE64_RUN_MIN)
 * - 空白なしで1万字以上つづく ASCII の並び(16進など。ASCII_RUN_MIN)
 * - 同じ長さの行に折り返した base64 のつづき(wrappedBase64Runs。まとめて1か所)
 *
 * 取り除いた跡の空白は詰める。データだけの行は行ごと消し、空行が2つ並んで残らないようにする
 * (コラムページの本文は空行で段落を分けるので、段落の区切りを増やさない)
 */
export function stripDataBlobs(text: string): { text: string; removed: number } {
  if (typeof text !== 'string') return { text, removed: 0 };
  // ほとんどの文はここで帰る(短くて data: を含まない)
  if (text.length < BASE64_RUN_MIN && !/data:/i.test(text)) return { text, removed: 0 };
  const lines = text.split('\n');
  // 行に分けた base64(wrappedBase64Runs)は、つづきの行をまとめて1か所と数え、どの行もデータだけの行として消す
  const runs = lines.length > 1 ? wrappedBase64Runs(lines) : [];
  let run = 0;
  const out: string[] = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    while (run < runs.length && runs[run][1] <= i) run++;
    const inRun = run < runs.length && runs[run][0] <= i;
    const r = inRun ? { text: '', removed: i === runs[run][0] ? 1 : 0 } : stripLine(lines[i]);
    removed += r.removed;
    if ((inRun || r.removed) && !r.text.trim()) {
      // データだけの行。前後が空行(か文の端)なら、空行を1つ減らして区切りを1つにする
      const prevBlank = out.length === 0 || !out[out.length - 1].trim();
      const next = lines[i + 1];
      if (prevBlank && next !== undefined && !next.trim()) i++;
      else if (next === undefined && out.length > 0 && !out[out.length - 1].trim()) out.pop();
      continue;
    }
    out.push(r.text);
  }
  return removed ? { text: out.join('\n'), removed } : { text, removed: 0 };
}

/** 1つのブロックの字から取り除く。**字が空になったブロックは null**(画像は字が空でも残す。絵そのものは src にある) */
function stripBlock(b: Block): { block: Block | null; removed: number } {
  if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') {
    const r = stripDataBlobs(b.text);
    if (!r.removed) return { block: b, removed: 0 };
    return { block: r.text.trim() ? { ...b, text: r.text } : null, removed: r.removed };
  }
  if (b.type === 'list') {
    let removed = 0;
    const items: string[] = [];
    for (const item of b.items) {
      const r = stripDataBlobs(item);
      removed += r.removed;
      // データだけだった項目は外す(もとから空の項目には触らない)
      if (r.removed && !r.text.trim()) continue;
      items.push(r.text);
    }
    if (!removed) return { block: b, removed: 0 };
    return { block: items.length ? { ...b, items } : null, removed };
  }
  if (b.type === 'image') {
    let removed = 0;
    let out: ImageBlock = b;
    for (const f of ['alt', 'caption'] as const) {
      const v = b[f];
      if (typeof v !== 'string') continue;
      const r = stripDataBlobs(v);
      if (!r.removed) continue;
      removed += r.removed;
      const next: ImageBlock = { ...out };
      if (r.text.trim()) next[f] = r.text;
      else delete next[f];
      out = next;
    }
    return { block: out, removed };
  }
  return { block: b, removed: 0 };
}

/**
 * 章の中のブロックから取り除く。字が空になったブロックは外す。
 * 外したブロックが場面転換の1行アキに挟まれていたら、アキを1つにする(章の頭と終わりにはアキを残さない)
 */
export function stripBlockBlobs(blocks: Block[]): { blocks: Block[]; removed: number } {
  const cleaned = blocks.map(stripBlock);
  // 行に分けた base64 が、1行ずつの段落になったもの(.txt と .md は改行で段落を分ける)。つづきをまとめて1か所と数える
  const texts = blocks.map((b) => (b.type === 'p' && typeof b.text === 'string' && !b.text.includes('\n') ? b.text : ''));
  for (const [a, z] of wrappedBase64Runs(texts)) {
    for (let k = a; k < z; k++) cleaned[k] = { block: null, removed: k === a ? 1 : 0 };
  }
  const removed = cleaned.reduce((n, c) => n + c.removed, 0);
  if (!removed) return { blocks, removed: 0 };
  const out: Block[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const b = cleaned[i].block;
    if (b) {
      out.push(b);
      i++;
      continue;
    }
    let j = i;
    while (j < cleaned.length && !cleaned[j].block) j++;
    const prev = out[out.length - 1];
    const next = j < cleaned.length ? cleaned[j].block : null;
    if ((!prev || prev.type === 'space') && next?.type === 'space') j++;
    else if (!next && prev?.type === 'space') out.pop();
    i = j;
  }
  return { blocks: out, removed };
}

/** 章の題・番号とブロックから取り除く。**章は外さない**(題が空になっても章のまま。章の数は挿絵などの位置に効く) */
export function stripChapterBlobs(ch: Chapter): { chapter: Chapter; removed: number } {
  const title = stripDataBlobs(ch.title);
  const no = ch.no !== undefined ? stripDataBlobs(ch.no) : { text: undefined, removed: 0 };
  const blocks = stripBlockBlobs(ch.blocks);
  const removed = title.removed + no.removed + blocks.removed;
  if (!removed) return { chapter: ch, removed: 0 };
  const chapter: Chapter = { ...ch, title: title.removed ? title.text.trim() : ch.title, blocks: blocks.blocks };
  if (no.removed) {
    if (no.text?.trim()) chapter.no = no.text.trim();
    else delete chapter.no;
  }
  return { chapter, removed };
}

// ---- 大きさ ----

/** いちばん長い段落(章の題・小見出し・引用・箇条書きの1項目・絵の説明も1つと数える)。章が無ければ null */
export function longestBlock(chapters: readonly Chapter[]): { chapter: number; chars: number } | null {
  let best: { chapter: number; chars: number } | null = null;
  const see = (chapter: number, s: unknown) => {
    if (typeof s !== 'string') return;
    if (!best || s.length > best.chars) best = { chapter, chars: s.length };
  };
  chapters.forEach((ch, i) => {
    see(i, ch.title);
    see(i, ch.no);
    for (const b of ch.blocks) {
      if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') see(i, b.text);
      else if (b.type === 'list') for (const item of b.items) see(i, item);
      else if (b.type === 'image') {
        see(i, b.alt);
        see(i, b.caption);
      }
    }
  });
  return best;
}

/** 断りの文で章を指す言い方。「「あとがき」の章」・章立ての無い原稿は「原稿」・題の無い章は「2番目の章」 */
export function chapterLabel(chapters: readonly Chapter[], index: number): string {
  const ch = chapters[index];
  const name = ch ? plainText([ch.no ?? '', ch.title ?? ''].filter(Boolean).join('　')).trim() : '';
  if (name) return `「${name.length > 20 ? `${name.slice(0, 20)}…` : name}」の章`;
  return chapters.length <= 1 ? '原稿' : `${index + 1}番目の章`;
}

export interface GuardResult {
  /** 取り除いたあとの原稿(何も無ければ渡したものそのまま) */
  manuscript: Manuscript;
  /** 画面で言っておくこと(取り除いた数・組版に時間がかかること) */
  notes: string[];
  /** **取り込まない**理由。あれば原稿を使わない(load.ts の parseSource が Error にして投げる) */
  error?: string;
}

/** 本に残るコラムページ(字数に入れる。models/project.ts の countBodyChars と同じ形) */
export type ColumnPageText = Pick<ColumnPage, 'title' | 'text'>;

/**
 * 取り込んだ原稿を、組版へ渡してよいか見る。
 * 1. 字に置き換えた画像などのデータを取り除く(知らせる)
 * 2. 取り除いたあとの原稿で、5万字以上の段落・100万字以上の原稿は断る。30万字以上は時間がかかると知らせる
 *
 * 字数は入口の画面の「◯字」と同じ数え方(models/project.ts の countBodyChars)。
 * columnPages = 取り込んだあとも本に残るコラムページ(取り込みと［原稿を組み直す］は本文だけを入れ替え、
 * コラムページは残して一緒に組む。2026-10-13 見直し。前は本文だけを数え、断る量の目安と入口の字数が食い違った)
 */
export function guardManuscript(manuscript: Manuscript, columnPages: readonly ColumnPageText[] = []): GuardResult {
  let removed = 0;
  const chapters = manuscript.chapters.map((ch) => {
    const r = stripChapterBlobs(ch);
    removed += r.removed;
    return r.chapter;
  });
  const ms = removed ? { ...manuscript, chapters } : manuscript;
  const notes: string[] = [];
  if (removed) notes.push(dataBlobsRemovedNote(removed));

  const longest = longestBlock(ms.chapters);
  if (longest && longest.chars >= MAX_BLOCK_CHARS) {
    return { manuscript: ms, notes, error: longBlockError(chapterLabel(ms.chapters, longest.chapter), longest.chars) };
  }
  const total = countBodyChars(ms.chapters, columnPages);
  const withColumns = countBodyChars([], columnPages) > 0;
  if (total >= MAX_TOTAL_CHARS) return { manuscript: ms, notes, error: tooLongError(total, withColumns) };
  if (total >= SLOW_TOTAL_CHARS) notes.push(slowTypesetNote(total, withColumns));
  return { manuscript: ms, notes };
}

/**
 * 保存の .json・自動保存から開いた本が、組版が止まるほど大きいか(project/file.ts の sanitize)。
 * 取り込みなら断る大きさ(5万字以上の段落・100万字以上)なら、その知らせを返す。無ければ null。
 * **開くのは止めない・字は切らない**(止めると本そのものが開けなくなる)。
 * 前は何も言わずに組版へ渡り、開くたびに画面が止まった(この見張りの前に取り込んだ、改行の抜けた .txt など。2026-10-13 見直し)
 */
export function sizeNoticeOnOpen(chapters: readonly Chapter[], columnPages: readonly ColumnPageText[] = []): string | null {
  const longest = longestBlock(chapters);
  if (longest && longest.chars >= MAX_BLOCK_CHARS) {
    return longBlockOnOpenNotice(chapterLabel(chapters, longest.chapter), longest.chars);
  }
  const total = countBodyChars(chapters, columnPages);
  return total >= MAX_TOTAL_CHARS ? tooLongOnOpenNotice(total) : null;
}
