// グレーの濃さを、刷り上がりが画面と同じ明るさになるように直す。Ghostscript で K だけにしたあと(DeviceGray になったあと)に掛ける。
//
// **なぜ要るのか。** 入稿用の変換は、無彩色(黒・グレー)を K だけで刷る。PDF の決まりで、DeviceGray の値 v は
// そのまま K = 1 − v のインクの量になる(色の管理を通らない)。ところが、画面のグレー(sRGB)の v と、
// K = 1 − v で刷った明るさは同じではない。Japan Color 2011 Coated の ICC で明るさ(L*)を測ると(2026-10-01、
// reports/2-2.md の D とリーダーの測り直し):
//
//   v(画面のグレー)  画面の L*  K = 1 − v で刷った L*  差
//   0.0              0.0        18.4                    +18.4
//   0.2              21.2       44.3                    +23.1
//   0.5              53.7       68.2                    +14.5
//   0.8              82.0       87.8                    +5.9
//   1.0              100        100                     0
//
// つまり、グレーの絵(白黒の写真・イラスト)やグレーの塗りが、画面よりかなり明るく(薄く)刷られる。真ん中のグレーで L* が 14 も違う。
// 白黒の本(Ghostscript の Gray の変換のあとも、値はほぼ sRGB のグレーのまま)でも、カラーの本の中の無彩色でも同じ。
// 写真を扱う道具(Photoshop のグレースケール変換)は、ここで「ドットゲイン」ぶんを見込んで値を濃くする。スタジオもそうする。
//
// **表の決め方。** scripts/press/make-gray-tone.py が、ICC の「K だけ(C=M=Y=0)」の明るさを K 0〜255 の全段で測り(LittleCMS・相対的な色域の合わせ方)、
// 画面のグレー v の輝度 Y に「黒点の補正」をかけたものを目標にして、その明るさになる K を逆に引く:
//     Y目標 = Yk100 + (1 − Yk100) × Y画面      (Yk100 は K100% の輝度。L* 18.4 → Y 0.0262)
// K100% は印刷で出せるいちばん暗い所なので、画面の黒(L* 0)には届かない。暗い側は、そのぶんを詰める。
// 守ること: 0 → 0(文字の黒は K100% のまま。1段も変えない)・255 → 255(紙の地に点を置かない)・単調に増える・段の飛びが小さい。
// 直したあとの L* は、この目標との差が全段で ±0.4 以内(許容 ±1.5。道具が確かめる)。
// 表を作った日: 2026-10-01。作った道具: scripts/press/make-gray-tone.py(ICC を替えたときは、道具を回し直して下の定数を貼り替える)。
//
// **直す所は3つ**(全部 DeviceGray・CalGray・ICCBased の成分1つのもの):
//   1. 描く命令: `v g`・`v G`、cs で灰色の色空間にしたあとの `v sc/scn/SC/SCN`
//   2. 画像: 8ビットで Flate か圧縮なしの画素 / Indexed で元がグレーの色の表
//   3. 影(Shading): 関数の途中の明るさも表で曲がるので、Type 2・3 は 256 点の標本(Type 0)に作り直す
//
// **直してはいけないもの。** 透明のマスクの値は「透け具合」であって、インクの濃さではない。
//   - 画像の /SMask・/Mask に使われている画像、型抜き(/ImageMask true)の画像
//   - ExtGState の /SMask の /G(マスクのグループの Form)と、そこからしか届かない Form・画像・影・パターン
//   マスクとページの両方から届くものは、どちらを優先してもどちらかが狂うので、触らずに skipped に出す。
// 色のあるもの(DeviceCMYK・DeviceRGB)と、パターンの名前だけの scn にも触らない。
//
// **直せなかったものは、黙って通さず skipped に入れる**(「何の・どこが・なぜ」)。JPEG のグレー画像はほどけないので直せない
// (もとからグレーの JPEG は、Ghostscript をそのまま通ることが在る。2026-10-01 color-a5 に1枚)。
//
// **直せない限り: 半透明に重なったグレー。** 表は、重ねる前の値 1つずつにかける(描く命令・画像・影の値)。ところが表は曲がっている(凸)ので、
// 半透明(/ca・/CA が 1 未満・Luminosity などの混ぜ方・透明のマスク)で下地と混ざったあとの明るさは、表を通した値どうしの混ぜと合わない。
// 重ねたあとは、画面より少し明るい側にずれる。2026-10-01 の実測(4-1 の 2。刷り上がりの L* の、画面の目標との差):
//   黒(0 g)を /ca 0.5 で塗る   +12.9    0.5 g を /ca 0.5 で塗る   +1.5    重ねずに 0.5 g で塗る   −0.1
//   mono-bunko の章扉(背景の絵 → Luminosity で混ぜる → マスク付きで重ねる。p14〜16)  +6.5(直す前は +8.5。直したぶんは縮まっている)
//   同じ本の、重ねの無い絵のページ(p17〜31 など)  0.0〜+0.4
// 直すには、重なりを1枚の絵に統合してから表をかけるしかなく、そこまではしない(文字の黒と、重ねの無い絵は、画面と同じ明るさに直る)。
// **issues にも出さない。** 背景に白をかぶせる本はふつうに在り、毎回の知らせは雑音になるため。
//
// **2度かけると、2度濃くなる。** 直したあとの PDF かどうかは、PDF からは分からない。流れ(pipeline)が1回だけ呼ぶこと。
// (すでに入稿用に変えた PDF は、pipeline の入口が isPdfx で断るので、ここには来ない)
// Node 24 でそのまま動く書き方にしてある(scripts/press/grayTone.test.ts が node で回す)。ブラウザ専用の物は使わない。
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import { contentHolders, pdfNum, readStream, replaceStream, rewriteOperations } from './content.ts';
import type { ContentHolder, Operation } from './content.ts';
import type { GrayToneReport } from './types.ts';

