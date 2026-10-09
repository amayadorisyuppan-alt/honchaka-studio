// ［紙の表紙］の書き出しの欄。**出し先が印刷所のときは、1回押すだけで入稿用(CMYK・PDF/X-4)まで作る。**
//
// 本文と違って、表紙はスタジオが自分で PDF を作る(印刷ダイアログを通らない)。
// だから「RGB の PDF を作る → そのまま入稿用に変える」を1つのボタンにまとめられる(2026-10-01)。
// 本文のように PDF を選び直させる手間は要らない。変換の中身は src/press、PDF を作って渡すのは CoverEditor.exportPaperPdf。
//
// KDP は RGB の PDF をそのまま受け付けるので、いままでどおり RGB の PDF を保存するだけ(余計な欄を出さない)。
//
// **変換に失敗したときは、理由を言って、RGB のままの PDF を保存できる逃げ道を出す。**
// 画面と同じ色(RGB)のまま書き出す道は、成功したときにも小さく置く(校正用・印刷所へ出さない用途)
import { useEffect, useRef, useState } from 'react';
import { safeFileStem } from '../project/file';
import type { PressProgress } from '../press/press';
import type { InkReport } from '../press/types';
import { FrogPeek } from './FrogMark';
import { IssueList, PressProgressLine } from './PressConvert';
import { inkSentence, megabytes, savedHeadline } from './pressText';

/** 表紙の PDF を作る段(RGB の PDF を描く)と、変換の段(PressProgress) */
export type CoverPdfProgress = PressProgress | { phase: 'draw' };

export interface CoverPdfOptions {
  /** true なら、出し先が印刷所でも変換せず、画面と同じ色(RGB)のまま保存する */
  rgb?: boolean;
  onProgress?: (p: CoverPdfProgress) => void;
  /** 画面から外れるとき・取り消すときに中止する。中止されたら、変換を止めて、何も保存しない */
  signal?: AbortSignal;
}

/** 表紙の書き出しの結果。CoverEditor.exportPaperPdf が返し、画面はこれを言葉にする */
export type CoverPdfOutcome =
  | { kind: 'saved-rgb'; name: string; bytes: number }
  | { kind: 'saved-cmyk'; name: string; bytes: number; ink: InkReport | null; issues: string[] }
  /** RGB の PDF は作れたが、入稿用への変換に失敗した(message は利用者向けの文) */
  | { kind: 'press-failed'; message: string }
  /** PDF を作るところで失敗した(理由は App の常時表示のエラーに出してある)か、中止された(何も言わない) */
  | { kind: 'error' };

type State =
  | { kind: 'idle' }
  | { kind: 'running'; progress: CoverPdfProgress }
  | { kind: 'done'; outcome: CoverPdfOutcome };

interface Props {
  /** true なら入稿用に変える(出し先が RGB を受け付けない印刷所) */
  convert: boolean;
  bookTitle: string;
  /** 背幅がまだ決まっていない(本文のページ数を数え中)あいだは押させない */
  disabled: boolean;
  exportCover: (opts: CoverPdfOptions) => Promise<CoverPdfOutcome | null>;
}

export function PressCover({ convert, bookTitle, disabled, exportCover }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  // 動いている書き出しの取り消し口。画面から外れるときに変換を止める(止めないと、外れたあとに勝手に保存される)
  const ctlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      ctlRef.current?.abort();
    },
    [],
  );
  const running = state.kind === 'running';
  const stem = safeFileStem(bookTitle, 'cover');

  async function run(rgb: boolean) {
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setState({ kind: 'running', progress: { phase: 'draw' } });
    try {
      const outcome = await exportCover({
        rgb,
        signal: ctl.signal,
        onProgress: (progress) => {
          if (!ctl.signal.aborted) setState({ kind: 'running', progress });
        },
      });
      if (ctl.signal.aborted) return;
      setState(outcome && outcome.kind !== 'error' ? { kind: 'done', outcome } : { kind: 'idle' });
    } catch {
      if (!ctl.signal.aborted) setState({ kind: 'idle' });
    } finally {
      if (ctlRef.current === ctl) ctlRef.current = null;
    }
  }

  const done = state.kind === 'done' ? state.outcome : null;

  return (
    <div className="press-cover">
      {convert && (
        <p className="hint">
          印刷所むけに、<b>印刷用の色（CMYK・PDF/X-4）</b>に変換して「{stem}_表紙_CMYK.pdf」で保存します。
          <b>鮮やかな青・緑・ピンクは、印刷ではすこし沈みます。</b>
          はじめは変換の道具（十数MB）の読み込みで、少し時間がかかります
        </p>
      )}
      <button className="primary-action" disabled={disabled || running} onClick={() => void run(false)}>
        {running ? '書き出し中…' : '紙の表紙を書き出す（PDF）'}
      </button>
      {convert && (
        <p className="hint">
          校正用など、印刷所へ出さないときは
          <button className="link-btn" disabled={running} onClick={() => void run(true)}>
            画面と同じ色（RGB）のまま書き出す
          </button>
        </p>
      )}

      {state.kind === 'running' && (
        <PressProgressLine
          kind="cover-cmyk"
          progress={state.progress as PressProgress}
          drawText={state.progress.phase === 'draw' ? '表紙の画像を PDF にしています…' : undefined}
        />
      )}

      {convert && done?.kind === 'saved-cmyk' && (
        <div className="press-done" role="status">
          {/* 確かめることが無いときだけ、カエルが喜ぶ(本文の PressConvert と同じ) */}
          {done.issues.length === 0 && (
            <span className="done-frog" aria-hidden="true">
              <FrogPeek width={34} mood="happy" />
            </span>
          )}
          <p>
            <b>{savedHeadline(done.issues.length > 0)}</b>「{done.name}」（{megabytes(done.bytes)}）を保存しました。
          </p>
          {inkSentence(done.ink) && <p>{inkSentence(done.ink)}</p>}
          <p className="hint">
            鮮やかな青・緑・ピンクは、印刷ではすこし沈みます。画面の色と見比べたいときは、保存した PDF を開いて確かめてください。
          </p>
          <IssueList issues={done.issues} />
        </div>
      )}

      {convert && done?.kind === 'saved-rgb' && (
        <div className="press-done" role="status">
          <p>
            <b>保存しました。</b>「{done.name}」（{megabytes(done.bytes)}）は、画面と同じ色（RGB）のままです。
          </p>
          <p className="warn">印刷所が RGB の PDF を受け付けるかは、入稿の前に印刷所に確かめてください</p>
        </div>
      )}

      {done?.kind === 'press-failed' && (
        <div className="press-done" role="alert">
          <p className="warn">
            印刷用の色（CMYK）に変換できませんでした。理由: {done.message}
          </p>
          <p className="hint">
            もう一度［紙の表紙を書き出す（PDF）］を押すか、次のボタンで、画面と同じ色（RGB）のまま保存できます。
            印刷所によっては RGB の PDF を受け付けないので、入稿の前に確かめてください
          </p>
          <button className="go-step" disabled={running} onClick={() => void run(true)}>
            画面と同じ色（RGB）のまま保存する
            <small>「{stem}_表紙.pdf」で保存します</small>
          </button>
        </div>
      )}
    </div>
  );
}
