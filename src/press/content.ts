// PDF の「描く命令」(content stream)を、字句に分けて命令単位で読み書きする土台。
//
// 入稿用の変換では、描く命令の色(rg / RG / k / K …)を書き換える場面が3つある(neutral.ts・inkLimit.ts・inspect.ts)。
// **正規表現で書き換えない。** 文字列の中の「0 0 0 rg」や、インライン画像のバイト列の中の「 EI 」を壊すから。
// ここは字句を正しく切り、命令(オペランド + オペレータ)の範囲を返し、
// **触らない所は1バイトも変えずに**置き換える(rewriteOperations)。
//
// ストリームを読み書きする部分(Flate・Predictor)と、文書の中の「描く命令を持つもの」を全部たどる部分(contentHolders)も、
// 3つの部品が同じものを使うのでここに置く。
//
// Node 24 でそのまま動く書き方にしてある(scripts/press/content.test.ts が node で回す)。ブラウザ専用の物は使わない。
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';

// ───────────────────────── 字句 ─────────────────────────

/**
 * 字句の種類。
 *
 * - `true` `false` `null` は **'keyword'**(オペレータにすると、BDC の辞書の中などで命令の区切りが狂う。
 *   name にすると「/true」と見分けがつかない。どちらでもない専用の型にして、オペランドとして扱う)。
 * - `{` `}` と、対のない `)` `>` は 1文字の 'operator'(content stream には出ないはずだが、
 *   壊れた入力でも無限ループにも例外にもしないために、読み飛ばさず字句にする)。
 */
export type TokenType =
  | 'number'
  | 'name'
  | 'string'
  | 'hex'
  | 'arrayOpen'
  | 'arrayClose'
  | 'dictOpen'
  | 'dictClose'
  | 'operator'
  | 'inlineImage'
  | 'keyword';

export interface Token {
  type: TokenType;
  start: number;
  end: number;
  /** number のときの値 */
  num?: number;
  /** name(先頭の / は除く。#xx は戻す)・operator・keyword の文字 */
  text?: string;
  /** inlineImage のときだけ: 画像のバイト列の範囲(ID の後の空白1つの次 〜 EI の前の空白の手前) */
  dataStart?: number;
  dataEnd?: number;
  /** inlineImage のときだけ: BI と ID のあいだの辞書(/W 2 /H 2 /CS /RGB …)の字句。キーと値が交互に並ぶ */
  imageDict?: Token[];
}

// 0 = 普通の文字、1 = 空白、2 = 区切り
const CLS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) CLS[c] = 1;
for (const c of '()<>[]{}/%') CLS[c.charCodeAt(0)] = 2;

const LF = 0x0a;
const CR = 0x0d;

/** 数の字句を読む。数でなければ NaN。+3 / -.5 / 4. / .5 を読む。指数表記・「--5」は数にしない(オペレータ扱いになる) */
function parseNum(b: Uint8Array, s: number, e: number): number {
  let p = s;
  let neg = false;
  if (b[p] === 0x2b || b[p] === 0x2d) {
    neg = b[p] === 0x2d;
    p++;
  }
  let mant = 0;
  let frac = 0;
  let dot = false;
  let any = false;
  for (; p < e; p++) {
    const d = b[p] - 48;
    if (d >= 0 && d <= 9) {
      any = true;
      mant = mant * 10 + d;
      if (dot) frac++;
    } else if (b[p] === 0x2e && !dot) dot = true;
    else return NaN;
  }
  if (!any) return NaN;
  // 仮数を整数で溜めて最後に 10 の冪で割る。Number('0.1') と同じ丸めになる(15桁まで)
  const v = frac === 0 ? mant : mant / 10 ** frac;
  return neg ? -v : v;
}

function latin1(b: Uint8Array, s: number, e: number): string {
  let out = '';
  // 1度に渡す数を絞る(巨大な引数展開を避ける)
  for (let i = s; i < e; i += 4096) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 4096)) as unknown as number[]);
  return out;
}

