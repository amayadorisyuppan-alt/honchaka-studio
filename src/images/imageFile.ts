// 利用者が選んだ画像のファイルを、取り込む前に頭の数バイトで見分ける。
// (2026-10-13 修正リスト 27・ユーザー決定「画像の受け入れは入口で制限をかけた方がいい。JPEG と PNG」)
//
// **受けるのは JPEG と PNG だけ。** ファイルを選ぶ窓の accept(JPEG・PNG)は絞り込みにすぎない
// (「すべてのファイル」にすれば何でも選べるし、ドラッグでも入る)。種類の決められないファイル
// (偽の .heic・種類が空・application/octet-stream・.docx など)は、前は optimize.ts の入口で素通りして、
// **断られずに壊れた画像として本に入った**。そこで、中身の頭の数バイトで見分けて、
// JPEG・PNG でなければここで日本語で断る。ブラウザが付けた種類(file.type)や拡張子は当てにしない。
//
// 対象は「利用者が選ぶ画像」だけ。Word の中の画像(mammoth が取り出す)・保存の .json の中の画像・
// 同梱の絵・見本の本の絵は、ここを通らない(今までどおり)。
//
// ここは画面の部品に触らない(File とバイト列だけ)ので、単体の検査(scripts/fileSniff.test.ts)で回せる。

/** 頭の数バイトで見分けた種類。jpeg と png だけが受け入れ */
export type ImageKind =
  | 'jpeg'
  | 'png'
  | 'heic'
  | 'avif'
  | 'webp'
  | 'gif'
  | 'bmp'
  | 'tiff'
  | 'svg'
  | 'pdf'
  | 'empty'
  | 'unknown';

/** 頭から何バイト読めば見分けられるか(HEIC の ftyp の互換ブランドまで) */
export const IMAGE_HEAD_BYTES = 64;

/** 受け入れる拡張子・種類(ファイルを選ぶ窓の accept に使う。ここ1か所から引く) */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,.jpg,.jpeg,.png';

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** 頭の数バイトから種類を見分ける。中身の字・拡張子・ブラウザの付けた種類は見ない */
export function sniffImage(head: Uint8Array): ImageKind {
  const n = head.length;
  if (n === 0) return 'empty';
  if (n >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (
    n >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return 'png';
  }
  // ISO の箱(ftyp)。iPhone の写真は heic、新しい形式の avif。mp4 や mov も ftyp だが、画像ではないので unknown
  if (n >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brands = [ascii(head, 8, 12)];
    for (let i = 16; i + 4 <= n; i += 4) brands.push(ascii(head, i, i + 4));
    if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
    if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
    return 'unknown';
  }
  if (n >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'webp';
  if (n >= 4 && ascii(head, 0, 4) === 'GIF8') return 'gif';
  // BMP は 'BM' だけでは字の並びと区別がつかないので、予約の4バイト(0)も見る
  if (n >= 10 && head[0] === 0x42 && head[1] === 0x4d && head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0) {
    return 'bmp';
  }
  if (
    n >= 4 &&
    ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a))
  ) {
    return 'tiff';
  }
  if (n >= 4 && ascii(head, 0, 4) === '%PDF') return 'pdf';
  // SVG は字で書かれている。頭の空白・BOM を除いて、<svg か <?xml で始まり、<svg が出てくるもの
  const text = ascii(head, 0, n).replace(/^[﻿ï»¿\s]+/, '');
  if (/^<(\?xml|svg)/i.test(text) && /<svg/i.test(ascii(head, 0, n))) return 'svg';
  return 'unknown';
}

/** 形式の呼び名(断りの文に入れる) */
const LABEL: Partial<Record<ImageKind, string>> = {
  heic: 'HEIC',
  avif: 'AVIF',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
  tiff: 'TIFF',
  svg: 'SVG',
  pdf: 'PDF',
};

/**
 * 受け入れられない種類の断りの文。JPEG・PNG なら null。
 * `name` はファイル名(分かれば、どのファイルかを添える)
 */
export function imageRejection(kind: ImageKind, name = ''): string | null {
  if (kind === 'jpeg' || kind === 'png') return null;
  const tail = name ? `（${name}）` : '';
  if (kind === 'empty') return `ファイルの中身が空です${tail}。JPEG か PNG の画像を選んでください`;
  if (kind === 'heic') {
    return (
      `HEIC 形式の画像は使えません${tail}。JPEG か PNG に書き出してから選んでください` +
      '（iPhone の写真は、パソコンに取り込むときに JPEG に変えるか、写真アプリから JPEG で書き出せます）'
    );
  }
  const label = LABEL[kind];
  if (label) return `${label} 形式の画像は使えません${tail}。JPEG か PNG に書き出してから選んでください`;
  return `画像として読み込めないファイルです${tail}。JPEG か PNG の画像を選んでください`;
}

/** バイト列の頭を見て、JPEG・PNG でなければ断りの文で例外を投げる。通れば種類を返す */
export function assertJpegOrPng(head: Uint8Array, name = ''): 'jpeg' | 'png' {
  const kind = sniffImage(head);
  const msg = imageRejection(kind, name);
  if (msg) throw new Error(msg);
  return kind as 'jpeg' | 'png';
}

function toBase64(bytes: Uint8Array): string {
  // 一気に String.fromCharCode へ渡すと引数が多すぎて落ちるので分ける
  const chunk = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

/**
 * **利用者が選んだ画像のファイルを、data URI にする入口。** 背景・挿絵・表紙・画像のフォルダの
 * どの道も、ここを通す。頭の数バイトで JPEG・PNG かを確かめ、違えば日本語の断りで例外を投げる
 * (呼び出し側がそのまま画面に出す)。data URI の種類は、ブラウザが付けた file.type ではなく、
 * 見分けた種類を付ける(種類が空の JPEG でも画像として扱える)
 */
export async function readImageFileAsDataUri(file: Blob & { name?: string }): Promise<string> {
  const head = new Uint8Array(await file.slice(0, IMAGE_HEAD_BYTES).arrayBuffer());
  const kind = assertJpegOrPng(head, file.name ?? '');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `data:image/${kind};base64,${toBase64(bytes)}`;
}
