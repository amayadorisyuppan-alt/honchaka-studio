// お知らせ欄(src/notice.ts の parseNotices)の検査。(2026-10-11 1.0.2)
// notice.json は公開担当が手で書き換えるファイルなので、形が崩れていても画面を壊さず、出してよいものだけを出すことを確かめる。
// あわせて、同梱の public/notice.json がそのまま読めることも見る。
//
// 回し方(ブラウザも dev サーバーも要らない。リポジトリの頭で回す)
//   npx vite build --ssr scripts/notice.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/notice.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { readFileSync } from 'node:fs';
import { parseNotices } from '../src/notice';

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

ok(parseNotices(null).length === 0 && parseNotices({}).length === 0 && parseNotices({ notices: 'x' }).length === 0, '形が違えば何も出さない');
ok(parseNotices({ notices: [] }).length === 0, '空なら何も出さない');

const one = parseNotices({ notices: [{ id: 'a', text: ' 本文 ', level: 'warn', link: 'https://example.com/x', linkText: 'くわしく' }] });
ok(j(one) === j([{ id: 'a', text: '本文', link: 'https://example.com/x', linkText: 'くわしく', level: 'warn' }]), '1件をそのまま読む(前後の空白は落とす)', j(one));

ok(parseNotices({ notices: [{ id: 'a', text: '' }, { text: 'id なし' }, { id: 'b', text: 1 }] }).length === 0, 'id と文の無いもの・文字でないものは出さない');
ok(parseNotices({ notices: [{ id: 'a', text: 'x'.repeat(301) }] }).length === 0, '長すぎる文は出さない');
ok(parseNotices({ notices: [{ id: 'a', text: 'x', level: 'danger' }] })[0].level === 'info', '知らない level は info');

const links = parseNotices({
  notices: [
    { id: 'a', text: 'x', link: 'javascript:alert(1)' },
    { id: 'b', text: 'x', link: 'http://example.com' },
    { id: 'c', text: 'x', link: 'https://example.com/"onmouseover' },
  ],
});
ok(links.every((n) => n.link === undefined && n.linkText === undefined), 'https 以外のリンク・引用符の入ったリンクは捨てる', j(links));

const dated = { notices: [{ id: 'a', text: 'x', from: '2026-10-11', until: '2026-10-31' }] };
ok(parseNotices(dated, '2026-10-10').length === 0, 'from より前は出さない');
ok(parseNotices(dated, '2026-10-11').length === 1 && parseNotices(dated, '2026-10-31').length === 1, 'from の日と until の日は出す');
ok(parseNotices(dated, '2026-11-01').length === 0, 'until を過ぎたら出さない');
ok(parseNotices({ notices: [{ id: 'a', text: 'x', until: '10/31' }] }, '2026-11-01').length === 1, '日付の形が違う until は見ない(出し続ける)');

const shipped = parseNotices(JSON.parse(readFileSync('public/notice.json', 'utf8')), '2026-10-12');
ok(Array.isArray(shipped), '同梱の public/notice.json が読める', j(shipped));

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
