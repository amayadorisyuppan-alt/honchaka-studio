// 絵(data URI)の画素数を調べる。頭の数十バイトから読めればその場で(描かない)、
// 読めない形式(AVIF など)だけ <img> に読ませて測る。絵の細かさの知らせ(models/imageResolution.ts)が使う。
//
// 結果は絵ごとに覚える(同じ絵を何度も測らない)。**測れなかった絵は null**: 知らせの対象から外す
// (分からないものを「粗い」とは言わない)。測っている最中の絵は、返す表に入っていない。

import { useEffect, useMemo, useState } from 'react';
import { pxSizeOfDataUri, type PxSize } from '../models/imageResolution';

/** 覚えておく絵の数の上限。超えたら全部捨てる(data URI は大きいので、持ち続けない) */
const CACHE_LIMIT = 256;
const cache = new Map<string, PxSize | null>();

function measureByImage(src: string): Promise<PxSize | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * src → 画素数。測れた(または測れないと分かった)絵だけ入る。SVG・空の src は入れない。
 * `srcs` は呼ぶ側で useMemo しておくこと(中身が変わらないあいだは同じ配列を渡す)
 */
export function useImageSizes(srcs: readonly string[]): ReadonlyMap<string, PxSize | null> {
  const [tick, bump] = useState(0);
  const list = useMemo(
    // 文字列か先に確かめる。.json の src が数や {} だと、ここで画面ごと落ちていた(2026-10-13 修正リスト 25。読み込みでも外すが、別の道で入っても落とさない)
    () => [...new Set(srcs.filter((s) => typeof s === 'string' && s.startsWith('data:image/') && !s.startsWith('data:image/svg')))],
    [srcs],
  );
  // 表は、絵の並び(list)か、測り終わり(tick)が変わったときだけ作り直す。毎回新しい Map を返すと、
  // 受け取る側(入稿前チェック)が毎回やり直しになる(2026-10-03 監査)
  const { out, pending } = useMemo(() => {
    if (cache.size > CACHE_LIMIT) cache.clear();
    const out = new Map<string, PxSize | null>();
    const pending: string[] = [];
    for (const s of list) {
      if (!cache.has(s)) {
        const quick = pxSizeOfDataUri(s);
        if (quick) cache.set(s, quick);
      }
      if (cache.has(s)) out.set(s, cache.get(s) ?? null);
      else pending.push(s);
    }
    return { out, pending };
    // tick: 測り終わった絵が cache に入ったあと、表を作り直すため
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, tick]);
  useEffect(() => {
    let alive = true;
    for (const s of pending) {
      void measureByImage(s).then((r) => {
        cache.set(s, r);
        if (alive) bump((n) => n + 1);
      });
    }
    return () => {
      alive = false;
    };
    // 測る絵が増えたとき(list が変わったとき)だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);
  return out;
}
