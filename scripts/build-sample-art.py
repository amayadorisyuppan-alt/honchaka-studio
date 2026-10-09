# -*- coding: utf-8 -*-
# サンプルの本「青い背表紙」の挿絵2枚を Pillow で描く。(2026-10-05)
#   street_spread : 見開き(2ページ)の挿絵 4200x3000。商店街の通り(喫茶店と古書店〈縹堂〉)
#   map           : 版面いっぱいの挿絵 3000x4200。商店街の地図(駅・商店街・古書店・祖母の家)
# **生成AIは使っていない**(平らな図形と文字を、コードで描いた切り絵風の絵)。そのため sampleArt.ts は fromPreset を付けない。
#
#   python scripts/build-sample-art.py            → public/sample/street-spread.jpg と map-print.jpg
#   python scripts/build-sample-art.py <出力先>    → 出力先に PNG も出す(確認用)
#
# **看板の文字は、どの判型・綴じ方でも「絵の中の文字が版面の外」の知らせが出ない所にだけ置く。**
# 左右のページの版面は、判型(文庫〜A4)・縦横・出し先で変わる。そのいちばん狭い所(新書の見開きは用紙が正方形に近く、
# 4200x3000 の絵の左右が切れる。A4 縦組みは天地の余白が大きい)の積集合が、
#   左ページ x 650〜1650・右ページ x 2550〜3550、y 630〜2230(絵の画素)
# なので、文字はそこに収める(折り目の 2100 から 450px = 約 23mm 以上離れる)。
# 絵を描き替えたら、スタジオの文字検出(src/textcheck)を掛け直して知らせが出ないことを確かめること(docs/TESTING.md)。
# 書体は Noto Serif JP(看板・ラベル)。アプリに同梱の書体と同じ家族(OFL)。Windows では C:/Windows/Fonts のものを使う。
import math
import os
import random
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
import numpy as np

SS = 2  # 描くときの倍率(縮めてなめらかにする)
BASE_W, BASE_H = 4200, 3000
FONT_SERIF = os.environ.get('NOTO_SERIF_JP_VF', 'C:/Windows/Fonts/NotoSerifJP-VF.ttf')
FONT_GOTHIC = 'C:/Windows/Fonts/BIZ-UDGothicB.ttc'


def serif(px, wght=800):
    f = ImageFont.truetype(FONT_SERIF, int(px * SS))
    f.set_variation_by_axes([wght])
    return f


def gothic(px):
    return ImageFont.truetype(FONT_GOTHIC, int(px * SS), index=0)


