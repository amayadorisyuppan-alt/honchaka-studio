// コラムページ(本文と組み方向の違う1ページ)の管理UI。
//
// 置けるのは章の切れ目だけ。挿絵ページとまったく同じ理由で、章はもともと改ページ
// 起こしなので1ページ挟んでも本文の流れが動かない(models/project.ts の Plate)。
//
// **この画面の役目は、あふれる前に止めること。** コラムページは1ページに収める作りで、
// 書きすぎても次のページへ流れない(版面の外へこぼれたまま断裁される)。
// 収まる量は判型・文字サイズ・行送り・組み方向で変わるので、そのつど計算して出す。

import { useEffect, useRef, useState } from 'react';
import {
  columnPageMode,
  columnPageParagraphs,
  outputsOf,
  type Chapter,
  type ColumnPage,
  type ProjectSettings,
  type WritingMode,
} from '../models/project';
import { computeLayout, fitColumnPage } from '../typeset/grid';
import type { LayoutInfo } from '../preview/VivliostylePreview';
import { positionLabel } from './PlateEditor';
import { BackgroundPicker } from './BackgroundPicker';
import { bgMonoProps, type ColorLook } from './PrintMonoToggle';
import { TYPING_COMMITTED, TYPING_FLUSH, TYPING_REVERTED } from './typingEvents';

interface Props {
  settings: ProjectSettings;
  chapters: Chapter[];
  onChange: (columnPages: ColumnPage[]) => void;
  /** プレビューの組み上がり。何ページ目に出たかを出すのに使う */
  layoutInfo?: LayoutInfo;
  /** そのページへプレビューを飛ばす。1始まり */
  onJump?: (page: number) => void;
  /** 1枚足したことを知らせる。足した先へ飛んで光らせるのに使う */
  onAdded?: (id: string) => void;
  /** 足したばかりのページの id。一覧の該当行へスクロールして光らせる */
  highlightId?: string | null;
  /**
   * 場所を変えた1枚へプレビューを連れて行く(組み上がりを待って飛ぶのは App)。
   * 挿絵ページ(PlateEditor の onFollow)と同じ理由(2026-09-23 ユーザー指摘)
   */
  onFollow?: (id: string) => void;
  /** 右の下見が電子書籍か。「◯ページ目（見る）」を「電子の下見で見る」に替える */
  ebookView?: boolean;
  /** 地の絵の「白黒で刷る」を出すか(カラーの紙の本だけ。2026-10-12 1.1.0。修正リストの 4-6) */
  printColor?: boolean;
  /** 白黒に見える絵・ごく淡い色の絵(鍵は bg:col-コラムの id) */
  colorRows?: ReadonlyMap<string, ColorLook>;
}

/**
 * 打鍵はこの欄のローカル状態に即時反映し、**手が止まってから(400ms)まとめて親へ渡す。**
 *
 * 組版の栓(data-defer-typeset)だけでは足りなかった(2026-09-14 ユーザー報告
 * 「打っている間は空白のままで、あとからだだだっと進む」)。1打鍵ごとに store へ
 * 入れる作りだと、履歴・自動保存・App全体の再描画が毎打鍵走って入力を塞ぐ。
 * 親に渡すのは手が止まったときと欄を離れたときだけ(取り消しの単位も文節でまとまる)。
 * 外から値が変わったとき(取り消しなど)は、欄にフォーカスが無ければ追従する
 */
