// 縦組みの本で、書名・著者名だけ横組みにする設定(settings.titleWritingMode)の検査。(2026-10-03)
//
// ## 何を確かめるか
//
//   1. titleWritingModeOf の4通り(縦×省略=縦 / 縦×横=横 / 横×省略=横 / 横×縦=横)
//   2. isLatinOnlyTitle(英字・数字・記号だけ=真。日本語が1字でもあれば偽。ルビ・強調の記法は外して見る)
//   3. 古い保存(項目なし)を開いても何も変わらない / AI の JSON から項目が落ちても残る / 壊れた値は知らせて前の値を残す
//   4. 組版HTML: 未選択の縦の本は大扉が縦(横組みの指定が入らない)。横書きにした縦の本は大扉に
//      writing-mode: horizontal-tb と実寸の幅・高さが入り、書名は縦中横を掛けない。本文・柱・奥付は変わらない。
//      横組みの本は、設定があっても変わらない
//   5. 下見は向きを変えても組み直さない: paintNeutral が書名の向きを固定する(sameNeutral が同じと言う)ので
//      下見へ渡す組版HTMLが1バイトも変わらない。向きは previewPaintCss が選ぶ(横書きなら大扉の規則を重ね、
//      縦なら横用の字の並びを隠す)。紙の書き出し(完全な設定)は正しい向きの1つだけを持つ
//   6. 電子書籍の扉: 縦の本の横書きだけ扉の html に class="tp-h" が付き、style.css に横組みの規則が入る。
//      本文の向き(縦)・ほかのページ・縦のままの本は変わらない
//
// 紙(Vivliostyle)と表紙の実測は scripts/check-title-horizontal.py と scripts/check-title-cover.py。
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   npx vite build --ssr scripts/titleWritingMode.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/titleWritingMode.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { defaultSettings, titleWritingModeOf } from '../src/models/project';
import type { WritingMode } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import { fromProjectFile, toProjectFile } from '../src/project/file';
import { manuscriptHtml } from '../src/typeset/html';
import { isLatinOnlyTitle } from '../src/typeset/text';
import { paintNeutral, previewPaintCss, sameNeutral } from '../src/preview/paint';
import { buildEpubBook, previewImageResolver } from '../src/exporters/epub';

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

// 1. 4通り
const four: [string, WritingMode, WritingMode | undefined, WritingMode][] = [
  ['縦×省略', 'vertical', undefined, 'vertical'],
  ['縦×横', 'vertical', 'horizontal', 'horizontal'],
  ['横×省略', 'horizontal', undefined, 'horizontal'],
  ['横×縦', 'horizontal', 'vertical', 'horizontal'],
];
for (const [n, wm, tw, want] of four) {
  ok(titleWritingModeOf({ writingMode: wm, titleWritingMode: tw }) === want, `titleWritingModeOf ${n}`);
}
ok(defaultSettings().titleWritingMode === undefined, '既定は省略(いまどおり)');

// 2. 英字だけの判定
const latin: [string, boolean][] = [
  ['Hello', true],
  ['Hello 2', true],
  ['The Quiet Station: 2nd', true],
  ['Hello 世界', false],
  ['ひらがな', false],
  ['カタカナ', false],
  ['한글', false],
  ['猫の駅', false],
  ['｜Hello《へろー》', true], // ルビの記法は外して、親文字(Hello)で見る(読みの仮名は数えない)
  ['｜こんにちは《Hello》', false], // 親文字が日本語
  ['**Hello**', true], // 強調の記法は外して見る
  ['*Hello*', true],
  ['', false],
  ['   ', false],
];
for (const [t, want] of latin) ok(isLatinOnlyTitle(t) === want, `isLatinOnlyTitle(${JSON.stringify(t)}) = ${want}`);

// 3. 保存ファイル
const ms = sampleManuscript();
const snap = (settings: ReturnType<typeof defaultSettings>) =>
  ({ settings, cover: defaultCoverSettings(), manuscript: ms, source: null }) as never;
const horizontalBook = { ...defaultSettings(), titleWritingMode: 'horizontal' as const };

