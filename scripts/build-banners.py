# リンク用バナーと OGP 画像をつくる。出力は public/banners/。
#
# **色は決め打ちしない。** src/app.css の :root(明るいテーマ)からトークンの値を読む。
# 画面とバナーで緑がずれると、貼ってもらったときに別のサービスに見える。
# app.css の色を変えたら、このスクリプトを流し直せばバナーもついてくる。
#
# 書体は Windows の游明朝(本の道具なので明朝)。小さい添え字だけはメイリオ —
# 9px の明朝は線が細すぎて、200×40 の帯の上でつぶれる。
#
#   python scripts/build-banners.py
import os
import re

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSS = os.path.join(ROOT, "src", "app.css")
OUT = os.path.join(ROOT, "public", "banners")
os.makedirs(OUT, exist_ok=True)

NAME = "ひっちゃか本づくりスタジオ"
SUB = "縦書き・横書き／紙の本・電子書籍"


def tokens() -> dict[str, str]:
    """src/app.css の最初の :root{...} から --名前: 値 を拾う(明るいテーマの既定値)。"""
    src = open(CSS, encoding="utf-8").read()
    i = src.index(":root {")
    body = src[i : src.index("\n}", i)]
    return dict(re.findall(r"(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;", body))


T = tokens()


def rgb(name: str) -> tuple[int, int, int]:
    h = T[name].lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


# 使う色。名前のとおりの役目で選ぶ(--accent=押せる濃いミント、--bg=クリームの地)
MINT = rgb("--accent")          # #0e7c72
MINT_DARK = rgb("--accent-strong")
MINT_PALE = rgb("--accent-fill")
CREAM = rgb("--bg")             # #faf7e9
INK = rgb("--text-strong")
INK_SUB = rgb("--text-sub")

MINCHO = r"C:\Windows\Fonts\yumin.ttf"    # 游明朝
GOTHIC = r"C:\Windows\Fonts\meiryo.ttc"   # メイリオ
GOTHIC_B = r"C:\Windows\Fonts\meiryob.ttc"
if not os.path.exists(MINCHO):
    MINCHO = r"C:\Windows\Fonts\msmincho.ttc"


