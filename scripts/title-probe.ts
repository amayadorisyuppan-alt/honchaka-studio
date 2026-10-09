// **縦組みの本の表紙で、書名・著者名だけ横書きにしたとき**(titleWritingMode='horizontal')を実際に描いて測る。(2026-10-03)
//
// 測ること(文庫・200ページ・KDP・右綴じ=表1が左)
//   a. 書名が横に並ぶ(横書き)/縦に並ぶ(縦書き)。向きを変えたとき、画素の並びが本当に変わっている
//   b. 書名・著者名の字が、表1の安全領域の中に収まる(位置を右上などに寄せたときも)
//   c. 表1が左・背と表4の画素が、向きを変えても1画素も変わらない(綴じ・背の位置が動いていない)
//   d. おまかせの位置のとき、書名の中心が表1の仕上がりの中央にある
//   e. titleWritingModeOf の4通り
// 縦書き側は描画のコードを変えていないので、「前と同じ」は描画コードの差分が無いことと、
// 組版HTMLの前後比べ(scripts/layout-matrix.ts)で見る。
import '@fontsource/noto-serif-jp/400.css';
import '@fontsource/noto-serif-jp/700.css';
import { COVER_SAFE_MM, computeCoverLayout, defaultCoverSettings, mmToPx } from '../src/models/cover';
import type { CoverAnchor, CoverLayout, CoverSettings } from '../src/models/cover';
import { ensureCoverFonts, renderPaperCover, type CoverText } from '../src/cover/render';
import { titleWritingModeOf } from '../src/models/project';
import { reportProbe } from './probe-report';

const canvas = document.getElementById('probe-canvas') as HTMLCanvasElement;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  n: number;
}

/** 明るい画素(白い文字)の外接箱。地は暗い単色で、帯は出さない */
function inkBox(x0: number, x1: number): Box {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas が取れませんでした');
  const w = x1 - x0;
  const b: Box = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 };
  if (w <= 0) return b;
  const { data } = ctx.getImageData(x0, 0, w, canvas.height);
  for (let i = 0; i < data.length; i += 4) {
    const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (lum < 0.7) continue;
    const p = i / 4;
    const x = x0 + (p % w);
    const y = Math.floor(p / w);
    b.n++;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }
  return b;
}

/** 面ごとの画素の指紋(背・表4が動いていないことを見る) */
function fingerprint(x0: number, x1: number): string {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas が取れませんでした');
  const { data } = ctx.getImageData(x0, 0, x1 - x0, canvas.height);
  let h = 2166136261;
  for (let i = 0; i < data.length; i += 4) {
    h = Math.imul(h ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16)), 16777619);
  }
  return (h >>> 0).toString(16);
}

const mm = (px: number) => Math.round(((px * 25.4) / 300) * 100) / 100;

interface Shot {
  all: Box;
  backFp: string;
  spineFp: string;
  /** 表1の外(背・表4)へ出た画素 */
  outside: number;
}

function shoot(layout: CoverLayout, settings: CoverSettings, text: CoverText): Shot {
  renderPaperCover(canvas, { layout, settings, text, image: null, backImage: null });
  const fx0 = mmToPx(layout.front.x0);
  const fx1 = mmToPx(layout.front.x1);
  return {
    all: inkBox(fx0, fx1),
    backFp: fingerprint(mmToPx(layout.back.x0), mmToPx(layout.back.x1)),
    spineFp: fingerprint(mmToPx(layout.spineArea.x0), mmToPx(layout.spineArea.x1)),
    outside: inkBox(0, fx0).n + inkBox(fx1, canvas.width).n,
  };
}

const TITLES = [
  { name: '日本語の書名', title: '猫の駅', author: '雨宿花子' },
  { name: '英字の書名', title: 'Quiet Station', author: 'Hanako Amayado' },
  { name: '長い英字の書名', title: 'Rain Until the Station Closes and Other Stories', author: 'Hanako Amayado' },
];
const ANCHORS: CoverAnchor[] = ['auto', 'top-right', 'bottom-left', 'top-left'];

