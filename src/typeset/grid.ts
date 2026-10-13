// 版面グリッド計算(docs/typesetting-rules.md §1.1)。
// 字詰・行数はユーザー入力にせず、判型+文字サイズ+余白から必ず整数で導出する。
// 端数は「小口だけ」「地だけ」に押しつけず、ノド:小口・天:地の比を保って配分する。

import type { Bleed4, MarginMins, PlateSize, ProjectSettings, WritingMode } from '../models/project';
import {
  PRINT_TARGETS,
  TRIM_SIZES,
  bindingOf,
  bleedOf,
  bleedSidesText,
  fmtMm,
  maxColumns,
  printRulesOf,
  saddleSpecOf,
  usesOwnPrintRules,
} from '../models/project';
import { isDialogueStart } from './text';

export const PT_TO_MM = 25.4 / 72;

/** 浮動小数点誤差で1行落ちるのを防ぐ */
const EPS = 1e-6;
const floorSafe = (v: number) => Math.floor(v + EPS);

/** KDP ペーパーバックのノド余白下限(mm)。総ページ数連動(rules §1.2)。**KDP の表そのもの**(出し先で変わる下限は gutterFloorMm) */
export function kdpGutterMm(pageCount: number): number {
  if (pageCount <= 150) return 9.6;
  if (pageCount <= 300) return 12.7;
  if (pageCount <= 500) return 15.9;
  if (pageCount <= 700) return 19.1;
  return 22.3;
}

/**
 * ノド余白の下限(mm)。**出し先で決まる。**(2026-10-01)
 * - 「その他の印刷所」で決まりが入っている本 … 利用者の数字。`thickPages` をこえたら
 *   `max(gutterMinMm, thickGutterMm)`(printRulesOf が切り上げ済みだが、ここでも max を取って
 *   下限が下がらないことをこの式だけで読めるようにしておく)、こえなければ `gutterMinMm`
 * - KDP と、決まりをまだ入れていない本 … KDP の表(kdpGutterMm)。古い保存が黙って変わらない
 *
 * - **中綴じの本** … 出し先の中綴じの決まり(saddle.gutterMinMm。10mm)。ページ数では増やさない
 *   (中綴じは根元まで開くので、無線のような厚い本のノドは要らない)。**printRulesOf より先に見る**
 *   (決まりが固定の会社は無線のノド 15mm が返ることがあり、後に置くとそちらが勝つ。2026-10-03)
 *
 * ページ数に対して**減らない**こと(App.tsx の estimatedPages の書き戻しが止まる前提。中綴じは一定値で、これを満たす)
 */
export function gutterFloorMm(
  pageCount: number,
  s: Pick<ProjectSettings, 'printTarget' | 'printRules' | 'binding'>,
): number {
  const saddle = saddleSpecOf(s);
  if (saddle) return saddle.gutterMinMm;
  const r = printRulesOf(s);
  if (!r) return kdpGutterMm(pageCount);
  return r.thickPages !== null && r.thickGutterMm !== null && pageCount > r.thickPages
    ? Math.max(r.gutterMinMm, r.thickGutterMm)
    : r.gutterMinMm;
}

/**
 * ノドの下限が「だれの決まりか」を、文に入れる形で言う。**KDP の本の文は従来のまま**(「KDP の下限」)。
 * 印刷所の決まりが入っていればそれ、出し先が印刷所なのに決まりをまだ入れていない本は
 * 「KDP の決まりの下限」(その本は KDP の表で組んでいる。黙って KDP と言わず、そう言う)
 */
export function gutterFloorLabel(s: Pick<ProjectSettings, 'printTarget' | 'printRules' | 'binding'>): string {
  const p = PRINT_TARGETS[s.printTarget];
  // 中綴じは、無線の決まりとは別の下限(出し先の中綴じの決まり)
  if (bindingOf(s) === 'saddle') return `${p.label}の中綴じの下限`;
  // 会社が決めている出し先は、その会社の名前で言う(「◯◯の決まりの下限」)
  if (p?.rulesSource === 'fixed') return `${p.label}の決まりの下限`;
  if (printRulesOf(s)) return '印刷所の決まりの下限';
  return usesOwnPrintRules(s.printTarget) ? 'KDP の決まりの下限' : 'KDP の下限';
}

/**
 * ノドに要る幅(mm)。出し先の下限(gutterFloorMm)に、**横組みなら行末のぶら下がり1字ぶん**を足す。
 *
 * 本文は `hanging-punctuation: allow-end` で行末の句読点を行の外へ1字ぶら下げる。
 * 横組みの偶数ページは行末がノド側なので、ぶら下がった「、」「。」がノドの余白へ出る
 * (2026-09-27 実測: A5横でノド16.6mm の行から、句読点の字の枠だけ 13.45mm まで出ていた)。
 * 出し先の下限はこの外側で守る。縦組みの行末は地なのでノドには出ない。
 * 字の枠で見ておく(インクは枠の一部だが、入稿の検査が何で測るかは分からないので安全側)
 */