const shortText = new Map<number, string>();
/** オペレータの文字。rg・Tj・T* など3文字までは使い回す(数百万回出るので) */
function opText(b: Uint8Array, s: number, e: number): string {
  const len = e - s;
  if (len > 3) return latin1(b, s, e);
  const key = len === 1 ? b[s] : len === 2 ? b[s] | (b[s + 1] << 8) : b[s] | (b[s + 1] << 8) | (b[s + 2] << 16);
  const k = key + len * 0x1000000;
  let t = shortText.get(k);
  if (t === undefined) {
    t = latin1(b, s, e);
    shortText.set(k, t);
  }
  return t;
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

function nameText(b: Uint8Array, s: number, e: number): string {
  if (b.subarray(s, e).indexOf(0x23) < 0) return latin1(b, s, e);
  let out = '';
  for (let i = s; i < e; i++) {
    if (b[i] === 0x23 && i + 2 < e && hexVal(b[i + 1]) >= 0 && hexVal(b[i + 2]) >= 0) {
      out += String.fromCharCode(hexVal(b[i + 1]) * 16 + hexVal(b[i + 2]));
      i += 2;
    } else out += String.fromCharCode(b[i]);
  }
  return out;
}

interface Lexer {
  b: Uint8Array;
  i: number;
}

/** 次の字句を1つ読む(空白とコメントは飛ばす)。終わりなら null。**必ず i が進む**ので、どんな入力でも止まる */
function readToken(L: Lexer): Token | null {
  const b = L.b;
  const n = b.length;
  let i = L.i;
  for (;;) {
    if (i >= n) {
      L.i = n;
      return null;
    }
    const c = b[i];
    if (CLS[c] === 1) {
      i++;
      continue;
    }
    if (c === 0x25) {
      // コメント: 行末まで。CR・LF のどちらでも終わる
      while (i < n && b[i] !== LF && b[i] !== CR) i++;
      continue;
    }
    break;
  }
  const start = i;
  const c = b[i];
  switch (c) {
    case 0x28: {
      // 文字列。かっこは入れ子になれる。\ の次の1文字は意味を見ずに飛ばす(\( \) \\ \ddd の先頭 行末の継続、全部これで足りる)
      let depth = 1;
      i++;
      while (i < n) {
        const d = b[i];
        if (d === 0x5c) i += 2;
        else if (d === 0x28) {
          depth++;
          i++;
        } else if (d === 0x29) {
          i++;
          if (--depth === 0) break;
        } else i++;
      }
      if (i > n) i = n; // 末尾が \ で終わる壊れた文字列
      L.i = i;
      return { type: 'string', start, end: i };
    }
    case 0x3c: {
      if (b[i + 1] === 0x3c) {
        L.i = i + 2;
        return { type: 'dictOpen', start, end: i + 2 };
      }
      const close = b.indexOf(0x3e, i + 1);
      const end = close < 0 ? n : close + 1;
      L.i = end;
      return { type: 'hex', start, end };
    }
    case 0x3e: {
      if (b[i + 1] === 0x3e) {
        L.i = i + 2;
        return { type: 'dictClose', start, end: i + 2 };
      }
      L.i = i + 1;
      return { type: 'operator', start, end: i + 1, text: '>' };
    }
    case 0x5b:
      L.i = i + 1;
      return { type: 'arrayOpen', start, end: i + 1 };
    case 0x5d:
      L.i = i + 1;
      return { type: 'arrayClose', start, end: i + 1 };
    case 0x7b:
    case 0x7d:
    case 0x29:
      L.i = i + 1;
      return { type: 'operator', start, end: i + 1, text: String.fromCharCode(c) };
    case 0x2f: {
      let j = i + 1;
      while (j < n && CLS[b[j]] === 0) j++;
      L.i = j;
      return { type: 'name', start, end: j, text: nameText(b, i + 1, j) };
    }
  }
  // 普通の文字の連なり: 数・true/false/null・オペレータ
  let j = i + 1;
  while (j < n && CLS[b[j]] === 0) j++;
  L.i = j;
  const v = parseNum(b, i, j);
  if (v === v) return { type: 'number', start, end: j, num: v };
  const len = j - i;
  if (len === 4 && b[i] === 0x74 && b[i + 1] === 0x72 && b[i + 2] === 0x75 && b[i + 3] === 0x65) return { type: 'keyword', start, end: j, text: 'true' };
  if (len === 4 && b[i] === 0x6e && b[i + 1] === 0x75 && b[i + 2] === 0x6c && b[i + 3] === 0x6c) return { type: 'keyword', start, end: j, text: 'null' };
  if (len === 5 && b[i] === 0x66 && b[i + 1] === 0x61 && b[i + 2] === 0x6c && b[i + 3] === 0x73 && b[i + 4] === 0x65) return { type: 'keyword', start, end: j, text: 'false' };
  return { type: 'operator', start, end: j, text: opText(b, i, j) };
}

/**
 * BI の字句を読んだ直後に呼ぶ。ID までの辞書を読み、生のバイト列を EI まで飛ばして、1つの 'inlineImage' 字句にして返す。
 *
 * 終わりの決め方: 辞書に /L か /Length があれば、その長さの先に(空白をはさんで)EI があるかを先に確かめる
 * (バイト列の中に「 EI 」が偶然あっても、長さで正しく切れる)。なければ「空白 + EI + 空白か終端」が最初に出る所。
 * ID の後の空白は1つだけが区切り(CR LF は1つの改行として2バイト飛ばす)。**1バイトずつ見ず、'E' を indexOf で探す**
 */
function readInlineImage(L: Lexer, bi: Token): Token {
  const b = L.b;
  const n = b.length;
  const dict: Token[] = [];
  let id: Token | null = null;
  for (;;) {
    const u = readToken(L);
    if (!u) break;
    if (u.type === 'operator' && u.text === 'ID') {
      id = u;
      break;
    }
    dict.push(u);
  }
  if (!id) {
    // ID が無いまま終わった(壊れた入力)。読めた所までを画像として返す
    return { type: 'inlineImage', start: bi.start, end: n, text: 'BI', dataStart: n, dataEnd: n, imageDict: dict };
  }
  let p = id.end;
  if (p < n && CLS[b[p]] === 1) p += b[p] === CR && b[p + 1] === LF ? 2 : 1;
  if (p > n) p = n;

  const isEnd = (k: number) => b[k] === 0x45 && b[k + 1] === 0x49 && (k + 2 >= n || CLS[b[k + 2]] === 1);
  let dataEnd = -1;
  let end = -1;
  let len = -1;
  for (let k = 0; k + 1 < dict.length; k++) {
    const key = dict[k];
    if (key.type === 'name' && (key.text === 'L' || key.text === 'Length') && dict[k + 1].type === 'number') len = dict[k + 1].num as number;
  }
  if (len >= 0 && p + len <= n) {
    let q = p + len;
    while (q < n && CLS[b[q]] === 1) q++;
    if (isEnd(q)) {
      dataEnd = p + len;
      end = q + 2;
    }
  }
  if (end < 0) {
    // ID の後の空白が「EI の前の空白」を兼ねることがある(中身が空の画像)ので、1つ手前から探す
    const from = Math.max(p - 1, id.end);
    let k = b.indexOf(0x45, from + 1);
    while (k >= 0) {
      if (CLS[b[k - 1]] === 1 && isEnd(k)) {
        dataEnd = Math.max(p, k - 1);
        end = k + 2;
        break;
      }
      k = b.indexOf(0x45, k + 1);
    }
    if (end < 0) {
      dataEnd = n;
      end = n;
    }
  }
  L.i = end;
  return { type: 'inlineImage', start: bi.start, end, text: 'BI', dataStart: p, dataEnd, imageDict: dict };
}

/** 字句を1つずつ渡す。BI は ID・画像のバイト列・EI までを1つの inlineImage にして渡す */
function scan(bytes: Uint8Array, emit: (t: Token) => void): void {
  const L: Lexer = { b: bytes, i: 0 };
  for (;;) {
    const t = readToken(L);
    if (!t) return;
    if (t.type === 'operator' && t.text === 'BI') emit(readInlineImage(L, t));
    else emit(t);
  }
}

/** content stream を字句に分ける。空白とコメント(% から行末)は捨てる */
export function tokenize(bytes: Uint8Array): Token[] {
  const out: Token[] = [];
  scan(bytes, (t) => out.push(t));
  return out;
}

export interface Operation {
  /** オペレータ('rg' 'Tj' 'BI' など) */
  op: string;
  /**
   * オペランドの字句。配列・辞書は**平らに**並ぶ(TJ なら arrayOpen・string・number … arrayClose)。
   * BI は、BI と ID のあいだの辞書の字句(/W 2 /H 2 /CS /RGB …)が入る(inspect が色空間を見るため)
   */
  operands: Token[];
  /** 命令全体の範囲(最初のオペランドの頭〜オペレータの終わり) */
  start: number;
  end: number;
  /** BI のときだけ: 元の inlineImage の字句(バイト列の範囲を持つ) */
  image?: Token;
}

function scanOperations(bytes: Uint8Array, emit: (o: Operation) => void): void {
  let pending: Token[] = [];
  scan(bytes, (t) => {
    if (t.type === 'operator') {
      emit({ op: t.text as string, operands: pending, start: pending.length ? pending[0].start : t.start, end: t.end });
      pending = [];
    } else if (t.type === 'inlineImage') {
      // BI の前にオペランドが残っていても(壊れた入力)、命令には含めない。元のバイトはそのまま残る
      emit({ op: 'BI', operands: t.imageDict ?? [], start: t.start, end: t.end, image: t });
      pending = [];
    } else pending.push(t);
  });
  // 最後にオペレータの無いオペランドが残っても捨てる(壊れた入力)
}

/**
 * 命令を1つずつ渡す。**配列を作らない**ので、100MB の描く命令でも一時のメモリは小さいまま(rewriteOperations と同じ読み方)。
 * `operations()` は全命令を配列にするので、388万命令(100MB)で Node のヒープが尽きて落ちた(2026-10-01 実測)。
 * 渡した Operation は、そのあと使い回されない(取っておいてよい)が、取っておくと配列と同じことになる
 */
export function forEachOperation(bytes: Uint8Array, fn: (o: Operation) => void): void {
  scanOperations(bytes, fn);
}

export function operations(bytes: Uint8Array): Operation[] {
  const out: Operation[] = [];
  scanOperations(bytes, (o) => out.push(o));
  return out;
}

/**
 * fn が文字列を返した命令だけ、その範囲を置き換える。null/undefined は触らない。変えなかった所はバイト単位で元のまま。
 * 置き換えの文字列は ASCII(1文字1バイトで書く)。何も変えなかったときは、渡された bytes そのものを返す
 */
export function rewriteOperations(
  bytes: Uint8Array,
  fn: (o: Operation) => string | null | undefined,
): { bytes: Uint8Array; changed: number } {
  const parts: Uint8Array[] = [];
  let last = 0;
  let total = 0;
  scanOperations(bytes, (o) => {
    const r = fn(o);
    if (typeof r !== 'string') return;
    const rep = new Uint8Array(r.length);
    for (let i = 0; i < r.length; i++) rep[i] = r.charCodeAt(i) & 0xff;
    parts.push(bytes.subarray(last, o.start), rep);
    last = o.end;
    total++;
  });
  if (total === 0) return { bytes, changed: 0 };
  parts.push(bytes.subarray(last));
  return { bytes: concat(parts), changed: total };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** PDF に書ける数の文字(指数表記にしない。小数は最大5桁、末尾の 0 を落とす。-0 は 0) */
export function pdfNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // toFixed は 1e21 以上で指数表記になる。PDF の数として意味のある大きさではないので、整数で丸める
  if (Math.abs(n) >= 1e15) return BigInt(Math.round(n)).toString();
  let s = n.toFixed(5);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

// ───────────────────────── ストリームの読み書き ─────────────────────────

const HINT_MAX = 2 ** 30;

/**
 * 変換の出口を最後まで読んで、1本のバイト列にする。sizeHint(出来上がりの大きさの見込み)があれば、その大きさの入れ物へ直に書く
 * (見込みが外れて超えたら、そこから先はかたまりのまま集めてつなぐ)。
 *
 * なぜ自前で読むのか: 前の `new Response(stream).arrayBuffer()` は、かたまりを集めて**もう1度**つなぐので、
 * ほどいた大きさの2倍が一時的に要る(2026-10-01 実測、400MB を圧縮→ほどくときの RSS の最大: 前 1706MB → 見込みつきで 867MB)
 */
async function drain(readable: ReadableStream<Uint8Array>, sizeHint?: number): Promise<Uint8Array> {
  const reader = readable.getReader();
  // 画像の幅・高さは PDF の自己申告なので、嘘や壊れた値で巨大な入れ物を作らないよう上限を置く
  let buf: Uint8Array | null = sizeHint && sizeHint > 0 && sizeHint <= HINT_MAX ? new Uint8Array(sizeHint) : null;
  let fill = 0;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (buf && fill + value.length <= buf.length) {
      buf.set(value, fill);
      fill += value.length;
    } else {
      if (buf) {
        parts.push(buf.subarray(0, fill));
        buf = null;
      }
      parts.push(value);
    }
    total += value.length;
  }
  // 申告よりずっと小さかったときは、余った入れ物を持ち続けないよう詰め直す
  if (buf) return fill * 2 < buf.length ? buf.slice(0, fill) : buf.subarray(0, fill);
  return parts.length === 1 ? parts[0] : concat(parts);
}

/** 入力を 1MB ずつ流し込む。Blob に包むと入力の複製が丸ごとできる(400MB を圧縮するだけで RSS が 820MB 増えた。この書き方は 11MB 増) */
async function pipeBytes(data: Uint8Array, ts: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> }, sizeHint?: number): Promise<Uint8Array> {
  const writer = ts.writable.getWriter();
  const reading = drain(ts.readable, sizeHint);
  const SLICE = 1 << 20;
  // 読む側を先に走らせておく(書くだけだと、出口が詰まって書き込みが止まる)
  const writing = (async () => {
    for (let i = 0; i < data.length; i += SLICE) await writer.write(data.subarray(i, Math.min(data.length, i + SLICE)) as BufferSource);
    await writer.close();
  })();
  try {
    const [out] = await Promise.all([reading, writing]);
    return out;
  } catch (e) {
    // 壊れた入力で読む側が先に落ちても、書く側の失敗を取りこぼさない(未処理の拒否にしない)
    writing.catch(() => {});
    reading.catch(() => {});
    throw e;
  }
}

