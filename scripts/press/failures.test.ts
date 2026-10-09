// 入稿用の変換(src/press/pipeline.ts)の「失敗のしかた」の検査。`node scripts/press/failures.test.ts` で回る(終了コード 0=全部通った / 1=落ちた)。
//
// 2026-10-01 崩しにいって読んだ人(reports/2-3.md)が見つけた穴を、1つずつ再現して塞いだ印:
//   - Ghostscript は、読めなかった PDF(空・途中で切れた・パスワード付き)にも終了コード 0 で白紙の 1 ページを出す。
//     それが「できました」になって、白紙の PDF が自動で保存されていた
//   - PostScript(`%!PS`)で始まるファイルを .pdf として渡すと、Ghostscript が実行してしまう(終わらないこともある)
//   - 道具の読み込みの失敗で、英語の生のエラーが利用者に出て、しかも「選んだファイルのせい」と言われていた
//   - `**** Error`・`Page drawing error`・代わりの書体への置き換えは、ログには出るのに利用者に届いていなかった
// Ghostscript は本物を動かすと重いので、deps を差し替えて、出力する行・終了コード・書き出す PDF を注入する。
// (本物の Ghostscript での確かめは e2e.test.ts と、Ghostscript の本物のログを写した行を流す下の検査)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString } from 'pdf-lib';
import { PressError, runPress } from '../../src/press/pipeline.ts';
import type { GsModule, PressDeps, PressJob, PressKind, PressPhase } from '../../src/press/pipeline.ts';
import type { BodyBoxes } from '../../src/press/types.ts';
import { failureText, inkSentence, issueLines, originOf, paperMismatchText, progressRatio, progressText, savedHeadline } from '../../src/components/pressText.ts';
import { mmText, paperSizeText } from '../../src/press/paper.ts';

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

// ───────────────────────── 材料 ─────────────────────────

const A5: BodyBoxes = { kind: 'body', trimW: 148, trimH: 210, bleedTop: 3.2, bleedBottom: 3.2, bleedFore: 3.2, bleedGutter: 0, firstGutter: 'right' };
/** A5 + 塗り足しの名目の用紙(pt)。これと同じ大きさの PDF なら、紙の大きさの指摘が出ない */
const PAPER_PT: [number, number] = [((148 + 3.2) * 72) / 25.4, ((210 + 6.4) * 72) / 25.4];

async function pdfOfPages(n: number): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage(PAPER_PT);
  return d.save({ useObjectStreams: false });
}

/** 暗号化された PDF(の trailer だけ真似たもの)。pdf-lib は /Encrypt があれば開かない */
function encryptedPdf(): Uint8Array {
  const s =
    '%PDF-1.4\n' +
    '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n' +
    '2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n' +
    '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>\nendobj\n' +
    '4 0 obj\n<</Filter/Standard/V 1/R 2/P -4/O(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)/U(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)>>\nendobj\n' +
    'trailer\n<</Root 1 0 R/Size 5/Encrypt 4 0 R>>\n%%EOF\n';
  return new TextEncoder().encode(s);
}

const text = (s: string) => new TextEncoder().encode(s);

interface FakeGs {
  /** 標準出力へ流す行。省略すると「Processing pages 1 through <入力のページ数>.」と「Page n」 */
  lines?: string[];
  /** callMain の戻り値。省略は 0 */
  exit?: number;
  /** callMain が投げるもの */
  throws?: unknown;
  /** out.pdf に書くもの。'echo' は入力そのまま。null は書かない */
  out?: 'echo' | Uint8Array | null;
  /** callMain の引数の記録先 */
  args?: string[][];
}

