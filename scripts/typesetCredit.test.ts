// 奥付の「組版　本ちゃか（ひっちゃか本づくりスタジオ）」の行(Manuscript.typesetCredit)の検査。(2026-11-07)
//
// 1. 真のとき、行が発行所の次・印刷の前に入る。発行所も印刷も無い本では著者の次
// 2. 偽・欄なし(前に作った本)では、行の配列が今までと1字も変わらない
// 3. colophonOf(原稿の取り込み直しで奥付の欄を持ち越す関数)が false と true を持ち越し、undefined は持ち越さない
// 4. 本ちゃかで新しく作る本(まっさら・サンプル)はオン
// 5. 欄の無い古い形の .json を読み込んで書き出した組版 HTML が、欄の無い本と同じ。外した本は外したまま
// 6. AI 用の JSON で欄が落ちた・壊れた値になったとき、いま開いている本の値を残して知らせる
//
// 回し方: node scripts/private/run-tests.mjs public|partner
import { colophonOf, defaultSettings, emptyManuscript, type Manuscript } from '../src/models/project';
import { TYPESET_CREDIT_ROW, colophonRows } from '../src/typeset/matter';
import { manuscriptHtml } from '../src/typeset/html';
import { sampleManuscript } from '../src/sample';
import { parseTxt } from '../src/importers/txt';
import { defaultCoverSettings } from '../src/models/cover';
import { fromProjectFile, toProjectFile, type ProjectSnapshot } from '../src/project/file';

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

const NOW = new Date(2026, 10, 7);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const base = (o: Partial<Manuscript> = {}): Manuscript => ({
  title: '青い背表紙',
  author: '雨宿 文',
  publisher: '',
  chapters: [],
  published: '2026年11月7日',
  ...o,
});

// ---- 文言 ----
ok(TYPESET_CREDIT_ROW === '組版　本ちゃか（ひっちゃか本づくりスタジオ）', '行の文言(ラベル＋全角空白＋値)', TYPESET_CREDIT_ROW);

// ---- 1. 行の場所 ----
{
  const full = colophonRows(base({ publisher: '雨宿書房', printer: 'Amazon KDP', isbn: '978-4-0000-0000-0', colophonExtra: '初版', typesetCredit: true }), NOW);
  const at = (p: string) => full.findIndex((r) => r.startsWith(p));
  ok(at('組版　') === at('発行所　') + 1, '発行所の次に入る', JSON.stringify(full));
  ok(at('印刷　') === at('組版　') + 1, '印刷の前に入る(組版の次が印刷)');
  ok(full.filter((r) => r === TYPESET_CREDIT_ROW).length === 1, '1行だけ入る');

  const noPub = colophonRows(base({ printer: 'Amazon KDP', typesetCredit: true }), NOW);
  ok(noPub[1].startsWith('著者　') && noPub[2] === TYPESET_CREDIT_ROW && noPub[3].startsWith('印刷　'), '発行所が無い本: 著者の次・印刷の前', JSON.stringify(noPub));

  const bare = colophonRows(base({ typesetCredit: true }), NOW);
  ok(bare[1].startsWith('著者　') && bare[2] === TYPESET_CREDIT_ROW && bare[3].startsWith('©'), '発行所も印刷も無い本: 著者の次', JSON.stringify(bare));

  const noPrinter = colophonRows(base({ publisher: '雨宿書房', isbn: '978-4-0000-0000-0', typesetCredit: true }), NOW);
  ok(noPrinter[2].startsWith('発行所　') && noPrinter[3] === TYPESET_CREDIT_ROW && noPrinter[4].startsWith('ISBN　'), '印刷が無い本: 発行所の次・ISBN の前', JSON.stringify(noPrinter));
}

// ---- 2. 偽・欄なしは今までと同じ ----
{
  const fields = { publisher: '雨宿書房', printer: 'Amazon KDP', isbn: '978-4-0000-0000-0', colophonExtra: '初版' };
  const old = colophonRows(base(fields), NOW);
  ok(same(colophonRows(base({ ...fields, typesetCredit: false }), NOW), old), '偽: 行の配列が欄なしと同じ');
  ok(same(colophonRows(base({ ...fields, typesetCredit: undefined }), NOW), old), 'undefined: 行の配列が欄なしと同じ');
  ok(!old.includes(TYPESET_CREDIT_ROW), '欄なしの本に行は入らない');
  const bare = colophonRows(base(), NOW);
  ok(same(bare, [`発行日　2026年11月7日`, '著者　雨宿 文', '©2026 雨宿 文']), '最小の本の奥付は従来どおり', JSON.stringify(bare));
}

