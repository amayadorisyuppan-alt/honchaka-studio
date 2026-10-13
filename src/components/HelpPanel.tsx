// ヘルプ。**このスタジオで何ができるかを、工程タブごとに並べる。**
//
// もとは「章に分かれないときの直し方」など、困りごとだけを集めた場所だった。
// 機能が増えるにつれて「どこで何ができるのか」が画面のどこにも書かれていない、
// という状態になったので、工程ごとの解説とQ&Aの2本立てに作り直した
// (2026-08-20 ユーザー判断)。
//
// **中身は src/help/content.ts に1つだけ持つ。** 画面と .md を別々に書くと、
// 必ず片方が古くなる(AI タブの頼み方の一覧で実際に起きた)。
//
// 配る .md は、行き詰まった人が**自分の AI に読ませて聞く**ことも想定している。
//
// **ここに書くのは、アプリの画面で確かめられることだけ。** 使いこなしや作例は
// 別売りのマニュアルの領分で、ここに盛ると画面もマニュアルも中途半端になる。

import { useEffect, useState } from 'react';
import {
  HELP_BAR,
  HELP_ENV,
  HELP_EPUB_DIFF,
  HELP_GLOSSARY,
  HELP_QA,
  HELP_REPAINT,
  HELP_SLOW,
  HELP_SOURCES,
  HELP_TABS,
  helpMarkdown,
} from '../help/content';
import { downloadBlob } from '../exporters/download';
import { FrogPeek } from './FrogMark';

interface Props {
  onClose: () => void;
}

