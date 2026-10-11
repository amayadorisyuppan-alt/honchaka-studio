import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  columnPageMode,
  columnPageParagraphs,
  BODY_FONTS,
  HEADING_FONT_STACK,
  PRINT_TARGETS,
  THEME_BODY_FONT,
  TRIM_SIZES,
  outputsOf,
  hasOwnBg,
  imageFormatLabel,
  isRenderableImage,
  bleedOf,
  bindingOf,
  printRulesOf,
  saddleCoverOf,
  tcyStack,
  trimUnsupported,
  usesOwnPrintRules,
  type InsertFit,
} from '../models/project';
import { bodyBoxes } from '../press/boxes';
import {
  bleedSummary,
  computeLayout,
  fitColumnPage,
  fullPagePx,
  gutterFloorLabel,
  gutterFloorMm,
  gutterNeedMm,
  mmToPx,
  plateAreaMm,
  printAreaMm,
} from '../typeset/grid';
import { manuscriptHtml, padOfHtml, pageBoxesOfHtml } from '../typeset/html';
import { saddleFindings, saddleOffNote, saddlePad as saddlePadOf } from '../typeset/saddle';
import { saddleBlockReason } from './bodyOutput';
import { SPREAD_FOLD_SAFE_MM, spreadGeometry, spreadImageNotes } from '../typeset/spread';
import { PRINT_MAX_SIDE, WRAP_MAX_SIDE } from '../images/optimize';
import { findTextOutside, overText, textMarksCss, textRowKey, textTargets, type TextFinding, type TextRowState } from '../textcheck/geometry';
import { useDetectedText } from '../textcheck/useDetectedText';
import { imageKey } from '../models/inlineImages';
import { paintNeutral, previewPaintCss, sameNeutral } from '../preview/paint';
import { collectFontFaceCss } from '../typeset/fontface';
import {
  PROFILE_TITLE,
  authorProfileOverflowLines,
  authorProfileParagraphs,
  colophonRows,
} from '../typeset/matter';
import { parseSource, readSource } from '../importers/load';
import { confirmReplaceBook, confirmReplaceManuscript, useProject } from '../store/useProject';
import { COVER_BLEED_MM, computeCoverLayout, coverSpineMm, PAPER_TYPES, papersFor, printerPapersOf, usesPrinterSpine } from '../models/cover';
import {
  basePpiOf,
  collectResolution,
  coverPartAreaMm,
  fitWithin,
  imageCheckPrompt,
  resolutionIssueText,
} from '../models/imageResolution';
import { useImageSizes } from '../images/useImageSizes';
import { useArtPalette } from '../images/usePalette';
import { ColorPaletteProvider } from './ColorInput';
import {
  VivliostylePreview,
  emptyLayout,
  type LayoutInfo,
  type PreviewHandle,
  type SpecialPage,
} from '../preview/VivliostylePreview';
import { CoverEditor, type CoverEditorHandle, type CoverPane } from './CoverEditor';
import type { FrontInk } from '../cover/render';
import { StepRail, STEPS, STEP_ACCENT, type StepId, type StepState } from './StepRail';
import { StudioLogo } from './FrogMark';
import { ShapeStep } from './steps/ShapeStep';
import type { PrintFocus } from './PrintRules';
import { printGuideCss } from '../preview/rulesGuide';
import { FormatBar, type BarScope } from './FormatBar';
import { ProjectBar, type ProjectBarHandle } from './ProjectBar';
import { AboutPanel, type AboutSection } from './AboutPanel';
import { HelpPanel } from './HelpPanel';
import { StartScreen } from './StartScreen';
import { NoticeBar } from './NoticeBar';
import { ThemeToggle } from './ThemeToggle';
import { choose as chooseBackupFolder } from '../project/backup';
import { ArtStep } from './steps/ArtStep';
import { AiStep } from './steps/AiStep';
import { ColophonStep } from './steps/ColophonStep';
import {
  ExportStep,
  exportTargetAvailable,
  type ExportTarget,
  type Problem,
  type Spec,
} from './steps/ExportStep';
import {
  buildEpubBook,
  exportEpub,
  isEpubImage,
  previewImageResolver,
  type EpubBook,
} from '../exporters/epub';
import { EbookPreview, spineLabels } from '../preview/EbookPreview';
import { assetUrl } from '../typeset/blobUrl';
import { downloadBlob } from '../exporters/download';
import { safeFileStem } from '../project/file';
import { TYPING_COMMITTED, TYPING_FLUSH, TYPING_REVERTED } from './typingEvents';
import { printToPdf } from '../exporters/print';
import { platePageRules } from '../typeset/css';

/**
 * カーソルが「文字を打つ欄」の中にあるか。
 *
 * ここが true のあいだ、Ctrl+Z は**その欄に打った文字までしか戻さない**
 * (下の keydown を参照)。あらすじを書いている途中の Ctrl+Z で本ごと
 * 巻き戻ったら取り返しがつかないので、欄の中と外で扱いを分ける。
 *
 * つまみ(range)・チェック・色・ファイルは文字を打つ欄ではないので false。
 * そこにカーソルがあるときは、ふつうに本の操作を戻す
 */
function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'color', 'file', 'button', 'submit', 'reset'].includes(
      el.type,
    );
  }
  return false;
}

/**
 * 設定変更を 400ms 落ち着かせてからプレビューを再組版する。
 *
 * `hold` が立っているあいだは**流さない**(タイマーも張らない)。(2026-08-22)
 * 奥付やコラムの文言を打っているあいだ、1文字ごとに全体を組み直さないための栓。
 * hold が下りた(欄を離れた・タブを離れた)瞬間に effect が張り直すので、
 * そこから ms 待って1回だけ流れる — 打っているあいだの編集は取りこぼさない
 */
function useDebounced<T>(value: T, ms: number, hold = false): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (hold) return;
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms, hold]);
  return v;
}

/**
 * **文言を打っているあいだ、組版を待たせるか。**(2026-08-22)
 *
 * 録画の実測: 奥付の文言を1文字打つたびに全297ページを組み直していた。
 * 奥付もコラムも1ページに閉じた紙面で、**打っている途中の姿を毎回組む意味がない。**
 * `data-defer-typeset` の付いた欄(奥付の8欄・コラムの見出しと本文)に
 * カーソルがあるあいだだけ true になり、useDebounced の栓(hold)になる。
 *
 * 確定の合図は「欄を離れた」こと:
 * - 別の場所をクリックした・Tab で欄の外へ出た(focusout → activeElement が変わる)
 * - 工程を切り替えた(レールのボタンへフォーカスが移る)
 * - **タブや窓を離れた**(window の blur。hasFocus が false になる)
 * どれでも hold が下り、そこから debounce の時間だけ待って**1回だけ**組む。
 * 行数が増える編集(著者紹介など)もこの1回に必ず入る — 値そのものは
 * 打つたびに store へ入っており、held していたのは組版だけだから。
 *
 * focusout→focusin の隙間(欄から欄へ移る一瞬)で栓が抜けないよう、
 * 読み直しは setTimeout(0) でイベントの波が収まってから行う
 */
function useDeferHold(): boolean {
  const [hold, setHold] = useState(false);
  useEffect(() => {
    let t = 0;
    const read = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const el = document.activeElement;
        setHold(
          document.hasFocus() &&
            el instanceof HTMLElement &&
            el.hasAttribute('data-defer-typeset'),
        );
      }, 0);
    };
    document.addEventListener('focusin', read);
    document.addEventListener('focusout', read);
    window.addEventListener('blur', read);
    window.addEventListener('focus', read);
    read();
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('focusin', read);
      document.removeEventListener('focusout', read);
      window.removeEventListener('blur', read);
      window.removeEventListener('focus', read);
    };
  }, []);
  return hold;
}

/**
 * 原稿を取り込み直したとき、スタジオで章の途中に置いた絵がどうなったかの断り。
 * **黙って動かさない**(差し込みページを巻末へ寄せたときと同じ作法。2026-08-21)。
 * 同じ段落へ戻せた絵は、戻っているので言わない — 言うのは場所が変わった絵だけ
 */
function carriedImagesNotes(fit: InsertFit): string[] {
  const out: string[] = [];
  // 章を並べ替えた・足した・消した原稿で、差し込みと章ごとの指定が同じ章についていったこと
  // (2026-09-25 見直し S1-6。前は番号どおりに別の章へ付け替わり、画面の説明も違っていた)
  if (fit.followed) {
    out.push(
      `章の並びが変わったので、挿絵ページ・コラムページ・章ごとの指定 ${fit.followed}件を、` +
        'もとと同じ章についていくよう付け直しました（章の題と本文で照らし合わせています）',
    );
  }
  if (fit.imagesMoved) {
    out.push(
      `章の途中に入れていた画像のうち ${fit.imagesMoved}枚は、前にあった段落が見つからなかったので、` +
        'その章の最後に移しました（［挿絵］の一覧で場所を選び直せます）',
    );
  }
  return out;
}

