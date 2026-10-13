// AI に手直ししてもらう。**このアプリに AI は入っていない。**
//
// このタブが言いたいことは1つ:
// **「スタジオだけでは届かない『もっとこうしたい』は、あなたの原稿と、
//   あなたが使っているチャットAI で叶う。そのやり方を教えます」**
// (2026-08-19 ユーザーの言い直し。それまでの書き方は「誰が」が抜けていて、
//  スタジオができるのか AI ができるのかが読み取れなかった)。
//
// だから文には**必ず主語を書く**。
//   - このスタジオ … 本全体の見た目(判型・書体・余白・色)を決める
//   - あなたの原稿 … 記号で書いておくと、スタジオが太字・ルビ・見出しとして組む
//   - あなたの AI  … その記号を原稿に書き入れたり、文章そのものを直したりする
//
// **プレビューは出さない全画面。** 渡して受け取るだけの場所なので、
// 誌面が横にあると「ここで本文を書き換えるのか」と読める。
//
// **書ける記法は、組版が持っているものだけを書く。** ここに嘘を書くと、
// 利用者はできないことを頼み、返ってきた結果が消えて理由が分からなくなる。
// 対応表の出どころは typeset/text.ts(convertEmphasis / convertAozoraRuby)と
// importers/*.ts(# と ## の扱い)、models/project.ts の Block。

import { useEffect, useState, type ReactNode } from 'react';
import { paragraphHtml } from '../../typeset/text';
import { SCENE_BREAKS, sceneBreakOf, type SceneBreakId } from '../../models/project';
import { useProject } from '../../store/useProject';
import {
  AI_VIDEO_MINUTES,
  AI_VIDEO_URL,
  BOOTH_SHOP_URL,
  SHOP_PACKS_LABEL,
  youtubeIdOf,
} from '../../shop';
import { downloadBlob } from '../../exporters/download';
import { FrogPeek } from '../FrogMark';
import { copyFallback, copyText } from '../copyText';
import { PRINT_GUIDE_PROMPT } from '../../project/printGuide';
import { TEXT_MARKS_PROMPT } from '../../help/content';

interface Props {
  /** 画像を落とした軽い JSON を書き出す(実体は ProjectBar が1つだけ持つ) */
  onExportForAi: () => void;
  /** 直した JSON を読み込む(実体は ProjectBar) */
  onLoadProject: () => void;
  /**
   * 原稿ファイルを選ばせる(実体は App の隠し input)。Word の飾りを記号に直してもらった
   * 原稿を、ここから取り込めるようにする(本文だけが入れ替わる。挿絵・設定は残る)
   */
  onPickManuscript: () => void;
  /** ［本文に画像とコラムを入れる］の［挿絵］を開く。絵を入れたい人の行き先 */
  onGoToPlates: () => void;
  /**
   * ［本のかたちを決める］の「印刷所の決まり」を開く。'head' は見出しまで、'paste' は AI の返事を貼る箱まで画面を動かす。
   * **設定は変えない**(出し先が KDP・紙を作らない本のときも、案内するだけ)
   */
  onGoToShape: (to?: 'head' | 'paste') => void;
  /**
   * 「印刷所の決まり」の欄がいまの本で使えるか。ok = 紙を作り、出し先が印刷所 /
   * kdp = 出し先が、決まりをスタジオが持っている会社(Amazon KDP など)で、要らない /
   * no-paper = 紙の本を作らない(紙にしか効かない)
   * ok 以外のときは、［入稿の数字を調べる］のカードを出さない(2026-10-03)
   */
  printRulesState: 'ok' | 'kdp' | 'no-paper';
  /**
   * 手持ちの画像の細かさを AI に確かめてもらう頼み方(この本で要る画素数入り。App が作る)。
   * 紙の本を作らないときは渡さない(電子書籍の絵は軽くして入れるので、細かさの話にならない)
   */
  imageCheckPrompt?: string;
}

/**
 * AI に投げる頼みごとの例。**そのままコピーして使える文にする。**
 * 「〜してください」の形にしておかないと、利用者が自分で書き起こす手間が残る
 */
const PROMPTS: [string, string][] = [
  [
    '原稿の飾りを記号に書き換える',
    '添付した「原稿の書き方.md」のルールに合わせて、文字を修飾した箇所をすべて記号に書き換えてください。文章そのものは1文字も変えないでください。',
  ],
  // 見出し・ルビの読み取りは Word だけの特別対応。ほかの道具の人はテキストで持ってきて、記号は AI に書き足してもらう
  // (2026-10-13 夜 ユーザー決定。記号は下の NOTATION と同じものだけを挙げる)
  // Google ドキュメントの人は Word(.docx)でダウンロードしてもらうので、ここには入れない(2026-10-13 ユーザー決定: それだけをすすめる)
  // **名前と中身を、テキストの原稿に記号を書き足す頼み方にした**(2026-10-13 ユーザーの実機の試し: Pages には Markdown の書き出しが無く、
  // Pages の人もテキストで持ってくる。Google ドキュメント・メモ帳のテキストも同じ)。書き換えさせず**足させる**(文は1字も変えない)。
  // 名前は help/content.ts の TEXT_MARKS_PROMPT(ヘルプの手順と同じ名前にする)
  [
    TEXT_MARKS_PROMPT,
    '添付したテキストの原稿に、添付した「原稿の書き方.md」のルールに合わせて、Markdown の記号を書き足してください。章の見出しの行には行のあたまに「# 」、小見出しの行には「## 」を付けます。ルビは ｜漢字《かんじ》、傍点は 《《ここに傍点》》、太字は **ここが太字** の形にし、場面の変わり目は --- だけの行にしてください。記号を足すだけで、文章そのものは1文字も変えず、全角スペースもそのまま残してください。できあがったものは、拡張子 .md のファイルにして渡してください。',
  ],
  [
    '誤字と脱字を直す',
    '本文の誤字・脱字と、明らかな変換ミスだけを直してください。文体は変えないでください。',
  ],
  [
    '章のタイトルを考える',
    '各章の内容に合う章タイトルを考えて、manuscript の章タイトルだけ書き換えてください。本文は変えないでください。',
  ],
  [
    '章の順番を入れ替える',
    '章の順番だけを入れ替えてください。読者が話の流れを追いやすい順に並べ替え、どの章をどこへ動かしたかを最後に一覧で教えてください。各章の中の文章は1文字も変えないでください。',
  ],
  [
    '章の中の段落を並べ替える',
    'この章の中で、話の流れが分かりにくいところがあれば段落の順番だけを入れ替えてください。段落の文章そのものは変えず、動かしたところを最後に教えてください。',
  ],
  [
    '小見出しを入れる',
    '長い章を読みやすくするため、話の切れ目に小見出しを入れてください。小見出しは blocks に { "type": "h3", "text": "…" } として挿入し、本文の文字は1文字も変えないでください。',
  ],
  [
    '大事なところを太字にする',
    '各章で読者に一番届けたい一文だけを ** ** で囲んで太字にしてください。1章につき1か所までにしてください。',
  ],
  [
    '難しい漢字にルビをふる',
    '中学生には読めなさそうな漢字にだけルビをふってください。ルビは 漢字《かんじ》 の形で書き、同じ語は初出の1回だけにしてください。',
  ],
  [
    '著者紹介を書く',
    '本文の雰囲気に合う著者紹介を3〜4行で書いて、manuscript.authorProfile に入れてください。',
  ],
  [
    '表紙のあらすじを書く',
    '裏表紙に載せるあらすじを150字くらいで書いて、cover の blurb に入れてください。ネタバレは避けてください。',
  ],
];

