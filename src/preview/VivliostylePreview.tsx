// Vivliostyle CoreViewer による組版プレビュー。
// 生成HTMLを Blob URL にして読み込ませ、見開き表示する。
//
// **ビューアは2つだけ作って、交互に使い回す。**(2026-08-21)
// もとは組み直しのたびに `new CoreViewer` していたが、CoreViewer には破棄の口が無く
// (`destroy` も `dispose` も無い)、捨てたつもりのものが全部生き残る。
// 詳しくは下の Buf と bufsRef のところに実測値つきで書いた。
//
// **長い本のための決まりが2つ足してある。**(2026-08-22。297ページの実原稿の報告から)
//
//   1. **1ページ目ができた時点で紙を出す**(下の earlyShow)。
//      Vivliostyle は「いま見るページだけ組む → interactive → 残り全部 → complete」の
//      2段構えなので、complete を待つ必要が無い。実測 14.5秒 → 3.4秒
//   2. **組み上がっていない面があれば、次の組み直しもそこへ重ねる**(下の buildingRef)。
//      別の面へ逃がすと2冊が同時に組まれ、共通の走らせ手を取り合う。実測 26.1秒 → 14.2秒

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent,
} from 'react';
import { CoreViewer, Navigation, PageViewMode, type Payload } from '@vivliostyle/core';
import { FrogPeek } from '../components/FrogMark';
import { createThumbs, type AddKind, type InsertKind, type ThumbStrip } from './PageThumbs';

export interface LayoutInfo {
  /** 挿絵がいま何ページ目に出ているか。挿絵の id で引く */
  platePages: Map<string, number>;
  /** コラムページの id → 何ページ目に出たか(1始まり)。左の欄から飛ぶのに使う */
  colPagePages: Map<string, number>;
  /**
   * 章の途中の絵 → 何ページ目に出たか(1始まり)。鍵は imageKey(章, 並び)。
   * ［挿絵］の一覧の「◯ページ目（見る）」に使う
   */
  imgPages: Map<string, number>;
  /**
   * 奥付が何ページ目に出たか(1始まり)。無ければ 0。
   *
   * **05 を開いたとき、そのページへプレビューを飛ばすのに使う。**
   * 奥付は1ページの紙面なので、書名や発行日を入れながら見えていないと確かめられない
   * (表紙と同じ「面をクローズアップする」型。2026-08-18)
   */
  colophonPage: number;
  /**
   * 章(0始まり) → 章が始まるページ(1始まり)。目次(0 なら無い)・大扉(0 なら無い)も同じく。
   * ［背景］で面の絵を変えたとき、その面へプレビューを飛ばすのに使う(2026-09-23 ユーザー指摘
   * 「第3章の背景を入れたけど、プレビューがそこに飛ばなかった」)
   */
  chapterPages: Map<number, number>;
  tocPage: number;
  titlePage: number;
  /**
   * 見開きの絵(PlateSize の 'spread')のうち、**手前に組版が白いページを1枚入れたもの**の id(2026-10-03)。
   * 見開きは偶数ページから始まるので、奇数ページに来るときは組版が白を挟む(css.ts の break-before: verso)。
   * 挟んだことは［挿絵］のその絵の行で知らせる(黙って足さない)。見分け方は readLayout
   */
  spreadBlank: Set<string>;
}

export function emptyLayout(): LayoutInfo {
  return {
    platePages: new Map(),
    colPagePages: new Map(),
    imgPages: new Map(),
    colophonPage: 0,
    chapterPages: new Map(),
    tocPage: 0,
    titlePage: 0,
    spreadBlank: new Set(),
  };
}

/**
 * これより小さい倍率で見せているときは、**縦中横の断り書きを添える。**
 *
 * 縦中横は半角の字を1文字ぶんの枠に詰めるので、枠の中の字は本文の半分の大きさになる。
 * 文庫9pt(=11.98px)なら1字あたり 5.99px で、そこへ倍率が掛かる。
 * 60% を切ると 3.6px を下回り、画素への丸めが字の位置を左右に振るので、
 * 隣の全角の字とそろっていないように見える(組み方は変わっていない)。
 */
const TCY_HINT_PCT = 60;

/**
 * 組み上がったページから、挿絵がいま何ページ目に出たかを読む。
 *
 * 挿絵の位置は「◯章の前」で決まるので、組み上がりを見る必要はない。
 * ここで読むのは画面に「いま N ページ目」と出すためだけ。
 * (以前はページ番号で置いていたので、段落がページをまたぐ様子まで読んでいた)
 */
function readLayout(root: HTMLElement): LayoutInfo {
  const info = emptyLayout();
  const pageBoxes = Array.from(root.querySelectorAll('[data-vivliostyle-page-container]'));
  pageBoxes.forEach((page, i) => {
    page.querySelectorAll('[data-plate]').forEach((el) => {
      const id = el.getAttribute('data-plate');
      if (id && !info.platePages.has(id)) info.platePages.set(id, i + 1);
      // 見開きの1ページ目の手前のページが「中身が空」なら、組版が白を挟んだ(ほかのページには section か div.plate か
      // div.fullbleed が残る。自分で置いたクッションも div.plate)
      if (id && el.classList.contains('sp-a') && i > 0 && !pageBoxes[i - 1].querySelector('section, div.plate, div.fullbleed')) {
        info.spreadBlank.add(id);
      }
    });
    page.querySelectorAll('[data-colpage]').forEach((el) => {
      const id = el.getAttribute('data-colpage');
      if (id && !info.colPagePages.has(id)) info.colPagePages.set(id, i + 1);
    });
    page.querySelectorAll('[data-img]').forEach((el) => {
      const key = el.getAttribute('data-img');
      if (key && !info.imgPages.has(key)) info.imgPages.set(key, i + 1);
    });
    if (!info.colophonPage && page.querySelector('section.colophon')) info.colophonPage = i + 1;
    // 章は各ページの断片が同じ id を持つ(visibleChapters と同じ読み方)。最初に出たページが章はじめ
    page.querySelectorAll('section.chapter[id]').forEach((sec) => {
      const n = chapterNoOf(sec.id);
      if (Number.isFinite(n) && !info.chapterPages.has(n)) info.chapterPages.set(n, i + 1);
    });
    if (!info.tocPage && page.querySelector('section.toc')) info.tocPage = i + 1;
    if (!info.titlePage && page.querySelector('section.titlepage')) info.titlePage = i + 1;
  });
  return info;
}

/** id="ch1" のような章 id から、0始まりの章番号を取り出す。取れなければ NaN */
function chapterNoOf(id: string): number {
  const n = Number(/^ch(\d+)$/.exec(id)?.[1]);
  return Number.isFinite(n) ? n - 1 : NaN;
}

/**
 * いま画面に出ている章の番号(0始まり)を、表示中のページ箱から直に読む。
 *
 * **ページ番号を経由しない。** 前は「いま見ているページ番号 → その番号を超えない
 * 最後の章はじめ」で章を1つだけ引いていたが、見開きは2ページぶん画面に出るのに
 * ページ番号は1つしか無いので、そのページがどちらの側(先か後ろか)を指しているかで
 * 答えが変わっていた。**前から進むと左側(番号の小さい章)、後ろから戻ると右側
 * (番号の大きい章)が出る**という報告はこれが原因(2026-08-20)。
 *
 * `renderAllPages` は全ページを DOM に持ち、いま画面に出ていない
 * `[data-vivliostyle-page-container]` には Vivliostyle 自身が `display: none` を
 * 直に書き込む。ここを見れば、見開きでも単ページでも**いま画面にある箱だけ**を
 * 数えられ、送ってきた向きに関係なく同じ見開きなら同じ答えになる。
 *
 * 章に属さないページ(コラム・挿絵・扉・目次・奥付)しか無い箱には章 id が無いので、
 * 何も足さない。見開きの片側だけに章がある(もう片側は挿絵など)ときは、
 * その1章だけが返る
 */
function visibleChapters(root: HTMLElement): number[] {
  const found: number[] = [];
  root.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]').forEach((page) => {
    if (page.style.display === 'none') return;
    page.querySelectorAll('section.chapter[id]').forEach((sec) => {
      const n = chapterNoOf(sec.id);
      if (Number.isFinite(n) && !found.includes(n)) found.push(n);
    });
  });
  return found;
}

/**
 * いま画面に出ているコラムページの id。**読み方は visibleChapters と同じ**(隠れている箱は飛ばす)。
 * コラムページの紙面は section.colpage[data-colpage]
 */
function visibleColumns(root: HTMLElement): string[] {
  const found: string[] = [];
  root.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]').forEach((page) => {
    if (page.style.display === 'none') return;
    page.querySelectorAll('[data-colpage]').forEach((el) => {
      const id = el.getAttribute('data-colpage');
      if (id && !found.includes(id)) found.push(id);
    });
  });
  return found;
}

/** 章にもコラムにも属さない、1枚で背景を持つページ(大扉・目次・奥付) */
export type SpecialPage = 'title' | 'toc' | 'colophon';

/**
 * いま画面に出ている大扉・目次・奥付。**帯が「このページだけ」を出すのに使う。**(2026-10-09)
 * それぞれの背景の濃さ・文字のフチは左の欄にしか無かった。見た目は帯にそろえる、というユーザー判断で帯へ移した
 */
function visiblePages(root: HTMLElement): SpecialPage[] {
  const found: SpecialPage[] = [];
  const add = (p: SpecialPage) => {
    if (!found.includes(p)) found.push(p);
  };
  root.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]').forEach((page) => {
    if (page.style.display === 'none') return;
    if (page.querySelector('section.titlepage')) add('title');
    if (page.querySelector('section.toc')) add('toc');
    if (page.querySelector('section.colophon')) add('colophon');
  });
  return found;
}

