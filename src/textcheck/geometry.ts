// 絵の中の文字が、ページの版面(余白の内側)に収まっているかを判定する。計算だけ(画面も Worker も触らない)。
//
// ## 何を見るか
//
// 版面の外に絵を置ける大きさは4つ: 全面(用紙いっぱい)・余白すこし・余白おおめ(css.ts の div.plate / div.fullbleed)・
// 見開き(2ページにまたがる。用紙2枚ぶん)。「版面いっぱい」と「本文の中」は、絵そのものが版面の中にあるので見ない。
//
// 見開きは、絵を「仕上がり2枚 + 小口の塗り足し」の四角に敷いて、左右のページの用紙で切る(typeset/spread.ts)。
// 文字の箱をそれぞれのページの用紙の mm に直し、**ページごとに**版面と比べる。さらに、折り目の中心から左右 5mm に
// 文字がかかっていれば、それも知らせる(綴じ・折り・断裁で ±1mm ほどずれて、読みにくくなる。印刷所の入稿ガイドの中綴じの章)。
//
// **折り目の側(ノド)の扱いは綴じ方で変わる**(2026-10-05 ユーザー決定):
//   無線綴じ … ノド側も版面で見る。真ん中は糊に食われて見えず、KDP も余白の外の文字は止めるので、強く言う(版面の外)。
//   中綴じ  … 本が根元まで平らに開くので、ノド側の余白は使わない。**折り目から左右 5mm** だけを「読みにくくなる」と
//             やわらかく言い(foldOnly)、それより離れていれば何も言わない。天・地・小口は、どちらの綴じも版面で見る。
//
// 絵の中の文字の箱(絵の画素。textcheck/db.ts)を、絵がページに置かれる位置で用紙の mm に直し、
// 版面の四角と比べる。**ノドと小口は左右のページで入れ替わる**ので、絵が何ページ目に出たか(組み上がりの報せ)が要る。
//
// ## 物差し
//
// 判定は **版面**(本文と同じ余白の内側)。KDP の余白の下限(小口 9.6mm など)より内側なので、
// ここを通る絵は KDP でも通る。逆に、ここで外と言われても KDP は通すことがある(厳しめに倒してある)。
// 利用者に見せる枠も版面なので、「枠の外に字がある」と目で確かめられる(2026-10-02 ユーザー要望)。
import type { Binding, ImageBlock, Manuscript, Plate, ProjectSettings, WritingMode } from '../models/project';
import { PLATE_INSET, type PageLayout } from '../typeset/grid';
import { foldBand, spreadGeometry } from '../typeset/spread';
import type { TextBox } from './db';

/** 版面の外に絵が出うる置き方 */
export type PlaceKind = 'full' | 'wide' | 'narrow' | 'spread';
export type PageSide = 'left' | 'right';

/** 用紙の左上を原点にした四角(mm) */
export interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 文字の検査にかける絵 */
export interface TextTarget {
  /** 'plate' = 挿絵ページ(章の切れ目) / 'img' = 章の途中の絵 */
  kind: 'plate' | 'img';
  /** 挿絵は id、章の途中の絵は imageKey(章, 並び)。下見の data-plate / data-img と同じ値 */
  key: string;
  src: string;
  place: PlaceKind;
  /** 章の途中の絵だけ: 章(0始まり)と、その中の並び */
  chapter?: number;
  block?: number;
}

/** 版面の外にはみ出してよい幅(mm)。箱は字より少し大きく出る(試作で外周の誤差 1% 前後)ので、そのぶん見逃す */
export const TEXT_TOLERANCE_MM = 1;

/** CSS の 1px は 1/96 インチ(絵は、縮める必要が無ければこの大きさで置かれる) */
const PX_MM = 25.4 / 96;

/** 何ページ目か(1始まり)から、見開きの左右。縦組みは1ページ目が左、横組みは右(preview/rulesGuide.ts と同じ対応) */
export function pageSideOf(page: number, mode: WritingMode): PageSide {
  const odd = page % 2 === 1;
  return mode === 'vertical' ? (odd ? 'left' : 'right') : odd ? 'right' : 'left';
}