export function App() {
  const {
    settings,
    manuscript,
    source,
    cover,
    isSample,
    loaded,
    sampleArtLoading,
    fetchSampleArtIfPending,
    setSettings,
    applyPreset,
    setManuscript,
    patchManuscript,
    reparse,
    loadSample,
    startNewBook,
    replaceProject,
    hydrate,
    undo,
    redo,
  } = useProject();
  /**
   * いま効いている綴じ方。(2026-10-03 中綴じ)中綴じは出し先が中綴じの決まりを持つときだけ効く
   * (KDP では選んでいても無線。bindingOf)。以降の組版・表紙・書き出し・控えは、みなこれを見る
   */
  const saddleOn = bindingOf(settings) === 'saddle';
  /** 中綴じの共紙(表紙も本文と同じ紙。表1・表4 は本文 PDF の先頭と末尾のページに入る) */
  const selfCover = saddleOn && saddleCoverOf(settings) === 'self';
  /**
   * 中綴じで、奥付の手前に入れている白いページの枚数。**保存しない画面の状態**(組み上がったページ数から決まる)。
   * 4 の倍数にそろえる足し算は、下の「ノドの書き戻し」と同じ effect の中で、順番を決めて走らせる
   */
  const [saddlePadCount, setSaddlePadCount] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  // 入口画面の［続けて作る］から、トップバーと同じファイル選択を開く
  const projectBarRef = useRef<ProjectBarHandle>(null);
  const coverRef = useRef<CoverEditorHandle>(null);
  /** 05 を開いたとき、奥付のページへプレビューを飛ばすのに使う */
  const previewRef = useRef<PreviewHandle>(null);
  const [step, setStep] = useState<StepId>('shape');
  /**
   * 「印刷所の決まり」の欄に触っているあいだ、下見のどこを色づけるか(2026-10-01 ユーザーと決定)。
   * 欄は ShapeStep の中、色づけは下見の上なので、ここで預かって渡す
   */
  const [printFocus, setPrintFocus] = useState<PrintFocus>(null);
  /** AI タブの［入稿の数字を調べる］から飛ぶ合図(ShapeStep の focusPrintRules) */
  const [shapeFocus, setShapeFocus] = useState<{ seq: number; to: 'head' | 'paste' } | null>(null);
  /** サイドバーの実体と、工程ごとのスクロール位置の覚え書き(.main の aside を参照) */
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarScrollMemo = useRef<Partial<Record<StepId, number>>>({});
  useEffect(() => {
    const el = sidebarRef.current;
    if (el) el.scrollTop = sidebarScrollMemo.current[step] ?? 0;
  }, [step]);
  /**
   * AI タブの［入稿の数字を調べる］から飛んできたら、見出しまで動かす。
   * **上の覚え書きを戻す effect より後ろに置く**(同じ描画のあと、後ろの effect が勝つ。子の effect で動かすと、
   * 覚え書きの位置に上書きされる)。rAF にしない: 前の面(AI タブ)の高さで計算されて行き過ぎた実績がある(ArtStep の focusPane)
   */
  const jumpToPrintRules = useRef(false);
  useEffect(() => {
    if (step !== 'shape' || !jumpToPrintRules.current) return;
    jumpToPrintRules.current = false;
    // 'paste' は、AI の返事を貼る箱まで(見出しで止めると、箱は畳まれた1行の下にあって見つけにくい。2026-10-01 ユーザー指摘)
    const id = shapeFocus?.to === 'paste' ? 'print-guide-box' : 'print-rules-head';
    (document.getElementById(id) ?? document.getElementById('print-rules-head'))?.scrollIntoView({ block: 'start' });
  }, [step, shapeFocus]);
  /**
   * 表1の書名・著者名の色を、どう決めて刷ったか(CoverEditor が描いた結果を返してくる)。
   * **色の欄は帯にあり、描いているのは表紙エディタ**なので、ここで受けて渡す
   * (プレビューから章番号を受けて帯へ渡すのと同じ配り方)
   */
  const [coverFrontInk, setCoverFrontInk] = useState<FrontInk>('picked');
  /**
   * 全画面の入口(StartScreen)を出しているか。
   * サイドバー+プレビューの `.main` の代わりにこれを出す(01 だけの特別扱い)
   */
  const [showStart, setShowStart] = useState(false);
  /**
   * 入口画面のどの段か。
   * **メニューのときはトップバーも出さない**(「タイトルと3つのボタンだけが見えているべき」)。
   * 新規作成に入ったら出す — そこで右上の［保存する］を指して説明するので、
   * 指す先が画面に無いと話が通らない
   */
  const [startMode, setStartMode] = useState<'menu' | 'new'>('menu');
  /**
   * 07 でいま何を書き出そうとしているか。null なら「選ぶ画面」。
   *
   * **選ぶ画面はプレビューを出さない**(分岐するだけの場所なので、01 と同じ型)。
   * 何かを選んだら、その1つを確かめながら書き出すのでプレビューを戻す。
   * ExportStep の中に閉じ込めず App が持つのは、この出し分けをするため
   */
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  /** 書き出しの入口で「作るもの」の欄を開いているか(ExportStep のコメント参照) */
  const [choosingOutputs, setChoosingOutputs] = useState(false);
  /**
   * プレビューを出さない全画面の工程。
   *
   * - 書き出しの「何を出すか選ぶ画面」… 分岐するだけの場所
   * - AI に手直ししてもらう … 渡して受け取るだけの場所。誌面が横にあると
   *   「ここで本文を書き換えるのか」と読める(2026-08-19 ユーザー指摘)
   */
  const exportHub = step === 'export' && exportTarget === null && !showStart;
  /**
   * ［電子書籍の本文］も下見を出さない(2026-08-21 ユーザー判断)。
   *
   * > まず、この画面ではプレビューを出したらいけないと思う。そもそもそれが間違いのもとだよね。
   * > だってチェックできないのに、わざわざチェックさせる意味がないじゃん
   *
   * このアプリの下見は1つしかなく、中身は**紙の組版**(manuscriptHtml)。
   * 電子書籍に版面は無いので、電子の姿は原理的に映せない。前日は
   * 「この下見は紙の組み方です」という札(.preview-what)を出して断ったが、
   * **断ってまで出す値打ちが無かった** — 確かめられないものを確かめさせている。
   * 画面ごと `.fullstage` に載せ替え、札と、EPUB の1ページ目に入る表紙の絵
   * (.preview-first-page)も一緒に外した。表紙の絵は板の中に入れると 109px 食って
   * ［書き出す］が折り返しの下へ落ちたので置いていない(実測。理由は ExportStep)
   */
  const exportEbook = step === 'export' && exportTarget === 'ebookBody' && !showStart;
  /**
   * ［紙の本文］も下見を出さない全画面にそろえた(2026-09-24 ユーザー決定)。
   * 下見は［紙の本文を確かめる・直す］で本文の下見へ飛んで見る
   */
  const exportPaper = step === 'export' && exportTarget === 'paperBody' && !showStart;
  const fullPage = (exportHub || exportEbook || exportPaper || step === 'ai') && !showStart;
  /**
   * ProjectBar を作り直させるための key。
   * 入口画面からバックアップ先フォルダを選んだとき、トップバーの ProjectBar は
   * 起動時に一度だけ許可状態を調べて自分の state に持っているので、それを
   * 素通りして選ぶと ProjectBar 側は「フォルダ未設定」のままになり自動保存が
   * 始まらない。ProjectBar 自体は触れない(読み込み処理を二重に書かない)ので、
   * key を変えて作り直させることで起動時の判定をもう一度走らせる
   */
  const [projectBarKey, setProjectBarKey] = useState(0);
  /** 組み上がった実ページ数。表紙の背幅計算に使う */
  const [pageCount, setPageCount] = useState(0);
  /**
   * **まだページ数を数えている最中か。**(2026-08-22)
   *
   * 長い本は、紙が見えてから全部組み上がるまでに何十秒もかかる。
   * そのあいだ帯にも入稿の控えにも「120ページ（概算）」(既定値)が出ていた。
   * 背幅も KDP の入稿値もページ数から作るので、**いいかげんな数を出すのは害になる。**
   * 数え終わるまでは数を出さず「数えています…」と書く。
   *
   * **初めは false。** 立ち上がりの合図はプレビューが出す(組みはじめたら true)。
   * 最初から true にすると、**プレビューが1度も組んでいない画面**
   * (入口を閉じずに表紙へ行った、など)で「数えています…」が出たまま止まる
   */
  const [counting, setCounting] = useState(false);
  /** 挿絵がいま何ページ目に出ているかを画面に出すための、組み上がりの情報 */
  const [layoutInfo, setLayoutInfo] = useState<LayoutInfo>(emptyLayout);
  /** いまの layoutInfo を、どの組版HTMLから組んだか(「いじった1枚へ連れて行く」の突き合わせ) */
  const [layoutHtml, setLayoutHtml] = useState('');
  /**
   * プレビューにいま出ている章の番号(0始まり)。**見開きなら2つ入ることがある。**
   * 帯が「いま見ている章」の飾りを出すのに使う(2026-08-19 ユーザーの発案)。
   *
   * ページ番号ではなく VivliostylePreview から直に章の一覧をもらう。
   * ページ番号を介すと、見開きの片側しか拾えず、しかも前から進むか後ろから
   * 戻るかで拾う側が変わっていた(2026-08-20 ユーザー報告)
   */
  const [visibleChapters, setVisibleChapters] = useState<number[]>([]);
  /**
   * いま画面に出ているコラムページの id。**帯が「このコラムだけ」を出すのに使う。**(2026-10-08)
   * コラムを見ながら帯で字の色を変えたら、本全体の字が白くなって本文が消えた(ユーザーの録画)。
   * 背景の濃さは帯で動く(コラムが本全体の濃さを継いでいる)のに、色だけ左の欄だったための取り違え
   */
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  /** いま画面に出ている大扉・目次・奥付。帯が「このページだけ」を出すのに使う(2026-10-09。背景の濃さ・フチを帯へ移した) */
  const [visiblePages, setVisiblePages] = useState<SpecialPage[]>([]);
  /** 表紙の左で開いている面。表紙の帯が、その面の文字(書名・あらすじ・背)に向く(2026-10-09) */
  const [coverPane, setCoverPane] = useState<CoverPane>('front');
  /** 帯の向き先を外から変える合図(［背景］タブで面を開いたとき。FormatBar の scopeRequest) */
  const [barScopeRequest, setBarScopeRequest] = useState<{ scope: BarScope; seq: number } | undefined>();
  const [importError, setImportError] = useState('');
  /** 入口の［続けて作る］で選んだ .json が読めなかった理由。入口ではトップバー(ProjectBar の知らせ)が隠れているので、カードの下に出す */
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (!showStart) setLoadError('');
  }, [showStart]);
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [notice, setNotice] = useState('');
  /**
   * ［このアプリについて］。**開くかどうかだけでなく「どの節へ」も持つ。**
   * 入口画面の一行リンクは［法人の方へ］を名指しで開く — トップバーは
   * その画面のあいだ畳まれているので、そこからしか行き着けない
   */
  const [about, setAbout] = useState(false);
  const [aboutSection, setAboutSection] = useState<AboutSection | null>(null);
  const openAbout = (section?: AboutSection) => {
    setAboutSection(section ?? null);
    setAbout(true);
  };
  /** ヘルプ。書いている最中に何度も見返す参照なので、常に開ける場所に置く */
  const [help, setHelp] = useState(false);
  /**
   * 画面のどこにいても出せる一言の札(Ctrl+Z で使う)。
   *
   * ページ一覧の `notify()` は `.main` の中にあるので、**表紙・AI・書き出しの
   * 画面では見えない。** 取り消しはどの画面でも効くので、札のほうを外へ出した。
   * `seq` は同じ文でも出し直すため(key を変えて出現のアニメを走らせる)
   */
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const toastTimer = useRef<number>(0);
  const say = useCallback((text: string) => {
    setToast({ text, seq: Date.now() });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  /**
   * **いま打っている欄と、その打ち始めの控え。**
   *
   * 文字を打つ欄の中で Ctrl+Z を押したとき、
   * 「その欄に打った文字を戻すだけ」で済むかどうかを見分けるために持つ。
   * 履歴の一番上が**その欄の打ち始めの控えのまま**なら、1つ戻しても
   * 変わるのはその欄の文字だけ — 本の設定までは巻き戻らない。
   *
   * **document の「上り」で拾うこと(capture ではない)。**
   * React は入力の受け口を #root に付けているので、上りで拾えば
   * 店の更新が済んだあとに走る。capture では入力より前に走ってしまい、
   * まだ積まれていない一つ前の控えを掴む(実測: それで毎回すれ違った)。
   * queueMicrotask で後ろへずらす手も効かない — listener を1つ呼ぶたびに
   * JS のスタックが空になり、そこで microtask が流れてしまうため
   */
  const typed = useRef<{ el: Element; top: unknown } | null>(null);
  useEffect(() => {
    const onInput = (e: Event) => {
      const el = e.target;
      if (!(el instanceof Element) || !isTyping(el)) return;
      const past = useProject.getState().past;
      typed.current = { el, top: past[past.length - 1] ?? null };
    };
    document.addEventListener('input', onInput);
    // 手が止まってから店へ渡す欄(コラム)は、渡した瞬間に打ち始めを記録し直す(typingEvents)
    document.addEventListener(TYPING_COMMITTED, onInput);
    return () => {
      document.removeEventListener('input', onInput);
      document.removeEventListener(TYPING_COMMITTED, onInput);
    };
  }, []);

  /**
   * Ctrl+Z で1つ戻す / Ctrl+Shift+Z・Ctrl+Y でやり直す(Mac は ⌘)。
   *
   * ユーザーの言(2026-08-20)「Undo を Ctrl+Z でできる、みたいな機能はつけられない？
   * **ついついやっちゃう**んだけど」。ついつい押すのだから、
   * **押して何も起きないのがいちばん困る。** 戻せるものが無いときも必ず札を出す。
   *
   * プレビューは iframe ではなく同じ書類の中に組まれるので、
   * 誌面をクリックしたあとのキーもここまで上がってくる(実測)。
   *
   * ### 文字を打つ欄の中(実測 2026-08-20)
   *
   * **ブラウザの既定の取り消しは、この画面では効かない。** React が値を持つ欄
   * (このアプリの入力欄はすべてそう)は、打つたびに React が value を書き戻すので、
   * Chrome が持っている「打つ前の文字」の控えがそこで捨てられる。
   * 実測: 書名の欄に abcde と打って Ctrl+Z を押しても、文字は 1 つも戻らなかった。
   * つまり**既定に任せる = 押しても本当に何も起きない**。
   *
   * そこで、欄の中では次の2つに分ける:
   *
   * - 履歴の一番上が**その欄の打ち始め**なら、1つ戻す。
   *   変わるのはその欄の文字だけなので、本ごと巻き戻ることはない
   * - そうでない(打つ前に別のことをした・別の欄で打った)なら**何も変えない**。
   *   代わりに「欄の外をクリックしてから」と札で言う。
   *   ここで戻すと、文章を書いている最中に本の設定が巻き戻る
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // **かな漢字変換の最中は触らない。** 変換中の Ctrl+Z は
      // 「変換をやり直す」ためのもので、IME に渡さないと日本語が打てなくなる
      if (e.isComposing || e.key === 'Process') return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const isUndo = k === 'z' && !e.shiftKey;
      const isRedo = (k === 'z' && e.shiftKey) || k === 'y';
      if (!isUndo && !isRedo) return;
      if (isTyping(document.activeElement)) {
        // 打ちかけの字を先に店へ渡させる(0.4 秒待つ欄。渡すと上の記録が今の欄に替わる)
        document.activeElement?.dispatchEvent(new Event(TYPING_FLUSH));
        const t = typed.current;
        const past = useProject.getState().past;
        const mine =
          isUndo && t && t.el === document.activeElement && past[past.length - 1] === t.top;
        if (!mine) {
          // **既定は邪魔しない**(preventDefault しない)。効くブラウザでは効かせる
          say('この入力欄の中では元に戻せません。欄の外をクリックしてから押してください');
          return;
        }
        e.preventDefault();
        const label = undo();
        // 欄の見た目も戻った値に合わせてもらう(フォーカス中は外の値を受けない欄がある。typingEvents)
        document.activeElement?.dispatchEvent(new Event(TYPING_REVERTED));
        // この打ち始めはもう使った。続けて押しても、その前の操作までは戻さない
        typed.current = null;
        say(`「${label}」を、打つ前に戻しました`);
        return;
      }
      e.preventDefault();
      // Mac は ⌘。押した手が知っているキーで案内する
      const mod = e.metaKey && !e.ctrlKey ? '⌘' : 'Ctrl';
      if (isUndo) {
        const label = undo();
        if (!label) {
          say('これ以上は戻せません（戻せるのは、いまの本を開いてからの操作だけです）');
          return;
        }
        const left = useProject.getState().past.length;
        say(
          `「${label}」を元に戻しました（${mod}+Shift+Z でやり直せます` +
            (left ? `／あと ${left} 回戻せます）` : '）'),
        );
        return;
      }
      const label = redo();
      say(label ? `「${label}」をやり直しました` : 'やり直せるものはありません');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, say]);

  // 07 を離れたら選択を戻す。次に開いたとき「何を書き出すか」から始まるようにする
  useEffect(() => {
    if (step !== 'export') {
      setExportTarget(null);
      setChoosingOutputs(false);
    }
  }, [step]);
  /**
   * **選んでいたカードが、作るもの・出し先を変えて無くなったら、選ぶ画面へ戻す。**
   * (紙を「作らない」にしたのに紙の本文の画面が残る、Kobo に変えたのに KDP 用の表紙が残る)
   */
  useEffect(() => {
    if (exportTarget && !exportTargetAvailable(exportTarget, settings)) setExportTarget(null);
  }, [exportTarget, settings]);

  /**
   * 05 を開いたら、奥付のページを出す。
   *
   * 奥付は1ページの紙面なので、**書名や発行日を入れながら見えていないと確かめられない**
   * (表紙と同じ「面をクローズアップする」型)。組み直しで奥付のページ番号が動いたら
   * ついていく — 挿絵を足したり判型を変えたりすると最終ページはすぐ動く
   */
  /**
   * 奥付へ飛ぶ前に見ていたページ。**戻ってきたらそこへ返す。**
   * 飛びっぱなしだと、本文の作業に戻ったときにさっきまで直していたページを
   * 探し直すことになる(2026-08-19 ユーザー指摘)
   */
  const beforeColophon = useRef<number | null>(null);
  useEffect(() => {
    if (step === 'colophon') {
      if (!layoutInfo.colophonPage) return;
      // 奥付を開いているあいだの組み直し(書名を打つなど)では控え直さない。
      // 控えるのは、他のステップから入ってきた最初の1回だけ
      if (beforeColophon.current === null) {
        beforeColophon.current = previewRef.current?.currentPage() ?? null;
      }
      previewRef.current?.goToPage(layoutInfo.colophonPage);
      return;
    }
    if (beforeColophon.current !== null) {
      previewRef.current?.goToPage(beforeColophon.current);
      beforeColophon.current = null;
    }
  }, [step, layoutInfo.colophonPage]);

  /**
   * 07 で書き出すものを選ぶ。**選んだそのつど、下見を1ページ目へ戻す。**
   *
   * ここは入稿するものを頭から確かめる場所なので、直前の工程で見ていたページを
   * 引き継ぐと「本文の途中から始まるデータ」に見える(2026-08-20 ユーザー報告
   * 「EPUBで本文を見たら、最初からではなく途中からの本文が出てきた」)。
   * 工程に入った1回だけでは足りない — 紙PDF→EPUB と選び直したときも先頭であってほしい。
   *
   * **effect ではなく、ここ(state を変える前)で戻すこと。**
   * 本文を選ぶと下見が単ページに切り替わり、VivliostylePreview は組版器ごと作り直す。
   * 作り直しは「いま見ていたページ」を控えてから始まり、組み上がったらそこへ返す作りで、
   * **子の effect は親の effect より先に走る**(React)。effect で戻すと、
   * 控えるほうが先に走って 20ページ目を掴み、あとから戻した1ページ目を上書きしてしまう
   * (実測: それで 20ページ目のままだった)。ここで戻せば、控える前に 1ページ目になる
   */
  const chooseExportTarget = useCallback((t: ExportTarget | null) => {
    if (t !== null) previewRef.current?.goToPage(1);
    setExportTarget(t);
  }, []);

  // **起動したら必ず入口(トップ)から。** 以前は初回起動だけだったが、トップを
  // ショーケースにしたので毎回ここをくぐる(2026-09-02 ユーザー要望
  // 「最初中身から開けてしまう」)。作業途中の本は消えておらず、
  // ［この本の作業に入る］の1クリック先にそのまま居る
  useEffect(() => {
    if (loaded) setShowStart(true);
  }, [loaded]);

  /**
   * **入口を閉じて作業画面に入ったら、はじめての起動のサンプルの絵を取りに行く。**(2026-10-12 1.0.3。修正リストの 6)
   * 入口を開いただけで約 9MB を読んでいた。入口だけ見て帰る人・［新規作成］や読み込みへ進む人には要らない。
   * 入口の閉じ方は［スタジオで本をつくる］・×・Esc・めくれる本・カードと何通りもあるので、showStart が下りたところで拾う。
   * **一度入口を出してから下りたときだけ。** 起動した回は、上の「入口を出す」と同じ描画でこちらも走り、
   * まだ下りたままの showStart を見て取りに行ってしまう(実測: 入口だけで絵 14 枚・9.2MB のままだった)
   */
  const startShownRef = useRef(false);
  useEffect(() => {
    if (showStart) {
      startShownRef.current = true;
      return;
    }
    if (loaded && startShownRef.current) void fetchSampleArtIfPending();
  }, [loaded, showStart, fetchSampleArtIfPending]);

  /** 入口画面からバックアップ先フォルダを選ぶ。選んだあと ProjectBar を作り直させる */
  async function handleChooseBackupFolder() {
    const state = await chooseBackupFolder();
    setProjectBarKey((k) => k + 1);
    return state;
  }

  /**
   * ノドの下限をページ数に追従させる。
   *
   * ノドの下限はページ数で段階的に上がる。KDP は 150/300/500/700 で 9.6→12.7→15.9→19.1→22.3mm、
   * 「その他の印刷所」は利用者の入れた「◯ページをこえたら◯mm」(2026-10-01。gutterFloorMm が出し先で分ける)。
   * 組版はこの下限を `estimatedPages` から決めているが、この値は作成時の 120 のまま
   * 一度も更新されていなかった。**厚い本はノドが規定に届かない**という
   * 静かな不具合になっていたので、組み上がった実ページ数を書き戻す。
   *
   * **段が変わるときだけ書く。** 毎回書くと再組版が走り続ける。
   * ノドを広げると1ページの行数が減ってページ数は増える方向にしか動かず、
   * 下限もページ数に対して単調非減少なので、この更新は数回で必ず収まる
   * (KDP の段は5つ、印刷所は2つで、下がる方向へは戻らない)。
   * 印刷所の「◯ページ超」の値が基準より小さくても下がらないのは、printRulesOf が
   * 切り上げているから(下がると 201→10mm→199→15mm→201… と振動する)。
   */
  const { printTarget, printRules, estimatedPages } = settings;
  // この書き戻しは、中綴じの白いページの収束と同じ effect の中で走らせる(下の paperPagesNow のあと)。
  // 2つが別々の effect だと、組み直しが重なって3回走りうる(2026-10-03 設計の監査)

  // バックアップに渡す1冊ぶん。**毎回作り直さないこと。**
  // 描画のたびに新しいオブジェクトになると「中身が変わった」と見なされ、
  // 同じ内容の9MBが書かれ続ける(2026-08-17 に実際に起きた)
  const snapshot = useMemo(
    () => ({ settings, cover, manuscript, source }),
    [settings, cover, manuscript, source],
  );

  const layout = useMemo(() => computeLayout(settings), [settings]);
  // 最後は必ず存在する書体へ倒す。bodyFont も theme も不正だと
  // BODY_FONTS[undefined] が undefined になり、currentFont.stack で画面が真っ白になる
  // (保存の読み込みでは sanitize が theme を直すが、ここは最終防波堤。2026-09-04)
  const currentFont =
    BODY_FONTS[settings.bodyFont] ??
    BODY_FONTS[THEME_BODY_FONT[settings.theme]] ??
    BODY_FONTS.serif;
  // 選んだ本文書体と見出しのゴシックを、組版HTMLに @font-face ごと持たせる。
  // これが無いと印刷経路(iframe)で書体が游明朝などに置き換わり、選択が出力に届かない
  // 本に出てくる文字だけを集める。@font-face をその字を含むサブセットに絞るのに使う。
  // 原稿が変わるたびに作り直すが、書体を切り替えたときだけ CSS を組み直せば足りる
  const bookText = useMemo(() => {
    const parts = [
      manuscript.title,
      manuscript.author,
      manuscript.publisher,
      manuscript.authorProfile ?? '',
    ];
    for (const ch of manuscript.chapters) {
      parts.push(ch.no ?? '', ch.title);
      for (const b of ch.blocks) {
        // **文字を持つブロックは全部数えること。** 抜けると、その字だけ書体に
        // 含まれず刷りで化ける(2026-08-19 に quote / list を足した)
        if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') parts.push(b.text);
        else if (b.type === 'list') parts.push(b.items.join(''));
        else if (b.type === 'image') parts.push(b.caption ?? b.alt ?? '');
      }
    }
    // コラムページは原稿ではなく設定側にあるが、刷られる文字であることは同じ。
    // ここに足さないと、コラムにしか出てこない字だけ書体が埋め込まれずに化ける
    for (const c of settings.columnPages ?? []) parts.push(c.title, c.text);
    // **奥付・後付・目次に出る字も数える。**(2026-09-04 レビュー指摘)
    // 「発行日」「著者」などのラベルや、奥付に打った発行日・印刷所・ISBN の値、
    // 著者紹介の見出し、目次の「目次」が抜けると、その字だけ刷りで別書体に化ける。
    // 発行日の日付は now で変わるので、ここでは値だけ足し、日付の生成字は下の GLYPHS で賄う
    parts.push(
      PROFILE_TITLE,
      '目次',
      manuscript.published ?? '',
      manuscript.printer ?? '',
      manuscript.isbn ?? '',
      manuscript.colophonExtra ?? '',
    );
    for (const row of colophonRows(manuscript)) parts.push(row);
    // **組版が作り出す字。** 全角数字(3桁以上の縦中横)・ダッシュ・三点リーダ・
    // 場面転換の＊・箇条書きの・と全角数字＋．。原稿の字面には現れないが刷りには出る
    // ！？は縦中横(applyTcy)が半角の !? から作る全角。詰め数字フォントの unicode-range が
    // これで引っかかる(無いと ！？ だけ本文の書体に戻って横圧縮の経路へ落ちる)
    const GLYPHS = '０１２３４５６７８９―…‥・＊　。、．！？';
    parts.push(GLYPHS);
    // 同じ字は1つでよいので、重複を落としてから渡す(長さが数十分の一になる)
    return [...new Set(parts.join(''))].join('');
  }, [manuscript, settings.columnPages]);
  const fontFaceCss = useMemo(
    () =>
      collectFontFaceCss(
        [
          currentFont.stack,
          // 縦中横の詰め数字(amayadori-tcy-〜)。本文・章・コラムの書体ごとに1つずつある
          tcyStack(settings.bodyFont),
          HEADING_FONT_STACK,
          // **章ごとに違う書体を使ったら、それも埋め込むこと。**
          // 集め忘れると、その章だけ閲覧環境の書体に置き換わって刷り上がりが変わる
          ...Object.values(settings.chapterFont ?? {}).flatMap((f) =>
            BODY_FONTS[f] ? [BODY_FONTS[f].stack, tcyStack(f)] : [],
          ),
          // ノンブルと柱に別の書体を選んでいたら、それも
          settings.nombreFont ? (BODY_FONTS[settings.nombreFont]?.stack ?? "") : '',
          settings.runningHeadFont ? (BODY_FONTS[settings.runningHeadFont]?.stack ?? "") : '',
          // コラムページごとの書体も
          ...(settings.columnPages ?? []).flatMap((c) =>
            c.bodyFont && BODY_FONTS[c.bodyFont] ? [BODY_FONTS[c.bodyFont].stack, tcyStack(c.bodyFont)] : [],
          ),
          // 奥付・著者紹介に別の書体を選んでいたら、本文と見出しの両方を
          ...[settings.colophonType, settings.profileType].flatMap((m) => [
            m?.bodyFont ? (BODY_FONTS[m.bodyFont]?.stack ?? '') : '',
            m?.headingFont ? (BODY_FONTS[m.headingFont]?.stack ?? '') : '',
          ]),
        ].filter(Boolean),
        bookText,
      ),
    // 章ごと・コラムページごとの書体、ノンブル・柱の書体を変えたときも集め直す。
    // 忘れると、選んだ書体が埋め込まれないまま組まれる
    [
      currentFont,
      bookText,
      settings.chapterFont,
      settings.columnPages,
      settings.colophonType,
      settings.profileType,
      settings.nombreFont,
      settings.runningHeadFont,
    ],
  );
  /**
   * **塗りを既定値に固定した設定。プレビューの組版はこちらで組む。**(2026-08-22)
   *
   * 背景・色・フチ・帯は文字を1文字も動かさない「塗り」なので、変えても
   * この値が変わらず、組版HTMLも変わらず、組み直しが起きない(preview/paint.ts)。
   * 中身が同じなら**前回と同じ参照**を返す — 塗りのスライダーを動かしている
   * あいだ、組版HTML(数十ms)を作り直さないため
   */
  const neutralRef = useRef<typeof settings | null>(null);
  const neutralSettings = useMemo(() => {
    const n = paintNeutral(settings);
    if (neutralRef.current && sameNeutral(neutralRef.current, n)) return neutralRef.current;
    neutralRef.current = n;
    return n;
  }, [settings]);
  /**
   * 奥付・コラムの文言を打っているあいだは組版を待たせる(useDeferHold)。
   * 欄を離れたら1回だけ流れる
   */
  const deferHold = useDeferHold();
  /**
   * **HTML の組み立ても栓の内側に入れる。**(2026-09-11 ユーザー報告
   * 「コラムに文字を入力するときにかくつく」)
   * 栓(deferHold)と debounce は下の debouncedHtml にしか掛かっておらず、
   * manuscriptHtml そのものは1キーごとに走っていた。本1冊ぶんの HTML は
   * 同梱画像の data URI を抱えた巨大な文字列で、これを毎打鍵作るのが
   * かくつきの正体。原稿と設定を先に堰き止めてから組み立てる
   */
  const heldManuscript = useDebounced(manuscript, 150, deferHold);
  const heldNeutral = useDebounced(neutralSettings, 150, deferHold);
  /**
   * **電子書籍だけの本は、紙の組版を作らない。**(2026-09-24 ユーザー決定「止めて電子の下見だけにする」)
   * 下見は電子(EPUB)だけになり、紙の組版HTMLを作る手間も組版も要らない。
   * 作るものは塗り(paintNeutral)で固定してあるので、ここは生の設定から読む
   */
  const paperOn = outputsOf(settings).paper;
  const previewHtml = useMemo(
    // 書名・著者名は縦用と横用の両方を入れる(titleBothWays)。書名の向きは下見の塗りのパッチが選ぶので、
    // 縦横を切り替えても組み直さない(2026-10-03。紙の書き出しは下の handlePrintPdf で完全な設定から組む)
    // サンプルの絵を取りに行っているあいだは組まない(絵の無いサンプルを組んでから組み直さない。store の sampleArtLoading)
    () =>
      loaded && paperOn && !sampleArtLoading
        ? manuscriptHtml(heldManuscript, heldNeutral, fontFaceCss, {
            titleBothWays: true,
            // 中綴じ(2026-10-03): 奥付の手前に白いページを足して 4 の倍数にそろえる。共紙は、表1・表4 の仮の枠を先頭と末尾に入れる
            // (絵は入れない。表紙を直すたびに本文を組み直さないため)。無線綴じは何も渡さず、組版HTMLは変わらない
            ...(bindingOf(heldNeutral) === 'saddle'
              ? {
                  padPages: saddlePadCount,
                  ...(saddleCoverOf(heldNeutral) === 'self' ? { coverFaces: 'placeholder' as const } : {}),
                }
              : {}),
          })
        : '',
    [heldManuscript, heldNeutral, loaded, sampleArtLoading, fontFaceCss, paperOn, saddlePadCount],
  );
  /**
   * いまの塗り。組み上がっている紙面へ CSS の差し替えだけで重ねる(組版0回)。
   * 書き出しは常に完全な settings を通る(下の handlePrintPdf と各 exporter)ので、
   * 画面だけ変わって出力に乗らない、という向きの事故は経路の形からして起きない
   */
  const paintCss = useMemo(() => previewPaintCss(settings), [settings]);
  /**
   * 組版のもとになる HTML は、**手が止まるのを待ってから**渡す。(2026-08-22)
   *
   * > ユーザーは1つの作業が終わるのを待たない。書体を変えてサイズを変えて行間を変えて
   * > 段組みを変えてヘッダーフッターを調整して、と一気に進む。その1つ1つで組版が
   * > 走ったら効率が悪すぎる(ユーザー要件)
   *
   * 長い本は1冊組むのに20秒かかる(実原稿293ページ・実測)。400ms のままだと
   * 1〜2秒おきの連続変更がぜんぶ別の組版になり、組んでは捨てるを繰り返す。
   * **150ページを超える本は1.5秒待って1回に合流させる**(useDebounced は変更の
   * たびに待ち直すので、触り続けているあいだは組み始めない)。
   * 短い本は組み直しが安い(1秒前後)ので、いままでどおり 400ms で組む。
   * 待っているあいだも前の紙面は見えたまま(VivliostylePreview が面を2枚持つ)。
   *
   * 1.5秒より間があいた変更は合流をすり抜けるが、そちらは組版側の打ち切りが拾う
   * (VivliostylePreview の cancelRender — 仕掛かりを即座に止めてから新しい1冊を組む)。
   * 「前の1冊を組み終えてから次」には決してならない。
   * ページ数の書き戻しや挿絵位置の通知は complete まで組み上がった1冊しか出さないので、
   * 打ち切られた組版の結果が保存やノド計算に混ざることはない
   */
  const debouncedHtml = useDebounced(previewHtml, pageCount > 150 ? 1500 : 400, deferHold);

  /**
   * **下見の種類。紙の組版か、電子書籍(EPUB)か。**(2026-09-24 ユーザー決定)
   * 紙と電子の両方を作る本は、下見の下の［紙の本｜電子書籍］で切り替える。
   * 電子書籍だけの本は、いつも電子の下見。紙だけの本は、いつも紙
   */
  const [previewMode, setPreviewMode] = useState<'paper' | 'ebook'>('paper');
  const outs = outputsOf(settings);
  /**
   * 表紙を書き出す画面。**ここでは電子を見ていても、表紙の見本の下で紙の下見を組ませる。**
   * 紙の表紙の背幅はページ数で決まる。電子の下見のまま紙を隠し続けると紙の組版が止まり、
   * 前のページ数の背幅で表紙を書き出してしまった(2026-09-24 レビューで発見)
   * **紙の本文を書き出す画面も同じ**(2026-10-03 監査)。電子の下見のまま紙を隠すと、紙が組まれず paperPagesNow が出ないまま、
   * 中綴じの主ボタンが「組み上がるまで待って」と言い続けて押せなくなる(行き止まり)。この画面は紙の下見を見せるので、組ませてよい
   */
  const coverTarget =
    step === 'export' &&
    (exportTarget === 'paperCover' || exportTarget === 'ebookCover' || exportTarget === 'paperBody');
  const showEbook = outs.ebook && (!outs.paper || (previewMode === 'ebook' && !coverTarget));
  /**
   * 電子の下見の中身。**書き出しと同じ buildEpubBook で作る**(違うのは画像の参照先だけ)。
   * 見ているときだけ作る。原稿と設定は手が止まるのを待ってから(打鍵のたびに作り直さない)。
   * 塗りの設定(背景など)は EPUB に入らないので、中身が前と同じなら前のものを使い回し、
   * 下見を読み直さない(スライダーを動かすたびに画面がまたたかない)
   */
  const heldSettings = useDebounced(settings, 400, deferHold);
  /**
   * 電子の下見に入れる表紙。**Kobo などの出し先だけ**(EPUB の1ページ目が表紙になる)。
   * 書き出しと同じく CoverEditor に描かせる。表紙・書名・著者名が変わったら描き直す。
   * data URI は1枚で数百KBあるので、使い回しの画像の控え(assetUrl)には入れず、
   * 自前の blob URL にして、替わったら捨てる(2026-09-24 レビューで発見: 下見に表紙が無かった)
   */
  const [ebookCover, setEbookCover] = useState<{ src: string; url: string } | null>(null);
  useEffect(() => {
    if (!showEbook || heldSettings.epubTarget !== 'reader') {
      setEbookCover(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void coverRef.current
        ?.ebookCoverDataUri()
        .then(async (src) => {
          if (!alive || !src) return;
          const blob = await (await fetch(src)).blob();
          if (alive) setEbookCover({ src, url: URL.createObjectURL(blob) });
        })
        .catch(() => {});
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [showEbook, heldSettings.epubTarget, cover, heldManuscript.title, heldManuscript.author]);
  useEffect(
    () => () => {
      if (ebookCover) URL.revokeObjectURL(ebookCover.url);
    },
    [ebookCover],
  );
  const ebookBookRef = useRef<EpubBook | null>(null);
  const ebookBook = useMemo(() => {
    if (!showEbook || !loaded) return null;
    const toUrl = (src: string) => (ebookCover && src === ebookCover.src ? ebookCover.url : assetUrl(src));
    const next = buildEpubBook(
      heldManuscript,
      heldSettings,
      previewImageResolver(toUrl),
      ebookCover?.src,
    );
    const prev = ebookBookRef.current;
    const same =
      prev &&
      prev.css === next.css &&
      prev.files.size === next.files.size &&
      [...next.files].every(([k, v]) => prev.files.get(k) === v) &&
      prev.spine.length === next.spine.length &&
      prev.spine.every((d, i) => d.file === next.spine[i].file);
    if (same) return prev;
    ebookBookRef.current = next;
    return next;
  }, [showEbook, loaded, heldManuscript, heldSettings, ebookCover]);
  const ebookLabels = useMemo(
    () => (ebookBook ? spineLabels(ebookBook, heldManuscript, heldSettings) : []),
    [ebookBook, heldManuscript, heldSettings],
  );

  /**
   * 書き出しの画面から本文の下見へ飛んだとき、戻る先(どの書き出しの画面か)。
   * 下見の上に［← 書き出しに戻る］を出す。書き出しへ戻ったら(どの道からでも)消す
   */
  const [previewReturn, setPreviewReturn] = useState<ExportTarget | null>(null);
  function openBodyPreview(mode: 'paper' | 'ebook') {
    setPreviewMode(mode);
    setPreviewReturn(exportTarget);
    setStep('shape');
  }
  /**
   * 書き出しの［紙の表紙］［電子書籍の表紙］から［…の表紙を確かめる・直す］で表紙の工程へ。**戻り道も付ける。**
   * (2026-09-24 ユーザー要望「本文には［書き出しに戻る］があって便利。表紙にも付けてほしい」)
   */
  function goToCoverFromExport() {
    setPreviewReturn(exportTarget);
    setStep('cover');
  }
  /** 戻り道のボタン。本文の下見の上と、表紙の工程の見本の上に出す */
  const returnLabel: Record<ExportTarget, string> = {
    paperBody: '紙の本文',
    ebookBody: '電子書籍の本文',
    paperCover: '紙の表紙',
    ebookCover: '電子書籍の表紙',
  };
  const returnButton =
    previewReturn && step !== 'export' && exportTargetAvailable(previewReturn, settings) ? (
      <button
        className="go-step preview-return"
        onClick={() => {
          setStep('export');
          chooseExportTarget(previewReturn);
        }}
      >
        ← 書き出しに戻る（{returnLabel[previewReturn]}）
      </button>
    ) : null;
  useEffect(() => {
    if (step === 'export') setPreviewReturn(null);
  }, [step]);
  /**
   * 紙の本文のページ数。**いまの本の姿で組み上がっているときだけ**出す(「この本文は N ページ」)。
   * 原稿と設定 → 組版HTML → 組み上がり、の3段がそろっていなければ、数は古い本のもの
   */
  const paperPagesNow =
    heldManuscript === manuscript &&
    heldNeutral === neutralSettings &&
    debouncedHtml === previewHtml &&
    layoutHtml === debouncedHtml &&
    !counting &&
    pageCount > 0
      ? pageCount
      : null;
  /**
   * **ノドの下限の書き戻し(estimatedPages)と、中綴じの白いページの収束。1つの effect で、順番を決めて走らせる。**
   *
   * ノドの下限はページ数で上がる(KDP・印刷所の「◯ページ超」)ので、組み上がった実ページ数を書き戻す
   * (理由と止まる根拠は、上の estimatedPages のコメント)。中綴じのノドの下限は一定値なので、これは何もしない。
   * 白いページは、**組み上がった紙面(paperPagesNow が出ているとき)から数え直す**:
   * 本文 n0 = 総ページ数 − 紙面に入っていた白いページ − 共紙の表紙(組んだ HTML の覚え書きから読む)、
   * 足す枚数 = (4 − n0 mod 4) mod 4。n0 は白いページに依らない(白いページは本文のあと)ので、書き戻しは1回で収まる。
   * 本を直すたびの組み直しは、本文の1回と白いページの1回、多くて2回(薄い本が前提)
   */
  useEffect(() => {
    if (!pageCount) return;
    const rule = { printTarget, printRules, binding: settings.binding };
    if (gutterFloorMm(pageCount, rule) !== gutterFloorMm(estimatedPages, rule)) {
      setSettings({ estimatedPages: pageCount });
      return;
    }
    if (!saddleOn) {
      if (saddlePadCount !== 0) setSaddlePadCount(0);
      return;
    }
    if (paperPagesNow === null) return;
    const marks = padOfHtml(layoutHtml);
    // 覚え書きの無い紙面は、無線のときに組んだもの(まだ中綴じで組み直されていない)
    if (!marks) return;
    const need = saddlePadOf(paperPagesNow - marks.pad - marks.cover, 'separate').pad;
    if (need !== saddlePadCount) setSaddlePadCount(need);
  }, [
    pageCount, estimatedPages, printTarget, printRules, settings.binding, setSettings,
    saddleOn, saddlePadCount, paperPagesNow, layoutHtml,
  ]);
  /**
   * 紙の本文を書き出せない理由(あれば。主ボタンを押せなくして、この文を出す)。**1か所**(PaperBodyExport → printBlockedReason)。
   * 中綴じは、ページ数が決まり、4 の倍数にそろってからでないと書き出さない(そろわない PDF を印刷所へ渡さない)
   */
  /** 中綴じの本文のページ数(白いページ・共紙の表紙を含まない)。組み上がっているときだけ。ShapeStep の読み上げに使う */
  const saddleBodyPages = (() => {
    if (!saddleOn || paperPagesNow === null) return null;
    const m = padOfHtml(layoutHtml);
    return m ? paperPagesNow - m.pad - m.cover : null;
  })();
  /** 奥付(著者紹介つき)のページがあるか。中綴じの白いページは、あれば奥付の手前、無ければ最後に入る */
  const hasColophon =
    (manuscript.title ? colophonRows(manuscript).length : 0) > 0 || authorProfileParagraphs(manuscript).length > 0;
  const printBlockReason: string | null = !paperOn || !saddleOn ? null : saddleBlockReason(paperPagesNow);
  /**
   * 下見に重ねる CSS。塗りのパッチ(paintCss)に、**「印刷所の決まり」の欄に触っているあいだだけ**
   * 塗り足し・ノドの帯の色づけを足す(2026-10-01)。組版は走らない(同じ <style> の書き換えだけ)。
   *
   * **組み直している最中は描かない**(paperPagesNow が null のあいだ)。古い紙面に新しい数字の帯が乗ると、
   * 帯の幅が紙面と合わない。紙の下見を出していないあいだ(電子書籍の下見・［本のかたち］以外の工程)も描かない
   */
  /**
   * **絵の中の文字が、版面(余白の内側)の外に出ていないか。**(2026-10-02 ユーザー要望)
   *
   * KDP は絵の中に描かれた文字も機械で検出し、版面の外に出ていると印刷できない(2026-09-30 ユーザーの知見)。
   * 版面の外に絵を置ける大きさ(全面・余白すこし・余白おおめ)の絵だけ、絵の中の文字の場所を調べ(textcheck/detect.ts。
   * この PC の中で動く。絵は外へ送らない)、ページに置いたときに版面の外に出るものを集める。
   *
   * - 紙の本を作るときだけ(電子書籍に版面は無い)。対象の絵が無ければ、調べる道具そのものを読み込まない
   * - 左右のページでノドと小口が入れ替わるので、絵が何ページ目に出たか(layoutInfo)で見る。
   *   組み直しの途中(paperPagesNow が null)は、**前に組み上がったときのページ**で見る(textPageMemo)。
   *   知らせを、関係のない編集のたびに点けたり消したりしない。いちども組み上がっていないあいだは、
   *   左右どちらに出ても外になる絵だけ言う(findTextOutside)
   * - 調べ終わっていない絵・調べられなかった絵は、外に出ているとは言わない(嘘のエラーを出さない)。
   *   そのかわり「確かめています」「確かめられませんでした」と言う(黙っていると「問題なし」と見分けられない)
   */
  const textCheckTargets = useMemo(
    () => (paperOn ? textTargets(manuscript, settings, imageKey) : []),
    // 絵と大きさだけを見る(settings の他の項目で作り直さない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paperOn, manuscript.chapters, settings.plates],
  );
  const textCheckSrcs = useMemo(() => [...new Set(textCheckTargets.map((t) => t.src))], [textCheckTargets]);
  const { found: detectedText, retry: retryDetect } = useDetectedText(textCheckSrcs);
  /** 絵 → 最後に組み上がったときのページ(1始まり)。組み直しの途中は、これで左右を決める */
  const textPageMemo = useRef(new Map<string, number>());
  const textPagesFresh = paperPagesNow !== null;
  const textFindings = useMemo<TextFinding[]>(
    () =>
      // 見開きのノド側(折り目の側)の見方は、いま効いている綴じ方で変わる(中綴じは折り目から 5mm だけ。textcheck/geometry.ts)
      findTextOutside(textCheckTargets, detectedText, layout, settings.writingMode, saddleOn ? 'saddle' : 'perfect', (t) => {
        const row = textRowKey(t);
        if (textPagesFresh) {
          const now = t.kind === 'plate' ? layoutInfo.platePages.get(t.key) : layoutInfo.imgPages.get(t.key);
          if (now !== undefined) textPageMemo.current.set(row, now);
          else textPageMemo.current.delete(row);
          return now;
        }
        return textPageMemo.current.get(row);
      }),
    [textCheckTargets, detectedText, layout, settings.writingMode, saddleOn, textPagesFresh, layoutInfo],
  );
  /**
   * 左の欄の、絵の行ごとに出すこと(外に出ている・確かめている最中・確かめられなかった)。問題の無い絵は入れない。
   * 同じ絵を2か所に置いていても、行ごとに出す(判定は置き方とページで変わる)
   */
  const textRows = useMemo(() => {
    const rows = new Map<string, TextRowState>();
    const byRow = new Map(textFindings.map((f) => [textRowKey(f.target), f]));
    for (const t of textCheckTargets) {
      const row = textRowKey(t);
      const f = byRow.get(row);
      if (f) rows.set(row, { state: 'outside', finding: f });
      else if (!detectedText.has(t.src)) rows.set(row, { state: 'checking' });
      else if (detectedText.get(t.src) === null) rows.set(row, { state: 'failed', retry: () => retryDetect(t.src) });
    }
    return rows;
  }, [textCheckTargets, textFindings, detectedText, retryDetect]);
  /** 確かめられなかった絵の枚数(書き出しの「直すところ」で言う) */
  const textUnchecked = useMemo(() => [...textRows.values()].filter((r) => r.state === 'failed').length, [textRows]);
  const textChecking = useMemo(() => [...textRows.values()].filter((r) => r.state === 'checking').length, [textRows]);
  const previewCss = useMemo(
    () =>
      // 「印刷所の決まり」の欄に触っているあいだは、色の帯を優先する。はみ出した文字の色も同じ ::after に描くので、
      // 両方出すと、絵のあるページで帯が消えたり位置がずれたりする(2026-10-02 見直しで指摘)
      step === 'shape' && !showEbook && paperPagesNow !== null && printFocus
        ? paintCss + printGuideCss(printFocus, layout, gutterFloorMm(paperPagesNow, settings))
        : // はみ出した文字の場所に色を重ねる。**いまの本の姿で組み上がっているときだけ**(古い紙面に重ねない)
          paintCss + (showEbook || paperPagesNow === null ? '' : textMarksCss(textFindings)),
    [paintCss, step, showEbook, paperPagesNow, printFocus, layout, settings, textFindings],
  );

  async function handleFile(file: File) {
    // **取込も「本を入れ替える」入口。** 原稿を読むと本文が丸ごと置き換わり、
    // undo 履歴も畳まれる(store の setManuscript)。誤って古い版の .docx を選んでも
    // 元に戻せないので、作業中の本があるときは確かめる(2026-09-04 レビュー指摘)。
    // 開いたばかりで未編集なら hasWorkToLose が false なので窓は出ない
    if (!confirmReplaceManuscript()) return;
    setImportError('');
    setNotice('');
    try {
      // 元ファイルも保持しておく(取込処理を直したとき組み直せるように)
      const src = await readSource(file);
      const { manuscript: ms, skippedColumnPages, notes = [] } = await parseSource(src);
      /**
       * **サンプルを開いたまま自分の原稿を取り込んだら、新しい本として始める。**(2026-09-25 見直し S2-9)
       * ［新規作成］の道は先にまっさらにしてから取り込むが、［AI に手直ししてもらう］などから取り込むと
       * サンプルの書名・著者名・版元・コラムページ・挿絵・背景・あらすじが自分の本に残っていた。
       * サンプルに手を入れていれば、上の confirmReplaceManuscript で断りを出してある
       */
      // 店の今の値で見る(画面の isSample は1つ前の描画のもの。［新規作成］の道では startNewBook の直後で、
      // 古い true のまま見ると、①で入れた書名をもう一度まっさらにしてしまう)
      if (useProject.getState().isSample) useProject.getState().startNewBook();
      const cur = useProject.getState().manuscript;
      const fit = setManuscript(
        {
          ...ms,
          title: cur.title || src.name,
          author: cur.author,
          publisher: cur.publisher,
        },
        src,
      );
      /**
       * **動かしたもの・入れなかったものは、その場で言う。**(2026-08-21)
       *
       * 差し込みページは「何章の前か」でしか位置を持てないので、章の数が変われば
       * どこかへ動く。前は何も言わずに動く(あるいは範囲の外へ出て消える)ので、
       * 「コラムだけはなくなっていた」というユーザー報告になった
       */
      const said: string[] = [...notes];
      if (skippedColumnPages.length) {
        said.push(
          `Word の中の［コラム］${skippedColumnPages.length}件は、章として取り込みませんでした` +
            `（コラムページはスタジオ側が持っています。Word で書き直したぶんは反映されません）`,
        );
      }
      if (fit.plates || fit.columnPages) {
        const moved = [
          fit.plates ? `挿絵ページ ${fit.plates}枚` : '',
          fit.columnPages ? `コラムページ ${fit.columnPages}枚` : '',
        ]
          .filter(Boolean)
          .join('と');
        said.push(`章が減ったので、行き場のなくなった${moved}を巻末へ移しました`);
      }
      if (fit.chapterSettings) {
        said.push(
          `なくなった章についていた見た目の指定 ${fit.chapterSettings}件は、効かなくなりました`,
        );
      }
      said.push(...carriedImagesNotes(fit));
      setNotice(said.join(' '));
    } catch (e) {
      setImportError(`取り込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleReparse() {
    setImportError('');
    try {
      const fit = await reparse();
      setNotice(
        ['取り込んだ原稿を、現在の取込処理で組み直しました。', ...(fit ? carriedImagesNotes(fit) : [])].join(' '),
      );
    } catch (e) {
      setImportError(`組み直しに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleExportEpub() {
    setImportError('');
    setExporting(true);
    try {
      // 表紙を EPUB の中に入れる。KDP は入稿画面で別に受け取るので無くても通るが、
      // 楽天Kobo など EPUB を配本するストアは中に入っていることを求める。
      // **「表紙まで同梱」を選んでいるのに表紙が描けなかったら、黙って表紙なしを作らない。**
      // KDP向け(kdp)は表紙別受け取りなので、描けなくても本文だけ書き出す(2026-09-04 レビュー指摘)
      let cover: string | undefined;
      try {
        cover = await coverRef.current?.ebookCoverDataUri();
      } catch (e) {
        if (settings.epubTarget === 'reader') {
          throw new Error(
            '表紙を作れなかったので中止しました（「表紙まで同梱」を選んでいます）。' +
              `［表紙をつくる］で表紙を確かめてください: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        cover = undefined; // KDP向けは表紙なしで続行(入稿画面で別に渡すため)
      }
      const { blob, dropped } = await exportEpub(manuscript, settings, cover);
      downloadBlob(blob, `${safeFileStem(manuscript.title, 'book')}.epub`);
      // 読めない画像(壊れている・画像でない中身)は EPUB に入れていない。黙って落とさず言う
      if (dropped) {
        setNotice(
          `読めない画像 ${dropped}枚は、EPUB に入れませんでした（壊れているか、画像ではないファイルです）。` +
            '［挿絵］や背景の一覧で、その画像を選び直してください',
        );
      }
    } catch (e) {
      setImportError(`EPUB出力に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  /** 印刷の画面を開いて紙の本文を保存してもらう。**うまくいったら true**(止めたとき・失敗は false。PaperBodyExport が①の「済み」に使う) */
  async function handlePrintPdf(): Promise<boolean> {
    setImportError('');
    // 中綴じで、ページ数がそろっていないときは書き出さない(画面のボタンも押せなくしているが、ここでも止める)
    if (printBlockReason) {
      setNotice(printBlockReason);
      return false;
    }
    setPrinting(true);
    // 印刷ダイアログ側の設定はこちらから触れないので、開く前に伝えておく。
    // 「余白: なし」「背景のグラフィック: オン」を選ばせるのはやめた(2026-09-14 ユーザー実測:
    // 余白なしはかえって崩れ、背景はオン/オフで変わらない。経緯は ExportStep の hint のコメント)
    // 「送信先: PDFに保存」の案内は、［紙の本文］の画面(PaperBodyExport)の中に常に出している。
    // 上の帯(notice)に出すと、ほかの工程へ移ったあとも残るので出さない(2026-10-03)
    setNotice('');
    try {
      // **書き出す瞬間に、完全な設定(塗り込み)で組版HTMLを作る。**(2026-08-22)
      // プレビュー用のHTMLは塗りを既定値に固定してある(paintNeutral)ので流用できない。
      // ここで作れば、押した時点の背景・色・フチが必ず刷りに乗る
      // ファイル名は表紙(「書名_表紙.pdf」)とそろえて「書名_本文.pdf」
      // 中綴じの共紙は、表紙の表1・表4 を本文の先頭と末尾のページに入れる(本文の用紙と同じ大きさで切り出す)
      let faces: { front: string; back: string } | undefined;
      if (selfCover) {
        faces = await coverRef.current?.renderFaces({ w: layout.paperW, h: layout.paperH });
        if (!faces) throw new Error('共紙の表紙の画像を作れませんでした。［表紙をつくる］で表紙を確かめてから、もう一度押してください');
      }
      await printToPdf(
        manuscriptHtml(
          manuscript,
          settings,
          fontFaceCss,
          saddleOn ? { padPages: saddlePadCount, ...(faces ? { coverFaces: faces } : {}) } : {},
        ),
        `${safeFileStem(manuscript.title, '本')}_本文`,
        // 章・コラムだけの帯(ページの箱ごと差し替える。下見の paint.ts と同じ規則)
        platePageRules(settings, '[data-vivliostyle-page-container]', '[data-vivliostyle-page-area-container]'),
      );
      return true;
    } catch (e) {
      setNotice('');
      setImportError(`紙PDFの出力に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setPrinting(false);
    }
  }

  const totalChars = useMemo(
    () =>
      manuscript.chapters.reduce(
        (sum, ch) =>
        sum +
          ch.blocks.reduce((s, b) => {
            // 引用と箇条書きも本文の字数のうち(ページ数の見積もりに効く)
            if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') return s + b.text.length;
            if (b.type === 'list') return s + b.items.reduce((n, x) => n + x.length, 0);
            return s;
          }, 0),
        0,
      ) +
      // コラムページも刷られる文字なので数える(1枚で1ページを起こす)
      (settings.columnPages ?? []).reduce((n, c) => n + c.title.length + c.text.length, 0),
    [manuscript, settings.columnPages],
  );

  // 「画像を入れたのに出ない」を画面で切り分けられるようにする。
  // 0枚なら取込が拾えていない、形式が合わなければブラウザが描けない
  const imgStats = useMemo(() => {
    let total = 0;
    const badFormats = new Set<string>();
    // 画面・紙PDFには出るが EPUB に入れられない形式(BMP・AVIF)。
    // epub.ts は入れられない絵を黙って落とすので、書き出し前に気づけるように数える
    // (2026-09-04 レビュー指摘。EPUB のコアメディアタイプは png/jpeg/gif/svg と webp)
    const epubDropFormats = new Set<string>();
    // WebP・BMP・AVIF は書き出すときに JPEG / PNG へ直すので、EPUB にも入る(2026-09-26)
    const EPUB_SAFE = /^image\/(png|jpe?g|gif|svg\+xml|webp|bmp|avif)$/i;
    for (const ch of manuscript.chapters) {
      for (const b of ch.blocks) {
        if (b.type !== 'image') continue;
        // 絵の無い画像ブロック(AI 用の JSON で戻せなかったもの)は、取り込めた枚数にも
        // 「刷れない形式」にも数えない。後者に入れると「不明 形式」と誤った説明が出る。
        // 戻せなかったことは読み込み時の警告で伝えている
        if (!b.src) continue;
        total++;
        if (!isRenderableImage(b.src)) {
          badFormats.add(imageFormatLabel(b.src) || '不明');
          continue;
        }
        const mime = /^data:([^;,]+)/.exec(b.src)?.[1] ?? '';
        if (mime && !EPUB_SAFE.test(mime)) epubDropFormats.add(imageFormatLabel(b.src) || mime);
      }
    }
    return {
      total,
      bad: badFormats.size ? [...badFormats].join('・') : '',
      epubDrop: epubDropFormats.size ? [...epubDropFormats].join('・') : '',
    };
  }, [manuscript]);

  // 章が1つも取れていない状態。.txt は「第一章」型の行しか章にしないので、
  // 「2章」のような書き方だと黙って1本の長い原稿になる。それを画面で気づけるようにする
  const noChapters =
    totalChars > 0 && manuscript.chapters.length === 1 && !manuscript.chapters[0].title;

  const pageCapacity = layout.charsPerLine * layout.linesPerPage;
  const estPages = Math.max(8, Math.ceil((totalChars / Math.max(1, pageCapacity)) * 1.15) + 4);

  /**
   * **絵の細かさ(ppi)が、出し先の目安に届いているか。知らせるだけで、止めない。**(2026-10-03 ユーザー判断
   * 「知らせるだけでいい。ぼけるといっても絵柄によってだいぶ差が出るはずなので、あとはユーザーの決定次第」)
   * 紙の本のときだけ。挿絵・章の途中の絵・表紙の絵を、組版が実際に置く実寸で数える(models/imageResolution.ts)。
   * 画素数は絵の頭から読む(描かない)。測れない形式の絵だけ、<img> に読ませて測る
   */
  const resSrcs = useMemo(() => {
    if (!paperOn) return [] as string[];
    const out: string[] = [];
    for (const p of settings.plates ?? []) if (!p.blank && p.src) out.push(p.src);
    for (const ch of manuscript.chapters) for (const b of ch.blocks) if (typeof b === 'object' && b !== null && b.type === 'image' && b.src) out.push(b.src);
    for (const v of [cover.wrap, cover.background, cover.backCover]) if (v?.kind === 'image' && v.src) out.push(v.src);
    return out;
  }, [paperOn, settings.plates, manuscript.chapters, cover.wrap, cover.background, cover.backCover]);
  const resSizes = useImageSizes(resSrcs);
  /**
   * **絵の色の一覧(色の欄の ▾ から開く。2026-10-03)。** スポイトは表紙のマスクで色が取れないので、絵から数えた色を並べる。
   * 表紙の画面は表紙の絵の色だけ(CoverEditor が数えて返す)。**本文の画面は「この本の絵」の色**:
   * 表紙の絵 → 本文の背景(紙の地・大扉・目次・奥付・章ごと) → 挿絵 → 章の途中の絵 の順に、絵ごとの1位・2位…と交互に
   * 8色まで混ぜる。数えるのは idle のとき・縮めた絵で・絵ごとに1度だけ(images/palette.ts)
   */
  const [coverPalette, setCoverPalette] = useState<string[]>([]);
  const bookArtSrcs = useMemo(() => {
    const out: string[] = [];
    const add = (v: string | undefined) => v && out.push(v);
    add(settings.bodyBg);
    for (const b of [settings.titleBg, settings.tocBg, settings.colophonBg]) add(b?.src);
    for (const b of Object.values(settings.chapterBg ?? {})) add(b?.src);
    for (const p of settings.plates ?? []) if (!p.blank) add(p.src);
    for (const ch of manuscript.chapters) for (const b of ch.blocks) if (typeof b === 'object' && b !== null && b.type === 'image') add(b.src);
    return out.slice(0, 12);
  }, [settings.bodyBg, settings.titleBg, settings.tocBg, settings.colophonBg, settings.chapterBg, settings.plates, manuscript.chapters]);
  const bookPalette = useArtPalette(bookArtSrcs, 8, coverPalette);
  const resCoverLayout = useMemo(
    () =>
      computeCoverLayout(settings.trim, pageCount || estPages, papersFor(settings.ink).includes(cover.paper) ? cover.paper : papersFor(settings.ink)[0], settings.writingMode === 'vertical', {
        target: settings.printTarget,
        spineInsetMm: settings.spineInsetMm,
        spineMm: cover.spineMmFromPrinter,
        bleedMm: printRulesOf(settings)?.bleedMm ?? COVER_BLEED_MM,
        binding: saddleOn ? 'saddle' : 'perfect',
        papers: { body: cover.printerBodyPaper, cover: cover.printerCoverPaper },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.trim, pageCount, estPages, settings.ink, cover.paper, settings.writingMode, settings.printTarget, settings.spineInsetMm, cover.spineMmFromPrinter, settings.printRules, saddleOn, cover.printerBodyPaper, cover.printerCoverPaper],
  );
  const resEntries = useMemo(
    () =>
      paperOn
        ? collectResolution({
            plates: settings.plates ?? [],
            chapters: manuscript.chapters,
            layout,
            cover: { settings: cover, layout: resCoverLayout },
            sizes: resSizes,
            base: basePpiOf(settings.printTarget),
          })
        : [],
    [paperOn, settings.plates, manuscript.chapters, layout, cover, resCoverLayout, resSizes, settings.printTarget],
  );
  /** 左の欄の、絵の行ごとに出す細かさ(鍵は textRows と同じ plate:id / img:鍵) */
  const resRows = useMemo(() => new Map(resEntries.map((e) => [e.key, e.verdict])), [resEntries]);
  /**
   * 手持ちの絵の細かさを、チャットの AI に確かめてもらう頼み方(［AI に手直ししてもらう］の［画像を入れる・差し替える］)。
   * **要る画素数はスタジオが出す**(画面下の読み値の「画像 全面・本文内」と同じ計算。表紙はいまのページ数の背幅で)。
   * 取り込みの上限を超える大きさは、読み値と同じく上限に合わせて言う(用意しても縮められる)。紙の本だけ
   */
  const imageCheck = useMemo(() => {
    if (!paperOn) return undefined;
    const ppi = basePpiOf(settings.printTarget);
    const px = (mm: { w: number; h: number }, max: number) =>
      fitWithin({ w: mmToPx(mm.w, ppi), h: mmToPx(mm.h, ppi) }, max);
    const area = printAreaMm(layout);
    return imageCheckPrompt({
      targetLabel: PRINT_TARGETS[settings.printTarget].label,
      ppi,
      trimLabel: `${(TRIM_SIZES[settings.trim] ?? TRIM_SIZES.bunko).label}mm`,
      sizes: [
        { label: '本文のページ全面（塗り足し込み）', px: fitWithin(fullPagePx(layout, ppi), PRINT_MAX_SIDE) },
        { label: '本文の中（版面いっぱい）', px: { w: mmToPx(area.w, ppi), h: mmToPx(area.h, ppi) } },
        { label: '見開き（2ページ・塗り足し込み）', px: px(plateAreaMm(layout, 'spread'), WRAP_MAX_SIDE) },
        { label: '表紙のおもて（表1・塗り足し込み）', px: px(coverPartAreaMm(resCoverLayout, 'front'), PRINT_MAX_SIDE) },
        { label: '表紙まるごと1枚（表4・背・表1・塗り足し込み）', px: px(coverPartAreaMm(resCoverLayout, 'wrap'), WRAP_MAX_SIDE) },
      ],
    });
  }, [paperOn, settings.printTarget, settings.trim, layout, resCoverLayout]);
  /**
   * 見開きの絵の行に出す、絵の画素数から言えること(縦横比が違うと中央だけが使われる・取り込みの上限で縮んでいる)。
   * 鍵は挿絵の id。見開きの絵だけ・紙の本のときだけ(typeset/spread.ts の spreadImageNotes)
   */
  const spreadNotes = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!paperOn) return m;
    const g = spreadGeometry(layout, settings.writingMode);
    for (const p of settings.plates ?? []) {
      if (p.blank || !p.src || p.size !== 'spread') continue;
      const notes = spreadImageNotes(resSizes.get(p.src), g, PRINT_MAX_SIDE, resRows.has(`plate:${p.id}`));
      if (notes.length) m.set(p.id, notes);
    }
    return m;
  }, [paperOn, layout, settings.writingMode, settings.plates, resSizes, resRows]);

  // レールのしるし。「決まっている / 確かめてほしい / まだ触っていない」の3段階だけ持つ。
  // 判型や書体は既定値があるので、触らなくても done でよい(空欄と同じ扱いにしない)
  const states = useMemo<Record<StepId, StepState>>(() => {
    const s: Record<StepId, StepState> = {
      // 判型も刷り色も既定値があるので、触らなくても「決まっている」でよい
      shape: 'done',
      art: imgStats.bad
        ? 'attention'
        : (settings.plates ?? []).length > 0 ||
            settings.bodyBg ||
            hasOwnBg(settings.titleBg) ||
            imgStats.total > 0
          ? 'done'
          : 'todo',
      colophon: manuscript.author.trim() ? 'done' : 'attention',
      // 飛ばしてよい工程なので、触っていなくても「確かめて」にはしない
      ai: 'done',
      /**
       * **絵を選んだかどうかでは測らない。**
       * 単色の表紙もれっきとした表紙で、既定値のままでも刷れるものが出来ている。
       * 「絵が入っていない＝まだ触っていない」と見なしていたので、
       * デザイン済みの表紙でもしるしが灰色のままだった(2026-08-19 ユーザー指摘)。
       * 他のステップと同じ扱い(既定値があるので触らなくても done)に揃え、
       * 表紙に出す文字が無いときだけ確かめてもらう
       */
      cover: manuscript.title.trim() ? 'done' : 'attention',
      export: 'todo',
    };
    // 書き出しは他のステップの総まとめ。どこかに要確認があればそれを映す。
    // **原稿の状態もここで拾う。** レールから 01 が消えたので、章が取れていないことを
    // 映すステップが他に無い(直しに行く先は下の problems が持っている)
    const others = STEPS.filter((x) => x.id !== 'export').map((x) => s[x.id]);
    s.export =
      others.includes('attention') || noChapters || totalChars === 0 ? 'attention' : 'done';
    return s;
  }, [noChapters, totalChars, imgStats, settings, manuscript.author, manuscript.title]);

  // 書き出しステップの確認用。ref 越しなので、参照が毎回変わらないよう固定しておく
  // (ExportStep の useEffect が毎描画で走ってしまう)
  const renderCoverPreviews = useCallback(
    () => coverRef.current?.renderPreviews() ?? Promise.reject(new Error('表紙がまだ準備できていません')),
    [],
  );
  /** あらすじの溢れ。表紙の見本を描いて初めて分かる */
  const [blurbOverflow, setBlurbOverflow] = useState(0);
  /** 背の文字の溢れ。こちらも描いて初めて分かる */
  const [spineOverflow, setSpineOverflow] = useState(0);
  /**
   * 表紙の見本。**07 を開いているあいだだけ描く。**
   *
   * 以前は ExportStep が自分で描いてサイドバーに小さく出していたが、
   * 右の大きなプレビューには本文が映ったままで、
   * 「紙の表紙の画面なのにプレビューは本文」になっていた(2026-08-19 ユーザー指摘)。
   * 同じ絵を両方で使うので、描画は App に1つだけ持つ
   */
  const [coverShots, setCoverShots] = useState<{ paper: string; ebook: string } | null>(null);
  // 見本づくりが失敗したか。失敗を握りつぶすと「見本を作っています…」が永遠に残る
  // (2026-09-04 レビュー指摘)。失敗したら ExportStep 側で案内に切り替える
  const [coverShotsFailed, setCoverShotsFailed] = useState(false);
  useEffect(() => {
    if (step !== 'export') return;
    let alive = true;
    setCoverShotsFailed(false);
    void renderCoverPreviews()
      .then((v) => {
        if (!alive) return;
        setCoverShots({ paper: v.paper, ebook: v.ebook });
        setBlurbOverflow(v.blurbOverflow);
        setSpineOverflow(v.spineOverflow);
      })
      .catch(() => {
        if (!alive) return;
        setCoverShots(null);
        setCoverShotsFailed(true);
      });
    return () => {
      alive = false;
    };
    // **書き出しの画面の中で出し先や刷り色を変えたら、見本と溢れも描き直す。**(2026-09-25 見直し S2-1)
    // 前は工程を移ったときしか描き直さず、［変える］で KDP にしても見本は「その他の印刷所」のまま、
    // あらすじの溢れ(直すところ)も出なかった。KDP の PDF ではバーコード欄のぶん約63字が欠けていた
  }, [
    step,
    renderCoverPreviews,
    settings.printTarget,
    settings.printRules,
    settings.ink,
    settings.trim,
    settings.writingMode,
    settings.spineInsetMm,
    cover,
    pageCount,
  ]);
  /**
   * いまの設定への参照。**コールバックを作り直さないために持つ。**
   * プレビューは html と見せ方でしか作り直さないので、
   * 設定を閉じ込めた関数を渡すと古い値のまま書き戻してしまう
   */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /**
   * サムネイルの上で差し込みページを動かす・消す・複製する。
   *
   * **位置は「何章の前に挟むか」でしか持てない。** 章の切れ目にしか置けないのは
   * 挿絵もコラムも同じで、サムネイル側が章の起こしと奥付の直前だけを
   * 落とし場所として出している(preview/PageThumbs.ts)
   */
  const moveInsert = useCallback(
    (kind: 'plate' | 'colpage', id: string, beforeChapter: number, at: number) => {
      /**
       * その切れ目にいる差し込みページを1つの列にして、動かしたものを at 番目へ入れ直す。
       * `at` は**動かすものを抜いたあとの列で何枚目か**(ページ一覧側でそろえて渡してくる)。
       *
       * **挿絵とコラムは別の配列に入っているが、紙の上では1つの列。**
       * 並び順は order という共通の物差しで持つ(models/project.ts)。
       * 動かすたびに、その切れ目にいる全員へ 0,1,2… を振り直す —
       * 隙間を空けて振ると、何度も動かすうちに数が詰まって順番が壊れる
       */
      const plates = settingsRef.current.plates ?? [];
      const cols = settingsRef.current.columnPages ?? [];
      const LAST = Number.MAX_SAFE_INTEGER;
      type Item = { kind: 'plate' | 'colpage'; id: string; order: number; rank: number };
      const group: Item[] = [];
      plates.forEach((p, i) => {
        if (p.beforeChapter !== beforeChapter) return;
        group.push({ kind: 'plate', id: p.id, order: p.order ?? LAST, rank: i });
      });
      cols.forEach((c, i) => {
        if (c.beforeChapter !== beforeChapter) return;
        // 同点なら挿絵が先。組版(typeset/html.ts)と同じ並べ方にそろえる
        group.push({ kind: 'colpage', id: c.id, order: c.order ?? LAST, rank: 1e6 + i });
      });
      group.sort((x, y) => x.order - y.order || x.rank - y.rank);

      const rest = group.filter((x) => !(x.kind === kind && x.id === id));
      const cut = Math.max(0, Math.min(at, rest.length));
      rest.splice(cut, 0, { kind, id, order: 0, rank: 0 });
      const orderOf = new Map(rest.map((x, i) => [`${x.kind}:${x.id}`, i]));

      const patch: { plates: typeof plates; columnPages: typeof cols } = {
        plates,
        columnPages: cols,
      };
      patch.plates = plates.map((p) => {
        const o = orderOf.get(`plate:${p.id}`);
        if (o === undefined) return p;
        return { ...p, beforeChapter, order: o };
      });
      patch.columnPages = cols.map((c) => {
        const o = orderOf.get(`colpage:${c.id}`);
        if (o === undefined) return c;
        return { ...c, beforeChapter, order: o };
      });
      setSettings(patch);
      // **動かした先へ連れて行く。**(2026-08-20 ユーザー指摘
      // 「サムネイルがドラッグした場所ではなく、ちょっと前のページで組みあがる」)
      // 組み直しは非同期なので、組み上がってから id でページを引いて飛ばす
      setJustAdded({ kind, id });
    },
    [setSettings],
  );

  const deleteInsert = useCallback(
    (kind: 'plate' | 'colpage', id: string) => {
      if (kind === 'plate') {
        setSettings({ plates: (settingsRef.current.plates ?? []).filter((p) => p.id !== id) });
      } else {
        setSettings({
          columnPages: (settingsRef.current.columnPages ?? []).filter((c) => c.id !== id),
        });
      }
    },
    [setSettings],
  );
  /**
   * 章の切れ目に新しいページを足す。**サムネイルの「＋」から呼ばれる。**
   *
   * 左の欄から足すと必ず本の最後に付いていたので、
   * 見ているページから遠く離れた場所に増えて探し回ることになっていた
   * (2026-08-19 ユーザー指摘)。押した切れ目にそのまま足す。
   *
   * 挿絵ページだけは**絵を選ばないと成り立たない**ので、
   * ここでは空の枠を作らず、左の欄で選んでもらう案内を出す
   */
  const [artFocus, setArtFocus] = useState<{
    pane: 'plates' | 'colpages' | 'blanks';
    seq: number;
    /** 挿絵の一覧で目立たせる行(「直すところ」の細かさの知らせから来たとき。ArtStep の focusPane.spot) */
    spot?: readonly string[];
  } | null>(
    null,
  );
  /**
   * ページ一覧の「＋」から預かった、次の1枚を入れる場所。
   * **挿絵は絵を選ばないと成り立たない**ので、押した場所をここで預かって、
   * 絵が決まったところで PlateEditor がそこへ挟む(2026-08-19 ユーザー指摘)
   */
  const [plateAt, setPlateAt] = useState<number | null>(null);
  /**
   * 足したばかりのページ。**組み上がったら、そこへ飛んで光らせる。**
   * 左の欄とページ一覧は画面の反対側にあるので、
   * 足しても「何も増えないじゃん」に見えていた(2026-08-19 ユーザー指摘)
   */
  /**
   * そのページへ連れて行く(組み上がりを待って)。足したときだけでなく、
   * **［挿絵］［コラム］の欄で場所・大きさ・絵を変えたときも**ここを通す(2026-09-23 ユーザー指摘
   * 「左の柱で章を指定したりページを指定しても、プレビューがその場所に移動してくれない」)。
   * 'img' は章の途中の絵で、id は imageKey(章, 並び)
   */
  /** 電子の下見で開いてほしいページ。奥付の工程を開いたら奥付へ(紙の下見と同じふるまい) */
  const [ebookFocus, setEbookFocus] = useState<{ file: string; seq: number; img?: number } | null>(
    null,
  );
  useEffect(() => {
    // **電子の下見を出しているときだけ。** 出していないときに立てると、あとで電子の下見を
    // 開いた瞬間にこの合図を拾い、本の最後(奥付)から始まった(2026-09-24 レビューで発見)
    if (step === 'colophon' && showEbook) {
      setEbookFocus({ file: 'colophon.xhtml', seq: Date.now() });
    }
  }, [step, showEbook]);

  const [justAdded, setJustAdded] = useState<{ kind: 'plate' | 'colpage' | 'img'; id: string } | null>(
    null,
  );

  /**
   * **本が変わったら、画面の状態も戻す。**(2026-08-20 ユーザー指摘
   * 「サンプルをつくると、それまでいじっていたサンプルと同じページから始まる」)
   *
   * 中身は入れ替わっているのに、開いているタブも見ているページも前のまま残っていた。
   * `bookId` は**別の本になったときだけ**変わる(サンプルを読み直す・新規作成・
   * 原稿を取り込む・保存ファイルを開く)ので、これを合図に戻す。
   * プレビューの見ているページ・倍率と、各タブの中の状態は、
   * それぞれの部品が自分で持っているので key で作り直させる
   */
  useEffect(() => {
    setStep('shape');
    setArtFocus(null);
    setExportTarget(null);
    setPlateAt(null);
    setJustAdded(null);
    setVisibleChapters([]);
    setVisibleColumns([]);
    setVisiblePages([]);
    // 帯の向き先の合図も本ごとのもの(前の本の章を次の本へ持ち越さない)
    setBarScopeRequest(undefined);
    // 電子の下見の合図と、書き出しへの戻り道も本ごとのもの(別の本へ持ち越さない)
    setEbookFocus(null);
    setPreviewReturn(null);
  }, [settings.bookId]);
  const addInsert = useCallback(
    (kind: 'plate' | 'colpage' | 'blank', beforeChapter: number) => {
      if (kind === 'blank') {
        const id = crypto.randomUUID();
        setSettings({
          plates: [
            ...(settingsRef.current.plates ?? []),
            { id, src: '', beforeChapter, size: 'full', blank: true },
          ],
        });
        setJustAdded({ kind: 'plate', id });
        setStep('art');
        setArtFocus({ pane: 'blanks', seq: Date.now() });
        return;
      }
      if (kind === 'colpage') {
        const id = crypto.randomUUID();
        setSettings({
          columnPages: [
            ...(settingsRef.current.columnPages ?? []),
            { id, title: '', text: '', beforeChapter },
          ],
        });
        setStep('art');
        setArtFocus({ pane: 'colpages', seq: Date.now() });
        setJustAdded({ kind: 'colpage', id });
        // **知らせるのは押した場所のそば。**(2026-08-19 ユーザー指摘
        // 「全体にかかる場所に置かれている意味が分からない」)
        previewRef.current?.notify('コラムページを足しました。左の欄で見出しと文章を書けます');
        return;
      }
      // 挿絵も**その場で足す**(コラム・クッションと同じ)。
      // 前は「押した場所を預かって、左の［挿絵ページを足す］を押させる」二段構えで、
      // 「押したのに追加されたページが見つからない」と迷わせた(2026-09-04 ユーザー報告)。
      // 絵の無い挿絵ページは組版が普通に1ページとして出す(html.ts「絵がまだ無いものは通す」)
      {
        const id = crypto.randomUUID();
        setSettings({
          plates: [
            ...(settingsRef.current.plates ?? []),
            { id, src: '', beforeChapter, size: 'full' },
          ],
        });
        setJustAdded({ kind: 'plate', id });
        setStep('art');
        setArtFocus({ pane: 'plates', seq: Date.now() });
        previewRef.current?.notify(
          '挿絵ページを足しました。左の一覧で［画像を選ぶ］か［プリセットから］画像を選んでください',
        );
      }
    },
    [setSettings],
  );
  const copyInsert = useCallback(
    (kind: 'plate' | 'colpage', id: string) => {
      const newId = crypto.randomUUID();
      setJustAdded({ kind, id: newId });
      if (kind === 'plate') {
        const list = settingsRef.current.plates ?? [];
        const i = list.findIndex((p) => p.id === id);
        if (i < 0) return;
        // **すぐ後ろに置く。** 同じ切れ目に2枚並ぶので、見開きの片方を埋めるのに使える
        const next = [...list];
        next.splice(i + 1, 0, { ...list[i], id: newId });
        setSettings({ plates: next });
      } else {
        const list = settingsRef.current.columnPages ?? [];
        const i = list.findIndex((c) => c.id === id);
        if (i < 0) return;
        const next = [...list];
        next.splice(i + 1, 0, { ...list[i], id: newId });
        setSettings({ columnPages: next });
      }
    },
    [setSettings],
  );

  /**
   * 足したページが組み上がったら、そこへ飛んで光らせる。
   * **組み直しは非同期**なので、足した直後には何ページ目になるか分からない。
   * 組み上がりの報せ(layoutInfo)を待って、id からページを引く
   */
  useEffect(() => {
    // 電子の下見を出しているときは、下の(電子の)効果が連れて行く
    if (!justAdded || showEbook) return;
    /**
     * **いまの本の姿から組んだ紙面が出るまで待つ。**(2026-09-23 レビューで発見)
     * 場所を変えたページは、変える前の紙面にも載っている。そこで引くと動かす前のページへ飛ぶ。
     * 「頼んだあとに来た最初の組み上がり」で決めると、変える前から組んでいた1冊が
     * 待ち時間(debounce)のあいだに組み上がったとき、それを掴んでしまう。
     * そこで、原稿と設定 → 組版HTML → 組み上がり の3段がすべていまの値にそろったときだけ引く。
     * 見た目が変わらない変更(絵の無い枠の大きさ など)は組み直しが起きないが、
     * そのときは3段が最初からそろっているので、すぐに今のページへ飛んで終わる
     * (待ちっぱなしにして、関係ない次の組み上がりで急に飛ぶことが無い)
     */
    const settled =
      heldManuscript === manuscript &&
      heldNeutral === neutralSettings &&
      debouncedHtml === previewHtml &&
      layoutHtml === debouncedHtml;
    if (!settled) return;
    const page =
      justAdded.kind === 'plate'
        ? layoutInfo.platePages.get(justAdded.id)
        : justAdded.kind === 'colpage'
          ? layoutInfo.colPagePages.get(justAdded.id)
          : layoutInfo.imgPages.get(justAdded.id);
    if (page) {
      previewRef.current?.goToPage(page);
      previewRef.current?.flashPage(page);
    }
    // いまの紙面に無ければ(消した・組まれない絵だった)、それで終わり
    setJustAdded(null);
  }, [
    justAdded,
    layoutInfo,
    layoutHtml,
    debouncedHtml,
    previewHtml,
    heldManuscript,
    manuscript,
    heldNeutral,
    neutralSettings,
    showEbook,
  ]);

  /**
   * **電子の下見を出しているときの「いじった1枚へ連れて行く」。**
   * 下見の中身(ebookBook)は手が止まってから作り直すので、原稿と設定がいまの値に追いつくのを待ち、
   * 追いついたら読む順から探して開く。挿絵とコラムは設定の id、章の途中の絵はその章。
   * 電子に入らないもの(絵の無い挿絵ページ・空のコラム)は見つからないので、そこで終わる
   */
  useEffect(() => {
    if (!justAdded || !showEbook) return;
    if (!ebookBook || heldManuscript !== manuscript || heldSettings !== settings) return;
    if (justAdded.kind === 'img') {
      // 章の途中の絵は、その章のファイルの何枚目の絵か(絵を選んでいない枠は EPUB に入らない)
      const [ch, bi] = justAdded.id.split(':').map(Number);
      const file = ebookBook.spine.find((d) => d.kind === 'chapter' && d.chapter === ch)?.file;
      const img = (heldManuscript.chapters[ch]?.blocks ?? [])
        .slice(0, bi)
        .filter((b) => b.type === 'image' && isEpubImage(b.src)).length;
      if (file) setEbookFocus({ file, seq: Date.now(), img });
    } else {
      const file = ebookBook.spine.find((d) => d.sourceId === justAdded.id)?.file;
      if (file) setEbookFocus({ file, seq: Date.now() });
    }
    setJustAdded(null);
  }, [justAdded, showEbook, ebookBook, heldManuscript, manuscript, heldSettings, settings]);

  /** いま表紙を書き出そうとしているか。プレビューを表紙の見本に差し替える */
  const coverShot =
    step === 'export' && exportTarget === 'paperCover'
      ? coverShots?.paper
      : step === 'export' && exportTarget === 'ebookCover'
        ? coverShots?.ebook
        : null;

  /**
   * **紙と電子の切り替え。両方を作る本だけ。**表紙の見本を出しているあいだは出さない。
   * **置き場所は下見の下の帯**(紙: ページ一覧・見開きと同じ帯の左端 / 電子: ページ数の行の左)。
   * (2026-09-25 ユーザー要望「紙の本と電子書籍のボタンが書籍のプレビューにかかっているのがもったいない。
   * ページ一覧や見開きが並んでいるところへ」)。もとは下見の上端の真ん中に浮かせていて、紙面に重なっていた
   */
  const previewModeSwitch =
    outs.paper && outs.ebook && !coverShot ? (
      <span className="preview-mode" role="group" aria-label="下見の種類">
        <button
          className={showEbook ? '' : 'on'}
          aria-pressed={!showEbook}
          onClick={() => setPreviewMode('paper')}
        >
          紙の本
        </button>
        <button
          className={showEbook ? 'on' : ''}
          aria-pressed={showEbook}
          onClick={() => setPreviewMode('ebook')}
        >
          電子書籍
        </button>
      </span>
    ) : null;

  // **EPUB の1ページ目に入る表紙は、もう下見の横には立てない。**(2026-08-21)
  // ［電子書籍の本文］が下見の無い全画面になったので、置く先が消えた。
  // 「このファイルに表紙も入る」ことは ExportStep の［EPUB の出し先］が言葉で言い、
  // 絵そのものは［電子書籍の表紙］で原寸で見てもらう(板に入れると入りきらない。実測)

  /**
   * わざと空けた白ページ(クッションページ)の枚数。
   * **EPUB には入らない**ので、書き出す前に断るために数える(理由は ExportStep)
   */
  const blankPlates = (settings.plates ?? []).filter((p) => p.blank).length;

  /**
   * 入稿前チェック。**新しい検査は書かない。**
   * どれも各ステップが既に持っている判定で、ここは散らばった警告を集めるだけ。
   * 引っかかっても書き出しは止めない(止めると「なぜ出せないのか」を探す旅が始まる)。
   *
   * 並ぶのは2種類だけ:
   * 1. **直すべきことがあるときの警告**(無いときは何も出さない)
   * 2. **KDP の入稿画面で利用者が選ぶ値**(判型・裁ち落とし)。ここだけは毎回出す
   *
   * 「章が10つに分かれています」のような、自分で入れた原稿の読み上げは置かない。
   * 本人がいちばん知っていることで、並べるほど直すべき行が埋もれる
   */
  // 著者紹介があふれる行数。判型・本文サイズ・奥付の行数で変わるので、そのつど数える
  const profileOverflow = useMemo(
    () =>
      authorProfileOverflowLines(
        authorProfileParagraphs(manuscript),
        manuscript.title ? colophonRows(manuscript).length : 0,
        layout,
      ),
    [manuscript, layout],
  );

  const problems = useMemo<Problem[]>(() => {
    // 横組みは行末の句読点がノドへ1字ぶら下がるので、そのぶんを足した幅で見る(grid.ts gutterNeedMm)
    const gutterMin = gutterNeedMm(pageCount || estPages, settings);
    const list: Problem[] = [];
    // 原稿の出し入れは工程ではなく入口画面が持つ(レールに 01 は無い)
    const toStart = {
      label: '→ 最初の画面',
      run: () => {
        setStartMode('new');
        setShowStart(true);
      },
    };

    if (totalChars === 0) {
      list.push({ text: '原稿がまだ入っていません', goto: toStart });
    } else if (noChapters) {
      list.push({ text: '章に分かれていません（目次と改ページが作れません）', goto: toStart });
    }
    if (!manuscript.author.trim()) {
      // 著者名を入れる欄は奥付にある(入口画面にもあるが、直すなら近いほうへ)
      list.push({
        text: '著者名が空です（奥付の ©️ が作れません）',
        goto: { label: '→ 奥付と著者紹介を入れる', run: () => setStep('colophon') },
      });
    }
    // ノドの下限はページ数で上がる。組版は `estimatedPages`(既定 120)で下限を決めているので、
    // 長い本では実際に必要な値に届かないことがある。ここは**組み上がった実ページ数**で見る
    // 表紙のあらすじ・背・ノド・1ページに収めるもの・背景だけのページは、紙の本だけの話。
    // 電子書籍だけの本では直す欄が出ていないので、入稿前チェックにも出さない(2026-09-24)
    const makesPaper = outputsOf(settings).paper;
    const makesEbook = outputsOf(settings).ebook;
    if (makesPaper && layout.margins.gutter < gutterMin) {
      list.push({
        text: `ノドが ${layout.margins.gutter.toFixed(2)}mm しかありません（${
          pageCount || estPages
        }ページなら ${gutterFloorLabel(settings)}は ${gutterFloorMm(pageCount || estPages, settings)}mm${
          settings.writingMode === 'horizontal'
            ? `。横組みは行末の句読点が1字ぶんノドへ出るので ${gutterMin.toFixed(2)}mm 要ります`
            : ''
        }）`,
        // 判型は［本のかたちを決める］工程にある(2026-08-19に帯から移動)。実際に飛ばす
        goto: { label: '→ 本のかたちを決める', run: () => setStep('shape') },
      });
    }
    // 中綴じ(2026-10-03)。KDP に切り替えたとき(無線で組んでいる)の知らせと、ページ数の上限・綴じる辺。
    // 入稿前チェックにも出す(画面の読み上げだけだと見落とす)。書き出しは止めない
    if (makesPaper) {
      const toShapeSaddle = { label: '→ 本のかたちを決める', run: () => setStep('shape') };
      const off = saddleOffNote(settings);
      if (off) list.push({ text: off, goto: toShapeSaddle });
      for (const f of saddleFindings(settings, paperPagesNow)) list.push({ text: f.text, goto: toShapeSaddle });
    }
    // ページ数の下限(KDP は24ページ)。組み上がった数だけで見る(見積もりでは言わない)
    const minPages = PRINT_TARGETS[settings.printTarget]?.minPages;
    if (makesPaper && minPages && pageCount > 0 && pageCount < minPages) {
      list.push({
        text:
          `${PRINT_TARGETS[settings.printTarget].label} のペーパーバックは ${minPages}ページからです` +
          `（いまは ${pageCount}ページ）。このままでは入稿できません。判型を小さくするか、文字を大きくするとページが増えます`,
        goto: { label: '→ 本のかたちを決める', run: () => setStep('shape') },
      });
    }
    // 背幅。KDP 以外では、印刷所から知らされた数字を入れてもらう(2026-09-27 ユーザー判断)。
    // 入っていなければ KDP の紙の厚みで出した目安のまま。入れたあとでページ数が変わったら確かめ直し
    if (makesPaper && !saddleOn && PRINT_TARGETS[settings.printTarget].asksPrinterSpine) {
      const toShape = { label: '→ 本のかたちを決める', run: () => setStep('shape') };
      if (!usesPrinterSpine(settings.printTarget, cover.spineMmFromPrinter)) {
        // 用紙の一覧を持つ会社は、選んだ用紙で出した目安。確定値がいつ届くかは会社の手順なので、会社の文で言う(papers.text)
        list.push({
          text: PRINT_TARGETS[settings.printTarget].papers
            ? PRINT_TARGETS[settings.printTarget].papers!.text.spineFinding
            : '表紙の背幅が、KDP の紙の厚みで出した目安のままです。印刷所から知らされた背幅を、［本のかたちを決める］の「印刷所の決まり」にある「背幅（印刷所の数字）」に入れてください',
          goto: toShape,
        });
      } else if (cover.spineMmPages !== undefined && pageCount > 0 && pageCount !== cover.spineMmPages) {
        list.push({
          text: `背幅を入れたときから、本文のページ数が変わっています（${cover.spineMmPages} → ${pageCount}ページ）。背幅も変わるので、印刷所に確かめて入れ直してください`,
          goto: toShape,
        });
      }
    }
    // 印刷所の決まり(塗り足し・ノドの下限)。出し先を印刷所にすると既定が入る(store の setSettings)が、
    // 古い保存の印刷所の本には入っていない。その本は**いまも KDP の決まりで組んでいる**ので、
    // 黙って組み替えず、入れてもらう(2026-10-01)
    if (makesPaper && usesOwnPrintRules(settings.printTarget) && !settings.printRules) {
      list.push({
        text: '印刷所の決まり（塗り足し・ノドの下限）がまだ入っていません。いまは KDP の決まりで組んでいます。［本のかたちを決める］の「印刷所の決まり」に、印刷所の入稿ガイドの数字を入れてください',
        goto: {
          label: '→ 印刷所の決まりを入れる',
          run: () => {
            // 見出しまで動かす(AI タブからの飛び先と同じ道。App の jumpToPrintRules)
            jumpToPrintRules.current = true;
            setStep('shape');
          },
        },
      });
    }
    // 出し先が受け付けない判型(unsupportedTrims)。黙って判型を変えず、選び直してもらう
    if (makesPaper && trimUnsupported(settings.printTarget, settings.trim)) {
      const t = TRIM_SIZES[settings.trim];
      list.push({
        text: `${t.label.replace(/\s+\d+×\d+$/, '')}は${PRINT_TARGETS[settings.printTarget].label}では使えません。判型を選び直してください`,
        goto: { label: '→ 本のかたちを決める', run: () => setStep('shape') },
      });
    }
    // 絵の中の文字が、版面の外に出ている(印刷の入稿で止められることがある)。直すのは［挿絵］の、その絵の行。
    // **紙の下見に戻してから行く**: 電子書籍の下見のままだと、行の知らせ(紙の話)が出ず、行き止まりになる
    const toPlates = {
      label: '→ 挿絵を開く',
      run: () => {
        setPreviewMode('paper');
        setStep('art');
        setArtFocus({ pane: 'plates', seq: Date.now() });
      },
    };
    // 見開きは2ページにまたがる(「10・11ページ」)
    const textPagesOf = (fs: TextFinding[]) =>
      fs
        .flatMap((f) => (f.page === null ? [] : f.target.place === 'spread' ? [[f.page, f.page + 1]] : [[f.page]]))
        .sort((a, b) => a[0] - b[0])
        .map((p) => `${p.join('・')}ページ`)
        .join('・');
    // **版面の外に出ている絵** と **折り目にかかっているだけの絵**(見開き。版面の中)は別の件にする。
    // 後者は「入稿で止められる」話ではない(綴じ・断裁のずれで読みにくくなる話。2026-10-03 レビュー)
    const outsideFindings = textFindings.filter((f) => !f.foldOnly);
    const foldFindings = textFindings.filter((f) => f.foldOnly);
    if (makesPaper && outsideFindings.length > 0) {
      // 見開きの絵は「版面いっぱい」にできないので、直し方を分けて言う
      const pageText = textPagesOf(outsideFindings);
      const withOver = outsideFindings.find((f) => overText(f.over));
      const alsoFold = outsideFindings.some((f) => (f.fold ?? 0) > 0);
      const onlySpread = outsideFindings.every((f) => f.target.place === 'spread');
      // 中綴じの見開きは、ノド側の余白を使わない(折り目から 5mm だけ離す)。無線綴じは版面の内側(折り目からも離して)
      const spreadFix = saddleOn
        ? `文字を、上・下・外側は版面の内側に、折り目からは ${SPREAD_FOLD_SAFE_MM}mm 以上離して置いた画像に差し替えてください`
        : '文字を版面の内側（折り目からも離して）に置いた画像に差し替えてください';
      const detail = [withOver ? overText(withOver.over) : '', alsoFold ? `見開きの折り目の左右 ${SPREAD_FOLD_SAFE_MM}mm にも文字がかかっています` : '']
        .filter(Boolean)
        .join('。');
      list.push({
        text:
          `画像の中の文字が、版面（本文の入る範囲）の外に出ています（${outsideFindings.length}枚` +
          `${pageText ? `。${pageText}` : ''}${detail ? `。${detail}` : ''}` +
          `${outsideFindings.length > 1 ? ' ほか' : ''}）。印刷の入稿で止められることがあります。` +
          (onlySpread
            ? `見開きの画像は、${spreadFix}`
            : outsideFindings.some((f) => f.target.place === 'spread')
              ? `見開きの画像以外は、画像の大きさを「版面いっぱい」にすると収まります。見開きの画像は、${spreadFix}`
              : '画像の大きさを「版面いっぱい」にすると収まります'),
        goto: toPlates,
      });
    }
    if (makesPaper && foldFindings.length > 0) {
      const pageText = textPagesOf(foldFindings);
      list.push({
        text:
          `見開きの画像の真ん中（折り目）の左右 ${SPREAD_FOLD_SAFE_MM}mm に文字がかかっています（${foldFindings.length}枚` +
          `${pageText ? `。${pageText}` : ''}）。綴じや断裁で ±1mm ほどずれて読みにくくなることがあります。` +
          '文字を折り目から離して置いた画像に差し替えてください',
        goto: toPlates,
      });
    }
    // 確かめられなかった絵・まだ確かめている絵。**黙っていると「問題なし」と見分けられない**(2026-10-02 見直しで指摘)。
    // 外に出ているとは言わない(分からないので)。文字が入っている絵なら、版面いっぱいにしておけば安心、とだけ言う
    if (makesPaper && textUnchecked > 0) {
      list.push({
        text:
          `画像の中の文字を確かめられなかった画像が ${textUnchecked} 枚あります（このブラウザでは開けない形式の画像など）。` +
          '文字の入った画像なら、大きさを「版面いっぱい」にしておくと安心です',
        goto: toPlates,
      });
    }
    if (makesPaper && textChecking > 0) {
      list.push({
        text: `画像の中の文字を、まだ確かめている画像が ${textChecking} 枚あります（少し待つと結果が出ます）`,
        goto: toPlates,
      });
    }
    // 絵の細かさが出し先の目安に届かない。**止めない**(絵柄によってぼけ方はだいぶ違う。決めるのは利用者)。
    // 挿絵と章の途中の絵は［挿絵］へ、表紙の絵は［表紙をつくる］へ飛ばす
    if (makesPaper && resEntries.length > 0) {
      const label = PRINT_TARGETS[settings.printTarget].label;
      const worstOf = (es: typeof resEntries) => es.reduce((a, b) => (b.verdict.ppi < a.verdict.ppi ? b : a)).verdict;
      const body = resEntries.filter((e) => e.group !== 'cover');
      const cov = resEntries.filter((e) => e.group === 'cover');
      if (body.length > 0) {
        // **どの画像の話かを、飛んだ先で示す。**(2026-10-09 ユーザー指摘「どの挿絵の話なのかがわからない」)
        // 鍵を渡すと、挿絵の一覧がその行を枠で囲み、上に一覧の札を出す(PlateEditor の spotlight)
        list.push({
          text: resolutionIssueText(body.length, worstOf(body), label, '挿絵と本文中の画像'),
          goto: {
            label: toPlates.label,
            run: () => {
              setPreviewMode('paper');
              setStep('art');
              setArtFocus({ pane: 'plates', seq: Date.now(), spot: body.map((e) => e.key) });
            },
          },
        });
      }
      if (cov.length > 0) {
        list.push({
          text: resolutionIssueText(cov.length, worstOf(cov), label, '表紙の画像'),
          goto: { label: '→ 表紙をつくる', run: () => setStep('cover') },
        });
      }
    }
    // Word は Excel・PowerPoint から貼った絵や図表を EMF / WMF で持つことがある。
    // <img> は出来るのにブラウザが描けないので、**黙って絵が消える**という壊れ方をする。
    // 枚数の検査ではなく、その形式が混ざっていないかを見ている
    if (imgStats.bad) {
      list.push({
        text: `章の途中の画像のうち ${imgStats.bad} 形式のものは刷れません（その画像だけ消えます）。［挿絵］の一覧で PNG か JPEG の画像を選び直してください`,
        goto: { label: '→ 本文に画像とコラムを入れる', run: () => setStep('art') },
      });
    }
    // BMP・AVIF は紙PDFには出るが EPUB に入れられず、電子書籍だけ絵が消える。
    // 紙だけ作る人には関係ないので警告どまりにする(2026-09-04 レビュー指摘)
    if (makesEbook && imgStats.epubDrop) {
      list.push({
        text: `${imgStats.epubDrop} 形式の画像は、電子書籍（EPUB）には入れられません（紙は出ますが、EPUB ではそのページの画像だけ消えます）。EPUB にも載せたいときは、［挿絵］の一覧で PNG か JPEG の画像を選び直してください`,
        goto: { label: '→ 本文に画像とコラムを入れる', run: () => setStep('art') },
      });
    }
    // 表紙のあらすじと背文字は紙の表紙(表4・背)にしか刷らない(2026-09-23 レビューで発見)
    if (makesPaper && blurbOverflow > 0) {
      list.push({
        text: `表紙のあらすじが約 ${blurbOverflow} 文字入りきっていません`,
        goto: { label: '→ 表紙をつくる', run: () => setStep('cover') },
      });
    }
    if (makesPaper && spineOverflow > 0) {
      list.push({
        text: `背の文字が約 ${spineOverflow} 文字入りきっていません（そのぶんは刷りません）`,
        goto: { label: '→ 表紙をつくる', run: () => setStep('cover') },
      });
    }
    /**
     * 中身の決まっていない差し込みページ。**書き出しは止めない。**
     * 途中で足して置きっぱなしにできる作りなので、あることは起こりうる。
     * ただし紙には**背景だけのページ**として出てしまうので、刷る前に一度は目に入れたい
     * (2026-08-20 ユーザー要望)
     */
    const emptyPlates = (settings.plates ?? []).filter((p) => !p.blank && !p.src).length;
    if (makesPaper && emptyPlates > 0) {
      list.push({
        text: `画像を選んでいない挿絵ページが ${emptyPlates} 枚あります（そのまま出すと背景だけのページになります）`,
        goto: { label: '→ 本文に画像とコラムを入れる', run: () => setStep('art') },
      });
    }
    const emptyCols = (settings.columnPages ?? []).filter(
      (c) => !c.title.trim() && !c.text.trim(),
    ).length;
    if (makesPaper && emptyCols > 0) {
      list.push({
        text: `中身が空のコラムページが ${emptyCols} 枚あります（そのまま出すと背景だけのページになります）`,
        goto: { label: '→ 本文に画像とコラムを入れる', run: () => setStep('art') },
      });
    }
    /**
     * 1ページに収まらないコラム。**あふれたぶんは余白へはみ出して刷られる。**
     * 編集欄でも赤く出しているが、そこを閉じたまま入稿する道があるので、ここでも見る
     */
    const overCols = (settings.columnPages ?? []).filter((c) => {
      if (!c.title.trim() && !c.text.trim()) return false;
      return fitColumnPage(
        layout,
        columnPageMode(c, settings.writingMode),
        c.title,
        columnPageParagraphs(c.text),
        { fontPt: c.fontPt, lineFeedPt: c.lineFeedPt, padXPct: c.padXPct, padYPct: c.padYPct },
      ).over;
    }).length;
    if (makesPaper && overCols > 0) {
      list.push({
        // はみ出した字は紙の外へ消えるのではなく、余白に刷られる(2026-09-25 見直し: 新書・横の本の縦組みのコラムで
        // ノドから 7.1mm。KDP の安全域 9.5mm を割る)。前の「刷られません」は事実と違った
        text: `1ページに収まらないコラムページが ${overCols} 枚あります（はみ出した字は余白にかかり、断裁で切れたり入稿で止められたりします）`,
        goto: { label: '→ 本文に画像とコラムを入れる', run: () => setStep('art') },
      });
    }
    // 著者紹介は奥付と1ページに収める決まり。あふれたぶんは黙って消えるので先に止める
    if (makesPaper && profileOverflow > 0) {
      list.push({
        text: `著者紹介が約 ${profileOverflow} 行ぶん入りきっていません（奥付と同じ1ページに収めます）`,
        goto: { label: '→ 奥付と著者紹介を入れる', run: () => setStep('colophon') },
      });
    }
    return list;
  }, [
    totalChars, noChapters, manuscript.author, layout, layout.margins.gutter,
    pageCount, estPages, imgStats, blurbOverflow, spineOverflow, profileOverflow,
    settings.plates, settings.columnPages, settings.writingMode, settings.makePaper,
    settings.makeEbook, settings.printTarget, settings.printRules, settings.fontPt, settings.trim,
    settings.binding, settings.saddleCover, saddleOn, paperPagesNow,
    cover.spineMmFromPrinter, cover.spineMmPages,
    textFindings, textUnchecked, textChecking, resEntries,
  ]);

  /**
   * KDP の入稿画面で選ぶ値。**ここに塗り足し込みの寸法を出してはいけない。**
   * トリムサイズ欄は仕上がり寸法を入れるところなので、塗り足し込みの数字を見せると
   * それを転記されてしまう(「全面 2,187×3,111px」を代替テキストに転記した事故と同じ構図)。
   */
  const specs = useMemo<Spec[]>(() => {
    const trim = TRIM_SIZES[settings.trim] ?? TRIM_SIZES.bunko;
    // 用紙が刷り色と食い違って保存されていることがあるので、表紙エディタと同じ規則で丸める
    const papers = papersFor(settings.ink);
    const paper = papers.includes(cover.paper) ? cover.paper : papers[0];
    /** 会社の用紙。一覧を持たない会社では null */
    const paperChoice = { body: cover.printerBodyPaper, cover: cover.printerCoverPaper };
    const ownPapers = printerPapersOf(settings.printTarget, paperChoice);
    /**
     * 控えに出す背幅。**表紙と同じ関数から出す**(models/cover.ts coverSpineMm)。
     * KDP 以外で印刷所の数字が入っていれば、それを「印刷所の数字」と添えて出す
     */
    const spineNote = (pages: number) => {
      // 中綴じは背が無い。かわりに、ページ数が 4 の倍数なこと(共紙は表紙の4ページを含む数)を添える
      if (saddleOn) return selfCover ? '中綴じ。表紙の4ページを含む数です（発注書の数え方は印刷所に確かめてください）' : '中綴じ。ページ数は 4 の倍数です';
      const fromPrinter = usesPrinterSpine(settings.printTarget, cover.spineMmFromPrinter);
      const mm = coverSpineMm(pages, paper, settings.printTarget, cover.spineMmFromPrinter, 'perfect', paperChoice);
      return `背幅 ${mm.toFixed(2)} mm${fromPrinter ? '（印刷所の数字）' : PRINT_TARGETS[settings.printTarget].asksPrinterSpine ? '（目安）' : ''}`;
    };
    // 同梱のプリセットは生成AIで作っている。KDP は出版フローで申告を求めており、
    // 未申告は規約違反になる。**利用者が自分で用意した画像のときは出さない**
    // (自分で入れたものの読み上げになるため)。
    //
    // **表紙以外は目印で判定する。** 表紙だけ CoverBackground が
    // `{ kind: 'preset' }` の形を保つが、背景と挿絵はプリセットを選んだ時点で
    // data URI になり、自前の画像と区別がつかなくなる。
    // ここを表紙だけで見ていたら「挿絵にプリセットを使ったのに申告の行が出ない」
    // という取りこぼしが実際に出た(2026-08-17)。過少申告は規約違反なので、
    // 絵を置ける場所すべてを見る
    const usesPreset =
      cover.wrap?.kind === 'preset' ||
      cover.background.kind === 'preset' ||
      cover.backCover.kind === 'preset' ||
      settings.bodyBgFromPreset === true ||
      [settings.titleBg, settings.tocBg, settings.colophonBg].some((b) => b?.fromPreset) ||
      Object.values(settings.chapterBg ?? {}).some((b) => b?.fromPreset) ||
      (settings.plates ?? []).some((p) => p.fromPreset) ||
      // 章の途中の絵も［挿絵］からプリセットを選べる(2026-09-23)
      manuscript.chapters.some((ch) =>
        ch.blocks.some((b) => b.type === 'image' && b.fromPreset),
      );
    /**
     * **作るものと出し先で、控えの行を絞る。**(2026-09-23)
     * 判型・用紙・裁ち落とし・ページ数は紙の入稿で訊かれる値なので、紙を作るときだけ。
     * 生成AIの申告は KDP が紙でも電子でも訊く。言い方は KDP に出すときだけ KDP の画面の呼び名にする。
     *
     * **紙の控えに申告の行を置くのは、紙の出し先が訊くとき(asksAiDeclaration)だけ。**(2026-10-07)
     * 紙を申告を訊かない会社・電子を KDP にした本で、紙の控えに KDP 向けの行が混ざっていた。
     * 紙の出し先が訊かないときは、電子書籍の側の控え(ebook: true)に置く。
     * 紙だけで、その出し先が訊かないなら出さない
     */
    const out = outputsOf(settings);
    const profile = PRINT_TARGETS[settings.printTarget];
    const saddleSpec = saddleOn ? profile.saddle : undefined;
    const rules = printRulesOf(settings);
    const bleed = bleedOf(settings);
    const paperAsksAi = out.paper && profile.asksAiDeclaration;
    const kdpAsks = paperAsksAi || (out.ebook && settings.epubTarget === 'kdp');
    // 共紙の中綴じは、表紙の4ページも本文 PDF に入る。「表紙を除く」と言う会社の項目名のままだと、数字と食い違う
    const pagesLabel = selfCover ? 'ページ数（表紙の4ページを含む）' : (profile.specLabels?.pages ?? 'ページ数');
    const paperRows: Spec[] = [
      {
        label: profile.specLabels?.trim ?? '判型（トリムサイズ）',
        value: `${trim.w} × ${trim.h} mm`,
        note: `${trim.label.replace(/\s+\d+×\d+$/, '')}・${
          settings.writingMode === 'vertical' ? '縦書き（右綴じ）' : '横書き（左綴じ）'
        }`,
      },
      // 用紙の一覧を持つ会社は、刷り色と、注文のときに書く本文用紙・表紙用紙を分けて出す
      ...(ownPapers
        ? [
            { label: profile.inkPaperLabel, value: settings.ink === 'mono' ? '白黒' : 'カラー' },
            { label: '本文用紙', value: ownPapers.body.label },
            ...(saddleOn ? [] : [{ label: '表紙用紙', value: ownPapers.cover.label }]),
          ]
        : [
            {
              label: profile.inkPaperLabel,
              value:
                settings.ink === 'mono' ? `白黒・${PAPER_TYPES[paper].label}` : PAPER_TYPES[paper].label,
            },
          ]),
      // 注文の項目に「綴じ方」がある会社(specLabels.binding)だけ。いま作れる綴じ方は無線綴じ
      // 無線綴じか中綴じか。発注書に「綴じ方」がある会社のほか、中綴じのときは、どの印刷所でも出す(2026-10-03)
      ...(profile.specLabels?.binding || saddleOn
        ? [
            {
              label: profile.specLabels?.binding ?? '綴じ方',
              value: saddleOn ? (selfCover ? '中綴じ（表紙も本文と同じ紙＝共紙）' : '中綴じ（表紙は別の紙）') : '無線綴じ',
              note: saddleOn ? '真ん中をホチキスで留めます' : undefined,
            },
          ]
        : []),
      // 注文の項目に「綴じ方向」がある会社(specLabels.direction。ノドの検査に使う)
      ...(profile.specLabels?.direction
        ? [
            {
              label: profile.specLabels.direction,
              value: settings.writingMode === 'vertical' ? '右綴じ' : '左綴じ',
              note: settings.writingMode === 'vertical' ? '縦書きの本' : '横書きの本',
            },
          ]
        : []),
      // 中綴じの表紙用紙(出し先に決まりがあるときだけ。共紙には表紙の紙が別に無い)
      ...(saddleOn && !selfCover && saddleSpec?.coverPaperNote
        ? [{ label: '表紙用紙（中綴じ）', value: saddleSpec.coverPaperNote, note: `${profile.label}の入稿ガイドの決まりです` }]
        : []),
      // 印刷所の決まりが入っている本は、入っている塗り足しの幅とノド側の有無まで言う
      // (KDP と、決まりをまだ入れていない本は従来の文。2026-10-01)。
      // **呼び名は［本のかたちを決める］の欄と同じ「塗り足し」**に、印刷所の入稿画面で見かける「裁ち落とし」を添える。
      // 括弧が二重(あり（3mm（四辺）))にならないよう、「あり：」でつなぐ。KDP のほうは KDP の入稿画面の呼び名のまま
      rules
        ? {
            label: '塗り足し（裁ち落とし）',
            value: rules.bleedMm > 0 ? `あり：${bleedSummary(bleed)}` : 'なし',
            note:
              rules.bleedMm > 0
                ? `本文PDFは塗り足し込みの寸法です。ノド側（綴じる側）${
                    rules.bleedGutter ? 'にも付けています' : 'には付けていません'
                  }`
                : '本文PDFは仕上がりと同じ寸法です（塗り足しを付けない決まり）',
          }
        : { label: '裁ち落とし', value: 'あり', note: '本文PDFは塗り足し込みの寸法です' },
      /**
       * **数え終わるまで数を出さない。**(2026-08-22)
       *
       * ここは「KDP の画面に何と入れるか」の控えで、背幅もこの数から作る。
       * 長い本は組み上がるまで何十秒もかかり、そのあいだ既定値の
       * 「120ページ（概算）」が出ていた(297ページの実原稿の正解は 361ページ)。
       * 全部組まずに数だけ先に出す道は無い(VivliostylePreview の onCounting に実測)
       */
      /*
       * **いまの本の姿で組み上がった数だけを出す**(paperPagesNow)。(2026-09-24 レビューで発見)
       * 電子の下見を見ているあいだは紙の組版が止まるので、pageCount は前の本の姿の数のことがある
       */
      paperPagesNow !== null
        ? {
            label: pagesLabel,
            value: `${paperPagesNow} ページ`,
            note: spineNote(paperPagesNow),
          }
        : !pageCount && !counting
          ? {
              label: pagesLabel,
              value: `${estPages} ページ（概算）`,
              note: spineNote(estPages),
            }
          : {
              label: pagesLabel,
              value: counting ? '数えています…' : '紙の下見が組み上がると出ます',
              note: counting
                ? '数え終わると背幅も出ます。ページ数は組み上がってからでないと確かめられません'
                : '下見の下の［紙の本］で紙の下見を開くと数えます（背幅もそこで決まります）',
            },
    ];
    if (!paperAsksAi && !out.ebook) return paperRows;
    return [
      ...(out.paper ? paperRows : []),
      {
        label: 'AI 生成コンテンツ',
        ebook: !paperAsksAi,
        /**
         * **チェックボックスをやめた(2026-08-19)。**
         *
         * 同梱の絵を1枚でも使っていれば答えは「はい」で確定し、押しても
         * 「はい/いいえ」は動かない。動かないものを押させると、押した意味を探して
         * 迷わせるだけだった。持ち込みの絵や原稿が AI 製かどうかは
         * こちらから判別しようがないので、**判断も申告も利用者に返す。**
         * ここが出すのは「KDP の画面に何と入れるか」だけにする
         */
        value: usesPreset ? 'はい' : '使ったなら「はい」',
        // KDP は「はい」のあと区分(文章/画像/翻訳)とツール名を訊く。その2つに何と入れるかを言う
        note: usesPreset
          ? kdpAsks
            ? '同梱の表紙・背景は生成AI（Higgsfield）で作った画像です。KDP では区分に「画像」、ツール名に「Higgsfield」と入れてください'
            : '同梱の表紙・背景は生成AI（Higgsfield）で作った画像です。出版先が申告を求めるときは、区分に「画像」、ツール名に「Higgsfield」と答えてください'
          : '生成AIで作った画像や文章を使っていなければ「いいえ」で構いません',
        control: (
          <p className="hint spec-note">
            自分で用意した画像や文章{usesPreset ? 'にも' : 'に'}生成AIを使ったら、
            {kdpAsks ? (
              <>
                <b>そのツール名も KDP に入れてください</b>（未申告は規約違反になります）
              </>
            ) : (
              <>
                出版先が申告を求めるときは<b>そのツール名も答えてください</b>
              </>
            )}
          </p>
        ),
      },
    ];
  }, [
    settings.trim,
    settings.writingMode,
    settings.ink,
    settings.makePaper,
    settings.makeEbook,
    settings.printTarget,
    settings.printRules,
    settings.binding,
    settings.saddleCover,
    saddleOn,
    selfCover,
    settings.epubTarget,
    manuscript.chapters,
    cover.paper,
    cover.spineMmFromPrinter,
    cover.printerBodyPaper,
    cover.printerCoverPaper,
    cover.wrap?.kind,
    cover.background.kind,
    cover.backCover.kind,
    settings.bodyBgFromPreset,
    settings.titleBg,
    settings.tocBg,
    settings.colophonBg,
    settings.chapterBg,
    settings.plates,
    setSettings,
    pageCount,
    estPages,
    counting,
    paperPagesNow,
  ]);

  const stepPanel = () => {
    switch (step) {
      case 'shape':
        return (
          <ShapeStep
            settings={settings}
            setSettings={setSettings}
            applyPreset={applyPreset}
            ebookView={showEbook}
            paperPages={paperPagesNow}
            saddleBodyPages={saddleBodyPages}
            hasColophon={hasColophon}
            onPrintFocus={setPrintFocus}
            focusPrintRules={shapeFocus ?? undefined}
          />
        );
      case 'art':
        return (
          <ArtStep
            key={settings.bookId}
            focusPane={artFocus ?? undefined}
            addAt={plateAt}
            onAddAtUsed={() => setPlateAt(null)}
            onJump={(page) => {
              previewRef.current?.goToPage(page);
              previewRef.current?.flashPage(page);
            }}
            onBarScope={(scope) => setBarScopeRequest({ scope, seq: Date.now() })}
            /** 左の欄から足したときも、足した先へ飛んで光らせる */
            onAdded={(kind, id) => setJustAdded({ kind, id })}
            onFollow={(kind, id) => setJustAdded({ kind, id })}
            /** 左の一覧の該当行へスクロールして光らせる(どの経路の追加でも)。
                章の途中の絵は一覧の行の目印が imageKey の前に img: を付けたもの */
            justAddedId={
              justAdded ? (justAdded.kind === 'img' ? `img:${justAdded.id}` : justAdded.id) : null
            }
            settings={settings}
            chapters={manuscript.chapters}
            layoutInfo={layoutInfo}
            textRows={textRows}
            resRows={resRows}
            spreadNotes={spreadNotes}
            printTargetLabel={PRINT_TARGETS[settings.printTarget].label}
            ebookView={showEbook}
            onShowPaper={() => setPreviewMode('paper')}
            setSettings={setSettings}
            setChapters={(chapters, undoKey) => patchManuscript({ chapters }, undoKey)}
          />
        );
      case 'colophon':
        return (
          <ColophonStep
            manuscript={manuscript}
            patchManuscript={patchManuscript}
            settings={settings}
            setSettings={setSettings}
          />
        );
      case 'export':
        return (
          <ExportStep
            exporting={exporting}
            printing={printing}
            onPrintPdf={() => handlePrintPdf()}
            onExportEpub={() => void handleExportEpub()}
            onExportCoverPdf={async (opts) => (await coverRef.current?.exportPaperPdf(opts)) ?? null}
            onExportCoverJpeg={() => void coverRef.current?.exportEbookJpeg()}
            problems={problems}
            specs={specs}
            outputs={settings}
            setSettings={setSettings}
            choosingOutputs={choosingOutputs}
            onChoosingOutputs={setChoosingOutputs}
            ebookMono={settings.ebookMono === true}
            blankPlates={blankPlates}
            covers={coverShots}
            coverShotsFailed={coverShotsFailed}
            onGoToCover={goToCoverFromExport}
            target={exportTarget}
            onTarget={chooseExportTarget}
            coverSpinePending={paperPagesNow === null && !saddleOn}
            coverSpineFromPrinter={usesPrinterSpine(settings.printTarget, cover.spineMmFromPrinter)}
            blockReason={printBlockReason}
            onOpenBodyPreview={openBodyPreview}
            paperPages={paperPagesNow}
            ink={settings.ink}
            bookTitle={manuscript.title}
            paperMm={{ w: layout.paperW, h: layout.paperH }}
            boxes={bodyBoxes(layout)}
          />
        );
      default:
        return null;
    }
  };

  const stepLabel = STEPS.find((s) => s.id === step);

  return (
    <ColorPaletteProvider colors={bookPalette} label="この本の画像の色" mono={settings.ink === 'mono'}>
    <div className="app">
      {/* 書名は入口画面と 02 奥付、著者名も 02 奥付にある。
          ここにも同じ欄があると、どれが本物か分からなくなるので重ねない */}
      <header className="topbar" hidden={showStart && startMode === 'menu'}>
        {/* 題字はロゴ「本ちゃか」(2026-10-07)。前は本棚の印+「ひっちゃか本づくりスタジオ」 */}
        <h1>
          <StudioLogo height={30} />
        </h1>
        {/* **入口へ戻る道はタイトルの真横。**
            右端の並びに混ぜていたら「よくわからない場所に紛れている」と言われた
            (2026-08-19)。アプリ名の隣は、どの画面でも同じ位置にある帰り道 */}
        <button
          className="home-btn"
          onClick={() => {
            setStartMode('menu');
            setShowStart(true);
          }}
        >
          最初の画面に戻る
        </button>
        <div className="spacer" />
        <ProjectBar
          highlightSave={showStart && startMode === 'new'}
          // 入口画面でバックアップ先を選んだときだけ変わる。許可状態の判定を
          // 起動時にもう一度やらせるための作り直し(ProjectBar 自体は触らない)
          key={projectBarKey}
          ref={projectBarRef}
          snapshot={snapshot}
          sample={isSample}
          // 入口のカードの下に出すのは、入口を見ているあいだの失敗だけ(作業画面ではトップバーの知らせで足りる)
          onLoadError={(m) => {
            if (showStart) setLoadError(m);
          }}
          onLoad={(p) => {
            /**
             * **読み込みも「いまの本を捨てる」入口。** 新規作成・サンプルと同じ断りを出す。
             * ここが唯一の置き場 — 入口画面の［続けて作る］も、トップバーの［読み込む］も、
             * 最後はここを通る(2026-08-21 ユーザー指摘「3つとも見ること」)。
             *
             * 断るときは AbortError にする。ProjectBar の run() が
             * 「取り消しは失敗ではない」として黙って畳んでくれるので、
             * 押していないのに「読み込みました」とも「失敗しました」とも出ない
             */
            if (!confirmReplaceBook('読み込んだファイルで、いまの本を置き換えます。')) {
              throw new DOMException('読み込みをやめました', 'AbortError');
            }
            replaceProject(p);
            setImportError('');
            setLoadError('');
            /**
             * **入口画面から開いたときだけ、そのままスタジオへ進む。**(2026-09-14 ユーザー要望
             * 「.json を選んだあと、トップに戻るのではなく中身を開いてほしい」)
             *
             * ここに来るのは読み込みが確かに成功した(fromProjectFile も confirm も
             * 通り抜けた)ときだけ——壊れたファイル・別形式は上の run() の catch が、
             * 取り消しは直上の throw が先に止めるので、この行より下には進まない。
             * つまり「開けたときだけ進む」は if の中身を書くまでもなく、
             * 到達できた時点で保証されている。
             *
             * 進む先の工程を指定していないのは、replaceProject が本ごとに
             * 振り直す bookId を頼りにしているため——下の「本が変わったら画面の
             * 状態も戻す」effect が bookId の変化を見て setStep('shape') を
             * 呼んでおり(新規作成・サンプルと共通)、ここで二重に書くと
             * 「最初の工程」の定義が2か所に散らばってしまう。
             *
             * トップバーの［読み込む］や AiStep の読み込みは showStart が false の
             * まま同じ onLoad を通るので、この分岐に入らず今まで通り画面を動かさない
             */
            if (showStart) {
              setShowStart(false);
              setStartMode('menu');
            }
          }}
        />
        {/* 画面の色。**本の設定ではないので工程にも帯にも載せない。**
            ヘルプ・このアプリについてと同じ「アプリそのものの操作」の並びに置く */}
        <ThemeToggle />
        {/* 章立ての書き方と、つまずいたときの直し方。工程の中ではなくここに置くのは
            **参照だから**。原稿を書いている最中(＝このアプリを触っていない時間)に
            見返すものなので、どの画面からでも同じ場所で開けるのがいちばん都合がよい */}
        <button className="about-open" onClick={() => setHelp(true)}>
          ヘルプ
        </button>
        {/* AGPL 13条のソース表示を兼ねるので、隠さず常に開けるところに置く */}
        <button className="about-open" onClick={() => openAbout()}>
          このアプリについて
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.docx"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />
      </header>

      {/* お知らせ欄(notice.json)。入口のメニューでは StartScreen が自分の頭に出すので、ここはトップバーが見えているときだけ */}
      {!(showStart && startMode === 'menu') && <NoticeBar />}

      {/* 入口画面のあいだは工程レールを出さない。まだ本が無いので順路が意味を持たず、
          「タイトルと3つのボタンだけが見えているべき」(2026-08-18 ユーザー指摘) */}
      {!showStart && (
      <StepRail
        current={step}
        states={states}
        onSelect={setStep}
      />
      )}
      {/* 作業画面はパソコン向け。スマホなど狭い画面のときだけ出す(CSS の .narrow-notice。2026-10-09 全体確認:
          スマホで作業画面に入ると下見がほとんど見えず、案内も無かった) */}
      {!showStart && (
        <p className="narrow-notice" role="note">
          この画面はパソコン向けのため、画面が狭いと仕上がりの確認や操作がしづらいことがあります。
          ［保存する］で保存し、パソコンの［続けて作る］から開くのがおすすめです。
        </p>
      )}

      {/*
        01 だけは他の工程と型が違う。サイドバー+プレビューではなく、
        画面いっぱいにアプリ名と3つの大きな入口だけを出す。

        **`.main` は隠すだけで、アンマウントしない。** 以前は showStart で
        三項演算子ごと切り替えていたが、それだと出し入れのたびに
        VivliostylePreview(組版エンジンの再初期化コスト)ごと作り直しになり、
        レイアウト計算の途中に破棄されて DOMRect の例外を吐くことがあった。
        `.cover-host` と同じ「常時マウント+hidden」に揃える
      */}
      {fullPage && (
        <div className="fullstage">
          <div className="fullstage-inner wide">
            <h2 className="fullstage-title">{stepLabel?.label}</h2>
            {importError && <p className="error">{importError}</p>}
            {notice && <p className="notice">{notice}</p>}
            {step === 'ai' && (
              <AiStep
                onExportForAi={() => projectBarRef.current?.exportForAi()}
                onLoadProject={() => projectBarRef.current?.openProjectFile()}
                onPickManuscript={() => fileRef.current?.click()}
                onGoToPlates={() => {
                  setStep('art');
                  setArtFocus({ pane: 'plates', seq: Date.now() });
                }}
                imageCheckPrompt={imageCheck}
                /* 「印刷所の決まり」へ飛ぶ。出し先が KDP・紙を作らない本のときは、勝手に設定を変えず、
                   案内だけする(ShapeStep の見出しはあるが、紙が無い本では欄ごと出ない) */
                printRulesState={
                  !outs.paper ? 'no-paper' : !usesOwnPrintRules(settings.printTarget) ? 'kdp' : 'ok'
                }
                onGoToShape={(to = 'head') => {
                  jumpToPrintRules.current = true;
                  setStep('shape');
                  setShapeFocus({ seq: Date.now(), to });
                }}
              />
            )}
            {(exportHub || exportEbook || exportPaper) && (
            <ExportStep
              exporting={exporting}
              printing={printing}
              onPrintPdf={() => handlePrintPdf()}
              onExportEpub={() => void handleExportEpub()}
              onExportCoverPdf={async (opts) => (await coverRef.current?.exportPaperPdf(opts)) ?? null}
              onExportCoverJpeg={() => void coverRef.current?.exportEbookJpeg()}
              problems={problems}
              specs={specs}
              outputs={settings}
              setSettings={setSettings}
              choosingOutputs={choosingOutputs}
              onChoosingOutputs={setChoosingOutputs}
              ebookMono={settings.ebookMono === true}
              blankPlates={blankPlates}
              covers={coverShots}
              coverShotsFailed={coverShotsFailed}
              onGoToCover={goToCoverFromExport}
              target={exportTarget}
              onTarget={chooseExportTarget}
              coverSpinePending={paperPagesNow === null && !saddleOn}
              coverSpineFromPrinter={usesPrinterSpine(settings.printTarget, cover.spineMmFromPrinter)}
              blockReason={printBlockReason}
              onOpenBodyPreview={openBodyPreview}
              paperPages={paperPagesNow}
              ink={settings.ink}
              bookTitle={manuscript.title}
              paperMm={{ w: layout.paperW, h: layout.paperH }}
            boxes={bodyBoxes(layout)}
            />
            )}
          </div>
        </div>
      )}

      {showStart && (
        <StartScreen
          isSample={isSample}
          source={source}
          chapters={manuscript.chapters.length}
          totalChars={totalChars}
          noChapters={noChapters}
          importError={importError}
          notice={notice}
          onReparse={() => void handleReparse()}
          outputs={settings}
          setSettings={setSettings}
          title={manuscript.title}
          author={manuscript.author}
          onTitle={(v) => patchManuscript({ title: v })}
          onAuthor={(v) => patchManuscript({ author: v })}
          mode={startMode}
          onModeChange={setStartMode}
          onPickFile={() => fileRef.current?.click()}
          onLoadProject={() => {
            setLoadError('');
            projectBarRef.current?.openProjectFile();
          }}
          loadError={loadError}
          onLoadSample={loadSample}
          onStartNew={startNewBook}
          onChooseFolder={handleChooseBackupFolder}
          onOpenAbout={openAbout}
          onOpenHelp={() => setHelp(true)}
          onClose={() => {
            /* **ヘルプ・このアプリについてが上に乗っているあいだは閉じない。**
               3つとも window の Esc を拾うので、入口からパネルを開いて Esc を
               押すと、パネルと一緒に入口まで閉じて作業画面に放り出されていた
               (2026-08-28 リモートで発見)。Esc はいちばん上の1枚だけを閉じる */
            if (help || about) return;
            setShowStart(false); setStartMode('menu');
          }}
        />
      )}

      {/* 本文側のステップ。表紙(06)のとき・入口画面を出しているときは隠す */}
      {/* 07 の「選ぶ画面」は分岐するだけなので、01 と同じくプレビューを出さない。
          何かを選んだら、その1つを確かめながら書き出すのでプレビューが戻る */}
      <div className="main" hidden={step === 'cover' || showStart || fullPage}>
        {/* **スクロール位置は工程ごとに覚える。**(2026-09-02 ユーザー指摘)
            同じ要素を使い回して中身だけ差し替えるので、何もしないと
            前の工程で下げた位置のまま次の工程が開いてしまう。
            覚え書きは onScroll で取り続け、工程が替わったら戻す(初見は先頭) */}
        <aside
          className="sidebar panel"
          ref={sidebarRef}
          onScroll={(e) => {
            sidebarScrollMemo.current[step] = e.currentTarget.scrollTop;
          }}
        >
          {/* **工程の名前はレールに出ている。** ここに同じ語を並べると、
              同じ文字が縦に2つ続いてサイドバーの高さを食うだけだった
              (2026-08-19 ユーザー指摘)。パネルの中身がその工程のものであることは、
              レールの選択で分かる */}
          {importError && <p className="error">{importError}</p>}
          {notice && <p className="notice">{notice}</p>}
          {stepPanel()}
        </aside>

        <main className="stage">
          <div className="preview">
            {/* **電子の下見を出しているあいだ、紙の下見は隠す(display: none)。** 隠れた紙は
                組版を止める(VivliostylePreview の visible)ので、2つを同時に組むことはない。
                display: contents の包みは箱を作らないので、紙の下見の配置は変わらない */}
            {loaded ? (
              <div style={{ display: showEbook ? 'none' : 'contents' }}>
              <VivliostylePreview
                key={settings.bookId}
                ref={previewRef}
                html={debouncedHtml}
                /* 塗り(背景・色・フチ・帯)は組版を通さず、この CSS の差し替えだけで映す */
                paintCss={previewCss}
                onPageCount={setPageCount}
                onLayout={(info, html) => {
                  setLayoutInfo(info);
                  setLayoutHtml(html);
                }}
                onVisibleChapters={(ch, cols, pgs) => {
                  setVisibleChapters(ch);
                  setVisibleColumns(cols);
                  setVisiblePages(pgs);
                }}
                onCounting={setCounting}
                /**
                 * 本文を書き出そうとしているあいだは単ページに固定する。
                 * 紙のPDFも EPUB も1ページずつで出るのに、見開きのまま下見していると
                 * 「見開きで刷られる」と読める(2026-08-19 ユーザー指摘)
                 */
                /* ［電子書籍の本文］はもう下見を出さないので、ここは紙だけでよい(2026-08-21) */
                forceView={
                  step === 'export' && exportTarget === 'paperBody' ? 'single' : undefined
                }
                onAddInsert={addInsert}
                addKinds={
                  outputsOf(settings).paper ? ['plate', 'colpage', 'blank'] : ['plate', 'colpage']
                }
                onMoveInsert={moveInsert}
                onDeleteInsert={deleteInsert}
                onCopyInsert={copyInsert}
                modeSwitch={previewModeSwitch}
                /* 仕上がり線(裁つ位置の点線)と版面の枠(2026-10-02)。位置は、組んだ HTML に書いてある塗り足しと余白から読む */
                boxesOf={pageBoxesOfHtml}
                /* 絵の中の文字が版面の外に出ているあいだ、全ページに版面の枠を出す(なぜ外なのかを目で分かるように) */
                showArea={textFindings.some((f) => !f.foldOnly)}
              />
              </div>
            ) : (
              <p className="loading">読み込み中…</p>
            )}
            {showEbook && ebookBook && (
              <EbookPreview
                key={settings.bookId}
                book={ebookBook}
                vertical={heldSettings.writingMode === 'vertical'}
                labels={ebookLabels}
                focus={ebookFocus}
                modeSwitch={previewModeSwitch}
              />
            )}
            {/* 書き出しの画面から飛んできたときの戻り道 */}
            {step !== 'cover' && returnButton}
            {/* **［電子書籍の本文］の札と、EPUB の1ページ目に入る表紙は外した。**(2026-08-21)
                どちらもあの工程で下見を出していたからこそ要ったもので、
                下見をやめた(ExportStep の .epub-stage)いま、出す場所そのものが無い。
                - 「この下見は紙の組み方です」の札(.preview-what)… 断ってまで下見を
                  出す値打ちが無い、というのがユーザーの判断。画面ごとやめた
                - EPUB の1ページ目の表紙(.preview-first-page)… 板の中へ小さく移すことも
                  試したが、実測で 109px 食って［書き出す］が落ちた。絵は
                  ［電子書籍の表紙］で見てもらう(ExportStep に理由を書いた)

                表紙を書き出すあいだは、本文の上に表紙の見本をかぶせる。
                組版エンジンを外して作り直すと再初期化のコストと例外を招くので、
                `.cover-host` と同じ「常時マウント+かぶせる」でそろえる */}
            {coverShot && (
              <div className="preview-cover">
                <figure className={exportTarget === 'ebookCover' ? 'ebook' : undefined}>
                  <img
                    src={coverShot}
                    alt={exportTarget === 'paperCover' ? '紙の表紙の見本' : '電子書籍の表紙の見本'}
                  />
                  <figcaption>
                    {exportTarget === 'paperCover'
                      ? '紙の表紙（表4・背・表1）— この見た目で書き出します'
                      : '電子書籍の表紙（表1のみ）— この見た目で書き出します'}
                  </figcaption>
                </figure>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* 表紙。書き出し(07)から呼べるよう常にマウントし、表示だけ切り替える */}
      {/* **入口画面を出しているあいだは表紙も隠す。** 隠し忘れていて、
          入口画面のまま「03 表紙」を押すと下に表紙エディタが生えていた
          (2026-08-18 ユーザー報告) */}
      <div className="cover-host" hidden={step !== 'cover' || showStart}>
        <CoverEditor
          key={settings.bookId}
          ref={coverRef}
          visible={step === 'cover'}
          trim={settings.trim}
          writingMode={settings.writingMode}
          titleWritingMode={settings.titleWritingMode}
          ink={settings.ink}
          pages={pageCount || estPages}
          printTarget={settings.printTarget}
          bleedMm={printRulesOf(settings)?.bleedMm ?? COVER_BLEED_MM}
          spineInsetMm={settings.spineInsetMm}
          binding={saddleOn ? 'saddle' : 'perfect'}
          selfCover={selfCover}
          makes={outputsOf(settings)}
          topSlot={step === 'cover' ? returnButton : null}
          title={manuscript.title}
          author={manuscript.author}
          publisher={manuscript.publisher}
          onFrontInk={setCoverFrontInk}
          onPalette={setCoverPalette}
          onPaneChange={setCoverPane}
          onExportError={setImportError}
        />
      </div>

      {/* **版面の帯。工程の外に置く。**
          判型も書体も、絵を入れながら・奥付を書きながら・表紙を作りながら変えたくなる。
          どの画面にいても同じ場所にあるよう、.main / .cover-host / 全画面のどれとも
          並ばない位置(.app の直下)に置く。入口画面のときだけ引っ込める */}
      {!showStart && (
        <ColorPaletteProvider
          colors={step === 'cover' ? coverPalette : bookPalette}
          label={step === 'cover' ? 'この表紙の画像の色' : 'この本の画像の色'}
          mono={step !== 'cover' && settings.ink === 'mono'}
        >
        <FormatBar
          key={settings.bookId}
          /**
           * いま画面に出ている章の番号(0始まり)。見開きなら2つ入ることがある。
           * **帯が「この章だけ」の飾りを出すのに使う。**
           * VivliostylePreview から直に来る(いま画面にある紙面から読んだもの)ので、
           * 前から進んでも後ろから戻っても同じ見開きなら同じ答えになる
           */
          visibleChapters={visibleChapters}
          visibleColumns={visibleColumns}
          visiblePages={visiblePages}
          scopeRequest={barScopeRequest}
          coverPane={coverPane}
          /** 背に文字を刷るか(背幅が足りて、［背］で「刷る」にしているとき)。表紙の帯の「背の文字」を出す条件 */
          coverSpineText={resCoverLayout.spineTextAllowed && cover.spineTextOn}
          /**
           * 帯に何を出すか。**その工程で効くものだけを出す。**
           * 効かない操作が並んでいると、触っても何も起きない体験になる
           * (2026-08-19 ユーザー指摘)
           */
          barMode={
            step === 'cover'
              ? 'cover'
              : step === 'colophon'
                ? 'colophon'
                : step === 'ai' || step === 'export'
                  ? 'none'
                  : 'body'
          }
          /** いま開いている工程の色。レールの下線と帯の左端を同じ色で結ぶ */
          accent={STEP_ACCENT[step]}
          /** 表1の文字色が自動で白へ振られているか。色の欄のそばで断る */
          coverFrontInk={coverFrontInk}
          settings={settings}
          layout={layout}
          chapters={manuscript.chapters}
          trimLabel={(TRIM_SIZES[settings.trim] ?? TRIM_SIZES.bunko).label}
          totalChars={totalChars}
          pageCount={pageCount}
          estPages={estPages}
          counting={counting}
          /** 電子の下見を見ているあいだは、書体の欄を「電子書籍は固定」にする */
          ebookView={showEbook}
          onShowPaper={() => setPreviewMode('paper')}
          setSettings={setSettings}
        />
        </ColorPaletteProvider>
      )}

      {/* **どの画面にいても同じ場所に出る札。**(Ctrl+Z で使う)
          工程レールのすぐ下・中央。誌面にもサイドバーにも属さないので、
          表紙(06)や AI(05)の全画面でも同じように見える */}
      {toast && (
        <p className="app-toast" key={toast.seq} role="status">
          {toast.text}
        </p>
      )}

      {help && <HelpPanel onClose={() => setHelp(false)} />}
      {about && (
        <AboutPanel
          section={aboutSection}
          onClose={() => {
            setAbout(false);
            setAboutSection(null);
          }}
        />
      )}
    </div>
    </ColorPaletteProvider>
  );
}
