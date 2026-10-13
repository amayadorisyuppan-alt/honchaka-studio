// 設定+グリッド計算結果 → 組版CSS(docs/typesetting-rules.md §10 の実装)。
// Vivliostyle(CSS組版)向け。
// 注意:
// - 天地余白はベース @page に、ノド・小口は :recto/:verso に分けて指定する
//   (4値まとめて :recto/:verso に書くと Vivliostyle が余白を二重適用する症状が出た)
// - 行取り・アキは論理プロパティを使わず、組み方向ごとに物理プロパティで生成する
// - 縦書き(右綴じ・rtl)では :recto=左ページ、横書き(ltr)では :recto=右ページ
// - 用紙は塗り足し込みの寸法で出す。CSS の `bleed` プロパティは :recto/:verso に書いても
//   効かず「ノド側だけ足さない」非対称にできないため、size を広げて余白を足す方式を採る
//   (仕上がり位置は動かない)。塗り足しは天・地・小口・ノドの4辺それぞれ(grid.ts の PageLayout.bleed)。
//   KDP はノド側が 0、印刷所は利用者の決まりで付ける(2026-10-01)。**この中は出し先を見ず、l だけを見る**

import {
  BLEED_MM,
  BODY_FONTS,
  HEADING_FONT_STACK,
  type MarginSlot,
  PRINT_TARGETS,
  THEME_BODY_FONT,
  bindingOf,
  hasOwnBg,
  isRenderableImage,
  maxColumns,
  printRulesOf,
  resolveBg,
  type MatterType,
  type ProjectSettings,
  type ResolvedBg,
  tcyStack,
  titlepageFontsOf,
  titleWritingModeOf,
} from '../models/project';
import {
  COLPAGE_TITLE_GAP,
  COLPAGE_TITLE_LINE,
  COLPAGE_TITLE_SIZE,
  PLATE_INSET,
  PT_TO_MM,
  chapterColumn,
  gutterFloorMm,
  plateInsetsMm,
  type PageLayout,
} from './grid';
import { assetUrl } from './blobUrl';
import { spreadGeometry } from './spread';
import { plainText } from '../models/inlineImages';

const GOTHIC = HEADING_FONT_STACK;

const pt = (v: number) => `${+v.toFixed(3)}pt`;
const mm = (v: number) => `${+v.toFixed(3)}mm`;

/**
 * 奥付のノド側の余裕(2026-10-13 修正リスト 23)。
 * 奥付の箱(罫線と文字)は版面の端から端まで使う。ノドの余白が出し先の下限ちょうど(無線綴じのノド 15mm など)のとき、
 * CSS の px の丸めで、罫線と文字のノド側の端が仕上がりから 14.992mm になり、入稿チェックの「ノド余白不足」(W-702)が出た(刷れる。念のための知らせ)。
 * 下限との差が SLACK_MM 未満のときだけ、**奥付の箱を左右から INSET_MM ずつ内へ寄せる**(罫線も文字も 15mm を割らない。
 * 本文の組み・ページ数は動かない。箱の幅が 0.6mm 狭くなるだけ)。罫線だけを寄せる形では、文字が 14.992mm のまま残った(テストデータの PDF で実測)。
 * 奥付は左右どちらのページにも来て、どちらがノド側か要素からは分からないので、両端を同じだけ寄せる。差が十分ある本は従来の CSS のまま
 */
const COLOPHON_RULE_SLACK_MM = 0.5;
const COLOPHON_RULE_INSET_MM = 0.3;

/**
 * 段と段のあいだの罫線を、**表罫(おもてけい)の重さまで落とす。**
 *
 * > 段組みの間の線が太すぎて文字が読みづらい。もうちょっとさりげないのがいい。
 * > 表罫くらいの太さでいいのでは(2026-08-20 ユーザー)
 *
 * ### ★ 罫は 1px より細くできない(2026-08-20 実測)
 *
 * CSS には 0.1mm と書けるが、**Blink は 0 でない罫の太さを必ず 1px 以上に切り上げる。**
 * 実測(同じ画面で `getComputedStyle` の使用値と、content-box 100px の箱の実寸):
 *
 * | 指定 | 使用値 | 箱の実寸 |
 * |---|---|---|
 * | `0.05mm` / `0.1mm` / `0.283pt` / `0.3pt` / `0.45pt` / `0.6px` | すべて `1px` | すべて 101px |
 *
 * つまり **もとの `0.45pt` という指定は最初から効いておらず、引かれていたのは 1px**。
 * 1px = 1/96インチ = **0.265mm** で、これは表罫(0.1mm)ではなく**裏罫(0.3mm)に近い**。
 * 「太すぎる」という見立ては正しかった。
 *
 * 箱の高さなら 0.1mm は 0.375px として通る(実測)ので、罫を背景のグラデーションで
 * 描けば実寸の表罫になる。**が、採らない** — 章見出しは `column-span: all` で
 * 段をぶち抜くので、section に敷いた縞は**章見出しの帯まで横切ってしまう**。
 *
 * ### 太さで無理なら、インクの量で合わせる
 *
 * 引ける下限は 0.265mm。表罫 0.1mm と**同じインク量**になる濃さは
 * 0.1 / 0.265 = **0.378**。太さは engine の下限のまま、濃さをここまで落とす。
 * 刷りでも 300dpi で 3.1 ドットぶんの幅があるので、網に負けて途切れることはない
 * (0.265mm × 300dpi ÷ 25.4 = 3.13px)。
 */
const COLUMN_RULE_INK = 0.378;

/**
 * 濃い背景の上でも本文が読めるようにする文字のフチ。
 *
 * `-webkit-text-stroke` は使わない。線が字の輪郭をまたいで引かれるため字面を削り、
 * 細い明朝が痩せる(0.09em で黒い画素が3割減るのを実測)。`paint-order: stroke fill` を
 * 添えても HTML のテキストでは効かなかった。
 * 8方向へずらした影を重ねる方式なら、字そのものには一切触れずに縁だけが増える。
 */
const OUTLINE_DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7],
];
/**
 * 白黒で刷る本のために、利用者が選んだ色を輝度グレーへ落とす。
 *
 * 背景画像は `background-blend-mode: luminosity` でグレーになるが、
 * **文字色とフチの色は CSS の色値なのでそこを通らない**。変換しないと
 * 「白黒で刷るのに画面のフチだけ赤い」状態になり、刷り上がりの判断ができない
 * (2026-08-16 にユーザーから指摘。それまでフチだけ色が残っていた)。
 *
 * export するのは preview/paint.ts(塗りだけの変更を組版なしで画面に映すパッチ)が
 * **同じ変換で同じ色**を作るため。実装が2つに割れると、画面と書き出しがずれる
 */
