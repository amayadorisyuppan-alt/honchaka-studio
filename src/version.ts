// アプリのバージョン(package.json の version)。組み立てのときに vite.config.ts の define が埋め込む。(2026-10-12 1.0.3)
// ［このアプリについて］とエラーの画面に出す。公開版は GitHub の同じ名前のタグ(v1.0.3 など)と対応する。
// vite を通さずに読まれたとき(node の道具など)は 'dev'

declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
