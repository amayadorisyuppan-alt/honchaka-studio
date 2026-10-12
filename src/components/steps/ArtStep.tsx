// 01 絵。ここだけは扱うものが4種類あるので、副タブを1段だけ入れる。
//
// - 挿絵　　　　　 … 章の切れ目に挟む1枚絵のページと、章の途中(段落のあと)に入れる絵
// - コラムページ　 … 章の切れ目に挟む、本文と組み方向の違う1ページ
// - クッション　　 … 絵も文字も置かない1ページ
// - 背景　　　　　 … 大扉・本文・目次・章・奥付に敷く地
//
// **「文中に貼る」(Word 往復)は 2026-09-23 に撤去した。** 章の途中の絵も［挿絵］で
// 段落を選んで入れられるようになったため(ユーザー判断「その方がわかりやすい」)。
//
// **階層は2段まで。** 3段目を作ると、いま起きている「どこにあるか分からない」が
// 別の形で戻ってくる。

import { useEffect, useRef, useState } from 'react';
import { SHOP_PACKS_LABEL } from '../../shop';
import {
  bindingOf,
  hasOwnBg,
  outputsOf,
  type BgSpec,
  type Chapter,
  type ProjectSettings,
} from '../../models/project';
import type { TextRowState } from '../../textcheck/geometry';
import type { ResolutionVerdict } from '../../models/imageResolution';
import type { LayoutInfo } from '../../preview/VivliostylePreview';
import { BackgroundPicker, bgSurfaceProps } from '../BackgroundPicker';
import { ColumnPageEditor } from '../ColumnPageEditor';
import { PlateEditor } from '../PlateEditor';
import { bgMonoProps, PrintMonoToggle, type ColorLook } from '../PrintMonoToggle';
import { Fold } from '../Fold';
import { ShopFoot } from '../ShopFoot';
import { FrogPeek } from '../FrogMark';
import type { BarScope } from '../FormatBar';

/** ［背景］の面の鍵 → 画面下の帯の向き先(本文全体は本全体、章は番号、大扉・目次・奥付はそのページ) */
function barScopeOf(key: string): BarScope {
  if (key === 'title') return 'page:title';
  if (key === 'toc') return 'page:toc';
  if (key === 'colophon') return 'page:colophon';
  const ch = /^chapter-(\d+)$/.exec(key);
  return ch ? Number(ch[1]) : 'book';
}

type Pane = 'plates' | 'colpages' | 'blanks' | 'background';

/**
 * 副タブ。**クッションを挿絵から切り離した。**(2026-08-20 ユーザー判断)
 *
 * 中身は同じ配列(settings.plates)に入っているが、利用者から見れば別のものだった。
 * 「挿絵ページを追加」の下に「クッションページを足す」が並んでいたので、
 * どちらの話をしている面なのか読めなかった。
 *
 * **名前は短くする。** 「コラムページ」は「コラム」まで詰める
 * (タブの行は折り返さないほうが読みやすい)
 */
/*
 * **並びはよく使う順。背景が先頭。**(2026-09-23 ユーザー要望「背景・挿絵・コラム・クッションの順がいい。
 * 背景はてっとりばやく入れられて初心者にもっとも優しいから先頭がいい」)。開いたときも背景から始める
 * (紙を作らない本には背景の面が無いので、そのときは挿絵から)
 */
const PANES: [Pane, string][] = [
  ['background', '背景'],
  ['plates', '挿絵'],
  ['colpages', 'コラム'],
  ['blanks', 'クッション'],
];

