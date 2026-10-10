# Noto Sans JP / Noto Serif JP の、輪郭の重なりを取り除いた写しを作る。
#
# ## なぜ要るか(2026-10-10 KDP の紙の校正紙)
#
# 章題の字の、線が交わる所だけが白く抜けて刷られた(「棚」が市松模様・「書」「空」「た」「の」の交差)。
# @fontsource の Noto Sans JP / Noto Serif JP は可変フォントから太さごとに切り出したもので
# (PDF に埋め込まれる名前が NotoSansJPThin-Bold・NotoSerifJPExtraLight-Regular)、
# **線の交わりで輪郭が二重に重なったまま**になっている。画面・ふつうのプリンタは重なりも黒く塗るが、
# KDP の印刷機は重なった所を白く抜く(重なった所を偶奇の規則で塗って描くと、校正紙と同じ形になる)。
# 積んでいる書体 27 種のうち、重なりがあるのは Noto の2種(字の面積の 5〜9%)だけで、残りは 0%。
# 同じ校正紙でも、重なりの無い BIZ UDPゴシック(コラムの見出し)・Klee One はきれいに刷れていた。
# 見出しのゴシックは Noto Sans JP 固定なので、どの本にも出る。
#
# ## 何をするか
#
# fontsource の woff2(unicode-range で 1 太さ 124 ファイルに分かれている)を1つずつ開き、
# fontTools の removeOverlaps(skia-pathops)で重なりを1つの輪郭にまとめ直して src/fonts/noto/ へ書く。
# 字形の違いは縁の丸めくらい(塗りの 0.1%)。字幅・縦の字送り・GSUB(縦書きの字形)などは触らない。
# ヒンティングは落ちる(重なりを直した字は命令が合わなくなるため。印刷と高解像度の画面では効かない)。
# @font-face は fontsource と同じ並び・同じ unicode-range で src/fonts/noto.css に書く。
# **ファミリー名は元のまま**(Noto の OFL には予約フォント名が無いので、改変版でも同じ名で配れる)。
# 作りかけの本の書体の設定も、組版の CSS も、そのまま効く。
#
# 実行(fontsource を上げたら回し直す):
#   pip install fonttools skia-pathops brotli
#   python scripts/build-noto-fonts.py   → src/fonts/noto/*.woff2 と src/fonts/noto.css を書く
# このあと scripts/build-tcy-fonts.py も回す(縦中横の数字は src/fonts/noto/ から作る)
import os, re, sys
from fontTools.ttLib import TTFont
from fontTools.ttLib.removeOverlaps import removeOverlaps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src/fonts/noto')
# fontsAll.ts が読んでいた太さと同じ
TARGETS = [('noto-sans-jp', 400), ('noto-sans-jp', 500), ('noto-sans-jp', 700),
           ('noto-serif-jp', 400), ('noto-serif-jp', 700)]

os.makedirs(OUT, exist_ok=True)
css = ['/* Noto Sans JP / Noto Serif JP の、輪郭の重なりを取り除いた写し。',
       '   scripts/build-noto-fonts.py が @fontsource から作る(手で編集しない)。理由はそのスクリプトの頭に書いてある */']
done = 0
for pkg, weight in TARGETS:
    src_css = open(os.path.join(ROOT, f'node_modules/@fontsource/{pkg}/{weight}.css'), encoding='utf-8').read()
    for block in re.findall(r'@font-face\s*\{([^}]*)\}', src_css):
        fam = re.search(r"font-family:\s*'([^']+)'", block).group(1)
        style = re.search(r'font-style:\s*([^;]+);', block).group(1).strip()
        display = re.search(r'font-display:\s*([^;]+);', block).group(1).strip()
        w = re.search(r'font-weight:\s*([^;]+);', block).group(1).strip()
        fn = re.search(r'url\(\./files/([^)]+\.woff2)\)', block).group(1)
        rng = re.search(r'unicode-range:\s*([^;]+);', block)
        font = TTFont(os.path.join(ROOT, f'node_modules/@fontsource/{pkg}/files/{fn}'))
        removeOverlaps(font)
        font.flavor = 'woff2'
        font.save(os.path.join(OUT, fn))
        css.append('@font-face {\n'
                   f"  font-family: '{fam}';\n  font-style: {style};\n  font-display: {display};\n  font-weight: {w};\n"
                   f"  src: url('./noto/{fn}') format('woff2');\n"
                   + (f'  unicode-range: {rng.group(1).strip()};\n' if rng else '') + '}')
        done += 1
    print(f'{pkg} {weight}: {done} files', flush=True)
open(os.path.join(ROOT, 'src/fonts/noto.css'), 'w', encoding='utf-8').write('\n'.join(css) + '\n')
print('wrote src/fonts/noto.css')
