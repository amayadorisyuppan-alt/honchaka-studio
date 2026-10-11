// アプリの状態管理(Zustand)+ IndexedDB 自動保存。

import { create } from 'zustand';
import { openDB, type IDBPDatabase } from 'idb';
import { EDITION } from '../edition';
import { parseSource } from '../importers/load';
import { sanitize } from '../project/file';
import {
  DEFAULT_PRINT_RULES,
  usesOwnPrintRules,
  THEME_BODY_FONT,
  defaultSettings,
  fitInsertsToChapters,
  followChapters,
  hasOwnBg,
  maxColumns,
  migrateBgSettings,
  migrateManuscript,
  typographyDefaults,
  type InsertFit,
  type Manuscript,
  type ProjectSettings,
  type SourceFile,
  type TrimId,
  type WritingMode,
} from '../models/project';
import { defaultCoverSettings, migrateCoverSettings, type CoverSettings } from '../models/cover';
import { carryStudioImages, matchChapters } from '../models/inlineImages';
import { sampleManuscript } from '../sample';
import { hasSampleFigStandIns, loadSampleArt, loadSampleFigs, replaceSampleFigs, sampleCover } from '../sampleArt';

/**
 * 元に戻す(Ctrl+Z)ために控える、変更ひとつぶん。
 *
 * **深いコピーを取らないこと。** 背景・挿絵・表紙は data URI で持っていて
 * 1冊で数十MBになる。Zustand の更新は `{...前, ...差分}` で新しい object を作るので、
 * **前の object の参照をそのまま持てば、画像は共有されたままで増えない。**
 * structuredClone や JSON の往復を挟むと、控えるたびに画像が丸ごと複製されて
 * すぐメモリが尽きる(30件なら数百MB)
 */
interface Undoable {
  settings: ProjectSettings;
  cover: CoverSettings;
  manuscript: Manuscript;
  /** 何を変えたのか。戻したときに画面へ出す言葉 */
  label: string;
}

/**
 * 帯の［すべてリセット］が戻す範囲。**帯の名札に出ている対象と1対1。**
 *
 * 帯は「本全体／◯章だけ」「奥付／著者紹介」と書き込み先を切り替えながら使う道具なので、
 * リセットも**そのとき向いている先だけ**を戻す。向いていない先まで巻き込むと、
 * 章の色を直すつもりで押した1回で本全体の書体まで飛ぶ
 */
export type DesignScope =
  | { kind: 'book' }
  | { kind: 'chapter'; index: number }
  | { kind: 'matter'; key: 'colophonType' | 'profileType' };

/**
 * 帯が書き込む「章ごとの指定」。**リセットはこの集合をそのまま消す。**
 * ここに足し忘れると、その項目だけ章の上書きが残って「戻らない」ことになる
 * (FormatBar の ChapterMapKey と同じ並び。片方だけ増やさないこと)
 */
const CHAPTER_DESIGN_KEYS = [
  'chapterFont',
  'chapterFontPt',
  'chapterLineFeedPt',
  'chapterColumns',
  'chapterDropCap',
  'chapterTextColor',
  'chapterHeadingColor',
  'chapterSubheadingColor',
  'chapterPlate',
  'chapterPlateColor',
] as const;

/**
 * `chapterBg` のうち、帯が書き込むのはこの3つだけ。
 * **`src`(その章に敷いた絵)は消さない。** 絵は［本文に画像とコラムを入れる］で選ぶもので、
 * 見た目の道具である帯のリセットで消えてよいものではない
 */
const CHAPTER_BG_DESIGN_KEYS = ['opacity', 'outline', 'outlineColor'] as const;

interface ProjectState {
  settings: ProjectSettings;
  /** 表紙の設定。自前画像は data URI で入るのでそれなりに重い */
  cover: CoverSettings;
  manuscript: Manuscript;
  /** 取り込んだ原稿ファイルそのもの(組み直し用)。サンプル表示中は null */
  source: SourceFile | null;
  /**
   * まだサンプルを見ているだけか。
   *
   * **これが true のあいだは自動バックアップを書かない**(ProjectBar)。
   * サンプルは作品ではなく見本なので控える意味がなく、それでも書くと
   * 起動して眺めただけの人のフォルダにサンプルの控えが世代20まで溜まる。
   * IndexedDB への自動保存は止めない — 触った状態が残らないと不便なため。
   *
   * 落ちるのは「自分の原稿を取り込んだとき」と「プロジェクトを読み込んだとき」だけ。
   * 判型や書体をいじっただけでは落とさない(それはまだサンプルで遊んでいる状態)
   */
  isSample: boolean;
  /**
   * **利用者がこの本に手を入れたか。**
   *
   * 消える前の断りを出すかどうかは、これ1つで決める(`hasWorkToLose`)。
   * `isSample` を代わりに使ってはいけない — サンプルを見ているだけの人でも、
   * 絵を足し、章の地を変え、表紙を組んでいることがある。
   * 立てるのは `pushUndo`(見た目・絵・表紙の変更が必ず通る)と `setManuscript`。
   * 開き直しても残るよう IndexedDB にも保存する
   */
  touched: boolean;
  /**
   * **サンプルの本文(章の途中の絵)に手を入れたか。**(2026-09-23)
   * 立てるのは patchManuscript(［挿絵］で章の途中の絵を足す・動かす・消す・替える)。
   * 立っているサンプルは、開き直しても本文を新しいサンプルへ差し替えない(freshenSample)。
   * 本を入れ替えたら落とす(replacedBookState)。開き直しても残るよう IndexedDB にも保存する
   */
  sampleEdited: boolean;
  loaded: boolean;
  /**
   * 保存が1件も無い状態で開いた=はじめての起動。**hydrate が一度だけ立てる。**
   * 入口画面(StartScreen)を自動で出すかどうかの判定に使う。isSample は
   * 「サンプルに戻す」を押しても true に戻ってしまうので、はじめてかどうかの
   * 判定には使えない(戻すたびに入口画面が勝手に出てくることになる)。こちらは
   * 開いたときの1回きりの事実だけを持つので、あとで手動で入口画面を閉じても
   * 再び勝手に出てはこない
   */
  isFirstRun: boolean;
  /**
   * **この端末への自動保存(IndexedDB)が失敗しているときのメッセージ。** 空なら正常。
   * 容量超過などで put が失敗し続けると「開き直せば続きから」が黙って崩れるので、
   * 状態に持って画面に赤で出す(2026-09-04)。成功したら空へ戻す
   */
  autosaveError: string;
  /**
   * 前回の保存を開いたときに直したもの(読めない値・外したもの)。ProjectBar が一度だけ知らせて空に戻す。
   * **自動保存の道にも読み込みと同じ点検を通す**(2026-09-25 見直し S1-3: 読めない値が自動保存されると、
   * 開き直しても毎回画面が落ちた。.json の読み込みだけ点検していた)
   */
  restoreFixes: string[];
  /**
   * 元に戻せる操作の控え。**新しいものが末尾。**
   * 中身は「その操作をする**前**の状態」で、一番上を取り出して被せれば1つ戻る
   */
  past: Undoable[];
  /** 戻したぶんの行き先(やり直し用)。新しく何かをしたら捨てる */
  future: Undoable[];
  /**
   * 1つ戻す。戻したものの名前を返す(何も無ければ null)。
   * **返り値は画面に出すためのもの。** 黙って変わると何が起きたか分からない
   */
  undo: () => string | null;
  /** 1つやり直す。やり直したものの名前を返す(何も無ければ null) */
  redo: () => string | null;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  setCover: (patch: Partial<CoverSettings>) => void;
  /** 判型・組み方向を変えたら文字サイズ・行送り・余白も既定値に合わせ直す */
  applyPreset: (trim: TrimId, mode: WritingMode) => void;
  /**
   * 帯（デザインする）の［すべてリセット］。**帯に出ているものだけを、はじめの状態へ戻す。**
   *
   * 戻す範囲は帯がいま向いている先そのもの(`DesignScope`)。
   * 帯の名札が「本全体をデザインする」なら本全体、「◯章だけ」ならその章、
   * 奥付の工程なら奥付か著者紹介の見た目だけを戻す
   */
  resetDesign: (scope: DesignScope) => void;
  /**
   * 原稿を取り込む。**章の数が変わったぶん、差し込みページを収め直して返す。**
   * 返り値は画面で断りを出すために使う(黙って動かさない)
   */
  setManuscript: (ms: Manuscript, src?: SourceFile) => InsertFit;
  /**
   * 原稿の一部を書き換える(元に戻せる)。
   * `undoKey` を渡すと、同じ鍵の書き換えが続いたときだけ1つの「元に戻す」にまとまる
   * (キャプションを打つ1字ずつを別の手にしない)。渡さなければ欄の名前でまとめる
   */
  patchManuscript: (patch: Partial<Manuscript>, undoKey?: string) => void;
  /**
   * 保持している原稿ファイルを現在の取込処理で組み直す(書名などは引き継ぐ)。
   * setManuscript と同じく、動かしたものを返す(原稿が無ければ undefined)
   */
  reparse: () => Promise<InsertFit | undefined>;
  /**
   * **はじめて開いたときの状態に戻す。** 原稿だけでなく、設定・表紙・絵も戻す。
   *
   * 原稿だけ差し替えていたら、前の本の背景や挿絵が残ったままサンプルの文章が
   * 流れてきて「サンプルと同じにならない」ことになった(2026-08-17 ユーザー報告)。
   * ボタンの意味はリセットなので、ゼロベースに戻す
   */
  loadSample: () => Promise<void>;
  /**
   * まっさらな本を始める。**サンプルには戻さない。**
   *
   * 「新規作成」なのに前の本の絵が残っていると、数冊を並行して作るときに
   * 別の本の挿絵や表紙が紛れ込む(2026-08-19 ユーザー指摘)。
   * 原稿・設定・表紙・絵をすべて捨て、本の id も振り直す
   */
  startNewBook: () => void;
  /** 読み込んだプロジェクトで丸ごと入れ替える(バックアップからの復元・AI が直したものの取り込み) */
  replaceProject: (p: Saved) => void;
  hydrate: () => Promise<void>;
}

