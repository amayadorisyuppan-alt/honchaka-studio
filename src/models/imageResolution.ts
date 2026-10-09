// 絵の細かさ(ppi。実寸で1インチに何画素あるか)を出し、足りなければ知らせる。**止めない。**
//
// 2026-10-03 ユーザー判断「警告を出しましょう。全体の問題」「知らせるだけでいい。ぼけるといっても
// 絵柄によってだいぶ差が出るはずなので、あとはユーザーの決定次第」。
// 基準は出し先の目安(PRINT_TARGETS の imagePpi。KDP と その他 300)。
//
// **実寸は、組版が実際に置く大きさで数える。**
// - 全面(挿絵・章の途中・表紙)は「cover」: 縦横比が違えば中央を切り出して用紙(塗り足し込み)を埋める。
//   拡大して切り出すので、細かさは「画素 ÷ 用紙の寸法」の小さいほう(縦横どちらか足りないほう)で決まる
// - 見開き(2ページ。2026-10-03)も cover。**用紙2枚ぶん**(仕上がり2枚 + 小口の塗り足し2つ。grid.ts の spreadArtMm)で数える。
//   1ページの全面の倍の幅になるので、同じ ppi を出すには画素が倍いる
// - 余白すこし・おおめ・版面いっぱい・本文の中は max-width / max-height だけで置く(css.ts の div.plate・figure.fig)。
//   **拡大はしない**: 箱に入りきらない絵は縮め(細かさは画素 ÷ 箱の寸法)、箱より小さい絵はそのままの大きさ
//   (CSS では 1px = 1/96 インチなので 96ppi。ここでは「ひどく粗い」として知らせる)
//
// 背景(章の地・紙の地)は対象にしない: 敷き方が cover・並べ・透かしと多様で、ぼやけても
// 本文の裏で目立ちにくい。いつか要るなら、ここに「敷き方」を足す。
// 本文の中の絵の箱は、版面(段組みなら1段ぶん)で見る。キャプションや章ごとの段数の違いは見ないので、
// 本文の中の ppi は「約」。

import { PRINT_TARGETS, type Chapter, type Plate, type PlateSize, type PrintTarget } from './project';
import { imageKey, imageSizeOf } from './inlineImages';
import type { CoverSettings } from './cover';
import { plateAreaMm, printAreaMm, type PageLayout } from '../typeset/grid';

const MM_PER_INCH = 25.4;
/** CSS の 1px = 1/96 インチ。箱より小さい絵は、この細かさでそのままの大きさに置かれる */
const CSS_PPI = 96;

export interface PxSize {
  w: number;
  h: number;
}
export interface MmSize {
  w: number;
  h: number;
}

/**
 * 絵の細かさ(ppi)。
 * - 'cover': 中央を切り出して領域を埋める(拡大してもよい)。縦横のうち足りないほうで決まる
 * - 'contain': 領域に収まるまで縮める。拡大はしない。領域より小さい絵は 96ppi(CSS の等倍)
 */
export function effectivePpi(px: PxSize, area: MmSize, fit: 'cover' | 'contain'): number {
  if (!(px.w > 0) || !(px.h > 0) || !(area.w > 0) || !(area.h > 0)) return Infinity;
  const pw = (px.w * MM_PER_INCH) / area.w;
  const ph = (px.h * MM_PER_INCH) / area.h;
  return fit === 'cover' ? Math.min(pw, ph) : Math.max(CSS_PPI, pw, ph);
}

/** 基準のこの割合を割ったら「少し足りない」。割り算の端数(350 に対して 349 など)で言わないための余裕 */
export const PPI_TOLERANCE = 0.98;
/** 基準のこの割合を割ったら「かなり足りない」。言い方を強める */
export const PPI_STRONG = 2 / 3;

export type ResolutionLevel = 'ok' | 'low' | 'veryLow';