/**
 * 原稿の中に書ける記法と、その見本。**組版が実際に持っているものだけ。**
 *
 * `raw` は原稿にそのまま書く文字列で、見本の右側は
 * **本文と同じ `paragraphHtml()` に通して**組み上げる(block のものは別扱い)。
 * 手で「こう見えます」と書くと、実装が変わったときに画面だけが嘘になる
 */
type Shape = 'inline' | 'h3' | 'chapter' | 'space' | 'quote' | 'list' | 'hr' | 'align';
const NOTATION: {
  what: string;
  how: string;
  result: string;
  raw: string;
  /** その記号が要る理由。要らない行には書かない */
  note?: string;
  shape: Shape;
}[] = [
  {
    what: '一部を太字にする',
    how: '**ここが太字**',
    result: '太字で組まれます',
    raw: '棚の前に立って、僕は**すぐに気がついた**。',
    shape: 'inline',
  },
  {
    what: 'ルビをふる',
    how: '漢字《かんじ》',
    result: '漢字にルビが付きます',
    // 送り仮名を《 》の中に入れる間違いが実際に起きた(2026-08-20、サンプルの
    // 「｜見返し《みかえし》」をユーザーが見つけた)。**例文の中で見せて直す** —
    // 注意書きだけでは読まれない。「沈《しず》んで」は送り仮名が外に出た形
    raw: '窓の外は、いつのまにか黄昏《たそがれ》に沈《しず》んでいた。',
    note: '《 》の直前にある漢字のつづきが、そのまま親文字になります。送り仮名は《 》の外に出してください。「沈《しず》んで」であって「沈んで《しずんで》」ではありません',
    shape: 'inline',
  },
  {
    what: 'ルビの範囲を決める',
    how: '｜好きな範囲《るび》',
    result: '｜から《の直前までが親文字になります',
    raw: '冬の渡り鳥｜鶫《つぐみ》の声が、朝から聞こえていた。',
    note: 'この ｜ は、ルビを付けたい漢字のすぐ前に別の漢字が続いているときだけ要ります。｜ がないと「鳥鶫」までが読みがなの対象になります。送り仮名を外したいときにも使えます（｜見返《みかえ》し）',
    shape: 'inline',
  },
  {
    what: '斜体にする',
    how: '*ここが斜体*',
    result: '斜体で組まれます',
    raw: '看板には*Closed*とだけ書かれていた。',
    note: 'Obsidian の I ボタンと同じ記号です。和文の書体は斜体を持たないことが多く、その場合は字を傾けて作ります',
    shape: 'inline',
  },
  {
    what: '傍点（圏点）をふる',
    how: '《《ここに傍点》》',
    result: '文字の脇にゴマ点が付きます',
    raw: 'それは《《たしかに》》あの本だった。',
    note: '二重の山括弧です。* を使わないのは、Obsidian で斜体を書いた文が全部 傍点になってしまうためです',
    shape: 'inline',
  },
  {
    what: '下線を引く',
    how: '<u>ここに下線</u>',
    result: '下線が引かれます',
    raw: '契約書の<u>第三条</u>を読み返した。',
    note: 'Obsidian の U ボタンが書き込むタグをそのまま読みます',
    shape: 'inline',
  },
  {
    what: '取り消し線を引く',
    how: '~~ここに取り消し線~~',
    result: '取り消し線が引かれます',
    raw: '約束は~~明日~~今日のうちに。',
    note: 'Obsidian の S ボタンと同じ記号です',
    shape: 'inline',
  },
  {
    what: '長いダッシュを引く',
    how: '-- （半角ハイフン2つ）',
    result: '―― になります（2つ）',
    raw: 'そのとき--言葉が途切れた。',
    note: '和文のダッシュは「――」と2つで1組。半角ハイフンを2つ打つだけで、切れ目なく1本につながるその1組になります。全角で「――」と2つ打っても同じです',
    shape: 'inline',
  },
  {
    what: '三点リーダを打つ',
    how: '... （半角ピリオド3つ）',
    result: '…… になります（2つ）',
    raw: '祖母は何も言わなかった...',
    note: '和文の三点リーダは「……」と2つで1組。3つ打つだけで、その1組になります。全角で「……」と2つ打っても同じです（全角の「…」を1つだけ打ったときは、そのまま1つで組まれます）',
    shape: 'inline',
  },
  {
    what: 'リンクを張る（電子書籍だけ）',
    how: '[文字](https://…)',
    result: '電子書籍だけリンクが張れます',
    raw: '詳しくは[あまやどり出版公式サイト](https://www.hittyaka-maker.com/)をご覧ください。',
    note: '紙では飛べないので、ふつうの本文として刷ります（青い字にも下線にもしません）。電子書籍だけリンクが張れます',
    shape: 'inline',
  },
  {
    what: '引用にする',
    how: '行のあたまに >（全角の ＞ も可）',
    result: '一段下げて、細い線を添えて組まれます',
    raw: '> 本は、読まれるまで半分しかできていない。',
    note: '続けて書いた > の行は、ひとつづきの引用としてまとまります',
    shape: 'quote',
  },
  {
    what: '箇条書きにする',
    how: '行のあたまに -（番号なら 1.）',
    result: '記号や番号が付いて、2行目以降も字下げが揃います',
    raw: '- 判型を決める\n- 書体を決める\n- 表紙をつくる',
    note: '半角の - や 1. のうしろには空白が要ります。空白がない行は箇条書きにならず、ふつうの本文として組まれます。全角の ・ と １． は空白なしで拾います。項目のあいだに空行を1つはさんでも、ひとつづきの箇条書きになります（空行2つは1行アキ）。番号は最初の項目に書いた数から数えるので、途中に ・ の項目をはさんで「４．」から書き継げば ４． から続きます',
    shape: 'list',
  },
  {
    /* **「区切り線を入れる」から名前を変えた。**(2026-08-21)
       線は4つある見た目のうちの1つで、しかも既定ではない。
       原稿に書くのは「ここで場面が変わる」という事実だけで、
       それをどう組むかは版面の側（画面下の帯）が決める */
    what: '場面を変える',
    how: '--- だけの行（*** でも可）',
    result: '場面の変わり目として組まれます',
    raw: 'その日、僕は店を出た。\n---\n次に扉を開けたのは、三年あとだった。',
    note: '見た目は画面のいちばん下の帯の［場面転換］で、1行アキ・＊・＊　＊　＊・罫 から選べます（既定は1行アキ。日本の小説はこれが主流です）。書いたハイフンの数で行の扱いが変わります。ハイフン3つ以上だけの行は場面転換に、2つ以下は本文の中のダッシュになります（-- は ―― になります）',
    shape: 'hr',
  },
  {
    what: '署名や日付を行末に寄せる',
    how: '行のあたまに >>（全角の ＞＞ も可）',
    result: '縦書きなら下、横書きなら右へ寄ります',
    raw: 'この本を作るあいだ、何度も版を組み直しました。\n>> 雨宿 文',
    note: 'あとがき・前書きの署名と日付のための書き方です。引用は > を1つ、行末寄せは2つ。Obsidian では入れ子の引用に使う記号ですが、このアプリでは行末寄せになります',
    shape: 'align',
  },
  {
    what: '大見出しを入れる（章）',
    how: '行のあたまに #（Word は見出し1）',
    result: '改ページして目次に載ります',
    raw: '# 第一章　空いた書棚',
    shape: 'chapter',
  },
  {
    what: '小見出しを入れる',
    how: '行のあたまに ##（Word は見出し2）',
    result: 'ゴシックの小見出しになります',
    raw: '## 商店街の古本屋',
    shape: 'h3',
  },
  {
    what: '原稿の行間を空ける',
    how: '空行を1つ',
    result: '1行ぶん空きます',
    raw:
      '母はそれきり黙ってしまった。' +
      '\n' +
      '僕も、それ以上は聞けなかった。' +
      '\n\n' +
      '玄関を開けると、畳の匂いがした。',
    shape: 'space',
  },
];

