import bundledManifestJson from './manifest.bundled.json';

// プリセット一覧の読み込み。**同梱ぶんと自分ぶんを繋げて返す。**
//
// `public/covers/manifest.json`      … 配布に同梱する画像(scripts/build-covers.py)
// `public/covers/manifest.mine.json` … 自分で足した画像(scripts/add-my-covers.py)
//
// 自分ぶんは .gitignore に入れてあるので、配布用のビルドには入らない。
// **無いのが普通なので、404 は黙って捨てる。**
//
// ## 同梱ぶんだけは焼き込みコピーも持つ(2026-09-14)
//
// `public/covers/manifest.json` は実行時に fetch しているだけなので、file:// で直接開いた
// ときや配置ミス・アップロードの取りこぼしがあると fetch が黙って失敗し、**プリセットが
// 0件になって選択画面が壊れる。** これを防ぐため `manifest.bundled.json` を static import で
// JS バンドルに焼き込み、fetch が失敗または0件のときだけ使う。公開フォルダの manifest が
// 更新されていれば、従来どおり fetch の結果が勝つ。

/**
 * 絵を敷く面。プリセットを出し分けるのに使う。
 *
 * - `cover` … 表紙(表1・背・表4)。CoverEditor
 * - `body`  … 本文の地・章の地・大扉・コラム・挿絵。BackgroundPicker
 */
export type PresetSurface = 'cover' | 'body';

/** manifest の1件。フィールドは build-covers.py の出力に合わせてある */
export interface CoverManifestEntry {
  id: string;
  group: string;
  groupLabel: string;
  theme: string;
  themeLabel: string;
  taste?: string;
  tasteLabel?: string;
  file: string;
  thumb: string;
  lum: number;
  w: number;
  h: number;
  /**
   * その絵を出す面の限定。**省略が既定で、省略なら両方に出す。**
   * こう決めたので、同梱の縦長の絵の manifest は1行も書き換えずに済んでいる。
   *
   * いまは `'body'`(帯つきの本文の地)だけが付く。1278×1824 の紙面いっぱいの地で、
   * 帯の位置が版面の天地に合わせてあるため、表紙に敷いても意味を持たない。
   * 判定は scripts/build-covers.py の USE_BY_GROUP が決める(手で書くのは1か所)。
   */
  use?: PresetSurface;
  /** 選ぶ画面にテーマごとに1行だけ添える断り書き。無ければ何も出さない */
  note?: string;
}

/**
 * その面に出してよい絵か。
 *
 * **表紙と本文で非対称にしている。**
 * - 表紙には `use: 'body'` の絵を出さない。帯は版面を基準に描いてあるので表紙では意味が無い
 * - 本文の地には**表紙用の縦長の絵もそのまま出す。** 表紙用を外すと機能後退になる:
 *   同梱の縦長の絵は全面画像で本文の地として実際に使えるし、サンプルの本文・大扉・章の地は
 *   いまも同梱の絵から採っている(sampleArt.ts)。BackgroundPicker が
 *   「買った素材を本文でも使い回せる」ために表紙パックを読んでいるのも元からの狙い
 */
function usableOn(e: CoverManifestEntry, surface: PresetSurface): boolean {
  // まるごと1枚(表1・背・表4にまたがる横長の絵。use: 'cover')は本文の地には出さない。
  // 横長の見開きを縦の紙面に敷いても使い道が無い(2026-09-27 ユーザー要望
  // 「まるごと表紙用のプリセットは、まるごと表紙を選ぶときにだけ出したい」)
  if (surface === 'body') return e.use !== 'cover';
  return e.use === undefined || e.use === surface;
}

/**
 * まるごと1枚(表紙全体)の絵か。**表紙の選択画面では、これだけを出す面と、これを出さない面に分ける。**
 * 「まるごと1枚」を選ぶときは横長の見開きの絵だけが要り、表1・表4を選ぶときには要らない
 * (2026-09-27 ユーザー要望)
 */
export function isWrapPreset(e: { group?: string }): boolean {
  return e.group === 'wrap';
}

/** 焼き込みコピー(manifest.bundled.json)。fetch が失敗/0件のときだけ使う保険 */
const bundledManifest = bundledManifestJson as CoverManifestEntry[];

async function load(url: string): Promise<CoverManifestEntry[]> {
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const list = await r.json();
    return Array.isArray(list) ? (list as CoverManifestEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * 同梱ぶん → 自分ぶんの順で1本にし、**その面に使えるものだけ**を返す。
 *
 * **自分ぶんを後ろにするのは意図的。** 一覧はテーマごとに区切って出すので、
 * 先に置くと同梱の絵より先に自分の絵が並ぶ。
 * 使い慣れた絵を上に出したい人は、そのときに並べ替えを考える
 *
 * 面は**必ず渡させる。** 既定値を置くと、新しい呼び出し元が絞り込みを忘れたときに
 * 表紙の選択画面へ本文用の絵が漏れる(この関数を分けた理由そのもの)。
 * 自分で足した画像(manifest.mine.json)に `use` は付かないので、どちらの面にも出る。
 */
export async function loadCoverPresets(surface: PresetSurface): Promise<CoverManifestEntry[]> {
  const [fetched, mine] = await Promise.all([
    load('covers/manifest.json'),
    load('covers/manifest.mine.json'),
  ]);
  // fetch が成功して1件以上あればそれを使い、失敗/0件なら焼き込みコピーで補う
  const bundled = fetched.length > 0 ? fetched : bundledManifest;
  return [...bundled, ...mine].filter((e) => usableOn(e, surface));
}
