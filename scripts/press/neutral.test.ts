// src/press/neutral.ts の検査。`node scripts/press/neutral.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 実物の PDF(Chrome が書き出した本文)の検査は、置き場を環境変数 PRESS_FIXTURES で渡したときだけ回る。
//   PRESS_FIXTURES=<color-a5.pdf などのあるフォルダ> node scripts/press/neutral.test.ts
// Ghostscript まで通す検査(1回 20 秒前後)は、さらに PRESS_GS=1 を付けたときだけ回る。PyMuPDF(python)が要る。
// 渡さなければ飛ばして、飛ばしたと表示する。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import { contentHolders, deflate, operations, readStream } from '../../src/press/content.ts';
import { neutralize } from '../../src/press/neutral.ts';
import type { NeutralDeps } from '../../src/press/neutral.ts';

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

const N = (s: string) => PDFName.of(s);
const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const dec = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

// ───────────────────────── 手作りの PDF を組む道具 ─────────────────────────

type Plain = Record<string, unknown>;

interface Built {
  doc: PDFDocument;
  /** 組んだときに登録した物の参照(名前で引く) */
  refs: Record<string, PDFRef>;
}

/**
 * 1ページの PDF を組む。**保存して開き直す**ので、中身のストリームは Chrome の PDF と同じ PDFRawStream になる。
 * extra は「名前 → 登録する物(辞書か、{dict, bytes} でストリーム)」。参照は refs に入る。
 * resources / content の中の文字列 '@名前' は、その参照に置き換える
 */
async function build(opts: {
  content: string | string[];
  resources?: Plain;
  extra?: Record<string, Plain | { dict: Plain; bytes: Uint8Array }>;
}): Promise<Built> {
  const src = await PDFDocument.create();
  const ctx = src.context;
  const page = src.addPage([200, 200]);
  const refs: Record<string, PDFRef> = {};
  // 先に参照だけ確保する(物どうしが互いを指せるように)
  for (const k of Object.keys(opts.extra ?? {})) refs[k] = ctx.nextRef();
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('@')) return refs[v.slice(1)];
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const o: Plain = {};
      for (const [k, x] of Object.entries(v)) o[k] = fix(x);
      return o;
    }
    return v;
  };
  for (const [k, v] of Object.entries(opts.extra ?? {})) {
    if ('bytes' in v && v.bytes instanceof Uint8Array) ctx.assign(refs[k], PDFRawStream.of(ctx.obj(fix(v.dict) as Plain), v.bytes));
    else ctx.assign(refs[k], ctx.obj(fix(v) as Plain));
  }
  page.node.set(N('Resources'), ctx.obj(fix(opts.resources ?? {}) as Plain));
  const contents = Array.isArray(opts.content) ? opts.content : [opts.content];
  const cRefs = contents.map((c) => ctx.register(ctx.flateStream(enc(c))));
  page.node.set(N('Contents'), cRefs.length === 1 ? cRefs[0] : ctx.obj(cRefs));
  const doc = await PDFDocument.load(await src.save({ useObjectStreams: false }), { updateMetadata: false });
  return { doc, refs };
}

/** ページの描く命令を、つないだ1本の文字にする(Contents が配列なら改行1つでつなぐ) */
async function textOf(doc: PDFDocument, i = 0): Promise<string> {
  const c = doc.getPage(i).node.get(N('Contents'));
  const v = c instanceof PDFRef ? doc.context.lookup(c) : c;
  const list = v instanceof PDFArray ? v.asArray().map((x) => doc.context.lookup(x as PDFRef)) : [v];
  const parts: string[] = [];
  for (const s of list) parts.push(dec((await readStream(s as PDFRawStream)) as Uint8Array));
  return parts.join('\n');
}

const get = (b: Built, k: string) => b.doc.context.lookup(b.refs[k]);
const dictOf = (v: unknown): PDFDict => (v instanceof PDFDict ? v : (v as PDFRawStream).dict);
const nums = (v: unknown): number[] => (v as PDFArray).asArray().map((x) => (x as PDFNumber).asNumber());

// ───────────────────────── 1. 描く命令 ─────────────────────────

console.log('描く命令');

await test('rg / RG: 無彩色だけ g / G になり、色つき・文字列の中・色つきの RG は1バイトも変わらない', async () => {
  const b = await build({
    content: 'q 0 0 0 rg 10 10 50 50 re f Q\n0.5 0.5 0.5 RG 0 0 1 rg\n(0 0 0 rg) Tj\n1 0 0 RG\n.25 .25 .25 rg',
  });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), 'q 0 g 10 10 50 50 re f Q\n0.5 G 0 0 1 rg\n(0 0 0 rg) Tj\n1 0 0 RG\n0.25 g');
  assert.deepEqual({ ops: r.ops, shadings: r.shadings, images: r.images, skipped: r.skipped }, { ops: 3, shadings: 0, images: 0, skipped: [] });
});

await test('0.0003 の差は同じ灰(Skia の小数の揺れ)。0.002 の差は色つき', async () => {
  const b = await build({ content: '0.6 0.60003 0.6 rg 0.6 0.602 0.6 rg' });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '0.60001 g 0.6 0.602 0.6 rg');
  assert.equal(r.ops, 1);
});

await test('色つきだけの内容は、保存し直しても内容のバイトが同じ(書き換えない)', async () => {
  const b = await build({ content: '0 0 1 rg 1 0 0 RG /DeviceRGB cs 0.1 0.2 0.3 sc 10 10 5 5 re f' });
  const before = await textOf(b.doc);
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), before);
  assert.equal(r.ops, 0);
});

await test('/DeviceRGB cs のあとの sc / scn と、CS のあとの SC / SCN。無彩色が混じるグループでは色つきも rg / RG にそろえる', async () => {
  const b = await build({ content: '/DeviceRGB cs 0.2 0.2 0.2 sc 1 0 0 scn /DeviceRGB CS 0.1 0.1 0.1 SCN 0 1 0 SC' });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/DeviceRGB cs 0.2 g 1 0 0 rg /DeviceRGB CS 0.1 G 0 1 0 RG');
  assert.equal(r.ops, 4);
});

await test('/DeviceRGB cs のあと、色つきの sc だけのグループは触らない', async () => {
  const b = await build({ content: '/DeviceRGB cs 1 0 0 sc 0 0 1 sc' });
  await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/DeviceRGB cs 1 0 0 sc 0 0 1 sc');
});

await test('資源の ColorSpace の名前が DeviceRGB を指すとき', async () => {
  const b = await build({ content: '/Cs1 cs 0.4 0.4 0.4 sc', resources: { ColorSpace: { Cs1: N('DeviceRGB') } } });
  await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/Cs1 cs 0.4 g');
});