export interface ResolutionVerdict {
  /** 実寸での細かさ(四捨五入) */
  ppi: number;
  /** 出し先の目安 */
  base: number;
  level: ResolutionLevel;
}

export function judgePpi(ppi: number, base: number): ResolutionVerdict {
  const r = Number.isFinite(ppi) ? Math.round(ppi) : Infinity;
  const level: ResolutionLevel = r < base * PPI_STRONG ? 'veryLow' : r < base * PPI_TOLERANCE ? 'low' : 'ok';
  return { ppi: r, base, level };
}

/** 出し先の目安(ppi) */
export function basePpiOf(target: PrintTarget): number {
  return PRINT_TARGETS[target]?.imagePpi ?? 300;
}

// ---- 置き場所ごとの実寸 ----

/** 挿絵ページ(章の切れ目)・章の途中のページいっぱいの絵の細かさ。size は PlateSize か 'flow'(本文の中)。'spread' は見開き(用紙2枚ぶん) */
export function placedPpi(px: PxSize, l: PageLayout, size: PlateSize | 'flow'): number {
  if (size === 'flow') return effectivePpi(px, printAreaMm(l), 'contain');
  return effectivePpi(px, plateAreaMm(l, size), size === 'full' || size === 'spread' ? 'cover' : 'contain');
}

/** 表紙の絵が占める実寸(mm)。塗り足し込み。面ごとの絵は、その面が占める幅 × 全体の高さ。cover で埋める */
export interface CoverLike {
  totalW: number;
  totalH: number;
  back: { x0: number; x1: number };
  front: { x0: number; x1: number };
}
export type CoverPart = 'front' | 'back' | 'wrap';

export function coverPartAreaMm(l: CoverLike, part: CoverPart): MmSize {
  if (part === 'wrap') return { w: l.totalW, h: l.totalH };
  const f = part === 'front' ? l.front : l.back;
  return { w: f.x1 - f.x0, h: l.totalH };
}

export function coverPpi(px: PxSize, l: CoverLike, part: CoverPart): number {
  return effectivePpi(px, coverPartAreaMm(l, part), 'cover');
}

/**
 * 長い辺が maxSide を超える大きさは、縦横比を保って縮めて言う。
 * 取り込みは長い辺を上限(images/optimize.ts)までに縮めるので、それを超える「推奨サイズ」は
 * 言っても届かない(言うと、利用者が用意しても縮められる)
 */
export function fitWithin(px: PxSize, maxSide: number): PxSize {
  const long = Math.max(px.w, px.h);
  if (long <= maxSide) return px;
  const k = maxSide / long;
  return { w: Math.round(px.w * k), h: Math.round(px.h * k) };
}

// ---- 本1冊ぶんを集める ----

export interface ResolutionEntry {
  /** 行の鍵。'plate:挿絵の id' / 'img:章:並び'(imageKey)/ 'cover:front|back|wrap' */
  key: string;
  /** 「入稿前チェック」で数えるときの分け方 */
  group: 'plate' | 'img' | 'cover';
  verdict: ResolutionVerdict;
}

export interface CollectInput {
  plates: readonly Plate[];
  chapters: readonly Chapter[];
  layout: PageLayout;
  /** 紙の表紙。紙の本を作らないときは渡さない */
  cover?: { settings: Pick<CoverSettings, 'background' | 'backCover' | 'wrap'>; layout: CoverLike } | null;
  /** 絵(src)→ 画素数。測れていない・測れなかった絵は入っていない(言わない) */
  sizes: ReadonlyMap<string, PxSize | null>;
  base: number;
}

/**
 * 細かさが足りない絵を集める(足りている絵は入れない)。**紙の本の話**: 電子書籍の絵は 1600px に
 * 軽くして入れるので、ここでは見ない(呼ぶ側が、紙を作らない本には呼ばない)。
 * 白ページ・絵の無い枠・SVG・まだ測れていない絵は飛ばす
 */
