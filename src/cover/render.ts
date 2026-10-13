// 表紙を Canvas に描く。紙(表4+背+表1の1枚)と電子(表1のみ)の両方をここで作る。
// 組版エンジン(Vivliostyle)は使わない。表紙は本文とちがってページ分割がなく、
// ピクセル単位で位置を決めたいため。

import {
  COVER_FONTS,
  COVER_SAFE_MM,
  coverFrontTextOn,
  EBOOK_COVER_PX,
  fitSpine,
  mmToPx,
  pxToPt,
  spineRunPx,
  spineTextBox,
  SPINE_GAP,
  SPINE_LEADING,
  SPINE_MIN_PX,
  type CoverAnchor,
  type CoverLayout,
  type CoverSettings,
} from '../models/cover';
import { loadCoverFonts } from './fontLoad';

/**
 * Canvas は「読み込み済みのフォント」しか使えない。未読込のまま fillText すると
 * 黙って別の書体で描かれるので、描く前に必ずこれを待つ
 *
 * **表紙に描く字を全部渡して読む。**(2026-10-11 1.0.3。修正リストの 17)
 * 字を渡さないと、書体の読み込みは空白1字ぶん(ラテンのサブセット)で終わり、書名の漢字は
 * 読まれないまま描かれる。前は下見の組版(Vivliostyle)がアプリの全部の書体を読ませていたので、
 * たまたま間に合っていた(src/preview/fontWaitGuard.ts で止めた)。
 * 断られて読めなかった面は作り直して読み直す(./fontLoad.ts)
 */
export async function ensureCoverFonts(settings: CoverSettings, text: CoverText): Promise<void> {
  const chars = [
    text.title,
    text.author,
    text.publisher,
    settings.spineTitle,
    settings.blurb,
    // 数字・記号(版元や著者名の表記ゆれ、背の詰め数字)。あっても数面しか増えない
    '0123456789０１２３４５６７８９・ー―…',
  ].join('');
  // 同じ字は1つでよい(あらすじが長くても、渡すのは字の種類だけ)
  const uniq = [...new Set(chars)].join('');
  // 表1に書名・著者名を入れないとき(2026-10-13)は、その2つの書体は使わないので読まない
  // (読めなかったときに、使っていない書体のことで知らせを出さないため)。書名・著者名の字は背で使うので、字の並びはそのまま
  const ids = coverFrontTextOn(settings)
    ? [settings.titleFont, settings.authorFont, settings.blurbFont, settings.spineFont]
    : [settings.blurbFont, settings.spineFont];
  const specs = new Set<string>([`400 100px ${GOTHIC}`]);
  for (const id of ids) {
    const f = COVER_FONTS[id] ?? COVER_FONTS.serif;
    specs.add(`${f.bold} 100px ${f.stack}`);
    specs.add(`400 100px ${f.stack}`);
  }
  // 読めなかった書体は画面で知らせる(2026-10-13 修正リスト 29。./fontLoad.ts の loadCoverFonts)
  await loadCoverFonts([...specs], uniq);
}

export interface CoverText {
  title: string;
  author: string;
  publisher: string;
  /** 本文の組み方向。縦組みの本は書名も縦書きにする */
  vertical: boolean;
}

const GOTHIC = '"Noto Sans JP", "Yu Gothic", sans-serif';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = src;
  });
}

/** 短辺を合わせて中央でトリミングして描く(CSS の object-fit: cover と同じ) */
function drawCoverFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/**
 * 画像の一部を切り出して、指定の枠へ cover-fit で置く。
 *
 * まるごと1枚の表紙を電子書籍にも出すときに要る。電子の表紙は表1だけなので、
 * **全体を縮めるのではなく、表1にあたる部分を切り出す**必要がある
 * (縮めると背や表4まで写り込んで、紙と別の絵になってしまう)
 */
function drawCoverFitSlice(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sx: number, sy: number, sw: number, sh: number,
  dx: number, dy: number, dw: number, dh: number,
): void {
  const scale = Math.max(dw / sw, dh / sh);
  // 切り出し側で、はみ出すぶんを中央から削る
  const useW = Math.min(sw, dw / scale);
  const useH = Math.min(sh, dh / scale);
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.drawImage(img, sx + (sw - useW) / 2, sy + (sh - useH) / 2, useW, useH, dx, dy, dw, dh);
  ctx.restore();
}

/** 指定範囲の平均輝度(0〜1)。帯を白にするか黒にするかの判定に使う */
function averageLuminance(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  // 書き出しの倍率(RenderInput.outputScale)が掛かっていると、画素は座標の k 倍ある。getImageData は画素の座標で読む
  const k = ctx.getTransform().a || 1;
  const sx = Math.max(0, Math.floor(x * k));
  const sy = Math.max(0, Math.floor(y * k));
  const sw = Math.max(1, Math.floor(w * k));
  const sh = Math.max(1, Math.floor(h * k));
  const { data } = ctx.getImageData(sx, sy, sw, sh);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return sum / (data.length / 4) / 255;
}

/** #rrggbb の明るさ(0〜1) */
function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

// Canvas には縦書きの概念がなく、フォントの縦組み用グリフ(vert)も使われない。
// 横組みのグリフをそのまま積むと、句読点は左下、長音や括弧は寝たままになるので、
// 縦組みで見え方が変わる文字だけ位置と向きを補正する。
/** 句読点。横組みでは左下にあるので、縦組みの右上へ寄せる */
const PUNCT_UPPER_RIGHT = /[、。，．]/;
/** 縦組みでは90度回す文字(長音・ダッシュ・各種括弧・リーダー) */
const ROTATE_IN_VERTICAL = /[ー―‐−〜～…‥（）()「」『』【】〔〕［］[\]｛｝{}〈〉《》]/;

/**
 * 文字のフチ。帯を敷かずに絵の上で文字を読ませたいときに使う。
 *
 * Canvas の `strokeText` は輪郭の**中心**に線を引くので、線の内側半分が字面を削る。
 * 先に太く縁取ってから上に塗りつぶすと、削られた内側が塗りで埋め戻され、
 * 外側の半分だけがフチとして残る(= 見えるフチの太さは lineWidth の半分)。
 * 本文側の text-shadow 方式と違い、Canvas は影を8方向に重ねるより stroke のほうが速く綺麗。
 */
interface Stroke {
  color: string;
  /** lineWidth(px)。見えるフチはこの半分 */
  width: number;
}
/** フチの太さ。文字サイズに対する lineWidth の比 */
const STROKE_RATIO = 0.16;

