// src/press/inspect.ts の検査。`node scripts/press/inspect.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 手作りの PDF で、点検が「RGB が残っている」「カラーのページ」を正しく言うかを見る。
// 実物の検査は、置き場を環境変数 PRESS_FIXTURES で渡したときだけ回る(color-a5.pdf を neutralize → limitInk → 点検まで通す)。
//   PRESS_FIXTURES=<color-a5.pdf などのあるフォルダ> node scripts/press/inspect.test.ts
// 渡さなければ飛ばして、飛ばしたと表示する。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import type { PDFRef } from 'pdf-lib';
import { deflate } from '../../src/press/content.ts';
import { inspectPress } from '../../src/press/inspect.ts';
import { limitInk } from '../../src/press/inkLimit.ts';
import { neutralize } from '../../src/press/neutral.ts';

const N = (s: string) => PDFName.of(s);
const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// ───────────────────────── 100MB の描く命令(別プロセス) ─────────────────────────
// INSPECT_CHILD=big: Node のヒープを 256MB に絞った子で、30MB の描く命令(命令 約116万)を点検する。
// 前の inspect は全命令を配列にしたので、40MB(155万命令)で 1.05GB・100MB で落ちた(2026-10-01 実測)。流し読みなら、絞ったヒープでも通る
if (process.env.INSPECT_CHILD === 'big') {
  const unit = enc('0 0 0 1 k 10 20 30 40 re f\n');
  const body = new Uint8Array(30 * 1024 * 1024);
  for (let i = 0; i + unit.length <= body.length; i += unit.length) body.set(unit, i);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([100, 100]);
  page.node.set(N('Contents'), pdf.context.register(pdf.context.stream(await deflate(body), { Filter: 'FlateDecode' })));
  const doc = await PDFDocument.load(await pdf.save({ useObjectStreams: false }), { updateMetadata: false });
  const r = await inspectPress(doc, 'body-cmyk');
  console.log(`BIG ${JSON.stringify(r)}`);
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

// ───────────────────────── 手作りの PDF を組む道具 ─────────────────────────

type Plain = Record<string, unknown>;

/**
 * 1ページの PDF を組んで、保存して開き直す(中身は Chrome の PDF と同じ PDFRawStream になる)。
 * extra は「名前 → 登録する物(辞書・配列、または {dict, bytes} でストリーム)」。resources / content の中の '@名前' はその参照に置き換わる
 */
async function build(opts: { content: string; resources?: Plain; extra?: Record<string, unknown> }) {
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
    const e = v as { dict?: Plain; bytes?: Uint8Array };
    if (e && e.bytes instanceof Uint8Array && e.dict) ctx.assign(refs[k], PDFRawStream.of(ctx.obj(fix(e.dict) as Plain), e.bytes));
    else ctx.assign(refs[k], ctx.obj(fix(v) as Plain));
  }
  page.node.set(N('Resources'), ctx.obj(fix(opts.resources ?? {}) as Plain));
  page.node.set(N('Contents'), ctx.register(ctx.flateStream(enc(opts.content))));
  return { doc: await PDFDocument.load(await src.save({ useObjectStreams: false }), { updateMetadata: false }), refs };
}

const formDict = { Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, 200, 200] };
const imgDict = (w: number, h: number, extra: Plain): Plain => ({ Type: N('XObject'), Subtype: N('Image'), Width: w, Height: h, BitsPerComponent: 8, Filter: N('FlateDecode'), ...extra });
const flat = async (dict: Plain, raw: number[]) => ({ dict, bytes: await deflate(Uint8Array.from(raw)) });
const sepFn = { FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 };
const separation = [N('Separation'), N('Spot1'), N('DeviceCMYK'), sepFn];

// ───────────────────────── 土台(これまで動いていたことが、動いたまま) ─────────────────────────

console.log('土台');

await test('K だけのページは「カラーのページ」に数えない。C が乗るページは数える', async () => {
  const a = await build({ content: '0 0 0 1 k 0 0 10 10 re f' });
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).colorPages, []);
  const b = await build({ content: '0.2 0 0 0 k 0 0 10 10 re f' });
  assert.deepEqual((await inspectPress(b.doc, 'body-cmyk')).colorPages, [1]);
});

