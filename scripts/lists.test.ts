// 箇条書きの取り込みと番号の検査。
//
// ## なぜ在るか
//
// 「１．A」空行「２．B」空行「３．C」と書いた原稿が、**全部「１．」で刷られた**
// (2026-10-02『日記の中に、鉱脈がある』付録「Obsidianの始め方」の手順1〜5)。
// 空行が来た時点で箇条書きを閉じていたので1項目ずつの箇条書きに割れ、
// 番号は箇条書きの中の並び順で振るので、どれも 1 から数え直されていた。
// もう1つ、「３．」のあとに「・」の項目をはさんで「４．」に戻ると、後ろが「１．」になっていた。
//
// 確かめること:
//
// - md・txt: 空行1つをはさんだ同じ種類の項目は、ひとつづきの箇条書きになる
// - 空行2つ以上は、いままでどおり1行アキ(箇条書きは割れるが、番号は書いた数のまま)
// - 番号つきは最初の項目の数から数える(start)。紙(html.ts)と EPUB(epub.ts)の両方
// - 「１．５倍」のような本文は箇条書きにしない
// - 保存・読み込み(バックアップと AI 用の両方)で start が残る。start の無い古い保存はそのまま 1 から
//
// Word の取り込み(importers/docx.ts)は mammoth と DOMParser が要るのでここでは回さない。
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   npx vite build --ssr scripts/lists.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/lists.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { defaultSettings, listMarker } from '../src/models/project';
import type { Block, Manuscript } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { parseMd } from '../src/importers/md';
import { detectListLine, parseTxt } from '../src/importers/txt';
import { manuscriptHtml } from '../src/typeset/html';
import { buildEpubBook, previewImageResolver } from '../src/exporters/epub';
import { fromProjectFile, toProjectFile } from '../src/project/file';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}

/** ブロックを見比べやすい短い字にする */
function shape(b: Block): string {
  if (b.type === 'list') {
    const head = b.ordered ? `ol${b.start !== undefined ? `@${b.start}` : ''}` : 'ul';
    return `${head}[${b.items.join('|')}]`;
  }
  if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') return `${b.type}:${b.text}`;
  return b.type;
}
const shapes = (ms: Manuscript) => ms.chapters.map((ch) => ch.blocks.map(shape));
function same(name: string, ms: Manuscript, want: string[][]) {
  const got = shapes(ms);
  ok(JSON.stringify(got) === JSON.stringify(want), name, `\n    得た   ${JSON.stringify(got)}\n    ほしい ${JSON.stringify(want)}`);
}
const both = (name: string, src: string, md: string[][], txt: string[][] = md) => {
  same(`md: ${name}`, parseMd(src), md);
  same(`txt: ${name}`, parseTxt(src), txt);
};

// ---- 空行をはさんだ箇条書き ----

both('全角の番号を空行1つずつで区切る(実際に踏んだ形)', '１．A\n\n２．B\n\n３．C', [['ol[A|B|C]']]);
both('半角の番号を空行1つずつで区切る', '1. A\n\n2. B\n\n3. C', [['ol[A|B|C]']]);
both('並びを空行1つずつで区切る', '- A\n\n- B\n\n・C', [['ul[A|B|C]']]);
both('空行なし(いままでどおり)', '１．A\n２．B\n３．C', [['ol[A|B|C]']]);
both('空行が空白だけの行でも続きとみなす', '１．A\n　\n２．B', [['ol[A|B]']]);
both('CRLF の原稿', '１．A\r\n\r\n２．B\r\n\r\n３．C\r\n', [['ol[A|B|C]']]);

// 空行2つ以上は1行アキ。割れた後ろの箇条書きは、書いてある「３．」から数える
both('空行2つは1行アキ(番号は書いた数のまま)', '１．A\n\n２．B\n\n\n３．C', [['ol[A|B]', 'space', 'ol@3[C]']]);
both('空行3つでも1行アキは1つ', '- A\n\n\n\n- B', [['ul[A]', 'space', 'ul[B]']]);

// 種類が変わるとき・箇条書きでない行が来たときは、いままでどおり閉じる。
// 空行のアキは md と txt で違う(md は空行2つから、txt は空行1つから1行アキ)
both('空行1つのあとに本文', '１．A\n\n本文', [['ol[A]', 'p:本文']], [['ol[A]', 'space', 'p:本文']]);
both('空行2つのあとに本文', '１．A\n\n\n本文', [['ol[A]', 'space', 'p:本文']]);
both('空行なしで本文', '１．A\n本文', [['ol[A]', 'p:本文']]);
both('空行1つで種類が変わる', '１．A\n\n・B', [['ol[A]', 'ul[B]']], [['ol[A]', 'space', 'ul[B]']]);
both('空行のあとに区切り線(線の前のアキは捨てる)', '- A\n\n---\n\n本文', [['ul[A]', 'hr', 'p:本文']]);
both('空行2つのあとに章(章の頭にアキを持ち込まない)', '- A\n\n\n# 第二章　次\n本文', [['ul[A]'], ['p:本文']]);
both('箇条書きで終わり、後ろに空行が続く', '本文\n- A\n- B\n\n\n', [['p:本文', 'ul[A|B]']]);
both('箇条書きのあとの空行1つと引用', '- A\n\n> 引用', [['ul[A]', 'quote:引用']], [['ul[A]', 'space', 'quote:引用']]);

