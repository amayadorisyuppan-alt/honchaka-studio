// runPress の job.grayTone(グレーの濃さの直しを呼ぶ側で切る)の検査(2026-10-02)。`node scripts/press/grayToneOption.test.ts` で回る。
// 偽の Ghostscript(入力をそのまま返す)で runPress を通し、K だけのグレーの値が直るか・直らないかを見る。依存なし。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName } from 'pdf-lib';
import { contentHolders } from '../../src/press/content.ts';
import { runPress } from '../../src/press/pipeline.ts';
import type { GsModule, PressDeps, PressJob, PressKind } from '../../src/press/pipeline.ts';
import type { BodyBoxes } from '../../src/press/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ICC = new Uint8Array(readFileSync(resolve(here, '../../src/press/JapanColor2011Coated.icc')));

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

const A5: BodyBoxes = { kind: 'body', trimW: 148, trimH: 210, bleedTop: 3.2, bleedBottom: 3.2, bleedFore: 3.2, bleedGutter: 0, firstGutter: 'right' };
const PAPER_PT: [number, number] = [((148 + 3.2) * 72) / 25.4, ((210 + 6.4) * 72) / 25.4];

/** 0.5 のグレーで塗る1ページ(直ると 0.33333 になる。grayTone.test.ts と同じ値) */
async function grayPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const page = d.addPage(PAPER_PT);
  const ctx = d.context;
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(new TextEncoder().encode('0.5 g 0 0 10 10 re f'))));
  return d.save({ useObjectStreams: false });
}

/** 入力をそのまま出力に返す偽の Ghostscript */
const echoGs: PressDeps['createGs'] = async (onLine) => {
  const files = new Map<string, Uint8Array>();
  const mod: GsModule = {
    callMain() {
      onLine('Processing pages 1 through 1.');
      onLine('Page 1');
      files.set('/work/out.pdf', files.get('/work/in.pdf') ?? new Uint8Array(0));
      return 0;
    },
    FS: {
      mkdir() {},
      writeFile(p, d) {
        files.set(p, d);
      },
      readFile(p) {
        const f = files.get(p);
        if (!f) throw new Error(`ENOENT ${p}`);
        return f;
      },
      unlink(p) {
        files.delete(p);
      },
    },
  };
  return mod;
};

async function run(kind: PressKind, over: Partial<PressJob>) {
  const job: PressJob = { kind, pdf: await grayPdf(), boxes: A5, title: '検査', inkLimit: 300, now: new Date('2026-10-02T00:00:00Z'), ...over };
  const r = await runPress(job, { createGs: echoGs, loadIcc: async () => ICC });
  const doc = await PDFDocument.load(r.pdf, { updateMetadata: false });
  const hs = await contentHolders(doc);
  const text = Buffer.from(hs[0].bytes).toString('latin1');
  return { r, text };
}

for (const kind of ['body-gray', 'body-cmyk'] as PressKind[]) {
  await test(`${kind}: grayTone を省くと今までどおり直る(0.5 → 0.33333・toneApplied=true)`, async () => {
    const { r, text } = await run(kind, {});
    assert.ok(text.includes('0.33333 g'), text);
    assert.equal(r.toneApplied, true);
    assert.equal(r.tone?.ops, 1);
  });
  await test(`${kind}: grayTone: true でも直る`, async () => {
    const { r, text } = await run(kind, { grayTone: true });
    assert.ok(text.includes('0.33333 g'), text);
    assert.equal(r.toneApplied, true);
  });
  await test(`${kind}: grayTone: false だと直らない(0.5 のまま・toneApplied=false・tone=null)`, async () => {
    const { r, text } = await run(kind, { grayTone: false });
    assert.ok(text.includes('0.5 g') && !text.includes('0.33333'), text);
    assert.equal(r.toneApplied, false);
    assert.equal(r.tone, null);
  });
}

console.log(`\n${passed} 件通った・${failed.length} 件落ちた`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
