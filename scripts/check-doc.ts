// 検査用の組版HTMLを1か所で作る。**紙(PDF)も画面(生プレビュー)も、ここから同じものを取る。**
//
// これを分けておかないと、「紙では効いて画面では効かない」を切り分けるときに
// 「そもそも同じ本を測っていないのでは」が疑いとして残る。
// 使う側は2つ:
//
//   scripts/render-check.ts    … node から呼んで .html を書き出す(→ Vivliostyle CLI → PDF)
//   scripts/preview-probe.ts   … ブラウザで CoreViewer に食わせて画面を測る
//
// 中身は**アプリの初回起動と同じサンプル**(差し込みページ込み)。
// `render-sample.ts` との違いは、挿絵ページ・コラムページを同じ位置に入れてあること。
// これが無いとページ番号がアプリの画面とずれるので、
// 「P14 に線が出ている」というユーザー報告と突き合わせられない。
//
// 絵は 1x1 の透明PNGで代用する。差し込みページは絵の有無にかかわらず1ページなので、
// ページ割りは実物と変わらない(本物の絵は data URI で数MBあり、検査には要らない)。
//
// **文中の画像(第二章の千鳥・第四章の全面)は sampleManuscript() が入れたものをそのまま通す。**
// 本文の流れの中で組まれるぶん**絵の寸法がページ割りを決める**(縦組みは回り込みで行が減る)ので、1x1 に置き換えると
// 検査だけ別の本を組むことになる。1.0.2 から sampleManuscript() が入れるのは**本物と同じ画素数の代わりの絵**(1色の SVG。
// 本物は public/sample/ のファイル)で、ページ割りは本物と同じになる(src/sampleFig.ts の頭。画素数は scripts/sample-figs.test.ts が見張る)。
import { defaultSettings, typographyDefaults } from '../src/models/project';
import type {
  Binding,
  ColumnPage,
  InkColor,
  Plate,
  PrintRules,
  PrintTarget,
  ProjectSettings,
  SaddleCover,
  SceneBreakId,
  TrimId,
} from '../src/models/project';
import { manuscriptHtml } from '../src/typeset/html';
import { sampleManuscript } from '../src/sample';

/** 1x1 の透明PNG。絵の中身は検査に関係ないので、いちばん軽いもので置き換える */
const PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** 4x4 の青いPNG。共紙の表4(赤の表1と見分ける) */
const BLUE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNgYPiPhIjiAACOsw/xs6MvMwAAAABJRU5ErkJggg==';
/**
 * 4x4 の赤いPNG。**全面の絵が用紙いっぱいに敷かれているかを、画素で測るとき**だけ使う
 * (透明では、絵が紙の端まで届いているか見分けられない。scripts/check-bleed.py)
 */
const RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4IScHRwzEcQCxYxBBO0tjggAAAABJRU5ErkJggg==';

