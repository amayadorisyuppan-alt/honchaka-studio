// src/press/grayTone.ts の検査。`node scripts/press/grayTone.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 実物の PDF の検査は、置き場を環境変数 PRESS_FIXTURES で渡したときだけ回る(Ghostscript を通すので 1本 10〜30 秒。PyMuPDF・Pillow の入った python が要る)。
//   PRESS_FIXTURES=<color-a5.pdf などのあるフォルダ> node scripts/press/grayTone.test.ts
// Ghostscript の出力は <PRESS_FIXTURES>/../out/graytone/ に置き、入力と引数が同じなら次回から使い回す(PRESS_FRESH=1 で作り直す)。
// 1本ごとに別の node を起こして Ghostscript を回す(同じプロセスで3回目に落ちることが在る。e2e.test.ts と同じ理由)。
// python が呼べないときは、python が要る検査だけ飛ばして、飛ばしたと表示する。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import { contentHolders, deflate, operations, readStream } from '../../src/press/content.ts';
import { neutralize } from '../../src/press/neutral.ts';
import { applyGrayTone, GRAY_TONE, toneGray } from '../../src/press/grayTone.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

let passed = 0;
const failed: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.stack ?? e).split('\n').slice(0, 7).join('\n       ')}`);
  }
}

const N = (s: string) => PDFName.of(s);
const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const dec = (b: Uint8Array): string => Buffer.from(b).toString('latin1');
const T = GRAY_TONE;

// ───────────────────────── 手作りの PDF を組む道具 ─────────────────────────

type Plain = Record<string, unknown>;
type Extra = Plain | unknown[] | { dict: Plain; bytes: Uint8Array };

interface Built {
  doc: PDFDocument;
  refs: Record<string, PDFRef>;
}

/**
 * 1ページの PDF を組む。**保存して開き直す**ので、中身のストリームは Chrome・Ghostscript の PDF と同じ PDFRawStream になる。
 * extra は「名前 → 登録する物(辞書か、{dict, bytes} でストリーム)」。参照は refs に入る。
 * resources / content / extra の中の文字列 '@名前' は、その参照に置き換える
 */
async function build(opts: { content: string; resources?: Plain; extra?: Record<string, Extra> }): Promise<Built> {
  const src = await PDFDocument.create();
  const ctx = src.context;
  const page = src.addPage([200, 200]);
  const refs: Record<string, PDFRef> = {};
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
    if (!Array.isArray(v) && 'bytes' in v && v.bytes instanceof Uint8Array) ctx.assign(refs[k], PDFRawStream.of(ctx.obj(fix(v.dict) as Record<string, never>), v.bytes));
    else ctx.assign(refs[k], ctx.obj(fix(v) as never));
  }
  page.node.set(N('Resources'), ctx.obj(fix(opts.resources ?? {}) as never));
  page.node.set(N('Contents'), ctx.register(ctx.flateStream(enc(opts.content))));
  const doc = await PDFDocument.load(await src.save({ useObjectStreams: false }), { updateMetadata: false });
  return { doc, refs };
}

async function textOf(doc: PDFDocument, i = 0): Promise<string> {
  const c = doc.getPage(i).node.get(N('Contents'));
  const v = c instanceof PDFRef ? doc.context.lookup(c) : c;
  return dec((await readStream(v as PDFRawStream)) as Uint8Array);
}

const get = (b: Built, k: string) => b.doc.context.lookup(b.refs[k]);
const dictOf = (v: unknown): PDFDict => (v instanceof PDFDict ? v : (v as PDFRawStream).dict);
const nums = (v: unknown): number[] => (v as PDFArray).asArray().map((x) => (x as PDFNumber).asNumber());
const pixels = async (b: Built, k: string): Promise<Uint8Array> => (await readStream(get(b, k) as PDFRawStream)) as Uint8Array;

/** 0 〜 255 が横に並ぶ、幅 256 のグレーの画素 */
const ramp = (rows = 2): Uint8Array => Uint8Array.from({ length: 256 * rows }, (_, i) => i % 256);

function imageDict(extra: Plain = {}, w = 256, h = 2): Plain {
  return { Type: N('XObject'), Subtype: N('Image'), Width: w, Height: h, ColorSpace: N('DeviceGray'), BitsPerComponent: 8, ...extra };
}

/** 保存し直して開き直したあとの、ストリームの辞書の文字と中身(触っていないかを比べる) */
function snapshot(doc: PDFDocument, ref: PDFRef): string {
  const o = doc.context.lookup(ref);
  if (o instanceof PDFRawStream) return `${o.dict.toString()}|${Buffer.from(o.contents).toString('base64')}`;
  return String(o);
}

// ───────────────────────── 1. 表 ─────────────────────────

console.log('表');

await test('GRAY_TONE: 256 個・0→0・255→255・単調に増える・段の飛びが小さい', () => {
  assert.equal(T.length, 256);
  assert.equal(T[0], 0, '文字の黒を1段も変えない');
  assert.equal(T[255], 255, '紙の地に点を置かない');
  let maxStep = 0;
  for (let i = 1; i < 256; i++) {
    assert.ok(T[i] >= T[i - 1], `単調でない: ${i}`);
    maxStep = Math.max(maxStep, T[i] - T[i - 1]);
  }
  assert.ok(maxStep <= 3, `段の飛びが大きい: ${maxStep}`);
});

await test('GRAY_TONE: 真ん中が濃く(小さく)なっている。代表の値', () => {
  assert.ok(T[128] < 128 - 30, `T[128]=${T[128]}`);
  for (let i = 1; i < 255; i++) assert.ok(T[i] <= i, `${i} → ${T[i]}: 画面より薄く刷るほうには動かさない`);
  assert.deepEqual([0, 32, 64, 96, 128, 160, 192, 224, 255].map((i) => T[i]), [0, 9, 26, 51, 86, 123, 166, 211, 255]);
});

await test('toneGray: 0 と 1 は動かない。範囲の外・NaN は 0〜1 に収める。段のあいだは直線', () => {
  assert.equal(toneGray(0), 0);
  assert.equal(toneGray(1), 1);
  assert.equal(toneGray(-3), 0);
  assert.equal(toneGray(7), 1);
  assert.equal(toneGray(Number.NaN), 0);
  assert.ok(Math.abs(toneGray(0.5) - 85 / 255) < 1e-12, `0.5 → ${toneGray(0.5)}`);
  for (let i = 0; i < 256; i++) assert.ok(Math.abs(toneGray(i / 255) * 255 - T[i]) < 1e-9, `${i}`);
  let prev = -1;
  for (let k = 0; k <= 4096; k++) {
    const y = toneGray(k / 4096);
    assert.ok(y >= prev, `細かく見ても単調に増える: ${k}`);
    prev = y;
  }
});

const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
const py = (args: string[], input?: string) => spawnSync('python', args, { input, encoding: 'utf8', env: pyEnv, maxBuffer: 1 << 26, cwd: repo });
const pyCan = (() => {
  const r = py(['-c', 'import numpy, scipy, PIL, pymupdf']);
  return r.status === 0;
})();

if (!pyCan) console.log('  [飛ばした] python(numpy・scipy・Pillow・PyMuPDF)が呼べないので、道具の出力との照合と実物の検査は飛ばした');
else {
  await test('make-gray-tone.py: 道具の出力が grayTone.ts の定数と同じ。直したあとの L* が目標と ±1.5 以内(道具が終了コード 0)', () => {
    const j = py(['scripts/press/make-gray-tone.py', '--json']);
    assert.equal(j.status, 0, j.stderr);
    assert.deepEqual(JSON.parse(j.stdout), Array.from(T));
    const full = py(['scripts/press/make-gray-tone.py']);
    assert.equal(full.status, 0, full.stdout + full.stderr);
    console.log(
      full.stdout
        .split('\n')
        .filter((l: string) => /^(直す前|直した後|表の)/.test(l))
        .map((l: string) => `       ${l}`)
        .join('\n'),
    );
  });
}

// ───────────────────────── 2. 描く命令 ─────────────────────────

console.log('描く命令');

await test('g / G / sc / scn / SC: グレーだけが表で直り、CMYK・RGB・文字列の中・0 と 1 は1バイトも変わらない', async () => {
  const content =
    '0.5 g 0 0 10 10 re f 0.5 G 0 g 1 g 0.2 0.3 0.4 rg 0 0 0 1 k 0.25 0.25 0.25 RG (0.5 g) Tj ' +
    '/DeviceGray cs 0.5 sc 0.5 scn /DeviceGray CS 0.5 SC /DeviceRGB cs 0.5 0.5 0.5 sc';
  const b = await build({ content });
  const r = await applyGrayTone(b.doc);
  assert.equal(
    await textOf(b.doc),
    '0.33333 g 0 0 10 10 re f 0.33333 G 0 g 1 g 0.2 0.3 0.4 rg 0 0 0 1 k 0.25 0.25 0.25 RG (0.5 g) Tj ' +
      '/DeviceGray cs 0.33333 sc 0.33333 scn /DeviceGray CS 0.33333 SC /DeviceRGB cs 0.5 0.5 0.5 sc',
  );
  assert.deepEqual({ ops: r.ops, images: r.images, shadings: r.shadings, skipped: r.skipped }, { ops: 5, images: 0, shadings: 0, skipped: [] });
});

await test('色が0と1だけ・グレーの命令が無いページは、内容のバイトが変わらない(書き戻さない)', async () => {
  const b = await build({ content: '0 g 1 G 0 0 1 rg 0 0 0 1 k 10 10 5 5 re f' });
  const before = (await contentHolders(b.doc))[0].bytes;
  const r = await applyGrayTone(b.doc);
  assert.deepEqual(Buffer.from((await contentHolders(b.doc))[0].bytes), Buffer.from(before));
  assert.equal(r.ops, 0);
});

await test('資源の色空間: ICCBased(N=1)・CalGray は直る。CalRGB・ICCBased(N=3)・Pattern の名前だけの scn は触らない', async () => {
  const b = await build({
    content: '/Icc1 cs 0.5 sc /Cal cs 0.5 sc /Icc3 cs 0.5 0.5 0.5 sc /CalRGB cs 0.5 0.5 0.5 sc /Pattern cs /P1 scn',
    resources: {
      ColorSpace: {
        Icc1: [N('ICCBased'), '@icc1'],
        Icc3: [N('ICCBased'), '@icc3'],
        Cal: [N('CalGray'), { WhitePoint: [0.95, 1, 1.09], Gamma: 2.2 }],
        CalRGB: [N('CalRGB'), { WhitePoint: [0.95, 1, 1.09] }],
      },
    },
    extra: { icc1: { dict: { N: 1 }, bytes: new Uint8Array(0) }, icc3: { dict: { N: 3 }, bytes: new Uint8Array(0) } },
  });
  const r = await applyGrayTone(b.doc);
  assert.equal(
    await textOf(b.doc),
    '/Icc1 cs 0.33333 sc /Cal cs 0.33333 sc /Icc3 cs 0.5 0.5 0.5 sc /CalRGB cs 0.5 0.5 0.5 sc /Pattern cs /P1 scn',
  );
  assert.equal(r.ops, 2);
  assert.deepEqual(r.skipped, []);
});

await test('q … Q をまたぐと、色空間が戻る。塗りと線は別々に追う', async () => {
  const a = await build({ content: '/DeviceGray cs q /DeviceRGB cs Q 0.5 sc' });
  await applyGrayTone(a.doc);
  assert.equal(await textOf(a.doc), '/DeviceGray cs q /DeviceRGB cs Q 0.33333 sc');
  const b = await build({ content: '/DeviceRGB cs q /DeviceGray cs Q 0.5 0.5 0.5 sc 0.5 sc' });
  const r = await applyGrayTone(b.doc);
  assert.equal(await textOf(b.doc), '/DeviceRGB cs q /DeviceGray cs Q 0.5 0.5 0.5 sc 0.5 sc');
  assert.equal(r.ops, 0);
  const c = await build({ content: '/DeviceRGB cs /DeviceGray CS 0.5 sc 0.5 SC' });
  await applyGrayTone(c.doc);
  assert.equal(await textOf(c.doc), '/DeviceRGB cs /DeviceGray CS 0.5 sc 0.33333 SC');
});

await test('索引色・下地がグレーのパターンの色の指定は、触らず skipped に出す', async () => {
  const b = await build({
    content: '/Ix cs 1 sc /Pg cs 0.5 /P1 scn',
    resources: { ColorSpace: { Ix: [N('Indexed'), N('DeviceGray'), 1, PDFHexString.of('00ff')], Pg: [N('Pattern'), N('DeviceGray')] } },
  });
  const r = await applyGrayTone(b.doc);
  assert.equal(await textOf(b.doc), '/Ix cs 1 sc /Pg cs 0.5 /P1 scn');
  assert.equal(r.ops, 0);
  assert.equal(r.skipped.length, 2, r.skipped.join(' / '));
  assert.match(r.skipped.join(' '), /索引色/);
  assert.match(r.skipped.join(' '), /パターン/);
});

await test('フォーム: 中の g は直る。色空間を引き継ぐ sc は触らず skipped。cs を指定した sc は直る', async () => {
  const b = await build({
    content: '/Fm1 Do /Fm2 Do',
    resources: { XObject: { Fm1: '@f1', Fm2: '@f2' } },
    extra: {
      f1: { dict: { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 10, 10] }, bytes: enc('0.5 sc 0.5 g 0.5 sc') },
      f2: { dict: { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 10, 10] }, bytes: enc('/DeviceGray cs 0.5 sc') },
    },
  });
  const r = await applyGrayTone(b.doc);
  assert.equal(dec(await pixels(b, 'f1')), '0.5 sc 0.33333 g 0.33333 sc');
  assert.equal(dec(await pixels(b, 'f2')), '/DeviceGray cs 0.33333 sc');
  assert.equal(r.ops, 3);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /引き継/);
});

// ───────────────────────── 3. 画像 ─────────────────────────

console.log('画像');

const imgs = await (async () => {
  // PNG の Sub(1)で予測した、幅 256・2 行の画素。読み戻すと ramp になる
  const png = new Uint8Array(2 * 257);
  for (let y = 0; y < 2; y++) {
    png[y * 257] = 1;
    for (let x = 0; x < 256; x++) png[y * 257 + 1 + x] = x === 0 ? 0 : 1;
  }
  const flate = await deflate(png);
  const rgb = Uint8Array.from({ length: 256 * 2 * 3 }, (_, i) => Math.floor(i / 3) % 256);
  const cmyk = Uint8Array.from({ length: 256 * 2 * 4 }, (_, i) => Math.floor(i / 4) % 256);
  const idx = Uint8Array.from({ length: 512 }, (_, i) => i % 4);
  return build({
    content: '/G8 Do',
    resources: {
      XObject: {
        G8: '@g8', G8F: '@g8f', ICC: '@icc', IDX: '@idx', IDX2: '@idx2', BIT1: '@bit1', G16: '@g16', DCT: '@dct', MASK: '@imgmask', KEY: '@key',
        INV: '@inv', RGB: '@rgb', CMYK: '@cmyk', WITHSM: '@withsm', BW: '@bw', MATTE: '@matte', MATTESM: '@mattesm',
      },
    },
    extra: {
      g8: { dict: imageDict(), bytes: ramp() },
      g8f: {
        dict: imageDict({ Filter: N('FlateDecode'), DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: 256 } }),
        bytes: flate,
      },
      icc1: { dict: { N: 1 }, bytes: new Uint8Array(0) },
      icc: { dict: imageDict({ ColorSpace: [N('ICCBased'), '@icc1'] }), bytes: ramp() },
      ixcs: [N('Indexed'), N('DeviceGray'), 3, PDFHexString.of('0055aaff')],
      idx: { dict: imageDict({ ColorSpace: [N('Indexed'), N('DeviceGray'), 3, PDFHexString.of('0055aaff')] }), bytes: idx },
      idx2: { dict: imageDict({ ColorSpace: '@ixcs' }), bytes: idx },
      bit1: { dict: imageDict({ BitsPerComponent: 1, Width: 16, Height: 16 }), bytes: new Uint8Array(32).fill(0xaa) },
      g16: { dict: imageDict({ BitsPerComponent: 16 }), bytes: new Uint8Array(1024).fill(0x80) },
      dct: { dict: imageDict({ Filter: N('DCTDecode') }), bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
      imgmask: { dict: { Type: N('XObject'), Subtype: N('Image'), Width: 16, Height: 16, ImageMask: true, BitsPerComponent: 1 }, bytes: new Uint8Array(32).fill(0x55) },
      key: { dict: imageDict({ Mask: [100, 120] }), bytes: ramp() },
      inv: { dict: imageDict({ Decode: [1, 0] }), bytes: ramp() },
      rgb: { dict: imageDict({ ColorSpace: N('DeviceRGB') }), bytes: rgb },
      cmyk: { dict: imageDict({ ColorSpace: N('DeviceCMYK') }), bytes: cmyk },
      sm: { dict: imageDict(), bytes: ramp() },
      withsm: { dict: imageDict({ ColorSpace: N('DeviceCMYK'), SMask: '@sm' }), bytes: cmyk },
      bw: { dict: imageDict(), bytes: Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 0)) },
      mattesm: { dict: imageDict({ Matte: [0] }), bytes: ramp() },
      matte: { dict: imageDict({ SMask: '@mattesm' }), bytes: ramp() },
    },
  });
})();

const imgBefore = new Map<string, string>();
for (const k of Object.keys(imgs.refs)) imgBefore.set(k, snapshot(imgs.doc, imgs.refs[k]));
const imgReport = await applyGrayTone(imgs.doc);

await test('グレーの画像(圧縮なし・Flate の PNG 予測つき・ICCBased N=1)の画素が、表で置き換わる', async () => {
  for (const k of ['g8', 'g8f', 'icc']) {
    const px = await pixels(imgs, k);
    assert.equal(px.length, 512, k);
    for (let i = 0; i < 512; i++) assert.equal(px[i], T[i % 256], `${k}[${i}]`);
  }
  // 圧縮なしだった画像は Flate になり、PNG の予測(Predictor 15)を付けて詰め直す(付けないと、写真のようなグレーが 2.2 倍になる。4-1 の 3)。
  // 読み戻した画素は上で確かめた(予測を戻して表と同じ)
  const d = dictOf(get(imgs, 'g8f'));
  assert.equal(d.lookup(N('Filter')), N('FlateDecode'));
  const parms = d.lookup(N('DecodeParms')) as PDFDict;
  assert.deepEqual(
    ['Predictor', 'Colors', 'BitsPerComponent', 'Columns'].map((k) => (parms.lookup(N(k)) as PDFNumber).asNumber()),
    [15, 1, 8, 256],
  );
  assert.equal(d.lookup(N('BitsPerComponent')) instanceof PDFNumber ? (d.lookup(N('BitsPerComponent')) as PDFNumber).asNumber() : 0, 8);
});

await test('Indexed(元がグレー): 色の表だけ直り、添字の画素は同じ。表を共有する2枚も、2度は濃くならない', async () => {
  const want = Uint8Array.from([0, T[0x55], T[0xaa], 255]);
  for (const k of ['idx', 'idx2']) {
    const cs = dictOf(get(imgs, k)).lookup(N('ColorSpace')) as PDFArray;
    assert.equal((cs.lookup(0) as PDFName).decodeText(), 'Indexed');
    assert.equal(cs.lookup(1), N('DeviceGray'));
    assert.deepEqual(Array.from((cs.lookup(3) as PDFHexString).asBytes()), Array.from(want), k);
    assert.deepEqual(Array.from(await pixels(imgs, k)), Array.from({ length: 512 }, (_, i) => i % 4), `${k} の添字は変わらない`);
  }
});

await test('直さない画像: 1ビット・型抜き・色抜き・Decode 反転・RGB・CMYK・マスクに使われている画像・白黒だけの8ビットは1バイトも変わらない', () => {
  for (const k of ['bit1', 'imgmask', 'key', 'inv', 'rgb', 'cmyk', 'sm', 'withsm', 'bw', 'mattesm', 'matte', 'g16', 'dct']) {
    assert.equal(snapshot(imgs.doc, imgs.refs[k]), imgBefore.get(k), k);
  }
});

await test('直せなかった画像は skipped に出る(16ビット・JPEG・色抜き・Decode・Matte)。白黒だけの画像・1ビットは出さない', () => {
  const text = imgReport.skipped.join('\n');
  const has = (k: string) => text.includes(`画像 ${imgs.refs[k].toString()}（`);
  for (const k of ['g16', 'dct', 'key', 'inv', 'matte']) assert.ok(has(k), `${k} が skipped に無い\n${text}`);
  for (const k of ['bw', 'bit1', 'imgmask', 'rgb', 'cmyk', 'sm', 'withsm', 'g8', 'icc', 'idx']) assert.ok(!has(k), `${k} が skipped に出ている\n${text}`);
  assert.match(text, /JPEG/);
});

await test('画像の数は 5(g8・g8f・icc・idx・idx2)。命令・影は 0', () => {
  assert.deepEqual({ ops: imgReport.ops, images: imgReport.images, shadings: imgReport.shadings }, { ops: 0, images: 5, shadings: 0 });
});

// ───────────────────────── 4. 影 ─────────────────────────

console.log('影');

const shade = await (async () => {
  const fn2 = (c0: number[], c1: number[], n = 1): Plain => ({ FunctionType: 2, Domain: [0, 1], C0: c0, C1: c1, N: n });
  const sh = (fn: unknown, extra: Plain = {}): Plain => ({ ShadingType: 2, ColorSpace: N('DeviceGray'), Coords: [0, 0, 100, 0], Function: fn, ...extra });
  const stitch = (pieces: Plain[]): Plain => ({
    FunctionType: 3, Domain: [0, 1], Functions: pieces, Bounds: [0.5], Encode: [0, 1, 0, 1],
  });
  const b = await build({
    content: '/S1 sh',
    resources: {
      Shading: {
        ramp: sh('@fRamp'),
        constHalf: sh(fn2([0.5], [0.5])),
        constWhite: sh('@fWhite'),
        stitchConst: sh(stitch([fn2([0.2], [0.2]), fn2([0.8], [0.8])])),
        stitchRamp: sh(stitch([fn2([0], [0.5]), fn2([0.5], [1])])),
        sampled: sh('@fSampled'),
        calc: sh('@fCalc'),
        rgb: { ShadingType: 2, ColorSpace: N('DeviceRGB'), Coords: [0, 0, 100, 0], Function: '@fRgb' },
        cmyk: { ShadingType: 2, ColorSpace: N('DeviceCMYK'), Coords: [0, 0, 100, 0], Function: '@fCmyk' },
        bg: sh(fn2([0.5], [0.5]), { Background: [0.5] }),
        shareA: sh('@fShared'),
        shareB: sh('@fShared'),
      },
    },
    extra: {
      fRamp: fn2([0], [1]),
      fWhite: fn2([1], [1]),
      fSampled: { dict: { FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [4], BitsPerSample: 8 }, bytes: Uint8Array.from([0, 85, 170, 255]) },
      fCalc: { dict: { FunctionType: 4, Domain: [0, 1], Range: [0, 1] }, bytes: enc('{ 0.5 mul }') },
      fRgb: { FunctionType: 2, Domain: [0, 1], C0: [0.5, 0.5, 0.5], C1: [1, 1, 1], N: 1 },
      fCmyk: { FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0.5], C1: [0, 0, 0, 1], N: 1 },
      fShared: fn2([0], [1], 1),
      // マスクのグループ(Luminosity)の中にだけある影
      maskFn: fn2([0], [1]),
      maskForm: {
        dict: { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 100, 100], Resources: { Shading: { M1: sh('@maskFn') } } },
        bytes: enc('/M1 sh 0.5 g'),
      },
    },
  });
  // ExtGState の /SMask を足す(辞書を直に持つ)
  const res = b.doc.getPage(0).node.Resources() as PDFDict;
  const gs = b.doc.context.obj({ GS1: { Type: N('ExtGState'), SMask: { Type: N('Mask'), S: N('Luminosity'), G: b.refs.maskForm } } });
  res.set(N('ExtGState'), gs);
  return b;
})();

const shDict = (name: string): PDFDict => ((shade.doc.getPage(0).node.Resources() as PDFDict).lookup(N('Shading')) as PDFDict).lookup(N(name)) as PDFDict;
const fnRefOf = (name: string) => shDict(name).get(N('Function'));
const fBefore = {
  white: snapshot(shade.doc, shade.refs.fWhite),
  calc: snapshot(shade.doc, shade.refs.fCalc),
  rgb: snapshot(shade.doc, shade.refs.fRgb),
  cmyk: snapshot(shade.doc, shade.refs.fCmyk),
  mask: snapshot(shade.doc, shade.refs.maskFn),
  maskForm: snapshot(shade.doc, shade.refs.maskForm),
};
const oldRamp = shade.refs.fRamp;
const oldShared = shade.refs.fShared;
const shadeReport = await applyGrayTone(shade.doc);

/** 作り直された標本の関数(Type 0)を読む */
async function samplesOf(fn: unknown): Promise<Uint8Array> {
  const f = shade.doc.context.lookup(fn as PDFRef) as PDFRawStream;
  assert.ok(f instanceof PDFRawStream, '標本のストリーム');
  const d = f.dict;
  assert.equal((d.lookup(N('FunctionType')) as PDFNumber).asNumber(), 0);
  assert.deepEqual(nums(d.lookup(N('Size'))), [256]);
  assert.deepEqual(nums(d.lookup(N('Domain'))), [0, 1]);
  assert.deepEqual(nums(d.lookup(N('Range'))), [0, 1]);
  assert.equal((d.lookup(N('BitsPerSample')) as PDFNumber).asNumber(), 8);
  return (await readStream(f)) as Uint8Array;
}

await test('Type 2 の変化する関数: 256 点の標本(Type 0)に作り直す。標本は表と同じ(途中の明るさが合う)', async () => {
  const s = await samplesOf(fnRefOf('ramp'));
  assert.equal(s.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(s[i], T[i], `標本 ${i}`);
});

await test('Type 3(つなぎ)の変化する関数も、標本にする。つなぎ目をまたいで表と同じ(±1)', async () => {
  const s = await samplesOf(fnRefOf('stitchRamp'));
  for (let i = 0; i < 256; i++) assert.ok(Math.abs(s[i] - T[i]) <= 1, `標本 ${i}: ${s[i]} と ${T[i]}`);
});

await test('べた塗り(Type 2 で C0 = C1)は値だけ直す。つなぎでべた塗りだけでできたものも、形を保って値だけ直す', () => {
  const c = shDict('constHalf').lookup(N('Function')) as PDFDict;
  assert.deepEqual(nums(c.lookup(N('C0'))).map((x) => Math.round(x * 1e5) / 1e5), [0.33333]);
  assert.deepEqual(nums(c.lookup(N('C1'))).map((x) => Math.round(x * 1e5) / 1e5), [0.33333]);
  const s = shDict('stitchConst').lookup(N('Function')) as PDFDict;
  assert.equal((s.lookup(N('FunctionType')) as PDFNumber).asNumber(), 3);
  const subs = s.lookup(N('Functions')) as PDFArray;
  const c0 = (i: number) => nums((subs.lookup(i) as PDFDict).lookup(N('C0')))[0];
  assert.ok(Math.abs(c0(0) - toneGray(0.2)) < 1e-9 && Math.abs(c0(1) - toneGray(0.8)) < 1e-9, `${c0(0)} ${c0(1)}`);
});

await test('白べた・黒べたの影(紙の地)は、関数のバイトも、数にも入らない(動かない)', () => {
  assert.equal(fnRefOf('constWhite') instanceof PDFRef, true);
  assert.equal(snapshot(shade.doc, shade.refs.fWhite), fBefore.white);
  assert.equal(String(fnRefOf('constWhite')), String(shade.refs.fWhite));
});

await test('Type 0 の標本(8ビット・出力1つ)は、標本の値を表で直す', async () => {
  const f = shade.doc.context.lookup(fnRefOf('sampled') as PDFRef) as PDFRawStream;
  assert.deepEqual(Array.from((await readStream(f)) as Uint8Array), [0, T[85], T[170], 255]);
});

await test('背景が成分1つのときは、それも直す', () => {
  assert.deepEqual(nums(shDict('bg').lookup(N('Background'))).map((x) => Math.round(x * 1e5) / 1e5), [0.33333]);
});

await test('Type 4(計算式)・RGB・CMYK の影は触らない。計算式は skipped に出る', () => {
  assert.equal(snapshot(shade.doc, shade.refs.fCalc), fBefore.calc);
  assert.equal(snapshot(shade.doc, shade.refs.fRgb), fBefore.rgb);
  assert.equal(snapshot(shade.doc, shade.refs.fCmyk), fBefore.cmyk);
  assert.equal(String(fnRefOf('calc')), String(shade.refs.fCalc));
  assert.equal(String(fnRefOf('rgb')), String(shade.refs.fRgb));
  assert.equal(shadeReport.skipped.filter((s) => /計算式/.test(s)).length, 1, shadeReport.skipped.join('\n'));
  assert.equal(shadeReport.skipped.length, 1, shadeReport.skipped.join('\n'));
});

await test('同じ関数を使う2つの影は、作り直した関数を共有する。使われなくなった古い関数は文書から消える', () => {
  assert.equal(String(fnRefOf('shareA')), String(fnRefOf('shareB')));
  assert.notEqual(String(fnRefOf('shareA')), String(oldShared));
  assert.equal(shade.doc.context.lookup(oldShared), undefined);
  assert.equal(shade.doc.context.lookup(oldRamp), undefined);
});

await test('マスクのグループの中にだけある影と Form は、1バイトも変わらない。直した影の数は 8', () => {
  assert.equal(snapshot(shade.doc, shade.refs.maskFn), fBefore.mask);
  assert.equal(snapshot(shade.doc, shade.refs.maskForm), fBefore.maskForm);
  // 影: ramp・constHalf・stitchConst・stitchRamp・sampled・bg・shareA・shareB(constWhite は動かないので数えない)
  assert.equal(shadeReport.shadings, 8);
  assert.equal(shadeReport.ops, 0);
});

// ───────────────────────── 5. 透明のマスク ─────────────────────────

console.log('透明のマスク');

const msk = await (async () => {
  const form = (bytes: string, res: Plain = {}): Extra => ({ dict: { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 100, 100], Group: { S: N('Transparency') }, Resources: res }, bytes: enc(bytes) });
  return build({
    // ページ側: 0.5 g(直る)・通常のフォーム(直る)・マスクのグループを Do する(両方から使われる)
    content: '0.5 g /GS1 gs /FmPlain Do /FmBoth Do /ImBoth Do /ImBothZero Do',
    resources: {
      ExtGState: {
        GS1: { Type: N('ExtGState'), SMask: { Type: N('Mask'), S: N('Luminosity'), G: '@maskOnly' } },
        GS2: { Type: N('ExtGState'), SMask: { Type: N('Mask'), S: N('Alpha'), G: '@fmBoth' } },
      },
      // Ghostscript の癖: マスクのグループと、その中の画像を、ページの資源にも並べる(ページの命令は Do しない)
      XObject: { FmPlain: '@plain', FmBoth: '@fmBoth', MaskOnlyListed: '@maskOnly', ImMaskOnly: '@imMaskOnly', ImBoth: '@imBoth', ImBothZero: '@imBothZero', ImPic: '@imPic' },
    },
    extra: {
      plain: form('0.5 g 0.25 G', { XObject: { ImPic: '@imPic' } }),
      imPic: { dict: imageDict(), bytes: ramp() },
      maskOnly: form('0.5 g /ImMaskOnly Do /ImBoth Do /ImBothZero Do', { XObject: { ImMaskOnly: '@imMaskOnly', ImBoth: '@imBoth', ImBothZero: '@imBothZero' } }),
      imMaskOnly: { dict: imageDict(), bytes: ramp() },
      imBoth: { dict: imageDict(), bytes: ramp() },
      imBothZero: { dict: imageDict(), bytes: new Uint8Array(512) },
      fmBoth: form('0.5 g'),
    },
  });
})();
const mBefore: Record<string, string> = {};
for (const k of ['maskOnly', 'imMaskOnly', 'imBoth', 'imBothZero', 'fmBoth']) mBefore[k] = snapshot(msk.doc, msk.refs[k]);
const mReport = await applyGrayTone(msk.doc);

await test('マスクのグループとその中だけの画像は触らない。ページの命令・普通のフォームの絵は直る', async () => {
  assert.equal(snapshot(msk.doc, msk.refs.maskOnly), mBefore.maskOnly, 'マスクのグループの Form(中の 0.5 g)');
  assert.equal(snapshot(msk.doc, msk.refs.imMaskOnly), mBefore.imMaskOnly, 'マスクの中だけの画像');
  assert.equal(await textOf(msk.doc), '0.33333 g /GS1 gs /FmPlain Do /FmBoth Do /ImBoth Do /ImBothZero Do');
  assert.equal(dec(await pixels(msk, 'plain')), '0.33333 g 0.10098 G');
  const px = await pixels(msk, 'imPic');
  for (let i = 0; i < 256; i++) assert.equal(px[i], T[i]);
});

await test('マスクとページの両方から呼ばれているものは、触らず skipped に出す。値が動かない画像(全部 0)は知らせない', () => {
  assert.equal(snapshot(msk.doc, msk.refs.imBoth), mBefore.imBoth);
  assert.equal(snapshot(msk.doc, msk.refs.fmBoth), mBefore.fmBoth);
  assert.equal(snapshot(msk.doc, msk.refs.imBothZero), mBefore.imBothZero);
  const text = mReport.skipped.join('\n');
  assert.ok(text.includes(`画像 ${msk.refs.imBoth.toString()}（`), text);
  assert.ok(text.includes(`フォーム ${msk.refs.fmBoth.toString()}（`), text);
  assert.ok(!text.includes(`画像 ${msk.refs.imBothZero.toString()}`), text);
  assert.ok(!text.includes(`画像 ${msk.refs.imMaskOnly.toString()}`), text);
  assert.ok(!text.includes(`フォーム ${msk.refs.maskOnly.toString()}`), '資源に並んでいるだけのマスクは知らせない');
});

await test('マスクにも見える絵にも使う画像(/SMask に使われ、ページも Do で描く)は、直さず skipped に出す。値が動かない画像・マスクにだけ使う画像は知らせない', async () => {
  const b = await build({
    content: '/Pic Do /Pic2 Do /Pic3 Do /Vis Do /VisZero Do',
    resources: { XObject: { Pic: '@pic', Pic2: '@pic2', Pic3: '@pic3', Vis: '@vis', VisZero: '@visZero' } },
    extra: {
      pic: { dict: imageDict({ SMask: '@vis' }), bytes: ramp() },
      pic2: { dict: imageDict({ SMask: '@visZero' }), bytes: ramp() },
      pic3: { dict: imageDict({ SMask: '@maskOnly' }), bytes: ramp() },
      vis: { dict: imageDict(), bytes: ramp() },
      visZero: { dict: imageDict(), bytes: new Uint8Array(512) },
      maskOnly: { dict: imageDict(), bytes: ramp() },
    },
  });
  const before = new Map<string, string>();
  for (const k of ['vis', 'visZero', 'maskOnly']) before.set(k, snapshot(b.doc, b.refs[k]));
  const r = await applyGrayTone(b.doc);
  for (const k of ['vis', 'visZero', 'maskOnly']) assert.equal(snapshot(b.doc, b.refs[k]), before.get(k), `${k} は触らない`);
  const text = r.skipped.join('\n');
  assert.ok(text.includes(`画像 ${b.refs.vis.toString()}（`), `見える絵にも使うマスクの画像が skipped に出ない\n${text}`);
  assert.match(text, /マスクにも見える画像にも使われている/);
  assert.ok(!text.includes(`画像 ${b.refs.visZero.toString()}`), '値が動かない画像は知らせない');
  assert.ok(!text.includes(`画像 ${b.refs.maskOnly.toString()}`), 'マスクにだけ使う画像は知らせない');
  // 普通の絵(pic)は直る
  const px = await pixels(b, 'pic');
  for (let i = 0; i < 256; i++) assert.equal(px[i], T[i]);
});

// ───────────────────────── 5.5 壊れた入力 ─────────────────────────

await test('壊れた辞書(項目を消す・変な値に替える)を 400 通り通しても、例外にならず、固まらない', async () => {
  const fn2 = (c0: number[], c1: number[]): Plain => ({ FunctionType: 2, Domain: [0, 1], C0: c0, C1: c1, N: 1 });
  const sh = (fn: unknown): Plain => ({ ShadingType: 2, ColorSpace: N('DeviceGray'), Coords: [0, 0, 100, 0], Function: fn, Background: [0.5] });
  const base = await build({
    content: '0.5 g /Cs1 cs 0.4 sc /Fm1 Do /Im1 Do /Ix Do /Sh1 sh /GS1 gs /Pattern cs /P1 scn',
    resources: {
      ColorSpace: { Cs1: [N('ICCBased'), '@icc'] },
      XObject: { Fm1: '@form', Im1: '@img', Ix: '@idx' },
      Shading: { Sh1: sh({ FunctionType: 3, Domain: [0, 1], Functions: [fn2([0], [1]), fn2([1], [0])], Bounds: [0.5], Encode: [0, 1, 0, 1] }), Sh2: sh('@fs') },
      Pattern: { P1: { PatternType: 2, Shading: sh('@fs2') } },
      ExtGState: { GS1: { SMask: { S: N('Luminosity'), G: '@mform' } } },
    },
    extra: {
      icc: { dict: { N: 1 }, bytes: new Uint8Array(0) },
      form: { dict: { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 10, 10], Resources: {} }, bytes: enc('0.5 g 0.2 sc') },
      mform: { dict: { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 10, 10], Resources: { XObject: { Im2: '@img2' } } }, bytes: enc('/Im2 Do') },
      img: { dict: imageDict({ SMask: '@img2' }), bytes: ramp() },
      img2: { dict: imageDict(), bytes: ramp() },
      idx: { dict: imageDict({ ColorSpace: [N('Indexed'), N('DeviceGray'), 1, PDFHexString.of('00ff')] }), bytes: ramp() },
      fs: { dict: { FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [4], BitsPerSample: 8 }, bytes: Uint8Array.from([0, 85, 170, 255]) },
      fs2: fn2([0.2], [0.8]),
    },
  });
  const bytes = await base.doc.save({ useObjectStreams: false });
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const weird = (doc: PDFDocument): unknown[] => {
    const c = doc.context;
    return [c.obj(null), c.obj(0), c.obj(-1), c.obj(1e9), N('Foo'), c.obj([]), c.obj([1, 2, 3]), c.obj({}), c.obj([N('DeviceGray')]), c.obj(2)];
  };
  const baseline = await applyGrayTone(await PDFDocument.load(bytes, { updateMetadata: false }));
  assert.ok(baseline.ops > 0 && baseline.images > 0 && baseline.shadings > 0, `土台で何も直らない: ${JSON.stringify(baseline)}`);
  let threw = 0;
  const t0 = performance.now();
  for (let it = 0; it < 400; it++) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const dicts: PDFDict[] = [];
    const seen = new Set<unknown>();
    const stack: unknown[] = [];
    for (const [, o] of doc.context.enumerateIndirectObjects()) stack.push(o instanceof PDFStream ? o.dict : o);
    while (stack.length) {
      const v = stack.pop();
      if (seen.has(v)) continue;
      seen.add(v);
      if (v instanceof PDFDict) {
        const type = v.lookup(N('Type'));
        const isTree = type === N('Pages') || type === N('Page') || type === N('Catalog');
        if (!isTree && [...v.keys()].length > 0) dicts.push(v);
        for (const [, x] of v.entries()) stack.push(x instanceof PDFRef ? doc.context.lookup(x) : x);
      } else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) stack.push(v.get(i) instanceof PDFRef ? doc.context.lookup(v.get(i) as PDFRef) : v.get(i));
    }
    const d = dicts[rnd(dicts.length)];
    const keys = [...d.keys()];
    const k = keys[rnd(keys.length)];
    if (rnd(3) === 0) d.delete(k);
    else d.set(k, weird(doc)[rnd(10)] as never);
    try {
      await applyGrayTone(doc);
    } catch (e) {
      threw++;
      if (threw <= 3) console.log(`       例外: ${(e as Error).message}(${k.decodeText()} を替えた)`);
    }
  }
  console.log(`       400 通り・${Math.round(performance.now() - t0)}ms・例外 ${threw}`);
  assert.equal(threw, 0);
});

// ───────────────────────── 6. 速さ ─────────────────────────

console.log('速さ');

await test('大きなグレーの画像(4000×4000 = 16MB)が数秒以内で直り、直したあとの画素が合う', async () => {
  const w = 4000;
  const h = 4000;
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) px[off + x] = (x * 255 / (w - 1)) | 0;
  }
  const b = await build({ content: '/I Do', resources: { XObject: { I: '@big' } }, extra: { big: { dict: imageDict({}, w, h), bytes: px } } });
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const r = await applyGrayTone(b.doc);
  const ms = Math.round(performance.now() - t0);
  const rss1 = process.memoryUsage().rss;
  const out = await pixels(b, 'big');
  console.log(`       ${ms}ms・RSS +${Math.round((rss1 - rss0) / 1048576)}MB`);
  assert.equal(r.images, 1);
  assert.ok(ms < 5000, `${ms}ms`);
  for (const x of [0, 1, 1000, 2000, 3999]) assert.equal(out[x], T[(x * 255 / (w - 1)) | 0]);
});

// ───────────────────────── 7. 実物 ─────────────────────────

const dirEnv = process.env.PRESS_FIXTURES;
if (!dirEnv) console.log('\n  [飛ばした] PRESS_FIXTURES が無いので、実物の検査は飛ばした');
else if (!pyCan) console.log('\n  [飛ばした] python が呼べないので、実物の検査は飛ばした');
else {
  console.log('\n実物');
  const fixtures = resolve(dirEnv);
  const outDir = resolve(fixtures, '../out/graytone');
  mkdirSync(outDir, { recursive: true });
  const ICC = join(repo, 'src/press/JapanColor2011Coated.icc');

  /** Ghostscript を別のプロセスで回す。SPEC.md 6 の引数(ここでは -dNOSAFER で ICC を読ませる)。入力と引数が同じなら前の出力を使い回す */
  const GS_CODE = `
