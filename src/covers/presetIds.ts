// 同梱のプリセットの id を引く。(2026-10-12 改修の希望 2)
//
// 画像のフォルダにある絵のファイル名(拡張子を除く)が同梱のプリセットの id と同じなら、
// その高解像度版として扱う(BOOTH で無料配布している高解像度版は、ファイル名がプリセットの id。例 `biz-business-01.jpg`)。
// 一覧の読み込み(manifest.ts の loadCoverPresets)は fetch を待つが、ここは**焼き込みコピー**(manifest.bundled.json)を見る。
// 同梱の id は配布物と一緒に決まっていて、fetch の成否で答えが変わってはいけないため。
// 自分で足した画像(manifest.mine.json。開発用)は同梱ではないので入れない。

import bundled from './manifest.bundled.json';
import { isPresetId } from '../models/project';

let ids: Set<string> | null = null;
let sizes: Map<string, { w: number; h: number }> | null = null;

/** 同梱のプリセットの id の集まり */
export function bundledPresetIds(): Set<string> {
  ids ??= new Set((bundled as { id: string }[]).map((e) => e.id).filter(isPresetId));
  return ids;
}

/** 同梱のプリセットの id か */
export function isBundledPresetId(id: string): boolean {
  return bundledPresetIds().has(id);
}

/**
 * 同梱のプリセットの画素数(配布物の一覧に書いてある大きさ)。表紙に同梱のプリセットをそのまま使っているときの
 * 細かさを、絵を読まずに数えるのに使う(models/imageResolution.ts の collectResolution。2026-10-12 改修の希望 2)
 */
export function bundledPresetPx(id: string): { w: number; h: number } | undefined {
  sizes ??= new Map(
    (bundled as { id: string; w?: number; h?: number }[])
      .filter((e) => typeof e.w === 'number' && typeof e.h === 'number' && e.w > 0 && e.h > 0)
      .map((e) => [e.id, { w: e.w as number, h: e.h as number }]),
  );
  return sizes.get(id);
}