/**
 * 画面のグレー(0〜255。sRGB の階調)→ 刷るときの DeviceGray の値(0〜255)の表。
 * K だけで刷ったときの明るさが、画面の明るさに合うように決めてある(黒は K100% が出せるいちばん暗い所なので、暗い側は「黒点の補正」で詰める)。
 * 代表の値: 0→0・32→9・64→26・96→51・128→86・160→123・192→166・224→211・255→255。
 * make-gray-tone.py --ts の出力そのまま(grayTone.test.ts が、道具の出力と一致することを確かめる)
 */
export const GRAY_TONE: Uint8Array = Uint8Array.from([
  0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 7, 7, 8, 8, 8, 9,
  9, 10, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16,
  17, 17, 18, 18, 19, 20, 20, 21, 21, 22, 22, 23, 24, 24, 25, 25,
  26, 27, 27, 28, 28, 29, 30, 30, 31, 32, 32, 33, 34, 35, 35, 36,
  37, 38, 39, 39, 40, 41, 42, 43, 44, 44, 45, 46, 47, 48, 49, 50,
  51, 52, 53, 54, 54, 55, 56, 58, 59, 60, 61, 62, 63, 64, 65, 66,
  67, 68, 70, 71, 72, 73, 74, 75, 76, 77, 78, 80, 81, 82, 83, 84,
  86, 87, 88, 89, 90, 91, 92, 94, 95, 96, 97, 98, 99, 100, 102, 103,
  104, 105, 106, 108, 109, 110, 111, 112, 114, 115, 116, 117, 118, 120, 121, 122,
  123, 124, 126, 127, 128, 129, 131, 132, 133, 135, 136, 137, 139, 140, 141, 143,
  144, 145, 147, 148, 149, 151, 152, 153, 155, 156, 158, 159, 160, 161, 163, 164,
  166, 167, 169, 170, 171, 173, 174, 175, 177, 178, 179, 181, 182, 184, 185, 186,
  188, 189, 190, 192, 193, 195, 196, 198, 199, 200, 202, 203, 205, 206, 208, 209,
  211, 212, 214, 215, 217, 218, 220, 221, 223, 224, 226, 227, 229, 230, 232, 233,
  234, 236, 237, 239, 240, 241, 243, 244, 245, 247, 248, 250, 251, 252, 254, 255,
]);

/**
 * 0〜1 の値を1つ直す(段と段のあいだは直線でつなぐ)。0 以下は 0、1 以上は 1(黒と白は変わらない)。
 * 検査と、ほかの部品から使えるように出す
 */
export function toneGray(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  const x = v * 255;
  const i = Math.floor(x);
  const f = x - i;
  const a = GRAY_TONE[i];
  const b = GRAY_TONE[i + 1];
  return (a + (b - a) * f) / 255;
}

const N = (s: string) => PDFName.of(s);
const N_COLORSPACE = N('ColorSpace');
const N_SUBTYPE = N('Subtype');

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

/** 色空間の種類。'gray' は DeviceGray・CalGray・ICCBased の成分1つ。Indexed と Pattern は、元(下地)がグレーのものだけ区別する */
type CsKind = 'gray' | 'indexedGray' | 'patternGray' | 'other';

function csKind(cs: unknown, depth = 0): CsKind {
  if (cs instanceof PDFName) {
    const t = cs.decodeText();
    return t === 'DeviceGray' || t === 'G' ? 'gray' : 'other';
  }
  if (!(cs instanceof PDFArray) || cs.size() === 0 || depth > 4) return 'other';
  const head = cs.lookup(0);
  if (!(head instanceof PDFName)) return 'other';
  switch (head.decodeText()) {
    case 'CalGray':
      return 'gray';
    case 'ICCBased': {
      const icc = cs.lookup(1);
      return icc instanceof PDFStream && numOf(icc.dict.lookup(N('N'))) === 1 ? 'gray' : 'other';
    }
    case 'Indexed':
    case 'I':
      return csKind(cs.lookup(1), depth + 1) === 'gray' ? 'indexedGray' : 'other';
    case 'Pattern':
      return cs.size() > 1 && csKind(cs.lookup(1), depth + 1) === 'gray' ? 'patternGray' : 'other';
  }
  return 'other';
}

/** /Decode が既定(0 1。Indexed は 0 〜 2^bpc−1)のとき true。無ければ既定 */
function defaultDecode(dict: PDFDict, maxVal: number): boolean {
  if (!dict.get(N('Decode'))) return true;
  const d = numArray(dict.lookup(N('Decode')));
  return !!d && d.length === 2 && d[0] === 0 && d[1] === maxVal;
}

/** 表を8ビットの並びに、その場で掛ける。1つでも値が変わったら true(何も変わらなければ、ストリームごと触らない) */
function toneInPlace(d: Uint8Array, n: number): boolean {
  let changed = false;
  for (let i = 0; i < n; i++) {
    const x = d[i];
    const y = GRAY_TONE[x];
    if (y !== x) {
      d[i] = y;
      changed = true;
    }
  }
  return changed;
}

