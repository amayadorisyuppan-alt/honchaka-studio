// テキスト原稿の取込。章の自動検出、Markdown と同じ見出し記法、
// 青空文庫ルビ記法(《》)に対応。

import type { Block, Chapter, Manuscript } from '../models/project';

/**
 * 「第三章 青い背表紙」のような行を (no, title) に分解する。
 *
 * **目印のあとには区切りが要る。** これが無いと
 * 「第二章と第三章は、いま読み返しても……」のような**本文の一文が章に化ける**
 * (2026-08-17 にサンプル原稿を書いていて実際に踏んだ)。
 * 目印の直後がかな・漢字で続いていれば、それは見出しではなく文の書き出し。
 */
const CHAPTER_RE =
  /^(第[0-9０-９〇一二三四五六七八九十百千]+[章話部]|序章|終章|序|プロローグ|エピローグ|まえがき|あとがき)(?:[　\s]+|[：:・．.\-—―|]+[　\s]*|$)(.*)$/;

/**
 * 見出しとして認める行の長さ。これを超える行は、目印で始まっていても本文とみなす。
 * 章題が40字を超えることは実務上まず無い一方、本文の一文は簡単に超える
 */
const CHAPTER_MAX_LEN = 40;

export function detectChapterLine(line: string): { no?: string; title: string } | null {
  if (line.length > CHAPTER_MAX_LEN) return null;
  const m = line.match(CHAPTER_RE);
  if (!m) return null;
  // 「プロローグ」「あとがき」等は番号ではなく題そのもの
  const isLabel = !/^第/.test(m[1]);
  if (isLabel && !m[2]) return { title: m[1] };
  return { no: m[1], title: m[2] ?? '' };
}

/**
 * 区切り線の行か。**行全体が `---` か `***`(3つ以上)のときだけ。**
 *
 * ここで判定してしまうのは、本文の文字列として先へ送ると
 * typeset/text.ts の normalizeDashes が `-{2,}` を2倍ダッシュ「――」に変えるため。
 * 組版に届いた時点ではもう線と区別できない(ダッシュの変換自体は正しいので text.ts は触らない)。
 *
 * `___`(下線)や `- - -`(記号のあいだに空白)は線にしない。**md.ts はこれらを
 * 従来どおり1行アキとして扱う**ので、場面転換のつもりで書いた原稿を勝手に線へ変えない
 */
export function isHrLine(line: string): boolean {
  return /^(?:-{3,}|\*{3,})$/.test(line.trim());
}

/**
 * 行末寄せの行 `>> 〜` の中身。そうでなければ null。
 *
 * **あとがき・前書きの署名と日付のための記法。** 和文では行末(縦組みなら地、
 * 横組みなら右)に寄せるのが作法で、行頭のままだと本文の続きに見える。
 *
 * **引用より先に見ること。** `>` 1つが引用なので、順番を逆にすると
 * `>> 雨宿 文` が「`> 雨宿 文` という引用」に化ける。
 *
 * 記号を `>>` にしたのは、このアプリの行単位の記法がすべて行頭の目印だから
 * (`#` `##` `>` `-` `---`)。Obsidian では入れ子の引用に使う記号だが、
 * 小説の原稿に入れ子の引用が出ることはまず無い(記法一覧にも断り書きを載せてある)
 */
export function detectEndAlignLine(line: string): string | null {
  // 全角の ＞＞ も受ける(引用と同じ理由。日本語入力のままだと全角になる)
  const m = /^[>＞]{2}[ 　]?(.+)$/.exec(line.trim());
  return m ? m[1].trim() : null;
}

/** 引用行 `> 〜` の中身。引用でなければ null */
export function detectQuoteLine(line: string): string | null {
  // 全角の ＞ も受ける。日本語入力のまま打つと全角になり、見た目では気づけない
  const m = /^[>＞][ 　]?(.+)$/.exec(line.trim());
  return m ? m[1].trim() : null;
}

export interface ListLine {
  text: string;
  ordered: boolean;
  /**
   * 番号つきの行に書いてあった数(全角も半角の数にする)。
   * 箇条書きの最初の項目のぶんだけ使う(models/project.ts の Block の start)
   */
  num?: number;
}