// 3a. 往復
{
  const text = toProjectFile(snap(horizontalBook), true);
  const r = fromProjectFile(text, snap(defaultSettings()));
  ok(r.project.settings.titleWritingMode === 'horizontal', '往復: 横書きのまま');
}
// 3b. 古い保存(項目なし)は、いま開いている本が「省略」のままなら省略のまま
{
  const text = toProjectFile(snap(defaultSettings()), true);
  const o = JSON.parse(text);
  delete o.settings.titleWritingMode;
  const r = fromProjectFile(JSON.stringify(o), snap(defaultSettings()));
  ok(r.project.settings.titleWritingMode === undefined, '古い保存: 値が変わらない(省略のまま)');
  ok(r.warnings.length === 0, '古い保存: 知らせが出ない', JSON.stringify(r.warnings));
}
// 3c. AI の JSON から項目が丸ごと落ちたとき: いま開いている本の値を残す(黙って縦へ戻さない)
{
  // AI 用の JSON(画像なし)。［保存する］の控え(画像込み)では、キーが無ければ未設定のまま開く(file.ts の keepMissing)
  const text = toProjectFile(snap(horizontalBook), false);
  const o = JSON.parse(text);
  delete o.settings.titleWritingMode;
  const r = fromProjectFile(JSON.stringify(o), snap(horizontalBook));
  ok(r.project.settings.titleWritingMode === 'horizontal', 'AI の JSON で項目が落ちても横書きを残す', String(r.project.settings.titleWritingMode));
  // 別の本として読むときは、いまの本の値を紛れ込ませない
  const o2 = JSON.parse(text);
  delete o2.settings.titleWritingMode;
  o2.settings.bookId = 'file-book';
  const r2 = fromProjectFile(JSON.stringify(o2), snap({ ...horizontalBook, bookId: 'another-book' }));
  ok(r2.project.settings.titleWritingMode === undefined, '別の本には残さない', String(r2.project.settings.titleWritingMode));
}
// 3d. 壊れた値は、知らせて前の値を残す
for (const bad of ['diagonal', 5, null, [], true]) {
  const o = JSON.parse(toProjectFile(snap(horizontalBook), true));
  o.settings.titleWritingMode = bad;
  const r = fromProjectFile(JSON.stringify(o), snap(horizontalBook));
  ok(r.project.settings.titleWritingMode === 'horizontal', `壊れた値 ${JSON.stringify(bad)}: 前の値を残す`, String(r.project.settings.titleWritingMode));
  ok(r.warnings.some((w) => w.includes('書名の向き')), `壊れた値 ${JSON.stringify(bad)}: 知らせる`, JSON.stringify(r.warnings));
}