function fakeGs(o: FakeGs): PressDeps['createGs'] {
  return async (onLine) => {
    const files = new Map<string, Uint8Array>();
    const mod: GsModule = {
      callMain(args) {
        o.args?.push(args);
        let lines = o.lines;
        if (!lines) {
          // 入力のページ数ぶん、本物と同じ行を流す
          const n = pagesIn(files.get('/work/in.pdf'));
          lines = [`Processing pages 1 through ${n}.`, ...Array.from({ length: n }, (_, i) => `Page ${i + 1}`)];
        }
        for (const l of lines) onLine(l);
        if (o.throws !== undefined) throw o.throws;
        if (o.out === 'echo' || o.out === undefined) files.set('/work/out.pdf', files.get('/work/in.pdf') ?? new Uint8Array(0));
        else if (o.out) files.set('/work/out.pdf', o.out);
        return o.exit ?? 0;
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
}

/** 偽の Ghostscript に渡った入力のページ数(PDF のなかの /Type /Page の数を数えるだけ。pdf-lib で作った素直な PDF 用) */
function pagesIn(bytes: Uint8Array | undefined): number {
  if (!bytes) return 0;
  const s = new TextDecoder('latin1').decode(bytes);
  return (s.match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length;
}

function job(kind: PressKind, pdf: Uint8Array, over: Partial<PressJob> = {}): PressJob {
  return { kind, pdf, boxes: A5, title: '検査', inkLimit: 300, now: new Date('2026-10-01T00:00:00Z'), ...over };
}

function deps(gs: FakeGs, over: Partial<PressDeps> = {}): PressDeps {
  return { createGs: fakeGs(gs), loadIcc: async () => ICC, ...over };
}

/** runPress が PressError で失敗することを確かめて、その PressError を返す */
async function failure(p: Promise<unknown>): Promise<PressError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PressError, `PressError ではない: ${String((e as Error)?.stack ?? e).slice(0, 200)}`);
    return e;
  }
  assert.fail('失敗するはずが、成功した');
}

/** 利用者に見せる文に、英語の生のエラーが混じっていない */
function noRawEnglish(message: string) {
  assert.ok(
    !/(Failed|Error|Aborted|fetch|undefined|RuntimeError|CompileError|Unrecoverable|memory access|TypeError|ENOENT|exit code|encrypted)/i.test(message),
    `英語が混じっている: ${message}`,
  );
}

// ───────────────────────── 1. 入口の点検 ─────────────────────────

console.log('入口の点検(PDF でないもの・暗号化・インクの上限)');

const NOT_PDF = 'PDF ではないファイルです';
for (const kind of ['body-gray', 'body-cmyk', 'cover-cmyk'] as const) {
  await test(`${kind}: 0 バイトのファイルは「${NOT_PDF}」で失敗(file)・Ghostscript は動かさない`, async () => {
    const args: string[][] = [];
    const e = await failure(runPress(job(kind, new Uint8Array(0)), deps({ args })));
    assert.equal(e.message, NOT_PDF);
    assert.equal(e.origin, 'file');
    assert.equal(args.length, 0, 'Ghostscript を動かしてはいけない');
  });
}

await test('テキストファイル・PostScript(%!PS)は「PDF ではないファイルです」で失敗し、Ghostscript は動かさない', async () => {
  for (const body of ['こんにちは。これは PDF ではありません\n', '%!PS\n{} loop\n', '%!PS-Adobe-3.0\n/Helvetica findfont 12 scalefont setfont showpage\n']) {
    for (const kind of ['body-gray', 'body-cmyk'] as const) {
      const args: string[][] = [];
      const e = await failure(runPress(job(kind, text(body)), deps({ args })));
      assert.equal(e.message, NOT_PDF, body.slice(0, 12));
      assert.equal(e.origin, 'file');
      assert.equal(args.length, 0);
    }
  }
});

await test('%PDF- が先頭 1KB より後にあるファイル・先頭が %! の「PDF と PostScript の合いの子」も失敗(Ghostscript に実行させない)', async () => {
  const late = new Uint8Array(2000 + 20);
  late.fill(0x20);
  late.set(text('%PDF-1.4\n'), 2000);
  const e1 = await failure(runPress(job('body-gray', late), deps({})));
  assert.equal(e1.message, NOT_PDF);
  const polyglot = text('%!PS\n%PDF-1.4\n{} loop\n');
  const e2 = await failure(runPress(job('body-gray', polyglot), deps({})));
  assert.equal(e2.message, NOT_PDF);
});

await test('先頭の 1KB 以内なら、前にごみ(空行など)があっても PDF と見なす', async () => {
  const body = await pdfOfPages(1);
  const junk = new Uint8Array(300 + body.length);
  junk.fill(0x0a, 0, 300);
  junk.set(body, 300);
  const r = await runPress(job('body-gray', junk), deps({}));
  assert.equal(r.pages, 1);
});

const ENCRYPTED = 'パスワードや編集の制限がかかっています。印刷の画面で保存した、元の本文 PDF を選んでください';
for (const kind of ['body-gray', 'body-cmyk'] as const) {
  await test(`${kind}: /Encrypt を持つ PDF は同じ文「${ENCRYPTED.slice(0, 12)}…」で失敗(file)`, async () => {
    const args: string[][] = [];
    const e = await failure(runPress(job(kind, encryptedPdf()), deps({ args })));
    assert.equal(e.message, ENCRYPTED);
    assert.equal(e.origin, 'file');
    noRawEnglish(e.message);
  });
}

await test('インクの上限が NaN・0・負・Infinity・undefined のカラー変換は、変換を始める前に失敗(測るだけの変換になって「問題なし」と言わない)', async () => {
  const body = await pdfOfPages(1);
  for (const bad of [Number.NaN, 0, -300, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
    for (const kind of ['body-cmyk', 'cover-cmyk'] as const) {
      const args: string[][] = [];
      const e = await failure(runPress(job(kind, body.slice(), { inkLimit: bad }), deps({ args })));
      assert.match(e.message, /インク/, String(bad));
      assert.equal(args.length, 0);
      noRawEnglish(e.message);
    }
  }
});

await test('白黒の変換は、インクの上限を使わないので、上限が NaN でも失敗しない', async () => {
  const r = await runPress(job('body-gray', await pdfOfPages(1), { inkLimit: Number.NaN }), deps({}));
  assert.equal(r.pages, 1);
});

await test('pdf-lib が読めない壊れ方(中身が空のページ木)の PDF は、body-gray でも body-cmyk でも同じ「PDF として読めませんでした」(file)', async () => {
  const broken = text('%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer\n<</Root 1 0 R/Size 2>>\n%%EOF\n');
  for (const kind of ['body-gray', 'body-cmyk'] as const) {
    const e = await failure(runPress(job(kind, broken.slice()), deps({})));
    assert.match(e.message, /^PDF として読めませんでした/);
    assert.equal(e.origin, 'file');
    noRawEnglish(e.message);
  }
});

// ───────────────────────── 1.5 入口で断る(変換済みの PDF・紙の大きさ) ─────────────────────────

console.log('入口で断る(変換済み・紙の大きさ)');

const ALREADY = 'すでに入稿用に変えた PDF です。印刷の画面で保存した、元の本文 PDF を選んでください';

/** XMP だけに PDF/X の印がある PDF(ほかの道具が作った PDF/X の形) */
async function xmpOnlyPdfx(version: string): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage(PAPER_PT);
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"><pdfxid:GTS_PDFXVersion>${version}</pdfxid:GTS_PDFXVersion></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const meta = d.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  d.catalog.set(PDFName.of('Metadata'), d.context.register(meta));
  return d.save({ useObjectStreams: false });
}

/** OutputIntent(/S /GTS_PDFX)だけを持つ PDF */
async function intentOnlyPdfx(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage(PAPER_PT);
  const intent = d.context.obj({ Type: 'OutputIntent', S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('FOGRA39') });
  d.catalog.set(PDFName.of('OutputIntents'), d.context.obj([d.context.register(intent)]));
  return d.save({ useObjectStreams: false });
}

for (const kind of ['body-gray', 'body-cmyk', 'cover-cmyk'] as const) {
  await test(`${kind}: スタジオが入稿用に変えた PDF をもう一度選ぶと「すでに入稿用に変えた PDF です…」で断る(file)・Ghostscript は動かさない`, async () => {
    const first = await runPress(job(kind, await pdfOfPages(2)), deps({}));
    const args: string[][] = [];
    const e = await failure(runPress(job(kind, first.pdf.slice()), deps({ args })));
    assert.equal(e.message, ALREADY);
    assert.equal(e.origin, 'file');
    assert.equal(e.complete, true, '助言が文に入っているので、画面は「選んだファイルを確かめて」を足さない');
    assert.equal(args.length, 0, 'Ghostscript を動かしてはいけない(動かすとグレーが2度濃くなる)');
    noRawEnglish(e.message);
  });
}

await test('ほかの道具が作った PDF/X(XMP の pdfxid・OutputIntent の GTS_PDFX だけ)も同じ扱いで断る', async () => {
  for (const [name, bytes] of [
    ['XMP の PDF/X-4', await xmpOnlyPdfx('PDF/X-4')],
    ['XMP の PDF/X-1a', await xmpOnlyPdfx('PDF/X-1a:2001')],
    ['OutputIntent', await intentOnlyPdfx()],
  ] as const) {
    const args: string[][] = [];
    const e = await failure(runPress(job('body-gray', bytes.slice()), deps({ args })));
    assert.equal(e.message, ALREADY, name);
    assert.equal(args.length, 0, name);
  }
});

await test('入稿用の印の無い PDF(pdf-lib が作った素直な PDF)は、これまでどおり変換できる', async () => {
  const r = await runPress(job('body-gray', await pdfOfPages(2)), deps({}));
  assert.equal(r.pages, 2);
});

await test('紙の大きさが違う PDF は、Ghostscript を動かさずに断る(file)。値(paperMismatch)で返る・どの kind でも', async () => {
  const d = await PDFDocument.create();
  d.addPage([300, 400]);
  const wrong = await d.save({ useObjectStreams: false });
  for (const kind of ['body-gray', 'body-cmyk'] as const) {
    const args: string[][] = [];
    const phases: PressPhase[] = [];
    const e = await failure(runPress(job(kind, wrong.slice()), deps({ args }, { onPhase: (p) => phases.push(p) })));
    assert.equal(e.origin, 'file');
    assert.ok(e.paperMismatch, '紙の大きさの違いが値で返らない');
    assert.deepEqual(e.paperMismatch?.pages, [1]);
    assert.deepEqual(e.paperMismatch?.actualMm, { w: 105.83, h: 141.11 });
    assert.deepEqual(e.paperMismatch?.expectedMm, { w: 151.2, h: 216.4 });
    assert.equal(e.complete, true);
    assert.equal(args.length, 0, 'Ghostscript を動かしてはいけない');
    assert.ok(!phases.includes('convert'), `変換の段に進んでいる: ${phases.join(',')}`);
    assert.doesNotMatch(e.message, /TrimBox|MediaBox/);
    assert.match(e.message, /違います/);
    noRawEnglish(e.message);
  }
});

await test('紙の大きさが違うのが 2 ページ目から(1 ページ目は合う)でも、全ページを比べて断る。ページの一覧が入る', async () => {
  const d = await PDFDocument.create();
  d.addPage(PAPER_PT);
  d.addPage([300, 400]);
  d.addPage([300, 400]);
  const e = await failure(runPress(job('body-gray', await d.save({ useObjectStreams: false })), deps({})));
  assert.deepEqual(e.paperMismatch?.pages, [2, 3]);
});

await test('紙の大きさの許す差(Chrome の丸めで −0.16mm・小さい側は 0.3mm まで・大きい側は 1mm まで)は断らない。それ以上は断る', async () => {
  const mm = 72 / 25.4;
  const pdfWith = async (dw: number, dh: number) => {
    const d = await PDFDocument.create();
    d.addPage([PAPER_PT[0] + dw * mm, PAPER_PT[1] + dh * mm]);
    return d.save({ useObjectStreams: false });
  };
  for (const [dw, dh] of [[0.099, -0.161], [-0.29, 0.9]]) {
    const r = await runPress(job('body-gray', await pdfWith(dw, dh)), deps({}));
    assert.equal(r.pages, 1, `${dw},${dh}`);
  }
  for (const [dw, dh] of [[-0.31, 0], [0, 1.1], [3, 3]]) {
    const e = await failure(runPress(job('body-gray', await pdfWith(dw, dh)), deps({})));
    assert.ok(e.paperMismatch, `${dw},${dh}`);
  }
});

await test('紙の大きさの文: 「111×154mm」のように、小数が .0 のときは整数で言う', () => {
  assert.equal(mmText(111), '111');
  assert.equal(mmText(111.0004), '111');
  assert.equal(mmText(111.2), '111.2');
  assert.equal(mmText(110.96), '111');
  assert.equal(paperSizeText({ w: 111, h: 154.04 }), '111×154mm');
  assert.equal(paperSizeText({ w: 115.2, h: 158 }), '115.2×158mm');
  const pm = { pages: [1], actualMm: { w: 111.2, h: 154.2 }, expectedMm: { w: 115, h: 158 } };
  const t = paperMismatchText(pm, 'before');
  assert.match(t, /^選んだ PDF の紙の大きさ（111\.2×154\.2mm）が、いまの本の用紙（115×158mm）と違います。変換せずに止めました。/);
  assert.match(t, /上のボタンで書き出し直して、保存した PDF をもう一度渡してください$/);
  assert.doesNotMatch(t, /保存しませんでした/);
  assert.match(paperMismatchText({ ...pm, pages: [3, 4, 5] }, 'before'), /^選んだ PDF の 3〜5 ページの紙の大きさ/);
  assert.match(paperMismatchText(pm, 'after'), /保存しませんでした/, '変換のあとの守りは、変換したので「止めました」と言わない');
});

await test('失敗の文: 文に助言が入っているもの(complete)には「選んだファイルが…確かめて」を足さない。暗号化の文は「外して」と「確かめて」が重ならない', () => {
  const plain = failureText('file', NOT_PDF);
  assert.match(plain, /印刷の画面で保存した本文 PDF か確かめてください/);
  assert.equal(failureText('file', ENCRYPTED, true), ENCRYPTED);
  assert.equal(failureText('file', ALREADY, true), ALREADY);
  assert.doesNotMatch(failureText('file', ENCRYPTED, true), /確かめて/);
  assert.doesNotMatch(ENCRYPTED, /外して/);
  const tool = '変換の道具を読み込めませんでした。通信を確かめて、ページを読み込み直してください';
  assert.equal(failureText('tool', tool), tool);
});

await test('インクを抑えた一言: 4色の合計であることを言う。数字は上限まで', () => {
  const ink = (maxBefore: number) => ({ limit: 300, maxBefore, maxAfter: 300, images: 1, ops: 0, shadings: 0, unhandled: [] });
  assert.equal(inkSentence(ink(338.4)), 'いちばん濃い所のインク（4色の合計）を 338% から 300% に抑えました。');
  assert.equal(inkSentence(ink(300.4)), 'いちばん濃い所のインク（4色の合計）を 300.4% から 300% に抑えました。');
  assert.equal(inkSentence(ink(250)), null);
});

// ───────────────────────── 2. Ghostscript の出力の点検 ─────────────────────────

console.log('Ghostscript の出力の点検');

// 本物の Ghostscript 10.06 のログから写した行(seams の検査 2026-10-01)
const LOG_TRUNCATED = [
  'GPL Ghostscript 10.06.0 (2025-09-09)',
  'Catalog dictionary not located in file, unable to proceed',
  "   **** Error: Couldn't initialise file.",
  '               Output may be incorrect.',
  '   No pages will be processed (FirstPage > LastPage).',
];
const LOG_PASSWORD = [
  'GPL Ghostscript 10.06.0: ',
  '   **** This file requires a password for access.',
  "   **** Error: Couldn't initialise file.",
  '               Output may be incorrect.',
  '   No pages will be processed (FirstPage > LastPage).',
];

for (const kind of ['body-gray', 'body-cmyk'] as const) {
  await test(`${kind}: 「Processing pages」が1度も出ない(Ghostscript は終了コード 0 で白紙を出す)なら失敗・白紙を返さない`, async () => {
    const e = await failure(runPress(job(kind, await pdfOfPages(2)), deps({ lines: ['GPL Ghostscript 10.06.0 (2025-09-09)'], out: await pdfOfPages(1) })));
    assert.match(e.message, /^PDF として読めませんでした/);
    assert.equal(e.origin, 'file');
    noRawEnglish(e.message);
  });
  await test(`${kind}: 途中で切れた PDF のログ(No pages will be processed・Couldn't initialise file)は失敗(file)`, async () => {
    const e = await failure(runPress(job(kind, await pdfOfPages(2)), deps({ lines: LOG_TRUNCATED, out: await pdfOfPages(1) })));
    assert.match(e.message, /^PDF として読めませんでした/);
    assert.equal(e.origin, 'file');
    assert.ok(e.log.includes('No pages will be processed'), 'ログの末尾は開発者向けに残す');
    noRawEnglish(e.message);
  });
  await test(`${kind}: パスワードを求められたログ(requires a password)は、暗号化と同じ文で失敗(file)`, async () => {
    const e = await failure(runPress(job(kind, await pdfOfPages(2)), deps({ lines: LOG_PASSWORD, out: await pdfOfPages(1) })));
    assert.equal(e.message, ENCRYPTED);
    assert.equal(e.origin, 'file');
  });
  await test(`${kind}: 出力のページ数が入力と違えば失敗(例: 入力 3 ページに出力 1 ページ)`, async () => {
    const e = await failure(runPress(job(kind, await pdfOfPages(3)), deps({ out: await pdfOfPages(1) })));
    assert.match(e.message, /ページ数/);
    assert.match(e.message, /1/);
    assert.match(e.message, /3/);
    noRawEnglish(e.message);
  });
}

await test('ページ数が合っていれば成功(入力 3 ページ・出力 3 ページ)', async () => {
  const r = await runPress(job('body-gray', await pdfOfPages(3)), deps({}));
  assert.equal(r.pages, 3);
});

await test('終了コードが 0 でないときは「変換できませんでした」だけを言い、コードと Ghostscript の出力は log(コンソール用)に回す', async () => {
  const e = await failure(runPress(job('body-gray', await pdfOfPages(1)), deps({ exit: 2, lines: ['Error: /undefined in hello', 'Unrecoverable error, exit code 2'] })));
  assert.match(e.message, /^変換できませんでした/);
  assert.doesNotMatch(e.message, /[0-9]/, '数字(終了コード)は利用者に見せない');
  assert.match(e.log, /exit code 2/);
  assert.match(e.log, /終了コード 2/);
  assert.equal(e.origin, 'file');
});

await test('Ghostscript が落ちた(callMain が英語の例外を投げた)ときは、括弧の英語を見せず log に回す(internal)', async () => {
  const e = await failure(runPress(job('body-gray', await pdfOfPages(1)), deps({ throws: new Error('abort(RuntimeError: memory access out of bounds)') })));
  assert.match(e.message, /^変換の途中で止まりました/);
  noRawEnglish(e.message);
  assert.equal(e.origin, 'internal');
  assert.match(e.log, /memory access out of bounds/);
});

await test('出力ファイルが無いときは「PDF ができていません」(internal)', async () => {
  const e = await failure(runPress(job('body-gray', await pdfOfPages(1)), deps({ out: null })));
  assert.match(e.message, /PDF ができていません/);
  assert.equal(e.origin, 'internal');
});

// ───────────────────────── 3. 道具の読み込みの失敗 ─────────────────────────

console.log('道具の読み込みの失敗');

const TOOL_MSG = '変換の道具を読み込めませんでした。通信を確かめて、ページを読み込み直してください';

await test('ICC の読み込みの失敗(オフラインの fetch は TypeError: Failed to fetch)は、日本語の文で失敗(tool)・英語は log へ', async () => {
  const e = await failure(runPress(job('body-cmyk', await pdfOfPages(1)), deps({}, { loadIcc: async () => { throw new TypeError('Failed to fetch'); } })));
  assert.equal(e.message, TOOL_MSG);
  assert.equal(e.origin, 'tool');
  assert.match(e.log, /Failed to fetch/);
});

await test('Ghostscript の読み込みの失敗(動的 import・wasm のコンパイル)は、日本語の文で失敗(tool)', async () => {
  for (const msg of [
    'Failed to fetch dynamically imported module: http://localhost:8765/assets/gs-CQxtkNud.js',
    'Aborted(CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 44 4f @+0). Build with -sASSERTIONS',
  ]) {
    for (const kind of ['body-gray', 'cover-cmyk'] as const) {
      const e = await failure(runPress(job(kind, await pdfOfPages(1)), deps({}, { createGs: async () => { throw new Error(msg); } })));
      assert.equal(e.message, TOOL_MSG);
      assert.equal(e.origin, 'tool');
      noRawEnglish(e.message);
      assert.ok(e.log.includes(msg.slice(0, 20)));
    }
  }
});

await test('ほかの部品が投げた英語の例外(pdf-lib などの不具合)は、日本語の文で失敗(internal)・元の例外は log へ', async () => {
  const e = await failure(
    runPress(job('body-gray', await pdfOfPages(1)), deps({}, { createGs: async () => ({
      callMain() { throw new RangeError('Invalid array length'); },
      FS: { mkdir() {}, writeFile() {}, readFile() { throw new Error('x'); } },
    }) })),
  );
  noRawEnglish(e.message);
  assert.equal(e.origin, 'internal');
  assert.match(e.log, /Invalid array length/);
});

// ───────────────────────── 4. 読めなかった・置き換わった所を利用者に知らせる ─────────────────────────

console.log('Ghostscript のログ → issues');

const LOG_DRAW_ERROR = [
  'Processing pages 1 through 3.',
  'Page 1',
  'Page 2',
  '   **** Error: Page drawing error occurred.',
  '               Output may be incorrect.',
  'Page 3',
];
const LOG_SUBST = [
  'Processing pages 1 through 3.',
  'Page 1',
  '**** Warning: cannot process embedded stream for font object 10735 0',
  '**** Attempting to load a substitute font.',
  'Loading CIDFont AAAAAA+NotoSerifJPExtraLight-Bold substitute from %rom%Resource/CIDFSubst/DroidSansFallback.ttf',
  'Page 2',
  'Page 3',
  '**** Warning: cannot process embedded stream for font object 10735 0',
  '**** Attempting to load a substitute font.',
  'Loading CIDFont AAAAAA+NotoSerifJPExtraLight-Bold substitute from %rom%Resource/CIDFSubst/DroidSansFallback.ttf',
];

await test('「**** Error: Page drawing error」は、そのページ番号つきで「正しく読めなかったかもしれません」と issues に入る', async () => {
  const r = await runPress(job('body-gray', await pdfOfPages(3)), deps({ lines: LOG_DRAW_ERROR }));
  const hit = r.issues.filter((s) => /ページの画像や文字を、正しく読めなかったかもしれません/.test(s));
  assert.equal(hit.length, 1, r.issues.join(' / '));
  assert.match(hit[0], /(^|[^0-9])2 ?ページの画像や文字/);
  noRawEnglish(hit[0]);
});

await test('ページ番号が分からないとき(Page の行より前の Error)は「一部のページ」と言う', async () => {
  const lines = ['Processing pages 1 through 3.', '   **** Error: something odd happened', 'Page 1', 'Page 2', 'Page 3'];
  const r = await runPress(job('body-gray', await pdfOfPages(3)), deps({ lines }));
  const hit = r.issues.filter((s) => /正しく読めなかったかもしれません/.test(s));
  assert.equal(hit.length, 1, r.issues.join(' / '));
  assert.match(hit[0], /一部のページ/);
});

await test('代わりの書体への置き換え(substitute font)は「埋め込まれていない書体が、別の書体に置き換わりました」と1回だけ issues に入る', async () => {
  const r = await runPress(job('body-gray', await pdfOfPages(3)), deps({ lines: LOG_SUBST }));
  const hit = r.issues.filter((s) => /埋め込まれていない書体が、別の書体に置き換わりました/.test(s));
  assert.equal(hit.length, 1, r.issues.join(' / '));
  assert.match(hit[0], /NotoSerifJPExtraLight-Bold/);
  assert.doesNotMatch(hit[0], /AAAAAA\+/, '書体の名前の前の6文字(部分埋め込みの印)は見せない');
  noRawEnglish(hit[0].replace(/NotoSerifJPExtraLight-Bold/g, ''));
});

await test('正常なログ(Warning だけ・`**** This file had errors that were repaired or ignored`)では issues を足さない', async () => {
  const lines = [
    'Processing pages 1 through 1.',
    'Page 1',
    '',
    'The following warnings were encountered at least once while processing this file:',
    '\t/Length present in Encryption dictionary and /V is neither 2 nor 3',
    '',
    '   **** This file had errors that were repaired or ignored.',
    '   **** The file was produced by: ',
    '   **** >>>> Skia/PDF m154 <<<<',
  ];
  const r = await runPress(job('body-gray', await pdfOfPages(1)), deps({ lines }));
  assert.deepEqual(r.issues.filter((s) => /読めなかった|置き換わり/.test(s)), []);
});

// ───────────────────────── 5. 段と、二重の知らせ ─────────────────────────

console.log('段の順番・同じ原因をまとめる');

const PHASE_ORDER: PressPhase[] = ['load', 'prepare', 'convert', 'finish', 'check'];

for (const kind of ['body-gray', 'body-cmyk', 'cover-cmyk'] as const) {
  await test(`${kind}: 段は load → prepare → convert → finish → check の順に1度ずつ(load に戻らない)`, async () => {
    const phases: PressPhase[] = [];
    const r = await runPress(job(kind, await pdfOfPages(1)), deps({}, { onPhase: (p) => phases.push(p) }));
    assert.equal(r.pages, 1);
    assert.deepEqual(phases, PHASE_ORDER);
  });
}

/** 内容のストリームが Flate として壊れているページ 1 つの PDF(Ghostscript の出力のつもり) */
async function brokenContentPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const page = d.addPage(PAPER_PT);
  const dict = d.context.obj({ Filter: 'FlateDecode' }) as PDFDict;
  const stream = PDFRawStream.of(dict, Uint8Array.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  const ref = d.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
  dict.set(PDFName.of('Length'), PDFNumber.of(12));
  return d.save({ useObjectStreams: false });
}

await test('読めなかったページ(壊れた Flate)を、点検・インク・X-4 が別々に言わず、issues では1つにまとまる', async () => {
  const bad = await brokenContentPdf();
  const r = await runPress(job('body-cmyk', bad.slice()), deps({ out: bad }));
  const talk = r.issues.filter((s) => /ページ 1/.test(s));
  assert.equal(talk.length, 1, `ページ 1 の読めなさを言う行が ${talk.length} 本:\n${r.issues.join('\n')}`);
  assert.match(talk[0], /読め/);
  // 元の報告(ink.unhandled・pdfx.violations)には、それぞれの言い方が残っている(開発者向け)
  assert.ok((r.ink?.unhandled.length ?? 0) > 0);
});

await test('読めなかったページは、色の書き換え(neutral)の skipped にも出るが、同じ原因なので別の行にしない', async () => {
  const bad = await brokenContentPdf();
  const r = await runPress(job('body-cmyk', bad.slice()), deps({ out: bad }));
  assert.ok((r.neutral?.skipped.length ?? 0) > 0, 'neutral が読めなかったことを覚えている');
  assert.equal(r.issues.filter((s) => /黒インクだけに直せなかった/.test(s)).length, 0, r.issues.join('\n'));
});

// ───────────────────────── 6. 色の書き換えで直せなかった所 → issues ─────────────────────────

console.log('neutral の skipped');

/** 1ページの内容に、RGB のインライン画像(BI … ID … EI)を入れた PDF。neutral は画素を書き換えないので、描く命令の skipped に入る */
async function inlineImagePdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const page = d.addPage(PAPER_PT);
  const content = d.context.stream('q 10 0 0 10 20 20 cm\nBI /W 1 /H 1 /CS /RGB /BPC 8 ID \u0001\u0002\u0003\nEI Q\n');
  page.node.set(PDFName.of('Contents'), d.context.register(content));
  return d.save({ useObjectStreams: false });
}

