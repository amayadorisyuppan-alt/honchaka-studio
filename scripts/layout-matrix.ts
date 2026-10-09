// 検査用: 判型 × 組み方向 × ページ数 × 出し先 を総なめして、**版面の計算と組版HTMLの「指紋」**を1行ずつ出す。
//
// ## なぜ在るか
//
// 版面の計算(src/typeset/grid.ts)と組版CSS(src/typeset/css.ts)は、塗り足し・ノドの下限・用紙の寸法のように
// 本全体に効く数字を持つ。そこを作り替えるとき(2026-10-01: 出し先ごとの塗り足しとノドの下限)に、
// **「変えるつもりのない本が1字も変わっていない」**を目で確かめることはできない。組み合わせが 168 通りある。
// 変える前と後でこの表を出して比べれば、変わった行だけが残る。
//
// 紙(PDF)は作らない。組版に渡す HTML(CSS 込み)が同じなら、組み上がりも同じ。
//
// ## 回し方
//
//   npx vite build --ssr scripts/layout-matrix.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/layout-matrix.js > before.tsv      (出力先がリポジトリの外なら .mjs に名前を変えて回す)
//   …作り替える…
//   (もう一度ビルドして) node <出力先>/layout-matrix.js > after.tsv
//   diff before.tsv after.tsv
//
// 環境変数 RULES に JSON を渡すと、出し先が「その他の印刷所」の行だけ、その値を settings.printRules に入れて組む
// (例: RULES='{"bleedMm":3,"bleedGutter":true,"gutterMinMm":15,"thickPages":200,"thickGutterMm":20}')。
import { createHash } from 'node:crypto';
import { TRIM_SIZES, defaultSettings, typographyDefaults } from '../src/models/project';
import type { PrintTarget, ProjectSettings, TrimId, WritingMode } from '../src/models/project';
import { computeCoverLayout } from '../src/models/cover';
import { computeLayout } from '../src/typeset/grid';
import { manuscriptHtml } from '../src/typeset/html';
import { sampleManuscript } from '../src/sample';

const md5 = (s: string) => createHash('md5').update(s).digest('hex').slice(0, 12);
const rules = process.env.RULES ? (JSON.parse(process.env.RULES) as Record<string, unknown>) : null;

// KDP のノド下限が切り替わるページ数(150 / 300 / 500 / 700)の前後と、印刷所の決まりの境目(200)の前後
const PAGES = [24, 120, 151, 200, 201, 301, 501, 701];
const TARGETS: PrintTarget[] = ['kdp', 'printshop'];
const MODES: WritingMode[] = ['vertical', 'horizontal'];
const ms = sampleManuscript();

const rows: string[] = [];
for (const trim of Object.keys(TRIM_SIZES) as TrimId[]) {
  for (const writingMode of MODES) {
    for (const printTarget of TARGETS) {
      for (const estimatedPages of PAGES) {
        const s = {
          ...defaultSettings(),
          trim,
          writingMode,
          ...typographyDefaults(trim, writingMode),
          estimatedPages,
          printTarget,
          ...(rules && printTarget === 'printshop' ? { printRules: rules } : {}),
        } as ProjectSettings;
        const l = computeLayout(s);
        rows.push(
          [
            'body',
            trim,
            writingMode,
            printTarget,
            estimatedPages,
            `${l.paperW.toFixed(3)}x${l.paperH.toFixed(3)}`,
            `gutter=${l.margins.gutter.toFixed(3)}`,
            `${l.charsPerLine}x${l.linesPerCol}`,
            md5(JSON.stringify(l)),
            md5(manuscriptHtml(ms, s)),
          ].join('\t'),
        );
      }
      // 表紙は綴じ方向(縦組み=右綴じ)と出し先で決まる。ページ数は背幅だけに効く
      const c = computeCoverLayout(trim, 200, 'white', writingMode === 'vertical', {
        target: printTarget,
        spineInsetMm: 1,
        ...(rules && printTarget === 'printshop' && typeof rules.bleedMm === 'number'
          ? { bleedMm: rules.bleedMm }
          : {}),
      } as Parameters<typeof computeCoverLayout>[4]);
      rows.push(
        ['cover', trim, writingMode, printTarget, 200, `${c.totalW.toFixed(3)}x${c.totalH.toFixed(3)}`, '', '', md5(JSON.stringify(c)), ''].join(
          '\t',
        ),
      );
    }
  }
}
console.log(rows.join('\n'));
