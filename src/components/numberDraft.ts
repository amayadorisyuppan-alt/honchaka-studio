// 数の欄に打った文字を、設定に入れる数へ直す(純粋な関数。画面を持たない)。(2026-10-13 修正リスト 24)
//
// 下の帯の「サイズ」「行送り」や表紙の「大きさ」の欄は、以前は `Number(e.target.value)` をそのまま入れていた。
// 空にすると 0(本文のサイズ 0pt → ページが真っ白、行送りは ×Infinity)、9999・-5・1e308 もそのまま保存された。
// min/max は矢印のボタンにしか効かず、打った数は通る。**数字を打ち直そうとして一度全部消すのは、ふつうの操作。**
// 方針は PrintRules.tsx の DraftNum のとおり — 打っているあいだは欄の中だけに持ち、
// 欄を離れたとき(か Enter)に、ここで範囲へ丸めて設定へ入れる。

/** 打った文字の読み。empty=空 / invalid=数として読めない / ok=設定に入れる数(value)と、打った数そのまま(typed) */
export type DraftRead =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'ok'; value: number; typed: number; clamped: boolean };

/**
 * 欄の文字を、範囲(min〜max)に収めた数へ読む。
 * - 空・空白だけ → empty(呼ぶ側が「元の値へ戻す」か「空を値にする」かを決める)
 * - 'abc'・'Infinity'・'1e999' のように有限の数にならない文字 → invalid(元の値へ戻す)
 * - 範囲の外 → 範囲の端へ(clamped=true)。小数は 2 桁に丸め、integer なら整数に丸める
 */
export function readDraft(raw: string, min: number, max: number, integer = false): DraftRead {
  const t = raw.trim();
  if (t === '') return { kind: 'empty' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { kind: 'invalid' };
  let v = Math.min(max, Math.max(min, n));
  if (integer) v = Math.round(v);
  v = Number(v.toFixed(2));
  // 丸めたあとでも範囲の中にいること(min が 0.333 のような端の数でも、はみ出さない)
  v = Math.min(max, Math.max(min, v));
  return { kind: 'ok', value: v, typed: n, clamped: v !== n };
}

/** 数を欄に出す文字。「3」「3.2」のように、末尾の 0 を落とす */
export const showDraft = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '' : `${Number(v.toFixed(2))}`;

/** 範囲に収めたときに出す短い知らせ(PrintRules と同じ形)。unit は「pt」「mm」「倍」など */
export function clampNoteText(label: string, min: number, max: number, value: number, unit = ''): string {
  return `${label}は ${showDraft(min)}〜${showDraft(max)}${unit} の範囲で入れられます。${showDraft(value)}${unit} にしました`;
}
