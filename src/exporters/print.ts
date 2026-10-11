// 紙PDF出力。
// PDFを直接生成するのではなく、Vivliostyle の printHTML で印刷用に組版し直した
// iframe を作り、ブラウザの印刷ダイアログ(「PDFに保存」)を開かせる方式をとる。
// プレビューと同じ組版エンジン・同じCSSを通るので、画面とページ配分が一致する。

import { printHTML } from '@vivliostyle/core';
import { fontUrlsIn, prefetchFonts } from '../preview/fontPrefetch';

/**
 * 組版HTMLを印刷ダイアログに送る。
 * resolve = ダイアログを開くところまで成功。実際に保存したかは知りようがない。
 *
 * `fileTitle` は「PDF に保存」の既定のファイル名になる(拡張子なし)。
 * **Chrome は、印刷する枠ではなく画面そのもののタイトルをファイル名に使う。**(2026-09-26 ユーザー報告
 * 「本文をDLしたらファイル名が『ひっちゃか本づくりスタジオ — 縦書き・横書き _ 電子・紙 同時制作』。
 * 表紙は『sakura_表紙』で落ちるので、本文も同じように」) 印刷ダイアログを開いているあいだだけ
 * 画面のタイトルを差し替え、閉じたら戻す(print() はダイアログを閉じるまで戻ってこない)
 */
export async function printToPdf(html: string, fileTitle: string, pageCss = ''): Promise<void> {
  /*
   * **刷る枠の中でも、Vivliostyle は本の書体を全部いっぺんに読む。**(2026-10-11 1.0.3。修正リストの 17)
   * 本番の Xserver は一斉の取得の一部を断り、断られた字は PDF に別の書体で入る。先に少しずつ取っておく
   * (下見で取ってあれば、すぐ戻る。src/preview/fontPrefetch.ts)
   */
  await prefetchFonts(fontUrlsIn(html));
  /*
   * **紙の PDF にはリンクを入れない。**(2026-09-26 ユーザーの KDP 入稿テストで発見)
   * KDP の Print Previewer が「印刷できないマークアップ（HTML形式のタグによる書体や修飾）を原稿から
   * 削除しました」と目次のページを指した。目次の章題(と本文の Markdown のリンク)は <a href> で、
   * Chrome は PDF にリンクの注釈を入れる。紙では押せないので、href だけ外す
   * (<a> は残すので、目次のリーダー線などの CSS はそのまま効く。ページ番号は data-page から引く)
   */
  const printable = html.replace(/<a\s+href="[^"]*"/g, '<a');
  return new Promise((resolve, reject) => {
    printHTML(printable, {
      title: fileTitle,
      printCallback: (iframeWin) => {
        /*
         * **組み上がった紙面にだけ効く CSS を、刷る直前に足す。**(2026-10-09)
         * Vivliostyle の CSS では書けない、ページ単位の指定(:has で「この章のページ」を選ぶもの。
         * 章・コラムだけの帯 platePageRules)。下見は paint.ts が同じ規則を足している
         */
        if (pageCss) {
          const st = iframeWin.document.createElement('style');
          st.textContent = pageCss;
          iframeWin.document.head.appendChild(st);
        }
        const appTitle = document.title;
        document.title = fileTitle;
        try {
          iframeWin.print();
        } finally {
          document.title = appTitle;
        }
        resolve();
      },
      errorCallback: (message) => reject(new Error(message)),
      hideIframe: true,
      removeIframe: true,
    });
  });
}