export interface CheckDocOptions {
  /** 横組みで組む(既定は縦組み) */
  yoko?: boolean;
  /** 区切り線を段落のあいだに詰める */
  dense?: boolean;
  /** 場面転換の見た目。省略するとアプリの既定(1行アキ) */
  scene?: SceneBreakId;
  /** 紙の出し先と印刷所の決まり。省略は KDP(2026-10-01。塗り足し・ノドの検査用) */
  printTarget?: PrintTarget;
  printRules?: PrintRules;
  /** ノド計算に使う推定ページ数(200ページ超の段階を測るとき。省略は既定) */
  estimatedPages?: number;
  /** 挿絵ページの絵を赤い画素にする(紙の端まで敷かれているかを測るため) */
  solidArt?: boolean;
  /** 書名。省略はサンプルの書名。長い書名で大扉がノドの下限を割らないかを測るとき(check-bleed.py) */
  title?: string;
  /** 縦組みの本で、書名・著者名だけ横組みにする(titleWritingMode。2026-10-03。scripts/check-title-horizontal.py) */
  titleYoko?: boolean;
  /** 判型・刷り色。省略はアプリの既定(文庫・カラー)。中綴じの検査(scripts/check-saddle.py)が A5 で測る */
  trim?: TrimId;
  ink?: InkColor;
  /** 中綴じ(2026-10-03)。`padPages` は奥付の手前に足す白いページ、`faces` は共紙の表1・表4(赤と青の絵で、位置を画素で測る) */
  binding?: Binding;
  saddleCover?: SaddleCover;
  padPages?: number;
  faces?: boolean;
  /** 書名も著者紹介も無い本(奥付が入らない)。中綴じの白いページが最後に入る本の検査(2026-10-03) */
  noColophon?: boolean;
  /** 判型・組み方向ごとの字の大きさ・余白の既定(typographyDefaults)を当てる。アプリで判型を選んだときと同じ本になる(柱・ノンブルの位置の検査 scripts/check-footer.py。2026-10-03) */
  typo?: boolean;
  /** 章題をすべてこの字に差し替える(長い章題が柱に出たときの検査 scripts/check-footer.py。2026-10-03) */
  chapterTitle?: string;
  /** 設定の上書き(JSON)。ノンブル・柱の置き場所や段組みを振るのに使う */
  extra?: Partial<ProjectSettings>;
  /**
   * 見開きの絵(挿絵ページの size: 'spread')を1枚入れる(scripts/check-spread.py。2026-10-03)。
   * `src` は絵の data URI、`before` は「何章の前か」。`blankBefore` は同じ切れ目の手前に白いクッションページを1枚置く
   * (見開きの前のページの偶奇を入れ替える)。`control` は見開きの代わりに白い1ページを置く(手前のページ数を数える対照)
   */
  spread?: { src: string; before: number; blankBefore?: boolean; control?: boolean };
}

/**
 * `dense` のとき、**段落のあいだに区切り線を機械的に差し込む。**
 *
 * サンプル原稿の区切り線は1本しか無いので、「線だけがページの端に取り残される」を
 * ふつうの原稿では踏めない(1本たまたま中ほどに出るだけ)。
 * 密に詰めた原稿を組めば、改ページの位置と線の位置が何十通りも当たるので、
 * break-before/after: avoid が外れたら必ずどこかで落ちる。
 *
 * **1行アキ(space)の直前・直後には入れない。** そこは既知の未対応
 * (hr → p.line-space の組はくっつくが、その次の段落との間で改ページが起きうる。
 *  src/typeset/css.ts の hr のコメントを見ること)。
 * 直していない箇所で検査が落ちても、何も分からない。
 *
 * **段落ごとには入れない。3つに1つ。**(2026-08-20 実測)
 * 区切り線は前にも後ろにもくっつく(break-before/after: avoid)ので、
 * 段落のあいだ全部に入れると**章まるごとが1つの切れない塊になる**。
 * そうなると組版は「どこかで切るしかない」ので、線の直後で切る例が出る。
 * それは詰め込みすぎが作った状況で、原稿の側の不具合ではない
 * (段落ごとに入れた版では、ページ末尾に単独の線が1件出た)。
 * 3つに1つなら切れる場所が必ず残り、それでいて線は本の中に40本ほど散る
 */
