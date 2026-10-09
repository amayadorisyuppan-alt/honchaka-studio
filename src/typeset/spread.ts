// 見開きの絵(挿絵ページの「見開き（2ページ）」)の、ページ割り・切り出しの計算と知らせの文。(2026-10-03)
//
// **1枚の横長の絵を、向かい合う2ページに分けて入れる。** ここは**純関数**だけを置く
// (ブラウザなしで検査できる。scripts/spread.test.ts)。組版CSS(css.ts)・文字の検査(textcheck/geometry.ts)・
// 画面の知らせ(PlateEditor)は、みなここの数字と文を使う。
//
// ## 向かい合う2ページ = 偶数ページから始まる2ページ
//
// 本は1ページ目が片側(横組みは右・縦組みは左)に出て、そのあと2ページ目と3ページ目が向かい合う。
// なので見開きは「偶数ページ + そのつぎの奇数ページ」(2-3、4-5 …)。
// 組版は1ページ目の絵に `break-before: verso`(偶数ページから始める)を付ける。奇数ページに来てしまうとき、
// 組版エンジンが白いページを1枚入れて偶数ページへ送る(章の起こしの `break-before: recto` と同じ仕組み)。
// 入れたことは画面で知らせる(PageThumbs の autoBlank の読み取り・PlateEditor の1行)。**黙って足さない。**
//
// ## 左右の割り当て(本を開いた見た目どおり)
//
//   横組み(左綴じ) … 偶数ページが左・奇数ページが右 → 1ページ目 = 絵の左半分、2ページ目 = 右半分
//   縦組み(右綴じ) … 偶数ページが右・奇数ページが左 → 1ページ目 = 絵の右半分、2ページ目 = 左半分
//   (どちらも、偶数ページのノド側が折り目に向く。pdfx.ts の pageBoxesPt・scripts/check-bleed.py の gutter_on_left と同じ決まり)
//
// ## 塗り足し(折り目をまたぐ)
//
// 絵は「向かい合う2ページの仕上がり + 小口側の塗り足し2つ + 天地の塗り足し」に敷く(grid.ts の spreadArtMm)。
// 各ページの用紙は、**そのページの半分 + ノド側の塗り足しの幅だけ反対側の絵**を含む。
// 折り目では2つの用紙が絵を共有して重なる(KDP はノド側の塗り足しが 0 なので重ならないが、同じ式で出る)。
// 断裁・製本でどちらに寄っても、折り目に白い筋が出ない。

import type { Binding, WritingMode } from '../models/project';
import type { PageLayout } from './grid';
import { spreadArtMm } from './grid';

/** 見開きの左右(本を開いた見た目) */
export type HalfSide = 'left' | 'right';

/** 絵の中心(折り目)から左右にこの幅(mm)には、顔・文字・細い線を置かない(印刷所の入稿ガイドの中綴じの注意。綴じ・折り・断裁で ±1mm ほどずれる) */
export const SPREAD_FOLD_SAFE_MM = 5;
/** 無線綴じで、折り目の近くが糊に隠れる幅(片側 mm のめやす) */
export const PERFECT_GLUE_HIDDEN_MM = 10;

/** 見開きの1ページぶん */
export interface SpreadHalf {
  /** 本を開いたときの左右 */
  side: HalfSide;
  /**
   * そのページの用紙の左端は、絵の左端から何 mm 右にあるか。
   * CSS では絵(幅 artW)を `left: -offset` に置き、用紙の幅で切る。
   * 横書きの1ページ目は 0、2ページ目は 仕上がり幅 + 小口の塗り足し − ノドの塗り足し
   */
  offset: number;
}

export interface SpreadGeometry {
  /** 絵が敷かれる四角(mm)。幅 = 仕上がり2枚 + 小口の塗り足し2つ、高さ = 用紙の高さ */
  artW: number;
  artH: number;
  /** 折り目の位置(絵の左端から。幅の真ん中) */
  foldX: number;
  /** 偶数ページ(見開きの1ページ目) */
  first: SpreadHalf;
  /** 奇数ページ(見開きの2ページ目) */
  second: SpreadHalf;
}

/**
 * 見開きの切り出し。`l` は組版の PageLayout(用紙・塗り足し)。
 * 縦組みは偶数ページが右、横組みは偶数ページが左(上の「左右の割り当て」)
 */
export function spreadGeometry(l: Pick<PageLayout, 'trimW' | 'paperW' | 'paperH' | 'bleed'>, mode: WritingMode): SpreadGeometry {
  const art = spreadArtMm(l);
  // 右の半分の用紙の左端(絵の左端から)。左の用紙は 0 から始まる
  const rightOffset = l.trimW + l.bleed.fore - l.bleed.gutter;
  const vertical = mode === 'vertical';
  return {
    artW: art.w,
    artH: art.h,
    foldX: art.w / 2,
    first: { side: vertical ? 'right' : 'left', offset: vertical ? rightOffset : 0 },
    second: { side: vertical ? 'left' : 'right', offset: vertical ? 0 : rightOffset },
  };
}

/**
 * 見開きの1ページ目が何ページ目に来るか。
 * @param pagesBefore その絵より前にあるページの数(白いページ・前の絵ページも含む)
 * @returns start = 1ページ目の番号(1始まり。かならず偶数)、pad = 手前に入る白いページの数(0 か 1)
 */
export function spreadStart(pagesBefore: number): { start: number; pad: 0 | 1 } {
  const next = Math.max(0, Math.floor(pagesBefore)) + 1;
  return next % 2 === 0 ? { start: next, pad: 0 } : { start: next + 1, pad: 1 };
}

