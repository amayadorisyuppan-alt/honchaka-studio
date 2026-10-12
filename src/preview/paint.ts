// 設定を「塗り」と「組み」に分け、**塗りだけの変更は組版なしで画面に映す。**(2026-08-22)
//
// ## なぜ要るか(297ページの実操作の録画から)
//
// 背景の絵や濃さを1回いじるたびに、全297ページが組み直されていた(1回2分)。
// だが背景は**文字を1文字も動かさない**。グリフの位置が変わらないなら、
// ページ数も背幅も変わらない — 組版を走らせる理由がそもそも無い。
//
// ## 仕組み
//
// 1. **プレビューには「塗りを既定値に固定した組版HTML」を渡す**(paintNeutral)。
//    塗りだけの変更ではこのHTMLが変わらないので、VivliostylePreview の
//    effect(html 依存)が走らず、組版は1回も起きない。
// 2. **いまの塗りは、組み上がった紙面へ CSS のパッチで重ねる**(previewPaintCss)。
//    Vivliostyle は計算済みのスタイルを**要素のインラインstyleに直書き**するので、
//    ふつうの規則では勝てない。`!important` 付きの規則を親 document に挿し、
//    描かれた箱を直接塗り替える(実測でインラインに勝つことを確認済み):
//      - @page の背景        → `[data-vivliostyle-bleed-box]`(用紙全面の箱)
//      - body の帯・文字色    → `[data-vivliostyle-original-tag="body"]`
//      - ノンブル・柱        → `[data-vivliostyle-page-margin-box=名前]`
//    どのページの塗りかは `:has(section.titlepage)` や `:has(section.chapter#ch3)` の
//    ように**組版HTMLに必ず入る目印**で引く(章の id、コラムの data-colpage)。
//    サムネイル(PageThumbs の複製)も同じ document にあるので、同じパッチが効く。
// 3. **書き出しはこれまでどおり完全なHTML・完全なCSSを通る。**
//    紙PDF(printToPdf)は書き出す瞬間に manuscriptHtml(原稿, いまの設定) を作り、
//    EPUB は自分の経路で設定を直に読む。だから塗りがプレビューにしか効かず
//    出力に乗らない、という事故は経路の形からして起きない(app-probe の
//    exportCarries が毎回それを実測する)。
//    色や背景の式(グレー変換・白かぶせ・フチの影)は typeset/css.ts の
//    export を共用し、**画面と刷りで別の式にならない**ようにしてある。
//
// ## 全設定の分類(2026-08-22 時点の ProjectSettings)
//
// ### 塗り(グリフを動かさない → 組版0回。paintNeutral が既定値に固定する)
//   ink(白黒/カラー)       … 色変換と img の grayscale だけ。寸法に触れない
//   bodyBg / bgOpacity      … @page の背景レイヤー
//   titleBg / tocBg / colophonBg / chapterBg / ColumnPage.bg
//                           … 面ごとの背景(src/濃さ/フチ)。BgSpec は全項目が塗り
//   textColor               … 文字色(※例外: 下の「段間の罫線」)
//   headingColor / subheadingColor / chapterTextColor / chapterHeadingColor /
//   chapterSubheadingColor  … 色だけ
//   textOutline / textOutlineColor … フチ = text-shadow。影は寸法を持たない
//   textPlate / textPlateColor / chapterPlate / chapterPlateColor … 帯 = background
//   ColumnPage.color / headingColor / outline / outlineColor / plate / plateColor
//   colophonType.color / headingColor、profileType.color / headingColor
//   bodyBgFromPreset / aiContentByUser / epubTarget / ebookMono /
//   spineInsetMm / makePaper / makeEbook / bookId
//                           … 組版HTMLに一切出てこない(画面の表示・書き出しの選択だけ)
//
// ### 組み(グリフが動く → これまでどおり組版)
//   trim / writingMode / theme / bodyFont / fontPt / lineFeedPt / margins /
//   columns / columnGapLines / columnRule / toc / sceneBreak / dropCap /
//   printTarget・printRules(塗り足しとノドの下限に効く。2026-10-01 から。これまでは「組版に出てこない」
//   として固定していたが、印刷所の決まりで用紙とノドが変わるので固定すると下見だけ KDP の寸法になる) /
//   binding・saddleCover(2026-10-03 中綴じ。ノドの下限・余りの配り・奥付の手前の白いページ・共紙の表紙の枠が変わるので組み。
//   paintNeutral は塗りしか固定しないので、そのまま通る) /
//   estimatedPages(ノド下限に効く) / nombreSlot / runningHeadSlot /
//   runningHeadPages / runningHeadText / nombreFont / runningHeadFont
//   (ノンブル・柱は枠の生成そのものが組版時に決まる) /
//   chapterFont / chapterFontPt / chapterLineFeedPt / chapterColumns /
//   chapterDropCap / plates / columnPages(文言・位置・書体・サイズ) /
//   colophonType・profileType の書体・サイズ・行送り / 原稿(manuscript)ぜんぶ
//
// ### 向きだけ(2026-10-03。組みに見えて、実は組み直さなくてよいもの)
//   titleWritingMode(縦組みの本の、書名・著者名の横書き)
//     … 変わるのは大扉の1ページの中だけ。大扉は独立した1ページ(break-after: page)なので、
//       ページ数も、ほかのページの字の位置も動かない。表紙は組版を使わない。
//       そこで組版には**縦のまま**を固定して渡し(paintNeutral)、下見の大扉の規則を
//       `!important` で重ねて向きを変える(previewPaintCss の「大扉の向き」)。
//       書名・著者名の字の並びは縦用と横用の両方を組版HTMLに入れてある(html.ts の titleBothWays)。
//       紙の書き出しは完全な設定で組むので、正しい向きの1つだけが入る
//
// ### 実測して決めたもの・安全側に倒したもの
//   文字のフチ(textOutline) … -webkit-text-stroke ではなく8方向の text-shadow で
//     作ってある(css.ts)。影は字幅もボックスも変えないので**塗り**。
//   柱の文言(runningHeadText) … 文字は動かさないが、枠の中身(content:)は
//     Vivliostyle が組版時に確定する。パッチでは書き換えられないので**組み**。
//   textColor … 原則塗り。ただし**段間の罫線(columnRule)を使っている本**では
//     罫の色にも使われ、罫は組版器が描く。その本に限り安全側(組み)に倒す。
//   場面転換の罫(hr)の色 … hr は背景で塗った「箱」なのでパッチが効く。塗り。
//   chapterBg の初回指定 … 組版HTML側の class(chapbgN)と @page 名が変わるが、
//     どちらも余白を持たず改ページ位置も変えない(章はもともとページ起こし)。
//     プレビューは class ではなく章の id で塗るので、初回から組版0回で映る。

