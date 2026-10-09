// プロジェクトのデータ型と判型プリセット。
// 既定値の根拠は docs/typesetting-rules.md v0.2(§1.3 判型別既定値)。

import { EDITION } from '../edition';
import { bleedSidesText, fmtMm, type Bleed4 } from './bleedText';

// 塗り足しの形と文は、版の部品からも使うので葉のモジュール(./bleedText)に置いてある。ここからも同じ名前で書き出す
export { bleedSidesText, fmtMm };
export type { Bleed4 };

export type WritingMode = 'vertical' | 'horizontal';
export type ThemeId = 'novel-serif' | 'practical-gothic';

/**
 * 本文の刷り色。KDP では入稿時に「インクと用紙のタイプ」を選ぶ。
 * 白黒で刷るなら、絵も背景もグレーになって出てくる。
 * 選んだとおりにプレビューとPDFを見せて、入稿前に確かめられるようにする。
 */
export type InkColor = 'mono' | 'color';

// 印刷費の高い安いは書かない。価格が変わるたびに直さないと嘘になる(2026-08-16 ユーザー指摘)。
// ここに書くのは、選んだ結果として**刷り上がりがどうなるか**だけにする
export const INK_COLORS: Record<InkColor, { label: string; hint: string }> = {
  mono: {
    label: '白黒',
    hint: '小説・読み物向け。画像も背景もグレーで刷られます',
  },
  color: {
    label: 'カラー',
    hint: 'ZINE・作品集向け。画像をそのまま出せます',
  },
};

/**
 * 場面転換(原稿の `---` の行)の見た目。
 *
 * > 結構太いけど、まあいいのかな。2段組みだとちょうどよく見えるんだけど、
 * > 1段組みだと、「これは何の線だあ？」となるデザインですね。
 * > 話の区切りであることを示しているのは分かったんだけど、
 * > もうちょっと不自然さを減らせないだろうか(2026-08-21 ユーザー・文庫サンプル P14)
 *
 * **見立ては正しかった。** 一般文芸・純文学の商業出版で場面転換に使うのは
 * **1行アキだけ**が主流で、記号すら置かない(「余白以外は認めない」という考え方も根強い)。
 * 記号を使う場合は「＊」「◇」「※」を行の中央に1つ、または3つ並べる。
 * **`-----` のような罫は、ネット小説・ライトノベル寄りの記法。**
 * つまりこのスタジオは、文庫の小説を組みながらネット小説の記法で出していた。
 *
 * 出版社ごとのスタイルガイドで統一されるものなので、**本1冊にひとつ**持つ。
 * 章ごとには持たせない(同じ本の中で場面転換の印が変わる本は無い)。
 */
export type SceneBreakId = 'blank' | 'star' | 'stars' | 'rule';

/**
 * 選択肢。**説明文は持たない。**(このリポジトリの方針「画面には手順だけ」)
 * 名前そのものが刷り上がりなので、読めばどうなるか分かる。
 *
 * `mark` は紙・EPUB に置く字。空なら字を置かない(1行アキ・罫)
 */
export const SCENE_BREAKS: Record<SceneBreakId, { label: string; mark: string }> = {
  blank: { label: '1行アキ', mark: '' },
  star: { label: '＊', mark: '＊' },
  stars: { label: '＊　＊　＊', mark: '＊　＊　＊' },
  rule: { label: '罫', mark: '' },
};

/**
 * 新しく作る本の既定。**「1行アキ」に置く。**
 *
 * **保存済みの本はここに従わない。** 既定を変えても、いま罫で出ている本が
 * 開いた瞬間に見た目を変えてはいけないので、項目を持たない古い保存は
 * migrateSceneBreak が 'rule' に倒す。決め手は**組み直しが起きること** —
 * 罫は前後のアキ込みで2行を占め、1行アキは1行しか占めない
 * (実測: 文庫9pt で 46.50pt → 31.00pt)。切れ目より後ろの行が1行ずつ動くので、
 * 場面転換の多い本では総ページ数・ノンブル・目次・背幅まで変わりうる
 * (サンプル「青い背表紙」は切れ目が1つだけなので 39ページのまま動かなかった)。
 * **開いただけで刷り上がりが変わる**のは、入稿を済ませた人には事故になる。
 * 見た目を変えたい人は帯で1回選べば済むが、勝手に変わったものを元へ戻すには
 * 「前はどうだったか」を知っている必要がある。分からなくなるほうを避ける
 */
export const DEFAULT_SCENE_BREAK: SceneBreakId = 'blank';

/** いま何で組むか。**紙・EPUB・Word・画面で同じ答えを使うための1か所** */
export function sceneBreakOf(s: { sceneBreak?: SceneBreakId }): SceneBreakId {
  const v = s.sceneBreak;
  return v && v in SCENE_BREAKS ? v : DEFAULT_SCENE_BREAK;
}

/**
 * 項目を持たない保存データの引き受け先。
 *
 * **未指定 = この設定より前に保存された本**なので、そのころの見た目(罫)を明示して返す。
 * 既定値とのマージだけでは、キーが無い保存データに新しい既定('1行アキ')が入ってしまい、
 * **開いた瞬間に組み直される**(理由は DEFAULT_SCENE_BREAK)。
 *
 * 通る道は2つあり、**どちらにも要る**:
 *   - 前回の続きを開く … store/useProject.ts の hydrate → migrateBgSettings が呼ぶ
 *   - .json を読み込む … project/file.ts の sanitize が呼ぶ
 */
export function migrateSceneBreak(saved: Record<string, unknown>): SceneBreakId | undefined {
  return saved.sceneBreak === undefined ? 'rule' : undefined;
}

/** 見出し・柱・ノンブルに使う書体。本文が何であれ固定(rules §0-5「書体は2つまで」) */
export const HEADING_FONT_STACK = '"Noto Sans JP", "Yu Gothic", "游ゴシック", sans-serif';

/**
 * 本文に使える書体。すべて SIL Open Font License 1.1 か Apache-2.0 で、
 * PDF への埋め込み・商用利用・同梱再配布ができる。
 *
 * group はUIの並び。「装飾」は1冊まるごとの本文には向かないが、
 * ZINE や短い本で使いたい人がいるので出す(UI側で注意書きを添える)。
 * bold は太字(<em>)に使うウェイト。その書体が持っている値を入れる。
 */
export const BODY_FONTS = {
  serif: {
    label: '明朝（Noto Serif JP）', group: '明朝', bold: 700,
    stack: '"Noto Serif JP", "Yu Mincho", "游明朝", serif',
  },
  koburi: {
    label: '源暎こぶり明朝｜縦組み小説', group: '明朝', bold: 700,
    stack: '"GenEi Koburi Mincho v6", "Noto Serif JP", serif',
  },
  shippori: {
    label: 'しっぽり明朝｜文芸・和', group: '明朝', bold: 700,
    stack: '"Shippori Mincho", "Noto Serif JP", serif',
  },
  zenOld: {
    label: 'Zen 旧明朝｜格調・古典', group: '明朝', bold: 700,
    stack: '"Zen Old Mincho", "Noto Serif JP", serif',
  },
  bizMincho: {
    label: 'BIZ UD明朝｜読みやすさ重視', group: '明朝', bold: 700,
    stack: '"BIZ UDMincho", "Noto Serif JP", serif',
  },
  kaisei: {
    label: '解星オプティ｜やわらかい明朝', group: '明朝', bold: 700,
    stack: '"Kaisei Opti", "Noto Serif JP", serif',
  },
  klee: {
    label: 'Klee｜教科書体・エッセイ', group: '明朝', bold: 600,
    stack: '"Klee One", "Noto Serif JP", serif',
  },
  gothic: {
    label: 'ゴシック（Noto Sans JP）', group: 'ゴシック', bold: 700,
    stack: '"Noto Sans JP", "Yu Gothic", "游ゴシック", sans-serif',
  },
  bizGothic: {
    label: 'BIZ UDPゴシック｜読みやすさ重視', group: 'ゴシック', bold: 700,
    stack: '"BIZ UDPGothic", "Noto Sans JP", sans-serif',
  },
  zenKaku: {
    label: 'Zen 角ゴシック New', group: 'ゴシック', bold: 700,
    stack: '"Zen Kaku Gothic New", "Noto Sans JP", sans-serif',
  },
  plex: {
    label: 'IBM Plex Sans JP', group: 'ゴシック', bold: 700,
    stack: '"IBM Plex Sans JP", "Noto Sans JP", sans-serif',
  },
  zenMaru: {
    label: 'Zen 丸ゴシック｜日常・児童', group: '装飾', bold: 700,
    stack: '"Zen Maru Gothic", "Noto Sans JP", sans-serif',
  },
  yuji: {
    label: '佑字 肅｜筆書き', group: '装飾', bold: 400,
    stack: '"Yuji Syuku", "Noto Serif JP", serif',
  },
  dot: {
    label: 'ドット｜SF・ゲーム', group: '装飾', bold: 400,
    stack: '"DotGothic16", monospace',
  },
  reggae: {
    label: 'Reggae One｜ポップ', group: '装飾', bold: 400,
    stack: '"Reggae One", "Noto Sans JP", sans-serif',
  },
} as const;
export type BodyFontId = keyof typeof BODY_FONTS;

/**
 * 縦中横(.tcy)の中の数字・！？にだけ当てる書体列。
 * 先頭は scripts/build-tcy-fonts.py が各書体から作る「詰め数字」`amayadori-tcy-<id>`、
 * そのあとに本文の書体列を続ける(詰め字に無い字が来ても本文の書体で出る)。
 * **なぜ要るか**はそのスクリプトの頭に(2桁の自然幅が 1.1em を超えると Chromium が
 * 横圧縮し、その経路で新しい Chrome の縦中横が右上へずれる。2026-09-14 ユーザー報告)
 */
export function tcyStack(id: BodyFontId): string {
  // 名は build-tcy-fonts.py の付け方と対。元の書体名を含めない(OFL の予約フォント名)
  return `"amayadori-tcy-${id}", ${(BODY_FONTS[id] ?? BODY_FONTS.serif).stack}`;
}

/** テーマを切り替えたときの既定の本文書体 */
export const THEME_BODY_FONT: Record<ThemeId, BodyFontId> = {
  'novel-serif': 'serif',
  'practical-gothic': 'gothic',
};

/**
 * EPUB に渡す書体の系統。
 * リフローでは書体を指定せず、明朝かゴシックかだけ伝える(rules §9)。
 * スタックの末尾に置いた総称ファミリーで判定する。
 */
export function bodyFontGeneric(id: BodyFontId): 'serif' | 'sans-serif' {
  const stack: string = BODY_FONTS[id]?.stack ?? '';
  return /,\s*serif$/.test(stack) ? 'serif' : 'sans-serif';
}
/** EPUB の出し先。表紙の入れ方が食い違うストアがあるので選ばせる */
export type EpubTarget = 'kdp' | 'reader';

export const EPUB_TARGETS: Record<EpubTarget, { label: string; hint: string }> = {
  kdp: {
    label: 'Amazon Kindle（KDP）',
    hint: '表紙は KDP の入稿画面でアップロードします。EPUB には表紙のページを入れません（入れると二重に出るか、変換に失敗します）',
  },
  reader: {
    // 楽天Kobo はまだ一度も試していないので、名前を出さない(2026-10-08 ユーザー)
    label: 'その他のお店',
    hint: 'EPUB の中に表紙のページを入れます。Google Play Books やファイルを直接配るときもこちらで大丈夫です',
  },
};

