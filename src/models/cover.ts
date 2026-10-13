// 表紙のデータ型と寸法計算。
// KDP ペーパーバックの表紙は「表4 + 背 + 表1」を1枚のPDFにする。
//   幅 = 塗り足し + 判型幅 + 背幅 + 判型幅 + 塗り足し
//   高 = 塗り足し + 判型高 + 塗り足し
//   背幅 = ページ数 × 用紙の厚み
// 電子書籍の表紙は表1だけの画像(1600×2560px 推奨・RGB)。

import { PRINT_TARGETS, TRIM_SIZES, spineInsetOf, type Binding, type PrinterPaper, type PrintTarget, type TrimId } from './project';

/**
 * 用紙の種類と1ページあたりの厚み(mm)。KDP 規定。
 * ink は本文の刷り色。KDP の入稿では「インクと用紙のタイプ」をまとめて選ぶので、
 * 白黒の本にカラー用紙を選ぶ組み合わせは存在しない
 */
export const PAPER_TYPES = {
  white: { label: '白色用紙', mmPerPage: 0.0572, ink: 'mono' },
  cream: { label: 'クリーム色用紙', mmPerPage: 0.0635, ink: 'mono' },
  colorPremium: { label: 'プレミアムカラー', mmPerPage: 0.0596, ink: 'color' },
  colorStandard: { label: '標準カラー', mmPerPage: 0.0572, ink: 'color' },
} as const;
export type PaperType = keyof typeof PAPER_TYPES;

/** その刷り色で選べる用紙 */
export function papersFor(ink: 'mono' | 'color'): PaperType[] {
  return (Object.keys(PAPER_TYPES) as PaperType[]).filter((k) => PAPER_TYPES[k].ink === ink);
}

/**
 * 表紙の塗り足し(mm)。KDP は四方 3.2mm。表紙は必ず裁ち落としで作る。
 * **「その他の印刷所」は利用者の決めた幅(PrintRules.bleedMm)に変わる**(2026-10-01)ので、
 * 描画と寸法は定数を直に読まず `CoverLayout.bleed` を読む。これは省略したときの値(KDP)
 */
export const COVER_BLEED_MM = 3.2;
/** 切れては困る要素を置ける内側の余白(mm)。外縁から 6.4mm 以上 */
export const COVER_SAFE_MM = 6.4;
/** 電子書籍の表紙(KDP 推奨) */
export const EBOOK_COVER_PX = { w: 1600, h: 2560 };
/** 印刷解像度 */
export const COVER_DPI = 300;

export const mmToPx = (mm: number, dpi: number = COVER_DPI) => Math.round((mm * dpi) / 25.4);

/**
 * 表紙を書き出すときの画素の倍率。表紙の座標は 300dpi で組む(COVER_DPI)が、出し先の目安(imagePpi)が
 * それより細かいとき(会社の imagePpi が 350 など)は、書き出す画素だけ増やす。300 以下の出し先は 1(従来のまま)
 */
export const coverOutputScale = (imagePpi: number) => Math.max(1, imagePpi / COVER_DPI);

/**
 * 文字を絵の上で読ませるための下ごしらえ。
 * - auto    地の明るさから 白帯/黒帯/なし を決める
 * - custom  帯の色を自分で選ぶ
 * - outline 帯を敷かず、字にフチを付ける(絵をいちばん隠さない)
 * - none    何もしない
 */
export type BandKind = 'auto' | 'custom' | 'outline' | 'none';

/** あらすじの下ごしらえ。書名側と考え方は同じだが、既定が「なし」なので別の型にする */
export type BlurbDecor = 'none' | 'band' | 'outline';

/**
 * 書名・著者名を置く位置。9か所から選ぶ。
 * auto は綴じ方向まかせ(縦組みなら右上、横組みなら中央上)。
 * 絵の主役に文字がかぶるときは、絵を作り直すより位置を動かすほうが早い。
 */
/**
 * 表紙の書体。本文はテーマ側で固定なので、ここは表紙だけの設定。
 * いずれも SIL Open Font License 1.1 で同梱している
 */
export const COVER_FONTS = {
  serif: { label: '明朝（標準）', stack: '"Noto Serif JP", serif', bold: 700 },
  shippori: { label: 'しっぽり明朝｜文芸・和', stack: '"Shippori Mincho", serif', bold: 700 },
  zenOld: { label: 'Zen 旧明朝｜格調・古典', stack: '"Zen Old Mincho", serif', bold: 700 },
  klee: { label: 'Klee｜教科書体・やわらかい', stack: '"Klee One", serif', bold: 600 },
  yuji: { label: '佑字 肅｜筆書き・時代/怪異', stack: '"Yuji Syuku", serif', bold: 400 },
  gothic: { label: 'ゴシック（標準）', stack: '"Noto Sans JP", sans-serif', bold: 700 },
  zenMaru: { label: 'Zen 丸ゴシック｜日常・児童', stack: '"Zen Maru Gothic", sans-serif', bold: 700 },
  dot: { label: 'ドット｜SF・ゲーム', stack: '"DotGothic16", monospace', bold: 400 },
  reggae: { label: 'Reggae One｜ポップ・強い', stack: '"Reggae One", cursive', bold: 400 },
} as const;
export type CoverFontId = keyof typeof COVER_FONTS;

export type CoverAnchor =
  | 'auto'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/**
 * 表紙の自分の画像(data URI)。画像のフォルダから同梱のプリセットの高解像度版(BOOTH の無料の高解像度版)を入れたとき、
 * またはプリセットをフォルダの高解像度版へ差し替えたときだけ、`fromPreset`(KDP の AI 申告に数える)と
 * `presetId`(その同梱の絵の id)を持つ。ふつうの自分の画像には付かない(2026-10-12 改修の希望 2)
 */
export type CoverImage = { kind: 'image'; src: string; fromPreset?: boolean; presetId?: string };

export type CoverBackground =
  | { kind: 'preset'; id: string }
  | CoverImage
  | { kind: 'solid'; color: string };