import {
  hasOwnBg,
  printRulesOf,
  resolveBg,
  titleWritingModeOf,
  type ColumnPage,
  type MatterType,
  type ProjectSettings,
} from '../models/project';
import { computeLayout } from '../typeset/grid';
import {
  bgBlendValue,
  bgImageValue,
  marginBoxName,
  outlineShadow,
  platePageRules,
  titleHorizontalDecls,
  toGray,
  withAlpha,
} from '../typeset/css';

/** 段間の罫線が出ている本か。出ていれば textColor は罫の色にも使われる(=組みに倒す) */
function columnRuleActive(s: ProjectSettings): boolean {
  if (!s.columnRule) return false;
  if (s.columns > 1) return true;
  return Object.values(s.chapterColumns ?? {}).some((c) => (c ?? 0) > 1);
}

/** コラムページから塗りの項目だけ落とす。塗りが1つも無ければ**同じ参照**を返す */
function neutralColumnPage(c: ColumnPage): ColumnPage {
  if (
    c.bg === undefined &&
    c.color === undefined &&
    c.headingColor === undefined &&
    c.outline === undefined &&
    c.outlineColor === undefined &&
    c.plate === undefined &&
    c.plateColor === undefined
  ) {
    return c;
  }
  const next = { ...c };
  delete next.bg;
  delete next.color;
  delete next.headingColor;
  delete next.outline;
  delete next.outlineColor;
  delete next.plate;
  delete next.plateColor;
  return next;
}

/** 奥付・著者紹介の見た目から色だけ落とす。色が無ければ同じ参照を返す */
function neutralMatter(m: MatterType | undefined): MatterType | undefined {
  if (!m || (m.color === undefined && m.headingColor === undefined)) return m;
  const next = { ...m };
  delete next.color;
  delete next.headingColor;
  return next;
}

/**
 * 塗りの項目を既定値に固定した設定。**プレビューの組版はこちらで組む。**
 *
 * 塗りだけの変更では返り値の中身が変わらない(sameNeutral が同じと言う)ので、
 * 組版HTMLも変わらず、組み直しが起きない。
 * 組みの項目はそのまま通すので、判型や書体の変更はこれまでどおり組み直る
 */
