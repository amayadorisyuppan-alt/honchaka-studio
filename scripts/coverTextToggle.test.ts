// 表紙の［表紙に書名と著者名を入れる］(CoverSettings.frontTextOn。2026-10-13 ユーザー要望
// 「表紙にタイトルと著者名を入れた画像を自分で用意したい」)の検査。
//
// ## なぜ在るか
//
// - 欄の無い古い保存・既定(入れる)の表紙は、**描く手順が1つも変わらない**こと(書名の位置も帯も今までどおり)
// - 外したときは、表1の書名・著者名と帯**だけ**が消え、背の文字・表4(あらすじ・バーコードの目印)・地は1つも動かないこと。
//   紙の表紙(面ごと・まるごと1枚・中綴じ)と電子書籍の表紙の両方で
// - 読み込み(project/file.ts の sanitize・fromProjectFile)と自動保存の移し替え(migrateCoverSettings)が、
//   true / false / 無い / 壊れた値 を正しく扱うこと
// - 作り方ごとの控え(modeStash)には入れず、面ごと ⇄ まるごと1枚 を切り替えても値が変わらないこと
//
// Canvas は偽物(描いた手順を書き留めるだけ)で立てる。字の幅は「1字 = 字の大きさ」で測る。
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   node scripts/private/run-tests.mjs public    (または partner)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import {
  COVER_MODE_KEYS,
  computeCoverLayout,
  coverFrontTextOn,
  defaultCoverSettings,
  migrateCoverSettings,
  mmToPx,
  sanitizeCoverModeLook,
  swapCoverModeLook,
  type BandKind,
  type CoverAnchor,
  type CoverLayout,
  type CoverSettings,
} from '../src/models/cover';
import { renderEbookCover, renderPaperCover, type CoverText, type RenderReport } from '../src/cover/render';
import { defaultSettings } from '../src/models/project';
import { sampleManuscript } from '../src/sample';
import { fromProjectFile, sanitize, toProjectFile, type ProjectSnapshot } from '../src/project/file';

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

// ---------------------------------------------------------------------------
// 偽物の Canvas。描く手順(塗る・字を置く・絵を置く・画素を読む)を、そのときの色・濃さ・書体と一緒に書き留める
// ---------------------------------------------------------------------------

interface Op {
  /** 比べるための1行(数は小数3桁まで) */
  key: string;
  name: string;
  /** 座標のある手順の x(px)。字・塗り・画素の読み取り・切り抜きの枠 */
  x?: number;
  text?: string;
}

const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);

