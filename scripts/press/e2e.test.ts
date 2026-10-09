// 入稿用の変換(src/press/pipeline.ts)を、実物の PDF で3種類とも通しで確かめる。
//   PRESS_FIXTURES=<color-a5.pdf などのあるフォルダ> node scripts/press/e2e.test.ts
// (終了コード 0=全部通った / 1=落ちた。PRESS_FIXTURES が無ければ「飛ばした」と表示して 0 で終わる)
//
// 1. 実物を通す: color-a5 → body-cmyk、mono-bunko → body-gray、sakura-shinsho → body-gray と body-cmyk、cover-color → cover-cmyk。
//    **1本ごとに scripts/press/run.ts を別のプロセスで起こす。** 同じ Node のプロセスで Ghostscript を3回続けて作り直すと、
//    3回目が「No such file or directory」で落ちることがある(2026-10-01 pdfx の担当が踏んだ。製品は Worker を使い捨てるので起きない)
// 2. スタジオのコードとは別の道具 scripts/check-press.py(PyMuPDF・pypdf)に、**全項目**をかけて、終了コード 0 を確かめる
// 3. 報告の数字を表示する: かかった時間・出力の大きさ・インクの最大(前・後)・カラーのページ・issues
// 出力は <PRESS_FIXTURES>/../out/e2e/ に置く(リポジトリには入れない)。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const fixturesEnv = process.env.PRESS_FIXTURES;
if (!fixturesEnv) {
  console.log('飛ばした: 環境変数 PRESS_FIXTURES(color-a5.pdf などのあるフォルダ)が無いので、実物の通しの検査は回していません');
  process.exit(0);
}
const fixtures = resolve(fixturesEnv);
const outDir = resolve(fixtures, '../out/e2e');
mkdirSync(outDir, { recursive: true });
const ICC = join(repo, 'src/press/JapanColor2011Coated.icc');

/** run.ts が出す報告(pdf 以外) */
interface Report {
  pages: number;
  pageMm: { w: number; h: number } | null;
  neutral: { ops: number; shadings: number; images: number; skipped: string[] } | null;
  ink: { limit: number; maxBefore: number; maxAfter: number; images: number; ops: number; shadings: number; unhandled: string[] } | null;
  pdfx: { fixed: number; violations: string[] };
  issues: string[];
  colorPages: number[];
  ms: number;
  bytes: number;
  rssMB: number;
  rssPeakMB?: number;
  phases: { phase: string; at: number }[];
}

interface Case {
  name: string;
  file: string;
  kind: 'body-gray' | 'body-cmyk' | 'cover-cmyk';
  trim: string;
  bleed: string;
  firstGutter?: 'left' | 'right';
}

const A5 = { trim: '148x210', bleed: '3.2,3.2,3.2,0', firstGutter: 'right' as const };
const BUNKO = { trim: '105x148', bleed: '3.2,3.2,3.2,0', firstGutter: 'right' as const };
const cases: Case[] = [
  { name: 'color-a5', file: 'color-a5.pdf', kind: 'body-cmyk', ...A5 },
  { name: 'mono-bunko', file: 'mono-bunko.pdf', kind: 'body-gray', ...BUNKO },
  { name: 'sakura-gray', file: 'sakura-shinsho.pdf', kind: 'body-gray', ...BUNKO },
  // カラーの本を白黒の変換に通す(画面は白黒の本にしか出さないが、確かめ用に)。Ghostscript の出力のページ 9 が、pdf-lib で開くと
  // 1バイト欠けて「読めないページ」になった(2-3 の 1。repair.ts で直した)。issues が空=読めないページが 0
  { name: 'color-a5-gray', file: 'color-a5.pdf', kind: 'body-gray', ...A5 },
  { name: 'sakura-cmyk', file: 'sakura-shinsho.pdf', kind: 'body-cmyk', ...BUNKO },
  // 表紙: MediaBox 862.6031×613.4173pt = 304.31×216.40mm、塗り足し四辺 3.2mm → 仕上がり 297.91×210
  { name: 'cover', file: 'cover-color.pdf', kind: 'cover-cmyk', trim: '297.91x210', bleed: '3.2,3.2,3.2,3.2' },
];

/** color-a5.pdf の、画像の無い「文字だけのページ」(SPEC.md 4)。カラーのページに入ってはいけない */
const TEXT_ONLY_A5 = [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 29, 30, 31, 32];

let passed = 0;
const failed: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

