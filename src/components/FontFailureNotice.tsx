// 書体を読み込めなかったときの知らせと［書体を読み直す］。(2026-10-13 修正リスト 29)
//
// 数えるのは src/preview/fontFailures.ts。失敗が無ければ何も出さない(場所も取らない)。
// 下見の上(App の .preview)と、表紙の画面の上(CoverEditor の topSlot)と、
// 書き出しの「直すところ」の行(ボタンだけ)に出す

import { useState, type ReactNode } from 'react';
import { fontFailureText, retryFontFailures } from '../preview/fontFailures';
import { useFontFailures } from '../preview/useFontFailures';

/** ［書体を読み直す］。読み直してもだめだったら、そう言う */
export function FontRetryButton(): ReactNode {
  const s = useFontFailures();
  const [stillBad, setStillBad] = useState(false);
  if (s.count === 0) return null;
  return (
    <span className="font-fail-actions">
      <button
        type="button"
        className="font-fail-retry"
        disabled={s.retrying}
        onClick={() => {
          setStillBad(false);
          void retryFontFailures().then((ok) => setStillBad(!ok));
        }}
      >
        {s.retrying ? '読み直しています…' : '書体を読み直す'}
      </button>
      {stillBad && !s.retrying && <span className="font-fail-still">まだ読み込めませんでした。ネットの接続を確かめてから、もう一度［書体を読み直す］を押してください</span>}
    </span>
  );
}

/** 下見・表紙の上に出す帯。失敗が無ければ何も出さない */
export function FontFailureNotice({ className = '' }: { className?: string }): ReactNode {
  const s = useFontFailures();
  if (s.count === 0) return null;
  return (
    <div className={`font-fail ${className}`.trim()} role="alert">
      <span className="font-fail-text">{fontFailureText(s)}</span>
      <FontRetryButton />
    </div>
  );
}
