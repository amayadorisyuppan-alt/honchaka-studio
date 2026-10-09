// スタジオの版面(PageLayout)・表紙の寸法(CoverLayout)から、PDF/X の箱(PressBoxes)を作る。
//
// **塗り足しの値の読み方を1か所にまとめる。** 「出し先ごとの塗り足し」(印刷所の決まり。ノド側にも付けるか)で
// PageLayout.bleed が変わっても、ここを通せば箱はそれに従う。
import type { PageLayout } from '../typeset/grid.ts';
import type { BodyBoxes, CoverBoxes } from './types.ts';

/**
 * 箱の数が使えない値(有限でない・負)のときは、例外にする。
 * NaN のまま通すと、PDF に `/TrimBox [… NaN …]` が書かれ、点検は「BleedBox が MediaBox の外」と的外れなことを言う(2026-10-01 実測。reports/2-1.md の 6)。
 * 値は書き出しの設定から計算される物なので、ここに来る NaN・負は呼び出し側の不具合。早く・読める文で止める
 */
function needLength(what: string, values: (number | undefined)[]): void {
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
    throw new Error(`箱の大きさの計算に使えない値です(${what}: ${values.join('・')})。有限の 0 以上の数でなければなりません`);
  }
}
/** 仕上がりの大きさ。0 以下も不可(0 の本は作れない) */
function needSize(what: string, values: number[]): void {
  if (!values.every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error(`箱の大きさの計算に使えない値です(${what}: ${values.join('・')})。有限の 0 より大きい数でなければなりません`);
  }
}

/**
 * 本文の箱。塗り足しは天・地・小口・ノドの4辺それぞれ(KDP はノド側が 0)。
 *
 * **1ページ目のノドは、縦組み(右綴じ)なら右、横組み(左綴じ)なら左。**
 * 根拠は2つ。
 *  - src/typeset/css.ts の `rectoLR`/`versoLR`: 縦組みは `:recto`(奇数ページ)に `margin-right: ノド`、横組みは `margin-left: ノド`。
 *    1ページ目は奇数ページ(:recto)なので、縦なら右・横なら左がノド
 *  - 実物(2026-10-01 に fixtures を測った): 縦組みの color-a5.pdf は奇数ページ(5・7)の版面が左 48.9pt・右 59.7pt で
 *    ノド側(右)の余白が広く、偶数ページ(6)は逆(左 59.5pt・右 49.2pt)。mono-bunko・sakura-shinsho も同じ。
 *    横組みの実物は無いので、そちらは css.ts の決まりだけが根拠
 */
export function bodyBoxes(l: Pick<PageLayout, 'trimW' | 'trimH' | 'bleed' | 'writingMode'>): BodyBoxes {
  needSize('本文の仕上がり', [l.trimW, l.trimH]);
  needLength('本文の塗り足し', [l.bleed?.top, l.bleed?.bottom, l.bleed?.fore, l.bleed?.gutter]);
  return {
    kind: 'body',
    trimW: l.trimW,
    trimH: l.trimH,
    bleedTop: l.bleed.top,
    bleedBottom: l.bleed.bottom,
    bleedFore: l.bleed.fore,
    bleedGutter: l.bleed.gutter,
    firstGutter: l.writingMode === 'vertical' ? 'right' : 'left',
  };
}

/**
 * 表紙の箱。展開(表4・背・表1)の全体の寸法 totalW×totalH は塗り足しを含み、塗り足しは四辺とも同じ幅。
 * 仕上がり(TrimBox)は、そこから四辺の塗り足しを引いたもの
 */
export function coverBoxes(l: { totalW: number; totalH: number; bleed: number }): CoverBoxes {
  needLength('表紙の塗り足し', [l.bleed]);
  needSize('表紙の展開の大きさ', [l.totalW, l.totalH]);
  needSize('表紙の仕上がり(展開から塗り足しを引いた大きさ)', [l.totalW - l.bleed * 2, l.totalH - l.bleed * 2]);
  return {
    kind: 'cover',
    trimW: l.totalW - l.bleed * 2,
    trimH: l.totalH - l.bleed * 2,
    bleed: l.bleed,
  };
}
