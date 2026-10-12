// ［紙の本文］の書き出しの画面の中身(2026-10-03 作り直し)。
//
// ユーザーの言「2度出しが必要な人が、いまの UI では理解できそうにない」「印刷する場所を選ばせるのだから、それに合ったものだけ出せばいい」。
// 以前は、［書き出す］の下に長い説明が3つ続き、その下に「変換する」の別の欄が付いていた。2段あることが読み取れなかった。
// 作り直しの形: **要る出し先は、「①RGB の PDF を保存」→(矢印)→「②入稿用に変換」の2つの箱。**
// (2026-10-03 ユーザー「ステップが必要だということがわからない」。番号・矢印・「済み」の印・「入稿用」の札で流れを目で追わせる)
// - 何を出すかは bodyOutputOf(出し先 × 刷り色)が決める。この画面は出し先の名前を見ない
// - 要る(required): ①の箱に主ボタン、②の箱に保存した PDF を落とす囲み(最初から見える。探させない)。
//   ①から戻ると①に「済み」・②の箱を強調。②が終わると②に「済み」と入稿に使うファイル名を大きく
// - 任意(optional。KDP の白黒): 本線は RGB。K1色は、畳んだ「試したいとき」の中に置く(しなくても入稿できる)
// - 要らない(none。KDP のカラー): 手順の③は「KDP の入稿画面で選ぶ」。囲みは出さない
// - 細かい話(余白・ページ数・背景)は、畳んだ「うまくいかないとき」へ
// 主ボタンを押せない条件は printBlockedReason の1か所(中綴じの 4 の倍数など、後から足す条件は blockReason で渡す)。
// フォルダを許可して自動で変換する道は、まだ作っていない(設計は D2。この画面の上に乗せる)。
import { useEffect, useRef, useState } from 'react';
import type { InkColor, PrintTargetProfile } from '../models/project';
import { safeFileStem } from '../project/file';
import type { BodyBoxes } from '../press/types';
import { bodyOutputOf, printBlockedReason } from './bodyOutput';
import { PressConvert } from './PressConvert';
import { selfCoverNotes } from '../typeset/saddle';

interface Props {
  /** 紙の本文のページ数。**いまの本の姿で組み上がっているときだけ**数、まだなら null */
  paperPages: number | null;
  printing: boolean;
  /**
   * 印刷の画面を開いて PDF を保存してもらう。**うまくいったかを返す**(失敗・中止なら false)。
   * 失敗したのに①に「済み」を付けない(2026-10-03 監査)
   */
  onPrintPdf: () => Promise<boolean> | void;
  onOpenBodyPreview: () => void;
  printProfile: PrintTargetProfile;
  /** 塗り足しの伝え方の文(出し先で違う。printProfile.bleedNote を呼んだ結果) */
  bleedNote: string;
  ink: InkColor;
  bookTitle: string;
  /** 用紙(仕上がり＋塗り足し)の寸法 mm。別の本の PDF を渡していないかを見る */
  paperMm: { w: number; h: number };
  boxes: BodyBoxes;
  /** 主ボタンを押せなくする理由(あれば、押せず、この文を出す)。中綴じの「4の倍数」などを足す口 */
  blockReason?: string | null;
  /**
   * 中綴じの本のときだけ渡す(2026-10-03)。ページ数が 4 の倍数なことを言い、共紙(self)なら
   * 「表紙もこの PDF に入る」「文字も画像になる」(白黒の本は白黒で刷られる)を短く添える
   */
  saddle?: { self: boolean };
  /** 変換で数えたカラーのページの数(終わっていなければ null)を App に知らせる。出し先の控え(orderSheet)の刷り色に使う(2026-10-12) */
  onColorPages?: (r: { count: number; total: number } | null) => void;
}

