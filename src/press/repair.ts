// pdf-lib で開いたときに、**1〜2バイト欠けてしまうストリームを元に戻す。**(Ghostscript の出力・ほかの道具が書いた PDF)
//
// 2026-10-01 画面の本から作り直した本文 PDF で見つかった(U-press-ui の実機の検査)。
// Ghostscript は、ページの描く命令のように圧縮しながら書くストリームの長さを、あとから書く
// (`/Length 7 0 R`。長さの値は別のオブジェクト)。しかも `stream … データ endstream` のあいだに改行を入れない。
// pdf-lib は /Length が直の数でないと、`endstream` の手前の改行(\n・\r・\r\n)を「区切り」とみなして削る。
// ところが Flate の末尾(adler32 の最後のバイト)がたまたま 0x0A や 0x0D だと、その**データ自身を区切りと取り違えて**
// 1バイト削ってしまう(確率は 1/128 のストリームごと。39ページの本で 27% の本に当たる。260ページの本は 87% が少なくとも1か所に当たる)。
// 削られたストリームは Flate が閉じておらず、content.ts の readStream が「壊れている」と言い、
// そのページはインクの量も色も測れず、カラーのページの一覧からも落ちた(color-a5 の13ページ)。
// ページの中身だけでなく、画像・ICC・Form も同じ書き方なので、**間接の /Length を持つストリーム全部**が対象。
//
// 直し方: pdf-lib が読み終えたあと、/Length(この時点で数に解決できる)より短いストリームを探し、
// 元のバイト列から正しい長さを取り直す。元の位置は、まず `N G obj` の見出しから `stream` の直後をたどって決める
// (同じ書き出しのストリームが2つあっても取り違えない)。見出しが見つからないときだけ、ストリームの先頭32バイトで探す。
// どちらも、**/Length ぶん進んだ先が `endstream` であること**を確かめてから差し替える。
// 戻せなかったものは、黙らずに failed(利用者向けの呼び名)として返す(pipeline.ts が issues に出す)
import { PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import type { PDFDocument, PDFRef } from 'pdf-lib';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const STREAM = ascii('stream');
const ENDSTREAM = ascii('endstream');

/** bytes の中で needle が最初に現れる位置(from 以降)。無ければ -1 */
function indexOf(bytes: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  for (let i = bytes.indexOf(first, from); i >= 0 && i + needle.length <= bytes.length; i = bytes.indexOf(first, i + 1)) {
    let k = 1;
    while (k < needle.length && bytes[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

/** at から空白(改行を含む)を読み飛ばした先が `endstream` か */
function endsWithEndstream(bytes: Uint8Array, at: number): boolean {
  let i = at;
  while (i < bytes.length && (bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x20)) i++;
  for (let k = 0; k < ENDSTREAM.length; k++) if (bytes[i + k] !== ENDSTREAM[k]) return false;
  return true;
}

/** `N G obj` の見出しの直後の `stream` の、次の位置(=データの先頭)。見つからなければ -1。同じ番号が2度あれば、あとのほう(増分更新の有効な側) */
function dataStartOf(bytes: Uint8Array, ref: PDFRef): number {
  const head = ascii(`${ref.objectNumber} ${ref.generationNumber} obj`);
  let at = -1;
  for (let i = indexOf(bytes, head); i >= 0; i = indexOf(bytes, head, i + 1)) {
    // `12 0 obj` が `112 0 obj` の末尾に当たったものは除く
    const prev = i === 0 ? 0x0a : bytes[i - 1];
    if (prev >= 0x30 && prev <= 0x39) continue;
    at = i;
  }
  if (at < 0) return -1;
  const kw = indexOf(bytes, STREAM, at + head.length);
  if (kw < 0) return -1;
  let p = kw + STREAM.length;
  // pdf-lib と同じく、`stream` のあとの \r\n・\n・\r を1つ読み飛ばす
  if (bytes[p] === 0x0d && bytes[p + 1] === 0x0a) p += 2;
  else if (bytes[p] === 0x0a || bytes[p] === 0x0d) p += 1;
  return p;
}

/** 戻せなかったストリームを、利用者に言う呼び名にする */
function labelOf(ref: PDFRef, obj: PDFRawStream): string {
  const sub = obj.dict.lookup(PDFName.of('Subtype'));
  const what = sub === PDFName.of('Image') ? '画像' : sub === PDFName.of('Form') ? 'フォーム' : obj.dict.get(PDFName.of('N')) ? '色の基準(ICC)' : 'データ';
  return `${what} ${ref.toString()}`;
}

export interface RepairResult {
  /** 欠けを戻したストリームの数 */
  repaired: number;
  /** 欠けているのに戻せなかったストリーム(「画像 12 0 R」のような呼び名) */
  failed: string[];
}

/**
 * 欠けたストリームを直す。
 * @param bytes doc を開くのに使った元のバイト列(Ghostscript の出力)
 */
export function repairTruncatedStreams(doc: PDFDocument, bytes: Uint8Array): RepairResult {
  let repaired = 0;
  const failed: string[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const len = obj.dict.lookup(PDFName.of('Length'));
    if (!(len instanceof PDFNumber)) continue;
    const want = len.asNumber();
    const have = obj.contents.byteLength;
    // 欠けるのは区切りと取り違えた改行だけ(\n か \r で1バイト、\r\n で2バイト)。それ以外の食い違いも、取り直せるか試す
    if (!(want > have)) continue;
    let start = dataStartOf(bytes, ref);
    // 見出しから決めた先頭が、pdf-lib が読んだ中身の先頭と合うか(合わなければ別物を指している)
    const probe = Math.min(have, 32);
    const sameHead = (s: number) => {
      if (s < 0) return false;
      for (let k = 0; k < probe; k++) if (bytes[s + k] !== obj.contents[k]) return false;
      return true;
    };
    if (!sameHead(start) || !(start + want <= bytes.length) || !endsWithEndstream(bytes, start + want)) {
      start = have >= 32 ? indexOf(bytes, obj.contents.subarray(0, 32)) : -1;
    }
    if (start < 0 || start + want > bytes.length || !sameHead(start) || !endsWithEndstream(bytes, start + want)) {
      failed.push(labelOf(ref, obj));
      continue;
    }
    doc.context.assign(ref, PDFRawStream.of(obj.dict, bytes.slice(start, start + want)));
    repaired++;
  }
  return { repaired, failed };
}
