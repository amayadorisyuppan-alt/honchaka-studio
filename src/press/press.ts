// 入稿用の変換の、画面から呼ぶ入り口。
//
// なぜ要るか(2026-09-26 印刷所の入稿ガイドの例): 白黒のページは K1色かグレースケールで、RGB のデータは不可。
// Chrome の印刷で保存した PDF は、黒い字も RGB(0 0 0 rg)で入っている。RGB の黒は刷るときに4色の掛け合わせになり、
// にじみや色付きの元になる。KDP はどちらでも受け付ける。カラーの本は CMYK(Japan Color 2011 Coated)にして、
// インクの総量を抑える。変換の流れは pipeline.ts、動かす場所は gsWorker.ts。
//
// ここは Worker を作って1回だけ使い、終わったら捨てる
// (Ghostscript は約15MB。260ページの変換で、文字だけなら約1.4GB・絵が多いと約2.1GB使うので、持ち続けない)。
//
// **画面から外れるとき・取り消すときは、AbortSignal で Worker を止める**(terminate)。
// 止めないと、変換が裏で走り続け、終わったあと画面にいない利用者へ勝手にファイルを保存し、
// 戻って押し直すと Worker が2つ同時に動いてメモリを食い合う(2-3 の 4)。

import type { PressDone, PressMessage, PressRequest } from './gsWorker';
import type { PressErrorOrigin, PressKind, PressPhase, PressResult } from './pipeline';
import type { PaperMismatch, PressBoxes } from './types';

export type { PressErrorOrigin, PressKind, PressPhase, PressResult };

export interface PressProgress {
  phase: PressPhase;
  /** 変換の済んだページ(変換中だけ) */
  page?: number;
  total?: number | null;
}

export interface PressJobInput {
  kind: PressKind;
  /** 保存した PDF(Worker へ所有権ごと渡すので、呼んだあとは使えない) */
  pdf: ArrayBuffer;
  boxes: PressBoxes;
  /** 書名(PDF の Title に入る) */
  title: string;
  /** インクの総量の上限(%)。カラーのときだけ使う */
  inkLimit: number;
  /** グレーの濃さの直しをするか。省いたら true(今までどおり直す)。KDP の白黒を K1色で試すときは false */
  grayTone?: boolean;
}

/**
 * 変換の失敗。message は利用者向けの日本語(英語の生のエラーは入らない)。
 * origin は原因で、画面は file のときだけ「選んだファイルを確かめてください」と言う
 * (pipeline.ts の PressError と同じ形。Worker の外へはメッセージで届くので、ここで作り直す。
 * pipeline.ts を値として import すると、pdf-lib まで画面の側の塊に入ってしまう)
 */
export class PressFailure extends Error {
  origin: PressErrorOrigin;
  /** message だけで、次にすることまで言えている(画面は「選んだファイルを確かめてください」を足さない) */
  complete: boolean;
  /** 紙の大きさが、いまの本の用紙と違った(値)。画面は書き出し直しの案内を付けて言う */
  paperMismatch?: PaperMismatch;
  constructor(message: string, origin: PressErrorOrigin, extra: { complete?: boolean; paperMismatch?: PaperMismatch } = {}) {
    super(message);
    this.name = 'PressFailure';
    this.origin = origin;
    this.complete = extra.complete === true;
    this.paperMismatch = extra.paperMismatch;
  }
}

const MSG_TOOL = '変換の道具を読み込めませんでした。通信を確かめて、ページを読み込み直してください';

/** 取り消されたときに reject する例外。呼んだ側は signal.aborted で見分けて、何も言わず何も保存しない */
function abortError(): Error {
  return new DOMException('変換を取り消しました', 'AbortError');
}

/** 入稿用の変換を1本する。進み具合は onProgress で返す。signal が中止されたら Worker を止めて、AbortError で reject する */
export function convertPress(job: PressJobInput, onProgress: (p: PressProgress) => void, signal?: AbortSignal): Promise<PressResult> {
  return new Promise((resolve, reject) => {
    // Worker を作る前に取り消されていたら、何も始めない(pdf は渡していないので、呼んだ側のものが残る)
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const worker = new Worker(new URL('./gsWorker.ts', import.meta.url), { type: 'module' });
    const id = 1;
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(abortError());
    };
    const settle = () => {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (ev: MessageEvent<PressMessage>) => {
      if (settled) return;
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'phase') onProgress({ phase: m.phase });
      else if (m.type === 'progress') onProgress({ phase: 'convert', page: m.page, total: m.total });
      else if (m.type === 'done') {
        settle();
        const { id: _id, type: _type, ...rest } = m;
        void _id;
        void _type;
        const done: PressDone = rest;
        resolve({ ...done, pdf: new Uint8Array(done.pdf) });
      } else {
        settle();
        // 画面に出すのは言葉だけ。Ghostscript の出力や英語の生のエラーは開発者向けにコンソールへ
        if (m.log) console.warn('[press] 変換の失敗の詳細:\n' + m.log);
        reject(new PressFailure(m.message, m.origin, { complete: m.complete, paperMismatch: m.paperMismatch }));
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      settle();
      // Worker の読み込み自体に失敗した(gsWorker-*.js が取れない・構文が読めない)。英語の理由はコンソールへ
      console.warn('[press] 変換の道具(Worker)を動かせませんでした:', e.message || '読み込みに失敗');
      reject(new PressFailure(MSG_TOOL, 'tool'));
    };
    const req: PressRequest = { id, kind: job.kind, pdf: job.pdf, boxes: job.boxes, title: job.title, inkLimit: job.inkLimit, grayTone: job.grayTone };
    worker.postMessage(req, [job.pdf]);
  });
}
