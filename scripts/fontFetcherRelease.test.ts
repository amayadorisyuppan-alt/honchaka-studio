// 組み直すたびにメモリが増える件(修正リスト 30。2026-10-13)の検査。
// - src/preview/fontFetcherRelease.ts: 取り寄せ終わった書体の係から、原稿への糸(fetch)を切る
// - @vivliostyle/core の書体の表(fontMapper.srcURLMap)と取り寄せ係(arrived・fetch・get)が、いまもその作りか
//   (Vivliostyle を上げて作りが変わったら、ここで落ちる。そのときは fontFetcherRelease.ts を見直す。
//    見直さないと、切る相手が見つからず黙って何もしなくなり、組み直すたびに原稿1冊ぶんが残る形に戻る)
//
// 回し方(ブラウザも dev サーバーも要らない。リポジトリの頭で回す)
//   npx vite build --ssr scripts/fontFetcherRelease.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/fontFetcherRelease.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { readFileSync } from 'node:fs';
import { releaseFontFetchers, type FontFetcherLike } from '../src/preview/fontFetcherRelease';

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

// 1) 取り寄せ済みの係だけ、fetch を「手元の結果を返すだけ」に替える
{
  const doc = { big: 'この回の原稿(本当は解析した文書)' };
  const resource = { face: 'Fnt_1' };
  const done: FontFetcherLike & { resource: unknown } = {
    arrived: true,
    resource,
    fetch: () => doc, // 原稿を閉じ込めた手順のつもり
    get() {
      return this.resource;
    },
  };
  const pending: FontFetcherLike = { arrived: false, fetch: () => doc, get: () => null };
  const origPending = pending.fetch;
  const viewer = { adaptViewer_: { fontMapper: { srcURLMap: { a: done, b: pending, c: undefined } } } };
  const n = releaseFontFetchers(viewer);
  ok(n === 1, '取り寄せ済みの1つだけ替える', `n=${n}`);
  ok(done.fetch !== undefined && done.fetch() === resource, '替えた fetch は手元の結果を返す(原稿は返さない)');
  ok(!String(done.fetch).includes('doc'), '替えた fetch は原稿を閉じ込めていない');
  ok(pending.fetch === origPending, '取り寄せの途中の係には触らない');
  ok(releaseFontFetchers(viewer) === 1 && done.fetch() === resource, '何度呼んでも同じ(組み上がりと組みはじめの両方で呼ぶ)');
}

// 2) 形が違っても落ちない(何もしない)
ok(releaseFontFetchers(null) === 0, 'ビューアが無ければ何もしない');
ok(releaseFontFetchers({}) === 0, '中身(adaptViewer_)が無ければ何もしない');
ok(releaseFontFetchers({ adaptViewer_: { fontMapper: {} } }) === 0, '書体の表が無ければ何もしない');
{
  const bad = { adaptViewer_: {} as Record<string, unknown> };
  Object.defineProperty(bad.adaptViewer_, 'fontMapper', {
    get() {
      throw new Error('読めない');
    },
  });
  let threw = false;
  try {
    releaseFontFetchers(bad);
  } catch {
    threw = true;
  }
  ok(!threw, '読むときに例外が出ても外へ投げない');
}

// 3) Vivliostyle の作りがいまも同じか(ソースを読む。上げたらここで気づく)
{
  const src = readFileSync('node_modules/@vivliostyle/core/lib/vivliostyle.js', 'utf8');
  ok(/this\.fontMapper=new \w+\(/.test(src), 'ビューアの中に fontMapper がある');
  ok(/srcURLMap\[s\]=o/.test(src) && /this\.srcURLMap\[s\]/.test(src), '書体の表は srcURLMap で、取り寄せ係を書体ごとに覚える');
  // 取り寄せ係: fetch を持ち、届いたら arrived を立て、get() は届いていれば手元の結果を返す
  const fetcher = /class\{constructor\(t,e\)\{d\(this,"fetch",t\);d\(this,"name"\);d\(this,"arrived",!1\);d\(this,"resource",null\)/.test(src);
  ok(fetcher, '取り寄せ係は fetch・arrived・resource を持つ');
  ok(/get\(\)\{return this\.arrived\?w\(this\.resource\):/.test(src), '届いた係の get() は手元の結果を返す(fetch を呼ばない)');
  ok(/deobfuscator\?e\.deobfuscator\(a\)/.test(src), '取り寄せの手順は書体の顔ぶれ(原稿の入れものにつながる)を閉じ込める');
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
