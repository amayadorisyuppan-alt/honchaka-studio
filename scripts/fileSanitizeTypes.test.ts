// 保存の .json の画像の欄に型の違う値・外の場所が入っていたときと、表の名前に toString などが入ったときの検査。
// (2026-10-13 修正リスト 25・26・33。運用の見直し 12 の B2・B3、A の https の src)
//
// ## なぜ在るか
//
// - 25: `settings.bodyBg` が文字列でない・`titleBg.src` が数、のような .json を読むと画面がエラーになり、
//   その値が自動保存に残って、**開き直しても入口にすら戻れなかった**。読み込み(src/project/file.ts の sanitize と
//   fromProjectFile)で、絵を置けるすべての欄の型を確かめて外す。エラーの画面には、控えを取ってから作りかけを空にして
//   最初の画面に戻る逃げ道を足した(src/components/crashEscape.ts)。その手順もここで確かめる
// - 26: `v in COVER_FONTS` が toString・constructor にも true になり、検査をすり抜けて表紙の書名が消えた
// - 33: 画像の src が `https://…` でも通り、読み込むと外のサイトへ取りに行った
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   node scripts/private/run-tests.mjs public      (ほかの検査と一緒に)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import {
  defaultSettings,
  isLoadableImageSrc,
  isRenderableImage,
  sceneBreakOf,
} from '../src/models/project';
import type { ProjectSettings } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import { fromProjectFile, rescueProjectFile, sanitize, toProjectFile } from '../src/project/file';
import type { ProjectSnapshot } from '../src/project/file';
import { manuscriptHtml } from '../src/typeset/html';
import { backupThenReset } from '../src/components/crashEscape';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG2 = PNG.replace('==', 'A=');
const BAD: unknown[] = [null, 123, 'x', {}, [], { src: 5 }];
const EXTERNAL = ['https://example.com/a.png', 'http://example.com/a.png', '//example.com/a.png', 'javascript:alert(1)', ' https://example.com/a.png', 'covers/../../x.png'];

function base(): ProjectSnapshot {
  const ms = sampleManuscript();
  ms.chapters[0].blocks = [...ms.chapters[0].blocks, { type: 'image', src: PNG2, alt: '絵' }];
  const settings: ProjectSettings = {
    ...defaultSettings(),
    bodyBg: PNG,
    titleBg: { src: PNG, opacity: 0.5 },
    tocBg: { src: PNG },
    colophonBg: { src: PNG },
    chapterBg: { 0: { src: PNG, opacity: 0.3 } },
    plates: [{ id: 'p1', src: PNG, beforeChapter: 0, size: 'wide' }],
    columnPages: [{ id: 'c1', title: 'コラム', text: '本文', beforeChapter: 0, bg: { src: PNG } }],
  } as ProjectSettings;
  const cover = { ...defaultCoverSettings(), background: { kind: 'image' as const, src: PNG } };
  return { settings, cover, manuscript: ms, source: null };
}

/** 読み込んだ本の、絵を置ける欄の src を全部集める */
function allSrcs(p: ProjectSnapshot): unknown[] {
  const s = p.settings;
  const out: unknown[] = [];
  if (s.bodyBg !== undefined) out.push(s.bodyBg);
  for (const k of ['titleBg', 'tocBg', 'colophonBg'] as const) {
    const v = s[k] as unknown;
    if (v !== undefined && v !== null) out.push(typeof v === 'object' && !Array.isArray(v) ? (v as { src?: unknown }).src ?? '' : v);
  }
  for (const v of Object.values((s.chapterBg ?? {}) as Record<string, unknown>)) {
    if (v !== undefined && v !== null) out.push(typeof v === 'object' && !Array.isArray(v) ? (v as { src?: unknown }).src ?? '' : v);
  }
  for (const pl of s.plates ?? []) out.push((pl as { src?: unknown }).src);
  for (const c of s.columnPages ?? []) if (c.bg !== undefined) out.push(c.bg?.src ?? '');
  for (const ch of p.manuscript.chapters) for (const b of ch.blocks) if (b.type === 'image') out.push(b.src);
  for (const k of ['background', 'backCover', 'wrap', 'wrapSaved'] as const) {
    const v = p.cover[k] as { kind?: string; src?: unknown } | undefined;
    if (v?.kind === 'image') out.push(v.src);
  }
  return out;
}
const allSafe = (p: ProjectSnapshot) => allSrcs(p).every((v) => typeof v === 'string' && isLoadableImageSrc(v));

/** o の path の値を v にする(path は . 区切り。数字の段は配列の添字か、キー) */
function setAt(o: Record<string, unknown>, path: string, v: unknown) {
  const ks = path.split('.');
  let cur: Record<string, unknown> = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[ks[ks.length - 1]] = v;
}

