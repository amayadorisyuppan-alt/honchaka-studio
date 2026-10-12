// 挿絵の管理UI。絵の入れ方は2通りある(2026-09-23 から):
//
// - **章の切れ目** … 絵だけの1ページを挟む(Plate / settings.plates)。
//   章はもともと改ページ起こしなので、挟んでも本文の流れが動かない
// - **章の途中** … 選んだ段落のあとに入れる(本文の画像ブロック / manuscript)。
//   それまでは Word に書き出して貼り、取り込み直すしかなかった。組版は最初から
//   段落のあいだの絵を組めたので、場所を選ぶ画面(ParagraphPicker)を足して Word の往復をやめた
//
// 利用者から見ればどちらも「挿絵」なので、**1つの一覧にページ順で並べる**。
// Word 原稿に貼ってあった絵も章の途中の絵なので、ここに出して動かせるようにした
// (それまではスタジオから触る手段が無かった)。
//
// 画像の追加は BackgroundPicker を使い回しているので、表紙用の画像パックからそのまま選べる。

import { useEffect, useRef, useState } from 'react';
import { isEpubImage } from '../exporters/epub';
import { overText, type TextRowState } from '../textcheck/geometry';
import { resolutionNote, type ResolutionVerdict } from '../models/imageResolution';
import { SPREAD_AUTO_BLANK_NOTE, SPREAD_EBOOK_NOTE, SPREAD_FOLD_SAFE_MM, SPREAD_REPICK_NOTE, spreadBindingNote } from '../typeset/spread';
import { WRAP_MAX_SIDE } from '../images/optimize';
import {
  PLATE_SIZES,
  imageFormatLabel,
  isRenderableImage,
  type Binding,
  type Chapter,
  type ImageBlock,
  type Plate,
  type PlateSize,
} from '../models/project';
import {
  IMAGE_SIZES,
  anchorSnippet,
  imageKey,
  imageSizeOf,
  insertImage,
  listInlineImages,
  moveImage,
  patchImage,
  plainText,
  removeImage,
  withImageSize,
  type ImageSizeChoice,
} from '../models/inlineImages';
import type { LayoutInfo } from '../preview/VivliostylePreview';
import { BackgroundPicker } from './BackgroundPicker';
import { ParagraphPicker } from './ParagraphPicker';
import { PrintMonoToggle, type ColorLook } from './PrintMonoToggle';

interface Props {
  plates: Plate[];
  chapters: Chapter[];
  /** プレビューの組み上がりから読んだ情報(いま何ページ目に出ているかの表示に使う) */
  layout: LayoutInfo;
  onChange: (plates: Plate[]) => void;
  /**
   * 中の画像パック一覧が開いたかどうかを ArtStep へ知らせる。
   * ArtStep 側はこれで副タブや案内文を隠し、サイドバーを一覧専用にする
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * 次に足す1枚を入れる場所(何章の前か)。
   * **ページ一覧の「＋」から来たときだけ入る。**(2026-08-19 ユーザー指摘
   * 「今クリックしているページに挿入したいんだが、できないのか」)
   * 絵を選ばないと挿絵は成り立たないので、押した場所をここで預かって、
   * 絵が決まったところでそこへ挟む
   */
  addAt?: number | null;
  /** 預かった場所を使い切ったことを知らせる(次の1枚は巻末に戻る) */
  onAddAtUsed?: () => void;
  /** 足したページへプレビューを飛ばす。1始まり */
  onJump?: (page: number) => void;
  /**
   * 1枚足したことを知らせる。**足した先へ飛んで光らせるのに使う。**
   * 左の欄で足しても、ページ一覧は画面の反対側なので
   * どこに増えたのか探すことになっていた(2026-08-20 ユーザー指摘)
   */
  onAdded?: (id: string) => void;
  /** 足したばかりのページの id。一覧の該当行へスクロールして光らせる */
  highlightId?: string | null;
  /**
   * **いじった1枚へプレビューを連れて行く。**(2026-09-23 ユーザー指摘「左の柱で章を指定したり
   * ページを指定しても、プレビューがその場所に移動してくれないので、どこをいじったか
   * わからなくなる」)。組み直しは非同期なので、App が組み上がりを待ってからそのページへ飛ぶ。
   * 'plate' は挿絵ページの id、'img' は章の途中の絵の imageKey(章, 並び)
   */
  onFollow?: (kind: 'plate' | 'img', id: string) => void;
  /** 右の下見が電子書籍か。行の「◯ページ目（見る）」を「電子の下見で見る」に替える */
  ebookView?: boolean;
  /**
   * 絵の中の文字の検査で、行に出すこと(鍵は plate:id / img:imageKey)。**その絵の行で知らせ、その場で直せるようにする**
   * (2026-10-02 ユーザー要望)。外に出ている・確かめている最中・確かめられなかった、の3つ。問題の無い絵は入っていない
   */
  textRows?: ReadonlyMap<string, TextRowState>;
  /**
   * 絵の細かさ(ppi)が出し先の目安に届かない絵の行に出すこと(鍵は textRows と同じ)。**知らせるだけで、止めない**
   * (2026-10-03 ユーザー判断)。足りている絵・まだ測れていない絵は入っていない
   */
  resRows?: ReadonlyMap<string, ResolutionVerdict>;
  /**
   * 目立たせる行(鍵は resRows と同じ plate:id / img:鍵)と、届いた合図の連番。
   * **［完成データを書き出す］の「直すところ」から来たときだけ入る。**(2026-10-09 ユーザー指摘
   * 「挿絵と本文中の画像のうち2枚は…と出るが、どの挿絵の話なのかがわからない」)
   * 届いたら、一覧の上に該当の画像を並べた札を出し、その行を枠で囲み、1枚目へ寄る
   */
  spotlight?: { keys: readonly string[]; seq: number };
  /**
   * 見開きの絵の行に出す、絵の画素数から言えること(鍵は挿絵の id。縦横比が違う・取り込みの上限で縮んでいる)。
   * 渡さなければ何も出さない(2026-10-03)
   */
  spreadNotes?: ReadonlyMap<string, readonly string[]>;
  /** 出し先の名前(「Amazon KDP」など)。細かさの知らせに添える */
  printTargetLabel?: string;
  /**
   * いまの綴じ方(bindingOf)。**見開きの絵の注意が綴じ方で変わる**(中綴じは根元まで開くので向いている・無線綴じは真ん中が糊で隠れる)。
   * 渡さなければ無線綴じとして言う(2026-10-03)
   */
  binding?: Binding;
  /**
   * どちらの面か。**中身は同じ配列だが、見せるものが違う。**(2026-08-20 ユーザー判断)
   * 'plates' なら絵のあるページだけ、'blanks' ならクッションだけを出す
   */
  only?: 'plates' | 'blanks';
  /**
   * 章の途中の絵を書き換える(原稿の章ごと差し替える)。**'plates' の面でだけ使う。**
   * 渡さなければ章の途中の絵は一覧に出さない
   */
  onChaptersChange?: (chapters: Chapter[], undoKey?: string) => void;
  /**
   * 行に「白黒で刷る」のチェックを出すか(2026-10-12 1.1.0。修正リストの 4-6)。**カラーの紙の本だけ**
   * (白黒の本は絵がすべて白黒・電子書籍は元の絵のまま)。渡さなければ出さない
   */
  printColor?: boolean;
  /** 白黒に見える絵・ごく淡い色の絵の行(鍵は resRows と同じ plate:id / img:鍵。models/printColor.ts の colorLookRows) */
  colorRows?: ReadonlyMap<string, ColorLook>;
}