function wouldChange(d: Uint8Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (GRAY_TONE[d[i]] !== d[i]) return true;
  return false;
}

function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

// ───────────────────────── 直してはいけないものを見分ける ─────────────────────────

/**
 * 文書の中のものを、「ページから届く」「マスクのグループから届く」に分ける。
 * 文書の ExtGState の /SMask の /G(Form)から届くものは、グレーの値が「透け具合」なので直さない。
 * 同じものを直に指す辞書・配列も数えるので、直接持たれている影の辞書も見分けられる(参照だけでは足りない)。
 *
 * **資源に並んでいるだけでは「使っている」と言えない。** Ghostscript は、マスクのグループの Form とその中の画像を、
 * ページの /XObject の資源にも並べる(mono-bunko の出力で確かめた。ページの命令はそれを Do しない)。
 * 並びだけで「ページからも届く」とすると、マスクを全部「両方から届く」と読んでしまうので、
 * マスクから届くものは、ページ側の命令(Do・sh・パターンの scn)が本当に呼んでいるときだけ「両方」と数える
 */
interface Reach {
  /** 文書の入り口(Catalog)から、マスクの /G を通らずに届くもの(資源に並んでいるだけのものも入る) */
  page: Set<object>;
  /** マスクの /G から届くもの */
  mask: Set<object>;
  /** ページ側の描く命令が、Do・sh・パターンの scn で本当に呼んでいるもの */
  invoked: Set<object>;
  /** 画像の /SMask・/Mask に使われている画像 */
  maskImages: Set<object>;
  /** 文書の中の全部(影の辞書を探すため) */
  all: Set<object>;
  /** ストリームの辞書(メッシュの影かどうかを見分ける) */
  streamDicts: Set<object>;
}

function walk(doc: PDFDocument, starts: unknown[], visited: Set<object>, cutG: Set<object> | null): void {
  const ctx = doc.context;
  const stack: unknown[] = [...starts];
  while (stack.length > 0) {
    let v = stack.pop();
    if (v instanceof PDFRef) v = ctx.lookup(v);
    // 名前・数などの小さなものは入れない(名前は使い回されるので、数えても意味が無い)
    if (!(v instanceof PDFStream || v instanceof PDFDict || v instanceof PDFArray) || visited.has(v)) continue;
    visited.add(v);
    if (v instanceof PDFStream) stack.push(v.dict);
    else if (v instanceof PDFDict) {
      for (const [k, x] of v.entries()) {
        if (cutG && cutG.has(v) && k.decodeText() === 'G') continue;
        stack.push(x);
      }
    } else for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
  }
}

/** 描く命令が呼んでいるもの(Do の XObject・sh の影・scn のパターン)を、ページから順にたどって集める */
function traceInvoked(doc: PDFDocument, holders: ContentHolder[]): Set<object> {
  const ctx = doc.context;
  const invoked = new Set<object>();
  const byObj = new Map<object, ContentHolder>();
  for (const h of holders) {
    if (!h.ref) continue;
    const o = ctx.lookup(h.ref);
    if (o) byObj.set(o, h);
  }
  const seen = new Set<ContentHolder>();
  const queue: Array<{ h: ContentHolder; inherited: PDFDict | null }> = [];
  for (const h of holders) if (h.kind === 'page') queue.push({ h, inherited: null });
  const named = (res: PDFDict | null, kind: string, name: string): unknown => {
    const d = res ? asDict(res.lookup(N(kind))) : null;
    return d ? d.lookup(N(name)) : undefined;
  };
  for (let qi = 0; qi < queue.length; qi++) {
    const { h, inherited } = queue[qi];
    if (seen.has(h)) continue;
    seen.add(h);
    const res = h.resources ?? inherited;
    const use = (o: unknown) => {
      if (!o || typeof o !== 'object') return;
      invoked.add(o);
      const sub = byObj.get(o);
      if (sub) queue.push({ h: sub, inherited: res });
    };
    rewriteOperations(h.bytes, (o) => {
      const ops = o.operands;
      const last = ops.length > 0 ? ops[ops.length - 1] : null;
      if (!last || last.type !== 'name') return null;
      const name = last.text as string;
      if (o.op === 'Do') use(named(res, 'XObject', name));
      else if (o.op === 'sh') use(named(res, 'Shading', name));
      else if (o.op === 'scn' || o.op === 'SCN') {
        const pat = named(res, 'Pattern', name);
        use(pat);
        // 影のパターン(PatternType 2)は、/Shading の辞書を使う
        const pd = pat instanceof PDFStream ? null : asDict(pat);
        const sh = pd ? pd.lookup(N('Shading')) : undefined;
        if (sh && typeof sh === 'object') invoked.add(sh);
      }
      return null;
    });
  }
  return invoked;
}

