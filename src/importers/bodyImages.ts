// 原稿に入っていた本文の絵を、刷るのに要る大きさ・形にそろえる。Word(.docx)と Markdown(.md)の取り込みが通る。
// docx.ts にあったものを、Google ドキュメントの Markdown の絵も同じ道へ通すために分けた(2026-10-13)

import type { Chapter } from '../models/project';
import { optimizeImageDataUri } from '../images/optimize';

/**
 * 章の中の絵(image ブロック)の src を、その場で置き換える。
 *
 * Word は写真や図を PNG で持っていることが多い。そのまま抱えると
 * 保存も組版も紙PDFも重くなるので、透過を使っていないものは JPEG に置き換える
 * (実測: 利用者の入稿データで画像 10.16MB → 2.77MB)。
 *
 * 読めない絵(Word の EMF など)は取り込みを止めずに、そのまま残す。
 * 刷れない形式は入稿前チェックで知らせる(App の imgStats)。
 * 同じ絵が何度も出てくるとき(Google ドキュメントは同じ絵を1つの定義で何度も参照する)は、1度だけ直す
 */
export async function optimizeBodyImages(chapters: Chapter[]): Promise<void> {
  const done = new Map<string, Promise<string>>();
  for (const ch of chapters) {
    for (const b of ch.blocks) {
      if (b.type !== 'image') continue;
      const src = b.src;
      let next = done.get(src);
      if (!next) {
        next = optimizeImageDataUri(src).catch(() => src);
        done.set(src, next);
      }
      b.src = await next;
    }
  }
}
