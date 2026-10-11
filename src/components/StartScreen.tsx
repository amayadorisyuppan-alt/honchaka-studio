// 入口画面。**「工程」ではない。**
//
// 初めて触った人に「01 がさっぱりわからなかった」と言われた(2026-08-18)。
// 原稿の出し入れは、見ながら微調整する他の工程と違って**分岐するだけの場所**なので、
// サイドバー+プレビューの型を使わず、画面いっぱいにアプリ名と大きな3択だけを出す。
// そのあと工程レールからも 01 を外し、原稿まわりはここが唯一の置き場になった(2026-08-19)。
//
// 2026-08-28、メニュー側を**ヒーロー型**に作り直した(デザイン案H)。
// 「トップが機能要素だけで、何をするものかビジュアルで分からない」というユーザーの
// 気づきが起点。**めくれる本(HeroBook)で成果物そのものを見せる。**
// 新規作成の手順(mode==='new')は従来の形のまま。
//
// 出す/出さないの判断(はじめての起動か、［最初の画面に戻る］が押されたか)は App が持つ。
//
// **読み込みの処理そのものはここに書かない。** 原稿の取込は App の隠し input、
// プロジェクトの読み込みは ProjectBar が唯一の実装を持つ。ここは開かせるだけ。

import { useEffect, useState } from 'react';
import { isSupported, type BackupState } from '../project/backup';
import { confirmReplaceBook } from '../store/useProject';
import { ThemeToggle } from './ThemeToggle';
import type { AboutSection } from './AboutPanel';
import type { ProjectSettings, SourceFile } from '../models/project';
import { OutputsChooser } from './OutputsChooser';
import { APP_URL, CONTACT_EMAIL, FEEDBACK_FORM_URL, NOTE_TIP_URL, TIP_URL, YOUTUBE_URL } from '../shop';
import { HeroBook } from './HeroBook';
import { NoticeBar } from './NoticeBar';
import { FrogPeek, StudioLogo } from './FrogMark';

/**
 * 「スタジオを応援する」のカードの縁で、カエルが言うひと言。**開くたびに1つ選ぶ。**
 *
 * トップの3枚のカードの文面は、**Gemini(Antigravity CLI)に見てもらってから入れた**
 * (2026-10-07 ユーザー「文章が英語直訳って感じ。Gemini を活用して」)。
 * 3.1 Pro と 3.8 Flash に同じ依頼を出し、Claude が事実を確かめて選んだ:
 * 使い方=Flash 案1・できた理由=Flash 案1・応援=Flash 案1 に Pro 案1 の「応援がなくても」を合わせた。
 * 文面を直すときも同じ手順で(依頼文の形は scratchpad に残らないので、要点: 事実を足さない・
 * 機能と引き換えにしない・急かさない・金額を書かない・大げさな言い方をしない)。
 * ひと言は Flash の2案と Pro の1案。
 * 入れたあと Flash にもう一度見せ、3か所の直し(「紙と電子の本」「時間の確保に」「雨やどりしながら」)を採った
 */
const FROG_LINES = [
  '雨やどりしながら、次の機能かんがえ中。',
  '新しい機能、連れてくるかも？',
  '新しい機能の葉っぱ、探してくるね',
] as const;

