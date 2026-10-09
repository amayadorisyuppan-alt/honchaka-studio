// 「絵の中の文字が版面の外に出ている」の知らせを、本物のアプリで確かめる。(2026-10-02)
//
//   npx vite --port 5188 --strictPort          ← 別のポートで開発サーバーを立てる(5173 は使わない)
//   node scripts/textcheck-probe.mjs [出力先] [ポート]
//
// headless の Chrome(playwright-core)でアプリごと開き、ページの中で絵を作って(canvas。文字のある絵と無い絵)、
// 挿絵として入れる。文字を見つける道具(src/textcheck。onnxruntime-web の WASM と検出モデル)が本当に動き、
//   - 文字のある絵を「全面」「余白すこし」で置くと、知らせ・版面の枠・はみ出した場所の色が出る
//   - 文字の無い絵には何も言わない
//   - 「版面いっぱい」にすると消える。「このままにする」で止められ、戻せる
//   - 外のサーバーへ1回も通信しない(絵を外へ送らない・道具を CDN から読まない)
// ことを見る。失敗したら終了コード 1。スクリーンショットは出力先へ残す。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'dist/textcheck-probe';
const PORT = process.argv[3] ?? '5188';
const BASE = `http://localhost:${PORT}/`;
mkdirSync(OUT, { recursive: true });

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok ' : 'NG '} ${name}${detail ? '  ' + detail : ''}`);
};
const KNOWN_ERROR = /Cannot set property bottom of #<DOMRectReadOnly>/;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && consoleErrors.push('console: ' + m.text()));
/** 外へ出ようとした通信(localhost 以外。data: と blob: は通信ではない) */
const external = [];
page.on('request', (r) => {
  const u = r.url();
  if (/^(data|blob):/.test(u)) return;
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) external.push(u);
});

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const get = (fn) =>
  page.evaluate(async (src) => {
    const m = await import('/src/store/useProject.ts');
    return new Function('s', `return (${src})(s)`)(m.useProject.getState());
  }, fn.toString());
const setSettings = (patch) =>
  page.evaluate(async (p) => {
    const m = await import('/src/store/useProject.ts');
    m.useProject.getState().setSettings(p);
  }, patch);
async function settle(ms = 40000) {
  await page.waitForTimeout(900);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await page.evaluate(() => /数えています/.test(document.body.innerText)))) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(900);
}
const rail = (name) => page.locator('button', { hasText: name }).first();
/** 下見の <style> に入っている、はみ出した文字の色の規則(どの絵のぶんがあるか) */
const marks = () =>
  page.evaluate(() => {
    const css = document.getElementById('preview-paint')?.textContent ?? '';
    return [...css.matchAll(/:has\(\[data-(plate|img)="([^"]+)"\]\)[^{]*::after \{([^}]*)\}/g)].map((m) => ({ kind: m[1], key: m[2], layers: (m[3].match(/linear-gradient/g) ?? []).length }));
  });
const waitFor = async (fn, ms = 90000, step = 300) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(step);
  }
  return false;
};
const sideText = async () => (await page.locator('aside.sidebar.panel').innerText()).replace(/\s/g, '');

await page.goto(BASE);
await page.getByText('サンプルを見る').click();
await page.waitForTimeout(1500);
await settle();

