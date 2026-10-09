// data URI を blob URL に置き換える。
//
// 画像は data URI(base64)で持っている。これを組版HTMLにそのまま書くと、
// 設定を触るたびに数MBの文字列を組み立て直し、Blob を作り、Vivliostyle が
// base64 を復号し直す。挿絵や背景を入れた途端にアプリ全体が重くなる原因になる。
//
// 同じ絵は blob URL を1つ作って使い回す。HTMLには短いURLだけが載り、
// ブラウザは復号した画像をURL単位で持っておける。
// blob URL は同一オリジンなので、印刷経路(printHTML の iframe)からも読める。

/** data URI → blob URL。同じ入力には同じURLを返す */
const cache = new Map<string, string>();

function decode(dataUri: string): Blob | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUri);
  if (!m) return null;
  const [, type, isB64, body] = m;
  try {
    if (!isB64) return new Blob([decodeURIComponent(body)], { type });
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

/**
 * 画像のURLを、組版HTMLに書いてよい形にする。
 * data URI なら blob URL に置き換える。それ以外(通常のURL)はそのまま返す。
 * Node で動かすとき(CLI検証)は URL.createObjectURL が無いので素通しする。
 */
export function assetUrl(src: string): string {
  if (!src.startsWith('data:')) return src;
  // Node にも URL.createObjectURL はあるが、返るのは blob:nodedata:… で
  // ブラウザからは読めない。CLI で組んだ PDF の画像が黙って消えるので、
  // 「関数があるか」ではなく「ブラウザか」で判定する(実測で踏んだ)
  if (typeof window === 'undefined' || typeof document === 'undefined') return src;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return src;
  const hit = cache.get(src);
  if (hit) return hit;
  const blob = decode(src);
  if (!blob) return src;
  const url = URL.createObjectURL(blob);
  cache.set(src, url);
  return url;
}