// 4. 組版HTML
const html = (patch: Partial<ReturnType<typeof defaultSettings>>) => manuscriptHtml(ms, { ...defaultSettings(), ...patch });
const tpCss = (h: string) => {
  const i = h.indexOf('section.titlepage {');
  return i < 0 ? '' : h.slice(i, h.indexOf('/* ---- 全面画像', i));
};
const vOff = html({ writingMode: 'vertical' });
const vSame = html({ writingMode: 'vertical', titleWritingMode: 'vertical' });
const vH = html({ writingMode: 'vertical', titleWritingMode: 'horizontal' });
ok(vOff === vSame, '縦×省略 と 縦×縦 は同じ HTML');
ok(!/section\.titlepage \{[^}]*horizontal-tb/.test(tpCss(vOff)), '縦×省略: 大扉に横組みの指定が入らない');
ok(/section\.titlepage \{[^}]*writing-mode: horizontal-tb;[^}]*width: [\d.]+mm;[^}]*height: [\d.]+mm;/.test(tpCss(vH)), '縦×横: 大扉の箱が横組みで、実寸の幅と高さを持つ');
ok(/\.titlepage \.author \{[^}]*horizontal-tb[^}]*text-align: center/.test(tpCss(vH)), '縦×横: 著者名が横組みで中央そろえ');
ok(!/\.titlepage h1 \{[^}]*margin-right/.test(tpCss(vH)), '縦×横: 書名に縦用の右寄せが入らない');
// 縦中横: 書名に 2 桁の数字があるとき、縦組みでだけ tcy が掛かる
{
  const m2 = { ...ms, title: '第12駅' };
  const hv = manuscriptHtml(m2, { ...defaultSettings(), writingMode: 'vertical' });
  const hh = manuscriptHtml(m2, { ...defaultSettings(), writingMode: 'vertical', titleWritingMode: 'horizontal' });
  const h1 = (h: string) => /<h1>([\s\S]*?)<\/h1>/.exec(h)?.[1] ?? '';
  ok(/tcy/.test(h1(hv)), '縦×省略: 書名の数字に縦中横が掛かる', h1(hv));
  ok(!/tcy/.test(h1(hh)), '縦×横: 書名の数字に縦中横を掛けない', h1(hh));
}
// 横組みの本は、設定があっても変わらない
ok(
  html({ writingMode: 'horizontal' }) === html({ writingMode: 'horizontal', titleWritingMode: 'horizontal' }) &&
    html({ writingMode: 'horizontal' }) === html({ writingMode: 'horizontal', titleWritingMode: 'vertical' }),
  '横組みの本は書名の向きの設定で変わらない',
);
// 本文・柱・奥付は変わらない(大扉の CSS と書名・著者名の行だけが違う)
{
  const strip = (h: string) =>
    h
      .replace(/section\.titlepage \{[\s\S]*?\/\* ---- 全面画像/, '')
      .replace(/<section class="titlepage">[\s\S]*?<\/section>/, '');
  ok(strip(vOff) === strip(vH), '縦×横: 大扉以外(本文・柱・奥付)の HTML は変わらない');
}

// 5. 下見(組まずに向きだけ変える)
{
  const sv = { ...defaultSettings(), writingMode: 'vertical' as const };
  const sh = { ...sv, titleWritingMode: 'horizontal' as const };
  const nv = paintNeutral(sv);
  const nh = paintNeutral(sh);
  ok(sameNeutral(nv, nh), '下見: 書名の向きを変えても sameNeutral が同じと言う(組み直さない)');
  const pv = manuscriptHtml(ms, nv, '', { titleBothWays: true });
  const ph = manuscriptHtml(ms, nh, '', { titleBothWays: true });
  ok(pv === ph, '下見: 向きを変えても下見の組版HTMLが1バイトも変わらない');
  // 縦のままの本の組版HTML(紙)は、下見の道具(titleBothWays)を足す前と同じ: 設定の有無・オプションの有無で変わらない
  ok(
    manuscriptHtml(ms, sv) === manuscriptHtml(ms, { ...sv, titleWritingMode: 'vertical' }) &&
      manuscriptHtml(ms, sv) === manuscriptHtml(ms, sv, '', {}),
    '縦のままの本: 紙の組版HTMLは設定の有無で変わらない',
  );
  const cv = previewPaintCss(sv);
  const ch = previewPaintCss(sh);
  ok(!/section\.titlepage \{[^}]*horizontal-tb/.test(cv), '下見の塗り(縦): 大扉を横組みにする規則が無い');
  ok(/titlepage \.tt-h \{ display: none/.test(cv), '下見の塗り(縦): 横用の字の並びを隠す');
  ok(
    /section\.titlepage \{ writing-mode: horizontal-tb !important; width: [\d.]+mm !important; height: [\d.]+mm !important;/.test(ch),
    '下見の塗り(横書き): 大扉の箱が横組みで実寸の幅と高さ',
  );
  ok(/titlepage h1 \{[^}]*margin-right: 0 !important/.test(ch), '下見の塗り(横書き): 書名の縦用の右寄せを消す');
  ok(/titlepage \.author \{[^}]*left: 0 !important; right: 0 !important/.test(ch), '下見の塗り(横書き): 著者名を中央そろえで下寄せ');
  ok(/titlepage \.tt-v \{ display: none/.test(ch), '下見の塗り(横書き): 縦用の字の並びを隠す');
  // 紙と同じ数字: 下見のパッチの幅・高さは、紙の組版CSS(横書き)と同じ値
  const paper = manuscriptHtml(ms, sh);
  const dims = (h: string, re: RegExp) => re.exec(h)?.slice(1).join(' ') ?? '';
  const dp = dims(paper, /section\.titlepage \{[\s\S]*?width: ([\d.]+mm);\s*height: ([\d.]+mm)/);
  const dv = dims(ch, /section\.titlepage \{ writing-mode: horizontal-tb !important; width: ([\d.]+mm) !important; height: ([\d.]+mm) !important/);
  ok(dp !== '' && dp === dv, '下見の大扉の幅・高さが、紙(横書き)の組版CSSと同じ', `${dp} / ${dv}`);
  // 数字を含む書名: 下見は縦用と横用の両方を持つ。紙は向きの1つだけ
  const m2 = { ...ms, title: '第12駅' };
  const both = manuscriptHtml(m2, nv, '', { titleBothWays: true });
  const h1Both = /<h1>[\s\S]*?<\/h1>/.exec(both)?.[0] ?? '';
  ok(/<span class="tt-v">[\s\S]*tcy[\s\S]*<\/span><span class="tt-h">第12駅<\/span>/.test(h1Both), '下見: 数字のある書名は縦用(縦中横)と横用の両方を持つ', h1Both);
  ok(!/tt-[vh]/.test(manuscriptHtml(m2, sh)) && !/tt-[vh]/.test(manuscriptHtml(m2, sv)), '紙の書き出し: 縦用・横用の目印は入らない');
  ok(
    !/tt-[vh]/.test(manuscriptHtml(m2, paintNeutral({ ...defaultSettings(), writingMode: 'horizontal' }), '', { titleBothWays: true })),
    '横組みの本: 縦用・横用の目印は入らない',
  );
}

// 6. 電子書籍の扉
{
  const epub = (patch: Partial<ReturnType<typeof defaultSettings>>) =>
    buildEpubBook(ms, { ...defaultSettings(), ...patch }, previewImageResolver((x) => x));
  const tp = (b: ReturnType<typeof epub>) => b.files.get('titlepage.xhtml') ?? '';
  const vOffB = epub({ writingMode: 'vertical' });
  const vHB = epub({ writingMode: 'vertical', titleWritingMode: 'horizontal' });
  const hB = epub({ writingMode: 'horizontal', titleWritingMode: 'horizontal' });
  ok(!/<html[^>]* class=/.test(tp(vOffB)), '電子書籍(縦×省略): 扉の html に tp-h が付かない');
  ok(/<html[^>]* class="tp-h"/.test(tp(vHB)), '電子書籍(縦×横): 扉の html に tp-h が付く');
  ok(/html\.tp-h \.titlepage \{[^}]*display: table;/.test(vHB.css), '電子書籍(縦×横): style.css に横組みの扉の規則が入る');
  ok(/html \{ writing-mode: vertical-rl;/.test(vHB.css), '電子書籍(縦×横): 本文の向きは縦のまま');
  ok(!/tp-h/.test(vOffB.css), '電子書籍(縦×省略): style.css に横組みの扉の規則が入らない(いまどおり)');
  ok(!/tp-h/.test(hB.css) && !/tp-h/.test(tp(hB)), '電子書籍(横組みの本): 変わらない');
  // 扉以外のファイルは1バイトも変わらない
  const sameOthers = Array.from(vOffB.files.keys()).every((k) => k === 'titlepage.xhtml' || vOffB.files.get(k) === vHB.files.get(k));
  ok(sameOthers, '電子書籍(縦×横): 扉以外のファイルは1バイトも変わらない');
  // 扉の字の並び: 横組みにすると数字に縦中横を掛けない
  const e2 = (patch: Partial<ReturnType<typeof defaultSettings>>) =>
    buildEpubBook({ ...ms, title: '第12駅' }, { ...defaultSettings(), ...patch }, previewImageResolver((x) => x));
  ok(/tcy/.test(tp(e2({ writingMode: 'vertical' }))), '電子書籍(縦×省略): 扉の書名の数字に縦中横');
  ok(!/tcy/.test(tp(e2({ writingMode: 'vertical', titleWritingMode: 'horizontal' }))), '電子書籍(縦×横): 扉の書名の数字に縦中横を掛けない');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
