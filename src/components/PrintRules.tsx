// 「印刷所の決まり」の欄([本のかたちを決める])。(2026-10-01 ユーザーと決定)
//
// 出し先が「その他の印刷所」の本は、塗り足しとノドの下限を、印刷所の入稿ガイドの数字で決める。
// 画面の考え方は5つ:
//
//  1. **直すのは違うところだけ。** よくある数字を先に入れてある。何も触らなくても多くの印刷所に合う
//  2. **1か所にまとめる。** 背幅(印刷所の数字)と背の縁のアキも、ここ(ShapeStep)に集めた
//  3. **触ると場所が色づく。** 欄に触っているあいだ、右の下見でその場所(ノド・塗り足し)が色づく。
//     「ノド」「塗り足し」という語を知らなくても、場所で分かる。入稿ガイドでの別の呼び名も添える
//  4. **AI は数字を読むだけ。** 本まるごとの JSON は往復させない(src/project/printGuide.ts)
//  5. **その場で結果を言う。** 「この本は、ノドが 15mm 以上になるように組みます」(grid.ts の printRulesResult)
//
// ## 数の欄は、打っている途中を手元に持つ
//
// 設定に入れると本が組み直しになる(長い本で十数秒)。**打つたびに入れてはいけない。**
// 打っている途中の文字(空・「1」「15」の途中)は欄の中だけに持ち、
// **欄を離れたとき(か Enter)に、読める数になっていれば設定へ入れる。** 読めなければ元の値へ戻す。
// 空欄が 0 に化ける(Number('') は 0)ことも、これで起きない。
// 矢印・つまみで刻んだときだけは、その場で入れる(1回の操作が1つの値で、打っている途中が無い)。

import { useEffect, useRef, useState } from 'react';
import {
  PRINT_RULE_LIMITS,
  SPINE_INSET_LIMIT,
  DEFAULT_PRINT_RULES,
  bleedOf,
  normalizePrintRules,
  printRulesOf,
  usesOwnPrintRules,
  type PrintRules,
  type ProjectSettings,
} from '../models/project';
import { printRulesResult } from '../typeset/grid';
import {
  PRINT_GUIDE_PROMPT,
  applyPrintGuide,
  parsePrintGuide,
  reportGuide,
  type GuideReport,
} from '../project/printGuide';
import { copyFallback, copyText } from './copyText';

/** 下見で色づける場所。欄に触っているあいだだけ(null は色づけなし) */
export type PrintFocus = 'bleed' | 'gutter' | null;

const L = PRINT_RULE_LIMITS;
/** 「3」「3.2」のように、末尾の 0 を落として欄に出す */
const show = (v: number | null | undefined): string => (v === null || v === undefined ? '' : `${Number(v.toFixed(2))}`);

/**
 * 数の欄。**打っている途中は手元に持ち、欄を離れたとき(か Enter)に onCommit を呼ぶ。**
 * 範囲の外は範囲に収めて入れ、収めたことを onClamped で伝える
 */
