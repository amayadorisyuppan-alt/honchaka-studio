// 組版に渡す書体のファイルを、組む前に少しずつ取っておく。(2026-10-11 1.0.3。修正リストの 17)
//
// ## なぜ要るか
//
// 下見の組版(Vivliostyle)は、組版の HTML にある @font-face(本で使う書体の、本の字を含むサブセット。
// src/typeset/fontface.ts)を全部いっぺんに読む。サンプルの本で約 630 面。
// 本番の Xserver(HTTP/2)は、1秒に 550 件ほどの一斉の取得のうち約 4 割を REFUSED_STREAM で断る
// (2026-10-11 実測。fontWaitGuard.ts を入れたあとに残った分)。断られた面は error のまま戻らず、
// その字は別の書体で組まれる。手元(HTTP/1.1)では起きない。
//
// ## どうするか
//
// 組む前に、同じファイルを fetch で**同時に数件ずつ**取り、断られたら間をおいて取り直す。
// assets/ の書体はファイル名にハッシュが付いていて長く覚えさせてよい(Cache-Control: immutable)ので、
// そのあと Vivliostyle が読むときはブラウザのキャッシュから出て、一斉の取得にならない。
//
// - 一度取れたファイルは覚えておき、組み直しのたびに取り直さない(2回目からは待たずに組む)
// - 取れなかったファイルがあっても組むのは止めない(今までどおり Vivliostyle が自分で取りに行く)

/**
 * 同時に取りに行く数。本番で 550 件の一斉は約 340 件しか通らなかった。十分に下に置く。
 * (2026-10-11 本番の書体で実測: 12 でも 24 でも断られ 0。最初の紙面が出るまで 12 は 3.3〜5.3 秒・24 は 3.2〜3.8 秒)
 */
const CONCURRENCY = 24;
/** 1つのファイルを取り直す回数(最初の1回を含まない) */
const RETRIES = 3;

const fetched = new Set<string>();
const inflight = new Map<string, Promise<void>>();

/** CSS の url(…) から、書体のファイル(.woff2 / .woff / .otf / .ttf)のアドレスを抜き出す */
export function fontUrlsIn(css: string): string[] {
  const out = new Set<string>();
  for (const m of css.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) {
    const u = m[2]!;
    if (/^(data:|blob:)/.test(u)) continue;
    if (/\.(woff2?|otf|ttf)(\?|#|$)/i.test(u)) out.add(u);
  }
  return [...out];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(url: string): Promise<void> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.ok) {
        // 本体を読み切らないと、キャッシュに入りきらないことがある
        await res.arrayBuffer();
        fetched.add(url);
        return;
      }
      if (res.status < 500) return; // 404 などは取り直しても同じ
    } catch {
      // 断られた(REFUSED_STREAM)・つながらない。間をおいて取り直す
    }
    await sleep(300 * (attempt + 1));
  }
}

/**
 * まだ取っていない書体のファイルを、同時に CONCURRENCY 件ずつ取る。
 * **全部取ってあれば null を返す**(呼ぶ側は待たずにそのまま組める)
 */
export function prefetchFonts(urls: string[]): Promise<void> | null {
  if (typeof fetch === 'undefined') return null;
  const todo = urls.filter((u) => !fetched.has(u));
  if (todo.length === 0) return null;
  const queue = [...todo];
  const waits: Promise<void>[] = [];
  const worker = async () => {
    for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
      let p = inflight.get(u);
      if (!p) {
        p = fetchOne(u).finally(() => inflight.delete(u));
        inflight.set(u, p);
      }
      await p;
    }
  };
  for (let i = 0; i < Math.min(CONCURRENCY, todo.length); i++) waits.push(worker());
  return Promise.all(waits).then(() => undefined);
}