/** 版面(用紙の mm)。ノドは見開きの内側: 左のページは右側、右のページは左側 */
export function typeAreaOnPaper(l: PageLayout, side: PageSide): RectMm {
  const fore = l.margins.fore + l.bleed.fore;
  const gutter = l.margins.gutter + l.bleed.gutter;
  const left = side === 'left' ? fore : gutter;
  const right = side === 'left' ? gutter : fore;
  const top = l.margins.top + l.bleed.top;
  const bottom = l.margins.bottom + l.bleed.bottom;
  return { x: left, y: top, w: l.paperW - left - right, h: l.paperH - top - bottom };
}

/**
 * 絵がページに置かれる四角(用紙の mm。全面は用紙からはみ出すことがある = 切り抜かれる)。
 * css.ts の div.plate.full / div.fullbleed(用紙いっぱい・切り抜いて埋める)と、
 * div.plate.wide / .narrow(仕上がりの外周を空けた箱の中に、切らずに収めて、用紙の真ん中に置く)と同じ計算
 */
export function imageOnPaper(place: Exclude<PlaceKind, 'spread'>, l: PageLayout, natW: number, natH: number): RectMm {
  if (place === 'full') {
    const scale = Math.max(l.paperW / natW, l.paperH / natH);
    const w = natW * scale;
    const h = natH * scale;
    return { x: (l.paperW - w) / 2, y: (l.paperH - h) / 2, w, h };
  }
  const inset = l.trimW * PLATE_INSET[place];
  const maxW = l.trimW - inset * 2;
  const maxH = l.trimH - inset * 2;
  // max-width / max-height なので、小さい絵は引き伸ばさない
  const scale = Math.min(PX_MM, maxW / natW, maxH / natH);
  const w = natW * scale;
  const h = natH * scale;
  return { x: (l.paperW - w) / 2, y: (l.paperH - h) / 2, w, h };
}

export interface TextJudge {
  /** 版面の外に出ている文字の箱(用紙の mm。用紙の中に見えている部分だけ) */
  outside: RectMm[];
  /** 辺ごとの、いちばん大きなはみ出し(mm)。出ていなければ 0 */
  over: { top: number; bottom: number; fore: number; gutter: number };
}

/** 文字の箱を用紙の mm に直し、版面の外に出ているものを集める */
export function judgeText(
  boxes: TextBox[],
  natW: number,
  natH: number,
  place: Exclude<PlaceKind, 'spread'>,
  l: PageLayout,
  side: PageSide,
  tolMm = TEXT_TOLERANCE_MM,
): TextJudge {
  const img = imageOnPaper(place, l, natW, natH);
  const area = typeAreaOnPaper(l, side);
  const kx = img.w / natW;
  const ky = img.h / natH;
  const out: TextJudge = { outside: [], over: { top: 0, bottom: 0, fore: 0, gutter: 0 } };
  for (const b of boxes) {
    // 用紙の中に見えている部分だけ(全面は切り抜かれる)
    const x0 = Math.max(0, img.x + b.x * kx);
    const y0 = Math.max(0, img.y + b.y * ky);
    const x1 = Math.min(l.paperW, img.x + (b.x + b.w) * kx);
    const y1 = Math.min(l.paperH, img.y + (b.y + b.h) * ky);
    if (x1 <= x0 || y1 <= y0) continue;
    const overLeft = area.x - x0;
    const overRight = x1 - (area.x + area.w);
    const overTop = area.y - y0;
    const overBottom = y1 - (area.y + area.h);
    if (Math.max(overLeft, overRight, overTop, overBottom) <= tolMm) continue;
    out.outside.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const overFore = side === 'left' ? overLeft : overRight;
    const overGutter = side === 'left' ? overRight : overLeft;
    if (overTop > tolMm) out.over.top = Math.max(out.over.top, overTop);
    if (overBottom > tolMm) out.over.bottom = Math.max(out.over.bottom, overBottom);
    if (overFore > tolMm) out.over.fore = Math.max(out.over.fore, overFore);
    if (overGutter > tolMm) out.over.gutter = Math.max(out.over.gutter, overGutter);
  }
  return out;
}

