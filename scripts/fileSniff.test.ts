// 選んだファイルを頭の数バイトで見分けて断る検査。(2026-10-13 修正リスト 27・28)
//
// ## なぜ在るか
//
// - 27: 画像は JPEG と PNG だけを入口(images/imageFile.ts)で受ける。種類の決められないファイル
//   (偽の .heic・種類が空・application/octet-stream・.docx など)は、前は断られずに壊れた画像として本に入った。
//   ブラウザが付ける種類(file.type)や拡張子は当てにならないので、**中身の頭の数バイト**で見分ける。
//   偽のファイルはバイト列で作る。
// - 28: 原稿の取り込みで、壊れた .docx・0 バイト・Word でない zip・パスワード付きの Word(中身が zip ではなく OLE の器)に、
//   jszip や mammoth の英語の文がそのまま出ていた。頭の数バイトで見分けて日本語にする(importers/fileCheck.ts)。
//   空の .txt は何も言わずに空の本になっていた。断る。1行だけ・見出しだけは今までどおり取り込む。
//
// ## 回し方
//
//   node scripts/private/run-tests.mjs public    (partner でも同じ)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import JSZip from 'jszip';
import {
  assertJpegOrPng,
  imageRejection,
  readImageFileAsDataUri,
  sniffImage,
  IMAGE_ACCEPT,
} from '../src/images/imageFile';
import { isFolderImageName } from '../src/images/folderScan';
import { optimizeImageDataUri } from '../src/images/optimize';
import {
  docxHeadProblem,
  docxZipProblem,
  friendlyDocxError,
  isBlankText,
  sniffContainer,
  sourceBytesProblem,
  EMPTY_FILE_MESSAGE,
} from '../src/importers/fileCheck';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...xs: (number | string)[]) =>
  Uint8Array.from(xs.flatMap((x) => (typeof x === 'string' ? [...enc(x)] : [x])));
const pad = (b: Uint8Array, n = 64) => {
  const out = new Uint8Array(Math.max(n, b.length));
  out.set(b);
  return out;
};

// ---- 偽物の頭(バイト列) ----
const JPEG = pad(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 'JFIF'));
const PNG = pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR'));
// iPhone の HEIC: 箱の大きさ(4) + 'ftyp' + 主ブランド 'heic' + 版(4) + 互換ブランド
const HEIC = pad(bytes(0, 0, 0, 0x18, 'ftyp', 'heic', 0, 0, 0, 0, 'mif1', 'heic'));
// 主ブランドが mif1 で互換に heic(種類の空の HEIC)
const HEIC_MIF1 = pad(bytes(0, 0, 0, 0x18, 'ftyp', 'mif1', 0, 0, 0, 0, 'heic', 'miaf'));
// AVIF は主ブランドが avif。mif1 が互換に入っていても HEIC とは見ない
const AVIF = pad(bytes(0, 0, 0, 0x1c, 'ftyp', 'avif', 0, 0, 0, 0, 'mif1', 'avif', 'miaf'));
const MP4 = pad(bytes(0, 0, 0, 0x18, 'ftyp', 'isom', 0, 0, 2, 0, 'isom', 'mp42'));
const WEBP = pad(bytes('RIFF', 0, 0, 0, 0, 'WEBP', 'VP8 '));
const GIF = pad(bytes('GIF89a', 1, 0, 1, 0));
const BMP = pad(bytes('BM', 0x36, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0));
const TIFF = pad(bytes('II', 0x2a, 0, 8, 0, 0, 0));
const PDF = pad(bytes('%PDF-1.7\n'));
const SVG = enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const TEXT = enc('これは画像ではなく、ただの文章です');
const BM_TEXT = enc('BMW の話をします。BM で始まる文章です。');
const ZIP = pad(bytes('PK', 3, 4, 20, 0, 0, 0));
const OLE = pad(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0));

