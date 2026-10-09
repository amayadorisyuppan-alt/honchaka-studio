// src/press/content.ts の検査。`node scripts/press/content.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 実物の PDF(Chrome が書き出した本文)の検査は、置き場を環境変数 PRESS_FIXTURES で渡したときだけ回る。
//   PRESS_FIXTURES=<color-a5.pdf などのあるフォルダ> node scripts/press/content.test.ts
// 渡さなければ飛ばして、飛ばしたと表示する。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import {
  contentHolders,
  deflate,
  forEachOperation,
  inflate,
  operations,
  pdfNum,
  pngPredict,
  readStream,
  replaceStream,
  rewriteOperations,
  tokenize,
} from '../../src/press/content.ts';
import type { Token } from '../../src/press/content.ts';

// ───────────────────────── メモリの測り(別プロセスで自分を呼ぶ) ─────────────────────────
// CONTENT_CHILD=mem: 150MB をほどくときの RSS の増えを測って `MEMPEAK <MB> <増え(MB)>` と出して終わる(CONTENT_HINT=1 で sizeHint を渡す)。
// RSS の最大は下がらないので、1回の実行で測れるのは1つ。あり・なしは別々の子で測る
if (process.env.CONTENT_CHILD === 'mem') {
  const useHint = process.env.CONTENT_HINT === '1';
  const n = 150 * 1024 * 1024;
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i += 4) {
    raw[i] = (i >> 12) & 255;
    raw[i + 1] = (i >> 16) & 255;
    raw[i + 3] = (i >> 8) & 255;
  }
  const z = await deflate(raw);
  const base = Math.round(process.resourceUsage().maxRSS / 1024);
  const out = await inflate(z, useHint ? n : undefined);
  const peak = Math.round(process.resourceUsage().maxRSS / 1024);
  if (out.length !== n || out[n - 4] !== raw[n - 4]) process.exit(3);
  console.log(`MEMPEAK ${Math.round(n / 1048576)} ${peak - base}`);
  process.exit(0);
}

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

const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const dec = (b: Uint8Array): string => Buffer.from(b).toString('latin1');
const ops = (s: string) => operations(enc(s)).map((o) => o.op);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
/** rg だけを g に書き換える(狙った命令だけ変わるかを見るための fn) */
const rgToG = (o: { op: string; operands: Token[] }) => (o.op === 'rg' ? '9 g' : null);
const rewrite = (s: string) => dec(rewriteOperations(enc(s), rgToG).bytes);

console.log('手書きの小さな例');

await test('文字列の中の 0 0 0 rg は命令ではない', () => {
  const s = 'BT (0 0 0 rg) Tj ET 1 0 0 rg';
  assert.deepEqual(ops(s), ['BT', 'Tj', 'ET', 'rg']);
  assert.equal(rewrite(s), 'BT (0 0 0 rg) Tj ET 9 g');
});

await test('エスケープされたかっこ・入れ子・\\\\・行末の継続', () => {
  const a = '(a\\)b 0 0 0 rg \\( ) Tj 0 0 0 rg';
  assert.deepEqual(ops(a), ['Tj', 'rg']);
  assert.equal(rewrite(a), '(a\\)b 0 0 0 rg \\( ) Tj 9 g');
  const b = '(\\\\) Tj 1 0 0 rg'; // \\ のあとの ) は閉じかっこ
  assert.deepEqual(ops(b), ['Tj', 'rg']);
  const c = '(x (y 0 0 0 rg) z) Tj 0 0 1 rg'; // 入れ子
  assert.deepEqual(ops(c), ['Tj', 'rg']);
  const d = '(ab\\\ncd 1 0 0 rg) Tj 0 1 0 rg'; // \ + 改行 = 継続
  assert.deepEqual(ops(d), ['Tj', 'rg']);
  const e = '(\\051 0 0 0 rg) Tj 0 1 0 rg'; // \051 = ) だが閉じかっこではない
  assert.deepEqual(ops(e), ['Tj', 'rg']);
});

await test('16進文字列・辞書', () => {
  const s = '<30 20 30 20 30 20 72 67> Tj /P << /MCID 0 /X <0072 67> >> BDC 0 0 0 rg';
  assert.deepEqual(ops(s), ['Tj', 'BDC', 'rg']);
  const t = tokenize(enc(s));
  assert.equal(t.filter((x) => x.type === 'hex').length, 2);
  assert.equal(t.filter((x) => x.type === 'dictOpen').length, 1);
  assert.equal(t.filter((x) => x.type === 'dictClose').length, 1);
});

await test('コメントの中の rg は命令ではない', () => {
  const s = '% 0 0 0 rg\n1 g % 1 0 0 rg\r0 0 0 rg';
  assert.deepEqual(ops(s), ['g', 'rg']);
  assert.equal(rewrite(s), '% 0 0 0 rg\n1 g % 1 0 0 rg\r9 g');
});

await test('インライン画像: 中の EI に見える並びや rg を命令にしない', () => {
  const data = 'xx EIX 0 0 0 rg (( \x00\xff\x80 EI\x01 EI1 yy';
  const s = `q 10 0 0 10 0 0 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID ${data}\nEI Q 0 0 1 rg`;
  assert.deepEqual(ops(s), ['q', 'cm', 'BI', 'Q', 'rg']);
  const bi = operations(enc(s)).find((o) => o.op === 'BI')!;
  assert.equal(dec(enc(s).subarray(bi.image!.dataStart, bi.image!.dataEnd)), data);
  assert.equal(bi.operands.length, 8); // /W 2 /H 2 /CS /RGB /BPC 8
  assert.equal(rewrite(s), s.replace('0 0 1 rg', '9 g'));
  // 画像の中のものは、fn が見ない(rg の命令は最後の1つだけ)
  let seen = 0;
  rewriteOperations(enc(s), (o) => void (o.op === 'rg' && seen++));
  assert.equal(seen, 1);
});

