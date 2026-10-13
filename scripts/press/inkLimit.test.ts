// src/press/inkLimit.ts の検査。`node scripts/press/inkLimit.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 実物の検査(Ghostscript に通した本文・表紙、scripts/check-press.py、絵の比べ)は、
// 置き場を環境変数 PRESS_FIXTURES で渡したときだけ回る。渡さなければ飛ばして、飛ばしたと表示する。
//   PRESS_FIXTURES=<color-a5.pdf などのあるフォルダ> node scripts/press/inkLimit.test.ts
// Ghostscript に通した結果は <PRESS_FIXTURES>/../out/inklimit/ に置いて使い回す(INKLIMIT_FRESH=1 で作り直す)。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { contentHolders, inflate, operations, readStream } from '../../src/press/content.ts';
import { clampCmyk, limitInk } from '../../src/press/inkLimit.ts';

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
const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} と ${b} が ${tol} 以上離れている`);
const sum4 = (v: number[]) => v[0] + v[1] + v[2] + v[3];

// ───────────────────────── 1. clampCmyk ─────────────────────────

console.log('clampCmyk の境界');

await test('上限以下の色はそのまま(同じ値)・ちょうど上限も触らない', () => {
  assert.deepEqual(clampCmyk(0.2, 0.3, 0.4, 0.5, 300), [0.2, 0.3, 0.4, 0.5]);
  // 0.3+0.3+0.2+0.2 は浮動小数で 1.0000000000000002 になる。ちょうど 100% の色を抑えない
  assert.deepEqual(clampCmyk(0.3, 0.3, 0.2, 0.2, 100), [0.3, 0.3, 0.2, 0.2]);
  assert.deepEqual(clampCmyk(0.75, 0.75, 0.75, 0.75, 300), [0.75, 0.75, 0.75, 0.75]);
  assert.deepEqual(clampCmyk(0, 0, 0, 1, 300), [0, 0, 0, 1]);
});

await test('わずかに超える色は、K を変えずに C・M・Y だけ下げる。合計は上限以下', () => {
  const [c, m, y, k] = clampCmyk(0.8, 0.8, 0.8, 0.61, 300);
  assert.equal(k, 0.61);
  assert.ok(c < 0.8 && m < 0.8 && y < 0.8);
  near(c + m + y + k, 3, 1e-12);
});

await test('4色ベタ 400% は 300% になる(K=100%、C=M=Y=約66.7%)', () => {
  const [c, m, y, k] = clampCmyk(1, 1, 1, 1, 300);
  assert.equal(k, 1);
  near(c, 2 / 3, 1e-12);
  near(m, 2 / 3, 1e-12);
  near(y, 2 / 3, 1e-12);
  near(sum4([c, m, y, k]), 3, 1e-12);
});

await test('C:M:Y の比が保たれる', () => {
  const [c, m, y, k] = clampCmyk(1, 0.8, 0.4, 0.9, 300);
  assert.equal(k, 0.9);
  near(c / m, 1 / 0.8, 1e-12);
  near(m / y, 0.8 / 0.4, 1e-12);
  near(sum4([c, m, y, k]), 3, 1e-12);
});

await test('K だけの色・C+M+Y だけの色(最大 300%)は上限 300 で触らない', () => {
  assert.deepEqual(clampCmyk(0, 0, 0, 1, 300), [0, 0, 0, 1]);
  assert.deepEqual(clampCmyk(1, 1, 1, 0, 300), [1, 1, 1, 0]);
});

await test('上限 240: 超える色だけが 240 に収まり、K は変わらない', () => {
  const r = clampCmyk(1, 1, 0.5, 0.7, 240);
  assert.equal(r[3], 0.7);
  near(sum4(r), 2.4, 1e-12);
  const under = clampCmyk(0.5, 0.5, 0.5, 0.8, 240);
  assert.deepEqual(under, [0.5, 0.5, 0.5, 0.8]);
});

await test('K だけで上限を超える(上限 80%)ときは C・M・Y を 0 にする。K は触らない', () => {
  assert.deepEqual(clampCmyk(0.5, 0.2, 0.1, 1, 80), [0, 0, 0, 1]);
});

await test('ランダムな 10000 色: 合計は上限以下、K は同じ、上限以下の色は同じ値のまま', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 10000; i++) {
    const v: [number, number, number, number] = [rnd(), rnd(), rnd(), rnd()];
    const limit = [240, 280, 300, 320][i % 4];
    const r = clampCmyk(...v, limit);
    assert.equal(r[3], v[3]);
    assert.ok(sum4(r) * 100 <= limit + 1e-6, `${v} → ${r}`);
    if (sum4(v) * 100 <= limit) assert.deepEqual(r, v);
  }
});

// ───────────────────────── 2. 手作りの PDF ─────────────────────────

console.log('手作りの PDF');

/** 手作りの文書。画像・影・描く命令・透明の設定を、変わるべきものと変わらないものに分けて入れる */
async function buildDoc() {
  const pdf = await PDFDocument.create();
  const ctx = pdf.context;
  const name = (s: string) => PDFName.of(s);
  const img = (w: number, h: number, cs: PDFObject | string, data: Uint8Array, extra: Record<string, unknown> = {}, bpc = 8): PDFRef => {
    const dict = {
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      ColorSpace: typeof cs === 'string' ? name(cs) : cs,
      BitsPerComponent: bpc,
      ...extra,
    };
    // Filter を自分で決める画像(JPEG)は、そのまま入れる。それ以外は Flate
    return ctx.register(extra.Filter ? ctx.stream(data, dict as never) : ctx.flateStream(data, dict as never));
  };
  const out: Record<string, PDFRef> = {};

  // ── 画像 ──
  // over: 画素ごとに 400%・349%・ちょうど 300%・K だけの黒
  out.over = img(4, 1, 'DeviceCMYK', Uint8Array.of(255, 255, 255, 255, 230, 230, 230, 200, 255, 255, 255, 0, 10, 20, 30, 255));
  // under: 全部上限以下。ICCBased(成分 4)。SMask つき(SMask の画像は測らない)
  const icc4 = ctx.register(ctx.stream(new Uint8Array(32), { N: 4 }));
  out.smask = img(2, 1, 'DeviceGray', Uint8Array.of(0, 255));
  out.under = img(2, 2, ctx.obj([name('ICCBased'), icc4]), Uint8Array.of(100, 50, 25, 60, 200, 100, 50, 150, 0, 0, 0, 255, 255, 200, 10, 0), { SMask: out.smask });
  // K だけ
  out.konly = img(2, 1, 'DeviceCMYK', Uint8Array.of(0, 0, 0, 255, 0, 0, 0, 128));
  // Predictor 15(PNG)。2行目は「上」の予測(タグ 2)で書く
  const row0 = [255, 255, 255, 255, 0, 0, 0, 0];
  const row1 = [230, 230, 230, 200, 10, 10, 10, 10];
  const pred = Uint8Array.from([0, ...row0, 2, ...row1.map((v, i) => (v - row0[i]) & 0xff)]);
  out.pred = img(2, 2, 'DeviceCMYK', pred, { DecodeParms: ctx.obj({ Predictor: 15, Colors: 4, Columns: 2, BitsPerComponent: 8 }) });
  // Decode 反転: 入っている数は 255 − 濃さ
  out.inv = img(2, 1, 'DeviceCMYK', Uint8Array.of(0, 0, 0, 0, 255, 255, 255, 0), { Decode: ctx.obj([1, 0, 1, 0, 1, 0, 1, 0]) });
  // Indexed(文字列の表・ストリームの表)
  const palette = [255, 255, 255, 255, 0, 0, 0, 255, 100, 50, 0, 0];
  out.idxStr = img(2, 1, ctx.obj([name('Indexed'), name('DeviceCMYK'), 2, PDFHexString.of(palette.map((v) => v.toString(16).padStart(2, '0')).join(''))]), Uint8Array.of(0x00, 0x10), {}, 4);
  const palRef = ctx.register(ctx.flateStream(Uint8Array.from(palette)));
  out.idxStream = img(2, 1, ctx.obj([name('Indexed'), name('DeviceCMYK'), 2, palRef]), Uint8Array.of(0x00, 0x10), {}, 4);
  // 手を入れられないもの
  out.dct = img(1, 1, 'DeviceCMYK', Uint8Array.of(1, 2, 3, 4), { Filter: name('DCTDecode') });
  out.rgb = img(1, 1, 'DeviceRGB', Uint8Array.of(1, 2, 3));
  out.deep = img(1, 1, 'DeviceCMYK', new Uint8Array(8), {}, 16);
  out.badDecode = img(1, 1, 'DeviceCMYK', Uint8Array.of(255, 255, 255, 255), { Decode: ctx.obj([0, 0.5, 0, 1, 0, 1, 0, 1]) });
  out.gray = img(2, 1, 'DeviceGray', Uint8Array.of(0, 255));

  // ── 影の指定 ──
  const fn2 = (c0: number[], c1: number[]) => ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: c0, C1: c1, N: 1 }));
  const axial = (fn: PDFObject, extra: Record<string, unknown> = {}) => ctx.register(ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceCMYK', Coords: [0, 0, 100, 0], Function: fn, ...extra }));
  out.sh2 = axial(fn2([1, 1, 1, 1], [0, 0, 0, 1]), { Background: [0.9, 0.9, 0.9, 0.9] });
  const stitched = ctx.register(
    ctx.obj({
      FunctionType: 3,
      Domain: [0, 1],
      Functions: [fn2([0.8, 0.8, 0.8, 0.8], [0, 0, 0, 0]), fn2([0, 0, 0, 0], [0.2, 0.2, 0.2, 0.2])],
      Bounds: [0.5],
      Encode: [0, 1, 0, 1],
    }),
  );
  out.sh3 = axial(stitched);
  const sampled = ctx.register(ctx.flateStream(Uint8Array.of(255, 255, 255, 255, 0, 0, 0, 0), { FunctionType: 0, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1], Size: [2], BitsPerSample: 8 }));
  out.sh0 = axial(sampled);
  const postscript = ctx.register(ctx.stream('{ dup dup dup }', { FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1] }));
  out.sh4 = axial(postscript);
  out.mesh = ctx.register(ctx.stream(new Uint8Array(10), { ShadingType: 4, ColorSpace: name('DeviceCMYK'), BitsPerCoordinate: 8, BitsPerComponent: 8, BitsPerFlag: 8, Decode: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1] }));
  const underFn = fn2([0.2, 0.2, 0.2, 0.2], [0, 0, 0, 1]);
  out.shUnder = axial(underFn);
  // 影のパターンの中に直に書かれた影
  const directFn = fn2([1, 1, 1, 1], [0, 0, 0, 0]);
  out.pattern = ctx.register(ctx.obj({ PatternType: 2, Shading: { ShadingType: 2, ColorSpace: 'DeviceCMYK', Coords: [0, 0, 1, 0], Function: directFn } }));
  out.fnOver = directFn;
  out.fnUnder = underFn;
  out.fnSampled = sampled;

  // ── 描く命令 ──
  const cs1 = ctx.obj([name('ICCBased'), icc4]);
  const cs2 = ctx.obj([name('Pattern'), name('DeviceCMYK')]);
  const page1 = [
    'q',
    '0.9 0.9 0.9 0.9 k',
    '(0.9 0.9 0.9 0.9 k) Tj',
    '0.2 0.2 0.2 0.5 K',
    '% 1 1 1 1 k comment',
    '/DeviceCMYK cs 0.8 0.8 0.8 0.8 scn',
    '/Cs1 CS 1 1 1 1 SC',
    '/Cs2 cs 0.9 0.9 0.9 0.9 /P1 scn',
    '/Cs3 cs 1 1 1 1 sc',
    'Q',
    'q /DeviceCMYK cs Q',
    '0.9 0.9 0.9 0.9 sc', // Q で DeviceGray に戻っているので、これは CMYK ではない
    '/GS1 gs',
  ].join('\n');
  const page2 = ['0.1 0.2 0.3 0.4 k', '1 0 0 1 K', '0 0 0 1 k', '(only under) Tj'].join('\n');
  const mk = (cmds: string) => ctx.register(ctx.stream(enc(cmds)));
  const resources = ctx.obj({
    ColorSpace: { Cs1: cs1, Cs2: cs2, Cs3: ctx.obj([name('Separation'), name('Spot'), name('DeviceCMYK'), ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 })]) },
    ExtGState: { GS1: { Type: 'ExtGState', BM: 'Multiply' } },
  });
  const p1 = pdf.addPage([200, 200]);
  p1.node.set(name('Contents'), mk(page1));
  p1.node.set(name('Resources'), resources);
  const p2 = pdf.addPage([200, 200]);
  out.content2 = mk(page2);
  p2.node.set(name('Contents'), out.content2);
  // Form: k のあとの sc は CMYK / 色空間を引き継いだままの 4 つの数 / CMYK のインライン画像
  const form = (cmds: string) => ctx.register(ctx.stream(enc(cmds), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
  out.form1 = form('0.9 0.9 0.9 0.9 k\n0.8 0.8 0.8 0.8 sc\n0.5 0.5 0.5 0.5 sc');
  out.form2 = form('0.1 0.1 0.1 0.1 sc');
  out.form3 = form('BI /W 1 /H 1 /BPC 8 /CS /CMYK ID \x01\x02\x03\x04 EI');
  // ExtGState の OP(間接オブジェクトとして)
  out.opGs = ctx.register(ctx.obj({ Type: 'ExtGState', OP: true }));
  out.page1 = p1.ref;
  out.page2 = p2.ref;
  return { bytes: await pdf.save({ useObjectStreams: false }), refs: out };
}

const built = await buildDoc();
const load = (b: Uint8Array) => PDFDocument.load(b, { updateMetadata: false });
const refOf = (name: string) => PDFRef.of(Number(built.refs[name].objectNumber), 0);
const pixelsOf = async (doc: PDFDocument, name: string) => {
  const s = doc.context.lookup(refOf(name)) as PDFRawStream;
  return Array.from((await readStream(s)) as Uint8Array);
};
const rawOf = (doc: PDFDocument, name: string) => (doc.context.lookup(refOf(name)) as PDFRawStream).contents;

const before = await load(built.bytes);
const origUnder = Buffer.from(rawOf(before, 'under'));
const origKonly = Buffer.from(rawOf(before, 'konly'));
const origBadDecode = Buffer.from(rawOf(before, 'badDecode'));
const origDct = Buffer.from(rawOf(before, 'dct'));
const origPage2 = Buffer.from(rawOf(before, 'content2'));
const origUnderFn = before.context.lookup(refOf('fnUnder')).toString();
const origUnderSh = before.context.lookup(refOf('shUnder')).toString();

const doc = await load(built.bytes);
const res = await limitInk(doc, 300);
console.log(`       ${JSON.stringify({ ...res, facts: res.facts.size })}`);

await test('数字: 前の最大 400%・あとの最大 300%・書き換えた画像 5・命令 6・影 4', () => {
  near(res.maxBefore, 400, 1e-6);
  assert.ok(res.maxAfter <= 300 + 1e-9, String(res.maxAfter));
  near(res.maxAfter, 300, 1e-6);
  assert.equal(res.limit, 300);
  assert.equal(res.images, 5);
  assert.equal(res.ops, 6);
  assert.equal(res.shadings, 4);
});

await test('画像 over: 超える画素だけ抑える(K は同じ・合計は 765 以下)。超えない画素は 1 バイトも変わらない', async () => {
  const p = await pixelsOf(doc, 'over');
  assert.deepEqual(p.slice(0, 4), [170, 170, 170, 255]); // 400% → 300%
  assert.deepEqual(p.slice(4, 8), [188, 188, 188, 200]); // 349% → 299.6%(切り捨て)
  assert.deepEqual(p.slice(8, 12), [255, 255, 255, 0]); // ちょうど 300% は触らない
  assert.deepEqual(p.slice(12, 16), [10, 20, 30, 255]);
  for (let i = 0; i < 16; i += 4) assert.ok(p[i] + p[i + 1] + p[i + 2] + p[i + 3] <= 765);
});

await test('画像 over の facts: 最大 300%・C/M/Y が付く', () => {
  const f = res.facts.get(built.refs.over.toString()) as { max: number; cmy: boolean };
  near(f.max, 300, 1e-6); // 抑えた 170+170+170+255 = 765 と、ちょうど 255+255+255+0 = 765
  assert.equal(f.cmy, true);
});

await test('画像 under(ICCBased N=4・SMask つき): ストリームのバイトが同じ。facts は出る', () => {
  assert.ok(origUnder.equals(Buffer.from(rawOf(doc, 'under'))));
  const f = res.facts.get(built.refs.under.toString()) as { max: number; cmy: boolean };
  near(f.max, (500 * 100) / 255, 1e-6); // 200+100+50+150
  assert.equal(f.cmy, true);
});

await test('SMask の画像は測らない(facts に入らない)', () => {
  assert.equal(res.facts.has(built.refs.smask.toString()), false);
});

await test('K だけの画像: 触らない。facts は cmy=false', () => {
  assert.ok(origKonly.equals(Buffer.from(rawOf(doc, 'konly'))));
  const f = res.facts.get(built.refs.konly.toString()) as { max: number; cmy: boolean };
  near(f.max, 100, 1e-6);
  assert.equal(f.cmy, false);
});

await test('Predictor 15 の画像: ほどいて抑え、予測を付け直して詰める(Colors 4・Columns 2)。読み戻した画素は抑えた値', async () => {
  const s = doc.context.lookup(refOf('pred')) as PDFRawStream;
  const parms = s.dict.lookup(PDFName.of('DecodeParms')) as PDFDict;
  assert.deepEqual(
    ['Predictor', 'Colors', 'BitsPerComponent', 'Columns'].map((k) => (parms.lookup(PDFName.of(k)) as PDFNumber).asNumber()),
    [15, 4, 8, 2],
  );
  assert.deepEqual(await pixelsOf(doc, 'pred'), [170, 170, 170, 255, 0, 0, 0, 0, 188, 188, 188, 200, 10, 10, 10, 10]);
});

await test('Decode 反転の画像: 濃さで測って抑え、反転のまま書く', async () => {
  // 濃さ (255,255,255,255) → (170,170,170,255)、入っている数は 255 − 濃さ = (85,85,85,0)。2画素目 (0,0,0,255) はそのまま
  assert.deepEqual(await pixelsOf(doc, 'inv'), [85, 85, 85, 0, 255, 255, 255, 0]);
  const f = res.facts.get(built.refs.inv.toString()) as { max: number };
  near(f.max, 300, 1e-6);
});

await test('Indexed(文字列の表): 表の色を抑える。表に無い色の数は変わらない', async () => {
  const s = doc.context.lookup(refOf('idxStr')) as PDFRawStream;
  const cs = s.dict.lookup(PDFName.of('ColorSpace')) as unknown as { lookup(i: number): { asBytes?(): Uint8Array } };
  const table = Array.from((cs.lookup(3) as { asBytes(): Uint8Array }).asBytes());
  assert.deepEqual(table, [170, 170, 170, 255, 0, 0, 0, 255, 100, 50, 0, 0]);
  assert.deepEqual(await pixelsOf(doc, 'idxStr'), [0x00, 0x10]);
});

await test('Indexed(ストリームの表): 表の色を抑える', async () => {
  const s = doc.context.lookup(refOf('idxStream')) as PDFRawStream;
  const cs = s.dict.lookup(PDFName.of('ColorSpace')) as unknown as { get(i: number): PDFRef };
  const table = await readStream(doc.context.lookup(cs.get(3)) as PDFRawStream);
  assert.deepEqual(Array.from(table as Uint8Array), [170, 170, 170, 255, 0, 0, 0, 255, 100, 50, 0, 0]);
});

await test('DeviceGray の画像は触らない(facts は 100%・cmy=false)', () => {
  const f = res.facts.get(built.refs.gray.toString()) as { max: number; cmy: boolean };
  near(f.max, 100, 1e-6);
  assert.equal(f.cmy, false);
});

await test('手を入れられない画像(JPEG の CMYK・RGB・16ビット・Decode が変)は unhandled に理由つきで出る。バイトは触らない', () => {
  const has = (key: string, why: string) =>
    assert.ok(res.unhandled.some((u) => u.includes(`画像 ${built.refs[key].toString()}`) && u.includes(why)), `${key}: ${why}\n${res.unhandled.join('\n')}`);
  has('dct', 'JPEG');
  has('rgb', 'RGB');
  has('deep', '8ビットでない');
  has('badDecode', 'Decode');
  assert.ok(origDct.equals(Buffer.from(rawOf(doc, 'dct'))));
  assert.ok(origBadDecode.equals(Buffer.from(rawOf(doc, 'badDecode'))));
  // 測れないものは「いちばん濃い・色が付く」側に倒す
  assert.deepEqual(res.facts.get(built.refs.dct.toString()), { max: 400, cmy: true });
});

await test('描く命令 1: k / K / cs+scn / CS+SC / パターンの scn を抑える。文字列・コメント・上限以下は 1 バイトも変わらない', async () => {
  const hs = await contentHolders(doc);
  const page = hs.find((h) => h.kind === 'page' && h.pageIndex === 0)!;
  const text = dec(page.bytes);
  assert.ok(text.includes('(0.9 0.9 0.9 0.9 k) Tj'));
  assert.ok(text.includes('% 1 1 1 1 k comment'));
  assert.ok(text.includes('0.2 0.2 0.2 0.5 K'));
  assert.ok(text.includes('/Cs3 cs 1 1 1 1 sc')); // 特色は触らない
  assert.ok(text.includes('0.9 0.9 0.9 0.9 sc')); // Q で DeviceGray に戻ったあと
  assert.ok(text.includes('/Cs2 cs ') && text.includes(' /P1 scn'));
  const ops = operations(page.bytes);
  const colorOps = ops.filter((o) => ['k', 'K', 'scn', 'SCN', 'SC'].includes(o.op) && o.operands.filter((t) => t.type === 'number').length === 4);
  assert.equal(colorOps.length, 5);
  let changedCount = 0;
  for (const o of colorOps) {
    const v = o.operands.filter((t) => t.type === 'number').map((t) => t.num as number);
    assert.ok(sum4(v) <= 3 + 1e-9, `${o.op} ${v}`);
    if (sum4(v) < 3 - 1e-9) continue;
    changedCount++;
  }
  // 0.9×4 の k は 0.7 0.7 0.7 0.9 になる
  const k = ops.find((o) => o.op === 'k')!;
  const kv = k.operands.map((t) => t.num as number);
  assert.ok(Math.abs(kv[0] - 0.7) < 2e-5 && kv[3] === 0.9, String(kv));
  assert.ok(changedCount >= 1);
  // 1 1 1 1 SC → 0.66666 … 1(切り捨て)
  const sc = ops.find((o) => o.op === 'SC')!;
  const sv = sc.operands.map((t) => t.num as number);
  assert.equal(sv[3], 1);
  assert.ok(sv[0] <= 2 / 3 && sv[0] > 2 / 3 - 2e-5);
  // パターンの名前は残る
  const pat = ops.find((o) => o.op === 'scn' && o.operands.some((t) => t.type === 'name' && t.text === 'P1'))!;
  assert.ok(pat);
});

await test('描く命令 2: 上限以下だけのページは、ストリームのバイトが同じ(書き戻さない)', () => {
  assert.ok(origPage2.length > 0);
  assert.ok(origPage2.equals(Buffer.from(rawOf(doc, 'content2'))));
});

await test('描く命令 3: Form。k のあとの sc も抑える。色空間を引き継いだ 4 つの数と CMYK のインライン画像は unhandled', async () => {
  const hs = await contentHolders(doc);
  const f1 = hs.find((h) => h.ref?.toString() === built.refs.form1.toString())!;
  const ops = operations(f1.bytes);
  assert.equal(ops.length, 3);
  for (const o of ops) assert.ok(sum4(o.operands.map((t) => t.num as number)) <= 3 + 1e-9);
  // 0.5×4(200%)は触らない
  assert.equal(dec(f1.bytes).split('\n')[2], '0.5 0.5 0.5 0.5 sc');
  assert.ok(res.unhandled.some((u) => u.includes('フォーム') && u.includes(built.refs.form2.toString()) && u.includes('引き継いだ')), res.unhandled.join('\n'));
  assert.ok(res.unhandled.some((u) => u.includes(built.refs.form3.toString()) && u.includes('インライン画像')), res.unhandled.join('\n'));
});

await test('描く命令 4: 特色の色空間は unhandled に出る', () => {
  assert.ok(res.unhandled.some((u) => u.includes('特色')), res.unhandled.join('\n'));
});

const num = (d: PDFDict, key: string): number[] => (d.lookup(PDFName.of(key)) as unknown as { asArray(): PDFNumber[] }).asArray().map((x) => x.asNumber());
const fnDict = (name: string): PDFDict => {
  const v = doc.context.lookup(refOf(name));
  return (v instanceof PDFRawStream ? v.dict : v) as PDFDict;
};

await test('影 Type 2: C0・C1 を抑える。/Background も抑える', () => {
  const sh = doc.context.lookup(refOf('sh2')) as PDFDict;
  const fn = sh.lookup(PDFName.of('Function')) as PDFDict;
  const c0 = num(fn, 'C0');
  assert.ok(sum4(c0) <= 3 + 1e-9);
  assert.equal(c0[3], 1);
  assert.deepEqual(num(fn, 'C1'), [0, 0, 0, 1]);
  const bg = num(sh, 'Background');
  assert.ok(sum4(bg) <= 3 + 1e-9 && Math.abs(bg[0] - 0.7) < 2e-5 && bg[3] === 0.9, String(bg));
  const f = res.facts.get(built.refs.sh2.toString()) as { max: number; cmy: boolean };
  assert.ok(f.max <= 300 + 1e-6 && f.cmy);
});

await test('影 Type 3(つなぎ): 中の Type 2 をそれぞれ抑える。超えない側は変わらない', () => {
  const stitched = (doc.context.lookup(refOf('sh3')) as PDFDict).lookup(PDFName.of('Function')) as PDFDict;
  const subs = stitched.lookup(PDFName.of('Functions')) as unknown as { size(): number; lookup(i: number): PDFDict };
  const a = subs.lookup(0);
  const b = subs.lookup(1);
  assert.ok(sum4(num(a, 'C0')) <= 3 + 1e-9 && num(a, 'C0')[0] < 0.8); // 320% → 300%
  assert.deepEqual(num(a, 'C1'), [0, 0, 0, 0]);
  assert.deepEqual(num(b, 'C1'), [0.2, 0.2, 0.2, 0.2]);
});

await test('影 Type 0(標本): 標本を抑える', async () => {
  const s = doc.context.lookup(refOf('fnSampled')) as PDFRawStream;
  assert.deepEqual(Array.from((await readStream(s)) as Uint8Array), [170, 170, 170, 255, 0, 0, 0, 0]);
});

await test('影 Type 4(計算式)・網の影: 測れないので unhandled(facts は 400%・cmy)。上限以下の影は触らない', () => {
  assert.ok(res.unhandled.some((u) => u.includes(`影の指定 ${built.refs.sh4.toString()}`) && u.includes('計算式')), res.unhandled.join('\n'));
  assert.ok(res.unhandled.some((u) => u.includes(`影の指定 ${built.refs.mesh.toString()}`) && u.includes('網')), res.unhandled.join('\n'));
  assert.deepEqual(res.facts.get(built.refs.sh4.toString()), { max: 400, cmy: true });
  assert.deepEqual(res.facts.get(built.refs.mesh.toString()), { max: 400, cmy: true });
  assert.equal(doc.context.lookup(refOf('fnUnder')).toString(), origUnderFn);
  assert.equal(doc.context.lookup(refOf('shUnder')).toString(), origUnderSh);
  const f = res.facts.get(built.refs.shUnder.toString()) as { max: number };
  near(f.max, 100, 1e-6); // C1 = 0 0 0 1 は 100%、C0 = 0.2×4 は 80%
});

await test('パターンの中に直に書かれた影も抑える', () => {
  const fn = fnDict('fnOver');
  assert.ok(sum4(num(fn, 'C0')) <= 3 + 1e-9);
  assert.ok([...res.facts.keys()].some((k) => k.startsWith(built.refs.pattern.toString()) && k.includes('の中の影')));
});

await test('乗算の合成モード(直に書かれた ExtGState)・オーバープリントは unhandled', () => {
  assert.ok(res.unhandled.some((u) => u.includes('乗算') && u.includes(built.refs.page1.toString())), res.unhandled.join('\n'));
  assert.ok(res.unhandled.some((u) => u.includes('オーバープリント') && u.includes(built.refs.opGs.toString())), res.unhandled.join('\n'));
});

await test('書き出して読み直して Infinity で測り直す: maxBefore = maxAfter = 300(unhandled の中身は同じ)', async () => {
  const again = await load(await doc.save({ useObjectStreams: false }));
  const r2 = await limitInk(again, Infinity);
  near(r2.maxBefore, r2.maxAfter, 1e-9);
  near(r2.maxAfter, 300, 1e-6);
  assert.equal(r2.images + r2.ops + r2.shadings, 0);
  assert.equal(r2.limit, Infinity);
  assert.deepEqual([...r2.unhandled].sort(), [...res.unhandled].sort());
  // 2 度目の抑えも何も変えない(冪等)
  const r3 = await limitInk(again, 300);
  assert.equal(r3.images + r3.ops + r3.shadings, 0);
});

await test('Infinity で測るだけ: 何も書き換えない(maxBefore = maxAfter = 400)', async () => {
  const fresh = await load(built.bytes);
  const r = await limitInk(fresh, Infinity);
  assert.equal(r.images + r.ops + r.shadings, 0);
  near(r.maxBefore, 400, 1e-6);
  near(r.maxAfter, 400, 1e-6);
  assert.deepEqual(await pixelsOf(fresh, 'over'), Array.from(Buffer.from((await inflate(rawOf(before, 'over'))))));
  assert.ok(r.facts.size > 5);
});

await test('上限を変える: 240% にすると、300% で止まっていた画素も抑える', async () => {
  const d240 = await load(built.bytes);
  const r = await limitInk(d240, 240);
  assert.ok(r.maxAfter <= 240 + 1e-9, String(r.maxAfter));
  const p = await pixelsOf(d240, 'over');
  for (let i = 0; i < 16; i += 4) assert.ok(p[i] + p[i + 1] + p[i + 2] + p[i + 3] <= 612);
  assert.equal(p[11], 0); // 255 255 255 0 は 300% → 240% に下がる
  assert.ok(p[8] < 255);
});

// ───────────────────────── 2b. 2026-10-01 の指摘(A3・B3・B5) ─────────────────────────

console.log('指摘の直し(A3・B3・B5)');

/** 1ページの文書を組んで、保存して開き直す(中身は Chrome の PDF と同じ PDFRawStream になる) */
async function mini(opts: {
  content: string;
  resources?: Record<string, unknown>;
  build?: (pdf: PDFDocument) => Record<string, unknown>;
}): Promise<{ doc: PDFDocument; refs: Record<string, PDFRef> }> {
  const pdf = await PDFDocument.create();
  const ctx = pdf.context;
  const extra = opts.build ? opts.build(pdf) : {};
  const page = pdf.addPage([200, 200]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ ...(opts.resources ?? {}), ...extra }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(enc(opts.content))));
  const saved = await pdf.save({ useObjectStreams: false });
  return { doc: await PDFDocument.load(saved, { updateMetadata: false }), refs: {} };
}

const cmykImage = (pdf: PDFDocument, data: number[], extra: Record<string, unknown> = {}): PDFRef =>
  pdf.context.register(
    pdf.context.flateStream(Uint8Array.from(data), { Type: 'XObject', Subtype: 'Image', Width: data.length / 4, Height: 1, ColorSpace: PDFName.of('DeviceCMYK'), BitsPerComponent: 8, ...extra } as never),
  );
const imageRefs = (doc: PDFDocument): PDFRef[] => [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && o.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')).map(([r]) => r);
const bytesOf = async (doc: PDFDocument, ref: PDFRef) => Array.from((await readStream(doc.context.lookup(ref) as PDFRawStream)) as Uint8Array);

await test('A3: パターンの下地が特色(`[/Pattern [/Separation …]]`)のとき、unhandled に出る。下地が CMYK のパターンは出ない', async () => {
  const sepFn = { FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 };
  const spot = await mini({
    content: '/Cs1 cs 1 /P1 scn 0 0 10 10 re f',
    resources: { ColorSpace: { Cs1: [PDFName.of('Pattern'), [PDFName.of('Separation'), PDFName.of('All'), PDFName.of('DeviceCMYK'), sepFn]] } },
  });
  const r = await limitInk(spot.doc, 300);
  assert.ok(r.unhandled.some((u) => u.includes('ページ 1') && u.includes('特色')), r.unhandled.join('\n'));
  const cmyk = await mini({
    content: '/Cs1 cs 0.1 0.1 0.1 0.1 /P1 scn 0 0 10 10 re f',
    resources: { ColorSpace: { Cs1: [PDFName.of('Pattern'), PDFName.of('DeviceCMYK')] } },
  });
  const r2 = await limitInk(cmyk.doc, 300);
  assert.deepEqual(r2.unhandled, []);
});

await test('B3: /Mask が数の配列(色抜き)の CMYK 画像は、抑える必要があるとき書き換えず unhandled。画素は1つも変わらない', async () => {
  const m = await mini({
    content: '/Im Do',
    build: (pdf) => ({ XObject: { Im: cmykImage(pdf, [255, 255, 200, 100, 10, 10, 10, 10], { Mask: [255, 255, 255, 255, 200, 200, 100, 100] }) } }),
  });
  const [ref] = imageRefs(m.doc);
  const before = await bytesOf(m.doc, ref);
  const r = await limitInk(m.doc, 300);
  assert.deepEqual(await bytesOf(m.doc, ref), before);
  assert.equal(r.images, 0);
  assert.ok(r.unhandled.some((u) => u.includes(`画像 ${ref.toString()}`) && u.includes('色抜き')), r.unhandled.join('\n'));
  // 嘘をつかない: 上限を超えたまま。報告の最大は、抑えていない値(317.6%)
  assert.ok(r.maxAfter > 300 + 1e-6, String(r.maxAfter));
  near(r.maxBefore, ((255 + 255 + 200 + 100) * 100) / 255, 1e-6);
  assert.deepEqual(r.facts.get(ref.toString())?.cmy, true);
});

await test('B3: /Mask の配列があっても、上限以下の画像は、そのまま(unhandled に出さない)', async () => {
  const m = await mini({
    content: '/Im Do',
    build: (pdf) => ({ XObject: { Im: cmykImage(pdf, [100, 100, 100, 100], { Mask: [0, 0, 0, 0, 0, 0, 0, 0] }) } }),
  });
  const r = await limitInk(m.doc, 300);
  assert.deepEqual(r.unhandled, []);
  assert.equal(r.images, 0);
});

await test('B3: /Matte つきの SMask を持つ CMYK 画像も、抑える必要があるとき書き換えず unhandled', async () => {
  const m = await mini({
    content: '/Im Do',
    build: (pdf) => {
      const smask = pdf.context.register(
        pdf.context.flateStream(Uint8Array.of(255, 128), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: PDFName.of('DeviceGray'), BitsPerComponent: 8, Matte: [0, 0, 0, 0] } as never),
      );
      return { XObject: { Im: cmykImage(pdf, [255, 255, 255, 255, 10, 10, 10, 10], { SMask: smask }) } };
    },
  });
  const img = imageRefs(m.doc).find((r) => (m.doc.context.lookup(r) as PDFRawStream).dict.has(PDFName.of('SMask')))!;
  const before = await bytesOf(m.doc, img);
  const r = await limitInk(m.doc, 300);
  assert.deepEqual(await bytesOf(m.doc, img), before);
  assert.equal(r.images, 0);
  assert.ok(r.unhandled.some((u) => u.includes(`画像 ${img.toString()}`) && u.includes('Matte')), r.unhandled.join('\n'));
});

await test('B3 の対照: Mask も Matte も無い同じ画像は、これまでどおり抑える', async () => {
  const m = await mini({ content: '/Im Do', build: (pdf) => ({ XObject: { Im: cmykImage(pdf, [255, 255, 200, 100, 10, 10, 10, 10]) } }) });
  const [ref] = imageRefs(m.doc);
  const r = await limitInk(m.doc, 300);
  assert.deepEqual(r.unhandled, []);
  assert.equal(r.images, 1);
  const p = await bytesOf(m.doc, ref);
  assert.ok(p[0] + p[1] + p[2] + p[3] <= 765);
});

await test('B3: 圧縮の無い画像で、抑えずに測るだけのときも、元のバイトを書き換えない', async () => {
  const m = await mini({
    content: '/Im Do',
    build: (pdf) => ({
      XObject: { Im: pdf.context.register(pdf.context.stream(Uint8Array.of(255, 255, 200, 100), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: PDFName.of('DeviceCMYK'), BitsPerComponent: 8, Mask: [0, 0, 0, 0, 0, 0, 0, 0] } as never)) },
    }),
  });
  const [ref] = imageRefs(m.doc);
  await limitInk(m.doc, 300);
  assert.deepEqual(Array.from((m.doc.context.lookup(ref) as PDFRawStream).contents), [255, 255, 200, 100]);
});

await test('B5: 自前の /Resources を持たない Form は、呼ぶ側の ColorSpace で名前を引き、CMYK なら抑える', async () => {
  const m = await mini({
    content: '/Fm1 Do',
    build: (pdf) => {
      const ctx = pdf.context;
      const form = ctx.register(ctx.stream(enc('/Cs1 cs 1 1 1 1 sc'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
      return { ColorSpace: { Cs1: PDFName.of('DeviceCMYK') }, XObject: { Fm1: form } };
    },
  });
  const r = await limitInk(m.doc, 300);
  assert.equal(r.ops, 1);
  assert.deepEqual(r.unhandled, []);
  const hs = await contentHolders(m.doc);
  const f = hs.find((h) => h.kind === 'form')!;
  const v = operations(f.bytes).find((o) => o.op === 'sc')!.operands.map((t) => t.num as number);
  assert.ok(sum4(v) <= 3 + 1e-9, String(v));
});

// ───────────────────────── 3. 実物 ─────────────────────────

const dirEnv = process.env.PRESS_FIXTURES;
if (!dirEnv) console.log('\n  [飛ばした] PRESS_FIXTURES が無いので、実物の検査は飛ばした');
else {
  const fixtures = resolve(dirEnv);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = join(fixtures, '..', 'out', 'inklimit');
  mkdirSync(outDir, { recursive: true });
  const icc = readFileSync(join(fixtures, 'JapanColor2011Coated.icc'));
  console.log(`\n実物(${fixtures})`);

  /** SPEC.md 6 の「カラー」の引数で Ghostscript に通す。結果は使い回す */
  async function viaGhostscript(name: string): Promise<Uint8Array> {
    const cache = join(outDir, `gs-${name}`);
    if (existsSync(cache) && !process.env.INKLIMIT_FRESH) return new Uint8Array(readFileSync(cache));
    const factory = (await import('@okathira/ghostpdl-wasm')).default as unknown as (o: Record<string, unknown>) => Promise<{
      callMain(a: string[]): number;
      FS: { mkdir(p: string): void; writeFile(p: string, d: Uint8Array): void; readFile(p: string): Uint8Array };
    }>;
    const gs = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
    gs.FS.mkdir('/work');
    gs.FS.writeFile('/work/in.pdf', new Uint8Array(readFileSync(join(fixtures, name))));
    gs.FS.writeFile('/work/JapanColor2011Coated.icc', new Uint8Array(icc));
    const code = gs.callMain([
      '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6',
      '-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK', '-dOverrideICC=true',
      '-sOutputICCProfile=/work/JapanColor2011Coated.icc', '-dDeviceGrayToK=true',
      '-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false',
      '-dColorImageFilter=/FlateEncode', '-dGrayImageFilter=/FlateEncode',
      '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
      '-sOutputFile=/work/out.pdf', '/work/in.pdf',
    ]);
    assert.equal(code, 0, `Ghostscript が ${code} で終わった`);
    const out = gs.FS.readFile('/work/out.pdf');
    writeFileSync(cache, out);
    return out;
  }

  const python = spawnSync('python', ['--version'], { encoding: 'utf-8' });
  const havePython = python.status === 0;
  if (!havePython) console.log('  [飛ばした] python が呼べないので、独立の検査(check-press.py)と絵の比べは飛ばす');
  const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  const checkPress = (kind: string, orig: string, out: string, extra: string[]) =>
    spawnSync(
      'python',
      [join(repo, 'scripts', 'check-press.py'), '--kind', kind, '--orig', join(fixtures, orig), '--out', out, ...extra, '--ink-limit', '300', '--icc', join(repo, 'src', 'press', 'JapanColor2011Coated.icc'), '--only', 'ink'],
      { encoding: 'utf-8', env: pyEnv, cwd: repo },
    );
  /** check-press.py の表(p3:300/299 の形)から、直読みの最大 */
  const directMax = (text: string): number => Math.max(...[...text.matchAll(/p\d+:(\d+)\/\d+/g)].map((m) => Number(m[1])));

  const cases: Array<{ name: string; label: string; kind: string; extra: string[]; expectBefore: [number, number] }> = [
    { name: 'color-a5.pdf', label: '本文(color-a5)', kind: 'body-cmyk', extra: ['--trim', '148x210', '--bleed', '3.2,3.2,3.2,0', '--first-gutter', 'right'], expectBefore: [330, 365] },
    { name: 'cover-color.pdf', label: '表紙(cover-color)', kind: 'cover-cmyk', extra: ['--trim', '297.9x210', '--bleed', '3.2,3.2,3.2,3.2'], expectBefore: [320, 365] },
  ];
  const limited: Record<string, string> = {};
  for (const c of cases) {
    const gsOut = await viaGhostscript(c.name);
    let result: Awaited<ReturnType<typeof limitInk>> | null = null;
    let outPath = '';
    await test(`${c.label}: Ghostscript(CMYK)のあとに limitInk(300): 前 ${c.expectBefore[0]}〜${c.expectBefore[1]}%・あと 300% 以下・unhandled なし・測り直しが合う`, async () => {
      const d = await PDFDocument.load(gsOut, { updateMetadata: false });
      const t0 = performance.now();
      result = await limitInk(d, 300);
      const ms = Math.round(performance.now() - t0);
      const saved = await d.save({ useObjectStreams: false });
      outPath = join(outDir, `limited-${c.name}`);
      writeFileSync(outPath, saved);
      limited[c.name] = outPath;
      const { facts, ...rest } = result;
      console.log(`       ${c.label}: ${ms}ms(限る処理だけ)  ${JSON.stringify(rest)}  facts ${facts.size}  ${gsOut.length} → ${saved.length} バイト`);
      assert.ok(result.maxBefore >= c.expectBefore[0] && result.maxBefore <= c.expectBefore[1], `前の最大 ${result.maxBefore}%`);
      assert.ok(result.maxAfter <= 300 + 1e-9, `あとの最大 ${result.maxAfter}%`);
      assert.deepEqual(result.unhandled, []);
      assert.ok(result.images > 0);
      const again = await PDFDocument.load(saved, { updateMetadata: false });
      const r2 = await limitInk(again, Infinity);
      near(r2.maxAfter, result.maxAfter, 1e-6);
      near(r2.maxBefore, r2.maxAfter, 1e-9);
      assert.deepEqual(r2.unhandled, []);
    });
    if (c.name === 'cover-color.pdf' && result) {
      // 表紙は 3594×2556 = 9,186,264 画素。読む・測る・詰め直すまで込みの時間は上の行
      console.log('       (表紙 9,186,264 画素の時間は上の行の「ms」)');
    }
    if (havePython) {
      await test(`${c.label}: 独立の検査 check-press.py(ink)が、限る前は落ち、限ったあとは通る。直読みの最大が合う`, () => {
        const pre = checkPress(c.kind, c.name, join(outDir, `gs-${c.name}`), c.extra);
        assert.equal(pre.status, 1, `限る前: 終了コード ${pre.status}\n${pre.stdout}${pre.stderr}`.slice(0, 600));
        const post = checkPress(c.kind, c.name, limited[c.name], c.extra);
        assert.equal(post.status, 0, `限ったあと: 終了コード ${post.status}\n${post.stdout}${post.stderr}`.slice(0, 1200));
        const r = result as Awaited<ReturnType<typeof limitInk>>;
        const dPre = directMax(pre.stdout);
        const dPost = directMax(post.stdout);
        console.log(`       check-press の直読み最大: 前 ${dPre}%(こちらの測り ${r.maxBefore.toFixed(2)}%)・あと ${dPost}%(こちら ${r.maxAfter.toFixed(2)}%)`);
        assert.ok(Math.abs(dPre - r.maxBefore) <= 1, `前: ${dPre} と ${r.maxBefore}`);
        assert.ok(Math.abs(dPost - r.maxAfter) <= 1, `あと: ${dPost} と ${r.maxAfter}`);
      });
    }
  }

  await test('試作の本文(trial-v4-color-out.pdf): 画像が JPEG のものは unhandled に出る。JPEG でない所だけが抑えられる', async () => {
    const d = await PDFDocument.load(new Uint8Array(readFileSync(join(fixtures, 'trial-v4-color-out.pdf'))), { updateMetadata: false });
    const r = await limitInk(d, 300);
    const jpeg = r.unhandled.filter((u) => u.includes('JPEG'));
    console.log(`       trial-v4: 前 ${r.maxBefore.toFixed(2)}% → あと ${r.maxAfter.toFixed(2)}%・JPEG ${jpeg.length} 枚・ほかの unhandled ${r.unhandled.length - jpeg.length}`);
    assert.ok(jpeg.length > 0);
    assert.equal(r.unhandled.length, jpeg.length);
    assert.ok(r.maxAfter <= 300 + 1e-9);
  });

  await test('試作の表紙(trial-v1-cover-out.pdf): JPEG の画像は unhandled', async () => {
    const d = await PDFDocument.load(new Uint8Array(readFileSync(join(fixtures, 'trial-v1-cover-out.pdf'))), { updateMetadata: false });
    const r = await limitInk(d, 300);
    assert.ok(r.unhandled.some((u) => u.includes('JPEG')));
  });

  if (havePython) {
    // 抑える前後の絵の差。RGB に直したものの差(0〜255)。ICC を効かせた変換と、素朴な変換の両方
    const script = `
