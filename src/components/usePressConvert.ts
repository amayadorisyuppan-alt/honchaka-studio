// 保存した本文 PDF(RGB)を、入稿用(白黒は K1色・カラーは CMYK。PDF/X-4)に変える流れ。PressConvert.tsx から切り出した(2026-10-03。挙動は変えていない)。
// 画面は PressConvert(PDF を落とす・選ぶ囲み)。この流れは、ほかの入り口(あとで足すフォルダの自動など)からも使えるように、画面から離してある。
//
// 紙の大きさが違う PDF の扱い・画面から外れたときの取り消しの考え方は、PressConvert.tsx の冒頭に書いてある(そのまま生きている)。
import { useEffect, useRef, useState } from 'react';
import { downloadBlob } from '../exporters/download';
import type { InkColor } from '../models/project';
import { safeFileStem } from '../project/file';
import { convertPress, type PressErrorOrigin, type PressKind, type PressProgress, type PressResult } from '../press/press';
import type { BodyBoxes } from '../press/types';
import { completeOf, originOf, paperMismatchOf, paperMismatchText } from './pressText';

export interface PressConvertOptions {
  bookTitle: string;
  /** 刷り色。白黒は K1色、カラーは CMYK に変える */
  ink: InkColor;
  /** いまの本の紙の本文のページ数。組み上がっていなければ null(照らし合わせを省く) */
  expectedPages: number | null;
  /** いまの本の用紙(仕上がり＋塗り足し)の寸法 mm。別の本の PDF を選んでいないかを見る */
  paperMm: { w: number; h: number };
  /** 本文の箱(仕上がり・塗り足し・1ページ目のノドの側)。PDF/X の TrimBox を決める */
  boxes: BodyBoxes;
  /** インクの総量の上限(%)。カラーの本文だけ使う */
  inkLimit: number;
  /** グレーの濃さの直しをするか(bodyOutputOf の grayTone)。省くと直す */
  grayTone?: boolean;
}

export type PressConvertState =
  | { kind: 'idle' }
  | { kind: 'running'; progress: PressProgress }
  | { kind: 'done'; result: PressResult; name: string; warnings: string[] }
  | { kind: 'refused'; message: string }
  | { kind: 'error'; message: string; origin: PressErrorOrigin | undefined; complete: boolean };

/** Chrome の印刷は用紙を最大 0.4mm ほど大きく出す(2026-09-27 実測)。それより粗く見る */
const SIZE_TOLERANCE_MM = 1.5;

/**
 * 変換が終わったあとの、紙の大きさの守り(違えば、案内の文。違わなければ null)。
 * ふつうは、変換の前に pipeline が断る(PressFailure.paperMismatch)ので、ここには来ない。
 * 変換の結果の paperMismatch(値)で決める。値が入っていない(undefined)結果のときだけ、1ページ目の寸法で見る。
 * 違反の文(TrimBox がありません、など)は、利用者に見せない
 */
function paperRefusal(result: PressResult, paperMm: { w: number; h: number }): string | null {
  const pm = result.pdfx.paperMismatch;
  if (pm) return paperMismatchText(pm, 'after');
  if (pm === null) return null;
  const m = result.pageMm;
  if (m && (Math.abs(m.w - paperMm.w) > SIZE_TOLERANCE_MM || Math.abs(m.h - paperMm.h) > SIZE_TOLERANCE_MM)) {
    return paperMismatchText({ pages: [1], actualMm: m, expectedMm: paperMm }, 'after');
  }
  return null;
}

export function usePressConvert({ bookTitle, ink, expectedPages, paperMm, boxes, inkLimit, grayTone = true }: PressConvertOptions) {
  const [state, setState] = useState<PressConvertState>({ kind: 'idle' });
  // 動いている変換の取り消し口。画面から外れるときに止める
  const ctlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      ctlRef.current?.abort();
    },
    [],
  );
  const running = state.kind === 'running';
  const color = ink === 'color';
  const kind: PressKind = color ? 'body-cmyk' : 'body-gray';
  const stem = safeFileStem(bookTitle, '本');
  const fileName = `${stem}_本文_${color ? 'CMYK' : 'K1色'}.pdf`;

  async function run(file: File) {
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setState({ kind: 'running', progress: { phase: 'load' } });
    try {
      const input = await file.arrayBuffer();
      if (ctl.signal.aborted) return;
      const result = await convertPress(
        { kind, pdf: input, boxes, title: bookTitle, inkLimit, grayTone },
        (progress) => {
          if (!ctl.signal.aborted) setState({ kind: 'running', progress });
        },
        ctl.signal,
      );
      if (ctl.signal.aborted) return;

      // 変換のあとの守り: 紙の大きさが違うなら、保存させずに案内する(ふつうは変換の前に断られるので、ここには来ない)
      const refusal = paperRefusal(result, paperMm);
      if (refusal) {
        setState({ kind: 'refused', message: refusal });
        return;
      }

      const warnings: string[] = [];
      if (expectedPages !== null && result.pages !== expectedPages) {
        warnings.push(
          `選んだ PDF は ${result.pages} ページで、いまの本（${expectedPages} ページ）と違います。別の PDF を選んでいないか確かめてください`,
        );
      }
      downloadBlob(new Blob([result.pdf as BlobPart], { type: 'application/pdf' }), fileName);
      setState({ kind: 'done', result, name: fileName, warnings });
    } catch (e) {
      // 外れたあと(取り消し)は、何も言わない。ほかの失敗は、原因に合う助言を付けて言う
      if (ctl.signal.aborted) return;
      // 紙の大きさが違う PDF は、変換せずに止めてある。失敗ではなく、書き出し直しの案内として言う
      const pm = paperMismatchOf(e);
      if (pm) {
        setState({ kind: 'refused', message: paperMismatchText(pm, 'before') });
        return;
      }
      setState({ kind: 'error', message: String((e as Error)?.message ?? e), origin: originOf(e), complete: completeOf(e) });
    } finally {
      if (ctlRef.current === ctl) ctlRef.current = null;
    }
  }

  return { state, running, kind, fileName, color, run };
}