class FakeCtx {
  ops: Op[] = [];
  fillStyle = '#000000';
  strokeStyle = '#000000';
  globalAlpha = 1;
  font = '10px sans-serif';
  textBaseline = 'alphabetic';
  lineWidth = 1;
  lineJoin = 'miter';
  miterLimit = 10;
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  // **filter は持たない。** 帯の「ぼかす」は filter の無いブラウザの道(四角い帯)を通る
  private stack: Record<string, unknown>[] = [];
  private k = 1;
  /** getImageData が返す明るさ(0〜255)。帯の「おまかせ」の判断がこれで決まる */
  constructor(private lum = 128) {}
  /** その手順の刷り上がりに効く状態だけ(画素を読む・切り抜くなどは、色や書体に左右されない) */
  private state(name: string) {
    const a = `a=${r3(this.globalAlpha)}`;
    if (name === 'fillRect') return `fs=${this.fillStyle} ${a} `;
    if (name === 'fillText') return `fs=${this.fillStyle} ${a} font=${this.font} tb=${this.textBaseline}`;
    if (name === 'strokeText') return `ss=${this.strokeStyle} ${a} font=${this.font} tb=${this.textBaseline} lw=${r3(this.lineWidth)} lj=${this.lineJoin}`;
    if (name === 'strokeRect') return `ss=${this.strokeStyle} ${a} lw=${r3(this.lineWidth)}`;
    if (name === 'drawImage') return a;
    return '';
  }
  private rec(name: string, args: unknown[], x?: number, text?: string) {
    const a = args.map((v) => (typeof v === 'number' ? r3(v) : String(v))).join(',');
    this.ops.push({ key: `${name}(${a}) ${this.state(name)}`, name, x, text });
  }
  save() {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
      font: this.font,
      textBaseline: this.textBaseline,
      lineWidth: this.lineWidth,
      lineJoin: this.lineJoin,
      miterLimit: this.miterLimit,
    });
    this.rec('save', []);
  }
  restore() {
    Object.assign(this, this.stack.pop() ?? {});
    this.rec('restore', []);
  }
  scale(x: number, y: number) {
    this.k *= x;
    this.rec('scale', [x, y]);
  }
  translate(x: number, y: number) {
    this.rec('translate', [x, y], x);
  }
  rotate(a: number) {
    this.rec('rotate', [a]);
  }
  getTransform() {
    return { a: this.k };
  }
  getImageData(x: number, y: number, w: number, h: number) {
    this.rec('getImageData', [x, y, w, h], x / this.k);
    return { data: new Uint8ClampedArray(16).fill(this.lum) };
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rec('fillRect', [x, y, w, h], x);
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    this.rec('strokeRect', [x, y, w, h], x);
  }
  fillText(t: string, x: number, y: number) {
    this.rec('fillText', [t, x, y], x, t);
  }
  strokeText(t: string, x: number, y: number) {
    this.rec('strokeText', [t, x, y], x, t);
  }
  measureText(t: string) {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const size = m ? Number(m[1]) : 10;
    return { width: [...t].length * size };
  }
  drawImage(img: { width?: number }, ...args: number[]) {
    this.rec('drawImage', [img?.width ?? 0, ...args], args.length >= 8 ? args[4] : args[0]);
  }
  beginPath() {
    this.rec('beginPath', []);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.rec('rect', [x, y, w, h], x);
  }
  clip() {
    this.rec('clip', []);
  }
  setLineDash(d: number[]) {
    this.rec('setLineDash', [d.join(' ')]);
  }
}

function fakeCanvas(lum?: number) {
  const ctx = new FakeCtx(lum);
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, ctx };
}
const fakeImage = (w: number, h: number) => ({ width: w, height: h }) as unknown as HTMLImageElement;

// ---------------------------------------------------------------------------
// 描く本の組み合わせ
// ---------------------------------------------------------------------------

/** 縦に積んでも回したり寄せたりしない字だけ(偽物の座標が面の中に収まるように) */
const TEXT_V: CoverText = { title: '雨の窓辺で', author: '山田花子', publisher: 'あまやどり出版', vertical: true };
const TEXT_H: CoverText = { title: '夜明けまでの長い長い物語を君に', author: '山田花子', publisher: 'あまやどり出版', vertical: false };

type Ground = 'solid' | 'image' | 'wrap';
interface Case {
  name: string;
  layout: CoverLayout;
  text: CoverText;
  ground: Ground;
  band: BandKind;
  soft: boolean;
  anchor: CoverAnchor;
  forExport: boolean;
}

const layouts: [string, CoverLayout][] = [
  ['右綴じ', computeCoverLayout('bunko', 300, 'white', true)],
  ['左綴じ', computeCoverLayout('a5', 240, 'cream', false)],
  ['中綴じ', computeCoverLayout('b5', 24, 'white', false, { target: 'printshop', binding: 'saddle' })],
];

const cases: Case[] = [];
for (const [ln, layout] of layouts) {
  for (const text of [TEXT_V, TEXT_H]) {
    for (const ground of ['solid', 'image', 'wrap'] as Ground[]) {
      for (const band of ['auto', 'custom', 'outline', 'none'] as BandKind[]) {
        for (const anchor of ['auto', 'bottom-left'] as CoverAnchor[]) {
          cases.push({
            name: `${ln}・${text.vertical ? '縦' : '横'}・${ground}・帯${band}・${anchor}`,
            layout,
            text,
            ground,
            band,
            soft: band === 'custom',
            anchor,
            forExport: anchor === 'auto',
          });
        }
      }
    }
  }
}

