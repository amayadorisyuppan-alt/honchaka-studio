// 原稿ファイルの読み込みと、取り込み済み原稿の組み直し。
// 取込処理(章検出・記法の除去など)を直したとき、保存済みの原稿を
// 現在の処理で組み直せるように、元ファイルを SourceFile として保持する。

import type { SourceFile } from '../models/project';
import { parseDocx } from './docx';
import { parseMd } from './md';
import { parseTxt } from './txt';
import { EMPTY_FILE_MESSAGE, friendlyDocxError, isBlankText, sourceBytesProblem } from './fileCheck';
import { guardManuscript, type ColumnPageText } from './guard';
import { optimizeBodyImages } from './bodyImages';
import type { ImportResult } from './result';

function kindOf(fileName: string): SourceFile['kind'] {
  if (/\.docx$/i.test(fileName)) return 'docx';
  if (/\.md$/i.test(fileName)) return 'md';
  return 'txt';
}

/**
 * 読めない形式と、その抜け道。
 *
 * 拡張子が分からないものは txt として読むので、Pages や PDF を選ぶと
 * 中身のバイナリがそのまま原稿として並んでしまう。何が起きたか分からないまま
 * 終わるより、直し方まで出す。**Google ドキュメントは Word(.docx)でダウンロードしてもらう。
 * ほかの道具(Pages など)で書いた原稿はテキスト(.txt)にしてもらう**(小見出しやルビの記号は、AI に書き足してもらって .md にする)
 * (2026-10-13 ユーザー決定: ルビ・見出しの読み取りは Word だけの特別対応。ほかの道具の .docx には広げない)
 * (2026-10-13 ユーザー決定: Google ドキュメントは Word(.docx)だけをすすめる。動画の案内と同じ。Google の .docx は Word と同じ読み方で
 *  見出しと画像がそのまま入るので、特別な扱いは足していない。Markdown の書き出しは画像が画面用の写しに縮み、10/13 には本が止まった)
 * (2026-10-13 ユーザーの実機の試し: Pages には Markdown の書き出しが無く、「Word」への書き出しは章に分かれない。
 *  だから Pages は「テキスト」への書き出しだけを言う。odt・rtf も、まずテキスト。くわしくはヘルプの「Word 以外で書いた原稿」)
 */
const CANT_READ: Record<string, string> = {
  pages: 'Pages の「ファイル」→「書き出す」→「標準テキスト」で書き出したファイル（.txt）を選んでください（「Word」に書き出したファイルは、章に分かれません）。くわしくは［ヘルプ］の「Word 以外で書いた原稿」をご覧ください',
  gdoc: 'Google ドキュメントで原稿を開き、「ファイル」→「ダウンロード」→「Microsoft Word（.docx）」で保存したファイルを選んでください（くわしくは［ヘルプ］の「Word 以外で書いた原稿」をご覧ください）',
  odt: 'この形式はそのままでは読み込めません。テキスト（.txt）として保存してから取り込んでください（くわしくは［ヘルプ］の「Word 以外で書いた原稿」をご覧ください）',
  doc: '古い Word 形式です。Word で開いて［名前を付けて保存］から .docx にしてください',
  rtf: 'Word で開いて .docx として保存し直すか、テキスト（.txt）にしてから入れてください（くわしくは［ヘルプ］の「Word 以外で書いた原稿」をご覧ください）',
  pdf: 'PDF からは取り込めません。元の原稿を .docx か .txt で用意してください',
  epub: 'EPUB からは取り込めません。元の原稿を .docx か .txt で用意してください',
};

// docx はバイナリなので、IndexedDB に JSON で保存できるよう Base64 にする。
// 一気に String.fromCharCode へ渡すと引数が多すぎて落ちるため分割する
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * **テキストの原稿の文字コードを見分けて読む。**(2026-09-25 見直し S2-15)
 *
 * 前は UTF-8 と決め打ちしていて、Windows のメモ帳で「ANSI」(Shift_JIS)で保存した原稿や、EUC-JP、
 * BOM の無い UTF-16 の原稿は、黙って大部分が化けた(205字中120字が「�」など。画面は取り込み成功と言う)。
 * 1. BOM があればそれに従う
 * 2. 0x00 が偶数か奇数の位置にだけ多く並んでいれば、BOM の無い UTF-16
 * 3. UTF-8 として壊れていなければ UTF-8
 * 4. だめなら Shift_JIS、次に EUC-JP を、どちらも「壊れていないか」で試す
 * どれでも読めなければ、直し方を添えて止める(化けた字のまま進めない)
 */
