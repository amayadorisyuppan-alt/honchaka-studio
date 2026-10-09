// 塗り足しの形と、それを文で言う関数。**何も import しない**(葉のモジュール)。
//
// 版(src/edition)が足す出し先も、塗り足しの伝え方(bleedNote)でこの関数を使う。
// models/project.ts は版の部品を読み込むので、版の部品が project.ts から値を import すると循環になり、
// 読み込む順番しだいで「EDITION がまだ無い」で落ちる(2026-10-10 見直しで再現)。だから project.ts から切り出した。
// project.ts からも同じ名前で書き出しているので、ほかの部品はいままでどおり project.ts から読んでよい

/** 塗り足し(mm)。天・地・小口・ノドの4辺それぞれ。ノド側は綴じる側 */
export interface Bleed4 {
  top: number;
  bottom: number;
  fore: number;
  gutter: number;
}

/** mm の数字を、末尾の 0 を落として言う(3 → "3"、3.2 → "3.2"、2.55 → "2.55") */
export function fmtMm(v: number): string {
  return `${Number(v.toFixed(2))}`;
}

/**
 * 塗り足しを「どの辺に・どれだけ」で言う。0 の辺は言わない。
 * 全部同じ幅なら「天・地・小口・ノドの四辺に 3mm」「天・地・小口の三辺に 3.2mm」、
 * 辺ごとに違えば「天 3mm・地 4mm・小口 3mm」と並べる。全部 0 なら「付けない」
 */
export function bleedSidesText(b: Bleed4): string {
  const sides: [string, number][] = [
    ['天', b.top],
    ['地', b.bottom],
    ['小口', b.fore],
    ['ノド', b.gutter],
  ];
  const on = sides.filter(([, v]) => v > 0);
  if (on.length === 0) return '付けない';
  if (on.every(([, v]) => v === on[0][1])) {
    const names = on.map(([n]) => n).join('・');
    const count = on.length === 4 ? 'の四辺' : on.length === 3 ? 'の三辺' : on.length === 2 ? 'の二辺' : '';
    return `${names}${count}に ${fmtMm(on[0][1])}mm`;
  }
  return on.map(([n, v]) => `${n} ${fmtMm(v)}mm`).join('・');
}