/**
 * IndexedDB を**消さないでほしい**とブラウザに申し出る。
 *
 * 既定の保存は best-effort で、ディスクが逼迫するとブラウザに捨てられうる。
 * ここが消えると「開き直せば続きから」が成り立たなくなるので、本物の原稿が
 * 入った時点で1度だけ頼む(サンプルを眺めているだけの人には頼まない)。
 *
 * Chrome / Edge は利用状況から自動で判断し、**確認は出さない**。
 * Firefox は確認を出すので、押す理由が本人にある瞬間まで待つ意味がある。
 * 断られても動きは変わらない(だから戻り値は見ない)
 */
/** 本を見分けるための id。中身ではなく「別の本かどうか」だけに使う */
const newBookId = () => crypto.randomUUID();

/**
 * 奥付と著者紹介の欄。**原稿を取り込み直しても残す。** どれもスタジオ(［奥付と著者紹介を入れる］や
 * AI の往復)で書く欄で、原稿ファイルには入っていない。取り込むたびに消えていたのに、画面は
 * 「本文だけが入れ替わる」と言っていた(2026-09-23 レビューで発見)。空の欄は持ち越さない
 */
function colophonOf(m: Manuscript): Partial<Manuscript> {
  const out: Partial<Manuscript> = {};
  (['authorProfile', 'published', 'printer', 'isbn', 'colophonExtra'] as const).forEach((k) => {
    if (m[k]) out[k] = m[k];
  });
  return out;
}

/** まっさらな原稿。サンプルとは違い、章も文字も持たない */
function emptyManuscript(): Manuscript {
  return { title: '', author: '', publisher: '', chapters: [] };
}

/**
 * **保存されたサンプルを、いまのサンプルで組み直す。**
 *
 * 保存にあるのは「そのとき組み上がったサンプルの写し」なので、
 * アプリが新しくなってもそこは古いままになる。
 * これが 2026-08-21 の「署名が紙では行末に寄るのに画面では寄らない」の正体だった:
 *
 * | | 何を読んでいたか | 署名 |
 * |---|---|---|
 * | 紙(PDF・CLI) | src/sample.ts を毎回読み直す | `>>` があるので行末に寄る |
 * | 画面 | IndexedDB に残った古い写し | `>>` を足す前の原稿なので行頭のまま |
 *
 * 押されたときだけ読み直す作りになっていた(StartScreen の［サンプルを見る］)。
 * **開き直しただけの人には新しいサンプルが届かない。**
 *
 * 差し替えるのは `chapters` だけ。書名・著者名・奥付の欄は入口画面で書き換えられる
 * ので利用者のものを残す。原稿を取り込めば isSample が落ちるので、ここへは来ない。
 *
 * **［挿絵］で章の途中の絵に手を入れたサンプルは、差し替えない。**(2026-09-23)
 * 本文ごと差し替えると手を入れた絵が消える。はじめは「絵に手を入れたら isSample を落とす」で
 * 守ったが、それだとサンプルなのに［直した原稿を取り込み直す］が出て、取り込んだ自分の原稿へ
 * サンプルの絵まで付け直してしまった(ユーザー報告「サンプルを開いてもこのボタンが出ている」)。
 * 次に「保存と今のサンプルで絵の並びが違えば、今のサンプルへ絵を付け直す」を試したが、
 * 手を入れたのか sample.ts の側が変わったのかを見分けられず、古い保存の絵を消し、
 * 空行や場面転換の前へ絵をずらし、絵を選ぶ前の枠を落とした(同日のレビューで発見)。
 * **手を入れたかは推し量らず、印(sampleEdited)で持つ。** 立っていれば保存どおりに開く
 * (新しいサンプルの本文は届かないが、［サンプルを見る］を押せば入れ替わる)
 *
 * サンプルの章の数が変わったときは、章ごとの指定(chapterBg など)の番号がずれる。
 * サンプルを差し替えるときはそこまで見ること
 */
function freshenSample(ms: Manuscript, isSample: boolean, edited: boolean): Manuscript {
  if (!isSample || edited) return ms;
  return { ...ms, chapters: sampleManuscript().chapters };
}

