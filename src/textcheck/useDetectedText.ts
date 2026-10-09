// 絵(src)ごとの「見つけた文字」を、調べ終わった順に state に入れていく。
//
// - 絵が1枚も無ければ、何もしない(Worker もモデルも読み込まない)
// - 同じ絵は1回だけ調べる(detect.ts が覚えている)
// - 調べられなかった絵は null(判定しない)。**勝手には試し直さない**(だめな絵を延々と頼み続けない)。
//   利用者が［もう一度確かめる］を押したとき(retry)だけ、試し直す
// - まだ入っていない絵 = 確かめている最中。呼ぶ側は「確かめています」と言える
import { useCallback, useEffect, useRef, useState } from 'react';
import { detectText, type DetectResult } from './detect';

export interface DetectedText {
  /** 絵 → 見つけた文字。調べられなかった絵は null。確かめている最中の絵は入っていない */
  found: ReadonlyMap<string, DetectResult | null>;
  /** 調べられなかった絵を、もう一度確かめる */
  retry: (src: string) => void;
}

export function useDetectedText(srcs: readonly string[]): DetectedText {
  const [found, setFound] = useState<ReadonlyMap<string, DetectResult | null>>(() => new Map());
  /** 頼んだ絵(結果待ちも含む)。同じ絵を二重に頼まない */
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ask = useCallback((src: string) => {
    if (asked.current.has(src)) return;
    asked.current.add(src);
    void detectText(src).then((r) => {
      if (mounted.current) setFound((prev) => new Map(prev).set(src, r));
    });
  }, []);
  useEffect(() => {
    for (const src of srcs) ask(src);
  }, [srcs, ask]);
  const retry = useCallback(
    (src: string) => {
      asked.current.delete(src);
      setFound((prev) => {
        const next = new Map(prev);
        next.delete(src);
        return next;
      });
      ask(src);
    },
    [ask],
  );
  return { found, retry };
}