/** onVisibleChapters に渡す3つ(章の番号・コラムページの id・大扉／目次／奥付) */
function visibleSections(root: HTMLElement): [number[], string[], SpecialPage[]] {
  return [visibleChapters(root), visibleColumns(root), visiblePages(root)];
}

/** 外から特定のページへ飛ばすための口(02 奥付を開いたときに使う) */
export interface PreviewHandle {
  /** 1始まりのページ番号へ移動する */
  goToPage: (page: number) => void;
  /**
   * そのページを一覧の中で光らせる。**増えたことを目で分からせる。**
   * 左の欄とページ一覧は画面の反対側にあるので、片方で足しても
   * もう片方で何が起きたか読めなかった(2026-08-19 ユーザー指摘)
   */
  flashPage: (page: number) => void;
  /** ページ一覧の中に一言出す。**操作した場所のそばで言う** */
  notify: (text: string) => void;
  /**
   * いま見ているページ(1始まり)。
   * **奥付へ飛ぶ前の居場所を控えるのに使う。** 飛びっぱなしだと、戻ってきたときに
   * さっきまで直していたページを探し直すことになる(2026-08-19 ユーザー指摘)
   */
  currentPage: () => number;
}

/**
 * プレビューの見せ方。見開きか、1ページずつか。
 *
 * **連続スクロールは作れない。** 実測(2026-08-19): Vivliostyle は
 * `renderAllPages` で全ページを DOM に持つが、**いま見ているページ以外に
 * `display: none` を掛ける**。`fitToScreen` を切っても、`pageViewMode` を変えても同じで、
 * CSS で `display` を戻すと今度は全ページが同じ座標に重なる(親が絶対配置のため)。
 * 組版エンジンの内部レイアウトを壊さずに縦へ積む道が無い。
 *
 * 代わりに**ホイールでページを送る**(下記 wheel)。手の動きはスクロールのまま、
 * 送られるのがページになる
 */
export type PreviewView = 'spread' | 'single';

/** 下のページ送りの帯の高さ(px)。誌面をここに重ねないための逃げしろ */
const NAV_H = 46;

/** その回の組み直しのあいだだけ効く聞き耳。面を作るときに立てた口へ差し込む */
interface BufJob {
  onNav: (payload: Payload) => void;
  onHyper: (payload: Payload) => void;
  onReady: () => void;
}

/**
 * 誌面を載せる面ひとつぶん。**ビューアは面と一生を共にする。**
 *
 * 聞き耳(nav / hyperlink / readystatechange)は面を作るときに1度だけ立て、
 * 中身は組み直しのたびに `job` を差し替える。
 * CoreViewer には**リスナーを外す口はあるが、ビューアを捨てる口が無い**ので、
 * 立て直さずに中身を差し替えるのがいちばん行儀がよい
 */
interface Buf {
  inner: HTMLElement;
  viewer: CoreViewer;
  job: BufJob | null;
}

/**
 * 面を1枚作る。**`new CoreViewer` を呼ぶのはここだけ。**
 * 以後の組み直しは `loadDocument` で中身を差し替える
 */
function makeBuf(host: HTMLElement): Buf {
  const inner = document.createElement('div');
  /**
   * **下のページ送りの帯ぶんを空けておく。**(2026-08-20 ユーザー指摘)
   * inset:0 だと、画面に収める指定が帯の裏まで紙を伸ばすので、
   * ページの下端が帯に隠れて読めなかった(実測: 紙 111〜741px、帯 694〜727px)。
   * ここを狭めれば、組版側が測る高さもそのぶん減って収まる
   */
  inner.style.cssText =
    `position:absolute;top:0;left:0;right:0;bottom:${NAV_H}px;overflow:auto;opacity:0;pointer-events:none;`;
  host.appendChild(inner);
  const viewer = new CoreViewer(
    { viewportElement: inner },
    {
      autoResize: true,
      renderAllPages: true,
      pageViewMode: PageViewMode.SPREAD,
      fitToScreen: true,
      pageBorderWidth: 1,
      pixelRatio: 0,
    },
  );
  const buf: Buf = { inner, viewer, job: null };
  viewer.addListener('nav', (payload) => buf.job?.onNav(payload));
  viewer.addListener('hyperlink', (payload) => buf.job?.onHyper(payload));
  viewer.addListener('readystatechange', () => buf.job?.onReady());
  return buf;
}

/**
 * その面で走っている組版を、いま止める。(2026-08-22)
 *
 * **CoreViewer に公開の止め口は無い。** ただ内部(adaptViewer_)の
 * cancelRenderingTask は render() 自身が頭で呼んでいるものと同じで、
 * 走っている組版タスクを打ち切るだけの行儀のよい口。次の loadDocument は
 * まっさらから組み直すので、途中で止めた面を渡しても壊れない
 * (2026-08-21 の実測でも「途中で止まった面は、組み直せば戻る」)。
 *
 * なぜ loadDocument に任せないか: loadDocument が古い組版を取り消すのは、
 * **新しい原稿を読み込んで解析したあと**(render() の頭)。それまでのあいだ
 * 古い組版が走らせ手(全ビューア共通の主線)を埋め続ける。長い本では
 * その「もう要らない組版」が次の組版の立ち上がりを遅らせる。
 *
 * 内部の形が変わって呼べなくなっても害は無い — その場合はいままでどおり
 * loadDocument が(遅れて)取り消す
 */
function cancelRender(buf: Buf | null | undefined) {
  if (!buf) return;
  try {
    (
      buf.viewer as unknown as { adaptViewer_?: { cancelRenderingTask?: () => void } }
    ).adaptViewer_?.cancelRenderingTask?.();
  } catch {
    /* 止められなくても組版そのものは壊れない */
  }
}

interface Props {
  html: string;
  /**
   * 塗り(背景・色・フチ・帯)を紙面へ重ねるパッチCSS(preview/paint.ts が作る)。(2026-08-22)
   *
   * **html は塗りを既定値に固定して組んである**(App が paintNeutral を通す)ので、
   * 塗りだけの変更ではこの文字列しか変わらない。組版は走らず、
   * <style> の書き換え1回で全ページ(サムネイル含む)に映る。
   * 297ページの実操作で「背景を1回いじるたびに2分の組み直し」だったものを
   * 組版0回にするための口
   */
  paintCss?: string;
  /** 組み上がった実ページ数を伝える(表紙の背幅計算に使う) */
  onPageCount?: (n: number) => void;
  /**
   * 挿絵がいま何ページ目に出たかを伝える。**2つめはその紙面を組んだ HTML。**
   * 受け手(App の「いじった1枚へ連れて行く」)が、いまの本の姿から組んだ紙面かどうかを
   * 突き合わせるのに使う。追い越される前に組み上がった古い1冊の報せで飛ばないため
   */
  onLayout?: (info: LayoutInfo, html: string) => void;
  /**
   * いま画面に出ている章の番号(0始まり)が変わったら知らせる。**見開きなら2つ
   * 入ることがある。** 帯が「いま開いている章」の飾りを出すのに使う(2026-08-19)。
   * 章に属さないページしか無い見開きでは空配列。
   * 2つ目はいま画面に出ているコラムページの id。帯が「このコラムだけ」を出すのに使う(2026-10-08)。
   * 3つ目は大扉・目次・奥付のうち画面に出ているもの。帯が「このページだけ」を出すのに使う(2026-10-09)
   */
  onVisibleChapters?: (chapters: number[], columns: string[], pages: SpecialPage[]) => void;
  /**
   * **ページ数をまだ数えている最中か。**(2026-08-22)
   *
   * 長い本では、紙が見えてから全部組み上がるまでに何十秒もかかる。
   * そのあいだ画面に「120ページ（概算）」(既定値)が出ていた。
   * **背幅も KDP の入稿値もページ数から作る**ので、いいかげんな数を出すのは害になる。
   *
   * 「全部組まずに数だけ先に出す」道は無い(実測 2026-08-22)。
   * `renderAllPages: false` にすると Vivliostyle は `epageCount` を返すが、
   * 中身は**字数を600で割った当て推量**(`Math.ceil(totalOffset/600)`)で、
   * 実原稿では **708 と出て、本当は 293ページ**だった。
   * だから**数え終わるまでは数を出さない**(画面には「数えています…」)
   */
  onCounting?: (counting: boolean) => void;
  /**
   * 見せ方を固定する。**書き出しの下見に使う。**
   *
   * 紙のPDFも EPUB も**1ページずつ**で出るのに、見開きのまま下見していると
   * 「見開きで刷られる」と読める(2026-08-19 ユーザー指摘)。
   * 書き出す物を選んでいるあいだは単ページに固定し、切り替えの札も止める
   */
  forceView?: PreviewView;
  /**
   * 差し込んだページ(挿絵・コラム・クッション)の並べ替えと出し入れ。
   * **サムネイルの上で直に動かせるようにする。**(2026-08-19 ユーザー要望)
   * 渡さなければ、サムネイルはただの飛び先のまま
   */
  onAddInsert?: (kind: AddKind, beforeChapter: number) => void;
  /** ページ一覧の［＋］で足してよい種類(ThumbHooks.addKinds)。省略は全部 */
  addKinds?: AddKind[];
  onMoveInsert?: (kind: InsertKind, id: string, beforeChapter: number, at: number) => void;
  onDeleteInsert?: (kind: InsertKind, id: string) => void;
  onCopyInsert?: (kind: InsertKind, id: string) => void;
  /** 紙と電子の切り替え(App)。下の帯の左端に置く。両方を作る本だけ渡ってくる */
  modeSwitch?: ReactNode;
  /**
   * 組版HTMLから塗り足し(mm)を読む口。**渡すと、下見に仕上がり線(裁つ位置の点線)を出せる。**(2026-10-02 ユーザー要望)
   *
   * 線の位置は**面ごと**に持つ(下の applyFaceVars): 組み直しのあいだは古い面と新しい面が入れ替わるので、
   * 1か所で持つと、入れ替わる一瞬だけ新しい紙面に古い位置の線が乗る(検査で実際に捕まえた)。
   * 面を組みはじめるときに、その HTML の塗り足しを面に書いておけば、どの瞬間も紙面と線が合う。
   * 塗り足しの無い紙(全辺 0)・読めない HTML には線を出さない(ボタンごと出さない)
   */
  boxesOf?: (html: string) => { bleed: TrimBleed; margins: TrimBleed | null } | null;
  /**
   * **全ページに版面(余白の内側)の枠を出すか。**(2026-10-02 ユーザー要望)
   * 絵の中の文字が版面の外に出ているとき(src/textcheck)に立つ。枠があると、なぜそこが外なのかが目で分かる。
   * 枠の位置も面ごと(boxesOf の margins)。はみ出した文字の場所の色は paintCss に入って渡ってくる
   */
  showArea?: boolean;
}