/**
 * 記法のルールを Markdown 1枚にする。**AI に読ませるためのファイル。**
 *
 * Word の書式は取り込みで落ちるので、原稿を記号に書き換える作業がどうしても要る。
 * その書き換えを AI に頼むとき、**このファイルと原稿を一緒に渡せば規則の説明が済む**
 * (2026-08-19 ユーザーの提案)。
 *
 * 中身は上の NOTATION から作る。**手で書き写さない** — 画面と配るファイルが
 * 食い違うと、AI に間違った規則を教えることになる。
 *
 * 道具ごとの行(「章と小見出しだけは…」の節)は、ヘルプの「Word 以外で書いた原稿」と同じことを言う
 * (2026-10-13 ユーザーの実機の試しで直した: Google ドキュメントは Word(.docx)、Pages などはテキスト + 記号の書き足し。
 * Pages には Markdown の書き出しが無い)
 */
function notationMarkdown(): string {
  const rows = NOTATION.map((n) => `| ${n.what} | \`${n.how}\` | ${n.result} |`).join('\n');
  const examples = NOTATION.map(
    (n) => `### ${n.what}\n\n原稿:\n\n\`\`\`\n${n.raw}\n\`\`\`\n\n${n.note ?? ''}`.trim(),
  ).join('\n\n');
  return `# 「ひっちゃか本づくりスタジオ」の原稿の書き方

このファイルは、**日本語の本を組むソフトが読み取る記号の一覧**です。
原稿をこの記号に書き換えるときの規則として使ってください。

## お願い

- 原稿の**文章そのものは1文字も変えない**でください。飾りを記号に置き換えるだけです。
- **Word（.docx）の書式は落ちます。** 太字ボタン・文字色・文字サイズは
  取り込みで消えるので、飾りが付いていた箇所を下の記号に書き換えてください。
  （Word のルビ機能で振ったルビは、取り込むときにルビの記号へ置き換わります）
- **Markdown（.md / Obsidian）の記号はそのまま使えます。** ただし
  文字色（\`<span style>\`）とハイライト（\`==〜==\`）は紙に出せないので、
  印だけ外して文字を残します。強調したいところは下の記号に置き換えてください。
- **全角スペース（U+3000）を半角に変えないでください。** 日本語の組版では字間そのものです。
- 全角のダッシュ・括弧・英数字も、そのまま残してください。

## 記号の一覧

| やりたいこと | 原稿にこう書く | 刷り上がり |
|---|---|---|
${rows}

## 章と小見出しだけは、記号を使わない書き方もできます

- **Word（.docx）** … 見出し1が章、見出し2が小見出しになります。
- **Markdown（.md）/ テキスト（.txt）** … 行のあたまの \`#\` が章、\`##\` が小見出しです。
- テキストでは「第一章」「プロローグ」のように書いた行も、記号なしで章になります。
- **Google ドキュメント** … 「ファイル」→「ダウンロード」→「Microsoft Word（.docx）」で保存すれば、Word と同じに読み取ります（見出し 1 が章、見出し 2 が小見出し）。
  Markdown（.md）でのダウンロードは、画像が粗くなったり抜けたりするので使いません。
- **Pages・メモ帳など（テキストの原稿）** … Pages は「ファイル」→「書き出す」→「標準テキスト」で .txt にします（Pages には Markdown の書き出しが無く、「Word」への書き出しは章に分かれません）。
  テキストでは「第一章」のような行で章に分かれます。小見出し・ルビ・傍点なども入れるときは、文章を1文字も変えずに、この一覧の記号を書き足して .md にします。

## 書けないもの

次の指定は、このソフトの組版では対応していません。書いても紙面には出ません。

- 行の途中だけ**書体・大きさ・色**を変えること（本全体・章ごとの指定はソフト側で行います）
- 蛍光ペンのハイライト（\`==〜==\` は印だけ外して文字を残します）

## ひとつずつの例

${examples}
`;
}

/**
 * 頼み方の例を Markdown 1枚にする。**AI に渡すためではなく、手元に置くため。**
 * 毎回この画面を開かなくても、テキストエディタから貼れるようにしておく
 * (2026-08-19 ユーザー要望)。中身は上の PROMPTS から作る — 手で書き写さない。
 */
function promptsMarkdown(): string {
  const body = PROMPTS.map(([label, text]) => `## ${label}\n\n${text}\n`).join('\n');
  return `# 「ひっちゃか本づくりスタジオ」AI への頼み方

書き出した \`.json\` ファイルを添付して、下の文をそのまま貼ってください。

## まず、この一言を添えてください

> ファイルの先頭の説明を読んでから直しはじめてください。

先頭には次の4つが書いてあります。

- 頼んでいない箇所は1文字も変えないこと
- 全角スペース（U+3000）を半角に変えないこと
- \`#img\` で始まる値はそのまま残すこと（画像の目印です）
- 章を増減したら、章ごとの設定の番号も振り直すこと

# 頼み方の例

${body}`;
}

/**
 * 文をコピーして、押した札に「コピーしました」を2秒出す。**失敗したら黙らず**、選んでコピーする窓を出す
 * (以前の2か所は、クリップボードが使えないと何も起きなかった。2026-10-01 に共通の関数へ集めた)
 */
async function copyWithMark(label: string, text: string, mark: (label: string) => void) {
  if (await copyText(text)) {
    mark(label);
    setTimeout(() => mark(''), 2000);
  } else {
    copyFallback(text);
  }
}

