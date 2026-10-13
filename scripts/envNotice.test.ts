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
// - 対応の段に、保守の順番(いちばん確かめているのは Windows・Chrome・Word。ほかはできる限り)の1行がある(2026-10-13 ユーザー決定)
// - ヘルプの「Word 以外で書いた原稿」(HELP_SOURCES。2026-10-13 ユーザーの実機の試し):
//   - 画面のパネル(HelpPanel.tsx)と配る .md の両方に、対応環境のすぐ下に出る
//   - Google ドキュメントは Word(.docx)だけをすすめ、Markdown は使わないよう言う。テキストでダウンロードしたら Pages のテキストと同じ
//   - Pages はテキストに書き出す。Word の書き出しは章に分かれない。Markdown の書き出しは無い
//   - AI の手順の頼み方の名前が、AI の工程と同じ(TEXT_MARKS_PROMPT)。手順のボタンの名前が画面にある
//   - 作者の手元のパソコンで試した結果だという断りと、違ったら報告してほしいという一言がある
//   - 「困ったとき」・対応環境の「対象外」・入口の③・読めない形式の断りが、この節を名前で指す
//   - ヘルプ・画面の文(src の文字列。注は除く)・README のどこにも、Pages から Markdown を作れるような言い方と、
//     Google ドキュメントに Markdown をすすめる言い方が残っていない。古い頼み方の名前も残っていない
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
import { HELP_ENV, HELP_QA, HELP_SOURCES, HELP_TABS, TEXT_MARKS_PROMPT, helpMarkdown } from '../src/help/content';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
// 保守の順番(2026-10-13 ユーザー決定)。2段は変えずに、対応の段に1行
ok(
  sup.items.some((x) => /Windows・Google Chrome・Word（\.docx）/.test(x) && /から優先して直し/.test(x) && /できる限り早く直します/.test(x)),
  // 前置きと段の名前の「直します」と食い違わないよう、直す順番として言う(2026-10-13 見直しの指摘)
  '対応: いちばん確かめている Windows・Chrome・Word から先に直し、ほかの組み合わせもできる限り早く直すと言う',
  supText,
);
const outText = all(out.items);
for (const w of ['スマホ', 'タブレット', 'Windows 7', 'XP', 'macOS 12', 'Safari', '40', '42', 'Firefox', 'Pages', 'Google ドキュメント', '一太郎']) {
  ok(outText.includes(w), `対象外: ${w}`);
}
ok(/Pages など[^。]*テキスト（\.txt）/.test(outText), '対象外: Pages などはテキスト（.txt）に書き出せば使える', outText);
ok(outText.includes(`「${HELP_SOURCES.title}」`), '対象外: 「Word 以外で書いた原稿」を名前で指す', outText);
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
ok(/Google ドキュメントは Word（\.docx）でダウンロード/.test(outText), '対象外: Google ドキュメントは Word（.docx）でダウンロードすれば使える');
// Google ドキュメントは Word(.docx)だけをすすめ、Pages はテキスト(2026-10-13 ユーザー決定。Pages には Markdown の書き出しが無い)。
// 問いは探す人がいるので残し、答えは1〜2文で「Word 以外で書いた原稿」を指す
const qa = HELP_QA.find((x) => x.q === 'Pages や Google ドキュメントで書いた原稿を使いたい');
ok(!!qa, '困ったとき: 「Pages や Google ドキュメントで書いた原稿を使いたい」は残す');
ok(!!qa && /Google ドキュメントの原稿は[^。]*「Microsoft Word（\.docx）」/.test(qa.a), '困ったとき: Google ドキュメントは Word（.docx）でダウンロードする', qa?.a);
ok(!!qa && /Pages の原稿は[^。]*「ファイル」→「書き出す」→「標準テキスト」/.test(qa.a), '困ったとき: Pages はテキストに書き出す', qa?.a);
ok(!!qa && !/Markdown/.test(qa.a), '困ったとき: Markdown をすすめない(Google の書き出し・Pages とも)', qa?.a);
ok(!!qa && qa.a.includes(`「${HELP_SOURCES.title}」`) && (qa.a.match(/。/g) ?? []).length <= 2, '困ったとき: 1〜2文で「Word 以外で書いた原稿」を名前で指す', qa?.a);
// 節は「困ったとき」ではなく「どこで何ができるか」の側に出るので、困ったときの答えはそちらの名前も言う(2026-10-13 見直しの指摘)
for (const q of ['Pages や Google ドキュメントで書いた原稿を使いたい', '章に分かれません']) {
  const a = HELP_QA.find((x) => x.q === q)?.a ?? '';
  ok(a.includes(`「どこで何ができるか」の「${HELP_SOURCES.title}」`), `困ったとき「${q}」: 「どこで何ができるか」の「${HELP_SOURCES.title}」と指す`, a);
}

