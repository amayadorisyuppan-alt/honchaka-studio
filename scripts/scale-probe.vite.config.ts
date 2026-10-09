// scripts/check-cover-scale.py が使う、probe 専用の vite 設定。
// ふだんの設定(vite.config.ts)に、scale-probe.html だけを入口にする指定を足す。
// **開発サーバーを立てずに**静的なファイルへ組むための設定。
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';

export default mergeConfig(
  base,
  defineConfig({
    base: '/',
    build: {
      rollupOptions: { input: 'scripts/scale-probe.html' },
    },
  }),
);