export function DraftNum({
  value,
  min,
  max,
  step,
  integer = false,
  allowEmpty = false,
  zeroIsEmpty = false,
  placeholder,
  ariaLabel,
  onCommit,
  onFocusChange,
  onClamped,
}: {
  /** 設定に入っている値(空は null / undefined) */
  value: number | null | undefined;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  /** 空欄を値として受けるか(受けないなら、空のまま離れたら元の値へ戻す) */
  allowEmpty?: boolean;
  /** 0 を「空」として扱う(背幅: 0 は「入れていない」。allowEmpty と一緒に使う) */
  zeroIsEmpty?: boolean;
  placeholder?: string;
  ariaLabel: string;
  /** 読める数になった値(空欄を受けるときは null)。いまと同じ値のときは呼ばない */
  onCommit: (v: number | null) => void;
  onFocusChange?: (focused: boolean) => void;
  onClamped?: (message: string) => void;
}) {
  const shown = show(value);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  // 外から値が変わったとき(取り消し・AI の返事・［よくある数字を入れる］)は、触っていなければ追う
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);

  /** 文字を値として読む。読めなければ元の値へ戻す */
  const commit = (raw: string) => {
    const t = raw.trim();
    if (t === '') {
      if (allowEmpty) {
        setText('');
        if (value !== null && value !== undefined) onCommit(null);
      } else {
        setText(shown);
      }
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      setText(shown);
      return;
    }
    let v = Math.min(max, Math.max(min, n));
    if (integer) v = Math.round(v);
    v = Number(v.toFixed(2));
    if (allowEmpty && zeroIsEmpty && v === 0) {
      setText('');
      if (value !== null && value !== undefined) onCommit(null);
      return;
    }
    setText(show(v));
    // 設定へ入れてから知らせる(入れる側が通知を消すので、順番が逆だと範囲の通知が消える)
    if (v !== value) onCommit(v);
    if (v !== n) onClamped?.(`${ariaLabel}は ${min}〜${max} の範囲で入れられます。${show(v)} にしました`);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={() => {
        focused.current = true;
        onFocusChange?.(true);
      }}
      onBlur={() => {
        focused.current = false;
        commit(text);
        onFocusChange?.(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(text);
        }
      }}
      onChange={(e) => {
        setText(e.target.value);
        // 矢印・つまみで刻んだとき(InputEvent の inputType が無い)は、打っている途中ではないので、その場で入れる
        if (!(e.nativeEvent as InputEvent).inputType && e.target.value !== '') commit(e.target.value);
      }}
    />
  );
}

