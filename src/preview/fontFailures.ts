// 書体のファイルを読み込めなかったことを数えて、画面で知らせる。(2026-10-13 修正リスト 29)
//
// ## 何が起きていたか
//
// 書体は woff2 を unicode-range で分けて約 3,000 個あり、使う字の分だけ取りに行く。
// ネットが切れている・サーバーが断る(修正リスト 17 の Xserver の REFUSED_STREAM)と取得は失敗し、
// その字は**何も言わずに代わりの書体で組まれる**。下見でも書き出した PDF でも利用者の選んだ書体と違うのに、
// 刷り上がるまで気づけない(2026-10-13 オフラインの実測: Reggae One を選ぶと取得 420 件が失敗、
// document.fonts の error が 0→144、知らせはゼロ。表紙の書名もゴシックで描かれた)。
//
// ## どう数えるか
//
// - **本文の下見(Vivliostyle)**: 組版は本で使う @font-face を Fnt_N という名前に写して、アプリと同じ
//   document に <style> で積む(fontWaitGuard.ts)。組み上がるたび(と loadingerror のたび)に document.fonts を
//   for…of で回し、**Fnt_N の面のうち error のもの**を拾う。面の src から、アプリの @font-face の書体名を引く。
//   - Vivliostyle は一度作った面を使い回し、消さない。前に選んでいた書体の error の面も残るので、
//     **いま組んでいる HTML に載っているファイルの面だけ**を数える(書体を選び直したら消える)
//   - アプリの画面の字(書体の一覧の見本など)の失敗は数えない。本に出ないので
// - **表紙(canvas)**: src/cover/fontLoad.ts が、作り直しても読めなかった面をここへ渡す
//
// ## 読み直し
//
// error の面は error のまま戻らない(ページを読み込み直すまで)。そこで fontLoad.ts と同じく、
// **同じ @font-face から面を作り直して読み、document.fonts に足す**(あとから足した面のほうが先に使われる)。
// 読めたら下見を組み直す(epoch を上げる。VivliostylePreview が見ている)。
// ページの読み込み直しにしないのは、**ネットが切れたままだと、アプリそのものが開けなくなる**から
// (サービスワーカーが無い。調べの A_報告 3 章)。

import { BODY_FONTS } from '../models/project';
import { absolutize, familyNames } from '../typeset/fontface';
import { fontUrlsIn } from './fontPrefetch';
import { isVivliostyleFace } from './fontWaitGuard';

const unq = (s: string) => s.trim().replace(/^["']|["']$/g, '');
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 太さの書き方をそろえる(normal と 400、bold と 700 は同じ) */
function normWeight(w: string): string {
  const n = norm(w || '400');
  return n === 'normal' ? '400' : n === 'bold' ? '700' : n;
}
/** 字の範囲の書き方をそろえる(書いていないのは全部の字) */
function normRange(r: string): string {
  const n = norm(r || '');
  return n === '' ? 'u+0-10ffff' : n;
}

/** 面と @font-face をつき合わせる鍵(書体名・太さ・斜体・字の範囲) */
export function faceKey(family: string, weight: string, style: string, range: string): string {
  return [unq(family).toLowerCase(), normWeight(weight), norm(style || 'normal'), normRange(range)].join('|');
}

/**
 * ページのスタイルシートの @font-face を、鍵 → src(絶対アドレス)の表にする。
 * `only` を渡すと、その書体名の規則だけを表に入れる(全部で約 4,000 規則あるので、要る分だけ)
 */
export function srcIndex(only?: (family: string) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (typeof document === 'undefined') return out;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      const fam = unq(st.getPropertyValue('font-family'));
      if (only && !only(fam)) continue;
      const key = faceKey(fam, st.getPropertyValue('font-weight'), st.getPropertyValue('font-style'), st.getPropertyValue('unicode-range'));
      // **同じ鍵に別のファイルが来ることがある**(下見の面は2つあり、Vivliostyle は面ごとに Fnt_1 から数えるので、
      // 2つの面で初めて出た書体の順が違うと、同じ Fnt_4 が別の書体を指す)。先勝ちにせず、候補を全部持つ(2026-10-13 見直し)
      const src = absolutize(st.getPropertyValue('src'), sheet.href ?? document.baseURI);
      const list = out.get(key);
      if (!list) out.set(key, [src]);
      else if (!list.includes(src)) list.push(src);
    }
  }
  return out;
}

const keyOfFace = (f: FontFace) => faceKey(f.family, f.weight, f.style, f.unicodeRange);