await test('インライン画像: /L があれば、中に本物の EI があっても長さで切れる', () => {
  const data = 'ab\nEI\ncd'; // 空白+EI+空白が中にある(8バイト)
  const s = `BI /W 1 /H 1 /L ${data.length} ID ${data}\nEI 0 0 0 rg`;
  assert.deepEqual(ops(s), ['BI', 'rg']);
  // /L が無いと、仕様どおり最初の「空白 EI 空白」で終わる(中の EI で切れる)
  const t = `BI /W 1 /H 1 ID ${data}\nEI 0 0 0 rg`;
  assert.deepEqual(ops(t).includes('rg'), true);
});

await test('インライン画像: 空の画像・CR LF・EI で終わる入力', () => {
  assert.deepEqual(ops('BI /W 0 ID\nEI Q'), ['BI', 'Q']);
  assert.deepEqual(ops('BI /W 1 ID\r\nabc\r\nEI Q'), ['BI', 'Q']);
  assert.deepEqual(ops('BI /W 1 ID abc EI'), ['BI']);
  assert.deepEqual(ops('BI /W 1 ID abc'), ['BI']); // EI が無い(壊れた入力)
});

await test('TJ の配列: 平らに並ぶ', () => {
  const s = '[(A) -120 (B) 5.5] TJ 0 0 0 rg';
  const o = operations(enc(s));
  assert.deepEqual(o.map((x) => x.op), ['TJ', 'rg']);
  assert.deepEqual(o[0].operands.map((x) => x.type), ['arrayOpen', 'string', 'number', 'string', 'number', 'arrayClose']);
  assert.equal(o[0].operands[2].num, -120);
  assert.equal(o[0].operands[4].num, 5.5);
  assert.equal(o[1].start, s.indexOf('0 0 0 rg'));
});

await test("' と \" のオペレータ", () => {
  const o = operations(enc('(abc) \' 1 2 (x) " T* b* 0 0 0 rg'));
  assert.deepEqual(o.map((x) => x.op), ["'", '"', 'T*', 'b*', 'rg']);
  assert.equal(o[0].operands.length, 1);
  assert.equal(o[1].operands.length, 3);
});

await test('true / false / null はオペランド(命令の区切りを狂わせない)・数の書き方', () => {
  const s = '/OC << /A true /B null /C [1 2 /X false] >> BDC .5 -.5 +3 4. 0.25 SC 1 g';
  const o = operations(enc(s));
  assert.deepEqual(o.map((x) => x.op), ['BDC', 'SC', 'g']);
  assert.deepEqual(o[1].operands.map((x) => x.num), [0.5, -0.5, 3, 4, 0.25]);
  assert.equal(o[0].operands.filter((x) => x.type === 'keyword').length, 3);
  // /true は name であって keyword ではない
  assert.equal(tokenize(enc('/true'))[0].type, 'name');
});

await test('名前の #xx・隣り合う字句', () => {
  const t = tokenize(enc('/F#31 12 Tf [(a)]TJ/F1 1 Tf(b)Tj'));
  assert.equal(t[0].text, 'F1');
  assert.deepEqual(
    t.map((x) => x.type),
    ['name', 'number', 'operator', 'arrayOpen', 'string', 'arrayClose', 'operator', 'name', 'number', 'operator', 'string', 'operator'],
  );
});

await test('壊れた入力でも例外にも無限ループにもならない', () => {
  for (const s of ['(abc 0 0 0 rg', '<3030', '[ (a) ', '<< /A 1', 'BI /W 1', 'BI', 'ID', ')', '>', '}', '(\\', '/', '% only', '1 2 3', '--5 0 0 rg', '1.2.3 g']) {
    const o = operations(enc(s));
    assert.ok(Array.isArray(o), s);
    assert.ok(same(rewriteOperations(enc(s), () => undefined).bytes, enc(s)));
  }
  assert.deepEqual(ops('(abc 0 0 0 rg'), []); // 閉じない文字列は、末尾まで文字列
  assert.deepEqual(ops('--5 0 0 rg'), ['--5', 'rg']);
});

await test('pdfNum', () => {
  assert.equal(pdfNum(0), '0');
  assert.equal(pdfNum(-0), '0');
  assert.equal(pdfNum(1), '1');
  assert.equal(pdfNum(0.5), '0.5');
  assert.equal(pdfNum(-0.000001), '0');
  assert.equal(pdfNum(1 / 3), '0.33333');
  assert.equal(pdfNum(2 / 3), '0.66667');
  assert.equal(pdfNum(1e-7), '0');
  assert.equal(pdfNum(123456.789012), '123456.78901');
  assert.equal(pdfNum(1.5e10), '15000000000');
  assert.equal(pdfNum(1e21), '1000000000000000000000');
  assert.equal(pdfNum(100), '100');
  assert.equal(pdfNum(NaN), '0');
  assert.equal(pdfNum(Infinity), '0');
  assert.equal(pdfNum(0.1 + 0.2), '0.3');
  assert.equal(pdfNum(12.000004), '12');
});

await test('何も変えない書き換えは入力とバイト単位で同じ(同じ配列を返す)', () => {
  const s = enc('q 1 0 0 rg (a) Tj BI /W 1 ID \x00\xff EI Q % c\n0 g');
  const r = rewriteOperations(s, () => null);
  assert.equal(r.changed, 0);
  assert.ok(r.bytes === s);
  const r2 = rewriteOperations(s, (o) => (o.op === 'g' ? '' : undefined));
  assert.equal(r2.changed, 1);
  assert.equal(dec(r2.bytes), dec(s).replace('0 g', ''));
});

await test('ゆらぎ入力(でたらめ): 例外なし・字句の範囲が増えていく・何も変えなければ同じ', () => {
  const alphabet = enc('()<>[]/%\\ \n\r\t0123456789.-+EIBDrgkKTj*\'"#xA\x00\xff');
  let x = 12345;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  for (let n = 0; n < 400; n++) {
    const len = rnd() % 200;
    const b = new Uint8Array(len);
    for (let i = 0; i < len; i++) b[i] = alphabet[rnd() % alphabet.length];
    const t = tokenize(b);
    let prev = 0;
    for (const k of t) {
      assert.ok(k.start >= prev && k.end > k.start && k.end <= len, `範囲 ${k.type} ${k.start}-${k.end} (前 ${prev})`);
      prev = k.end;
    }
    operations(b);
    assert.ok(same(rewriteOperations(b, () => undefined).bytes, b));
  }
});

