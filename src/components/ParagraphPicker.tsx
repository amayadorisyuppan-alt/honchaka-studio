// 章の途中に絵を入れる場所を選ぶ画面。**開いているあいだサイドバーを丸ごと使う**
// (画像パックの一覧 PresetScreen と同じ扱い)。
//
// 2026-09-23 まで、章の途中に絵を入れるには Word に書き出して貼り、取り込み直すしかなかった。
// 組版は最初から段落のあいだの絵を組めたので、足りなかったのは「どの段落のあとか」を
// 画面で選ぶ手段だけ。段落は冒頭の字で並べ、字で探せるようにする。
//
// プレビューの段落を直に押して選ぶ形も考えたが、段落がページをまたいで割れたときに
// 目印が両方に残るか・拡大縮小のつまみ操作と押す操作をどう分けるか、を確かめていないので
// 今回は採らない(一覧なら組版の都合に左右されない)。

import { useMemo, useState } from 'react';
import type { Chapter } from '../models/project';
import { blockSnippet, plainText } from '../models/inlineImages';

interface Props {
  chapters: Chapter[];
  /** 最初に開いておく章 */
  initialChapter?: number;
  /**
   * 動かしている絵。**一覧から外し、その直前の段落に「いまの場所」と印を付ける。**
   * 新しく入れるときは渡さない
   */
  moving?: { chapter: number; block: number };
  /** 選ばれた。after は章の中の番号で、-1 なら章のはじめ */
  onPick: (chapter: number, after: number) => void;
  onBack: () => void;
}

function chapterName(ch: Chapter, i: number): string {
  return [ch.no, plainText(ch.title)].filter(Boolean).join('　') || `${i + 1}つめの章`;
}

export function ParagraphPicker({ chapters, initialChapter = 0, moving, onPick, onBack }: Props) {
  const [chapter, setChapter] = useState(
    Math.min(Math.max(0, initialChapter), Math.max(0, chapters.length - 1)),
  );
  const [query, setQuery] = useState('');
  const q = query.replace(/[\s　]/g, '');

  /**
   * 並べる行。**字で探しているときは本全体から拾う。** どの章にあるかを覚えていなくても、
   * 覚えている一節から辿れるように(章の一覧は字を入れないときの道)
   */
  const rows = useMemo(() => {
    const out: { chapter: number; after: number; label: string; here: boolean }[] = [];
    const scan = (ci: number) => {
      const ch = chapters[ci];
      if (!ch) return;
      ch.blocks.forEach((b, bi) => {
        if (moving && moving.chapter === ci && moving.block === bi) return;
        let label = blockSnippet(b);
        if (!label) return;
        if (q) {
          const text = plainText(b.type === 'list' ? b.items.join('') : 'text' in b ? b.text : '');
          if (!text.replace(/[\s　]/g, '').includes(q)) return;
          // **探した字のまわりを見せる。** 書き出しだけだと、長い段落のどこで当たったのか
          // 見えず、同じ語が何度も出る本では選べない(2026-09-23 実測)
          const at = text.indexOf(query.trim());
          if (at > 12) label = `…${text.slice(at - 12, at + query.trim().length + 20)}…`;
        }
        const here = !!moving && moving.chapter === ci && lastBefore(ch, moving.block) === bi;
        out.push({ chapter: ci, after: bi, label, here });
      });
    };
    if (q) chapters.forEach((_, ci) => scan(ci));
    else scan(chapter);
    return out;
  }, [chapters, chapter, q, moving]);

  const atStartHere =
    !!moving && moving.chapter === chapter && lastBefore(chapters[chapter], moving.block) === -1;

  return (
    <div className="para-picker">
      <button className="ghost para-back" onClick={onBack}>
        ← 戻る
      </button>
      <h3>画像を入れる場所を選ぶ</h3>
      <p className="hint">
        押した段落の<b>あと</b>に入ります
      </p>

      <label className="stack">
        章
        <select value={chapter} disabled={!!q} onChange={(e) => setChapter(Number(e.target.value))}>
          {chapters.map((ch, i) => (
            <option key={i} value={i}>
              {chapterName(ch, i)}
            </option>
          ))}
        </select>
      </label>
      <input
        className="para-search"
        type="search"
        value={query}
        placeholder="本文の字で探す（本全体から）"
        onChange={(e) => setQuery(e.target.value)}
      />

      <ul className="para-list">
        {!q && (
          <li>
            <button className={atStartHere ? 'here' : ''} onClick={() => onPick(chapter, -1)}>
              <span className="para-text">章のはじめ（見出しのすぐあと）</span>
              {atStartHere && <span className="para-here">いまの場所</span>}
            </button>
          </li>
        )}
        {rows.map((r) => (
          <li key={`${r.chapter}:${r.after}`}>
            <button className={r.here ? 'here' : ''} onClick={() => onPick(r.chapter, r.after)}>
              {q && <span className="para-ch">{chapterName(chapters[r.chapter], r.chapter)}</span>}
              <span className="para-text">{r.label}</span>
              {r.here && <span className="para-here">いまの場所</span>}
            </button>
          </li>
        ))}
        {q && rows.length === 0 && <li className="hint">見つかりません</li>}
      </ul>
    </div>
  );
}

/**
 * その絵の直前にある、一覧に出る段落の番号。無ければ -1(章のはじめ)。
 * 一覧に出ないもの(空行)は飛ばす — 「いまの場所」の印をその行に付けるため
 */
function lastBefore(ch: Chapter | undefined, block: number): number {
  if (!ch) return -1;
  for (let i = block - 1; i >= 0; i--) if (blockSnippet(ch.blocks[i])) return i;
  return -1;
}
