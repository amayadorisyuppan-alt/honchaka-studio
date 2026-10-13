// 絵の細かさの知らせの部品。挿絵(PlateEditor)・表紙(CoverEditor)・背景(BackgroundPicker)で同じ形を出す。
//
// - ResolutionNote: 絵の行に出す1行(足りない絵にだけ)。**知らせるだけ**で、止めない
// - PresetHiresNote: 同梱のプリセットの絵に知らせが出たとき、BOOTH の無料の高解像度版へ案内する一言
//   (2026-10-12 修正リスト 21。同梱の絵は本ちゃかを重くしないため、わざと文庫までの大きさにしてある)
// - FolderHiresContext・FolderHiresBulk: 画像のフォルダに同梱のプリセットの高解像度版があるとき、PresetHiresNote の代わりに
//   ［高解像度版に差し替える］（絵の行）・［まとめて差し替える］（入稿前チェックの行）を出す。
//   フォルダが決まっていない・許可が切れている・高解像度版が無いときは、今までどおり PresetHiresNote（2026-10-12 改修の希望 2）
// - BgResolutionContext: 背景の画面へ「どの画像が足りないか」を渡す。BackgroundPicker は
//   ArtStep・ColophonStep・ColumnPageEditor から呼ばれるので、props を何段も通さず文脈で渡す(修正リスト 19)

import { createContext, useContext, useState, type ReactNode } from 'react';
import { resolutionNote, type ResolutionVerdict } from '../models/imageResolution';
import { FREE_HIRES_PRESETS_URL } from '../shop';

/**
 * 背景の画像ごとの判定(画像 src → 判定)と、出し先の呼び名。
 * 入稿前チェックと同じ collectResolution の結果から作る(App.tsx)ので、数字は食い違わない。
 * 提供されていない・空のときは何も出さない(公開版は背景を数えない)
 */
export interface BgResolution {
  verdicts: ReadonlyMap<string, ResolutionVerdict>;
  targetLabel: string;
}
export const BgResolutionContext = createContext<BgResolution | null>(null);

/**
 * 画像のフォルダにある、同梱のプリセットの高解像度版(ファイル名がプリセットの id と同じ画像。BOOTH の無料の高解像度版)。
 * 細かさの知らせが同梱のプリセットに出たとき、BOOTH への案内の代わりに［高解像度版に差し替える］を出すために、
 * App が文脈で渡す(useFolderHires)。提供されていない・フォルダが読めない・高解像度版が無いときは、今までどおり BOOTH の案内。
 * (2026-10-12 改修の希望 2 の続き)
 */
export interface FolderHires {
  /** フォルダに、この同梱のプリセットの高解像度版があるか */
  has(presetId: string): boolean;
  /** その原画を読んで、本に入れる形(取り込みと同じ最適化ずみの data URI)にする。maxSide は見開きの挿絵だけ広く取る */
  load(presetId: string, maxSide?: number): Promise<string>;
  /** 差し替えずみの絵か。差し替えてもまだ足りないとき、同じ案内を繰り返さない */
  isSwapped(src: string): boolean;
  markSwapped(src: string): void;
}
export const FolderHiresContext = createContext<FolderHires | null>(null);

/** 知らせの出た絵を、フォルダの高解像度版へ替えるための手がかり */
export interface HiresSwap {
  /** その絵の presetId。無い(古い本・自分の画像)ときは差し替えない */
  presetId: string | undefined;
  /** いま入っている絵 */
  src: string;
  /** 取り込みの長い辺の上限(見開きの挿絵は WRAP_MAX_SIDE) */
  maxSide?: number;
  /** 新しい絵を、呼び出し側の持ち場に書く(濃さ・fromPreset・presetId は残して src だけ替える) */
  apply: (src: string) => void;
}

/** 同梱のプリセットの絵に添える案内: フォルダに高解像度版がある('folder')/ 差し替えずみ('swapped')/ BOOTH へ案内('booth')/ 何も添えない('none') */
export function presetGuide(ctx: FolderHires | null, preset: boolean, swap: HiresSwap | undefined): 'folder' | 'swapped' | 'booth' | 'none' {
  if (!preset) return 'none';
  if (ctx && swap?.presetId) {
    if (ctx.isSwapped(swap.src)) return 'swapped';
    if (ctx.has(swap.presetId)) return 'folder';
  }
  return 'booth';
}