function computeReach(doc: PDFDocument, holders: ContentHolder[]): Reach {
  const all = new Set<object>();
  walk(doc, [doc.catalog], all, null);
  const smaskDicts = new Set<object>();
  const groups: unknown[] = [];
  const maskImages = new Set<object>();
  const streamDicts = new Set<object>();
  for (const o of all) {
    if (o instanceof PDFStream) {
      streamDicts.add(o.dict);
      if (o.dict.lookup(N_SUBTYPE) === N('Image')) {
        for (const key of ['SMask', 'Mask']) {
          const m = o.dict.lookup(N(key));
          if (m instanceof PDFStream) maskImages.add(m);
        }
      }
    } else if (o instanceof PDFDict) {
      const sm = o.lookup(N('SMask'));
      // 画像の /SMask はストリーム。ExtGState の /SMask は辞書(/S と /G を持つ)
      if (sm instanceof PDFDict) {
        smaskDicts.add(sm);
        const g = sm.get(N('G'));
        if (g) groups.push(g);
      }
    }
  }
  const page = new Set<object>();
  walk(doc, [doc.catalog], page, smaskDicts);
  const mask = new Set<object>();
  walk(doc, groups, mask, null);
  return { page, mask, invoked: traceInvoked(doc, holders), maskImages, all, streamDicts };
}

/**
 * 'touch' = ページ側のもの(直す)/ 'both' = マスクの中のもので、ページの命令も呼んでいる(触らず知らせる)/
 * 'skip' = マスクの中だけのもの・どこからも届かないもの(触らない)
 */
function scopeOf(r: Reach, o: object): 'touch' | 'both' | 'skip' {
  if (!r.mask.has(o)) return r.page.has(o) ? 'touch' : 'skip';
  return r.invoked.has(o) ? 'both' : 'skip';
}

// ───────────────────────── 1. 描く命令 ─────────────────────────

type Paint = 'gray' | 'indexedGray' | 'patternGray' | 'other' | 'unknown';

/**
 * 描く命令を読み進めて、いまの塗り・線の色空間を追いかける(q / Q で戻る)。
 * ページは、cs を指定するまで DeviceGray(初期値)。Form・パターンは、呼び出し元から引き継ぐので何だか分からない('unknown')。
 * 分からないときは触らない(CMYK の色を取り違えて直すより、触らないほうが安全)
 */
function makeTracker(resources: PDFDict | null, startsGray: boolean, note: (s: string) => void) {
  const start: Paint = startsGray ? 'gray' : 'unknown';
  let fill: Paint = start;
  let stroke: Paint = start;
  const stack: Array<[Paint, Paint]> = [];
  const csDict = resources ? asDict(resources.lookup(N_COLORSPACE)) : null;
  let inherited = false;
  let indexedNoted = false;
  let patternNoted = false;
  let inlineGray = 0;

  const resolve = (name: string): Paint => {
    if (name === 'DeviceGray' || name === 'G') return 'gray';
    if (name === 'DeviceRGB' || name === 'DeviceCMYK' || name === 'RGB' || name === 'CMYK' || name === 'Pattern') return 'other';
    const found = csDict ? csDict.lookup(N(name)) : undefined;
    return found === undefined ? 'other' : csKind(found);
  };

  const step = (o: Operation): { value: number; stroke: boolean } | null => {
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
      case 'G': {
        const isStroke = o.op === 'G';
        if (isStroke) stroke = 'gray';
        else fill = 'gray';
        if (ops.length === 1 && ops[0].type === 'number') return { value: ops[0].num as number, stroke: isStroke };
        return null;
      }
      case 'rg':
      case 'k':
        fill = 'other';
        return null;
      case 'RG':
      case 'K':
        stroke = 'other';
        return null;
      case 'cs':
      case 'CS': {
        const name = ops.length === 1 && ops[0].type === 'name' ? (ops[0].text as string) : null;
        const st: Paint = name === null ? 'other' : resolve(name);
        if (o.op === 'cs') fill = st;
        else stroke = st;
        return null;
      }
      case 'sc':
      case 'scn':
      case 'SC':
      case 'SCN': {
        const isStroke = o.op === 'SC' || o.op === 'SCN';
        const st = isStroke ? stroke : fill;
        const nums = ops.filter((t) => t.type === 'number').length;
        if (st === 'gray') {
          if (ops.length === 1 && nums === 1) return { value: ops[0].num as number, stroke: isStroke };
          return null;
        }
        if (st === 'unknown' && ops.length === 1 && nums === 1) inherited = true;
        if (st === 'indexedGray' && !indexedNoted) {
          indexedNoted = true;
          note('索引色(元がグレー)で塗っている命令');
        }
        if (st === 'patternGray' && nums > 0 && !patternNoted) {
          patternNoted = true;
          note('下地がグレーのパターンの色の指定');
        }
        return null;
      }
      case 'BI': {
        // インライン画像。画素は書き換えない(Chrome の PDF にも、Ghostscript の出力にも無い)ので、数だけ残して知らせる
        for (let i = 0; i + 1 < ops.length; i++) {
          const key = ops[i];
          if (key.type === 'name' && (key.text === 'CS' || key.text === 'ColorSpace') && ops[i + 1].type === 'name') {
            const v = ops[i + 1].text;
            if (v === 'G' || v === 'DeviceGray') inlineGray++;
          }
        }
        return null;
      }
    }
    return null;
  };
  return { step, inherited: () => inherited, inlineGray: () => inlineGray };
}

