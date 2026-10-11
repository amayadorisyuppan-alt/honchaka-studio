// サンプルの文中の画像(千鳥2枚。src/sampleFig.ts)の検査。(2026-10-11 1.0.2)
//
// sampleManuscript() は本物と**同じ画素数**の代わりの絵を入れ、ページ割りはその画素数で決まる。
// 本物(public/sample/ のファイル)を差し替えて画素数が変わったのに sampleFig.ts の w・h を直し忘れると、
// サンプルを開いた直後(代わりの絵)と本物が届いたあと、また Node の検査と画面とで、別の本を組むことになる。それをここで止める。
//
// 回し方(ブラウザも dev サーバーも要らない。リポジトリの頭で回す)
//   npx vite build --ssr scripts/sample-figs.test.ts --outDir <出力先> --emptyOutDir --logLevel warn
//   node <出力先>/sample-figs.test.js          (出力先がリポジトリの外なら .mjs に名前を変えて回す)
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE_FIGS, SAMPLE_FIG_PEN } from '../src/sampleFig';
import { sampleManuscript } from '../src/sample';
import { hasSampleFigStandIns, replaceSampleFigs } from '../src/sampleArt';

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

/** JPEG の SOF から 幅・高さ・色の数 を読む */
function jpegInfo(buf: Buffer): { w: number; h: number; comps: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // SOF0〜SOF15(DHT C4・JPG C8・DAC CC を除く)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

for (const f of SAMPLE_FIGS) {
  const info = jpegInfo(readFileSync(join('public', 'sample', f.file)));
  ok(!!info && info.w === f.w && info.h === f.h, `${f.file} の画素数が sampleFig.ts の w・h と同じ`, JSON.stringify(info));
  const svg = decodeURIComponent(f.placeholder.replace(/^data:image\/svg\+xml,/, ''));
  ok(svg.includes(`width="${f.w}"`) && svg.includes(`height="${f.h}"`), `${f.file} の代わりの絵が同じ画素数を名乗る`, svg);
  ok(f.placeholder.length < 400, `${f.file} の代わりの絵は小さい(アプリ本体を重くしない)`, String(f.placeholder.length));
}
const pen = jpegInfo(readFileSync(join('public', 'sample', SAMPLE_FIG_PEN.file)));
ok(pen?.comps === 1, '章の途中の千鳥は灰色1色の JPEG(「白黒に見えてカラー」の知らせを出さない)', String(pen?.comps));

// 2枚とも、本物の大きさなら文庫〜A5 で 300ppi に届く(1.0.1 は文庫でも知らせが出ていた)
const a5Full = { w: 148 + 3.175 * 2, h: 210 + 3.175 * 2 };
const cover = SAMPLE_FIGS.find((f) => f.file === 'chidori-full.jpg')!;
const ppiFull = Math.min((cover.w * 25.4) / a5Full.w, (cover.h * 25.4) / a5Full.h);
ok(ppiFull >= 350, 'A5 の全面でも 350ppi 以上', ppiFull.toFixed(0));

const ms = sampleManuscript();
ok(hasSampleFigStandIns(ms), 'sampleManuscript() は代わりの絵を入れる');
const real = new Map(SAMPLE_FIGS.map((f) => [f.placeholder, `data:image/jpeg;base64,${f.file}`]));
// 利用者が差し替えた絵(別の src)には触らないこと
const mine = 'data:image/png;base64,MINE';
ms.chapters[0].blocks.push({ type: 'image', src: mine });
const out = replaceSampleFigs(ms, real);
const srcs = out ? out.chapters.flatMap((c) => c.blocks.flatMap((b) => (b.type === 'image' ? [b.src] : []))) : [];
ok(!!out && !hasSampleFigStandIns(out), '差し替えると代わりの絵が残らない');
ok(srcs.filter((s) => s.startsWith('data:image/jpeg;base64,chidori')).length === 2, '千鳥2枚とも本物になる', JSON.stringify(srcs));
ok(srcs.includes(mine), '利用者の絵はそのまま');
ok(replaceSampleFigs(out!, real) === null, '差し替え済みの原稿には何もしない');
ok(replaceSampleFigs(sampleManuscript(), new Map()) === null, '本物が取れなければ何もしない(代わりの絵のまま組む)');

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