await test('q … Q をまたぐと、色空間が戻る', async () => {
  // Q のあとは DeviceRGB に戻っているので、3つの数の sc は RGB の指定
  const a = await build({ content: '/DeviceRGB cs q /DeviceGray cs 0.5 sc Q 0.4 0.4 0.4 sc' });
  await neutralize(a.doc);
  assert.equal(await textOf(a.doc), '/DeviceRGB cs q /DeviceGray cs 0.5 sc Q 0.4 g');
  // q の中で RGB にしても、Q のあとはもとの DeviceGray。3つの数の sc は RGB の指定ではないので触らない
  const b = await build({ content: 'q /DeviceRGB cs Q 0.4 0.4 0.4 sc' });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), 'q /DeviceRGB cs Q 0.4 0.4 0.4 sc');
  assert.equal(r.ops, 0);
  // 塗りと線は別々に追う
  const c = await build({ content: '/DeviceRGB cs /DeviceGray CS 0.3 0.3 0.3 SC 0.3 0.3 0.3 sc' });
  await neutralize(c.doc);
  assert.equal(await textOf(c.doc), '/DeviceRGB cs /DeviceGray CS 0.3 0.3 0.3 SC 0.3 g');
});

await test('パターン: scn の名前つき・[/Pattern /DeviceRGB] の色つきパターンは触らない', async () => {
  const b = await build({
    content: '/Pattern cs /P1 scn /Cs2 cs 0.5 0.5 0.5 /P1 scn 0 0 0 rg',
    resources: { ColorSpace: { Cs2: [N('Pattern'), N('DeviceRGB')] } },
  });
  await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/Pattern cs /P1 scn /Cs2 cs 0.5 0.5 0.5 /P1 scn 0 g');
});

await test('ICCBased(N=3): 無彩色だけのグループはグレーにする。色つきが混じるグループは触らず skipped', async () => {
  const icc = { dict: { N: 3, Alternate: N('DeviceRGB') }, bytes: new Uint8Array(0) };
  const b = await build({
    content: '/Icc cs 0.5 0.5 0.5 sc /Icc2 cs 0.3 0.3 0.3 sc 1 0 0 sc /Icc1 cs 0.7 0.7 0.7 sc',
    resources: { ColorSpace: { Icc: [N('ICCBased'), '@icc'], Icc2: [N('ICCBased'), '@icc'], Icc1: [N('ICCBased'), '@icc1'] } },
    extra: { icc, icc1: { dict: { N: 1 }, bytes: new Uint8Array(0) } },
  });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/Icc cs 0.5 g /Icc2 cs 0.3 0.3 0.3 sc 1 0 0 sc /Icc1 cs 0.7 0.7 0.7 sc');
  assert.equal(r.ops, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /Icc2/);
});

await test('ページの Contents が配列でも、つないで読んで、書き戻せる', async () => {
  const b = await build({ content: ['0 0 0 rg 1 1 5 5 re', 'f 0.2 0.2 0.2 RG 0 0 1 rg'] });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '0 g 1 1 5 5 re\nf 0.2 G 0 0 1 rg');
  assert.equal(r.ops, 2);
});

await test('フォーム: 中の rg は直る。色空間を引き継ぐ sc(cs が無い)は触らない', async () => {
  const b = await build({
    content: '/Fm1 Do',
    resources: { XObject: { Fm1: '@form' } },
    extra: {
      form: {
        dict: { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 10, 10] },
        bytes: enc('0 0 0 rg 0.5 0.5 0.5 sc 0.2 0.2 0.2 RG'),
      },
    },
  });
  const r = await neutralize(b.doc);
  assert.equal(dec((await readStream(get(b, 'form') as PDFRawStream)) as Uint8Array), '0 g 0.5 0.5 0.5 sc 0.2 G');
  assert.equal(r.ops, 2);
});

await test('インライン画像の色空間が RGB なら、触らずに skipped へ', async () => {
  const b = await build({ content: 'q BI /W 1 /H 1 /CS /RGB /BPC 8 ID \u0001\u0001\u0001 EI Q 0 0 0 rg' });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), 'q BI /W 1 /H 1 /CS /RGB /BPC 8 ID \u0001\u0001\u0001 EI Q 0 g');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /インライン画像/);
});

// ───────────────────────── 2. 影の指定 ─────────────────────────

console.log('影の指定(Shading)');

const fn2 = (c0: number[], c1: number[], extra: Plain = {}): Plain => ({ FunctionType: 2, Domain: [0, 1], C0: c0, C1: c1, N: 1, ...extra });
const shade = (fn: unknown, extra: Plain = {}, cs: unknown = N('DeviceRGB'), type = 2): Plain => ({
  ShadingType: type,
  ColorSpace: cs,
  Coords: [0, 0, 100, 0],
  Function: fn,
  ...extra,
});
const pattern = (shading: unknown): Plain => ({ Type: N('Pattern'), PatternType: 2, Shading: shading });
const patRes = (...names: string[]): Plain => ({ Pattern: Object.fromEntries(names.map((n) => [n, `@${n}`])) });
const shOf = (b: Built, k: string): PDFDict => dictOf(get(b, k)).lookup(N('Shading')) as PDFDict;

await test('Type 2 の無彩色: 色空間が DeviceGray・C0 C1 が1成分・Range も1成分。色つきは toString まで同じ', async () => {
  const b = await build({
    content: '/Pattern cs /pa scn 0 0 5 5 re f /pb scn',
    resources: patRes('pa', 'pb'),
    extra: {
      pa: pattern(shade(fn2([0.2, 0.2, 0.2], [0.8, 0.8, 0.8], { Range: [0, 1, 0, 1, 0, 1] }))),
      pb: pattern(shade(fn2([1, 0, 0], [0, 0, 1]))),
    },
  });
  const colored = shOf(b, 'pb').toString();
  const r = await neutralize(b.doc);
  const a = shOf(b, 'pa');
  assert.equal(a.lookup(N('ColorSpace')), N('DeviceGray'));
  const f = a.lookup(N('Function')) as PDFDict;
  assert.deepEqual(nums(f.lookup(N('C0'))), [0.2]);
  assert.deepEqual(nums(f.lookup(N('C1'))), [0.8]);
  assert.deepEqual(nums(f.lookup(N('Range'))), [0, 1]);
  assert.equal(shOf(b, 'pb').toString(), colored);
  assert.equal(r.shadings, 1);
});

await test('C0 C1 が無い Type 2 は、3成分なら [0 0 0] [1 1 1] とみなす(無彩色)', async () => {
  const b = await build({
    content: '/Pattern cs /pa scn',
    resources: patRes('pa'),
    extra: { pa: pattern(shade({ FunctionType: 2, Domain: [0, 1], N: 1 })) },
  });
  const r = await neutralize(b.doc);
  const f = shOf(b, 'pa').lookup(N('Function')) as PDFDict;
  assert.deepEqual([nums(f.lookup(N('C0'))), nums(f.lookup(N('C1')))], [[0], [1]]);
  assert.equal(r.shadings, 1);
});

await test('同じ Function を、無彩色の影と色つきの影(背景が色つき)が共有 → 色つきの側は元の関数のまま', async () => {
  const b = await build({
    content: '/Pattern cs /pa scn /pb scn',
    resources: patRes('pa', 'pb'),
    extra: {
      fn: fn2([0.5, 0.5, 0.5], [0.9, 0.9, 0.9]),
      pa: pattern(shade('@fn')),
      pb: pattern(shade('@fn', { Background: [1, 0, 0] })),
    },
  });
  const r = await neutralize(b.doc);
  const a = shOf(b, 'pa');
  const c = shOf(b, 'pb');
  assert.equal(a.lookup(N('ColorSpace')), N('DeviceGray'));
  assert.deepEqual(nums((a.lookup(N('Function')) as PDFDict).lookup(N('C0'))), [0.5]);
  assert.equal(c.lookup(N('ColorSpace')), N('DeviceRGB'));
  assert.equal(c.get(N('Function')), b.refs.fn);
  assert.deepEqual(nums((c.lookup(N('Function')) as PDFDict).lookup(N('C0'))), [0.5, 0.5, 0.5]);
  assert.equal(r.shadings, 1);
  assert.ok(get(b, 'fn'), '色つきの影が使っている元の関数は残る');
});

