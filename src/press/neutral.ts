// カラーの本の本文を CMYK にする前の下ごしらえ: 無彩色(R=G=B)の RGB を、DeviceGray に書き換える。
//
// 背景: Chrome の本文 PDF は黒い字も `0 0 0 rg`(RGB)で描く。そのまま Ghostscript で ICC 変換すると、
// 黒が4色の黒(C89 M87 Y82 K78)になり、文字だけのページまで「カラー」と数えられて印刷代が上がり、字の縁もにじむ
// (2026-09-27 の試作)。Ghostscript は `-dDeviceGrayToK=true` でグレーを K 版だけに入れるので、
// 渡す**前**に、無彩色の指定をグレーにしておく。**色のあるもの(青い見出しなど)には触らない**
// (`-dBlackText` は色文字まで黒にするので使えない)。
//
// 書き換える場所は3つ:
//   1. 描く命令の色(rg / RG と、cs で RGB にしたあとの sc / scn)
//   2. 影の指定(Shading)。Chrome は全ページに「紙の地」の白い影を敷く。黒ベタの影もある。
//      Ghostscript はこれを、RGB のまま ICC で変換するので、影が無彩色でも C・M・Y が乗りうる
//   3. 画像(R=G=B の画素だけでできた RGB の画像は、1成分のグレーの画像にする)
//
// **調べられないものは、触らずに skipped に入れる。** 黙って落とすと「無彩色にした」つもりになる。
// Node 24 でそのまま動く書き方にしてある(scripts/press/neutral.test.ts が node で回す)。
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import { contentHolders, forEachOperation, pdfNum, readStream, replaceStream, rewriteOperations } from './content.ts';
import type { ContentHolder, Operation } from './content.ts';
import type { NeutralReport } from './types.ts';

export interface NeutralDeps {
  /**
   * JPEG などをほどいて画素にする道具（ブラウザの Worker では createImageBitmap で作る。Node の検査では渡さない）。
   * 渡されなければ、DCTDecode の画像は調べずに skipped に入れる
   */
  decodeImage?: (bytes: Uint8Array, filter: string) => Promise<{ width: number; height: number; rgba: Uint8Array } | null>;
}

/**
 * 「同じ」と見る差。0.0005 は 8ビットの 1段(0.0039)の8分の1。
 * Skia が小数5桁で書く数(0.6 を 0.6 と 0.60001 で書く揺れ)を、同じ灰として扱うため
 */
const SAME = 0.0005;

const N = (s: string) => PDFName.of(s);
const DEVICE_GRAY = N('DeviceGray');

// ───────────────────────── 小さな道具 ─────────────────────────

function asDict(v: unknown): PDFDict | null {
  return v instanceof PDFDict ? v : null;
}

