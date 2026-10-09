# -*- coding: utf-8 -*-
"""印刷所の決まり(塗り足し・ノドの下限)で組んだ紙(PDF)を機械で測る。

## なぜ在るか

2026-10-01 に、塗り足しとノドの下限を出し先ごとに決められるようにした
(KDP は塗り足し 3.2mm でノド側なし。「その他の印刷所」は利用者が入れた数字)。
それまでの検査(check-typeset.py)は KDP の既定の本しか組まず、位置は**版面を基準に**測るので、
塗り足しの変更には鈍感だった。**用紙の寸法も、仕上がりから見た版面の位置も、測っていなかった。**
ここで足すのは、塗り足しを変えても本が動いていないことと、決まりどおりの紙になっていることの検査。

CSS の `bleed` プロパティは Vivliostyle で効かないので、組版は「用紙(size)を広げて余白を足す」方式
(src/typeset/css.ts の冒頭)。ノド側にも足すと、ノド・小口の入れ替わり(:recto/:verso)と
版面の幅の式が絡む。**どこか1つ式を取り違えると、版面が塗り足しのぶんだけずれる**ので、字の位置で測る。

## 何を測るか

どれも「仕上がり(断裁後)の左上」を原点にした mm で見る。用紙のどこが仕上がりかは、
その本の塗り足し(天・地・小口・ノド)と、ページの奇偶(ノドが左右どちらか)から出す。

1. **用紙の寸法** … 全ページが 仕上がり + 塗り足し(幅は 小口 + ノド、高さは 天 + 地)。
2. **版面の位置が動いていない** … 塗り足しだけを変えた本(ノドの下限は KDP と同じになる設定)は、
   KDP の本と**全ページ・全文字の位置が同じ**(仕上がり基準。用紙の中ではずれる)。
   本文の字・ノンブル・柱がまとめて入る。左右のページ・縦組み・横組みの全部で。
   大扉は用紙の中央に置くので、ノド側の塗り足しが小口側と違うと仕上がりの中央からずれる(KDP は 1.6mm)。
   そのため大扉だけ別に測る(4.)。
3. **ノドの下限** … 既定の決まり(15mm・200ページ超は 20mm)で、どのページも、ノド側の仕上がりの端から
   本文の字までが下限以上(横組みの行末のぶら下がりは、組版が1字ぶん足して見てある)。
4. **大扉の書名が、仕上がりの左右の中央にある**(四辺に付けた決まりのとき)。
4b. **大扉の字が、ノド側の下限を割らない** … 書名を 38 字に長くした本で測る(LONG_TITLE)。
   大扉は左右対称の余白で、決まりが入っている本は max(小口側, ノド側) にそろえてある(css.ts の titleM)。
   そろえる前は、横組みで書名が長いと、1ページ目(右ページ)の字が仕上がりの左端から 13.5mm で、
   既定の下限 15mm を割った(2026-10-01 実測。KDP は下限 9.6mm が小口の余白とほぼ同じなので出ない)。
   あわせて、四辺に付けた決まりでは書名の字の左右が仕上がりの中央に対して対称であること、
   KDP の本は余白が変わっていないこと(小口側と同じ・ノドの下限は求めない)を見る。
5. **全面の絵が用紙いっぱい** … 赤い絵を全面ページに敷き、絵の端から用紙の四辺までの隙間を画素で測る
   (白黒の本では絵はグレーに刷られる)。塗り足しのぶんまで絵が届いていないと、断裁のずれで白いフチが出る。
   隙間は Chrome の用紙の丸めぶん(0.25〜0.5mm。KDP の本も同じ)まで許す。

## 使い方

    python scripts/check-bleed.py            # 縦組み・横組みの両方(22本組む。数分)
    python scripts/check-bleed.py --quick    # 縦組みだけ(11本)
    python scripts/check-bleed.py --keep     # 中間ファイル(HTML/PDF)を残す
    python scripts/check-bleed.py --chrome "C:\\path\\to\\chrome.exe"

終了コードは 0=全部通った / 1=どれか落ちた。

組版HTMLは scripts/render-check.ts(環境変数 PRINT_TARGET・RULES・EST・SOLID で決まりを渡す)。
PDF 化は check-typeset.py と同じ手順(Vivliostyle CLI。作業フォルダは一時フォルダ)。
PyMuPDF(`pip install pymupdf`)が要る。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    sys.exit('PyMuPDF が要ります: pip install pymupdf')

ROOT = Path(__file__).resolve().parent.parent
PT2MM = 25.4 / 72

# check-typeset.py の道具(Chrome の在り処・外部コマンド)を借りる。ファイル名にハイフンがあるので import できない
_spec = importlib.util.spec_from_file_location('check_typeset', ROOT / 'scripts' / 'check-typeset.py')
_ct = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(_ct)

# 検査用の本(scripts/check-doc.ts)は文庫(105×148)。大扉の書名はサンプル原稿(src/sample.ts)のもの
TRIM_W, TRIM_H = 105.0, 148.0
TITLE = '青い背表紙'
# 大扉の左右の余白を測る長い書名(38字)。横組みで3行に折れ、ノド側の字が余白いっぱいまで来る。
# title_page() は TITLE を含むページを探すので、先頭に TITLE を置く
LONG_TITLE = TITLE + '、あるいは祖母の家の本棚に最後まで残っていた古い一冊のこと、そして'

# PDF の用紙寸法の許容(mm)。Chrome は用紙を px に丸めて PDF にする(1px = 0.26mm)ので、丸めぶんは許す。
# 塗り足しの幅の違い(0.2mm〜3mm)を見分けるには、丸めより細かくないといけない
SIZE_TOL = 0.15
# 字の位置を KDP の本と比べる許容(mm)。同じ組版を用紙だけ動かしているので、丸めぶん(1px 以下)で足りる
POS_TOL = 0.1
# ノドの下限の許容(mm)。字の箱の丸めぶん
GUTTER_TOL = 0.05
# 大扉の書名が中央にある許容(mm)
CENTER_TOL = 0.3

KDP_BLEED = (3.2, 3.2, 3.2, 0.0)  # 天・地・小口・ノド
RULES_DEFAULT = dict(bleedMm=3, bleedGutter=True, gutterMinMm=15, thickPages=200, thickGutterMm=20)


def rules(**kw):
    """塗り足しだけを変えたい本は、ノドの下限と段階を外す(ノドは KDP と同じ=余白の既定が効く)"""
    base = dict(bleedMm=3, bleedGutter=True, gutterMinMm=0, thickPages=None, thickGutterMm=None)
    base.update(kw)
    return base


# (名前, 出し先, 決まり, 推定ページ数, 塗り足し(天,地,小口,ノド), ノドの下限 or None)
CONFIGS = [
    ('kdp', 'kdp', None, None, KDP_BLEED, None),
    ('bleed0', 'printshop', rules(bleedMm=0), None, (0, 0, 0, 0), None),
    ('bleed3', 'printshop', rules(), None, (3, 3, 3, 3), None),
    ('bleed5', 'printshop', rules(bleedMm=5), None, (5, 5, 5, 5), None),
    ('nogutter3', 'printshop', rules(bleedGutter=False), None, (3, 3, 3, 0), None),
    ('default', 'printshop', RULES_DEFAULT, None, (3, 3, 3, 3), 15.0),
    ('default201', 'printshop', RULES_DEFAULT, 201, (3, 3, 3, 3), 20.0),
]


def build_bundle() -> Path:
    """組版器を node から呼べる形にまとめる。出力先は check-typeset.py の dist/check とは別にする"""
    out = ROOT / 'dist' / 'check-bleed'
    _ct.run(['npx', 'vite', 'build', '--ssr', 'scripts/render-check.ts',
             '--outDir', 'dist/check-bleed', '--logLevel', 'warn'], cwd=ROOT)
    return out / 'render-check.js'


def build_pdf(bundle: Path, work: Path, vertical: bool, chrome: str | None, cfg, title: str | None = None) -> Path:
    name, target, rl, est, _, _ = cfg
    tag = f'{name}-title' if title else name
    html = work / f'{tag}.html'
    pdf = work / f'{tag}.pdf'
    env = dict(os.environ)
    env['WM'] = 'v' if vertical else 'h'
    env['DENSE'] = '0'
    env['SCENE'] = 'blank'
    env['SOLID'] = '1'
    env['PRINT_TARGET'] = target
    if rl is not None:
        env['RULES'] = json.dumps(rl)
    else:
        env.pop('RULES', None)
    if est is not None:
        env['EST'] = str(est)
    else:
        env.pop('EST', None)
    if title:
        env['TITLE'] = title
    else:
        env.pop('TITLE', None)
    p = subprocess.run(['node', str(bundle), str(html)], cwd=str(ROOT), capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=env, shell=(os.name == 'nt'))
    if p.returncode != 0:
        print(p.stdout, p.stderr)
        sys.exit(f'組版HTMLの書き出しに失敗しました({name})')
    cmd = ['npx', '--yes', '@vivliostyle/cli', 'build', html.name, '-o', pdf.name]
    if chrome:
        cmd += ['--executable-browser', chrome]
    _ct.run(cmd, cwd=work)
    return pdf


def gutter_on_left(i: int, vertical: bool) -> bool:
    """i ページ目(0 始まり)のノドが、用紙の左側か。

    1ページ目は :recto。縦組み(右綴じ・rtl)の :recto は左ページ=ノドが右、
    横組み(ltr)の :recto は右ページ=ノドが左。そのあと交互に入れ替わる(css.ts の rectoLR / versoLR)"""
    recto = (i % 2 == 0)
    return (not recto) if vertical else recto


def page_chars(page):
    """ページの字を (文字, (x0,y0,x1,y1)) で、PDF に入っている順に返す。空白は捨てる"""
    out = []
    for blk in page.get_text('rawdict')['blocks']:
        for ln in blk.get('lines', []):
            for sp in ln['spans']:
                for ch in sp['chars']:
                    if ch['c'].strip() == '':
                        continue
                    out.append((ch['c'], tuple(ch['bbox'])))
    return out


class Book:
    """1冊ぶんの PDF を、仕上がり基準の mm で読む"""

    def __init__(self, pdf: Path, vertical: bool, bleed):
        self.doc = fitz.open(str(pdf))
        self.vertical = vertical
        self.top, self.bottom, self.fore, self.gutter = bleed
        self.n = len(self.doc)

    def paper_mm(self, i):
        r = self.doc[i].rect
        return r.width * PT2MM, r.height * PT2MM

    def trim_origin(self, i):
        """仕上がりの左上が、用紙のどこか(mm)"""
        left = gutter_on_left(i, self.vertical)
        return (self.gutter if left else self.fore), self.top

    def chars_trim(self, i):
        """字ごとの箱を、仕上がりの左上を原点にした mm で返す"""
        ox, oy = self.trim_origin(i)
        return [(c, ((b[0] * PT2MM) - ox, (b[1] * PT2MM) - oy, (b[2] * PT2MM) - ox, (b[3] * PT2MM) - oy))
                for c, b in page_chars(self.doc[i])]

    def title_page(self):
        for i in range(self.n):
            t = ''.join(c for c, _ in page_chars(self.doc[i]))
            if TITLE in t or TITLE[::-1] in t:
                return i
        return None


def check_paper(book: Book, label: str) -> list[str]:
    """1. 全ページの用紙が 仕上がり + 塗り足し"""
    fails = []
    ew = TRIM_W + book.fore + book.gutter
    eh = TRIM_H + book.top + book.bottom
    bad = []
    for i in range(book.n):
        w, h = book.paper_mm(i)
        if abs(w - ew) > SIZE_TOL or abs(h - eh) > SIZE_TOL:
            bad.append((i + 1, round(w, 2), round(h, 2)))
    if bad:
        fails.append(f'{label}: 用紙が {ew:.2f}×{eh:.2f}mm ではないページ {len(bad)}件 例 {bad[:3]}')
    w0, h0 = book.paper_mm(0)
    print(f'  用紙 {w0:.2f}×{h0:.2f}mm（期待 {ew:.2f}×{eh:.2f}）全 {book.n} ページ'
          f'{"  ok" if not bad else "  NG"}')
    return fails


def check_same_as_kdp(book: Book, kdp: Book, label: str, skip: set[int]) -> list[str]:
    """2. 仕上がりから見た字の位置が、KDP の本と同じ"""
    fails = []
    if book.n != kdp.n:
        return [f'{label}: ページ数が KDP の本と違う（{book.n} と {kdp.n}）。版面の幅が変わっている']
    worst = 0.0
    worst_at = None
    mism = []
    for i in range(book.n):
        if i in skip:
            continue
        a = book.chars_trim(i)
        b = kdp.chars_trim(i)
        if len(a) != len(b) or any(x[0] != y[0] for x, y in zip(a, b)):
            mism.append((i + 1, len(a), len(b)))
            continue
        for (c, ba), (_, bb) in zip(a, b):
            d = max(abs(p - q) for p, q in zip(ba, bb))
            if d > worst:
                worst, worst_at = d, (i + 1, c)
    if mism:
        fails.append(f'{label}: 字の並びが KDP の本と違うページ {mism[:5]}')
    elif worst > POS_TOL:
        fails.append(f'{label}: 仕上がり基準の字の位置が KDP の本から最大 {worst:.3f}mm ずれている'
                     f'（p.{worst_at[0]} 「{worst_at[1]}」）')
    print(f'  字の位置の KDP との差 最大 {worst:.3f}mm（{book.n - len(skip)} ページ・全文字。許容 {POS_TOL}mm）'
          f'{"  ok" if not mism and worst <= POS_TOL else "  NG"}')
    return fails


def check_gutter(book: Book, floor: float, label: str, skip: set[int]) -> list[str]:
    """3. ノド側の仕上がりの端から本文の字まで、下限以上"""
    fails = []
    worst = None
    worst_page = None
    for i in range(book.n):
        if i in skip:
            continue
        cs = book.chars_trim(i)
        if not cs:
            continue
        left = gutter_on_left(i, book.vertical)
        d = min((b[0] if left else TRIM_W - b[2]) for _, b in cs)
        if worst is None or d < worst:
            worst, worst_page = d, i + 1
    if worst is None:
        return [f'{label}: 字のあるページが無い']
    ok = worst >= floor - GUTTER_TOL
    if not ok:
        fails.append(f'{label}: ノド側の余白が最小 {worst:.2f}mm（p.{worst_page}）。下限 {floor}mm に届かない')
    print(f'  ノド側の端から字まで 最小 {worst:.2f}mm（p.{worst_page}。下限 {floor}mm）{"  ok" if ok else "  NG"}')
    return fails


def check_title_center(book: Book, label: str, expect_center: bool) -> list[str]:
    """4. 大扉の書名が、仕上がりの左右の中央に在る(四辺に付けた決まりのとき)"""
    fails = []
    ti = book.title_page()
    if ti is None:
        return [f'{label}: 大扉(書名「{TITLE}」のページ)が見つからない']
    # 書名は大扉でいちばん大きい字。同じ大きさの字を集める
    cs = book.chars_trim(ti)
    size = max(max(b[2] - b[0], b[3] - b[1]) for _, b in cs)
    big = [b for _, b in cs if max(b[2] - b[0], b[3] - b[1]) >= size * 0.95]
    cx = (min(b[0] for b in big) + max(b[2] for b in big)) / 2
    off = cx - TRIM_W / 2
    ok = abs(off) <= CENTER_TOL
    note = ''
    if expect_center:
        if not ok:
            fails.append(f'{label}: 大扉の書名が仕上がりの中央から {off:+.2f}mm ずれている（p.{ti + 1}）')
        note = '  ok' if ok else '  NG'
    else:
        note = f'  （ノド側に塗り足しが無いので、紙の中央に置くと仕上がりの中央からずれる。KDP も同じ）'
    print(f'  大扉(p.{ti + 1})の書名の中心 仕上がりの中央から {off:+.2f}mm{note}')
    return fails


def check_title_gutter(book: Book, floor: float | None, label: str, symmetric: bool) -> list[str]:
    """4b. 長い書名の大扉で、ノド側の仕上がりの端から字までが下限以上(floor が None の本=KDP は求めない)。
    symmetric のとき(四辺に付けた決まり)は、字の左右の端が仕上がりの中央に対して対称であることも見る"""
    fails = []
    ti = book.title_page()
    if ti is None:
        return [f'{label}: 長い書名の大扉が見つからない']
    cs = book.chars_trim(ti)
    left = gutter_on_left(ti, book.vertical)
    x0 = min(b[0] for _, b in cs)
    x1 = max(b[2] for _, b in cs)
    gutter_side = x0 if left else TRIM_W - x1
    fore_side = TRIM_W - x1 if left else x0
    msg = (f'  長い書名の大扉(p.{ti + 1}) ノド側 {gutter_side:.2f}mm / 小口側 {fore_side:.2f}mm'
           f'（仕上がりの端から字まで）')
    ok = True
    if floor is not None:
        if gutter_side < floor - GUTTER_TOL:
            ok = False
            fails.append(f'{label}: 長い書名の大扉で、ノド側の余白が {gutter_side:.2f}mm（p.{ti + 1}）。下限 {floor}mm に届かない')
        msg += f' 下限 {floor}mm'
    if symmetric:
        center = (x0 + x1) / 2 - TRIM_W / 2
        if abs(center) > CENTER_TOL:
            ok = False
            fails.append(f'{label}: 長い書名の大扉の字が仕上がりの中央から {center:+.2f}mm ずれている（p.{ti + 1}）')
        msg += f' 中央からのずれ {center:+.2f}mm'
    print(msg + ('  ok' if ok else '  NG'))
    return fails


def red(px) -> bool:
    """検査用の赤い絵の画素か。**検査用の本は白黒(ink=mono)なので、絵はグレーに落ちて刷られる**
    (赤 200,30,30 は輝度 66 前後のグレー)。カラーで組んだときの赤も通す"""
    if px[0] > 150 and px[1] < 90 and px[2] < 90:
        return True
    return 54 <= px[0] <= 80 and max(px[:3]) - min(px[:3]) <= 4


# 全面の絵の端に残ってよい隙間(mm)。Chrome は用紙を px に丸めて PDF にするので、
# 絵の端と用紙の端のあいだに 0.25〜0.5mm の白い線が残ることがある(2026-10-01 実測。
# KDP の本は右に 0.25mm、塗り足し 0 の本は右に 0.5mm。画素 1〜2 個ぶん)。
# 塗り足しのぶん(既定 3mm)まで届いていないなら、これを大きく超える
FULLBLEED_GAP_TOL = 0.6


def check_fullbleed(book: Book, label: str) -> list[str]:
    """5. 全面の絵が用紙いっぱい。赤い絵のページで、絵の端から用紙の端までの隙間が丸めぶん以下"""
    fails = []
    found = 0
    dpi = 100
    k = 25.4 / dpi  # 1画素 = mm
    for i in range(book.n):
        pm = book.doc[i].get_pixmap(dpi=dpi)
        w, h = pm.width, pm.height
        # 赤い全面の絵のページか(中央と内側の4点がすべて絵の色。本文ページや本物の絵のページは外れる)
        pts = [(w // 2, h // 2), (w // 4, h // 4), (3 * w // 4, h // 4), (w // 4, 3 * h // 4), (3 * w // 4, 3 * h // 4)]
        if not all(red(pm.pixel(x, y)) for x, y in pts):
            continue
        found += 1

        def gap(coords) -> float:
            """端から数えて、最初に絵の色が現れるまでの距離(mm)"""
            for n, (x, y) in enumerate(coords):
                if red(pm.pixel(x, y)):
                    return n * k
            return float('inf')

        gaps = {
            '左': gap([(x, h // 2) for x in range(w)]),
            '右': gap([(x, h // 2) for x in range(w - 1, -1, -1)]),
            '天': gap([(w // 2, y) for y in range(h)]),
            '地': gap([(w // 2, y) for y in range(h - 1, -1, -1)]),
        }
        bad = {d: round(g, 2) for d, g in gaps.items() if g > FULLBLEED_GAP_TOL}
        if bad:
            fails.append(f'{label}: 全面の絵(p.{i + 1})が用紙の端まで届いていない(隙間 mm): {bad}')
        print(f'  全面の絵 p.{i + 1}: 端の隙間 ' + ' '.join(f'{d}{g:.2f}' for d, g in gaps.items())
              + f'mm（許容 {FULLBLEED_GAP_TOL}mm）{"  ok" if not bad else "  NG"}')
    if found == 0:
        fails.append(f'{label}: 赤い全面の絵のページが見つからない(検査用の本が変わった?)')
    return fails


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser(description='印刷所の決まりで組んだ紙の、塗り足しとノドを測る')
    ap.add_argument('--quick', action='store_true', help='縦組みだけ')
    ap.add_argument('--keep', action='store_true', help='中間ファイルを残す')
    ap.add_argument('--chrome', help='Chrome の実行ファイル。省略すると既定の場所を探す')
    ap.add_argument('--only', help='この名前の決まりだけ(kdp は比べる相手として必ず組む)')
    a = ap.parse_args()

    chrome = _ct.find_chrome(a.chrome)
    if not chrome:
        print('※ Chrome が見つかりません。--chrome で渡してください', file=sys.stderr)
    bundle = build_bundle()
    work = Path(tempfile.mkdtemp(prefix='bleed-check-'))
    fails: list[str] = []
    try:
        for vertical in ([True] if a.quick else [True, False]):
            mode = '縦組み' if vertical else '横組み'
            books: dict[str, Book] = {}
            for cfg in CONFIGS:
                name = cfg[0]
                if a.only and name not in (a.only, 'kdp'):
                    continue
                # 縦横で同じ名前の PDF が上書きされないよう、フォルダを分ける
                sub = work / ('v' if vertical else 'h')
                sub.mkdir(exist_ok=True)
                print(f'\n[{mode}] {name}: 出し先={cfg[1]} 決まり={cfg[2]} 推定ページ数={cfg[3]}')
                pdf = build_pdf(bundle, sub, vertical, chrome, cfg)
                book = Book(pdf, vertical, cfg[4])
                books[name] = book
                label = f'{mode}・{name}'
                fails += check_paper(book, label)
                ti = book.title_page()
                skip = {ti} if ti is not None else set()
                if name != 'kdp':
                    # 塗り足しだけを変えた本(ノドの下限を外したもの)は KDP と同じ位置になる
                    if cfg[5] is None:
                        fails += check_same_as_kdp(book, books['kdp'], label, skip)
                if cfg[5] is not None:
                    fails += check_gutter(book, cfg[5], label, skip)
                if name != 'kdp':
                    fails += check_title_center(book, label, expect_center=(cfg[4][2] == cfg[4][3]))
                fails += check_fullbleed(book, label)
            # 大扉(4b)。書名を長くした本を、KDP と既定の決まり(15mm・201ページ想定は 20mm)で組む
            for cfg in CONFIGS:
                name = cfg[0]
                if name not in ('kdp', 'default', 'default201', 'nogutter3'):
                    continue
                if a.only and name not in (a.only, 'kdp'):
                    continue
                sub = work / ('v' if vertical else 'h')
                print(f'\n[{mode}] {name}・長い書名({len(LONG_TITLE)}字): 大扉')
                pdf = build_pdf(bundle, sub, vertical, chrome, cfg, title=LONG_TITLE)
                book = Book(pdf, vertical, cfg[4])
                label = f'{mode}・{name}・長い書名'
                floor = cfg[5]
                if name == 'nogutter3':
                    # ノド側に塗り足しを付けない決まり。下限は入れていない(gutterMinMm=0)ので求めない
                    floor = None
                fails += check_title_gutter(book, floor, label, symmetric=(cfg[4][2] == cfg[4][3] and name != 'kdp' and not vertical))
    finally:
        if a.keep:
            print(f'中間ファイルは {work} に残しました')
        else:
            shutil.rmtree(work, ignore_errors=True)

    if fails:
        print('\n落ちた検査:')
        for f in fails:
            print('  NG ' + f)
        return 1
    print('\n通りました')
    return 0


if __name__ == '__main__':
    sys.exit(main())