await test('速さ: 20MB の content stream を数秒で', () => {
  const unit = 'q 0 0 0 rg 1 0 0 1 72.5 700.25 cm BT /F1 9.5 Tf [(\\(x\\) abc) -12 (def)] TJ ET 0.5 g 10 20 30 40 re f Q\n';
  const n = Math.ceil((20 * 1024 * 1024) / unit.length);
  const big = enc(unit.repeat(n));
  const t0 = performance.now();
  const o = operations(big);
  const r = rewriteOperations(big, (op) => (op.op === 'rg' ? '0 g' : null));
  const ms = performance.now() - t0;
  console.log(`       ${(big.length / 1048576).toFixed(1)}MB・命令 ${o.length} 個・書き換え ${r.changed} 個 ${Math.round(ms)}ms`);
  assert.equal(r.changed, n);
  assert.ok(ms < 15000, `${ms}ms`);
});

console.log('ストリームの読み書き');

const mkDoc = () => PDFDocument.create({ updateMetadata: false } as never);

async function rawStream(doc: PDFDocument, data: Uint8Array, entries: Record<string, unknown>): Promise<PDFRawStream> {
  const dict = doc.context.obj(entries as never) as PDFDict;
  const s = PDFRawStream.of(dict, data);
  doc.context.register(s);
  return s;
}

/** PNG の予測で行を詰める(検査用の手作りの符号化)。方式は行ごとに tags から選ぶ */
function pngEncode(raw: Uint8Array, rowBytes: number, bpp: number, tags: number[]): Uint8Array {
  const rows = raw.length / rowBytes;
  const out = new Uint8Array(rows * (rowBytes + 1));
  for (let r = 0; r < rows; r++) {
    const tag = tags[r % tags.length];
    out[r * (rowBytes + 1)] = tag;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[r * rowBytes + i];
      const a = i >= bpp ? raw[r * rowBytes + i - bpp] : 0;
      const b = r > 0 ? raw[(r - 1) * rowBytes + i] : 0;
      const c = r > 0 && i >= bpp ? raw[(r - 1) * rowBytes + i - bpp] : 0;
      let p = 0;
      if (tag === 1) p = a;
      else if (tag === 2) p = b;
      else if (tag === 3) p = (a + b) >> 1;
      else if (tag === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[r * (rowBytes + 1) + 1 + i] = (x - p) & 0xff;
    }
  }
  return out;
}

const sample = (n: number, seed = 7) => {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = (x >> 8) & 0xff;
  }
  return b;
};

await test('inflate / deflate の往復', async () => {
  const d = sample(100000);
  assert.ok(same(await inflate(await deflate(d)), d));
  assert.ok(same(await inflate(await deflate(new Uint8Array(0))), new Uint8Array(0)));
});

await test('readStream: Filter なし・名前・要素1つの配列・DCT は null', async () => {
  const doc = await mkDoc();
  const d = sample(1000);
  assert.ok(same((await readStream(await rawStream(doc, d, {})))!, d));
  const z = await deflate(d);
  assert.ok(same((await readStream(await rawStream(doc, z, { Filter: 'FlateDecode' })))!, d));
  const f = await rawStream(doc, z, {});
  f.dict.set(PDFName.of('Filter'), doc.context.obj([PDFName.of('FlateDecode')]));
  assert.ok(same((await readStream(f))!, d));
  assert.equal(await readStream(await rawStream(doc, d, { Filter: 'DCTDecode' })), null);
  const g = await rawStream(doc, z, {});
  g.dict.set(PDFName.of('Filter'), doc.context.obj([PDFName.of('ASCII85Decode'), PDFName.of('FlateDecode')]));
  assert.equal(await readStream(g), null);
  // 重ねがけの Flate
  const zz = await rawStream(doc, await deflate(z), {});
  zz.dict.set(PDFName.of('Filter'), doc.context.obj([PDFName.of('FlateDecode'), PDFName.of('FlateDecode')]));
  assert.ok(same((await readStream(zz))!, d));
  // 壊れた Flate は例外
  await assert.rejects(readStream(await rawStream(doc, sample(50), { Filter: 'FlateDecode' })));
});

await test('readStream: Predictor 12(Up)・15(行ごとの方式)・10〜14 の全部', async () => {
  const doc = await mkDoc();
  const colors = 3;
  const columns = 11;
  const rows = 9;
  const rowBytes = colors * columns;
  const raw = sample(rowBytes * rows, 3);
  for (const [pred, tags] of [
    [12, [2]],
    [15, [0, 1, 2, 3, 4]],
    [10, [0]],
    [11, [1]],
    [13, [3]],
    [14, [4]],
  ] as const) {
    const z = await deflate(pngEncode(raw, rowBytes, colors, [...tags]));
    const s = await rawStream(doc, z, { Filter: 'FlateDecode', DecodeParms: { Predictor: pred, Colors: colors, Columns: columns } });
    assert.ok(same((await readStream(s))!, raw), `Predictor ${pred}`);
  }
  // DecodeParms が配列、Colors 1・BitsPerComponent 16
  const raw16 = sample(2 * 5 * 4, 9);
  const z16 = await deflate(pngEncode(raw16, 10, 2, [4, 2]));
  const s16 = await rawStream(doc, z16, {});
  s16.dict.set(PDFName.of('Filter'), doc.context.obj([PDFName.of('FlateDecode')]));
  s16.dict.set(PDFName.of('DecodeParms'), doc.context.obj([{ Predictor: 15, Colors: 1, BitsPerComponent: 16, Columns: 5 }] as never));
  assert.ok(same((await readStream(s16))!, raw16));
  // 最後の行が欠けていても、読めた所まで返す
  const cut = pngEncode(raw, rowBytes, colors, [2]).subarray(0, (rowBytes + 1) * 8 + 5);
  const sc = await rawStream(doc, await deflate(cut), { Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Colors: colors, Columns: columns } });
  assert.equal((await readStream(sc))!.length, rowBytes * 8 + 4);
});