// ---- ヘルプの「Word 以外で書いた原稿」(2026-10-13 ユーザー決定)----
const S = HELP_SOURCES;
ok(S.title === 'Word 以外で書いた原稿', '節の名前は「Word 以外で書いた原稿」', S.title);
ok(/いちばんよく読めるのは、Word（\.docx）/.test(S.lead), '前置き: いちばんよく読めるのは Word（.docx）', S.lead);
const toolText = (head: string) => all(S.tools.find((t) => t.head.startsWith(head))?.items ?? []);
const gText = toolText('Google ドキュメント');
const pText = toolText('Pages');
const tText = toolText('テキストの原稿');
ok(S.tools.length === 3 && !!gText && !!pText && !!tText, '道具は Google ドキュメント・Pages・テキストの原稿の3つ', S.tools.map((t) => t.head).join(' / '));
ok(
  /「ファイル」→「ダウンロード」→「Microsoft Word（\.docx）」/.test(gText) && /おすすめするのは、この方法だけ/.test(gText),
  'Google: Word（.docx）でのダウンロードだけをすすめる',
  gText,
);
ok(/「Markdown（\.md）」でのダウンロードは使わないでください/.test(gText) && /粗く/.test(gText) && /抜ける/.test(gText), 'Google: Markdown（.md）は使わない(画像が粗くなる・抜ける)', gText);
ok(/テキスト（\.txt）[^。]*「テキストの原稿」と同じ/.test(gText), 'Google: テキストでダウンロードしたときは、テキストの原稿(Pages と同じ)', gText);
// 作者が試していないこと・ほかで確かめたことは、その行で断る(note は「とくに断りのないかぎり」。2026-10-13 見直しの指摘)
ok(/書式なしテキスト[^。]*まだ試していません/.test(gText), 'Google: 書式なしテキストは作者がまだ試していないと断る', gText);
ok(/場面の区切りが抜ける[^。]*公開されている文書/.test(gText), 'Google: Markdown で画像などが抜けるのは、公開の文書で確かめたと断る', gText);
ok(/とくに断りのないかぎり/.test(S.note), '断り: 作者のパソコンの結果なのは「とくに断りのないかぎり」', S.note);
ok(/「ファイル」→「書き出す」→「標準テキスト」/.test(pText) && /「テキストの原稿」/.test(pText), 'Pages: テキストに書き出して、テキストの原稿として読む', pText);
ok(/「Word」で書き出したファイルは[^。]*章に分かれず/.test(pText), 'Pages: Word の書き出しは章に分かれない', pText);
ok(/Pages には、Markdown（\.md）で書き出す機能はありません/.test(pText), 'Pages: Markdown の書き出しは無い', pText);
ok(/「第一章」/.test(tText) && /［挿絵］/.test(tText) && /｜漢字《よみ》/.test(tText) && /AI に記号を書き足して/.test(tText), 'テキスト: 章の分かれ方・画像は［挿絵］・ルビの記号・AI で記号を足す', tText);
const steps = all(S.aiSteps);
ok(steps.includes(`「${TEXT_MARKS_PROMPT}」`), 'AI の手順: 頼み方の名前が AI の工程と同じ', steps);
ok(/1文字も変えず/.test(steps) && /\.md/.test(steps), 'AI の手順: 文章は変えずに記号を足して .md にする', steps);
ok(
  /自分のパソコン（Windows と Mac）/.test(S.note) && /2026年10月/.test(S.note) && /［お使いの環境をコピー］/.test(S.note) && /報告・感想のフォーム/.test(S.note),
  '断り: 作者の手元のパソコンで試した結果で、違ったら［お使いの環境をコピー］の文を添えて報告してほしい',
  S.note,
);
ok(HELP_QA.some((x) => S.note.includes(`「${x.q}」`) && /［お使いの環境をコピー］/.test(x.a)), '断り: 指している「困ったとき」の問いが本当にあり、報告のやり方を言っている', S.note);

// 画面のパネルにも出る(対応環境のすぐ下・工程の前)。パネルは React なので、ソースで並びを見る
const read = (p: string) => readFileSync(p, 'utf8');
const panel = read('src/components/HelpPanel.tsx');
const at = (s: string) => panel.indexOf(s);
ok(
  ['HELP_SOURCES.title', 'HELP_SOURCES.lead', 'HELP_SOURCES.tools.map', 'HELP_SOURCES.aiSteps.map', 'HELP_SOURCES.note'].every((x) => at(x) > 0),
  'パネル: 節の名前・前置き・道具ごと・AI の手順・断りを出す',
);
ok(at('HELP_ENV.howTo.map') < at('HELP_SOURCES.title') && at('HELP_SOURCES.note') < at('HELP_TABS.map'), 'パネル: 対応環境のすぐ下、工程の前に置く');
// 困ったときの答えが「どこで何ができるか」の側と言っているのが本当か(その名前の切り替えの中に出る)
ok(
  panel.includes('どこで何ができるか') && at("view === 'tabs' &&") > 0 && at("view === 'tabs' &&") < at('HELP_SOURCES.title') && at('HELP_SOURCES.note') < at("view === 'qa' &&"),
  'パネル: 節は「どこで何ができるか」の側に出る(困ったときの答えの指し方と合う)',
);
// 配る .md にも同じ並びで入る
ok(md.includes(`## ${S.title}`) && S.tools.every((t) => md.includes(`### ${t.head}`)) && md.includes(`### ${S.aiHead}`), '配る .md: 節と道具ごと・AI の手順の見出し');
ok(S.aiSteps.every((x, i) => md.includes(`${i + 1}. ${x}`)) && md.includes(S.note), '配る .md: 番号つきの手順と断り');
ok(md.indexOf(`## ${HELP_ENV.title}`) < md.indexOf(`## ${S.title}`) && md.indexOf(`## ${S.title}`) < md.indexOf('## 工程'), '配る .md: 対応環境のすぐ下、工程の前');