/**
 * 紙の出し先(刷ってもらう会社)。**会社ごとの決まりは、ここの1件にまとめて持つ。**
 *
 * KDP は「79ページより多い本にだけ背文字を刷る」「背の縁から 1.6mm 空ける」
 * 「表4の右下にバーコードを自動で刷る」を課している。どれも**KDP の数字**であって、
 * よその印刷所の数字ではない(2026-08-20 ユーザー指摘「KDP以外で印刷する場合は、
 * こんなに背文字が細くなる理由はなくなる」)。
 *
 * **会社が増えてもコードの `=== 'kdp'` を探して回らない。**(2026-09-23)
 * 出し先の会社を足すときに足すのはこの表の1件だけで済むよう、
 * 会社ごとに違う値をすべて PrintTargetProfile の欄として持ち、画面と組版はこの欄だけを見る。
 * 会社の出し先は版(src/edition の EDITION.printTargets)からも足せる。足した会社は「その他の印刷所」の前に並ぶ
 *
 * **紙面の組み方は、塗り足しとノドの下限だけ出し先で変わる。**(2026-10-01)
 * KDP は自分の決まり(塗り足し 3.2mm でノド側なし・ノドの下限は総ページ数の表)で固定。
 * 「その他の印刷所」は、利用者が入れた数字(PrintRules)で決まる。判型と文字の組みは出し先で変わらない
 *
 * 型は 'kdp' と 'printshop' に加えて、版が足した会社の id(文字列)も受ける。
 * **この版に無い id(別の版で保存した本)は、読み込むときに「その他の印刷所」へ切り替える**(project/file.ts の sanitize)
 */
export type PrintTarget = 'kdp' | 'printshop' | (string & {});

/**
 * 紙面の決まり(塗り足し・ノドの下限)を、だれが決めるか。(2026-10-02)
 * - `kdp` … KDP の決まり(塗り足し 3.2mm でノド側なし・ノドはページ数の表)。printRulesOf は null
 * - `user` … 利用者が入稿ガイドから写した数字(PrintRules)。「印刷所の決まり」の欄と、AI に調べてもらう箱が出る
 * - `fixed` … 会社が決めていて、利用者は変えられない(fixedPrintRules)。欄は出さず、決まりを短く見せるだけ
 */
export type RulesSource = 'kdp' | 'user' | 'fixed';

/**
 * 綴じ方。(2026-10-03 ユーザー「ZINE で使いたい人の大半が中綴じ雑誌形態を想定している。やらずには済ませられない」)
 * - `perfect` … 無線綴じ。背のあるふつうの本(いままでの作り。項目が無い本はこちら)
 * - `saddle`  … 中綴じ。紙を重ねて真ん中をホチキスで留める。薄い本・ZINE 向き。背は無く、ページ数は 4 の倍数
 */
export type Binding = 'perfect' | 'saddle';

/**
 * 中綴じの表紙の入れ方。
 * - `separate` … 別表紙。表紙だけ別の紙で巻く。表4と表1を背なしで直結した1枚を、本文とは別に出す(既定)
 * - `self`     … 共紙。表紙も本文と同じ紙。表1・表4 は本文 PDF の先頭と末尾のページになる
 */
export type SaddleCover = 'separate' | 'self';

/**
 * 出し先の、中綴じの決まり。**この欄を持つ出し先だけが、中綴じを選べる**(KDP は持たない)。
 */
export interface SaddleSpec {
  /** ノドの下限(mm。片側)。中綴じは根元まで開くので、無線(15mm)より小さい */
  gutterMinMm: number;
  /** 総ページ数の上限(標準の用紙)。決まりが無ければ null */
  maxPages: number | null;
  /** いちばん薄い本文用紙のときの上限。決まりが無ければ null */
  maxPagesThinPaper: number | null;
  /** 綴じる辺(判型の高さ)の目安の下限(mm)。決まりが無ければ null */
  minBindEdgeMm: number | null;
  /** 中綴じの表紙用紙(別表紙のときの、出し先の決まり。控えに出す。例「◯◯紙のみ」) */
  coverPaperNote?: string;
}

export interface PrintTargetProfile {
  /** 選ぶボタンの名前 */
  label: string;
  /** 選んだときに下へ出す一言(背文字の決まり) */
  hint: string;
  /**
   * 背の縁から空けるアキ(mm)。**会社が決めているならその値で固定**する。
   * 省くと、利用者が［本のかたちを決める］の「印刷所の決まり」にある［背の縁のアキ］で決める(spineInsetMm)
   */
  fixedSpineInsetMm?: number;
  /** 背文字を刷ってよい最少ページ数(会社の規定)。規定が無ければ省く(背幅だけで決まる) */
  spineTextMinPages?: number;
  /**
   * 本文のページ数の下限。**KDP のペーパーバックは24ページから**(2026-09-25 見直し S2-2)。
   * 決めていない会社は持たない。下回っても書き出しは止めず、入稿前チェックで言う
   */
  minPages?: number;
  /**
   * 表4の右下に空けておくバーコードの場所(mm)。**会社が自動で刷るときだけ**持つ。
   * 省いた会社では、あらすじが表4の下端まで使える
   */
  barcodeMm?: { w: number; h: number };
  /** 入稿の控え(［完成データを書き出す］の右の欄)の見出しと前置き */
  specsTitle: string;
  specsLead: string;
  /** 控えの「刷り色と用紙」の項目名。会社の入稿画面の呼び名に寄せる */
  inkPaperLabel: string;
  /**
   * 紙の本文 PDF を渡すときの、裁ち落とし(塗り足し)の伝え方。
   * **塗り足しの数字は直書きせず、いま効いている4つの値(bleedOf)を受けて文を作る**
   * (2026-10-01。印刷所は利用者が入れた幅で言う。KDP の文は数字を含まないので値を見ない)
   */
  bleedNote: (b: Bleed4) => string;
  /**
   * インクの総量の上限(%。4色ベタで 400)。入稿用の PDF へ変換するとき(src/press)の
   * 目標。KDP も印刷所も 300(2026-10-01 利用者と決めた。画面には出さない)
   */
  inkLimitPct: number;
  /**
   * 保存した PDF(RGB)を、そのまま受け付けるか。**受け付けない会社には、入稿用(白黒は K1色・カラーは CMYK。
   * どちらも PDF/X-4)への変換を、書き出しの画面に出す**(2026-10-01)。KDP は RGB のまま受け付ける。
   * 「その他の印刷所」は、RGB を受け付けない印刷所が多いので、受け付けない側に倒す
   */
  acceptsRgbPdf: boolean;
  /**
   * 文の中で入稿先を呼ぶ名前(「①の PDF は○○に入稿できない」)。省くと「印刷所」。
   * 「その他の印刷所」を文に差し込むと不自然なので、ボタンの名前(label)とは分けた(2026-10-07)
   */
  pressName?: string;
  /**
   * RGB の PDF を受け付ける会社のうち、**白黒の本だけ**、入稿用(K1色)への変換を任意の道として出すか(2026-10-02。
   * KDP の白黒の本を K1色(グレー)で入稿して RGB と比べたい、という利用者の試し)。
   * 受け付けない会社(acceptsRgbPdf が false)は、いつも出すので、この欄は見ない。カラーの本には出さない
   */
  offersGrayForMono?: boolean;
  /**
   * 入稿用へ変換するとき、**グレーの濃さの直し**(src/press/grayTone.ts)をするか。
   * 直しはオフセット印刷のドットゲインを見込んだ判断なので、トナー機の KDP では直さない。省くと直す
   */
  fixesGrayTone?: boolean;
  /**
   * 生成AIで作った中身の申告を、その会社の入稿画面で求められるか。
   * 求められるなら、何と答えるかを控えに出す
   */
  asksAiDeclaration: boolean;
  /** 紙面の決まりをだれが決めるか。**画面と組版は出し先の名前ではなく、この欄で分ける**(2026-10-02) */
  rulesSource: RulesSource;
  /** rulesSource が fixed の会社の決まり(利用者は変えられない) */
  fixedPrintRules?: PrintRules;
  /** fixed の決まりの出典。画面で決まりを短く見せるときに添える */
  fixedRulesSource?: string;
  /**
   * 背幅を、会社(印刷所)が知らせる数字で決めるか。決めるなら、［本のかたちを決める］に数字の欄を出し、
   * 入っていないあいだは KDP の紙の厚みで出した目安で、入稿前チェックが入れるよう促す
   */
  asksPrinterSpine: boolean;
  /** この会社が受け付けない判型。選べなくする。すでにその判型の本は、黙って変えず、入稿前チェックで言う */
  unsupportedTrims?: TrimId[];
  /**
   * 中綴じの決まり。**欄を持つ出し先だけが、中綴じを選べる**(bindingOf)。KDP は中綴じが無いので持たない
   * (綴じ方を選んでいる本を KDP に切り替えても、選びは消さない。KDP のあいだは無線として組む)
   */
  saddle?: SaddleSpec;
  /**
   * 絵の細かさの目安(ppi。実寸で何画素あるか)。画面の表示と、足りない絵を知らせる基準に使う
   * (models/imageResolution.ts。知らせるだけで止めない)。表紙の書き出しの細かさもこれに合わせる
   */
  imagePpi: number;
  /** 判型の欄のとなりなどに添える、受け付ける判型の説明。決まりのある会社だけ */
  trimNote?: string;
  /**
   * 控えの項目名を、会社の発注の画面の呼び名に寄せる(省くと「判型（トリムサイズ）」「ページ数」)。
   * `binding` を持つ会社は、控えに「綴じ方」の行を足す(無線綴じか中綴じか。ProjectSettings.binding)
   */
  specLabels?: { trim?: string; pages?: string; binding?: string; direction?: string };
  /**
   * 表紙を書き出す細かさ(ppi)。**表紙は文字ごと1枚の画像**なので、文字の輪郭のためにこれで書き出す。
   * 省くと imagePpi。表紙に置く写真が足りているかの知らせは、これではなく imagePpi で見る
   */
  coverPpi?: number;
  /**
   * 背文字を刷ってよい背幅の下限(mm。会社の規定)。規定が無ければ省く(読める大きさになるかだけで決まる)
   */
  spineTextMinMm?: number;
  /**
   * 仕上がりの端から、ノンブル・柱の字の下端(上端)まで空ける距離(mm。会社の規定の安全域)。
   * 省くと KDP の 0.25インチ(6.4mm)。決まりがここまで届かない「その他の印刷所」も、安全なほうの 6.4mm に倒す
   */
  safeAreaMm?: number;
  /**
   * 背幅の目安を出すための、会社の本文用紙と表紙用紙の一覧。**持つ会社では［本のかたちを決める］の用紙の欄が
   * この一覧になり**、背幅の目安は 本文ページ数 ÷ 2 × 本文用紙の厚さ ＋ 表紙用紙の厚さ × 2(会社の式)になる。
   * 省いた会社は KDP の紙の厚み(PAPER_TYPES)で目安を出す。先頭が既定
   */
  papers?: { body: PrinterPaper[]; cover: PrinterPaper[]; text: PapersText };
  /** 変換したカラーの本文で、カラーのページの一覧の下に添える一言。省くと「見積りで聞かれたときに使えます」 */
  colorPagesNote?: string;
  /**
   * 入稿が2回に分かれる会社(先に本文を送ると背幅が届き、それから表紙を作る)の、表紙の書き出しに添える一言。
   * 背幅が目安のままのときだけ出す
   */
  coverAfterSpineNote?: string;
}

/**
 * 用紙の一覧を持つ会社の、画面の文。(2026-10-10)
 * 何に書く用紙か・背幅の確定値がいつ届くかは会社ごとの手順なので、共通の画面には書かず、会社の側に持たせる
 */
export interface PapersText {
  /** 用紙の欄の下の説明(無線綴じ)。[前, 太字にする所, 後] */
  hint: readonly [string, string, string];
  /** 用紙の欄の下の説明(中綴じ) */
  hintSaddle: string;
  /** 背幅の欄の説明で「空欄のときは、選んだ用紙から計算した目安(…)を使います。」に続ける文 */
  spineAfter: string;
  /** 入稿前チェック: 背幅が、用紙から出した目安のまま */
  spineFinding: string;
}

/** 会社の用紙。背幅の目安を出すのに使う */
export interface PrinterPaper {
  id: string;
  /** 注文のときに書く名前(銘柄と斤量) */
  label: string;
  /** 選ぶ欄に添える一言(色味など) */
  note?: string;
  /** 1枚の厚さ(mm) */
  mm: number;
}

