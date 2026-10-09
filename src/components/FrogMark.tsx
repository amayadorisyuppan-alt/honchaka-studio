// あまやどり出版のカエル。**隠れミッキー方式**(2026-08-28 ユーザー決定)で
// あちこちに置くための1個の部品。増やすときも必ずこれを使う。
//
// 決まり(2026-09-02 改定「TOPとヘルプばっかりでつまんない」を受けて):
// **常に見えているのは1画面1匹**(工程レールの終点)。それとは別に、
// **スクロールの底・読み物の末尾**には、見つけた人だけのもう1匹を置いてよい。
// 作業の邪魔をしない隅に、小さく、は変わらず。表情(mood)は置き場に合わせて選ぶ。
// 線画はロゴ(蓮の葉の下のカエル)の簡略化。本物のロゴ画像とは別物なので、
// ロゴそのものが要る場面(ヘッダーの版元署名・OGP・バナー)では BrandLogo を使うこと。

import { useState } from 'react';

/**
 * 版元の本物ロゴ。public/brand/amayadori-logo.png を出す。
 * 画像は利用者のPC(リポジトリの外の非公開の資料フォルダ、資料/1.png)からコミットしてもらう約束(2026-08-28)なので、
 * まだ無い環境では線画の FrogBadge に黙って切り替える
 */
export function BrandLogo({ size = 40 }: { size?: number }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <FrogBadge size={size} />;
  return (
    <img
      className="brand-logo"
      src="brand/amayadori-logo.png"
      alt="あまやどり出版"
      style={{ height: size }}
      onError={() => setMissing(true)}
    />
  );
}

/** 丸い判の中に座るカエル(ヘッダーのロゴなど) */
export function FrogBadge({ size = 40 }: { size?: number }) {
  return (
    <span className="frog-badge" style={{ width: size, height: size }} aria-hidden="true">
      <svg
        width={size * 0.7}
        height={size * 0.65}
        viewBox="0 0 28 26"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      >
        {/* 蓮の葉 */}
        <path d="M4 8 Q7 3 14 3 Q22 3 25 8 Q20 10 14 9 Q8 10 4 8 Z" />
        <path d="M7 9 Q6 12 7 14" />
        {/* カエル */}
        <ellipse cx="14" cy="19" rx="6" ry="4.6" />
        <circle cx="11.6" cy="15.4" r="1.5" />
        <circle cx="16.4" cy="15.4" r="1.5" />
        <path d="M11 20.5 Q14 22 17 20.5" />
        <path d="M8 23.5 H20" />
      </svg>
    </span>
  );
}

/**
 * バナー案Aの本棚(背表紙4冊)。題字に添える小さな棚
 * (2026-09-04 ユーザー「スタジオそのものも、このテイストに合わせて」)。
 * 色はバナーと同じ決め打ち: ミント・藍・金茶・深ミント
 */
export function ShelfMark({ height = 18 }: { height?: number }) {
  return (
    <svg
      className="shelf-mark"
      width={(height * 34) / 26}
      height={height}
      viewBox="0 0 34 26"
      aria-hidden="true"
    >
      <rect x="1" y="6" width="6" height="20" rx="1.5" fill="#0e7c72" />
      <rect x="9" y="1" width="6" height="25" rx="1.5" fill="#112834" />
      <rect x="17" y="9" width="6" height="17" rx="1.5" fill="#c8a13a" />
      <rect x="25" y="3.5" width="6" height="22.5" rx="1.5" fill="#0a6259" />
    </svg>
  );
}

/**
 * スタジオのロゴ「本ちゃか」(2026-10-07 ユーザー決定。題字とトップの見出しを
 * 「ロゴ+本ちゃか」に替え、「ひっちゃか本づくりスタジオ」を小さく添える)。
 *
 * 絵は public/brand/honchaka-mark.svg — 画像生成の手描きの絵(4冊の背表紙と、金茶の本からのぞくカエル)を
 * 元の色だけにそろえてから vtracer で図形にし、svgo で縮めたもの。元の絵と作り方の控えは
 * 非公開の資料フォルダの 資料/本ちゃかロゴ_20261007/。
 * 字は画面では HTML の字(丸ゴシック)で出す。テーマで色を変えられ、小さくてもにじまないため。
 * 字まで図形にした一式(ほかの場所に貼る用)は public/brand/honchaka-logo.svg と -dark.svg
 */
export function StudioLogo({ height = 28, by = false }: { height?: number; by?: boolean }) {
  return (
    <span className="studio-logo">
      <img className="studio-mark" src="brand/honchaka-mark.svg" alt="" style={{ height }} />
      <span className="studio-name">
        <b>本ちゃか</b>
        <small>
          ひっちゃか本づくりスタジオ
          {by && <span className="studio-by">BY あまやどり出版</span>}
        </small>
      </span>
    </span>
  );
}

/** 表情。置き場の気分に合わせて親が選ぶ(既定は calm) */
export type FrogMood = 'calm' | 'happy' | 'wink' | 'sleepy' | 'wow';

/** ふちから顔だけのぞくカエル(本の上など)。置き場所は親が決める */
export function FrogPeek({ width = 54, mood = 'calm' }: { width?: number; mood?: FrogMood }) {
  // 目: ふつうは丸い瞳。happy/sleepy/wink は線で描く
  const eye = (cx: number, closed: boolean, sleepy = false) =>
    closed ? (
      <path d={sleepy ? `M${cx - 2.4} 22 H${cx + 2.4}` : `M${cx - 2.4} 22 Q${cx} 19.4 ${cx + 2.4} 22`} />
    ) : (
      <circle cx={cx} cy="21.2" r={mood === 'wow' ? 1.4 : 1} fill="currentColor" stroke="none" />
    );
  return (
    <svg
      className="frog-peek"
      width={width}
      height={(width * 40) / 54}
      viewBox="0 0 54 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <ellipse cx="27" cy="30" rx="13" ry="9" className="frog-fill" />
      <circle cx="21.5" cy="21.5" r="3.4" className="frog-fill" />
      <circle cx="32.5" cy="21.5" r="3.4" className="frog-fill" />
      {eye(21.5, mood === 'happy' || mood === 'sleepy', mood === 'sleepy')}
      {eye(32.5, mood === 'happy' || mood === 'sleepy' || mood === 'wink', mood === 'sleepy')}
      {mood === 'wow' ? (
        <ellipse cx="27" cy="33" rx="2.6" ry="3.2" />
      ) : mood === 'sleepy' ? (
        <path d="M23 33.5 Q27 34.5 31 33.5" />
      ) : (
        <path d="M20 32 Q27 36 34 32" />
      )}
      {/* 眠いときだけ、頭のよこに小さな「z」 */}
      {mood === 'sleepy' && (
        <path d="M40 14 h5 l-5 5 h5" strokeWidth="1.2" />
      )}
    </svg>
  );
}
