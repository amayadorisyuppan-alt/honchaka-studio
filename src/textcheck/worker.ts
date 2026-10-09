// 絵の中の文字を見つける Worker。**絵は外へ送らない**(この PC の中の WASM で動く)。
//
// - 実行系: onnxruntime-web(MIT)の WASM。スレッドは1本(配布先では SharedArrayBuffer が使えない: COOP/COEP を付けられない)
// - モデル: PP-OCRv4 の mobile の文字検出(DBNet。Apache-2.0)。認識(読むほう)のモデルは積まない — 要るのは位置だけ
// - WASM もモデルも、**同じ配布物の中**から読む(?url で dist に出す)。CDN は使わない
//
// 呼ぶ側(detect.ts)は、絵が要るときにはじめてこの Worker を作る。文字の検査が要らない本では、何も読み込まない
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import modelUrl from './ch_PP-OCRv4_det_infer.onnx?url';
import { DETECT_OPTIONS, lumaFromRgba, planResize, probToBoxes, rgbaToTensor, type TextBox } from './db';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
// すでに Worker の中なので、もう1段の Worker は作らせない
ort.env.wasm.proxy = false;

export interface DetectRequest {
  id: number;
  /** 画面の側で開いた絵(detect.ts の openImage。下見と同じ向き・同じ大きさ)。受け取ったら、使い終わりに閉じる */
  bitmap: ImageBitmap;
}
export type DetectResponse =
  | { id: number; ok: true; w: number; h: number; boxes: TextBox[] }
  | { id: number; ok: false; error: string };

let session: Promise<ort.InferenceSession> | null = null;
function load(): Promise<ort.InferenceSession> {
  session ??= (async () => {
    const buf = await (await fetch(modelUrl)).arrayBuffer();
    return ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })();
  // 読み込みに失敗したら、覚えない(次の絵でもう一度読みに行く。たまたまの失敗で、あとの絵まで全部だめにしない)
  session.catch(() => {
    session = null;
  });
  return session;
}

async function detect(bmp: ImageBitmap): Promise<{ w: number; h: number; boxes: TextBox[] }> {
  const s = await load();
  const w = bmp.width;
  const h = bmp.height;
  const g = planResize(w, h, DETECT_OPTIONS.limit);
  const canvas = new OffscreenCanvas(g.netW, g.netH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  // 透明な所は白(紙の色)にする
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, g.netW, g.netH);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, g.netW, g.netH);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, g.netW, g.netH).data;
  const input = new ort.Tensor('float32', rgbaToTensor(rgba, g), [1, 3, g.netH, g.netW]);
  const out = await s.run({ [s.inputNames[0]]: input });
  const prob = out[s.outputNames[0]].data as Float32Array;
  const boxes = probToBoxes(prob, lumaFromRgba(rgba, g.netW * g.netH), g);
  return { w, h, boxes };
}

self.onmessage = async (e: MessageEvent<DetectRequest>) => {
  const { id, bitmap } = e.data;
  let res: DetectResponse;
  try {
    res = { id, ok: true, ...(await detect(bitmap)) };
  } catch (err) {
    res = { id, ok: false, error: String((err as Error)?.message ?? err) };
    try {
      bitmap.close();
    } catch {
      // もう閉じている
    }
  }
  (self as unknown as Worker).postMessage(res);
};