/**
 * 書名・著者名の下に敷く帯を塗る。
 *
 * **soft ならふちをぼかして絵に溶かす**(2026-09-27 ユーザー要望「帯をぼやっとさせたい。真四角より情緒がある」)。
 * キャンバスの blur を掛けて塗ると、ふちから外へ向かって濃さが自然に抜ける。ぼかすと端が薄くなるので、
 * ぼかしのぶん外へ広げて塗り、文字の下の濃さは四角い帯とほぼ同じに保つ。
 * 半径は帯の短い辺の 22%、広げるのは半径の 0.3 倍。**文字のまわりにまとわりつく大きさ**にとどめる
 * (2026-09-27 ユーザー「40% は悪目立ちする。最初に渡した見本くらいに」。18%・22%・26%・40% を並べて見比べた)
 * ctx.filter の無いブラウザでは四角い帯に戻す(このアプリは Chromium 前提だが、描けないよりはよい)
 */
/**
 * 塗る帯を、文字を置く枠(帯の枠)からどれだけ内側へ詰めるか(px)。
 *
 * 枠は文字のまわりに字の大きさの半分ほどのゆとりを持つ(縦組みは左右 0.45字・上下 0.5字、
 * 横組みは左右 1字・上下 0.5字)。**置き場所と文字の位置はこの枠で決めたまま、塗る帯だけを詰める**
 * (2026-09-27 ユーザー「帯が文字の幅・高さに比べて大きい。もう少し文字サイズに近く」)。
 * 詰めたあとのゆとりは、縦組みで左右 0.25字・上下 0.3字、横組みで左右 0.5字・上下 0.3字
 */
function bandInset(size: number, vertical: boolean): { x: number; y: number } {
  return { x: size * (vertical ? 0.2 : 0.5), y: size * 0.2 };
}

function fillBand(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  alpha: number,
  soft: boolean,
): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.globalAlpha = alpha;
  if (soft && 'filter' in ctx) {
    const r = Math.max(1, Math.min(w, h) * 0.22);
    // **小さく描いてぼかし、引き伸ばして重ねる。**(2026-09-27)
    // 大きなキャンバスへそのまま blur を掛けると1回 0.35 秒かかり、色の丸を動かすとぎくしゃくした。
    // ぼかした絵は細部を持たないので、1/4 の大きさで作って引き伸ばしても見た目は変わらない
    const scale = 0.25;
    const spread = r * 3; // blur が外へにじむ幅(標準偏差の3倍でほぼ0になる)
    const ow = Math.max(1, Math.ceil((w + spread * 2) * scale));
    const oh = Math.max(1, Math.ceil((h + spread * 2) * scale));
    const off = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (off) off.width = ow;
    if (off) off.height = oh;
    const o = off?.getContext('2d');
    if (o && 'filter' in o) {
      o.fillStyle = fill;
      o.filter = `blur(${(r * scale).toFixed(2)}px)`;
      o.fillRect((spread - r * 0.3) * scale, (spread - r * 0.3) * scale, (w + r * 0.6) * scale, (h + r * 0.6) * scale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off as HTMLCanvasElement, x - spread, y - spread, w + spread * 2, h + spread * 2);
    } else {
      ctx.filter = `blur(${r.toFixed(1)}px)`;
      ctx.fillRect(x - r * 0.3, y - r * 0.3, w + r * 0.6, h + r * 0.6);
    }
  } else {
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

function paintText(
  ctx: CanvasRenderingContext2D,
  ch: string,
  x: number,
  y: number,
  stroke?: Stroke,
): void {
  if (stroke && stroke.width > 0) {
    ctx.save();
    // 角を丸めないと、鋭角の字画でフチが棘のように飛び出す
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.strokeText(ch, x, y);
    ctx.restore();
  }
  ctx.fillText(ch, x, y);
}

/** 縦書き: 1文字ずつ縦に積む。cx は文字の中心 */
function drawVertical(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  top: number,
  size: number,
  leading = 1.06,
  stroke?: Stroke,
): void {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const w = ctx.measureText(ch).width;
    const y = top + size + i * size * leading;

    if (PUNCT_UPPER_RIGHT.test(ch)) {
      paintText(ctx, ch, cx + size * 0.28, y - size * 0.5, stroke);
      continue;
    }
    if (ROTATE_IN_VERTICAL.test(ch)) {
      ctx.save();
      // 文字の中心を原点にして90度回す
      ctx.translate(cx, y - size * 0.35);
      ctx.rotate(Math.PI / 2);
      paintText(ctx, ch, -w / 2, size * 0.35, stroke);
      ctx.restore();
      continue;
    }
    paintText(ctx, ch, cx - w / 2, y, stroke);
  }
}

/** 行頭に置けない文字(句読点・閉じ括弧・小書き仮名・長音)。折り返しでは前の行にぶら下げる */
const NO_LINE_START =
  /[、。，．）」』】〕］｝〉》ー…‥ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ！？!?：；]/;

/** maxW に収まるよう折り返す。行頭禁則の文字は前の行にぶら下げる */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of para) {
      if (line && !NO_LINE_START.test(ch) && ctx.measureText(line + ch).width > maxW) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** 折り返した塊の高さ(1行目の天から最終行のベースライン下まで) */
function blockHeight(size: number, lineCount: number, leading: number): number {
  return size * 1.2 + (lineCount - 1) * size * leading;
}

/**
 * 折り返した塊が maxW × maxH に収まるまで文字を縮める。
 * 表紙は「入りきらないぶんが切れる」のが最悪なので、はみ出す前に必ず小さくする。
 */
function fitWrapped(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: (size: number) => string,
  maxW: number,
  maxH: number,
  startSize: number,
  minSize: number,
  leading: number,
  /** これ以上に行を増やしたくないとき(手で改行位置を指定された書名など) */
  maxLines = Infinity,
): { size: number; lines: string[]; height: number; width: number } {
  let size = startSize;
  for (;;) {
    ctx.font = font(size);
    const lines = wrapLines(ctx, text, maxW);
    const height = blockHeight(size, lines.length, leading);
    // 行頭禁則のぶら下げで maxW を1文字ぶん超えることがあるので、幅も測って判定する
    const width = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
    const fits = height <= maxH && width <= maxW && lines.length <= maxLines;
    if (fits || size <= minSize) return { size, lines, height, width };
    size = Math.max(minSize, size * 0.94);
  }
}

/** 手で入れた改行の数(0か1なら指定なしとみなす) */
function manualLineCount(text: string): number {
  const n = text.split('\n').filter((s) => s.trim().length > 0).length;
  return n > 1 ? n : Infinity;
}

/** 縦書きを列に割る。列頭が禁則文字になるなら前の列へ送る */
function splitColumns(text: string, perCol: number): string[] {
  const cols: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + perCol);
    while (end < text.length && NO_LINE_START.test(text[end])) end++;
    cols.push(text.slice(i, end));
    i = end;
  }
  return cols;
}

