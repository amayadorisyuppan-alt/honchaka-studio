// サンプル「青い背表紙」の文中の画像2枚(第二章の末尾の千鳥・第四章の全面「千鳥と青い本」)。
//
// **1.0.2 から、絵そのものは `public/sample/` のファイルに置く。**(2026-10-11 ユーザー判断。凍結解除後の修正リストの 7)
// 1.0.1 までは小さな JPEG を data URI の定数でここに埋め込んでいて、文庫でも「300ppi に届かない」の知らせが出ていた
// (章の途中 882×661 は A5 で 226dpi、全面 777×1038 は文庫で 188dpi)。足りる大きさ(2枚で約 2.2MB)を埋め込むと、
// 入口を開いただけで全員が読むアプリ本体の JS がそのぶん重くなる。そこで、ほかのサンプルの絵(見開きの通り・地図)と同じく
// ファイルにして、サンプルを開くときに取りに行く(sampleArt.ts の withSampleFigs。store/useProject.ts の applySampleArt から呼ぶ)。
//
// **原稿には「同じ画素数の代わりの絵」を入れておく。** sampleManuscript() は同期で呼ばれる
// (store の初期値・freshenSample・CLI の検査 check-doc / layout-matrix など)ので、fetch を待てない。
// そこで、本物と**同じ画素数**を名乗る1色の SVG を data URI で入れる。本文の中の絵は「箱に入りきらなければ縮め、
// 小さければそのままの大きさ」で置かれ(models/imageResolution.ts の頭)、全面は用紙いっぱいに切り出して敷かれるので、
// ページ割りを決めるのは画素数(縦横比)だけ。代わりの絵でも本物でも、同じページに同じ大きさで組まれる。
// Node の検査が画面と別の本を組む事故(2026-08-21 の署名の件)を作らないのは、この画素数が本物と同じだから。
// **絵を差し替えたら、下の w・h も直すこと**(scripts/sample-figs.test.ts がファイルの画素数との食い違いを止める)。
//
// **絵の出どころ。** GPT Image 2.5・4k・high で 2026-10-10 に新しく描いた
// (amayadori-cover-packs/新規生成/ の 353 と 356。a・b の2案から 2026-10-11 にユーザーが選んだ: 全面は a、章の途中は b)。
// 章の途中の1枚は、生成したものを**灰色ちょうど**にした版(356_…_4k_b_グレー.jpg)から作る。サンプルは見本なので、
// 「白黒に見えて色が少しずれている絵」の知らせ(修正リストの 4-6)を出さない絵にしておく。
// 大きさは、全面が生成そのままの 2480×3312(A5 全面で 389dpi・B5 で 319dpi。q80 で約 1.6MB)、
// 章の途中が 2200×1647(本文の幅 186mm でも 300dpi。灰色1色の q85 で約 0.6MB)。
//
// ---- 以下は 1.0.1 までの頭のコメントから引き継いだ、置き場所と絵柄の理由 ----
//
// **なぜ入れるか。** 章の途中の絵(本文の流れの中で組まれる画像。［挿絵］で段落を選んで入れる)と、
// 大きさ「全面（1ページ）」の絵は、どちらもサンプルで一度は見せる(記法16種を本文に織り込んだのと同じ理屈。
// 千鳥は 2026-08-22、全面は 2026-09-14 ユーザー要望「Wordで全面に入れる本文中画像の例もサンプルに入れたい」)。
// どちらも［挿絵］で入れた絵の形で持つ(sample.ts の fromStudio)。Word に貼る見本ではない。
//
// **なぜ千鳥か。** 第一章「羽を休めている、小さな鳥」が第二章の古書店で千鳥だと判明する。
// 全面は、千鳥が封筒をくわえて青い本の上に立つ — 第四章で読まれる「鳥の郵便配達人」の話と、
// 書名『青い背表紙』、雨の窓、遠景の灯台(灯台守の話)まで、物語の要素をぜんぶ1枚に入れてある。
//
// **どこに置くか。** 章の途中の千鳥は第二章の最終ページの頭に当たる段落(「いい買いものだ…」)の直前、
// 全面は第四章の小見出し「最初の頁」の直前(位置を決めた実測は sample.ts の挿入箇所のコメント)。
//
// **白地の絵にする(章の途中)。** 端まで描き込んだ版は文庫の紙面で四角い濃い塊になる。白地に溶ける絵なら紙の続きに見える。
//
// **AI 申告。** サンプルは同梱プリセットの絵(fromPreset)で既に「はい」になる。
// この2枚も AI 製だが、原稿ごと差し替えれば消えるものなので判定には足さない。

export interface SampleFig {
  /** public/sample/ の下のファイル名 */
  file: string;
  /** ファイルの画素数。代わりの絵もこの大きさを名乗る */
  w: number;
  h: number;
  /** 原稿に入れておく代わりの絵(同じ画素数の1色の SVG)。差し替えるときは、この文字列と同じ src を探す */
  placeholder: string;
}

/** 本物と同じ画素数を名乗る1色の SVG。中身は読み込み中に一瞬見えるだけなので、紙に近い色にしておく */
function standIn(w: number, h: number, fill: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${fill}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 千鳥のペン画(灰色ちょうど)。第二章の末尾で本文が回り込む */
export const SAMPLE_FIG_PEN: SampleFig = {
  file: 'chidori-pen.jpg',
  w: 2200,
  h: 1647,
  placeholder: standIn(2200, 1647, '#f7f7f5'),
};

/** 千鳥と封筒と青い本(カラー)。第四章の全面ページ */
export const SAMPLE_FIG_COVER: SampleFig = {
  file: 'chidori-full.jpg',
  w: 2480,
  h: 3312,
  placeholder: standIn(2480, 3312, '#e9e7e2'),
};

export const SAMPLE_FIGS: readonly SampleFig[] = [SAMPLE_FIG_PEN, SAMPLE_FIG_COVER];

/** sample.ts が原稿に入れる src(代わりの絵) */
export const SAMPLE_FIG = SAMPLE_FIG_PEN.placeholder;
export const SAMPLE_FIG_FULL = SAMPLE_FIG_COVER.placeholder;