export function toGray(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const y = Math.round(
    0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255),
  );
  const h = y.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/** #rrggbb に透明度を足して rgba() にする。帯の濃さに使う(paint.ts と共用) */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${+alpha.toFixed(3)})`;
}

/**
 * 余白ありの挿絵(余白すこし・おおめ)を、ノド側を下限まで空けた名前付きページ(@page platewide / platenarrow)で組むか。
 * 組むなら、その箱(四方の内寸と箱の幅 mm)。組まない(余白0の @page plate で組む)なら null。
 * 無線綴じで印刷所の決まりがあり、ノド側の内寸が比の内寸より大きい本だけ(2026-10-12 修正リスト 4-5)。
 * 組版(typesetCss)と下見の重ね(paint.ts の挿絵の余白。修正リスト 13)が同じ判定を使う
 */
export function plateGutterBoxOf(
  l: PageLayout,
  size: 'wide' | 'narrow',
): { ins: ReturnType<typeof plateInsetsMm>; boxW: number } | null {
  const ins = plateInsetsMm(l, size);
  if (!(ins.gutter > ins.fore)) return null;
  return { ins, boxW: l.trimW - ins.fore - ins.gutter };
}

/**
 * 余白ありの挿絵の、絵の最大の幅・高さ(mm)。css.ts の div.plate.wide / .narrow img と、
 * 下見の重ね(paint.ts。修正リスト 13)が同じ値を使う。比は grid.ts の PLATE_INSET
 */
export function plateImgBox(l: PageLayout, size: 'wide' | 'narrow'): { maxW: number; maxH: number } {
  const inset = l.trimW * PLATE_INSET[size];
  const gutter = plateGutterBoxOf(l, size);
  return { maxW: gutter ? gutter.boxW : l.trimW - inset * 2, maxH: l.trimH - inset * 2 };
}

/**
 * **章だけ・コラムだけの「本文の下に帯」を、そのページの帯の箱ごと差し替える規則。**(2026-10-09 全体確認)
 *
 * 本全体の帯は body の background で、Vivliostyle はそれを各ページの箱に塗る
 * (紙: [data-vivliostyle-page-area-container]、下見: [data-vivliostyle-original-tag="body"])。
 * 以前は章・コラムの section に background を当てていたが、それでは下に塗られた本全体の帯を消せず、
 * 章・コラムで「なし」を選んでも帯が残り、ほかの値では二重に塗られていた。
 * Vivliostyle の CSS には :has もページ単位の指定も無いので、組み上がった DOM にブラウザの CSS として足す
 * (下見は paint.ts、紙は print.ts が印刷の直前に差し込む)。
 * 挿絵のページ(div.plate)は本全体の打ち消し(paint.ts / css.ts の div.plate)に任せて触らない
 */
export function platePageRules(s: ProjectSettings, pageSel: string, areaSel: string): string {
  const mono = s.ink === 'mono';
  const ink = (c: string | undefined) => (c ? (mono ? toGray(c) : c) : c);
  const value = (a: number, c: string | undefined) =>
    a > 0 ? withAlpha(ink(c) ?? '#fff', Math.min(1, Math.max(0, a))) : 'transparent';
  const rules: string[] = [];
  for (const k of new Set([...Object.keys(s.chapterPlate ?? {}), ...Object.keys(s.chapterPlateColor ?? {})])) {
    const i = Number(k);
    const own = (s.chapterPlate ?? {})[i];
    const color = (s.chapterPlateColor ?? {})[i];
    if (own === undefined && color === undefined) continue;
    // 色だけ変えた章は、濃さを本全体から継ぐ
    const v = value(own ?? s.textPlate ?? 0, color ?? s.textPlateColor);
    rules.push(
      `${pageSel}:has(section.chapter#ch${i + 1}):not(:has(div.plate)) ${areaSel} { background: ${v} !important; }`,
    );
  }
  for (const c of s.columnPages ?? []) {
    if (c.plate === undefined && c.plateColor === undefined) continue;
    const v = value(c.plate ?? s.textPlate ?? 0, c.plateColor ?? s.textPlateColor);
    const id = c.id.replace(/["\\]/g, '');
    rules.push(`${pageSel}:has(section.colpage[data-colpage="${id}"]) ${areaSel} { background: ${v} !important; }`);
  }
  return rules.join('\n');
}

/** フチを8方向の影で作る(冒頭の OUTLINE_DIRS を参照)。paint.ts と共用 */
export function outlineShadow(width: number, color: string): string {
  const w = Math.max(0, +(width ?? 0).toFixed(3));
  if (!w) return '';
  const c = color || '#fff';
  return OUTLINE_DIRS.map(
    ([x, y]) => `${+(x * w).toFixed(3)}em ${+(y * w).toFixed(3)}em 0 ${c}`,
  ).join(', ');
}

/** 紙の白。background-color ではなく画像レイヤーとして敷く(理由は typesetCss の bgLayer を参照) */
export const PAPER = 'linear-gradient(#fff, #fff)';

/**
 * 背景画像の重ね(background-image の値)。上=白いかぶせ(濃さ 0〜1)、中=絵、下=紙の白。
 *
 * **typesetCss(組版CSS)と preview/paint.ts(塗りパッチ)の両方がここを通る。**
 * 式が2つに割れると「画面の背景と刷りの背景が別もの」になるので、1つに置く
 */
export function bgImageValue(src: string | undefined, opacity: number): string {
  const veil = (1 - Math.min(1, Math.max(0, opacity ?? 0.25))).toFixed(3);
  return src
    ? [
        /*
         * **かぶせる白が要らない(濃さ 1)ときは、層を none にする。**(2026-10-12 1.1.0)
         * 透明度 0 の白のグラデーションを、Chrome は「透明度 0 の黒」の計算式の影として PDF に書き、
         * Ghostscript は CMYK にするとき、それを見えない4色の黒の部品(192×274 の画像)に変える。
         * 刷りには出ないが C・M・Y を持つので、そのページがカラーと数えられた(絵を全部白黒にしても章の地のページが残った)。
         * 層は消さずに none で残す(白黒の本の合成 bgBlendValue は3層を前提に並べている)
         */
        veil === '0.000' ? 'none' : `linear-gradient(rgba(255,255,255,${veil}), rgba(255,255,255,${veil}))`,
        `url("${assetUrl(src)}")`,
        PAPER,
      ].join(', ')
    : PAPER;
}

/** 白黒の本で絵をグレーに落とす合成(background-blend-mode の値)。paint.ts と共用 */
export function bgBlendValue(mono: boolean, src: string | undefined): string {
  return mono && src ? 'normal, luminosity, normal' : 'normal';
}

/**
 * 「ノド／小口」の置き場所 → マージンボックスの名前(bottom-right など)。
 *
 * 見開きの本は表と裏で左右が入れ替わる。縦組み(右綴じ)の表ページは小口が左、
 * 横組み(左綴じ)の表ページは小口が右。だから設定は左右で持たず、ここで振り分ける。
 * typesetCss はこれに `@` を付けて @page の枠に使い、paint.ts は
 * Vivliostyle が描いた `[data-vivliostyle-page-margin-box=…]` を同じ名前で引く
 */
export function marginBoxName(slot: MarginSlot, vertical: boolean, recto: boolean): string | null {
  if (slot === 'none') return null;
  const [edge, place] = slot.split('-') as ['top' | 'bottom', 'gutter' | 'center' | 'fore'];
  if (place === 'center') return `${edge}-center`;
  const foreLeft = vertical ? recto : !recto;
  const foreIsLeft = place === 'fore' ? foreLeft : !foreLeft;
  return `${edge}-${foreIsLeft ? 'left' : 'right'}`;
}

/**
 * 縦組みの本の大扉を、書名・著者名だけ横組みにするときの宣言(2026-10-03)。
 *
 * **組版HTMLのCSS(typesetCss)と、下見の「組まずに向きだけ変える」パッチ(preview/paint.ts)が
 * 同じものを使う。** 下見は縦のままの組版に `!important` で重ねるだけなので、
 * 2か所に同じ数字を書くと、画面と刷りで大扉の位置が食い違う。
 * 縦組みのページに横組みの器を置くと幅が版面幅にならず細くなる(奥付で実測済み)ので、
 * 幅と高さを実寸で与える。ここの数字は typesetCss が大扉に使うものと同じ(titleM は左右対称の余白)
 */
export function titleHorizontalDecls(
  s: ProjectSettings,
  l: PageLayout,
): { section: string; h1: string; author: string; h1Reset: string } {
  const m = l.margins;
  const bleed = l.bleed;
  const topM = m.top + bleed.top;
  const bottomM = m.bottom + bleed.bottom;
  const foreM = m.fore + bleed.fore;
  const gutterM = m.gutter + bleed.gutter;
  const pageAreaH = l.paperH - topM - bottomM;
  const titleM = printRulesOf(s) ? Math.max(foreM, gutterM) : foreM;
  const feed = s.lineFeedPt;
  return {
    section: `writing-mode: horizontal-tb; width: ${mm(l.paperW - titleM * 2)}; height: ${mm(pageAreaH)};`,
    h1: 'writing-mode: horizontal-tb; text-align: center;',
    author: `writing-mode: horizontal-tb; bottom: ${pt(feed * 3)}; left: 0; right: 0; text-align: center;`,
    // 縦組みの書名が持つ「版面の中央へ寄せる」右マージン。下見が縦の組版に重ねるとき、これを消す
    h1Reset: 'margin-right: 0;',
  };
}

/**
 * 大扉の書名・著者名の書体の宣言(2026-10-12 今後の改修の希望 5)。
 *
 * **組版HTMLのCSS(typesetCss)と、下見の「組まずに書体だけ変える」パッチ(preview/paint.ts)が同じものを使う。**
 * 書体は titlepageFontsOf で決める。'cover'(表紙とつながる)は、ここへ来る前に App が withTitlepageCover で
 * 表紙のいまの書体へ置き換えておく(置き換えずに来たら本文の書体に倒れる)。
 * 太さはその書体の bold(佑字 肅・ドット・Reggae One は 400、Klee は 600)。太字を持たない書体を 700 で頼むと、
 * ブラウザが字を太らせて形が崩れる。
 * **指定の無い項目は空を返す。** 大扉はいままでどおり本文の書体・太さ 700 で組み、組版HTMLは1バイトも変わらない。
 * 縦中横(.tcy)の詰め数字も、選んだ書体のものにそろえる
 */
export function titlepageFontDecls(s: ProjectSettings): { h1: string; author: string; h1Tcy: string; authorTcy: string } {
  const f = titlepageFontsOf(s);
  const titleOn = s.titlepageTitleFont !== undefined;
  const authorOn = s.titlepageAuthorFont !== undefined;
  return {
    h1: titleOn ? `font-family: ${BODY_FONTS[f.title].stack}; font-weight: ${BODY_FONTS[f.title].bold};` : '',
    author: authorOn ? `font-family: ${BODY_FONTS[f.author].stack};` : '',
    h1Tcy: titleOn ? `font-family: ${tcyStack(f.title)};` : '',
    authorTcy: authorOn ? `font-family: ${tcyStack(f.author)};` : '',
  };
}

/**
 * @param bookTitle 柱に書名を入れる設定のときだけ使う。
 *   書名は本文の中に無いので `string()` では拾えず、CSS に直に埋めるしかない
 */
/**
 * 柱に刷れる字数の上限(2026-10-03 監査)。
 * 柱は折り返さない(anchorFor)ので、長い書名・章題は紙の端へ出てしまう。
 * **幅を切る CSS が余白の枠で効かない**ため、字数で切る。1字を 1em(柱の字の大きさ)とみなす
 * (欧文は細いので、実際の幅はこれより狭くなる = 安全側)。
 * 版面の幅(ノド〜小口の余白の内側)のうち、同じ辺にノンブルがあるときはノンブルのぶん(中央なら両脇・脇なら残り)を空ける。
 * 越えた分は「…」にする(clipRunningHead)
 */
export function runningHeadMaxChars(s: ProjectSettings, l: PageLayout): number {
  const m = l.margins;
  const bleed = l.bleed;
  const areaW = l.paperW - (m.gutter + bleed.gutter) - (m.fore + bleed.fore);
  const nombreSlot: MarginSlot = s.nombreSlot ?? 'bottom-fore';
  const headSlot: MarginSlot = s.runningHeadSlot ?? 'bottom-center';
  const edgeOf = (slot: MarginSlot) => (slot.startsWith('top') ? 'top' : 'bottom');
  const sameEdge = nombreSlot !== 'none' && edgeOf(nombreSlot) === edgeOf(headSlot);
  const share = !sameEdge ? 1 : headSlot.endsWith('-center') ? 0.6 : nombreSlot.endsWith('-center') ? 0.3 : 0.45;
  return Math.max(4, Math.floor((areaW * share) / (s.fontPt * 0.75 * PT_TO_MM)));
}

/** 柱の字を max 字までに切り、越えるときは最後を「…」にする(字数は表示される字=コードポイントで数える) */
export function clipRunningHead(text: string, max: number): string {
  const cs = Array.from(text);
  return cs.length <= max ? text : `${cs.slice(0, Math.max(1, max - 1)).join('')}…`;
}

export function typesetCss(s: ProjectSettings, l: PageLayout, bookTitle = ''): string {
  const vertical = s.writingMode === 'vertical';
  // 縦組みの本で、大扉の書名・著者名だけ横組みにするか(2026-10-03)。本文・柱・奥付は変えない
  const titleH = vertical && titleWritingModeOf(s) === 'horizontal';
  const titleDecls = titleHorizontalDecls(s, l);
  // 大扉の書名・著者名だけの書体(2026-10-12 希望 5)。指定が無ければ空 = いままでどおり
  const tpFont = titlepageFontDecls(s);
  // 保存済みデータに bodyFont が無い場合(この設定より前のプロジェクト)はテーマから補う
  const font = BODY_FONTS[s.bodyFont] ?? BODY_FONTS[THEME_BODY_FONT[s.theme]];
  const bodyFont = font.stack;
  const feed = s.lineFeedPt;
  /**
   * ルビ・傍点の注釈を、行の端から字面の肩へ寄せる距離(注釈の字の em)。
   * 行の端(行送りの半分)から字面(0.5字)まで戻し、わずかな間(0.05字)を足す。
   * 注釈の字は本文の半分なので、本文の字で測った値を2倍にする
   */
  const annoShift = (fontPt: number, feedPt: number) =>
    ((1 - feedPt / fontPt / 2 + 0.05) * 2).toFixed(3);
  const m = l.margins;

  // 物理プロパティのマッピング(縦書き: 行は右→左に進む/横書き: 上→下)
  const blockSize = vertical ? 'width' : 'height'; // n行取りの「厚み」
  const inlineSize = vertical ? 'height' : 'width'; // 行に沿った長さ(区切り線の長さ)
  const marginBefore = vertical ? 'margin-right' : 'margin-top'; // 見出し前のアキ
  const marginAfter = vertical ? 'margin-left' : 'margin-bottom'; // 見出し後のアキ
  // 行の中のアキ。縦組みでは天地、横組みでは左右になる
  // (引用の字下げ・箇条書きのぶら下げは、どちらも「行の中」の位置なのでこちらを使う)
  const padLineStart = vertical ? 'padding-top' : 'padding-left';
  const padLineEnd = vertical ? 'padding-bottom' : 'padding-right';
  // 版面の実寸(pt)。画像を版面内に収めるのに使う。
  // 縦書きでは max-width:100% が段や版面の幅を拾えず画像が版面外まで膨らむため、
  // 実寸で上限を与える必要がある(実測で確認済み)
  // 段組み時は「1段ぶん」を基準にする(linesPerPage は段数倍された総行数なので使わない)
  const printW = vertical ? l.linesPerCol * feed : l.charsPerLine * s.fontPt;
  const printH = vertical ? l.charsPerLine * s.fontPt : l.linesPerCol * feed;

  // ---- 本文中の画像を、段組みのときにどう置くか(2026-08-17 実測) ----
  //
  // 縦組みの回り込みは「絵の天地」を段から差し引いた**残り**に本文を流す。
  // 段は 1段しかない本文とちがって天地が短いので、絵が段いっぱいになると
  // 残りが数文字ぶんしか無く、1行1〜3字の帯になって読めない(利用者から報告あり)。
  // さらに絵が段の 95% を超えると、**その章の1ページ目から本文が丸ごと押し出される**
  // (B5 3段で実測: 章の1ページ目が見出しだけの 18字になった)。
  //
  // どちらも「残りが半端」なときに起きる。残りは**0か、読める幅か**のどちらかにする:
  //
  // - 段に「絵 + 本文10字」が入る → 絵の天地を (字数 − 10字) までに抑えて回り込ませる
  //   10字は rules の下限(これを切ると語が毎行割れる)
  // - 入らない(3段・4段はたいてい 12〜17字) → **回り込ませない**。
  //   絵は段の天地をそのまま使い、行方向だけ段の半分に抑える。
  //   本文は絵の先へ、段いっぱいの行で流れる
  //
  // 1段のときは今までどおり(版面が広いので回り込みで行が戻る。2026-08-16 の実測)
  const WRAP_MIN_CHARS = 10; // 回り込む本文に残す最低字数
  const FIG_MIN_CHARS = 8; // これを下回るなら図版として成立しないので回り込みをやめる
  //
  // 下の figBox が、段の数・1段の字数・1段の天地・文字サイズからこの判断をする。
  // 本全体の値と、章ごとに段数や文字サイズを変えた章の値の、両方で呼ぶ(下の chapterFigCss)

  // ---- 1段の縦組みでは、絵を「ページの天」に寄せる(2026-09-29) ----
  //
  // 回り込みをふつうの float で組んでいたあいだは、絵は**置いた段落の位置**に出た。
  // 絵は版面の幅いっぱいまで広がるので、ページの途中に当たるとまず入りきらず、
  // 後ろの本文ごと次のページへ送られて、送り元に空きが残った。送られた先でも、
  // 絵の前のアキ(1行)がページの頭で消えないので、絵は版面の端から1行ぶん内へずれ、
  // 反対側は版面から1行ぶん外へ出ていた(B6 で実測: 版面 62〜434px に対し絵 39〜413px)。
  // ユーザー報告「画像を文中に入れると、最初の行から画像がきれいに入らない」はこれ。
  //
  // ページフロート(float-reference: page)にすると、絵は置いた段落のあるページの
  // 天・行頭の角に着き、**前後の本文が絵の下へ回り込んでページを埋める**。
  // そのページに入らない絵は次のページの頭へ送られるが、本文は先に流れるので空きが残らない
  // (同じ原稿で実測: 送り元の空きが消えて総 9→8ページ。絵は 61〜435px で版面にそろう)。
  //
  // 段組みではやらない。ページの角へ寄せると、下の段に置いた絵が上の段へ飛んでしまう
  const figBox = (cols: number, chars: number, spanPt: number, fontPt: number) => {
    const wrap = !vertical || cols === 1 || chars >= WRAP_MIN_CHARS + FIG_MIN_CHARS;
    return {
      wrap,
      pageFloat: vertical && wrap && cols === 1,
      maxW:
        vertical && !wrap
          ? printW * 0.5 // 回り込まないぶん、段の残り半分に本文の行が立つ
          : printW,
      maxH:
        vertical && wrap && cols > 1
          ? // 絵と本文のあいだの半行(margin-inline)もここから出る。引いておかないと
            // 約束した10字に届かない(引かないと実測 9.1字だった)
            (chars - WRAP_MIN_CHARS) * fontPt - feed * 0.5
          : spanPt - feed * 0.5,
    };
  };
  const {
    wrap: wrapFig,
    pageFloat: pageFloatFig,
    maxW: figMaxW,
    maxH: figMaxH,
  } = figBox(l.columns, l.charsPerLine, printH, s.fontPt);
  /** キャプション付きの絵が、行の並ぶ方向で譲るぶん(理由は figure.fig.has-cap img のところ) */
  const figCapGive = (pageFloat: boolean) => feed * (pageFloat ? 2.4 : 3.4);

  // ---- 章ごとに段数・文字サイズを変えた章の絵(2026-09-29) ----
  //
  // 上の4つは本全体の段数と字数で決めている。章だけ段数を変えても上限はそのままだったので、
  // 1段の本の中の2段の章では、絵の天地の上限が1段の版面の天地のままになり、
  // **下の段に置いた絵が版面の地を越えてノンブルに重なった**
  // (B6・縦・9.5pt で実測: 版面の地 606px に対し絵の下端 682px。約20mm)。
  // 逆向き(段組みの本の中の1段の章)は、上限が段組み用の小さい値のままになっていた。
  //
  // 段数・文字サイズ・行送りのどれかを変えた章は、その章の1段で figBox を引き直し、
  // 本全体と違う値になったものだけ上書きする。絵の前後のアキとキャプションは本全体の
  // 行送りで組んであるので(figure.fig の margin-block)、譲るぶんは本全体の行送りのまま。
  // 横組みは段組みが無く、版面の四角も文字サイズで変わらないので、上書きは要らない
  //
  // **段組みの本の中の1段の章は、ページの天に寄せる。** 1段の本と同じ組み方にそろえる
  // (段が1つなら「下の段の絵が上の段へ飛ぶ」ことが起きない)
  const chapterFigCss = (i: number): string => {
    if (!vertical) return '';
    const fp = (s.chapterFontPt ?? {})[i] || s.fontPt;
    const lf = (s.chapterLineFeedPt ?? {})[i];
    const rawCol = (s.chapterColumns ?? {})[i];
    const cols = rawCol ? Math.min(rawCol, maxColumns(s.trim, s.writingMode)) : l.columns;
    // 段間は、章で段数を決めたときだけ章の行送りで引き直される(section.chapter.chmixN の column-gap)
    const feedHere = lf ?? fp * (feed / s.fontPt);
    const gapPt = rawCol && cols > 1 ? feedHere * s.columnGapLines : l.columnGapPt;
    const { spanPt, chars } = chapterColumn(l, cols, fp, gapPt);
    const f = figBox(cols, chars, spanPt, fp);
    const sel = `section.chapter.chmix${i} figure.fig`;
    const box = [
      f.wrap !== wrapFig
        ? f.wrap
          ? 'float: inline-start; clear: inline-start;'
          : 'float: none; clear: none;'
        : '',
      f.pageFloat !== pageFloatFig
        ? f.pageFloat
          ? 'float-reference: page; margin-block-start: 0;'
          : `float-reference: inline; margin-block-start: ${pt(feed)};`
        : '',
    ].filter(Boolean);
    const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
    const resized = !same(f.maxW, figMaxW) || !same(f.maxH, figMaxH);
    return [
      box.length ? `${sel} { ${box.join(' ')} }` : '',
      resized ? `${sel} img { max-width: ${pt(f.maxW)}; max-height: ${pt(f.maxH)}; }` : '',
      // 章の img の規則は本全体の has-cap より重いので、大きさを変えた章は has-cap も出し直す
      resized || f.pageFloat !== pageFloatFig
        ? `${sel}.has-cap img { max-width: ${pt(f.maxW - figCapGive(f.pageFloat))}; }`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  };
  /** 上書きの要る章のぶんだけ。1つも無ければ空(1行も足さない) */
  const chapterFigRules = Array.from(
    new Set([
      ...Object.keys(s.chapterFontPt ?? {}),
      ...Object.keys(s.chapterLineFeedPt ?? {}),
      ...Object.keys(s.chapterColumns ?? {}),
    ]),
  )
    .map((k) => chapterFigCss(Number(k)))
    .filter(Boolean)
    .map((rule) => `\n${rule}`)
    .join('');

  // 塗り足しは天・地・小口・ノドの4辺それぞれ(KDP はノド側 0。背なので断裁されない)。
  // 用紙が外へ広がったぶん余白を足すので、仕上がり寸法から見た版面の位置は変わらない
  const bleed = l.bleed;
  const topM = m.top + bleed.top;
  const bottomM = m.bottom + bleed.bottom;
  const foreM = m.fore + bleed.fore;
  const gutterM = m.gutter + bleed.gutter;

  // 大扉で書名を版面の左右中央に置くための実寸(rules §8)。
  // Vivliostyle のページ内では section が版面サイズを持たないため flex の
  // 中央寄せも margin:auto も効かない。行の位置を直接算出して寄せる。
  // 大扉だけは左右対称の余白にしているので、本文の版面ではなく扉の幅で計算する
  // ページ領域の実寸(mm)。ノド・小口はページの奇偶で入れ替わるが合計は同じ
  // = 仕上がり幅 − ノド − 小口。ノド側にも塗り足しを足すので、gutterM で引かないと版面がそのぶん広がる
  const pageAreaW = l.paperW - gutterM - foreM;
  const pageAreaH = l.paperH - topM - bottomM;
  // 奥付の罫線を内へ寄せるか(下限が分かる出し先 = 印刷所の決まりが入った本か中綴じ。KDP の表は対象にしない)
  const colophonRuleInset =
    (bindingOf(s) === 'saddle' || printRulesOf(s)) && l.margins.gutter - gutterFloorMm(s.estimatedPages, s) < COLOPHON_RULE_SLACK_MM
      ? COLOPHON_RULE_INSET_MM
      : 0;

  // 挿絵ページの四方の内寸(mm)。判型に対する比で持つので、大きい判型ほど余白も広がる。
  // 2つの差がはっきり出る値にする(近いと選ぶ意味がないうえ、本文の版面と偶然一致して見える)
  // 比は grid.ts の PLATE_INSET が持つ。画面に出す推奨サイズと同じ値を使うため
  // 無線綴じで決まりの入った本は、ノド側だけ下限まで空ける(2026-10-12 修正リスト 4-5。grid.ts plateInsetsMm)。
  // ノドは見開きの内側なので、左右のページで入れ替わる。要素からはページの左右が分からないため、
  // **ページの余白で絵の箱の位置を決める**(:recto/:verso ごとに左右の余白を変えた名前付きページ。printplate と同じ手)。
  // 空けるのは ノド側の内寸が比の内寸より大きいときだけ(そうでなければ規則を1行も足さない = 従来の組版HTMLのまま)。
  // 式は下見の重ね(paint.ts の挿絵の余白)と共用するので、外の plateGutterBoxOf / plateImgBox に置いた(2026-10-12 修正リスト 13)
  const plateGutterWide = plateGutterBoxOf(l, 'wide');
  const plateGutterNarrow = plateGutterBoxOf(l, 'narrow');
  const plateBoxWide = plateImgBox(l, 'wide');
  const plateBoxNarrow = plateImgBox(l, 'narrow');
  /**
   * ページの左右の余白(mm)。左のページは 小口が左・ノドが右、右のページはその逆。
   * 余白は 塗り足し + 内寸(仕上がりの端から絵の箱までの距離)。箱の中に絵を中央寄せで置く
   */
  const plateGutterMargins = (ins: { fore: number; gutter: number }, side: 'left' | 'right') =>
    side === 'left'
      ? { left: bleed.fore + ins.fore, right: bleed.gutter + ins.gutter }
      : { left: bleed.gutter + ins.gutter, right: bleed.fore + ins.fore };
  /** 余白ありの挿絵のページ(@page platewide / platenarrow)。:recto は 縦組みなら左のページ・横組みなら右のページ */
  const plateGutterPages = (name: string, ins: { fore: number; gutter: number }) => {
    const page = (pseudo: 'recto' | 'verso') => {
      const side = (pseudo === 'recto') === vertical ? 'left' : 'right';
      const mg = plateGutterMargins(ins, side);
      return `
@page ${name}:${pseudo} {${noBoxes}
  margin-left: ${mm(mg.left)};
  margin-right: ${mm(mg.right)};
}`;
    };
    return `
@page ${name} {${noBoxes}
  margin: 0;
}${page('recto')}${page('verso')}`;
  };
  // 見開きの絵(2026-10-03)。**使っている本にだけ規則を足す**(使っていない本の組版HTMLは1バイトも変えない)。
  // 絵の置き方・左右の割り当て・塗り足しの重ね方は typeset/spread.ts
  const spreadCss = (s.plates ?? []).some((p) => p.size === 'spread' && !p.blank && p.src && isRenderableImage(p.src))
    ? (() => {
        const g = spreadGeometry(l, s.writingMode);
        return `
/* ---- 見開きの絵(挿絵ページの「見開き（2ページ）」) ----
   1枚の横長の絵を、向かい合う2ページに分けて入れる。html.ts が同じ絵を2つの箱(sp-a = 偶数ページ・sp-b = 奇数ページ)に入れる。
   絵は「仕上がり2枚 + 小口の塗り足し2つ」の幅(${mm(g.artW)} × ${mm(g.artH)})に中央を切り出して敷き、
   各ページの用紙(塗り足し込み)で切る。折り目の側は、ノド側の塗り足しのぶんだけ反対側の絵まで入る。
   1ページ目は break-before: verso(偶数ページから)。奇数ページに来るときは組版が白いページを1枚入れる。
   2ページ目の recto は、1ページ目が偶数ページなら自然に満たされる(白は増えない) */
div.plate.spread {
  position: relative;
  overflow: hidden;
  display: block;
}
div.plate.spread.sp-a { break-before: verso; }
div.plate.spread.sp-b { break-before: recto; }
div.plate.spread img {
  position: absolute;
  top: 0;
  width: ${mm(g.artW)};
  height: ${mm(g.artH)};
  max-width: none;
  max-height: none;
  object-fit: cover;
}
div.plate.spread.sp-a img { left: ${mm(-g.first.offset)}; }
div.plate.spread.sp-b img { left: ${mm(-g.second.offset)}; }`;
      })()
    : '';

  // 挿絵・全面画像に column-span: all は付けない。
  // 段抜きにすると、その手前で段が均等割りされて前のページが埋まりきらない(実測で確認)。
  // break-before/after: page と用紙の実寸だけで、段組みでも1枚で1ページを占める
  // (2段・3段・4段とも 185×264mm @(0,0) で出ることを実測)

  // 大扉の左右の余白(左右対称)。**印刷所の決まりが入っている本だけ**、ノド側の下限と小口側の大きいほうにそろえる。
  // 大きいほうにしないと、横組みで書名が長いとき、1ページ目(右ページ)の字がノドの下限を割る
  // (2026-10-01 実測: 文庫・横組み・既定の決まり 15mm・書名38字で、仕上がりの端から 13.5mm)。
  // KDP と決まりの無い本は、いままでどおり foreM(下限 9.6mm が小口の余白とほぼ同じで、表に出ない。
  // 組版HTMLを1バイトも変えない)。四辺に塗り足しを付けた決まりは、左右対称なので書名は仕上がりの中央のまま。
  // ノド側に塗り足しを付けない決まりは、用紙の中央=仕上がりの中央から塗り足しの半分だけ小口へずれる(KDP も同じ)
  const titleM = printRulesOf(s) ? Math.max(foreM, gutterM) : foreM;
  const titlePageInline = (l.paperW - titleM * 2) / PT_TO_MM; // 扉の版面幅(pt)
  const titleThickness = feed * 2; // 書名1行の厚み(= line-height)
  const titleCenterOffset = (titlePageInline - titleThickness) / 2;
  const authorOffset = (titlePageInline + titleThickness) / 2 + feed * 2; // 書名の左に2行空ける

  // ノド・小口(ページの奇偶で入れ替わる)
  const rectoLR = vertical
    ? `margin-right: ${mm(gutterM)}; margin-left: ${mm(foreM)};`
    : `margin-left: ${mm(gutterM)}; margin-right: ${mm(foreM)};`;
  const versoLR = vertical
    ? `margin-left: ${mm(gutterM)}; margin-right: ${mm(foreM)};`
    : `margin-right: ${mm(gutterM)}; margin-left: ${mm(foreM)};`;

  /**
   * 置き場所 → マージンボックス名(@付き)。`none` は刷らない。
   * 左右の振り分けは marginBoxName(モジュール先頭)に1本化してある —
   * 塗りパッチ(preview/paint.ts)が同じ名前で枠を引くため
   */
  const boxOf = (slot: MarginSlot, recto: boolean): string | null => {
    const name = marginBoxName(slot, vertical, recto);
    return name ? `@${name}` : null;
  };

  /** ドロップキャップの行数。0 なら付けない */
  const drop = Math.max(0, Math.min(5, Math.round(s.dropCap ?? 0)));
  /** その章に何か上書きがあるか(html.ts が付ける chmix クラスと対にする) */
  const chapterHasOverride = (i: number) =>
    !!(s.chapterFont ?? {})[i] ||
    !!(s.chapterFontPt ?? {})[i] ||
    !!(s.chapterLineFeedPt ?? {})[i] ||
    !!(s.chapterColumns ?? {})[i] ||
    (s.chapterDropCap ?? {})[i] !== undefined;

  const nombreSlot: MarginSlot = s.nombreSlot ?? 'bottom-fore';
  const headSlot: MarginSlot = s.runningHeadSlot ?? 'bottom-center';
  /** 柱をどのページに出すか。既定は奇数ページだけ(和書の定番)だが、選べる */
  const headPages = s.runningHeadPages ?? 'recto';
  /**
   * 柱に何を刷るか。章題(既定)か、書名か。
   * 書名は `string()` を使わず、その場で文字を埋める(値が本文の中に無いため)
   */
  // 書名は記法を外した字にする(2026-09-25 見直し S2-11: 書名に ｜親《よみ》 を書くと、柱にその記法が
  // そのまま刷られていた。章題のほうは data-plain で同じことを済ませている)
  const headContent =
    s.runningHeadText === 'title'
      ? JSON.stringify(clipRunningHead(plainText(bookTitle), runningHeadMaxChars(s, l)))
      : 'string(chapter-title, first)';
  const headOn = (recto: boolean) =>
    headPages === 'both' || (recto ? headPages === 'recto' : headPages === 'verso');

  /**
   * ノンブル・柱を余白のどこに落とすか。
   *
   * マージンボックスは本文の縦書きを継承してしまうため、必ず横組みに戻す。
   * 既定の縦中央だと余白のまん中に落ちて、文庫では仕上がりの端から約6mm しか残らず
   * KDP の安全領域(仕上がり端から 6.4mm)を割る。
   *
   * **本文からの距離では決めない。** 以前は版面の直下 `0.7行` に置いていたが、
   * これは行送りに連れて動く値で、判型を変えると余白だけが広がって
   * ノンブルが本文にへばりついたまま取り残された(2026-08-19 ユーザー指摘)。
   * ノンブルの位置は**紙のかたちで決まる**もので、行送りとは関係がない。
   *
   * いまは**余白そのものの 40% の位置**に1行を置く。判型が変われば余白に連れて動き、
   * どの判型でも安全領域を割らない。版面寄り(50%より手前)にするのは、
   * ノンブルは紙の端よりも版面に属して見えるほうが本らしいから。
   *
   * ### ★ 率だけでは余白の狭い判型が持たない(2026-08-20 実測・修正)
   *
   * > フッターと本文の位置関係が近すぎる。**今は圧迫感があって読むのが苦しい**
   * > (2026-08-20 ユーザー。文庫・縦組みの画面)
   *
   * 率だけで置くと、余白の狭い判型ほどアキが薄くなる。画面で実測した文庫・縦組み
   * (版面の下端 136.007mm / ノンブルの字の上端 137.768mm)では **1.76mm しかなく、
   * 行送り 15.5pt(5.47mm)の 0.32行**。本文9ptの字送りで見ても 0.55字で、
   * 行と行のあいだより狭い。これでは本文の続きに見える。
   *
   * かといって率を上げると、A4のように余白が広い判型でノンブルが紙の端へ寄っていく。
   * 40% にした理由(版面に属して見えるほうが本らしい)を壊すので、**率は上げない**。
   * 率はそのままに、**行を基準にした下限**を足して、狭いほうだけを底上げする:
   *
   * ```
   * offset = clamp(max(band × 0.4 − 行厚/2, 行送り × 0.9), 0, band − 行厚)
   * ```
   *
   * 下限を **1.0行ではなく 0.9行**にしたのは、1.0行だと文庫・縦の地で
   * 置ける帯(8.79mm)から行厚(3.51mm)を引いた 5.29mm に足りず(1行=5.47mm)、
   * 決めているのが式ではなく clamp になってしまうから。**届く範囲で定番にいちばん近い値**を取る。
   *
   * ### ★★ 率を取る物差しがまちがっていた(2026-08-20 実測・修正)
   *
   * > 新書・B6・四六・A5版も高さのわりにノンブルとフッターが本文に近い。
   * > どれも**ページ全体から見て、本文に寄りすぎ**(2026-08-20 ユーザー。4判型の画面)
   *
   * 上の「行を基準にした下限」は文庫を救ったが、**行では判型の大きさに追いつかない**。
   * 余白の広い判型では率のほうが勝つので、下限をいくら上げても届かない。
   * 率そのものを見直す必要があった。
   *
   * **真因は率の値ではなく、率を取る物差しだった。** 帯は「版面の端から**安全線**まで」で
   * 測っていたが、安全線(仕上がり端から 6.4mm)は**読者に見えない線**で、
   * KDP に断裁で切り落とされないと約束させるためだけの線でしかない。
   * 読者がページを見て測っているのは版面の端から**紙の端**までで、ユーザーの
   * 「ページ全体から見て」もそれを指している。**見えない線を物差しにしてはいけない。**
   *
   * 安全線ぶんを先に引いてから率を掛けると、判型によらず **6.4 × 0.4 = 2.56mm** だけ
   * 一律にノンブルが本文側へ寄る。この 2.56mm は新書の余白(26.65mm)では効くが
   * A4(74.45mm)では誤差にしかならない。**だから中くらいの判型だけが詰まって見えた。**
   * 余白に占める割合で並べると、ユーザーが名指しした4判型がそのまま下位4つになる:
   *
   * | 判型 | 直す前 | 直したあと |
   * |---|---|---|
   * | 新書 / B6 / 四六 | **30%** | 40% |
   * | A5 | **32%** | 40% |
   * | B5 | 35% | 40% |
   * | A4 | 37% | 40% |
   * | 文庫(下限が効いている) | 44% | 44% |
   *
   * 直しは **率を余白そのものに掛ける**の一点。安全線は**クランプにだけ**使う
   * (置いた1行が安全領域を割らないことは今までどおり保証される):
   *
   * ```
   * SAFE_MM = 6.4                    // KDP: 仕上がり端から内側
   * band    = 余白 − SAFE_MM          // 置いてよい帯(クランプにだけ使う)
   * offset  = clamp(max(余白 × 0.4 − 行厚/2, 行送り × 0.9), 0, band − 行厚)
   * ```
   *
   * **和書の定番とも合う。** JLREQ(日本語組版処理の要件・JIS X 4051 系)は縦組みの
   * ノンブルを「**地から基本版面の文字サイズの5倍くらい上げた位置**」に置くと書いている。
   * つまり定番も**紙の端から**決めていて、版面からでも安全線からでもない。
   * 直したあとの字の中心から仕上がり端までを 5em と突き合わせると、
   * ユーザーが名指しした4判型でぴたりと重なる(新書 15.99 対 15.87mm で差 0.12mm、
   * A5 18.14 対 18.52、四六 15.75 対 16.76、B6 14.76 対 16.76)。
   * **名指しされた4判型は、定番の位置に届くはずなのに届いていなかった判型**だった。
   * 文庫は余白 15.19mm が 5em(15.87mm)より狭く定番に物理的に届かないので、
   * 下限(0.9行)が代わりに支える。B5・A4 は余白が広すぎて率のほうが勝つ。
   *
   * JLREQ が定める**最低アキ**は「基本版面の文字サイズより大きく」= 1文字ぶん超で、
   * これは下限 0.9行(文庫で 1.55em)がすでに上回っている。
   *
   * 生成CSSの実測(縦組み・既定余白・地)。**文庫は動かない**:
   *
   * | 判型 | 地余白 | 版面下端からの padding | 何行ぶん | 字の下端から仕上がり端 |
   * |---|---|---|---|---|
   * | 文庫(A6) | 15.19mm | 4.92mm(据え置き) | 0.90 | 6.77mm |
   * | 新書 | 26.65 | 6.35 → **8.91** | 1.16 → 1.63 | 16.79 → 14.23 |
   * | B6 | 24.59 | 5.43 → **7.99** | 0.93 → 1.37 | 15.46 → 12.90 |
   * | 四六判 | 26.25 | 6.09 → **8.65** | 1.02 → 1.44 | 16.45 → 13.89 |
   * | A5 | 30.24 | 7.49 → **10.05** | 1.18 → 1.58 | 18.65 → 16.09 |
   * | B5 | 56.35 | 17.93 → **20.49** | 2.82 → 3.23 | 34.32 → 31.76 |
   * | A4 | 74.45 | 25.08 → **27.64** | 3.74 → 4.12 | 45.09 → 42.53 |
   *
   * 動く量は**どの判型でも 2.56mm ちょうど**(= SAFE_MM × 0.4)。名指しされた4判型では
   * 4割増しになり、名指しされていない B5・A4 では1割ほどしか動かない。
   * どの判型も字の下端から仕上がり端まで 6.4mm 以上あり、安全領域は割らない。
   *
   * ### 天は同じ式で置くが、同じだけは空かない — 紙が足りない
   *
   * 天の余白は地より狭い(既定の天:地 = 1:1.25)。同じ式を通した実測(縦組み・天):
   * 文庫 2.25(据え置き)、新書 4.92→**7.05**、B6 5.24→**6.15**、四六 5.40→**6.55**、
   * A5 5.71→**7.63**、B5 13.42→**15.98**、A4 19.12→**21.68**。
   * **地と同じ 40% に乗る**(文庫を除く)。
   *
   * **文庫の天だけは 0.9行(4.92mm)が物理的に入らない。** 天余白 12.16mm から
   * 安全領域 6.4mm と行厚 3.51mm を引くと残りが 2.25mm しかないため、
   * ここは clamp が効いて「安全領域ぎりぎりまで版面から離す」に落ちる。
   * **寄せが逆(下端寄せ)なだけで式は同じ**なので、余白さえあれば天も地と同じ率になる。
   *
   * ### 横組みは下限が支えている
   *
   * 横組みは版面が天地に広く、余白が縦組みの半分ほどしかない。地は率が勝つが
   * (新書 4.76→5.86、A4 6.83→8.04)、**天はどの判型も下限 0.9行のまま動かない**。
   * 横組みの天はもともと余白の 43〜44% に来ていて、詰まって見える判型が無かった。
   *
   * ### ★★★ ベースラインをそろえ、本文から 1.5mm 離した(2026-10-03 ユーザー指摘・実測)
   *
   * > フッターの位置が文庫〜A5 でちょっと本文に近い気がする。ノンブルと下ぞろえにした方が
   * > いいんじゃないか。今は本文との余白が少なくて圧迫感(2026-10-03 ユーザー。文庫・縦組みの写真)
   *
   * 直したこと(scripts/check-footer.py で、紙の字の墨の端を画素で測った。KDP・縦組み):
   *
   * 1. **柱とノンブルのベースラインをそろえた。** 地は両方を行の箱の上端にそろえていたので、
   *    字の小さい柱の字が本文寄りに見えた(ベースラインのずれは実測 0.10mm、柱の字の上端は
   *    ノンブルより 0.1〜0.6mm 本文側)。いまは `line-height: 0` で行の箱を点にし、書体ごとの
   *    字下がりを引いて padding を出すので、ずれは 0.03mm 以下(anchorFor の注)。
   * 2. **本文から 1.5mm 離した**(MARK_EXTRA_MM)。式の 率・下限のどちらにも足す。
   *
   * | 判型(縦・KDP) | 本文の墨の端 → ノンブルの字の上端 | 柱の字の上端 | ノンブルの字の下端 → 仕上がり端 |
   * |---|---|---|---|
   * | 文庫 | 5.44 → **7.00** | 5.30 → **6.96** | 8.05 → **6.48** |
   * | 新書 | 9.72 → **11.27** | 9.51 → **11.24** | 14.62 → 13.06 |
   * | B6 | 8.88 → **10.46** | 8.65 → **10.34** | 13.29 → 11.70 |
   * | 四六判 | 8.69 → **10.28** | 8.11 → **9.80** | 14.29 → 12.70 |
   * | A5 | 10.06 → **11.65** | 9.48 → **11.16** | 16.55 → 14.96 |
   *
   * 文庫は安全線(KDP 6.4mm)に阻まれて +1.56mm まで(紙の端から 6.48mm に字の下端が来る)。
   * 安全域の規定が KDP より狭い会社は、その出し先だけ安全線を PrintTargetProfile.safeAreaMm にする(SAFE_MM)。
   * 安全線の判定は行の箱ではなく**字の下端**(地は字下がり 0.2字、天は字の背 0.8字ぶん)で見る(markBaseMM)。
   *
   * ### ★★★★ ベースラインではなく字の下端でそろえる(2026-10-12 修正リスト 11)
   *
   * > 柱がノンブルと天ぞろえになっているが、地ぞろえに変える(2026-10-11 ユーザー。文庫・縦組み)
   *
   * ベースラインがそろっても、和文の字はベースラインより少し下へ出るので、柱の字の下端がノンブルより
   * 0.14〜0.19mm 地の側に出て、上端のほうがそろって見えた。ノンブルの位置(markBaseMM)はそのままに、
   * 柱だけを HEAD_INK_DROP ぶん持ち上げる。天に置いた本も同じ(字の下端 = 墨の、地の側の端)。
   * 本文の行・ページ数は動かない(余白の枠の中の padding だけ)。
   */
  /**
   * 仕上がり端から、置いた字の下端(上端)まで確保する距離。
   * KDP は 0.25インチ(6.4mm)。会社の規定があればその値(safeAreaMm)。
   * 「その他の印刷所」は利用者の決まりがここまで届かないので、安全なほう(6.4mm)に倒す。
   * 規定の値ちょうどを狙うと字の下端の丸めで割りかねないので、会社の側で余裕を見た値を持たせる
   * (2026-10-03 監査: 5mm ちょうどを狙ったら、文庫・横組みで実測 5.02mm だった)
   */
  const SAFE_MM = PRINT_TARGETS[s.printTarget]?.safeAreaMm ?? 6.4;
  /**
   * 版面から離す距離に足す分(mm)。
   * ★ 2026-10-03 ユーザー「フッターの位置が文庫〜A5 でちょっと本文に近い。ノンブルと下ぞろえにした方が
   * いいんじゃないか。今は本文との余白が少なくて圧迫感」。
   * 上の式のままだと、字の大きい本文から見て柱の字の上端まで文庫で約5mm(行送りの 0.9行)しか空かない。
   * 和書の定番「版面から1行ぶん前後」は行送り 15.5pt(5.47mm)なので、そこから**さらに 1.5mm** 離す
   * (文庫は紙の端の安全線に阻まれて届くところまで。下の clamp)
   */
  const MARK_EXTRA_MM = 1.5;
  /** 行の箱の中心とベースラインの距離を字の大きさで割った値((ascent − descent) / 2)。和文の書体 / 既定のノンブル(Georgia) */
  const K_CJK = 0.43;
  const K_GEORGIA = 0.35;
  /**
   * 和文の字(かな・漢字)の墨が、ベースラインより下へ出る量(字の大きさに対する比)。
   * ★ 2026-10-12 修正リスト 11。ユーザー(10/11 文庫・縦組み)「柱がノンブルと天ぞろえになっているが、地ぞろえに変える」。
   * ノンブルの数字(Georgia の lining-nums も、和文の書体の数字も)はベースラインの上に立つが、和文の字は
   * 少し下へ出る。ベースラインをそろえると、柱の字の下端がノンブルより 0.14〜0.19mm 地の側に出て、
   * 上端がほぼそろう = 天ぞろえに見えた(scripts/check-footer.py の (a) で実測。文庫・A5、縦・横、地・天)。
   * 柱だけをこのぶん持ち上げて、**字の下端(墨の、地の側の端)** をノンブルとそろえる。
   * 実測の 0.062〜0.072字(章題の字で 0.08字まで)の真ん中を取った
   */
  const HEAD_INK_DROP = 0.07;
  /** ノンブルの字の大きさ(mm)。柱はその 0.75/0.85。位置は**ノンブルのベースライン**で決める */
  const markFsMM = s.fontPt * 0.85 * PT_TO_MM;
  /** 版面から最低これだけは離す。和書の定番「版面から1行ぶん前後」に合わせる */
  const markMinGapMM = feed * 0.9 * PT_TO_MM + MARK_EXTRA_MM;
  /**
   * 版面の端から、ノンブルの**ベースライン**までの距離(mm)。
   * 率は「版面から紙の端まで」= 余白そのものに掛ける。安全線は最後の Math.min だけが見る
   * (見えない線を物差しにすると判型で詰まる。上の ★★ を参照)。
   *
   * - 地: 字は線の上に立つので、ベースラインから**下**に字下がり(0.2字ぶん)が出る。そこまで含めて安全線を割らない
   * - 天: 逆に、ベースラインから**上**に字の背(0.8字ぶん)が出る
   */
  const markBaseMM = (edge: 'top' | 'bottom') => {
    const edgeMM = edge === 'bottom' ? m.bottom : m.top;
    // 版面の端から字の上端(天は下端)までの空き。率と下限の大きいほう
    const gap = Math.max(0, edgeMM * 0.4 - (markFsMM * 1.25) / 2 + MARK_EXTRA_MM, markMinGapMM);
    const want = edge === 'bottom' ? gap + markFsMM * 0.97 : gap + markFsMM * 0.28;
    // 天の字の背は 0.8字より少し高いことがある(長い柱に括弧や高い字が入ると実測 6.40mm ちょうどに届いた)ので 0.86字で見る
    // 天では、持ち上げた柱(HEAD_INK_DROP)の字の背も見る。柱の字は 0.75/0.85 の大きさなので、いまの値では
    // ノンブルの 0.86字のほうが高く、結果は変わらない(書体や値を変えたときの守り。2026-10-12 修正リスト 11)
    const headTopMM = (markFsMM * 0.75) / 0.85 * (HEAD_INK_DROP + 0.9);
    const room =
      edge === 'bottom'
        ? edgeMM - SAFE_MM - markFsMM * 0.2
        : edgeMM - SAFE_MM - Math.max(markFsMM * 0.86, headTopMM);
    return Math.max(0, Math.min(room, want));
  };
  /**
   * 置き場所(2026-10-03 見直し)。**ノンブルと柱を、同じベースラインにそろえる。**
   *
   * 以前は両方を `vertical-align: top`(地)や `bottom`(天)で行の箱の縁にそろえていた。
   * 行の箱の縁からベースラインまでの距離は「字の大きさ × 行の高さの余り × 書体」で決まるので、
   * 字の大きさの違う柱とノンブルでは、字の並ぶ線が 0.1〜0.4mm ずれた(柱のほうが本文寄り・字の小さいほう)。
   *
   * ここでは `line-height: 0` にして行の箱を点にし、**その点から書体の字下がり(k × 字の大きさ)だけ下**に
   * ベースラインが来る、という式で padding を逆算する。行の高さの項が消えるので、柱とノンブルの
   * ずれは書体の違いぶん(0.1mm 以下)だけになる。
   * k は書体の ascent/descent から出る値((ascent − descent) / 2。em 比): 和文の書体はどれも 0.42〜0.44、
   * 既定のノンブル(Georgia)は 0.35。実測(scripts/check-footer.py)で合わせた
   *
   * 地は紙の端(下)から、天は版面(下)から測った padding で置く(どちらも `vertical-align: bottom`。
   * 天の枠は紙の端から版面へ伸びるので、下端に寄せる)
   *
   * **折り返させない(`white-space: nowrap`)。** 行の箱が点(高さ 0)なので、長い柱が折り返すと
   * 2行とも同じベースラインに重なって読めなくなる(2026-10-03 監査。A5 に 40字の書名を柱にして再現)。
   * 折り返さないぶん、長い柱は紙の端へはみ出す。**幅で切る CSS(overflow: hidden / text-overflow)は使えない**
   * (実測: Vivliostyle の余白の枠では A5・横組み・地だけ、柱が丸ごと消える)ので、
   * 柱の字数を数えて「…」で省いてから渡す(runningHeadMaxChars / clipRunningHead)
   */
  const anchorFor = (edge: 'top' | 'bottom', fsMM: number, k: number, liftMM = 0) =>
    edge === 'bottom'
      ? `
      vertical-align: bottom;
      line-height: 0;
      white-space: nowrap;
      padding-bottom: ${mm(Math.max(0, bottomM - markBaseMM('bottom') + k * fsMM + liftMM))};`
      : `
      vertical-align: bottom;
      line-height: 0;
      white-space: nowrap;
      padding-bottom: ${mm(markBaseMM('top') + k * fsMM + liftMM)};`;
  /** 白黒で刷る本。絵も背景も文字もグレーになるので、画面とPDFもそのとおりに見せる */
  const mono = s.ink === 'mono';
  /** 利用者が選んだ色を、刷り色の設定に合わせて通す。白黒ならグレーへ落とす */
  const ink = (c: string | undefined) => (c ? (mono ? toGray(c) : c) : c);

  // 本文のフチ。面ごとの上書きが無いところはこれが効く
  const bodyShadow = outlineShadow(s.textOutline ?? 0, ink(s.textOutlineColor) ?? '#fff');
  const textOutline = bodyShadow
    ? `
  text-shadow: ${bodyShadow};`
    : '';
  /**
   * 面ごとのフチの上書き。本文と同じ値なら何も出さない(CSSを無駄に膨らませない)。
   * フチを外した面には `none` を明示する。書かないと body の影を継いでしまう
   */
  const outlineDecl = (r: ResolvedBg): string => {
    const shadow = outlineShadow(r.outline, ink(r.outlineColor) ?? '#fff');
    if (shadow === bodyShadow) return '';
    return shadow ? `text-shadow: ${shadow};` : 'text-shadow: none;';
  };

  /**
   * 本文の下に敷く帯。**body に敷くと版面ぶんだけが塗られ、余白には絵が残る**
   * (実測: 文庫で紙 108.3×154.5mm に対し、塗られたのは四方 12.7〜18.7mm を除いた内側だけ。
   *  ノド・小口が入れ替わる :verso でも版面に追随した)。
   * 表紙のあらすじ帯と同じで、派手な絵を余白で見せたまま本文を読ませられる。
   *
   * section に敷いてはいけない。section のボックスは中身の量で決まるので、
   * 章の終わりのページでは文字のあるところまでしか塗られない
   * (実測: 短い章の最終ページで版面 82mm 中 5mm しか塗られなかった)
   */
  const plateAlpha = Math.min(1, Math.max(0, s.textPlate ?? 0));
  const bodyPlate =
    plateAlpha > 0 ? withAlpha(ink(s.textPlateColor) ?? '#fff', plateAlpha) : 'transparent';

  // ノンブル・柱は余白に置くが、そこも背景画像の上なのでフチは同じように要る。
  // 書体は選べる。既定はノンブルが欧文セリフ(数字だけなので本文に揃えなくてよい)、
  // 柱がゴシック(本文と同じだと地の文の続きに見える)
  const nombreFamily = s.nombreFont
    ? (BODY_FONTS[s.nombreFont]?.stack ?? BODY_FONTS.serif.stack)
    : 'Georgia, "Times New Roman", serif';
  const headFamily = s.runningHeadFont ? (BODY_FONTS[s.runningHeadFont]?.stack ?? BODY_FONTS.serif.stack) : GOTHIC;
  const edgeOf = (slot: MarginSlot) => (slot.startsWith('top') ? 'top' : 'bottom') as 'top' | 'bottom';
  /**
   * **数字の高さをそろえる(lining-nums)。**(2026-10-10 KDP の校正紙・ユーザー「背景のあるページだけ十の位が小さい」)
   * Georgia の数字は不揃い数字で、0・1・2 だけが小さい(3〜9 は下か上へはみ出す)。
   * 「17」「23」「30」は大小が混ざり、「12」「33」は混ざらないので、書体が替わったように見えた
   * (背景の有る章の番号が、たまたま混ざる組だった)。Georgia は lnum を持っているので、そろった数字に切り替える。
   * 和文の書体の数字はもとからそろっているので、選んだ書体では何も変わらない
   */
  const nombreStyle = (edge: 'top' | 'bottom') => `
      writing-mode: horizontal-tb;${anchorFor(edge, s.fontPt * 0.85 * PT_TO_MM, s.nombreFont ? K_CJK : K_GEORGIA)}${textOutline}
      font-family: ${nombreFamily};
      font-variant-numeric: lining-nums;
      font-size: ${pt(s.fontPt * 0.85)};
      color: ${ink(s.textColor) ?? '#000'};`;
  /**
   * 柱。ノンブルと**字の下端**をそろえる(HEAD_INK_DROP ぶん持ち上げる)。
   *
   * **Chrome の約物の詰め(text-spacing-trim)と和欧間の空き(text-autospace)を切る。**(2026-10-12 修正リスト 11)
   * 柱に「、」「。」や英字が入るだけで、柱のベースラインが 0.20mm 天の側へ跳ねた(文庫・縦組みで実測。
   * 「祖母と青い本」は跳ねず、「祖母と青い本、あの家」「祖母とABC」「、祖母と青い」は跳ねる。半角の空白では跳ねない)。
   * 行の箱を点にした line-height: 0 の置き方が、この処理の入った行で崩れるとみられる。2つとも切ると、
   * 3つとも跳ねなかった(どちらか片方だけで足りるかは試していない)。柱は1行の短い文なので、詰めない組みで困らない
   */
  const headStyle = (edge: 'top' | 'bottom') => `
    writing-mode: horizontal-tb;${anchorFor(edge, s.fontPt * 0.75 * PT_TO_MM, K_CJK, HEAD_INK_DROP * s.fontPt * 0.75 * PT_TO_MM)}${textOutline}
    font-family: ${headFamily};
    font-size: ${pt(s.fontPt * 0.75)};
    text-spacing-trim: space-all;
    text-autospace: no-autospace;
    color: #444;`;

  /**
   * そのページのノンブルと柱を組む。**同じ枠を取り合ったら柱を譲る。**
   * ページ番号は本の索引に使う実用の情報で、柱は読む助けなので、優先はノンブル
   */
  /** そのページで実際に使う枠の名前(章ごとのフチを上書きするのに要る) */
  const marginBoxNames = (recto: boolean): string[] => {
    const nb = boxOf(nombreSlot, recto);
    const hb = headOn(recto) ? boxOf(headSlot, recto) : null;
    return [nb, hb && hb !== nb ? hb : null].filter((x): x is string => !!x);
  };

  const marginBoxes = (recto: boolean) => {
    const nb = boxOf(nombreSlot, recto);
    const hb = headOn(recto) ? boxOf(headSlot, recto) : null;
    const out: string[] = [];
    if (nb) out.push(`  ${nb} {\n    content: counter(page);${nombreStyle(edgeOf(nombreSlot))}\n  }`);
    if (hb && hb !== nb) {
      out.push(
        `  ${hb} {` +
          `\n    /* 柱: 章題 */` +
          `\n    content: ${headContent};${headStyle(edgeOf(headSlot))}` +
          `\n  }`,
      );
    }
    return out.join('\n');
  };

  /**
   * 扉・奥付・白ページで刷らないための打ち消し。
   * **置き場所が動くので、天地の6枠すべてを消す。** 地だけ消していたころは、
   * ノンブルを天に置いた瞬間に扉へページ番号が出てしまう
   */
  const noBoxes = ['top', 'bottom']
    .flatMap((edge) => ['left', 'center', 'right'].map((x) => `  @${edge}-${x} { content: none; }`))
    .join('\n');

  /**
   * 背景画像。上から白を重ねて薄くする(濃さ 0〜1)。
   * 画像そのものを加工せずに済むので、表紙用の画像パックをそのまま流用できる。
   * 塗り足し込みの用紙全面に敷くため、断裁されても白フチが出ない。
   * レイヤーの式は bgImageValue(モジュール先頭)に1本化 — 塗りパッチと共用。
   *
   * 紙の白を `background-color` で置いてはいけない。Vivliostyle は @page の
   * background-color を background-image より手前のボックスに乗せるため、
   * 白が画像を覆って**プレビューだけ真っ白**になる(PDFには出るので気づきにくい。実測で確認)。
   * 白も画像レイヤーの最下段として重ねることで、同じボックスに正しく積む。
   */
  const bgLayer = (src: string | undefined, opacity: number) => {
    // 白黒の本では背景もグレーで刷られる。@page の背景に filter は掛けられないので、
    // 下に敷いた白と luminosity で合成して色を落とす(明るさだけを採る = グレースケール)
    const blendVal = bgBlendValue(mono, src);
    const blend = blendVal !== 'normal' ? `
  background-blend-mode: ${blendVal};` : '';
    return `
  background-image: ${bgImageValue(src, opacity)};${blend}
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;`;
  };

  // ---- 区切り線の寸法 ----
  //
  // **線の向きは組み方向で入れ替える。** 縦組みは行が右から左へ進むので、
  // 切れ目は行に沿って立つ短い縦線になる。横に引くと行を横切ってしまい、
  // 段組みでは隣の段までまたいで見える。width/height と border の辺を入れ替えるだけでよい。
  const hrLen = s.fontPt * 6; // 線の長さ(6字ぶん)
  // 太さは本文の 1/20(文庫9ptで 0.45pt = 0.159mm)。**段間の罫線とは別もの。**
  // 段間の罫線は表罫(0.1mm)の重さまで落としたが(COLUMN_RULE_INK)、こちらは場面の切れ目を
  // 示す飾りで、6字ぶんしかない短い線だから、消え入りそうにすると役目を果たさない。
  const hrWeight = Math.max(0.3, s.fontPt / 20);
  // 前後のアキ。線の太さを込みで**ちょうど2行**を占める値にする(行のグリッドをずらさない)。
  // 下のとおり太さは箱の寸法で作る(border ではない)ので、使用値が指定どおりに出る。
  // hrGap*2 + hrWeight = feed*2 がそのまま成り立つ
  const hrGap = (feed * 2 - hrWeight) / 2;
  // 縦組みで線を天地の中央に置くための位置。**margin auto は使えない** —
  // Vivliostyle のページ内では section が版面のサイズを持たないため
  // (大扉の titleCenterOffset と同じ事情)。行に沿った版面の実寸から直に出す。
  // 縦組みの printH は「1行に入る字数 × 文字サイズ」= 天地の実寸(段組みなら1段ぶん)
  const hrOffset = (printH - hrLen) / 2;

  // @page の中のコメントも出力に入る。**KDP の形(天・地・小口が 3.2mm でノド側なし)は従来の文のまま**
  // (KDP の本の組版HTMLを1字も変えない検査のため)。それ以外は4辺の数字をそのまま言う
  const paperComment =
    bleed.top === bleed.bottom && bleed.top === bleed.fore && bleed.gutter === 0 && bleed.top === BLEED_MM
      ? `用紙 = 仕上がり + 塗り足し(小口 +${bleed.fore}mm / 天地 各 +${bleed.top}mm)。KDP には「裁ち落としあり」で入稿する`
      : `用紙 = 仕上がり + 塗り足し(天 +${bleed.top}mm / 地 +${bleed.bottom}mm / 小口 +${bleed.fore}mm / ノド +${bleed.gutter}mm)`;

  return `
@page {
  /* ${paperComment} */
  size: ${mm(l.paperW)} ${mm(l.paperH)};
  margin: ${mm(topM)} ${mm(gutterM)} ${mm(bottomM)} ${mm(foreM)};${bgLayer(s.bodyBg, s.bgOpacity)}
}
@page :recto {
  ${rectoLR}
${marginBoxes(true)}
}
@page :verso {
  ${versoLR}
${marginBoxes(false)}
}
/* 扉・奥付・白ページにはノンブル・柱を刷らない(隠しノンブル、rules §7) */
@page :first {${noBoxes}
}
@page :blank {${noBoxes}
}
@page plain {${noBoxes}
}
/* 目次・奥付・大扉は面ごとに絵と濃さを持てる。指定が無ければ本文と同じ絵になり、
   「無地」を選んだときは紙の白だけを敷き直してベースの絵を打ち消す */
@page toc {${noBoxes}${(() => {
    const r = resolveBg(s.tocBg, s);
    return bgLayer(r.src, r.opacity);
  })()}
}
@page colophon {${noBoxes}${(() => {
    const r = resolveBg(s.colophonBg, s);
    return bgLayer(r.src, r.opacity);
  })()}
}
/* 大扉。枠ものの背景を敷いたとき文字が枠の中で偏らないよう、左右の余白を揃える。
   :recto/:verso より詳細度を上げないとノド・小口の指定に負ける */
@page titlepage {${noBoxes}${(() => {
    const r = resolveBg(s.titleBg, s);
    return bgLayer(r.src, r.opacity);
  })()}
}
@page titlepage:recto, titlepage:verso {
  margin-left: ${mm(titleM)};
  margin-right: ${mm(titleM)};
}
/* 全面画像のページ。用紙いっぱいに画像を敷くので余白も背景も持たない */
@page fullbleed {${noBoxes}
  margin: 0;
  background-image: ${PAPER};
}
/* 挿絵ページ。余白ありの絵のときは本文の背景がまわりに出てほしいので背景は消さない */
@page plate {${noBoxes}
  margin: 0;
}${plateGutterWide ? plateGutterPages('platewide', plateGutterWide.ins) : ''}${plateGutterNarrow ? plateGutterPages('platenarrow', plateGutterNarrow.ins) : ''}
/* 版面いっぱいの挿絵ページ。**余白は本文と同じまま**(ノド・小口の入れ替わりも @page :recto/:verso から
   そのまま継ぐ。コラムページと同じ作り)。絵の中の文字が余白に出ないための大きさなので、
   余白を 0 にする plate とは別のページにする。ノンブル・柱は他の挿絵ページにそろえて刷らない */
@page printplate {${noBoxes}
}
/* コラムページ。ノンブルと柱の扱いは**挿絵ページにそろえる**(どちらも刷らない)。
   ページ番号そのものは進むので、続く本文のノンブルはずれない(隠しノンブル、rules §7)。
   余白は本文と同じままにする — 中身が文字なので、版面の外へ寄ると読めない
   (挿絵ページの margin:0 は絵を紙いっぱいに敷くための指定で、ここでは要らない) */
@page colpage {${noBoxes}
}
${
  /**
   * コラムページごとの背景。**章ごとの背景とまったく同じ作り。**
   * 指定のあるページだけ、そのページ専用の @page を作る
   * (ページ名にハイフンや数字始まりを使うと Vivliostyle が拾わないので colbg0 の形)。
   * フチは中身(section)に当てる。ノンブル・柱は出さないので余白の枠は要らない
   */
  (s.columnPages ?? [])
    .map((c, i) => {
      if (!hasOwnBg(c.bg)) return '';
      const r = resolveBg(c.bg, s);
      const decl = outlineDecl(r);
      return (
        `@page colbg${i} {${noBoxes}${bgLayer(r.src, r.opacity)}\n}` +
        `\nsection.colpage.colbg${i} { page: colbg${i};${decl ? ` ${decl}` : ''} }`
      );
    })
    .filter(Boolean)
    .join('\n')
}
${
  // 大扉・目次・奥付のフチ。これらはノンブル・柱を出さない(noBoxes)ので、中身だけでよい
  (
    [
      ['section.titlepage', s.titleBg],
      ['section.toc', s.tocBg],
      ['section.colophon', s.colophonBg],
    ] as const
  )
    .map(([sel, spec]) => {
      const decl = outlineDecl(resolveBg(spec, s));
      return decl ? `${sel} { ${decl} }` : '';
    })
    .filter(Boolean)
    .join('\n')
}
${
  Object.entries(s.chapterFont ?? {})
    .filter(([i, f]) => f && chapterHasOverride(Number(i)))
    .map(
      ([i, f]) =>
        `section.chmix${i} { font-family: ${(BODY_FONTS[f]?.stack ?? BODY_FONTS.serif.stack)}; font-weight: 400; }\n` +
        `section.chmix${i} .tcy { font-family: ${tcyStack(f)}; }`,
    )
    .join('\n')
}
${
  /**
   * 章ごとの文字サイズ・行送り・段の数。
   *
   * **版面の行グリッドからは外れる。** 字数×行数は本全体の値で決まっていて、
   * @page の余白も1つなので、サイズを変えた章は同じ四角の中を違う大きさの行で流れる。
   * コラムや資料編のような「別ものの章」を想定した機能。
   *
   * **セレクタは section.chapter.chmixN。** クラス1個だけの section.chmixN では
   * 段組みを書いている section.chapter と重みが並び、後に出てくる方(= section.chapter)が
   * 勝ってしまう。2クラスにして順番に関係なく上書きする
   *
   * 章題(header.chapter-title)と小見出し(h3)は本全体の pt で書いてあるので、
   * サイズを変えた章でも見出しの大きさは揃ったままになる(本としてはその方がよい)
   */
  Array.from(
    new Set([
      ...Object.keys(s.chapterFontPt ?? {}),
      ...Object.keys(s.chapterLineFeedPt ?? {}),
      ...Object.keys(s.chapterColumns ?? {}),
    ]),
  )
    .map((k) => {
      const i = Number(k);
      const fp = (s.chapterFontPt ?? {})[i];
      const lf = (s.chapterLineFeedPt ?? {})[i];
      // 段数はその判型・組み方向の上限に収める(2026-09-25 見直し S2-10: 横組みにしても、章ごとに
      // 2段にした章が2段のまま組まれ、しかも横組みでは段数の欄が出ないので直せなかった)。
      // 値そのものは残す(縦組みへ戻せば、その章はまた2段になる)
      const rawCol = (s.chapterColumns ?? {})[i];
      const col = rawCol ? Math.min(rawCol, maxColumns(s.trim, s.writingMode)) : rawCol;
      if (!fp && !lf && !col) return '';
      // 行送りの指定が無い章は、本全体と同じ「文字に対する行送りの比」を保つ
      const feedHere = lf ?? (fp ? fp * (feed / s.fontPt) : feed);
      const decls = [
        fp ? `font-size: ${pt(fp)};` : '',
        lf || fp ? `line-height: ${pt(feedHere)};` : '',
        col ? `column-count: ${col};` : '',
        // 段間はその章の行送りで引き直す。本全体の値を使うと、文字の小さい章で段間だけ広く見える
        col && col > 1 ? `column-gap: ${pt(feedHere * s.columnGapLines)};` : '',
        // 1段の本の中に段組みの章を作るときは、column-fill と罫線もここで足す
        col && col > 1 ? 'column-fill: auto;' : '',
        // 罫は 1px より細くできないので、濃さで表罫にそろえる(COLUMN_RULE_INK)。
        // 字の大きさには連動させない — 表罫は活字の時代から絶対寸法で決まっている
        col && col > 1 && s.columnRule
          ? `column-rule: 1px solid ${withAlpha(ink(s.textColor) ?? '#000', COLUMN_RULE_INK)};`
          : '',
        // 行送り比が変わる章は、ルビ・傍点の行間側の寄せも置き直す(上の rt を参照)
        fp || lf ? `--anno-shift: ${annoShift(fp ?? s.fontPt, feedHere)};` : '',
      ].filter(Boolean);
      return `section.chapter.chmix${i} {\n  ${decls.join('\n  ')}\n}`;
    })
    .filter(Boolean)
    .join('\n')
}
${
  // 章ごとの背景。指定のある章だけ、その章専用のページを作る。
  // ページ名にハイフンや数字始まりを使うと Vivliostyle が拾わないので chapbg0 の形にする。
  // page はインラインstyleでは効かないため、クラスに当てる。
  //
  // 濃さとフチも章ごとに持てる。明るい絵と暗い絵が混ざったとき、
  // 全体で1つの濃さしか持てないと必ずどちらかで本文が読めなくなるため。
  // フチはページの中身(section)だけでなく、余白に出るノンブル・柱にも要る。
  // マージンボックスは @page :recto / :verso に定義されているので、
  // 名前付きページ側も :recto / :verso まで書いて詳細度を上げないと勝てない
  Object.entries(s.chapterBg ?? {})
    .filter(([, spec]) => hasOwnBg(spec))
    .map(([i, spec]) => {
      const r = resolveBg(spec, s);
      const decl = outlineDecl(r);
      return (
        `@page chapbg${i} {${bgLayer(r.src, r.opacity)}\n}\n` +
        // 置き場所が動くので、枠の名前は決め打ちにできない(marginBoxNames を使う)
        (decl
          ? `@page chapbg${i}:recto {\n${marginBoxNames(true)
              .map((n) => `  ${n} { ${decl} }`)
              .join('\n')}\n}\n` +
            `@page chapbg${i}:verso {\n${marginBoxNames(false)
              .map((n) => `  ${n} { ${decl} }`)
              .join('\n')}\n}\n`
          : '') +
        `section.chapbg${i} { page: chapbg${i};${decl ? ` ${decl}` : ''} }`
      );
    })
    .join('\n')
}
${
  /*
   * 章ごとの帯(本文の下の色地)は、ここ(section)には塗らない。(2026-10-09 全体確認)
   * section に当てても、ページの箱に塗られた本全体の帯を消せない(「なし」が効かず、ほかの値は二重に塗られる)。
   * ページの箱ごと差し替える platePageRules を、印刷の直前(print.ts)と下見(paint.ts)で足す
   */
  ''
}
${
  // 章ごとの色。章の背景を変えると絵の明暗が章ごとに変わるので、字の色も追随できる必要がある。
  //
  // 本文は section に当てるだけでよいが、**章見出しは詳細度で勝たないといけない**。
  // 全体の見出し色 `header.chapter-title { color }` は (0,1,1)、
  // `section.chcolN header.chapter-title` は (0,2,1) なので、章ごとの指定が勝つ。
  // 本文だけ指定した章では、全体の見出し色がそのまま効く(章の色に飲まれない)
  [
    ...new Set([
      ...Object.keys(s.chapterTextColor ?? {}),
      ...Object.keys(s.chapterHeadingColor ?? {}),
      ...Object.keys(s.chapterSubheadingColor ?? {}),
    ]),
  ]
    .map((i) => {
      const body = (s.chapterTextColor ?? {})[Number(i)];
      const head = (s.chapterHeadingColor ?? {})[Number(i)];
      const sub = (s.chapterSubheadingColor ?? {})[Number(i)];
      return [
        body ? `section.chcol${i} { color: ${ink(body)}; }` : '',
        head ? `section.chcol${i} header.chapter-title { color: ${ink(head)}; }` : '',
        sub ? `section.chcol${i} h3 { color: ${ink(sub)}; }` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n')
}

body {
  ${vertical ? 'writing-mode: vertical-rl;' : ''}
  margin: 0;
  color: ${ink(s.textColor) ?? '#000'};
  /* 紙の色は @page が持つ。ここで色を塗ると版面だけ塗られる(実測で確認)。
     それを逆手に取ったのが帯。帯なしのときは transparent のまま */
  background: ${bodyPlate};
  font-family: ${bodyFont};
  font-size: ${pt(s.fontPt)};
  line-height: ${pt(feed)};
  font-weight: 400;
  text-align: justify;
  hanging-punctuation: allow-end;${textOutline}
}
p {
  margin: 0;
  text-indent: 1em;
  line-break: strict;
  word-break: normal;
  overflow-wrap: break-word;
  /* **段末・段頭の1行を許す。**(2026-09-14 ユーザー報告・2段組p22で実測)
     欧文の既定(orphans/widows=2)のまま段を割ると、段の残りが2行未満のとき
     7行の段落が丸ごと次の段へ送られ、上の段が2行分空いたまま終わる
     (実測: 上段14行+空き2行、下段頭に「紙は思いのほか…」の7行が全部落ちた)。
     和書の組版は行グリッドが主で、段末の1行送り・段頭の1行残しはふつうに許される。
     行を最後まで詰めるほうを取る */
  orphans: 1;
  widows: 1;
}
${mono ? `/* 白黒で刷る本。挿絵も図版もグレーで出るので、画面とPDFもそのとおりにする。
   **ブラウザで組むときは、絵を灰色の写しに差し替えてある**(gray-copy。models/printColor.ts)。filter を掛けると
   Chrome が PDF で 300dpi に描き直すので、写しには掛けない(2026-10-12 1.1.0。修正リストの 4-1)。
   写しが無いとき(node の検査・写しを作れなかった絵)だけ、前と同じ filter でグレーにする */
img:not(.gray-copy) { filter: grayscale(1); }
` : ''}p.no-indent { text-indent: 0; }
/* 挿絵を段落の途中に挟むと段落が2つに割れる。
   前半の最後の行に text-align-last: justify を掛けてはいけない。
   割る位置は組む前の見積もりなので、行がぴったり埋まらないことがあり、
   そのとき字間が伸びて壊れて見える(実機で発生)。行末が少し空くほうが害が小さい */
p.line-space { text-indent: 0; }
/* 行末寄せ(あとがき・前書きの署名と日付。原稿の >> の行)。
   **物理の左右で書かない。** 「行末」は組み方向で変わる — 縦組みなら地(下)、
   横組みなら右。text-align の right も end も行の向きで決まる論理値なので、
   1つ書けば両方に効く(縦組みでの right は「行の終わり側」= 地)。
   2つ並べてあるのは、論理値 end を知らない古いエンジンに right で受け止めさせるため。
   字下げは外す — 署名は段落の書き出しではない。

   実測(サンプル「青い背表紙」あとがき末尾の署名「雨宿 文」・文庫9pt。
   CLI で PDF 化して字の位置を測ったもの。版面は縦組み38字×15行):

   | | 縦組み(P38) | 横組み(P36) |
   |---|---|---|
   | 直す前 | 版面の天から 1字下げの位置に頭。地まで 107.2mm 空き | 同じく行頭 |
   | 直したあと | 署名の末尾が版面の地から **0.055mm** | 版面の右端から **0.007mm** |

   生プレビューの DOM でも裏を取った(縦組み): 段落の箱の地 635.2158px に対して
   字の並びの地が 635.2158px。**差 0.00002px** で、行末に着いている。
   この数字は scripts/check-typeset.py が毎回出すので、疑ったら回すこと */
p.align-end {
  text-indent: 0;
  text-align: right;
  text-align: end;
}
/* 縦中横。**数字・！？は詰め数字フォント(amayadori-tcy-〜)で出す。**
   2桁の自然幅が 1.1em を超える書体(Noto Serif JP など大半)では Chromium が横圧縮するが、
   その経路で新しい Chrome の縦中横が右上へずれた(2026-09-14 ユーザー報告「21はOKで22はNG」。
   21は1.03emで素通し、22は1.12emで圧縮 — 経路の違いと一致)。あらかじめ 0.5em に詰めた字なら
   どの組も素通しになる。作り方は scripts/build-tcy-fonts.py */
.tcy { text-combine-upright: all; font-family: ${tcyStack(s.bodyFont)}; }
/* ---- ルビ ----
   **注釈は行の外に浮かせる。**(2026-09-14 ユーザー報告「1行抜け」の根治)

   ブラウザ標準のルビ組み(display: ruby)は、注釈のぶんだけ**その行の行箱を太らせる**
   (実測: 行送り52.4pxの本文で、ルビ行だけ61px。line-height をどう指定しても抑えられない)。
   太った行が積もると、行グリッドがページ・段の器と合わなくなり、
   段末・ページ末で最後の1行が入りきらず**1行分の空きを残して次へ送られる**
   (2段組のp21・p27などで実測。1段でも起きるが、段組みだと器が半分になるぶん目立つ)。

   そこで注釈(rt)を absolute で行の流れから外し、親文字の**行間側に浮かせて**描く。
   紙の組版と同じ考え方 — ルビは行間に置くもので、行を太らせるものではない。
   行送りが本文の1.6倍前後あれば、0.5emの注釈は行間(約0.6em)に収まる。

   - ruby は display: inline に落とす(ruby のままだと Chromium が position を無視し、
     注釈が別の場所へ飛ぶ。実測)。基準箱は inline のまま = 行を乱さない
   - 位置は物理プロパティで書く。縦組み: 親文字の右(行間側)・天地は親文字の中央。
     横組み: 親文字の上・左右は中央。論理プロパティ(inset-block-start 等)は
     縦組みの abspos で解釈が揺れた(実測)ので使わない
   - **寄せる先は字面の中心(50%)+半角(注釈の字での1em)。端(100%)を基準にしない** —
     インラインの内容ボックスの厚みはフォントの縦メトリクスで決まり、1emとは限らない
     (実測: Noto Serif JP・しっぽり明朝は1.47em。端基準だと注釈が字面から0.23em離れ、
     2026-09-14 ユーザー報告「ルビがかなり離れた」になる。源暎こぶりは1.00emでぴったり)。
     字面はボックスの中心に据わるので、中心基準ならどの書体でも肩に付く
   - ページ・段の1行目では注釈が余白側へ出るが、これは紙の本でも同じふるまい

   **傍点(圏点)も同じ理屈で行間に浮かせる。** text-emphasis を使わないのは、
   Chromium がルビと同様に**マークのぶん行箱を太らせる**から(実測: 行送り52.4pxの本文で
   傍点の行だけ66.4px。ルビを直しても第一章に1行抜けが残っていた原因)。
   text.ts が《《〜》》を**1字ずつ** <span class="boten"> に割るので、
   ここは各字の ::after にゴマ点を1つ置くだけでよい(EPUB は今までどおり
   .boten への text-emphasis で打つ。リーダーの組版は行送りに余裕があるので太っても困らない) */
ruby { display: inline; white-space: nowrap; }
.boten { white-space: nowrap; }
.boten::after { content: '﹅'; }
ruby rt, .boten::after {
  /* **絶対配置は使わない。大きさ0のインラインブロックを行の中に置き、相対配置で動かす。**
     絶対配置(position: absolute)だと、2段組の**下段**にあるルビの注釈が Chromium の
     多段組の断片化に巻き込まれて2つに割れ、本体が親文字側へ4pxほど寄る
     (2026-09-14 ユーザー報告「掠《か》だけ漢字にへばりつく」。上段の見返《みかえ》や
     1段の章では起きない。実DOMで rt.getClientRects() が2つ返るのを確認)。
     大きさ0(width/height: 0)の箱は行の中で場所を取らず、行箱も太らせない
     (実測: 行数・行送りとも変化なし)。中身の注釈はその箱からはみ出して描かれる。
     箱の位置: 行の「上側」(vertical-align: top = 縦組みでは右、横組みでは上)、
     文字送り方向では親文字の直後。そこから
       - 文字送り方向: 親文字の中央に据えるぶん戻す(--off。text.ts が字数から計算する)
       - 行間方向: 行の端から字面の肩まで = 1 − 行送り比/2 (+わずかな間)。**行送り比は
         見出し・奥付・コラムなどで本文と違う**ので、--anno-shift をその文脈に置く
         (置き忘れると注釈が本文の上に乗る。2026-09-14 ユーザー報告「P5 章見出しのルビが本文に被る」)
     長すぎる読みは text.ts が --k(拡大率)を付けてくる。**縮めるのは transform で**、
     font-size を変えない — em の大きさが変わると --off も --anno-shift も一緒に狂うため。
     縮む向きは親文字に接する角から(transform-origin)
     ruby と .boten は nowrap にして、親文字と注釈の間で行が折れないようにする */
  display: inline-block;
  width: 0;
  height: 0;
  overflow: visible;
  vertical-align: top;
  position: relative;
  font-size: 0.5em;
  line-height: 1;
  white-space: nowrap;
  transform: scale(var(--k, 1));
  ${vertical
    ? `top: calc(var(--off, 1.5) * -1em);
  left: calc(var(--anno-shift, ${annoShift(s.fontPt, feed)}) * 1em);
  transform-origin: left top;`
    : `left: calc(var(--off, 1.5) * -1em);
  top: calc(var(--anno-shift, ${annoShift(s.fontPt, feed)}) * -1em);
  transform-origin: left bottom;`}
}
/* コラムページは本文と組み方向を違えられる(.wm-h/.wm-v)。注釈もそのページの向きに従える */
section.colpage.wm-v rt, section.colpage.wm-v .boten::after {
  top: calc(var(--off, 1.5) * -1em);
  left: calc(var(--anno-shift, ${annoShift(s.fontPt, feed)}) * 1em);
  transform-origin: left top;
}
section.colpage.wm-h rt, section.colpage.wm-h .boten::after {
  left: calc(var(--off, 1.5) * -1em);
  top: calc(var(--anno-shift, ${annoShift(s.fontPt, feed)}) * -1em);
  transform-origin: left bottom;
}
/* ---- 文脈ごとの行送り比 ----
   ルビ・傍点の行間側の寄せは「1 − 行送り比/2」で決まる(上の rt を参照)。
   **本文と違う 文字サイズ:行送り を持つところは、ここで比を置き直す。**
   置き忘れると、その見出しのルビが本文の上に乗る。**比が本文と同じところは書かない**
   (大扉の書名は 2倍/2倍、小見出しは等倍なので、どちらも本文の値のままでよい) */
header.chapter-title .ct { --anno-shift: ${annoShift(s.fontPt * 1.6, feed * 1.55)}; }
.toc h1 { --anno-shift: ${annoShift(s.fontPt * 1.4, feed * 2)}; }
figure.fig figcaption { --anno-shift: ${annoShift(s.fontPt * 0.85, feed)}; }
section.colpage > h2 { --anno-shift: ${annoShift(s.fontPt * COLPAGE_TITLE_SIZE, feed * COLPAGE_TITLE_LINE)}; }
.colophon-box, .profile-box { --anno-shift: ${annoShift(s.fontPt * 0.9, feed)}; }
.colophon-box h1 { --anno-shift: ${annoShift(s.fontPt * 1.2, feed * 1.2)}; }
/* 太字はその書体が持っているウェイトを使う。持っていない値を書くと
   ブラウザが合成太字を作り、字面が潰れる(源暎こぶり明朝など1ウェイトの書体) */
em { font-style: normal; font-weight: ${font.bold}; }
/* 斜体・下線・取り消し線。**和文書体は斜体を持たないことが多く、**
   その場合ブラウザが合成する(字が傾くだけで書としては崩れる)。
   縦組みでは特に読みにくいので、使いどころは利用者に委ねる */
i { font-style: italic; }
/**
 * 下線。**縦組みでは文字の右に引く。**
 *
 * 既定(auto)は「下」に引くが、縦組みの「下」は**左側**。和文の傍線は右側に引くので、
 * そのままだと逆になる(実測で確認)。text-underline-position: right が
 * まさにこのための値で、載っているエンジンも対応している(CSS.supports で確認)
 *
 * ### アキが縦と横で倍ちがった(2026-08-20 実測・修正)
 *
 * > 下線を見ました。**ちょっと離れているのが気になる。もう少し寄せられないか**
 * > (2026-08-20 ユーザー。文庫・縦組みの画面)
 *
 * **同じ 0.2em でも、縦と横では基準の線が違う**ので離れ方が倍ちがっていた:
 *
 * - **縦(position: right)** … 基準は**仮想ボディの右端**。offset がそのままアキになる
 * - **横(position: auto)** … 基準は書体が持つ下線位置で、実測すると
 *   **仮想ボディの下端より 0.11em 上**(欧文のベースライン寄り)。
 *   そこから 0.2em 下ろすので、仮想ボディからは 0.09em しか離れない
 *
 * つまり縦は横の**倍以上**離れていた。縦を 0.1em に詰めて横(0.09em)とそろえる。
 * **横は触らない** — もともと詰まって見えない側なので、動かす理由がない。
 *
 * **詰めすぎて字に触れてはいけない。** 和文の傍線は字面から浮かせるもの。
 * 同梱書体の字面を canvas の actualBoundingBox で実測すると、いちばん張り出す
 * 「◯」でも仮想ボディの内側 0.0156em で止まる(明朝)。0.1em ならアキは
 * 最悪でも 0.116em = 文庫9ptで **0.37mm** 残るので触れない。
 *
 * ※ここは組版CSSのテンプレート文字列の中。**バッククォートを書かないこと**(文字列が切れる)
 */
u {
  text-decoration: underline;
  text-underline-offset: ${vertical ? '0.1em' : '0.2em'};${vertical ? '\n  text-underline-position: right;' : ''}
}
/* 章の書き出しを大きく組む(ドロップキャップ)。
   **initial-letter は使わない。** 数字で始まる章は縦中横になり、
   その中の1桁だけを大きくすることになって効かなかった(2026-08-19 ユーザー報告)。
   実測でもインライン要素には効かない。いまは html.ts が先頭のひとかたまりを
   .dropcap で包み、ここは float で N 行ぶんの厚みを与えるだけ。
   **1字下げも消す。** 残すと大きな字がまるごと1字ぶん落ちる(同日 ユーザー報告)。
   会話文で始まる章では鉤括弧が大きくなるので、使うかどうかは利用者に委ねる */
${
  drop > 0
    ? `section.chapter > p:first-of-type { text-indent: 0; }
.dropcap {
  float: ${vertical ? 'inline-start' : 'left'};
  /**
   * N行ぶんの厚みにする。行送りを掛ければ隣の本文と N 行で揃う……はずが、
   * **端数の丸めで 0.01px はみ出して、次の1行まで押しのけていた**
   * (実測: 2行 = 41.33px に対して字の箱が 41.34px。2行指定なのに3行にわたる)。
   * 浮いたものは1ピクセルでも触れた行を全部よけさせるので、**1px 引いておく**。
   * 目には見えない差で、行数だけが正しくなる
   */
  font-size: calc(${pt(feed * drop)} - 1px);
  line-height: 1;
  /**
   * アキは**行の進む向きへ**取る(inline-end)。
   * 縦組みで block-end に取ると、それも行数に足されて同じはみ出しが起きる
   */
  margin-inline-end: 0.1em;
}
`
    : ''
}${
  /**
   * 章ごとの「章はじめの大文字」。
   *
   * **その章の行送りで掛ける。** 文字サイズを変えた章では行送りも変わるので、
   * 本全体の行送りで掛けると N 行ぶんに揃わない。
   * 使わない章(0)は、html.ts が .dropcap で包まない側で消える
   */
  Object.entries(s.chapterDropCap ?? {})
    .map(([k, v]) => {
      const i = Number(k);
      const d = Math.max(0, Math.min(5, Math.round(v ?? 0)));
      if (!d) return `section.chapter.chmix${i} > p:first-of-type { text-indent: 1em; }`;
      const lf = (s.chapterLineFeedPt ?? {})[i];
      const fp = (s.chapterFontPt ?? {})[i];
      const feedHere = lf ?? (fp ? fp * (feed / s.fontPt) : feed);
      return (
        `section.chapter.chmix${i} > p:first-of-type { text-indent: 0; }` +
        `\nsection.chapter.chmix${i} .dropcap {` +
        `\n  float: ${vertical ? 'inline-start' : 'left'};` +
        `\n  font-size: calc(${pt(feedHere * d)} - 1px);` +
        `\n  line-height: 1;` +
        `\n  margin-inline-end: 0.1em;` +
        `\n}`
      );
    })
    .join('\n')
}
/* 本文中のリンク。**紙では飛べないので、見た目を本文に戻す。**
   青い字や下線が刷られていると、読者は押せると思って困る(電子書籍側では下線を付ける) */
p a, h3 a { color: inherit; text-decoration: none; }
/* 取り消し線は字の中央を通るので、縦横どちらでも向きの指定は要らない */
s { text-decoration: line-through; }

/* ---- 章(見出し1): 章番号+章題ワンセット+後2行アキ = 5行取り(rules §6) ---- */
section.chapter {
  break-before: page;${
    l.columns > 1
      ? `
  /* 段組み(縦組みのみ)。段間は設定値(行数×行送り) */
  column-count: ${l.columns};
  column-gap: ${pt(l.columnGapPt)};
  /* 1段目から順に埋める。既定の balance だと章の終わりのページで
     残りの本文が全段に等分され、1段目がすかすかのまま3段に割れて読みにくい */
  column-fill: auto;${
    s.columnRule
      ? `
  /* 段間の罫線。**段間の中央に引かれる**ので、線のぶん段が細くなることはない。
     太さは 1px(engine の下限。0.265mm)で、濃さを落として表罫の重さにそろえる。
     なぜ太さで合わせられないかは COLUMN_RULE_INK を見ること */
  column-rule: 1px solid ${withAlpha(ink(s.textColor) ?? '#000', COLUMN_RULE_INK)};`
      : ''
  }`
      : ''
  }
}
section.chapter.first { break-before: recto; } /* 本文開始P1のみ奇数起こし */
header.chapter-title {
  margin: 0;${
    l.columns > 1
      ? `
  column-span: all; /* 章見出しで段をぶち抜く。段組みでないときに書くと Vivliostyle が例外を投げる */`
      : ''
  }
  ${blockSize}: ${pt(feed * 3)};
  ${marginAfter}: ${pt(feed * 2)};
  /* 天(行頭)からの起こし下げ。ブロック要素の text-indent で実現
     (margin/padding は改ページ直後だと Vivliostyle に破棄され、inline には text-indent が効かない) */
  text-indent: ${pt(feed * 1.4)};
  font-family: ${GOTHIC};
  break-after: avoid;
  break-inside: avoid;
}
header.chapter-title .chapter-no {
  margin: 0;
  text-indent: inherit;
  font-size: ${pt(s.fontPt)};
  font-weight: 500;
  letter-spacing: 0.5em;
  line-height: ${pt(feed)};
}
header.chapter-title .ct {
  margin: 0;
  text-indent: inherit;
  font-weight: 700;
  font-size: ${pt(s.fontPt * 1.6)};
  /* 行送りは本文の1.55倍。**1.35倍だと章題にルビを振ったとき章番号の行に食い込む**
     (実測: 13.6pt の字に対し行間の空きが片側2.99pt しかなく、6.8pt のルビが収まらない。
     2026-09-14 ユーザー報告「P5 ルビの位置がおかしくて本文に被る」の残り)。
     見出しの箱(3行取り)は変えていないので、刷り位置はほとんど動かない */
  line-height: ${pt(feed * 1.55)};
  /* 柱に出す章題。**content() は使えない。** ルビは <rt> も中身なので、
     文字列に読みまで混ざる(実測: 柱が「残響崩壊ざんきょうほうかい（エコーフォール）」になった。
     2026-09-14 ユーザーのキャプチャ)。読みを外した字を html.ts が data-plain に入れている */
  string-set: chapter-title attr(data-plain);
}${
    // 章見出しの色。指定が無ければ本文の色を継ぐ(章番号と章題は同じ色にする)
    s.headingColor ? `\nheader.chapter-title { color: ${ink(s.headingColor)}; }` : ''
  }

/* ---- 小見出し(見出し3): 2行取り(rules §6) ----
   行取りを ${blockSize} で固定すると、見出しが2行になったとき高さが足りず
   本文に重なる。前後のアキ(0.5行ずつ)+ 本文と同じ行送りで組み、
   1行なら2行取り・2行なら3行取りと自然に伸びるようにする */
h3 {
  margin: 0;
  ${marginBefore}: ${pt(feed * 0.5)};
  ${marginAfter}: ${pt(feed * 0.5)};
  line-height: ${pt(feed)};
  font-family: ${GOTHIC};
  font-weight: 700;
  font-size: ${pt(s.fontPt)};${s.subheadingColor ? `\n  color: ${ink(s.subheadingColor)};` : ''}
  break-after: avoid;
  break-inside: avoid;
}

/* ---- 引用(行のあたまに > と書いた行) ----
   **縦組みでは左に縦罫を入れない。** 縦罫は横組みの本の作法で、縦組みで同じことをすると
   行の進む先(左)に線が立ち、次の行や隣の段との境目にしか見えない。
   和文では「天地を1字ずつ空けて行を短くする」だけで引用と分かる。
   ${vertical ? '天地のアキ = padding-top/bottom。縦組みでは行の中の位置' : '左右のアキ = padding-left/right'} */
blockquote {
  margin: 0;${
    vertical
      ? ''
      : `
  /* 横組みは上下に1行アキ。縦組みでは本文の行の流れをそのまま使うので入れない */
  ${marginBefore}: ${pt(feed)};
  ${marginAfter}: ${pt(feed)};`
  }
  ${padLineStart}: 1em;
  ${padLineEnd}: 1em;${
    vertical
      ? `
  /* 行頭1字下げ。天地のアキとは別に、書き出しだけもう1字下がる */
  text-indent: 1em;`
      : `
  text-indent: 0;`
  }
}

/* ---- 箇条書き ----
   マーカー(・ / １．)は**字として本文の流れに置く**(HTML 側で入れている)。
   list-style を使わないのは、縦組みだとマーカーが行の外に落ちて版面から消えるうえ、
   番号が半角のまま寝てしまうため。
   2行目以降のぶら下げは text-indent の負値で作る:
   行全体を1字(番号つきは2字)下げ、1行目だけ同じぶん戻す */
ul.list, ol.list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.list li {
  ${padLineStart}: 1em;
  text-indent: -1em;
  /* 1項目が2ページに割れると、マーカーだけが前のページに残る */
  break-inside: avoid;
}
ol.list li {
  ${padLineStart}: 2em;
  text-indent: -2em;
}

/* ---- 区切り線(場面転換で「罫」を選んだときだけ出る) ----
   ${vertical
     ? '縦組み: 行に沿って立つ短い縦線。天地の中央に置く'
     : '横組み: 行を横切る短い横線。左右の中央に置く'}
   **既定はもう罫ではない**(2026-08-21。既定は1行アキ。下の p.scene-break を見ること)。
   選ばれていないときこの規則を出しても害は無いので、常に書いている —
   太さの検査(scripts/check-typeset.py の check_css)が、どの見た目を選んでいても
   罫の引きかたを見張り続けられるようにするため。
   場面転換の線は前後の段落と一組。**ページの頭・末尾に単独で来てはいけない**(2026-08-20 ユーザー報告。
   「意味不明の線」に見える)。break-before/after: avoid で前後どちらの段落にもくっつけ、
   線だけが改ページの境目に落ちないようにする。
   実測(Vivliostyle CLI で PDF 化し、hr の前後に元からある段落へ機械的に挿入した118件を検査):
   直す前は 126件中 17件が「前に本文が無いページ頭」・12件が「後ろに本文が無いページ末尾」。
   直したあとはページ頭が 0件、ページ末尾が 4件(いずれも hr の直後に元から
   場面転換の1行アキ(p.line-space)が続く、密に詰め込んだ検証用の原稿でしか
   起きない特殊な並びで、hr 単体を疎に置く実際の使い方(ユーザー報告の箇所で再現)では
   前後とも 0件)。p.line-space 自体には avoid 指定が無いので、hr の直後に
   もう一つ場面転換記法が続く原稿ではまだ起こりうる(未対応。触るなら line-space 側)

   ### ★ 線は border ではなく「箱の寸法」で引く(2026-08-20 実測・再修正)

   > P14にまだ太い線が残ってますよ。これなんでしょうね。。。(ユーザー報告)

   前の直しは**置き場所**(ページの端に落ちる)だけを直したので、線そのものは太いままだった。
   原因は COLUMN_RULE_INK の説明にある罠と同じもの — **Blink は 0 でない罫の太さを
   必ず 1画素以上に切り上げる。** 段間の罫線ではそれを突き止めて濃さで合わせたのに、
   区切り線は border-left のまま残っていた。

   実測(文庫9pt・縦組み・サンプル「青い背表紙」P14 の区切り線):

   | | 指定 | 画面(dpr 1・getComputedStyle) | 紙(CLI で PDF 化・ベクタの実寸) |
   |---|---|---|---|
   | 直す前(border) | 0.45pt | **1px = 0.75pt = 0.265mm** | 0.375pt |
   | 直したあと(箱) | 0.45pt | **0.59375px = 0.445pt = 0.157mm** | 0.4688pt |

   紙の 0.4688pt(=0.625px)は、描画の 1/8画素の升目に乗ったもの。線が紙のどこに落ちたかで
   0.375pt(0.5px)にも振れる(区切り線を38本ちらして実測)。
   **どちらも指定の 0.45pt から半升ぶん**で、1画素への切り上げとは桁が違う。

   画面の 0.265mm は表罫(0.1mm)ではなく**裏罫(0.3mm)に近い**。本文が9ptの明朝で
   刷られている中に裏罫が1本立てば、それは「太い線」に見える。ユーザーの見立ては正しかった。
   紙の 0.375pt は、印刷経路の dpr が 2 で切り上げの下限が 0.5px になっていたためで、
   **同じ指定なのに画面と紙で太さが違っていた**(前回の引き継ぎに「border は指定より
   細く引かれる」と書いてあったのは、紙だけを見て画面を見ていなかったための誤り)。

   直しかたは、段間の罫線のときに検討して**そちらでは採れなかった**手をこちらで採る。
   罫を border ではなく**箱そのものの寸法**で作れば、切り上げは起きない
   (箱の寸法は 0.375px でも通ることが段間の罫線の調査で実測済み)。
   段間の罫線でこれを採れなかったのは、罫を section の背景で描くと
   column-span: all の章見出しまで横切ってしまうからで、hr は自分ひとりの箱なので
   その問題が無い。太さの指定がそのまま出るので、画面と紙で同じ太さになり、
   hrGap の「ちょうど2行」も端数なしで成り立つ */
hr {
  border: none;
  /* 太さ = 箱の厚み。background で塗る(border では 1画素に切り上げられる) */
  background: ${ink(s.textColor) ?? '#000'};
  ${blockSize}: ${pt(hrWeight)};
  ${inlineSize}: ${pt(hrLen)};
  ${marginBefore}: ${pt(hrGap)};
  ${marginAfter}: ${pt(hrGap)};
  ${vertical ? `margin-top: ${pt(hrOffset)};` : `margin-left: auto;
  margin-right: auto;`}
  /* avoid ではなく avoid-page。avoid だと段組みで**段替わりまで妨げて**、
     収まらない「前段落+線+次段落」の塊ごと下の段へ送られ、上の段が
     埋まりきらないまま終わる(2026-09-14 ユーザー報告・2段組で多発)。
     ページの頭・末尾に線を落とさない保証(上の実測)はページ境界だけの話なので
     avoid-page で足りる */
  break-before: avoid-page;
  break-after: avoid-page;
  break-inside: avoid;
}

/* ---- 場面転換を字で組むとき(1行アキ / ＊ / ＊　＊　＊) ----

   > 1段組みだと、「これは何の線だあ？」となるデザインですね。
   > もうちょっと不自然さを減らせないだろうか(2026-08-21 ユーザー・P14)

   **一般文芸・純文学の商業出版は「1行アキだけ」が主流。** 記号すら置かない。
   記号を使うなら「＊」「◇」「※」を行の中央に1つか3つ。
   ハイフンを並べた罫(-----)はネット小説・ライトノベル寄りの記法だった
   (models/project.ts の SceneBreakId)。既定を 1行アキ に変え、罫は選べば出る。

   **どの見た目も行のグリッドを崩さない。**
   - 1行アキ … margin なしの1行(p.line-space と同じ作り)。**ちょうど1行**
   - ＊     … 前後に半行ずつ。字の1行と合わせて**ちょうど2行**(罫と同じ量)

   **前後の段落から切り離さない。** 罫と同じく break-before/after: avoid を掛ける。
   1行アキはとくに効く — ページの頭や末尾に落ちた空白は**目に見えない**ので、
   場面が変わったこと自体が読者に届かなくなる(罫なら「線が浮いている」と気づけるが、
   アキは気づきようがない)。前後どちらにも本文がある位置にしか置かせない。

   **画面にだけ見えるしるしは足さない。** 下見で「ここが場面転換」と出して
   紙に出ないのは嘘になる。紙で見えないものは画面でも見えないままにする */
p.scene-break {
  text-indent: 0;
  /* hr と同じ理由で avoid-page(段替わりは許す。2026-09-14) */
  break-before: avoid-page;
  break-after: avoid-page;
  break-inside: avoid;
}
/* 1行アキ。中身は全角空白。**空の p にしてはいけない** —
   高さを持たず、1行ぶんのアキにならない(p.line-space が全角空白を置いているのと同じ理由) */
p.scene-break.blank {
  ${marginBefore}: 0;
  ${marginAfter}: 0;
}
/* ＊ / ＊　＊　＊。**行の進む向きの中央に置く。**
   text-align は行の向きで決まる論理値なので、1つ書けば縦組み(天地の中央)にも
   横組み(左右の中央)にも効く(p.align-end の end / right と同じ考え方)。
   body の justify を上書きする。前後のアキは半行ずつで、字の1行と足して2行 */
p.scene-break.mark {
  text-align: center;
  ${marginBefore}: ${pt(feed / 2)};
  ${marginAfter}: ${pt(feed / 2)};
}

/* ---- 大扉(rules §8) ---- */
/* 版元名は入れない(奥付に記載する)。書名を左右中央、著者名をその左下に置く */
section.titlepage {
  page: titlepage;
  break-after: page;
  /* position は指定しない: .author の absolute 配置基準をページ領域全体にするため */${titleH ? `
  /* 縦組みの本の書名を横組みにするとき(titleWritingMode)。縦組みのページに横組みの器を置くと
     幅が版面幅にならず細くなる(奥付で実測済み)ので、幅と高さを実寸で与える */
  ${titleDecls.section}` : ''}
}
.titlepage h1 {
  margin: 0;
  ${vertical && !titleH ? `margin-right: ${pt(titleCenterOffset)};` : titleH ? titleDecls.h1 : 'text-align: center;'}
  padding-top: ${pt(feed * 5)};
  ${tpFont.h1 || `font-family: ${bodyFont};
  font-weight: 700;`}
  font-size: ${pt(s.fontPt * 2)};
  line-height: ${pt(feed * 2)};
}
.titlepage .author {
  margin: 0;
  text-indent: 0;
  position: absolute;
  font-size: ${pt(s.fontPt * 1.1)};
  ${vertical && !titleH
    ? `bottom: ${pt(feed * 2)}; right: ${pt(authorOffset)};`
    : titleH
      ? titleDecls.author
      : `bottom: ${pt(feed * 3)}; left: 0; right: 0; text-align: center;`}${tpFont.author ? `
  /* 大扉だけの書体(titlepageAuthorFont。2026-10-12 希望 5) */
  ${tpFont.author}` : ''}
}${tpFont.h1Tcy ? `
.titlepage h1 .tcy { ${tpFont.h1Tcy} }` : ''}${tpFont.authorTcy ? `
.titlepage .author .tcy { ${tpFont.authorTcy} }` : ''}

/* ---- 全面画像(裁ち落とし) ----
   用紙(塗り足し込み)いっぱいに敷く。断裁位置が多少ずれても白フチが出ない。
   ノンブル・柱も出ない(@page fullbleed の noBoxes) */
div.fullbleed {
  page: fullbleed;
  break-before: page;
  break-after: page;
  margin: 0;
  text-indent: 0;
}
div.fullbleed img {
  display: block;
  width: ${mm(l.paperW)};
  height: ${mm(l.paperH)};
  object-fit: cover;
}

/* ---- 挿絵ページ(章と章の間に挟む1枚絵) ----
   div に用紙の実寸を与えているので、ここでは flex の中央寄せが効く
   (ページ領域のサイズを持たない section とは違う) */
div.plate {
  page: plate;
  break-before: page;
  break-after: page;
  margin: 0;
  text-indent: 0;
  width: ${mm(l.paperW)};
  height: ${mm(l.paperH)};
  display: flex;
  align-items: center;
  justify-content: center;${
    // 帯は body に敷いてあるが、@page plate は margin:0 なので
    // ここだけ「版面 = 紙いっぱい」になり、帯が絵のまわりを塗り潰してしまう
    // (実測で確認)。この div は紙の実寸を持つので、同じ絵を敷き直して打ち消す。
    // 帯を使っていないときは何もしない(同じ画像をPDFに二度入れないため)
    plateAlpha > 0 ? bgLayer(s.bodyBg, s.bgOpacity) : ''
  }
}
/* わざと空けた白ページ。@page plate は margin:0 でノンブルも柱も出ないので、
   中身を置かなければそのまま白い1ページになる。
   組版側でページを勝手に足すのはやめ、置いたものがそのまま出る形に統一した
   (経緯は html.ts の platesBefore) */
div.plate.blank { display: block; }
div.plate img { display: block; }
/* 全面は用紙いっぱい。縦横比が違っても中央を切り出して埋める(白フチを作らない) */
div.plate.full img {
  width: ${mm(l.paperW)};
  height: ${mm(l.paperH)};
  object-fit: cover;
}
/* 余白ありは絵を切らずに収める。
   余白は本文の版面から取らない。本文のノドが広い判型でも挿絵まで寄って見えるのを避けるため、
   仕上がり寸法に対する四方の内寸で決める(判型が変わっても見た目の比率が揃う) */
div.plate.wide img {
  max-width: ${mm(plateBoxWide.maxW)};
  max-height: ${mm(plateBoxWide.maxH)};
}
div.plate.narrow img {
  max-width: ${mm(plateBoxNarrow.maxW)};
  max-height: ${mm(plateBoxNarrow.maxH)};
}${
  // 無線綴じで決まりの入った本: ノド側だけ下限まで空ける(修正リスト 4-5)。箱の位置は @page platewide / platenarrow の左右の余白が決めるので、
  // 箱はページの版面の幅にして、その中に絵を中央寄せで置く。
  // **幅は mm で決める(auto にしない)**: 縦組み(vertical-rl)では width が行の進む向きの大きさなので、auto だと箱が絵の幅まで縮んで
  // 右(ブロックの始まり)へ寄り、縦長の絵が箱の真ん中に来ない(見直しの指摘。素の Chrome で実測)
  (plateGutterWide
    ? `
/* ノド側を下限まで空ける(無線綴じ・印刷所の決まりあり)。ページの左右の余白で箱の位置を決める */
div.plate.wide { page: platewide; width: ${mm(plateGutterWide.boxW)}; }`
    : '') +
  (plateGutterNarrow ? `
div.plate.narrow { page: platenarrow; width: ${mm(plateGutterNarrow.boxW)}; }` : '')
}
/* 版面いっぱい。箱を用紙ではなく**版面の実寸**にして、その中で中央に寄せる。
   ページは本文と同じ余白を持つ(@page printplate)ので、箱の位置はそのまま版面に重なる。
   帯の敷き直しも要らない — 版面 = 余白の内側なので、本文のページと同じに body の帯が出る */
div.plate.print {
  page: printplate;
  width: ${mm(pageAreaW)};
  height: ${mm(pageAreaH)};
  background-image: none;
}
div.plate.print img {
  max-width: ${mm(pageAreaW)};
  max-height: ${mm(pageAreaH)};
}${spreadCss}

/* ---- 本文中の画像 ---- */
figure.fig {
  /* 余白は必ず論理方向で取る。縦組みで margin-top/bottom を使うと、
     行の進む方向(=段の天地)を食って画像が段からはみ出し、柱・ノンブルに重なる
     (B5 3段で実測: 段の下端を行送り1つぶん 5.3mm 超えていた) */
  margin-block: ${pt(feed)};
  /* 回り込む本文が絵に接しないよう、地側だけ半行あける
     (そのぶん下で max-height を削ってあるので、段からはみ出さない) */
  margin-inline: 0 ${pt(feed * 0.5)};
  text-indent: 0;
  /* 画像とキャプションが別ページに割れるのを防ぐ(旧仕様名も併記) */
  break-inside: avoid;
  page-break-inside: avoid;
}${vertical && wrapFig ? `
/* 縦組みでは画像の「幅」が行の並ぶ方向。横長の絵を帯として置くと、
   高さが余っていても その幅ぶんの行が丸ごと消える
   (実原稿 B6 1段で実測: 版面幅103.9mm に対し画像104.1mm → 本文0行)。
   段の天に寄せて本文を回り込ませると、絵を縮めずに行が戻る(0行→8行、総56→55ページ)。
   横組みでは画像は天地方向を使うだけで行は減らないので、回り込ませない */
figure.fig {
  float: inline-start;
  clear: inline-start;
}` : ''}${pageFloatFig ? `
/* 1段の縦組みは、ページの天・行頭の角に寄せる(理由は上の pageFloatFig)。
   絵の前のアキは取らない。ページの頭に着くので、取ると版面の端から1行ずれる */
figure.fig {
  float-reference: page;
  margin-block-start: 0;
}` : ''}
figure.fig img {
  display: block;${vertical ? '' : `
  /* 横組みでは版面の左右中央に置く */
  margin-inline: auto;`}
  max-width: ${pt(figMaxW)};
  max-height: ${pt(figMaxH)};
}
/* キャプション付きは、キャプションが積まれる方向のサイズを1行ぶん譲る。
   縦書きではキャプションが画像の左に来るので削るのは「幅」(高さではない) */
/* **前後のアキ(margin-block 1行ずつ)のぶんも譲る。**(2026-09-25 見直し S2-3)
   キャプションの1.4行だけ譲っていたので、絵が版面いっぱいのとき「アキ＋絵＋キャプション＋アキ」が
   版面より2行ぶん広くなり、キャプションが余白へはみ出した(新書・縦でノドから 8.2mm。KDP の安全域は 9.5mm)。
   キャプションは字なので版面の中に置く。キャプションの無い絵は、はみ出るのが空のアキだけなので据え置く
   ページの天に寄せる絵(pageFloatFig)は前のアキが無いので、譲るのはキャプションと後ろのアキだけ */
figure.fig.has-cap img {
  ${vertical
    ? `max-width: ${pt(figMaxW - figCapGive(pageFloatFig))};`
    : `max-height: ${pt(printH - feed * 3.4)};`}
}${chapterFigRules}
figure.fig figcaption {
  /* 画像との間だけ空ける。縦組みではキャプションが画像の左に来るので、
     ここも論理方向で書かないと隙間が天地側に付いてしまう */
  margin: 0;
  margin-block-start: ${pt(feed * 0.4)};
  text-indent: 0;
  font-size: ${pt(s.fontPt * 0.85)};
  font-family: ${GOTHIC};
  line-height: ${pt(feed)};
  break-before: avoid;
  page-break-before: avoid;
}


/* ---- 目次(rules §8) ---- */
section.toc {
  page: toc;
  break-before: page;
  break-after: page;
}
.toc h1 {
  margin: 0;
  ${blockSize}: ${pt(feed * 2)};
  ${marginAfter}: ${pt(feed * 2)};
  font-family: ${GOTHIC};
  font-weight: 700;
  font-size: ${pt(s.fontPt * 1.4)};
  line-height: ${pt(feed * 2)};
}
.toc ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.toc li {
  ${blockSize}: ${pt(feed * 1.5)};
  break-inside: avoid;
}
.toc a {
  color: inherit;
  text-decoration: none;
}
/* 章題とノンブルをリーダーで接続(rules §8) */
.toc a::after {
  content: leader('・');
  letter-spacing: 0.25em;
}
/* ページ番号は章の id を target-counter で引く。
   a::after にまとめて入れると縦書きで数字が横倒しになるため別要素にする。
   縦中横(text-combine-upright)は3桁を1emに圧縮して字を歪ませるので使わない。
   目次は本文の行グリッドに乗せる必要がないため、横組みブロックとして
   数字本来の字幅のまま置く(3桁=1.5em でも li の行幅 1.5行分に収まる) */
.toc .pn::after {
  content: target-counter(attr(data-page), page);
  writing-mode: horizontal-tb;
  display: inline-block;
}

/* ---- コラムページ(本文と組み方向の違う1ページ) ----

   **奥付とまったく同じ作り方。** 版面の実寸を width と height の両方で与えて、
   1ページに収める。器だけに組み方向を書くと本文の組み方向を継承して伸び、
   次ページへこぼれる(奥付で実測済み)ので、組み方向は section 自身に書く。

   **@page には書けない。** Vivliostyle はページを割る軸をルートの組み方向だけで
   決めているので、@page にも section にも「改ページの向き」は足せない
   (章ごとの組み方向を実装しようとして 9083px はみ出したときの結論。
   経緯は models/project.ts の chapterSubheadingColor の下)。
   ここで組み方向が効くのは、1ページに収まる箱だからにすぎない。

   そのぶん**あふれたら紙から落ちる**。画面側で字数を先に止めている
   (typeset/grid.ts の fitColumnPage。見出しの大きさとアキはそちらと同じ値) */
section.colpage {
  page: colpage;
  break-before: page;
  break-after: page;
  width: ${mm(pageAreaW)};
  height: ${mm(pageAreaH)};
  /* 章の段組みは section.chapter にしか掛かっていないので、ここは常に1段。
     **あふれても隠さない。** overflow: hidden で切ると、書いた文が黙って消える。
     版面の外へこぼれた姿がプレビューに出るほうが、画面の警告と結びついて分かりやすい */
}
/* 横組みのコラムページ。縦組みの本の中に1ページだけ横組みを差し込む形 */
section.colpage.wm-h { writing-mode: horizontal-tb; }
/* 横組みの本に縦組みを差し込むときはこちら */
section.colpage.wm-v { writing-mode: vertical-rl; }
section.colpage > h2 {
  margin: 0;
  text-indent: 0;
  font-family: ${GOTHIC};
  font-weight: 700;
  font-size: ${pt(s.fontPt * COLPAGE_TITLE_SIZE)};
  line-height: ${pt(feed * COLPAGE_TITLE_LINE)};
}
/* 見出しと本文のアキ。**組み方向ごとに物理プロパティで書く。**
   横組みなら下、縦組みなら左が「見出しの次」になる */
section.colpage.wm-h > h2 { margin-bottom: ${pt(feed * COLPAGE_TITLE_GAP)}; }
section.colpage.wm-v > h2 { margin-left: ${pt(feed * COLPAGE_TITLE_GAP)}; }
/* 本文は本の設定をそのまま継ぐ(書体・文字サイズ・行送り)。
   1字下げも本文と同じ。会話文で始まる段落だけ html.ts が no-indent を付ける */
section.colpage > p {
  margin: 0;
  font-family: ${bodyFont};
  font-size: ${pt(s.fontPt)};
  line-height: ${pt(feed)};
}
${
  /**
   * ページごとの書体・文字サイズ・行送り。
   *
   * **1ページに収める紙面なので、ここが入る字数を直に決める。**
   * 見出しも一緒に縮める(本文だけ小さくすると見出しだけが浮く)。
   * 行送りの指定が無いページは、本全体と同じ比を保つ(章ごとの指定と同じ考え方)
   */
  (s.columnPages ?? [])
    .map((c, i) => {
      const fp = c.fontPt;
      const lf = c.lineFeedPt;
      const bf = c.bodyFont;
      const hasDeco =
        c.color !== undefined ||
        c.outline !== undefined ||
        c.plate !== undefined ||
        c.headingFont !== undefined ||
        c.headingPt !== undefined ||
        c.headingColor !== undefined;
      const hasPad = !!(c.padXPct || c.padYPct);
      if (!fp && !lf && !bf && !hasDeco && !hasPad) return '';
      const feedHere = lf ?? (fp ? fp * (feed / s.fontPt) : feed);
      const sel = `section.colpage.colp${i}`;
      return [
        bf
          ? `${sel} > p { font-family: ${(BODY_FONTS[bf]?.stack ?? BODY_FONTS.serif.stack)}; font-weight: 400; }\n${sel} .tcy { font-family: ${tcyStack(bf)}; }`
          : '',
        fp || lf
          ? `${sel} > p { font-size: ${pt(fp ?? s.fontPt)}; line-height: ${pt(feedHere)}; }`
          : '',
        // 行送り比が変わるページは、ルビ・傍点の行間側の寄せも置き直す
        fp || lf ? `${sel} > p { --anno-shift: ${annoShift(fp ?? s.fontPt, feedHere)}; }` : '',
        // 見出し。**指定が無ければ本文に付いてくる。** headingPt を入れたときだけ切り離す
        fp || lf || c.headingPt
          ? `${sel} > h2 { font-size: ${pt(c.headingPt ?? (fp ?? s.fontPt) * COLPAGE_TITLE_SIZE)}; line-height: ${pt(c.headingPt ? c.headingPt * COLPAGE_TITLE_LINE * (feedHere / ((fp ?? s.fontPt) * COLPAGE_TITLE_SIZE)) : feedHere * COLPAGE_TITLE_LINE)}; }`
          : '',
        c.headingFont
          ? `${sel} > h2 { font-family: ${(BODY_FONTS[c.headingFont]?.stack ?? BODY_FONTS.serif.stack)}; }`
          : '',
        c.headingColor ? `${sel} > h2 { color: ${ink(c.headingColor)}; }` : '',
        fp || lf
          ? `${sel}.wm-h > h2 { margin-bottom: ${pt(feedHere * COLPAGE_TITLE_GAP)}; }\n${sel}.wm-v > h2 { margin-left: ${pt(feedHere * COLPAGE_TITLE_GAP)}; }`
          : '',
        // 文字の領域を版面の内側へ狭める(額のような枠柄の地に文字を収めるため。
        // 2026-09-11 ユーザー要望)。%は版面に対する片側ぶん。
        // box-sizing を締めて外寸(版面)は変えずに、中身だけ狭くする
        hasPad
          ? `${sel} { box-sizing: border-box; padding: ${mm((pageAreaH * (c.padYPct ?? 0)) / 100)} ${mm((pageAreaW * (c.padXPct ?? 0)) / 100)}; }`
          : '',
        // 飾り。**本文の帯と同じ考え方**(色・フチ・下に敷く帯)だが、
        // このページ1枚にだけ掛かる。帯は section の background なので版面ぶんが塗られる
        c.color ? `${sel} { color: ${ink(c.color)}; }` : '',
        c.outline !== undefined
          ? `${sel} { text-shadow: ${outlineShadow(c.outline, ink(c.outlineColor ?? s.textOutlineColor) ?? '#fff') || 'none'}; }`
          : '',
        // 下に敷く帯は、ここ(section)には塗らない。章と同じく platePageRules がページの箱ごと差し替える(2026-10-09)
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n')
}

/* ---- 奥付(rules §8) ----
   天ぞろえだと奥付に見えないので、版面の地に寄せて細い罫で本文と切る。
   縦組みの本でも奥付だけは横組みにする(現代の和書で最も一般的な体裁)。
   section に版面の実寸を与えているのは、中身を版面の地に寄せるため
   (Vivliostyle では section がページ領域のサイズを自動では持たない) */
/* 奥付を置くページは「横組みの器」にする。縦組みのままだと width が版面幅として効かず、
   セクションが本文の列幅まで縮んで奥付が細くなる(実測で確認) */
section.colophon {
  page: colophon;
  break-before: page;
  position: relative;
  writing-mode: horizontal-tb;
  width: ${mm(pageAreaW)};
  height: ${mm(pageAreaH)};
}
/* 奥付だけを地に貼る。著者紹介は天から流すので、この箱とはくっつかない。
   組み方向の指定は箱そのものにも置く。器だけに書くと、縦組みの本文を継承して
   奥付が縦に伸び、次ページへこぼれることがある(実測で確認) */
.colophon-box {
  position: absolute;
  /* 左右の寄せ(colophonRuleInset)はノドの余白が下限ちょうどの本だけ。ふつうは 0(修正リスト 23) */
  left: ${mm(colophonRuleInset)};
  bottom: 0;
  /* 幅は実寸で与える。縦組みのページに置くと left/right:0 だけでは幅が決まらず、
     箱が細くなって奥付の最終行が次ページへこぼれた(実測で確認) */
  width: ${mm(pageAreaW - 2 * colophonRuleInset)};
  writing-mode: horizontal-tb;
  border-top: 0.4pt solid #000;
  padding-top: ${pt(feed * 0.8)};
  font-family: ${bodyFont};
  font-size: ${pt(s.fontPt * 0.9)};
  line-height: ${pt(feed)};
}
.colophon-box h1 {
  margin: 0 0 ${pt(feed * 0.6)};
  font-size: ${pt(s.fontPt * 1.2)};
  font-weight: 700;
  line-height: ${pt(feed * 1.2)};
}
.colophon-box p { text-indent: 0; margin: 0; }

/* ---- 著者紹介(版面の天から) ----
   あとがきと違って本文ではないので、章立てにはしない。
   縦組みの本でも奥付とそろえて横組み・同じ文字サイズで組む。
   経歴・既刊を並べる欄なので、行頭は下げない。
   **奥付とはくっつけない。** 天から流して、奥付は地に貼ったままにする
   (地でひとかたまりにすると、奥付の付属物に見えてしまう) */
.profile-box {
  writing-mode: horizontal-tb;${
    // 奥付の箱と同じく、ノドの余白が下限ちょうどの本だけ左右から内へ寄せる(修正リスト 23。
    // 著者紹介の横組みの行頭も版面の端に来るので、14.992mm になっていた。テストデータの PDF で実測)
    colophonRuleInset > 0 ? `\n  margin-left: ${mm(colophonRuleInset)};\n  margin-right: ${mm(colophonRuleInset)};` : ''
  }
  font-family: ${bodyFont};
  font-size: ${pt(s.fontPt * 0.9)};
  line-height: ${pt(feed)};
}
.profile-box h2 {
  margin: 0 0 ${pt(feed * 0.3)};
  font-size: ${pt(s.fontPt * 0.9)};
  font-weight: 700;
  line-height: ${pt(feed)};
}
.profile-box p { text-indent: 0; margin: 0; }
${
  /**
   * 奥付と著者紹介の見た目。**別々に上書きできる。**(2026-08-19 ユーザー要望)
   *
   * 同じページに並ぶが役目が違う(書誌の記録と、読ませる文章)。
   * 見出し(.colophon-box h1 / .profile-box h2)も一緒に動かす。
   * 本文だけ縮めると見出しだけが浮くため
   */
  (
    [
      ['.colophon-box', s.colophonType, 1.2],
      ['.profile-box', s.profileType, 1],
    ] as [string, MatterType | undefined, number][]
  )
    .map(([sel, m, headScale]) => {
      // **見出しだけの指定も拾う。** ここに headingFont / headingColor を書き忘れていて、
      // 「見出しの書体だけ変えた」ときに何も出ていなかった(2026-08-19 実測で発覚)
      const any =
        m &&
        (m.bodyFont ||
          m.fontPt ||
          m.lineFeedPt ||
          m.color ||
          m.headingFont ||
          m.headingPt ||
          m.headingColor);
      if (!any) return '';
      const size = m.fontPt ?? s.fontPt * 0.9;
      const feedHere = m.lineFeedPt ?? (m.fontPt ? m.fontPt * (feed / s.fontPt) : feed);
      const decls = [
        m.bodyFont ? `font-family: ${(BODY_FONTS[m.bodyFont]?.stack ?? BODY_FONTS.serif.stack)};` : '',
        m.fontPt || m.lineFeedPt ? `font-size: ${pt(size)};` : '',
        m.fontPt || m.lineFeedPt ? `line-height: ${pt(feedHere)};` : '',
        // 行送り比が変わるなら、ルビ・傍点の行間側の寄せも置き直す
        m.fontPt || m.lineFeedPt ? `--anno-shift: ${annoShift(size, feedHere)};` : '',
        m.color ? `color: ${ink(m.color)};` : '',
      ].filter(Boolean);
      /**
       * 見出し。**指定が無ければ本文に付いてくる。**
       * headingPt を入れたときだけ本文から切り離す。
       * 本文だけ縮めて見出しが取り残されるより、既定では一緒に動くほうがよい
       */
      const hsel = `${sel} ${sel === '.colophon-box' ? 'h1' : 'h2'}`;
      const headPt = m.headingPt ?? size * headScale;
      const headFeed = m.headingPt
        ? m.headingPt * (feedHere / size)
        : feedHere * headScale;
      const headDecls = [
        m.fontPt || m.lineFeedPt || m.headingPt
          ? `font-size: ${pt(headPt)}; line-height: ${pt(headFeed)};`
          : '',
        m.headingFont ? `font-family: ${(BODY_FONTS[m.headingFont]?.stack ?? BODY_FONTS.serif.stack)};` : '',
        m.headingColor ? `color: ${ink(m.headingColor)};` : '',
      ].filter(Boolean);
      const head = headDecls.length ? `${hsel} { ${headDecls.join(' ')} }` : '';
      return `${sel} {\n  ${decls.join('\n  ')}\n}${head ? '\n' + head : ''}`;
    })
    .filter(Boolean)
    .join('\n')
}
`;
}
