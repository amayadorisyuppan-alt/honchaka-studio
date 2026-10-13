// 原稿を組版へ渡す前の見張り(src/importers/guard.ts)と、保存の .json・自動保存から開くときの取り除き
// (src/project/file.ts の sanitize)の検査。(2026-10-13)
//
// ## なぜ在るか
//
// Google ドキュメントの［ダウンロード］→［Markdown（.md）］の原稿を取り込むと、絵が
// `[image1]: <data:image/png;base64,…>` という 146万字の1段落になって組版に渡り、紙面ができあがるまで
// 75〜80 分かかる見込みになった(画面は 2〜7 秒ずつ固まる)。自動保存がその段落を書くので、開き直しても止まる。
//
// 確かめること:
//
// - 字に置き換えた画像などのデータ(data URI と、2,000字以上の base64 らしい並び)だけを取り除く。
//   包み(`<…>`・`![…](…)`・`[id]: `・`<img src="…">`・`[字](…)`)ごと取り除き、跡の空白を詰める
// - 2026-10-13 見直しで足したもの: 短い data URI(説明の例)は残す・base64 の変種(-_)・1万字以上の ASCII の並び(16進など)・
//   76字ずつ折り返した base64(1行ずつの段落になったものも)を取り除く。146万字でも 2 秒かからない
// - 長い URL・英文・顔文字・「wwww」「8888」・日本語は残す(1,999字の base64 の並びも残す)
// - 取り除いたあと、5万字以上の段落は断る(章の名前と、改行が抜けていることを言う)。100万字以上は断る。30万字以上は知らせる
// - 字数は入口の画面と同じ数え方(countBodyChars。本に残るコラムページも入れる)
// - 保存の .json・自動保存から開くときも取り除いて知らせる(取り込んだ .md が残っていれば［原稿を組み直す］をすすめる)。
//   絵の実体(src)と、長いだけの本物の段落には触らない。組版が止まるほど大きい本は、開くときに知らせる
//
// .txt / .md / .docx の取り込みの入口(importers/load.ts)は mammoth を読むので、ここでは回さない
// (guardManuscript をそのまま呼ぶ。load.ts の parseSource はこれを通して、error があれば投げるだけ)。
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   node scripts/private/run-tests.mjs public      (ほかの検査と一緒に)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { countBodyChars, defaultSettings } from '../src/models/project';
import type { Block, Chapter, Manuscript, ProjectSettings } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import {
  ASCII_RUN_MIN,
  BASE64_RUN_MIN,
  DATA_URI_BARE_MIN,
  MAX_BLOCK_CHARS,
  MAX_TOTAL_CHARS,
  SLOW_TOTAL_CHARS,
  formatChars,
  guardManuscript,
  stripBlockBlobs,
  stripDataBlobs,
} from '../src/importers/guard';
import { parseMd } from '../src/importers/md';
import { parseTxt } from '../src/importers/txt';
import { fromProjectFile, sanitize, toProjectFile } from '../src/project/file';
import type { ProjectSnapshot } from '../src/project/file';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 200);