import { readFileSync, writeFileSync } from 'node:fs';
const [kind, input, output, icc] = process.argv.slice(1);
const factory = (await import('@okathira/ghostpdl-wasm')).default;
const log = [];
const gs = await factory({ noInitialRun: true, print: (l) => log.push(l), printErr: (l) => log.push(l) });
gs.FS.mkdir('/work');
gs.FS.writeFile('/work/in.pdf', readFileSync(input));
const images = ['-dAutoFilterColorImages=false','-dAutoFilterGrayImages=false','-dColorImageFilter=/FlateEncode','-dGrayImageFilter=/FlateEncode','-dDownsampleColorImages=false','-dDownsampleGrayImages=false','-dDownsampleMonoImages=false'];
let args;
if (kind === 'cmyk') {
  gs.FS.writeFile('/work/JapanColor2011Coated.icc', readFileSync(icc));
  args = ['-dNOSAFER','-dBATCH','-dNOPAUSE','-sDEVICE=pdfwrite','-dCompatibilityLevel=1.6','-sColorConversionStrategy=CMYK','-sProcessColorModel=DeviceCMYK','-dOverrideICC=true','-sOutputICCProfile=/work/JapanColor2011Coated.icc','-dDeviceGrayToK=true',...images,'-sOutputFile=/work/out.pdf','/work/in.pdf'];
} else {
  args = ['-dNOSAFER','-dBATCH','-dNOPAUSE','-sDEVICE=pdfwrite','-dCompatibilityLevel=1.6','-sColorConversionStrategy=Gray','-sProcessColorModel=DeviceGray','-dOverrideICC=true',...images,'-sOutputFile=/work/out.pdf','/work/in.pdf'];
}
const code = gs.callMain(args);
if (code !== 0) { console.error(log.slice(-8).join('\\n')); process.exit(1); }
writeFileSync(output, gs.FS.readFile('/work/out.pdf'));
`;
  const runGs = (kind: 'gray' | 'cmyk', input: string, name: string): string => {
    const key = createHash('sha1').update(kind).update(readFileSync(input)).update(GS_CODE).digest('hex').slice(0, 10);
    const out = join(outDir, `${name}.gs-${key}.pdf`);
    if (existsSync(out) && !process.env.PRESS_FRESH) {
      console.log(`       ${name}: 前回の Ghostscript の出力を使う(${key})`);
      return out;
    }
    const t0 = performance.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', GS_CODE, kind, input, out, ICC], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, `Ghostscript が落ちた: ${r.stderr}`);
    console.log(`       ${name}: Ghostscript ${Math.round((performance.now() - t0) / 1000)} 秒`);
    return out;
  };

  /** 元の絵(sRGB)・直す前・直したあとを同じ大きさで絵にして、刷り上がりの明るさ L* を元の目標と比べる(72dpi)。K 量 → L* は make-gray-tone.py の測った曲線 */
  const PY_METRIC = `
