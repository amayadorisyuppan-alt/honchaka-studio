# 縦中横(.tcy)専用の「詰め数字」フォントを、同梱の各書体から作る。
#
# ## なぜ要るか(2026-09-14 ユーザー報告「縦中横の数字がものによってずれる。21はOKで22はNG」)
#
# Chromium の text-combine-upright は、2桁の自然幅が 1.1em を超えると**横方向に圧縮**して
# 1emに収める(半角化の機能 hwid/twid が書体に無いとき。同梱の fontsource 版はどれも無い)。
# 同梱書体の数字は大半がプロポーショナル(Noto Serif JP: 「1」0.471em・他≈0.56em)なので、
# 「21」(1.03em)は素通し、「22」(1.12em)は圧縮、と組ごとに経路が分かれる。
# この**圧縮の経路で、新しい Chrome(Windows)では字が右上へずれる**(手元の Chromium 141 では
# 再現しない。Skia の描画かレイアウトの回帰と思われる)。「21」は素通しなので正常 — 報告と一致する。
#
# ## 何をするか
#
# 圧縮そのものを起こさせない。0〜9 と全角の ！？ だけを各書体から抜き出し、
# 字幅がちょうど 0.5em になるよう**あらかじめ横に詰めた**小さなフォントを作る
# (2桁=1.0em・「！？」=1.0em で、どの組も「21」と同じ素通しの経路を通る)。
# 見た目は Chromium が圧縮していたのと同じ「横に詰めた字」で、位置だけが確実になる。
# 書体ごとに1〜2ファイル(数字用・！？用)。typeset/css.ts が `.tcy` にだけこのフォントを当てる
# (BODY_FONTS の tcyStack)。EPUB には入れない(リーダーが自前で縦中横を組む)。
# ファミリー名は amayadori-tcy-<id>(元の書体名は使わない。OFL の予約フォント名のため)。
#
# 実行: python3 scripts/build-tcy-fonts.py  → src/fonts/tcy/*.woff2 と src/fonts/tcy.css を書く
import glob, os, sys
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src/fonts/tcy')
os.makedirs(OUT, exist_ok=True)

# id → (fontsource パッケージ名 or 自前ファイル, 主ファミリー名)。models/project.ts の BODY_FONTS と同じ順
FONTS = {
    'serif': ('noto-serif-jp', 'Noto Serif JP'),
    'koburi': ('src/fonts/GenEiKoburiMin6-R.woff2', 'GenEi Koburi Mincho v6'),
    'shippori': ('shippori-mincho', 'Shippori Mincho'),
    'zenOld': ('zen-old-mincho', 'Zen Old Mincho'),
    'bizMincho': ('biz-udmincho', 'BIZ UDMincho'),
    'kaisei': ('kaisei-opti', 'Kaisei Opti'),
    'klee': ('klee-one', 'Klee One'),
    'gothic': ('noto-sans-jp', 'Noto Sans JP'),
    'bizGothic': ('biz-udpgothic', 'BIZ UDPGothic'),
    'zenKaku': ('zen-kaku-gothic-new', 'Zen Kaku Gothic New'),
    'plex': ('ibm-plex-sans-jp', 'IBM Plex Sans JP'),
    'yuji': ('yuji-syuku', 'Yuji Syuku'),
    'maru': ('zen-maru-gothic', 'Zen Maru Gothic'),
    'dot': ('dotgothic16', 'DotGothic16'),
    'reggae': ('reggae-one', 'Reggae One'),
}
DIGITS = [ord(c) for c in '0123456789']
BANGS = [0xFF01, 0xFF1F]
TARGET = 0.5  # 1字の字幅(em)。2字でちょうど 1em

