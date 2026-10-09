// 「印刷所の決まり」の欄に触っているあいだ、右の下見のページの上に、その場所を色の帯で重ねる。
// (2026-10-01 ユーザーと決定「触ると場所が色づく。『ノド』『塗り足し』を知らなくても場所で分かる」)
//
// ## 組み直しを起こさない
//
// 帯は組版HTMLにも組版エンジンにも触れない。塗りのパッチ(paint.ts の previewPaintCss)と同じ口 —
// 親 document の <style> に `!important` なしの規則を足すだけ(App が paintCss の後ろへつなぐ)。
// 帯が出る・消えるたびに組み直していたら、欄をさわるたびに十数秒かかる。
//
// ## 位置(下見の実物で測って確かめた。scripts/rules-probe.mjs)
//
// - `[data-vivliostyle-bleed-box]` が**用紙の全面**(塗り足しを含む)で、`position:absolute; inset:0; overflow:hidden`。
//   この ::after が、用紙の全面を基準に位置を取れる
// - 下見の拡大縮小は、ページ容れもの(data-vivliostyle-page-container)の transform: scale。
//   容れものの中の座標は CSS の mm(= 96dpi の px)のまま — **mm はそのまま効く**(拡大しても帯の幅は用紙と同じ比)
// - ノドは常に見開きの内側。物理の `data-vivliostyle-page-side="left"` のページは**右端**、`right` のページは**左端**
//   (縦組みも横組みも同じ。縦組みは1ページ目が left、横組みは right)
// - 仕上がりの位置: 用紙の端から、天・地・小口・ノドの塗り足しぶん内側
//
// 本の下見(.preview-viewport)だけに掛ける。ページ一覧(サムネイル)には出さない
// (小さく並ぶ全ページに帯が出ると、ちらついて見える)
//
// ## 仕上がり線(裁つ位置の点線)は、ここではない
//
// 同じ箱の ::before に描くが、規則は app.css に固定で置いてある(.show-trim)。位置は、紙面を載せる面ごとの
// CSS 変数(VivliostylePreview の applyTrimVars)。帯はこちらの ::after で、線の上(z-index 5)に重なる

import type { PageLayout } from '../typeset/grid';

/** 帯の色。**既存のトークンから**(暗いテーマでも読める)。半透明にして、紙面の字を隠さない */
const BLEED_COLOR = 'color-mix(in srgb, var(--bad) 42%, transparent)';
const GUTTER_COLOR = 'color-mix(in srgb, var(--step-shape) 36%, transparent)';

const mm = (v: number) => `${Number(v.toFixed(3))}mm`;

const PAGE = '.preview-body .preview-viewport [data-vivliostyle-page-container]';

/**
 * 帯の CSS。
 *
 * @param focus 触っている欄が指す場所('bleed' = 塗り足し / 'gutter' = ノド)
 * @param l いまの版面(用紙・塗り足し)
 * @param gutterFloorMm ノドの下限(mm)。ノドの帯の幅。**組み上がった余白ではなく、守る約束のほう**
 */
export function printGuideCss(focus: 'bleed' | 'gutter', l: PageLayout, gutterFloorMm: number): string {
  const b = l.bleed;
  const frame = `content: ''; position: absolute; box-sizing: border-box; pointer-events: none; z-index: 5;`;
  if (focus === 'bleed') {
    // 用紙の外周(塗り足し)。辺ごとの塗り足しの幅で、4本の帯を重ねて描く。ノド側に付けない決まりは、その辺が 0 になって三方になる。
    // **border を使わない**: 枠線の太さは画面の1画素に切り捨てられ(3mm が 2.91mm になる)、細い塗り足しほど狂いが目立つ。
    // 背景の大きさは mm のまま描かれる。左右の帯は、天・地の帯と角で重ならないよう、その間だけ(重なると角が濃くなる)
    const rule = (side: 'left' | 'right') => {
      const gutterIsRight = side === 'left';
      const lw = gutterIsRight ? b.fore : b.gutter;
      const rw = gutterIsRight ? b.gutter : b.fore;
      const c = `linear-gradient(${BLEED_COLOR}, ${BLEED_COLOR})`;
      const mid = `calc(100% - ${mm(b.top)} - ${mm(b.bottom)})`;
      return `${PAGE}[data-vivliostyle-page-side="${side}"] > [data-vivliostyle-bleed-box]::after {
  ${frame} inset: 0; background:
    ${c} 0 0 / 100% ${mm(b.top)} no-repeat,
    ${c} 0 100% / 100% ${mm(b.bottom)} no-repeat,
    ${c} 0 ${mm(b.top)} / ${mm(lw)} ${mid} no-repeat,
    ${c} 100% ${mm(b.top)} / ${mm(rw)} ${mid} no-repeat;
}`;
    };
    return `
${rule('left')}
${rule('right')}
`;
  }
  // ノド: 仕上がりの綴じる側の端から、下限の幅(天から地まで。塗り足しの帯は含めない)
  const rule = (side: 'left' | 'right') => {
    const gutterIsRight = side === 'left';
    const edge = gutterIsRight ? 'right' : 'left';
    return `${PAGE}[data-vivliostyle-page-side="${side}"] > [data-vivliostyle-bleed-box]::after {
  ${frame} ${edge}: ${mm(b.gutter)}; width: ${mm(gutterFloorMm)}; top: ${mm(b.top)}; bottom: ${mm(b.bottom)}; background: ${GUTTER_COLOR};
}`;
  };
  return `
${rule('left')}
${rule('right')}
`;
}
