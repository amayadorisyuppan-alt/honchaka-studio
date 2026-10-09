#!/usr/bin/env python3
"""グレーの濃さの表(src/press/grayTone.ts の GRAY_TONE)を作る道具。

なぜ在るか
  入稿用の変換は、無彩色(黒・グレー)を K だけで刷る。PDF の決まりで、DeviceGray の値 v は
  そのまま K = 1 - v のインクの量になる(色の管理を通らない)。ところが画面のグレー(sRGB)の v と、
  K = 1 - v で刷った明るさは同じではない。Japan Color 2011 Coated で測ると、真ん中のグレー(v=0.5)で
  L* が 14.5 も明るく(薄く)刷られる(2026-10-01 実測)。写真を扱う道具(Photoshop のグレースケール変換)が
  「ドットゲイン」ぶんを見込んで値を濃くするのと同じことを、この表でやる。

何をするか
  1. ICC(K だけ・C=M=Y=0)で、K 0〜255 の全段の明るさ L* を LittleCMS(Pillow の ImageCms)で測る
     (相対的な色域の合わせ方。紙の白が 100)。8ビットの Lab は L* が 0.39 刻みなので、
     単調にそろえてから軽くならして使う。
  2. 画面のグレー v(sRGB)の輝度 Y に、黒点の補正をかけて目標にする:
        Y目標 = Yk100 + (1 - Yk100) * Y画面       (Yk100 は K100% の輝度。L* 18.4 → Y 0.026)
     K100% は印刷で出せるいちばん暗い所なので、画面の黒(Y=0)には届かない。そのぶん暗い側を詰める。
  3. Y目標 になる K を、測った曲線から逆に引く。表の値は 255 - K。
  守ること: 0 → 0(文字の黒は K100% のまま)、255 → 255(紙の地に点を置かない)、単調に増える、なめらか。

回し方
  python scripts/press/make-gray-tone.py            # 表と、直す前・あとの L* の差を表示(±1.5 を越えたら終了コード 1)
  python scripts/press/make-gray-tone.py --json     # 表(256 個)だけを JSON で標準出力へ
  python scripts/press/make-gray-tone.py --ts       # grayTone.ts に貼る形(1行16個)で出す
  python scripts/press/make-gray-tone.py --icc <path>   # 別の ICC で作る
  (PYTHONIOENCODING=utf-8 を付けると Windows でも日本語が化けない)

表を作り直すのはどんなとき
  ICC を替えたとき(別の印刷条件に合わせるとき)。作り直したら、--ts の出力を src/press/grayTone.ts の
  GRAY_TONE に貼り替え、表を作った日付を直す。scripts/press/grayTone.test.ts が、この道具の出力と
  grayTone.ts の定数が一致することを確かめる(python が呼べるとき)。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ICC = REPO / "src" / "press" / "JapanColor2011Coated.icc"
# 直したあとの L* の差の許容(黒点の補正を見込んだ目標との差)
TOLERANCE = 1.5


def measure_k_curve(icc_path: Path) -> np.ndarray:
    """K だけ(C=M=Y=0)の K = 0..255 の L*(紙の白が 100 の相対的な値)を返す(256 個)"""
    prof = ImageCms.getOpenProfile(str(icc_path))
    lab = ImageCms.createProfile("LAB")
    # 相対的な色域の合わせ方(INTENT_RELATIVE_COLORIMETRIC)。黒点の補正のフラグは付けない(印刷機は黒点を補正しない)
    xf = ImageCms.buildTransform(prof, lab, "CMYK", "LAB", renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
    # Pillow の CMYK は 255 が 100%。K だけ 0..255 を 256 x 1 の画像に並べる
    k = np.arange(256, dtype=np.uint8)
    cmyk = np.zeros((1, 256, 4), dtype=np.uint8)
    cmyk[0, :, 3] = k
    img = Image.frombytes("CMYK", (256, 1), cmyk.tobytes())
    out = np.asarray(ImageCms.applyTransform(img, xf))
    # Pillow の Lab は L が 0..255(= L* × 255 / 100)
    return out[0, :, 0].astype(np.float64) * 100.0 / 255.0


def isotonic_decreasing(y: np.ndarray) -> np.ndarray:
    """単調に減るように、隣どうしの逆転を平均でならす(pool adjacent violators)"""
    n = len(y)
    vals = list(-y)  # 増える向きに直して PAV
    wts = [1.0] * n
    blocks: list[list[float]] = []  # [値の平均, 重み, 長さ]
    for v, w in zip(vals, wts):
        blocks.append([v, w, 1])
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            v2, w2, n2 = blocks.pop()
            v1, w1, n1 = blocks.pop()
            blocks.append([(v1 * w1 + v2 * w2) / (w1 + w2), w1 + w2, n1 + n2])
    out = np.concatenate([np.full(int(b[2]), b[0]) for b in blocks])
    return -out


def smooth_curve(l_star: np.ndarray) -> np.ndarray:
    """測った L*(K=0..255。K が増えると減る)を、単調にそろえて軽くならす。両端は動かさない"""
    mono = isotonic_decreasing(l_star)
    # 8ビット Lab の刻み(0.39)の揺れを消すだけの、狭い窓の移動平均(端は折り返さず、窓を狭める)
    half = 3
    out = mono.copy()
    for i in range(1, 255):
        h = min(half, i, 255 - i)
        out[i] = mono[i - h : i + h + 1].mean()
    out[0], out[255] = mono[0], mono[255]
    return isotonic_decreasing(out)


def lstar_to_y(l: np.ndarray | float):
    l = np.asarray(l, dtype=np.float64)
    f = (l + 16.0) / 116.0
    return np.where(l > 8.0, f**3, l / 903.2963)


def y_to_lstar(y: np.ndarray | float):
    y = np.asarray(y, dtype=np.float64)
    return np.where(y > 216.0 / 24389.0, 116.0 * np.cbrt(y) - 16.0, y * 903.2963)


def srgb_to_y(v8: np.ndarray) -> np.ndarray:
    """sRGB のグレー(0〜255)の輝度 Y(0〜1)"""
    c = v8.astype(np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def build_table(l_k_raw: np.ndarray) -> dict:
    l_k = smooth_curve(l_k_raw)
    y_k = lstar_to_y(l_k)  # K=0..255 の輝度(K が増えると減る)
    y_k100 = float(y_k[255])

    v = np.arange(256)
    y_screen = srgb_to_y(v)
    y_target = y_k100 + (1.0 - y_k100) * y_screen
    # 目標の輝度になる K を、曲線から逆に引く。np.interp は増える x を要る(y_k は K と逆向きなので、並べ替える)
    k_for_target = np.interp(y_target, y_k[::-1], np.arange(255, -1, -1, dtype=np.float64))
    table = np.rint(255.0 - k_for_target).astype(np.int64)
    # 端を決め打ち(0 → 0・255 → 255)し、単調に増えるようにそろえる
    table[0], table[255] = 0, 255
    table = np.maximum.accumulate(np.clip(table, 0, 255))

    # 刷り上がりの L*(直す前: K = 255 - v、直したあと: K = 255 - table[v])。生の測定値で見る(ならした値は使わない)
    l_before = l_k_raw[255 - v]
    l_after = l_k_raw[255 - table]
    l_screen = y_to_lstar(y_screen)
    l_target = y_to_lstar(y_target)
    return dict(
        table=table,
        l_k=l_k,
        l_k_raw=l_k_raw,
        l_screen=l_screen,
        l_target=l_target,
        l_before=l_before,
        l_after=l_after,
        y_k100=y_k100,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="グレーの濃さの表を作る")
    ap.add_argument("--icc", type=Path, default=DEFAULT_ICC)
    ap.add_argument("--json", action="store_true", help="表(256 個)だけを JSON で出す")
    ap.add_argument("--ts", action="store_true", help="grayTone.ts に貼る形で出す")
    args = ap.parse_args()

    r = build_table(measure_k_curve(args.icc))
    t: np.ndarray = r["table"]

    if args.json:
        print(json.dumps([int(x) for x in t]))
        return 0
    if args.ts:
        rows = []
        for i in range(0, 256, 16):
            rows.append("  " + ", ".join(f"{int(x)}" for x in t[i : i + 16]) + ",")
        print("\n".join(rows))
        return 0

    print(f"ICC: {args.icc.name}   K100% の L* = {r['l_k_raw'][255]:.1f}(輝度 Y = {r['y_k100']:.4f})")
    print()
    print("  v   表の値 | 画面の L*  目標の L* | 直す前の L*  差(画面)  差(目標) | 直したあとの L*  差(目標)")
    worst_after = 0.0
    for i in list(range(0, 256, 16)) + [255]:
        print(
            f"{i:4d}  {int(t[i]):6d} | {r['l_screen'][i]:8.1f}  {r['l_target'][i]:8.1f} |"
            f" {r['l_before'][i]:10.1f}  {r['l_before'][i] - r['l_screen'][i]:+8.1f}  {r['l_before'][i] - r['l_target'][i]:+8.1f} |"
            f" {r['l_after'][i]:14.1f}  {r['l_after'][i] - r['l_target'][i]:+8.1f}"
        )
    d_after = r["l_after"] - r["l_target"]
    d_before = r["l_before"] - r["l_target"]
    worst_after = float(np.abs(d_after).max())
    print()
    print(f"直す前: 目標との差の最大 {np.abs(d_before).max():.1f}(v={int(np.abs(d_before).argmax())})")
    print(f"直した後: 目標との差の最大 {worst_after:.2f}(v={int(np.abs(d_after).argmax())})  許容 ±{TOLERANCE}")
    steps = np.diff(t)
    print(f"表の段の飛び: 最大 {int(steps.max())}・0 の段(同じ値が続く){int((steps == 0).sum())} か所・単調 {bool((steps >= 0).all())}")
    print(f"表の代表: " + "  ".join(f"{i}→{int(t[i])}" for i in (0, 32, 64, 96, 128, 160, 192, 224, 255)))
    ok = worst_after <= TOLERANCE and t[0] == 0 and t[255] == 255 and bool((steps >= 0).all())
    if not ok:
        print("表の条件を満たしていません", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
