// Word(.docx)取込。mammoth で HTML 化し、見出し1で章分割する。

import mammoth from 'mammoth';
import { COLPAGE_MARK, type Block, type Chapter } from '../models/project';
import { optimizeBodyImages } from './bodyImages';
import { droppedTextKinds, prepareDocx } from './docxPrep';
import { detectChapterLine, detectListLine, detectQuoteLine, isHrLine, listBlock, openList } from './txt';
import type { OpenList } from './txt';
import type { ImportResult } from './result';

// 取り込みの結果の形は result.ts へ移した(md・txt も同じ形で返すため。2026-10-13)。前からの読み先のために、ここからも出す
export type { ImportResult };

/**
 * 引用を `<blockquote>` にする対応表。
 *
 * **mammoth の既定の対応表に引用は入っていない**(node_modules/mammoth の
 * options-reader.js を実際に読んで確認。見出し・箇条書き・脚注しかない)。
 * 何も足さないと、Word の「引用文」スタイルで書いた段落はただの `<p>` で出てくる。
 *
 * スタイル名は Word の版と言語で変わる。英語版は "Quote" / "Intense Quote"、
 * 日本語版は「引用文」で保存されることがあるので、どれも同じ行き先にしておく。
 * `p.Quote` はスタイル**名**ではなく id で当てる書き方(このアプリが書き出す .docx がこの形)。
 * `:fresh` を付けるのは、続けて書かれた引用を1つの箱に畳ませないため
 * (畳まれると文と文が区切りなくつながる)
 */
const QUOTE_STYLE_MAP = [
  "p.Quote => blockquote:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
  "p[style-name='引用文'] => blockquote:fresh",
];

/**
 * Word が自動で入れる代替テキスト。画像の説明ではないのでキャプションにしない。
 * 例:「ロゴ が含まれている画像\n\nAI によって生成されたコンテンツは間違っている可能性があります。」
 */
const AUTO_ALT = /AI\s*(によって)?生成|自動的に生成された説明|が含まれている画像/;

const PLACEMENT = '(全面|裁ち落とし|ぜんめん|ページ全体)';
/** 代替テキストの先頭、または [ ] で囲んで書かれた配置の指定 */
const PLACEMENT_PREFIX = new RegExp(`^${PLACEMENT}(?=\\s|$|[、。:：/／])[\\s、。:：/／]*`);
const PLACEMENT_BRACKETED = new RegExp(`[[［]\\s*${PLACEMENT}\\s*[\\]］]`, 'g');
/** 判定用。g 付きの正規表現は test() が lastIndex を持ち回るので、検出には使わない */
const PLACEMENT_ANY = new RegExp(`^${PLACEMENT}(?=\\s|$|[、。:：/／])|[[［]\\s*${PLACEMENT}\\s*[\\]］]`);

/**
 * Word の代替テキストを読む。
 * 先頭に「全面」(または `[全面]`)と書かれていたら、その画像はページ全面に敷く。
 * 指定の語そのものはキャプションとして刷らない。
 */
export function parseImageAlt(raw: string | null): { alt?: string; full?: boolean } {
  let alt = (raw ?? '').trim();
  if (!alt) return {};
  // 自動説明は「〜が含まれている画像(改行)AI 生成コンテンツは…」の形。
  // 文言は Word のバージョンで変わるので、改行を含むものも人の書いたキャプションではないとみなす
  if (AUTO_ALT.test(alt) || /[\r\n]/.test(alt)) return {};
  const full = PLACEMENT_ANY.test(alt);
  alt = alt.replace(PLACEMENT_PREFIX, '').replace(PLACEMENT_BRACKETED, '').trim();
  return { ...(alt ? { alt } : {}), ...(full ? { full: true } : {}) };
}

