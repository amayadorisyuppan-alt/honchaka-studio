// 変換のあとの点検。**入稿してよい色になっているか**を、PDF の中身を開いて数える。
//
// 見るのは3つ:
//   1. RGB が残っていないか(描く命令の rg / RG・色空間の名前・画像)。Chrome の本文 PDF は黒い字も `0 0 0 rg`(RGB)で、
//      そのまま刷ると4色の掛け合わせになる(2026-09-26 印刷所の入稿ガイドの例: 白黒のページは K1色かグレースケール、RGB は不可)
//   2. 白黒の本なのに、K 以外(CMYK)が在る所
//   3. **C・M・Y が乗るページ(「カラーのページ」)の一覧。** 印刷代は、カラーのページの数で変わる。
//      文字だけのページを間違ってカラーと数えると、利用者の見積もりがずれる(neutral.ts の目的)
//
// カラーのページは、ページの描く命令と、そこから使っているもの(Form・パターン・影・画像・Type3 の字形。入れ子も)をたどって決める。
// **「色を指定しただけで何も描いていない」ものまでカラーに数える**(安全な側)。測れない物(読めない画像など)もカラー側に倒す。
// 透明のマスク(SMask)の中身はインクではないので、たどらない。
//
// 前の gsWorker.ts の tidyAndCheckGray の点検(色の命令・色空間の名前・グレーでない画像)を、ここへ移した。
// Node 24 でそのまま動く書き方にしてある(scripts/press/e2e.test.ts が node で回す)。ブラウザ専用の物は使わない。
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import { contentHolders, forEachOperation, readStream } from './content.ts';
import type { ContentHolder } from './content.ts';
import type { InkFact } from './inkLimit.ts';
import type { PressKind } from './pipeline.ts';

export interface Inspection {
  /** RGB の指定が残っている所(「画像 12 0 R」「描く命令 ページ 3」のような文。空なら無い) */
  rgb: string[];
  /** 白黒の本なのに K 以外(CMYK の C・M・Y)が在る所 */
  notGray: string[];
  /** C・M・Y が乗るページ(1 始まり) */
  colorPages: number[];
  /** 読めなくて調べられなかった描く命令(「呼び名（理由）」。空でなければ、点検の結果は「調べた範囲では」になる) */
  unchecked: string[];
}

const N = (s: string) => PDFName.of(s);

// 色空間の名前。描く命令の中に直に埋め込んだ画像(BI … ID … EI)は /CS /RGB のように略して書くので、それも見る
const RGB_NAMES = /\/(?:DeviceRGB|CalRGB|Lab)\b|\/CS\s*\/(?:RGB)\b/;
const CMYK_NAMES = /\/DeviceCMYK\b|\/CS\s*\/CMYK\b/;

/** C・M・Y が「0 でない」と見る下限。Ghostscript は K だけの色に 0 をそのまま書く。0.0005 は 8ビットの 1段の 1/8 */
const CMY_EPS = 0.0005;

type Family = 'gray' | 'cmyk' | 'rgb' | 'spot' | 'pattern' | 'unknown';

function dictOf(v: unknown): PDFDict | null {
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return null;
}

/** 色空間(名前・配列・参照)が、どの種類か。Indexed は元の色空間の種類。resNames は資源の ColorSpace の辞書(名前を引く用) */
function familyOf(doc: PDFDocument, cs: PDFObject | undefined, resNames: PDFDict | null, depth = 0): Family {
  if (cs === undefined || depth > 8) return 'unknown';
  const v = doc.context.lookup(cs);
  if (v instanceof PDFName) {
    switch (v.decodeText()) {
      case 'DeviceGray':
      case 'G':
      case 'CalGray':
        return 'gray';
      case 'DeviceCMYK':
      case 'CMYK':
        return 'cmyk';
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
      case 'Lab':
        return 'rgb';
      case 'Pattern':
        return 'pattern';
    }
    const hit = resNames?.get(v);
    return hit !== undefined ? familyOf(doc, hit, null, depth + 1) : 'unknown';
  }
  if (v instanceof PDFArray) {
    const head = v.lookup(0);
    switch (head instanceof PDFName ? head.decodeText() : '') {
      case 'ICCBased': {
        const icc = v.lookup(1);
        const n = icc instanceof PDFStream ? icc.dict.lookup(N('N')) : null;
        const count = n instanceof PDFNumber ? n.asNumber() : 0;
        return count === 4 ? 'cmyk' : count === 1 ? 'gray' : count === 3 ? 'rgb' : 'unknown';
      }
      case 'Indexed':
      case 'I':
        return familyOf(doc, v.get(1), resNames, depth + 1);
      case 'Pattern':
        return 'pattern';
      case 'CalGray':
        return 'gray';
      case 'CalRGB':
      case 'Lab':
        return 'rgb';
      case 'Separation':
      case 'DeviceN':
        return 'spot';
    }
  }
  return 'unknown';
}