/** 頼み方の一覧を全面で見せる。1つずつコピーして使うもの */
function PromptsPanel({ onClose, onDownload }: { onClose: () => void; onDownload: () => void }) {
  const [copied, setCopied] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = (label: string, text: string) => void copyWithMark(label, text, setCopied);

  return (
    <div className="about-backdrop" onClick={onClose}>
      <div
        className="about demo-panel"
        role="dialog"
        aria-label="AI への頼み方"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="about-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>
        <h2>そのまま渡せる頼み方</h2>
        {/* 「例であって縛りではない」を先に言う(2026-09-02 ユーザー要望)。
            文例だけ見せると「この中から選ぶもの」と読めてしまう */}
        {/* 「なぜAIに頼むのか」から言う(2026-09-04 ユーザー指摘。
            文字の修正= .json を書き直す仕事 → 自分では大変 → だからAI、の順) */}
        <p className="about-lede">
          スタジオで作った本の<b>中身の手直し</b>（文字の修正・見出しの追加など）は、
          書き出した <b>.json ファイルを書き直す</b>ことになります。
          自分で書き直すのは大変なので、<b>AI に頼むのがいちばん</b>です——
          .json を添付して、やりたいことを伝えるだけ。
          頼む文は<b>自由に書いてかまいません</b>が、「こんな修正をしたいときは、
          こう伝えるとうまくいく」という文例をここに集めました。
          そのまま貼っても、自分の言葉に書き換えても大丈夫です。
        </p>
        <button className="ghost panel-download" onClick={onDownload}>
          頼み方をまとめてダウンロード（.md）
        </button>
        <ul className="prompt-list">
          {PROMPTS.map(([label, body]) => (
            <li key={label}>
              <b>{label}</b>
              <span>{body}</span>
              <button className="ghost" onClick={() => copy(label, body)}>
                {copied === label ? 'コピーしました' : 'この文をコピー'}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 見本の右側。**本文と同じ変換に通す**(手で書き写さない) */
function Rendered({ raw, shape, scene }: { raw: string; shape: Shape; scene: SceneBreakId }) {
  if (shape === 'h3') {
    return (
      <div className="demo-page">
        {/* 前後の段落は本文ではなく**説明のための添え物**なので、地の文と同じ黒にしない */}
        <p className="demo-p demo-dim">前の段落がここで終わります。</p>
        <h4 className="demo-h3">{raw.replace(/^#+\s*/, '')}</h4>
        <p className="demo-p demo-dim">次の段落がここから始まります。</p>
      </div>
    );
  }
  if (shape === 'chapter') {
    return (
      <div className="demo-page">
        <p className="demo-break">— ここで改ページ —</p>
        <p className="demo-chapter-no">第一章</p>
        <h4 className="demo-chapter">空いた書棚</h4>
      </div>
    );
  }
  if (shape === 'quote') {
    return (
      <div className="demo-page">
        <p className="demo-p demo-dim">前の段落がここで終わります。</p>
        <blockquote className="demo-quote">{raw.replace(/^[>＞][ 　]?/, '')}</blockquote>
        <p className="demo-p demo-dim">次の段落がここから始まります。</p>
      </div>
    );
  }
  if (shape === 'list') {
    return (
      <div className="demo-page">
        <ul className="demo-list">
          {raw.split('\n').map((line, i) => (
            <li key={i}>{line.replace(/^[-*+][ 　]+/, '')}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (shape === 'hr') {
    /* **いま選んでいる見た目で見せる。**(2026-08-21)
       見本は「原稿 → 刷り上がり」で見せる決まりなので、選んでいないものを
       描いたらそれは嘘になる。1行アキのときだけ字で断るのは、
       空行の見本(shape === 'space')と同じ理由 —
       見本の大きさでは、白い余白が「たまたま空いている」ようにしか見えない。
       **紙にこの字は出ない**(組版が置くのは全角空白だけ) */
    const [before, , after] = raw.split('\n');
    return (
      <div className="demo-page">
        <p className="demo-p">{before}</p>
        {scene === 'rule' ? (
          <hr className="demo-hr" />
        ) : scene === 'blank' ? (
          <p className="demo-gap">ここが1行ぶんのアキ</p>
        ) : (
          <p className="demo-p demo-scene-mark">{SCENE_BREAKS[scene].mark}</p>
        )}
        <p className="demo-p">{after}</p>
      </div>
    );
  }
  if (shape === 'align') {
    // 見本の紙面は横組みなので「右へ寄る」が出る。縦組みの本では地(下)へ寄る
    const [before, signed] = raw.split('\n');
    return (
      <div className="demo-page">
        <p className="demo-p demo-dim">{before}</p>
        <p className="demo-p demo-align-end">{signed.replace(/^[>＞]{2}[ 　]?/, '')}</p>
      </div>
    );
  }
  if (shape === 'space') {
    // 空行で区切られた「かたまり」ごとに、2つめから上を空ける。
    // 続けて書いた行がどう組まれるかも見せないと、何が変わったのか分からない
    const groups = raw.split(/\n{2,}/).map((g) => g.split('\n'));
    return (
      <div className="demo-page">
        {groups.map((lines, gi) => (
          <div key={gi}>
            {/* **空いたことを字で示す。** 白い紙の上の余白は、
                見本の大きさだと「たまたま空いている」ようにしか見えない */}
            {gi > 0 && <p className="demo-gap">ここが1行ぶんのアキ</p>}
            {lines.map((line, li) => (
              <p className="demo-p" key={li}>
                {line}
              </p>
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="demo-page">
      <p className="demo-p" dangerouslySetInnerHTML={{ __html: paragraphHtml(raw, false) }} />
    </div>
  );
}

/** 記法の見本を全面で見せる。表の1行だけでは、どう変わるのかが伝わらなかった */
function NotationDemo({ onClose, onDownload }: { onClose: () => void; onDownload: () => void }) {
  /* 「場面を変える」がどう組まれるかは、いま選んでいる見た目で決まる(2026-08-21)。
     **店から直に取る。** 見本のためだけに props を1本通すほどの筋ではない
     (FormatBar が cover / resetDesign を取っているのと同じ扱い) */
  const scene = useProject((s) => sceneBreakOf(s.settings));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="about-backdrop" onClick={onClose}>
      <div
        className="about demo-panel"
        role="dialog"
        aria-label="原稿の書き方の見本"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="about-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>
        <h2>原稿にこう書くと、こう組まれます</h2>
        {/* 「Wordの飾り→AIで記号に書き換え→取り込む」の順番が読めなかった
            (2026-09-04 ユーザー指摘「それが今の文章だとさっぱりわからん」)。
            なぜ消える→だからどうする→誰がやる、の順で言い切る */}
        <p className="about-lede">
          左が<b>あなたの原稿に書く文字</b>、右が<b>刷り上がり</b>です。
          スタジオが読み取れるのは、文章の中に書かれた<b>この記号だけ</b>。
          <b>Word のボタンで付けた太字やルビ・文字色は、取り込むと消えます。</b>
        </p>
        <p className="about-lede">
          だから、Word で飾りを付けてある原稿は、<b>取り込む前に、飾りをこの記号に
          書き換えておきます</b>。
          下の<b>［このルールをダウンロード］</b>のファイルと Word の原稿を AI に渡して、
          <b>「文章は変えずに、飾りをこのルールの記号に書き換えて」</b>と頼むと効率的です。
        </p>
        {/* **ダウンロードは先頭に置く。** 下まで読まないと落とせないのは効率が悪い
            (2026-08-19 ユーザー指摘) */}
        <button className="ghost panel-download" onClick={onDownload}>
          このルールをダウンロード（.md）
        </button>
        {NOTATION.map((n) => (
          <div className="demo-row" key={n.what}>
            <h3>{n.what}</h3>
            {n.note && <p className="demo-note">{n.note}</p>}
            <div className="demo-pair">
              <div>
                <span className="demo-side">原稿に書く</span>
                <pre className="demo-raw">{n.raw}</pre>
              </div>
              <span className="demo-arrow" aria-hidden="true">
                →
              </span>
              <div>
                <span className="demo-side">刷り上がり</span>
                <Rendered raw={n.raw} shape={n.shape} scene={scene} />
              </div>
            </div>
          </div>
        ))}
        <p className="hint">
          ルビの<code>《 》</code>と<code>｜</code>は<b>全角</b>です。
          半角の <code>&lt; &gt;</code> や <code>|</code> ではルビになりません
        </p>
      </div>
    </div>
  );
}

/**
 * 扉の中の読み物パネル。Esc と背面クリックで閉じる
 * (NotationDemo / PromptsPanel と同じ流儀。あちらは中身が特殊なので別のまま)
 */
function DoorPanel({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="about-backdrop" onClick={onClose}>
      <div className="about demo-panel" role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <button className="about-close" aria-label="閉じる" onClick={onClose}>
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

/**
 * やりたいこと。**主画面の入口はこの5枚。**(4枚から増やした: 2026-10-01 の「AI に入稿ガイドを読んでもらう」。
 * 2026-09-23 ユーザー要望「行動別になっている方が
 * わかりやすいかも。画像を自前のAIで入れるときのやり方、文字を修飾したいときのやり方、みたいな感じ」)
 *
 * それまでの主画面は「やることは3つだけ」(JSON の往復)と4枚の扉だった。だが実際の流れは
 * 行動ごとに違う — 誤字直しは JSON の往復、Word の飾りは取り込む前の原稿直し、
 * 絵はそもそも AI が要らない(［挿絵］で入れられる)。1本の手順に全部を載せていたので、
 * 自分の用事がどの流れなのかを利用者が読み解く必要があった。
 *
 * **カードに番号は振らない。** 番号は開いたあとの手順だけが持つ
 * (2026-09-04 ユーザー指摘「上と下でどっちも①②③を使うのが混乱のもと」)
 */
type Action = 'fix' | 'deco' | 'blurb' | 'image' | 'printshop';
const ACTIONS: { id: Action; title: string; sub: string }[] = [
  { id: 'fix', title: '文字を直す', sub: '誤字・言い回し・章のタイトル・章の順番・小見出し' },
  { id: 'deco', title: '文字を飾る', sub: '太字・ルビ・傍点・引用など' },
  { id: 'blurb', title: '紹介文を書いてもらう', sub: '著者紹介・裏表紙のあらすじ' },
  { id: 'image', title: '画像を入れる・差し替える', sub: 'AI は要りません。スタジオでできます' },
  // 2026-10-01 ユーザーと決定。本まるごとの書き出しは要らない(数行を読むだけ)ので、JSON の往復とは別の道
  // 名前は「入稿の数字を調べる」(2026-10-03 ユーザー指摘「このカードだけ『AIに』と入っている。大事なのはガイドを読ませることでなく数字を調べること」)。
  // **出し先が［その他の印刷所］(決まりを利用者が入れる)のときだけ出す。** KDP など決まりをスタジオが持つ会社は、カードごと出さない
  { id: 'printshop', title: '入稿の数字を調べる', sub: '塗り足し・ノドの下限など、印刷所のガイドにある数字を AI に探してもらいます' },
];

/**
 * 行動ごとに出す文例。**PROMPTS の見出しで引く**(番号で引くと、並べ替えたときに黙ってずれる)。
 * 文例そのものは PROMPTS 1か所だけに書く — 配布する .md(promptsMarkdown)も同じ配列から作る
 */
const PROMPTS_FOR = {
  fix: ['誤字と脱字を直す', '章のタイトルを考える', '章の順番を入れ替える', '章の中の段落を並べ替える', '小見出しを入れる'],
  decoBook: ['大事なところを太字にする', '難しい漢字にルビをふる'],
  // まだ取り込んでいない原稿。Word で付けた飾りを記号に直す文と、テキストや md に
  // 新しく飾りを足す文の両方を出す(2026-09-23 ユーザー指摘「テキストや md でもいいはず」)
  decoFile: ['原稿の飾りを記号に書き換える', TEXT_MARKS_PROMPT, '大事なところを太字にする', '難しい漢字にルビをふる'],
  blurb: ['著者紹介を書く', '表紙のあらすじを書く'],
} as const;

/** 1つずつコピーできる文例の並び。全面の一覧(PromptsPanel)と同じ見た目 */
function PromptList({ labels }: { labels: readonly string[] }) {
  const [copied, setCopied] = useState('');
  const copy = (label: string, text: string) => void copyWithMark(label, text, setCopied);
  return (
    <ul className="prompt-list">
      {PROMPTS.filter(([label]) => labels.includes(label)).map(([label, body]) => (
        <li key={label}>
          <b>{label}</b>
          <span>{body}</span>
          <button className="ghost" onClick={() => copy(label, body)}>
            {copied === label ? 'コピーしました' : 'この文をコピー'}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * **JSON の往復。** 文字を直す・飾りを足す・紹介文を書かせる、の3つはこの流れ。
 * 手順の文言は、それまでの主画面の3手順をそのまま持ってきた(2026-09-14 のユーザー指定の言い回し)。
 * 違うのは頼む手順で出す文例だけ。
 *
 * **手順の段(<li>)だけを返す。** 包む <ol> は呼ぶ側が持つ。飾るでは分かれ道の段①を同じ <ol> の
 * 先頭に置き、その後ろだけを道ごとに差し替える — <ol> ごと差し替えると、押したばかりの
 * 分かれ道のボタンが作り直されてフォーカスが失われる(2026-09-23 レビューで発見)
 */
function JsonSteps({
  start,
  labels,
  askMore,
  onExportForAi,
  onLoadProject,
}: {
  /** 1つめの段の番号 */
  start: number;
  labels: readonly string[];
  /** 手順「あなたの AI に頼む」の文例の下に足す一言 */
  askMore?: ReactNode;
  onExportForAi: () => void;
  onLoadProject: () => void;
}) {
  return (
    <>
      <li>
        <span className="ai-flow-no">{start}</span>
        <b>本を書き出す</b>
        <button className="primary-action" onClick={onExportForAi}>
          AI用に書き出す
        </button>
        <span>
          上の<b>［AI用に書き出す］ボタンを押す</b>と、<b>画像を抜いた軽い .json ファイル</b>
          が手元に保存されます（画像は重すぎてチャットに貼れません）
        </span>
      </li>
      <li>
        <span className="ai-flow-no">{start + 1}</span>
        <b>あなたの AI に頼む</b>
        <span className="ai-flow-plain">チャットにファイルを添付</span>
        {/* 一言はここに直接書く(2026-09-14 ユーザー報告「必読の一言がどこに書いてあるか、
            この文面じゃわからない」)。文言も同日のユーザー指定そのまま */}
        <span>
          あなたの AI のチャット欄にファイルを添付したら、最初にこの一言をそのまま貼ります——
          <b>「ファイルの先頭の説明を読んでから直しはじめてください」</b>。
          そのあとに、下の文例をコピーして貼ります（自分の言葉に書き換えても大丈夫です）
        </span>
        <PromptList labels={labels} />
        {askMore}
      </li>
      <li>
        <span className="ai-flow-no">{start + 2}</span>
        <b>直った本を戻す</b>
        <button className="primary-action" onClick={onLoadProject}>
          読み込む
        </button>
        {/* 流れを最初から書く(2026-09-14 ユーザー指摘)。どのファイルを・どのボタンで・すると何が起きる */}
        <span>
          AI が直して返してきた <b>.json ファイルを手元に保存</b>し、
          上の<b>［読み込む］ボタン</b>でそのファイルを選びます。すると、
          <b>いまスタジオで作りかけの本のデータが、選んだファイルの中身に丸ごと
          置き換わります</b>。なお、データを読み込ませる前に、画面の上の
          <b>［保存する］</b>でいまの本を自分のパソコンに保存しておくと、
          万一 AI が壊していても元に戻せて安心です
        </span>
      </li>
    </>
  );
}

/**
 * **必読は手順の中に置く。** 扉として下に並べるだけだと、読まずに進めてしまう。
 * 往復の流れを選んだ人が必ず通る場所なので、札つきで割り込ませる
 * (必読は別格: 2026-09-02 ユーザー指摘「必ず伝えることが最初」の発展形)
 */
function MustInline({ askStep, onOpenMust }: { askStep: number; onOpenMust: () => void }) {
  return (
    <div className="ai-must-inline">
      <span className="ai-badge">必読</span>
      <span>
        <b>AI にデータを壊されないために</b>——書き出した .json の先頭には、
        本を壊さないための注意書きを入れてあります。手順{askStep}の一言は、それを AI に読ませるためのものです
      </span>
      <button className="linklike" onClick={onOpenMust}>
        注意書きの中身を読む
      </button>
    </div>
  );
}

/** 往復の3手順と必読(文字を直す・紹介文を書いてもらう) */
function JsonFlow({
  labels,
  onExportForAi,
  onLoadProject,
  onOpenMust,
}: {
  labels: readonly string[];
  onExportForAi: () => void;
  onLoadProject: () => void;
  onOpenMust: () => void;
}) {
  return (
    <>
      <ol className="ai-flow">
        <JsonSteps start={1} labels={labels} onExportForAi={onExportForAi} onLoadProject={onLoadProject} />
      </ol>
      <MustInline askStep={2} onOpenMust={onOpenMust} />
    </>
  );
}

/**
 * JSON の往復で効く飾り。**文の中の飾りだけ。**(2026-09-23 レビューで発見)
 * 引用(>)・行末寄せ(>>)・箇条書き・場面転換・見出し・行間は、原稿ファイルを取り込むときに
 * 行の頭の記号から段落の形へ直している(importers/)。JSON で戻した本文は取り込みを通らないので、
 * 記号がそのまま字として刷られる
 */
const INLINE_NOTATIONS = NOTATION.filter((n) => n.shape === 'inline').length;

/**
 * AI タブの先頭に置く動画(YouTube)。**押すまで何も読み込まない。**(2026-10-01 ユーザーと決定)
 *
 * - AI_VIDEO_URL が空(動画がまだ無い)なら、何も出さない
 * - 押す前は、ローカルの絵だけの1行。**YouTube のサムネイル画像(i.ytimg.com)は使わない**:
 *   表示しただけで Google へ接続してしまう。「原稿を外へ送らない」と書いているこのアプリでは、
 *   見る人が押すまで外へ出ない形にする
 * - 押したら youtube-nocookie の埋め込みに替える。下に「YouTube で開く」を常に置く
 *   (file:// などで埋め込みを断られたときの逃げ道でもある)
 * - 動画の ID は youtubeIdOf が 11文字の形で確かめる。通らなければ何も描かない
 *   (iframe の src に任意の文字列を入れない)
 * - AiStep は step==='ai' の間だけ描かれるので、タブを離れると iframe ごと消えて音も止まる
 */
function AiVideo() {
  const [playing, setPlaying] = useState(false);
  const id = youtubeIdOf(AI_VIDEO_URL);
  if (!id) return null;
  const mins = AI_VIDEO_MINUTES > 0 ? `（${AI_VIDEO_MINUTES}分）` : '';
  return (
    <div className="ai-video">
      {playing ? (
        <div className="ai-video-frame">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`}
            title="AI でできること（動画）"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      ) : (
        <button className="ai-video-play" onClick={() => setPlaying(true)}>
          <FrogPeek width={46} mood="happy" />
          <svg className="ai-video-icon" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
            <circle cx="15" cy="15" r="14" fill="currentColor" />
            <path d="M12 9.5 L21.5 15 L12 20.5 Z" fill="var(--bg-box)" />
          </svg>
          <span className="ai-video-text">
            <b>AI でできることを動画で見る{mins}</b>
            <small>見なくても使えます。押すと YouTube に接続します</small>
          </span>
        </button>
      )}
      <a
        className="ai-video-open"
        href={`https://www.youtube.com/watch?v=${id}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        YouTube で開く
      </a>
    </div>
  );
}

export function AiStep({
  onExportForAi,
  onLoadProject,
  onPickManuscript,
  onGoToPlates,
  onGoToShape,
  printRulesState,
  imageCheckPrompt,
}: Props) {
  /**
   * **主画面は「やりたいこと5枚」と、その下に開く1つの流れだけ。**
   * (2026-09-02 ユーザー要求「文字が多すぎる。全部を一つの画面で見せる必要はない」の延長)。
   * 選ぶまでは手順を出さない。くわしい話は下の［くわしく読む］の扉の中
   */
  const [open, setOpen] = useState<null | 'demo' | 'prompts' | 'must' | 'cant'>(null);
  const close = () => setOpen(null);
  const [action, setAction] = useState<Action | null>(null);
  // 出し先を変えて［入稿の数字を調べる］の札が消えたら、選んでいた印も外す(札が無いのに、
  // 戻したときだけ勝手に開いて見える・どの札も選ばれていないのに下に手順が残る、を防ぐ)
  useEffect(() => {
    if (action === 'printshop' && printRulesState !== 'ok') setAction(null);
  }, [action, printRulesState]);
  /** 「印刷所の決まり」の頼み方をコピーした印(押した札に2秒だけ出す) */
  const [guideCopied, setGuideCopied] = useState('');
  /**
   * 飾りを付けたい原稿はどこにあるか。**流れがまるで違う**ので、先に分ける:
   * もうスタジオに入っている本は JSON の往復、まだ取り込んでいない原稿(Word・テキスト・md)は
   * 取り込む前の原稿直し(Word のボタンの飾りは取り込むと消えるため)
   */
  const [decoFrom, setDecoFrom] = useState<'book' | 'file'>('book');

  const downloadNotation = () =>
    downloadBlob(
      new Blob([notationMarkdown()], { type: 'text/markdown;charset=utf-8' }),
      '原稿の書き方.md',
    );

  const downloadPrompts = () =>
    downloadBlob(
      new Blob([promptsMarkdown()], { type: 'text/markdown;charset=utf-8' }),
      'AIへの頼み方.md',
    );

  const flowProps = { onExportForAi, onLoadProject, onOpenMust: () => setOpen('must') };
  const stepProps = { onExportForAi, onLoadProject };

  /**
   * 飾るの手順①。**分かれ道を流れの先頭の段にする。**(2026-09-23 ユーザー指摘
   * 「『飾りを付けたい原稿は、いまどこにありますか』が上にあるとわかりにくい。①として流れの先頭に」)。
   * 手順の枠の外に問いを置いていたら、問いと手順のつながりが読めなかった。
   * 横いっぱいの段にして、その下に②〜④を並べる(app.css の .ai-flow-fork)
   */
  const decoFork = (
    <li className="ai-flow-fork">
      <span className="ai-flow-no">1</span>
      <b>飾りを付けたい原稿は、いまどこにありますか</b>
      <div className="seg ai-fork">
        <button
          className={decoFrom === 'book' ? 'active' : ''}
          aria-pressed={decoFrom === 'book'}
          onClick={() => setDecoFrom('book')}
        >
          <b>もうスタジオに入っている本</b>
          <small>AI用に書き出して頼み、戻します</small>
        </button>
        <button
          className={decoFrom === 'file' ? 'active' : ''}
          aria-pressed={decoFrom === 'file'}
          onClick={() => setDecoFrom('file')}
        >
          <b>まだ取り込んでいない原稿</b>
          <small>Word・テキスト・md。取り込む前に、原稿に飾りの記号を入れてもらいます</small>
        </button>
      </div>
    </li>
  );
  /**
   * 文例に無い飾りの頼み方。**頼む手順の中で言う。**(2026-09-23 ユーザー指摘
   * 「他の例も『使える飾りのルール』にあるので、②の中で知らせた方がいい。全体枠の一番下に
   * 書いてあるけど、これだと気が付かない」)
   */
  const rulesLink = (
    <button className="linklike" onClick={() => setOpen('demo')}>
      ［使える飾りのルール］
    </button>
  );
  /** スタジオに入っている本(JSON の往復)。**文の中の飾りだけ**を言う(INLINE_NOTATIONS) */
  const decoMoreBook = (
    <p className="ai-flow-more">
      文例にない飾りも、<b>文の中の飾り</b>（傍点・下線・斜体など、{INLINE_NOTATIONS}種類）なら
      同じように頼めます。{rulesLink}で見本を見て、文例の言葉を書き換えてください。
      引用・行末寄せ・箇条書きのような<b>行ごとの飾りは、この往復では効きません</b>
      （①で［まだ取り込んでいない原稿］を選ぶと、原稿ファイルに入れてもらう手順が出ます）
    </p>
  );
  /** 取り込む前の原稿。取り込みが行の頭の記号も読むので、全部の飾りが使える */
  const decoMoreFile = (
    <p className="ai-flow-more">
      文例にない飾り（傍点・下線・引用・行末寄せなど、全部で{NOTATION.length}種類）も頼めます。
      {rulesLink}で見本を見て、文例の言葉を書き換えてください（記号は自分で書き込んでもかまいません）
    </p>
  );

  return (
    <>
      <AiVideo />
      {/* リードは「できるようになること→やり方」の順(2026-09-02 ユーザーの言い直し) */}
      <p className="step-lede">
        「ここだけ太字にしたい」「誤字をまとめて直したい」——スタジオにできない
        <b>中身の手直し</b>も、<b>あなたがふだん使っているチャットAI</b>
        （ChatGPT・Claude・Gemini など）の力を借りればできます。
        <b>やりたいことを選ぶ</b>と、そのやり方が下に出ます。
      </p>

      <h2 className="ai-flow-title">何をしたいですか</h2>
      <div className="ai-actions" role="group" aria-label="やりたいこと">
        {ACTIONS.filter((a) => a.id !== 'printshop' || printRulesState === 'ok').map((a) => (
          <button
            key={a.id}
            className={action === a.id ? 'ai-action on' : 'ai-action'}
            aria-pressed={action === a.id}
            onClick={() => setAction(action === a.id ? null : a.id)}
          >
            <b>{a.title}</b>
            <span>{a.sub}</span>
          </button>
        ))}
      </div>

      {action === 'fix' && (
        <section className="ai-panel">
          <JsonFlow labels={PROMPTS_FOR.fix} {...flowProps} />
        </section>
      )}

      {action === 'blurb' && (
        <section className="ai-panel">
          <JsonFlow labels={PROMPTS_FOR.blurb} {...flowProps} />
        </section>
      )}

      {action === 'deco' && (
        <section className="ai-panel">
          {/* **<ol> と段①は道を切り替えても作り直さない。** 後ろの段だけを差し替える(JsonSteps の頭の説明) */}
          <ol className="ai-flow">
            {decoFork}
            {decoFrom === 'book' ? (
              <JsonSteps start={2} labels={PROMPTS_FOR.decoBook} askMore={decoMoreBook} {...stepProps} />
            ) : (
              /* **取り込む前の原稿直し。** Word のボタンで付けた太字やルビは取り込みで落ちるので、
                 取り込む前に記号へ書き換えてもらう(なぜ消える→だからどうする→誰がやる、の順。
                 2026-09-04 ユーザー指摘「それが今の文章だとさっぱりわからん」)。
                 テキストや md の原稿も同じ道で、こちらは新しく飾りの記号を足してもらう */
              <>
                <li>
                  <span className="ai-flow-no">2</span>
                  <b>ルールを手元に落とす</b>
                  <button className="primary-action" onClick={downloadNotation}>
                    ルールをダウンロード（.md）
                  </button>
                  <span>
                    スタジオが読み取れる飾りの記号を1枚にまとめたファイルです
                    （中身は［くわしく読む］の［使える飾りのルール］と同じ）
                  </span>
                </li>
                <li>
                  <span className="ai-flow-no">3</span>
                  <b>原稿と一緒に AI に渡す</b>
                  <span className="ai-flow-plain">原稿とルールを添付</span>
                  <span>
                    あなたの AI のチャット欄に2つを添付して、やりたいことに合う文をコピーして貼ります。
                    <b>Word のボタンで付けた太字やルビは、取り込むと消えます</b>——1つめの文で記号に
                    書き換えてもらえば残ります
                  </span>
                  <PromptList labels={PROMPTS_FOR.decoFile} />
                  {decoMoreFile}
                </li>
                <li>
                  <span className="ai-flow-no">4</span>
                  <b>直った原稿を取り込む</b>
                  <button className="primary-action" onClick={onPickManuscript}>
                    原稿を選ぶ
                  </button>
                  <span>
                    AI が記号を入れた原稿を、<b>テキストファイル（.txt か .md）で保存</b>してから
                    選びます。<b>本文だけが入れ替わり</b>、挿絵・背景・表紙・設定・奥付と著者紹介は
                    そのまま残ります
                  </span>
                </li>
              </>
            )}
          </ol>
          {decoFrom === 'book' && <MustInline askStep={3} onOpenMust={() => setOpen('must')} />}
        </section>
      )}

      {action === 'image' && (
        <section className="ai-panel">
          {/* **絵に AI は要らない。**(2026-09-23)
              章の途中にも［挿絵］で段落を選んで入れられるようになった。それまでは Word に書き出して
              貼るか、ファイルを直接さわれる AI に画像込みの保存を渡すしかなかった。
              利用者はこの用事を AI の話だと思ってここへ来る(ユーザーの例「画像を自前のAIで入れるときのやり方」)
              ので、カードは残して、行き先を言い切る */}
          <p className="ai-image-lede">
            画像を入れるのに<b>AI は要りません</b>。スタジオの
            <b>［本文に画像とコラムを入れる］の［挿絵］</b>で、章の切れ目にも、
            <b>章の途中（段落を選んで）</b>にも入れられます。差し替えや場所の変更もそこでできます。
          </p>
          <button className="primary-action" onClick={onGoToPlates}>
            ［挿絵］を開く
          </button>
          <p className="hint">
            チャットの AI には画像を渡していない（書き出す .json に画像は入りません）ので、
            画像の追加や差し替えは AI には頼めません
          </p>

          {/* **手持ちの画像の細かさは、入れる前に AI で確かめられる。**(2026-10-09 ユーザー要望)
              入れた画像はスタジオが測って［挿絵］の行と「直すところ」で知らせるが、どれを使うか選ぶ段階では
              測れない。要る画素数はこの本の数字を頼み方に入れてあるので、AI は画像の画素数を読んで比べるだけ */}
          {imageCheckPrompt && (
            <>
              <h3 className="ai-image-sub">画像の細かさを AI に確かめてもらう</h3>
              <p>
                本に入れた画像は、スタジオがその場で細かさを確かめ、足りないときは<b>［挿絵］の行</b>と
                <b>［完成データを書き出す］の「直すところ」</b>でお知らせします。
                入れる前に手元の画像を確かめたいときは、この本に必要な画素数が入った頼み方を、画像と一緒に AI へ渡してください。
              </p>
              <ol className="ai-flow">
                <li>
                  <span className="ai-flow-no">1</span>
                  <b>頼み方をコピーする</b>
                  <button
                    className="primary-action"
                    onClick={() => void copyWithMark('imgcheck', imageCheckPrompt, setGuideCopied)}
                  >
                    {guideCopied === 'imgcheck' ? 'コピーしました' : '頼み方をコピー'}
                  </button>
                  <span>本文全面・本文中・見開き・表紙ごとに、必要な画素数が入っています</span>
                </li>
                <li>
                  <span className="ai-flow-no">2</span>
                  <b>あなたの AI に頼む</b>
                  <span className="ai-flow-plain">画像を添付して、頼み方を貼り付ける</span>
                  <span>
                    画像ごとに、どの使い方なら足りるかが返ってきます。
                  </span>
                </li>
              </ol>
              <p className="hint">
                AI は画素数を読み違えることがあります。気になる画像は、ファイルを右クリックして
                ［プロパティ］→［詳細］の「大きさ」（Mac は［情報を見る］の「詳細情報」にある「寸法」）で、横と縦の画素数を直接確かめてください。
              </p>
            </>
          )}
        </section>
      )}

      {action === 'printshop' && printRulesState === 'ok' && (
        <section className="ai-panel">
          {/* **本まるごとの書き出しは要らない。**(2026-10-01 ユーザーと決定) 欲しいのは数行の数字だけなので、
              JSON を往復させる(壊される危険がある)かわりに、頼み方と入稿ガイドだけを AI に渡す */}
          <p className="ai-image-lede">
            印刷所に出す本の<b>塗り足しとノドの下限</b>は、印刷所ごとに違います。
            あなたの AI に<b>入稿の数字を探してもらう</b>と、数行で返ってくるので、
            スタジオの<b>［本のかたちを決める］の「印刷所の決まり」</b>に貼ります。
            <b>本のデータを AI に渡す必要はありません</b>。
          </p>
          {(
            <ol className="ai-flow">
              <li>
                <span className="ai-flow-no">1</span>
                <b>頼み方をコピーする</b>
                {/* **ここでコピーできるようにする。**(2026-10-01 ユーザー指摘「［欄に入れる］がどこだか分からず探した」)
                    もとは［本のかたちを決める］へ飛んでからコピーさせていたが、行って・戻って・また行く、になっていた。
                    コピーはここで済ませ、飛ぶのは貼るとき(3コマ目)の1回だけにする */}
                <button
                  className="primary-action"
                  onClick={() => void copyWithMark('guide', PRINT_GUIDE_PROMPT, setGuideCopied)}
                >
                  {guideCopied === 'guide' ? 'コピーしました' : '頼み方をコピー'}
                </button>
                <span>AI に渡す頼み方の文を、ここでコピーします</span>
              </li>
              <li>
                <span className="ai-flow-no">2</span>
                <b>あなたの AI に頼む</b>
                <span className="ai-flow-plain">入稿ガイドと頼み方を貼る</span>
                <span>
                  あなたの AI のチャット欄に、印刷所の<b>入稿ガイド（PDF を添付、または URL）</b>と、
                  コピーした頼み方を貼ります。返ってくるのは<b>6行</b>です
                </span>
              </li>
              <li>
                <span className="ai-flow-no">3</span>
                <b>返ってきた数行を貼る</b>
                <button className="primary-action" onClick={() => onGoToShape('paste')}>
                  貼る場所を開く
                </button>
                <span>
                  ［本のかたちを決める］の「印刷所の決まり」にある箱が開きます。返ってきた数行を貼って
                  <b>［欄に入れる］</b>を押すと、スタジオに<b>何がいくつに変わったか</b>が表示されます（Ctrl+Z で元に戻せます）
                </span>
              </li>
            </ol>
          )}
          <p className="hint">AI は数字を読み違えることがあるので、入稿前にガイドと見比べてください</p>
        </section>
      )}

      {/* くわしい話はこの4枚の扉の中。読む・読まないは利用者が決める。
          **必読は先頭で別格**(札と枠。2026-09-02 / 09-04 ユーザー指摘) */}
      <h2 className="ai-doors-title">くわしく読む</h2>
      <div className="ai-more">
        {/* 塗りのボタンにすると4つとも主役に見える。読み物なので細い枠(ghost)にそろえ、
            必読だけ濃い縁と札で別格にする */}
        <button className="ghost ai-more-must" onClick={() => setOpen('must')}>
          <span className="ai-badge">必読</span>
          AI にデータを壊されないために
        </button>
        <button className="ghost" onClick={() => setOpen('prompts')}>
          頼み方の文例（{PROMPTS.length}）
        </button>
        <button className="ghost" onClick={() => setOpen('demo')}>
          使える飾りのルール（{NOTATION.length}）
        </button>
        <button className="ghost" onClick={() => setOpen('cant')}>
          頼む前に：スタジオで出せないもの
        </button>
      </div>

      {/* 底のかくれカエル。受け渡し場所の番人 */}
      <div className="frog-sit" aria-hidden="true">
        <FrogPeek width={44} mood="wink" />
      </div>

      {open === 'demo' && <NotationDemo onClose={close} onDownload={downloadNotation} />}
      {open === 'prompts' && <PromptsPanel onClose={close} onDownload={downloadPrompts} />}

      {open === 'must' && (
        <DoorPanel label="AI にデータを壊されないために" onClose={close}>
          <h2>AI にデータを壊されないために</h2>
          {/* 「この扉が何を紹介しているのか」を先に言う(2026-09-04 ユーザー指摘
              「コミュニケーションが足りていない」)。順番は
              1. JSON に注意書きを入れてあるという事実 → 2. でも読み飛ばされる →
              3. だから守らせる一言 → 4. 中身の4つ。
              JSON の先頭の注意(file.ts の GUIDE_FOR_AI)とここは同じ内容の二本立て —
              あちらは AI に読ませる文、こちらは利用者に読ませる文。両方要る */}
          <p className="about-lede">
            ［AI用に書き出す］で作る JSON の先頭には、
            <b>本のデータを壊さないための注意書きを、こちらで最初から入れてあります</b>。
            あなたが約束ごとをぜんぶ覚える必要はありません。
            ただ、AI は言われないと<b>ファイルの説明を読み飛ばすことがあります</b>。
          </p>
          <p className="ai-note">
            だから、頼むときにこの一言を添えてください。
            <br />
            <b>「ファイルの先頭の説明を読んでから直しはじめてください」</b>
          </p>
          <p className="hint">AI用に書き出した JSON の先頭に書いてあるのは、次の4つです</p>
          <ul className="help-list">
            <li>
              <b>頼んでいない箇所は1文字も変えないこと。</b>
              これを言わないと、AI は親切のつもりで文体まで直します
            </li>
            <li>
              <b>全角スペースを半角に変えないこと。</b>
              日本語の組版では字間そのもので、変わると紙面が崩れます
            </li>
            <li>
              <b>
                <code>#img</code> で始まる値はそのまま残すこと。
              </b>
              壊れているのではなく、画像の目印です
            </li>
            <li>
              <b>章を増減したら、章ごとの設定の番号も振り直すこと。</b>
              背景や文字色は「何番目の章か」で紐づいています
            </li>
          </ul>
          <p className="hint">うまく伝わらないときは、この4つをそのままコピーして貼ってください</p>
          <p className="ai-note">
            <b>ファイルを直接さわれる AI なら。</b>
            Claude Code のようにパソコンのファイルを読み書きできる相手には、画面の上の
            <b>［保存する］</b>で作った<b>画像込みのほう</b>を渡して構いません。
            画像まで含めて扱えるので、チャットの AI には頼めない
            <b>挿絵の差し替えや追加</b>まで頼めます（手元の画像ファイルを渡して
            「この画像を第二章の前に入れて」のように）。
            なお、画像を入れるだけならスタジオの<b>［挿絵］</b>でもできます。
          </p>
        </DoorPanel>
      )}

      {open === 'cant' && (
        <DoorPanel label="スタジオが組めないもの" onClose={close}>
          <h2>スタジオが組めないもの</h2>
          {/* 「できないこと」だけだと「AI に頼めばできるのか？」と読めてしまう。
              **主語をスタジオにして、頼んでも紙に出ないと言い切る**(2026-08-19) */}
          <p className="about-lede">
            次のことは<b>スタジオの組版では対応していません</b>。
            AI に頼んで書かせても<b>紙面には出ません</b>。
          </p>
          <ul className="help-list">
            {/* 「本全体でひとつ」は嘘だった(2026-09-04 ユーザー指摘)。
                chapterFont / chapterFontPt で章ごとにも変えられる */}
            <li>
              <b>行の途中だけ書体・大きさを変えることはできません。</b>
              変えられるのは<b>本全体・章ごと・コラムページの単位</b>です
              （本全体と章ごとは画面下の帯で。コラムページはさらに<b>組み方向</b>まで
              別にできます——［本文に画像とコラムを入れる］で作れます）。
            </li>
            <li>
              <b>行の途中だけ色を変えることもできません。</b>
              ただし<b>本文・章見出し・小見出し</b>は、それぞれ色を変えられます。
              <b>章ごとに変えることもできます</b>（画面下の帯の［文字の色］）。
            </li>
            <li>
              <b>画像を作ることはできません。</b>
              このスタジオは AI ではないので、画像を生成する機能はありません。
              画像はご自分で用意するか、<b>同梱の画像</b>からお選びいただくか、
              下の BOOTH でお求めいただけます。
            </li>
          </ul>
          <a className="shop-link" href={BOOTH_SHOP_URL} target="_blank" rel="noopener noreferrer">
            {SHOP_PACKS_LABEL}
          </a>
          <p className="hint">
            場面やテーマ別の画像を数百点そろえています。買った画像は
            ［本文に画像とコラムを入れる］の<b>［画像を選ぶ］</b>から読み込めます
          </p>
        </DoorPanel>
      )}
    </>
  );
}
