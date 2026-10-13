/**
 * **自動保存がまだ終わっていないときだけ、ページを離れる前に確認の窓を出す。**(2026-10-12 修正リスト 2-2)
 *
 * 10/9 に「離れる合図で書き出す」(useProject の flushSave)を入れたが、画像の多い大きな本(書き込みが 4MB ほど)は、
 * 再読み込みの途中で書き終わらずに落ちることがあった。書き込みの待ち(0.8 秒)か書き込みの最中のあいだだけ、
 * ブラウザの「このサイトを離れますか?」を出し、利用者に書き終わるまでの時間を渡す。
 * **保存済みのふだんは出さない**(出しっぱなしにすると、ただの再読み込みのたびに止められる)。
 * 確認の文はブラウザが決める(こちらでは変えられない)。版による違いは無い
 */

/** beforeunload のイベントのうち、ここで触る部分だけ */
export interface LeaveEventLike {
  preventDefault(): void;
  returnValue: unknown;
}

/** 書き込みの最中の数(複数の書き込みが重なることがあるので、数で持つ) */
export function createWriteCounter() {
  let n = 0;
  return {
    /** 書き込みを始めた */
    begin() {
      n++;
    },
    /** 書き込みが終わった(成功も失敗も) */
    end() {
      n = Math.max(0, n - 1);
    },
    /** いま書き込みの最中か */
    get active() {
      return n > 0;
    },
  };
}

/**
 * 離れる確認を出すか。
 * 待っている保存か、書き込みの最中があって、かつ自動保存が止められていないときだけ。
 * (止められているときは、そもそも書き込みを待っていない)
 */
export function shouldConfirmLeave(opts: { queued: boolean; writing: boolean; blocked: boolean }): boolean {
  if (opts.blocked) return false;
  return opts.queued || opts.writing;
}

/**
 * beforeunload の中で呼ぶ。確認が要るときだけ、ブラウザに確認の窓を頼む。
 * (preventDefault と returnValue の両方。どちらかしか見ない版があるため)
 * @returns 確認を頼んだか
 */
export function requestLeaveConfirm(e: LeaveEventLike, confirm: boolean): boolean {
  if (!confirm) return false;
  e.preventDefault();
  e.returnValue = '';
  return true;
}
