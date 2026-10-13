// 失敗の理由を、利用者に見せる日本語にする。(2026-10-13 修正リスト 32)
//
// 表紙の書き出しが通信の失敗(書体を取れない・ネットが切れた)で止まると、ブラウザの英語の例外
// 「A network error occurred.」が、日本語の「表紙PDFの書き出しに失敗しました: 」のあとにそのまま出ていた。
// **利用者向けに書いた日本語の Error はそのまま見せる**(変換の道具の失敗の文など。変換の側が日本語にしてある)。
// 言い換えるのは、ブラウザが出す通信の失敗の英語だけ。ほかの英語(壊れた zip など)は、ここでは触らない。

/** 通信の失敗のときに見せる文 */
export const NETWORK_ERROR_TEXT = '通信がうまくいきませんでした。ネットの接続を確かめて、もう一度お試しください';

/** ブラウザが通信の失敗で出す文(Chrome・Edge・Firefox・Safari)。日本語を含まない文にだけ当てる */
const NETWORK_PATTERNS = [
  /network ?error/i, // A network error occurred. / NetworkError when attempting to fetch resource.
  /failed to fetch/i, // Chrome の fetch
  /load failed/i, // Safari の fetch
  /network request failed/i,
  /err_(internet_disconnected|network_changed|connection|name_not_resolved|timed_out)/i,
  /\bnetwork\b.*\b(offline|disconnected|unavailable)\b/i,
];

/** 文に日本語(ひらがな・カタカナ・漢字)が入っているか */
const HAS_JAPANESE = /[぀-ヿ㐀-鿿]/;

/** 失敗(例外)から、利用者に見せる一言を作る。日本語の文はそのまま、通信の失敗の英語は日本語に言い換える */
export function userErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
  if (HAS_JAPANESE.test(raw)) return raw;
  if (NETWORK_PATTERNS.some((p) => p.test(raw))) return NETWORK_ERROR_TEXT;
  // 名前が NetworkError の DOMException は、文が空でも通信の失敗
  if (e instanceof Error && e.name === 'NetworkError') return NETWORK_ERROR_TEXT;
  return raw;
}
