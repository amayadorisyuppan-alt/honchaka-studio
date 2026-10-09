// 保存ファイルの読み込みで、settings.printRules(印刷所の決まり)が壊れていたときの扱いの検査。
//
// ## なぜ在るか
//
// AI に直してもらった JSON や古い保存には、printRules が「文字列・数・配列・null」で返ってくることがある。
// キーが無いときは、いま開いている本の決まりを残す(src/project/file.ts の sanitize)。
// 型が違うときも**同じ扱い**でなければ、用紙とノドが黙って KDP の決まりに戻り、入れた数字が消える
// (2026-10-01 読み直しで発見)。
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   npx vite build --ssr scripts/printRulesFile.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/printRulesFile.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
//
// ## 下見の仕上がり線のための覚え書き(2026-10-02)
//
// 組版HTMLの head に、その HTML を組んだときの塗り足しを書く(src/typeset/html.ts の <meta name="studio-bleed">)。
// 下見は設定ではなくこの覚え書きから線の位置を取るので、**設定 → HTML → 読み戻し**が合っていることをここで確かめる。
import { bleedOf, defaultSettings } from '../src/models/project';
import type { PrintRules } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import { fromProjectFile, toProjectFile } from '../src/project/file';
import { bleedOfHtml, manuscriptHtml } from '../src/typeset/html';

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

const RULES: PrintRules = { bleedMm: 4, bleedGutter: false, gutterMinMm: 18, thickPages: 250, thickGutterMm: 22 };
const ms = sampleManuscript();
const base = { ...defaultSettings(), printTarget: 'printshop' as const, printRules: RULES };
const snap = (settings: typeof base | (Omit<typeof base, 'printRules'> & { printRules?: undefined })) =>
  ({ settings, cover: defaultCoverSettings(), manuscript: ms, source: null }) as never;

const text = toProjectFile(snap(base), true);

for (const bad of ['x', 5, [], null, true]) {
  const label = JSON.stringify(bad);
  const o = JSON.parse(text);
  o.settings.printRules = bad;
  const r = fromProjectFile(JSON.stringify(o), snap(base));
  ok(
    JSON.stringify(r.project.settings.printRules) === JSON.stringify(RULES),
    `型違い ${label}: いまの決まりを残す`,
    JSON.stringify(r.project.settings.printRules),
  );
  ok(r.warnings.some((w) => w.includes('印刷所の決まり')), `型違い ${label}: 知らせる`, JSON.stringify(r.warnings));

  // 別の本として読むときは、いまの本の数字を紛れ込ませない
  const other = { ...base, bookId: 'another-book' };
  const o2 = JSON.parse(text);
  o2.settings.printRules = bad;
  o2.settings.bookId = 'file-book';
  const r2 = fromProjectFile(JSON.stringify(o2), snap(other));
  ok(r2.project.settings.printRules === undefined, `型違い ${label}: 別の本には残さない`, JSON.stringify(r2.project.settings.printRules));
  ok(r2.warnings.some((w) => w.includes('印刷所の決まり')), `型違い ${label}: 別の本でも知らせる`);

  // いま開いている本にも決まりが無ければ、残すものが無い(捨てて知らせる)
  const noRules = { ...defaultSettings(), printTarget: 'kdp' as const };
  const r3 = fromProjectFile(JSON.stringify(o), snap(noRules as never));
  ok(r3.project.settings.printRules === undefined, `型違い ${label}: いまの本にも無ければ捨てる`);
  ok(r3.warnings.some((w) => w.includes('印刷所の決まり')), `型違い ${label}: 捨てたことを知らせる`);
}

