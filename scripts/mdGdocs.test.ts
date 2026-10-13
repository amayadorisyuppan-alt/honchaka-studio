// Markdown の取り込み(src/importers/md.ts と下ごしらえの mdPrep.ts)と、柱の字(typeset/html.ts の章題の data-plain)の検査。(2026-10-13)
//
// ## なぜ在るか
//
// Google ドキュメントの［ファイル］→［ダウンロード］→［Markdown（.md）］で書き出した原稿を取り込むと、本が壊れた:
// 絵が 146万字の段落になって組版が止まり、`![][image1]` が字のまま刷られ、見出しの `**` で章の番号が読めず柱に `**` が刷られ、
// 書き手の打った `\>` `\*\*\*` が引用・区切り線にならず `\` ごと刷られた(同じ原稿の .docx は正しく取り込めた)。
//
// 確かめること:
//
// - Google の書き出しの癖の 21 例(2026-10-13 の調べの例を、本物のブロックの形に合わせたもの)
// - 本物の書き出しの縮み版(同じ 30 行。146万字の絵だけ小さな PNG にした): 3章・ブロックの並び・字に \ と ** と data: が残らない
// - 絵: JPEG と PNG だけ受ける(種類の名前と中身の頭のバイト)。場所・URL の絵と読めない絵は外して数を言う
// - 逃がし \X: Google の書き出しなら構造を見る前に外す。ほかの .md は構造にしないで字に戻す(\ は刷らない。全角の記号には触らない)。
//   ほかの .md の、構造や飾りにならない記号の前の \(顔文字の \(^o^)/ など)は打ったまま刷る
// - 2026-10-13 見直し: 行末の「  」や | ---- | の表だけでは Google と見分けない・前付けのキーの空白と [ … ]・
//   記号だけの見出しは章のまま・取れない絵で文を切らない・Obsidian のノートの埋め込みは字のまま・<img src="…">・
//   空行に挟まれた「* 」は残す・Google と見分けたら絵が無くても Word（.docx）をすすめる
// - YAML の前付けは YAML らしいときだけ外す(「---/A/---/B」で A を落とさない)
// - 小見出しの前の1行アキは小見出しの前に入る(txt と同じ)
// - 柱(data-plain)に ** などの記法が出ない。記法の無い章題の柱は前と1字も変わらない
// - lists.test.ts が見ている md の決まり(空行2つで1行アキなど)は、ここでは見ない(そちらで回る)
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   node scripts/private/run-tests.mjs public      (ほかの検査と一緒に)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { defaultSettings } from '../src/models/project';
import type { Block, Chapter, Manuscript } from '../src/models/project';
import { parseMd } from '../src/importers/md';
import { parseTxt } from '../src/importers/txt';
import {
  acceptImageDataUri,
  detectGoogleDocs,
  frontMatterEnd,
  gdocsMdNote,
  mdImageFormatNote,
  mdImageLinkedNote,
  prepareMarkdown,
  unescapeMarkdown,
} from '../src/importers/mdPrep';
import { guardManuscript } from '../src/importers/guard';
import { manuscriptHtml } from '../src/typeset/html';
import { stripInlineMarks } from '../src/typeset/text';

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

/** 小さな本物の PNG(1×1)と JPEG の頭 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/2Q==';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** 決まった並びの base64 の字(英大文字・小文字・数字・+/ を全部含む) */
function b64(n: number, seed = 7): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = seed;
  let s = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += A[x % 64];
  }
  return s;
}

/** ブロックを見比べやすい短い字にする。行末寄せの段落は end:、絵は種類だけ */
function shape(b: Block): string {
  if (b.type === 'list') return `list${b.ordered ? '(ol)' : ''}:${b.items.join('|')}`;
  if (b.type === 'p') return `${b.align === 'end' ? 'end' : 'p'}:${b.text}`;
  if (b.type === 'h3' || b.type === 'quote') return `${b.type}:${b.text}`;
  if (b.type === 'image') return `image:${/^data:image\/([a-z]+)/.exec(b.src)?.[1] ?? b.src.slice(0, 20)}`;
  return b.type;
}
interface Want {
  no?: string;
  title: string;
  blocks: string[];
}
const shapes = (ms: Manuscript): Want[] =>
  ms.chapters.map((ch) => ({ ...(ch.no !== undefined ? { no: ch.no } : {}), title: ch.title, blocks: ch.blocks.map(shape) }));
function same(name: string, ms: Manuscript, want: Want[]) {
  const got = shapes(ms);
  ok(JSON.stringify(got) === JSON.stringify(want), name, `\n    得た   ${JSON.stringify(got)}\n    ほしい ${JSON.stringify(want)}`);
}
/** 原稿のすべての字(章の番号・題・段落・箇条書きの項目・絵の説明)。絵の src は入れない */
function allText(ms: Manuscript): string[] {
  return ms.chapters.flatMap((ch: Chapter) => [
    ch.no ?? '',
    ch.title,
    ...ch.blocks.flatMap((b) =>
      b.type === 'list' ? b.items : b.type === 'image' ? [b.alt ?? '', b.caption ?? ''] : 'text' in b ? [b.text] : [],
    ),
  ]);
}
const md = (src: string, notes: string[] = []) => parseMd(src, '', notes);

// ---- 1. Google の書き出しの癖(2026-10-13 の調べの 21 例) ----

same('Q1 見出しの ** を外す・章の番号を読む・末尾の絵の定義は字にしない', md(
  '# **第1章　雨の日の図書室**\n\n本文。\n\n## **小見出し**\n\n本文二。\n\n# **あとがき**\n\nおわり。\n\n[image1]: <data:image/png;base64,iVBORw0KGgo=>',
), [
  { no: '第1章', title: '雨の日の図書室', blocks: ['p:本文。', 'h3:小見出し', 'p:本文二。'] },
  { title: 'あとがき', blocks: ['p:おわり。'] },
]);