/** 「１２」「12」を 12 にする。桁が多すぎて数として持てないときは undefined(1 から数える) */
function listNum(digits: string): number | undefined {
  const n = Number(digits.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)));
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * 箇条書きの行を、マーカーと中身に分ける。箇条書きでなければ null。
 *
 * 拾う書き方は4つ。**後ろの2つは、このアプリが Word へ書き出した行を読み戻すため**
 * (Word の段落番号は mammoth が `<ul>` にしてくれるが、こちらが書き出すのは
 *  マーカーを字として置いた段落なので、記号のほうでも拾えないと往復しない)。
 *
 * | 書き方 | 出るもの |
 * |---|---|
 * | `- ` `* ` `+ ` | 並び |
 * | `1. ` `2) ` | 番号つき |
 * | `・` | 並び |
 * | `１．` | 番号つき |
 *
 * **半角の記号には空白を要る形にしてある。** 空白を求めないと
 * 「*強調*で始まる行」「2.5倍と書き出した行」まで箇条書きに化ける
 */
export function detectListLine(line: string): ListLine | null {
  const s = line.trim();
  // 記号だけが並んだ行(`- - -` など)は箇条書きではない。区切り線・1行アキ側の担当
  const onlyMarks = (t: string) => /^[-*+_\s]+$/.test(t);

  let m = /^[-*+][ 　]+(.+)$/.exec(s);
  if (m && !onlyMarks(m[1])) return { text: m[1].trim(), ordered: false };
  m = /^[・･][ 　]*(.+)$/.exec(s);
  if (m) return { text: m[1].trim(), ordered: false };
  m = /^([0-9]+)[.)][ 　]+(.+)$/.exec(s);
  if (m) return { text: m[2].trim(), ordered: true, num: listNum(m[1]) };
  // 全角のときだけ空白を省ける(書き出しが「１．項目」の形)。
  // ただし直後が数字なら「１．５倍」のような本文なので拾わない
  m = /^([０-９]+)．[ 　]*(?![0-9０-９])(.+)$/.exec(s);
  if (m) return { text: m[2].trim(), ordered: true, num: listNum(m[1]) };
  return null;
}

/**
 * 組み立て中の箇条書き。md.ts・txt.ts・docx.ts が同じ形で持つ。
 * 番号つきは**最初の項目の数**を start に取る。2つめからの数は見ない
 * (CommonMark と同じ。「1. 1. 1.」と書いても 1・2・3 になる)
 */
export interface OpenList {
  items: string[];
  ordered: boolean;
  start?: number;
}

export function openList(item: ListLine): OpenList {
  return { items: [], ordered: item.ordered, ...(item.ordered ? { start: item.num } : {}) };
}

/** 組み立て終えた箇条書きのブロック。start は 1 のときは書かない(古い保存と同じ形になる) */
export function listBlock(list: OpenList): Block {
  return {
    type: 'list',
    items: list.items,
    ...(list.ordered ? { ordered: true } : {}),
    ...(list.ordered && list.start !== undefined && list.start !== 1 ? { start: list.start } : {}),
  };
}

/**
 * 空行をはさんで次の項目が来たとき、**同じ箇条書きの続きとみなすか。**
 *
 * > 「１．A」空行「２．B」空行「３．C」と書いたら、全部「１．」で刷られた
 * > (2026-10-02『日記の中に、鉱脈がある』付録「Obsidianの始め方」の手順1〜5)
 *
 * 項目のあいだに空行を1つはさむのは Markdown のふつうの書き方(CommonMark の loose list)。
 * もとは空行が来た時点で箇条書きを閉じていたので、1項目ずつの箇条書きに割れ、
 * 番号がどれも 1 から数え直されていた。
 *
 * - **空行1つ** + 同じ種類(番号つき／並び)の項目 → 続き。空行は捨てる
 *   (txt でも同じ。空行1つは本来1行アキだが、項目ごとに場面転換のアキが入るのは書き手の意図ではない)
 * - **空行2つ以上** → 続きにしない。閉じて1行アキを入れ、次の項目から新しい箇条書きにする。
 *   md では空行2つが「ここを1行空ける」の書き方なので、それを守る。
 *   番号は書いてある数(start)から数えるので、割れても「３．」は「３．」のまま
 * - 種類が変わる・箇条書きでない行が来る → いままでどおり閉じる
 */
export function continuesAfterBlank(list: OpenList, item: ListLine | null, blankRun: number): boolean {
  return !!item && item.ordered === list.ordered && blankRun === 1;
}

/**
 * @param _notes 取り込みで言っておくことを足す先(省略できる)。load.ts の parseSource が画面へ出す
 *   (Word のルビの断りと同じ道。2026-10-13 に道だけ通した。使うときは名前の _ を外す)
 */