async function toneOps(doc: PDFDocument, holders: ContentHolder[], reach: Reach, report: GrayToneReport, skipped: Set<string>): Promise<void> {
  for (const h of holders) {
    // マスクのなかのもの(ページの命令が呼んでいないもの)は触らない。両方から呼ばれているものは、直す必要が在るときだけ知らせる
    let blocked = false;
    if (h.ref) {
      const obj = doc.context.lookup(h.ref);
      const sc = obj ? scopeOf(reach, obj) : 'skip';
      if (sc === 'skip') continue;
      blocked = sc === 'both';
    }
    const t = makeTracker(h.resources, h.kind === 'page', (s) => skipped.add(`${h.label} の${s}（濃さを直していない）`));
    const r = rewriteOperations(h.bytes, (o) => {
      const u = t.step(o);
      if (!u) return null;
      const v = u.value;
      // 0 と 1(黒と白)は表でも動かない。範囲の外の値は触らない
      if (!(v > 0 && v < 1)) return null;
      return `${pdfNum(toneGray(v))} ${o.op}`;
    });
    if (t.inlineGray() > 0) skipped.add(`${h.label} のグレーのインライン画像 ${t.inlineGray()} 個（画素は直していない）`);
    if (t.inherited()) skipped.add(`${h.label}（色空間を呼び出し元から引き継いで色を指定しているので、グレーか分からず直していない）`);
    if (blocked) {
      if (r.changed > 0) skipped.add(`${h.label}（透明のマスクとページの両方から使われているので、グレーの濃さを直していない）`);
      continue;
    }
    if (r.changed > 0) {
      await h.write(r.bytes);
      report.ops += r.changed;
    }
  }
}

// ───────────────────────── 2. 画像 ─────────────────────────

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

function filterNames(d: PDFDict): string[] {
  const f = d.lookup(N('Filter'));
  const list = f instanceof PDFArray ? f.asArray() : f ? [f] : [];
  const out: string[] = [];
  for (const x of list) {
    const v = d.context.lookup(x);
    if (v instanceof PDFName) out.push(v.decodeText());
  }
  return out;
}

/** マスクにも見える絵にも使われている画像を、表で直したら値が動くか(読めない・分からないときは true) */
async function maskImageMayChange(img: PDFRawStream): Promise<boolean> {
  const dict = img.dict;
  const kind = csKind(dict.lookup(N_COLORSPACE));
  const bpc = numOf(dict.lookup(N('BitsPerComponent')));
  const w = numOf(dict.lookup(N('Width')));
  const h = numOf(dict.lookup(N('Height')));
  if (kind !== 'gray' || bpc !== 8 || !w || !h || w <= 0 || h <= 0) return bpc === 1 && kind === 'gray' ? false : true;
  try {
    const data = await readStream(img, w * h);
    return !data || data.length < w * h || wouldChange(data, w * h);
  } catch {
    return true;
  }
}

