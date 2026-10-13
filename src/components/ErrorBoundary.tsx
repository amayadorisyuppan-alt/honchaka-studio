// 最後の防波堤。**描画のどこかで例外が飛んでも、画面を真っ白にしない。**
//
// React は子のレンダリング中に投げられた例外を捕まえないと、ツリーごと
// アンマウントして真っ白になる。このアプリは本のデータを IndexedDB に自動保存して
// いるので、白紙のまま操作を続けたり閉じたりされると、壊れた状態が上書き保存されて
// 「開き直しても白紙」に陥りうる(2026-09-04 レビュー指摘。壊れた JSON・AI が書いた
// 不正値・想定外の入力が引き金になりうる)。
//
// ここで捕まえて「データは消えていません。リロードしてください」と出し、
// **［保存する］を押せば、その場で .json に控えを取れる**ようにしておく。
// クラスコンポーネントなのは、error boundary が今もクラスAPIでしか書けないため。

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { safeFileStem, toProjectFile } from '../project/file';
import { downloadBlob } from '../exporters/download';
import { clearAutosave, readAutosave, useProject } from '../store/useProject';
import { backupThenReset } from './crashEscape';
import { APP_VERSION } from '../version';
import { EDITION } from '../edition';
import { ReportCopy } from './ReportCopy';
import { reportText } from './reportText';
import { reportExtraNow } from './envProbe';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 原因究明のために残す(利用者には出さない)
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  /** その場で .json 控えを取る。**保存自体が失敗しても黙らない。** */
  private save = () => {
    try {
      const s = useProject.getState();
      const text = toProjectFile(
        { settings: s.settings, cover: s.cover, manuscript: s.manuscript, source: s.source },
        true,
      );
      downloadBlob(new Blob([text], { type: 'application/json' }), `${safeFileStem(s.manuscript.title)}_復旧.json`);
    } catch (e) {
      alert('保存にも失敗しました。お手数ですが、この画面のまま開発元にお知らせください。\n' + String(e));
    }
  };

  /**
   * **再読み込みしても抜け出せない人の逃げ道。**(2026-10-13 修正リスト 25)
   * 控えを取ってから、ブラウザの中の作りかけを空にして、最初の画面に戻る。控えが取れなければ何も消さない。
   * 自動保存の名前は版ごとに違うが、読むのも空にするのも useProject の中で閉じている
   */
  private escape = () => {
    void backupThenReset({
      confirm: (m) => window.confirm(m),
      readSaved: readAutosave,
      current: () => {
        const s = useProject.getState();
        return { settings: s.settings, cover: s.cover, manuscript: s.manuscript, source: s.source };
      },
      download: (text, name) => downloadBlob(new Blob([text], { type: 'application/json' }), name),
      clearSaved: clearAutosave,
      reload: () => location.reload(),
      alert: (m) => alert(m),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-box" role="alert">
          <h1>画面の表示でエラーが起きました</h1>
          <p>
            <b>あなたの本のデータは消えていません。</b>
            この端末に自動保存されたものは残っています。まず下のボタンで<b>控えを手元に取ってから</b>、
            ページを再読み込みしてください。
          </p>
          <div className="crash-actions">
            <button className="primary-action" onClick={this.save}>
              いまの本を保存する（.json）
            </button>
            <button className="ghost" onClick={() => location.reload()}>
              ページを再読み込み
            </button>
          </div>
          {/* 再読み込みしても同じ画面になる人の逃げ道(2026-10-13 修正リスト 25)。上の2つと分けて、あとの手段として置く */}
          <p>
            再読み込みしてもこの画面になるときは、下の［控えを保存して最初の画面に戻る］で控えを保存してから、最初の画面に戻れます。
          </p>
          <div className="crash-actions">
            <button className="ghost" onClick={this.escape}>
              控えを保存して最初の画面に戻る
            </button>
          </div>
          {/* バージョンも添える。報告をもらったとき、どの版の話かが分かる(修正リストの 5。2026-10-12) */}
          <p className="crash-detail">
            {/* 外側が括弧なので、版の印は「・」でつなぐ(「（バージョン 1.1.0（○○版））」と二重にしない) */}
            {this.state.error.message}（バージョン {APP_VERSION}{EDITION.versionMark ? `・${EDITION.versionMark}` : ''}）
          </p>
          {/* 報告フォームに貼る文をコピーする(2026-10-12 修正リスト 5)。バージョン・ブラウザ・OS・エラーの文だけで、原稿や書名は入らない */}
          <ReportCopy
            getText={async () => {
              // エラーの文は待つ前に取っておく(待つあいだに state が変わっても、押した時点の文で作る)
              const errorMessage = this.state.error?.message ?? '';
              return reportText({
                version: APP_VERSION,
                mark: EDITION.versionMark,
                userAgent: navigator.userAgent,
                errorMessage,
                // OS の本当の版・画面・下見のページ数・対応環境の中か外か(2026-10-13 運用の見直し 12)。取れなければ省かれる
                extra: await reportExtraNow(),
              });
            }}
          />
        </div>
      </div>
    );
  }
}
