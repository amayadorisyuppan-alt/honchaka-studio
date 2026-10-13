// 書体の失敗の帳面(./fontFailures.ts)を React から見る口。(2026-10-13 修正リスト 29)
// 帳面そのものは React を読まない(単体の検査を node で回すため。scripts/fontFailures.test.ts)

import { useSyncExternalStore } from 'react';
import {
  EMPTY_FONT_FAILURES,
  fontFailureSnapshot,
  subscribeFontFailures,
  type FontFailureSnap,
} from './fontFailures';

/** 読めなかった書体・読み直している最中か */
export function useFontFailures(): FontFailureSnap {
  return useSyncExternalStore(subscribeFontFailures, fontFailureSnapshot, () => EMPTY_FONT_FAILURES);
}

/** 読み直して読めた回数だけを見る。下見の組み直し・表紙の描き直しに使う(失敗が増えただけでは描き直さない) */
export function useFontRetryEpoch(): number {
  return useSyncExternalStore(
    subscribeFontFailures,
    () => fontFailureSnapshot().epoch,
    () => 0,
  );
}