async function toneImages(doc: PDFDocument, reach: Reach, report: GrayToneReport, skipped: Set<string>): Promise<void> {
  const ctx = doc.context;
  // 列挙の途中で文書を書き換えるので、先に対象の参照だけ集める(画素は1枚ずつ読む。大きな配列を持ち続けない)
  const targets: PDFRef[] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(N_SUBTYPE) === N('Image')) targets.push(ref);
  }
  for (const ref of targets) {
    const img = ctx.lookup(ref);
    if (!(img instanceof PDFRawStream)) continue;
    const dict = img.dict;
    const label = `画像 ${ref.toString()}`;
    if (String(dict.lookup(N('ImageMask'))) === 'true') continue; // 型抜き。色は描く命令の色
    if (reach.maskImages.has(img)) {
      // 透明のマスクの画像。値は「透け具合」なので直さない。ただし、見える絵としても描いている(Do している)なら、
      // 直さないぶん、その絵だけ画面より明るく刷られる。黙らずに知らせる(値が動かない画像は、知らせるまでもない。4-1 の 4)
      if (reach.invoked.has(img) && (await maskImageMayChange(img))) {
        skipped.add(`${label}（透明のマスクにも見える画像にも使われているので、グレーの濃さを直していない）`);
      }
      continue;
    }
    const csObj = dict.lookup(N_COLORSPACE);
    const kind = csKind(csObj);
    if (kind !== 'gray' && kind !== 'indexedGray') continue;
    const sc = scopeOf(reach, img);
    if (sc === 'skip') continue;
    // マスクの中の画像とページの絵を、Ghostscript が1つにまとめることが在る。直す必要が在る(値が動く)ときだけ知らせる
    const blocked = sc === 'both';
    const bpc = numOf(dict.lookup(N('BitsPerComponent')));
    const w = numOf(dict.lookup(N('Width')));
    const h = numOf(dict.lookup(N('Height')));

    if (kind === 'indexedGray') {
      const arr = csObj as PDFArray;
      const hival = numOf(arr.lookup(2));
      if (bpc === null || bpc > 8 || !defaultDecode(dict, (1 << bpc) - 1)) {
        skipped.add(`${label}（索引色の Decode が既定と違う・ビット数が合わないので、直していない）`);
        continue;
      }
      const table = await indexedTable(arr.lookup(3));
      if (hival === null || !table || table.length < hival + 1) {
        skipped.add(`${label}（索引色の表を読めないので、直していない）`);
        continue;
      }
      const gray = table.slice(0, hival + 1);
      if (!toneInPlace(gray, gray.length)) continue;
      if (blocked) {
        skipped.add(`${label}（透明のマスクとページの両方から使われているので、グレーの濃さを直していない）`);
        continue;
      }
      // 色の表は、画像のあいだで共有されることが在る。元の表は書き換えず、この画像だけ新しい表を持たせる
      dict.set(N_COLORSPACE, ctx.obj([N('Indexed'), arr.get(1), hival, PDFHexString.of(hex(gray))]));
      report.images++;
      continue;
    }

    if (bpc === 1) continue; // 白黒2値は 0 と 1 だけ。表でも動かない
    if (bpc !== 8) {
      skipped.add(`${label}（グレーの画像が 8ビットでなく${bpc ?? '不明の'}ビットなので、直していない）`);
      continue;
    }
    if (!w || !h || w <= 0 || h <= 0) continue;
    const filters = filterNames(dict);
    if (filters.some((f) => f === 'DCTDecode' || f === 'DCT')) {
      skipped.add(`${label}（JPEG のグレーの画像なので、ほどけず直していない）`);
      continue;
    }
    if (filters.some((f) => f === 'JPXDecode')) {
      skipped.add(`${label}（JPEG 2000 のグレーの画像なので、ほどけず直していない）`);
      continue;
    }
    if (!defaultDecode(dict, 1)) {
      skipped.add(`${label}（Decode が既定と違うので、直していない）`);
      continue;
    }
    // 色抜き(Mask の数の配列)は、直す前の値で書かれている。表で値が動くと、抜けるはずの画素が合わなくなる
    if (dict.lookup(N('Mask')) instanceof PDFArray) {
      skipped.add(`${label}（色抜きの指定があるので、直していない）`);
      continue;
    }
    // 合成用マスクが Matte(下地の色)を持っていると、画像だけ直すと前乗算の計算が合わなくなる
    const smask = dict.lookup(N('SMask'));
    if (smask instanceof PDFStream && smask.dict.get(N('Matte'))) {
      skipped.add(`${label}（透明のマスクが下地の色を持っているので、直していない）`);
      continue;
    }
    let data: Uint8Array | null;
    try {
      data = await readStream(img);
    } catch {
      skipped.add(`${label}（中身が壊れていて読めない）`);
      continue;
    }
    if (!data) {
      skipped.add(`${label}（対応していない圧縮なので、直していない）`);
      continue;
    }
    if (data.length < w * h) {
      skipped.add(`${label}（画素の数が幅×高さに足りないので、直していない）`);
      continue;
    }
    if (blocked) {
      // 圧縮なしのときは data が文書の中身そのものなので、書き換えずに調べる
      if (wouldChange(data, w * h)) skipped.add(`${label}（透明のマスクとページの両方から使われているので、グレーの濃さを直していない）`);
      continue;
    }
    if (!toneInPlace(data, w * h)) continue;
    // 画素は PNG の行ごとの予測を付けて詰める(付けないと、写真のようなグレーの絵が Ghostscript の出力の 2.2 倍になった。content.ts の pngPredict)
    await replaceStream(doc, ref, data, { predict: { colors: 1, columns: w, rows: h } });
    report.images++;
    data = null;
  }
}

// ───────────────────────── 3. 影(Shading) ─────────────────────────

interface FnResult {
  /** 直した関数(新しいオブジェクト)。直す必要が無い(値が1つも動かない)ときは undefined */
  fn?: PDFObject;
  /** 直せなかった理由 */
  why?: string;
}

interface FnCtx {
  doc: PDFDocument;
  /** 古い関数の参照 → 作り直した関数。同じ関数を使う影が、作り直したものを共有する */
  converted: Map<string, FnResult>;
  /** 作り直したので、ほかから使われなくなったかもしれない古い関数 */
  replaced: PDFRef[];
}

function fnDictOf(v: unknown): PDFDict | null {
  return v instanceof PDFStream ? v.dict : asDict(v);
}

/** 関数の出力(0〜1。成分1つ)を t で求める。Type 2・3 だけ。求められなければ null */
function evalFn(ctx: PDFDocument['context'], f: unknown, t: number, depth = 0): number | null {
  const obj = f instanceof PDFRef ? ctx.lookup(f) : f;
  const dict = fnDictOf(obj);
  if (!dict || depth > 8) return null;
  const type = numOf(dict.lookup(N('FunctionType')));
  const domain = numArray(dict.lookup(N('Domain'))) ?? [0, 1];
  if (domain.length < 2) return null;
  const x = Math.min(Math.max(t, domain[0]), domain[1]);
  let y: number | null = null;
  if (type === 2) {
    const c0 = dict.get(N('C0')) ? numArray(dict.lookup(N('C0'))) : [0];
    const c1 = dict.get(N('C1')) ? numArray(dict.lookup(N('C1'))) : [1];
    const n = numOf(dict.lookup(N('N')));
    if (!c0 || !c1 || c0.length !== 1 || c1.length !== 1 || n === null) return null;
    y = c0[0] + Math.pow(x, n) * (c1[0] - c0[0]);
  } else if (type === 3) {
    const fns = dict.lookup(N('Functions'));
    const bounds = numArray(dict.lookup(N('Bounds')));
    const enc = numArray(dict.lookup(N('Encode')));
    if (!(fns instanceof PDFArray) || !bounds || !enc || fns.size() === 0) return null;
    const k = fns.size();
    if (bounds.length !== k - 1 || enc.length < k * 2) return null;
    const edges = [domain[0], ...bounds, domain[1]];
    let i = 0;
    while (i < k - 1 && x >= edges[i + 1]) i++;
    const span = edges[i + 1] - edges[i];
    const u = span === 0 ? enc[i * 2] : enc[i * 2] + ((x - edges[i]) * (enc[i * 2 + 1] - enc[i * 2])) / span;
    y = evalFn(ctx, fns.get(i), u, depth + 1);
  }
  if (y === null) return null;
  const range = numArray(dict.lookup(N('Range')));
  if (range && range.length >= 2) y = Math.min(Math.max(y, range[0]), range[1]);
  return y;
}

