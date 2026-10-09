# -*- coding: utf-8 -*-
"""紙面を機械で検査する。**目で見て「直った」と言わないための道具。**

## なぜ在るか

区切り線(hr)がページの端に単独で落ちる不具合を 2026-08-20 に「直した」と報告したのに、
ユーザーの画面ではまだ太い線が残っていた。前の担当は PDF だけを見て
「線は指定より細く引かれている」と結論したが、**画面では 1px(0.75pt)に切り上げられていた**。
目と手で確かめるかぎり、この取りこぼしはまた起きる。だから機械で測る。

このリポジトリで最初の検査スクリプト。**別の検査を足すならこのファイルに足す。**

## 何を測るか

### 紙(PDF)

1. **区切り線の太さ** … 指定(本文の 1/20。文庫9ptなら 0.45pt)どおりに引かれているか。
   border で引くと Blink が 1画素に切り上げるので、太さは箱の寸法で作ってある
   (src/typeset/css.ts の hr を見ること)。切り上げが戻っていれば、ここで落ちる。
2. **区切り線の置き場所** … 線だけがページの頭・末尾に取り残されていないか。
   線の前後(縦組みなら行の進む向き=左右)に本文の字があるかどうかで判定する。
3. **行末寄せ(署名)** … あとがき末尾の署名が版面の行末(縦組みなら地、横組みなら右)に
   着いているか。原稿の `>>` 記法(src/importers/txt.ts の detectEndAlignLine)の結果を見る。
4. **場面転換の見た目**(2026-08-21 追加) … 原稿の `---` は
   1行アキ / ＊ / ＊　＊　＊ / 罫 の4つから選べる(既定は1行アキ)。
   4つとも**同じ物差し**で測る — 切れ目の前の本文行から、あとの本文行まで、
   **行送りの何本ぶん進んだか**(1行アキ=2本 / ＊=3本 / 罫=3本)。
   記号は版面の行方向の中央に来ているかも見る。行送りは PDF から実測する。
   **1行アキがページの端に落ちていないかは、紙を見ても分からない**
   (空白は目に見えない)ので、切り離さない指定が効いているかは CSS の側で見る。

### 画面(ブラウザ)— 2026-08-21 に足した

**紙だけ見ていたから取りこぼした。** 署名の行末寄せは紙では版面の地に着いていたのに、
利用者の画面では行頭のままだった。紙は `src/sample.ts` を毎回読み直すのに対し、
画面が映していたのは IndexedDB に残った古い写しで、**別の原稿を組んでいた**。
紙をいくら測っても出てこない食い違いなので、ブラウザの側も回す。

4. **生プレビューの行末寄せ** … アプリと同じ CoreViewer に同じ組版HTMLを食わせ、
   署名の段落の「行末」側と字の並びの差を px で測る(scripts/preview-probe.ts)。
5. **入口3つのゼロリセット** … 新規作成／続けて作る／サンプルを見る のあとに、
   前の本が1か所も残っていないか。印をつけたデータを流し込み、状態を総なめして
   道つきで数える(scripts/store-probe.ts)。消える前の断り・別の本への画像の
   流れ込み・保存された古いサンプルの組み直しも、同じ回で見る。
6. **組み直しを繰り返しても溜まらないか** … 同じ本を何度も組み直して、
   1回あたりの秒数・窓に付いた監視の数・**捨てたのに生きているビューアの数**を並べる
   (scripts/rebuild-probe.ts)。「プレビューが10分以上」「2ページ目でフリーズ」
   (2026-08-21 ユーザー報告)は**使っているうちに溜まる**型なので、1回組むだけの検査では
   出てこなかった。**秒数を見ていても出てこない**(実測: 12回組み直しても 0.87秒のまま)。
   効くのは残っているビューアの数のほう。
   同じ回で、**版面を display:none にしたまま組むと止まること**も確かめる
   (アプリが「見えていないあいだは組まない」を持っている理由そのもの)。
7. **長い本で固まらないか** … サンプル原稿を9回ぶん積んだ259ページの本で
   **アプリごと立ち上げ**、誌面が見えるまでの秒数を測る(scripts/app-probe.tsx)。
   「297頁で3分くらいで画面が見えて、全部で10分以上」(2026-08-21 ユーザー報告)は、
   **組版の速さではなくアプリの見せ方**の問題だった(裸の CoreViewer なら
   259ページの1ページ目は 0.26秒で出る)。だからここだけは React ごと本物を載せる。
   同じ回で、文字の大きさを続けて変えたときに**組み直しが溜まらないか**も見る。
   アプリは起動すると必ず入口(トップ)から始まるので、probe は利用者と同じく
   ［この本の作業に入る］を押して入り、**そこから**秒数を測る(2026-09-29)。

## 使い方

    python scripts/check-typeset.py              # 縦組みのサンプルを検査(紙+画面)
    python scripts/check-typeset.py --yoko       # 横組みで検査
    python scripts/check-typeset.py --dense      # 区切り線を段落のあいだに詰めて検査
    python scripts/check-typeset.py --only-screen # 画面だけ(速い)
    python scripts/check-typeset.py --no-screen  # 紙だけ(これまでどおり)
    python scripts/check-typeset.py --keep       # 中間ファイル(HTML/PDF)を残す
    python scripts/check-typeset.py            # 縦組みのサンプルを検査(場面転換は既定の1行アキ)
    python scripts/check-typeset.py --yoko     # 横組みで検査
    python scripts/check-typeset.py --dense    # 区切り線を段落のあいだに詰めて検査
    python scripts/check-typeset.py --scene rule   # 場面転換を「罫」にして検査
    python scripts/check-typeset.py --scene all    # 4つの見た目をぜんぶ順に検査(組版を4回通す)
    python scripts/check-typeset.py --keep     # 中間ファイル(HTML/PDF)を残す
    python scripts/check-typeset.py --chrome "C:\\path\\to\\chrome.exe"

終了コードは 0=全部通った / 1=どれか落ちた。

## 環境で詰まったところ(2026-08-20)

- **Chrome の在り処を渡さないと落ちる。** このマシンには puppeteer 用の Chrome が
  入っておらず、Vivliostyle CLI が `spawn UNKNOWN` で止まる。
  既定では `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe` などを順に探し、
  見つからなければ `--chrome` で渡してもらう。
- **CLI はリポジトリ直下で回すと vite build まで走る**(vite.config.ts を見つけるため)。
  HTML を一時フォルダへ置き、そこを作業フォルダにして回すと走らない。
- **PDF の中では、縦組みでも字は「1文字=1つの正方形」で入っている**(PyMuPDF の rawdict)。
  だから縦組みでも横組みでも、同じやり方で行の頭と末尾が測れる。
- PyMuPDF(`pip install pymupdf`)が要る。

## 環境で詰まったところ(2026-08-21・画面の検査を足したとき)

- **headless Chrome の `--dump-dom` では待てない。** `--virtual-time-budget=60000` を
  付けても、測り終わる前に DOM を吐いて出ていく(title が PROBE-RUNNING のまま)。
  組版もフォントの読み込みも本物の時間で走るので、仮想時間では進まない。
  小さな受け口を立てて、**測り終わった側から POST させる**ようにした。
- **開発サーバーを 127.0.0.1 で待ってはいけない。** vite は `localhost` に bind し、
  この環境では localhost が **::1 にしか解決しない**。127.0.0.1 は繋がらないうえに
  「拒否」ではなく待たされるので、猶予がまるごと溶ける。名前で引かせること。
- **ブラウザは使い捨てのプロファイルで開く。** store-probe は IndexedDB を書き換える。
  ふだん使いのブラウザで開くと、その人が作りかけの本が消える。
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    sys.exit('PyMuPDF が要ります: pip install pymupdf')

ROOT = Path(__file__).resolve().parent.parent
PT2MM = 25.4 / 72

# 本文の文字サイズ(pt)。既定値(src/models/project.ts の defaultSettings)と同じ。
# 区切り線の太さと長さは、この値から出す
FONT_PT = 9.0
HR_WEIGHT_PT = FONT_PT / 20   # 指定の太さ 0.45pt
HR_LEN_PT = FONT_PT * 6       # 指定の長さ 54pt(6字ぶん)
# 太さの許容。**紙の PDF は 1/8 画素(0.094pt)の升目に乗る。**
#
# 実測(区切り線を40本ちらした版): 指定 0.45pt(=0.6px)に対し、
# 出てくるのは 0.375pt(0.5px)か 0.4688pt(0.625px)のどちらか。
# **線が紙のどこに落ちたかで、隣の升目に振れる。** だから±1升は許す。
# 落としたいのは 0.75pt(=1px)、つまり**画素への切り上げが戻ったとき**。
HR_WEIGHT_MIN = 0.36   # 0.375pt(升目1つぶん細い側)まで許す
HR_WEIGHT_MAX = 0.60   # 0.75pt(1画素への切り上げ)はここで落ちる
# 行末に着いているかの許容(pt)。字の箱の丸めぶんだけ見る
ALIGN_TOL = 0.5
# 画面(生プレビュー)で行末に着いているかの許容(px)。
# 実測では 0.000px(縦組み・文庫9pt)で、丸めの振れを見込んでも 0.5px あれば足りる。
# **行頭のままなら数百px ずれる**ので、境目に迷う値ではない
SCREEN_ALIGN_TOL_PX = 0.5
# ブラウザの検査を待つ上限(秒)。30ページを組んでページを送るので、それなりに掛かる
PROBE_TIMEOUT_S = 180

# ---- 組み直しを繰り返す検査(2026-08-21) ----
#
# **何回組み直すか。** 1回 0.9秒前後(サンプル39ページ・実測)なので、
# 5回まわしても5秒。溜まっているかどうかは1回目と最後の差で出る
REBUILD_ROUNDS = 5
# 最後の1回が最初の1回の何倍まで許すか。
# **実測では最後のほうが速い**(1回目は書体の読み込みぶん重い。倍率 0.66〜0.80)。
# だから 2.0 はかなり緩い。**秒数はもともとこの不具合を捕まえられない** —
# 落とすのは下の「監視」と「亡霊」のほう
REBUILD_RATIO_MAX = 2.0
# 窓に残ってよい resize の監視の数。**面は2枚で頭打ち**(VivliostylePreview の bufsRef)。
# 作り直す作りに戻したら、ここが組み直しの回数ぶん増える(実測: 12回で12本)
REBUILD_LISTENERS_MAX = 2
# 版面を display:none にしたまま組んだ回を、何秒待って「止まった」と見なすか。
# ふだんが 0.9秒なので、15秒はもう別の世界
REBUILD_HIDDEN_TIMEOUT_MS = 15000

# ---- 長い本で固まらないか(2026-08-22) ----
#
# ユーザー報告「297頁で3分くらいで画面が見えるようになって、全部が見えるようになるまでに
# さらに10分以上」。**アプリごと立ち上げて測る**(scripts/app-probe.tsx)。
# CoreViewer を裸で回すだけでは何も出てこない — 259ページでも1ページ目は 0.26秒で出る
# (scripts/long-probe.ts の実測)。効くのは「アプリが、いつ紙を見せるか」のほう。
#
# **原稿は git に入っているサンプルを積んで作る。** 実原稿(非公開の資料フォルダの body.docx)は
# 上げられないので、誰の手元でも同じ本になるように scripts/long-doc.ts で9回ぶん積む。
LONG_SCALE = 9
# 誌面が見えるまでの上限(秒)。**ここがこの検査の本体。**
# 実測(2026-08-22・headless Chrome・サンプル9倍=259ページ):
#   直す前 14.8秒（全部組み上がるまで覆ったままだった）
#   直した後 3.2秒（1ページ目ができた時点で紙を出す）
# ユーザーと決めた目安が「10秒以内」なので、そこを境にする。
# 3.2秒に対して3倍の余裕があり、機械の速さの違いでは落ちない
LONG_VISIBLE_MAX_S = 10.0
# 立ち上がりのあいだ、押しても返ってこない時間の上限(ミリ秒)。
# 実測は 0〜354ミリ秒。組版は25ミリ秒動いて1ミリ秒休む作りなので、
# 秒の単位で埋まりはじめたら何かが変わっている
LONG_STALL_MAX_MS = 2000
# 組み上がったあとに文字の大きさを何回変えるか。**続けて触ったときが本番**
LONG_RETOUCH = 2
# そのとき組んでよい冊数。触った回数 + 1(ページ数の書き戻しでノドの段が変わるぶん)。
# **溜まっていないこと**を見る。実測: 2回触って2冊
LONG_RETOUCH_LOADS_EXTRA = 1
# この検査だけ、結果を待つ上限を分ける(秒)。**ほかの probe と同じ 180秒では足りない。**
# 立ち上がり → サイズを2回 → 背景を5回 → 奥付、と4つを順に測り、そのつど「静かになるまで
# 6秒」「落ち着いてから3秒」を待つ作りなので、速い機械でも1分半は掛かる。
# 実測(2026-09-29・headless Chrome・268ページ): 1本で 146〜161秒。
# 180秒だと、機械が少し混んだだけで「結果が返りませんでした」になる
LONG_PROBE_TIMEOUT_S = 420

# これより近い字は「同じ行の一部」とみなす(ルビ・縦中横は行の中で少しずれて立つ)。
# 行送りの下限は 10pt(帯の入力の下限)なので、その半分を境にする
LINE_MERGE_PT = 5.0

# あとがき末尾の署名。サンプル原稿(src/sample.ts)の最後の行
SIGNATURE = '雨宿文'

# ---- 場面転換の見た目(2026-08-21) ----
#
# 原稿の `---` をどう組むかを選べるようにした(models/project.ts の SceneBreakId)。
# 一般文芸・純文学の商業出版は「1行アキだけ」が主流なので、**既定は blank**。
#
# **測り方は4つとも同じ。** 「切れ目の前にある最後の本文行から、
# 切れ目のあとの最初の本文行まで、行送りの何本ぶん進んだか」を数える:
#
#   1行アキ … 2.0本(本文1行 + 空いた1行)
#   ＊     … 3.0本(本文1行 + 前後半行ずつ+記号の1行 = 2行)
#   罫     … 3.0本(本文1行 + 前後のアキ込みで2行。もとからこの設計)
#
# **行送りは PDF から実測する**(判型ごとの既定値を書き写さない)。
# 同じページに立っている行の間隔で、いちばん多い値がその本の行送り
SCENES = ('blank', 'star', 'stars', 'rule')
SCENE_LABEL = {'blank': '1行アキ', 'star': '＊', 'stars': '＊　＊　＊', 'rule': '罫'}
# 前の本文行 → 次の本文行 が、行送りの何本ぶんか
SCENE_SPAN = {'blank': 2.0, 'star': 3.0, 'stars': 3.0, 'rule': 3.0}
# 記号の見た目のとき、その行に並ぶ字(全角空白は PDF から拾えないので数だけ持つ)
SCENE_MARK_COUNT = {'star': 1, 'stars': 3}
SCENE_MARK = '＊'
# サンプル原稿(src/sample.ts)で `---` の**直後**に来る文。ここを目印に切れ目を探す。
# ユーザー報告の「P14 の線」がまさにこの1本(第一章 帰りの電車 → 数日後の商店街)
SCENE_ANCHOR = '数日後の休みの日'
# 行送り何本ぶん、の許容(本)。字の箱の丸めぶんだけ見る。
# 0.5本ずれたら別の組み方(半行ぶんの取りこぼし)なので、その手前で落ちる
SCENE_SPAN_TOL = 0.08
# 記号が版面の中央に来ているかの許容(pt)。実測は 0.02pt 未満(下の check_scene の出力)
SCENE_CENTER_TOL = 1.0

CHROME_CANDIDATES = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
]


def find_chrome(given: str | None) -> str | None:
    if given:
        return given
    for c in CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    return shutil.which('chrome') or shutil.which('google-chrome')


def run(cmd: list[str], cwd: Path | None = None) -> None:
    """外部コマンド。落ちたら出力ごと見せて止める(黙って通り過ぎない)"""
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', shell=(os.name == 'nt'))
    if p.returncode != 0:
        print(' '.join(cmd))
        print(p.stdout[-3000:])
        print(p.stderr[-3000:])
        sys.exit(f'コマンドが失敗しました(終了コード {p.returncode})')


def build_pdf(work: Path, vertical: bool, chrome: str | None, dense: bool = False,
              scene: str = 'blank') -> Path:
    """サンプル原稿 → 組版HTML → PDF。組版の道は本番と同じものを通す"""
    html = work / 'check.html'
    pdf = work / 'check.pdf'

    # 1) TypeScript の組版器を node から呼べる形にまとめる(vite の ssr ビルド)
    run(['npx', 'vite', 'build', '--ssr', 'scripts/render-check.ts',
         '--outDir', 'dist/check', '--logLevel', 'warn'], cwd=ROOT)

    # 2) 組版HTMLを書き出す
    env = dict(os.environ)
    env['WM'] = 'v' if vertical else 'h'
    env['DENSE'] = '1' if dense else '0'
    # 場面転換の見た目(1行アキ / ＊ / ＊　＊　＊ / 罫)。render-check.ts が受ける
    env['SCENE'] = scene
    p = subprocess.run(['node', str(ROOT / 'dist/check/render-check.js'), str(html)],
                       cwd=str(ROOT), capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=env, shell=(os.name == 'nt'))
    if p.returncode != 0:
        print(p.stdout, p.stderr)
        sys.exit('組版HTMLの書き出しに失敗しました')
    print(p.stdout.strip())

    # 3) PDF 化。**作業フォルダは一時フォルダ**(リポジトリ直下だと vite build まで走る)
    cmd = ['npx', '--yes', '@vivliostyle/cli', 'build', html.name, '-o', pdf.name]
    if chrome:
        cmd += ['--executable-browser', chrome]
    run(cmd, cwd=work)
    return pdf


# ---- PDF の読み取り ----

def page_chars(page) -> list[tuple[str, tuple[float, float, float, float]]]:
    """ページの字を (文字, 箱) で全部返す。空白は捨てる"""
    out = []
    for blk in page.get_text('rawdict')['blocks']:
        for ln in blk.get('lines', []):
            for sp in ln['spans']:
                for ch in sp['chars']:
                    if ch['c'].strip() == '':
                        continue
                    out.append((ch['c'], tuple(ch['bbox'])))
    return out


def line_end_of_page(chars, vertical: bool) -> float | None:
    """そのページの**版面の行末**。行ごとの末尾をそろえ、いちばん多い値を採る。

    **10字より短い行は数えない。** ノンブルと柱は版面の外にあり、
    段落の終わりの行は途中で切れているので、どちらも版面の行末を指さない。
    ぶら下げ(hanging-punctuation)で1字ぶん外へ出る行は残るが、少数なので多数決で落ちる
    """
    lines = defaultdict(list)
    for _, b in chars:
        key = round(b[0], 0) if vertical else round(b[1], 0)  # 縦組みは x が行
        lines[key].append(b)
    ends = [round(max(b[3] for b in v) if vertical else max(b[2] for b in v), 1)
            for v in lines.values() if len(v) >= 10]
    if not ends:
        return None
    return Counter(ends).most_common(1)[0][0]


def lines_of_page(chars, vertical: bool):
    """そのページの行を、**読む順に**並べて返す。戻りは (行の位置, 行の字) の並び。

    縦組みは x が行を決め、行は**右から左へ**進む(だから x の大きい順)。
    横組みは y が行を決め、上から下へ進む。
    行の位置は、その行の字の値の中央値で採る(1字だけ外れても動かないように)。

    **ルビと縦中横は同じ行の中で少しずれた場所に立つ**(実測: ルビは親文字の
    2〜5pt 隣、縦中横は組み直された箱の中)。座標だけでまとめると、
    ルビの付いた行が2本にも3本にも見えてしまい、行の間隔が測れない。
    **行送りの下限は 10pt**(帯の入力の下限)なので、その半分より近いものは
    同じ行の一部とみなしてまとめ直す
    """
    groups = defaultdict(list)
    for c, b in chars:
        groups[round(b[0], 0) if vertical else round(b[1], 0)].append((c, b))
    raw = []
    for v in groups.values():
        vals = sorted(b[0] if vertical else b[1] for _, b in v)
        raw.append((vals[len(vals) // 2], v))
    raw.sort(key=lambda t: t[0])
    out: list = []
    for pos, v in raw:
        if out and pos - out[-1][0] < LINE_MERGE_PT:
            # 位置は字数の多いほう(親文字の側)を採る。ルビに引っぱられないように
            keep = out[-1][0] if len(out[-1][1]) >= len(v) else pos
            out[-1] = (keep, out[-1][1] + v)
        else:
            out.append((pos, list(v)))
    out.sort(key=lambda t: -t[0] if vertical else t[0])
    return out


def line_text(line, vertical: bool) -> str:
    """行の字を、**字の進む向きに**つないだもの。縦組みは上から下、横組みは左から右。

    ルビも混ざる(lines_of_page が同じ行にまとめるため)ので、
    目印にする文はルビの付いていない場所から選ぶこと
    """
    _, v = line
    return ''.join(c for c, _ in sorted(v, key=lambda t: t[1][1] if vertical else t[1][0]))


def line_pitch(lines) -> float | None:
    """その本の行送り(pt)。**PDF から実測する。**

    隣り合う行の間隔のうち、いちばん多い値。1行アキや見出しで飛んでいる箇所は
    多数決で落ちる。0.1pt に丸めてから数える(字の箱の丸めで下位桁が揺れるため)
    """
    if len(lines) < 3:
        return None
    gaps = [round(abs(lines[i + 1][0] - lines[i][0]), 1) for i in range(len(lines) - 1)]
    gaps = [g for g in gaps if g > 0.5]
    if not gaps:
        return None
    return Counter(gaps).most_common(1)[0][0]


def body_chars(chars, span, vertical: bool):
    """柱とノンブルを落として、**版面の中の字だけ**にする。

    **縦組みの本でも、柱とノンブルは横に流れて組まれている**(2026-08-21 実測。
    PyMuPDF の line dir は本文も柱も (1,0) だが、柱の字は y を揃えて x が増える。
    大きさは 6.75pt / 7.65pt で本文の 9pt より小さい)。
    そのため行ごとにまとめると、**本文の行に柱の字が1字ずつ紛れ込む** —
    「＊」だけの行が「＊空」に見え、記号の行として数えられなくなる
    (実測: 区切りを詰めた原稿で ＊ が38個あるのに33個しか拾えなかった)。

    版面の外に立つ字は本文ではないので、行に沿った向きの band から外れたものを捨てる。
    余地は本文1字ぶん(FONT_PT)。ぶら下げで版面の外へ出る約物は残り、
    15pt 下に組まれる柱は落ちる(実測: 版面の地 385.6pt / 柱の天 400.65pt)
    """
    if not span:
        return chars
    lo, hi = span
    i0, i1 = (1, 3) if vertical else (0, 2)
    return [(c, b) for c, b in chars if b[i1] > lo - FONT_PT and b[i0] < hi + FONT_PT]


def doc_line_spans(doc, vertical: bool) -> dict[int, tuple[float, float]]:
    """**本ぜんたい**の版面の行頭と行末(行に沿った向きの両端)を、**表と裏で別々に**。

    行ごとの先頭・末尾をそろえ、全ページぶんを合わせていちばん多い値を採る。
    10字より短い行は数えない — ノンブルと柱は版面の外、段落の終わりの行は
    途中で切れているので、どちらも端を指さない。
    段落の1字下げは行頭を1字ぶん動かすが、下げていない行のほうが多いので多数決で落ちる。

    **1ページずつ測ってはいけない(2026-08-21 実測)。** 章の書き出しのページや、
    区切りを詰めた原稿(--dense)のページには、端まで届く行が数本しか立たない。
    そのページだけで多数決を取ると版面の端を取り違え、
    正しく中央に置かれている記号を「ずれている」と言い出す
    (実測: 記号の位置は 214.51pt で一定なのに、ページごとの多数決は
     160.60 / 175.25 / 225.50pt と暴れた)。

    **かわりに、表(奇数)と裏(偶数)は分けて数える(2026-08-21 実測)。**
    ノドは小口より広いので、**版面はページの表裏で左右にずれる。**
    横組みではそのずれが行に沿った向きに乗り、全ページを一緒に数えると
    多数決が拮抗して(実測: 行末が 267.3pt=185本 と 264.3pt=181本)、
    版面の中央が 1.5pt ずれる。**中央に置いた記号がそのぶん「ずれている」ことになる。**
    縦組みでは行が天地に沿って進み、天地は表裏で動かないので起きない
    """
    i0, i1 = (1, 3) if vertical else (0, 2)
    starts: dict[int, Counter] = {0: Counter(), 1: Counter()}
    ends: dict[int, Counter] = {0: Counter(), 1: Counter()}
    for pno in range(doc.page_count):
        side = pno % 2
        for _, v in lines_of_page(page_chars(doc[pno]), vertical):
            if len(v) < 10:
                continue
            starts[side][round(min(b[i0] for _, b in v), 1)] += 1
            ends[side][round(max(b[i1] for _, b in v), 1)] += 1
    out = {}
    for side in (0, 1):
        if starts[side] and ends[side]:
            out[side] = (starts[side].most_common(1)[0][0], ends[side].most_common(1)[0][0])
    return out


def count_lines(chars, vertical: bool) -> int:
    """そのページに立っている行の数。縦組みは x、横組みは y でまとめる"""
    return len({round(b[0], 0) if vertical else round(b[1], 0) for _, b in chars})


def thin_rects(page):
    """細長い塗り = 罫線。区切り線・下線・取り消し線・奥付の罫がここに入る"""
    out = []
    for d in page.get_drawings():
        r = d['rect']
        w, h = r.width, r.height
        if min(w, h) < 3 and max(w, h) > 5:
            out.append(r)
    return out


# ---- 検査 ----

def check_css(html_path: Path) -> list[str]:
    """組版CSSそのものを見る検査。**紙の PDF では見分けられないものがあるため。**

    区切り線の太さは、border で引くと画面では 1画素(0.75pt)に切り上げられる。
    ところが**印刷経路の画素は 1/2px なので、紙の PDF では 0.375pt にしかならない**。
    つまり PDF をいくら測っても、border で引き直されたことに気づけない
    (前回まさにそれで取りこぼした)。
    そこで、線が「箱の寸法」で引かれていることを CSS の側で確かめる。
    ここが落ちたら src/typeset/css.ts の hr を見ること
    """
    css = html_path.read_text(encoding='utf-8')
    i = css.find(chr(10) + 'hr {')
    if i < 0:
        return ['組版CSSに hr の指定が見当たらない(src/typeset/css.ts が変わった?)']
    # **コメントは判定に混ぜない。** 「border では切り上げられる」という注意書き自体が
    # border や background の字を含むので、消してから見る(実際にこれで一度すり抜けた)
    rule = re.sub(r'/\*.*?\*/', '', css[i:css.find('}', i)], flags=re.S)
    fails = []
    if not re.search(r'\bbackground\s*:', rule):
        fails.append('区切り線が背景(箱)で引かれていない。border で引くと画面で 1画素に'
                     '切り上げられ、紙の PDF では見分けられない(css.ts の hr を見ること)')
    for m in re.finditer(r'\bborder[-a-z]*\s*:\s*([^;]+)', rule):
        # 太さを持つ border だけを咎める(border: none / border-width: 0 は素通し)
        if re.search(r'(?<![\w.])\d*\.?[1-9]\d*\s*(pt|px|mm|em|rem)', m.group(1)):
            fails.append(f'区切り線が border で引かれている: {m.group(0).strip()}')

    # 場面転換を字で組むときの規則(2026-08-21)。**紙の PDF では見分けられない**ので CSS を見る。
    #
    # 「1行アキがページの頭・末尾に落ちる」は、罫とちがって**紙を見ても分からない** —
    # 空白は目に見えないので、落ちたことも、落ちていないことも測れない。
    # 切れ目を前後の段落から離さない指定(break-before/after/inside: avoid)が
    # 効いているかどうかは、ここでしか確かめられない
    j = css.find(chr(10) + 'p.scene-break {')
    if j < 0:
        fails.append('組版CSSに p.scene-break の指定が見当たらない'
                     '(1行アキ・＊ の組み方。src/typeset/css.ts を見ること)')
    else:
        srule = re.sub(r'/\*.*?\*/', '', css[j:css.find('}', j)], flags=re.S)
        for prop in ('break-before', 'break-after', 'break-inside'):
            if not re.search(rf'\b{prop}\s*:\s*avoid', srule):
                fails.append(f'場面転換が前後の段落から切り離されている({prop}: avoid が無い)。'
                             'ページの頭・末尾に落ちた1行アキは目に見えず、'
                             '場面が変わったことが読者に届かない')
    k = css.find(chr(10) + 'p.scene-break.mark {')
    if k < 0:
        fails.append('組版CSSに p.scene-break.mark の指定が見当たらない(＊ の組み方)')
    elif not re.search(r'\btext-align\s*:\s*center',
                       re.sub(r'/\*.*?\*/', '', css[k:css.find('}', k)], flags=re.S)):
        fails.append('場面転換の記号が中央に寄せられていない(text-align: center が無い)')
    return fails


def check_scene(doc, vertical: bool, scene: str, dense: bool = False) -> list[str]:
    """場面転換(原稿の `---`)が、選んだ見た目のとおりに組まれているか。

    **4つの見た目を同じ物差しで測る。** サンプルの `---` は1本だけなので
    (第一章 帰りの電車 → 数日後の商店街。ユーザー報告の「P14 の線」がこれ)、
    その直後の文を目印に切れ目の場所を突き止め、
    **前の本文行から次の本文行までが行送りの何本ぶんか**を数える。

    測るもの:
      1. 送りの量 … 1行アキ=2.0本 / ＊=3.0本 / 罫=3.0本(SCENE_SPAN)
      2. 置き場所 … 切れ目の前に本文があるか。**1行アキはとくに効く** —
         ページの頭に落ちた空白は目に見えないので、場面が変わったことが読者に届かない
      3. 記号の位置 … ＊ が版面の行方向の中央に来ているか

    **罫の太さはここでは測らない。** thin_rects を使う既存の検査がすでに見ている
    """
    fails: list[str] = []
    marks = SCENE_MARK_COUNT.get(scene, 0)
    where = '天地' if vertical else '左右'
    # 版面は本ぜんたいで1つ(ただし**表と裏で左右にずれる**)。
    # ページごとに測り直すと、行の少ないページで取り違える
    spans = doc_line_spans(doc, vertical)

    # --- 3. 記号(＊)の位置。切れ目の場所とは別に、出てきた記号を全部見る ---
    mark_lines = 0
    if marks:
        for pno in range(doc.page_count):
            page = doc[pno]
            span = spans.get(pno % 2)
            chars = body_chars(page_chars(page), span, vertical)
            lines = lines_of_page(chars, vertical)
            for idx, ln in enumerate(lines):
                if line_text(ln, vertical) != SCENE_MARK * marks:
                    continue
                mark_lines += 1
                # 前後に本文があるか(線と同じ判定。ページの端に取り残されていないか)
                if idx == 0:
                    fails.append(f'P{pno + 1}: 場面転換の記号がページの頭に単独で落ちている')
                if idx == len(lines) - 1:
                    fails.append(f'P{pno + 1}: 場面転換の記号がページの末尾に単独で落ちている')
                if not span:
                    continue
                i0, i1 = (1, 3) if vertical else (0, 2)
                lo = min(b[i0] for _, b in ln[1])
                hi = max(b[i1] for _, b in ln[1])
                got = (lo + hi) / 2
                want = (span[0] + span[1]) / 2
                if abs(got - want) > SCENE_CENTER_TOL:
                    fails.append(
                        f'P{pno + 1}: 場面転換の記号が版面の{where}の中央に来ていない。'
                        f'記号の中央 {got:.2f}pt / 版面の中央 {want:.2f}pt '
                        f'(差 {abs(got - want) * PT2MM:.3f}mm)')
                else:
                    print(f'  P{pno + 1} 記号「{SCENE_MARK * marks}」… 版面の{where}の中央から '
                          f'{abs(got - want) * PT2MM:.4f}mm')
        if mark_lines == 0:
            fails.append('場面転換の記号が1本も見つからない。'
                         'サンプル原稿から --- の行が消えていないか')

    # --- 1・2. 切れ目の前後の送り ---
    #
    # **--dense では測らない。** 段落のあいだに切れ目を機械で差し込んだ原稿なので、
    # 目印の前後がもう本物の並びではない(--dense は置き場所を当てにいく回。
    # 記号の置き場所は上のまとまりが全ページぶん見ている)
    if dense:
        return fails
    for pno in range(doc.page_count):
        page = doc[pno]
        chars = body_chars(page_chars(page), spans.get(pno % 2), vertical)
        lines = lines_of_page(chars, vertical)
        hit = next((i for i, ln in enumerate(lines) if SCENE_ANCHOR in line_text(ln, vertical)), None)
        if hit is None:
            continue
        pitch = line_pitch(lines)
        if not pitch:
            continue
        # 記号の行は本文ではない。1つ戻して「前の本文行」を探す
        prev = hit - 1
        if marks and prev >= 0 and line_text(lines[prev], vertical) == SCENE_MARK * marks:
            prev -= 1
        if prev < 0:
            fails.append(
                f'P{pno + 1}: 場面転換がページの境目に落ちている（切れ目の前に本文が無い）。'
                f'{SCENE_LABEL[scene]}では読者に切れ目が届かない')
            return fails
        moved = abs(lines[hit][0] - lines[prev][0])
        want = SCENE_SPAN[scene]
        if abs(moved / pitch - want) > SCENE_SPAN_TOL:
            fails.append(
                f'P{pno + 1}: 場面転換の送りが {moved / pitch:.3f}行。'
                f'{SCENE_LABEL[scene]}は {want} 行のはず'
                f'（行送り {pitch}pt で実測 {moved:.2f}pt）')
        else:
            print(f'  P{pno + 1} 場面転換「{SCENE_LABEL[scene]}」… 前の行から次の行まで '
                  f'{moved / pitch:.3f}行（行送り {pitch}pt ×{want} = {moved:.2f}pt）')
        return fails

    fails.append(f'場面転換が見つからない（目印「{SCENE_ANCHOR}」が本文に無い）。'
                 'サンプル原稿から --- の行が消えていないか')
    return fails


def check(pdf_path: Path, vertical: bool, dense: bool = False, scene: str = 'blank') -> list[str]:
    doc = fitz.open(pdf_path)
    fails: list[str] = []
    hr_seen = 0
    print(f'  ページ数 {doc.page_count} / 用紙 {doc[0].rect.width:.2f} x {doc[0].rect.height:.2f}pt')

    for pno in range(doc.page_count):
        page = doc[pno]
        chars = page_chars(page)
        n = pno + 1

        # --- 1・2. 区切り線 ---
        # **「罫」を選んだときだけ線が引かれる。**(2026-08-21 に見た目を選べるようにした)
        # ほかの見た目では場面転換に線が無いので、下の判定は check_scene が受け持つ
        for r in (thin_rects(page) if scene == 'rule' else []):
            thick = r.width if vertical else r.height
            length = r.height if vertical else r.width
            # 区切り線は「本文6字ぶんの長さ」で見分ける。下線や取り消し線は長さが文に従う
            if abs(length - HR_LEN_PT) > 1.0:
                continue
            hr_seen += 1
            if not (HR_WEIGHT_MIN <= thick <= HR_WEIGHT_MAX):
                fails.append(
                    f'P{n}: 区切り線の太さが {thick:.4f}pt。指定は {HR_WEIGHT_PT:.4f}pt '
                    f'({thick * PT2MM:.3f}mm / 指定 {HR_WEIGHT_PT * PT2MM:.3f}mm)。'
                    f'1画素(0.75pt)への切り上げが戻っていないか、css.ts の hr を見ること')
            # 線の前後に本文があるか。縦組みは行が右から左へ進むので、
            # 「前」= 線より右、「後ろ」= 線より左
            if vertical:
                before = any(b[0] > r.x1 + 0.5 for _, b in chars)
                after = any(b[2] < r.x0 - 0.5 for _, b in chars)
            else:
                before = any(b[1] > r.y1 + 0.5 for _, b in chars)
                after = any(b[3] < r.y0 - 0.5 for _, b in chars)
            if not before:
                fails.append(f'P{n}: 区切り線がページの頭に単独で落ちている(前に本文が無い)')
            if not after:
                fails.append(f'P{n}: 区切り線がページの末尾に単独で落ちている(後ろに本文が無い)')

        # --- 3. 行末寄せの署名 ---
        #
        # 同じ名前は**大扉と奥付にも出る**(著者名として)。そちらは組版の体裁で置いた字で、
        # 原稿の記法とは関係が無い。本文のページだけを見るために、
        # 「最終ページ(奥付)ではない」ことと「行がじゅうぶんに立っている」ことで絞る
        # (大扉は書名と著者名の2行しか無い)
        # **--dense のときは見ない。** 原稿を機械で書き換えているので、
        # あとがきの組み上がりはもう本物ではない(区切り線の置き場所だけを見る回)
        text = ''.join(c for c, _ in chars)
        if (not dense and SIGNATURE in text and pno < doc.page_count - 1
                and count_lines(chars, vertical) >= 5):
            end = line_end_of_page(chars, vertical)
            sig = [b for c, b in chars if c in SIGNATURE]
            sig_end = max(b[3] if vertical else b[2] for b in sig)
            where = '地' if vertical else '右端'
            if end is None or abs(sig_end - end) > ALIGN_TOL:
                fails.append(
                    f'P{n}: 署名が行末に着いていない。署名の末尾 {sig_end:.2f}pt / '
                    f'版面の{where} {end}pt(差 {abs(sig_end - (end or 0)) * PT2MM:.2f}mm)')
            else:
                print(f'  P{n} 署名「{SIGNATURE}」… 版面の{where}から '
                      f'{abs(sig_end - end) * PT2MM:.3f}mm')

    if scene == 'rule':
        print(f'  区切り線 {hr_seen}本を検査')
    if hr_seen == 0 and scene == 'rule':
        fails.append('区切り線が1本も見つからない。サンプル原稿から --- の行が消えていないか')
    # 場面転換の見た目そのもの(送り・置き場所・記号の位置)
    fails += check_scene(doc, vertical, scene, dense)
    return fails


# ---- 画面(生プレビュー・ストア)の検査 ----
#
# **紙だけ見ていたから取りこぼした。**
#
# 署名の行末寄せは、紙(PDF)では版面の地に着いているのに、利用者の画面では行頭のままだった
# (2026-08-21)。紙は `src/sample.ts` を毎回読み直すが、画面が映すのは IndexedDB に
# 残った古い写しで、**そもそも別の原稿を組んでいた**。
# 紙をいくら測っても、この食い違いは出てこない。
#
# そこでブラウザの側も回す。仕組みは3つ:
#
#   scripts/preview-probe.html … アプリと同じ CoreViewer に同じ組版HTMLを食わせて実測
#   scripts/store-probe.html   … 入口3つのボタンが前の本を消し切っているかを実測
#   scripts/probe-report.ts    … 測り終えた結果をこのスクリプトへ返す
#
# **`--dump-dom` は使えない**(実測: `--virtual-time-budget=60000` でも
# 測り終わる前に DOM を吐いて出ていく)。組版もフォントの読み込みも本物の時間で走るので、
# 仮想時間では待てない。だから受け口を立てて、測り終わった側から POST させる。

def free_port() -> int:
    """空いているポートを1つ借りる。**5173 は使わない**(開発サーバーとぶつかる)"""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return int(s.getsockname()[1])


class _Sink(http.server.BaseHTTPRequestHandler):
    """測定結果の受け口。POST の body をそのまま預かるだけ"""

    received: list[str] = []

    def do_POST(self):  # noqa: N802 (http.server の決まった名前)
        n = int(self.headers.get('Content-Length') or 0)
        _Sink.received.append(self.rfile.read(n).decode('utf-8', 'replace'))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args):
        pass  # 検査の出力を汚さない


def wait_for_http(url: str, timeout: float) -> bool:
    """開発サーバーが応えるまで待つ。

    **127.0.0.1 で待ってはいけない**(2026-08-21 に踏んだ)。
    vite は `localhost` に bind し、この環境では localhost が **::1 にしか解決しない**。
    127.0.0.1 へ繋ぎにいくと接続できず、しかも「拒否」ではなく**待たされる**ので、
    60秒の猶予がまるごと溶けて「サーバーが上がりませんでした」になる。
    名前で引かせれば、IPv4/IPv6 のどちらに bind していても届く
    """
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.3)
    return False


def run_probes(chrome: str | None, work: Path, vertical: bool) -> list[str]:
    """開発サーバーと headless Chrome を立てて、2つの probe を回す"""
    fails: list[str] = []
    if not chrome:
        return ['Chrome が無いので画面の検査を飛ばしました（--chrome で渡してください）']

    vite_port = free_port()
    sink_port = free_port()
    _Sink.received.clear()
    httpd = http.server.HTTPServer(('127.0.0.1', sink_port), _Sink)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    env = dict(os.environ)
    env['PORT'] = str(vite_port)
    vite = subprocess.Popen(
        ['npx', 'vite', '--port', str(vite_port), '--strictPort', '--logLevel', 'error'],
        cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        shell=(os.name == 'nt'))
    profile = work / 'chrome-profile'
    try:
        if not wait_for_http(f'http://localhost:{vite_port}/', 90):
            return [f'開発サーバーが {vite_port} で上がりませんでした']
        wm = 'v' if vertical else 'h'
        probes = [
            ('生プレビューの行末寄せ', f'/scripts/preview-probe.html?wm={wm}&appcss=1',
             PROBE_TIMEOUT_S),
            ('入口3つのゼロリセット', '/scripts/store-probe.html', PROBE_TIMEOUT_S),
            # **アプリと同じ作り(mode=swap)で回す。** 面を2枚だけ作って交互に使う、が
            # いまの VivliostylePreview。最後の1回(hiddenAt)は版面を隠したまま組む
            ('組み直しを繰り返す',
             f'/scripts/rebuild-probe.html?wm={wm}&mode=swap&rounds={REBUILD_ROUNDS}'
             f'&hiddenAt={REBUILD_ROUNDS + 1}&timeout={REBUILD_HIDDEN_TIMEOUT_MS}',
             PROBE_TIMEOUT_S),
            # **アプリごと立ち上げて、長い本で固まらないかを見る。**
            # 裸の CoreViewer では出てこない(288ページでも1ページ目は0.4秒)。
            # 出てくるのは「アプリが、いつ紙を見せるか」のほう
            # paint / colophon: 塗り(背景)の変更が組版0回で映るか・奥付の打鍵が
            # 組版を起こさないか(2026-08-22 に追加。判定は judge_long の末尾)
            ('長い本で固まらないか',
             f'/scripts/app-probe.html?scale={LONG_SCALE}&retouch={LONG_RETOUCH}'
             '&paint=5&colophon=1', LONG_PROBE_TIMEOUT_S),
        ]
        for label, path, timeout_s in probes:
            report = f'http://127.0.0.1:{sink_port}/result'
            url = (f'http://localhost:{vite_port}{path}'
                   f'{"&" if "?" in path else "?"}report={urllib.parse.quote(report)}')
            before = len(_Sink.received)
            # **プロファイルは使い捨て。** store-probe は IndexedDB を書き換えるので、
            # ふだん使いのブラウザで開くと、その人の本が消える
            proc = subprocess.Popen(
                [chrome, '--headless=new', '--disable-gpu', '--no-first-run',
                 '--no-default-browser-check', '--disable-extensions',
                 # **回収を促してから数えるため。** これが無いと「捨てたのに生きている
                 # ビューア」が、ただ回収前なだけのものと見分けられない(実測で踏んだ)
                 '--js-flags=--expose-gc', '--enable-precise-memory-info',
                 f'--user-data-dir={profile}', url],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            end = time.time() + timeout_s
            while len(_Sink.received) == before and time.time() < end:
                time.sleep(0.3)
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
            if len(_Sink.received) == before:
                fails.append(f'{label}: {timeout_s}秒たっても結果が返りませんでした')
                continue
            fails += judge_probe(label, json.loads(_Sink.received[-1]), vertical)
    finally:
        vite.terminate()
        httpd.shutdown()
    return fails


def judge_rebuild(label: str, r: dict) -> list[str]:
    """組み直しを繰り返した結果を読む。

    **落とすのは「秒数」ではなく「溜まったもの」。**
    12回組み直しても1回あたりは 0.87秒のままだった(2026-08-21 実測)。
    それでも窓に付いた監視は 1→12本、捨てたのに生きているビューアは 12個、
    JSヒープは 16→58MB へまっすぐ伸びていた。**そちらを数える。**
    """
    fails: list[str] = []
    rounds = r.get('rounds') or []
    if not rounds:
        return [f'{label}: 1回も組めませんでした（{r.get("note") or r.get("errors")}）']

    shown = [x for x in rounds if not x.get('hidden')]
    hidden = [x for x in rounds if x.get('hidden')]

    for x in shown:
        if not x['done']:
            fails.append(f'{label}: {x["i"]}回目が組み上がりませんでした'
                         f'（{x["sec"]}秒で{x["pages"]}ページのまま）')
    for x in shown:
        print(f'  組み直し {x["i"]}回目 … {x["sec"]}秒 / {x["pages"]}ページ / '
              f'窓の監視 {x["listeners"]}本 / 捨てたのに生きているビューア {x["zombies"]}個 / '
              f'JSヒープ {x["heapMB"]}MB')

    last = shown[-1] if shown else None
    if last:
        if last['listeners'] > REBUILD_LISTENERS_MAX:
            fails.append(
                f'{label}: 窓に付いた大きさの監視が {last["listeners"]}本あります'
                f'（面は2枚のはずなので {REBUILD_LISTENERS_MAX}本まで）。'
                'プレビューがビューアを作り直す作りに戻っていないか見てください')
        if last['zombies'] > 0:
            fails.append(
                f'{label}: 捨てたのに生きているビューアが {last["zombies"]}個あります。'
                'CoreViewer には破棄の口が無いので、作った数だけ残ります'
                '（src/preview/VivliostylePreview.tsx の bufsRef を参照）')
    if r.get('ratio', 0) > REBUILD_RATIO_MAX:
        fails.append(f'{label}: 最後の1回が最初の1回の {r["ratio"]}倍かかっています'
                     f'（{REBUILD_RATIO_MAX}倍まで）')

    watch = r.get('watch') or {}
    if not watch.get('onShow'):
        fails.append(
            f'{label}: 版面が画面へ戻ったことに気づけません（ResizeObserver が鳴らない）。'
            'これが鳴らないと、表紙やAIの工程から戻ってきても組み直しが始まりません')

    # **隠したまま組むと止まること**を確かめる。アプリが「見えていないあいだは組まない」を
    # 持っている理由そのものなので、ここが通ってしまったら番人の要否を考え直すことになる
    for x in hidden:
        if x['done']:
            fails.append(
                f'{label}: 版面を display:none にしたまま組んだのに組み上がりました'
                f'（{x["sec"]}秒 / {x["pages"]}ページ）。Vivliostyle 側が直ったのかもしれません。'
                'だとすれば VivliostylePreview の「見えていないあいだは組まない」は要りません')
        else:
            leader = any('DOMRect' in e for e in x['errors'])
            print(f'  版面を隠したまま組むと … {x["sec"]}秒たっても {x["pages"]}ページで止まる'
                  f'（目次のリーダー罫の例外 {"あり" if leader else "なし"}）'
                  '。だから見えていないあいだは組みません')
    return fails


def judge_long(label: str, r: dict) -> list[str]:
    """長い本をアプリごと立ち上げた結果を読む。

    **見るのは「紙が見えるまで」。** 全部組み上がるのが後ろで続くのは構わない
    (ユーザーと決めた線: 画面が出るまで10秒以内・操作が返ってくること)。

    直す前の実測(サンプル9倍=259ページ・headless Chrome):
      紙が1枚できるまで 3.1秒 / **誌面が見えるまで 14.8秒** / 全部で 15.1秒
      文字の大きさを2回続けて変えて、落ち着くまで 26.1秒
    直したあと:
      紙が1枚できるまで 3.1秒 / **誌面が見えるまで 3.2秒** / 全部で 16.0秒
      文字の大きさを2回続けて変えて、落ち着くまで 14.2秒
    """
    if not r.get('ok'):
        return [f'{label}: {r.get("note") or "立ち上がらなかった"}'
                f'{"／" + "／".join(r.get("errors") or []) if r.get("errors") else ""}']
    fails: list[str] = []
    print(f'  {r.get("chapters")}章の本（{r.get("pages")}ページ）… '
          f'紙が1枚できるまで {r.get("firstPaperSec")}秒 / '
          f'**誌面が見えるまで {r.get("visibleSec")}秒** / '
          f'全部で {r.get("allSec")}秒 / 立ち上がりに組んだ冊数 {r.get("builds")}'
          f'（入口で［この本の作業に入る］を押してから。入口が出るまで {r.get("startShownSec")}秒）')
    print(f'  そのあいだ押しても返ってこなかった回数 {r.get("stalls")}回'
          f'（最長 {r.get("worstMs")}ミリ秒）')
    print(f'  文字の大きさを{r.get("retouchTimes")}回続けて変えて、'
          f'落ち着くまで {r.get("retouchSec")}秒 / 組んだ冊数 {r.get("retouchLoads")}')

    visible = float(r.get('visibleSec') or 0)
    if visible <= 0:
        fails.append(f'{label}: 誌面が最後まで見えませんでした')
    elif visible > LONG_VISIBLE_MAX_S:
        fails.append(
            f'{label}: 誌面が見えるまで {visible}秒かかりました（{LONG_VISIBLE_MAX_S}秒まで）。'
            'VivliostylePreview の「1ページ目ができた時点で紙を出す」(earlyShow) が'
            '効かなくなっていないか見てください')
    if int(r.get('worstMs') or 0) > LONG_STALL_MAX_MS:
        fails.append(
            f'{label}: 立ち上がりのあいだ、{r["worstMs"]}ミリ秒ものあいだ画面が返ってきません'
            f'（{LONG_STALL_MAX_MS}ミリ秒まで）')
    want = int(r.get('retouchTimes') or 0) + LONG_RETOUCH_LOADS_EXTRA
    if int(r.get('retouchLoads') or 0) > want:
        fails.append(
            f'{label}: {r["retouchTimes"]}回触っただけで {r["retouchLoads"]}冊ぶん組んでいます'
            f'（{want}冊まで）。組み直しが溜まっています —'
            'VivliostylePreview の buildingRef（組んでいる面へ重ねる）を見てください')

    # ---- 塗り(背景)の変更が組版なしで映るか(?paint=N。2026-08-22) ----
    # 背景は文字を1文字も動かさないので、組版0回が正解。直す前は回数ぶん組んでいた
    if 'paintLoads' in r:
        print(f'  背景を{r.get("paintChanges")}回続けて変えて … 組んだ冊数 {r["paintLoads"]} / '
              f'画面に映るまで {r.get("paintAppliedMs")}ミリ秒 / '
              f'書き出しに乗る {r.get("exportCarries")}')
        if int(r['paintLoads'] or 0) != 0:
            fails.append(
                f'{label}: 背景(塗り)の変更で {r["paintLoads"]}冊ぶん組み直しています（0が正解）。'
                'App の paintNeutral（塗りを固定した組版HTML）が効いていません')
        if not r.get('paintShown'):
            fails.append(
                f'{label}: 背景を変えたのに画面の描画値が変わっていません。'
                'preview/paint.ts の塗りパッチ（!important の <style>）を見てください')
        applied = [int(x) for x in (r.get('paintAppliedMs') or [])]
        if any(x < 0 for x in applied):
            fails.append(f'{label}: 塗りが画面に映らなかった回があります（{applied}）')
        if not r.get('exportCarries'):
            fails.append(
                f'{label}: ★塗りが書き出し（完全な組版HTML）に乗っていません。'
                'プレビューだけ変わって出力に乗らないのは最悪の事故です — '
                'manuscriptHtml が完全な settings を受けているか見てください')

    # ---- 奥付の文言を打っても組版が走らないか(?colophon=1。2026-08-22) ----
    if 'typingLoads' in r:
        print(f'  奥付に8回打って … 打っているあいだ {r["typingLoads"]}冊 / '
              f'欄を離れてから {r.get("matterLoads")}冊'
              f'（{r.get("matterSettledSec")}秒で落ち着いた）')
        if int(r['typingLoads'] or 0) != 0:
            fails.append(
                f'{label}: 奥付を打っているあいだに {r["typingLoads"]}冊ぶん組んでいます（0が正解）。'
                'data-defer-typeset の栓（App の useDeferHold）が効いていません')
        if int(r.get('matterLoads') or 0) < 1:
            fails.append(
                f'{label}: ★欄を離れても組み直しが走りません。打った文言が紙面に反映されない'
                '（編集の取りこぼし）ことを意味します')
        if int(r.get('matterLoads') or 0) > 1:
            fails.append(
                f'{label}: 欄を離れたあと {r["matterLoads"]}冊も組んでいます（1が正解）')
    if 'colophonError' in r:
        fails.append(f'{label}: {r["colophonError"]}')
    return fails


def judge_probe(label: str, r: dict, vertical: bool) -> list[str]:
    """probe の返した実測値を読む。**数字はそのまま出す** — 通ったときも見せる"""
    fails: list[str] = []
    if r.get('kind') == 'app':  # 長い本をアプリごと
        return judge_long(label, r)
    if 'rounds' in r:  # 組み直しを繰り返す
        return judge_rebuild(label, r)
    if 'aligns' in r:  # 生プレビュー
        if not r.get('ok'):
            return [f'{label}: {r.get("note") or "組み上がらなかった"}'
                    f'{"／" + "／".join(r.get("errors") or []) if r.get("errors") else ""}']
        where = '地' if vertical else '右端'
        # 見えていないページ(display:none)は寸法が全部0になる。実測できたものだけ見る
        found = [a for a in r['aligns'] if a['boxEnd'] != 0]
        if not found:
            return [f'{label}: 行末寄せの段落が1つも見つからない'
                    '（サンプル原稿から >> の行が消えていないか）']
        for a in found:
            if abs(a['gap']) > SCREEN_ALIGN_TOL_PX:
                fails.append(
                    f'{label}: P{a["page"]}「{a["text"]}」が行末に着いていない。'
                    f'段落の箱の{where} {a["boxEnd"]}px / 字の並び {a["inkEnd"]}px'
                    f'（差 {a["gap"]}px・text-align={a["textAlign"]}）')
            else:
                print(f'  画面 P{a["page"]} 署名「{a["text"]}」… 段落の箱の{where}との差 '
                      f'{a["gap"]}px（行頭からは {a["headGap"]}px）')
        print(f'  画面 {r["pages"]}ページを組んで検査')
        return fails

    # ストア
    if 'cases' not in r:
        return [f'{label}: 測れなかった（{r.get("落ちた") or r}）']
    for c in r['cases']:
        if c['leftovers']:
            fails.append(f'{label}: {c["name"]} のあとに前の本が残っている：'
                         + '・'.join(c['leftovers']))
        if c['undo'] or c['redo']:
            fails.append(f'{label}: {c["name"]} のあとに取り消しの控えが残っている'
                         f'（戻る{c["undo"]}件・進む{c["redo"]}件）')
        # **読み込んだ本(続けて作る)だけは、印が立っているのが正しい。**
        # 2026-09-25 の見直し S1-4 で変えた(読み込んだ本が断りなしに消えていた)。
        # どちらが正しいかは probe が入口ごとに持っている(store-probe.ts の touchedWant)
        want = bool(c.get('touchedWant', False))
        if c['touched'] and not want:
            fails.append(f'{label}: {c["name"]} のあとも「手を入れた」印が立っている'
                         '（何もしていないのに毎回訊かれる）')
        if want and not c['touched']:
            fails.append(f'{label}: {c["name"]} のあとに「手を入れた」印が立っていない'
                         '（読み込んだ本が、新規作成・サンプルの前に断りなしで消える）')
    cross = r.get('別の本への画像の流れ込み') or {}
    if cross.get('leftovers'):
        fails.append(f'{label}: 本の id を持たない古いファイルを読むと、'
                     f'いま開いている本の絵が流れ込む：' + '・'.join(cross['leftovers']))
    ask = r.get('消える前の断り') or {}
    if ask.get('触っていないサンプル'):
        fails.append(f'{label}: 触っていないサンプルでも消える前の断りが出る（邪魔なだけ）')
    if not ask.get('絵を足したサンプル'):
        fails.append(f'{label}: サンプルに絵を足しても、消える前の断りが出ない')
    stale = r.get('古い写しのサンプル') or {}
    if stale.get('before') is not False or stale.get('after') is not True:
        fails.append(f'{label}: 保存された古いサンプルが組み直されない'
                     f'（{stale}）。画面だけが古い本を映す')
    if not fails:
        print(f'  入口3つとも、前の本は1か所も残っていません'
              f'（{len(r["cases"])}通りを総なめ）')
    return fails


def main() -> int:
    # Windows のコンソールは既定が cp932 で、日本語の記号でも落ちることがある。
    # 検査の結果が読めないと意味が無いので、出口を UTF-8 に寄せる
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser(description='組み上がりの紙面を PDF で機械検査する')
    ap.add_argument('--yoko', action='store_true', help='横組みで検査する(既定は縦組み)')
    ap.add_argument('--dense', action='store_true',
                    help='段落のあいだに区切り線を詰めた原稿で検査する(置き場所の検査を効かせる)')
    ap.add_argument('--keep', action='store_true', help='中間ファイルを残す')
    ap.add_argument('--chrome', help='Chrome の実行ファイル。省略すると既定の場所を探す')
    ap.add_argument('--no-screen', action='store_true',
                    help='画面(生プレビュー・入口のゼロリセット)の検査を飛ばす')
    ap.add_argument('--only-screen', action='store_true',
                    help='画面の検査だけを回す(紙のPDFを作らない。速い)')
    ap.add_argument('--scene', default='blank', choices=(*SCENES, 'all'),
                    help='場面転換の見た目。既定は blank(アプリの既定と同じ1行アキ)。'
                         'all なら4つとも順に組んで測る')
    a = ap.parse_args()

    vertical = not a.yoko
    chrome = find_chrome(a.chrome)
    if not chrome:
        print('※ Chrome が見つかりません。--chrome で渡してください', file=sys.stderr)

    scenes = list(SCENES) if a.scene == 'all' else [a.scene]
    fails: list[str] = []
    for scene in scenes:
        work = Path(tempfile.mkdtemp(prefix='typeset-check-'))
        print(f'{"縦組み" if vertical else "横組み"}のサンプル'
              f'（場面転換=「{SCENE_LABEL[scene]}」'
              f'{"・区切りを詰めたもの" if a.dense else ""}）'
              f'を組んで検査します（作業先 {work}）')
        try:
            if not a.only_screen:
                pdf = build_pdf(work, vertical, chrome, a.dense, scene)
                fails += check_css(work / 'check.html') + check(pdf, vertical, a.dense, scene)
            # **画面も測る。** 紙だけ見ていたから、署名の件を取りこぼした。
            # --dense は原稿を機械で書き換えた回なので、画面の検査は回さない。
            # 場面転換を4つとも回すときも、画面は1回でよい(見た目が違うだけで経路は同じ)
            if not a.no_screen and not a.dense and scene == scenes[0]:
                print('\n画面(生プレビューと入口のボタン)を検査します')
                fails += run_probes(chrome, work, vertical)
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
