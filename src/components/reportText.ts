// 不具合の報告フォームに貼る短い文を作る。(2026-10-12 修正リストの 5 / 運用の見直し 3)
//
// ［このアプリについて］とエラーの画面の［報告用の文をコピー］が使う。
// **入れるのは、バージョン・ブラウザ・OS の大まかな名前・(エラーの画面だけ)エラーの文。**
// 原稿・書名・ファイル名は入れない(外へ何も送らない約束。ここは文を作るだけで、送りもしない)。
// 2026-10-13(運用の見直し 12 / 対応環境): OS の本当の版・画面の広さと拡大率・下見のページ数(数だけ)・対応環境の中か外か、を足した。
// 非同期に取るもの(platformVersion)は envProbe.ts が集めて extra で渡す。入口の知らせの判定(envNoticeOf)もここに置く。
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
  /**
   * 押した時点で取れた、くわしい環境(2026-10-13 運用の見直し 12 / 対応環境)。
   * 渡したときだけ「OS の本当の版・画面・下見のページ数・対応環境の中か外か」の行が入る。取れなかった項目は書かない
   */
  extra?: ReportExtra;
}

export interface ReportExtra {
  /** Chrome・Edge の userAgentData.getHighEntropyValues(['platformVersion']) の値("13.0.0"・"15.0.0" など)。取れなければ null */
  platformVersion?: string | null;
  /** innerWidth・innerHeight・devicePixelRatio */
  screen?: { width: number; height: number; dpr: number } | null;
  /** いまの下見のページ数(数だけ)。0 や取れないときは書かない */
  pages?: number | null;
}

/** 報告フォームに貼る文。1項目1行 */
export function reportText(info: ReportInfo): string {
  const ua = info.userAgent.trim();
  const lines = [`バージョン: ${versionLabel(info.version, info.mark)}`];
  // ブラウザが読めなければ userAgent をそのまま(OS もそこから読めるので、別の行にはしない)
  const browser = browserOf(ua);
  const x = info.extra;
  if (browser) {
    lines.push(`ブラウザ: ${browser}`);
    lines.push(`OS: ${(x ? osDetailOf(ua, x.platformVersion) : null) ?? osOf(ua) ?? '不明'}`);
  } else {
    lines.push(`ブラウザ: ${ua || '不明'}`);
  }
  if (x) {
    const s = x.screen;
    if (s && s.width > 0 && s.height > 0) {
      const dpr = Number.isFinite(s.dpr) && s.dpr > 0 ? `・拡大率 ${Math.round(s.dpr * 100) / 100}` : '';
      // innerWidth は画面全体ではなく、ブラウザの窓の内側の広さ(見直しの指摘。半分の窓で使っている人と見分けられるように)
      lines.push(`ブラウザの窓: ${Math.round(s.width)}×${Math.round(s.height)}${dpr}`);
    }
    if (x.pages && x.pages > 0) lines.push(`下見のページ数: ${x.pages}`);
    if (browser) lines.push(`対応環境: ${ENV_TIER_LABEL[envTierOf(ua, x.platformVersion)]}`);
  }
  if (info.errorMessage !== undefined) lines.push(`エラー: ${shortError(info.errorMessage) || '（文なし）'}`);
  return lines.join('\n');
}

// ── 対応環境(2026-10-13 運用の見直し 12。ユーザー決定: 保守の範囲を広げない・2段に分ける) ──────────
// 対応   : Windows 10・11 と macOS 13 以降の、Google Chrome・Microsoft Edge の新しい版(不具合は直す)
// 対象外 : スマホ・タブレット / Windows 7・8・8.1・Vista・XP / macOS 12 以前 / Mac の Safari / Firefox / 古い Chrome・Edge
//          (Mac の Safari は初め「確認中」の段にしたが、同じ本でページ数が変わったので今は対象外。あとで見直すかもしれない)
// 文の元は src/help/content.ts の HELP_ENV。数字を変えるときは両方を見る

/** 対応する Chrome・Edge のいちばん古い版。Vivliostyle が組版を細かくする currentCSSZoom が入った版(下調べ A) */
export const MIN_CHROMIUM = 128;
/** 対応する macOS のいちばん古い版。最新の Chrome・Edge が入る最低が macOS 13 Ventura(下調べ A) */
export const MIN_MACOS = 13;

/** Chrome・Edge の版の先頭の数字。Chrome・Edge でなければ null(Opera などは数えない) */
export function chromiumMajorOf(ua: string): number | null {
  const m = /^(?:Chrome|Edge) (\d+)$/.exec(browserOf(ua) ?? '');
  return m ? Number(m[1]) : null;
}

/** 版の文字列("15.0.0"・"10.15.7")の先頭の数字。読めなければ null */
function majorOf(v: string | null | undefined): number | null {
  const m = /^\s*(\d+)/.exec(v ?? '');
  return m ? Number(m[1]) : null;
}

/** Windows 7・8・8.1・Vista(NT 6.x)と XP(NT 5.x)。userAgent に版がそのまま出る(Chrome・Edge は 109 で止まっている) */
function isOldWindows(ua: string): boolean {
  return /\bWindows NT [56]\.\d/.test(ua);
}