function useLazyText(value: string, onCommit: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef(0);
  const committed = useRef(value);
  const el = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  /** App が Ctrl+Z で戻した直後だけは、フォーカス中でも外の値に合わせる(TYPING_REVERTED) */
  const follow = useRef(false);
  /** いちばん新しく受け取った外の値(描くたびに更新) */
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if ((!focused.current || follow.current) && value !== committed.current) {
      follow.current = false;
      committed.current = value;
      setDraft(value);
    }
  }, [value]);
  const commit = (v: string) => {
    if (v === committed.current) return;
    committed.current = v;
    onCommit(v);
    // 店へ渡したことを App へ(Ctrl+Z の「この欄の打ち始め」を記録し直してもらう。typingEvents)
    el.current?.dispatchEvent(new Event(TYPING_COMMITTED, { bubbles: true }));
  };
  // Ctrl+Z の直前に App から「いま渡して」が来る。溜めている字をその場で渡す。
  // commit は描くたびに作り直すので、受け口も描くたびに付け直す
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const flush = () => {
      window.clearTimeout(timer.current);
      commit(node.value);
    };
    const reverted = () => {
      // 打ってすぐ(0.4 秒のうちに)戻したときは、渡した値と戻した値が同じ描き直しに入るので、
      // 外の値は「打つ前」のまま変わらず、上の追従が走らない。受け取っている値(= 打つ前)へ直に戻す。
      // 渡し終えてから戻したときは、このあと値が変わって上の追従が走る
      if (latest.current !== committed.current) {
        committed.current = latest.current;
        setDraft(latest.current);
      } else {
        follow.current = true;
      }
    };
    node.addEventListener(TYPING_FLUSH, flush);
    node.addEventListener(TYPING_REVERTED, reverted);
    return () => {
      node.removeEventListener(TYPING_FLUSH, flush);
      node.removeEventListener(TYPING_REVERTED, reverted);
    };
  });
  return {
    ref: el,
    value: draft,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: (e: { currentTarget: { value: string } }) => {
      focused.current = false;
      window.clearTimeout(timer.current);
      commit(e.currentTarget.value);
    },
    onChange: (e: { currentTarget: { value: string } }) => {
      const v = e.currentTarget.value;
      setDraft(v);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => commit(v), 400);
    },
  };
}

function LazyTextarea({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'onFocus' | 'onBlur'
>) {
  return <textarea {...rest} {...useLazyText(value, onCommit)} />;
}

function LazyInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onFocus' | 'onBlur'
>) {
  return <input {...rest} {...useLazyText(value, onCommit)} />;
}

/** 組み方向の選び方。既定は「本文と逆」= この機能そのもの */
const MODE_OPTIONS: [string, string][] = [
  ['auto', '本文と逆（おすすめ）'],
  ['horizontal', '横組み'],
  ['vertical', '縦組み'],
];