/** 塗り足し(mm)。天・地・小口・ノド(models/project.ts の Bleed4 と同じ形。下見は組版の型を知らないので、形だけ書く) */
interface TrimBleed {
  top: number;
  bottom: number;
  fore: number;
  gutter: number;
}

/**
 * 面に、仕上がり線と版面の枠の位置を書く(CSS 変数)。線の規則は app.css([data-face] …)。
 * - 仕上がり線: 辺ごとに、位置(--trim-◯)と、引くかどうか(--trim-◯-on。塗り足しが 0 の辺は 0 = 引かない)。
 *   塗り足しが1辺でもあれば data-trim を付ける(ボタンを出すかどうかの印)
 * - 版面の枠: 仕上がりの端からの余白(--area-◯)と、引けるかどうか(--area-on。余白が読めなければ 0)
 */
function applyFaceVars(inner: HTMLElement, boxes: { bleed: TrimBleed; margins: TrimBleed | null } | null) {
  if (!boxes) {
    inner.removeAttribute('data-face');
    inner.removeAttribute('data-trim');
    return;
  }
  const b = boxes.bleed;
  inner.setAttribute('data-face', '');
  inner.toggleAttribute('data-trim', b.top > 0 || b.bottom > 0 || b.fore > 0 || b.gutter > 0);
  for (const [name, v] of Object.entries({ top: b.top, bottom: b.bottom, fore: b.fore, gutter: b.gutter })) {
    inner.style.setProperty(`--trim-${name}`, `${Number(v.toFixed(3))}mm`);
    inner.style.setProperty(`--trim-${name}-on`, v > 0 ? '1' : '0');
  }
  const m = boxes.margins;
  inner.style.setProperty('--area-on', m ? '1' : '0');
  for (const [name, v] of Object.entries(m ?? { top: 0, bottom: 0, fore: 0, gutter: 0 })) {
    inner.style.setProperty(`--area-${name}`, `${Number(v.toFixed(3))}mm`);
  }
}

/** 仕上がり線を出すかの覚え書き(この PC のこのブラウザだけ。theme.ts と同じ流儀)。'0' = 出さない */
const TRIM_KEY = 'book-studio-trim-line';
/** 仕上がり線の説明を、いちど見せたかの覚え書き */
const TRIM_SEEN_KEY = 'book-studio-trim-line-seen';
/** 仕上がり線の説明を出しておく長さ(ms) */
const TRIM_HINT_MS = 9000;
/** この画面を開いてから、説明をいちど見せたか(localStorage が使えないブラウザでも、組み直すたびに出さないため) */
let trimSeenHere = false;
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // プライベートモードなどで使えないことがある。覚えられないだけで動きはする
    return null;
  }
}
function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 同上
  }
}

/** 塗りパッチを挿す <style> の id。document に1つだけ持つ */
const PAINT_STYLE_ID = 'preview-paint';