function settingsOf(c: Case, front: boolean | undefined | 'absent'): CoverSettings {
  const s: CoverSettings = {
    ...defaultCoverSettings(),
    spineTextOn: true,
    spinePublisherOn: true,
    blurb: '雨の降る町で、ふたりは出会った。窓辺の席に座る少女と、傘を忘れた少年の、ひと夏の物語。',
    band: c.band,
    bandSoft: c.soft,
    titleAnchor: c.anchor,
    authorAnchor: c.anchor === 'auto' ? 'auto' : 'top-right',
    titleDx: c.anchor === 'auto' ? 0 : 4,
    authorDy: c.anchor === 'auto' ? 0 : -3,
    ...(c.ground === 'image' ? { background: { kind: 'image' as const, src: 'data:image/png;base64,AAAA' } } : {}),
    ...(c.ground === 'wrap' ? { mode: 'wrap' as const, wrap: { kind: 'image' as const, src: 'data:image/png;base64,AAAA' } } : {}),
  };
  if (front === 'absent') delete s.frontTextOn;
  else s.frontTextOn = front;
  return s;
}

function inputOf(c: Case, s: CoverSettings) {
  return {
    layout: c.layout,
    settings: s,
    text: c.text,
    image: c.ground === 'image' ? fakeImage(1600, 2560) : null,
    backImage: null,
    wrapImage: c.ground === 'wrap' ? fakeImage(4200, 2600) : null,
    forExport: c.forExport,
  };
}

function paper(c: Case, front: boolean | undefined | 'absent'): { ops: Op[]; report: RenderReport } {
  const { canvas, ctx } = fakeCanvas();
  const report = renderPaperCover(canvas, inputOf(c, settingsOf(c, front)));
  return { ops: ctx.ops, report };
}
function ebook(c: Case, front: boolean | undefined | 'absent'): Op[] {
  const { canvas, ctx } = fakeCanvas();
  renderEbookCover(canvas, inputOf(c, settingsOf(c, front)));
  return ctx.ops;
}

const same = (a: Op[], b: Op[]) => a.length === b.length && a.every((o, i) => o.key === b[i].key);
const isText = (o: Op) => o.name === 'fillText' || o.name === 'strokeText';

/** 頭と尻の一致を取り、ON から抜けたひと続きの手順を返す。off が ON から1か所を抜いた形でなければ null */
function removedChunk(on: Op[], off: Op[]): Op[] | null {
  let p = 0;
  while (p < off.length && p < on.length && on[p].key === off[p].key) p++;
  let s = 0;
  while (s < off.length - p && s < on.length - p && on[on.length - 1 - s].key === off[off.length - 1 - s].key) s++;
  return p + s === off.length ? on.slice(p, on.length - s) : null;
}

// ---------------------------------------------------------------------------
// 1. 既定・欄の無い古い保存は、今までと同じ手順で描く
// ---------------------------------------------------------------------------
ok(coverFrontTextOn({}) === true, 'coverFrontTextOn: 欄が無ければ入れる');
ok(coverFrontTextOn({ frontTextOn: undefined }) === true, 'coverFrontTextOn: undefined は入れる');
ok(coverFrontTextOn({ frontTextOn: true }) === true, 'coverFrontTextOn: true は入れる');
ok(coverFrontTextOn({ frontTextOn: false }) === false, 'coverFrontTextOn: false だけ入れない');
ok(defaultCoverSettings().frontTextOn === true, '既定は入れる(［すべてリセット］で戻る)');

for (const c of cases) {
  const on = paper(c, true);
  const undef = paper(c, undefined);
  const absent = paper(c, 'absent');
  ok(same(on.ops, undef.ops), `紙 ${c.name}: undefined は true と同じ手順`);
  ok(same(on.ops, absent.ops), `紙 ${c.name}: 欄が無い保存は true と同じ手順`);
  ok(JSON.stringify(on.report) === JSON.stringify(absent.report), `紙 ${c.name}: 欄が無い保存は報告も同じ`);
  ok(same(ebook(c, true), ebook(c, 'absent')), `電子 ${c.name}: 欄が無い保存は true と同じ手順`);
}