/**
 * FlateDecode を戻す。PDF の Flate は zlib 形式なので DecompressionStream の 'deflate' がそのまま使える。壊れていれば例外。
 * sizeHint はほどいた大きさの見込み(画像なら 幅×高さ×成分数)。当たっていれば、ほどく間の一時的な複製が要らない
 */
export async function inflate(data: Uint8Array, sizeHint?: number): Promise<Uint8Array> {
  return pipeBytes(data, new DecompressionStream('deflate') as never, sizeHint);
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipeBytes(data, new CompressionStream('deflate') as never);
}

const N_FILTER = PDFName.of('Filter');
const N_PARMS = PDFName.of('DecodeParms');

function numOf(d: PDFDict | null, key: string, dflt: number): number {
  const v = d?.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : dflt;
}

/** 辞書の項目が「辞書または null」でないときも例外にしない読み方 */
function asDict(v: unknown): PDFDict | null {
  return v instanceof PDFDict ? v : null;
}

/** PNG の予測(10〜15)を戻す。行ごとの先頭1バイトが、その行の方式(0 なし・1 左・2 上・3 平均・4 Paeth) */
function undoPng(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const stride = rowBytes + 1;
  const rows = Math.ceil(data.length / stride);
  if (rowBytes <= 0 || rows <= 0) return new Uint8Array(0);
  const out = new Uint8Array(rows * rowBytes);
  const zero = new Uint8Array(rowBytes);
  let outLen = 0;
  for (let r = 0; r < rows; r++) {
    const s = r * stride;
    const tag = data[s];
    const len = Math.min(rowBytes, data.length - s - 1);
    if (len <= 0) break;
    const cur = out.subarray(r * rowBytes, r * rowBytes + rowBytes);
    const up = r > 0 ? out.subarray((r - 1) * rowBytes, r * rowBytes) : zero;
    for (let i = 0; i < len; i++) {
      const x = data[s + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = up[i];
      let v: number;
      switch (tag) {
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const c = i >= bpp ? up[i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          v = x;
      }
      cur[i] = v & 0xff;
    }
    outLen = r * rowBytes + len;
  }
  return out.subarray(0, outLen);
}

/** TIFF の予測(2)を戻す。各成分を左の同じ成分との差で持っている */
function undoTiff(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const out = new Uint8Array(data);
  if (rowBytes <= 0) return out;
  const samples = colors * columns;
  for (let off = 0; off < out.length; off += rowBytes) {
    const len = Math.min(rowBytes, out.length - off);
    if (bpc === 8) {
      for (let i = colors; i < len; i++) out[off + i] = (out[off + i] + out[off + i - colors]) & 0xff;
    } else if (bpc === 16) {
      const n = Math.min(samples, len >> 1);
      for (let s = colors; s < n; s++) {
        const p = off + s * 2;
        const q = off + (s - colors) * 2;
        const v = (((out[p] << 8) | out[p + 1]) + ((out[q] << 8) | out[q + 1])) & 0xffff;
        out[p] = v >> 8;
        out[p + 1] = v & 0xff;
      }
    } else if (bpc === 1 || bpc === 2 || bpc === 4) {
      const mask = (1 << bpc) - 1;
      const n = Math.min(samples, Math.floor((len * 8) / bpc));
      const get = (s: number) => {
        const bit = s * bpc;
        return (out[off + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask;
      };
      for (let s = colors; s < n; s++) {
        const v = (get(s) + get(s - colors)) & mask;
        const bit = s * bpc;
        const at = off + (bit >> 3);
        const sh = 8 - bpc - (bit & 7);
        out[at] = (out[at] & ~(mask << sh)) | (v << sh);
      }
    }
  }
  return out;
}

/**
 * ストリームの中身をほどいて返す。Filter なし・/FlateDecode(名前でも、要素の配列でも。重ねがけも)に対応。
 * DecodeParms に Predictor があれば戻す(PNG の 10〜15 と TIFF の 2。Colors・BitsPerComponent・Columns を見る)。
 * それ以外の圧縮(DCTDecode など)は null。**Flate の中身が壊れているときは例外**(呼ぶ側で「読めなかったもの」に数える)。
 * sizeHint はほどいた大きさの見込み(画像なら 幅×高さ×成分数。メモリを減らすためだけの値で、外れても結果は変わらない)
 */
export async function readStream(stream: PDFRawStream, sizeHint?: number): Promise<Uint8Array | null> {
  const dict = stream.dict;
  const f = dict.lookup(N_FILTER);
  const p = dict.lookup(N_PARMS) ?? dict.lookup(PDFName.of('DP'));
  const filters: unknown[] = f instanceof PDFArray ? f.asArray().map((x) => (x instanceof PDFRef ? dict.context.lookup(x) : x)) : f ? [f] : [];
  const parms: unknown[] = p instanceof PDFArray ? p.asArray().map((x) => (x instanceof PDFRef ? dict.context.lookup(x) : x)) : p ? [p] : [];
  let data = stream.contents;
  for (let i = 0; i < filters.length; i++) {
    const name = filters[i];
    if (name !== PDFName.of('FlateDecode') && name !== PDFName.of('Fl')) return null;
    const pr = asDict(parms[i]);
    const predictor = numOf(pr, 'Predictor', 1);
    // 見込みは、Predictor が無い最後の段にだけ使う(予測を戻す前の大きさは、行ごとの先頭1バイトぶん違う)
    data = await inflate(data, predictor === 1 && i === filters.length - 1 ? sizeHint : undefined);
    if (predictor === 1) continue;
    const colors = numOf(pr, 'Colors', 1);
    const bpc = numOf(pr, 'BitsPerComponent', 8);
    const columns = numOf(pr, 'Columns', 1);
    if (predictor >= 10 && predictor <= 15) data = undoPng(data, colors, bpc, columns);
    else if (predictor === 2) data = undoTiff(data, colors, bpc, columns);
    else return null;
  }
  return data;
}

/**
 * 8ビットの画素(成分 colors 個・幅 columns)に、PNG の行ごとの予測を付ける(undoPng の逆)。行ごとに
 * None / Sub / Up / Average / Paeth の5通りを試し、差の絶対値(符号つきの1バイトとして)の和がいちばん小さい方式を選ぶ
 * (libpng と同じ選び方。同じ和なら番号の小さい方)。data は rowBytes(=colors×columns)の整数倍であること。
 *
 * **なぜ要るか(2026-10-01 4-1 の 3)。** Ghostscript は画像に PNG の予測(Predictor 15)を付けて詰める。
 * それを readStream で戻して書き戻すとき、予測を付けずに詰めると、写真のようなグレーの絵が 2.2 倍になった
 * (なめらかな絵は、予測が差を小さくしてくれるので詰まりやすい)
 */
export function pngPredict(data: Uint8Array, colors: number, columns: number): Uint8Array {
  const rowBytes = colors * columns;
  if (rowBytes <= 0 || data.length % rowBytes !== 0) throw new Error('pngPredict: 画素の数が行の大きさの整数倍ではありません');
  const rows = data.length / rowBytes;
  const out = new Uint8Array(rows * (rowBytes + 1));
  const zero = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const cur = data.subarray(r * rowBytes, (r + 1) * rowBytes);
    const up = r > 0 ? data.subarray((r - 1) * rowBytes, r * rowBytes) : zero;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    for (let i = 0; i < rowBytes; i++) {
      const x = cur[i];
      const a = i >= colors ? cur[i - colors] : 0;
      const b = up[i];
      const c = i >= colors ? up[i - colors] : 0;
      const pa = b > c ? b - c : c - b;
      const pb = a > c ? a - c : c - a;
      const sum = a + b - 2 * c;
      const pc = sum < 0 ? -sum : sum;
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      let t = (x << 24) >> 24;
      s0 += t < 0 ? -t : t;
      t = ((x - a) << 24) >> 24;
      s1 += t < 0 ? -t : t;
      t = ((x - b) << 24) >> 24;
      s2 += t < 0 ? -t : t;
      t = ((x - ((a + b) >> 1)) << 24) >> 24;
      s3 += t < 0 ? -t : t;
      t = ((x - paeth) << 24) >> 24;
      s4 += t < 0 ? -t : t;
    }
    let tag = 0;
    let best = s0;
    if (s1 < best) (best = s1), (tag = 1);
    if (s2 < best) (best = s2), (tag = 2);
    if (s3 < best) (best = s3), (tag = 3);
    if (s4 < best) (best = s4), (tag = 4);
    const o = r * (rowBytes + 1);
    out[o] = tag;
    for (let i = 0; i < rowBytes; i++) {
      const x = cur[i];
      const a = i >= colors ? cur[i - colors] : 0;
      const b = up[i];
      let p: number;
      switch (tag) {
        case 1:
          p = a;
          break;
        case 2:
          p = b;
          break;
        case 3:
          p = (a + b) >> 1;
          break;
        case 4: {
          const c = i >= colors ? up[i - colors] : 0;
          const pa = b > c ? b - c : c - b;
          const pb = a > c ? a - c : c - a;
          const sum = a + b - 2 * c;
          const pc = sum < 0 ? -sum : sum;
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          p = 0;
      }
      out[o + 1 + i] = (x - p) & 0xff;
    }
  }
  return out;
}

/**
 * ref のストリームを新しい中身に置き換える。辞書のほかの項目は保ち、Filter は FlateDecode(compress=false なら無し)、
 * DecodeParms は消し、Length を直す。set で項目を足し、remove で消せる。
 * **画像の画素を書き戻すときは predict を渡す**(8ビット・成分 colors 個・幅 columns・高さ rows)。PNG の行ごとの予測を付けて詰め、
 * /DecodeParms << /Predictor 15 /Colors … /BitsPerComponent 8 /Columns … >> を書く(読み戻した画素は、渡した画素と同じ)。
 * 画像でないストリーム(描く命令・関数・色の表)には渡さない。data が predict の大きさに足りないときは、予測を付けずに詰める
 */
export async function replaceStream(
  doc: PDFDocument,
  ref: PDFRef,
  data: Uint8Array,
  opts?: { compress?: boolean; set?: Record<string, PDFObject>; remove?: string[]; predict?: { colors: number; columns: number; rows: number } },
): Promise<void> {
  const old = doc.context.lookup(ref);
  if (!(old instanceof PDFStream)) throw new Error(`${ref.toString()} はストリームではありません`);
  const compress = opts?.compress !== false;
  const p = opts?.predict;
  const need = p ? p.colors * p.columns * p.rows : 0;
  const predicted = compress && !!p && need > 0 && Number.isFinite(need) && data.length >= need;
  const body = compress ? await deflate(predicted && p ? pngPredict(data.length === need ? data : data.subarray(0, need), p.colors, p.columns) : data) : data;
  const dict = old.dict.clone(doc.context);
  dict.delete(N_FILTER);
  dict.delete(N_PARMS);
  for (const k of opts?.remove ?? []) dict.delete(PDFName.of(k));
  if (compress) dict.set(N_FILTER, PDFName.of('FlateDecode'));
  if (predicted && p) {
    dict.set(N_PARMS, doc.context.obj({ Predictor: 15, Colors: p.colors, BitsPerComponent: 8, Columns: p.columns }));
  }
  for (const [k, v] of Object.entries(opts?.set ?? {})) dict.set(PDFName.of(k), v);
  dict.set(PDFName.of('Length'), PDFNumber.of(body.length));
  doc.context.assign(ref, PDFRawStream.of(dict, body));
}

// ───────────────────────── 描く命令を持つものを全部たどる ─────────────────────────

/**
 * 自前の /Resources を持たない Form に、呼んでいる側の資源を渡す。呼ぶ側のさらに親から継ぐ入れ子も辿る。
 * 色空間の名前(/Cs1 など)や XObject の名前を引くのに資源が要る。引けないと、neutral は色空間を知らずに黙って触らず、
 * inspect は Form の中の CMYK の画像を見落とした(2026-10-01 の指摘 B5)。
 * 一度も `Do` されていなければ null のまま。**Form が無ければ命令を1つも読まない**(自前の資源を持たない Form は Chrome や Ghostscript の出力には出ない)
 */
function inheritResources(holders: ContentHolder[]): void {
  if (!holders.some((h) => h.kind === 'form' && !h.resources)) return;
  const byRef = new Map<string, ContentHolder>();
  for (const h of holders) if (h.ref) byRef.set(h.ref.toString(), h);
  // 先に、各持ち主が `Do` している名前だけ集める(資源は継いでから決まるので、名前を引くのはあと)
  const calls = new Map<ContentHolder, string[]>();
  for (const h of holders) {
    const names: string[] = [];
    forEachOperation(h.bytes, (o) => {
      if (o.op === 'Do' && o.operands.length === 1 && o.operands[0].type === 'name') names.push(o.operands[0].text as string);
    });
    if (names.length) calls.set(h, names);
  }
  const queue = holders.filter((h) => h.resources);
  for (let q = 0; q < queue.length; q++) {
    const parent = queue[q];
    const xobj = parent.resources?.lookup(PDFName.of('XObject'));
    if (!(xobj instanceof PDFDict)) continue;
    for (const name of calls.get(parent) ?? []) {
      const r = xobj.get(PDFName.of(name));
      const child = r instanceof PDFRef ? byRef.get(r.toString()) : undefined;
      if (!child || child.kind !== 'form' || child.resources) continue;
      child.resources = parent.resources;
      child.resourcesInherited = true;
      queue.push(child);
    }
  }
}

export interface ContentHolder {
  kind: 'page' | 'form' | 'pattern' | 'charproc';
  /** 利用者に見せる呼び名。例: 'ページ 3'・'フォーム 12 0 R' */
  label: string;
  /** ページのときは 0 始まりのページ番号 */
  pageIndex?: number;
  /** ページ以外は、そのオブジェクトの参照 */
  ref?: PDFRef;
  bytes: Uint8Array;
  /**
   * 資源(Resources の辞書)。**Form が自前の /Resources を持たないときは、それを `Do` している側の資源を継ぐ**
   * (PDF の決まり。継いだときは resourcesInherited が true)。どこからも呼ばれていなければ null
   */
  resources: PDFDict | null;
  resourcesInherited?: boolean;
  write(bytes: Uint8Array): Promise<void>;
}

const N_CONTENTS = PDFName.of('Contents');
const N_RESOURCES = PDFName.of('Resources');
const N_SUBTYPE = PDFName.of('Subtype');
const N_FONT = PDFName.of('Font');

/**
 * 文書の中の「描く命令」を持つものを全部たどる: 各ページの Contents(配列なら**つないで1本として**扱う)、
 * Form XObject、タイリングパターン(PatternType 1)、Type3 フォントの CharProcs。
 * それぞれについて、ほどいた中身と、書き戻す関数、資源(Resources の辞書。色空間の名前を引くのに使う)を渡す。
 * 同じオブジェクトは1度だけ。ページの Contents が配列のときに書き戻すと、1本にまとめた新しいストリームに差し替える。
 *
 * **読めなかったもの**(DCTDecode など Flate でない圧縮・Flate が壊れている)は一覧に入れない。
 * 黙って落とすと「色を調べたつもり」になるので、skipped を渡せば、その呼び名(と理由)を足す。
 *
 * ページの Contents を配列でつなぐときの区切りは改行1つ(仕様は「間に空白があるものとして1本に読む」)。
 * 同じストリームを複数のページが共有していると、最初のページだけが持つ(Chrome の PDF にはない)
 */
export async function contentHolders(doc: PDFDocument, skipped?: string[]): Promise<ContentHolder[]> {
  const out: ContentHolder[] = [];
  const claimed = new Set<string>();
  const ctx = doc.context;
  const skip = (label: string, why: string) => skipped?.push(`${label}（${why}）`);

  const load = async (label: string, stream: PDFRawStream): Promise<Uint8Array | null> => {
    try {
      const b = await readStream(stream);
      if (!b) skip(label, '対応していない圧縮');
      return b;
    } catch {
      skip(label, '中身が壊れていて読めない');
      return null;
    }
  };
  const resOf = (d: PDFDict): PDFDict | null => asDict(d.lookup(N_RESOURCES));

  // ページ。Contents を1本ずつ使うページの数を先に数える(つなぎ直したときに、ほかで使っていない古いストリームだけ捨てるため)
  const pages = doc.getPages();
  const useCount = new Map<string, number>();
  const contentsOf = (page: (typeof pages)[number]) => {
    const c = page.node.get(N_CONTENTS);
    const v = c instanceof PDFRef ? ctx.lookup(c) : c;
    const refs: PDFRef[] = [];
    if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) {
        const e = v.get(i);
        if (e instanceof PDFRef) refs.push(e);
      }
      return { refs, isArray: true };
    }
    if (c instanceof PDFRef && v instanceof PDFRawStream) refs.push(c);
    return { refs, isArray: false };
  };
  const pageContents = pages.map(contentsOf);
  for (const pc of pageContents) for (const r of pc.refs) useCount.set(r.toString(), (useCount.get(r.toString()) ?? 0) + 1);

  const fontPage = new Map<PDFDict, PDFDict>(); // Type3 フォント → それを使うページの Resources(CharProcs の資源が無いとき用)
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const { refs, isArray } = pageContents[pi];
    const resources = asDict(page.node.Resources() ?? null);
    const fonts = resources ? asDict(resources.lookup(N_FONT)) : null;
    if (fonts && resources) for (const [, v] of fonts.entries()) {
      const fd = asDict(fonts.context.lookup(v));
      if (fd && !fontPage.has(fd)) fontPage.set(fd, resources);
    }
    if (refs.length === 0) continue;
    const label = `ページ ${pi + 1}`;
    if (refs.some((r) => claimed.has(r.toString()))) {
      skip(label, 'ほかのページと中身を共有している');
      continue;
    }
    for (const r of refs) claimed.add(r.toString());
    const bodies: Uint8Array[] = [];
    let ok = true;
    for (const r of refs) {
      const b = await load(label, ctx.lookup(r) as PDFRawStream);
      if (!b) {
        ok = false;
        break;
      }
      bodies.push(b);
    }
    if (!ok) continue;
    let bytes: Uint8Array;
    if (bodies.length === 1) bytes = bodies[0];
    else {
      const parts: Uint8Array[] = [];
      bodies.forEach((b, k) => {
        if (k > 0) parts.push(new Uint8Array([LF]));
        parts.push(b);
      });
      bytes = concat(parts);
    }
    out.push({
      kind: 'page',
      label,
      pageIndex: pi,
      bytes,
      resources,
      write: async (nb) => {
        if (refs.length === 1) {
          await replaceStream(doc, refs[0], nb);
          return;
        }
        // 配列のときは、1本にまとめた新しいストリームを作って差し替える。
        // 古い断片は、ほかで使っていないものだけ捨てる(残すと、書き換える前の色の指定が文書に残ってしまう)
        const ref = ctx.register(PDFRawStream.of(ctx.obj({}), new Uint8Array(0)));
        await replaceStream(doc, ref, nb);
        page.node.set(N_CONTENTS, ref);
        if (isArray) for (const r of refs) if ((useCount.get(r.toString()) ?? 0) <= 1) ctx.delete(r);
      },
    });
  }

  // Form XObject・パターン・Type3 の字形は、番号順に総なめする
  const fonts: PDFDict[] = [];
  const seenFont = new Set<PDFDict>();
  const addFont = (d: PDFDict) => {
    if (!seenFont.has(d)) {
      seenFont.add(d);
      fonts.push(d);
    }
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const sub = obj.dict.lookup(N_SUBTYPE);
      const isForm = sub === PDFName.of('Form');
      const isPattern = !isForm && numOf(obj.dict, 'PatternType', 0) === 1;
      if (!isForm && !isPattern) continue;
      if (claimed.has(ref.toString())) continue;
      claimed.add(ref.toString());
      const label = `${isForm ? 'フォーム' : 'パターン'} ${ref.toString()}`;
      const bytes = await load(label, obj);
      if (!bytes) continue;
      out.push({
        kind: isForm ? 'form' : 'pattern',
        label,
        ref,
        bytes,
        resources: resOf(obj.dict),
        write: (nb) => replaceStream(doc, ref, nb),
      });
    } else if (obj instanceof PDFDict && obj.lookup(N_SUBTYPE) === PDFName.of('Type3')) addFont(obj);
  }
  for (const d of fontPage.keys()) if (d.lookup(N_SUBTYPE) === PDFName.of('Type3')) addFont(d);
  inheritResources(out);
  for (const font of fonts) {
    const procs = asDict(font.lookup(PDFName.of('CharProcs')));
    if (!procs) continue;
    const resources = resOf(font) ?? fontPage.get(font) ?? null;
    for (const [, v] of procs.entries()) {
      if (!(v instanceof PDFRef) || claimed.has(v.toString())) continue;
      const s = ctx.lookup(v);
      if (!(s instanceof PDFRawStream)) continue;
      claimed.add(v.toString());
      const label = `Type3 の字形 ${v.toString()}`;
      const bytes = await load(label, s);
      if (!bytes) continue;
      out.push({ kind: 'charproc', label, ref: v, bytes, resources, write: (nb) => replaceStream(doc, v, nb) });
    }
  }
  return out;
}