export function parseTxt(source: string, fallbackTitle = '', _notes: string[] = []): Manuscript {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const chapters: Chapter[] = [];
  let current: Chapter | null = null;
  let pendingSpace = false;
  /** 箇条書きの途中で続いている空行の数(下の continuesAfterBlank) */
  let blankRun = 0;

  /** 組み立て中の箇条書き。箇条書きでない行が来たところで1ブロックにする */
  let list: OpenList | null = null;

  const push = (b: Block) => {
    if (!current) {
      current = { title: '', blocks: [] };
      chapters.push(current);
    }
    current.blocks.push(b);
  };
  const flushList = () => {
    if (!list) return;
    push(listBlock(list));
    list = null;
  };
  const flushSpace = () => {
    if (!pendingSpace) return;
    push({ type: 'space' });
    pendingSpace = false;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      blankRun++;
      // 箇条書きの途中の空行は、次の行を見てから決める(続きの項目なら捨てる)
      if (list) continue;
      // 空行: 段落区切り。連続空行は1行アキ1つに丸める(rules §3)。
      // **区切り線の直後の空行は捨てる。** 線そのものが前後にアキを持っているので、
      // 足すと線の後ろだけ1行ぶん間延びする(前の空行は区切り線の側で捨てている)
      if (
        current &&
        current.blocks.length > 0 &&
        current.blocks[current.blocks.length - 1].type !== 'hr'
      ) {
        pendingSpace = true;
      }
      continue;
    }
    // 箇条書きは連続する行を1つにまとめるので、他の分岐より先に見る。
    // まとめ終わるのは「箇条書きでない行が来たところ」なので、
    // ここを抜けた先では必ず flushList() を通す
    const item = detectListLine(line.trim());
    if (list && blankRun > 0 && !continuesAfterBlank(list, item, blankRun)) {
      // 置いておいた空行を、閉じた箇条書きのあとの1行アキにする(空行のときに決めていたのと同じ結果)
      flushList();
      pendingSpace = true;
    }
    blankRun = 0;
    if (item) {
      if (!list || list.ordered !== item.ordered) {
        flushList();
        flushSpace();
        list = openList(item);
      }
      list.items.push(item.text);
      continue;
    }
    flushList();

    // 区切り線。**前の空行は捨てる。** 線そのものが切れ目なので、
    // 1行アキを足すと線のまわりだけ間延びする
    if (isHrLine(line)) {
      if (current && current.blocks.length > 0) {
        pendingSpace = false;
        push({ type: 'hr' });
      }
      continue;
    }
    // 行末寄せ(署名・日付)。**引用より先に見る** — `>` 1つが引用なので、
    // 順番を逆にすると `>> 雨宿 文` が「`> 雨宿 文` という引用」に化ける
    const endAlign = detectEndAlignLine(line);
    if (endAlign) {
      flushSpace();
      push({ type: 'p', text: endAlign, align: 'end' });
      continue;
    }
    const quote = detectQuoteLine(line);
    if (quote) {
      flushSpace();
      push({ type: 'quote', text: quote });
      continue;
    }
    const ch = detectChapterLine(line.trim());
    if (ch) {
      current = { no: ch.no, title: ch.title, blocks: [] };
      chapters.push(current);
      pendingSpace = false;
      continue;
    }
    // Markdown と同じ見出し記法も受ける。テキストには小見出しを付ける手段がなく、
    // 「### 小見出し」と書いた原稿が記号ごと紙面に刷られてしまうため。
    // 拡張子を .md に変えなくても、どちらでも同じ書き方が通るようにする
    const h1 = /^#\s+(.*)$/.exec(line.trim());
    if (h1) {
      const det = detectChapterLine(h1[1].trim());
      current = det ? { no: det.no, title: det.title, blocks: [] } : { title: h1[1].trim(), blocks: [] };
      chapters.push(current);
      pendingSpace = false;
      continue;
    }
    const h3 = /^###?\s+(.*)$/.exec(line.trim());
    if (h3) {
      if (pendingSpace) {
        push({ type: 'space' });
        pendingSpace = false;
      }
      push({ type: 'h3', text: h3[1].trim() });
      continue;
    }
    if (pendingSpace) {
      push({ type: 'space' });
      pendingSpace = false;
    }
    // 行頭の全角空白(手動字下げ)は削除し、字下げは組版側で行う
    push({ type: 'p', text: line.replace(/^[　\s]+/, '') });
  }
  flushList(); // 原稿が箇条書きで終わっているとき

  return {
    title: fallbackTitle,
    author: '',
    publisher: '',
    chapters: chapters.length ? chapters : [{ title: '', blocks: [] }],
  };
}