interface Props {
  /**
   * 外から開かせたい面。**サムネイルの「＋」で足したあと、その場所へ連れて行く。**
   * 足したのに別の面が開いたままだと、どこに増えたのか探すことになる
   * (2026-08-19 ユーザー指摘)。同じ値が続けて来ても開き直せるよう連番を添える
   */
  focusPane?: {
    pane: 'plates' | 'colpages' | 'blanks';
    seq: number;
    /**
     * 挿絵の一覧で目立たせる行(鍵は resRows と同じ plate:id / img:鍵)。**「直すところ」から来たときだけ。**
     * 「挿絵と本文中の画像のうち2枚は…」から飛んでも、どの画像の話か分からなかった(2026-10-09 ユーザー指摘)
     */
    spot?: readonly string[];
  };
  /** ページ一覧の「＋」から預かった、次の1枚を入れる場所(何章の前か) */
  addAt?: number | null;
  onAddAtUsed?: () => void;
  /** そのページへプレビューを飛ばす。1始まり */
  onJump?: (page: number) => void;
  /**
   * 画面下の帯の向き先を変える。**背景の面(本文全体・大扉・目次・章・奥付)を開いたとき、帯もその面へ向ける。**
   * 濃さ・文字のフチ・本文の下の帯は帯でしか変えられない(2026-10-09 に左の欄から外した)
   */
  onBarScope?: (scope: BarScope) => void;
  /** 1枚足したことを知らせる。足した先へ飛んで光らせるのに使う */
  onAdded?: (kind: 'plate' | 'colpage', id: string) => void;
  /**
   * 場所・大きさ・絵を変えた1枚へプレビューを連れて行く(組み上がりを待って飛ぶのは App)。
   * 'img' は章の途中の絵(id は imageKey)
   */
  onFollow?: (kind: 'plate' | 'colpage' | 'img', id: string) => void;
  /**
   * 足したばかりのページの id(App の justAdded)。左の一覧の該当行へ
   * スクロールして光らせる。プレビューの「＋」から足すと行はページ順の
   * 位置に入って画面の外のこともある(2026-09-04 ユーザー報告)
   */
  justAddedId?: string | null;
  settings: ProjectSettings;
  chapters: Chapter[];
  layoutInfo: LayoutInfo;
  /** 絵の中の文字の検査で、行に出すこと(鍵は plate:id / img:鍵)。［挿絵］の、その絵の行に知らせを出す */
  textRows?: ReadonlyMap<string, TextRowState>;
  /** 絵の細かさが出し先の目安に届かない絵の行に出すこと(鍵は textRows と同じ)。知らせるだけで、止めない */
  resRows?: ReadonlyMap<string, ResolutionVerdict>;
  /** 見開きの絵の行に出す、絵の画素数から言えること(鍵は挿絵の id) */
  spreadNotes?: ReadonlyMap<string, readonly string[]>;
  /** 出し先の名前。細かさの知らせに添える */
  printTargetLabel?: string;
  /**
   * 右の下見が電子書籍か。**紙のページ番号(「◯ページ目（見る）」)は電子の下見では意味が無い**ので、
   * 一覧の行は「電子の下見で見る」に替わる
   */
  ebookView?: boolean;
  /**
   * 右の下見を紙へ切り替える。背景・クッションの面で、電子の下見を出しているときの断りに付ける。
   * **自分からは切り替えない。**(2026-09-24 ユーザー報告「画像タブで電子書籍を押しても、一瞬見えて
   * 紙にすぐ戻る」)。以前は背景・クッションの面を開いているだけで紙へ戻していたが、画像タブは
   * 背景の面から開くので、［電子書籍］を押した直後に戻されていた。押した人の選択を優先する
   */
  onShowPaper?: () => void;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  /** 章の途中の絵を書き換える(原稿の章ごと差し替える。元に戻せる。undoKey は PlateEditor 参照) */
  setChapters: (chapters: Chapter[], undoKey?: string) => void;
  /** 絵ごとの「白黒で刷る」を出すか(カラーの紙の本だけ。2026-10-12 1.1.0。修正リストの 4-6) */
  printColor?: boolean;
  /** 白黒に見える絵・ごく淡い色の絵(鍵は plate:id / img:鍵 / bg:面。models/printColor.ts の colorLookRows) */
  colorRows?: ReadonlyMap<string, ColorLook>;
}