export function ColumnPageEditor({
  settings,
  chapters,
  onChange,
  layoutInfo,
  onJump,
  onAdded,
  highlightId,
  onFollow,
  ebookView = false,
  printColor = false,
  colorRows,
}: Props) {
  const pages = settings.columnPages ?? [];
  /** 地の絵の「白黒で刷る」(4-6)。本文全体の絵を継いでいるコラムは、本文全体の欄で選ぶことを言う */
  const monoFor = (c: ColumnPage) =>
    bgMonoProps(c.bg, (spec) => patch(c.id, { bg: spec }), {
      printColor: printColor && !ebookView,
      look: colorRows?.get(`bg:col-${c.id}`),
      bodyHasImage: Boolean(settings.bodyBg),
      bodyMono: Boolean(settings.bodyBgPrintMono),
    });
  /**
   * 作るもの。**組み方向の切り替えと「1ページに収まるか」は紙の本だけの話。**(2026-09-23 ユーザー指摘
   * 「電子書籍は縦読みと横読み、どちらか一つしか対応しないんじゃない？」)。EPUB ではコラムも本文と
   * 同じ向きで流す(exporters/epub.ts の colPageXhtml)ので、電子だけの本にはこの2つを出さず、
   * 紙と電子の両方を作る本には「電子では本文と同じ向き」を添える。
   *
   * 調べた事実(同日): 1冊で1つに決まるのは**めくる向き**(spine の page-progression-direction)。
   * 文字の組み方向は XHTML ごとに変えられる(EPUB 3.3 §5.7.1、Apple Books は「1ファイル1方向、
   * 両方使うならファイルを分ける」、電書連テンプレートも横組みの奥付をファイル単位で持つ)。
   * ただし Kindle の現行ガイドと Kobo の公式仕様はファイルごとの混在に触れていないので、
   * 画面の断りは「崩れる」ではなく「確かめが要るので本文にそろえている」と言う
   */
  const out = outputsOf(settings);
  // 版面はここで出す。判型・文字サイズ・余白を変えると収まる量も変わるので、
  // 保存された値ではなく毎回いまの設定から計算する
  const layout = computeLayout(settings);

  /**
   * どの1枚の背景の一覧を開いているか。開いているあいだは他の行を描かない
   * (サイドバーをその一覧専用にする。他の面のピッカーと同じ扱い)
   */
  const [bgFor, setBgFor] = useState<string | null>(null);

  /** 増えた行を見せに行く(挿絵ページ PlateEditor と同じ仕掛け・同じ理由) */
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashRow = (id: string) => {
    setFlashId(id);
    requestAnimationFrame(() => {
      document
        .querySelector(`.colpage-list li[data-id="${id}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };
  useEffect(() => {
    if (!highlightId) return;
    flashRow(highlightId);
  }, [highlightId]);
  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 2200);
    return () => clearTimeout(t);
  }, [flashId]);

  function add() {
    // crypto.randomUUID は挿絵ページでも使っているので、この環境では使える
    const id = crypto.randomUUID();
    onChange([
      {
        id,
        title: '',
        text: '',
        // 既定は**本文の最初**(挿絵ページと同じ)。巻末だと一覧でも末尾に出て
        // 「押したのに増えていない」と探させた(2026-09-04 ユーザー報告)。
        // 配列の先頭へ入れる理由も挿絵ページ(PlateEditor.addEmpty)と同じ
        beforeChapter: 0,
      },
      ...pages,
    ]);
    onAdded?.(id);
  }

  function patch(id: string, p: Partial<ColumnPage>) {
    onChange(pages.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }

  // 「このページの地」の一覧を開いているあいだは、選ぶ画面**だけ**を描く。
  // カードの中に入れたままだと、選択画面(absolute配置)がカードの小さな枠に
  // 張り付いて1列分しか見えなくなる(2026-09-13 ユーザー報告)。
  // 背景タブ(ArtStep の openBg)と同じ作法
  const bgCol = bgFor ? pages.find((p) => p.id === bgFor) : undefined;
  if (bgCol) {
    return (
      <div className="colpages">
        <BackgroundPicker
          label="このページの地"
          hint="指定しなければ本文の背景をそのまま使います"
          inheritFrom="本文"
          value={bgCol.bg}
          onChange={(spec) => patch(bgCol.id, { bg: spec })}
          allowPlain
          {...monoFor(bgCol)}
          open
          onOpenChange={(o) => setBgFor(o ? bgCol.id : null)}
        />
      </div>
    );
  }

  return (
    <div className="colpages">
      <button className="ghost add-page" onClick={add}>
        コラムページを足す
      </button>
      {/* 「本文と逆」は本文の組み方向に付いて回る。本文を縦→横にした瞬間、
          コラムも横→縦に回って、横組み前提の文章があふれた(2026-09-04 ユーザー報告)。
          仕組みは既定のままでよい(この機能そのもの)が、回ることは先に言っておく */}
      {pages.length > 0 &&
        (out.paper ? (
          <p className="hint">
            <b>紙の本では</b>、組み方向が<b>「本文と逆」</b>のページは、本文の組み方向を変えると
            <b>一緒に回ります</b>。回したくないページは、下の欄で<b>横組み／縦組みに固定</b>してください
            （収まらなくなったら、そのページに赤い警告が出ます）
            {out.ebook && (
              <>
                。<b>電子書籍では、コラムも本文と同じ向き</b>で流れます（めくる向きは1冊で1つ。
                ページごとに組み方向を変える作りは、ストアや端末ごとの確かめが要るので、本文にそろえています）
              </>
            )}
          </p>
        ) : (
          <p className="hint">
            電子書籍では、コラムも<b>本文と同じ向き</b>で流れます（めくる向きは1冊で1つ。ページごとに
            組み方向を変える作りは、ストアや端末ごとの確かめが要るので、本文にそろえています）。
            ページの区切りも読む端末が決めるので、1ページに収める必要はありません
          </p>
        ))}

      {pages.length > 0 && (
        <ul className="colpage-list">
          {/* 一覧は**ページ順(場所→順番)**で並べる(挿絵ページと同じ理由。
              表示だけの並べ替えで、onChange は id で触るので壊れない) */}
          {pages
            .map((c, idx) => [c, idx] as const)
            .filter(([c]) => !bgFor || bgFor === c.id)
            .sort(
              // order の無いものは末尾扱い+配列順(組版と同じ規則。挿絵ページと同じ)
              ([a, ai], [b, bi]) =>
                a.beforeChapter - b.beforeChapter ||
                (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
                ai - bi,
            )
            .map(([c], i) => {
            const mode = columnPageMode(c, settings.writingMode);
            const page = layoutInfo?.colPagePages.get(c.id);
            const paragraphs = columnPageParagraphs(c.text);
            const fit = fitColumnPage(layout, mode, c.title, paragraphs, {
              fontPt: c.fontPt,
              lineFeedPt: c.lineFeedPt,
              padXPct: c.padXPct,
              padYPct: c.padYPct,
            });
            return (
              <li
                key={c.id}
                data-id={c.id}
                // 書体・大きさ・色・フチ・帯・地・余白は紙の1ページのための指定(EPUB は本文と同じに流す)。
                // 電子書籍だけの本では見せない(.ebook-only の CSS で隠す)
                className={
                  [flashId === c.id ? 'row-flash' : '', out.paper ? '' : 'ebook-only']
                    .filter(Boolean)
                    .join(' ') || undefined
                }
              >
                <div className="colpage-head">
                  {/* **頭の帯に見出しも出す。**(2026-10-09 ユーザー指摘「どこまでが1つのコラムの話なのか
                      わかりにくい」) 「1枚目」だけでは、どのコラムのカードかが帯から読めない */}
                  <b className="colpage-name">
                    {i + 1}枚目
                    {c.title.trim() && <span>「{c.title.trim()}」</span>}
                  </b>
                  {/* **押すとそこへ飛ぶ。**(2026-08-19 ユーザー指摘)
                      「1枚目」だけでは、プレビューのどこのことなのか結びつかない */}
                  {ebookView
                    ? // 空のコラムは EPUB に入らない
                      (c.title.trim() || c.text.trim()) && (
                        <button className="linklike" onClick={() => onFollow?.(c.id)}>
                          電子の下見で見る
                        </button>
                      )
                    : page !== undefined && (
                        <button className="linklike" onClick={() => onJump?.(page)}>
                          {page} ページ目（見る）
                        </button>
                      )}
                  {/* 「見る」の真横にあり、打ち込んだ本文が1クリックで消えるので確かめる
                      (2026-09-04 レビュー指摘。中身が空のときは訊かない) */}
                  <button
                    className="ghost"
                    onClick={() => {
                      const hasText = c.title.trim() || c.text.trim();
                      if (hasText && !window.confirm(`${i + 1}枚目のコラムを削除しますか？\n（Ctrl+Z で元に戻せます）`)) {
                        return;
                      }
                      onChange(pages.filter((x) => x.id !== c.id));
                    }}
                  >
                    ページを削除
                  </button>
                </div>

                {/* 置く場所と組み方向。ページそのものの扱いなので、文章・画像の手前に置く */}
                <div className="colpage-place">
                  <label className="stack">
                    置く場所
                    <select
                      value={Math.min(c.beforeChapter, chapters.length)}
                      onChange={(e) => {
                        patch(c.id, { beforeChapter: Number(e.target.value) });
                        // 一覧はページ順に並べ直すので、動いた行へ寄り、プレビューもそこへ送る
                        flashRow(c.id);
                        onFollow?.(c.id);
                      }}
                    >
                      {chapters.map((_, ci) => (
                        <option key={ci} value={ci}>{positionLabel(chapters, ci)}</option>
                      ))}
                      <option value={chapters.length}>
                        {positionLabel(chapters, chapters.length)}
                      </option>
                    </select>
                  </label>
                  {out.paper && (
                    <label className="stack">
                      組み方向
                      <select
                        value={c.writingMode ?? 'auto'}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === 'auto') {
                            const next = { ...c };
                            delete next.writingMode;
                            onChange(pages.map((x) => (x.id === c.id ? next : x)));
                          } else {
                            patch(c.id, { writingMode: v as WritingMode });
                          }
                        }}
                      >
                        {MODE_OPTIONS.map(([v, label]) => (
                          <option key={v} value={v}>{label}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                {/* **① 文章と ② 画像を、地の色を変えた別の区画にする。**(2026-10-09 ユーザー指摘
                    「原稿を入れる場所と画像を入れる場所がわかりにくい。同じコラムの話だけど、
                    やっている作業が明らかに異なることを示してほしい」) */}
                <section className="colpage-sec colpage-sec-text">
                  <h4 className="colpage-sec-title">① 文章</h4>
                  {/* data-defer-typeset: 打っているあいだ組版を待たせる(奥付と同じ。
                      コラムも1ページに閉じた紙面なので、1文字ごとに全体を組む意味がない) */}
                  <label className="stack">
                    見出し
                    <LazyInput
                      data-defer-typeset=""
                      type="text"
                      value={c.title}
                      placeholder="空でもかまいません"
                      onCommit={(v) => patch(c.id, { title: v })}
                    />
                  </label>
                  <label className="stack">
                    本文
                    <LazyTextarea
                      data-defer-typeset=""
                      rows={6}
                      value={c.text}
                      placeholder="コラムの文章。改行すると段落が変わります"
                      onCommit={(v) => patch(c.id, { text: v })}
                    />
                  </label>

                  {/* **行で数えて行で見せる。**(2026-09-11 ユーザー報告
                      「字数は収まっているのにエラーが出る」) 収まるかは行数で決まる
                      (短い段落は1行を丸ごと使う)のに、字数の目安だけ出していたので、
                      「196字 < 209字なのに赤」という矛盾に見えた。主役を行数にして、
                      字数はあくまで参考として添える。**文章の区画に置く** — 書く量と並べて見るもの */}
                  {out.paper && (
                  <>
                  <p className="readout">
                    {mode === 'vertical' ? '縦組み' : '横組み'}／
                    1行 <b>{fit.charsPerLine}字</b>×<b>{fit.linesPerPage}行</b>
                    <small>
                      いまの行数<b>{Math.ceil(fit.usedLines)}行</b>
                    </small>
                    <small>
                      入る行数<b>約{Math.floor(fit.bodyLines)}行</b>
                    </small>
                    <small>
                      （字数 {fit.chars}／目安 約{fit.capacity}。短い段落が多いと行が先に尽きます）
                    </small>
                  </p>
                  {fit.over ? (
                    <p className="error colpage-over">
                      1ページに収まりません（目安{Math.floor(fit.bodyLines)}行のところ
                      {Math.ceil(fit.usedLines)}行あります）。
                      <b>はみ出した部分は印刷されない</b>ため、
                      文章を減らすか、画面下の帯で文字を小さくしてください。
                    </p>
                  ) : Math.floor(fit.bodyLines - fit.usedLines) < 1 ? (
                    /* 目安どうしの引き算が0や負でも、あふれ判定(over)が通っていれば
                       実際にはぎりぎり収まる見込み。「あと-1行書けます」のような
                       意味不明な表示を出さない(2026-09-13 ユーザー報告のスクショ) */
                    <p className="hint">
                      ぎりぎりです。紙の下見で最後の行まで出ているか確かめてください
                    </p>
                  ) : (
                    <p className="hint">
                      あと{Math.floor(fit.bodyLines - fit.usedLines)}行ぶん書けます
                    </p>
                  )}
                  </>
                  )}
                </section>

                {out.paper && (
                <section className="colpage-sec colpage-sec-art">
                  <h4 className="colpage-sec-title">② 背景画像</h4>
                  {/* **このページだけの地。**(2026-08-20 ユーザー要望)
                      章ごとの背景と同じ持ち方。コラムは本文と別ものの1ページなので、
                      地も別にできて初めて独立した面になる。
                      **濃さとフチの調整は出さない。** 帯の「背景の濃さ」「文字のフチ」と同じ値なので、
                      2か所に置くとまた取り違える(2026-10-09) */}
                  <BackgroundPicker
                    label="このページの地"
                    hint="指定しなければ本文の背景をそのまま使います"
                    inheritFrom="本文"
                    value={c.bg}
                    onChange={(spec) => patch(c.id, { bg: spec })}
                    allowPlain
                    {...monoFor(c)}
                    open={bgFor === c.id}
                    onOpenChange={(o) => setBgFor(o ? c.id : null)}
                  />
                  {/* 文字のまわりの余白は画面下の帯へ移した(2026-10-09 ユーザー要望「文字回りの余白の話だから、デザインバーに入れた方がいい」。FormatBar のコラムの欄) */}
                </section>
                )}

                {/* **見た目は帯だけで変える。**(2026-10-09 ユーザー要望「デザイン関連は下のバーで
                    いじれるだけにして、左の柱からは、下のバーでできることは削除したい」)
                    書体・大きさ・色・フチ・帯・背景の濃さは、右の下見でこのページを開くと
                    帯がこのコラムに切り替わる(FormatBar の visibleColumns)。その道をここで言う */}
                {out.paper && !ebookView && (
                  <p className="hint colpage-design-note">
                    書体や色などの見た目は、<b>画面下の帯</b>で変えられます。
                    このページを開くと、帯がこのコラムの設定に切り替わります。
                    {page !== undefined && (
                      <>
                        {' '}
                        <button className="linklike" onClick={() => onJump?.(page)}>
                          このページを開く
                        </button>
                      </>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