export function gutterNeedMm(
  pageCount: number,
  s: Pick<ProjectSettings, 'writingMode' | 'fontPt' | 'printTarget' | 'printRules' | 'binding'>,
): number {
  const hang = s.writingMode === 'horizontal' ? s.fontPt * PT_TO_MM : 0;
  return gutterFloorMm(pageCount, s) + hang;
}

/**
 * 「印刷所の決まり」の欄の下に出す、**この本に何が起きるか**の文。(2026-10-01 ユーザーと決定
 * 「その場で結果を言う」)。欄の数字そのものではなく、決まりと、その結果の用紙の大きさを言う。
 *
 * 「前の値」は言わない。ノドは余りを配ったあとの値で、決まりを変える前と比べにくいから。
 * 言うのは「◯mm 以上になるように組みます」(下限。gutterNeedMm)だけ — 余りを配った結果は
 * それより広いことがあるが、守る約束は下限のほう。
 *
 * - `kind: 'kdp'` … 出し先が KDP。欄は出さず、読み上げるだけ
 * - `kind: 'fixed'` … 出し先が、会社の決まりで固定(rulesSource が fixed)。欄は出さず、決まりを短く見せるだけ
 * - `kind: 'rules'` … 出し先が印刷所で決まりが入っている
 * - `kind: 'unset'` … 出し先が印刷所だが決まりが無い(古い保存。いまは KDP の決まりで組んでいる)
 *
 * @param pages 紙の本文のページ数(組み上がっていれば実数、まだなら見積もり)
 * @param known pages が組み上がった実数か
 */
