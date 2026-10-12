// 04 書き出し。出来上がるファイルと、その前の確認をここに集める。
//
// 以前はトップバーの右端に本文の3つ、表紙タブに切り替えると表紙の2つ、という出し分けだった。
// 「表紙タブなのに本文が出る」という混乱を避けるための作りだったが、
// ステップになったので**出来上がるものを1か所に並べられる**。
//
// **表紙は押す前に見せる。** ここに来るまでに表紙ステップを開いているとは限らず、
// 何が出るのか分からないままダウンロードが始まるのは落ち着かない。
//
// **入稿前チェックは新しい検査を書かない。** 判定はどれも各ステップが既に持っているもので、
// ここは**散らばっている警告を1か所に集めるだけ**。

import { Fragment, type ReactNode } from 'react';
import {
  EPUB_TARGETS,
  PRINT_TARGETS,
  bindingOf,
  bleedOf,
  outputsOf,
  saddleCoverOf,
  type EpubTarget,
  type ProjectSettings,
} from '../../models/project';
import { HELP_EPUB_DIFF } from '../../help/content';
import { NOTE_TIP_URL, TIP_URL } from '../../shop';
import { FrogPeek } from '../FrogMark';
import { OutputsChooser } from '../OutputsChooser';
import { PaperBodyExport } from '../PaperBodyExport';
import { PressCover, type CoverPdfOptions, type CoverPdfOutcome } from '../PressCover';
import type { BodyBoxes } from '../../press/types';

/**
 * 直したほうがよいところ。**無いときは1行も出さない。**
 * 「章が10つに分かれています」のような、自分で入れた原稿の読み上げは置かない。
 * 本人がいちばん知っていることで、並べるほど直すべき行が埋もれる
 */
export interface Problem {
  text: string;
  /** 直しに行く先 */
  goto: { label: string; run: () => void };
}

/**
 * KDP の入稿画面で**利用者が自分で選ぶ・入れる値**。
 *
 * こちらがどれだけ正しく書き出しても、あちらで選び間違えると版面が狂う。
 * 入稿のときに見返せるよう、必要な値をここに1か所へまとめておく
 * (2026-08-17 ユーザーの依頼「KDPで入稿するときに入れるべきテクニカルな内容が
 * ここでひとまとまりになっていれば、あとで困らない」)。
 */
export interface Spec {
  /** KDP の画面での項目名に寄せる */
  label: string;
  value: string;
  note?: string;
  /**
   * 値を変えるための操作。**アプリ側で言い切れない項目にだけ付ける。**
   * いまは AI 生成コンテンツだけ — 利用者が自分で AI に描かせた絵や
   * 書かせた文章を持ち込んだ場合、こちらからは判別しようがない
   */
  control?: ReactNode;
  /**
   * 電子書籍の出し先で答える行。紙も作る本では、紙の控えとは見出しを分けて下に出す
   * (紙の出し先が訊かない AI 生成コンテンツの申告を、紙の発注書の控えに混ぜないため。2026-10-07)
   */
  ebook?: boolean;
  /**
   * 見出しを分けて出す行のまとまり(2026-10-12)。ふつうの行のあとに、見出しごとにまとめて出す。
   * 発注書の項目どおりに組む控え(PrintTargetProfile.orderSheet)が、発注書に書く欄の無い値を分けるのに使う
   */
  section?: string;
}