import sys, json, importlib.util
import numpy as np
import pymupdf
from scipy import ndimage
pymupdf.TOOLS.set_icc(False)   # ICC を効かせると K だけの黒が4色に描かれてしまう(PyMuPDF の癖)
spec = importlib.util.spec_from_file_location('mg', sys.argv[1])
mg = importlib.util.module_from_spec(spec); spec.loader.exec_module(mg)
lk = mg.smooth_curve(mg.measure_k_curve(mg.DEFAULT_ICC))
yk = float(mg.lstar_to_y(lk[255]))
def render(page, cs=pymupdf.csRGB):
    pm = page.get_pixmap(matrix=pymupdf.Matrix(1, 1), colorspace=cs, alpha=False)
    return np.frombuffer(pm.samples_mv, dtype=np.uint8).reshape(pm.height, pm.width, pm.n).astype(int)
orig, before, after = [pymupdf.open(x) for x in sys.argv[2:5]]
res = {}
for p in range(1, len(orig) + 1):
    A = render(orig[p-1]); B = render(before[p-1]); C = render(after[p-1])
    if not (A.shape == B.shape == C.shape):
        res[str(p)] = {'shape': False}; continue
    neut = lambda X: (X[..., 0] == X[..., 1]) & (X[..., 1] == X[..., 2])
    nA, nB, nC = neut(A), neut(B), neut(C)
    g = A[..., 0]
    lt = mg.y_to_lstar(yk + (1 - yk) * mg.srgb_to_y(g))
    lp = lambda X: np.interp(255 - X[..., 0], np.arange(256), lk)
    gi = g.astype(np.int16)
    smooth = (ndimage.maximum_filter(gi, size=3) - ndimage.minimum_filter(gi, size=3)) <= 24   # 文字の縁(アンチエイリアス)を外す
    mid = nA & nB & nC & (g > 20) & (g < 235) & smooth
    r = {'mid': int(mid.sum()), 'minB': int(B[..., 0][nB].min()) if nB.any() else -1, 'minC': int(C[..., 0][nC].min()) if nC.any() else -1,
         'same': bool(np.array_equal(B, C))}
    if mid.sum() > 0:
        dB = (lp(B) - lt)[mid]; dC = (lp(C) - lt)[mid]
        r['before'] = [float(dB.mean()), float(np.abs(dB).mean())]
        r['after'] = [float(dC.mean()), float(np.abs(dC).mean())]
    res[str(p)] = r
