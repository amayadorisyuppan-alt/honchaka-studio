// ［紙の本文］の「保存した PDF をここへ」の囲み。保存した本文 PDF を、入稿用(白黒は K1色・カラーは CMYK。PDF/X-4)に変える。
// 出す条件と、何に変えるかは bodyOutput.ts(bodyOutputOf)が決める。この部品は、囲み・進み具合・できあがりの報告だけを持つ
// (変換の流れは usePressConvert.ts に切り出した。2026-10-03)。
//
// 本文 PDF は Chrome の印刷ダイアログで保存するので、スタジオはその中身を受け取れない。
// だから**保存した PDF を、囲みに落とすか［選ぶ］で渡してもらい**、それを入稿用に変えて保存させる。
// 囲みは、手順の③として**最初から見えている**(探させない。2026-10-03 ユーザー「2度出しが必要な人が、いまの UI では理解できそうにない」)。
// 変換の中身は src/press/press.ts(入り口)・pipeline.ts(流れ)・gsWorker.ts(Worker)。
// 表紙はスタジオが自分で PDF を作るので、こちらを通らず書き出しと同時に変える(PressCover.tsx)。
//
// **紙の大きさが、いまの本の用紙と違う PDF は、変換せずに止める。**(2026-10-01)
// 別の本の PDF や、判型・塗り足しを変える前の PDF に、いまの本の箱(仕上がりの枠)を付けて入稿させると、
// 仕上がりの位置が狂う。「箱が付いていない」より悪いので、書き出し直しを案内して止める。
// 変換を全部走らせてから断ると、ページの多い本で数分待たせるので、断るのは変換の前(pipeline の入口。PressFailure.paperMismatch)。
// 変換のあとの pdfx.paperMismatch(値)の点検は、守りとして残してある。どちらも値で決め、違反の文の中身を探さない
// (文を書き換えただけで、止める判断が効かなくなるため)。
// **すでに入稿用に変えた PDF**(もう一度かけるとグレーが2度濃くなる)も、変換の前に断る(失敗の文は pipeline の MSG_ALREADY)。
//
// **画面から外れるとき(戻る・別の欄を開く)は、変換を取り消す。**(2026-10-01)
// 止めないと、変換が裏で走り続け、終わったあと画面にいない利用者へ勝手にファイルを保存する。
// 変換の中身が重い(260ページで 1.4〜2.1GB)ので、押し直して2つ同時に動くのも避けたい。外れたあとは、何も保存せず、何も言わない
import { useEffect, useRef, useState } from 'react';
import { downloadBlob } from '../exporters/download';
import type { PressKind, PressProgress } from '../press/press';
import { usePressConvert, type PressConvertOptions } from './usePressConvert';
import { FrogPeek } from './FrogMark';
import {
  colorPagesSentence,
  failureText,
  inkSentence,
  issueLines,
  megabytes,
  progressRatio,
  progressText,
  savedHeadline,
} from './pressText';

interface Props extends PressConvertOptions {
  /**
   * 任意の道か。**RGB の PDF をそのまま入稿できる出し先(KDP)の白黒の本**が、K1色で試したいときの道。
   * 「しないと入稿できない」とは言わない(グレーの直しを切るのは、呼ぶ側が grayTone に false を渡す)
   */
  optional?: boolean;
  /** ファイルが画面の上を運ばれている間(囲みを光らせる。受け取りは囲みの中だけ) */
  glow?: boolean;
  /** 印刷の画面から戻った直後(②へ進むよう、囲みを少し目立たせる) */
  attention?: boolean;
  /**
   * 変換が終わった(終わった PDF の名前)・終わっていない(null)を、親の「②済み」の印に知らせる。
   * 2段の箱(PaperBodyExport)が、②の状態を箱の頭に出すため(2026-10-03)
   */
  onConverted?: (name: string | null) => void;
  /** カラーのページの一覧の下に添える一言(出し先で違う。PRINT_TARGETS の colorPagesNote)。省くと見積りの話 */
  colorPagesNote?: string;
}