/**
 * 表4・背・表1をまたぐ1枚の絵。
 *
 * 市販の本の多くがこの作りで、「絶対入れたくなる」と利用者から要望が出た(2026-08-18)。
 * **面ごとの地とは排他**にする。どちらが出るのか曖昧になると事故るので、
 * これが入っているあいだ background / backCover / spineColor は使わない。
 *
 * 単色は選べない。全面を単色にしたいなら、面ごとの地を同じ色にすれば済む
 */
export type CoverWrap = { kind: 'preset'; id: string } | CoverImage;

export interface CoverSettings {
  paper: PaperType;
  /**
   * 印刷所から知らされた背幅(mm)。**出し先が KDP 以外のときだけ使う。**(2026-09-27 ユーザー判断
   * 「全部の印刷所を調べて対応するのは現実的じゃない。合わないときは自分で入れさせた方がいい」)。
   * 印刷所ごとに紙も厚みも違うので、スタジオは印刷所の表を持たず、出た数字を入れてもらう。
   * 空(undefined)なら、KDP の紙の厚み × ページ数の目安を使う。KDP は計算の決まりが1つなので、いつも自動
   */
  spineMmFromPrinter?: number;
  /** 印刷所の背幅を入れたときの本文のページ数。ページ数が変わったら確かめ直しを促す */
  spineMmPages?: number;
  /**
   * 会社の本文用紙・表紙用紙(PrinterPaper の id)。**用紙の一覧を持つ会社(PRINT_TARGETS の papers)だけで使う**。
   * 背幅の目安と控えに使う。空や一覧に無い id なら、一覧の先頭(printerPapersOf)。KDP の用紙(paper)とは別に覚える
   */
  printerBodyPaper?: string;
  printerCoverPaper?: string;
  /**
   * 表紙全体に敷く1枚。**あるときは面ごとの地より優先する。**
   * 背の位置は本文のページ数で動くので、絵のどこが背に来るかは画面で示す必要がある
   */
  wrap?: CoverWrap;
  /**
   * まるごと1枚をやめたときの**控え**。作り方を切り替えても選んだ絵を失わないための置き場
   * (2026-09-04 ユーザー要望「切り替えたらまるごと1枚の表紙が出てこなくなった」)。
   * 「まるごと1枚から作る」へ戻ると wrap へ戻される。描画はこの欄を一切見ない
   */
  wrapSaved?: CoverWrap;
  /**
   * **いま選んでいないほうの作り方**の飾り(帯・文字の位置と大きさと色・あらすじの飾り)の控え。
   * 作り方を切り替えるとき、COVER_MODE_KEYS の欄とまるごと入れ替える(swapCoverModeLook)。
   *
   * 面ごとの絵と1枚絵では文字の読ませ方がまるで違うのに、この欄が共通だったので
   * 「どっちにも帯が入る。面ごとは帯が不要で、まるごとは帯が必要。別の作業にしたい」
   * (2026-09-04 ユーザー要望)。wrap ⇄ wrapSaved と同じ理屈で、飾りも控えを持つ。
   * **描画はこの欄を一切見ない。** 初回の切り替えでは控えが無いので、いまの飾りを持って移る
   */
  modeStash?: CoverModeLook;
  /**
   * どちらの作り方か。**表紙設定の中に持つ**のが肝心 —
   * コンポーネントの state に置いていたら、Ctrl+Z が飾りと絵だけを戻して
   * モードの見かけが取り残され、次の切り替えで両モードの飾りが逆向きに
   * 入れ替わって恒久的に交差した(2026-09-04 レビューで実証)。
   * ここに置けば undo・読み込み(replaceProject)が飾りと**同じ1手で**戻す。
   * 無い(古い保存)ときは wrap の有無から推定する。描画はこの欄を見ない
   * (刷るものは wrap の有無で決まる。「まるごとを選んだが絵は未選択」でも落ちない)
   */
  mode?: 'faces' | 'wrap';
  /** 表1の地 */
  background: CoverBackground;
  /** 表4の地。表1とは独立して指定する(同じ絵にしたいなら同じものを選ぶ) */
  backCover: CoverBackground;
  /** 背の地の色 */
  spineColor: string;
  /**
   * 背に文字を刷るか。**背幅が足りない本では、画面にこの欄そのものを出さない**
   * (computeCoverLayout の spineTextAllowed を参照)
   */
  spineTextOn: boolean;
  /** 背だけで使う書名。空なら本の書名。**改行は使わない**(背は1本の線) */
  spineTitle: string;
  /** 背に著者名も刷るか */
  spineAuthorOn: boolean;
  /** 背の地(下端)に版元名を刷るか */
  spinePublisherOn: boolean;
  /** 背の文字の書体 */
  spineFont: CoverFontId;
  spineTextColor: string;
  /**
   * 背の**書名**の大きさ(倍)。1倍で、置ける幅の7割ほどを字が占める。
   * **下は 7pt で床、上は背幅と天地(字数)の両方で頭打ち**(fitSpine が面倒をみる)。
   *
   * **2026-08-22 まではこれ1つで3つとも動いていた**(著者名・版元名は書名から
   * SPINE_SUB_RATIO で導いていた)。古い保存はこの値のままなので、
   * migrateCoverSettings が下の2つへ同じ刷り上がりになる値を入れる
   */
  spineScale: number;
  /** 背の**著者名**の大きさ(倍)。既定は書名の 0.72 倍(SPINE_SUB_RATIO.author) */
  spineAuthorScale: number;
  /** 背の**版元名**の大きさ(倍)。既定は書名の 0.6 倍(SPINE_SUB_RATIO.publisher) */
  spinePublisherScale: number;
  /**
   * 背の文字を横に倒す(90度回して1行で流す)。既定は1字ずつ縦に積む。
   * 和書の背は縦積みが普通だが、欧文混じりの書名は倒すほうが読める
   */
  spineSideways: boolean;
  /**
   * 表1に書名・著者名を入れるか(2026-10-13 ユーザー要望「表紙にタイトルと著者名を入れた画像を自分で用意したい」)。
   * **false のときは、表1に書名・著者名も、その下に敷く帯も描かない**(下見・紙の表紙 PDF・電子書籍の表紙 JPEG・EPUB の表紙)。
   * 背の文字(spineTextOn)・表4のあらすじ・大扉・奥付・EPUB の書誌には効かない。
   * 省略(この欄より前の保存)は入れる(今までどおり)。読むときは coverFrontTextOn を通す。
   *
   * **作り方ごとの控え(COVER_MODE_KEYS)には入れない。** 誰が書名を書くか(絵か本ちゃか)は本の中身の決めごとで、
   * 背の文字の有無(spineTextOn)・書名の改行(titleOverride)・書体と同じ側にある。切り替えるたびに
   * 書名が出たり消えたりすると、見えている表紙と覚えている設定が食い違って見える。1つの欄を両方の作り方で使う
   */
  frontTextOn?: boolean;
  band: BandKind;
  /** band が custom のときの帯色 */
  bandColor: string;
  bandOpacity: number;
  /**
   * 帯のふちをぼかす(2026-09-27 ユーザー要望「帯をぼやっとさせたい。真四角より情緒がある」)。
   * 省略・false は今までどおりの四角い帯。古い保存は持っていないので、刷り上がりは変わらない
   */
  bandSoft?: boolean;
  /** band が outline のときのフチ色 */
  bandOutlineColor: string;
  /**
   * 表紙だけで使う書名。改行を入れると意味の切れ目で行(縦組みなら列)を変えられる。
   * 空なら本の書名をそのまま使い、幅に合わせて自動で折り返す。
   * 大扉・奥付・EPUB の書誌には影響させない(改行が入ると困るため)
   */
  titleOverride: string;
  titleColor: string;
  titleScale: number;
  /** 書名を置く位置。絵の主役を避けたいときに動かす */
  titleAnchor: CoverAnchor;
  /**
   * 位置の微調整(mm)。9か所+おまかせのパッドで決めた位置から、さらに少しずらす
   * (2026-09-04 ユーザー要望「画像によって、あと少しずらしたいってことが起こる」)。
   * 正の値で右/下へ。描画は安全領域にクランプするので、大きくしても断裁にはかからない
   */
  titleDx?: number;
  titleDy?: number;
  /** 書名の書体。物語の雰囲気に合わせて選ぶ */
  titleFont: CoverFontId;
  authorColor: string;
  authorScale: number;
  /** 著者名を置く位置 */
  authorAnchor: CoverAnchor;
  /** 著者名の位置の微調整(mm)。titleDx/titleDy と同じ約束 */
  authorDx?: number;
  authorDy?: number;
  /** 著者名の書体 */
  authorFont: CoverFontId;
  /** 表4のあらすじ(任意) */
  blurb: string;
  /** あらすじの書体。書名・著者名と揃えたいことが多いので独立して選べる */
  blurbFont: CoverFontId;
  /** あらすじの読ませ方。地を敷くか、字にフチを付けるか、何もしないか */
  blurbDecor: BlurbDecor;
  blurbBandColor: string;
  blurbBandOpacity: number;
  /** blurbDecor が outline のときのフチ色 */
  blurbOutlineColor: string;
}

