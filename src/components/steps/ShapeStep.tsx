// 「本のかたちを決める」。**最初に一度決めて、あとは戻ってこない工程。**
//
// もとは画面下の帯(FormatBar)の中の板だった。帯に置いた理由は
// 「工程ではなく道具だから」だったが、精査すると2種類が混ざっていた:
//
//   - **決め切るもの** … 判型・組み方向・目次・刷り色・本文用紙・ノンブル・柱。
//     KDP の入稿画面で選ぶ値でもあり、一度決めたら本ができるまで触らない
//   - **往復するもの** … 書体・サイズ・行送り・段組み・色・フチ・帯。
//     紙面を見ながら何度も戻って変える
//
// 前者を工程レールの先頭へ戻し、帯には後者だけを残した(2026-08-19 ユーザーの提案)。
// これで「かたちを決める → レイアウトを整える → 画像 → 奥付 → 表紙 → AI → 入稿」
// という順路が、レールと帯の分担にそのまま重なる。
//
// **帯に置いていたころの制約はここには無い。** 横一列に押し込む必要がないので、
// 説明文も警告もそのまま出せる。

import {
  INK_COLORS,
  MARGIN_SLOTS,
  PRINT_TARGETS,
  SPINE_INSET_LIMIT,
  TRIM_SIZES,
  bindingOf,
  offersSaddle,
  outputsOf,
  saddleCoverOf,
  saddleSpecOf,
  titleWritingModeOf,
  trimUnsupported,
  type InkColor,
  type MarginSlot,
  type ProjectSettings,
  type TrimId,
  type WritingMode,
} from '../../models/project';
import {
  PAPER_TYPES,
  papersFor,
  coverSpineMm,
  printerPapersOf,
  spineTextMinPages,
  type PaperType,
} from '../../models/cover';
import { isLatinOnlyTitle } from '../../typeset/text';
import { saddleFindings, saddleOffNote, saddleReadout } from '../../typeset/saddle';
import { useProject } from '../../store/useProject';
import { FrogPeek } from '../FrogMark';
import { OutputsChooser } from '../OutputsChooser';
import { DraftNum, PrintRules, type PrintFocus } from '../PrintRules';

/**
 * 余白のどこに刷るかを選ぶ小さな盤。表紙の文字を置く AnchorPad と同じ考え方で、
 * **紙のかたちのまま**選ばせる(「@bottom-left」のような枠の名前は出さない)。
 *
 * 3列は左からノド寄り・中央・小口寄り。**左右ではなく綴じからの遠近**なので、
 * 裏のページでも同じところに刷られる
 */
function SlotPad({
  value,
  onChange,
  other,
}: {
  value: MarginSlot;
  onChange: (v: MarginSlot) => void;
  /**
   * もう一方が取っている枠。**盤の上に薄く出す。**
   * ノンブルと柱は同じ6つの枠を取り合うのに、盤が別々だと
   * 取り合っていることが「警告文」でしか分からなかった。
   * 相手の居場所が見えていれば、そもそも重ねずに選べる
   */
  other?: { slot: MarginSlot; mark: string; label: string };
}) {
  const cell = (id: MarginSlot) => {
    const label = MARGIN_SLOTS.find((m) => m.id === id)?.label ?? '';
    const taken = other && other.slot === id;
    const clash = taken && value === id;
    return (
      <button
        key={id}
        className={[value === id ? 'active' : '', taken ? 'taken' : '', clash ? 'clash' : '']
          .filter(Boolean)
          .join(' ')}
        title={taken ? `${label}（${other.label}が入っています）` : label}
        aria-label={taken ? `${label} ${other.label}が入っています` : label}
        onClick={() => onChange(id)}
      >
        {taken ? other.mark : ''}
      </button>
    );
  };
  return (
    <div className="slot-pad-wrap">
      <div className="slot-pad">
        {(['top-gutter', 'top-center', 'top-fore'] as MarginSlot[]).map(cell)}
        <span className="slot-pad-page">誌面</span>
        {(['bottom-gutter', 'bottom-center', 'bottom-fore'] as MarginSlot[]).map(cell)}
      </div>
      <div className="slot-pad-legend">
        <span>ノド（内側）</span>
        <span>中央</span>
        <span>小口（外側）</span>
      </div>
      <button
        className={value === 'none' ? 'ghost active-off' : 'ghost'}
        onClick={() => onChange('none')}
      >
        入れない
      </button>
    </div>
  );
}