export async function parseDocx(buffer: ArrayBuffer, fallbackTitle = ''): Promise<ImportResult> {
  const prep = await prepareDocx(buffer);
  const result = await mammoth.convertToHtml(
    { arrayBuffer: prep.buffer },
    { styleMap: QUOTE_STYLE_MAP },
  );
  const notes: string[] = [];
  if (prep.ruby) {
    notes.push(`Word のルビ ${prep.ruby}か所を、スタジオのルビ（｜親《よみ》）にして取り込みました`);
  }
  /**
   * **下ごしらえでもほどけなかった要素は、中の字ごと入っていない。** mammoth は警告を返すので、
   * そのうち字を持っていたものの種類の数だけ言う(要素の名前は利用者に通じないので出さない)。
   * 原稿と見比べてもらう
   */
  const PREFIX = 'An unrecognised element was ignored: ';
  const ignored = [
    ...new Set(
      result.messages
        .filter((m) => m.type === 'warning' && m.message.startsWith(PREFIX))
        .map((m) => m.message.slice(PREFIX.length).trim()),
    ),
  ];
  const lost = await droppedTextKinds(prep.buffer, ignored);
  if (lost) {
    notes.push(
      `Word の中に、スタジオが読めない書き方の部分が ${lost}種類ありました。` +
        `その部分の文字は入っていないので、原稿と見比べてください`,
    );
  }
  const doc = new DOMParser().parseFromString(result.value, 'text/html');

  const chapters: Chapter[] = [];
  let current: Chapter | null = null;
  /** 組み立て中の箇条書き。記号で書かれた段落が続くあいだ溜める */
  let list: OpenList | null = null;
  /**
   * **［コラム］の中を読み飛ばしているあいだ。**
   *
   * Word 書き出し(2026-09-23 に撤去)はコラムページを「［コラム］見出し」の章として
   * 入れていた(刷り上がりと同じ流れで読めるように。models/project.ts の COLPAGE_MARK)。
   * 撤去前に書き出した Word が手元に残っているので、読み飛ばしはいまも要る。
   * コラムページ自体はスタジオの設定側(`settings.columnPages`)が持っているので、
   * これを章として戻すと**本文に二重に入り、そのぶん章の数が増える**。
   * 章が増えれば挿絵もコラムも章ごとの背景も、紐づいている章がずれる
   * (2026-08-21 実測: 5章 → 7章。コラム2枚目が「あとがきの前」→「千鳥の声の前」へ移動)。
   *
   * **挿絵ページは Word に出していない**。コラムだけがこの往復に乗っていたので、
   * 挿絵と同じ「往復に乗せない」へそろえる。
   * 見出しから次の見出しまでを丸ごと飛ばし、飛ばした見出しは呼び出し側へ返す
   */
  let skipping = false;
  const skippedColumnPages: string[] = [];

  const push = (b: Block) => {
    if (skipping) return;
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

  for (const el of Array.from(doc.body.children)) {
    const text = (el.textContent ?? '').trim();
    const tag = el.tagName.toLowerCase();

    // **記号で書かれた箇条書き。** Word の書式は取込で落ちるので、
    // 記法の一覧(AiStep の NOTATION)は「行のあたまに `- `」と案内している。
    // Word の段落番号を使った人は下の <ul>/<ol> のほうで拾われる。
    // 連続する段落を1つにまとめるので、他の分岐より先に見る
    const item = tag === 'p' && !isHrLine(text) ? detectListLine(text) : null;
    if (item) {
      if (!list || list.ordered !== item.ordered) {
        flushList();
        list = openList(item);
      }
      list.items.push(item.text);
      continue;
    }
    // 空白だけの段落は、組み立て中の箇条書きを閉じない(下の !text で捨てるだけの段落なので)。
    // 閉じると項目が1つずつの箇条書きに割れ、番号がどれも 1 に戻る(txt.ts の continuesAfterBlank)。
    // 本当に空の段落は mammoth がはじめから落としている(ignoreEmptyParagraphs の既定)
    if (list && tag === 'p' && !text && !el.querySelector('img')) continue;
    flushList();

    // Word の段落番号・箇条書き。mammoth が <ul>/<ol> にしてくれる。
    // **入れ子は平らにする。** 本文組版に段付きの箇条書きを持ち込むと、
    // 縦組みで字下げがどんどん深くなって版面から落ちる
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(el.children)
        .filter((li) => li.tagName.toLowerCase() === 'li')
        .map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (items.length) push({ type: 'list', items, ...(tag === 'ol' ? { ordered: true } : {}) });
      continue;
    }
    if (tag === 'blockquote') {
      // 中に段落があればそのまま1行ずつ、無ければ箱ごと1つの引用にする
      const inner = Array.from(el.querySelectorAll('p'))
        .map((p) => (p.textContent ?? '').trim())
        .filter(Boolean);
      for (const t of inner.length ? inner : [text]) if (t) push({ type: 'quote', text: t });
      continue;
    }
    // Word の「罫線」は mammoth が捨てるのでここには来ないが、
    // 他のソフトが書いた .docx から来ることはある
    if (tag === 'hr') {
      if (current && current.blocks.length > 0) push({ type: 'hr' });
      continue;
    }
    if (tag === 'h1') {
      // **［コラム］は章にしない。** ここから次の見出しまでを読み飛ばす
      if (text.startsWith(COLPAGE_MARK)) {
        skipping = true;
        skippedColumnPages.push(text.slice(COLPAGE_MARK.length).trim() || '無題');
        continue;
      }
      skipping = false;
      const det = detectChapterLine(text);
      current = det
        ? { no: det.no, title: det.title, blocks: [] }
        : { title: text, blocks: [] };
      chapters.push(current);
      continue;
    }
    if (tag === 'h2' || tag === 'h3') {
      if (text) push({ type: 'h3', text });
      continue;
    }
    // Word に貼った画像。mammoth が既定で data URI 化した <img> をそのまま拾う。
    // 画像だけの段落は textContent が空なので、この後の !text で捨てられてしまう。
    // querySelectorAll は要素自身を拾わないため、<img> が直下に来る場合を別に見る
    const imgs = tag === 'img' ? [el] : Array.from(el.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (src) push({ type: 'image', src, ...parseImageAlt(img.getAttribute('alt')) });
    }
    if (!text) continue;
    // このアプリが書き出した .docx の、画像の下のキャプション行。
    // 同じ字が代替テキスト(descr → 直前の image の alt)にも入って戻ってくるので、
    // そのまま拾うとキャプションが図の下と本文とに二重に刷られる。1つに畳む
    const prevBlock = current?.blocks[current.blocks.length - 1];
    if (prevBlock?.type === 'image' && (prevBlock.caption ?? prevBlock.alt) === text) continue;
    // 区切り線。**Word の段落罫線は mammoth が読まない**ので、記号で書いてもらう。
    // このアプリが書き出す .docx も、線ではなく `***` の行として出している(往復させるため)
    if (isHrLine(text)) {
      if (current && current.blocks.length > 0) push({ type: 'hr' });
      continue;
    }
    // 引用文スタイルを使わず、行のあたまに `> ` と書いた人のぶん
    // (記法の一覧はこちらを案内している。Word の書式は取込で落ちるため)
    const quote = detectQuoteLine(text);
    if (quote) {
      push({ type: 'quote', text: quote });
      continue;
    }
    push({ type: 'p', text: text.replace(/^[　\s]+/, '') });
  }
  flushList(); // 原稿が箇条書きで終わっているとき

  // Word は写真や図を PNG で持っていることが多い。透過を使っていないものは JPEG に置き換える。
  // 読めない絵(Word の EMF など)は、そのまま残す(Markdown の絵と同じ道。bodyImages.ts)
  await optimizeBodyImages(chapters);

  return {
    manuscript: {
      title: fallbackTitle,
      author: '',
      publisher: '',
      chapters: chapters.length ? chapters : [{ title: '', blocks: [] }],
    },
    skippedColumnPages,
    notes,
  };
}
