// この版に無い紙の出し先で保存した本を開いたときの扱いの検査(src/project/file.ts の sanitize)。
//
// ## なぜ在るか(2026-10-10)
//
// 選べる紙の出し先は版で違う(src/edition の printTargets)。別の版で会社を選んで保存した本を開くと、
// その id はこの版では読めない値と同じに見える。ふつうの「読めない値」の扱い(いまの設定に戻す)だと、
// 新しく開いた本では KDP に戻り、塗り足しもノドも黙って KDP の決まりに変わる。そこで:
// - 控え(画像込み)・別の本・自動保存 … 「その他の印刷所」に切り替え、決まりの数字が無ければ既定の決まりを入れて知らせる
// - AI 用の JSON を同じ本へ読み戻す … いままでどおり、いま開いている本の出し先を残す
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   npx vite build --ssr scripts/printTargetCompat.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/printTargetCompat.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { DEFAULT_PRINT_RULES, PRINT_TARGETS, bleedOf, defaultSettings, printRulesOf } from '../src/models/project';
import type { PrintRules } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import { PRINT_TARGET_SWITCHED_NOTICE, fromProjectFile, sanitize, toProjectFile } from '../src/project/file';

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

/** この版には無い会社の id(どの版にも無い名前にしてある) */
const MISSING = 'nosuchprinter';
ok(!(MISSING in PRINT_TARGETS), '前提: 検査に使う id は、この版の出し先の表に無い');

const ms = sampleManuscript();
const snap = (settings: Record<string, unknown>) =>
  ({ settings, cover: defaultCoverSettings(), manuscript: ms, source: null }) as never;
// 読み込む先(いま開いている本)は KDP。黙って KDP に戻らないことを見たいので、わざと KDP にしておく
const current = snap({ ...defaultSettings(), printTarget: 'kdp' });

// 1. 控え(画像込み)。別の版で会社を選んで保存した本。会社の決まりは固定なので printRules を持っていない
{
  const base = { ...defaultSettings(), printTarget: MISSING };
  delete (base as Record<string, unknown>).printRules;
  const text = toProjectFile(snap(base), true);
  const r = fromProjectFile(text, current);
  const s = r.project.settings;
  ok(s.printTarget === 'printshop', '控え: 「その他の印刷所」に切り替える', String(s.printTarget));
  ok(JSON.stringify(s.printRules) === JSON.stringify(DEFAULT_PRINT_RULES), '控え: 既定の決まりを入れる', JSON.stringify(s.printRules));
  ok(JSON.stringify(printRulesOf(s)) === JSON.stringify(DEFAULT_PRINT_RULES), '控え: 組版は既定の決まりで組む(KDP に戻らない)');
  ok(bleedOf(s).gutter > 0, '控え: ノド側の塗り足しも付く(KDP の決まりではない)', JSON.stringify(bleedOf(s)));
  ok(r.warnings.includes(PRINT_TARGET_SWITCHED_NOTICE), '控え: 切り替えたことを知らせる', JSON.stringify(r.warnings));
  ok(!r.warnings.some((w) => w.includes('AI が正しくない値')), '控え: AI のせいにしない', JSON.stringify(r.warnings));
}

// 2. 控えが自分の決まりの数字を持っているときは、それを残す
{
  const RULES: PrintRules = { bleedMm: 4, bleedGutter: false, gutterMinMm: 18, thickPages: 250, thickGutterMm: 22 };
  const text = toProjectFile(snap({ ...defaultSettings(), printTarget: MISSING, printRules: RULES }), true);
  const r = fromProjectFile(text, current);
  ok(r.project.settings.printTarget === 'printshop', '数字つき: 切り替える');
  ok(JSON.stringify(r.project.settings.printRules) === JSON.stringify(RULES), '数字つき: 持っていた数字を残す', JSON.stringify(r.project.settings.printRules));
}

// 3. 自動保存から戻すとき(hydrate と同じ呼び方: 別の本として扱う)
{
  const loaded = snap({ ...defaultSettings(), printTarget: MISSING });
  const r = sanitize(loaded, current, true);
  ok(r.project.settings.printTarget === 'printshop', '自動保存: 切り替える');
  ok(r.notices.includes(PRINT_TARGET_SWITCHED_NOTICE), '自動保存: 知らせを返す');
  ok(r.fixed.length === 0, '自動保存: 「読めない値」には数えない', JSON.stringify(r.fixed));
}

// 4. AI 用の JSON を同じ本へ読み戻すとき(keepMissing)は、いままでどおり、いま開いている本の出し先を残す
{
  const cur = snap({ ...defaultSettings(), printTarget: 'printshop', printRules: DEFAULT_PRINT_RULES });
  const loaded = snap({ ...defaultSettings(), printTarget: MISSING });
  const r = sanitize(loaded, cur, false, true);
  ok(r.project.settings.printTarget === 'printshop', 'AI の往復: いま開いている本の出し先を残す', String(r.project.settings.printTarget));
  ok(r.notices.length === 0, 'AI の往復: 切り替えの知らせは出さない');
  ok(r.fixed.includes('紙の出し先'), 'AI の往復: 読めない値として知らせる(いままでどおり)', JSON.stringify(r.fixed));
}

// 5. この版にある出し先は、触らない
for (const t of Object.keys(PRINT_TARGETS)) {
  const r = sanitize(snap({ ...defaultSettings(), printTarget: t }), current, true);
  ok(r.project.settings.printTarget === t && r.notices.length === 0, `この版の出し先 ${t}: そのまま`);
}

// 6. id の形をしていない値(AI の書き損じ)は、いままでどおり読めない値として、いまの設定に戻す
for (const bad of [5, null, 'Amazon KDP', '']) {
  const r = sanitize(snap({ ...defaultSettings(), printTarget: bad }), current, true);
  ok(r.project.settings.printTarget === 'kdp' && r.notices.length === 0, `書き損じ ${JSON.stringify(bad)}: いまの設定に戻す`, String(r.project.settings.printTarget));
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