/**
 * 「面ごとに作る」⇄「まるごと1枚から作る」で**別の値を持つ**欄。
 *
 * 入れるのは**絵に対して文字を読ませるための欄**だけ:
 * 帯、書名・著者名の位置と大きさと色、あらすじの飾り。
 * 本の中身である欄(書名の改行・あらすじの文章・書体・背の文字)は**入れない** —
 * それらは作り方を替えても同じ本だから、切り替えで変わったら困る
 */
export const COVER_MODE_KEYS = [
  'band',
  'bandColor',
  'bandOpacity',
  'bandSoft',
  'bandOutlineColor',
  'titleAnchor',
  'titleScale',
  'titleColor',
  'titleDx',
  'titleDy',
  'authorAnchor',
  'authorScale',
  'authorColor',
  'authorDx',
  'authorDy',
  'blurbDecor',
  'blurbBandColor',
  'blurbBandOpacity',
  'blurbOutlineColor',
] as const;
export type CoverModeKey = (typeof COVER_MODE_KEYS)[number];
/**
 * モードの控えの束。Partial なのは、壊れた保存から欄ごとに捨てられるようにするため
 * (sanitizeCoverModeLook)。無い欄は入れ替えのとき動かさない=いまの値を持って移る
 */
export type CoverModeLook = Partial<Pick<CoverSettings, CoverModeKey>>;

/**
 * 作り方を切り替えるときの patch を作る。**いまの飾りを控えへ、控えの飾りを現物へ。**
 * 控えが無い(初回の切り替え)ときは、いまの飾りをそのまま持って移る —
 * 既定へ倒すと「位置を決めたのに切り替えたら消えた」になる。以後は別々に育つ
 */
export function swapCoverModeLook(s: CoverSettings): Partial<CoverSettings> {
  const mine: CoverModeLook = {};
  for (const k of COVER_MODE_KEYS) (mine as Record<string, unknown>)[k] = s[k];
  return { ...(s.modeStash ?? {}), modeStash: mine };
}

/**
 * 表1に書名・著者名(と帯)を描くか。**省略(古い保存)は描く。** false のときだけ描かない
 * (描画・画面・書体の読み込みがみなここを通す。2026-10-13 ユーザー要望)
 */
export function coverFrontTextOn(s: Pick<CoverSettings, 'frontTextOn'>): boolean {
  return s.frontTextOn !== false;
}