export function collectResolution(input: CollectInput): ResolutionEntry[] {
  const { plates, chapters, layout, cover, sizes, base } = input;
  const out: ResolutionEntry[] = [];
  const add = (key: string, group: ResolutionEntry['group'], ppi: number) => {
    const verdict = judgePpi(ppi, base);
    if (verdict.level !== 'ok') out.push({ key, group, verdict });
  };
  for (const p of plates) {
    const px = !p.blank && p.src ? sizes.get(p.src) : null;
    if (px) add(`plate:${p.id}`, 'plate', placedPpi(px, layout, p.size));
  }
  chapters.forEach((ch, ci) => {
    ch.blocks.forEach((b, bi) => {
      if (typeof b !== 'object' || b === null || b.type !== 'image' || !b.src) return;
      const px = sizes.get(b.src);
      if (px) add(`img:${imageKey(ci, bi)}`, 'img', placedPpi(px, layout, imageSizeOf(b)));
    });
  });
  if (cover) {
    const srcOf = (v: { kind: string; src?: string } | undefined) => (v?.kind === 'image' ? v.src : undefined);
    // まるごと1枚があるときは、面ごとの地は描かない(models/cover.ts の CoverWrap)
    const wrapSrc = srcOf(cover.settings.wrap);
    const parts: [CoverPart, string | undefined][] = wrapSrc
      ? [['wrap', wrapSrc]]
      : [
          ['front', srcOf(cover.settings.background)],
          ['back', srcOf(cover.settings.backCover)],
        ];
    for (const [part, src] of parts) {
      const px = src ? sizes.get(src) : null;
      if (px) add(`cover:${part}`, 'cover', coverPpi(px, cover.layout, part));
    }
  }
  return out;
}

// ---- 画面に出す文 ----

/** 表紙の面の呼び名 */
export const COVER_PART_LABEL: Record<CoverPart, string> = {
  front: '表1（表紙のおもて）の画像',
  back: '表4（裏表紙）の画像',
  wrap: '表紙まるごと1枚の画像',
};

/**
 * 絵の行に出す1行。足りているとき(level = ok)は null。
 * **知らせるだけ**: 決めるのは利用者(絵柄によって、ぼけ方はだいぶ違う)。
 * 数字の意味は短く添える(「実寸で1インチに何画素あるか」)。
 */
export function resolutionNote(v: ResolutionVerdict, targetLabel: string): string | null {
  if (v.level === 'ok') return null;
  const head = `この大きさだと、細かさは約 ${v.ppi}ppi（実寸1インチあたりの画素数）です。${targetLabel}のおすすめは ${v.base}ppi 以上。`;
  return v.level === 'veryLow'
    ? `${head}刷ると、かなりぼやけることがあります（絵柄によります）。サイズを小さくするか、細かい画像に替えるときれいに刷れます`
    : `${head}刷ると少しぼやけることがあります（絵柄によります）。このまま使うかは、お決めください`;
}

/** 入稿前チェックの1行 */
export function resolutionIssueText(n: number, worst: ResolutionVerdict, targetLabel: string, where: string): string {
  return (
    `${where}のうち ${n} 枚は、実寸の細かさが${targetLabel}のおすすめ（${worst.base}ppi 以上）に届きません` +
    `（いちばん低いもので約 ${worst.ppi}ppi）。刷ると少しぼやけることがあります（絵柄によります）。止めはしません。決めるのはあなたです`
  );
}

// ---- 手持ちの絵の細かさを、チャットの AI に確かめてもらう頼み方(2026-10-09 ユーザー要望) ----
//
// スタジオは入れた絵をその場で測るが、**入れる前**(どの絵を使うか選ぶとき)には測れない。
// 頼み方には、この本で要る画素数を使い方ごとに入れておき、AI にはファイルの実際の画素数を
// 読んで比べることだけを頼む(計算の前提を AI に任せない)。
// **見た目から推し量らせない**: チャットに上げた画像は、AI が見るときに縮められていることがある