/**
 * 両端の値を直すだけで済む関数(べた塗り: Type 2 で C0 = C1。それだけで作ったつなぎの Type 3)を、新しい辞書にして返す。
 * 済まないものは null。値が1つも動かないとき(白べた・黒べた)は、同じ辞書(元)を返す
 */
function exactFn(ctx: PDFDocument['context'], f: unknown, depth = 0): { dict: PDFDict; changed: boolean } | null {
  const obj = f instanceof PDFRef ? ctx.lookup(f) : f;
  const dict = fnDictOf(obj);
  if (!dict || depth > 8 || obj instanceof PDFStream) return null;
  const type = numOf(dict.lookup(N('FunctionType')));
  if (type === 2) {
    const c0 = dict.get(N('C0')) ? numArray(dict.lookup(N('C0'))) : [0];
    const c1 = dict.get(N('C1')) ? numArray(dict.lookup(N('C1'))) : [1];
    if (!c0 || !c1 || c0.length !== 1 || c1.length !== 1 || c0[0] !== c1[0]) return null;
    const t = toneGray(c0[0]);
    if (t === c0[0]) return { dict, changed: false };
    const out = dict.clone(ctx);
    out.set(N('C0'), ctx.obj([t]));
    out.set(N('C1'), ctx.obj([t]));
    return { dict: out, changed: true };
  }
  if (type === 3) {
    const fns = dict.lookup(N('Functions'));
    if (!(fns instanceof PDFArray) || fns.size() === 0) return null;
    const items: PDFObject[] = [];
    let changed = false;
    for (let i = 0; i < fns.size(); i++) {
      const r = exactFn(ctx, fns.get(i), depth + 1);
      if (!r) return null;
      items.push(r.dict);
      changed = changed || r.changed;
    }
    if (!changed) return { dict, changed: false };
    const out = dict.clone(ctx);
    out.set(N('Functions'), ctx.obj(items));
    return { dict: out, changed: true };
  }
  return null;
}

/**
 * 影の関数を、グレーの濃さを直したものに作り直す。**元の関数は書き換えず、新しいものを作る**
 * (同じ関数を、マスクのなかの影とページの影が共有していても、マスクの側は元のまま残る)。
 *
 * - べた塗りの関数は、値を直すだけ(つなぎ目のずれが出ない)
 * - Type 2・3 の変化する関数は、256 点の標本(Type 0)にする。表は直線ではないので、両端を直しただけでは途中の明るさが合わない
 * - Type 0 の標本は、8ビット・出力1つ・Decode が Range と同じなら、標本の値を表で直す
 * - Type 4(計算式)は、求められないので直さない
 */
async function convertFunction(fc: FnCtx, fnObj: unknown, depth = 0): Promise<FnResult> {
  const ctx = fc.doc.context;
  if (fnObj instanceof PDFRef) {
    const key = fnObj.toString();
    const cached = fc.converted.get(key);
    if (cached) return cached;
    const r = await convertFunction(fc, ctx.lookup(fnObj), depth);
    if (r.fn) {
      // 元が参照で持たれていたので、新しいものも間接オブジェクトにして、共有の形を保つ
      const ref = r.fn instanceof PDFRef ? r.fn : ctx.register(r.fn);
      const done = { fn: ref };
      fc.converted.set(key, done);
      fc.replaced.push(fnObj);
      return done;
    }
    fc.converted.set(key, r);
    return r;
  }
  const dict = fnDictOf(fnObj);
  if (!dict) return { why: '関数を読めない' };
  if (depth > 8) return { why: '関数が深く入れ子になっている' };
  const type = numOf(dict.lookup(N('FunctionType')));

  if (type === 2 || type === 3) {
    const exact = exactFn(ctx, fnObj);
    if (exact) return exact.changed ? { fn: exact.dict } : {};
    const domain = numArray(dict.lookup(N('Domain'))) ?? [0, 1];
    if (domain.length !== 2) return { why: '入力が1つの関数ではない' };
    const samples = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const y = evalFn(ctx, fnObj, domain[0] + ((domain[1] - domain[0]) * i) / 255);
      if (y === null) return { why: '出力が1成分のグレーの関数ではなく、途中の値を求められない' };
      samples[i] = Math.round(toneGray(y) * 255);
    }
    const out = ctx.register(
      PDFRawStream.of(
        ctx.obj({ FunctionType: 0, Domain: domain, Range: [0, 1], Size: [256], BitsPerSample: 8 }),
        new Uint8Array(0),
      ),
    );
    await replaceStream(fc.doc, out, samples, { compress: false });
    return { fn: out };
  }

  if (type === 0 && fnObj instanceof PDFRawStream) {
    const size = numArray(dict.lookup(N('Size')));
    const range = numArray(dict.lookup(N('Range')));
    const decode = dict.get(N('Decode')) ? numArray(dict.lookup(N('Decode'))) : range;
    if (numOf(dict.lookup(N('BitsPerSample'))) !== 8 || !size || size.length === 0 || !range || range.length !== 2)
      return { why: '8ビット・出力1つの標本ではない' };
    if (range[0] !== 0 || range[1] !== 1 || !decode || decode.length !== 2 || decode[0] !== 0 || decode[1] !== 1)
      return { why: '標本の Range・Decode が 0〜1 ではない' };
    let count = 1;
    for (const s of size) count *= s;
    if (!Number.isFinite(count) || count <= 0 || count > 64_000_000) return { why: '標本が多すぎる' };
    let data: Uint8Array | null;
    try {
      data = await readStream(fnObj);
    } catch {
      return { why: '標本の中身が壊れている' };
    }
    if (!data || data.length < count) return { why: '標本を読めない' };
    const gray = data.slice(0, count);
    if (!toneInPlace(gray, count)) return {};
    const out = ctx.register(PDFRawStream.of(fnObj.dict.clone(ctx), new Uint8Array(0)));
    await replaceStream(fc.doc, out, gray);
    return { fn: out };
  }

  if (type === 4) return { why: '計算式の関数なので、途中の値を求められない' };
  return { why: '対応していない種類の関数' };
}

