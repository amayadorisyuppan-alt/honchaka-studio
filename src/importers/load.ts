// 原稿ファイルの読み込みと、取り込み済み原稿の組み直し。
// 取込処理(章検出・記法の除去など)を直したとき、保存済みの原稿を
// 現在の処理で組み直せるように、元ファイルを SourceFile として保持する。

import type { SourceFile } from '../models/project';
import { parseDocx, type ImportResult } from './docx';
import { parseMd } from './md';
import { parseTxt } from './txt';

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
 * 終わるより、.docx への直し方まで出す。どのワープロも .docx で書き出せる
 */
const CANT_READ: Record<string, string> = {
  pages: 'Pages の［ファイル → 書き出す → Word］で .docx にしてください',
  gdoc: 'Google ドキュメントの［ファイル → ダウンロード → Microsoft Word (.docx)］で保存したものを選んでください',
  odt: 'LibreOffice などで［Word 2007-365 (.docx)］として保存し直してください',
  doc: '古い Word 形式です。Word で開いて［名前を付けて保存］から .docx にしてください',
  rtf: 'Word や Pages で開いて .docx として保存し直してください',
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
  const help = CANT_READ[ext];
  if (help) throw new Error(`.${ext} は読めません。${help}`);
  const kind = kindOf(file.name);
  return {
    name: file.name.replace(/\.[^.]+$/, ''),
    kind,
    data: kind === 'docx' ? toBase64(await file.arrayBuffer()) : decodeText(await file.arrayBuffer()),
  };
}

/**
 * SourceFile を現在の取込処理でパースする。
 *
 * 返すのは原稿だけではなく、**本文に入れなかったものの断り**も含む。
 * .txt / .md にはコラムの目印が無いので、そちらは常に空
 */
export async function parseSource(src: SourceFile): Promise<ImportResult> {
  if (src.kind === 'docx') return parseDocx(fromBase64(src.data), src.name);
  if (src.kind === 'md') return { manuscript: parseMd(src.data, src.name), skippedColumnPages: [] };
  return { manuscript: parseTxt(src.data, src.name), skippedColumnPages: [] };
}

export type { ImportResult };