await test('readStream: Predictor 2(TIFF)8・16・4 ビット', async () => {
  const doc = await mkDoc();
  const diff = (raw: Uint8Array, colors: number, rowBytes: number, bits: number) => {
    const out = new Uint8Array(raw);
    const samples = (rowBytes * 8) / bits;
    for (let off = 0; off < raw.length; off += rowBytes) {
      if (bits === 8) for (let i = rowBytes - 1; i >= colors; i--) out[off + i] = (raw[off + i] - raw[off + i - colors]) & 0xff;
      else if (bits === 16) {
        for (let s = samples - 1; s >= colors; s--) {
          const v = (((raw[off + s * 2] << 8) | raw[off + s * 2 + 1]) - ((raw[off + (s - colors) * 2] << 8) | raw[off + (s - colors) * 2 + 1])) & 0xffff;
          out[off + s * 2] = v >> 8;
          out[off + s * 2 + 1] = v & 0xff;
        }
      } else {
        const get = (s: number) => (raw[off + (s >> 1)] >> (s & 1 ? 0 : 4)) & 15;
        for (let s = samples - 1; s >= colors; s--) {
          const v = (get(s) - get(s - colors)) & 15;
          const sh = s & 1 ? 0 : 4;
          out[off + (s >> 1)] = (out[off + (s >> 1)] & ~(15 << sh)) | (v << sh);
        }
      }
    }
    return out;
  };
  for (const [bits, colors, columns] of [[8, 3, 6], [16, 1, 7], [4, 3, 4], [8, 1, 9]] as const) {
    const rowBytes = Math.ceil((bits * colors * columns) / 8);
    const raw = sample(rowBytes * 6, bits + colors);
    const z = await deflate(diff(raw, colors, rowBytes, bits));
    const s = await rawStream(doc, z, { Filter: 'FlateDecode', DecodeParms: { Predictor: 2, Colors: colors, BitsPerComponent: bits, Columns: columns } });
    assert.ok(same((await readStream(s))!, raw), `TIFF ${bits}bit ${colors}色`);
  }
});

await test('replaceStream: 辞書を保ち、Filter・Length を直し、DecodeParms を消す', async () => {
  const doc = await mkDoc();
  const old = await deflate(pngEncode(sample(12), 3, 1, [2]));
  const s = await rawStream(doc, old, { Subtype: 'Form', Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Columns: 3 }, Foo: 7, Bar: 8 });
  const ref = doc.context.getObjectRef(s)!;
  const data = enc('1 0 0 rg 10 10 5 5 re f');
  await replaceStream(doc, ref, data, { set: { Baz: PDFNumber.of(1) }, remove: ['Bar'] });
  const n = doc.context.lookup(ref) as PDFRawStream;
  assert.equal(String(n.dict.get(PDFName.of('Filter'))), '/FlateDecode');
  assert.equal(n.dict.get(PDFName.of('DecodeParms')), undefined);
  assert.equal(String(n.dict.get(PDFName.of('Subtype'))), '/Form');
  assert.equal(String(n.dict.get(PDFName.of('Foo'))), '7');
  assert.equal(n.dict.get(PDFName.of('Bar')), undefined);
  assert.equal(String(n.dict.get(PDFName.of('Baz'))), '1');
  assert.equal(String(n.dict.get(PDFName.of('Length'))), String(n.contents.length));
  assert.ok(same((await readStream(n))!, data));
  await replaceStream(doc, ref, data, { compress: false });
  const m = doc.context.lookup(ref) as PDFRawStream;
  assert.equal(m.dict.get(PDFName.of('Filter')), undefined);
  assert.ok(same(m.contents, data));
  // 保存して開き直しても同じ
  const re = await PDFDocument.load(await doc.save(), { updateMetadata: false });
  const r = re.context.lookup(ref) as PDFRawStream;
  assert.ok(same((await readStream(r))!, data));
});

console.log('画素の書き戻し(PNG の行ごとの予測)');

/** 写真のような画素(なめらかな勾配+細かいざらつき)。seed が同じなら同じ */
function photoLike(w: number, h: number, colors: number, seed = 1): Uint8Array {
  const out = new Uint8Array(w * h * colors);
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < colors; c++) {
        const base = 128 + 90 * Math.sin((x + c * 7) / 23) * Math.cos(y / 31);
        out[(y * w + x) * colors + c] = Math.max(0, Math.min(255, Math.round(base + (rnd() % 7) - 3)));
      }
    }
  }
  return out;
}

await test('pngPredict → readStream(Predictor 15): 成分 1・3・4・幅が 1 や奇数・ランダム・平ら・勾配のどれでも、読み戻した画素が1バイトも違わない', async () => {
  const doc = await mkDoc();
  const cases: Array<[number, number, number, string]> = [];
  for (const colors of [1, 3, 4]) {
    for (const [w, h] of [[1, 1], [1, 9], [2, 3], [7, 5], [31, 17], [64, 64]]) cases.push([colors, w, h, 'photo']);
  }
  for (const [colors, w, h, kind] of cases) {
    let px: Uint8Array;
    if (kind === 'photo') px = photoLike(w, h, colors, w * 31 + h);
    else px = new Uint8Array(w * h * colors);
    const s = await rawStream(doc, enc('x'), { Subtype: 'Image', Width: w, Height: h });
    const ref = doc.context.getObjectRef(s)!;
    await replaceStream(doc, ref, px, { predict: { colors, columns: w, rows: h } });
    const n = doc.context.lookup(ref) as PDFRawStream;
    const parms = n.dict.lookup(PDFName.of('DecodeParms')) as PDFDict;
    assert.equal(String(parms.get(PDFName.of('Predictor'))), '15');
    assert.equal(String(parms.get(PDFName.of('Colors'))), String(colors));
    assert.equal(String(parms.get(PDFName.of('BitsPerComponent'))), '8');
    assert.equal(String(parms.get(PDFName.of('Columns'))), String(w));
    assert.equal(String(n.dict.get(PDFName.of('Filter'))), '/FlateDecode');
    assert.equal(String(n.dict.get(PDFName.of('Length'))), String(n.contents.length));
    assert.ok(same((await readStream(n))!, px), `成分 ${colors}・${w}×${h}`);
  }
  // 平ら・全部 0・全部 255・交互・乱数そのもの
  const w = 33;
  const h = 11;
  const patterns: Record<string, Uint8Array> = {
    zero: new Uint8Array(w * h),
    full: new Uint8Array(w * h).fill(255),
    alt: Uint8Array.from({ length: w * h }, (_, i) => (i % 2 ? 255 : 0)),
    noise: Uint8Array.from({ length: w * h }, (_, i) => (i * 2654435761) >>> 24),
  };
  for (const [name, px] of Object.entries(patterns)) {
    const rt = await readStream(await rawStreamOf(doc, px, 1, w, h));
    assert.ok(same(rt!, px), name);
  }
});

