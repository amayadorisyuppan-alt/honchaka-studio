# -*- coding: utf-8 -*-
"""縦組みの本で、書名・著者名だけを横組みにした大扉(titleWritingMode='horizontal')を、紙(PDF)で測る。

## なぜ在るか(2026-10-03)

縦組みのページに横組みの器を置くと、幅が版面幅にならず細くなる(奥付で実測済み。src/typeset/css.ts の
section.colophon)。大扉でも同じことが起きうるので、**本物の組版器(Vivliostyle)で**測る。
縦のままの本が1字も変わっていないことは、この検査ではなく scripts/layout-matrix.ts の前後の diff で見る。

## 何を測るか(縦組みの本・大扉のページ)

1. 書名の字が**横に並んでいる**(字の並びの幅が高さより大きい。長い書名は折れてもよい)
2. 書名が**仕上がりの左右の中央**にある(四辺に塗り足しを付けた決まりの本。KDP はノド側に塗り足しが無いので、
   紙の中央=仕上がりの中央から塗り足しの半分ずれる。それは見るだけ)
3. 著者名が**横に並び・左右の中央・ページの下寄り**にある
4. 書名が**天から5行ぶん**下がった所にある(縦用の既定がそのまま使える)
5. 長い書名(38字)が、ノド側の下限(既定の決まり 15mm)を割らず、版面の中で折れる

## 使い方

    python scripts/check-title-horizontal.py            # KDP と既定の決まり(15mm)で3本組む
    python scripts/check-title-horizontal.py --keep
    python scripts/check-title-horizontal.py --chrome "C:\\path\\to\\chrome.exe"

終了コードは 0=全部通った / 1=どれか落ちた。PyMuPDF と Chrome が要る(check-bleed.py と同じ)。
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location('check_bleed', ROOT / 'scripts' / 'check-bleed.py')
_cb = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(_cb)

TRIM_W, TRIM_H = _cb.TRIM_W, _cb.TRIM_H
CENTER_TOL = _cb.CENTER_TOL
GUTTER_TOL = _cb.GUTTER_TOL
CFGS = {c[0]: c for c in _cb.CONFIGS}

# 文庫・既定の本の行送り(pt)。書名は天から5行ぶん下がる(css.ts の .titlepage h1 の padding-top)
AUTHOR_NAME = '雨宿'


def spans(boxes):
    return (min(b[0] for b in boxes), max(b[2] for b in boxes), min(b[1] for b in boxes), max(b[3] for b in boxes))


def measure(book, label: str, expect_center: bool, floor: float | None, long_title: bool) -> list[str]:
    fails: list[str] = []
    ti = book.title_page()
    if ti is None:
        return [f'{label}: 大扉(書名「{_cb.TITLE}」のページ)が見つからない']
    cs = book.chars_trim(ti)
    size = max(max(b[2] - b[0], b[3] - b[1]) for _, b in cs)
    title = [b for _, b in cs if max(b[2] - b[0], b[3] - b[1]) >= size * 0.95]
    author = [b for c, b in cs if max(b[2] - b[0], b[3] - b[1]) < size * 0.95]
    if not author:
        return [f'{label}: 著者名の字が見つからない']

    # 1. 書名が横に並んでいる
    x0, x1, y0, y1 = spans(title)
    horizontal = (x1 - x0) > (y1 - y0) * 1.5
    if not horizontal:
        fails.append(f'{label}: 書名が横に並んでいない(幅 {x1 - x0:.1f}mm・高さ {y1 - y0:.1f}mm)')
    # 2. 左右の中央
    cx = (x0 + x1) / 2
    off = cx - TRIM_W / 2
    centered = abs(off) <= CENTER_TOL
    if expect_center and not centered:
        fails.append(f'{label}: 書名が仕上がりの中央から {off:+.2f}mm ずれている(p.{ti + 1})')
    print(f'  書名 幅 {x1 - x0:.1f}mm × 高さ {y1 - y0:.1f}mm・中心は仕上がりの中央から {off:+.2f}mm'
          f'{"" if not expect_center else ("  ok" if centered else "  NG")}{"" if horizontal else "  NG(横でない)"}')

    # 3. 著者名
    ax0, ax1, ay0, ay1 = spans(author)
    a_h = (ax1 - ax0) > (ay1 - ay0) * 1.5
    a_off = (ax0 + ax1) / 2 - TRIM_W / 2
    a_low = ay0 > TRIM_H * 0.6
    a_ok = a_h and a_low and (abs(a_off) <= CENTER_TOL or not expect_center)
    if not a_h:
        fails.append(f'{label}: 著者名が横に並んでいない')
    if not a_low:
        fails.append(f'{label}: 著者名が下寄りにない(上端 {ay0:.1f}mm / 仕上がり高 {TRIM_H}mm)')
    if expect_center and abs(a_off) > CENTER_TOL:
        fails.append(f'{label}: 著者名が仕上がりの中央から {a_off:+.2f}mm ずれている')
    print(f'  著者名 中心は中央から {a_off:+.2f}mm・上端 {ay0:.1f}mm(仕上がり高 {TRIM_H}mm の下寄り)'
          f'{"  ok" if a_ok else "  NG"}')

    # 4. 書名の上端(天から5行ぶん=5×行送り。文庫の既定の行送りは 12.5pt 前後なので、版面の天から 20〜40mm)
    if not long_title:
        top = y0
        ok4 = 15 <= top <= 60
        if not ok4:
            fails.append(f'{label}: 書名の上端が仕上がりの天から {top:.1f}mm(想定 15〜60mm)')
        print(f'  書名の上端 天から {top:.1f}mm{"  ok" if ok4 else "  NG"}')

    # 5. 長い書名: ノド側の下限と、左右対称
    if long_title:
        left = _cb.gutter_on_left(ti, book.vertical)
        ax0_, ax1_, _, _ = spans([b for _, b in cs])
        gutter_side = ax0_ if left else TRIM_W - ax1_
        fore_side = TRIM_W - ax1_ if left else ax0_
        ok5 = True
        if floor is not None and gutter_side < floor - GUTTER_TOL:
            ok5 = False
            fails.append(f'{label}: 長い書名で、ノド側の余白が {gutter_side:.2f}mm。下限 {floor}mm に届かない')
        rows = len({round(b[1] / (size * 0.6)) for b in title})
        if rows < 2:
            ok5 = False
            fails.append(f'{label}: 長い書名が折れていない(行数 {rows})')
        print(f'  長い書名 {rows} 行・ノド側 {gutter_side:.2f}mm / 小口側 {fore_side:.2f}mm'
              f'{"" if floor is None else f"(下限 {floor}mm)"}{"  ok" if ok5 else "  NG"}')
    return fails


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser(description='縦組みの本の、横組みの大扉を測る')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--chrome')
    a = ap.parse_args()
    chrome = _cb._ct.find_chrome(a.chrome)
    if not chrome:
        print('※ Chrome が見つかりません。--chrome で渡してください', file=sys.stderr)
    bundle = _cb.build_bundle()
    work = Path(tempfile.mkdtemp(prefix='title-h-check-'))
    fails: list[str] = []
    os.environ['TITLE_WM'] = 'h'
    try:
        plan = [
            ('kdp', None, False, '縦組み・kdp(ノド側の塗り足し無し=中央は見るだけ)'),
            ('default', None, False, '縦組み・既定の決まり(四辺 3mm)'),
            ('default', _cb.LONG_TITLE, True, '縦組み・既定の決まり・長い書名'),
        ]
        for n, (name, title, long_title, label) in enumerate(plan):
            cfg = CFGS[name]
            print(f'\n[{label}]')
            sub = work / f'p{n}'
            sub.mkdir()
            pdf = _cb.build_pdf(bundle, sub, True, chrome, cfg, title=title)
            book = _cb.Book(pdf, True, cfg[4])
            expect_center = (cfg[4][2] == cfg[4][3]) and name != 'kdp'
            fails += measure(book, label, expect_center, cfg[5], long_title)
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