/** 本の中に並ぶ、1ページものと見開き(2ページ)の列 */
export type PageItem = 'one' | 'spread';

export interface PagePlan {
  item: PageItem;
  /** このものの1ページ目の番号(1始まり)。見開きはかならず偶数 */
  start: number;
  /** 手前に組版が入れる白いページの数(見開きだけ。0 か 1) */
  pad: 0 | 1;
  /** このもののページ数(1ページもの 1・見開き 2) */
  pages: 1 | 2;
}

/**
 * 1ページもの('one')と見開き('spread')の並びを、本の中のページ番号に直す。
 * 見開きは偶数ページから始まり、合わないときは手前に白いページが1枚入る。**入れる枚数の数え方は組版と同じ**
 * (組版は break-before: verso。奇数ページに来るときだけ白を1枚)。
 * @param pagesBefore 並びの手前にあるページの数
 */
export function planPages(items: readonly PageItem[], pagesBefore = 0): PagePlan[] {
  const out: PagePlan[] = [];
  let n = Math.max(0, Math.floor(pagesBefore));
  for (const item of items) {
    if (item === 'one') {
      out.push({ item, start: n + 1, pad: 0, pages: 1 });
      n += 1;
    } else {
      const { start, pad } = spreadStart(n);
      out.push({ item, start, pad, pages: 2 });
      n = start + 1;
    }
  }
  return out;
}

/** 折り目のまわり(絵の左端から測った x の範囲)。中心から左右 SPREAD_FOLD_SAFE_MM */
export function foldBand(g: Pick<SpreadGeometry, 'foldX'>): { x0: number; x1: number } {
  return { x0: g.foldX - SPREAD_FOLD_SAFE_MM, x1: g.foldX + SPREAD_FOLD_SAFE_MM };
}

// ---- 画面に出す文 ----

/** 見開きの絵の行に出す、綴じ方ごとの注意(1行)。**中綴じが向いている・無線は真ん中が見えにくい。** 選べないわけではない */
export function spreadBindingNote(binding: Binding): string {
  return binding === 'saddle'
    ? `中綴じは根元まで開くので、見開きの画像にいちばん向いています。ただ、綴じや断裁で ±1mm ほどずれるので、真ん中（折り目）の左右 ${SPREAD_FOLD_SAFE_MM}mm には、顔・文字・細い線を置かないでください（背景や大きな面はまたいで大丈夫です）`
    : `無線綴じでは、真ん中が糊で隠れて見えにくくなります（片側 ${PERFECT_GLUE_HIDDEN_MM}mm ほど）。真ん中に顔や文字を置かない画像にしてください`;
}

/** 白いページを1枚入れたときの知らせ(その絵の行に1行) */
export const SPREAD_AUTO_BLANK_NOTE =
  '見開きは、偶数ページから始まる向かい合う2ページに入れます。このままだと奇数ページから始まってしまうので、この画像の前に白いページを1枚入れています。前に画像やクッションページを1枚足すと、白いページは要りません';

/**
 * すでに選んである絵の大きさを「見開き」に切り替えても、絵は取り込んだときの大きさ(長い辺 4200px まで)のまま。
 * 見開きは用紙2枚ぶんで 6200px まで取り込めるので、細かさが足りないときの手がかりを1行で言う(2026-10-03 レビュー)
 */
export const SPREAD_REPICK_NOTE = '大きさを「見開き」にしてから画像を選び直すと、大きいまま取り込めます';

/**
 * 見開きの行に出す、絵の画素数から言えること(1行ずつ)。
 * @param capSide 切り替える前の取り込みの上限(images/optimize の PRINT_MAX_SIDE)。絵の長い辺がそこで頭打ちなら「縮められている」とみなす
 * @param short 細かさが出し先の目安に届いていない(resRows に入っている)か
 */
export function spreadImageNotes(
  px: { w: number; h: number } | null | undefined,
  g: Pick<SpreadGeometry, 'artW' | 'artH'>,
  capSide: number,
  short: boolean,
): string[] {
  if (!px) return [];
  const out: string[] = [];
  const aspect = spreadAspectNote(px, g);
  if (aspect) out.push(aspect);
  if (short && Math.max(px.w, px.h) >= capSide - 2) out.push(SPREAD_REPICK_NOTE);
  return out;
}

/** 電子書籍の下見・書き出しでの見え方 */
export const SPREAD_EBOOK_NOTE =
  '電子書籍では、端末によって見開きの見せ方がばらばらなので、1ページに横長の画像をまるごと縮めて入れます';

/**
 * 絵の縦横比が、見開きの四角と大きく違うとき(横長でない)の注意。比が 1.2 倍以上ずれたら言う。
 * 画面では［挿絵］の見開きの行に出す(App が絵の画素数から作る。2026-10-03 レビューで「定義だけで出ていない」と指摘)
 */
export function spreadAspectNote(px: { w: number; h: number }, g: Pick<SpreadGeometry, 'artW' | 'artH'>): string | null {
  if (!(px.w > 0) || !(px.h > 0)) return null;
  const want = g.artW / g.artH;
  const have = px.w / px.h;
  const r = have / want;
  if (r >= 1 / 1.2 && r <= 1.2) return null;
  return r > 1
    ? '画像が見開きの形より横に長いので、左右が少し切れます（画像の中央を、見開きいっぱいに合わせて使います）'
    : '画像が見開きの形より縦に長いので、上下が少し切れます（画像の中央を、見開きいっぱいに合わせて使います）';
}
