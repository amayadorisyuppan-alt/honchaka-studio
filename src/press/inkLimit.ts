// インクの総量(C+M+Y+K)を、上限(%)以下に収める。Ghostscript で CMYK にしたあとに掛ける。
//
// **なぜ自分で抑えるのか。** Japan Color 2011 Coated の ICC で変換すると、写真のいちばん暗い所が 350% を少し超える
// (2026-09-27 試作の実測: 本文の写真で最大 361%、表紙で 356%)。印刷では総量が多すぎると乾かず裏移りするので、
// 利用者と 300% 以下に決めた(2026-10-01)。Ghostscript には総量を抑える指定が無い。
//
// **抑え方。** 合計が上限を超える色だけ、K はそのまま、C・M・Y を同じ割合で下げる(色みを保ち、暗さは K が支える)。
// K だけの黒や、上限以下の色には1ビットも触らない(画像は1画素も変わらなければストリームごと触らない)。
//
// 手を入れる所は4つ: 画像の画素・Indexed の色の表 / 描く命令の色(k K sc scn …)/ 影の指定(Shading)の色 / (測るだけ)透明の重なり。
// 抑えられない所は、黙って通さず unhandled に「何の・どこが・なぜ」を入れる(入れた所は、上限を超えているかもしれない)。
//
// Node 24 でそのまま動く書き方にしてある(scripts/press/inkLimit.test.ts が node で回す)。ブラウザ専用の物は使わない。
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from 'pdf-lib';
import { contentHolders, pdfNum, readStream, replaceStream, rewriteOperations } from './content.ts';
import type { ContentHolder, Operation } from './content.ts';
import type { InkReport } from './types.ts';

/** あるオブジェクト(画像・影)のインクの事実。点検(inspect.ts)が「カラーのページ」を数えるのに使い回す */
export interface InkFact {
  /** C+M+Y+K の最大(%)。抑えたあとの値 */
  max: number;
  /** C・M・Y のどれかが 0 でない画素・色が在る */
  cmy: boolean;
}

export interface InkLimitResult extends InkReport {
  /** 画像・影ごとの事実。キーは参照の文字('12 0 R') */
  facts: Map<string, InkFact>;
}

/** 浮動小数の誤差で「ちょうど上限」の色を抑えてしまわないための余裕(%) */
const EPS = 1e-7;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** PDF に書く数を、5桁で切り捨てる(四捨五入だと、書いたあとの合計が上限をわずかに超えることがある) */
const floor5 = (v: number): number => Math.floor(v * 1e5) / 1e5;
/** 報告の数。割り算の誤差(299.99999999999994 など)を見せない */
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

function isOver(c: number, m: number, y: number, k: number, limit: number): boolean {
  return (c + m + y + k) * 100 > limit + EPS;
}

/**
 * 1色を抑える(0〜1 の4つ)。K はそのまま、C・M・Y に s = (上限 − K) / (C+M+Y) を掛ける。
 * 上限以下ならそのまま返す。K だけで上限を超えているとき(上限が 100% 未満)は C・M・Y を 0 にする。
 * 検査と、ほかの部品から使えるように出す
 */
export function clampCmyk(c: number, m: number, y: number, k: number, limit: number): [number, number, number, number] {
  if (!isOver(c, m, y, k, limit)) return [c, m, y, k];
  const cmy = c + m + y;
  if (cmy <= 0) return [c, m, y, k];
  const avail = limit / 100 - k;
  if (avail <= 0) return [0, 0, 0, k];
  const s = avail / cmy;
  return [c * s, m * s, y * s, k];
}

// ───────────────────────── 色空間 ─────────────────────────

type Space =
  | { kind: 'cmyk' }
  | { kind: 'gray' }
  | { kind: 'rgb' }
  | { kind: 'indexed'; base: Space; arr: PDFArray }
  | { kind: 'pattern'; base: Space | null }
  | { kind: 'spot' }
  | { kind: 'unknown' };

