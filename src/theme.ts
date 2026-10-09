// 画面の色(明るい / 暗い)の覚え方。
//
// **本の設定ではないので `ProjectSettings` には入れない。**(2026-08-20 ユーザー判断)
// 判型や書体は本そのものの持ちものだが、画面を明るくするか暗くするかは
// **その人の目と机の明るさの話**で、本には関係がない。settings に混ぜると
// プロジェクトの .json に載ってしまい、**ファイルを誰かに渡した瞬間に
// 相手の画面まで作者の好みへ書き換わる**。AI に渡して返してもらう往復でも、
// 本文とは無関係の値が毎回旅をすることになる。
// だから保存先はブラウザの localStorage(この PC のこのブラウザだけ)にする。
//
// **既定は「OS に合わせる」。**(2026-08-20 ユーザー判断)
// いまの利用者は暗い画面に慣れており、明るいほうを一律の既定にすると
// 次に開いたときに別のアプリに見える。かといって暗いままだと
// 「デフォルトカラーも欲しい」という要望に応えられない。
// OS の設定に従えば、暗い画面で作業している人はそのまま暗く、
// 昼間に明るい設定で使っている人は最初から明るい。**選ばせずに正解が出る。**
//
// **手で選んだときだけ覚えて、OS より優先する。** 3つの状態を持つ:
//   'system'(既定・記録しない) / 'light' / 'dark'
//
// 解決(どちらの色にするか)は**この 1 か所だけ**でやり、CSS には
// `prefers-color-scheme` を書いていない。メディアクエリの中に色を書くと、
// 手で選んだ指定が勝てるかどうかをセレクタの重みで考え続けることになる。
// ここが `<html data-theme="light|dark">` を貼り、app.css はそれだけを見る。

/** 利用者の選択。'system' は「OS に合わせる」(=記録しない) */
export type ThemePref = 'system' | 'light' | 'dark';

/** 実際に画面へ出る色。data-theme に貼る値 */
export type ThemeMode = 'light' | 'dark';

/**
 * localStorage の鍵。
 * **index.html の先頭のスクリプトにも同じ文字列が書いてある。**
 * あちらは「最初の一瞬だけ違う色が出る」のを防ぐためだけの写しなので、
 * 鍵の名前を変えるときは必ず両方直すこと。
 */
export const THEME_KEY = 'book-studio-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** いまの選択を読む。壊れた値や未設定は 'system' に倒す */
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // プライベートモードなどで localStorage が使えないことがある。
    // 覚えられないだけで動きはするので、黙って 'system' で続ける
  }
  return 'system';
}

/** 選択から、実際に出す色を決める */
export function resolveTheme(pref: ThemePref): ThemeMode {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** `<html data-theme="...">` を貼り替える。app.css が見ているのはこれだけ */
export function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode;
}

/** 選択を覚えて、その場で貼り替える。'system' は記録そのものを消す */
export function saveThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // 覚えられなくても、この画面が開いているあいだは効かせる
  }
  applyTheme(resolveTheme(pref));
}

/**
 * OS の設定が変わったら追随する。**'system' のときだけ。**
 * 手で選んでいる人の画面が、OS の自動切り替え(夜になったら暗く、など)で
 * 勝手に変わってはいけない。
 * 戻り値は購読をやめる関数。
 */
export function watchSystemTheme(getPref: () => ThemePref): () => void {
  if (!window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () => {
    if (getPref() === 'system') applyTheme(resolveTheme('system'));
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
