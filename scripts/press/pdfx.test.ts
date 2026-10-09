// src/press/pdfx.ts の検査。`node scripts/press/pdfx.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 実物(Chrome が書き出した本文・表紙を Ghostscript に通したもの)の検査は、環境変数 PRESS_FIXTURES を渡したときだけ回る。
//   PRESS_FIXTURES=<color-a5.pdf などのあるフォルダ> node scripts/press/pdfx.test.ts
// 渡さなければ飛ばして、飛ばしたと表示する。実物の検査は Ghostscript を3回動かす(数十秒)。
//   PRESS_REUSE_GS=1 を付けると、出力フォルダにある前回の Ghostscript の出力(gs-*.pdf)を使い回す
// 出力フォルダは PRESS_OUT(無ければ PRESS_FIXTURES の隣の out/pdfx)。独立の検査(scripts/check-press.py)は python で呼ぶ。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFHeader, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts, cmyk } from 'pdf-lib';
import * as pdfxMod from '../../src/press/pdfx.ts';
import { applyPdfx4, checkPdfx4, pageBoxesPt, savePdfx4 } from '../../src/press/pdfx.ts';
import { bodyBoxes, coverBoxes } from '../../src/press/boxes.ts';
import type { PdfxOptions } from '../../src/press/pdfx.ts';
import type { PressBoxes } from '../../src/press/types.ts';

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

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const icc = new Uint8Array(readFileSync(join(repo, 'src', 'press', 'JapanColor2011Coated.icc')));
const MM = 72 / 25.4;
const N = (s: string) => PDFName.of(s);
const near = (a: number, b: number, tol = 0.001) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}(許す差 ${tol})`);
const nearArr = (a: number[], b: number[], tol = 0.001) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => near(v, b[i], tol));
};

// ───────────────────────── 1. pageBoxesPt ─────────────────────────
console.log('pageBoxesPt');

const A5: PressBoxes = { kind: 'body', trimW: 148, trimH: 210, bleedTop: 3.2, bleedBottom: 3.2, bleedFore: 3.2, bleedGutter: 0, firstGutter: 'right' };
const A5W = 151.2 * MM; // 428.598
const A5H = 216.4 * MM; // 613.417

await test('A5・塗り足し 3.2/3.2/3.2/0・1ページ目(ノド右)', () => {
  const b = pageBoxesPt(A5, 0, { x: 0, y: 0, width: 428.88, height: 613.92 });
  assert.equal(b.problem, undefined);
  // 左上を保って名目の大きさに切り直す(余りは右と下)
  nearArr(b.media, [0, 613.92 - A5H, A5W, 613.92]);
  // ノドが右: 左に小口の塗り足し 3.2mm、右はノド側の塗り足し 0 なので TrimBox の右端 = 用紙の右端
  nearArr(b.trim, [3.2 * MM, 613.92 - (3.2 + 210) * MM, (3.2 + 148) * MM, 613.92 - 3.2 * MM]);
  near(b.trim[2], b.media[2]);
});

await test('2ページ目はノドが左(TrimBox の左端 = 用紙の左端)', () => {
  const b = pageBoxesPt(A5, 1, { x: 0, y: 0, width: 428.88, height: 613.92 });
  nearArr(b.trim, [0, 613.92 - (3.2 + 210) * MM, 148 * MM, 613.92 - 3.2 * MM]);
  const c = pageBoxesPt(A5, 2, { x: 0, y: 0, width: 428.88, height: 613.92 });
  near(c.trim[0], 3.2 * MM); // 3ページ目はまた右
});

await test('1ページ目のノドが左の本(横組み)は、左右が逆', () => {
  const b = pageBoxesPt({ ...A5, firstGutter: 'left' }, 0, { x: 0, y: 0, width: 428.88, height: 613.92 });
  near(b.trim[0], 0);
  const c = pageBoxesPt({ ...A5, firstGutter: 'left' }, 1, { x: 0, y: 0, width: 428.88, height: 613.92 });
  near(c.trim[0], 3.2 * MM);
});

await test('四辺 3mm の本文(ノド側にも付く)', () => {
  const four: PressBoxes = { kind: 'body', trimW: 148, trimH: 210, bleedTop: 3, bleedBottom: 3, bleedFore: 3, bleedGutter: 3, firstGutter: 'right' };
  const b = pageBoxesPt(four, 0, { x: 0, y: 0, width: 154 * MM, height: 216 * MM });
  assert.equal(b.problem, undefined);
  nearArr(b.media, [0, 0, 154 * MM, 216 * MM]);
  nearArr(b.trim, [3 * MM, 3 * MM, 151 * MM, 213 * MM]);
});

await test('表紙: TrimBox は四辺を塗り足しだけ内へ', () => {
  const cover: PressBoxes = { kind: 'cover', trimW: 297.9, trimH: 210, bleed: 3.2 };
  const w = (297.9 + 6.4) * MM;
  const h = 216.4 * MM;
  const b = pageBoxesPt(cover, 0, { x: 0, y: 0, width: w, height: h });
  assert.equal(b.problem, undefined);
  nearArr(b.media, [0, 0, w, h]);
  nearArr(b.trim, [3.2 * MM, 3.2 * MM, w - 3.2 * MM, h - 3.2 * MM]);
});

await test('名目より 0.3mm 大きい MediaBox は、左上を保って切り直される(原点が 0 でなくても)', () => {
  const m = { x: 10, y: 20, width: A5W + 0.3 * MM, height: A5H + 0.3 * MM };
  const b = pageBoxesPt(A5, 0, m);
  assert.equal(b.problem, undefined);
  near(b.media[0], 10);
  near(b.media[3], 20 + m.height); // 上は動かない
  near(b.media[2] - b.media[0], A5W);
  near(b.media[3] - b.media[1], A5H);
  near(b.trim[1], b.media[3] - (3.2 + 210) * MM);
});

await test('小さすぎる・大きすぎるときは problem(ちょうど境目の内側は通る)', () => {
  // 小さい側は 0.3mm まで(Chrome が用紙を格子に丸めて、名目より最大 0.16mm 小さく出す。2026-10-01 実測)。大きい側は 1mm まで
  const at = (dw: number, dh = 0) => pageBoxesPt(A5, 4, { x: 0, y: 0, width: A5W + dw * MM, height: A5H + dh * MM });
  assert.equal(at(-0.29).problem, undefined);
  assert.equal(at(0.99).problem, undefined);
  assert.equal(at(0, 0.99).problem, undefined);
  assert.equal(at(0, -0.29).problem, undefined);
  const small = at(-0.31).problem ?? '';
  assert.match(small, /^5ページの紙の大きさ（\d+(\.\d+)?×\d+(\.\d+)?mm）が、この本の用紙（151\.2×216\.4mm）と違います$/);
  assert.ok(at(1.1).problem);
  assert.ok(at(0, -0.31).problem);
  assert.ok(at(0, 1.1).problem);
  // A4 の PDF を A5 の設定で通したとき
  const wrong = pageBoxesPt(A5, 0, { x: 0, y: 0, width: 595.28, height: 841.89 }).problem ?? '';
  assert.match(wrong, /1ページの紙の大きさ（210(\.\d+)?×297(\.\d+)?mm）/);
});

// ───────────────────────── 2. 手作りの PDF ─────────────────────────
console.log('\n手作りの PDF');

const NOW = new Date(Date.UTC(2026, 9, 1, 7, 49, 0));
const baseOpts = (over?: Partial<PdfxOptions>): PdfxOptions => ({
  icc,
  title: 'テストの本',
  boxes: A5,
  blend: 'DeviceCMYK',
  now: NOW,
  ids: { documentId: 'uuid:00000000-0000-4000-8000-000000000001', instanceId: 'uuid:00000000-0000-4000-8000-000000000002' },
  ...over,
});

/**
 * 直す所を一通り持った 3ページ(A5 + Chrome 並みの 0.3mm の余り)。
 * リンクの注釈・PrinterMark の注釈・/OpenAction・/AA・/Names の JavaScript・透明のグループ(DeviceRGB)と
 * SMask の /BC(3成分)・転送関数・空の /Annots []
 */
async function makeDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const W = 428.88;
  const H = 613.92;
  const p0 = doc.addPage([W, H]);
  const p1 = doc.addPage([W, H]);
  doc.addPage([W, H]);
  p0.drawRectangle({ x: 20, y: 20, width: 100, height: 100, color: cmyk(0, 0, 0, 1) });
  // ページの /Group(DeviceRGB)
  p0.node.set(N('Group'), ctx.obj({ S: 'Transparency', CS: 'DeviceRGB', I: true }));
  // SMask(Luminosity)の元になるフォーム(自身も /Group /CS /DeviceRGB)と、それを使う ExtGState。/BC は 3成分
  const form = ctx.register(
    ctx.stream('0 0 0 1 k 0 0 50 50 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50], Group: { S: 'Transparency', CS: 'DeviceRGB' } }),
  );
  const gs = ctx.register(
    ctx.obj({
      Type: 'ExtGState',
      SMask: { Type: 'Mask', S: 'Luminosity', G: form, BC: [0.2, 0.4, 0.6] },
      TR: 'Custom',
      HTP: 'Custom',
    }),
  );
  p0.node.set(N('Resources'), ctx.obj({ ExtGState: { GS0: gs }, XObject: { Fm0: form } }));
  // 注釈: Link(URI の動作つき)と PrinterMark
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], A: { S: 'URI', URI: PDFString.of('https://example.com/') } }));
  const mark = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'PrinterMark', Rect: [0, 0, 5, 5] }));
  p0.node.set(N('Annots'), ctx.obj([link, mark]));
  p1.node.set(N('Annots'), ctx.obj([]));
  // 図形の中身(PDFContentStream)は書き出すまで符号化されない。製品では保存済みの PDF を開くので、同じように開き直す
  // Catalog
  doc.catalog.set(N('OpenAction'), ctx.obj([p0.ref, 'Fit']));
  doc.catalog.set(N('AA'), ctx.obj({ WC: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } }));
  doc.catalog.set(N('Names'), ctx.obj({ JavaScript: { Names: [PDFString.of('x'), { S: 'JavaScript', JS: PDFString.of('1') }] } }));
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), { updateMetadata: false });
}

const goodState: { bytes?: Uint8Array } = {};

await test('applyPdfx4 → savePdfx4 → 開き直して checkPdfx4 が空。fixed の数が合う', async () => {
  const doc = await makeDoc();
  const before = await checkPdfx4(doc);
  assert.ok(before.length >= 8, `直す前は決まりに合わないはず: ${before.length} 件`);
  const r = await applyPdfx4(doc, baseOpts());
  assert.deepEqual(r.violations, [], r.violations.join('\n'));
  // 箱 3ページ・グループ 2(ページと Form)・下地 1・注釈 1(Link。PrinterMark は残す)・
  // 在ってはいけないもの 5(/OpenAction・/AA・/Names の JavaScript・/TR・/HTP)
  assert.deepEqual(r.detail, { boxPages: 3, groups: 2, backdrops: 1, annots: 1, forbidden: 5, orphans: r.detail.orphans });
  assert.equal(r.fixed, 3 + 2 + 1 + 1 + 5);
  assert.ok(r.detail.orphans >= 1, 'Link の注釈(と動作)は捨てられる');
  const bytes = await savePdfx4(doc);
  goodState.bytes = bytes;
  const text = Buffer.from(bytes).toString('latin1');
  assert.equal(text.slice(0, 8), '%PDF-1.6');
  assert.ok(/trailer[\s\S]*\/ID\s*\[/.test(text), 'trailer に /ID');
  assert.ok(/\nxref\n/.test(text) && !/\/Type\s*\/XRef/.test(text), '相互参照は古い形の表');
  assert.ok(!text.includes('/URI') && !text.includes('app.alert'), '外した動作は文書に残らない');
  const re = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.deepEqual(await checkPdfx4(re), []);
  // 中身の確認: 箱・OutputIntent・Info・XMP
  const p = re.getPage(0).node;
  const arr = (k: string) => (p.lookup(N(k)) as PDFArray).asArray().map((x) => (x as PDFNumber).asNumber());
  nearArr(arr('MediaBox'), [0, 613.92 - A5H, A5W, 613.92]);
  nearArr(arr('BleedBox'), arr('MediaBox'));
  assert.ok(!p.has(N('CropBox')) && !p.has(N('ArtBox')));
  const annots = p.lookup(N('Annots')) as PDFArray;
  assert.equal(annots.size(), 1);
  assert.equal((annots.lookup(0) as PDFDict).lookup(N('Subtype'))?.toString(), '/PrinterMark');
  assert.ok(!re.getPage(1).node.has(N('Annots')), '空の /Annots [] は消える');
  assert.equal(p.lookup(N('Group')) instanceof PDFDict ? ((p.lookup(N('Group')) as PDFDict).lookup(N('CS')) as PDFName).decodeText() : '', 'DeviceCMYK');
  const intents = re.catalog.lookup(N('OutputIntents')) as PDFArray;
  assert.equal(intents.size(), 1);
  const oi = intents.lookup(0) as PDFDict;
  assert.equal(oi.lookup(N('S'))?.toString(), '/GTS_PDFX');
  assert.equal((oi.lookup(N('OutputConditionIdentifier')) as PDFString).decodeText(), 'JCS2011');
  const prof = oi.lookup(N('DestOutputProfile')) as PDFRawStream;
  assert.equal(String(prof.dict.lookup(N('N'))), '4');
  assert.equal(String(prof.dict.lookup(N('Filter'))), '/FlateDecode');
  const info = re.context.lookup(re.context.trailerInfo.Info as PDFRef) as PDFDict;
  assert.equal(info.lookup(N('Trapped'))?.toString(), '/False');
  assert.equal((info.lookup(N('Title')) as PDFHexString).decodeText(), 'テストの本');
  assert.equal((info.lookup(N('ModDate')) as PDFString).decodeText(), 'D:20261001074900Z');
  const meta = re.catalog.lookup(N('Metadata')) as PDFRawStream;
  assert.equal(meta.dict.get(N('Filter')), undefined);
  const xmp = Buffer.from(meta.contents).toString('utf8');
  assert.ok(xmp.includes('<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>'));
  assert.ok(xmp.includes('<pdf:Trapped>False</pdf:Trapped>'));
  assert.ok(xmp.includes('<xmp:ModifyDate>2026-10-01T07:49:00Z</xmp:ModifyDate>'));
  assert.ok(xmp.includes('uuid:00000000-0000-4000-8000-000000000001'));
  // SMask の /BC は 4成分(0 0 0 1-v)になった。v = 0.3*0.2+0.59*0.4+0.11*0.6 = 0.362
  const gsd = (re.context.lookup(((p.lookup(N('Resources')) as PDFDict).lookup(N('ExtGState')) as PDFDict).get(N('GS0')) as PDFRef) as PDFDict);
  const bc = ((gsd.lookup(N('SMask')) as PDFDict).lookup(N('BC')) as PDFArray).asArray().map((x) => (x as PDFNumber).asNumber());
  nearArr(bc, [0, 0, 0, 0.638]);
  assert.ok(!gsd.has(N('TR')) && !gsd.has(N('HTP')));
});

await test('元の CreationDate は保ち、ModDate は渡した日時にする。Producer は元の表記を残す', async () => {
  const doc = await makeDoc();
  const ref = doc.context.register(doc.context.obj({ Producer: PDFString.of('GPL Ghostscript 10.06.0'), CreationDate: PDFString.of("D:20260927101500+09'00'") }));
  doc.context.trailerInfo.Info = ref;
  const r = await applyPdfx4(doc, baseOpts({ title: '' }));
  assert.deepEqual(r.violations, []);
  const d = doc.context.lookup(ref) as PDFDict;
  assert.equal((d.lookup(N('CreationDate')) as PDFString).decodeText(), "D:20260927101500+09'00'");
  assert.match((d.lookup(N('Producer')) as PDFString).decodeText(), /^GPL Ghostscript 10\.06\.0; PDF\/X-4 finish/);
  assert.equal((d.lookup(N('Title')) as PDFHexString).decodeText(), '無題');
  const xmp = Buffer.from((doc.catalog.lookup(N('Metadata')) as PDFRawStream).contents).toString('utf8');
  assert.ok(xmp.includes('<xmp:CreateDate>2026-09-27T10:15:00+09:00</xmp:CreateDate>'));
});

await test('2回かけても壊れない(OutputIntent・XMP・Producer が二重にならない。2回目の fixed は 0)', async () => {
  const doc = await makeDoc();
  await applyPdfx4(doc, baseOpts());
  const r2 = await applyPdfx4(doc, baseOpts({ ids: undefined, now: new Date(NOW.getTime() + 60000) }));
  assert.deepEqual(r2.violations, []);
  assert.equal(r2.fixed, 0);
  assert.equal((doc.catalog.lookup(N('OutputIntents')) as PDFArray).size(), 1);
  // ICC のストリームは1つだけ(同じものを使い回す)
  let profiles = 0;
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream && o.dict.has(N('N')) && String(o.dict.get(N('N'))) === '4') profiles++;
  }
  assert.equal(profiles, 1);
  const xmp = Buffer.from((doc.catalog.lookup(N('Metadata')) as PDFRawStream).contents).toString('utf8');
  assert.equal(xmp.split('<pdfxid:GTS_PDFXVersion>').length, 2);
  assert.ok(xmp.includes('<xmpMM:VersionID>2</xmpMM:VersionID>'), '2回目は版が 1 つ上がる');
  assert.equal(xmp.split('PDF/X-4 finish').length, 2, 'Producer の印が二重にならない');
  // 保存して開き直した物にもう1回
  const bytes = await savePdfx4(doc);
  const re = await PDFDocument.load(bytes, { updateMetadata: false });
  const r3 = await applyPdfx4(re, baseOpts({ ids: undefined, now: new Date(NOW.getTime() + 120000) }));
  assert.deepEqual(r3.violations, []);
  assert.equal(r3.fixed, 0);
  assert.equal((re.catalog.lookup(N('OutputIntents')) as PDFArray).size(), 1);
});

await test('白黒の本(blend=DeviceGray): グループは DeviceGray、/BC は 1成分', async () => {
  const doc = await makeDoc();
  const r = await applyPdfx4(doc, baseOpts({ blend: 'DeviceGray' }));
  assert.deepEqual(r.violations, []);
  const p = doc.getPage(0).node;
  assert.equal(((p.lookup(N('Group')) as PDFDict).lookup(N('CS')) as PDFName).decodeText(), 'DeviceGray');
  const gsd = doc.context.lookup(((p.lookup(N('Resources')) as PDFDict).lookup(N('ExtGState')) as PDFDict).get(N('GS0')) as PDFRef) as PDFDict;
  const bc = ((gsd.lookup(N('SMask')) as PDFDict).lookup(N('BC')) as PDFArray).asArray().map((x) => (x as PDFNumber).asNumber());
  nearArr(bc, [0.362], 0.0006);
});

await test('用紙の大きさが合わないページは、箱を書かずに violations へ', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([595.28, 841.89]);
  const r = await applyPdfx4(doc, baseOpts());
  assert.ok(r.violations.some((v) => /^1ページの紙の大きさ（210(\.\d+)?×297(\.\d+)?mm）が、この本の用紙（151\.2×216\.4mm）と違います/.test(v)), r.violations.join('\n'));
  assert.equal(r.detail.boxPages, 0);
  assert.equal(doc.getPage(0).node.has(N('TrimBox')), false);
});

await test('回転・UserUnit のあるページは violations へ。継いだ MediaBox・親の CropBox にも対応', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const a = doc.addPage([428.88, 613.92]);
  const b = doc.addPage([428.88, 613.92]);
  const c = doc.addPage([428.88, 613.92]);
  a.node.set(N('Rotate'), PDFNumber.of(90));
  b.node.set(N('UserUnit'), PDFNumber.of(2));
  // c: MediaBox を親の Pages に移し(ページ自身は持たない)、親に CropBox を置く
  const parent = c.node.lookup(N('Parent')) as PDFDict;
  parent.set(N('MediaBox'), doc.context.obj([0, 0, 428.88, 613.92]));
  parent.set(N('CropBox'), doc.context.obj([5, 5, 100, 100]));
  c.node.delete(N('MediaBox'));
  const r = await applyPdfx4(doc, baseOpts());
  assert.ok(r.violations.some((v) => v.startsWith('1ページは回転')), r.violations.join('\n'));
  assert.ok(r.violations.some((v) => v.startsWith('2ページは用紙の単位')), r.violations.join('\n'));
  assert.ok(!r.violations.some((v) => v.startsWith('3ページ')), '継いだ MediaBox のページは通る');
  assert.equal(parent.has(N('CropBox')), false, '親の CropBox は消える(子が継いでしまうので)');
  assert.ok(c.node.has(N('TrimBox')) && c.node.has(N('MediaBox')));
});

// ───────────────────────── F3: 2026-10-01 の直し(reports/2-1.md の 1〜6) ─────────────────────────
console.log('\n箱・版の印・書名・暗号化・小さい点(F3)');

const pyAvailable = (mods: string) => spawnSync('python', ['-c', `import ${mods}`], { encoding: 'utf8' }).status === 0;
const pyRun = (args: string[]) => {
  const r = spawnSync('python', args, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 1 << 26 });
  return { code: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const tmp = mkdtempSync(join(tmpdir(), 'pdfx-test-'));

/** 同じ大きさの白紙を n ページ(大きさは mm) */
async function blank(wMm: number, hMm: number, n = 3): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < n; i++) doc.addPage([wMm * MM, hMm * MM]);
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), { updateMetadata: false });
}
const mediaOf = (doc: PDFDocument, i: number) =>
  (doc.getPage(i).node.lookup(N('MediaBox')) as PDFArray).asArray().map((x) => (x as PDFNumber).asNumber());
const infoOfDoc = (doc: PDFDocument) => doc.context.lookup(doc.context.trailerInfo.Info as PDFRef) as PDFDict;
const strOf = (v: unknown) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '');

// ── 1. 用紙の大きさ ──
await test('1. 名目より小さい側に 0.16mm 振れた PDF(Chrome 実測の 151.3×216.24mm)は、断られずに整えられる', async () => {
  const doc = await blank(151.3, 216.24);
  const r = await applyPdfx4(doc, baseOpts());
  assert.deepEqual(r.violations, [], r.violations.join('\n'));
  assert.equal(r.paperMismatch ?? null, null);
  assert.equal(r.detail.boxPages, 3);
  // MediaBox は名目の大きさで書く。左上を保つので、足りない 0.16mm は元の紙の下(y が負)に出る(白のまま。塗り足しの端が欠けるだけで、断裁で落ちる所)
  const m = mediaOf(doc, 0);
  nearArr([m[2] - m[0], m[3] - m[1]], [A5W, A5H]);
  near(m[3], 216.24 * MM, 0.0002);
  assert.ok(m[1] < 0, `下に伸びる: ${m[1]}`);
  const bytes = await savePdfx4(doc);
  const re = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.deepEqual(await checkPdfx4(re), []);
  writeFileSync(join(tmp, 'smaller.pdf'), bytes);
});

await test('1. 小さい側に振れた PDF は、独立の検査 check-press.py の boxes を通る', () => {
  if (!pyAvailable('pypdf, pymupdf, numpy')) return void console.log('       (python か pypdf・pymupdf が無いので飛ばした)');
  const res = pyRun([join(repo, 'scripts', 'check-press.py'), '--kind', 'body-gray', '--out', join(tmp, 'smaller.pdf'), '--trim', '148x210', '--bleed', '3.2,3.2,3.2,0', '--first-gutter', 'right', '--only', 'boxes', '--quiet']);
  assert.equal(res.code, 0, res.text);
});

await test('1. 0.5mm 小さい・2mm 大きい PDF は paperMismatch(値)が入り、箱を書かない。violations の文は今のまま', async () => {
  const small = await blank(151.2 - 0.5, 216.4);
  const rs = await applyPdfx4(small, baseOpts());
  assert.ok(rs.paperMismatch, '値で返る');
  assert.deepEqual(rs.paperMismatch?.pages, [1, 2, 3]);
  nearArr([rs.paperMismatch!.actualMm.w, rs.paperMismatch!.actualMm.h, rs.paperMismatch!.expectedMm.w, rs.paperMismatch!.expectedMm.h], [150.7, 216.4, 151.2, 216.4], 0.01);
  assert.ok(rs.violations.some((v) => /^1ページの紙の大きさ（150\.7×216\.4mm）が、この本の用紙（151\.2×216\.4mm）と違います\(ほか 2 ページも同じ\)/.test(v)), rs.violations.join('\n'));
  assert.equal(small.getPage(0).node.has(N('TrimBox')), false);
  assert.equal(rs.detail.boxPages, 0);

  const big = await blank(151.2, 216.4 + 2);
  const rb = await applyPdfx4(big, baseOpts());
  assert.deepEqual(rb.paperMismatch?.pages, [1, 2, 3]);
  nearArr([rb.paperMismatch!.actualMm.w, rb.paperMismatch!.actualMm.h], [151.2, 218.4], 0.01);
  assert.equal(big.getPage(2).node.has(N('TrimBox')), false);

  // 一部のページだけ違うとき: 違うページの番号だけ、最初の違いの大きさが actual
  const mixed = await blank(151.2, 216.4, 4);
  mixed.getPage(2).setMediaBox(0, 0, 595.28, 841.89);
  const rm = await applyPdfx4(mixed, baseOpts());
  assert.deepEqual(rm.paperMismatch?.pages, [3]);
  nearArr([rm.paperMismatch!.actualMm.w, rm.paperMismatch!.actualMm.h], [210, 297], 0.01);
  assert.equal(mixed.getPage(0).node.has(N('TrimBox')), true, '合っているページには箱が書かれる');
  assert.equal(mixed.getPage(2).node.has(N('TrimBox')), false);
});

await test('1. 合っている PDF は paperMismatch が null', async () => {
  const doc = await blank(151.2, 216.4);
  const r = await applyPdfx4(doc, baseOpts());
  assert.deepEqual(r.violations, []);
  assert.equal(r.paperMismatch, null);
});

// ── 2. Info の /GTS_PDFXVersion ──
await test('2. 既定は「Info に書く」。定数を切り替えると「書かない・在れば違反」になり、検査も両方の向きを確かめる', async () => {
  assert.equal(pdfxMod.WRITE_INFO_PDFX_VERSION, true, '既定は書く');

  const a = await blank(151.2, 216.4);
  const ra = await applyPdfx4(a, baseOpts());
  assert.deepEqual(ra.violations, []);
  assert.equal(strOf(infoOfDoc(a).lookup(N('GTS_PDFXVersion'))), 'PDF/X-4');
  assert.deepEqual(await checkPdfx4(a, { infoVersionMark: true }), []);
  const asOmit = await checkPdfx4(a, { infoVersionMark: false });
  assert.ok(asOmit.some((v) => /Info の \/GTS_PDFXVersion が残っています/.test(v)), asOmit.join('\n'));

  const b = await blank(151.2, 216.4);
  const rb = await applyPdfx4(b, baseOpts({ infoVersionMark: false }));
  assert.deepEqual(rb.violations, [], rb.violations.join('\n'));
  assert.equal(infoOfDoc(b).has(N('GTS_PDFXVersion')), false, '書かない側では消える');
  assert.deepEqual(await checkPdfx4(b, { infoVersionMark: false }), []);
  const bAsWrite = await checkPdfx4(b, { infoVersionMark: true });
  assert.ok(bAsWrite.some((v) => /Info の PDF\/X の版\(\/GTS_PDFXVersion\)が PDF\/X-4 になっていません\(なし\)/.test(v)), bAsWrite.join('\n'));
  // XMP の版の印は、どちらでも要る
  assert.ok(Buffer.from((b.catalog.lookup(N('Metadata')) as PDFRawStream).contents).toString('utf8').includes('<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>'));
});

await test('2. check-press.py も、Info の版の印を両方の向きで確かめる(--info-pdfx-version write|omit)', async () => {
  if (!pyAvailable('pypdf, pymupdf, numpy')) return void console.log('       (python か pypdf・pymupdf が無いので飛ばした)');
  const run = (file: string, mode: string) =>
    pyRun([join(repo, 'scripts', 'check-press.py'), '--kind', 'body-gray', '--out', file, '--trim', '148x210', '--bleed', '3.2,3.2,3.2,0', '--first-gutter', 'right', '--only', 'pdfx', '--quiet', '--info-pdfx-version', mode]);
  const w = await blank(151.2, 216.4);
  await applyPdfx4(w, baseOpts());
  const o = await blank(151.2, 216.4);
  await applyPdfx4(o, baseOpts({ infoVersionMark: false }));
  const wp = join(tmp, 'info-write.pdf');
  const op = join(tmp, 'info-omit.pdf');
  writeFileSync(wp, await savePdfx4(w));
  writeFileSync(op, await savePdfx4(o));
  assert.equal(run(wp, 'write').code, 0, run(wp, 'write').text);
  assert.equal(run(op, 'omit').code, 0, run(op, 'omit').text);
  const wrong1 = run(op, 'write');
  const wrong2 = run(wp, 'omit');
  assert.notEqual(wrong1.code, 0, '書く設定で、無い PDF は落ちる');
  assert.notEqual(wrong2.code, 0, '書かない設定で、在る PDF は落ちる');
  assert.match(wrong1.text, /GTS_PDFXVersion/);
  assert.match(wrong2.text, /GTS_PDFXVersion/);
});

// ── 3. 書名 ──
await test('3. cleanTitle: 改行・タブ・制御文字は空白、U+FFFE/FFFF と孤立サロゲートは除く、前後を取る、200 字で切る、空は「無題」', () => {
  const c = pdfxMod.cleanTitle;
  assert.equal(c('青い背表紙'), '青い背表紙');
  assert.equal(c('  前後 '), '前後');
  assert.equal(c('a\rb\r\nc\td\ne'), 'a b  c d e');
  assert.equal(c('a\u0000b\u0001c\u001fd\u007fe'), 'a b c d e');
  assert.equal(c('a￾b￿c'), 'abc');
  assert.equal(c('x\ud800y\udc00z'), 'xyz', '孤立サロゲートは除く');
  assert.equal(c('🙂本🙂'), '🙂本🙂', '対になったサロゲートは残す');
  assert.equal(c(''), '無題');
  assert.equal(c('   \t\r\n '), '無題');
  assert.equal(c('￾￿'), '無題');
  const long = c('あ'.repeat(300));
  assert.equal([...long].length, 200);
  // 200 字目が絵文字でも、サロゲートの途中で切らない
  const emoji = c('a'.repeat(199) + '🙂🙂');
  assert.equal([...emoji].length, 200);
  assert.equal(emoji.endsWith('🙂'), true);
  assert.ok(!/[\ud800-\udbff]$/.test(emoji.replace(/🙂$/, '')), 'サロゲートの途中で切れていない');
  // 切った末尾が空白なら、そこも取る
  assert.equal(c('a'.repeat(199) + ' bbb'), 'a'.repeat(199));
  assert.equal(c('a&<>"\'b'), 'a&<>"\'b', '記号はそのまま(XMP の側で逃がす)');
});

await test('3. 書名は Info と XMP に同じ文字で入り、XMP は XML の読み手(minidom)で読める', async () => {
  const titles = ['テストの本', '', 'a\rb\r\nc\td', 'a￾b￿c', 'x\ud800y', '🙂 絵文字 🙂', 'a&b<c>d"e\'f]]>g--h', '\u0001\u001f制御', 'あ'.repeat(500), ' \t前後\n '];
  const paths: string[] = [];
  const infoTitles: string[] = [];
  for (const [i, title] of titles.entries()) {
    const doc = await blank(151.2, 216.4, 1);
    const r = await applyPdfx4(doc, baseOpts({ title }));
    assert.deepEqual(r.violations, [], `${JSON.stringify(title)}: ${r.violations.join('\n')}`);
    const re = await PDFDocument.load(await savePdfx4(doc), { updateMetadata: false });
    infoTitles.push(strOf(infoOfDoc(re).lookup(N('Title'))));
    const p = join(tmp, `title-${i}.xmp`);
    writeFileSync(p, (re.catalog.lookup(N('Metadata')) as PDFRawStream).contents);
    paths.push(p);
    assert.equal(infoTitles[i], pdfxMod.cleanTitle(title), `Info の書名が整えた物になっている: ${JSON.stringify(title)}`);
  }
  if (!pyAvailable('xml.dom.minidom')) return void console.log('       (python が無いので、XML の読み手での確認は飛ばした)');
  const script = `