// ---- 3. colophonOf ----
{
  ok(colophonOf(base({ typesetCredit: false })).typesetCredit === false, 'colophonOf: false を持ち越す');
  ok(colophonOf(base({ typesetCredit: true })).typesetCredit === true, 'colophonOf: true を持ち越す');
  ok(!('typesetCredit' in colophonOf(base())), 'colophonOf: undefined は持ち越さない(欄を作らない)');
  const c = colophonOf(base({ authorProfile: '紹介', printer: 'X', isbn: '', colophonExtra: '', typesetCredit: false }));
  ok(c.authorProfile === '紹介' && c.printer === 'X' && !('isbn' in c) && !('colophonExtra' in c), 'colophonOf: ほかの欄の動きは変わらない(空は持ち越さない)', JSON.stringify(c));
  // 取り込み直しの合成(useProject.reparse の { ...parsed, ...colophonOf(cur) })
  const parsed: Manuscript = { title: 't', author: '', publisher: '', chapters: [] };
  ok(({ ...parsed, ...colophonOf(base({ typesetCredit: false })) }).typesetCredit === false, '取り込み直し: 外した本は外したまま');
  ok(({ ...parsed, ...colophonOf(base()) }).typesetCredit === undefined, '取り込み直し: 欄の無い前の本は欄のないまま');
}

// ---- 4. 新しい本ははじめからオン ----
ok(emptyManuscript().typesetCredit === true, 'まっさらの新しい本はオン');
ok(sampleManuscript().typesetCredit === true, 'サンプルはオン');
ok(colophonRows(sampleManuscript(), NOW).includes(TYPESET_CREDIT_ROW), 'サンプルの奥付に行が出る');

// ---- 5. 古い形の .json(欄なし) ----
{
  const settings = defaultSettings();
  const ms = parseTxt('第一章　はじまり\n\n本文です。\n');
  const mkMs = (o: Partial<Manuscript>): Manuscript => ({ ...ms, title: '青い背表紙', author: '雨宿 文', publisher: '雨宿書房', published: '2026年11月7日', ...o });
  const snap = (m: Manuscript): ProjectSnapshot => ({ settings, cover: defaultCoverSettings(), manuscript: m, source: null });

  const oldBook = mkMs({});
  ok(!('typesetCredit' in oldBook), '(前提)古い本は欄を持たない');
  const text = toProjectFile(snap(oldBook), false);
  ok(!('typesetCredit' in JSON.parse(text).manuscript), '古い本を書き出した .json に欄は入らない');
  const back = fromProjectFile(text, snap(oldBook));
  ok(back.project.manuscript.typesetCredit === undefined, '読み込んでも欄は無いまま(オンにならない)');
  ok(manuscriptHtml(back.project.manuscript, back.project.settings) === manuscriptHtml(oldBook, settings), '読み込み直した本の組版 HTML は、欄の無い本と同じ');
  ok(!manuscriptHtml(back.project.manuscript, back.project.settings).includes('本ちゃか'), '古い本の組版 HTML に組版の行は無い');

  // 開いている本が新しい本(オン)でも、欄の無い別の本の .json は欄なしのまま(補わない)
  // (bookId を違えて別の本にする。.json の側は id を持たない古い形なので、書名を違えて別の本と見分けさせる)
  const otherCur = snap(mkMs({ title: '別の本', typesetCredit: true }));
  const other = fromProjectFile(text, otherCur);
  ok(other.project.manuscript.typesetCredit === undefined, '別の本の .json(欄なし)は、いま開いている本がオンでも補わない');

  // 外した本・入れた本は、書き出して読み戻してもそのまま
  for (const v of [true, false]) {
    const cur = snap(mkMs({ typesetCredit: v }));
    const r = fromProjectFile(toProjectFile(cur, false), cur);
    ok(r.project.manuscript.typesetCredit === v, `書き出して読み戻しても ${v} のまま`);
  }
  const on = mkMs({ typesetCredit: true });
  ok(manuscriptHtml(on, settings).includes('本ちゃか'), '真の本の組版 HTML に組版の行が出る');
  ok(manuscriptHtml(on, settings) !== manuscriptHtml(oldBook, settings), '真の本は欄なしの本と組版 HTML が違う');
  ok(manuscriptHtml(mkMs({ typesetCredit: false }), settings) === manuscriptHtml(oldBook, settings), '偽の本は欄なしの本と組版 HTML が同じ');

  // ---- 6. AI 用の JSON(同じ本・画像なし) ----
  const cur = snap(on);
  const dropped = JSON.parse(toProjectFile(cur, false));
  delete dropped.manuscript.typesetCredit;
  const r1 = fromProjectFile(JSON.stringify(dropped), cur);
  ok(r1.project.manuscript.typesetCredit === true, 'AI が欄を落としても、いま開いている本の値(入れる)を残す');
  ok(r1.warnings.some((w) => w.includes('組版の行')), 'AI が欄を落としたら知らせる', JSON.stringify(r1.warnings));
  const broken = JSON.parse(toProjectFile(cur, false));
  broken.manuscript.typesetCredit = 'no';
  const r2 = fromProjectFile(JSON.stringify(broken), cur);
  ok(r2.project.manuscript.typesetCredit === true, '壊れた値はいまの値に戻す');
  ok(r2.warnings.some((w) => w.includes('組版の行')), '壊れた値は知らせる');
  // 欄の無い前の本を開いているときは、落ちても何も補わない
  const oldCur = snap(oldBook);
  const r3 = fromProjectFile(toProjectFile(oldCur, false), oldCur);
  ok(r3.project.manuscript.typesetCredit === undefined && !r3.warnings.some((w) => w.includes('組版の行')), '欄の無い前の本は、AI の往復でも欄を作らず知らせもしない');
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
