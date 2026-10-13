// 面ごとの背景を選ぶUI。大扉・本文・目次・章・奥付を**すべて同じ体裁**で並べるための部品。
//
// 表紙タブと同じ画像パック(public/covers)から選べるようにして、買った素材を本文でも使い回せる。
//
// 選んだ絵は data URI にして設定に持つ。
// 相対URLのままだと、印刷ダイアログ経由(printHTML の iframe)や書き出し後のHTMLで
// 解決先が変わって絵が消えることがあるため。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { type BgSpec } from '../models/project';
import { optimizeImageDataUri } from '../images/optimize';
import { IMAGE_ACCEPT, readImageFileAsDataUri } from '../images/imageFile';
import { loadCoverPresets } from '../covers/manifest';
import { isBundledPresetId } from '../covers/presetIds';
import { PresetScreen, type PresetItem } from './PresetScreen';
import { BackgroundResolutionNote } from './ResolutionNote';

// 一覧そのもの(絞り込み・並べ方・BOOTH の導線)と利用条件の文言は PresetScreen へ移した。
// **表紙タブと同じ形を使うため。** ここから PresetTerms を import している呼び出し元が
// いるので、名前はそのまま通しておく
export { PresetTerms } from './PresetScreen';

// 利用者が選んだ画像のファイルは、頭の数バイトで JPEG・PNG かを確かめてから data URI にする。
// それ以外(HEIC・WebP・種類の分からないファイルなど)は日本語で断る(images/imageFile.ts。2026-10-13 修正リスト 27)
const fileToDataUri = readImageFileAsDataUri;