/** replaceStream(predict) で作ったストリームを返す(読み戻しの検査用) */
async function rawStreamOf(doc: PDFDocument, px: Uint8Array, colors: number, w: number, h: number): Promise<PDFRawStream> {
  const s = await rawStream(doc, enc('x'), { Subtype: 'Image', Width: w, Height: h });
  const ref = doc.context.getObjectRef(s)!;
  await replaceStream(doc, ref, px, { predict: { colors, columns: w, rows: h } });
  return doc.context.lookup(ref) as PDFRawStream;
}

await test('pngPredict: 行ごとに None・Sub・Up・Average・Paeth のうち絶対値の和が小さいものを選ぶ(少なくとも 3 通りが使われ、選んだものは和が最小で、戻せる)', async () => {
  const w = 40;
  const colors = 1;
  const rows: number[][] = [];
  // 行 0 は 0 だらけ(None)・行 1 は横の勾配(Sub)・行 2 は行 1 と同じ(Up)・行 3 は上と左の平均で書ける形・行 4 は斜め(Paeth が有利)
  rows.push(Array.from({ length: w }, (_, i) => (i % 5 === 0 ? 1 : 0)));
  rows.push(Array.from({ length: w }, (_, i) => 10 + i * 3));
  rows.push(rows[1].slice());
  rows.push(Array.from({ length: w }, (_, i) => (i === 0 ? 50 : (rows[2][i] + (i > 0 ? 60 : 0)) & 0xff)));
  rows.push(Array.from({ length: w }, (_, i) => (i * 7 + 4 * 13) & 0xff));
  const px = Uint8Array.from(rows.flat());
  const filtered = pngPredict(px, colors, w);
  const tags = new Set<number>();
  for (let r = 0; r < rows.length; r++) tags.add(filtered[r * (w + 1)]);
  assert.ok(tags.size >= 3, `使われた方式: ${[...tags].join(',')}`);
  // 選んだ方式が、5通りのうち和が最小のものであること(別の書き方で数え直す)
  const abs8 = (v: number) => Math.abs(((v & 0xff) << 24) >> 24);
  for (let r = 0; r < rows.length; r++) {
    const cur = rows[r];
    const up = r > 0 ? rows[r - 1] : new Array(w).fill(0);
    const sums = [0, 0, 0, 0, 0];
    for (let i = 0; i < w; i++) {
      const a = i > 0 ? cur[i - 1] : 0;
      const b = up[i];
      const c = i > 0 ? up[i - 1] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      sums[0] += abs8(cur[i]);
      sums[1] += abs8(cur[i] - a);
      sums[2] += abs8(cur[i] - b);
      sums[3] += abs8(cur[i] - ((a + b) >> 1));
      sums[4] += abs8(cur[i] - pr);
    }
    assert.equal(filtered[r * (w + 1)], sums.indexOf(Math.min(...sums)), `行 ${r}: ${sums.join(',')}`);
  }
  const doc = await mkDoc();
  assert.ok(same((await readStream(await rawStreamOf(doc, px, colors, w, rows.length)))!, px));
});

await test('予測つきで詰めると、なめらかな絵は予測なしより小さくなる(写真のようなグレー 512×512 で 0.8 倍以下・ざらつきのある勾配は 0.5 倍以下)', async () => {
  const doc = await mkDoc();
  const photo = photoLike(512, 512, 1);
  const grad = Uint8Array.from({ length: 512 * 512 }, (_, i) => ((i % 512) >> 1) + (Math.floor(i / 512) >> 1) + (((i * 2654435761) >>> 28) % 3));
  for (const [name, px, limit] of [['photo', photo, 0.8], ['gradient', grad, 0.5]] as const) {
    const plain = (await deflate(px)).length;
    const predicted = (await rawStreamOf(doc, px, 1, 512, 512)).contents.length;
    assert.ok(predicted < plain * limit, `${name}: 予測なし ${plain} → 予測あり ${predicted}`);
  }
});

await test('replaceStream(predict): compress:false では予測を付けない・画素が足りないときは付けずに詰める・予測を渡さなければ今までどおり(DecodeParms なし)', async () => {
  const doc = await mkDoc();
  const px = photoLike(8, 8, 1);
  const s = await rawStream(doc, enc('x'), { Subtype: 'Image' });
  const ref = doc.context.getObjectRef(s)!;
  await replaceStream(doc, ref, px, { compress: false, predict: { colors: 1, columns: 8, rows: 8 } });
  let n = doc.context.lookup(ref) as PDFRawStream;
  assert.equal(n.dict.get(PDFName.of('DecodeParms')), undefined);
  assert.ok(same(n.contents, px));
  await replaceStream(doc, ref, px.subarray(0, 40), { predict: { colors: 1, columns: 8, rows: 8 } });
  n = doc.context.lookup(ref) as PDFRawStream;
  assert.equal(n.dict.get(PDFName.of('DecodeParms')), undefined);
  assert.ok(same((await readStream(n))!, px.subarray(0, 40)));
  await replaceStream(doc, ref, px);
  n = doc.context.lookup(ref) as PDFRawStream;
  assert.equal(n.dict.get(PDFName.of('DecodeParms')), undefined);
  // 画素が多いとき(後ろに余りがあるとき)は、必要なぶんだけ書く
  const longer = new Uint8Array(8 * 8 + 5).fill(9);
  await replaceStream(doc, ref, longer, { predict: { colors: 1, columns: 8, rows: 8 } });
  n = doc.context.lookup(ref) as PDFRawStream;
  assert.equal((await readStream(n))!.length, 64);
});

