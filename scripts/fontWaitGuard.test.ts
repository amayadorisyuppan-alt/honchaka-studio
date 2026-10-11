// 書体の一斉の取得を止める仕掛け(修正リストの 17。2026-10-11 1.0.3)の検査。
// - src/preview/fontWaitGuard.ts: Vivliostyle の読み込み待ちに、Vivliostyle の面だけを見せる
// - src/preview/fontPrefetch.ts: 組版の HTML から書体のファイルのアドレスを抜き出す
// - @vivliostyle/core の waitFontLoading が、いまも document.fonts を forEach で回す作りか
//   (Vivliostyle を上げて作りが変わったら、ここで落ちる。そのときは fontWaitGuard.ts を見直す)
//
// 回し方(ブラウザも dev サーバーも要らない。リポジトリの頭で回す)
//   npx vite build --ssr scripts/fontWaitGuard.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/fontWaitGuard.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { readFileSync } from 'node:fs';
import { installFontWaitGuard, isVivliostyleFace } from '../src/preview/fontWaitGuard';
import { fontUrlsIn } from '../src/preview/fontPrefetch';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}
const j = JSON.stringify;

ok(isVivliostyleFace('Fnt_12') && isVivliostyleFace('"Fnt_3"') && isVivliostyleFace('-viv-ts-sp'), 'Vivliostyle の面(Fnt_N・-viv-)は見せる');
ok(!isVivliostyleFace('Noto Serif JP') && !isVivliostyleFace('Shippori Mincho') && !isVivliostyleFace('amayadori-tcy-serif') && !isVivliostyleFace('Fnt'), 'アプリの書体は見せない');

// 偽の document.fonts。forEach の絞り込みと、2回入れても1回ぶんしか効かないことを見る
const faces = ['Noto Sans JP', 'Fnt_1', 'Shippori Mincho', '-viv-ts-sp', 'Fnt_2'].map((family) => ({ family }));
const fake = {
  forEach(cb: (f: unknown, f2: unknown, s: unknown) => void) {
    for (const f of faces) cb(f, f, fake);
  },
} as unknown as FontFaceSet;
installFontWaitGuard(fake);
installFontWaitGuard(fake);
const seen: string[] = [];
fake.forEach((f) => seen.push(f.family));
ok(j(seen) === j(['Fnt_1', '-viv-ts-sp', 'Fnt_2']), 'forEach は Vivliostyle の面だけを回す(2回入れても同じ)', j(seen));
let self: unknown = null;
fake.forEach(function (this: unknown) {
  self = this;
}, 'THIS');
ok(self === 'THIS', 'forEach の thisArg を渡す');
installFontWaitGuard(undefined);
ok(true, 'document が無いところ(node)では何もしない');

const css = `
@font-face{font-family:"Noto Serif JP";src:url("https://example.com/bookstudio/assets/noto-serif-jp-0-400-normal-AAAA.woff2") format("woff2"),url(./x.woff) format("woff");unicode-range:U+3000}
@font-face{font-family:Fnt;src:url('https://example.com/a/b.woff2?v=1')}
.bg{background:url(data:image/png;base64,iVBORw0KGgo=)} .x{background:url("https://example.com/a/pic.jpg")}
@font-face{font-family:dup;src:url("https://example.com/bookstudio/assets/noto-serif-jp-0-400-normal-AAAA.woff2")}`;
const urls = fontUrlsIn(css);
ok(
  j(urls) ===
    j(['https://example.com/bookstudio/assets/noto-serif-jp-0-400-normal-AAAA.woff2', './x.woff', 'https://example.com/a/b.woff2?v=1']),
  '書体のファイルだけを、重ねずに抜き出す(画像・data: は取らない)',
  j(urls),
);

// Vivliostyle の作りの確かめ
const viv = readFileSync('node_modules/@vivliostyle/core/lib/vivliostyle.js', 'utf8');
const at = viv.indexOf('waitFontLoading(){');
const body = at >= 0 ? viv.slice(at, at + 400) : '';
ok(at >= 0, '@vivliostyle/core に waitFontLoading がある');
ok(/ownerDocument\.fonts/.test(body) && /\.forEach\(/.test(body) && /\.load\(\)/.test(body),
  'waitFontLoading は document.fonts を forEach で回して load() する作りのまま(変わったら fontWaitGuard.ts を見直す)', body.slice(0, 200));

console.log(`\n${passed} ok / ${failed} NG`);
process.exit(failed ? 1 : 0);
