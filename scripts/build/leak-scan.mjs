// 書き出したファイルの中に、出してはいけない語が残っていないかを調べる道具。
//
// 語の一覧はこの道具には書かない(一覧そのものを配らないため)。一覧のファイルを渡して使う。
// 一覧は JSON の配列で、1件ずつ { "re": "正規表現", "flags": "iu"(省略可), "why": "なぜ止めるか" }。
//
// 調べるもの:
// - ファイルの名前(パス)。%xx の形も戻してから見る
// - 中身。そのままの UTF-8 に加え、\uXXXX・\u{…}・\xXX・&#…;・%xx の書き換えを戻した形、
//   全角・半角をそろえた形(NFKC)、ゼロ幅の文字を抜いた形でも見る。文字の画像・フォント・圧縮した中身は
//   読めないので、文字としてそのまま入っているものだけを拾う(UTF-16 でも見る)
//
//   node scripts/build/leak-scan.mjs <一覧の .json> <調べるフォルダ>     見つかれば終了コード 1
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 文字として読む拡張子。これ以外(画像・フォント・wasm など)は、そのままの並びだけを見る */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.json', '.map', '.md', '.txt',
  '.svg', '.xml', '.yml', '.yaml', '.webmanifest', '.csv', '.tsv', '.py', '.ps1', '.bat', '.cmd', '.sh',
  '.toml', '.ini', '.cfg', '.htaccess', '.gitignore', '.env', '',
]);
/** 中身が圧縮されていて、文字が並びとして現れない形式。UTF-16 で読み直さない(時間の無駄) */
const PACKED_EXT = new Set(['.woff2', '.woff', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.zip', '.gz', '.br', '.pdf', '.wasm', '.onnx', '.icc']);

export function loadPatterns(file) {
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || list.length === 0) throw new Error(`語の一覧が空か、形が違います: ${file}`);
  return list.map((p) => ({ re: new RegExp(p.re, p.flags ?? 'iu'), why: p.why ?? p.re }));
}

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

function decodeEscapes(t) {
  return t
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeChar(Number(d)))
    .replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
}
function safeChar(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * data: URI の base64 を戻した中身(つなげたもの)。小さな画像・SVG・JSON は JS の中に base64 で埋め込まれるので、
 * そのままでは文字が見えない(2026-10-10 見直しの指摘)。中身は UTF-8 として読む
 */
function dataUriPayloads(text) {
  const parts = [];
  for (const m of text.matchAll(/data:[\w/+.-]*(?:;[\w=-]+)*;base64,([A-Za-z0-9+/]{8,}={0,2})/g)) {
    try {
      parts.push(Buffer.from(m[1], 'base64').toString('utf8'));
    } catch {
      // 読めない base64 は飛ばす
    }
  }
  return parts.join('\n');
}

/** 調べる形を全部並べる。同じ語を、書き換えられた形でも取りこぼさないため */
function forms(text) {
  const decoded = decodeEscapes(text);
  const out = [text];
  if (decoded !== text) out.push(decoded);
  const norm = decoded.normalize('NFKC').replace(ZERO_WIDTH, '');
  if (norm !== decoded) out.push(norm);
  const embedded = dataUriPayloads(text);
  if (embedded) out.push(embedded, decodeEscapes(embedded).normalize('NFKC').replace(ZERO_WIDTH, ''));
  return out;
}

function excerpt(text, index, len) {
  const a = Math.max(0, index - 30);
  const b = Math.min(text.length, index + len + 30);
  return text.slice(a, b).replace(/\s+/g, ' ');
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

/**
 * フォルダの下を全部調べて、見つかったものを返す(空なら漏れなし)。
 * skip は、調べない相対パスの判定(省略可。node_modules など)
 */
export function scanTree(root, patterns, skip = () => false) {
  const hits = [];
  let files = 0;
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split(sep).join('/');
    if (skip(rel)) continue;
    files++;
    for (const name of forms(rel.normalize('NFC'))) {
      for (const p of patterns) {
        const m = p.re.exec(name);
        if (m) hits.push({ file: rel, where: 'ファイル名', why: p.why, excerpt: excerpt(name, m.index, m[0].length) });
      }
    }
    const buf = readFileSync(abs);
    const ext = extname(abs).toLowerCase();
    const texts = TEXT_EXT.has(ext) ? forms(buf.toString('utf8')) : [buf.toString('utf8')];
    if (!PACKED_EXT.has(ext)) texts.push(buf.toString('utf16le'));
    const seen = new Set();
    for (const t of texts) {
      for (const p of patterns) {
        const m = p.re.exec(t);
        if (!m) continue;
        const key = `${p.why}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ file: rel, where: '中身', why: p.why, excerpt: excerpt(t, m.index, m[0].length) });
      }
    }
  }
  return { hits, files };
}

export function formatHits(hits) {
  return hits.map((h) => `  ${h.file}(${h.where}) … ${h.why}: 「${h.excerpt}」`).join('\n');
}

// 直に回したとき
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [listFile, dir] = process.argv.slice(2);
  if (!listFile || !dir) {
    console.error('使い方: node scripts/build/leak-scan.mjs <一覧の .json> <調べるフォルダ>');
    process.exit(2);
  }
  const { hits, files } = scanTree(dir, loadPatterns(listFile), (rel) => rel.startsWith('node_modules/') || rel.startsWith('.git/'));
  // 1つも調べられなかったのは、場所の取り違え。「漏れなし」と言わない
  if (files === 0) {
    console.error(`調べるファイルが1つもありません: ${dir}`);
    process.exit(2);
  }
  if (hits.length) {
    console.error(`出してはいけない語が ${hits.length} 件見つかりました(${files} ファイルを調べた):\n${formatHits(hits)}`);
    process.exit(1);
  }
  console.log(`漏れなし(${files} ファイルを調べた)`);
}
