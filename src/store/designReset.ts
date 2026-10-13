// 本全体の［すべてリセット］のうち、コラム・大扉・目次・奥付の帯が書き込んだ見た目を戻す部分。
// (2026-10-12 修正リスト 2-3 ユーザー判断「コラム・大扉・目次・奥付の帯で変えたものも戻す」)
//
// 店(useProject)から切り出してあるのは、zustand も IndexedDB も使わない純粋な関数にして、
// 単体の検査(scripts/resetDesign.test.ts)で直に回すため。
import type { BgSpec, ColumnPage, ProjectSettings } from '../models/project';

/**
 * `chapterBg` など背景(BgSpec)のうち、帯が書き込むのはこの3つだけ。
 * **`src`(敷いた絵)・`base`・`printMono` は消さない。** 絵は［本文に画像とコラムを入れる］や［背景］で選ぶもので、
 * 見た目の道具である帯のリセットで消えてよいものではない
 */
export const BG_DESIGN_KEYS = ['opacity', 'outline', 'outlineColor'] as const;

/**
 * コラム(ColumnPage)の欄のうち、帯が書き込む見た目の値。**本全体の［すべてリセット］はこれも落とす。**
 * FormatBar の「このコラムをリセット」の colPatch と同じ並び。片方だけ増やさないこと。
 * 見出し・本文・敷いた絵(bg.src)・組み方向・位置(beforeChapter / order)は帯の持ち物ではないので残す
 */
export const COLUMN_DESIGN_KEYS = [
  'bodyFont',
  'fontPt',
  'lineFeedPt',
  'color',
  'headingFont',
  'headingPt',
  'headingColor',
  'outline',
  'outlineColor',
  'plate',
  'plateColor',
  'padXPct',
  'padYPct',
] as const;

/** 背景(BgSpec)から、帯の濃さ・フチだけを抜く。絵(src)などは残す。空になれば undefined */
export function stripBgDesign(spec: BgSpec | undefined): BgSpec | undefined {
  if (!spec) return undefined;
  const out: BgSpec = { ...spec };
  for (const k of BG_DESIGN_KEYS) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * コラム・大扉・目次・奥付・奥付と著者紹介の書体・大扉の書体について、帯で変えた値を落とした**差分**を返す
 * (渡した settings は書き換えない。呼び出し側が `{ ...settings, ...差分 }` で重ねる)。
 * 戻すのは帯が書き込む見た目の値だけで、コラムの文章・敷いた絵、各ページの絵、書名などの中身は残す
 */
export function resetPageDesigns(s: ProjectSettings): Partial<ProjectSettings> {
  const patch: Partial<ProjectSettings> = {};
  if (s.columnPages?.length) {
    patch.columnPages = s.columnPages.map((c) => {
      const col: ColumnPage = { ...c };
      for (const k of COLUMN_DESIGN_KEYS) delete col[k];
      const bg = stripBgDesign(col.bg);
      if (bg) col.bg = bg;
      else delete col.bg;
      return col;
    });
  }
  for (const k of ['titleBg', 'tocBg', 'colophonBg'] as const) {
    if (s[k]) patch[k] = stripBgDesign(s[k]);
  }
  // 奥付・著者紹介の書体・サイズ・色(MatterType)。帯だけが書き込む入れものなので、まるごと空に戻す
  patch.colophonType = undefined;
  patch.profileType = undefined;
  // 大扉の書名・著者名の書体(今後の改修の希望 5)。省略は本文の書体なので、undefined に戻す
  patch.titlepageTitleFont = undefined;
  patch.titlepageAuthorFont = undefined;
  return patch;
}