/** 縦書きの列送り(1列ぶんの幅は size * COL_GAP) */
const COL_GAP = 1.55;

/**
 * 縦書きが maxW × maxH に収まるまで文字を縮めつつ列に割る。
 * text に改行が入っていればそこで必ず列を変える(利用者が意味の切れ目で指定したもの)。
 * autoCols は自動折り返しで増やしてよい列数の上限。
 */
function fitVertical(
  text: string,
  maxW: number,
  maxH: number,
  autoCols: number,
  startSize: number,
  minSize: number,
  leading = 1.06,
): { size: number; cols: string[] } {
  const manual = text.split('\n').filter((s) => s.length > 0);
  // 手で指定した改行は必ず守るので、列数の上限はそれ以上にする
  const maxCols = Math.max(autoCols, manual.length);

  const layout = (size: number) => {
    // n 文字ぶんの高さ = size + (n-1) * size * leading
    const perCol = Math.max(1, Math.floor((maxH - size) / (size * leading)) + 1);
    const cols = manual.flatMap((seg) => splitColumns(seg, perCol));
    const width = size * 1.9 + (cols.length - 1) * size * COL_GAP;
    return { cols, width };
  };

  // まず指定どおりの列数(改行なしなら1列)で通せる大きさを探す。
  // 書名は、無理に大きくして勝手に列を割るより、少し小さくして一列で通すほうが締まる
  const oneColMin = Math.max(minSize, startSize * 0.5);
  for (let size = startSize; ; size = Math.max(oneColMin, size * 0.94)) {
    const { cols, width } = layout(size);
    if (cols.length <= manual.length && width <= maxW) {
      return { size, cols: cols.length ? cols : [''] };
    }
    if (size <= oneColMin) break;
  }

  // 一列に通すと読めない大きさになる長い書名だけ、列を割ることを許す
  let size = startSize;
  for (;;) {
    const { cols, width } = layout(size);
    if ((cols.length <= maxCols && width <= maxW) || size <= minSize) {
      return { size, cols: cols.length ? cols : [''] };
    }
    size = Math.max(minSize, size * 0.94);
  }
}

/**
 * 表1の書名・著者名の色を、どう決めたか。**画面で断るために返す。**
 *
 * > 表１の文字の色が地の色と同じになっているけど、これは地が濃いから自動で
 * > 白抜きにしているよね？ 注釈入れたほうがいいのでは(2026-08-20 ユーザー)
 *
 * そのとおりの作りで、しかも**選んだ色は上書きされる**(実測は models/cover.ts ではなく
 * paintFront のコメントに残した)。色の欄だけを見ても分からないので、
 * どちらで出ているのかを描画側から返して帯に出す。
 *
 * - `picked` … 選んだ色をそのまま刷った
 * - `auto-white-on-ground` … 地が濃いので白へ振った(選んだ色は使っていない)
 * - `auto-white-on-band` … 帯が濃いので白へ振った(同上)
 * - `outline` … 文字にフチを付けているので、自動は止めてある(選んだ色のまま)
 */
export type FrontInk = 'picked' | 'auto-white-on-ground' | 'auto-white-on-band' | 'outline';

/**
 * **背に実際に刷った大きさ。** 画面の数字はここから取る。
 *
 * 背文字の縛りは2つあり(背幅と天地)、字数の多い本では**描画側が縮める**。
 * 画面が spineTextBox の答えだけを出していたころは、そこで嘘をついていた
 * (2026-08-22)。描いた本人が使った値を返して、画面と刷り上がりを一致させる
 */
export interface SpinePrint {
  titlePt: number;
  authorPt: number;
  publisherPt: number;
  /** 天地(字数)に入らず、指定の倍率より縮めて刷った */
  shrunk: boolean;
  /** 3つの割合を保ったまま、あと何倍にできるか。1.00 ならもうぎりぎり */
  headroom: number;
  /** はみ出さない上限まで大きくしたときの書名(pt) */
  limitPt: number;
  /** その上限を決めたのは、背幅(width)か、字数(height)か */
  limitedBy: 'width' | 'height';
}

/** 描いた結果、利用者に知らせたいこと */
export interface RenderReport {
  /** あらすじが入りきらず組めなかった文字数(0なら全部入っている) */
  blurbOverflow: number;
  /** 背に入りきらず刷らなかった文字数(0なら全部入っている) */
  spineOverflow: number;
  /** 背に刷った大きさ。刷っていないときは null */
  spine: SpinePrint | null;
  /** 表1の書名・著者名の色を、どう決めたか */
  frontInk: FrontInk;
}

/** 背に刷った結果。切った字数と、実際に使った大きさ */
interface SpinePainted {
  /** 入りきらず刷らなかった文字数 */
  dropped: number;
  /** 実際に使った大きさ。画面はこれを読む */
  print: SpinePrint | null;
}

/**
 * 背に文字を刷る。**戻り値は、切った字数と実際に使った大きさ。**
 *
 * **Canvas には縦書きが無い。** 縦積みは drawVertical(1字ずつ積んで、句読点と長音・
 * 括弧だけ位置と向きを直す)に任せる。倒すときは canvas ごと90度回して1行で流す。
 *
 * 置き方は和書の定番: 書名を天から、著者名をそのすぐ下、版元名は地に寄せる。
 *
 * **大きさは models/cover.ts の fitSpine に決めさせる。** 背幅(横)と天地(縦)の
 * 2つの縛りをまとめて解いた答えなので、画面に出す pt と1ミリもずれない。
 * 横倒しは字幅が書体で変わるので、実測(measureText)を渡して同じ関数に解かせる。
 *
 * **入りきらないぶんは必ず捨てる。** 背からあふれた文字は消えるのではなく、
 * 表1・表4の側へ回り込んで刷られる。縮めても入らないなら、切って画面で知らせるほうがよい。
 */
