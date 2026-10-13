// scripts/sample-fig-probe-run.mjs が使う、検査専用の vite 設定。
// ふだんの設定(vite.config.ts。関数の形なので mergeConfig は使えず、呼んで得た設定へ足す)に、
// sample-fig-probe.html だけを入口にする指定を足す。開発サーバーを立てずに静的なファイルへ組む。
import { defineConfig, mergeConfig, type ConfigEnv } from 'vite';
import base from '../vite.config';

export default defineConfig(async (env: ConfigEnv) => {
  const b = typeof base === 'function' ? await base(env) : base;
  return mergeConfig(b, {
    base: '/',
    build: {
      rollupOptions: { input: 'scripts/sample-fig-probe.html' },
    },
  });
});
