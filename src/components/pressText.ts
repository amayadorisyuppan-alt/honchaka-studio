// 入稿用の変換の画面(本文の PressConvert・表紙の PressCover)で、同じ言い方をそろえるための小さな部品。
//
// 画面の言葉は、本を作るのがはじめての人に分かる言葉にする(2026-10-01)。
// 「RGB」「CMYK」「K」は使うが、PDF の中身の話(OutputIntent・TrimBox など)は画面に出さない。
import { paperSizeText } from '../press/paper.ts';
import type { PressErrorOrigin, PressKind, PressProgress } from '../press/press';
import type { InkReport, PaperMismatch } from '../press/types';

/** 変換のあとの大きさ。MB で、小数1けた */
export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * ページ番号の一覧を「1, 3, 13〜16, 18〜28」の形にする。連続する番号は「〜」でまとめる。
 * 印刷所の見積りで「カラーは何ページ・どのページか」を聞かれたときに、そのまま読み上げられるように
 */
export function pageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}〜${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

/** カラーのページの報告(本文のカラーの本)。ページが無い・全部のときは言い分けて、一覧は出さない */
export function colorPagesSentence(colorPages: number[], total: number): string {
  if (colorPages.length === 0) return 'カラーのページはありませんでした。全ページが黒インクだけです。';
  if (colorPages.length >= total) return `全 ${total} ページがカラーです。`;
  return `カラーのページ: ${pageRanges(colorPages)}（${colorPages.length}ページ）。それ以外は黒インクだけです。`;
}

/**
 * インクを抑えたときの一言。**抑える所が無かった(元から上限以下)なら null**(言わない)。
 * 数字は四捨五入で言うが、四捨五入すると上限と同じになる(300.4% → 300%)ときは小数1けたで言う
 */
export function inkSentence(ink: InkReport | null): string | null {
  if (!ink || ink.maxBefore <= ink.limit + 0.01) return null;
  const before = Math.round(ink.maxBefore) > ink.limit ? String(Math.round(ink.maxBefore)) : ink.maxBefore.toFixed(1);
  // 「インク」だけだと、黒インクの濃さのことにも読める。4色(C・M・Y・K)を重ねた合計の量であることを言う(2026-10-01 4-2)
  return `いちばん濃い所のインク（4色の合計）を ${before}% から ${ink.limit}% に抑えました。`;
}

/** 進み具合の文。段(読み込み・下ごしらえ・変換・仕上げ・点検)ごとに言い分ける */
export function progressText(kind: PressKind, p: PressProgress): string {
  switch (p.phase) {
    case 'load':
      return '変換の道具を読み込んでいます…';
    case 'prepare':
      // 下ごしらえで色を書き換えるのはカラーの本文だけ。白黒の本文と表紙は、PDF の中身(ページ数・パスワード)を確かめる段
      return kind === 'body-cmyk' ? '色を調べて、変換の下ごしらえをしています…' : 'PDF の中身を確かめています…';
    case 'convert': {
      const what = kind === 'body-gray' ? 'K1色' : kind === 'body-cmyk' ? 'CMYK ' : '色を印刷用（CMYK）';
      // 表紙は1ページだけなので「1 / 1 ページ」とは言わない
      const count = kind !== 'cover-cmyk' && p.page ? ` ${p.page}${p.total ? ` / ${p.total}` : ''} ページ` : '';
      return `${what}に変換しています…${count}`;
    }
    case 'finish':
      return '印刷所へ出せる形（PDF/X-4）に整えています…';
    case 'check':
      return kind === 'body-gray'
        ? 'K 以外の色が残っていないか確かめています…'
        : 'インクの量と、カラーのページを確かめています…';
  }
}

/**
 * 帯の進み具合(0〜1)。分母が分からない段(道具の読み込み・下ごしらえ)は null(縞の帯で「動いている」ことだけ見せる)。
 * **仕上げ(finish)と点検(check)は満ちたまま**にする。Ghostscript が終わった(=100%)あと、仕上げで帯が縞に戻ると、
 * 巻き戻ったように見える(2-3 の 7)
 */
export function progressRatio(p: PressProgress): number | null {
  if (p.phase === 'convert' && p.page && p.total) return p.page / p.total;
  return p.phase === 'finish' || p.phase === 'check' ? 1 : null;
}

/**
 * 変換に失敗したときの文。**原因に合う助言だけを付ける。**
 *   file     ファイルが原因: 「選んだファイルを確かめてください」(これを全部の失敗に付けると、道具の読み込みの失敗まで利用者のせいに聞こえる)。
 *            message だけで次にすることまで言えているとき(complete)は、足さない(「外して保存し直して」と「確かめて」が重なっていた)
 *   tool     変換の道具の読み込み: 文そのものが助言(通信・読み込み直し)を含む
 *   internal 途中で止まった: ページの読み込み直し
 * message は、変換の側が日本語にしてある(英語の生のエラーはコンソールへ回してある)
 */
export function failureText(origin: PressErrorOrigin | undefined, message: string, complete = false): string {
  if (origin === 'file') {
    if (complete) return message;
    // 「保存した PDF」は、変換のあとの PDF も指すので、どの PDF かを言う(印刷ダイアログで保存した本文 PDF)
    return `${message}。選んだファイルが、印刷の画面で保存した本文 PDF か確かめてください。直らないときは、ページの再読み込みのあとにもう一度お試しください`;
  }
  if (origin === 'tool') return message;
  return `${message}。ページを読み込み直して、もう一度お試しください`;
}

/**
 * 紙の大きさが、いまの本の用紙と違うときの文。画面(PressConvert)が、変換の前に断ったとき('before')と、
 * 変換のあとの守りで見つけたとき('after')で言い分ける。大きさは「111×154mm」の形(小数が .0 のときは整数で)
 */
export function paperMismatchText(pm: PaperMismatch, when: 'before' | 'after'): string {
  const where = pm.pages.includes(1) || pm.pages.length === 0 ? '選んだ PDF の' : `選んだ PDF の ${pageRanges(pm.pages)} ページの`;
  const stopped = when === 'before' ? '変換せずに止めました' : '保存しませんでした';
  return (
    `${where}紙の大きさ（${paperSizeText(pm.actualMm)}）が、いまの本の用紙（${paperSizeText(pm.expectedMm)}）と違います。${stopped}。` +
    '別の本の PDF か、判型や塗り足しを変える前に保存した PDF かもしれません。' +
    '上のボタンで書き出し直して、保存した PDF をもう一度渡してください'
  );
}

/** 失敗の例外から、紙の大きさの違い(値)を取り出す。無ければ null */
export function paperMismatchOf(e: unknown): PaperMismatch | null {
  const v = (e as { paperMismatch?: PaperMismatch })?.paperMismatch;
  return v && Array.isArray(v.pages) && v.actualMm && v.expectedMm ? v : null;
}

/** 失敗の例外が、文だけで次にすることまで言えている(complete)か */
export function completeOf(e: unknown): boolean {
  return (e as { complete?: unknown })?.complete === true;
}

/** 失敗の例外から、原因を取り出す(PressFailure 以外は、原因が分からない) */
export function originOf(e: unknown): PressErrorOrigin | undefined {
  const o = (e as { origin?: unknown })?.origin;
  return o === 'file' || o === 'tool' || o === 'internal' ? o : undefined;
}

/** 入稿の前に確かめることが長く続くと読めないので、先頭の数件だけ見せて、残りは「ほか ○ 件」にする */
export function issueLines(issues: string[], max = 3): { shown: string[]; more: number } {
  return { shown: issues.slice(0, max), more: Math.max(0, issues.length - max) };
}

/** 保存したあとの見出し。確かめることが在るときは、「できました」と言い切らない(言い切ると、下の警告を読み飛ばされる) */
export function savedHeadline(hasCheck: boolean): string {
  return hasCheck ? '保存しましたが、入稿の前に確かめることがあります。' : 'できました。';
}