interface Props {
  exporting: boolean;
  printing: boolean;
  problems: Problem[];
  specs: Spec[];
  /**
   * 作るもの(紙・電子)と出し先。**ここで選んだものに関係するカードと控えだけを出す。**
   * (2026-09-23 ユーザー要望「入稿の最初で選択ができて、それ以降は関連するものしか出ない」)。
   * もとは電子の出し先だけを［電子書籍の本文］の中で選ばせていた
   */
  outputs: Pick<
    ProjectSettings,
    'makePaper' | 'makeEbook' | 'printTarget' | 'printRules' | 'epubTarget' | 'binding' | 'saddleCover'
  >;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  /**
   * 入口で作るものの欄を開いているか。**App が持つ。** この画面は App の中で2か所
   * (サイドバーと、電子書籍の本文の全画面)に出るので、［出し先を変える］で全画面から
   * 入口へ戻ったとき、開いたまま渡すには上で持つしかない
   */
  choosingOutputs: boolean;
  onChoosingOutputs: (open: boolean) => void;
  /**
   * 電子書籍の色(白黒か)。**選ぶのは［本のかたちを決める］。**(2026-09-24 ユーザー要望
   * 「紙と同じように、電子書籍も白黒かカラーかを選んだ状態で版下を作れた方がいい」)
   * ここでは何色で書き出すかを言うだけ。掛かるのは `figure.fig img, .plate img` だけで、表紙には掛からない
   */
  ebookMono: boolean;
  /**
   * わざと空けた白ページ(クッションページ)の枚数。
   *
   * **EPUB には入らないので、入る前に断る。**(2026-08-20 ユーザーの確認
   * 「電子書籍だけ黙って削除とかしないよね？」)
   * 電子書籍にはページという区切りが無く、1画面に何が入るかは読む人の
   * 画面と文字の大きさで決まるので、白ページを1つ足しても「白い1画面」にはならない。
   * 消しているのは事実なので、**黙って消さない**(空の挿絵・空のコラムと同じ作法)。
   *
   * **消すボタンは置かない。**(2026-08-20 ユーザー判断で撤回)
   * 一度は「ここで消せる」を作ったが、元データは紙と電子で1つなので
   * **紙の PDF からも消えてページ数が変わる**。白ページは奇数ページ起こしや
   * 見開きの向かい合わせのために置いた紙のためのページなので、
   * 電子の都合で紙を崩すのは筋が悪い。断るだけにする
   */
  blankPlates: number;
  onPrintPdf: () => Promise<boolean> | void;
  onExportEpub: () => void;
  /**
   * 紙の表紙の PDF を保存する。**印刷所なら入稿用(CMYK・PDF/X-4)に変えるまでを1回で**(CoverEditor.exportPaperPdf)。
   * 何を保存したかを返すので、できあがりの報告はこの画面(PressCover)が出す
   */
  onExportCoverPdf: (opts: CoverPdfOptions) => Promise<CoverPdfOutcome | null>;
  onExportCoverJpeg: () => void;
  /**
   * 表紙の見本。**描くのは App。**
   * 右の大きなプレビューにも同じ絵を出すので、描画を2か所に持てない
   * (紙の表紙を選んでいるのにプレビューが本文のままだった。2026-08-19 ユーザー指摘)
   */
  covers: { paper: string; ebook: string } | null;
  /** 見本づくりが失敗したか。true なら「作っています…」ではなく案内に切り替える */
  coverShotsFailed: boolean;
  onGoToCover: () => void;
  /** いま何を書き出そうとしているか。null なら選ぶ画面。**App が持つ**(プレビューの出し分けに使う) */
  target: ExportTarget | null;
  onTarget: (t: ExportTarget | null) => void;
  /**
   * 本文のページ数がまだ確定していない(組版中)。**紙の表紙は背幅がページ数で決まる**ので、
   * 数え終わる前に書き出すと概算の背幅で刷ってしまう(2026-09-04 レビュー指摘)。
   * 電子書籍の表紙は表1のみで背に依存しないため、こちらは待たせない
   */
  coverSpinePending: boolean;
  /**
   * 紙の表紙の背幅が、印刷所から知らされた数字か(目安のままなら false)。入稿が2回に分かれる会社
   * (PRINT_TARGETS の coverAfterSpineNote)で、目安のまま表紙を書き出そうとしているときに一言添える
   */
  coverSpineFromPrinter?: boolean;
  /**
   * 本文の下見を開く(紙/電子)。**本のかたちの工程へ移り、その下見を出す。**
   * 下見の上に［← 書き出しに戻る］が出る(2026-09-24 ユーザー決定「どちらもボタンで下見へ飛ぶ形に
   * そろえる」)。書き出しの画面の中に下見を置くと、紙は見開きのまま・電子は置き場が無い、と
   * 2つの画面で振る舞いが食い違っていた
   */
  onOpenBodyPreview: (mode: 'paper' | 'ebook') => void;
  /** 紙の本文のページ数。**いまの本の姿で組み上がっているときだけ**数、まだなら null */
  paperPages: number | null;
  /**
   * 紙の本文の主ボタンを押せない理由(あれば。中綴じの「ページ数が 4 の倍数にそろっていない」など。App が決める。2026-10-03)。
   * 押せなくして、この文を出す(PaperBodyExport → printBlockedReason)
   */
  blockReason?: string | null;
  /**
   * 紙の刷り色。［紙の本文］の入稿用の変換が、白黒なら K1色、カラーなら CMYK になる。
   * **変換の欄は、保存した RGB の PDF を受け付けない出し先(その他の印刷所など)には必ず出す**
   * (2026-10-01。KDP は RGB のまま受け付けるので、**白黒の本にだけ任意の道として**出す(2026-10-02。
   * カラーの KDP には出さない。2026-09-23「自分に該当するものだけしか出てこない」)
   */
  ink: 'mono' | 'color';
  /** 書名。入稿用にした PDF のファイル名に使う */
  bookTitle: string;
  /** 用紙(仕上がり＋塗り足し)の寸法 mm。入稿用にするとき、別の本の PDF を選んでいないかを見る */
  paperMm: { w: number; h: number };
  /** 本文の箱(仕上がり・塗り足し・1ページ目のノド)。入稿用の PDF/X の TrimBox に使う */
  boxes: BodyBoxes;
  /** 入稿用の変換で数えたカラーのページの数(終わっていなければ null)。App が控え(specs)の⑩に使う(2026-10-12) */
  onColorPages?: (r: { count: number; total: number } | null) => void;
}

/**
 * 07 で書き出せるもの。**1つずつ選んで片づける形にする。**
 *
 * 以前は本文2つと表紙2つのボタンが説明文と一緒に縦に並んでいて、
 * どれを押せばよいのか、いま何の話をしているのかが読めなかった(2026-08-18 の作り直し)。
 * KDP の入稿画面でも本文と表紙は別の欄なので、まとまりをそちらに合わせる。
 */