same('Q2 見出しの一部の太字・斜体、{#…}、目次の行', md(
  '[第1章　出発](#第1章　出発)\n\n[小さな町](#小さな町)\n\n# 第1章　**出発** {#第1章　出発}\n\n## 次回: *10月5日*  {#小さな町}\n\nほんぶん。',
), [{ no: '第1章', title: '出発', blocks: ['h3:次回: 10月5日', 'p:ほんぶん。'] }]);

same('Q3 空の見出しと「# ---」は捨てる(# を刷らない)', md('# **プロローグ**\n\n# \n\n## \n\n# ---\n\nはじまり。'), [
  { title: 'プロローグ', blocks: ['p:はじまり。'] },
]);

{
  const src =
    '# **第一章　雨**\n\n\\> 引用の行。\n\n\\>\\> 雨宿　文\n\n\\*\\*\\*\n\n場面が変わる。\n\n\\---\n\n1\\. 一つめ  \n2\\. 二つめ\n\n\\- 項目\n\n\\# 第二章　晴れ\n\n本文。';
  ok(prepareMarkdown(src).google, 'Q4 Google の書き出しと見分ける(逃がし + 見出しがどれも **)');
  same('Q4 逃がした記法は構造になる(引用・行末寄せ・区切り線・番号つき・並び・章)', md(src), [
    {
      no: '第一章',
      title: '雨',
      blocks: ['quote:引用の行。', 'end:雨宿　文', 'hr', 'p:場面が変わる。', 'hr', 'list(ol):一つめ|二つめ', 'list:項目'],
    },
    { no: '第二章', title: '晴れ', blocks: ['p:本文。'] },
  ]);
}

same('Q5 行の中の逃がしを外す(ルビの全角の記号はそのまま)', md(
  '# **第1章　記号**\n\nANTHROPIC\\_API\\_KEY と Q\\&A と https\\://example.com と www\\.example.com\n\n\\[注\\] 5\\*3 と \\~ と 驚き\\! と C\\# と (2017\\) と a \\- b と a \\+ b と x \\= y と \\<u\\>下線\\</u\\> と \\\\ と \\`x\\`\n\n\\*\\*強調\\*\\*と｜漢字《かんじ》',
), [
  {
    no: '第1章',
    title: '記号',
    blocks: [
      'p:ANTHROPIC_API_KEY と Q&A と https://example.com と www.example.com',
      'p:[注] 5*3 と ~ と 驚き! と C# と (2017) と a - b と a + b と x = y と <u>下線</u> と \\ と x',
      'p:**強調**と｜漢字《かんじ》',
    ],
  },
]);

same('Q6 1行の絵の参照と末尾の定義 → 絵のブロック', md(`# **第2章　晴れた日**\n\n![][image1]\n\n画像の下の段落。\n\n[image1]: <${PNG}>`), [
  { no: '第2章', title: '晴れた日', blocks: ['image:png', 'p:画像の下の段落。'] },
]);

same('Q7 文の途中・並んだ絵・箇条書きの中の絵。同じ定義を2度使う。定義の無い参照は捨てる', md(
  `前の文![][image1]後の文  \n![][image1]![][image2]  \n* ![][image2]\n\n![][image9]\n\n[image1]: <${PNG}>\n\n[image2]: <${JPEG}>`,
), [{ title: '', blocks: ['p:前の文', 'image:png', 'p:後の文', 'image:png', 'image:jpeg', 'image:jpeg'] }]);

{
  const big = b64(28_000);
  const g = guardManuscript(md(`# 第1章　長い行\n\n本文。\n\n${big}\n\nつづき。`));
  same('Q8 どの .md も: とても長い base64 の行は段落にならない(見張りが取り除く)', g.manuscript, [
    { no: '第1章', title: '長い行', blocks: ['p:本文。', 'p:つづき。'] },
  ]);
  ok(!g.error && g.notes.length === 1, 'Q8 取り除いたことを言う', JSON.stringify(g.notes));
}

{
  const src = '# 第1章　朝\n\n一段落目。  \n二段落目。  \n三段落目。\n\n四段落目。  \n五段落目。\n\n\\*\\*\\*\n\n六段落目。';
  const prep = prepareMarkdown(src);
  ok(prep.google && prep.tight, 'Q9 段落を詰めた Google の文書と見分ける', JSON.stringify(prep.signals));
  same('Q9 段落を詰めた文書: 空行1つは書き手の空の段落 = 1行アキ', md(src), [
    {
      no: '第1章',
      title: '朝',
      blocks: ['p:一段落目。', 'p:二段落目。', 'p:三段落目。', 'space', 'p:四段落目。', 'p:五段落目。', 'hr', 'p:六段落目。'],
    },
  ]);
}

same('Q10 段落のあいだを空けた文書: 空行1つはただの段落の切れ目', md('# **第1章　夜**\n\n一。\n\n二。\n\n三。'), [
  { no: '第1章', title: '夜', blocks: ['p:一。', 'p:二。', 'p:三。'] },
]);
{
  // Google と見分けたうえで段落のあいだを空けた文書(絵がある)でも、空行1つは段落の切れ目
  const src = `# **第1章　夜**\n\n一。\n\n二。\n\n三。\n\n![][image1]\n\n[image1]: <${PNG}>`;
  const prep = prepareMarkdown(src);
  ok(prep.google && !prep.tight, 'Q10 絵のある Google の文書で、段落のあいだを空けた文書と見分ける');
  same('Q10 段落のあいだを空けた Google の文書', md(src), [
    { no: '第1章', title: '夜', blocks: ['p:一。', 'p:二。', 'p:三。', 'image:png'] },
  ]);
}

same('Q11 箇条書き: 後ろの「  」・空の項目・- と *・チェックボックス・「- ## x」', md(
  '# **第1章　持ち物**\n\n* 濡れた傘  \n* 読みかけの文庫本  \n* \n* のど飴\n\n- [ ] 宿題  \n- [x] ~~買い物~~  \n- ## 議題',
), [{ no: '第1章', title: '持ち物', blocks: ['list:濡れた傘|読みかけの文庫本|のど飴|宿題|~~買い物~~|議題'] }]);