async function askPersist() {
  try {
    if (!navigator.storage?.persist || (await navigator.storage.persisted())) return;
    await navigator.storage.persist();
  } catch {
    /* 未対応のブラウザでは何もしない */
  }
}

// **版ごとに名前を分ける**(EDITION.storageSuffix。標準の版は '' で、いままでの名前のまま)。
// 自動保存はアドレスごとに分かれ、フォルダでは分かれないので、同じアドレスの別のフォルダに置いた別の版と混ざらないように
const DB_NAME = 'book-studio' + EDITION.storageSuffix;
const STORE = 'project';

let dbPromise: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore(STORE);
    },
  });
  return dbPromise;
}

interface Saved {
  settings: ProjectSettings;
  cover: CoverSettings;
  manuscript: Manuscript;
  source: SourceFile | null;
  isSample?: boolean;
  /** 手を入れた印。**開き直しても消える前の断りが出るように**、これも保存する */
  touched?: boolean;
  /** サンプルの本文に手を入れた印(ProjectState.sampleEdited) */
  sampleEdited?: boolean;
}

/**
 * **前回のデータを読めなかったときは自動保存を止める。**(2026-09-04 レビュー指摘)
 * 読み込みが一時的に失敗しただけで、レコード自体は無事なことがある。そのまま
 * サンプルや空で上書き保存すると、唯一の控え(バックアップ未設定の人)を壊す。
 * hydrate の失敗でここを立て、リロードするまで書き込みを一切させない
 */
let autosaveBlocked = false;

/**
 * **同じ本を2つのタブで開いたら、片方の自動保存を止める。**(2026-09-04 レビュー指摘)
 * 保存先(IndexedDB の 'current')は1つなので、2タブが交互に書くと片方の作業が消える。
 * Web Locks でこのページが「主」を取れなければ自動保存を止め、警告を出す。
 * Web Locks の無い古い環境では何もしない(挙動は従来どおり)。ページを閉じるまで
 * 解放しないため、ロックは never-resolve の Promise で保持する
 */
let lockRequested = false;
function claimSingleTabLock() {
  if (lockRequested) return;
  lockRequested = true;
  const locks = (navigator as unknown as { locks?: LockManager }).locks;
  if (!locks?.request) return;
  // 鍵の名前も版ごとに分ける(DB_NAME と同じ理由。分けないと、同じブラウザで別の版を開いたとき、あとの方の自動保存が止まる)
  void locks.request('book-studio-current' + EDITION.storageSuffix, { ifAvailable: true }, (lock) => {
    if (lock) return new Promise<void>(() => {}); // 取れた=主。閉じるまで保持
    // 取れなかった=別のタブが開いている。こちらは書かない
    autosaveBlocked = true;
    useProject.setState({
      autosaveError:
        'この本は別のタブでも開いています。二重に開くと片方の作業が消えるため、' +
        'このタブでは自動保存を止めています。片方を閉じて、こちらを再読み込みしてください。',
    });
    return undefined;
  });
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** まだ書いていない自動保存(800ms 待ちのあいだ)。ページを離れるときに書き出す(flushSave) */
let pendingSave: Saved | undefined;
function scheduleSave(s: Saved) {
  if (autosaveBlocked) return;
  clearTimeout(saveTimer);
  pendingSave = s;
  saveTimer = setTimeout(() => {
    const p = pendingSave;
    pendingSave = undefined;
    if (p) void writeSave(p);
  }, 800);
}

/**
 * **ページを離れるときに、待っている自動保存を書き出す。**(2026-10-09 全体確認)
 * 変えてから 0.8 秒以内に再読み込み・タブを閉じると、その変更が自動保存に入っていなかった
 * (ヘルプは「閉じて開き直せば続きから作れます」と言っている)。離れる合図(beforeunload・pagehide)で書き始める。
 * 画像の多い大きな本では、再読み込みのときに書き終わらないことがある(確認の窓は出さない)
 */
function flushSave() {
  if (!pendingSave || autosaveBlocked) return;
  clearTimeout(saveTimer);
  const p = pendingSave;
  pendingSave = undefined;
  void writeSave(p, true);
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushSave);
  window.addEventListener('pagehide', flushSave);
}

async function writeSave(s: Saved, leaving = false) {
  const snapshot: Saved = {
    settings: s.settings,
    cover: s.cover,
    manuscript: s.manuscript,
    source: s.source,
    isSample: s.isSample,
    touched: s.touched,
    sampleEdited: s.sampleEdited,
  };
  try {
    const d = await db();
    // IndexedDB は構造化複製で保存するので、こちらで JSON へ往復させない。
    // 画像は data URI(1枚で1MB超になる)なので、往復させると保存のたびに
    // 数MBの文字列を作っては捨てることになり、入力のたびに引っかかる
    if (leaving) {
      // 離れる途中は、書き込みをすぐ確定させる(commit。待たずに閉じられても残りやすい)
      const tx = d.transaction(STORE, 'readwrite');
      void tx.store.put(snapshot, 'current');
      tx.commit?.();
      await tx.done;
    } else {
      await d.put(STORE, snapshot, 'current');
    }
    // 成功したら、前に出していた失敗表示を消す
    if (useProject.getState().autosaveError) useProject.setState({ autosaveError: '' });
  } catch (e) {
    // **握りつぶさない。**(2026-09-04 レビュー指摘)
    // 容量超過やディスク逼迫で put が失敗し続けると「開き直せば続きから」が崩れる。
    // 状態へ上げて画面に赤で出し、利用者に［保存する］で控えを促す(App/ProjectBar)
    console.warn('autosave failed', e);
    useProject.setState({
      autosaveError:
        'この端末への自動保存に失敗しました（空き容量が足りない可能性があります）。' +
        '［保存する］で .json ファイルに控えを取ってください。',
    });
  }
}

/**
 * サンプルの絵を読み込んで設定へ流す。**サンプルを見ているあいだだけ。**
 * 読み込みのあいだに利用者が自分の原稿を入れていたら、そこへ絵を被せない
 */
async function applySampleArt(
  set: (p: Partial<ProjectState>) => void,
  get: () => ProjectState,
  chapterCount: number,
) {
  const [art] = await Promise.all([loadSampleArt(chapterCount), upgradeSampleFigs(set, get)]);
  if (!art || !get().isSample) return;
  set({ settings: { ...get().settings, ...art } });
  scheduleSave(get());
}

/**
 * サンプルの文中の画像(千鳥2枚)を、代わりの絵から本物(public/sample/ のファイル)に差し替える。(1.0.2)
 * sampleManuscript() が入れるのは同じ画素数の代わりの絵なので(理由は sampleFig.ts の頭)、
 * **代わりの絵が原稿に残っていたら、どこから開いた本でも取りに行く**:
 * サンプルを開いたとき・はじめての起動・自動保存から開き直したとき(freshenSample でサンプルの本文に戻すと代わりの絵になる)・
 * 代わりの絵のまま保存された .json を読んだとき。
 * 置き換えるのは取ってきた**あと**の原稿(そのあいだに本文が直されていても、直したものは残る)。
 * 戻す履歴には積まない(利用者の操作ではない。手を入れた印 touched も立てない)
 */