/**
 * パターンの色空間は、下地(`[/Pattern /DeviceRGB]` の /DeviceRGB)の種類で見る。色なしのタイルのパターンは、色を下地の色空間の数で決めるので、
 * 下地が RGB なら RGB の指定が残っている(Ghostscript はこの下地を RGB のまま残した。2026-10-01 の指摘 A4)。
 * 下地の無い `/Pattern`(色つきのタイル・影)は 'pattern' のまま
 */
function effectiveFamily(doc: PDFDocument, cs: PDFObject | undefined, resNames: PDFDict | null, depth = 0): Family {
  const fam = familyOf(doc, cs, resNames, depth);
  if (fam !== 'pattern' || cs === undefined || depth > 8) return fam;
  const v = doc.context.lookup(cs);
  if (v instanceof PDFName) {
    const hit = resNames?.get(v);
    return hit === undefined ? 'pattern' : effectiveFamily(doc, hit, null, depth + 1);
  }
  if (v instanceof PDFArray && v.size() > 1) {
    const base = effectiveFamily(doc, v.get(1), resNames, depth + 1);
    return base === 'unknown' ? 'pattern' : base;
  }
  return 'pattern';
}

/** 辞書とその中に直に入っている辞書・配列の中の辞書を全部たどる(参照は追わない。参照の先は別のオブジェクトとして来る) */
function walkDirect(root: PDFObject, fn: (d: PDFDict) => void): void {
  const visit = (v: PDFObject | undefined): void => {
    if (v instanceof PDFDict) {
      fn(v);
      for (const [, x] of v.entries()) if (x instanceof PDFDict || x instanceof PDFArray) visit(x);
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) {
        const x = v.get(i);
        if (x instanceof PDFDict || x instanceof PDFArray) visit(x);
      }
    }
  };
  visit(root instanceof PDFStream ? root.dict : root);
}

/** 画像の C・M・Y に 0 でない画素が在るか。読めなければ true(安全な側) */
async function imageHasCmy(doc: PDFDocument, stream: PDFRawStream): Promise<boolean> {
  const d = stream.dict;
  // 型抜き(ImageMask)は色空間を持たない。色は描く命令の色で決まる。色空間が無いからと「色あり」に倒すと、
  // 黒だけのページがカラーのページに数えられた(2026-10-01 の指摘 A2)
  if (String(d.lookup(N('ImageMask'))) === 'true') return false;
  const fam = familyOf(doc, d.get(N('ColorSpace')), null);
  if (fam === 'gray') return false;
  if (fam !== 'cmyk') return true;
  const cs = doc.context.lookup(d.get(N('ColorSpace')) as PDFObject);
  // Indexed の表や 8 ビット以外は、画素を直には数えない(Ghostscript の出力は 8 ビットの DeviceCMYK)
  if (!(cs instanceof PDFName) && !(cs instanceof PDFArray && cs.lookup(0) === N('ICCBased'))) return true;
  const bpc = d.lookup(N('BitsPerComponent'));
  if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) return true;
  let data: Uint8Array | null = null;
  try {
    data = await readStream(stream);
  } catch {
    return true;
  }
  if (!data) return true;
  const dec = d.lookup(N('Decode'));
  let inv = 0;
  if (dec instanceof PDFArray && dec.size() >= 2) {
    const first = dec.lookup(0);
    if (first instanceof PDFNumber && first.asNumber() === 1) inv = 0xff;
  }
  const n4 = data.length & ~3;
  for (let i = 0; i < n4; i += 4) {
    if (((data[i] ^ inv) | (data[i + 1] ^ inv) | (data[i + 2] ^ inv)) !== 0) return true;
  }
  return false;
}

