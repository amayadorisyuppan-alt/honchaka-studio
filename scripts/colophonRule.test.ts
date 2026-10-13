// 奥付の罫線のノド側の余裕(src/typeset/css.ts の colophonRuleInset)の検査。(2026-10-13 修正リスト 23)
//
// 無線綴じでノドの余白が出し先の下限ちょうどのとき、奥付の罫線が版面の端まで引かれ、CSS の px の丸めで
// ノド側の端が仕上がりから 14.992mm になった(出し先の入稿チェックの W-702。刷れるが、知らせが出る)。
//
// 1. 下限との差が 0.5mm 未満の本だけ、奥付の箱を左右から 0.3mm ずつ内へ寄せる(罫線も文字も。幅は 0.6mm 狭くなる)
// 2. 差が十分ある本・KDP・決まりを入れていない印刷所は、従来の CSS のまま(left: 0mm・幅は版面のまま)
// 3. 寄せても版面(computeLayout)は動かない(ページ数・背幅に響かない)
//
// PDF での確かめは、運用の見直し12の調べの道具 pagebox.mjs(PDF の要素の位置を仕上がりの端から mm で出す)。
// 回し方: node scripts/private/run-tests.mjs public|partner
import { DEFAULT_PRINT_RULES, defaultSettings, type ProjectSettings } from '../src/models/project';
import { computeLayout, gutterFloorMm } from '../src/typeset/grid';
import { typesetCss } from '../src/typeset/css';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log('  ok  ' + name);
  } else {
    failed++;
    console.log('  NG  ' + name + (detail ? '  ' + detail : ''));
  }
}

const mk = (o: Partial<ProjectSettings>): ProjectSettings => ({ ...defaultSettings(), ...o });
const shop = (o: Partial<ProjectSettings> = {}) => mk({ printTarget: 'printshop', printRules: { ...DEFAULT_PRINT_RULES }, trim: 'a5', ...o });

/** 奥付の箱の left と width(mm)を CSS から読む */
function boxOf(css: string): { left: number; width: number } | null {
  const m = /\.colophon-box \{[^}]*?left: ([\d.]+)mm;[^}]*?width: ([\d.]+)mm;/.exec(css);
  return m ? { left: Number(m[1]), width: Number(m[2]) } : null;
}
/** 版面の幅(mm) = 仕上がり幅 − ノド − 小口(css.ts の pageAreaW と同じ) */
const areaW = (l: ReturnType<typeof computeLayout>) =>
  l.paperW - (l.margins.gutter + l.bleed.gutter) - (l.margins.fore + l.bleed.fore);

// ---- 1・2. 行送りを動かして、下限ぴったりに近い本と、余裕のある本を作る(縦組み・無線綴じ・印刷所の決まりあり) ----
{
  let tight = 0;
  let loose = 0;
  let bad = '';
  for (let lf = 14; lf <= 30; lf += 0.25) {
    const s = shop({ writingMode: 'vertical', lineFeedPt: lf });
    const l = computeLayout(s);
    const floor = gutterFloorMm(s.estimatedPages, s);
    const css = typesetCss(s, l);
    const isTight = l.margins.gutter - floor < 0.5;
    if (isTight) tight++;
    else loose++;
    const b = boxOf(css);
    const w = +areaW(l).toFixed(3);
    if (!b) bad += ` lf=${lf}(奥付の箱が見つからない)`;
    else if (isTight && !(b.left === 0.3 && Math.abs(b.width - (w - 0.6)) < 0.002)) bad += ` lf=${lf}(寄せた形になっていない left=${b.left} width=${b.width} 版面=${w})`;
    else if (!isTight && !(b.left === 0 && Math.abs(b.width - w) < 0.002)) bad += ` lf=${lf}(従来の形でない left=${b.left} width=${b.width} 版面=${w})`;
    // 著者紹介の箱も同じだけ寄せる(横組みの行頭が版面の端に来るので)
    const pm = /\.profile-box \{[^}]*?margin-left: ([\d.]+)mm;\s*margin-right: ([\d.]+)mm;/.exec(css);
    if (isTight && !(pm && pm[1] === '0.3' && pm[2] === '0.3')) bad += ` lf=${lf}(著者紹介の箱を寄せていない)`;
    if (!isTight && pm) bad += ` lf=${lf}(余裕のある本で著者紹介を寄せている)`;
  }
  ok(bad === '', '下限との差が 0.5mm 未満の本だけ罫線を寄せる(それ以外は従来の形)', bad);
  ok(tight > 0 && loose > 0, `前提: 試した本に、下限ぴったりに近い本(${tight})と余裕のある本(${loose})の両方がある`);
}

// ---- 2. 効かない本 ----
{
  const kdp = mk({ printTarget: 'kdp', trim: 'a5', writingMode: 'vertical' });
  ok(boxOf(typesetCss(kdp, computeLayout(kdp)))?.left === 0, 'KDP: 奥付の箱は従来のまま');
  const unset = mk({ printTarget: 'printshop', trim: 'a5', writingMode: 'vertical' });
  ok(boxOf(typesetCss(unset, computeLayout(unset)))?.left === 0, '決まりをまだ入れていない印刷所: 奥付の箱は従来のまま');
}

// ---- 3. 寄せても版面は動かない ----
{
  // 寄せる前後で変わるのは typesetCss の奥付の罫線だけ。版面(computeLayout)は罫線を見ない
  const s = shop({ writingMode: 'vertical', lineFeedPt: 20 });
  const a = computeLayout(s);
  typesetCss(s, a);
  ok(JSON.stringify(computeLayout(s)) === JSON.stringify(a), 'CSS を作っても版面は変わらない');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