await test('描く命令を書き換えられなかった所(RGB のインライン画像)は、issues に「黒インクだけに直せなかった所」として入る', async () => {
  const src = await inlineImagePdf();
  const r = await runPress(job('body-cmyk', src.slice()), deps({ out: 'echo' }));
  assert.ok((r.neutral?.skipped.length ?? 0) > 0, `neutral.skipped=${JSON.stringify(r.neutral?.skipped)}`);
  const hit = r.issues.filter((s) => /黒い字やグレーを、黒インクだけに直せなかった所が [0-9]+ か所あります/.test(s));
  assert.equal(hit.length, 1, r.issues.join('\n'));
  assert.match(hit[0], /カラーに数えられます/);
});

await test('JPEG をほどけなかった・計算式の影、のような「画像と影」の skipped は、issues に入れない(その色の数え方は別に点検される)', async () => {
  const r = await runPress(job('body-cmyk', await pdfOfPages(1)), deps({}));
  assert.equal(r.issues.filter((s) => /黒インクだけに直せなかった/.test(s)).length, 0);
});

// ───────────────────────── 7. 結果の欄 ─────────────────────────

await test('結果に tone(グレーの濃さの直し)の報告が入る。本文は白黒もカラーも直し、表紙は直さない(null)', async () => {
  const gray = await runPress(job('body-gray', await pdfOfPages(1)), deps({}));
  assert.ok(gray.tone && Array.isArray(gray.tone.skipped), '白黒の本文に tone の報告が無い');
  const cmyk = await runPress(job('body-cmyk', await pdfOfPages(1)), deps({}));
  assert.ok(cmyk.tone && Array.isArray(cmyk.tone.skipped), 'カラーの本文に tone の報告が無い');
  const cover = await runPress(job('cover-cmyk', await pdfOfPages(1)), deps({}));
  assert.equal(cover.tone, null);
});