/** 章の呼び名。一覧と場所の言い方で使う */
function chapterName(chapters: Chapter[], i: number): string {
  const ch = chapters[i];
  if (!ch) return `${i + 1}つめの章`;
  return [ch.no, plainText(ch.title)].filter(Boolean).join('　') || `${i + 1}つめの章`;
}

/** 一覧の1行。章の切れ目のページと、章の途中の絵 */
type Row =
  | { kind: 'plate'; plate: Plate; sort: number[] }
  | { kind: 'img'; chapter: number; block: number; image: ImageBlock; sort: number[] };

/** 一覧と flash の目印。章の途中の絵は組み上がりの鍵(imageKey)をそのまま使う */
const imgRowId = (chapter: number, block: number) => `img:${imageKey(chapter, block)}`;
/** 一覧の絵の枠。白黒で刷る絵は灰色で見せる(画面だけ。app.css の .plate-thumb.mono) */
const monoThumb = (mono: boolean | undefined) => (mono ? 'plate-thumb mono' : 'plate-thumb');

/**
 * 挿絵を挟む場所の言い方。
 *
 * **持っている値は「◯章の前」だが、読む人には「◯章の最後」と言う。**
 * 同じ切れ目を指す2つの言い方で、章を読み終えたところに絵が来る、と考えるほうが自然
 * (2026-08-17 ユーザー指摘)。データの持ち方は変えていない。
 *
 * 最初の章の前だけは「ひとつ前の章」が無いので、本文の頭として言う。
 *
 * コラムページ(ColumnPageEditor)も同じ切れ目に置くので、言い方をここから借りている。
 * 別々に書くと、片方だけ言い回しを直したときに同じ場所が2つの名前で呼ばれる
 */
export function positionLabel(chapters: Chapter[], before: number): string {
  if (before <= 0) return '本文の最初（1つめの章の前）';
  if (before >= chapters.length) return '本文の最後（奥付の前）';
  const prev = chapters[before - 1];
  const name = [prev.no, prev.title].filter(Boolean).join('　');
  return name ? `${name} の最後` : `${before}つめの章の最後`;
}