interface Props {
  /** サンプルを見ているだけか。「サンプルを見る」を押したときの確認要否に使う */
  isSample: boolean;
  /** 原稿ファイルを選ばせる(実体は App の隠し input。ここでは開くだけ) */
  onPickFile: () => void;
  /** プロジェクトの.jsonを選ばせる(実体は ProjectBar。ここでは開くだけ) */
  onLoadProject: () => void;
  /** ［続けて作る］で選んだ .json が読めなかった理由(トップバーが隠れているので、ここで言う) */
  loadError?: string;
  /** はじめて開いたときの状態(サンプル)に戻す */
  onLoadSample: () => Promise<void>;
  /**
   * まっさらな本を始める。原稿・設定・表紙・絵をすべて捨てる。
   * **これをやらないと、前の本の絵が新しい本に残る**(2026-08-19 ユーザー指摘)
   */
  onStartNew: () => void;
  /**
   * バックアップ先フォルダを選ぶ。choose() を直接ここで呼ばないのは、
   * トップバーの ProjectBar が許可状態を起動時に一度だけ調べて自分のuseStateに
   * 持っているため。ここで選んでも ProjectBar 側が古いままだと自動保存が
   * 始まらないので、選び終えたら App 側で ProjectBar を作り直させる
   */
  onChooseFolder: () => Promise<BackupState>;
  /** 何もせず閉じて、いままでの作業画面に戻る */
  onClose: () => void;
  /** 書名・著者名。**入口で入れてもらう**(ここで入れば 01 を開く用事がひとつ減る) */
  title: string;
  author: string;
  onTitle: (v: string) => void;
  onAuthor: (v: string) => void;
  /**
   * いまメニューか、新規作成の途中か。**持ち主は App。**App はトップバーの出し分けに使い、
   * トップバーの［最初の画面に戻る］で 'menu' に戻す。ここで別に持っていたら、
   * 新規作成の途中でそれを押してもトップバーが消えるだけで、画面は新規作成のままだった(2026-10-08)
   */
  mode: 'menu' | 'new';
  onModeChange: (mode: 'menu' | 'new') => void;
  /** いま入っている原稿。取り込んだ結果をここで確かめられるようにする */
  source: SourceFile | null;
  chapters: number;
  totalChars: number;
  /** 章が1つも取れていない(取込は成功しているが1本の長い原稿になっている) */
  noChapters: boolean;
  /**
   * 取込の失敗・通知。**入口画面のあいだ .main は hidden** なので、App 側の
   * エラー表示(サイドバー)は見えない。ここに渡して②の直下に出さないと、
   * 壊れた原稿を選んだ人が「押しても無反応」で詰まる(2026-09-04 レビュー指摘)
   */
  importError: string;
  notice: string;
  /** 取り込んだ原稿を、いまの取込処理でもう一度組み直す */
  onReparse: () => void;
  /**
   * 作るもの(紙・電子)と出し先。**新規作成の手順で最初に訊く**(2026-09-23 ユーザー要望
   * 「最初に新規製作をするときにも選べて、そこで選んだ人は…関連するものしか出ない」)
   */
  outputs: Pick<ProjectSettings, 'makePaper' | 'makeEbook' | 'printTarget' | 'epubTarget'>;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  /**
   * ［このアプリについて］を開く。節の名前を渡すと、そこまで送る。
   * **この画面のあいだトップバーは畳まれている**ので、ここから開けないと
   * 法人向けの話にも、作った理由にも、入口からは一生たどり着けない
   */
  onOpenAbout: (section?: AboutSection) => void;
  /**
   * ［ヘルプ］を開く。理由は onOpenAbout と同じ — トップバーが畳まれている
   * この画面から、使い方のまとめに届く道がほかに無い(2026-08-23 ユーザー指示)
   */
  onOpenHelp: () => void;
}