await test('同じ Function を無彩色の影2つが共有 → 作り直した関数を共有し、元の関数は捨てる', async () => {
  const b = await build({
    content: '/Pattern cs /pa scn /pb scn',
    resources: patRes('pa', 'pb'),
    extra: { fn: fn2([0.1, 0.1, 0.1], [0.4, 0.4, 0.4]), pa: pattern(shade('@fn')), pb: pattern(shade('@fn')) },
  });
  const r = await neutralize(b.doc);
  assert.equal(r.shadings, 2);
  const fa = shOf(b, 'pa').get(N('Function'));
  assert.ok(fa instanceof PDFRef);
  assert.equal(fa, shOf(b, 'pb').get(N('Function')), '2つの影が同じ新しい関数を指す');
  assert.notEqual(fa, b.refs.fn);
  assert.equal(get(b, 'fn'), undefined, '誰も使わなくなった元の関数は文書から消える');
});

await test('Type 3(つなぎ): 中が全部 Type 2 の無彩色なら直る。色つきが1つでも混じれば触らない', async () => {
  const stitch = (a: Plain, c: Plain): Plain => ({ FunctionType: 3, Domain: [0, 1], Functions: [a, c], Bounds: [0.5], Encode: [0, 1, 0, 1] });
  const b = await build({
    content: '/Pattern cs /pa scn /pb scn',
    resources: patRes('pa', 'pb'),
    extra: {
      f1: fn2([0, 0, 0], [0.5, 0.5, 0.5]),
      pa: pattern(shade(stitch(fn2([0.2, 0.2, 0.2], [0.4, 0.4, 0.4]), fn2([0.4, 0.4, 0.4], [1, 1, 1])))),
      pb: pattern(shade(stitch(fn2([0.2, 0.2, 0.2], [0.4, 0.4, 0.4]), fn2([0.4, 0.4, 0.4], [1, 0, 0])))),
      pc: pattern(shade({ FunctionType: 3, Domain: [0, 1], Functions: ['@f1', '@f1'], Bounds: [0.5], Encode: [0, 1, 0, 1] })),
    },
  });
  const coloredBefore = shOf(b, 'pb').toString();
  const r = await neutralize(b.doc);
  assert.equal(r.shadings, 2);
  const fa = shOf(b, 'pa').lookup(N('Function')) as PDFDict;
  const kids = (fa.lookup(N('Functions')) as PDFArray).asArray().map((k) => nums((k as PDFDict).lookup(N('C1'))));
  assert.deepEqual(kids, [[0.4], [1]]);
  assert.equal(shOf(b, 'pb').toString(), coloredBefore);
  // 参照で持たれた子の関数(pc の f1)は、親の Type 3 を作り直した時に子も作り直され、元の f1 は誰も使わなくなって消える
  assert.equal(shOf(b, 'pc').lookup(N('ColorSpace')), N('DeviceGray'));
  assert.equal(get(b, 'f1'), undefined);
});

await test('Type 0(標本): 8ビット・3出力で全標本が無彩色 → 1出力。色つきの標本が1つでもあれば触らない', async () => {
  const sampled = (bytes: number[]) => ({
    dict: { FunctionType: 0, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1], Size: [3], BitsPerSample: 8 },
    bytes: Uint8Array.from(bytes),
  });
  const b = await build({
    content: '/Pattern cs /pa scn /pb scn',
    resources: patRes('pa', 'pb'),
    extra: {
      f0: sampled([0, 0, 0, 128, 128, 128, 255, 255, 255]),
      f1: sampled([0, 0, 0, 128, 129, 128, 255, 255, 255]),
      pa: pattern(shade('@f0')),
      pb: pattern(shade('@f1')),
    },
  });
  const r = await neutralize(b.doc);
  assert.equal(r.shadings, 1);
  const f = shOf(b, 'pa').lookup(N('Function')) as PDFRawStream;
  assert.deepEqual(Array.from((await readStream(f)) as Uint8Array), [0, 128, 255]);
  assert.deepEqual(nums(f.dict.lookup(N('Range'))), [0, 1]);
  assert.equal(shOf(b, 'pb').lookup(N('ColorSpace')), N('DeviceRGB'));
  assert.equal(shOf(b, 'pb').get(N('Function')), b.refs.f1);
});

await test('Type 4(計算式)・成分ごとの関数の配列・メッシュは触らず skipped', async () => {
  const b = await build({
    content: '/Pattern cs /pa scn /pb scn /pc scn',
    resources: patRes('pa', 'pb', 'pc'),
    extra: {
      f4: { dict: { FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1] }, bytes: enc('{dup dup}') },
      pa: pattern(shade('@f4', {}, N('DeviceRGB'), 1)),
      pb: pattern(shade([fn2([0], [1]), fn2([0], [1]), fn2([0], [1])])),
      mesh: { dict: { ShadingType: 4, ColorSpace: N('DeviceRGB'), BitsPerCoordinate: 8, BitsPerComponent: 8, BitsPerFlag: 8, Decode: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1] }, bytes: new Uint8Array(0) },
      pc: pattern(shade(fn2([0, 0, 0], [1, 1, 1]))),
    },
  });
  const before = [shOf(b, 'pa').toString(), shOf(b, 'pb').toString()];
  const r = await neutralize(b.doc);
  assert.deepEqual([shOf(b, 'pa').toString(), shOf(b, 'pb').toString()], before);
  assert.equal(r.shadings, 1, 'pc だけが直る');
  assert.equal(r.skipped.length, 3);
  assert.ok(r.skipped.some((s) => /計算式/.test(s)));
  assert.ok(r.skipped.some((s) => /成分ごと/.test(s)));
  assert.ok(r.skipped.some((s) => /メッシュ/.test(s)));
});

await test('/Background: 無彩色なら1成分にする。色つきならその影は触らない', async () => {
  const b = await build({
    content: '/Pattern cs /pa scn /pb scn',
    resources: patRes('pa', 'pb'),
    extra: {
      pa: pattern(shade(fn2([0, 0, 0], [1, 1, 1]), { Background: [0.3, 0.3, 0.3] })),
      pb: pattern(shade(fn2([0, 0, 0], [1, 1, 1]), { Background: [0.3, 0.3, 0.9] })),
    },
  });
  const before = shOf(b, 'pb').toString();
  const r = await neutralize(b.doc);
  assert.deepEqual(nums(shOf(b, 'pa').lookup(N('Background'))), [0.3]);
  assert.equal(shOf(b, 'pb').toString(), before);
  assert.equal(r.shadings, 1);
});