await test('RGB の命令が残っていれば rgb に出る。DeviceGray の画像は出ない・カラー数えにもならない', async () => {
  const a = await build({ content: '0 0 0 rg /Im Do', resources: { XObject: { Im: '@im' } }, extra: { im: await flat(imgDict(1, 1, { ColorSpace: N('DeviceGray') }), [9]) } });
  const r = await inspectPress(a.doc, 'body-cmyk');
  assert.ok(r.rgb.some((x) => /描く命令 ページ 1/.test(x)), r.rgb.join('/'));
  assert.ok(!r.rgb.some((x) => /画像/.test(x)));
});

// ───────────────────────── A2: 型抜き ─────────────────────────

console.log('A2: 型抜き(ImageMask)');

const maskImg = async () => flat({ Type: N('XObject'), Subtype: N('Image'), Width: 8, Height: 1, ImageMask: true, BitsPerComponent: 1, Filter: N('FlateDecode') }, [0xaa]);

await test('A2: 黒だけで型抜きを使うページは、カラーのページではない(inkLimit を通しても通さなくても)', async () => {
  const mk = async () => build({ content: '0 g q 100 0 0 100 10 10 cm /Im1 Do Q', resources: { XObject: { Im1: '@im' } }, extra: { im: await maskImg() } });
  const a = await mk();
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).colorPages, []);
  const b = await mk();
  const ink = await limitInk(b.doc, 300);
  assert.deepEqual((await inspectPress(b.doc, 'body-cmyk', ink.facts)).colorPages, []);
});

await test('A2: 型抜きでも、塗る色が C・M・Y を持てば、そのページはカラー(色は描く命令の側が決める)', async () => {
  const a = await build({ content: '0.3 0 0 0 k q 100 0 0 100 10 10 cm /Im1 Do Q', resources: { XObject: { Im1: '@im' } }, extra: { im: await maskImg() } });
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).colorPages, [1]);
});

await test('A2 の対照: 色空間の無い(型抜きでない)画像・RGB の画像は、測れない・色つきなので、カラー', async () => {
  const a = await build({ content: '0 g /Im1 Do', resources: { XObject: { Im1: '@im' } }, extra: { im: await flat(imgDict(1, 1, {}), [1]) } });
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).colorPages, [1]);
  const b = await build({ content: '0 g /Im1 Do', resources: { XObject: { Im1: '@im' } }, extra: { im: await flat(imgDict(1, 1, { ColorSpace: N('DeviceRGB') }), [1, 2, 3]) } });
  assert.deepEqual((await inspectPress(b.doc, 'body-cmyk')).colorPages, [1]);
});

// ───────────────────────── A3: 特色 ─────────────────────────

console.log('A3: 特色(Separation・DeviceN)');

await test('A3: Separation の色を使うページは、カラーのページに数える', async () => {
  const a = await build({ content: '/Cs1 cs 1 scn 0 0 10 10 re f', resources: { ColorSpace: { Cs1: separation } } });
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).colorPages, [1]);
  const b = await build({ content: '/Cs1 CS 1 SCN 0 0 10 10 re S', resources: { ColorSpace: { Cs1: separation } } });
  assert.deepEqual((await inspectPress(b.doc, 'body-cmyk')).colorPages, [1]);
});

await test('A3: DeviceN も、間接オブジェクトに置かれた特色も、カラーのページ', async () => {
  const deviceN = [N('DeviceN'), [N('A'), N('B')], N('DeviceCMYK'), { FunctionType: 4, Domain: [0, 1, 0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1] }];
  const a = await build({ content: '/Cs1 cs 1 1 scn', resources: { ColorSpace: { Cs1: deviceN } } });
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).colorPages, [1]);
  const b = await build({ content: '/Cs1 cs 1 scn', resources: { ColorSpace: { Cs1: '@sep' } }, extra: { sep: separation } });
  assert.deepEqual((await inspectPress(b.doc, 'body-cmyk')).colorPages, [1]);
});

await test('A3: パターンの下地が特色(`[/Pattern [/Separation …]]`)でも、カラーのページ', async () => {
  const a = await build({ content: '/Cs1 cs 1 /P1 scn 0 0 10 10 re f', resources: { ColorSpace: { Cs1: [N('Pattern'), separation] } } });
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).colorPages, [1]);
});

await test('A3 の対照: DeviceGray の色空間・下地が DeviceGray のパターンは、カラーではない', async () => {
  const a = await build({ content: '/Cs1 cs 0.5 scn /Cs2 cs 0.5 /P1 scn', resources: { ColorSpace: { Cs1: N('DeviceGray'), Cs2: [N('Pattern'), N('DeviceGray')] } } });
  const r = await inspectPress(a.doc, 'body-cmyk');
  assert.deepEqual(r.colorPages, []);
  assert.deepEqual(r.rgb, []);
});