import sys, json
from xml.dom import minidom
out = []
for p in sys.argv[1:]:
    dom = minidom.parse(p)
    li = dom.getElementsByTagName('rdf:li')[0]
    out.append(''.join(n.data for n in li.childNodes if n.nodeType in (n.TEXT_NODE, n.CDATA_SECTION_NODE)))
print(json.dumps(out, ensure_ascii=False))
`;
  const res = pyRun(['-c', script, ...paths]);
  assert.equal(res.code, 0, `XMP が XML として読めない: ${res.text}`);
  const got = JSON.parse(res.text.trim().split('\n').pop() ?? '[]') as string[];
  assert.deepEqual(got, infoTitles, 'XML の読み手で読んだ dc:title が、Info の /Title と同じ');
});

// ── 4. 暗号化 ──
await test('4. /Encrypt が在れば、violations に「パスワードや編集の制限がかかっています」', async () => {
  const doc = await blank(151.2, 216.4);
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard' }));
  const r = await applyPdfx4(doc, baseOpts());
  assert.ok(r.violations.some((v) => v.includes('パスワードや編集の制限がかかっています')), r.violations.join('\n'));
});

// ── 5. 小さい点 ──
await test('5. 箱の入力が NaN・負・0 以下のときは、箱を書かずに problem を返す', async () => {
  const bad: [string, PressBoxes][] = [
    ['NaN', { ...A5, trimW: NaN } as PressBoxes],
    ['負の塗り足し', { ...A5, bleedTop: -1 } as PressBoxes],
    ['0 の仕上がり', { ...A5, trimH: 0 } as PressBoxes],
    ['Infinity', { ...A5, bleedFore: Infinity } as PressBoxes],
    ['表紙の負の仕上がり', { kind: 'cover', trimW: -5, trimH: 210, bleed: 3.2 }],
    ['表紙の NaN の塗り足し', { kind: 'cover', trimW: 297.9, trimH: 210, bleed: NaN }],
  ];
  for (const [name, boxes] of bad) {
    const p = pageBoxesPt(boxes, 0, { x: 0, y: 0, width: 428.88, height: 613.92 });
    assert.ok(p.problem && /箱の大きさ/.test(p.problem), `${name}: ${p.problem}`);
    const doc = await blank(151.2, 216.4, 2);
    const r = await applyPdfx4(doc, baseOpts({ boxes }));
    assert.ok(r.violations.some((v) => /箱の大きさ/.test(v)), `${name}: ${r.violations.join('\n')}`);
    assert.equal(doc.getPage(0).node.has(N('TrimBox')), false, `${name}: 箱を書いていない`);
    assert.ok(mediaOf(doc, 0).every((v) => Number.isFinite(v)), `${name}: MediaBox が壊れていない`);
    assert.equal(r.paperMismatch ?? null, null, `${name}: 紙の大きさの食い違いではない`);
  }
});

await test('5. /OCProperties の /AS(自動の切り替え)は消す', async () => {
  const doc = await blank(151.2, 216.4);
  const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('L') }));
  doc.catalog.set(
    N('OCProperties'),
    doc.context.obj({ OCGs: [ocg], D: { AS: [{ Event: 'View', OCGs: [ocg], Category: ['View'] }], Order: [ocg] }, Configs: [{ AS: [], Name: PDFString.of('c') }] }),
  );
  assert.ok((await checkPdfx4(doc)).some((v) => /\/AS/.test(v)), '直す前は咎める');
  const r = await applyPdfx4(doc, baseOpts());
  assert.deepEqual(r.violations, [], r.violations.join('\n'));
  const ocp = doc.catalog.lookup(N('OCProperties')) as PDFDict;
  assert.equal((ocp.lookup(N('D')) as PDFDict).has(N('AS')), false);
  assert.equal(((ocp.lookup(N('Configs')) as PDFArray).lookup(0) as PDFDict).has(N('AS')), false);
  assert.ok(r.detail.forbidden >= 2);
});

// ── 6. boxes.ts ──
await test('6. bodyBoxes・coverBoxes は、有限でない値・負の値で例外にする(正しい値は今までどおり)', () => {
  const layout = { trimW: 148, trimH: 210, bleed: { top: 3.2, bottom: 3.2, fore: 3.2, gutter: 0 }, writingMode: 'vertical' as const };
  assert.deepEqual(bodyBoxes(layout), { kind: 'body', trimW: 148, trimH: 210, bleedTop: 3.2, bleedBottom: 3.2, bleedFore: 3.2, bleedGutter: 0, firstGutter: 'right' });
  assert.equal(bodyBoxes({ ...layout, writingMode: 'horizontal' }).firstGutter, 'left');
  assert.throws(() => bodyBoxes({ ...layout, trimW: NaN }), /箱/);
  assert.throws(() => bodyBoxes({ ...layout, trimH: 0 }), /箱/);
  assert.throws(() => bodyBoxes({ ...layout, bleed: { ...layout.bleed, gutter: -0.1 } }), /箱/);
  assert.throws(() => bodyBoxes({ ...layout, bleed: { ...layout.bleed, top: Infinity } }), /箱/);
  assert.throws(() => bodyBoxes({ ...layout, bleed: { ...layout.bleed, fore: undefined as unknown as number } }), /箱/);
  const cb = coverBoxes({ totalW: 304.3, totalH: 216.4, bleed: 3.2 });
  assert.equal(cb.kind, 'cover');
  nearArr([cb.trimW, cb.trimH, cb.bleed], [297.9, 210, 3.2], 1e-9);
  assert.throws(() => coverBoxes({ totalW: NaN, totalH: 216.4, bleed: 3.2 }), /箱/);
  assert.throws(() => coverBoxes({ totalW: 304.3, totalH: 216.4, bleed: -1 }), /箱/);
  assert.throws(() => coverBoxes({ totalW: 5, totalH: 216.4, bleed: 3.2 }), /箱/, '塗り足しを引いたら仕上がりが無くなる');
});

console.log('\nわざと壊したもの(整えた PDF を1か所だけ壊して、checkPdfx4 が見つけるか)');

async function good(): Promise<PDFDocument> {
  assert.ok(goodState.bytes, '先の検査が通っていない');
  return PDFDocument.load(goodState.bytes as Uint8Array, { updateMetadata: false });
}
/** 壊したものに対して、狙った決まりだけが落ちること(ほかの決まりを巻き込まない) */
async function broken(name: string, mutate: (doc: PDFDocument) => void | PDFDocument | Promise<void | PDFDocument>, expect: RegExp) {
  await test(`壊す: ${name}`, async () => {
    let doc = await good();
    // mutate が新しい PDFDocument を返したときは、そちらを点検する(pdf-lib の描画は保存するまで符号化されないので、開き直したもの)
    const next = await mutate(doc);
    if (next instanceof PDFDocument) doc = next;
    const v = await checkPdfx4(doc);
    assert.ok(v.some((x) => expect.test(x)), `見つからない。出たもの: ${JSON.stringify(v)}`);
    assert.ok(v.length <= 2, `巻き込みが多い: ${JSON.stringify(v)}`);
  });
}
const metaXml = (doc: PDFDocument) => Buffer.from((doc.catalog.lookup(N('Metadata')) as PDFRawStream).contents).toString('utf8');
const setMeta = (doc: PDFDocument, xml: string) => {
  const ref = doc.catalog.get(N('Metadata')) as PDFRef;
  doc.context.assign(ref, doc.context.stream(new TextEncoder().encode(xml), { Type: 'Metadata', Subtype: 'XML' }));
};
const infoOf = (doc: PDFDocument) => doc.context.lookup(doc.context.trailerInfo.Info as PDFRef) as PDFDict;

await broken('TrimBox を消す', (d) => d.getPage(2).node.delete(N('TrimBox')), /3ページに仕上がりの枠\(TrimBox\)がありません/);
await broken('TrimBox と ArtBox の両方', (d) => d.getPage(1).node.set(N('ArtBox'), d.getPage(1).node.get(N('TrimBox')) as PDFArray), /TrimBox と ArtBox の両方/);
await broken('TrimBox が BleedBox の外', (d) => d.getPage(0).node.set(N('TrimBox'), d.context.obj([0, 0, 500, 700])), /BleedBox の外/);
await broken('Trapped を消す', (d) => infoOf(d).delete(N('Trapped')), /Info の \/Trapped/);
await broken('Trapped が Unknown', (d) => infoOf(d).set(N('Trapped'), N('Unknown')), /Info の \/Trapped.*Unknown/);
await broken('OutputIntent を消す', (d) => d.catalog.delete(N('OutputIntents')), /印刷の条件\(OutputIntent。色の基準\)が入っていません/);
await broken('OutputIntent の ICC を RGB(N=3)にする', (d) => {
  const oi = (d.catalog.lookup(N('OutputIntents')) as PDFArray).lookup(0) as PDFDict;
  (oi.lookup(N('DestOutputProfile')) as PDFRawStream).dict.set(N('N'), PDFNumber.of(3));
}, /成分数\(\/N\)が 4/);
await broken('XMP の版が PDF/X-3', (d) => setMeta(d, metaXml(d).replace('>PDF/X-4<', '>PDF/X-3<')), /pdfxid:GTS_PDFXVersion\)が PDF\/X-4 になっていません\(PDF\/X-3\)/);
await broken('XMP を消す', (d) => d.catalog.delete(N('Metadata')), /XMP\(メタデータ。Catalog の \/Metadata\)がありません/);
await broken('XMP の Trapped が Unknown', (d) => setMeta(d, metaXml(d).replace('>False</pdf:Trapped>', '>Unknown</pdf:Trapped>')), /pdf:Trapped/);
await broken('XMP の書名と Info の書名が違う', (d) => setMeta(d, metaXml(d).replace('テストの本', '別の本')), /書名が Info と XMP で食い違っています/);
await broken('XMP の更新日が Info と違う', (d) => setMeta(d, metaXml(d).replace('<xmp:ModifyDate>2026-10-01T07:49:00Z', '<xmp:ModifyDate>2026-10-02T07:49:00Z')), /更新日が Info と XMP で食い違っています/);
await broken('XMP の VersionID を消す', (d) => setMeta(d, metaXml(d).replace(/<xmpMM:VersionID>.*<\/xmpMM:VersionID>\n/, '')), /xmpMM:VersionIDがありません/);
await broken('XMP を圧縮する', (d) => {
  const m = d.catalog.lookup(N('Metadata')) as PDFRawStream;
  m.dict.set(N('Filter'), N('FlateDecode'));
}, /XMP\(メタデータ\)が圧縮されています/);
await broken('Info の GTS_PDFXVersion が無い', (d) => infoOf(d).delete(N('GTS_PDFXVersion')), /Info の PDF\/X の版\(\/GTS_PDFXVersion\)が PDF\/X-4 になっていません\(なし\)/);
await broken('Info の GTS_PDFXVersion が PDF/X-3', (d) => infoOf(d).set(N('GTS_PDFXVersion'), PDFString.of('PDF/X-3:2002')), /Info の PDF\/X の版\(\/GTS_PDFXVersion\)が PDF\/X-4 になっていません\(PDF\/X-3:2002\)/);
await broken('Info に GTS_PDFXConformance', (d) => infoOf(d).set(N('GTS_PDFXConformance'), PDFString.of('PDF/X-1a:2001')), /Info に \/GTS_PDFXConformance が残っています/);
await broken('RGB の命令を足す', (d) => {
  d.getPage(1).node.set(N('Contents'), d.context.register(d.context.flateStream('1 0 0 rg 0 0 10 10 re f')));
}, /RGB の色が残っています.*描く命令の RGB の色 1 か所/);
await broken('RGB の画像を足す', (d) => {
  const img = d.context.register(d.context.stream(new Uint8Array(3), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  d.getPage(2).node.set(N('Resources'), d.context.obj({ XObject: { Im0: img } }));
}, /RGB の画像 1 枚/);
await broken('合成グループを DeviceRGB に戻す', (d) => {
  (d.getPage(0).node.lookup(N('Group')) as PDFDict).set(N('CS'), N('DeviceRGB'));
}, /透明の合成グループの色空間 1 か所/);
await broken('埋め込みなしの書体(Helvetica)', async (d) => {
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.getPage(2).drawText('abc', { font: f, size: 10, x: 10, y: 10, color: cmyk(0, 0, 0, 1) });
  const re = await PDFDocument.load(await d.save({ useObjectStreams: false }), { updateMetadata: false });
  re.context.header = PDFHeader.forVersion(1, 6); // 書き出し直すと 1.7 になるので、版の決まりを巻き込まない
  return re;
}, /書体が埋め込まれていません: Helvetica/);
await broken('リンクの注釈を足す', (d) => {
  const link = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 1, 1] }));
  d.getPage(2).node.set(N('Annots'), d.context.obj([link]));
}, /注釈\(Link\)が 3ページにあります/);
await broken('/OpenAction を足す', (d) => d.catalog.set(N('OpenAction'), d.context.obj([d.getPage(0).ref, 'Fit'])), /開いたときの動作/);
await broken('JavaScript の動作を足す', (d) => d.catalog.set(N('Foo'), d.context.obj({ S: 'JavaScript', JS: PDFString.of('1') })), /動作\(JavaScript\)/);
await broken('LZW のストリームを足す', (d) => {
  const s = d.context.register(d.context.stream(new Uint8Array(4), { Filter: 'LZWDecode' }));
  d.catalog.set(N('Foo'), s);
}, /LZW 圧縮のデータ/);
await broken('転送関数(/TR)を足す', (d) => d.catalog.set(N('Foo'), d.context.obj({ Type: 'ExtGState', TR: 'Foo' })), /転送関数・ハーフトーン/);
await broken('PostScript の XObject を足す', (d) => d.catalog.set(N('Foo'), d.context.register(d.context.stream('x', { Type: 'XObject', Subtype: 'PS' }))), /PostScript の部品/);
await broken('/ID を消す', (d) => {
  delete (d.context.trailerInfo as { ID?: unknown }).ID;
}, /識別番号\(trailer の \/ID\)がありません/);
await broken('ヘッダの版が 1.7', (d) => {
  d.context.header = PDFHeader.forVersion(1, 7);
}, /1\.6 より新しくなっています/);
await broken('暗号化の印(/Encrypt)', (d) => {
  d.context.trailerInfo.Encrypt = d.context.register(d.context.obj({ Filter: 'Standard' }));
}, /パスワードや編集の制限がかかっています/);

// ───────────────────────── 3. 実物 ─────────────────────────
const fixtures = process.env.PRESS_FIXTURES;
if (!fixtures || !existsSync(join(fixtures, 'color-a5.pdf'))) {
  console.log('\n実物の検査は飛ばした(環境変数 PRESS_FIXTURES に color-a5.pdf などのあるフォルダを渡すと回る)');
} else {
  console.log('\n実物');
  const out = process.env.PRESS_OUT ?? join(fixtures, '..', 'out', 'pdfx');
  mkdirSync(out, { recursive: true });
  const iccPath = join(repo, 'src', 'press', 'JapanColor2011Coated.icc');

  const FLATE = [
    '-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false', '-dColorImageFilter=/FlateEncode', '-dGrayImageFilter=/FlateEncode',
    '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
  ];
  // SPEC.md 6 の引数。外の ICC を読むので -dNOSAFER
  const COLOR_ARGS = [
    '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6', '-sColorConversionStrategy=CMYK',
    '-sProcessColorModel=DeviceCMYK', '-dOverrideICC=true', '-sOutputICCProfile=/work/JapanColor2011Coated.icc', '-dDeviceGrayToK=true',
    ...FLATE, '-sOutputFile=/work/out.pdf', '/work/in.pdf',
  ];
  const GRAY_ARGS = [
    '-dNOSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6', '-sColorConversionStrategy=Gray',
    '-sProcessColorModel=DeviceGray', '-dOverrideICC=true', ...FLATE, '-sOutputFile=/work/out.pdf', '/work/in.pdf',
  ];
  // Ghostscript は1回ごとに別の node で動かす。同じ process で3回続けて作り直すと、3回目(表紙)が
  // 「No such file or directory」で落ちた(2026-10-01 実測。表紙だけ単独で回すと通る。製品は Worker を使い捨てるので起きない)
  const GS_RUNNER = `
    import fs from 'node:fs';
    const [input, iccPath, output, ...args] = process.argv.slice(1);
    const factory = (await import('@okathira/ghostpdl-wasm')).default;
    const log = [];
    const gs = await factory({ noInitialRun: true, print: (l) => log.push(l), printErr: (l) => log.push(l) });
    gs.FS.mkdir('/work');
    gs.FS.writeFile('/work/in.pdf', fs.readFileSync(input));
    gs.FS.writeFile('/work/JapanColor2011Coated.icc', fs.readFileSync(iccPath));
    const code = gs.callMain(args);
    if (code !== 0) { console.error('exit ' + code + ': ' + log.filter((l) => !/^Page /.test(l)).slice(-6).join(' | ')); process.exit(1); }
    fs.writeFileSync(output, gs.FS.readFile('/work/out.pdf'));
  `;
  async function ghostscript(input: string, args: string[], output: string): Promise<Uint8Array> {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', GS_RUNNER, input, iccPath, output, ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, `Ghostscript が落ちた: ${r.stderr}`);
    return new Uint8Array(readFileSync(output));
  }
  const py = (args: string[]) => {
    const r = spawnSync('python', args, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 1 << 26 });
    return { code: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  interface Case {
    name: string;
    file: string;
    gs: string;
    mode: 'color' | 'gray';
    kind: string;
    boxes: PressBoxes;
    blend: 'DeviceGray' | 'DeviceCMYK';
    trim: string;
    bleed: string;
    gutter?: 'right';
    title: string;
  }
  // 表紙の展開寸法は、実物の MediaBox から逆算する(スタジオの設定からの計算は別の担当の範囲)
  const cases: Case[] = [
    { name: 'color-a5', file: 'color-a5.pdf', gs: 'gs-color-a5.pdf', mode: 'color', kind: 'body-cmyk', boxes: A5, blend: 'DeviceCMYK', trim: '148x210', bleed: '3.2,3.2,3.2,0', gutter: 'right', title: '青い背表紙' },
    {
      name: 'mono-bunko', file: 'mono-bunko.pdf', gs: 'gs-mono.pdf', mode: 'gray', kind: 'body-gray',
      boxes: { kind: 'body', trimW: 105, trimH: 148, bleedTop: 3.2, bleedBottom: 3.2, bleedFore: 3.2, bleedGutter: 0, firstGutter: 'right' },
      blend: 'DeviceGray', trim: '105x148', bleed: '3.2,3.2,3.2,0', gutter: 'right', title: '青い背表紙',
    },
    {
      name: 'cover', file: 'cover-color.pdf', gs: 'gs-cover.pdf', mode: 'color', kind: 'cover-cmyk',
      boxes: { kind: 'cover', trimW: 297.9, trimH: 210, bleed: 3.2 }, blend: 'DeviceCMYK', trim: '297.9x210', bleed: '3.2,3.2,3.2,3.2', title: '表紙',
    },
  ];

  for (const c of cases) {
    console.log(`\n${c.name}`);
    const gsPath = join(out, c.gs);
    let gsBytes: Uint8Array;
    if (process.env.PRESS_REUSE_GS && existsSync(gsPath)) gsBytes = new Uint8Array(readFileSync(gsPath));
    else {
      const t = performance.now();
      gsBytes = await ghostscript(join(fixtures, c.file), c.mode === 'color' ? COLOR_ARGS : GRAY_ARGS, gsPath);
      console.log(`       Ghostscript ${Math.round(performance.now() - t)}ms`);
    }
    const doc = await PDFDocument.load(gsBytes, { updateMetadata: false });
    const gsHead = Buffer.from(gsBytes.subarray(0, 8)).toString('latin1');
    const gsHasId = !!doc.context.trailerInfo.ID;
    const t0 = performance.now();
    const r = await applyPdfx4(doc, { icc, title: c.title, boxes: c.boxes, blend: c.blend, now: NOW });
    const t1 = performance.now();
    const bytes = await savePdfx4(doc);
    const outPath = join(out, `${c.name}-x4.pdf`);
    writeFileSync(outPath, bytes);
    console.log(
      `       Ghostscript の出力 ヘッダ ${gsHead}・/ID ${gsHasId ? 'あり' : 'なし'} → applyPdfx4 ${Math.round(t1 - t0)}ms・save ${Math.round(performance.now() - t1)}ms`,
    );
    console.log(`       fixed ${r.fixed} ${JSON.stringify(r.detail)}`);
    console.log(`       violations ${JSON.stringify(r.violations)}`);

    await test(`${c.name}: checkPdfx4 が空`, () => assert.deepEqual(r.violations, []));
    await test(`${c.name}: 書き出したファイルの頭が %PDF-1.6・trailer に /ID・相互参照がふつうの表`, () => {
      const text = Buffer.from(bytes).toString('latin1');
      assert.equal(text.slice(0, 8), '%PDF-1.6');
      const tail = text.slice(-600);
      assert.ok(/trailer/.test(tail) && /\/ID\s*\[/.test(tail), 'trailer に /ID');
      assert.ok(/\nxref\n0 \d+\n/.test(text) && !/\/Type\s*\/XRef\b/.test(text) && !/\/Type\s*\/ObjStm\b/.test(text));
    });
    await test(`${c.name}: 開き直して checkPdfx4 が空・ページ数が同じ`, async () => {
      const re = await PDFDocument.load(bytes, { updateMetadata: false });
      assert.equal(re.getPageCount(), doc.getPageCount());
      assert.deepEqual(await checkPdfx4(re), []);
    });
    await test(`${c.name}: 独立の検査 check-press.py の pdfx・boxes が通る`, () => {
      const args = [
        join(repo, 'scripts', 'check-press.py'), '--kind', c.kind, '--orig', join(fixtures, c.file), '--out', outPath,
        '--trim', c.trim, '--bleed', c.bleed, '--icc', iccPath, '--only', 'pdfx,boxes', '--quiet',
      ];
      if (c.gutter) args.push('--first-gutter', c.gutter);
      const res = py(args);
      console.log(res.text.split('\n').map((l) => `       | ${l}`).join('\n'));
      assert.equal(res.code, 0, '独立の検査が落ちた');
    });
    await test(`${c.name}: 整える前後で絵がずれていない(左上を合わせて比べる)`, async () => {
      // MuPDF は OutputIntent を DeviceCMYK・DeviceGray の既定の色空間に採って、色を管理して描く(= 入稿データとして正しい見え方)。
      // 位置の比べには邪魔なので、比べる用の写しからだけ OutputIntent を外す(2026-10-01 実測: 外すと差が 0。
      // 付けたままだと 1ページ目の絵・グレーが ICC を通るぶん、平均 0.6〜1 の差が出る。箱だけを変えた物の差も 0)
      const copy = await PDFDocument.load(bytes, { updateMetadata: false });
      copy.catalog.delete(N('OutputIntents'));
      const cmpPath = join(out, `${c.name}-x4-nointent.pdf`);
      writeFileSync(cmpPath, await copy.save({ useObjectStreams: false }));
      const script = `