export function StartScreen({
  isSample,
  onPickFile,
  onLoadProject,
  loadError = '',
  onLoadSample,
  onChooseFolder,
  onClose,
  title,
  author,
  onTitle,
  onAuthor,
  mode,
  onModeChange: setMode,
  source,
  chapters,
  totalChars,
  noChapters,
  importError,
  notice,
  onReparse,
  outputs,
  setSettings,
  onStartNew,
  onOpenAbout,
  onOpenHelp,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Chrome / Edge だけの機能。無いブラウザでは選ぶボタンごと出さず、
  // 手動保存への案内だけを出す(保存先を必須にしないための分岐)
  const supported = isSupported();

  // Esc で閉じる。AboutPanel と同じ挙動に揃える
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleChoose() {
    setBusy(true);
    setError('');
    try {
      const state = await onChooseFolder();
      setFolder(state.folder);
    } catch (e) {
      // フォルダ選択の取り消しは失敗ではない(ProjectBar の run() と同じ扱い)
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * **押しても画面を閉じない。**
   *
   * 以前はファイル選択を開いた直後に閉じていたので、原稿を選ぶ前に作業画面へ
   * 飛ばされていた(取り消しても飛ばされる)。取り込んだ結果を確かめる場所を
   * この画面に置いた以上、閉じるのは利用者(2026-08-19 ユーザー指摘)。
   * 作業画面へは、下の［この本の作業に入る］から入る
   */
  /**
   * 新しい本を始める。**まっさらにしてから入る。**
   * 前の本の絵(挿絵・背景・表紙)が残っていると、数冊を並行して作るときに
   * 別の本の絵が紛れ込む(2026-08-19 ユーザー指摘)。
   *
   * **断りは3つのカードで同じもの**(`confirmReplaceBook`)。ここに文面を書かないこと。
   * 前は「新規作成」と「サンプルを見る」に別々の文面があり、しかも判定が `isSample`
   * だったので、**サンプルに絵を足した人には何も訊かずに消していた**
   * (2026-08-21 ユーザー報告「アラートがなく、データが展開」)
   */
  function handleNew() {
    if (!confirmReplaceBook('新しい本を始めます。')) return;
    onStartNew();
    setMode('new');
  }

  function handleImport() {
    onPickFile();
  }

  /**
   * 保存した .json を開く。**断りはファイルを選び終えてから**(App の onLoad)。
   * ここで先に訊くと、ファイル選びを取り消しただけの人にも訊いたことになる
   */
  function handleLoadProject() {
    onLoadProject();
  }

  async function handleViewSample() {
    // **サンプルを見ているだけかどうかでは決めない。**
    // サンプルに絵を足し、章の地を変え、表紙を組んでいる人がいる。
    // 手を入れたかどうかだけを見る
    if (!confirmReplaceBook('サンプルに切り替えます。')) return;
    /**
     * **いつでも読み直す。**(2026-08-20 ユーザー報告「新機能が見えない」)
     *
     * もとは「すでにサンプルを見ているなら何もしない」だった。だが
     * **アプリが新しくなってもサンプルが古いまま**になる。
     * サンプルは利用者の作りものではないので、作り直して失うものは無い
     */
    await onLoadSample();
    /**
     * **作業画面へ入る。**(2026-08-20 ユーザー報告「押しても反応がない」)
     *
     * 他のカードは押しても画面を閉じない — ファイルを選ぶ窓が開くので、
     * 選ばずに閉じた人がいきなり作業画面に放り出されないようにするため。
     * だがこのカードだけは「作業画面に入ります」と自分で言っており、
     * そのあとに何もすることが無い。**サンプルを見ているときは、
     * 押しても本当に何も起きなかった**(if の中でしか動いていなかった)
     */
    onClose();
  }

  // ── メニューと手順の両方で使う共通部品 ──────────────────────────

  /** 3つの入口カード。線画はバナー案Aと同じ筆致(2026-09-04 テイスト合わせ第2弾) */
  const menuCards = (
    <div className="start-menu">
      <button className="start-card" onClick={() => void handleNew()}>
        {/* まっさらな紙とペン */}
        <span className="start-card-art" aria-hidden="true">
          <svg width="44" height="40" viewBox="0 0 44 40" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 4 H26 L32 10 V36 H6 Z" />
            <path d="M26 4 V10 H32" />
            <path d="M39 14 L24 29 L22 34 L27 32 L42 17 Z" />
          </svg>
        </span>
        <span className="start-card-title">新規作成</span>
        <span className="start-card-desc">
          いまの本を<b>閉じて</b>、まっさらから新しい本を作ります
        </span>
      </button>
      <button className="start-card" onClick={handleLoadProject}>
        {/* しおりの挟まった開いた本 */}
        <span className="start-card-art" aria-hidden="true">
          <svg width="46" height="40" viewBox="0 0 46 40" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 10 Q14 4 4 6 V32 Q14 30 23 35 Q32 30 42 32 V6 Q32 4 23 10 Z" />
            <path d="M23 10 V35" />
            <path d="M31 6 V18 L34 15 L37 18 V6.5" />
          </svg>
        </span>
        <span className="start-card-title">続けて作る</span>
        <span className="start-card-desc">
          前に<b>保存した .json</b> を開いて、続きから作ります
        </span>
      </button>
      <button className="start-card" onClick={() => void handleViewSample()}>
        {/* めがねカエル(OGPと同じ顔) */}
        <span className="start-card-art" aria-hidden="true">
          <svg width="48" height="38" viewBox="0 0 54 42" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <ellipse cx="27" cy="31" rx="14" ry="10" />
            <circle cx="20" cy="19" r="6" />
            <circle cx="34" cy="19" r="6" />
            <path d="M26 19 H28" />
            <circle cx="20" cy="19.5" r="1.4" fill="currentColor" stroke="none" />
            <circle cx="34" cy="19.5" r="1.4" fill="currentColor" stroke="none" />
            <path d="M20 33 Q27 37 34 33" />
          </svg>
        </span>
        <span className="start-card-title">サンプルを見る</span>
        <span className="start-card-desc">サンプル原稿のまま、作業画面に入ります</span>
      </button>
    </div>
  );

  // いま何が開いているかと、作業画面へ入る道。**両方のモードで同じ場所に出す。**
  // 3つのカードはどれも画面を閉じないので、入る道はここ1つだけになる
  const currentBook = (
    <div className="start-current">
      <p className="start-current-book">
        いま開いている本
        <b>{title.trim() || '（書名がまだありません）'}</b>
        <small>
          {/* まっさらに始めた直後は source が無いが、サンプルでもない。3つを言い分ける。
              保存した .json・AI 用 .json・古い自動保存から開いた本も source を持たないので、
              章があるのに「原稿はまだありません」とは出さない(原稿の名前を省くだけ) */}
          {source
            ? `${source.name} / `
            : isSample
              ? 'サンプル原稿 / '
              : chapters === 0
                ? '原稿はまだありません / '
                : ''}
          {chapters} 章 /{' '}
          {totalChars.toLocaleString()} 字
        </small>
      </p>
      <button className="primary-action" onClick={onClose}>
        この本の作業に入る
      </button>
      {/* **直した原稿を、いまの本に入れ直す道。**(2026-09-23)
          もとは［本文に画像とコラムを入れる］の［文中に貼る］(Word 往復)の中にしか
          この入口が無かった。その面を撤去したので、原稿の出し入れを受け持つこの画面へ移す
          (README「原稿の出し入れは工程ではなく入口画面」)。
          サンプルと、原稿がまだ無い本には出さない — 前者は［新規作成］、後者は下の手順②が入口 */}
      {mode === 'menu' && !isSample && chapters > 0 && (
        <div className="start-reimport">
          <button className="ghost" onClick={onPickFile}>
            直した原稿を取り込み直す
          </button>
          <small>
            本文だけが入れ替わります。挿絵・背景・表紙・設定・奥付と著者紹介はそのまま残り、
            章の途中に入れた画像も同じ段落のあとへ付け直します
          </small>
          {importError && <p className="error">{importError}</p>}
          {notice && <p className="notice">{notice}</p>}
        </div>
      )}
    </div>
  );

  // ── シェアと、不具合・感想の受け口(2026-09-14 ユーザー要望) ──────────
  // 「本をつくりたい人たちに向けてシェアを強く推奨したい」— 広告を出していないので、
  // 使った人のシェアだけが次の利用者への道。band として目に入る形で置く。
  // 感想・不具合は「すべて読むが、お返事は基本しない」方針。その方針ごと正直に書く
  // (返事を待たせてから沈黙するより、先に言っておくほうが誠実)
  const [copied, setCopied] = useState(false);
  const shareText = '原稿を渡すだけで、紙の本と電子書籍のデータができる無料の本づくりサービス';
  const shareUrl =
    `https://x.com/intent/post?text=${encodeURIComponent(shareText)}` +
    `&url=${encodeURIComponent(APP_URL)}` +
    `&hashtags=${encodeURIComponent('ひっちゃか本づくりスタジオ')}`;
  const copyAppUrl = async () => {
    try {
      await navigator.clipboard.writeText(APP_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境では、せめて URL を見せる
      window.prompt('この URL をコピーしてください', APP_URL);
    }
  };
  const shareBox = (
    <div className="start-share">
      <p className="start-share-lede">
        <b>気に入ったら、本をつくりたい人にこのスタジオを教えてください。</b>
        広告を出していない小さな工房なので、みなさんのシェアがいちばんの力になります
      </p>
      <div className="start-share-actions">
        <a className="share-x" href={shareUrl} target="_blank" rel="noopener noreferrer">
          X でシェアする
        </a>
        <button className="share-copy" onClick={() => void copyAppUrl()}>
          {copied ? 'コピーしました ✓' : 'リンクをコピー'}
        </button>
        <button className="linklike" onClick={() => onOpenAbout('support')}>
          ブログやサイトに貼れるバナー
        </button>
      </div>
      <p className="start-share-fb">
        不具合を見つけたとき・感想を伝えたいときは、
        {FEEDBACK_FORM_URL ? (
          <a className="linklike" href={FEEDBACK_FORM_URL} target="_blank" rel="noopener noreferrer">
            報告・感想フォーム
          </a>
        ) : (
          <a className="linklike" href={`mailto:${CONTACT_EMAIL}`}>
            メール（{CONTACT_EMAIL}）
          </a>
        )}
        へ。X で <b>#ひっちゃか本づくりスタジオ</b> を付けてつぶやいてもらっても見つけられます。
        すべて読んでいますが、<b>お返事は基本できません</b>——ごめんなさい
      </p>
    </div>
  );

  // ── 使い方・なぜ作ったか・応援する の3枚(2026-10-06 ユーザー要望) ──────────
  // 「個人開発だから、投げ銭をもう少し大きめに入れてもいい。そういうことを伝えておくのもあり」。
  // 参考にしたのは個人開発の「ぐるりペイント」のページ: **応援を、ほかの入り口と同じ大きさのカードで並べる**・
  // 頼みごとは絵とひと言で軽く・「寄付しても特に何もない」と正直に言う。
  // 2026-09-02 に決めた誠実の中身(機能と引き換えにしない・急かさない・金額を言わない)はそのまま守る —
  // 「投げ銭をしてもしなくても、使える機能は同じ」をカードに書いて、引き換えにしないことを言葉にした。
  // 使い方動画はまだ本数が無いので、カードにはせず下の1行のまま(空の棚へ誘わない)
  const [frogLine] = useState(() => FROG_LINES[Math.floor(Math.random() * FROG_LINES.length)]);
  const linkCards = (
    <>
      <div className="start-menu start-links">
        <button className="start-card" onClick={onOpenHelp}>
          {/* 罫の入ったページと、しおり */}
          <span className="start-card-art" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 4 H32 V36 H8 Z" />
              <path d="M13 12 H27 M13 18 H27 M13 24 H22" />
              <path d="M26 4 V14 L29 11 L32 14" />
            </svg>
          </span>
          <span className="start-card-title">使い方を読む</span>
          {/* 文面は Gemini に見てもらった案(2026-10-07 ユーザー「英語直訳っぽい」。下の COPY のコメント参照) */}
          <span className="start-card-desc">
            原稿の整え方から入稿までの流れをまとめました。作業画面右上の［ヘルプ］からも同じものが読めます。
          </span>
        </button>
        <button className="start-card" onClick={() => onOpenAbout('why')}>
          {/* ランプの灯り(作った理由を話す夜) */}
          <span className="start-card-art" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16 Q12 6 20 6 Q28 6 28 16 L25 26 H15 Z" />
              <path d="M15 30 H25 M16 34 H24" />
              <path d="M20 12 V20" />
            </svg>
          </span>
          <span className="start-card-title">このスタジオができた理由</span>
          {/* 中身は［このアプリについて］の「なぜ作ったか」(作った人の一人称の話)。要約をここに書く */}
          <span className="start-card-desc">
            本を何十冊も作ってきた個人が、「原稿を渡すだけで紙と電子の本ができる場所」を自分で形にしました。
          </span>
        </button>
        {TIP_URL && (
          // **カードは <div>、押すのは中の丸いボタン。**(2026-10-07 ユーザー「トップのボタン、note用もほしい」)
          // OFUSE はログイン(Sozi ID)が要るので、note の決済でも送れるように入口を2つ並べる。
          // カードごと <a> にすると中にリンクを入れ子にできない
          <div className="start-card start-card-tip">
            {/* **カエルのひと言は、カードの上の縁に乗せる。**(2026-10-07 ユーザー
                「枠の縁に沿わすとか、本文とは違うんだなとわかる遊び心がもうちょいほしい」)
                カエルが縁から顔を出し、金茶の吹き出しが縁の線にまたがって座る。
                ひと言は開くたびに3つから選ぶ(Gemini の案から) */}
            <span className="tip-frog">
              <span className="tip-bubble">{frogLine}</span>
              <span aria-hidden="true">
                <FrogPeek width={44} mood="happy" />
              </span>
            </span>
            {/* 貯金箱(カエルは縁の上にいるので、絵は箱だけ) */}
            <span className="start-card-art" aria-hidden="true">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 16 H32 V34 Q32 36 30 36 H10 Q8 36 8 34 Z" />
                <path d="M16 21 H24" />
                <circle cx="20" cy="8" r="4.5" />
                <path d="M20 6 V10" />
              </svg>
            </span>
            <span className="start-card-title">スタジオを応援する</span>
            <span className="start-card-desc">
              ひとりで運営している個人開発のサイトです。いただいた応援は、サイトの維持費や、次の機能を作る時間の確保にあてています。
              応援がなくても、すべての機能を無料で使えます。
            </span>
            <span className="tip-actions">
              <a className="tip-btn" href={TIP_URL} target="_blank" rel="noopener noreferrer">
                OFUSE で応援する
              </a>
              {/* note の応援記事は URL が入ってから並べる(src/shop.ts の NOTE_TIP_URL)。金額は書かない */}
              {NOTE_TIP_URL && (
                <a className="tip-btn" href={NOTE_TIP_URL} target="_blank" rel="noopener noreferrer">
                  note で応援する
                </a>
              )}
            </span>
          </div>
        )}
      </div>
    </>
  );

  // **一行だけ。**(2026-08-22 深夜 ユーザー指示「トップからは一行リンクで」)
  // この画面のあいだトップバーは畳まれているので、［このアプリについて］と
  // ［ヘルプ］への道がここにしか無い。法人向けの話は行き止まりにしないよう、
  // 節を名指しで開く。YouTube は使い方動画の置き場(2026-08-23 ユーザー指示)。
  // 投げ銭はその上に1行(2026-09-02 ユーザー要望「さらっと、誠実な感じで」)。
  // 機能と引き換えにしない・急かさない・金額を言わない、が誠実の中身。
  // **トップ(ヒーロー型)では、投げ銭の1行は上の linkCards のカードに置き換わる**(heroed)。
  // 新規作成の手順の画面には linkCards を出さないので、1行のまま残す
  const footLinks = (heroed: boolean) => (
    <>
      {TIP_URL && !heroed && (
        <p className="start-tip">
          このスタジオは、これからも無料です。もし作った本が形になって、
          応援したいなと思ったら——
          <a className="linklike" href={TIP_URL} target="_blank" rel="noopener noreferrer">
            投げ銭（OFUSE）
          </a>
          {/* note の応援記事は URL が入ってから並べる(src/shop.ts の NOTE_TIP_URL)。金額は書かない */}
          {NOTE_TIP_URL && (
            <>
              や
              <a className="linklike" href={NOTE_TIP_URL} target="_blank" rel="noopener noreferrer">
                note の応援記事
              </a>
            </>
          )}
          で制作を支えられます。
        </p>
      )}
      <p className="start-foot">
      {/* トップでは［使い方を読む］のカードがあるので、1行には出さない */}
      {!heroed && (
        <>
          <button className="linklike" onClick={onOpenHelp}>
            使い方
          </button>
          <span aria-hidden="true"> ・ </span>
        </>
      )}
      <a className="linklike" href={YOUTUBE_URL} target="_blank" rel="noopener noreferrer">
        使い方動画（YouTube）
      </a>
      <span aria-hidden="true"> ・ </span>
      <button className="linklike" onClick={() => onOpenAbout()}>
        このアプリについて
      </button>
      <span aria-hidden="true"> ・ </span>
      <button className="linklike" onClick={() => onOpenAbout('business')}>
        法人の方へ（自社サービスへの組み込み）
      </button>
      </p>
    </>
  );

  // ── メニュー(ヒーロー型) ─────────────────────────────────────
  if (mode === 'menu') {
    return (
      <div className="start-screen start-heroed">
        {/* オーロラ。光の玉3つを CSS で漂わせる(reduced-motion では止まる) */}
        <div className="hero-blobs" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>

        {/* 版元の署名つきヘッダー。×ボタンの役は［スタジオで本をつくる］が兼ねる。
            ロゴは40pxでは蓮の葉が読めなかった(2026-09-02「小さすぎる」)ので大きめに */}
        <header className="hero-top">
          {/* 見出しはロゴ「本ちゃか」(2026-10-07)。前は版元のロゴ(あまやどり出版)+明朝の題字 */}
          <div className="hero-name">
            <StudioLogo height={56} by />
          </div>
          <div className="hero-top-actions">
            {/* **入口にも画面の色を置く。** トップバーはこの画面では畳まれているので、
                ここに無いと「まぶしい」と思ったいちばん最初の瞬間に手が届かない */}
            <ThemeToggle />
            <button className="hero-ghost" onClick={handleLoadProject}>
              保存した .json を開く
            </button>
            {/* 「書く」ではなく「本をつくる」— このアプリの動詞(2026-08-28 ユーザー指摘) */}
            <button className="hero-cta" onClick={onClose}>
              スタジオで本をつくる　↗
            </button>
          </div>
        </header>

        {/* お知らせ欄(notice.json)。不具合の回り道など、最初に目に入ってほしいものなのでヘッダーのすぐ下 */}
        <NoticeBar className="hero" />

        <div className="hero-body">
          <span className="hero-flag">
            <i aria-hidden="true" />
            本をめくって仕上がりを体験
          </span>
          <h1 className="hero-h1">原稿を、手触りのある一冊に。</h1>
          <p className="hero-en" aria-hidden="true">
            Turn your words into a real book.
          </p>
          {/* Amazon対応はここで一度だけ言う。あとの工程で KDP が連呼される前に
              「何のことか」を先に知らせる(2026-09-02 ユーザー指摘)。
              同日v2: 「合う形」では弱い —「とくにAmazonに合わせて作り込んである」が伝わる文に */}
          <p className="hero-lede">
            <b>だれでも気軽に本をつくれるように</b>と作った、無料のサービスです。
            書き上げた原稿を、そのまま紙の本と電子書籍の形にします。
            とくに<b>Amazonでの出版（Kindle と紙の本＝出版サービス〈KDP〉）に合わせて作り込んであり</b>、
            判型・背幅・塗り足しまで、入稿でそのまま使える形で書き出します。
          </p>
          {/* **効くところだけを札で出す。** 5つを超えたら、どれも見られなくなる */}
          <ul className="start-badges">
            <li>縦書き・横書き</li>
            <li>紙の本・電子書籍</li>
            <li>無料</li>
            <li>原稿は Word・テキスト・Markdown</li>
            <li title="原稿も画像もブラウザの中だけで扱います。書き出したファイルはどこで出版しても構いません">
              データは自分のもの
            </li>
          </ul>

          {/* 本物のサンプルを表紙から奥付までめくれる(public/hero が無ければ出ない)。
              「これが何か」を本のすぐ上で言う(2026-09-02「開かせるナビゲーションがほしい」) */}
          <p className="hero-booknav">
            これは、このスタジオが実際に組んだ<b>サンプル本</b>です。
            表紙から奥付まで、めくって仕上がりをたしかめられます。
          </p>
          <HeroBook onEnter={onClose} />

          <p className="start-lede hero-begin">まずはどこから始めますか。</p>
          {menuCards}
          {loadError && (
            <p className="error" role="alert">
              読み込みに失敗しました。{loadError}。もう一度ファイルを選んでください。
            </p>
          )}
          {currentBook}
          {shareBox}
          {linkCards}
          {footLinks(true)}
        </div>
      </div>
    );
  }

  // ── 新規作成の手順(従来の形のまま) ───────────────────────────
  return (
    <div className="start-screen">
      <div className="start-theme">
        <ThemeToggle />
      </div>
      <button className="start-close" aria-label="閉じる" onClick={onClose}>
        ×
      </button>
      <div className="start-inner">
        {/* 題字に本棚(リンクバナー案Aと同じ印) */}
        <h1 className="start-title">
          <StudioLogo height={48} />
        </h1>
        <div className="start-new">
          {/* 入口で書名と著者名を入れてもらう。大扉・奥付・表紙・電子書籍の書誌に効くので、
              いちばん最初に決まっていたほうが以降の画面が意味を持つ */}
          <div className="start-step">
            <p className="start-step-title">① 本の名前</p>
            <label className="stack">
              書名
              <input
                value={title}
                placeholder="はじめての本"
                onChange={(e) => onTitle(e.target.value)}
              />
            </label>
            <label className="stack">
              著者名
              <input
                value={author}
                placeholder="山田花子"
                onChange={(e) => onAuthor(e.target.value)}
              />
            </label>
            <p className="start-step-desc">
              大扉・奥付・表紙・電子書籍の書誌に使います。あとから変えられます
            </p>
          </div>

          {/* **作るものは原稿より先に訊く。** ここで選んだものに関係する欄だけが、
              この先のすべての画面に出る(紙を作らなければ背や表4の話は出ない)。
              あとから［本のかたちを決める］と［完成データを書き出す］の先頭で変えられる */}
          <div className="start-step">
            <p className="start-step-title">② 作るもの</p>
            <OutputsChooser settings={outputs} setSettings={setSettings} showHints={false} />
          </div>

          <div className="start-step">
            <p className="start-step-title">③ 原稿を取り込む</p>
            <p className="start-step-desc">
              .txt / .md / .docx が読めます。Pages や Google ドキュメントで書いた原稿は、
              Word 形式（.docx）で書き出してから入れてください
            </p>
            <button className="primary-action" onClick={handleImport}>
              原稿を取り込む
            </button>

            {/* 取込の失敗・通知は**この画面にも出す**。App のサイドバー表示は
                入口のあいだ hidden で見えない(2026-09-04 レビュー指摘) */}
            {importError && <p className="error">{importError}</p>}
            {notice && <p className="notice">{notice}</p>}

            {noChapters && (
              <p className="warn">
                <b>章に分かれていません。</b>
                章にしたい行は「第一章」「プロローグ」のように書くか、行頭に <b>#&nbsp;</b>
                を付けてください（.docx なら見出し1）
              </p>
            )}
            {/* 書き方そのものは［ヘルプ］に置いた。ここに畳んで入れていたが、
                この画面は本を作り始めたら通らないので、書いている最中に見返せない
                (2026-08-19 ユーザー指摘) */}
            <p className="start-step-desc">
              章と小見出しの付け方は、画面右上の<b>［ヘルプ］</b>にあります
            </p>
            {source && (
              <button
                className="ghost"
                title="取り込んだ原稿を、現在の取り込み処理でもう一度組み直します"
                onClick={onReparse}
              >
                原稿を組み直す
              </button>
            )}
          </div>

          {/* **保存の話はここが本番。** どのブラウザでも動く手動保存を先に言い切る。
              自動保存は Chrome / Edge だけの上乗せなので、そのあとに回す
              (順序を逆にすると、非対応ブラウザの人には否定文が先に目に入る) */}
          <div className="start-step start-step-save">
            <p className="start-step-title">④ 作ったものの残しかた</p>
            <p className="start-step-desc">
              画面の上の<b>［保存する］</b>を押すと、本のデータが <b>.json</b> ファイルとして
              手元に保存されます。<b>次に開くときは［続けて作る］でそのファイルを選べば、
              続きから作れます。</b>こまめに押してください
            </p>
            {supported ? (
              <>
                <p className="start-step-desc">
                  <b>Chrome / Edge なら自動でも残せます。</b>画面の上の
                  <b>［フォルダを決める］</b>で .json の置き場所を1度決めておくと、
                  変更のたびに自動で控えが残ります
                </p>
                <button className="ghost" disabled={busy} onClick={() => void handleChoose()}>
                  {folder ? `フォルダを決め直す（いま: ${folder}）` : 'フォルダを決める'}
                </button>
                {error && <p className="error">{error}</p>}
              </>
            ) : (
              <p className="start-step-desc">
                なお<b>自動保存はこのブラウザでは動きません</b>（Chrome / Edge のみ）。
                上の［保存する］で残してください
              </p>
            )}
          </div>
        </div>

        {currentBook}

        {/* **［戻る］は「いま開いている本」より後ろ。** 前に置いていたら
            「いま開いている本に戻る」ボタンだと読まれた(2026-08-19 ユーザー報告) */}
        <button className="ghost start-back" onClick={() => setMode('menu')}>
          ← 最初の画面に戻って選び直す
        </button>

        {footLinks(false)}
      </div>
    </div>
  );
}
