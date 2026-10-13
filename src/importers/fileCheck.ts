// 原稿のファイルを、読む前に頭の数バイトで見分けて、読めないときは日本語で断る。
// (2026-10-13 修正リスト 28)
//
// 前は、壊れた .docx・0 バイトの .docx・Word でない zip・パスワード付きの Word を選ぶと、
// jszip や mammoth の英語の文(「Can't find end of central directory : is this a zip file ?」と
// ドキュメントへのリンク、「Could not find main document part. Are you sure this is a valid .docx document?」)が
// そのまま「取り込みに失敗しました:」のあとに出ていた。何が悪くて何をすればよいかが分からない。
//
// - パスワード付きの Word(.docx)は、中身が zip ではなく OLE という別の器に入る。頭が D0 CF 11 E0 A1 B1 1A E1。
//   古い形式の .doc も同じ器なので、「パスワード付きか、古い .doc」として直し方を2つ言う
// - 空の .txt / .md は、前は何も言わずに空の本になった。断る(取り込まない)。1行だけ・見出しだけは今までどおり取り込む
//
// ここは画面の部品に触らない(バイト列と JSZip だけ)ので、単体の検査(scripts/fileSniff.test.ts)で回せる。
// 画面(App)は、ここが返す日本語の文を出すだけ。

import JSZip from 'jszip';

export const EMPTY_FILE_MESSAGE = 'ファイルの中身が空でした。文章の入ったファイルを選んでください';

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04], // 中身のある zip
  [0x50, 0x4b, 0x05, 0x06], // 空の zip
  [0x50, 0x4b, 0x07, 0x08], // 分割 zip
];
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const startsWith = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);

/** 頭の数バイトで見分けた、原稿ファイルの器 */
export type ContainerKind = 'empty' | 'zip' | 'ole' | 'other';

export function sniffContainer(head: Uint8Array): ContainerKind {
  if (head.length === 0) return 'empty';
  if (ZIP_SIGNATURES.some((s) => startsWith(head, s))) return 'zip';
  if (startsWith(head, OLE_SIGNATURE)) return 'ole';
  return 'other';
}

const FIX_HOW = 'Word で開き直して、［名前を付けて保存］から .docx で保存し直してみてください';

/**
 * .docx として選ばれたファイルの、頭の数バイトで分かる断り。読めそうなら null。
 * 空・パスワード付きの Word(または古い .doc)・zip でないもの
 */
export function docxHeadProblem(head: Uint8Array): string | null {
  switch (sniffContainer(head)) {
    case 'empty':
      return EMPTY_FILE_MESSAGE;
    case 'ole':
      return (
        'パスワードがかかった Word か、古い形式（.doc）の Word のようです。' +
        'パスワードを外すか、.docx で保存し直してから選んでください' +
        '（パスワードは、Windows の Word なら［ファイル］→［情報］→［文書の保護］→［パスワードを使用して暗号化］、' +
        'Mac の Word なら［校閲］→［文書の保護］で空にします）'
      );
    case 'other':
      return `Word（.docx）のファイルとして読み込めません。壊れているか、Word ではないファイルのようです。${FIX_HOW}`;
    default:
      return null;
  }
}

/** zip の中身を見て Word でないと分かったときの、何のファイルかの呼び名 */
function whatIsZip(names: string[], contentTypes: string): string {
  if (/spreadsheetml/.test(contentTypes) || names.some((n) => n.startsWith('xl/'))) return 'Excel';
  if (/presentationml/.test(contentTypes) || names.some((n) => n.startsWith('ppt/'))) return 'PowerPoint';
  if (names.includes('mimetype') && names.some((n) => n === 'content.xml')) return 'OpenDocument（.odt など）';
  if (names.includes('META-INF/container.xml')) return 'EPUB';
  return '';
}

/**
 * zip として開けるか、Word の中身が入っているかを確かめる。読めそうなら null。
 * (頭の数バイトで zip と分かったあとに呼ぶ。壊れた zip・Word でない zip を日本語で断る)
 */
export async function docxZipProblem(buf: ArrayBuffer): Promise<string | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return `Word のファイルが壊れていて読み込めません（ダウンロードやコピーの途中で途切れたのかもしれません）。元のファイルをもう一度用意するか、${FIX_HOW}`;
  }
  const names = Object.keys(zip.files);
  const ct = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  const isWord = /wordprocessingml/.test(ct) || names.some((n) => /^word\/[^/]+\.xml$/.test(n) && /document/i.test(n));
  if (isWord) return null;
  const what = whatIsZip(names, ct);
  return what
    ? `${what} のファイルで、Word（.docx）ではありません。Word の原稿を選んでください`
    : 'Word（.docx）ではない zip ファイルです。Word の原稿を選んでください';
}

/**
 * **原稿のファイルを読む前の確かめ。** 読めそうなら null、読めないなら日本語の断りの文。
 * `kind` は拡張子で決めた種類(importers/load.ts の kindOf)。
 * - .docx: 空・パスワード付きの Word・壊れた zip・Word でない zip
 * - .txt / .md: 0 バイト(空白だけの中身は、文字に直したあと isBlankText で見る)
 */
export async function sourceBytesProblem(kind: 'docx' | 'md' | 'txt', buf: ArrayBuffer): Promise<string | null> {
  if (kind !== 'docx') return buf.byteLength === 0 ? EMPTY_FILE_MESSAGE : null;
  return docxHeadProblem(new Uint8Array(buf, 0, Math.min(buf.byteLength, 8))) ?? (await docxZipProblem(buf));
}

/**
 * mammoth などが投げた英語の文を、日本語の断りにする(Word の中身が読めなかったとき)。
 * もう日本語になっている文(スタジオが投げた文)はそのまま返す
 */
export function friendlyDocxError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/[぀-ヿ一-鿿]/.test(msg)) return msg;
  return `Word の中身を読み取れませんでした（ファイルが壊れているか、Word ではない可能性があります）。${FIX_HOW}`;
}

/** 原稿の文字が空(空白・改行・BOM だけを含む)か */
export function isBlankText(text: string): boolean {
  return text.replace(/[\s﻿​]+/g, '') === '';
}