function spaceText(sp: Space | null): string {
  switch (sp?.kind) {
    case 'rgb':
      return 'RGB';
    case 'spot':
      return '特色';
    case 'pattern':
      return 'パターン';
    case 'indexed':
      return '索引色';
    default:
      return '色空間が分からないもの';
  }
}

const N_CS = PDFName.of('ColorSpace');

/** 色空間の指定(名前・配列・参照)を、インクの量を測るために分類する。csRes は資源の ColorSpace の辞書(名前を引く用) */
function classify(ctx: PDFContext, cs: PDFObject | undefined, csRes: PDFDict | null, depth = 0): Space {
  if (depth > 8 || cs === undefined) return { kind: 'unknown' };
  const v = ctx.lookup(cs);
  if (v instanceof PDFName) {
    switch (v.decodeText()) {
      case 'DeviceCMYK':
      case 'CMYK':
        return { kind: 'cmyk' };
      case 'DeviceGray':
      case 'G':
      case 'CalGray':
        return { kind: 'gray' };
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
      case 'Lab':
        return { kind: 'rgb' };
      case 'Pattern':
        return { kind: 'pattern', base: null };
    }
    if (csRes) {
      const hit = csRes.get(v);
      if (hit !== undefined) return classify(ctx, hit, null, depth + 1);
    }
    return { kind: 'unknown' };
  }
  if (v instanceof PDFArray) {
    const head = v.lookup(0);
    const name = head instanceof PDFName ? head.decodeText() : '';
    switch (name) {
      case 'ICCBased': {
        const icc = v.lookup(1);
        const n = icc instanceof PDFStream ? icc.dict.lookup(PDFName.of('N')) : null;
        const count = n instanceof PDFNumber ? n.asNumber() : 0;
        return count === 4 ? { kind: 'cmyk' } : count === 1 ? { kind: 'gray' } : count === 3 ? { kind: 'rgb' } : { kind: 'unknown' };
      }
      case 'Indexed':
      case 'I':
        return { kind: 'indexed', base: classify(ctx, v.get(1), csRes, depth + 1), arr: v };
      case 'Pattern':
        return { kind: 'pattern', base: v.size() > 1 ? classify(ctx, v.get(1), csRes, depth + 1) : null };
      case 'CalGray':
        return { kind: 'gray' };
      case 'CalRGB':
      case 'Lab':
        return { kind: 'rgb' };
      case 'Separation':
      case 'DeviceN':
        return { kind: 'spot' };
    }
  }
  return { kind: 'unknown' };
}