// ---- 絵を作る(ページの中で。1200×1700) ----
const imgs = await page.evaluate(() => {
  const make = (draw) => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 1700;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 1200, 1700);
    draw(g);
    return c.toDataURL('image/png');
  };
  // 文字が、絵の端ぎりぎりと真ん中にある図
  const text = make((g) => {
    g.fillStyle = '#222';
    g.font = 'bold 34px sans-serif';
    g.fillText('図1　売上の推移（2025年）', 20, 50);
    g.font = '28px sans-serif';
    g.fillText('北海道', 20, 850);
    g.fillText('九州・沖縄', 1040, 850);
    g.fillText('真ん中のラベル', 500, 850);
    g.fillText('出典：社内資料をもとに作成', 20, 1680);
    g.strokeStyle = '#444';
    g.lineWidth = 3;
    g.strokeRect(150, 200, 900, 560);
    g.fillStyle = '#dbe7e4';
    g.fillRect(150, 900, 900, 600);
  });
  // 文字が、絵の真ん中にだけある図(全面で置いても版面の中に入る)
  const center = make((g) => {
    g.fillStyle = '#1d2b3a';
    g.fillRect(0, 0, 1200, 1700);
    g.fillStyle = '#fff';
    g.font = 'bold 64px serif';
    g.fillText('旅のはじまり', 400, 860);
  });
  // 文字の無い絵(濃淡と図形だけ)
  const none = make((g) => {
    const gr = g.createLinearGradient(0, 0, 1200, 1700);
    gr.addColorStop(0, '#2b4a6f');
    gr.addColorStop(1, '#e8d9b0');
    g.fillStyle = gr;
    g.fillRect(0, 0, 1200, 1700);
    g.strokeStyle = '#333';
    g.lineWidth = 4;
    for (let i = 0; i < 12; i++) {
      g.beginPath();
      g.arc(100 + ((i * 263) % 1000), 100 + ((i * 419) % 1500), 40 + ((i * 53) % 120), 0, Math.PI * 2);
      g.stroke();
    }
  });
  return { text, center, none };
});

// ---- 文字のある絵・真ん中だけの絵・文字の無い絵を、全面の挿絵として入れる ----
await setSettings({
  plates: [
    { id: 'tc-text', src: imgs.text, beforeChapter: 1, size: 'full' },
    { id: 'tc-center', src: imgs.center, beforeChapter: 2, size: 'full' },
    { id: 'tc-none', src: imgs.none, beforeChapter: 3, size: 'full' },
  ],
});
const t0 = Date.now();
const found = await waitFor(async () => (await marks()).some((m) => m.key === 'tc-text'));
ok('文字のある絵(全面)で、はみ出した文字の色の規則が出る(道具が動いた)', found, `${((Date.now() - t0) / 1000).toFixed(1)}秒`);
await settle();
{
  const m = await marks();
  const t = m.find((x) => x.key === 'tc-text');
  ok('はみ出した箱は、端の文字の数(4つ: 上・左・右・下)。真ん中のラベルは入らない', !!t && t.layers === 4, JSON.stringify(m));
  // 「何も言わない」が、調べた結果であることを確かめる(調べ終わっていない・調べられなかった、でも何も出ないので)。
  // アプリと同じ道具(同じモジュール。結果は覚えてある)に、同じ絵を訊く
  const res = await page.evaluate(async (im) => {
    const d = await import('/src/textcheck/detect.ts');
    const [c, n] = await Promise.all([d.detectText(im.center), d.detectText(im.none)]);
    return { center: c ? c.boxes.length : null, none: n ? n.boxes.length : null };
  }, imgs);
  ok('文字が真ん中にだけある絵: 文字は見つけている(箱 1 つ以上)が、版面の中なので何も言わない', res.center !== null && res.center >= 1 && !m.some((x) => x.key === 'tc-center'), JSON.stringify(res));
  ok('文字の無い絵: 調べて、箱が 0。何も言わない', res.none === 0 && !m.some((x) => x.key === 'tc-none'), JSON.stringify(res));
}
ok('全ページに版面の枠を出す(.show-area)', await page.evaluate(() => document.querySelector('.preview-viewport')?.classList.contains('show-area')));
{
  const hint = await page.locator('.preview-hint.area').innerText().catch(() => '');
  ok('下見に、枠と色の説明が出る(赤い線は版面・赤く塗った所は絵の中の文字)', /赤い線は版面/.test(hint.replace(/\s/g, '')) && /画像の中の文字/.test(hint), hint);
}
// 枠の位置: 見えているページの ::before の重ね(5〜8番目)が、組版の余白と同じ場所にある。
// 本文の見開きへ進んでから測る(はじめに出ている大扉には、枠を引かない)
await page.locator('.page-nav button', { hasText: '次' }).first().click();
await page.locator('.page-nav button', { hasText: '次' }).first().click();
await page.waitForTimeout(800);
{
  const r = await page.evaluate(async () => {
    const MMPX = 96 / 25.4;
    const grid = await import('/src/typeset/grid.ts');
    const store = await import('/src/store/useProject.ts');
    const l = grid.computeLayout(store.useProject.getState().settings);
    const vp = document.querySelector('.preview-viewport');
    const rc = vp.getBoundingClientRect();
    const out = [];
    for (const f of [0.25, 0.75]) {
      const el = document.elementFromPoint(rc.left + rc.width * f, rc.top + rc.height * 0.5)?.closest('[data-vivliostyle-page-container]');
      if (!el) continue;
      const bb = el.querySelector('[data-vivliostyle-bleed-box]');
      const cs = getComputedStyle(bb, '::before');
      const pos = cs.backgroundPosition.split(',').map((s) => s.trim());
      const size = cs.backgroundSize.split(',').map((s) => s.trim());
      const px = (s) => parseFloat(s) / MMPX;
      // 5番目 = 枠の天の線(位置は「左から X・上から Y」)、8番目 = 枠の右の線(「右から X」は calc(100% - Xpx) で返る)
      const top = pos[4]?.match(/^([\d.]+)px ([\d.]+)px$/);
      const right = pos[7]?.match(/^calc\(100% - ([\d.]+)px\) /);
      // 太さは、天の線の大きさ(幅 高さ)の高さのほう。画面の上での太さに直す
      const scale = bb.getBoundingClientRect().width / bb.offsetWidth;
      const thickPx = parseFloat((size[4] ?? '').split(' ').pop()) * scale;
      out.push({ side: el.getAttribute('data-vivliostyle-page-side'), left: top ? px(top[1]) : null, top: top ? px(top[2]) : null, right: right ? px(right[1]) : null, thickPx, n: pos.length });
    }
    return { m: l.margins, pages: out };
  });
  const near = (a, b) => a !== null && Math.abs(a - b) < 0.06;
  const L = r.pages.find((p) => p.side === 'left');
  const R = r.pages.find((p) => p.side === 'right');
  ok('枠は8本の重ねのうち後ろの4本。画面の上で約 1.5 画素の太さ', r.pages.length > 0 && r.pages.every((p) => p.n === 8 && Math.abs(p.thickPx - 1.5) < 0.2), JSON.stringify(r.pages));
  if (L) ok('左のページの枠: 左=小口の余白・右=ノドの余白・天=天の余白', near(L.left, r.m.fore) && near(L.right, r.m.gutter) && near(L.top, r.m.top), `${JSON.stringify(L)} 余白 ${JSON.stringify(r.m)}`);
  if (R) ok('右のページの枠: 左=ノドの余白・右=小口の余白', near(R.left, r.m.gutter) && near(R.right, r.m.fore), JSON.stringify(R));
  ok('左右どちらかのページで枠を測れた', !!L || !!R);
}