// ---------------------------------------------------------------------------
// 2. 外すと、表1の書名・著者名と帯だけが消える
// ---------------------------------------------------------------------------
for (const c of cases) {
  const L = c.layout;
  const fx0 = mmToPx(L.front.x0);
  const fx1 = mmToPx(L.front.x1);
  const inFront = (o: Op) => o.x !== undefined && o.x >= fx0 - 0.5 && o.x <= fx1 + 0.5;
  const inRange = (o: Op, a: number, b: number) => o.x !== undefined && o.x >= mmToPx(a) - 0.5 && o.x <= mmToPx(b) + 0.5;
  const on = paper(c, true);
  const off = paper(c, false);

  // 抜けたのはひと続きの表1の手順だけ(地・背・表4は頭と尻で一致する)
  const chunk = removedChunk(on.ops, off.ops);
  ok(chunk !== null, `紙 ${c.name}: 外したときの手順は、入れたときから表1の文字の所を抜いただけ`, `${off.ops.length} / ${on.ops.length}`);
  if (chunk) {
    ok(chunk.some((o) => isText(o) && o.text?.includes(c.text.title[0])), `紙 ${c.name}: 抜けた所に書名がある`);
    ok(chunk.some((o) => isText(o) && o.text?.includes(c.text.author[0])), `紙 ${c.name}: 抜けた所に著者名がある`);
    const outside = chunk.filter((o) => o.x !== undefined && !inFront(o));
    ok(outside.length === 0, `紙 ${c.name}: 抜けた手順はみな表1の中`, outside.map((o) => o.key).join(' / '));
    // 帯を敷く読ませ方(下に帯を敷く・おまかせで表1の絵の上)なら、抜けた所に帯の塗りがある。
    // おまかせは表1の絵(面ごとの自前の画像)のときだけ敷く(単色の地・まるごと1枚では敷かない。render.ts の paintFront)
    const bandDrawn = c.band === 'custom' || (c.band === 'auto' && c.ground === 'image');
    if (bandDrawn) {
      ok(chunk.some((o) => o.name === 'fillRect' && / a=0\.85 /.test(o.key)), `紙 ${c.name}: 抜けた所に帯がある`);
    }
    if (c.band === 'outline') ok(chunk.some((o) => o.name === 'strokeText'), `紙 ${c.name}: 抜けた所にフチがある`);
  }
  // 外したほうには、表1に字も帯も無い(地の塗り・絵だけ)
  const offFront = off.ops.filter(inFront);
  ok(!offFront.some(isText), `紙 ${c.name}: 外すと表1に字が無い`);
  ok(
    !offFront.some((o) => o.name === 'fillRect' && / a=0\.85 /.test(o.key)),
    `紙 ${c.name}: 外すと表1に帯が無い`,
  );
  // 背の文字と表4は1つも変わらない
  const spineOps = (ops: Op[]) => ops.filter((o) => L.spine > 0 && inRange(o, L.spineArea.x0, L.spineArea.x1) && !inFront(o));
  const backOps = (ops: Op[]) => ops.filter((o) => inRange(o, L.back.x0, L.back.x1) && !inFront(o));
  ok(same(spineOps(on.ops), spineOps(off.ops)), `紙 ${c.name}: 背の手順は同じ`);
  ok(same(backOps(on.ops), backOps(off.ops)), `紙 ${c.name}: 表4の手順は同じ`);
  if (L.spineTextAllowed) {
    ok(spineOps(off.ops).some(isText), `紙 ${c.name}: 外しても背の文字は刷る`);
  }
  ok(backOps(off.ops).some((o) => isText(o) && o.text?.includes('雨の降る')), `紙 ${c.name}: 外してもあらすじは刷る`);
  // 報告: あらすじ・背のあふれと背の大きさは同じ。色の判断はしていないので picked
  ok(on.report.blurbOverflow === off.report.blurbOverflow, `紙 ${c.name}: あらすじのあふれは同じ`);
  ok(on.report.spineOverflow === off.report.spineOverflow, `紙 ${c.name}: 背のあふれは同じ`);
  ok(JSON.stringify(on.report.spine) === JSON.stringify(off.report.spine), `紙 ${c.name}: 背の大きさは同じ`);
  ok(off.report.frontInk === 'picked', `紙 ${c.name}: 外すと色の断り書きは出ない(picked)`);

  // 電子書籍の表紙(EPUB の表紙もこれ)。外したほうは、入れたときの地の手順で終わる
  const eOn = ebook(c, true);
  const eOff = ebook(c, false);
  ok(eOff.length < eOn.length && eOff.every((o, i) => o.key === eOn[i].key), `電子 ${c.name}: 外すと地だけを描いて終わる`);
  ok(!eOff.some(isText), `電子 ${c.name}: 外すと字が無い`);
  ok(eOn.slice(eOff.length).some((o) => isText(o) && o.text?.includes(c.text.title[0])), `電子 ${c.name}: 入れたときは書名がある`);
  ok(!eOff.some((o) => o.name === 'fillRect' && / a=0\.85 /.test(o.key)), `電子 ${c.name}: 外すと帯が無い`);
}