// AI の手順に出てくるボタン・工程の名前が、画面にある(言い換えたまま古くならないように)
const aiStep = read('src/components/steps/AiStep.tsx');
const startScreen = read('src/components/StartScreen.tsx');
const uiText = aiStep + startScreen + HELP_TABS.map((t) => t.title).join('\n');
for (const m of steps.matchAll(/［([^］]+)］/g)) ok(uiText.includes(m[1]), `AI の手順のボタン［${m[1]}］が画面にある`);
// AI の工程の頼み方は TEXT_MARKS_PROMPT を使う(import・PROMPTS・文字を飾るの並び)
// 注を外す(だいたいで足りる)。/* は行の頭か JSX の { のあとにあるものだけを注の始まりと見る
// (「// importers/*.ts」のような行の注の中の /* から、次の */ までを丸ごと消さないように)。// は URL の : のあとを除く
const noComments = (s: string) =>
  s.replace(/(^|\{)[ \t]*\/\*[\s\S]*?\*\//gm, '$1').replace(/(^|[\s;,(){}])\/\/.*$/gm, '$1');
ok((noComments(aiStep).match(/\bTEXT_MARKS_PROMPT\b/g) ?? []).length >= 3, 'AI の工程: 頼み方の名前は TEXT_MARKS_PROMPT から取る');

// ほかの案内も、この節を名前で指す
ok(startScreen.includes(`「${S.title}」`), '入口の③: 「Word 以外で書いた原稿」を名前で指す');
const load = read('src/importers/load.ts');
ok(load.includes(`「${S.title}」`), '読めない形式の断り: 「Word 以外で書いた原稿」を名前で指す');
ok(/pages: '[^'\n]*「ファイル」→「書き出す」→「標準テキスト」/.test(load) && !/pages: '[^'\n]*Markdown/.test(load), '読めない形式の断り: Pages はテキストに書き出す(Markdown は言わない)');

// 残りもの探し: ヘルプ・画面の文(src の .ts / .tsx から注を除いたもの)・README に、
// Pages から Markdown を作れるような言い方・Google ドキュメントに Markdown をすすめる言い方・古い頼み方の名前が無い。
// src は行をつないでから見る(JSX の文は「Pages の原稿は」と「Markdown（.md）か…」のように行をまたいで書いてある。前の入口の③がそうだった)
const joinLines = (s: string) => s.replace(/\r?\n[ \t]*/g, '');
const PAGES_MD = [/Pages[^。\n]*Markdown（\.md）か/, /Pages[^。\n]*Markdown かテキスト/, /Pages[^。\n]*Markdown に(し|書き換え|変え)/, /Pages の原稿を Markdown/];
const GOOGLE_MD = [/Google ドキュメント[^。\n]*Markdown（\.md）か/, /Google ドキュメント[^。\n]*Markdown かテキスト/, /Google ドキュメント[^。\n]*Markdown に(し|書き換え|変え)/];
const sources: [string, string][] = [
  ['ヘルプの .md', md],
  ['README.md', read('README.md')],
  ...readdirSync('src', { recursive: true })
    .map(String)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f): [string, string] => [join('src', f), joinLines(noComments(read(join('src', f))))]),
];
for (const [name, text] of sources) {
  const hit = [...PAGES_MD, ...GOOGLE_MD].find((re) => re.test(text));
  if (hit) ok(false, `残りもの: ${name} に Pages・Google ドキュメントへ Markdown をすすめる言い方がある`, text.match(hit)?.[0]);
}
ok(sources.length > 50, `残りもの探しは src と README を見た(${sources.length} ファイル)`);
const OLD_PROMPT = 'Pages の原稿を ' + 'Markdown にする';
ok(!sources.some(([, text]) => text.includes(OLD_PROMPT)), '残りもの: 古い頼み方の名前が残っていない');
const imgQa = HELP_QA.find((x) => x.q === '画像が取り込めません');
ok(
  !!imgQa && /\.md の中に画像そのもの/.test(imgQa.a) && /「Microsoft Word（\.docx）」/.test(imgQa.a) && !/\.md の原稿には画像が入りません/.test(imgQa.a),
  '困ったとき: .md の中の画像は入る。Google ドキュメントは Word（.docx）で',
  imgQa?.a,
);

if (failed) {
  console.log(`\n${failed} 件落ちた`);
  process.exit(1);
}
console.log('\n全部通った');