export function PlateEditor({
  plates,
  chapters,
  layout,
  onChange,
  onOpenChange,
  addAt,
  onAddAtUsed,
  onJump,
  onAdded,
  highlightId,
  onFollow,
  ebookView = false,
  textRows,
  resRows,
  spotlight,
  spreadNotes,
  printTargetLabel = '出し先',
  binding = 'perfect',
  only = 'plates',
  onChaptersChange,
  printColor = false,
  colorRows,
}: Props) {
  /**
   * 絵の中の文字の検査の知らせ(その絵の行に出す)。
   * - 外に出ている: **何が起きているか → どこを見ればよいか → どう直すか**の順に言い、直すボタンを並べる。
   *   文字ではない模様を文字と見ることもあるので、「このままにする」も置く(その絵の検査を止める)
   * - 確かめている最中・確かめられなかった: 黙っていると「問題なし」と見分けられないので、1行で言う
   */
  const textCheckNote = (row: TextRowState | undefined, hasJump: boolean, onFit: () => void, onKeep: () => void) => {
    if (!row || ebookView) return null;
    if (row.state === 'checking') return <p className="hint">画像の中の文字を確かめています…</p>;
    if (row.state === 'failed') {
      return (
        <p className="hint">
          この画像は、<b>画像の中の文字を確かめられませんでした</b>（このブラウザでは開けない形式の画像など）。
          文字の入った画像なら、大きさを「版面いっぱい」にしておくと安心です{' '}
          <button className="linklike" onClick={row.retry}>
            もう一度確かめる
          </button>
        </p>
      );
    }
    const f = row.finding;
    // 見開きは2ページにまたがるので「版面いっぱい」にはできない。絵のほうを直してもらう
    if (f.target.place === 'spread') {
      const outsideText = overText(f.over);
      // 折り目にかかっているだけ(版面の外ではない。中綴じのノド側はほぼこれ)は、止められる話ではないので、やわらかく言う
      const soft = !!f.foldOnly;
      return (
        <div className={soft ? 'text-check soft' : 'text-check'} role={soft ? 'status' : 'alert'}>
          {outsideText && (
            <p className="error">
              この画像の中の<b>文字が、版面（本文の入る範囲）の外に出ています</b>（{outsideText}）。
              印刷の入稿で止められることがあります
            </p>
          )}
          {!!f.fold && (
            <p className={soft ? 'warn' : 'error'}>
              画像の<b>真ん中（折り目）の左右 {SPREAD_FOLD_SAFE_MM}mm に、文字がかかっています</b>。
              綴じや断裁で ±1mm ほどずれるので、読みにくくなることがあります
            </p>
          )}
          <p className="hint">
            {hasJump && <>上の<b>「◯ページ目（見る）」</b>を押すと、右の下見にこの画像のページが出ます。</>}
            {soft ? (
              <>
                <b>色を塗った所</b>が、折り目にかかっている文字です。文字を折り目から離して置いた画像に差し替えてください
              </>
            ) : (
              <>
                <b>赤い線が版面</b>、<b>赤く塗った所</b>が外に出ている文字（または折り目にかかる文字）です。
                見開きの画像は「版面いっぱい」にできないので、
                {binding === 'saddle'
                  ? `文字を、上・下・外側は版面の内側に、折り目からは ${SPREAD_FOLD_SAFE_MM}mm 以上離して置いた画像に差し替えてください`
                  : '文字を版面の内側（折り目からも離して）に置いた画像に差し替えてください'}
              </>
            )}
          </p>
          <div className="text-check-actions">
            <button className="ghost" onClick={onKeep}>
              文字ではない・このままにする
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="text-check" role="alert">
        <p className="error">
          この画像の中の<b>文字が、版面（本文の入る範囲）の外に出ています</b>（{overText(f.over)}）。
          印刷の入稿で止められることがあります
        </p>
        <p className="hint">
          {hasJump && <>上の<b>「◯ページ目（見る）」</b>を押すと、右の下見にこの画像のページが出ます。</>}
          <b>赤い線が版面</b>、<b>赤く塗った所</b>が外に出ている文字です。
          大きさを<b>「版面いっぱい」</b>にすると、画像ごと版面の中に収まります
        </p>
        <div className="text-check-actions">
          <button className="primary-action" onClick={onFit}>
            版面いっぱいにする
          </button>
          <button className="ghost" onClick={onKeep}>
            文字ではない・このままにする
          </button>
        </div>
      </div>
    );
  };
  /**
   * 絵の細かさの知らせ(その絵の行に1行)。足りている絵には出さない。電子書籍の下見では出さない(紙の話)。
   * 「かなり足りない」ときは、頭に太字を付けて強める
   */
  const resNote = (key: string) => {
    const v = resRows?.get(key);
    const text = v && !ebookView ? resolutionNote(v, printTargetLabel) : null;
    return text ? (
      <p className="warn" role="status">
        {v!.level === 'veryLow' && <b>細かさがかなり足りません。 </b>}
        {text}
      </p>
    ) : null;
  };
  /**
   * 「このままにする」を選んだ絵の行に出す、戻すための1行。
   * 検査にかかる大きさ(全面・余白すこし・余白おおめ)のときだけ(ほかの大きさは、もともと調べない)
   */
  const textKeptNote = (kept: boolean | undefined, checked: boolean, onCheck: () => void) =>
    kept && checked && !ebookView ? (
      <p className="hint">
        この画像は、画像の中の文字の確認を止めています{' '}
        <button className="linklike" onClick={onCheck}>
          もう一度確かめる
        </button>
      </p>
    ) : null;
  // 画像パックの一覧を開いているあいだ、下の一覧と［クッションページを足す］を隠す。
  // BackgroundPicker の open を親(ここ)で持つことで、
  // ArtStep へも「開いている」を伝えつつ、閉じるボタンを自分でも出せるようにする
  /**
   * どの1枚の画像パック一覧を開いているか(挿絵の id、章の途中の絵は imgRowId)。
   * 開いていなければ null。
   * **開いているあいだは他の行も足すボタンも描かない**(サイドバーを一覧専用にする)
   */
  const [picking, setPicking] = useState<string | null>(null);
  /**
   * 章の途中に絵を入れる場所を選んでいるか。新しく入れる('new')か、
   * いまある絵を動かす(その絵の場所)か。**選んでいるあいだはサイドバーを明け渡す**
   * (画像パックの一覧と同じ扱い)
   */
  const [placing, setPlacing] = useState<
    null | 'new' | { chapter: number; block: number; image: ImageBlock }
  >(null);
  /** 操作が取り消されたときの断り(場所を選んでいるあいだに本文が変わった、など) */
  const [notice, setNotice] = useState('');
  /**
   * 「元に戻す」の1手の区切り。**絵を足す・動かす・消す・替えるは1回ずつ別の手にする。**
   * 同じ鍵が続くと store の pushUndo が1つにまとめるので、続けて2枚消したあと［元に戻す］で
   * 2枚とも戻ってしまった(2026-09-23 レビューで発見)。キャプションの打鍵だけは絵ごとの鍵でまとめる
   */
  const opKey = () => `inline-image:${Date.now()}`;

  /**
   * **増えた行を見せに行く。** ページ一覧の「＋」で足すと行はページ順の位置に入るので、
   * 画面の外のこともある(2026-09-04 ユーザー報告「該当ページに出てしまうので、
   * 左の柱でも見えるように位置を移動してほしい」)。App の justAdded(highlightId)を合図に、
   * その行までスクロールして光らせる。自分のボタン・＋・複製、どの経路でも App が
   * justAdded を立てるので同じに効く。**別の工程から＋を押してここがあとから
   * マウントされる場合**も、マウント時にこの効果が走るので取りこぼさない
   */
  const [flashId, setFlashId] = useState<string | null>(null);
  const flash = (id: string) => {
    setFlashId(id);
    // 行が描かれてから寄る(同じ描画サイクルではまだ無い)
    requestAnimationFrame(() => {
      document
        .querySelector(`.plate-list li[data-id="${id}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };
  useEffect(() => {
    if (!highlightId) return;
    flash(highlightId);
  }, [highlightId]);
  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 2200);
    return () => clearTimeout(t);
  }, [flashId]);

  /**
   * 「直すところ」から渡された、目立たせる行(鍵)。**札を閉じるまで残す**(光らせて消すだけだと、
   * 2枚目を探すときにはもう分からない)。鍵 → 行の目印は、挿絵ページは plate: を外した id、
   * 章の途中の絵は鍵がそのまま行の目印(imgRowId と同じ形)
   */
  const [spot, setSpot] = useState<readonly string[] | null>(null);
  const spotSeq = useRef(-1);
  const rowIdOfKey = (key: string) => (key.startsWith('plate:') ? key.slice(6) : key);
  const pageOfKey = (key: string) =>
    (key.startsWith('plate:')
      ? layout.platePages.get(key.slice(6))
      : layout.imgPages.get(key.slice(4))) ?? null;
  /** その画像の行へ寄って光らせ、下見もそのページへ送る */
  const goSpot = (key: string) => {
    flash(rowIdOfKey(key));
    const page = pageOfKey(key);
    if (page !== null) onJump?.(page);
  };
  useEffect(() => {
    if (!spotlight || spotlight.seq === spotSeq.current) return;
    spotSeq.current = spotlight.seq;
    setSpot(spotlight.keys);
    if (spotlight.keys[0]) goSpot(spotlight.keys[0]);
    // goSpot は毎回作り直される関数なので依存に入れない(合図の連番が変わったときだけ動く)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlight?.seq]);
  /** 行に付ける印(光らせる・枠で囲む) */
  const rowClass = (id: string, key: string) =>
    [flashId === id ? 'row-flash' : '', spot?.includes(key) ? 'row-spot' : ''].filter(Boolean).join(' ') ||
    undefined;

  /**
   * いじった行を追いかける。**一覧の行へ寄り、プレビューもそのページへ送る。**
   * 一覧はページ順に並べ直すので、場所を変えた行は一覧の別の所へ移る。寄らないと、
   * 自分は元の位置に残ったまま行を見失う(2026-09-23 ユーザー指摘「追加した枠が移動しても
   * 自分もそれに合わせて移動してほしい」)。
   * 章の途中の絵は、絵を選ぶまで組まれない(ページが無い)ので、プレビューは絵を選んだときに送る
   */
  const followPlate = (id: string) => {
    flash(id);
    onFollow?.('plate', id);
  };
  const followImg = (chapter: number, block: number, hasPicture: boolean) => {
    flash(imgRowId(chapter, block));
    if (hasPicture) onFollow?.('img', imageKey(chapter, block));
  };

  const setPickingAndNotify = (v: string | null) => {
    setPicking(v);
    onOpenChange?.(v !== null);
  };
  const setPlacingAndNotify = (v: typeof placing) => {
    setPlacing(v);
    onOpenChange?.(v !== null);
  };

  /**
   * 挿絵ページを1枚足す。**絵はまだ選ばない。**(2026-08-20 ユーザー判断)
   *
   * もとは「絵を選んだ瞬間にページができる」形で、コラムページの
   * 「足す → 中を書く」と手順が食い違っていた。
   * 先に枠を作って中で絵を選ぶ形にそろえると、位置も大きさも先に決められる。
   *
   * **`addAt` を見ずに `chapters.length` 決め打ちだった(2026-08-20 に回帰)。**
   * ページ一覧の「＋」から挿絵を選ぶと `addAt` に押した切れ目が渡ってくるのに、
   * ここが受け取らずに握りつぶしていたので、どこの「＋」から入っても
   * 本文の最後（奥付の前）に足されていた。`addBlank` は同じ `addAt` を最初から
   * 見ていたので気づきにくかった
   */
  function addEmpty() {
    const id = crypto.randomUUID();
    onChange([
      // ページ一覧の「＋」から来ていればその切れ目。無ければ**本文の最初**。
      // 巻末に足していたころは、下の一覧でも末尾に出て「押したのに増えていない」と
      // 探させた(2026-09-04 ユーザー報告)。**配列の先頭へ入れる**のは、同じ切れ目に
      // 先客がいても新しい1枚が一覧と刷りの両方で先頭に来るようにするため
      // (組版は order の無いもの同士を配列順で並べる。html.ts の insertsBefore)
      { id, src: '', beforeChapter: addAt ?? 0, size: 'full' },
      ...plates,
    ]);
    onAddAtUsed?.();
    onAdded?.(id);
  }

  /**
   * クッションページ。絵も文字も置かない1ページ。
   *
   * **「白紙」とは呼ばない。** 背景は @page に敷いてあり @page plate は余白だけを
   * 上書きするので、このページにも背景が出る。白い紙にはならない。
   * 「絵のないページ」も嘘で、背景そのものが絵。呼び名は利用者が調べて持ってきたもの。
   * **なぜ入れるのかが名前に入っている**のが採った理由(2026-08-18)。
   *
   * **出るのは「本文」の背景。目次のものではない**(実測: 目次だけ別の絵にして組むと、
   * クッションの絵は本文ページと同じハッシュになった)。
   *
   * **ページを1枚足すだけの道具で、置き場所は選ばない。** ただし「余りを埋める」用途に
   * 限っては本文が始まる前でないと効かない。奇数起こし(break-before: recto)を課しているのは
   * 最初の章だけで、それ以外の章は break-before: page だから、途中に置いても
   * ページが1枚増えるだけで白は生まれない(章の切れ目に置く挿絵で実測済み)。
   *
   * **余りは1ページだけで、クッションでも挿絵でも埋まる。** 前付け
   * (大扉・目次・クッション・挿絵)の合計が偶数なら本文が素直に始まり、奇数なら組版が
   * 白を1枚挟む。文庫サンプルで実測:
   *
   * | 前付け | 結果 |
   * |---|---|
   * | 大扉+目次+挿絵1 | P4 が白。挿絵は目次と向かい合う |
   * | 大扉+目次+クッション1+挿絵1 | 白なし。挿絵 P4 が章の起こし P5 と向かい合う |
   * | 大扉+目次+**挿絵2** | 白なし。**もう1枚の絵でも埋まる** |
   * | 大扉+挿絵1(目次なし) | 白なし。ここで足すと逆に白が出る |
   */
  function addBlank() {
    const id = crypto.randomUUID();
    onChange([
      ...plates,
      // ページ一覧の「＋」から来ていればその切れ目。無ければ本文の頭
      { id, src: '', beforeChapter: addAt ?? 0, size: 'full', blank: true },
    ]);
    onAddAtUsed?.();
    onAdded?.(id);
  }

  /**
   * 章の途中の場所が選ばれた。新しく入れるなら**絵の無い枠**を置き、
   * 動かすならいまの絵をそこへ移す。どちらも、その行を光らせて見せに行く。
   *
   * 枠を先に置いて絵はあとで選ぶのは、挿絵ページの「足す → 絵を選ぶ」にそろえるため
   * (2026-08-20 ユーザー判断と同じ理由。場所と大きさを先に決められる)
   */
  function place(chapter: number, after: number) {
    if (!onChaptersChange) return;
    const target = placing;
    setPlacingAndNotify(null);
    setNotice('');
    if (target === 'new') {
      onChaptersChange(
        insertImage(chapters, chapter, after, { type: 'image', src: '', fromStudio: true }),
        opKey(),
      );
      followImg(chapter, after + 1, false);
    } else if (target) {
      // **動かす絵が、選び始めたときと同じ場所にまだあるか確かめる。** 場所を選んでいる
      // あいだに［元に戻す］などで本文が変わると、番号が別のブロックを指す。確かめずに動かすと
      // 関係ない段落を動かしてしまう(2026-09-23 レビューで発見)。絵は書き換えのたびに
      // 新しい値になるので、同じものかは参照で比べられる
      if (chapters[target.chapter]?.blocks[target.block] !== target.image) {
        setNotice('場所を選んでいるあいだに本文が変わったので、動かすのをやめました。もう一度［場所を選び直す］から選んでください');
        return;
      }
      const moved = moveImage(chapters, target, { chapter, after });
      onChaptersChange(moved.chapters, opKey());
      followImg(moved.at.chapter, moved.at.block, !!target.image.src);
    }
  }

  /**
   * その面に出すものだけ。中身は同じ配列に入っている。
   * **一覧はページ順(場所→順番)で並べる。** 配列の順(足した順)のままだと、
   * 「場所」を変えても行が動かず、本の順番と一覧の順番が食い違って探させる
   * (2026-09-04 ユーザー要望「ページを移動すると、ページ順の位置に移動する、としてほしい」)。
   * 並べ替えるのは表示だけ — onChange は元の配列を id で触るので壊れない。
   *
   * 章の途中の絵は、その章の切れ目のページより後ろ・次の切れ目より前に入る
   * (並びの鍵の2つめ: 切れ目のページが 0、章の中の絵が 1)
   */
  const LAST = Number.MAX_SAFE_INTEGER;
  const rows: Row[] = [
    ...plates
      .map((p, idx) => [p, idx] as const)
      .filter(([p]) => (only === 'blanks' ? !!p.blank : !p.blank))
      // order の無いものは末尾扱い+配列順 — 組版(html.ts insertsBefore)と同じ規則。
      // ここが刷りの順とズレると、一覧の並びがまた嘘になる
      .map(([p, idx]): Row => ({
        kind: 'plate',
        plate: p,
        sort: [p.beforeChapter, 0, p.order ?? LAST, idx],
      })),
    ...(only === 'plates' && onChaptersChange
      ? listInlineImages(chapters).map(
          (r): Row => ({ kind: 'img', ...r, sort: [r.chapter, 1, r.block, 0] }),
        )
      : []),
  ].sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a.sort[i] !== b.sort[i]) return a.sort[i] - b.sort[i];
    return 0;
  });

  /**
   * **開いている一覧の行が無くなったら、一覧を閉じる。**(2026-09-23 レビューで発見)
   * 行を消した・［元に戻す］で行が減った、などで開いた行が無くなると、絞り込み(picking)が
   * 何も指さないまま残り、一覧も足すボタンも出ない画面で止まっていた
   */
  const pickingExists =
    picking === null ||
    rows.some((r) =>
      r.kind === 'plate' ? r.plate.id === picking : imgRowId(r.chapter, r.block) === picking,
    );
  useEffect(() => {
    if (!pickingExists) setPickingAndNotify(null);
    // setPickingAndNotify は毎回作り直される関数なので依存に入れない(入れると毎描画で走る)
  }, [pickingExists]);

  /** 1枚を書き換えて、その1枚を追いかける(場所・大きさ・絵のどれを変えても) */
  function patch(id: string, p: Partial<Plate>) {
    onChange(plates.map((x) => (x.id === id ? { ...x, ...p } : x)));
    followPlate(id);
  }

  // 場所を選ぶ画面。**開いているあいだは一覧も足すボタンも描かない**
  if (placing !== null && onChaptersChange) {
    return (
      <ParagraphPicker
        chapters={chapters}
        initialChapter={placing === 'new' ? 0 : placing.chapter}
        moving={placing === 'new' ? undefined : placing}
        onPick={place}
        onBack={() => setPlacingAndNotify(null)}
      />
    );
  }

  /** 章の切れ目の1ページ(クッションもこの形) */
  const plateRow = (p: Plate, i: number) => {
    const now = layout.platePages.get(p.id) ?? null;
    /** この行の画像一覧を開いているか。**開いているあいだは一覧だけを描く**(下の imgRow と同じ) */
    const open = picking === p.id;
    return (
      <li key={p.id} data-id={p.id} className={rowClass(p.id, `plate:${p.id}`)}>
        {!open && (
          <>
        {/* **押すとそこへ飛ぶリンクは、行のいちばん上に置く。**(2026-09-14 ユーザー報告
            「挿絵とコラムでリンクの場所が上だったり下だったりして無駄に探してしまう」)
            コラムページ(ColumnPageEditor)は見出し(.colpage-head)の中=行の先頭に
            このリンクがあるのに、挿絵側はヒント文の末尾=行の最後に付けていたので、
            面を切り替えるたびに目が迷っていた。ヒント文とは切り離し、
            独立した行として他の中身より先に出す(クッションもこの部品を共有するので同時に直る)。
            **字も「◯ページ目（見る）」にそろえる。** もとは「いま ◯ページ目（見る）」で、
            場所をそろえたあとも字だけ食い違って見えた(2026-09-14 ユーザー判断でコラム側に寄せた) */}
        {ebookView ? (
          // 電子に入るのは絵のある挿絵ページだけ(白ページも絵の無い枠も、入らない形式の絵も入らない)
          !p.blank && isEpubImage(p.src) ? (
            <p className="hint plate-jump">
              <button className="linklike" onClick={() => onFollow?.('plate', p.id)}>
                電子の下見で見る
              </button>
            </p>
          ) : null
        ) : (
          now !== null && (
            <p className="hint plate-jump">
              <button className="linklike" onClick={() => onJump?.(now)}>
                {p.size === 'spread' && !p.blank && p.src ? `${now}・${now + 1}` : now} ページ目（見る）
              </button>
            </p>
          )
        )}
        {p.blank ? (
          <span className="plate-thumb blank">クッション</span>
        ) : p.src ? (
          // 白黒で刷る絵は、一覧の絵も灰色で見せる(画面だけ。4-6)
          <img className={monoThumb(p.printMono)} src={p.src} alt={`挿絵${i + 1}`} />
        ) : (
          <span className="plate-thumb empty">画像はまだ</span>
        )}
        <div className="plate-fields">
          {!p.blank && only === 'plates' && <span className="plate-kind">章の切れ目のページ</span>}
          <select
            value={Math.min(p.beforeChapter, chapters.length)}
            onChange={(e) => patch(p.id, { beforeChapter: Number(e.target.value) })}
          >
            {chapters.map((_, ci) => (
              <option key={ci} value={ci}>{positionLabel(chapters, ci)}</option>
            ))}
            <option value={chapters.length}>{positionLabel(chapters, chapters.length)}</option>
          </select>
          {/* 白ページに大きさは無い */}
          {!p.blank && (
            <select
              value={p.size}
              // 大きさを変えたら、「このままにする」も消す(その大きさでの了解なので、置き方が変われば確かめ直す)
              onChange={(e) => patch(p.id, { size: e.target.value as PlateSize, textOk: undefined })}
            >
              {(Object.keys(PLATE_SIZES) as PlateSize[]).map((k) => (
                <option key={k} value={k}>{PLATE_SIZES[k].label}</option>
              ))}
            </select>
          )}
          <button
            className="ghost"
            onClick={() => onChange(plates.filter((x) => x.id !== p.id))}
          >
            ページを削除
          </button>
        </div>
          </>
        )}
        {/* **絵はこのページの中で選ぶ。**(2026-08-20 ユーザー判断)
            1枚ごとに置くので、どのページの絵を替えているのかが迷いようがない。
            一覧を開いた1枚だけを描く(他の面のピッカーと同じ扱い) */}
        {!p.blank && (
          <BackgroundPicker
            label={`${i + 1}枚目の画像`}
            value={p.src ? { src: p.src, fromPreset: p.fromPreset } : undefined}
            showState={false}
            showThumb={false}
            showLabel={false}
            shopHint="テーマ別・様式別の有料の画像パックです。表紙にも背景にも挿絵にも使えます。買った画像は［画像を選ぶ］から読み込めます"
            open={picking === p.id}
            onOpenChange={(o) => setPickingAndNotify(o ? p.id : null)}
            // 見開きは用紙2枚ぶんの広さなので、取り込みの長い辺の上限を表紙の「まるごと1枚」と同じにする(A4・B5 でも 300ppi 前後に届く)
            maxSide={p.size === 'spread' ? WRAP_MAX_SIDE : undefined}
            onChange={(spec) =>
              // 絵を替えたら、「このままにする」も消す(別の絵なので、確かめ直す)
              patch(p.id, { src: spec?.src ?? '', fromPreset: spec?.fromPreset, textOk: undefined })
            }
          />
        )}
        {!open && (
        <p className="hint">
          {p.blank
            ? '画像も文字も置かないページ（背景は出ます）'
            : p.src
              ? PLATE_SIZES[p.size].hint
              : '画像を選ぶまでは、背景だけの1ページとして出ます'}
        </p>
        )}
        {/* 見開きの絵の注意。**綴じ方で言うことが変わる**(中綴じは向いている・無線は真ん中が糊で隠れる)。
            白いページを入れたときは、その1行を必ず出す(黙って足さない) */}
        {!open && !p.blank && p.size === 'spread' && (
          <>
            {p.src && !ebookView && layout.spreadBlank.has(p.id) && (
              <p className="warn" role="status">{SPREAD_AUTO_BLANK_NOTE}</p>
            )}
            <p className="hint">{ebookView ? SPREAD_EBOOK_NOTE : spreadBindingNote(binding)}</p>
            {/* 絵の縦横比が見開きと違うとき(中央だけが使われる)。取り込みの上限の知らせ(SPREAD_REPICK_NOTE)は細かさの知らせの下に出す */}
            {!ebookView &&
              (spreadNotes?.get(p.id) ?? [])
                .filter((n) => n !== SPREAD_REPICK_NOTE)
                .map((n) => (
                  <p key={n} className="hint">{n}</p>
                ))}
          </>
        )}
        {!open &&
          textCheckNote(
            textRows?.get(`plate:${p.id}`),
            now !== null,
            () => patch(p.id, { size: 'print', textOk: undefined }),
            () => patch(p.id, { textOk: true }),
          )}
        {!open && textKeptNote(p.textOk, !p.blank && !!p.src && p.size !== 'print', () => patch(p.id, { textOk: undefined }))}
        {!open && !p.blank && !!p.src && resNote(`plate:${p.id}`)}
        {!open && !p.blank && !!p.src && printColor && !ebookView && (
          <PrintMonoToggle
            checked={!!p.printMono}
            onChange={(v) => patch(p.id, { printMono: v || undefined })}
            look={colorRows?.get(`plate:${p.id}`)}
          />
        )}
        {/* 見開きに切り替えただけの絵は 4200px のまま(見開きは 6200px まで取り込める)。細かさが足りないときだけ、選び直しを1行で */}
        {!open && !p.blank && !!p.src && !ebookView && spreadNotes?.get(p.id)?.includes(SPREAD_REPICK_NOTE) && (
          <p className="hint">{SPREAD_REPICK_NOTE}</p>
        )}
      </li>
    );
  };

  /** 章の途中の絵 */
  const imgRow = (chapter: number, block: number, img: ImageBlock, i: number) => {
    const id = imgRowId(chapter, block);
    const now = layout.imgPages.get(imageKey(chapter, block)) ?? null;
    const size = imageSizeOf(img);
    const anchor = anchorSnippet(chapters[chapter], block);
    const write = (fn: (b: ImageBlock) => ImageBlock, key = opKey()) =>
      onChaptersChange?.(patchImage(chapters, chapter, block, fn), key);
    /** 大きさ・絵を変えたら追いかける。キャプションの打鍵では追わない(1字ごとに飛ばない) */
    const writeAndFollow = (fn: (b: ImageBlock) => ImageBlock) => {
      const next = fn(img);
      write(() => next);
      followImg(chapter, block, !!next.src);
    };
    /**
     * この行の画像一覧を開いているか。**開いているあいだは一覧だけを描く。**
     * 行の［絵を削除］が押せたままだと、消した行の番号に次の絵が繰り上がり、
     * 一覧が別の絵のものにすり替わった(2026-09-23 レビューで発見)
     */
    const open = picking === id;
    return (
      <li key={id} data-id={id} className={rowClass(id, id)}>
        {!open && (
          <>
        {ebookView ? (
          isEpubImage(img.src) ? (
            <p className="hint plate-jump">
              <button
                className="linklike"
                onClick={() => onFollow?.('img', imageKey(chapter, block))}
              >
                電子の下見で見る
              </button>
            </p>
          ) : null
        ) : (
          now !== null && (
            <p className="hint plate-jump">
              <button className="linklike" onClick={() => onJump?.(now)}>
                {now} ページ目（見る）
              </button>
            </p>
          )
        )}
        {img.src ? (
          <img className={monoThumb(img.printMono)} src={img.src} alt={`挿絵${i + 1}`} />
        ) : (
          <span className="plate-thumb empty">画像はまだ</span>
        )}
        <div className="plate-fields">
          {/* 場所は「◯章の途中」と、直前の段落の書き出しで言う。
              番号で言われても本文のどこなのか思い出せない */}
          <span className="plate-kind">{chapterName(chapters, chapter)} の途中</span>
          <span className="plate-where">
            {anchor ? `${anchor}のあと` : '章のはじめ（見出しのすぐあと）'}
          </span>
          <button
            className="ghost"
            onClick={() => setPlacingAndNotify({ chapter, block, image: img })}
          >
            場所を選び直す
          </button>
          <select
            value={size}
            onChange={(e) =>
              writeAndFollow((b) => {
                // 大きさを変えたら、「このままにする」も消す(その大きさでの了解なので、置き方が変われば確かめ直す)
                const next = withImageSize(b, e.target.value as ImageSizeChoice);
                delete next.textOk;
                return next;
              })
            }
          >
            {(Object.keys(IMAGE_SIZES) as ImageSizeChoice[]).map((k) => (
              <option key={k} value={k}>{IMAGE_SIZES[k].label}</option>
            ))}
          </select>
          {/* キャプションは本文の中に置く絵だけ。1ページを使う絵には置く余白が無い
              (全面画像にキャプションを置かないのと同じ理由。typeset/html.ts) */}
          {size === 'flow' && (
            <input
              type="text"
              value={img.caption ?? img.alt ?? ''}
              placeholder="キャプション（なくてもよい）"
              // 打っているあいだ組版を待たせる(奥付・コラムと同じ栓。長い本で1字ごとに組み直さない)
              data-defer-typeset=""
              onChange={(e) =>
                write((b) => ({ ...b, caption: e.target.value }), `inline-caption:${chapter}:${block}`)
              }
            />
          )}
          <button
            className="ghost"
            onClick={() => onChaptersChange?.(removeImage(chapters, chapter, block), opKey())}
          >
            画像を削除
          </button>
        </div>
          </>
        )}
        <BackgroundPicker
          label={`${i + 1}枚目の画像`}
          value={img.src ? { src: img.src, fromPreset: img.fromPreset } : undefined}
          showState={false}
          showThumb={false}
          showLabel={false}
          shopHint="テーマ別・様式別の有料の画像パックです。表紙にも背景にも挿絵にも使えます。買った画像は［画像を選ぶ］から読み込めます"
          open={picking === id}
          onOpenChange={(o) => setPickingAndNotify(o ? id : null)}
          onChange={(spec) =>
            writeAndFollow((b) => {
              const next: ImageBlock = { ...b, src: spec?.src ?? '' };
              if (spec?.fromPreset) next.fromPreset = true;
              else delete next.fromPreset;
              // 絵を替えたら、「このままにする」も消す(別の絵なので、確かめ直す)
              delete next.textOk;
              return next;
            })
          }
        />
        {!open && (
          <>
        <p className="hint">
          {!img.src
            ? '画像を選ぶと、この場所に組まれます'
            : size === 'flow'
              ? IMAGE_SIZES.flow.hint
              : `${IMAGE_SIZES[size].hint}。その段落のところで改ページするので、前のページの下が空くことがあります`}
        </p>
        {/* **刷れない形式はその行で言う。** Word が Excel・PowerPoint から貼った絵を
            EMF/WMF で保存していることがあり、ブラウザが描けないので組まれない。
            もとは［文中に貼る］の面が枚数と形式を出していた(その面は撤去した) */}
        {img.src && !isRenderableImage(img.src) && (
          <p className="error">
            {imageFormatLabel(img.src) || 'この'} 形式の画像は<b>ブラウザが表示できない</b>ため組まれません。
            PNG か JPEG の画像を選び直してください
          </p>
        )}
        {/* 原稿から来た絵は、原稿を取り込み直すと原稿の側から戻ってくる。
            ここで動かしたぶんは、そのとき原稿の位置に戻る(スタジオで入れた絵は付け直す) */}
        {!img.fromStudio && img.src && (
          <p className="hint">
            原稿（Word）に貼ってあった画像です。原稿を取り込み直すと、原稿のとおりの場所に戻ります
          </p>
        )}
        {!!img.src && resNote(`img:${imageKey(chapter, block)}`)}
        {!!img.src && isRenderableImage(img.src) && printColor && !ebookView && (
          <PrintMonoToggle
            checked={!!img.printMono}
            onChange={(v) =>
              write((b) => {
                const next = { ...b };
                if (v) next.printMono = true;
                else delete next.printMono;
                return next;
              })
            }
            look={colorRows?.get(`img:${imageKey(chapter, block)}`)}
          />
        )}
        {textCheckNote(
          textRows?.get(`img:${imageKey(chapter, block)}`),
          now !== null,
          () =>
            writeAndFollow((b) => {
              const next = withImageSize(b, 'print');
              delete next.textOk;
              return next;
            }),
          () => write((b) => ({ ...b, textOk: true })),
        )}
        {textKeptNote(img.textOk, !!img.src && size !== 'flow' && size !== 'print', () =>
          write((b) => {
            const next = { ...b };
            delete next.textOk;
            return next;
          }),
        )}
          </>
        )}
      </li>
    );
  };

  /**
   * 絵のある行の通し番号(「◯枚目の絵」)。クッションは数えない。
   * **絞り込む前に振る** — 一覧を開いた1枚だけを描くときも、番号は本の中の番号のまま
   */
  let pictureNo = 0;
  const numbered = rows.map((r) => ({
    r,
    n: r.kind === 'plate' && r.plate.blank ? 0 : pictureNo++,
  }));

  /**
   * 「直すところ」から来たときの札に並べる画像。**一覧にいまある行だけ**(消した画像は出さない)。
   * 差し替えて足りるようになった画像も、札を閉じるまでは「細かさが足りるようになりました」と残す(数が急に減ると、どれが直ったか分からない)
   */
  const spotItems = (spot ?? []).flatMap((key) => {
    const r = rows.find((x) =>
      x.kind === 'plate' ? `plate:${x.plate.id}` === key : imgRowId(x.chapter, x.block) === key,
    );
    if (!r) return [];
    const page = pageOfKey(key);
    const at = page !== null ? `${page}ページ` : '';
    let label: string;
    if (r.kind === 'plate') {
      label = at ? `${at}の挿絵ページ` : '挿絵ページ';
    } else {
      const ch = chapters[r.chapter];
      const name = (ch && [ch.no, ch.title].filter(Boolean).join('　')) || `${r.chapter + 1}つめの章`;
      label = `${name} の途中の画像${at ? `（${at}）` : ''}`;
    }
    return [{ key, label, page, verdict: resRows?.get(key) }];
  })
    // ページ順に並べる(まだ数えていない画像は後ろへ)
    .sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity));

  return (
    <div className="plates">
      {only === 'plates' && !picking && spot && spotItems.length > 0 && (
        <div className="spot-box" role="status">
          <p className="spot-title">
            <b>おすすめの細かさに届かない画像</b>（{spotItems.length}枚）
          </p>
          <p className="hint">下の一覧で枠がついている行です。押すと、その行へ移動し、右の下見に表示されます。</p>
          <ul>
            {spotItems.map(({ key, label, verdict }) => (
              <li key={key}>
                <button className="linklike" onClick={() => goSpot(key)}>
                  {label}
                </button>
                <span>{verdict ? `約 ${verdict.ppi}ppi` : '細かさが足りるようになりました'}</span>
              </li>
            ))}
          </ul>
          <button className="ghost" onClick={() => setSpot(null)}>
            知らせを閉じる
          </button>
        </div>
      )}
      {only === 'plates' && !picking && (
        <>
          {/* **入れ方は2通り。ボタンも2つに分ける。**(2026-09-23)
              場所の選び方がまるで違う(切れ目は一覧から選ぶ・途中は段落を選ぶ)ので、
              1つのボタンで足してから種類を変えさせるより、先に分かれたほうが迷わない */}
          <p className="step-lede">画像の入れ方は2通りです。</p>
          <button className="ghost add-page" onClick={addEmpty}>
            章の切れ目に、画像だけのページを足す
          </button>
          <p className="hint">
            <b>本文の最初</b>に1枚入ります。場所は下の一覧で選び直せます。
            {!ebookView && (
              <>
                <b>右のページ一覧の［＋］</b>から足すと、その切れ目に直接入ります
              </>
            )}
          </p>
          {onChaptersChange && (
            <>
              <button
                className="ghost add-page"
                disabled={!chapters.some((c) => c.blocks.length)}
                onClick={() => setPlacingAndNotify('new')}
              >
                章の途中に、画像を入れる
              </button>
              <p className="hint">入れたい段落を選ぶと、そのあとに入ります</p>
            </>
          )}
        </>
      )}

      {/* 一覧を開いているあいだは、挿絵の一覧も［クッションページを足す］も描かない
          (他の面のピッカーと同じ扱い) */}
      {only === 'blanks' && !picking && (
        <>
          <button className="ghost add-page" onClick={addBlank}>
            クッションページを足す
          </button>
          {/* **行き先も書く。**(2026-08-19 ユーザーの提案)
              このボタンは押すと本文の頭に付くので、入れたい場所が決まっているなら
              右のページ一覧の「＋」のほうが早い。捨てずに残すのは、
              一覧を畳んでいる人と、場所をあとで決めたい人がいるため */}
          {/* 電子の下見にはページ一覧が無い(挿絵・コラムの面と同じく、紙の下見のときだけ案内する) */}
          <p className="hint">
            このボタンは<b>本文の最初</b>に足します。
            {!ebookView && (
              <>
                場所が決まっているなら、<b>右のページ一覧の［＋］</b>から足すとその切れ目に入ります
              </>
            )}
          </p>
        </>
      )}

      {/* 推奨サイズはここに出さない。
          BOOTH の導線の真下に大きさの一覧が並ぶと「大きさ別に売っている」ように読める。
          余白ありの寸法を出すのはもっと悪く、**わざわざ小さい画像を用意させてしまう**
          (絵は全面ぶんの画素で持っておけば、どの大きさを選んでも足りる)。
          数値は情報バーの「ページ全面」に1つだけ置く(2026-08-16 ユーザー指摘) */}

      {notice && !picking && <p className="warn">{notice}</p>}

      {rows.length > 0 && (
        <ul className="plate-list">
          {numbered
            .filter(
              ({ r }) =>
                !picking ||
                (r.kind === 'plate'
                  ? picking === r.plate.id
                  : picking === imgRowId(r.chapter, r.block)),
            )
            .map(({ r, n }) =>
              r.kind === 'plate' ? plateRow(r.plate, n) : imgRow(r.chapter, r.block, r.image, n),
            )}
        </ul>
      )}
    </div>
  );
}
