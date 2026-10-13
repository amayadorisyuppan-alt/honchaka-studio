// プリセット(同梱の画像パック)を選ぶ**専用画面**。開いているあいだサイドバーを丸ごと使う。
//
// 表紙タブ(CoverEditor)と背景・挿絵(BackgroundPicker)が別々に一覧を持っていた。
// 背景側は専用画面に作り直したが、表紙側は**絞り込みが無く、説明の下に3列で並べるだけ**で
// 取り残されていて、「画像が小さくて選びにくい」「バーが2つ並んで操作しづらい」と
// 不満が出た(2026-08-19 ユーザー指摘)。**同じ形をどちらからも使う**ようにここへ出す。
//
// 出すのは**戻る道・絞り込み・一覧・BOOTH の4つだけ**。見出しもサムネイルも
// ボタン列も利用条件の長文も置かない。以前は開いても上にそれらが残っていて、
// 画像を見るために開いたのに画面の半分が説明で埋まっていた(同日の指摘)。
// 見た目は app.css の .preset-view / .preset-head / .preset-pinned /
// .preset-box / .preset-foot が作っている。
// (2026-10-12 改修の希望 2) 呼び出し側が onPickFile を渡したときは、一覧の上に「アップロード」の段
// (自分の画像のフォルダ。FolderImages.tsx)を足す。ユーザーが決めた見出しなので、上の「4つだけ」の例外
//
// **選んだあとの処理は呼び出し側に任せる。** 表紙は `{ kind: 'preset', id }` を
// そのまま設定へ書くが、背景は data URI に直してから持つ
// (相対URLのままだと印刷ダイアログ経由や書き出し後のHTMLで絵が消える)。
// 同じ「選ぶ」でも後始末がまるで別物なので、ここは onPick を呼ぶところで手を止める。
// 選んだあと画面を閉じるかどうかも呼び出し側の判断(表紙は右にプレビューが出ているので
// 開いたまま見比べられる。背景はプレビューが無いので閉じて戻る)。

import { useState } from 'react';
import { TRIM_SIZES } from '../models/project';
import { useProject } from '../store/useProject';
import { BOOTH_SHOP_URL, FREE_HIRES_PRESETS_URL, SHOP_PACKS_LABEL } from '../shop';
import { FolderImages } from './FolderImages';

/**
 * public/covers/manifest.json の1件(scripts/build-covers.py が生成する)。
 * 呼び出し側はこれより多く項目を持っていてよい(表紙側は theme / lum も読む)。
 */
export interface PresetItem {
  id: string;
  groupLabel: string;
  themeLabel: string;
  file: string;
  thumb: string;
  /** そのテーマに添える一言。持っている絵があればテーマの見出しの下に1行だけ出す */
  note?: string;
  /** まとまり('wrap' = まるごと1枚の表紙など)。manifest がそのまま持っている */
  group?: string;
}

/**
 * 同梱プリセットの使いどころ。**絵を選ぶ画面すべてに出す。**
 *
 * 同梱の画像はそのまま本の表紙・中身になって売られるので、
 * 「使ってよいのか」「クレジットは要るのか」は選ぶその場で答えないと届かない
 * (［このアプリについて］まで読みに行く人はいない)。
 * KDP の AI 申告は**未申告だと規約違反**なので、ここでも言う。
 *
 * 詳しい条件(素材としての再配布は不可・同じ絵の本が出ることがある)は
 * ［このアプリについて］に置いてある。ここは手順の途中なので短く。
 */
export function PresetTerms() {
  return (
    <p className="hint preset-terms">
      同梱の画像は<b>生成AI（Higgsfield）</b>で作っています。
      <b>本に使って販売できます（クレジット不要）。</b>
      KDP では「AI 生成コンテンツ」に<b>「はい」</b>と答えてください
    </p>
  );
}

/**
 * 同梱の画像の大きさ。**文庫まで。**(2026-09-23 ユーザー要望「プリセットは解像度の関係で文庫にしか
 * 対応していない。その注釈と、B5 まで使えるデータを BOOTH で無料配布していることを告知したい」)。
 * 同梱の縦位置の絵は 1664×2560px。素材側の仕分け(350dpi で
 * 数えている)で「同梱＝文庫まで(新書には31px足りない)」と決めてあり、それに合わせて言う。
 * **絵を選ぶ画面すべてに、一覧の上に常に出す**(畳むと読まれない)。いまの判型が文庫より
 * 大きいときは、足りないことを警告の色で言い切る。有料のパックがあることもここで添える
 */
function PresetResolutionNote() {
  const trim = useProject((s) => s.settings.trim);
  const big = trim !== 'bunko';
  return (
    <p className={big ? 'warn preset-res' : 'hint preset-res'}>
      {big ? (
        <>
          同梱の画像は<b>文庫サイズまで</b>の解像度で、いまの判型（{(TRIM_SIZES[trim] ?? TRIM_SIZES.bunko).label}）では
          <b>粗く刷られます</b>。
        </>
      ) : (
        <>
          同梱の画像は<b>文庫サイズまで</b>の解像度です。
        </>
      )}
      同じ画像の<b>B5 まで使える高解像度版</b>を
      <a href={FREE_HIRES_PRESETS_URL} target="_blank" rel="noopener noreferrer">
        BOOTH で無料配布
      </a>
      しています。ほかにも、さまざまなジャンル・タッチの画像を用意しています。
      下の［{SHOP_PACKS_LABEL}］から購入できます
    </p>
  );
}

