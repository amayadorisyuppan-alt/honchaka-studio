import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { SHOP_PACKS_LABEL } from '../shop';
import { PDFDocument } from 'pdf-lib';
import {
  PAPER_TYPES,
  computeCoverLayout,
  spineTextBox,
  spineTextMinPages,
  papersFor,
  swapCoverModeLook,
  SPINE_MIN_PT,
  type CoverAnchor,
  type CoverBackground,
  type CoverWrap,
  coverOutputScale,
  mmToPx,
} from '../models/cover';
import { coverPpi, fitWithin, judgePpi, resolutionNote, type CoverPart } from '../models/imageResolution';
import {
  INK_COLORS,
  PRINT_TARGETS,
  type Binding,
  type InkColor,
  type PrintTarget,
  type TrimId,
  type WritingMode,
  titleWritingModeOf,
} from '../models/project';
import { PRINT_MAX_SIDE, WRAP_MAX_SIDE, optimizeImageDataUri } from '../images/optimize';
import { isWrapPreset, loadCoverPresets } from '../covers/manifest';
import { ColorInput, ColorPaletteProvider } from './ColorInput';
import { useArtPalette } from '../images/usePalette';
import { PresetScreen, type PresetItem } from './PresetScreen';
import { ShopFoot } from './ShopFoot';
import {
  ensureCoverFonts,
  loadImage,
  renderEbookCover,
  renderPaperCover,
  type CoverText,
  type FrontInk,
  type SpinePrint,
} from '../cover/render';
import { downloadBlob } from '../exporters/download';
import { safeFileStem } from '../project/file';
import { convertPress } from '../press/press';
import { coverBoxes } from '../press/boxes';
import type { CoverPdfOptions, CoverPdfOutcome } from './PressCover';
import { useProject } from '../store/useProject';
import { Fold } from './Fold';
import { isLatinOnlyTitle } from '../typeset/text';
import { selfCoverNotes } from '../typeset/saddle';

interface Props {
  trim: TrimId;
  writingMode: WritingMode;
  /**
   * 書名・著者名の向き(縦組みの本で横書きにするとき。2026-10-03)。省略は本文に従う。
   * **綴じの向き・表1の左右は writingMode のまま**で、文字の向きだけを変える
   */
  titleWritingMode?: WritingMode;
  /** 本文の刷り色。選べる用紙がこれで決まる */
  ink: InkColor;
  /** 本文の実ページ数(背幅の計算に使う) */
  pages: number;
  /** 紙の出し先。**背文字の決まりと塗り足しがこれで変わる** */
  printTarget: PrintTarget;
  /**
   * 表紙の塗り足し(mm。四辺とも同じ幅)。KDP は 3.2、「その他の印刷所」は印刷所の決まりの幅
   * (App が `printRulesOf(settings)?.bleedMm ?? COVER_BLEED_MM` を渡す。2026-10-01)
   */
  bleedMm: number;
  /** 背の縁から空けるアキ(mm)。出し先の会社が決めているとき(KDP は 1.6)は無視される */
  spineInsetMm: number;
  /**
   * 綴じ方(App が bindingOf で決めた、いま効いているもの。2026-10-03)。**中綴じには背が無い**:
   * 表紙は 表4と表1を直結した1枚(横幅 塗り足し + 判型の幅 × 2 + 塗り足し)・折り目は真ん中・背のタブと背文字の欄は出さない
   */
  binding?: Binding;
  /** 中綴じの共紙か(表紙も本文と同じ紙。表1・表4 は本文 PDF の先頭と末尾のページに入る)。画面に一言添える */
  selfCover?: boolean;
  /**
   * 作るもの(models/project.ts の outputsOf)。**紙を作らない本には背・表4を出さない**
   * (電子書籍の表紙は表1だけ)。電子を作らない本には電子の表紙の見本を出さない。
   * 2026-09-23 ユーザー要望「自分が今必要としているものだけしか見えない」
   */
  makes: { paper: boolean; ebook: boolean };
  /** 見本の上に差し込むもの(書き出しの画面から来たときの［← 書き出しに戻る］) */
  topSlot?: ReactNode;
  title: string;
  author: string;
  publisher: string;
  /**
   * 表紙ステップを開いているか。
   *
   * 書き出しは「04 書き出し」から呼ぶので、このコンポーネントは**常にマウントしておく**。
   * ただし画面用のキャンバスを描き続けると、本文をいじっている間ずっと
   * 表紙の再描画が走ることになるので、見えていないときは描かない。
   * 書き出しはどちらも自前のキャンバスに描き直すので、これで困らない。
   */
  visible: boolean;
  /**
   * 表1の書名・著者名の色を、どう決めて刷ったか。**帯の色の欄で断るのに使う。**
   *
   * 濃い地では選んだ色が白に上書きされるが、それは**実際に描いてみないと分からない**
   * (画像の地は書名まわりの平均輝度を測って決めている)。判断した本人=描画側から
   * 上へ返し、App が帯へ渡す。ページ一覧から章番号を返すのと同じ配り方
   */
  onFrontInk?: (ink: FrontInk) => void;
  /**
   * 表紙の絵(表1・表4・まるごと1枚)から数えた色の並び。App が［表紙をデザインする］の帯の色の欄にも
   * 同じ並びを出すために受け取る(2026-10-03)
   */
  onPalette?: (colors: string[]) => void;
  /**
   * いま左で開いている面(表1・背・表4・まるごと1枚)。**画面下の帯が、その面の文字に向く。**(2026-10-09)
   * あらすじ・背の文字の見た目を帯へ移したので、開いている面と帯の向き先をそろえる
   */
  onPaneChange?: (pane: CoverPane) => void;
  /**
   * 書き出しの失敗を App へ返す。「04 書き出し」から呼ぶと CoverEditor は hidden で、
   * 内部の error 表示が見えない(押しても無反応に見える)。ここへ上げて、
   * サイドバーの常時表示エラーに載せる(2026-09-04 レビュー指摘)
   */
  onExportError?: (msg: string) => void;
}

/** 書き出しは「04 書き出し」ステップから呼ぶ */
export interface CoverEditorHandle {
  /**
   * 紙の表紙の PDF を保存する。**出し先が RGB を受け付けない印刷所なら、そのまま入稿用(CMYK・PDF/X-4)に変える**
   * (opts.rgb で変えずに保存もできる)。何を保存したかを返す(「04 書き出し」は CoverEditor が hidden なので、
   * 画面に出す報告は呼んだ側が持つ)
   */
  exportPaperPdf: (opts?: CoverPdfOptions) => Promise<CoverPdfOutcome>;
  exportEbookJpeg: () => Promise<void>;
  /**
   * 書き出し前の確認用の見本。
   * 表紙ステップを開かずにボタンを押すことになるので、何が出てくるのかを先に見せる。
   * 紙は書き出しと同じ条件(バーコードの仮はめなし)で描く。
   *
   * あらすじの溢れも一緒に返す。表紙ステップを一度も開いていないと画面の状態は
   * 更新されないので、**入稿前チェックはここで描き直した結果から読む**
   */
  renderPreviews: () => Promise<{
    paper: string;
    ebook: string;
    blurbOverflow: number;
    spineOverflow: number;
  }>;
  /**
   * EPUB に入れる電子書籍の表紙(実寸の JPEG data URI)。
   * KDP は表紙を別に受け取るが、楽天Kobo など EPUB を配本するストアは中に求める
   */
  ebookCoverDataUri: () => Promise<string>;
  /**
   * **中綴じの共紙**で、本文 PDF の先頭(表1)と末尾(表4)のページに入れる絵。(2026-10-03)
   * 書き出し用に描いた表紙(表4＋表1 を直結した1枚)から、本文の用紙と同じ大きさ(`page`・mm)で切り出す。
   * 小口の側の端をそろえて切るので、ノドの側には折り目の向こうの絵が少し入る(ノド側の塗り足し。断裁されない側)
   */
  renderFaces: (page: { w: number; h: number }) => Promise<{ front: string; back: string }>;
}

/**
 * public/covers/manifest.json の1件(scripts/build-covers.py が生成する)。
 * 一覧を出すのに要る項目(id・分類・テーマ・実体・サムネイル)は
 * PresetScreen 側の PresetItem に持たせてあるので、ここは**表紙だけが読む分**を足す
 */
interface PresetEntry extends PresetItem {
  /** テーマの機械可読な名前。画面に出すのは themeLabel のほう */
  theme: string;
  /** サムネイルの明るさ。帯の「おまかせ」で白帯/黒帯を決める材料 */
  lum: number;
}

/**
 * プリセットを選ぶ専用画面を、どの面のために開いているか。
 * null なら開いていない。**面ごとに設定の書き込み先が違う**ので、
 * 開いた面を覚えておかないと選ばれた絵をどこへ入れるか決められない
 */
type PresetTarget = 'front' | 'back' | 'wrap';

/** 専用画面の見出しに出す面の呼び名。副タブと同じ言葉にして、迷子にならないようにする */
const PRESET_TARGET_LABELS: Record<PresetTarget, string> = {
  front: '表1（おもて）',
  back: '表4（うら）',
  wrap: 'まるごと1枚',
};

const MM_TO_PT = 72 / 25.4;

/**
 * 表紙の副タブ。
 * 以前は 地/文字/うら という「属性」で切っていたが、初見ユーザーから
 * 「表1がどこだか分からない」と不満が出た(2026-08-18)。
 * 人は属性ではなく面(表1をやって→背→表4)で考えて作業するので、面を軸に切り直す。
 * 表1・表4はそれぞれ地と文字が両方あるが、背は文字を持たない(下の spineTextAllowed 参照)
 */
