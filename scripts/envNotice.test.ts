// 対応環境の判定と、入口の知らせ・報告の文・ヘルプの節の検査。(2026-10-13 運用の見直し 12 / 対応環境)
//
// ## 確かめること
//
// - 入口の知らせ(envNoticeOf):
//   - Mac の Safari は 'safari'、Firefox(Mac / Windows)は 'firefox'(どちらも対象外。Safari は 10/13 夜に確認中から対象外へ)
//   - 古い Windows(7 の Chrome 109・XP の Chrome 49)は 'oldWindows'。**古いブラウザの文は重ねない**
//   - Windows 10 の Chrome 120・Edge 109 は 'oldBrowser'(128 未満)。Chrome 155・Edge 130 は出さない
//   - Mac の Chrome は userAgent だけでは出さない。platformVersion が 12.x なら 'oldMac'(古いブラウザより先)、15.0.0 なら出さない
//   - iPhone・iPad・Android は出さない(スマホ・タブレットの知らせのほうが先に効く。重ねない)
//   - 読めない userAgent・空の文字列は出さない
// - 段(envTierOf): 対応・対象外(確認中の段は今は無い)
// - Opera・Brave・Mac の Edge・ChromeOS で、ふつうの人に知らせを誤って出さない(見直しの指摘)
// - platformVersion → Windows 10 / 11 の見分け(windowsNameOf)と、報告の文の新しい行
// - ヘルプの「対応環境」の節が2段と性能など・版の調べ方を持ち、配る .md にも入る
//
// ## 回し方(ブラウザも dev サーバーも要らない。scripts/private/run-tests.mjs が全部まとめて回す)
//
//   npx vite build --ssr scripts/envNotice.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/envNotice.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import {
  ENV_NOTICE_TEXT,
  chromiumMajorOf,
  envNoticeOf,
  envTierOf,
  osDetailOf,
  reportText,
  windowsNameOf,
} from '../src/components/reportText';
import { HELP_ENV, HELP_QA, helpMarkdown } from '../src/help/content';

let failed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) console.log(`ok  ${name}`);
  else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}