await test('資源の /Shading の中の影(sh 用)・ICCBased(N=3) の色空間の影・もとから DeviceGray の影', async () => {
  const icc = { dict: { N: 3 }, bytes: new Uint8Array(0) };
  const b = await build({
    content: '/Sh1 sh',
    resources: {
      Shading: {
        Sh1: shade(fn2([0.1, 0.1, 0.1], [0.9, 0.9, 0.9])),
        Sh2: shade(fn2([0.1, 0.1, 0.1], [0.9, 0.9, 0.9]), {}, [N('ICCBased'), '@icc']),
        Sh3: shade(fn2([0], [1]), {}, N('DeviceGray')),
      },
    },
    extra: { icc },
  });
  const r = await neutralize(b.doc);
  const res = dictOf(b.doc.getPage(0).node).lookup(N('Resources')) as PDFDict;
  const sh = res.lookup(N('Shading')) as PDFDict;
  assert.equal((sh.lookup(N('Sh1')) as PDFDict).lookup(N('ColorSpace')), N('DeviceGray'));
  assert.equal((sh.lookup(N('Sh2')) as PDFDict).lookup(N('ColorSpace')), N('DeviceGray'));
  assert.equal((sh.lookup(N('Sh3')) as PDFDict).lookup(N('ColorSpace')), N('DeviceGray'));
  assert.equal(r.shadings, 2);
});

// ───────────────────────── 3. 画像 ─────────────────────────

console.log('画像');

const imgDict = (w: number, h: number, cs: unknown, extra: Plain = {}): Plain => ({
  Type: N('XObject'),
  Subtype: N('Image'),
  Width: w,
  Height: h,
  ColorSpace: cs,
  BitsPerComponent: 8,
  Filter: N('FlateDecode'),
  ...extra,
});
const flat = async (dict: Plain, raw: number[]) => ({ dict, bytes: await deflate(Uint8Array.from(raw)) });
const imgOf = (b: Built, k: string) => get(b, k) as PDFRawStream;
const pix = async (b: Built, k: string) => Array.from((await readStream(imgOf(b, k))) as Uint8Array);

await test('無彩色の RGB の Flate 画像 → 1成分の DeviceGray・Flate・予測(Colors 1)つき。Interpolate・SMask は保つ', async () => {
  const b = await build({
    content: '/Im1 Do',
    resources: { XObject: { Im1: '@im' } },
    extra: {
      mask: await flat(imgDict(2, 1, N('DeviceGray')), [255, 128]),
      im: await flat(imgDict(2, 1, N('DeviceRGB'), { Interpolate: true, SMask: '@mask' }), [10, 10, 10, 200, 200, 200]),
    },
  });
  const r = await neutralize(b.doc);
  const d = imgOf(b, 'im').dict;
  assert.equal(d.lookup(N('ColorSpace')), N('DeviceGray'));
  assert.equal(d.lookup(N('Filter')), N('FlateDecode'));
  const parms = d.lookup(N('DecodeParms')) as PDFDict;
  assert.deepEqual(['Predictor', 'Colors', 'BitsPerComponent', 'Columns'].map((k) => Number(String(parms.lookup(N(k))))), [15, 1, 8, 2]);
  assert.equal(String(d.lookup(N('Interpolate'))), 'true');
  assert.equal(d.get(N('SMask')), b.refs.mask);
  assert.equal((d.lookup(N('Length')) as PDFNumber).asNumber(), imgOf(b, 'im').contents.length);
  assert.deepEqual(await pix(b, 'im'), [10, 200]);
  assert.equal(r.images, 1);
});

await test('色つきの画像(1画素だけ違う)は、辞書もバイトも同じ', async () => {
  const b = await build({
    content: '',
    extra: { im: await flat(imgDict(2, 1, N('DeviceRGB')), [10, 10, 10, 200, 200, 201]) },
  });
  const before = [imgOf(b, 'im').dict.toString(), Buffer.from(imgOf(b, 'im').contents)];
  const r = await neutralize(b.doc);
  assert.equal(imgOf(b, 'im').dict.toString(), before[0]);
  assert.ok(Buffer.from(imgOf(b, 'im').contents).equals(before[1] as Buffer));
  assert.equal(r.images, 0);
  assert.deepEqual(r.skipped, []);
});

await test('ICCBased(N=3) の無彩色の画像も直る。N=1・CMYK・DeviceGray・16ビット・ImageMask は触らない', async () => {
  const b = await build({
    content: '',
    extra: {
      icc3: { dict: { N: 3 }, bytes: new Uint8Array(0) },
      icc1: { dict: { N: 1 }, bytes: new Uint8Array(0) },
      a: await flat(imgDict(1, 1, [N('ICCBased'), '@icc3']), [7, 7, 7]),
      b: await flat(imgDict(1, 1, [N('ICCBased'), '@icc1']), [7]),
      c: await flat(imgDict(1, 1, N('DeviceCMYK')), [1, 2, 3, 4]),
      d: await flat(imgDict(1, 1, N('DeviceGray')), [7]),
      e: await flat(imgDict(1, 1, N('DeviceRGB'), { BitsPerComponent: 16 }), [7, 7, 7, 7, 7, 7]),
      f: await flat(imgDict(8, 1, N('DeviceGray'), { ImageMask: true, BitsPerComponent: 1 }), [0xaa]),
    },
  });
  const snap = (k: string) => imgOf(b, k).dict.toString() + Buffer.from(imgOf(b, k).contents).toString('hex');
  const before = ['b', 'c', 'd', 'e', 'f'].map(snap);
  const r = await neutralize(b.doc);
  assert.equal(r.images, 1);
  assert.equal(imgOf(b, 'a').dict.lookup(N('ColorSpace')), N('DeviceGray'));
  assert.deepEqual(['b', 'c', 'd', 'e', 'f'].map(snap), before);
});

await test('Predictor 15(PNG の予測)つきの無彩色の画像: 予測を戻してからグレーにし、成分 1 の予測を付け直す(読み戻した画素は同じ)', async () => {
  // 3×2 の RGB。1行目は予測なし(0)、2行目は上との差(2)
  const row0 = [10, 10, 10, 20, 20, 20, 30, 30, 30];
  const row1 = [40, 40, 40, 50, 50, 50, 60, 60, 60];
  const raw = [0, ...row0, 2, ...row1.map((v, i) => (v - row0[i]) & 0xff)];
  const b = await build({
    content: '',
    extra: { im: await flat(imgDict(3, 2, N('DeviceRGB'), { DecodeParms: { Predictor: 15, Colors: 3, Columns: 3, BitsPerComponent: 8 } }), raw) },
  });
  const r = await neutralize(b.doc);
  assert.equal(r.images, 1);
  const parms = imgOf(b, 'im').dict.lookup(N('DecodeParms')) as PDFDict;
  assert.deepEqual(['Predictor', 'Colors', 'Columns'].map((k) => Number(String(parms.lookup(N(k))))), [15, 1, 3]);
  assert.deepEqual(await pix(b, 'im'), [10, 20, 30, 40, 50, 60]);
});

await test('Indexed(元が RGB): 色の表が全部無彩色なら、元を DeviceGray にした表に。色つきの表は触らない', async () => {
  const b = await build({
    content: '',
    extra: {
      a: await flat(imgDict(2, 1, [N('Indexed'), N('DeviceRGB'), 2, PDFHexString.of('000000808080ffffff')], { BitsPerComponent: 8 }), [0, 2]),
      b: await flat(imgDict(2, 1, [N('Indexed'), N('DeviceRGB'), 1, PDFHexString.of('000000808081')], { BitsPerComponent: 8 }), [0, 1]),
    },
  });
  const before = imgOf(b, 'b').dict.toString();
  const r = await neutralize(b.doc);
  assert.equal(r.images, 1);
  const cs = imgOf(b, 'a').dict.lookup(N('ColorSpace')) as PDFArray;
  assert.equal(cs.lookup(0), N('Indexed'));
  assert.equal(cs.lookup(1), N('DeviceGray'));
  assert.equal(String(cs.lookup(3)), '<0080ff>');
  assert.equal(imgOf(b, 'b').dict.toString(), before);
});