console.log('contentHolders');

/** ページ(Contents が1本)・ページ(配列2本)・Form・パターン・Type3 の字形を持つ小さな文書 */
async function buildDoc() {
  const doc = await mkDoc();
  const ctx = doc.context;
  const mk = async (text: string, extra: Record<string, unknown> = {}) => {
    const s = await rawStream(doc, await deflate(enc(text)), { Filter: 'FlateDecode', ...extra });
    return ctx.getObjectRef(s)!;
  };
  const form = await mk('0 0 0 rg 0 0 5 5 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] });
  const pattern = await mk('1 0 0 rg 0 0 3 3 re f', { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 4, 4], XStep: 4, YStep: 4, Resources: {} });
  const glyph = await mk('1000 0 d0 0 0 0 rg 0 0 5 5 re f');
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 10, 10], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { a: glyph }, Encoding: { Type: 'Encoding', Differences: [97, 'a'] }, FirstChar: 97, LastChar: 97, Widths: [1000] } as never));
  const page1 = doc.addPage([100, 100]);
  page1.node.set(PDFName.of('Contents'), await mk('0 0 0 rg 0 0 10 10 re f /Fm0 Do'));
  page1.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm0: form }, Font: { F1: font } } as never));
  const page2 = doc.addPage([100, 100]);
  const c1 = await mk('q 0 0 0 rg');
  const c2 = await mk('0 0 5 5 re f Q 1 0 0 rg 0 0 1 1 re f');
  page2.node.set(PDFName.of('Contents'), ctx.obj([c1, c2]));
  page2.node.set(PDFName.of('Resources'), ctx.obj({ Pattern: { P1: pattern } } as never));
  return { doc, c1, c2 };
}

await test('contentHolders: 種類と数・Contents 配列は1本につなぐ・Resources', async () => {
  const { doc } = await buildDoc();
  const h = await contentHolders(doc);
  assert.deepEqual(h.map((x) => x.kind), ['page', 'page', 'form', 'pattern', 'charproc']);
  assert.deepEqual(h.map((x) => x.label.replace(/ \d+ 0 R/, ' R')), ['ページ 1', 'ページ 2', 'フォーム R', 'パターン R', 'Type3 の字形 R']);
  assert.equal(dec(h[1].bytes), 'q 0 0 0 rg\n0 0 5 5 re f Q 1 0 0 rg 0 0 1 1 re f');
  assert.deepEqual(operations(h[1].bytes).map((o) => o.op), ['q', 'rg', 're', 'f', 'Q', 'rg', 're', 'f']);
  assert.equal(h[0].pageIndex, 0);
  assert.equal(h[1].pageIndex, 1);
  assert.ok(h[0].resources instanceof PDFDict);
  assert.ok(h[0].resources!.get(PDFName.of('XObject')));
  assert.ok(h[2].ref instanceof PDFRef);
  assert.ok(h[4].resources instanceof PDFDict, 'Type3 の字形はページの Resources を借りる'); // 字体に Resources が無いのでページ1のもの
  const sk: string[] = [];
  await contentHolders(doc, sk);
  assert.deepEqual(sk, []);
});

await test('contentHolders: 書き戻して保存 → 開き直すと、中身が変わり、ほかは壊れない', async () => {
  const { doc, c1, c2 } = await buildDoc();
  const h = await contentHolders(doc);
  for (const x of h) {
    const r = rewriteOperations(x.bytes, (o) => (o.op === 'rg' ? '0 g' : null));
    if (r.changed) await x.write(r.bytes);
  }
  const bytes = await doc.save();
  const re = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(re.getPageCount(), 2);
  const h2 = await contentHolders(re);
  assert.deepEqual(h2.map((x) => x.kind), ['page', 'page', 'form', 'pattern', 'charproc']);
  for (const x of h2) assert.equal(operations(x.bytes).filter((o) => o.op === 'rg').length, 0, x.label);
  assert.equal(dec(h2[0].bytes), '0 g 0 0 10 10 re f /Fm0 Do');
  assert.equal(dec(h2[1].bytes), 'q 0 g\n0 0 5 5 re f Q 0 g 0 0 1 1 re f');
  // Contents は配列から1本のストリームに替わり、古い断片は文書から消えている
  assert.ok(re.getPage(1).node.lookup(PDFName.of('Contents')) instanceof PDFRawStream);
  assert.equal(re.context.lookup(c1), undefined);
  assert.equal(re.context.lookup(c2), undefined);
  // 書き換えなかったものは変わらない(Form の BBox・Resources の XObject)
  assert.ok(re.getPage(0).node.Resources()!.lookup(PDFName.of('XObject')) instanceof PDFDict);
});

await test('contentHolders: 読めないもの(DCT・壊れた Flate)は skipped に入る', async () => {
  const doc = await mkDoc();
  const page = doc.addPage([10, 10]);
  const s = await rawStream(doc, sample(30), { Filter: 'DCTDecode' });
  page.node.set(PDFName.of('Contents'), doc.context.getObjectRef(s)!);
  const f = await rawStream(doc, sample(30), { Filter: 'FlateDecode', Type: 'XObject', Subtype: 'Form' });
  void f;
  const sk: string[] = [];
  const h = await contentHolders(doc, sk);
  assert.equal(h.length, 0);
  assert.equal(sk.length, 2);
  assert.ok(sk[0].startsWith('ページ 1') && sk[1].startsWith('フォーム'), sk.join('/'));
});

console.log('2026-10-01 の指摘(B1・B5・メモリ)');