def hexc(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.im = Image.new('RGB', (w * SS, h * SS), hexc('#F1E9D8'))
        self.d = ImageDraw.Draw(self.im)

    def s(self, v):
        return [round(x * SS) for x in v] if isinstance(v, (list, tuple)) else round(v * SS)

    def rect(self, x0, y0, x1, y1, fill, outline=None, width=0, r=0):
        box = [round(x0 * SS), round(y0 * SS), round(x1 * SS), round(y1 * SS)]
        if r:
            self.d.rounded_rectangle(box, radius=round(r * SS), fill=fill, outline=outline, width=round(width * SS))
        else:
            self.d.rectangle(box, fill=fill, outline=outline, width=round(width * SS))

    def poly(self, pts, fill, outline=None):
        self.d.polygon([(round(x * SS), round(y * SS)) for x, y in pts], fill=fill, outline=outline)

    def ell(self, x0, y0, x1, y1, fill, outline=None, width=0):
        self.d.ellipse([round(x0 * SS), round(y0 * SS), round(x1 * SS), round(y1 * SS)], fill=fill, outline=outline, width=round(width * SS))

    def line(self, pts, fill, width):
        self.d.line([(round(x * SS), round(y * SS)) for x, y in pts], fill=fill, width=max(1, round(width * SS)), joint='curve')

    def text_ink(self, x, y, s, font, fill, anchor='la'):
        """文字を描き、インクの範囲(基準座標)を返す。x,y は左上基準"""
        self.d.text((round(x * SS), round(y * SS)), s, font=font, fill=fill, anchor=anchor)
        b = self.d.textbbox((round(x * SS), round(y * SS)), s, font=font, anchor=anchor)
        return [b[0] / SS, b[1] / SS, b[2] / SS, b[3] / SS]

    def finish(self, grain=True, seed=7):
        out = self.im.resize((self.w, self.h), Image.LANCZOS)
        if grain:
            rng = np.random.default_rng(seed)
            a = np.asarray(out).astype(np.float32)
            # 紙の目(細かいざらつき)
            fine = np.clip(rng.normal(128, 9, (self.h, self.w)), 0, 255).astype(np.uint8)
            fine = (np.asarray(Image.fromarray(fine, 'L').filter(ImageFilter.GaussianBlur(0.7))).astype(np.float32) - 128) * 0.45
            # 水彩のにじみ(大きなむら)
            low = rng.normal(0, 1, (self.h // 160 + 2, self.w // 160 + 2)).astype(np.float32)
            low = np.asarray(Image.fromarray(low).resize((self.w, self.h), Image.BICUBIC))
            a = a * (1 + 0.018 * low[..., None]) + fine[..., None]
            out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
        return out


def lerp(c0, c1, t):
    return tuple(round(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))


# ---------------------------------------------------------------------------------------------
# 商店街の通り(基準 4200x3000)。drawTexts=False なら、看板の文字を描かない(テスト印刷の下絵)
# ---------------------------------------------------------------------------------------------
NAVY = '#23394F'
CREAM = '#F6EFDC'
INK = '#1F2A33'


def striped_awning(c, x0, x1, y0, y1, ca, cb, n, scallop=34):
    w = (x1 - x0) / n
    for i in range(n):
        c.rect(x0 + w * i, y0, x0 + w * (i + 1), y1, ca if i % 2 == 0 else cb)
    for i in range(n):
        col = ca if i % 2 == 0 else cb
        c.ell(x0 + w * i, y1 - scallop, x0 + w * (i + 1), y1 + scallop, col)
    c.rect(x0, y0 - 14, x1, y0 + 8, '#00000022' if False else lerp(hexc(ca), (0, 0, 0), 0.25))


def roof(c, x0, x1, y0, y1, col, tile_col):
    c.rect(x0, y0, x1, y1, col)
    # 瓦の段
    step = (y1 - y0) / 5
    for i in range(1, 5):
        c.line([(x0, y0 + step * i), (x1, y0 + step * i)], tile_col, 5)
    c.rect(x0 - 24, y0 - 10, x1 + 24, y0 + 26, tile_col)


def window(c, x0, y0, x1, y1, frame, glass, bars=2):
    c.rect(x0, y0, x1, y1, frame)
    c.rect(x0 + 14, y0 + 14, x1 - 14, y1 - 14, glass)
    for i in range(1, bars):
        xx = x0 + (x1 - x0) * i / bars
        c.rect(xx - 5, y0 + 14, xx + 5, y1 - 14, frame)
    c.rect(x0 + 14, (y0 + y1) / 2 - 5, x1 - 14, (y0 + y1) / 2 + 5, frame)


def potted_plant(c, x, y, s=1.0, leaf='#5E8A66'):
    c.poly([(x - 55 * s, y - 80 * s), (x + 55 * s, y - 80 * s), (x + 40 * s, y), (x - 40 * s, y)], '#B5714F')
    for dx, dy, r in [(-38, -150, 52), (30, -170, 58), (0, -215, 56), (-10, -130, 45)]:
        c.ell(x + (dx - r) * s, y + (dy - r) * s, x + (dx + r) * s, y + (dy + r) * s, leaf)


def lantern(c, x, y, s=1.0, col='#B5533C'):
    c.line([(x, y - 90 * s), (x, y - 40 * s)], '#3A3A3A', 5)
    c.ell(x - 38 * s, y - 40 * s, x + 38 * s, y + 70 * s, col)
    c.rect(x - 22 * s, y - 48 * s, x + 22 * s, y - 36 * s, '#3A3A3A')
    c.rect(x - 22 * s, y + 66 * s, x + 22 * s, y + 78 * s, '#3A3A3A')
    for k in (-14, 0, 14):
        c.line([(x + k * s, y - 30 * s), (x + k * s * 1.25, y + 62 * s)], lerp(hexc(col), (0, 0, 0), 0.25), 3)


def books_row(c, x0, x1, ybase, hmin, hmax, seed, blue_at=None):
    rnd = random.Random(seed)
    pal = ['#8C6A4F', '#B4894B', '#5F7F73', '#A55E4A', '#4C6481', '#D1B58A', '#7E5C6E', '#6C7F56', '#C79A62']
    x = x0
    while x < x1 - 20:
        w = rnd.randint(22, 44)
        h = rnd.randint(hmin, hmax)
        col = pal[rnd.randrange(len(pal))]
        if blue_at is not None and x0 + blue_at <= x < x0 + blue_at + 60:
            col = '#1E4F8F'
            h = hmax + 14
            w = 52
        c.rect(x, ybase - h, min(x + w, x1), ybase, col)
        c.rect(x + 5, ybase - h + 12, x + w - 5, ybase - h + 18, lerp(hexc(col), (255, 255, 255), 0.4))
        x += w + 2


def bird(c, x, y, s, col):
    # つばめ(切り絵風): 胴・翼・尾
    c.ell(x - 30 * s, y - 14 * s, x + 30 * s, y + 18 * s, col)
    c.poly([(x - 6 * s, y - 6 * s), (x - 70 * s, y - 52 * s), (x - 20 * s, y + 8 * s)], col)
    c.poly([(x + 6 * s, y - 6 * s), (x + 70 * s, y - 52 * s), (x + 20 * s, y + 8 * s)], col)
    c.poly([(x - 24 * s, y + 8 * s), (x - 62 * s, y + 44 * s), (x - 8 * s, y + 16 * s)], col)
    c.poly([(x - 14 * s, y + 10 * s), (x - 40 * s, y + 56 * s), (x + 4 * s, y + 14 * s)], col)


def person(c, x, ybase, s, coat, hair='#2E2A28', book=None):
    # 顔を描かない平たい人影
    c.poly([(x - 28 * s, ybase - 190 * s), (x + 28 * s, ybase - 190 * s), (x + 40 * s, ybase - 60 * s), (x - 40 * s, ybase - 60 * s)], coat)
    c.rect(x - 24 * s, ybase - 62 * s, x - 6 * s, ybase, '#2E2E36')
    c.rect(x + 6 * s, ybase - 62 * s, x + 24 * s, ybase, '#2E2E36')
    c.ell(x - 24 * s, ybase - 250 * s, x + 24 * s, ybase - 196 * s, '#E3C3A0')
    c.ell(x - 26 * s, ybase - 258 * s, x + 26 * s, ybase - 222 * s, hair)
    if book:
        c.rect(x - 22 * s, ybase - 150 * s, x + 14 * s, ybase - 108 * s, book)


def street_scene(draw_texts=True, clean=False):
    c = Canvas(BASE_W, BASE_H)
    texts = []  # (文字列, インクの範囲) 検証用

    # --- 空(夕方の淡い光) ---
    top, hor = hexc('#BFD4DA'), hexc('#F3E3C6')
    for y in range(0, 1500, 6):
        c.rect(0, y, BASE_W, y + 6, lerp(top, hor, min(1, y / 1250) ** 1.2))
    for (cx, cy, w, h) in [(560, 260, 700, 120), (900, 330, 480, 90), (3300, 200, 800, 130), (3700, 310, 520, 90), (2050, 430, 560, 80)]:
        if clean and 1300 < cx < 2900:
            continue  # テスト印刷の下絵は、折り目の上の空を空けておく
        c.rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, '#F7F1E2', r=h / 2)
    # 遠い山と、遠くの屋根
    c.poly([(1300, 1500), (1700, 1180), (2000, 1260), (2250, 1130), (2650, 1330), (2900, 1500)], '#A9BDB5')
    c.poly([(1500, 1520), (1850, 1330), (2250, 1400), (2500, 1300), (2800, 1520)], '#98AEA8')

    # --- 地面 ---
    c.rect(0, 1500, BASE_W, BASE_H, '#CDBB9C')
    c.poly([(1940, 1500), (2270, 1500), (2900, BASE_H), (1300, BASE_H)], '#E3D5B8')
    for t in (0.18, 0.4, 0.62, 0.82):
        y = 1500 + (BASE_H - 1500) * t * t * 1.1 + 40
        half = 165 + (y - 1500) * 0.53
        c.line([(2100 - half, y), (2100 + half, y)], '#D0BF9F', 5)
    # 路面の左右の縁石
    c.poly([(1300, BASE_H), (1940, 1500), (1962, 1500), (1360, BASE_H)], '#BDAA8A')
    c.poly([(2900, BASE_H), (2270, 1500), (2248, 1500), (2840, BASE_H)], '#BDAA8A')

    # --- 遠くの店(中央の通りの奥) ---
    # 左奥
    c.rect(1690, 1090, 1930, 1760, '#C9B79A')
    c.rect(1690, 1060, 1930, 1105, '#4E5963')
    c.rect(1720, 1210, 1900, 1280, '#9AB0B8')
    c.rect(1720, 1520, 1900, 1760, '#D8B567')
    c.rect(1700, 1450, 1920, 1520, '#B5533C')
    c.rect(1930, 1250, 2020, 1740, '#B9C7C4')
    c.rect(1930, 1226, 2020, 1262, '#56626B')
    # 右奥
    c.rect(2270, 1130, 2510, 1740, '#B7C6B3')
    c.rect(2270, 1100, 2510, 1146, '#4E5963')
    c.rect(2300, 1240, 2480, 1310, '#9AB0B8')
    c.rect(2300, 1500, 2480, 1740, '#E0C8A6')
    c.rect(2280, 1430, 2500, 1500, '#5E8A94')
    c.rect(2180, 1290, 2270, 1730, '#C8B8A2')
    c.rect(2180, 1266, 2270, 1302, '#56626B')
    # 街灯
    for lx in (1860, 2380):
        c.rect(lx - 7, 1380, lx + 7, 1950, '#46505A')
        c.ell(lx - 34, 1330, lx + 34, 1396, '#F1D58E')
        c.rect(lx - 40, 1318, lx + 40, 1336, '#46505A')

    # --- 通りをわたる、ちょうちんと旗 ---
    pts = []
    for i in range(0, 41 if not clean else 0):
        t = i / 40
        x = 1660 + (2620 - 1660) * t
        y = 640 + 190 * math.sin(math.pi * t) * 0.9 + 0
        pts.append((x, y))
    if pts:
        c.line(pts, '#3E3E3E', 6)
    flag_cols = ['#C47A58', '#E3C171', '#6D9488', '#D8D0BC', '#4C6481', '#B5533C']
    for i in range(1, 12 if not clean else 1):
        t = i / 12
        x = 1660 + (2620 - 1660) * t
        y = 640 + 190 * math.sin(math.pi * t) * 0.9
        col = flag_cols[i % len(flag_cols)]
        c.poly([(x - 36, y), (x + 36, y), (x, y + 88)], col)

    # --- 左奥の青果店(切れている)  x 0..700 ---
    roof(c, -20, 740, 700, 840, '#5D6770', '#46505A')
    c.rect(-20, 840, 740, 2150, '#9DB39A')
    window(c, 80, 930, 330, 1180, '#EADFC6', '#9CB4BE')
    window(c, 410, 930, 660, 1180, '#EADFC6', '#9CB4BE')
    c.rect(-20, 1260, 740, 1350, '#5A7E6D')
    striped_awning(c, -20, 740, 1350, 1560, '#4E7F6B', '#EFE7D2', 9)
    c.rect(-20, 1600, 740, 2150, '#40443F')
    # 台の上の木箱と果物
    c.rect(20, 1840, 700, 2150, '#B98A58')
    for k in range(4):
        c.rect(40 + k * 165, 1780, 40 + k * 165 + 150, 1850, '#9E7344')
        for j in range(5):
            col = ['#C9503C', '#E0A038', '#7FA24F', '#D0653C', '#E6C24A'][(k + j) % 5]
            c.ell(52 + k * 165 + j * 27, 1738 + (j % 2) * 10, 52 + k * 165 + j * 27 + 50, 1738 + (j % 2) * 10 + 50, col)

    # --- 左の主役: 喫茶店 x 740..1620 ---
    roof(c, 700, 1660, 640, 790, '#566067', '#3F4952')
    c.rect(720, 790, 1640, 2150, '#DEC38C')
    window(c, 790, 860, 1010, 1100, '#F2E8CF', '#A5BCC4')
    window(c, 1350, 860, 1570, 1100, '#F2E8CF', '#A5BCC4')
    c.rect(1060, 880, 1300, 1120, NAVY)  # 小さな張り出し看板(絵柄だけ)
    c.rect(1080, 900, 1280, 1100, '#E9DFC5')
    c.ell(1130, 940, 1230, 1040, '#B8855C')  # コーヒーカップの輪
    c.ell(1150, 960, 1210, 1020, '#E9DFC5')
    # 看板
    c.rect(760, 1170, 1600, 1400, NAVY)
    c.rect(780, 1190, 1580, 1380, None, outline='#C9B889', width=6)
    striped_awning(c, 740, 1620, 1420, 1590, '#C47A58', '#F3EBD6', 11)
    # 店のガラスと扉
    c.rect(770, 1660, 1610, 2150, '#4A3E33')
    c.rect(800, 1690, 1210, 2090, '#F0CF86')
    c.rect(800, 1690, 1210, 1790, '#F5DFA6')
    for i in range(3):
        c.ell(850 + i * 120, 1930, 930 + i * 120, 2010, '#F6EFDC')  # テーブルの上の器
        c.rect(868 + i * 120, 1990, 912 + i * 120, 2090, '#6B5238')
    c.rect(1250, 1690, 1480, 2150, '#7B4F37')
    c.rect(1272, 1712, 1458, 1960, '#F0CF86')
    c.ell(1420, 1960, 1448, 1988, '#E3C171')
    c.rect(1500, 1700, 1590, 2090, '#F0CF86')
    lantern(c, 1530, 1520, 1.0)
    potted_plant(c, 780, 2150, 1.05, '#5E8A66')
    potted_plant(c, 1600, 2150, 1.0, '#6C9A70')
    c.rect(740, 2150, 1640, 2170, '#8C7A5E')

    # --- 右の主役: 古本屋 x 2560..3560 ---
    roof(c, 2540, 3590, 660, 800, '#4C565E', '#39434B')
    c.rect(2560, 800, 3570, 2150, '#2C4A66')
    # 二階の窓と、つばめの印
    window(c, 2650, 880, 2870, 1110, '#E9DFC5', '#C9D6D8')
    window(c, 3260, 880, 3480, 1110, '#E9DFC5', '#C9D6D8')
    c.ell(2960, 880, 3170, 1090, '#E9DFC5')
    bird(c, 3065, 995, 1.3, '#2C4A66')
    # 看板(木地)
    c.rect(2590, 1170, 3540, 1400, '#E4D6B0')
    c.rect(2610, 1190, 3520, 1380, None, outline='#8C6D45', width=6)
    striped_awning(c, 2570, 3560, 1420, 1580, '#1E3A55', '#CFC3A2', 12)
    c.rect(2570, 1600, 3560, 2150, '#2A2622')
    # 店先の本棚(たくさんの背表紙)
    c.rect(2610, 1640, 3030, 2150, '#7A5638')
    for r, yb in enumerate((1780, 1930, 2080)):
        books_row(c, 2626, 3014, yb, 70, 118, 11 + r, blue_at=170 if r == 1 else None)
        c.rect(2610, yb, 3030, yb + 12, '#5C4029')
    # 扉とショーウインドー
    c.rect(3080, 1640, 3290, 2150, '#7B4F37')
    c.rect(3102, 1662, 3268, 1940, '#E8C77F')
    c.rect(3320, 1660, 3540, 2090, '#E8C77F')
    c.rect(3320, 2060, 3540, 2150, '#5C4029')
    books_row(c, 3334, 3526, 2060, 80, 140, 31)
    c.rect(3334, 1760, 3526, 1768, '#5C4029')
    books_row(c, 3334, 3526, 1768, 60, 100, 41)
    lantern(c, 3050, 1520, 0.9, '#C4682F')
    c.rect(2560, 2150, 3570, 2170, '#8C7A5E')
    # 立て看板(三角の台)
    c.poly([(2670, 2360), (3000, 2360), (2960, 1820), (2710, 1820)], '#C9B88C')
    c.poly([(2700, 2340), (2980, 2340), (2948, 1850), (2722, 1850)], '#EDE3C6')
    c.rect(2700, 2340, 2720, 2380, '#4A3E33')
    c.rect(2960, 2340, 2980, 2380, '#4A3E33')

    # --- 右はしの店(切れている) x 3620..4200 ---
    roof(c, 3620, 4260, 720, 860, '#5A646C', '#434D56')
    c.rect(3640, 860, 4260, 2150, '#C99478')
    window(c, 3730, 950, 3950, 1180, '#F0E6CE', '#A9BEC6')
    window(c, 4010, 950, 4230, 1180, '#F0E6CE', '#A9BEC6')
    striped_awning(c, 3640, 4260, 1330, 1520, '#D7C27A', '#F4EDD8', 8)
    c.rect(3660, 1560, 4260, 2150, '#4A3E36')
    c.rect(3700, 1590, 4220, 2000, '#EFCB7E')
    for i in range(5):
        c.ell(3740 + i * 100, 1830, 3820 + i * 100, 1910, '#C98B4A')  # パンの丸い形
        c.ell(3745 + i * 100, 1740, 3815 + i * 100, 1800, '#D8A15E')
    c.rect(3640, 2150, 4260, 2170, '#8C7A5E')

    # --- 手前の路面と人・もの ---
    c.rect(0, 2170, BASE_W, 2200, '#B5A283')
    # 自転車(左手前)
    for (bx, by) in ((1030, 2640), (1330, 2640)):
        c.ell(bx - 110, by - 110, bx + 110, by + 110, None, outline='#2B3139', width=12)
        c.ell(bx - 12, by - 12, bx + 12, by + 12, '#2B3139')
    c.line([(1030, 2640), (1170, 2480), (1330, 2640)], '#2B3139', 12)
    c.line([(1170, 2480), (1230, 2640)], '#2B3139', 12)
    c.line([(1170, 2480), (1150, 2430), (1090, 2420)], '#2B3139', 12)
    c.line([(1230, 2640), (1310, 2430), (1370, 2425)], '#2B3139', 12)
    c.rect(1128, 2402, 1210, 2420, '#2B3139')
    c.rect(1230, 2460, 1310, 2520, '#B5533C')  # かご
    # 通りの人(顔を描かない人影)。折り目から離して、左右に1人ずつ
    person(c, 1790, 2060, 1.45, '#6D8C8C')
    person(c, 2440, 2020, 1.35, '#B5533C', book='#1E4F8F')
    # 猫(右手前)
    cx, cy = 3290, 2640
    c.ell(cx - 130, cy - 110, cx + 130, cy + 120, '#D9A064')
    c.ell(cx - 70, cy - 190, cx + 70, cy - 60, '#D9A064')
    c.poly([(cx - 68, cy - 170), (cx - 40, cy - 235), (cx - 12, cy - 178)], '#D9A064')
    c.poly([(cx + 68, cy - 170), (cx + 40, cy - 235), (cx + 12, cy - 178)], '#D9A064')
    c.ell(cx - 38, cy - 150, cx - 22, cy - 130, '#2B2B2B')
    c.ell(cx + 22, cy - 150, cx + 38, cy - 130, '#2B2B2B')
    c.line([(cx + 120, cy + 90), (cx + 230, cy + 40), (cx + 260, cy - 60)], '#D9A064', 34)
    # 街路樹の鉢(右手前)
    potted_plant(c, 2800, 2780, 1.5, '#4F7C5C')
    potted_plant(c, 520, 2800, 1.4, '#5E8A66')

    # --- 文字(左右のページの版面の内側だけ) ---
    if draw_texts:
        f = serif(150, 800)
        texts.append(('喫茶みなと', c.text_ink(1180, 1285, '喫茶みなと', f, CREAM, 'mm')))
        f = serif(170, 800)
        texts.append(('古書 縹堂', c.text_ink(3065, 1285, '古書 縹堂', f, INK, 'mm')))
        f = serif(112, 800)
        texts.append(('均一', c.text_ink(2835, 1930, '均一', f, INK, 'mm')))
        texts.append(('百円', c.text_ink(2835, 2075, '百円', f, '#B5533C', 'mm')))
    return c, texts


# ---------------------------------------------------------------------------------------------
# 商店街の地図(3000x4200)。縦長。文字は余白を空けて、いっぱいまで使う
# ---------------------------------------------------------------------------------------------
def map_scene():
    W, H = 3000, 4200
    c = Canvas(W, H)
    paper = '#F2EAD6'
    c.rect(0, 0, W, H, paper)
    texts = []
    # 川(右から下へ)
    river = [(2500, 0), (2380, 700), (2560, 1300), (2420, 1900), (2640, 2500), (2500, 3200), (2620, 4200)]
    c.poly(river + [(3000, 4200), (3000, 0)], '#B6CFD3')
    c.line(river, '#8FB1B8', 14)
    # 線路と駅(下)
    c.rect(0, 3500, W, 3600, '#D7CDB8')
    c.line([(0, 3550), (W, 3550)], '#7A7468', 10)
    for x in range(40, W, 90):
        c.line([(x, 3515), (x, 3585)], '#7A7468', 8)
    c.rect(300, 3620, 900, 3860, '#C7855F', r=24)
    c.rect(340, 3660, 860, 3820, '#F2EAD6', r=16)
    # 街区(やさしい色の四角)
    blocks = [
        (200, 300, 900, 900, '#DCE3C8'), (1000, 300, 1500, 900, '#E9D9B5'), (200, 1000, 900, 1700, '#E6CFC0'),
        (1000, 1000, 1500, 1700, '#D9E1DF'), (200, 1800, 900, 2500, '#E9D9B5'), (1000, 1800, 1500, 2500, '#DCE3C8'),
        (200, 2600, 900, 3300, '#D9E1DF'), (1000, 2600, 1500, 3300, '#E6CFC0'), (1600, 300, 2200, 1000, '#CFDDBF'),
        (1600, 1100, 2200, 1700, '#E9D9B5'), (1600, 1800, 2200, 2500, '#D9E1DF'), (1600, 2600, 2200, 3300, '#E6CFC0'),
    ]
    for (x0, y0, x1, y1, col) in blocks:
        c.rect(x0, y0, x1, y1, col, r=36)
    # 商店街(まんなかの太い道。点線の中心線)
    c.rect(930, 0, 1000, 3500, '#E9DFC4')
    c.rect(1500, 300, 1600, 3300, '#EADFC4')
    c.rect(0, 925, 3000, 985, '#E9DFC4')
    c.rect(0, 2525, 3000, 2585, '#E9DFC4')
    street = [(1250, 3500), (1250, 3300), (1250, 960), (1250, 0)]
    c.rect(1180, 0, 1320, 3500, '#E4B58A')
    for y in range(40, 3500, 120):
        c.rect(1245, y, 1255, y + 60, '#F6EFDC')
    c.rect(1180, 0, 1186, 3500, '#B98A5E')
    c.rect(1314, 0, 1320, 3500, '#B98A5E')
    # 店のしるし(色の四角)と文字。箱は文字の幅に合わせて決める
    f_lab = serif(120, 800)
    f_small = serif(96, 700)
    def tw(label, f):
        bb = c.d.textbbox((0, 0), label, font=f)
        return (bb[2] - bb[0]) / SS
    def shop(x, cy, label, col, f=f_lab, fill=INK, anchor='left', pad=46, h=190, ol='#7C6A4E'):
        w = tw(label, f) + pad * 2
        x0 = x if anchor == 'left' else x - w / 2
        c.rect(x0, cy - h / 2, x0 + w, cy + h / 2, col, outline=ol, width=8, r=20)
        texts.append((label, c.text_ink(x0 + w / 2, cy, label, f, fill, 'mm')))
        return x0, x0 + w
    shop(1350, 560, '喫茶みなと', '#E3C171')
    shop(1350, 1290, '八百屋ささき', '#D8B6A2')
    shop(1350, 2300, 'とうふ店', '#B8CFC8')
    shop(600, 1330, '郵便局', '#C9D4E6', anchor='center')
    shop(580, 2150, 'ひがし書房', '#EBD8A8', anchor='center')
    # 古本屋(主役): 濃い藍と、つばめ
    shop(1350, 1920, '古書 縹堂', '#2C4A66', fill=CREAM, h=210, ol='#1E3A55')
    bird(c, 2230, 1740, 1.2, '#2C4A66')
    # 祖母の家
    c.poly([(330, 2880), (600, 2740), (870, 2880)], '#B5533C')
    c.rect(380, 2880, 820, 3180, '#EFDCC0', outline='#7C6A4E', width=8)
    c.rect(560, 3020, 640, 3180, '#7B4F37')
    texts.append(('祖母の家', c.text_ink(600, 3290, '祖母の家', f_lab, INK, 'mm')))
    # 公園(左上の緑の街区)と神社
    c.ell(430, 440, 670, 680, '#A9C9A2')
    c.ell(500, 510, 600, 610, '#7FA97E')
    texts.append(('はなみ公園', c.text_ink(550, 790, 'はなみ公園', f_small, INK, 'mm')))
    c.rect(1700, 2700, 2100, 3000, '#CFC3A2', r=16)
    c.rect(1840, 2740, 1960, 2760, '#B5533C')
    c.rect(1850, 2760, 1950, 2780, '#B5533C')
    c.rect(1860, 2780, 1880, 2960, '#B5533C')
    c.rect(1920, 2780, 1940, 2960, '#B5533C')
    texts.append(('もり神社', c.text_ink(1900, 3090, 'もり神社', f_small, INK, 'mm')))
    # 駅
    texts.append(('ひがし駅', c.text_ink(600, 3740, 'ひがし駅', serif(130, 800), INK, 'mm')))
    # 川の名前
    texts.append(('ゆめ川', c.text_ink(2690, 1100, 'ゆめ川', f_small, '#2E5A66', 'mm')))
    # 歩いた道(破線の道のり): 駅 → 商店街 → 古本屋
    route = [(600, 3615), (600, 3400), (1250, 3400), (1250, 1960), (1345, 1960)]
    for (a, b) in zip(route, route[1:]):
        n = max(1, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / 70))
        for i in range(n):
            t0, t1 = i / n, (i + 0.55) / n
            c.line([(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0), (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)], '#B5533C', 16)
    c.ell(1332, 1948, 1362, 1978, '#B5533C')
    # 題名と凡例(余白を空けて、いっぱいまで)
    c.rect(200, 90, 200 + tw('商店街の地図', serif(125, 800)) + 90, 270, '#23394F', r=24)
    texts.append(('商店街の地図', c.text_ink(200 + (tw('商店街の地図', serif(125, 800)) + 90) / 2, 180, '商店街の地図', serif(125, 800), CREAM, 'mm')))
    texts.append(('つばめ商店街', c.text_ink(1760, 180, 'つばめ商店街', f_small, '#7A3E24', 'mm')))
    c.line([(980, 3980), (1090, 3980)], '#B5533C', 16)
    texts.append(('歩いて十五分', c.text_ink(1140, 3980, '歩いて十五分', f_small, '#B5533C', 'lm')))
    # 方位
    c.poly([(2760, 3880), (2820, 3980), (2700, 3980)], '#23394F')
    c.poly([(2760, 4080), (2820, 3980), (2700, 3980)], '#C9B889')
    texts.append(('北', c.text_ink(2760, 3770, '北', serif(110, 800), INK, 'mm')))
    return c, texts


if __name__ == '__main__':
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'sample')
    os.makedirs(root, exist_ok=True)
    png_dir = sys.argv[1] if len(sys.argv) > 1 else None
    for name, build, seed, dest in (
        ('street_spread', lambda: street_scene(True)[0], 7, 'street-spread.jpg'),
        ('map', lambda: map_scene()[0], 11, 'map-print.jpg'),
    ):
        im = build().finish(seed=seed).convert('RGB')
        im.save(os.path.join(root, dest), quality=84, optimize=True, progressive=True, subsampling=1)
        if png_dir:
            os.makedirs(png_dir, exist_ok=True)
            im.save(os.path.join(png_dir, name + '.png'))
        print(dest, im.size)
