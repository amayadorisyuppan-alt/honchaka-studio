// 大扉の書名・著者名の書体(settings.titlepageTitleFont / titlepageAuthorFont)の検査。(2026-10-12 今後の改修の希望 5・1.2.0)
//
// ## 何を確かめるか
//
//   1. titlepageFontsOf: 未指定 → 本文の書体 / 'cover' → 表紙の書体(表紙を変えるとついてくる) / 固定 → そのまま /
//      表紙の書体が BODY_FONTS に無い id → 本文の書体 / 書名と著者名は別々。表紙の 9 書体は全部 BODY_FONTS にある
//   2. withTitlepageCover: 'cover' が無ければ同じ参照。あれば表紙のいまの書体に置き換わる
//   3. 組版HTML: 未指定はいままでどおり(本文の書体・太さ 700)。選んだら書体とその書体の太さ(佑字 肅は 400)・
//      縦中横の詰め数字もその書体。書名だけ選んだら著者名は変わらない。大扉の外の HTML は変わらない
//   4. 下見: 大扉の書体を変えても組み直さない(paintNeutral が固定し、sameNeutral が同じと言い、組版HTMLが同じ)。
//      書体は previewPaintCss が !important で重ねる(未指定なら重ねない)
//   5. 保存ファイル: 往復で残る / 表に無い名前は外して知らせる / 古い保存(項目なし)は未指定のまま
//   6. 電子書籍の扉は変わらない(書体を指定しない)
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   node scripts/private/run-tests.mjs public    (ほかの検査とまとめて)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import {
  BODY_FONTS,
  defaultSettings,
  isBodyFontId,
  titlepageFontsOf,
  withTitlepageCover,
} from '../src/models/project';
import { COVER_FONTS, defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import { fromProjectFile, toProjectFile } from '../src/project/file';
import { manuscriptHtml } from '../src/typeset/html';
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

type S = ReturnType<typeof defaultSettings>;
const base: S = { ...defaultSettings(), bodyFont: 'serif' };

// 1. 書体を決める関数
for (const id of Object.keys(COVER_FONTS)) ok(isBodyFontId(id), `表紙の書体 ${id} は本文の書体の表にもある`);
ok(!isBodyFontId('toString') && !isBodyFontId('__proto__') && !isBodyFontId('mincho') && !isBodyFontId(5), '表に無い名前は書体と見なさない');
{
  const cov = { titleFont: 'shippori', authorFont: 'zenMaru' };
  const none = titlepageFontsOf(base, cov);
  ok(none.title === 'serif' && none.author === 'serif', '未指定: 書名・著者名とも本文の書体', JSON.stringify(none));
  const linked = titlepageFontsOf({ ...base, titlepageTitleFont: 'cover', titlepageAuthorFont: 'cover' }, cov);
  ok(linked.title === 'shippori' && linked.author === 'zenMaru', "'cover': 表紙の書名・著者名の書体", JSON.stringify(linked));
  const follow = titlepageFontsOf({ ...base, titlepageTitleFont: 'cover' }, { titleFont: 'yuji', authorFont: 'dot' });
  ok(follow.title === 'yuji', "'cover': 表紙の書体を変えると大扉もついてくる", JSON.stringify(follow));
  ok(follow.author === 'serif', '書名だけつないだら、著者名は本文の書体のまま', JSON.stringify(follow));
  const fixed = titlepageFontsOf({ ...base, titlepageTitleFont: 'klee', titlepageAuthorFont: 'gothic' }, cov);
  ok(fixed.title === 'klee' && fixed.author === 'gothic', '固定: 選んだ書体のまま(表紙を見ない)', JSON.stringify(fixed));
  const odd = titlepageFontsOf({ ...base, titlepageTitleFont: 'cover' }, { titleFont: 'notAFont', authorFont: 'serif' });
  ok(odd.title === 'serif', "'cover' で表紙の書体が表に無い id: 本文の書体", JSON.stringify(odd));
  const noCover = titlepageFontsOf({ ...base, titlepageTitleFont: 'cover' });
  ok(noCover.title === 'serif', "'cover' で表紙を渡さない: 本文の書体に倒れる", JSON.stringify(noCover));
  const badBody = titlepageFontsOf({ ...base, bodyFont: 'mincho' as never, theme: 'practical-gothic' });
  ok(badBody.title === 'gothic', '本文の書体が壊れていたらテーマの既定', JSON.stringify(badBody));
  ok(titlepageFontsOf({ ...base, bodyFont: 'reggae' }).title === 'reggae', '未指定は本文の書体についていく');
}

// 2. withTitlepageCover
{
  const cov = { titleFont: 'shippori', authorFont: 'zenMaru' };
  ok(withTitlepageCover(base, cov) === base, "'cover' が無ければ同じ参照");
  const fixedOnly = { ...base, titlepageTitleFont: 'klee' as const };
  ok(withTitlepageCover(fixedOnly, cov) === fixedOnly, '固定だけなら同じ参照');
  const r = withTitlepageCover({ ...base, titlepageTitleFont: 'cover', titlepageAuthorFont: 'gothic' }, cov);
  ok(r.titlepageTitleFont === 'shippori' && r.titlepageAuthorFont === 'gothic', "'cover' だけ表紙の書体に置き換わる", JSON.stringify([r.titlepageTitleFont, r.titlepageAuthorFont]));
}

// 3. 組版HTML
const ms = { ...sampleManuscript(), title: '第12駅の猫', author: '雨宿り太郎' };
const html = (patch: Partial<S>) => manuscriptHtml(ms, { ...base, ...patch });
const tpCss = (h: string) => {
  const i = h.indexOf('section.titlepage {');
  return i < 0 ? '' : h.slice(i, h.indexOf('/* ---- 全面画像', i));
};
const h1Rule = (h: string) => /\.titlepage h1 \{[^}]*\}/.exec(tpCss(h))?.[0] ?? '';
const authorRule = (h: string) => /\.titlepage \.author \{[^}]*\}/.exec(tpCss(h))?.[0] ?? '';
for (const wm of ['vertical', 'horizontal'] as const) {
  const off = html({ writingMode: wm });
  ok(h1Rule(off).includes(`font-family: ${BODY_FONTS.serif.stack};`) && /font-weight: 700;/.test(h1Rule(off)), `${wm} 未指定: 書名は本文の書体・太さ 700(いままでどおり)`, h1Rule(off));
  ok(!/font-family/.test(authorRule(off)), `${wm} 未指定: 著者名に書体の指定を足さない`, authorRule(off));
  ok(!/\.titlepage h1 \.tcy|\.titlepage \.author \.tcy/.test(tpCss(off)), `${wm} 未指定: 大扉の縦中横の規則を足さない`);
  ok(off === html({ writingMode: wm, titlepageTitleFont: undefined, titlepageAuthorFont: undefined }), `${wm} 未指定: 項目が undefined でも同じ HTML`);

  const yuji = html({ writingMode: wm, titlepageTitleFont: 'yuji' });
  ok(h1Rule(yuji).includes(`font-family: ${BODY_FONTS.yuji.stack};`), `${wm} 書名を佑字 肅: 書名の書体`, h1Rule(yuji));
  ok(/font-weight: 400;/.test(h1Rule(yuji)) && !/font-weight: 700/.test(h1Rule(yuji)), `${wm} 書名を佑字 肅: 太さはその書体の 400(合成太字にしない)`, h1Rule(yuji));
  ok(/\.titlepage h1 \.tcy \{ font-family: "amayadori-tcy-yuji"/.test(tpCss(yuji)), `${wm} 書名を佑字 肅: 縦中横の詰め数字もその書体`);
  ok(!/font-family/.test(authorRule(yuji)), `${wm} 書名だけ選んだら著者名は変わらない`, authorRule(yuji));
  const klee = html({ writingMode: wm, titlepageTitleFont: 'klee', titlepageAuthorFont: 'shippori' });
  ok(/font-weight: 600;/.test(h1Rule(klee)), `${wm} Klee: 太さ 600`, h1Rule(klee));
  ok(authorRule(klee).includes(`font-family: ${BODY_FONTS.shippori.stack};`), `${wm} 著者名をしっぽり明朝`, authorRule(klee));
  const strip = (h: string) =>
    h.replace(/section\.titlepage \{[\s\S]*?\/\* ---- 全面画像/, '').replace(/<section class="titlepage">[\s\S]*?<\/section>/, '');
  ok(strip(off) === strip(klee), `${wm} 大扉の外(本文・柱・奥付)の HTML は変わらない`);
}
// 縦の本の書名を横書きにしても、書体は同じく効く
{
  const vh = html({ writingMode: 'vertical', titleWritingMode: 'horizontal', titlepageTitleFont: 'reggae' });
  ok(h1Rule(vh).includes(BODY_FONTS.reggae.stack) && /horizontal-tb/.test(h1Rule(vh)), '縦×横書きの書名: 書体も向きも入る', h1Rule(vh));
}
// 表紙とつながる: 表紙の書体を変えると、紙の組版(withTitlepageCover を通したもの)の大扉もついてくる
{
  const s = { ...base, titlepageTitleFont: 'cover' as const, titlepageAuthorFont: 'cover' as const };
  const c1 = { ...defaultCoverSettings(), titleFont: 'shippori' as const, authorFont: 'gothic' as const };
  const c2 = { ...c1, titleFont: 'dot' as const };
  const p1 = manuscriptHtml(ms, withTitlepageCover(s, c1));
  const p2 = manuscriptHtml(ms, withTitlepageCover(s, c2));
  ok(h1Rule(p1).includes(BODY_FONTS.shippori.stack) && authorRule(p1).includes(BODY_FONTS.gothic.stack), '表紙とつながる: 表紙の書名・著者名の書体で組む', tpCss(p1));
  ok(h1Rule(p2).includes(BODY_FONTS.dot.stack) && /font-weight: 400;/.test(h1Rule(p2)), '表紙とつながる: 表紙の書名をドットにすると大扉もドット(太さ 400)', h1Rule(p2));
}

// 4. 下見(組み直さない)
{
  const cov = { ...defaultCoverSettings(), titleFont: 'zenOld' as const, authorFont: 'klee' as const };
  const a = { ...base, writingMode: 'vertical' as const };
  const b = { ...a, titlepageTitleFont: 'cover' as const, titlepageAuthorFont: 'reggae' as const };
  ok(sameNeutral(paintNeutral(a), paintNeutral(b)), '下見: 大扉の書体を変えても sameNeutral が同じと言う');
  ok(manuscriptHtml(ms, paintNeutral(a), '', { titleBothWays: true }) === manuscriptHtml(ms, paintNeutral(b), '', { titleBothWays: true }), '下見: 組版HTMLが1バイトも変わらない');
  const pa = previewPaintCss(withTitlepageCover(a, cov));
  const pb = previewPaintCss(withTitlepageCover(b, cov));
  ok(!/section\.titlepage h1 \{[^}]*font-family/.test(pa) && !/section\.titlepage \.author \{[^}]*font-family/.test(pa), '下見: 未指定なら書体を重ねない');
  ok(pb.includes(`section.titlepage h1 { font-family: ${BODY_FONTS.zenOld.stack} !important; font-weight: 700 !important; }`), '下見: 表紙とつながる書名は表紙の書体(Zen 旧明朝)を重ねる', pb.split('\n').filter((l) => l.includes('titlepage')).join(' | '));
  ok(pb.includes(`section.titlepage .author { font-family: ${BODY_FONTS.reggae.stack} !important; }`), '下見: 著者名は選んだ書体を重ねる');
  ok(/section\.titlepage h1 \.tcy \{ font-family: "amayadori-tcy-zenOld"[^}]*!important; \}/.test(pb), '下見: 縦中横の詰め数字も重ねる');
  const pc = previewPaintCss(withTitlepageCover(b, { ...cov, titleFont: 'yuji' }));
  ok(pc.includes(`section.titlepage h1 { font-family: ${BODY_FONTS.yuji.stack} !important; font-weight: 400 !important; }`), '下見: 表紙の書体を変えると塗りだけでついてくる');
}

// 5. 保存ファイル
const snap = (settings: S) => ({ settings, cover: defaultCoverSettings(), manuscript: ms, source: null }) as never;
{
  const book = { ...base, titlepageTitleFont: 'cover' as const, titlepageAuthorFont: 'shippori' as const };
  const r = fromProjectFile(toProjectFile(snap(book), true), snap(base));
  ok(r.project.settings.titlepageTitleFont === 'cover' && r.project.settings.titlepageAuthorFont === 'shippori', '往復: そのまま残る');
  const old = fromProjectFile(toProjectFile(snap(base), true), snap(base));
  ok(old.project.settings.titlepageTitleFont === undefined && old.project.settings.titlepageAuthorFont === undefined, '古い保存(項目なし): 未指定のまま');
  for (const bad of ['mincho', 'toString', 5, null, [], true]) {
    const o = JSON.parse(toProjectFile(snap(book), true));
    o.settings.titlepageTitleFont = bad;
    const rr = fromProjectFile(JSON.stringify(o), snap(base));
    ok(rr.project.settings.titlepageTitleFont === undefined, `壊れた値 ${JSON.stringify(bad)}: 外す(本文の書体に戻る)`, String(rr.project.settings.titlepageTitleFont));
    ok(rr.project.settings.titlepageAuthorFont === 'shippori', `壊れた値 ${JSON.stringify(bad)}: 著者名の書体は残る`);
  }
}

// 6. 電子書籍の扉は変わらない(書体を指定しない)
{
  const e = (patch: Partial<S>) => {
    const b = buildEpubBook(ms, { ...base, ...patch }, previewImageResolver((x) => x));
    return JSON.stringify([...b.files].filter(([k]) => /titlepage|style/.test(k)));
  };
  const e0 = e({});
  ok(e0.length > 2 && e0 === e({ titlepageTitleFont: 'reggae', titlepageAuthorFont: 'cover' }), '電子書籍: 扉と style.css が大扉の書体で変わらない');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