export function PaperBodyExport({
  paperPages,
  printing,
  onPrintPdf,
  onOpenBodyPreview,
  printProfile,
  bleedNote,
  ink,
  bookTitle,
  paperMm,
  boxes,
  blockReason,
  saddle,
  onColorPages,
}: Props) {
  const out = bodyOutputOf(printProfile, ink);
  const required = out.convert === 'required';
  const blocked = printBlockedReason({ printing, blockReason });
  // 落とす囲みの外へ PDF を落としても、Chrome がタブをその PDF に切り替えない(スタジオが消えない)ようにする。
  // 画面のどこへ落としても何も起きない。囲みの中だけが受け取る。(2026-10-03 監査)
  // **この画面が出ている間だけ**。ファイルが運ばれている間は、囲みを光らせて「ここへ」と示す
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!required && out.convert !== 'optional') return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
    };
    const onLeave = (e: DragEvent) => {
      // ウィンドウの外へ出たときだけ消す(relatedTarget が無いとき)
      if (!e.relatedTarget) setDragging(false);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragleave', onLeave);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragleave', onLeave);
      setDragging(false);
    };
  }, [required, out.convert]);
  // 印刷の画面から戻って、**保存の手順がうまく終わったら**、①に「済み」の印を付け、②の箱を少し目立たせる(ここで終わりだと思わせない)。
  // 失敗したときは付けない。①をやり直したら、②の古い「済み」と古いファイル名は消す(PressConvert を作り直して空に戻す)
  const [attention, setAttention] = useState(false);
  const [step1Done, setStep1Done] = useState(false);
  const [convertedName, setConvertedName] = useState<string | null>(null);
  const [convertRound, setConvertRound] = useState(0);
  const attentionTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(attentionTimer.current), []);
  async function savePdf() {
    const ok = await onPrintPdf();
    // void を返す呼び手(ok が undefined)は、うまくいったものとみなす。false のときだけ見送る
    if (ok === false || !required) return;
    setStep1Done(true);
    setConvertRound((n) => n + 1);
    setAttention(true);
    window.clearTimeout(attentionTimer.current);
    attentionTimer.current = window.setTimeout(() => setAttention(false), 6000);
  }
  const convertProps = {
    bookTitle,
    ink,
    expectedPages: paperPages,
    paperMm,
    boxes,
    inkLimit: printProfile.inkLimitPct,
    colorPagesNote: printProfile.colorPagesNote,
    grayTone: out.grayTone,
    glow: dragging,
  };
  const stem = safeFileStem(bookTitle, '本');

  return (
    <div className="paper-stage">
      {/* **①で終わったと思わせない。** 変換が要る出し先では、見出しのすぐ下で言い切る(2026-10-07 ユーザー要望
          「①では入稿ができないから、必ず①のデータを②に入れて変換して下さい」。どの印刷所でも同じ)。文面は Gemini Pro の案 */}
      {required && (
        <p className="press-lead">
          <b>①で保存した PDF は{printProfile.pressName ?? '印刷所'}に入稿できないため、必ず②に入れて変換してください。</b>
          受け付けるのは、②で変換した PDF だけです。名前の最後が「_{out.suffix}」に変わった PDF を入稿してください。
        </p>
      )}
      <p className="paper-pages">
        {paperPages !== null ? (
          <>
            この本文は <b>{paperPages} ページ</b>の PDF になります
            {saddle && <>（中綴じ・4 の倍数{saddle.self ? '・表紙の4ページを含む' : ''}）</>}
          </>
        ) : (
          <>ページ数は、紙の下見が組み上がると出ます（下のボタンで下見を開くと数えます）</>
        )}
      </p>
      {/* **ほかの工程へ移るボタンは、4つの画面で同じ言い方・同じ見た目。**(2026-09-24 ユーザー指摘
          「『表紙を直す』『紙の本文を下見で確かめる』は同じ作業なのに言葉が違う」) 移るボタンと戻るボタンは
          .go-step(枠だけ)、塗りつぶしは［書き出す］だけ */}
      <button className="go-step" onClick={onOpenBodyPreview}>
        紙の本文を確かめる・直す →<small>［本のかたちを決める］の下見へ移ります</small>
      </button>
      {/* 共紙は表紙のファイルが別に無い。表紙もこの PDF の最初と最後に入ることを、ここで言い切る */}
      {saddle?.self && (
        <p className="hint">
          {selfCoverNotes(ink).map((t) => (
            <span key={t}>
              {t}。
            </span>
          ))}
        </p>
      )}
      {required ? (
        // 2段の箱を矢印でつなぐ。①で RGB の PDF を保存し、②でそれを入稿用に変える
        // (2026-10-03 ユーザー「ステップが必要だということがわからない。①RGBデータをつくる ②①のデータをCMYKデータにする、
        //  みたいなことがわかるように。番号を付ける。矢印で流れを感じさせる」)
        <div className="press-flow">
          <section className={`press-step${step1Done ? ' done' : ''}`} aria-labelledby="press-step-1">
            <div className="press-step-head">
              <span className="press-num" aria-hidden="true">
                ①
              </span>
              <h3 id="press-step-1">画面の色（RGB）の PDF を保存する</h3>
              {step1Done && <span className="press-badge done">済み</span>}
            </div>
            <button className="primary-action" disabled={blocked !== null} onClick={() => void savePdf()}>
              {printing ? '組版中…' : step1Done ? '本文の PDF をもう一度保存する' : '本文の PDF を保存する（印刷の画面が開きます）'}
            </button>
            {blocked && !printing && (
              <p className="warn" role="status">
                {blocked}
              </p>
            )}
            <p className="press-step-note">
              印刷の画面で、<b>「送信先: PDFに保存」</b>を選んで［保存］します（ほかは変えません）
            </p>
            <p className="press-file">
              できる PDF<code>{stem}_本文.pdf</code>
              <span className="press-file-use">校正用（画面と同じ色）</span>
            </p>
          </section>

          <div className="press-arrow" aria-hidden="true">
            ↓
          </div>

          <section
            className={`press-step press-step-2${convertedName ? ' done' : step1Done ? ' next' : ''}${attention ? ' attention' : ''}`}
            aria-labelledby="press-step-2"
          >
            <div className="press-step-head">
              <span className="press-num" aria-hidden="true">
                ②
              </span>
              <h3 id="press-step-2">
                ①の PDF を、印刷用の{ink === 'color' ? '色（CMYK）' : '黒1色（K1色）'}に変換する
              </h3>
              <span className="press-badge use">入稿用</span>
              {convertedName && <span className="press-badge done">済み</span>}
            </div>
            <PressConvert key={convertRound} {...convertProps} onConverted={setConvertedName} onColorPages={onColorPages} />
            <p className={`press-file${convertedName ? ' ready' : ''}`}>
              {convertedName ? '入稿に使うファイル' : 'できる PDF'}
              <code>{convertedName ?? `${stem}_本文_${out.suffix}.pdf`}</code>
              <span className="press-file-use">入稿に使うのは、こちらです</span>
            </p>
          </section>
        </div>
      ) : (
        <>
          <button className="primary-action" disabled={blocked !== null} onClick={() => void savePdf()}>
            {printing ? '組版中…' : '紙の本文を書き出す（PDF）'}
          </button>
          {blocked && !printing && (
            <p className="warn" role="status">
              {blocked}
            </p>
          )}
          {/* 手順は2行。**ダイアログでは何も変えさせない。**(2026-09-14 ユーザー実測: 余白「なし」はかえって縮んで崩れ、
              背景のグラフィックはオン/オフで変わらなかった。経緯は畳んだ「うまくいかないとき」) */}
          <ol className="press-steps">
            <li>上のボタンを押します（印刷の画面が開きます）</li>
            <li>
              印刷の画面で、<b>「送信先: PDFに保存」</b>を選んで［保存］します（ほかは変えません）
            </li>
            <li>保存した PDF を、そのまま入稿の画面で選びます</li>
          </ol>
        </>
      )}

      {out.convert === 'optional' && (
        <details className="press-more">
          <summary>白黒（K1色）の PDF も試したいとき（しなくても入稿できます）</summary>
          <p className="hint">Amazon KDP は、保存した PDF（RGB）のままで入稿できます。RGB と見比べたいときだけ、使ってください。</p>
          <PressConvert {...convertProps} optional />
        </details>
      )}

      {/* 塗り足しの伝え方は出し先で違う(PRINT_TARGETS の bleedNote)。「裁ち落としあり」を印刷ダイアログの中で探させない
          (2026-09-04 ユーザー報告)ため、選ぶ場所が別の画面なら、そう言い切る */}
      <p className="hint">{bleedNote}</p>

      <details className="press-more">
        <summary>うまくいかないとき</summary>
        <ul className="press-points">
          <li>
            印刷の画面に出るページ数が、上のページ数と同じなら、正しく出ています
          </li>
          <li>
            <b>余白は「デフォルト」のまま</b>にしてください。「なし」に変えると、かえって縮んで崩れます
          </li>
          <li>背景の画像が白く抜けたときだけ、「背景のグラフィック」をオンにします</li>
          {required && <li>保存した PDF の名前は、何でもかまいません。囲みへそのまま落としてください</li>}
        </ul>
      </details>
    </div>
  );
}
