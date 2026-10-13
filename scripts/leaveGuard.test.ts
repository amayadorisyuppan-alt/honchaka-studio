// ページを離れる確認(src/store/leaveGuard.ts)の検査。(2026-10-12 修正リスト 2-2)
//
// 書き込み待ち・書き込み中のあいだだけ beforeunload で確認の窓を頼み、保存済みのふだんは頼まないこと。
// 回し方: node scripts/private/run-tests.mjs public|partner (ブラウザも要らない)
import { createWriteCounter, requestLeaveConfirm, shouldConfirmLeave } from '../src/store/leaveGuard';

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

function fakeEvent() {
  const e = { prevented: 0, returnValue: undefined as unknown, preventDefault() { this.prevented++; } };
  return e;
}

// 1. 書き込みの最中の数
{
  const c = createWriteCounter();
  ok(!c.active, '始めは書き込み中ではない');
  c.begin();
  ok(c.active, '書き込みを始めたら中');
  c.begin();
  c.end();
  ok(c.active, '2つ重なって1つ終わっても、まだ中');
  c.end();
  ok(!c.active, '全部終わったら中ではない');
  c.end();
  ok(!c.active, '余分に end しても負の数にならない');
  c.begin();
  ok(c.active, '余分な end のあとでも、次の begin で中になる');
}

// 2. 確認を出すか
ok(!shouldConfirmLeave({ queued: false, writing: false, blocked: false }), '保存済みのふだんは出さない');
ok(shouldConfirmLeave({ queued: true, writing: false, blocked: false }), '書き込み待ち(0.8 秒のあいだ)なら出す');
ok(shouldConfirmLeave({ queued: false, writing: true, blocked: false }), '書き込み中なら出す');
ok(shouldConfirmLeave({ queued: true, writing: true, blocked: false }), '待ちと最中が重なっても出す');
ok(!shouldConfirmLeave({ queued: true, writing: true, blocked: true }), '自動保存が止められているときは出さない(書き込みを待っていない)');

// 3. イベントへの頼み方
{
  const e = fakeEvent();
  ok(requestLeaveConfirm(e, true) === true && e.prevented === 1 && e.returnValue === '', '確認が要るときは preventDefault と returnValue の両方');
  const f = fakeEvent();
  ok(requestLeaveConfirm(f, false) === false && f.prevented === 0 && f.returnValue === undefined, '要らないときは何も触らない');
}

// 4. 流れ: 変更 → 待ち → 書き込み → 終わり
{
  const c = createWriteCounter();
  let queued = false;
  const ask = () => shouldConfirmLeave({ queued, writing: c.active, blocked: false });
  ok(!ask(), '流れ: 何も変えていない');
  queued = true;
  ok(ask(), '流れ: 変えた(待ち)');
  queued = false;
  c.begin();
  ok(ask(), '流れ: 書き込み中');
  c.end();
  ok(!ask(), '流れ: 書き終えたら倒れる');
  c.begin();
  c.end();
  ok(!ask(), '流れ: 書き込みが失敗で終わっても(end は finally)倒れる');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