/** titleAnchor / authorAnchor に入れてよい値。CoverAnchor 型と同じ並び */
export const COVER_ANCHORS: readonly CoverAnchor[] = [
  'auto',
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

/**
 * 読み込んだ modeStash を漉す。**切り替えた瞬間に settings へ流し込まれる**ので、
 * AI や手書きで壊れた値が入っていると、そこで初めて描画が落ちる。欄ごとに検めて、
 * 読めない欄だけ黙って捨てる(無い欄は「動かさない」になるだけで害がない)
 */
export function sanitizeCoverModeLook(v: unknown): CoverModeLook | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: CoverModeLook = {};
  const num = (x: unknown, lo: number, hi: number) =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : undefined;
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
  const anchor = (x: unknown) => (COVER_ANCHORS.includes(x as CoverAnchor) ? (x as CoverAnchor) : undefined);

  if (o.band === 'auto' || o.band === 'custom' || o.band === 'outline' || o.band === 'none') out.band = o.band;
  if (o.blurbDecor === 'none' || o.blurbDecor === 'band' || o.blurbDecor === 'outline') out.blurbDecor = o.blurbDecor;
  const set = <K extends CoverModeKey>(k: K, val: CoverModeLook[K] | undefined) => {
    if (val !== undefined) out[k] = val;
  };
  set('bandColor', str(o.bandColor));
  set('bandOutlineColor', str(o.bandOutlineColor));
  set('titleColor', str(o.titleColor));
  set('authorColor', str(o.authorColor));
  set('blurbBandColor', str(o.blurbBandColor));
  set('blurbOutlineColor', str(o.blurbOutlineColor));
  set('bandOpacity', num(o.bandOpacity, 0, 1));
  if (typeof o.bandSoft === 'boolean') out.bandSoft = o.bandSoft;
  set('blurbBandOpacity', num(o.blurbBandOpacity, 0, 1));
  // 倍率の床と天井は画面のスライダーより広め。値が大きいだけなら描画は落ちない
  set('titleScale', num(o.titleScale, 0.1, 5));
  set('authorScale', num(o.authorScale, 0.1, 5));
  // 微調整(mm)。描画側で安全領域にクランプするので、床と天井はゆるくてよい
  set('titleDx', num(o.titleDx, -100, 100));
  set('titleDy', num(o.titleDy, -100, 100));
  set('authorDx', num(o.authorDx, -100, 100));
  set('authorDy', num(o.authorDy, -100, 100));
  set('titleAnchor', anchor(o.titleAnchor));
  set('authorAnchor', anchor(o.authorAnchor));
  return out;
}

/**
 * 保存済みの表紙設定を現在の形へ直す。**古い保存を開いても刷り上がりが変わらないこと**が決まり。
 *
 * 1. 2026-08-16 まで あらすじは `blurbBand: boolean`(地を敷くか)だった。
 *    「地 / フチ / なし」の3択にしたので、真偽値から移し替える。
 * 2. 2026-08-22 まで背文字の大きさは `spineScale` 1つで、著者名・版元名は描画のたびに
 *    書名 × SPINE_SUB_RATIO で導いていた。3つ別々にしたので、**その積を書き下ろす。**
 *    倍率を掛けた値をそのまま入れるので、開き直しても同じ大きさで刷れる
 * 3. 2026-10-13 に frontTextOn(表1に書名・著者名を入れるか)が入った。無い保存は既定(入れる)で今までどおり。
 *    true / false 以外が入っていたら入れる側へ倒す(書名が消えた表紙を黙って刷らない。読み込みの .json は
 *    project/file.ts の sanitize が先に知らせて直す)
 */
export function migrateCoverSettings(saved: Record<string, unknown>): Partial<CoverSettings> {
  const out: Partial<CoverSettings> = {};
  if (saved.blurbDecor === undefined && typeof saved.blurbBand === 'boolean') {
    out.blurbDecor = saved.blurbBand ? 'band' : 'none';
  }
  if (saved.frontTextOn !== undefined && typeof saved.frontTextOn !== 'boolean') out.frontTextOn = true;
  const scale = typeof saved.spineScale === 'number' && saved.spineScale > 0 ? saved.spineScale : 1;
  if (saved.spineAuthorScale === undefined) out.spineAuthorScale = scale * SPINE_SUB_RATIO.author;
  if (saved.spinePublisherScale === undefined) {
    out.spinePublisherScale = scale * SPINE_SUB_RATIO.publisher;
  }
  return out;
}

export function defaultCoverSettings(): CoverSettings {
  return {
    paper: 'white',
    background: { kind: 'solid', color: '#1b2b45' },
    backCover: { kind: 'solid', color: '#1b2b45' },
    spineColor: '#16243a',
    spineTextOn: false,
    spineTitle: '',
    spineAuthorOn: true,
    spinePublisherOn: false,
    spineFont: 'serif',
    spineTextColor: '#ffffff',
    spineScale: 1,
    spineAuthorScale: SPINE_SUB_RATIO.author,
    spinePublisherScale: SPINE_SUB_RATIO.publisher,
    spineSideways: false,
    // 表1に書名・著者名を入れる(2026-10-13)。既定へ入れておくのは［すべてリセット］で戻すため(setCover はマージ型)
    frontTextOn: true,
    band: 'auto',
    bandColor: '#ffffff',
    bandOpacity: 0.85,
    bandOutlineColor: '#ffffff',
    titleOverride: '',
    titleColor: '#141c2e',
    titleScale: 1,
    titleAnchor: 'auto',
    // 微調整も既定へ入れておく。setCover はマージ型なので、
    // ここに無い欄は［すべてリセット］で戻らない(modeStash の教訓と同じ)
    titleDx: 0,
    titleDy: 0,
    titleFont: 'serif',
    authorColor: '#141c2e',
    authorScale: 1,
    authorAnchor: 'auto',
    authorDx: 0,
    authorDy: 0,
    authorFont: 'serif',
    blurb: '',
    blurbFont: 'serif',

    blurbDecor: 'none',
    blurbBandColor: '#ffffff',
    blurbBandOpacity: 0.85,
    blurbOutlineColor: '#ffffff',
  };
}