/** 「厚い本のノド」: ◯ページをこえたら ◯mm。**2つの欄をひと組として**、組を離れたときに入れる */
function ThickFields({
  pages,
  mm,
  onCommit,
  onFocusChange,
  onNote,
}: {
  pages: number | null;
  mm: number | null;
  onCommit: (pages: number | null, mm: number | null) => void;
  onFocusChange: (focused: boolean) => void;
  onNote: (message: string) => void;
}) {
  const [tp, setTp] = useState(show(pages));
  const [tm, setTm] = useState(show(mm));
  const inside = useRef(false);
  useEffect(() => {
    if (!inside.current) {
      setTp(show(pages));
      setTm(show(mm));
    }
  }, [pages, mm]);

  const reset = () => {
    setTp(show(pages));
    setTm(show(mm));
  };
  const commit = () => {
    const a = tp.trim();
    const b = tm.trim();
    if (a === '' && b === '') {
      if (pages !== null || mm !== null) onCommit(null, null);
      return;
    }
    const na = Number(a);
    const nb = Number(b);
    if (a === '' || b === '' || !Number.isFinite(na) || !Number.isFinite(nb)) {
      onNote('「厚い本のノド」は、ページ数と mm の両方に数字を入れるか、両方を空にしてください。元の数字に戻しました');
      reset();
      return;
    }
    const p = Math.round(Math.min(L.thickPages[1], Math.max(L.thickPages[0], na)));
    const g = Number(Math.min(L.thickGutterMm[1], Math.max(L.thickGutterMm[0], nb)).toFixed(2));
    setTp(show(p));
    setTm(show(g));
    if (p !== pages || g !== mm) onCommit(p, g);
    if (p !== na || g !== nb) {
      onNote(`厚い本のノドは、${L.thickPages[0]}〜${L.thickPages[1]}ページ・${L.thickGutterMm[0]}〜${L.thickGutterMm[1]}mm の範囲で入れられます。${p}ページ・${show(g)}mm にしました`);
    }
  };

  return (
    <span
      className="print-thick-row"
      onFocus={() => {
        inside.current = true;
        onFocusChange(true);
      }}
      onBlur={(e) => {
        // 組の中で欄が移るあいだは入れない。組の外へ出たときに入れる
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        inside.current = false;
        commit();
        onFocusChange(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    >
      <input
        type="number"
        min={L.thickPages[0]}
        max={L.thickPages[1]}
        step={10}
        value={tp}
        placeholder="—"
        aria-label="厚い本のノドが変わるページ数"
        onChange={(e) => setTp(e.target.value)}
      />
      <span>ページをこえたら</span>
      <input
        type="number"
        min={L.thickGutterMm[0]}
        max={L.thickGutterMm[1]}
        step={0.5}
        value={tm}
        placeholder="—"
        aria-label="厚い本のノド"
        onChange={(e) => setTm(e.target.value)}
      />
      <span>mm</span>
    </span>
  );
}

interface Props {
  settings: ProjectSettings;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  /** 紙の本文のページ数。組み上がっているときだけ数、まだなら null */
  paperPages: number | null;
  /** 右の下見がいま電子書籍か(色づけが見えない) */
  ebookView: boolean;
  /** 欄に触っているあいだ、下見のどこを色づけるか */
  onPrintFocus: (f: PrintFocus) => void;
  /** AI タブの［入稿の数字を調べる］から飛んできた合図。変わったら AI の箱を開く */
  openAiSeq?: number;
  /** 飛んできたのが「貼る場所を開く」からなら true。箱を開いたあと、貼る欄にカーソルを置く */
  focusPaste?: boolean;
}

/** いちど使った openAiSeq(欄が作り直されても覚えているように、関数の外に置く) */
let usedAiSeq = 0;

export function PrintRules({ settings, setSettings, paperPages, ebookView, onPrintFocus, openAiSeq, focusPaste }: Props) {
  const rules = printRulesOf(settings);
  const pages = paperPages ?? settings.estimatedPages;
  const result = printRulesResult(settings, pages, paperPages !== null);
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  // 結果は、**入れたあとの値**(key)といっしょに持つ。欄の値がそれと違ってきたら(Ctrl+Z で戻した・自分で直した)、
  // 結果は古くなったので出さない(2026-10-01 読み直しで発見: 取り消したのに「変わったところ…」が残り、
  // 欄は 3 なのに「5 になりました」と言っていた)
  const [reported, setReported] = useState<{ report: GuideReport; key: string } | null>(null);
  const valuesKey = JSON.stringify([rules, settings.spineInsetMm]);
  const report = reported && reported.key === valuesKey ? reported.report : null;
  const [copied, setCopied] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  /** 「貼る場所を開く」から来たとき、箱が開いたあとで貼る欄にカーソルを置く(開く前は欄が隠れていて置けない) */
  const wantPaste = useRef(false);
  useEffect(() => {
    // 同じ合図は1回だけ使う。この欄は工程を移るたびに作り直されるので、覚えておかないと、
    // ［本のかたちを決める］に戻るたびに箱が開いてカーソルが貼る欄へ行ってしまう
    if (!openAiSeq || openAiSeq === usedAiSeq) return;
    usedAiSeq = openAiSeq;
    setAiOpen(true);
    wantPaste.current = !!focusPaste;
  }, [openAiSeq, focusPaste]);
  useEffect(() => {
    if (!aiOpen || !wantPaste.current) return;
    wantPaste.current = false;
    // 画面を動かすのは App(箱の頭まで)。ここで動かすと、欄が画面の下端に来る位置で止まり、箱の頭が隠れる
    pasteRef.current?.focus({ preventScroll: true });
  }, [aiOpen, openAiSeq]);

  // 欄が消えるとき(工程を離れる・出し先を替える)は、色づけも消す。
  // **最新の関数を ref で持つ**: 依存に入れると、親が描き直すたびに後片づけが走って色づけが消える
  const focusRef = useRef(onPrintFocus);
  focusRef.current = onPrintFocus;
  useEffect(() => () => focusRef.current(null), []);
  const ownRules = usesOwnPrintRules(settings.printTarget);
  const hasFields = ownRules && rules !== null;
  useEffect(() => {
    if (!hasFields) focusRef.current(null);
  }, [hasFields]);

  /**
   * 下見の仕上がり線の説明。紙の下見を出していて、塗り足しがあるときだけ
   * (電子書籍の下見・塗り足し 0 の本には線が無い)。**余白の見方まで言う**: もとの困りごとは
   * 「小口とノドが同じ幅に見える」だった(2026-10-01)。線を消した人が戻せるよう、ボタンの場所も言う
   */
  const lineBleed = bleedOf(settings);
  const trimNote =
    ebookView || (lineBleed.top <= 0 && lineBleed.bottom <= 0 && lineBleed.fore <= 0 && lineBleed.gutter <= 0) ? null : (
      <p className="hint">
        右の下見の<b>点線</b>は<b>仕上がり線</b>（裁つ位置）です。外側は切り落とされるので、
        <b>余白は点線の内側</b>で見ます
        {lineBleed.gutter <= 0 && <>（綴じる側は裁たないので線がありません。紙の端が本の端です）</>}
        。下見の下の［仕上がり線］で表示・非表示を切り替えられます
      </p>
    );

  // ---- 決まりを利用者が入れない出し先(KDP・決まりが固定の会社): 欄は出さず、読み上げるだけ ----
  if (!ownRules) {
    return (
      <>
        <p className="readout print-rules-readout">{result.main}</p>
        {/* 会社が決めている出し先(rulesSource が fixed)は、この本ではどうなるかも添える */}
        {result.extra.map((t) => (
          <p className="hint" key={t}>
            {t}
          </p>
        ))}
        {trimNote}
      </>
    );
  }

  // ---- 出し先が印刷所で、決まりがまだ無い(古い保存) ----
  if (!rules) {
    return (
      <>
        <p className="readout print-rules-readout">{result.main}</p>
        <button className="ghost" onClick={() => setSettings({ printRules: { ...DEFAULT_PRINT_RULES } })}>
          よくある数字を入れる
        </button>
        <p className="hint">
          押すと、塗り足し 3mm（四辺）・ノド 15mm（200ページをこえたら 20mm）が入ります。
          <b>用紙の大きさとノドが変わって、本を組み直します</b>。あとで数字は直せます
        </p>
      </>
    );
  }

  /** 設定に入れる(ほかの項目は、いま効いている値のまま) */
  const write = (patch: Partial<PrintRules>) => {
    const next = normalizePrintRules({ ...rules, ...patch });
    // **厚い本のノドは、ノドの下限より小さくできない**(小さいほうは効かない。normalizePrintRules が切り上げる)。
    // 切り上げたことを、その場で言う
    let msg = '';
    if (patch.thickGutterMm != null && next.thickGutterMm !== null && next.thickGutterMm > patch.thickGutterMm) {
      msg = `厚い本のノド ${show(patch.thickGutterMm)}mm は、ノドの下限 ${show(next.gutterMinMm)}mm より小さいので、${show(next.thickGutterMm)}mm にしました（小さいほうは効きません）`;
    } else if (
      patch.gutterMinMm !== undefined &&
      rules.thickGutterMm !== null &&
      next.thickGutterMm !== null &&
      next.thickGutterMm > rules.thickGutterMm
    ) {
      msg = `厚い本のノドも、ノドの下限に合わせて ${show(next.thickGutterMm)}mm にしました（下限より小さくはできません）`;
    }
    setNote(msg);
    setSettings({ printRules: next });
  };
  const clamped = (m: string) => setNote((prev) => (prev ? `${prev} ${m}` : m));

  const copy = async () => {
    const ok = await copyText(PRINT_GUIDE_PROMPT);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      copyFallback(PRINT_GUIDE_PROMPT);
    }
  };

  /** 貼られた文を読んで、変わるところだけ設定に入れる(1回で。Ctrl+Z 1回で戻る) */
  const apply = () => {
    if (text.trim() === '') {
      setReported({
        report: {
          headline: '何も貼られていません。AI から返ってきた数行を貼ってから押してください',
          changed: [],
          same: [],
          unknown: [],
          skipped: [],
          skippedMore: 0,
          rejected: [],
          notes: [],
          basis: [],
          willChange: false,
        },
        key: valuesKey,
      });
      return;
    }
    const parsed = parsePrintGuide(text, {
      bleedMm: L.bleedMm,
      gutterMinMm: L.gutterMinMm,
      thickPages: L.thickPages,
      thickGutterMm: L.thickGutterMm,
      spineInsetMm: SPINE_INSET_LIMIT,
    });
    const applied = applyPrintGuide(
      {
        bleedMm: rules.bleedMm,
        bleedGutter: rules.bleedGutter,
        gutterMinMm: rules.gutterMinMm,
        thickPages: rules.thickPages,
        thickGutterMm: rules.thickGutterMm,
        spineInsetMm: settings.spineInsetMm,
      },
      parsed,
    );
    const r = reportGuide(parsed, applied);
    if (!r.willChange) {
      setReported({ report: r, key: valuesKey });
      return;
    }
    const n = applied.next;
    const patch: Partial<ProjectSettings> = {
      printRules: normalizePrintRules({
        bleedMm: n.bleedMm,
        bleedGutter: n.bleedGutter,
        gutterMinMm: n.gutterMinMm,
        thickPages: n.thickPages,
        thickGutterMm: n.thickGutterMm,
      }),
    };
    if (n.spineInsetMm !== settings.spineInsetMm) patch.spineInsetMm = n.spineInsetMm;
    // 入れたあとの値で鍵を作る(printRulesOf と同じ丸めを通した値。欄がこの値になったら結果を出し続ける)
    setReported({ report: r, key: JSON.stringify([patch.printRules, patch.spineInsetMm ?? settings.spineInsetMm]) });
    setNote('');
    setSettings(patch);
  };

  const focusProps = (kind: Exclude<PrintFocus, null>) => (f: boolean) => onPrintFocus(f ? kind : null);

  return (
    <>
      <p className="hint">よくある数字を先に入れてあります。入稿ガイドと<b>違うところだけ</b>直してください。</p>

      <div className="print-rules">
        <label>
          <span>
            塗り足し<i className="print-chip bleed" aria-hidden="true" />
          </span>
          <span className="num">
            <DraftNum
              value={rules.bleedMm}
              min={L.bleedMm[0]}
              max={L.bleedMm[1]}
              step={0.5}
              ariaLabel="塗り足し"
              onCommit={(v) => write({ bleedMm: v ?? rules.bleedMm })}
              onFocusChange={focusProps('bleed')}
              onClamped={clamped}
            />
            mm
          </span>
        </label>
        <p className="hint print-alias">入稿ガイドでは「ドブ」「裁ち落とし」とも</p>

        <label className="check">
          <input
            type="checkbox"
            checked={rules.bleedGutter}
            onChange={(e) => write({ bleedGutter: e.target.checked })}
            onFocus={() => onPrintFocus('bleed')}
            onBlur={() => onPrintFocus(null)}
          />
          綴じる側（ノド）にも塗り足しを付ける
        </label>

        <label>
          <span>
            ノドの下限<i className="print-chip gutter" aria-hidden="true" />
          </span>
          <span className="num">
            <DraftNum
              value={rules.gutterMinMm}
              min={L.gutterMinMm[0]}
              max={L.gutterMinMm[1]}
              step={0.5}
              ariaLabel="ノドの下限"
              onCommit={(v) => write({ gutterMinMm: v ?? rules.gutterMinMm })}
              onFocusChange={focusProps('gutter')}
              onClamped={clamped}
            />
            mm
          </span>
        </label>
        <p className="hint print-alias">綴じる側の余白。入稿ガイドでは「綴じしろ」とも</p>

        <div className="print-thick">
          <span className="print-thick-name">
            厚い本のノド<i className="print-chip gutter" aria-hidden="true" />
          </span>
          <ThickFields
            pages={rules.thickPages}
            mm={rules.thickGutterMm}
            onCommit={(p, g) => write({ thickPages: p, thickGutterMm: g })}
            onFocusChange={focusProps('gutter')}
            onNote={setNote}
          />
        </div>
        <p className="hint print-alias">決まりがなければ、両方を空のままにします</p>
      </div>

      {note && <p className="warn">{note}</p>}

      <p className="readout print-rules-readout">{result.main}</p>
      {result.extra.map((t, i) => (
        <p key={`${i}-${t}`} className="hint">
          {t}
        </p>
      ))}
      <p className="hint">
        {ebookView ? (
          <>
            右の下見を<b>［紙の本］</b>にすると、欄をさわっているあいだ、その場所が<b>色</b>で見えます
          </>
        ) : (
          <>欄をさわっているあいだ、右の下見で、その場所が<b>色</b>で見えます</>
        )}
      </p>
      {trimNote}

      {/* AI に数字を読んでもらう。**畳んでおく**: 入稿ガイドを見ながら自分で入れる人が多く、
          開いたままだと縦の長さをずっと占める。AI タブの案内から来たときは開く。
          **畳んだ1行に、中に何があるかを書く。**(2026-10-01 ユーザー指摘「このささやかなボタンの下にあったとは」。
          見出しだけの細い1行だったので、［欄に入れる］がこの中だと分からなかった) */}
      <details
        id="print-guide-box"
        className="chapter-bg print-guide"
        open={aiOpen}
        onToggle={(e) => setAiOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>
          入稿の数字を AI に調べてもらう
          <small>頼み方のコピーと、AI の返事を貼る欄は、この中です{aiOpen ? '' : '（押すと開きます）'}</small>
        </summary>
        <p className="hint">
          ① <b>［頼み方をコピー］</b> → ② 自分の AI に、印刷所の<b>入稿ガイド（PDF か URL）</b>と一緒に貼る →
          ③ 返ってきた数行を下に貼って<b>［欄に入れる］</b>
        </p>
        <button className="ghost" onClick={() => void copy()}>
          {copied ? 'コピーしました' : '頼み方をコピー'}
        </button>
        <label className="stack">
          AI が返してきた数行
          <textarea
            ref={pasteRef}
            rows={6}
            value={text}
            placeholder={'塗り足し: …\n綴じる側の塗り足し: …\nノドの下限: …'}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button className="primary-action" onClick={apply}>
          欄に入れる
        </button>
        {report && <GuideResult report={report} />}
        <p className="hint">
          AI は数字を読み違えることがあります。<b>入稿ガイドと見比べてください</b>
        </p>
      </details>
    </>
  );
}

/** 貼った返事を読んだ結果。変わったところ・同じだったところ・読めなかった行・根拠 */
function GuideResult({ report }: { report: GuideReport }) {
  return (
    <div className="print-guide-result" role="status" aria-live="polite">
      {report.headline && <p className="warn">{report.headline}</p>}
      {report.changed.length > 0 && (
        <p className="readout">
          <b>変わったところ</b>：{report.changed.join('、')}
        </p>
      )}
      {report.same.length > 0 && (
        <p className="hint">
          <b>変わらなかったところ</b>（いまと同じ数字）：{report.same.join('、')}
        </p>
      )}
      {report.unknown.length > 0 && (
        <p className="hint">
          <b>「不明」だったところ</b>（いまの数字のまま）：{report.unknown.join('、')}
        </p>
      )}
      {report.rejected.map((t, i) => (
        <p key={`${i}-${t}`} className="warn">
          {t}
        </p>
      ))}
      {report.skipped.length > 0 && (
        <div className="hint">
          <b>読めなかった行</b>（いまの数字のまま）：
          <ul>
            {report.skipped.map((t, i) => (
              <li key={`${i}-${t.line}`}>
                {t.line}
                {t.why && <span>　← {t.why}</span>}
              </li>
            ))}
            {report.skippedMore > 0 && <li>ほか {report.skippedMore} 件</li>}
          </ul>
        </div>
      )}
      {report.notes.map((t, i) => (
        <p key={`${i}-${t}`} className="hint">
          {t}
        </p>
      ))}
      {report.basis.length > 0 && (
        <p className="hint print-basis">
          <b>AI が書いた根拠</b>（返事のまま）：{report.basis.join(' ／ ')}
        </p>
      )}
    </div>
  );
}