// ---- 「・」をはさんで番号つきに戻る(実際に踏んだもう1つの形) ----

both(
  '・ の項目をはさんで ４． に戻る',
  '３．二つだけ決める\n・名前\n・置き場所\n４．Create',
  [['ol@3[二つだけ決める]', 'ul[名前|置き場所]', 'ol@4[Create]']],
);
both(
  '・ の項目をはさんで ４． に戻る(項目のあいだに空行1つ)',
  '１．A\n\n２．B\n\n３．二つだけ決める\n・名前\n・置き場所\n\n４．Create\n\n５．E',
  [['ol[A|B|二つだけ決める]', 'ul[名前|置き場所]', 'ol@4[Create|E]']],
  [['ol[A|B|二つだけ決める]', 'ul[名前|置き場所]', 'space', 'ol@4[Create|E]']],
);

// ---- 番号の取り方 ----

both('最初の項目の数だけを使う(CommonMark と同じ)', '1. A\n1. B\n1. C', [['ol[A|B|C]']]);
both('最初の数から数える', '3. A\n7. B', [['ol@3[A|B]']]);
both('全角の２桁', '１２．A\n１３．B', [['ol@12[A|B]']]);
both('0 から始める', '0. A\n1. B', [['ol@0[A|B]']]);
both('閉じ括弧の番号', '4) A\n\n5) B', [['ol@4[A|B]']]);

// ---- 本文を箇条書きにしない ----

both('「１．５倍」は本文', '１．５倍の速さで読めた。', [['p:１．５倍の速さで読めた。']]);
both('「2.5倍」は本文', '2.5倍の速さで読めた。', [['p:2.5倍の速さで読めた。']]);
both('箇条書きの直後の「１．５倍」は本文(空行なし)', '１．A\n１．５倍の速さ', [['ol[A]', 'p:１．５倍の速さ']]);
both(
  '箇条書きの空行1つあとの「１．５倍」は本文',
  '１．A\n\n１．５倍の速さ',
  [['ol[A]', 'p:１．５倍の速さ']],
  [['ol[A]', 'space', 'p:１．５倍の速さ']],
);
ok(detectListLine('１．５倍') === null, 'detectListLine: 「１．５倍」は箇条書きではない');
ok(detectListLine('１．A')?.num === 1, 'detectListLine: 「１．A」の数は 1');
ok(detectListLine('１２．A')?.num === 12, 'detectListLine: 「１２．A」の数は 12');
ok(detectListLine('7) A')?.num === 7, 'detectListLine: 「7) A」の数は 7');
ok(detectListLine('- A')?.num === undefined, 'detectListLine: 並びは数を持たない');

// ---- マーカー ----

ok(listMarker(0, true) === '１．', 'listMarker: start なしは １． から');
ok(listMarker(2, true) === '３．', 'listMarker: 3つめは ３．');
ok(listMarker(0, true, 4) === '４．', 'listMarker: start 4 は ４． から');
ok(listMarker(1, true, 9) === '１０．', 'listMarker: start 9 の2つめは １０．');
ok(listMarker(0, true, 0) === '０．', 'listMarker: start 0 は ０．');
ok(listMarker(0, false, 4) === '・', 'listMarker: 並びは start を見ない');
for (const bad of [NaN, -1, 2.5, '4', null]) {
  ok(listMarker(0, true, bad as never) === '１．', `listMarker: 使えない start ${String(bad)} は 1 から`);
}

// ---- 紙(html.ts)と EPUB(epub.ts) ----

