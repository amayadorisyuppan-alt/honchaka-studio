// 開発用: サンプル原稿を組版HTMLとして書き出す(CLI経由のPDF検証に使う)
// 実行: npx tsx scripts/render-sample.ts [出力パス]
import { writeFileSync } from 'node:fs';
import { defaultSettings } from '../src/models/project';
import { manuscriptHtml } from '../src/typeset/html';
import { sampleManuscript } from '../src/sample';

const out = process.argv[2] ?? 'docs/sample-book.html';
const html = manuscriptHtml(sampleManuscript(), defaultSettings());
writeFileSync(out, html, 'utf-8');
console.log(`written: ${out} (${html.length} chars)`);
