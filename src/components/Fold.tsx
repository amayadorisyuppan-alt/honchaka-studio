// 「細かく決める」の畳み。
//
// 各ステップは、その工程を決めるのに要る1〜2択だけを出し、それ以下の粒度をここへ入れる。
// 閉じたまま最後まで行けるのが既定。
//
// ラベルには**中に何が入っているかを列挙する**こと。「細かく決める」とだけ書くと、
// 何が畳まれているのか分からず、結局すべて開いて確かめることになる。

import { useState, type ReactNode } from 'react';

interface Props {
  /** 中身を列挙した見出し。例: 「細かく決める（段組み・刷り色）」 */
  label: string;
  children: ReactNode;
  /** 既定値から動いているとき、閉じたままでも分かるようにしるしを出す */
  changed?: boolean;
  /**
   * 開閉を親に持たせたいときだけ渡す(**半制御**)。渡さなければ自分で持つ。
   *
   * 04 の背景は、章の一覧を開くあいだ畳みごと描画から外している。
   * 自分で状態を持ったままだと**戻ったときに閉じてしまい**、章を続けて設定するのに
   * 毎回開き直すことになる(2026-08-18)。親が覚えていれば開いたまま戻れる
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * 目立たせる畳み。**「しまってある」ではなく「ここから変える」を見せたいとき**に使う。
   *
   * 04 の背景の「目次・章・奥付」で、地味な畳みが上の「本文全体」の付属品に見えて
   * 探されてしまった(2026-09-14 ユーザー報告「正直探してしまった」)。
   * 面の入り口が畳みの中にしかない場所では、畳み自身が入り口の顔をする必要がある
   */
  strong?: boolean;
}

export function Fold({
  label,
  children,
  changed = false,
  open: openProp,
  onOpenChange,
  strong = false,
}: Props) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  return (
    <div className={['fold', open && 'open', strong && 'strong'].filter(Boolean).join(' ')}>
      <button className="fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {/* ▸ だと畳みの記号として弱く押せる印象が薄いので ＋/− で開閉を示す */}
        <span className="fold-caret" aria-hidden="true">
          {open ? '−' : '＋'}
        </span>
        <span className="fold-label">{label}</span>
        {changed && <span className="fold-dot" title="既定値から変えています" />}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}