import sys, json
import numpy as np, pymupdf
from PIL import Image, ImageCms
pymupdf.TOOLS.set_icc(False)
a = pymupdf.open(sys.argv[1]); b = pymupdf.open(sys.argv[2])
pages = [int(x) for x in sys.argv[3].split(',')]
jc = ImageCms.getOpenProfile(sys.argv[4]); srgb = ImageCms.createProfile('sRGB')
tf = ImageCms.buildTransform(jc, srgb, 'CMYK', 'RGB', renderingIntent=1, flags=ImageCms.Flags.BLACKPOINTCOMPENSATION)
rows = []
for p in pages:
    pa = a[p].get_pixmap(dpi=100, colorspace=pymupdf.csCMYK, alpha=False)
    pb = b[p].get_pixmap(dpi=100, colorspace=pymupdf.csCMYK, alpha=False)
    ia = Image.frombytes('CMYK', (pa.w, pa.h), pa.samples); ib = Image.frombytes('CMYK', (pb.w, pb.h), pb.samples)
    ra = np.asarray(ImageCms.applyTransform(ia, tf)).astype(int); rb = np.asarray(ImageCms.applyTransform(ib, tf)).astype(int)
    d = np.abs(ra - rb)
    ca = np.frombuffer(pa.samples, np.uint8).astype(int); cb = np.frombuffer(pb.samples, np.uint8).astype(int)
    rows.append({'page': p + 1, 'icc_max': int(d.max()), 'icc_mean': round(float(d.mean()), 4), 'cmyk_max': int(np.abs(ca - cb).max()), 'cmyk_mean': round(float(np.abs(ca - cb).mean()), 4)})