function numOf(v: unknown): number | null {
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** 数だけの配列を読む。数以外が混じっていたら null */
function numArray(v: unknown): number[] | null {
  if (!(v instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) {
    const n = numOf(v.lookup(i));
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

const isNeutral3 = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) < SAME;

type CsKind = 'rgb' | 'icc3' | 'cal' | 'gray' | 'cmyk' | 'pattern' | 'patternRgb' | 'indexedRgb' | 'other';

/**
 * 色空間(名前・配列・参照)が、どの種類か。
 * 'rgb' は DeviceRGB、'icc3' は ICCBased で成分3、'cal' は CalRGB。'indexedRgb' は元が上の3つのどれかの Indexed。
 * 'patternRgb' は色なしのタイルのパターンの下地が RGB のもの(`[/Pattern /DeviceRGB]`)
 */
function csKind(cs: unknown, depth = 0): CsKind {
  if (cs instanceof PDFName) {
    switch (cs.decodeText()) {
      case 'DeviceRGB':
      case 'RGB':
        return 'rgb';
      case 'DeviceGray':
      case 'G':
        return 'gray';
      case 'DeviceCMYK':
      case 'CMYK':
        return 'cmyk';
      case 'Pattern':
        return 'pattern';
    }
    return 'other';
  }
  if (!(cs instanceof PDFArray) || cs.size() === 0 || depth > 4) return 'other';
  const head = cs.lookup(0);
  if (!(head instanceof PDFName)) return 'other';
  switch (head.decodeText()) {
    case 'ICCBased': {
      const icc = cs.lookup(1);
      const n = icc instanceof PDFStream ? numOf(icc.dict.lookup(N('N'))) : null;
      return n === 3 ? 'icc3' : 'other';
    }
    case 'CalRGB':
      return 'cal';
    case 'Pattern': {
      if (cs.size() < 2) return 'pattern';
      const base = csKind(cs.lookup(1), depth + 1);
      return base === 'rgb' || base === 'icc3' || base === 'cal' || base === 'indexedRgb' ? 'patternRgb' : 'pattern';
    }
    case 'Indexed':
    case 'I': {
      const base = csKind(cs.lookup(1), depth + 1);
      return base === 'rgb' || base === 'icc3' || base === 'cal' ? 'indexedRgb' : 'other';
    }
  }
  return 'other';
}

const isRgbLike = (k: CsKind) => k === 'rgb' || k === 'icc3' || k === 'cal';

// ───────────────────────── 1. 描く命令 ─────────────────────────

/** 描く命令を読み進めるときの、いまの塗り・線の色空間 */
interface CsState {
  /** unknown = 呼び出し元から引き継ぐ(フォームなど)ので、何だか分からない */
  k: 'gray' | 'rgb' | 'icc' | 'other' | 'unknown';
  /** cs の命令の通し番号(同じ cs のもとで使われた sc をまとめて決めるため)。cs を経ていなければ -1 */
  id: number;
  name?: string;
  /** cs のあとに sc / scn で色を決めたか。決めていなければ、その色空間の最初の色(RGB は黒)のまま */
  set?: boolean;
}

/** 色を決める命令。sc / scn は RGB の色空間のもとで3つの数を指定したもの。cs は、色空間を RGB にした命令そのもの */
interface ColorUse {
  /** 'set' = rg / sc / scn、'cs' = cs / CS(RGB の色空間にする命令) */
  what: 'set' | 'cs';
  stroke: boolean;
  vals: [number, number, number];
  /** rg / RG は -1。sc / scn / cs は cs の通し番号 */
  group: number;
  device: boolean;
  name?: string;
}

/** 塗る命令。cs だけ言って sc を言わないまま塗ると、その色空間の最初の色(RGB は黒)で塗られる */
const PAINT_FILL = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'Tj', 'TJ', "'", '"', 'Do']);
const PAINT_STROKE = new Set(['S', 's', 'B', 'B*', 'b', 'b*', 'Tj', 'TJ', "'", '"', 'Do']);

/**
 * 描く命令を1つずつ読んで、いまの色空間を追いかける。**同じ道具を2回の走査(数える・書き換える)で使う**ので、
 * 通し番号が一致する。q / Q で色空間が戻ることも追う(戻らないと、Q の後ろの sc を取り違える)。
 *
 * 読みながら、書き換えの前に決めておくことも集める:
 *   - inherits: 色空間を引き継いだまま、数で色を指定した(Form が親の色空間を前提にしている。2026-10-01 の指摘 A1)
 *   - doNames: `Do` している名前(上の Form を呼ぶ側をたどるため)
 *   - patternRgb: 下地が RGB のパターンの色空間を使った名前(書き換えられないので知らせる)
 * onImplicit は、数える回だけ渡す(cs だけ言って塗った所を、黒の指定として数える)
 */
function makeTracker(resources: PDFDict | null, startsGray: boolean, onImplicit?: (u: ColorUse) => void) {
  const start = (): CsState => (startsGray ? { k: 'gray', id: -1 } : { k: 'unknown', id: -1 });
  let fill = start();
  let stroke = start();
  const stack: Array<[CsState, CsState]> = [];
  let csCount = 0;
  const csDict = resources ? asDict(resources.lookup(N('ColorSpace'))) : null;
  let inlineRgb = 0;
  let inherits = false;
  const doNames: string[] = [];
  const patternRgb = new Set<string>();

  const resolve = (name: string): CsState => {
    const id = csCount++;
    const found = csDict ? csDict.lookup(N(name)) : undefined;
    const k = csKind(found ?? N(name));
    if (k === 'rgb') return { k: 'rgb', id, name };
    if (k === 'icc3' || k === 'cal') return { k: 'icc', id, name };
    if (k === 'gray') return { k: 'gray', id };
    if (k === 'patternRgb') patternRgb.add(name);
    return { k: 'other', id };
  };

  const step = (o: Operation): ColorUse | null => {
    const ops = o.operands;
    switch (o.op) {
      case 'q':
        stack.push([fill, stroke]);
        return null;
      case 'Q': {
        const top = stack.pop();
        if (top) [fill, stroke] = top;
        return null;
      }
      case 'g':
        fill = { k: 'gray', id: -1 };
        return null;
      case 'G':
        stroke = { k: 'gray', id: -1 };
        return null;
      case 'k':
        fill = { k: 'other', id: -1 };
        return null;
      case 'K':
        stroke = { k: 'other', id: -1 };
        return null;
      case 'cs':
      case 'CS': {
        const name = ops.length === 1 && ops[0].type === 'name' ? (ops[0].text as string) : null;
        const st: CsState = name === null ? { k: 'other', id: csCount++ } : resolve(name);
        const isStroke = o.op === 'CS';
        if (isStroke) stroke = st;
        else fill = st;
        if (st.k === 'rgb' || st.k === 'icc') return { what: 'cs', stroke: isStroke, vals: [0, 0, 0], group: st.id, device: st.k === 'rgb', name: st.name };
        return null;
      }
      case 'rg':
      case 'RG': {
        const isStroke = o.op === 'RG';
        if (isStroke) stroke = { k: 'rgb', id: -1 };
        else fill = { k: 'rgb', id: -1 };
        if (ops.length === 3 && ops.every((t) => t.type === 'number'))
          return { what: 'set', stroke: isStroke, vals: [ops[0].num as number, ops[1].num as number, ops[2].num as number], group: -1, device: true };
        return null;
      }
      case 'sc':
      case 'scn':
      case 'SC':
      case 'SCN': {
        const isStroke = o.op === 'SC' || o.op === 'SCN';
        const st = isStroke ? stroke : fill;
        // 色空間を持ち主から引き継いでいるのに、数で色を指定している: その数が何の色空間のものかは、呼ぶ側しだい
        if (st.k === 'unknown' && ops.some((t) => t.type === 'number')) inherits = true;
        if (st.id >= 0 && !st.set) {
          if (isStroke) stroke = { ...st, set: true };
          else fill = { ...st, set: true };
        }
        // パターンの scn は名前を持つ。数が3つだけのときだけ RGB の色の指定
        if ((st.k !== 'rgb' && st.k !== 'icc') || st.id < 0) return null;
        if (ops.length !== 3 || !ops.every((t) => t.type === 'number')) return null;
        return {
          what: 'set',
          stroke: isStroke,
          vals: [ops[0].num as number, ops[1].num as number, ops[2].num as number],
          group: st.id,
          device: st.k === 'rgb',
          name: st.name,
        };
      }
      case 'BI': {
        // インライン画像の色空間(/CS /RGB)。画素は書き換えない(Chrome の PDF には無い)ので、数だけ残す
        const d = o.operands;
        for (let i = 0; i + 1 < d.length; i++) {
          const key = d[i];
          if (key.type === 'name' && (key.text === 'CS' || key.text === 'ColorSpace') && d[i + 1].type === 'name') {
            const v = d[i + 1].text;
            if (v === 'RGB' || v === 'DeviceRGB') inlineRgb++;
          }
        }
        return null;
      }
      case 'Do':
        if (ops.length === 1 && ops[0].type === 'name') doNames.push(ops[0].text as string);
        break;
    }
    // 塗る命令: cs を言っただけで sc が無いと、その色空間の最初の色(RGB なら黒)で塗られる(指摘 B6)。
    // 数えるときは、これを「黒の指定が1つ」と数える。書き換えるときは、その cs ごと `0 g` にする
    if (onImplicit) {
      if (PAINT_FILL.has(o.op) && (fill.k === 'rgb' || fill.k === 'icc') && fill.id >= 0 && !fill.set) {
        onImplicit({ what: 'set', stroke: false, vals: [0, 0, 0], group: fill.id, device: fill.k === 'rgb', name: fill.name });
        fill = { ...fill, set: true };
      }
      if (PAINT_STROKE.has(o.op) && (stroke.k === 'rgb' || stroke.k === 'icc') && stroke.id >= 0 && !stroke.set) {
        onImplicit({ what: 'set', stroke: true, vals: [0, 0, 0], group: stroke.id, device: stroke.k === 'rgb', name: stroke.name });
        stroke = { ...stroke, set: true };
      }
    }
    return null;
  };
  return { step, inlineRgb: () => inlineRgb, inherits: () => inherits, doNames, patternRgb };
}

const fmt = (v: number[]) => v.map(pdfNum).join(' ');
/** 無彩色の色は、3つの平均を1つの灰にする(完全に等しいときは元の数のまま) */
const grayOf = (v: [number, number, number]) => (v[0] === v[1] && v[1] === v[2] ? v[0] : (v[0] + v[1] + v[2]) / 3);

/** 1つの cs のもとで決めた色(同じ cs の下の sc / scn をまとめて決める) */
interface Group {
  neutral: number;
  colored: number;
  device: boolean;
  name?: string;
  /** cs のあと sc を言わずに塗った(最初の色の黒で塗った)。無彩色(黒)として数える */
  implicit: boolean;
}

async function neutralizeOps(doc: PDFDocument, report: NeutralReport, skipped: Set<string>, opsSkipped: Set<string>): Promise<void> {
  // 描く命令を書き換えられなかったものは、skipped と opsSkipped の両方に入れる(pipeline が利用者に知らせる。文の中身で見分けない)
  const skipOps = (msg: string) => {
    skipped.add(msg);
    opsSkipped.add(msg);
  };
  const holderSkips: string[] = [];
  const holders = await contentHolders(doc, holderSkips);
  for (const s of holderSkips) skipOps(`描く命令 ${s}`);

  // 1回目: すべての持ち主を読んで、sc / scn を cs ごとにまとめて数える(無彩色が何個・色つきが何個)。
  // あわせて、親の色空間を前提にした Form と、その Form を呼ぶ側を洗い出す(書き換える前に、全体を見る必要がある)
  const info = new Map<ContentHolder, { groups: Map<number, Group>; inherits: boolean; doNames: string[] }>();
  for (const h of holders) {
    const groups = new Map<number, Group>();
    const slot = (u: ColorUse): Group => {
      let g = groups.get(u.group);
      if (!g) groups.set(u.group, (g = { neutral: 0, colored: 0, device: u.device, name: u.name, implicit: false }));
      return g;
    };
    const t1 = makeTracker(h.resources, h.kind === 'page', (u) => {
      const g = slot(u);
      g.neutral++;
      g.implicit = true;
    });
    forEachOperation(h.bytes, (o) => {
      const u = t1.step(o);
      if (u && u.what === 'set' && u.group >= 0) {
        const g = slot(u);
        if (isNeutral3(...u.vals)) g.neutral++;
        else g.colored++;
      }
    });
    if (t1.inlineRgb() > 0) skipOps(`${h.label} のインライン画像 ${t1.inlineRgb()} 個（RGB の画素は書き換えない）`);
    for (const n of t1.patternRgb) skipOps(`${h.label} の色空間 /${n}（色なしのタイルのパターンの下地が RGB なので、書き換えていない）`);
    // ICCBased・CalRGB の色空間は、色つきが1つでも混じっていたら、そのグループには触らない
    // (無彩色だけ `x g` にすると色空間が切り替わり、後ろの色つきの sc が3つの数を渡す相手を失う)
    for (const [, g] of groups) {
      if (!g.device && g.colored > 0 && g.neutral > 0)
        skipOps(`${h.label} の色空間 /${g.name ?? '?'}（ICC 付きの RGB に色つきと無彩色が混じっているので触らない）`);
    }
    info.set(h, { groups, inherits: t1.inherits(), doNames: t1.doNames });
  }

  // 親の色空間を前提にした Form(自分では cs を言わずに、数だけで色を指定する)があるとき、
  // 親の `rg` / `sc` をグレーに書き換えると、Form が継ぐ色空間が変わって色が化ける
  // (再現: 親 `/DeviceRGB cs 0.5 0.5 0.5 sc /Fm1 Do`・Form `1 0 0 sc … f` が、親を g にすると赤が白に描かれた)。
  // Chrome の PDF には無い形だが、利用者がほかの道具の PDF を選ぶことがある。
  // **その Form と、呼ぶ側(入れ子の上もすべて)は、書き換えずに skipped へ**
  const byRef = new Map<string, ContentHolder>();
  for (const h of holders) if (h.ref) byRef.set(h.ref.toString(), h);
  const parents = new Map<ContentHolder, ContentHolder[]>();
  for (const p of holders) {
    const xobj = p.resources?.lookup(N('XObject'));
    if (!(xobj instanceof PDFDict)) continue;
    for (const name of info.get(p)?.doNames ?? []) {
      const r = xobj.get(N(name));
      const child = r instanceof PDFRef ? byRef.get(r.toString()) : undefined;
      if (!child) continue;
      const list = parents.get(child);
      if (list) list.push(p);
      else parents.set(child, [p]);
    }
  }
  const tainted = new Map<ContentHolder, string>();
  const queue: ContentHolder[] = [];
  for (const h of holders) {
    if (!info.get(h)?.inherits) continue;
    tainted.set(h, `${h.label}（色空間を親から引き継いだまま数で色を指定しているので、色の書き換えをしなかった）`);
    queue.push(h);
  }
  for (let q = 0; q < queue.length; q++) {
    const child = queue[q];
    for (const p of parents.get(child) ?? []) {
      if (tainted.has(p)) continue;
      tainted.set(p, `${p.label}（色空間を引き継ぐ ${child.label} を呼んでいるので、色の書き換えをしなかった）`);
      queue.push(p);
    }
  }
  for (const msg of tainted.values()) skipOps(msg);

  // 2回目: 書き換える
  for (const h of holders) {
    if (tainted.has(h)) continue;
    const groups = (info.get(h) as { groups: Map<number, Group> }).groups;
    const t2 = makeTracker(h.resources, h.kind === 'page');
    const r = rewriteOperations(h.bytes, (o) => {
      const u = t2.step(o);
      if (!u) return null;
      if (u.what === 'cs') {
        // cs だけ言って sc の無いまま塗る色空間は、最初の色(黒)を、cs ごと `0 g` にして無彩色にそろえる。
        // ICC 付きに色つきが混じるグループは、上で「触らない」と決めたので触らない
        const g = groups.get(u.group);
        if (!g || !g.implicit) return null;
        if (!g.device && g.colored > 0) return null;
        return u.stroke ? '0 G' : '0 g';
      }
      const neutral = isNeutral3(...u.vals);
      if (u.group < 0) return neutral ? `${pdfNum(grayOf(u.vals))} ${u.stroke ? 'G' : 'g'}` : null;
      const g = groups.get(u.group);
      if (!g) return null;
      if (u.device) {
        // DeviceRGB: 無彩色が1つでも在れば、このグループの sc は全部「色空間ごと指定する命令」にそろえる
        if (g.neutral === 0) return null;
        if (neutral) return `${pdfNum(grayOf(u.vals))} ${u.stroke ? 'G' : 'g'}`;
        return `${fmt(u.vals)} ${u.stroke ? 'RG' : 'rg'}`;
      }
      if (g.colored > 0 || !neutral) return null;
      return `${pdfNum(grayOf(u.vals))} ${u.stroke ? 'G' : 'g'}`;
    });
    if (r.changed > 0) {
      await h.write(r.bytes);
      report.ops += r.changed;
    }
  }
}

// ───────────────────────── 2. 影の指定(Shading) ─────────────────────────

/** 関数の変換。直したあとの関数(新しいオブジェクト)を返す。直せなければ null と、その理由 */
interface FnResult {
  fn: PDFObject | null;
  why?: string;
}

interface ShadingCtx {
  doc: PDFDocument;
  /** 古い関数の参照 → 作り直した関数の参照(同じ関数を使う影の指定が、作り直したものを共有する) */
  converted: Map<string, PDFObject>;
  /** 作り直したので、ほかから使われなくなったかもしれない古い関数の参照 */
  replaced: PDFRef[];
}

/**
 * 関数を、3出力の無彩色から1出力に作り直す。**元の関数は書き換えず、新しいものを作る。**
 * 同じ関数を、色つきの影と無彩色の影が共有していても、色つきの側は元のまま残る。
 * 使われなくなった元の関数は、あとでまとめて捨てる
 */
async function convertFunction(sc: ShadingCtx, fnObj: PDFObject | undefined, depth = 0): Promise<FnResult> {
  const ctx = sc.doc.context;
  if (fnObj instanceof PDFRef) {
    const key = fnObj.toString();
    const cached = sc.converted.get(key);
    if (cached) return { fn: cached };
    const r = await convertFunction(sc, ctx.lookup(fnObj), depth);
    if (!r.fn) return r;
    // 新しいものも、元と同じく間接オブジェクトにする(元が参照で持たれていたので、共有の形を保つ)
    const ref = r.fn instanceof PDFRef ? r.fn : ctx.register(r.fn);
    sc.converted.set(key, ref);
    sc.replaced.push(fnObj);
    return { fn: ref };
  }
  if (depth > 8) return { fn: null, why: '関数が深く入れ子になっている' };
  const dict = fnObj instanceof PDFStream ? fnObj.dict : asDict(fnObj);
  if (!dict) return { fn: null, why: '関数を読めない' };
  const type = numOf(dict.lookup(N('FunctionType')));

  // Range は3出力ぶん(最小・最大の組が3つ)。**3つの組が同じときだけ**1出力の組にできる
  // (組が違うと、成分ごとに頭打ちが違う。先頭の組だけ残すと、たとえば緑の頭打ちが消える。2026-10-01 の指摘 B7)
  const oneRange = (): number[] | null | 'none' | 'differs' => {
    const r = numArray(dict.lookup(N('Range')));
    if (!dict.get(N('Range'))) return 'none';
    if (!r || r.length !== 6) return null;
    if (r[0] !== r[2] || r[0] !== r[4] || r[1] !== r[3] || r[1] !== r[5]) return 'differs';
    return [r[0], r[1]];
  };

  if (type === 2) {
    const c0 = dict.get(N('C0')) ? numArray(dict.lookup(N('C0'))) : [0, 0, 0];
    const c1 = dict.get(N('C1')) ? numArray(dict.lookup(N('C1'))) : [1, 1, 1];
    if (!c0 || !c1 || c0.length !== 3 || c1.length !== 3) return { fn: null, why: '色が3成分ではない関数' };
    if (!isNeutral3(c0[0], c0[1], c0[2]) || !isNeutral3(c1[0], c1[1], c1[2])) return { fn: null, why: '色つきの関数' };
    const range = oneRange();
    if (range === null) return { fn: null, why: 'Range が3成分ではない' };
    if (range === 'differs') return { fn: null, why: 'Range が成分ごとに違う' };
    const out = dict.clone(ctx);
    out.set(N('C0'), ctx.obj([grayOf([c0[0], c0[1], c0[2]])]));
    out.set(N('C1'), ctx.obj([grayOf([c1[0], c1[1], c1[2]])]));
    if (range === 'none') out.delete(N('Range'));
    else out.set(N('Range'), ctx.obj(range));
    return { fn: out };
  }

  if (type === 3) {
    const fns = dict.lookup(N('Functions'));
    if (!(fns instanceof PDFArray)) return { fn: null, why: 'つなぎの関数の Functions を読めない' };
    const items: PDFObject[] = [];
    for (let i = 0; i < fns.size(); i++) {
      const r = await convertFunction(sc, fns.get(i), depth + 1);
      if (!r.fn) return r;
      items.push(r.fn);
    }
    const range = oneRange();
    if (range === null) return { fn: null, why: 'Range が3成分ではない' };
    if (range === 'differs') return { fn: null, why: 'Range が成分ごとに違う' };
    const out = dict.clone(ctx);
    out.set(N('Functions'), ctx.obj(items));
    if (range === 'none') out.delete(N('Range'));
    else out.set(N('Range'), ctx.obj(range));
    return { fn: out };
  }

  if (type === 0 && fnObj instanceof PDFRawStream) {
    const size = numArray(dict.lookup(N('Size')));
    const bps = numOf(dict.lookup(N('BitsPerSample')));
    const range = numArray(dict.lookup(N('Range')));
    if (!size || size.length === 0 || bps !== 8 || !range || range.length !== 6) return { fn: null, why: '8ビット・3出力の標本ではない' };
    if (range[0] !== range[2] || range[0] !== range[4] || range[1] !== range[3] || range[1] !== range[5]) return { fn: null, why: 'Range が成分ごとに違う' };
    const decode = dict.get(N('Decode')) ? numArray(dict.lookup(N('Decode'))) : range;
    if (!decode || decode.length !== 6) return { fn: null, why: 'Decode を読めない' };
    // 3出力で Decode が揃っていないと、同じ標本の値でも出力が同じにならない
    if (decode[0] !== decode[2] || decode[0] !== decode[4] || decode[1] !== decode[3] || decode[1] !== decode[5])
      return { fn: null, why: '出力ごとに Decode が違う' };
    let count = 1;
    for (const s of size) count *= s;
    if (!Number.isFinite(count) || count <= 0 || count > 64_000_000) return { fn: null, why: '標本が多すぎる' };
    let data: Uint8Array | null;
    try {
      data = await readStream(fnObj);
    } catch {
      return { fn: null, why: '標本の中身が壊れている' };
    }
    if (!data || data.length < count * 3) return { fn: null, why: '標本を読めない' };
    const gray = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const r = data[i * 3];
      if (r !== data[i * 3 + 1] || r !== data[i * 3 + 2]) return { fn: null, why: '色つきの標本' };
      gray[i] = r;
    }
    const out = ctx.register(PDFRawStream.of(fnObj.dict.clone(ctx), new Uint8Array(0)));
    await replaceStream(sc.doc, out, gray, { set: { Range: ctx.obj([range[0], range[1]]) } });
    if (dict.get(N('Decode'))) (ctx.lookup(out) as PDFStream).dict.set(N('Decode'), ctx.obj([decode[0], decode[1]]));
    return { fn: out };
  }

  if (type === 4) return { fn: null, why: '計算式なので調べられない' };
  return { fn: null, why: '対応していない種類の関数' };
}

