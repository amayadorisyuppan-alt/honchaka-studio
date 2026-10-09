import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatHits, loadPatterns, scanTree } from './scripts/build/leak-scan.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * @fontsource の CSS から woff(旧形式)の src を落とし、woff2 だけにする。
 *
 * 日本語フォントは1書体1ウェイトで約120個のサブセットに分かれており、
 * 両形式を出すと dist が倍になる(実測: 書体を9つ積んだ時点で 127MB)。
 * このアプリは Vivliostyle が動く Chromium 系ブラウザが前提で、
 * woff しか読めない環境ではそもそもプレビューが動かないため、woff2 だけでよい。
 */
function woff2Only(): Plugin {
  return {
    name: 'woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@fontsource') || !id.endsWith('.css')) return null;
      // src: url(...woff2) format('woff2'), url(...woff) format('woff');
      const out = code.replace(
        /,\s*url\([^)]*\.woff['"]?\)\s*format\(\s*['"]woff['"]\s*\)/g,
        '',
      );
      return out === code ? null : { code: out, map: null };
    },
  };
}

/*
 * **版(エディション)の切り替え。**(2026-10-10)
 *
 * 同じソースから、組み立てのときの指定で版を選ぶ。指定は VITE_EDITION か --mode(どちらも public か partner)。
 * 何も指定しなければ標準の版(public)。版ごとに違うものは src/edition/index.ts の EDITION 1つにまとめてあり、
 * partner の版では、その代わりに src/partners/index.ts を読み込む(この部品は標準の版のソースには入っていない)。
 *
 * 標準の版では、src/partners/ の下を1つでも読み込んだら組み立てを止める。
 * さらに、出してはいけない語の一覧(scripts/private/forbidden-words.json。標準の版のソースには入っていない)が
 * あれば、組み上がった dist を全部調べ、1つでも見つかれば dist を消して止める
 */
const EDITIONS = ['public', 'partner'] as const;
type EditionId = (typeof EDITIONS)[number];
const EDITION_DEFAULT = resolve(ROOT, 'src/edition/index.ts');
const EDITION_ENTRY: Record<Exclude<EditionId, 'public'>, string> = {
  partner: resolve(ROOT, 'src/partners/index.ts'),
};
const PARTNERS_DIR = resolve(ROOT, 'src/partners');
const FORBIDDEN_LIST = resolve(ROOT, 'scripts/private/forbidden-words.json');

/** パスを比べるための形(Windows の \ と、ドライブ名の大文字小文字をそろえる) */
const norm = (p: string) => p.replace(/\\/g, '/').replace(/[?#].*$/, '').toLowerCase();

function editionOf(mode: string): EditionId {
  const e = process.env.VITE_EDITION || (mode === 'partner' ? 'partner' : 'public');
  if (!(EDITIONS as readonly string[]).includes(e)) {
    throw new Error(`VITE_EDITION は ${EDITIONS.join(' か ')} です(いまは「${e}」)`);
  }
  if (e !== 'public' && !existsSync(EDITION_ENTRY[e as Exclude<EditionId, 'public'>])) {
    throw new Error(`「${e}」の版の部品がありません。このソースで組み立てられるのは標準の版(public)だけです`);
  }
  return e as EditionId;
}

/** 版の部品を差し替える。標準の版では、ほかの版の部品を読み込んだら止める */
function editionSwap(edition: EditionId): Plugin {
  return {
    name: 'edition-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (edition === 'public' || !importer || !/(^|\/)edition(\/index(\.ts)?)?$/.test(source)) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!r || norm(r.id) !== norm(EDITION_DEFAULT)) return null;
      return EDITION_ENTRY[edition];
    },
    load(id) {
      if (edition === 'public' && norm(id).startsWith(norm(PARTNERS_DIR) + '/')) {
        this.error(`標準の版の組み立てで、ほかの版の部品を読み込もうとしました: ${id}`);
      }
      return null;
    },
  };
}

/** 標準の版の dist に、出してはいけない語が無いかを調べる。見つかれば dist を消して止める */
function leakGuard(edition: EditionId): Plugin {
  let outDir = '';
  let ssr = false;
  return {
    name: 'leak-guard',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
      ssr = !!c.build.ssr;
    },
    closeBundle() {
      // 検査用の SSR の組み立て(scripts/*.test.ts)は配らないので見ない
      if (edition !== 'public' || ssr) return;
      if (!existsSync(FORBIDDEN_LIST)) {
        if (existsSync(PARTNERS_DIR)) {
          rmSync(outDir, { recursive: true, force: true });
          throw new Error(`ほかの版の部品があるのに、語の一覧(${FORBIDDEN_LIST})がありません。dist を消して止めました`);
        }
        return;
      }
      const { hits, files } = scanTree(outDir, loadPatterns(FORBIDDEN_LIST));
      if (files === 0) throw new Error(`dist にファイルが1つもありません(調べられません): ${outDir}`);
      if (hits.length) {
        rmSync(outDir, { recursive: true, force: true });
        throw new Error(`標準の版の dist に、出してはいけない語が ${hits.length} 件ありました。dist を消して止めました:\n${formatHits(hits)}`);
      }
      console.log(`[leak-guard] 標準の版の dist を ${files} ファイル調べました。出してはいけない語はありません`);
    },
  };
}

// base: './' — Xserver のサブディレクトリ(例: /bookmaker/)に置いても動くよう相対パスにする
export default defineConfig(({ mode }) => {
  const edition = editionOf(mode);
  return {
    base: './',
    plugins: [woff2Only(), editionSwap(edition), react(), leakGuard(edition)],
    server: {
      // Vite は既定で PORT 環境変数を見ない(5173 が埋まっていると勝手に隣へずれる)。
      // 別のセッションが 5173 を使っているときに、渡されたポートで確実に上がるようにする
      port: Number(process.env.PORT) || 5173,
    },
    build: {
      target: 'es2020',
      // 版ごとに置き場所を分ける(取り違えて上げないように)。--outDir を渡せばそちらが勝つ
      outDir: edition === 'public' ? 'dist' : `dist-${edition}`,
    },
    // 入稿用の変換の Worker(src/press/gsWorker.ts)は、Ghostscript を押されたときに読み込む(dynamic import)。
    // 既定の iife 形式の Worker では dynamic import が使えないので、ES モジュールで出す
    worker: {
      format: 'es',
      plugins: () => [editionSwap(edition)],
    },
  };
});