async function urlToDataUri(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} を読み込めませんでした`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('変換に失敗しました'));
    r.readAsDataURL(blob);
  });
}

/**
 * 面ごとの背景(大扉・目次・章・奥付)のピッカーに渡す、値・書き込み・濃さとフチの調整。
 * **［本文に画像とコラムを入れる］の［背景］と、［奥付と著者紹介を入れる］の両方で使う。**
 * 奥付の背景は両方から変えられる(2026-09-23 ユーザー要望「奥付タブで変えられる方が親切」)。
 * 同じ面を2か所で別々に組み立てると、片方だけ調整の出し方が変わって食い違うので1つにした。
 * **濃さ・文字のフチの調整はここでは出さない。**(2026-10-09 ユーザー判断「デザインに関連する話は下のバーで」)
 * 画面下の帯が、そのページ(大扉・目次・奥付・章)を向いているときに変える(FormatBar の page: / 章の範囲)
 */
export function bgSurfaceProps(
  spec: BgSpec | undefined,
  write: (next: BgSpec | undefined) => void,
): Pick<Props, 'value' | 'onChange'> {
  return { value: spec, onChange: write };
}

interface Props {
  label: string;
  hint?: string;
  value: BgSpec | undefined;
  onChange: (spec: BgSpec | undefined) => void;
  /** 「設定あり/未設定」の表示。追加用のボタンとして使うときは切る */
  showState?: boolean;
  /**
   * いま入っている絵の枠。**追加用のボタンとして使うときは出さない。**
   * これから足す1枚に「いまの絵」は無いので、「なし」と書かれた空箱が
   * 常に置かれているだけになっていた(2026-08-20 ユーザー指摘)
   */
  showThumb?: boolean;
  /**
   * 見出し(h3)を出すか。**追加用のボタンとして使うときは出さない。**
   * 面ごとのピッカーが縦に並ぶ背景タブでは、どの面の操作か分かるように必須だが、
   * 挿絵タブには1つしか無いうえ、上のリードが同じことを言っていた
   * (2026-08-20 ユーザー指摘「リード・見出し・ボタンの関係がいまいち」)
   */
  showLabel?: boolean;
  /**
   * 背景としての細かさの一言(修正リスト 19)を出すか。既定は showLabel と同じ(背景の面のピッカーだけ)。
   * 挿絵の「画像を選ぶ」にも使い回しているが、挿絵は自分の行に挿絵の大きさで測った一言を出すので、
   * ここで全面の数字を重ねて出さない(見直しの指摘 2026-10-12)
   */
  showResolution?: boolean;
  /** 絵を指定しないときに「本文と同じ / 無地」を選ばせる(目次・奥付) */
  allowPlain?: boolean;
  /** 継承元の呼び名。指定すると、絵が無いとき「◯◯と同じ」と表示する */
  inheritFrom?: string;
  /** 素材の購入導線。文言はその面に合わせて変える(挿絵/背景) */
  shopLabel?: string;
  /** 購入導線の下に添える紹介文。ここまでが「追加」の話だと切れ目を作る役目も持つ */
  shopHint?: string;
  /**
   * 一覧の開閉を親が握りたいときに渡す。渡さなければ今まで通り自分で持つ。
   * ArtStep 側は「いま画面上で開いている一覧はどれか」を1つの状態で持ちたいので、
   * 制御できるようにしておく(渡さない呼び出し元の動きは変えない)。
   */
  open?: boolean;
  /**
   * 開閉が変わるたびに呼ぶ。親はこれで「いま一覧を開いているか」を知り、
   * 開いているあいだはサイドバーの他の項目を描かないようにする。
   */
  onOpenChange?: (open: boolean) => void;
  /** 取り込む絵の長い辺の上限(画素)。省略は本文の全面ぶん(optimize.ts の PRINT_MAX_SIDE)。見開きの挿絵は広いので大きくする */
  maxSide?: number;
  /**
   * 一覧を開いていないときに、説明の下へ足すもの(2026-10-12 1.1.0)。
   * 背景の面の「白黒で刷る」(PrintMonoToggle)に使う。白黒で刷る面は、枠の絵も灰色で見せる(mono)
   */
  extra?: ReactNode;
  mono?: boolean;
}

export function BackgroundPicker({
  label,
  hint,
  value,
  onChange,
  showState = true,
  showThumb = true,
  showLabel = true,
  showResolution = showLabel,
  allowPlain = false,
  inheritFrom,
  shopLabel,
  shopHint,
  open: openProp,
  onOpenChange,
  maxSide,
  extra,
  mono = false,
}: Props) {
  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [openState, setOpenState] = useState(false);
  // open は制御あり(openProp を渡された)ときはそちらに従い、無ければ自前の状態を使う。
  // setOpen は差し替わった値をそのつど onOpenChange で親へ知らせる。
  const open = openProp ?? openState;
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const v = typeof next === 'function' ? (next as (prev: boolean) => boolean)(open) : next;
    if (openProp === undefined) setOpenState(v);
    onOpenChange?.(v);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || presets.length) return;
    // 同梱ぶんと、自分で足した画像(manifest.mine.json)を繋げて読む。
    // **'body' は表紙用の縦長の絵も返す**(表紙パックを本文で使い回せるのが元からの狙い)。
    // 出さないのは、まるごと1枚(表紙全体の横長の見開き。use:'cover')だけ。
    // 逆向きでは、帯つきの本文の地は表紙の一覧に出ない
    void loadCoverPresets('body').then((list) => setPresets(list as PresetItem[]));
  }, [open, presets.length]);

  /** 絵を差し替える。濃さ・フチの指定は残す(絵を変えるたびに調整し直さずに済む) */
  /**
   * 絵を差し替える。
   *
   * `fromPreset` は「同梱のプリセットから選んだ」目印。**選んだ瞬間にしか分からない。**
   * プリセットは読み込んだ時点で data URI になるので、保存したあとは
   * 利用者が自分で用意した画像と見分けがつかなくなる。
   * この目印が無いと「04 書き出し」の AI 生成コンテンツの申告が出せない
   * (同梱の絵は生成AI製で、KDP は申告を求めている)。
   */
  async function pick(run: () => Promise<string>, fromPreset = false, presetId?: string) {
    setError('');
    setBusy(true);
    try {
      // 透過を使っていない大きな PNG はここで JPEG に置き換える。
      // 背景や挿絵は1枚が数MBになるので、保存にも組版にも紙PDFにも効く
      const next: BgSpec = { ...value, src: await optimizeImageDataUri(await run(), maxSide) };
      if (fromPreset) next.fromPreset = true;
      else delete next.fromPreset; // 自前の画像に差し替えたら目印を消す
      // どの同梱のプリセットか(2026-10-12 改修の希望 2)。高解像度版への差し替えの手がかり。目印と同じく、自前の画像では消す
      if (fromPreset && presetId) next.presetId = presetId;
      else delete next.presetId;
      onChange(next);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function clearImage() {
    const rest: BgSpec = { ...value };
    delete rest.src;
    delete rest.fromPreset;
    delete rest.presetId;
    // 白黒で刷る印は、その面の絵についての指定。絵を外したら一緒に外す(継いだ絵は本文全体の印に従う)
    delete rest.printMono;
    // 絵も調整も無くなったら、面ごとの設定そのものを外して継承に戻す
    onChange(Object.keys(rest).length ? rest : undefined);
  }

  const src = value?.src;
  const plain = !src && value?.base === 'plain';

  /**
   * プリセットを開いているときの画面。**選ぶことだけに使う。**
   *
   * 見た目と操作は PresetScreen(表紙タブと共通)に任せ、ここは**選ばれた絵の後始末**だけやる。
   * 相対URLのままでは、印刷ダイアログ経由(printHTML の iframe)や書き出し後のHTMLで
   * 解決先が変わって絵が消えるので、data URI に直してから設定に入れる。
   *
   * 選んだら閉じる。この面には表紙タブのようなプレビューが無く、
   * 開いたままにしても選んだ結果を見比べられないため
   */
  if (open) {
    return (
      <PresetScreen
        label={label}
        presets={presets}
        busy={busy}
        error={error}
        shopLabel={shopLabel}
        shopHint={shopHint}
        onBack={() => setOpen(false)}
        // 同梱の絵には id を付ける(自分で足した開発用の絵 manifest.mine.json は同梱ではないので付けない)
        onPick={(pr) =>
          void pick(() => urlToDataUri(`covers/${pr.file}`), true, isBundledPresetId(pr.id) ? pr.id : undefined)
        }
        // 画像のフォルダ(「アップロード」の段)。［画像を選ぶ］と同じ取り込み。
        // ファイル名が同梱のプリセットの id なら、その高解像度版として目印と id を付ける(2026-10-12 改修の希望 2)
        onPickFile={(file, presetId) => pick(() => fileToDataUri(file), !!presetId, presetId)}
      />
    );
  }

  return (
    <div className={showLabel ? 'bg-picker' : 'bg-picker bg-add'}>
      {/* 見出しは、面ごとのピッカーが縦に並ぶときだけ。
          同じ見た目のものが何本も並ぶので、無いとどの面の操作か分からない。
          追加用に1つだけ置くときは、上のリードと二重になるので出さない */}
      {showLabel && (
      <h3 className="bg-label">
        {label}
        {showState && (
          <span className={src ? 'bg-state on' : 'bg-state'}>
            {src ? '設定あり' : plain ? '無地' : inheritFrom ? `${inheritFrom}と同じ` : '未設定'}
          </span>
        )}
      </h3>
      )}
      <div className="bg-row">
        {showThumb &&
          (src ? (
            <img className={mono ? 'bg-thumb mono' : 'bg-thumb'} src={src} alt={`${label}の背景`} />
          ) : (
            <span className="bg-thumb empty">{plain ? '無地' : 'なし'}</span>
          ))}
        <div className="bg-buttons">
          <button className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
            画像を選ぶ
          </button>
          <button className="ghost" disabled={busy} onClick={() => setOpen(true)}>
            プリセットから
          </button>
          {/* **［画像を外す］は「絵を選ぶ2つの道」の仲間ではない。**(2026-08-20)
              並びの3つめに同じ顔で置いていたが、これは選ぶのと逆向きの操作で、
              しかも絵が入っているときにだけ現れる。名前を付けて、
              追加用の並び(.bg-add)では行を分けて小さく置けるようにする
              (3つを同じ大きさで横に並べると 287px 要り、挿絵1枚ぶんの箱 256px から
              31px あふれる。実測は app.css の .bg-add を参照) */}
          {src && (
            <button className="ghost bg-clear" disabled={busy} onClick={clearImage}>
              画像を外す
            </button>
          )}
        </div>
      </div>

      {/* 絵を持たない面の地。目次・奥付だけが対象(本文の絵を敷くか、無地にするか) */}
      {allowPlain && !src && (
        <div className="seg">
          <button
            className={!plain ? 'active' : ''}
            onClick={() => {
              const next: BgSpec = { ...value, base: 'inherit' };
              onChange(next);
            }}
          >
            {inheritFrom ?? '本文'}と同じ
          </button>
          <button className={plain ? 'active' : ''} onClick={() => onChange({ ...value, base: 'plain' })}>
            無地
          </button>
        </div>
      )}

      {hint && <p className="hint">{hint}</p>}
      {/* この面の画像の細かさが足りないときの一言(2026-10-12 修正リスト 19。挿絵・表紙と同じ形)。
          出し先が背景も測るとき(PrintTargetProfile.checksBackgroundPpi)だけ文脈から来る。それ以外は何も出ない。同梱のプリセットなら BOOTH の高解像度版の案内つき(21) */}
      {showResolution && (
        <BackgroundResolutionNote
          src={src}
          preset={value?.fromPreset === true}
          // フォルダに高解像度版があるときの［高解像度版に差し替える］。fromPreset・presetId・濃さはそのまま残して、src だけ替える
          presetId={value?.presetId}
          maxSide={maxSide}
          apply={(next) => onChange({ ...value, src: next })}
        />
      )}
      {extra}
      {error && <p className="error">{error}</p>}

      <input
        ref={fileRef}
        type="file"
        accept={IMAGE_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(() => fileToDataUri(f));
          e.target.value = '';
        }}
      />
    </div>
  );
}