const UA = {
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1',
  firefoxIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  chromeWin120:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chromeWin155:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  chromeWin7:
    'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
  chromeXp: 'Mozilla/5.0 (Windows NT 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/49.0.2623.112 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
  edgeWin109:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36 Edg/109.0.1518.140',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  chromeLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  odd: 'SomeCrawler/1.0',
  // 見直しの指摘で足した見本(将来 browserOf の並びを触ったときの守り)
  operaWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
  braveWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edgeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const n = (ua: string, pv?: string | null) => String(envNoticeOf(ua, pv));

// ---- 入口の知らせ ----
ok(envNoticeOf(UA.safariMac) === 'safari', 'Mac の Safari は safari(対象外)', n(UA.safariMac));
ok(envNoticeOf(UA.operaWin) === null, 'Opera は知らせを出さない(報告では外)', n(UA.operaWin));
ok(envNoticeOf(UA.braveWin) === null, 'Brave(Chrome と同じ名乗り)は出さない', n(UA.braveWin));
ok(envNoticeOf(UA.edgeMac) === null && envNoticeOf(UA.edgeMac, '14.5.0') === null, 'Mac の Edge 130 は出さない', n(UA.edgeMac));
ok(envNoticeOf(UA.chromeOs) === null, 'ChromeOS は出さない', n(UA.chromeOs));
ok(envNoticeOf(UA.firefoxMac) === 'firefox', 'Mac の Firefox は firefox', n(UA.firefoxMac));
ok(envNoticeOf(UA.firefoxWin) === 'firefox', 'Windows の Firefox は firefox', n(UA.firefoxWin));
ok(envNoticeOf(UA.chromeWin7) === 'oldWindows', 'Windows 7 の Chrome 109 は oldWindows(古いブラウザの文は重ねない)', n(UA.chromeWin7));
ok(envNoticeOf(UA.chromeXp) === 'oldWindows', 'XP の Chrome 49 は oldWindows', n(UA.chromeXp));
ok(envNoticeOf(UA.chromeWin120) === 'oldBrowser', 'Windows 10 の Chrome 120 は oldBrowser', n(UA.chromeWin120));
ok(envNoticeOf(UA.edgeWin109) === 'oldBrowser', 'Edge 109 は oldBrowser(Chrome の 109 ではなく Edg の版で見る)', n(UA.edgeWin109));
ok(envNoticeOf(UA.chromeWin155) === null, 'Windows 10 の Chrome 155 は出さない', n(UA.chromeWin155));
ok(envNoticeOf(UA.chromeWin) === null, 'Windows の Chrome 130 は出さない', n(UA.chromeWin));
ok(envNoticeOf(UA.edgeWin) === null, 'Edge 130 は Chrome の名前を含むが、出さない', n(UA.edgeWin));
ok(envNoticeOf(UA.chromeMac) === null, 'Mac の Chrome は userAgent だけでは出さない(Safari と取り違えない)', n(UA.chromeMac));
ok(envNoticeOf(UA.chromeMac, '12.7.6') === 'oldMac', 'Mac の Chrome で platformVersion 12.7.6 は oldMac', n(UA.chromeMac, '12.7.6'));
ok(envNoticeOf(UA.chromeMac, '10.15.7') === 'oldMac', 'Mac の Chrome で platformVersion 10.15.7 は oldMac', n(UA.chromeMac, '10.15.7'));
ok(envNoticeOf(UA.chromeMac, '13.0.0') === null, 'macOS 13 は出さない', n(UA.chromeMac, '13.0.0'));
ok(envNoticeOf(UA.chromeMac, '15.0.0') === null, 'macOS 15 は出さない', n(UA.chromeMac, '15.0.0'));
ok(envNoticeOf(UA.chromeMac, null) === null, 'platformVersion が取れなければ何もしない', n(UA.chromeMac, null));
ok(
  envNoticeOf(UA.chromeMac.replace('Chrome/130', 'Chrome/110'), '12.0.0') === 'oldMac',
  '古い macOS で古い Chrome は、OS の文を先にする(oldMac)',
  n(UA.chromeMac.replace('Chrome/130', 'Chrome/110'), '12.0.0'),
);
ok(envNoticeOf(UA.chromeWin, '15.0.0') === null, 'Windows の platformVersion は oldMac の判定に使わない', n(UA.chromeWin, '15.0.0'));
ok(envNoticeOf(UA.chromeLinux) === null, 'Linux の Chrome は出さない', n(UA.chromeLinux));
ok(envNoticeOf(UA.safariIphone) === null, 'iPhone の Safari は出さない(スマホの知らせが先)', n(UA.safariIphone));
ok(envNoticeOf(UA.safariIpad) === null, 'iPad の Safari は出さない', n(UA.safariIpad));
ok(envNoticeOf(UA.chromeIphone) === null, 'iPhone の Chrome は出さない', n(UA.chromeIphone));
ok(envNoticeOf(UA.firefoxIphone) === null, 'iPhone の Firefox は出さない', n(UA.firefoxIphone));
ok(envNoticeOf(UA.firefoxAndroid) === null, 'Android の Firefox は出さない', n(UA.firefoxAndroid));
ok(envNoticeOf(UA.chromeAndroid) === null, 'Android の Chrome は出さない', n(UA.chromeAndroid));
ok(envNoticeOf(UA.odd) === null, '読めない userAgent は出さない');
ok(envNoticeOf('') === null, '空の userAgent は出さない');
for (const [k, v] of Object.entries(ENV_NOTICE_TEXT)) {
  ok(v.length > 10 && !/動作環境/.test(v), `知らせの文がある: ${k}`, v);
}
ok(/対応していません/.test(ENV_NOTICE_TEXT.safari) && /修正はできません/.test(ENV_NOTICE_TEXT.safari), 'Safari の知らせは「対応していません・修正はできません」と言う');
ok(/修正はできません/.test(ENV_NOTICE_TEXT.firefox) && /修正はできません/.test(ENV_NOTICE_TEXT.oldWindows), '対象外の知らせは「修正はできません」と言う');
ok(/最新版/.test(ENV_NOTICE_TEXT.oldBrowser), '古いブラウザの知らせは新しくするよう言う');

ok(chromiumMajorOf(UA.edgeWin109) === 109 && chromiumMajorOf(UA.chromeWin155) === 155, 'Chrome・Edge の版の先頭');
ok(chromiumMajorOf(UA.firefoxWin) === null && chromiumMajorOf(UA.safariMac) === null, 'Firefox・Safari は Chrome の版を持たない');

// ---- 段 ----
const t = (ua: string, pv?: string | null) => envTierOf(ua, pv);
ok(t(UA.chromeWin) === 'supported' && t(UA.edgeWin) === 'supported' && t(UA.chromeWin155) === 'supported', 'Windows 10/11 の Chrome・Edge 128 以上は対応');
ok(t(UA.chromeMac) === 'supported' && t(UA.chromeMac, '15.0.0') === 'supported', 'Mac の Chrome は対応(版が分かれば 13 以上)');
ok(t(UA.chromeMac, '12.7.6') === 'outside', 'macOS 12 の Chrome は対象外');
ok(t(UA.safariMac) === 'outside', 'Mac の Safari は対象外(今は)');
ok(t(UA.edgeMac) === 'supported', 'Mac の Edge は対応');
ok(t(UA.firefoxWin) === 'outside' && t(UA.chromeWin7) === 'outside' && t(UA.chromeXp) === 'outside', 'Firefox・古い Windows は対象外');
ok(t(UA.chromeWin120) === 'outside' && t(UA.edgeWin109) === 'outside', '古い Chrome・Edge は対象外');
ok(t(UA.safariIphone) === 'outside' && t(UA.safariIpad) === 'outside' && t(UA.chromeAndroid) === 'outside', 'スマホ・タブレットは対象外');
ok(t(UA.chromeLinux) === 'outside' && t(UA.odd) === 'outside', 'どの段にも名前の無いもの(Linux・読めない)は外');

// ---- platformVersion → Windows 10 / 11 ----
ok(windowsNameOf('15.0.0') === 'Windows 11', '15.0.0 は Windows 11');
ok(windowsNameOf('13.0.0') === 'Windows 11', '13.0.0 は Windows 11(境目)');
ok(windowsNameOf('10.0.0') === 'Windows 10', '10.0.0 は Windows 10');
ok(windowsNameOf('1.0.0') === 'Windows 10', '1.0.0 は Windows 10(境目)');
ok(windowsNameOf('0.3.0') === null && windowsNameOf('') === null && windowsNameOf(null) === null, '0・空・null は言わない');
ok(osDetailOf(UA.chromeWin, '15.0.0') === 'Windows 11', '報告の OS: Windows 11');
ok(osDetailOf(UA.chromeMac, '15.0.0') === 'macOS 15.0.0', '報告の OS: Mac は版をそのまま', String(osDetailOf(UA.chromeMac, '15.0.0')));
ok(osDetailOf(UA.chromeWin, null) === null, 'platformVersion が無ければ言わない(今の大まかな名前のまま)');

// ---- 報告の文 ----
const full = reportText({
  version: '1.2.0',
  userAgent: UA.chromeWin,
  extra: { platformVersion: '15.0.0', screen: { width: 1536, height: 864, dpr: 1.25 }, pages: 212 },
});
console.log('--- 報告の文(くわしい環境つき)---\n' + full);
ok(
  full ===
    'バージョン: 1.2.0\nブラウザ: Chrome 130\nOS: Windows 11\nブラウザの窓: 1536×864・拡大率 1.25\n下見のページ数: 212\n対応環境: 対応環境の中',
  '報告の文に OS の本当の版・画面・ページ数・対応環境が入る',
  full,
);
const bare = reportText({ version: '1.2.0', userAgent: UA.safariMac, extra: { platformVersion: null, screen: null, pages: 0 } });
ok(
  bare === 'バージョン: 1.2.0\nブラウザ: Safari 17.5\nOS: macOS\n対応環境: 対応環境の外',
  '取れないもの(版・画面・0 ページ)は書かない',
  bare,
);
ok(reportText({ version: '1.2.0', userAgent: UA.chromeWin }) === 'バージョン: 1.2.0\nブラウザ: Chrome 130\nOS: Windows 10/11', 'extra が無ければ今までの文のまま');

// ---- ヘルプの「対応環境」の節 ----
const all = (xs: readonly string[]) => xs.join('\n');
ok(HELP_ENV.title === '対応環境', '節の名前は「対応環境」', HELP_ENV.title);
ok(/修正します/.test(HELP_ENV.lead) && /修正はできません/.test(HELP_ENV.lead), '前置きで「対応の中は直す・外は直せない」と言う', HELP_ENV.lead);
ok(HELP_ENV.tiers.length === 2, '段は2つ(確認中は今は無い)', String(HELP_ENV.tiers.length));
const [sup, out] = HELP_ENV.tiers;
ok(/^対応/.test(sup.head) && /^対象外/.test(out.head), '段の順は 対応・対象外');
const supText = all(sup.items);
ok(/Windows 10・11/.test(supText) && /macOS 13/.test(supText), '対応: Windows 10・11 と macOS 13 以降');
ok(/Chrome/.test(supText) && /Edge/.test(supText) && /128/.test(supText), '対応: Chrome・Edge の 128 以上');
ok(/\.docx/.test(supText) && /\.txt/.test(supText) && /\.md/.test(supText) && /Word だけの特別対応/.test(supText), '対応: 原稿の3形式と、Word だけの特別対応');
const outText = all(out.items);
for (const w of ['スマホ', 'タブレット', 'Windows 7', 'XP', 'macOS 12', 'Safari', '40', '42', 'Firefox', 'Pages', 'Google ドキュメント', '一太郎', 'Markdown']) {
  ok(outText.includes(w), `対象外: ${w}`);
}
const restText = all(HELP_ENV.items);
ok(/8GB/.test(restText) && /16GB/.test(restText) && /1280/.test(restText), '性能・画面: メモリと画面の幅');
ok(/どこにも送りません/.test(restText), '原稿と画像はどこにも送らない');
const howText = all(HELP_ENV.howTo);
ok(
  /バージョン情報/.test(howText) && /この Mac について/.test(howText) && /Google Chrome について/.test(howText) && /Microsoft Edge について/.test(howText),
  '版の調べ方: Windows・Mac・Chrome・Edge',
);
const md = helpMarkdown();
ok(md.includes(`## ${HELP_ENV.title}`), '配る .md にも「対応環境」が入る');
ok(HELP_ENV.tiers.every((x) => md.includes(`### ${x.head}`)) && md.includes(`### ${HELP_ENV.howToHead}`), '配る .md に2段と版の調べ方の見出し');
const qa = HELP_QA.find((x) => /Pages/.test(x.q));
ok(!!qa && /Markdown/.test(qa.a) && /ダウンロード/.test(qa.a), '困ったとき: Pages・Google ドキュメントは Markdown にする');

if (failed) {
  console.log(`\n${failed} 件落ちた`);
  process.exit(1);
}
console.log('\n全部通った');