async function main() {
  // 文庫・200ページ・KDP・右綴じ(縦組みの本。表1が左)。綴じは書名の向きとは関係なく、この呼び出しで決まる
  const layout = computeCoverLayout('bunko', 200, 'white', true, { target: 'kdp' });
  const fails: string[] = [];
  const rows: unknown[] = [];
  const base: CoverSettings = {
    ...defaultCoverSettings(),
    band: 'none',
    titleColor: '#ffffff',
    authorColor: '#ffffff',
    spineTextOn: false,
  };
  await ensureCoverFonts(base);

  if (layout.front.x0 >= layout.back.x0) fails.push('右綴じなのに表1が左でない');

  // 安全領域(表1)。右綴じは表1が左: 外側(小口側)に 塗り足し+安全領域、背側に安全領域
  const frontX0 = mmToPx(layout.front.x0);
  const frontX1 = mmToPx(layout.front.x1);
  const safe = {
    x0: frontX0 + mmToPx(layout.bleed + COVER_SAFE_MM),
    x1: frontX1 - mmToPx(COVER_SAFE_MM),
    y0: mmToPx(layout.bleed + COVER_SAFE_MM),
    y1: mmToPx(layout.totalH - layout.bleed - COVER_SAFE_MM),
  };
  // 表1の仕上がりの中央(左に塗り足し・背側は塗り足し無し)
  const trimCenter = (frontX0 + mmToPx(layout.bleed) + frontX1) / 2;

  // 向きの判定(著者名なし・おまかせ位置): 縦書きは縦長・横書きは横長
  for (const t of TITLES) {
    const only = (vertical: boolean) => shoot(layout, base, { title: t.title, author: '', publisher: '', vertical });
    const v = only(true);
    const h = only(false);
    const vW = v.all.x1 - v.all.x0;
    const vH = v.all.y1 - v.all.y0;
    const hW = h.all.x1 - h.all.x0;
    const hH = h.all.y1 - h.all.y0;
    if (!(hW > hH)) fails.push(`${t.name}: 横書きにしたのに字の並びが横長でない(${mm(hW)}×${mm(hH)}mm)`);
    if (t.title.length <= 4 && !(vH > vW)) fails.push(`${t.name}: 縦書きの字の並びが縦長でない(${mm(vW)}×${mm(vH)}mm)`);
    const off = (h.all.x0 + h.all.x1) / 2 - trimCenter;
    if (Math.abs(mm(off)) > 1.5) fails.push(`${t.name}: 横書きの書名の中心が表1の仕上がりの中央から ${mm(off)}mm ずれている`);
    rows.push({
      case: t.name,
      縦書き: `${mm(vW)}x${mm(vH)}mm`,
      横書き: `${mm(hW)}x${mm(hH)}mm`,
      横書きの中心の中央からのずれmm: mm(off),
    });
  }

  // 位置を寄せたときも、安全領域に収まる/背・表4が動かない/表1の外へ出ない
  for (const t of TITLES) {
    for (const a of ANCHORS) {
      const settings: CoverSettings = { ...base, titleAnchor: a, authorAnchor: a };
      const [v, h] = [true, false].map((vertical) =>
        shoot(layout, settings, { title: t.title, author: t.author, publisher: '', vertical }),
      );
      const tol = 3; // 画素。字の外接箱の丸め
      const inSafe =
        h.all.x0 >= safe.x0 - tol && h.all.x1 <= safe.x1 + tol && h.all.y0 >= safe.y0 - tol && h.all.y1 <= safe.y1 + tol;
      if (!inSafe) {
        fails.push(
          `${t.name}・位置 ${a}: 横書きの字が安全領域を割る(字 ${mm(h.all.x0 - frontX0)}〜${mm(h.all.x1 - frontX0)}mm / 安全 ${mm(safe.x0 - frontX0)}〜${mm(safe.x1 - frontX0)}mm)`,
        );
      }
      if (h.outside > 0) fails.push(`${t.name}・位置 ${a}: 横書きの字が表1の外(背・表4)へ ${h.outside} 画素出た`);
      if (h.backFp !== v.backFp) fails.push(`${t.name}・位置 ${a}: 向きを変えたら表4が変わった`);
      if (h.spineFp !== v.spineFp) fails.push(`${t.name}・位置 ${a}: 向きを変えたら背が変わった`);
      if (h.all.n === 0) fails.push(`${t.name}・位置 ${a}: 横書きで何も刷られていない`);
    }
  }

  // 設定の関数(4通り)
  const cases: [string, 'vertical' | 'horizontal', 'vertical' | 'horizontal' | undefined, string][] = [
    ['縦×省略', 'vertical', undefined, 'vertical'],
    ['縦×横', 'vertical', 'horizontal', 'horizontal'],
    ['横×省略', 'horizontal', undefined, 'horizontal'],
    ['横×縦', 'horizontal', 'vertical', 'horizontal'],
  ];
  for (const [n, wm, tw, want] of cases) {
    const got = titleWritingModeOf({ writingMode: wm, titleWritingMode: tw });
    if (got !== want) fails.push(`titleWritingModeOf ${n}: ${got}(期待 ${want})`);
  }

  reportProbe({ ok: fails.length === 0, fails, rows }, fails.length === 0);
}

void main().catch((e) => reportProbe({ ok: false, fails: [String(e?.stack ?? e)] }, false));