// ---- ［挿絵］の、その絵の行に知らせが出る ----
await rail('本文に画像とコラムを入れる').click();
await page.waitForTimeout(600);
await page.locator('button', { hasText: '挿絵' }).first().click().catch(() => {});
await page.waitForTimeout(500);
{
  const n = await page.locator('.text-check').count();
  const tx = await sideText();
  ok('［挿絵］の一覧: 知らせは1枚ぶんだけ(文字のある絵の行)', n === 1, `${n} 件`);
  ok('知らせの文: 何が起きているか・どこへどれだけ・どこを見るか・どう直すか', /文字が、版面（本文の入る範囲）の外に出ています/.test(tx) && /(上|下|外側（小口）|綴じる側（ノド）)へ[\d.]+mm/.test(tx) && /はみ出し/.test(tx) && /「◯ページ目（見る）」を押すと/.test(tx) && /「版面いっぱい」にすると/.test(tx), tx.match(/この絵の中の文字が[^。]*。/)?.[0] ?? '');
  ok('確かめ終わった絵の行に、「確かめています」は残らない', !/画像の中の文字を確かめています/.test(tx));
  // その絵のページへ飛んで、色の重ねを見る
  const row = page.locator('li[data-id="tc-text"]');
  await row.locator('button.linklike', { hasText: 'ページ目' }).click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => {
    const el = document.querySelector('.preview-viewport [data-vivliostyle-page-container]:has([data-plate="tc-text"])');
    const bb = el?.querySelector('[data-vivliostyle-bleed-box]');
    if (!bb) return null;
    const cs = getComputedStyle(bb, '::after');
    return { content: cs.content, layers: cs.backgroundImage.split('linear-gradient').length - 1, visible: el.style.display !== 'none' };
  });
  ok('その絵のページに、はみ出した文字の色が重なる(::after に4つ)', !!after && after.content !== 'none' && after.layers === 4, JSON.stringify(after));
  await shot('01-text-outside');
}

