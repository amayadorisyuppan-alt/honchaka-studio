// 入稿用の変換を、Node から1本だけ通す道具。製品の Worker(src/press/gsWorker.ts)と同じ runPress を呼ぶ。
//
//   node scripts/press/run.ts --kind body-cmyk --in a.pdf --out b.pdf --trim 148x210 --bleed 3.2,3.2,3.2,0 \
//        --first-gutter right --title 題 [--ink-limit 300] [--no-gray-tone] [--report r.json]
//
// - --kind: body-gray(白黒の本文)/ body-cmyk(カラーの本文)/ cover-cmyk(表紙)
// - --trim: 仕上がり(塗り足しを除く)幅x高さ mm。--bleed: 天,地,小口,ノド mm(表紙は1つか4つで、四辺とも同じ幅)
// - 報告(pdf 以外)を JSON で標準出力へ出す。--report を渡せばファイルにも書く。rssMB は終わった時点、rssPeakMB は途中の最大(メモリの実測用)
//
// Ghostscript は 1 回の実行ごとに作り直す(C の中の状態は2回目を想定していない)。
// 同じ Node のプロセスで続けて何本も通さず、1本ごとにこの道具を別のプロセスで起こすこと(e2e.test.ts はそうしている)。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PressError, runPress } from '../../src/press/pipeline.ts';
import type { GsModule, PressKind } from '../../src/press/pipeline.ts';
import type { PressBoxes } from '../../src/press/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ICC = resolve(here, '../../src/press/JapanColor2011Coated.icc');

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`引数が読めません: ${a}`);
    if (a === '--no-gray-tone') {
      out['no-gray-tone'] = '1';
      continue;
    }
    out[a.slice(2)] = argv[++i] ?? '';
  }
  return out;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const kind = args.kind as PressKind;
if (!['body-gray', 'body-cmyk', 'cover-cmyk'].includes(kind)) die('--kind は body-gray / body-cmyk / cover-cmyk のどれか');
if (!args.in || !args.out) die('--in と --out が要ります');
const trim = /^([\d.]+)x([\d.]+)$/.exec(args.trim ?? '');
if (!trim) die('--trim は 148x210 の形で');
const bleed = (args.bleed ?? '').split(',').map(Number);
if (bleed.length === 0 || bleed.some((n) => !Number.isFinite(n))) die('--bleed は 3.2,3.2,3.2,0 の形で(表紙は 3.2 でも可)');

let boxes: PressBoxes;
if (kind === 'cover-cmyk') {
  boxes = { kind: 'cover', trimW: Number(trim![1]), trimH: Number(trim![2]), bleed: bleed[0] };
} else {
  if (bleed.length !== 4) die('本文の --bleed は 天,地,小口,ノド の4つ');
  const gutter = args['first-gutter'];
  if (gutter !== 'left' && gutter !== 'right') die('--first-gutter は left か right');
  boxes = {
    kind: 'body',
    trimW: Number(trim![1]),
    trimH: Number(trim![2]),
    bleedTop: bleed[0],
    bleedBottom: bleed[1],
    bleedFore: bleed[2],
    bleedGutter: bleed[3],
    firstGutter: gutter,
  };
}

const t0 = performance.now();
const phases: { phase: string; at: number }[] = [];
let lastPage = 0;
try {
  const result = await runPress(
    {
      kind,
      pdf: new Uint8Array(readFileSync(args.in)),
      boxes,
      title: args.title ?? '無題',
      inkLimit: args['ink-limit'] ? Number(args['ink-limit']) : 300,
      grayTone: args['no-gray-tone'] ? false : undefined,
      now: new Date(),
    },
    {
      async createGs(onLine): Promise<GsModule> {
        const factory = (await import('@okathira/ghostpdl-wasm')).default as unknown as (o: Record<string, unknown>) => Promise<GsModule>;
        return factory({ noInitialRun: true, print: onLine, printErr: onLine });
      },
      async loadIcc() {
        return new Uint8Array(readFileSync(ICC));
      },
      onPhase: (phase) => phases.push({ phase, at: Math.round(performance.now() - t0) }),
      onProgress: (page) => {
        lastPage = page;
      },
    },
  );
  writeFileSync(args.out, result.pdf);
  const { pdf, ...report } = result;
  const text = JSON.stringify(
    { ...report, bytes: pdf.byteLength, lastGsPage: lastPage, phases, rssMB: Math.round(process.memoryUsage().rss / 1048576), rssPeakMB: Math.round(process.resourceUsage().maxRSS / 1024) },
    null,
    2,
  );
  if (args.report) writeFileSync(args.report, text);
  console.log(text);
} catch (e) {
  // 画面に出る文(message)と、開発者向けの詳細(log。英語の生のエラー・Ghostscript の出力の末尾)を分けて出す
  console.error(`失敗: ${(e as Error).message}${e instanceof PressError ? `（原因: ${e.origin}）` : ''}`);
  if (e instanceof PressError && e.log) console.error('--- 詳細(開発者向け) ---\n' + e.log);
  else if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
}