await test('B1: forEachOperation は operations() と同じ命令を同じ順に渡す(BI・文字列・コメントを含む)', () => {
  const text = 'q 0 0 0 rg (a 1 0 0 rg) Tj % c 1 1 1 rg\nBI /W 1 /H 1 /CS /RGB /BPC 8 ID \x01\x02\x03 EI Q [(a) -5 (b)] TJ /Pattern cs /P1 scn 1 0 0 1 0 0 cm';
  const bytes = enc(text);
  const seen: Array<[string, number, number, number]> = [];
  forEachOperation(bytes, (o) => seen.push([o.op, o.start, o.end, o.operands.length]));
  assert.deepEqual(seen, operations(bytes).map((o) => [o.op, o.start, o.end, o.operands.length]));
  assert.ok(seen.length >= 9);
});

await test('B1: forEachOperation は、渡した命令を取っておいても、あとの命令で上書きされない', () => {
  const kept: ReturnType<typeof operations> = [];
  forEachOperation(enc('1 0 0 rg 0 1 0 RG 0 0 1 rg'), (o) => kept.push(o));
  assert.deepEqual(kept.map((o) => o.operands.map((t) => t.num)), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

await test('inflate / deflate: 1MB をまたぐ大きさの往復(流し込みの切れ目で壊れない)', async () => {
  const d = sample(3_500_000);
  const z = await deflate(d);
  assert.ok(same(await inflate(z), d));
});

await test('inflate の sizeHint: ちょうど・小さすぎ(あふれた分はつなぐ)・大きすぎ(詰め直す)・0・巨大な嘘 のどれでも、結果は同じ', async () => {
  const d = sample(2_700_000);
  const z = await deflate(d);
  for (const hint of [d.length, d.length - 1, 1, d.length + 5, d.length * 50, 0, -3, 2 ** 40, Number.NaN]) {
    const out = await inflate(z, hint);
    assert.equal(out.length, d.length, `hint ${hint}`);
    assert.ok(same(out, d), `hint ${hint}`);
  }
  // 申告より大きく小さいときは、余った入れ物を持ち続けない
  const small = await inflate(await deflate(enc('abc')), 10_000_000);
  assert.equal(dec(small), 'abc');
  assert.ok(small.buffer.byteLength < 1_000_000, String(small.buffer.byteLength));
});

await test('inflate: 壊れた入力・途中で切れた入力は、sizeHint が有っても例外(未処理の拒否にしない)', async () => {
  const z = await deflate(sample(300_000));
  await assert.rejects(inflate(z.subarray(0, Math.floor(z.length / 2)), 300_000));
  await assert.rejects(inflate(sample(5000), 5000));
  await assert.rejects(inflate(new Uint8Array(0)));
});

await test('readStream の sizeHint: 結果は付けても付けなくても同じ。Predictor 付き・外れた見込みでも壊れない', async () => {
  const doc = await mkDoc();
  const raw = sample(40_000);
  const plain = await rawStream(doc, await deflate(raw), { Filter: 'FlateDecode' });
  assert.ok(same((await readStream(plain)) as Uint8Array, raw));
  assert.ok(same((await readStream(plain, raw.length)) as Uint8Array, raw));
  assert.ok(same((await readStream(plain, 7)) as Uint8Array, raw));
  const rowBytes = 100;
  const rows = 400;
  const tagged = pngEncode(raw, rowBytes, 1, Array.from({ length: rows }, () => 2));
  const pred = await rawStream(doc, await deflate(tagged), { Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 1, Columns: rowBytes, BitsPerComponent: 8 } });
  const a = (await readStream(pred)) as Uint8Array;
  assert.ok(same((await readStream(pred, raw.length)) as Uint8Array, a));
  assert.ok(same(a, raw));
});

await test('メモリ: 150MB をほどくとき、sizeHint を渡すと、ほどいた大きさの1.4倍を超えて増えない(RSS の最大で比べる。別プロセス)', () => {
  const peak = (hint: boolean) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, CONTENT_CHILD: 'mem', CONTENT_HINT: hint ? '1' : '0' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const m = r.stdout.match(/MEMPEAK (\d+) (-?\d+)/);
    assert.ok(m, r.stdout);
    return { size: Number(m[1]), grew: Number(m[2]) };
  };
  const withHint = peak(true);
  const without = peak(false);
  console.log(`       ${withHint.size}MB をほどいたときの RSS の増え: 見込みあり +${withHint.grew}MB・見込みなし +${without.grew}MB`);
  assert.ok(withHint.grew < withHint.size * 1.4, `見込みありで +${withHint.grew}MB`);
});

/** 自前の Resources を持たない Form が、呼ぶ側の資源を継ぐ。入れ子・どこからも呼ばれない・自前の資源がある、の3通り */
async function inheritDoc() {
  const doc = await mkDoc();
  const ctx = doc.context;
  const mk = async (text: string, extra: Record<string, unknown> = {}) => ctx.getObjectRef(await rawStream(doc, await deflate(enc(text)), { Filter: 'FlateDecode', ...extra }))!;
  const formExtra = { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] };
  const inner = await mk('/Cs1 cs 0.5 0.5 0.5 sc', formExtra); // 資源なし。A から呼ばれる
  const outer = await mk('/Inner Do', { ...formExtra, Resources: { ColorSpace: { Cs1: PDFName.of('DeviceRGB') }, XObject: { Inner: inner } } }); // 自前の資源
  const bare = await mk('/Inner2 Do', formExtra); // 資源なし。ページから呼ばれる
  const inner2 = await mk('/Cs2 cs', formExtra); // 資源なし。bare から呼ばれる(入れ子で継ぐ)
  const lonely = await mk('0 g', formExtra); // どこからも呼ばれない
  const page = doc.addPage([100, 100]);
  page.node.set(PDFName.of('Contents'), await mk('/Outer Do /Bare Do'));
  const pageRes = ctx.obj({ ColorSpace: { Cs2: PDFName.of('DeviceGray') }, XObject: { Outer: outer, Bare: bare } } as never);
  page.node.set(PDFName.of('Resources'), pageRes);
  // bare は inner2 を呼ぶので、bare の資源(=ページの資源)に Inner2 が要る
  (pageRes as PDFDict).lookup(PDFName.of('XObject'), PDFDict).set(PDFName.of('Inner2'), inner2);
  return { doc, inner, outer, bare, inner2, lonely, pageRes };
}