const current = base();
const text = toProjectFile(current, true);

// 0. 正しいファイルは、何も言わずにそのまま戻る
{
  const r = fromProjectFile(text, current);
  ok(r.warnings.length === 0, '正しい控え: 知らせが出ない', JSON.stringify(r.warnings));
  const srcs = allSrcs(r.project);
  // PNG は 本文の背景・3つの面・章1・挿絵・コラムの地・表1 の 8 か所
  ok(allSafe(r.project) && srcs.filter((x) => x === PNG).length === 8 && srcs.includes(PNG2), '正しい控え: 絵が全部戻る', String(srcs.length));
}

// 1. 欄そのもの・src に型の違う値・外の場所(本文の中に直に書いたもの)
const SLOTS: [string, string][] = [
  ['settings.bodyBg', '本文の背景'],
  ['settings.titleBg', '大扉の背景'],
  ['settings.titleBg.src', '大扉の背景'],
  ['settings.tocBg.src', '目次の背景'],
  ['settings.colophonBg', '奥付の背景'],
  ['settings.chapterBg', '章ごとの背景'],
  ['settings.chapterBg.0', '章ごとの背景'],
  ['settings.chapterBg.0.src', '章ごとの背景'],
  ['settings.plates.0', '挿絵ページ'],
  ['settings.plates.0.src', '挿絵ページ'],
  ['settings.columnPages.0.bg', 'コラムページの地'],
  ['settings.columnPages.0.bg.src', 'コラムページの地'],
  ['cover.background', '表紙(表1)の地'],
  ['cover.background.src', '表紙(表1)の地'],
  ['cover.wrap', 'まるごと1枚'],
];
let imgBlockIndex = -1;
{
  const o = JSON.parse(text);
  imgBlockIndex = (o.manuscript.chapters[0].blocks as { type: string }[]).findIndex((b) => b.type === 'image');
  SLOTS.push([`manuscript.chapters.0.blocks.${imgBlockIndex}.src`, '本文中の画像']);
}
// 外して知らせなくてよい値(正しい形): 面の背景・章ごとの背景・コラムの地の null と {}(null は無いのと同じに読まれる)
const HARMLESS_PATHS = ['settings.titleBg', 'settings.colophonBg', 'settings.chapterBg', 'settings.chapterBg.0', 'settings.columnPages.0.bg'];
const harmless = (path: string, v: unknown) =>
  HARMLESS_PATHS.includes(path) && (v === null || JSON.stringify(v) === '{}');
for (const [path, label] of SLOTS) {
  for (const v of [...BAD, ...EXTERNAL]) {
    const name = `${path} = ${JSON.stringify(v)}`;
    const o = JSON.parse(text);
    setAt(o, path, v);
    let r: ReturnType<typeof fromProjectFile> | null = null;
    try {
      r = fromProjectFile(JSON.stringify(o), current);
    } catch (e) {
      ok(false, `${name}: 例外が出ない`, String(e));
      continue;
    }
    ok(allSafe(r.project), `${name}: 悪い値が外れる`, JSON.stringify(allSrcs(r.project)).slice(0, 200));
    ok(!JSON.stringify(r.project).includes('example.com'), `${name}: 外の場所が残らない`);
    if (!harmless(path, v)) {
      ok(r.warnings.some((w) => w.includes(label)), `${name}: 知らせる(${label})`, JSON.stringify(r.warnings));
    }
    // 組版の HTML を作っても落ちない(画面が落ちていたのと同じ所を通る)
    try {
      manuscriptHtml(r.project.manuscript, r.project.settings);
      ok(true, `${name}: 組版が落ちない`);
    } catch (e) {
      ok(false, `${name}: 組版が落ちない`, String(e));
    }
  }
}

// 2. 末尾の images(実体)に型の違う値・外の場所
for (const place of ['titleBg', 'bodyBg', 'plate.p1', 'colpage.c1', 'cover.background']) {
  for (const v of [...BAD, ...EXTERNAL]) {
    const name = `images["${place}"] = ${JSON.stringify(v)}`;
    const o = JSON.parse(text);
    // 同じ絵は最初の置き場所の名前でまとめられるので、置き場所ごとに別の実体にしておく
    if (!(place in o.images)) {
      const ph = `#img:${place}`;
      if (place === 'titleBg') o.settings.titleBg.src = ph;
      if (place === 'plate.p1') o.settings.plates[0].src = ph;
      if (place === 'colpage.c1') o.settings.columnPages[0].bg.src = ph;
      if (place === 'cover.background') o.cover.background.src = ph;
    }
    o.images[place] = v;
    try {
      const r = fromProjectFile(JSON.stringify(o), current);
      ok(allSafe(r.project), `${name}: 悪い値が外れる`, JSON.stringify(allSrcs(r.project)).slice(0, 200));
      ok(!JSON.stringify(r.project).includes('example.com'), `${name}: 外の場所が残らない`);
      ok(r.warnings.some((w) => w.includes('画像')), `${name}: 知らせる`, JSON.stringify(r.warnings));
    } catch (e) {
      ok(false, `${name}: 例外が出ない`, String(e));
    }
  }
}

