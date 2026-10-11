// 版面の帯。**いつでも触れる場所に、いつでも効くものを置く。**
//
// 書体・サイズ・行送り・段組み・色・フチ・帯は、もとは工程レールの「見た目」だった。
// だが工程ではない — 絵を入れているときも、奥付を書いているときも、
// 表紙を作っているときも、**そのつど戻って変えたくなる**。
// 一度決めて次へ進むもの(工程)と、ずっと手元に置いておくもの(道具)は別で、
// 後者をレールに並べていたのが間違いだった。
//
// **逆に、判型・組み方向・目次・刷り色・用紙・ノンブル・柱は帯から出した。**
// (2026-08-19 ユーザーの提案 → steps/ShapeStep.tsx)
// 一度は「本のかたち」「ページの端」として帯に板を置いたが、これらは決め切るもので、
// 往復するのは書体と文字まわりだけだった。帯に残すのは往復するものだけにする。
//
// **残った並びは2つのまとまり。**
//   1. 読みやすさ … 書体・サイズ・行送り・場面転換・段組み・段間・章はじめの大文字
//   2. 飾り       … 背景の濃さ・フチ・帯・文字の色
// 最後に［すべてリセット］。触るものの種類が変わるところに区切りを入れる。
//
// **場面転換(2026-08-21)を帯に入れたのは、決め切るものに見えて往復するものだから。**
// 「本1冊でひとつ」という点だけ見れば［本のかたちを決める］の目次・刷り色と同類だが、
// あちらは値そのものが答え(KDP の入稿画面で聞かれる)なのに対し、
// 場面転換は**自分の原稿のその場面でどう見えるかを見比べないと決められない**。
// 4つを順に選んで紙面を見る操作なので、プレビューの真下でなければ往復にならない。
// 帯が混むぶんは、**原稿に `---` が1つも無い本には出さない**ことで返している。
//
// 帯は2段。**上が操作、下が読み値。**
// 「版面の読み値は操作ではない」という InfoBar の切り分けはそのまま生きているので、
// 混ぜずに行を分けて、下の行(InfoBar)には手を入れない。
//
// **飾りは「本全体」と「この章だけ」を切り替えて使う。**(2026-08-19 ユーザーの発案)
// 色だけで5つ(本文・章見出し・小見出し・フチ・帯)あり、それを全体ぶんと章ぶんの
// 二列に並べると帯に載らない。**同じ操作を1セットだけ置き、書き込み先を切り替える。**
// 章を選べるのはプレビューでその章を開いているときだけ(chapterNow >= 0)。
// 章に自前の指定がある操作には印を付け、［×］で全体の値に戻せるようにする。
//
// **操作は畳まない。** はじめは組ごとに板を開く形にしたが、2つの理由でやめた:
//   1. 帯は横スクロールする(overflow-x)。**スクロール枠は中の絶対配置を切り取る**ので、
//      板が開いても見えなかった(2026-08-19 ユーザー報告「板は上に開きません」)
//   2. 「文字」と「行送り」のように**続けて2つ触りたい**ものが1枚の板に隠れると、
//      開くまで何があるのか分からない
// 幅が足りないぶんは横スクロールで逃がす。板を残すのは、中に章ごとの指定を抱える
// 「文字の色」だけ(そこだけ document.body へ出して、切り取られないようにする)。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BODY_FONTS,
  SCENE_BREAKS,
  THEME_BODY_FONT,
  hasSceneBreak,
  maxColumns,
  outputsOf,
  resolveBg,
  sceneBreakOf,
  titleWritingModeOf,
  type BgSpec,
  type BodyFontId,
  type Chapter,
  type ColumnPage,
  type ProjectSettings,
  type SceneBreakId,
} from '../models/project';
import {
  COVER_FONTS,
  defaultCoverSettings,
  type BandKind,
  type BlurbDecor,
  type CoverFontId,
} from '../models/cover';
import { useProject, type DesignScope } from '../store/useProject';
import type { MatterType } from '../models/project';
import type { FrontInk } from '../cover/render';
import type { PageLayout } from '../typeset/grid';
import { ColorInput } from './ColorInput';
import type { SpecialPage } from '../preview/VivliostylePreview';
import type { CoverPane } from './CoverEditor';

/** 大扉・目次・奥付の、背景の設定の置き場所と名札 */
const PAGE_BG_KEY = { title: 'titleBg', toc: 'tocBg', colophon: 'colophonBg' } as const;
const PAGE_LABEL: Record<SpecialPage, string> = { title: '大扉', toc: '目次', colophon: '奥付' };

/** 本文の帯が向いている先。本全体・章(番号)・コラム(col:id)・大扉／目次／奥付(page:名前) */
export type BarScope = 'book' | number | `col:${string}` | `page:${SpecialPage}`;
import { InfoBar } from './InfoBar';

/**
 * 表1の文字の色について、色の欄のそばに出す断り書き。
 *
 * **「なぜその色で出ているのか」を言う。**(2026-08-20 ユーザー提案)
 * 濃い面のうえでは選んだ色が白に上書きされ、色の見本と刷り上がりが食い違う。
 * さらに **選んでも上書きは止まらない**(実測: 濃い地に赤 #e03030 を選んでも
 * 赤の画素は1つも出ない)ので、逃げ道まで書かないと直しようがない
 */
const FRONT_INK_NOTE: Record<FrontInk, ReactNode> = {
  picked: null,
  'auto-white-on-ground': (
    <>
      <b>地が濃いので自動で白にしています。</b>
      選んだ色は出ません。フチにするか、地を淡くしてください
    </>
  ),
  'auto-white-on-band': (
    <>
      <b>帯が濃いので自動で白にしています。</b>
      選んだ色は出ません。帯の色を淡くしてください
    </>
  ),
  outline: (
    <>
      文字にフチを付けているあいだは<b>自動で白にする動きを止めています</b>。書名・著者名は選んだ色のまま出ます
    </>
  ),
};

/**
 * 章ごとの指定を持つ設定の名前。**帯のスコープ切替はこの集合の上を動く。**
 * どれも `Record<番号, 値>` で、章に無ければ本全体の値を使う
 */
type ChapterMapKey =
  | 'chapterFont'
  | 'chapterFontPt'
  | 'chapterLineFeedPt'
  | 'chapterColumns'
  | 'chapterDropCap'
  | 'chapterTextColor'
  | 'chapterHeadingColor'
  | 'chapterSubheadingColor'
  | 'chapterPlate'
  | 'chapterPlateColor';

/** 帯に直に置くひと組。小さな見出しと、その操作そのもの */
function BarField({
  label,
  hint,
  children,
}: {
  label: string;
  /** 値のうしろに添える短い読み(濃さの%など)。説明文は置かない */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="barfield">
      <span className="barfield-label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      {children}
    </label>
  );
}

/**
 * 中身の多い組だけの板。**document.body へ出す。**
 *
 * 帯は横スクロールするので、帯の中に絶対配置で置くと切り取られて見えない。
 * ポータルで外へ出し、ボタンの位置から座標を測って**上へ**開く
 * (帯は画面のいちばん下なので、下へ出すと画面外になる)。
 */
