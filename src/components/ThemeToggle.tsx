// 画面の色の切り替え。
//
// **置き場所はトップバー。** 工程レールにも帯にも載せない。
// レールは「本を作る順番」、帯は「版面の道具」で、どちらも本に関わるもの。
// 画面を明るくするか暗くするかは本に関係がないので、
// ヘルプ・このアプリについてと同じ「アプリそのものの操作」の並びに置く。
//
// **入口画面にも出す。** トップバーは入口のメニューでは畳まれる(App.tsx の hidden)ので、
// そこにしか置かないと**アプリを開いていちばん最初の画面**で切り替えられない。
// 「まぶしい」と思うのはたいていその瞬間なので、両方に出す。
//
// **札にはいまの値を出す(帯のボタンと同じ作法)。** 3択をそのまま見せるほうが
// 「押すたびに何かが変わる」ボタンより読める。とくに既定の「OSに合わせる」は、
// 選択肢として見えていないと**そういう状態があること自体**が伝わらない。
import { useEffect, useRef, useState } from 'react';
import {
  applyTheme,
  readThemePref,
  resolveTheme,
  saveThemePref,
  watchSystemTheme,
  type ThemePref,
} from '../theme';

const LABELS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'OSに合わせる' },
  { value: 'light', label: '明るい' },
  { value: 'dark', label: '暗い' },
];

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  // OS の変化を拾うときに「いまの選択」が要る。state を直に読むと
  // 購読した時点の値で固まるので、ref 越しに最新を見る
  const prefRef = useRef(pref);
  prefRef.current = pref;

  useEffect(() => {
    // index.html の先頭で貼ってあるはずだが、そちらが動かない環境でも
    // ここで必ずそろえる(貼り直しても同じ値なので何も起きない)
    applyTheme(resolveTheme(prefRef.current));
    return watchSystemTheme(() => prefRef.current);
  }, []);

  return (
    <label className="theme-pick">
      <span>画面の色</span>
      <select
        value={pref}
        onChange={(e) => {
          const next = e.target.value as ThemePref;
          setPref(next);
          saveThemePref(next);
        }}
      >
        {LABELS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