export const VivliostylePreview = forwardRef<PreviewHandle, Props>(function VivliostylePreview(
  {
    html,
    paintCss,
    onPageCount,
    onLayout,
    onVisibleChapters,
    onCounting,
    forceView,
    onAddInsert,
    addKinds,
    onMoveInsert,
    onDeleteInsert,
    onCopyInsert,
    modeSwitch,
    boxesOf,
    showArea,
  },
  ref,
) {
  const [viewPick, setView] = useState<PreviewView>('spread');
  const view = forceView ?? viewPick;
  /**
   * サムネイルを出すか。**畳めるようにする。**
   * 116px を常に取られると、狭い画面では誌面そのものが小さくなる
   * (2026-08-19 ユーザー要望「切り替えたら見えるように」)
   */
  const [thumbsOn, setThumbsOn] = useState(true);
  /**
   * 表示倍率。**0 は「画面に収める」。**(2026-08-20 ユーザー要望。表紙と同じ形にそろえる)
   *
   * Vivliostyle は fitToScreen と zoom の2本立てで、fitToScreen が入っていると
   * zoom は見ない。「全体」に戻す道を持たせるため、0 を fitToScreen の合図にする
   */
  const [zoom, setZoom] = useState(0);
  /**
   * 「全体」で収めているときの実際の倍率(%)。
   *
   * **数字を出さないと、いま何倍で見ているのか分からない**(2026-08-20 ユーザー指摘)。
   * fitToScreen の倍率は Vivliostyle が決めるので、こちらからは知りようがない。
   * 組み上がったページの箱に載っている transform を測って読む
   */
  const [fitPct, setFitPct] = useState(0);
  /** **組み直しの中から読む。** 依存に入れると、倍率を触るたびに組み直しになる */
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const containerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  /** **いま画面に出ている**ほうのビューア。ページ送り・倍率・goToPage はこれに効かせる */
  const viewerRef = useRef<CoreViewer | null>(null);
  const thumbsRef = useRef<ThumbStrip | null>(null);
  /**
   * 誌面を載せる面。**2枚だけ作って交互に使う。**
   *
   * ## なぜ作り直さないか(2026-08-21 実測)
   *
   * もとは組み直しのたびに `new CoreViewer(...)` して、捨てるほうには何もしていなかった。
   * **Vivliostyle の CoreViewer には破棄の口が無い**(`destroy` も `dispose` も無い)ので、
   * 捨てたつもりのビューアが全部そのまま残る。
   * 実測(`scripts/rebuild-probe.ts`・サンプル39ページを12回組み直し、回収を促してから計測):
   *
   *   いまの作り  窓の監視 1→12本 / 捨てたのに生きているビューア 12個 / JSヒープ 16→58MB
   *   2枚を交互  窓の監視 2本のまま / 生き残り 0個            / JSヒープ 16→22MB(2回目以降は横ばい)
   *
   * `setOptions({ autoResize: false })` を掛けると窓の監視は外れるが、**それでも回収されない**
   * (12回捨てて12個とも生きていた)。原稿を食わせていないビューアなら回収されるので、
   * 握っているのは `loadDocument` が立てる「終わらない命令待ちのループ」のほう。
   * つまり**作り直さない以外に手が無い。**
   *
   * ## なぜ1枚ではなく2枚か
   *
   * 1枚を使い回すと、組み直しのあいだ**その面の中身が消えて1ページ目から描き直る**。
   * それは「1個作業するたびに読み込みなおしになる」「扉ページが上に重なる」
   * (2026-08-19 ユーザー報告)に戻ることを意味する。
   * 2枚を交互にすれば、**片方で組みながら、もう片方の紙面を見せたまま**にできる。
   * 溜まるものは2枚ぶんで頭打ちになる
   */
  const bufsRef = useRef<Buf[] | null>(null);
  /**
   * **いま組んでいる面。組み上がるまで、次の組み直しもここへ来る。**(2026-08-22)
   *
   * もとは組み直しのたびに面を1つ進めていた(`turnRef`)。だから
   * **前の組版がまだ終わっていないうちに次を始めると、2冊が同時に組まれた。**
   * Vivliostyle の走らせ手は全ビューア共通の1本(25ミリ秒動いて1ミリ秒休む)なので、
   * 2冊が同じ主線を取り合い、どちらも倍かかる。続けて触れば触るだけ溜まる。
   *
   * **同じビューアへもう一度食わせれば、走っている組版は取り消される。**
   * (`node_modules/@vivliostyle/core` の `render()` が頭で `cancelRenderingTask()` を
   *  呼んでいる。`loadDocument` → `render` → `resize` の道)
   * だから「組んでいる面」を覚えておいて、そこへ重ねる。
   *
   * 実測(`scripts/app-probe.tsx`。文字の大きさを900ミリ秒おきに変えて、
   * 最後の1回から画面が落ち着くまで):
   *
   *   サンプル9倍(259ページ)を2回     **26.1秒 → 14.2秒**（どちらも組んだのは2冊）
   *   297ページの実原稿(361ページ)を3回 **37.2秒 → 28.8秒**（どちらも4冊）
   *
   * **組む「冊数」は変わっていない。** 変わったのは、**古い1冊を取り消せるようになった**
   * こと。残る時間は1冊ぶんの組版そのもので、そのあいだも前の紙面は見えていて、
   * 押しても返ってくる(心拍のあきは0回)
   */
  const buildingRef = useRef<Buf | null>(null);
  /**
   * いま見ているページ(0始まり)。組み直しは1ページ目から描き直すので、
   * ここに覚えておいて同じページへ戻す(判型や余白をいじるたび先頭に飛ぶのを防ぐ)
   */
  const currentPageRef = useRef(0);
  /**
   * 組み直し中。**そのあいだプレビューを覆う。**
   *
   * 新しいビューアは1ページ目から描き始めるので、覆わないと
   * 「直すたびに大扉へ飛んで、しばらくして戻ってくる」ように見える
   * (2026-08-18 ユーザー報告)。見ていたページの復元は組み上がりの完了後にしか
   * できないので、途中経過を見せないことで辻褄を合わせる
   */
  const [busy, setBusy] = useState(true);
  /**
   * いま画面に出ている誌面の入れもの(2枚のうちの片方)。**組み直しのあいだも残す。**
   *
   * もとは effect の後始末で毎回 inner.remove() していた。React は
   * 「前の後始末 → 次の effect」の順で走るので、設定を1つ変えるたびに
   * 誌面がいったん消え、覆いが出て、まっさらから組み直る絵になっていた
   * (2026-08-19 ユーザー指摘「1個作業するたびに読み込みなおしになる」)。
   * 新しい面が組み上がってから古い面を退かせれば、待っているあいだも前の紙面が見える
   */
  const liveInnerRef = useRef<HTMLElement | null>(null);
  /** 一度でも誌面を出したか。**覆いの出し方を変えるのに使う**(下の preview-busy 参照) */
  const [hasPage, setHasPage] = useState(false);
  /**
   * いま何ページできたか。**待っているあいだの手がかり。**
   * 覆いだけだと、止まっているのか進んでいるのか分からない
   * (長い本では組み上がるまで十数秒かかる。2026-08-19 ユーザー要望)
   */
  const [built, setBuilt] = useState(0);
  // 依存配列に入れると、渡されるたびに組み直しになってしまうので ref で持つ
  const pageCountRef = useRef(onPageCount);
  pageCountRef.current = onPageCount;
  const layoutRef = useRef(onLayout);
  layoutRef.current = onLayout;
  const boxesOfRef = useRef(boxesOf);
  boxesOfRef.current = boxesOf;
  const visibleChaptersRef = useRef(onVisibleChapters);
  visibleChaptersRef.current = onVisibleChapters;
  const countingRef = useRef(onCounting);
  countingRef.current = onCounting;
  const insertRef = useRef<{
    add?: (k: AddKind, before: number) => void;
    kinds?: AddKind[];
    move?: (k: InsertKind, id: string, before: number, at: number) => void;
    del?: (k: InsertKind, id: string) => void;
    copy?: (k: InsertKind, id: string) => void;
  }>({});
  insertRef.current = {
    add: onAddInsert,
    kinds: addKinds,
    move: onMoveInsert,
    del: onDeleteInsert,
    copy: onCopyInsert,
  };

  /**
   * 誌面が**いま画面に出ているか。**
   *
   * ## なぜ要るか(2026-08-21 実測。ユーザー報告「2ページ目でフリーズ」の正体)
   *
   * アプリは表紙・AI・書き出しの工程で `.main` を **display:none** にする
   * (畳まずに隠すだけ。components/App.tsx の `hidden={step === 'cover' || …}`)。
   * プレビューはそのまま生きているので、その状態で帯や工程の設定を触ると
   * **見えていないまま組み直しが走る。**
   *
   * 描かれていない木の中では `getBoundingClientRect()` が全部 0 を返す。
   * Vivliostyle はそのときだけ**書き換えのできない `DOMRect`** をそのまま返す作りで、
   * 目次のリーダー罫(typeset/css.ts の `content: leader('・')`)の後処理が
   * その `.bottom` に代入するので `TypeError: Cannot set property bottom of
   * #<DOMRectReadOnly>` で落ちる。後処理の呼び出しに try/catch が無いため
   * レイアウトの frame が終わらず、**目次のページで止まったまま二度と返ってこない。**
   *
   * 実測(scripts/rebuild-probe.ts・サンプル39ページ):
   *
   *   見えている       1.2秒で39ページ
   *   display:none 内  **2ページで止まり、60秒待っても組み上がらない**
   *   そのあと出す     0.9秒で39ページ（面は壊れていない。組み直せば戻る）
   *
   * だから**見えていないあいだは組まない。** 出てきたら組む
   */
  const [visible, setVisible] = useState(true);
  /**
   * 仕上がり線を出すか。**はじめは出す**(下見の紙は塗り足し込みで、線が無いと余白が広く見える)。
   * 消した人は、次に開いたときも消えたまま
   */
  const [trimOn, setTrimOn] = useState(() => readStored(TRIM_KEY) !== '0');
  /**
   * 線の説明を出しているか。**ずっとは出さない**(紙面の下端に重なる)。出すのは、
   * はじめて線が出たとき(このブラウザで1回)・ボタンで出したとき・ボタンに触れているあいだ
   */
  const [trimHint, setTrimHint] = useState(false);
  const [trimHover, setTrimHover] = useState(false);
  /** いま出ている面に、仕上がり線があるか(面を出すたびに、その面の印から読む) */
  const [hasTrim, setHasTrim] = useState(false);
  const trimShown = hasTrim && trimOn;
  // はじめての説明は、**紙面が見えてから**(入口の画面の裏や「ページを作っています…」のあいだに出しても読めない)
  const trimSeeable = trimShown && visible && hasPage && !busy;
  useEffect(() => {
    if (!trimSeeable || trimSeenHere || readStored(TRIM_SEEN_KEY) === '1') return;
    trimSeenHere = true;
    writeStored(TRIM_SEEN_KEY, '1');
    setTrimHint(true);
  }, [trimSeeable]);
  useEffect(() => {
    if (!trimHint) return;
    const t = window.setTimeout(() => setTrimHint(false), TRIM_HINT_MS);
    return () => window.clearTimeout(t);
  }, [trimHint]);
  // ボタンが消えるとき(電子書籍の下見へ移る・組み直しの途中)は mouseleave が来ない。触れている印を倒しておく
  // (倒さないと、ボタンが戻ったときに説明が出たままになる)
  useEffect(() => {
    if (!hasTrim) setTrimHover(false);
  }, [hasTrim]);
  /**
   * 版面の枠の説明。**枠が出たときに、しばらくだけ**(仕上がり線の説明と同じ扱い。紙面の下端に重ねたままにしない)。
   * くわしい説明と直し方は、左の欄の、その絵の行に出ている
   */
  const [areaHint, setAreaHint] = useState(false);
  useEffect(() => {
    if (!showArea) {
      setAreaHint(false);
      return;
    }
    setAreaHint(true);
    const t = window.setTimeout(() => setAreaHint(false), TRIM_HINT_MS + 3000);
    return () => window.clearTimeout(t);
  }, [showArea]);
  const toggleTrim = () => {
    const next = !trimOn;
    setTrimOn(next);
    writeStored(TRIM_KEY, next ? '1' : '0');
    setTrimHint(next);
  };
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // **`getClientRects()` が空 = どこにも描かれていない**(自分か親が display:none)。
    // 幅や高さが 0 なだけなら箱は1つ返るので、ここで取り違えない
    const read = () => setVisible(el.getClientRects().length > 0);
    read();
    // display の出し入れでも寸法の報せは飛ぶ(実測: 隠したとき・戻したとき両方で来る)
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 塗り(背景・色・フチ・帯)を紙面へ重ねる。**組版はしない。**(2026-08-22)
   *
   * Vivliostyle は計算済みのスタイルを要素のインラインstyleに直書きするので、
   * `!important` 付きの規則を親 document に1本挿して勝つ(paint.ts に実測の経緯)。
   * 規則は `.preview-body` に閉じてあり、印刷経路(iframe)には届かない。
   * 組み上がる前に変えても、規則は生きているので出来たページから順に効く
   */
  useEffect(() => {
    if (paintCss === undefined) return;
    let el = document.getElementById(PAINT_STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = PAINT_STYLE_ID;
      document.head.appendChild(el);
    }
    if (el.textContent !== paintCss) el.textContent = paintCss;
  }, [paintCss]);

  /**
   * いま見せている紙面が「どの原稿・どの見方」を組んだものか。
   *
   * タブを離れて戻ると visible が倒れて立ち、下の effect が走り直す。
   * そこで無条件に組んでいたので、**何も変えていなくても組み直しが走っていた**
   * (2026-09-14 ユーザー報告「タブを移動して元に戻ると、何も触ってなくても
   * 版下が組みなおされてしまっている」)。
   * 組み上がり(readyState complete)まで行けた回だけここに覚え、
   * 同じ原稿・同じ見方なら出てきたときに組み直さない。
   * 途中で隠されて打ち切った回は覚えない — そのときだけ、従来どおり
   * まっさらから組み直す(打ち切りの理由は下の DOMRect の話を参照)
   */
  const renderedRef = useRef<{ html: string; view: PreviewView } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !html) return;
    /**
     * **見えていないあいだは組まない。**(上の visible を参照)
     *
     * state ではなく DOM を直に見る。`visible` の初期値は true なので、
     * 隠れたまま立ち上がった1回目をここで止めないと、そこで固まってしまう
     */
    if (el.getClientRects().length === 0) {
      /**
       * **組んでいる最中に隠されたら、その組版ごと止める。**(2026-08-22)
       *
       * 「見えていないあいだは組まない」は組み**始め**を止めるだけで、
       * **すでに走っている組版**は隠れた木の中を走り続ける。描かれていない木では
       * getBoundingClientRect が全部 0 を返し、Vivliostyle は書き換えできない
       * DOMRect をそのまま返すので、目次のリーダー罫の後処理が
       * `TypeError: Cannot set property bottom of DOMRectReadOnly` で落ちる
       * (289ページの本で組版中に画面を切り替えると出る、と記録されていたすり抜け)。
       * 出てきたら visible が立ち、この effect がまっさらから組み直す
       */
      cancelRender(buildingRef.current);
      // **「数えています」も下ろす。**(2026-09-24) 打ち切ったまま立てっぱなしだと、
      // 電子の下見や書き出しの全画面で紙の下見を隠すたびに「数えています…」が残った。
      // 出てきたら、組み直しと一緒にまた立つ
      countingRef.current?.(false);
      return;
    }
    // 出てきただけで、原稿も見方も変わっていないなら、いまの紙面がそのまま正しい。
    // 組み直さない(上の renderedRef を参照)
    if (
      liveInnerRef.current &&
      renderedRef.current?.html === html &&
      renderedRef.current.view === view
    ) {
      /*
       * **組みかけの回を打ち切ったまま戻ってきたら、札も下ろす。**(2026-09-25 見直し S2-19)
       * 値を変えて1秒以内に元へ戻す(Ctrl+Z でも)と、変えた値の組み直しは片づけ(下の return () =>)で
       * 黙らされ、元の値はいま見せている紙面と同じなのでここで帰る。札を下ろす役がどちらにも無く、
       * 「ページを作っています…」が90秒たっても消えなかった(誌面そのものは正しいまま)
       */
      if (buildingRef.current) {
        cancelRender(buildingRef.current);
        buildingRef.current = null;
      }
      setBusy(false);
      thumbsRef.current?.setBusy(false);
      countingRef.current?.(false);
      return;
    }
    /**
     * **単ページ⇄見開きの切り替えだけなら、組み直さずに設定だけ送る。**(2026-09-14 ユーザー報告
     * 「紙書籍データを書き出したあと、本のかたちタブに戻ると組版をし直し始める」)
     *
     * 紙の本文を書き出す工程では単ページに固定している(見開きで下見していると
     * 見開きで刷られると読めるため)。そこから他の工程へ戻ると見開きに戻るので、
     * **表示のしかたが変わっただけで1冊まるごと組み直していた。**
     *
     * ページの割り付けはどちらでも同じ(実測: サンプルを9倍に積んだ268ページの本で
     * 見開き→単ページ→見開きと往復し、ページ数も各ページの字も1字も変わらなかった)。
     * ズームと同じく setOptions で足りる。
     *
     * 組んでいる最中(buildingRef)は、その回が古い表示のしかたで読み込み済みなので、
     * この近道は使わず下の組み直しに任せる
     */
    if (
      liveInnerRef.current &&
      viewerRef.current &&
      !buildingRef.current &&
      renderedRef.current?.html === html
    ) {
      const fit = zoomRef.current === 0;
      viewerRef.current.setOptions({
        pageViewMode: view === 'single' ? PageViewMode.SINGLE_PAGE : PageViewMode.SPREAD,
        ...(fit ? { fitToScreen: true } : { fitToScreen: false, zoom: zoomRef.current }),
      });
      renderedRef.current = { html, view };
      // 見開きだと隣の頁も出るので、いま見えている章を読み直す
      visibleChaptersRef.current?.(...visibleSections(liveInnerRef.current));
      return;
    }

    /**
     * 面は2枚だけ作る(上の bufsRef を参照)。**組む先の決め方はこの3行が肝。**
     *
     * 1. **まだ組み上がっていない面があれば、そこへ重ねる。**
     *    同じビューアへ食わせ直すと走っている組版が取り消されるので、
     *    2冊が主線を取り合わない(上の buildingRef を参照)
     * 2. そうでなければ、**いま見せていないほう**へ組む。
     *    片方で組みながら、もう片方の紙面を見せたままにできる
     */
    if (!bufsRef.current) bufsRef.current = [makeBuf(el), makeBuf(el)];
    const bufs = bufsRef.current;
    const buf =
      buildingRef.current ?? bufs.find((b) => b.inner !== liveInnerRef.current) ?? bufs[0]!;
    buildingRef.current = buf;
    const { inner, viewer } = buf;
    // 仕上がり線と版面の枠の位置を、この面に書く(この面がこれから載せる紙面の塗り足しと余白)
    applyFaceVars(inner, boxesOfRef.current?.(html) ?? null);

    /**
     * **前の組版がまだ走っていたら、いま止める。**(2026-08-22)
     * 下の loadDocument も結局は取り消すが、それは新しい原稿の読み込みと解析の
     * **あと**。それまで前の組版が主線を埋め続けるので、先に打ち切っておく
     * (走っていない面には何もしない)
     */
    cancelRender(buf);

    setBusy(true);
    setBuilt(0);
    countingRef.current?.(true);

    /**
     * **組み上がるまでは隠す。opacity で隠す — visibility ではだめ。**
     *
     * Vivliostyle はページの箱に `visibility: visible` を**直に書き込む**ので、
     * 親を `visibility: hidden` にしても子がそれを打ち消して出てきてしまう。
     * 実際、組み直しのあいだ新しい1ページ目(扉)が古い面の上に重なって見えていた
     * (2026-08-19 ユーザー報告「扉ページが上に重なって、今いるページを見ることができない」)。
     *
     * **DOM から外して隠すのもだめ。** 外した木の中は寸法が全部 0 になり、
     * 上の visible と同じ理由で目次のページから返ってこなくなる
     * (実測 2026-08-21: 外して組み直したら2ページで固まり、25秒待っても返らなかった)
     */
    inner.style.opacity = '0';
    inner.style.pointerEvents = 'none';

    const pageViewMode = view === 'single' ? PageViewMode.SINGLE_PAGE : PageViewMode.SPREAD;
    // 0 は「画面に収める」。組み直しのたびに、いまの倍率を掛け直す
    const fitToScreen = zoomRef.current === 0;

    /**
     * 復元が済むまで nav を無視する。読み込み中の 0 で記憶を上書きさせない。
     *
     * 組み直しの最中にも `nav` が飛んでくる(ページが1枚ずつ出来るたび、`epage: 0` で)。
     * それを currentPageRef へ書いていたので、復元するころには 0 になっていた。
     * 「設定を変えるたびに大扉へ飛ぶ」の正体がこれ(2026-08-17 ユーザー報告)。
     *
     * **この番人がいるので、戻る先は組み込みの前に控えなくてよい。**
     * もとは effect の頭で `want` に控えていたが、そうすると組み直しのあいだに
     * 利用者がページ一覧で移った先や、App が goToPage で指した先が、
     * 古い値で上書きされてしまう。復元のときに currentPageRef を読めばよい
     */
    let restored = false;
    /**
     * この回がまだ現役か。
     *
     * 面もビューアも使い回すので、**前の回の合図をここで黙らせる。**
     * 黙らせないと、追い越された組み直しの結果でページ数や版面が書き換わる
     */
    let alive = true;

    const pageEls = () =>
      Array.from(inner.querySelectorAll<HTMLElement>('[data-vivliostyle-page-container]'));

    /**
     * いま画面に出ている(0始まりの)ページ番号。**見開きなら2つ返る。**
     * `renderAllPages` は全ページを DOM に持ち、出していない箱には Vivliostyle 自身が
     * `display: none` を書き込むので、ここを見れば実際の表示が分かる
     */
    const shownPages = () =>
      pageEls().flatMap((el2, i) => (el2.style.display === 'none' ? [] : [i]));

    /** 後追いの確認。後始末で止める */
    const confirmTimers: number[] = [];

    /**
     * 戻したページに本当に居るか、あとから確かめる。
     *
     * `navigateToPage` はその場で動かさず、**内部の命令列に積むだけ**
     * (実装は `sendCommand({a:'moveTo', epage})`)。組み上がりの表示だけ先に出て
     * 命令が流れなかったときは、**1ページ目(扉)に居座る**。
     * 取りこぼしたときだけ、もう一度送り直す。
     * そのあいだに利用者が動かしていたら(記憶が変わっていたら)何もしない
     */
    const confirmPage = (back: number) => {
      // 0(大扉)へ戻すときも見る。面を使い回すと、前の文書で立っていた見開きから描き始めるため
      if (back < 0) return;
      for (const ms of [250, 1000]) {
        confirmTimers.push(
          window.setTimeout(() => {
            if (!alive || currentPageRef.current !== back) return;
            const shown = shownPages();
            if (shown.length === 0 || shown.includes(back)) return;
            viewer.navigateToPage(Navigation.EPAGE, back);
          }, ms),
        );
      }
    };

    // サムネイルは組み上がるのを待たない。出来たページから順に足していく
    // (長い本だと全部そろうまで十数秒かかり、その間なにも出ないため)
    thumbsRef.current?.destroy();
    const thumbs = stripRef.current
      ? createThumbs(
          stripRef.current,
          (i) => {
            currentPageRef.current = i;
            viewer.navigateToPage(Navigation.EPAGE, i);
            thumbs?.setActive(i);
            // 章の一覧は出さない。navigateToPage の表示切り替えは非同期なので、
            // ここで読むと切り替わる前の見開きを掴んでしまう。あとに来る nav が正す
          },
          // **ref 越しに呼ぶ。** effect は html と view と visible でしか走らないので、
          // ここで関数そのものを閉じ込めると古いものを掴んだままになる
          {
            onAdd: onAddInsert ? (k, before) => insertRef.current.add?.(k, before) : undefined,
            addKinds: () => insertRef.current.kinds ?? ['plate', 'colpage', 'blank'],
            onMove: (k, id, before, at) => insertRef.current.move?.(k, id, before, at),
            onDelete: (k, id) => insertRef.current.del?.(k, id),
            onCopy: (k, id) => insertRef.current.copy?.(k, id),
          },
        )
      : null;
    thumbsRef.current = thumbs;
    thumbs?.setBusy(true);

    /**
     * 組み上がった面を見せ、**前に見せていた面を退かせる。**
     * 新しい面を出してから古いほうを消す。逆順にすると1フレームだけ何も無い
     * 瞬間ができて、ちらつきに見える
     */
    const show = () => {
      inner.style.opacity = '1';
      inner.style.pointerEvents = '';
      const old = liveInnerRef.current;
      if (old && old !== inner) {
        old.style.opacity = '0';
        old.style.pointerEvents = 'none';
      }
      liveInnerRef.current = inner;
      // ページ送り・倍率・goToPage は**いま見えている面**に効かせる
      viewerRef.current = viewer;
      // いま出した面に、仕上がり線があるか(ボタンを出すかどうか)
      setHasTrim(inner.hasAttribute('data-trim'));
    };

    /**
     * 保険。**組み上がりの合図が来なくても覆いは外す。**
     * 隠れたまま何も見えないほうが、途中経過が見えるより悪い
     */
    const safety = setTimeout(() => {
      // 合図が来なくても、隠したままにはしない(途中経過でも見えるほうがまし)
      // **見せる前に、いまできているぶんの中で見ていたページへ寄せる。**
      // ここで戻さずに面だけ出すと、待たされたあげく扉に立たされる。
      // restored は立てない — あとから本当の組み上がりが来たら、そちらが戻し直す
      const els = pageEls();
      const back = Math.min(currentPageRef.current, Math.max(0, els.length - 1));
      if (back > 0 || !shownPages().includes(0)) viewer.navigateToPage(Navigation.EPAGE, back);
      show();
      setBusy(false);
      // **一覧の札もここで消す。** 覆いだけ消して札を残すと、
      // 「中央は終わったのに一覧は作り続けている」という嘘の画面になる
      thumbs?.setBusy(false);
      countingRef.current?.(false);
    }, 60000);

    /**
     * **1ページ目ができた時点で紙を出す。**(2026-08-22)
     *
     * ## なぜ要るか
     *
     * > 297頁で3分くらいで画面が見えるようになって、全部が見えるようになるまでに
     * > さらに10分以上かかる(2026-08-21 ユーザー)
     *
     * Vivliostyle は**2段構えで組む**(node_modules を読んで確認):
     *
     *   renderPagesUpto(いま見るページ) → readyState = 'interactive'
     *   → countEPages → renderAllPages() → readyState = 'complete'
     *
     * つまり**1ページ目はとっくに出来ている**のに、こちらは `complete` しか
     * 見ていなかったので、全部組み上がるまで覆いを外さなかった。
     * 実測(297ページの実原稿=組み上がり361ページ・`scripts/app-probe.tsx`):
     * 紙が1枚できるのは 3.3秒、覆いが外れるのは 14.5秒。**11秒は待つ必要が無かった。**
     * この直しで **14.5秒 → 3.4秒**。全部組み上がるのは後ろで続く(14.3秒)
     *
     * ## まだ1枚も出していないときだけ
     *
     * 組み直しのときは**前の紙面がそのまま見えている**ので、
     * 途中の1ページ目に差し替えるのは改悪になる
     * (2026-08-19 ユーザー報告「扉ページが上に重なって、今いるページを見ることができない」)。
     * だから出すのは「まだ何も出していない = 取り込んだ直後の1冊目」のときだけ。
     * 覆いは消さずに**隅の小さい札**に変えて、あと何ページ増えたかを出し続ける
     */
    const earlyShow = () => {
      if (liveInnerRef.current) return; // すでに紙が出ている。差し替えない
      if (pageEls().length === 0) return;
      show();
      setHasPage(true);
      /**
       * **ここから先のページ送りは覚える。**
       *
       * 紙を出した以上、利用者はもうめくれる。覚えはじめないと、
       * 組み上がったあとの組み直し(ノドの書き戻しなど)で1ページ目に引き戻される。
       *
       * 組版の途中に飛んでくる `nav` は、**1ページ目にいるときだけ `epage` を持つ**
       * (node_modules の `countEPages` のコールバック。値は 0)。
       * いまはその1ページ目にいるので、0 で上書きされても何も失われない
       */
      restored = true;
    };

    const poll = setInterval(() => {
      const els = pageEls();
      thumbs?.sync(els);
      setBuilt(els.length);
    }, 700);

    // ---- この回のあいだだけ効く聞き耳。面を作るときに立てた口へ差し込む ----
    buf.job = {
      // ページ移動のたびに現在ページを覚える(payload.epage は0始まり)
      onNav: (payload) => {
        /*
         * **いま見せている面なら、回が片づいたあとでもページ送りを追う。**(2026-10-09 見直しで発見)
         * 下見を隠して戻す(表紙の工程・電子の下見・入口画面から戻る)と、この回は片づけ(alive=false)られるが、
         * 原稿が同じなら組み直さない近道で帰るので、新しい聞き耳が立たない。alive だけで弾くと、
         * 戻ってからのページ送りがすべて捨てられ、帯の「この章だけ／コラム」も現在ページも止まっていた
         * (これより前からあった穴)。組みかけの面は restored が立つまで弾き、ほかの面が見えたら弾く
         */
        if (!restored || (!alive && liveInnerRef.current !== inner)) return;
        if (typeof payload.epage === 'number' && Number.isFinite(payload.epage)) {
          currentPageRef.current = Math.round(payload.epage);
          thumbsRef.current?.setActive(currentPageRef.current);
        }
        // **DOM が実際に切り替わったあとに読む。** nav が届いた時点では、まだ前の見開きが
        // 出ていることがある(2026-10-09 ユーザー報告「コラムのページにめくってきたのに、帯で
        // 本全体しか選べない」。実測: ［次 ▶］でめくると、帯の選択肢がいつも1つ前の見開きのものだった)。
        // その場でも読み(遅れない環境ではこれで足りる)、描き替えの2コマあとと、念のため少しあとにも読み直す
        const report = () => {
          if (alive || liveInnerRef.current === inner) visibleChaptersRef.current?.(...visibleSections(inner));
        };
        report();
        requestAnimationFrame(() => requestAnimationFrame(report));
        setTimeout(report, 250);
      },

      /**
       * 目次の章題を押したら、その章のページへ送る。
       *
       * 組版された目次は `<a href="#ch1">` で、押すと指の形のカーソルまで出るのに、
       * **何も起きなかった**(2026-08-20 ユーザーの確認「クリックしても
       * スタジオ内ではジャンプできないんですよね？」)。原因は Vivliostyle の作りで、
       * 本の中へのリンクは `preventDefault()` したうえで hyperlink という報せを投げ、
       * **どこへ飛ぶかは組み込んだ側が決める**ことになっている。
       * 受け取る先を書いていなかったので、押しても飛び先が決まらないままだった。
       *
       * 飛ばす先は `navigateToInternalUrl` に渡すだけでよい(ページ番号を自分で
       * 探さなくてよい)。飛んだあとは通常のページ送りと同じく nav が飛んでくるので、
       * いま見ているページも章の一覧もそちらが正す
       */
      onHyper: (payload) => {
        // 目次の章題も、ページ送りと同じく「いま見せている面」なら効かせる(上の onNav と同じ理由)
        if ((!alive && liveInnerRef.current !== inner) || !payload.internal || !payload.href) return;
        viewer.navigateToInternalUrl(payload.href);
      },

      onReady: () => {
        if (!alive) return;
        // **1ページ目ができた合図。**(上の earlyShow を参照)
        // ここで紙を出すと、長い本でも待たされずに読みはじめられる
        if (viewer.readyState === 'interactive') {
          earlyShow();
          return;
        }
        // 追い越された組み直しが遅れて上がることがある。その結果でページ数や版面を
        // 書き換えると、画面と食い違った値が残る
        if (viewer.readyState !== 'complete') return;
        clearInterval(poll);
        // この面は組み上がった。次の組み直しは、もう片方の面へ行ってよい
        if (buildingRef.current === buf) buildingRef.current = null;
        // この原稿・この見方は組み上がった。隠して戻っただけなら次は組み直さない
        renderedRef.current = { html, view };
        try {
          /**
           * **いちばん先に、見ていたページへ戻す。**
           *
           * もとは組み上がりの報せ(ページ数・版面)を先に出していた。この2本は
           * どちらも例外を投げうる(差し替え中の `getPageSizes` など)ので、
           * 落ちると catch へ抜けて**復元だけが飛ばされ**、新しい面が1ページ目(扉)の
           * まま出てしまう。しかも記憶(currentPageRef)は前のページのまま残るので、
           * **次の1回からはちゃんと戻る** — 「1回目だけ扉に飛ばされて、2回目からは
           * 今いたページにいる」という報せ(2026-08-20)はこの形をしている。
           * 落ちようのない処理(DOM を数えるだけ)で戻し切ってから、報せを出す。
           */
          const els = pageEls();
          // ページ数は組版器に訊かず DOM から数える。ここで例外を出さないため
          const total = els.length;
          // 見ていたページへ戻す。ページ数が減っていたら末尾で止める
          const back = Math.min(currentPageRef.current, Math.max(0, total - 1));
          currentPageRef.current = back;
          // ここから先の nav は利用者の操作なので、また覚えはじめる
          restored = true;
          // 送り出す前に仕掛ける。navigateToPage が落ちても後追いが拾えるように
          confirmPage(back);
          /*
           * **0 でも、いま 0 が出ていなければ送る。**(2026-10-09 全体確認)
           * 下見の面は2枚を使い回し、Vivliostyle は読み直しても前の文書で立っていた位置から描き始める。
           * 大扉(0)を見ているときに組み直しが終わると、もう片方の面の古い見開き(第一章など)が出て、
           * 帯の「大扉だけ」が本全体に落ち、変えた濃さ・フチが本全体へ書かれていた
           */
          const move = back > 0 || !shownPages().includes(0);
          if (move) viewer.navigateToPage(Navigation.EPAGE, back);

          // ここから先は「知らせる」処理。落ちても居場所は失わない
          pageCountRef.current?.(viewer.getPageSizes().length);
          layoutRef.current?.(readLayout(inner), html);
          thumbs?.sync(els);
          thumbs?.setActive(back);
          // **送らなかったときだけ、ここで章の一覧を読む。**
          // 送ったなら上の navigateToPage が表示を切り替えるが、その反映は
          // 非同期(nav で後から飛んでくる)なので、いまここで読むと切り替わる前の
          // 見開きを掴んでしまう。送っていなければ表示はすでに正しいので、
          // ここで読んで確定させる(nav が来ない唯一の道)
          if (!move) visibleChaptersRef.current?.(...visibleSections(inner));
        } catch {
          /* 組版が途中で差し替わった場合は無視する */
        } finally {
          // **覆いは必ず外す。** try の最後に置いていたら、途中の例外
          // (差し替え中の getPageSizes など)で外し忘れ、プレビューが
          // 隠れたままになった(2026-08-18 ユーザー報告)
          clearTimeout(safety);
          show();
          setHasPage(true);
          setBusy(false);
          /**
           * **ページ一覧の札(「ページを作っています…」)も必ず消す。**(2026-08-22)
           *
           * もとは try の中(sync の直後)で消していたので、その手前の例外
           * (差し替え中の getPageSizes / navigateToPage など)で飛ばされると、
           * **中央の覆いは消えるのに一覧の札だけ永遠に残った**
           * (ユーザー報告: 297ページの本で「中央の読み込み中は1分30秒で消えたのに、
           *  ページ一覧の読み込み中は7分たっても消えない」)。覆いと同じ finally に置く
           */
          thumbs?.setBusy(false);
          // **数え終わった。** ここまでは画面に「数えています…」を出しておく
          countingRef.current?.(false);
        }
      },
    };

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    viewer.loadDocument(
      { url },
      {},
      {
        // **毎回入れ直す。** 退いていたあいだに落とした設定を戻すため
        autoResize: true,
        renderAllPages: true,
        pageViewMode,
        fitToScreen,
        ...(fitToScreen ? {} : { zoom: zoomRef.current }),
      },
    );

    return () => {
      // **いちばん先に黙らせる。** 以降この回が投げるものは全部捨てる
      alive = false;
      clearInterval(poll);
      clearTimeout(safety);
      for (const t of confirmTimers) clearTimeout(t);
      // **面もビューアも捨てない。** 捨てる口が無いので、次の回で使い回す。
      // サムネイルも消さない — 消すと組み直しのあいだ一覧が空になる。
      // 次の回の頭で作り直している
      // Blob URL は読み込み途中の組版が参照している可能性があるので遅れて破棄
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
  }, [html, view, visible]);

  /**
   * 本を切り替えるとこの部品ごと入れ替わる(App の `key={settings.bookId}`)。
   * **ビューアは捨てられない**が、せめて窓の監視を外して面を片づける
   */
  useEffect(
    () => () => {
      for (const b of bufsRef.current ?? []) {
        b.job = null;
        /**
         * **走っている組版ごと止める。**(2026-08-22)
         * 本を切り替えた(または開発時の StrictMode の一度目の)面は、
         * もう誰も見ないのに1冊を最後まで組み切っていた。ビューアは捨てられないが、
         * 組版タスクは打ち切れる。放すのはそこまででよい
         */
        cancelRender(b);
        // 窓の大きさが変わるたびに、もう誰も見ていない本を組み直させない
        try {
          b.viewer.setOptions({ autoResize: false });
        } catch {
          /* 組版の途中でも、片づけは止めない */
        }
        // **面はここで外さない。** React が容れもの(.preview-viewport)ごと片づける。
        // ここで外すと、開発時の StrictMode の二度がけで**組版の途中の面が
        // 描かれない木に落ちて**、目次のリーダー罫で止まった幽霊が毎回できる
      }
      bufsRef.current = null;
      buildingRef.current = null;
      thumbsRef.current?.destroy();
      thumbsRef.current = null;
      liveInnerRef.current = null;
      viewerRef.current = null;
      // 塗りパッチの <style> も片づける(次の本の分は次の instance が挿し直す)
      document.getElementById(PAINT_STYLE_ID)?.remove();
    },
    [],
  );

  /**
   * 倍率を変える。**組み直さない。**
   * html が変わっていないのに組み直すと、そのたびに全ページを組み直すことになる
   */
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    if (zoom === 0) v.setOptions({ fitToScreen: true });
    else v.setOptions({ fitToScreen: false, zoom });
  }, [zoom]);

  const nav = (dir: Navigation) => viewerRef.current?.navigateToPage(dir);

  /**
   * ホイールでページを送る。**連続スクロールの代わり。**
   *
   * 誌面はスクロールしない(上の PreviewView 参照)ので、そのままだとホイールが
   * どこにも効かず「動かない画面」に見える。手の動きはスクロールのまま、
   * 送られるものをページにする。
   * タッチパッドは1回の指の動きで何十回も飛んでくるので、間隔を空けて間引く
   */
  /**
   * 紙が窓からはみ出しているか。**はみ出していれば「見る場所を動かす」が先。**
   * 拡大したのに送りしかできないと、見たいところへ寄れない
   * (2026-08-20 ユーザー指摘「拡大してもドラッグできないから見たい箇所が拡大できない」)
   */
  const canPan = () => {
    const el = liveInnerRef.current;
    if (!el) return false;
    return el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2;
  };

  const wheelAt = useRef(0);
  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) < 4) return;
    /**
     * はみ出しているあいだは、まずホイールをそのまま送らせる(紙の中を動く)。
     * ただし**縦にもう動けないなら、ページ送りに切り替える。**
     *
     * 前は「はみ出していれば常に素通し」だった。120%程度の拡大では
     * **横だけ**がはみ出すことが多く、縦スクロールには行き場が無いので、
     * ホイールがどこにも効かない=「別のページに移動できない」になっていた
     * (2026-09-14 ユーザー報告。挿絵を足した直後に限らず、拡大中はいつでも起きる)。
     * 縦に余地があるあいだは今までどおり紙の中を動き、端に着いたら次へ送る
     */
    if (canPan()) {
      const el = liveInnerRef.current;
      if (el) {
        const canDown = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
        const canUp = el.scrollTop > 2;
        if (e.deltaY > 0 ? canDown : canUp) return; // まだ紙の中を動ける
      }
    }
    const now = Date.now();
    if (now - wheelAt.current < 220) return;
    wheelAt.current = now;
    nav(e.deltaY > 0 ? Navigation.NEXT : Navigation.PREVIOUS);
  };

  /**
   * 掴んで動かす。**拡大したときだけ効く。**
   * 収まっているときに掴めると、ページを送ろうとした手が滑って混乱する
   */
  const pan = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const onPanDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !canPan()) return;
    const el = liveInnerRef.current;
    if (!el) return;
    pan.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
    // **文字を選ばせない。**(2026-08-20 ユーザー指摘
    // 「拡大してドラッグするときに文字の指定が入ってしまう」)
    // 掴んだ瞬間に選択が始まると、紙が動かず青い帯だけが伸びる
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
  };
  const onPanMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = pan.current;
    const el = liveInnerRef.current;
    if (!s || !el) return;
    el.scrollLeft = s.l - (e.clientX - s.x);
    el.scrollTop = s.t - (e.clientY - s.y);
  };
  const onPanUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pan.current) return;
    pan.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // 組み直し中に呼ばれても意味がないので、そのときは何もしない
  useImperativeHandle(
    ref,
    () => ({
      goToPage: (page: number) => {
        const i = Math.max(0, page - 1);
        currentPageRef.current = i;
        viewerRef.current?.navigateToPage(Navigation.EPAGE, i);
        thumbsRef.current?.setActive(i);
      },
      currentPage: () => currentPageRef.current + 1,
      flashPage: (page: number) => thumbsRef.current?.flash(Math.max(0, page - 1)),
      notify: (text: string) => thumbsRef.current?.notify(text),
    }),
    [],
  );

  /**
   * 「全体」で収めているときの倍率を測る。
   *
   * **Vivliostyle はページの箱に `transform: scale()` を直に書き込む**ので、
   * 描画後の幅(getBoundingClientRect)と変形前の幅(offsetWidth)の比が、そのまま倍率になる。
   * fitToScreen の倍率を返す口はビューアに無いので、この手で読むしかない。
   *
   * 組み上がりは非同期なので、しばらく測り直す。画面の伸び縮みは ResizeObserver で拾う
   */
  useEffect(() => {
    if (zoom) return;
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      // **いま見えている面の中だけを測る。** 面は2枚あり、退いているほうは
      // opacity で隠しているだけなので、寸法は 0 にならない。
      // el(容れもの)から探すと、そちらの紙を掴んで別の倍率を出してしまう
      const boxes = Array.from(
        (liveInnerRef.current ?? el).querySelectorAll<HTMLElement>(
          '[data-vivliostyle-page-container]',
        ),
      );
      const box = boxes.find((b) => b.offsetWidth > 0 && b.getBoundingClientRect().width > 0);
      if (!box) return;
      const pct = Math.round((box.getBoundingClientRect().width / box.offsetWidth) * 100);
      if (pct > 0) setFitPct(pct);
    };
    measure();
    let left = 12;
    const t = setInterval(() => {
      measure();
      if (--left <= 0) clearInterval(t);
    }, 400);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      clearInterval(t);
      ro.disconnect();
    };
    // **紙が出たとき・組み上がったとき・画面に戻ってきたときにも測り直す**(2026-10-02)。
    // html が届いてから 4.8秒のうちに紙が出なかったとき(入口の画面で待っていた・長い本・遅い PC)、
    // 倍率が 0 のまま残っていた。仕上がり線の太さはこの倍率で割るので、残ると線が 0.4 画素になって見えない
  }, [zoom, html, view, visible, hasPage, busy]);

  /**
   * いま何倍で見えているか(%)。「全体」のときは測った値、そうでなければ指定値。
   * 縦中横の断り書き(TCY_HINT_PCT)を出すかどうかの判定に使う
   */
  const shownPct = zoom ? Math.round(zoom * 100) : fitPct;

  return (
    <>
      <div className={`preview-body${thumbsOn ? '' : ' no-thumbs'}`}>
        {/* サムネイルは組み上がったページの複製。画像化しないので誌面と食い違わない。
            **畳んでも作り続ける。** 出し直すたびに全ページを複製し直すのは高い */}
        <div className="thumbs" ref={stripRef} hidden={!thumbsOn} />
        <div
          className={`preview-viewport${zoom ? ' pannable' : ''}${trimShown ? ' show-trim' : ''}${showArea ? ' show-area' : ''}`}
          /* 仕上がり線の太さを画面の上で一定にするための倍率(app.css の .show-trim の規則が割り算に使う) */
          style={{ '--pv-zoom': shownPct > 0 ? shownPct / 100 : 1 } as CSSProperties}
          ref={containerRef}
          onWheel={onWheel}
          onPointerDown={onPanDown}
          onPointerMove={onPanMove}
          onPointerUp={onPanUp}
          onPointerCancel={onPanUp}
        />
        {/* 組み直しのあいだの覆い。**外すのは見ていたページへ戻したあと**。
            覆わないと、新しいビューアが1ページ目から描くところが見えてしまい、
            「直すたびに大扉へ飛ぶ」ように読める */}
        {/* **専門用語を出さない。** 「組んでいます」は組版の言葉で、
            初めての人には何が起きているのか分からない(2026-08-19 ユーザー指摘) */}
        {/* **2回目からは覆わない。** 前の誌面が残っているので、隠すと
            「毎回まっさらから作り直している」ように見える(2026-08-19 ユーザー指摘)。
            出来たことだけ隅で知らせて、紙面はそのまま読ませる */}
        {busy && (
          <div className={hasPage ? 'preview-busy small' : 'preview-busy'} aria-live="polite">
            {/* 待っているあいだのカエル(2026-10-06 ユーザー要望「大人かわいい」)。
                出ているのは組み直しのあいだだけなので、「常に見えているのは1画面1匹」(FrogMark.tsx)には数えない */}
            <span className="busy-frog" aria-hidden="true">
              <FrogPeek width={hasPage ? 22 : 46} />
            </span>
            <b>ページを作っています…</b>
            <span>{built > 0 ? `${built} ページできました` : 'しばらくお待ちください'}</span>
          </div>
        )}
      </div>
      {/* 縦中横の断り書き。**小さく出しているときだけ添える。**(2026-08-20 ユーザー指摘)
          「プレビューではずれて見えるのに、書き出しの下見ではきれいに入っている」。
          実測すると**組み方はどちらも同じ**で、違うのは画面に収める倍率だけだった
          (見開き 26.6% / 単ページ 53.3%。同じページの縦中横を測ると、
           字の箱の大きさも隣の字との間隔も 1/1000px まで一致した)。
          縦中横は半角の字を1文字ぶんの枠に詰めるので、枠の中の字が小さく、
          小さく描くほど画素への丸めが効いて片寄って見える。**実害は無い。**
          放っておくと組み間違いだと読まれるので、そう見える倍率のときだけ一言置く */}
      {shownPct > 0 && shownPct < TCY_HINT_PCT && (
        <p className="preview-hint" title="画面に収めるための縮小で起きる見え方です。組み方そのものは倍率で変わりません(実測)。倍率を上げるか、［単ページ］にして大きく見ると揃って見えます。">
          表示が小さいので、<b>横に並べた数字</b>が寄って見えることがあります。書き出したものには出ません
        </p>
      )}
      {/* 仕上がり線の説明。縦中横の断り書きと同じ場所なので、両方出るときは1段上に置く */}
      {showArea && areaHint && (
        <p className={`preview-hint area${shownPct > 0 && shownPct < TCY_HINT_PCT ? ' upper' : ''}`} role="status">
          <i className="area-swatch" aria-hidden="true" />
          赤い線は<b>版面</b>（本文の入る範囲）。<b>赤く塗った所</b>が、版面の外に出ている<b>画像の中の文字</b>です
        </p>
      )}
      {trimShown && !(showArea && areaHint) && (trimHint || trimHover) && (
        <p
          className={`preview-hint trim${shownPct > 0 && shownPct < TCY_HINT_PCT ? ' upper' : ''}`}
          role="status"
        >
          <i className="trim-swatch" aria-hidden="true" />
          点線は<b>仕上がり線</b>（裁つ位置）。<b>外側は切り落とされる</b>ので、余白は<b>点線の内側</b>で見ます。線は印刷されません
        </p>
      )}
      {/* 見せ方の切り替えと、ページ送り。**同じ帯に置く。**
          どちらも「いまどこを見るか」の操作で、探す場所が2つあると迷う */}
      <div className="page-nav">
        {modeSwitch && (
          <>
            {modeSwitch}
            <span className="page-nav-sep" />
          </>
        )}
        <button
          className={thumbsOn ? 'on' : ''}
          aria-pressed={thumbsOn}
          onClick={() => setThumbsOn((v) => !v)}
        >
          ページ一覧
        </button>
        <span className="page-nav-sep" />
        {/* 書き出しの下見のあいだは止める。1ページずつで出るものを
            見開きで見せると、そのまま刷られると読める(2026-08-19 ユーザー指摘) */}
        <button
          className={view === 'spread' ? 'on' : ''}
          aria-pressed={view === 'spread'}
          disabled={!!forceView}
          title={forceView ? '書き出す物を選んでいるあいだは、刷り上がりと同じ単ページで出します' : undefined}
          onClick={() => setView('spread')}
        >
          見開き
        </button>
        <button
          className={view === 'single' ? 'on' : ''}
          aria-pressed={view === 'single'}
          disabled={!!forceView}
          title={forceView ? '書き出す物を選んでいるあいだは、刷り上がりと同じ単ページで出します' : undefined}
          onClick={() => setView('single')}
        >
          単ページ
        </button>
        {/* 仕上がり線。**塗り足しのある紙の下見だけ**(電子書籍・塗り足しの無い紙には出さない) */}
        {hasTrim && (
          <button
            className={trimOn ? 'on trim-toggle' : 'trim-toggle'}
            aria-pressed={trimOn}
            aria-label="仕上がり線"
            title="裁つ位置の線（仕上がり線）を下見に出します。線の外側（塗り足し）は切り落とされるので、余白は線の内側で見ます。線は印刷されません"
            onClick={toggleTrim}
            onMouseEnter={() => setTrimHover(true)}
            onMouseLeave={() => setTrimHover(false)}
            onFocus={() => setTrimHover(true)}
            onBlur={() => setTrimHover(false)}
          >
            <i className="trim-swatch" aria-hidden="true" />
            {/* 狭い画面では字を畳んで見本の点線だけにする(app.css の .trim-label)。読み上げには aria-label が残る */}
            <span className="trim-label">仕上がり線</span>
          </button>
        )}
        <span className="page-nav-sep" />
        {/* 表示倍率。**表紙と同じ形にそろえる。**(2026-08-20 ユーザー要望)
            「全体」は画面に収める指定に戻す(組版側の fitToScreen) */}
        <span className="page-zoom">
          <input
            type="range"
            min={0.4}
            max={2}
            step={0.1}
            value={zoom || 1}
            aria-label="表示倍率"
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          {/* **既定でも％で出す。**「全体」とだけ出ていると、いま何倍で見ているのか
              読めない。収めているときは測った倍率を出し、隣のボタンで「全体」へ戻す */}
          <b>{zoom ? `${Math.round(zoom * 100)}%` : fitPct ? `${fitPct}%` : '—'}</b>
          <button
            className={zoom === 0 ? 'on' : ''}
            title="画面に収まる大きさに戻します"
            onClick={() => setZoom(0)}
          >
            全体
          </button>
        </span>
        <span className="page-nav-sep" />
        <button onClick={() => nav(Navigation.FIRST)} title="最初のページ">|◀</button>
        <button onClick={() => nav(Navigation.PREVIOUS)} title="前へ">◀ 前</button>
        <button onClick={() => nav(Navigation.NEXT)} title="次へ">次 ▶</button>
        <button onClick={() => nav(Navigation.LAST)} title="最後のページ">▶|</button>
      </div>
    </>
  );
});
