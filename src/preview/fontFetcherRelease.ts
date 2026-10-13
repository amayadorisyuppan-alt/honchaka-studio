// 書体の取り寄せ係が、取り寄せ終わったあとも**組んだ原稿をまるごと握ったままにしない**ようにする。
// (2026-10-13 修正リスト 30「組み直すたびにメモリが増える」。検査は scripts/fontFetcherRelease.test.ts)
//
// ## 何が残っていたか(ヒープのスナップショットで保持の道をたどった)
//
// ビューアの中(adaptViewer_)の書体の表 `fontMapper.srcURLMap` は、@font-face ごとに取り寄せ係(Fetcher)を1つ持ち、
// **ビューアと一生を共にする**(下見の面は2枚を使い回すので、表も捨てられない。VivliostylePreview.tsx の bufsRef)。
// 取り寄せ係は取り寄せの手順(`fetch`)を持ったままで、その手順は**はじめてその書体を使った回の原稿の入れもの**
// (資源の表 → blob: の原稿 → 解析した文書)を閉じ込めている。だから**新しい書体(縦中横・見出しの書体を含む)が
// 出てくるたびに、その回の原稿1冊ぶんの文書が残った**:
//
//   取り寄せ係.fetch → 書体の顔ぶれ(DocumentFaces).deobfuscator → 資源の表 → blob:… → 解析した文書
//
// 実測(scratchpad の leak.mjs。書体を7つ順に変えて組み直す。数は回収を促したあと):
//   約300ページ(body.docx) 1回ごとに 節点 +2.8万・文書 +1(C の報告の「+2.8万節点/回」の正体)
//   見本の本(40ページ)      10回で 文書 6→15・節点 1.26万→4.82万・JS ヒープ 38→77MB
//
// ## 直し方
//
// 取り寄せ終わった係(arrived)は、もう `fetch` を呼ばない(Vivliostyle は `get()` で手元の結果を返す)。
// そこで `fetch` を「手元の結果を返すだけ」に差し替えて、原稿への糸を切る。表そのもの(どの書体を読み込み済みか)と、
// 文書の head に足した @font-face の <style> はそのまま残すので、書体の読み直しも見た目の変化も無い。
// 取り寄せの途中の係には触らない(次の回で切る)。
//
// 内部の形が変わって読めなくなっても害は無い(何もしないだけ。VivliostylePreview.tsx の cancelRender と同じ考え方)。
// 形が変わったことは検査が Vivliostyle のソースを読んで知らせる

/** Vivliostyle の取り寄せ係(Fetcher)のうち、ここで触る所だけ */
export interface FontFetcherLike {
  arrived?: boolean;
  fetch?: () => unknown;
  get?: () => unknown;
}

/** ビューア(CoreViewer)から書体の表を引く。読めなければ null */
function fontTableOf(viewer: unknown): Record<string, FontFetcherLike | undefined> | null {
  const map = (
    viewer as { adaptViewer_?: { fontMapper?: { srcURLMap?: Record<string, FontFetcherLike | undefined> } } } | null
  )?.adaptViewer_?.fontMapper?.srcURLMap;
  return map && typeof map === 'object' ? map : null;
}

/** 取り寄せ終わった係の `fetch` を差し替える。差し替えた数を返す(検査用) */
export function releaseFontFetchers(viewer: unknown): number {
  let n = 0;
  try {
    const map = fontTableOf(viewer);
    if (!map) return 0;
    for (const f of Object.values(map)) {
      if (!f || !f.arrived || typeof f.get !== 'function') continue;
      const get = f.get.bind(f);
      // 取り寄せ済みなら get() は手元の結果をすぐ返す。万一 fetch が呼ばれても同じ物が返る
      f.fetch = () => get();
      n++;
    }
  } catch {
    /* 放せなくても組版そのものは壊れない */
  }
  return n;
}
