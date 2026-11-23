// Markdown の前付け(YAML front matter)から、書名・著者名・奥付の欄を読む検査。(2026-11-23)
//
// ## なぜ在るか
//
// refeel(縦書きの日記)が日記を Markdown の原稿にして渡すとき、著者名などを前付けに書いても、本ちゃかは前付けを
// 丸ごと捨てていたので、取り込んだあと画面で打ち直すしかなかった。前付けの決まったキーを読み、画面の欄が空のときの
// 初期値にする(読むのは src/importers/mdPrep.ts の readFrontMatter、使うのは md.ts の parseMd)。
//
// 確かめること:
//
// 1. 読むキー(snake_case): title・author・publisher・publish_date・printer・isbn・author_profile・colophon_extra
// 2. 値の書き方: 引用符なし・"…"(中の \n は改行)・'…'・行をまたぐ `key: |`・` #` の注釈・空の値と null
// 3. 書いてよいが使わないキー(url など)と知らないキーは読み捨てる。組版の行は前付けからは読まない
// 4. 1行の欄は改行を空白にまとめ、著者紹介と奥付に足す行は改行を残す
// 5. 前付けがない・YAML でない(---/A/---/B)ときは、今までどおり書名はファイル名・著者名は空
// 6. 読んだ欄が奥付の行(colophonRows)に出る
// 7. refeel の書き出しの形(JSON の文字列で書いた前付け)をそのまま読める
//
// 回し方: node scripts/private/run-tests.mjs public|partner
import { parseMd } from '../src/importers/md';
import { readFrontMatter } from '../src/importers/mdPrep';
import { colophonRows } from '../src/typeset/matter';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log('  ok  ' + name);
  } else {
    failed++;
    console.log('  NG  ' + name + (detail ? '  ' + detail : ''));
  }
}
const same = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(g === w, name, g === w ? '' : `\n      got:  ${g}\n      want: ${w}`);
};
const fm = (src: string) => readFrontMatter(src.split('\n'));
const NOW = new Date(2026, 10, 23);

// ---- 1. 読むキー ----
{
  const ms = parseMd(
    [
      '---',
      'title: 雨の日の図書室',
      'author: 雨宿 文',
      'publisher: あまやどり出版',
      'publish_date: 2026年11月23日 初版第1刷',
      'printer: 雨宿印刷',
      'isbn: 978-4-00-000000-0',
      'author_profile: |',
      '  1990年生まれ。',
      '',
      '  既刊に『晴れの日』。',
      'colophon_extra: |',
      '  第2版 2027年1月1日',
      '  装丁 雨宿 文',
      '---',
      '',
      '# 雨の日',
      '',
      '本文。',
    ].join('\n'),
    'ファイルの名前',
  );
  same('1 キーを欄に読む', { ...ms, chapters: undefined }, {
    title: '雨の日の図書室',
    author: '雨宿 文',
    publisher: 'あまやどり出版',
    published: '2026年11月23日 初版第1刷',
    printer: '雨宿印刷',
    isbn: '978-4-00-000000-0',
    authorProfile: '1990年生まれ。\n\n既刊に『晴れの日』。',
    colophonExtra: '第2版 2027年1月1日\n装丁 雨宿 文',
    chapters: undefined,
  });
  same('1 本文は今までどおり(前付けは本文に入らない)', ms.chapters, [{ title: '雨の日', blocks: [{ type: 'p', text: '本文。' }] }]);

  // 6. 奥付の行
  same('6 読んだ欄が奥付の行に出る', colophonRows(ms, NOW), [
    '発行日　2026年11月23日 初版第1刷',
    '著者　雨宿 文',
    '発行所　あまやどり出版',
    '印刷　雨宿印刷',
    'ISBN　978-4-00-000000-0',
    '第2版 2027年1月1日',
    '装丁 雨宿 文',
    '©2026 雨宿 文',
  ]);
}