/** 1つの描く命令の持ち主(ページ・Form・パターン・字形)から読み取った事実。命令の本体は、読んだらすぐ捨てる */
interface Summary {
  /** 色の命令(k K rg RG sc scn …)や色つきのインライン画像が、それだけで C・M・Y を持つ */
  color: boolean;
  /** 使っているもの(キーは参照の文字。直に書かれた影は dict で持つ) */
  forms: string[];
  images: string[];
  patterns: string[];
  shadings: { key: string | null; dict: PDFDict }[];
  fonts: PDFDict[];
}

/**
 * 変換のあとの PDF を点検する。doc は applyPdfx4 のあと(PDF/X-4 の形に整えたあと)のもの。
 * facts は limitInk の結果(画像・影ごとの C・M・Y の有無)。無ければ画像は自分で測る
 */
export async function inspectPress(doc: PDFDocument, kind: PressKind, facts?: Map<string, InkFact>): Promise<Inspection> {
  const ctx = doc.context;
  const gray = kind === 'body-gray';
  const rgb: string[] = [];
  const notGray: string[] = [];
  const seenLabel = new Set<string>();
  const addRgb = (label: string) => {
    if (!seenLabel.has(label)) {
      seenLabel.add(label);
      rgb.push(label);
    }
  };
  const addGray = (label: string) => {
    if (!seenLabel.has(label)) {
      seenLabel.add(label);
      notGray.push(label);
    }
  };

  // ── 辞書・画像の色空間 ──
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    // 色空間の配列そのもの(`[/Pattern /DeviceRGB]` や `[/ICCBased …]` が、間接オブジェクトとして在る)。辞書の値としては参照でしか現れない
    if (obj instanceof PDFArray) {
      const fam = effectiveFamily(doc, obj, null);
      if (fam === 'rgb') addRgb(`色空間 ${ref.toString()}`);
      else if (gray && fam === 'cmyk') addGray(`色空間 ${ref.toString()}`);
      continue;
    }
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const key = ref.toString();
    if (obj instanceof PDFRawStream && dict.lookup(N('Subtype')) === N('Image')) {
      if (String(dict.lookup(N('ImageMask'))) === 'true') continue; // 型抜き。色は描く命令の色
      const cs = dict.get(N('ColorSpace'));
      if (cs === undefined) continue; // JPEG 2000 など、色空間が中に入っている(X-4 の点検が別に見る)
      const fam = familyOf(doc, cs, null);
      if (fam === 'rgb') addRgb(`画像 ${key}`);
      else if (gray && fam !== 'gray') addGray(`画像 ${key}`);
      continue;
    }
    // ICC の中身(/N を持つ)と XMP は色の指定ではないので見ない
    if (dict.get(N('N')) || dict.lookup(N('Type')) === N('Metadata')) continue;
    const text = dict.toString();
    if (RGB_NAMES.test(text)) addRgb(`色空間 ${key}`);
    else if (gray && CMYK_NAMES.test(text)) addGray(`色空間 ${key}`);
    // 名前の書かれていない色空間: [/ICCBased …]（3成分）が資源の ColorSpace に入っているもの
    walkDirect(obj, (d) => {
      const csv = d.get(N('ColorSpace'));
      if (csv === undefined) return;
      const names = csv instanceof PDFDict ? [...csv.entries()].map(([, v]) => v) : [csv];
      for (const v of names) {
        const fam = effectiveFamily(doc, v, null);
        if (fam === 'rgb') addRgb(`色空間 ${key}`);
        else if (gray && fam === 'cmyk') addGray(`色空間 ${key}`);
      }
    });
  }

  // ── 描く命令 ──
  const unchecked: string[] = [];
  const holders = await contentHolders(doc, unchecked);
  const summaries = new Map<string, Summary>();
  const holderKey = (h: ContentHolder) => (h.kind === 'page' ? `page:${h.pageIndex}` : (h.ref as PDFRef).toString());
  const byKey = new Map<string, ContentHolder>();
  for (const h of holders) {
    byKey.set(holderKey(h), h);
    summaries.set(holderKey(h), summarize(h));
  }

  function summarize(h: ContentHolder): Summary {
    const res = h.resources;
    const sub = (name: string): PDFDict | null => {
      const v = res?.lookup(N(name));
      return v instanceof PDFDict ? v : null;
    };
    const csRes = sub('ColorSpace');
    const xobj = sub('XObject');
    const pats = sub('Pattern');
    const shs = sub('Shading');
    const fonts = sub('Font');
    const s: Summary = { color: false, forms: [], images: [], patterns: [], shadings: [], fonts: [] };
    let rgbHit = false;
    let cmykHit = false;
    const refOrNull = (d: PDFDict | null, name: string | undefined): PDFRef | null => {
      if (!d || name === undefined) return null;
      const v = d.get(N(name));
      return v instanceof PDFRef ? v : null;
    };
    // 命令は配列にせず、1つずつ読む(100MB の描く命令を配列にすると、Node のヒープが尽きて落ちた。2026-10-01 の指摘 B1)
    forEachOperation(h.bytes, (o) => {
      const t = o.operands;
      switch (o.op) {
        case 'rg':
        case 'RG':
          rgbHit = true;
          s.color = true;
          break;
        case 'k':
        case 'K':
          cmykHit = true;
          if (t.length >= 3 && (Math.abs(t[0].num ?? 0) > CMY_EPS || Math.abs(t[1].num ?? 0) > CMY_EPS || Math.abs(t[2].num ?? 0) > CMY_EPS)) s.color = true;
          break;
        case 'sc':
        case 'SC':
        case 'scn':
        case 'SCN': {
          const last = t[t.length - 1];
          if (last && last.type === 'name') {
            const r = refOrNull(pats, last.text);
            if (r) s.patterns.push(r.toString());
            else if (pats && last.text !== undefined) {
              const dd = pats.lookup(N(last.text));
              if (dd instanceof PDFDict) s.shadings.push({ key: null, dict: dd });
            }
          }
          const nums = t.filter((x) => x.type === 'number');
          if (nums.length === 4) {
            if (nums.slice(0, 3).some((x) => Math.abs(x.num ?? 0) > CMY_EPS)) s.color = true;
          } else if (nums.length === 3) {
            // RGB や Lab の指定。cs を追わないので、安全な側でカラーに数える
            s.color = true;
          }
          break;
        }
        case 'cs':
        case 'CS': {
          const n = t[0];
          if (n && n.type === 'name') {
            const fam = effectiveFamily(doc, N(n.text as string), csRes);
            if (fam === 'rgb') {
              rgbHit = true;
              s.color = true;
            } else if (fam === 'cmyk') cmykHit = true;
            // 特色(Separation・DeviceN)は、実際のインクが何色・何%かを測れない。安全な側でカラーに数える
            // (数えないと、実インク 400% のページが「黒インクだけ」と出た。2026-10-01 の指摘 A3)
            else if (fam === 'spot') s.color = true;
          }
          break;
        }
        case 'Do': {
          const n = t[0];
          const r = refOrNull(xobj, n?.text);
          if (!r) break;
          const x = ctx.lookup(r);
          const sd = x instanceof PDFStream ? x.dict : null;
          if (!sd) break;
          if (sd.lookup(N('Subtype')) === N('Image')) s.images.push(r.toString());
          else s.forms.push(r.toString());
          break;
        }
        case 'sh': {
          const n = t[0];
          const r = refOrNull(shs, n?.text);
          if (r) {
            const d = dictOf(ctx.lookup(r));
            if (d) s.shadings.push({ key: r.toString(), dict: d });
          } else if (shs && n?.text !== undefined) {
            const d = shs.lookup(N(n.text));
            if (d instanceof PDFDict) s.shadings.push({ key: null, dict: d });
          }
          break;
        }
        case 'Tf': {
          const n = t[0];
          if (fonts && n?.text !== undefined) {
            const fd = fonts.lookup(N(n.text));
            if (fd instanceof PDFDict && fd.lookup(N('Subtype')) === N('Type3')) s.fonts.push(fd);
          }
          break;
        }
        case 'BI': {
          // インライン画像の色空間: /CS か /ColorSpace の次の字句
          let cs: string | null = null;
          for (let i = 0; i + 1 < t.length; i++) {
            if (t[i].type === 'name' && (t[i].text === 'CS' || t[i].text === 'ColorSpace') && t[i + 1].type === 'name') cs = t[i + 1].text as string;
          }
          const isMask = t.some((x, i) => x.type === 'name' && (x.text === 'IM' || x.text === 'ImageMask') && t[i + 1]?.text === 'true');
          if (isMask) break;
          const fam = cs === null ? 'unknown' : familyOf(doc, N(cs), csRes);
          if (fam === 'rgb') {
            rgbHit = true;
            s.color = true;
          } else if (fam === 'gray') {
            // K だけ
          } else {
            if (fam === 'cmyk') cmykHit = true;
            s.color = true; // 中の画素は測らない。安全な側
          }
          break;
        }
        default:
          break;
      }
    });
    if (rgbHit) addRgb(`描く命令 ${h.label}`);
    if (gray && cmykHit) addGray(`描く命令 ${h.label}`);
    return s;
  }

  // ── カラーのページ ──
  const imageCmy = new Map<string, boolean>();
  const isImageColor = async (key: string): Promise<boolean> => {
    const fact = facts?.get(key);
    if (fact) return fact.cmy;
    let v = imageCmy.get(key);
    if (v === undefined) {
      const m = key.match(/^(\d+) (\d+) R$/);
      const x = m ? ctx.lookup(PDFRef.of(Number(m[1]), Number(m[2]))) : undefined;
      v = x instanceof PDFRawStream ? await imageHasCmy(doc, x) : true;
      imageCmy.set(key, v);
    }
    return v;
  };
  /** 影の色。limitInk が測っていればその結果、なければ色空間がグレーのものだけ「色なし」 */
  const isShadingColor = (key: string | null, dict: PDFDict): boolean => {
    const fact = key ? facts?.get(key) : undefined;
    if (fact) return fact.cmy;
    return familyOf(doc, dict.get(N('ColorSpace')), null) !== 'gray';
  };

  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  async function holderColor(key: string): Promise<boolean> {
    const done = memo.get(key);
    if (done !== undefined) return done;
    const s = summaries.get(key);
    // 読めなかったものは数えられない(unchecked に出ている)。色なしとして扱う
    if (!s || visiting.has(key)) return false;
    visiting.add(key);
    let color = s.color;
    for (const k of s.forms) if (!color && (await holderColor(k))) color = true;
    for (const k of s.images) if (!color && (await isImageColor(k))) color = true;
    for (const k of s.patterns) {
      if (color) break;
      const m = k.match(/^(\d+) (\d+) R$/);
      const pat = m ? ctx.lookup(PDFRef.of(Number(m[1]), Number(m[2]))) : undefined;
      const pd = dictOf(pat);
      const type = pd?.lookup(N('PatternType'));
      if (pd && type instanceof PDFNumber && type.asNumber() === 2) {
        const shRaw = pd.get(N('Shading'));
        const sd = dictOf(pd.lookup(N('Shading')));
        if (!sd || isShadingColor(shRaw instanceof PDFRef ? shRaw.toString() : `${k} の中の影`, sd)) color = true;
      } else if (await holderColor(k)) color = true;
    }
    for (const sh of s.shadings) if (!color && isShadingColor(sh.key, sh.dict)) color = true;
    for (const fd of s.fonts) {
      if (color) break;
      const procs = fd.lookup(N('CharProcs'));
      if (!(procs instanceof PDFDict)) continue;
      for (const [, v] of procs.entries()) if (!color && v instanceof PDFRef && (await holderColor(v.toString()))) color = true;
    }
    visiting.delete(key);
    memo.set(key, color);
    return color;
  }

  const colorPages: number[] = [];
  const pageCount = doc.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    const key = `page:${i}`;
    if (byKey.has(key) && (await holderColor(key))) colorPages.push(i + 1);
  }
  return { rgb, notGray, colorPages, unchecked };
}
