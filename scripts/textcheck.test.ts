// 「絵の中の文字が版面の外に出ている」の判定(src/textcheck)の検査。計算の部分だけ(Worker とモデルは使わない)。
//
// ## 何を確かめるか
//
// - db.ts: 確率の図 → 文字の箱。しきい値・塊のまとめ方・「線の多さ」の絞り込み・元の絵の座標への戻し
// - geometry.ts: 絵がページに置かれる位置(全面は切り抜き・余白つきは切らずに収める)、版面の四角(左右のページでノドが入れ替わる)、
//   版面の外に出た箱の拾い方、検査にかける絵の選び方、下見に重ねる CSS
//
// 本物の道具(onnxruntime-web とモデル)を通した確かめは scripts/textcheck-probe.mjs(本物のアプリで)。
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   npx vite build --ssr scripts/textcheck.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/textcheck.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { defaultSettings } from '../src/models/project';
import type { Manuscript, Plate } from '../src/models/project';
import { computeLayout } from '../src/typeset/grid';
import { imageKey } from '../src/models/inlineImages';
import { DETECT_OPTIONS, planResize, probToBoxes, rgbaToTensor, lumaFromRgba } from '../src/textcheck/db';
import {
  findTextOutside,
  imageOnPaper,
  judgeText,
  overText,
  pageSideOf,
  textMarksCss,
  textRowKey,
  textTargets,
  typeAreaOnPaper,
} from '../src/textcheck/geometry';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// db.ts
// ---------------------------------------------------------------------------
{
  const g = planResize(2400, 3393, 1024);
  ok(g.netW % 32 === 0 && g.netH % 32 === 0 && Math.max(g.netW, g.netH) <= 1024 + 16, '長辺 1024 に縮め、各辺は 32 の倍数', `${g.netW}×${g.netH}`);
  ok(near(g.sx * g.netW, 2400) && near(g.sy * g.netH, 3393), '元の絵の座標へ戻す比が合う');
  const small = planResize(300, 200, 1024);
  ok(small.netW === 288 && small.netH === 192, '小さい絵は拡大しない(32 の倍数に丸めるだけ)', `${small.netW}×${small.netH}`);
  const tiny = planResize(10, 10, 1024);
  ok(tiny.netW === 32 && tiny.netH === 32, 'とても小さい絵でも 32 画素は確保する');
}
{
  // 2×1 画素: 赤と青。テンソルは BGR の順(1枚目のチャンネルが青)
  const g = { netW: 2, netH: 1, sx: 1, sy: 1, srcW: 2, srcH: 1 };
  const t = rgbaToTensor(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), g);
  ok(t.length === 6 && t[0] < 0 && t[1] > 0 && t[4] > 0 && t[5] < 0, 'テンソルは BGR の順(赤の画素は3枚目、青の画素は1枚目が大きい)', Array.from(t).map((v) => v.toFixed(2)).join(' '));
  const luma = lumaFromRgba(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]), 2);
  ok(luma[0] === 255 && luma[1] === 0, '輝度: 白は 255、黒は 0');
}
{
  // 64×64 の確率の図。文字らしい塊を置く。輝度は、塊の中に2画素幅の縦の縞(= 字の画)を引いておく
  // (1画素おきの縞では、左右の画素の差が 0 になって「線」に数えられない)
  const W = 64;
  const H = 64;
  const g = { netW: W, netH: H, sx: 10, sy: 10, srcW: 640, srcH: 640 };
  const prob = new Float32Array(W * H);
  const luma = new Uint8Array(W * H).fill(255);
  const blob = (x0: number, y0: number, w: number, h: number, p: number, stripes: boolean) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        prob[y * W + x] = p;
        if (stripes && x % 4 < 2) luma[y * W + x] = 0;
      }
  };
  blob(4, 4, 30, 8, 0.9, true); // 文字: 自信が高く、線が多い
  blob(4, 30, 30, 8, 0.9, false); // なめらかな濃淡: 自信は高いが、線が無い → 落とす
  blob(40, 30, 20, 8, 0.6, true); // 自信が足りない(0.7 未満) → 落とす
  blob(4, 50, 30, 3, 0.9, true); // 細すぎる(短辺 5 未満) → 落とす
  const boxes = probToBoxes(prob, luma, g);
  ok(boxes.length === 1, '文字らしい塊だけが残る(線の無い塊・自信の足りない塊・細すぎる塊は落とす)', JSON.stringify(boxes));
  const b = boxes[0];
  // 広げる幅: 面積 240 × 1.5 ÷ 周長 76 ≒ 4.74 画素(ネットワーク上) → 元の絵では ×10。左と上は絵の端(0)で止まる
  ok(!!b && b.x === 0 && b.y === 0 && near(b.x + b.w, (34 + 4.74) * 10, 2) && near(b.y + b.h, (12 + 4.74) * 10, 2), '箱は少し広げて、元の絵の画素に直す。絵の外へは出さない', JSON.stringify(b));
  ok(!!b && near(b.conf, 0.9, 0.001), '自信の値は、塊の中の確率の平均');
  // 斜めの細い帯(外接矩形のうち塊が占める割合が小さい) → 落とす。
  // **輝度は全面に縞を引いておく**(線の多さの条件は通る)。落とすのが「埋まり具合」の条件だと確かめるため、
  // 同じ輝度で、埋まり具合の条件だけを外すと箱が出ることも見る
  const prob2 = new Float32Array(W * H);
  for (let i = 0; i < 40; i++) for (let d = 0; d < 6; d++) prob2[(10 + i) * W + 10 + i + d] = 0.9;
  const striped = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) striped[i] = (i % W) % 4 < 2 ? 0 : 255;
  ok(probToBoxes(prob2, striped, g).length === 0, '斜めの帯(外接矩形をあまり埋めない塊)は落とす');
  ok(probToBoxes(prob2, striped, g, { ...DETECT_OPTIONS, minFill: 0 }).length === 1, '(同じ絵で、埋まり具合の条件だけ外すと箱が出る = 落としているのはこの条件)');
  ok(probToBoxes(new Float32Array(W * H), luma, g).length === 0, '何も無い確率の図からは、箱が出ない');
  ok(DETECT_OPTIONS.limit === 1024 && DETECT_OPTIONS.boxThresh === 0.7 && DETECT_OPTIONS.minEdge === 0.14, '試作で決めた値のまま(変えるときは、試し絵で測り直すこと。db.ts の頭の説明)');
}

