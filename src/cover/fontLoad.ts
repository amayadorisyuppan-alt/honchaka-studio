// 表紙を描く前に、使う書体を確実に読み込む。(2026-10-11 1.0.3。修正リストの 17)
//
// ## 何が起きていたか
//
// 本番の Xserver(HTTP/2)は、一斉に取りに行った書体のファイルの一部を断る(REFUSED_STREAM)。
// 断られた @font-face の面は error のまま戻らず、その面に当たる document.fonts.load は
// 「A network error occurred.」で落ち続ける(押し直しても同じ。再読み込みするまで直らない)。
// 一斉の取得の元(Vivliostyle が全部の面を読ませていた)は src/preview/fontWaitGuard.ts で止めたが、
// 回線の都合で1面だけ断られることはありうるので、ここでも直せるようにしておく。
//
// ## どうするか
//
// 1. **描く字を渡して読む。** 字を渡さないと document.fonts.load は空白1字ぶん(ラテンのサブセット)しか
//    読まず、書名の漢字は黙って別の書体で描かれる(前は Vivliostyle が全部の面を読ませていたので間に合っていた)
// 2. それでも落ちたら、**error の面を、同じ @font-face から作り直して読み直す。**
//    CSS から生まれた面は document.fonts から消せないが、あとから足した面のほうが先に使われるので、
//    読み直した面で描かれる

import { absolutize, familyNames, unicodeRangeHits } from '../typeset/fontface';

const unq = (s: string) => s.trim().replace(/^["']|["']$/g, '');
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** error の面と同じ書体名・太さ・字の範囲の @font-face を、ページのスタイルシートから探して src を返す */
function srcOf(face: FontFace): string | null {
  const fam = unq(face.family).toLowerCase();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      if (unq(st.getPropertyValue('font-family')).toLowerCase() !== fam) continue;
      if (norm(st.getPropertyValue('font-weight') || '400') !== norm(face.weight)) continue;
      if (norm(st.getPropertyValue('font-style') || 'normal') !== norm(face.style)) continue;
      const range = st.getPropertyValue('unicode-range');
      if (range && norm(range) !== norm(face.unicodeRange)) continue;
      return absolutize(st.getPropertyValue('src'), sheet.href ?? document.baseURI);
    }
  }
  return null;
}

/**
 * 作り直して読めた面(元の error の面で覚える)。CSS の面は error のまま残るので、
 * 次の書き出しでも document.fonts.load は落ちる。そのたびに作り直さないよう、済んだものは飛ばす
 */
const repaired = new WeakSet<FontFace>();

/** 作り直した面を読む。断られたら間をおいて取り直す */
async function reload(face: FontFace): Promise<boolean> {
  if (repaired.has(face)) return true;
  const src = srcOf(face);
  if (!src) return false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const fresh = new FontFace(face.family, src, {
      weight: face.weight,
      style: face.style,
      unicodeRange: face.unicodeRange,
      display: face.display,
    });
    try {
      await fresh.load();
      document.fonts.add(fresh);
      repaired.add(face);
      return true;
    } catch {
      await sleep(400 * (attempt + 1));
    }
  }
  return false;
}

/**
 * `spec`(「700 100px "Noto Serif JP", serif」の形)で `text` を描けるように読み込む。
 * 読めなかった面があれば作り直して読み直し、それでも読めなければ最初の失敗を投げる
 */
export async function loadFontForText(spec: string, text: string): Promise<void> {
  const chars = text || ' ';
  try {
    await document.fonts.load(spec, chars);
    return;
  } catch (e) {
    const want = new Set(familyNames(spec).map((f) => f.toLowerCase()));
    const used = new Set<number>();
    for (const ch of chars) used.add(ch.codePointAt(0) ?? 0);
    // **for…of で回す。** forEach は Vivliostyle 向けに絞ってある(src/preview/fontWaitGuard.ts)
    const broken: FontFace[] = [];
    for (const f of document.fonts) {
      if (f.status !== 'error') continue;
      if (!want.has(unq(f.family).toLowerCase())) continue;
      if (!unicodeRangeHits(f.unicodeRange, used)) continue;
      broken.push(f);
    }
    if (broken.length === 0) throw e;
    // 同時に読み直すのは数面ずつ(一斉に取りに行くと、また断られる)
    const queue = [...broken];
    let allOk = true;
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) if (!(await reload(f))) allOk = false;
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    if (!allOk) throw e;
  }
}
