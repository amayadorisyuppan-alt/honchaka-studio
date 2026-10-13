// 取り込みの結果の形。.txt / .md / .docx のどれも同じ形で返す(importers/load.ts の parseSource)。
// docx.ts に置いていたのを、md・txt や見張り(guard.ts)が Word の取り込み(mammoth)を読まずに使えるよう分けた(2026-10-13)

import type { Manuscript } from '../models/project';

/** 取り込みの結果。原稿と、**本文に入れなかったもの**の断り */
export interface ImportResult {
  manuscript: Manuscript;
  /**
   * 本文に取り込まなかった［コラム］見出しの、その見出しの字。
   * 画面で「何を入れなかったか」を言うために持つ(黙って捨てない)。.txt / .md には目印が無いので、いつも空
   */
  skippedColumnPages: string[];
  /**
   * 取り込みで言っておくこと。ルビを記号に置き換えた数、読めずに飛ばした部分(Word。2026-09-25 見直し S1-7)、
   * 字に置き換えた画像などのデータを取り除いた数・組版に時間がかかること(どの形式も。importers/guard.ts)、
   * .md の中の取り込めなかった絵・Google ドキュメントの絵のきめが足りないこと(importers/mdPrep.ts)。
   * **黙って字を落とさない**
   */
  notes?: string[];
}