export function HelpPanel({ onClose }: Props) {
  // Esc で閉じる。背景を押しても閉じる(AboutPanel と同じ)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 見るもの。**工程の解説と困りごとは、探し方が違う** */
  const [view, setView] = useState<'tabs' | 'qa'>('tabs');

  const download = () =>
    downloadBlob(
      new Blob([helpMarkdown()], { type: 'text/markdown;charset=utf-8' }),
      'ひっちゃか本づくりスタジオの使い方.md',
    );

  return (
    <div className="about-backdrop" onClick={onClose}>
      {/* 中身を押しても閉じない */}
      <div className="about help" role="dialog" aria-label="ヘルプ" onClick={(e) => e.stopPropagation()}>
        <button className="about-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>

        <h2>ヘルプ</h2>
        {/* 「何のソフトで、6つが何のための工程か」を先に(2026-09-04 ユーザー指摘
            「画面の上に6つの工程が並んでいます、より初見で伝わりやすく」) */}
        <p className="hint">
          ひっちゃか本づくりスタジオは、<b>本の入稿データ（紙のPDFと電子書籍のEPUB）を
          完成させるまでの6つの工程</b>を、画面の上に順番に並べています。
          左から順に片づけていくと本が1冊できます。
          いちばん下の<b>帯</b>は見た目の道具です。<b>開いている工程に合わせて中身が変わり</b>、
          本文の見た目は本文の工程で、表紙の見た目は［表紙をつくる］で直せます。
        </p>

        {/* **AI に読ませられる形で配る。** 行き詰まったとき、
            画面を探すより自分の AI に聞くほうが早い人がいる */}
        <button className="ghost help-dl" onClick={download}>
          この使い方をダウンロード（.md）
        </button>
        <p className="hint">
          自分の AI に読ませて、困っていることをそのまま聞くこともできます
        </p>

        <div className="subtabs help-tabs">
          <button className={view === 'tabs' ? 'on' : ''} onClick={() => setView('tabs')}>
            どこで何ができるか
          </button>
          <button className={view === 'qa' ? 'on' : ''} onClick={() => setView('qa')}>
            困ったとき（{HELP_QA.length}件）
          </button>
        </div>

        {view === 'tabs' && (
          <>
            {/* いちばん先に置く。「自分のパソコン・ブラウザで使えるか」は、使い方より前に知りたいこと
                (2026-10-13 運用の見直し 12。入口の1行からここへ来る) */}
            <section className="help-sec help-env">
              <h3>{HELP_ENV.title}</h3>
              <p>{HELP_ENV.lead}</p>
              {/* 対応・対象外の2段(2026-10-13 夜 ユーザー決定)→ 性能など → 版の調べ方 */}
              {HELP_ENV.tiers.map((t) => (
                <div key={t.head}>
                  <h4>{t.head}</h4>
                  <ul className="help-list">
                    {t.items.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <h4>{HELP_ENV.otherHead}</h4>
              <ul className="help-list">
                {HELP_ENV.items.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <h4>{HELP_ENV.howToHead}</h4>
              <ul className="help-list">
                {HELP_ENV.howTo.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </section>

            {/* 対応環境のすぐ下。取り込む前に読むもので、対応環境の「対象外」の行と最初の画面の③からここを指す
                (2026-10-13 ユーザー決定。Google ドキュメントは Word、Pages はテキスト。作者の手元で試した結果だと断る) */}
            <section className="help-sec help-sources">
              <h3>{HELP_SOURCES.title}</h3>
              <p>{HELP_SOURCES.lead}</p>
              {HELP_SOURCES.tools.map((t) => (
                <div key={t.head}>
                  <h4>{t.head}</h4>
                  <ul className="help-list">
                    {t.items.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <h4>{HELP_SOURCES.aiHead}</h4>
              <ol className="help-list">
                {HELP_SOURCES.aiSteps.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ol>
              <p className="help-sources-note">{HELP_SOURCES.note}</p>
            </section>

            {HELP_TABS.map((t) => (
              <section key={t.title} className="help-sec">
                <h3>{t.title}</h3>
                <p>{t.lead}</p>
                <ul className="help-list">
                  {t.can.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                {t.notes?.length ? (
                  <>
                    <p className="help-note-head">気をつけること</p>
                    <ul className="help-list help-notes">
                      {t.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </section>
            ))}

            {/* 工程の直後に置く。ここまでで出てきた専門語(小口・ノド・柱・版面…)を
                そのつど拾って辞書を作ると必ず漏れるので、画面に出ている語だけを
                まとめて一度に置く(2026-08-22 ユーザーの指示) */}
            <section className="help-sec help-glossary">
              <h3>用語集</h3>
              <ul className="help-list">
                {HELP_GLOSSARY.map((g) => (
                  <li key={g.term}>
                    <b>{g.term}</b>　{g.def}
                  </li>
                ))}
              </ul>
            </section>

            {/* 工程の直後・帯の前に置く。**6つ目の工程(完成データを書き出す)の続き**として
                読ませたいので、帯より先に来る位置がいちばん近い。
                書き出しタブにも同じ中身から短いぶんを出している(元は content.ts の1か所) */}
            <section className="help-sec help-epub-diff">
              <h3>{HELP_EPUB_DIFF.title}</h3>
              <p>{HELP_EPUB_DIFF.lead}</p>
              <p className="help-note-head">{HELP_EPUB_DIFF.alwaysHead}</p>
              <ul className="help-list help-notes">
                {HELP_EPUB_DIFF.always.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p className="help-note-head">{HELP_EPUB_DIFF.dependsHead}</p>
              <ul className="help-list help-notes">
                {HELP_EPUB_DIFF.depends.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p>{HELP_EPUB_DIFF.check}</p>
            </section>

            <section className="help-sec help-bar">
              <h3>{HELP_BAR.title}</h3>
              <p>{HELP_BAR.lead}</p>
              <ul className="help-list">
                {HELP_BAR.can.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="help-note-head">気をつけること</p>
              <ul className="help-list help-notes">
                {HELP_BAR.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>

            {/* 帯の直後。「帯を触るとどっちなのか」がここで分かるようにする */}
            <section className="help-sec help-repaint">
              <h3>{HELP_REPAINT.title}</h3>
              <p>{HELP_REPAINT.lead}</p>
              <p className="help-note-head">{HELP_REPAINT.noHead}</p>
              <ul className="help-list">
                {HELP_REPAINT.no.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p className="help-note-head">{HELP_REPAINT.yesHead}</p>
              <ul className="help-list help-notes">
                {HELP_REPAINT.yes.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p>{HELP_REPAINT.note}</p>
            </section>

            {/* いちばん最後。困りごとの一歩手前として、環境のせいで遅いことがあると
                先回りしておく(公開後の訪問者にも同じことが起きるため) */}
            <section className="help-sec help-slow">
              <h3>{HELP_SLOW.title}</h3>
              <p>{HELP_SLOW.lead}</p>
              <p>{HELP_SLOW.check}</p>
              <ul className="help-list">
                {HELP_SLOW.fix.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </section>
          </>
        )}

        {view === 'qa' && (
          <dl className="help-qa">
            {HELP_QA.map((x) => (
              <div key={x.q}>
                <dt>{x.q}</dt>
                <dd>{x.a}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* 末尾のかくれカエル(1画面1匹の決まりは FrogMark.tsx)。読み切った人だけが見つける */}
        <div className="frog-sit" aria-hidden="true">
          <FrogPeek width={44} />
        </div>
      </div>
    </div>
  );
}