function paintSpine(
  ctx: CanvasRenderingContext2D,
  settings: CoverSettings,
  text: CoverText,
  layout: CoverLayout,
  H: number,
): SpinePainted {
  // 背は1本の線なので、書名の改行(表1のための列分け)はここでは使わない
  const title = (settings.spineTitle.trim() || text.title).replace(/\n/g, '');
  const author = settings.spineAuthorOn ? text.author.trim().replace(/\n/g, '') : '';
  const publisher = settings.spinePublisherOn ? text.publisher.trim().replace(/\n/g, '') : '';
  if (!title && !author && !publisher) return { dropped: 0, print: null };

  // 置ける幅は models/cover.ts が決める(アキは出し先で変わる)
  const box = spineTextBox(layout.spine, settings.spineScale, settings.spineSideways, layout.spineInset);
  const wPx = mmToPx(box.width);
  const cx = mmToPx(layout.spineArea.x0) + mmToPx(layout.spine) / 2;
  // 天地は塗り足し + 安全領域を空ける。背の端すれすれの文字は断裁で落ちる
  const pad = mmToPx(layout.bleed + COVER_SAFE_MM);
  const availH = H - pad * 2;
  if (wPx < SPINE_MIN_PX || availH <= 0) {
    return { dropped: title.length + author.length + publisher.length, print: null };
  }

  const f = COVER_FONTS[settings.spineFont] ?? COVER_FONTS.serif;
  const font = (size: number) => `${f.bold} ${size}px ${f.stack}`;
  ctx.save();
  ctx.fillStyle = settings.spineTextColor;
  ctx.textBaseline = 'alphabetic';
  let dropped = 0;

  // **3つの大きさをここで解く。** 縦積みは字数だけで決まるが、
  // 横倒しは字幅が書体で変わるので、実測を渡して同じ関数に解かせる
  const fit = fitSpine({
    widthPx: wPx,
    availPx: availH,
    sideways: settings.spineSideways,
    runs: { title, author, publisher },
    scales: {
      title: settings.spineScale,
      author: settings.spineAuthorScale,
      publisher: settings.spinePublisherScale,
    },
    measure: (s, sz) => {
      ctx.font = font(sz);
      return ctx.measureText(s).width;
    },
  });
  const size = fit.sizes.title;
  const authorSize = fit.sizes.author;
  const pubSize = fit.sizes.publisher;
  const print: SpinePrint = {
    titlePt: pxToPt(size),
    authorPt: pxToPt(authorSize),
    publisherPt: pxToPt(pubSize),
    shrunk: fit.shrunk,
    headroom: fit.headroom,
    limitPt: pxToPt(fit.limitTitlePx),
    limitedBy: fit.limitedBy,
  };

  if (settings.spineSideways) {
    // --- 横に倒す。書名 → 著者名の順に並べ、版元名だけ地へ回す ---
    //
    // **書名と著者名を1本の文字列に繋いでいたのをやめた**(2026-08-21)。
    // 繋ぐと同じ大きさでしか描けず、「タイトルと著者名が同じ大きさ」になっていた。
    // 別々に測って別々に置く
    const widthAt = (s: string, sz: number) => {
      if (!s) return 0;
      ctx.font = font(sz);
      return ctx.measureText(s).width;
    };
    ctx.textBaseline = 'middle';

    /** 入りきらないぶんは尻から落とす。落とした字数を数える */
    const fitText = (s: string, sz: number, max: number) => {
      ctx.font = font(sz);
      if (!s || ctx.measureText(s).width <= max) return s;
      let out = s;
      while (out.length > 0 && ctx.measureText(out).width > max) out = out.slice(0, -1);
      dropped += s.length - out.length;
      return out;
    };
    /** 倒して描く。天から `at` の位置に置く */
    const layDown = (s: string, sz: number, at: number) => {
      if (!s) return;
      ctx.font = font(sz);
      ctx.save();
      ctx.translate(cx, at);
      ctx.rotate(Math.PI / 2);
      paintText(ctx, s, 0, 0);
      ctx.restore();
    };

    const pubW = widthAt(publisher, pubSize);
    const headRoom = availH - (pubW ? pubW + size * SPINE_GAP : 0);
    const t2 = fitText(title, size, headRoom);
    const titleW = widthAt(t2, size);
    const a2 = author ? fitText(author, authorSize, headRoom - titleW - size * SPINE_GAP) : '';

    layDown(t2, size, pad);
    if (a2) layDown(a2, authorSize, pad + titleW + size * SPINE_GAP);
    if (publisher) {
      const p = fitText(publisher, pubSize, availH);
      if (p) layDown(p, pubSize, H - pad - widthAt(p, pubSize));
    }
    ctx.restore();
    return { dropped, print };
  }

  // --- 1字ずつ縦に積む(既定) ---
  //
  // 和書の背は 書名 > 著者名 > 版元名 の順に小さくなるのが定番。
  // **その割合は利用者が3つ別々に決められる**(2026-08-22)。既定は SPINE_SUB_RATIO。
  // 大きさそのものは上の fitSpine が解いてある(下限 7pt もそこで掛かる)。
  //
  // 縮めても入らないぶんは切る。地の版元名を先に確保し、残りを書名 → 著者名の順に配る。
  // **入る字数はそれぞれの大きさで数える** — 小さい字のほうが多く入る
  const capacityOf = (h: number, sz: number) =>
    h < sz ? 0 : Math.floor((h - sz) / (sz * SPINE_LEADING)) + 1;
  const pubChars = publisher ? Math.min(publisher.length, capacityOf(availH, pubSize)) : 0;
  const pubH = spineRunPx(pubChars, pubSize);
  const headRoom = availH - (pubH ? pubH + size * SPINE_GAP : 0);

  const titleChars = Math.min(title.length, capacityOf(headRoom, size));
  const afterTitle = headRoom - spineRunPx(titleChars, size) - size * SPINE_GAP;
  const authorChars = author ? Math.min(author.length, capacityOf(afterTitle, authorSize)) : 0;
  dropped =
    title.length - titleChars + (author.length - authorChars) + (publisher.length - pubChars);

  if (titleChars > 0) {
    ctx.font = font(size);
    drawVertical(ctx, title.slice(0, titleChars), cx, pad, size, SPINE_LEADING);
  }
  if (authorChars > 0) {
    ctx.font = font(authorSize);
    const top = pad + spineRunPx(titleChars, size) + size * SPINE_GAP;
    drawVertical(ctx, author.slice(0, authorChars), cx, top, authorSize, SPINE_LEADING);
  }
  if (pubChars > 0) {
    ctx.font = font(pubSize);
    // 地から積み上げる。drawVertical は1文字目のベースラインが top + size なので、
    // 最終文字が下端に来るよう逆算する
    const top = H - pad - spineRunPx(pubChars, pubSize);
    drawVertical(ctx, publisher.slice(0, pubChars), cx, top, pubSize, SPINE_LEADING);
  }
  ctx.restore();
  return { dropped, print };
}

interface RenderInput {
  layout: CoverLayout;
  settings: CoverSettings;
  text: CoverText;
  /** 表1の背景画像(なければ単色で塗る) */
  image: HTMLImageElement | null;
  /** 表4の背景画像(なければ単色で塗る) */
  backImage: HTMLImageElement | null;
  /**
   * 表紙全体に敷く1枚(settings.wrap の実体)。
   * **あるときは面ごとの地を描かない。** 渡さなければ従来どおり
   */
  wrapImage?: HTMLImageElement | null;
  /** 書き出し用に描くとき true。バーコードの仮はめなど、画面だけの目印を省く */
  forExport?: boolean;
  /**
   * 紙の表紙を、300dpi の座標のまま k 倍の画素で描く(書き出しだけ。省くと 1)。
   * 出し先の目安が 300 より細かいとき、表紙も同じ細かさで書き出すため(2026-10-03)。
   * 描く座標は変えない(ctx.scale で拡大するだけ)ので、字の大きさ・置き場所・折り返しは k に依らず同じ。
   * 絵は拡大した画素で描くので、細かい絵ほど細かさが残る
   */
  outputScale?: number;
}

