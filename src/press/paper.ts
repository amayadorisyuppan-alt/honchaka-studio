// 紙の大きさ(mm)を、利用者に見せる形にする。画面(PressConvert)と変換の失敗の文(pipeline.ts)で同じ言い方にするための小さな部品。
//
// 値だけを扱うので、pdf-lib を読み込まない(画面の側の塊に入れても重くならない)。
// 「111×154mm」のように、小数が .0 のときは整数で言う(111.0×154.0mm と言うと、細かい違いがあるように読めるため。2026-10-01)

/** mm の数を、小数 1 けたまでで言う。.0 は付けない(111 → 111、111.2 → 111.2、110.96 → 111) */
export function mmText(n: number): string {
  return String(Number(n.toFixed(1)));
}

/** 幅×高さ(mm)を「111×154mm」の形にする */
export function paperSizeText(mm: { w: number; h: number }): string {
  return `${mmText(mm.w)}×${mmText(mm.h)}mm`;
}