/** 見開きの絵(2ページ)の判定。左右のページごとに版面と比べ、折り目のまわりも見る */
export interface SpreadJudge {
  /** 1ページ目(偶数ページ)・2ページ目(奇数ページ)で、版面の外に出ている文字の箱(そのページの用紙の mm。見えている部分だけ) */
  outsideA: RectMm[];
  outsideB: RectMm[];
  /** 辺ごとの、いちばん大きなはみ出し(mm)。出ていなければ 0 */
  over: TextJudge['over'];
  /** 折り目のまわり(中心から左右 SPREAD_FOLD_SAFE_MM)にかかる文字の箱の数(はみ出しの箱も含めて数える) */
  fold: number;
  /**
   * 版面の外に出ている文字の箱の数(許容を超えたもの。ページごとに数えるので、折り目をまたぐ箱は2と数えうる)。
   * 0 で fold > 0 なら「折り目にかかっているだけ」(版面の中。印刷の入稿で止められる話ではない)
   */
  outsideCount: number;
}

/**
 * 見開きの絵の中の文字の箱(絵の画素)を、左右それぞれのページの用紙の mm に直して、版面の外に出ているものを集める。
 * 版面の外 = そのページの版面(ノド・小口はページの左右で入れ替わる)の外。折り目のまわりにかかる箱は、
 * 版面の中にあっても集める(色を付けて見せる)。**箱が折り目をまたぐときは、見えている両方のページに出す**
 * @param binding **いま効いている綴じ方**(bindingOf。KDP は選んでいても無線)。
 *   中綴じのときは、ノド側(折り目の側)のはみ出しを数えない — 折り目のまわり 5mm だけを fold に集める(上のコメント)
 */
export function judgeSpreadText(
  boxes: TextBox[],
  natW: number,
  natH: number,
  l: PageLayout,
  mode: WritingMode,
  binding: Binding,
  tolMm = TEXT_TOLERANCE_MM,
): SpreadJudge {
  const g = spreadGeometry(l, mode);
  const band = foldBand(g);
  // 全面と同じ「中央を切り出して埋める」置き方(css.ts の div.plate.spread img は object-fit: cover)
  const scale = Math.max(g.artW / natW, g.artH / natH);
  const dw = natW * scale;
  const dh = natH * scale;
  const ax = (g.artW - dw) / 2;
  const ay = (g.artH - dh) / 2;
  const out: SpreadJudge = { outsideA: [], outsideB: [], over: { top: 0, bottom: 0, fore: 0, gutter: 0 }, fold: 0, outsideCount: 0 };
  const pages = [
    { half: g.first, list: out.outsideA },
    { half: g.second, list: out.outsideB },
  ];
  for (const b of boxes) {
    const u0 = ax + b.x * scale;
    const u1 = ax + (b.x + b.w) * scale;
    const v0 = ay + b.y * scale;
    const v1 = ay + (b.y + b.h) * scale;
    const inFold = u1 > band.x0 && u0 < band.x1 && v1 > 0 && v0 < g.artH;
    if (inFold) out.fold++;
    for (const { half, list } of pages) {
      // そのページの用紙の中に見えている部分だけ
      const x0 = Math.max(0, u0 - half.offset);
      const x1 = Math.min(l.paperW, u1 - half.offset);
      const y0 = Math.max(0, v0);
      const y1 = Math.min(l.paperH, v1);
      if (x1 <= x0 || y1 <= y0) continue;
      const area = typeAreaOnPaper(l, half.side);
      const overLeft = area.x - x0;
      const overRight = x1 - (area.x + area.w);
      const overTop = area.y - y0;
      const overBottom = y1 - (area.y + area.h);
      const overFore = half.side === 'left' ? overLeft : overRight;
      // 中綴じは、ノド側の余白で「外」と言わない(折り目から 5mm の帯は inFold が受け持つ)
      const overGutter = binding === 'saddle' ? 0 : half.side === 'left' ? overRight : overLeft;
      const outside = Math.max(overFore, overGutter, overTop, overBottom) > tolMm;
      if (!outside && !inFold) continue;
      list.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      if (!outside) continue;
      out.outsideCount++;
      if (overTop > tolMm) out.over.top = Math.max(out.over.top, overTop);
      if (overBottom > tolMm) out.over.bottom = Math.max(out.over.bottom, overBottom);
      if (overFore > tolMm) out.over.fore = Math.max(out.over.fore, overFore);
      if (overGutter > tolMm) out.over.gutter = Math.max(out.over.gutter, overGutter);
    }
  }
  return out;
}

const placeOfPlate = (p: Plate): PlaceKind | null =>
  p.size === 'full' || p.size === 'wide' || p.size === 'narrow' || p.size === 'spread' ? p.size : null;
const placeOfBlock = (b: ImageBlock): PlaceKind | null => (b.full ? 'full' : b.size === 'wide' || b.size === 'narrow' ? b.size : null);

