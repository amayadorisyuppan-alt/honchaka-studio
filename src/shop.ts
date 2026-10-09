// 外向きのリンク。あちこちから参照するので、書き換えるのはここだけ。

/**
 * 素材の販売先。
 *
 * **サブドメインは `amydr-publish`。** `amayadori.booth.pm` と書いていた時期があるが、
 * それはあまやどり出版のショップではない(取り違えると赤の他人の店へ客を送る)。
 */
export const BOOTH_SHOP_URL = 'https://amydr-publish.booth.pm/';

/**
 * 有料の画像パック(BOOTH)へのボタンの文字。**どの画面でもこの1つ。**(2026-09-23 ユーザー指摘
 * 「追加の挿絵を購入する、というのが(有料パックと)同じものに思えないので統一したい」)。
 * 面ごとに「追加の挿絵を…」「追加の背景画像を…」「追加の表紙画像を…」と言い分けていたが、
 * 売っているのは同じパックで、表紙にも背景にも挿絵にも使える。呼び方は「有料の画像パック」にそろえる
 */
export const SHOP_PACKS_LABEL = '有料の画像パックを見る（BOOTH）';

/**
 * 同梱プリセットの高解像度版(**無料**)。同じ絵を B5 まで使える大きさにしたもの。
 * 同梱ぶん(public/covers)は重さの都合で文庫までの大きさのまま配っている
 * (素材の仕分けで「同梱＝文庫まで / BOOTHの無料パック＝B5まで」と決めてある)。
 * **商品ページが公開されたら、その商品の URL に差し替える。** それまではショップの入口
 */
export const FREE_HIRES_PRESETS_URL = BOOTH_SHOP_URL;

/** あまやどり出版の公式サイト */
export const SITE_URL = 'https://www.hittyaka-maker.com/';

/**
 * スタジオ本体の公開URL。**index.html の og:url と同じ値**を持つ
 * (2つが食い違うと、シェアされたカードとコピーされたリンクが別の場所を指す)。
 * トップのシェア(Xの投稿・リンクのコピー)はここを配る。
 * **www 付きで持つ**(2026-10-10。公式サイトの公開 URL が www 付きで確定。www なしは .htaccess で転送する)
 */
export const APP_URL = 'https://www.hittyaka-maker.com/bookstudio/';

/**
 * 不具合報告・感想の受け口(Google フォーム)。2026-09-14 ユーザー作成。
 * 「お返事は基本しない」方針なので、返信を前提にしないフォームを受け口にする。
 * 空文字に戻すと、トップの案内はメール(CONTACT_EMAIL)に切り替わる
 */
export const FEEDBACK_FORM_URL: string = 'https://forms.gle/8nT2fH5yKvRVDeSp8';

/**
 * ソースコードの入手先。
 *
 * **AGPL 第13条の義務。** Vivliostyle(AGPL-3.0)を組み込んでいるのでこのアプリも AGPL で、
 * Web で提供するならソースの入手先を利用者に示さなければならない。
 * **公開する前にリポジトリを public にすること** — private のままだと
 * リンクを出しても入手できず、義務を果たしたことにならない。
 * (2026-10-10 に公開用のリポジトリへ移した。版ごとに入手先を変えるときは src/edition の sourceUrl)
 */
export const SOURCE_URL = 'https://github.com/amayadorisyuppan-alt/honchaka-studio';

/**
 * 投げ銭の受け口。**サービスがまだ決まっていないので空**(2026-08-22 時点)。
 *
 * 候補は OFUSE / Ko-fi / PayPal.me / Amazon ほしい物リスト。決まったらここに URL を
 * 1本入れるだけでよい。**空のあいだは「このアプリについて」の投げ銭の節ごと出さない** —
 * 「準備中」とだけ書いた行は、押せないのに目に入るぶん、無いより悪い。
 */
// 型を `string` と書いておく。`''` のままだと空文字リテラル型になり、
// URL を入れた側の分岐が「あり得ない」と見なされる
export const TIP_URL: string = 'https://ofuse.me/fd3bc7ac';

