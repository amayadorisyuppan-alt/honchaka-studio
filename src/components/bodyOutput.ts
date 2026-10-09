// ［紙の本文］で「何を出すか」を、出し先 × 刷り色で決める1か所(2026-10-03)。
//
// 画面(PaperBodyExport)・ファイル名・グレーの直しの有無は、みなここから読む。
// 出し先の名前では分けない。PRINT_TARGETS の欄(acceptsRgbPdf・offersGrayForMono・fixesGrayTone)から導く。
// 純関数なので、ブラウザなしで検査できる(scripts/bodyOutput.test.ts)。
import type { InkColor, PrintTargetProfile } from '../models/project';

/**
 * 保存した PDF(RGB)を、入稿用に変換するか。
 *   required … 要る(RGB を受け付けない出し先。その他の印刷所など)。画面は、変換まで本線にする
 *   optional … 任意(RGB のまま入稿できる出し先の、白黒の本だけ。K1色で試したい人の道)。本線は RGB
 *   none     … 変換しない(RGB のまま入稿。KDP のカラー)
 */
export type BodyConvert = 'required' | 'optional' | 'none';

export interface BodyOutput {
  convert: BodyConvert;
  /** 変換の種類。白黒は K1色、カラーは CMYK。変換しない(none)なら null */
  kind: 'k1' | 'cmyk' | null;
  /** ファイル名の末尾。変換しないなら null */
  suffix: 'K1色' | 'CMYK' | null;
  /**
   * 変換のときに、グレーの濃さの直しをするか。
   * **任意の変換(optional)は、必ず直さない。** RGB の PDF と見比べる試しなので、直しが掛かると比べられない(2026-10-02 と同じ決め)。
   * 要る変換(required)は、出し先の fixesGrayTone で決める(省くと直す)
   */
  grayTone: boolean;
}

type OutputFields = Pick<PrintTargetProfile, 'acceptsRgbPdf' | 'offersGrayForMono' | 'fixesGrayTone'>;

export function bodyOutputOf(profile: OutputFields, ink: InkColor): BodyOutput {
  const mono = ink === 'mono';
  const convert: BodyConvert = !profile.acceptsRgbPdf ? 'required' : profile.offersGrayForMono && mono ? 'optional' : 'none';
  if (convert === 'none') return { convert, kind: null, suffix: null, grayTone: false };
  return {
    convert,
    kind: mono ? 'k1' : 'cmyk',
    suffix: mono ? 'K1色' : 'CMYK',
    grayTone: convert === 'optional' ? false : profile.fixesGrayTone !== false,
  };
}

/** 変換した PDF のファイル名(書名の部分は呼ぶ側が安全な形にして渡す) */
export function bodyOutputFileName(stem: string, out: BodyOutput): string {
  return `${stem}_本文_${out.suffix ?? 'RGB'}.pdf`;
}

/**
 * 中綴じの本の、主ボタンを押せない理由。押せるなら null。(2026-10-03)
 * 中綴じは総ページ数が 4 の倍数でなければならない。**そろっていない PDF を印刷所へ渡さない**ために、
 * 数え終わるまで(null)と、4 の倍数にそろうまでは書き出させない。そろえる足し算は App が走らせている(白いページ)ので、
 * 少し待てば押せるようになる。無線綴じの本はこの関数を通さない(いつも押せる)
 * @param pages 紙の本文の総ページ数(白いページ・共紙の表紙を含む)。いまの本の姿で組み上がっていなければ null
 */
export function saddleBlockReason(pages: number | null): string | null {
  if (pages === null) return '中綴じは、本文のページ数が決まってから書き出します。紙の下見が組み上がるまで、少し待ってください（いつまでも出ないときは、下の［紙の本文を確かめる・直す］を押してください）';
  if (pages % 4 !== 0) return 'ページ数を 4 の倍数にそろえています。少し待ってから、もう一度押してください';
  return null;
}

/**
 * 主ボタン(印刷の画面を開く)を押せない理由。押せるなら null。
 * **押せる/押せないの条件はここ1か所**。中綴じの「ページ数が4の倍数でないと書き出せない」などは、blockReason で足す
 * (呼ぶ側が理由の文を渡す。理由があれば、画面は押せなくして、その文を出す)
 */
export function printBlockedReason(o: { printing: boolean; blockReason?: string | null }): string | null {
  if (o.printing) return '組版中です。終わるまでお待ちください';
  return o.blockReason ?? null;
}