export interface CoverLayout {
  /** 塗り足し(mm)。四辺とも同じ幅。描画もこの値を見る(KDP は 3.2、印刷所は利用者の決めた幅) */
  bleed: number;
  /** 塗り足しを含む全体(mm) */
  totalW: number;
  totalH: number;
  /** 背幅(mm) */
  spine: number;
  /** 各面の左右位置(mm)。塗り足しを含む座標系 */
  back: { x0: number; x1: number };
  spineArea: { x0: number; x1: number };
  front: { x0: number; x1: number };
  /** 300dpi でのピクセル数 */
  px: { w: number; h: number };
  /** 表1だけを切り出したときのピクセル数(自前画像の推奨サイズ) */
  frontPx: { w: number; h: number };
  /**
   * 背の縁から空けるアキ(mm)。出し先で決まる(KDP は 1.6 固定)。
   * **描画も画面もこの値を見る**ので、表示と刷り上がりが食い違いようがない
   */
  spineInset: number;
  /**
   * 背に文字を刷れるか。**2つの条件をどちらも満たしたときだけ true。**
   *   1. 出し先の規定 - KDP は "We only print spine text on books with more than 79 pages."
   *      よその印刷所にこの決まりは無いので、ページ数では止めない
   *   2. 読める大きさになるか - 背幅からアキを引いた残りに 7pt が入るか(出し先を問わない)
   * KDP の79ページは1を満たすが2を満たさない(上限 3.7pt)。**そこは刷らせない。**
   */
  spineTextAllowed: boolean;
  /** 背幅が印刷所から知らされた数字か(false なら ページ数 × 紙の厚み の目安) */
  spineFromPrinter: boolean;
  /**
   * 中綴じの表紙のときだけ true。**背が無い**(spine = 0。表4と表1を直結した1枚。横幅は 塗り足し＋判型幅×2＋塗り足し)。
   * 折り目は真ん中。背文字・背のタブ・背幅の欄は出さない(2026-10-03)。
   * **無線綴じのときは項目そのものを付けない**(layout-matrix の指紋が JSON 全体の md5 なので、false を足しても変わってしまう)
   */
  saddle?: true;
  /**
   * 表4の右下に空けておくバーコードの場所(mm)。**会社が自動で刷るときだけ**入る(KDP)。
   * null なら空けない(あらすじが表4の下端まで使える)。会社ごとの値は PRINT_TARGETS
   */
  barcode: { w: number; h: number } | null;
  /** 右綴じ(縦組み)。表1が左、表4が右になる */
  rightBound: boolean;
}

/**
 * 背に文字を刷れるか。**2つの条件を見る。**
 *   1. 出し先の規定 - KDP は "We only print spine text on books with more than 79 pages."
 *      よその印刷所にこの決まりは無いので、ページ数では止めない
 *   2. 読める大きさになるか - 背幅からアキを引いた残りに 7pt が入るか。**こちらは出し先を問わない**
 *      (細い背文字は本の見栄えをかえって落とす、というのがこのアプリの判断)
 */
function spineTextAllowedFor(
  spine: number,
  pages: number,
  print: { target?: PrintTarget; spineInsetMm?: number },
): boolean {
  const target = print.target ?? 'kdp';
  const inset = spineInsetOf(target, print.spineInsetMm ?? SPINE_TEXT_INSET_MM);
  // 会社の規定(KDP は80ページから)。規定の無い会社はページ数では止めない
  const min = PRINT_TARGETS[target]?.spineTextMinPages;
  if (min !== undefined && pages < min) return false;
  // 会社の規定の背幅(spineTextMinMm)
  const minMm = PRINT_TARGETS[target]?.spineTextMinMm;
  if (minMm !== undefined && spine < minMm) return false;
  return spineTextBox(spine, 1, false, inset).maxPt >= SPINE_MIN_PT;
}

/**
 * 出し先に応じた、背の縁のアキ(mm)。会社が決めている値(KDP は 1.6)は動かせない。
 * 中身は models/project.ts の spineInsetOf(会社ごとの決まりは PRINT_TARGETS が持つ)
 */
export function spineInsetFor(target: PrintTarget, spineInsetMm: number): number {
  return spineInsetOf(target, spineInsetMm);
}

/** 印刷所から知らされた背幅を使うか。背幅を印刷所が知らせる出し先(asksPrinterSpine)だけ。KDP は計算の決まりが1つなので自動 */
export function usesPrinterSpine(target: PrintTarget, spineMm: number | undefined, binding: Binding = 'perfect'): boolean {
  // 中綴じに背は無い。入れてある印刷所の数字は消さずに無視する(無線に戻せば元の数字が使える)
  if (binding === 'saddle') return false;
  return PRINT_TARGETS[target]?.asksPrinterSpine === true && typeof spineMm === 'number' && Number.isFinite(spineMm) && spineMm > 0;
}

/** 会社の用紙の選び(CoverSettings の printerBodyPaper / printerCoverPaper) */
export interface PrinterPaperChoice {
  body?: string;
  cover?: string;
}

/**
 * いま選んでいる会社の用紙。**用紙の一覧を持たない会社(KDP・その他の印刷所)は null。**
 * 選んでいない・一覧に無い id は、一覧の先頭に丸める(画面・背幅・控えが同じ答えを使う)
 */
export function printerPapersOf(
  target: PrintTarget,
  choice: PrinterPaperChoice = {},
): { body: PrinterPaper; cover: PrinterPaper } | null {
  const list = PRINT_TARGETS[target]?.papers;
  if (!list || list.body.length === 0 || list.cover.length === 0) return null;
  return {
    body: list.body.find((x) => x.id === choice.body) ?? list.body[0],
    cover: list.cover.find((x) => x.id === choice.cover) ?? list.cover[0],
  };
}