print(json.dumps(rows))
`;
    for (const [name, pages] of [['color-a5.pdf', '0,2,12,20,26'], ['cover-color.pdf', '0']] as const) {
      await test(`絵の比べ ${name}: 抑える前後で、見た目の差がごく小さい(RGB で最大 40 以下・平均 3 以下)`, () => {
        const r = spawnSync('python', ['-c', script, join(outDir, `gs-${name}`), limited[name], pages, join(repo, 'src', 'press', 'JapanColor2011Coated.icc')], { encoding: 'utf-8', env: pyEnv });
        assert.equal(r.status, 0, r.stderr.slice(0, 600));
        const rows = JSON.parse(r.stdout.trim().split('\n').pop() as string) as Array<{ page: number; icc_max: number; icc_mean: number; cmyk_max: number; cmyk_mean: number }>;
        for (const x of rows) console.log(`       ${name} p${x.page}: RGB(ICC)の差 最大 ${x.icc_max}・平均 ${x.icc_mean} / CMYK の数の差 最大 ${x.cmyk_max}・平均 ${x.cmyk_mean}`);
        for (const x of rows) {
          assert.ok(x.icc_max <= 40, `p${x.page} 最大 ${x.icc_max}`);
          assert.ok(x.icc_mean <= 3, `p${x.page} 平均 ${x.icc_mean}`);
        }
      });
    }
  }
}

console.log(`\n${passed} 件通った・${failed.length} 件落ちた`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
