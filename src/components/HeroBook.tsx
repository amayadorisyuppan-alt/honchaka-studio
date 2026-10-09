// 入口の「めくれる本」。**スタジオが実際に組んだサンプルを、表紙から奥付まで見せる。**
//
// 画像は scripts/build-hero-pages.mjs が public/hero/ に置いた事前レンダリング。
// アプリと同じ組版HTML・同じ CoreViewer で撮ってあるので、ここに映るものは
// 宣伝用の絵ではなく**本物の出力**。判型・総ページ・背幅も撮影時の実計算値
// (manifest.json)を出す。
//
// めくりはページカールではなく**面の切替**(2026-08-28 ユーザー決定)。
// 読み込みは「いま見ている面の前後1面だけ」— 初期表示は表紙1枚ぶんで済む。
// manifest が無い(ビルドしていない)環境では、部品ごと出さない。
import { useEffect, useMemo, useRef, useState } from 'react';
import { FrogPeek } from './FrogMark';

interface HeroManifest {
  trim: { id: string; label: string; w: number; h: number };
  binding: 'right' | 'left';
  pages: number;
  specPages: number | null;
  spineMm: number | null;
  bleedMm: number;
  cover: string | null;
  /** 裏表紙(表4)。最後の見開きのあとにめくれる(2026-09-04 ユーザー要望) */
  back?: string | null;
  images: string[];
  /** カラーで刷った同じページ。白黒⇄カラー切替(2026-09-11 ユーザー要望
   * 「どっちも作れるのが売り」)。無い・枚数が合わない古い manifest では切替を出さない */
  imagesColor?: string[] | null;
}

/** 1面 = 表紙・裏表紙(1枚) / 見開き(右+左) / 仕様書 */
type Face =
  | { kind: 'cover'; src: string }
  | { kind: 'spread'; right: string | null; left: string | null; firstPage: number }
  | { kind: 'back'; src: string }
  | { kind: 'spec' };

interface Props {
  /** 入口を閉じて作業画面へ。押すと「いま開いている本」が開く(サンプルとは限らない)ので、
   * ボタン名は「この本を編集」ではなく版元CTAと同じ動詞にしてある(2026-09-04 レビュー指摘) */
  onEnter: () => void;
}