/**
 * 表1に文字を置いてよい範囲。
 * 紙は「塗り足し + 安全領域」を除いた内側で、背側だけは塗り足しがないぶん狭い。
 * 電子は断裁がないが、端ぎりぎりだと窮屈なので同じくらいの余白を取る。
 */
interface FrontBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 断裁後に見える範囲。左右の中央はここで決める(塗り足しぶん寄るのを防ぐ) */
  trimX: number;
  trimW: number;
}

const TITLE_LEADING = 1.35;

/**
 * 表1(表紙おもて)を描く。紙表紙の右側と、電子書籍の表紙で共通に使う。
 * x/y/w/h は面全体(塗り足し込み)、box は文字を置いてよい内側。
 */
function paintFront(
  ctx: CanvasRenderingContext2D,
  { settings, text, image, layout }: RenderInput,
  x: number,
  y: number,
  w: number,
  h: number,
  box: FrontBox,
  /** 地はもう描いてある(まるごと1枚)。文字だけ載せる */
  groundPainted = false,
): FrontInk {
  if (groundPainted) {
    // 何もしない。まるごと1枚を先に敷いてあるので、上書きすると絵が消える
  } else if (image) {
    drawCoverFit(ctx, image, x, y, w, h);
  } else {
    ctx.fillStyle =
      settings.background.kind === 'solid' ? settings.background.color : '#1b2b45';
    ctx.fillRect(x, y, w, h);
  }

  // **表1に書名・著者名を入れない**(2026-10-13 ユーザー要望「表紙にタイトルと著者名を入れた画像を自分で用意したい」)。
  // 地だけ描いて帰る。帯も敷かない(帯は書名・著者名を読ませるためのもの)。紙・電子のどちらの表1もここを通る。
  // 色の判断もしていないので 'picked'(帯の断り書きは出ない)。背の文字・表4は呼んだ側が描くので変わらない
  if (!coverFrontTextOn(settings)) return 'picked';

  // 左右の中央は「断裁後に見える範囲」の中央。ただし塊が安全領域を割るなら内側へ寄せる
  const trimCenter = box.trimX + box.trimW / 2;
  const centerFor = (blockW: number) =>
    Math.max(
      box.x + blockW / 2,
      Math.min(trimCenter, box.x + box.w - blockW / 2),
    );
  /**
   * 指定の位置へ塊を置く。auto のときは綴じ方向まかせの既定値をそのまま使う。
   * 絵の主役に文字がかぶるとき、絵を作り直すより位置を動かすほうが早い
   */
  const place = (
    anchor: CoverAnchor,
    blockW: number,
    blockH: number,
    autoX: number,
    autoY: number,
  ): [number, number] => {
    if (anchor === 'auto') return [autoX, autoY];
    const [v, hz] = anchor.split('-');
    const px =
      hz === 'left'
        ? box.x
        : hz === 'right'
          ? box.x + box.w - blockW
          : centerFor(blockW) - blockW / 2;
    const py =
      v === 'top'
        ? box.y
        : v === 'bottom'
          ? box.y + box.h - blockH
          : box.y + (box.h - blockH) / 2;
    return [px, py];
  };

  const tf = COVER_FONTS[settings.titleFont] ?? COVER_FONTS.serif;
  const af = COVER_FONTS[settings.authorFont] ?? COVER_FONTS.serif;
  const titleFont = (s: number) => `${tf.bold} ${s}px ${tf.stack}`;
  const authorFont = (s: number) => `${s}px ${af.stack}`;
  const baseTitle = h * 0.062;
  const baseAuthor = h * 0.026;
  const startTitle = baseTitle * settings.titleScale;
  const startAuthor = baseAuthor * settings.authorScale;
  // 縮小の下限は判型から決める。利用者の倍率に掛けると、2倍指定のとき下限まで2倍になり、
  // 収まる大きさへ縮みきる前に打ち切られてはみ出す
  const minTitle = Math.min(startTitle, baseTitle * 0.3);
  const minAuthor = Math.min(startAuthor, baseAuthor * 0.4);

  // --- 書名の大きさ・組み位置を先に決める(帯の大きさがこれで決まる) ---
  // 縦組みの著者名は書名の「左」に置くので、縦には競合しない。
  // ここを狭く切ると、一列で入るはずの書名が勝手に二列に割れる
  const titleMaxH = box.h * (text.vertical ? 0.82 : 0.58);
  const bandPadOf = (s: number) => s * 0.5;

  /**
   * 左右に寄せるときは折り返し幅を狭める。
   * 幅いっぱいに組んだ塊は左へも右へも動かしようがなく、指定しても中央のままになる
   */
  const sideWidth = (anchor: CoverAnchor) => {
    if (anchor === 'auto') return box.w;
    const hz = anchor.split('-')[1];
    return hz === 'center' ? box.w : box.w * 0.55;
  };
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(v, Math.max(lo, hi)));

  /**
   * 位置の微調整(mm→px)。パッドで決めた位置に足すだけ。
   * 紙はこの面の高さ=塗り足し込みの全高なので割り算が正確に合う。
   * 電子書籍の表紙は塗り足しが無いぶん4%ほど小さく効くが、微調整の用途では効かない差。
   * **必ず安全領域のクランプより前に足す** — どれだけ動かしても断裁にはかからない
   */
  const pxPerMm = h / layout.totalH;
  const nz = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  let bandX: number, bandY: number, bandW: number, bandH: number;
  let titleSize: number;
  let titleLines: string[] = [];
  let titleCols: string[] = [];
  /** 横組みで文字を中央そろえする位置。帯と書名で同じ値を使う */
  let titleCx = trimCenter;

  if (text.vertical) {
    const fit = fitVertical(text.title, box.w, titleMaxH, 3, startTitle, minTitle);
    titleSize = fit.size;
    titleCols = fit.cols;
    const pad = bandPadOf(titleSize);
    const colGap = titleSize * COL_GAP;
    // 右端の列は小口寄り。ただし安全領域からは必ず内側に入れる
    const rightCx = Math.min(x + w * 0.72, box.x + box.w - titleSize * 0.95);
    const longest = titleCols.reduce((m, c) => Math.max(m, c.length), 1);
    bandW = titleSize * 1.9 + (titleCols.length - 1) * colGap;
    bandH = titleSize + (longest - 1) * titleSize * 1.06 + pad * 2;
    [bandX, bandY] = place(
      settings.titleAnchor,
      bandW,
      bandH,
      rightCx + titleSize * 0.95 - bandW,
      box.y + box.h * 0.03,
    );
  } else {
    const fit = fitWrapped(
      ctx,
      text.title,
      titleFont,
      sideWidth(settings.titleAnchor),
      titleMaxH,
      startTitle,
      minTitle,
      TITLE_LEADING,
      // 改行位置を指定されたら、そこで折れるよう縮める(勝手に行を増やさない)
      manualLineCount(text.title),
    );
    titleSize = fit.size;
    titleLines = fit.lines;
    const pad = bandPadOf(titleSize);
    bandW = Math.min(box.w, fit.width + pad * 4);
    bandH = fit.height + pad * 2;
    // 帯ではなく文字塊を基準に置く。帯は左右にパディングを持つので、
    // 帯を右端に合わせると中の文字は中央へ戻ってしまう
    const [textX, textY] = place(
      settings.titleAnchor,
      fit.width,
      fit.height,
      centerFor(Math.max(bandW, fit.width)) - fit.width / 2,
      box.y + box.h * 0.09 + bandPadOf(titleSize),
    );
    titleCx = clamp(
      textX + fit.width / 2,
      box.x + bandW / 2,
      box.x + box.w - bandW / 2,
    );
    bandX = titleCx - bandW / 2;
    bandY = textY - bandPadOf(titleSize);
  }
  // 微調整。文字も帯もこの座標から導かれるので、塊ごと一緒に動く
  bandX += nz(settings.titleDx) * pxPerMm;
  bandY += nz(settings.titleDy) * pxPerMm;
  // 帯が安全領域からはみ出さないように寄せる
  bandX = clamp(bandX, box.x, box.x + box.w - bandW);
  bandY = clamp(bandY, box.y, box.y + box.h - bandH);
  // 文字も帯も同じ中心にそろえる。ここを別々にすると帯だけ内側に寄って文字がはみ出す
  titleCx = bandX + bandW / 2;

  // 地の明るさ。画像なら書名まわりを実測し、単色ならその色から求める
  const bgLum = image
    ? averageLuminance(ctx, bandX, bandY, bandW, bandH)
    : settings.background.kind === 'solid'
      ? hexLuminance(settings.background.color)
      : 0.2;

  // 帯の色を決める。custom は指定色、auto は地の明るさから白/黒/なし。
  // outline は帯を敷かず、字のほうにフチを付ける(絵をいちばん隠さない)
  const useOutline = settings.band === 'outline';
  let bandFill: string | null = null;
  if (settings.band === 'custom') {
    bandFill = settings.bandColor;
  } else if (settings.band === 'auto') {
    // 単色の地は明暗が一様なので帯は要らない。画像のときだけ敷く
    bandFill = !image ? null : bgLum > 0.62 ? null : bgLum > 0.35 ? '#ffffff' : '#000000';
  }
  if (bandFill) {
    const t = bandInset(titleSize, text.vertical);
    fillBand(
      ctx,
      bandX + t.x,
      bandY + t.y,
      bandW - t.x * 2,
      bandH - t.y * 2,
      bandFill,
      settings.bandOpacity,
      settings.bandSoft === true,
    );
  }

  // 文字色: 実際に文字が乗る面(帯があれば帯、なければ地)が暗いなら白へ振る。
  // ただしフチを付けるときは自動で振らない。利用者が文字色とフチ色の両方を決めており、
  // そこを勝手に白へ倒すと「白文字に白フチ」で消える。
  //
  // **選んだ色は上書きされる。** 濃い面のうえでは、何色を選んでも白になる
  // (2026-08-20 実測: 地 #1b2b45 に書名 #e03030 を選んでも、刷り上がりに赤の画素は
  //  1つも出ず 白 #f8f8f8 だけだった)。逃げ道はフチか、面を淡くすることの2つ:
  //
  // | 文字を読ませる | 文字が乗る面 | 選んだ色 | 実際に出た色 |
  // |---|---|---|---|
  // | おまかせ | 単色の濃い地 #1b2b45 | #e03030 | #ffffff(上書き) |
  // | おまかせ | 単色の淡い地 #f2e8d5 | #141c2e | #141c2e(そのまま) |
  // | 下に帯を敷く | 白帯 #ffffff | #e03030 | #e03030(そのまま) |
  // | 下に帯を敷く | 黒帯 #202020 | #e03030 | #ffffff(上書き) |
  // | 文字にフチ | 濃い地 #1b2b45 | #e03030 | #e03030(そのまま) |
  const underLum = bandFill ? hexLuminance(bandFill) : bgLum;
  const onDark = !useOutline && underLum < 0.5;
  const titleColor = onDark ? '#ffffff' : settings.titleColor;
  const authorColor = onDark ? '#ffffff' : settings.authorColor;
  /** 上の判断を、そのまま画面へ持っていく値にしておく(帯の断り書きに使う) */
  const frontInk: FrontInk = useOutline
    ? 'outline'
    : onDark
      ? bandFill
        ? 'auto-white-on-band'
        : 'auto-white-on-ground'
      : 'picked';
  const strokeOf = (size: number): Stroke | undefined =>
    useOutline ? { color: settings.bandOutlineColor, width: size * STROKE_RATIO } : undefined;

  ctx.fillStyle = titleColor;
  ctx.font = titleFont(titleSize);
  ctx.textBaseline = 'alphabetic';
  const titlePad = bandPadOf(titleSize);
  const titleStroke = strokeOf(titleSize);
  if (text.vertical) {
    // 列は右から左へ。1列目が右端
    const colGap = titleSize * COL_GAP;
    const rightCx = bandX + bandW - titleSize * 0.95;
    titleCols.forEach((col, i) => {
      drawVertical(ctx, col, rightCx - i * colGap, bandY + titlePad, titleSize, 1.06, titleStroke);
    });
  } else {
    titleLines.forEach((line, i) => {
      const lw = ctx.measureText(line).width;
      paintText(
        ctx,
        line,
        titleCx - lw / 2,
        bandY + titlePad + titleSize + i * titleSize * TITLE_LEADING,
        titleStroke,
      );
    });
  }

  if (!text.author) return frontInk;

  // --- 著者名。書名と同じ規則で、はみ出す前に縮める ---
  const aPad = (s: number) => s * 0.5;
  let authorSize: number;
  let authorLines: string[] = [];
  let authorCols: string[] = [];
  let authorCx = trimCenter;
  let aX: number, aY: number, aW: number, aH: number;

  if (text.vertical) {
    // 書名の左下。書名とは横にずらすので、縦は下寄りに置くだけでよい
    const aTop = box.y + box.h * 0.55;
    const fit = fitVertical(
      text.author,
      box.w * 0.5,
      box.y + box.h - aTop - startAuthor * 0.5,
      2,
      startAuthor,
      minAuthor,
    );
    authorSize = fit.size;
    authorCols = fit.cols;
    const pad = aPad(authorSize);
    const colGap = authorSize * COL_GAP;
    const longest = authorCols.reduce((m, c) => Math.max(m, c.length), 1);
    aW = authorSize * 1.9 + (authorCols.length - 1) * colGap;
    aH = authorSize + (longest - 1) * authorSize * 1.06 + pad * 2;
    [aX, aY] = place(
      settings.authorAnchor,
      aW,
      aH,
      bandX - authorSize * 1.7 - aW / 2,
      aTop - pad,
    );
  } else {
    const fit = fitWrapped(
      ctx,
      text.author,
      authorFont,
      sideWidth(settings.authorAnchor),
      box.h * 0.14,
      startAuthor,
      minAuthor,
      1.5,
    );
    authorSize = fit.size;
    authorLines = fit.lines;
    const pad = aPad(authorSize);
    aW = Math.min(box.w, fit.width + pad * 4);
    aH = fit.height + pad * 2;
    const [textX, textY] = place(
      settings.authorAnchor,
      fit.width,
      fit.height,
      centerFor(Math.max(aW, fit.width)) - fit.width / 2,
      // 地から一定の位置。ただし書名の帯には重ねない
      Math.max(bandY + bandH + authorSize, box.y + box.h - aH - box.h * 0.1) + pad,
    );
    aX = clamp(textX + fit.width / 2, box.x + aW / 2, box.x + box.w - aW / 2) - aW / 2;
    aY = textY - pad;
  }
  // 微調整(書名と同じ約束)
  aX += nz(settings.authorDx) * pxPerMm;
  aY += nz(settings.authorDy) * pxPerMm;
  aX = clamp(aX, box.x, box.x + box.w - aW);
  aY = clamp(aY, box.y, box.y + box.h - aH);
  authorCx = aX + aW / 2;

  if (bandFill) {
    const a = bandInset(authorSize, text.vertical);
    fillBand(ctx, aX + a.x, aY + a.y, aW - a.x * 2, aH - a.y * 2, bandFill, settings.bandOpacity, settings.bandSoft === true);
  }
  ctx.fillStyle = authorColor;
  ctx.font = authorFont(authorSize);
  const apad = aPad(authorSize);
  const authorStroke = strokeOf(authorSize);
  if (text.vertical) {
    const colGap = authorSize * COL_GAP;
    const rightCx = aX + aW - authorSize * 0.95;
    authorCols.forEach((col, i) => {
      drawVertical(ctx, col, rightCx - i * colGap, aY + apad, authorSize, 1.06, authorStroke);
    });
  } else {
    authorLines.forEach((line, i) => {
      const lw = ctx.measureText(line).width;
      paintText(
        ctx,
        line,
        authorCx - lw / 2,
        aY + apad + authorSize + i * authorSize * 1.5,
        authorStroke,
      );
    });
  }
  return frontInk;
}

