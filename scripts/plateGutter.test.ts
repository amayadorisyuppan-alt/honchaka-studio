// 挿絵ページ「余白すこし」のノド側の空け(無線綴じ・印刷所の決まりあり)の検査。(2026-10-12 修正リスト 4-5)
//
// 1. 効く本: 「その他の印刷所」・無線綴じ → layout.plateGutterMm = ノドの下限(既定 15mm)
// 2. 効かない本: KDP・中綴じ・決まりをまだ入れていない印刷所 → 付かない。組版CSSにも規則が1行も増えない
// 3. 内寸(plateInsetsMm / plateAreaMm): ノド側だけ下限まで。おおめ(比のほうが大きい)は比のまま
// 4. 組版CSS: @page platewide の :recto/:verso で左右の余白が入れ替わる(横組み/縦組み)
// 5. 絵の置き場所(imageOnPaper): 左右どちらのページでも、ノド側の余白が下限以上・小口側は比のまま
//
// 回し方: node scripts/private/run-tests.mjs public|partner
import { DEFAULT_PRINT_RULES, TRIM_SIZES, defaultSettings, type ProjectSettings } from '../src/models/project';
import { PLATE_INSET, computeLayout, plateAreaMm, plateInsetsMm } from '../src/typeset/grid';
import { typesetCss } from '../src/typeset/css';
import { imageOnPaper } from '../src/textcheck/geometry';

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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const mk = (o: Partial<ProjectSettings>): ProjectSettings => ({ ...defaultSettings(), ...o });
const shop = (o: Partial<ProjectSettings> = {}) =>
  mk({ printTarget: 'printshop', printRules: { ...DEFAULT_PRINT_RULES }, trim: 'a5', ...o });

const A5 = TRIM_SIZES.a5;
const inset = A5.w * PLATE_INSET.wide; // 5.92mm

// ---- 1. 効く本 ----
{
  const s = shop();
  const l = computeLayout(s);
  ok(l.plateGutterMm === DEFAULT_PRINT_RULES.gutterMinMm, `印刷所・無線: plateGutterMm = ノドの下限 ${DEFAULT_PRINT_RULES.gutterMinMm}mm`, String(l.plateGutterMm));
}

// ---- 2. 効かない本 ----
{
  const kdp = computeLayout(mk({ printTarget: 'kdp', trim: 'a5' }));
  ok(kdp.plateGutterMm === undefined && !('plateGutterMm' in kdp), 'KDP: 付かない(キー自体が無い)');
  const unset = computeLayout(mk({ printTarget: 'printshop', trim: 'a5' }));
  ok(unset.plateGutterMm === undefined, '印刷所でも決まりをまだ入れていない本: 付かない');
  const saddle = computeLayout(shop({ binding: 'saddle' }));
  ok(saddle.plateGutterMm === undefined, '中綴じ: 付かない');
  for (const [name, s] of [['KDP', mk({ printTarget: 'kdp', trim: 'a5' })], ['決まりなし', mk({ printTarget: 'printshop', trim: 'a5' })], ['中綴じ', shop({ binding: 'saddle' })]] as const) {
    const css = typesetCss(s, computeLayout(s));
    ok(!/platewide|platenarrow/.test(css), `${name}: 組版CSSに platewide / platenarrow が出ない`);
    ok(css.includes(`max-width: ${+(A5.w - inset * 2).toFixed(3)}mm`), `${name}: 余白すこしの max-width は従来の 仕上がり幅 − 4%×2`);
  }
}

// ---- 3. 内寸 ----
{
  const l = computeLayout(shop());
  const w = plateInsetsMm(l, 'wide');
  ok(near(w.fore, inset) && near(w.top, inset) && near(w.gutter, 15), `余白すこし: 小口・天地 ${inset.toFixed(2)}mm、ノド 15mm`, JSON.stringify(w));
  const n = plateInsetsMm(l, 'narrow');
  ok(near(n.gutter, n.fore) && near(n.fore, A5.w * 0.2), '余白おおめ(20% = 29.6mm)は比のまま(下限 15mm より大きい)', JSON.stringify(n));
  const a = plateAreaMm(l, 'wide');
  ok(near(a.w, A5.w - inset - 15) && near(a.h, A5.h - inset * 2), '推奨サイズ(plateAreaMm): 幅は空けたぶん狭い・高さは従来どおり', JSON.stringify(a));
  const k = computeLayout(mk({ printTarget: 'kdp', trim: 'a5' }));
  const ka = plateAreaMm(k, 'wide');
  ok(ka.w === A5.w - inset * 2, 'KDP: plateAreaMm の幅は従来の式と一致(最後の桁まで)');
}

