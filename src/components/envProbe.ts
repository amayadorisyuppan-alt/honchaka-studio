// ブラウザから、対応環境の判定と報告の文に使う値を集める。(2026-10-13 運用の見直し 12 / 対応環境)
//
// reportText.ts は純粋な関数だけにしてあるので、navigator・window・DOM に触る所はここに分けた。
// **集めるのは OS の版・画面の広さ・下見のページ数だけ。** 原稿・書名・ファイル名には触らない。
// どれも取れなければ黙って null(古いブラウザで落ちない。報告の文は取れたものだけで作る)。

import type { ReportExtra } from './reportText';

interface UADataLike {
  getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }>;
}

/**
 * Chrome・Edge の userAgentData から OS の版("15.0.0" など)を取る。
 * Safari・Firefox には userAgentData が無いので null。待ちすぎないよう timeoutMs で切る(失敗は黙る)
 */
export async function platformVersionNow(timeoutMs = 800): Promise<string | null> {
  try {
    const data = (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData);
    if (!data || typeof data.getHighEntropyValues !== 'function') return null;
    const got = data.getHighEntropyValues(['platformVersion']).then(
      (v) => (typeof v?.platformVersion === 'string' && v.platformVersion ? v.platformVersion : null),
      () => null,
    );
    const late = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    return await Promise.race([got, late]);
  } catch {
    return null;
  }
}

/** 下見のページ数。下見が出ていなければ null(数だけを数える。中身は読まない) */
function previewPagesNow(): number | null {
  try {
    const n = document.querySelectorAll('.preview-body [data-vivliostyle-page-container]').length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 報告の文の extra。押した時点の値を集める */
export async function reportExtraNow(): Promise<ReportExtra> {
  let screen: ReportExtra['screen'] = null;
  try {
    screen = { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio };
  } catch {
    screen = null;
  }
  return { platformVersion: await platformVersionNow(), screen, pages: previewPagesNow() };
}
