// 入稿用の変換(カラー=CMYK・白黒=K1色)を、画面と同じ入口(convertPress → Worker)で1本通す検査台。(2026-10-12 1.1.0)
// node の道具(scripts/press/run.ts)は JPEG をほどけないので、JPEG の灰色の絵(4-6 の写し)は調べずに素通しになる。
// ここは Worker の中で createImageBitmap がほどくので、製品と同じに無彩色を見分ける。
//
// 開き方: http://localhost:5173/scripts/press-probe.html?kind=body-cmyk&trim=105x148&bleed=3.2,3.2,3.2,0&gutter=right
//   input#pdf にファイルを入れると変換し、title が PRESS-DONE / PRESS-FAIL になる。
//   window.__press に結果(colorPages・neutral・tone・issues)、window.__pressPdf に出来上がりの PDF(base64)を置く
import { convertPress } from '../src/press/press';
import type { PressKind } from '../src/press/press';

const q = new URLSearchParams(location.search);
const kind = (q.get('kind') ?? 'body-cmyk') as PressKind;
const [trimW, trimH] = (q.get('trim') ?? '105x148').split('x').map(Number);
const [bleedTop, bleedBottom, bleedFore, bleedGutter] = (q.get('bleed') ?? '3.2,3.2,3.2,0').split(',').map(Number);
const firstGutter = q.get('gutter') === 'left' ? 'left' : 'right';

const input = document.getElementById('pdf') as HTMLInputElement;
input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const r = await convertPress(
      {
        kind,
        pdf: await file.arrayBuffer(),
        boxes: { kind: 'body', trimW, trimH, bleedTop, bleedBottom, bleedFore, bleedGutter, firstGutter },
        title: 'press-probe',
        inkLimit: 300,
      },
      () => {},
    );
    const w = window as unknown as Record<string, unknown>;
    w.__press = { pages: r.pages, colorPages: r.colorPages, neutral: r.neutral, toneApplied: r.toneApplied, tone: r.tone, issues: r.issues, ms: r.ms };
    let bin = '';
    const bytes = new Uint8Array(r.pdf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    w.__pressPdf = btoa(bin);
    document.title = 'PRESS-DONE';
  } catch (e) {
    (window as unknown as Record<string, unknown>).__press = { error: String((e as Error)?.message ?? e) };
    document.title = 'PRESS-FAIL';
  }
});
