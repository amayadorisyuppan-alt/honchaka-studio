// 入稿用の変換を受け持つ Web Worker。**Ghostscript(WebAssembly 版)と pdf-lib をここだけで動かす。**
//
// 中身(部品を順に通す流れ)は src/press/pipeline.ts。ここは殻だけ:
// Ghostscript と ICC を読み込み、pipeline を呼び、進み具合を画面の側へ知らせる。
// 画面の側の入り口は src/press/press.ts。
//
// **画面を止めないために Worker に置く。** 260ページの本で Ghostscript が1〜2分、pdf-lib の読み書きも
// 数秒かかる(2026-09-27 試作の実測。Worker の中なら画面は 131 秒のあいだ一度も止まらなかった)。
// **Ghostscript は 1 回ごとに作り直す。** C の中の状態は2回目の呼び出しを想定していない
// (同じ Node のプロセスで3回続けて作り直すと3回目が落ちた、という報告もある)。
// だから Worker ごと使い捨てにして(press.ts)、メモリ(260ページで 1.4〜2.1GB。実測は pipeline.ts)もその場で返す。
// **1つの Worker に2回目のリクエストが来たら、受け付けずに失敗で返す**(2回目を想定していない作りを、黙って動かさない)。
//
// ライセンス: Ghostscript と @okathira/ghostpdl-wasm は AGPL-3.0。このアプリも AGPL なので組み込める。
// 入手先は［このアプリについて］と licenses/THIRD-PARTY-NOTICES.txt に書いてある。
import gsWasmUrl from '@okathira/ghostpdl-wasm/gs.wasm?url';
import iccUrl from './JapanColor2011Coated.icc?url';
import { PressError, runPress } from './pipeline.ts';
import type { GsModule, PressErrorOrigin, PressKind, PressPhase, PressResult } from './pipeline.ts';
import type { PaperMismatch, PressBoxes } from './types.ts';

type GsFactory = (opts: Record<string, unknown>) => Promise<GsModule>;

export interface PressRequest {
  id: number;
  kind: PressKind;
  /** 利用者が保存した PDF */
  pdf: ArrayBuffer;
  boxes: PressBoxes;
  title: string;
  inkLimit: number;
  /** グレーの濃さの直しをするか。省いたら true */
  grayTone?: boolean;
}

/** 画面の側へ返す結果。pdf だけ ArrayBuffer(所有権ごと渡す) */
export type PressDone = Omit<PressResult, 'pdf'> & { pdf: ArrayBuffer };

export type PressMessage =
  | { id: number; type: 'phase'; phase: PressPhase }
  | { id: number; type: 'progress'; page: number; total: number | null }
  | ({ id: number; type: 'done' } & PressDone)
  /**
   * origin は失敗の原因(file=選んだファイル・tool=変換の道具の読み込み・internal=途中で止まった)。画面が助言を変える。
   * complete は message だけで次にすることまで言えている印(画面は助言を足さない)。paperMismatch は紙の大きさの違い(値)
   */
  | { id: number; type: 'error'; message: string; log: string; origin: PressErrorOrigin; complete?: boolean; paperMismatch?: PaperMismatch };

const post = (m: PressMessage, transfer: Transferable[] = []) => self.postMessage(m, { transfer });

/**
 * JPEG をほどいて画素にする(neutral.ts が「R=G=B の画素だけの JPEG か」を調べるのに使う)。
 * **色の管理で値が変わらないように** colorSpaceConversion: 'none' で作る。ほどけなければ null。
 * **EXIF の向きも効かせない**(imageOrientation: 'none')。Ghostscript は PDF の中の JPEG の EXIF を見ないので、
 * 向きを効かせると、向きが 180° の無彩色 JPEG(幅×高さが同じ)が上下逆のグレー画像になる(2-2 の C。Node では確かめられない)。
 * 'none' を受け付けない環境で例外になったら、指定を外してやり直す
 */
async function decodeImage(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array } | null> {
  try {
    const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', imageOrientation: 'none' });
    } catch {
      bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    }
    try {
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const g = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
      if (!g) return null;
      g.drawImage(bmp, 0, 0);
      const data = g.getImageData(0, 0, bmp.width, bmp.height);
      return { width: bmp.width, height: bmp.height, rgba: new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength) };
    } finally {
      bmp.close();
    }
  } catch {
    return null;
  }
}

let used = false;

self.onmessage = async (ev: MessageEvent<PressRequest>) => {
  // **入力の ArrayBuffer を、ここで変数に取り出さない。** 取り出すと、この非同期関数が終わるまで(=変換が終わるまで)
  // 元の ArrayBuffer が生き残り、入力の大きさ(32〜95MB)ぶんのメモリが無駄になる(V8 で再現。2-3 の 6)。
  // Uint8Array に包んで runPress に渡し、受け取った側の欄は null にしておく
  const req = ev.data;
  const { id, kind, boxes, title, inkLimit, grayTone } = req;
  if (used) {
    post({ id, type: 'error', message: '変換の道具は1回しか使えません。ページを読み込み直してください', log: '', origin: 'internal' });
    return;
  }
  used = true;
  try {
    const job = { kind, pdf: new Uint8Array(req.pdf), boxes, title, inkLimit, grayTone, now: new Date() };
    (req as unknown as { pdf: null }).pdf = null;
    const result = await runPress(
      job,
      {
        async createGs(onLine) {
          const factory = (await import('@okathira/ghostpdl-wasm')).default as unknown as GsFactory;
          return factory({
            noInitialRun: true,
            // Vite が別のファイル名で配る gs.wasm の場所を教える(base: './' なので相対のまま効く)
            locateFile: (path: string) => (path.endsWith('.wasm') ? gsWasmUrl : path),
            print: onLine,
            printErr: onLine,
          });
        },
        async loadIcc() {
          // 失敗の英語(`Failed to fetch`・HTTP の番号)は、pipeline が「変換の道具を読み込めませんでした」に包んで log へ回す
          const res = await fetch(iccUrl);
          if (!res.ok) throw new Error(`ICC の読み込みに失敗(HTTP ${res.status})`);
          return new Uint8Array(await res.arrayBuffer());
        },
        decodeImage,
        onPhase: (phase) => post({ id, type: 'phase', phase }),
        onProgress: (page, total) => post({ id, type: 'progress', page, total }),
      },
    );
    // pdf だけ ArrayBuffer にして、所有権ごと返す。**コピーしない**:
    // pdf-lib の save は丁度の大きさの Uint8Array を返すので、その buffer をそのまま渡せる(丸ごとコピーすると 62.6MB の出力で一瞬 2 倍になった)。
    // 丁度でないとき(別の部品が大きな buffer の一部を返したとき)だけ、必要な範囲を切り出す
    const p = result.pdf;
    const buf = (p.byteOffset === 0 && p.byteLength === p.buffer.byteLength ? p.buffer : p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength)) as ArrayBuffer;
    post({ id, type: 'done', ...result, pdf: buf }, [buf]);
  } catch (e) {
    if (e instanceof PressError) {
      post({ id, type: 'error', message: e.message, log: e.log, origin: e.origin, complete: e.complete, paperMismatch: e.paperMismatch });
    }
    else post({ id, type: 'error', message: '変換の途中で、うまくいかないことがありました', log: String((e as Error)?.stack ?? e), origin: 'internal' });
  }
};