function numArray(v: PDFObject | undefined): number[] | null {
  if (!(v instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) {
    const x = v.lookup(i);
    if (!(x instanceof PDFNumber)) return null;
    out.push(x.asNumber());
  }
  return out;
}

// ───────────────────────── 画素の輪 ─────────────────────────

interface PixelStat {
  /** 抑える前・あとの合計の最大(0〜1020。1画素の C+M+Y+K を 8ビットの数のまま足したもの) */
  before: number;
  after: number;
  changed: number;
  /** 抑えたあとに、C・M・Y のどれかが 0 でない画素が在る */
  cmy: boolean;
}

/**
 * C M Y K の順に4バイトずつ並んだ画素を、合計が cap(8ビットの数の合計)以下になるように、その場で抑える。
 * inv は 0 か 0xff。/Decode が反転([1 0 1 0 1 0 1 0])の画像は、入っている数が「0xff − 濃さ」なので、XOR で濃さに戻して測る。
 * 輪の中に関数呼び出しも配列の確保も置かない(900万画素で 1 秒以内が目安)。
 *
 * 丸めは切り捨て。C・M・Y それぞれを floor(値 × 残り / (C+M+Y)) にするので、3つの和は残りを超えない
 * (整数どうしの割り算の商は、整数でなければ整数から 1/765 以上離れる。浮動小数の誤差で floor が狂うことはない)
 */
function clampPixels(d: Uint8Array, n4: number, cap: number, inv: number): PixelStat {
  let maxBefore = 0;
  let maxAfter = 0;
  let changed = 0;
  let cmyAny = 0;
  for (let i = 0; i < n4; i += 4) {
    let c = d[i] ^ inv;
    let m = d[i + 1] ^ inv;
    let y = d[i + 2] ^ inv;
    const k = d[i + 3] ^ inv;
    let s = c + m + y + k;
    if (s > maxBefore) maxBefore = s;
    if (s > cap) {
      const avail = cap - k;
      if (avail <= 0) {
        c = 0;
        m = 0;
        y = 0;
      } else {
        const cmy = c + m + y;
        c = ((c * avail) / cmy) | 0;
        m = ((m * avail) / cmy) | 0;
        y = ((y * avail) / cmy) | 0;
      }
      d[i] = c ^ inv;
      d[i + 1] = m ^ inv;
      d[i + 2] = y ^ inv;
      changed++;
      s = c + m + y + k;
    }
    if (s > maxAfter) maxAfter = s;
    cmyAny |= c | m | y;
  }
  return { before: maxBefore, after: maxAfter, changed, cmy: cmyAny !== 0 };
}

const pct8 = (sum: number): number => (sum * 100) / 255;

// ───────────────────────── 本体 ─────────────────────────

/** 抑えられない・測れないもの。理由は画面に出る日本語 */
class Unsupported extends Error {}

interface Acc {
  before: number;
  after: number;
  cmy: boolean;
  changed: boolean;
}

const N_FILTER = PDFName.of('Filter');
const N_DECODE = PDFName.of('Decode');

function filterNames(d: PDFDict): string[] {
  const f = d.lookup(N_FILTER);
  const list = f instanceof PDFArray ? f.asArray() : f ? [f] : [];
  const out: string[] = [];
  for (const x of list) {
    const v = d.context.lookup(x);
    if (v instanceof PDFName) out.push(v.decodeText());
  }
  return out;
}

function numOf(d: PDFDict, key: string): number | null {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/**
 * doc の中の CMYK の色を、合計が limit(%)以下になるように抑える(doc を直に書き換える)。
 * limit を Infinity にすると、何も書き換えずに測るだけ(maxBefore = maxAfter、facts は入る)
 */
export async function limitInk(doc: PDFDocument, limit: number): Promise<InkLimitResult> {
  const ctx = doc.context;
  const measureOnly = !Number.isFinite(limit);
  // 8ビットの合計の上限。浮動小数で 764.9999 にならないよう、わずかに足してから切り捨てる
  const cap = measureOnly ? Number.POSITIVE_INFINITY : Math.floor((limit * 255) / 100 + 1e-9);

  const facts = new Map<string, InkFact>();
  const unhandled: string[] = [];
  let maxBefore = 0;
  let maxAfter = 0;
  let nImages = 0;
  let nOps = 0;
  let nShadings = 0;
  const seen = (before: number, after: number) => {
    if (before > maxBefore) maxBefore = before;
    if (after > maxAfter) maxAfter = after;
  };
  const giveUp = (what: string, why: string, key?: string) => {
    unhandled.push(`${what}（${why}）`);
    // 測れないものは「いちばん濃い・色が付く」側に倒す(点検が、カラーでないと言い切らないため)
    if (key) facts.set(key, { max: 400, cmy: true });
  };

  const entries = ctx.enumerateIndirectObjects();

  // 透明のマスク(SMask・Mask)に使われている画像はインクではない。先に集める
  const maskRefs = new Set<string>();
  for (const [, obj] of entries) {
    if (!(obj instanceof PDFRawStream) || obj.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    for (const key of ['SMask', 'Mask']) {
      const v = obj.dict.get(PDFName.of(key));
      if (v && ctx.lookup(v) instanceof PDFRawStream) maskRefs.add(String(v));
    }
  }

  // ── 画像 ──
  // 1枚ずつ処理して、大きな配列を持ち続けない(表紙は CMYK で 36MB)
  const indexedDone = new Map<PDFArray, InkFact>();
  for (const [ref, obj] of entries) {
    if (!(obj instanceof PDFRawStream) || obj.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    if (maskRefs.has(ref.toString())) continue;
    await processImage(ref, obj);
  }

  async function processImage(ref: PDFRef, stream: PDFRawStream): Promise<void> {
    const d = stream.dict;
    if (String(d.lookup(PDFName.of('ImageMask'))) === 'true') return; // 型抜き。色は描く命令の色
    const key = ref.toString();
    const what = `画像 ${key}`;
    const filters = filterNames(d);
    const sp = classify(ctx, d.get(N_CS), null);

    if (sp.kind === 'unknown' && d.get(N_CS) === undefined) {
      giveUp(what, filters.includes('JPXDecode') ? 'JPEG 2000 で色空間が中に入っているので、測れない' : '色空間が書かれていないので、測れない', key);
      return;
    }
    if (sp.kind === 'gray') {
      facts.set(key, { max: 100, cmy: false });
      seen(100, 100);
      return;
    }
    if (sp.kind === 'indexed') {
      await processIndexed(key, what, sp);
      return;
    }
    if (sp.kind !== 'cmyk') {
      giveUp(what, `${spaceText(sp)}のままなので、インクの量は測れない`, key);
      return;
    }

    // ここから CMYK(DeviceCMYK か、成分が4つの ICCBased)
    if (numOf(d, 'BitsPerComponent') !== 8) {
      giveUp(what, '8ビットでない CMYK なので、測れない', key);
      return;
    }
    const dec = numArray(d.lookup(N_DECODE));
    let inv = 0;
    if (dec) {
      const isDefault = dec.length === 8 && dec.every((x, i) => x === (i % 2 === 0 ? 0 : 1));
      const isInverted = dec.length === 8 && dec.every((x, i) => x === (i % 2 === 0 ? 1 : 0));
      if (isInverted) inv = 0xff;
      else if (!isDefault) {
        giveUp(what, '/Decode が既定でも反転でもないので、測れない', key);
        return;
      }
    }
    if (filters.some((f) => f === 'DCTDecode' || f === 'DCT')) {
      giveUp(what, 'JPEG の CMYK なので、中を見られない', key);
      return;
    }
    const w = numOf(d, 'Width');
    const h = numOf(d, 'Height');
    let data: Uint8Array | null;
    try {
      data = await readStream(stream, w !== null && h !== null ? w * h * 4 : undefined);
    } catch {
      giveUp(what, '中身が壊れていて読めない', key);
      return;
    }
    if (!data) {
      giveUp(what, '対応していない圧縮なので、測れない', key);
      return;
    }
    // 色の値で透明を決めている画像は、抑えると透明だった画素が見えたり、色がずれたりする(2026-10-01 の指摘 B3)。
    //   - /Mask が数の配列: その色の画素を抜く。抑えた色は鍵に合わなくなる
    //   - SMask が /Matte を持つ: 下地の色と混ぜ込んで(前乗算して)書いてある。画素だけ変えると、混ぜ込みの前提が合わなくなる
    // どちらも、抑える必要が無い(上限以下の)画像ならそのままでよい。抑える必要があるときだけ、書き換えず unhandled にする
    const smask = ctx.lookup(d.get(PDFName.of('SMask')) as PDFObject);
    const maskKind = ctx.lookup(d.get(PDFName.of('Mask')) as PDFObject) instanceof PDFArray
      ? '色抜きの指定(Mask)'
      : smask instanceof PDFStream && smask.dict.has(PDFName.of('Matte')) ? '透明のマスクの下地の色(Matte)' : null;
    // readStream は、圧縮の無い画像では元のバイト列そのものを返す。測るだけのときに書き換えてしまわないよう、写しで測る
    const stat = clampPixels(maskKind ? data.slice() : data, Math.min(data.length, w !== null && h !== null ? w * h * 4 : data.length) & ~3, cap, inv);
    if (maskKind && stat.changed > 0) {
      giveUp(what, `${maskKind}があり、抑えると透明の所や色が変わるので、触っていない。上限を超えたまま`, key);
      facts.set(key, { max: round6(pct8(stat.before)), cmy: true });
      seen(round6(pct8(stat.before)), round6(pct8(stat.before)));
      return;
    }
    if (stat.changed > 0) {
      // 画素は PNG の行ごとの予測を付けて詰める(付けないと、書き戻した画像がふくらむ。content.ts の pngPredict)
      await replaceStream(doc, ref, data, w !== null && h !== null && w > 0 && h > 0 ? { predict: { colors: 4, columns: w, rows: h } } : undefined);
      nImages++;
    }
    facts.set(key, { max: round6(pct8(stat.after)), cmy: stat.cmy });
    seen(round6(pct8(stat.before)), round6(pct8(stat.after)));
  }

  /** 元が CMYK の Indexed: 色の表(文字列かストリーム)の各色を抑える。表は画像のあいだで共有されることがあるので1度だけ */
  async function processIndexed(key: string, what: string, sp: Extract<Space, { kind: 'indexed' }>): Promise<void> {
    const base = sp.base;
    if (base.kind === 'gray') {
      facts.set(key, { max: 100, cmy: false });
      seen(100, 100);
      return;
    }
    if (base.kind !== 'cmyk') {
      giveUp(what, `${spaceText(base)}を元にした索引色なので、インクの量は測れない`, key);
      return;
    }
    const done = indexedDone.get(sp.arr);
    if (done) {
      facts.set(key, done);
      return;
    }
    const table = sp.arr.get(3);
    const tv = table === undefined ? undefined : ctx.lookup(table);
    let bytes: Uint8Array | null = null;
    let tableRef: PDFRef | null = null;
    if (tv instanceof PDFRawStream) {
      tableRef = table as PDFRef;
      try {
        bytes = await readStream(tv);
      } catch {
        giveUp(what, '色の表が壊れていて読めない', key);
        return;
      }
    } else if (tv instanceof PDFString || tv instanceof PDFHexString) {
      bytes = tv.asBytes();
    }
    if (!bytes) {
      giveUp(what, '色の表が読めないので、測れない', key);
      return;
    }
    const hival = (() => {
      const v = ctx.lookup(sp.arr.get(2));
      return v instanceof PDFNumber ? v.asNumber() : 255;
    })();
    const n4 = Math.min(bytes.length, (hival + 1) * 4) & ~3;
    const stat = clampPixels(bytes, n4, cap, 0);
    if (stat.changed > 0) {
      if (tableRef) await replaceStream(doc, tableRef, bytes);
      else sp.arr.set(3, hexOf(bytes));
      nImages++;
    }
    const fact = { max: round6(pct8(stat.after)), cmy: stat.cmy };
    indexedDone.set(sp.arr, fact);
    facts.set(key, fact);
    seen(round6(pct8(stat.before)), round6(pct8(stat.after)));
  }

  const gsReported = new Set<string>();
  // ── 影の指定(Shading)と透明の設定(ExtGState)。辞書を総なめする ──
  // 影は、ページの資源に直に書かれていることも、別のオブジェクトのことも在るので、直に持っている辞書の中も見る
  for (const [ref, obj] of entries) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const owner = ref.toString();
    const pending: Promise<void>[] = [];
    walkDicts(dict, (d, isRoot) => {
      if (d.has(PDFName.of('ShadingType'))) pending.push(processShading(d, isRoot ? owner : `${owner} の中の影`));
      checkGState(d, owner);
    });
    for (const p of pending) await p;
  }

  function checkGState(d: PDFDict, owner: string): void {
    const bm = d.lookup(PDFName.of('BM'));
    const normal = (x: PDFObject) => x === PDFName.of('Normal') || x === PDFName.of('Compatible');
    const badBm = bm instanceof PDFName ? !normal(bm) : bm instanceof PDFArray ? bm.asArray().some((x) => !normal(ctx.lookup(x) as PDFObject)) : false;
    const overprint = String(d.lookup(PDFName.of('OP'))) === 'true' || String(d.lookup(PDFName.of('op'))) === 'true';
    if (badBm && !gsReported.has(`${owner} bm`)) {
      gsReported.add(`${owner} bm`);
      unhandled.push(`透明の設定 ${owner}（乗算などの合成モードがあるので、重なった所は測れない）`);
    }
    if (overprint && !gsReported.has(`${owner} op`)) {
      gsReported.add(`${owner} op`);
      unhandled.push(`透明の設定 ${owner}（オーバープリントがあるので、重なった所は測れない）`);
    }
  }

  async function processShading(d: PDFDict, key: string): Promise<void> {
    const what = `影の指定 ${key}`;
    const sp = classify(ctx, d.get(N_CS), null);
    if (sp.kind === 'gray') {
      facts.set(key, { max: 100, cmy: false });
      seen(100, 100);
      return;
    }
    if (sp.kind !== 'cmyk') {
      giveUp(what, `${spaceText(sp)}のままなので、インクの量は測れない`, key);
      return;
    }
    const type = numOf(d, 'ShadingType') ?? 0;
    if (type >= 4) {
      giveUp(what, '網の影なので、測れない', key);
      return;
    }
    const acc: Acc = { before: 0, after: 0, cmy: false, changed: false };
    try {
      const fn = d.get(PDFName.of('Function'));
      if (fn === undefined) throw new Unsupported('関数がないので、測れない');
      await walkFunction(fn, acc, 0);
      if (d.has(PDFName.of('Background'))) clampArray(d, 'Background', acc);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      giveUp(what, e.message, key);
      return;
    }
    if (acc.changed) nShadings++;
    facts.set(key, { max: round6(acc.after), cmy: acc.cmy });
    seen(round6(acc.before), round6(acc.after));
  }

  /** 辞書の項目 key の4つの数(C M Y K)を抑える。acc に前後の合計・色が付くか・書き換えたかを足す */
  function clampArray(owner: PDFDict, key: string, acc: Acc): void {
    const v = numArray(owner.lookup(PDFName.of(key)));
    if (!v || v.length !== 4) throw new Unsupported(`/${key} の成分が4つではないので、測れない`);
    const [c, m, y, k] = v.map(clamp01);
    const before = (c + m + y + k) * 100;
    let after = before;
    let out = v;
    if (!measureOnly && isOver(c, m, y, k, limit)) {
      const r = clampCmyk(c, m, y, k, limit);
      out = [floor5(r[0]), floor5(r[1]), floor5(r[2]), v[3]];
      owner.set(PDFName.of(key), ctx.obj(out));
      acc.changed = true;
      after = (out[0] + out[1] + out[2] + clamp01(out[3])) * 100;
    }
    if (before > acc.before) acc.before = before;
    if (after > acc.after) acc.after = after;
    if (out[0] > 0 || out[1] > 0 || out[2] > 0) acc.cmy = true;
  }

  async function walkFunction(fn: PDFObject, acc: Acc, depth: number): Promise<void> {
    if (depth > 8) throw new Unsupported('関数の入れ子が深すぎるので、測れない');
    const f = ctx.lookup(fn);
    if (f instanceof PDFArray) throw new Unsupported('関数が配列(成分ごとの関数)なので、測れない');
    const dict = f instanceof PDFStream ? f.dict : f instanceof PDFDict ? f : null;
    if (!dict) throw new Unsupported('関数が読めないので、測れない');
    switch (numOf(dict, 'FunctionType')) {
      case 2:
        // 途中の色は C0 と C1 のあいだの混ぜなので、両端が上限以下なら途中も上限以下
        clampArray(dict, 'C0', acc);
        clampArray(dict, 'C1', acc);
        return;
      case 3: {
        const subs = dict.lookup(PDFName.of('Functions'));
        if (!(subs instanceof PDFArray)) throw new Unsupported('つなぎの関数の中身が読めないので、測れない');
        for (let i = 0; i < subs.size(); i++) await walkFunction(subs.get(i), acc, depth + 1);
        return;
      }
      case 0: {
        if (!(f instanceof PDFRawStream)) throw new Unsupported('標本の関数がストリームでないので、測れない');
        const range = numArray(dict.lookup(PDFName.of('Range')));
        const decode = numArray(dict.lookup(N_DECODE));
        const unit = [0, 1, 0, 1, 0, 1, 0, 1];
        const same = (a: number[] | null, b: number[]) => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);
        if (!same(range, unit) || (decode && !same(decode, unit))) throw new Unsupported('標本の関数の Range・Decode が既定でないので、測れない');
        if (numOf(dict, 'BitsPerSample') !== 8) throw new Unsupported('標本の関数が8ビットでないので、測れない');
        let data: Uint8Array | null;
        try {
          data = await readStream(f);
        } catch {
          throw new Unsupported('標本の関数が壊れていて読めない');
        }
        if (!data) throw new Unsupported('標本の関数が対応していない圧縮なので、測れない');
        // 標本のあいだは線形の補間なので、全部の標本が上限以下なら途中も上限以下
        const stat = clampPixels(data, data.length & ~3, cap, 0);
        if (stat.changed > 0) {
          if (!(fn instanceof PDFRef)) throw new Unsupported('標本の関数の参照が分からないので、測れない');
          await replaceStream(doc, fn, data);
          acc.changed = true;
        }
        const b = pct8(stat.before);
        const a = pct8(stat.after);
        if (b > acc.before) acc.before = b;
        if (a > acc.after) acc.after = a;
        if (stat.cmy) acc.cmy = true;
        return;
      }
      default:
        throw new Unsupported('計算式の関数なので、測れない');
    }
  }

  // ── 描く命令 ──
  const skipped: string[] = [];
  const holders = await contentHolders(doc, skipped);
  for (const s of skipped) unhandled.push(`${s}。読めないので、インクの量は測れない`);
  for (const h of holders) await processContent(h);

  async function processContent(h: ContentHolder): Promise<void> {
    const bytes = h.bytes;
    const csResObj = h.resources?.lookup(N_CS);
    const csRes = csResObj instanceof PDFDict ? csResObj : null;
    const cache = new Map<string, Space>();
    const byName = (name: string): Space => {
      let sp = cache.get(name);
      if (!sp) {
        sp = classify(ctx, PDFName.of(name), csRes);
        cache.set(name, sp);
      }
      return sp;
    };
    interface GState {
      fill: Space | null;
      stroke: Space | null;
    }
    // ページの最初は DeviceGray。Form などは持ち主の状態を引き継ぐので分からない(null)
    const gray: Space = { kind: 'gray' };
    let st: GState = h.kind === 'page' ? { fill: gray, stroke: gray } : { fill: null, stroke: null };
    const stack: GState[] = [];
    let warnedSpot = false;
    let warnedInherit = false;
    let warnedBI = false;
    const warn = (why: string) => unhandled.push(`${h.label}（${why}）`);
    const text = (t: { start: number; end: number }) => String.fromCharCode.apply(null, bytes.subarray(t.start, t.end) as unknown as number[]);

    /** 4つの色の数を持つ命令の、数の位置。c m y k を測り、上限を超えていれば書き換えの文を返す */
    const colorOp = (o: Operation, first: number, tail: string): string | null => {
      const t = o.operands;
      const c = clamp01(t[first].num as number);
      const m = clamp01(t[first + 1].num as number);
      const y = clamp01(t[first + 2].num as number);
      const k = clamp01(t[first + 3].num as number);
      const before = (c + m + y + k) * 100;
      if (measureOnly || !isOver(c, m, y, k, limit)) {
        seen(before, before);
        return null;
      }
      const r = clampCmyk(c, m, y, k, limit);
      const nc = floor5(r[0]);
      const nm = floor5(r[1]);
      const ny = floor5(r[2]);
      seen(before, (nc + nm + ny + k) * 100);
      nOps++;
      // K は元の書き方のまま(書き直すと、桁の丸めで合計がわずかに増えることがある)
      return `${pdfNum(nc)} ${pdfNum(nm)} ${pdfNum(ny)} ${text(t[first + 3])}${tail} ${o.op}`;
    };
    const numbers = (t: Operation['operands'], n: number, from = 0): boolean => {
      if (t.length < from + n) return false;
      for (let i = from; i < from + n; i++) if (t[i].type !== 'number') return false;
      return true;
    };

    const out = rewriteOperations(bytes, (o): string | null => {
      switch (o.op) {
        case 'q':
          stack.push({ ...st });
          return null;
        case 'Q': {
          const s = stack.pop();
          if (s) st = s;
          return null;
        }
        case 'k':
        case 'K': {
          const cmyk: Space = { kind: 'cmyk' };
          if (o.op === 'k') st.fill = cmyk;
          else st.stroke = cmyk;
          if (o.operands.length !== 4 || !numbers(o.operands, 4)) return null;
          return colorOp(o, 0, '');
        }
        case 'g':
        case 'rg':
          st.fill = o.op === 'g' ? gray : { kind: 'rgb' };
          return null;
        case 'G':
        case 'RG':
          st.stroke = o.op === 'G' ? gray : { kind: 'rgb' };
          return null;
        case 'cs':
        case 'CS': {
          const n = o.operands[0];
          const sp: Space = n && n.type === 'name' ? byName(n.text as string) : { kind: 'unknown' };
          // パターンの下地が特色(`[/Pattern [/Separation …]]`)のときも同じ。色は下地の色空間の数で決まるので、インクは測れない
          // (これを見ないと、実インク 400% の色が、何の知らせも無く通った。2026-10-01 の指摘 A3)
          if ((sp.kind === 'spot' || (sp.kind === 'pattern' && sp.base?.kind === 'spot')) && !warnedSpot) {
            warnedSpot = true;
            warn('特色の色空間を使っているので、その色のインクは測れない');
          }
          if (o.op === 'cs') st.fill = sp;
          else st.stroke = sp;
          return null;
        }
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const cur = o.op === 'sc' || o.op === 'scn' ? st.fill : st.stroke;
          const t = o.operands;
          if (cur === null || cur.kind === 'unknown') {
            // 色空間を持ち主から引き継いでいる。4つの数がインクなのか特色なのか分からない
            if (numbers(t, 4) && t.length === 4 && !warnedInherit) {
              warnedInherit = true;
              warn('色空間を引き継いだまま4つの数で色を指定しているので、測れない');
            }
            return null;
          }
          if (cur.kind === 'cmyk' && t.length === 4 && numbers(t, 4)) return colorOp(o, 0, '');
          if (cur.kind === 'pattern' && cur.base?.kind === 'cmyk' && t.length === 5 && numbers(t, 4) && t[4].type === 'name') {
            return colorOp(o, 0, ` ${text(t[4])}`);
          }
          return null;
        }
        case 'BI': {
          const names = o.operands.filter((x) => x.type === 'name').map((x) => x.text as string);
          const cmykInline = names.some((n) => n === 'CMYK' || n === 'DeviceCMYK' || (csRes?.has(PDFName.of(n)) && classify(ctx, PDFName.of(n), csRes).kind === 'cmyk'));
          if (cmykInline && !warnedBI) {
            warnedBI = true;
            warn('CMYK のインライン画像があるので、中は測れない');
          }
          return null;
        }
        default:
          return null;
      }
    });
    if (out.changed > 0) await h.write(out.bytes);
  }

  return { limit, maxBefore, maxAfter, images: nImages, ops: nOps, shadings: nShadings, unhandled, facts };
}

/** 辞書とその中に直に入っている辞書・配列の中の辞書を、全部たどる(参照は追わない。参照の先は別のオブジェクトとして来る) */
function walkDicts(root: PDFDict, fn: (d: PDFDict, isRoot: boolean) => void): void {
  const visit = (v: PDFObject | undefined, isRoot: boolean): void => {
    if (v instanceof PDFDict) {
      fn(v, isRoot);
      for (const [, x] of v.entries()) if (x instanceof PDFDict || x instanceof PDFArray) visit(x, false);
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) {
        const x = v.get(i);
        if (x instanceof PDFDict || x instanceof PDFArray) visit(x, false);
      }
    }
  };
  visit(root, true);
}

function hexOf(bytes: Uint8Array): PDFHexString {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return PDFHexString.of(s);
}
