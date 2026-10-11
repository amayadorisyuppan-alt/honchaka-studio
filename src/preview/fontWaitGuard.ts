// Vivliostyle の「書体の読み込み待ち」が、アプリの書体まで全部読ませないようにする。(2026-10-11 1.0.3)
//
// ## 何が起きていたか(修正リストの 17)
//
// @vivliostyle/core 2.44.1 の font Mapper は、組版に使う @font-face を Fnt_N という名前で登録したあと、
// `waitFontLoading()` で **ページの document.fonts を全部回し、まだ読んでいない面を残らず load() する**:
//
//     waitFontLoading(){let t=this.head.ownerDocument.fonts,e=0;
//       t.forEach(s=>{s.status==="unloaded"&&(e++,s.load().catch(o=>{}))}); …
//
// 下見の組版はアプリと同じページ(同じ document)で動くので、ここにはアプリが積んでいる
// 15 書体の @font-face(太さごとに約 120 のサブセット。合わせて約 3,700 面)も入っている。
// 本で使っていない書体まで、全部のサブセットを一度に取りに行っていた
// (手元で実測: ［サンプルを見る］の 0.5 秒後に woff2 を 3,577 件)。
// 本番の Xserver(HTTP/2)はこの一斉の取得の約半分を REFUSED_STREAM で断り、断られた面は error のまま戻らない。
// 表紙を描く前の document.fonts.load がその面に当たって「A network error occurred.」で止まっていた。
//
// ## どう直すか
//
// Vivliostyle が回すときだけ、**Vivliostyle が自分で作った面(Fnt_N と -viv-…)だけを見せる。**
// 組版が待つべきなのはこの面だけ(本で使う書体を、本の字を含むサブセットに絞って渡している。
// src/typeset/fontface.ts)。アプリの書体は、画面で字を描くときにブラウザが要る分だけ読む。
//
// - 印刷(printHTML)は別の iframe で組むので、ここは効かない(その iframe には本で使う面しか無い)
// - document.fonts を for…of や [...] で回すもの(検査の道具など)は forEach を通らないので変わらない
// - Vivliostyle を上げたら、waitFontLoading が forEach で回す作りのままかを確かめる(scripts/fontWaitGuard.test.ts)

/** Vivliostyle が自分で作る書体の名前。Fnt_N は @font-face を写したもの、-viv-ts-sp は字間の調整用 */
export function isVivliostyleFace(family: string): boolean {
  return /^(Fnt_\d+|-viv-)/.test(family.replace(/^["']|["']$/g, ''));
}

type ForEachCb = (face: FontFace, face2: FontFace, set: FontFaceSet) => void;

/** forEach を「Vivliostyle の面だけ」に絞ったものに差し替える。2回目からは何もしない */
export function installFontWaitGuard(set: FontFaceSet | undefined = globalThis.document?.fonts): void {
  if (!set) return;
  const marked = set as FontFaceSet & { __vivFontWaitGuard?: true };
  if (marked.__vivFontWaitGuard) return;
  const orig = set.forEach.bind(set);
  Object.defineProperty(set, 'forEach', {
    configurable: true,
    value(cb: ForEachCb, thisArg?: unknown) {
      orig((face, face2, s) => {
        if (isVivliostyleFace(face.family)) cb.call(thisArg, face, face2, s);
      });
    },
  });
  marked.__vivFontWaitGuard = true;
}