/** 決まった並びの base64 の字(英大文字・小文字・数字・+/ を全部含む) */
function b64(n: number, seed = 1): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = seed;
  let s = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += A[x % 64];
  }
  return s;
}
/** base64 の変種(URL 用。+/ の代わりに -_) */
const b64url = (n: number, seed = 1) => b64(n, seed).replace(/\+/g, '-').replace(/\//g, '_');
/** 16進の並び(小文字と数字だけ) */
function hex(n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return s.slice(0, n);
}
/** 小さな絵のデータ(中身 96字。包みの無いものは残す長さ) */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** 包みが無くても取り除く長さ(DATA_URI_BARE_MIN 字以上)の中身を持つ絵のデータ */
const LONG = `data:image/png;base64,iVBORw0KGgo${b64(DATA_URI_BARE_MIN, 3)}`;
/** Google ドキュメントの書き出しと同じ形の、大きな絵のデータ */
const BIG = `data:image/png;base64,iVBORw0KGgo${b64(200_000)}==`;
/** メールの添付のように 76字ずつ折り返した base64(合わせて 3,000字) */
const WRAPPED = (b64(3_000, 5).match(/.{1,76}/g) ?? []).join('\n');
const JP = '雨の日の図書室は、いつもより静かだった。窓の外では、紫陽花が濡れて光っている。';

// ---- 1. 取り除き(stripDataBlobs) ----
{
  const cases: [string, string, string, number][] = [
    ['data URI だけ', LONG, '', 1],
    ['文の間の data URI(空白で区切り)', `前の文 ${LONG} 後の文`, '前の文 後の文', 1],
    ['<data:…>', `前の文<${LONG}>後の文`, '前の文後の文', 1],
    ['![](data:…)', `前の文![図](${PNG})後の文`, '前の文後の文', 1],
    ['![](<data:…> "題")', `前の文 ![図](<${PNG}> "題") 後の文`, '前の文 後の文', 1],
    ['[image1]: <data:…>(Google の参照の定義)', `[image1]: <${BIG}>`, '', 1],
    ['[image1]: data:…(<> 無し)', `[image1]: ${PNG}`, '', 1],
    ['引数つき', `前 data:image/svg+xml;charset=utf-8;base64,${b64(DATA_URI_BARE_MIN)} 後`, '前 後', 1],
    ['大文字', `前 DATA:IMAGE/PNG;BASE64,${b64(DATA_URI_BARE_MIN)} 後`, '前 後', 1],
    ['2つ並び', `前 ${LONG} ${LONG} 後`, '前 後', 2],
    ['行の頭と終わり', ` ${LONG} 本文 ${LONG} `, '本文', 2],
    // 包みごと取り除く(前は中身だけ取って `<img src="">`・`[添付]()` が紙面に残った。2026-10-13 見直し)
    ['<img src="data:…">(タグごと)', `前の文<img src="${LONG}" width="300">後の文`, '前の文後の文', 1],
    ["<img alt='…' src='data:…'>(タグごと)", `前の文 <img alt='図' src='${LONG}'> 後の文`, '前の文 後の文', 1],
    ['[字](data:…)(絵でないデータへのリンク)', `前の文 [添付](data:application/pdf;base64,${b64(300)}) 後の文`, '前の文 後の文', 1],
    ['base64 の並び 2,000字', `前の文 ${b64(BASE64_RUN_MIN)} 後の文`, '前の文 後の文', 1],
    ['base64 の並び 2,000字(和文に直に)', `前の文${b64(BASE64_RUN_MIN)}後の文`, '前の文後の文', 1],
    ['base64 の変種(-_)の並び 2,000字', `前の文 ${b64url(BASE64_RUN_MIN)} 後の文`, '前の文 後の文', 1],
    ['16進の並び 1万字', `前の文 ${hex(ASCII_RUN_MIN)} 後の文`, '前の文 後の文', 1],
    ['記号まじりの ASCII の並び 1万字', `前の文 ${'a1!'.repeat(ASCII_RUN_MIN / 2)} 後の文`, '前の文 後の文', 1],
    ['76字ずつ折り返した base64', `一行目\n${WRAPPED}\n二行目`, '一行目\n二行目', 1],
    ['76字ずつ折り返した base64(段落のあいだ)', `一段落目\n\n${WRAPPED}\n\n二段落目`, '一段落目\n\n二段落目', 1],
  ];
  for (const [name, input, want, n] of cases) {
    const r = stripDataBlobs(input);
    ok(r.text === want && r.removed === n, `取り除く: ${name}`, show(r));
  }

  // 残すもの
  const longUrl =
    'https://example.com/search?' +
    Array.from({ length: 120 }, (_, i) => `q${i}=${b64(12, i + 2)}`).join('&') +
    '#' + 'section-2.3';
  ok(longUrl.length > BASE64_RUN_MIN, '長い URL は 2,000字を超える', String(longUrl.length));
  const english = Array.from({ length: 400 }, () => 'The quick brown fox jumps over the lazy dog 1234.').join(' ');
  const keep: [string, string][] = [
    ['base64 の並び 1,999字', `前の文 ${b64(BASE64_RUN_MIN - 1)} 後の文`],
    ['長い URL', `参照: ${longUrl} を見てください`],
    ['英文', english],
    ['顔文字と記号', '(^_^)/ ＼(^o^)／ m(_ _)m (*´▽｀*) orz '.repeat(200)],
    ['wwww(小文字だけ)', 'w'.repeat(3000)],
    ['8888(数字だけ)', '8'.repeat(3000)],
    ['AAAA(大文字だけ)', 'A'.repeat(3000)],
    ['小文字と数字だけ(16進の並び)', 'deadbeef0123'.repeat(300)],
    ['日本語', JP.repeat(200)],
    ['中身の無い data URI(説明の文)', 'data URI は data:image/png;base64, のあとに中身を書きます'],
    // 短い data URI は、本の中の説明の例かもしれないので残す(DATA_URI_BARE_MIN。2026-10-13 見直し)
    ['短い data URI(説明の例)', 'HTML では data:text/plain;base64,SGVsbG8= のように書くと「Hello」になります。'],
    ['短い data URI(コードの中の例)', '`data:image/gif;base64,R0lGODlhAQABAAAAACw=` と書きます'],
    ['短い data URI の <…>', `例: <${PNG}>`],
    ['短い data URI の <img>', `例: <img src="${PNG}" width="1">`],
    ['短い data URI へのリンク', '例: [こんにちは](data:text/plain;base64,SGVsbG8=)'],
    ['base64 の変種(-_)の並び 1,999字', `前の文 ${b64url(BASE64_RUN_MIN - 1)} 後の文`],
    ['16進の並び 9,999字', `前の文 ${hex(ASCII_RUN_MIN - 1)} 後の文`],
    ['顔文字(バックスラッシュ)', '＼(^o^)／ \\(^o^)/ ¯\\_(ツ)_/¯ '.repeat(200)],
    ['76字ずつ折り返した base64 の 1,900字(短い)', (b64(1_900, 5).match(/.{1,76}/g) ?? []).join('\n')],
    ['76字ずつの英数字の行(小文字と数字だけ)', Array.from({ length: 60 }, () => 'abcdefghij0123456789'.repeat(4).slice(0, 76)).join('\n')],
    ['base64 でない data URI', '例: data:text/plain,hello と書きます'],
    ['ただの data: の字', 'data: 2026年の集計'],
  ];
  for (const [name, input] of keep) {
    const r = stripDataBlobs(input);
    ok(r.text === input && r.removed === 0, `残す: ${name}`, show(r));
  }

  // 行ごと消すとき(コラムページの本文は空行で段落を分ける)
  const lines: [string, string, string][] = [
    ['段落と段落の間', `一段落目\n\n${LONG}\n\n二段落目`, '一段落目\n\n二段落目'],
    ['終わり', `一段落目\n\n${LONG}`, '一段落目'],
    ['頭', `${LONG}\n\n一段落目`, '一段落目'],
    ['続けて書いた行の間', `一行目\n${LONG}\n二行目`, '一行目\n二行目'],
    ['終わりの改行は残す', `一行目\n${LONG}\n`, '一行目\n'],
  ];
  for (const [name, input, want] of lines) {
    const r = stripDataBlobs(input);
    ok(r.text === want && r.removed === 1, `行ごと消す: ${name}`, show(r));
  }

  // 実物と同じ大きさ(146万字)でも速く終わる
  const huge = `[image1]: <data:image/png;base64,${b64(1_462_516)}>`;
  const t0 = Date.now();
  const r = stripDataBlobs(huge);
  const ms = Date.now() - t0;
  ok(r.text === '' && r.removed === 1, '146万字の参照の定義を取り除く', show(r));
  ok(ms < 2000, '146万字でも 2 秒かからない', `${ms}ms`);
  const t1 = Date.now();
  stripDataBlobs(JP.repeat(30_000)); // 117万字の日本語(取り除くものは無い)
  ok(Date.now() - t1 < 2000, '100万字を超える日本語の段落でも 2 秒かからない', `${Date.now() - t1}ms`);
  // 閉じていない <img と [字]( の包み(包みの残りを探して、146万字の中身を戻りながら探し直さない)
  for (const [name, input] of [
    ['閉じていない <img src="', `<img src="data:image/png;base64,${b64(1_462_516)}`],
    ['閉じていない [字](', `[添付](data:application/pdf;base64,${b64(1_462_516)}`],
    ['16進の並び 146万字', hex(1_462_516)],
    ['76字ずつ折り返した base64 146万字', (b64(1_462_516, 5).match(/.{1,76}/g) ?? []).join('\n')],
  ] as const) {
    const t = Date.now();
    const rr = stripDataBlobs(input);
    ok(Date.now() - t < 2000 && rr.removed === 1 && !/[A-Za-z0-9]{100}/.test(rr.text), `${name}でも 2 秒かからずに取り除く`, `${Date.now() - t}ms ${show(rr.text)}`);
  }
}

// ---- 2. ブロックと章(guardManuscript の取り除き) ----
const ms = (chapters: Chapter[]): Manuscript => ({ title: '本', author: '', publisher: '', chapters });
const p = (text: string): Block => ({ type: 'p', text });
{
  // 1行アキに挟まれていたら1つにする。章の終わりには残さない
  const r1 = stripBlockBlobs([p('一'), { type: 'space' }, p(LONG), { type: 'space' }, p('二')]);
  ok(show(r1.blocks) === show([p('一'), { type: 'space' }, p('二')]) && r1.removed === 1, 'アキに挟まれた段落を外すとアキは1つ', show(r1.blocks));
  const r2 = stripBlockBlobs([p('一'), { type: 'space' }, p(LONG)]);
  ok(show(r2.blocks) === show([p('一')]), '章の終わりの段落を外すと、前のアキも外す', show(r2.blocks));
  const r3 = stripBlockBlobs([p(LONG), { type: 'space' }, p('一')]);
  ok(show(r3.blocks) === show([p('一')]), '章の頭の段落を外すと、後ろのアキも外す', show(r3.blocks));
  const plain = [p('一'), { type: 'space' } as Block, p('二')];
  ok(stripBlockBlobs(plain).blocks === plain, '取り除くものが無ければ同じ配列を返す');
  // 折り返した base64 が1行ずつの段落になったもの(.txt)は、つづきをまとめて外して1か所と数える(2026-10-13 見直し)
  const r4 = stripBlockBlobs([p('一'), { type: 'space' }, ...WRAPPED.split('\n').map(p), { type: 'space' }, p('二')]);
  ok(show(r4.blocks) === show([p('一'), { type: 'space' }, p('二')]) && r4.removed === 1, '折り返した base64 の段落のつづきを外す(1か所)', show(r4));

  const chapters: Chapter[] = [
    {
      no: '第1章',
      title: '雨の日の図書室',
      blocks: [
        p(JP),
        { type: 'h3', text: `小見出し ${LONG}` },
        { type: 'quote', text: `引用${LONG}` },
        { type: 'list', items: ['濡れた傘', LONG, `長靴 ${LONG}`] },
        { type: 'image', src: PNG, alt: `説明 ${LONG}`, caption: LONG },
        { type: 'hr' },
        p(JP),
      ],
    },
    { title: `${LONG}`, blocks: [p(JP)] },
    // Google ドキュメントの書き出しは、参照の定義が最後の章の終わりに段落として入る
    { title: 'あとがき', blocks: [p('読んでくださって、ありがとうございました。'), p(`[image1]: <${BIG}>`)] },
  ];
  const before = JSON.stringify(chapters);
  const g = guardManuscript(ms(chapters));
  const [c1, c2, c3] = g.manuscript.chapters;
  ok(JSON.stringify(chapters) === before, '渡した原稿は書き換えない');
  ok(!g.error, '取り除いたあとは断らない', show(g.error));
  ok(g.manuscript.chapters.length === 3, '章の数は変わらない');
  ok(c1.no === '第1章' && c1.title === '雨の日の図書室', '章の題はそのまま');
  ok(show(c1.blocks[1]) === show({ type: 'h3', text: '小見出し' }), '小見出しから取り除く', show(c1.blocks[1]));
  ok(show(c1.blocks[2]) === show({ type: 'quote', text: '引用' }), '引用から取り除く', show(c1.blocks[2]));
  ok(show(c1.blocks[3]) === show({ type: 'list', items: ['濡れた傘', '長靴'] }), '箇条書き: データだけの項目は外す', show(c1.blocks[3]));
  const img = c1.blocks[4];
  ok(img.type === 'image' && img.src === PNG && img.alt === '説明' && !('caption' in img), '絵: src はそのまま、説明だけ直す', show(img));
  ok(c2.title === '' && c2.blocks.length === 1, 'データだけの章の題は空にする(章は残す)', show(c2));
  ok(c3.blocks.length === 1 && c3.blocks[0].type === 'p', 'あとがきの参照の定義の段落を外す', show(c3.blocks));
  ok(g.notes.length === 1 && g.notes[0].includes('8か所'), '取り除いた数を1つの知らせで言う', show(g.notes));

  const clean = ms([{ title: '一', blocks: [p(JP)] }]);
  const gc = guardManuscript(clean);
  ok(gc.manuscript === clean && gc.notes.length === 0 && !gc.error, '何も無ければ、渡した原稿そのままで何も言わない');
}

// ---- 3. 大きさ ----
{
  const para = (n: number) => '字'.repeat(n);
  // 1つの段落
  const under = guardManuscript(ms([{ title: 'あとがき', blocks: [p(para(MAX_BLOCK_CHARS - 1))] }]));
  ok(!under.error, `段落 ${MAX_BLOCK_CHARS - 1}字は通す`, show(under.error));
  const at = guardManuscript(ms([{ title: '一', blocks: [p('短い')] }, { title: 'あとがき', blocks: [p('短い'), p(para(MAX_BLOCK_CHARS))] }]));
  ok(!!at.error && at.error.includes('「あとがき」の章') && at.error.includes('5万字') && at.error.includes('改行'), `段落 ${MAX_BLOCK_CHARS}字は断る(章と改行の抜けを言う)`, show(at.error));
  const titled = guardManuscript(ms([{ no: '第2章', title: '**晴れた日の帰り道**', blocks: [p(para(146 * 10_000 + 2_769))] }]));
  ok(!!titled.error && titled.error.includes('「第2章　晴れた日の帰り道」の章') && titled.error.includes('146万字'), '章の名前は記号を外して言う', show(titled.error));
  const noTitle = guardManuscript(ms([{ title: '', blocks: [p(para(MAX_BLOCK_CHARS))] }]));
  ok(!!noTitle.error && noTitle.error.startsWith('原稿に'), '章立ての無い原稿は「原稿」と言う', show(noTitle.error));
  const second = guardManuscript(ms([{ title: '', blocks: [p('一')] }, { title: '', blocks: [p(para(MAX_BLOCK_CHARS))] }]));
  ok(!!second.error && second.error.startsWith('2番目の章に'), '題の無い章は何番目かで言う', show(second.error));
  const item = guardManuscript(ms([{ title: '一', blocks: [{ type: 'list', items: ['短い', para(MAX_BLOCK_CHARS)] }] }]));
  ok(!!item.error, '箇条書きの1項目も段落として見る', show(item.error));
  // base64 の並びは取り除いてから見る(断らずに取り込む)
  const blob = guardManuscript(ms([{ title: '一', blocks: [p(`本文${b64(60_000)}`)] }]));
  ok(!blob.error && blob.manuscript.chapters[0].blocks.length === 1 && blob.notes.length === 1, 'base64 の並びは取り除いてから大きさを見る', show(blob));

  // 原稿全体(1千字の段落を並べる)
  const book = (n: number) => {
    const blocks: Block[] = [];
    for (let left = n; left > 0; left -= 1000) blocks.push(p(para(Math.min(1000, left))));
    return ms([{ title: '一', blocks }]);
  };
  const slowUnder = guardManuscript(book(SLOW_TOTAL_CHARS - 1));
  ok(!slowUnder.error && slowUnder.notes.length === 0, `${SLOW_TOTAL_CHARS - 1}字は何も言わない`, show(slowUnder.notes));
  const slow = guardManuscript(book(SLOW_TOTAL_CHARS));
  ok(!slow.error && slow.notes.length === 1 && slow.notes[0].includes('30万字') && slow.notes[0].includes('数分'), `${SLOW_TOTAL_CHARS}字は時間がかかると知らせる`, show(slow.notes));
  const big = guardManuscript(book(MAX_TOTAL_CHARS - 1));
  ok(!big.error && big.notes.length === 1, `${MAX_TOTAL_CHARS - 1}字は通す(知らせる)`, show(big.error));
  const tooBig = guardManuscript(book(MAX_TOTAL_CHARS));
  ok(!!tooBig.error && tooBig.error.includes('100万字') && tooBig.error.includes('分けて'), `${MAX_TOTAL_CHARS}字は断る(分けるよう言う)`, show(tooBig.error));
  // 入口の画面と同じ数え方(章の題は数えない。引用・箇条書きは数える)
  const mixed: Chapter[] = [{ title: 'とても長い章の題'.repeat(10), blocks: [p('あいう'), { type: 'quote', text: 'えお' }, { type: 'list', items: ['か', 'きく'] }, { type: 'h3', text: 'け' }] }];
  ok(countBodyChars(mixed) === 9, '字数の数え方: 段落・引用・箇条書き・小見出し', String(countBodyChars(mixed)));
  ok(countBodyChars(mixed, [{ title: 'コ', text: 'ラム' }]) === 12, '字数の数え方: コラムページも足す');
  // 本に残るコラムページも数に入れる(取り込み直しても残って一緒に組まれる。入口の「◯字」と同じ。2026-10-13 見直し)
  const cols = [{ title: 'コラム', text: para(20_000 - 3) }];
  const colBig = guardManuscript(book(MAX_TOTAL_CHARS - 10_000), cols);
  ok(
    !!colBig.error && colBig.error.includes('原稿とコラムページを合わせて') && colBig.error.includes('101万字'),
    '本文 99万字 + コラム 2万字は断る(コラムページも合わせて言う)',
    show(colBig.error),
  );
  ok(!guardManuscript(book(MAX_TOTAL_CHARS - 10_000)).error, 'コラムページが無ければ、同じ本文 99万字は通す');
  const colSlow = guardManuscript(book(SLOW_TOTAL_CHARS - 10_000), cols);
  ok(!colSlow.error && colSlow.notes.length === 1 && colSlow.notes[0].includes('原稿とコラムページを合わせて'), '本文 29万字 + コラム 2万字は時間がかかると知らせる', show(colSlow.notes));
  ok(guardManuscript(book(SLOW_TOTAL_CHARS), [{ title: '', text: '' }]).notes[0].startsWith('原稿が'), '空のコラムページだけなら「原稿が」と言う');

  // 字数の言い方
  const fmt: [number, string][] = [[0, '0字'], [9_999, '9,999字'], [10_000, '1万字'], [50_000, '5万字'], [52_345, '5.2万字'], [99_999, '9.9万字'], [300_000, '30万字'], [1_000_000, '100万字'], [1_462_769, '146万字']];
  for (const [n, want] of fmt) ok(formatChars(n) === want, `字数の言い方 ${n} → ${want}`, formatChars(n));
}

// ---- 4. Google ドキュメントの Markdown を取り込み(md.ts)で読んだ形 ----
// md.ts は絵の定義を外して絵のブロックにする(2026-10-13。くわしくは scripts/mdGdocs.test.ts)。
// 見張りに届くのは、絵の書き方でない所にじかに書かれたデータだけ
{
  const md = [
    '# **第1章　雨の日の図書室**',
    '',
    '雨の日の図書室は、いつもより静かだった。  ',
    '![][image1]',
    '',
    '# **あとがき**',
    '',
    '読んでくださって、ありがとうございました。',
    '',
    `[image1]: <${BIG}>`,
  ].join('\n');
  const g = guardManuscript(parseMd(md, '雨'));
  const first = g.manuscript.chapters[0];
  const last = g.manuscript.chapters[g.manuscript.chapters.length - 1];
  const texts = g.manuscript.chapters.flatMap((ch) => [ch.title, ...ch.blocks.map((b) => ('text' in b ? b.text : b.type === 'list' ? b.items.join('') : ''))]);
  ok(!g.error && g.notes.length === 0, 'Google の Markdown: 絵の定義は md.ts が外すので、見張りが取り除くものは無い', show(g));
  ok(!texts.some((t) => t.includes('base64')), 'Google の Markdown: データが本文の字に残らない');
  ok(first.blocks.some((b) => b.type === 'image' && b.src === BIG), 'Google の Markdown: 絵は参照の場所(第1章)に絵のブロックとして入る', show(first.blocks.map((b) => b.type)));
  ok(last.blocks.length === 1 && last.blocks[0].type === 'p', 'Google の Markdown: あとがきは本文だけ', show(last.blocks));
  ok(countBodyChars(g.manuscript.chapters) < 200, 'Google の Markdown: 字数が本文の分だけになる', String(countBodyChars(g.manuscript.chapters)));
  // .md の本文にじかに書かれたデータ(絵の書き方でない)は、これまでどおり見張りが取り除く
  const stray = guardManuscript(parseMd(`# 第1章　雨\n\n本文。\n\n${LONG}\n`, '雨'));
  ok(!stray.error && !JSON.stringify(stray.manuscript).includes('base64') && stray.notes.length === 1, '.md の本文にじかに書かれたデータは取り除く', show(stray));
  // .txt でも同じ
  const t = guardManuscript(parseTxt(`第1章　雨\n\n本文。\n\n${LONG}\n`, '雨'));
  ok(!t.error && !JSON.stringify(t.manuscript).includes('base64') && t.notes.length === 1, '.txt でも取り除く', show(t));
  // .txt の中の <img src="data:…">(タグごと取り除く。前は `<img src="">` が紙面に残った)
  const ti = guardManuscript(parseTxt(`第1章　雨\n\n本文。\n\n<img src="${LONG}" width="300">\n\nつづき。`, '雨'));
  ok(!ti.error && !JSON.stringify(ti.manuscript).includes('img') && ti.notes.length === 1, '.txt の <img src="data:…"> はタグごと取り除く', show(ti.manuscript.chapters[0].blocks));
  // 折り返した base64 の .txt(1行ずつの段落になる)
  const tw = guardManuscript(parseTxt(`第1章　雨\n\n本文。\n\n${WRAPPED}\n\nつづき。`, '雨'));
  const twTexts = tw.manuscript.chapters[0].blocks.map((b) => ('text' in b ? b.text : b.type));
  ok(
    !tw.error && tw.notes.length === 1 && !twTexts.some((x) => x.length > 20) && twTexts.includes('本文。') && twTexts.includes('つづき。'),
    '.txt の折り返した base64 は、つづきをまとめて取り除く',
    show(twTexts),
  );
}

// ---- 5. 保存の .json・自動保存から開くとき(sanitize) ----
{
  const book = sampleManuscript();
  const base: ProjectSnapshot = {
    settings: {
      ...defaultSettings(),
      columnPages: [{ id: 'c1', title: 'コラム', text: `一段落目\n\n${LONG}\n\n二段落目`, beforeChapter: 0 }],
    } as ProjectSettings,
    cover: defaultCoverSettings(),
    manuscript: book,
    source: null,
  };
  // 取り込みで入ってしまった段落(この直しの前に取り込んで、自動保存に残っている本)
  const lastCh = book.chapters[book.chapters.length - 1];
  const stuck: ProjectSnapshot = {
    ...base,
    manuscript: {
      ...book,
      chapters: [
        ...book.chapters.slice(0, -1),
        { ...lastCh, blocks: [...lastCh.blocks, { type: 'image', src: PNG, caption: '絵' }, p(`[image1]: <${BIG}>`)] },
      ],
    },
  };
  const NOTE = '画像などのデータを英数字の列に置き換えたもの';

  // 自動保存から開く(useProject の hydrate と同じ呼び方)
  const r = sanitize(JSON.parse(JSON.stringify(stuck)), { settings: defaultSettings(), cover: defaultCoverSettings(), manuscript: book, source: null }, true);
  const outLast = r.project.manuscript.chapters[r.project.manuscript.chapters.length - 1];
  ok(!JSON.stringify(r.project.manuscript).includes('base64,iVBORw0KGgo' + b64(20)), '自動保存: 146万字の段落を取り除く');
  ok(outLast.blocks.some((b) => b.type === 'image' && b.src === PNG), '自動保存: 本文中の絵の実体(src)はそのまま', show(outLast.blocks.slice(-2)));
  ok(r.project.settings.columnPages?.[0].text === '一段落目\n\n二段落目', '自動保存: コラムページの本文からも取り除く', show(r.project.settings.columnPages?.[0]));
  ok(r.notices.some((n) => n.includes(NOTE) && n.includes('2か所')), '自動保存: 新しい知らせで言う(本文1・コラム1)', show(r.notices));
  ok(r.fixed.length === 0 && r.removed.length === 0, '自動保存: 「読めない値」「外したもの」には入れない', show([r.fixed, r.removed]));
  ok(r.project.manuscript.chapters.length === book.chapters.length, '自動保存: 章の数は変わらない');
  ok(!r.notices.some((n) => n.includes('［原稿を組み直す］')), '自動保存: 取り込んだ原稿ファイルが無ければ、組み直しはすすめない', show(r.notices));
  // 取り込んだ .md が残っていれば、［原稿を組み直す］で絵が入ることを言う(2026-10-13 に止まった本の形)
  const withMd = { ...stuck, source: { name: '第1章', kind: 'md', data: '# 第1章' } } as ProjectSnapshot;
  const rm = sanitize(JSON.parse(JSON.stringify(withMd)), { settings: defaultSettings(), cover: defaultCoverSettings(), manuscript: book, source: null }, true);
  ok(rm.notices.some((n) => n.includes(NOTE) && n.includes('［原稿を組み直す］')), '自動保存: 取り込んだ .md が残っていれば、［原稿を組み直す］をすすめる', show(rm.notices));
  const withTxt = { ...stuck, source: { name: '第1章', kind: 'txt', data: '第1章' } } as ProjectSnapshot;
  const rt = sanitize(JSON.parse(JSON.stringify(withTxt)), { settings: defaultSettings(), cover: defaultCoverSettings(), manuscript: book, source: null }, true);
  ok(!rt.notices.some((n) => n.includes('［原稿を組み直す］')), '自動保存: .txt では組み直しをすすめない(組み直しても絵は入らない)', show(rt.notices));

  // 長いだけの本物の段落は、開くときには断らない・切らない。**知らせだけ出す**(開くたびに画面が止まるので。2026-10-13 見直し)
  const longReal = '字'.repeat(MAX_BLOCK_CHARS * 2);
  const long: ProjectSnapshot = { ...base, settings: defaultSettings(), manuscript: { ...book, chapters: [{ title: '長い', blocks: [p(longReal)] }] } };
  const rl = sanitize(JSON.parse(JSON.stringify(long)), { settings: defaultSettings(), cover: defaultCoverSettings(), manuscript: book, source: null }, true);
  const lb = rl.project.manuscript.chapters[0].blocks[0];
  ok(lb.type === 'p' && lb.text === longReal, '長いだけの本物の段落は、開くときに触らない');
  ok(
    rl.notices.length === 1 && rl.notices[0].includes('「長い」の章') && rl.notices[0].includes('10万字') && rl.notices[0].includes('改行') && rl.notices[0].includes('取り込み直す'),
    '長い段落は、開くときに章と字数と直し方を知らせる',
    show(rl.notices),
  );
  ok(rl.fixed.length === 0 && rl.removed.length === 0, '長い段落は「読めない値」「外したもの」には入れない');
  // 章立ての無い本(改行の抜けた .txt をこの見張りの前に取り込んだ本の形)
  const untitled: ProjectSnapshot = { ...base, settings: defaultSettings(), manuscript: { ...book, chapters: [{ title: '', blocks: [p('あ'.repeat(MAX_BLOCK_CHARS))] }] } };
  const ru = sanitize(JSON.parse(JSON.stringify(untitled)), { settings: defaultSettings(), cover: defaultCoverSettings(), manuscript: book, source: null }, true);
  ok(ru.notices.length === 1 && ru.notices[0].startsWith('原稿に'), '章立ての無い本は「原稿」と言う', show(ru.notices));
  // 100万字以上(コラムページも数える)
  const manyBlocks: Block[] = Array.from({ length: 990 }, () => p('字'.repeat(1000)));
  const many: ProjectSnapshot = {
    ...base,
    settings: { ...defaultSettings(), columnPages: [{ id: 'c9', title: '', text: '字'.repeat(20_000), beforeChapter: 0 }] } as ProjectSettings,
    manuscript: { ...book, chapters: [{ title: '一', blocks: manyBlocks }] },
  };
  const rmany = sanitize(JSON.parse(JSON.stringify(many)), { settings: defaultSettings(), cover: defaultCoverSettings(), manuscript: book, source: null }, true);
  ok(rmany.notices.length === 1 && rmany.notices[0].includes('101万字') && rmany.notices[0].includes('分けて'), '本文とコラムページで100万字を超える本は、開くときに知らせる', show(rmany.notices));
  ok(rmany.project.manuscript.chapters[0].blocks.length === 990, '100万字を超える本も、字は切らない');

  // 保存の .json を開く(画像込みの控え)
  const current: ProjectSnapshot = { ...base, settings: { ...defaultSettings(), bookId: 'b1' } as ProjectSettings };
  const backup = toProjectFile({ ...stuck, settings: { ...stuck.settings, bookId: 'b1' } as ProjectSettings }, true);
  const f = fromProjectFile(backup, current);
  const fLast = f.project.manuscript.chapters[f.project.manuscript.chapters.length - 1];
  ok(f.warnings.some((w) => w.includes(NOTE)), '.json: 知らせが出る', show(f.warnings));
  ok(!f.warnings.some((w) => w.startsWith('読めなかったので外したもの') || w.startsWith('読めない値があったので')), '.json: 「読めない」とは言わない', show(f.warnings));
  ok(fLast.blocks.some((b) => b.type === 'image' && b.src === PNG), '.json: 本文中の絵は戻る', show(fLast.blocks.slice(-2)));
  ok(!fLast.blocks.some((b) => b.type === 'p' && b.text.includes('[image1]')), '.json: 参照の定義の段落は外れる');
  // ふつうの控えは何も言わない(既存の知らせを増やさない)
  const plain = fromProjectFile(toProjectFile({ ...current, settings: { ...current.settings, columnPages: [] } as ProjectSettings }, true), current);
  ok(plain.warnings.length === 0, 'ふつうの控えは何も言わない', show(plain.warnings));
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