await test('/Decode が既定と違う(反転)・色抜きの Mask・Matte つきの SMask は触らず skipped', async () => {
  const b = await build({
    content: '',
    extra: {
      a: await flat(imgDict(1, 1, N('DeviceRGB'), { Decode: [1, 0, 1, 0, 1, 0] }), [9, 9, 9]),
      b: await flat(imgDict(1, 1, N('DeviceRGB'), { Mask: [0, 0, 0, 0, 0, 0] }), [9, 9, 9]),
      sm: await flat(imgDict(1, 1, N('DeviceGray'), { Matte: [1, 1, 1] }), [255]),
      c: await flat(imgDict(1, 1, N('DeviceRGB'), { SMask: '@sm' }), [9, 9, 9]),
      d: await flat(imgDict(1, 1, N('DeviceRGB'), { Decode: [0, 1, 0, 1, 0, 1] }), [9, 9, 9]),
    },
  });
  const r = await neutralize(b.doc);
  assert.equal(r.images, 1, '既定どおりの Decode の d だけ直る');
  assert.equal(r.skipped.length, 3);
  for (const k of ['a', 'b', 'c']) assert.equal(imgOf(b, k).dict.lookup(N('ColorSpace')), N('DeviceRGB'));
});

await test('壊れた Flate の画像・対応しない圧縮は skipped(落ちない)', async () => {
  const b = await build({
    content: '',
    extra: {
      a: { dict: imgDict(1, 1, N('DeviceRGB')), bytes: Uint8Array.from([1, 2, 3, 4, 5]) },
      b: { dict: imgDict(1, 1, N('DeviceRGB'), { Filter: N('LZWDecode') }), bytes: Uint8Array.from([1, 2, 3]) },
      c: await flat(imgDict(4, 4, N('DeviceRGB')), [1, 1, 1]),
    },
  });
  const r = await neutralize(b.doc);
  assert.equal(r.images, 0);
  assert.equal(r.skipped.length, 3);
});

await test('JPEG(DCTDecode): decodeImage が無ければ skipped。有れば R・G・B の差が 2 以下なら灰の Flate に、色つきなら触らない', async () => {
  const mk = async () =>
    build({
      content: '',
      extra: {
        a: { dict: imgDict(2, 1, N('DeviceRGB'), { Filter: N('DCTDecode') }), bytes: Uint8Array.from([0xff, 0xd8, 1]) },
        b: { dict: imgDict(2, 1, N('DeviceRGB'), { Filter: N('DCTDecode') }), bytes: Uint8Array.from([0xff, 0xd8, 2]) },
        c: { dict: imgDict(2, 1, N('DeviceRGB'), { Filter: N('DCTDecode') }), bytes: Uint8Array.from([0xff, 0xd8, 3]) },
      },
    });
  const none = await mk();
  const r0 = await neutralize(none.doc);
  assert.equal(r0.images, 0);
  assert.equal(r0.skipped.length, 3);
  assert.match(r0.skipped[0], /JPEG/);

  const b = await mk();
  const deps: NeutralDeps = {
    decodeImage: async (bytes) => {
      const tag = bytes[2];
      if (tag === 1) return { width: 2, height: 1, rgba: Uint8Array.from([100, 101, 99, 255, 50, 50, 52, 255]) }; // 差は 2 以下
      if (tag === 2) return { width: 2, height: 1, rgba: Uint8Array.from([100, 0, 0, 255, 50, 50, 50, 255]) }; // 赤い
      return null; // ほどけない
    },
  };
  const before = imgOf(b, 'b').dict.toString();
  const r = await neutralize(b.doc, deps);
  assert.equal(r.images, 1);
  assert.equal(imgOf(b, 'a').dict.lookup(N('ColorSpace')), N('DeviceGray'));
  assert.equal(imgOf(b, 'a').dict.lookup(N('Filter')), N('FlateDecode'));
  assert.deepEqual(await pix(b, 'a'), [100, 50]);
  assert.equal(imgOf(b, 'b').dict.toString(), before);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /ほどけなかった/);
});

await test('2回通しても何も変わらない(冪等)', async () => {
  const b = await build({
    content: '0 0 0 rg /Pattern cs /pa scn /Im Do',
    resources: { ...patRes('pa'), XObject: { Im: '@im' } },
    extra: { pa: pattern(shade(fn2([0, 0, 0], [1, 1, 1]))), im: await flat(imgDict(1, 1, N('DeviceRGB')), [3, 3, 3]) },
  });
  const first = await neutralize(b.doc);
  assert.deepEqual([first.ops, first.shadings, first.images], [1, 1, 1]);
  const second = await neutralize(b.doc);
  assert.deepEqual([second.ops, second.shadings, second.images, second.skipped.length], [0, 0, 0, 0]);
});

// ───────────────────────── 4. 2026-10-01 の指摘(色の書き換えの正しさ) ─────────────────────────

console.log('指摘の直し(A1・A4・B5・B6・B7・16ビット)');

const formDict = { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 200, 200] };
const formOf = async (b: Built, k: string) => dec((await readStream(get(b, k) as PDFRawStream)) as Uint8Array);

await test('A1: 色空間を引き継ぐ Form(cs を言わずに sc で色を指定)を呼ぶページ・その Form は、書き換えずに skipped へ(3通り)', async () => {
  const form = { dict: formDict, bytes: enc('1 0 0 sc 20 20 100 100 re f') };
  const cases: Array<[string, string]> = [
    ['/DeviceRGB cs 0.5 0.5 0.5 sc /Fm1 Do', '/DeviceRGB cs 0.5 0.5 0.5 sc /Fm1 Do'],
    ['0.5 0.5 0.5 rg 0 0 10 10 re f /Fm1 Do', '0.5 0.5 0.5 rg 0 0 10 10 re f /Fm1 Do'],
    ['/DeviceRGB cs 0.5 0.5 0.5 scn /Fm1 Do', '/DeviceRGB cs 0.5 0.5 0.5 scn /Fm1 Do'],
  ];
  for (const [content, expected] of cases) {
    const b = await build({ content, resources: { XObject: { Fm1: '@form' } }, extra: { form } });
    const r = await neutralize(b.doc);
    assert.equal(await textOf(b.doc), expected, content);
    assert.equal(await formOf(b, 'form'), '1 0 0 sc 20 20 100 100 re f');
    assert.equal(r.ops, 0, content);
    assert.ok(r.skipped.some((s) => /ページ 1.*引き継ぐ/.test(s)), `${content}\n${r.skipped.join('\n')}`);
    assert.ok(r.skipped.some((s) => /フォーム.*引き継いだまま/.test(s)), r.skipped.join('\n'));
  }
});