export function decodeText(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  const tryDecode = (label: string, fatal: boolean) => {
    try {
      return new TextDecoder(label, { fatal }).decode(b);
    } catch {
      return null;
    }
  };
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const n = Math.min(b.length, 4096);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i++) if (b[i] === 0) (i % 2 ? oddZero++ : evenZero++);
  if (n >= 4 && oddZero > n / 8 && evenZero < oddZero / 4) return tryDecode('utf-16le', false) ?? '';
  if (n >= 4 && evenZero > n / 8 && oddZero < evenZero / 4) return tryDecode('utf-16be', false) ?? '';
  const utf8 = tryDecode('utf-8', true);
  if (utf8 !== null) return utf8;
  // EUC-JP のバイト列は Shift_JIS としても壊れずに読めてしまうことがある(半角カナの羅列になる)。
  // 両方読めたら、ひらがなの多いほうを採る
  const hira = (t: string) => (t.match(/[ぁ-ゟ]/g) ?? []).length;
  const cands = ['shift_jis', 'euc-jp']
    .map((label) => tryDecode(label, true))
    .filter((t): t is string => t !== null)
    .sort((a, c) => hira(c) - hira(a));
  if (cands.length) return cands[0];
  // BOM の無い UTF-16。日本語ばかりの文だと 0x00 がほとんど出ず、上の見分けに掛からない。
  // 両方の並びで読んでみて、日本語の字(ひらがな・カタカナ・漢字)が大半を占めるほうを採る
  const jp = (t: string) => (t.match(/[ぁ-ゟ゠-ヿ一-鿿]/g) ?? []).length / Math.max(1, t.length);
  const u16 = ['utf-16le', 'utf-16be']
    .map((label) => tryDecode(label, true))
    .filter((t): t is string => t !== null)
    .sort((a, c) => jp(c) - jp(a));
  if (u16.length && jp(u16[0]) > 0.3) return u16[0];
  throw new Error(
    '文字コードを読み取れませんでした。メモ帳なら［名前を付けて保存］で文字コードを「UTF-8」にして保存し直してください',
  );
}

/** 選択されたファイルを SourceFile にする(パースはまだしない) */
export async function readSource(file: File): Promise<SourceFile> {
  const ext = (/\.([^.]+)$/.exec(file.name)?.[1] ?? '').toLowerCase();
  // 表の自分のキーだけ引く。`.constructor` のような拡張子で Object の元の関数が出ないように(2026-10-13 修正リスト 26)
  const help = Object.prototype.hasOwnProperty.call(CANT_READ, ext) ? CANT_READ[ext] : undefined;
  if (help) throw new Error(`.${ext} は読めません。${help}`);
  const kind = kindOf(file.name);
  const name = file.name.replace(/\.[^.]+$/, '');
  const buf = await file.arrayBuffer();
  // 空・パスワード付きの Word・壊れた zip・Word でない zip は、jszip や mammoth の英語の文が出る前に日本語で断る。
  // 空の .txt / .md も、前は何も言わずに空の本になったので断る(取り込まない)。1行だけ・見出しだけは今までどおり取り込む
  // (2026-10-13 修正リスト 28。見分けは importers/fileCheck.ts)
  const problem = await sourceBytesProblem(kind, buf);
  if (problem) throw new Error(problem);
  if (kind === 'docx') return { name, kind, data: toBase64(buf) };
  const data = decodeText(buf);
  if (isBlankText(data)) throw new Error(EMPTY_FILE_MESSAGE);
  return { name, kind, data };
}

/** 形式ごとのパース。見張り(guard.ts)を通す前のもの */
async function parseByKind(src: SourceFile): Promise<ImportResult> {
  if (src.kind === 'docx') {
    // mammoth の英語の文(「Could not find main document part」など)を、そのまま画面に出さない(2026-10-13 修正リスト 28)
    try {
      return await parseDocx(fromBase64(src.data), src.name);
    } catch (e) {
      throw new Error(friendlyDocxError(e));
    }
  }
  // .md / .txt も、言っておくことがあれば notes に足してもらう(Word と同じく画面に出す)
  const notes: string[] = [];
  if (src.kind === 'md') {
    const manuscript = parseMd(src.data, src.name, notes);
    // .md の中に入っていた絵(Google ドキュメントの書き出しなど)も、Word の絵と同じく刷るのに要る大きさ・形にそろえる。
    // parseMd は同期のまま(検査で node から回す)なので、ここで直す(2026-10-13)
    await optimizeBodyImages(manuscript.chapters);
    return { manuscript, skippedColumnPages: [], notes };
  }
  return { manuscript: parseTxt(src.data, src.name, notes), skippedColumnPages: [], notes };
}

/**
 * SourceFile を現在の取込処理でパースする。取り込み(App の handleFile)と［原稿を組み直す］(store の reparse)の両方が通る。
 *
 * 返すのは原稿だけではなく、**本文に入れなかったものの断り**も含む。
 * .txt / .md にはコラムの目印が無いので、skippedColumnPages は常に空。
 *
 * **どの形式も、組版へ渡す前に見張り(guard.ts)を通す。**(2026-10-13)
 * 字に置き換えた画像などのデータは取り除いて notes で言う。組版が止まるほど大きい原稿(改行の抜けた5万字以上の段落・
 * 100万字以上)は、断りの文を Error にして投げる(画面は取り込みの失敗として出す。原稿は入れ替えない)。
 *
 * @param columnPages 取り込んだあとも本に残るコラムページ。原稿と一緒に組まれるので、字数に入れる
 *   (入口の画面の「◯字」と同じ。2026-10-13 見直し)
 */
export async function parseSource(src: SourceFile, columnPages: readonly ColumnPageText[] = []): Promise<ImportResult> {
  const result = await parseByKind(src);
  const guard = guardManuscript(result.manuscript, columnPages);
  if (guard.error) throw new Error(guard.error);
  return { ...result, manuscript: guard.manuscript, notes: [...(result.notes ?? []), ...guard.notes] };
}

export type { ImportResult };