import sys, json, pymupdf, numpy as np
pymupdf.TOOLS.set_icc(False)
a = pymupdf.open(sys.argv[1]); b = pymupdf.open(sys.argv[2])
n = a.page_count
assert n == b.page_count, 'ページ数'
pick = sorted(set([0, 1, n // 2, n - 1]))
worst = 0.0; res = []
for i in pick:
    if i >= n: continue
    def px(doc):
        p = doc[i]
        m = pymupdf.Matrix(72/72, 72/72)
        # MediaBox の左上から、共通の大きさだけを描く
        r = p.rect
        return p, r
    pa, ra = px(a); pb, rb = px(b)
    w = min(ra.width, rb.width); h = min(ra.height, rb.height)
    clip_a = pymupdf.Rect(ra.x0, ra.y0, ra.x0 + w, ra.y0 + h)
    clip_b = pymupdf.Rect(rb.x0, rb.y0, rb.x0 + w, rb.y0 + h)
    A = pa.get_pixmap(dpi=72, clip=clip_a, colorspace=pymupdf.csGRAY)
    B = pb.get_pixmap(dpi=72, clip=clip_b, colorspace=pymupdf.csGRAY)
    x = np.frombuffer(A.samples, dtype=np.uint8).reshape(A.height, A.width).astype(int)
    y = np.frombuffer(B.samples, dtype=np.uint8).reshape(B.height, B.width).astype(int)
    hh = min(x.shape[0], y.shape[0]); ww = min(x.shape[1], y.shape[1])
    d = np.abs(x[:hh,:ww] - y[:hh,:ww])
    res.append({'page': i + 1, 'max': int(d.max()), 'mean': round(float(d.mean()), 4), 'size_a': [round(ra.width,2), round(ra.height,2)], 'size_b': [round(rb.width,2), round(rb.height,2)]})
    worst = max(worst, float(d.mean()))
print(json.dumps({'worst_mean': worst, 'pages': res}, ensure_ascii=False))
`;
      const res = py(['-c', script, gsPath, cmpPath]);
      const last = res.text.trim().split('\n').pop() ?? '';
      const j = JSON.parse(last) as { worst_mean: number; pages: { page: number; max: number; mean: number; size_a: number[]; size_b: number[] }[] };
      console.log(`       絵の差(72dpi・輝度): ${j.pages.map((p) => `p${p.page} 平均${p.mean}/最大${p.max} 用紙 ${p.size_a.join('×')}→${p.size_b.join('×')}`).join(' | ')}`);
      assert.ok(j.worst_mean < 0.001, `絵が動いている: 平均差 ${j.worst_mean}`);
    });
    await test(`${c.name}: 2回かけても壊れない(再読み込みした物にもう1回。fixed 0・OutputIntent 1つ)`, async () => {
      const re = await PDFDocument.load(bytes, { updateMetadata: false });
      const r2 = await applyPdfx4(re, { icc, title: c.title, boxes: c.boxes, blend: c.blend, now: new Date(NOW.getTime() + 60000) });
      assert.deepEqual(r2.violations, []);
      assert.equal(r2.fixed, 0);
      assert.equal((re.catalog.lookup(N('OutputIntents')) as PDFArray).size(), 1);
      const again = await savePdfx4(re);
      // ほぼ同じ大きさ(ICC などを増やしていない)
      assert.ok(Math.abs(again.length - bytes.length) < 20000, `${bytes.length} → ${again.length}`);
    });
  }

  // Ghostscript を通さない、元の PDF(ヘッダ 1.4・/ID なし・リンクの注釈つきの Chrome の本文、PDF 1.7・相互参照ストリームつきの表紙)。
  // ヘッダ・/ID・リンク・空の /Annots [] の始末を、色の変換と切り離して確かめる(色は RGB のままなので、残りは RGB だけのはず)
  console.log('\nGhostscript を通さない元の PDF');
  for (const [file, kind, links] of [
    ['sakura-shinsho.pdf', 'body', 10],
    ['cover-color.pdf', 'cover', 0],
  ] as const) {
    const src = new Uint8Array(readFileSync(join(fixtures, file)));
    const doc = await PDFDocument.load(src, { updateMetadata: false });
    const hadId = !!doc.context.trailerInfo.ID;
    const srcHead = Buffer.from(src.subarray(0, 8)).toString('latin1');
    const m = doc.getPage(0).getMediaBox();
    // 用紙の大きさは実物から逆算した設定(さくらの新書は判型が分からないので、実物に合わせる)
    const r1 = (v: number) => Math.round(v * 100) / 100;
    const b: PressBoxes =
      kind === 'body'
        ? { kind: 'body', trimW: r1(m.width / MM - 3.2), trimH: r1(m.height / MM - 6.4), bleedTop: 3.2, bleedBottom: 3.2, bleedFore: 3.2, bleedGutter: 0, firstGutter: 'right' }
        : { kind: 'cover', trimW: 297.9, trimH: 210, bleed: 3.2 };
    const r = await applyPdfx4(doc, { icc, title: file, boxes: b, blend: 'DeviceCMYK', now: NOW });
    const bytes = await savePdfx4(doc);
    writeFileSync(join(out, `raw-${file.replace('.pdf', '')}-x4.pdf`), bytes);
    console.log(`       ${file}: 元のヘッダ ${srcHead}・/ID ${hadId ? 'あり' : 'なし'} → fixed ${r.fixed} ${JSON.stringify(r.detail)}`);
    console.log(`       violations ${JSON.stringify(r.violations)}`);
    await test(`${file}: ヘッダ 1.6・/ID を作る・相互参照は表・リンク ${links} 個を外す・残る違反は RGB だけ`, () => {
      const text = Buffer.from(bytes).toString('latin1');
      assert.equal(text.slice(0, 8), '%PDF-1.6');
      assert.ok(/\/ID\s*\[/.test(text.slice(-600)));
      assert.ok(!/\/Type\s*\/XRef\b/.test(text));
      assert.equal(r.detail.annots, links);
      assert.ok(!text.includes('/URI'));
      assert.ok(r.violations.length > 0 && r.violations.every((v) => v.startsWith('RGB の色が残っています')), r.violations.join('\n'));
    });
  }
}

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} 件通った・${failed.length} 件落ちた`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