/**
 * 背幅(mm)。**表紙の寸法・書き出しの控え・入稿前チェックが、みなこれ1つを使う。**
 * 印刷所の数字があれば(asksPrinterSpine の出し先のとき)それを、なければ目安:
 * - 用紙の一覧を持つ会社 … 本文ページ数 ÷ 2 × 本文用紙の厚さ ＋ 表紙用紙の厚さ × 2(会社の式。ノリは足さない)
 * - それ以外 … ページ数 × 紙1枚の厚み(KDP の値)
 */
export function coverSpineMm(
  pages: number,
  paper: PaperType,
  target: PrintTarget,
  spineMm?: number,
  binding: Binding = 'perfect',
  choice: PrinterPaperChoice = {},
): number {
  // 中綴じは背が無い(紙を重ねて真ん中を留める。ページ数にも用紙にも依らない)
  if (binding === 'saddle') return 0;
  if (usesPrinterSpine(target, spineMm)) return spineMm as number;
  const own = printerPapersOf(target, choice);
  if (own) return (Math.max(0, pages) / 2) * own.body.mm + own.cover.mm * 2;
  return Math.max(0, pages) * (PAPER_TYPES[paper] ?? PAPER_TYPES.white).mmPerPage;
}

export function computeCoverLayout(
  trim: TrimId,
  pages: number,
  paper: PaperType,
  /**
   * 右綴じ(縦組みの本)かどうか。
   * 表紙は本を開いた向きに巻きつく1枚なので、綴じ方向で表1と表4の左右が入れ替わる。
   *   左綴じ(横組み): 表4 | 背 | 表1   ← 表1が右
   *   右綴じ(縦組み): 表1 | 背 | 表4   ← 表1が左
   */
  rightBound = false,
  /**
   * 紙の出し先。**背文字の決まりと塗り足しが、これで変わる。**
   * 判型も背幅の計算も、出し先では変わらない。
   * `bleedMm` は印刷所の決まりの塗り足し幅(省略は KDP の 3.2)。呼ぶ側は
   * `printRulesOf(settings)?.bleedMm ?? COVER_BLEED_MM` を渡す(表紙は四辺とも同じ幅)
   */
  print: {
    target?: PrintTarget;
    spineInsetMm?: number;
    spineMm?: number;
    bleedMm?: number;
    binding?: Binding;
    /** 会社の用紙(用紙の一覧を持つ会社だけ。背幅の目安に効く) */
    papers?: PrinterPaperChoice;
  } = {},
): CoverLayout {
  const t = TRIM_SIZES[trim] ?? TRIM_SIZES.bunko;
  const b =
    typeof print.bleedMm === 'number' && Number.isFinite(print.bleedMm) && print.bleedMm >= 0
      ? print.bleedMm
      : COVER_BLEED_MM;
  const target = print.target ?? 'kdp';
  const binding = print.binding ?? 'perfect';
  const spineFromPrinter = usesPrinterSpine(target, print.spineMm, binding);
  const spine = coverSpineMm(pages, paper, target, print.spineMm, binding, print.papers);

  const totalW = b + t.w + spine + t.w + b;
  const totalH = b + t.h + b;

  const left = { x0: 0, x1: b + t.w };
  const spineArea = { x0: b + t.w, x1: b + t.w + spine };
  const right = { x0: b + t.w + spine, x1: totalW };

  return {
    bleed: b,
    totalW,
    totalH,
    spine,
    back: rightBound ? right : left,
    spineArea,
    front: rightBound ? left : right,
    px: { w: mmToPx(totalW), h: mmToPx(totalH) },
    // 表1は「判型幅 + 外側の塗り足し」×「判型高 + 天地の塗り足し」
    frontPx: { w: mmToPx(t.w + b), h: mmToPx(totalH) },
    spineInset: spineInsetFor(print.target ?? 'kdp', print.spineInsetMm ?? SPINE_TEXT_INSET_MM),
    spineTextAllowed: binding !== 'saddle' && spineTextAllowedFor(spine, pages, print),
    spineFromPrinter,
    ...(binding === 'saddle' ? { saddle: true as const } : {}),
    barcode: PRINT_TARGETS[print.target ?? 'kdp']?.barcodeMm ?? null,
    rightBound,
  };
}

/**
 * KDP が求める、背の縁と文字のあいだのアキ(mm)。**1ミリも縮めない。**
 *
 * KDP の一次情報(Create a Paperback Cover / Paperback Submission Guidelines):
 *   "Text on larger spines must be sized to fit the spine, with at least
 *    0.0625" (1.6 mm) of space between the text and the edge of the spine."
 *   "Every book varies slightly when bound. Allow for 0.0625" (1.6 mm) variance
 *    on either side of the fold lines for your cover."
 *
 * **回り込みは却下の理由になる。** 綴じたときの折り位置が最大このくらいずれるので、
 * ここを削ると文字が表1・表4へ回り込んで刷られる。**アキを詰めて字を稼ぐ道は無い。**
 */
export const SPINE_TEXT_INSET_MM = 1.6;

/**
 * 背に刷ってよい最小の文字(pt)。KDP が本文の下限として挙げている値。
 * これを下回るくらいなら**刷らないほうがよい** - 細い背文字は本の見栄えをかえって落とす。
 */
export const SPINE_MIN_PT = 7;

/**
 * 1倍のときに字が占める、置ける幅に対する割合。
 *
 * **0.78 から 0.70 へ下げた**(2026-08-21 ユーザー「タイトルこんなに大きく出るの？」)。
 * 293ページの実原稿(背 16.76mm・置ける幅 13.56mm)で 0.78 は 30.0pt、
 * 背幅に対して字が 63% を占めて左右のアキが 1.5mm ずつしか残らなかった。
 * 0.70 なら 26.9pt で、アキは 2.0mm ずつ。市販の文庫の見え方に近い。
 *
 * **KDP は大きさの上限を決めていない。** 規則は「80ページ以上」と「縁から1.6mm」の2つだけ。
 * ここは組版としての判断であって、入稿の可否には関わらない。
 */
const SPINE_RATIO = { vertical: 0.7, sideways: 0.64 };