/**
 * error の面と同じ書体名・太さ・字の範囲の @font-face の src。見つからなければ null。
 * 候補が2つ以上あるときは、`prefer`(いま組んでいる本の書体のファイル)に載っている1つに絞る。
 * **絞れなければ null**(別の書体のファイルで面を作り直すと、その範囲の字が下見で別の書体になる)
 */
export function srcOf(face: FontFace, index?: Map<string, string[]>, prefer?: ReadonlySet<string>): string | null {
  const fam = unq(face.family);
  const idx = index ?? srcIndex((f) => f.toLowerCase() === fam.toLowerCase());
  const list = idx.get(keyOfFace(face)) ?? [];
  if (list.length <= 1) return list[0] ?? null;
  if (!prefer) return null;
  const hit = list.filter((s) => {
    const u = fontUrlsIn(s)[0];
    return u !== undefined && prefer.has(u);
  });
  return hit.length === 1 ? hit[0]! : null;
}

/**
 * 作り直して読めた面(元の error の面で覚える)。CSS の面は error のまま残るので、
 * 次の書き出しでも document.fonts.load は落ちる。そのたびに作り直さないよう、済んだものは飛ばす。
 * 下見の数え直しでも、これに入っている面は数えない
 */
const repaired = new WeakSet<FontFace>();
export const isRepaired = (face: FontFace) => repaired.has(face);

/** 作り直した面を読む。断られたら間をおいて取り直す(`tries` 回まで) */
export async function reloadFace(
  face: FontFace,
  index?: Map<string, string[]>,
  tries = 4,
  prefer?: ReadonlySet<string>,
): Promise<boolean> {
  if (repaired.has(face)) return true;
  const src = srcOf(face, index, prefer);
  if (!src || typeof FontFace === 'undefined') return false;
  for (let attempt = 0; attempt < tries; attempt++) {
    const fresh = new FontFace(face.family, src, {
      weight: face.weight,
      style: face.style,
      unicodeRange: face.unicodeRange,
      display: face.display,
    });
    try {
      await fresh.load();
      document.fonts.add(fresh);
      repaired.add(face);
      return true;
    } catch {
      if (attempt + 1 < tries) await sleep(400 * (attempt + 1));
    }
  }
  return false;
}

/**
 * 画面に出す書体の名前。本文の書体の一覧(BODY_FONTS)の名前の頭(「｜」の前)にする。
 * 縦中横の数字の書体(amayadori-tcy-◯◯)は、その本文の書体の名前。一覧に無い書体はそのままの名前
 */
export function fontLabel(family: string): string {
  const f = unq(family);
  const tcy = /^amayadori-tcy-(.+)$/.exec(f);
  for (const [id, def] of Object.entries(BODY_FONTS)) {
    if (tcy ? id === tcy[1] : familyNames(def.stack)[0] === f) return def.label.split('｜')[0]!.trim();
  }
  return f;
}

// ---- 失敗の帳面 ----

export interface FontFailureSnap {
  /** 読めなかった書体の名前(画面に出す形。重ねない) */
  families: string[];
  /** 読めなかった面の数 */
  count: number;
  /** 読み直している最中 */
  retrying: boolean;
  /** 読み直して1面でも読めたら増える。下見と表紙はこれを見て組み直す・描き直す */
  epoch: number;
}

/** 本文の下見の失敗(面 → アプリの書体名) */
let preview = new Map<FontFace, string>();
/** 表紙の失敗 */
let cover = new Map<FontFace, string>();
let retrying = false;
let epoch = 0;
let snap: FontFailureSnap = { families: [], count: 0, retrying: false, epoch: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  const fams = new Set<string>();
  for (const f of [...preview.values(), ...cover.values()]) if (f) fams.add(fontLabel(f));
  const families = [...fams].sort();
  const count = preview.size + cover.size;
  if (
    snap.count === count &&
    snap.retrying === retrying &&
    snap.epoch === epoch &&
    snap.families.join('\n') === families.join('\n')
  )
    return;
  snap = { families, count, retrying, epoch };
  for (const l of listeners) l();
}

export function fontFailureSnapshot(): FontFailureSnap {
  return snap;
}
export function subscribeFontFailures(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** 帳面の最初の姿(何も失敗していない)。React の SSR 用(./useFontFailures.ts) */
export const EMPTY_FONT_FAILURES: FontFailureSnap = snap;

/** 知らせの文(下見・表紙の帯と、書き出しの「直すところ」の行で同じ文を使う) */
export function fontFailureText(s: Pick<FontFailureSnap, 'families'>): string {
  const names = s.families.join('・');
  return (
    `書体の一部を読み込めませんでした${names ? `（${names}）` : ''}。` +
    'このままだと、その字は別の書体で組まれます。ネットの接続を確かめて、［書体を読み直す］を押してください'
  );
}

// ---- 本文の下見 ----

/** いま組んでいる HTML に載っている書体のファイル */
let previewUrls = new Set<string>();
/** 書体のファイル → アプリの書体名(アプリの @font-face から作る。足りなければ作り直す) */
let urlFamily: Map<string, string> | null = null;

function buildUrlFamily(): Map<string, string> {
  const out = new Map<string, string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const fam = unq(rule.style.getPropertyValue('font-family'));
      if (isVivliostyleFace(fam)) continue;
      for (const u of fontUrlsIn(absolutize(rule.style.getPropertyValue('src'), sheet.href ?? document.baseURI)))
        if (!out.has(u)) out.set(u, fam);
    }
  }
  return out;
}

