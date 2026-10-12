// 中綴じの本の、ページ数・知らせの文。(2026-10-03)
//
// 中綴じは紙を重ねて真ん中をホチキスで留めるので、ページ数は 4 の倍数でなければならない(紙1枚が4ページ)。
// ここは**純関数**だけを置く(ブラウザなしで検査できる。scripts/saddle.test.ts)。
// 画面(ShapeStep の読み上げ)・入稿前チェック・書き出しの止め方は、みなここの数字と文を使う。
// 無線綴じを偶数にそろえる出し先(PrintTargetProfile.perfectEvenPages。2026-10-12)も、同じ足し算(padToUnit・pageUnitOf)を使う。
//
// ## 数え方(D1 設計 §2)
//
//   n0   = 組み上げた本文のページ数。**表紙も白ページも含めない**
//   pad  = (4 − n0 mod 4) mod 4        … 足す白いページ。奥付の手前に入れる(奥付が最後のページに来る)
//   表紙 = 共紙のときだけ 4 ページ(表1・表2・表3・表4)。4 の倍数なので pad の式は変わらない
//   総数 = n0 + pad + 表紙
//
// 例: 37 ページ → pad 3 → 別表紙は 40 ページ、共紙は 44 ページ。
//
// ## 見開きの絵(typeset/spread.ts)との取り合い(2026-10-03)
//
// 見開きの絵は偶数ページから始まるので、奇数ページに来るときは**組版が白いページを1枚、絵の手前に入れる**(break-before: verso)。
// その白は組み上がった本文のページ数 n0 に**もう含まれている**(n0 = 組み上がった全ページ − pad − 表紙)。
// ここの pad(奥付の手前。見開きより後ろ)は n0 に依らず n0 だけで決まり、見開きの偶奇は pad に動かされない
// (pad は見開きより後ろに入るので、見開きの前のページ数は変わらない)。だから足し算は1回で収まり、組み直しが行き来しない。
// 共紙の表1・表2(先頭の2ページ)も偶数ページぶんなので、見開きの偶奇を変えない。紙で測る検査は scripts/check-spread.py の 6。

import {
  PRINT_TARGETS,
  TRIM_SIZES,
  bindingOf,
  saddleCoverOf,
  saddleSpecOf,
  type InkColor,
  type ProjectSettings,
  type SaddleCover,
} from '../models/project';

/** 共紙の表紙のページ数(表1・表2・表3・表4) */
export const SELF_COVER_PAGES = 4;

export interface SaddlePages {
  /** 足す白いページの数(0〜3) */
  pad: number;
  /** 共紙の表紙のページ数(別表紙は 0) */
  coverPages: number;
  /** PDF の総ページ数 */
  total: number;
}

/** 本文 n0 ページに足す白いページと、PDF の総ページ数 */
export function saddlePad(n0: number, cover: SaddleCover): SaddlePages {
  const n = Math.max(0, Math.floor(n0));
  const pad = padToUnit(n, 4);
  const coverPages = cover === 'self' ? SELF_COVER_PAGES : 0;
  return { pad, coverPages, total: n + pad + coverPages };
}

/** 本文 n0 ページを unit の倍数にそろえるために足す白いページの数(0 ページの本には足さない) */
export function padToUnit(n0: number, unit: number): number {
  const n = Math.max(0, Math.floor(n0));
  return n === 0 || unit < 2 ? 0 : (unit - (n % unit)) % unit;
}

/**
 * 本文のページ数を、何の倍数にそろえるか。(2026-10-12)
 * - 中綴じ … 4(紙1枚が4ページ)
 * - 無線綴じで、出し先が偶数にそろえる決まりを持つとき(perfectEvenPages) … 2。白いページは中綴じと同じく奥付の手前に入る
 * - それ以外(KDP・その他の印刷所の無線綴じ) … null。何も足さず、組版HTMLは1バイトも変わらない
 */
export function pageUnitOf(s: Pick<ProjectSettings, 'printTarget' | 'binding'>): 4 | 2 | null {
  if (bindingOf(s) === 'saddle') return 4;
  return PRINT_TARGETS[s.printTarget]?.perfectEvenPages ? 2 : null;
}

/** 綴じる辺の長さ(mm)。判型は縦長なので、綴じる辺は高さ(縦書き・横書きとも) */
export function bindEdgeMm(trim: ProjectSettings['trim']): number {
  return (TRIM_SIZES[trim] ?? TRIM_SIZES.bunko).h;
}