export function HeroBook({ onEnter }: Props) {
  const [mf, setMf] = useState<HeroManifest | null>(null);
  const [gone, setGone] = useState(false);
  const [face, setFace] = useState(0);
  // 本文の刷り色。白黒とカラーは**同じ原稿の実出力**を2セット撮ってあり、
  // ページ番号を保ったまま差し替わる(表紙は元からカラーなので変わらない)
  const [inkColor, setInkColor] = useState(false);

  useEffect(() => {
    fetch('hero/manifest.json')
      .then((r) => (r.ok ? (r.json() as Promise<HeroManifest>) : Promise.reject(new Error(String(r.status)))))
      .then(setMf)
      .catch(() => setGone(true));
  }, []);

  const colorOk = !!mf?.imagesColor && mf.imagesColor.length === mf.images.length;

  /** 次の面へ。最後の面(仕様書)からは表紙へ戻る(下の［表紙にもどる］と同じ) */
  const facesLen = useRef(0);
  const goNext = () => setFace((f) => (f >= facesLen.current - 1 ? 0 : f + 1));
  const goPrev = () => setFace((f) => Math.max(0, f - 1));
  /**
   * **左右の矢印キーでもめくる。** 画面の左右の矢印と同じ向き(右綴じは ← が次)。
   * 入力欄にいるとき・修飾キーつきのときは奪わない
   */
  const rightBound = mf?.binding !== 'left';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
      // ヘルプ・このアプリについて などが上に開いているあいだは、下の本をめくらない
      // (キーはいちばん上の1枚にだけ効かせる。Esc と同じ約束)
      if (document.querySelector('[role="dialog"]')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'ArrowLeft') (rightBound ? goNext : goPrev)();
      else if (e.key === 'ArrowRight') (rightBound ? goPrev : goNext)();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // goNext / goPrev は setFace と ref しか触らないので、向きが変わったときだけ張り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightBound]);

  const faces = useMemo<Face[]>(() => {
    if (!mf) return [];
    const out: Face[] = [];
    if (mf.cover) out.push({ kind: 'cover', src: `hero/${mf.cover}` });
    const list = inkColor && mf.imagesColor && mf.imagesColor.length === mf.images.length ? mf.imagesColor : mf.images;
    const img = (i: number) => (i >= 0 && i < list.length ? `hero/${list[i]}` : null);
    // 右綴じ: 奇数ページ(p1,p3…)が左。最初の見開きは p1 だけ、以後 [右=偶数, 左=奇数]
    out.push({ kind: 'spread', right: null, left: img(0), firstPage: 1 });
    for (let i = 1; i < mf.images.length; i += 2) {
      out.push({ kind: 'spread', right: img(i), left: img(i + 1), firstPage: i + 1 });
    }
    if (mf.back) out.push({ kind: 'back', src: `hero/${mf.back}` });
    out.push({ kind: 'spec' });
    return out;
  }, [mf, inkColor]);

  // 前後1面の画像を先に取りにいく。めくった瞬間の白紙を減らす
  useEffect(() => {
    [faces[face - 1], faces[face + 1]].forEach((f) => {
      if (!f) return;
      const urls = f.kind === 'spread' ? [f.right, f.left] : f.kind === 'spec' ? [] : [f.src];
      urls.forEach((u) => {
        if (u) new Image().src = u;
      });
    });
  }, [face, faces]);

  facesLen.current = faces.length;
  if (gone || !mf || faces.length === 0) return null;

  const cur = faces[face];
  const label =
    cur.kind === 'cover'
      ? '表紙'
      : cur.kind === 'back'
        ? '裏表紙（表4）'
        : cur.kind === 'spec'
          ? '仕様書・KDP適合値'
          : cur.right === null
            ? `${cur.firstPage} 頁`
            : `${cur.firstPage}–${Math.min(cur.firstPage + 1, mf.pages)} 頁`;
  const specPages = mf.specPages ?? mf.pages;
  const last = face === faces.length - 1;

  return (
    <div className="hero-book" style={{ ['--page-ar' as string]: `${mf.trim.w} / ${mf.trim.h}` }}>
      {/* **本の左右にめくる矢印。**(2026-09-23 ユーザー要望「サンプルの左右に矢印を入れるなどして、
          本を見ながらすぐめくる動作が選択できるようにしたい」)。下の［次の頁をめくる］まで
          目を動かさずに済む。向きは下のボタンと同じ約束(右綴じは左が次) */}
      <div className="hero-viewer">
      <button
        className="hero-side hero-side-l"
        aria-label={rightBound ? (last ? '表紙にもどる' : '次の頁をめくる') : '前の頁'}
        title={rightBound ? (last ? '表紙にもどる' : '次の頁') : '前の頁'}
        disabled={!rightBound && face === 0}
        onClick={rightBound ? goNext : goPrev}
      >
        ‹
      </button>
      <button
        className="hero-side hero-side-r"
        aria-label={rightBound ? '前の頁' : last ? '表紙にもどる' : '次の頁をめくる'}
        title={rightBound ? '前の頁' : last ? '表紙にもどる' : '次の頁'}
        disabled={rightBound && face === 0}
        onClick={rightBound ? goPrev : goNext}
      >
        ›
      </button>
      <div className="hero-stage" key={face}>
        {(cur.kind === 'cover' || cur.kind === 'back') && (
          <div className="hero-single">
            <FrogPeek />
            <img
              src={cur.src}
              alt={cur.kind === 'cover' ? 'サンプル本の表紙' : 'サンプル本の裏表紙（表4）'}
              width={mf.trim.w * 5}
              height={mf.trim.h * 5}
            />
          </div>
        )}
        {/* 見開きは角丸のため overflow:hidden なので、カエルは外(ステージ)に載せる。
            見開きは幅いっぱいだから、ステージの右上=紙の右上になる */}
        {cur.kind === 'spread' && <FrogPeek />}
        {cur.kind === 'spread' && (
          <div className="hero-spread">
            {/* DOM順=画面の左→右。**右綴じは奇数頁が左・偶数頁が右**なので、
                left(奇数)を先に置く。読み順(右ページが先)で置いていたころは
                流し込みで左右が鏡写しになり、1頁目が右に出ていた
                (2026-08-28 ユーザー報告「縦書きなのに開きが逆」) */}
            <div className="hero-page hero-page-l">
              {cur.left ? (
                <img src={cur.left} alt="" width={mf.trim.w * 5} height={mf.trim.h * 5} />
              ) : (
                <span className="hero-blank" />
              )}
            </div>
            <div className="hero-page hero-page-r">
              {cur.right ? (
                <img src={cur.right} alt="" width={mf.trim.w * 5} height={mf.trim.h * 5} />
              ) : (
                <span className="hero-blank" />
              )}
            </div>
          </div>
        )}
        {cur.kind === 'spec' && (
          <div className="hero-spec">
            <FrogPeek />
            <p className="hero-spec-head">仕様書・KDP適合値</p>
            <dl>
              <div>
                <dt>判型（トリム）</dt>
                <dd>
                  {mf.trim.w} × {mf.trim.h} mm（{mf.trim.label}）
                </dd>
              </div>
              <div>
                <dt>総ページ数</dt>
                <dd>{specPages} 頁</dd>
              </div>
              <div>
                <dt>組方向・綴じ</dt>
                {/* このサンプルは縦組み。KDPの設定名では「右綴じ(ページめくり方向: 右から左)」 */}
                <dd>{mf.binding === 'right' ? '縦書き・右綴じ（右から左）' : '横書き・左綴じ（左から右）'}</dd>
              </div>
              {mf.spineMm != null && (
                <div>
                  <dt>背幅自動計算</dt>
                  <dd>
                    <b className="hero-spec-chip">{mf.spineMm.toFixed(2)} mm</b>
                  </dd>
                </div>
              )}
              <div>
                <dt>塗り足し</dt>
                <dd>+{mf.bleedMm} mm 対応済</dd>
              </div>
            </dl>
            <p className="hero-spec-note">この数字はすべて、いま見たサンプルをスタジオが組んだときの実際の値です。</p>
            <button className="primary-action" onClick={onEnter}>
              スタジオで本をつくる
            </button>
          </div>
        )}
      </div>
      </div>
      {/* 本文の刷り色の切替。白黒でもカラーでも作れることを、言葉ではなく
          同じ頁の2つの実出力で見せる(2026-09-11 ユーザー要望「どっちも作れるのが売り」)。
          表紙・裏表紙はどちらの本でもカラー印刷なので変わらない */}
      {colorOk && (
        <div className="hero-inkrow" role="group" aria-label="本文の刷り色">
          <span className="hero-inklabel">本文の刷り</span>
          <button
            className={inkColor ? 'hero-inkbtn' : 'hero-inkbtn on'}
            aria-pressed={!inkColor}
            onClick={() => setInkColor(false)}
          >
            白黒
          </button>
          <button
            className={inkColor ? 'hero-inkbtn on' : 'hero-inkbtn'}
            aria-pressed={inkColor}
            onClick={() => setInkColor(true)}
          >
            カラー
          </button>
          <span className="hero-inkhint">同じ原稿から、どちらの本も組めます</span>
        </div>
      )}
      {/* **右綴じは左へ読み進む**ので、［次の頁］は左・［前の頁］は右に置く
          (マンガのビューアと同じ約束。2026-08-28「開きが逆」の指摘に合わせて左右も揃えた)。
          最後の面では［次］の席が［表紙にもどる］になる(戻り道が無いと行き止まり) */}
      <div className="hero-pager">
        {face === faces.length - 1 ? (
          <button className="hero-pgbtn" onClick={() => setFace(0)}>
            ↺　表紙にもどる
          </button>
        ) : (
          <button className="hero-pgbtn" onClick={() => setFace((f) => Math.min(faces.length - 1, f + 1))}>
            ‹　次の頁をめくる
          </button>
        )}
        <span className="hero-pgnow">
          {label}　/　全 {specPages} 頁
        </span>
        <button className="hero-pgbtn" disabled={face === 0} onClick={() => setFace((f) => Math.max(0, f - 1))}>
          前の頁　›
        </button>
      </div>
    </div>
  );
}