async function main() {
  // 1. 画像の見分け
  ok(sniffImage(JPEG) === 'jpeg', '見分け: JPEG');
  ok(sniffImage(PNG) === 'png', '見分け: PNG');
  ok(sniffImage(HEIC) === 'heic', '見分け: HEIC(主ブランド heic)');
  ok(sniffImage(HEIC_MIF1) === 'heic', '見分け: HEIC(主ブランド mif1・互換に heic)');
  ok(sniffImage(AVIF) === 'avif', '見分け: AVIF は HEIC と取り違えない');
  ok(sniffImage(MP4) === 'unknown', '見分け: mp4 の ftyp は HEIC ではない');
  ok(sniffImage(WEBP) === 'webp', '見分け: WebP');
  ok(sniffImage(GIF) === 'gif', '見分け: GIF');
  ok(sniffImage(BMP) === 'bmp', '見分け: BMP');
  ok(sniffImage(TIFF) === 'tiff', '見分け: TIFF');
  ok(sniffImage(PDF) === 'pdf', '見分け: PDF');
  ok(sniffImage(SVG) === 'svg', '見分け: SVG(字で書かれた画像)');
  ok(sniffImage(new Uint8Array(0)) === 'empty', '見分け: 空');
  ok(sniffImage(TEXT) === 'unknown', '見分け: ただの文章');
  ok(sniffImage(BM_TEXT) === 'unknown', '見分け: BM で始まる文章を BMP と取り違えない');
  ok(sniffImage(ZIP) === 'unknown', '見分け: zip(.docx など)は画像ではない');
  ok(sniffImage(JPEG.subarray(0, 3)) === 'jpeg', '見分け: JPEG は頭の3バイトで足りる');

  // 2. 断りの文
  ok(imageRejection('jpeg') === null && imageRejection('png') === null, '断りなし: JPEG・PNG');
  const heicMsg = imageRejection('heic', 'IMG_0001.HEIC') ?? '';
  ok(/HEIC/.test(heicMsg) && /JPEG か PNG/.test(heicMsg) && /IMG_0001/.test(heicMsg), 'HEIC の断り: HEIC・JPEG か PNG・ファイル名', heicMsg);
  for (const k of ['webp', 'gif', 'bmp', 'tiff', 'svg', 'pdf', 'avif'] as const) {
    ok(/JPEG か PNG/.test(imageRejection(k) ?? ''), `断り: ${k} は JPEG か PNG へ誘う`);
  }
  ok(/JPEG か PNG の画像を選んでください/.test(imageRejection('unknown', 'a.docx') ?? ''), '断り: 種類不明は「JPEG か PNG の画像を選んでください」');
  ok(/空/.test(imageRejection('empty') ?? ''), '断り: 空のファイル');
  let threw = '';
  try {
    assertJpegOrPng(TEXT, 'memo.png');
  } catch (e) {
    threw = e instanceof Error ? e.message : '';
  }
  ok(/memo\.png/.test(threw) && /JPEG か PNG/.test(threw), '偽の .png(中身は文章)も中身で断る', threw);

  // 3. ファイルとして読む(ブラウザが付けた種類は当てにしない)
  const file = (b: Uint8Array, name: string, type = '') => new File([b], name, { type });
  {
    const d = await readImageFileAsDataUri(file(JPEG, 'photo.bin', ''));
    ok(d.startsWith('data:image/jpeg;base64,'), '種類が空の JPEG は image/jpeg で入る');
    const back = Uint8Array.from(atob(d.slice(d.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    ok(back.length === JPEG.length && back.every((v, i) => v === JPEG[i]), 'data URI の中身は元のバイト列と同じ');
    const d2 = await readImageFileAsDataUri(file(PNG, 'a.png', 'application/octet-stream'));
    ok(d2.startsWith('data:image/png;base64,'), 'octet-stream の PNG は image/png で入る');
    const big = new Uint8Array(300_000);
    big.set(JPEG);
    const d3 = await readImageFileAsDataUri(file(big, 'big.jpg', 'image/jpeg'));
    ok(d3.length > 400_000 && d3.startsWith('data:image/jpeg;base64,'), '大きいファイルも通る');
  }
  const rejects: [string, Uint8Array, string, string][] = [
    ['偽の .heic(中身は文章)', TEXT, 'x.heic', 'image/heic'],
    ['本物の HEIC(種類が空)', HEIC, 'IMG_0001.HEIC', ''],
    ['本物の HEIC(.jpg と名乗る)', HEIC, 'IMG_0002.jpg', 'image/jpeg'],
    ['種類が空の文章', TEXT, 'memo', ''],
    ['octet-stream', ZIP, 'data.bin', 'application/octet-stream'],
    ['.docx(zip)', ZIP, 'book.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['WebP', WEBP, 'a.webp', 'image/webp'],
    ['GIF', GIF, 'a.gif', 'image/gif'],
    ['SVG', SVG, 'a.svg', 'image/svg+xml'],
    ['空のファイル', new Uint8Array(0), 'empty.png', 'image/png'],
  ];
  for (const [label, b, name, type] of rejects) {
    let msg = '';
    try {
      await readImageFileAsDataUri(file(b, name, type));
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    ok(/JPEG か PNG/.test(msg), `断る: ${label}`, msg);
  }
  {
    let msg = '';
    try {
      await readImageFileAsDataUri(file(HEIC, 'IMG_0001.HEIC', ''));
    } catch (e) {
      msg = e instanceof Error ? e.message : '';
    }
    ok(/HEIC/.test(msg), 'HEIC は種類が空でも HEIC の断りになる', msg);
  }

  // 4. 取り込みの所(optimize)も、data: なのに画像でないものを素通りさせない
  {
    let msg = '';
    try {
      await optimizeImageDataUri('data:application/octet-stream;base64,AAAA');
    } catch (e) {
      msg = e instanceof Error ? e.message : '';
    }
    ok(/JPEG か PNG/.test(msg), 'optimize: data:application/octet-stream は断る', msg);
    msg = '';
    try {
      await optimizeImageDataUri('data:text/html;base64,AAAA');
    } catch (e) {
      msg = e instanceof Error ? e.message : '';
    }
    ok(/JPEG か PNG/.test(msg), 'optimize: data:text/html も断る', msg);
    ok((await optimizeImageDataUri('covers/a.jpg')) === 'covers/a.jpg', 'optimize: data: でない値(相対 URL)はそのまま');
    ok((await optimizeImageDataUri('data:image/svg+xml,%3Csvg%2F%3E')).startsWith('data:image/svg'), 'optimize: 同梱の SVG はそのまま(見本の本の絵)');
  }

  // 5. ファイルを選ぶ窓の絞り込みと、フォルダの拾い方
  ok(IMAGE_ACCEPT === 'image/jpeg,image/png,.jpg,.jpeg,.png', 'accept は JPEG と PNG だけ');
  ok(!/webp|heic|gif|svg|\*/i.test(IMAGE_ACCEPT), 'accept に webp・heic・gif・svg・image/* が無い');
  ok(['a.jpg', 'b.JPEG', 'c.png'].every(isFolderImageName) && !['a.webp', 'a.heic', 'a.gif'].some(isFolderImageName), 'フォルダ: jpg・jpeg・png だけ拾う');

  // 6. 原稿の器の見分け
  ok(sniffContainer(new Uint8Array(0)) === 'empty', '器: 空');
  ok(sniffContainer(ZIP) === 'zip', '器: zip');
  ok(sniffContainer(OLE) === 'ole', '器: OLE(パスワード付きの Word・古い .doc)');
  ok(sniffContainer(TEXT) === 'other', '器: それ以外');
  ok(docxHeadProblem(ZIP.subarray(0, 8)) === null, '.docx の頭: zip なら問題なし');
  ok(docxHeadProblem(new Uint8Array(0)) === EMPTY_FILE_MESSAGE, '.docx の頭: 0 バイトは「空」');
  const olemsg = docxHeadProblem(OLE.subarray(0, 8)) ?? '';
  ok(/パスワード/.test(olemsg) && /\.docx/.test(olemsg) && !/zip/i.test(olemsg), '.docx の頭: パスワード付きの Word は日本語で直し方つき', olemsg);
  const othermsg = docxHeadProblem(TEXT.subarray(0, 8)) ?? '';
  ok(/Word/.test(othermsg) && !/zip file/i.test(othermsg), '.docx の頭: zip でないものは日本語で断る', othermsg);

  // 7. zip の中身
  const wordZip = new JSZip();
  wordZip.file('[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  wordZip.file('word/document.xml', '<w:document/>');
  ok((await docxZipProblem(await wordZip.generateAsync({ type: 'arraybuffer' }))) === null, 'zip: Word の中身があれば問題なし');
  const xlsx = new JSZip();
  xlsx.file('[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>');
  xlsx.file('xl/workbook.xml', '<workbook/>');
  const xmsg = (await docxZipProblem(await xlsx.generateAsync({ type: 'arraybuffer' }))) ?? '';
  ok(/Excel/.test(xmsg) && /Word/.test(xmsg), 'zip: Excel のファイルと分かれば、そう言う', xmsg);
  const plainZip = new JSZip();
  plainZip.file('hello.txt', 'hi');
  const pmsg = (await docxZipProblem(await plainZip.generateAsync({ type: 'arraybuffer' }))) ?? '';
  ok(/Word/.test(pmsg) && /zip/.test(pmsg) && !/is this a zip file/.test(pmsg), 'zip: Word でない zip は日本語で断る', pmsg);
  const brokenZip = pad(bytes('PK', 3, 4, 20, 0, 0, 0, 8, 0), 200);
  const bmsg = (await docxZipProblem(brokenZip.buffer as ArrayBuffer)) ?? '';
  ok(/壊れ/.test(bmsg) && !/is this a zip file|Can't find/.test(bmsg), 'zip: 壊れた zip は日本語で断る(英語の文を出さない)', bmsg);

  // 8. 英語の文の言い換え
  const f1 = friendlyDocxError(new Error('Could not find main document part. Are you sure this is a valid .docx document?'));
  ok(/Word/.test(f1) && !/Could not find/.test(f1), '言い換え: mammoth の英語の文', f1);
  ok(friendlyDocxError(new Error('Can\'t find end of central directory : is this a zip file ?')).includes('Word'), '言い換え: jszip の英語の文');
  ok(friendlyDocxError(new Error('文字コードを読み取れませんでした')) === '文字コードを読み取れませんでした', '言い換え: 日本語の文はそのまま');

  // 9. 空の文章
  ok(isBlankText('') && isBlankText(' \n\t　\n') && isBlankText('﻿\n'), '空: 空白・改行・BOM だけも空');
  ok(!isBlankText('あ') && !isBlankText('# 見出し'), '空ではない: 1字・見出しだけ');

  // 10. 原稿の取り込みの入口(importers/load.ts の readSource が呼ぶ sourceBytesProblem)。
  //     load.ts そのものは mammoth を読み込み、この検査の組み立て(tmp に出す)では解決できないので、直には回さない
  const problem = (kind: 'docx' | 'md' | 'txt', data: BlobPart) =>
    new Blob([data]).arrayBuffer().then((b) => sourceBytesProblem(kind, b));
  ok((await problem('txt', '')) === EMPTY_FILE_MESSAGE, '取り込み: 空の .txt は断る');
  ok((await problem('md', '')) === EMPTY_FILE_MESSAGE, '取り込み: 空の .md も断る');
  ok((await problem('docx', '')) === EMPTY_FILE_MESSAGE, '取り込み: 0 バイトの .docx は断る');
  ok((await problem('txt', '一行だけ')) === null, '取り込み: 1行だけの .txt は今までどおり入る');
  ok((await problem('txt', '# 見出しだけ')) === null && (await problem('md', '# 見出しだけ')) === null, '取り込み: 見出しだけの .txt / .md も入る');
  const pw = (await problem('docx', OLE)) ?? '';
  ok(/パスワード/.test(pw), '取り込み: パスワード付きの Word は「パスワードを外して」', pw);
  const nonzip = (await problem('docx', TEXT)) ?? '';
  ok(/Word/.test(nonzip) && !/zip file/.test(nonzip), '取り込み: 中身が文章の .docx は日本語で断る', nonzip);
  const notword = (await problem('docx', await plainZip.generateAsync({ type: 'uint8array' }))) ?? '';
  ok(/Word/.test(notword) && /zip/.test(notword), '取り込み: Word でない zip は日本語で断る', notword);
  const brk = (await problem('docx', brokenZip)) ?? '';
  ok(/壊れ/.test(brk), '取り込み: 壊れた .docx は日本語で断る', brk);
  ok((await problem('docx', await wordZip.generateAsync({ type: 'uint8array' }))) === null, '取り込み: Word の形の zip は入口を通る(中身は mammoth へ)');
  console.log(`\n${passed} 通過 / ${failed} 失敗`);
  process.exit(failed ? 1 : 0);
}
void main();
