// 検索の題と、構造化データ(JSON-LD)の検査。(2026-10-19 修正リスト 40)
//
// ## なぜ在るか
//
// Google で「本ちゃか」と探すと、題が「ひっちゃか本づくりスタジオ」と出て、本ちゃかの名前が出なかった。
// 前の <title> と og:title は「本ちゃか — ひっちゃか本づくりスタジオ」で、Google が題を作り直すとき「—」の後ろだけを出していた。
// 画面の大きな見出し(h1)にも「本ちゃか」の字が無かった(入口の h1 は「原稿を、手触りのある一冊に。」)。
// 直したあと、名前を「本ちゃか」にそろえた所が、あとの直しでばらばらに戻らないように止める。
//
// ## 確かめること
//
// - <title> は index.html に1つだけ(試しの版の組み立てが、頭に【試し】を付けるため。vite.config.ts の channelHtml)で、頭が「本ちゃか」
// - og:title の頭が「本ちゃか」・og:site_name が「本ちゃか」・meta description と og:description が「本ちゃかは、」で始まる
// - 構造化データ(WebApplication): name が本ちゃか・alternateName がひっちゃか本づくりスタジオ・publisher があまやどり出版・無料・url が og:url と同じ
// - 入口の画面のいちばん上の見出し(h1)が、ロゴ「本ちゃか ひっちゃか本づくりスタジオ」(.hero-name)で、キャッチ「原稿を、手触りのある一冊に。」は h1 ではない
//   (画面の中身を描く検査はここには無いので、StartScreen.tsx のソースの形で見る)
//
// 題や説明の文は仮の文(Gemini 前)。文を直しても、頭の「本ちゃか」とこの検査の形が合っていればよい。
//
// ## 回し方(ブラウザも dev サーバーも要らない。scripts/private/run-tests.mjs が全部まとめて回す)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (!cond) {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}

const html = readFileSync('index.html', 'utf8');

/** <meta name|property="key" content="…" /> の content。属性の並びが決まっているので、改行をまたいでも拾う */
function meta(attr: 'name' | 'property', key: string): string | undefined {
  return new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`).exec(html)?.[1];
}

// ---- 題 ----
const titles = html.match(/<title>[^<]*<\/title>/g) ?? [];
ok(titles.length === 1, '<title> は index.html に1つだけ(試しの版の組み立てが頭に【試し】を付ける)', String(titles.length));
// 試しの版の検査(channel.test.ts)は、組み立てた index.html から【試し】を「最初の1つだけ」外して元と比べる。注などに同じ字があると、題より先にそちらが外れて落ちる
ok(!html.includes('【試し】'), 'index.html に【試し】の字を書かない(題の頭に付ける印と取り違えるため)');
const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
ok(title.startsWith('本ちゃか'), '<title> の頭が「本ちゃか」', title);
ok(title.includes('ひっちゃか本づくりスタジオ'), '<title> に「ひっちゃか本づくりスタジオ」も入っている', title);

// ---- og ----
const ogTitle = meta('property', 'og:title') ?? '';
ok(ogTitle.startsWith('本ちゃか'), 'og:title の頭が「本ちゃか」', ogTitle);
ok(ogTitle === title, 'og:title は <title> と同じ(食い違うと、SNS の題と検索の題が別になる)', `${ogTitle} / ${title}`);
ok(meta('property', 'og:site_name') === '本ちゃか', 'og:site_name は「本ちゃか」', meta('property', 'og:site_name'));

// ---- 説明 ----
const description = meta('name', 'description') ?? '';
ok(description.startsWith('本ちゃかは、'), 'meta description は「本ちゃかは、」で始まる', description);
const ogDescription = meta('property', 'og:description') ?? '';
ok(ogDescription.startsWith('本ちゃかは、'), 'og:description は「本ちゃかは、」で始まる', ogDescription);

// ---- 構造化データ ----
const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(ldBlocks.length === 1, '構造化データ(JSON-LD)が1つある', String(ldBlocks.length));
let ld: Record<string, unknown> = {};
try {
  ld = JSON.parse(ldBlocks[0] ?? '{}') as Record<string, unknown>;
} catch (e) {
  ok(false, '構造化データが JSON として読める', String(e));
}
ok(ld['@context'] === 'https://schema.org', '構造化データ: @context が schema.org');
ok(ld['@type'] === 'WebApplication', '構造化データ: WebApplication', String(ld['@type']));
ok(ld.name === '本ちゃか', '構造化データ: name は「本ちゃか」', String(ld.name));
ok(ld.alternateName === 'ひっちゃか本づくりスタジオ', '構造化データ: alternateName は「ひっちゃか本づくりスタジオ」', String(ld.alternateName));
const publisher = ld.publisher as { name?: string } | undefined;
ok(publisher?.name === 'あまやどり出版', '構造化データ: publisher は「あまやどり出版」', JSON.stringify(publisher));
ok(ld.isAccessibleForFree === true, '構造化データ: 無料(isAccessibleForFree)');
const offers = ld.offers as { price?: string; priceCurrency?: string } | undefined;
ok(offers?.price === '0' && offers?.priceCurrency === 'JPY', '構造化データ: 価格は0円', JSON.stringify(offers));
ok(ld.url === meta('property', 'og:url'), '構造化データの url は og:url と同じ(src/shop.ts の APP_URL とも)', `${ld.url} / ${meta('property', 'og:url')}`);
ok(ld.inLanguage === 'ja', '構造化データ: 日本語(inLanguage)');
// 題・og:title の「本ちゃか」と、構造化データの name の頭が同じ名前を指す
ok(title.startsWith(String(ld.name)), '構造化データの name が <title> の頭と同じ名前', `${ld.name} / ${title}`);

// ---- 入口の見出し(h1) ----
const start = readFileSync('src/components/StartScreen.tsx', 'utf8');
ok(/<h1 className="hero-name">\s*<StudioLogo[^>]*\/>\s*<\/h1>/.test(start), '入口のいちばん上の h1 は、ロゴ「本ちゃか ひっちゃか本づくりスタジオ」(.hero-name)');
ok(!/<h1 className="hero-h1"/.test(start), 'キャッチ「原稿を、手触りのある一冊に。」(.hero-h1)は h1 にしない');
ok(/<h2 className="hero-h1">原稿を、手触りのある一冊に。<\/h2>/.test(start), 'キャッチは見た目(.hero-h1)のまま h2 にある');
const logo = readFileSync('src/components/FrogMark.tsx', 'utf8');
ok(/<b>本ちゃか<\/b>/.test(logo) && /ひっちゃか本づくりスタジオ/.test(logo), 'ロゴ(StudioLogo)の文字に「本ちゃか」と「ひっちゃか本づくりスタジオ」がある');

if (failed) {
  console.log(`\n${failed} 件落ちた`);
  process.exit(1);
}
console.log('\n全部通った');