/** 文書の中の影の指定(ShadingType を持つ辞書)を、直に持たれているものも含めて全部集める */
function collectShadings(doc: PDFDocument): Array<{ dict: PDFDict; isStream: boolean; label: string }> {
  const out: Array<{ dict: PDFDict; isStream: boolean; label: string }> = [];
  const seen = new Set<PDFDict>();
  const walk = (v: unknown, owner: PDFRef, isStream: boolean, depth: number) => {
    if (depth > 12) return;
    if (v instanceof PDFDict) {
      if (seen.has(v)) return;
      seen.add(v);
      if (v.get(N('ShadingType'))) out.push({ dict: v, isStream, label: `影の指定 ${owner.toString()}` });
      for (const [, x] of v.entries()) walk(x, owner, false, depth + 1);
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) walk(v.get(i), owner, false, depth + 1);
    }
  };
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    // フォントのファイルや画像の中身は辞書だけ見れば足りる(中のバイト列は読まない)
    if (obj instanceof PDFStream) walk(obj.dict, ref, true, 0);
    else walk(obj, ref, false, 0);
  }
  return out;
}

async function neutralizeShadings(doc: PDFDocument, report: NeutralReport, skipped: Set<string>): Promise<void> {
  const ctx = doc.context;
  const sc: ShadingCtx = { doc, converted: new Map(), replaced: [] };
  for (const s of collectShadings(doc)) {
    const d = s.dict;
    const kind = csKind(d.lookup(N('ColorSpace')));
    if (!isRgbLike(kind)) continue;
    const type = numOf(d.lookup(N('ShadingType')));
    if (s.isStream || (type !== null && type >= 4)) {
      skipped.add(`${s.label}（メッシュの影なので調べられない）`);
      continue;
    }
    // 背景は、無彩色のときだけ1成分にする。色つきなら、この影は触らない
    let bg: number[] | null = null;
    if (d.get(N('Background'))) {
      bg = numArray(d.lookup(N('Background')));
      if (!bg || bg.length !== 3) {
        skipped.add(`${s.label}（背景の色を読めない）`);
        continue;
      }
      if (!isNeutral3(bg[0], bg[1], bg[2])) continue;
    }
    const fnVal = d.get(N('Function'));
    if (fnVal === undefined) continue;
    const resolved = fnVal instanceof PDFRef ? ctx.lookup(fnVal) : fnVal;
    if (resolved instanceof PDFArray) {
      skipped.add(`${s.label}（成分ごとに関数が分かれているので触らない）`);
      continue;
    }
    const r = await convertFunction(sc, fnVal);
    if (!r.fn) {
      // 色つきの影は、直せなくて当たり前なので数えない。「調べられなかった」ものだけ知らせる
      if (r.why && r.why !== '色つきの関数' && r.why !== '色つきの標本') skipped.add(`${s.label}（${r.why}）`);
      continue;
    }
    d.set(N('Function'), r.fn);
    d.set(N('ColorSpace'), DEVICE_GRAY);
    if (bg) d.set(N('Background'), ctx.obj([grayOf([bg[0], bg[1], bg[2]])]));
    report.shadings++;
  }

  // 作り直したので使われなくなった古い関数を捨てる。**ほかの影(色つき)が使っているものは残る**
  if (sc.replaced.length === 0) return;
  const users = new Map<string, Set<string>>();
  const note = (v: unknown, owner: string, depth: number) => {
    if (depth > 12) return;
    if (v instanceof PDFRef) {
      const k = v.toString();
      let set = users.get(k);
      if (!set) users.set(k, (set = new Set()));
      set.add(owner);
    } else if (v instanceof PDFDict) for (const [, x] of v.entries()) note(x, owner, depth + 1);
    else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) note(v.get(i), owner, depth + 1);
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) note(obj instanceof PDFStream ? obj.dict : obj, ref.toString(), 0);
  // 候補は、作り直した古い関数と、つなぎの関数(Type 3)の中の関数
  const candidates = new Map<string, PDFRef>();
  const addCandidate = (ref: PDFRef, depth: number) => {
    if (candidates.has(ref.toString()) || depth > 8) return;
    candidates.set(ref.toString(), ref);
    const o = ctx.lookup(ref);
    const subs = (o instanceof PDFStream ? o.dict : asDict(o))?.lookup(N('Functions'));
    if (subs instanceof PDFArray) for (let i = 0; i < subs.size(); i++) {
      const e = subs.get(i);
      if (e instanceof PDFRef) addCandidate(e, depth + 1);
    }
  };
  for (const ref of sc.replaced) addCandidate(ref, 0);
  // 親が先に落ちれば子も落ちる。誰にも使われなくなるまで、増えなくなるまで繰り返す
  const dead = new Set<string>();
  for (let progress = true; progress; ) {
    progress = false;
    for (const k of candidates.keys()) {
      if (dead.has(k)) continue;
      let live = false;
      for (const o of users.get(k) ?? []) if (o !== k && !dead.has(o)) live = true;
      if (!live) {
        dead.add(k);
        progress = true;
      }
    }
  }
  for (const k of dead) ctx.delete(candidates.get(k) as PDFRef);
}

