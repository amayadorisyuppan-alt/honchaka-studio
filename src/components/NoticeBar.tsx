// お知らせ欄の1行。入口(StartScreen の頭)と作業画面(トップバーの下)に置く。
// 中身は notice.json(src/notice.ts)。無ければ何も描かない(場所も取らない)。

import { useEffect, useState } from 'react';
import { dismissNotice, loadNotices, type Notice } from '../notice';

export function NoticeBar({ className = '' }: { className?: string }) {
  const [list, setList] = useState<Notice[]>([]);
  useEffect(() => {
    let alive = true;
    void loadNotices().then((n) => {
      if (alive) setList(n);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!list.length) return null;
  return (
    <div className={`notice-bar ${className}`.trim()} role="region" aria-label="お知らせ">
      {list.map((n) => (
        <p key={n.id} className={`notice-bar-item ${n.level}`}>
          <span className="notice-bar-label">お知らせ</span>
          <span className="notice-bar-text">
            {n.text}
            {n.link && (
              <>
                {' '}
                <a href={n.link} target="_blank" rel="noopener noreferrer">
                  {n.linkText ?? 'くわしく'}
                </a>
              </>
            )}
          </span>
          <button
            type="button"
            className="notice-bar-close"
            aria-label="このお知らせを閉じる"
            title="このお知らせを閉じる"
            onClick={() => {
              dismissNotice(n.id);
              setList((l) => l.filter((x) => x.id !== n.id));
            }}
          >
            ×
          </button>
        </p>
      ))}
    </div>
  );
}
