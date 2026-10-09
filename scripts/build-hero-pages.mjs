// トップの「めくれる本」用に、サンプル本の全ページと表紙を撮影して
// public/hero/ に画像と台帳(manifest.json)を出す。
//
// **アプリと同じ組版で撮る。** ページは scripts/hero-probe.html(同じ組版HTML・
// 同じ CoreViewer)を1ページずつ送りながら撮影する。表紙は実アプリの
// 06 表紙のシートを撮り、表1だけを切り出す。背幅は画面の表示から読む
// (計算式を二重に持たない)。
//
// 使い方:
//   npm run dev                     (先に開発サーバーを立てる)
//   node scripts/build-hero-pages.mjs
//
// 前提:
//   - devDependencies の playwright-core(ブラウザ本体は同梱しない)。
//     ブラウザは HERO_CHROME=実行ファイルパス で指定。無指定なら
//     /opt/pw-browsers/chromium(リモート開発機) → システムの Chrome の順に探す
//   - WebP 変換と表1の切り出しは Python の Pillow(pip install pillow)
//   - サンプル本の内容や判型を変えたら、これを回し直してコミットする
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.HERO_URL ?? 'http://localhost:5173';
const OUT = 'public/hero';
const exePath =
  process.env.HERO_CHROME ??
  ['/opt/pw-browsers/chromium'].find((p) => {
    try { return statSync(p); } catch { return false; }
  });

const browser = await chromium.launch(
  exePath ? { executablePath: exePath, args: ['--no-sandbox'] } : { channel: 'chrome' },
);
// **縦長の窓で撮る。** 1200×900 で撮っていたころ、ページ(縦組みで高さ約1050px)が
// 窓の下へはみ出し、はみ出た分が描画されず「本文の下が切れて白帯」になった
// (2026-08-28 ユーザー報告。全37頁が下欠けだった)
let page = await (
  await browser.newContext({ viewport: { width: 900, height: 1500 }, deviceScaleFactor: 1.5 })
).newPage();

// ── 1) 撮影台でページを1枚ずつ撮る ──────────────────────────────
// **白黒とカラーの2セット撮る。** トップの切替(2026-09-11 ユーザー要望
// 「どっちも作れるのが売り」)は、同じ原稿を ink 設定だけ変えて組んだ
// 2つの実出力を見せる。フィルタで色を落とした偽物は使わない
rmSync(OUT, { recursive: true, force: true });
let pages = 0;