export function printRulesResult(
  s: ProjectSettings,
  pages: number,
  known: boolean,
): { kind: 'kdp' | 'fixed' | 'rules' | 'unset'; main: string; extra: string[] } {
  const trim = TRIM_SIZES[s.trim] ?? TRIM_SIZES.bunko;
  const trimName = trim.label.replace(/[\s(（].*$/, '');
  const pageText = known ? `${pages}ページ` : `仮に${pages}ページ`;
  const need = gutterNeedMm(pages, s);
  const floor = gutterFloorMm(pages, s);
  const l = computeLayout({ ...s, estimatedPages: pages });
  const bleedText = bleedSidesText(l.bleed);
  const paperText = `${fmtMm(l.paperW)}×${fmtMm(l.paperH)}mm`;
  const rules = printRulesOf(s);

  // ---- 中綴じ(2026-10-03)。無線の決まりの文(厚い本のノド・「ノドは 15mm 以上」)は言わない。ここで先に返す ----
  const saddle = saddleSpecOf(s);
  if (saddle) {
    const profile = PRINT_TARGETS[s.printTarget];
    const sNeedText =
      need > floor ? `${fmtMm(need)}mm 以上（下限 ${fmtMm(floor)}mm ＋ 句読点 ${fmtMm(need - floor)}mm）` : `${fmtMm(need)}mm 以上`;
    const sBodyW = trim.w - l.margins.gutter - l.margins.fore;
    const sNarrow =
      sBodyW < trim.w / 2
        ? `ただ、本文の幅が仕上がりの半分より狭くなります（${fmtMm(sBodyW)}mm）。ノドの下限が大きすぎないか、見直してください。`
        : '';
    const bleedLine =
      bleedText === '付けない'
        ? `塗り足しは付けません。用紙は ${paperText}（仕上がりと同じ大きさ）です。`
        : `塗り足しは${bleedText}で、用紙は ${paperText} になります。`;
    const hang =
      s.writingMode === 'horizontal'
        ? [`横書きは行末の句読点がノドの側へ出るので、下限に 1字ぶん（${fmtMm(need - floor)}mm）を足して組みます。`]
        : [];
    if (profile.rulesSource === 'fixed') {
      return {
        kind: 'fixed',
        main: `${profile.label}の決まり（${profile.fixedRulesSource ?? '入稿ガイド'}）の中綴じで組みます。塗り足しは${bleedText}、用紙は ${paperText}。綴じる側の余白（ノド）は ${fmtMm(saddle.gutterMinMm)}mm 以上。ここは変えられません。`,
        extra: [`この本（${trimName}・${pageText}）は、ノドが ${sNeedText}になるように組みます。`, ...hang],
      };
    }
    if (!rules) {
      return {
        kind: 'unset',
        main: `この本は、まだ印刷所の決まりを入れていません。いまは中綴じで、塗り足しは${bleedText}・ノドは ${sNeedText}になるように組んでいます。`,
        extra: [],
      };
    }
    return {
      kind: 'rules',
      main: `この本（${trimName}・${pageText}）は、中綴じのノドが ${sNeedText}になるように組みます。${sNarrow}`,
      extra: [
        bleedLine,
        `中綴じは真ん中を留めて根元まで開くので、ノドの下限は ${fmtMm(saddle.gutterMinMm)}mm です。上の「ノドの下限」と「◯ページをこえたら」は、無線綴じのときに使います。`,
        ...hang,
      ],
    };
  }

  if (!rules) {
    // KDP の決まり(出し先が KDP、または決まりを入れていない印刷所の本)。
    // **「ノド」を説明なしに出さない**(2026-10-01 読み直し: KDP はいちばん多くの、はじめての人が通る道)。
    // 数字は欄と同じ関数から(塗り足しは l.bleed、ノドは floor)
    const kdp = `紙の端に ${fmtMm(l.bleed.fore)}mm の塗り足しを付け、綴じる側の余白（ノド）は ${fmtMm(floor)}mm 以上あけます`;
    if (usesOwnPrintRules(s.printTarget)) {
      return {
        kind: 'unset',
        main: `この本は、まだ印刷所の決まりを入れていません。いまは Amazon KDP の決まりで組んでいます。${kdp}。`,
        extra: [],
      };
    }
    return { kind: 'kdp', main: `Amazon KDP の決まりで組みます。${kdp}。ここは変えられません。`, extra: [] };
  }

  const extra: string[] = [];
  extra.push(
    bleedText === '付けない'
      ? `塗り足しは付けません。用紙は ${paperText}（仕上がりと同じ大きさ）です。`
      : `塗り足しは${bleedText}で、用紙は ${paperText} になります。`,
  );
  if (rules.thickPages !== null && rules.thickGutterMm !== null && pages > rules.thickPages && floor > rules.gutterMinMm) {
    extra.push(`${rules.thickPages}ページをこえているので、厚い本のノド（${fmtMm(rules.thickGutterMm)}mm）を使っています。`);
  }
  if (s.writingMode === 'horizontal') {
    extra.push(
      `横書きは行末の句読点がノドの側へ出るので、下限に 1字ぶん（${fmtMm(need - floor)}mm）を足して組みます。`,
    );
  }
  // 横組みの「ノドが 18mm 以上」の 18 は、下限 + 句読点1字ぶん。その行だけで足し算が分かるようにする
  const needText =
    need > floor ? `${fmtMm(need)}mm 以上（下限 ${fmtMm(floor)}mm ＋ 句読点 ${fmtMm(need - floor)}mm）` : `${fmtMm(need)}mm 以上`;
  // 下限を大きくしすぎて、本文の幅が仕上がりの半分を切ったら、その場で言う(2026-10-01 読み直しで発見:
  // ノドの下限 50 で本文 8 行・64 ページになっても、何も言わなかった)
  const bodyW = trim.w - l.margins.gutter - l.margins.fore;
  const narrow =
    bodyW < trim.w / 2
      ? `ただ、本文の幅が仕上がりの半分より狭くなります（${fmtMm(bodyW)}mm）。ノドの下限が大きすぎないか、見直してください。`
      : '';
  const profile = PRINT_TARGETS[s.printTarget];
  if (profile?.rulesSource === 'fixed') {
    // 会社の決まりで固定。決まりそのものを短く言い、そのあとに、この本ではどうなるかを足す
    const thick =
      rules.thickPages !== null && rules.thickGutterMm !== null
        ? `、${rules.thickPages}ページをこえる本は ${fmtMm(rules.thickGutterMm)}mm 以上`
        : '';
    return {
      kind: 'fixed',
      main: `${profile.label}の決まり（${profile.fixedRulesSource ?? '入稿ガイド'}）で組みます。塗り足しは${bleedText}、用紙は ${paperText}。綴じる側の余白（ノド）は ${fmtMm(rules.gutterMinMm)}mm 以上${thick}。ここは変えられません。`,
      extra: [`この本（${trimName}・${pageText}）は、ノドが ${needText}になるように組みます。`, ...extra.slice(1)],
    };
  }
  return {
    kind: 'rules',
    main: `この本（${trimName}・${pageText}）は、ノドが ${needText}になるように組みます。${narrow}`,
    extra,
  };
}

/** 1行の字数上限(rules §0-3) */
const MAX_CHARS: Record<WritingMode, number> = { vertical: 42, horizontal: 40 };

/**
 * 余りを配るときの目標比(rules §1.1-5)。
 * ノドは小口より広くする。くるみ製本は綴じ側が湾曲して読みにくくなるため。
 * 1.4 は出版済みペーパーバックの実測値(ノド:小口 ≒ 1.41)に合わせた。
 */
const GUTTER_PER_FORE = 1.4;
/** 中綴じは根元まで開くので、ノドと小口を同じ幅にする(くるみ製本のような綴じ側の湾曲が無い) */
const GUTTER_PER_FORE_SADDLE = 1.0;
/** 地は天より広くする(視覚的重心を上げる。既定値の天/地もこの比で置いてある) */
const BOTTOM_PER_TOP = 1.25;

/**
 * 版面を引いた残りを2つの余白に比率で配る。両方の下限は必ず満たす。
 *
 * これを入れる前は残り全部を小口(と地)に足していたため、字数上限に当たる判型で
 * 小口がノドの2倍近くまで膨らんでいた(B5横組みの入稿データで ノド17.0 / 小口30.9mm を実測。
 * 2026-08-10)。綴じ側が狭い本は厚くなるほど読めなくなるので、比で配り直す。
 */
function splitMargin(total: number, ratio: number, minLarge: number, minSmall: number) {
  let large = Math.max(minLarge, (total * ratio) / (ratio + 1));
  let small = total - large;
  if (small < minSmall) {
    small = minSmall;
    large = total - small;
  }
  return { large, small };
}

export interface PageLayout {
  /** 仕上がり寸法(断裁後に読者が手に取るサイズ) */
  trimW: number;
  trimH: number;
  /** 入稿する用紙の寸法。仕上がりに塗り足しを足したもの */
  paperW: number;
  paperH: number;
  /**
   * 塗り足し(mm)。天・地・小口・ノドの4辺それぞれ(bleedOf)。
   * KDP はノド側が 0。名前は src/press/types.ts の BodyBoxes(bleedTop…bleedGutter)と対応する
   */
  bleed: Bleed4;
  /** 1行の字数(段組み時は1段あたり) */
  charsPerLine: number;
  /** 1段あたりの行数 */
  linesPerCol: number;
  /** 段数(1 = 段組みなし) */
  columns: number;
  /** ページ全体の行数(= linesPerCol × columns) */
  linesPerPage: number;
  /** 段間(pt) */
  columnGapPt: number;
  /** 端数吸収後の確定余白 mm */
  margins: MarginMins;
  fontPt: number;
  lineFeedPt: number;
  writingMode: WritingMode;
  /**
   * 無線綴じの本が出し先の決まり(印刷所の決まり)を持つとき、**ノドの下限(mm)**。(2026-10-12 修正リスト 4-5)
   * 挿絵ページの「余白すこし」の絵は、ノド側だけこの下限まで空ける(plateInsetsMm)。
   * 中綴じ・KDP・決まりをまだ入れていない本は付けない(挿絵の置き方も組版HTMLも従来のまま)
   */
  plateGutterMm?: number;
}

export function computeLayout(s: ProjectSettings): PageLayout {
  const l = computeLayoutBase(s);
  // 挿絵ページ(余白あり)のノド側の下限。無線綴じで決まりが入っている本だけ(中綴じ・KDP・決まりなしは付けない)
  if (bindingOf(s) === 'perfect' && printRulesOf(s)) {
    const g = gutterFloorMm(s.estimatedPages, s);
    if (g > 0) return { ...l, plateGutterMm: g };
  }
  return l;
}

function computeLayoutBase(s: ProjectSettings): PageLayout {
  const trim = TRIM_SIZES[s.trim] ?? TRIM_SIZES.bunko;
  const charMm = s.fontPt * PT_TO_MM;
  const lineMm = s.lineFeedPt * PT_TO_MM;
  const gutter = Math.max(s.margins.gutter, gutterNeedMm(s.estimatedPages, s));
  // ノドと小口に余りを配る比。中綴じは根元まで開くので、くるみ製本の 1.4 ではなく 1(同じ幅)にする(2026-10-03)。
  // 字詰め・行数はこの比に依らない(余りの配りだけが変わる)
  const gutterPerFore = bindingOf(s) === 'saddle' ? GUTTER_PER_FORE_SADDLE : GUTTER_PER_FORE;
  const m = { ...s.margins, gutter };
  const bleed = bleedOf(s);
  // **かっこを付けて足す。** `trim.h + top + bottom` と順に足すと、判型 12 個中 8 個で末尾の桁が
  // `trim.h + (top + bottom)` と変わる(2026-10-01 実測。KDP の組版を1字も変えないため)
  const paperW = trim.w + (bleed.fore + bleed.gutter);
  const paperH = trim.h + (bleed.top + bleed.bottom);

  // 段組みは縦組みのみ。段間は行数で持ち、行送りに比例させる
  const cols = Math.max(1, Math.min(s.columns || 1, maxColumns(s.trim, s.writingMode)));
  const gapLines = Math.max(0, s.columnGapLines ?? 1);
  const gapMm = lineMm * gapLines;
  const columnGapPt = s.lineFeedPt * gapLines;

  if (s.writingMode === 'vertical') {
    // 縦書き: 行長=天地方向(段で分割する)、行数=左右方向
    const colSpan = (trim.h - m.top - m.bottom - gapMm * (cols - 1)) / cols;
    let charsPerLine = floorSafe(colSpan / charMm);
    charsPerLine = Math.max(1, Math.min(charsPerLine, MAX_CHARS.vertical));
    // 天地方向の余りを天:地に配る(段間ぶんも版面のうち)
    const blockH = charsPerLine * charMm * cols + gapMm * (cols - 1);
    const tb = splitMargin(trim.h - blockH, BOTTOM_PER_TOP, m.bottom, m.top);

    let linesPerCol = floorSafe((trim.w - gutter - m.fore) / lineMm);
    linesPerCol = Math.max(1, linesPerCol);
    // 左右の余りをノド:小口に配る
    const lr = splitMargin(trim.w - linesPerCol * lineMm, gutterPerFore, gutter, m.fore);

    return {
      trimW: trim.w,
      trimH: trim.h,
      paperW,
      paperH,
      bleed,
      charsPerLine,
      linesPerCol,
      columns: cols,
      linesPerPage: linesPerCol * cols,
      columnGapPt,
      margins: { top: tb.small, bottom: tb.large, fore: lr.small, gutter: lr.large },
      fontPt: s.fontPt,
      lineFeedPt: s.lineFeedPt,
      writingMode: s.writingMode,
    };
  }

  // 横書き: 行長=左右方向、行数=天地方向(段組みは対応しない)
  let charsPerLine = floorSafe((trim.w - gutter - m.fore) / charMm);
  charsPerLine = Math.max(1, Math.min(charsPerLine, MAX_CHARS.horizontal));
  const lr = splitMargin(trim.w - charsPerLine * charMm, gutterPerFore, gutter, m.fore);

  let linesPerPage = floorSafe((trim.h - m.top - m.bottom) / lineMm);
  linesPerPage = Math.max(1, linesPerPage);
  const tb = splitMargin(trim.h - linesPerPage * lineMm, BOTTOM_PER_TOP, m.bottom, m.top);

  return {
    trimW: trim.w,
    trimH: trim.h,
    paperW,
    paperH,
    bleed,
    charsPerLine,
    linesPerCol: linesPerPage,
    columns: 1,
    linesPerPage,
    columnGapPt: 0,
    margins: { top: tb.small, bottom: tb.large, fore: lr.small, gutter: lr.large },
    fontPt: s.fontPt,
    lineFeedPt: s.lineFeedPt,
    writingMode: s.writingMode,
  };
}

/**
 * 章ごとに段数・文字サイズ・行送りを変えた章の、1段ぶんの天地(pt)と字数。縦組み用。
 *
 * 版面の四角は本全体の値で決まっていて(@page の余白は1つ)、章はその四角を自分の段数で割る。
 * 式は computeLayout の縦組みと同じ(段間を引いて段数で割り、字数は切り捨て)。
 * 本全体の段は端数を余白へ逃がしてあるので「段の天地 = 字数 × 文字サイズ」だが、
 * 章の段は割った余りを抱えたままになる。だから2つとも返す —
 * 絵の上限には段の天地を、回り込む本文に残す字数の勘定には字数を使う
 *
 * @param gapPt その章の段間(pt)。章で段数を変えたときは章の行送りで引き直してある
 */
export function chapterColumn(
  l: PageLayout,
  cols: number,
  fontPt: number,
  gapPt: number,
): { spanPt: number; chars: number } {
  const blockPt = l.charsPerLine * l.fontPt * l.columns + l.columnGapPt * (l.columns - 1);
  const spanPt = (blockPt - gapPt * (cols - 1)) / cols;
  return { spanPt, chars: Math.max(1, floorSafe(spanPt / fontPt)) };
}

/** 画像を収める領域の実寸(mm)。段組み時は1段ぶんを返す */
export function printAreaMm(l: PageLayout): { w: number; h: number } {
  const block = l.linesPerCol * l.lineFeedPt * PT_TO_MM; // 行が並ぶ方向
  const inline = l.charsPerLine * l.fontPt * PT_TO_MM; // 字が並ぶ方向
  return l.writingMode === 'vertical' ? { w: block, h: inline } : { w: inline, h: block };
}

/** 印刷解像度(dpi)。画像の推奨サイズはこれで換算する */
export const PRINT_DPI = 300;

/** `dpi` を省くと 300。出し先の目安(PRINT_TARGETS の imagePpi)で言うときだけ渡す */
export function mmToPx(v: number, dpi: number = PRINT_DPI): number {
  return Math.round((v * dpi) / 25.4);
}

const mm = (v: number) => `${v.toFixed(2)}mm`;

export function layoutSummary(l: PageLayout): string {
  const head = l.columns > 1 ? `${l.columns}段組 / 1段 ` : '';
  return (
    `${head}${l.charsPerLine}字×${l.linesPerCol}行 / ` +
    `天${mm(l.margins.top)} 地${mm(l.margins.bottom)} 小口${mm(l.margins.fore)} ノド${mm(l.margins.gutter)}`
  );
}

/**
 * 塗り足しを短く言う。全部同じ幅なら「3mm（四辺）」、ノド側が無ければ「3.2mm（天・地・小口）」、
 * 辺ごとに違えば「天 3mm・地 4mm…」。付けない本は「なし」。
 * (文に組み込む言い方は project.ts の bleedSidesText)
 */
export function bleedSummary(b: Bleed4): string {
  const sides: [string, number][] = [
    ['天', b.top],
    ['地', b.bottom],
    ['小口', b.fore],
    ['ノド', b.gutter],
  ];
  const on = sides.filter(([, v]) => v > 0);
  if (on.length === 0) return 'なし';
  if (on.every(([, v]) => v === on[0][1])) {
    return on.length === 4
      ? `${fmtMm(on[0][1])}mm（四辺）`
      : `${fmtMm(on[0][1])}mm（${on.map(([n]) => n).join('・')}）`;
  }
  return on.map(([n, v]) => `${n} ${fmtMm(v)}mm`).join('・');
}

/** 入稿する用紙の寸法(塗り足し込み)。余白の数値は仕上がり基準のまま読ませる */
export function paperSummary(l: PageLayout): string {
  return `${mm(l.paperW)} × ${mm(l.paperH)}(仕上がり ${mm(l.trimW)}×${mm(l.trimH)} + 塗り足し ${bleedSummary(l.bleed)})`;
}

/** 全面画像(ページいっぱい)に必要な画素数。用紙寸法を 300dpi 換算する */
export function fullPagePx(l: PageLayout, dpi: number = PRINT_DPI): { w: number; h: number } {
  return { w: mmToPx(l.paperW, dpi), h: mmToPx(l.paperH, dpi) };
}

/**
 * 挿絵ページの四方の内寸。**仕上がり幅に対する比**で持つので、判型が変わっても
 * 見た目の余白比率が揃う。css.ts の div.plate.wide / .narrow と同じ値を使うこと
 * (別々に持つと、画面に出す推奨サイズと実際の組み上がりがずれる)。
 */
export const PLATE_INSET: Record<PlateSize, number> = { full: 0, wide: 0.04, narrow: 0.2, print: 0, spread: 0 };

/**
 * 版面(余白の内側)の実寸(mm)。**段組みに関係なく、ページの余白を引いた四角。**
 * printAreaMm が「行が実際に並ぶ範囲(段組みなら1段)」なのに対し、こちらは余白の線そのもの。
 * 「版面いっぱい」の絵はこの中に収める(KDP が見るのは余白の線。models/project.ts の PlateSize)
 */
export function pageAreaMm(l: PageLayout): { w: number; h: number } {
  return {
    w: l.trimW - l.margins.gutter - l.margins.fore,
    h: l.trimH - l.margins.top - l.margins.bottom,
  };
}

/**
 * 見開きの絵(PlateSize の 'spread')が敷かれる四角(mm)。**向かい合う2ページの仕上がり + 外側の塗り足し(小口の2つ)・天地の塗り足し。**
 * 幅は 仕上がり2枚 + 小口の塗り足し2つ、高さは用紙の高さ(天 + 仕上がり + 地)。
 * ノド側の塗り足し(KDP は 0、印刷所は決まりしだい)は、折り目の両側でこの絵のなかに入る(typeset/spread.ts)ので足さない。
 * 絵の縦横比がこれと違うときは、全面と同じに中央を切り出して埋める(object-fit: cover)
 */
export function spreadArtMm(l: Pick<PageLayout, 'trimW' | 'paperH' | 'bleed'>): { w: number; h: number } {
  return { w: l.trimW * 2 + l.bleed.fore * 2, h: l.paperH };
}

/** 挿絵ページに入れる画像の実寸(mm)。全面だけ塗り足し込みの用紙寸法になる。
 * 版面いっぱいは仕上がりの比ではなく本文の余白で決まるので、PLATE_INSET を通さない */
export function plateAreaMm(l: PageLayout, size: PlateSize): { w: number; h: number } {
  if (size === 'full') return { w: l.paperW, h: l.paperH };
  if (size === 'spread') return spreadArtMm(l);
  if (size === 'print') return pageAreaMm(l);
  const ins = plateInsetsMm(l, size);
  // 左右対称のときは従来の式のまま(浮動小数点の最後の桁まで変えない)
  return { w: l.trimW - (ins.gutter === ins.fore ? ins.fore * 2 : ins.fore + ins.gutter), h: l.trimH - ins.top * 2 };
}

/**
 * 挿絵ページ(余白すこし・おおめ)の絵の四方の内寸(mm)。**css.ts の div.plate.wide / .narrow と textcheck/geometry.ts が同じ値を使う。**
 * 天地・小口側は仕上がり幅の比(PLATE_INSET)。**ノド側だけ**、無線綴じで決まりの入った本はノドの下限(l.plateGutterMm)まで空ける
 * (2026-10-12 修正リスト 4-5。A5 の「余白すこし」は 4% = 5.9mm で、下限 15mm を割っていた)。
 * 比のほうが大きい(おおめなど)ときは比のまま。左右が非対称になるので、絵は縦横比を保ったまま空けたぶん小さくなる。
 * gutter > fore のときだけノド側を空けている(= 規則を足す)。そうでなければ従来の左右対称
 */
export function plateInsetsMm(
  l: Pick<PageLayout, 'trimW' | 'plateGutterMm'>,
  size: 'wide' | 'narrow',
): { top: number; fore: number; gutter: number } {
  const inset = l.trimW * PLATE_INSET[size];
  return { top: inset, fore: inset, gutter: Math.max(inset, l.plateGutterMm ?? 0) };
}

/** 挿絵ページに入れる画像の推奨画素数(300dpi) */
export function platePx(l: PageLayout, size: PlateSize): { w: number; h: number } {
  const a = plateAreaMm(l, size);
  return { w: mmToPx(a.w), h: mmToPx(a.h) };
}

// ---- コラムページ(本文と組み方向の違う1ページ) ----
//
// **あふれたら紙から落ちる。** 1ページに収める作りなので、書きすぎても
// 次のページへは流れず、版面の外へ伸びたまま断裁される。
// 画面で先に止めるために、ここで版面の実寸から収容量を出す。
//
// 見出しの大きさ・アキは css.ts の section.colpage と**同じ値を使うこと**
// (別々に持つと、画面の警告と実際の組み上がりがずれる。PLATE_INSET と同じ理由)。

/** 見出しの文字サイズ(本文比) */
export const COLPAGE_TITLE_SIZE = 1.3;
/** 見出し1行の行送り(本文の行送り比) */
export const COLPAGE_TITLE_LINE = 1.5;
/** 見出しと本文のあいだのアキ(本文の行数) */
export const COLPAGE_TITLE_GAP = 0.8;

export interface ColumnPageFit {
  /** 1行に入る字数 */
  charsPerLine: number;
  /** ページに入る行数 */
  linesPerPage: number;
  /** 見出しが食う行数(見出しが無ければ 0) */
  titleLines: number;
  /** 本文に残る行数 */
  bodyLines: number;
  /** 本文が実際に使う行数(段落ごとに切り上げ) */
  usedLines: number;
  /**
   * 本文に入る字数の目安。
   * 行数 × 1行の字数から、1字下げのぶん1字を引いた値
   * (引かないと「目安ちょうど」で警告が出て、画面の中で言うことが食い違う)
   */
  capacity: number;
  /** いま書かれている字数(改行を除く) */
  chars: number;
  /** 収まらない */
  over: boolean;
}

/**
 * コラムページ1枚が収まるかを見る。
 *
 * 版面は @page の余白を引いた実寸そのもの(css.ts の pageAreaW / pageAreaH と同じ式)。
 * 塗り足しは天地・小口・ノドの余白に足して用紙を広げているだけなので、ここでは打ち消し合う:
 *   版面幅 = 仕上がり幅 − ノド − 小口 ／ 版面高 = 仕上がり高 − 天 − 地
 *
 * そのページの組み方向で、字が並ぶ辺と行が並ぶ辺が入れ替わる:
 *   横組み … 1行の字数 = 版面幅 / 文字サイズ、行数 = 版面高 / 行送り
 *   縦組み … 1行の字数 = 版面高 / 文字サイズ、行数 = 版面幅 / 行送り
 *
 * 字数ではなく**行数で見る**。1行に満たない段落も1行を占めるので、
 * 字数だけで見ると短い段落を並べたときに必ず外す。
 * 1字下げ(text-indent: 1em)ぶんも段落ごとに1字として数える。
 */
export function fitColumnPage(
  l: PageLayout,
  mode: WritingMode,
  title: string,
  paragraphs: string[],
  /** そのページだけの文字サイズ・行送り(pt)と、文字領域を狭める余白(片側%)。省略なら本文と同じ・余白なし */
  type?: { fontPt?: number; lineFeedPt?: number; padXPct?: number; padYPct?: number },
): ColumnPageFit {
  // 余白指定(padXPct/padYPct)は css.ts が padding で狭めるのと同じ式で引く。
  // ここで引かないと「入る字数の目安」だけ版面いっぱいで数えて、目安が嘘になる
  const areaW =
    (l.trimW - l.margins.gutter - l.margins.fore) * (1 - (2 * (type?.padXPct ?? 0)) / 100);
  const areaH =
    (l.trimH - l.margins.top - l.margins.bottom) * (1 - (2 * (type?.padYPct ?? 0)) / 100);
  // 文字を小さくすれば入る字数は増える。ここが画面の「入る字数の目安」の元になる
  const fontPt = type?.fontPt ?? l.fontPt;
  const feedPt = type?.lineFeedPt ?? (type?.fontPt ? type.fontPt * (l.lineFeedPt / l.fontPt) : l.lineFeedPt);
  const charMm = fontPt * PT_TO_MM;
  const lineMm = feedPt * PT_TO_MM;

  const vertical = mode === 'vertical';
  const lineLenMm = vertical ? areaH : areaW; // 字が並ぶ辺
  const stackMm = vertical ? areaW : areaH; // 行が並ぶ辺

  const charsPerLine = Math.max(1, floorSafe(lineLenMm / charMm));
  /** 端数を保った行数。あふれ判定はこちらで見る(下の over のコメント) */
  const linesFloat = stackMm / lineMm;
  const linesPerPage = Math.max(1, floorSafe(linesFloat));

  // 見出しは本文より大きいので、入る字数も少ない。折り返したぶんだけ行を食う
  const t = title.trim();
  const titleChars = Math.max(1, floorSafe(lineLenMm / (charMm * COLPAGE_TITLE_SIZE)));
  const titleLines = t
    ? Math.ceil(t.length / titleChars) * COLPAGE_TITLE_LINE + COLPAGE_TITLE_GAP
    : 0;

  const bodyLines = Math.max(0, linesPerPage - titleLines);
  // '' は1行アキ(columnPageParagraphs)。折り返し計算には掛けず1行として数える。
  // 字下げの1字は html.ts と同じ条件で足す——会話文(「…)は字下げ無しで組む
  // (2026-09-12 ユーザー報告)。さらに本文CSSは hanging-punctuation: allow-end で
  // **行末の句読点をぶら下げる**ので、句読点も1マスに数えると段落ごとに
  // 1行ずつ過大になりうる(2026-09-13「収まっているのにエラー」の再々発)。
  // ここでも同じ規則で行を詰めて数える: 行の頭から1行ぶん取り、あふれた先頭が
  // 句読点ならその行の末尾にぶら下げて一緒に消費する
  const HANG = '、。，．';
  const paraLines = (p: string): number => {
    const ind = isDialogueStart(p) ? 0 : 1;
    let pos = 0;
    let lines = 0;
    while (pos < p.length) {
      let end = pos + charsPerLine - (lines === 0 ? ind : 0);
      if (end < p.length && HANG.includes(p[end])) end++;
      pos = end;
      lines++;
    }
    return Math.max(1, lines);
  };
  const usedLines = paragraphs.reduce((n, p) => n + (p === '' ? 1 : paraLines(p)), 0);
  const chars = paragraphs.reduce((n, p) => n + p.length, 0);

  return {
    charsPerLine,
    linesPerPage,
    titleLines,
    bodyLines,
    usedLines,
    capacity: Math.max(0, Math.floor(bodyLines) * charsPerLine - 1),
    chars,
    /**
     * **半行ぶんの猶予を持って判定する。**(2026-09-11 ユーザー報告
     * 「原稿が収まっているにもかかわらずエラーが出る」)
     * この目安は floor と ceil を重ねた保守的な数え方で、実際の組版が
     * 収めた紙面を 1 行未満の差で「収まらない」と言うことがあった
     * (実測: 21字×13行の面で、目安 11 行 vs 実際は収まる)。
     * 端数を捨てない行数(linesFloat)と比べ、半行を超えるあふれだけ赤にする
     */
    over: usedLines > Math.max(0, linesFloat - titleLines) + 0.5,
  };
}
