// 素材の購入導線。**サイドバーの下端に貼り付けて、タブの外に置く。**
//
// もとは表1タブの［単色］の中と、プリセット専用画面の下端の2か所にあった。
// 単色の中に入っていたのは「地(背景)」の節に書いていたからで、
// **単色を選んでいる人には要らない話**が単色の欄に出ていたことになる
// (2026-08-19 ユーザー指摘「なぜか単色の背景の中に入っている」)。
//
// タブの中に置くと、そのタブを開いた人にしか見えない。買える物があることは
// タブに関係なく分かっていてよいので、サイドバーそのものの下端に固定する。
// `position: sticky` なので、パネルをどれだけスクロールしても同じ場所に残る。

import { BOOTH_SHOP_URL } from '../shop';

export function ShopFoot({
  label,
  hint,
}: {
  /** ボタンの文字。買う物がその画面で何なのかを言う(表紙背景/挿絵) */
  label: string;
  /** 畳んだ中に入れる補足。**既定では出さない。**下端に常駐するので、
   *  説明文を出しっぱなしにすると本来の操作の場所を食う */
  hint: string;
}) {
  return (
    <div className="shop-foot">
      <a className="shop-link" href={BOOTH_SHOP_URL} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
      <details className="shop-foot-more">
        <summary>どんな画像？</summary>
        <p className="hint">{hint}</p>
      </details>
    </div>
  );
}
