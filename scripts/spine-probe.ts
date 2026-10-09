// **［ぎりぎりまで大きく］が本当にぎりぎりになるかを機械で測る。**
//
// ## なぜ在るか
//
// 「KDPの制限におさまるぎりぎりのサイズがボタン一つで指定できるといいんだけどなあ」
// (2026-08-21 ユーザー要望)
//
// 背文字の大きさには**縛りが2つ**ある。
//
//   1. 背幅(横) … 縁から 1.6mm 空けた残りに字幅が入るか(KDP の規定はこちら)
//   2. 天地(縦) … 字数 × 行送りが紙の高さに入るか(規定ではなく算数)
//
// 画面は長らく 1 しか見ておらず、字数の多い本では**描画が縮めた実寸と食い違って**いた。
// ボタンを付けるなら、押した後が本当に上限であることを数字で押さえておかないと、
// 「押したのに小さく出る」がまた戻ってくる。目で見て確かめるかぎり必ず戻る。
//
// ## 測ること(短い書名と長い書名の両方で)
//
//   a. 押した後、**1文字も切れていない**(spineOverflow が 0)
//   b. 押した後の刷り上がりが、**はみ出さない上限そのもの**(誤差 0.5% 未満)
//   c. 押した後にさらに 5% 上げても、**刷り上がりが1ミリも大きくならない**(= 天井)
//   d. 背の外(表1・表4の側)に文字の画素が**1つも無い**(回り込みなし)
//   e. 古い保存(spineScale だけ)を移した結果が、**前と同じ刷り上がり**になる
//
// ## 使い方
//
//   python scripts/check-spine.py
//
// あるいは手で:
//   npx vite --port 5199
//   http://localhost:5199/scripts/spine-probe.html
//
// 測り終わると document.title が `PROBE-DONE` か `PROBE-FAIL`。
// **IndexedDB は触らない**(store を通さず、models と cover/render だけを呼ぶ)。
import '@fontsource/noto-serif-jp/400.css';
import '@fontsource/noto-serif-jp/700.css';
import {
  computeCoverLayout,
  defaultCoverSettings,
  migrateCoverSettings,
  mmToPx,
  spineTextBox,
  SPINE_SUB_RATIO,
  type CoverLayout,
  type CoverSettings,
} from '../src/models/cover';
import { ensureCoverFonts, renderPaperCover, type CoverText } from '../src/cover/render';
import { reportProbe } from './probe-report';

/** 背の画素を数えた結果 */
interface Ink {
  /** 背の中の明るい画素(白い文字) */
  inside: number;
  /** 背より左へ出た画素。**1つでもあれば表4・表1へ回り込んでいる** */
  left: number;
  /** 背より右へ出た画素 */
  right: number;
  /** 文字の天(px)。上端に近いほど天地を使い切っている */
  top: number;
  /** 文字の地(px) */
  bottom: number;
}

/** 1件ぶんの測定 */
interface Shot {
  /** 書名の刷り上がり(pt)。**描画が実際に使った値** */
  titlePt: number;
  authorPt: number;
  publisherPt: number;
  /** はみ出さない上限(pt) */
  limitPt: number;
  /** 上限を決めたのは背幅か字数か */
  limitedBy: string;
  /** あと何倍にできるか。1.00 ならぎりぎり */
  headroom: number;
  /** 天地に入らず縮めて刷ったか */
  shrunk: boolean;
  /** 入りきらず切った字数 */
  dropped: number;
  /**
   * **背幅しか見なかったときの答え**(pt)。2026-08-22 まで画面はこれを出していた。
   * 字数の多い本では titlePt と食い違う = 画面が嘘をついていた証拠
   */
  widthOnlyPt: number;
  ink: Ink;
}

interface CaseResult {
  name: string;
  背幅: string;
  押す前: Shot;
  押した後: Shot;
  さらに5パーセント上げる: Shot;
  倍率: { 書名: number; 著者: number; 版元: number };
  fails: string[];
}

const canvas = document.getElementById('probe-canvas') as HTMLCanvasElement;

/** 明るい画素(白い文字)を数える。背の地は暗い色にしてある */
function scanInk(layout: CoverLayout): Ink {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas が取れませんでした');
  const x0 = mmToPx(layout.spineArea.x0);
  const x1 = mmToPx(layout.spineArea.x1);
  // 背の左右 40px までを見る。回り込みは背のすぐ外に出る
  const margin = 40;
  const sx = Math.max(0, x0 - margin);
  const sw = Math.min(canvas.width, x1 + margin) - sx;
  const { data } = ctx.getImageData(sx, 0, sw, canvas.height);
  const ink: Ink = { inside: 0, left: 0, right: 0, top: canvas.height, bottom: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (lum < 0.6) continue;
    const p = i / 4;
    const x = sx + (p % sw);
    const y = Math.floor(p / sw);
    if (x < x0) ink.left++;
    else if (x >= x1) ink.right++;
    else {
      ink.inside++;
      if (y < ink.top) ink.top = y;
      if (y > ink.bottom) ink.bottom = y;
    }
  }
  if (ink.inside === 0) ink.top = 0;
  return ink;
}

