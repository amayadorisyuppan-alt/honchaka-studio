// 書体を読み込めなかったことを数えて知らせる仕組み(修正リスト 29。2026-10-13)の検査。
// - src/preview/fontFailures.ts: 下見(Vivliostyle の Fnt_N の面)の失敗を数える・表紙の失敗を受け取る・読み直す
// - src/cover/fontLoad.ts: 表紙の書体で、作り直しても読めなかった面を知らせへ渡す
// ブラウザは要らない。document.fonts・styleSheets・FontFace・CSSFontFaceRule を偽物で立てて回す。
//
// 回し方(リポジトリの頭で): node scripts/private/run-tests.mjs public(ほかの検査と一緒に回る)
// 終了コード 0 = 全部通った / 1 = 落ちた。
import {
  faceKey,
  fontFailureSnapshot,
  fontFailureText,
  fontLabel,
  resetFontFailuresForTest,
  retryFontFailures,
  scanPreviewFontFailures,
  setCoverFontFailures,
  srcOf,
  watchFontFailures,
} from '../src/preview/fontFailures';
import { familyPartOf, loadCoverFonts } from '../src/cover/fontLoad';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}
const j = JSON.stringify;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 偽のブラウザ ----
const g = globalThis as Record<string, unknown>;
class FakeRule {
  style: { getPropertyValue: (p: string) => string };
  constructor(props: Record<string, string>) {
    this.style = { getPropertyValue: (p) => props[p] ?? '' };
  }
}
g.CSSFontFaceRule = FakeRule;
const rule = (props: Record<string, string>) => new FakeRule(props);

type Face = { family: string; weight: string; style: string; unicodeRange: string; display: string; status: string };
const face = (family: string, status: string, weight = '400', unicodeRange = 'U+3000-303F'): Face => ({
  family,
  weight,
  style: 'normal',
  unicodeRange,
  display: 'auto',
  status,
});

const BASE = 'https://example.com/bookstudio/';
const A = `${BASE}assets/reggae-one-0-400-normal-AAAA.woff2`;
const B = `${BASE}assets/reggae-one-1-400-normal-BBBB.woff2`;
const OLD = `${BASE}assets/dotgothic16-0-400-normal-CCCC.woff2`;
const N = `${BASE}assets/noto-sans-jp-0-700-normal-DDDD.woff2`;

// アプリの @font-face(本物の書体名)と、Vivliostyle が写した @font-face(Fnt_N)
const appSheet = {
  href: `${BASE}assets/index.css`,
  cssRules: [
    rule({ 'font-family': '"Reggae One"', 'font-weight': '400', src: `url(./reggae-one-0-400-normal-AAAA.woff2) format("woff2")`, 'unicode-range': 'U+3000-303F' }),
    rule({ 'font-family': '"Reggae One"', 'font-weight': '400', src: `url(./reggae-one-1-400-normal-BBBB.woff2) format("woff2")`, 'unicode-range': 'U+4E00-4E0F' }),
    rule({ 'font-family': 'DotGothic16', 'font-weight': '400', src: `url(./dotgothic16-0-400-normal-CCCC.woff2) format("woff2")`, 'unicode-range': 'U+3000-303F' }),
    rule({ 'font-family': '"Noto Sans JP"', 'font-weight': '700', src: `url(./noto-sans-jp-0-700-normal-DDDD.woff2) format("woff2")`, 'unicode-range': 'U+3000-303F' }),
  ],
};
const vivSheet = {
  href: null,
  cssRules: [
    rule({ 'font-family': 'Fnt_1', 'font-weight': 'normal', src: `url("${A}")`, 'unicode-range': 'U+3000-303F' }),
    rule({ 'font-family': 'Fnt_1', 'font-weight': '400', src: `url("${B}")`, 'unicode-range': 'U+4E00-4E0F' }),
    rule({ 'font-family': 'Fnt_2', 'font-weight': '400', src: `url("${OLD}")`, 'unicode-range': 'U+3000-303F' }),
  ],
};
const faces: Face[] = [
  face('Fnt_1', 'error'), // いまの本の書体(Reggae One)。数える
  face('Fnt_1', 'loaded', '400', 'U+4E00-4E0F'), // 読めた面。数えない
  face('Fnt_2', 'error'), // 前に選んでいた書体(いまの HTML に無い)。数えない
  face('"Reggae One"', 'error'), // アプリの画面の字(書体の一覧の見本など)。下見では数えない
];
const listeners: Record<string, (() => void)[]> = {};
let loadImpl: (spec: string, text: string) => Promise<unknown> = async () => [];
const fonts = {
  [Symbol.iterator]: () => faces[Symbol.iterator](),
  add: (f: Face) => faces.push(f),
  addEventListener: (t: string, cb: () => void) => (listeners[t] ??= []).push(cb),
  load: (spec: string, text: string) => loadImpl(spec, text),
};
g.document = { fonts, styleSheets: [appSheet, vivSheet], baseURI: BASE };
/** 作り直した面の読み込みが通るか(ネットが戻ったか) */
let online = false;
const tried: string[] = [];
g.FontFace = class {
  family: string;
  weight: string;
  style: string;
  unicodeRange: string;
  display: string;
  status = 'unloaded';
  src: string;
  constructor(family: string, src: string, d: { weight: string; style: string; unicodeRange: string; display: string }) {
    Object.assign(this, { family, src, ...d });
    this.family = family;
    this.src = src;
    this.weight = d.weight;
    this.style = d.style;
    this.unicodeRange = d.unicodeRange;
    this.display = d.display;
  }
  async load() {
    tried.push(this.src);
    if (!online) throw new Error('A network error occurred.');
    this.status = 'loaded';
    return this;
  }
};