/** 紙の表紙(表4 + 背 + 表1)を1枚のキャンバスに描く */
export function renderPaperCover(
  canvas: HTMLCanvasElement,
  input: RenderInput,
): RenderReport {
  // text は表1側(renderFront)で使う。表4には書名も版元名も刷らない
  const { layout, settings, backImage, wrapImage } = input;
  const k = Math.max(1, input.outputScale ?? 1);
  canvas.width = Math.round(layout.px.w * k);
  canvas.height = Math.round(layout.px.h * k);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { blurbOverflow: 0, spineOverflow: 0, spine: null, frontInk: 'picked' };
  if (k !== 1) ctx.scale(canvas.width / layout.px.w, canvas.height / layout.px.h);
  let blurbOverflow = 0;
  let spineOverflow = 0;
  /** 背に実際に使った大きさ。**画面の数字はこれを読む**(spineTextBox の答えとは食い違う) */
  let spine: SpinePrint | null = null;

  const H = layout.px.h;
  const x = (mm: number) => mmToPx(mm);

  // 綴じ方向で表1と表4の左右が入れ替わる(layout.front / layout.back が持っている)
  const backX = x(layout.back.x0);
  const backW = x(layout.back.x1) - backX;
  const frontX = x(layout.front.x0);
  const frontW = x(layout.front.x1) - frontX;
  const outer = x(layout.bleed + COVER_SAFE_MM);
  const inner = x(COVER_SAFE_MM);
  const bleed = x(layout.bleed);

  // --- まるごと1枚(表4・背・表1をまたぐ) ---
  // **面ごとの地より先に、全面へ1枚敷く。** これがあるときは面ごとの地を描かない
  // (どちらが出るのか曖昧にしないため。models/cover.ts の CoverWrap を参照)
  if (wrapImage) drawCoverFit(ctx, wrapImage, 0, 0, layout.px.w, H);

  // --- 表4(表1とは独立。単色か、別の画像) ---
  const bc = settings.backCover;
  if (wrapImage) {
    // まるごと1枚が敷いてあるので何もしない
  } else if (bc.kind === 'solid') {
    ctx.fillStyle = bc.color;
    ctx.fillRect(backX, 0, backW, H);
  } else if (backImage) {
    drawCoverFit(ctx, backImage, backX, 0, backW, H);
  } else {
    ctx.fillStyle = '#1b2b45';
    ctx.fillRect(backX, 0, backW, H);
  }

  // --- 背 ---
  if (!wrapImage) {
    ctx.fillStyle = settings.spineColor;
    ctx.fillRect(x(layout.spineArea.x0), 0, x(layout.spine), H);
  }
  // **文字は地の上に載せる。** まるごと1枚を敷いた背でも刷る(絵の上に書名が乗るのは
  // 市販の本でも普通の作り)。読めるかどうかは色の選択に任せ、こちらでは帯を敷かない
  if (settings.spineTextOn && layout.spineTextAllowed) {
    const painted = paintSpine(ctx, settings, input.text, layout, H);
    spineOverflow = painted.dropped;
    spine = painted.print;
  }

  // --- 表1 ---
  // 背に接する側は塗り足しがないので安全領域だけ、小口・天地は塗り足しぶんも内側へ入る。
  // 右綴じでは表1が左に来るので、小口は左・背は右になる
  const frontSpineLeft = !layout.rightBound;
  const frontInk = paintFront(ctx, input, frontX, 0, frontW, H, {
    x: frontX + (frontSpineLeft ? inner : outer),
    y: outer,
    w: frontW - inner - outer,
    h: H - outer * 2,
    // 断裁後に見える範囲。塗り足しは小口側にだけ付いている
    trimX: frontX + (frontSpineLeft ? 0 : bleed),
    trimW: frontW - bleed,
  
  }, Boolean(wrapImage));

  // --- 表4の文字 ---
  // あらすじは断裁ぎりぎりに置かない。安全領域からさらに一息(5mm)内側に入れる。
  // 左右とも同じアキにしておけば、綴じ方向が変わっても安全領域を割らない
  const safe = outer;
  const pad4 = safe + x(5);
  const bodySize = H * 0.019;
  const blurbTop = pad4 + H * 0.06;
  const blurbLeft = backX + pad4;
  const blurbW = backW - pad4 * 2;
  // バーコード領域は表4の右下。あらすじはここへ食い込ませない。
  // **会社が自動でバーコードを刷るときだけ**空ける(layout.barcode。KDP は 50×30mm)。
  // 空けない会社では、あらすじが安全領域の下端まで使える
  const barcode = layout.barcode;
  const barcodeTop = barcode ? H - safe - x(barcode.h) : H - safe;

  if (settings.blurb.trim()) {
    const bf = COVER_FONTS[settings.blurbFont] ?? COVER_FONTS.serif;
    const pad = bodySize * 1.1;
    const leading = 1.75;
    // 地の余白ぶんも含めてバーコードの手前で止める(バーコードが無ければ安全領域の手前)
    const maxH = barcodeTop - (barcode ? x(6) : 0) - blurbTop - pad;
    // 本文用の文字は 8pt 前後しかないので、縮められるのは 8 割まで。
    // それでも入らないぶんは組まずに、入りきらなかったことを呼び出し元へ返す
    const fit = fitWrapped(
      ctx,
      settings.blurb,
      (s) => `${s}px ${bf.stack}`,
      blurbW,
      maxH,
      bodySize,
      bodySize * 0.8,
      leading,
    );
    const maxLines = Math.max(
      1,
      Math.floor((maxH - fit.size * 1.2) / (fit.size * leading)) + 1,
    );
    const lines = fit.lines.slice(0, maxLines);
    blurbOverflow = fit.lines.slice(maxLines).join('').length;

    const blockH = blockHeight(fit.size, lines.length, leading) + pad * 2;
    const banded = settings.blurbDecor === 'band';
    const outlined = settings.blurbDecor === 'outline';
    if (banded) {
      ctx.fillStyle = settings.blurbBandColor;
      ctx.globalAlpha = settings.blurbBandOpacity;
      ctx.fillRect(blurbLeft - pad, blurbTop - pad, blurbW + pad * 2, blockH);
      ctx.globalAlpha = 1;
    }
    // 文字が乗る面の明るさから色を決める。
    // フチを付けるときはフチの明暗を基準にする(白フチなら字は濃く、黒フチなら白く)
    const under = banded
      ? hexLuminance(settings.blurbBandColor)
      : outlined
        ? hexLuminance(settings.blurbOutlineColor)
        : averageLuminance(ctx, blurbLeft, blurbTop, blurbW, Math.min(blockH, H - blurbTop));
    ctx.fillStyle = under < 0.5 ? '#ffffff' : '#1a1a1a';
    ctx.font = `${fit.size}px ${bf.stack}`;
    const blurbStroke: Stroke | undefined = outlined
      ? { color: settings.blurbOutlineColor, width: fit.size * STROKE_RATIO }
      : undefined;
    lines.forEach((line, i) =>
      paintText(ctx, line, blurbLeft, blurbTop + fit.size + i * fit.size * leading, blurbStroke),
    );
  }

  // 表4に版元名は刷らない(2026-08-11 決定)。
  // 個人出版では発行所を持たないことが多く、発行者に自分の名前を入れると
  // 著者名が2度出ているようにしか見えないため。発行所は奥付だけに載せる

  // 会社がバーコードを自動で刷る領域(KDP は約50×30mm)。表4の右下に取る。
  // 画面では目印として薄く示すが、書き出しには入れない
  // (実際のバーコード位置とわずかにずれると仮はめの枠だけが残って見苦しいため)
  if (!input.forExport && barcode) {
    const bcW = x(barcode.w);
    const bcH = x(barcode.h);
    const bcX = backX + backW - safe - bcW;
    const bcY = H - safe - bcH;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.55;
    ctx.fillRect(bcX, bcY, bcW, bcH);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#888888';
    ctx.setLineDash([x(2), x(2)]);
    ctx.lineWidth = Math.max(1, x(0.4));
    ctx.strokeRect(bcX, bcY, bcW, bcH);
    ctx.setLineDash([]);
    ctx.fillStyle = '#555555';
    ctx.font = `${bodySize * 0.85}px ${GOTHIC}`;
    ctx.fillText('バーコード領域(出力には含まれません)', bcX + x(3), bcY + bcH / 2);
    ctx.restore();
  }

  return { blurbOverflow, spineOverflow, spine, frontInk };
}

