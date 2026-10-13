// 本に入っている同梱のプリセットの絵を、画像のフォルダにある高解像度版へまとめて差し替えるときの、
// 「どの絵が対象か」「差し替えたあとの設定」を作る部分。(2026-10-12 改修の希望 2 の続き・修正リスト 21 の続き)
//
// 同梱の絵は presetId(どの同梱のプリセットか)を持っている。フォルダに同じ id の画像(BOOTH の無料の高解像度版)があれば、
// その原画から取り込んだ絵に src だけを替える。fromPreset・presetId・濃さなどはそのまま残す。
// 絵の細かさの知らせが出ている絵だけを対象にする(filter。知らせが出ていない絵は替えない)。
// **表紙は対象外**(表紙の絵は presetId を持たない。{ kind: 'preset', id } のまま同梱の絵を指す)。
//
// ここは画面にも保存にも触らない(設定を返すだけ)ので、単体の検査で回せる。
// 書き込みは store の swapArt が、設定と原稿を1つの「元に戻す」にまとめて行う。

import type { BgSpec, Manuscript, Plate, ProjectSettings } from './project';
import { imageKey } from './inlineImages';

/** 差し替えの対象になりうる1か所 */
export interface SwapPlace {
  kind: 'plate' | 'img' | 'bg';
  /**
   * 数える単位。挿絵は 'plate:id'、章の途中の絵は 'img:鍵'(行の鍵と同じ)、背景は 'bg:'＋その絵(同じ絵を敷く面が複数あっても1枚と数える)
   */
  unit: string;
  presetId: string;
  /** いま入っている絵 */
  src: string;
  /** 見開きの挿絵(取り込みの長い辺の上限を広く取る) */
  wide: boolean;
}

/** 知らせが出ている絵(入稿前チェックと同じ collectResolution の結果から作る) */
export interface SwapFilter {
  /** 'plate:id' の鍵 */
  plates: ReadonlySet<string>;
  /** 'img:鍵' の鍵 */
  imgs: ReadonlySet<string>;
  /** 背景の絵(src)。pageBackgrounds は同じ絵を1度しか数えないので、鍵ではなく絵で引く */
  bgSrcs: ReadonlySet<string>;
}

export const EMPTY_SWAP_FILTER: SwapFilter = { plates: new Set(), imgs: new Set(), bgSrcs: new Set() };

export interface SwapResult {
  /** 対象になった場所(置き換えるかどうかによらず) */
  places: SwapPlace[];
  /** 変わった設定(変わらなければ無い) */
  settings?: Partial<ProjectSettings>;
  /** 変わった原稿(変わらなければ無い) */
  manuscript?: Partial<Manuscript>;
}

/** 数える単位の数(同じ単位は1枚) */
export function countSwapUnits(places: readonly SwapPlace[], only?: (p: SwapPlace) => boolean): number {
  const seen = new Set<string>();
  for (const p of places) if (!only || only(p)) seen.add(p.unit);
  return seen.size;
}

/**
 * 本の中の、差し替えの対象になる場所を集め、`pick` が返した新しい絵に替えた設定を作る。
 * `pick` が undefined を返す場所(フォルダに高解像度版が無い・読めなかった)・同じ絵を返す場所は、そのまま残す。
 * 入力は書き換えない(替えた欄だけ新しい値で返す)
 */
export function swapPresetArt(
  settings: ProjectSettings,
  manuscript: Manuscript,
  filter: SwapFilter,
  pick: (place: SwapPlace) => string | undefined,
): SwapResult {
  const places: SwapPlace[] = [];
  const settingsPatch: Partial<ProjectSettings> = {};
  const manuscriptPatch: Partial<Manuscript> = {};

  // 挿絵ページ
  let platesChanged = false;
  const plates = (settings.plates ?? []).map((p: Plate) => {
    if (p.blank || !p.src || !p.presetId || !filter.plates.has(`plate:${p.id}`)) return p;
    const place: SwapPlace = {
      kind: 'plate', unit: `plate:${p.id}`, presetId: p.presetId, src: p.src, wide: p.size === 'spread',
    };
    places.push(place);
    const n = pick(place);
    if (!n || n === p.src) return p;
    platesChanged = true;
    // 絵を替えたら「このままにする」も消す(画像を選び直したときと同じ。別の絵なので確かめ直す)
    const { textOk: _drop, ...rest } = p;
    void _drop;
    return { ...rest, src: n } as Plate;
  });
  if (platesChanged) settingsPatch.plates = plates;

  // 章の途中の絵
  let chaptersChanged = false;
  const chapters = manuscript.chapters.map((ch, ci) => {
    let changed = false;
    const blocks = ch.blocks.map((b, bi) => {
      if (typeof b !== 'object' || b === null || b.type !== 'image') return b;
      const key = `img:${imageKey(ci, bi)}`;
      if (!b.src || !b.presetId || !filter.imgs.has(key)) return b;
      const place: SwapPlace = { kind: 'img', unit: key, presetId: b.presetId, src: b.src, wide: false };
      places.push(place);
      const n = pick(place);
      if (!n || n === b.src) return b;
      changed = true;
      const { textOk: _drop, ...rest } = b;
      void _drop;
      return { ...rest, src: n };
    });
    if (!changed) return ch;
    chaptersChanged = true;
    return { ...ch, blocks };
  });
  if (chaptersChanged) manuscriptPatch.chapters = chapters;

  // 面ごとの背景
  const bg = (spec: BgSpec | undefined): BgSpec | undefined => {
    if (!spec?.src || !spec.presetId || !filter.bgSrcs.has(spec.src)) return spec;
    const place: SwapPlace = { kind: 'bg', unit: `bg:${spec.src}`, presetId: spec.presetId, src: spec.src, wide: false };
    places.push(place);
    const n = pick(place);
    return n && n !== spec.src ? { ...spec, src: n } : spec;
  };
  for (const k of ['titleBg', 'tocBg', 'colophonBg'] as const) {
    const next = bg(settings[k]);
    if (next !== settings[k]) settingsPatch[k] = next;
  }
  if (settings.chapterBg) {
    let changed = false;
    const next: Record<number, BgSpec> = {};
    for (const [k, v] of Object.entries(settings.chapterBg)) {
      const n = bg(v);
      if (n !== v) changed = true;
      next[Number(k)] = n ?? v;
    }
    if (changed) settingsPatch.chapterBg = next;
  }
  if (settings.columnPages) {
    let changed = false;
    const next = settings.columnPages.map((c) => {
      const n = bg(c.bg);
      if (n === c.bg) return c;
      changed = true;
      return { ...c, bg: n };
    });
    if (changed) settingsPatch.columnPages = next;
  }
  // 本文全体の背景(bodyBg は BgSpec ではなく生の文字列。id は隣の bodyBgPresetId)
  if (settings.bodyBg && settings.bodyBgPresetId && filter.bgSrcs.has(settings.bodyBg)) {
    const place: SwapPlace = {
      kind: 'bg', unit: `bg:${settings.bodyBg}`, presetId: settings.bodyBgPresetId, src: settings.bodyBg, wide: false,
    };
    places.push(place);
    const n = pick(place);
    if (n && n !== settings.bodyBg) settingsPatch.bodyBg = n;
  }

  return {
    places,
    ...(Object.keys(settingsPatch).length ? { settings: settingsPatch } : {}),
    ...(Object.keys(manuscriptPatch).length ? { manuscript: manuscriptPatch } : {}),
  };
}
