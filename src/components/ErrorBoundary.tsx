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
import { useProject } from '../store/useProject';
import { APP_VERSION } from '../version';

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
          {/* バージョンも添える。報告をもらったとき、どの版の話かが分かる(修正リストの 5。2026-10-12) */}
          <p className="crash-detail">
            {this.state.error.message}（バージョン {APP_VERSION}）
          </p>
        </div>
      </div>
    );
  }
}