/** ページの注釈(リンクなど)の数 */
async function annotCount(file: string): Promise<number> {
  const doc = await PDFDocument.load(readFileSync(file), { updateMetadata: false });
  let n = 0;
  for (const p of doc.getPages()) {
    const a = p.node.lookup(PDFName.of('Annots'));
    if (a instanceof PDFArray) n += a.size();
  }
  return n;
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

for (const c of cases) {
  const input = join(fixtures, c.file);
  if (!existsSync(input)) {
    console.log(`\n${c.name}: 飛ばした(${c.file} が無い)`);
    continue;
  }
  const out = join(outDir, `${c.name}.pdf`);
  console.log(`\n${c.name}(${c.kind}) ← ${c.file}`);

  // 1. 変換(別のプロセス)
  const runArgs = [
    join(here, 'run.ts'),
    '--kind', c.kind,
    '--in', input,
    '--out', out,
    '--trim', c.trim,
    '--bleed', c.bleed,
    '--title', 'サンプル',
    '--ink-limit', '300',
  ];
  if (c.firstGutter) runArgs.push('--first-gutter', c.firstGutter);
  const run = spawnSync(process.execPath, runArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    failed.push(`${c.name}: 変換`);
    console.log(`  FAIL 変換できなかった(終了コード ${run.status})\n${(run.stderr || '').split('\n').slice(0, 12).join('\n')}`);
    continue;
  }
  const r = JSON.parse(run.stdout) as Report;
  console.log(
    `  時間 ${(r.ms / 1000).toFixed(1)} 秒 / 出力 ${mb(r.bytes)} / ${r.pages} ページ` +
      (r.ink ? ` / インク最大 ${r.ink.maxBefore.toFixed(1)}% → ${r.ink.maxAfter.toFixed(1)}%(上限 ${r.ink.limit}%・書き換え 画像${r.ink.images} 命令${r.ink.ops} 影${r.ink.shadings}・測れなかった ${r.ink.unhandled.length})` : ''),
  );
  if (r.neutral) console.log(`  無彩色をグレーへ: 命令 ${r.neutral.ops}・影 ${r.neutral.shadings}・画像 ${r.neutral.images}(調べられなかった ${r.neutral.skipped.length})`);
  console.log(`  X-4 の形: 直したところ ${r.pdfx.fixed}・合わない所 ${r.pdfx.violations.length}`);
  console.log(`  カラーのページ(${r.colorPages.length}): ${r.colorPages.join(',') || 'なし'}`);
  console.log(`  issues(${r.issues.length}): ${r.issues.join(' / ') || 'なし'}`);

  // 2. 独立の検査(全項目)
  const py = ['scripts/check-press.py', '--kind', c.kind, '--orig', input, '--out', out, '--trim', c.trim, '--bleed', c.bleed, '--icc', ICC, '--quiet'];
  if (c.firstGutter) py.push('--first-gutter', c.firstGutter);
  if (c.kind !== 'body-gray') py.push('--ink-limit', '300');
  const chk = spawnSync('python', py, { cwd: repo, encoding: 'utf8', env: pyEnv, maxBuffer: 64 * 1024 * 1024 });
  const summary = (chk.stdout || '').split('--- まとめ ---')[1] ?? chk.stdout ?? chk.stderr ?? '';
  console.log('  check-press.py(全項目):');
  for (const line of summary.split('\n').filter((l) => l.trim())) console.log(`    ${line.trim()}`);
  const notes = (chk.stdout || '').split('\n').filter((l) => /^\s*(\?\?|\*)/.test(l));
  for (const n of notes.slice(0, 6)) console.log(`    ${n.trim()}`);

  check(`${c.name}: check-press.py が全項目通る(終了コード 0)`, () => {
    assert.equal(chk.status, 0, `終了コード ${chk.status}\n${(chk.stdout || '').slice(-1500)}${chk.stderr || ''}`);
  });

  // 3. 数字の確かめ
  check(`${c.name}: 先頭が %PDF-1.6`, () => {
    assert.equal(readFileSync(out).subarray(0, 8).toString('latin1'), '%PDF-1.6');
  });
  check(`${c.name}: issues が空・X-4 に合わない所が無い`, () => {
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.pdfx.violations, []);
  });
  check(`${c.name}: 段が load → prepare → convert → finish → check の順に1度ずつ(load に戻らない)`, () => {
    assert.deepEqual(
      r.phases.map((p) => p.phase),
      ['load', 'prepare', 'convert', 'finish', 'check'],
    );
  });
  if (r.ink) {
    const ink = r.ink;
    check(`${c.name}: インクの最大が上限以下で、測れなかった所が無い`, () => {
      assert.ok(ink.maxAfter <= ink.limit + 1e-6, `maxAfter ${ink.maxAfter}`);
      assert.deepEqual(ink.unhandled, []);
    });
  }
  if (c.kind === 'body-gray') {
    check(`${c.name}: 白黒の本はカラーのページが無い`, () => assert.deepEqual(r.colorPages, []));
  }
  if (c.name === 'color-a5') {
    check('color-a5: 文字だけの 15 ページがカラーのページに入っていない', () => {
      const hit = TEXT_ONLY_A5.filter((p) => r.colorPages.includes(p));
      assert.deepEqual(hit, []);
      assert.ok(r.colorPages.length > 0, '絵のページがカラーに数えられていない');
    });
  }
  if (c.name === 'sakura-cmyk' || c.name === 'sakura-gray') {
    const before = await annotCount(input);
    const after = await annotCount(out);
    check(`${c.name}: リンク ${before} 個 → ${after} 個`, () => {
      assert.equal(before, 10, '元の PDF のリンクが 10 個ではない');
      assert.equal(after, 0);
    });
  }
  if (c.kind === 'cover-cmyk') {
    check('cover: カラーのページは 1 ページ目', () => assert.deepEqual(r.colorPages, [1]));
  }
}

console.log(`\n通った ${passed} 件 / 落ちた ${failed.length} 件`);
if (failed.length) {
  console.log('落ちたもの:\n  ' + failed.join('\n  '));
  process.exit(1);
}
