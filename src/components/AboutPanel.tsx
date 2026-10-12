// このアプリについて。制作者のクレジットと、ライセンスまわりの表示。
//
// **AGPL 第13条の義務を果たす場所でもある。** Vivliostyle(AGPL-3.0)を組み込んでいるので
// このアプリ自体も AGPL で、Web で提供する以上「ソースの入手先を利用者に示す」必要がある。
// 隠し場所にせず、トップバーから常に開けるようにしてある。
//
// 画面には手順だけを置く方針なので、こうした「読まなくても本は作れる」話は
// ここへ集めて、工程レールの邪魔をしない。

import { useEffect } from 'react';
import {
  BANNERS,
  BOOTH_SHOP_URL,
  CONTACT_EMAIL,
  MANUALS,
  NOTE_TIP_URL,
  NOTE_URL,
  SITE_URL,
  SOURCE_URL,
  TIP_URL,
} from '../shop';
import { EDITION } from '../edition';
import { APP_VERSION } from '../version';
import { FrogPeek } from './FrogMark';
import { ReportCopy } from './ReportCopy';
import { reportText, versionLabel } from './reportText';

/** この版のソースの入手先。版が自分の入手先を持てばそちら(AGPL: 使っている版そのもののソースを示す) */
const sourceUrl = EDITION.sourceUrl ?? SOURCE_URL;

/** 名指しで開ける節。入口画面の一行リンクから使う */
export type AboutSection = 'why' | 'support' | 'business';

interface Props {
  onClose: () => void;
  /**
   * 開いた直後にここまで送る節。トップの［法人の方へ］のように、
   * 下のほうにある1節だけが目当てで開かれることがある。
   * **バナーの img には width/height を書いてある** — 書かないと
   * 画像が届いた瞬間に下の節がずれて、送った先が別の場所になる
   */
  section?: AboutSection | null;
}