// ---- 4. 組版CSS ----
{
  const bleed = 3; // DEFAULT_PRINT_RULES.bleedMm・bleedGutter あり
  const mmv = (v: number) => `${+v.toFixed(3)}mm`;
  const h = shop({ writingMode: 'horizontal' });
  const ch = typesetCss(h, computeLayout(h));
  ok(DEFAULT_PRINT_RULES.bleedMm === bleed && DEFAULT_PRINT_RULES.bleedGutter, '前提: 既定の決まりは塗り足し 3mm・ノド側にも付ける');
  // 横組み: :recto = 右のページ(ノドが左)。左の余白 = 塗り足し + ノド、右の余白 = 塗り足し + 小口
  const rectoH = /@page platewide:recto \{[\s\S]*?\n\}/.exec(ch)?.[0] ?? '';
  ok(rectoH.includes(`margin-left: ${mmv(bleed + 15)}`) && rectoH.includes(`margin-right: ${mmv(bleed + inset)}`), '横組み・:recto(右のページ): 左=ノド側が広い', rectoH);
  const versoH = /@page platewide:verso \{[\s\S]*?\n\}/.exec(ch)?.[0] ?? '';
  ok(versoH.includes(`margin-left: ${mmv(bleed + inset)}`) && versoH.includes(`margin-right: ${mmv(bleed + 15)}`), '横組み・:verso(左のページ): 右=ノド側が広い', versoH);
  ok(ch.includes(`div.plate.wide { page: platewide; width: ${mmv(A5.w - inset - 15)}; }`), 'div.plate.wide は platewide のページに入り、幅は mm で版面いっぱい(縦組みで auto だと絵の幅に縮む)');
  ok(ch.includes(`max-width: ${mmv(A5.w - inset - 15)};`), '絵の max-width = 仕上がり幅 − 小口 − ノド');
  ok(!/platenarrow/.test(ch), '余白おおめは規則を足さない(比のほうが大きい)');
  ok(/@page platewide \{[\s\S]*?margin: 0;/.test(ch), '名前付きページの基本は余白 0(4値を :recto/:verso に書かない)');
  // 縦組み: :recto = 左のページ(ノドが右)
  const v = shop({ writingMode: 'vertical' });
  const cv = typesetCss(v, computeLayout(v));
  const rectoV = /@page platewide:recto \{[\s\S]*?\n\}/.exec(cv)?.[0] ?? '';
  ok(rectoV.includes(`margin-left: ${mmv(bleed + inset)}`) && rectoV.includes(`margin-right: ${mmv(bleed + 15)}`), '縦組み・:recto(左のページ): 右=ノド側が広い', rectoV);
}

// ---- 5. 絵の置き場所 ----
{
  const l = computeLayout(shop());
  const g = 15;
  // 横長・縦長・正方形の絵(画素)。小さい絵は引き伸ばさない(PX_MM)ので、大きな絵で測る
  for (const [nw, nh] of [[3000, 2000], [2000, 3000], [2400, 2400]] as const) {
    for (const side of ['left', 'right'] as const) {
      const r = imageOnPaper('wide', l, nw, nh, side);
      // 仕上がりの左端(左のページ = 小口の塗り足しの位置・右のページ = ノドの塗り足しの位置)
      const trimL = side === 'left' ? l.bleed.fore : l.bleed.gutter;
      const leftMargin = r.x - trimL;
      const rightMargin = trimL + l.trimW - (r.x + r.w);
      const gutterMargin = side === 'left' ? rightMargin : leftMargin;
      const foreMargin = side === 'left' ? leftMargin : rightMargin;
      ok(gutterMargin >= g - 1e-6, `${nw}x${nh} ${side}ページ: ノド側の余白 ${gutterMargin.toFixed(2)}mm >= 15mm`);
      ok(foreMargin >= inset - 1e-6, `${nw}x${nh} ${side}ページ: 小口側の余白 ${foreMargin.toFixed(2)}mm >= ${inset.toFixed(2)}mm`);
      ok(r.y >= inset - 1e-6 && r.y + r.h <= l.paperH - inset + 1e-6, `${nw}x${nh} ${side}ページ: 天地は仕上がり幅の 4% より内側`);
    }
  }
  // 比のほうが大きい(おおめ)と、KDP は従来の中央寄せ
  const nar = imageOnPaper('narrow', l, 3000, 2000, 'left');
  ok(near(nar.x + nar.w / 2, l.paperW / 2), '余白おおめ: 用紙の中央寄せのまま');
  const kl = computeLayout(mk({ printTarget: 'kdp', trim: 'a5' }));
  const kw = imageOnPaper('wide', kl, 3000, 2000, 'left');
  ok(near(kw.x + kw.w / 2, kl.paperW / 2), 'KDP: 用紙の中央寄せのまま(従来)');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