async function upgradeSampleFigs(set: (p: Partial<ProjectState>) => void, get: () => ProjectState) {
  if (!hasSampleFigStandIns(get().manuscript)) return;
  const real = await loadSampleFigs();
  const ms = replaceSampleFigs(get().manuscript, real);
  if (!ms) return;
  set({ manuscript: ms });
  scheduleSave(get());
}

/**
 * 控える深さ。**30。**
 *
 * 1件が持つのは object の参照3つだけ(画像は現物を共有するので増えない)なので、
 * 深くしてもメモリはほとんど動かない。にもかかわらず 30 で止めるのは、
 * **押し続けたときに「いつの状態まで戻ったのか」が分からなくなるから。**
 * 判型・書体・色をひととおり試す1往復ぶんが 30 に収まる
 */
const UNDO_MAX = 30;
/**
 * 同じところをいじり続けているあいだを1件にまとめる、その切れ目(ms)。
 *
 * **1文字ずつ積んではいけない。** 書名やあらすじを打つたびに積むと、
 * Ctrl+Z を1回押しても1文字しか戻らず使いものにならない。
 * 手が止まった(800ms)ところを区切りとし、続けて打っている・つまみを動かして
 * いるあいだは**打ち始める前の状態を1つだけ**控える。
 * ゆっくり打つ人では1文字ぶんが1件になることもあるが、それでも 30 件ぶん戻れる
 */
const COALESCE_MS = 800;

/** 直前に積んだ操作の種類と時刻。まとめる相手を見分けるためだけに持つ */
let lastKind = '';
let lastAt = 0;

/** 変えた項目の名前。**画面に出す言葉なので、設定名ではなく利用者の言葉で書く** */
const CHANGE_LABELS: Record<string, string> = {
  // 本のかたち
  trim: '判型',
  writingMode: '組み方向',
  titleWritingMode: '書名の向き',
  theme: 'テーマ',
  ink: '刷り色',
  bodyFont: '本文の書体',
  fontPt: '文字の大きさ',
  lineFeedPt: '行送り',
  margins: '余白',
  columns: '段の数',
  columnGapLines: '段のあいだ',
  columnRule: '段のあいだの線',
  toc: '目次',
  dropCap: '章はじめの大文字',
  epubTarget: 'EPUB の出し先',
  ebookMono: '電子書籍の色',
  printTarget: '紙の出し先',
  printRules: '印刷所の決まり',
  binding: '綴じ方',
  saddleCover: '中綴じの表紙の入れ方',
  spineInsetMm: '背のアキ',
  // 色と背景
  bodyBg: '本文の背景',
  bodyBgFromPreset: '本文の背景',
  bgOpacity: '背景の濃さ',
  titleBg: '大扉の背景',
  tocBg: '目次の背景',
  colophonBg: '奥付の背景',
  chapterBg: 'この章の背景',
  textColor: '本文の色',
  headingColor: '見出しの色',
  subheadingColor: '小見出しの色',
  textOutline: '文字のフチ',
  textOutlineColor: 'フチの色',
  textPlate: '本文の下の帯',
  textPlateColor: '帯の色',
  chapterTextColor: 'この章の本文の色',
  chapterHeadingColor: 'この章の見出しの色',
  chapterSubheadingColor: 'この章の小見出しの色',
  chapterPlate: 'この章の帯',
  chapterPlateColor: 'この章の帯の色',
  chapterFont: 'この章の書体',
  chapterFontPt: 'この章の文字の大きさ',
  chapterLineFeedPt: 'この章の行送り',
  chapterColumns: 'この章の段の数',
  chapterDropCap: 'この章の大文字',
  // ノンブルと柱
  nombreSlot: 'ノンブルの位置',
  nombreFont: 'ノンブルの書体',
  runningHeadSlot: '柱の位置',
  runningHeadFont: '柱の書体',
  runningHeadPages: '柱を出すページ',
  runningHeadText: '柱の文字',
  // 差し込みページ
  plates: '挿絵ページ',
  columnPages: 'コラムページ',
  // 奥付まわり
  colophonType: '奥付の見た目',
  profileType: '著者紹介の見た目',
  aiContentByUser: '生成AIの申告',
  // 原稿
  title: '書名',
  author: '著者名',
  publisher: '版元',
  authorProfile: '著者紹介',
  chapters: '本文',
  // 表紙
  paper: '本文用紙',
  wrap: '表紙のまるごと1枚',
  background: '表1の地',
  backCover: '表4の地',
  band: '表紙の帯',
  bandColor: '帯の色',
  bandOpacity: '帯の濃さ',
  bandSoft: '帯のフチ',
  spineMmFromPrinter: '印刷所の背幅',
  spineMmPages: '印刷所の背幅',
  printerBodyPaper: '本文用紙',
  printerCoverPaper: '表紙用紙',
  bandOutlineColor: '帯のフチの色',
  spineColor: '背の色',
  spineTextOn: '背の文字',
  spineTitle: '背の書名',
  spineAuthorOn: '背の著者名',
  spinePublisherOn: '背の版元',
  spineFont: '背の書体',
  spineTextColor: '背の文字の色',
  spineScale: '背の書名の大きさ',
  spineAuthorScale: '背の著者名の大きさ',
  spinePublisherScale: '背の版元名の大きさ',
  spineSideways: '背の文字の向き',
  titleOverride: '表紙の書名',
  titleColor: '書名の色',
  titleScale: '書名の大きさ',
  titleAnchor: '書名の位置',
  titleFont: '書名の書体',
  authorColor: '著者名の色',
  authorScale: '著者名の大きさ',
  authorAnchor: '著者名の位置',
  authorFont: '著者名の書体',
  blurb: 'あらすじ',
  blurbFont: 'あらすじの書体',
  blurbDecor: 'あらすじの飾り',
  blurbBandColor: 'あらすじの帯の色',
  blurbBandOpacity: 'あらすじの帯の濃さ',
  blurbOutlineColor: 'あらすじのフチの色',
};

/**
 * 変えた項目から、画面に出す言葉を作る。
 * 表になければ大きな括りで言う(名前を知らない設定でも「何かを戻した」ことは伝わる)
 */
function changeLabel(keys: string[], fallback: string): string {
  // **まとめて書き換わったときは、代表の1つを名乗らせない。**
  // 表紙の［すべてリセット］は 30 項目を一度に差し替えるので、
  // 先頭の項目で「本文用紙」と出ると、何が戻ったのか読めなくなる
  if (keys.length >= 8) return `${fallback}のまとめ直し`;
  for (const k of keys) {
    if (CHANGE_LABELS[k]) return CHANGE_LABELS[k];
  }
  return fallback;
}

/**
 * いまの状態を「戻せるもの」として積む。**変える前に呼ぶこと。**
 *
 * `kind` が同じまま続けて呼ばれているあいだは積まない。積まないことで、
 * past の一番上は「その一連の操作を**始める前**」の状態のまま残る
 */