export type ExportTarget = 'paperBody' | 'ebookBody' | 'paperCover' | 'ebookCover';
/** 本文と表紙は KDP でも別の欄。**色で見分けられるようにする**(2026-08-19) */
type ExportKind = 'body' | 'cover';
/**
 * **紙の本と電子書籍の、2本の柱で立てる。**(2026-09-04 外部レビュー
 * 「4つ固まっているとわかりにくい」)。以前は本文2つ→表紙2つの並び(KDPの入稿欄合わせ)
 * だったが、利用者の頭は「紙を出すのか・電子を出すのか」が先。
 * 柱=出す本の形、カードの札(本文/表紙)=KDP の入稿欄、と役目を分けた
 */
type ExportGroup = {
  /** 柱の色分け(app.css の .export-pillar.paper / .ebook)に使う */
  id: 'paper' | 'ebook';
  /** 頭の色札に入れる短い字。「紙」「電子」だけで柱の性格を言う */
  mark: string;
  title: string;
  /** どこへ行くデータか。見出しの文字だけでは紙/電子の区別が
   * ぱっと見で付かなかった(2026-09-11 ユーザー指摘)ので、
   * 柱を色付きの箱にした上で、行き先も一言添える */
  sub: string;
  items: [ExportTarget, ExportKind, string, string][];
};

/**
 * **作るものと出し先で、柱もカードも絞る。**(2026-09-23 ユーザー要望
 * 「自分に該当するものだけしか出てこない」)
 *
 * - 作らないほうの柱は出さない
 * - 電子の表紙(JPEG)は **KDP に出すときだけ**。楽天Kobo などは EPUB の中に表紙が入るので、
 *   この1枚は要らない(以前から「要らない」とコメントにありながら、いつも出していた)
 * - 柱の添え書きは、選んだ出し先の名前で言う(「KDP・印刷所むけ」のような両論併記をやめる)
 */
export function exportGroups(o: Props['outputs']): ExportGroup[] {
  const out = outputsOf(o);
  const groups: ExportGroup[] = [];
  if (out.paper) {
    groups.push({
      id: 'paper',
      mark: '紙',
      title: '紙書籍',
      sub: `印刷して綴じる本。出し先は ${PRINT_TARGETS[o.printTarget].label}`,
      /* **カードの名前は「本文」「表紙」だけ。**(2026-09-14 ユーザー指摘
         「見出しに紙書籍・電子書籍とあるから、『紙の本文』といった見出しはいらない」)。
         紙/電子は柱の見出しが言っているので、カードでは繰り返さない。
         選んだ先の画面の見出しには柱が無いので、そちらはフルネーム(EXPORT_LABEL) */
      // 中綴じ(2026-10-03): 別表紙は背なしの1枚。**共紙は表紙のカードを出さない**(表1・表4 は本文 PDF の先頭と末尾に入る)
      items:
        bindingOf(o) === 'saddle'
          ? saddleCoverOf(o) === 'self'
            ? [['paperBody', 'body', '本文', 'PDF。表紙の4ページも入ります（印刷ダイアログから保存します）']]
            : [
                ['paperBody', 'body', '本文', 'PDF。印刷ダイアログから保存します'],
                ['paperCover', 'cover', '表紙', 'PDF。表4と表1を背なしでつないだ1枚'],
              ]
          : [
              ['paperBody', 'body', '本文', 'PDF。印刷ダイアログから保存します'],
              ['paperCover', 'cover', '表紙', 'PDF。表4・背・表1がつながった1枚'],
            ],
    });
  }
  if (out.ebook) {
    const kdp = o.epubTarget === 'kdp';
    const items: [ExportTarget, ExportKind, string, string][] = [
      [
        'ebookBody',
        'body',
        '本文',
        kdp ? 'EPUB。表紙のページは作らず、別の JPEG 画像で渡します' : 'EPUB。1ページ目に表紙まで入ります',
      ],
    ];
    if (kdp) items.push(['ebookCover', 'cover', '表紙', 'JPEG。表1だけの1枚']);
    groups.push({
      id: 'ebook',
      mark: '電子',
      title: '電子書籍',
      sub: `画面で読む本。出し先は ${EPUB_TARGETS[o.epubTarget].label}`,
      items,
    });
  }
  return groups;
}

/** その出し先・作るもので選べるカードか(選んでいたカードが消えたら選ぶ画面へ戻すのに使う) */
export function exportTargetAvailable(t: ExportTarget, o: Props['outputs']): boolean {
  return exportGroups(o).some((g) => g.items.some(([id]) => id === t));
}

/**
 * EPUB の出し先を、**お店の名前ではなく「何が入るか」で見出す。**(2026-08-21 ユーザーの言
 * 「EPUB の出し先は2つに分かれる。表紙まで同梱、本文だけ。プラットフォームによって
 * ここも異なる。代表例は入れておくけど、あとは自分で確認して」)
 *
 * 選んでいるのは本当は**ファイルの作り**のほうで、店名はその代表例でしかない。
 * 店名だけを出していると「この2つ以外の店には出せない」と読める
 */
const EPUB_TARGET_KIND: Record<EpubTarget, string> = {
  kdp: '本文だけ',
  reader: '表紙まで同梱',
};
/** 選んだ先の画面の見出し。柱(紙書籍/電子書籍)が見えない場所なので、こちらはフルネーム */
const EXPORT_LABEL: Record<ExportTarget, string> = {
  paperBody: '紙の本文',
  paperCover: '紙の表紙',
  ebookBody: '電子書籍の本文',
  ebookCover: '電子書籍の表紙（KDP用）',
};

