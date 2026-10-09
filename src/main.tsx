import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 積んでいる書体は src/fontsAll.ts にまとめてある。
// **検査(scripts/long-probe.ts)からも同じものを読ませるため**に切り出した。
// collectFontFaceCss は動いているページのスタイルシートから拾うので、
// 読み込む顔ぶれが違うと、検査は本番と違う本を測ることになる
import './fontsAll';
import './app.css';
import { App } from './components/App';
import { ErrorBoundary } from './components/ErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
