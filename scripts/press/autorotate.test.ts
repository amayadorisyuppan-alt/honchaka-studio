// 入稿用の変換が、ページを回さないことの検査(2026-10-02)。`node scripts/press/autorotate.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 縦組みの本で、欧文だけが寝かせて組まれたページ(書名が「long」だけの大扉など)を、Ghostscript の pdfwrite は既定
// `-dAutoRotatePages=/PageByPage` で /Rotate 270 にしてしまい、そのページの TrimBox・BleedBox が付かず X-4 から外れた。
// 1. gsArgs が3種類とも `-dAutoRotatePages=/None` を含む(依存なし)
// 2. 実物の検査は、置き場を環境変数 PRESS_FIXTURES で渡し、PRESS_GS=1 のときだけ回る(Ghostscript を通すので数秒〜)。
//      PRESS_GS=1 PRESS_FIXTURES=<title-p1.pdf と title-p1-6.pdf のあるフォルダ> node scripts/press/autorotate.test.ts
//    どちらも 文庫 105×148mm(塗り足し四辺 3mm)の本文として、白黒(body-gray)で通し、出力の全ページに /Rotate が無く TrimBox がある。
//    1本ごとに run.ts を別のプロセスで起こす(同じプロセスで Ghostscript を作り直すと落ちることがある。e2e.test.ts と同じ理由)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName } from 'pdf-lib';
import { gsArgs } from '../../src/press/pipeline.ts';
import type { PressKind } from '../../src/press/pipeline.ts';

const here = dirname(fileURLToPath(import.meta.url));

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

console.log('gsArgs');
for (const kind of ['body-gray', 'body-cmyk', 'cover-cmyk'] as PressKind[]) {
  await test(`${kind}: -dAutoRotatePages=/None を1つだけ含む(入力・出力の指定より前)`, () => {
    const a = gsArgs(kind);
    assert.equal(a.filter((x) => x === '-dAutoRotatePages=/None').length, 1);
    assert.ok(a.indexOf('-dAutoRotatePages=/None') < a.indexOf('-sOutputFile=/work/out.pdf'));
    assert.ok(!a.some((x) => x.startsWith('-dAutoRotatePages=') && x !== '-dAutoRotatePages=/None'));
  });
}

console.log('\n実物');
const fixturesEnv = process.env.PRESS_FIXTURES;
if (process.env.PRESS_GS !== '1' || !fixturesEnv) {
  console.log('  [飛ばした] PRESS_GS=1 と PRESS_FIXTURES(title-p1.pdf などのあるフォルダ)が両方あるときだけ、Ghostscript を通す実物の検査を回す');
} else {
  const fixtures = resolve(fixturesEnv);
  const outDir = resolve(fixtures, '../out/autorotate');
  mkdirSync(outDir, { recursive: true });
  for (const file of ['title-p1.pdf', 'title-p1-6.pdf']) {
    const input = join(fixtures, file);
    if (!existsSync(input)) {
      console.log(`  [飛ばした] ${file} が無い`);
      continue;
    }
    await test(`${file}: 白黒の本文として通すと、全ページに /Rotate が無く TrimBox・BleedBox がある`, async () => {
      const out = join(outDir, file);
      const run = spawnSync(
        process.execPath,
        [join(here, 'run.ts'), '--kind', 'body-gray', '--in', input, '--out', out, '--trim', '105x148', '--bleed', '3,3,3,3', '--first-gutter', 'right', '--title', '検査'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      assert.equal(run.status, 0, `変換できなかった(終了コード ${run.status})\n${(run.stderr || '').slice(0, 800)}`);
      const before = await PDFDocument.load(readFileSync(input), { updateMetadata: false });
      const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      assert.equal(doc.getPageCount(), before.getPageCount());
      doc.getPages().forEach((p, i) => {
        assert.equal(p.node.lookup(PDFName.of('Rotate')), undefined, `${i + 1} ページ目に /Rotate がある`);
        assert.ok(p.node.lookup(PDFName.of('TrimBox')), `${i + 1} ページ目に TrimBox が無い`);
        assert.ok(p.node.lookup(PDFName.of('BleedBox')), `${i + 1} ページ目に BleedBox が無い`);
      });
    });
  }
}

console.log(`\n${passed} 件通った・${failed.length} 件落ちた`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