/** 「フォルダに高解像度版があります」の一言と［高解像度版に差し替える］(まとめて差し替える版は FolderHiresBulk) */
function FolderHiresOffer({ swap }: { swap: HiresSwap }): ReactNode {
  const ctx = useContext(FolderHiresContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!ctx || !swap.presetId) return null;
  const presetId = swap.presetId;
  async function run() {
    setBusy(true);
    setError('');
    try {
      const src = await ctx!.load(presetId, swap.maxSide);
      ctx!.markSwapped(src);
      if (src !== swap.src) swap.apply(src);
    } catch (e) {
      setError(readErrorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      フォルダに高解像度版があります。
      <button className="ghost hires-swap" disabled={busy} onClick={() => void run()}>
        {busy ? '差し替えています…' : '高解像度版に差し替える'}
      </button>
      {error && <span className="error"> {error}</span>}
    </>
  );
}

/** フォルダを読めなかったときの一言。取り込みの断り(Error)は利用者向けの文なのでそのまま、ブラウザの例外は言い換える */
export function readErrorText(e: unknown): string {
  if (e instanceof Error && !(e instanceof DOMException)) return e.message;
  return 'フォルダから読み込めませんでした。画像を選ぶ画面の［フォルダを開き直す］を押してから、もう一度お試しください';
}

/**
 * 入稿前チェックの行に添える、まとめて差し替える一言。
 * @param n フォルダに高解像度版がある枚数(1 以上)
 * @param rest 知らせが出ている同梱の絵のうち、フォルダに高解像度版が無い枚数(あれば BOOTH の案内も添える)
 */
export function FolderHiresBulk({
  n,
  rest,
  onSwap,
}: {
  n: number;
  rest: number;
  onSwap: () => Promise<void>;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    setBusy(true);
    setError('');
    try {
      await onSwap();
    } catch (e) {
      setError(readErrorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      フォルダに高解像度版がある画像が {n} 枚あります。
      <button className="ghost hires-swap" disabled={busy} onClick={() => void run()}>
        {busy ? '差し替えています…' : 'まとめて差し替える'}
      </button>
      {error && <span className="error"> {error}</span>}
      {rest > 0 && (
        <>
          {' '}
          ほかの {rest} 枚は、フォルダに高解像度版がありません。<PresetHiresNote />
        </>
      )}
    </>
  );
}

/** 同梱のプリセットの絵に細かさの知らせが出たときに添える一言。リンクは BOOTH の無料の高解像度版(文は Gemini Pro の案 → Flash の仕上げ。2026-10-12) */
export function PresetHiresNote(): ReactNode {
  return (
    <>
      アプリに入っている画像は文庫サイズまでの大きさです。
      <a href={FREE_HIRES_PRESETS_URL} target="_blank" rel="noopener noreferrer">
        BOOTH の無料の高解像度版
      </a>
      （B5 まで）をお使いください
    </>
  );
}

/**
 * 絵の細かさの知らせ(その絵の行に1行)。足りているとき(level = ok)は何も出さない。
 * 「かなり足りない」ときは、頭に太字を付けて強める。
 * @param preset 同梱のプリセットから選んだ絵か。そうなら高解像度版の案内を添える
 */
export function ResolutionNote({
  verdict,
  targetLabel,
  preset = false,
  swap,
}: {
  verdict: ResolutionVerdict | undefined;
  targetLabel: string;
  preset?: boolean;
  /** 渡すと、フォルダに高解像度版があるとき BOOTH の案内の代わりに［高解像度版に差し替える］を出す(2026-10-12 改修の希望 2) */
  swap?: HiresSwap;
}): ReactNode {
  const folder = useContext(FolderHiresContext);
  const text = verdict ? resolutionNote(verdict, targetLabel) : null;
  if (!verdict || !text) return null;
  const guide = presetGuide(folder, preset, swap);
  return (
    <p className="warn" role="status">
      {verdict.level === 'veryLow' && <b>細かさがかなり足りません。 </b>}
      {text}
      {guide === 'booth' && (
        <>
          。<PresetHiresNote />
        </>
      )}
      {guide === 'folder' && swap && (
        <>
          。<FolderHiresOffer swap={swap} />
        </>
      )}
    </p>
  );
}

/** 背景の画面の、1つの面の画像の所に出す知らせ。その画像(src)が足りないときだけ。同梱のプリセットなら案内つき */
export function BackgroundResolutionNote({
  src,
  preset,
  presetId,
  maxSide,
  apply,
}: {
  src: string | undefined;
  preset: boolean;
  /** この面の絵の presetId と、新しい絵を書く処理(渡すと、フォルダの高解像度版へ差し替えられる) */
  presetId?: string;
  maxSide?: number;
  apply?: (src: string) => void;
}): ReactNode {
  const ctx = useContext(BgResolutionContext);
  if (!ctx || !src) return null;
  const swap: HiresSwap | undefined = apply ? { presetId, src, maxSide, apply } : undefined;
  return <ResolutionNote verdict={ctx.verdicts.get(src)} targetLabel={ctx.targetLabel} preset={preset} swap={swap} />;
}
