// src/press/repair.ts の検査。`node scripts/press/repair.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 手で作った PDF に、/Length が別オブジェクト(間接)で、末尾が改行(0x0A・0x0D・0x0D 0x0A など)のストリームを入れる。
// pdf-lib は間接の長さだと endstream の手前の改行を削るので、その1〜2バイトを落とす。repair はそれを元に戻す。
// 実物(Ghostscript の出力)での確かめは、画面の検査(U-press-ui)と e2e.test.ts で行った。
//
// 2026-10-01 見直し(2-3 の 1): ページの中身だけでなく、画像・ICC・Form も同じ書き方なので全部が対象であること、
// 末尾が CR でも LF でも CR LF でも直ること、元の位置を「先頭32バイト」だけで探すと、同じ書き出しのストリームや
// 32バイトより短いストリームで取り違えるか直せないこと、直せなかったものは黙らずに failed で返すことを確かめる。
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { repairTruncatedStreams } from '../../src/press/repair.ts';

let passed = 0;
const failed: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.stack ?? e).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

/** Flate にしたとき、最後のバイトが want になる(adler32 の下位バイト)中身を探す */
function flateEndingWith(want: number): Buffer {
  for (let i = 0; i < 100000; i++) {
    // 同じ行の繰り返しだと adler32 の下位バイトが偏って 0x0a・0x0d になれないので、行ごとに数を変える
    const z = deflateSync(Buffer.from(Array.from({ length: 6 }, (_, k) => `${i + k * k} ${i * (k + 3)} m\n`).join('')));
    if (z[z.length - 1] === want) return z;
  }
  throw new Error('見つからない');
}

/** 疑似乱数(再現できるように種つき) */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x & 0xff;
  };
}

/** 長さ n のでたらめなバイト列。末尾に tail を付ける(Flate として正しい必要は無い。repair は中身を読まない) */
function blob(seed: number, n: number, tail: number[]): Buffer {
  const r = rng(seed);
  return Buffer.concat([Buffer.from(Array.from({ length: n }, () => r())), Buffer.from(tail)]);
}

interface S {
  /** オブジェクト番号。省略は 10 から順に */
  num?: number;
  data: Uint8Array;
  /** 辞書に足す中身(`/Subtype/Image` など) */
  dict?: string;
  /** /Length を直の数にする(pdf-lib がそのまま使う。欠けない) */
  direct?: boolean;
  /** 辞書に書く長さ。省略はデータの長さ(わざと食い違わせる検査用) */
  claim?: number;
}

/** ストリームを並べた PDF。ページ1つ(内容は最初のストリーム)。/Length は別オブジェクト(100 + i)で、データの直後に endstream(改行なし。Ghostscript と同じ) */
function build(streams: S[], eol = '\n'): Uint8Array {
  const parts: Buffer[] = [];
  const push = (s: string | Uint8Array) => parts.push(Buffer.from(s as Uint8Array | string, typeof s === 'string' ? 'latin1' : undefined));
  const first = streams[0].num ?? 10;
  push(
    '%PDF-1.6\n' +
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n' +
      '2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n' +
      `3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents ${first} 0 R>>\nendobj\n`,
  );
  streams.forEach((s, i) => {
    const num = s.num ?? 10 + i;
    const len = s.claim ?? s.data.length;
    push(`${num} 0 obj\n<</Length ${s.direct ? len : `${100 + i} 0 R`}${s.dict ?? ''}>>\nstream${eol}`);
    push(s.data);
    push('endstream\nendobj\n');
  });
  streams.forEach((s, i) => {
    if (!s.direct) push(`${100 + i} 0 obj\n${s.claim ?? s.data.length}\nendobj\n`);
  });
  push('trailer\n<</Root 1 0 R/Size 300>>\n%%EOF\n');
  return Buffer.concat(parts);
}

/** doc の中の、i 番目の(番号順の)ストリームの中身 */
function streamsOf(doc: PDFDocument): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) if (o instanceof PDFRawStream) m.set(ref.toString(), o.contents);
  return m;
}

const eq = (a: Uint8Array | undefined, b: Uint8Array) => !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

console.log('repairTruncatedStreams');

const contentOf = (doc: PDFDocument): Uint8Array => {
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream && o.dict.get(PDFName.of('Filter'))) return o.contents;
  }
  throw new Error('ストリームが無い');
};

for (const last of [0x0a, 0x0d, 0x41]) {
  await test(`ページの中身(Flate)の末尾が 0x${last.toString(16)}`, async () => {
    const z = flateEndingWith(last);
    const bytes = build([{ data: z, dict: '/Filter/FlateDecode' }]);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const before = contentOf(doc).byteLength;
    // 前提の確認: 0x0a・0x0d は pdf-lib が削る(0x41 は削らない)。末尾が 0d 0a のときは2バイト削られる
    const lost = last === 0x41 ? 0 : z[z.length - 2] === 0x0d && last === 0x0a ? 2 : 1;
    assert.equal(before, z.length - lost);
    const r = repairTruncatedStreams(doc, bytes);
    assert.equal(r.repaired, last === 0x41 ? 0 : 1);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(Buffer.from(contentOf(doc)), z);
    const len = doc.context.enumerateIndirectObjects().map(([, o]) => (o instanceof PDFRawStream ? o.dict.lookup(PDFName.of('Length')) : null));
    assert.ok(len.some((l) => l instanceof PDFNumber));
  });
}

