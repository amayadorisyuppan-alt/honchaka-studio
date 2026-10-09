// 絵の中の文字の箱を取る(画面の側の口)。Worker(worker.ts)を、要るときにはじめて作る。
//
// - 同じ絵は1回だけ調べる(絵の data URI を鍵に覚える)
// - 1枚ずつ順に(Worker の中の実行系は、同時に2つは走れない)
// - **調べられなかったときは null**(古いブラウザ・読めない絵・時間切れ)。呼ぶ側は「分からない」として扱い、
//   エラーにも合格にもしない(嘘のエラーを出さない)。そのかわり「確かめられなかった」と言う(App)
// - しばらく使わなければ Worker を捨てる(モデルを抱えたままにしない)
//
// ## 絵を開くのは、画面の側(<img>)
//
// Worker の中で Blob から開く(createImageBitmap(blob))と、**SVG が開けない**(Chrome)。図表は SVG のことがある。
// スマホで撮った JPEG の向き(EXIF)も、<img> と同じに扱わないと、見つけた箱の縦横が下見とずれる。
// だから下見と同じ <img> で開き、その絵(ImageBitmap)を Worker へ渡す(2026-10-02 見直しで指摘)
import type { TextBox } from './db';
import type { DetectRequest, DetectResponse } from './worker';

export interface DetectResult {
  /** 絵の画素の大きさ(下見に出るときの向き) */
  w: number;
  h: number;
  /** 見つけた文字の箱(絵の画素) */
  boxes: TextBox[];
}

/** 1枚にかけてよい時間(ms)。はじめの1枚はモデルの読み込みも含む */
const TIMEOUT_MS = 90000;
/** 使わなくなってから Worker を捨てるまで(ms) */
const IDLE_MS = 120000;

const cache = new Map<string, Promise<DetectResult | null>>();
let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: DetectResponse) => void>();
let chain: Promise<unknown> = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | undefined;

function dropWorker() {
  worker?.terminate();
  worker = null;
  for (const done of waiting.values()) done({ id: -1, ok: false, error: 'terminated' });
  waiting.clear();
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<DetectResponse>) => {
      const done = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      done?.(e.data);
    };
    // Worker そのものが落ちた(WASM が読めない など)。待っている分を全部「分からない」で返す
    worker.onerror = () => dropWorker();
  }
  return worker;
}

/** 下見と同じ <img> で絵を開く(SVG・向きつきの JPEG も、下見に出るのと同じ絵になる) */
async function openImage(src: string): Promise<ImageBitmap | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return await createImageBitmap(img);
  } catch {
    return null;
  }
}

async function run(src: string): Promise<DetectResult | null> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const bitmap = await openImage(src);
  if (!bitmap) return null;
  clearTimeout(idle);
  const id = ++seq;
  const res = await new Promise<DetectResponse>((resolve) => {
    const timer = setTimeout(() => {
      // 止まった Worker は途中でやめさせられないので、捨てて作り直す
      waiting.delete(id);
      dropWorker();
      resolve({ id, ok: false, error: 'timeout' });
    }, TIMEOUT_MS);
    waiting.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    try {
      getWorker().postMessage({ id, bitmap } satisfies DetectRequest, [bitmap]);
    } catch (err) {
      clearTimeout(timer);
      waiting.delete(id);
      resolve({ id, ok: false, error: String(err) });
    }
  });
  idle = setTimeout(dropWorker, IDLE_MS);
  return res.ok ? { w: res.w, h: res.h, boxes: res.boxes } : null;
}

/**
 * 絵(data URI など、<img> で開ける形)の中の文字の箱を返す。調べられなかったら null。
 * 同じ絵は、2回目からは覚えている結果を返す。調べられなかった絵は覚えない(次に呼ばれたら、もう一度試す)
 */
export function detectText(src: string): Promise<DetectResult | null> {
  let p = cache.get(src);
  if (!p) {
    // 前の絵が終わってから(成否に関係なく)
    p = chain.then(
      () => run(src),
      () => run(src),
    );
    chain = p;
    cache.set(src, p);
    void p.then((r) => {
      if (r === null && cache.get(src) === p) cache.delete(src);
    });
  }
  return p;
}
