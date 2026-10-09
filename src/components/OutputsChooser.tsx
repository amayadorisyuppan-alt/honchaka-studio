// 作るもの(紙の本・電子書籍)と、それぞれの出し先を選ぶ欄。
//
// 2026-09-23 ユーザー要望:「今は KDP かそれ以外かがわかりにくい。自分に該当するものだけしか
// 出てこない、入稿の最初で選択ができて、それ以降は関連するものしか出ない、としてほしい。
// 紙と電子を最初に選んでもらうのもありで、自分が今必要としているものだけしか見えない」。
//
// **同じ欄を3か所に置く**: 新規作成の手順・［本のかたちを決める］の先頭・［完成データを書き出す］の先頭。
// 新規作成だけに置くと、［続けて作る］やサンプルから入った人は選ぶ場所が無い。
//
// **紙と電子は別々に聞く。** 両方作る人が多く、「紙は KDP・電子は Kobo」のような組み合わせもある。
// 1つの二択では言い表せない。
//
// **選ぶのは画面の出し分けだけ。** 作らない側の設定は消さない(models/project.ts の outputsOf)。
//
// 出し先の選択肢は PRINT_TARGETS / EPUB_TARGETS をそのまま並べる。印刷会社が増えたら
// 表に1件足すだけで、ここにも選択肢が1つ増える(ボタンを手で書き足さない)。

import {
  EPUB_TARGETS,
  PRINT_TARGETS,
  outputsOf,
  type EpubTarget,
  type PrintTarget,
  type ProjectSettings,
} from '../models/project';

interface Props {
  settings: Pick<ProjectSettings, 'makePaper' | 'makeEbook' | 'printTarget' | 'epubTarget'>;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  /** 出し先ごとの一言を出すか。狭い場所(新規作成の手順)では省く */
  showHints?: boolean;
  /**
   * 「関係する欄だけが出ます」の断りを出すか。**［本のかたちを決める］では出さない**
   * (2026-09-23 ユーザー指摘「細かい説明はいらない。本文をつくるときに必要な情報だけに」)
   */
  showNote?: boolean;
}

export function OutputsChooser({ settings, setSettings, showHints = true, showNote = true }: Props) {
  const out = outputsOf(settings);
  const printIds = Object.keys(PRINT_TARGETS) as PrintTarget[];
  const epubIds = Object.keys(EPUB_TARGETS) as EpubTarget[];

  return (
    <div className="outputs">
      <div className="outputs-row">
        <span className="outputs-name">紙の本</span>
        <div className="seg outputs-seg">
          {printIds.map((id) => (
            <button
              key={id}
              className={out.paper && settings.printTarget === id ? 'active' : ''}
              onClick={() => setSettings({ makePaper: true, printTarget: id })}
            >
              {PRINT_TARGETS[id].label}
            </button>
          ))}
          {/* **両方「作らない」にはさせない。** 片方がすでに作らないなら、もう片方の
              ［作らない］は押せない(何も作らない本は成り立たない) */}
          <button
            className={!out.paper ? 'active' : ''}
            disabled={!out.ebook}
            onClick={() => setSettings({ makePaper: false })}
          >
            作らない
          </button>
        </div>
      </div>
      <div className="outputs-row">
        <span className="outputs-name">電子書籍</span>
        <div className="seg outputs-seg">
          {epubIds.map((id) => (
            <button
              key={id}
              className={out.ebook && settings.epubTarget === id ? 'active' : ''}
              onClick={() => setSettings({ makeEbook: true, epubTarget: id })}
            >
              {EPUB_TARGETS[id].label}
            </button>
          ))}
          <button
            className={!out.ebook ? 'active' : ''}
            disabled={!out.paper}
            onClick={() => setSettings({ makeEbook: false })}
          >
            作らない
          </button>
        </div>
      </div>
      {showHints && (
        <ul className="outputs-hints">
          {out.paper && <li>{PRINT_TARGETS[settings.printTarget].hint}</li>}
          {out.ebook && <li>{EPUB_TARGETS[settings.epubTarget].hint}</li>}
        </ul>
      )}
      {showNote && (
        <p className="hint outputs-note">
          選んだものに関係する欄だけが出ます。あとからいつでも変えられます（作らないほうの設定も消えません）
        </p>
      )}
    </div>
  );
}