async function toneShadings(doc: PDFDocument, reach: Reach, report: GrayToneReport, skipped: Set<string>): Promise<void> {
  const ctx = doc.context;
  const fc: FnCtx = { doc, converted: new Map(), replaced: [] };
  for (const o of reach.all) {
    if (!(o instanceof PDFDict) || !o.get(N('ShadingType'))) continue;
    const d = o;
    if (csKind(d.lookup(N_COLORSPACE)) !== 'gray') continue;
    const sc = scopeOf(reach, d);
    if (sc === 'skip') continue;
    const label = `影の指定(種類 ${numOf(d.lookup(N('ShadingType'))) ?? '?'})`;
    if (sc === 'both') {
      skipped.add(`${label}（透明のマスクとページの両方から使われているので、グレーの濃さを直していない）`);
      continue;
    }
    const type = numOf(d.lookup(N('ShadingType')));
    if (reach.streamDicts.has(d) || (type !== null && type >= 4)) {
      skipped.add(`${label}（メッシュの影なので、グレーの濃さを直していない）`);
      continue;
    }
    // 背景は、成分1つのときだけ直す
    let bg: number[] | null = null;
    if (d.get(N('Background'))) {
      bg = numArray(d.lookup(N('Background')));
      if (!bg || bg.length !== 1) {
        skipped.add(`${label}（背景の色を読めないので、グレーの濃さを直していない）`);
        continue;
      }
    }
    const fnVal = d.get(N('Function'));
    if (fnVal === undefined) continue;
    const resolved = fnVal instanceof PDFRef ? ctx.lookup(fnVal) : fnVal;
    if (resolved instanceof PDFArray) {
      skipped.add(`${label}（成分ごとに関数が分かれているので、グレーの濃さを直していない）`);
      continue;
    }
    const r = await convertFunction(fc, fnVal);
    if (r.why) {
      skipped.add(`${label}（${r.why}。グレーの濃さを直していない）`);
      continue;
    }
    let changed = false;
    if (r.fn) {
      d.set(N('Function'), r.fn);
      changed = true;
    }
    if (bg && toneGray(bg[0]) !== bg[0]) {
      d.set(N('Background'), ctx.obj([toneGray(bg[0])]));
      changed = true;
    }
    if (changed) report.shadings++;
  }
  dropDeadFunctions(doc, fc.replaced);
}

/** 作り直したので使われなくなった古い関数を捨てる(残すと、直す前の値が文書に残る)。**ほかの影が使っているものは残る** */
function dropDeadFunctions(doc: PDFDocument, replaced: PDFRef[]): void {
  if (replaced.length === 0) return;
  const ctx = doc.context;
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
  const add = (ref: PDFRef, depth: number) => {
    if (candidates.has(ref.toString()) || depth > 8) return;
    candidates.set(ref.toString(), ref);
    const subs = fnDictOf(ctx.lookup(ref))?.lookup(N('Functions'));
    if (subs instanceof PDFArray) for (let i = 0; i < subs.size(); i++) {
      const e = subs.get(i);
      if (e instanceof PDFRef) add(e, depth + 1);
    }
  };
  for (const ref of replaced) add(ref, 0);
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

// ───────────────────────── 入り口 ─────────────────────────

/**
 * doc の中の DeviceGray の値(描く命令・画像・影・索引色の表)を GRAY_TONE で置き換える(doc を直に書き換える)。
 * Ghostscript の**あと**に呼ぶ。**1回だけ**(2度かけると2度濃くなる。直したあとの PDF かどうかは PDF からは分からない)
 */
export async function applyGrayTone(doc: PDFDocument): Promise<GrayToneReport> {
  const report: GrayToneReport = { ops: 0, images: 0, shadings: 0, skipped: [] };
  const skipped = new Set<string>();
  const holderSkips: string[] = [];
  const holders = await contentHolders(doc, holderSkips);
  for (const s of holderSkips) skipped.add(`描く命令 ${s}`);
  const reach = computeReach(doc, holders);
  await toneShadings(doc, reach, report, skipped);
  await toneImages(doc, reach, report, skipped);
  await toneOps(doc, holders, reach, report, skipped);
  report.skipped = [...skipped];
  return report;
}