// 3. 自動保存から開くとき(useProject の hydrate と同じ呼び方)。すでに悪い値が残っている人も入れる
for (const [path, v] of [['settings.bodyBg', { kind: 'image', src: 'x' }], ['settings.titleBg', { src: 5 }], ['settings.bodyBg', 123]] as const) {
  const p = JSON.parse(JSON.stringify(current));
  setAt(p, path, v);
  try {
    const r = sanitize(p, { settings: defaultSettings(), cover: defaultCoverSettings(), manuscript: p.manuscript, source: null }, true);
    ok(allSafe(r.project) && r.fixed.length > 0, `自動保存 ${path} = ${JSON.stringify(v)}: 外して知らせる`, JSON.stringify(r.fixed));
  } catch (e) {
    ok(false, `自動保存 ${path}: 例外が出ない`, String(e));
  }
}

// 4. 表の名前に Object の元の名前(修正リスト 26)
for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
  const cases: [string, (r: ReturnType<typeof fromProjectFile>) => boolean][] = [
    ['cover.titleFont', (r) => r.project.cover.titleFont === current.cover.titleFont],
    ['cover.authorFont', (r) => r.project.cover.authorFont === current.cover.authorFont],
    ['cover.blurbFont', (r) => r.project.cover.blurbFont === current.cover.blurbFont],
    ['cover.spineFont', (r) => r.project.cover.spineFont === current.cover.spineFont],
    ['cover.paper', (r) => r.project.cover.paper === current.cover.paper],
    ['settings.nombreFont', (r) => r.project.settings.nombreFont === undefined],
    ['settings.runningHeadFont', (r) => r.project.settings.runningHeadFont === undefined],
    ['settings.chapterFont', (r) => Object.keys(r.project.settings.chapterFont ?? {}).length === 0],
    ['settings.plates.0.size', (r) => r.project.settings.plates[0]?.size === 'full'],
    ['settings.bodyFont', (r) => r.project.settings.bodyFont === current.settings.bodyFont],
    ['settings.sceneBreak', (r) => r.project.settings.sceneBreak === current.settings.sceneBreak],
  ];
  for (const [path, check] of cases) {
    const o = JSON.parse(text);
    setAt(o, path, path === 'settings.chapterFont' ? { 0: name } : name);
    // __proto__ は JSON.parse ではふつうのキーになるが、setAt の代入では入らないので、文字で差し替える
    const json = JSON.stringify(o);
    try {
      const r = fromProjectFile(json, current);
      ok(check(r), `${path} = "${name}": 表の名前として通らない`, JSON.stringify((r.project as unknown as Record<string, unknown>)[path.split('.')[0]]).slice(0, 120));
    } catch (e) {
      ok(false, `${path} = "${name}": 例外が出ない`, String(e));
    }
  }
  ok(sceneBreakOf({ sceneBreak: name as never }) !== (name as never), `sceneBreakOf("${name}") は既定に倒す`);
}

// 5. src の判定そのもの(修正リスト 33)
for (const v of [PNG, '', 'data:image/svg+xml,%3Csvg%3E', 'data:image/webp;base64,AAAA', 'covers/biz-business-01.jpg', 'sample/fig_pen.png']) {
  ok(isLoadableImageSrc(v), `読んでよい: ${v.slice(0, 40)}`);
}
for (const v of [...EXTERNAL, 'x', 'data:text/html,<b>', 'blob:https://x/1', 'file:///C:/a.png', 'covers/.hidden', 5, null, {}]) {
  ok(!isLoadableImageSrc(v), `読まない: ${JSON.stringify(v)}`);
}
for (const v of ['https://example.com/a.png', '//example.com/a.png', '\\\\example.com\\a.png', ' https://example.com/a.png', 'ht\ttps://example.com/a.png', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)']) {
  ok(!isRenderableImage(v), `表示しない: ${JSON.stringify(v)}`);
}
for (const v of [PNG, 'covers/a.jpg']) ok(isRenderableImage(v), `表示する: ${v.slice(0, 30)}`);
ok(!isRenderableImage(5 as never), '表示しない: 数');

