// fig-probe.html を headless Chrome で開いて、結果の JSON を標準出力へ出す。
//   node scripts/fig-probe-run.mjs "at=12" [port] [screenshot.png]
import { chromium } from 'playwright-core';

const query = process.argv[2] ?? '';
const port = process.argv[3] ?? '5199';
const shot = process.argv[4];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(`http://localhost:${port}/scripts/${process.env.PROBE_PAGE ?? 'fig-probe'}.html?${query}`);
await page.waitForFunction(() => document.title !== 'PROBE-RUNNING', null, { timeout: 120000 });
console.log(await page.locator('#probe-result').textContent());
if (shot) {
  await page.evaluate(() => {
    document.getElementById('probe-result').style.display = 'none';
  });
  await page.screenshot({ path: shot });
}
await browser.close();