export const PRINT_TARGETS: Record<PrintTarget, PrintTargetProfile> = {
  kdp: {
    label: 'Amazon KDP',
    hint: '背に文字を刷れるのは80ページから。背の縁から 1.6mm ずつ空けます（KDP の規定。詰めると綴じのブレで文字が表紙側へ回り込み、入稿が却下されます）',
    fixedSpineInsetMm: 1.6,
    spineTextMinPages: 80,
    minPages: 24,
    // KDP がバーコードを自動で刷る場所。2 × 1.2 インチを丸めて取っている(cover/render.ts)
    barcodeMm: { w: 50, h: 30 },
    specsTitle: 'KDP の入稿画面で選ぶ値',
    specsLead: 'Amazon KDP に入稿するとき、あちらの画面で自分で選ぶ値です。ここを見ながら写してください（間違えるとエラーになります）。',
    inkPaperLabel: 'インクと用紙のタイプ',
    bleedNote: () =>
      'あとで KDP の入稿画面で判型を設定するときに「裁ち落とし（ブリード）あり」を選んでください（いま出ている印刷ダイアログに、この項目はありません）。この PDF は塗り足し込みの寸法です',
    inkLimitPct: 300,
    acceptsRgbPdf: true,
    offersGrayForMono: true,
    fixesGrayTone: false,
    asksAiDeclaration: true,
    rulesSource: 'kdp',
    asksPrinterSpine: false,
    imagePpi: 300,
  },
  // 並びは［作るもの］のボタンの順。「その他の印刷所」は最後に置く(名前のある会社のあいだに挟まると見落とす。2026-10-03)
  ...EDITION.printTargets,
  printshop: {
    label: 'その他の印刷所',
    hint: 'ページ数の下限はありません。塗り足し・ノドの下限・背の縁のアキは、入稿する印刷所のガイドに書いてある数字を、［本のかたちを決める］の「印刷所の決まり」に入れてください。表4にバーコードの場所は空けません',
    specsTitle: '印刷所に伝える値',
    specsLead: '印刷所に入稿するとき、注文や入稿の画面で伝える値です。項目の呼び名は印刷所によって違うので、ガイドと照らし合わせてください。',
    inkPaperLabel: '刷り色と本文用紙',
    bleedNote: (b) =>
      bleedSidesText(b) === '付けない'
        ? 'この PDF は塗り足しを付けない寸法（仕上がりと同じ大きさ）です。印刷所の指定する塗り足しと違うときは、入稿の前に印刷所に確かめてください'
        : `この PDF は塗り足し込み（仕上がりの外側に、${bleedSidesText(b)}）の寸法です。印刷所の指定する塗り足しと違うときは、入稿の前に印刷所に確かめてください`,
    inkLimitPct: 300,
    acceptsRgbPdf: false,
    asksAiDeclaration: false,
    rulesSource: 'user',
    asksPrinterSpine: true,
    // 数字は、よくある入稿ガイドの値を初期値にする(印刷所ごとに違うので、欄から直せるようにするのは後。2026-10-03)
    saddle: { gutterMinMm: 10, maxPages: 48, maxPagesThinPaper: 60, minBindEdgeMm: 150 },
    imagePpi: 300,
  },
};

/** 背の縁のアキ(mm)。決めている会社はその値、決めていない会社は利用者の指定 */
export function spineInsetOf(target: PrintTarget, spineInsetMm: number): number {
  return PRINT_TARGETS[target]?.fixedSpineInsetMm ?? Math.max(0, spineInsetMm);
}

/**
 * **作るもの。** 紙の本・電子書籍のどちらを作るか(両方でもよい)。
 *
 * 画面に出すものを絞るためだけに使う(2026-09-23 ユーザー要望「自分に該当するものだけしか
 * 出てこない」「自分が今必要としているものだけしか見えない」)。
 * **組版も書き出しの中身も変えない** — 作らない側の設定は消さずに残し、
 * 選び直せば元どおり出てくる。項目の無い古いファイルは両方(いままでの見え方)
 */
export function outputsOf(s: Pick<ProjectSettings, 'makePaper' | 'makeEbook'>): {
  paper: boolean;
  ebook: boolean;
} {
  const paper = s.makePaper !== false;
  const ebook = s.makeEbook !== false;
  // 両方「作らない」は成り立たないので、両方作る扱いに戻す(画面でも選べないようにしてある)
  return paper || ebook ? { paper, ebook } : { paper: true, ebook: true };
}

/**
 * ノンブル(ページ番号)と柱(章題)を余白のどこに刷るか。
 *
 * **左右ではなく「ノド／小口」で持つ。** 見開きの本は表と裏で左右が入れ替わるので、
 * 左右で持つと裏のページだけ位置がずれる。刷るときに :recto / :verso へ振り分ける。
 *
 * `@bottom-center` に柱を置くのは**このアプリの既定であって決まりではない**。
 * 日本語の本では柱もノンブルも地に置くのが定番(柱=地の中央 / ノンブル=地の小口寄り)だが、
 * 柱を天に置く本もふつうにある(2026-08-19 ユーザーの問いへの答え)。
 * CSS のマージンボックスは16か所あり、Vivliostyle も全部実装している(実測)
 */
export type MarginSlot =
  | 'none'
  | 'top-gutter'
  | 'top-center'
  | 'top-fore'
  | 'bottom-gutter'
  | 'bottom-center'
  | 'bottom-fore';

export const MARGIN_SLOTS: { id: MarginSlot; label: string }[] = [
  { id: 'top-gutter', label: '天・ノド寄り' },
  { id: 'top-center', label: '天・中央' },
  { id: 'top-fore', label: '天・小口寄り' },
  { id: 'bottom-gutter', label: '地・ノド寄り' },
  { id: 'bottom-center', label: '地・中央' },
  { id: 'bottom-fore', label: '地・小口寄り' },
  { id: 'none', label: '入れない' },
];

export type TrimId = 'bunko' | 'shinsho' | 'b6' | 'shirokuban' | 'a5' | 'b5' | 'a4';

export interface TrimSize {
  id: TrimId;
  label: string;
  /** 仕上がり寸法 mm */
  w: number;
  h: number;
}

export const TRIM_SIZES: Record<TrimId, TrimSize> = {
  bunko: { id: 'bunko', label: '文庫（A6） 105×148', w: 105, h: 148 },
  shinsho: { id: 'shinsho', label: '新書 103×182', w: 103, h: 182 },
  b6: { id: 'b6', label: 'B6 128×182', w: 128, h: 182 },
  shirokuban: { id: 'shirokuban', label: '四六判 127×188', w: 127, h: 188 },
  a5: { id: 'a5', label: 'A5 148×210', w: 148, h: 210 },
  b5: { id: 'b5', label: 'B5 182×257', w: 182, h: 257 },
  a4: { id: 'a4', label: 'A4 210×297', w: 210, h: 297 },
};

/**
 * 挿絵ページ(章と章の間に挟む1枚絵)。
 * 章の途中に置く絵(本文の画像ブロック)とは別で、原稿を取り込んだあとにスタジオで足す。
 * ページ番号ではなく「何章の前か」で位置を持つので、本文を組み直しても差し込み位置がずれない。
 */
/**
 * `print` = 版面いっぱい(2026-09-30 追加)。**文字の入った図表のための大きさ。**
 * KDP は絵の中に描かれた文字も検出し、版面(余白の内側)から外に出ていると印刷できない
 * (ユーザーの知見)。「余白すこし」は仕上がりの外周4%(B6 で 5mm)しか空けないので、
 * 図表の端の文字が KDP の余白の下限(小口 6.4mm・ノド 9.6mm 以上)を割る。
 * この大きさは本文と同じ余白の中に絵を収めるので、絵の端まで文字があっても余白に出ない
 */
/**
 * `spread` = 見開き(2ページ)(2026-10-03 追加)。**1枚の横長の絵を、向かい合う2ページに分けて入れる。**
 * 「章の切れ目の絵ページ」(Plate)だけの大きさで、章の途中の絵(ImageBlock)には無い。
 * 必ず偶数ページから始まる(組版が `break-before: verso` で、合わないときは白いページを1枚入れる)。
 * 切り出し・塗り足しの重ね方は typeset/spread.ts
 */
export type PlateSize = 'full' | 'wide' | 'narrow' | 'print' | 'spread';

export const PLATE_SIZES: Record<PlateSize, { label: string; hint: string }> = {
  full: { label: '全面', hint: '紙の端まで。断裁で外周が少し切れます' },
  wide: { label: '余白すこし', hint: '仕上がりの外周4%を空けて収めます' },
  narrow: { label: '余白おおめ', hint: '仕上がりの外周20%を空けて収めます' },
  print: {
    label: '版面いっぱい',
    hint: '本文と同じ余白の内側に収めます。文字の入った図表はこれに（余白に文字が出ると KDP で刷れません）',
  },
  spread: {
    label: '見開き（2ページ）',
    hint: '横長の1枚の画像を、向かい合う2ページにまたがって入れます。紙の端まで画像にします。断裁で外周が少し切れます',
  },
};

/** 奥付・著者紹介の見た目。省略した項目は本文の設定を継ぐ */
export interface MatterType {
  bodyFont?: BodyFontId;
  /** 文字サイズ(pt)。省略なら本文の0.9倍 */
  fontPt?: number;
  /** 行送り(pt)。省略なら本文と同じ */
  lineFeedPt?: number;
  color?: string;
  /**
   * **見出しだけの指定。省略すると本文に合わせて動く。**
   * 奥付の見出しは書名、著者紹介の見出しは「著者紹介」の行。
   *
   * headingPt を入れると本文から切り離せる。入れないあいだは
   * 本文のサイズに決まった倍率を掛けた大きさで付いてくる
   * (2026-08-19 ユーザー指摘「本文はどうやっていじったら」)
   */
  headingFont?: BodyFontId;
  headingPt?: number;
  headingColor?: string;
}

export interface Plate {
  id: string;
  /** data URI */
  src: string;
  /**
   * この章の「前」に挟む。章数と同じ値なら本文の最後(あとがきの前)。
   * つまり実質は「ひとつ前の章の末尾」。
   *
   * 章の切れ目に置くものは、この形で持つ。章はもともと改ページ起こしなので、
   * そこに1枚挟んでも本文の流れが一切動かない。
   * **章の途中に置く絵は、この形ではなく本文の画像ブロック(ImageBlock)で持つ**
   * (2026-09-23)。位置を「どの段落のあとか」で持てるのは原稿の並びの側だけなので。
   */
  beforeChapter: number;
  size: PlateSize;
  /** 同梱のプリセットから選んだ絵か(BgSpec.fromPreset と同じ用途) */
  fromPreset?: boolean;
  /**
   * **この絵の中の文字は、版面の外に出ていてよい**(利用者がそう言った。2026-10-02)。
   * 絵の中の文字が版面(余白の内側)の外に出ていると知らせる検査(src/textcheck)を、この絵では止める。
   * 文字ではない模様を文字と見たとき・分かったうえでそのまま出すときのための逃げ道。絵を差し替えたら消す
   */
  textOk?: boolean;
  /**
   * 絵を置かない、**わざと空けた1ページ**。src は空になる。
   *
   * 章は奇数ページ起こしなので、挿絵を1枚だけ挟むと白ページが1枚できる。
   * 以前は組版側が黙って位置を調整していたが、黙ってページが増えるのは説明できない。
   * 白ページを自分で置けるようにして、[空白][絵] のように**組み合わせを選べる**ようにした
   * (2026-08-17 ユーザー判断)
   */
  blank?: boolean;
  /**
   * 同じ切れ目に何枚も挟んだときの並び順。**挿絵とコラムで共通の物差し。**
   *
   * 組版は「挿絵 → コラム」の順で出していたので、同じ切れ目にある挿絵とコラムを
   * ひっくり返せなかった(2026-08-20 ユーザー指摘「P15,P16は章末にあるから
   * ひっくり返せるのでは？と思ったけど移動ができない」)。
   * 小さい順に並べ、**無指定は末尾**(足したばかりのものが後ろに付く)
   */
  order?: number;
}