type Note = { level: 'ng' | 'warn'; text: string };

/**
 * 中綴じで、直したほうがよいこと。引っかかったときだけ返す(入稿前チェックと、画面の読み上げの下に出す)。
 * **書き出しは止めない**(止めると「なぜ出せないのか」を探す旅が始まる)。
 * @param total PDF の総ページ数(白いページ・共紙の表紙を含む)。数え終わっていなければ null(ページ数の話はしない)
 */
export function saddleFindings(s: ProjectSettings, total: number | null): Note[] {
  const spec = saddleSpecOf(s);
  if (!spec) return [];
  const out: Note[] = [];
  const label = PRINT_TARGETS[s.printTarget].label;
  if (total !== null) {
    const hard = spec.maxPagesThinPaper ?? spec.maxPages;
    if (hard !== null && total > hard) {
      out.push({
        level: 'ng',
        text: `中綴じは ${hard} ページまでしか作れません（いまは ${total} ページ）。ページ数を減らすか、無線綴じにしてください`,
      });
    } else if (spec.maxPages !== null && total > spec.maxPages) {
      out.push({
        level: 'warn',
        text: `${label}の中綴じは ${spec.maxPages} ページまでです（いまは ${total} ページ）。${
          spec.maxPagesThinPaper !== null ? `本文用紙がいちばん薄いときだけ ${spec.maxPagesThinPaper} ページまで作れます。` : ''
        }入稿の前に印刷所に確かめてください`,
      });
    }
  }
  const edge = bindEdgeMm(s.trim);
  if (spec.minBindEdgeMm !== null && edge < spec.minBindEdgeMm) {
    out.push({
      level: 'warn',
      text: `綴じる辺が ${edge}mm で、目安の ${spec.minBindEdgeMm}mm に足りません。中綴じが作れるか、入稿の前に印刷所へ相談してください`,
    });
  }
  return out;
}

/**
 * 綴じ方を中綴じにしているのに、いまの出し先には中綴じが無いとき(KDP)の一言。それ以外は null。
 * 選びは消さず、無線として組んでいる(黙って組み替えない・戻せる)ことを言う
 */
export function saddleOffNote(s: Pick<ProjectSettings, 'printTarget' | 'binding'>): string | null {
  if (s.binding !== 'saddle' || bindingOf(s) === 'saddle') return null;
  return `いまの出し先（${PRINT_TARGETS[s.printTarget].label}）には中綴じがないので、無線綴じで組んでいます。中綴じが作れる出し先に戻すと、中綴じに戻ります`;
}

/**
 * ［本のかたちを決める］の読み上げ。**1〜2行。**(綴じる辺・ノドは、引っかかったときだけ saddleFindings が言う)
 * @param n0 本文のページ数(白いページ・共紙の表紙を含まない)。組み上がっていなければ null
 * @param hasColophon 奥付があるか。白いページは奥付の手前に入る(無ければ最後)
 */
export function saddleReadout(s: ProjectSettings, n0: number | null, hasColophon = true): string {
  const spec = saddleSpecOf(s);
  if (!spec) return '';
  const cover = saddleCoverOf(s);
  const limit = spec.maxPages !== null ? `（上限 ${spec.maxPages}）` : '';
  if (n0 === null) return '本文のページ数は、紙の下見が組み上がると出ます（電子書籍の下見を見ているときは、［紙の本］に切り替えてください）。中綴じは 4 の倍数にそろえます';
  const { pad, coverPages, total } = saddlePad(n0, cover);
  const where = hasColophon ? '奥付の前に' : '最後に';
  const head =
    pad === 0
      ? `いま本文は ${n0} ページで、中綴じの 4 の倍数にそろっています${limit}。`
      : `いま本文は ${n0} ページです。中綴じはページ数を 4 の倍数にするので、${where}白いページを ${pad} ページ入れて ${n0 + pad} ページにします${limit}。`;
  const tail = coverPages > 0 ? `表紙の ${coverPages} ページもこの PDF に入るので、全部で ${total} ページです。` : '';
  return head + tail;
}

/** 共紙のとき、表紙のつくりについての短い知らせ(白黒の本には1行足す) */
export function selfCoverNotes(ink: InkColor): string[] {
  const notes = ['表紙は、本文 PDF の最初と最後のページに入ります。文字も画像と同じ画像になります'];
  if (ink === 'mono') notes.push('白黒の本なので、表紙も本文と同じ白黒で刷られます');
  return notes;
}
