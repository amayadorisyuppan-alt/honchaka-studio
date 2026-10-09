// 入稿用の変換(src/press)で、部品どうしが受け渡す型。
//
// 変換は「色を変える前の下ごしらえ → Ghostscript → あと始末 → 点検」の順に部品を通す(pipeline.ts)。
// 部品は別々に試せるように、PDF の中身(pdf-lib の PDFDocument)と、ここにある小さな型だけで話す。

/**
 * 本文1ページぶんの箱(mm)。**ノドは奇数・偶数ページで左右が入れ替わる。**
 *
 * PDF/X は、ページごとに「仕上がりの枠(TrimBox)」を持つことを求める。スタジオの本文は
 * 塗り足し込みの用紙で書き出すので、用紙のどこが仕上がりかをここで伝える
 */
export interface BodyBoxes {
  kind: 'body';
  /** 仕上がり(断裁後)の幅と高さ */
  trimW: number;
  trimH: number;
  bleedTop: number;
  bleedBottom: number;
  /** 小口側の塗り足し */
  bleedFore: number;
  /** ノド側の塗り足し。KDP 式(ノド側に付けない)は 0 */
  bleedGutter: number;
  /** 1ページ目のノドが、紙の左右どちら側か。2ページ目からは交互に入れ替わる */
  firstGutter: 'left' | 'right';
}

/** 表紙(表4・背・表1がつながった1枚)の箱(mm)。塗り足しは四辺に同じ幅 */
export interface CoverBoxes {
  kind: 'cover';
  /** 塗り足しを除いた、展開の幅と高さ */
  trimW: number;
  trimH: number;
  bleed: number;
}

export type PressBoxes = BodyBoxes | CoverBoxes;

/** 無彩色(R=G=B)を、色を変える前にグレーへ書き換えた数(neutral.ts) */
export interface NeutralReport {
  /** 描く命令(rg / RG など)を書き換えた数 */
  ops: number;
  /** 影の指定(Shading)を書き換えた数 */
  shadings: number;
  /** 画像を書き換えた数 */
  images: number;
  /** 無彩色かどうか調べられなかったもの(「何の・どのオブジェクト」) */
  skipped: string[];
  /**
   * skipped のうち、**描く命令を書き換えられなかった**もの(読めないストリーム・RGB のインライン画像・色空間を引き継ぐ Form とそれを呼ぶ側・
   * 色つきと無彩色が混じった色空間)。同じ文が skipped にも入っている。画像と影の skipped は入らない(その色の数え方は別に点検される)。
   * 文の中身を探して見分けない(文を直すと、利用者への知らせが黙って消えるため。2026-10-01 4-1 の 4)
   */
  opsSkipped: string[];
}

/** インクの総量を上限に収めた結果(inkLimit.ts)。単位は %(4色ベタで 400) */
export interface InkReport {
  limit: number;
  /** 抑える前の最大 */
  maxBefore: number;
  /** 抑えた後の最大。unhandled が空なら limit 以下 */
  maxAfter: number;
  /** 書き換えた画像・描く命令・影の指定の数 */
  images: number;
  ops: number;
  shadings: number;
  /** 上限を超えているかもしれないが、手を入れられなかったもの */
  unhandled: string[];
}

/**
 * 選んだ PDF の紙の大きさが、いまの本の用紙と違った(別の本の PDF か、判型や塗り足しを変える前に保存した PDF)。
 * 画面は、これが在るときは保存させずに「書き出し直してください」と言う。
 * **文の中身を探して見分けない**(violations の文を書き換えただけで、保存を止める判断が効かなくなるから)
 */
export interface PaperMismatch {
  /** 合わなかったページ(1 始まり) */
  pages: number[];
  /** 最初に合わなかったページの、実際の紙の大きさ mm */
  actualMm: { w: number; h: number };
  /** この本の用紙の大きさ mm */
  expectedMm: { w: number; h: number };
}

/** PDF/X-4 の形に整えた結果(pdfx.ts) */
export interface PdfxReport {
  /** 直したところの数(箱・合成の色空間など) */
  fixed: number;
  /** 整えたあとに残った、PDF/X-4 の決まりに合わないところ(空なら合っている) */
  violations: string[];
  /** 紙の大きさが合わなかったとき(合っていれば null か、無い) */
  paperMismatch?: PaperMismatch | null;
}

/** グレーの濃さを、刷り上がりが画面と同じ明るさになるように直した数(grayTone.ts) */
export interface GrayToneReport {
  /** 書き換えた描く命令・画像・影の指定の数 */
  ops: number;
  images: number;
  shadings: number;
  /** 直せなかったもの(「何の・どのオブジェクト」) */
  skipped: string[];
}