export function AboutPanel({ onClose, section }: Props) {
  // Esc で閉じる。背景を押しても閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!section) return;
    document.getElementById(`about-${section}`)?.scrollIntoView({ block: 'start' });
  }, [section]);

  const link = (href: string, text: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );

  return (
    <div className="about-backdrop" onClick={onClose}>
      {/* 中身を押しても閉じない */}
      <div
        className="about"
        role="dialog"
        aria-label="このアプリについて"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="about-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>

        <h2>本ちゃか — ひっちゃか本づくりスタジオ</h2>
        {/* 縦書きは強みだが、専用ではない。横書きの本も作れる */}
        <p className="about-lede">
          日本語の本を、<b>縦書きでも横書きでも</b>、電子書籍と紙で同時に作るための道具です。
          原稿も画像も<b>あなたのパソコンから外に出ません</b>（すべてブラウザの中で組んでいます）。
        </p>

        <dl className="about-list">
          <div>
            <dt>作っている人</dt>
            <dd>{link(SITE_URL, 'あまやどり出版')}</dd>
          </div>
          {/* 不具合の報告で、どの版の話かを分かるようにする(修正リストの 5。2026-10-12)。
              「版」は版面・版下と紛れるので「バージョン」と書く。公開版は GitHub の同じ名前のタグと対応する */}
          <div>
            <dt>バージョン</dt>
            {/* 番号のあとに版の印(印を持つ版だけ)。報告に貼る文のコピーも置く(2026-10-12 修正リスト 5)。
                文にはバージョン・ブラウザ・OS だけが入り、原稿や書名は入らない */}
            <dd>
              {versionLabel(APP_VERSION, EDITION.versionMark)}
              <ReportCopy
                getText={() =>
                  reportText({
                    version: APP_VERSION,
                    mark: EDITION.versionMark,
                    userAgent: navigator.userAgent,
                  })
                }
              />
            </dd>
          </div>
          <div>
            <dt>ソースコード</dt>
            <dd>{link(sourceUrl, sourceUrl.replace(/^https:\/\//, '').replace(/^\.\//, ''))}</dd>
          </div>
          <div>
            <dt>ライセンス</dt>
            <dd>
              {link('https://www.gnu.org/licenses/agpl-3.0.html', 'GNU Affero General Public License v3.0')}
            </dd>
          </div>
          {/* 素材の販売(BOOTH)はここから「応援のしかた」へ移した。
              同じリンクを1枚のダイアログに2回出すと、どちらが本物か探させることになる */}
          {/* 同梱物の著作権表示。MIT / ISC / BSD / OFL はいずれも
              「配るときは著作権表示を付ける」ことが条件なので、置き場所が要る。
              ビルドすると minify で消えるため、テキストで別に持たせている */}
          <div>
            <dt>著作権表示</dt>
            <dd>
              {link('licenses/THIRD-PARTY-NOTICES.txt', '同梱している書体とライブラリの一覧')}
            </dd>
          </div>
        </dl>

        {/* **一人称のまま置く。**(2026-08-22 深夜 ユーザーの自己紹介原文をもとに整えた)
            ここだけは手順でも仕様でもなく、作った人の話。読まなくても本は作れるので
            画面には出さず、この中に置いている */}
        <h3 id="about-why">なぜ作ったか</h3>
        {/* **行の折り返しは「、」「。」の直後だけにする。** JSX は文中の改行を
            半角スペース1つに変えるので、語の途中で折ると和文の真ん中に空きが出る
            (「紙の本も電子書籍も␣自分の手で」と出て、実機で見つけた) */}
        <p>
          KDP が日本で始まったころに、自分で本をつくりはじめました。
          紙の本も電子書籍も自分の手で形にできるのが楽しくて、
          気がつけば数十点の本を出していました。
        </p>
        {/* 書名リンクは shop.ts の MANUALS。**式の前後では改行してよい**
            (JSX は式に隣り合う改行を丸ごと捨てるので、空きは出ない) */}
        <p>
          そのうちにたくさんの友達から「自分も作りたいけれど、やり方がわからない」と言われるようになりました。
          一人ひとりに説明し続けるのが大変で、
          {link(NOTE_URL, 'note に連載していた記事')}をもとに、
          Word と Canva で KDP から出版するやり方をマニュアル2冊にまとめ、
          KDP 経由でお分けすることにしました。
          {link(MANUALS[0].url, `『${MANUALS[0].title}』`)}と
          {link(MANUALS[1].url, `『${MANUALS[1].title}』`)}の2冊です。
          いまでは知らない方にもずいぶん買っていただけていて、とてもありがたく思っています。
        </p>
        <p>
          それでも、原稿さえ渡せばあとは自動で紙と電子のデータができあがったら、
          どれだけらくちんだろう、という思いは消えませんでした。
          オンデマンド出版の各社にも自動で組む仕組みはそれなりにありましたが、
          どこも「うちで出版してください」が前提で、
          せっかく作ったデータをユーザーが自分の好きなようには使えません。
          一度作ったものは、そのまま使いまわしたいじゃないですか。
          そうしようとすると Word や一太郎、Canva で版下を自作するしかなく、
          それが本の可能性を著しく低くしている気がしていました。
        </p>
        <p>
          AI が進化したぞという話を聞きつけるたびに組版の自動化に挑戦しては、
          どうしてもできない日々が続きました。
          けれど今年、Claude に Fable 5 が登場したことで話が変わりました。
          コーディングを AI がやってくれるようになり、
          自分が欲しいサービスを自分の手で形にできるようになったのです。
        </p>
        <p>
          このスタジオは、本をつくりたいあなたに<b>無料</b>で使ってもらえるサービスです。
          本を出したい方には、中身をつくることに全精力を傾けてほしいから。
          そしてその最大の壁が、いまは「組版」でした。
          どんどん使って、この世にまだない本をどんどん生み出してもらえたら、
          こんなに幸せなことはありません。
        </p>
        <p>
          ひとつ心細いのは、こんな便利なものを作ってしまったら、
          私が売っているマニュアルは当然売れなくなるだろうなあ、ということです（笑）。
        </p>

        {/* **お願いは「なぜ作ったか」のすぐ後ろ。** 話を読んだ直後がいちばん届く。
            投げ銭はサービスが決まるまで節ごと出さない(src/shop.ts の TIP_URL) */}
        <h3 id="about-support">応援のしかた</h3>
        <p>
          <b>リンクは大歓迎です。</b>よかったら、このバナーをお使いください。
        </p>
        <ul className="about-banners">
          {BANNERS.map((b) => (
            <li key={b.file}>
              {/* width/height を書いておく。書かないと画像が届いた瞬間に
                  下の節がずれ、［法人の方へ］で開いた人が別の場所に着く */}
              <img
                src={b.file}
                width={b.w}
                height={b.h}
                alt={`本ちゃか（ひっちゃか本づくりスタジオ） ${b.label}`}
              />
              <a href={b.file} download>
                {b.label} を保存
              </a>
            </li>
          ))}
        </ul>
        {(TIP_URL || NOTE_TIP_URL) && (
          <p>
            {/* 個人開発であることを正直に言う(2026-10-06 ユーザー要望「あくまでも個人開発だから。そういうことを伝えておくのもあり」)。
                引き換えにしないことも言葉にする。文面は Gemini 3.1 Pro の案(2026-10-07。StartScreen.tsx の FROG_LINES のコメント参照) */}
            このスタジオは、個人がひとりで開発・運営しています。
            <b>OFUSE（投げ銭）</b>による応援は、そのままサイトの維持費や次の機能を作る力になります。
            （応援がなくても、すべての機能を変わらずご利用いただけます）
            {TIP_URL && link(TIP_URL, TIP_URL.replace(/^https?:\/\//, ''))}
            {/* note の応援記事は URL が入ってから並べる(src/shop.ts の NOTE_TIP_URL)。金額は書かない */}
            {NOTE_TIP_URL && (
              <>
                {TIP_URL && '　'}
                note の応援記事（{link(NOTE_TIP_URL, 'note')}）からも応援できます。
              </>
            )}
          </p>
        )}
        {BOOTH_SHOP_URL && (
          <p>
            表紙・背景の<b>追加パックを販売しています</b>（
            {link(BOOTH_SHOP_URL, 'BOOTH')}
            ）。買っていただけたら、それがいちばんの支えになります。
          </p>
        )}

        {/* 入口の一行リンクからここへ直接来る。**AGPL の話より先に「相談できる」を言う** —
            義務の説明が先に来ると、読み終わる前に閉じられる */}
        <h3 id="about-business">法人の方へ</h3>
        <p>
          <b>自社サービスへの組み込みや、そのための改修は有償でお引き受けします。</b>
          このアプリは AGPL-3.0 で公開しているので、そのまま組み込むと
          <b>そちら側のソースも公開する義務</b>が生じます。公開せずにお使いになりたい場合は、
          <b>別途の有償ライセンス（デュアルライセンス）</b>でご相談ください。
        </p>
        <p>
          ご連絡先：
          {CONTACT_EMAIL ? (
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          ) : (
            <b>準備中です</b>
          )}
        </p>

        <h3>組版エンジン</h3>
        <p>
          {link('https://vivliostyle.org/', 'Vivliostyle')}（CSS組版・AGPL-3.0）を使っています。
          そのため<b>このアプリ自体も AGPL-3.0</b> です。
          改造したものを配ったり、Web に置いたりする場合は、
          <b>同じくソースを公開してください</b>。個人で使うぶんには何の制約もありません。
        </p>
        {/* 入稿用の変換(白黒の本文は K1色・カラーの本文と表紙は CMYK。どれも PDF/X-4)に使う。
            これも AGPL なので入手先を示す(第13条・第6条d)。2026-10-01 に白黒だけから3種類に広げた */}
        <p>
          入稿用のデータへの変換（白黒の本文は K1色、カラーの本文と表紙は CMYK。どれも PDF/X-4）には、
          {link('https://www.ghostscript.com/', 'Ghostscript')}
          （Artifex Software・AGPL-3.0）をブラウザで動くようにした
          {link('https://github.com/okathira-dev/ghostpdl-wasm/tree/v1.1.0', 'ghostpdl-wasm 1.1.0')}
          を使っています。
        </p>
        {/* 色の基準(ICC プロファイル)。許諾は「そのまま使う・埋め込む・配るのは自由、改変と販売は X-Rite の許可が要る」。
            改変せずに同梱していること、できた PDF に埋め込まれること(PDF/X の決まり)を言う。原文は THIRD-PARTY-NOTICES.txt */}
        <p>
          色の基準には、{link('https://registry.color.org/profile-registry/', 'Japan Color 2011 Coated')}
          の ICC プロファイル（提供: 一般社団法人 日本印刷産業機械工業会・著作権: X-Rite, Incorporated）を
          <b>改変せずに</b>同梱しています。入稿用の PDF には、PDF/X の決まりにしたがってこのプロファイルが
          埋め込まれます。許諾の原文は{link('licenses/THIRD-PARTY-NOTICES.txt', '同梱ソフトウェアの表示')}にあります。
        </p>
        {/* 絵の中の文字の検査(2026-10-02)。**絵を外へ送らない**ことを、道具の名前といっしょに言う
            (文字を「読む」と聞くと、どこかへ送っているのではと心配になる)。どちらも帰属の表示で足りる許諾(MIT・Apache-2.0) */}
        <p>
          画像の中の文字が版面の外に出ていないかの確かめには、
          {link('https://onnxruntime.ai/', 'ONNX Runtime Web')}（MIT）と、
          {link('https://github.com/PaddlePaddle/PaddleOCR', 'PaddleOCR')} の文字検出モデル（Apache-2.0。改変せずに同梱）を使っています。
          <b>この PC の中だけで動き、画像を外へ送ることはありません</b>。調べるのは文字の場所だけで、文字は読みません。
        </p>

        <h3>書体</h3>
        {/* 「OFL か Apache 2.0」と書いていたが、2026-08-17 に全15書体を実物で確認したところ
            **すべて OFL 1.1** だった(Apache のものは1つも入っていない)。
            断言する以上、確かめた事実だけを書く */}
        <p>
          同梱している書体は<b>すべて SIL Open Font License 1.1</b> です。
          <b>PDF に埋め込んで出版できます</b>。
        </p>
        <p>
          源暎こぶり明朝は、源ノ明朝を縦組み・長文向けに改変した本文専用書体です
          （おたもん／{link('https://okoneya.jp/font/', '御琥祢屋')}、
          {link('fonts/GenEiKoburiMin-OFL.txt', 'ライセンス全文')}）。
        </p>

        {/* 同梱の画像は利用者がそのまま本の表紙にして売る。
            「使っていいのか」「クレジットは要るのか」は必ず聞かれるので、
            聞かれる前に書いておく。KDP の申告は未申告だと規約違反になるため必須。
            **枚数は書かない**(2026-09-27 ユーザー判断)。足すたびにずれる(45枚と書いたまま101点になっていた) */}
        <h3>表紙・背景の画像</h3>
        <p>
          同梱の画像は<b>生成AI（Higgsfield）で作っています</b>。
          <b>本の表紙や中身に使って販売できます。クレジットは要りません。</b>
          画像そのものを素材として配ったり売ったりすることだけはご遠慮ください。
        </p>
        <p>
          <b>KDP に出すときは「AI 生成コンテンツ」の質問に「はい」と答えてください。</b>
          申告は Amazon 社内で使われるもので、商品ページには出ません。
          未申告のまま出版すると規約違反になります。
        </p>
        {/* 同梱物なので誰でも同じ絵を使える。あとから知ると裏切られた感じになる */}
        <p>
          同梱の画像は誰でも使えるので、<b>同じ画像の本が出ることがあります</b>。
          一点ものにしたいときは、ご自分の画像を選んでください。
        </p>

        <p className="about-foot">
          このアプリは無保証です。出版の前に、書き出したファイルをご自分で確かめてください。
        </p>

        {/* 末尾のかくれカエル(1画面1匹の決まりは FrogMark.tsx) */}
        <div className="frog-sit" aria-hidden="true">
          <FrogPeek width={44} />
        </div>
      </div>
    </div>
  );
}
