// 文をクリップボードへ写す。**失敗したら黙らず、false を返す。**(2026-10-01)
//
// それまで AiStep の中に同じ処理が2つあり、どちらも `clipboard?.writeText().then(...)` だけで、
// クリップボードが無い・許可されなかったときに何も起きなかった(利用者には「押したのに反応がない」)。
// StartScreen のリンクのコピーは try/catch と window.prompt の逃げ道を持っていたので、それをここへ集めた。
//
// 呼ぶ側は、false が返ったら copyFallback で「ここから選んでコピーしてください」を出す。

/** 写せたら true。clipboard API が無い・拒まれたときは、古い方法(選択して execCommand)を試し、それも駄目なら false */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 許可されなかった・http で開いている、など。下の方法へ */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * コピーできなかったときの逃げ道。文を**選べる形で画面の中に出す**。
 *
 * 以前は window.prompt だった。prompt の欄は1行なので、6行ある頼み方(印刷所の決まりを読んでもらう文)の
 * 改行が潰れて、貼った先で1行になった(2026-10-01 読み直しで指摘)。textarea なら改行がそのまま残る。
 * React の外(DOM を直に作る)にしたのは、呼ぶ側(PrintRules・AiStep)が async の中から
 * 呼ぶだけで、状態を持たせずに済むため。背景の暗い所を押す・Esc・［閉じる］で閉じる
 */
export function copyFallback(text: string): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'about-backdrop';
  const box = document.createElement('div');
  box.className = 'about';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'コピーできませんでした');
  box.addEventListener('click', (e) => e.stopPropagation());

  const msg = document.createElement('p');
  msg.textContent = 'コピーできませんでした。下の文を選んで、コピーしてください';
  msg.style.margin = '0 0 8px';

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  ta.rows = Math.min(12, Math.max(3, text.split('\n').length + 1));
  ta.setAttribute('aria-label', 'コピーする文');
  ta.style.cssText =
    'width:100%;box-sizing:border-box;background:var(--bg-field);color:inherit;border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit;resize:vertical';
  // 触れたら全部を選ぶ(あとは Ctrl+C か、右クリックの［コピー］)
  ta.addEventListener('focus', () => ta.select());

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ghost';
  close.textContent = '閉じる';
  close.style.marginTop = '8px';

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') done();
  };
  const done = () => {
    window.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  close.addEventListener('click', done);
  backdrop.addEventListener('click', done);
  window.addEventListener('keydown', onKey);

  box.append(msg, ta, close);
  backdrop.append(box);
  document.body.appendChild(backdrop);
  ta.focus();
  ta.select();
}