const html = `<style>@font-face{font-family:"Reggae One";src:url("${A}")}@font-face{font-family:"Reggae One";src:url("${B}")}</style>`;

async function main() {
  // ---- 名前と鍵 ----
  ok(fontLabel('"Reggae One"') === 'Reggae One', '書体の一覧の名前の頭を出す(Reggae One)', fontLabel('Reggae One'));
  ok(fontLabel('Noto Serif JP') === '明朝（Noto Serif JP）', '明朝の名前', fontLabel('Noto Serif JP'));
  ok(fontLabel('amayadori-tcy-serif') === '明朝（Noto Serif JP）', '縦中横の書体は、その本文の書体の名前', fontLabel('amayadori-tcy-serif'));
  ok(fontLabel('Unknown Font') === 'Unknown Font', '一覧に無い書体はそのままの名前');
  ok(
    faceKey('Fnt_1', 'normal', '', '') === faceKey('"Fnt_1"', '400', 'normal', 'U+0-10FFFF'),
    '太さ normal と 400、字の範囲なしと全部の字は同じ鍵',
  );

  ok(
    familyPartOf('700 100px "Noto Serif JP", serif') === '"Noto Serif JP", serif' &&
      familyPartOf('italic 400 12.5px/1.6 "Reggae One"') === '"Reggae One"',
    '表紙の spec から書体名の並びだけを取り出す(頭の書体の error の面を拾えるように)',
  );

  // ---- 下見 ----
  resetFontFailuresForTest();
  ok(fontFailureSnapshot().count === 0, '最初は何も出さない');
  scanPreviewFontFailures(html);
  let s = fontFailureSnapshot();
  ok(s.count === 1 && j(s.families) === j(['Reggae One']), 'いまの本の書体の error の面だけを数え、アプリの書体名で出す', j(s));
  ok(
    fontFailureText(s).includes('（Reggae One）') && fontFailureText(s).includes('［書体を読み直す］'),
    '知らせの文に書体名とボタンの名前が入る',
    fontFailureText(s),
  );
  scanPreviewFontFailures(`<style>@font-face{font-family:x;src:url("${N}")}</style>`);
  ok(fontFailureSnapshot().count === 0, '書体を選び直して組み直したら、前の書体の失敗は消える');
  scanPreviewFontFailures(html);

  // loadingerror のあとにも数え直す(まとめて1回)
  watchFontFailures(fonts as unknown as FontFaceSet);
  faces.push(face('Fnt_1', 'error', '400', 'U+4E00-4E0F'));
  for (const cb of listeners.loadingerror ?? []) cb();
  ok(fontFailureSnapshot().count === 1, 'loadingerror の直後はまだ数え直さない(まとめる)');
  await sleep(500);
  ok(fontFailureSnapshot().count === 2, 'loadingerror のあと、少しおいて数え直す', j(fontFailureSnapshot()));

  // ---- 表紙 ----
  online = false;
  const coverBroken = face('"Noto Sans JP"', 'error', '700', 'U+3000-303F');
  faces.push(coverBroken);
  loadImpl = async () => {
    throw new Error('A network error occurred.');
  };
  let threw = false;
  try {
    await loadCoverFonts(['700 100px "Noto Sans JP", sans-serif'], '「」');
  } catch {
    threw = true;
  }
  s = fontFailureSnapshot();
  ok(threw, '表紙: 作り直しても読めなければ、今までどおり投げる');
  ok(s.count === 3 && j(s.families) === j(['Reggae One', 'ゴシック（Noto Sans JP）']), '表紙: 読めなかった書体を知らせに足す', j(s));
  loadImpl = async () => [];
  await loadCoverFonts(['400 100px "Reggae One"'], '「」');
  ok(fontFailureSnapshot().count === 2, '表紙: 書体を選び直して読めたら、表紙の古い失敗は消える', j(fontFailureSnapshot()));
  setCoverFontFailures([coverBroken as unknown as FontFace]);

  // ---- 読み直す(ネットが切れたまま) ----
  tried.length = 0;
  const epoch0 = fontFailureSnapshot().epoch;
  let all = await retryFontFailures();
  s = fontFailureSnapshot();
  ok(!all && s.count === 3 && !s.retrying && s.epoch === epoch0, '切れたままなら失敗は残り、組み直さない', j(s));
  ok(tried.length > 0 && tried.every((u) => [A, B, N].some((x) => u.includes(x))), '同じ @font-face の src で作り直して読む', j(tried));

  // 面が多くても、読めないと分かったら早めにやめる
  for (let i = 0; i < 40; i++) {
    const r = `U+${(0x5000 + i * 16).toString(16)}-${(0x500f + i * 16).toString(16)}`;
    vivSheet.cssRules.push(rule({ 'font-family': 'Fnt_1', 'font-weight': '400', src: `url("${BASE}assets/reggae-one-x${i}.woff2")`, 'unicode-range': r }));
    faces.push(face('Fnt_1', 'error', '400', r));
  }
  scanPreviewFontFailures(html + vivSheet.cssRules.map((r) => `url("${r.style.getPropertyValue('src').replace(/^url\("|"\)$/g, '')}")`).join(' '));
  const many = fontFailureSnapshot().count;
  tried.length = 0;
  await retryFontFailures();
  ok(many >= 40 && tried.length <= 2 * 8, `切れたままなら何百面も試さない(${many} 面のうち ${tried.length} 回で止めた)`);

  // ---- 読み直す(ネットが戻った) ----
  online = true;
  all = await retryFontFailures();
  s = fontFailureSnapshot();
  ok(all && s.count === 0 && s.epoch === epoch0 + 1, '戻ってから読み直すと、知らせは消え、組み直しの合図(epoch)が上がる', j(s));
  scanPreviewFontFailures(html);
  ok(fontFailureSnapshot().count === 0, '読み直せた面は、組み直しのあとの数え直しでも数えない(CSS の面は error のまま残るため)');

  // ---- 同じ Fnt_N が2つの面で別の書体を指すとき(2026-10-13 見直し) ----
  {
    const f9 = face('Fnt_9', 'error');
    const key = faceKey('Fnt_9', '400', 'normal', 'U+3000-303F');
    const one = new Map([[key, [`url("${A}")`]]]);
    const two = new Map([[key, [`url("${A}")`, `url("${OLD}")`]]]);
    const asFace = f9 as unknown as FontFace;
    ok(srcOf(asFace, one) === `url("${A}")`, '候補が1つなら、それを使う');
    ok(srcOf(asFace, two) === null, '候補が2つで絞る手がかりが無ければ、作り直さない(別の書体のファイルで面を作らない)');
    ok(srcOf(asFace, two, new Set([A])) === `url("${A}")`, 'いま組んでいる本のファイルに載っている候補に絞る');
    ok(srcOf(asFace, two, new Set([B])) === null, 'どの候補もいまの本に無ければ、作り直さない');
  }

  console.log(`\n${passed} ok / ${failed} NG`);
  process.exit(failed ? 1 : 0);
}
void main();