/**
 * コラムページ(章と章の間に挟む、本文と組み方向の違う1ページ)。
 *
 * **章ごとの組み方向は持てないが、1ページに収まるものなら組める。**
 * Vivliostyle はページを割る軸をルートの組み方向だけで決めているので、
 * 縦組みの本に横組みの章を混ぜると改ページが起きず本文が紙からはみ出す
 * (実測 9083px。詳しくは ProjectSettings の chapterSubheadingColor の下)。
 * ただし奥付は縦組みの本でも横組みで出せている。**版面の実寸を width と height の
 * 両方で与えて、1ページに収めているから**。コラムページも同じ作り方にしてある
 * (typeset/css.ts の section.colpage)。
 *
 * そのぶん**あふれたら紙から落ちる**ので、画面側で先に字数を警告する
 * (typeset/grid.ts の fitColumnPage)。
 *
 * 位置の持ち方は Plate と同じで「何章の前か」。章の切れ目にしか置けないのも同じ理由
 * (章はもともと改ページ起こしなので、1ページ挟んでも本文の流れが動かない)。
 */
export interface ColumnPage {
  id: string;
  /** 見出し。空でもよい */
  title: string;
  /** 本文。空行で段落を分ける */
  text: string;
  /** Plate と同じ。この章の「前」に挟む */
  beforeChapter: number;
  /** 組み方向。省略すると本文と逆になる(それがこの機能の目的) */
  writingMode?: WritingMode;
  /**
   * このページだけの書体・文字サイズ・行送り。省略なら本文と同じ。
   *
   * **1ページに収める紙面なので、ここが入る字数を直に決める。**
   * 変えるのは帯(FormatBar)だけ。コラムのページを開くと帯がそのコラムに切り替わる。
   * 以前は編集欄の中にも置いていたが、帯と2か所にあると取り違える(帯が「本全体」のまま
   * 字の色を白にして本文が消えた)ので、2026-10-09 に編集欄から外した。
   * 入る行数の目安は編集欄に出るので、帯で変えた結果もそこで見える
   */
  bodyFont?: BodyFontId;
  fontPt?: number;
  lineFeedPt?: number;
  /** 文字の色。省略なら本文と同じ */
  color?: string;
  /**
   * 見出しだけの指定。省略すると本文に合わせて動く
   * (2026-08-19 ユーザー指摘「見出しと本文が一緒に大きくなったり小さくなったりしている」)
   */
  headingFont?: BodyFontId;
  headingPt?: number;
  headingColor?: string;
  /** 同じ切れ目での並び順。挿絵(Plate.order)と同じ物差しで並べる */
  order?: number;
  /**
   * このページだけの背景。**章ごとの背景(chapterBg)と同じ持ち方。**
   * 省略すると本文の背景をそのまま継ぐ。
   * コラムは本文と別ものの1ページなので、地も別にできて初めて独立した面になる
   * (2026-08-20 ユーザー要望)
   */
  bg?: BgSpec;
  /** 文字のフチ(em)と色。0 は「フチなし」という指定 */
  outline?: number;
  outlineColor?: string;
  /** 下に敷く帯の濃さ(0〜1)と色。0 は「帯なし」という指定 */
  plate?: number;
  plateColor?: string;
  /**
   * 文字の領域を版面の内側へ狭める余白(版面に対する片側の%)。
   * 額のような枠柄の地に文字を収めるための指定
   * (2026-09-11 ユーザー要望「画像に合わせて文字の幅を変えたい」)。
   * padXPct は左右、padYPct は天地。省略は 0(版面いっぱい)。
   * 「入る字数の目安」(typeset/grid.ts fitColumnPage)も同じ値で縮む
   */
  padXPct?: number;
  padYPct?: number;
}

/** そのコラムページの組み方向。無指定なら本文の逆 */
export function columnPageMode(c: ColumnPage, body: WritingMode): WritingMode {
  return c.writingMode ?? (body === 'vertical' ? 'horizontal' : 'vertical');
}

/**
 * 書名・著者名(表紙の表1と大扉)の向き。(2026-10-03)
 * 横組みの本はいつも横。縦組みの本は、titleWritingMode が省略なら本文に従って縦(いまどおり)
 */
export function titleWritingModeOf(s: { writingMode: WritingMode; titleWritingMode?: WritingMode }): WritingMode {
  return s.writingMode === 'vertical' ? (s.titleWritingMode ?? 'vertical') : 'horizontal';
}

/**
 * コラムページの本文を段落へ割る。
 *
 * **1行が1段落。空行は捨てる。** 本文の取り込み(importers/txt.ts)と同じ数え方だが、
 * 空行を「1行アキ」にはしない。1ページに収めきる紙面なので、
 * 見えないものに行を食わせない(あふれの計算も同じ数え方でそろえてある)。
 */