function familyOfUrl(url: string): string {
  if (!urlFamily?.has(url)) urlFamily = buildUrlFamily();
  return urlFamily.get(url) ?? '';
}

/**
 * 下見の組版の面のうち、読めなかったものを数え直す。組み上がったとき(VivliostylePreview)と、
 * 書体の読み込みが失敗したとき(loadingerror)に呼ぶ。
 * @param html いま組んだ組版の HTML。渡すと「いまの本の書体のファイル」を覚え直す
 */
export function scanPreviewFontFailures(html?: string): void {
  if (typeof document === 'undefined' || !document.fonts) return;
  if (html !== undefined) previewUrls = new Set(fontUrlsIn(html));
  const next = new Map<FontFace, string>();
  let index: Map<string, string[]> | null = null;
  // **for…of で回す。** forEach は Vivliostyle 向けに絞ってある(fontWaitGuard.ts)
  for (const face of document.fonts) {
    if (face.status !== 'error' || repaired.has(face) || !isVivliostyleFace(face.family)) continue;
    index ??= srcIndex(isVivliostyleFace);
    const src = srcOf(face, index, previewUrls);
    const url = src ? fontUrlsIn(src)[0] : undefined;
    if (!url || !previewUrls.has(url)) continue;
    next.set(face, familyOfUrl(url));
  }
  preview = next;
  emit();
}

let watching = false;
let scanTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * 書体の読み込みが失敗したら数え直す。組み上がりより後に落ちた面(組版は書体を待ち切らずに進むことがある)を拾う。
 * 一度に何百面も落ちるので、まとめて1回にする
 */
export function watchFontFailures(set: FontFaceSet | undefined = globalThis.document?.fonts): void {
  if (watching || !set || typeof set.addEventListener !== 'function') return;
  watching = true;
  set.addEventListener('loadingerror', () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scanPreviewFontFailures(), 400);
  });
}

// ---- 表紙 ----

/**
 * 表紙を描く前の読み込みで、作り直しても読めなかった面(src/cover/fontLoad.ts)。
 * **表紙の書体を全部読むたびに、そのときの結果で置き換える**(選び直した書体の古い失敗を残さない)
 */
export function setCoverFontFailures(faces: FontFace[]): void {
  cover = new Map(faces.map((f) => [f, unq(f.family)]));
  emit();
}

// ---- 読み直す ----

/**
 * 読めなかった面を作り直して読み直す。1面でも読めたら epoch を上げる(下見は組み直し、表紙は描き直す)。
 * **最初の数面が全部だめなら、そこでやめる**(ネットが切れたままなら、何百面を1面ずつ待たせることになる)。
 * 全部読めたら true
 */
export async function retryFontFailures(): Promise<boolean> {
  if (retrying) return false;
  const faces = [...new Set([...preview.keys(), ...cover.keys()])];
  if (faces.length === 0) return true;
  retrying = true;
  emit();
  const index = srcIndex();
  const queue = [...faces];
  let okCount = 0;
  let ngCount = 0;
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      // 読めた面がまだ1つも無いまま 4 面だめなら、つながっていない。残りは試さない
      if (okCount === 0 && ngCount >= 4) return;
      // 下見の面は、いま組んでいる本の書体のファイルに絞って作り直す(srcOf の候補が2つ以上のとき)
      if (await reloadFace(f, index, 2, preview.has(f) ? previewUrls : undefined)) okCount++;
      else ngCount++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, faces.length) }, worker));
  } finally {
    for (const f of faces) {
      if (!repaired.has(f)) continue;
      preview.delete(f);
      cover.delete(f);
    }
    retrying = false;
    if (okCount > 0) epoch++;
    emit();
  }
  return preview.size + cover.size === 0;
}

/** 検査用: 帳面を空にする */
export function resetFontFailuresForTest(): void {
  preview = new Map();
  cover = new Map();
  previewUrls = new Set();
  urlFamily = null;
  retrying = false;
  epoch = 0;
  emit();
}