/** 落とされた(選ばれた)ファイルが PDF らしいか。名前の末尾か種類で見る(印刷の保存は .pdf になる) */
function looksLikePdf(f: File): boolean {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

export function PressConvert({ optional = false, glow = false, attention = false, onConverted, colorPagesNote, ...opts }: Props) {
  const { state, running, kind, fileName, color, run } = usePressConvert(opts);
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [notPdf, setNotPdf] = useState(false);
  const what = color ? 'CMYK' : 'K1色';
  const doneName = state.kind === 'done' ? state.name : null;
  useEffect(() => {
    onConverted?.(doneName);
  }, [doneName]); // eslint-disable-line react-hooks/exhaustive-deps

  function take(f: File | undefined) {
    if (!f || running) return;
    if (!looksLikePdf(f)) {
      setNotPdf(true);
      return;
    }
    setNotPdf(false);
    // 同じファイルをもう一度選んでも動くように、選んだ記録を消しておく
    void run(f).finally(() => {
      if (fileRef.current) fileRef.current.value = '';
    });
  }

  return (
    <section className="press-convert">
      <div
        className={`press-drop${over ? ' over' : ''}${glow ? ' glow' : ''}${attention ? ' attention' : ''}${running ? ' busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!running) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files?.[0]);
        }}
      >
        <p className="press-drop-title">
          {optional ? '保存した本文 PDF をここへ落とすと、白黒（K1色）の PDF もできます' : '①で保存した PDF を、ここへ落としてください'}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => take(e.target.files?.[0])}
        />
        <button className="go-step" disabled={running} onClick={() => fileRef.current?.click()}>
          ［選ぶ］から探す
          {optional && (
            <small>
              できる PDF は「{fileName}」（{what}）です
            </small>
          )}
        </button>
      </div>
      {notPdf && (
        <p className="warn" role="alert">
          PDF のファイルではないようです。印刷の画面で保存した、本文の PDF を渡してください
        </p>
      )}
      <p className="hint">
        はじめは変換の道具（十数MB）を読み込みます。{color ? '画像の多い本やページの多い本は' : 'ページの多い本は'}数分かかります。終わるまでこの画面のままお待ちください
      </p>
      <details className="press-more">
        <summary>変換で何が変わるか</summary>
        {color ? (
          <ul className="press-points">
            <li>
              色を、印刷用の CMYK に変えます。<b>黒い字とグレーは、黒インクだけ</b>にします（文字だけのページが、カラー印刷の料金にならないため）
            </li>
            <li>濃すぎる所は、インクの重なりを {opts.inkLimit}% までに抑えます</li>
            <li>
              <b>文字・書体・画像の細かさは、そのまま</b>です
            </li>
            <li>
              <b>鮮やかな青・緑・ピンクは、印刷ではすこし沈みます</b>（CMYK では出せない色があるため）
            </li>
          </ul>
        ) : (
          <ul className="press-points">
            <li>全ページを、K（黒インク）1色だけにします。<b>文字・書体・画像の細かさは、そのまま</b>です</li>
            {/* 文は Gemini 3.8 Flash の案(2026-10-07。前の「手を加えずにそのまま変えます」は、加えないのに変える、とぶつかっていた) */}
            {optional && <li>元のPDFと見比べられるよう、グレーの濃さは補正せずそのまま変換します</li>}
          </ul>
        )}
      </details>

      {state.kind === 'running' && <PressProgressLine kind={kind} progress={state.progress} />}

      {state.kind === 'done' && (
        <div className="press-done" role="status">
          {/* 確かめることが無く「できました」で終わるときだけ、カエルが喜ぶ(2026-10-06「大人かわいい」) */}
          {state.result.issues.length === 0 && state.warnings.length === 0 && (
            <span className="done-frog" aria-hidden="true">
              <FrogPeek width={34} mood="happy" />
            </span>
          )}
          <p>
            <b>{savedHeadline(state.result.issues.length > 0 || state.warnings.length > 0)}</b>
            「{state.name}」（{state.result.pages} ページ・{megabytes(state.result.pdf.byteLength)}）を保存しました。
          </p>
          {color ? (
            <>
              <p>{colorPagesSentence(state.result.colorPages, state.result.pages)}</p>
              {state.result.colorPages.length > 0 && (
                <p className="hint">{colorPagesNote ?? '印刷所の見積りで、カラーのページ数を聞かれたときに使えます。'}</p>
              )}
              {inkSentence(state.result.ink) && <p>{inkSentence(state.result.ink)}</p>}
            </>
          ) : (
            state.result.issues.length === 0 && (
              <p className="hint">
                全ページで、K 以外の色の指定が残っていないことを確かめました。
                {optional && '入稿画面では、この PDF でも、もとの RGB の PDF でも選べます。'}
              </p>
            )
          )}
          <IssueList issues={state.result.issues} />
          {state.warnings.map((w) => (
            <p key={w} className="warn">
              {w}
            </p>
          ))}
          <button
            className="link-btn"
            onClick={() =>
              downloadBlob(new Blob([state.result.pdf as BlobPart], { type: 'application/pdf' }), state.name)
            }
          >
            もう一度保存する
          </button>
        </div>
      )}

      {state.kind === 'refused' && (
        <p className="warn" role="alert">
          {state.message}
        </p>
      )}

      {state.kind === 'error' && (
        <p className="warn" role="alert">
          {failureText(state.origin, state.message, state.complete)}
        </p>
      )}
    </section>
  );
}

/** 入稿の前に確かめることの一覧。長いときは先頭の数件と「ほか ○ 件」にする(全文は変換の結果の issues に残っている) */
export function IssueList({ issues }: { issues: string[] }) {
  const { shown, more } = issueLines(issues);
  return (
    <>
      {shown.map((issue) => (
        <p key={issue} className="warn">
          {issue}。入稿の前に印刷所に確かめてください
        </p>
      ))}
      {more > 0 && <p className="warn">ほか {more} 件あります。入稿の前に印刷所に確かめてください</p>}
    </>
  );
}

/** 進み具合の帯。drawText を渡すと、その文を言う(表紙の「PDF を作る」段は変換の外にあるため) */
export function PressProgressLine({ kind, progress, drawText }: { kind: PressKind; progress: PressProgress; drawText?: string }) {
  const ratio = progressRatio(progress);
  return (
    <div className="press-progress" role="status" aria-live="polite">
      <p className="hint">{drawText ?? progressText(kind, progress)}</p>
      {/* 分母が分かるまでは、縞の動く帯で「動いている」ことだけを言う */}
      <div className={ratio === null ? 'press-bar indeterminate' : 'press-bar'}>
        <span style={ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }} />
      </div>
    </div>
  );
}
