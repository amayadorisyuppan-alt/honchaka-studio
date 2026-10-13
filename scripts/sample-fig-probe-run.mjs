// sample-fig-probe.html を headless Chrome で開いて、千鳥のページの本文の行数・総ページ数を表にする。(2026-10-12 修正リスト 20)
//
// 開発サーバーは立てない。検査用に静的なファイルへ組んで、それを配って開く:
//   npx vite build --config scripts/sample-fig-probe.vite.config.ts --outDir <出力先> --emptyOutDir
//   node scripts/sample-fig-probe-run.mjs <出力先> <判型,判型,...> [段落の頭の文 ...]
// 段落の頭の文を渡さなければ(または `-`)、sample.ts の置き場所のまま測る。`none` は千鳥を外した本(総ページ数の基準)。
// 例: node scripts/sample-fig-probe-run.mjs C:/tmp/figprobe-dist bunko,b6,a5 none 商店街の外れ 「探しものは
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [dist, trimArg = 'bunko,b6,a5', ...befores] = process.argv.slice(2);
if (!dist) {
  console.error('使い方: node scripts/sample-fig-probe-run.mjs <dist> [trims] [before ...]');
  process.exit(2);
}
const trims = trimArg.split(',');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(dist, p.endsWith('/') ? p + 'index.html' : p);
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const jobs = [];
for (const trim of trims) for (const b of befores.length ? befores : [null]) jobs.push({ trim, before: b === '-' ? null : b });

async function run({ trim, before }) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  const q = new URLSearchParams({ trim });
  if (before !== null) q.set('before', before);
  await page.goto(`http://127.0.0.1:${port}/scripts/sample-fig-probe.html?${q}`);
  await page.waitForFunction(() => document.title !== 'PROBE-RUNNING', null, { timeout: 180000 });
  const r = JSON.parse(await page.locator('#probe-result').textContent());
  await page.close();
  return r;
}

const out = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const j = queue.shift();
      const r = await run(j);
      out.push({ ...j, r });
    }
  }),
);
for (const trim of trims) {
  for (const o of out.filter((x) => x.trim === trim).sort((a, b) => String(a.before).localeCompare(String(b.before)))) {
    const r = o.r;
    const fp = r.ok ? r.figPages.map((p) => `P${p.page}(本文${p.lines}行)`).join(',') || '図なし' : 'ERR ' + r.error;
    console.log(`${trim}\t総${r.pageCount}p\t千鳥 ${fp}\t絵だけ=${r.ok ? r.figOnly.join(',') || 'なし' : '?'}\t[${o.before ?? 'sample.ts'}]`);
  }
}
await browser.close();
server.close();