interface Props {
  settings: ProjectSettings;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  applyPreset: (trim: TrimId, mode: WritingMode) => void;
  /** 右の下見がいま電子書籍か(両方を作る本)。帯の書体・サイズが「固定」の表示になっている */
  ebookView?: boolean;
  /**
   * 紙の本文のページ数。**いまの本の姿で組み上がっているときだけ**数、まだなら null。
   * 印刷所の背幅を入れたときのページ数を覚えて、あとでページ数が変わったら知らせるのに使う
   */
  paperPages?: number | null;
  /**
   * 中綴じの本文のページ数(白いページ・共紙の表紙を含まない)。**いまの本の姿で組み上がっているときだけ**数、まだなら null。
   * 読み上げ「いま本文は N ページ。…白いページを ◯ 枚入れて ◯ ページにします」に使う(2026-10-03)
   */
  saddleBodyPages?: number | null;
  /** 奥付があるか。白いページは奥付の手前に入る(無ければ最後)。読み上げの言い方に使う */
  hasColophon?: boolean;
  /** 「印刷所の決まり」の欄に触っているあいだ、下見のどこを色づけるか(App が下見へ渡す) */
  onPrintFocus?: (f: PrintFocus) => void;
  /**
   * AI タブの［入稿の数字を調べる］から飛んできた合図。**seq が変わるたびに** AI の箱を開く
   * (見出しまで画面を動かすのは App。ArtStep の focusPane と同じ型)
   */
  focusPrintRules?: { seq: number; to: 'head' | 'paste' };
}

const noFocus = () => {};