export function buildCheckHtml(opt: CheckDocOptions = {}): string {
  const ms = sampleManuscript();
  const chapterCount = ms.chapters.length;
  if (opt.title) ms.title = opt.title;
  if (opt.chapterTitle) for (const ch of ms.chapters) ch.title = opt.chapterTitle;
  if (opt.noColophon) {
    ms.title = '';
    ms.authorProfile = '';
  }

  if (opt.dense) {
    for (const ch of ms.chapters) {
      const out: typeof ch.blocks = [];
      let seen = 0;
      ch.blocks.forEach((b, i) => {
        out.push(b);
        const next = ch.blocks[i + 1];
        if (b.type === 'p' && next && next.type === 'p' && ++seen % 3 === 0) {
          out.push({ type: 'hr' });
        }
      });
      ch.blocks = out;
    }
  }

  // 置き場所は sampleArt.ts の loadSampleArt と同じにする。
  // **ここがずれるとページ番号がずれる** ので、あちらを直したらこちらも直すこと
  const ART = opt.solidArt ? RED : PX;
  const plates: Plate[] = [
    { id: 'p1', src: ART, beforeChapter: 0, size: 'full', fromPreset: true },
    {
      id: 'p2',
      src: PX,
      beforeChapter: Math.min(3, Math.max(1, chapterCount - 1)),
      size: 'wide',
      fromPreset: true,
    },
    {
      id: 'p3',
      src: PX,
      beforeChapter: Math.max(1, chapterCount - 1),
      size: 'narrow',
      order: 0,
      fromPreset: true,
    },
  ];

  if (opt.spread) {
    const at = Math.max(0, Math.min(chapterCount, opt.spread.before));
    // 配列の並びがそのまま同じ切れ目の中の並びになる(order の無いものは配列順。html.ts の insertsBefore)
    if (opt.spread.blankBefore) plates.push({ id: 'spb', src: '', beforeChapter: at, size: 'full', blank: true });
    plates.push(
      opt.spread.control
        ? { id: 'sp', src: '', beforeChapter: at, size: 'full', blank: true }
        : { id: 'sp', src: opt.spread.src, beforeChapter: at, size: 'spread' },
    );
  }

  const columnPages: ColumnPage[] = [
    {
      id: 'c1',
      title: '祖母と、青い本のこと',
      text: 'ダミー\nダミー',
      beforeChapter: 2,
      bodyFont: 'klee',
      fontPt: 8.5,
      headingPt: 12,
      bg: { src: PX, opacity: 0.18, fromPreset: true },
    },
    {
      id: 'c2',
      title: 'あの家のこと',
      text: 'ダミー\nダミー',
      beforeChapter: Math.max(1, chapterCount - 1),
      order: 1,
      bodyFont: 'bizGothic',
      headingFont: 'bizGothic',
      fontPt: 9,
      headingPt: 13,
      color: '#ffffff',
      headingColor: '#ffffff',
      bg: { src: PX, opacity: 1, fromPreset: true },
    },
  ];

  const s: ProjectSettings = {
    ...defaultSettings(),
    ...(opt.yoko ? { writingMode: 'horizontal' as const } : {}),
    ...(opt.titleYoko ? { titleWritingMode: 'horizontal' as const } : {}),
    ...(opt.scene ? { sceneBreak: opt.scene } : {}),
    ...(opt.trim ? { trim: opt.trim } : {}),
    ...(opt.typo ? typographyDefaults(opt.trim ?? defaultSettings().trim, opt.yoko ? 'horizontal' : 'vertical') : {}),
    ...(opt.ink ? { ink: opt.ink } : {}),
    ...(opt.binding ? { binding: opt.binding } : {}),
    ...(opt.saddleCover ? { saddleCover: opt.saddleCover } : {}),
    ...(opt.printTarget ? { printTarget: opt.printTarget } : {}),
    ...(opt.printRules ? { printRules: opt.printRules } : {}),
    ...(opt.estimatedPages ? { estimatedPages: opt.estimatedPages } : {}),
    ...(opt.extra ?? {}),
    columnPages,
    chapterFontPt: chapterCount > 3 ? { 3: 8.5 } : {},
    chapterDropCap: { 0: 3 },
    bgOpacity: 0.25,
    titleBg: { src: PX, opacity: 0.4, fromPreset: true },
    chapterBg: chapterCount > 1 ? { 1: { src: PX, opacity: 0.3, fromPreset: true } } : {},
    plates,
  };

  return manuscriptHtml(
    ms,
    s,
    '',
    opt.binding === 'saddle'
      ? {
          padPages: opt.padPages ?? 0,
          ...(opt.saddleCover === 'self' ? { coverFaces: opt.faces ? { front: RED, back: BLUE } : ('placeholder' as const) } : {}),
        }
      : {},
  );
}

/** 章の数。書き出しのログに出して、ページ番号のずれに気づけるようにする */
export function checkChapterCount(): number {
  return sampleManuscript().chapters.length;
}