/** 電子書籍の表紙(表1のみ)を KDP 推奨サイズで描く */
export function renderEbookCover(canvas: HTMLCanvasElement, input: RenderInput): void {
  canvas.width = EBOOK_COVER_PX.w;
  canvas.height = EBOOK_COVER_PX.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  // 断裁はないが、端まで文字が来ると窮屈なので紙と同じくらいの余白を取る
  // (文庫の「塗り足し+安全領域」は面の幅の約9%・高さの約6%にあたる)
  const mx = w * 0.09;
  const my = h * 0.06;
  // まるごと1枚のときは、**紙で表1になる部分だけを切り出す**。
  // 全体を縮めると背や表4まで写り込んで、紙と別の絵になってしまう
  const { layout, wrapImage } = input;
  if (wrapImage) {
    const scale = Math.max(layout.px.w / wrapImage.width, layout.px.h / wrapImage.height);
    const drawnW = wrapImage.width * scale;
    const drawnH = wrapImage.height * scale;
    const offX = (layout.px.w - drawnW) / 2;
    const offY = (layout.px.h - drawnH) / 2;
    // 紙のキャンバス座標 → 元画像の座標へ戻す
    const toSrcX = (px: number) => (px - offX) / scale;
    const fx0 = mmToPx(layout.front.x0);
    const fx1 = mmToPx(layout.front.x1);
    drawCoverFitSlice(
      ctx,
      wrapImage,
      toSrcX(fx0),
      -offY / scale,
      toSrcX(fx1) - toSrcX(fx0),
      layout.px.h / scale,
      0, 0, w, h,
    );
  }

  paintFront(ctx, input, 0, 0, w, h, {
    x: mx,
    y: my,
    w: w - mx * 2,
    h: h - my * 2,
    trimX: 0,
    trimW: w,
  }, Boolean(wrapImage));
}
