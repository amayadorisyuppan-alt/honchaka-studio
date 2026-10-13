// ［お使いの環境をコピー］のボタン(10/13 に［報告用の文をコピー］から改名。作り手が「意味が分からない」と言ったため。Gemini の案)。［このアプリについて］とエラーの画面が使う。(2026-10-12 修正リストの 5 / 運用の見直し 3)
//
// 押すと、不具合の報告フォームに貼る短い文(reportText.ts)をクリップボードに入れる。コピーするだけで、外へは何も送らない。
// 写すのは PrintRules・AiStep と同じ copyText。写せなかったら copyFallback で、文を選べる形で画面に出す。
// **エラーの画面は、アプリの他の部品が壊れていても動く必要がある**ので、ここは React と copyText(DOM だけ)にしか頼らない。

import { useState } from 'react';
import { copyFallback, copyText } from './copyText';

interface Props {
  /**
   * 押された時点で文を作る(エラーの文などは、押すまで決まらないことがある)。
   * Promise でもよい — OS の版(userAgentData)は非同期でしか取れないので、コピーの前に待つ(2026-10-13 運用の見直し 12。envProbe.ts が 0.8 秒で切る)
   */
  getText: () => string | Promise<string>;
  /** ボタンの class を足したいとき(エラーの画面は ghost) */
  className?: string;
}

export function ReportCopy({ getText, className }: Props) {
  const [done, setDone] = useState(false);

  const copy = async () => {
    let t = '';
    try {
      t = await getText();
    } catch {
      // 文を作れないほど壊れていても、ボタンが固まらないように
      t = 'バージョン・ブラウザの情報を取れませんでした';
    }
    if (await copyText(t)) setDone(true);
    else copyFallback(t);
  };

  return (
    <div className="report-copy">
      <button type="button" className={className ?? 'ghost'} onClick={copy}>
        お使いの環境をコピー
      </button>
      {done && (
        <span className="report-copy-note" role="status">
          コピーしました
        </span>
      )}
      <p className="report-copy-hint">不具合の報告やアンケートに貼り付けていただくための、お使いのパソコンやブラウザの情報です（原稿の内容は入りません）</p>
    </div>
  );
}
