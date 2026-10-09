// 絵の中の文字を見つける(文字検出モデル DBNet = PP-OCR の検出部)の、前処理と後処理。
//
// ## なぜ在るか
//
// 絵の中に描かれた文字が版面(余白の内側)から外に出ていると、印刷の入稿で止められる(KDP は絵の中の文字も
// 機械で検出する。2026-09-30 ユーザーの知見)。それを先に知らせるには、**絵のどこに文字があるか**だけ分かればよい
// (読める必要は無い)。検出モデルが返すのは「ここが文字らしい」という確率の図なので、それを箱に直すのがここ。
//
// ## 決めた値の出どころ(2026-10-02 の試作。47枚の試し絵で測った)
//
// いちばん困るのは、文字の無い絵(写真・絵画・模様)を「文字あり」と言うこと。次が、端の文字の見落とし。
// PP-OCRv4 の mobile の検出モデル・長辺 1024 で、下の値(DETECT_OPTIONS)にすると
//   - 文字の無い絵 34枚(絵画・背景・模様・図形だけの図)で、箱 0
//   - 文字のある合成の絵 9枚で、正解の箱 442 のうち 440(端の文字 108 のうち 106)。見つけた文字の外周の誤差は 13 画素まで
//   - 実物の図表 3枚の外周が、目で見た外周と 1% 以内。図の上端の小さい「グラフビュー」も拾う
// 箱の自信のしきい値は 0.5〜0.97 のどれでも誤りが 0 だった(幅が広い = たまたま合わせた値ではない)。
// 長辺 1536 にすると文字の無い絵 3枚に箱が出たので、**大きくしない**(細かい模様を文字と見るようになる)。
//
// OpenCV は使わない(配る大きさを増やさない)。外部依存なし。Worker の中でも node でも動く。

/** ネットワークに入れる大きさと、元の絵の座標へ戻すための比 */
export interface Geom {
  /** ネットワークに入れる幅・高さ(32 の倍数) */
  netW: number;
  netH: number;
  /** ネットワークの1画素が、元の絵の何画素か */
  sx: number;
  sy: number;
  srcW: number;
  srcH: number;
}

/** 見つけた文字の箱(元の絵の画素)。conf は自信の値(0〜1) */
export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface DetectOptions {
  /** 絵を縮める長辺(画素)。拡大はしない */
  limit: number;
  /** 確率の図を二値化するしきい値 */
  thresh: number;
  /** 箱の自信(塊の中の確率の平均)の下限 */
  boxThresh: number;
  /** 塊の外接矩形の短辺の下限(ネットワーク上の画素) */
  minSide: number;
  /** 塊の画素数 ÷ 外接矩形の面積 の下限(ぐにゃぐにゃ・斜めの模様を落とす) */
  minFill: number;
  /** 箱の中の「線の多さ」(輝度の勾配が大きい画素の割合)の下限。なめらかな濃淡・ベタ塗りの図形を落とす */
  minEdge: number;
  /** 箱の広げ具合(DB の標準。モデルは文字を少し内側に縮めて出すので、外へ戻す) */
  unclip: number;
}

/** 試作で決めた値(このファイルの頭の説明) */
export const DETECT_OPTIONS: DetectOptions = {
  limit: 1024,
  thresh: 0.4,
  boxThresh: 0.7,
  minSide: 5,
  minFill: 0.7,
  minEdge: 0.14,
  unclip: 1.5,
};

/**
 * 絵の大きさから、ネットワークに入れる大きさを決める。
 * 長辺が limit を超えるなら縮め、各辺を 32 の倍数に丸めて全面に敷く(縦横比は最大 16 画素ぶん崩れる。PaddleOCR の標準と同じ)
 */
export function planResize(w: number, h: number, limit: number): Geom {
  const longSide = Math.max(w, h);
  const scale = longSide > limit ? limit / longSide : 1;
  const netW = Math.max(32, Math.round((w * scale) / 32) * 32);
  const netH = Math.max(32, Math.round((h * scale) / 32) * 32);
  return { netW, netH, sx: w / netW, sy: h / netH, srcW: w, srcH: h };
}

/**
 * RGBA(netW×netH。canvas で縮めたもの) → Float32 [1, 3, netH, netW]。
 * チャンネルは BGR の順(PaddleOCR は OpenCV の BGR のまま ImageNet の mean/std を引く)
 */
export function rgbaToTensor(rgba: Uint8ClampedArray | Uint8Array, g: Geom): Float32Array {
  const plane = g.netW * g.netH;
  const out = new Float32Array(3 * plane);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const k0 = 1 / (255 * std[0]);
  const k1 = 1 / (255 * std[1]);
  const k2 = 1 / (255 * std[2]);
  const b0 = -mean[0] / std[0];
  const b1 = -mean[1] / std[1];
  const b2 = -mean[2] / std[2];
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = rgba[p + 2] * k0 + b0;
    out[plane + i] = rgba[p + 1] * k1 + b1;
    out[2 * plane + i] = rgba[p] * k2 + b2;
  }
  return out;
}

