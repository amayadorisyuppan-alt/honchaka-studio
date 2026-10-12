// 不具合の報告フォームに貼る短い文を作る。(2026-10-12 修正リストの 5 / 運用の見直し 3)
//
// ［このアプリについて］とエラーの画面の［報告用の文をコピー］が使う。
// **入れるのは、バージョン・ブラウザ・OS の大まかな名前・(エラーの画面だけ)エラーの文。**
// 原稿・書名・ファイル名は入れない(外へ何も送らない約束。ここは文を作るだけで、送りもしない)。
//
// 重い依存を持たない純粋な関数だけにしてある — エラーの画面は、アプリの他の部品が壊れていても動かす必要がある。
// ブラウザの情報(userAgent)は引数で受ける。そうすると単体の検査(scripts/reportText.test.ts)で回せる。

/** バージョンの表示。印があれば番号のあとに付ける(例「1.1.0（○○版）」) */
export function versionLabel(version: string, mark?: string): string {
  return mark ? `${version}（${mark}）` : version;
}

/** userAgent からブラウザの名前と版を読む。読めなければ null */
export function browserOf(ua: string): string | null {
  // 並べる順が大事。Edge・Opera・iOS 版の各ブラウザは Chrome や Safari の名前も含むので、先に拾う
  const rules: Array<[RegExp, string]> = [
    [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
    [/\bOPR\/(\d+)/, 'Opera'],
    [/\b(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
    [/\b(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
    [/\bVersion\/(\d+(?:\.\d+)?).*\bSafari\//, 'Safari'],
  ];
  for (const [re, name] of rules) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return null;
}

/** userAgent から OS の大まかな名前を読む。読めなければ null */
export function osOf(ua: string): string | null {
  // iPhone の userAgent は "like Mac OS X"、Android は "Linux" も含むので、先に拾う
  if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) return 'iOS';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bWindows NT 10\.0\b/.test(ua)) return 'Windows 10/11';
  if (/\bWindows\b/.test(ua)) return 'Windows';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux';
  return null;
}

/** エラーの文は先頭の1行だけ、長すぎれば切る(スタックや、まれにエラーに混ざる長い文を持ち出さない) */
function shortError(message: string): string {
  const line = message.split(/\r?\n/)[0].trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export interface ReportInfo {
  /** APP_VERSION */
  version: string;
  /** 版の印(EDITION.versionMark)。標準の版は省く */
  mark?: string;
  /** navigator.userAgent */
  userAgent: string;
  /** エラーの画面から作るときだけ、エラーの文 */
  errorMessage?: string;
}

/** 報告フォームに貼る文。1項目1行 */
export function reportText(info: ReportInfo): string {
  const ua = info.userAgent.trim();
  const lines = [`バージョン: ${versionLabel(info.version, info.mark)}`];
  // ブラウザが読めなければ userAgent をそのまま(OS もそこから読めるので、別の行にはしない)
  const browser = browserOf(ua);
  if (browser) {
    lines.push(`ブラウザ: ${browser}`);
    lines.push(`OS: ${osOf(ua) ?? '不明'}`);
  } else {
    lines.push(`ブラウザ: ${ua || '不明'}`);
  }
  if (info.errorMessage !== undefined) lines.push(`エラー: ${shortError(info.errorMessage) || '（文なし）'}`);
  return lines.join('\n');
}