def mincho(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(MINCHO, size, index=0)


def gothic(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(GOTHIC, size, index=0)


def gothic_bold(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(GOTHIC_B, size, index=0)


def fit(text: str, font_of, width: int, start: int) -> ImageFont.FreeTypeFont:
    """幅に収まるいちばん大きいサイズを選ぶ。書体を変えても字がはみ出さない。"""
    size = start
    while size > 6:
        f = font_of(size)
        if f.getbbox(text)[2] - f.getbbox(text)[0] <= width:
            return f
        size -= 1
    return font_of(6)


def draw_text(d: ImageDraw.ImageDraw, xy, text, font, fill, anchor="la"):
    d.text(xy, text, font=font, fill=fill, anchor=anchor)


def strip_banner(w: int, h: int, title_px: int, sub_px: int, pad: int, title_of=mincho) -> Image.Image:
    """横帯(200×40 / 468×60)。濃いミントの地にクリームの字 — よその明るい
    ページに貼られる前提なので、地を塗って自分の存在を作る。

    `title_of` を渡し分けているのは 200×40 のため。13字の名前は 13px までしか
    入らず、その大きさの明朝は線が消えて添え字より弱く見えた(3倍に拡大して確認)。
    小さいほうだけゴシックの太字にして、名前が名前として読めるようにしている。"""
    im = Image.new("RGB", (w, h), MINT)
    d = ImageDraw.Draw(im)
    # 左の細い縦線と外枠。塗りっぱなしより「札」らしく見える
    d.rectangle([0, 0, w - 1, h - 1], outline=MINT_DARK)
    d.rectangle([pad - 4, pad, pad - 3, h - pad - 1], fill=MINT_PALE)

    x = pad + 4
    inner = w - x - pad
    ft = fit(NAME, title_of, inner, title_px)
    fs = fit(SUB, gothic, inner, sub_px)
    th = ft.getbbox(NAME)[3] - ft.getbbox(NAME)[1]
    sh = fs.getbbox(SUB)[3] - fs.getbbox(SUB)[1]
    gap = max(2, h // 14)
    top = (h - (th + gap + sh)) // 2
    draw_text(d, (x, top), NAME, ft, CREAM)
    draw_text(d, (x, top + th + gap), SUB, fs, MINT_PALE)
    return im


def ogp() -> Image.Image:
    """SNS 用 1200×630。こちらは紙の色(クリーム)を地にして、
    大扉のように罫で挟む。タイムラインの中で「本の道具」に見えるように。"""
    w, h = 1200, 630
    im = Image.new("RGB", (w, h), CREAM)
    d = ImageDraw.Draw(im)
    # 外周のミント枠(内側に一本)
    d.rectangle([0, 0, w - 1, h - 1], fill=MINT)
    d.rectangle([18, 18, w - 19, h - 19], fill=CREAM)

    ft = fit(NAME, mincho, w - 220, 96)
    fs = fit(SUB, gothic, w - 260, 34)
    cx, cy = w // 2, h // 2
    draw_text(d, (cx, cy - 8), NAME, ft, INK, anchor="mm")
    # 名前の上下に細い罫。上は太く、下は細く(大扉の見え方)
    tw = ft.getbbox(NAME)[2] - ft.getbbox(NAME)[0]
    half = tw // 2 + 26
    d.rectangle([cx - half, cy - 90, cx + half, cy - 87], fill=MINT)
    d.rectangle([cx - half, cy + 52, cx + half, cy + 53], fill=MINT)
    draw_text(d, (cx, cy + 92), SUB, fs, INK_SUB, anchor="mm")
    return im


made = [
    # 上限を渡すだけで、fit() が幅に収まるいちばん大きい字を選ぶ
    ("banner-200x40.png", strip_banner(200, 40, 16, 10, 8, gothic_bold)),
    ("banner-468x60.png", strip_banner(468, 60, 30, 16, 18)),
    ("ogp-1200x630.png", ogp()),
]
for name, im in made:
    im.save(os.path.join(OUT, name), optimize=True)
    print(f"{name}  {im.size[0]}x{im.size[1]}  {os.path.getsize(os.path.join(OUT, name)):,} bytes")

# 見本のページ。3点を実寸で並べる(貼る前に大きさの感じを見てもらう)
html = f"""<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <title>ひっちゃか本づくりスタジオ バナー見本</title>
    <style>
      body {{ margin: 0; padding: 32px; background: {T['--bg']}; color: {T['--text']};
             font-family: "Meiryo", system-ui, sans-serif; }}
      h1 {{ font-size: 18px; margin: 0 0 6px; color: {T['--text-strong']}; }}
      p {{ font-size: 13px; color: {T['--text-sub']}; margin: 0 0 24px; }}
      figure {{ margin: 0 0 28px; }}
      figcaption {{ font-size: 12px; color: {T['--text-dim']}; margin-bottom: 6px; }}
      img {{ display: block; max-width: 100%; }}
    </style>
  </head>
  <body>
    <h1>ひっちゃか本づくりスタジオ バナー</h1>
    <p>リンクは大歓迎です。下の画像をダウンロードしてお使いください（改変はご遠慮ください）。</p>
    <figure>
      <figcaption>200 × 40（小）</figcaption>
      <img src="banner-200x40.png" width="200" height="40" alt="ひっちゃか本づくりスタジオ" />
    </figure>
    <figure>
      <figcaption>468 × 60（横長）</figcaption>
      <img src="banner-468x60.png" width="468" height="60" alt="ひっちゃか本づくりスタジオ" />
    </figure>
    <figure>
      <figcaption>1200 × 630（SNS・OGP／実寸の半分で表示）</figcaption>
      <img src="ogp-1200x630.png" width="600" height="315" alt="ひっちゃか本づくりスタジオ" />
    </figure>
  </body>
</html>
"""
open(os.path.join(OUT, "preview.html"), "w", encoding="utf-8").write(html)
print("preview.html")