/**
 * まるごと1枚(表紙全体)の絵だけを並べる画面の断り。**上の PresetResolutionNote の代わりに出す。**
 *
 * まるごと1枚の絵は横長の見開き(1664×1109 など)で、表1・背・表4にまたがって広げるので、
 * 文庫でも約180dpi(背幅を入れて幅約230mm)にしかならず、刷るには足りない。本の背幅で寸法が
 * 変わるので BOOTH の無料の高解像度版にも入れていない(在庫の地図)。
 * 前は縦の絵と同じ一覧に混ざっていたので、上に「文庫サイズまで」、テーマの下に「文庫でも足りない」と
 * 言い分けていたが、この画面をまるごと1枚の絵だけにしてから(2026-09-27)は上の断りが丸ごと食い違って
 * 見えた(同日ユーザー指摘「説明としてわかりにくい」)。この画面ではこれ1つだけを出す。
 *
 * **刷る用の画像を置いていない理由と、自作の道も書く**(同日ユーザー要望)。背幅はページ数と紙で
 * 変わるので、表紙全体の正しい大きさは本ごとに違い、決まった大きさの画像では合わない。
 * 自作するときの大きさは、**表紙の見本の上に出している「表紙全体」の寸法**を指す(2026-09-27 ユーザー判断。
 * 前は KDP の表紙計算ツールへのリンクを置いていたが、スタジオが同じ式(ページ数×KDP の紙の厚み＋塗り足し)で
 * いまの本の大きさをもう出しているので、外へ行かせなくてよい)。KDP 以外の印刷所は、印刷所が知らせる背幅で
 */

function WrapResolutionNote() {
  return (
    <>
      <p className="hint preset-res">
        表紙全体（表1・背・表4）に広げる<b>見本</b>です。背の幅は本のページ数と紙で変わるので、
        表紙全体の正しい大きさは本ごとに異なります。
        <b>スタジオに入っている画像を本番用としてそのまま使用しないでください。</b>
        （BOOTH で無料配布している高解像度版にも、まるごと1枚の画像は入っていません）。
        現在入っている見本を印刷に使うと、たとえ文庫であっても粗く刷られます。
      </p>
      <p className="hint preset-res">
        まるごと1枚から表紙をつくる場合は、ご自分の本の大きさに合わせて画像を用意してください。
        右の表紙の見本の上に、いまの本の<b>「表紙全体」の大きさ</b>（mm と px）が出ています。
        その大きさで画像を作ってください。本文を直してページ数が変わると、この大きさも変わります
        （KDP 以外の印刷所では、印刷所から知らされた背幅を［本のかたちを決める］の「印刷所の決まり」にある「背幅（印刷所の数字）」に
        入れると、この大きさもその数字で出ます）。
      </p>
    </>
  );
}

interface Props {
  /** 見出しに出す面の呼び名(「表1（おもて）」「大扉」など)。同じ画面が何度も開くので必須 */
  label: string;
  /** manifest.json から読んだ一覧。読み込みは呼び出し側が持つ */
  presets: PresetItem[];
  /** 戻る道。押されたら呼び出し側がこの画面を閉じる */
  onBack: () => void;
  /** 絵が選ばれた。設定へどう書くかは呼び出し側が決める(冒頭のコメント参照) */
  onPick: (preset: PresetItem) => void;
  /**
   * いま選ばれているプリセットの id。分かるときだけ渡す。
   * 背景側は選んだ瞬間に data URI へ直してしまうので、あとから id は分からない
   */
  selectedId?: string;
  /** 読み込み中。押しても取り消せない待ちがあるあいだはボタンを止める */
  busy?: boolean;
  error?: string;
  /** 素材の購入導線。文言はその面に合わせて変える(表紙背景/挿絵) */
  shopLabel?: string;
  /** 購入導線の下に添える紹介文 */
  shopHint?: string;
  /**
   * 画像のフォルダ(「アップロード」の段)の画像が押された。原画のファイルと、同梱のプリセットの高解像度版なら その id。
   * 渡したときだけ、一覧の上に「アップロード」の段を出す(2026-10-12 改修の希望 2)。
   * 取り込みは呼び出し側の今のファイル選びと同じ道で(長辺の上限もそちらが決める)
   */
  onPickFile?: (file: File, presetId: string | undefined) => Promise<void> | void;
}

