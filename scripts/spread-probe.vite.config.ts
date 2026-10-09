// scripts/spread-probe.mjs が使う、probe 専用の vite 設定。
// ふだんの設定(vite.config.ts)に、spread-probe.html だけを入口にする指定を足す。
// **開発サーバーを立てずに**静的なファイルへ組むための設定(app-probe.vite.config.ts と同じ作り)。
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';

export default mergeConfig(
  base,
  defineConfig({
    base: '/',
    build: {
      rollupOptions: { input: 'scripts/spread-probe.html' },
    },
  }),
);
