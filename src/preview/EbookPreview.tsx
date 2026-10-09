// 電子書籍(EPUB)の下見。**書き出す XHTML そのものを、読む端末くらいの枠で1画面ずつめくる。**
//
// 2026-09-24 ユーザーの問題提起:「電子書籍のプレビューを見せないといけない気がしている。
// 奥付は縦書きなら横には入らないし、コラムの組み方向も全体の組に合わせることになる。
// これを言葉で言うだけでは不親切ではないのか」。同日の決定(ユーザー選択):
// 1画面ずつめくる / 紙と電子の切り替えはプレビューの上と書き出しタブ /
// 電子書籍だけの本は紙の組版を止めて電子の下見だけにする。
//
// ## 作り
//
// - 中身は exporters/epub.ts の buildEpubBook が作る(書き出しと同じ関数。違うのは画像の参照先だけ)
// - 1ファイル(XHTML)ずつ iframe に XML として読ませる。**読む機械と同じく、ファイルの境目で必ず改ページ**
// - 本文・目次・コラム・奥付は、段組み(multicol)で画面の大きさごとに区切る。縦組みの段は
//   上から下へ積まれるので、「次」は1画面ぶん下へ送る(見た目は右から左にめくるのと同じ)。
//   扉・挿絵・表紙は1画面のまま(full-page の器が高さ100%で収める)
// - Vivliostyle は使わない。**開いたときに1ファイルだけ組む**ので軽い
//   (実測 2026-09-24: 本1冊の中身を作るのに 0.02〜0.07秒、1ファイルを出すのは一瞬)
//
// ## 読む機械との違い(正直に)
//
// これは Chrome で流した一例。書体・文字の大きさ・余白・改ページの細部は読む機械ごとに違う。
// 画面にもそう断り、入稿前にストアのプレビューで確かめることは HELP_EPUB_DIFF.check のとおり残す
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EpubBook, EpubSpineDoc } from '../exporters/epub';
import type { Manuscript, ProjectSettings } from '../models/project';
import { plainText } from '../models/inlineImages';

/** 読む順の各ページの呼び名。ページを選ぶ一覧と、いまどこかの表示に使う */
export function spineLabels(book: EpubBook, ms: Manuscript, s: ProjectSettings): string[] {
  let plates = 0;
  return book.spine.map((d) => {
    switch (d.kind) {
      case 'cover':
        return '表紙';
      case 'titlepage':
        return '大扉';
      case 'toc':
        return '目次';
      case 'chapter': {
        const ch = ms.chapters[d.chapter ?? 0];
        const name = ch ? [ch.no, plainText(ch.title)].filter(Boolean).join('　') : '';
        return name || `${(d.chapter ?? 0) + 1}つめの章`;
      }
      case 'plate':
        plates += 1;
        return `挿絵ページ ${plates}`;
      case 'colpage': {
        const c = (s.columnPages ?? []).find((x) => x.id === d.sourceId);
        const t = c?.title.trim();
        return t ? `コラム「${plainText(t)}」` : 'コラム';
      }
      case 'colophon':
        return '奥付';
    }
  });
}

/** 画面の大きさ(CSS px)。Kindle 端末は 3:4、スマホは縦長 */
const DEVICES = {
  kindle: { label: 'Kindle 端末くらい', w: 360, h: 480 },
  phone: { label: 'スマホくらい', w: 360, h: 720 },
} as const;
type Device = keyof typeof DEVICES;

/** 文字の大きさ(読む人が端末で変えられる。その幅を見せる) */
const FONT_STEPS = {
  small: { label: '小', px: 14 },
  medium: { label: '中', px: 16 },
  large: { label: '大', px: 20 },
} as const;
type FontStep = keyof typeof FONT_STEPS;

/** 画面の縁のアキ(CSS px)。読む機械の既定の余白に近い値 */
const MARGIN = 18;

/** めくる段組みを掛けるページ。扉・挿絵・表紙は1画面の器で収めるので掛けない */
const FLOWS: EpubSpineDoc['kind'][] = ['toc', 'chapter', 'colpage', 'colophon'];

/**
 * めくるための CSS。**書き出す style.css のあとに足すだけ**(書き出すファイルには入らない)。
 *
 * 段の幅を「画面 − 縁×2」、段の間を「縁×2」にすると、1段の送りがちょうど画面1枚ぶんになる。
 * 縦組みは段が上から下へ積まれるので scrollTop を、横組みは scrollLeft を画面ずつ送る。
 *
 * **絵は画面に収める(!important)。** 書き出す CSS の figure の img は max-width: 100% だが、
 * 縦組みの図版の箱は幅が決まらないので効かず、画面から大きくはみ出した(実測 592px/360px)。
 * 読む機械は絵を画面に収めて出すので、下見もそれに合わせる
 */