export function PresetScreen({
  label,
  presets,
  onBack,
  onPick,
  selectedId,
  busy = false,
  error,
  shopLabel,
  shopHint,
  onPickFile,
}: Props) {
  // 絞り込み。テーマは固定の候補があるので select、キーワードは自由入力。
  // **この画面の中に閉じた状態にする。** 開き直すたびに条件が消えるほうが、
  // 前に打った条件が残っていて「絵が足りない」と誤解されるより事故が少ない
  const [themeFilter, setThemeFilter] = useState('');
  const [keyword, setKeyword] = useState('');

  // select の選択肢は絞り込み前の全件から出す(選んだ結果ゼロ件のテーマも選べる必要がある)
  const themes = Array.from(new Set(presets.map((p) => p.themeLabel)));
  const kw = keyword.trim();
  const filtered = presets.filter((p) => {
    if (themeFilter && p.themeLabel !== themeFilter) return false;
    // groupLabel(物語/ミステリー等の分類) と themeLabel の部分一致で十分
    if (kw && !p.groupLabel.includes(kw) && !p.themeLabel.includes(kw)) return false;
    return true;
  });
  const visibleThemes = Array.from(new Set(filtered.map((p) => p.themeLabel)));
  /** まるごと1枚(表紙全体)の絵だけの一覧か。そうなら解像度の断りをそちら向けに差し替える */
  const wrapOnly = presets.length > 0 && presets.every((p) => p.group === 'wrap');

  return (
    <div className="bg-picker bg-picker-open preset-view">
      <div className="preset-head">
        <button className="ghost" disabled={busy} onClick={onBack}>
          ← 戻る
        </button>
        <h3>{label}：プリセットから選ぶ</h3>
      </div>

      <div className="preset-pinned">
        {wrapOnly ? <WrapResolutionNote /> : <PresetResolutionNote />}
        {presets.length > 0 && (
          <div className="preset-filter">
            <select value={themeFilter} onChange={(e) => setThemeFilter(e.target.value)}>
              <option value="">すべてのテーマ</option>
              {themes.map((th) => (
                <option key={th} value={th}>
                  {th}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="キーワードで絞り込み(例: 物語、レトロ)"
            />
          </div>
        )}
      </div>

      <div className="preset-box">
        {/* 自分の画像のフォルダ。**プリセットの一覧の上に「アップロード」の見出しで並べる**
            (2026-10-12 改修の希望 2。10/12 夜ユーザー)。一覧と一緒に流れる(絞り込みは同梱の一覧だけに効く) */}
        {onPickFile && <FolderImages busy={busy} onPick={onPickFile} />}
        {presets.length === 0 && (
          <p className="hint">
            プリセットが読み込めませんでした。Ctrl+F5 で再読み込みしてください
          </p>
        )}
        {presets.length > 0 && filtered.length === 0 && (
          <p className="hint preset-empty">この条件に合う画像はありません</p>
        )}
        {visibleThemes.map((themeLabel) => (
          <div key={themeLabel} className="preset-theme">
            <p className="hint">{themeLabel}</p>
            {/* **テーマに1行だけ添える断り書き。** 文言は manifest が持つ(build-covers.py が付ける)。
                帯つきの地は文庫の版面に合わせて描いてあり、ほかの判型では位置がずれるので、
                選ぶ前に一言だけ言っておく。**判型で出し分けはしない** —
                余白は利用者が動かせるうえ組み方向でも変わるので、判型だけを見た出し分けは
                当てにならず、絵が黙って消えるほうが不親切になる(実測は引き継ぎメモ) */}
            {(() => {
              const note = filtered.find((p) => p.themeLabel === themeLabel && p.note)?.note;
              return note ? <p className="hint preset-note">{note}</p> : null;
            })()}
            <div className="preset-grid">
              {filtered
                .filter((pr) => pr.themeLabel === themeLabel)
                .map((pr) => (
                  <button
                    key={pr.id}
                    className={pr.id === selectedId ? 'preset-item active' : 'preset-item'}
                    title={`${pr.groupLabel} / ${pr.themeLabel}`}
                    disabled={busy}
                    onClick={() => onPick(pr)}
                  >
                    <img src={`covers/${pr.thumb}`} alt={pr.themeLabel} loading="lazy" />
                  </button>
                ))}
            </div>
          </div>
        ))}
        {error && <p className="error">{error}</p>}
      </div>

      {/* **下端に貼り付ける。ただし1行に収める。**
          下に置くだけでは足りなかった。説明文と紹介文を積むと帯が 169px になり、
          701px のサイドバーで絵を見られるのが 366px = 1段ぶんしか残らなかった
          (2026-08-19 実測。ユーザーからは「移動していない」と見えていた)。
          利用条件は一度読めばよいものなので畳み、紹介文は購入ボタンの説明に寄せる */}
      <div className="preset-foot">
        <details className="preset-terms-fold">
          <summary>画像の使いかた</summary>
          <div className="preset-terms-body">
            <PresetTerms />
            {shopHint && <p className="hint shop-hint">{shopHint}</p>}
          </div>
        </details>
        <a className="shop-link" href={BOOTH_SHOP_URL} target="_blank" rel="noopener noreferrer">
          {shopLabel ?? SHOP_PACKS_LABEL}
        </a>
      </div>
    </div>
  );
}
