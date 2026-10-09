// 見開きの絵の画面を、本物の App で開くための入口。(2026-10-03)
//
// app-probe.tsx と同じく、**サンプルの原稿を保存済みの本として立ち上げ、App を載せ、入口をくぐる**。
// そのあとの操作(挿絵の大きさを選ぶ・下見を見開きにする・写真を撮る)は、scripts/spread-probe.mjs が
// playwright-core でする。ここは、そのために window へ口(__spread)を出すだけ:
//
//   __spread.store      … useProject(設定・原稿を直に触る)
//   __spread.art(kind)  … 横長の絵の data URI。'plain' = 風景(文字なし)/ 'text' = 折り目と端に文字を描いた図
//   __spread.ready      … App が載って入口をくぐったら true
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { sampleManuscript } from '../src/sample';
import { useProject } from '../src/store/useProject';

import '../src/fontsAll';
import '../src/app.css';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 横長の絵(3600×2570 = A5 の見開きに近い比 1.40)。風景は左右につながる山と空、折り目の位置に細い塔を1本 */
function makeArt(kind: 'plain' | 'text'): string {
  const W = 3600;
  const H = 2570;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#2a6fb5');
  sky.addColorStop(0.65, '#9ed0ee');
  sky.addColorStop(1, '#f6e3b4');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  // 太陽(左寄り)
  g.fillStyle = '#fff3c4';
  g.beginPath();
  g.arc(W * 0.27, H * 0.3, 190, 0, Math.PI * 2);
  g.fill();
  // 遠い山・近い山(左右をまたぐ)
  const ridge = (base: number, amp: number, color: string, phase: number) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 20) {
      g.lineTo(x, base - amp * (0.6 * Math.sin(x / 520 + phase) + 0.4 * Math.sin(x / 190 + phase * 2)));
    }
    g.lineTo(W, H);
    g.closePath();
    g.fill();
  };
  ridge(H * 0.62, 220, '#6e86a8', 0.4);
  ridge(H * 0.74, 180, '#44688a', 1.7);
  ridge(H * 0.88, 130, '#27483a', 3.1);
  // 折り目(絵の真ん中)をまたぐ橋 — つながって見えれば左右の切り出しが合っている
  g.fillStyle = '#7a3b2e';
  g.fillRect(W * 0.28, H * 0.8, W * 0.44, 36);
  g.fillRect(W * 0.28, H * 0.8 + 36, 30, 160);
  g.fillRect(W * 0.72 - 30, H * 0.8 + 36, 30, 160);
  g.fillRect(W / 2 - 15, H * 0.8 + 36, 30, 160);
  if (kind === 'text') {
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#1b2a3a';
    g.lineWidth = 8;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    // 折り目の上に大きな文字
    g.font = 'bold 190px sans-serif';
    g.strokeText('FOLD TITLE', W / 2, H * 0.42);
    g.fillText('FOLD TITLE', W / 2, H * 0.42);
    // 左の小口の近くに文字(版面の外)
    g.textAlign = 'left';
    g.font = 'bold 130px sans-serif';
    g.strokeText('EDGE NOTE', 40, H * 0.14);
    g.fillText('EDGE NOTE', 40, H * 0.14);
  }
  return c.toDataURL('image/jpeg', 0.9);
}

async function main() {
  useProject.getState().setManuscript(sampleManuscript(), { name: 'sample.txt', kind: 'txt', data: '' });
  await sleep(1500); // scheduleSave(800ms) が書き終わるのを待つ
  const { App } = await import('../src/components/App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  const end = performance.now() + 60000;
  while (performance.now() < end) {
    const btn = document.querySelector<HTMLButtonElement>('.start-current button.primary-action');
    if (btn) {
      btn.click();
      break;
    }
    await sleep(50);
  }
  (window as unknown as { __spread: unknown }).__spread = { store: useProject, art: makeArt, ready: true };
}
void main();