def find_file(pkg, cps):
    """指定の文字を全部含むサブセットファイルを探す(fontsource は unicode-range で分割されている)"""
    if pkg.endswith('.woff2'):
        p = os.path.join(ROOT, pkg)
        return p if all(cp in TTFont(p).getBestCmap() for cp in cps) else None
    for f in sorted(glob.glob(os.path.join(ROOT, f'node_modules/@fontsource/{pkg}/files/{pkg}-*-400-normal.woff2'))):
        cm = TTFont(f).getBestCmap()
        if all(cp in cm for cp in cps):
            return f
    return None

def condense(src, cps, out, family, merge_overlaps=False):
    font = TTFont(src)
    cmap = font.getBestCmap()
    upm = font['head'].unitsPerEm
    names = [cmap[cp] for cp in cps]
    hmtx = font['hmtx']
    widest = max(hmtx[n][0] for n in names) / upm
    sx = min(1.0, TARGET / widest)  # 一番広い字が 0.5em に収まる比。全字同じ比で詰める(字形の統一)
    # 先に必要な字だけに絞る(GSUB などは落とす。縦中横は横並びの素の字でよい)
    opt = Options()
    opt.layout_features = []
    opt.name_IDs = ['*']
    opt.notdef_outline = True
    opt.glyph_names = True
    sub = Subsetter(options=opt)
    sub.populate(unicodes=cps)
    sub.subset(font)
    glyf = font['glyf']
    glyphSet = font.getGlyphSet()
    for n in names:
        pen = TTGlyphPen(glyphSet)
        glyphSet[n].draw(TransformPen(pen, (sx, 0, 0, 1, 0, 0)))
        glyf[n] = pen.glyph()
        adv, lsb = hmtx[n]
        hmtx[n] = (int(round(adv * sx)), int(round(lsb * sx)))
    # ファミリー名を付け替える(元の書体と混ざらないように)
    name = font['name']
    for rec in name.names:
        if rec.nameID in (1, 4, 16):
            rec.string = family
        elif rec.nameID == 6:
            rec.string = family.replace(' ', '') + '-Regular'
    if merge_overlaps:
        # Noto(fontsource)は輪郭が重なったままで、KDP の印刷で「4」などの交わりが白く抜ける。
        # 本文と同じく重なりを取る(理由は scripts/build-noto-fonts.py。pip install skia-pathops が要る)
        from fontTools.ttLib.removeOverlaps import removeOverlaps
        removeOverlaps(font)
    font.flavor = 'woff2'
    font.save(out)
    return sx, os.path.getsize(out)

css = ['/* 縦中横用の詰め数字フォント。scripts/build-tcy-fonts.py が作る(手で編集しない)。',
       '   理由と仕組みはそのスクリプトの頭に書いてある */']
for fid, (pkg, fam) in FONTS.items():
    # 内部名にする。元の書体名を含めると OFL の「予約フォント名」に触れる書体があり得る
    # (改変版に元の名を付けてはいけない)。この名は models/project.ts の tcyStack と対にする
    tcy_family = f'amayadori-tcy-{fid}'
    for kind, cps, rng in (('digits', DIGITS, 'U+0030-0039'), ('bang', BANGS, 'U+FF01, U+FF1F')):
        src = find_file(pkg, cps)
        if not src:
            print(f'{fid}: {kind} の元が見つからない', file=sys.stderr)
            continue
        out = os.path.join(OUT, f'{fid}-{kind}.woff2')
        sx, size = condense(src, cps, out, tcy_family, merge_overlaps=pkg.startswith('noto-'))
        print(f'{fid:10s} {kind:6s} sx={sx:.3f} {size/1024:.1f}KB  ← {os.path.basename(src)}')
        css.append(f"@font-face {{\n  font-family: '{tcy_family}';\n  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n  src: url('./tcy/{fid}-{kind}.woff2') format('woff2');\n  unicode-range: {rng};\n}}")
open(os.path.join(ROOT, 'src/fonts/tcy.css'), 'w', encoding='utf-8').write('\n'.join(css) + '\n')
print('wrote src/fonts/tcy.css')