// ───────────────────────── 3. 画像 ─────────────────────────

/** バイト列を16進の文字にする(Indexed の色の表を書き直すため) */
function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

/** Indexed の色の表(文字列かストリーム)を読む */
async function indexedTable(v: unknown): Promise<Uint8Array | null> {
  if (v instanceof PDFHexString || v instanceof PDFString) return v.asBytes();
  if (v instanceof PDFRawStream) {
    try {
      return await readStream(v);
    } catch {
      return null;
    }
  }
  return null;
}

/** /Decode が既定(0 1 の繰り返し。Indexed は 0 〜 2^bpc-1)のとき true。無ければ既定 */
function defaultDecode(dict: PDFDict, comps: number, maxVal: number): boolean {
  if (!dict.get(N('Decode'))) return true;
  const d = numArray(dict.lookup(N('Decode')));
  if (!d || d.length !== comps * 2) return false;
  for (let i = 0; i < comps; i++) if (d[i * 2] !== 0 || d[i * 2 + 1] !== maxVal) return false;
  return true;
}

async function neutralizeImages(doc: PDFDocument, report: NeutralReport, skipped: Set<string>, deps?: NeutralDeps): Promise<void> {
  const ctx = doc.context;
  // 列挙の途中で文書を書き換えるので、先に対象の参照だけ集める(画素は1枚ずつ読む)
  const targets: PDFRef[] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(N('Subtype')) === N('Image')) targets.push(ref);
  }
  for (const ref of targets) {
    const img = ctx.lookup(ref);
    if (!(img instanceof PDFRawStream)) continue;
    const dict = img.dict;
    const label = `画像 ${ref.toString()}`;
    if (String(dict.lookup(N('ImageMask'))) === 'true') continue;
    const csObj = dict.lookup(N('ColorSpace'));
    const kind = csKind(csObj);
    if (!isRgbLike(kind) && kind !== 'indexedRgb') continue;
    const bpc = numOf(dict.lookup(N('BitsPerComponent')));
    // 8ビット以外の RGB(16ビットなど)は触らない。黙って触らないと「無彩色にした」つもりになるので、理由を出す
    // (16ビットの RGB 画像は、Ghostscript が RGB のまま ICC 変換するので、無彩色でも C・M・Y が乗りうる。2026-10-01 の指摘)
    if (kind !== 'indexedRgb' && bpc !== 8) {
      skipped.add(`${label}（${bpc === null ? 'ビット数が書かれていない' : `${bpc}ビット`}の RGB なので、無彩色か調べていない）`);
      continue;
    }
    if (kind === 'indexedRgb' && (bpc === null || bpc > 8)) {
      skipped.add(`${label}（${bpc === null ? 'ビット数が書かれていない' : `${bpc}ビット`}の索引色なので、無彩色か調べていない）`);
      continue;
    }
    const w = numOf(dict.lookup(N('Width')));
    const h = numOf(dict.lookup(N('Height')));
    if (!w || !h || w <= 0 || h <= 0) continue;
    const decodeOk = kind === 'indexedRgb' ? defaultDecode(dict, 1, (1 << (bpc as number)) - 1) : defaultDecode(dict, 3, 1);
    if (!decodeOk) {
      skipped.add(`${label}（Decode が既定と違う）`);
      continue;
    }
    // 色抜き(Mask の配列)は成分3つぶんで書かれている。グレーにすると意味が変わるので触らない
    if (dict.lookup(N('Mask')) instanceof PDFArray) {
      skipped.add(`${label}（色抜きの指定がある）`);
      continue;
    }
    // 合成用マスクが Matte(RGB で書かれた下地の色)を持っていると、画像だけグレーにすると成分の数が合わなくなる
    const smask = dict.lookup(N('SMask'));
    if (smask instanceof PDFStream && smask.dict.get(N('Matte'))) {
      skipped.add(`${label}（透明のマスクが下地の色を持っている）`);
      continue;
    }
    const filter = dict.lookup(N('Filter'));
    const filterName = filter instanceof PDFName ? filter.decodeText() : filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) instanceof PDFName ? (filter.lookup(0) as PDFName).decodeText() : null;

    if (kind === 'indexedRgb') {
      const arr = csObj as PDFArray;
      const hival = numOf(arr.lookup(2));
      const table = await indexedTable(arr.lookup(3));
      if (hival === null || !table || table.length < (hival + 1) * 3) {
        skipped.add(`${label}（索引色の表を読めない）`);
        continue;
      }
      const gray = new Uint8Array(hival + 1);
      let ok = true;
      for (let i = 0; i <= hival; i++) {
        const r = table[i * 3];
        if (r !== table[i * 3 + 1] || r !== table[i * 3 + 2]) {
          ok = false;
          break;
        }
        gray[i] = r;
      }
      if (!ok) continue;
      dict.set(N('ColorSpace'), ctx.obj([N('Indexed'), DEVICE_GRAY, hival, PDFHexString.of(hex(gray))]));
      report.images++;
      continue;
    }

    let rgb: Uint8Array | null = null;
    let jpegGray: Uint8Array | null = null;
    if (filterName === 'DCTDecode' || filterName === 'DCT') {
      if (!deps?.decodeImage) {
        skipped.add(`${label}（JPEG をほどく道具がないので、無彩色か調べていない）`);
        continue;
      }
      let px: Awaited<ReturnType<NonNullable<NeutralDeps['decodeImage']>>>;
      try {
        px = await deps.decodeImage(img.contents, 'DCTDecode');
      } catch {
        px = null;
      }
      if (!px || px.width !== w || px.height !== h || px.rgba.length < w * h * 4) {
        skipped.add(`${label}（JPEG をほどけなかった）`);
        continue;
      }
      // JPEG は圧縮の誤差で R・G・B が数段ずれる。2段まで(ほとんど見えない差)は無彩色と見る
      const rgba = px.rgba;
      const out = new Uint8Array(w * h);
      let neutral = true;
      for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        const r = rgba[j];
        const g = rgba[j + 1];
        const b = rgba[j + 2];
        if (Math.abs(r - g) > 2 || Math.abs(g - b) > 2 || Math.abs(r - b) > 2) {
          neutral = false;
          break;
        }
        out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
      if (!neutral) continue;
      jpegGray = out;
    } else {
      try {
        rgb = await readStream(img, w * h * 3);
      } catch {
        skipped.add(`${label}（中身が壊れていて読めない）`);
        continue;
      }
      if (!rgb) {
        skipped.add(`${label}（対応していない圧縮）`);
        continue;
      }
      if (rgb.length < w * h * 3) {
        skipped.add(`${label}（画素の数が幅×高さに足りない）`);
        continue;
      }
      // 1画素でも色があれば、その画像は触らない。早く抜ける
      const n = w * h;
      let neutral = true;
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        if (rgb[j] !== rgb[j + 1] || rgb[j] !== rgb[j + 2]) {
          neutral = false;
          break;
        }
      }
      if (!neutral) continue;
    }

    let gray: Uint8Array;
    if (jpegGray) gray = jpegGray;
    else {
      const px = rgb as Uint8Array;
      gray = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < gray.length; i++, j += 3) gray[i] = px[j];
    }
    rgb = null;
    await replaceStream(doc, ref, gray, {
      set: { ColorSpace: DEVICE_GRAY, BitsPerComponent: PDFNumber.of(8) },
      remove: ['Decode', 'ColorTransform'],
      predict: { colors: 1, columns: w, rows: h },
    });
    report.images++;
  }
}

// ───────────────────────── 入り口 ─────────────────────────

/** doc の中の無彩色の RGB を DeviceGray に書き換える（doc を直に書き換える） */
export async function neutralize(doc: PDFDocument, deps?: NeutralDeps): Promise<NeutralReport> {
  const report: NeutralReport = { ops: 0, shadings: 0, images: 0, skipped: [], opsSkipped: [] };
  const skipped = new Set<string>();
  const opsSkipped = new Set<string>();
  // 影の指定と画像を先に直す。描く命令の書き換えは、これらと独立
  await neutralizeShadings(doc, report, skipped);
  await neutralizeImages(doc, report, skipped, deps);
  await neutralizeOps(doc, report, skipped, opsSkipped);
  report.skipped = [...skipped];
  report.opsSkipped = [...opsSkipped];
  return report;
}
