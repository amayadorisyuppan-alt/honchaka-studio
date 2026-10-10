// アプリが積んでいる書体を、まとめて読み込むだけのファイル。
//
// **検査からも同じものを読ませるために切り出した。**(2026-08-22)
// `typeset/fontface.ts` の `collectFontFaceCss` は
// **動いているページのスタイルシートから @font-face を拾う**ので、
// これが読み込まれていないと、検査は「@font-face が1つも無い本」を測ってしまう。
// 実測では、ここが有るか無いかで組み上がりが 10秒 → 数十秒に変わる。
//
// 本文・表紙で選べる書体(models/project.ts の BODY_FONTS と models/cover.ts の COVER_FONTS)。
// いずれも SIL Open Font License 1.1 / Apache-2.0 で、PDF への埋め込みと同梱・再配布ができる。
// vite.config.ts の woff2Only プラグインが woff(旧形式)を落とすので、出るのは woff2 だけ。
// Noto Sans JP / Noto Serif JP だけは、@fontsource のものから輪郭の重なりを取り除いた写しを読む。
// fontsource のままだと、KDP の印刷で線の交わりが白く抜ける(2026-10-10 校正紙。理由は scripts/build-noto-fonts.py)
import './fonts/noto.css';
import '@fontsource/shippori-mincho/400.css';
import '@fontsource/shippori-mincho/700.css';
import '@fontsource/zen-old-mincho/400.css';
import '@fontsource/zen-old-mincho/700.css';
import '@fontsource/biz-udmincho/400.css';
import '@fontsource/biz-udmincho/700.css';
import '@fontsource/kaisei-opti/400.css';
import '@fontsource/kaisei-opti/700.css';
import '@fontsource/klee-one/400.css';
import '@fontsource/klee-one/600.css';
import '@fontsource/biz-udpgothic/400.css';
import '@fontsource/biz-udpgothic/700.css';
import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/700.css';
import '@fontsource/ibm-plex-sans-jp/400.css';
import '@fontsource/ibm-plex-sans-jp/700.css';
import '@fontsource/yuji-syuku/400.css';
import '@fontsource/zen-maru-gothic/400.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource/dotgothic16/400.css';
import '@fontsource/reggae-one/400.css';
// npm に無い書体(源暎こぶり明朝)は自前でホストする
import './fonts.css';
// 縦中横(.tcy)専用の詰め数字。scripts/build-tcy-fonts.py が各書体から作る(理由はそこに)
import './fonts/tcy.css';
