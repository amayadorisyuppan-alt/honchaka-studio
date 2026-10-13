// 挿絵の余白(修正リスト 13)を変えても、下見の本1冊を組み直さないことの検査。(2026-10-12)
//
// 下見の組み直しは「組版HTMLが変わったか」で決まる(App: paintNeutral → sameNeutral → manuscriptHtml)。
// 13: 全面・余白すこし・余白おおめ の切り替えでは、paintNeutral を通した設定が同じ(sameNeutral)で、組版HTMLも1字も変わらない。
//     見開き・版面いっぱい・絵の差し替え・ノド側を空ける本(印刷所の決まり・無線綴じ)の余白すこしは、今までどおり変わる(組み直す)。
//     下見の重ね(previewPaintCss)は、その挿絵の絵の寸法を、紙の組版と同じ値で書く。
//
// 回し方: node scripts/private/run-tests.mjs public|partner
import { DEFAULT_PRINT_RULES, defaultSettings, type Manuscript, type Plate, type ProjectSettings } from '../src/models/project';
import { computeLayout } from '../src/typeset/grid';
import { plateImgBox, typesetCss } from '../src/typeset/css';
import { manuscriptHtml } from '../src/typeset/html';
import { paintNeutral, previewPaintCss, sameNeutral } from '../src/preview/paint';

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

// 1x1 の PNG(絵があるものとして組ませる)
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG2 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const ms: Manuscript = {
  title: '青い本',
  author: '山田花子',
  publisher: '',
  published: '2026年10月12日',
  chapters: [
    { no: '第一章', title: 'はじまり', blocks: [{ type: 'p', text: 'むかしむかし、あるところに。' }] },
    { no: '第二章', title: 'おわり', blocks: [{ type: 'p', text: 'めでたし。' }] },
  ],
} as unknown as Manuscript;

const plate = (size: Plate['size'], src = PNG): Plate => ({ id: 'p1', src, beforeChapter: 1, size }) as Plate;
const mk = (o: Partial<ProjectSettings>): ProjectSettings => ({ ...defaultSettings(), ...o });
// 画面と同じく、**同じ設定の挿絵だけを差し替えた**写しを作る(ほかの項目は同じ参照のまま。store の直し方と同じ)
const KDP_BASE = mk({ printTarget: 'kdp', trim: 'a5' });
const kdp = (size: Plate['size'], src = PNG): ProjectSettings => ({ ...KDP_BASE, plates: [plate(size, src)] });
// ノド側を空ける本(印刷所の決まり・無線綴じ。修正リスト 4-5): 余白すこしは platewide で組む。おおめは比のほう大きいので plate のまま
const SHOP_BASE = mk({ printTarget: 'printshop', printRules: { ...DEFAULT_PRINT_RULES }, trim: 'a5' });
const shop = (size: Plate['size']): ProjectSettings => ({ ...SHOP_BASE, plates: [plate(size)] });

const htmlOf = (s: ProjectSettings) => manuscriptHtml(ms, paintNeutral(s), '', { titleBothWays: true });
const same = (a: ProjectSettings, b: ProjectSettings) => sameNeutral(paintNeutral(a), paintNeutral(b));

// ---- 13. 挿絵の余白 ----
console.log('13. 挿絵の余白');
for (const [a, b] of [['full', 'wide'], ['wide', 'narrow'], ['narrow', 'full']] as const) {
  ok(same(kdp(a), kdp(b)), `KDP: ${a} → ${b} は同じ組み(sameNeutral)`);
  ok(htmlOf(kdp(a)) === htmlOf(kdp(b)), `KDP: ${a} → ${b} で組版HTMLが1字も変わらない`);
}
for (const [a, b] of [['full', 'spread'], ['wide', 'print'], ['print', 'narrow']] as const) {
  ok(!same(kdp(a), kdp(b)), `KDP: ${a} → ${b} は組み直す(ページ数・ページの余白が変わる)`);
}
ok(!same(kdp('wide'), kdp('wide', PNG2)), '絵の差し替えは組み直す');
ok(!same(kdp('wide'), { ...kdp('wide'), plates: [{ ...plate('wide'), beforeChapter: 2 }] }), '位置を変えたら組み直す');
ok(!same(kdp('wide'), { ...KDP_BASE, plates: [] }), '消したら組み直す');
ok(!same(shop('full'), shop('wide')), 'ノド側を空ける本: 全面 → 余白すこし は組み直す(@page platewide の余白は重ねで動かせない)');
ok(!same(shop('wide'), shop('narrow')), 'ノド側を空ける本: 余白すこし → おおめ は組み直す');
ok(same(shop('full'), shop('narrow')), 'ノド側を空ける本でも、全面 ↔ おおめ(どちらも余白0のページ)は組み直さない');
ok(paintNeutral(kdp('narrow')).plates[0].size === 'full', '組版には全面で渡す');
ok(paintNeutral(shop('wide')).plates[0].size === 'wide', 'ノド側を空ける本の余白すこしはそのまま渡す');
{
  const s0 = mk({ printTarget: 'kdp', trim: 'a5' });
  ok(paintNeutral(s0).plates === s0.plates, '挿絵が無い・変えるものが無いときは同じ参照');
}
// 重ね: 紙の組版と同じ寸法
{
  const s = kdp('wide');
  const l = computeLayout(s);
  const box = plateImgBox(l, 'wide');
  const css = previewPaintCss(s);
  const full = typesetCss(s, l);
  const mmS = (v: number) => `${+v.toFixed(3)}mm`;
  ok(css.includes(`div.plate[data-plate="p1"] img { width: auto !important; height: auto !important; max-width: ${mmS(box.maxW)} !important; max-height: ${mmS(box.maxH)} !important;`), '下見の重ね: 余白すこしの寸法', css.split('\n').filter((x) => x.includes('data-plate')).join(' / '));
  ok(full.includes(`max-width: ${mmS(box.maxW)};`) && full.includes(`max-height: ${mmS(box.maxH)};`), '紙の組版の余白すこしと同じ値');
  const cssFull = previewPaintCss(kdp('full'));
  ok(cssFull.includes(`div.plate[data-plate="p1"] img { width: ${mmS(l.paperW)} !important; height: ${mmS(l.paperH)} !important;`) && cssFull.includes('object-fit: cover !important'), '下見の重ね: 全面は用紙いっぱい・切り抜き');
  ok(!previewPaintCss(shop('wide')).includes('data-plate="p1"'), 'ノド側を空ける本の余白すこしは重ねない(組版がその大きさで組んでいる)');
  ok(!previewPaintCss(kdp('spread')).includes('data-plate="p1"'), '見開きは重ねない');
}

console.log(`\n${passed} ok / ${failed} NG`);
process.exit(failed ? 1 : 0);