/**
 * 投げ銭のもう1つの受け口: **note の有料記事**(1本 300 円ほど。2026-09-27 ユーザー案)。
 * OFUSE を使わない人にも、ふだんの note の決済で応援してもらえるようにする。
 * **記事ができたら URL を入れる。空のあいだは出さない**(TIP_URL と同じ扱い)。
 * 画面には金額を書かない — 入口の投げ銭の行の方針「金額を言わない」(2026-09-02)を守る。
 * 値段は記事の側が示す
 */
export const NOTE_TIP_URL: string = '';

/**
 * AI タブの先頭に出す動画(YouTube)の URL。**動画がまだ無いので空**(2026-10-01)。
 * **空のあいだは何も出さない**(NOTE_TIP_URL と同じ扱い)。URL を1本入れれば出る。
 * watch?v=・youtu.be/・shorts/・embed/ のどの形でもよい(youtubeIdOf が ID を取り出す)。
 * 型を `string` と書く理由は TIP_URL と同じ(空文字リテラル型にしない)
 */
export const AI_VIDEO_URL: string = '';

/** 動画の長さ(分)。画面の「動画で見る（◯分）」に出す。0 なら分は書かない */
export const AI_VIDEO_MINUTES: number = 0;

/**
 * YouTube の URL から動画の ID(11文字)を取り出す。**形が合わなければ null。**
 * iframe の src に任意の文字列を入れないため、ID は 英数字と - _ の11文字かを必ず確かめる
 * (通らなければ何も描かない)。YouTube 以外のホストの URL も null
 */
export function youtubeIdOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
      id = m ? m[1] : null;
    }
  }
  return id !== null && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/**
 * 法人からの問い合わせ先。**空のあいだは「準備中」と出す。**
 *
 * こちらは節を消さない。有償で組み込めることを知らせるのが目的なので、
 * 宛先が未定でも「相談できる」という事実のほうを先に伝える必要がある
 * (投げ銭とは目的が違うので、空のときの振る舞いも変えてある)。
 */
export const CONTACT_EMAIL: string = 'amayadorisyuppan@gmail.com';

/** note の連載。「なぜ作ったか」の文中からリンクする */
export const NOTE_URL = 'https://note.com/amayadori_syupan';

/**
 * YouTube チャンネル(使い方動画の置き場)。
 * ハンドルが日本語なので percent-encode した形で持つ(@あまやどり出版)。
 * 2026-08-23 時点で動画はまだ無いが、リンクは先に張っておく(ユーザー指示)。
 */
export const YOUTUBE_URL =
  'https://www.youtube.com/@%E3%81%82%E3%81%BE%E3%82%84%E3%81%A9%E3%82%8A%E5%87%BA%E7%89%88';

/**
 * 販売中のマニュアル2冊。「なぜ作ったか」の文中からリンクする。
 * ユーザー提供の amzn.asia 短縮リンクは行き先の書名を確かめられなかったので、
 * 書名との対応を確認済みの ASIN 直リンクにしてある(2026-08-23。行き先は同じ商品ページ)。
 */
export const MANUALS = [
  {
    title: 'WordとCanvaで自分の本を出版しよう！［入門編］',
    url: 'https://www.amazon.co.jp/dp/B0FBT8KFPV',
  },
  {
    title: 'Canvaで自分の本を出版しよう',
    url: 'https://www.amazon.co.jp/dp/B0G5PZN5SZ',
  },
] as const;

/**
 * リンクを貼ってくれる人に渡すバナー。`public/banners/` の中身と対応する。
 * 画像は `node scripts/build-banners.mjs --adopt a` で作り直せる
 * (版下は scripts/banners-src.html。2026-09-04「愛嬌のあるバナーに」で
 * Pillow 直描きの build-banners.py からカエル入りの HTML 版下へ置き換えた。
 * OGP 1200×630 だけは今も build-banners.py 製)。
 */
export const BANNERS = [
  { file: 'banners/banner-200x40.png', w: 200, h: 40, label: '小（200×40）' },
  { file: 'banners/banner-468x60.png', w: 468, h: 60, label: '横長（468×60）' },
] as const;