/**
 * 文字の検査にかける絵を集める。**版面の外に出うる大きさの絵だけ**(版面いっぱい・本文の中は、絵ごと版面の中)。
 * 「文字ではない」と利用者が言った絵(textOk)と、白ページ・絵の無い枠は外す
 */
export function textTargets(ms: Manuscript, s: Pick<ProjectSettings, 'plates'>, keyOf: (chapter: number, block: number) => string): TextTarget[] {
  const out: TextTarget[] = [];
  for (const p of s.plates ?? []) {
    const place = placeOfPlate(p);
    if (p.blank || !p.src || p.textOk || !place) continue;
    out.push({ kind: 'plate', key: p.id, src: p.src, place });
  }
  ms.chapters.forEach((ch, ci) => {
    ch.blocks.forEach((b, bi) => {
      if (typeof b !== 'object' || b === null || b.type !== 'image') return;
      const place = placeOfBlock(b);
      if (!b.src || b.textOk || !place) return;
      out.push({ kind: 'img', key: keyOf(ci, bi), src: b.src, place, chapter: ci, block: bi });
    });
  });
  return out;
}

/** 見つかった「版面の外の文字」1件(絵1枚ぶん) */
export interface TextFinding {
  target: TextTarget;
  /** 何ページ目か(1始まり)。組み上がる前で分からなければ null。見開きは1ページ目(偶数ページ) */
  page: number | null;
  /** 判定に使った左右。ページが分からないときは、左右どちらでも外に出る絵だけを言い、箱の少ないほうで言う。見開きは1ページ目の左右 */
  side: PageSide;
  /** 外に出ている箱(そのページの用紙の mm)。見開きは1ページ目のぶん */
  outside: RectMm[];
  over: TextJudge['over'];
  /** 見開きだけ: 2ページ目のぶんの箱 */
  outsideB?: RectMm[];
  /** 見開きだけ: 折り目のまわり(中心から左右 5mm)にかかる文字の数。0 なら言わない */
  fold?: number;
  /**
   * 見開きだけ: 折り目にかかっているだけで、版面の外には出ていない(中綴じは、ノド側の余白を見ないので、ほぼこちら)。
   * 書き出しの「直すところ」では「版面の外」「入稿で止められる」とは言わず、別の1件にする(2026-10-03 レビュー)
   */
  foldOnly?: boolean;
}

/**
 * 絵ごとの判定をまとめる。
 * @param detected 絵(src)→ 見つけた文字。まだ調べていない・調べられなかった絵は入っていない(判定しない)
 * @param pageOf 絵が何ページ目に出たか(組み上がりの報せ)。まだなら undefined
 */
export function findTextOutside(
  targets: TextTarget[],
  detected: ReadonlyMap<string, { w: number; h: number; boxes: TextBox[] } | null>,
  l: PageLayout,
  mode: WritingMode,
  /** いま効いている綴じ方(bindingOf)。見開きのノド側の見方が変わる */
  binding: Binding,
  pageOf: (t: TextTarget) => number | undefined,
): TextFinding[] {
  const out: TextFinding[] = [];
  for (const t of targets) {
    const d = detected.get(t.src);
    if (!d || d.boxes.length === 0 || d.w <= 0 || d.h <= 0) continue;
    const page = pageOf(t) ?? null;
    if (t.place === 'spread') {
      // 見開きは1ページ目がかならず偶数ページなので、ページ番号が分からなくても左右は決まっている
      const j = judgeSpreadText(d.boxes, d.w, d.h, l, mode, binding);
      if (j.outsideA.length || j.outsideB.length) {
        out.push({
          target: t,
          page,
          side: spreadGeometry(l, mode).first.side,
          outside: j.outsideA,
          outsideB: j.outsideB,
          over: j.over,
          fold: j.fold,
          foldOnly: j.outsideCount === 0,
        });
      }
      continue;
    }
    if (page !== null) {
      const side = pageSideOf(page, mode);
      const j = judgeText(d.boxes, d.w, d.h, t.place, l, side);
      if (j.outside.length) out.push({ target: t, page, side, outside: j.outside, over: j.over });
      continue;
    }
    // ページがまだ分からない(いちども組み上がっていない)。**左右どちらのページに出ても外になる絵だけ**言う。
    // 片側でだけ外になる絵(文字が、ノドと小口の余白の差の帯にかかる絵)を「外」と言うと、
    // 組み上がって実際の左右が分かったときに消える = 嘘の知らせになる(2026-10-02 見直しで指摘)
    const L = judgeText(d.boxes, d.w, d.h, t.place, l, 'left');
    const R = judgeText(d.boxes, d.w, d.h, t.place, l, 'right');
    if (L.outside.length && R.outside.length) {
      const j = L.outside.length <= R.outside.length ? L : R;
      out.push({ target: t, page, side: j === L ? 'left' : 'right', outside: j.outside, over: j.over });
    }
  }
  return out;
}