export function columnPageParagraphs(text: string): string[] {
  // **空行は「1行アキ」として残す**(2026-09-11 ユーザー要望
  // 「改行して行をあけたところが反映されない」)。以前は空行を捨てていた
  // (1ページに収める紙面で、見えない行に場所を食わせない設計)が、
  // 行アキを意図した空行が黙って消えるほうが不意打ちだった。
  // 返り値の '' が1行アキ。連続する空行は1つに畳み、先頭・末尾の空行は捨てる
  // (収まり計算 typeset/grid.ts と組版 typeset/html.ts も同じ数え方)
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((t) => t.replace(/^[　\s]+/, '').trimEnd());
  const out: string[] = [];
  for (const t of lines) {
    if (t === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(t);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * コラムページを Word へ出したときの見出しの頭に付けていた目印。
 *
 * **Word 書き出しは 2026-09-23 に撤去した**が、それまでに書き出した Word が
 * 利用者の手元に残っている。その Word を取り込んでもコラムが章として増えないよう、
 * 取り込む側(`importers/docx.ts`)はいまもこの字を見て読み飛ばす
 */
export const COLPAGE_MARK = '［コラム］';

/** 章の数が変わったとき、差し込みページをどう動かしたか */
export interface InsertFit {
  /** 巻末へ寄せた挿絵ページの数 */
  plates: number;
  /** 巻末へ寄せたコラムページの数 */
  columnPages: number;
  /** 章そのものが無くなったので効かなくなった、章ごとの指定の数 */
  chapterSettings: number;
  /** スタジオで章の途中に置いた絵のうち、同じ段落のあとへ付け直せた数 */
  imagesKept?: number;
  /** 付け直す段落が見つからず、その章の最後へ移した数 */
  imagesMoved?: number;
  /**
   * 章の並びが変わったので、**同じ章についていくよう**付け直した挿絵ページ・コラムページ・
   * 章ごとの指定の数(matchChapters。2026-09-25 見直し S1-6)
   */
  followed?: number;
}

/** 章ごとに持つ指定。**章が減ると行き場を失う**ので、数えて画面で言う */
const CHAPTER_KEYED = [
  'chapterBg',
  'chapterFont',
  'chapterFontPt',
  'chapterLineFeedPt',
  'chapterColumns',
  'chapterDropCap',
  'chapterTextColor',
  'chapterHeadingColor',
  'chapterSubheadingColor',
  'chapterPlate',
  'chapterPlateColor',
] as const;

/**
 * 差し込みページを、いまの章の数に収める。
 *
 * **挿絵もコラムも「何章の前か」でしか位置を持てない**(models の Plate / ColumnPage)。
 * 原稿を取り込み直すと章の数が変わるので、範囲の外へ出たものは
 * **組版から黙って消える**(組版は 0〜章数 の切れ目しか見ない)。
 *
 * 2026-08-21 実測(サンプル5章 → 2章の原稿を取り込む):
 * ```
 *   紙に出た挿絵      3 → 1 枚   (残り2枚は章の外に取り残された)
 *   紙に出たコラム    2 → 1 枚   (残り1枚も同じ)
 *   画面に出る断り    なし
 * ```
 * ファイルを開く道(`project/file.ts` の fromProjectFile)は前から巻末へ寄せて
 * 「直したもの」に出していたので、**取り込みの道をそちらへそろえる**。
 * 捨てずに巻末へ寄せるのは、捨てると絵も文章も戻せなくなるため。
 *
 * 章ごとの指定(背景・書体・色)は**寄せない**。「第二章の地」は第二章のものなので、
 * 別の章へ移すほうが間違い。効かなくなった数だけ数えて、画面で言う
 */
export function fitInsertsToChapters(
  s: ProjectSettings,
  chapters: number,
): { settings: ProjectSettings; fit: InsertFit } {
  const plates = s.plates ?? [];
  const cols = s.columnPages ?? [];
  const outPlates = plates.filter((p) => p.beforeChapter > chapters);
  const outCols = cols.filter((c) => c.beforeChapter > chapters);
  let chapterSettings = 0;
  for (const key of CHAPTER_KEYED) {
    const map = s[key] as Record<number, unknown> | undefined;
    if (!map) continue;
    chapterSettings += Object.keys(map).filter((k) => Number(k) >= chapters).length;
  }
  if (!outPlates.length && !outCols.length) {
    return { settings: s, fit: { plates: 0, columnPages: 0, chapterSettings } };
  }
  return {
    settings: {
      ...s,
      plates: plates.map((p) =>
        p.beforeChapter > chapters ? { ...p, beforeChapter: chapters } : p,
      ),
      columnPages: cols.map((c) =>
        c.beforeChapter > chapters ? { ...c, beforeChapter: chapters } : c,
      ),
    },
    fit: { plates: outPlates.length, columnPages: outCols.length, chapterSettings },
  };
}

/**
 * **取り込み直しで、差し込みページと章ごとの指定を、同じ章についていかせる。**(2026-09-25 見直し S1-6)
 *
 * `match` は前の原稿の章 → 新しい原稿の章(-1 は無くなった章。inlineImages の matchChapters)。
 * - 挿絵・コラムの「◯章の前」は、その章が移った先の前へ。章が無くなっていたら、その次に残っている
 *   章の前へ(どれも無ければ巻末)
 * - 章ごとの指定(背景・書体・色…)は、その章が移った先の番号へ。無くなった章のものは外す
 *   (効かなくなった数として数える。別の章へ移すほうが間違い、という前からの決まり)
 * そのあと、範囲の外に出たものを巻末へ寄せる(fitInsertsToChapters)
 */
export function followChapters(
  s: ProjectSettings,
  match: number[],
  newCount: number,
): { settings: ProjectSettings; fit: InsertFit } {
  const identity = match.length === newCount && match.every((m, i) => m === i);
  if (identity) return fitInsertsToChapters(s, newCount);
  let followed = 0;
  let lostSettings = 0;
  const before = (b: number) => {
    for (let k = b; k < match.length; k++) if (match[k] >= 0) return match[k];
    return newCount;
  };
  const plates = (s.plates ?? []).map((p) => {
    const b = before(p.beforeChapter);
    if (b === p.beforeChapter) return p;
    followed++;
    return { ...p, beforeChapter: b };
  });
  const columnPages = (s.columnPages ?? []).map((c) => {
    const b = before(c.beforeChapter);
    if (b === c.beforeChapter) return c;
    followed++;
    return { ...c, beforeChapter: b };
  });
  const next: ProjectSettings = { ...s, plates, columnPages };
  for (const key of CHAPTER_KEYED) {
    const map = s[key] as Record<number, unknown> | undefined;
    if (!map) continue;
    const moved: Record<number, unknown> = {};
    for (const [k, v] of Object.entries(map)) {
      const oi = Number(k);
      const ni = oi < match.length ? match[oi] : -1;
      if (ni < 0) {
        lostSettings++;
        continue;
      }
      if (ni !== oi) followed++;
      moved[ni] = v;
    }
    (next as unknown as Record<string, unknown>)[key] = moved;
  }
  const { settings, fit } = fitInsertsToChapters(next, newCount);
  return {
    settings,
    fit: { ...fit, chapterSettings: fit.chapterSettings + lostSettings, followed },
  };
}

/**
 * 面ごとの背景。画像・濃さ・文字のフチをひとまとめに持つ。
 *
 * **省略した項目は本文の設定を継ぐ。** 絵だけ差し替えて濃さは全体に揃える、
 * という指定ができるようにするため。章ごとに絵を変えると、明るい絵と暗い絵が混ざって
 * 同じ濃さでは本文が読めなくなるので、面ごとに濃さとフチを持てる必要がある。
 */
export interface BgSpec {
  /** 背景画像(data URI)。空なら base に従う */
  src?: string;
  /** 濃さ 0〜1。省略なら本文の値 */
  opacity?: number;
  /** 文字のフチ(em)。省略なら本文の値 */
  outline?: number;
  /** フチの色。省略なら本文の値 */
  outlineColor?: string;
  /**
   * 絵を指定しないときの地。'inherit'(既定) は本文と同じ絵、'plain' は無地。
   * src があるときは見ない。目次・奥付で「本文の絵を敷かない」を表すのに使う
   */
  base?: 'inherit' | 'plain';
  /**
   * 同梱のプリセットから選んだ絵か。**選んだ瞬間にしか分からないので目印を残す。**
   * プリセットは読み込んだ時点で data URI になり、保存後は利用者が自分で用意した
   * 画像と見分けがつかない。同梱の絵は生成AIで作っており、KDP は出版フローで
   * 申告を求めているので、「04 書き出し」に申告の行を出すための判定に使う
   */
  fromPreset?: boolean;
}

/** BgSpec を本文の設定で埋めた、組版がそのまま使える値 */
export interface ResolvedBg {
  src?: string;
  opacity: number;
  outline: number;
  outlineColor: string;
}

export function resolveBg(spec: BgSpec | undefined, s: ProjectSettings): ResolvedBg {
  const plain = !spec?.src && spec?.base === 'plain';
  return {
    src: spec?.src ?? (plain ? undefined : s.bodyBg),
    opacity: spec?.opacity ?? s.bgOpacity,
    outline: spec?.outline ?? s.textOutline,
    outlineColor: spec?.outlineColor ?? s.textOutlineColor,
  };
}

/** その面が本文と違う指定を持っているか(画面に「本文と同じ」を出すため) */
export function hasOwnBg(spec: BgSpec | undefined): boolean {
  if (!spec) return false;
  return Boolean(
    spec.src || spec.base === 'plain' ||
      spec.opacity !== undefined || spec.outline !== undefined,
  );
}

/**
 * 保存済みデータの背景設定を BgSpec 形式へ直す。
 *
 * 2026-08-16 より前は 大扉・章が data URI の文字列、目次・奥付が真偽値だった。
 * hydrate は既定値とマージするだけなので、型が変わったこの2つは明示的に移し替える。
 * 移さないと「保存した背景が消えた」という壊れ方をする。
 */
/**
 * 旧「あとがき」欄(`Manuscript.afterword`)からの移行。
 *
 * あとがきは専用の欄をやめ、**本文の章として書いてもらう**ことにした。
 * 「あとがき」と書く人ばかりではなく「おわりに」「エピローグ」もあるし、
 * 章に番号を振らない人もいる。専用欄を1つ置いても取りこぼす。
 * 空いた場所は「著者紹介」(奥付の上に横組みで入る)に充てた。
 *
 * 中身は捨てず、**巻末の章「あとがき」として本文に足す**。
 * 移行後は `afterword` を消すので、二度足されることはない。
 */
export function migrateManuscript(saved: Manuscript): Manuscript {
  const old = (saved as unknown as Record<string, unknown>).afterword;
  if (typeof old !== 'string' || !old.trim()) return saved;

  const blocks: Block[] = old
    .split(/\r?\n\s*\r?\n/)
    .map((t) => t.replace(/\r?\n/g, '').trim())
    .filter(Boolean)
    .map((text) => ({ type: 'p', text }));

  const next = { ...saved, chapters: [...saved.chapters, { title: 'あとがき', blocks }] };
  delete (next as unknown as Record<string, unknown>).afterword;
  return next;
}

export function migrateBgSettings(saved: Record<string, unknown>): Partial<ProjectSettings> {
  const out: Partial<ProjectSettings> = {};
  const toSpec = (v: unknown): BgSpec | undefined =>
    typeof v === 'string' ? (v ? { src: v } : undefined) : (v as BgSpec | undefined);

  if (typeof saved.titleBg === 'string') out.titleBg = toSpec(saved.titleBg);

  if (saved.chapterBg && typeof saved.chapterBg === 'object') {
    const next: ChapterBackgrounds = {};
    for (const [k, v] of Object.entries(saved.chapterBg as Record<string, unknown>)) {
      const spec = toSpec(v);
      if (spec) next[Number(k)] = spec;
    }
    out.chapterBg = next;
  }

  // 旧: bgOnToc(既定 true) / bgOnColophon(既定 false)
  if (saved.tocBg === undefined && saved.bgOnToc === false) out.tocBg = { base: 'plain' };
  if (saved.colophonBg === undefined) {
    out.colophonBg = saved.bgOnColophon === true ? { base: 'inherit' } : { base: 'plain' };
  }
  // 場面転換の見た目。**背景の話ではないが、ここに相乗りさせる。**
  // 保存データを読むときに通る移し替えの口はこの関数ひとつしかなく
  // (store/useProject.ts の hydrate)、既定値とのマージだけでは
  // 「項目が無い古い保存」と「1行アキを選んだ新しい保存」を見分けられない
  const scene = migrateSceneBreak(saved);
  if (scene) out.sceneBreak = scene;
  // 電子書籍の色も同じ口に相乗りさせる(理由は sceneBreak と同じ。migrateEbookMono)
  const ebookMono = migrateEbookMono(saved);
  if (ebookMono !== undefined) out.ebookMono = ebookMono;
  return out;
}

/**
 * **古い保存の［書き出す EPUB の色］を、新しい［電子書籍の色］へ移す。**(2026-09-24)
 *
 * 前は `epubMono` を「紙が白黒で、紙を作る本のときだけ効くスイッチ」として持っていた
 * (exporters/epub.ts は makePaper !== false && ink === 'mono' && epubMono のときだけ白黒にした)。
 * 新しい `ebookMono` はそれだけで効くので、そのまま写すと、白黒を選んだあと刷り色をカラーにした本が
 * 白黒に変わる。**前に実際に効いていた値**を写す。`ebookMono` を持っている保存には触らない
 * (返り値 undefined = 触らない)
 */
export function migrateEbookMono(saved: Record<string, unknown>): boolean | undefined {
  if (typeof saved.ebookMono === 'boolean') return undefined;
  if (saved.epubMono === undefined) return undefined;
  return saved.epubMono === true && saved.ink === 'mono' && saved.makePaper !== false;
}

/** 余白の最低値(mm)。ノドは KDP 規定と比較して大きい方を使う */
export interface MarginMins {
  top: number; // 天
  bottom: number; // 地
  fore: number; // 小口
  gutter: number; // ノド
}

export interface TypographyDefaults {
  fontPt: number;
  lineFeedPt: number; // 行送り
  margins: MarginMins;
}

/** 判型×組み方向ごとの既定値(rules §1.3) */
const DEFAULTS: Record<WritingMode, Partial<Record<TrimId, TypographyDefaults>>> = {
  vertical: {
    // fore(小口)は最低値。端数吸収で最終値は少し大きくなる(例: 文庫 9.5→約10mm で 15行確保)
    // **文庫は 8.5pt(＝ほぼ 12Q)。**(2026-08-21 ユーザー判断「文庫本は文字サイズの定番を
    // 8.5ptにしたらダメかなあ。12Qくらいでしょ」)。12Q ちょうどは 8.504pt で、
    // 前の 9pt は 12.70Q だった。商業文庫の定番は 12〜13Q なので、9pt はやや大きい。
    // 行送りも一緒に下げる — 8.5pt のまま 15.5pt だと行送り比が ×1.72 → ×1.82 になって間延びする。
    // 14.5pt なら ×1.71 で前と同じ手ざわりのまま。
    //   実測(105×148・天12/地15・小口9.5/ノド13):
    //     9.0pt/15.5pt … 38字 × 15行 = 570字/頁
    //     8.5pt/14.5pt … 40字 × 16行 = 640字/頁 ← 商業文庫の定番の幅(38〜42字×15〜17行)の中
    //   1頁の字数が12%増えるので、ページ数も背幅もそのぶん減る。
    // **保存済みの本は組み直らない** — hydrate は保存の値を既定より優先するため。
    // ここが効くのは新しい本と、判型を変えたときのリセット
    bunko: { fontPt: 8.5, lineFeedPt: 14.5, margins: { top: 12, bottom: 15, fore: 9.5, gutter: 13 } },
    shinsho: { fontPt: 9, lineFeedPt: 15.5, margins: { top: 22, bottom: 26, fore: 8.5, gutter: 12 } },
    b6: { fontPt: 9.5, lineFeedPt: 16.5, margins: { top: 20, bottom: 24, fore: 13, gutter: 15 } },
    shirokuban: { fontPt: 9.5, lineFeedPt: 17, margins: { top: 20, bottom: 24, fore: 10, gutter: 15 } },
    a5: { fontPt: 10.5, lineFeedPt: 18, margins: { top: 22, bottom: 26, fore: 14, gutter: 16 } },
    b5: { fontPt: 10.5, lineFeedPt: 18, margins: { top: 22, bottom: 26, fore: 15, gutter: 17 } },
    a4: { fontPt: 11, lineFeedPt: 19, margins: { top: 24, bottom: 28, fore: 17, gutter: 19 } },
  },
  horizontal: {
    bunko: { fontPt: 8.5, lineFeedPt: 15, margins: { top: 12, bottom: 14, fore: 10, gutter: 13 } },
    shinsho: { fontPt: 8.5, lineFeedPt: 15, margins: { top: 14, bottom: 16, fore: 10, gutter: 13 } },
    b6: { fontPt: 9, lineFeedPt: 16, margins: { top: 15, bottom: 17, fore: 12, gutter: 14 } },
    shirokuban: { fontPt: 9, lineFeedPt: 16, margins: { top: 15, bottom: 17, fore: 12, gutter: 14 } },
    a5: { fontPt: 9, lineFeedPt: 16, margins: { top: 16, bottom: 18, fore: 14, gutter: 16 } },
    // B5・A4 は本文を大きくする。横組みの上限40字(rules §0-3)に対して字が小さいと
    // 版面が細くなり、余った幅がそのまま余白になってノドが30mm超まで膨らむ(2026-08-10 実測)
    b5: { fontPt: 10.5, lineFeedPt: 19, margins: { top: 18, bottom: 20, fore: 15, gutter: 17 } },
    a4: { fontPt: 12, lineFeedPt: 21.5, margins: { top: 20, bottom: 22, fore: 17, gutter: 19 } },
  },
};

/**
 * KDP ペーパーバックの塗り足し(mm)。
 * 用紙は仕上がり寸法に対し「小口 +3.2 / 天 +3.2 / 地 +3.2」だけ広い。
 * ノド側は背にあたるので断裁されず、塗り足しを足さない。
 */
export const BLEED_MM = 3.2;

/**
 * 印刷所の決まり。**出し先が「その他の印刷所」のときだけ効く**(2026-10-01)。
 *
 * それまでは塗り足しもノドの下限も、出し先に関係なく KDP の決まり1つで組んでいた。
 * 印刷所ごとに塗り足し(3mm が多いが、ノド側にも付けるかは分かれる)とノドの下限が違うので、
 * 利用者が入稿先のガイドから写した数字で決める。KDP の本は、この値を持っていても読まない
 */
export interface PrintRules {
  /** 塗り足しの幅 mm(表紙も同じ幅) */
  bleedMm: number;
  /** 綴じる側(ノド)にも塗り足しを付けるか。KDP は付けない(背にあたるので断裁されない) */
  bleedGutter: boolean;
  /** ノドの下限 mm */
  gutterMinMm: number;
  /** 「このページ数をこえたら」。決まりが無ければ null */
  thickPages: number | null;
  /** そのときのノドの下限 mm。決まりが無ければ null */
  thickGutterMm: number | null;
}

/** 既定。多くの印刷所の入稿案内にある値(塗り足し 3mm を四辺・ノド 15mm・200ページ超は 20mm) */
export const DEFAULT_PRINT_RULES: PrintRules = {
  bleedMm: 3,
  bleedGutter: true,
  gutterMinMm: 15,
  thickPages: 200,
  thickGutterMm: 20,
};

/** 欄と読み込み(file.ts の sanitize)と printRulesOf が、同じ範囲を見る */
export const PRINT_RULE_LIMITS = {
  bleedMm: [0, 10],
  gutterMinMm: [0, 50],
  thickPages: [1, 2000],
  thickGutterMm: [0, 50],
} as const;

/** 背の縁のアキ(mm)の範囲。出し先の会社が決めていないときの欄(ShapeStep)と、AI の返事を読む所が同じ範囲を見る */
export const SPINE_INSET_LIMIT = [0, 5] as const;

const clampTo = (v: unknown, lim: readonly [number, number], fallback: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(lim[1], Math.max(lim[0], v));
};

/**
 * 印刷所の決まりを、組版が受け取れる形に丸める。**丸めの計算はここ1か所**
 * (読み込みの sanitize と、使うときの printRulesOf の両方がこれを呼ぶ。2026-10-01)。
 *
 * 2か所に別々に書いていたとき、範囲外の値で答えが食い違った(検証の実測:
 * `{bleedMm:-1, gutterMinMm:1e9}` を、sanitize は既定(3/15)に戻し、printRulesOf は 0/50 に丸めた。
 * `gutterMinMm:30, thickGutterMm:10` を、sanitize は 10 のまま通し、printRulesOf は 30 に切り上げた)。
 * 画面の欄が生の値を出すと「10 と表示して 30 で組む」になるので、保存する値も同じ丸めにそろえる
 *
 * - 型が違う項目(数でない・NaN・Infinity・真偽でない)は、その項目だけ既定に戻す
 * - 範囲外の数は、範囲に収める
 * - **`thickGutterMm` は `gutterMinMm` 以上に切り上げる**: 下限がページ数で下がると、
 *   ページ数の書き戻し(App.tsx の estimatedPages)が「201ページ→10mm→199ページ→15mm→201ページ」
 *   と振動する(2026-10-01 下調べ)。書き戻しは下限が増える一方なことを前提に止まる
 * - `thickPages` と `thickGutterMm` は、片方だけ null なら両方 null(「◯ページをこえたら◯mm」は組で意味を持つ)。
 *   項目そのものが無い(undefined)のは既定、**null は「決まりが無い」**
 */
export function normalizePrintRules(r: Partial<Record<keyof PrintRules, unknown>>): PrintRules {
  const d = DEFAULT_PRINT_RULES;
  const L = PRINT_RULE_LIMITS;
  const gutterMinMm = clampTo(r.gutterMinMm, L.gutterMinMm, d.gutterMinMm);
  const tp = r.thickPages === undefined ? d.thickPages : r.thickPages;
  const tg = r.thickGutterMm === undefined ? d.thickGutterMm : r.thickGutterMm;
  const hasThick = tp !== null && tg !== null;
  return {
    bleedMm: clampTo(r.bleedMm, L.bleedMm, d.bleedMm),
    bleedGutter: typeof r.bleedGutter === 'boolean' ? r.bleedGutter : d.bleedGutter,
    gutterMinMm,
    thickPages: hasThick ? Math.round(clampTo(tp, L.thickPages, d.thickPages as number)) : null,
    thickGutterMm: hasThick
      ? Math.max(gutterMinMm, clampTo(tg, L.thickGutterMm, d.thickGutterMm as number))
      : null,
  };
}

/**
 * いま効いている印刷所の決まり。**KDP の本と、決まりをまだ入れていない本は null**
 * (その場合は KDP の決まりで組む)。
 *
 * - 出し先が印刷所でも `printRules` が無い本は null。古い保存を開いたとき、黙って
 *   ノドと用紙が変わらないようにする(defaultSettings にも入れていない)。
 *   出し先を印刷所に切り替えたときに入れるのは store の setSettings
 * - 丸め方は normalizePrintRules
 */
export function printRulesOf(
  s: Pick<ProjectSettings, 'printTarget' | 'printRules'>,
): PrintRules | null {
  const p = PRINT_TARGETS[s.printTarget];
  // 会社が決めている出し先(rulesSource が fixed)は、利用者の printRules を読まず、会社の値をそのまま返す
  if (p?.rulesSource === 'fixed' && p.fixedPrintRules) return p.fixedPrintRules;
  const r = s.printRules;
  if (p?.rulesSource !== 'user' || !r || typeof r !== 'object' || Array.isArray(r)) return null;
  return normalizePrintRules(r);
}

/** 利用者が決まり(印刷所の決まり)を入れる出し先か。「印刷所の決まり」の欄と、AI に入稿の数字を調べてもらう箱が出る */
export function usesOwnPrintRules(target: PrintTarget): boolean {
  return PRINT_TARGETS[target]?.rulesSource === 'user';
}

/** この出し先で、その判型は使えないか(unsupportedTrims) */
export function trimUnsupported(target: PrintTarget, trim: TrimId): boolean {
  return PRINT_TARGETS[target]?.unsupportedTrims?.includes(trim) === true;
}

/**
 * **いま効いている綴じ方。** 選んでいる綴じ方(settings.binding)ではなく、これを見る。(2026-10-03)
 * 中綴じは**出し先がその決まり(PrintTargetProfile.saddle)を持つときだけ**効く。KDP には中綴じが無いので、
 * 選んでいても無線として組む(選びは消さない。出し先を戻せば中綴じに戻る。画面と入稿前チェックでそう言う)。
 * 項目の無い古い保存は無線(いままでどおり。組版は1字も変わらない)
 */
export function bindingOf(s: Pick<ProjectSettings, 'printTarget' | 'binding'>): Binding {
  return s.binding === 'saddle' && PRINT_TARGETS[s.printTarget]?.saddle ? 'saddle' : 'perfect';
}

/** 中綴じのとき、出し先の決まり。無線のとき・出し先が中綴じを持たないときは null */
export function saddleSpecOf(s: Pick<ProjectSettings, 'printTarget' | 'binding'>): SaddleSpec | null {
  return bindingOf(s) === 'saddle' ? (PRINT_TARGETS[s.printTarget].saddle ?? null) : null;
}

/** この出し先は中綴じを選べるか(［本のかたちを決める］の［綴じ方］を出すか) */
export function offersSaddle(target: PrintTarget): boolean {
  return !!PRINT_TARGETS[target]?.saddle;
}

/** 中綴じの表紙の入れ方。省略は別表紙(中綴じの表紙用紙を別に選ぶのが標準) */
export function saddleCoverOf(s: Pick<ProjectSettings, 'saddleCover'>): SaddleCover {
  return s.saddleCover === 'self' ? 'self' : 'separate';
}

/**
 * 塗り足し(天・地・小口・ノド)。**組版・表紙・文言はみなここから読む。**
 * **中綴じでも変えない**(四辺が出し先の塗り足しのまま。2026-10-03 監査: 入稿ガイドは「四辺に 3mm」がふつうで、
 * 本文の全ページを同じ寸法にしておくと、共紙の表紙も自然にそろう。ノド側なしが正しいと分かったときだけ、ここに分岐を足す)
 * KDP と、決まりをまだ入れていない本は { 3.2, 3.2, 3.2, 0 }(BLEED_MM。ノド側なし)
 */
export function bleedOf(s: Pick<ProjectSettings, 'printTarget' | 'printRules'>): Bleed4 {
  const r = printRulesOf(s);
  if (!r) return { top: BLEED_MM, bottom: BLEED_MM, fore: BLEED_MM, gutter: 0 };
  return { top: r.bleedMm, bottom: r.bleedMm, fore: r.bleedMm, gutter: r.bleedGutter ? r.bleedMm : 0 };
}


/**
 * 段数の上限(2026-08-04 決定)。
 * 段組みは縦組みのみ。B5・A4 は4段まで、それ以外の判型は3段まで。
 * 根拠: 既定の文字サイズだと B6以下の4段は1段8〜9字になり、
 * 新聞の11〜12字を大きく下回って語が毎行割れる(実測で確認済み)。
 * 文字を小さくすれば成立するが、それはマニュアル側の題材とする。
 */
export function maxColumns(trim: TrimId, mode: WritingMode): number {
  if (mode === 'horizontal') return 1;
  return trim === 'b5' || trim === 'a4' ? 4 : 3;
}

export function typographyDefaults(trim: TrimId, mode: WritingMode): TypographyDefaults {
  const d = DEFAULTS[mode][trim];
  if (d) return { ...d, margins: { ...d.margins } };
  return { fontPt: 9, lineFeedPt: 16, margins: { top: 16, bottom: 18, fore: 12, gutter: 14 } };
}

export interface ProjectSettings {
  trim: TrimId;
  writingMode: WritingMode;
  /**
   * 縦組みの本で、書名・著者名(表紙の表1・大扉・電子書籍の扉)だけを横組みにするか。(2026-10-03)
   * 省略 = 本文に従う(いまどおり)。横組みの本では見ない(titleWritingModeOf を通す)。
   * **綴じの向きや表紙の左右は writingMode が決めている**ので、書名の向きのために writingMode は変えない
   */
  titleWritingMode?: WritingMode;
  theme: ThemeId;
  /** 本文の刷り色。白黒なら絵も背景もグレーで組む(刷り上がりと画面を合わせる) */
  ink: InkColor;
  /** 本文の書体。テーマを変えると既定値に戻る(THEME_BODY_FONT) */
  bodyFont: BodyFontId;
  fontPt: number;
  lineFeedPt: number;
  margins: MarginMins;
  /** 段組み数(1=段組みなし)。縦組みのみ有効 */
  columns: number;
  /** 段間(行数で持つ。行送りを変えても比率が保たれる)。既定は1行 */
  columnGapLines: number;
  /** 目次ページを扉の次に入れる(rules §8) */
  toc: boolean;
  /**
   * 場面転換(原稿の `---`)の見た目。既定は「1行アキ」(SceneBreakId を見ること)。
   *
   * **章ごとには持たない。** 出版社のスタイルガイドが本1冊で1つに決めるもので、
   * 同じ本の中で場面転換の印が変わる本は無い。
   * **未指定は「この設定より前の保存」** = 罫(migrateSceneBreak)
   */
  sceneBreak?: SceneBreakId;
  /**
   * EPUB の出し先。**表紙の入れ方だけが変わる。**
   *
   * KDP と楽天Kobo の要件が正面から食い違うので、1つのファイルで両方は満たせない:
   * - KDP  「表紙の HTML ページを本文に足さないこと。二重に出るか変換に失敗する」
   * - Kobo 「表紙画像はそれ専用の XHTML ファイルに入れること」
   *
   * どちらでも表紙画像そのものは manifest と metadata に載せる。
   * 違うのは cover.xhtml を作って spine に並べるかどうかだけ
   */
  epubTarget: EpubTarget;
  /**
   * 書き出す EPUB の絵を白黒にするか。**既定は false = カラーのまま。**
   *
   * `ink` は「紙をどのインクで刷るか」の設定で、紙の印刷条件でしかない。
   * 電子書籍に印刷は無く、読まれるのはたいていカラーの画面なので、
   * **紙を白黒で刷ると決めただけで電子の絵から色が落ちるのは行き過ぎ**。
   * 色を落とすのは戻せない方向の変更なので、既定は「落とさない」に置く。
   *
   * 一方で「白黒の本」として作ったものを電子でもそろえたい人はいるので、
   * 選べるようにした。
   *
   * **2026-09-24 から［本のかたちを決める］の［電子書籍の色］で選ぶ、紙とは別の値。**
   * 以前は紙が白黒のときだけ書き出しの画面に出し、`ink === 'mono'` とそろったときだけ掛けていた。
   * 電子の下見ができたので、紙の刷り色と同じく本の器を決める場所で選び、下見で確かめてから
   * 書き出す形にした(ユーザー要望)。電子書籍を作る本ではいつも欄が見えるので、効いている指定が
   * 画面から消えることは無い
   *
   * **値の名前は `ebookMono`。**(2026-09-24) 効き方が変わった(紙の刷り色と切り離した)ので、
   * 前の `epubMono` とは別の名前にした。同じ名前のままだと、前の画面で白黒を選んだあと刷り色を
   * カラーにした(または紙を作らないにした)本は、前はカラーで出ていたのに白黒に変わってしまう。
   * 古い保存は読み込むときに `migrateEbookMono` が、前に**実際に効いていた**値へ移す
   */
  ebookMono?: boolean;
  /** 紙の出し先。背文字の決まりがこれで変わる(PrintTarget を参照) */
  printTarget: PrintTarget;
  /**
   * 印刷所の決まり(塗り足し・ノドの下限)。**出し先が「その他の印刷所」のときだけ効く。**
   * **省略は「まだ入れていない」= いままでどおり KDP の決まりで組む**(printRulesOf)。
   * 出し先を印刷所に切り替えたとき、無ければ DEFAULT_PRINT_RULES を入れる(store の setSettings)。
   * defaultSettings には入れない(古い保存を開いて、黙ってノドと用紙が変わらないように)
   */
  printRules?: PrintRules;
  /**
   * 綴じ方(bindingOf を通して読む)。**省略は無線綴じ**(いままでの本)。中綴じは、出し先が中綴じの決まり
   * (PrintTargetProfile.saddle)を持つときだけ効く(その他の印刷所など)。
   * defaultSettings には入れない(古い保存を開いて、黙って組版が変わらないように。printRules と同じ約束)。
   * 出し先を KDP に変えても消さない(戻せば中綴じに戻る)
   */
  binding?: Binding;
  /** 中綴じの表紙の入れ方(saddleCoverOf を通して読む)。省略は別表紙。無線綴じの本には効かない */
  saddleCover?: SaddleCover;
  /**
   * 背の縁から空けるアキ(mm)。
   * **出し先の会社が決めているとき(PrintTargetProfile.fixedSpineInsetMm。KDP は 1.6)は
   * そちらに固定**され、この値は使われない
   */
  spineInsetMm: number;
  /**
   * 作るもの(outputsOf を通して読む)。false のときだけ「作らない」。
   * 省略は作る(項目の無い古いファイルは両方作る)
   */
  makePaper?: boolean;
  makeEbook?: boolean;
  /** ノド計算に使う推定総ページ数(本文確定後は実測で上書き) */
  estimatedPages: number;
  /**
   * 本文ページに敷く背景画像(data URI)。空なら無地。
   * **他の面(大扉・目次・章・奥付)はこれを既定として継ぐ**
   */
  /**
   * 利用者が**自分で用意した**絵や文章に生成AIを使ったか。
   *
   * 同梱のプリセットを使ったかどうかはアプリ側で分かるが(fromPreset)、
   * 持ち込まれた画像や原稿が AI 製かどうかは**判別しようがない**。
   * KDP の申告は本の中身すべてが対象で、未申告は規約違反になるので、
   * 手で「はい」にできる道を残す。**申告を弱める向きには使えない**
   * (同梱の絵を使っていれば、ここが false でも「はい」になる)
   */
  aiContentByUser?: boolean;
  bodyBg?: string;
  /**
   * bodyBg が同梱のプリセットか。**bodyBg だけ BgSpec ではなく生の文字列**なので、
   * 目印を隣に置くしかない(用途は BgSpec.fromPreset と同じ)
   */
  bodyBgFromPreset?: boolean;
  /**
   * 本文の背景の濃さ 0〜1。上から白をかぶせて薄くする。
   * 表紙用の画像パックはそのまま敷くと本文が読めないので、既定は薄め。
   * 面ごとに上書きできる(BgSpec.opacity)
   */
  /**
   * この本の id。**別の本かどうかを見分けるためだけに使う。**
   *
   * AI用に書き出した JSON は画像を持たないので、読み込むときは手元の絵で埋め直す。
   * その埋め直しは**同じ本のときだけ正しい**。数冊を並行して作っていると、
   * 別の本の JSON を読んだ瞬間に手元の絵が混ざる(2026-08-19 ユーザー指摘)。
   * 本を新しく始めたとき・原稿を取り込んだときに振り直す
   */
  bookId?: string;
  /**
   * 章の書き出しの1字を大きくする(ドロップキャップ)。何行ぶんにするか。
   * 0 なら付けない。CSS の initial-letter を使う — **縦組みでも効く**(実測)
   */
  dropCap?: number;
  /** 段と段のあいだに罫線を引く(段組みのときだけ意味を持つ) */
  columnRule?: boolean;
  bgOpacity: number;
  /**
   * ノンブル(ページ番号)の置き場所。既定は地・小口寄り(rules §7)。
   * `none` で刷らない(電子書籍には元から入らない)
   */
  nombreSlot?: MarginSlot;
  /** 柱(章題)の置き場所。既定は地・中央 */
  runningHeadSlot?: MarginSlot;
  /**
   * 柱をどのページに出すか。既定は奇数ページだけ(和書の定番)。
   * **選択肢を削らない。** 偶数ページに入れたい人・両方に入れたい人もいる
   * (2026-08-19 ユーザー指摘)
   */
  runningHeadPages?: 'recto' | 'verso' | 'both';
  /**
   * 柱に入れる文字。章題(既定)か、書名か。
   * **章題だけとは限らない。** 実用書では書名を入れる本も多い(2026-08-19 ユーザー指摘)
   */
  runningHeadText?: 'chapter' | 'title';
  /** ノンブルの書体。既定は欧文セリフ(数字だけなので本文書体に揃えなくてよい) */
  nombreFont?: BodyFontId;
  /** 柱の書体。既定はゴシック */
  runningHeadFont?: BodyFontId;
  /**
   * 本文の文字に付けるフチの太さ(em)。0 なら付けない。
   * 濃い背景画像の上でも本文が読めるようにするための逃げ道(ZINE向け)。
   * 背景を薄くすると絵が死ぬので、絵はそのままに文字側で読ませる。
   * 面ごとに上書きできる(BgSpec.outline)
   */
  textOutline: number;
  /** フチの色。既定は白 */
  textOutlineColor: string;
  /**
   * 本文の下に敷く帯の濃さ 0〜1。0 なら敷かない。
   * フチと同じ目的(濃い絵の上で本文を読ませる)だが、絵を薄めず、字も加工しない。
   * **版面ぶんだけ敷かれ、余白には絵がそのまま出る** ので、
   * 派手な絵を余白で見せながら本文を読ませられる(表紙のあらすじ帯と同じ考え方)。
   *
   * 面ごとには持てない。帯は body に敷いており(css.ts 参照)、
   * body の背景は「ページ領域＝版面」に塗られるが、CSS上ひとつしか持てないため。
   * 面ごとに変えたいなら @page の背景レイヤーを版面寸法で置く手があるが、
   * ノド・小口が :recto/:verso で入れ替わるので全ページ名を2倍書くことになる。
   * 濃い絵でも読めるようにするのが目的で、章ごとに変える必然性は薄いので採らない
   */
  textPlate: number;
  /** 帯の色。既定は白 */
  textPlateColor: string;
  /** 本文の文字色 */
  textColor: string;
  /** 章見出しの文字色。空なら本文と同じ */
  headingColor?: string;
  /** 小見出しの文字色。空なら本文と同じ */
  subheadingColor?: string;
  /**
   * 章ごとの本文の色。指定のない章は textColor。
   * 章ごとに背景の絵を変える ZINE では、絵の明暗に合わせて字の色も変える必要がある
   */
  chapterTextColor?: Record<number, string>;
  /** 章ごとの章見出しの色。指定のない章は headingColor(それも無ければ本文の色) */
  chapterHeadingColor?: Record<number, string>;
  /** 大扉。省略なら本文と同じ */
  titleBg?: BgSpec;
  /** 目次。省略なら本文と同じ */
  tocBg?: BgSpec;
  /** 奥付。既定は無地(書誌を読ませる場所なので) */
  colophonBg?: BgSpec;
  /** 章ごと。指定のない章は本文と同じ */
  /** 章ごとの小見出しの色。無指定の章は全体の設定を使う */
  chapterSubheadingColor?: Record<number, string>;
  /**
   * **章ごとの組み方向は持てない。**(2026-08-19 実測で取り下げ)
   *
   * Vivliostyle はページを割る軸を**ルートの組み方向だけ**で決めていて、
   * section にも @page にも writing-mode を書き足せない。混ぜると行は折り返すのに
   * 改ページされず、本文が1ページの中に伸びて紙からはみ出す(実測 9083px)。
   * 奥付が縦組みの本でも横組みで出せているのは、**1ページに収まる要素だから**
   * (css.ts の奥付にも「縦に伸びて次ページへこぼれる」実測が残っている)。
   *
   * 書体・サイズ・行送り・段数・色・大文字は要素に当たるだけなので章ごとに持てる
   */
  /**
   * 章ごとの本文書体。無指定の章は本全体の設定に従う。
   * **埋め込む書体が増える。** 使った書体ぶんだけ @font-face を集めること(App.tsx)
   */
  chapterFont?: Record<number, BodyFontId>;
  /**
   * 章ごとの本文サイズ(pt)。無指定の章は本全体の設定に従う。
   *
   * **版面の行グリッドからは外れる。** 字数×行数は本全体の値で決まっていて、
   * @page の余白も本全体で1つ。サイズを変えた章は、同じ四角の中を
   * 違う大きさの行で流れる(コラムや資料編のような「別ものの章」を想定した機能)。
   * 情報バーに出る「18字×15行」は**本全体の標準**であって、その章の実測ではない
   */
  chapterFontPt?: Record<number, number>;
  /** 章ごとの行送り(pt)。無指定の章は本全体の設定に従う */
  chapterLineFeedPt?: Record<number, number>;
  /** 章ごとの段の数。無指定の章は本全体の設定に従う */
  chapterColumns?: Record<number, number>;
  /** 章ごとの「章はじめの大文字」の行数。0 は「この章では使わない」という指定 */
  chapterDropCap?: Record<number, number>;
  /**
   * 奥付と著者紹介の見た目。**別々に持つ。**(2026-08-19 ユーザー要望)
   *
   * 同じページに並ぶが役目が違う。奥付は書誌の記録で、著者紹介は読ませる文章。
   * 省略した項目は本文の設定を継ぐ(どちらも既定では本文の0.9倍で組んでいる)
   */
  colophonType?: MatterType;
  profileType?: MatterType;
  /**
   * 章ごとの「本文の下に帯」。**背景の濃さ・フチと組で使う。**
   *
   * 濃さとフチは chapterBg(BgSpec)が持っているが、帯だけはそこに無かった。
   * 絵の明るい章と暗い章では、読ませるために敷く帯の濃さも色も別々に要る
   */
  chapterPlate?: Record<number, number>;
  /** 章ごとの帯の色。省略なら本全体の色 */
  chapterPlateColor?: Record<number, string>;
  chapterBg?: ChapterBackgrounds;
  /**
   * 挿絵ページ。原稿ではなく設定側に持つ。
   * 原稿を組み直しても消えないようにするため(reparse は manuscript を作り直す)
   */
  plates: Plate[];
  /**
   * コラムページ。挿絵ページと同じく設定側に持つ(原稿を組み直しても消えないため)。
   * 差し込む場所も挿絵と同じ「章の前」で、同じ切れ目では**挿絵のあと**に出る
   */
  columnPages: ColumnPage[];
}

export function defaultSettings(): ProjectSettings {
  const t = typographyDefaults('bunko', 'vertical');
  return {
    trim: 'bunko',
    writingMode: 'vertical',
    theme: 'novel-serif',
    ink: 'mono',
    bodyFont: THEME_BODY_FONT['novel-serif'],
    fontPt: t.fontPt,
    lineFeedPt: t.lineFeedPt,
    margins: t.margins,
    columns: 1,
    columnGapLines: 1,
    toc: true,
    sceneBreak: DEFAULT_SCENE_BREAK,
    epubTarget: 'kdp',
    printTarget: 'kdp',
    spineInsetMm: 1.0,
    estimatedPages: 120,
    bgOpacity: 0.25,
    nombreSlot: 'bottom-fore',
    runningHeadSlot: 'bottom-center',
    // 奥付は書誌を読ませる場所なので、既定では絵を敷かない
    colophonBg: { base: 'plain' },
    textOutline: 0,
    textOutlineColor: '#ffffff',
    textPlate: 0,
    textPlateColor: '#ffffff',
    textColor: '#000000',
    plates: [],
    columnPages: [],
  };
}

// ---- 原稿 ----

export type Block =
  | {
      type: 'p';
      text: string;
      /**
       * 行末寄せ。原稿の行のあたまに `>>` と書いた行(importers/txt.ts の
       * detectEndAlignLine)。**あとがき・前書きの署名や日付のためのもの。**
       *
       * > P38は最後の名前が行頭になっているけど、これを行末に移動することはできないのかなあ
       * > (2026-08-20 ユーザー)
       *
       * 和文の作法では、署名と日付は行末に寄せる。**「行末」は組み方向で変わる** —
       * 縦組みなら地(下)、横組みなら右。物理の左右で書かず、CSS の論理値に任せる
       * (typeset/css.ts の p.align-end を見ること)。
       *
       * 値を `'end'` の1つだけにしてあるのは、行頭寄せ = 既定なので指定が要らず、
       * 中央寄せは本文には使わない(大扉・奥付が持つ体裁で、原稿の記法にはしない)ため
       */
      align?: 'end';
    }
  | { type: 'space' } // 場面転換の1行アキ
  | { type: 'h3'; text: string } // 小見出し(節)
  /**
   * 引用。行のあたまに `> ` と書いた行(Markdown と同じ)。
   *
   * **続けて書かれた引用行はつなげず、1行を1ブロックにする。**
   * Markdown の仕様どおりに1つの段落へ畳むと、詩や短歌のように
   * 行そのものに意味がある引用が平らに潰れてしまう。
   * 続けて置いたときのアキは組版側でマージンが相殺されるので広がらない
   */
  | { type: 'quote'; text: string }
  /**
   * 箇条書き。連続する行を1つのブロックにまとめる。
   *
   * **マーカー(・/１．)は持たない。** 紙・EPUB・Word で同じ文字を出す必要があるので、
   * 書き出すときに listMarker() で付ける。原稿の文字列に混ぜてしまうと、
   * Word へ書き出して取り込み直したときに二重に付く
   */
  | {
      type: 'list';
      items: string[];
      ordered?: boolean;
      /**
       * 番号つきの最初の番号。**原稿の最初の項目に書いてあった数**(importers/txt.ts の openList)。
       * 無ければ 1(この項目ができる前の保存はみな 1 から数えていた)。1 のときは書かない。
       *
       * 「３．二つだけ決める」のあとに「・」の項目が2つはさまり、「４．Create」に戻る原稿で、
       * 並びをはさんだ後ろの番号つきが「１．」から数え直されていた(2026-10-02)。
       * 箇条書きの入れ子は平らにする決まりなので(importers/docx.ts)、番号は書いてある数で続ける
       */
      start?: number;
    }
  /**
   * 区切り線。`---` か `***` **だけ**の行。
   *
   * **判定は取込(importers)で、行を丸ごと見て済ませる。**
   * 本文の文字列として残すと typeset/text.ts の normalizeDashes が
   * `-{2,}` を2倍ダッシュ「――」に変えるため、組版まで届いた時点では
   * もう線として見分けられない(ダッシュの変換そのものは正しいので text.ts は触らない)
   */
  | { type: 'hr' }
  /** 本文中の画像。src は data URI(IndexedDB に JSON で保存するため文字列で持つ)。
   * 既定は版面内に収める。full=true のときだけ、そのページを1枚で占める全面画像になる */
  | ImageBlock;

/**
 * 本文中の画像。**段落と段落のあいだに置く1枚。**
 *
 * もとは Word 原稿に貼った絵を取り込むためだけの形だった。2026-09-23 から、
 * スタジオの［挿絵］でも章の途中へ直に置けるようにした(ユーザー判断「Word の機能なんか
 * つくらずに、挿絵を追加する機能自体を改修してほしい」)。Word 書き出しはそのとき撤去した。
 *
 * 位置は**配列の中の並び**だけで持つ(どの段落のあとか)。ページ番号は持たない —
 * 判型や段組みを変えても、絵は同じ場面について回る(挿絵ページが章の切れ目に
 * 限られていた理由の片方は、ページ番号で置いていたことだった)。
 */
export interface ImageBlock {
  type: 'image';
  /** data URI。絵をまだ選んでいない枠は空文字(組版には出ない) */
  src: string;
  alt?: string;
  caption?: string;
  /** そのページを1枚で占める全面画像(塗り足しまで) */
  full?: boolean;
  /**
   * 1ページを使う、余白つきの絵。挿絵ページの「余白すこし／余白おおめ／版面いっぱい」と同じ見た目。
   * `full` が立っていればそちらが勝つ。どちらも無ければ本文の流れの中に収める
   */
  size?: Exclude<PlateSize, 'full' | 'spread'>;
  /**
   * **スタジオの画面で置いた絵か。** 原稿ファイルには入っていないので、
   * 原稿を取り込み直すと消える。取り込み直すときに、この印の付いた絵だけを
   * 前の段落の文字を手がかりに同じ場所へ付け直す(models/inlineImages.ts)。
   * Word 原稿に貼ってあった絵は原稿の側から戻ってくるので付けない
   */
  fromStudio?: boolean;
  /** 同梱のプリセットから選んだ絵か(BgSpec.fromPreset と同じ用途。KDP の AI 申告に使う) */
  fromPreset?: boolean;
  /**
   * **この絵の中の文字は、版面の外に出ていてよい**(利用者がそう言った。2026-10-02)。
   * 絵の中の文字が版面(余白の内側)の外に出ていると知らせる検査(src/textcheck)を、この絵では止める。
   * 文字ではない模様を文字と見たとき・分かったうえでそのまま出すときのための逃げ道。絵を差し替えたら消す
   */
  textOk?: boolean;
}

/**
 * 箇条書きのマーカー。**紙・EPUB・Word の3か所で同じ文字を出すためにここへ置く。**
 *
 * - 並びは中黒「・」1字。CSS の list-style は使わない(縦組みでは行の外に落ちる)
 * - 番号つきは**全角の「１．」**。半角数字は縦組みで寝てしまううえ、
 *   縦中横(text.ts の applyTcy)は本文にしか掛からずマーカーは通らない。
 *   全角にしておけば、どの経路でもそのまま正立する
 * - 番号は start(箇条書きの最初の番号。無ければ 1)から数える
 */
export function listMarker(index: number, ordered?: boolean, start?: number): string {
  if (!ordered) return '・';
  const n = String(listStart(start) + index).replace(/[0-9]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) + 0xfee0),
  );
  return `${n}．`;
}

/** 箇条書きの最初の番号。数として使えない値(壊れた保存など)は 1 に倒す — 紙に「NaN．」を刷らない */
export function listStart(start: unknown): number {
  return typeof start === 'number' && Number.isSafeInteger(start) && start >= 0 ? start : 1;
}

/** `<ol>` に付ける start 属性。1 から数えるときは付けない(読み上げや、マーカーを読まない機械のため) */
export function listStartAttr(b: { ordered?: boolean; start?: number }): string {
  const n = listStart(b.start);
  return b.ordered && n !== 1 ? ` start="${n}"` : '';
}

/**
 * マーカーがぶら下がる字数。2行目以降はこのぶん下げて頭をそろえる。
 *
 * 番号つきが2字なのは「１．」の見たままの幅。**10 以上は「１０．」で3字になる**が、
 * ぶら下げは2字で固定する。可変にすると同じ箇条書きの中で頭の位置が段ちがいになり、
 * かえって読みにくい(2桁の行だけ本文の頭が1字ぶん先に出るが、マーカーとは重ならない)
 */
export function listHangEm(ordered?: boolean): number {
  return ordered ? 2 : 1;
}

export interface Chapter {
  /** 「第三章」のような番号部。なければ undefined */
  no?: string;
  title: string;
  blocks: Block[];
}

/**
 * 原稿に場面転換(`---`)が1つでもあるか。
 *
 * **帯に［場面転換］を出すかどうかの判定に使う。** 場面転換を1つも書いていない
 * 原稿でこれを選ばせても、どれを選んでも紙面は1ミリも動かない。
 * 「動かないものを押させると、押した意味を探して迷う」
 * (AI 生成コンテンツの申告をチェックからやめたときと同じ判断。2026-08-19)
 */
export function hasSceneBreak(chapters: Chapter[]): boolean {
  return chapters.some((ch) => ch.blocks.some((b) => b.type === 'hr'));
}

/**
 * 章ごとの背景。章の index で引く。
 * 原稿ではなく設定側に持つ。原稿を組み直しても消えないようにするため
 * (reparse は manuscript を作り直す)。
 * 指定のない章は本文の背景をそのまま使う。
 */
export type ChapterBackgrounds = Record<number, BgSpec>;

export interface Manuscript {
  title: string;
  author: string;
  /** 奥付の発行所。任意(個人出版では書かないことも多い) */
  publisher: string;
  chapters: Chapter[];
  /**
   * 著者紹介(奥付の上)。経歴や既刊を書く欄。空行で段落を分ける。空なら入れない。
   * 旧「あとがき」(`afterword`)から改めたもの。移行は migrateManuscript が持つ
   */
  authorProfile?: string;
  /** 奥付の発行日。空なら書き出した日を入れる */
  published?: string;
  /** 奥付の印刷所。任意 */
  printer?: string;
  /** 奥付の ISBN。任意 */
  isbn?: string;
  /** 奥付に足す行(1行1項目)。版数など、決まった欄に収まらないもの */
  colophonExtra?: string;
}

/**
 * 取り込んだ原稿ファイルそのもの。
 * 原稿は取込時にパースされて Manuscript として保存されるため、
 * あとから取込処理を直しても保存済みの中身は変わらない。
 * 組み直せるように元データを持っておく。
 */
export interface SourceFile {
  name: string;
  kind: 'txt' | 'md' | 'docx';
  /** txt/md は素のテキスト、docx は ArrayBuffer を Base64 にしたもの */
  data: string;
}

/**
 * ブラウザが表示できる画像形式か。
 *
 * mammoth は Word が持っている形式をそのまま data URI にする(images.dataUri が
 * element.contentType を使う)。Word は Excel や PowerPoint から貼った絵、図表、
 * SmartArt などを EMF / WMF で保存することがあり、これらはブラウザが描画できない。
 * <img> は出来るのに何も出ないので、原因が分からない不具合になりやすい。
 *
 * **空文字も表示できないものとして扱う。** AI 用の JSON で戻せなかった画像は
 * project/file.ts の fromProjectFile が src を空にして残す(枚数は読み込み時に警告する)。
 * ここで通すと、紙面に中身の無い <img> の枠が組まれてしまう
 */
export function isRenderableImage(src: string): boolean {
  if (!src) return false;
  const m = /^data:([^;,]+)/.exec(src);
  if (!m) return true; // data URI 以外は判定しない
  return /^image\/(png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml)$/i.test(m[1]);
}

/** 表示できない画像の形式名(利用者への説明用)。判定できなければ空文字 */
export function imageFormatLabel(src: string): string {
  const m = /^data:image\/([^;,]+)/.exec(src);
  return m ? m[1].replace(/^x-/, '').toUpperCase() : '';
}

export function emptyManuscript(): Manuscript {
  return { title: '', author: '', publisher: '', chapters: [] };
}
