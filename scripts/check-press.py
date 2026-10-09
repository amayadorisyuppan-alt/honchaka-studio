# -*- coding: utf-8 -*-
"""入稿データ(変換後の PDF)を、スタジオのコードとは**別の道具**で調べる検査。

## なぜ在るか

入稿用の変換(src/press)は、PDF を Ghostscript に通し、pdf-lib で X-4 の形に整える。
その出来を、**同じコードで確かめては同じ間違いを2度する**。9/27 の試作でも、
Ghostscript が黙って画像を JPEG に圧縮し直す・グループの色空間が RGB のまま残る・
インクが 360% に届く、といった事は「出力を別の目で見る」ことで初めて見つかった。
だからこの検査は src/press を**読まない・使わない**。PDF 1 冊そのものを、
PyMuPDF(描画・文字・画素)と pypdf(オブジェクトの総なめ)で調べる。

## 使い方

    python scripts/check-press.py --kind body-cmyk --orig <変換前.pdf> --out <変換後.pdf> \\
        --trim 148x210 --bleed 3.2,3.2,3.2,0 --first-gutter right --ink-limit 300 \\
        --icc src/press/JapanColor2011Coated.icc
    python scripts/check-press.py --kind body-gray --orig … --out … --trim 105x148 \\
        --bleed 3.2,3.2,3.2,0 --first-gutter right --icc …
    python scripts/check-press.py --kind cover-cmyk --orig … --out … \\
        --trim <塗り足しを除いた展開の幅>x<高さ> --bleed 3.2,3.2,3.2,3.2 --ink-limit 300 --icc …

    --bleed は 天,地,小口,ノド(mm)。表紙は四辺。--trim は仕上がり(塗り足しを除く)の 幅x高さ(mm)
    --json <path>        結果を JSON でも書き出す
    --only <項目,…>      項目を絞る(content rgb ink konly pdfx boxes images。1〜7 の番号でもよい)
    --quiet              通った項目の中身を省く

終了コードは 0=全部通った / 1=どれか落ちた / 2=検査の道具が信用できない(下の「罠」)。

## 調べる項目(1項目ずつ「通った/落ちた」と、落ちたときは場所と数字)

1. content … 中身が減っていない。ページ数・72dpi の絵の差・抽出した文字(空白と改行を除く)
2. rgb     … RGB が残っていない。xref を **1番から最後まで総なめ**(たどれる所だけでは見落とす)
3. ink     … インクの量(cmyk の kind)。各ページの C+M+Y+K の最大。描いた絵と、命令・画素の直読みの突き合わせ
4. konly   … K だけのページ。body-gray は全ページ、body-cmyk は「変換前に色の無いページ」
5. pdfx    … PDF/X-4 の形(OutputIntent・XMP・Info・箱・版・暗号・注釈・フォント・フィルタ …)
6. boxes   … 箱の寸法。MediaBox=仕上がり+塗り足し、TrimBox の位置(ノドは1ページ目が --first-gutter の側、以後交互)、
             絵の中身が箱からずれていない
7. images  … 画像が劣化していない。JPEG(DCTDecode)が無い、画素数が変換前と同じ

## 罠(2026-10-01 に実測した。ここを踏むと「K だけの黒が4色」に見える)

### PyMuPDF は ICC を効かせたまま描くと、K だけの黒を4色にする

`0 0 0 1 k`(K だけ)の四角を csCMYK の画素に描いて読むと:

    PDF に OutputIntent(CMYK の ICC)が無い    →  C=0 M=0 Y=0 K=255   (そのまま)
    PDF に OutputIntent(Japan Color)が在る    →  C=161 M=171 B=188 K=209(= 729/255 = 286%)

MuPDF は PDF の OutputIntent を DeviceCMYK の既定の色空間に採るので、出力の ICC を通って
**K だけの黒が4色になる**。入稿データとして正しいほど(OutputIntent が在るほど)、検査が嘘をつく。
`pymupdf.TOOLS.set_icc(False)` で ICC を切ると DeviceCMYK は素通しになる(C=M=Y=0, K=255)。
この検査は最初に ICC を切り、**K だけの手作りの PDF(OutputIntent つき)を描いて C=M=Y=0 と出ること**を
毎回確かめてから使う(確かめられなければ終了コード 2 で止まる)。
ICC を切ると RGB → CMYK は素朴な変換になる(RGB の黒が K だけに見える)。**RGB の取りこぼしは
絵ではなく項目2の総なめで見る**ので、絵のほうは CMYK の命令・画素だけを素通しで見られれば足りる。

### 描いた絵のインクは、写真では本当の最大より小さく出る

72dpi に縮めると、画素が混ざって最大が下がる(1664×2560 の画像を 429pt 幅に描くと 1/4 以下に縮む)。
だから**インクの最大は、画像の画素・content stream の k/K の数字を直に読んだ値を正**とする。
描いた絵は、直読みで見えないもの(シェーディング・パターン・透明の重なり)の網として併用し、
どちらかが上限を超えたら落とす。食い違い(描いた絵のほうが大きい)は表に出す。

### MuPDF の ICC を切ると、Adobe 印の CMYK JPEG の読み方が変わる

Ghostscript が JPEG に圧縮し直した CMYK 画像(試作 trial-v4 の p1)は、ICC を切って RGB に描くと平均輝度 143、
ICC を効かせると 209(変換前 210)と、同じ絵が違って見えた。だから**見た目の比べ(項目1・6)は ICC を効かせて描き**、
インクと K だけの判定(項目3・4)は ICC を切って描く。Flate の CMYK 画像(あるべき出力)には影響しない。

## 検査そのものの検査(2026-10-01)

    trial-v4-color-out.pdf  落ちた: ink(最大 361%)・pdfx(OutputIntent なし・TrimBox なし・Group /CS が RGB・版 1.7)
                            ・boxes(MediaBox が 0.1〜0.18mm 大きい・TrimBox なし)・images(JPEG 9個)
                            通った: content・rgb の命令(rg/RG 0。Group の /CS だけ RGB)・konly(文字だけの 15 ページ)
    trial-v1-cover-out.pdf  落ちた: ink(356%)・pdfx・boxes(TrimBox なし)・images(JPEG)
    color-a5.pdf を --out に  落ちた: rgb(rg/RG 422 か所・ICCBased N=3 の画像・Group)
    手作りの X-4(scratchpad の make_good.py)  全項目が通る。RGB の黒・400% のインク・XMP なし・Trapped 無し・OutputIntent なしの版は、それぞれの項目だけが落ちる

## X-4 の決まりの出典と、自信の無いところ

各所のコメントに「[出典 …]」で書いた。ISO 15930-7:2010(PDF/X-4)の条文そのものは有料で、
手元で確かめられたのは Ghostscript・pdfx 系ツールの実装と PDF/X の解説(callas・Ghent PDF Output Suite の
公開資料)から。**自信の無い項目は「[要確認]」を付け、落ちても「規格違反と断定できない」旨を出す。**
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit('numpy が要ります: pip install numpy')
try:
    import pymupdf
except ImportError:  # pragma: no cover
    try:
        import fitz as pymupdf  # type: ignore
    except ImportError:
        sys.exit('PyMuPDF が要ります: pip install pymupdf')
try:
    from pypdf import PdfReader
    from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NameObject
except ImportError:  # pragma: no cover
    sys.exit('pypdf が要ります: pip install pypdf')

MM = 72 / 25.4  # 1mm = 2.8346pt

# ---------------------------------------------------------------------------
# しきい値(実物で決めた。根拠は各行)
# ---------------------------------------------------------------------------

# 「中身が減っていない」の絵の比べ方。72dpi の輝度(0.299R+0.587G+0.114B)を 3x3 でぼかして差を取る。
# **色ではなく輝度**で比べるのは、CMYK にすると鮮やかな色は少し変わる一方、物が消えた・ずれたときは輝度が大きく動くため。
# 実測(2026-10-01。試作 trial-v4 の p5 を、変換前 color-a5 の p5 と比べた):
#   正しい変換後         ぼかした輝度差の最大 0.9、>60 の画素 0 個(全 32 ページで 0)
#   20x60pt の文字を白で消す  >60 の画素 0.063%(最大差 220)
#   8x8pt を消す             >60 の画素 0.0046%(最大差 93)  ← 絵では拾えない。文字の突き合わせが拾う
#   1pt ずらす・3pt ずらす   ずれの探索(best_shift)が (+1,0)・(+3,+3)px と当てた。3pt ずれは >60 の画素 3.2%
# 雑音が 0 なので、しきい値は「画素 0.03%(= 15x25pt ほどの欠け)」にした
LUMA_DIFF_T = 60       # この輝度差(0..255)を超えた画素を「違う」と数える
LUMA_FRAC_MAX = 0.0003  # 「違う」画素が1ページの 0.03% を超えたら落とす
SHIFT_RADIUS = 4       # 絵のずれを探す範囲(72dpi で ±4px = ±1.4mm)

# 箱の寸法の許す差(mm)。指示どおり 0.05mm
BOX_TOL_MM = 0.05
BOX_TOL = BOX_TOL_MM * MM
# 箱の入れ子の比べは、数字の丸め(PDF は小数 5 桁まで)だけ許す
NEST_TOL = 0.01

# インクの許すはみ出し(百分率の点)。8bit の丸めで 300% が 300.4% になりうるので 1 点まで許す
INK_SLACK = 1.0

ITEM_ORDER = ['content', 'rgb', 'ink', 'konly', 'pdfx', 'boxes', 'images']
ITEM_TITLE = {
    'content': '1 中身が減っていない',
    'rgb': '2 RGB が残っていない',
    'ink': '3 インクの量',
    'konly': '4 K だけのページ',
    'pdfx': '5 PDF/X-4 の形',
    'boxes': '6 箱の寸法',
    'images': '7 画像が劣化していない',
}


# ---------------------------------------------------------------------------
# 結果の入れ物
# ---------------------------------------------------------------------------

@dataclass
class Item:
    key: str
    status: str = 'pass'            # pass / fail / skip
    lines: list[str] = field(default_factory=list)   # 通ったことの中身・表
    problems: list[str] = field(default_factory=list)  # 落ちた理由(場所と数字つき)
    notes: list[str] = field(default_factory=list)   # 落ちはしないが知っておくこと

    def fail(self, msg: str) -> None:
        self.problems.append(msg)
        self.status = 'fail'

    def skip(self, why: str) -> None:
        self.status = 'skip'
        self.notes.append(why)

    def to_json(self) -> dict:
        return {'item': self.key, 'title': ITEM_TITLE[self.key], 'status': self.status,
                'problems': self.problems, 'notes': self.notes, 'detail': self.lines}


def fmt_pages(nums: list[int]) -> str:
    """[2,4,5,6,9] → '2,4-6,9'"""
    nums = sorted(set(nums))
    out, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f'{nums[i]}-{nums[j]}')
        i = j + 1
    return ','.join(out) if out else '(なし)'


def head(lst: list, n: int = 8) -> str:
    s = ', '.join(str(x) for x in lst[:n])
    return s + (f' …他{len(lst) - n}' if len(lst) > n else '')


# ---------------------------------------------------------------------------
# content stream の字句(命令単位で読む)
# ---------------------------------------------------------------------------

_WS = b'\x00\t\n\x0c\r '
_REG = rb'[^\x00\t\n\x0c\r ()<>\[\]{}/%]'
_TOK = re.compile(
    rb'[\x00\t\n\x0c\r ]*(?:(%[^\r\n]*)|(/' + _REG + rb'*)|(<<)|(>>)|(<[^>]*>)|(\[)|(\])|(\()|(' + _REG + rb'+)|(.))',
    re.S)
_STR_SPECIAL = re.compile(rb'[()\\]')
_NUM = re.compile(rb'^[+-]?(?:\d+\.?\d*|\.\d+)$')
_EI = re.compile(rb'[\x00\t\n\x0c\r ]EI(?=[\x00\t\n\x0c\r ]|$)')


@dataclass
class ContentFacts:
    """1本の content stream が持つ色の命令"""
    rgb: list[tuple[str, tuple[float, float, float]]] = field(default_factory=list)   # rg / RG
    cmyk: list[tuple[str, tuple[float, float, float, float]]] = field(default_factory=list)  # k / K(と 4 数の sc)
    gray: list[float] = field(default_factory=list)   # g / G の値(K だけのインクとして数える)
    do_names: list[str] = field(default_factory=list)    # Do で描くもの(画像・Form)の名前
    pat_names: list[str] = field(default_factory=list)   # scn/SCN の最後の名前(パターンで塗る)
    sh_names: list[str] = field(default_factory=list)    # sh で塗るシェーディングの名前
    gs_names: list[str] = field(default_factory=list)    # gs(ExtGState。SMask を持つことがある)の名前
    font_names: list[str] = field(default_factory=list)  # Tf で選ぶ書体の名前(Type3 の字は別の stream)
    sc3: list[tuple[float, float, float]] = field(default_factory=list)  # 3 数の sc/scn(RGB か Lab か ICC3 か名前で決まる)
    cs_rgb: Counter = field(default_factory=Counter)    # `/DeviceRGB cs` のように直に書かれた RGB 系の色空間
    cs_cmyk: int = 0
    inline: list[dict] = field(default_factory=list)    # BI … ID … EI の画像
    sh: int = 0                      # sh(シェーディングを塗る)の数
    n_ops: int = 0


def scan_content(data: bytes) -> ContentFacts:
    """content stream を字句に分けて、色の命令だけを拾う。

    文字列 `( … )` の中の `rg` や、インライン画像の画素の中の `EI` を命令と取り違えないよう、
    文字列は入れ子・エスケープごと読み飛ばし、BI は ID まで辞書として読んで画素を飛ばす。
    (Ghostscript は小さい画像を BI … EI で書く。2026-10-01)
    """
    f = ContentFacts()
    pos, n = 0, len(data)
    operands: list = []
    in_bi = False
    while pos < n:
        m = _TOK.match(data, pos)
        if not m:
            break
        pos = m.end()
        if m.group(1) is not None:      # コメント
            continue
        if m.group(2) is not None:      # 名前
            operands.append(('n', m.group(2)[1:].decode('latin1')))
            continue
        if m.group(3) is not None or m.group(4) is not None or m.group(6) is not None or m.group(7) is not None:
            operands.append(('d', m.group(0).strip().decode('latin1')))
            continue
        if m.group(5) is not None:      # 16進文字列
            operands.append(('s', ''))
            continue
        if m.group(8) is not None:      # 文字列。入れ子とエスケープを読み飛ばす
            depth = 1
            while depth and pos < n:
                s = _STR_SPECIAL.search(data, pos)
                if not s:
                    pos = n
                    break
                ch = data[s.start()]
                if ch == 0x5C:          # バックスラッシュ: 次の1字を飛ばす
                    pos = s.start() + 2
                    continue
                depth += 1 if ch == 0x28 else -1
                pos = s.end()
            operands.append(('s', ''))
            continue
        tok = m.group(9)
        if tok is None:
            continue
        if _NUM.match(tok):
            operands.append(float(tok))
            continue
        if tok in (b'true', b'false', b'null'):
            operands.append(('k', tok.decode()))
            continue
        # ここから演算子
        op = tok.decode('latin1')
        if op == 'BI':
            in_bi = True
            operands = []
            continue
        if op == 'ID' and in_bi:
            d = {}
            i = 0
            while i < len(operands) - 1:
                if isinstance(operands[i], tuple) and operands[i][0] == 'n':
                    v = operands[i + 1]
                    d[operands[i][1]] = v[1] if isinstance(v, tuple) else v
                    i += 2
                else:
                    i += 1
            f.inline.append(d)
            e = _EI.search(data, pos)
            pos = e.end() if e else n
            in_bi = False
            operands = []
            f.n_ops += 1
            continue
        nums = [v for v in operands if isinstance(v, float)]
        f.n_ops += 1
        if op in ('rg', 'RG') and len(nums) >= 3:
            f.rgb.append((op, tuple(nums[-3:])))
        elif op in ('k', 'K') and len(nums) >= 4:
            f.cmyk.append((op, tuple(nums[-4:])))
        elif op in ('g', 'G'):
            if nums:
                f.gray.append(nums[-1])
        elif op in ('sc', 'scn', 'SC', 'SCN'):
            if operands and isinstance(operands[-1], tuple) and operands[-1][0] == 'n':
                f.pat_names.append(operands[-1][1])
            if len(nums) == 4:
                f.cmyk.append((op, tuple(nums)))
            elif len(nums) == 3:
                f.sc3.append(tuple(nums))
        elif op in ('cs', 'CS'):
            nm = operands[-1][1] if operands and isinstance(operands[-1], tuple) and operands[-1][0] == 'n' else ''
            if nm in ('DeviceRGB', 'CalRGB', 'Lab', 'RGB'):
                f.cs_rgb[nm] += 1
            elif nm in ('DeviceCMYK', 'CMYK'):
                f.cs_cmyk += 1
        elif op == 'sh':
            f.sh += 1
            if operands and isinstance(operands[-1], tuple) and operands[-1][0] == 'n':
                f.sh_names.append(operands[-1][1])
        elif op in ('Do', 'gs', 'Tf'):
            nm = next((v[1] for v in operands if isinstance(v, tuple) and v[0] == 'n'), None)
            if nm is not None:
                {'Do': f.do_names, 'gs': f.gs_names, 'Tf': f.font_names}[op].append(nm)
        operands = []
    return f


# ---------------------------------------------------------------------------
# PDF 1冊の入れ物
# ---------------------------------------------------------------------------

CS_FAMILIES = ('/ICCBased', '/Indexed', '/I', '/CalRGB', '/CalGray', '/Lab', '/Separation', '/DeviceN', '/Pattern')


def deref(o):
    return o.get_object() if hasattr(o, 'get_object') else o


def cs_desc(cs) -> str:
    """色空間の指定を、報告に載せる短い字にする(/ICCBased N=3 など)"""
    cs = deref(cs)
    if isinstance(cs, list) and cs:
        fam = str(deref(cs[0]))
        if fam == '/ICCBased':
            try:
                return f'/ICCBased N={deref(cs[1]).get("/N")}'
            except Exception:
                return '/ICCBased'
        if fam in ('/Indexed', '/I'):
            return '/Indexed(元 ' + cs_desc(cs[1]) + ')'
        if fam in ('/Separation', '/DeviceN') and len(cs) > 2:
            return fam + '(代替 ' + cs_desc(cs[2]) + ')'
        return fam
    return str(cs)[:40]


def cs_class(cs, depth: int = 0) -> set[str]:
    """色空間の指定を {'GRAY','RGB','CMYK','LAB','PATTERN','NAMED'} にする。

    Indexed は元の色空間、Separation/DeviceN は代替の色空間、ICCBased は /N で決める。
    """
    cs = deref(cs)
    if depth > 6 or cs is None:
        return {'UNKNOWN'}
    if isinstance(cs, str):
        nm = str(cs)
        if nm in ('/DeviceGray', '/G', '/CalGray'):
            return {'GRAY'}
        if nm in ('/DeviceRGB', '/RGB', '/CalRGB'):
            return {'RGB'}
        if nm in ('/DeviceCMYK', '/CMYK'):
            return {'CMYK'}
        if nm == '/Pattern':
            return {'PATTERN'}
        return {'NAMED'}   # リソースの名前(中身は別に総なめされる)
    if isinstance(cs, list) and cs:
        fam = str(deref(cs[0]))
        if fam == '/ICCBased':
            try:
                n = int(deref(cs[1]).get('/N'))
            except Exception:
                return {'UNKNOWN'}
            return {1: {'GRAY'}, 3: {'RGB'}, 4: {'CMYK'}}.get(n, {'UNKNOWN'})
        if fam in ('/Indexed', '/I'):
            return cs_class(cs[1], depth + 1)
        if fam in ('/Separation', '/DeviceN'):
            return cs_class(cs[2], depth + 1) if len(cs) > 2 else {'UNKNOWN'}
        if fam == '/CalRGB':
            return {'RGB'}
        if fam == '/CalGray':
            return {'GRAY'}
        if fam == '/Lab':
            return {'LAB'}
        if fam == '/Pattern':
            return {'PATTERN'}
        return cs_class(cs[0], depth + 1)
    return {'UNKNOWN'}


def _eq_comps(v, tol=0.0005) -> bool:
    v = deref(v)
    if not isinstance(v, list) or not v:
        return False
    xs = [float(deref(x)) for x in v]
    return max(xs) - min(xs) <= tol


def fn_neutral(fn, depth: int = 0) -> bool:
    """関数の出力が、どの入力でも R=G=B(無彩色)か。分からないものは False(=色が在るとみなす)"""
    fn = deref(fn)
    if depth > 6 or not isinstance(fn, dict):
        return False
    try:
        ft = int(fn.get('/FunctionType'))
    except Exception:
        return False
    if ft == 2:
        return _eq_comps(fn.get('/C0', [0.0])) and _eq_comps(fn.get('/C1', [1.0])) if fn.get('/C0') is not None and fn.get('/C1') is not None else False
    if ft == 3:
        subs = deref(fn.get('/Functions'))
        return isinstance(subs, list) and all(fn_neutral(x, depth + 1) for x in subs)
    return False


def shading_neutral(sh) -> bool:
    """シェーディングが無彩色だけでできているか。Chrome は背景の白(1 1 1 の軸グラデーション)をこの形で塗る"""
    sh = deref(sh)
    if not isinstance(sh, dict):
        return False
    cl = cs_class(sh.get('/ColorSpace')) if sh.get('/ColorSpace') is not None else {'UNKNOWN'}
    if cl == {'GRAY'}:
        return True
    if cl == {'RGB'}:
        return fn_neutral(sh.get('/Function'))
    return False


@dataclass
class ImgRef:
    xref: int
    w: int
    h: int
    cls: set
    mask: bool            # /ImageMask(色は現在の塗りの色)
    filters: list[str]


@dataclass
class PageInfo:
    no: int                # 1始まり
    xref: int
    streams: list[int] = field(default_factory=list)   # 描く命令を持つ stream(ページの Contents・Form・タイル・Type3 の字)
    images: list[ImgRef] = field(default_factory=list)
    shadings: int = 0          # 色が在る(か、無彩色と言い切れない)シェーディング・パターンの数
    shadings_neutral: int = 0  # 無彩色と確かめられたシェーディングの数(白い背景など)
    tiling: int = 0


def _filters_of(d) -> list[str]:
    f = deref(d.get('/Filter'))
    if f is None:
        return []
    if isinstance(f, list):
        return [str(deref(x)) for x in f]
    return [str(f)]


def _idnum(o) -> int | None:
    return o.idnum if isinstance(o, IndirectObject) else None


class Pdf:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.mu = pymupdf.open(str(self.path))
        self.reader = PdfReader(str(self.path), strict=False)
        self.n_pages = self.mu.page_count
        self._pages: list[PageInfo] | None = None
        self._facts: dict[int, ContentFacts] = {}
        self._imgink: dict[int, tuple[float, float] | None] = {}
        self._sweep: Sweep | None = None
        self.raw = self.path.read_bytes()

    # --- オブジェクトの総なめ(1番から /Size の手前まで。xref の表に載っていない番号も当たってみる) ---
    def all_objects(self):
        size = int(self.reader.trailer['/Size'])
        for n in range(1, size):
            try:
                o = self.reader.get_object(IndirectObject(n, 0, self.reader))
            except Exception:
                continue
            if o is None:
                continue
            yield n, o

    def stream(self, n: int) -> bytes:
        try:
            return self.mu.xref_stream(n) or b''
        except Exception:
            return b''

    def facts(self, n: int) -> ContentFacts:
        if n not in self._facts:
            self._facts[n] = scan_content(self.stream(n))
        return self._facts[n]

    # --- ページごとに、**実際に使われている**描く命令・画像・シェーディングをたどる ---
    # Chrome の PDF は、使わないパターン(グラデーション)もページの Resources に並べる(実測 2026-10-01:
    # 文字だけのページ 15 枚すべてに /Pattern が 1 つ在るが、content stream から呼ばれてはいない)。
    # Resources の一覧を「色が在る」と数えると文字だけのページが 1 枚も無くなるので、Do・scn・sh・gs・Tf で
    # 名前が呼ばれたものだけを、そのストリーム自身の Resources(無ければ親の)で引いてたどる
    def pages(self) -> list[PageInfo]:
        if self._pages is not None:
            return self._pages
        out = []
        for i, page in enumerate(self.reader.pages):
            pi = PageInfo(no=i + 1, xref=page.indirect_reference.idnum if page.indirect_reference else -1)
            seen: set[int] = set()

            def inherit(d, key):
                p = d
                for _ in range(40):
                    if p is None:
                        return None
                    v = p.get(key)
                    if v is not None:
                        return v
                    p = p.get('/Parent')
                return None

            def lookup(res, kind, name):
                d = deref(res.get(kind)) if isinstance(res, dict) else None
                if isinstance(d, dict) and ('/' + name) in d:
                    ref = dict.get(d, '/' + name)
                    return ref, deref(ref)
                return None, None

            def visit_stream(idn, own_res, parent_res):
                """idn: content stream の番号。own_res: そのストリームの /Resources(無ければ None)"""
                if idn in seen:
                    return
                seen.add(idn)
                pi.streams.append(idn)
                res = deref(own_res) if own_res is not None else parent_res
                f = self.facts(idn)
                for nm in f.do_names:
                    ref, obj = lookup(res, '/XObject', nm)
                    if not isinstance(obj, dict):
                        continue
                    st = str(obj.get('/Subtype'))
                    if st == '/Image':
                        k = _idnum(ref)
                        if k is not None and k in seen:
                            continue
                        if k is not None:
                            seen.add(k)
                        try:
                            w, h = int(obj.get('/Width')), int(obj.get('/Height'))
                        except Exception:
                            w = h = 0
                        cs = obj.get('/ColorSpace')
                        pi.images.append(ImgRef(k if k is not None else -1, w, h,
                                                cs_class(cs) if cs is not None else {'GRAY'},
                                                bool(obj.get('/ImageMask')), _filters_of(obj)))
                    elif st == '/Form' and _idnum(ref) is not None:
                        visit_stream(_idnum(ref), obj.get('/Resources'), res)
                for nm in f.pat_names:
                    ref, obj = lookup(res, '/Pattern', nm)
                    if isinstance(obj, dict):
                        if int(obj.get('/PatternType', 0) or 0) == 1 and _idnum(ref) is not None:
                            pi.tiling += 1
                            visit_stream(_idnum(ref), obj.get('/Resources'), res)
                        elif shading_neutral(obj.get('/Shading')):
                            pi.shadings_neutral += 1
                        else:
                            pi.shadings += 1
                for nm in f.sh_names:
                    _, obj = lookup(res, '/Shading', nm)
                    if shading_neutral(obj):
                        pi.shadings_neutral += 1
                    else:
                        pi.shadings += 1
                for nm in f.gs_names:
                    ref, obj = lookup(res, '/ExtGState', nm)
                    if isinstance(obj, dict):
                        sm = deref(obj.get('/SMask'))
                        g = dict.get(sm, '/G') if isinstance(sm, dict) else None
                        if _idnum(g) is not None:
                            visit_stream(_idnum(g), deref(g).get('/Resources'), res)
                for nm in f.font_names:
                    ref, fd = lookup(res, '/Font', nm)
                    if isinstance(fd, dict) and str(fd.get('/Subtype')) == '/Type3':
                        cp = deref(fd.get('/CharProcs'))
                        if isinstance(cp, dict):
                            for _, cref in cp.items():
                                if _idnum(cref) is not None:
                                    visit_stream(_idnum(cref), fd.get('/Resources'), res)

            raw = dict.get(page, '/Contents')
            ids: list[int] = []
            if isinstance(raw, IndirectObject):
                o = raw.get_object()
                if isinstance(o, list):
                    ids = [_idnum(r) for r in o if _idnum(r) is not None]
                else:
                    ids = [raw.idnum]
            elif isinstance(raw, list):
                ids = [_idnum(r) for r in raw if _idnum(r) is not None]
            pres = deref(inherit(page, '/Resources'))
            for idn in ids:
                visit_stream(idn, None, pres)
            out.append(pi)
        self._pages = out
        return out

    def image_ink(self, xref: int) -> tuple[float, float] | None:
        """CMYK 画像の画素を直に読んで (C+M+Y+K の最大[0..4], C・M・Y の最大[0..1])。読めなければ None。
        Pixmap は Decode 配列も効かせて読んでくれる。ICC は set_icc(False) で切ってあるので素通し。"""
        if xref in self._imgink:
            return self._imgink[xref]
        res = None
        try:
            pm = pymupdf.Pixmap(self.mu, xref)
            if pm.n == 4 and pm.colorspace is not None and pm.colorspace.name == 'DeviceCMYK':
                a = np.frombuffer(pm.samples, np.uint8).reshape(-1, 4)
                res = (float(a.sum(axis=1, dtype=np.uint16).max()) / 255, float(a[:, :3].max()) / 255)
            elif pm.n == 1 and pm.colorspace is not None and pm.colorspace.name == 'DeviceGray':
                a = np.frombuffer(pm.samples, np.uint8)
                res = (1 - float(a.min()) / 255, 0.0)   # グレーは K だけ。インク = 1 - 明るさ
        except Exception:
            res = None
        self._imgink[xref] = res
        return res

    def sweep(self) -> 'Sweep':
        if self._sweep is None:
            self._sweep = do_sweep(self)
        return self._sweep


# ---------------------------------------------------------------------------
# オブジェクトの総なめ(1番から最後まで)
# ---------------------------------------------------------------------------

# X-4 で持ってはいけない鍵。[出典 ISO 15930-7 の禁止事項を、Ghostscript の pdfwrite の PDF/X 実装(gdevpdfx.c の
# pdf_check_forbidden_*)と callas の PDF/X-4 プロファイルの名称で突き合わせた。X-4 は X-1a より緩い(透明・OCG・ICC が可)]
FORBIDDEN_KEYS = {
    '/JS': 'JavaScript', '/JavaScript': 'JavaScript', '/AA': '追加の動作(AA)', '/OpenAction': '開いたときの動作',
    '/EmbeddedFiles': '埋め込みファイル', '/EF': '埋め込みファイル', '/Movie': '動画', '/Sound': '音',
    '/Rendition': 'レンディション', '/RichMedia': 'リッチメディア', '/3D': '3D', '/Trans': 'ページ切り替え効果',
    '/OPI': 'OPI', '/Alternates': '代替画像', '/Ref': '参照 XObject', '/XFA': 'XFA',
}


@dataclass
class Sweep:
    n_objects: int = 0
    n_streams: int = 0
    rgb: list[dict] = field(default_factory=list)       # {obj, kind, detail}
    cmyk: list[dict] = field(default_factory=list)
    icc_ids: set = field(default_factory=set)
    images: list[dict] = field(default_factory=list)    # {obj,w,h,bpc,filters,cls,mask,hasS}
    fonts: list[dict] = field(default_factory=list)
    filters: dict = field(default_factory=lambda: defaultdict(list))
    keys: dict = field(default_factory=lambda: defaultdict(list))
    actions: list[dict] = field(default_factory=list)
    groups: list[dict] = field(default_factory=list)
    smask_bc: list[dict] = field(default_factory=list)
    transfer: list[dict] = field(default_factory=list)
    content_streams: set = field(default_factory=set)
    ocg: list[int] = field(default_factory=list)
    external: list[int] = field(default_factory=list)
    ps_xobj: list[int] = field(default_factory=list)


def _bc_len(v) -> int:
    v = deref(v)
    return len(v) if isinstance(v, list) else 0


def do_sweep(pdf: Pdf) -> Sweep:
    sw = Sweep()
    reader = pdf.reader
    root = reader.trailer['/Root'].get_object()
    oi = deref(root.get('/OutputIntents'))
    if isinstance(oi, list):
        for x in oi:
            d = deref(x)
            if isinstance(d, dict):
                dp = d.get('/DestOutputProfile')
                if _idnum(dict.get(d, '/DestOutputProfile')) is not None:
                    sw.icc_ids.add(_idnum(dict.get(d, '/DestOutputProfile')))
    for pg in reader.pages:
        c = dict.get(pg, '/Contents')
        if isinstance(c, IndirectObject):
            o = c.get_object()
            if isinstance(o, list):
                for r in o:
                    if _idnum(r) is not None:
                        sw.content_streams.add(_idnum(r))
            else:
                sw.content_streams.add(c.idnum)
        elif isinstance(c, list):
            for r in c:
                if _idnum(r) is not None:
                    sw.content_streams.add(_idnum(r))

    def rgb_hit(n, kind, detail):
        sw.rgb.append({'obj': n, 'kind': kind, 'detail': detail})

    def walk(o, n, path, owner):
        """辞書・配列を総なめ。参照(IndirectObject)はたどらない(参照先は別の番号で必ず来る)"""
        if isinstance(o, IndirectObject):
            return
        if isinstance(o, dict):
            keys = set(o.keys())
            for k in keys & set(FORBIDDEN_KEYS):
                sw.keys[k].append(n)
            if '/TR' in keys:
                v = deref(o.get('/TR'))
                if str(v) != '/Identity':
                    sw.transfer.append({'obj': n, 'key': '/TR', 'v': str(v)[:30]})
            if '/TR2' in keys:
                v = deref(o.get('/TR2'))
                if str(v) != '/Default':
                    sw.transfer.append({'obj': n, 'key': '/TR2', 'v': str(v)[:30]})
            if '/HT' in keys:
                v = deref(o.get('/HT'))
                if isinstance(v, dict) and ('/TransferFunction' in v or '/HalftoneName' in v):
                    sw.transfer.append({'obj': n, 'key': '/HT', 'v': 'TransferFunction/HalftoneName あり'})
            if '/S' in keys and '/A' not in keys:
                st = str(deref(o.get('/S')))
                if st in ('/JavaScript', '/Launch', '/URI', '/GoToR', '/GoToE', '/SubmitForm', '/ResetForm',
                          '/ImportData', '/Named', '/SetOCGState', '/Rendition', '/Sound', '/Movie', '/Hide',
                          '/Thread', '/Trans', '/GoTo3DView', '/GoTo'):
                    sw.actions.append({'obj': n, 'S': st})
            if '/A' in keys:
                a = deref(o.get('/A'))
                if isinstance(a, dict) and '/S' in a:
                    sw.actions.append({'obj': n, 'S': str(deref(a.get('/S')))})
            if str(deref(o.get('/Type'))) == '/OCG':
                sw.ocg.append(n)
            if '/OC' in keys:
                sw.ocg.append(n)
            if '/OCProperties' in keys:
                sw.ocg.append(n)
            # ストリームの種別
            sub = str(deref(o.get('/Subtype'))) if '/Subtype' in keys else ''
            if hasattr(o, 'get_data'):
                sw.n_streams += 1
                for fl in _filters_of(o):
                    sw.filters[fl].append(n)
                if '/F' in keys:
                    sw.external.append(n)
                if sub == '/Form' or int(o.get('/PatternType', 0) or 0) == 1:
                    sw.content_streams.add(n)
                if sub == '/PS':
                    sw.ps_xobj.append(n)
            if str(deref(o.get('/Type'))) == '/XObject' and sub == '/PS':
                sw.ps_xobj.append(n)
            if '/CharProcs' in keys:
                cp = deref(o.get('/CharProcs'))
                if isinstance(cp, dict):
                    for _, r in cp.items():
                        if _idnum(r) is not None:
                            sw.content_streams.add(_idnum(r))
            # 画像
            if sub == '/Image':
                cs = o.get('/ColorSpace')
                cls = cs_class(cs) if cs is not None else ({'GRAY'} if o.get('/ImageMask') else {'UNKNOWN'})
                try:
                    w, h = int(o.get('/Width')), int(o.get('/Height'))
                except Exception:
                    w = h = 0
                sw.images.append({'obj': n, 'w': w, 'h': h, 'bpc': int(o.get('/BitsPerComponent', 0) or 0),
                                  'filters': _filters_of(o), 'cls': cls, 'mask': bool(o.get('/ImageMask')),
                                  'cs': (cs_desc(cs) if cs is not None else None)})
                if 'RGB' in cls or 'LAB' in cls:
                    rgb_hit(n, '画像の色空間', f'{w}x{h} {cs_desc(cs)}')
                if 'CMYK' in cls:
                    sw.cmyk.append({'obj': n, 'kind': '画像の色空間', 'detail': f'{w}x{h}'})
            # 透明のグループ
            if '/Group' in keys:
                g = deref(o.get('/Group'))
                if isinstance(g, dict) and str(deref(g.get('/S'))) == '/Transparency':
                    cs = g.get('/CS')
                    sw.groups.append({'obj': n, 'cs': (cs_desc(cs) if cs is not None else None),
                                      'cls': cs_class(cs) if cs is not None else set(), 'page': str(deref(o.get('/Type'))) == '/Page'})
                    if cs is not None:
                        cl = cs_class(cs)
                        if 'RGB' in cl or 'LAB' in cl:
                            rgb_hit(n, '透明のグループ(/Group /CS)', cs_desc(cs))
                        if 'CMYK' in cl:
                            sw.cmyk.append({'obj': n, 'kind': '透明のグループ(/Group /CS)', 'detail': str(deref(cs))[:50]})
            # SMask の /BC
            if '/BC' in keys and str(deref(o.get('/S'))) == '/Luminosity':
                bl = _bc_len(o.get('/BC'))
                sw.smask_bc.append({'obj': n, 'n': bl})
                if bl == 3:
                    rgb_hit(n, 'SMask の /BC', '3成分(RGB)')
                if bl == 4:
                    sw.cmyk.append({'obj': n, 'kind': 'SMask の /BC', 'detail': '4成分(CMYK)'})
            # シェーディング・パターンの色空間
            if '/ShadingType' in keys and '/ColorSpace' in keys:
                cl = cs_class(o.get('/ColorSpace'))
                if 'RGB' in cl or 'LAB' in cl:
                    rgb_hit(n, 'シェーディングの色空間', cs_desc(o.get('/ColorSpace')))
                if 'CMYK' in cl:
                    sw.cmyk.append({'obj': n, 'kind': 'シェーディングの色空間', 'detail': ''})
            # フォント
            if str(deref(o.get('/Type'))) == '/Font' and sub in ('/Type1', '/TrueType', '/MMType1', '/Type3', '/Type0',
                                                                '/CIDFontType0', '/CIDFontType2'):
                emb = None
                if sub == '/Type3':
                    emb = True
                elif sub != '/Type0':
                    fd = deref(o.get('/FontDescriptor'))
                    emb = bool(isinstance(fd, dict) and any(k in fd for k in ('/FontFile', '/FontFile2', '/FontFile3')))
                sw.fonts.append({'obj': n, 'sub': sub, 'base': str(deref(o.get('/BaseFont')) or ''), 'emb': emb})
            for k, v in o.items():
                walk(v, n, path + [str(k)], o)
            return
        if isinstance(o, list):
            if o and isinstance(o[0], str) and str(o[0]) in CS_FAMILIES:
                fam = str(o[0])
                cl = cs_class(o)
                detail = f'{fam}' + (f' N={deref(o[1]).get("/N")}' if fam == '/ICCBased' and isinstance(deref(o[1]), dict) else '')
                if fam == '/ICCBased' and _idnum(o[1]) is not None:
                    sw.icc_ids.add(_idnum(o[1]))
                if 'RGB' in cl or 'LAB' in cl:
                    rgb_hit(n, '色空間の配列', detail if fam != '/Indexed' else '/Indexed の元が RGB')
                if 'CMYK' in cl:
                    sw.cmyk.append({'obj': n, 'kind': '色空間の配列', 'detail': detail})
            for v in o:
                walk(v, n, path, owner)
            return
        if isinstance(o, str) and isinstance(o, NameObject):
            nm = str(o)
            if nm in ('/DeviceRGB', '/CalRGB', '/Lab'):
                # 画像・グループ・シェーディング・配列の中は上で個別に数えた。ここは「名前が直に書かれた」残り
                if not (path and path[-1] in ('/ColorSpace', '/CS')) and not any(p in ('/Indexed',) for p in path):
                    rgb_hit(n, '名前の直書き', f'{"/".join(path[-3:])}={nm}')
            elif nm == '/DeviceCMYK':
                if not (path and path[-1] in ('/ColorSpace', '/CS')):
                    sw.cmyk.append({'obj': n, 'kind': '名前の直書き', 'detail': f'{"/".join(path[-3:])}={nm}'})

    for n, o in pdf.all_objects():
        sw.n_objects += 1
        walk(o, n, [], None)
    # 画像・グループの /ColorSpace・/CS が名前そのもの(/DeviceRGB)のとき、walk の名前の直書きは除外してあるので、
    # cs_class で拾ったほうを使う(重複しない)。ICC のストリーム自身(中身は色の指定でない)は数えない
    sw.rgb = [h for h in sw.rgb if h['obj'] not in sw.icc_ids]
    sw.cmyk = [h for h in sw.cmyk if h['obj'] not in sw.icc_ids]
    # 同じ場所の重複を落とす
    for lst in (sw.rgb, sw.cmyk):
        seen = set()
        uniq = []
        for h in lst:
            k = (h['obj'], h['kind'], h['detail'])
            if k not in seen:
                seen.add(k)
                uniq.append(h)
        lst[:] = uniq
    return sw


# ---------------------------------------------------------------------------
# 絵にする(輝度・CMYK)
# ---------------------------------------------------------------------------

def render_rgb_luma(pdf: Pdf, i: int, dpi: int = 72) -> np.ndarray:
    """ページを RGB で描いて輝度にする(変換前は RGB、変換後は見た目用に RGB に戻す)。"""
    page = pdf.mu[i]
    try:
        page.set_cropbox(page.mediabox)   # CropBox で切れていても MediaBox 全体を描く(メモリ上だけ。ファイルは書き換えない)
    except Exception:
        pass
    pm = page.get_pixmap(matrix=pymupdf.Matrix(dpi / 72, dpi / 72), colorspace=pymupdf.csRGB, alpha=False)
    a = np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, 3).astype(np.float32)
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def render_cmyk(pdf: Pdf, i: int, dpi: int = 72) -> np.ndarray:
    page = pdf.mu[i]
    try:
        page.set_cropbox(page.mediabox)
    except Exception:
        pass
    pm = page.get_pixmap(matrix=pymupdf.Matrix(dpi / 72, dpi / 72), colorspace=pymupdf.csCMYK, alpha=False)
    return np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, 4)


def blur3(a: np.ndarray) -> np.ndarray:
    p = np.pad(a, 1, mode='edge')
    h, w = a.shape
    return sum(p[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)) / 9.0


class Ctx:
    """全項目で共有するもの(引数・描いた絵の取り置き)"""

    def __init__(self, args, orig: Pdf | None, out: Pdf):
        self.args = args
        self.orig = orig
        self.out = out
        self._luma: dict[tuple[str, int], np.ndarray] = {}
        self._cmyk_render: dict[int, np.ndarray] = {}

    def cmyk(self, i: int) -> np.ndarray:
        """変換後のページを 72dpi の CMYK 画素で(ICC を切ってあるので、命令の値がそのまま出る)"""
        if i not in self._cmyk_render:
            pymupdf.TOOLS.set_icc(False)
            self._cmyk_render[i] = render_cmyk(self.out, i)
        return self._cmyk_render[i]

    def luma(self, which: str, i: int) -> np.ndarray:
        key = (which, i)
        if key not in self._luma:
            # 見た目用の RGB は **ICC を効かせて**描く(変換後は CMYK を、OutputIntent か MuPDF の既定の CMYK 基準で RGB に戻す)。
            # ICC を切ったまま描くと、Adobe 印の CMYK JPEG(Ghostscript が JPEG に圧縮し直した画像)の読み方が変わり、
            # 同じ絵が 66 も暗く見えた(p1 の平均輝度 209 → 143、2026-10-01 実測。ICC を効かせると 209 で変換前と合う)。
            # ink と K だけの判定は ICC を切った描き(cmyk())で別にやる。切り替えは描く直前だけ
            pdf = self.orig if which == 'orig' else self.out
            pymupdf.TOOLS.set_icc(True)
            try:
                self._luma[key] = render_rgb_luma(pdf, i)
            finally:
                pymupdf.TOOLS.set_icc(False)
        return self._luma[key]


# ---------------------------------------------------------------------------
# 1 中身が減っていない
# ---------------------------------------------------------------------------

def check_content(cx: Ctx) -> Item:
    it = Item('content')
    o, t = cx.orig, cx.out
    if o is None:
        it.skip('--orig が無いので比べられない')
        return it
    if o.n_pages != t.n_pages:
        it.fail(f'ページ数が違う: 変換前 {o.n_pages} → 変換後 {t.n_pages}')
        return it
    it.lines.append(f'ページ数 {t.n_pages}(変換前と同じ)')
    bad_pic, bad_txt = [], []
    stats = []
    for i in range(t.n_pages):
        lo, lt = cx.luma('orig', i), cx.luma('out', i)
        # 右端・下端の 1px は比べない: ページの大きさが小数のとき端の画素は一部しか描かれず、
        # 変換前後で MediaBox が違う(Chrome の余りを落とした)と、そこだけ絵が違って見える(mono-bunko の変換で実測 2026-10-01)
        h, w = min(lo.shape[0], lt.shape[0]) - 1, min(lo.shape[1], lt.shape[1]) - 1
        a, b = blur3(lo[:h, :w]), blur3(lt[:h, :w])
        d = np.abs(a - b)
        frac = float((d > LUMA_DIFF_T).mean())
        mass_o, mass_t = float((255 - a).sum()), float((255 - b).sum())
        ratio = (mass_t / mass_o) if mass_o > 0 else 1.0
        stats.append((i + 1, frac, ratio, lo.shape, lt.shape))
        if frac > LUMA_FRAC_MAX:
            ys, xs = np.where(d > LUMA_DIFF_T)
            bad_pic.append(f'p{i + 1}: 差の大きい画素 {frac * 100:.2f}%(上限 {LUMA_FRAC_MAX * 100:.2f}%)'
                           f' 範囲 x{xs.min()}-{xs.max()} y{ys.min()}-{ys.max()}px')
        to = re.sub(r'\s+', '', o.mu[i].get_text())
        tt = re.sub(r'\s+', '', t.mu[i].get_text())
        if to != tt:
            k = next((j for j in range(min(len(to), len(tt))) if to[j] != tt[j]), min(len(to), len(tt)))
            bad_txt.append(f'p{i + 1}: 文字が違う(変換前 {len(to)}字 → 変換後 {len(tt)}字、最初の違いは{k}字目 '
                           f'「{to[max(0, k - 5):k + 8]}」→「{tt[max(0, k - 5):k + 8]}」)')
    cx.content_stats = stats  # type: ignore[attr-defined]
    for m in bad_pic:
        it.fail('絵が違う ' + m)
    for m in bad_txt:
        it.fail(m)
    if not bad_pic:
        worst = max(stats, key=lambda s: s[1])
        it.lines.append(f'72dpi の輝度の差(>{LUMA_DIFF_T}の画素): 最大 {worst[1] * 100:.3f}%(p{worst[0]})、全ページ {LUMA_FRAC_MAX * 100:.2f}% 以下')
        rs = [s[2] for s in stats]
        it.lines.append(f'墨量(255-輝度の総和)の 変換後/変換前: {min(rs):.3f} 〜 {max(rs):.3f}')
    if not bad_txt:
        it.lines.append('抽出した文字(空白・改行を除く)が全ページで同じ')
    return it


# ---------------------------------------------------------------------------
# 2 RGB が残っていない
# ---------------------------------------------------------------------------

def check_rgb(cx: Ctx) -> Item:
    it = Item('rgb')
    t = cx.out
    kind = cx.args.kind
    sw = t.sweep()
    it.lines.append(f'総なめ: オブジェクト 1〜{int(t.reader.trailer["/Size"]) - 1} 番のうち {sw.n_objects} 個(ストリーム {sw.n_streams} 個)')
    # オブジェクトの辞書・配列の中
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for h in sw.rgb:
        by_kind[h['kind']].append(h)
    for kd, hs in by_kind.items():
        it.fail(f'{kd}に RGB 系(/DeviceRGB /CalRGB /Lab /ICCBased N=3)が {len(hs)} か所: ' +
                head([f'obj{h["obj"]}({h["detail"]})' for h in hs]))
    # content stream の命令(ページから届く所と、総なめで見つけた Form など全部)
    page_of: dict[int, list[int]] = defaultdict(list)
    for pi in t.pages():
        for s in pi.streams:
            page_of[s].append(pi.no)
    streams = set(sw.content_streams)
    for pi in t.pages():
        streams.update(pi.streams)
    n_rg = n_cmyk = n_gray = 0
    rg_streams: list[tuple[int, int, str]] = []   # (stream, 個数, 例)
    cs_streams: list[str] = []
    cmyk_streams: list[str] = []
    rg_pages: set[int] = set()
    for s in sorted(streams):
        f = t.facts(s)
        if f.rgb:
            n_rg += len(f.rgb)
            rg_streams.append((s, len(f.rgb), f'{" ".join(f"{x:g}" for x in f.rgb[0][1])} {f.rgb[0][0]}'))
            rg_pages.update(page_of.get(s, []))
        if f.cs_rgb:
            cs_streams.append(f'obj{s}(ページ {fmt_pages(page_of.get(s, []))}) {dict(f.cs_rgb)}')
        for im in f.inline:
            cs = str(im.get('CS', im.get('ColorSpace', '')))
            if cs in ('RGB', 'DeviceRGB', 'CalRGB', 'Lab'):
                cs_streams.append(f'obj{s}(ページ {fmt_pages(page_of.get(s, []))}) のインライン画像が {cs}')
            if cs in ('CMYK', 'DeviceCMYK'):
                n_cmyk += 1
        n_cmyk += len(f.cmyk)
        n_gray += len(f.gray)
        if kind == 'body-gray' and f.cmyk:
            cmyk_streams.append(f'obj{s}(ページ {fmt_pages(page_of.get(s, []))}) {len(f.cmyk)}か所')
    if rg_streams:
        it.fail(f'content stream の rg/RG が {n_rg} か所({len(rg_streams)} 本、ページ {fmt_pages(sorted(rg_pages))})。例: ' +
                head([f'obj{s} に {n}か所({ex})' for s, n, ex in rg_streams], 4))
    if cs_streams:
        it.fail('RGB 系の色空間の直書きが content stream に: ' + head(cs_streams, 4))
    if cmyk_streams:
        it.fail('白黒の本なのに content stream に k/K(CMYK)。DeviceGray だけのはず: ' + head(cmyk_streams, 4))
    it.lines.append(f'命令の総なめ: content stream {len(streams)} 本。rg/RG {n_rg} か所、k/K {n_cmyk} か所、g/G {n_gray} か所')
    if kind == 'body-gray':
        bykind: dict[str, list[dict]] = defaultdict(list)
        for h in sw.cmyk:
            bykind[h['kind']].append(h)
        for kd, hs in bykind.items():
            it.fail(f'白黒の本なのに{kd}に CMYK が {len(hs)} か所: ' + head([f'obj{h["obj"]}({h["detail"]})' for h in hs]))
    # N=3 の ICC が参照されずに残っている(色の指定ではないので数えないが、知らせる)
    return it


# ---------------------------------------------------------------------------
# 3 インクの量・4 K だけのページ(直読みと絵を突き合わせる)
# ---------------------------------------------------------------------------

def direct_page_ink(t: Pdf, pi: PageInfo) -> dict:
    """そのページから届く命令・画像を直に読む。
    返り値: ink=C+M+Y+K の最大(0..4)、cmy=C・M・Y の最大(0..1)、where=その最大の出どころ、
    nonk=K だけでない色の出どころ(RGB の命令・RGB/CMYK の画像・シェーディング)"""
    ink, cmy, where = 0.0, 0.0, ''
    nonk: list[str] = []
    for s in pi.streams:
        f = t.facts(s)
        for g in f.gray:   # DeviceGray は K だけで刷られる(インクは 1-g)
            if 1 - g > ink:
                ink, where = 1 - g, f'obj{s} の {g:g} g'
        for op, v in f.cmyk:
            tot = sum(v)
            if tot > ink:
                ink, where = tot, f'obj{s} の {" ".join(f"{x:g}" for x in v)} {op}'
            if max(v[:3]) > 0:
                cmy = max(cmy, max(v[:3]))
        if f.rgb:
            nonk.append(f'obj{s} に rg/RG {len(f.rgb)}か所')
        if f.sc3:
            nonk.append(f'obj{s} に 3数の sc/scn {len(f.sc3)}か所')
    for im in pi.images:
        if im.mask:
            continue
        if 'CMYK' in im.cls:
            r = t.image_ink(im.xref)
            if r is None:
                nonk.append(f'画像 obj{im.xref}(CMYK・画素を読めない)')
                continue
            if r[0] > ink:
                ink, where = r[0], f'画像 obj{im.xref} {im.w}x{im.h}'
            if r[1] > 0:
                cmy = max(cmy, r[1])
                nonk.append(f'画像 obj{im.xref} {im.w}x{im.h}(C・M・Y が乗る)')
        elif im.cls == {'GRAY'}:
            r = t.image_ink(im.xref)
            if r is not None and r[0] > ink:
                ink, where = r[0], f'画像 obj{im.xref} {im.w}x{im.h}(DeviceGray)'
        else:
            nonk.append(f'画像 obj{im.xref} {im.w}x{im.h} の色空間 {"/".join(sorted(im.cls))}')
    if pi.shadings:
        nonk.append(f'シェーディング/パターン {pi.shadings}個')
    return {'ink': ink, 'cmy': cmy, 'where': where, 'nonk': nonk}


def check_ink(cx: Ctx) -> Item:
    it = Item('ink')
    t = cx.out
    if cx.args.kind == 'body-gray':
        it.skip('白黒の本(K1色)なので、インクの量は 4 の「全ページ C=M=Y=0」で見る')
        return it
    limit = cx.args.ink_limit
    rows = []
    over = []
    disagree = []
    for pi in t.pages():
        dr = direct_page_ink(t, pi)
        a = cx.cmyk(pi.no - 1)
        s = a.sum(axis=2, dtype=np.uint16)
        r_ink = float(s.max()) / 255 * 100
        d_ink = dr['ink'] * 100
        cx.render_ink[pi.no] = (r_ink, float(a[..., :3].max()) / 255)  # type: ignore[attr-defined]
        cx.direct_ink[pi.no] = dr  # type: ignore[attr-defined]
        worst = max(r_ink, d_ink)
        rows.append((pi.no, d_ink, r_ink, dr['where']))
        if worst > limit + INK_SLACK:
            ys, xs = np.where(s > (limit + INK_SLACK) / 100 * 255)
            src = 'どちらも' if min(r_ink, d_ink) > limit + INK_SLACK else ('直読み(命令・画素)' if d_ink >= r_ink else '描いた絵')
            loc = (f'描いた絵では x{xs.min()}-{xs.max()} y{ys.min()}-{ys.max()}px(72dpi)' if len(xs) else '')
            over.append(f'p{pi.no}: 最大 {worst:.0f}%(直読み {d_ink:.0f}% / 絵 {r_ink:.0f}%、{src}が超えた)。'
                        f'出どころ: {dr["where"] or "直読みでは見えない(シェーディング・透明の重なりなど)"} {loc}')
        if r_ink > d_ink + 1.0:
            disagree.append((pi.no, d_ink, r_ink))
    for m in over:
        it.fail(f'上限 {limit}%(+{INK_SLACK:g}%まで許す)を超えた ' + m)
    mx = max(max(r[1], r[2]) for r in rows)
    if not over:
        it.lines.append(f'全 {len(rows)} ページで最大 {mx:.0f}% (上限 {limit}% + 許す {INK_SLACK:g}%)')
    # 表: ページごとの最大
    it.lines.append('ページごとの最大インク(直読み / 描いた絵)%:')
    line = []
    for no, d, r, w in rows:
        line.append(f'p{no}:{d:.0f}/{r:.0f}')
    for k in range(0, len(line), 8):
        it.lines.append('  ' + '  '.join(line[k:k + 8]))
    if disagree:
        it.notes.append('描いた絵のほうが直読みより 1% 以上大きいページ(シェーディング・透明の重なり・ICC 画像の可能性): ' +
                        head([f'p{n}({d:.0f}→{r:.0f}%)' for n, d, r in disagree], 6) +
                        '。判定は大きいほうで行っている(どちらかが超えれば落とす)')
    photo = [(n, d, r) for n, d, r, _ in rows if d > r + 3]
    if photo:
        it.notes.append(f'写真のページでは直読みのほうが絵より大きい(72dpi に縮むと画素が混ざる): {head([f"p{n}({d:.0f}>{r:.0f}%)" for n, d, r in photo], 5)}。'
                        '正は直読み')
    return it


def check_konly(cx: Ctx) -> Item:
    it = Item('konly')
    t, o = cx.out, cx.orig
    kind = cx.args.kind
    if kind == 'cover-cmyk':
        it.skip('表紙は絵のページ。K だけを求めない(カラーのページの一覧は出す)')
    # ページごとに、描いた絵と直読みで C・M・Y が乗るかを調べる
    color_pages: list[int] = []
    must_k: dict[int, str] = {}
    if kind == 'body-gray':
        for pi in t.pages():
            must_k[pi.no] = '白黒の本'
    elif kind == 'body-cmyk':
        if o is None:
            it.skip('--orig が無いので、変換前に色が在ったページを決められない')
        else:
            if o.n_pages != t.n_pages:
                it.fail('ページ数が変換前と違うので、ページを突き合わせられない')
                return it
            for pi in o.pages():
                col, why = page_has_color(o, pi)
                if not col:
                    must_k[pi.no] = '変換前に色が無い'
            cx.orig_color_pages = [p.no for p in o.pages() if p.no not in must_k]  # type: ignore[attr-defined]
    for pi in t.pages():
        dr = getattr(cx, 'direct_ink', {}).get(pi.no) or direct_page_ink(t, pi)
        ri = getattr(cx, 'render_ink', {}).get(pi.no)
        if ri is None:
            a = cx.cmyk(pi.no - 1)
            ri = (float(a.sum(axis=2, dtype=np.uint16).max()) / 255 * 100, float(a[..., :3].max()) / 255)
        has_cmy_render = ri[1] > 0
        has_cmy_direct = dr['cmy'] > 0 or bool(dr['nonk'])
        if has_cmy_render or has_cmy_direct:
            color_pages.append(pi.no)
            if pi.no in must_k:
                it.fail(f'p{pi.no}({must_k[pi.no]})に C・M・Y が乗っている: 描いた絵の C/M/Y 最大 {ri[1] * 100:.0f}%、'
                        f'直読み {dr["cmy"] * 100:.0f}%、' + ('; '.join(dr['nonk'][:3]) or 'K 以外の命令なし'))
    cx.color_pages = color_pages  # type: ignore[attr-defined]
    if must_k:
        bad = [p for p in must_k if p in color_pages]
        if not bad:
            it.lines.append(f'K だけのはずの {len(must_k)} ページ({fmt_pages(list(must_k))})は、全部 C=M=Y=0')
    it.lines.append(f'カラーのページ(C・M・Y が乗る) {len(color_pages)}/{t.n_pages}: {fmt_pages(color_pages)}')
    if kind == 'body-cmyk' and o is not None and hasattr(cx, 'orig_color_pages'):
        it.lines.append(f'(変換前に色が在るとみたページ: {fmt_pages(cx.orig_color_pages)})')
    return it


def page_has_color(o: Pdf, pi: PageInfo) -> tuple[bool, str]:
    """変換前のページに「色」が在るか。**迷ったら「在る」にする**(K だけと断言するのは確実なページだけ)。
    色の命令が全部 R=G=B(誤差 1/2000 まで)で、画像・シェーディング・パターンが無ければ無い。"""
    for s in pi.streams:
        f = o.facts(s)
        for op, (r, g, b) in f.rgb:
            if max(abs(r - g), abs(g - b), abs(r - b)) > 0.0005:
                return True, f'obj{s} の {r:g} {g:g} {b:g} {op}'
        for op, v in f.cmyk:
            if max(v[:3]) > 0:
                return True, f'obj{s} の CMYK 命令'
        for (r, g, b) in f.sc3:
            if max(abs(r - g), abs(g - b), abs(r - b)) > 0.0005:
                return True, f'obj{s} の 3数 sc'
        for im in f.inline:
            cs = str(im.get('CS', im.get('ColorSpace', '')))
            if cs not in ('G', 'DeviceGray') and not im.get('IM', im.get('ImageMask', False)):
                return True, f'インライン画像 {cs}'
    for im in pi.images:
        if im.mask:
            continue
        if im.cls != {'GRAY'}:
            return True, f'画像 obj{im.xref} {im.w}x{im.h}'
    if pi.shadings:
        return True, f'無彩色と言い切れないシェーディング {pi.shadings}個'
    return False, ''


# ---------------------------------------------------------------------------
# 5 PDF/X-4 の形
# ---------------------------------------------------------------------------

NS = {
    'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'pdfxid': 'http://www.npes.org/pdfx/ns/id/',
    'pdf': 'http://ns.adobe.com/pdf/1.3/',
    'xmp': 'http://ns.adobe.com/xap/1.0/',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'xmpMM': 'http://ns.adobe.com/xap/1.0/mm/',
}


def xmp_get(root: ET.Element, ns: str, local: str) -> str | None:
    """XMP の値。要素でも rdf:Description の属性でも書ける(どちらも正しい XMP)ので両方探す。
    dc:title のように rdf:Alt / rdf:Seq の中に書かれるものは、最初の rdf:li の字を返す"""
    q = '{%s}%s' % (NS[ns], local)
    for el in root.iter():
        if q in el.attrib:
            return el.attrib[q]
        if el.tag == q:
            li = el.find('.//{%s}li' % NS['rdf'])
            if li is not None:
                return (li.text or '').strip()
            return (el.text or '').strip()
    return None


def parse_pdf_date(s: str) -> datetime | None:
    m = re.match(r"D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?([Zz+-])?(\d\d)?'?(\d\d)?'?", str(s))
    if not m:
        return None
    y, mo, d, h, mi, se = (int(x) if x else dflt for x, dflt in zip(m.groups()[:6], (0, 1, 1, 0, 0, 0)))
    tz = timezone.utc
    if m.group(7) in ('+', '-'):
        from datetime import timedelta
        off = timedelta(hours=int(m.group(8) or 0), minutes=int(m.group(9) or 0))
        tz = timezone(off if m.group(7) == '+' else -off)
    try:
        return datetime(y, mo, d, h, mi, se, tzinfo=tz)
    except ValueError:
        return None


def parse_iso_date(s: str) -> datetime | None:
    try:
        d = datetime.fromisoformat(s.strip().replace('Z', '+00:00'))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def rect_of(v) -> tuple[float, float, float, float] | None:
    v = deref(v)
    if not isinstance(v, list) or len(v) != 4:
        return None
    try:
        a = [float(deref(x)) for x in v]
    except Exception:
        return None
    return (min(a[0], a[2]), min(a[1], a[3]), max(a[0], a[2]), max(a[1], a[3]))


def inside(a, b, tol=NEST_TOL) -> bool:
    """a が b の中に入っている"""
    return a[0] >= b[0] - tol and a[1] >= b[1] - tol and a[2] <= b[2] + tol and a[3] <= b[3] + tol


class Sub:
    """pdfx 項目の中の小さな判定を1行ずつ並べる"""

    def __init__(self, it: Item):
        self.it = it

    def ok(self, label: str, detail: str = ''):
        self.it.lines.append(f'  ok  {label}' + (f' … {detail}' if detail else ''))

    def ng(self, label: str, detail: str):
        self.it.lines.append(f'  NG  {label} … {detail}')
        self.it.fail(f'{label}: {detail}')

    def warn(self, label: str, detail: str):
        self.it.lines.append(f'  ??  {label} … {detail}')
        self.it.notes.append(f'{label}: {detail}')


def check_pdfx(cx: Ctx) -> Item:
    it = Item('pdfx')
    sub = Sub(it)
    t = cx.out
    reader = t.reader
    sw = t.sweep()
    root = reader.trailer['/Root'].get_object()
    raw = t.raw

    # --- ヘッダ・暗号・ID ---
    # [出典 ISO 15930-7: PDF/X-4 は PDF 1.6 を土台とし、1.6 より新しい版は不可。Ghostscript は X-4 で CompatibilityLevel を 1.6 に固定する]
    m = re.match(rb'%PDF-(\d)\.(\d)', raw[:16])
    if not m:
        sub.ng('ヘッダの版', '先頭が %PDF-x.y でない')
    else:
        ver = (int(m.group(1)), int(m.group(2)))
        cv = deref(root.get('/Version'))
        cver = None
        if cv is not None:
            mm = re.match(r'(\d)\.(\d)', str(cv).lstrip('/'))
            cver = (int(mm.group(1)), int(mm.group(2))) if mm else None
        if ver > (1, 6):
            sub.ng('ヘッダの版が 1.6 以下', f'%PDF-{ver[0]}.{ver[1]}')
        elif cver and cver > (1, 6):
            sub.ng('Catalog の /Version が 1.6 以下', f'/Version /{cver[0]}.{cver[1]}')
        else:
            sub.ok('ヘッダの版が 1.6 以下', f'%PDF-{ver[0]}.{ver[1]}' + (f'、/Version {cver[0]}.{cver[1]}' if cver else ''))
    if '/Encrypt' in reader.trailer or t.mu.is_encrypted:
        sub.ng('暗号化なし', 'trailer に /Encrypt')
    else:
        sub.ok('暗号化なし')
    ids = deref(reader.trailer.get('/ID'))
    # [出典 PDF/X-4: trailer の /ID は必須(2つの文字列)。X-4 は更新の履歴を /ID と XMP の DocumentID/VersionID で追う]
    if isinstance(ids, list) and len(ids) == 2 and all(len(deref(x)) > 0 for x in ids):
        sub.ok('trailer に /ID(2つ)')
    else:
        sub.ng('trailer に /ID(2つ)', f'/ID={ids!r}'[:80])

    # --- OutputIntents ---
    ois = deref(root.get('/OutputIntents'))
    gts = []
    if isinstance(ois, list):
        for x in ois:
            d = deref(x)
            if isinstance(d, dict) and str(deref(d.get('/S'))) == '/GTS_PDFX':
                gts.append(d)
    if not gts:
        sub.ng('Catalog の /OutputIntents に /S /GTS_PDFX', 'OutputIntent が無い' if not ois else f'{len(ois)}個あるが GTS_PDFX が無い')
    else:
        d = gts[0]
        # [出典 PDF/X-4 6.7.2: GTS_PDFX の OutputIntent は1つ以上。複数あれば同じ印刷条件を指すこと]
        sub.ok('OutputIntent /S /GTS_PDFX', f'{len(gts)}個')
        oci = deref(d.get('/OutputConditionIdentifier'))
        if oci is None or not str(oci).strip():
            sub.ng('OutputConditionIdentifier', '無い・空')
        else:
            sub.ok('OutputConditionIdentifier', str(oci))
        # [出典 PDF/X-4 6.7.3: 印刷条件が ICC 登録簿に載っていなければ /DestOutputProfile が必須、/Info も付ける。
        #  載っているなら DestOutputProfile は省ける。スタジオは常に埋め込む方針なので DestOutputProfile を必須にして調べる]
        dp = deref(d.get('/DestOutputProfile'))
        if not isinstance(dp, dict) or not hasattr(dp, 'get_data'):
            sub.ng('DestOutputProfile', '無い・ストリームでない')
        else:
            n = _idnum(dict.get(d, '/DestOutputProfile'))
            try:
                nn = int(dp.get('/N'))
            except Exception:
                nn = None
            data = t.stream(n) if n else dp.get_data()
            if nn != 4:
                sub.ng('DestOutputProfile が N=4', f'/N={nn}')
            else:
                sub.ok('DestOutputProfile が N=4', f'obj{n}')
            hdr_ok = len(data) > 128 and data[36:40] == b'acsp'
            if not hdr_ok:
                sub.ng('DestOutputProfile が ICC として読める', f'{len(data)}バイト、先頭に acsp が無い')
            else:
                cls, space, major = data[12:16], data[16:20], data[8]
                # [出典 PDF/X-4 6.7.3: 出力プロファイルは ICC の出力機器(prtr)か、色空間(GRAY/RGB/CMYK)のもの。版は ICC.1:2001-04(v2.x)か ICC.1:2004(v4.x)]
                if cls != b'prtr' or space != b'CMYK' or major not in (2, 4):
                    sub.ng('DestOutputProfile の種類', f'クラス {cls!r}、色空間 {space!r}、版 {major}(prtr・CMYK・v2/v4 のはず)')
                else:
                    sub.ok('DestOutputProfile の種類', f'prtr・CMYK・v{major}')
            if cx.args.icc:
                want = Path(cx.args.icc).read_bytes()
                if hashlib.sha256(data).hexdigest() == hashlib.sha256(want).hexdigest():
                    sub.ok('DestOutputProfile の中身が --icc と同じ', f'SHA-256 {hashlib.sha256(data).hexdigest()[:16]}…')
                else:
                    sub.ng('DestOutputProfile の中身が --icc と同じ',
                           f'埋め込み {len(data)}バイト {hashlib.sha256(data).hexdigest()[:16]}… ≠ {len(want)}バイト {hashlib.sha256(want).hexdigest()[:16]}…')
        if d.get('/Info') is None:
            sub.warn('OutputIntent の /Info', '無い。[要確認] 登録簿に載らない条件では付けるのが決まりだが、載っている名前なら省ける')

    # --- XMP ---
    meta = deref(root.get('/Metadata'))
    xroot = None
    xmp: dict[str, str | None] = {}
    if not isinstance(meta, dict) or not hasattr(meta, 'get_data'):
        sub.ng('XMP(Catalog の /Metadata)', '無い')
    else:
        try:
            xdata = t.stream(_idnum(dict.get(root, '/Metadata')) or 0) or meta.get_data()
            xroot = ET.fromstring(xdata)
            sub.ok('XMP が XML として読める', f'{len(xdata)}バイト')
        except Exception as e:  # noqa: BLE001
            sub.ng('XMP が XML として読める', str(e)[:80])
        if xroot is not None:
            if str(deref(meta.get('/Subtype'))) != '/XML' or str(deref(meta.get('/Type'))) != '/Metadata':
                sub.ng('XMP の /Type /Metadata /Subtype /XML', f'{deref(meta.get("/Type"))} {deref(meta.get("/Subtype"))}')
            need = [('pdfxid', 'GTS_PDFXVersion'), ('pdf', 'Trapped'), ('xmp', 'CreateDate'), ('xmp', 'ModifyDate'),
                    ('xmp', 'MetadataDate'), ('dc', 'title'), ('xmpMM', 'DocumentID'), ('xmpMM', 'VersionID'),
                    ('xmpMM', 'RenditionClass')]
            for ns, loc in need:
                xmp[f'{ns}:{loc}'] = xmp_get(xroot, ns, loc)
            # [出典 PDF/X-4 6.7.5: XMP に pdfxid:GTS_PDFXVersion="PDF/X-4"。X-4 は更新の同一性のため xmpMM:DocumentID/VersionID/RenditionClass も要る
            #  (Ghostscript の PDF/X-4 の XMP と callas の X-4 の検査項目)]
            v = xmp['pdfxid:GTS_PDFXVersion']
            if v == 'PDF/X-4':
                sub.ok('XMP pdfxid:GTS_PDFXVersion', v)
            else:
                sub.ng('XMP pdfxid:GTS_PDFXVersion が PDF/X-4', repr(v))
            v = xmp['pdf:Trapped']
            if v in ('True', 'False'):
                sub.ok('XMP pdf:Trapped(True か False)', v)
            else:
                sub.ng('XMP pdf:Trapped が True か False', repr(v))
            for k in ('xmp:CreateDate', 'xmp:ModifyDate', 'xmp:MetadataDate'):
                v = xmp[k]
                if v and parse_iso_date(v):
                    sub.ok(f'XMP {k}', v)
                else:
                    sub.ng(f'XMP {k}', f'{v!r}(無い・日付として読めない)')
            for k in ('dc:title', 'xmpMM:DocumentID', 'xmpMM:VersionID', 'xmpMM:RenditionClass'):
                v = xmp[k]
                if v:
                    sub.ok(f'XMP {k}', v[:60])
                else:
                    sub.ng(f'XMP {k}', '無い・空')

    # --- Info ---
    info = deref(reader.trailer.get('/Info'))
    if not isinstance(info, dict):
        sub.ng('Info 辞書', '無い')
    else:
        tr = str(deref(info.get('/Trapped')))
        if tr in ('/True', '/False'):
            sub.ok('Info /Trapped(/True か /False)', tr)
        else:
            sub.ng('Info /Trapped が /True か /False', f'{tr}(/Unknown や無しは X-4 では不可)')
        # [出典 PDF/X-4: Info の Title・CreationDate・ModDate。X-1a では Title 必須。X-4 は XMP に写しがあれば足りるが、
        #  食い違いは不可(Info と XMP の ModDate・Title は同じに)]
        for k in ('/Title', '/CreationDate', '/ModDate'):
            if info.get(k) is None or not str(deref(info.get(k))).strip():
                sub.ng(f'Info {k}', '無い・空')
            else:
                sub.ok(f'Info {k}', str(deref(info.get(k)))[:50])
        if xroot is not None:
            tx = xmp.get('dc:title')
            ti = str(deref(info.get('/Title')) or '')
            if tx is not None and ti and tx != ti:
                sub.ng('Info /Title と XMP dc:title が同じ', f'Info「{ti[:30]}」 XMP「{tx[:30]}」')
            elif tx is not None and ti:
                sub.ok('Info /Title と XMP dc:title が同じ')
            trx = xmp.get('pdf:Trapped')
            if trx and tr in ('/True', '/False') and ('/' + trx) != tr:
                sub.ng('Info /Trapped と XMP pdf:Trapped が同じ', f'Info {tr} XMP {trx}')
            elif trx and tr in ('/True', '/False'):
                sub.ok('Info /Trapped と XMP pdf:Trapped が同じ')
            for ik, xk in (('/CreationDate', 'xmp:CreateDate'), ('/ModDate', 'xmp:ModifyDate')):
                di = parse_pdf_date(str(deref(info.get(ik)) or ''))
                dx = parse_iso_date(xmp.get(xk) or '')
                if di and dx:
                    if abs((di - dx).total_seconds()) > 1:
                        sub.ng(f'Info {ik} と XMP {xk} が同じ', f'Info {di.isoformat()} XMP {dx.isoformat()}')
                    else:
                        sub.ok(f'Info {ik} と XMP {xk} が同じ')
        gv = deref(info.get('/GTS_PDFXVersion'))
        # [要確認] X-1a/X-3 は Info に GTS_PDFXVersion を要求する。X-4 は XMP に移したので、資料が割れている(src/press/pdfx.ts の冒頭の 4)。
        # 書く側(既定。pdfx.ts の WRITE_INFO_PDFX_VERSION = true): Info に PDF/X-4 が要る。書かない側: Info に在れば咎める
        if cx.args.info_pdfx_version == 'write':
            if gv is None:
                sub.ng('Info /GTS_PDFXVersion が PDF/X-4', '無い(書く設定)')
            elif str(gv) != 'PDF/X-4':
                sub.ng('Info /GTS_PDFXVersion', f'{gv!r}(PDF/X-4 のはず)')
            else:
                sub.ok('Info /GTS_PDFXVersion', 'PDF/X-4')
        elif gv is not None:
            sub.ng('Info /GTS_PDFXVersion が無い', f'{gv!r} が残っている(書かない設定)')
        else:
            sub.ok('Info /GTS_PDFXVersion が無い(書かない設定)')

    # --- 箱(各ページ) ---
    no_tb, both, bad_nest, bad_crop, bad_num = [], [], [], [], []
    for i, page in enumerate(reader.pages):
        no = i + 1
        mb = rect_of(page.mediabox and [page.mediabox.left, page.mediabox.bottom, page.mediabox.right, page.mediabox.top])
        tb, ab = rect_of(page.get('/TrimBox')), rect_of(page.get('/ArtBox'))
        bb, cb = rect_of(page.get('/BleedBox')), rect_of(page.get('/CropBox'))
        # [出典 PDF/X-4 6.1.1(ISO 15930-7): TrimBox か ArtBox のどちらか一方が必須。両方在るのは不可]
        if tb is None and ab is None:
            no_tb.append(no)
        if tb is not None and ab is not None:
            both.append(no)
        eff_bb = bb or cb or mb
        inner = tb or ab
        if mb is None or any(r is not None and (r[2] <= r[0] or r[3] <= r[1]) for r in (mb, tb, ab, bb, cb)):
            bad_num.append(no)
            continue
        if inner is not None and not inside(inner, eff_bb):
            bad_nest.append(f'p{no}: TrimBox {tuple(round(x, 2) for x in inner)} が BleedBox {tuple(round(x, 2) for x in eff_bb)} の外')
        if bb is not None and not inside(bb, mb):
            bad_nest.append(f'p{no}: BleedBox が MediaBox の外')
        # [要確認] CropBox の決まり。PDF の規格では「CropBox は MediaBox の内側」。PDF/X は「BleedBox は CropBox の内側かそれと同じ」とは
        #  書いていないが、Acrobat・Ghent の検査は「CropBox が TrimBox/BleedBox より小さいと、見える範囲が箱に届かない」ことを咎める。
        #  スタジオは CropBox を書かない(MediaBox と同じ)方針なので、書いてあれば「MediaBox の内側で BleedBox を含む」ことを求める
        if cb is not None:
            if not inside(cb, mb):
                bad_crop.append(f'p{no}: CropBox が MediaBox の外')
            elif not inside(eff_bb if bb else (tb or ab), cb):
                bad_crop.append(f'p{no}: CropBox {tuple(round(x, 2) for x in cb)} が BleedBox/TrimBox を含まない')
    n = len(reader.pages)
    if no_tb:
        sub.ng('全ページに TrimBox(か ArtBox)', f'無いページ {fmt_pages(no_tb)}(全 {n} ページ中 {len(no_tb)})')
    else:
        sub.ok('全ページに TrimBox(か ArtBox)', f'{n} ページ')
    if both:
        sub.ng('TrimBox と ArtBox は両方持たない', f'両方在るページ {fmt_pages(both)}')
    else:
        sub.ok('TrimBox と ArtBox は両方持たない')
    if bad_num:
        sub.ng('箱が正しい長方形', f'ページ {fmt_pages(bad_num)}')
    if bad_nest:
        sub.ng('箱の入れ子(TrimBox ⊆ BleedBox ⊆ MediaBox)', '; '.join(bad_nest[:4]) + (f' …他{len(bad_nest) - 4}' if len(bad_nest) > 4 else ''))
    else:
        sub.ok('箱の入れ子(TrimBox ⊆ BleedBox ⊆ MediaBox)')
    if bad_crop:
        sub.ng('CropBox の決まり[要確認]', '; '.join(bad_crop[:3]))
    else:
        sub.ok('CropBox が無いか、MediaBox の内側で BleedBox を含む')

    # --- 注釈・動作・埋め込み・OCG ---
    annots: Counter = Counter()
    annot_pages: dict[str, list[int]] = defaultdict(list)
    for i, page in enumerate(reader.pages):
        an = deref(page.get('/Annots'))
        if isinstance(an, list):
            for a in an:
                d = deref(a)
                st = str(deref(d.get('/Subtype'))) if isinstance(d, dict) else '?'
                if st != '/PrinterMark':
                    annots[st] += 1
                    annot_pages[st].append(i + 1)
    # [出典 PDF/X-4 6.? 注釈: 印刷されうる注釈は版面に影響するので、スタジオは PrinterMark 以外を一切入れない方針(X-4 は
    #  BleedBox の外の注釈を許すなど X-1a より緩いが、リンクは印刷所の工程で意味が無く、動作も禁止(下)なので外す)]
    if annots:
        sub.ng('注釈が無い(PrinterMark 以外)', ', '.join(f'{k} {v}個(ページ {fmt_pages(annot_pages[k])})' for k, v in annots.items()))
    else:
        sub.ok('注釈が無い(PrinterMark 以外)')
    js = sorted(set(sw.keys.get('/JS', []) + sw.keys.get('/JavaScript', [])))
    if js:
        sub.ng('JavaScript が無い', f'obj {head(js)}')
    else:
        sub.ok('JavaScript が無い')
    acts = [a for a in sw.actions]
    openact = sw.keys.get('/OpenAction', [])
    aa = sw.keys.get('/AA', [])
    if acts or openact or aa:
        c = Counter(a['S'] for a in acts)
        sub.ng('動作(Action)が無い', f'{dict(c)} obj {head(sorted(set(a["obj"] for a in acts)))}' +
               (f' /OpenAction obj {head(openact)}' if openact else '') + (f' /AA obj {head(aa)}' if aa else ''))
    else:
        sub.ok('動作(Action)が無い')
    emb = sorted(set(sw.keys.get('/EmbeddedFiles', []) + sw.keys.get('/EF', [])))
    if emb:
        sub.ng('埋め込みファイルが無い', f'obj {head(emb)}')
    else:
        sub.ok('埋め込みファイルが無い')
    # [出典 PDF/X-4 は透明・ICC に加え OCG(レイヤー)も許す。ここでの「無い」はスタジオの方針(入稿に隠れた層を持ち込まない)]
    if sw.ocg or sw.keys.get('/OCProperties'):
        sub.ng('OCG(レイヤー)が無い(スタジオの方針。X-4 の規格は許す)', f'obj {head(sorted(set(sw.ocg)))}')
    else:
        sub.ok('OCG(レイヤー)が無い')
    forb = {k: v for k, v in sw.keys.items() if k not in ('/JS', '/JavaScript', '/OpenAction', '/AA', '/EmbeddedFiles', '/EF')}
    if forb:
        sub.ng('その他の禁止の鍵が無い', '; '.join(f'{FORBIDDEN_KEYS[k]}({k}) obj {head(sorted(set(v)), 4)}' for k, v in forb.items()))
    else:
        sub.ok('その他の禁止の鍵が無い', '動画・音・3D・OPI・参照 XObject・ページ切り替え・XFA')
    if sw.ps_xobj:
        sub.ng('PostScript XObject が無い', f'obj {head(sw.ps_xobj)}')
    if sw.external:
        sub.ng('外部ファイルを指すストリームが無い(/F)', f'obj {head(sw.external)}')

    # --- フォント ---
    # [出典 PDF/X-4 6.3: 全フォントを埋め込む。Type3 は字の形を PDF に持つので可。標準14書体も埋め込みが要る]
    unemb = [f for f in sw.fonts if f['emb'] is False]
    if unemb:
        sub.ng('フォントが全部埋め込み', f'{len(unemb)}個が非埋め込み: ' + head([f'obj{f["obj"]} {f["base"]}' for f in unemb]))
    else:
        c = Counter(f['sub'] for f in sw.fonts)
        sub.ok('フォントが全部埋め込み(Type3 は字の形を持つので可)', f'{len(sw.fonts)}個 {dict(c)}')

    # --- 透明のグループ ---
    # [出典 PDF/X-4 6.? 透明: ページの /Group /CS は出力の色空間(DeviceGray/DeviceCMYK か、出力 ICC)。DeviceRGB のままは不可。
    #  9/27 の試作で Ghostscript が /DeviceRGB のまま残すのを確認]
    badg = [g for g in sw.groups if g['cls'] & {'RGB', 'LAB'}]
    nog = [g for g in sw.groups if g['cs'] is None]
    if badg:
        sub.ng('透明のグループの /CS が DeviceRGB でない', f'{len(badg)}個が RGB: ' + head([f'obj{g["obj"]}{"(ページ)" if g["page"] else ""}' for g in badg]))
    else:
        sub.ok('透明のグループの /CS が DeviceRGB でない', f'グループ {len(sw.groups)}個')
    if nog:
        sub.warn('透明のグループに /CS が無い', f'{len(nog)}個(obj {head([g["obj"] for g in nog], 4)})。[要確認] 無いとビューアが既定(RGB)で合成する')

    # --- フィルタ・転送関数 ---
    # [出典 PDF/X-4: LZWDecode は使わない(X-1a/X-3 と同じ)。JPXDecode は X-4 では許されるが色空間・SMaskInData に制限が在る。
    #  スタジオは JPX を作らないので、在れば落とす(厳しめ)]
    if sw.filters.get('/LZWDecode'):
        sub.ng('LZWDecode が無い', f'obj {head(sw.filters["/LZWDecode"])}')
    else:
        sub.ok('LZWDecode が無い')
    if sw.filters.get('/JPXDecode'):
        sub.ng('JPXDecode が無い(厳しめ。[要確認] X-4 は制限つきで許す)', f'obj {head(sw.filters["/JPXDecode"])}')
    else:
        sub.ok('JPXDecode が無い')
    if sw.filters.get('/Crypt'):
        sub.ng('Crypt フィルタが無い', f'obj {head(sw.filters["/Crypt"])}')
    # [出典 PDF/X-1a/-3/-4: ExtGState の /TR は不可(/Identity は可)、/TR2 は /Default のみ。ハーフトーンに TransferFunction・HalftoneName を持たせない]
    if sw.transfer:
        sub.ng('転送関数・ハーフトーンの制限', '; '.join(f'obj{x["obj"]} {x["key"]}={x["v"]}' for x in sw.transfer[:4]))
    else:
        sub.ok('転送関数(/TR /TR2)・ハーフトーンの制限')
    return it


# ---------------------------------------------------------------------------
# 6 箱の寸法
# ---------------------------------------------------------------------------

def best_shift(lo: np.ndarray, lt: np.ndarray, r: int) -> tuple[int, int, float, float]:
    """変換前(lo)と変換後(lt)を重ねて、一番合うずらし幅を探す。返り値 (dx, dy, 0ずらしの誤差, 最良の誤差)。
    lt を (dx, dy) だけずらして lo に重ねる。0 ずらしが最良と並ぶなら (0,0) を優先する。"""
    h, w = min(lo.shape[0], lt.shape[0]), min(lo.shape[1], lt.shape[1])
    a = blur3(lo[:h, :w])
    b = blur3(lt[:h, :w])
    if h < 4 * r or w < 4 * r:
        return 0, 0, 0.0, 0.0
    core = a[r:h - r, r:w - r]
    e0 = float(np.abs(core - b[r:h - r, r:w - r]).mean())
    best = (0, 0, e0)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            e = float(np.abs(core - b[r + dy:h - r + dy, r + dx:w - r + dx]).mean())
            if e < best[2] - 1e-6:
                best = (dx, dy, e)
    return best[0], best[1], e0, best[2]


def check_boxes(cx: Ctx) -> Item:
    it = Item('boxes')
    t, o = cx.out, cx.orig
    a = cx.args
    tw, th = a.trim_mm
    bt, bb, bo, bg = a.bleed_mm   # 天・地・小口・ノド
    reader = t.reader
    bad_size, bad_trim, bad_bleed = [], [], []
    rows = []
    for i, page in enumerate(reader.pages):
        no = i + 1
        # ノドの側。1ページ目が --first-gutter の側で、以後交互(縦組みは右綴じなので 1ページ目のノドは右、横組みは左)
        gutter_right = (a.first_gutter == 'right') == (no % 2 == 1)
        bl, br = (bo, bg) if gutter_right else (bg, bo)
        ew, eh = (tw + bl + br) * MM, (th + bt + bb) * MM
        mb = rect_of([page.mediabox.left, page.mediabox.bottom, page.mediabox.right, page.mediabox.top])
        tb = rect_of(page.get('/TrimBox'))
        bbx = rect_of(page.get('/BleedBox')) or rect_of(page.get('/CropBox')) or mb
        mw, mh = mb[2] - mb[0], mb[3] - mb[1]
        rows.append((no, mw / MM, mh / MM))
        if abs(mw - ew) > BOX_TOL or abs(mh - eh) > BOX_TOL:
            bad_size.append(f'p{no}: MediaBox {mw / MM:.3f}x{mh / MM:.3f}mm(期待 {ew / MM:.3f}x{eh / MM:.3f}mm、差 {abs(mw - ew) / MM:.3f}・{abs(mh - eh) / MM:.3f}mm)')
        if tb is None:
            bad_trim.append(f'p{no}: TrimBox が無い')
        else:
            # PDF の座標は y が上向き。TrimBox の左・右・下・上の塗り足しを MediaBox から測る
            got = (tb[0] - mb[0], mb[2] - tb[2], tb[1] - mb[1], mb[3] - tb[3])  # 左 右 下(地) 上(天)
            exp = (bl * MM, br * MM, bb * MM, bt * MM)
            tw_got, th_got = tb[2] - tb[0], tb[3] - tb[1]
            if any(abs(g - e) > BOX_TOL for g, e in zip(got, exp)) or abs(tw_got - tw * MM) > BOX_TOL or abs(th_got - th * MM) > BOX_TOL:
                bad_trim.append(
                    f'p{no}(ノド{"右" if gutter_right else "左"}): TrimBox の塗り足し 左{got[0] / MM:.3f} 右{got[1] / MM:.3f} 地{got[2] / MM:.3f} 天{got[3] / MM:.3f}mm、'
                    f'大きさ {tw_got / MM:.3f}x{th_got / MM:.3f}mm'
                    f'(期待 左{exp[0] / MM:.3f} 右{exp[1] / MM:.3f} 地{exp[2] / MM:.3f} 天{exp[3] / MM:.3f}mm、{tw}x{th}mm)')
        if any(abs(x - y) > BOX_TOL for x, y in zip(bbx, mb)):
            bad_bleed.append(f'p{no}: BleedBox {tuple(round(x, 2) for x in bbx)} ≠ MediaBox {tuple(round(x, 2) for x in mb)}')
    n = len(rows)
    for m in bad_size[:6]:
        it.fail('MediaBox の大きさ ' + m)
    if len(bad_size) > 6:
        it.fail(f'MediaBox の大きさが期待と違うページが他に {len(bad_size) - 6} 枚')
    for m in bad_trim[:6]:
        it.fail('TrimBox の位置 ' + m)
    if len(bad_trim) > 6:
        it.fail(f'TrimBox の位置が期待と違うページが他に {len(bad_trim) - 6} 枚')
    for m in bad_bleed[:4]:
        it.fail('BleedBox ≠ MediaBox ' + m)
    if not bad_size:
        ws = [r[1] for r in rows]
        hs = [r[2] for r in rows]
        it.lines.append(f'MediaBox が全 {n} ページ 仕上がり {tw}x{th}mm + 塗り足し(天{bt} 地{bb} 小口{bo} ノド{bg}) にちょうど(許す差 {BOX_TOL_MM}mm)。実物 {min(ws):.3f}〜{max(ws):.3f} x {min(hs):.3f}〜{max(hs):.3f}mm')
    if not bad_trim:
        it.lines.append(f'TrimBox の位置が全ページで期待どおり(1ページ目のノドは {"右" if a.first_gutter == "right" else "左"}、以後交互)')
    if not bad_bleed:
        it.lines.append('BleedBox = MediaBox')
    # 絵の中身が箱からずれていない
    if o is None:
        it.notes.append('--orig が無いので、絵の中身のずれは見ていない')
        return it
    if o.n_pages != t.n_pages:
        it.fail('ページ数が変換前と違うので、絵のずれを見られない')
        return it
    shifted = []
    maxe = 0.0
    for i in range(t.n_pages):
        lo, lt = cx.luma('orig', i), cx.luma('out', i)
        dx, dy, e0, eb = best_shift(lo, lt, SHIFT_RADIUS)
        maxe = max(maxe, e0)
        # 「ずれている」= 0 ずらしより明らかに(25% 以上)よく合う、かつ 0 ずらしの誤差が小さくない
        if (dx, dy) != (0, 0) and e0 > 0.5 and eb < e0 * 0.75:
            shifted.append(f'p{i + 1}: 変換後を({dx:+d},{dy:+d})px(72dpi)ずらすと一番合う。誤差 {e0:.2f}→{eb:.2f}')
    for m in shifted[:6]:
        it.fail('絵の中身が箱からずれている ' + m)
    if not shifted:
        it.lines.append(f'絵の中身が、変換前の左上と変換後の MediaBox の左上で同じ位置(±{SHIFT_RADIUS}px のずらしで探して 0 が最良。0ずらしの誤差の最大 {maxe:.2f}/255)')
    return it


# ---------------------------------------------------------------------------
# 7 画像が劣化していない
# ---------------------------------------------------------------------------

def check_images(cx: Ctx) -> Item:
    it = Item('images')
    t, o = cx.out, cx.orig
    sw = t.sweep()
    imgs = sw.images
    it.lines.append(f'変換後の画像 {len(imgs)}個(うち文字や型抜きの ImageMask {sum(1 for i in imgs if i["mask"])})')
    # 変換前の DCT をそのまま通したもの(同じバイト列)は、再圧縮ではないので許す
    orig_dct: set[str] = set()
    if o is not None:
        for im in o.sweep().images:
            if '/DCTDecode' in im['filters']:
                try:
                    orig_dct.add(hashlib.sha1(o.mu.xref_stream_raw(im['obj'])).hexdigest())
                except Exception:
                    pass
    dct = [i for i in imgs if '/DCTDecode' in i['filters']]
    recompressed, passthru = [], []
    for im in dct:
        h = hashlib.sha1(t.mu.xref_stream_raw(im['obj'])).hexdigest()
        (passthru if h in orig_dct else recompressed).append(im)
    # [理由: JPEG に圧縮し直すと、読み込んだ絵が劣化する(利用者と決めたこと 2026-10-01)。画像は Flate のまま。
    #  変換前の JPEG をバイト列のまま通しただけなら劣化はしないので許す(K だけの DeviceGray の JPEG などで起きる)]
    if recompressed:
        by: Counter = Counter((i['w'], i['h'], i['cs'] or '') for i in recompressed)
        it.fail(f'JPEG(DCTDecode)に圧縮し直された画像が {len(recompressed)}個: ' +
                head([f'obj{i["obj"]} {i["w"]}x{i["h"]} {i["cs"] or ""}' for i in recompressed]) +
                (f'。大きさ別 {dict(by)}' if len(by) < 6 else ''))
    else:
        it.lines.append('JPEG に圧縮し直された画像は無い')
    if passthru:
        it.notes.append(f'変換前の JPEG をバイト列のまま通した画像が {len(passthru)}個(劣化なし): ' + head([f'obj{i["obj"]} {i["w"]}x{i["h"]}' for i in passthru], 4))
    if o is None:
        it.notes.append('--orig が無いので、画素数は比べていない')
        return it
    # 画素数: 変換前の画像の (幅,高さ) ごとの数が、変換後にも在る(縮められていない)
    co: Counter = Counter((i['w'], i['h']) for i in o.sweep().images)
    ct: Counter = Counter((i['w'], i['h']) for i in imgs)
    missing = []
    for k, v in co.items():
        if ct.get(k, 0) < 1:
            near = min(ct, key=lambda x: abs(x[0] * x[1] - k[0] * k[1])) if ct else None
            missing.append(f'{k[0]}x{k[1]}(変換前 {v}個、変換後 0個' + (f'、いちばん近いのは {near[0]}x{near[1]}' if near else '') + ')')
    if missing:
        it.fail('変換前に在った大きさの画像が変換後に無い(縮められた・消えた): ' + '; '.join(missing[:6]))
    else:
        it.lines.append(f'変換前の画像の大きさ {len(co)}種(計{sum(co.values())}個)が、すべて変換後にも在る')
    extra = [k for k in ct if k not in co]
    if extra:
        it.notes.append('変換後だけに在る大きさ(マスクの分割など): ' + head([f'{k[0]}x{k[1]}' for k in extra], 5))
    # ページごとの画像の大きさの並びも見る(同じ画像が別のページに移っていないか)
    pm = []
    for po, pt in zip(o.pages(), t.pages()):
        so = sorted((i.w, i.h) for i in po.images if not i.mask)
        st = sorted((i.w, i.h) for i in pt.images if not i.mask)
        if so != st:
            pm.append(f'p{po.no}: 変換前 {so[:3]} → 変換後 {st[:3]}')
    if pm:
        it.notes.append('ページが貼る画像の大きさが変わった(マスクの付け替えなら問題ない): ' + head(pm, 3))
    return it


# ---------------------------------------------------------------------------
# 検査の道具そのものが嘘をつかないかの確認(罠の自己点検)
# ---------------------------------------------------------------------------

def canary_k_only(icc_path: str | None) -> tuple[bool, str]:
    """K だけの命令(`0 g` と `0 0 0 1 k`)を、OutputIntent(CMYK の ICC)つきの PDF にして描き、
    C=M=Y=0 と出ることを確かめる。出なければ、この道具の描き方が信用できない。"""
    d = pymupdf.open()
    p = d.new_page(width=100, height=100)
    p.insert_text((5, 5), '.')
    d.update_stream(p.get_contents()[0], b'0 g 10 10 20 20 re f 0 0 0 1 k 50 10 20 20 re f 0 0 0 0.5 k 10 50 20 20 re f')
    if icc_path and Path(icc_path).exists():
        cat = d.pdf_catalog()
        icx = d.get_new_xref()
        d.update_object(icx, '<< /N 4 /Alternate /DeviceCMYK >>')
        d.update_stream(icx, Path(icc_path).read_bytes())   # 生で渡す(deflate は保存時に掛かる。二重に圧縮すると ICC が読めなくなる)
        oi = d.get_new_xref()
        d.update_object(oi, f'<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (X) /DestOutputProfile {icx} 0 R >>')
        d.xref_set_key(cat, 'OutputIntents', f'[{oi} 0 R]')
    data = d.tobytes(deflate=True)
    d.close()
    d = pymupdf.open('pdf', data)
    pm = d[0].get_pixmap(matrix=pymupdf.Matrix(1, 1), colorspace=pymupdf.csCMYK, alpha=False)
    a = np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, 4)
    px = [tuple(int(x) for x in a[100 - 20, 20]), tuple(int(x) for x in a[100 - 20, 60]), tuple(int(x) for x in a[100 - 60, 20])]
    ok = all(c[0] == 0 and c[1] == 0 and c[2] == 0 for c in px) and px[0][3] == 255 and px[1][3] == 255
    return ok, f'0 g → {px[0]}、0 0 0 1 k → {px[1]}、0 0 0 0.5 k → {px[2]}(C,M,Y,K の 0..255)'


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

CHECKS = {
    'content': check_content, 'rgb': check_rgb, 'ink': check_ink, 'konly': check_konly,
    'pdfx': check_pdfx, 'boxes': check_boxes, 'images': check_images,
}


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='入稿データ(変換後の PDF)を PyMuPDF・pypdf で別に検査する',
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--kind', required=True, choices=['body-gray', 'body-cmyk', 'cover-cmyk'])
    ap.add_argument('--orig', help='変換前の PDF')
    ap.add_argument('--out', required=True, help='変換後の PDF')
    ap.add_argument('--trim', required=True, help='仕上がり(塗り足しを除く) 幅x高さ mm 例 148x210')
    ap.add_argument('--bleed', required=True, help='塗り足し 天,地,小口,ノド mm 例 3.2,3.2,3.2,0')
    ap.add_argument('--first-gutter', choices=['left', 'right'], default='right', help='1ページ目のノドの側(縦組みは right)')
    ap.add_argument('--ink-limit', type=float, default=300.0, help='インクの総量の上限 %% (cmyk のとき)')
    ap.add_argument('--icc', help='色の基準の ICC(OutputIntent の中身と照らす)')
    ap.add_argument('--json', help='結果を JSON でも書き出す')
    ap.add_argument('--only', help='項目を絞る(content,rgb,ink,konly,pdfx,boxes,images か 1〜7)')
    ap.add_argument('--quiet', action='store_true', help='通った項目の中身を省く')
    ap.add_argument('--info-pdfx-version', choices=['write', 'omit'], default='write',
                    help='Info の /GTS_PDFXVersion を write=要る(既定。pdfx.ts の WRITE_INFO_PDFX_VERSION と同じ向き)・omit=在れば咎める')
    a = ap.parse_args(argv)
    try:
        w, h = a.trim.lower().split('x')
        a.trim_mm = (float(w), float(h))
        b = [float(x) for x in a.bleed.split(',')]
        assert len(b) == 4
        a.bleed_mm = tuple(b)
    except Exception:
        ap.error('--trim は 148x210、--bleed は 3.2,3.2,3.2,0 の形で')
    return a


def main(argv=None) -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    a = parse_args(argv)
    # ICC を切る。切らないと PyMuPDF は OutputIntent を通して、K だけの黒を4色で描く(docstring の「罠」)
    pymupdf.TOOLS.set_icc(False)
    ok, detail = canary_k_only(a.icc)
    print(f'[道具の自己点検] OutputIntent つきの K だけの PDF を描く(ICC を切った状態): {"通った" if ok else "落ちた"} … {detail}')
    if not ok:
        print('  この検査の描き方が信用できないので止める(PyMuPDF の版や ICC の扱いが変わった可能性)')
        return 2
    only = None
    if a.only:
        names = []
        for x in a.only.split(','):
            x = x.strip()
            names.append(ITEM_ORDER[int(x) - 1] if x.isdigit() else x)
        bad = [n for n in names if n not in CHECKS]
        if bad:
            print(f'--only の名前が違う: {bad}(使えるのは {",".join(ITEM_ORDER)})')
            return 2
        only = names
    out = Pdf(Path(a.out))
    orig = Pdf(Path(a.orig)) if a.orig else None
    cx = Ctx(a, orig, out)
    cx.render_ink = {}      # type: ignore[attr-defined]
    cx.direct_ink = {}      # type: ignore[attr-defined]
    print(f'種類 {a.kind} / 変換後 {Path(a.out).name}({out.n_pages}ページ)' + (f' / 変換前 {Path(a.orig).name}({orig.n_pages}ページ)' if orig else ''))
    results: list[Item] = []
    # ink は konly より先に回す(描いた絵と直読みを共有する)
    for key in ITEM_ORDER:
        if only is not None and key not in only:
            continue
        results.append(CHECKS[key](cx))
    failed = [r for r in results if r.status == 'fail']
    for r in results:
        mark = {'pass': '通った', 'fail': '落ちた', 'skip': '飛ばした'}[r.status]
        print(f'\n[{mark}] {ITEM_TITLE[r.key]}')
        if r.status == 'fail':
            for p in r.problems:
                print(f'  ! {p}')
        if not (a.quiet and r.status == 'pass'):
            for ln in r.lines:
                print(f'  {ln}' if not ln.startswith('  ') else ln)
        for n in r.notes:
            print(f'  * {n}')
    print('\n--- まとめ ---')
    for r in results:
        print(f'  {"通った" if r.status == "pass" else "落ちた" if r.status == "fail" else "飛ばした"}  {ITEM_TITLE[r.key]}')
    print(f'  → {"全部通った" if not failed else str(len(failed)) + '項目が落ちた: ' + ', '.join(r.key for r in failed)}')
    if a.json:
        Path(a.json).write_text(json.dumps({
            'kind': a.kind, 'out': str(a.out), 'orig': str(a.orig) if a.orig else None,
            'canary': {'ok': ok, 'detail': detail},
            'passed': not failed, 'items': [r.to_json() for r in results],
        }, ensure_ascii=False, indent=1), encoding='utf-8')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
