// 02 奥付。必ず要る2つ(著者・発行日)だけを出し、任意の欄は畳む。
//
// **全欄に data-defer-typeset を付けてある。**(2026-08-22)
// 奥付は1ページに閉じた紙面なのに、1文字打つたびに全体(297ページの本なら1回2分)を
// 組み直していた。この目印の付いた欄にカーソルがあるあいだ、App(useDeferHold)が
// 組版を待たせる。欄を離れた・工程を替えた・タブを離れたら1回だけ組む。
// 値そのものは打つたびに保存・取り消しの履歴へ入る(待たせるのは組版だけ)。

import { useState } from 'react';
import { outputsOf, type Manuscript, type ProjectSettings } from '../../models/project';
import { BackgroundPicker, bgSurfaceProps } from '../BackgroundPicker';
import { Fold } from '../Fold';
import { FrogPeek } from '../FrogMark';

interface Props {
  manuscript: Manuscript;
  patchManuscript: (patch: Partial<Manuscript>) => void;
  settings: ProjectSettings;
  setSettings: (patch: Partial<ProjectSettings>) => void;
}

export function ColophonStep({ manuscript, patchManuscript, settings, setSettings }: Props) {
  const foldChanged = Boolean(
    manuscript.publisher || manuscript.printer || manuscript.isbn || manuscript.colophonExtra,
  );
  /** 背景の一覧を開いているか。開いているあいだは一覧だけを描く(サイドバーを明け渡す) */
  const [bgOpen, setBgOpen] = useState(false);
  /**
   * 任意の欄の畳みの開け閉め。**ここで持つ。** 背景の一覧を開くと欄ごと外れるので、畳みに
   * 持たせたままだと戻ったときに閉じてしまう(ArtStep の perPageOpen と同じ。2026-09-23 レビューで発見)
   */
  const [foldOpen, setFoldOpen] = useState(false);
  /**
   * **奥付の背景もここで変えられる。**(2026-09-23 ユーザー要望「奥付の背景は奥付タブで
   * 変えられる方が親切。両方に入れておいてもいい」)。［本文に画像とコラムを入れる］の［背景］の
   * ものと同じ設定(settings.colophonBg)を、同じ作り(bgSurfaceProps)で触る。
   * 背景は紙の本だけのものなので、紙を作らない本には出さない(［背景］の面と同じ)
   */
  const paper = outputsOf(settings).paper;
  const bgPicker = paper ? (
    <BackgroundPicker
      label="奥付の背景"
      hint="奥付は書誌情報を載せるため、初期状態は無地です。画像の濃さと文字のフチは画面下の帯で設定します。この背景の画像は、［本文に画像とコラムを入れる］の［背景］からも変更できます。"
      allowPlain
      inheritFrom="本文"
      open={bgOpen}
      onOpenChange={setBgOpen}
      {...bgSurfaceProps(settings.colophonBg, (v) => setSettings({ colophonBg: v }))}
    />
  ) : null;
  if (bgOpen && bgPicker) return bgPicker;

  return (
    <>
      <p className="step-lede">
        本のいちばん最後に入るページです。<b>書いた欄だけが並びます。</b>
      </p>

      <label className="stack">
        著者紹介
        <textarea
          data-defer-typeset=""
          rows={4}
          value={manuscript.authorProfile ?? ''}
          placeholder="経歴や既刊など。空行で段落を分けてください"
          onChange={(e) => patchManuscript({ authorProfile: e.target.value })}
        />
      </label>
      {/* 著者紹介が紙面のどこに入るかを言っておく。
          **あとがきの案内はここに置かない。**(2026-10-09 ユーザー判断)著者紹介の欄の下にあると、
          あとがきもこの欄に関係があるように読めて紛らわしい(あとがきは原稿の章として書く) */}
      <p className="hint">
        著者紹介は、奥付と同じページの上のほうに、横書きで入ります（空なら入りません）。
        <b>奥付と合わせて1ページに収めます</b>ので、数行で書いてください。
      </p>

      {/* 書名・著者は入口画面でも入れるが、**作業中に直せる場所はここ。**
          どちらも奥付・大扉・表紙・電子書籍の書誌に効く(値は同じものを指す) */}
      <label className="stack">
        書名
        <input
          data-defer-typeset=""
          value={manuscript.title}
          placeholder="はじめての本"
          onChange={(e) => patchManuscript({ title: e.target.value })}
        />
      </label>
      <label className="stack">
        著者
        <input
          data-defer-typeset=""
          value={manuscript.author}
          placeholder="山田花子"
          onChange={(e) => patchManuscript({ author: e.target.value })}
        />
      </label>
      <label className="stack">
        発行日
        <input
          data-defer-typeset=""
          value={manuscript.published ?? ''}
          // **placeholder は常に今日。**(2026-09-02 ユーザー要望「たえず今日が出るように」)
          // 空のとき書き出しに入る日付と同じものを見せる。固定の例文だと
          // 「古い日付が入っている」ように読めてしまった
          placeholder={(() => {
            const t = new Date();
            return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`;
          })()}
          onChange={(e) => patchManuscript({ published: e.target.value })}
        />
      </label>
      <p className="hint">
        発行日を空にすると、奥付には<b>書き出した日</b>が入ります。©の行は著者名から自動で作ります
      </p>

      <Fold label="任意の欄（発行所・印刷・ISBN）" changed={foldChanged} open={foldOpen} onOpenChange={setFoldOpen}>
        <label className="stack">
          発行所
          <input
          data-defer-typeset=""
            value={manuscript.publisher}
            placeholder="あまやどり出版"
            onChange={(e) => patchManuscript({ publisher: e.target.value })}
          />
        </label>
        <label className="stack">
          印刷
          <input
          data-defer-typeset=""
            value={manuscript.printer ?? ''}
            placeholder="Amazon KDP"
            onChange={(e) => patchManuscript({ printer: e.target.value })}
          />
        </label>
        <label className="stack">
          ISBN
          <input
          data-defer-typeset=""
            value={manuscript.isbn ?? ''}
            placeholder="978-4-xxxx-xxxx-x"
            onChange={(e) => patchManuscript({ isbn: e.target.value })}
          />
        </label>
        <label className="stack">
          その他
          <textarea
          data-defer-typeset=""
            rows={2}
            value={manuscript.colophonExtra ?? ''}
            placeholder="1行1項目(版数など)"
            onChange={(e) => patchManuscript({ colophonExtra: e.target.value })}
          />
        </label>
      </Fold>

      {bgPicker}

      {/* 底のかくれカエル。奥付を書き終えるころには、すこし眠い */}
      <div className="frog-sit" aria-hidden="true">
        <FrogPeek width={40} mood="sleepy" />
      </div>
    </>
  );
}