// 縮める倍率を掛けた書き出し(outputScale)でも同じ
{
  const c = cases[0];
  const run = (front: boolean) => {
    const { canvas, ctx } = fakeCanvas();
    renderPaperCover(canvas, { ...inputOf(c, settingsOf(c, front)), forExport: true, outputScale: 350 / 300 });
    return ctx.ops;
  };
  const chunk = removedChunk(run(true), run(false));
  ok(chunk !== null && chunk.some(isText), '紙 書き出しの倍率つき: 外すと表1の文字の所だけが抜ける');
}

// ---------------------------------------------------------------------------
// 3. 作り方ごとの控えには入れない(面ごと ⇄ まるごと1枚 で値が変わらない)
// ---------------------------------------------------------------------------
ok(!(COVER_MODE_KEYS as readonly string[]).includes('frontTextOn'), '控えの欄(COVER_MODE_KEYS)に入れない');
{
  let s: CoverSettings = { ...defaultCoverSettings(), frontTextOn: false, mode: 'faces', band: 'none' };
  const p1 = swapCoverModeLook(s);
  ok(!('frontTextOn' in p1), '切り替えの patch に frontTextOn は入らない');
  ok(!('frontTextOn' in (p1.modeStash ?? {})), '控えに frontTextOn は入らない');
  s = { ...s, mode: 'wrap', ...p1 };
  ok(s.frontTextOn === false, 'まるごと1枚へ切り替えても外したまま');
  const p2 = swapCoverModeLook(s);
  s = { ...s, mode: 'faces', ...p2 };
  ok(s.frontTextOn === false, '面ごとへ戻しても外したまま');
  ok(s.band === 'none', '飾りはこれまでどおり控えと入れ替わる(帯は元の値)');
  // 手で書いた .json の控えに紛れていても、控えを漉す所で落ちる(切り替えで値が化けない)
  const st = sanitizeCoverModeLook({ frontTextOn: true, band: 'custom' });
  ok(st !== undefined && !('frontTextOn' in st) && st.band === 'custom', '控えを漉すと frontTextOn は落ちる');
  const s3: CoverSettings = { ...defaultCoverSettings(), frontTextOn: false, modeStash: st };
  ok({ ...s3, ...swapCoverModeLook(s3) }.frontTextOn === false, '漉した控えと入れ替えても外したまま');
}

// ---------------------------------------------------------------------------
// 4. 自動保存の移し替え(useProject の hydrate と同じ重ね方)
// ---------------------------------------------------------------------------
const hydrate = (saved: Record<string, unknown>): CoverSettings =>
  ({ ...defaultCoverSettings(), ...saved, ...migrateCoverSettings(saved) }) as CoverSettings;
{
  const base = { ...defaultCoverSettings() } as Record<string, unknown>;
  delete base.frontTextOn;
  ok(!('frontTextOn' in migrateCoverSettings(base)), '移し替え: 欄の無い保存には何も足さない');
  ok(hydrate(base).frontTextOn === true, '移し替え: 欄の無い保存は入れる');
  ok(hydrate({ ...base, frontTextOn: false }).frontTextOn === false, '移し替え: false は外したまま');
  ok(hydrate({ ...base, frontTextOn: true }).frontTextOn === true, '移し替え: true は入れたまま');
  for (const bad of ['false', 0, 1, null, {}, []]) {
    ok(migrateCoverSettings({ ...base, frontTextOn: bad }).frontTextOn === true, `移し替え: 壊れた値 ${JSON.stringify(bad)} は入れる側へ`);
    ok(hydrate({ ...base, frontTextOn: bad }).frontTextOn === true, `移し替え: 壊れた値 ${JSON.stringify(bad)} を重ねても入れる`);
  }
}