function pushUndo(
  set: (p: Partial<ProjectState>) => void,
  get: () => ProjectState,
  kind: string,
  label: string,
) {
  const now = Date.now();
  if (kind === lastKind && now - lastAt < COALESCE_MS) {
    lastAt = now;
    return;
  }
  lastKind = kind;
  lastAt = now;
  const s = get();
  // 参照をそのまま持つ。ここでコピーを取らないことがこの機能の前提
  const past = [
    ...s.past,
    { settings: s.settings, cover: s.cover, manuscript: s.manuscript, label },
  ];
  if (past.length > UNDO_MAX) past.splice(0, past.length - UNDO_MAX);
  // 何かを新しくやったら、やり直しの先は消える。**枝分かれは持たない**
  // touched もここで立てる。**「利用者が手を入れた」と分かる場所はここ1つ**なので、
  // 消える前の断りを出すかどうかの判定を、この1か所に集めておく
  set({ past, future: [], touched: true });
}

/**
 * 履歴を捨てる。**本が入れ替わったときだけ。**
 * 別の本になったのに前の本へ戻れると、混ざったものが出来上がって事故る
 */
function clearedHistory() {
  lastKind = '';
  lastAt = 0;
  return { past: [], future: [] };
}

/**
 * 本を入れ替えるときに、**どの入口でも必ず戻すもの。**
 *
 * 「新規・続けて・サンプル、どのボタンを押しても、いま残っているデータを
 * すべてゼロリセットしないといけない」(2026-08-21 ユーザー)。
 * 原稿・設定・表紙は入口ごとに入れる中身が違うが、ここに並ぶものは違いようがない。
 * **3か所に散らすと、また片方だけ直すことになる**ので、1つにまとめて持つ
 */
function replacedBookState() {
  return {
    /** 取り込んだ原稿ファイル。持ち越すと、別の本を［組み直す］で前の本文が流れ込む */
    source: null,
    /** 手を入れた印。入れ替えた直後は、まだ誰も何もしていない */
    touched: false,
    sampleEdited: false,
    ...clearedHistory(),
  };
}

/**
 * **いま開いている本に、消えて困るものがあるか。**
 *
 * `isSample` では測れない。サンプルを見ているだけの人でも、絵を足し、章の地を変え、
 * 表紙を組んでいることがある。それを「サンプルだから捨ててよい」と決めつけたのが
 * 2026-08-21 の報告(「アラートがなくデータが展開」)の正体。
 *
 * 判定は `touched` ひとつ。**pushUndo が立てる**ので、見た目・絵・表紙・原稿の
 * どれを触っても立つ(取り込みだけは履歴を畳むので setManuscript が直に立てる)。
 * 開き直しても残るよう IndexedDB にも一緒に保存する
 */
export function hasWorkToLose(): boolean {
  return useProject.getState().touched;
}

/**
 * 原稿ファイルで**本文だけ**を置き換える前の断り。(2026-09-23 レビューで発見)
 *
 * 本を丸ごと入れ替える断り(下の confirmReplaceBook)を使い回していたので、
 * 「原稿・設定・表紙・画像は、すべて消えます」と出ていた。実際に入れ替わるのは本文だけで、
 * 挿絵・背景・表紙・設定は残る(サンプルでなければ奥付と著者紹介も。setManuscript)。
 * 窓と画面の案内(「本文だけが入れ替わる」)が食い違わないよう、言うことを分ける。
 * 取り込みは履歴を畳むので、いまの本文は Ctrl+Z で戻せないことだけは必ず言う(［元に戻す］というボタンは無い)
 */
export function confirmReplaceManuscript(): boolean {
  if (!hasWorkToLose()) return true;
  // ［新規作成］で①の書名・著者名や②の作るものだけ入れた本には、まだ本文が無い。
  // 書名・著者名・設定・表紙・奥付は取り込んだあとも残る(handleFile・setManuscript)ので、失うものが無い(2026-10-09 全体確認)
  if (useProject.getState().manuscript.chapters.length === 0) return true;
  const keeps = useProject.getState().isSample
    ? '挿絵・背景・表紙・設定'
    : '挿絵・背景・表紙・設定・奥付と著者紹介';
  return window.confirm(
    '選んだ原稿ファイルで、本文を置き換えます。\n' +
      `${keeps}はそのまま残ります。\n` +
      '置き換えたあと、Ctrl+Z（Mac は ⌘+Z）で元の本文に戻すことはできません。念のため、先に［保存する］で控えを取っておくと安心です。\n\n' +
      '進めますか。',
  );
}

/**
 * 本を捨てて別のものに入れ替える前の断り。**入口3つが同じ文面を使う。**
 *
 * ここを通らない入口を作らないこと(前は「新規作成」と「サンプルを見る」に
 * 別々の文面が書かれ、「続けて作る」には何も無かった)。
 *
 * @param what 何をするのかの1行(「新しい本を始めます。」など)
 * @returns 進めてよければ true
 */
export function confirmReplaceBook(what: string): boolean {
  // まだ何も触っていない本(開いたばかりのサンプル)で窓を出すのは邪魔なだけ
  if (!hasWorkToLose()) return true;
  return window.confirm(
    `${what}\n` +
      'いま開いている本の原稿・設定・表紙・画像は、すべて消えます。\n' +
      '続きを作るつもりなら、先に［保存する］で控えを取ってください。\n\n' +
      '進めますか。',
  );
}