/** RGBA → 輝度(0〜255) */
export function lumaFromRgba(rgba: Uint8ClampedArray | Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  return out;
}

interface Comp {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cnt: number;
  sum: number;
}

/** 確率の図を二値化し、つながった塊(8近傍)ごとに、外接矩形・画素数・確率の和を集める */
function components(prob: Float32Array, W: number, H: number, thresh: number): Comp[] {
  const n = W * H;
  const label = new Int32Array(n);
  const parent = new Int32Array((n >> 1) + 2);
  let next = 1;
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) {
      if (a < b) parent[b] = a;
      else parent[a] = b;
    }
  };
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (!(prob[i] > thresh)) continue;
      let l = 0;
      const a = x > 0 ? label[i - 1] : 0;
      const b = y > 0 ? label[i - W] : 0;
      const c = y > 0 && x > 0 ? label[i - W - 1] : 0;
      const d = y > 0 && x < W - 1 ? label[i - W + 1] : 0;
      if (a) l = a;
      if (b) {
        if (l) union(l, b);
        else l = b;
      }
      if (c) {
        if (l) union(l, c);
        else l = c;
      }
      if (d) {
        if (l) union(l, d);
        else l = d;
      }
      if (!l) {
        l = next;
        parent[l] = l;
        next++;
      }
      label[i] = l;
    }
  }
  if (next === 1) return [];
  const byRoot = new Map<number, Comp>();
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const l0 = label[row + x];
      if (!l0) continue;
      const l = find(l0);
      let c = byRoot.get(l);
      if (!c) {
        c = { x0: x, y0: y, x1: x, y1: y, cnt: 0, sum: 0 };
        byRoot.set(l, c);
      }
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y > c.y1) c.y1 = y;
      c.cnt++;
      c.sum += prob[row + x];
    }
  }
  return [...byRoot.values()];
}

/** 箱の中で、輝度の勾配が大きい画素の割合(線・画の細かさ) */
function edgeRate(luma: Uint8Array, W: number, H: number, x0: number, y0: number, x1: number, y1: number): number {
  const ax = Math.max(1, Math.floor(x0));
  const ay = Math.max(1, Math.floor(y0));
  const bx = Math.min(W - 2, Math.ceil(x1));
  const by = Math.min(H - 2, Math.ceil(y1));
  if (bx <= ax || by <= ay) return 0;
  let n = 0;
  let e = 0;
  for (let y = ay; y < by; y++) {
    const row = y * W;
    for (let x = ax; x < bx; x++) {
      const i = row + x;
      n++;
      const gx = luma[i + 1] - luma[i - 1];
      const gy = luma[i + W] - luma[i - W];
      if (Math.abs(gx) + Math.abs(gy) > 48) e++;
    }
  }
  return e / n;
}

/**
 * 確率の図 → 文字の箱(元の絵の画素)。
 * @param prob モデルの出力(netW×netH の確率)
 * @param luma ネットワークに入れた絵の輝度(netW×netH)。「線の多さ」の絞り込みに使う
 */
export function probToBoxes(prob: Float32Array, luma: Uint8Array, g: Geom, o: DetectOptions = DETECT_OPTIONS): TextBox[] {
  const boxes: TextBox[] = [];
  for (const c of components(prob, g.netW, g.netH, o.thresh)) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    if (Math.min(bw, bh) < o.minSide) continue;
    if (c.cnt / (bw * bh) < o.minFill) continue;
    const conf = c.sum / c.cnt;
    if (conf < o.boxThresh) continue;
    // 広げる(DB の標準: 面積 × unclip ÷ 周長 だけ四方へ。長方形で近似)
    const dist = (bw * bh * o.unclip) / (2 * (bw + bh));
    const x0 = c.x0 - dist;
    const y0 = c.y0 - dist;
    const x1 = c.x1 + 1 + dist;
    const y1 = c.y1 + 1 + dist;
    if (edgeRate(luma, g.netW, g.netH, x0, y0, x1, y1) < o.minEdge) continue;
    const X0 = Math.max(0, x0 * g.sx);
    const Y0 = Math.max(0, y0 * g.sy);
    const X1 = Math.min(g.srcW, x1 * g.sx);
    const Y1 = Math.min(g.srcH, y1 * g.sy);
    if (X1 <= X0 || Y1 <= Y0) continue;
    boxes.push({ x: Math.round(X0), y: Math.round(Y0), w: Math.round(X1 - X0), h: Math.round(Y1 - Y0), conf: Math.round(conf * 1000) / 1000 });
  }
  boxes.sort((a, b) => b.conf - a.conf);
  return boxes;
}