export function paintNeutral(s: ProjectSettings): ProjectSettings {
  const keepInk = columnRuleActive(s);
  return {
    ...s,
    // ---- ここから下が「塗り」。値は defaultSettings と同じ既定に固定する ----
    ink: 'color',
    bodyBg: undefined,
    bodyBgFromPreset: false,
    // 背景を白黒で刷る印(1.1.0)。背景は塗りのパッチが写しで塗る(App が printColor の写しを渡す)ので、組みには関わらない
    bodyBgPrintMono: undefined,
    bgOpacity: 0.25,
    // 罫線の出ている本だけ、色を組みに残す(冒頭の分類を参照)
    textColor: keepInk ? s.textColor : '#000000',
    headingColor: undefined,
    subheadingColor: undefined,
    chapterTextColor: undefined,
    chapterHeadingColor: undefined,
    chapterSubheadingColor: undefined,
    textOutline: 0,
    textOutlineColor: '#ffffff',
    textPlate: 0,
    textPlateColor: '#ffffff',
    chapterPlate: undefined,
    chapterPlateColor: undefined,
    titleBg: undefined,
    tocBg: undefined,
    colophonBg: undefined,
    chapterBg: undefined,
    columnPages: (s.columnPages ?? []).map(neutralColumnPage),
    colophonType: neutralMatter(s.colophonType),
    profileType: neutralMatter(s.profileType),
    // ---- 組版HTMLに出てこない項目。固定して「変更なし」と見なせるようにする ----
    aiContentByUser: false,
    // 書名の向きは大扉の1ページだけの話なので、組版には縦のまま渡す(冒頭の「向きだけ」)
    titleWritingMode: undefined,
    epubTarget: 'kdp',
    ebookMono: false,
    spineInsetMm: 1.0,
    // 作るもの(2026-09-23)。画面の出し分けにしか使わないので、変えても組み直さない。
    // 固定し忘れると、紙・電子を選び直すたびに本がまるごと組み直る(長い本で20秒)
    makePaper: undefined,
    makeEbook: undefined,
  };
}

/** 塗り以外まで見ない浅い比較(キーごとに Object.is) */
function shallowEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * paintNeutral の返り値どうしが**同じ本の同じ組みか**。
 *
 * paintNeutral は呼ぶたびに新しいオブジェクトを作るので、参照では比べられない。
 * ここで同じと分かれば App は前回の参照を使い回し、組版HTMLの作り直し
 * (数十msかかる)も、プレビューの組み直しも起きない。
 * columnPages と colophonType / profileType は paintNeutral が中身ごと
 * 作り直すことがあるので、1段だけ深く見る
 */
export function sameNeutral(a: ProjectSettings, b: ProjectSettings): boolean {
  // printRules は参照ではなく**効いている決まり(printRulesOf)で比べる**(2026-10-01)。
  // 欄が同じ値を新しいオブジェクトで書き直すたびに全部組み直すと、長い本で十数秒かかる。
  // KDP の本は printRulesOf が null なので、printRules を持っていても持っていなくても
  // 同じ組版になり、組み直さない(組版HTMLは printRulesOf 越しにしか読まない)
  const deeper = new Set(['columnPages', 'colophonType', 'profileType', 'printRules']);
  const ka = Object.keys(a) as (keyof ProjectSettings)[];
  // キーの本数は printRules の有無で変わるので、printRules を除いて数える
  const countOf = (o: object) => Object.keys(o).filter((k) => k !== 'printRules').length;
  if (countOf(a) !== countOf(b)) return false;
  for (const k of ka) {
    if (deeper.has(k)) continue;
    if (!Object.is(a[k], b[k])) return false;
  }
  if (!shallowEq(printRulesOf(a), printRulesOf(b))) return false;
  if (!shallowEq(a.colophonType, b.colophonType)) return false;
  if (!shallowEq(a.profileType, b.profileType)) return false;
  const ca = a.columnPages ?? [];
  const cb = b.columnPages ?? [];
  if (ca.length !== cb.length) return false;
  for (let i = 0; i < ca.length; i++) {
    if (!shallowEq(ca[i], cb[i])) return false;
  }
  return true;
}

