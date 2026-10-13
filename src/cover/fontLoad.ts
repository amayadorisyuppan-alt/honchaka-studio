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
// 3. **作り直しても読めなかった面は、画面で知らせる。**(2026-10-13 修正リスト 29)
//    前は投げるだけで、表紙は代わりの書体(ゴシック)のまま黙って描かれていた。
//    作り直しと読み直しの仕組みは、下見の知らせと同じもの(src/preview/fontFailures.ts)

import { familyNames, unicodeRangeHits } from '../typeset/fontface';
import { reloadFace, setCoverFontFailures, srcIndex } from '../preview/fontFailures';

const unq = (s: string) => s.trim().replace(/^["']|["']$/g, '');

/**
 * 「700 100px "Noto Serif JP", serif」から、書体名の並び(「"Noto Serif JP", serif」)だけを取り出す。
 * **前は spec をそのまま familyNames に渡していて、頭の書体が「700 100px "noto serif jp」になり、
 * いちばん大事な1つめの書体の error の面を拾えていなかった**(2026-10-13 修正リスト 29 の検査で見つけた。
 * 拾えたのは2つめ以降の代わりの書体だけ)
 */
export function familyPartOf(spec: string): string {
  return spec.replace(
    /^\s*(?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|\d{3})\s+)*[\d.]+(?:px|pt|em|rem|%)(?:\/\S+)?\s+/i,
    '',
  );
}

/**
 * `spec`(「700 100px "Noto Serif JP", serif」の形)で `text` を描けるように読み込む。
 * 読めなかった面があれば作り直して読み直し、それでも読めなければ最初の失敗を投げる。
 * 作り直しても読めなかった面は `failed` に入れる(渡したときだけ)
 */
export async function loadFontForText(spec: string, text: string, failed?: Set<FontFace>): Promise<void> {
  const chars = text || ' ';
  try {
    await document.fonts.load(spec, chars);
    return;
  } catch (e) {
    const want = new Set(familyNames(familyPartOf(spec)).map((f) => f.toLowerCase()));
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
    // @font-face の表は1回だけ作る(全部で約 4,000 規則。面ごとに回すと重い)
    const index = srcIndex((fam) => want.has(fam.toLowerCase()));
    // 同時に読み直すのは数面ずつ(一斉に取りに行くと、また断られる)
    const queue = [...broken];
    let allOk = true;
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (await reloadFace(f, index)) continue;
        allOk = false;
        failed?.add(f);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    if (!allOk) throw e;
  }
}

/**
 * 表紙の書体を全部読む(src/cover/render.ts の ensureCoverFonts)。
 * **読めなかった面を、そのたびの結果で知らせ直す**(fontFailures の表紙の帳面。書体を選び直したら古い失敗は消える)。
 * 1つでも読めなければ、最初の失敗を投げる(今までどおり)
 */
export async function loadCoverFonts(specs: string[], text: string): Promise<void> {
  const failed = new Set<FontFace>();
  const results = await Promise.allSettled(specs.map((s) => loadFontForText(s, text, failed)));
  setCoverFontFailures([...failed]);
  const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (bad) throw bad.reason;
}