// ---- 直す: 版面いっぱいにする ----
await page.locator('.text-check button', { hasText: '版面いっぱいにする' }).click();
ok('［版面いっぱいにする］で、大きさが変わる', (await get((s) => s.settings.plates.find((p) => p.id === 'tc-text').size)) === 'print');
ok('知らせ・色・枠が消える', await waitFor(async () => (await page.locator('.text-check').count()) === 0 && (await marks()).length === 0 && !(await page.evaluate(() => document.querySelector('.preview-viewport')?.classList.contains('show-area'))), 20000));
await settle();
await shot('02-fit-print');

// ---- 余白すこし(4%)でも、端の文字は版面の外。知らせが戻る → このままにする → 戻す ----
await setSettings({ plates: (await get((s) => s.settings.plates)).map((p) => (p.id === 'tc-text' ? { ...p, size: 'wide' } : p)) });
ok('余白すこしにすると、知らせが戻る(端の文字は版面の外)', await waitFor(async () => (await page.locator('.text-check').count()) === 1, 30000));
await settle();
await page.locator('.text-check button', { hasText: '文字ではない・このままにする' }).click();
ok('［このままにする］で、その絵の確かめを止める(知らせ・色・枠が消える)', await waitFor(async () => (await page.locator('.text-check').count()) === 0 && (await marks()).length === 0, 10000));
ok('止めたことを、絵に覚える(textOk)', (await get((s) => s.settings.plates.find((p) => p.id === 'tc-text').textOk)) === true);
ok('止めた絵の行に、戻す道がある(もう一度確かめる)', /画像の中の文字の確認を止めています/.test(await sideText()));
await page.locator('button.linklike', { hasText: 'もう一度確かめる' }).click();
ok('［もう一度確かめる］で、知らせが戻る', await waitFor(async () => (await page.locator('.text-check').count()) === 1, 10000));

// ---- 大きさを変えたら、「このままにする」は消える(その大きさでの了解なので) ----
await page.locator('.text-check button', { hasText: '文字ではない・このままにする' }).click();
await page.waitForTimeout(400);
await page.locator('li[data-id="tc-text"] select').nth(1).selectOption('full');
ok('［このままにする］のあとで大きさを変えると、確かめ直す(textOk が消えて、知らせが戻る)', (await waitFor(async () => (await page.locator('.text-check').count()) === 1, 30000)) && (await get((s) => s.settings.plates.find((p) => p.id === 'tc-text').textOk)) === undefined);
await settle();

// ---- 大扉には、版面の枠を出さない(大扉だけ左右の余白が違う) ----
{
  const r = await page.evaluate(() => {
    const thick = (el) => {
      const bb = el?.querySelector(':scope > [data-vivliostyle-bleed-box]');
      if (!bb) return null;
      const size = getComputedStyle(bb, '::before').backgroundSize.split(',').map((s) => s.trim());
      return parseFloat((size[4] ?? '').split(' ').pop());
    };
    const pages = [...document.querySelectorAll('.preview-viewport [data-vivliostyle-page-container]')];
    const title = pages.find((p) => p.querySelector('section.titlepage'));
    const body = pages.find((p) => p.querySelector('section.chapter') && !p.querySelector('section.titlepage'));
    return { title: thick(title), body: thick(body), hasTitle: !!title };
  });
  ok('大扉には版面の枠を引かない(太さ 0)。本文のページには引く', r.hasTitle && r.title === 0 && r.body > 0, JSON.stringify(r));
}