// 正しい形は、そのまま通る(警告なし)
{
  const r = fromProjectFile(text, snap(base));
  ok(JSON.stringify(r.project.settings.printRules) === JSON.stringify(RULES), '正しい形は値のまま');
  ok(!r.warnings.some((w) => w.includes('印刷所の決まり')), '正しい形は警告なし', JSON.stringify(r.warnings));
}
// AI 用の JSON(画像なし)でキーが無いときも、いまの決まりを残す(前からの動き)
{
  const o = JSON.parse(toProjectFile(snap(base), false));
  delete o.settings.printRules;
  const r = fromProjectFile(JSON.stringify(o), snap(base));
  ok(JSON.stringify(r.project.settings.printRules) === JSON.stringify(RULES), 'キーが無いときも、いまの決まりを残す');
}
// ［保存する］の控え(画像込み)にキーが無いのは「保存した時点で未設定」: いまの決まりを持ち込まない・警告しない
{
  const o = JSON.parse(text);
  delete o.settings.printRules;
  const r = fromProjectFile(JSON.stringify(o), snap(base));
  ok(r.project.settings.printRules === undefined, '控えにキーが無ければ、決まりは未設定のまま開く', JSON.stringify(r.project.settings.printRules));
  ok(!r.warnings.some((w) => w.includes('印刷所の決まり')), '控えにキーが無くても警告しない', JSON.stringify(r.warnings));
}

// ---- 組版HTMLの、塗り足しの覚え書き(下見の仕上がり線が読む) ----
{
  const cases: [string, ReturnType<typeof defaultSettings>][] = [
    ['KDP(天・地・小口 3.2mm、ノドなし)', { ...defaultSettings(), printTarget: 'kdp' }],
    ['印刷所・決まりなし(KDP の決まりで組む)', { ...defaultSettings(), printTarget: 'printshop' }],
    ['印刷所・四辺 3mm', { ...defaultSettings(), printTarget: 'printshop', printRules: { ...RULES, bleedMm: 3, bleedGutter: true } }],
    ['印刷所・三辺 4mm', { ...defaultSettings(), printTarget: 'printshop', printRules: { ...RULES, bleedMm: 4, bleedGutter: false } }],
    ['印刷所・2.5mm 四辺(小数)', { ...defaultSettings(), printTarget: 'printshop', printRules: { ...RULES, bleedMm: 2.5, bleedGutter: true } }],
    ['印刷所・塗り足し 0', { ...defaultSettings(), printTarget: 'printshop', printRules: { ...RULES, bleedMm: 0, bleedGutter: true } }],
    ['横組み・印刷所・四辺 3mm', { ...defaultSettings(), writingMode: 'horizontal', printTarget: 'printshop', printRules: { ...RULES, bleedMm: 3, bleedGutter: true } }],
  ];
  for (const [name, st] of cases) {
    const html = manuscriptHtml(ms, st);
    ok(JSON.stringify(bleedOfHtml(html)) === JSON.stringify(bleedOf(st)), `覚え書きを読み戻すと、設定の塗り足しと同じ: ${name}`, `${JSON.stringify(bleedOfHtml(html))} / ${JSON.stringify(bleedOf(st))}`);
    ok((html.match(/<meta name="studio-bleed"/g) ?? []).length === 1 && html.indexOf('<meta name="studio-bleed"') < 600, `覚え書きは head の先頭に1つだけ: ${name}`);
  }
  ok(bleedOfHtml('<!DOCTYPE html><html><head><meta charset="UTF-8"></head></html>') === null, '覚え書きの無い HTML は null(線を出さない)');
  ok(bleedOfHtml('<meta name="studio-bleed" content="3 3 3">') === null, '数が足りない覚え書きは null');
  ok(bleedOfHtml('<meta name="studio-bleed" content="3 x 3 3">') === null, '数でない覚え書きは null');
  ok(bleedOfHtml('') === null, '空の HTML は null');
  // 書名に同じ形の文字列が入っていても、取り違えない(書名はエスケープされ、覚え書きは title より前にある)
  const tricky = manuscriptHtml({ ...ms, title: '<meta name="studio-bleed" content="9 9 9 9">' }, { ...defaultSettings(), printTarget: 'kdp' });
  ok(JSON.stringify(bleedOfHtml(tricky)) === JSON.stringify(bleedOf({ printTarget: 'kdp' })), '書名に覚え書きと同じ形の文字が入っていても、本物のほうを読む', JSON.stringify(bleedOfHtml(tricky)));
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