// ---------------------------------------------------------------------------
// geometry.ts
// ---------------------------------------------------------------------------
const kdp = computeLayout({ ...defaultSettings(), trim: 'b6', printTarget: 'kdp' });
const shop = computeLayout({
  ...defaultSettings(),
  trim: 'b6',
  printTarget: 'printshop',
  printRules: { bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20 },
});
{
  ok(pageSideOf(1, 'vertical') === 'left' && pageSideOf(2, 'vertical') === 'right', '縦組み: 1ページ目は左、2ページ目は右');
  ok(pageSideOf(1, 'horizontal') === 'right' && pageSideOf(2, 'horizontal') === 'left', '横組み: 1ページ目は右、2ページ目は左');
  const L = typeAreaOnPaper(kdp, 'left');
  const R = typeAreaOnPaper(kdp, 'right');
  ok(near(L.x, kdp.margins.fore + 3.2) && near(kdp.paperW - (L.x + L.w), kdp.margins.gutter), 'KDP・左のページ: 左は小口の余白＋塗り足し、右はノドの余白(ノド側に塗り足しは無い)', JSON.stringify(L));
  ok(near(R.x, kdp.margins.gutter) && near(kdp.paperW - (R.x + R.w), kdp.margins.fore + 3.2), 'KDP・右のページ: 左がノド、右が小口');
  ok(near(L.w, R.w) && near(L.w, kdp.trimW - kdp.margins.fore - kdp.margins.gutter), '版面の幅は左右のページで同じ(仕上がり − ノド − 小口)');
  ok(near(L.y, kdp.margins.top + 3.2) && near(L.h, kdp.trimH - kdp.margins.top - kdp.margins.bottom), '天地: 天の余白＋塗り足しから、版面の高さ');
  const S = typeAreaOnPaper(shop, 'left');
  ok(near(shop.paperW - (S.x + S.w), shop.margins.gutter + 3), '印刷所(四辺に塗り足し): ノド側にも塗り足しのぶんが足される');
}
{
  // 全面: 用紙いっぱいに、切り抜いて埋める
  const tall = imageOnPaper('full', kdp, 1000, 4000); // 縦に長い絵 → 幅を合わせ、天地がはみ出す
  ok(near(tall.w, kdp.paperW) && tall.h > kdp.paperH && near(tall.x, 0) && near(tall.y, (kdp.paperH - tall.h) / 2), '全面・縦長の絵: 幅を用紙に合わせ、天地は真ん中を切り出す', JSON.stringify(tall));
  const wide = imageOnPaper('full', kdp, 4000, 1000);
  ok(near(wide.h, kdp.paperH) && wide.w > kdp.paperW && near(wide.y, 0), '全面・横長の絵: 高さを用紙に合わせ、左右は真ん中を切り出す');
  // 余白すこし: 仕上がりの外周 4% を空けた箱に、切らずに収めて、用紙の真ん中
  const w = imageOnPaper('wide', kdp, 2400, 3393);
  const inset = kdp.trimW * 0.04;
  ok(w.w <= kdp.trimW - inset * 2 + 0.001 && w.h <= kdp.trimH - inset * 2 + 0.001 && near(w.x + w.w / 2, kdp.paperW / 2) && near(w.y + w.h / 2, kdp.paperH / 2), '余白すこし: 外周 4% を空けた箱に収まり、用紙の真ん中', JSON.stringify(w));
  ok(near(w.w / w.h, 2400 / 3393, 0.001), '余白すこし: 絵の縦横比は変えない');
  const n = imageOnPaper('narrow', kdp, 2400, 3393);
  ok(n.w < w.w && n.h < w.h, '余白おおめは、余白すこしより小さい');
  // 小さい絵は引き伸ばさない(96dpi の実寸)
  const s = imageOnPaper('wide', kdp, 200, 100);
  ok(near(s.w, (200 * 25.4) / 96) && near(s.h, (100 * 25.4) / 96), '小さい絵は引き伸ばさない(1画素 = 1/96 インチ)', JSON.stringify(s));
}
{
  // 1000×1000 の絵を全面で置く(B6 は縦長なので、高さを合わせて左右を切り出す)
  const center = [{ x: 400, y: 450, w: 200, h: 100, conf: 0.9 }];
  ok(judgeText(center, 1000, 1000, 'full', kdp, 'left').outside.length === 0, '真ん中の文字は、全面でも版面の中');
  const top = [{ x: 400, y: 5, w: 200, h: 40, conf: 0.9 }];
  const jt = judgeText(top, 1000, 1000, 'full', kdp, 'left');
  ok(jt.outside.length === 1 && jt.over.top > 5 && jt.over.bottom === 0 && jt.over.fore === 0 && jt.over.gutter === 0, '上端の文字は、天側にはみ出す', JSON.stringify(jt.over));
  ok(near(jt.outside[0].y, 0, 1) && jt.outside[0].y >= 0, 'はみ出した箱は、用紙の mm(用紙の外へは出さない)', JSON.stringify(jt.outside[0]));
  // 切り抜かれて用紙に出ない所(左端)の文字は、数えない
  const cropped = [{ x: 0, y: 450, w: 60, h: 100, conf: 0.9 }];
  const img = imageOnPaper('full', kdp, 1000, 1000);
  ok(img.x < 0 && judgeText(cropped, 1000, 1000, 'full', kdp, 'left').outside.length === (img.x + 60 * (img.w / 1000) > 0 ? 1 : 0), '切り抜かれて用紙に出ない文字は数えない(出ている分だけ見る)');
  // ノドと小口は、左右のページで入れ替わる。四辺に塗り足しのある本(印刷所)で測る:
  // 版面の左端は、左のページ(左が小口)より右のページ(左がノド)のほうが内側にある
  const a = typeAreaOnPaper(kdp, 'left');
  const k = img.w / 1000;
  const sImg = imageOnPaper('full', shop, 1000, 1000);
  const sk = sImg.w / 1000;
  const sL = typeAreaOnPaper(shop, 'left');
  const sR = typeAreaOnPaper(shop, 'right');
  const gap = sR.x - sL.x; // = ノドの余白 − 小口の余白
  ok(gap > 2.5, '(前提)この本は、ノドの余白が小口の余白より 2.5mm 以上広い', `差 ${gap.toFixed(2)}mm 余白 ${JSON.stringify(shop.margins)}`);
  // 左のページの版面の左端から 0.5mm 内側に左端がある箱 = 左のページでは中、右のページ(そこはノドの余白の中)では外
  const boxNearLeft = [{ x: (sL.x + 0.5 - sImg.x) / sk, y: 450, w: 100, h: 60, conf: 0.9 }];
  const onLeft = judgeText(boxNearLeft, 1000, 1000, 'full', shop, 'left');
  const onRight = judgeText(boxNearLeft, 1000, 1000, 'full', shop, 'right');
  ok(onLeft.outside.length === 0, '同じ絵・同じ文字が、左のページ(そちらが小口)では版面の中');
  ok(onRight.outside.length === 1 && near(onRight.over.gutter, gap - 0.5, 0.05) && onRight.over.fore === 0, '右のページ(そちらがノド)では外。はみ出しはノド側に数える', JSON.stringify(onRight.over));
  // 右端の近くでは逆: 右のページ(右が小口)では中、左のページ(右がノド)では外
  const rightEdge = sR.x + sR.w; // 右のページの版面の右端(用紙の左から)
  const boxNearRight = [{ x: (rightEdge - 0.5 - sImg.x) / sk - 100, y: 450, w: 100, h: 60, conf: 0.9 }];
  const rOnRight = judgeText(boxNearRight, 1000, 1000, 'full', shop, 'right');
  const rOnLeft = judgeText(boxNearRight, 1000, 1000, 'full', shop, 'left');
  ok(rOnRight.outside.length === 0 && rOnLeft.outside.length === 1 && rOnLeft.over.gutter > 0 && rOnLeft.over.fore === 0, '右端の近くの文字は逆: 右のページでは中、左のページ(右がノド)では外', `${JSON.stringify(rOnRight.over)} / ${JSON.stringify(rOnLeft.over)}`);
  // 1mm までのはみ出しは見逃す(箱は字より少し大きく出る)
  const edge = [{ x: (a.x - 0.8 - img.x) / k, y: 450, w: 100, h: 60, conf: 0.9 }];
  ok(judgeText(edge, 1000, 1000, 'full', kdp, 'left').outside.length === 0, '0.8mm のはみ出しは見逃す(許す幅 1mm)');
  const edge2 = [{ x: (a.x - 1.5 - img.x) / k, y: 450, w: 100, h: 60, conf: 0.9 }];
  const je = judgeText(edge2, 1000, 1000, 'full', kdp, 'left');
  ok(je.outside.length === 1 && near(je.over.fore, 1.5, 0.05), '1.5mm のはみ出しは拾う(小口側に 1.5mm)', JSON.stringify(je.over));
  ok(overText({ top: 0, bottom: 3, fore: 6.2, gutter: 0 }) === '外側（小口）へ 6.2mm・下へ 3.0mm はみ出し', 'はみ出しを言葉にする(上・下・外側・綴じる側で言う。大きい順。出ていない辺は言わない)', overText({ top: 0, bottom: 3, fore: 6.2, gutter: 0 }));
  ok(overText({ top: 2, bottom: 0, fore: 0, gutter: 4 }) === '綴じる側（ノド）へ 4.0mm・上へ 2.0mm はみ出し', 'ノドは「綴じる側（ノド）」、天は「上」と言う', overText({ top: 2, bottom: 0, fore: 0, gutter: 4 }));
}
{
  // 検査にかける絵の選び方
  const plates: Plate[] = [
    { id: 'a', src: 'data:image/png;base64,AAAA', beforeChapter: 0, size: 'full' },
    { id: 'b', src: 'data:image/png;base64,BBBB', beforeChapter: 0, size: 'print' }, // 版面いっぱい → 見ない
    { id: 'c', src: '', beforeChapter: 0, size: 'wide' }, // 絵が無い → 見ない
    { id: 'd', src: '', beforeChapter: 0, size: 'full', blank: true }, // 白ページ → 見ない
    { id: 'e', src: 'data:image/png;base64,EEEE', beforeChapter: 0, size: 'wide', textOk: true }, // このままにする → 見ない
    { id: 'f', src: 'data:image/png;base64,FFFF', beforeChapter: 0, size: 'narrow' },
  ];
  const ms = {
    title: 't',
    author: '',
    chapters: [
      {
        title: '一',
        blocks: [
          { type: 'p', text: 'あ' },
          { type: 'image', src: 'data:image/png;base64,G', full: true },
          { type: 'image', src: 'data:image/png;base64,H' }, // 本文の中 → 見ない
          { type: 'image', src: 'data:image/png;base64,I', size: 'print' }, // 版面いっぱい → 見ない
          { type: 'image', src: 'data:image/png;base64,J', size: 'wide' },
          { type: 'image', src: 'data:image/png;base64,K', size: 'narrow', textOk: true }, // このままにする → 見ない
        ],
      },
    ],
  } as unknown as Manuscript;
  const ts = textTargets(ms, { plates }, imageKey);
  ok(ts.map((t) => `${t.kind}:${t.key}:${t.place}`).join(' ') === `plate:a:full plate:f:narrow img:${imageKey(0, 1)}:full img:${imageKey(0, 4)}:wide`, '検査にかけるのは、版面の外に出うる大きさの絵だけ(版面いっぱい・本文の中・白ページ・このままにする絵は外す)', ts.map((t) => `${t.kind}:${t.key}:${t.place}`).join(' '));

  // まとめ: 調べていない絵・調べられなかった絵・文字の無い絵は、何も言わない
  const edgeBox = [{ x: 5, y: 5, w: 300, h: 40, conf: 0.9 }];
  const detected = new Map<string, { w: number; h: number; boxes: typeof edgeBox } | null>([
    ['data:image/png;base64,AAAA', { w: 1000, h: 1400, boxes: edgeBox }],
    ['data:image/png;base64,FFFF', null], // 調べられなかった
    ['data:image/png;base64,G', { w: 1000, h: 1400, boxes: [] }], // 文字なし
    // J は、まだ調べていない(入っていない)
  ]);
  const fs = findTextOutside(ts, detected, kdp, 'vertical', 'perfect', (t) => (t.key === 'a' ? 12 : undefined));
  ok(fs.length === 1 && fs[0].target.key === 'a' && fs[0].page === 12 && fs[0].side === 'right', '判定するのは、調べ終わって文字のあった絵だけ。ページから左右を決める(縦組みの12ページ目は右)', JSON.stringify(fs.map((f) => [f.target.key, f.page, f.side])));
  const unknown = findTextOutside(ts, detected, kdp, 'vertical', 'perfect', () => undefined);
  ok(unknown.length === 1 && unknown[0].page === null, 'ページがまだ分からないとき: 左右どちらに出ても外になる絵(上端の文字)は言う(ページは null)');
  // 片側のページでだけ外になる絵は、ページが分かるまで言わない(組み上がったら消える知らせ = 嘘、を出さない)
  {
    const sImg = imageOnPaper('full', shop, 1000, 1000);
    const sL = typeAreaOnPaper(shop, 'left');
    const oneSide = [{ x: (sL.x + 0.5 - sImg.x) / (sImg.w / 1000), y: 450, w: 100, h: 60, conf: 0.9 }];
    const tg = [{ kind: 'plate' as const, key: 'z', src: 'z', place: 'full' as const }];
    const dz = new Map([['z', { w: 1000, h: 1000, boxes: oneSide }]]);
    ok(findTextOutside(tg, dz, shop, 'vertical', 'perfect', () => undefined).length === 0, '片側のページでだけ外になる絵は、ページが分かるまで言わない');
    ok(findTextOutside(tg, dz, shop, 'vertical', 'perfect', () => 2).length === 1, '(同じ絵) 右のページ(縦組みの2ページ目)だと分かれば言う');
    ok(findTextOutside(tg, dz, shop, 'vertical', 'perfect', () => 1).length === 0, '(同じ絵) 左のページ(1ページ目)だと分かれば、言わない');
  }

  const css = textMarksCss(fs);
  ok(css.includes(':has([data-plate="a"])') && css.includes('::after') && (css.match(/linear-gradient/g) ?? []).length === 1 && /mm \d/.test(css.replace(/\s+/g, ' ')), '下見に重ねる CSS: その絵のあるページの ::after に、箱の数だけ色を重ねる(mm)', css.slice(0, 200));
  ok(textMarksCss(unknown) === '', 'ページが分からないあいだは、色を重ねない(左右が決まらないと場所が決まらない)');
  ok(textRowKey({ kind: 'plate', key: 'a' }) === 'plate:a' && textRowKey({ kind: 'img', key: imageKey(0, 1) }) === `img:${imageKey(0, 1)}`, '行の鍵は plate:id / img:鍵(PlateEditor が引く形)');
  const many = [{ ...fs[0], outside: Array.from({ length: 200 }, (_, i) => ({ x: i, y: 1, w: 1, h: 1 })) }];
  ok((textMarksCss(many).match(/linear-gradient/g) ?? []).length === 80, '箱が多い絵(表など)でも、重ねるのは 80 個まで');
  const img = findTextOutside(
    [{ kind: 'img', key: imageKey(0, 1), src: 'x', place: 'full' }],
    new Map([['x', { w: 1000, h: 1400, boxes: edgeBox }]]),
    kdp,
    'vertical',
    'perfect',
    () => 3,
  );
  ok(textMarksCss(img).includes(`:has([data-img="${imageKey(0, 1)}"])`), '章の途中の絵は data-img で引く');
}

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