/** 描いて、実測を1件ぶん取る */
function shoot(settings: CoverSettings, layout: CoverLayout, text: CoverText): Shot {
  const report = renderPaperCover(canvas, {
    layout,
    settings,
    text,
    image: null,
    backImage: null,
  });
  const s = report.spine;
  const box = spineTextBox(
    layout.spine,
    settings.spineScale,
    settings.spineSideways,
    layout.spineInset,
  );
  return {
    titlePt: round(s?.titlePt ?? 0),
    authorPt: round(s?.authorPt ?? 0),
    publisherPt: round(s?.publisherPt ?? 0),
    limitPt: round(s?.limitPt ?? 0),
    limitedBy: s?.limitedBy ?? '-',
    headroom: round(s?.headroom ?? 0, 4),
    shrunk: Boolean(s?.shrunk),
    dropped: report.spineOverflow,
    widthOnlyPt: round(box.pt),
    ink: scanInk(layout),
  };
}

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

/** 画面のボタンと同じ計算。**上限を越えないよう切り捨てる** */
const pressed = (settings: CoverSettings, headroom: number): CoverSettings => {
  const down = (v: number) => Math.floor(v * headroom * 1000) / 1000;
  return {
    ...settings,
    spineScale: down(settings.spineScale),
    spineAuthorScale: down(settings.spineAuthorScale),
    spinePublisherScale: down(settings.spinePublisherScale),
  };
};

interface Case {
  name: string;
  pages: number;
  sideways: boolean;
  title: string;
  author: string;
  publisher: string;
  /** 版元名を刷るか(既定は刷らない設定なので、明示する) */
  publisherOn?: boolean;
}

const CASES: Case[] = [
  {
    name: '短い書名・縦積み(200ページ)',
    pages: 200,
    sideways: false,
    title: '猫の駅',
    author: '雨宿花子',
    publisher: 'あまやどり出版',
    publisherOn: true,
  },
  {
    name: '長い書名・縦積み(200ページ)',
    pages: 200,
    sideways: false,
    title: '雨のあがるまで、この駅で待っている長い長い物語',
    author: '雨宿花子',
    publisher: 'あまやどり出版',
    publisherOn: true,
  },
  {
    name: '短い書名・横倒し(200ページ)',
    pages: 200,
    sideways: true,
    title: '猫の駅',
    author: '雨宿花子',
    publisher: 'あまやどり出版',
    publisherOn: true,
  },
  {
    name: '長い書名・横倒し(200ページ)',
    pages: 200,
    sideways: true,
    title: '雨のあがるまで、この駅で待っている長い長い物語',
    author: '雨宿花子',
    publisher: 'あまやどり出版',
    publisherOn: true,
  },
  {
    name: '薄い本・縦積み(112ページ)',
    pages: 112,
    sideways: false,
    title: '猫の駅',
    author: '雨宿花子',
    publisher: 'あまやどり出版',
    publisherOn: true,
  },
  {
    name: '分厚い本・縦積み(297ページ)',
    pages: 297,
    sideways: false,
    title: '雨のあがるまで',
    author: '雨宿花子',
    publisher: 'あまやどり出版',
    publisherOn: true,
  },
  {
    name: '版元名なし・縦積み(200ページ)',
    pages: 200,
    sideways: false,
    title: '猫の駅',
    author: '雨宿花子',
    publisher: 'あまやどり出版',
    publisherOn: false,
  },
];

