// お知らせ欄。アプリと同じ場所に置いた `notice.json` を起動時に1度だけ読み、
// 中身があれば入口と作業画面の上に1行ずつ出す。(2026-10-11 1.0.2)
//
// **なぜ要るか。** このアプリは Xserver に置くだけの静的なアプリで、出したあとの画面に
// あとから知らせを出す方法が無かった(直して出し直すしかない)。1.0.1 の公開日に、
// 初めて開いた人だけ表紙の書き出しが失敗する不具合が見つかり、直すまでのあいだ回り道を
// 伝える場所が要った。`notice.json` を書き換えて上げるだけなら、組み立て直さずに知らせられる。
// (案の出どころ: 引き継ぎ/運用の見直し_20261010.md の 4)
//
// **外へは何も送らない。** 読むのはアプリと同じアドレスのファイル1つだけで、
// 「原稿は外に送らない」約束は崩れない。読めなければ(持ち出し版・ファイルが無い・形が違う)何も出さない。
//
// **文は文字として出す。** HTML は解釈しない。リンクは https のものだけ通す。
//
// ファイルの形(public/notice.json。`_` で始まる鍵は読み飛ばすので、書き方のメモに使える):
// ```json
// { "notices": [
//   { "id": "2026-10-11-cover", "text": "…", "link": "https://…", "linkText": "くわしく",
//     "level": "warn", "until": "2026-11-30" }
// ] }
// ```
// - id: 閉じた印を覚える鍵。**文を直したら id も変える**(閉じた人にも、直した文をもう一度出すため)
// - level: "warn"(注意の色)か、省略で "info"
// - from / until: "YYYY-MM-DD"。この日から/この日まで出す(端末の日付で見る)。省略で、ずっと

export interface Notice {
  id: string;
  text: string;
  link?: string;
  linkText?: string;
  level: 'info' | 'warn';
}

/** 閉じた知らせの id。localStorage(この PC のこのブラウザだけ) */
const DISMISS_KEY = 'honchaka:notice-dismissed';
/** 1行に収まらない長文は、壊れたファイルとみなして出さない */
const MAX_TEXT = 300;
/** 一度に出すのは2件まで。それより多いと作業画面が下へ押し出される */
const MAX_SHOWN = 2;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 端末の今日(YYYY-MM-DD)。from/until は日付だけで比べる */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** notice.json の中身を確かめて、出してよい知らせだけにする。形が違うものは黙って落とす */
export function parseNotices(raw: unknown, now = today()): Notice[] {
  const list = (raw as { notices?: unknown } | null)?.notices;
  if (!Array.isArray(list)) return [];
  const out: Notice[] = [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!id || !text || text.length > MAX_TEXT) continue;
    if (typeof o.from === 'string' && DATE_RE.test(o.from) && now < o.from) continue;
    if (typeof o.until === 'string' && DATE_RE.test(o.until) && now > o.until) continue;
    const link = typeof o.link === 'string' && /^https:\/\/[^\s"'<>]+$/.test(o.link) ? o.link : undefined;
    const linkText = link && typeof o.linkText === 'string' && o.linkText.trim() ? o.linkText.trim() : undefined;
    out.push({ id, text, link, linkText, level: o.level === 'warn' ? 'warn' : 'info' });
  }
  return out;
}

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** この画面を開いてから閉じたもの。localStorage が使えないブラウザでも、入口と作業画面の両方で閉じたままにする */
const closedNow = new Set<string>();

export function dismissNotice(id: string) {
  closedNow.add(id);
  try {
    // 古い id が溜まり続けないよう、新しいほうから 50 件だけ覚える
    const next = [id, ...readDismissed().filter((x) => x !== id)].slice(0, 50);
    localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
  } catch {
    // プライベートモードなどで覚えられなくても、開いているあいだは closedNow で閉じたままにする
  }
}

let loading: Promise<Notice[]> | null = null;

/**
 * notice.json を読む。**起動して1度だけ**(入口と作業画面の両方から呼ばれても、取りに行くのは1回)。
 * `cache: 'no-cache'` で、毎回サーバーに新しいか確かめる(書き換えたらすぐ出るように)。
 * 閉じたものは除いて返す
 */
export function loadNotices(): Promise<Notice[]> {
  if (!loading) {
    loading = (async () => {
      try {
        const res = await fetch('notice.json', { cache: 'no-cache' });
        if (!res.ok) return [];
        return parseNotices(await res.json());
      } catch {
        return [];
      }
    })();
  }
  return loading.then((all) => {
    const gone = new Set([...readDismissed(), ...closedNow]);
    return all.filter((n) => !gone.has(n.id)).slice(0, MAX_SHOWN);
  });
}