/**
 * 書名に対する、著者名と版元名の大きさの割合。
 *
 * **前は3つとも同じ大きさで刷っていた**(2026-08-21 ユーザー指摘
 * 「タイトルと著者名が同じ大きさなのがちょっと気になる。ふつうはタイトルがやや大きいはず」)。
 * 和書の背は 書名 > 著者名 > 版元名 の順で小さくなるのが定番。
 */
export const SPINE_SUB_RATIO = { author: 0.72, publisher: 0.6 };
/** 倍率をいくつにしても、これを超えて太らせない(背から出さないための頭打ち) */
const SPINE_RATIO_CAP = 0.98;

export const mmToPt = (mm: number) => (mm * 72) / 25.4;
export const ptToMm = (pt: number) => (pt * 25.4) / 72;

export interface SpineTextBox {
  /** 背の縁から空けるアキ(mm) */
  inset: number;
  /** 文字を置ける幅(mm) */
  width: number;
  /** その倍率で実際に使う字の大きさ(pt) */
  pt: number;
  /** 幅いっぱいまで太らせたときの大きさ(pt)。この背で出せる上限 */
  maxPt: number;
  /** 1倍では 7pt に届かないので、下限まで持ち上げてある */
  raised: boolean;
}

/**
 * 背の文字の置き場と大きさ。**画面と描画で同じ答えを使う**ために、ここに1つだけ持つ。
 *
 * 背幅(白色用紙)と、出せる大きさの関係:
 *   79ページ  背 4.52mm -> 置ける幅 1.32mm -> 上限  3.7pt  <- KDP の下限だが読めない
 *   100ページ 背 5.72mm -> 置ける幅 2.52mm -> 上限  7.0pt  <- ここでようやく 7pt
 *   112ページ 背 6.41mm -> 置ける幅 3.21mm -> 1倍で 7.1pt
 *   200ページ 背11.44mm -> 置ける幅 8.24mm -> 1倍で 18.2pt
 */
/**
 * その用紙で、背に 7pt を刷れるようになる最小ページ数。
 * **KDP の80ページと、読める大きさになるページ数の、遅いほう。**
 * 白色用紙で100ページ、クリーム色用紙で91ページ、プレミアムカラーで96ページ。
 */
export function spineTextMinPages(
  paper: PaperType,
  inset = SPINE_TEXT_INSET_MM,
  target: PrintTarget = 'kdp',
  choice: PrinterPaperChoice = {},
): number {
  // 会社の規定の背幅(spineTextMinMm)があれば、それにも届く背幅
  const need = Math.max(ptToMm(SPINE_MIN_PT) / SPINE_RATIO_CAP + inset * 2, PRINT_TARGETS[target]?.spineTextMinMm ?? 0);
  // 用紙の一覧を持つ会社は、会社の式(ページ数 ÷ 2 × 本文用紙 ＋ 表紙用紙 × 2)を解く。偶数ページに切り上げる
  const own = printerPapersOf(target, choice);
  const pages = own
    ? Math.max(0, Math.ceil((need - own.cover.mm * 2) / own.body.mm) * 2)
    : Math.ceil(need / (PAPER_TYPES[paper] ?? PAPER_TYPES.white).mmPerPage);
  // 下限は会社の規定(KDP は80ページ)。規定の無い会社は背幅だけで決まる
  const min = PRINT_TARGETS[target]?.spineTextMinPages;
  return min !== undefined ? Math.max(min, pages) : pages;
}

export function spineTextBox(
  spine: number,
  scale = 1,
  sideways = false,
  /** 背の縁から空けるアキ(mm)。KDP は 1.6 固定、よその印刷所はその指定に従う */
  insetMm = SPINE_TEXT_INSET_MM,
): SpineTextBox {
  const inset = Math.max(0, insetMm);
  const width = Math.max(0, spine - inset * 2);
  const ratio = sideways ? SPINE_RATIO.sideways : SPINE_RATIO.vertical;
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const maxPt = mmToPt(width * SPINE_RATIO_CAP);
  const want = mmToPt(width * ratio * k);
  // 7pt へは持ち上げるが、背から出してまで太らせはしない
  const pt = Math.min(maxPt, Math.max(want, Math.min(SPINE_MIN_PT, maxPt)));
  return { inset, width, pt, maxPt, raised: want < SPINE_MIN_PT && maxPt >= SPINE_MIN_PT };
}

// ---------------------------------------------------------------------------
// 背文字の「ぎりぎり」を決める
//
// **背文字の大きさには縛りが2つある。** 片方しか見ていないと画面が嘘をつく。
//
//   1. 背幅(横) … 縁から 1.6mm 空けた残りに字幅が入るか。spineTextBox の maxPt。
//                 **KDP の規定はこちら**(回り込みは却下の理由になる)
//   2. 天地(縦) … 字数 × 行送りが紙の高さに入るか。**規定ではなく算数。**
//                 ここに入らなければ描画側が縮めるか、字を切るしかない
//
// 2026-08-22 まで画面は 1 しか見ておらず、字数の多い本で食い違っていた
// (実測・文庫・白色用紙・KDP。scripts/check-spine.py):
//
//   297ページ・書名7字   画面 27.36pt → 実際に刷るのは 22.41pt
//   200ページ・書名22字  画面 16.35pt → 実際に刷るのは 11.45pt
//
// **2つの縛りをまとめてここで解き、画面も描画も同じ答えを使う。**
// ---------------------------------------------------------------------------

/** 背の文字の行送り。1本の線なので本文より詰める */
export const SPINE_LEADING = 1.02;
/** 書名と著者名・版元名のあいだ(書名の字1つぶん × この値) */
export const SPINE_GAP = 1.4;
/** 背に刷ってよい最小の文字(300dpi のピクセル)。7pt を下回るなら刷らずに切る */
export const SPINE_MIN_PX = mmToPx(ptToMm(SPINE_MIN_PT));
/** 300dpi のピクセルを pt に直す(画面へ出すのは pt) */
export const pxToPt = (px: number) => (px * 72) / COVER_DPI;