/**
 * はみ出した辺と幅を、言葉にする(「外側（小口）へ 6.2mm・下へ 3.0mm はみ出し」)。大きい順。
 * **天・地・小口・ノドを知らない人にも分かる言い方**にする(上・下・外側・綴じる側。2026-10-02 見直しで指摘:
 * 「小口側に 6.2mm」は「小口から 6.2mm の所」とも読めた)
 */
export function overText(over: TextJudge['over']): string {
  const names: [string, number][] = [
    ['外側（小口）', over.fore],
    ['綴じる側（ノド）', over.gutter],
    ['上', over.top],
    ['下', over.bottom],
  ];
  const parts = names
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([n, v]) => `${n}へ ${v.toFixed(1)}mm`);
  return parts.length ? `${parts.join('・')} はみ出し` : '';
}

/** 左の欄の、その絵の行に出すこと。外に出ている / 確かめている最中 / 確かめられなかった(問題なしの絵は何も出さない) */
export type TextRowState =
  | { state: 'outside'; finding: TextFinding }
  | { state: 'checking' }
  | { state: 'failed'; retry: () => void };

/** 行の鍵(挿絵は plate:id、章の途中の絵は img:imageKey) */
export const textRowKey = (t: Pick<TextTarget, 'kind' | 'key'>) => `${t.kind}:${t.key}`;

const mm = (v: number) => `${Number(v.toFixed(2))}mm`;
/** 重ねる色の箱の上限(1ページ)。表のように箱が何百もある絵で、規則が大きくなりすぎないように */
const MAX_MARKS = 80;

/**
 * 下見の、はみ出した文字の場所に色を重ねる CSS(そのページだけ)。
 * 用紙の全面の箱の ::after に、箱の数だけ背景を重ねる(「印刷所の決まり」の色の帯と同じ口。preview/rulesGuide.ts)。
 * ページが分かっている絵だけ(左右が決まらないと、場所が決まらない)
 */
export function textMarksCss(findings: TextFinding[]): string {
  // 版面の外 = 赤。**折り目にかかっているだけ**(中綴じのノド側はほぼこれ。入稿で止められる話ではない)は、やわらかい色にする
  const gradient = (v: string) => {
    const color = `color-mix(in srgb, var(${v}) 45%, transparent)`;
    return `linear-gradient(${color}, ${color})`;
  };
  const rule = (attr: string, key: string, boxes: RectMm[], soft: boolean) => {
    const c = gradient(soft ? '--warn' : '--bad');
    const layers = boxes
      .slice(0, MAX_MARKS)
      .map((r) => `${c} ${mm(r.x)} ${mm(r.y)} / ${mm(r.w)} ${mm(r.h)} no-repeat`)
      .join(',\n    ');
    return `.preview-body .preview-viewport [data-vivliostyle-page-container]:has([${attr}="${key}"]) > [data-vivliostyle-bleed-box]::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 6;
  background:
    ${layers};
}`;
  };
  return (
    findings
      // 見開きは、ページ番号が分からなくても左右が決まっている(1ページ目は偶数ページ)ので、いつでも描く
      .filter((f) => f.page !== null || f.outsideB !== undefined)
      .flatMap((f) => {
        const attr = f.target.kind === 'plate' ? 'data-plate' : 'data-img';
        const key = f.target.key.replace(/["\\]/g, '\\$&');
        const soft = !!f.foldOnly;
        const rules = f.outside.length ? [rule(attr, key, f.outside, soft)] : [];
        // 見開きの2ページ目の箱は、2ページ目につけた data-plate-b で引く(typeset/html.ts)
        if (f.outsideB?.length) rules.push(rule('data-plate-b', key, f.outsideB, soft));
        return rules;
      })
      .join('\n')
  );
}
