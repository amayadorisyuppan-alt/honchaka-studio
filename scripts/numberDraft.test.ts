// 数の欄の丸め(src/components/numberDraft.ts)と、失敗の文の言い換え(src/components/errorText.ts)の検査。(2026-10-13 修正リスト 24・32)
//
// 回し方: node scripts/private/run-tests.mjs public|partner  (ブラウザも dev サーバーも要らない)
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { clampNoteText, readDraft, showDraft } from '../src/components/numberDraft';
import { NETWORK_ERROR_TEXT, userErrorText } from '../src/components/errorText';

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
const j = JSON.stringify;

// ── 本文のサイズの欄(7〜14)と同じ範囲で
const R = (raw: string, integer = false) => readDraft(raw, 7, 14, integer);
ok(j(R('')) === j({ kind: 'empty' }), '空は empty(設定に入れない。0 に化けない)', j(R('')));
ok(j(R('   ')) === j({ kind: 'empty' }), '空白だけも empty');
ok(j(R('abc')) === j({ kind: 'invalid' }), "'abc' は invalid(元に戻す)");
ok(j(R('1e999')) === j({ kind: 'invalid' }), "'1e999'(Infinity)は invalid");
ok(j(R('Infinity')) === j({ kind: 'invalid' }), "'Infinity' は invalid");
ok(j(R('NaN')) === j({ kind: 'invalid' }), "'NaN' は invalid");
ok(j(R('0')) === j({ kind: 'ok', value: 7, typed: 0, clamped: true }), "'0' は下限 7 へ", j(R('0')));
ok(j(R('-5')) === j({ kind: 'ok', value: 7, typed: -5, clamped: true }), "'-5' は下限 7 へ", j(R('-5')));
ok(j(R('9999')) === j({ kind: 'ok', value: 14, typed: 9999, clamped: true }), "'9999' は上限 14 へ", j(R('9999')));
ok(j(R('1e308')) === j({ kind: 'ok', value: 14, typed: 1e308, clamped: true }), "'1e308' は上限 14 へ", j(R('1e308')));
ok(j(R('0.1')) === j({ kind: 'ok', value: 7, typed: 0.1, clamped: true }), "'0.1' は下限 7 へ");
ok(j(R('8.5')) === j({ kind: 'ok', value: 8.5, typed: 8.5, clamped: false }), "'8.5' はそのまま(丸めない)", j(R('8.5')));
ok(j(R(' 8.5 ')) === j({ kind: 'ok', value: 8.5, typed: 8.5, clamped: false }), '前後の空白は無視');
ok(j(R('7')) === j({ kind: 'ok', value: 7, typed: 7, clamped: false }), '下限の端 7 はそのまま');
ok(j(R('14')) === j({ kind: 'ok', value: 14, typed: 14, clamped: false }), '上限の端 14 はそのまま');
ok(j(R('6.99')) === j({ kind: 'ok', value: 7, typed: 6.99, clamped: true }), '下限のすぐ外 6.99 は 7 へ');
ok(j(R('14.01')) === j({ kind: 'ok', value: 14, typed: 14.01, clamped: true }), '上限のすぐ外 14.01 は 14 へ');
ok(j(R('8.123456')) === j({ kind: 'ok', value: 8.12, typed: 8.123456, clamped: true }), '小数は 2 桁に丸める(丸めたら知らせる)', j(R('8.123456')));
ok(j(R('10.4', true)) === j({ kind: 'ok', value: 10, typed: 10.4, clamped: true }), '整数の欄は整数に丸める', j(R('10.4', true)));

// 範囲が小数の端(表紙の大きさ 0.3〜2)
ok(j(readDraft('0', 0.3, 2)) === j({ kind: 'ok', value: 0.3, typed: 0, clamped: true }), '表紙の大きさ 0 は 0.3 へ');
ok(j(readDraft('99', 0.3, 2)) === j({ kind: 'ok', value: 2, typed: 99, clamped: true }), '表紙の大きさ 99 は 2 へ');
// 微調整 mm(-100〜100): 負の端
ok(j(readDraft('-99999', -100, 100)) === j({ kind: 'ok', value: -100, typed: -99999, clamped: true }), '微調整 -99999 は -100 へ');
ok(j(readDraft('99999', -100, 100)) === j({ kind: 'ok', value: 100, typed: 99999, clamped: true }), '微調整 99999 は 100 へ');
ok(j(readDraft('0', -100, 100)) === j({ kind: 'ok', value: 0, typed: 0, clamped: false }), '微調整 0 はそのまま(範囲の中)');
ok(j(readDraft('-0', -100, 100)).includes('"clamped":false'), "'-0' は範囲の中");

// ── 欄に出す文字と知らせの文
ok(showDraft(8.5) === '8.5' && showDraft(8) === '8' && showDraft(0.3) === '0.3', '欄の文字は末尾の 0 を落とす');
ok(showDraft(null) === '' && showDraft(undefined) === '' && showDraft(NaN) === '', '空・NaN は空の欄');
ok(
  clampNoteText('サイズ', 7, 14, 14, 'pt') === 'サイズは 7〜14pt の範囲で入れられます。14pt にしました',
  '知らせの文(単位つき)',
  clampNoteText('サイズ', 7, 14, 14, 'pt'),
);
ok(
  clampNoteText('塗り足し', 0, 10, 10) === '塗り足しは 0〜10 の範囲で入れられます。10 にしました',
  '知らせの文(単位なしは今までの PrintRules と同じ)',
);

// ── 通信の失敗の言い換え
ok(userErrorText(new TypeError('A network error occurred.')) === NETWORK_ERROR_TEXT, "'A network error occurred.' は日本語に");
ok(userErrorText(new TypeError('Failed to fetch')) === NETWORK_ERROR_TEXT, "'Failed to fetch' は日本語に");
ok(userErrorText(new TypeError('NetworkError when attempting to fetch resource.')) === NETWORK_ERROR_TEXT, 'Firefox の通信の失敗も日本語に');
ok(userErrorText(new TypeError('Load failed')) === NETWORK_ERROR_TEXT, "Safari の 'Load failed' も日本語に");
ok(userErrorText(new Error('net::ERR_INTERNET_DISCONNECTED')) === NETWORK_ERROR_TEXT, 'ERR_INTERNET_DISCONNECTED も日本語に');
ok(userErrorText('A network error occurred.') === NETWORK_ERROR_TEXT, '文字列で投げられても言い換える');
const jp = '変換の道具を読み込めませんでした。通信を確かめて、ページを読み込み直してください';
ok(userErrorText(new Error(jp)) === jp, '利用者向けの日本語の Error はそのまま');
ok(userErrorText(new Error('画像を読み込めませんでした (network error)')).startsWith('画像を'), '日本語を含む文は(英語が混ざっても)そのまま');
ok(userErrorText(new Error('Out of memory')) === 'Out of memory', '通信と関係ない英語は触らない');
ok(userErrorText(42) === '42' && userErrorText(null) === 'null', 'Error でないものは文字にする');
{
  const e = new Error('');
  e.name = 'NetworkError';
  ok(userErrorText(e) === NETWORK_ERROR_TEXT, '名前が NetworkError で文が空でも日本語に');
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