function pagedCss(vertical: boolean, fontPx: number): string {
  const col = vertical
    ? `column-width: calc(100vh - ${2 * MARGIN}px);`
    : `column-width: calc(100vw - ${2 * MARGIN}px);`;
  return `:root {
  height: 100vh; width: 100vw; margin: 0; padding: ${MARGIN}px; box-sizing: border-box;
  ${col} column-gap: ${2 * MARGIN}px; column-fill: auto; overflow: hidden;
  font-size: ${fontPx}px;
}
body { margin: 0; }
img { max-height: calc(100vh - ${2 * MARGIN}px) !important; max-width: calc(100vw - ${2 * MARGIN}px) !important; }
`;
}

/** 1画面の器(扉・挿絵・表紙)にも、文字の大きさと縁だけは合わせる */
function fullCss(fontPx: number): string {
  return `:root { font-size: ${fontPx}px; }
body { margin: 0; padding: ${MARGIN}px; box-sizing: border-box; overflow: hidden; }
`;
}

interface Props {
  book: EpubBook;
  vertical: boolean;
  /** 読む順の各ページの呼び名(book.spine と同じ長さ) */
  labels: string[];
  /**
   * 開いてほしいページ(ファイル名)。seq が変わるたびに飛ぶ。
   * 奥付の工程を開いたときに奥付へ、など
   */
  /** img: そのファイルの中の何枚目の絵(0始まり)の画面を開くか。章の途中の絵をいじったとき */
  focus?: { file: string; seq: number; img?: number } | null;
  /** 紙と電子の切り替え(App)。紙の下見と同じく画面の下に置く。両方を作る本だけ渡ってくる */
  modeSwitch?: ReactNode;
}

