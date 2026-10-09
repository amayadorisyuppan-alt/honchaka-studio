// 絵の色の一覧を、画面(React)で使うためのフック。数え方は palette.ts を参照。

import { useEffect, useMemo, useState } from 'react';
import { cachedPalette, mergePalettes, paletteOf } from './palette';

export type ArtSource = string | HTMLImageElement | null | undefined;

/** 数えない絵(SVG・空)。SVG は線画で、色の一覧には向かない */
const countable = (s: ArtSource): s is string | HTMLImageElement =>
  !!s && !(typeof s === 'string' && (s.startsWith('data:image/svg') || s.startsWith('<')));

/**
 * 絵たちの色の一覧(max 色まで)。**sources は呼ぶ側で useMemo しておくこと**(中身が変わらないあいだは同じ配列を渡す)。
 * `lead` は、すでに選んである色の並び(表紙の色など)。一番はじめの絵として混ぜる。
 * 数え終わるまでは、数え終わった分だけを返す
 */
export function useArtPalette(
  sources: readonly ArtSource[],
  max = 8,
  lead?: readonly string[],
): string[] {
  const list = useMemo(() => {
    const seen = new Set<string | HTMLImageElement>();
    const out: (string | HTMLImageElement)[] = [];
    for (const s of sources) {
      if (!countable(s) || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }, [sources]);
  const [tick, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    for (const s of list) {
      if (cachedPalette(s)) continue;
      void paletteOf(s).then(() => alive && bump((n) => n + 1));
    }
    return () => {
      alive = false;
    };
  }, [list]);
  return useMemo(() => {
    const lists: (readonly string[])[] = [];
    if (lead && lead.length) lists.push(lead);
    for (const s of list) lists.push(cachedPalette(s) ?? []);
    return mergePalettes(lists, max);
    // tick: 数え終わった絵が cache に入ったあと、並びを作り直すため
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, lead, max, tick]);
}