export function ArtStep({
  focusPane,
  addAt,
  onAddAtUsed,
  onJump,
  onBarScope,
  onAdded,
  onFollow,
  justAddedId,
  settings,
  chapters,
  layoutInfo,
  textRows,
  resRows,
  spreadNotes,
  printTargetLabel,
  ebookView = false,
  onShowPaper,
  setSettings,
  setChapters,
  printColor = false,
  colorRows,
}: Props) {
  const [pane, setPaneRaw] = useState<Pane>(() =>
    outputsOf(settings).paper ? 'background' : 'plates',
  );
  /**
   * **紙を作らない本には、背景とクッションの面を出さない。**(2026-09-23 ユーザー要望
   * 「自分が今必要としているものだけしか見えない」)。どちらも紙のページにしか入らない
   * (背景は EPUB に敷かない・白ページは EPUB に入らない)。値は消さない
   */
  const paperOnly: Pane[] = ['blanks', 'background'];
  const paper = outputsOf(settings).paper;
  const panes = paper ? PANES : PANES.filter(([id]) => !paperOnly.includes(id));
  const setPane = (next: Pane) => setPaneRaw(paper || !paperOnly.includes(next) ? next : 'plates');
  if (!paper && paperOnly.includes(pane)) setPaneRaw('plates');
  /** 背景・クッションの面で、右が電子の下見のときの断り(紙へ切り替える道を添える) */
  const paperOnlyView =
    ebookView && onShowPaper ? (
      <div className="step-note ebook-view-note">
        <span>
          いま右に出ているのは<b>電子書籍の下見</b>です。ここで変えたものは<b>紙の下見</b>で見えます
        </span>
        <button className="go-step" onClick={onShowPaper}>
          紙の下見に切り替える
        </button>
      </div>
    ) : null;
  const focusSeq = useRef(-1);
  if (focusPane && focusPane.seq !== focusSeq.current) {
    focusSeq.current = focusPane.seq;
    if (pane !== focusPane.pane) setPane(focusPane.pane);
  }
  /**
   * 副タブの箱そのもの。
   *
   * 以前は面の中から別の面へ移るボタン(「［文中に貼る］を開く」)があり、移ったあと
   * この箱の頭まで送り戻していた。移る先の面を撤去したので、その仕掛けも外した
   * (面をまたぐボタンを足すなら、描き終わってから scrollIntoView すること。
   * requestAnimationFrame では前の面の高さで計算されて 32px 行き過ぎた。2026-08-20 実測)
   */
  const boxRef = useRef<HTMLDivElement>(null);
  // 背景タブの中で、いまどの面の一覧を開いているか。
  // 値が入っているあいだは、他の面のピッカーも案内文も描かない
  // (サイドバーをその一覧専用にする。2026-08-18 「一覧性がない」への対応)。
  // 面の呼び名: 'title' | 'body' | 'toc' | 'colophon' | `chapter-${章の番号}`
  const [openBg, setOpenBg] = useState<string | null>(null);
  // 挿絵ページ(PlateEditor)側で画像パックの一覧を開いているか。
  // 開いているあいだは、下の副タブ切り替えと共通の案内文も描かない
  const [platesPicking, setPlatesPicking] = useState(false);
  /**
   * **挿絵の面を離れたら、一覧専用の状態を戻す。**(2026-09-23 レビューで発見)
   * 画像の一覧や場所を選ぶ画面を開いたまま、ページ一覧の［＋］でコラムやクッションの面へ
   * 連れて行かれると、挿絵の面(PlateEditor)は閉じる知らせを出さずに消える。
   * platesPicking が立ったまま残り、挿絵の面へ戻ったとき副タブの行が出なくなっていた
   */
  useEffect(() => {
    if (pane !== 'plates') setPlatesPicking(false);
  }, [pane]);
  // 「ページごとに変える」の開閉。**畳み自身に持たせない。**
  // 章の一覧を開くあいだ畳みごと描画から外すので、自分で持つと戻ったときに閉じてしまい、
  // 章を続けて設定するのに毎回開き直すことになる(2026-08-18)
  const [perPageOpen, setPerPageOpen] = useState(false);
  // いま「サイドバーを一覧専用にしている」かどうか(副タブ切り替え自体を隠す判定に使う)
  const focused = pane === 'background' ? openBg !== null : pane === 'plates' && platesPicking;

  /**
   * 面ごとのピッカーに渡す一式を作る。
   * 濃さ・フチは**その面に実際に絵が出るときだけ**出す(無地の面では意味がないため)。
   */
  /**
   * **その面のページへプレビューを連れて行く。**(2026-09-23 ユーザー指摘「第3章の背景を入れたけど、
   * プレビューがそこに飛ばなかった」)。一覧を開いたとき(いまの絵を見ながら選べる)と、
   * 絵や濃さを変えたとき。背景は塗りだけの変更で組み直しが起きないので、ページ番号はいまの
   * 組み上がりのまま引ける。まだ組み上がっていない(0)ときは動かさない
   */
  const jump = (page: number | undefined) => {
    if (page) onJump?.(page);
  };
  /**
   * **飛ぶのは絵(または本文と同じ／無地)を変えたときだけ。** 濃さ・フチの調整では飛ばない
   * (2026-09-23 レビューで発見)。スライダーの1目盛りごとに章はじめへ連れ戻され、
   * 章の途中の読みにくいページを見ながら濃さを決められなくなっていた
   */
  const surface = (
    spec: BgSpec | undefined,
    write: (next: BgSpec | undefined) => void,
    page: number | undefined,
    key: string,
  ) => {
    const props = bgSurfaceProps(spec, write);
    return {
      ...props,
      // 白黒で刷る(カラーの紙の本だけ。4-6)。鍵は colorLookRows の bg:面
      ...bgMonoProps(spec, write, {
        printColor,
        look: colorRows?.get(`bg:${key}`),
        bodyHasImage: Boolean(settings.bodyBg),
        bodyMono: Boolean(settings.bodyBgPrintMono),
      }),
      onChange: (next: BgSpec | undefined) => {
        props.onChange(next);
        jump(page);
        // 絵を変えた面へ、帯も向ける(濃さ・フチは帯でしか変えられない。2026-10-09)
        onBarScope?.(barScopeOf(key));
      },
    };
  };
  /**
   * 本文全体の絵が見えるページ。**自前の背景(無地を含む)を持たない最初の章。**
   * 1つめの章が「前書きは無地」のときにそこへ飛ぶと、変えた絵が見えない(2026-09-23 レビューで発見)
   */
  const bodyShownAt = (() => {
    const ch = chapters.findIndex((_, i) => !hasOwnBg(settings.chapterBg?.[i]));
    return ch >= 0 ? layoutInfo.chapterPages.get(ch) : undefined;
  })();
  /** 一覧の開け閉め。開いたらその面へ飛ぶ */
  const openFor = (key: string, page: number | undefined) => (o: boolean) => {
    setOpenBg(o ? key : null);
    if (o) {
      jump(page);
      onBarScope?.(barScopeOf(key));
    }
  };

  const chapterBg = settings.chapterBg ?? {};
  const perPageCount =
    (hasOwnBg(settings.tocBg) ? 1 : 0) +
    (hasOwnBg(settings.colophonBg) && settings.colophonBg?.base !== 'plain' ? 1 : 0) +
    Object.values(chapterBg).filter(hasOwnBg).length;

  // 目次・章・奥付のピッカーは「畳みの中」と「一覧を専有しているとき」の2箇所で
  // 出す必要があるので、要素を1回だけ組み立てて使い回す(props をここで2度書かない)
  const tocPicker = (
    <BackgroundPicker
      label="目次"
      allowPlain
      inheritFrom="本文"
      open={openBg === 'toc'}
      onOpenChange={openFor('toc', layoutInfo.tocPage)}
      {...surface(settings.tocBg, (v) => setSettings({ tocBg: v }), layoutInfo.tocPage, 'toc')}
    />
  );
  const colophonPicker = (
    <BackgroundPicker
      label="奥付"
      hint="書誌を読ませる場所なので、既定では無地です"
      allowPlain
      inheritFrom="本文"
      open={openBg === 'colophon'}
      onOpenChange={openFor('colophon', layoutInfo.colophonPage)}
      {...surface(settings.colophonBg, (v) => setSettings({ colophonBg: v }), layoutInfo.colophonPage, 'colophon')}
    />
  );
  const chapterPickers = chapters.map((ch, i) => (
    <BackgroundPicker
      key={i}
      label={[ch.no, ch.title].filter(Boolean).join('　') || `${i + 1}つめの章`}
      inheritFrom="本文"
      /* 章も大扉とまったく同じ穴を抱えている ─ resolveBg() の継承は面を選ばないので、
         自前の絵を持たない章は本文の背景をそのまま継ぎ、消す手段が無かった。
         「本文には背景を敷きたいが、この章だけは無地にしたい」は前書き・あとがきの
         ような章で普通に起こる要望なので、目次・奥付・大扉と体裁をそろえて出す
         (2026-09-14) */
      allowPlain
      open={openBg === `chapter-${i}`}
      onOpenChange={openFor(`chapter-${i}`, layoutInfo.chapterPages.get(i))}
      {...surface(
        chapterBg[i],
        (v) => {
          const next = { ...chapterBg };
          if (v) next[i] = v;
          else delete next[i];
          setSettings({ chapterBg: next });
        },
        layoutInfo.chapterPages.get(i),
        `chapter-${i}`,
      )}
    />
  ));
  const openChapterMatch = openBg ? /^chapter-(\d+)$/.exec(openBg) : null;
  const openChapterIndex = openChapterMatch ? Number(openChapterMatch[1]) : null;

  return (
    <>
      {/* 一覧を専有しているあいだは副タブも共通の案内も描かない
          (サイドバーをその一覧専用にする。2026-08-18 「一覧性がない」への対応) */}
      {/* **タブと中身をひとつの箱に入れる。**(表紙の面タブと同じ作り)
          並べただけだと、タブの行と中の切り替えがどちらも「ボタンが並んだ行」に見えて、
          どちらが親なのか分からない(2026-08-19 ユーザー指摘) */}
      {/* 一覧を専有しているあいだ(focused)は、タブも箱も描かずサイドバーを明け渡す */}
      <div className={focused ? 'tabbox plain' : 'tabbox'} ref={boxRef}>
        {!focused && (
          <div className="subtabs">
            {panes.map(([id, label]) => (
              <button key={id} className={pane === id ? 'on' : ''} onClick={() => setPane(id)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="tabpane">

      {pane === 'plates' && (
        <>
          {/* **説明を置かない。**(2026-08-19 ユーザー指摘「文字が多くて何をやればいいか
              わかりにくい」) 入れ方2通りのボタンと、その1行ずつで足りている */}
          <PlateEditor
            plates={settings.plates ?? []}
            chapters={chapters}
            layout={layoutInfo}
            onChange={(plates) => setSettings({ plates })}
            onChaptersChange={setChapters}
            onOpenChange={setPlatesPicking}
            addAt={addAt}
            onAddAtUsed={onAddAtUsed}
            onJump={onJump}
            onAdded={(id) => onAdded?.('plate', id)}
            onFollow={onFollow}
            highlightId={justAddedId}
            ebookView={ebookView}
            textRows={textRows}
            resRows={resRows}
            spreadNotes={spreadNotes}
            printTargetLabel={printTargetLabel}
            binding={bindingOf(settings)}
            printColor={printColor}
            colorRows={colorRows}
            only="plates"
            spotlight={
              focusPane?.pane === 'plates' && focusPane.spot?.length
                ? { keys: focusPane.spot, seq: focusPane.seq }
                : undefined
            }
          />
        </>
      )}

      {pane === 'blanks' && (
        <>
          {/* **1行だけ。** 何のためのページかが分かれば、あとはボタンと一覧で足りる */}
          <p className="step-lede">
            章立ての都合で<b>1ページ余る</b>ときに、画像も文字も置かない1枚を挟みます
            （背景に決めた画像だけは、このページにも敷かれます）。
          </p>
          {/* 背景の面と同じ断り(2026-09-24 ユーザー要望「クッションページにも紙だけの注釈を」) */}
          <p className="step-note">
            クッションページが入るのは<b>紙の本だけ</b>です。電子書籍にはページという区切りがないので、
            白い1ページは入りません
          </p>
          {paperOnlyView}
          <PlateEditor
            plates={settings.plates ?? []}
            chapters={chapters}
            layout={layoutInfo}
            onChange={(plates) => setSettings({ plates })}
            addAt={addAt}
            onAddAtUsed={onAddAtUsed}
            onJump={onJump}
            onAdded={(id) => onAdded?.('plate', id)}
            onFollow={onFollow}
            highlightId={justAddedId}
            ebookView={ebookView}
            only="blanks"
          />
        </>
      )}

      {pane === 'colpages' && (
        <>
          {/* **1行だけ。**(2026-08-19 ユーザー指摘)
              あふれの話は編集欄の中に「入る字数の目安」として毎回出ているので、
              ここで先に言う必要がない */}
          <p className="step-lede">
            コラム・人物の関係・用語のまとめなど、
            <b>本文の流れとは別に読ませたい1ページ</b>を章の切れ目に挟みます。
            {/* 電子の下見にはページ一覧が無いので、［＋］の案内は紙の下見のときだけ */}
            {!ebookView && (
              <>
                入れる場所が決まっているなら、<b>右のページ一覧の［＋］</b>から足すと、その切れ目に入ります。
              </>
            )}
          </p>
          <ColumnPageEditor
            settings={settings}
            chapters={chapters}
            onChange={(columnPages) => setSettings({ columnPages })}
            layoutInfo={layoutInfo}
            onJump={onJump}
            onAdded={(id) => onAdded?.('colpage', id)}
            onFollow={(id) => onFollow?.('colpage', id)}
            highlightId={justAddedId}
            ebookView={ebookView}
            printColor={printColor}
            colorRows={colorRows}
          />
        </>
      )}

      {pane === 'background' && (
        <>
          {/* 一覧を開いている面だけを描く。**戻る道と見出しはピッカーが自前で持つ**
              (2026-08-19 に「選ぶ画面」へ作り替えた)ので、ここでは何も足さない */}
          {openBg ? null : (
            <>
              {/* 「ページの地に画像を敷きます」はタブ名が言っているので書かない。
                  「電子書籍で背景が出ない」は実際に問い合わせが来たので、これだけ残す */}
              <p className="step-note">
                背景が入るのは<b>紙の本だけ</b>です。電子書籍は読む人が文字の大きさや
                配色を変えるので、画像は敷きません
              </p>
              {/* **濃さ・文字のフチ・本文の下の帯は帯で変える。**(2026-10-09 ユーザー判断「デザインに関連する話は下のバーで」)
                  面を開くと帯もその面へ向く(onBarScope) */}
              <p className="hint">
                画像の濃さ・文字のフチ・「本文の下に帯」は、<b>画面下の帯</b>で変えます。
                下で面（本文全体・大扉・目次・章・奥付）の画像を選ぶと、帯もその面に切り替わります
              </p>
            </>
          )}
          {paperOnlyView}

          {(openBg === null || openBg === 'title') && (
            <BackgroundPicker
              label="大扉"
              hint="いちばん最初のページ。枠ものの画像はここに入れるのがおすすめ"
              inheritFrom="本文"
              /* **目次・奥付と同じく「本文と同じ／無地」を出す。**(2026-09-14 ユーザー報告
                 「本文に背景を敷いたら大扉まで同じ背景が入ってしまう。分けられている
                 はずなのに」)。resolveBg() は自前の絵を持たない面へ本文の背景(bodyBg)を
                 継がせる作りで、これは目次・奥付にも共通の仕組み。だが allowPlain が
                 目次・奥付にしか渡っておらず、大扉だけ「無地にする」道が無かった
                 ─ 継いだ絵を消す手段が1つも無いのはこの面だけの穴だった */
              allowPlain
              open={openBg === 'title'}
              onOpenChange={openFor('title', layoutInfo.titlePage || 1)}
              {...surface(settings.titleBg, (v) => setSettings({ titleBg: v }), layoutInfo.titlePage || 1, 'title')}
            />
          )}

          {(openBg === null || openBg === 'body') && (
            <BackgroundPicker
              /* **「本文」ではなく「本文全体」。**(2026-08-21 ユーザー指摘)
                 すぐ下に「目次・章・奥付の背景」が並ぶので、「本文」とだけ書くと
                 “本文のページだけに敷くもの”に見えて取り違える。実際は指定の無い面
                 すべての受け皿なので、名前のほうを実態に寄せた */
              label="本文全体"
              hint="指定しなかった面は、すべてこの画像になります"
              value={
                settings.bodyBg
                  ? { src: settings.bodyBg, fromPreset: settings.bodyBgFromPreset }
                  : undefined
              }
              onChange={(spec) => {
                // 絵を外したら、白黒で刷る印も外す(印は本文全体の絵についての指定)
                setSettings({
                  bodyBg: spec?.src,
                  bodyBgFromPreset: spec?.fromPreset,
                  ...(spec?.src ? {} : { bodyBgPrintMono: undefined }),
                });
                jump(bodyShownAt);
                onBarScope?.('book');
              }}
              open={openBg === 'body'}
              onOpenChange={openFor('body', bodyShownAt)}
              mono={printColor && !!settings.bodyBgPrintMono}
              extra={
                printColor && settings.bodyBg ? (
                  <PrintMonoToggle
                    checked={!!settings.bodyBgPrintMono}
                    onChange={(v) => setSettings({ bodyBgPrintMono: v || undefined })}
                    look={colorRows?.get('bg:body')}
                  />
                ) : undefined
              }
            />
          )}

          {/* 目次・章・奥付は畳みの中。どれか1つが一覧を開いたら、畳みごと外して
              その1面だけを描く(畳みの開閉ボタンも「他の項目」の一部として隠す) */}
          {/* **名前は「ページごと」ではない。**(2026-08-21 ユーザー報告
              「そもそもページごとには変えられないから、今のままだと嘘になってしまう」)

              背景を持てる単位は**面**(大扉・本文・目次・章・奥付)で、ページではない。
              章の中の3ページ目だけ絵を変える、はどうやってもできない
              (引き継ぎメモ「章ごとに変えられるもの / 変えられないもの」)。
              上に並ぶ2つの見出しが「大扉」「本文」という面の名前なので、
              **この畳みも面の名前を並べる**。順番は中身(目次→章→奥付)と同じ本の順。

              **説明は足さない。** 開けば目次・章・奥付のピッカーがそのまま出るので、
              何が入っているかは見れば分かる(同日ユーザー指摘)。
              実測(1440×900・文庫サンプル・.fold-label に使える幅は 215px):
              変更前 260.08px → **45.08px あふれて「2件」が枠の外へ出ていた**
              変更後 163.22px(余り 51.78px。章が11件になっても 170.44px で収まる) */}
          {/* **地味な畳みでは入り口に見えなかった**(2026-09-14 ユーザー報告
              「目立たず埋もれてしまっている。正直探してしまった」。同じ枠の中に
              並ぶせいで“本文全体の付属品”に誤読された)。目次・章・奥付へ行く道は
              ここにしかないので、畳みを strong(色地・大きめの字)にして入り口の顔を
              させる。名前も「〜の背景」から**「〜の背景を変える」**へ(ユーザー案)。
              動詞まで書くと“押すと変えられる”が名前だけで伝わる。
              長くなるぶんは .fold-label が折り返す(2行になってよい、と同報告) */}
          {openBg === null && (
            <Fold
              label={`目次・章・奥付の背景を変える${perPageCount ? `　${perPageCount}件` : ''}`}
              changed={perPageCount > 0}
              open={perPageOpen}
              onOpenChange={setPerPageOpen}
              strong
            >
              {tocPicker}
              {chapterPickers}
              {colophonPicker}
            </Fold>
          )}
          {openBg === 'toc' && tocPicker}
          {openChapterIndex !== null && chapterPickers[openChapterIndex]}
          {openBg === 'colophon' && colophonPicker}
        </>
      )}

        </div>
      </div>

      {/* **タブの外・サイドバーの下端。**(2026-08-19 ユーザー指摘)
          タブの中に置くと、そのタブを開いた人にしか見えない */}
      <ShopFoot
        label={SHOP_PACKS_LABEL}
        hint="テーマ別・様式別の有料の画像パックです。表紙にも背景にも挿絵にも使えます。買った画像は［画像を選ぶ］から読み込んで使えます"
      />

      {/* 底のかくれカエル(決まりは FrogMark.tsx)。絵えらびは、たのしい */}
      <div className="frog-sit" aria-hidden="true">
        <FrogPeek width={40} mood="happy" />
      </div>
    </>
  );
}