async function runCase(c: Case): Promise<CaseResult> {
  // 文庫(A6)・白色用紙・右綴じ(縦組み)・KDP。**背幅はページ数で決まる**
  const layout = computeCoverLayout('bunko', c.pages, 'white', true, { target: 'kdp' });
  const base: CoverSettings = {
    ...defaultCoverSettings(),
    spineTextOn: true,
    spineAuthorOn: true,
    spinePublisherOn: c.publisherOn ?? false,
    spineSideways: c.sideways,
    // 背の地は暗く、文字は白く。明るい画素を数えれば文字の位置が分かる
    spineColor: '#16243a',
    spineTextColor: '#ffffff',
  };
  const text: CoverText = {
    title: c.title,
    author: c.author,
    publisher: c.publisher,
    vertical: true,
  };
  await ensureCoverFonts(base);

  const before = shoot(base, layout, text);
  const after = shoot(pressed(base, before.headroom), layout, text);
  // 押した後にさらに 5% 上げる。**ここで刷り上がりが大きくなるなら、天井ではなかった**
  const over = shoot(pressed(pressed(base, before.headroom), 1.05), layout, text);

  const fails: string[] = [];
  const pushed = pressed(base, before.headroom);
  if (after.dropped > 0) fails.push(`${c.name}: 押した後に ${after.dropped} 文字切れました`);
  if (Math.abs(after.titlePt - after.limitPt) > after.limitPt * 0.005) {
    fails.push(
      `${c.name}: 押した後の刷り上がり ${after.titlePt}pt が上限 ${after.limitPt}pt と違います`,
    );
  }
  if (Math.abs(after.headroom - 1) > 0.01) {
    fails.push(`${c.name}: 押した後もまだ ${after.headroom} 倍の余地があります`);
  }
  if (over.titlePt > after.titlePt * 1.001) {
    fails.push(
      `${c.name}: さらに5%上げたら ${over.titlePt}pt になりました(${after.titlePt}pt が天井のはず)`,
    );
  }
  // 倍率は切り捨てで書き戻すので、0.1% ほど下がることはある(それは「小さくなった」ではない)
  if (after.titlePt < before.titlePt * 0.995) {
    fails.push(`${c.name}: 押したら小さくなりました(${before.titlePt} → ${after.titlePt}pt)`);
  }
  if (after.ink.left > 0 || after.ink.right > 0) {
    fails.push(
      `${c.name}: 背の外に文字が出ました(左 ${after.ink.left} / 右 ${after.ink.right} 画素)`,
    );
  }
  if (after.ink.inside === 0) fails.push(`${c.name}: 背に文字が1画素も刷られていません`);

  return {
    name: c.name,
    背幅: `${layout.spine.toFixed(2)}mm(置ける幅 ${(layout.spine - layout.spineInset * 2).toFixed(2)}mm)`,
    押す前: before,
    押した後: after,
    さらに5パーセント上げる: over,
    倍率: {
      書名: round(pushed.spineScale, 3),
      著者: round(pushed.spineAuthorScale, 3),
      版元: round(pushed.spinePublisherScale, 3),
    },
    fails,
  };
}

/**
 * 古い保存(spineScale だけ)の移し替え。
 * **前と同じ刷り上がりになること** — 前は著者名 = 書名 × 0.72、版元名 = 書名 × 0.6 だった
 */
function migrationCase(): { name: string; 移した倍率: unknown; fails: string[] } {
  const fails: string[] = [];
  const old = { ...defaultCoverSettings(), spineScale: 1.2 } as Record<string, unknown>;
  delete old.spineAuthorScale;
  delete old.spinePublisherScale;
  const moved = migrateCoverSettings(old);
  const want = {
    author: 1.2 * SPINE_SUB_RATIO.author,
    publisher: 1.2 * SPINE_SUB_RATIO.publisher,
  };
  if (Math.abs((moved.spineAuthorScale ?? 0) - want.author) > 1e-9) {
    fails.push(`古い保存の著者名が ${moved.spineAuthorScale} になりました(${want.author} のはず)`);
  }
  if (Math.abs((moved.spinePublisherScale ?? 0) - want.publisher) > 1e-9) {
    fails.push(
      `古い保存の版元名が ${moved.spinePublisherScale} になりました(${want.publisher} のはず)`,
    );
  }
  // 何も持っていない保存(既定のまま)でも、既定値と同じになること
  const bare = migrateCoverSettings({});
  if (bare.spineAuthorScale !== SPINE_SUB_RATIO.author) {
    fails.push(`spineScale を持たない保存で著者名が ${bare.spineAuthorScale} になりました`);
  }
  return {
    name: '古い保存(spineScale だけ)の移し替え',
    移した倍率: { 書名: 1.2, 著者: moved.spineAuthorScale, 版元: moved.spinePublisherScale },
    fails,
  };
}

async function main() {
  const cases: CaseResult[] = [];
  for (const c of CASES) cases.push(await runCase(c));
  const migration = migrationCase();
  const fails = [...cases.flatMap((c) => c.fails), ...migration.fails];
  reportProbe({ cases, migration, fails }, fails.length === 0);
}

main().catch((e: unknown) => {
  reportProbe({ 落ちた: String(e), stack: (e as Error)?.stack ?? '' }, false);
});