same('Q12 入れ子の箇条書き(2・3字の字下げ)と「> > * 項目」', md(
  '# **第1章　入れ子**\n\n1. 一  \n   * 子  \n2. 二\n\n> > * 深い項目  \n> > * もう一つ',
), [{ no: '第1章', title: '入れ子', blocks: ['list(ol):一', 'list:子', 'list(ol):二', 'list:深い項目|もう一つ'] }]);

same('Q13 表: Google の区切り行・マスの中の改行(U+000B)・1マスの表', md('| 一行目\u000b二行目 |\n| :---- |\n\n| 名前 | 年 |\n| :---- | ----: |\n| 太郎 | 12 |'), [
  { title: '', blocks: ['p:一行目 二行目', 'p:名前　年', 'p:太郎　12'] },
]);

same('Q14 脚注: 本文の [^1] は外し、定義は中身を段落に(前と同じ)', md('# **第1章　注**\n\n本文[^1]です。\n\n[^1]:  注の中身'), [
  { no: '第1章', title: '注', blocks: ['p:本文です。', 'p:注の中身'] },
]);

same('Q15 コードブロック: 印の行は捨て、中は字のまま(逃がしも外さない)', md('# **第1章　コード**\n\n```\nlet a\\_b = 1;\n```'), [
  { no: '第1章', title: 'コード', blocks: ['p:let a\\_b = 1;'] },
]);

same('Q16 本文にじかに書いた data: の絵(Google の「Markdown としてコピー」の形)', md(`# **第1章　絵**\n\n![](${PNG})\n\n下の文。  \nもう一行。`), [
  { no: '第1章', title: '絵', blocks: ['image:png', 'p:下の文。', 'p:もう一行。'] },
]);

{
  const src = '---\ntitle: メモ\n---\n# 第1章　ふつう\n\n\\# 見出しではない\n\n\\> 引用ではない\n\n\\*注\\*';
  ok(!prepareMarkdown(src).google, 'Q17 YAML の前付けがあれば Google ではない');
  same('Q17 Google でない .md: 逃がした記号は構造にせず、字に戻す(\\ は刷らない)', md(src), [
    { no: '第1章', title: 'ふつう', blocks: ['p:# 見出しではない', 'p:> 引用ではない', 'p:*注*'] },
  ]);
}

same('Q18 行頭の全角空白は外し、かぎかっこ・引用符は残す。行頭のタブも外す', md('# **第1章　声**\n\n　「こんにちは」と“彼”は言った。  \n\tタブで始まる行。'), [
  { no: '第1章', title: '声', blocks: ['p:「こんにちは」と“彼”は言った。', 'p:タブで始まる行。'] },
]);

{
  const src = `---\n\n**本の題**  \n作者\n\n---\n\n# 第1章　始\n\n本文。\n\n![][image1]\n\n[image1]: <${PNG}>`;
  ok(prepareMarkdown(src).google, 'Q19 横線で始まる Google の文書と見分ける');
  same('Q19 横線で始まる文書: 次の --- までを前付けとして捨てない', md(src), [
    { title: '', blocks: ['p:**本の題**', 'p:作者', 'hr'] },
    { no: '第1章', title: '始', blocks: ['p:本文。', 'image:png'] },
  ]);
}

same('Q20 見出しの中の絵は、見出しのすぐあとへ', md(`# ![][image1] 第1章　表紙\n\n本文。\n\n[image1]: <${PNG}>`), [
  { no: '第1章', title: '表紙', blocks: ['image:png', 'p:本文。'] },
]);

same('Q21 空のチェックボックスの項目は捨て、印の付いた項目は字を残す', md('# 第1章　やること\n\n- [ ] \n- [x] 済\n- [ ] 未'), [
  { no: '第1章', title: 'やること', blocks: ['list:済|未'] },
]);