// ───────────────────────── A4: パターンの下地の RGB ─────────────────────────

console.log('A4: [/Pattern /DeviceRGB]');

await test('A4: 色なしのタイルのパターンの下地が RGB(`[/Pattern /DeviceRGB]`)のとき、rgb に出る(ページの資源に直に書いてあっても、間接オブジェクトでも、辞書の参照でも)', async () => {
  const direct = await build({ content: '/Cs1 cs 0.5 0.5 0.5 /P1 scn', resources: { ColorSpace: { Cs1: [N('Pattern'), N('DeviceRGB')] } } });
  const r1 = await inspectPress(direct.doc, 'body-cmyk');
  assert.ok(r1.rgb.length > 0, '直に書かれた下地が見つからない');
  const indirect = await build({ content: '/Cs1 cs 0.5 0.5 0.5 /P1 scn', resources: { ColorSpace: { Cs1: '@cs' } }, extra: { cs: [N('Pattern'), N('DeviceRGB')] } });
  const r2 = await inspectPress(indirect.doc, 'body-cmyk');
  assert.ok(r2.rgb.some((x) => /色空間/.test(x)), r2.rgb.join('/'));
  assert.ok(r2.rgb.some((x) => /描く命令 ページ 1/.test(x)), r2.rgb.join('/'));
  // ColorSpace の辞書そのものが間接オブジェクト(/ColorSpace 14 0 R)で、その値が配列への参照
  const dictRef = await build({ content: '/Cs1 cs 0.5 0.5 0.5 /P1 scn', resources: { ColorSpace: '@csd' }, extra: { csd: { Cs1: '@cs' }, cs: [N('Pattern'), N('DeviceRGB')] } });
  const r3 = await inspectPress(dictRef.doc, 'body-cmyk');
  assert.ok(r3.rgb.length > 0 && r3.rgb.some((x) => /描く命令/.test(x)), r3.rgb.join('/'));
});

await test('A4: 描く命令では使っていなくても、ColorSpace の辞書(間接オブジェクト)が指す `[/Pattern /DeviceRGB]` の配列は、色空間の RGB として出る', async () => {
  const a = await build({ content: '0 g', resources: { ColorSpace: '@csd' }, extra: { csd: { Cs1: '@cs' }, cs: [N('Pattern'), N('DeviceRGB')] } });
  const r = await inspectPress(a.doc, 'body-cmyk');
  assert.ok(r.rgb.some((x) => /色空間/.test(x)), r.rgb.join('/'));
  // 対照: 同じ作りで下地が CMYK なら、何も出ない
  const b = await build({ content: '0 g', resources: { ColorSpace: '@csd' }, extra: { csd: { Cs1: '@cs' }, cs: [N('Pattern'), N('DeviceCMYK')] } });
  assert.deepEqual((await inspectPress(b.doc, 'body-cmyk')).rgb, []);
});

await test('A4 の対照: 下地の無い /Pattern・下地が CMYK のパターンは、RGB に出ない', async () => {
  const a = await build({ content: '/Pattern cs /P1 scn /Cs2 cs 0.1 0.1 0.1 0.1 /P1 scn', resources: { ColorSpace: { Cs2: [N('Pattern'), N('DeviceCMYK')] } } });
  const r = await inspectPress(a.doc, 'body-cmyk');
  assert.deepEqual(r.rgb, []);
});

await test('A4: neutral は直せないので skipped に出し、点検は rgb に出す(どちらも見落とさない)', async () => {
  const a = await build({ content: '/Cs1 cs 0.5 0.5 0.5 /P1 scn', resources: { ColorSpace: { Cs1: '@cs' } }, extra: { cs: [N('Pattern'), N('DeviceRGB')] } });
  const n = await neutralize(a.doc);
  assert.ok(n.skipped.some((s) => /下地が RGB/.test(s)), n.skipped.join('/'));
  assert.ok((await inspectPress(a.doc, 'body-cmyk')).rgb.length > 0);
});

// ───────────────────────── B5: 資源を持たない Form ─────────────────────────

console.log('B5: 自前の資源を持たない Form');

