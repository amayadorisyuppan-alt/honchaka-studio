// リンク用バナーを scripts/banners-src.html から作る。
//
// 旧 build-banners.py は Pillow + Windows の游明朝で描いていたが、
// 「もうちょっと愛嬌のあるバナーに」(2026-09-04 ユーザー要望)で作り直した。
// 版下は HTML/CSS(アプリ同梱の Noto Serif JP + Zen Maru Gothic + かくれカエルの線画)。
// ここでは 3倍で撮って PIL で実寸へ縮め、小さい字でも線が残るようにする。
//
//   node scripts/build-banners.mjs            … 全案を scratch へ(見比べ用)
//   node scripts/build-banners.mjs --adopt a  … 案 a を public/banners へ反映
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUTDIR = process.env.BANNER_OUT ?? join(ROOT, 'public', 'banners', 'preview');
mkdirSync(OUTDIR, { recursive: true });

const adopt = process.argv.includes('--adopt')
  ? process.argv[process.argv.indexOf('--adopt') + 1]
  : null;

// ブラウザ: PW_CHROMIUM → リモート開発機の /opt/pw-browsers/chromium → システムの Chrome の順(build-hero-pages.mjs と同じ)
const exePath = process.env.PW_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const browser = await chromium.launch(
  exePath ? { executablePath: exePath, args: ['--no-sandbox'] } : { channel: 'chrome' },
);
// 窓は版下が全部入る高さに。既定の 720 だと、下にある OGP の下端 11px ほどが窓の外で撮れず、
// 緑の枠の下辺が欠けて灰色の地が写っていた(2026-10-07 ユーザー指摘)
const page = await (
  await browser.newContext({ deviceScaleFactor: 3, viewport: { width: 1280, height: 1400 } })
).newPage();
await page.goto(pathToFileURL(join(HERE, 'banners-src.html')).href);
// Webフォントを待つ(待たないと代替書体で撮れてしまう)
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const SIZES = { 200: [200, 40], 468: [468, 60] };
const shots = [];
for (const variant of ['a', 'b', 'c']) {
  for (const s of [200, 468]) {
    const raw = join(OUTDIR, `banner-${variant}-${s}-raw.png`);
    await page.locator(`#${variant}-${s}`).screenshot({ path: raw });
    shots.push({ variant, s, raw });
  }
}
// OGP(1200×630)は案Aテイストの1枚だけ。--adopt のとき一緒に public へ入る
const ogpRaw = join(OUTDIR, 'ogp-raw.png');
await page.locator('#ogp').screenshot({ path: ogpRaw });
await browser.close();

// 3倍→実寸へ LANCZOS で縮める(Python は Pillow が入っている前提。旧スクリプトと同じ)
for (const { variant, s, raw } of shots) {
  const [w, h] = SIZES[s];
  const out =
    adopt === variant
      ? join(ROOT, 'public', 'banners', `banner-${w}x${h}.png`)
      : join(OUTDIR, `banner-${variant}-${w}x${h}.png`);
  execFileSync(PY, [
    '-c',
    `
from PIL import Image
im = Image.open(${JSON.stringify(raw)}).convert('RGB')
im.resize((${w}, ${h}), Image.LANCZOS).save(${JSON.stringify(out)})
`,
  ]);
  console.log('wrote', out);
}
// OGP を実寸へ
{
  const out = adopt
    ? join(ROOT, 'public', 'banners', 'ogp-1200x630.png')
    : join(OUTDIR, 'ogp-1200x630.png');
  execFileSync(PY, [
    '-c',
    `
from PIL import Image
im = Image.open(${JSON.stringify(ogpRaw)}).convert('RGB')
im.resize((1200, 630), Image.LANCZOS).save(${JSON.stringify(out)})
`,
  ]);
  console.log('wrote', out);
}
console.log(adopt ? `adopted variant "${adopt}" into public/banners/` : 'preview only (use --adopt a|b|c)');