export function ExportStep({
  exporting,
  printing,
  problems,
  specs,
  outputs,
  setSettings,
  choosingOutputs: choosing,
  onChoosingOutputs: setChoosing,
  ebookMono,
  blankPlates,
  onPrintPdf,
  onExportEpub,
  onExportCoverPdf,
  onExportCoverJpeg,
  covers,
  coverShotsFailed,
  onGoToCover,
  target,
  onTarget,
  coverSpinePending,
  coverSpineFromPrinter = false,
  onOpenBodyPreview,
  paperPages,
  blockReason,
  ink,
  bookTitle,
  paperMm,
  boxes,
  onColorPages,
}: Props) {
  const epubTarget = outputs.epubTarget;
  const out = outputsOf(outputs);
  const printProfile = PRINT_TARGETS[outputs.printTarget];
  /**
   * 右の控えの見出しと前置き。**紙を作るなら紙の出し先の言い方**(KDP の入稿画面・印刷所の注文画面)。
   * 電子だけなら、電子の出し先の言い方にする
   */
  const ebookHead =
    epubTarget === 'kdp'
      ? {
          title: 'KDP の入稿画面で答える値',
          lead: 'Amazon KDP に電子書籍を入稿するとき、あちらの画面で答える値です。',
        }
      : {
          title: '出版先で答える値',
          lead: '電子書籍を出すお店の入稿画面で、聞かれたら答える値です。',
        };
  const specsHead = out.paper ? { title: printProfile.specsTitle, lead: printProfile.specsLead } : ebookHead;
  /** 紙も作る本では、電子書籍の出し先で答える行を、紙の控えの下に見出しを分けて出す */
  const mainSpecs = out.paper ? specs.filter((s) => !s.ebook) : specs;
  const ebookSpecs = out.paper ? specs.filter((s) => s.ebook) : [];
  const specDl = (rows: Spec[]) => (
    <dl className="spec-list">
      {rows.map((s, i) => (
        <div key={i}>
          <dt>{s.label}</dt>
          <dd>
            {s.value}
            {s.note && <em>{s.note}</em>}
            {s.control}
          </dd>
        </div>
      ))}
    </dl>
  );
  /**
   * 見出しを分けた行(section)は、ふつうの行のあとに、見出しごとにまとめて出す(2026-10-12)。
   * section を持たない控え(KDP・その他の印刷所)は、いままでどおり dl が1つだけ
   */
  const specList = (rows: Spec[]) => {
    const sections = [...new Set(rows.flatMap((s) => (s.section ? [s.section] : [])))];
    if (sections.length === 0) return specDl(rows);
    return (
      <>
        {specDl(rows.filter((s) => !s.section))}
        {sections.map((h) => (
          <Fragment key={h}>
            <h3 className="spec-section">{h}</h3>
            {specDl(rows.filter((s) => s.section === h))}
          </Fragment>
        ))}
      </>
    );
  };

  return (
    <>
      {/* ［電子書籍の本文］だけは出さない。**あの画面のいちばん上に来るのは結論**で、
          その前に「確かめてから」と置くと、下見で確かめられると読めてしまう */}
      {target !== 'ebookBody' && (
        <p className="step-lede">確かめてから、1つずつ書き出します。</p>
      )}

      {/* **控えは上、書き出しは下。** 控えは一度見れば済むもの、書き出しは何度も押すもので
          役割が違う。AI 生成コンテンツの申告は紙にも電子にも要るので、
          4つのボタンのどれかに埋めると片方で落ちる(だからここに1か所だけ置く) */}
      {target === null && (
        <>
          {/* **作るものと出し先が、この画面の入口。**(2026-09-23 ユーザー要望
              「入稿の最初で選択ができて、それ以降は関連するものしか出ない」)。
              新規作成や［本のかたちを決める］で選んだものを1行で見せ、ここでも変えられる */}
          <div className="export-outputs">
            <p>
              作るもの：
              {out.paper && <b>紙の本（{printProfile.label}）</b>}
              {out.paper && out.ebook && '・'}
              {out.ebook && <b>電子書籍（{EPUB_TARGETS[epubTarget].label}）</b>}
            </p>
            <button className="ghost" onClick={() => setChoosing(!choosing)}>
              {choosing ? '閉じる' : '変える'}
            </button>
          </div>
          {choosing && <OutputsChooser settings={outputs} setSettings={setSettings} />}

          {/* 直すところは左右どちらの列にも属さないので、上に通しで置く。
              たいていは空なので、あるときだけ場所を取る */}
          {problems.length > 0 && (
            <>
              <h2>直すところ</h2>
              <ul className="checklist">
                {problems.map((p, i) => (
                  <li key={i} className="ng">
                    <span className="ic">!</span>
                    <span>
                      {p.text}
                      <button className="link-btn" onClick={p.goto.run}>
                        {p.goto.label}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              {/* 止めない。止めると「なぜ出せないのか」を探す旅が始まる */}
              <p className="hint">このままでも書き出せます</p>
            </>
          )}

          {/* **左が本題、右は控え。** ここでやることはデータの書き出しで、
              KDP の入稿値は入稿画面を開いたときに見返すもの。
              縦に積むと「まず読むもの」に見えてしまう(2026-08-19 ユーザー指摘) */}
          <div className="export-hub">
            <div className="export-hub-main">
              <h2>書き出すもの</h2>
              {/* 紙/電子の柱を色付きの箱にして立てる(exportGroups のコメント参照) */}
              {exportGroups(outputs).map((g) => (
                <section className={`export-pillar ${g.id}`} key={g.id}>
                  <div className="export-pillar-head">
                    <span className="export-pillar-mark">{g.mark}</span>
                    <div className="export-pillar-titles">
                      <h3>{g.title}</h3>
                      <p>{g.sub}</p>
                    </div>
                  </div>
                  <div className="export-menu">
                    {g.items.map(([id, kind, label, note]) => (
                      <button
                        key={id}
                        className={`export-card ${kind}`}
                        onClick={() => onTarget(id)}
                      >
                        {/* 46px の色札はやめた(2026-09-14)。カードの名前が「本文」に
                            なったので、札と名前が同じ言葉の二度書きになる。
                            本文/表紙の色分けは左端の色線(border-left)が引き継ぐ */}
                        <span className="export-text">
                          <b>{label}</b>
                          <small>{note}</small>
                        </span>
                        {/* 「ここから書き出す」の矢印。狭いサイドバーでは CSS で消す */}
                        <span className="export-go" aria-hidden="true">
                          ↓
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            {/* 入稿のときに見返す場所。入稿先の画面を開いたまま、ここを見て写せる形にする。
                **見出しと前置きは出し先で変える**(PRINT_TARGETS の specsTitle / specsLead)。
                印刷所を選んだ人にも「KDP の入稿画面で」と出ていた(2026-09-23 調査で発見) */}
            <aside className="export-hub-side">
              <h2>{specsHead.title}</h2>
              {/* 何のための一覧なのかを先に言う。項目名だけ並んでいても、
                  入稿先をまだ開いていない人には何の話か分からない(2026-08-19 ユーザー指摘) */}
              <p className="step-lede">{specsHead.lead}</p>
              {specList(mainSpecs)}
              {ebookSpecs.length > 0 && (
                <>
                  <h2>{ebookHead.title}</h2>
                  <p className="step-lede">{ebookHead.lead}</p>
                  {specList(ebookSpecs)}
                </>
              )}
            </aside>
          </div>
        </>
      )}

      {target !== null && <h2 className="export-title">{EXPORT_LABEL[target]}</h2>}

      {/* ---- ［紙の本文］。**下見を出さない全画面**(2026-09-24 ［電子書籍の本文］とそろえた) ----
          下見はボタンで本文の下見へ飛んで確かめる。ここでは「何ページの PDF になるか」を言い切る */}
      {target === 'paperBody' && (
        <PaperBodyExport
          paperPages={paperPages}
          printing={printing}
          onPrintPdf={onPrintPdf}
          onOpenBodyPreview={() => onOpenBodyPreview('paper')}
          printProfile={printProfile}
          bleedNote={printProfile.bleedNote(bleedOf(outputs))}
          ink={ink}
          bookTitle={bookTitle}
          paperMm={paperMm}
          boxes={boxes}
          blockReason={blockReason}
          saddle={bindingOf(outputs) === 'saddle' ? { self: saddleCoverOf(outputs) === 'self' } : undefined}
          onColorPages={onColorPages}
        />
      )}

      {/* ---- ［電子書籍の本文］。**下見を出さない全画面**(2026-08-21 作り直し) ----
          ユーザーの言「この画面、全く意味が分からない」「まず、この画面では
          プレビューを出したらいけないと思う。そもそもそれが間違いのもとだよね。
          だってチェックできないのに、わざわざチェックさせる意味がないじゃん」

          **下見をやめた理由。** このアプリの下見は1つしかなく、中身は紙の組版
          (manuscriptHtml)。電子書籍には版面が無いので、電子の姿は原理的に映せない。
          前日は「この下見は紙の組み方です」という札を出して断ったが、
          **断ってまで出す値打ちが無い**(確かめられないものを確かめさせている)。
          画面ごとやめて、`.fullstage`(分岐するだけの全画面)に載せ替えた。
          札(.preview-what)と、EPUB の1ページ目の表紙(.preview-first-page)は
          下見と一緒に外した。表紙の絵は板の中へ移すことも試したが、実測で 109px 食って
          ［書き出す］が落ちたので置いていない(下の［出し先］に理由を書いた)。

          **並びは「結論 → なぜ → 詳しく → 決めること → 書き出す」。**
          全画面が使えるぶん説明を足せるが、**ずらずらした文章にはしない**
          (ユーザー指示「箇条書きなど使ってください。また見出しやボタンも効果的に使うべき」)。
          文は箇条書きに割り、19件の一覧はボタン(details)の中に畳む */}
      {target === 'ebookBody' && (
        <div className="epub-stage">
          {/* **まず結論。** この画面でいちばん言いたいのは1つだけ */}
          <section className="epub-first">
            <p className="epub-shout">
              書き出した EPUB は、
              <b>出したいお店のプレビューで、必ず1度は見てください</b>
            </p>
            {/* なぜそう言うのか。**2つに割って書く**(下見の話と、お店ごとの話) */}
            <ul className="epub-points">
              {/* 「EPUBが手に入らないように読めてしまう」(2026-09-04 ユーザー指摘)ので、
                  手に入ること自体を括弧で言い切ってから、映せない理由を言う */}
              {/* 2026-09-24 に電子の下見ができたので「電子の仕上がりまでは映せません」を書き換えた。
                  下見は Chrome で流した一例なので、お店のプレビューで見る話(次の2つ)は残す */}
              <li>
                電子書籍は<b>読む端末が文字を流し直す</b>ので、決まったページの姿がありません。
                見え方の一例は、下の<b>［電子書籍の本文を確かめる・直す］</b>で、端末くらいの画面でめくって
                確かめられます（EPUB そのものは、いちばん下の<b>［書き出す］</b>で手に入ります）
              </li>
              <li>
                しかも<b>お店ごとに、電子書籍データの出し方が違います</b>。
                その違いはスタジオでは再現できません
              </li>
              <li>{HELP_EPUB_DIFF.check}</li>
            </ul>
            <button className="go-step" onClick={() => onOpenBodyPreview('ebook')}>
              電子書籍の本文を確かめる・直す →<small>［本のかたちを決める］の下見へ移ります</small>
            </button>
            {/* **詳しくはボタンの中。** 19件を開いたまま積むと画面が倍の高さになり、
                肝心の［書き出す］が折り返しの下へ落ちる。読む気になった人だけが開く。
                中身は help/content.ts の1か所で、ヘルプの板・配布 .md にも同じものが出る */}
            <details className="epub-diff">
              <summary>
                詳しくは：紙と電子で何が変わるか（必ずこうなるもの {HELP_EPUB_DIFF.always.length} 件・
                読む端末によるもの {HELP_EPUB_DIFF.depends.length} 件）
              </summary>
              <div className="epub-diff-body">
                <p className="epub-diff-lead">{HELP_EPUB_DIFF.lead}</p>
                {/* 2つの一覧は横に並べる。縦に積むと開いたときに2倍の高さになる */}
                <div className="epub-diff-cols">
                  <div>
                    <p className="epub-diff-head">{HELP_EPUB_DIFF.alwaysHead}</p>
                    <ul>
                      {HELP_EPUB_DIFF.always.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="epub-diff-head">{HELP_EPUB_DIFF.dependsHead}</p>
                    <ul>
                      {HELP_EPUB_DIFF.depends.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </details>
          </section>

          {/* **決めることは2つだけ。** 横に並べて、どちらも1画面に入れる */}
          <div className="epub-choices">
            {/* 表紙の入れ方が KDP と Kobo で正面から食い違うので、1つのファイルで両方は満たせない。
                KDP「表紙のHTMLページを足すと二重に出るか変換に失敗する」/
                Kobo「表紙画像は専用のXHTMLに入れること」。
                **押すものには「何が入るか」を大きく、店名を小さく。**
                店名だけだと、この2店以外には出せないと読める(2026-08-21 ユーザー指摘) */}
            <section className="epub-block">
              {/* **前置きの文は置かない。** 「2つに分かれる」はボタンそのものが言っている。
                  1440×900 で［書き出す］が折り返しの下へ落ちないよう、行は1行ずつに詰める */}
              {/* **ここでは選ばせない。**(2026-09-23 ユーザー要望「KDP か否かを選ばせるけど、
                  最初に選んだ人は自動で選択されていて、DLするだけ」)。
                  出し先は作るものと一緒に選んである(新規作成・本のかたち・この画面の入口)ので、
                  ここは「どちらで作るか」を言い切るだけにし、変える道は入口へ戻す */}
              <h3>EPUB の出し先</h3>
              <p className="epub-target-now">
                <b>{EPUB_TARGET_KIND[epubTarget]}</b>（{EPUB_TARGETS[epubTarget].label}）
                <button
                  className="linklike"
                  onClick={() => {
                    setChoosing(true);
                    onTarget(null);
                  }}
                >
                  出し先を変える
                </button>
              </p>
              {/* 説明は**選んだほうの話だけ**にする。両方の一般論を並べていたら
                  「表紙タブでDLする必要はない、が伝わらない」(2026-09-04 ユーザー指摘)。
                  選択で中身が実際に変わることは exporters/epub.ts が保証している
                  (kdp=表紙ページ無し / reader=専用XHTMLで同梱) */}
              <ul className="epub-points">
                {epubTarget === 'kdp' ? (
                  <>
                    <li>
                      この EPUB に<b>表紙のページは作りません</b>（表紙の画像自体はデータとして含まれています）。
                      KDP は表紙を入稿画面で<b>別に</b>受け取る決まりのため、ページとしても入れると二重に表示されるか、変換に失敗します
                    </li>
                    {/* 「下の」は付けない。この面を開いているとき、そのカードは画面のどこにも無い
                        (書き出すものを選ぶ画面の側にある)ので、下を探しても見つからない
                        (2026-09-23 ユーザー指摘「下の、というのが意味不明」) */}
                    <li>
                      表紙は<b>［電子書籍の表紙（KDP用）］の JPEG</b> を
                      KDP の入稿画面でアップロードしてください
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      この EPUB の<b>1ページ目に表紙まで入ります</b>
                      （画像は［表紙をつくる］で確かめられます。KDP 以外の出し先では
                      ［電子書籍の表紙］のカードは出ません）
                    </li>
                    <li>
                      <b>この1ファイルだけで入稿できます</b>。
                      表紙のファイルを別に用意する必要はありません
                    </li>
                  </>
                )}
                <li>
                  お店の名前は<b>代表例</b>です。ほかのお店に出すときは、
                  <b>表紙まで同梱か・本文だけか、どちらを受け取るお店なのか</b>を、
                  そのお店の案内でご自分で確かめてください
                </li>
              </ul>
              {/* **同梱される表紙の絵は、ここには出さない。**(2026-08-21 実測で判断)
                  もとは下見の左上に 240px で立てていたが、下見をやめたので置き場が消えた。
                  この板の中へ小さく移すことも試したが、**実測で 109px を食い**、
                  白ページの断りが出る本では板が 46px あふれて［書き出す］が
                  折り返しの下へ落ちた。小さくすれば入るが、それは
                  「小さくて確認ができない」と言われた形に戻るだけ(2026-08-20)。
                  **この画面は絵を確かめる場所ではない**(下見を出さないと決めた画面である)。
                  絵そのものは［電子書籍の表紙］で原寸で見られるので、そちらを指す */}
            </section>

            {/* **(ここから 09-24 までの経緯。いまの作りは次のコメント)**
                **刷り色「白黒」を電子まで持っていくかは、こちらで決めない。**(2026-08-20)
                紙だけ img に grayscale を掛けていて、EPUB の絵はカラーのまま出ていた。
                刷り色は KDP の入稿画面で選ぶ**紙の印刷条件**で、電子書籍に印刷は無く、
                読まれるのはたいていカラーの画面。色を落とすのは戻せない向きの変更なので、
                **既定はカラーのまま**にして、そろえたい人が選べるようにした。
                当時は**白黒で刷る本のときだけ出していた**(カラーで刷る本に「紙と同じ白黒」は無い)。

                **「電子書籍の絵」という名前をやめた。**(2026-08-21 ユーザー指摘
                「『電子書籍の絵』と画面には書かれているけど、紙でカラー本を作ったら
                そのまま反映されますよね？ 文字もカラーになるからこの表現はおかしい」)
                利用者が選んでいるのは**書き出すデータを何色で出すか**であって、
                絵だけの話だと名乗るのが混乱のもとだった。名前は「色」で言い直し、
                **どこまで効くのか**(本文の画像だけ・表紙は掛からない・文字の色は
                そもそも EPUB に渡らない)を箇条書きで下に置いていた。
                掛かるのは `figure.fig img, .plate img` だけで、表紙には掛からない(これはいまも同じ) */}
            {/* **選ぶのは［本のかたちを決める］。**(2026-09-24 ユーザー要望「紙と同じように、電子書籍も
                白黒かカラーかを選んだ状態で版下を作れた方がいい」) 電子の下見ができたので、選んだ色を
                下見で確かめてから書き出せる。ここでは何色で出るかだけを言う。
                値は紙の刷り色と切り離した settings.ebookMono で、電子書籍を作る本ではいつも出す */}
            <section className="epub-block">
              <h3>電子書籍の色</h3>
              <p className="epub-color-now">
                <b>{ebookMono ? '白黒' : 'カラー'}</b>で書き出します
                <small>
                  （本文に入れた画像の色です。表紙はいつもカラー。変えるときは
                  <b>［本のかたちを決める］</b>の［電子書籍の色］で選びます）
                </small>
              </p>
            </section>
          </div>

          {/* **いちばん下は［書き出す］の行。** 白ページの断りは、その右に並べる。
              段落として上に積むと、そのぶん［書き出す］が下がって
              1440×900 の折り返しの下へ落ちる(実測)。
              押したら何が出るかの断りなので、ボタンの隣が意味の上でも合う。

              **出し先で中身が変わるので、ボタンの名前も変える。**
              表紙まで同梱するときに「本文を書き出す」だと、
              表紙を別に用意する必要があると読める(2026-08-19 ユーザー指摘) */}
          <div className="epub-go">
            <button className="primary-action" disabled={exporting} onClick={onExportEpub}>
              {exporting
                ? '出力中…'
                : epubTarget === 'kdp'
                  ? '電子書籍の本文を書き出す（EPUB）'
                  : '電子書籍の表紙・本文をまとめて書き出す（EPUB）'}
            </button>
            {/* **白ページは EPUB に入らない。入る前に断る。**(2026-08-20)
                電子書籍にはページという区切りが無く、1画面に何が入るかは読む人の
                画面と文字の大きさで決まる。白ページを1つ足しても「白い1画面」にはならない。
                **黙って消さない**のがこのアプリの作法なので、枚数まで言う。
                消すボタンは置かない — 元データは紙と電子で1つなので、
                消せば紙の PDF からも消えてページ数が変わる(2026-08-20 ユーザー判断) */}
            {blankPlates > 0 && (
              <p className="warn">
                白ページ（クッション）が {blankPlates} 枚ありますが、
                <b>EPUB には入りません</b>
                （電子書籍にページの区切りがないため）。
                <b>紙の PDF にはそのまま出ます</b>
              </p>
            )}
          </div>
        </div>
      )}

      {(target === 'paperCover' || target === 'ebookCover') && (
        <>
          {/* 見本は**右のプレビューに大きく出す**(App が同じ covers を使う)。
              340px のサイドバーに縮めて置いていたが、表紙の確認には小さすぎたうえ、
              右には本文が映ったままで何を見ているのか分からなかった(2026-08-19) */}
          {!covers &&
            (coverShotsFailed ? (
              <p className="warn">
                見本を作れませんでした。<b>［表紙をつくる］</b>で表紙を開いて確かめてください
              </p>
            ) : (
              <p className="hint">見本を作っています…</p>
            ))}
          <p className="hint">
            <b>右に出ている見本の見た目で書き出します。</b>
            {target === 'paperCover'
              ? bindingOf(outputs) === 'saddle'
                ? '表4と表1を背なしでつないだ、入稿されるとおりの姿です（折り目は真ん中）'
                : 'バーコードの仮はめを外した、入稿されるとおりの姿です'
              : 'KDP 推奨の 1600×2560px・RGB の JPEG です'}
          </p>
          <button className="go-step" onClick={onGoToCover}>
            {target === 'paperCover' ? '紙の表紙' : '電子書籍の表紙'}を確かめる・直す →
            <small>［表紙をつくる］へ移ります</small>
          </button>
          {/* 紙の表紙は背幅がページ数で決まる。数え終わるまで待たせる(概算で刷らせない) */}
          {target === 'paperCover' && coverSpinePending && (
            <p className="hint">
              <b>いま、本文のページ数を数えています…</b>紙の表紙は<b>背の幅がページ数で決まる</b>ので、
              数え終わると正しい背幅で書き出せます
            </p>
          )}
          {/* 入稿が2回に分かれる会社(coverAfterSpineNote を持つ会社)で、背幅がまだ目安のとき。止めはしない
              (本文と表紙を一緒に送ってもよい決まり)。中綴じには背が無いので言わない */}
          {target === 'paperCover' &&
            printProfile.coverAfterSpineNote &&
            !coverSpineFromPrinter &&
            bindingOf(outputs) !== 'saddle' && <p className="hint">{printProfile.coverAfterSpineNote}</p>}
          {/* 紙の表紙は、印刷所なら入稿用の PDF まで1回で作る。報告と失敗の逃げ道は PressCover が持つ */}
          {target === 'paperCover' ? (
            <PressCover
              convert={!printProfile.acceptsRgbPdf}
              bookTitle={bookTitle}
              disabled={coverSpinePending}
              exportCover={onExportCoverPdf}
            />
          ) : (
            <button className="primary-action" onClick={onExportCoverJpeg}>
              電子書籍の表紙を書き出す（JPEG）
            </button>
          )}
        </>
      )}

      {/* **戻り道は、いちばん下。**(2026-08-20 ユーザー指摘
          「『書き出すものを選びなおす』ボタンは一番上か、一番下か、どちらかにしたい。
          文中に挟まっていると、そうでなくてもボタンとして目立ってないから完全に埋もれる」)
          もとは step-lede と見出しのあいだにいて、文章の途中に落ちていた。

          **下を採ったのは、ここが「1つずつ書き出す」場所だから。**
          紙の本文を出す → 選び直す → 電子書籍の本文を出す → 選び直す …と回るので、
          この戻り道は書き出しの**次にやること**であって、その前に読むものではない。
          押す前に目に入る必要が無く、押したあとすぐ手が届けばよい。

          上に置くと、見出し・書き出しボタンと「最初に目が行く場所」を取り合う。
          下なら、すぐ上の青い［書き出す］との塗り分けだけで上下が付く
          (主役は書き出しで、これは戻り道)。板は 900px の窓なら
          いちばん高い［電子書籍の本文］でも収まるので、下でも探し回らずに済む */}
      {target !== null && (
        <button className="export-back" onClick={() => onTarget(null)}>
          ← 書き出すものを選び直す
        </button>
      )}

      {/* 底のかくれカエル。本ができる工程なので、いちばん驚いている */}
      <div className="frog-sit" aria-hidden="true">
        <FrogPeek width={40} mood="wow" />
      </div>
      {/* **本ができた画面の底に、投げ銭の1行。**(2026-10-06 ユーザー要望「投げ銭をもう少し大きめに」)
          書き出しを終えた瞬間が、いちばん「ありがとう」と思ってもらえる場面。
          ただし作業の邪魔はしない: 閉じる操作の要らない地の文で、カエルの下にだけ置く。
          誠実の決まり(機能と引き換えにしない・急かさない・金額を言わない。2026-09-02)は入口と同じ */}
      {TIP_URL && (
        <p className="export-thanks">
          {/* まだ書き出す前にも見える場所なので「ここまで」を付ける。
              文面は Gemini 3.1 Pro の案(2026-10-07。StartScreen.tsx の FROG_LINES のコメント参照) */}
          ここまでお疲れさまでした。このスタジオは個人で開発しています。もしお役に立てたら、
          <a className="linklike" href={TIP_URL} target="_blank" rel="noopener noreferrer">
            OFUSE（投げ銭）
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
          で応援していただけると、サイトの維持や次の機能を作る力になります。
        </p>
      )}
    </>
  );
}