await test('B5: contentHolders は、資源を持たない Form に、呼ぶ側の資源を渡す(入れ子も)。自前の資源は変えない。呼ばれない Form は null', async () => {
  const t = await inheritDoc();
  const hs = await contentHolders(t.doc);
  const of = (r: PDFRef) => hs.find((h) => h.ref?.toString() === r.toString())!;
  // inner は outer の資源を継ぐ
  assert.equal(of(t.inner).resources, of(t.outer).resources);
  assert.equal(of(t.inner).resourcesInherited, true);
  assert.ok(of(t.inner).resources?.has(PDFName.of('ColorSpace')));
  // 自前の資源は、そのまま
  assert.ok(!of(t.outer).resourcesInherited);
  assert.ok(of(t.outer).resources);
  // bare はページの資源を継ぎ、inner2 は bare 経由でページの資源を継ぐ
  assert.equal(of(t.bare).resources, hs.find((h) => h.kind === 'page')!.resources);
  assert.equal(of(t.inner2).resources, of(t.bare).resources);
  // どこからも呼ばれない Form は、資源が無いまま
  assert.equal(of(t.lonely).resources, null);
  assert.ok(!of(t.lonely).resourcesInherited);
});

await test('B5: buildDoc の Form(自前の資源なし)は、呼んでいるページの資源を継ぐ', async () => {
  const { doc } = await buildDoc();
  const hs = await contentHolders(doc);
  const form = hs.find((h) => h.kind === 'form')!;
  const page1 = hs.find((h) => h.kind === 'page' && h.pageIndex === 0)!;
  assert.equal(form.resourcesInherited, true);
  assert.equal(form.resources, page1.resources);
});

console.log('実物');

const dirEnv = process.env.PRESS_FIXTURES;
if (!dirEnv) console.log('  skip PRESS_FIXTURES が無いので、実物の検査は飛ばした');
else {
  for (const name of ['color-a5.pdf', 'mono-bunko.pdf', 'sakura-shinsho.pdf']) {
    const path = join(dirEnv, name);
    if (!existsSync(path)) {
      console.log(`  skip ${name} が無い`);
      continue;
    }
    const src = readFileSync(path);
    const doc = await PDFDocument.load(src, { updateMetadata: false });
    const sk: string[] = [];
    const t0 = performance.now();
    const holders = await contentHolders(doc, sk);
    const readMs = Math.round(performance.now() - t0);
    const kinds: Record<string, number> = {};
    const opCount: Record<string, number> = {};
    let rgPage = 0;
    let rgAll = 0;
    let nTokens = 0;
    const colorOps = new Set(['rg', 'RG', 'g', 'G', 'k', 'K', 'sc', 'SC', 'scn', 'SCN', 'cs', 'CS', 'sh', 'BI', 'Do', 'gs']);

    await test(`${name}: ホルダーを全部たどれる(読めなかったものが無い)`, () => {
      assert.deepEqual(sk, []);
      assert.ok(holders.filter((h) => h.kind === 'page').length === doc.getPageCount());
    });
    await test(`${name}: 全部のホルダーが字句に分かれ、何も変えない書き換えでバイト単位で同じ`, () => {
      for (const h of holders) {
        kinds[h.kind] = (kinds[h.kind] ?? 0) + 1;
        const t = tokenize(h.bytes);
        nTokens += t.length;
        let prev = 0;
        for (const k of t) {
          assert.ok(k.start >= prev && k.end <= h.bytes.length, h.label);
          prev = k.end;
        }
        const r = rewriteOperations(h.bytes, () => undefined);
        assert.ok(r.bytes === h.bytes && r.changed === 0, h.label);
        // 字句から作り直した命令の数と、operations の数が合う(取りこぼしが無い)
        const o = operations(h.bytes);
        for (const x of o) {
          if (colorOps.has(x.op)) opCount[`${h.kind}:${x.op}`] = (opCount[`${h.kind}:${x.op}`] ?? 0) + 1;
          if (x.op === 'rg' || x.op === 'RG') {
            rgAll++;
            if (h.kind === 'page') rgPage++;
            assert.equal(x.operands.length, 3, `${h.label} ${x.op}`);
          }
        }
      }
    });
    await test(`${name}: 書き戻して保存 → 開き直す(ページ数・各ページの Contents が読める)`, async () => {
      const copy = await PDFDocument.load(src, { updateMetadata: false });
      const hs = await contentHolders(copy);
      let changed = 0;
      for (const h of hs) {
        const r = rewriteOperations(h.bytes, (o) => (o.op === 'rg' || o.op === 'RG' ? (o.op === 'rg' ? '0 g' : '0 G') : null));
        if (r.changed) {
          await h.write(r.bytes);
          changed += r.changed;
        }
      }
      const re = await PDFDocument.load(await copy.save({ useObjectStreams: false }), { updateMetadata: false });
      assert.equal(re.getPageCount(), doc.getPageCount());
      const hs2 = await contentHolders(re);
      assert.equal(hs2.length, hs.length);
      let left = 0;
      for (let i = 0; i < hs2.length; i++) {
        const o = operations(hs2[i].bytes);
        left += o.filter((x) => x.op === 'rg' || x.op === 'RG').length;
        // 書き換えた数だけ命令の数は変わらない(rg → g で命令数は同じ)
        assert.equal(o.length, operations(hs[i].bytes).length, hs2[i].label);
      }
      assert.equal(left, 0);
      console.log(`       書き換え ${changed} 個`);
    });
    console.log(`       ${name}: ホルダー ${JSON.stringify(kinds)}・字句 ${nTokens}・読み込み ${readMs}ms`);
    console.log(`       rg/RG: ページの中身 ${rgPage}・全部 ${rgAll}`);
    console.log(`       色まわりの命令: ${JSON.stringify(opCount)}`);
    if (name === 'color-a5.pdf') {
      await test('color-a5.pdf: ページの中身だけで数えた rg と RG の合計が 422', () => assert.equal(rgPage, 422));
    }
  }
}

console.log(`\n${passed} 件通った・${failed.length} 件落ちた`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
// 使っていない import の警告を避ける(PDFArray は将来の検査で使う)
void PDFArray;
