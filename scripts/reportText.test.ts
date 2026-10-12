// 報告に貼る文と、保存ファイルに入る「書いたアプリの版」の検査。(2026-10-12 修正リストの 5)
//
// ## 確かめること
//
// - 報告に貼る文: バージョン(印つき/なし)・ブラウザ・OS・(エラーの画面だけ)エラーの文。原稿や書名は入らない
// - userAgent が読めないときは、userAgent をそのまま出す
// - 保存ファイル(バックアップ・AI 用の両方)に savedBy { app, edition } が入る
// - savedBy の無い古いファイルも、ある新しいファイルも、同じ中身で開ける
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   npx vite build --ssr scripts/reportText.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/reportText.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { defaultSettings } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import { fromProjectFile, toProjectFile } from '../src/project/file';
import { EDITION } from '../src/edition';
import { browserOf, osOf, reportText, versionLabel } from '../src/components/reportText';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}

const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  odd: 'SomeCrawler/1.0',
};

ok(browserOf(UA.chromeWin) === 'Chrome 130', 'Chrome', String(browserOf(UA.chromeWin)));
ok(browserOf(UA.edgeWin) === 'Edge 130', 'Edge は Chrome と取り違えない', String(browserOf(UA.edgeWin)));
ok(browserOf(UA.firefoxMac) === 'Firefox 131', 'Firefox', String(browserOf(UA.firefoxMac)));
ok(browserOf(UA.safariMac) === 'Safari 17.5', 'Safari', String(browserOf(UA.safariMac)));
ok(browserOf(UA.odd) === null, '読めない userAgent は null');
ok(osOf(UA.chromeWin) === 'Windows 10/11', 'OS: Windows');
ok(osOf(UA.firefoxMac) === 'macOS', 'OS: macOS');
ok(osOf(UA.safariIphone) === 'iOS', 'OS: iPhone は macOS と取り違えない', String(osOf(UA.safariIphone)));
ok(osOf(UA.chromeAndroid) === 'Android', 'OS: Android は Linux と取り違えない', String(osOf(UA.chromeAndroid)));
ok(osOf(UA.chromeLinux) === 'Linux', 'OS: Linux');

ok(versionLabel('1.1.0') === '1.1.0', '印なしは番号だけ');
ok(versionLabel('1.1.0', '○○版') === '1.1.0（○○版）', '印があれば番号のあとに付く');

const plain = reportText({ version: '1.1.0', userAgent: UA.chromeWin });
console.log('--- 標準の版の例 ---\n' + plain);
ok(plain === 'バージョン: 1.1.0\nブラウザ: Chrome 130\nOS: Windows 10/11', '標準の版の文', plain);

const marked = reportText({ version: '1.1.0', mark: '○○版', userAgent: UA.firefoxMac });
console.log('--- 印つきの例 ---\n' + marked);
ok(marked.startsWith('バージョン: 1.1.0（○○版）\n'), '印つきの文は番号のあとに印が付く', marked);

const crash = reportText({
  version: '1.1.0',
  userAgent: UA.edgeWin,
  errorMessage: "Cannot read properties of undefined (reading 'x')\n    at foo (bundle.js:1:2)",
});
console.log('--- エラーの画面の例 ---\n' + crash);
ok(crash.endsWith("エラー: Cannot read properties of undefined (reading 'x')"), 'エラーは先頭の1行だけ', crash);
ok(!crash.includes('bundle.js'), 'スタックは入れない');

const long = reportText({ version: '1.1.0', userAgent: UA.chromeWin, errorMessage: 'あ'.repeat(500) });
ok(long.split('\n').pop()!.length <= 'エラー: '.length + 201, '長いエラーの文は切る', String(long.length));

const odd = reportText({ version: '1.1.0', userAgent: UA.odd });
ok(odd === 'バージョン: 1.1.0\nブラウザ: SomeCrawler/1.0', '読めなければ userAgent をそのまま', odd);
ok(reportText({ version: '1.1.0', userAgent: '' }).endsWith('ブラウザ: 不明'), 'userAgent が空なら「不明」');

// ---- 保存ファイルの savedBy ----
const ms = sampleManuscript();
const snap = (settings = defaultSettings()) =>
  ({ settings, cover: defaultCoverSettings(), manuscript: ms, source: null }) as never;

for (const withImages of [true, false]) {
  const text = toProjectFile(snap(), withImages);
  const o = JSON.parse(text);
  const label = withImages ? 'バックアップ' : 'AI 用';
  ok(
    o.savedBy && typeof o.savedBy.app === 'string' && o.savedBy.app.length > 0 && o.savedBy.edition === EDITION.id,
    `${label}: savedBy に版が入る`,
    JSON.stringify(o.savedBy),
  );
  ok(o.format === 'book-studio-project' && o.version === 1, `${label}: ファイルの形の番号(format・version)は変わらない`);
  ok(Object.keys(o).indexOf('savedBy') < Object.keys(o).indexOf('settings'), `${label}: savedBy は設定より前(先頭にまとまる)`);

  const withBy = fromProjectFile(text, snap());
  delete o.savedBy;
  const withoutBy = fromProjectFile(JSON.stringify(o), snap());
  ok(
    JSON.stringify(withBy.project) === JSON.stringify(withoutBy.project),
    `${label}: savedBy の有る無しで、開いた中身が変わらない`,
  );
  ok(
    JSON.stringify(withBy.warnings) === JSON.stringify(withoutBy.warnings),
    `${label}: savedBy の有る無しで、知らせも変わらない`,
    JSON.stringify([withBy.warnings, withoutBy.warnings]),
  );
}

// 形の怪しい savedBy が付いていても、開ける(読み込みはこの欄を見ない)
{
  const o = JSON.parse(toProjectFile(snap(), true));
  o.savedBy = 'x';
  let opened = true;
  try {
    fromProjectFile(JSON.stringify(o), snap());
  } catch {
    opened = false;
  }
  ok(opened, '型違いの savedBy が付いていても開ける');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