await test('B5: ページ → 資源なしの Form → CMYK の画像(C=100%)。画像はページの資源から引く。カラーのページになる', async () => {
  const a = await build({
    content: '/A Do',
    resources: { XObject: { A: '@a', I: '@i' } },
    extra: { a: { dict: formDict, bytes: enc('/I Do') }, i: await flat(imgDict(1, 1, { ColorSpace: N('DeviceCMYK') }), [255, 0, 0, 0]) },
  });
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).colorPages, [1]);
  // 対照: 画像が K だけなら、カラーではない
  const b = await build({
    content: '/A Do',
    resources: { XObject: { A: '@a', I: '@i' } },
    extra: { a: { dict: formDict, bytes: enc('/I Do') }, i: await flat(imgDict(1, 1, { ColorSpace: N('DeviceCMYK') }), [0, 0, 0, 255]) },
  });
  assert.deepEqual((await inspectPress(b.doc, 'body-cmyk')).colorPages, []);
});

await test('B5: 資源なしの Form の中の `/Cs1 cs`(ページの ColorSpace が DeviceRGB)は、RGB として見つかる', async () => {
  const a = await build({
    content: '/A Do',
    resources: { ColorSpace: { Cs1: N('DeviceRGB') }, XObject: { A: '@a' } },
    extra: { a: { dict: formDict, bytes: enc('/Cs1 cs') } },
  });
  const r = await inspectPress(a.doc, 'body-cmyk');
  assert.ok(r.rgb.some((x) => /フォーム/.test(x)), r.rgb.join('/'));
});

// ───────────────────────── B6: cs だけで塗る(黒の RGB が残る) ─────────────────────────

console.log('B6: cs だけ言って塗る');

await test('B6: cs だけ言って塗るページは、neutral の前は点検が RGB の残りとして拾い、neutral が `0 g` にしたあとは何も残らない', async () => {
  const a = await build({ content: '/DeviceRGB cs 0 0 5 5 re f' });
  assert.ok((await inspectPress(a.doc, 'body-cmyk')).rgb.some((x) => /描く命令/.test(x)));
  await neutralize(a.doc);
  assert.deepEqual((await inspectPress(a.doc, 'body-cmyk')).rgb, []);
});

// ───────────────────────── B1: 巨大な描く命令 ─────────────────────────

console.log('B1: 巨大な描く命令');

await test('B1: Node のヒープを 256MB に絞った別プロセスでも、30MB(約116万命令)の描く命令を点検できる', () => {
  const r = spawnSync(process.execPath, ['--max-old-space-size=256', fileURLToPath(import.meta.url)], { env: { ...process.env, INSPECT_CHILD: 'big' }, encoding: 'utf8' });
  assert.equal(r.status, 0, `${String(r.stderr).split('\n').slice(0, 4).join('\n')}\n${r.stdout}`);
  const m = r.stdout.match(/BIG (\{.*\})/);
  assert.ok(m, r.stdout);
  const out = JSON.parse(m[1]);
  assert.deepEqual(out.colorPages, []);
  assert.deepEqual(out.rgb, []);
});

// ───────────────────────── 実物 ─────────────────────────

console.log('実物');

const dirEnv = process.env.PRESS_FIXTURES;
if (!dirEnv) console.log('  [飛ばした] PRESS_FIXTURES が無いので、実物の検査は飛ばした');
else if (!existsSync(join(dirEnv, 'color-a5.pdf'))) console.log('  [飛ばした] color-a5.pdf が無い');
else {
  await test('color-a5.pdf: neutralize → limitInk → 点検 で、描く命令の RGB の残り 0・カラーのページが 1,3,13-16,18-28(17ページ)・最大インク 300%', async () => {
    const doc = await PDFDocument.load(readFileSync(join(dirEnv, 'color-a5.pdf')), { updateMetadata: false });
    const n = await neutralize(doc);
    assert.equal(n.ops, 422);
    const ink = await limitInk(doc, 300);
    const r = await inspectPress(doc, 'body-cmyk', ink.facts);
    console.log(`       命令 ${n.ops}・カラーのページ ${JSON.stringify(r.colorPages)}・RGB の残り ${JSON.stringify(r.rgb)}・未確認 ${r.unchecked.length}`);
    // Ghostscript を通す前なので、画像・影はまだ RGB のまま残りうる。ここで確かめるのは「点検が落ちず、描く命令に RGB の指定が残っていない」こと
    assert.ok(!r.rgb.some((x) => /描く命令/.test(x)), r.rgb.join('/'));
    assert.deepEqual(r.unchecked, []);
  });
}

console.log(`\n${passed} 件通った・${failed.length} 件落ちた`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
