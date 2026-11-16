// 後付(著者紹介・奥付)の中身を組み立てる。
// 紙(html.ts)と EPUB(epub.ts)で同じ内容を出すため、文言の生成はここに集約する。
//
// **あとがきは後付ではなく本文の章として書いてもらう。**
// 「あとがき」と書く人ばかりではなく「おわりに」「エピローグ」もあり、
// 章に番号を振らない人もいる。専用の欄を1つ置いても取りこぼすので、
// 章の見出しとして書けばそのまま巻末の章として組まれるようにした
// (importers/txt.ts が「あとがき」「エピローグ」等を章見出しとして拾う)。

import QRCode from 'qrcode';
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
  /** 奥付に QR コードを載せるか。載せると奥付が QR_SIZE_MM と上のアキのぶん高くなる */
  qr = false,
): number {
  if (!paragraphs.length) return 0;
  const feed = l.lineFeedPt;
  // css.ts の .colophon-box: padding-top 0.8 + 見出し 1.2 + 見出し下 0.6 + 項目 rowCount 行 + 罫線
  // (+ QR コードの上のアキ QR_GAP_FEED 行 + QR コードの高さ)
  const qrPt = rowCount && qr ? feed * QR_GAP_FEED + QR_SIZE_MM / PT_TO_MM : 0;
  const colophonPt = rowCount ? feed * (0.8 + 1.2 + 0.6 + rowCount) + 0.4 + qrPt : 0;
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

/**
 * 奥付に入れる組版の行(2026-11-07)。「本ちゃか」で組んだ本に、どの道具で組んだかを1行残す。
 * `Manuscript.typesetCredit` が真のときだけ colophonRows が足す。
 * 画面(ColophonStep のチェック)・ヘルプ・検査が同じ文言を指せるように、ここ1か所に持つ
 */
export const TYPESET_CREDIT_ROW = '組版　本ちゃか（ひっちゃか本づくりスタジオ）';

export function colophonRows(ms: Manuscript, now: Date = new Date()): string[] {
  const published = (ms.published ?? '').trim();
  const dateStr = published || `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  // 必ず出るのは発行日と著者だけ。以降は書いた欄だけが並ぶ
  // (個人出版では発行所も印刷所も ISBN も無いことが多い)
  const rows = [`発行日　${dateStr}`];
  if (ms.author) rows.push(`著者　${ms.author}`);
  if (ms.publisher?.trim()) rows.push(`発行所　${ms.publisher.trim()}`);
  // 組版の行は発行所の次・印刷の前(どちらも無ければ著者の次)。欄が真のときだけ。無い・偽なら今までどおり
  if (ms.typesetCredit) rows.push(TYPESET_CREDIT_ROW);
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

// ---- 奥付の QR コード(2026-11-15) ----
//
// 電子版の案内ページや Web サイトへの URL を、奥付の最後に QR コードで載せる。
// **画像は原稿に保存しない。** 組むたびに colophonUrl から作る(作るのは同期で一瞬)。
// 保存すると URL と画像が食い違う道(取り消し・取り込み直し・別の画面での変更)ができるうえ、
// 作り直すたびに取り消しの履歴へ余計な手が積まれる。
// 紙(html.ts)は data URI のまま <img> に、EPUB(epub.ts)は ImageResolver で ZIP 内の
// SVG ファイルにして manifest に載せる(data URI のままだと Kindle の変換が止まる)。

/** 奥付に刷る QR コードの一辺(mm)。周りの白いアキ(QR_QUIET モジュール)も含む */
export const QR_SIZE_MM = 18;
/** QR コードの上のアキ(行送りに対する割合)。css.ts と著者紹介のあふれの見積もりで共有する */
export const QR_GAP_FEED = 0.6;
/** 周りの白いアキ(モジュール数)。規格の下限は 4。背景の絵に接しても読めるように入れる */
const QR_QUIET = 4;
/**
 * 1モジュールがこれより細いと、家庭用・オンデマンド印刷のにじみで読めないことがある(mm)。
 * 18mm に収めるので、URL が長いほど細くなる。下回ったら画面で短い URL を勧める
 */
export const QR_MIN_MODULE_MM = 0.33;

export interface ColophonQr {
  /** QR コードにした文字(前後の空白を落とした URL)。代替テキストに使う */
  text: string;
  /** 奥付に埋める SVG の data URI */
  dataUri: string;
  /** 1モジュールの大きさ(mm) */
  moduleMm: number;
}

/** 前回の結果。組版は打つたびに何度も呼ぶので、同じ URL なら作り直さない */
let qrCache: { text: string; qr: ColophonQr | null } | null = null;

/**
 * 奥付の QR コード。URL が空、または長すぎて QR コードにできなければ null。
 * 誤り訂正は M(15%)。汚れ・かすれにはある程度耐え、L より密度が上がりすぎない
 */
export function colophonQr(ms: Manuscript): ColophonQr | null {
  const text = (ms.colophonUrl ?? '').trim();
  if (!text) return null;
  if (qrCache?.text === text) return qrCache.qr;
  let qr: ColophonQr | null = null;
  try {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = modules.size;
    const side = n + QR_QUIET * 2;
    // 黒いモジュールを1本の path にまとめる(1マス1要素だと数百〜千を超える)
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (modules.get(r, c)) d += `M${c + QR_QUIET} ${r + QR_QUIET}h1v1h-1z`;
      }
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" ` +
      `width="${QR_SIZE_MM}mm" height="${QR_SIZE_MM}mm" shape-rendering="crispEdges">` +
      `<rect width="${side}" height="${side}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    qr = { text, dataUri: `data:image/svg+xml,${encodeURIComponent(svg)}`, moduleMm: QR_SIZE_MM / side };
  } catch {
    // 入る量を超えた(qrcode が投げる)。奥付には出さず、画面で知らせる
    qr = null;
  }
  qrCache = { text, qr };
  return qr;
}