/**
 * Windows の platformVersion から 10 と 11 を見分ける。
 * userAgent はどちらも "Windows NT 10.0" なので見分けられない。platformVersion の頭が 13 以上なら 11、1〜12 なら 10(Microsoft の決まり)。
 * 0 や読めないときは null
 */
export function windowsNameOf(platformVersion: string | null | undefined): 'Windows 11' | 'Windows 10' | null {
  const n = majorOf(platformVersion);
  if (n === null || n < 1) return null;
  return n >= 13 ? 'Windows 11' : 'Windows 10';
}

/** 報告の文の OS。platformVersion が取れたときだけ本当の版を言う(Windows は 10/11、Mac は "15.0.0" などをそのまま) */
export function osDetailOf(ua: string, platformVersion: string | null | undefined): string | null {
  const os = osOf(ua);
  if (!platformVersion) return null;
  if (os === 'Windows 10/11') return windowsNameOf(platformVersion);
  if (os === 'macOS') return majorOf(platformVersion) === null ? null : `macOS ${platformVersion.trim()}`;
  return null;
}

/** 入口に出す知らせの種類 */
export type EnvNotice = 'safari' | 'firefox' | 'oldWindows' | 'oldMac' | 'oldBrowser';

/**
 * 入口で、対応環境の外の人に知らせを出すかどうか。止めはしない。(2026-10-13 運用の見直し 12 / 対応環境)
 *
 * - **スマホ・タブレットの userAgent(iPhone・iPad・Android)は null** — 「パソコン専用」の知らせ(CSS)のほうが先に効くので、重ねて出さない。
 *   (iPadOS の Safari は Mac の Safari を名乗ることがある。そのぶんは入口の CSS が、タッチが主の端末では知らせを隠して受ける)
 * - 古い Windows(NT 5.x・6.x)は、ブラウザが何でも 'oldWindows'。**OS の文を先にして、ブラウザの文は重ねない**
 * - Firefox は 'firefox'、Mac の Safari は 'safari'(どちらも対象外。Safari は同じ仕組みの試しでページ数が Chrome と変わった: 40 と 42。
 *   10/13 夜に「確認中」から「今は対象外」へ。落ち着いてから見直す)
 * - macOS の版は、Chrome・Edge では userAgent から分からない(10_15_7 に固定されている)。
 *   `platformVersion`(userAgentData から非同期に取る)を渡されたときだけ、13 未満なら 'oldMac'。古い OS の文を古いブラウザの文より先にする
 * - Chrome・Edge の版の先頭が 128 未満なら 'oldBrowser'
 */
export function envNoticeOf(ua: string, platformVersion?: string | null): EnvNotice | null {
  const os = osOf(ua);
  if (os === 'iOS' || os === 'Android') return null;
  if (isOldWindows(ua)) return 'oldWindows';
  const b = browserOf(ua);
  if (b === null) return null;
  if (b.startsWith('Firefox ')) return 'firefox';
  if (b.startsWith('Safari ')) return 'safari';
  if (os === 'macOS') {
    const mac = majorOf(platformVersion);
    if (mac !== null && mac < MIN_MACOS) return 'oldMac';
  }
  const cm = chromiumMajorOf(ua);
  if (cm !== null && cm < MIN_CHROMIUM) return 'oldBrowser';
  return null;
}

/** 入口の知らせの文(下書き。2026-10-13)。止めはしないので「開けることもある」と言い、直せないことだけをはっきり言う */
export const ENV_NOTICE_TEXT: Record<EnvNotice, string> = {
  // Mac の Safari は今は対象外(2026-10-13 夜 ユーザー決定。落ち着いてから見直す)
  safari:
    'Safari は対応していません（同じ本でも Chrome とページ数が変わることがあります）。開ける場合もありますが、不具合の修正はできません。Chrome か Edge をお使いください。',
  firefox: 'Firefox は対応していません。開ける場合もありますが、不具合の修正はできません。Chrome か Edge をお使いください。',
  oldWindows:
    'お使いの Windows は対応していません（対応は Windows 10・11）。開ける場合もありますが、不具合の修正はできません。',
  oldMac: 'お使いの macOS は対応していません（対応は macOS 13 以降）。開ける場合もありますが、不具合の修正はできません。',
  oldBrowser: 'お使いのブラウザは古いため対応していません。ブラウザを最新版に更新してください。',
};

/** 対応環境の中か外か(報告の文に書く)。確認中の段は、Mac の Safari を対象外にしたので今は無い(2026-10-13 夜) */
export type EnvTier = 'supported' | 'outside';

export const ENV_TIER_LABEL: Record<EnvTier, string> = {
  supported: '対応環境の中',
  outside: '対応環境の外',
};

/**
 * 2段のどちらか。**対応は「Windows 10・11 か Mac」で「Chrome か Edge の 128 以上」(Mac は版が分かれば 13 以上)だけ。**
 * Linux・Opera など、どの段にも名前の無いものも「外」(対応は名前を挙げたものだけ)
 */
export function envTierOf(ua: string, platformVersion?: string | null): EnvTier {
  const os = osOf(ua);
  if (os === 'iOS' || os === 'Android') return 'outside';
  if (envNoticeOf(ua, platformVersion)) return 'outside';
  if ((os === 'Windows 10/11' || os === 'macOS') && chromiumMajorOf(ua) !== null) return 'supported';
  return 'outside';
}