export function ShapeStep({
  settings,
  setSettings,
  applyPreset,
  ebookView = false,
  paperPages = null,
  saddleBodyPages = null,
  hasColophon = true,
  onPrintFocus = noFocus,
  focusPrintRules,
}: Props) {
  /**
   * 本文用紙。**表紙の設定だが、置き場所はここ。**
   *
   * 背幅の計算に使う値なので表紙タブの先頭に置いていたが、
   * 「ここを見ても意味が分からない」と言われた(2026-08-19 ユーザー指摘)。
   * KDP の入稿画面でも「インクと用紙のタイプ」はひと組なので、刷り色の隣に置く
   */
  const cover = useProject((s) => s.cover);
  const patchCover = useProject((s) => s.setCover);
  /** 書名が英字だけか(縦組みの本で横書きを勧める一言に使う。2026-10-03) */
  const latinTitle = useProject((s) => isLatinOnlyTitle(s.manuscript.title));
  /** AI タブの［入稿の数字を調べる］から飛んできた合図。AI の箱を開く(見出しまで動かすのは App) */
  const jumpSeq = focusPrintRules?.seq;
  const papers = papersFor(settings.ink);
  const paper = papers.includes(cover.paper) ? cover.paper : papers[0];
  /** 会社の用紙の選び。一覧を持たない会社では背幅に効かない */
  const paperChoice = { body: cover.printerBodyPaper, cover: cover.printerCoverPaper };
  /** 会社の用紙の一覧。在れば用紙の欄はこの一覧になる。KDP・その他の印刷所は null */
  const ownPaperList = PRINT_TARGETS[settings.printTarget].papers;
  const ownPapers = printerPapersOf(settings.printTarget, paperChoice);
  /** いまの用紙とアキで、背に文字を刷れるようになるページ数 */
  const spineMin = spineTextMinPages(paper, settings.spineInsetMm, settings.printTarget, paperChoice);
  /** 作るもの。紙を作らない本には、紙にしか効かない欄を出さない(2026-09-23 ユーザー要望) */
  const out = outputsOf(settings);
  /**
   * 印刷所の背幅を訊くか。**KDP 以外の出し先だけ。**(2026-09-27 ユーザー判断)
   * 印刷所ごとに紙の厚みは違い、全部の表は持てないので、印刷所が出した数字を入れてもらう
   */
  /** 中綴じ(背が無い)か。**背幅・背の縁のアキの欄は出さない**(2026-10-03)。KDP では選んでいても無線(bindingOf) */
  const saddleOn = bindingOf(settings) === 'saddle';
  const saddleSpec = saddleSpecOf(settings);
  const asksPrinterSpine = PRINT_TARGETS[settings.printTarget].asksPrinterSpine && !saddleOn;
  /** 出し先が受け付けない判型(unsupportedTrims)を、いま選んでいるか */
  const trimBad = trimUnsupported(settings.printTarget, settings.trim);
  const printProfile = PRINT_TARGETS[settings.printTarget];
  /**
   * 目安の背幅。欄が空のときに使う値を、そのまま見せる。用紙の一覧を持つ会社はその用紙と会社の式で、
   * ほかは KDP の紙の厚み × ページ数
   */
  const estPages = paperPages ?? settings.estimatedPages;
  const spineEstimate = coverSpineMm(estPages, paper, ownPapers ? settings.printTarget : 'kdp', undefined, 'perfect', paperChoice);
  /** 背幅を入れたときから、ページ数が変わったか */
  const spinePagesMoved =
    cover.spineMmFromPrinter !== undefined &&
    cover.spineMmPages !== undefined &&
    paperPages !== null &&
    paperPages !== cover.spineMmPages;
  /** 出し先の会社が背の縁のアキを決めていないときだけ、利用者に決めてもらう */
  const insetIsFree = PRINT_TARGETS[settings.printTarget].fixedSpineInsetMm === undefined && !saddleOn;

  const nombreSlot = settings.nombreSlot ?? 'bottom-fore';
  const headSlot = settings.runningHeadSlot ?? 'bottom-center';
  const headPages = settings.runningHeadPages ?? 'recto';
  const headText = settings.runningHeadText ?? 'chapter';
  /** 同じ枠を取り合っているか。刷るときはページ番号を優先する(css.ts と同じ判断) */
  const sameSlot = nombreSlot !== 'none' && nombreSlot === headSlot;


  return (
    <>
      {/* **並びは「決まる順」。**(2026-08-19 ユーザーと精査)
          1. 判型と綴じ … 紙のかたちが決まらないと他が決められない。
             ここを変えると文字サイズと余白も既定値に戻るので、いちばん先に置く
          2. 刷り色と紙 … 背幅が決まる。KDP の入稿画面で聞かれる値のひと組
          3. ページに刷るもの … 目次・ノンブル・柱。**紙面の上に載るもの**なので最後。
             目次はもとは「判型と綴じ」に入れていたが、綴じの話ではない */}
      {/* KDP を説明なしに出さない・KDP専用だと誤解させない(2026-09-02 ユーザー指摘)。
          出し先は下の［作るもの］で「Amazon KDP／その他の印刷所」と名指しで選ぶようになったので、
          リードの「KDP でもほかの印刷所でも使えます」は二度書きとして外した(2026-09-23)。
          ［デザインする］という名指しもやめる — 帯の左端の実物は「本全体をデザインする」で、
          章を選ぶと名前が変わるため、固有名ではなく**場所**で案内する */}
      {/* 電子書籍だけを作る本では、判型は入稿で聞かれない(読む端末が文字を流し直す)。
          その本に向けて「入稿でそのまま聞かれる値」とは言わない */}
      {out.paper ? (
        <p className="lead">
          まず本の器を決めます。<b>ここで決めた値は、本を売り出すときにそのまま聞かれる値です</b>。
          {/* 電子の下見のあいだ、帯の書体とサイズは「固定」の表示になる(FormatBar の paperBar)。
              そのときに「いつでも変えられます」と言うと、真下の帯と食い違う(2026-09-24 レビューで発見) */}
          {ebookView ? (
            <>
              書体や文字の大きさは<b>紙の本だけ</b>のものです。画面のいちばん下の帯で変えるときは、
              右の下見を<b>［紙の本］</b>にしてください（電子書籍は読む人の端末が決めます）。
            </>
          ) : (
            <>
              書体や文字の大きさは<b>画面のいちばん下にある細長い帯</b>で、いつでも変えられます。
            </>
          )}
        </p>
      ) : (
        // 電子書籍だけの本は、下見も電子(2026-09-24)。判型は電子書籍に無いので欄ごと出さない
        <p className="lead">
          まず本の器を決めます。電子書籍は読む人の端末が文字を流し直すので、<b>判型はありません</b>。
          <b>組み方向と目次は電子書籍にそのまま入ります</b>。見え方は右の下見でめくって確かめられます。
          書体は<b>本文が明朝、見出しと太字がゴシックで固定</b>です（電子書籍は読む人の端末が書体を決めるので、
          ほかの書体にはできません）。
        </p>
      )}

      {/* **作るものがいちばん先。**(2026-09-23)
          紙を作るか・電子を作るか・どこへ出すかで、この先に出る欄そのものが変わる。
          もとはこの工程の中ほどに［どこで刷るか］(紙の出し先だけ)があった。
          それをここへ吸い上げ、電子の出し先(もとは書き出しの画面にしか無かった)と並べた */}
      {/* **ボタンだけを出す。** 出し先ごとの一言(背文字は80ページから・EPUB に表紙を入れるか…)は
          表紙と書き出しの話で、本文の器を決めるこの工程には要らない(2026-09-23 ユーザー指摘
          「細かい説明はいらない。本文つくるときに必要な情報だけにした方がいい」)。
          一言は新規作成(省略)と［完成データを書き出す］(出す)で読める */}
      <h2>作るもの</h2>
      <OutputsChooser settings={settings} setSettings={setSettings} showHints={false} showNote={false} />

      <h2>{out.paper ? '判型と綴じ' : '組み方向'}</h2>
      {out.paper && (
      <label className="stack">
        判型
        <select
          value={settings.trim}
          onChange={(e) => applyPreset(e.target.value as TrimId, settings.writingMode)}
        >
          {/* 出し先が受け付けない判型(unsupportedTrims)は選べなくする。すでにその判型の本は、
              黙って変えず、残したまま「使えません」と言う(選び直すのは利用者) */}
          {Object.values(TRIM_SIZES).map((t) => {
            const bad = trimUnsupported(settings.printTarget, t.id);
            return (
              <option key={t.id} value={t.id} disabled={bad}>
                {bad ? `${t.label}（${printProfile.label}では使えません）` : t.label}
              </option>
            );
          })}
        </select>
      </label>
      )}
      {out.paper && trimBad && (
        <p className="warn">
          {TRIM_SIZES[settings.trim].label.replace(/\s+\d+×\d+$/, '')}は{printProfile.label}では使えません。
          ほかの判型を選び直してください（選ぶと、文字サイズと余白がその判型の既定値に戻ります）
        </p>
      )}
      {out.paper && printProfile.trimNote && <p className="hint">{printProfile.trimNote}</p>}
      <label className="stack">
        組み方向
        <select
          value={settings.writingMode}
          onChange={(e) => applyPreset(settings.trim, e.target.value as WritingMode)}
        >
          <option value="vertical">縦書き（右綴じ）</option>
          <option value="horizontal">横書き（左綴じ）</option>
        </select>
      </label>
      {out.paper && (
      <p className="hint">
        判型と組み方向を変えると、<b>文字サイズと余白もその判型の既定値に戻ります</b>。
        そのため、<b>最初に決めてください</b>
      </p>
      )}

      {/* 書名の向き(2026-10-03)。縦書きの本のときだけ。**組み方向のすぐ下**(ヘルプもそう言う。綴じ方より上)。applyPreset は通さない(文字サイズ・余白は動かさない) */}
      {settings.writingMode === 'vertical' && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={titleWritingModeOf(settings) === 'horizontal'}
              // 外したら設定ごと消す(省略 = 本文に従う)。'vertical' を書くと、書名の向きを「選んだ」ことになってしまう
              onChange={(e) => setSettings({ titleWritingMode: e.target.checked ? 'horizontal' : undefined })}
            />
            書名と著者名を横書きにする
          </label>
          <p className="hint">
            表紙・大扉・電子書籍の扉に効きます。本文・柱・奥付は変わりません。
            表紙の書名の位置は［表紙をつくる］で直せます
          </p>
          {latinTitle && titleWritingModeOf(settings) === 'vertical' && (
            <p className="hint">
              書名が英字だけです。横書きにすると読みやすくなります{' '}
              <button className="ghost" onClick={() => setSettings({ titleWritingMode: 'horizontal' })}>
                横書きにする
              </button>
            </p>
          )}
        </>
      )}

      {/* **綴じ方。**(2026-10-03 中綴じ) 中綴じを選べる出し先(saddle を持つ出し先。その他の印刷所など)だけ。KDP には欄を出さない。
          KDP に切り替えた本は、選びを消さず、無線で組んでいることを言う(戻せる)。
          applyPreset は通さない(文字サイズ・余白は動かさない) */}
      {out.paper && offersSaddle(settings.printTarget) && (
        <>
          <div className="stack">
            綴じ方
            <div className="seg" role="group" aria-label="綴じ方">
              <button
                className={!saddleOn ? 'active' : ''}
                aria-pressed={!saddleOn}
                onClick={() => saddleOn && setSettings({ binding: 'perfect' })}
              >
                無線綴じ
              </button>
              <button
                className={saddleOn ? 'active' : ''}
                aria-pressed={saddleOn}
                onClick={() => saddleOn || setSettings({ binding: 'saddle' })}
              >
                中綴じ
              </button>
            </div>
          </div>
          <p className="hint">
            {saddleOn ? (
              <>真ん中をホチキスで留める綴じ方です。薄い本・ZINE 向き。背はなく、ページ数は<b>4 の倍数</b>にそろえます</>
            ) : (
              <>背のあるふつうの本です。薄い本・ZINE には<b>中綴じ</b>もあります</>
            )}
          </p>
        </>
      )}
      {out.paper && !offersSaddle(settings.printTarget) && saddleOffNote(settings) && (
        <p className="hint">{saddleOffNote(settings)}</p>
      )}
      {out.paper && saddleOn && saddleSpec && (
        <>
          <div className="stack">
            表紙
            <div className="seg" role="group" aria-label="中綴じの表紙">
              <button
                className={saddleCoverOf(settings) === 'separate' ? 'active' : ''}
                aria-pressed={saddleCoverOf(settings) === 'separate'}
                onClick={() => setSettings({ saddleCover: 'separate' })}
              >
                別表紙
              </button>
              <button
                className={saddleCoverOf(settings) === 'self' ? 'active' : ''}
                aria-pressed={saddleCoverOf(settings) === 'self'}
                onClick={() => setSettings({ saddleCover: 'self' })}
              >
                共紙
              </button>
            </div>
          </div>
          <p className="hint">
            {saddleCoverOf(settings) === 'self' ? (
              <>表紙も本文と同じ紙です。<b>表紙のファイルは要りません</b>（表1・表4 は本文の PDF に入ります）</>
            ) : (
              <>表紙だけ別の厚い紙で巻きます。表紙のファイルは、背のない1枚で別に出します</>
            )}
          </p>
          {/* 読み上げは短く。引っかかったとき(ページ数の上限・綴じる辺)だけ、下に足す */}
          <p className="readout">{saddleReadout(settings, saddleBodyPages, hasColophon)}</p>
          {/* 白いページを自分で使いたい人へ。足した絵やコラムは、そのぶん自動の白いページを減らす */}
          {saddleBodyPages !== null && saddleBodyPages % 4 !== 0 && (
            <p className="hint">
              白いページを自分で使うときは、［本文に画像とコラムを入れる］で奥付の前に画像やコラムを足します（そのぶん自動の白いページが減ります）
            </p>
          )}
          {saddleFindings(settings, paperPages).map((f) => (
            <p key={f.text} className="warn">
              {f.text}
            </p>
          ))}
          {/* ノドは 10mm からで足りる。余白の設定がそれより大きいときだけ、［ノドを 10mm にする］を出す。
              押したときだけ余白の値を書き換える(黙って変えない。Ctrl+Z で戻せる) */}
          {settings.margins.gutter > saddleSpec.gutterMinMm + 0.05 && (
            <details className="chapter-bg">
              <summary>ノドをもっと狭くしたいとき</summary>
              <p className="hint">
                ノドは <b>{saddleSpec.gutterMinMm}mm</b> からで足ります（いまの余白の設定は {settings.margins.gutter}mm）{' '}
                <button
                  className="ghost"
                  onClick={() => setSettings({ margins: { ...settings.margins, gutter: saddleSpec.gutterMinMm } })}
                >
                  ノドを {saddleSpec.gutterMinMm}mm にする
                </button>
              </p>
            </details>
          )}
        </>
      )}

      {/* 刷り色・用紙・背の縁のアキは**紙の本だけの話**。電子書籍だけを作る本には出さない
          (刷り色は EPUB には効かない。models/project.ts の INK_COLORS) */}
      {out.paper && (
        <>
      <h2>刷り色と紙</h2>
      <label className="stack">
        刷り色
        <select
          value={settings.ink}
          onChange={(e) => {
            const ink = e.target.value as InkColor;
            setSettings({ ink });
            // **用紙も刷り色に合うものへ替えておく。**(2026-09-25 見直し S2-12)
            // 前は画面の表示だけ「合う用紙」に丸め、覚えている用紙は前のままだったので、
            // 画面の背幅と書き出した表紙 PDF の背幅が 0.06〜0.10mm 食い違った
            if (!papersFor(ink).includes(cover.paper)) patchCover({ paper: papersFor(ink)[0] });
          }}
        >
          {(Object.keys(INK_COLORS) as InkColor[]).map((k) => (
            <option key={k} value={k}>
              {INK_COLORS[k].label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">{INK_COLORS[settings.ink].hint}</p>
      {/* **会社の用紙の一覧を持つ出し先(papers)は、その一覧から選ぶ。**(2026-10-07)
          背幅の目安は 本文ページ数 ÷ 2 × 本文用紙の厚さ ＋ 表紙用紙の厚さ × 2。KDP の用紙(cover.paper)は消さずに残す */}
      {ownPaperList && ownPapers ? (
        <>
          <label className="stack">
            本文用紙
            <select value={ownPapers.body.id} onChange={(e) => patchCover({ printerBodyPaper: e.target.value })}>
              {ownPaperList.body.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                  {x.note ? `（${x.note}）` : ''}
                </option>
              ))}
            </select>
          </label>
          {/* 中綴じの表紙用紙は会社の決まり(控えに出す)。背も無いので、表紙用紙の欄は無線綴じのときだけ */}
          {!saddleOn && (
            <label className="stack">
              表紙用紙
              <select value={ownPapers.cover.id} onChange={(e) => patchCover({ printerCoverPaper: e.target.value })}>
                {ownPaperList.cover.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                    {x.note ? `（${x.note}）` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {/* 説明の文は会社の手順なので、会社の側に持たせる(papers.text) */}
          <p className="hint">
            {saddleOn ? (
              ownPaperList.text.hintSaddle
            ) : (
              <>
                {ownPaperList.text.hint[0]}
                <b>{ownPaperList.text.hint[1]}</b>
                {ownPaperList.text.hint[2]}
              </>
            )}
          </p>
        </>
      ) : (
        <>
      <label className="stack">
        本文用紙
        <select value={paper} onChange={(e) => patchCover({ paper: e.target.value as PaperType })}>
          {papers.map((k) => (
            <option key={k} value={k}>
              {PAPER_TYPES[k].label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        {saddleOn ? (
          <>中綴じに背はないので、用紙は背幅には効きません。刷り色に合う用紙だけを出しています</>
        ) : (
          <>紙の厚みで<b>背幅が決まります</b>。刷り色に合う用紙だけを出しています</>
        )}
        {settings.printTarget === 'kdp' && '（KDP の入稿でも「インクと用紙のタイプ」はひと組です）'}
      </p>
        </>
      )}

      {/* **印刷所の決まり。**(2026-10-01 ユーザーと決定) 塗り足し・ノドの下限・厚い本のノドと、
          いままで「刷り色と紙」に在った背幅(印刷所の数字)・背の縁のアキを、ここ1か所に集めた。
          出し先が KDP のときは、KDP の決まりを読み上げるだけ(欄は出さない) */}
      {/* id は AI タブから飛んでくる先(App が、サイドバーの覚え書きを戻したあとで見出しまで動かす) */}
      <h2 id="print-rules-head">印刷所の決まり</h2>
      <PrintRules
        settings={settings}
        setSettings={setSettings}
        paperPages={paperPages}
        ebookView={ebookView}
        onPrintFocus={onPrintFocus}
        openAiSeq={jumpSeq}
        focusPaste={focusPrintRules?.to === 'paste'}
      />

      {/* 印刷所から知らされた背幅。空なら KDP の紙の厚みで出した目安を使う(models/cover.ts coverSpineMm)。
          KDP 以外の出し先だけ(KDP は紙の厚みの表を持っている) */}
      {asksPrinterSpine && (
        <>
          <label>
            背幅（印刷所の数字）
            <span className="num">
              <DraftNum
                value={cover.spineMmFromPrinter}
                min={0}
                max={100}
                step={0.01}
                allowEmpty
                zeroIsEmpty
                placeholder={spineEstimate.toFixed(2)}
                ariaLabel="背幅"
                onCommit={(v) => {
                  // 空欄・0 以下は「入れていない」(目安を使う)。入れたときのページ数を覚える(組み上がっていなければ覚えない)
                  const ok = v !== null && v > 0;
                  patchCover({
                    spineMmFromPrinter: ok ? v : undefined,
                    spineMmPages: ok ? (paperPages ?? undefined) : undefined,
                  });
                }}
              />
              mm
            </span>
          </label>
          <p className="hint">
            印刷所から知らされた背幅を入れてください。表紙の背と、表紙全体の大きさがこの数字で決まります。
            {ownPapers ? (
              <>
                <b>
                  空欄のときは、選んだ用紙から計算した目安（{spineEstimate.toFixed(2)}mm・{estPages}ページ）
                </b>
                を使います。{ownPaperList?.text.spineAfter}
              </>
            ) : (
              <>
                <b>
                  空のときは、KDP の紙の厚みで出した目安（{spineEstimate.toFixed(2)}mm・{estPages}ページ）
                </b>
                を使います。印刷所の紙では背幅が違うことがあります
              </>
            )}
          </p>
          {spinePagesMoved && (
            <p className="warn">
              背幅を入れたときから、本文のページ数が変わっています（{cover.spineMmPages} → {paperPages}
              ページ）。背幅も変わるので、印刷所に確かめて入れ直してください
            </p>
          )}
        </>
      )}

      {/* **背の縁のアキは、出し先の会社が決めていないときだけ訊く。**
          KDP は 1.6mm と決めているので出さない(PRINT_TARGETS の fixedSpineInsetMm)。
          **空欄は元の値へ戻す**(以前は空欄を 0 にしていた。DraftNum が打っている途中を手元に持つ) */}
      {insetIsFree && (
        <>
          <label>
            背の縁のアキ
            <span className="num">
              <DraftNum
                value={settings.spineInsetMm}
                min={SPINE_INSET_LIMIT[0]}
                max={SPINE_INSET_LIMIT[1]}
                step={0.1}
                ariaLabel="背の縁のアキ"
                onCommit={(v) => v !== null && setSettings({ spineInsetMm: v })}
              />
              mm
            </span>
          </label>
          <p className="hint">
            背の縁から、この幅だけ文字を離します。<b>綴じたときの折り位置のブレを吸収する余白</b>で、
            削ると文字が表1・表4へ回り込みます。
            {spineMin > 0 && (
              <>
                {' '}いまの用紙とこのアキなら、<b>{spineMin}ページ</b>から背に文字を刷れます
              </>
            )}
            <small>
              参考: KDP は 1.6mm。同人誌の印刷所は 1mm 前後を求めることが多いですが、
              <b>入稿先のガイドに書いてある数字が正解です</b>
            </small>
          </p>
        </>
      )}
        </>
      )}

      {/* **電子書籍の色は、ここで決める。**(2026-09-24 ユーザー要望「電子書籍のプレビューが本文設定タブで
          見えるようになったんだから、紙書籍と同じように、電子書籍も白黒カラーかを選んだ状態で版下を
          作成できた方がいい」) もとは紙を白黒で刷る本のときだけ、書き出しの画面で選んでいた。
          紙の刷り色とは別の値(settings.ebookMono。古い epubMono は読み込むときに移す)。電子だけの本でも選べる */}
      {out.ebook && (
        <>
          <h2>電子書籍の色</h2>
          <label className="stack">
            色
            <select
              value={settings.ebookMono ? 'mono' : 'color'}
              onChange={(e) => setSettings({ ebookMono: e.target.value === 'mono' })}
            >
              <option value="color">カラー</option>
              <option value="mono">白黒</option>
            </select>
          </label>
          <p className="hint">
            白黒にすると、<b>本文に入れた画像（挿絵・文中の画像）</b>を白黒にして入れます
            {out.paper && '（紙の刷り色とは別に選べます）'}。
            表紙はいつもカラーです。文字の色は読む人の端末が決めます。
            <small className="hint-sub">白黒の指示を読み取らない端末では、画像がカラーのまま出ることがあります</small>
          </p>
        </>
      )}

      {/* 電子書籍にはページが無いので「刷るもの」とは言わない。残るのは目次だけ */}
      <h2>{out.paper ? 'ページに刷るもの' : '目次'}</h2>
      <label className="stack">
        目次ページ
        <select
          value={settings.toc ? 'on' : 'off'}
          onChange={(e) => setSettings({ toc: e.target.value === 'on' })}
        >
          <option value="on">入れる</option>
          <option value="off">入れない</option>
        </select>
      </label>
      <p className="hint">目次のページは扉の次に入り、章のタイトルとページ番号を点線でつないで並べます</p>

      {/* ノンブルと柱は**紙のページにしか刷らない**(電子書籍にはページが無い)。
          電子書籍だけを作る本には出さない */}
      {out.paper && (
        <>
      <h3 className="bg-label">ページ番号（ノンブル）</h3>
      <SlotPad
        value={nombreSlot}
        onChange={(v) => setSettings({ nombreSlot: v })}
        other={{ slot: headSlot, mark: '柱', label: '柱' }}
      />

      <h3 className="bg-label">ヘッダー・フッター（柱）</h3>
      <SlotPad
        value={headSlot}
        onChange={(v) => setSettings({ runningHeadSlot: v })}
        other={{ slot: nombreSlot, mark: '①', label: 'ページ番号' }}
      />
      {/* **「入れない」を選んだら、その先は出さない。**
          柱を使わない人にとっては、文字も出すページも書体も意味の無い3行になる */}
      {headSlot !== 'none' && (
        <>
          <label className="stack">
            入れる文字
            <select
              value={headText}
              onChange={(e) =>
                setSettings({ runningHeadText: e.target.value as 'chapter' | 'title' })
              }
            >
              <option value="chapter">章のタイトル</option>
              <option value="title">本の書名</option>
            </select>
          </label>
          <label className="stack">
            出すページ
            <select
              value={headPages}
              onChange={(e) =>
                setSettings({ runningHeadPages: e.target.value as 'recto' | 'verso' | 'both' })
              }
            >
              <option value="recto">奇数ページだけ（和書の定番）</option>
              <option value="verso">偶数ページだけ</option>
              <option value="both">両方のページ</option>
            </select>
          </label>
        </>
      )}
      <p className="hint">ページ番号と柱は、扉・目次・奥付のページには刷りません</p>
      {sameSlot && (
        <p className="warn">
          <b>ページ番号と柱が同じ場所を取り合っています。</b>
          ページ番号を優先するので、柱は刷りません
        </p>
      )}

      {/* **書体は画面下の帯へ移した。**(2026-10-09 ユーザー判断「デザインに関連する話は下のバーで」)
          ここに残すのは、出すかどうかと位置(決め切るもの) */}
      <p className="hint">ページ番号と柱の書体は、画面下の帯の［ノンブル・柱の書体］で変えます（帯の対象が「本全体」のときに設定できます）</p>

        </>
      )}

      {/* 底のかくれカエル(決まりは FrogMark.tsx)。器えらびは、のんびり */}
      <div className="frog-sit" aria-hidden="true">
        <FrogPeek width={40} />
      </div>
    </>
  );
}