await test('opsSkipped: 描く命令を書き換えられなかったもの(引き継ぐ Form・それを呼ぶページ・インライン画像・色空間の混在)だけが入り、画像と影の skipped は入らない', async () => {
  // 引き継ぐ Form とそれを呼ぶページ
  const form = { dict: formDict, bytes: enc('1 0 0 sc 20 20 100 100 re f') };
  const a = await build({ content: '/DeviceRGB cs 0.5 0.5 0.5 sc /Fm1 Do', resources: { XObject: { Fm1: '@form' } }, extra: { form } });
  const ra = await neutralize(a.doc);
  assert.equal(ra.opsSkipped.length, 2, ra.opsSkipped.join('\n'));
  assert.ok(ra.opsSkipped.every((s) => ra.skipped.includes(s)));
  assert.ok(ra.opsSkipped.some((s) => /^ページ 1/.test(s)) && ra.opsSkipped.some((s) => /^フォーム/.test(s)));
  // インライン画像
  const b = await build({ content: 'q 10 0 0 10 20 20 cm\nBI /W 1 /H 1 /CS /RGB /BPC 8 ID \u0001\u0002\u0003\nEI Q\n' });
  const rb = await neutralize(b.doc);
  assert.equal(rb.opsSkipped.length, 1, rb.opsSkipped.join('\n'));
  assert.match(rb.opsSkipped[0], /インライン画像/);
  // 画像の skipped(Decode が既定と違う RGB 画像)は、skipped には入るが opsSkipped には入らない
  const c = await build({
    content: '/Im1 Do',
    resources: { XObject: { Im1: '@im' } },
    extra: { im: { dict: { Type: N('XObject'), Subtype: N('Image'), Width: 1, Height: 1, ColorSpace: N('DeviceRGB'), BitsPerComponent: 8, Decode: [1, 0, 1, 0, 1, 0] }, bytes: Uint8Array.from([1, 2, 3]) } },
  });
  const rc = await neutralize(c.doc);
  assert.ok(rc.skipped.length > 0, '画像の skipped が出ない');
  assert.deepEqual(rc.opsSkipped, []);
  // 何も無ければ空
  const d = await build({ content: '0 0 0 rg' });
  assert.deepEqual((await neutralize(d.doc)).opsSkipped, []);
});

await test('A1: 入れ子の上もすべて(ページ → Form A → 引き継ぐ Form B)。引き継がない Form の中の rg は、これまでどおり直る', async () => {
  const b = await build({
    content: '0 0 0 rg /A Do',
    resources: { XObject: { A: '@a', C: '@c' } },
    extra: {
      a: { dict: { ...formDict, Resources: { XObject: { B: '@b' } } }, bytes: enc('0.2 0.2 0.2 rg /B Do') },
      b: { dict: formDict, bytes: enc('0 1 0 scn 0 0 5 5 re f') },
      c: { dict: formDict, bytes: enc('0.3 0.3 0.3 rg') },
    },
  });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '0 0 0 rg /A Do');
  assert.equal(await formOf(b, 'a'), '0.2 0.2 0.2 rg /B Do');
  assert.equal(await formOf(b, 'c'), '0.3 g'); // どこからも呼ばれていない・引き継がない Form は直る
  assert.equal(r.ops, 1);
  assert.equal(r.skipped.filter((s) => /引き継/.test(s)).length, 3); // ページ・A・B
});

await test('A1: 色つきの数だけで色を決めるのは、cs を自分で言っていれば引き継ぎではない(これまでどおり直る)', async () => {
  const b = await build({
    content: '/DeviceRGB cs 0.5 0.5 0.5 sc /Fm1 Do',
    resources: { XObject: { Fm1: '@form' } },
    extra: { form: { dict: formDict, bytes: enc('/DeviceRGB cs 1 0 0 sc 0 0 5 5 re f') } },
  });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/DeviceRGB cs 0.5 g /Fm1 Do');
  assert.equal(r.skipped.length, 0);
});

await test('A4: [/Pattern /DeviceRGB](色なしのタイルの下地が RGB)は、触らないが skipped に出す', async () => {
  const b = await build({
    content: '/Cs1 cs 0.5 0.5 0.5 /P1 scn 0 0 0 rg',
    resources: { ColorSpace: { Cs1: [N('Pattern'), N('DeviceRGB')] } },
  });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/Cs1 cs 0.5 0.5 0.5 /P1 scn 0 g');
  assert.ok(r.skipped.some((s) => /Cs1.*下地が RGB/.test(s)), r.skipped.join('\n'));
});

await test('B5: 自前の /Resources を持たない Form は、呼ぶ側の資源で色空間の名前を引く(/Cs1 → DeviceRGB なら、無彩色は g になる)', async () => {
  const b = await build({
    content: '/Fm1 Do',
    resources: { ColorSpace: { Cs1: N('DeviceRGB') }, XObject: { Fm1: '@form' } },
    extra: { form: { dict: formDict, bytes: enc('/Cs1 cs 0.4 0.4 0.4 sc 0 0 5 5 re f') } },
  });
  const r = await neutralize(b.doc);
  assert.equal(await formOf(b, 'form'), '/Cs1 cs 0.4 g 0 0 5 5 re f');
  assert.equal(r.ops, 1);
});

await test('B5: 入れ子(ページ → 資源を持つ Form A → 資源を持たない Form B)も、Form A の資源で引く', async () => {
  const b = await build({
    content: '/A Do',
    resources: { XObject: { A: '@a' } },
    extra: {
      a: { dict: { ...formDict, Resources: { ColorSpace: { Cs9: N('DeviceRGB') }, XObject: { B: '@b' } } }, bytes: enc('/B Do') },
      b: { dict: formDict, bytes: enc('/Cs9 cs 0.1 0.1 0.1 sc') },
    },
  });
  await neutralize(b.doc);
  assert.equal(await formOf(b, 'b'), '/Cs9 cs 0.1 g');
});

await test('B6: cs だけ言って sc が無いまま塗る(最初の色の黒が RGB のまま残る)→ cs ごと `0 g`。線は `0 G`', async () => {
  const b = await build({ content: '/DeviceRGB cs 10 10 5 5 re f /DeviceRGB CS 0 0 9 9 re S' });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '0 g 10 10 5 5 re f 0 G 0 0 9 9 re S');
  assert.equal(r.ops, 2);
});

await test('B6: 黒で塗ったあとに色つきの sc が続くグループは、色つきを rg にそろえる。sc のあとに塗るだけなら cs はそのまま', async () => {
  const a = await build({ content: '/DeviceRGB cs 0 0 5 5 re f 1 0 0 sc 0 0 5 5 re f' });
  await neutralize(a.doc);
  assert.equal(await textOf(a.doc), '0 g 0 0 5 5 re f 1 0 0 rg 0 0 5 5 re f');
  const b = await build({ content: '/DeviceRGB cs 1 0 0 sc 0 0 5 5 re f' });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/DeviceRGB cs 1 0 0 sc 0 0 5 5 re f');
  assert.equal(r.ops, 0);
});

await test('B6: q … Q で戻ると、cs のあとの色は決まっていない状態に戻る(Q のあとに塗れば黒)', async () => {
  const b = await build({ content: '/DeviceRGB cs q 1 0 0 sc 0 0 5 5 re f Q 0 0 5 5 re f' });
  await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '0 g q 1 0 0 rg 0 0 5 5 re f Q 0 0 5 5 re f');
});