export const useProject = create<ProjectState>((set, get) => ({
  settings: defaultSettings(),
  // **はじめの1冊はサンプルなので、表紙もサンプルのものを立てておく。**
  // hydrate に保存が無ければこの状態のまま作業画面へ入る(絵は同期に決まるので、
  // loadSampleArt の非同期を待たなくてよい。表紙はプリセットの id を持つだけ)
  cover: sampleCover(),
  manuscript: sampleManuscript(),
  source: null,
  isSample: true,
  // 開いたばかりのサンプルは、まだ誰も何もしていない。捨てるときに窓は出さない
  touched: false,
  sampleEdited: false,
  loaded: false,
  isFirstRun: false,
  autosaveError: '',
  restoreFixes: [],
  past: [],
  future: [],

  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return null;
    set({
      settings: prev.settings,
      cover: prev.cover,
      manuscript: prev.manuscript,
      past: s.past.slice(0, -1),
      // いまの状態をやり直し側へ回す。**ここでも深いコピーは取らない**
      future: [
        ...s.future,
        { settings: s.settings, cover: s.cover, manuscript: s.manuscript, label: prev.label },
      ],
    });
    // 戻したところで束ねを打ち切る。次にいじったものが、戻す前の操作と
    // ひとまとまりに数えられないように
    lastKind = '';
    lastAt = 0;
    // **戻した状態も保存する。** 保存しないと、開き直したときだけ戻る前に返る
    scheduleSave(get());
    return prev.label;
  },

  redo: () => {
    const s = get();
    const next = s.future[s.future.length - 1];
    if (!next) return null;
    set({
      settings: next.settings,
      cover: next.cover,
      manuscript: next.manuscript,
      past: [
        ...s.past,
        { settings: s.settings, cover: s.cover, manuscript: s.manuscript, label: next.label },
      ],
      future: s.future.slice(0, -1),
    });
    lastKind = '';
    lastAt = 0;
    scheduleSave(get());
    return next.label;
  },

  setSettings: (patch) => {
    const keys = Object.keys(patch);
    // **機械が書き戻す値は積まない。** estimatedPages は組み上がった実ページ数を
    // App が書き戻しているだけで、人の操作ではない。積むと Ctrl+Z が
    // 「何も起きない1回」を消費し、しかも戻した直後にまた書き戻されて
    // やり直しの先(future)まで消える
    if (!(keys.length === 1 && keys[0] === 'estimatedPages')) {
      pushUndo(set, get, `settings:${keys.join(',')}`, changeLabel(keys, '本のかたち'));
    }
    const next = { ...get().settings, ...patch };
    // テーマを切り替えたら本文書体もそのテーマの既定に戻す
    // (明朝テーマのままゴシック本文が残る、といった食い違いを防ぐ)
    if (patch.theme && patch.theme !== get().settings.theme && !patch.bodyFont) {
      next.bodyFont = THEME_BODY_FONT[patch.theme];
    }
    // 出し先を「その他の印刷所」に切り替えたとき、印刷所の決まりがまだ無ければ既定を入れる
    // (2026-10-01。入れないと、印刷所を選んだのに塗り足しもノドも KDP の決まりのままになる)。
    // **切り替えの瞬間だけ。** もとから印刷所で決まりの無い古い保存は、ここを通らないので
    // KDP の決まりのまま(黙ってノドと用紙が変わらない。App の入稿前チェックが入れるよう促す)。
    // 入口の画面・OutputsChooser のどちらもここを通るので、そちらは直さずに済む
    if (
      patch.printTarget !== undefined &&
      usesOwnPrintRules(patch.printTarget) &&
      !usesOwnPrintRules(get().settings.printTarget) &&
      !next.printRules
    ) {
      next.printRules = { ...DEFAULT_PRINT_RULES };
    }
    set({ settings: next });
    scheduleSave(get());
  },

  setCover: (patch) => {
    const keys = Object.keys(patch);
    pushUndo(set, get, `cover:${keys.join(',')}`, changeLabel(keys, '表紙'));
    set({ cover: { ...get().cover, ...patch } });
    scheduleSave(get());
  },

  applyPreset: (trim, mode) => {
    // 判型と組み方向は文字サイズ・行送り・余白まで巻き添えで変える。
    // **戻せないと痛い操作**なので、続けて押されても1件ずつ積む
    pushUndo(set, get, `preset:${Date.now()}`, '判型と組み方向');
    const t = typographyDefaults(trim, mode);
    set({
      settings: {
        ...get().settings,
        trim,
        writingMode: mode,
        fontPt: t.fontPt,
        lineFeedPt: t.lineFeedPt,
        margins: t.margins,
        // 判型や組み方向を変えると段数の上限が下がることがある(横組みは1段)
        columns: Math.min(get().settings.columns || 1, maxColumns(trim, mode)),
      },
    });
    scheduleSave(get());
  },

  /**
   * 帯の［すべてリセット］。**押しても本当に何も起きていなかった。**
   * (2026-08-20 ユーザー報告「デザインする帯の『すべてリセット』を押しても反応がない」)
   *
   * もとは `applyPreset(いまの判型, いまの組み方向)` を呼ぶだけで、戻していたのは
   * **文字サイズ・行送り・余白の3つ**。帯に並ぶ9組のうち2組しか掛かっていなかった。
   *
   * 実測(2026-08-20・文庫縦組みのサンプル・1440×900)。帯を
   * 書体ゴシック / 11pt / 行送り20pt / 背景の濃さ70% / フチ太い / 帯しっかり /
   * 本文#cc0000・章見出し#0055aa・小見出し#118844 / 2段 / 大文字3行 に変えてから押すと:
   *
   * ```
   * 戻った   サイズ 11→9pt、行送り 20→15.5pt、余白(ノド 15.98→13.40mm)
   * 残った   書体・背景の濃さ・文字のフチ・本文の下の帯・文字の色3つ・段組み・章はじめの大文字
   * もう一度押す  変わった項目 0件・札も出ない → 画面上は完全に無反応
   * ```
   *
   * **サイズと行送りを触っていない人には、押しても1つも値が動かないボタン**だった。
   * さらに `applyPreset` を借りていたせいで、何も変わらない1回でも取り消しの控えが1つ積まれ、
   * Ctrl+Z の札に「『判型と組み方向』を元に戻しました」と、このボタンが触りもしない
   * 名前が出ていた(実測)。
   *
   * **直しは「帯に出ているものを、帯が向いている先ぶんだけ、全部戻す」。**
   * 判型・組み方向はここでは触らない(決めるのは［本のかたちを決める］で、
   * 見た目のリセットで判型が動いたら事故になる)。絵も消さない。
   * 押す前に window.confirm で範囲を言い、Ctrl+Z で戻せるようにしてある
   */
  resetDesign: (scope) => {
    const s = get();
    const d = defaultSettings();

    if (scope.kind === 'matter') {
      pushUndo(set, get, `resetDesign:${scope.key}`, '奥付・著者紹介の見た目のリセット');
      // MatterType は帯だけが書き込む入れもの。まるごと空に戻せば「本文と同じ」に戻る。
      // **奥付のページの背景の濃さ・フチも戻す。**(2026-10-09) 帯の奥付モードに出るようになったので、
      // 帯に出ているものを戻す約束どおり。奥付と著者紹介は同じページなので、どちらのリセットでも戻す。絵は残す
      const cbg = s.settings.colophonBg ? { ...s.settings.colophonBg } : undefined;
      if (cbg) {
        delete cbg.opacity;
        delete cbg.outline;
        delete cbg.outlineColor;
      }
      set({
        settings: {
          ...s.settings,
          [scope.key]: undefined,
          colophonBg: cbg && hasOwnBg(cbg) ? cbg : undefined,
        },
      });
      scheduleSave(get());
      return;
    }

    if (scope.kind === 'chapter') {
      pushUndo(set, get, `resetDesign:chapter${scope.index}`, 'この章のデザインのリセット');
      const next: ProjectSettings = { ...s.settings };
      for (const k of CHAPTER_DESIGN_KEYS) {
        const map = next[k];
        if (!map || next[k]?.[scope.index] === undefined) continue;
        const copy = { ...map };
        delete copy[scope.index];
        // 空になった Record は持たない(保存の中身が読みやすいのと、
        // 「指定あり」の印が空の入れもので立たないようにするため)
        next[k] = (Object.keys(copy).length ? copy : undefined) as never;
      }
      // 濃さ・フチだけを抜き、その章に敷いた絵は残す
      const bg = s.settings.chapterBg?.[scope.index];
      if (bg) {
        const spec = { ...bg };
        for (const k of CHAPTER_BG_DESIGN_KEYS) delete spec[k];
        const all = { ...(s.settings.chapterBg ?? {}) };
        if (Object.keys(spec).length) all[scope.index] = spec;
        else delete all[scope.index];
        next.chapterBg = Object.keys(all).length ? all : undefined;
      }
      set({ settings: next });
      scheduleSave(get());
      return;
    }

    pushUndo(set, get, 'resetDesign:book', 'デザインのリセット');
    // 文字サイズ・行送り・余白は判型ごとに正解が違うので、既定値ではなく判型の値から取る
    const t = typographyDefaults(s.settings.trim, s.settings.writingMode);
    const next: ProjectSettings = {
      ...s.settings,
      // テーマの既定書体へ。defaultSettings() の書体は「小説・明朝」テーマのものなので、
      // 実用書テーマの本をゴシックからいきなり明朝に振り替えてしまう
      bodyFont: THEME_BODY_FONT[s.settings.theme],
      fontPt: t.fontPt,
      lineFeedPt: t.lineFeedPt,
      margins: { ...t.margins },
      columns: 1,
      columnGapLines: d.columnGapLines,
      columnRule: undefined,
      dropCap: undefined,
      bgOpacity: d.bgOpacity,
      textOutline: d.textOutline,
      textOutlineColor: d.textOutlineColor,
      textPlate: d.textPlate,
      textPlateColor: d.textPlateColor,
      textColor: d.textColor,
      headingColor: undefined,
      subheadingColor: undefined,
      // **場面転換も戻す。**(2026-08-21 追加)
      // 帯に出ている以上、[すべてリセット]で戻らないと嘘になる。
      // 戻し先は「1行アキ」= アプリの既定であって、この本が前に使っていた見た目ではない
      sceneBreak: d.sceneBreak,
      // ノンブル・柱の書体も帯(本全体)に出るようになった(2026-10-09)。帯に出ている以上、ここで戻す
      nombreFont: undefined,
      runningHeadFont: undefined,
    };
    // **章ごとの上書きも消す。** 残すと「本全体を戻したのに誌面が変わらない」ことになり、
    // 直そうとした人が章を1つずつ開いて回る羽目になる(それを避けるためのボタン)
    for (const k of CHAPTER_DESIGN_KEYS) next[k] = undefined;
    if (s.settings.chapterBg) {
      const all: typeof s.settings.chapterBg = {};
      for (const [i, bg] of Object.entries(s.settings.chapterBg)) {
        const spec = { ...bg };
        for (const k of CHAPTER_BG_DESIGN_KEYS) delete spec[k];
        if (Object.keys(spec).length) all[Number(i)] = spec;
      }
      next.chapterBg = Object.keys(all).length ? all : undefined;
    }
    set({ settings: next });
    scheduleSave(get());
  },

  setManuscript: (ms, src) => {
    /**
     * **差し込みページを、新しい章の数に収め直す。**(2026-08-21)
     *
     * 挿絵もコラムも位置は「何章の前か」でしか持てないので、章の数が減ると
     * 範囲の外へ取り残され、**組版から黙って消える**(実測: 5章→2章の原稿を
     * 取り込むと 紙の挿絵 3→1枚 / 紙のコラム 2→1枚)。
     * ファイルを開く道(project/file.ts)は前から巻末へ寄せていたので、そちらへそろえる。
     * 動かしたことは呼び出し側が画面で言う
     */
    /**
     * **スタジオで章の途中に置いた絵を、新しい原稿の同じ段落のあとへ付け直す。**(2026-09-23)
     * 原稿ファイルには入っていない絵なので、何もしないと取り込み直すたびに消える。
     * 段落が見つからなかった絵は、その章の最後へ絵のまま移す
     */
    // **サンプルからは付け直さない。** サンプルの絵(千鳥・全面)もスタジオで置いた扱い
    // なので、自分の原稿へ持ち越すと他人の絵が自分の本に混ざる
    const carried = get().isSample
      ? { chapters: ms.chapters, kept: 0, moved: 0 }
      : carryStudioImages(get().manuscript.chapters, ms.chapters);
    // 奥付と著者紹介は残す(colophonOf)。サンプルからは持ち越さない — サンプルの ISBN や
    // 著者紹介が自分の本に混ざる(絵を付け直さないのと同じ理由)
    const colophon = get().isSample ? {} : colophonOf(get().manuscript);
    ms = { ...ms, ...colophon, chapters: carried.chapters };
    // 差し込みページと章ごとの指定は、同じ章についていく(並べ替え・追加・削除があっても)。
    // サンプルからは章の対応を取らない(サンプルの章に付けた指定を自分の本の章へ移さない)
    const { settings, fit: fitted } = get().isSample
      ? fitInsertsToChapters(get().settings, ms.chapters.length)
      : followChapters(
          get().settings,
          matchChapters(get().manuscript.chapters, ms.chapters),
          ms.chapters.length,
        );
    const fit: InsertFit = { ...fitted, imagesKept: carried.kept, imagesMoved: carried.moved };
    // 自分の原稿が入った時点でサンプルではなくなる(以降はバックアップを書く)
    // 自分の原稿が入ったら別の本になる。id を振り直して、
    // 前の本の JSON を読んだときに絵が混ざらないようにする
    set({
      manuscript: ms,
      isSample: false,
      settings: { ...settings, bookId: newBookId() },
      ...(src ? { source: src } : {}),
      // **取り込みは履歴を畳むので pushUndo を通らない。** ここで直に印を立てる
      touched: true,
      // 別の本になったので、前の本へ戻る道は畳む
      ...clearedHistory(),
    });
    void askPersist();
    scheduleSave(get());
    return fit;
  },

  patchManuscript: (patch, undoKey) => {
    const keys = Object.keys(patch);
    pushUndo(set, get, undoKey ?? `manuscript:${keys.join(',')}`, changeLabel(keys, '原稿'));
    set({
      manuscript: { ...get().manuscript, ...patch },
      // 章の途中の絵を足す・動かす・消しても、**サンプルはサンプルのまま。** 手を入れた印だけ
      // 立て、開き直したときに本文を差し替えないようにする(freshenSample)。isSample を落とすと、
      // サンプルに［直した原稿を取り込み直す］が出てしまう(2026-09-23 ユーザー報告)
      ...('chapters' in patch && get().isSample ? { sampleEdited: true } : {}),
    });
    scheduleSave(get());
  },

  reparse: async () => {
    const src = get().source;
    if (!src) return;
    const { manuscript: parsed } = await parseSource(src);
    const cur = get().manuscript;
    // 同じ本のまま本文だけ組み直す。**戻せる**(取り込み直しとは違って本は変わらない)
    pushUndo(set, get, `reparse:${Date.now()}`, '原稿の組み直し');
    // スタジオで置いた絵は原稿ファイルに無いので、組み直しでも付け直す(setManuscript と同じ)
    const carried = get().isSample
      ? { chapters: parsed.chapters, kept: 0, moved: 0 }
      : carryStudioImages(cur.chapters, parsed.chapters);
    // 取込処理を直すと章の数が変わることがある。ここでも差し込みページを収め直す
    const { settings, fit } = followChapters(
      get().settings,
      matchChapters(cur.chapters, parsed.chapters),
      parsed.chapters.length,
    );
    // 書名・著者・版元は画面で編集された値を優先する
    set({
      settings,
      manuscript: {
        ...parsed,
        // 奥付と著者紹介も画面のもの(原稿ファイルには無い欄。colophonOf)
        ...colophonOf(cur),
        chapters: carried.chapters,
        title: cur.title || parsed.title,
        author: cur.author,
        publisher: cur.publisher,
      },
    });
    scheduleSave(get());
    return { ...fit, imagesKept: carried.kept, imagesMoved: carried.moved };
  },

  startNewBook: () => {
    set({
      // bookId を振り直す。これが変わると、別の本の JSON を読んだときに
      // 手元の絵で埋め直されなくなる(project/file.ts の otherBook)
      settings: { ...defaultSettings(), bookId: newBookId() },
      cover: defaultCoverSettings(),
      manuscript: emptyManuscript(),
      // サンプルではないので、以降はバックアップも書く
      isSample: false,
      // 原稿ファイル・手を入れた印・戻る道。**入口3つで共通**
      ...replacedBookState(),
    });
    void askPersist();
    scheduleSave(get());
  },

  loadSample: async () => {
    const ms = sampleManuscript();
    set({
      settings: { ...defaultSettings(), bookId: newBookId() },
      cover: sampleCover(),
      manuscript: ms,
      isSample: true,
      // 原稿ファイル・手を入れた印・戻る道。**入口3つで共通**
      // (別の本(見本)になったので、前に作っていたものへは戻さない)
      ...replacedBookState(),
    });
    scheduleSave(get());
    await applySampleArt(set, get, ms.chapters.length);
  },

  replaceProject: (p) => {
    // hydrate と同じく既定値とマージする。古いファイルを読んでも項目の欠けで壊れない
    set({
      // **id はファイルのものを引き継ぐ。** 同じ本を開き直しただけなので、
      // ここで振り直すと次の AI 往復で絵が戻らなくなる。
      // 持っていない古いファイルには、この場で1つ与える
      settings: { ...defaultSettings(), ...p.settings, bookId: p.settings.bookId ?? newBookId() },
      // **書き出したファイルにも移し替えを掛ける。**(2026-08-22)
      // 既定値とのマージだけでは、型や持ち方が変わった項目は移らない。
      // 背文字の大きさを3つに分けたとき、ここを通さないと「1.2倍で保存した本を
      // 開き直すと著者名だけ既定(0.72)に戻る」が起きる
      cover: {
        ...defaultCoverSettings(),
        ...p.cover,
        ...migrateCoverSettings(p.cover as unknown as Record<string, unknown>),
      },
      manuscript: migrateManuscript(p.manuscript),
      isSample: false,
      // 読み込んだもので丸ごと入れ替わる。**読み込む前へは戻せない**
      // (同じ本を開き直しただけのこともあるが、中身は別物になりうる)
      ...replacedBookState(),
      /**
       * **読み込んだ本は「手を入れた本」として扱う。**(2026-09-25 見直し S1-4)
       * replacedBookState は「入れ替えた直後はまだ誰も触っていない」で touched を false にするが、
       * 読み込んだ本は利用者の作業そのもの。とくに AI 用 .json の往復のあとは、画像がこの端末の
       * 自動保存にしか無い(ファイルには入っていない)。false のままだと［新規作成］［サンプルを見る］
       * 別の読み込みが、断りなしにこの本を消していた
       */
      touched: true,
      // 取り込んだ原稿ファイルだけは、読み込んだファイルのものを引き継ぐ
      source: p.source ?? null,
    });
    void askPersist();
    scheduleSave(get());
    void upgradeSampleFigs(set, get);
  },

  hydrate: async () => {
    // 2つ目のタブなら自動保存を止める(相互上書き防止)。読み込みより先に張っておく
    claimSingleTabLock();
    try {
      const d = await db();
      const saved = (await d.get(STORE, 'current')) as Partial<Saved> | undefined;
      if (saved?.settings && saved?.manuscript) {
        // 既定値とマージする: 設定項目が増えても古い保存データが壊れない。
        // ただし背景は型そのものが変わった(文字列・真偽値 → BgSpec)ので、
        // マージだけでは移らない。migrateBgSettings で明示的に移し替える
        const merged = {
          settings: {
            ...defaultSettings(),
            ...saved.settings,
            ...migrateBgSettings(saved.settings as unknown as Record<string, unknown>),
            // この設定より前の保存には id が無い。ここで1つ与えておく
            bookId: saved.settings.bookId ?? newBookId(),
          },
          cover: {
            ...defaultCoverSettings(),
            ...saved.cover,
            ...migrateCoverSettings(saved.cover as unknown as Record<string, unknown>),
          },
          manuscript: freshenSample(
            migrateManuscript(saved.manuscript),
            saved.isSample ?? false,
            saved.sampleEdited ?? false,
          ),
          source: saved.source ?? null,
        };
        // 読めない値は既定へ戻す(戻す先は「いま開いている本」ではなく既定。まだ何も開いていない)。
        // 第3引数 true = 画像の置き場所の欠けを補わない(自動保存は丸ごと書くので、欠けは本当に無いもの)
        const { project: fixedP, fixed, removed, notices } = sanitize(
          merged,
          {
            settings: { ...defaultSettings(), bookId: merged.settings.bookId },
            cover: defaultCoverSettings(),
            manuscript: get().manuscript,
            source: null,
          },
          true,
        );
        set({
          settings: fixedP.settings,
          cover: fixedP.cover,
          manuscript: fixedP.manuscript,
          source: merged.source,
          restoreFixes: [
            ...(fixed.length ? [`読めない値を既定に戻しました：${fixed.join('・')}`] : []),
            ...(removed.length ? [`読めなかったので外しました：${removed.join('・')}`] : []),
            ...notices,
          ],
          // 目印が無い古い保存は false に倒す。取りこぼして1世代余計に書くほうが、
          // 本物の原稿のバックアップが止まるより害が小さい
          isSample: saved.isSample ?? false,
          // 印を持たない古い保存は「触ってある」に倒す。**訊きすぎるほうが安全** —
          // 訊かずに消すと戻せないが、余計に訊いても押し直せば済む
          touched: saved.touched ?? true,
          sampleEdited: saved.sampleEdited ?? false,
          loaded: true,
          // 前回の続きを開いたところ。**開く前へは戻せない**
          ...clearedHistory(),
        });
        void upgradeSampleFigs(set, get);
        return;
      }
      // **ここまで来たら「読めたが保存は無かった」=はじめての起動。**
      // 読み込みが例外で落ちた場合(catch)と区別する — サンプルの流し込みと
      // それに伴う自動保存は、保存が本当に無いと確認できたときだけ行う。
      // isFirstRun も同じ条件で立てる(入口画面の自動表示に使う)
      set({ loaded: true, isFirstRun: true });
      await applySampleArt(set, get, get().manuscript.chapters.length);
    } catch (e) {
      // **読めなかった。サンプルで上書きしない。**(2026-09-04 レビュー指摘)
      // レコードは無事かもしれないので、自動保存を止めてリロードを促す。
      // 画面自体は初期状態(サンプル)で出すが、書き込みは一切させない
      console.warn('restore failed', e);
      autosaveBlocked = true;
      set({
        loaded: true,
        autosaveError:
          '前回のデータを読み込めませんでした。上書きを避けるため、自動保存を止めています。' +
          '［保存する］で控えを取ってから、ページを再読み込みしてください。',
      });
      // 画面に出すのは初期状態のサンプルなので、千鳥だけは本物にしておく(自動保存は止まっているので書かない)
      void upgradeSampleFigs(set, get);
    }
  },
}));