// ---- SVG の図表も調べられる(図表は SVG のことがある。Worker の中では開けないので、画面の側で開く) ----
{
  const svg =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1700" viewBox="0 0 1200 1700"><rect width="1200" height="1700" fill="#fff"/>' +
        '<text x="20" y="50" font-size="34" font-family="sans-serif" fill="#222">SVG の図表　端の見出し</text>' +
        '<text x="420" y="860" font-size="34" font-family="sans-serif" fill="#222">真ん中のラベル</text></svg>',
    );
  const plates = await get((s) => s.settings.plates);
  await setSettings({ plates: [...plates, { id: 'tc-svg', src: svg, beforeChapter: 4, size: 'full' }] });
  ok('SVG の絵でも、端の文字を見つけて知らせる', await waitFor(async () => (await page.locator('li[data-id="tc-svg"] .text-check').count()) === 1, 60000));
  await setSettings({ plates });
  await settle();
}

// ---- 書き出しの「直すところ」 ----
await rail('完成データを書き出す').click();
await page.waitForTimeout(800);
{
  const tx = (await page.locator('body').innerText()).replace(/\s/g, '');
  ok('書き出しの「直すところ」に出る', /直すところ/.test(tx) && /画像の中の文字が、版面（本文の入る範囲）の外に出ています（1枚/.test(tx), tx.match(/画像の中の文字が[^→]*/)?.[0] ?? '');
  await shot('03-export-problem');
  // (同じ行き先の「直すところ」がほかにもあることがある。この知らせの行のボタンを押す)
  {
    const btns = page.locator('ul.checklist li', { hasText: '絵の中の文字が' }).locator('button.link-btn');
    const n = await btns.count();
    const vis = [];
    for (let i = 0; i < n; i++) if (await btns.nth(i).isVisible()) vis.push(i);
    ok('「直すところ」のこの知らせは、見えている場所に1つだけ', vis.length === 1, `全部で ${n} 個・見えているのは ${vis.length} 個`);
    await btns.nth(vis[0] ?? 0).click();
  }
  await page.waitForTimeout(700);
  ok('「→ 挿絵を開く」で、その行のある面へ行く', (await page.locator('.text-check').count()) === 1);
}
// 電子書籍の下見のまま書き出しへ行っても、「→ 挿絵を開く」で紙の下見に戻って、知らせの出ている行へ着く
{
  await setSettings({ makeEbook: true });
  await page.waitForTimeout(500);
  await page.locator('.preview-mode button:visible', { hasText: '電子書籍' }).first().click();
  await page.waitForTimeout(800);
  ok('(電子書籍の下見のあいだは、行の知らせを出さない)', (await page.locator('.text-check').count()) === 0);
  await rail('完成データを書き出す').click();
  await page.waitForTimeout(800);
  const btns = page.locator('ul.checklist li', { hasText: '絵の中の文字が、版面' }).locator('button.link-btn');
  let clicked = false;
  for (let i = 0; i < (await btns.count()); i++) {
    if (await btns.nth(i).isVisible()) {
      await btns.nth(i).click();
      clicked = true;
      break;
    }
  }
  await page.waitForTimeout(1200);
  ok('電子書籍の下見から来ても、「→ 挿絵を開く」で紙の下見に戻り、知らせのある行に着く', clicked && (await page.locator('.text-check').count()) === 1);
}

// ---- 紙の本を作らない本では、調べない ----
await setSettings({ makePaper: false, makeEbook: true });
await page.waitForTimeout(1500);
ok('紙の本を作らない本では、知らせも枠も出さない', (await page.locator('.text-check').count()) === 0 && (await marks()).length === 0);
await rail('完成データを書き出す').click();
await page.waitForTimeout(800);
ok('紙の本を作らない本では、書き出しの「直すところ」にも出さない', !/画像の中の文字/.test((await page.locator('body').innerText()).replace(/\s/g, '')));
await setSettings({ makePaper: true });
await settle();

ok('外のサーバーへ通信していない(絵を外へ送らない・道具を CDN から読まない)', external.length === 0, external.slice(0, 3).join(' '));
const unexpected = consoleErrors.filter((e) => !KNOWN_ERROR.test(e));
ok('コンソールにエラーなし(Vivliostyle の既知の例外を除く)', unexpected.length === 0, JSON.stringify(unexpected.slice(0, 3)));
await browser.close();
process.exit(failed ? 1 : 0);
