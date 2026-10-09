// Markdown 原稿の取込。# = 章、### = 小見出し。装飾は Phase 2。

import type { Block, Chapter, Manuscript } from '../models/project';
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

export function parseMd(source: string, fallbackTitle = ''): Manuscript {
  const all = source.replace(/\r\n?/g, '\n').split('\n');
  // 先頭の YAML front matter(--- で囲まれたメタデータ。Obsidian などが付ける)は本文ではない
  let lines = all;
  if (all[0]?.trim() === '---') {
    const end = all.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) lines = all.slice(end + 1);
  }
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

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      blankRun++;
      // 箇条書きの途中の空行は、次の行を見てから決める(空行1つで続きの項目なら、
      // 同じ箇条書きにつなぐ。txt.ts の continuesAfterBlank)
      if (list) continue;
      // Markdown の単発改行は段落区切り。2行以上の空白で場面転換とみなす。
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
    const item = detectListLine(line);
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

    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      const det = detectChapterLine(h1[1].trim());
      current = det
        ? { no: det.no, title: det.title, blocks: [] }
        : { title: h1[1].trim(), blocks: [] };
      chapters.push(current);
      pendingSpace = false;
      continue;
    }
    const h3 = line.match(/^###?\s+(.*)$/); // ## と ### は小見出し扱い(Phase 1)
    if (h3) {
      push({ type: 'h3', text: h3[1].trim() });
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

    // Markdown 特有の記法は本文組版に持ち込まない(記法がそのまま紙面に出てしまう)。
    // 強調 `**〜**` だけは残す。paragraphHtml が <em> に変換して太字で組む
    const text = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 画像(実体を持てないので未対応)
      // リンク `[文字](URL)` はそのまま残す。paragraphHtml が <a> にする(電子書籍で飛べる)
      .replace(/`([^`]*)`/g, '$1') // インラインコード
      .replace(/^\s*\[\^[^\]]+\]:\s*/, '') // 脚注の定義行 → 中身だけ残す
      .replace(/\[\^[^\]]+\]/g, '') // 本文中の脚注参照
      .replace(/^\s*#{4,}\s+/, '') // h4 以下は本文扱い
      // 箇条書きのマーカーと引用の `>` は、ここでは落とさない。
      // どちらも上で list / quote のブロックとして拾い終わっている
      .trim();
    if (!text) continue;

    flushSpace();
    push({ type: 'p', text: text.replace(/^[　\s]+/, '') });
  }
  flushList(); // 原稿が箇条書きで終わっているとき

  return {
    title: fallbackTitle,
    author: '',
    publisher: '',
    chapters: chapters.length ? chapters : [{ title: '', blocks: [] }],
  };
}