export type CoverPane = 'front' | 'spine' | 'back' | 'wrap';
/**
 * 面のタブ。**「まるごと1枚」はここに入れない。**(2026-08-19 ユーザー指摘)
 *
 * 面ごとの地とは**排他**なので、同じ並びに置くと「表1を選んでいるつもりで
 * まるごと1枚が効いている」という取り違えが起きる
 * (「同じタブでみていくと、操作を間違ってしまう」)。
 * 作り方そのものの分かれ道として、タブの上で先に選ばせる
 */
const COVER_PANES: [CoverPane, string][] = [
  ['front', '表1（おもて）'],
  ['spine', '背'],
  ['back', '表4（うら）'],
];

export const CoverEditor = forwardRef<CoverEditorHandle, Props>(function CoverEditor(
  {
    trim,
    writingMode,
    titleWritingMode,
    ink,
    pages,
    printTarget,
    bleedMm,
    spineInsetMm,
    binding = 'perfect',
    selfCover = false,
    makes,
    topSlot,
    title,
    author,
    publisher,
    visible,
    onFrontInk,
    onPalette,
    onPaneChange,
    onExportError,
  },
  ref,
) {
  // 表紙の設定は本文と同じく IndexedDB に自動保存する(リロードしても作った表紙が残る)
  const settings = useProject((s) => s.cover);
  const patch = useProject((s) => s.setCover);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [backImage, setBackImage] = useState<HTMLImageElement | null>(null);
  const [wrapImage, setWrapImage] = useState<HTMLImageElement | null>(null);
  // 表紙の絵の色(スポイトの代わり)。**まるごと1枚があるあいだは、面ごとの絵は描かれない**ので数えない
  const artSources = useMemo(
    () => (settings.wrap ? [wrapImage] : [image, backImage]),
    [settings.wrap, image, backImage, wrapImage],
  );
  const artPalette = useArtPalette(artSources, 8);
  useEffect(() => {
    onPalette?.(artPalette);
    // onPalette は App の useState の setter(同一参照)
  }, [artPalette, onPalette]);
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  /** あらすじが表4に入りきらなかった文字数。0 なら全部組めている */
  const [blurbOverflow, setBlurbOverflow] = useState(0);
  /** 背に入りきらなかった文字数。0 なら全部刷れている */
  const [spineOverflow, setSpineOverflow] = useState(0);
  /**
   * **背に実際に刷った大きさ。描画側から受け取る。**
   *
   * 背文字の縛りは2つ(背幅と天地)あり、字数の多い本では描画側が縮める。
   * 画面が spineTextBox の答えだけを出していたころは、そこで嘘をついていた
   * (2026-08-22。［ぎりぎりまで大きく］を押したのに小さく出る、が起きる)
   */
  const [spinePrint, setSpinePrint] = useState<SpinePrint | null>(null);
  const [error, setError] = useState('');
  const paperRef = useRef<HTMLCanvasElement>(null);
  const ebookRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const backFileRef = useRef<HTMLInputElement>(null);
  const wrapFileRef = useRef<HTMLInputElement>(null);

  /**
   * 背幅を決める用紙。**刷り色に合わない用紙を覚えていたら、合う用紙に丸める。**
   * ［本のかたちを決める］・書き出しの控えと同じ規則(2026-09-25 見直し S2-12: ここだけ丸めて
   * いなかったので、画面の背幅と書き出した表紙の背幅が食い違った)
   */
  const paper = papersFor(ink).includes(settings.paper) ? settings.paper : papersFor(ink)[0];
  // 縦組みの本は右綴じなので、表紙も表1が左・表4が右になる
  const layout = useMemo(
    () =>
      computeCoverLayout(trim, pages, paper, writingMode === 'vertical', {
        target: printTarget,
        spineInsetMm,
        // 印刷所から知らされた背幅。KDP のときは使わない(computeCoverLayout が見分ける)
        spineMm: settings.spineMmFromPrinter,
        bleedMm,
        binding,
        // 会社の用紙(用紙の一覧を持つ会社)。背幅の目安に効く
        papers: { body: settings.printerBodyPaper, cover: settings.printerCoverPaper },
      }),
    [trim, pages, paper, writingMode, printTarget, spineInsetMm, settings.spineMmFromPrinter, bleedMm, binding, settings.printerBodyPaper, settings.printerCoverPaper],
  );
  const saddle = binding === 'saddle';
  /** 出し先の絵の細かさの目安(ppi)。表紙の「必要な大きさ」・書き出しの画素・細かさの知らせの基準 */
  const imagePpi = PRINT_TARGETS[printTarget].imagePpi;
  /**
   * 表紙を書き出す細かさ(ppi)。表紙は文字ごと1枚の画像なので、文字の輪郭のために上げる会社がある
   * (coverPpi)。置く写真の細かさの目安は imagePpi のまま
   */
  const outputPpi = PRINT_TARGETS[printTarget].coverPpi ?? imagePpi;
  // 取り込みは長い辺を上限までに縮める(images/optimize.ts)ので、それを超える大きさは言わない
  const facePx = fitWithin(
    { w: mmToPx(layout.front.x1 - layout.front.x0, imagePpi), h: mmToPx(layout.totalH, imagePpi) },
    PRINT_MAX_SIDE,
  );
  const wrapPx = fitWithin({ w: mmToPx(layout.totalW, imagePpi), h: mmToPx(layout.totalH, imagePpi) }, WRAP_MAX_SIDE);
  /**
   * 背の文字の置き場と大きさ。**描画と同じ関数から取る。**
   * 画面が「8.1pt」と言っているのに刷り上がりが違う、という食い違いを作らないため
   */
  const spineBox = useMemo(
    () => spineTextBox(layout.spine, settings.spineScale, settings.spineSideways, layout.spineInset),
    [layout.spine, layout.spineInset, settings.spineScale, settings.spineSideways],
  );
  /**
   * 背に文字を刷らない理由。**止まった理由だけを言う。**(2026-10-09 全体確認: 会社の背幅の規定(spineTextMinMm)だけで
   * 止まっているのに「7.8pt までで、読める下限の 7pt に届きません」と言い、文が食い違っていた)
   * 判定(models/cover.ts の spineTextAllowedFor)と同じ順・同じ値で見る
   */
  const spineRule = PRINT_TARGETS[printTarget];
  const spineByPages = spineRule.spineTextMinPages !== undefined && pages < spineRule.spineTextMinPages;
  const spineByMm = spineRule.spineTextMinMm !== undefined && layout.spine < spineRule.spineTextMinMm;
  // 規定で止まっていないのに刷れないなら、理由は大きさ(念のための受け皿も兼ねる)
  const spineByPt =
    spineTextBox(layout.spine, 1, false, layout.spineInset).maxPt < SPINE_MIN_PT || !(spineByPages || spineByMm);
  /**
   * 画面に出す背文字の大きさ。**描画が実際に使った値をそのまま出す。**
   *
   * まだ一度も描いていないあいだだけ、幅の縛りだけで出した見込みで埋める
   * (spineTextBox は天地=字数の縛りを知らないので、字数の多い本では大きめに出る)
   */
  const spineShown: SpinePrint = spinePrint ?? {
    titlePt: spineBox.pt,
    authorPt: spineTextBox(layout.spine, settings.spineAuthorScale, settings.spineSideways, layout.spineInset).pt,
    publisherPt: spineTextBox(layout.spine, settings.spinePublisherScale, settings.spineSideways, layout.spineInset).pt,
    shrunk: false,
    headroom: 1,
    limitPt: spineBox.maxPt,
    limitedBy: 'width',
  };
  const titleVertical = titleWritingModeOf({ writingMode, titleWritingMode }) === 'vertical';
  const text: CoverText = useMemo(
    () => ({
      // 表紙だけ改行位置を変えたいときは titleOverride を使う(本の書名は変えない)
      title: settings.titleOverride.trim() || title,
      author,
      publisher,
      // 書名・著者名の向き。表1の位置・綴じ・背は writingMode から決まるので、ここだけが titleWritingMode を見る
      vertical: titleVertical,
    }),
    [settings.titleOverride, title, author, publisher, titleVertical],
  );

  // プリセット一覧(なければギャラリーを出さないだけで、他の機能は動く)。
  // 同梱ぶんと、自分で足した画像(manifest.mine.json)を繋げて読む。
  // **'cover' を渡して表紙に使える絵だけに絞る。** 帯つきの本文の地(use: 'body')は
  // 版面を基準に描いてあるので、表紙に敷いても帯の位置に意味が無い
  useEffect(() => {
    void loadCoverPresets('cover').then((list) => setPresets(list as PresetEntry[]));
  }, []);

  /** 背景設定から実際の画像URLを求める(単色のときは null) */
  function bgSrc(bg: CoverBackground): string | null {
    if (bg.kind === 'image') return bg.src;
    if (bg.kind === 'preset') {
      const file = presets.find((p) => p.id === bg.id)?.file;
      return file ? `covers/${file}` : null;
    }
    return null;
  }

  useEffect(() => {
    let alive = true;
    const src = bgSrc(settings.background);
    if (src) {
      loadImage(src)
        .then((img) => alive && setImage(img))
        .catch(() => alive && setError('表1の画像を読み込めませんでした'));
    } else {
      setImage(null);
    }
    return () => {
      alive = false;
    };
  }, [settings.background, presets]);

  // まるごと1枚。面ごとの地とは排他なので、これがあるあいだ表1・表4の絵は描かれない
  useEffect(() => {
    let alive = true;
    const w = settings.wrap;
    const src = w ? bgSrc(w as CoverBackground) : null;
    if (src) {
      loadImage(src)
        .then((img) => alive && setWrapImage(img))
        .catch(() => alive && setError('表紙全体の画像を読み込めませんでした'));
    } else {
      setWrapImage(null);
    }
    return () => {
      alive = false;
    };
  }, [settings.wrap, presets]);

  useEffect(() => {
    let alive = true;
    const src = bgSrc(settings.backCover);
    if (src) {
      loadImage(src)
        .then((img) => alive && setBackImage(img))
        .catch(() => alive && setError('表4の画像を読み込めませんでした'));
    } else {
      setBackImage(null);
    }
    return () => {
      alive = false;
    };
  }, [settings.backCover, presets]);

  useEffect(() => {
    // 表紙ステップを開いていないときは描かない(本文の編集中ずっと再描画が走るのを避ける)
    if (!visible) return;
    let alive = true;
    const input = { layout, settings, text, image, backImage, wrapImage };
    const draw = () => {
      if (!alive) return;
      if (paperRef.current) {
        const report = renderPaperCover(paperRef.current, input);
        setBlurbOverflow(report.blurbOverflow);
        setSpineOverflow(report.spineOverflow);
        setSpinePrint(report.spine);
        // **書体を読み込む前の1回目でも返す。** 色の判断に書体は関わらないので、
        // 待たせると「開いた直後だけ断り書きが出ない」という見え方になる
        onFrontInk?.(report.frontInk);
      }
      if (ebookRef.current) renderEbookCover(ebookRef.current, input);
    };
    // 書体が未読込のまま描くと黙って別の書体になる。読み込んでから描き直す
    draw();
    void ensureCoverFonts(settings, text).then(draw);
    return () => {
      alive = false;
    };
    // **wrapImage を落とすと「まるごと1枚」だけ絵が変わらない。**
    // 絵は非同期で読み込まれるので、設定が変わった直後の描画には間に合わず、
    // 読み込み終わりの state 更新で描き直すしかない。ここに wrapImage が無かったため、
    // ほかの操作で再描画が走るまで古い絵のままだった(2026-08-19 ユーザー報告
    // 「何回かあちこち押したら治った」)
    // onFrontInk は App の useState の setter(同一参照)なので、ここに入れても回らない
  }, [visible, layout, settings, text, image, backImage, wrapImage, onFrontInk]);

  async function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('読み込みに失敗しました'));
      r.readAsDataURL(file);
    });
  }

  async function handleImage(file: File, target: 'front' | 'back' | 'wrap') {
    setError('');
    // 表紙は1枚で数MBになる。刷るのに要る大きさまで縮め、透過を使っていない絵は高画質の JPEG にする
    // (images/optimize.ts)。「まるごと1枚」は表1・背・表4 にまたがるので上限を大きく取る。
    // 読めない画像(壊れている・画像でない)はここで断る(2026-09-25 見直し S2-16)
    let src: string;
    try {
      src = await optimizeImageDataUri(
        await readAsDataUrl(file),
        target === 'wrap' ? WRAP_MAX_SIDE : PRINT_MAX_SIDE,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (target === 'front') patch({ background: { kind: 'image', src } });
    else if (target === 'wrap') patch({ wrap: { kind: 'image', src } });
    else patch({ backCover: { kind: 'image', src } });
  }

  async function exportPaperPdf(opts: CoverPdfOptions = {}): Promise<CoverPdfOutcome> {
    setError('');
    try {
      opts.onProgress?.({ phase: 'draw' });
      // 書体が未読込だと黙って別の書体で書き出される
      await ensureCoverFonts(settings, text);
      // 画面用のキャンバスにはバーコードの目印が入っているので、書き出し用に描き直す
      const c = document.createElement('canvas');
      // 出し先の書き出しの細かさ(coverPpi)が 300 より細かいときは、書き出す画素を増やす(座標は同じ)
      renderPaperCover(c, { layout, settings, text, image, backImage, wrapImage, forExport: true, outputScale: coverOutputScale(outputPpi) });
      /*
       * **ふだんは劣化の無い PNG。大きくなりすぎるときだけ、最高画質の JPEG に切り替える。**
       * (2026-09-25 見直し S1-8、2026-09-26 ユーザーと決定)
       * 写真の「まるごと1枚」を A4 で作ると PNG の PDF が 52MB になった。KDP は表紙を 40MB 以下にするよう
       * 勧めている(上限は 650MB。大きいと処理が遅くなる)。印刷用 PDF の業界の既定も、写真は最高画質の JPEG。
       * 実測(その 52MB の表紙): JPEG 品質100 で 28MB、元との差は256段階で最大4(目では区別できない)。
       * 品質100でもまだ大きいときだけ、少しずつ下げる
       */
      const pdf = await PDFDocument.create();
      const PDF_SOFT_LIMIT = 38 * 1024 * 1024; // 40MB の手前(PDF の骨組みのぶんを残す)
      const bytesOf = (dataUri: string) => Math.floor(((dataUri.length - dataUri.indexOf(',') - 1) * 3) / 4);
      const png = c.toDataURL('image/png');
      let embedded;
      if (bytesOf(png) <= PDF_SOFT_LIMIT) {
        embedded = await pdf.embedPng(png);
      } else {
        let jpeg = '';
        for (const q of [1, 0.97, 0.94, 0.9]) {
          jpeg = c.toDataURL('image/jpeg', q);
          if (bytesOf(jpeg) <= PDF_SOFT_LIMIT) break;
        }
        embedded = await pdf.embedJpg(jpeg);
      }
      const w = layout.totalW * MM_TO_PT;
      const h = layout.totalH * MM_TO_PT;
      const page = pdf.addPage([w, h]);
      page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
      const bytes = await pdf.save();
      // pdf-lib は Uint8Array を返す。Blob に渡すため ArrayBuffer に写す
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      const stem = safeFileStem(title, 'cover');
      const profile = PRINT_TARGETS[printTarget];

      // 画面から外れた(中止された)あとは、何も保存しない
      if (opts.signal?.aborted) return { kind: 'error' };

      // KDP は RGB の PDF をそのまま受け付ける。印刷所でも、利用者が画面と同じ色(RGB)を選んだときはそのまま保存する
      if (profile.acceptsRgbPdf || opts.rgb) {
        const name = `${stem}_表紙.pdf`;
        downloadBlob(new Blob([buf], { type: 'application/pdf' }), name);
        return { kind: 'saved-rgb', name, bytes: buf.byteLength };
      }

      // **印刷所は RGB を受け付けない。** 作った PDF を、そのまま入稿用(CMYK・PDF/X-4・インク上限)に変える。
      // 変換の入り口は Worker へ所有権ごと渡すので、保存用に写しておく必要は無い(失敗しても RGB は作り直せる)。
      // 失敗は、理由を返して呼んだ側が RGB で保存する逃げ道を出す(ここで諦めて何も保存しないと、押しても何も出ない)
      let result;
      try {
        result = await convertPress(
          { kind: 'cover-cmyk', pdf: buf, boxes: coverBoxes(layout), title, inkLimit: profile.inkLimitPct },
          opts.onProgress ?? (() => {}),
          opts.signal,
        );
      } catch (e) {
        // 中止された(画面から外れた)ときは、失敗とも言わない。変換の失敗の文は、変換の側が日本語にしてある
        if (opts.signal?.aborted) return { kind: 'error' };
        return { kind: 'press-failed', message: e instanceof Error ? e.message : String(e) };
      }
      if (opts.signal?.aborted) return { kind: 'error' };
      const name = `${stem}_表紙_CMYK.pdf`;
      downloadBlob(new Blob([result.pdf as BlobPart], { type: 'application/pdf' }), name);
      return { kind: 'saved-cmyk', name, bytes: result.pdf.byteLength, ink: result.ink, issues: result.issues };
    } catch (e) {
      const msg = `表紙PDFの書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`;
      setError(msg);
      onExportError?.(msg);
      return { kind: 'error' };
    }
  }

  // 画面用のキャンバスは表紙ステップを開いていないと描かれていないので、
  // 紙PDFと同じく書き出し用に描き直す(こうしないと「04 書き出し」から呼んだとき白紙になる)
  async function exportEbookJpeg() {
    setError('');
    try {
      await ensureCoverFonts(settings, text);
      const c = document.createElement('canvas');
      renderEbookCover(c, { layout, settings, text, image, backImage, wrapImage });
      await new Promise<void>((resolve) => {
        c.toBlob(
          (blob) => {
            if (blob) downloadBlob(blob, `${safeFileStem(title, 'cover')}_電子書籍表紙.jpg`);
            resolve();
          },
          'image/jpeg',
          0.92,
        );
      });
    } catch (e) {
      {
        const msg = `電子書籍表紙の書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`;
        setError(msg);
        onExportError?.(msg);
      }
    }
  }

  /** 実寸のキャンバスを縮めて data URI にする(確認用なので JPEG で十分) */
  function shrink(c: HTMLCanvasElement, maxW: number): string {
    const scale = Math.min(1, maxW / c.width);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(c.width * scale));
    out.height = Math.max(1, Math.round(c.height * scale));
    out.getContext('2d')?.drawImage(c, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.8);
  }

  async function renderPreviews() {
    await ensureCoverFonts(settings, text);
    // **wrapImage を落とさないこと。** 「まるごと1枚」を選んでいると、
    // これが無い見本は表紙の絵が消えた姿になる(書き出されるものと食い違う)
    const input = { layout, settings, text, image, backImage, wrapImage };
    const paper = document.createElement('canvas');
    const report = renderPaperCover(paper, { ...input, forExport: true });
    const ebook = document.createElement('canvas');
    renderEbookCover(ebook, input);
    // 420 / 150 は 340px のサイドバーに収めていた頃の寸法。
    // いまはプレビュー(画面の右半分)に大きく出すので、そこで粗が見えない大きさにする
    return {
      paper: shrink(paper, 1400),
      ebook: shrink(ebook, 900),
      blurbOverflow: report.blurbOverflow,
      spineOverflow: report.spineOverflow,
    };
  }

  async function ebookCoverDataUri() {
    await ensureCoverFonts(settings, text);
    const c = document.createElement('canvas');
    renderEbookCover(c, { layout, settings, text, image, backImage, wrapImage });
    return c.toDataURL('image/jpeg', 0.9);
  }

  /** 共紙: 書き出し用に描いた表紙から、表1と表4を本文の用紙の大きさで切り出す(CoverEditorHandle.renderFaces) */
  async function renderFaces(page: { w: number; h: number }) {
    await ensureCoverFonts(settings, text);
    const c = document.createElement('canvas');
    renderPaperCover(c, { layout, settings, text, image, backImage, wrapImage, forExport: true, outputScale: coverOutputScale(outputPpi) });
    const pxPerMm = c.width / layout.totalW;
    const w = Math.min(c.width, Math.max(1, Math.round(page.w * pxPerMm)));
    const h = c.height;
    // 1枚のデータの大きさ。ふだんは劣化の無い PNG、大きすぎるときだけ最高画質の JPEG(exportPaperPdf と同じ決め)
    const FACE_SOFT_LIMIT = 16 * 1024 * 1024;
    const bytesOf = (dataUri: string) => Math.floor(((dataUri.length - dataUri.indexOf(',') - 1) * 3) / 4);
    const cut = (fromLeft: boolean): string => {
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const g = out.getContext('2d');
      if (!g) throw new Error('表紙の画像を切り出せませんでした');
      g.drawImage(c, fromLeft ? 0 : c.width - w, 0, w, h, 0, 0, w, h);
      const png = out.toDataURL('image/png');
      if (bytesOf(png) <= FACE_SOFT_LIMIT) return png;
      let jpeg = '';
      for (const q of [1, 0.97, 0.94, 0.9]) {
        jpeg = out.toDataURL('image/jpeg', q);
        if (bytesOf(jpeg) <= FACE_SOFT_LIMIT) break;
      }
      return jpeg;
    };
    // 右綴じ(縦組み)は表1が左・表4が右。表1は表の左端(小口)から、表4は右端(小口)から、本文の用紙の幅だけ切る
    const frontLeft = layout.rightBound;
    return { front: cut(frontLeft), back: cut(!frontLeft) };
  }

  useImperativeHandle(ref, () => ({
    exportPaperPdf,
    exportEbookJpeg,
    renderPreviews,
    ebookCoverDataUri,
    renderFaces,
  }));

  // 1.0 = 表紙全体が画面に収まる大きさ。細部を見たいときだけ上げる
  const [zoom, setZoom] = useState(1);
  const [pane, setPane] = useState<CoverPane>('front');
  /** 紙を作らない本では、背・表4の面は無い(開いていたら表1へ戻す) */
  // 中綴じには背が無いので、「背」のタブも出さない(2026-10-03)
  const panes = makes.paper
    ? COVER_PANES.filter(([id]) => !(saddle && id === 'spine'))
    : COVER_PANES.filter(([id]) => id === 'front');
  useEffect(() => {
    if (!makes.paper && (pane === 'spine' || pane === 'back')) setPane('front');
    if (saddle && pane === 'spine') setPane('front');
  }, [makes.paper, saddle, pane]);
  // プリセットの専用画面。開いているあいだサイドバーはこれ1枚になる(下の描画を参照)
  const [presetFor, setPresetFor] = useState<PresetTarget | null>(null);
  /**
   * 「まるごと1枚」で作っているか。**settings から導出する。state に持たない。**
   * useState に持っていたころ、Ctrl+Z が cover だけを戻して見かけのモードが
   * 取り残され、次の切り替えで swapCoverModeLook が逆向きに走って
   * 両モードの飾りが恒久的に交差した(2026-09-04 レビューで実証)。
   * mode が無い古い保存は wrap の有無から推定する(絵があるならまるごと)
   */
  const isWrap = (settings.mode ?? (settings.wrap ? 'wrap' : 'faces')) === 'wrap';

  /**
   * 副タブをモードに追従させる。ボタン経由の切り替えは自前で setPane しているが、
   * **undo・読み込みでもモードは動く**ので、外から変わったときにここで揃える
   * (wrapモードの本を開き直すと pane='front' のまま暗幕が掛かる、も同根で直る)
   */
  useEffect(() => {
    setPane((p) => (isWrap ? 'wrap' : p === 'wrap' ? 'front' : p));
  }, [isWrap]);
  // 開いている面を App へ(帯の向き先)。onPaneChange は App の setter(同一参照)
  useEffect(() => {
    onPaneChange?.(pane);
  }, [pane, onPaneChange]);

  /** その面がいま選んでいるプリセットの id。プリセット以外の地(単色・自前の画像)なら undefined */
  function selectedPresetId(target: PresetTarget): string | undefined {
    const ground: CoverBackground | CoverWrap | undefined =
      target === 'wrap'
        ? settings.wrap
        : target === 'front'
          ? settings.background
          : settings.backCover;
    return ground?.kind === 'preset' ? ground.id : undefined;
  }

  /** 選ばれた絵を、開いていた面の設定へ書き込む */
  function applyPreset(target: PresetTarget, id: string) {
    if (target === 'wrap') patch({ wrap: { kind: 'preset', id } as CoverWrap });
    else if (target === 'front') patch({ background: { kind: 'preset', id } });
    else patch({ backCover: { kind: 'preset', id } });
  }

  /** 9か所の位置を選ぶ小さな盤。絵の主役に文字がかぶるときに動かす */
  const AnchorPad = ({
    value,
    onChange,
  }: {
    value: CoverAnchor;
    onChange: (a: CoverAnchor) => void;
  }) => (
    <div className="anchor-pad">
      {(
        [
          'top-left',
          'top-center',
          'top-right',
          'middle-left',
          'middle-center',
          'middle-right',
          'bottom-left',
          'bottom-center',
          'bottom-right',
        ] as CoverAnchor[]
      ).map((a) => {
        // 英語トークン(top-left など)ではなく、日本語で読み上げ・ツールチップを出す
        const [v, h] = a.split('-');
        const jp =
          ({ top: '上', middle: '中央', bottom: '下' }[v] ?? '') +
          ({ left: '左', center: '中央', right: '右' }[h] ?? '');
        const label = jp === '中央中央' ? '中央' : jp;
        return (
          <button
            key={a}
            className={value === a ? 'active' : ''}
            title={label}
            aria-label={`文字の位置：${label}`}
            aria-pressed={value === a}
            onClick={() => onChange(a)}
          />
        );
      })}
      <button
        className={`anchor-auto ${value === 'auto' ? 'active' : ''}`}
        onClick={() => onChange('auto')}
      >
        おまかせ
      </button>
    </div>
  );

  /**
   * いま選んでいるプリセットを1枚だけ見せる欄。表1・表4・まるごと1枚で同じ形を使う。
   *
   * **絵の名前も出す。** サムネイルだけだと似た絵柄が並ぶパックでどれを選んだか分からず、
   * 一覧を開き直して確かめることになる
   */
  function ChosenPreset({ id, onOpen }: { id: string; onOpen: () => void }) {
    const hit = presets.find((p) => p.id === id);
    return (
      <div className="preset-chosen">
        {hit ? (
          <img src={`covers/${hit.thumb}`} alt={hit.themeLabel} />
        ) : (
          <span className="preset-chosen-empty">まだ選んでいません</span>
        )}
        <div className="preset-chosen-side">
          <button className="ghost" onClick={onOpen}>
            {hit ? 'ほかの画像に変える' : 'プリセットから選ぶ'}
          </button>
          {hit && (
            <p className="preset-chosen-name">
              {hit.groupLabel} / {hit.themeLabel}
            </p>
          )}
        </div>
      </div>
    );
  }

  /**
   * 表1・表4、どちらの面かで見た目は同じだが中身(background / backCover)が違う「地」の設定。
   * 以前はここに表1/表4を選ぶトグルがあり、面の副タブと二重に「どっちの面か」を選ばせていた。
   * いまは面の副タブ自体が target を決めるので、ここは呼ばれた面の分だけ描く
   */
  /** 表紙の絵の細かさの知らせ(1行)。足りているとき・紙を作らないときは出さない。**知らせるだけ** */
  function coverResNote(part: CoverPart, img: HTMLImageElement | null) {
    if (!img || !makes.paper) return null;
    const v = judgePpi(coverPpi({ w: img.naturalWidth, h: img.naturalHeight }, layout, part), imagePpi);
    const text = resolutionNote(v, PRINT_TARGETS[printTarget].label);
    return text ? (
      <p className="warn" role="status">
        {v.level === 'veryLow' && <b>細かさがかなり足りません。 </b>}
        {text}
      </p>
    ) : null;
  }

  function GroundSection({ target }: { target: 'front' | 'back' }) {
    const bg = target === 'front' ? settings.background : settings.backCover;
    const setBg = (next: CoverBackground) =>
      patch(target === 'front' ? { background: next } : { backCover: next });
    const inputRef = target === 'front' ? fileRef : backFileRef;
    return (
      <section>
        <h2>地（背景）</h2>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImage(f, target);
            e.target.value = '';
          }}
        />
        <div className="seg">
          <button
            className={bg.kind === 'solid' ? 'active' : ''}
            onClick={() => setBg({ kind: 'solid', color: bg.kind === 'solid' ? bg.color : '#1b2b45' })}
          >
            単色
          </button>
          <button className={bg.kind === 'image' ? 'active' : ''} onClick={() => inputRef.current?.click()}>
            自前の画像
          </button>
          {/* **押したらその場で一覧へ入る。** 以前はここで黙って1枚目に差し替わり、
              下に小さな一覧が生えるだけだった(選んだつもりのない絵が表紙になっていた) */}
          <button
            className={bg.kind === 'preset' ? 'active' : ''}
            onClick={() => setPresetFor(target)}
          >
            プリセット
          </button>
        </div>

        {bg.kind === 'solid' && (
          <label className="color-row">
            色
            <ColorInput value={bg.color} onChange={(e) => setBg({ kind: 'solid', color: e.target.value })} />
          </label>
        )}

        {/* **設定の列に一覧は置かない。** 340px の中で3列に並べると1枚が100px前後にしかならず、
            「画像が小さくて選びにくい」「バーが2つ並んで操作しづらい」と言われた
            (2026-08-19 ユーザー指摘)。選ぶのは専用画面(PresetScreen)に任せ、
            ここには**いま選んでいる1枚**だけを、押せば選び直せる形で残す */}
        {bg.kind === 'preset' && <ChosenPreset id={bg.id} onOpen={() => setPresetFor(target)} />}

        <p className="hint">
          自前の画像は <b>{facePx.w.toLocaleString()} × {facePx.h.toLocaleString()} px</b>
          ({imagePpi}dpi)が目安。縦横比が違っても中央を切り出して収めます
        </p>
        {bg.kind === 'image' && coverResNote(target, target === 'front' ? image : backImage)}
      </section>
    );
  }

  /**
   * 面(表1/背/表4)の左右範囲(mm)。プレビューに載せるフォーカス枠の元データ。
   *
   * **「まるごと1枚」はここに入れない。** 面ではなく全体なので、範囲を
   * 表紙いっぱいにして一覧へ混ぜたら、他の面を選んでいるあいだ
   * 「選ばれていない面」として**全面に暗幕が掛かった**(2026-08-18 に実害)。
   * まるごと1枚を選んでいるときは、どこも暗くせず背の位置だけを枠で示す
   */
  const FACES = (saddle ? ['front', 'back'] : ['front', 'spine', 'back']) as ('front' | 'spine' | 'back')[];
  const faceRanges: Record<'front' | 'spine' | 'back', { x0: number; x1: number }> = {
    front: layout.front,
    spine: layout.spineArea,
    back: layout.back,
  };
  /** プレビューの面をクリックしたときの読み上げ名。COVER_PANES と同じ言葉を使う */
  const FACE_LABELS: Record<'front' | 'spine' | 'back', string> = {
    front: '表1（おもて）',
    spine: '背',
    back: '表4（うら）',
  };

  /**
   * 書名・著者名の置き場所。**表1タブと「まるごと1枚」タブの両方に出す。**
   * 飾りがモード別になったので、まるごと側にも同じ操作が無いと
   * 「位置を変える手段そのものが無い」状態になる(2026-09-04 レビューで実証。
   * 分割前は面タブへ一時的に戻れば共有値が効いたが、いまは控えに入るだけで届かない)。
   *
   * コンポーネントにはせず JSX を1回作って両方に差す — render のたびに
   * 関数コンポーネントを作り直すと、Fold や textarea が remount されて入力が途切れる
   */
  const textPlacementSections = (
    <>
      {/* まず出すのは「位置」と「大きさ」だけ。
          絵の主役に文字がかぶったときに動かすのがこの画面の主用途で、
          色・書体・改行位置はそれが済んでから触るもの */}
      <section>
        <h2>書名</h2>
        {/* 縦書きの本のうち、横書きにしてあるとき、または英字だけの書名(縦に積むと読みにくい)のときだけ出す。
            ふつうの縦書きの本には要らない知らせなので出さない(2026-10-03 監査) */}
        {writingMode === 'vertical' && (!titleVertical || isLatinOnlyTitle(title)) && (
          <p className="hint">
            現在、書名と著者名は{titleVertical ? '縦書き' : '横書き'}です。向きは画面下の帯の「書名・著者名の向き」で変更できます。
          </p>
        )}
        <label className="stack">
          位置
          <AnchorPad value={settings.titleAnchor} onChange={(a) => patch({ titleAnchor: a })} />
        </label>
        <label>
          大きさ
          <span className="num">
            <input
              type="number"
              min={0.3}
              max={2}
              step={0.05}
              value={settings.titleScale}
              onChange={(e) => patch({ titleScale: Number(e.target.value) })}
            />
            倍
          </span>
        </label>
        {/* パッドの9か所+おまかせでは「あと少し」が届かない(2026-09-04 ユーザー要望
            「画像によって、あと少しずらしたいってことが起こる」)。mm で足し引きする */}
        <label>
          微調整
          <span className="num">
            <input
              type="number"
              aria-label="書名を左右にずらす(mm)"
              min={-100}
              max={100}
              step={0.5}
              value={settings.titleDx ?? 0}
              onChange={(e) => patch({ titleDx: Number(e.target.value) })}
            />
            <input
              type="number"
              aria-label="書名を上下にずらす(mm)"
              min={-100}
              max={100}
              step={0.5}
              value={settings.titleDy ?? 0}
              onChange={(e) => patch({ titleDy: Number(e.target.value) })}
            />
            mm
          </span>
        </label>
        <p className="hint">
          左の欄が左右（＋で右へ）、右の欄が上下（＋で下へ）。
          どれだけ動かしても、断裁や安全領域の手前で止まります
        </p>
        <Fold label="改行位置を決める" changed={Boolean(settings.titleOverride.trim())}>
          <label className="stack">
            改行位置
            <textarea
              rows={3}
              placeholder={title || '書名'}
              value={settings.titleOverride}
              onChange={(e) => patch({ titleOverride: e.target.value })}
            />
          </label>
          <p className="hint">
            改行したいところで <b>Enter</b> を押してください
            ({titleVertical ? '縦組みなら列が変わります' : '横組みなら行が変わります'})。空のままなら本の書名をそのまま使い、
            幅に合わせて自動で折り返します。ここで変えても大扉・奥付・EPUB の書名は変わりません
          </p>
        </Fold>
      </section>

      <section>
        <h2>著者名</h2>
        <label className="stack">
          位置
          <AnchorPad value={settings.authorAnchor} onChange={(a) => patch({ authorAnchor: a })} />
        </label>
        <label>
          大きさ
          <span className="num">
            <input
              type="number"
              min={0.5}
              max={2}
              step={0.05}
              value={settings.authorScale}
              onChange={(e) => patch({ authorScale: Number(e.target.value) })}
            />
            倍
          </span>
        </label>
        <label>
          微調整
          <span className="num">
            <input
              type="number"
              aria-label="著者名を左右にずらす(mm)"
              min={-100}
              max={100}
              step={0.5}
              value={settings.authorDx ?? 0}
              onChange={(e) => patch({ authorDx: Number(e.target.value) })}
            />
            <input
              type="number"
              aria-label="著者名を上下にずらす(mm)"
              min={-100}
              max={100}
              step={0.5}
              value={settings.authorDy ?? 0}
              onChange={(e) => patch({ authorDy: Number(e.target.value) })}
            />
            mm
          </span>
        </label>
        <p className="hint">
          <b>画像の主役に文字がかぶるときは位置を動かしてください</b>
        </p>
      </section>

      {/* 書名・著者名の帯(文字を読ませる)は画面下の帯だけに置く。(2026-10-09 ユーザー判断「デザインに関連する話は下のバーで」)
          2026-09-04 に「あらすじの帯が左にあるのに書名の帯だけ下にあると探す」と言われて左にも写したが、
          あらすじの見た目も帯へ移したので、写しはやめて帯の1か所にそろえた */}
    </>
  );

  /** あらすじ(本文・書体・飾り)。表4タブと「まるごと1枚」タブの両方に出す(理由は上と同じ) */
  const blurbSections = (
    <>
      <section>
        <h2>あらすじ</h2>
        <textarea
          rows={4}
          placeholder="あらすじ(任意)"
          value={settings.blurb}
          onChange={(e) => patch({ blurb: e.target.value })}
        />
        <p className="hint">書体や絵の上での読ませ方（地・フチ）は、画面下の帯（あらすじをデザインする）で変更できます</p>
        {blurbOverflow > 0 && (
          <p className="warn">
            あらすじが表4に入りきらないので <b>約{blurbOverflow}文字</b> を組めていません。
            断ち切りやバーコードにかからない範囲までしか組みません
          </p>
        )}
        {/* 空けるのは会社がバーコードを自動で刷るときだけ(layout.barcode。KDP)。
            その他の印刷所を選んだ人に KDP の話をしない(2026-09-23 ユーザー要望
            「自分に該当するものだけしか出てこない」) */}
        {layout.barcode ? (
          <p className="hint">
            表4の右下はバーコード用に空けてあります（{PRINT_TARGETS[printTarget].label}
            が自動で配置します）。プレビューの点線枠は出力には含まれません
          </p>
        ) : (
          <p className="hint">
            表4にバーコードの場所は空けていません。ISBN のバーコードを入れるときは、
            印刷所の指定する場所にあらすじがかからないよう、あらすじを短くしてください
          </p>
        )}
      </section>
    </>
  );

  return (
    // 表紙は本文が白黒でもカラーで刷る(cover/render.ts はグレーに落とさない)ので、並びもカラーのまま(2026-10-03)
    <ColorPaletteProvider colors={artPalette} label="この表紙の画像の色" mono={false}>
    <div className="cover">
      <aside className="sidebar">
        {/* **プリセットを選んでいるあいだは、サイドバーを一覧に明け渡す。**
            背景・挿絵(BackgroundPicker)とまったく同じ画面を使う。
            右のプレビューは出したままなので、選んだ絵がその場で表紙に入る様子を見ながら
            次の1枚を試せる。**だから選んでも閉じない**(背景側は見比べる相手が無いので閉じる)。

            shopHint は**短く**。下端に貼り付く帯なので、長いとそのぶん一覧の見える高さを食う
            (実測: 3行の紹介文で下端が 187px になり、196×299px の絵が1枚も収まらなかった) */}
        {presetFor ? (
          <PresetScreen
            label={PRESET_TARGET_LABELS[presetFor]}
            /* **まるごと1枚の絵は、まるごと1枚を選ぶときにだけ出す。そのときは縦の絵を出さない**
               (2026-09-27 ユーザー要望)。表1・表4を選ぶ画面には横長の見開きの絵は要らず、
               まるごと1枚には縦の絵は使えない。電子書籍だけの本はふつう表1の画面しか開かないが、
               前にまるごと1枚で作っていた本は(作るものを変えても設定は消さないので)この画面を開ける。
               そのときもまるごと1枚の絵だけを出す */
            presets={presets.filter((p) => (presetFor === 'wrap' ? isWrapPreset(p) : !isWrapPreset(p)))}
            selectedId={selectedPresetId(presetFor)}
            shopHint="買った画像は［自前の画像］からも読み込めます"
            onBack={() => setPresetFor(null)}
            onPick={(pr) => applyPreset(presetFor, pr.id)}
          />
        ) : (
          <>
          {/* 副タブは「地/文字/うら」という属性ではなく、表1→背→表4という面で切る。
              人は面(パーツ)で考えて手を動かすので、「いま触っている面がどこか」が
              タブ名だけで分かる。どの面を選んでいるかはプレビュー側の枠にも連動する。

              **タブと中身をひとつの箱に入れる。** 別々に並べていたころは、面を選ぶ行と
              その面の中の［単色/自前の画像/プリセット］が同じ「ボタンが並んだ行」に見えて、
              どちらが親なのか分からなかった(2026-08-19 ユーザー指摘)。
              タブは箱の見出し、中身は箱の中、という形にして段差を作る */}
          {/* **作り方の分かれ道を先に置く。** 排他なので、どちらで作っているかが
              いつでも読めていないといけない(2026-08-19 ユーザー指摘) */}
          {/* **電子書籍だけの本には出さない。**(2026-09-24 ユーザー指摘「電子書籍の表紙にまるごと1枚が
              あるけど不要」)。電子の表紙は表1の1枚だけで、表4・背にまたぐ絵の出番が無い。
              ただし前にまるごと1枚で作っていた本は、面ごとへ戻れるよう分かれ道を残す */}
          {(makes.paper || isWrap) && (
          <>
          <div className="cover-mode">
            <button
              className={!isWrap ? 'active' : ''}
              onClick={() => {
                // **実際に切り替わるときだけ**入れ替える。押し直しで動くと、
                // 控えと現物が意味もなく交換されてしまう
                if (!isWrap) return;
                // **モード・飾り・絵を1回の patch にまとめる**(Ctrl+Z でも1手で、
                // 三つ揃いのまま戻る)。飾り(帯・文字の位置と大きさと色・あらすじの飾り)は
                // 作り方ごとの控えと入れ替える(2026-09-04 ユーザー要望「面ごとは帯不要・
                // まるごとは帯が必要。別の作業にしたい」)。
                // 絵も**捨てずに控えへ。** 前は wrap を消していたので、切り替えた瞬間に
                // 選んだ絵が失われ、まるごと1枚へ戻っても空だった(2026-09-04 ユーザー報告)
                patch({
                  mode: 'faces',
                  ...swapCoverModeLook(settings),
                  ...(settings.wrap ? { wrap: undefined, wrapSaved: settings.wrap } : {}),
                });
                // **面のタブへ戻しておく。** pane は 'wrap' のまま残るので、
                // 戻ったときにどのタブも選ばれておらず中身が空になる(実測)
                setPane('front');
              }}
            >
              面ごとに作る
              <em>{saddle ? '表1・表4 を別々に' : '表1・背・表4 を別々に'}</em>
            </button>
            <button
              className={isWrap ? 'active' : ''}
              onClick={() => {
                // 飾りの入れ替えと絵の控え戻しは、上の「面ごとに作る」と対になる
                if (isWrap) return;
                patch({
                  mode: 'wrap',
                  ...swapCoverModeLook(settings),
                  ...(!settings.wrap && settings.wrapSaved
                    ? { wrap: settings.wrapSaved, wrapSaved: undefined }
                    : {}),
                });
                setPane('wrap');
              }}
            >
              まるごと1枚から作る
              <em>{saddle ? '1枚の画像を表4・表1にまたいで敷く' : '1枚の画像を表4・背・表1にまたいで敷く'}</em>
            </button>
          </div>
          {/* 飾りが別々に覚わることは、見た目からは分からないので言葉で置いておく */}
          <p className="hint">
            帯や文字の位置などの飾りは、<b>作り方ごとに別々に</b>覚えます。切り替えても互いに影響しません
          </p>
          </>
          )}
          {/* 中綴じ(2026-10-03)。背が無いこと・折り目が真ん中なことを、はじめに言う */}
          {makes.paper && saddle && (
            <p className="hint">
              <b>中綴じの表紙には背がありません。</b>表4と表1をつなげた1枚で、折り目は真ん中です（プレビューの破線）。
              折り目に顔や文字がかからないようにしてください
              {selfCover && <>。{selfCoverNotes(ink).join('。')}</>}
            </p>
          )}

          {isWrap ? (
            <div className="tabbox">
              <div className="subtabs">
                <button className="on">まるごと1枚</button>
              </div>
              <div className="tabpane">
            <section>
              <h2>表紙全体に1枚</h2>
              <input
                ref={wrapFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleImage(f, 'wrap');
                  e.target.value = '';
                }}
              />
              <div className="seg">
                <button
                  className={!settings.wrap ? 'active' : ''}
                  // ここでも捨てずに控えへ(モード切替と同じ約束)。
                  // mode:'wrap' を明示するのは、mode の無い古い保存だと wrap を消した瞬間に
                  // 推定が「面ごと」へ倒れ、飾りの入れ替え無しでモードだけ飛ぶため
                  onClick={() =>
                    patch({ mode: 'wrap', wrap: undefined, wrapSaved: settings.wrap ?? settings.wrapSaved })
                  }
                >
                  使わない
                </button>
                <button
                  className={settings.wrap?.kind === 'image' ? 'active' : ''}
                  onClick={() => wrapFileRef.current?.click()}
                >
                  自前の画像
                </button>
                <button
                  className={settings.wrap?.kind === 'preset' ? 'active' : ''}
                  onClick={() => setPresetFor('wrap')}
                >
                  プリセット
                </button>
              </div>

              {/* 一覧は専用画面へ(理由は GroundSection 側の同じ欄のコメント参照)。
                  ここは**テーマで分けずに全部並べていた**ので、なおさら探しにくかった */}
              {settings.wrap?.kind === 'preset' && (
                <ChosenPreset id={settings.wrap.id} onOpen={() => setPresetFor('wrap')} />
              )}

              {/* **排他であることを先に言う。** どちらが出るのか曖昧だと事故る */}
              <p className="hint">
                1枚の画像を<b>表4・背・表1にまたいで</b>敷きます。
                使っているあいだは<b>面ごとの地（表1・背・表4の色や画像）は出ません</b>。
              </p>
              {/* 背幅は本文のページ数で動くので、絵のどこが背に来るかは自分では決められない */}
              {saddle ? (
                <p className="hint">
                  中綴じは<b>背がなく、折り目が真ん中</b>です。顔や文字が折り目にかからない画像を選んでください。
                  プレビューの<b>破線</b>が折り目の位置です（画面だけの目印で、刷り上がりには出ません）
                </p>
              ) : (
              <p className="hint">
                いまの背幅は <b>{layout.spine.toFixed(2)} mm</b>
                （{layout.spineFromPrinter ? '印刷所の数字' : `本文 ${pages || '—'} ページ`}）。
                <b>{layout.spineFromPrinter ? '背幅を入れ直すと背の位置も動きます' : 'ページ数が変わると背の位置も動きます'}</b>ので、
                顔や文字が背にかからない画像を選んでください。
                プレビューの折り目の<b>破線</b>が背の位置です（画面だけの目印で、刷り上がりには出ません）
              </p>
              )}
              <p className="hint">
                必要な大きさは <b>{wrapPx.w.toLocaleString()} × {wrapPx.h.toLocaleString()} px</b>
                （塗り足し込み・{imagePpi}dpi）
              </p>
              {settings.wrap?.kind === 'image' && coverResNote('wrap', wrapImage)}
            </section>
            {/* **文字とあらすじの操作もこのタブに置く。** 飾りがモード別になったので、
                面タブへ戻っても届かない(控えに入るだけ)。まるごと1枚は1つのタブで
                作業が完結する(2026-09-04 ユーザー要望「それぞれ別の作業にしたい」) */}
            {textPlacementSections}
            {/* あらすじは表4に刷るもの。紙を作らない本の表紙(表1だけ)には出ない */}
            {makes.paper && blurbSections}
              </div>
            </div>
          ) : (
          <div className="tabbox">
            <div className="subtabs">
              {panes.map(([id, label]) => (
                <button
                  key={id}
                  className={pane === id ? 'on' : ''}
                  onClick={() => setPane(id)}
                >
                  {label}
                </button>
              ))}
            </div>

          {pane === 'front' && (
            <div className="tabpane">
          <GroundSection target="front" />

          {/* **「文字を読ませる」と色・書体は下の帯にある。**
              絵を見ながらいちばん往復する操作なので、左の欄から画面下の
              ［表紙をデザインする］へ移した(2026-08-19 ユーザー指摘)。
              左に残すのは**どこに置くか・どれだけ大きくするか**という配置の話だけ */}
          {textPlacementSections}
            </div>
          )}

          {pane === 'spine' && (
            <div className="tabpane">
          <section>
            <h2>背の太さ</h2>
            {/* **背幅はここでは決められない。** 本文のページ数 × 紙1枚の厚みで出る値なので、
                この面に置けるのは「何がこの数字を作っているか」と「どこへ行けば変えられるか」
                の2つだけ。用紙と刷り色は画面下の帯にあるので、行き先まで書く */}
            {layout.spineFromPrinter ? (
              <p className="readout">
                印刷所から知らされた背幅 <b>{layout.spine.toFixed(2)}mm</b> を使っています
                <small>［本のかたちを決める］の「印刷所の決まり」にある「背幅（印刷所の数字）」で変えられます</small>
              </p>
            ) : (
              <p className="readout">
                本文用紙が<b>「{PAPER_TYPES[paper].label}」</b>、刷り色が
                <b>「{INK_COLORS[ink].label}」</b>なので、
                <b>
                  {pages}ページで背幅 {layout.spine.toFixed(2)}mm
                </b>
                {' '}になります
                <small>
                  この用紙は1ページあたり {PAPER_TYPES[paper].mmPerPage}mm。
                  用紙や刷り色を変えると背幅も変わります
                  （［本のかたちを決める］で選べます）
                </small>
              </p>
            )}
            {/* 背幅を印刷所が知らせる出し先(asksPrinterSpine)で、まだ数字が入っていないとき。目安は KDP の紙の厚み */}
            {PRINT_TARGETS[printTarget].asksPrinterSpine && !layout.spineFromPrinter && (
              <p className="hint">
                この背幅は <b>KDP の紙の厚みで出した目安</b>です。印刷所の紙では違うことがあるので、
                印刷所から知らされた背幅を［本のかたちを決める］の「印刷所の決まり」にある「背幅（印刷所の数字）」に入れてください
              </p>
            )}
          </section>

          <section>
            <h2>背の色</h2>
            <label className="color-row">
              背の色
              <ColorInput
                value={settings.spineColor}
                onChange={(e) => patch({ spineColor: e.target.value })}
              />
            </label>
            <p className="hint">
              この背の色が刷られるのは<b>「面ごとに作る」で作っているとき</b>です。
              「まるごと1枚から作る」に切り替えると、背はその画像になります
            </p>
          </section>

          {/* **背幅が足りない本では、この欄そのものを出さない。**
              KDP が背文字を認めるのは79ページから。それ未満の本に入力欄を見せると、
              書いたのに刷られないか、刷ったら表1へ回り込むかのどちらかになる */}
          <section>
            <h2>背の文字</h2>
            {!layout.spineTextAllowed ? (
              <p className="hint">
                背幅が<b>{layout.spine.toFixed(2)}mm</b>（{pages}ページ）しかないので、
                背には文字を刷りません。
                <small>
                  {spineByPages && (
                    <>
                      {PRINT_TARGETS[printTarget].label} が背文字を刷るのは
                      <b>{PRINT_TARGETS[printTarget].spineTextMinPages}ページから</b>。
                    </>
                  )}
                  {spineByMm && (
                    <>
                      {PRINT_TARGETS[printTarget].label}で背に文字を刷れるのは、
                      <b>背幅が {PRINT_TARGETS[printTarget].spineTextMinMm}mm 以上</b>のときだけです。
                    </>
                  )}
                  {spineByPt && (
                    <>
                      {(spineByPages || spineByMm) && 'さらに'}
                      綴じのブレを避けるため、背の縁から {layout.spineInset.toFixed(2)}mm ずつ空けます。
                      この本で文字に使えるのは{' '}
                      {Math.max(0, layout.spine - layout.spineInset * 2).toFixed(2)}mm ＝{' '}
                      <b>{spineBox.maxPt.toFixed(1)}pt</b> までで、読める下限の {SPINE_MIN_PT}pt に届きません。
                    </>
                  )}
                  この用紙なら
                  <b>
                    {spineTextMinPages(paper, layout.spineInset, printTarget, {
                      body: settings.printerBodyPaper,
                      cover: settings.printerCoverPaper,
                    })}
                    ページ
                  </b>
                  から刷れるようになります
                  {PRINT_TARGETS[printTarget].fixedSpineInsetMm !== undefined &&
                    `（${PRINT_TARGETS[printTarget].label} 以外の印刷所なら、［本のかたちを決める］でアキを詰められます）`}
                </small>
              </p>
            ) : (
              <>
                <label className="stack">
                  背の文字
                  <select
                    value={settings.spineTextOn ? 'on' : 'off'}
                    onChange={(e) => patch({ spineTextOn: e.target.value === 'on' })}
                  >
                    <option value="on">刷る</option>
                    <option value="off">刷らない</option>
                  </select>
                </label>
                {settings.spineTextOn && (
                  <>
                    <label className="stack">
                      書名（空なら本の書名）
                      <input
                        type="text"
                        value={settings.spineTitle}
                        placeholder={text.title}
                        onChange={(e) => patch({ spineTitle: e.target.value })}
                      />
                    </label>
                    <p className="hint">
                      背は1本の線なので改行は使いません。書名が長いときは、この欄で
                      <b>背に刷る書名だけを短く</b>できます（本の書名は変わりません）
                    </p>
                    <label className="stack">
                      著者名
                      <select
                        value={settings.spineAuthorOn ? 'on' : 'off'}
                        onChange={(e) => patch({ spineAuthorOn: e.target.value === 'on' })}
                      >
                        <option value="on">書名の下に刷る</option>
                        <option value="off">刷らない</option>
                      </select>
                    </label>
                    <label className="stack">
                      版元名
                      <select
                        value={settings.spinePublisherOn ? 'on' : 'off'}
                        onChange={(e) => patch({ spinePublisherOn: e.target.value === 'on' })}
                      >
                        <option value="on">背の下端に刷る</option>
                        <option value="off">刷らない</option>
                      </select>
                    </label>
                    {/* 文字の向き・書体・色は画面下の帯(背の文字をデザインする)へ移した(2026-10-09)。
                        大きさは収まりの数字・警告と一緒に見るものなので、ここに残す */}
                    {/* **3つ別々に決められる**(2026-08-22 ユーザー要望)。
                        欄を縦に3つ並べるとこの板がさらに伸びるので、横に並べて1行に収める。
                        刷らない段の欄は出さない(著者名・版元名を「刷らない」にしているとき) */}
                    <div className="spine-sizes">
                      <div className="spine-sizes-head">
                        <span>大きさ（倍）</span>
                        <button
                          type="button"
                          className="ghost"
                          disabled={!spinePrint}
                          title="背からはみ出さず、天地（字数）にも収まる、いちばん大きい組み合わせにします。3つの割合はそのままです"
                          onClick={() => {
                            // 描画側が返した headroom を3つに掛けるだけ。
                            // **画面で計算し直さない** — 字幅は書体で変わるので、
                            // 実際に描いた本人の答えを使うほうが確実
                            const g = spinePrint?.headroom ?? 1;
                            // 上限を越えないよう切り捨てる(丸め上げると1回ぶん縮められる)
                            const down = (v: number) => Math.floor(v * g * 1000) / 1000;
                            patch({
                              spineScale: down(settings.spineScale),
                              spineAuthorScale: down(settings.spineAuthorScale),
                              spinePublisherScale: down(settings.spinePublisherScale),
                            });
                          }}
                        >
                          ぎりぎりまで大きく
                        </button>
                      </div>
                      <div className="spine-sizes-row">
                        <label>
                          書名
                          <input
                            type="number"
                            min={0.3}
                            max={1.4}
                            step={0.05}
                            value={settings.spineScale}
                            onChange={(e) => patch({ spineScale: Number(e.target.value) })}
                          />
                        </label>
                        {settings.spineAuthorOn && (
                          <label>
                            著者
                            <input
                              type="number"
                              min={0.3}
                              max={1.4}
                              step={0.05}
                              value={settings.spineAuthorScale}
                              onChange={(e) => patch({ spineAuthorScale: Number(e.target.value) })}
                            />
                          </label>
                        )}
                        {settings.spinePublisherOn && (
                          <label>
                            版元
                            <input
                              type="number"
                              min={0.3}
                              max={1.4}
                              step={0.05}
                              value={settings.spinePublisherScale}
                              onChange={(e) =>
                                patch({ spinePublisherScale: Number(e.target.value) })
                              }
                            />
                          </label>
                        )}
                      </div>
                    </div>
                    {/* 置ける幅は背幅そのものではない。断裁のブレで文字が表1・表4へ
                        回り込まないよう、縁からアキを取ったうえで字の大きさが決まる。

                        **出すのは描画が使った実寸。** 背幅だけを見た見込みを出していたころは、
                        字数の多い本で食い違っていた(2026-08-22 実測・文庫・白色用紙):
                          297ページ・書名7字  画面 27.36pt → 実際に刷るのは 22.41pt */}
                    <p className="readout">
                      背幅 {layout.spine.toFixed(2)}mm のうち文字に使えるのは{' '}
                      <b>{spineBox.width.toFixed(2)}mm</b>。刷る大きさは{' '}
                      <b>書名 {spineShown.titlePt.toFixed(1)}pt</b>
                      {settings.spineAuthorOn && <>・著者 {spineShown.authorPt.toFixed(1)}pt</>}
                      {settings.spinePublisherOn && <>・版元 {spineShown.publisherPt.toFixed(1)}pt</>}
                      <small>
                        背の縁から {layout.spineInset.toFixed(2)}mm ずつ空けます
                        {PRINT_TARGETS[printTarget].fixedSpineInsetMm !== undefined
                          ? `（${PRINT_TARGETS[printTarget].label} の決まり。ここを削ると綴じのブレで文字が表1・表4へ回り込み、入稿が却下されます）`
                          : '（［本のかたちを決める］で変えられます。印刷所のガイドの数字に合わせてください）'}
                        。はみ出さない上限は書名{' '}
                        {/* **上限は切り捨てで出す。** 四捨五入すると、押した直後に
                            「刷る 25.4pt・上限 25.5pt」と出て、もう一度押せる顔になる */}
                        {(Math.floor(spineShown.limitPt * 10) / 10).toFixed(1)}pt
                        {spineShown.limitedBy === 'width' ? '（背幅で頭打ち）' : '（字数で頭打ち）'}
                        {spineShown.shrunk && '。字数が多いので、指定より縮めて刷っています'}
                      </small>
                    </p>
                    {spineBox.raised && (
                      <p className="warn">
                        <b>この背幅では「大きさ 1倍」の文字が {SPINE_MIN_PT}pt に届かないので、
                        背の文字を {SPINE_MIN_PT}pt まで自動で大きくしています。</b>
                        細い背文字は本の見栄えをかえって落とすので、
                        窮屈に見えるなら背は無地のままにするほうが締まります
                      </p>
                    )}
                    {spineOverflow > 0 && (
                      <p className="warn">
                        背に入りきらないので <b>約{spineOverflow}文字</b> を刷っていません。
                        書名を短くするか、著者名・版元名を減らしてください
                      </p>
                    )}
                    <p className="hint">
                      この背の文字は、<b>「まるごと1枚から作る」に切り替えても、その画像の上に刷られます</b>。
                      切り替えたときは、画像の明るさに合わせて文字の色を選び直してください。
                      書体・向き・色は、画面下の帯（背の文字をデザインする）で変更できます
                    </p>
                  </>
                )}
              </>
            )}
          </section>
            </div>
          )}

          {pane === 'back' && (
            <div className="tabpane">
          <GroundSection target="back" />
          {blurbSections}
            </div>
          )}

          </div>
          )}

          {error && <p className="error">{error}</p>}

          {/* **タブの外・サイドバーの下端。**(2026-08-19 ユーザー指摘)
              もとは表1の［単色］の節の中にあり、単色を選んでいる人にだけ
              「表紙画像を買えます」が出ていた。買える物があることはタブに関係ない */}
          <ShopFoot
            label={SHOP_PACKS_LABEL}
            hint="テーマ別・様式別の有料の画像パックです。表紙にも背景にも挿絵にも使えます。買った画像は［自前の画像］から読み込んで使えます"
          />
          </>
        )}
      </aside>

      <main className="cover-preview" style={{ ['--zoom' as string]: zoom }}>
        {topSlot && <div className="cover-top-slot">{topSlot}</div>}
        <div className="zoom-bar">
          <span>表示倍率</span>
          <input
            type="range"
            aria-label="表示倍率"
            min={0.4}
            max={2}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <b>{Math.round(zoom * 100)}%</b>
          <button onClick={() => setZoom(1)}>全体</button>
          {/* 背幅と仕上がり寸法。**操作ではなく結果**なので、設定の列に置く必要がない。
              いま見ている絵のすぐ上に出しておけば、ページ数を動かしたときに
              背が太くなるのを絵と数字の両方で確かめられる。
              表1/背/表4 のどの面を触っていても同じ値なので、副タブの中に入れると3回書くことになる */}
          {makes.paper && (
            <span className="zoom-readout">
              {saddle ? (
                <>中綴じ（背なし）</>
              ) : (
                <>
                  背幅 <b>{layout.spine.toFixed(2)}mm</b>（{layout.spineFromPrinter ? '印刷所の数字' : `${pages}ページ`}）
                </>
              )}
              <em>
                表紙全体 {layout.totalW.toFixed(1)} × {layout.totalH.toFixed(1)}mm /{' '}
                {mmToPx(layout.totalW, outputPpi).toLocaleString()} × {mmToPx(layout.totalH, outputPpi).toLocaleString()} px
              </em>
            </span>
          )}
        </div>
        {/* **紙を作らない本では見せないが、外さない。** 描画と、あらすじのあふれの報告は
            このキャンバスが受け持っているので、DOM に残したまま隠す */}
        <div className="cover-sheet" hidden={!makes.paper}>
          <h3>
            紙の表紙(
            {saddle
              ? layout.rightBound
                ? '表1・表4 — 右綴じ・中綴じ'
                : '表4・表1 — 左綴じ・中綴じ'
              : layout.rightBound
                ? '表1・背・表4 — 右綴じ'
                : '表4・背・表1 — 左綴じ'})
          </h3>
          <div className="cover-canvas-wrap">
            <canvas ref={paperRef} />
            {/* いま副タブで選んでいる面をキャンバス上に示す枠。
                「表1ボタンを押すと表1にフォーカスがいくようにしてほしい」という
                初見ユーザーの要望への対応(2026-08-18)。位置は computeCoverLayout() の
                mm 座標をそのまま % に直すだけ。綴じ方向で表1/表4の左右が入れ替わっても
                layout.front/back が既に反映済みなので、ここで左右を決め打ちしない */}
            {/* **枠を押しても面を切り替えられるようにした。**(2026-09-14 ユーザー要望
                「表1がアクティブなときに表4をクリックすると表4がアクティブになる、
                という操作を加えることはできる? いちいちボタンに戻らないといけないのが
                面倒くさい」)。上のタブ(COVER_PANES)は押せる場所が増えるだけで残す。

                書名・著者名は位置パッド(AnchorPad)とmm微調整の数値入力でしか動かせず、
                このプレビュー上をドラッグして動かす操作はこのファイルに無い(確認済み)。
                なので「動かした距離が小さいときだけ切り替える」ような取り違え防止は要らず、
                ただの onClick でよい。

                **「まるごと1枚」では面という単位そのものが無い**ので押しても何もしない
                (pane==='wrap' のときは clickable を落とし、role/tabIndex/onClick ごと外す。
                CSS 側も .cover-face-guide / .cover-face-clear で pointer-events を切っている) */}
            <div className="cover-face-overlay" aria-hidden={pane === 'wrap' ? 'true' : undefined}>
              {FACES.map((id) => {
                const r = faceRanges[id];
                const left = (r.x0 / layout.totalW) * 100;
                const width = ((r.x1 - r.x0) / layout.totalW) * 100;
                // まるごと1枚のときは絵の色をそのまま見せたいので、どの面も暗くしない。
                // 代わりに背の**折り目の位置だけ**破線で示す。
                // 実線の枠(cover-face-on)で囲っていたころは、細い背では枠が背を
                // 塗りつぶして見え「面ごとの背の色が入ってしまう」と読まれた
                // (2026-09-04 ユーザー報告。刷り上がりには何も出ないのに、そう見えた)
                const cls =
                  pane === 'wrap'
                    ? id === 'spine'
                      ? 'cover-face cover-face-guide'
                      : 'cover-face cover-face-clear'
                    : id === pane
                      ? 'cover-face cover-face-on'
                      : 'cover-face';
                const clickable = pane !== 'wrap';
                const goFace = () => setPane(id);
                return (
                  <div
                    key={id}
                    className={cls}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-label={clickable ? `${FACE_LABELS[id]}を編集` : undefined}
                    aria-pressed={clickable ? id === pane : undefined}
                    onClick={clickable ? goFace : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            // Enter・Space の両方を拾う。Space はスクロールを起こすので既定動作を止める
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              goFace();
                            }
                          }
                        : undefined
                    }
                  />
                );
              })}
              {/* 中綴じは背が無いので、折り目(真ん中)だけを破線で示す。画面だけの目印 */}
              {saddle && (
                <div
                  className="cover-face cover-face-guide cover-face-fold"
                  aria-hidden="true"
                  style={{ left: `${(layout.spineArea.x0 / layout.totalW) * 100}%`, width: 0 }}
                />
              )}
            </div>
          </div>
        </div>
        {/* 電子を作らない本には出さない。紙を作らない本では、これが唯一の見本なので大きく */}
        <div
          className={makes.paper ? 'cover-sheet ebook' : 'cover-sheet ebook solo'}
          hidden={!makes.ebook}
        >
          <h3>電子書籍の表紙</h3>
          <canvas ref={ebookRef} />
        </div>
      </main>
    </div>
    </ColorPaletteProvider>
  );
});
