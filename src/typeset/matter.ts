// 後付(著者紹介・奥付)の中身を組み立てる。
// 紙(html.ts)と EPUB(epub.ts)で同じ内容を出すため、文言の生成はここに集約する。
//
// **あとがきは後付ではなく本文の章として書いてもらう。**
// 「あとがき」と書く人ばかりではなく「おわりに」「エピローグ」もあり、
// 章に番号を振らない人もいる。専用の欄を1つ置いても取りこぼすので、
// 章の見出しとして書けばそのまま巻末の章として組まれるようにした
// (importers/txt.ts が「あとがき」「エピローグ」等を章見出しとして拾う)。

import type { Manuscript } from '../models/project';
import { PT_TO_MM, type PageLayout } from './grid';

export const PROFILE_TITLE = '著者紹介';

/**
 * 著者紹介が奥付と同じページに収まるか。収まらない行数を返す(0 なら収まる)。
 *
 * 著者紹介は版面の天から流し、奥付は地に貼ってある。あふれると**奥付に重なる**ので、
 * 数行で書く欄と割り切って逃がす仕掛けは作らず、「04 書き出し」でエラーを出す。
 * (地でひとかたまりに寄せていた時期は、あふれたぶんが黙って消えていた。
 *  下ぞろえの器を Vivliostyle はページ間で分割しないため。flex・table-cell とも同じ)
 *
 * **字数では判定できない。** 段落の変わり目で行が余るので、同じ字数でも
 * 段落の数だけ必要な行数が変わる(実測: 文庫9ptで90字は入り、同じ条件の218字が落ちた)。
 * 段落ごとに行数を数える。
 *
 * 組み上がりを見て判定できればよいが、プレビューは表示中のページしか大きさを持たない。
 * 代わりに css.ts の積み上げをそのまま計算する
 * (実測との差: 文庫9pt・奥付7行で奥付の高さ 53.5mm 見積もりに対し実測 55.0mm)。
 */
export function authorProfileOverflowLines(
  paragraphs: string[],
  rowCount: number,
  l: PageLayout,
): number {
  if (!paragraphs.length) return 0;
  const feed = l.lineFeedPt;
  // css.ts の .colophon-box: padding-top 0.8 + 見出し 1.2 + 見出し下 0.6 + 項目 rowCount 行 + 罫線
  const colophonPt = rowCount ? feed * (0.8 + 1.2 + 0.6 + rowCount) + 0.4 : 0;
  // .profile-box: 見出し1行 + 見出し下 0.3行、下に奥付との間を1行あける
  const overheadPt = feed * (1 + 0.3) + (rowCount ? feed : 0);

  const areaBlockPt = (l.trimH - l.margins.top - l.margins.bottom) / PT_TO_MM;
  const areaInlinePt = (l.trimW - l.margins.gutter - l.margins.fore) / PT_TO_MM;

  const avail = Math.floor((areaBlockPt - colophonPt - overheadPt) / feed);
  const perLine = Math.floor(areaInlinePt / (l.fontPt * 0.9));
  if (perLine < 1) return paragraphs.length;

  // 禁則で1行増えることがあるので1行ぶん余裕をみる。足りないと消えるので余らせる側に外す
  const need = paragraphs.reduce((n, t) => n + Math.ceil(t.length / perLine), 1);
  return Math.max(0, need - avail);
}

/** 著者紹介の段落。空行で区切る。書かれていなければ空配列(=入れない) */
export function authorProfileParagraphs(ms: Manuscript): string[] {
  return (ms.authorProfile ?? '')
    .split(/\r?\n\s*\r?\n/)
    .map((s) => s.replace(/\r?\n/g, '').trim())
    .filter(Boolean);
}

/**
 * 奥付の行。発行日を書いていなければ書き出した日を入れる。
 * ©の年は発行日から拾う(過去日で出しても年がずれない)。
 */
/**
 * **発行日の欄から © の年(西暦)を読む。** 読めなければ undefined(呼び出し側で書き出した年に倒す)。
 *
 * 前は半角の4桁しか拾わず、「令和7年9月25日」「２０２５年」「二〇二五年」などは、書き出した日の年に
 * なっていた(2026-09-25 見直し S2-13。刷り上がった本に違う年が載る)。
 * 全角数字・漢数字(〇一二…と十)・和暦(明治・大正・昭和・平成・令和、元年)を読む
 */
export function copyrightYear(published: string): string | undefined {
  const KANJI: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  // 全角数字を半角に
  let t = published.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 漢数字の並び(二〇二五・三十一・十二)を数字に
  t = t.replace(/[〇零一二三四五六七八九十]+/g, (run) => {
    if (!run.includes('十')) return run.split('').map((c) => String(KANJI[c])).join('');
    const [tens, ones] = run.split('十');
    return String((tens ? KANJI[tens] ?? 1 : 1) * 10 + (ones ? KANJI[ones] ?? 0 : 0));
  });
  const era = /(明治|大正|昭和|平成|令和)\s*(元|\d{1,2})\s*年/.exec(t);
  if (era) {
    const base: Record<string, number> = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };
    return String(base[era[1]] + (era[2] === '元' ? 1 : Number(era[2])));
  }
  return /\d{4}/.exec(t)?.[0];
}

export function colophonRows(ms: Manuscript, now: Date = new Date()): string[] {
  const published = (ms.published ?? '').trim();
  const dateStr = published || `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  // 必ず出るのは発行日と著者だけ。以降は書いた欄だけが並ぶ
  // (個人出版では発行所も印刷所も ISBN も無いことが多い)
  const rows = [`発行日　${dateStr}`];
  if (ms.author) rows.push(`著者　${ms.author}`);
  if (ms.publisher?.trim()) rows.push(`発行所　${ms.publisher.trim()}`);
  if (ms.printer?.trim()) rows.push(`印刷　${ms.printer.trim()}`);
  if (ms.isbn?.trim()) rows.push(`ISBN　${ms.isbn.trim()}`);
  for (const line of (ms.colophonExtra ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (t) rows.push(t);
  }
  const year = copyrightYear(published) ?? String(now.getFullYear());
  rows.push(`©${year} ${ms.author || ''}`.trimEnd());
  return rows;
}
