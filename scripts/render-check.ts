// 検査用: **アプリの初回起動と同じサンプル**(差し込みページ込み)を組版HTMLとして書き出す。
//
// 中身の組み立ては scripts/check-doc.ts に移した。**画面を測る preview-probe.ts と
// 同じ本を組むため**(別々に持つと「同じ本を測っていないのでは」が疑いとして残る)。
//
// 実行:
//   npx vite build --ssr scripts/render-check.ts --outDir dist/check
//   node dist/check/render-check.js 出力先.html
// 環境変数 WM=h を付けると横組み、DENSE=1 で区切り線を詰めて書き出す。
// SCENE=blank|star|stars|rule で場面転換の見た目を変える(省略するとアプリの既定=1行アキ)。
// PRINT_TARGET=printshop と RULES='{"bleedMm":3,...}'(PrintRules の JSON)で、印刷所の決まりで組む
// (scripts/check-bleed.py が使う)。SOLID=1 で挿絵ページの絵を赤い画素に、EST=201 でノド計算の推定ページ数を変える。
// TITLE=... で書名を差し替える(長い書名の大扉を測る)。TITLE_WM=h で縦組みの本の書名・著者名だけ横組みにする。
// 中綴じ(scripts/check-saddle.py): TRIM=a5・INK=mono・BINDING=saddle・SADDLE_COVER=self・PAD=白いページの枚数・FACES=1(共紙の表1・表4 に赤と青の絵を入れる)・NO_COLOPHON=1(書名も著者紹介も無い本。奥付が入らない)。
// 柱・ノンブルの位置(scripts/check-footer.py): TYPO=1(判型ごとの字・余白の既定を当てる)・EXTRA='{"nombreSlot":"top-fore"}'(設定の上書き JSON)・CHAPTER_TITLE=... で章題を全部差し替える。
// 見開きの絵(scripts/check-spread.py): SPREAD_SRC=<PNG のパス>・SPREAD_AT=<何章の前か>・SPREAD_BLANK=1(同じ切れ目の手前に白いクッションページ)・SPREAD_CONTROL=1(見開きの代わりに白い1ページ)。
// ふだんは scripts/check-typeset.py がこの手順ごと回すので、直に叩く必要は無い。
import { readFileSync, writeFileSync } from 'node:fs';
import type { Binding, InkColor, PrintRules, PrintTarget, SaddleCover, SceneBreakId, TrimId } from '../src/models/project';
import { buildCheckHtml, checkChapterCount } from './check-doc';

const out = process.argv[2] ?? 'out.html';
const html = buildCheckHtml({
  yoko: process.env.WM === 'h',
  dense: process.env.DENSE === '1',
  scene: process.env.SCENE as SceneBreakId | undefined,
  printTarget: process.env.PRINT_TARGET as PrintTarget | undefined,
  printRules: process.env.RULES ? (JSON.parse(process.env.RULES) as PrintRules) : undefined,
  estimatedPages: process.env.EST ? Number(process.env.EST) : undefined,
  solidArt: process.env.SOLID === '1',
  title: process.env.TITLE || undefined,
  titleYoko: process.env.TITLE_WM === 'h',
  trim: (process.env.TRIM as TrimId | undefined) || undefined,
  ink: (process.env.INK as InkColor | undefined) || undefined,
  binding: (process.env.BINDING as Binding | undefined) || undefined,
  saddleCover: (process.env.SADDLE_COVER as SaddleCover | undefined) || undefined,
  padPages: process.env.PAD ? Number(process.env.PAD) : undefined,
  faces: process.env.FACES === '1',
  noColophon: process.env.NO_COLOPHON === '1',
  typo: process.env.TYPO === '1',
  chapterTitle: process.env.CHAPTER_TITLE || undefined,
  extra: process.env.EXTRA ? JSON.parse(process.env.EXTRA) : undefined,
  spread: process.env.SPREAD_SRC
    ? {
        src: `data:image/png;base64,${readFileSync(process.env.SPREAD_SRC).toString('base64')}`,
        before: Number(process.env.SPREAD_AT ?? 1),
        blankBefore: process.env.SPREAD_BLANK === '1',
        control: process.env.SPREAD_CONTROL === '1',
      }
    : undefined,
});
writeFileSync(out, html, 'utf-8');
console.log(`written: ${out} (${html.length} chars) 章数=${checkChapterCount()}`);