// ---- 2. 値の書き方 ----
same('2 "…" の中の \\n は改行(著者紹介)', fm('author_profile: "1行目\\n2行目"'), { authorProfile: '1行目\n2行目' });
same('2 "…" の中の \\" は引用符', fm('title: "「雨」と\\"晴れ\\""'), { title: '「雨」と"晴れ"' });
same("2 '…' は引用符を外し、'' は ' 1つ", fm("author: 'O''Brien'"), { author: "O'Brien" });
same('2 引用符なしの値の ` #` から後ろは注釈', fm('author: 雨宿 文  # ペンネーム'), { author: '雨宿 文' });
same('2 引用符の中の # は字のまま', fm('title: "第#1号"'), { title: '第#1号' });
same('2 空の値・null・~ は入れない', fm('author:\npublisher: null\nprinter: ~\nisbn: ""'), {});
same('2 同じキーが2つあれば後ろのもの', fm('author: 甲\nauthor: 乙'), { author: '乙' });
same('2 閉じていない "…" は、引用符だけ外す', fm('title: "雨の日'), { title: '雨の日' });

// ---- 3. 読み捨てるキー ----
same(
  '3 url・知らないキー・camelCase は読み捨てる',
  fm('url: "https://refeel.day/e/abc"\nsource: https://refeel.day\nauthorProfile: 読まない\ntags: [日記]'),
  {},
);
same('3 組版の行は前付けから読まない', fm('typeset_credit: false\ntypesetCredit: false'), {});
same('3 知らないキーの | の中身は、次のキーとして読まない', fm('notes: |\n  author: 中身\nauthor: 外'), { author: '外' });
same('3 字下げした行(Obsidian の - の並び)はキーとして読まない', fm('tags:\n  - 日記\n  author: x'), {});

// ---- 4. 改行 ----
same('4 1行の欄の改行は空白にまとめる', fm('title: |\n  雨の日の\n  図書室'), { title: '雨の日の 図書室' });
same('4 | の前後の空行は落とす', fm('colophon_extra: |\n\n  第2版\n\nauthor: 甲'), { colophonExtra: '第2版', author: '甲' });

// ---- 5. 前付けがない・YAML でない ----
{
  const none = parseMd('# 第一章\n\n本文。', 'ファイルの名前');
  same('5 前付けがなければ書名はファイル名・著者名と版元は空、奥付の欄はない', { ...none, chapters: undefined }, {
    title: 'ファイルの名前',
    author: '',
    publisher: '',
    chapters: undefined,
  });
  const notYaml = parseMd('---\nauthor\n---\n本文。', 'ファイルの名前');
  ok(notYaml.author === '' && notYaml.title === 'ファイルの名前', '5 YAML でない ---/A/---(横線)は前付けとして読まない');
  const noTitle = parseMd('---\nauthor: 甲\n---\n本文。', 'ファイルの名前');
  ok(noTitle.title === 'ファイルの名前' && noTitle.author === '甲', '5 前付けに書名がなければ、書名はファイル名');
}

// ---- 7. refeel の書き出しの形 ----
{
  const ms = parseMd(
    [
      '---',
      'title: "太郎の日記"',
      'author: "太郎"',
      'period: "2026-06-01 〜 2026-07-01"',
      'source: "https://refeel.day"',
      'url: "https://refeel.day"',
      'exported_at: "2026-10-12"',
      '---',
      '',
      '# 2026年6月1日（月）　雨の日',
      '',
      '朝から雨。',
    ].join('\n'),
    '太郎の日記',
  );
  same('7 refeel の前付け: 書名と著者名だけ読み、ほかは捨てる', { ...ms, chapters: undefined }, {
    title: '太郎の日記',
    author: '太郎',
    publisher: '',
    chapters: undefined,
  });
  ok(ms.chapters.length === 1 && ms.chapters[0].title === '2026年6月1日（月）　雨の日', '7 refeel の原稿: 1日が1章');
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
