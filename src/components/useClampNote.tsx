// 数の欄を範囲に丸めたときの短い知らせ。(2026-10-13 修正リスト 24)
//
// 下の帯や表紙の欄は、PrintRules のように欄の下に文を出す場所が無い(帯は1行で横にスクロールする)。
// そこで、元に戻したことを知らせる札(App の .app-toast)と同じ見た目の札を、画面の上に数秒だけ出す。
// 札は fixed なので、帯の overflow に切り取られない。読むだけの札で、操作はふさがない(pointer-events なし)。

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** `say` を欄の onClamped に渡し、`note` を部品の中のどこかに置く */
export function useClampNote(): { say: (text: string) => void; note: ReactNode } {
  const [shown, setShown] = useState<{ text: string; seq: number } | null>(null);
  const timer = useRef(0);
  const say = useCallback((text: string) => {
    setShown({ text, seq: Date.now() });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(null), 4200);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const note = shown ? (
    <p className="app-toast" key={shown.seq} role="status">
      {shown.text}
    </p>
  ) : null;
  return { say, note };
}