const resumed = parseMd('# 付録\n３．二つだけ決める\n・名前\n・置き場所\n４．Create\n５．E');
{
  const html = manuscriptHtml(resumed, defaultSettings());
  ok(/<ol class="list" start="3">\s*<li>３．/.test(html), '紙: 先頭の番号つきは ３． から(start="3")');
  ok(/<ol class="list" start="4">\s*<li>４．[\s\S]*?<\/li>\s*<li>５．/.test(html), '紙: ・ のあとの番号つきは ４．５．(start="4")');
  ok(!/<li>１．/.test(html), '紙: １． から数え直していない');
  const plain = manuscriptHtml(parseMd('１．A\n\n２．B\n\n３．C'), defaultSettings());
  ok((plain.match(/<ol class="list">/g) ?? []).length === 1, '紙: 空行をはさんでも <ol> は1つ', `${(plain.match(/<ol/g) ?? []).length}`);
  ok(/<li>１．[\s\S]*?<li>２．[\s\S]*?<li>３．/.test(plain), '紙: １．２．３． と振る');
}
{
  const book = buildEpubBook(resumed, defaultSettings(), previewImageResolver((s) => s));
  const ch = book.files.get(book.chapterFiles[0]) ?? '';
  ok(/<ol class="list" start="3">\s*<li>３．/.test(ch), 'EPUB: 先頭の番号つきは ３． から(start="3")');
  ok(/<ol class="list" start="4">\s*<li>４．[\s\S]*?<\/li>\s*<li>５．/.test(ch), 'EPUB: ・ のあとの番号つきは ４．５．(start="4")');
  ok(!/<li>１．/.test(ch), 'EPUB: １． から数え直していない');
}

// ---- 保存と読み込み ----

const settings = { ...defaultSettings(), bookId: 'list-test' };
const snap = (manuscript: Manuscript) =>
  ({ settings, cover: defaultCoverSettings(), manuscript, source: null }) as never;
const listsOf = (ms: Manuscript) =>
  ms.chapters.flatMap((ch) => ch.blocks).filter((b): b is Extract<Block, { type: 'list' }> => b.type === 'list');

for (const withImages of [true, false]) {
  const label = withImages ? 'バックアップ' : 'AI 用';
  const text = toProjectFile(snap(resumed), withImages);
  const r = fromProjectFile(text, snap(resumed));
  ok(
    JSON.stringify(listsOf(r.project.manuscript).map((b) => b.start)) === JSON.stringify([3, undefined, 4]),
    `${label}: 保存して読み戻しても start が残る`,
    JSON.stringify(listsOf(r.project.manuscript)),
  );
  ok(!r.warnings.some((w) => w.includes('本文の段落の形')), `${label}: 正しい start は直さない`, JSON.stringify(r.warnings));
}

// start の無い古い保存。そのまま読めて、1 から数える
{
  const old: Manuscript = {
    title: '',
    author: '',
    publisher: '',
    chapters: [{ title: '', blocks: [{ type: 'list', items: ['A', 'B'], ordered: true }] }],
  };
  const r = fromProjectFile(toProjectFile(snap(old), true), snap(old));
  const [b] = listsOf(r.project.manuscript);
  ok(b !== undefined && !('start' in b), '古い保存: start が無いまま読める');
  ok(!r.warnings.some((w) => w.includes('本文の段落の形')), '古い保存: 直したと言わない');
  ok(/<ol class="list">\s*<li>１．[\s\S]*?<li>２．/.test(manuscriptHtml(r.project.manuscript, settings)), '古い保存: １．２． と振る');
}

// AI が書いた start。数字だけの字は数に直し、それ以外は捨てて 1 から数える
for (const [bad, want] of [
  ['"4"', 4],
  ['"x"', undefined],
  ['-1', undefined],
  ['2.5', undefined],
  ['null', undefined],
  ['"1"', undefined],
] as const) {
  const o = JSON.parse(toProjectFile(snap(resumed), false));
  const lists = o.manuscript.chapters[0].blocks.filter((b: { type: string }) => b.type === 'list');
  lists[2].start = JSON.parse(bad);
  const r = fromProjectFile(JSON.stringify(o), snap(resumed));
  const got = listsOf(r.project.manuscript)[2];
  ok(got.start === want && (want !== undefined || !('start' in got)), `AI 用: start ${bad} → ${want ?? '書かない(1 から)'}`, JSON.stringify(got));
  ok(r.warnings.some((w) => w.includes('本文の段落の形')), `AI 用: start ${bad} を直したと知らせる`, JSON.stringify(r.warnings));
  const html = manuscriptHtml(r.project.manuscript, settings);
  ok(!html.includes('NaN'), `AI 用: start ${bad} でも NaN を刷らない`);
}

// AI が全角スペースを半角に変えた項目は元に戻り、そのとき start も落ちない
{
  const wide = parseMd('４．名前　を決める\n５．置き場所');
  const o = JSON.parse(toProjectFile(snap(wide), false));
  o.manuscript.chapters[0].blocks[0].items[0] = '名前 を決める';
  const r = fromProjectFile(JSON.stringify(o), snap(wide));
  const [b] = listsOf(r.project.manuscript);
  ok(b.items[0] === '名前　を決める' && b.start === 4, 'AI 用: 全角スペースを戻しても start は 4 のまま', JSON.stringify(b));
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