/** 背に積む3段。空文字なら刷らない */
export interface SpineRuns {
  title: string;
  author: string;
  publisher: string;
}
/** 3段それぞれの倍率、あるいは大きさ(px)。同じ形なので使い回す */
export interface SpineTriple {
  title: number;
  author: number;
  publisher: number;
}

export interface SpineFitInput {
  /** 背に文字を置ける幅(px)。背幅からアキを引いたもの */
  widthPx: number;
  /** 背の長手方向に使える長さ(px)。塗り足しと安全領域を引いたもの */
  availPx: number;
  sideways: boolean;
  runs: SpineRuns;
  /** 利用者が決めた3つの倍率 */
  scales: SpineTriple;
  /**
   * その大きさ(px)で組んだときの文字列の長さ(px)。**横倒しのときだけ本物が要る。**
   * 渡さないときは「和文の字面はほぼ正方形」として字数から見積もる
   */
  measure?: (text: string, sizePx: number) => number;
}

export interface SpineFit {
  /** 実際に刷る大きさ(px)。天地に入らなければ、ここで既に縮めてある */
  sizes: SpineTriple;
  /** 天地(字数)に入らず、指定の倍率より縮めたか */
  shrunk: boolean;
  /**
   * **3つの割合を保ったまま、あと何倍にできるか。** 1.00 ならもうぎりぎり。
   * ［ぎりぎりまで大きく］はこの値を3つの倍率に掛けるだけでよい。
   * 1 を下回るときは、いまの指定が入りきっていない(掛ければ収まる)
   */
  headroom: number;
  /** 上限まで大きくしたときの書名の大きさ(px) */
  limitTitlePx: number;
  /** その上限を決めたのは、背幅(width)か、字数(height)か */
  limitedBy: 'width' | 'height';
}

/** 縦に n 文字積んだときの長さ(1文字目の天から最終文字のベースラインまで) */
export function spineRunPx(chars: number, sizePx: number): number {
  return chars <= 0 ? 0 : sizePx + (chars - 1) * sizePx * SPINE_LEADING;
}

/** 3段ぜんぶで、背の長手方向に要る長さ(px)。**描画の置き方とそろえてある** */
function spineExtentPx(
  sizes: SpineTriple,
  runs: SpineRuns,
  sideways: boolean,
  measure: (text: string, sizePx: number) => number,
): number {
  const run = (s: string, size: number) =>
    s ? (sideways ? measure(s, size) : spineRunPx(s.length, size)) : 0;
  // アキは書名の字1つぶんで測る(書名・著者名で幅が違っても間は同じにしたい)
  const gap = sizes.title * SPINE_GAP;
  const head = run(runs.title, sizes.title) + (runs.author ? gap + run(runs.author, sizes.author) : 0);
  const pub = run(runs.publisher, sizes.publisher);
  return head + (pub ? pub + gap : 0);
}

/**
 * 背文字の大きさを決める。**画面と描画で同じ答えを使うために、ここに1つだけ持つ。**
 *
 * 3つの倍率はそのままの割合で扱う。天地に入らなければ**3つとも同じ割合で**縮め、
 * それ以上は縮めずに(下限 7pt)描画側が字を切る。
 */
export function fitSpine(input: SpineFitInput): SpineFit {
  const { widthPx, availPx, sideways, runs, scales } = input;
  const ratio = sideways ? SPINE_RATIO.sideways : SPINE_RATIO.vertical;
  const capPx = Math.max(0, widthPx) * SPINE_RATIO_CAP;
  // 背が細すぎて 7pt が入らない本では、**下限より背幅を優先する**(背から出さない)。
  // そもそも spineTextAllowed が false になるので、ここへは来ないはず
  const minPx = Math.min(SPINE_MIN_PX, capPx);
  const num = (v: number, or: number) => (Number.isFinite(v) && v > 0 ? v : or);
  const base: SpineTriple = {
    title: widthPx * ratio * num(scales.title, 1),
    author: widthPx * ratio * num(scales.author, SPINE_SUB_RATIO.author),
    publisher: widthPx * ratio * num(scales.publisher, SPINE_SUB_RATIO.publisher),
  };
  // 和文の字面はほぼ正方形なので、実測が無いときは字数 × 大きさで見積もる
  const measure = input.measure ?? ((t: string, sz: number) => spineRunPx(t.length, sz));
  const clamp = (v: number) => Math.min(capPx, Math.max(minPx, v));
  const at = (g: number): SpineTriple => ({
    title: clamp(base.title * g),
    author: clamp(base.author * g),
    publisher: clamp(base.publisher * g),
  });
  const fits = (g: number) => spineExtentPx(at(g), runs, sideways, measure) <= availPx;

  const biggest = Math.max(base.title, base.author, base.publisher);
  // 幅で頭打ちになる倍。これ以上いくら上げても字は太らない
  const gCap = biggest > 0 ? capPx / biggest : 1;
  // これ以下はすべて下限に貼り付くので、探しても何も変わらない
  const gLo = biggest > 0 ? minPx / biggest : 1;

  let headroom: number;
  let limitedBy: 'width' | 'height';
  if (fits(gCap)) {
    headroom = gCap;
    limitedBy = 'width';
  } else if (!fits(gLo)) {
    // 7pt まで落としても入らない。これ以上は字を切るしかない(描画側が切って知らせる)
    headroom = gLo;
    limitedBy = 'height';
  } else {
    // 入る/入らないの境目を挟み撃ちにする。40回で 10^-12 まで詰まる
    let lo = gLo;
    let hi = gCap;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    headroom = lo;
    limitedBy = 'height';
  }

  // 指定どおりで入るなら 1倍のまま。入らないぶんは headroom まで縮める
  const g = Math.min(1, headroom);
  return {
    sizes: at(g),
    shrunk: g < 0.9995,
    headroom,
    limitTitlePx: at(headroom).title,
    limitedBy,
  };
}