await test('紙の大きさが合っていれば、結果の pdfx.paperMismatch は null(違う PDF は入口で断るので、結果には来ない)', async () => {
  const r = await runPress(job('body-gray', await pdfOfPages(1)), deps({}));
  assert.equal(r.pdfx.paperMismatch ?? null, null);
});

// ───────────────────────── 8. 色空間を引き継ぐ Form の skipped → issues ─────────────────────────

/** ページが `/DeviceRGB cs 0.5 0.5 0.5 sc /Fm1 Do`、Form が cs を言わずに `1 0 0 sc`(色空間を親から引き継ぐ形) */
async function inheritingFormPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const page = d.addPage(PAPER_PT);
  const form = d.context.stream('1 0 0 sc 20 20 100 100 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200], Resources: {} });
  const content = d.context.stream('/DeviceRGB cs 0.5 0.5 0.5 sc /Fm1 Do');
  page.node.set(PDFName.of('Resources'), d.context.obj({ XObject: { Fm1: d.context.register(form) } }));
  page.node.set(PDFName.of('Contents'), d.context.register(content));
  return d.save({ useObjectStreams: false });
}

await test('色空間を引き継ぐ Form とそれを呼ぶページ(書き換えなかった所)は、issues に「黒インクだけに直せなかった所が 2 か所」と出る', async () => {
  const r = await runPress(job('body-cmyk', await inheritingFormPdf()), deps({ out: 'echo' }));
  assert.equal(r.neutral?.opsSkipped.length, 2, JSON.stringify(r.neutral?.opsSkipped));
  assert.ok(r.neutral?.opsSkipped.every((s) => r.neutral?.skipped.includes(s)), 'opsSkipped は skipped の一部');
  const hit = r.issues.filter((s) => /黒い字やグレーを、黒インクだけに直せなかった所が 2 か所あります/.test(s));
  assert.equal(hit.length, 1, r.issues.join('\n'));
});

console.log(`\n${passed} 件通過 / ${failed.length} 件落ち`);
if (failed.length) console.log('落ちたもの:\n  ' + failed.join('\n  '));
process.exit(failed.length ? 1 : 0);