// ---------------------------------------------------------------------------
// 5. 読み込み(project/file.ts)
// ---------------------------------------------------------------------------
const LABEL = '表紙に書名と著者名を入れるか';
function snapshot(front: unknown): ProjectSnapshot {
  const cover = { ...defaultCoverSettings() } as CoverSettings;
  if (front === 'absent') delete cover.frontTextOn;
  else (cover as unknown as Record<string, unknown>).frontTextOn = front;
  return { settings: defaultSettings(), cover, manuscript: sampleManuscript(), source: null };
}
{
  // 別の本として読む(欄の補いはしない)
  for (const [v, want] of [[true, true], [false, false], ['absent', undefined]] as const) {
    const r = sanitize(snapshot(v), snapshot(true), true);
    ok(r.project.cover.frontTextOn === want, `読み込み: ${String(v)} はそのまま`, String(r.project.cover.frontTextOn));
    ok(!r.fixed.includes(LABEL), `読み込み: ${String(v)} は知らせない`);
  }
  // 壊れた値は、いま開いている本の値に戻して知らせる
  for (const bad of ['false', 'true', 0, 1, null, {}, []]) {
    for (const now of [true, false, 'absent'] as const) {
      const r = sanitize(snapshot(bad), snapshot(now), true);
      const want = now === 'absent' ? undefined : now;
      ok(r.project.cover.frontTextOn === want, `読み込み: 壊れた値 ${JSON.stringify(bad)}(いまは ${String(now)})はいまの値へ`, String(r.project.cover.frontTextOn));
      ok(r.fixed.includes(LABEL), `読み込み: 壊れた値 ${JSON.stringify(bad)} は知らせる`);
    }
  }
  // AI 用の JSON(同じ本・画像なし)で欄が丸ごと無い: 外してある本だけ外したまま残して知らせる
  {
    const r = sanitize(snapshot('absent'), snapshot(false), false, true);
    ok(r.project.cover.frontTextOn === false && r.fixed.includes(LABEL), 'AI の JSON: 欄が消えても外した本は外したまま(知らせる)');
    const r2 = sanitize(snapshot('absent'), snapshot(true), false, true);
    ok(r2.project.cover.frontTextOn === undefined && !r2.fixed.includes(LABEL), 'AI の JSON: 入れている本は何もしない(知らせない)');
    const r3 = sanitize(snapshot('absent'), snapshot(false), false, false);
    ok(r3.project.cover.frontTextOn === undefined && !r3.fixed.includes(LABEL), '控え(画像込み): 欄が無いのは保存したときのまま(補わない)');
  }
  // ファイルを通した往復
  {
    const cur = snapshot(false);
    const text = toProjectFile(cur, false);
    ok(JSON.parse(text).cover.frontTextOn === false, '書き出した .json に false が入る');
    const back = fromProjectFile(text, cur);
    ok(back.project.cover.frontTextOn === false, '読み戻しても外したまま');
    ok(!back.warnings.some((w) => w.includes(LABEL)), '読み戻しで知らせは出ない');
    const dropped = JSON.parse(text);
    delete dropped.cover.frontTextOn;
    const back2 = fromProjectFile(JSON.stringify(dropped), cur);
    ok(back2.project.cover.frontTextOn === false, 'AI が欄を落としても外したまま');
    ok(back2.warnings.some((w) => w.includes(LABEL)), 'AI が欄を落としたら知らせる');
    const broken = JSON.parse(text);
    broken.cover.frontTextOn = 'no';
    const back3 = fromProjectFile(JSON.stringify(broken), snapshot(true));
    ok(back3.project.cover.frontTextOn === true && back3.warnings.some((w) => w.includes(LABEL)), '壊れた値はいまの値(入れる)に戻して知らせる');
  }
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