await test('B6: ICCBased に色つきが混じるグループは、黒で塗っていても触らず skipped(色空間が切り替わると色つきの sc が相手を失う)', async () => {
  const icc = { dict: { N: 3, Alternate: N('DeviceRGB') }, bytes: new Uint8Array(0) };
  const b = await build({
    content: '/Icc cs 0 0 5 5 re f 1 0 0 sc 0 0 5 5 re f',
    resources: { ColorSpace: { Icc: [N('ICCBased'), '@icc'] } },
    extra: { icc },
  });
  const r = await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '/Icc cs 0 0 5 5 re f 1 0 0 sc 0 0 5 5 re f');
  assert.ok(r.skipped.some((s) => /Icc/.test(s)), r.skipped.join('\n'));
});

await test('B6: ICCBased で黒しか使わないグループは、cs ごと `0 g`', async () => {
  const icc = { dict: { N: 3, Alternate: N('DeviceRGB') }, bytes: new Uint8Array(0) };
  const b = await build({
    content: '/Icc cs 0 0 5 5 re f',
    resources: { ColorSpace: { Icc: [N('ICCBased'), '@icc'] } },
    extra: { icc },
  });
  await neutralize(b.doc);
  assert.equal(await textOf(b.doc), '0 g 0 0 5 5 re f');
});

await test('B7: 関数の /Range が成分ごとに違うときは触らない(skipped)。そろっていれば、これまでどおり1成分にする', async () => {
  const b = await build({
    content: '/Pattern cs /pa scn /pb scn',
    resources: patRes('pa', 'pb'),
    extra: {
      pa: pattern(shade(fn2([0.2, 0.2, 0.2], [0.8, 0.8, 0.8], { Range: [0, 1, 0, 0.5, 0, 1] }))),
      pb: pattern(shade(fn2([0.2, 0.2, 0.2], [0.8, 0.8, 0.8], { Range: [0, 0.5, 0, 0.5, 0, 0.5] }))),
    },
  });
  const r = await neutralize(b.doc);
  assert.equal(shOf(b, 'pa').lookup(N('ColorSpace')), N('DeviceRGB'));
  assert.equal(shOf(b, 'pb').lookup(N('ColorSpace')), N('DeviceGray'));
  assert.deepEqual(nums((shOf(b, 'pb').lookup(N('Function')) as PDFDict).lookup(N('Range'))), [0, 0.5]);
  assert.equal(r.shadings, 1);
  assert.ok(r.skipped.some((s) => /Range が成分ごとに違う/.test(s)), r.skipped.join('\n'));
});

await test('B7: Type 0(標本)・Type 3(つなぎ)も、Range が成分ごとに違えば触らない', async () => {
  const sampled = { dict: { FunctionType: 0, Domain: [0, 1], Range: [0, 1, 0, 0.5, 0, 1], Size: [2], BitsPerSample: 8 }, bytes: await deflate(Uint8Array.of(0, 0, 0, 255, 255, 255)) };
  const b = await build({
    content: '/Pattern cs /pa scn /pb scn',
    resources: patRes('pa', 'pb'),
    extra: {
      s0: { dict: { ...sampled.dict, Filter: N('FlateDecode') }, bytes: sampled.bytes },
      pa: pattern(shade('@s0')),
      pb: pattern(shade({ FunctionType: 3, Domain: [0, 1], Functions: [fn2([0, 0, 0], [1, 1, 1])], Bounds: [], Encode: [0, 1], Range: [0, 1, 0, 0.5, 0, 1] })),
    },
  });
  const r = await neutralize(b.doc);
  assert.equal(r.shadings, 0);
  assert.equal(r.skipped.filter((s) => /Range が成分ごとに違う/.test(s)).length, 2, r.skipped.join('\n'));
});

await test('16ビットの RGB 画像は、触らないが skipped に理由を出す(黙って通さない)', async () => {
  const b = await build({
    content: '/Im Do',
    resources: { XObject: { Im: '@im' } },
    extra: { im: await flat(imgDict(1, 1, N('DeviceRGB'), { BitsPerComponent: 16 }), [0, 5, 0, 5, 0, 5]) },
  });
  const before = imgOf(b, 'im').dict.toString();
  const r = await neutralize(b.doc);
  assert.equal(imgOf(b, 'im').dict.toString(), before);
  assert.equal(r.images, 0);
  assert.ok(r.skipped.some((s) => /16ビット/.test(s)), r.skipped.join('\n'));
});

// ───────────────────────── 実物 ─────────────────────────

const dirEnv = process.env.PRESS_FIXTURES;
const tmp = mkdtempSync(join(tmpdir(), 'neutral-test-'));

const rgLeft = async (doc: PDFDocument) => {
  const skipped: string[] = [];
  let neutralLeft = 0;
  let coloredLeft = 0;
  for (const h of await contentHolders(doc, skipped)) {
    for (const o of operations(h.bytes)) {
      if ((o.op === 'rg' || o.op === 'RG') && o.operands.length === 3) {
        const [r, g, b] = o.operands.map((t) => t.num as number);
        if (Math.max(r, g, b) - Math.min(r, g, b) < 0.0005) neutralLeft++;
        else coloredLeft++;
      }
    }
  }
  return { neutralLeft, coloredLeft, skipped };
};

const py = (code: string, ...args: string[]) =>
  spawnSync('python', ['-', ...args], { input: code, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 1 << 26 });

const neutralized = new Map<string, string>();
if (!dirEnv) console.log('\n  skip PRESS_FIXTURES が無いので、実物の検査は飛ばした');
else {
  console.log('\n実物');
  for (const name of ['color-a5.pdf', 'mono-bunko.pdf', 'sakura-shinsho.pdf']) {
    const path = join(dirEnv, name);
    if (!existsSync(path)) {
      console.log(`  skip ${name} が無い`);
      continue;
    }
    await test(`${name}: neutralize が通り、保存し直して開けてページ数が同じ。2回目は何も変えない`, async () => {
      const bytes = readFileSync(path);
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = doc.getPageCount();
      const t0 = performance.now();
      const r = await neutralize(doc);
      const ms = Math.round(performance.now() - t0);
      const left = await rgLeft(doc);
      console.log(`       命令 ${r.ops}・影 ${r.shadings}・画像 ${r.images}・skipped ${r.skipped.length}・${ms}ms`);
      for (const s of r.skipped) console.log(`         skipped: ${s}`);
      console.log(`       書き換えのあとに残った rg/RG: 無彩色 ${left.neutralLeft}・色つき ${left.coloredLeft}`);
      assert.equal(left.neutralLeft, 0, '無彩色の rg / RG が残らない');
      assert.deepEqual(left.skipped, [], '読めなかった描く命令が無い');
      const out = await doc.save({ useObjectStreams: false });
      const outPath = join(tmp, name.replace('.pdf', '.neutral.pdf'));
      writeFileSync(outPath, out);
      neutralized.set(name, outPath);
      assert.equal((await PDFDocument.load(out)).getPageCount(), pages);
      const again = await neutralize(doc);
      assert.deepEqual([again.ops, again.shadings, again.images], [0, 0, 0]);
      if (name === 'color-a5.pdf') {
        assert.equal(r.ops, 422, 'rg / RG 422 か所が全部グレーになる');
        assert.equal(left.coloredLeft, 0);
      }
    });
  }
}

