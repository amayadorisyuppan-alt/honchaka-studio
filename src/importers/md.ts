// Markdown 原稿の取込。# = 章、## と ### = 小見出し。装飾は Phase 2。
// 行を読む前の下ごしらえ(絵・見出しの印・逃がし \X・Google ドキュメントの書き出しの癖)は mdPrep.ts(2026-10-13)

import type { Block, Chapter, Manuscript } from '../models/project';
import { prepareMarkdown, restoreEscapesIn } from './mdPrep';
import {
  continuesAfterBlank,
  detectChapterLine,
  detectEndAlignLine,
  detectListLine,
  detectQuoteLine,
  isHrLine,
  listBlock,
  openList,
} from './txt';
import type { OpenList } from './txt';

/**
 * 段落の字から、紙面に持ち込まない Markdown の記法を外す。
 * 強調 `**〜**` だけは残す。paragraphHtml が <em> に変換して太字で組む
 */
function paragraphText(line: string): string {
  return (
    line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 画像(取れる絵は下ごしらえで絵のブロックにしてある。残りは場所や URL の絵)
      // リンク `[文字](URL)` はそのまま残す。paragraphHtml が <a> にする(電子書籍で飛べる)
      .replace(/`([^`]*)`/g, '$1') // インラインコード
      .replace(/^\s*\[\^[^\]]+\]:\s*/, '') // 脚注の定義行 → 中身だけ残す
      .replace(/\[\^[^\]]+\]/g, '') // 本文中の脚注参照
      .replace(/^\s*#{4,}\s+/, '') // h4 以下は本文扱い(7つ以上の # は見出しではないので、ここで落とす)
      // 箇条書きのマーカーと引用の `>` は、ここでは落とさない。
      // どちらも上で list / quote のブロックとして拾い終わっている
      .trim()
      // 行頭の全角空白(手動字下げ)は削除し、字下げは組版側で行う
      .replace(/^[　\s]+/, '')
  );
}

/**
 * @param notes 取り込みで言っておくことを足す先(省略できる)。load.ts の parseSource が画面へ出す
 *   (取り込めなかった絵・Google ドキュメントの絵のきめが足りないこと。2026-10-13)
 */
export function parseMd(source: string, fallbackTitle = '', notes: string[] = []): Manuscript {
  // 先頭の YAML front matter(--- で囲まれたメタデータ。Obsidian などが付ける)は、下ごしらえで外してある
  // (中身が YAML らしいときだけ。Google の書き出しでは外さない)
  const { entries, google } = prepareMarkdown(source, notes);
  const chapters: Chapter[] = [];
  let current: Chapter | null = null;
  let pendingSpace = false;
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

  for (const e of entries) {
    const line = e.kind === 'image' ? '' : e.text.trimEnd();
    if (e.kind !== 'image' && !line.trim()) {
      blankRun++;
      // 箇条書きの途中の空行は、次の行を見てから決める(空行1つで続きの項目なら、
      // 同じ箇条書きにつなぐ。txt.ts の continuesAfterBlank)
      if (list) continue;
      // Markdown の単発改行は段落区切り。2行以上の空白で場面転換とみなす
      // (段落のあいだを詰めた Google の文書では、空行1つを下ごしらえで2つにしてある)。
      // 区切り線の直後の空行は捨てる(線が前後にアキを持っているため。txt.ts と同じ)
      if (
        blankRun >= 2 &&
        current &&
        current.blocks.length > 0 &&
        current.blocks[current.blocks.length - 1].type !== 'hr'
      ) {
        pendingSpace = true;
      }
      continue;
    }

    // 箇条書きは連続する行を1つにまとめるので、他の分岐より先に見る。
    // まとめ終わるのは「箇条書きでない行が来たところ」なので、ここを抜けたら必ず流す。
    // `- - -` のように記号だけが並ぶ行は detectListLine が弾く(下の水平線の担当)
    const item = e.kind === 'line' ? detectListLine(line) : null;
    if (list && blankRun > 0 && !continuesAfterBlank(list, item, blankRun)) {
      // 置いておいた空行の扱いを、ここで決める。空行のときに決めていたのと同じ結果にする
      // (閉じた箇条書きのあとに、2行以上なら1行アキ)
      flushList();
      if (blankRun >= 2) pendingSpace = true;
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

    // 原稿に入っていた絵(Google ドキュメントの書き出しなど。下ごしらえで受けた JPEG・PNG だけ)
    if (e.kind === 'image') {
      flushSpace();
      push({ type: 'image', src: e.src });
      continue;
    }
    // コードブロックの中の行。記法として読まず、字のまま段落にする
    if (e.kind === 'code') {
      flushSpace();
      push({ type: 'p', text: line.replace(/^[　\s]+/, '') });
      continue;
    }
    if (e.kind === 'heading') {
      if (e.level === 1) {
        const det = detectChapterLine(e.text);
        current = det ? { no: det.no, title: det.title, blocks: [] } : { title: e.text, blocks: [] };
        chapters.push(current);
        pendingSpace = false;
        continue;
      }
      // ## と ### は小見出し扱い(Phase 1)。前の1行アキは小見出しの前に置く(txt.ts と同じ。
      // 前は小見出しのあとの段落の前に入っていた。2026-10-13)
      if (e.level <= 3) {
        flushSpace();
        push({ type: 'h3', text: e.text });
        continue;
      }
      // h4 以下は本文扱い
      const text = paragraphText(e.text);
      if (!text) continue;
      flushSpace();
      push({ type: 'p', text });
      continue;
    }

    // 区切り線。**行全体が `---` か `***` のときだけ。**
    // 下の「水平線 → 1行アキ」より先に見る(そちらは `___` や `- - -` まで拾うので、
    // 順番を逆にすると区切り線がすべて1行アキに化ける)。
    // 前の空行は捨てる。線そのものが切れ目なので、1行アキを足すと線のまわりだけ間延びする
    if (isHrLine(line)) {
      if (current && current.blocks.length > 0) {
        pendingSpace = false;
        push({ type: 'hr' });
      }
      continue;
    }

    // 水平線(---, ***, ___, - - - など)は場面転換の1行アキとして扱う。
    // 記号のあいだに空白が入る書き方もあるので、そこまで拾う
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      if (current && current.blocks.length > 0) pendingSpace = true;
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

    // 引用。1行を1ブロックにする(理由は models/project.ts の Block を参照)
    const quote = detectQuoteLine(line);
    if (quote) {
      flushSpace();
      push({ type: 'quote', text: quote });
      continue;
    }

    // 表。区切り行(|---|---|)は捨て、データ行はセルを全角スペースでつなぐ。
    // 縦組みで表を組むのは別仕事なので、まずは記法を紙面に出さないことを優先する
    if (/^\s*\|/.test(line)) {
      if (/^[\s|:-]+$/.test(line)) continue;
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (!cells.length) continue;
      if (pendingSpace) {
        push({ type: 'space' });
        pendingSpace = false;
      }
      push({ type: 'p', text: cells.join('　') });
      continue;
    }

    // Markdown 特有の記法は本文組版に持ち込まない(記法がそのまま紙面に出てしまう)
    const text = paragraphText(line);
    if (!text) continue;

    flushSpace();
    push({ type: 'p', text });
  }
  flushList(); // 原稿が箇条書きで終わっているとき

  const result: Chapter[] = chapters.length ? chapters : [{ title: '', blocks: [] }];
  // Google の書き出しでない .md の `\#` などは、構造を見るあいだ預けておいた。ここで字に戻す(`\` は刷らない)
  if (!google) restoreEscapesIn(result);
  return {
    title: fallbackTitle,
    author: '',
    publisher: '',
    chapters: result,
  };
}