// 6. エラーの画面の逃げ道(crashEscape)。控えが取れなければ何も消さない
async function escapeCases() {
  const make = (over: Partial<Parameters<typeof backupThenReset>[0]> = {}) => {
    const log: string[] = [];
    const files: string[] = [];
    const deps: Parameters<typeof backupThenReset>[0] = {
      confirm: () => (log.push('confirm'), true),
      readSaved: async () => JSON.parse(JSON.stringify(current)),
      current: () => current,
      download: (t, n) => (log.push(`download:${n}`), files.push(t)),
      clearSaved: async () => void log.push('clear'),
      reload: () => void log.push('reload'),
      alert: (m) => void log.push(`alert:${m.slice(0, 10)}`),
      wait: async () => undefined,
      ...over,
    };
    return { deps, log, files };
  };
  {
    const { deps, log, files } = make();
    const r = await backupThenReset(deps);
    ok(r === 'done' && log.join(',').replace(/download:[^,]*/, 'download') === 'confirm,download,clear,reload', '逃げ道: 控え→空にする→開き直す の順', log.join(','));
    ok(log.some((l) => l.endsWith('_復旧.json')), '逃げ道: 控えの名前', log.join(','));
    const back = fromProjectFile(files[0], { ...current, settings: { ...current.settings, bookId: 'other' } });
    ok(back.project.manuscript.chapters.length === current.manuscript.chapters.length, '逃げ道: 控えは読み込める');
  }
  {
    const { deps, log } = make({ confirm: () => false });
    ok((await backupThenReset(deps)) === 'cancelled' && log.length === 0, '逃げ道: やめたら何もしない', log.join(','));
  }
  {
    const { deps, log } = make({ download: () => { throw new Error('x'); } });
    const r = await backupThenReset(deps);
    ok(r === 'backup-failed' && !log.includes('clear') && !log.includes('reload'), '逃げ道: 控えが失敗したら消さない', log.join(','));
  }
  {
    const { deps, log } = make({ readSaved: async () => { throw new Error('idb'); } });
    const r = await backupThenReset(deps);
    ok(r === 'backup-failed' && !log.includes('clear'), '逃げ道: 自動保存が読めなければ消さない', log.join(','));
  }
  {
    const { deps, log } = make({ clearSaved: async () => { throw new Error('idb'); } });
    const r = await backupThenReset(deps);
    ok(r === 'clear-failed' && !log.includes('reload'), '逃げ道: 空にできなければ開き直さない', log.join(','));
  }
  {
    // 形の壊れた自動保存(章が配列でない・bodyBg が数)でも控えは作れて、読み込める
    const broken = JSON.parse(JSON.stringify(current));
    broken.manuscript.chapters = 'x';
    broken.settings.bodyBg = 123;
    const { deps, files } = make({ readSaved: async () => broken });
    ok((await backupThenReset(deps)) === 'done', '逃げ道: 壊れた本でも控えが取れる');
    const f = JSON.parse(files[0]);
    ok(f.format === 'book-studio-project' && f.settings.bodyBg === 123, '逃げ道: 壊れた本は手を加えずに書く');
    try {
      const back = fromProjectFile(files[0], current);
      ok(allSafe(back.project), '逃げ道: 壊れた控えも読み込める(悪い値は外れる)');
    } catch (e) {
      ok(false, '逃げ道: 壊れた控えも読み込める', String(e));
    }
  }
  {
    // 自動保存が無ければ、画面が持っている本から控えを取る
    const { deps, files } = make({ readSaved: async () => undefined });
    await backupThenReset(deps);
    ok(JSON.parse(files[0]).settings.bodyBg !== undefined || JSON.parse(files[0]).images !== undefined, '逃げ道: 自動保存が無ければ画面の本を控える');
  }
  ok(typeof rescueProjectFile(undefined) === 'string', '逃げ道: 何も無くても控えの関数は落ちない');
}

// 組版・印刷が使う blob: の一時の場所は通す(断ると紙の本文の PDF から挿絵のページが全部抜けた。2026-10-13)
ok(isRenderableImage('blob:http://localhost:5173/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab'), 'blob: の一時の場所は通す(組版・印刷)');
ok(!isRenderableImage('https://example.com/a.png'), 'https の外のサイトは断る');
ok(!isRenderableImage('javascript:alert(1)'), 'javascript: は断る');
ok(isRenderableImage('covers/story-bungei-01.jpg'), '同梱の絵の相対の場所は通す');

void escapeCases().then(() => {
  console.log(`\n${passed} 通過 / ${failed} 失敗`);
  process.exit(failed ? 1 : 0);
});