for (const v of [
  { ink: 'mono', dir: 'pages', q: '' },
  { ink: 'color', dir: 'pages-color', q: '?ink=color' },
]) {
  await page.goto(`${URL}/scripts/hero-probe.html${v.q}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /PROBE-(DONE|FAIL)/.test(document.title), null, { timeout: 200000 });
  if ((await page.title()) !== 'PROBE-DONE') {
    const why = await page.evaluate(() => document.getElementById('probe-result')?.textContent ?? '');
    throw new Error(`hero-probe (${v.ink}) failed: ${why.slice(0, 500)}`);
  }
  const n = await page.evaluate(() => window.__hero.pages);
  console.log(`pages (${v.ink}): ${n}`);
  // 刷り色は色しか変えないので頁数は一致するはず。ズレたら切替で別の頁が出る
  if (v.ink === 'mono') pages = n;
  else if (n !== pages) throw new Error(`color variant page count ${n} != mono ${pages}`);
  mkdirSync(join(OUT, v.dir), { recursive: true });

  for (let i = 0; i < n; i++) {
    await page.evaluate((idx) => window.__hero.go(idx), i);
    await page.waitForTimeout(120);
    const el = page.locator(`#probe-viewport [data-vivliostyle-page-index="${i}"]`).last();
    // **窓からはみ出したまま撮らない。** はみ出た領域は描画されず白くなる
    // (下切れ・白帯事件)。1枚でもはみ出したら撮影を止めて窓の大きさを直させる
    const box = await el.boundingBox();
    const vp = page.viewportSize();
    if (!box || box.y < 0 || box.y + box.height > vp.height || box.width > vp.width) {
      throw new Error(`page ${i + 1} (${v.ink}) overflows viewport: ${JSON.stringify(box)} vs ${JSON.stringify(vp)}`);
    }
    await el.screenshot({ path: join(OUT, v.dir, `p${String(i + 1).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 90 });
  }
}

// ── 2) 実アプリで表紙のシートを撮る ──────────────────────────────
// **表紙は高密度で撮る。** キャンバスの中身は印刷解像度(2,581×1,824px)で描かれて
// いるのに、dsf 1.5 の撮影では表示サイズまで落ちて、トップの表4のあらすじが
// ぼやけて読めなかった(2026-09-04 ユーザー報告)。dsf 3 なら backing にほぼ届く
await page.close();
page = await (
  await browser.newContext({ viewport: { width: 1400, height: 1500 }, deviceScaleFactor: 3 })
).newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
try {
  await page.click('button.primary-action:has-text("この本の作業に入る")', { timeout: 5000 });
} catch { /* 入口が出ない読み込みもある */ }

// **背幅はページ数から決まる。** 組み上がる前に表紙へ行くと途中の数で計算した
// 背幅を読んでしまう(1.54mm 事件)。下見が落ち着くまで待ってから行く
{
  const SEL = '.preview-body [data-vivliostyle-page-container]';
  let last2 = -1, stable2 = 0; const t2 = Date.now();
  for (;;) {
    const n = await page.locator(SEL).count();
    if (n !== last2) { last2 = n; stable2 = Date.now(); }
    if (last2 >= 5 && Date.now() - stable2 > 4000) break;
    if (Date.now() - t2 > 180000) throw new Error('app typeset timeout');
    await page.waitForTimeout(500);
  }
}
await page.click('button:has-text("表紙をつくる")');
await page.waitForSelector('.cover-sheet');
// **面ハイライトの枠を消してから撮る。** 表1を示すUI枠(cover-face-on)が
// キャンバスに重なったまま撮れてしまい、切り出した表紙の右端に枠線が
// 「背の色の帯」として写り込んでいた(2026-08-28 ユーザー報告)
await page.addStyleTag({ content: '.cover-face-overlay { display: none !important; }' });
await page.waitForTimeout(1500); // 表1の絵(青い本)の読み込み待ち

const bodyText = await page.evaluate(() => document.body.innerText);
const spineM = bodyText.match(/背幅[^0-9]*([0-9.]+)\s*mm/);
const spineMm = spineM ? Number(spineM[1]) : null;
const pagesM = bodyText.match(/([0-9]+)\s*(?:頁|ページ)/);
const specPages = pagesM ? Number(pagesM[1]) : null;
console.log('spineMm:', spineMm, 'specPages:', specPages);

// 紙表紙の canvas を**直接**撮る。以前は縦横比で要素を探していたが、
// 窓の大きさしだいで「比率がたまたま許容内の、より大きな灰色の容れ物」が
// 勝ってしまい、上端に舞台の灰色が写り込んだ(2026-09-04)。
// 構造は分かっているのだから探さない: 紙のシートは .cover-sheet(:not(.ebook)) の canvas
const BLEED = 3.2, TRIM_W = 105, TRIM_H = 148;
const wrapRatio = (BLEED + TRIM_W + (spineMm ?? 2) + TRIM_W + BLEED) / (BLEED + TRIM_H + BLEED);
const paperCanvas = page.locator('.cover-sheet:not(.ebook) canvas').first();
const box = await paperCanvas.boundingBox();
if (box && Math.abs(box.width / box.height - wrapRatio) < 0.02) {
  await paperCanvas.screenshot({ path: join(OUT, 'cover-wrap.png') });
} else {
  console.warn(`paper canvas ratio mismatch: ${box && (box.width / box.height).toFixed(4)} vs ${wrapRatio.toFixed(4)}; skipping cover`);
}
await browser.close();

// ── 3) 表1の切り出しと WebP 化(Pillow) ──────────────────────────
// 式: 幅 = 塗り足し+判型幅+背幅+判型幅+塗り足し。
// **右綴じのシートは左から 表1|背|表4**(最初は右側を切って表4を拾ってしまった)
const py = `
import glob, os, sys
try:
    from PIL import Image
except ImportError:
    print('NO_PILLOW'); sys.exit(0)
out = ${JSON.stringify(OUT)}
bleed, tw, th = ${BLEED}, ${TRIM_W}, ${TRIM_H}
spine = ${spineMm ?? 'None'}
wrap = os.path.join(out, 'cover-wrap.png')
if spine is not None and os.path.exists(wrap):
    from PIL import ImageDraw
    im = Image.open(wrap)
    total_w = bleed + tw + spine + tw + bleed
    total_h = bleed + th + bleed
    sx, sy = im.width / total_w, im.height / total_h
    box = (round(bleed * sx), round(bleed * sy), round((bleed + tw) * sx), round((bleed + th) * sy))
    im.crop(box).save(os.path.join(out, 'cover.webp'), quality=88)
    # 表4(シートの右側)も切り出す(2026-09-04「表4も最後に入るように」)。
    # 画面用キャンバスにはバーコードの仮はめ(50x30mm+文字)が描かれているので、
    # 表4の無地から採った色で塗って消す(印刷出力には元々入らない画面だけの目印)。
    # ※塗りつぶしは無地の表4が前提。表4を写真にしたら別の消し方が要る
    bx0 = round((bleed + tw + spine) * sx)
    back = im.crop((bx0, round(bleed * sy), round((bleed + tw + spine + tw) * sx), round((bleed + th) * sy)))
    bw, bh = back.size
    fill = back.getpixel((int(bw * 0.12), int(bh * 0.80)))
    d = ImageDraw.Draw(back)
    lx, ly = bw / tw, bh / th
    d.rectangle((47.0 * lx, 110.0 * ly, 100.0 * lx, 143.0 * ly), fill=fill)
    back.save(os.path.join(out, 'back.webp'), quality=88)
    if not ${process.env.HERO_KEEP_WRAP ? 'True' : 'False'}:
        os.remove(wrap)
for f in sorted(glob.glob(os.path.join(out, 'pages*', '*.jpg'))):
    Image.open(f).save(f[:-4] + '.webp', quality=84)
    os.remove(f)
print('WEBP_OK')
`;
let webp = false;
try {
  // Windows の python3 は Microsoft Store へ誘う空の入口で、Pillow の段が丸ごと落ちる
  // (表紙が null・ページが jpg のまま manifest に載る)。Windows では python を呼ぶ
  const pyExe = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const r = execFileSync(pyExe, ['-c', py]).toString();
  webp = r.includes('WEBP_OK');
  console.log(r.trim());
} catch (e) {
  console.warn('pillow step failed, keeping jpeg:', String(e).slice(0, 200));
}

const images = readdirSync(join(OUT, 'pages')).sort();
const imagesColor = readdirSync(join(OUT, 'pages-color')).sort();
const hasCover = readdirSync(OUT).includes('cover.webp');
const hasBack = readdirSync(OUT).includes('back.webp');
const manifest = {
  builtAt: new Date().toISOString().slice(0, 10),
  trim: { id: 'bunko', label: '文庫判（A6）', w: TRIM_W, h: TRIM_H },
  binding: 'right',
  pages: images.length,
  /** アプリの画面が言うページ数(背幅の根拠)。撮影枚数と食い違ったら要調査 */
  specPages,
  spineMm,
  bleedMm: BLEED,
  cover: hasCover ? 'cover.webp' : null,
  /** 裏表紙(表4)。最後の見開きのあとにめくれる */
  back: hasBack ? 'back.webp' : null,
  images: images.map((f) => `pages/${f}`),
  /** カラーで刷ったときの同じページ。トップの白黒⇄カラー切替に使う。
   * 枚数が食い違ったら null(切替を出さない)にして、白黒だけで動かす */
  imagesColor: imagesColor.length === images.length ? imagesColor.map((f) => `pages-color/${f}`) : null,
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('manifest:', JSON.stringify(manifest).slice(0, 200));
console.log('webp:', webp);