export interface ImageCheckInput {
  /** 出し先の名前(「Amazon KDP」など) */
  targetLabel: string;
  /** 出し先のおすすめの細かさ(ppi) */
  ppi: number;
  /** 判型の名前(「文庫（A6）105×148mm」など) */
  trimLabel: string;
  /** 使い方ごとの要る画素数。上から順に並べる */
  sizes: readonly { label: string; px: PxSize }[];
}

export function imageCheckPrompt(i: ImageCheckInput): string {
  const n = (v: number) => v.toLocaleString('ja-JP');
  return [
    'これから渡す画像を、紙の本に使えるか確かめてください。',
    '',
    '## 本の条件',
    `- 出し先: ${i.targetLabel}（おすすめの細かさは ${i.ppi}ppi 以上）`,
    `- 判型: ${i.trimLabel}`,
    `- 使い方ごとに要る画素数（${i.ppi}ppi のとき。横×縦）:`,
    ...i.sizes.map((s) => `  - ${s.label}: ${n(s.px.w)}×${n(s.px.h)}px`),
    '',
    '## 確かめ方',
    '1. 画像ごとに、ファイルを開いて実際の横と縦の画素数を読み取ってください。見た目で推測せず、読み取れないときは「読めません」と答えてください。',
    '2. 上の画素数と比べて、どの使い方なら足りるかを答えてください。全面・見開き・表紙は、縦横比が違うと端を切り落として埋めるため、横と縦のうち足りないほうで決まります。本文の中は、縦横比を保ったまま枠に収まるまで縮めて置くため、枠にぴったり合う辺で決まります。',
    `3. 足りないときは、その使い方でのおおよその細かさ（約◯ppi。${i.ppi} × 画像の画素数 ÷ 要る画素数）も書いてください。`,
    '',
    '## 答え方',
    '画像ごとに1行で: ファイル名 / 横×縦の画素数 / 足りる使い方 / 足りない使い方（約◯ppi）',
  ].join('\n');
}

// ---- 絵の画素数を、データ URI の頭から読む(同期。描かずに済む) ----

/** base64 の先頭だけ読む量(JPEG は EXIF などのあとに寸法が来る。大きいサムネ付きの写真でも届く量) */
const HEAD_B64_CHARS = 1 << 18; // 262144 文字 ≒ 196KB

function headBytes(dataUri: string): Uint8Array | null {
  const i = dataUri.indexOf(',');
  if (i < 0 || !/;base64/i.test(dataUri.slice(0, i))) return null;
  const n = Math.min(dataUri.length - i - 1, HEAD_B64_CHARS);
  const b64 = dataUri.slice(i + 1, i + 1 + (n - (n % 4)));
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  } catch {
    return null;
  }
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * PNG・JPEG・GIF・BMP・WebP の画素数。読めなければ null(呼ぶ側が、描いて測る道へ回す)。
 * SVG は大きさを持たない線の絵なので null のまま(知らせの対象外)
 */
export function pxSizeOfDataUri(dataUri: string): PxSize | null {
  const b = headBytes(dataUri);
  if (!b || b.length < 24) return null;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: u32be(b, 16), h: u32be(b, 20) };
  }
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: u16le(b, 6), h: u16le(b, 8) };
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    const h = u32le(b, 22);
    return { w: u32le(b, 18), h: h > 0x7fffffff ? 0x100000000 - h : h };
  }
  // JPEG: マーカーをたどって SOFn(C0〜CF のうち C4・C8・CC を除く)を探す
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1];
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = u16be(b, o + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: u16be(b, o + 7), h: u16be(b, o + 5) };
      }
      o += 2 + len;
    }
    return null;
  }
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === 'VP8L' && b[20] === 0x2f) {
      const bits = u32le(b, 21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    }
  }
  return null;
}