print(json.dumps(res))
`;
  const PY_CMY = `
import sys, json
import numpy as np
import pymupdf
pymupdf.TOOLS.set_icc(False)
a = pymupdf.open(sys.argv[1]); b = pymupdf.open(sys.argv[2])
res = {}
for i in range(len(a)):
    pa = a[i].get_pixmap(dpi=72, colorspace=pymupdf.csCMYK); pb = b[i].get_pixmap(dpi=72, colorspace=pymupdf.csCMYK)
    x = np.frombuffer(pa.samples_mv, dtype=np.uint8).reshape(-1, 4); y = np.frombuffer(pb.samples_mv, dtype=np.uint8).reshape(-1, 4)
    res[str(i + 1)] = {'cmyEqual': bool(np.array_equal(x[:, :3], y[:, :3])), 'kMaxB': int(x[:, 3].max()), 'kMaxC': int(y[:, 3].max())}
print(json.dumps(res))
`;
  type Metric = Record<string, { mid: number; minB: number; minC: number; same: boolean; before?: [number, number]; after?: [number, number]; shape?: boolean }>;
  const metric = (orig: string, before: string, after: string): Metric => {
    const r = py(['-', join(here, 'make-gray-tone.py'), orig, before, after], PY_METRIC);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  /** 描く命令を、呼び名ごとに前後で比べる。直してよいのは「0 より大きく 1 より小さい」グレーの値の命令だけ */
  const GRAY_OPS = new Set(['g', 'G', 'sc', 'scn', 'SC', 'SCN']);
  async function opChanges(before: PDFDocument, after: PDFDocument): Promise<{ changed: number; bad: string[]; holders: number }> {
    const a = new Map((await contentHolders(before)).map((h) => [h.label, h]));
    const b = new Map((await contentHolders(after)).map((h) => [h.label, h]));
    const bad: string[] = [];
    let changed = 0;
    for (const [label, ha] of a) {
      const hb = b.get(label);
      if (!hb) {
        bad.push(`${label} が無くなった`);
        continue;
      }
      const oa = operations(ha.bytes);
      const ob = operations(hb.bytes);
      if (oa.length !== ob.length) {
        bad.push(`${label}: 命令の数が変わった ${oa.length} → ${ob.length}`);
        continue;
      }
      for (let i = 0; i < oa.length; i++) {
        const x = oa[i];
        const y = ob[i];
        const tx = dec(ha.bytes.subarray(x.start, x.end));
        const ty = dec(hb.bytes.subarray(y.start, y.end));
        if (tx === ty) continue;
        changed++;
        const v = x.operands.length === 1 && x.operands[0].type === 'number' ? (x.operands[0].num as number) : NaN;
        if (x.op !== y.op || !GRAY_OPS.has(x.op) || !(v > 0 && v < 1)) bad.push(`${label}: 「${tx}」→「${ty}」`);
      }
    }
    return { changed, bad, holders: a.size };
  }

  /** 文書の中の、マスクのグループ(ExtGState の /SMask の /G)から届くものの、前後の中身 */
  function maskGroups(doc: PDFDocument): { groups: number; objects: Map<string, string> } {
    const ctx = doc.context;
    const starts: unknown[] = [];
    let groups = 0;
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
      const sm = d?.lookup(N('SMask'));
      if (sm instanceof PDFDict && sm.get(N('G'))) {
        groups++;
        starts.push(sm.get(N('G')));
      }
    }
    const objects = new Map<string, string>();
    const seen = new Set<unknown>();
    // 画像の /SMask・/Mask に使われている画像も、同じく触らない
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream) || o.dict.lookup(N('Subtype')) !== N('Image')) continue;
      for (const key of ['SMask', 'Mask']) {
        const m = o.dict.get(N(key));
        if (m instanceof PDFRef && ctx.lookup(m) instanceof PDFRawStream) objects.set(m.toString(), snapshot(doc, m));
      }
    }
    const stack = [...starts];
    while (stack.length) {
      const v = stack.pop();
      if (v instanceof PDFRef) {
        const o = ctx.lookup(v);
        if (!o || seen.has(o)) continue;
        seen.add(o);
        objects.set(v.toString(), snapshot(doc, v));
        stack.push(o instanceof PDFStream ? o.dict : o);
      } else if (v instanceof PDFDict) for (const [, x] of v.entries()) stack.push(x);
      else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
    }
    return { groups, objects };
  }

  const load = (path: string) => PDFDocument.load(readFileSync(path), { updateMetadata: false });
  const saveTo = async (doc: PDFDocument, name: string) => {
    const p = join(outDir, name);
    writeFileSync(p, await doc.save({ useObjectStreams: false }));
    return p;
  };

  // ── mono-bunko(白黒の本。Ghostscript の Gray のあと) ──
  const monoSrc = join(fixtures, 'mono-bunko.pdf');
  if (!existsSync(monoSrc)) console.log('  [飛ばした] mono-bunko.pdf が無い');
  else {
    const gs = runGs('gray', monoSrc, 'mono-bunko');
    const before = await load(gs);
    const after = await load(gs);
    const t0 = performance.now();
    const r = await applyGrayTone(after);
    const ms = Math.round(performance.now() - t0);
    const afterPath = await saveTo(after, 'mono-bunko.tone.pdf');
    console.log(`       mono-bunko: 命令 ${r.ops}・画像 ${r.images}・影 ${r.shadings}・skipped ${r.skipped.length}・${ms}ms`);
    for (const s of r.skipped) console.log(`         skipped: ${s}`);

    await test('mono-bunko: 画像の多い本が数秒以内で直り、保存し直して開けて、2回目の保存でページ数が同じ', async () => {
      assert.ok(ms < 5000, `${ms}ms`);
      assert.ok(r.images > 0 && r.ops > 0);
      assert.equal((await load(afterPath)).getPageCount(), 37);
    });

    await test('mono-bunko: 直したあとの描く命令は、直す前と同じ並びで、変わったのは 0 < v < 1 のグレーの命令だけ(文字の黒 0 g は1つも変わらない)', async () => {
      const c = await opChanges(before, after);
      console.log(`       変わった命令 ${c.changed}(読んだ Form・ページ ${c.holders})`);
      assert.deepEqual(c.bad, []);
      assert.equal(c.changed, r.ops);
    });

    await test('mono-bunko: 透明のマスクのグループ(ExtGState の /SMask)から届くものが、1バイトも変わらない', async () => {
      const a = maskGroups(before);
      const b = maskGroups(after);
      console.log(`       マスクのグループ ${a.groups} 個・そこから届くオブジェクト ${a.objects.size} 個`);
      assert.ok(a.groups >= 1);
      for (const [k, v] of a.objects) assert.equal(b.objects.get(k), v, `${k} が変わった`);
    });

    await test('mono-bunko: 絵のページで、直したあとのほうが、元の Chrome の PDF の明るさに近い。文字の黒の濃さは変わらない', () => {
      const m = metric(monoSrc, gs, afterPath);
      const pics = Object.entries(m).filter(([, v]) => v.mid >= 3000 && v.before && v.after);
      let sb = 0;
      let sa = 0;
      let n = 0;
      const worse: string[] = [];
      for (const [p, v] of pics) {
        const [b, a] = [(v.before as [number, number])[1], (v.after as [number, number])[1]];
        sb += b * v.mid;
        sa += a * v.mid;
        n += v.mid;
        if (!(a < b)) worse.push(`p${p}: ${b.toFixed(2)} → ${a.toFixed(2)}`);
      }
      const rows = pics.map(([p, v]) => `p${p} ${(v.before as number[]).map((x) => x.toFixed(1)).join('/')}→${(v.after as number[]).map((x) => x.toFixed(1)).join('/')}`);
      console.log(`       絵の領域(滑らかで中間の濃さの画素)の L* の差(刷り − 画面の目標)の [平均/絶対平均]。直す前→直したあと:\n       ${rows.join('  ')}`);
      console.log(`       全体(画素数で重み): 絶対平均 ${(sb / n).toFixed(2)} → ${(sa / n).toFixed(2)}(${pics.length} ページ・${n} 画素)`);
      assert.ok(pics.length >= 5, `絵のページが少ない: ${pics.length}`);
      assert.deepEqual(worse, [], '直したあとのほうが元から遠くなったページ');
      assert.ok(sa / n < sb / n / 2, '絶対平均が半分未満になる');
      // 文字だけのページ(絵の領域が無い)は、いちばん暗い画素が前後で同じ
      const textPages = Object.entries(m).filter(([, v]) => v.mid < 300);
      assert.ok(textPages.length >= 5);
      for (const [p, v] of textPages) assert.equal(v.minC, v.minB, `p${p} の最も暗い画素が変わった`);
    });
  }

  // ── color-a5(カラーの本。neutralize → Ghostscript の CMYK のあと) ──
  const colorSrc = join(fixtures, 'color-a5.pdf');
  if (!existsSync(colorSrc)) console.log('  [飛ばした] color-a5.pdf が無い');
  else {
    const neutDoc = await load(colorSrc);
    await neutralize(neutDoc);
    const neutPath = await saveTo(neutDoc, 'color-a5.neutral.pdf');
    const gs = runGs('cmyk', neutPath, 'color-a5');
    const before = await load(gs);
    const after = await load(gs);
    const t0 = performance.now();
    const r = await applyGrayTone(after);
    const ms = Math.round(performance.now() - t0);
    const afterPath = await saveTo(after, 'color-a5.tone.pdf');
    console.log(`       color-a5: 命令 ${r.ops}・画像 ${r.images}・影 ${r.shadings}・skipped ${r.skipped.length}・${ms}ms`);
    for (const s of r.skipped) console.log(`         skipped: ${s}`);

    await test('color-a5: 数秒以内で直り、変わったのは 0 < v < 1 のグレーの命令だけ(CMYK の命令・RGB の命令は1つも変わらない)', async () => {
      assert.ok(ms < 5000, `${ms}ms`);
      const c = await opChanges(before, after);
      console.log(`       変わった命令 ${c.changed}`);
      assert.deepEqual(c.bad, []);
      assert.equal(c.changed, r.ops);
    });

    await test('color-a5: CMYK の画像・DeviceRGB の画像・色つきの影は、1バイトも変わらない', async () => {
      let n = 0;
      for (const [ref, o] of before.context.enumerateIndirectObjects()) {
        if (!(o instanceof PDFRawStream) || o.dict.lookup(N('Subtype')) !== N('Image')) continue;
        const cs = o.dict.lookup(N('ColorSpace'));
        if (cs !== N('DeviceCMYK') && cs !== N('DeviceRGB')) continue;
        n++;
        assert.equal(snapshot(after, ref), snapshot(before, ref), `画像 ${ref.toString()}`);
      }
      console.log(`       色つきの画像 ${n} 枚が同じ`);
      assert.ok(n > 0);
    });

    await test('color-a5: C・M・Y の量が前後で1画素も変わらない。文字だけの 15 ページの K の最大は同じ', () => {
      const run = py(['-', gs, afterPath], PY_CMY);
      assert.equal(run.status, 0, run.stderr);
      const res = JSON.parse(run.stdout) as Record<string, { cmyEqual: boolean; kMaxB: number; kMaxC: number }>;
      const bad = Object.entries(res).filter(([, v]) => !v.cmyEqual).map(([p]) => p);
      assert.equal(Object.keys(res).length, 32);
      assert.deepEqual(bad, [], 'C・M・Y が変わったページ');
      for (const p of [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 29, 30, 31, 32]) assert.equal(res[String(p)].kMaxC, res[String(p)].kMaxB, `p${p} の K の最大`);
    });

    await test('color-a5: 透明のマスクのグループから届くものが、1バイトも変わらない', () => {
      const a = maskGroups(before);
      const b = maskGroups(after);
      console.log(`       マスクのグループ ${a.groups} 個・そこから届くオブジェクト ${a.objects.size} 個`);
      for (const [k, v] of a.objects) assert.equal(b.objects.get(k), v, `${k} が変わった`);
    });

    await test('color-a5: 直せないグレーの JPEG は skipped に出る(この本に1枚)', () => {
      assert.equal(r.skipped.filter((s) => /JPEG/.test(s)).length, 1, r.skipped.join('\n'));
    });
  }

  // ── 自作の絵: カラーの流れ(neutralize → Ghostscript の CMYK)で、グレーの絵と塗りの明るさが画面に近づく ──
  await test('カラーの流れの全体: 灰の RGB の絵・塗り・線(neutralize → Ghostscript CMYK)が、直したあとのほうが元の明るさに近い', async () => {
    const src = await PDFDocument.create();
    const ctx = src.context;
    const page = src.addPage([200, 200]);
    const w = 256;
    const h = 64;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) rgb.fill(i % w, i * 3, i * 3 + 3);
    const im = ctx.register(PDFRawStream.of(ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }), rgb));
    page.node.set(N('Resources'), ctx.obj({ XObject: { Im1: im } }));
    const content = 'q 0.5 0.5 0.5 rg 10 100 80 60 re f Q q 180 0 0 40 10 10 cm /Im1 Do Q q 0.3 0.3 0.3 RG 10 w 10 170 m 190 170 l S Q';
    page.node.set(N('Contents'), ctx.register(ctx.flateStream(enc(content))));
    const origPath = join(outDir, 'syn.pdf');
    writeFileSync(origPath, await src.save({ useObjectStreams: false }));
    const nd = await load(origPath);
    await neutralize(nd);
    const gs = runGs('cmyk', await saveTo(nd, 'syn.neutral.pdf'), 'syn');
    const after = await load(gs);
    const r = await applyGrayTone(after);
    assert.deepEqual({ ops: r.ops, images: r.images, skipped: r.skipped }, { ops: 2, images: 1, skipped: [] });
    const m = metric(origPath, gs, await saveTo(after, 'syn.tone.pdf'))['1'];
    console.log(`       絵の領域の L* の差(刷り − 目標)[平均/絶対平均]: 直す前 ${(m.before as number[]).map((x) => x.toFixed(1)).join('/')} → 直したあと ${(m.after as number[]).map((x) => x.toFixed(1)).join('/')}(${m.mid} 画素)`);
    assert.ok((m.before as number[])[1] > 5, '直す前は大きく薄い');
    assert.ok((m.after as number[])[1] < 1.5, `直したあとは目標に合う: ${(m.after as number[])[1]}`);
  });
}

console.log(`\n${passed} 件通った・${failed.length} 件落ちた`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
