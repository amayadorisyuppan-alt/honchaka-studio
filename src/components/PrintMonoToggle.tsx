// 画像ごとの「白黒で刷る」のチェックと、白黒に見える絵・ごく淡い色の絵の知らせ。(2026-10-12 1.1.0。修正リストの 4-6)
//
// カラーの紙の本だけに出す(白黒の本は絵がすべて白黒・電子書籍は元の絵のまま)。挿絵の一覧(PlateEditor)と背景の面(ArtStep)で使う。
// **知らせは事実だけ。** 白黒にしたほうがよいとは言わない(わざと色を残す人もいる。10/10 ユーザー決定)。
// 文は Gemini を通した(メモ japanese-copy-gemini-review)。直すときもそうする
import type { ReactNode } from 'react';
import type { BgSpec } from '../models/project';

/** 画面の文。直すときは Gemini を通す */
export const PRINT_MONO_TEXT = {
  label: '紙の本では白黒で刷る',
  on: '紙の本では黒インクだけで印刷されます（電子書籍はカラーのままです）。',
  gray: '白黒に見えますが、色の情報を持っています。このまま印刷するとカラーインクが使われるため、カラーページとして扱われます。',
  pale: 'ごく淡い色がついています。このまま印刷するとカラーインクが使われるため、カラーページとして扱われます。',
  inherit: '白黒で刷るかどうかは、「本文全体」の欄で設定します。',
  issue: (n: number) => `白黒に見える画像や淡い色の画像が ${n} 枚あります。このまま印刷するとカラーページとして扱われます。`,
};

export type ColorLook = 'gray' | 'pale';

/**
 * 背景の面(大扉・目次・奥付・章・コラム)の BackgroundPicker に渡す extra と mono。
 * 自前の絵を持つ面はチェックを出す。本文全体の絵を継いでいる面は、本文全体の欄で選ぶことを言う(無地の面は何も出さない)
 */
export function bgMonoProps(
  spec: BgSpec | undefined,
  write: (next: BgSpec | undefined) => void,
  o: { printColor: boolean; look?: ColorLook | null; bodyHasImage: boolean; bodyMono: boolean },
): { extra?: ReactNode; mono?: boolean } {
  if (!o.printColor) return {};
  if (spec?.src) {
    return {
      mono: !!spec.printMono,
      extra: (
        <PrintMonoToggle
          checked={!!spec.printMono}
          onChange={(v) => {
            const next: BgSpec = { ...spec };
            if (v) next.printMono = true;
            else delete next.printMono;
            write(next);
          }}
          look={o.look}
        />
      ),
    };
  }
  if (spec?.base !== 'plain' && o.bodyHasImage) return { mono: o.bodyMono, extra: <p className="hint">{PRINT_MONO_TEXT.inherit}</p> };
  return {};
}

interface Props {
  checked: boolean;
  onChange: (mono: boolean) => void;
  /** 測った色のずれから見た、この絵の見え方(白黒に見える・ごく淡い色)。どちらでもなければ渡さない */
  look?: ColorLook | null;
}

export function PrintMonoToggle({ checked, onChange, look }: Props) {
  return (
    <div className="print-mono">
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {PRINT_MONO_TEXT.label}
      </label>
      {checked ? (
        <p className="hint">{PRINT_MONO_TEXT.on}</p>
      ) : look ? (
        <p className="warn" role="status">
          {look === 'gray' ? PRINT_MONO_TEXT.gray : PRINT_MONO_TEXT.pale}
        </p>
      ) : null}
    </div>
  );
}