// ---- 2. 本物の書き出しの縮み版(2026-10-13 の原稿と同じ 30 行。146万字の絵だけ小さな PNG) ----
{
  const lines = [
    '# **第1章\u3000雨の日の図書室**',
    '',
    '放課後の図書室は、いつもより静かだった。窓をたたく雨の音だけが、**ここは太字**のように強く聞こえる。',
    '',
    '｜司書《ししょ》の先生は、カウンターの奥で本の背を整えていた。',
    '',
    '## **小見出しのテスト**',
    '',
    '持ってきたものは三つ。',
    '',
    '* 濡れた傘  ',
    '* 読みかけの文庫本  ',
    '* のど飴',
    '',
    '\\> 引用のテスト。行のあたまに記号を付けた書き方。',
    '',
    '\\*\\*\\*',
    '',
    '区切り線のあとの段落。場面が変わったつもり。',
    '',
    '# **第2章\u3000晴れた日の帰り道**',
    '',
    '![][image1]',
    '',
    '画像の下の段落。',
    '',
    '# **あとがき**',
    '',
    '最後まで読んでくださって、ありがとうございました。',
    '',
    `[image1]: <${PNG}>`,
  ];
  ok(lines.length === 31, '縮み版: 31 行(最後の行が絵の定義。改行で終わらない)');
  const notes: string[] = [];
  const ms = parseMd(lines.join('\n'), '第1章　雨の日の図書室', notes);
  ok(ms.chapters.length === 3, '縮み版: 3章', String(ms.chapters.length));
  const heads = ms.chapters.map((c) => [c.no ?? '', c.title]);
  ok(
    JSON.stringify(heads) === JSON.stringify([['第1章', '雨の日の図書室'], ['第2章', '晴れた日の帰り道'], ['', 'あとがき']]),
    '縮み版: 章の番号と題(** なし)',
    JSON.stringify(heads),
  );
  const types = ms.chapters.map((c) => c.blocks.map((b) => b.type).join(','));
  ok(types[0] === 'p,p,h3,p,list,quote,hr,p', '縮み版: 第1章は p/p/h3/p/list/quote/hr/p', types[0]);
  ok(types[1] === 'image,p', '縮み版: 第2章は絵のあとに段落', types[1]);
  ok(types[2] === 'p', '縮み版: あとがきは本文だけ(絵の定義が段落にならない)', types[2]);
  const img = ms.chapters[1].blocks[0];
  ok(img.type === 'image' && img.src === PNG, '縮み版: 絵の src は定義のデータそのもの');
  const texts = allText(ms);
  ok(!texts.some((t) => t.includes('\\')), '縮み版: どの字にも \\ が残らない', JSON.stringify(texts.filter((t) => t.includes('\\'))));
  ok(!texts.some((t) => /data:/i.test(t)), '縮み版: どの字にも data: が残らない');
  // ** は本文の太字の記法としてだけ残る(紙面では <em> になる)。章の番号・題・小見出しには残らない
  const headTexts = [...ms.chapters.flatMap((c) => [c.no ?? '', c.title]), ...ms.chapters.flatMap((c) => c.blocks.filter((b) => b.type === 'h3').map((b) => ('text' in b ? b.text : '')))];
  ok(!headTexts.some((t) => t.includes('*')), '縮み版: 章の番号・題・小見出しに * が残らない', JSON.stringify(headTexts));
  ok(texts.filter((t) => t.includes('**')).join('') === '放課後の図書室は、いつもより静かだった。窓をたたく雨の音だけが、**ここは太字**のように強く聞こえる。', '縮み版: ** は本文の太字の段落だけ');
  const body = manuscriptHtml(ms, defaultSettings()).replace(/<style[\s\S]*?<\/style>/g, '');
  ok(!body.includes('**') && !body.includes('\\'), '縮み版: 組んだ紙面に ** も \\ も出ない');
  ok(body.includes('<em>ここは太字</em>'), '縮み版: 本文の ** は太字になる');
  ok(
    JSON.stringify([...body.matchAll(/data-plain="([^"]*)"/g)].map((m) => m[1])) === JSON.stringify(['雨の日の図書室', '晴れた日の帰り道', 'あとがき']),
    '縮み版: 柱の字に ** が出ない',
  );
  ok(notes.length === 1 && notes[0] === gdocsMdNote(1), '縮み版: 絵のきめが足りないことを言う(1枚)', JSON.stringify(notes));
  ok(notes[0].includes('印刷すると粗く') && notes[0].includes('「ダウンロード」→「Microsoft Word（.docx）」'), '縮み版: 印刷には粗いことと、Word（.docx）でのダウンロードを言う', notes[0]);
  // 見張りに掛けても、もう取り除くものは無い
  const g = guardManuscript(ms);
  ok(!g.error && g.notes.length === 0, '縮み版: 見張りが取り除くものは残っていない', JSON.stringify(g.notes));
}

// ---- 3. 絵の受け入れ ----
{
  ok(acceptImageDataUri(PNG) === PNG, '絵: PNG は受ける');
  ok(acceptImageDataUri(JPEG) === JPEG, '絵: JPEG は受ける');
  ok(acceptImageDataUri(GIF) === null, '絵: GIF は受けない');
  ok(acceptImageDataUri('data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAEX/I/of') === null, '絵: WebP は受けない');
  ok(acceptImageDataUri('data:image/png;base64,AAAAAAAAAAAAAAAA') === null, '絵: PNG と名乗っても中身の頭が PNG でなければ受けない');
  ok(acceptImageDataUri('data:image/png;base64,') === null, '絵: 中身が空なら受けない');
  ok(acceptImageDataUri('data:image/png;base64,iVBO Rw0K') === null, '絵: base64 でない字が混ざれば受けない');
  ok(acceptImageDataUri('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=') === null, '絵: SVG は受けない');
  ok(acceptImageDataUri('data:application/octet-stream;base64,iVBORw0KGgoAAAANSUhEUg==') === null, '絵: 種類が画像でなければ受けない');
  const swapped = acceptImageDataUri(`data:image/png;base64,${JPEG.split(',')[1]}`);
  ok(swapped === JPEG, '絵: 中身が JPEG なら、名前を image/jpeg に直して受ける', String(swapped).slice(0, 40));
  ok(acceptImageDataUri(`data:image/jpg;base64,${JPEG.split(',')[1]}`) === JPEG, '絵: image/jpg は image/jpeg に直す');
  ok(acceptImageDataUri('data:IMAGE/PNG;base64,' + PNG.split(',')[1]) === PNG, '絵: 種類の大文字は小文字に直す');

  const notes: string[] = [];
  const ms = md(
    [
      '# 第1章　絵',
      '',
      '![GIF](' + GIF + ')',
      '',
      '![][bad]',
      '',
      '![ファイル](images/a.png)',
      '',
      '![ネット](https://example.com/a.png "題")',
      '',
      '![[Pasted image 20261013.png]]',
      '',
      '![図][fig]',
      '',
      '本文。',
      '',
      '[注1]: 説明文',
      '',
      '[fig]: images/fig.png',
      '',
      '[bad]: <data:image/png;base64,AAAAAAAAAAAAAAAA>',
    ].join('\n'),
    notes,
  );
  same('絵: 取れない絵はどれも外す。絵の参照する場所の定義は外し、ほかの定義の行は本文のまま', ms, [
    { no: '第1章', title: '絵', blocks: ['p:本文。', 'p:[注1]: 説明文'] },
  ]);
  ok(
    JSON.stringify(notes) === JSON.stringify([mdImageFormatNote(2), mdImageLinkedNote(4)]),
    '絵: 読めない絵 2枚・場所や URL の絵 4枚を言う(Google でないので、きめの話はしない)',
    JSON.stringify(notes),
  );
  ok(!allText(ms).some((t) => t.includes('![') || /data:/.test(t)), '絵: 絵の書き方とデータが字に残らない');

  // リンクで包んだ絵(Web クリップの形)は、包みのリンクごと外す([ や ](…) を残さない)
  {
    const n: string[] = [];
    same('絵: リンクで包んだ絵は包みごと外す', md('前の文。[![](https://example.com/a.png)](https://example.com/a)\n\n後の文。', n), [
      { title: '', blocks: ['p:前の文。', 'p:後の文。'] },
    ]);
    ok(JSON.stringify(n) === JSON.stringify([mdImageLinkedNote(1)]), '絵: リンクで包んだ URL の絵も数える', JSON.stringify(n));
  }
  // 太字の中の絵・太字をまたぐ絵
  same('絵: **![][image1]** は絵だけ。太字の途中の絵は、切れ目で太字を閉じて開き直す', md(
    `**![][image1]**\n\n**前![][image1]後**\n\n~~消し![][image1]線~~\n\n[image1]: <${PNG}>`,
  ), [{ title: '', blocks: ['image:png', 'p:**前**', 'image:png', 'p:**後**', 'p:~~消し~~', 'image:png', 'p:~~線~~'] }]);
  // 引用・番号つきの行の中の絵: 前の字は同じ形のまま、後ろの字はふつうの段落
  same('絵: 引用と番号つきの行の中の絵', md(`> 前![](${PNG})後\n\n1. 項目![](${PNG})`), [
    { title: '', blocks: ['quote:前', 'image:png', 'p:後', 'list(ol):項目', 'image:png'] },
  ]);
  // 絵の前の1行アキ(空行2つ)は絵の前に入る
  same('絵: 空行2つのあとの絵は、1行アキのあとに入る', md(`本文。\n\n\n![](${PNG})`), [{ title: '', blocks: ['p:本文。', 'space', 'image:png'] }]);
  // 定義を外した跡に空行2つを残さない(1行アキにしない)
  same('絵: 段落のあいだの定義の行を外しても1行アキにならない', md(`一。\n\n[image1]: <${PNG}>\n\n二。`), [{ title: '', blocks: ['p:一。', 'p:二。'] }]);
}

// ---- 4. 逃がし \X ----
{
  ok(unescapeMarkdown('a\\_b `c\\_d` e\\*') === 'a_b `c\\_d` e*', '逃がし: コード `…` の中は外さない');
  ok(unescapeMarkdown('``a\\_`b`` c\\_') === '``a\\_`b`` c_', '逃がし: 2つの ` で囲んだコードの中の ` も字のまま');
  ok(unescapeMarkdown('\\｜漢字《かんじ》\\《') === '\\｜漢字《かんじ》\\《', '逃がし: 全角の記号の前の \\ には触らない');
  ok(unescapeMarkdown('C:\\Users\\name') === 'C:\\Users\\name', '逃がし: 記号でない字の前の \\ は字のまま');

  // Google でない .md: 構造にはしない。字には \ を残さない
  same('Google でない .md: 1\\. は番号つきにしない・\\- は並びにしない・\\*\\*\\* は線にしない', md('1\\. 一つめ\n\n\\- 項目\n\n\\*\\*\\*\n\n\\>\\> 署名'), [
    { title: '', blocks: ['p:1. 一つめ', 'p:- 項目', 'p:***', 'p:>> 署名'] },
  ]);
  same('Google でない .md: \\\\ は \\ 1つ。コードの中の \\ は残す', md('a\\\\b と `c\\_d` と e\\_f'), [{ title: '', blocks: ['p:a\\b と c\\_d と e_f'] }]);
  same('Google でない .md: 見出しの中の逃がし(\\# も ** も字のまま)', md('# 第1章　C\\# と \\*\\*\n\n## 見出し\\_一'), [
    { no: '第1章', title: 'C# と **', blocks: ['h3:見出し_一'] },
  ]);
  same('Google でない .md: 箇条書き・引用・表の中の逃がし', md('- A\\_B\n\n> 引\\*用\n\n| a\\|b | c |'), [
    { title: '', blocks: ['list:A_B', 'quote:引*用', 'p:a|b　c'] },
  ]);
  same('Google でない .md: ルビの記号はそのまま', md('｜司書《ししょ》と|漢字《かんじ》'), [{ title: '', blocks: ['p:｜司書《ししょ》と|漢字《かんじ》'] }]);

  // Google: https\:// はリンクになる字に戻る
  const g = md('# **第1章　リンク**\n\n[サイト](https\\://example.com/a\\_b) と https\\://example.com');
  same('Google: リンクの中の逃がしも外す', g, [
    { no: '第1章', title: 'リンク', blocks: ['p:[サイト](https://example.com/a_b) と https://example.com'] },
  ]);
  // Google でない .md は、ふつうの原稿のまま見分けない
  for (const src of ['- A\n\n- B\n\n・C', '１．A\n\n２．B', '# 第1章\n\n本文。\n\n本文二。', '# 題\n\n本文\\。']) {
    ok(!detectGoogleDocs(src.split('\n')).google, `見分け: ふつうの .md は Google ではない ${JSON.stringify(src)}`);
  }
  ok(!detectGoogleDocs(['# メモ', '', '\\# ハッシュタグ', '', '保存先は `C:\\out\\<名前>` です']).google, '見分け: Web クリップの逃がしとコードの中の \\ では Google にしない');
  ok(detectGoogleDocs(['本文 https\\://example.com']).google, '見分け: https\\:// は Google');

  // Google でない .md: 構造や飾りにならない記号の前の \ は、打ったまま刷る(前の md.ts・.txt と同じ。2026-10-13 見直し)
  same('Google でない .md: 顔文字の \\( や \\/ は、\\ ごと残す', md('やったー\\(^o^)/ と叫んだ。\\/\\/ も \\"引用\\" も \\? も。'), [
    { title: '', blocks: ['p:やったー\\(^o^)/ と叫んだ。\\/\\/ も \\"引用\\" も \\? も。'] },
  ]);
  same('Google でない .md: 文の途中の 1\\. の \\ は残し、行頭の 1\\. と 2\\) は番号つきにしない', md('1\\. 一\n\n2\\) 二\n\nver1\\.2'), [
    { title: '', blocks: ['p:1. 一', 'p:2) 二', 'p:ver1\\.2'] },
  ]);
}

// ---- 4b. Google でない .md を Google の書き出しと見分けない(2026-10-13 見直し) ----
{
  // 行末の「  」(Markdown のふつうの改行)だけでは Google にしない。段落のあいだの空行を1行アキにしない
  const verse = '# 詩\n\n春の雨  \n夏の雲  \n秋の月\n\n冬の雪  \n春の花\n\nおわり。';
  ok(!prepareMarkdown(verse).google, '見分け: 行末に「  」のある詩は Google ではない', JSON.stringify(prepareMarkdown(verse).signals));
  same('行末に「  」のある詩: 空行1つは1行アキにしない', md(verse), [
    { title: '詩', blocks: ['p:春の雨', 'p:夏の雲', 'p:秋の月', 'p:冬の雪', 'p:春の花', 'p:おわり。'] },
  ]);
  const hard = '# 第一章　朝\n\n朝が来た。  \n鳥が鳴いた。\n\n昼が来た。  \n日が照った。\n\n夜が来た。  \n星が出た。';
  ok(!prepareMarkdown(hard).google, '見分け: 行末に「  」のある小説は Google ではない');
  same('行末に「  」のある小説: 段落のあいだに1行アキが入らない', md(hard), [
    { no: '第一章', title: '朝', blocks: ['p:朝が来た。', 'p:鳥が鳴いた。', 'p:昼が来た。', 'p:日が照った。', 'p:夜が来た。', 'p:星が出た。'] },
  ]);
  // 詰めた文書でも、ほかの手がかり(見出しがどれも **)があれば Google
  ok(prepareMarkdown('# **第1章　朝**\n\n一。  \n二。  \n三。  \n四。\n\n五。').google, '見分け: 詰めた文書 + 見出しがどれも ** なら Google');

  // `| ---- | ---- |`(Typora・Prettier)は Google の表の区切り行と見ない。逃がした記号は字のまま
  const typora = '# 第一章　登場人物\n\n| 名前 | 年齢 |\n| ---- | ---- |\n| 太郎 | 12   |\n\n\\# タグの話\n\n\\- ハイフンで始まる台詞\n\n\\> 引用ではない\n\n本文。';
  ok(!prepareMarkdown(typora).google, '見分け: | ---- | の表は Google ではない', JSON.stringify(prepareMarkdown(typora).signals));
  same('| ---- | の表の .md: \\# \\- \\> は章・並び・引用にしない', md(typora), [
    { no: '第一章', title: '登場人物', blocks: ['p:名前　年齢', 'p:太郎　12', 'p:# タグの話', 'p:- ハイフンで始まる台詞', 'p:> 引用ではない', 'p:本文。'] },
  ]);
  ok(detectGoogleDocs(['| 名前 | 年 |', '| :---- | ----: |']).google, '見分け: | :---- | の表は Google');
}

// ---- 4c. 見出し・絵・箇条書きの見直し(2026-10-13) ----
{
  // 記号だけの見出しは、題の無い章の切れ目として残す
  same('見出し: # * * * は章の切れ目のまま(題もそのまま)', md('# * * *\n\n一つめの話。\n\n# * * *\n\n二つめの話。'), [
    { title: '* * *', blocks: ['p:一つめの話。'] },
    { title: '* * *', blocks: ['p:二つめの話。'] },
  ]);
  same('見出し: # *** と ## *** も字のまま', md('# ***\n\n一。\n\n## ***\n\n二。'), [{ title: '***', blocks: ['p:一。', 'h3:***', 'p:二。'] }]);
  same('見出し: Google の書き出しで書き手が打った # \\*\\*\\* も章のまま。Google の # --- は捨てる', md(
    `# **第1章　始**\n\n本文。\n\n# \\*\\*\\*\n\n一つめ。\n\n# ---\n\n二つめ。\n\n![][image1]\n\n[image1]: <${PNG}>`,
  ), [
    { no: '第1章', title: '始', blocks: ['p:本文。'] },
    { title: '***', blocks: ['p:一つめ。', 'p:二つめ。', 'image:png'] },
  ]);
  // 対になっていない ~~ と ** は、Google でない .md の見出しでは字のまま(Google の書き出しでは外す)
  same('見出し: Google でない .md の ~~ は字のまま', md('# おまけ~~\n\n## やったー~~\n\n本文~~です。'), [
    { title: 'おまけ~~', blocks: ['h3:やったー~~', 'p:本文~~です。'] },
  ]);
  same('見出し: Google の書き出しでは、対になっていない ** を外す', md(`# **第1章　雨**\n\n## **小見出し![][image1]**後\n\n[image1]: <${PNG}>`), [
    { no: '第1章', title: '雨', blocks: ['h3:小見出し後', 'image:png'] },
  ]);

  // 取れない絵は外すだけで、文は切らない
  {
    const n: string[] = [];
    same('絵: 取れない絵をはさんだ文は1つの段落のまま', md('この![](icon.png)ボタンを押すと、画面が切り替わります。\n\n**前の文![](x.png)後の文**\n\n* 項目![](y.png)のつづき', n), [
      { title: '', blocks: ['p:このボタンを押すと、画面が切り替わります。', 'p:**前の文後の文**', 'list:項目のつづき'] },
    ]);
    ok(JSON.stringify(n) === JSON.stringify([mdImageLinkedNote(3)]), '絵: 外した絵の数は言う', JSON.stringify(n));
  }
  same('絵: Google の書き出しの、定義の無い参照も文を切らない', md(`# **第1章**\n\n雨が![][image9]降った。\n\n前![][image9]中![][image1]後\n\n[image1]: <${PNG}>`), [
    { no: '第1章', title: '', blocks: ['p:雨が降った。', 'p:前中', 'image:png', 'p:後'] },
  ]);

  // Obsidian の ![[…]]: 絵のファイルだけ絵として数える。ノートの埋め込みは字のまま残す
  {
    const n: string[] = [];
    same('絵: Obsidian の ![[第1章]](ノートの埋め込み)は字のまま', md('# 本\n\n![[第1章]]\n\n![[第2章#あらすじ]]\n\n![[表紙.PNG|300]]\n\n![[地図.jpeg]]', n), [
      { title: '本', blocks: ['p:![[第1章]]', 'p:![[第2章#あらすじ]]'] },
    ]);
    ok(JSON.stringify(n) === JSON.stringify([mdImageLinkedNote(2)]), '絵: Obsidian の絵のファイル(.PNG|300・.jpeg)だけ、取り込めなかった数に入れる', JSON.stringify(n));
  }

  // <img src="…">(HTML の書き方)
  {
    const n: string[] = [];
    same('絵: <img src="data:…"> は絵のブロックに。場所の <img> は外す', md(
      `# 第一章 はじまり\n\n<img src="${PNG}">\n\n前<IMG alt="図" src='${JPEG}' style="zoom:50%">後\n\n<img src="assets/a.png" width="300">\n\n<img src="${GIF}">\n\n続き。`,
      n,
    ), [{ no: '第一章', title: 'はじまり', blocks: ['image:png', 'p:前', 'image:jpeg', 'p:後', 'p:続き。'] }]);
    ok(JSON.stringify(n) === JSON.stringify([mdImageFormatNote(1), mdImageLinkedNote(1)]), '絵: <img> の読めない絵と場所の絵も数を言う', JSON.stringify(n));
    const g = guardManuscript(md(`# 第一章\n\n<img src="${PNG}">\n\n続き。`));
    ok(g.notes.length === 0 && !JSON.stringify(g.manuscript).includes('<img'), '絵: <img src="data:…"> は見張りに残り物を渡さない(紙面に <img が出ない)', JSON.stringify(g.notes));
  }

  // 空の項目: 箇条書きの中だけ捨てる。空行に挟まれた `* ` は場面転換の印かもしれないので残す
  same('箇条書き: 空行に挟まれた「* 」(後ろに空白)は残す', md('前の場面。\n\n* \n\n次の場面。'), [{ title: '', blocks: ['p:前の場面。', 'p:*', 'p:次の場面。'] }]);
  same('箇条書き: 項目のあいだの空の項目は捨てる', md('* 一\n* \n* 二\n\n1. 三\n2. \n\n終わり。'), [{ title: '', blocks: ['list:一|二', 'list(ol):三', 'p:終わり。'] }]);
}

// ---- 4d. Google の書き出しと見分けたときの知らせ(2026-10-13 見直し) ----
{
  const n0: string[] = [];
  md('# **第1章　雨**\n\n一。\n\n\\> 引用。', n0);
  ok(JSON.stringify(n0) === JSON.stringify([gdocsMdNote(0)]), 'Google の書き出し: 絵が無くても Word（.docx）をすすめる(1つだけ)', JSON.stringify(n0));
  ok(!gdocsMdNote(0).includes('粗く') && gdocsMdNote(0).includes('抜けることがあります') && gdocsMdNote(0).includes('Microsoft Word（.docx）'), 'Google の書き出し: 絵が無いときは、きめの話をせず、抜けることと Word を言う');
  ok(gdocsMdNote(2).includes('画像 2枚') && gdocsMdNote(2).includes('粗く') && gdocsMdNote(2).includes('抜けることがあります'), 'Google の書き出し: 絵があるときは、きめと抜けることを1つの文で言う');
  const n1: string[] = [];
  md('# 第1章\n\n一。\n\n二。', n1);
  ok(n1.length === 0, 'Google でない .md では何も言わない', JSON.stringify(n1));
}

// ---- 5. 前付け・コードブロック・目次・入れ子の引用など ----
{
  same('前付け: YAML でなければ捨てない(---/A/---/B で A を落とさない)', md('---\nA\n---\nB'), [{ title: '', blocks: ['p:A', 'hr', 'p:B'] }]);
  same('前付け: Obsidian の前付け(字下げの続き・- の並び)は外す', md('---\ntitle: メモ\ntags:\n  - 日記\n- 下書き\naliases: []\n---\n本文'), [{ title: '', blocks: ['p:本文'] }]);
  // キーに空白のある前付け(Obsidian の Linter)と、行をまたぐ [ … ] も外す(前の md.ts と同じ。2026-10-13 見直し)
  same('前付け: キーに空白のある前付けを外す', md('---\ndate created: 2026-10-01 10:00\ndate modified: 2026-10-12 09:00\ntags: 小説\n---\n\n# 第一章　始まり\n\n本文。'), [
    { no: '第一章', title: '始まり', blocks: ['p:本文。'] },
  ]);
  same('前付け: 行をまたぐ tags: [ … ] の前付けを外す', md('---\ntitle: x\ntags: [\n  小説,\n  下書き\n]\n---\n\n# 第一章　始まり\n\n本文。'), [
    { no: '第一章', title: '始まり', blocks: ['p:本文。'] },
  ]);
  same('前付け: # の注釈から始まる前付けも外す', md('---\n# メモ\ntitle: x\n---\n本文'), [{ title: '', blocks: ['p:本文'] }]);
  ok(frontMatterEnd(['---', '# 第1章', '---']) === -1, '前付け: 注釈の形の行しか無ければ前付けではない');
  ok(frontMatterEnd(['---', 'https://example.com', '---']) === -1, '前付け: URL の行は key: と見ない');
  ok(frontMatterEnd(['---', 'title: x', '---', 'B']) === 2, '前付け: YAML の key: 値 なら閉じの行');
  ok(frontMatterEnd(['---', '本の題', '---']) === -1, '前付け: ふつうの字なら前付けではない');
  ok(frontMatterEnd(['---', '', '---']) === -1, '前付け: 中が空なら前付けではない');
  ok(frontMatterEnd(['---', '', 'title: x', '---']) === -1, '前付け: --- のすぐ次が空行なら前付けではない(Google の横線)');
  same('前付け: 横線で始まり「作者: 山田」と書いた扉を捨てない', md('---\n\n作者: 山田\n\n---\n\n# 第1章　始\n\n本文。'), [
    { title: '', blocks: ['p:作者: 山田', 'hr'] },
    { no: '第1章', title: '始', blocks: ['p:本文。'] },
  ]);

  same('コード: 閉じていない ``` は印だけ捨て、あとは普通に読む', md('```\n# 第1章　題\n本文'), [{ no: '第1章', title: '題', blocks: ['p:本文'] }]);
  same('コード: 中の # や - は見出し・箇条書きにしない', md('# 第1章　題\n\n```js\n# コメント\n- a\n```\n\n本文'), [
    { no: '第1章', title: '題', blocks: ['p:# コメント', 'p:- a', 'p:本文'] },
  ]);
  same('目次の行は捨て、行の中の [字](#…) は字だけ', md('[第1章](#ch1) [第2章](#ch2)\n\n# 第1章　題\n\n[第2章](#ch2)を見てください'), [
    { no: '第1章', title: '題', blocks: ['p:第2章を見てください'] },
  ]);
  same('引用: > > は1段に、>> は行末寄せのまま', md('> > 深い引用\n\n>> 署名'), [{ title: '', blocks: ['quote:深い引用', 'end:署名'] }]);
  same('見出し: 閉じの # と h4 以下(強調は残す)と # だけの行', md('# 第1章　題 #\n\n## 見出し ##\n\n#### **小さな見出し**\n\n#\n\n本文'), [
    { no: '第1章', title: '題', blocks: ['h3:見出し', 'p:**小さな見出し**', 'p:本文'] },
  ]);
  same('見出し: # のあとが全角空白でも見出し(前と同じ)', md('#　第1章　題\n\n##　小見出し\n\n本文'), [
    { no: '第1章', title: '題', blocks: ['h3:小見出し', 'p:本文'] },
  ]);
  same('箇条書き: * だけの行(空白なし)は場面転換の印かもしれないので残す', md('一。\n\n*\n\n二。'), [{ title: '', blocks: ['p:一。', 'p:*', 'p:二。'] }]);
  same('U+000B は空白に', md('一\u000b二'), [{ title: '', blocks: ['p:一 二'] }]);
}

// ---- 6. 小見出しの前の1行アキ(txt と同じに) ----
{
  same('md: 空行2つのあとの ## は、1行アキのあとに小見出し', md('本文\n\n\n## 小見出し\n本文二'), [
    { title: '', blocks: ['p:本文', 'space', 'h3:小見出し', 'p:本文二'] },
  ]);
  const t = parseTxt('本文\n\n## 小見出し\n本文二');
  ok(JSON.stringify(t.chapters[0].blocks.map(shape)) === JSON.stringify(['p:本文', 'space', 'h3:小見出し', 'p:本文二']), 'txt: 同じ形(空行1つで1行アキ)');
}

// ---- 7. 長い行でも遅くならない ----
{
  const payload = `iVBORw0KGgo${b64(1_500_000)}`;
  const src = `# **第1章　絵**\n\n![][image1]\n\n本文。\n\n[image1]: <data:image/png;base64,${payload}>`;
  const t0 = Date.now();
  const notes: string[] = [];
  const ms = md(src, notes);
  const took = Date.now() - t0;
  ok(took < 2000, `150万字の絵の定義を ${took}ms で読む(2 秒まで)`);
  same('150万字の絵の定義は絵のブロックになる', ms, [{ no: '第1章', title: '絵', blocks: ['image:png', 'p:本文。'] }]);
  const t1 = Date.now();
  const g = guardManuscript(md(`本文。\n\n${b64(1_500_000)}\n\nつづき。`));
  const took2 = Date.now() - t1;
  ok(took2 < 2000 && g.notes.length === 1, `150万字の base64 の段落を ${took2}ms で読んで取り除く(2 秒まで)`);
  // 閉じない ``` が多くても、開きの印ごとに全部の行を見直さない
  const fences = Array.from({ length: 40_000 }, (_, i) => (i % 2 ? '本文。' : '```js')).join('\n');
  const t2 = Date.now();
  const f = md(fences);
  const took3 = Date.now() - t2;
  ok(took3 < 2000 && f.chapters[0].blocks.length === 20_000 && f.chapters[0].blocks.every((b) => b.type === 'p'), `閉じない \`\`\` が2万個ある原稿を ${took3}ms で読む(2 秒まで)`);
}

// ---- 8. 柱(章題の data-plain) ----
{
  /** 前の柱の字の作り方(記法の無い章題では、いまも同じ字になること) */
  const before = (title: string) => title.replace(/《《([^》]+)》》/g, '$1').replace(/《[^》]*》/g, '').replace(/[｜|]/g, '');
  const plainTitles = ['第三章　青い背表紙', '｜司書《ししょ》の部屋', '《《傍点》》の章', 'A|B', '5*3の謎', 'あとがき', '雨と“傘”', '１２３'];
  const marked = [
    ['**雨の日**の図書室', '雨の日の図書室'],
    ['*斜体*と~~消し~~', '斜体と消し'],
    ['<u>下線</u>と<b>太</b>', '下線と太'],
    ['[リンク](https://example.com)と==印==', 'リンクと印'],
    ['**｜司書《ししょ》**', '司書'],
  ] as const;
  const ms: Manuscript = {
    title: '本',
    author: '',
    publisher: '',
    chapters: [...plainTitles, ...marked.map((m) => m[0])].map((title) => ({ title, blocks: [{ type: 'p', text: '本文。' }] })),
  };
  for (const vertical of [true, false]) {
    const s = { ...defaultSettings(), writingMode: vertical ? 'vertical' : 'horizontal' } as ReturnType<typeof defaultSettings>;
    const html = manuscriptHtml(ms, s);
    const plains = [...html.matchAll(/data-plain="([^"]*)"/g)].map((m) => m[1]);
    const label = vertical ? '縦' : '横';
    ok(plains.length === ms.chapters.length, `柱(${label}): 章の数だけある`, String(plains.length));
    plainTitles.forEach((t, i) => ok(plains[i] === before(t), `柱(${label}): 記法の無い章題は前と同じ ${t}`, plains[i]));
    marked.forEach(([t, want], i) => ok(plains[plainTitles.length + i] === want, `柱(${label}): ${t} → ${want}`, plains[plainTitles.length + i]));
    ok(html.includes('<em>雨の日</em>の図書室'), `柱(${label}): 章題そのものは太字のまま`);
  }
  ok(stripInlineMarks('ふつうの字') === 'ふつうの字', '柱: stripInlineMarks は記法の無い字を変えない');
  ok(stripInlineMarks('5*3') === '5*3', '柱: 対になっていない * は残す(章題にもそのまま刷られる)');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