// ───────────────────────── Ghostscript まで通す・見た目 ─────────────────────────

const A5_TEXT_PAGES = [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 29, 30, 31, 32];

const PY_INK = `
import sys, json
import numpy as np
import pymupdf
pymupdf.TOOLS.set_icc(False)   # ICC を効かせると K だけの黒が4色に描かれてしまう(PyMuPDF の癖)
d = pymupdf.open(sys.argv[1])
out = {}
for i in range(len(d)):
    pm = d[i].get_pixmap(dpi=72, colorspace=pymupdf.csCMYK)
    a = np.frombuffer(pm.samples_mv, dtype=np.uint8).reshape(-1, 4)
    out[i + 1] = [int(a[:, k].max()) for k in range(4)]
print(json.dumps(out))
`;

const PY_DIFF = `
import sys, json
import numpy as np
import pymupdf
a = pymupdf.open(sys.argv[1]); b = pymupdf.open(sys.argv[2])
res = {}
for p in [int(x) for x in sys.argv[3].split(',')]:
    pa = a[p - 1].get_pixmap(dpi=96, colorspace=pymupdf.csRGB); pb = b[p - 1].get_pixmap(dpi=96, colorspace=pymupdf.csRGB)
    x = np.frombuffer(pa.samples_mv, dtype=np.uint8).astype(int); y = np.frombuffer(pb.samples_mv, dtype=np.uint8).astype(int)
    d = np.abs(x - y)
    res[p] = [int(d.max()), round(float(d.mean()), 4)]
print(json.dumps(res))
`;

if (dirEnv && neutralized.has('color-a5.pdf')) {
  await test('見た目: color-a5.pdf を neutralize の前後で絵にして比べる(96dpi)', () => {
    const pages = '1,2,3,13,17,22,32';
    const r = py(PY_DIFF, join(dirEnv, 'color-a5.pdf'), neutralized.get('color-a5.pdf') as string, pages);
    if (r.status !== 0) {
      console.log(`       skip python / PyMuPDF が使えない: ${String(r.stderr).split('\n').slice(-3).join(' ')}`);
      return;
    }
    const res = JSON.parse(r.stdout) as Record<string, [number, number]>;
    console.log(`       ページごとの [最大の差, 平均の差]: ${JSON.stringify(res)}`);
    for (const [p, [max]] of Object.entries(res)) assert.ok(max <= 2, `ページ ${p} の絵が変わった(最大 ${max})`);
  });
  await test('見た目: mono-bunko.pdf も(96dpi)', () => {
    const p = neutralized.get('mono-bunko.pdf');
    if (!p) return;
    const r = py(PY_DIFF, join(dirEnv, 'mono-bunko.pdf'), p, '1,2,5,10,20,30,37');
    if (r.status !== 0) return console.log('       skip python / PyMuPDF が使えない');
    const res = JSON.parse(r.stdout) as Record<string, [number, number]>;
    console.log(`       ページごとの [最大の差, 平均の差]: ${JSON.stringify(res)}`);
    for (const [pg, [max]] of Object.entries(res)) assert.ok(max <= 2, `ページ ${pg} の絵が変わった(最大 ${max})`);
  });
}

if (!process.env.PRESS_GS) console.log('\n  skip PRESS_GS=1 が無いので、Ghostscript まで通す検査は飛ばした');
else if (!dirEnv || !neutralized.has('color-a5.pdf')) console.log('\n  skip Ghostscript の検査には PRESS_FIXTURES と color-a5.pdf が要る');
else {
  console.log('\nGhostscript(カラーの引数)まで通す');
  const icc = join(dirEnv, 'JapanColor2011Coated.icc');
  const factory = (await import('@okathira/ghostpdl-wasm')).default as unknown as (o: Record<string, unknown>) => Promise<{
    callMain(a: string[]): number;
    FS: { mkdir(p: string): void; writeFile(p: string, d: Uint8Array): void; readFile(p: string): Uint8Array };
  }>;
  /** SPEC.md 6 の「カラー」の引数。製品の Worker とは違い、ここでは -dNOSAFER で ICC を読ませる */
  const runGs = async (input: string, output: string) => {
    const log: string[] = [];
    const gs = await factory({ noInitialRun: true, print: (l: string) => log.push(l), printErr: (l: string) => log.push(l) });
    gs.FS.mkdir('/work');
    gs.FS.writeFile('/work/in.pdf', readFileSync(input));
    gs.FS.writeFile('/work/JapanColor2011Coated.icc', readFileSync(icc));
    const code = gs.callMain([
      '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6',
      '-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK', '-dOverrideICC=true',
      '-sOutputICCProfile=/work/JapanColor2011Coated.icc', '-dDeviceGrayToK=true',
      '-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false',
      '-dColorImageFilter=/FlateEncode', '-dGrayImageFilter=/FlateEncode',
      '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
      '-sOutputFile=/work/out.pdf', '/work/in.pdf',
    ]);
    assert.equal(code, 0, `Ghostscript が終了コード ${code}\n${log.slice(-5).join('\n')}`);
    writeFileSync(output, gs.FS.readFile('/work/out.pdf'));
  };
  const inkOf = (file: string): Record<string, number[]> | null => {
    const r = py(PY_INK, file);
    if (r.status !== 0) {
      console.log(`       skip python / PyMuPDF が使えない: ${String(r.stderr).split('\n').slice(-3).join(' ')}`);
      return null;
    }
    return JSON.parse(r.stdout);
  };
  const cmyPages = (ink: Record<string, number[]>, pages: number[]) => pages.filter((p) => Math.max(...ink[String(p)].slice(0, 3)) > 0);

  await test('color-a5.pdf: neutralize を通すと、文字だけの 15 ページが C=M=Y=0 になる(通さないと何ページが 4色になるか比べる)', async () => {
    const origGs = join(tmp, 'color-a5.orig.gs.pdf');
    const neutGs = join(tmp, 'color-a5.neutral.gs.pdf');
    await runGs(join(dirEnv as string, 'color-a5.pdf'), origGs);
    await runGs(neutralized.get('color-a5.pdf') as string, neutGs);
    const a = inkOf(origGs);
    const b = inkOf(neutGs);
    if (!a || !b) return;
    const badA = cmyPages(a, A5_TEXT_PAGES);
    const badB = cmyPages(b, A5_TEXT_PAGES);
    const allB = cmyPages(b, Array.from({ length: 32 }, (_, i) => i + 1));
    console.log(`       neutralize なし: 文字だけの 15 ページのうち C・M・Y が乗るのは ${badA.length} ページ ${JSON.stringify(badA)}`);
    console.log(`       neutralize あり: 同じく ${badB.length} ページ ${JSON.stringify(badB)}`);
    console.log(`       neutralize あり、32 ページ全体で C・M・Y が乗るページ(写真・色つきの絵のページ): ${JSON.stringify(allB)}`);
    console.log(`       neutralize あり、文字ページの K の最大(255 = ベタ): ${JSON.stringify(A5_TEXT_PAGES.map((p) => b[String(p)][3]))}`);
    assert.deepEqual(badB, [], '影の指定を含め、文字だけのページに C・M・Y が乗らない');
    assert.ok(badA.length > badB.length, 'neutralize を通さないと乗る(この検査が効いている)');
  });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} 件通った・${failed.length} 件落ちた`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