export function EbookPreview({ book, vertical, labels, focus, modeSwitch }: Props) {
  const [device, setDevice] = useState<Device>('kindle');
  const [fontStep, setFontStep] = useState<FontStep>('medium');
  /** いま開いている読む順の位置と、その中の画面 */
  const [doc, setDoc] = useState(0);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  /** 前のページへ戻ってきたときは、そのファイルの最後の画面から見せる */
  const wantLast = useRef(false);
  /**
   * 開いてほしい絵(ファイルの中で何枚目か)。**絵や書体が届くたびに画面の数が変わる**ので、
   * 読み込みが落ち着くまで持っておき、そのたびに絵のある画面へ合わせ直す。
   * 利用者が自分でめくったら捨てる(めくったあとに引き戻さない)
   */
  const anchorRef = useRef<number | null>(null);
  /**
   * 開いたときにもう立っていた合図。**これには応じない。** 前に立った合図(奥付の工程で立てたもの
   * など)を、下見を開き直すたびに拾って本の最後へ飛んでいた(2026-09-24 レビューで発見)
   */
  const mountSeq = useRef(focus?.seq);
  /** 読み込みを隠れた枠の中でした(寸法が 0 で数えられなかった)。出てきたら数え直す */
  const pendingRef = useRef(false);
  const settleRef = useRef<(() => void) | null>(null);
  /**
   * いま開いているファイル。**本が作り直されたら、同じファイルを探して開き直す。**
   * 並びの番号で持っていたので、手前に目次やコラムが増えると隣のファイルへずれた
   * (2026-09-24 レビューで発見)。ファイルを移ったときだけ書き換える(本の作り直しでは書き換えない)
   */
  const curFileRef = useRef<string | null>(null);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const { w: W, h: H } = DEVICES[device];
  const fontPx = FONT_STEPS[fontStep].px;
  const spine = book.spine;
  const cur = spine[Math.min(doc, spine.length - 1)];

  useEffect(() => {
    curFileRef.current = spine[doc]?.file ?? null;
    // 本の作り直し(spine)では書き換えない。ファイルを移ったときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);
  // 本が作り直されたら(設定を変えた)、同じファイルを開き直す。無くなっていれば収める
  useEffect(() => {
    const f = curFileRef.current;
    const i = f ? spine.findIndex((d) => d.file === f) : -1;
    if (i >= 0) {
      if (i !== doc) setDoc(i);
      return;
    }
    if (doc > spine.length - 1) {
      setDoc(Math.max(0, spine.length - 1));
      setPage(0);
    }
    // doc は上の効果が追いかける。spine が替わったときだけ見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spine]);

  /** そのファイルの n 枚目の絵が載っている画面(0始まり)。見つからなければ null */
  const pageOfImg = (n: number): number | null => {
    const d = frameRef.current?.contentDocument;
    const img = d?.querySelectorAll('img')[n];
    if (!d || !img) return null;
    const root = d.documentElement;
    const r = img.getBoundingClientRect();
    const p = vertical
      ? Math.floor((r.top + root.scrollTop + 1) / H)
      : Math.floor((r.left + root.scrollLeft + 1) / W);
    return Math.max(0, p);
  };

  // 外から「ここを開いて」と言われたら飛ぶ
  useEffect(() => {
    if (!focus || focus.seq === mountSeq.current) return;
    const i = spine.findIndex((d) => d.file === focus.file);
    if (i < 0) return;
    anchorRef.current = focus.img ?? null;
    if (i === doc && anchorRef.current !== null) {
      // 同じファイルを開いているなら読み直しは起きない。いまの中身から探す
      const p = pageOfImg(anchorRef.current);
      setPage(p ?? 0);
    } else {
      setDoc(i);
      setPage(0);
    }
    // spine は book と一緒に変わる。focus の合図(seq)だけで飛ぶ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  /**
   * CSS は**ファイルの中に書き込む**(CDATA で囲んだ style)。
   * blob URL にして link で読ませていたら、開発中の React が後片づけを2回走らせたときに
   * 使っている最中の URL を捨ててしまい、読み込みに失敗した(ERR_FILE_NOT_FOUND。2026-09-24 実測)
   */
  const styles = useMemo(
    () => ({ base: book.css, paged: pagedCss(vertical, fontPx), full: fullCss(fontPx) }),
    [book, vertical, fontPx],
  );

  /** いまの画面へ送る */
  const scrollTo = useCallback(
    (p: number) => {
      const root = frameRef.current?.contentDocument?.documentElement;
      if (!root) return;
      if (vertical) root.scrollTop = p * H;
      else root.scrollLeft = p * W;
    },
    [vertical, W, H],
  );

  /** そのファイルが何画面あるか。絵や書体が読み込まれるたびに数え直す */
  const measure = useCallback(() => {
    const d = frameRef.current?.contentDocument;
    if (!d || !cur) return;
    // **隠れた枠では数えない。** 寸法が 0 の中で数えると、12画面のファイルが 228画面などと出て、
    // めくっても進まなくなった(2026-09-24 レビューで発見)。出てきたところで数え直す
    if (!frameRef.current || frameRef.current.getClientRects().length === 0) {
      pendingRef.current = true;
      return;
    }
    pendingRef.current = false;
    const root = d.documentElement;
    if (!FLOWS.includes(cur.kind)) {
      setPages(1);
      return 1;
    }
    /**
     * **最後の画面まで送れるよう、終わりに目印を置く。**(2026-09-24 ユーザー報告
     * 「何ページか下の文字が切れてしまっている」)。スクロールできる範囲は最後の段の**文字の終わり**
     * までしかないので、最後の画面だけ縁のアキ(18px)ぶん手前で止まり、上が空いて下の字が切れた。
     * 目印は「画面の数 × 画面の大きさ」の位置に置くので、数え直しても画面の数は変わらない。
     * 数は切り上げ(最後の段が短くても1画面と数える。四捨五入だと最後の画面が消えることがある)
     */
    const extent = vertical ? root.scrollHeight : root.scrollWidth;
    const size = vertical ? H : W;
    const n = Math.max(1, Math.ceil((extent - 2) / size));
    let end = d.getElementById('ebook-preview-end');
    if (!end) {
      end = d.createElement('div');
      end.id = 'ebook-preview-end';
      end.setAttribute('aria-hidden', 'true');
      d.body.appendChild(end);
    }
    end.setAttribute(
      'style',
      `position: absolute; width: 1px; height: 1px; ${
        vertical ? `top: ${n * H - 1}px; right: 0` : `left: ${n * W - 1}px; top: 0`
      }`,
    );
    setPages(n);
    return n;
  }, [cur, vertical, W, H]);

  // ファイルを読み込む。本・ファイル・文字の大きさ・画面の大きさが変わったら読み直す
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !cur) return;
    const flow = FLOWS.includes(cur.kind);
    const inline = (css: string) => `<style type="text/css">/*<![CDATA[*/\n${css}\n/*]]>*/</style>`;
    const x = (book.files.get(cur.file) ?? '').replace(
      '<link rel="stylesheet" type="text/css" href="style.css"/>',
      `${inline(styles.base)}\n${inline(flow ? styles.paged : styles.full)}`,
    );
    const url = URL.createObjectURL(new Blob([x], { type: 'application/xhtml+xml' }));
    let alive = true;
    frame.onload = () => {
      if (!alive) return;
      const d = frame.contentDocument;
      if (!d) return;
      // **目次のリンクと画面の左右のクリックは、ここで受け止める。**
      // iframe の中でリンクをたどると blob の外(存在しないファイル)へ飛んでしまう
      d.addEventListener('click', (e) => {
        const a = (e.target as Element | null)?.closest?.('a');
        if (a) {
          e.preventDefault();
          const href = a.getAttribute('href') ?? '';
          const file = href.split('#')[0];
          const i = spine.findIndex((s) => s.file === file);
          if (i >= 0) {
            setDoc(i);
            setPage(0);
          } else if (/^https?:/.test(href)) {
            window.open(href, '_blank', 'noopener');
          }
          return;
        }
        // 画面の左右の端を押してもめくれる(読む端末と同じ)
        const x0 = (e as MouseEvent).clientX;
        if (x0 < W * 0.35) leftRef.current();
        else if (x0 > W * 0.65) rightRef.current();
      });
      const settle = () => {
        const measured = measure();
        if (measured === undefined) return;
        const n = measured;
        if (anchorRef.current !== null) {
          const p = pageOfImg(anchorRef.current);
          if (p !== null) {
            const q = Math.min(p, n - 1);
            setPage(q);
            scrollTo(q);
            return;
          }
        }
        if (wantLast.current) {
          wantLast.current = false;
          setPage(n - 1);
          scrollTo(n - 1);
        } else {
          setPage((p) => {
            const q = Math.min(p, n - 1);
            scrollTo(q);
            return q;
          });
        }
      };
      settleRef.current = settle;
      // 枠の中にいても矢印キーでめくれるように(中を押すと、キーはこちらの窓に届かなくなる)
      d.addEventListener('keydown', (e) => keyRef.current(e));
      d.addEventListener('wheel', (e) => wheelRef.current(e), { passive: false });
      settle();
      // 絵と書体が届くと画面の数が変わるので、届いたところで数え直す
      d.querySelectorAll('img').forEach((img) => {
        if (!img.complete) img.addEventListener('load', settle, { once: true });
      });
      void d.fonts?.ready.then(() => alive && settle());
    };
    frame.src = url;
    return () => {
      alive = false;
      frame.onload = null;
      // 次のファイルを読み始めてから捨てる(読み込み中の URL を先に捨てると空白になる)
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    // measure/scrollTo は W/H/vertical/cur から作り直される
  }, [book, cur, styles, W, H, measure, scrollTo, spine]);

  // 画面の中の位置を反映する
  useEffect(() => {
    scrollTo(page);
  }, [page, scrollTo]);

  /** 次へ・前へ。ファイルの端では隣のファイルへ */
  const next = useCallback(() => {
    anchorRef.current = null;
    if (page < pages - 1) setPage(page + 1);
    else if (doc < spine.length - 1) {
      setDoc(doc + 1);
      setPage(0);
    }
  }, [page, pages, doc, spine.length]);
  const prev = useCallback(() => {
    anchorRef.current = null;
    if (page > 0) setPage(page - 1);
    else if (doc > 0) {
      wantLast.current = true;
      setDoc(doc - 1);
    }
  }, [page, doc]);
  /** 画面の左・右。**右綴じ(縦組み)は左が次**(入口のサンプル本・紙の見開きと同じ約束) */
  const left = vertical ? next : prev;
  const right = vertical ? prev : next;
  const leftRef = useRef(left);
  const rightRef = useRef(right);
  leftRef.current = left;
  rightRef.current = right;

  /**
   * **マウスのスクロール(ホイール)でもめくる。**(2026-09-24 ユーザー要望)
   * 下へ回すと次、上へ回すと前。ひと回しで1画面だけ送る(タッチパッドは細かい量が続けて届くので、
   * 送ったあと少し待つ)。枠の外(下見の地)でも中でも効かせる
   */
  const nextRef = useRef<() => void>(() => {});
  const prevRef = useRef<() => void>(() => {});
  nextRef.current = next;
  prevRef.current = prev;
  const lastWheel = useRef(0);
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const dy = e.deltaY;
    const dx = e.deltaX;
    if (Math.max(Math.abs(dy), Math.abs(dx)) < 4) return;
    const t = performance.now();
    if (t - lastWheel.current < 350) return;
    lastWheel.current = t;
    // 横に払ったときは画面の左右と同じ向き(縦組みは左へ払うと次)
    const forward = Math.abs(dy) >= Math.abs(dx) ? dy > 0 : vertical ? dx < 0 : dx > 0;
    if (forward) nextRef.current();
    else prevRef.current();
  };
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 矢印キーでもめくる。入力欄にいるとき・下見が隠れているときは奪わない
  // (隠れた下見をめくると、ほかの画面の ← → で電子の下見が勝手に進んでいた。2026-09-24 レビューで発見)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    if (!stageRef.current?.getClientRects().length) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('[role="dialog"]')) return;
    if (e.key === 'ArrowLeft') leftRef.current();
    else if (e.key === 'ArrowRight') rightRef.current();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 枠を、置き場所に収まる大きさまで拡大・縮小する
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 32) / (W + 24), (r.height - 24) / (H + 24), 1.8);
      setScale(Math.max(0.4, s));
      // 隠れているあいだに読み込んだファイルは、出てきたここで数え直す
      if (pendingRef.current && frameRef.current?.getClientRects().length) settleRef.current?.();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  const atStart = doc === 0 && page === 0;
  const atEnd = doc === spine.length - 1 && page >= pages - 1;

  return (
    <div className="ebook-preview">
      <div className="ebook-bar">
        <label className="ebook-where">
          <select
            value={doc}
            onChange={(e) => {
              anchorRef.current = null;
              setDoc(Number(e.target.value));
              setPage(0);
            }}
            aria-label="読む順のページへ移る"
          >
            {spine.map((d, i) => (
              <option key={d.file} value={i}>
                {labels[i] ?? d.file}
              </option>
            ))}
          </select>
        </label>
        <div className="seg ebook-seg" role="group" aria-label="画面の大きさ">
          {(Object.keys(DEVICES) as Device[]).map((k) => (
            <button key={k} className={device === k ? 'active' : ''} onClick={() => setDevice(k)}>
              {DEVICES[k].label}
            </button>
          ))}
        </div>
        <div className="seg ebook-seg" role="group" aria-label="文字の大きさ">
          <span className="ebook-seg-name">文字</span>
          {(Object.keys(FONT_STEPS) as FontStep[]).map((k) => (
            <button key={k} className={fontStep === k ? 'active' : ''} onClick={() => setFontStep(k)}>
              {FONT_STEPS[k].label}
            </button>
          ))}
        </div>
      </div>

      <div className="ebook-stage" ref={stageRef}>
        <button
          className="ebook-side ebook-side-l"
          onClick={left}
          disabled={vertical ? atEnd : atStart}
          aria-label={vertical ? '次へ' : '前へ'}
          title={vertical ? '次へ' : '前へ'}
        >
          ‹
        </button>
        <div
          className="ebook-device"
          style={{ width: W, height: H, transform: `scale(${scale})` }}
        >
          <iframe
            ref={frameRef}
            title="電子書籍の下見"
            sandbox="allow-same-origin"
            style={{ width: W, height: H }}
          />
        </div>
        <button
          className="ebook-side ebook-side-r"
          onClick={right}
          disabled={vertical ? atStart : atEnd}
          aria-label={vertical ? '前へ' : '次へ'}
          title={vertical ? '前へ' : '次へ'}
        >
          ›
        </button>
      </div>

      <div className="ebook-foot">
        {modeSwitch}
        <p className="ebook-now">
          {labels[doc] ?? ''}　{page + 1} / {pages}
        </p>
      </div>
      <p className="hint ebook-note">
        書体は<b>本文が明朝、見出しと太字がゴシックで固定</b>です（電子書籍は読む人の端末が書体を決めるので、
        ほかの書体にはできません）。書き出す電子書籍そのものを、この画面で流した<b>一例</b>です。書体・余白・改ページの細部は
        読む端末ごとに違います。入稿前に、KDP なら Kindle Previewer、楽天Kobo なら Kobo のプレビューで
        1度は通して見てください
      </p>
    </div>
  );
}