await test('直したあと、保存して開き直しても Flate が最後まで読める', async () => {
  const z = flateEndingWith(0x0a);
  const bytes = build([{ data: z, dict: '/Filter/FlateDecode' }]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  repairTruncatedStreams(doc, bytes);
  const saved = await doc.save({ useObjectStreams: false });
  const again = await PDFDocument.load(saved, { updateMetadata: false });
  assert.deepEqual(Buffer.from(contentOf(again)), z);
});

await test('長さが合っているストリームは触らない(0 件)', async () => {
  const bytes = build([{ data: deflateSync(Buffer.from('q Q\n')), dict: '/Filter/FlateDecode' }]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const r = repairTruncatedStreams(doc, bytes);
  assert.equal(r.repaired, 0);
  assert.deepEqual(r.failed, []);
});

// 末尾の改行の全部の組み合わせ × ストリームの種類(ページの中身・画像・ICC・Form)。間接の /Length のストリームは全部が対象
const TAILS: [string, number[]][] = [
  ['LF', [0x0a]],
  ['CR', [0x0d]],
  ['CR LF', [0x0d, 0x0a]],
  ['LF CR', [0x0a, 0x0d]],
  ['CR CR', [0x0d, 0x0d]],
  ['LF LF', [0x0a, 0x0a]],
];
const KINDS: [string, string][] = [
  ['ページの中身', '/Filter/FlateDecode'],
  ['画像', '/Type/XObject/Subtype/Image/Width 4/Height 4/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode'],
  ['ICC', '/N 4/Alternate/DeviceCMYK/Filter/FlateDecode'],
  ['Form', '/Type/XObject/Subtype/Form/BBox[0 0 10 10]/Filter/FlateDecode'],
];

for (const eol of ['\n', '\r\n']) {
  await test(`${TAILS.length * KINDS.length} 本(末尾 ${TAILS.map((t) => t[0]).join('・')} × ${KINDS.map((k) => k[0]).join('・')})が全部元に戻る(stream の後ろが ${JSON.stringify(eol)})`, async () => {
    const streams: S[] = [];
    let seed = 1;
    for (const [, tail] of TAILS) for (const [, dict] of KINDS) streams.push({ data: blob(seed++, 200 + seed, tail), dict });
    const bytes = build(streams, eol);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    // 前提: pdf-lib はこの24本を、全部、削る
    const before = streamsOf(doc);
    streams.forEach((s, i) => assert.ok(before.get(`${10 + i} 0 R`)!.byteLength < s.data.length, `${i} 番目は pdf-lib が削っていない`));
    const r = repairTruncatedStreams(doc, bytes);
    assert.equal(r.repaired, streams.length);
    assert.deepEqual(r.failed, []);
    const after = streamsOf(doc);
    streams.forEach((s, i) => assert.ok(eq(after.get(`${10 + i} 0 R`), s.data), `${i} 番目が元に戻っていない`));
  });
}

await test('先頭32バイトより短いストリーム(Ghostscript の白紙のページの中身など)も戻る', async () => {
  const bytes = build([{ data: Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x0a]), dict: '/Filter/FlateDecode' }]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const r = repairTruncatedStreams(doc, bytes);
  assert.equal(r.repaired, 1);
  assert.deepEqual(r.failed, []);
});

await test('先頭32バイトが同じで長さも同じ2つのストリームを、取り違えない(それぞれ自分の中身に戻る)', async () => {
  const head = blob(7, 40, []);
  const a = Buffer.concat([head, Buffer.from([1, 2, 3, 4]), Buffer.from([0x0a])]);
  const b = Buffer.concat([head, Buffer.from([9, 8, 7, 6]), Buffer.from([0x0a])]);
  const bytes = build([{ data: a }, { data: b }]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const r = repairTruncatedStreams(doc, bytes);
  assert.equal(r.repaired, 2);
  const after = streamsOf(doc);
  assert.ok(eq(after.get('10 0 R'), a), '1つ目が2つ目の中身になった');
  assert.ok(eq(after.get('11 0 R'), b), '2つ目が1つ目の中身になった');
});

await test('番号が「12」と「112」のオブジェクトを取り違えない(`12 0 obj` が `112 0 obj` の末尾に当たる)', async () => {
  const a = blob(11, 80, [0x0a]);
  const b = blob(12, 80, [0x0d]);
  // 112 を先に置く。12 の見出しを探して 112 の末尾に当たると、112 の中身を 12 に入れてしまう
  const bytes = build([
    { num: 112, data: b },
    { num: 12, data: a },
  ]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const r = repairTruncatedStreams(doc, bytes);
  assert.equal(r.repaired, 2);
  const after = streamsOf(doc);
  assert.ok(eq(after.get('12 0 R'), a));
  assert.ok(eq(after.get('112 0 R'), b));
});

await test('直せなかったものは、黙らずに failed(呼び名つき)で返す: endstream が /Length の先に無い', async () => {
  // /Length は 300 と言うのに、データは 200 バイトで endstream が来る(ほかのソフトの壊れた PDF)
  const data = blob(21, 199, [0x0a]);
  const bytes = build([
    { data: blob(22, 100, []), dict: '/Filter/FlateDecode' },
    { data, dict: '/Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceGray/BitsPerComponent 8', claim: 300 },
  ]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const r = repairTruncatedStreams(doc, bytes);
  assert.equal(r.repaired, 0);
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0], /画像 11 0 R/);
});

await test('/Length が直の数のストリームは対象外(pdf-lib は直の数ならそのまま使う)', async () => {
  const data = blob(31, 100, [0x0a]);
  const bytes = build([{ data, direct: true }]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const r = repairTruncatedStreams(doc, bytes);
  assert.equal(r.repaired, 0);
  assert.deepEqual(r.failed, []);
  assert.ok(eq(streamsOf(doc).get('10 0 R'), data));
});

console.log(`\n${passed} 件通過 / ${failed.length} 件落ち`);
process.exit(failed.length ? 1 : 0);
