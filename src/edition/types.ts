// 版(エディション)の形。**版ごとに違うものは、この形の1つの値(EDITION)にまとめて持つ。**
//
// 標準の版は ./index.ts。組み立てのとき VITE_EDITION で別の版を選ぶと、vite.config.ts が
// ./index.ts の代わりにその版の部品を読み込む(標準の版では、ほかの版の部品は1つも読み込まない)。
// 画面と組版は出し先の名前で分けず、出し先の表(PRINT_TARGETS)の欄だけを見るので、
// 版で変わるのは「表に足す出し先」「ヘルプの文」「自動保存の置き場所の名前」「ソースの入手先」だけで済む。
import type { PrintTargetProfile } from '../models/project';

/** ヘルプの文の差し替え。標準の版の文(from)と1字も違わない文だけを、to に置き換える */
export interface HelpReplace {
  from: string;
  to: string;
}

/** ヘルプの箇条書きへの差し込み。標準の版の文(after)のすぐ後ろに、insert を足す */
export interface HelpInsert {
  after: string;
  insert: string;
}

export interface Edition {
  /** 版の名前。組み立てのときの VITE_EDITION と同じ */
  id: string;
  /**
   * 自動保存(IndexedDB)と、二重に開いたかを見る鍵の名前の末尾。
   * 自動保存はアドレス(オリジン)ごとに分かれ、フォルダでは分かれない。同じアドレスの別のフォルダに
   * 別の版を置くと、名前を分けないかぎり、同じブラウザで開いたときに互いの自動保存を上書きする
   */
  storageSuffix: string;
  /** 紙の出し先に足す会社。［作るもの］では「その他の印刷所」の前に、この順で並ぶ */
  printTargets: Readonly<Record<string, PrintTargetProfile>>;
  /** ヘルプの文の差し替えと差し込み(src/help/content.ts が、画面と配る .md の両方に当てる) */
  helpReplaces: readonly HelpReplace[];
  helpInserts: readonly HelpInsert[];
  /** ソースコードの入手先。省けば src/shop.ts の SOURCE_URL */
  sourceUrl?: string;
  /**
   * バージョンの番号のあとに付ける印(「1.1.0（○○版）」の「○○版」)。省けば付けない(標準の版)。
   * 不具合の報告で、どの版の話かを見分けるため(修正リストの 5。2026-10-12)。
   * 印の文字は標準の版に入れてはいけない語なので、各版の部品の側に置く
   */
  versionMark?: string;
}