/** CSS の属性セレクタに入れる id。UUID しか来ないはずだが、引用符だけは落としておく */
function cssId(id: string): string {
  return id.replace(/["\\]/g, '');
}

/**
 * いまの塗りを、組み上がった紙面に重ねるパッチCSS。
 *
 * **常に「いまの設定の完全な塗り」を書く**(差分ではない)。プレビューの組版は
 * 塗りを既定値に固定してあるので、ここが上書きしない値=既定値がそのまま見える。
 * セレクタは `.preview-body`(VivliostylePreview の根)に閉じる —
 * 印刷経路(printHTML の iframe)は別 document なので、そもそも届かない
 */
export function previewPaintCss(s: ProjectSettings): string {
  const mono = s.ink === 'mono';
  const ink = (c: string | undefined) => (c ? (mono ? toGray(c) : c) : c);
  const vertical = s.writingMode === 'vertical';
  const page = '.preview-body [data-vivliostyle-page-container]';
  const rules: string[] = [];

  /** 用紙全面の箱(bleed box)に背景を敷く。@page の背景と同じ場所 */
  const bg = (sel: string, src: string | undefined, opacity: number) =>
    rules.push(`${sel} {
  background-image: ${bgImageValue(src, opacity)} !important;
  background-blend-mode: ${bgBlendValue(mono, src)} !important;
  background-size: cover !important;
  background-position: center !important;
  background-repeat: no-repeat !important;
}`);
  const bleedOf = (mark: string) =>
    `${page}${mark ? `:has(${mark})` : ''} > [data-vivliostyle-bleed-box]`;

  // ---- 背景 ----
  // 名前なしページ(本文・挿絵ページ)= 本文の背景。
  // 名前付きページはこの下で :has の目印ごとに上書きする(:has ぶん詳細度が上がる)
  bg(bleedOf(''), s.bodyBg, s.bgOpacity);
  // 全面画像のページは紙の白だけ(@page fullbleed と同じ)
  bg(bleedOf('div.fullbleed'), undefined, 1);
  // 大扉・目次・奥付。指定が無ければ本文の背景を継ぐ(resolveBg が埋める)
  const tp = resolveBg(s.titleBg, s);
  bg(bleedOf('section.titlepage'), tp.src, tp.opacity);
  const toc = resolveBg(s.tocBg, s);
  bg(bleedOf('section.toc'), toc.src, toc.opacity);
  const col = resolveBg(s.colophonBg, s);
  bg(bleedOf('section.colophon'), col.src, col.opacity);
  // 章ごと。目印は組版HTMLに必ず入る章の id(chapbg クラスには頼らない)。
  // **章の途中の1ページの絵(div.plate / div.fullbleed に data-img)のページは外す。** 紙では
  // そのページは @page plate / fullbleed で組まれ、章の地は出ない(css.ts)。ここで章の地を塗ると
  // 下見だけが紙と違う絵になる(2026-09-23、章の途中に余白つきの絵を置けるようにしたとき。
  // 全面のほうは同日のレビューで発見 — 章の id を含むぶんこちらの詳細度が勝ち、
  // 上の「全面は紙の白」を上書きしていた)
  for (const [k, spec] of Object.entries(s.chapterBg ?? {})) {
    if (!hasOwnBg(spec)) continue;
    const r = resolveBg(spec, s);
    bg(
      `${page}:has(section.chapter#ch${Number(k) + 1}):not(:has(div.plate[data-img], div.fullbleed[data-img])) > [data-vivliostyle-bleed-box]`,
      r.src,
      r.opacity,
    );
  }
  // コラムページごと。目印は data-colpage(こちらも必ず入る)
  (s.columnPages ?? []).forEach((c) => {
    if (!hasOwnBg(c.bg)) return;
    const r = resolveBg(c.bg, s);
    bg(bleedOf(`section.colpage[data-colpage="${cssId(c.id)}"]`), r.src, r.opacity);
  });

  // ---- 本文の色・帯・フチ(body に相当する箱。中の文字はそこから継ぐ) ----
  const plateAlpha = Math.min(1, Math.max(0, s.textPlate ?? 0));
  const bodyPlate =
    plateAlpha > 0 ? withAlpha(ink(s.textPlateColor) ?? '#fff', plateAlpha) : 'transparent';
  const bodyShadow = outlineShadow(s.textOutline ?? 0, ink(s.textOutlineColor) ?? '#fff');
  rules.push(`${page} [data-vivliostyle-original-tag="body"] {
  color: ${ink(s.textColor) ?? '#000'} !important;
  background: ${bodyPlate} !important;
  text-shadow: ${bodyShadow || 'none'} !important;
}`);
  // 場面転換の罫。箱の背景で塗ってある(css.ts の hr)ので色もここで
  rules.push(`${page} hr { background-color: ${ink(s.textColor) ?? '#000'} !important; }`);
  // 白黒の本は絵も図版もグレー(img { filter } と同じ)
  rules.push(`${page} img { filter: ${mono ? 'grayscale(1)' : 'none'} !important; }`);

  // ---- 見出しの色 ----
  // 指定が無いときは inherit を書く。プレビューの組版は色を持っていないので
  // 実は書かなくても同じだが、「常に完全な塗りを書く」の原則で明示する
  rules.push(
    `${page} header.chapter-title { color: ${s.headingColor ? ink(s.headingColor) : 'inherit'} !important; }`,
  );
  rules.push(`${page} h3 { color: ${s.subheadingColor ? ink(s.subheadingColor) : 'inherit'} !important; }`);

  // ---- 章ごとの色・帯・フチ(目印は章の id) ----
  const chapterKeys = new Set([
    ...Object.keys(s.chapterTextColor ?? {}),
    ...Object.keys(s.chapterHeadingColor ?? {}),
    ...Object.keys(s.chapterSubheadingColor ?? {}),
  ]);
  for (const k of chapterKeys) {
    const i = Number(k);
    const sel = `${page} section.chapter#ch${i + 1}`;
    const body = (s.chapterTextColor ?? {})[i];
    const head = (s.chapterHeadingColor ?? {})[i];
    const sub = (s.chapterSubheadingColor ?? {})[i];
    if (body) rules.push(`${sel} { color: ${ink(body)} !important; }`);
    if (head) rules.push(`${sel} header.chapter-title { color: ${ink(head)} !important; }`);
    if (sub) rules.push(`${sel} h3 { color: ${ink(sub)} !important; }`);
  }
  // 章・コラムだけの帯は、ページの箱(body に相当する箱)ごと差し替える。section に当てても
  // 上の本全体の帯を消せなかった(2026-10-09 全体確認)。紙の印刷も同じ規則(print.ts)
  const platePages = platePageRules(s, page, '[data-vivliostyle-original-tag="body"]');
  if (platePages) rules.push(platePages);

  // ---- 面ごとのフチ(大扉・目次・奥付・章) ----
  const shadowOf = (spec: Parameters<typeof resolveBg>[0]) => {
    const r = resolveBg(spec, s);
    return outlineShadow(r.outline, ink(r.outlineColor) ?? '#fff') || 'none';
  };
  rules.push(`${page} section.titlepage { text-shadow: ${shadowOf(s.titleBg)} !important; }`);
  // ---- 大扉の向き(縦組みの本の書名・著者名の横書き。組み直さずに向きだけ変える) ----
  // 組版は縦のまま固定で組んである(paintNeutral)。横書きのときは、紙の組版と同じ宣言
  // (titleHorizontalDecls)を重ねる。縦中横などの字の並びも、横用の1つへ切り替える。
  // 縦のときは、横用の字の並びを隠すだけ(縦用と横用が同じ字の並びなら、そもそも1つしか入っていない)
  if (vertical && titleWritingModeOf(s) === 'horizontal') {
    const d = titleHorizontalDecls(s, computeLayout(s));
    const imp = (decls: string) => decls.replace(/;/g, ' !important;');
    rules.push(`${page} section.titlepage { ${imp(d.section)} }`);
    rules.push(`${page} section.titlepage h1 { ${imp(d.h1 + ' ' + d.h1Reset)} }`);
    rules.push(`${page} section.titlepage .author { ${imp(d.author)} }`);
    rules.push(`${page} section.titlepage .tt-v { display: none !important; }`);
  } else {
    rules.push(`${page} section.titlepage .tt-h { display: none !important; }`);
  }
  rules.push(`${page} section.toc { text-shadow: ${shadowOf(s.tocBg)} !important; }`);
  rules.push(`${page} section.colophon { text-shadow: ${shadowOf(s.colophonBg)} !important; }`);
  for (const [k, spec] of Object.entries(s.chapterBg ?? {})) {
    if (!hasOwnBg(spec)) continue;
    rules.push(
      `${page} section.chapter#ch${Number(k) + 1} { text-shadow: ${shadowOf(spec)} !important; }`,
    );
  }
  // コラムページの背景側のフチ(BgSpec.outline。css.ts の colbgN と同じもの)。
  // **ここに無いあいだ、コラムの「文字のフチ」ボタンはプレビューに映らなかった**
  // (2026-09-14 ユーザー報告「白フチをつけようとボタンを押したけど反応がない」。
  // 完全CSSを通る書き出しにだけ効く=画面と刷りが食い違う、いちばん悪い形)。
  // 飾り側(c.outline)の規則はこのあとに出るので、両方あるときは飾りが勝つ(完全CSSと同じ順)
  (s.columnPages ?? []).forEach((c) => {
    if (!hasOwnBg(c.bg)) return;
    rules.push(
      `${page} section.colpage[data-colpage="${cssId(c.id)}"] { text-shadow: ${shadowOf(c.bg)} !important; }`,
    );
  });

  // ---- ノンブル・柱(余白の枠) ----
  // 枠も背景画像の上に立つので、フチは本文と同じものを掛ける
  rules.push(
    `${page} [data-vivliostyle-page-margin-box] { text-shadow: ${bodyShadow || 'none'} !important; }`,
  );
  // 章ごとのフチは、その章のページの枠にも(css.ts の chapbgN:recto/verso と同じ意図)
  for (const [k, spec] of Object.entries(s.chapterBg ?? {})) {
    if (!hasOwnBg(spec)) continue;
    rules.push(
      `${page}:has(section.chapter#ch${Number(k) + 1}) [data-vivliostyle-page-margin-box] { text-shadow: ${shadowOf(spec)} !important; }`,
    );
  }
  // ノンブルの色は本文の文字色に追随する(柱は #444 固定なので触らない)。
  // どの枠にあるかはページの表裏で入れ替わる。縦書き(右綴じ)は左ページが表
  for (const side of ['left', 'right'] as const) {
    const recto = vertical ? side === 'left' : side === 'right';
    const name = marginBoxName(s.nombreSlot ?? 'bottom-fore', vertical, recto);
    if (!name) continue;
    rules.push(
      `${page}[data-vivliostyle-page-side="${side}"] [data-vivliostyle-page-margin-box="${name}"] { color: ${ink(s.textColor) ?? '#000'} !important; }`,
    );
  }

  // ---- コラムページごとの飾り ----
  (s.columnPages ?? []).forEach((c) => {
    const sel = `${page} section.colpage[data-colpage="${cssId(c.id)}"]`;
    if (c.color) rules.push(`${sel} { color: ${ink(c.color)} !important; }`);
    if (c.headingColor) rules.push(`${sel} > h2 { color: ${ink(c.headingColor)} !important; }`);
    if (c.outline !== undefined) {
      const sh = outlineShadow(c.outline, ink(c.outlineColor ?? s.textOutlineColor) ?? '#fff');
      rules.push(`${sel} { text-shadow: ${sh || 'none'} !important; }`);
    }
    // 下に敷く帯は platePageRules(上の章の帯の所)でページの箱ごと差し替える
  });

  // ---- 挿絵ページの帯打ち消し ----
  // @page plate は margin:0 で版面=紙いっぱいになり、body の帯が絵のまわりを
  // 塗り潰す。css.ts と同じく、帯があるときだけ同じ背景を敷き直して打ち消す
  if (plateAlpha > 0) {
    bg(`${page} div.plate`, s.bodyBg, s.bgOpacity);
  } else {
    rules.push(`${page} div.plate { background-image: none !important; }`);
  }
  // 版面いっぱいの絵は余白が本文と同じ(@page printplate)で、帯は本文のページと同じに出る。
  // 敷き直すと版面の四角にもう1枚重なるので、こちらは常に消す(css.ts の div.plate.print と同じ)
  rules.push(`${page} div.plate.print { background-image: none !important; }`);

  // ---- 奥付・著者紹介の色 ----
  const matter = (sel: string, hsel: string, m: MatterType | undefined) => {
    rules.push(`${page} ${sel} { color: ${m?.color ? ink(m.color) : 'inherit'} !important; }`);
    rules.push(
      `${page} ${hsel} { color: ${m?.headingColor ? ink(m.headingColor) : 'inherit'} !important; }`,
    );
  };
  matter('.colophon-box', '.colophon-box h1', s.colophonType);
  matter('.profile-box', '.profile-box h2', s.profileType);

  return rules.join('\n');
}