function BarMenu({
  label,
  value,
  width = 300,
  children,
}: {
  label: string;
  value: ReactNode;
  /** 板の幅。中身の多い組(読みやすさ・飾り)は広げる */
  width?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ left: 0, bottom: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const PANEL_W = width;

  // 開くたびにボタンの位置を測る(帯は横スクロールするので、前回の値は当てにならない)
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setBox({
      // 画面の右端からはみ出さないところまで戻す
      left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)),
      bottom: window.innerHeight - r.top + 8,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        className={open ? 'barmenu-btn on' : 'barmenu-btn'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="barfield-label">{label}</span>
        <span className="barmenu-value">{value}</span>
        <span className="barmenu-caret">{open ? '▾' : '▴'}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="barmenu-panel"
            style={{ left: box.left, bottom: box.bottom, width: PANEL_W }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

interface Props {
  /**
   * いま画面に出ている章の番号(0始まり)。章の順に並ぶ。**見開きなら2つ入ることがある。**
   * 「この章だけ」の選択肢をここから作る。章に属さないページ(コラム・挿絵・扉・
   * 目次・奥付)しか映っていない見開きでは空配列(2026-08-20 ユーザー報告で単一の
   * ページ番号からの逆算をやめ、いま画面にある紙面から直に受け取る形にした)
   */
  visibleChapters: number[];
  /**
   * いま画面に出ているコラムページの id。**出ていれば「このコラムだけ」を選べるようにし、
   * 出てきたときはそれに切り替える。**(2026-10-08 ユーザー要望)
   * コラムを見ながら帯で字の色を白にしたら、本全体の字が白くなって本文が消えた。
   * 背景の濃さは帯で動いた(コラムは本全体の濃さを継ぐ)ので、色も帯で変えるものと思うのが自然。
   * 見開きの反対側が章のこともあるので、「本全体」「この章」も選べるまま残す
   */
  visibleColumns?: string[];
  /**
   * いま画面に出ている大扉・目次・奥付。**出ていれば「このページだけ」を選べるようにする。**
   * 自動では向かない(本を開くと1ページ目が大扉なので、帯が「大扉だけ」で始まってしまう)。［背景］タブで開いたときは scopeRequest で向く。
   * そのページの背景の濃さ・文字のフチを変える(2026-10-09。左の欄から帯へ移した)
   */
  visiblePages?: SpecialPage[];
  /**
   * 帯の向き先を外から変える合図(連番つき)。**［背景］タブで章や大扉などの背景を開いたとき、帯もそこへ向ける。**
   * 濃さ・文字のフチは帯でしか変えられなくなった(2026-10-09)ので、開いた面と帯の向き先がずれないようにする
   */
  scopeRequest?: { scope: BarScope; seq: number };
  /**
   * 表紙の左でいま開いている面。**表紙の帯は、その面の文字に向く**(表1・まるごと1枚 → 書名・著者名、
   * 表4 → あらすじ、背 → 背の文字)。帯の左端で選び直せる(2026-10-09)
   */
  coverPane?: CoverPane;
  /** 背に文字を刷るか(背幅が足りて「刷る」にしているとき)。刷らないときは「背の文字」を出さない */
  coverSpineText?: boolean;
  /**
   * 帯に何を出すか。**その工程で効くものだけを出す。**(2026-08-19 ユーザー指摘)
   *
   * - `body`     本文の工程。書体・サイズ・行送り・飾り・段組み・大文字の全部
   * - `cover`    表紙。本文の操作は1つも出さない。表紙の「読ませ方」や書名の色は
   *              絵を見ながらいちばん往復する操作なので、こちらに入れ替える
   * - `colophon` 奥付。**奥付の紙面に効くものだけ。**
   *              段組みも章はじめの大文字も奥付には掛からないし、
   *              「この章だけ」は奥付に章が無いので意味がない
   * - `none`     AI と書き出し。**帯そのものを出さない。**
   *              どちらも版面を触る画面ではなく、下に操作列があると迷う
   */
  barMode?: 'body' | 'cover' | 'colophon' | 'none';
  /**
   * 表1の書名・著者名の色が、実際にはどう決まって刷られたか(CoverEditor が描いた結果)。
   * **色の欄のそばで断るのに使う。**
   *
   * > 表１の文字の色が地の色と同じになっているけど、これは地が濃いから自動で
   * > 白抜きにしているよね？ 注釈入れたほうがいいのでは(2026-08-20 ユーザー)
   *
   * 色の見本と刷り上がりが食い違うのは、**濃い面のうえでは選んだ色が白に上書きされる**
   * から。欄を見ただけでは分からないので、描いた側から受け取って言う
   */
  coverFrontInk?: FrontInk;
  /**
   * いま開いている工程の色(StepRail の STEP_ACCENT)。
   * **レールの下線と帯の左端に同じ色を出す。** 帯は工程によって中身が
   * 入れ替わるのに見た目が同じで、変わったことに初見では気づけなかった
   * (2026-08-19 ユーザー指摘)
   */
  accent?: string;
  settings: ProjectSettings;
  layout: PageLayout;
  chapters: Chapter[];
  trimLabel: string;
  totalChars: number;
  pageCount: number;
  estPages: number;
  /** まだページ数を数えている最中か。**当てにならない数は出さない**(InfoBar へ渡す) */
  counting?: boolean;
  /**
   * 右の下見がいま電子書籍か。**電子の下見を見ているあいだは、書体の欄を「固定」の表示にする。**
   * 紙と電子の両方を作る本で、電子を見ながら書体を変えても下見は何も変わらない(書体は紙だけに効く)
   */
  ebookView?: boolean;
  /** 右の下見を紙へ切り替える(書体の断りの中の［紙の下見に切り替える］) */
  onShowPaper?: () => void;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  /* **applyPreset はもう受け取らない。**(2026-08-20)
     ［すべてリセット］が借りていたが、あれは判型・組み方向を決め直すためのもので、
     戻るのは文字サイズ・行送り・余白の3つだけだった。帯のリセットは
     store の resetDesign が担う(判型は［本のかたちを決める］の持ちものに戻した) */
}

export function FormatBar({
  visibleChapters: visibleOnPaper,
  visibleColumns: columnsOnPaper = [],
  visiblePages: pagesOnPaper = [],
  scopeRequest,
  coverPane = 'front',
  coverSpineText = false,
  barMode = 'body',
  coverFrontInk = 'picked',
  accent,
  settings,
  layout,
  chapters,
  trimLabel,
  totalChars,
  pageCount,
  estPages,
  counting,
  ebookView = false,
  onShowPaper,
  setSettings,
}: Props) {
  /**
   * **電子の下見を見ているあいだは「◯章だけデザインする」を出さない。**(2026-09-24)
   * 章ごとに変えられるものは、どれも紙だけに効く(書体・サイズ・行送り・飾り・段組み)。
   * しかも visibleChapters は隠れている紙の下見の最後の見開きから来た古い値。
   * 選んでいた章は scope に残るので、紙の下見へ戻ればその章の選択に戻る
   */
  const visibleChapters = ebookView ? [] : visibleOnPaper;
  const maxCols = maxColumns(settings.trim, settings.writingMode);
  const fontId = settings.bodyFont ?? THEME_BODY_FONT[settings.theme];
  const currentFont = BODY_FONTS[fontId] ?? BODY_FONTS[THEME_BODY_FONT[settings.theme]];
  const mono = settings.ink === 'mono';
  const cover = useProject((s) => s.cover);
  const setCover = useProject((s) => s.setCover);
  /**
   * ［すべてリセット］の中身。**帯だけが使うので、App を経由せず店から直に取る。**
   * (cover / setCover と同じ扱い。props を1本増やすほどの筋のものではない)
   */
  const resetDesign = useProject((s) => s.resetDesign);
  const chapterBody = settings.chapterTextColor ?? {};
  const chapterHead = settings.chapterHeadingColor ?? {};
  const chapterSub = settings.chapterSubheadingColor ?? {};
  /**
   * 選択肢の中でいちばん近い段。**保存された値が選択肢に無いことがある**
   * (AI が返した JSON、古い保存、以前のサンプルが持っていた 0.78 など)。
   * 素通しすると select が先頭を映してしまい、「なし」と出ているのに色バーが並ぶ
   */
  const nearest = (v: number, steps: number[]) =>
    v <= 0 ? 0 : steps.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  /**
   * 触っている対象。**「本全体」か「特定の章」か。**
   * 章は番号そのもので持つ(見開きに2つ章があるとき、どちらを選んだかを覚える必要がある)。
   * 章に切り替えたまま扉や目次へ送ると、その章が見開きから外れて選べなくなるが、
   * 状態は保ったままなので、その章がまた見開きに出てくれば選択に復帰する
   * (2026-08-19 の挙動をそのまま踏襲。以前は「章だけ」という真偽値だったが、
   * 見開きに複数の章がまたがるとどれを指すか決められないので、章番号そのものにした)
   */
  const [scope, setScope] = useState<BarScope>('book');
  /**
   * **作り直された帯は、それより前の合図を聞かない。**(2026-10-09 見直しで発見)
   * 帯は本を開き直すたび・入口画面から戻るたびに作り直される。-1 から始めると、App に残っている
   * 古い合図(前に開いた章の背景)をもう一度受けて、帯が勝手にその章へ向いていた
   */
  const scopeSeq = useRef(scopeRequest?.seq ?? -1);
  /**
   * 合図で向き先を変えた直後は、コラムの自動の切り替えを少し待たせる。合図と一緒に下見がその面へ飛ぶので、
   * 飛んだ先の見開きにコラムがあると、合図で向けた章を上書きしていた(2026-10-09 見直しで発見)
   */
  const holdAutoUntil = useRef(0);
  useEffect(() => {
    if (!scopeRequest || scopeRequest.seq === scopeSeq.current) return;
    scopeSeq.current = scopeRequest.seq;
    holdAutoUntil.current = performance.now() + 1500;
    setScope(scopeRequest.scope);
  }, [scopeRequest]);
  /** 選んだ章がいま見開きに出ているときだけ有効。出ていなければ本全体扱いに落ちる */
  const chapterNow = typeof scope === 'number' && visibleChapters.includes(scope) ? scope : -1;
  /** 電子の下見のあいだは章と同じく出さない(コラムの見た目は紙だけに効く) */
  const visibleCols = ebookView ? [] : columnsOnPaper;
  const columnPages = settings.columnPages ?? [];
  /**
   * 選んだコラム。**章と同じく、いま画面に出ているときだけ有効。** 出ていなければ本全体に落ちる。
   * 書き込み先は ColumnPage の欄。**コラムの見た目を変えるのはこの帯だけ**(2026-10-09 に左の欄から外した)
   */
  const colId = typeof scope === 'string' && scope.startsWith('col:') ? scope.slice(4) : '';
  const colNow: ColumnPage | undefined =
    barMode === 'body' && colId && visibleCols.includes(colId)
      ? columnPages.find((c) => c.id === colId)
      : undefined;
  const byColumn = !!colNow;
  /**
   * **コラムのページが画面に出てきたら、帯をそのコラムに向ける。**
   * 新しく出てきたときだけ切り替え、出ているあいだに「本全体」や「この章」へ戻したら、それを守る
   */
  // 見たかどうかは紙の下見の値で数える(電子の下見を見ているあいだ空になる visibleCols で数えると、
  // 紙へ戻るたびに同じコラムを「新しく出てきた」と読んで、選び直した向き先を上書きしていた)
  const seenCols = useRef<string[]>([]);
  const colsKey = columnsOnPaper.join('\n');
  useEffect(() => {
    const fresh = columnsOnPaper.find((id) => !seenCols.current.includes(id));
    seenCols.current = columnsOnPaper;
    if (fresh && barMode === 'body' && !ebookView && performance.now() >= holdAutoUntil.current) {
      setScope(`col:${fresh}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsKey, barMode]);
  /**
   * コラムの名札。見出しが空のコラムもある。**何枚目かでは呼ばない** — 左の欄の「◯枚目」は
   * ページ順に並べ直した番号で、columnPages の並びとは一致しない
   */
  const columnLabel = (id: string) => {
    const title = columnPages.find((c) => c.id === id)?.title.trim();
    return title ? `コラム「${title}」` : 'コラム（見出しなし）';
  };
  /**
   * 選んだ大扉・目次・奥付。**コラムと同じく、いま画面に出ているときだけ有効。**(2026-10-09)
   * そのページの背景の濃さ・文字のフチ(titleBg / tocBg / colophonBg)だけを変える。
   * 以前は左の欄(［背景］タブ・［奥付］の工程)にしか無かった。見た目は帯にそろえる、というユーザー判断で移した
   */
  const visiblePgs = ebookView ? [] : pagesOnPaper;
  const pageId = typeof scope === 'string' && scope.startsWith('page:') ? (scope.slice(5) as SpecialPage) : null;
  const pageNow: SpecialPage | null =
    barMode === 'body' && pageId && visiblePgs.includes(pageId) ? pageId : null;
  const byPage = pageNow !== null;
  /*
   * **大扉・目次・奥付は、出てきても自動では向かない。** 選択肢に並ぶだけ(［背景］タブで開いたときは合図で向く)。
   * 自動で向けていたころ、本を開くと1ページ目(大扉)で帯が「大扉だけ」になり、書体・サイズなどが
   * 隠れたまま始まっていた。目次とコラムが同じ見開きに出ると、コラムを開いても目次に取られた(2026-10-09 見直しで発見)
   */
  /**
   * 背景の濃さ・フチを書き込む、1ページの面。帯がそのページを向いているとき(大扉・目次・奥付)と、
   * ［奥付］の工程(奥付のページの背景。奥付と著者紹介の両方に効く)
   */
  const pageBgKey: 'titleBg' | 'tocBg' | 'colophonBg' | null = pageNow
    ? PAGE_BG_KEY[pageNow]
    : barMode === 'colophon'
      ? 'colophonBg'
      : null;
  const pageBg: BgSpec | undefined = pageBgKey ? settings[pageBgKey] : undefined;
  /**
   * 大扉・目次・奥付に、いま絵が出ているか。**出ていなければ「背景の濃さ」は出さない**(動かしても何も変わらない。
   * 奥付は既定で無地)。左の欄の調整も「その面に実際に絵が出るときだけ」出していた(2026-10-09 見直しで発見)
   */
  const pageBgShown = !pageBgKey || !!resolveBg(pageBg, settings).src;
  const setPageBg = (patch: Partial<BgSpec>) => {
    if (!pageBgKey) return;
    const spec: BgSpec = { ...(settings[pageBgKey] ?? {}), ...patch };
    for (const k of Object.keys(spec) as (keyof BgSpec)[]) {
      if (spec[k] === undefined) delete spec[k];
    }
    setSettings({ [pageBgKey]: Object.keys(spec).length ? spec : undefined });
  };
  /**
   * 奥付の工程で、いま触っているのが奥付か著者紹介か。
   * **同じページに並ぶが役目が違う**(書誌の記録と、読ませる文章)ので
   * 別々に決められる必要がある(2026-08-19 ユーザー要望)
   */
  const [matter, setMatter] = useState<'colophon' | 'profile'>('colophon');
  /**
   * 表紙の帯が向いている文字。**書名・著者名／あらすじ／背の文字。**(2026-10-09 ユーザー判断
   * 「デザインに関連する話が左バーにあったら、それは下のバーで作業できるように」)。
   * あらすじの書体・読ませ方、背の文字の書体・色・向きは、もとは左の欄(表4・背)にあった。
   * 左で開いている面が変わったら、それに合わせて向き直す(選び直したものは、面が変わるまで守る)
   */
  const [coverTarget, setCoverTarget] = useState<'title' | 'blurb' | 'spine'>('title');
  useEffect(() => {
    setCoverTarget(coverPane === 'back' ? 'blurb' : coverPane === 'spine' ? 'spine' : 'title');
  }, [coverPane]);
  /** 奥付には章が無いので、「この章だけ」は出さない(出しても書き込む先が無い) */
  const byChapter = barMode === 'body' && chapterNow >= 0 && !!chapters[chapterNow];
  /** 章の名札。番号だけだと見開きに2つ出たときにどちらの話か読めない(章題まで出す) */
  const chapterLabel = (i: number) =>
    (chapters[i] && [chapters[i].no, chapters[i].title].filter(Boolean).join('　')) ||
    `${i + 1}つめの章`;
  const chapterName = chapterNow >= 0 ? chapterLabel(chapterNow) : '';

  /**
   * コラムの欄を書き換える。**undefined を渡した欄は落として、本文と同じに戻す**
   * (欄が無い = 本文と同じ、という持ち方。0 は「なし」という指定なので消さない)
   */
  const colPatch = (patch: Partial<ColumnPage>) => {
    if (!colNow) return;
    const next: ColumnPage = { ...colNow, ...patch };
    for (const k of Object.keys(patch) as (keyof ColumnPage)[]) {
      if (patch[k] === undefined) delete next[k];
    }
    setSettings({ columnPages: columnPages.map((x) => (x.id === colNow.id ? next : x)) });
  };
  /** scoped() と同じ形の口。コラムに自前の指定が無ければ、継いでいる値(fallback)を見せる */
  function columnPick<K extends keyof ColumnPage>(
    key: K,
    fallback: NonNullable<ColumnPage[K]>,
  ): { value: NonNullable<ColumnPage[K]>; set: (v: ColumnPage[K] | undefined) => void; overridden: boolean } {
    const own = colNow?.[key];
    return {
      value: (own ?? fallback) as NonNullable<ColumnPage[K]>,
      set: (v) => colPatch({ [key]: v } as Partial<ColumnPage>),
      overridden: own !== undefined,
    };
  }
  /** コラム側の［×］。押すとその欄(と、対になる色)を落として本文と同じに戻す */
  const colReset = (...keys: (keyof ColumnPage)[]) =>
    byColumn && keys.some((k) => colNow?.[k] !== undefined) ? (
      <button
        className="barswatch-reset"
        title="このコラムの指定をやめて、本文と同じに戻す"
        onClick={() => colPatch(Object.fromEntries(keys.map((k) => [k, undefined])))}
      >
        ×
      </button>
    ) : null;

  // コラムは章の外なので、自前の指定が無ければ本全体の帯を継いで出る(紙面と同じ値を見せる)
  const platePick = byColumn
    ? columnPick('plate', settings.textPlate ?? 0)
    : scoped<'textPlate', number>('textPlate', 'chapterPlate', 0);
  const plateStep = nearest(platePick.value, [0.75, 0.95]);
  const plateColorPick = byColumn
    ? columnPick('plateColor', settings.textPlateColor ?? '#ffffff')
    : scoped<'textPlateColor', string>('textPlateColor', 'chapterPlateColor', '#ffffff');

  /**
   * 帯に置く色見本。**名前は色の下に小さく。**
   * 横一列に3つ並べるので、名前を左に置くと幅が3倍になる。
   * `inherited` が true(= 自前の指定を持たない)ときは、継いでいる色を薄い枠で示し、
   * 戻すボタンも出さない(戻すものが無い)
   */
  const swatch = (
    name: string,
    value: string,
    onChange: (v: string) => void,
    inherited = false,
    onReset?: () => void,
  ) => (
    <span className={inherited ? 'barswatch inherited' : 'barswatch'} key={name}>
      <ColorInput
        value={value}
        aria-label={name}
        onChange={(e) => onChange(e.target.value)}
      />
      <em>{name}</em>
      {!inherited && onReset && (
        <button className="barswatch-reset" title={`${name}を全体と同じに戻す`} onClick={onReset}>
          ×
        </button>
      )}
    </span>
  );
  /** 背景の濃さとフチは chapterBg(BgSpec)が持っている。そこだけ書き込み方が違う */
  const chBg = (chapterNow >= 0 && (settings.chapterBg ?? {})[chapterNow]) || undefined;
  const setChapterBg = (patch: Partial<BgSpec>) => {
    const next = { ...(settings.chapterBg ?? {}) };
    const spec = { ...(next[chapterNow] ?? {}), ...patch };
    for (const k of Object.keys(spec) as (keyof BgSpec)[]) {
      if (spec[k] === undefined) delete spec[k];
    }
    if (Object.keys(spec).length) next[chapterNow] = spec;
    else delete next[chapterNow];
    setSettings({ chapterBg: next });
  };
  /**
   * 背景の濃さとフチは chapterBg(BgSpec)の中にある。ほかの章ごとの設定と
   * 持ち方が違うので scoped() には乗らない。読み書きをここで揃えておく
   */
  /**
   * コラムでは、背景の濃さは地(bg.opacity。章と同じ BgSpec)、フチは ColumnPage の
   * outline / outlineColor に書く。濃さは自前の絵が無くても効く(本文の絵を継いで、濃さだけ変わる)
   */
  const colBgWith = (patch: Partial<BgSpec>): BgSpec | undefined => {
    const spec: BgSpec = { ...(colNow?.bg ?? {}), ...patch };
    for (const k of Object.keys(spec) as (keyof BgSpec)[]) {
      if (spec[k] === undefined) delete spec[k];
    }
    return Object.keys(spec).length ? spec : undefined;
  };
  // 書き込み先の順: コラム → 大扉・目次・奥付(帯がそのページを向いているとき、または［奥付］の工程) → 章 → 本全体
  const opacityNow = byColumn
    ? (colNow.bg?.opacity ?? settings.bgOpacity)
    : pageBgKey
      ? (pageBg?.opacity ?? settings.bgOpacity)
      : ((byChapter ? chBg?.opacity : undefined) ?? settings.bgOpacity);
  const outlineNow = byColumn
    ? (colNow.outline ?? settings.textOutline)
    : pageBgKey
      ? (pageBg?.outline ?? settings.textOutline)
      : ((byChapter ? chBg?.outline : undefined) ?? settings.textOutline);
  const outlineColorNow = byColumn
    ? (colNow.outlineColor ?? settings.textOutlineColor)
    : pageBgKey
      ? (pageBg?.outlineColor ?? settings.textOutlineColor)
      : ((byChapter ? chBg?.outlineColor : undefined) ?? settings.textOutlineColor);
  const outlineStep = nearest(outlineNow, [0.05, 0.09]);
  const setOpacity = (v: number) =>
    byColumn
      ? colPatch({ bg: colBgWith({ opacity: v }) })
      : pageBgKey
        ? setPageBg({ opacity: v })
        : byChapter
          ? setChapterBg({ opacity: v })
          : setSettings({ bgOpacity: v });
  const setOutline = (v: number) =>
    byColumn
      ? colPatch({ outline: v })
      : pageBgKey
        ? setPageBg({ outline: v })
        : byChapter
          ? setChapterBg({ outline: v })
          : setSettings({ textOutline: v });
  const setOutlineColor = (v: string) =>
    byColumn
      ? colPatch({ outlineColor: v })
      : pageBgKey
        ? setPageBg({ outlineColor: v })
        : byChapter
          ? setChapterBg({ outlineColor: v })
          : setSettings({ textOutlineColor: v });
  /** BgSpec 側の［×］。chapterBg は色と絵も抱えているので、消すのはその項目だけ */
  const resetBg = (k: 'opacity' | 'outline') =>
    byColumn ? (
      k === 'opacity' ? (
        colNow.bg?.opacity !== undefined ? (
          <button
            className="barswatch-reset"
            title="このコラムの指定をやめて、本文と同じに戻す"
            onClick={() => colPatch({ bg: colBgWith({ opacity: undefined }) })}
          >
            ×
          </button>
        ) : null
      ) : (
        colReset('outline', 'outlineColor')
      )
    ) : pageBgKey ? (
      pageBg?.[k] !== undefined ? (
        <button
          className="barswatch-reset"
          title="このページの指定をやめて、本文と同じに戻す"
          onClick={() =>
            setPageBg(k === 'opacity' ? { opacity: undefined } : { outline: undefined, outlineColor: undefined })
          }
        >
          ×
        </button>
      ) : null
    ) : byChapter && chBg?.[k] !== undefined ? (
      <button
        className="barswatch-reset"
        title="この章の指定をやめて、本全体と同じに戻す"
        onClick={() => setChapterBg({ [k]: undefined })}
      >
        ×
      </button>
    ) : null;

  /**
   * 奥付・著者紹介の見た目。**章とは別の入れもの。**
   * 章は Record<番号, 値> だが、こちらは1つのオブジェクト(MatterType)なので
   * scoped() には乗らない。同じ形の口だけそろえて、画面側は同じ書き方で使えるようにする
   */
  const isMatter = barMode === 'colophon';
  /** 紙を作るか。作らない本には EPUB に入らない飾りと段組みを出さない(3. 飾り のコメント) */
  const paper = outputsOf(settings).paper;
  /**
   * **帯に紙だけの欄を出すか。** 電子書籍だけの本に加えて、両方を作る本で**電子の下見を見ている
   * あいだも出さない**(2026-09-24 ユーザー判断「サイズ・行送りも書体と同じ扱いに」)。
   * 帯は右の下見に効くものを触る場所なので、電子を見ているときは電子書籍だけの本と同じ帯にそろえる。
   * 書体とサイズ・行送りは、消すと「どこへ行った」になるので、押すと理由が出る固定の表示に替える
   */
  const paperBar = paper && !ebookView;
  /**
   * 電子書籍では変えられないものを押したときの断り(大きな字の板)。
   * 'font' = 書体(固定) / 'size' = 文字の大きさ・行送り(読む人が決める)
   */
  const [notice, setNotice] = useState<null | 'font' | 'size'>(null);
  /** 断りを開いたボタン。閉じたらそこへフォーカスを返す(キーボードで帯の頭からやり直させない) */
  const noticeOpener = useRef<HTMLElement | null>(null);
  const openNotice = (kind: 'font' | 'size') => {
    noticeOpener.current = document.activeElement as HTMLElement | null;
    setNotice(kind);
  };
  /**
   * 開いているあいだ: Esc で閉じる・Tab は板の中のボタンだけを回る(aria-modal と食い違わせない)。
   * 閉じたら開いたボタンへ戻す。［紙の下見に切り替える］で閉じたときはそのボタンが消えているので、
   * 紙の帯の書体の欄へ送る
   */
  useEffect(() => {
    if (!notice) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNotice(null);
        return;
      }
      if (e.key !== 'Tab') return;
      const btns = [...document.querySelectorAll<HTMLButtonElement>('.font-fixed-dialog button')];
      if (!btns.length) return;
      e.preventDefault();
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.shiftKey ? (i <= 0 ? btns.length - 1 : i - 1) : (i + 1) % btns.length;
      btns[next].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const opener = noticeOpener.current;
      noticeOpener.current = null;
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>('.formatbar .barfontpick select')?.focus();
    };
  }, [notice]);
  /**
   * 紙の下見へ切り替えたら(または紙の本だけになったら)、出しっぱなしにしない。
   * **帯の種類が変わったときも閉じる。**(2026-09-24 レビューで発見) 表紙・AI・書き出しの帯は
   * この板を描かないので、開いたまま工程を移ると見えないまま残り、本文の工程へ戻った瞬間に
   * ひとりでに出てきた
   */
  useEffect(() => {
    setNotice(null);
  }, [paperBar, barMode]);
  const noticeBoard = notice
    ? createPortal(
        <div className="about-backdrop" onClick={() => setNotice(null)}>
          <div
            className="about font-fixed-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="font-fixed-title"
            onClick={(e) => e.stopPropagation()}
          >
            {notice === 'font' ? (
              <>
                <p className="font-fixed-big" id="font-fixed-title">
                  <span aria-hidden="true">⚠</span> 電子書籍の書体は変えられません
                </p>
                <p className="font-fixed-what">
                  本文は<b>明朝</b>、見出しと太字は<b>ゴシック</b>で固定です。
                </p>
                <p>
                  電子書籍は、<b>読む人の端末（Kindle・スマホなど）が書体を決めます</b>。
                  スタジオでほかの書体を選んでも、読む人には届きません。
                </p>
                {paper && (
                  <p>
                    書体を選べるのは<b>紙の本</b>だけです。紙の書体は、右の下見を<b>［紙の本］</b>にすると、
                    この帯で変えられます。
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="font-fixed-big" id="font-fixed-title">
                  <span aria-hidden="true">⚠</span> 電子書籍の文字の大きさは、読む人が決めます
                </p>
                <p className="font-fixed-what">
                  文字の大きさと行の間隔は、<b>読む人が端末で変えます</b>。
                </p>
                <p>
                  電子書籍には決まったページがありません。文字の大きさは本に入れず、
                  最初は<b>読む人の端末の標準の大きさ</b>で出ます。右の下見の<b>［文字 小・中・大］</b>で、
                  大きさを変えたときの見え方を確かめられます。
                </p>
                {paper && (
                  <p>
                    文字の大きさ・行送りや、背景の濃さ・文字の色などの飾りを決められるのは<b>紙の本</b>だけです。
                    右の下見を<b>［紙の本］</b>にすると、この帯で変えられます。
                  </p>
                )}
              </>
            )}
            <div className="font-fixed-actions">
              {paper && onShowPaper && (
                <button
                  className="go-step"
                  onClick={() => {
                    setNotice(null);
                    onShowPaper();
                  }}
                >
                  紙の下見に切り替える
                </button>
              )}
              <button autoFocus onClick={() => setNotice(null)}>
                わかりました
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;
  const matterKey = matter === 'colophon' ? 'colophonType' : 'profileType';
  const matterNow = (settings[matterKey] ?? {}) as MatterType;
  function matterPick<K extends keyof MatterType>(
    key: K,
    fallback: NonNullable<MatterType[K]>,
  ): { value: NonNullable<MatterType[K]>; set: (v: MatterType[K]) => void; overridden: boolean } {
    return {
      value: (matterNow[key] ?? fallback) as NonNullable<MatterType[K]>,
      set: (v) => {
        const next: MatterType = { ...matterNow };
        if (v === undefined || (v as unknown) === '') delete next[key];
        else next[key] = v;
        setSettings({ [matterKey]: next });
      },
      overridden: matterNow[key] !== undefined,
    };
  }
  /** 奥付側の［×］。押すとその項目だけ落として本文と同じに戻る */
  const matterReset = (key: keyof MatterType) =>
    isMatter && matterNow[key] !== undefined ? (
      <button
        className="barswatch-reset"
        title="この指定をやめて、本文と同じに戻す"
        onClick={() => {
          const next: MatterType = { ...matterNow };
          delete next[key];
          setSettings({ [matterKey]: next });
        }}
      >
        ×
      </button>
    ) : null;

  const fontPick = isMatter
    ? matterPick('bodyFont', fontId)
    : byColumn
      ? columnPick('bodyFont', fontId)
      : scoped<'bodyFont', BodyFontId>('bodyFont', 'chapterFont', fontId);
  const shownFont = BODY_FONTS[fontPick.value] ?? currentFont;
  // 奥付と著者紹介は既定で本文の 0.9 倍。画面にもその値を出す
  const fontPtPick = isMatter
    ? matterPick('fontPt', +(settings.fontPt * 0.9).toFixed(2))
    : byColumn
      ? columnPick('fontPt', settings.fontPt)
      : scoped<'fontPt', number>('fontPt', 'chapterFontPt', settings.fontPt);
  const feedPick = isMatter
    ? matterPick('lineFeedPt', settings.lineFeedPt)
    : byColumn
      ? columnPick('lineFeedPt', settings.lineFeedPt)
      : scoped<'lineFeedPt', number>('lineFeedPt', 'chapterLineFeedPt', settings.lineFeedPt);
  /**
   * 見出しの書体・サイズ。**奥付とコラムだけ**(本文の章見出しの書体は本全体で1つなので出さない)。
   * どちらも「空なら本文について動く」
   */
  const headFontNow = isMatter ? matterNow.headingFont : colNow?.headingFont;
  const setHeadFont = (v: BodyFontId | undefined) =>
    isMatter ? matterPick('headingFont', fontId).set(v) : colPatch({ headingFont: v });
  const headPtNow = isMatter ? matterNow.headingPt : colNow?.headingPt;
  const setHeadPt = (v: number | undefined) =>
    isMatter ? matterPick('headingPt', 0).set(v) : colPatch({ headingPt: v });
  const headReset = (k: 'headingFont' | 'headingPt') => (isMatter ? matterReset(k) : colReset(k));
  /**
   * 画面に出す行送り。**サイズだけ変えた章は、組版側が比を保って行送りも変える。**
   * (css.ts: 行送りの指定が無い章は fontPt x 本全体の比)。
   * そこを見せずに本全体の 15.5pt を出すと、刷り上がりと数字が食い違う
   */
  const feedAuto = !feedPick.overridden && fontPtPick.overridden;
  const feedExact = feedAuto
    ? +(fontPtPick.value * (settings.lineFeedPt / settings.fontPt)).toFixed(2)
    : feedPick.value;
  /**
   * **欄に入れる数は、欄の刻み(0.5)にそろえる。**(2026-10-12 1.0.3。修正リストの 15)
   * 比から出した 13.03 のような数をそのまま入れると、Chrome が刻みに合わない値と見なして
   * 「有効な値を入力してください」の吹き出しを出し、狭い欄では「13.0…」と切れて見えた。
   * 組版は丸めない(css.ts のまま。作りかけの本のページ割りを動かさない)。差は 0.25pt 以下。
   * 倍率(×1.53 など)は丸める前の値から出す
   */
  const feedShown = feedAuto ? Math.round(feedExact * 2) / 2 : feedExact;
  /** 見出しの［×］。章と奥付で入れものが違うので、ここで振り分ける */
  const mark = (chapterKey: ChapterMapKey, matterField: keyof MatterType & keyof ColumnPage) =>
    isMatter
      ? matterReset(matterField)
      : byColumn
        ? colReset(matterField)
        : resetMark(chapterKey);
  const colPick = scoped<'columns', number>('columns', 'chapterColumns', settings.columns);
  const dropPick = scoped<'dropCap', number>('dropCap', 'chapterDropCap', 0);

  /**
   * 章ごとの設定を1つ書き換える。**undefined を渡すと章ごと落として全体に戻る。**
   * 0 は「なし」という指定なので消さない(帯の「なし」が消えると全体の帯が出てしまう)
   */
  const setChapterValue = <V,>(key: ChapterMapKey, i: number, v: V | undefined) => {
    const next: Record<number, unknown> = {
      ...((settings[key] ?? {}) as Record<number, unknown>),
    };
    if (v === undefined || v === '') delete next[i];
    else next[i] = v;
    setSettings({ [key]: next });
  };
  /** その章に自前の指定があるか */
  const own = (key: ChapterMapKey) =>
    chapterNow >= 0 &&
    (settings[key] as Record<number, unknown> | undefined)?.[chapterNow] !== undefined;

  /**
   * スコープに応じた読み書き。**画面の操作はこれ1本しか見ない。**
   * 全体スコープなら settings の値をそのまま、章スコープなら
   * 「章の値 ?? 全体の値」を見せ、書き込みは章の側へ行く
   */
  function scoped<K extends keyof ProjectSettings, V>(
    globalKey: K,
    chapterKey: ChapterMapKey,
    fallback: V,
  ): { value: V; set: (v: V | undefined) => void; overridden: boolean } {
    const g = (settings[globalKey] as V | undefined) ?? fallback;
    if (!byChapter) {
      return {
        value: g,
        set: (v) => setSettings({ [globalKey]: v }),
        overridden: false,
      };
    }
    const c = (settings[chapterKey] as Record<number, V> | undefined)?.[chapterNow];
    return {
      value: c ?? g,
      set: (v) => setChapterValue(chapterKey, chapterNow, v),
      overridden: c !== undefined,
    };
  }

  /**
   * 章スコープのときだけ出す［×］。押すとその章の指定を落として全体に戻る。
   * 指定が無いときは何も出さない(戻すものが無い)
   */
  const resetMark = (key: ChapterMapKey) =>
    byChapter && own(key) ? (
      <button
        className="barswatch-reset"
        title="この章の指定をやめて、本全体と同じに戻す"
        onClick={() => setChapterValue(key, chapterNow, undefined)}
      >
        ×
      </button>
    ) : null;

  /**
   * 表紙のときの帯。**本文の操作は1つも出さない。**
   * 表紙の画面で本文の書体や行送りを触れても意味がないし、
   * 「文字のフチ」のように名前が同じで中身の違う操作が並ぶと必ず取り違える
   * (本文のフチは textOutline、表紙のフチは band === 'outline')
   */
  /**
   * **AI と書き出しでは帯そのものを出さない。**(2026-08-19 ユーザー指摘)
   * どちらも版面を触る画面ではない。下に操作列が残っていると、
   * 「ここで何か決めるのか」と読み手の手が止まる
   */
  if (barMode === 'none') return null;

  if (barMode === 'cover') {
    const c = cover;
    const setC = (patch: Partial<typeof c>) => setCover(patch);
    // 選べない向き先(紙を作らない本のあらすじ・背に字を刷らない本の背)を向いていたら、書名・著者名に落とす
    const target =
      (coverTarget === 'blurb' && !paper) || (coverTarget === 'spine' && !(paper && coverSpineText))
        ? 'title'
        : coverTarget;
    const fontSelect = (
      value: CoverFontId,
      onChange: (v: CoverFontId) => void,
      label: string,
    ) => (
      <select
        aria-label={label}
        style={{ fontFamily: (COVER_FONTS[value] ?? COVER_FONTS.serif).stack }}
        value={value}
        onChange={(e) => onChange(e.target.value as CoverFontId)}
      >
        {(Object.keys(COVER_FONTS) as CoverFontId[]).map((k) => (
          <option key={k} value={k} style={{ fontFamily: COVER_FONTS[k].stack }}>
            {COVER_FONTS[k].label}
          </option>
        ))}
      </select>
    );
    return (
      <div className="formatbar" style={{ ['--step-accent' as string]: accent }}>
        <div className="formatbar-tools">
          {/* **名札が向き先の切り替え。**本文の帯(本全体／章／コラム)と同じ形。
              あらすじは紙の本の表4、背の文字は背に字を刷るときだけ(作らない面の欄は出さない) */}
          <label className="barscope">
            <select
              value={target}
              onChange={(e) => setCoverTarget(e.target.value as 'title' | 'blurb' | 'spine')}
            >
              <option value="title">書名・著者名をデザインする</option>
              {paper && <option value="blurb">あらすじをデザインする</option>}
              {paper && coverSpineText && <option value="spine">背の文字をデザインする</option>}
            </select>
          </label>

          {target === 'title' && (
          <>

          {/* 絵の上に文字を読ませる方法。「下に敷く(帯)」か「字を縁取る(フチ)」の2通り。
              帯は確実に読めるが絵を隠し、フチは絵をほとんど隠さない。
              **もとはサイドバーにあった。** 絵を見ながらいちばん往復する操作なので帯へ移した */}
          <BarField label="文字を読ませる">
            <span className="num">
              <select value={c.band} onChange={(e) => setC({ band: e.target.value as BandKind })}>
                <option value="auto">おまかせ</option>
                <option value="custom">下に帯を敷く</option>
                <option value="outline">文字にフチ</option>
                <option value="none">なし</option>
              </select>
              {c.band === 'custom' && (
                <ColorInput
                  className="barcolor"
                  aria-label="帯の色"
                  value={c.bandColor}
                  onChange={(e) => setC({ bandColor: e.target.value })}
                />
              )}
              {c.band === 'outline' && (
                <ColorInput
                  className="barcolor"
                  aria-label="フチの色"
                  value={c.bandOutlineColor}
                  onChange={(e) => setC({ bandOutlineColor: e.target.value })}
                />
              )}
            </span>
          </BarField>

          {c.band !== 'outline' && c.band !== 'none' && (
            <BarField label="帯の濃さ" hint={`${Math.round(c.bandOpacity * 100)}%`}>
              <input
                className="barrange"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={c.bandOpacity}
                onChange={(e) => setC({ bandOpacity: Number(e.target.value) })}
              />
            </BarField>
          )}
          {/* 帯のフチ。サイドバーの［書名・著者名の帯］と同じ値(どちらで変えても同じ) */}
          {c.band !== 'outline' && c.band !== 'none' && (
            <BarField label="帯のフチ">
              <span className="num">
                <select
                  value={c.bandSoft ? 'soft' : 'hard'}
                  onChange={(e) => setC({ bandSoft: e.target.value === 'soft' })}
                >
                  <option value="hard">くっきり</option>
                  <option value="soft">ぼかす</option>
                </select>
              </span>
            </BarField>
          )}

          <span className="barsep" />

          {/* **色見本と同じ行に断りを置く。** 別の場所に書くと、見本と刷り上がりが
              食い違って見えている当人には届かない(色の欄を見ているから)。
              **下に積んではいけない。** 帯は横に流れる並びなので、1つだけ背の高い組を
              作ると帯の丈がそのぶん伸び、色を触るたびに誌面が上下する
              (実測: 見本の下に置くと帯が 68px → 131px になった) */}
          <BarField label="文字の色">
            <span className="barswatches">
              {swatch('書名', c.titleColor, (v) => setC({ titleColor: v }))}
              {swatch('著者名', c.authorColor, (v) => setC({ authorColor: v }))}
              {FRONT_INK_NOTE[coverFrontInk] && (
                <span className="barink">{FRONT_INK_NOTE[coverFrontInk]}</span>
              )}
            </span>
          </BarField>

          <BarField label="書名の書体">
            {fontSelect(c.titleFont, (v) => setC({ titleFont: v }), '書名の書体')}
          </BarField>
          <BarField label="著者名の書体">
            {fontSelect(c.authorFont, (v) => setC({ authorFont: v }), '著者名の書体')}
          </BarField>

          {/* **書名の向きを表紙の帯にも置く。**(2026-10-09 ユーザー要望「表紙デザイン組みながら
              絶対探す機能」) 値は［本のかたちを決める］の［書名と著者名を横書きにする］と同じ
              titleWritingMode(どちらで変えても同じ)。縦書きの本のときだけ(横書きの本は書名もいつも横)。
              外したら設定ごと消す(省略 = 本文に従う)のも、あちらのチェックと同じ */}
          {settings.writingMode === 'vertical' && (
            <BarField label="書名・著者名の向き">
              <select
                title="大扉や電子書籍の扉も同じ向きになります（本文・柱・奥付は変わりません）"
                value={titleWritingModeOf(settings)}
                onChange={(e) =>
                  setSettings({
                    titleWritingMode: e.target.value === 'horizontal' ? 'horizontal' : undefined,
                  })
                }
              >
                <option value="vertical">縦書き</option>
                <option value="horizontal">横書き</option>
              </select>
            </BarField>
          )}

          </>
          )}

          {/* **あらすじ。**(2026-10-09 左の欄の表4から移した) 書体と、絵の上で読ませる方法(地・フチ)。
              「文字を読ませる」(書名の帯)と名前を分ける: 名前が同じで中身の違う操作が並ぶと取り違える */}
          {target === 'blurb' && (
            <>
              <BarField label="あらすじの書体">
                {fontSelect(c.blurbFont, (v) => setC({ blurbFont: v }), 'あらすじの書体')}
              </BarField>
              <BarField label="あらすじを読ませる">
                <span className="num">
                  <select
                    value={c.blurbDecor}
                    onChange={(e) => setC({ blurbDecor: e.target.value as BlurbDecor })}
                  >
                    <option value="none">なし</option>
                    <option value="band">地を敷く</option>
                    <option value="outline">文字にフチ</option>
                  </select>
                  {c.blurbDecor === 'band' && (
                    <ColorInput
                      className="barcolor"
                      aria-label="地の色"
                      value={c.blurbBandColor}
                      onChange={(e) => setC({ blurbBandColor: e.target.value })}
                    />
                  )}
                  {c.blurbDecor === 'outline' && (
                    <ColorInput
                      className="barcolor"
                      aria-label="フチの色"
                      value={c.blurbOutlineColor}
                      onChange={(e) => setC({ blurbOutlineColor: e.target.value })}
                    />
                  )}
                </span>
              </BarField>
              {c.blurbDecor === 'band' && (
                <BarField label="地の濃さ" hint={`${Math.round(c.blurbBandOpacity * 100)}%`}>
                  <input
                    className="barrange"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={c.blurbBandOpacity}
                    onChange={(e) => setC({ blurbBandOpacity: Number(e.target.value) })}
                  />
                </BarField>
              )}
            </>
          )}

          {/* **背の文字。**(2026-10-09 左の欄の［背］から移した) 書体・向き・色。
              「まるごと1枚」では［背］の面が開けないので、背の文字の色を変える道がここにしか無い */}
          {target === 'spine' && (
            <>
              <BarField label="背の文字の書体">
                {fontSelect(c.spineFont, (v) => setC({ spineFont: v }), '背の文字の書体')}
              </BarField>
              <BarField label="文字の向き">
                <select
                  value={c.spineSideways ? 'sideways' : 'vertical'}
                  onChange={(e) => setC({ spineSideways: e.target.value === 'sideways' })}
                >
                  <option value="vertical">縦に積む（和書の定番）</option>
                  <option value="sideways">横に倒す</option>
                </select>
              </BarField>
              <BarField label="文字の色">
                <span className="barswatches">
                  {swatch('背の文字', c.spineTextColor, (v) => setC({ spineTextColor: v }))}
                </span>
              </BarField>
            </>
          )}

          <span className="barsep" />

          {/* **本文用紙だけは残す。** 表紙の設定ではあるが、決めた場所は
              ［本のかたちを決める］で、背幅の計算に使う値。ここで戻すと
              「かたち」で決めたことが表紙のリセットで消える */}
          <button
            className="barbtn barreset"
            title="表紙の地・文字の色・書体・位置に加え、あらすじ・背の書名・まるごと1枚の画像も、はじめの状態に戻します（本文用紙はそのまま）"
            onClick={() => {
              // **消えるものを名指しする。** blurb(あらすじ)・spineTitle(背の書名)・
              // wrap/wrapSaved(まるごと1枚の絵)まで空に戻す。
              // 「デザイン」としか言わないと、打ち込んだあらすじが消えて驚く(2026-09-04 レビュー指摘)
              if (
                !window.confirm(
                  '表紙をはじめの状態に戻しますか？\n\n' +
                    '地・文字の色・書体・位置に加えて、あらすじ・背の書名・改行位置・' +
                    'まるごと1枚の画像も消えます。\n（Ctrl+Z で元に戻せます）',
                )
              )
                return;
              // setCover はマージ型なので、**既定に無い欄は名指しで消す**。
              // defaultCoverSettings() を渡すだけだと wrap/wrapSaved/modeStash/mode が
              // 生き残り、「まるごと1枚の絵も消えます」の約束が嘘になるうえ、
              // リセット後の切り替えで控えの飾りがそっくり復活する(2026-09-04 レビューで実証)
              setCover({
                ...defaultCoverSettings(),
                paper: cover.paper,
                wrap: undefined,
                wrapSaved: undefined,
                modeStash: undefined,
                mode: undefined,
              });
            }}
          >
            すべてリセット
          </button>

          {/* **本文の帯とちがって読み値の行は出さない。** 版面の字数も総字数も
              表紙には関わりがなく、出すと表紙の値だと読み違える */}
          <p className="barnote">
            {target === 'title' ? (
              <>
                書名・著者名の位置・大きさ・改行位置は左の欄で。<b>画像の主役に文字がかぶるときは位置を動かします</b>
              </>
            ) : target === 'blurb' ? (
              // まるごと1枚では［表4］の面が無く、あらすじの欄は［まるごと1枚］の中にある(2026-10-09 見直しで発見)
              coverPane === 'wrap'
                ? 'あらすじの文章は、左の欄の［まるごと1枚］で入力します'
                : 'あらすじの文章は、左の欄の［表4］で入力します'
            ) : coverPane === 'wrap' ? (
              // まるごと1枚では［背］の面が開けない。背に載せる項目と大きさは「面ごとに作る」の［背］で決める
              '背に載せる項目（著者名・版元名）やその大きさは、「面ごとに作る」に切り替えたあとの［背］で設定します'
            ) : (
              '背に載せる項目（著者名・版元名）や大きさは、左の欄の［背］で設定します'
            )}
          </p>
        </div>
      </div>
    );
  }

  /**
   * ［すべてリセット］が戻す先と、その言い方。
   *
   * **戻す範囲は「帯がいま向いている先」。** 帯は名札(本全体／◯章だけ／奥付／著者紹介)で
   * 書き込み先を切り替えながら使う道具なので、リセットもその先だけを戻す。
   * 向いていない先まで巻き込むと、章の色を直すつもりの1回で本全体の書体が飛ぶ。
   *
   * **「何が戻るか」を並べるのは確認の文だけにする。** ボタンの文字は範囲だけ。
   * 9項目をボタンに書くと帯が伸びるし、押す前に読ませたいのは範囲のほうなので
   */
  const resetScope: DesignScope = isMatter
    ? { kind: 'matter', key: matterKey }
    : byChapter
      ? { kind: 'chapter', index: chapterNow }
      : { kind: 'book' };
  const matterLabel = matter === 'colophon' ? '奥付' : '著者紹介';
  /** もう一方。背景の濃さ・文字のフチは1ページぶんの設定(colophonBg)なので、どちらのリセットでもこちらも戻る */
  const matterOther = matter === 'colophon' ? '著者紹介' : '奥付';
  const resetLabel = isMatter
    ? `${matterLabel}をリセット`
    : byColumn
      ? 'このコラムをリセット'
      : byPage
        ? `${PAGE_LABEL[pageNow]}をリセット`
        : byChapter
          ? 'この章をリセット'
          : 'すべてリセット';
  const resetTitle = isMatter
    ? `${matterLabel}の書体・サイズ・行送り・色と、${matterOther}と共通の「背景の濃さ・文字のフチ」を本文と同じに戻します`
    : byColumn
      ? `${columnLabel(colNow.id)}で変えた書体・サイズ・行送り・背景の濃さ・文字のフチ・下の帯・文字の色・文字のまわりの余白を、本文と同じに戻します（敷いた画像はそのまま）`
      : byPage
        ? `${PAGE_LABEL[pageNow]}の背景の濃さと文字のフチを、本文と同じに戻します（敷いた画像は残ります）`
        : byChapter
      ? `${chapterName}だけの指定をやめて、本全体と同じに戻します（この章に敷いた画像はそのまま）`
      : '書体・サイズ・行送り・余白・段組み・章はじめの大文字・場面転換・背景の濃さ・文字のフチ・本文の下の帯・文字の色・ノンブルと柱の書体を、はじめの状態に戻します（判型・組み方向・画像はそのまま）';
  /**
   * 押す前の確認。**取り消せることまで書く。**
   * 表紙の［すべてリセット］が先に同じ形を採っていて、そちらは「反応がない」と
   * 言われていない — 確認の窓が出ること自体が「押せた」という返事になっている
   */
  const resetConfirm = isMatter
    ? `${matterLabel}の見た目を、本文と同じに戻しますか？\n\n書体・文字サイズ・行送り・色・見出しの指定と、ページの背景の濃さ・文字のフチが戻ります。\n背景の濃さと文字のフチは${matterOther}と共通のため、そちらも戻ります（背景の画像は残ります）。\n（Ctrl+Z で元に戻せます）`
    : byColumn
      ? `${columnLabel(colNow.id)}だけの変更をやめて、本文と同じに戻しますか？\n\n書体・サイズ・行送り・見出し・背景の濃さ・文字のフチ・下の帯・文字の色・文字のまわりの余白が、本文の設定に戻ります。\nこのコラムに敷いた画像はそのまま残ります。\n（Ctrl+Z で元に戻せます）`
      : byPage
        ? `${PAGE_LABEL[pageNow]}の背景の濃さと文字のフチを、本文と同じに戻しますか？\n\n敷いた画像はそのまま残ります。\n（Ctrl+Z で元に戻せます）`
        : byChapter
      ? `${chapterName}だけの指定をやめて、本全体と同じに戻しますか？\n\n書体・サイズ・行送り・段の数・章はじめの大文字・背景の濃さ・文字のフチ・本文の下の帯・文字の色が、本全体の値に戻ります。\nこの章に敷いた画像は消えません。\n（Ctrl+Z で元に戻せます）`
      : '本全体のデザインを、はじめの状態に戻しますか？\n\n書体・文字サイズ・行送り・余白・段組み・章はじめの大文字・場面転換・背景の濃さ・文字のフチ・本文の下の帯・文字の色・ノンブルと柱の書体が戻ります。\n章ごとに変えた指定も消えます。\n判型・組み方向・画像・原稿はそのままです。\n（Ctrl+Z で元に戻せます）';

  return (
    <div
      className={byChapter || byColumn || byPage ? 'formatbar by-chapter' : 'formatbar'}
      style={{ ['--step-accent' as string]: accent }}
    >
      {noticeBoard}
      <div className="formatbar-tools">
        {/* **対象の切り替えが、帯の名札そのもの。**(2026-08-19)
            はじめは名札の隣に小さな select を置いたが、操作を平らに並べたら
            埋もれてしまった(ユーザー指摘)。**うしろへ動かす案もあったが、
            対象は他のすべての操作の意味を変えるので、先に読ませないと危ない**
            (本全体のつもりで1章だけ変えていた、という壊れ方をする)。
            名札と一体にすれば、いちばん先に読む語がそのまま対象になる。
            章のときは帯ぜんたいの地も変える(.formatbar.by-chapter) */}
        {barMode === 'colophon' ? (
          /* 章のかわりに「奥付／著者紹介」を選ぶ。名札と一体なのは本文の帯と同じ */
          <label className="barscope">
            <select
              value={matter}
              onChange={(e) => setMatter(e.target.value as 'colophon' | 'profile')}
            >
              <option value="colophon">奥付をデザインする</option>
              <option value="profile">著者紹介をデザインする</option>
            </select>
          </label>
        ) : (
          /* **見開きにまたがる章の数だけ選択肢を出す。**(2026-08-20 ユーザー報告)
             見開きに2つの章がまたがっているのに片方しか選べず、しかも前から進むか
             後ろから戻るかでどちらが出るかが変わっていた。visibleChapters は
             いま画面にある紙面から直に読んだものなので、両方が並ぶ。
             章に属さないページ(コラム・挿絵・扉・目次・奥付)しか映っていないときは
             visibleChapters が空になり、「本全体」だけが残る
             (「なし」の空箱を出さない、という決まりに合わせて disabled の選択肢は置かない) */
          /* コラムが画面にあれば、その数だけ「このコラムだけ」も並べる(2026-10-08)。
             出てきたときはそれが選ばれている(上の seenCols)ので、帯で変えた色がコラムにだけ効く */
          <label className={byChapter || byColumn || byPage ? 'barscope on' : 'barscope'}>
            <select
              value={
                byColumn
                  ? `col:${colNow.id}`
                  : byPage
                    ? `page:${pageNow}`
                    : byChapter
                      ? String(chapterNow)
                      : 'book'
              }
              onChange={(e) => {
                const v = e.target.value;
                setScope(
                  v === 'book'
                    ? 'book'
                    : v.startsWith('col:')
                      ? (v as `col:${string}`)
                      : v.startsWith('page:')
                        ? (v as `page:${SpecialPage}`)
                        : Number(v),
                );
              }}
            >
              <option value="book">本全体をデザインする</option>
              {visibleChapters.map((i) => (
                <option key={i} value={i}>
                  {chapterLabel(i)} だけデザインする
                </option>
              ))}
              {barMode === 'body' &&
                visibleCols
                  .filter((id) => columnPages.some((c) => c.id === id))
                  .map((id) => (
                    <option key={id} value={`col:${id}`}>
                      {columnLabel(id)} だけデザインする
                    </option>
                  ))}
              {/* 大扉・目次・奥付が画面にあれば、そのページだけ(背景の濃さ・文字のフチ)も選べる(2026-10-09) */}
              {barMode === 'body' &&
                visiblePgs.map((pg) => (
                  <option key={pg} value={`page:${pg}`}>
                    {PAGE_LABEL[pg]}だけデザインする
                  </option>
                ))}
            </select>
          </label>
        )}

        {/* ---- 2. 読みやすさ ----
            **書体・サイズ・行送り・組み方向は帯に直に置く。**
            板に入れていたころは、いちばん往復するものが1枚のうしろに隠れていた
            (2026-08-19 ユーザー指摘「ばらして帯に入れてほしい」)。
            板に残すのは**説明が要るもの**だけ — 段組みと章はじめの大文字。
            どちらも「なぜそうなるか」を読まないと選べない */}
        {/* **電子書籍の書体は選ばせない。**(2026-09-24 ユーザー決定) 電子書籍は本文が明朝、
            見出しと太字がゴシックで固定(exporters/epub.ts)。選べるように見せると、選んだ書体が
            電子にも出ると誤解される。電子書籍だけの本と、両方を作る本で電子の下見を見ているときは
            固定の表示にし、**押すと大きな字の断りを出す**(2026-09-24 ユーザー要望「もう少し目立たせて
            ほしい。帯から直そうとするとエラーとして大きな文字でポップアップする、のように」) */}
        {/* **大扉・目次・奥付だけを向いているときは、背景の濃さと文字のフチだけを出す。**
            書体・大きさ・色などは、これらのページでは本全体の値で組まれるので、出すと効かない欄になる */}
        {!byPage && (
        <>
        {!paperBar ? (
          <BarField label={isMatter || byColumn ? '本文の書体' : '書体'}>
            <button
              type="button"
              className="bar-fixed"
              aria-haspopup="dialog"
              aria-label="書体：本文 明朝／見出し・太字 ゴシック（電子書籍は固定。押すと理由が出ます）"
              onClick={() => openNotice('font')}
            >
              本文 明朝／見出し・太字 ゴシック
              <span className="bar-fixed-mark">電子書籍は固定</span>
            </button>
          </BarField>
        ) : (
        <BarField label={isMatter || byColumn ? '本文の書体' : '書体'} hint={mark('chapterFont', 'bodyFont')}>
          <span className="barfontpick">
            <select
              className="wide"
              style={{ fontFamily: shownFont.stack }}
              value={fontPick.value}
              onChange={(e) => fontPick.set(e.target.value as BodyFontId)}
            >
              {['明朝', 'ゴシック', '装飾'].map((group) => (
                <optgroup
                  key={group}
                  label={group === '装飾' ? '装飾（長い本文には向きません）' : group}
                >
                  {(Object.entries(BODY_FONTS) as [BodyFontId, (typeof BODY_FONTS)[BodyFontId]][])
                    .filter(([, f]) => f.group === group)
                    .map(([id, f]) => (
                      <option key={id} value={id} style={{ fontFamily: f.stack }}>
                        {f.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            <span
              className="barspecimen"
              style={{ fontFamily: shownFont.stack }}
              aria-hidden="true"
            >
              あの日の空
            </span>
          </span>
        </BarField>
        )}

        {/* **見出しの書体は奥付のときだけ。**(2026-08-19 ユーザー要望)
            本文の工程では章見出しの書体は本全体で1つ(GOTHIC)なので、
            出しても書き込む先が無い */}
        {(isMatter || byColumn) && paperBar && (
          <BarField label="見出しの書体" hint={headReset('headingFont')}>
            <select
              className="wide"
              style={{
                fontFamily: BODY_FONTS[headFontNow ?? fontPick.value]?.stack ?? shownFont.stack,
              }}
              value={headFontNow ?? ''}
              onChange={(e) => setHeadFont((e.target.value || undefined) as BodyFontId | undefined)}
            >
              <option value="">本文と同じ</option>
              {(Object.entries(BODY_FONTS) as [BodyFontId, (typeof BODY_FONTS)[BodyFontId]][]).map(
                ([id, f]) => (
                  <option key={id} value={id} style={{ fontFamily: f.stack }}>
                    {f.label}
                  </option>
                ),
              )}
            </select>
          </BarField>
        )}

        {/* **見出しのサイズ。空なら本文について動く。**(2026-08-19 ユーザー指摘)
            本文だけ縮めて見出しが取り残されるより、既定では一緒に動くほうがよい。
            数字を入れたところで切り離す */}
        {/* **文字の大きさ・行送りは紙の本だけ。**(2026-09-24) EPUB は読む人の端末が決める
            (pt は入れず、行送りは本文の line-height 1.75 という倍率だけ。読む人が端末で変えられる。
            exporters/epub.ts の epubCss)。電子書籍だけの本と電子の下見のあいだは、下の見出しのサイズ・
            サイズ・行送りを出さず、その手前の「読む人が端末で決めます」の表示に替える */}
        {/* 電子書籍の文字の大きさ・行送りは読む人が決める。**消さずに、押すと理由が出る表示に替える**
            (書体と同じ扱い。2026-09-24 ユーザー判断) */}
        {!paperBar && (
          <BarField label="サイズ・行送り">
            <button
              type="button"
              className="bar-fixed"
              aria-haspopup="dialog"
              aria-label="サイズ・行送り：読む人が端末で決めます（電子書籍。押すと理由が出ます）"
              onClick={() => openNotice('size')}
            >
              読む人が端末で決めます
              <span className="bar-fixed-mark">電子書籍</span>
            </button>
          </BarField>
        )}
        {(isMatter || byColumn) && paperBar && (
          <BarField
            label="見出しのサイズ"
            hint={headPtNow === undefined ? '本文と連動' : headReset('headingPt')}
          >
            <span className="num">
              <input
                type="number"
                min={6}
                max={24}
                step={0.5}
                placeholder="連動"
                value={headPtNow ?? ''}
                onChange={(e) =>
                  setHeadPt(e.target.value === '' ? undefined : Number(e.target.value))
                }
              />
              pt
            </span>
          </BarField>
        )}

        {paperBar && (
        <BarField label={isMatter || byColumn ? '本文のサイズ' : 'サイズ'} hint={mark('chapterFontPt', 'fontPt')}>
          <span className="num">
            <input
              type="number"
              min={7}
              max={14}
              step={0.5}
              value={fontPtPick.value}
              onChange={(e) => fontPtPick.set(Number(e.target.value))}
            />
            pt
          </span>
        </BarField>
        )}

        {/* 行送りの読みは**倍率**。pt の数字だけでは詰まっているかどうか分からない */}
        {paperBar && (
        <BarField
          label="行送り"
          hint={
            <>
              ×{(feedExact / fontPtPick.value).toFixed(2)}
              {mark('chapterLineFeedPt', 'lineFeedPt')}
            </>
          }
        >
          <span className="num">
            <input
              type="number"
              min={10}
              max={28}
              step={0.5}
              value={feedShown}
              onChange={(e) => feedPick.set(Number(e.target.value))}
            />
            pt
          </span>
        </BarField>
        )}

        </>
        )}

        {/* 場面転換(原稿の `---`)の見た目。
            **原稿に `---` が1つも無い本には出さない。** どれを選んでも紙面が
            1ミリも動かない操作を並べると、押した意味を探して迷う
            (AI 生成コンテンツの申告をチェックからやめたときと同じ判断。2026-08-19)。

            **なぜ帯なのか。** 本のかたち(判型・組み方向・目次)と同じ「一度決めるもの」に
            見えるが、実際は**紙面を見ないと決められない**。4つを順に選んで、
            自分の本のその場面でどう見えるかを見比べる操作なので、
            プレビューの真下にある帯でないと往復が成立しない
            (帯に残すのは往復するものだけ、という切り分けのとおり)。

            **説明文は添えない。** 選択肢の名前がそのまま刷り上がり(SCENE_BREAKS)。
            **とくに「1行アキ」に注意書きを付けない** — 「紙では何も出ません」と
            断りたくなるが、それは一般文芸の正解そのもので、断ると欠陥に見える。
            画面の下見にだけ見えるしるしも足さない(紙に出ないものは画面にも出さない) */}
        {/* コラムには原稿の `---` が来ないので、コラムを選んでいるあいだは出さない */}
        {barMode === 'body' && !byColumn && !byPage && hasSceneBreak(chapters) && (
          <BarField label="場面転換">
            {/* いちばん長い選択肢が「＊　＊　＊」なので、既定の 132px に収まる */}
            <select
              value={sceneBreakOf(settings)}
              onChange={(e) => setSettings({ sceneBreak: e.target.value as SceneBreakId })}
            >
              {(Object.keys(SCENE_BREAKS) as SceneBreakId[]).map((k) => (
                <option key={k} value={k}>
                  {SCENE_BREAKS[k].label}
                </option>
              ))}
            </select>
          </BarField>
        )}

        {paperBar && !byPage && <span className="barsep" />}

        {/* ---- 3. 飾り ----
            **紙を作らない本には、飾りと段組みを出さない。**(2026-09-23 ユーザー要望
            「自分が今必要としているものだけしか見えない」)。背景の濃さ・フチ・帯・文字の色・
            段組み・章はじめの大文字は、どれも EPUB には入らない(help/content.ts の HELP_EPUB_DIFF)。
            電子書籍だけを作る人に見せると、電子にも効くと読める。値は消さない。

            **ここだけは畳まない。** 紙面を見ながらいちばん触るものなので、
            板の中に隠すと開き直しの往復になる(2026-08-19 ユーザー指摘)。
            対象は帯の先頭のプルダウンで切り替える。指定のある項目には［×］が出る。
            **背景の濃さ・フチは、奥付モードでは奥付のページの背景(colophonBg)に書く。**(2026-10-09)
            以前は「奥付モードでは本全体(settings.bgOpacity)を書き換えてしまう」ので出さなかった(2026-09-04 レビュー指摘)。
            書き込み先を奥付のページに分けたので出せる(左の欄にしか無かったものを帯へ移した)。帯(本文の下)は本文モードだけ */}
        {(barMode === 'body' || isMatter) && paperBar && pageBgShown && (
        <BarField
          label="背景の濃さ"
          hint={
            <>
              {Math.round(opacityNow * 100)}%{resetBg('opacity')}
            </>
          }
        >
          <input
            className="barrange"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacityNow}
            onChange={(e) => setOpacity(Number(e.target.value))}
          />
        </BarField>
        )}

        {(barMode === 'body' || isMatter) && paperBar && (
        <BarField label="文字のフチ" hint={resetBg('outline')}>
          <span className="num">
            <select value={outlineStep} onChange={(e) => setOutline(Number(e.target.value))}>
              <option value={0}>なし</option>
              <option value={0.05}>細い</option>
              <option value={0.09}>太い</option>
            </select>
            {outlineStep > 0 && (
              <ColorInput
                className="barcolor"
                aria-label="フチの色"
                value={outlineColorNow}
                onChange={(e) => setOutlineColor(e.target.value)}
              />
            )}
          </span>
        </BarField>
        )}

        {barMode === 'body' && paperBar && !byPage && (
        <BarField
          label="本文の下に帯"
          hint={byColumn ? colReset('plate', 'plateColor') : resetMark('chapterPlate')}
        >
          <span className="num">
            <select value={plateStep} onChange={(e) => platePick.set(Number(e.target.value))}>
              <option value={0}>なし</option>
              <option value={0.75}>うすく</option>
              <option value={0.95}>しっかり</option>
            </select>
            {plateStep > 0 && (
              <ColorInput
                className="barcolor"
                aria-label="帯の色"
                value={plateColorPick.value}
                onChange={(e) => plateColorPick.set(e.target.value)}
              />
            )}
          </span>
        </BarField>
        )}

        {/* 文字の色。**本文・章見出し・小見出しを横一列に。**
            名前を書くと場所を食うので、色見本の下に小さく置く。
            章スコープのときは、指定していない色を薄い枠で示す(継いでいる色) */}
        {paperBar && !byPage && (
        <BarField label={mono ? '文字の色（白黒に変換）' : '文字の色'}>
          <span className="barswatches">
            {swatch(
              '本文',
              (isMatter
                ? matterNow.color
                : byColumn
                  ? colNow.color
                  : byChapter
                    ? chapterBody[chapterNow]
                    : undefined) ??
                settings.textColor ??
                '#000000',
              (v) =>
                isMatter
                  ? matterPick('color', '#000000').set(v)
                  : byColumn
                    ? colPatch({ color: v })
                    : byChapter
                      ? setChapterValue('chapterTextColor', chapterNow, v)
                      : setSettings({ textColor: v }),
              isMatter
                ? matterNow.color === undefined
                : byColumn
                  ? colNow.color === undefined
                  : byChapter && !chapterBody[chapterNow],
              isMatter
                ? () => matterPick('color', '#000000').set(undefined)
                : byColumn
                  ? () => colPatch({ color: undefined })
                  : byChapter
                    ? () => setChapterValue('chapterTextColor', chapterNow, undefined)
                    : undefined,
            )}
            {/* コラムの見出し。**空なら本文の色について動く**(組版と同じ) */}
            {byColumn &&
              swatch(
                '見出し',
                colNow.headingColor ?? colNow.color ?? settings.textColor ?? '#000000',
                (v) => colPatch({ headingColor: v }),
                colNow.headingColor === undefined,
                () => colPatch({ headingColor: undefined }),
              )}
            {/* **奥付には章見出しも小見出しも無い。** 触っても何も起きない色見本は出さない */}
            {isMatter &&
              swatch(
                '見出し',
                matterNow.headingColor ?? matterNow.color ?? settings.textColor ?? '#000000',
                (v) => matterPick('headingColor', '#000000').set(v),
                matterNow.headingColor === undefined,
                () => matterPick('headingColor', '#000000').set(undefined),
              )}
            {barMode === 'body' && !byColumn &&
              swatch(
              '章見出し',
              (byChapter ? chapterHead[chapterNow] : undefined) ??
                settings.headingColor ??
                settings.textColor ??
                '#000000',
              (v) =>
                byChapter
                  ? setChapterValue('chapterHeadingColor', chapterNow, v)
                  : setSettings({ headingColor: v }),
              byChapter ? !chapterHead[chapterNow] : !settings.headingColor,
              byChapter
                ? () => setChapterValue('chapterHeadingColor', chapterNow, undefined)
                : undefined,
            )}
            {barMode === 'body' && !byColumn &&
              swatch(
              '小見出し',
              (byChapter ? chapterSub[chapterNow] : undefined) ??
                settings.subheadingColor ??
                settings.textColor ??
                '#000000',
              (v) =>
                byChapter
                  ? setChapterValue('chapterSubheadingColor', chapterNow, v)
                  : setSettings({ subheadingColor: v }),
              byChapter ? !chapterSub[chapterNow] : !settings.subheadingColor,
              byChapter
                ? () => setChapterValue('chapterSubheadingColor', chapterNow, undefined)
                : undefined,
            )}
          </span>
        </BarField>
        )}

        {barMode === 'body' && paperBar && !byColumn && !byPage && <span className="barsep" />}

        {/* **ノンブルと柱の書体。**(2026-10-09 ユーザー判断「デザインに関連する話は下のバーで」)
            もとは［本のかたちを決める］の畳みの中。2026-08-19 に「決め切るもの」としてノンブル・柱ごと帯から出したが、
            書体は見た目の話なので帯へ戻す(出す・出さない・位置は［本のかたちを決める］のまま)。
            本全体で1つの設定なので、章・コラム・ページを向いているときは出さない */}
        {barMode === 'body' && paperBar && !byChapter && !byColumn && !byPage && (
          <BarMenu
            label="ノンブル・柱の書体"
            value={`${settings.nombreFont ? BODY_FONTS[settings.nombreFont]?.label ?? '数字用' : '数字用'} / ${
              settings.runningHeadFont ? BODY_FONTS[settings.runningHeadFont]?.label ?? 'ゴシック' : 'ゴシック'
            }`}
            width={300}
          >
            <label className="stack">
              ページ番号（ノンブル）
              <select
                value={settings.nombreFont ?? ''}
                onChange={(e) =>
                  setSettings({ nombreFont: (e.target.value || undefined) as BodyFontId | undefined })
                }
              >
                <option value="">数字用（欧文セリフ）</option>
                {(Object.entries(BODY_FONTS) as [BodyFontId, (typeof BODY_FONTS)[BodyFontId]][]).map(([id, f]) => (
                  <option key={id} value={id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              柱
              <select
                value={settings.runningHeadFont ?? ''}
                onChange={(e) =>
                  setSettings({ runningHeadFont: (e.target.value || undefined) as BodyFontId | undefined })
                }
              >
                <option value="">ゴシック（既定）</option>
                {(Object.entries(BODY_FONTS) as [BodyFontId, (typeof BODY_FONTS)[BodyFontId]][]).map(([id, f]) => (
                  <option key={id} value={id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">表示の有無や位置は［本のかたちを決める］で設定します</p>
          </BarMenu>
        )}

        {/* **コラムの文字のまわりの余白。**(2026-10-09 ユーザー要望「文字回りの余白の話だから、デザインバーに入れた方がいい」)
            額のような枠柄の地に文字を収めるための指定(2026-09-11)。もとはコラムの左の欄にあった。
            **見せる単位は mm、持つのは版面に対する%**(判型を変えても見た目の比率が保たれる)。入る行数も同じだけ減る */}
        {byColumn && paperBar && (() => {
          const areaW = layout.trimW - layout.margins.gutter - layout.margins.fore;
          const areaH = layout.trimH - layout.margins.top - layout.margins.bottom;
          const xMm = Math.round((areaW * (colNow.padXPct ?? 0)) / 100);
          const yMm = Math.round((areaH * (colNow.padYPct ?? 0)) / 100);
          const setPad = (key: 'padXPct' | 'padYPct', mm: number, base: number) =>
            colPatch({ [key]: mm === 0 ? undefined : +((mm / base) * 100).toFixed(2) });
          return (
            <BarMenu label="文字のまわりの余白" value={`左右 ${xMm}mm・天地 ${yMm}mm`} width={300}>
              <label className="stack">
                <span>左右（各）{colReset('padXPct')}</span>
                <span className="num">
                  <input
                    type="range"
                    min={0}
                    max={25}
                    step={1}
                    value={xMm}
                    onChange={(e) => setPad('padXPct', Number(e.target.value), areaW)}
                  />
                  {xMm}mm
                </span>
              </label>
              <label className="stack">
                <span>天地（各）{colReset('padYPct')}</span>
                <span className="num">
                  <input
                    type="range"
                    min={0}
                    max={25}
                    step={1}
                    value={yMm}
                    onChange={(e) => setPad('padYPct', Number(e.target.value), areaH)}
                  />
                  {yMm}mm
                </span>
              </label>
              <p className="hint">
                左右・天地とも<b>両側からそれぞれ</b>この寸法だけ内側に寄せます。
                枠柄の地に文字を収めるときに（入る行数も同じだけ減ります）
              </p>
            </BarMenu>
          );
        })()}

        {/* ---- 4. 説明が要るものだけ板に残す ----
            **奥付では出さない。** 段組みは section.chapter にしか掛からず、
            章はじめの大文字は章の最初の段落に付くもの。どちらも奥付の紙面には効かない
            (2026-08-19 ユーザー指摘「奥付では使えない機能が混ざっている」)
            **コラムでも出さない。** 段組みも大文字も section.chapter にしか掛からない */}
        {barMode === 'body' && paperBar && !byColumn && !byPage && (
        <>
        {/* ---- 説明が要るものだけ板に残す ----
            段組みも章はじめの大文字も、選択肢を見ただけでは選べない。
            段組みは「1行に何字入るか」、大文字は「効かない書き出しが3つある」を
            読ませないと決められないので、説明文の置ける板に置く */}
        <BarMenu
          label={byChapter ? 'この章の段組みと大文字' : '段組みと大文字'}
          value={`${colPick.value > 1 ? `${colPick.value}段` : '1段'} / 大文字${
            dropPick.value > 0 ? `${dropPick.value}行` : 'なし'
          }`}
          width={330}
        >
          {byChapter && (
            <p className="hint scope-note">
              いま変えるのは<b>{chapterName}</b>
              だけです。［×］で本全体と同じに戻ります
            </p>
          )}

          <h3 className="bg-label">段組み</h3>
          {maxCols > 1 ? (
            <>
              <label className="stack">
                <span>段の数{resetMark('chapterColumns')}</span>
                <select
                  value={Math.min(colPick.value, maxCols)}
                  onChange={(e) => colPick.set(Number(e.target.value))}
                >
                  {Array.from({ length: maxCols }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? 'なし' : `${n}段`}
                    </option>
                  ))}
                </select>
              </label>
              {colPick.value > 1 && !byChapter && (
                <>
                  <label>
                    段のあいだ
                    <span className="num">
                      <input
                        type="number"
                        min={0}
                        max={4}
                        step={0.5}
                        value={settings.columnGapLines}
                        onChange={(e) =>
                          setSettings({
                            columnGapLines: Number(e.target.value),
                          })
                        }
                      />
                      行
                    </span>
                  </label>
                  <label className="stack">
                    段のあいだの線
                    <select
                      value={settings.columnRule ? 'on' : 'off'}
                      onChange={(e) => setSettings({ columnRule: e.target.value === 'on' })}
                    >
                      <option value="off">引かない</option>
                      <option value="on">引く</option>
                    </select>
                  </label>
                </>
              )}
              {colPick.value > 1 && byChapter && (
                <p className="hint">
                  段のあいだの幅と線は<b>本全体でひとつ</b>です
                  （幅はこの章の行送りで引き直されます）
                </p>
              )}
            </>
          ) : (
            <p className="hint">この判型では段組みできません（1段だけです）</p>
          )}
          {byChapter ? (
            /* **章ごとの字数は出さない。** 版面(字数×行数)は本全体の値で決まっていて、
               サイズを変えた章はその行グリッドから外れる。数字を出すと
               「その章もこの字数で組まれている」と誤解させる */
            <p className="hint">
              本全体は<b>1行 {layout.charsPerLine}字</b>です。この章のサイズを変えると、
              <b>この章だけ、1行の字数も行の並びも本全体とは別</b>になります
              （コラムや資料編のように、独立した章として組まれます）
            </p>
          ) : (
            <p className="hint">
              いまの設定で<b>1行に {layout.charsPerLine}字</b>入ります。
              {settings.columns > 1 && '10字を切ると語が毎行割れて読みにくくなります。'}
            </p>
          )}

          <h3 className="bg-label">章はじめの大文字</h3>
          <label className="stack">
            <span>大きさ{resetMark('chapterDropCap')}</span>
            <select value={dropPick.value} onChange={(e) => dropPick.set(Number(e.target.value))}>
              <option value={0}>なし</option>
              <option value={2}>2行ぶん</option>
              <option value={3}>3行ぶん</option>
              <option value={4}>4行ぶん</option>
            </select>
          </label>
          {/* **例外が多い飾りなので、先に全部言う。** あとで「効かない」と気づくより、
              先に知っているほうがよい(2026-08-19 ユーザー指摘) */}
          <p className="hint">章の書き出しを、指定した行数ぶんの大きさで組みます。</p>
          <p className="hint">
            数字で始まる章は<b>2桁までなら数字ごと</b>（「19時」なら「19」）、 ルビの付いた語は
            <b>ルビごと</b>大きくなります。
          </p>
          <p className="hint">
            <b>思ったとおりにならない書き出し</b>が3つあります。
            <br />・<b>会話文</b>…「や『が大きくなります
            <br />・<b>太字や斜体で始まる段落</b>
            …強調ごと巨大になるので、付けません
            <br />・<b>3桁以上の数字</b>…1文字目の数字だけが大きくなります
          </p>
        </BarMenu>
        </>
        )}

        {/* **見た目を他と分ける。** 押すと文字サイズも余白も戻る強い操作なので、
            並んだ操作のひとつに見えてはいけない(2026-08-19 ユーザー指摘)

            **戻す範囲を、名前と確認の両方で言う。**(2026-08-20 ユーザー報告
            「デザインする帯の『すべてリセット』を押しても反応がない」)
            もとは applyPreset を借りていて、戻るのは文字サイズ・行送り・余白の3つだけ。
            帯に並ぶ9組のうち2組しか掛からず、その2つが既定のままなら**1つも値が動かない**
            (実測は store の resetDesign を参照)。いまは帯に出ているものを全部戻す。

            範囲は帯の名札そのもの — 「本全体をデザインする」なら本全体、
            「◯章だけ」ならその章。**名札を読まずに押す人がいる**ので、
            ボタンの文字と確認の文にも同じ範囲を書く。 */}
        {/* **電子書籍だけの本と電子の下見のあいだは出さない。**(2026-09-24 レビューで発見)
            戻す中身(書体・サイズ・行送り・余白・段組み・飾り・奥付の見た目)は、どれも紙だけに効き、
            そのとき帯には出ていない。押すと、見えていない紙のデザインが黙って消えていた */}
        {paperBar && (
        <button
          className="barbtn barreset"
          title={resetTitle}
          onClick={() => {
            if (!window.confirm(resetConfirm)) return;
            // コラムは店の resetDesign の範囲(本全体・章・奥付)の外。見た目の欄を全部と、
            // 地の濃さを落とす(絵と余白は残す)
            if (byPage) {
              setPageBg({ opacity: undefined, outline: undefined, outlineColor: undefined });
              return;
            }
            if (byColumn) {
              colPatch({
                bodyFont: undefined,
                fontPt: undefined,
                lineFeedPt: undefined,
                color: undefined,
                headingFont: undefined,
                headingPt: undefined,
                headingColor: undefined,
                outline: undefined,
                outlineColor: undefined,
                plate: undefined,
                plateColor: undefined,
                padXPct: undefined,
                padYPct: undefined,
                bg: colBgWith({ opacity: undefined }),
              });
              return;
            }
            resetDesign(resetScope);
          }}
        >
          {resetLabel}
        </button>
        )}
      </div>

      {/* 下の行は読み値。**操作は混ぜない**(InfoBar 側の切り分けをそのまま生かす) */}
      <InfoBar
        layout={layout}
        trimLabel={trimLabel}
        totalChars={totalChars}
        chapters={chapters.length}
        pageCount={pageCount}
        estPages={estPages}
        counting={counting}
        paper={paperBar}
        print={settings}
      />
    </div>
  );
}
