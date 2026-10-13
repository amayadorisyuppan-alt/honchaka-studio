// プロジェクト1冊ぶんの入出力。
//
// 用途が2つあり、**必要なものが逆**なので1つの関数で出し分ける:
//
// - **バックアップ** … 画像込みの完全なもの。欠けていたら復元にならない
// - **AI に渡す**   … 画像を落とした軽いもの。data URI が入るとチャットに貼れない
//
// 画像を落とすときは `#img:titleBg` のような**置き場所の名前**に置き換える。読み込むときに
// **いま開いているプロジェクトの同じ置き場所**から埋め直すので、AI が挿絵の順番を入れ替えても絵は失われない。
//
// ### なぜ「登場順の通し番号」(#img0, #img1, …)をやめたか(2026-09-14)
//
// 元は番号で持っていた。ところが Gemini に渡した AI 用 JSON が `settings.titleBg` の
// **キーを丸ごと落として**返ってきたことがあった。番号は「画像を書き出した順」に振っているので、
// 大扉の背景(本来なら #img0)が丸ごと抜けると、本文中の画像が #img1〜3 から #img0〜2 へ
// **1つずつ繰り上がる**。読み込みは番号を「いま開いているプロジェクトの画像配列への添字」として
// 引くだけなので、#img0 は大扉の背景の実体に化け、本文の挿絵の位置がすべてずれ、
// 最後の1枚は誰にも参照されず消えた(利用者実測)。
//
// 番号は「登場順」という**全体の並びに依存する**目印で、どこか1か所が抜けるだけで
// それより後ろの対応が総崩れになる。置き場所の名前ならその心配がない —
// titleBg が丸ごと無くても、本文の画像の名前(body.0, body.1, …)は影響を受けない。
// AI が本文の画像ブロックを別の場所へ動かしても、目印はそのブロックの中にあるので
// **画像はブロックについて動く**(これは仕様どおりの挙動)。
//
// 古い保存(`#img0` 形式)は今でも読める。番号から始まる目印は従来どおり
// 「いま開いているプロジェクトを同じ順で歩いた画像配列」への添字として解決する(後方互換)。
// 新しく書き出すものだけが新形式になる。

import {
  BODY_FONTS,
  isBodyFontId,
  DEFAULT_PRINT_RULES,
  PLATE_SIZES,
  PRINT_TARGETS,
  SCENE_BREAKS,
  THEME_BODY_FONT,
  TRIM_SIZES,
  listStart,
  migrateSceneBreak,
  migrateEbookMono,
  normalizePrintRules,
  isPresetId,
  isLoadableImageSrc,
} from '../models/project';
import type { BgSpec, BodyFontId, Manuscript, ProjectSettings, SourceFile } from '../models/project';
import { COVER_FONTS, PAPER_TYPES, sanitizeCoverModeLook } from '../models/cover';
import { EDITION } from '../edition';
import { APP_VERSION } from '../version';
import { plainText } from '../models/inlineImages';
import type { CoverBackground, CoverSettings, CoverWrap } from '../models/cover';

export const PROJECT_FORMAT = 'book-studio-project';
const VERSION = 1;

export interface ProjectSnapshot {
  settings: ProjectSettings;
  cover: CoverSettings;
  manuscript: Manuscript;
  source: SourceFile | null;
}

interface ProjectFile extends ProjectSnapshot {
  format: typeof PROJECT_FORMAT;
  version: number;
  /**
   * ファイル自身の説明。**利用者の AI に読ませるために入れる。**
   *
   * これが無いと、AI は `#img0` を見て「画像が欠けている」「壊れている」と報告してしまい、
   * 利用者は「エラーじゃないか」と受け取る。何のためにそうなっているかは
   * ファイルの中にしか書けない(渡す相手はこちらの画面を見ていない)。
   *
   * 分かれ目は「AI かどうか」ではなく **「チャット欄に貼るのか、ファイルを直接扱えるのか」**。
   * Claude Code のようにファイルを触れる相手なら、バックアップをそのまま渡してよい
   * (base64 を文脈に載せずスクリプトで書き換えられるので、むしろ完全なぶん扱いやすい)。
   * 軽いほうが要るのは、貼る・添付するしかないチャットの場合。
   */
  _このファイルについて: string[];
  savedAt: string;
  /**
   * このファイルを書いたアプリの版(2026-10-12 修正リストの 5)。不具合の報告で、どの版が書いたファイルかを見分ける。
   * 上の `format` / `version` は**ファイルの形の番号**で、アプリの版ではない。
   * 読み込みでは使わない(無い古いファイルも、あるファイルも今までどおり開く)。
   * edition は版の id(標準の版は 'public')
   */
  savedBy?: { app: string; edition: string };
  /** 画像が入っているか。false なら読み込み時に手元の絵で埋め直す */
  withImages: boolean;
  /**
   * 画像の実体。`#img:titleBg` の `titleBg` がこのオブジェクトのキーになる
   * (本文中の画像は `body.0` のように登場順の番号つき)。
   *
   * **本文や設定の中に data URI を散らさず、ファイルの末尾に隔離する。**
   * こうすると構造が先頭にまとまり、base64 を読まずに設定と原稿だけを扱える。
   * 1枚が数百KBあるので、これが途中に挟まると人も道具も読み進められない。
   *
   * `string[]`(配列)のときは**旧形式のファイル**(このアプリ側が新形式に変わる前に
   * 書き出したバックアップ)。`#img0` の 0 がその配列の添字を指す。読み込み側の
   * 両対応はこの型のゆれで判定している(`Array.isArray`)
   */
  images?: string[] | Record<string, string>;
}

const GUIDE_FOR_AI = [
  '「ひっちゃか本づくりスタジオ」で作っている本のプロジェクトファイルです。',
  'AI に読ませて手直しするための版なので、画像は入っていません。',
  '「#img:titleBg」「#img:body.0」のような値は画像の目印です。壊れているのでも、抜け落ちているのでもありません。',
  'スタジオに読み込むとき、この目印は手元の画像に自動で戻ります。',
  'そのため #img で始まる値は、消したり書き換えたりせず、そのまま残してください。',
  '目印がどこに出てくるか(plates / chapterBg / cover など)を見れば、挿絵か背景か表紙かが分かります。',
  '★titleBg / tocBg / colophonBg / chapterBg / bodyBg のように画像の置き場所を表すキーは、値を書き換えないのはもちろん、キーそのものも絶対に削除しないでください。省略すると別の意味(その面だけ無地にする、本文と同じ背景にする等)になり、設定した画像が消えます。',
  '直してよいのは settings(判型・書体・余白・色など)と manuscript(本文と章立て)です。',
  '★settings.printRules(印刷所の決まり。塗り足しとノドの下限)は、頼まれない限り変えないでください。数字を変えると、用紙の大きさとページ数が変わり、入稿先の決まりと合わなくなります。',
  '★章ごとの設定は「何番目の章か」で紐づいています。chapterBg / chapterTextColor / chapterHeadingColor のキーと、plates の beforeChapter がそれです。',
  '★そのため章の順番を入れ替えたり、増減させたりしたときは、これらの番号も必ず一緒に振り直してください。忘れると背景や色が別の章に付きます。',
  '★文字を勝手に正規化しないでください。とくに全角スペース(U+3000)を半角に変えないでください。日本語の組版では字間そのものなので、変えると紙面が崩れます。全角のダッシュ・括弧・英数字も同じです。',
  '★ルビ(振り仮名)を足すときは、読みが漢字の並びだけに対応しないなら、｜ で親文字の範囲を指定してください。'
    + '《》の直前の漢字の並びだけが親文字になる決まりなので、「万が一《まんがいち》」と書くと'
    + '親文字が「一」の1字だけになり、読みが隣の字にはみ出して紙面が崩れます。'
    + '「｜万が一《まんがいち》」が正しい書き方です。送り仮名は親文字に入れません(「｜見返《みかえ》し」)。',
  '★頼まれていない箇所は1文字も変えないでください。',
  'format と version は変えないでください。',
  '直したら同じ形式の JSON で返してください。スタジオの［読み込む］から戻せます。',
];

const GUIDE_FOR_BACKUP = [
  '「ひっちゃか本づくりスタジオ」で作っている本のバックアップです。画像も含めた完全な控えです。',
  'スタジオの［読み込む］から、そのまま元に戻せます。',
  '「#img:titleBg」「#img:body.0」のような値は画像の目印で、実体はファイル末尾の images に、目印と同じ名前をキーにして入っています。',
  'ファイルを直接扱える AI（Claude Code など）なら、この版をそのまま渡して構いません。',
  'その場合、末尾の images は読み込まずにプログラムで扱ってください（1枚が数百KBあり、そのまま読むとコンテキストを消費し尽くします）。',
  'images より前だけを読めば、設定と原稿はすべて把握できます。',
  '画像の目印(キーもプレースホルダの値も)は、消したり書き換えたりせず、そのまま残してください。',
  'チャット欄に貼る・添付する使い方なら、スタジオの［AI用に書き出す］で作った軽いほうを使ってください。',
  '直してよいのは settings(判型・書体・余白・色など)と manuscript(本文と章立て)です。',
  '★settings.printRules(印刷所の決まり。塗り足しとノドの下限)は、頼まれない限り変えないでください。数字を変えると、用紙の大きさとページ数が変わり、入稿先の決まりと合わなくなります。',
  'format と version は変えないでください。',
];

/** 旧形式。`#img0` の 0 が `collectImages` の返す配列への添字 */
const OLD_PLACEHOLDER = /^#img(\d+)$/;
/** 新形式。`place` の中身は下の mapImages が渡す置き場所の名前(例: titleBg, plate.<id>, body.3) */
const NEW_PLACEHOLDER = /^#img:(.+)$/;

/**
 * 表(書体・用紙・挿絵の大きさなど)の自分のキーか。(2026-10-13 修正リスト 26)
 * `v in TABLE` は toString・constructor など Object の元の名前にも true になり、.json の `"toString"` が検査をすり抜けて
 * 表紙の書名が消えた(運用の見直し 12 の B3)。表を引く検査はこれで見る
 */
function ownKey(table: object, v: unknown): boolean {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(table, v);
}

/**
 * 読み込んだ .json の画像の欄に入っていてよい値か(sanitize の段階)。(2026-10-13 修正リスト 25・33)
 * 画像の目印(#img0・#img:titleBg)はこのあと実体に置き換えるので通す。実体は置き換えるときに isLoadableImageSrc で見る
 */
function isImageSrcOrPlaceholder(v: unknown): v is string {
  return isLoadableImageSrc(v) || (typeof v === 'string' && (OLD_PLACEHOLDER.test(v) || NEW_PLACEHOLDER.test(v)));
}

/**
 * プロジェクト内の画像 src をまとめて変換する。
 *
 * **画像の置き場所をこの関数1か所に集めている。** 散らすと、面や設定が増えたときに
 * 片方だけ直して取りこぼす。新しく画像を持つ設定を足したら、ここにも足すこと。
 *
 * `fn` の第2引数 `place` は**その画像がどこに置かれているかを表す名前**。
 * `toProjectFile` はこれをそのままプレースホルダの目印にし、`fromProjectFile` は
 * これで「いま開いているプロジェクトの同じ置き場所」を引く。名前を付け忘れると
 * その画像だけ登場順の通し番号方式に逆戻りしてしまうので、置き場所を足したら
 * 必ず一意な名前を渡すこと(他の置き場所と衝突しないプレフィックスを付ける)。
 */
function mapImages(p: ProjectSnapshot, fn: (src: string, place: string) => string): ProjectSnapshot {
  const s = { ...p.settings };
  const cover = { ...p.cover };

  if (s.bodyBg) s.bodyBg = fn(s.bodyBg, 'bodyBg');
  for (const k of ['titleBg', 'tocBg', 'colophonBg'] as const) {
    const spec = s[k];
    if (spec?.src) s[k] = { ...spec, src: fn(spec.src, k) };
  }
  if (s.chapterBg) {
    const next: typeof s.chapterBg = {};
    for (const [i, spec] of Object.entries(s.chapterBg)) {
      next[Number(i)] = spec?.src ? { ...spec, src: fn(spec.src, `chapterBg.${i}`) } : spec;
    }
    s.chapterBg = next;
  }
  // 白ページの挿絵は src が空。プレースホルダに置き換えると空文字が画像として登録されてしまう。
  // 名前は挿絵ページ自身の id を使う(挿絵は並べ替えできるので、登場順ではなく id で名指す)
  if (s.plates?.length) {
    s.plates = s.plates.map((pl) => (pl.src ? { ...pl, src: fn(pl.src, `plate.${pl.id}`) } : pl));
  }

  for (const k of ['background', 'backCover'] as const) {
    const bg = cover[k];
    if (bg.kind === 'image') cover[k] = { ...bg, src: fn(bg.src, `cover.${k}`) };
  }

  // 本文中の画像だけは、置き場所の「名前」を持たない(章の何番目のブロックか、では
  // 章の並べ替え・ブロックの追加で簡単にずれる)。代わりに**本文全体を通した登場順**を名前にする。
  // AI が画像ブロックを別の場所(別の段落の間)へ動かしても、目印はそのブロックの中に
  // ついて回るので絵は失われない。動くのは「何番目の画像か」ではなく「そのブロックがどこにあるか」
  let bodyIndex = 0;
  const manuscript: Manuscript = {
    ...p.manuscript,
    chapters: p.manuscript.chapters.map((ch) => ({
      ...ch,
      // 絵をまだ選んでいない枠(src 空)は素通し。［挿絵］で章の途中に枠だけ置いた状態が
      // あるため(2026-09-23)。挿絵ページの白と同じで、空文字を画像として登録すると
      // 読み込み時に「戻せなかった画像」として数えてしまう。番号も振らない
      blocks: ch.blocks.map((b) =>
        b.type === 'image' && b.src ? { ...b, src: fn(b.src, `body.${bodyIndex++}`) } : b,
      ),
    })),
  };

  // まるごと1枚(とその控え)。入れ忘れていて、自前画像の1枚絵が AI 用 JSON に
  // 巨大な data URI のまま残っていた(2026-09-04 発見)。
  // **旧形式(#img0)の互換のため、いまも必ずいちばん最後に回すこと。** `collectImages` は
  // fn を呼んだ順を配列の添字にするので、途中へ足すと過去に書き出した #img0 形式のファイルの
  // 番号と食い違って絵が入れ替わる。新形式は名前で引くので順番に意味はないが、
  // 旧形式の対応を壊さないために据え置く
  for (const k of ['wrap', 'wrapSaved'] as const) {
    const w = cover[k];
    // src 空は素通し(plates と同じ)。プレースホルダ化に失敗した '' を登録すると、
    // 空文字が画像として1枚登録されてしまう(上の注意と同じ罠)
    if (w?.kind === 'image' && w.src) cover[k] = { ...w, src: fn(w.src, `cover.${k}`) };
  }
  // コラムページの地。**入れ忘れていて、AI 用 JSON に写真の中身がそのまま入っていた**
  // (2026-09-25 見直し S2-6: 画面は「画像は入っていません」と言うのに、利用者の写真がチャット AI へ渡り、
  // ファイルも約1MB 重くなっていた)。旧形式の番号を崩さないよう、まるごと1枚よりさらに後ろに置く。
  // 名前はコラムページ自身の id(並べ替えできるので登場順にしない。挿絵ページと同じ)
  if (s.columnPages?.length) {
    s.columnPages = s.columnPages.map((c) =>
      c.bg?.src ? { ...c, bg: { ...c.bg, src: fn(c.bg.src, `colpage.${c.id}`) } } : c,
    );
  }

  return { settings: s, cover, manuscript, source: p.source };
}

/**
 * 【旧形式の読み込み専用】出てくる順に番号を振りながら画像を集める。
 * `place`(第2引数)は使わない — 旧形式の目印は登場順の添字でしか引けないため
 */
function collectImages(p: ProjectSnapshot): string[] {
  const list: string[] = [];
  const seen = new Map<string, number>();
  mapImages(p, (src) => {
    if (!OLD_PLACEHOLDER.test(src) && !NEW_PLACEHOLDER.test(src) && !seen.has(src)) {
      seen.set(src, list.length);
      list.push(src);
    }
    return src;
  });
  return list;
}

/** 【新形式の読み込み専用】置き場所の名前ごとに画像を集める */
function collectImagesByPlace(p: ProjectSnapshot): Map<string, string> {
  const byPlace = new Map<string, string>();
  mapImages(p, (src, place) => {
    if (!OLD_PLACEHOLDER.test(src) && !NEW_PLACEHOLDER.test(src)) byPlace.set(place, src);
    return src;
  });
  return byPlace;
}

/**
 * 書き出す。
 * @param withImages true=バックアップ(画像込み) / false=AI に渡す(画像なし)
 */
export function toProjectFile(p: ProjectSnapshot, withImages: boolean): string {
  // どちらの版も、画像は本文から抜いて置き場所の名前に置き換える(新形式)。
  // 違うのは**実体を末尾に付けるかどうか**だけ
  const images: Record<string, string> = {};
  const seen = new Map<string, string>();
  let body = mapImages(p, (src, place) => {
    if (!seen.has(src)) {
      // 同じ画像が複数の場所で使われているときは、最初に出会った場所の名前を
      // プレースホルダとして使い回す(旧実装が最初の番号を使い回していたのと同じ考え方)
      seen.set(src, `#img:${place}`);
      images[place] = src;
    }
    return seen.get(src)!;
  });
  // 元の原稿ファイル(docx の Base64)は AI に渡す版では落とす。読むものではなく、ただ重い
  if (!withImages) body = { ...body, source: null };

  // **並び順は意味を持つ。** 説明が先頭、画像の実体が末尾。
  // こうすると、先頭から images の手前までを読むだけで設定と原稿を把握できる
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    version: VERSION,
    _このファイルについて: withImages ? GUIDE_FOR_BACKUP : GUIDE_FOR_AI,
    savedAt: new Date().toISOString(),
    savedBy: { app: APP_VERSION, edition: EDITION.id },
    withImages,
    ...body,
    ...(withImages ? { images } : {}),
  };
  // 整形しても大きさは変わらない(中身のほとんどが1本の長い文字列なので)。
  // 1行のままだと人も道具も読み進められないので、必ず整形する
  return JSON.stringify(file, null, 2);
}

/**
 * **形が壊れているかもしれない本から、控え(画像込みの .json)を作る。**(2026-10-13 修正リスト 25)
 * エラーの画面の逃げ道で、自動保存を空にする前に使う。ふつうは toProjectFile と同じものを返す。
 * 本の形が崩れていて toProjectFile が落ちたら(章が配列でない など)、中身を手を加えずにそのまま書く —
 * 画像は data URI のまま本文の中に残るが、［読み込む］はそのまま読める(読むときに sanitize が形を直す)。
 * それも書けなければ例外を投げる(呼ぶ側は、控えが取れないあいだは何も消さない)
 */
export function rescueProjectFile(raw: unknown): string {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProjectSnapshot>;
  try {
    return toProjectFile(
      { settings: r.settings!, cover: r.cover!, manuscript: r.manuscript!, source: r.source ?? null },
      true,
    );
  } catch {
    return JSON.stringify(
      {
        format: PROJECT_FORMAT,
        version: VERSION,
        _このファイルについて: GUIDE_FOR_BACKUP,
        savedAt: new Date().toISOString(),
        savedBy: { app: APP_VERSION, edition: EDITION.id },
        withImages: true,
        settings: r.settings,
        cover: r.cover,
        // 原稿が無い本の控えも［読み込む］で開けるように、空の原稿を入れておく(無いと「中身が足りません」で開けない)
        manuscript: r.manuscript ?? { title: '', chapters: [] },
        source: r.source ?? null,
      },
      null,
      2,
    );
  }
}

/**
 * 利用者が書いた文字をまとめて変換する。書誌・章題・本文・表紙の文言が対象。
 * 画像の src は含めない(そちらは mapImages が見る)。
 */
function mapTexts(p: ProjectSnapshot, fn: (s: string) => string): ProjectSnapshot {
  const m = p.manuscript;
  const t = (s: string | undefined) => (s ? fn(s) : s);
  return {
    // **原稿ではないが文字を持つものも通すこと。** コラムページは設定側にあるが
    // 中身は本文と同じ日本語なので、通さないと AI に渡した時点で丸ごと抜け落ちる
    settings: {
      ...p.settings,
      columnPages: (p.settings.columnPages ?? []).map((c) => ({
        ...c,
        title: fn(c.title),
        text: fn(c.text),
      })),
    },
    cover: {
      ...p.cover,
      titleOverride: fn(p.cover.titleOverride),
      spineTitle: fn(p.cover.spineTitle),
      blurb: fn(p.cover.blurb),
    },
    source: p.source,
    manuscript: {
      ...m,
      title: fn(m.title),
      author: fn(m.author),
      publisher: fn(m.publisher),
      authorProfile: t(m.authorProfile),
      published: t(m.published),
      printer: t(m.printer),
      colophonExtra: t(m.colophonExtra),
      chapters: m.chapters.map((ch) => ({
        ...ch,
        no: t(ch.no),
        title: fn(ch.title),
        blocks: ch.blocks.map((b) => {
          // **文字を持つブロックは全部通すこと。** 通し忘れると、その種類だけ
          // AI が半角に変えた全角スペースが戻らない(2026-08-19 に quote / list を足した)
          if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') {
            return { ...b, text: fn(b.text) };
          }
          if (b.type === 'list') return { ...b, items: b.items.map(fn) };
          if (b.type === 'image') return { ...b, alt: t(b.alt), caption: t(b.caption) };
          return b;
        }),
      })),
    },
  };
}

/**
 * AI が半角に変えてしまった全角スペースを、元の文字に戻す。
 *
 * **これはプロンプトでは防げない。** Gemini に「全角スペースを半角に直さないでください」と
 * 明示して頼んでも、3回とも34個すべてが半角化された(2026-08-17 実測)。
 * 日本語組版では字間そのものなので、放っておくと紙面が変わる。
 *
 * 直すのは**中身が変わっていない文字列だけ**。スペースの幅を無視して見比べ、
 * それで一致するなら「AI はここを触っていない」と分かるので、元の文字列をそのまま採る。
 * AI が実際に書き換えた文章は一致しないので、手を出さない。
 */
function repairSpacing(loaded: ProjectSnapshot, current: ProjectSnapshot): {
  project: ProjectSnapshot;
  repaired: number;
} {
  const flat = (s: string) => s.replace(/　/g, ' ');
  const byFlat = new Map<string, string>();
  mapTexts(current, (s) => {
    if (s.includes('　')) byFlat.set(flat(s), s);
    return s;
  });
  if (!byFlat.size) return { project: loaded, repaired: 0 };

  let repaired = 0;
  const project = mapTexts(loaded, (s) => {
    if (s.includes('　')) return s; // すでに全角のまま
    const original = byFlat.get(s);
    if (original === undefined) return s; // 中身が変わっている。触らない
    repaired++;
    return original;
  });
  return { project, repaired };
}

/**
 * AI が返した値のうち、組版が受け取れないものを手元の値へ戻す。
 *
 * **AI は平気で存在しない値を書く。** 実測では、判型に "B7"、文字サイズに "9pt"、
 * 章の配列に文字列、余白を丸ごと欠落——といった返し方で**アプリが落ちた**(2026-08-17)。
 * 読み込みは利用者の操作なので、落ちると何が起きたのか分からないまま作業が飛ぶ。
 *
 * 直せない値は**既定に倒さず、いま開いているプロジェクトの値を使う**。
 * 利用者が育ててきた設定のほうが、既定よりも正解に近い。
 */
/** この版に無い紙の出し先を「その他の印刷所」へ切り替えたときの知らせ(sanitize) */
// 文は Gemini(Pro)の案をそのまま使っている(2026-10-10。会社の名前や「版」の言葉は出さない)
export const PRINT_TARGET_SWITCHED_NOTICE =
  '保存された紙の出し先が現在選べないため、「その他の印刷所」に切り替えて開きました。' +
  '塗り足しやノドの数字は、［本のかたちを決める］の「印刷所の決まり」でご確認ください。';

export function sanitize(
  loaded: ProjectSnapshot,
  current: ProjectSnapshot,
  otherBook: boolean,
  /**
   * キーが丸ごと無い項目(画像の置き場所・書名の向き・綴じ方・印刷所の決まり)を「消えた」とみなし、
   * いま開いている本の値を残すか。**AI 用の JSON(画像なし)だけに当てる。**
   * ［保存する］の控え(画像込み)では、無いキーは「保存した時点で未設定だった」という意味なので当てない
   * (2026-10-09 全体確認: 控えを開き直しても、控えのあとで入れた背景・中綴じ・横書きの書名が残り、
   * 「AI が正しくない値を書いた可能性」と出ていた)
   */
  keepMissing = !otherBook,
): { project: ProjectSnapshot; fixed: string[]; removed: string[]; notices: string[] } {
  const fixed: string[] = [];
  /**
   * **読めない値ではないが、知らせておくこと。**(2026-10-10)
   * 「読めない値を戻した」「外した」とは別に言う(AI のせいにしない・壊れたように言わない)
   */
  const notices: string[] = [];
  /**
   * **読めずに外したもの。**「いまの設定を残した」ではないので、fixed とは別に言う
   * (2026-09-25 見直し S1-5: コラム・挿絵のページが「読み込みました」だけで黙って消えていた)
   */
  const removed: string[] = [];
  const s = { ...loaded.settings };
  const cur = current.settings;

  const keep = (label: string, key: keyof ProjectSettings) => {
    (s as Record<string, unknown>)[key] = cur[key];
    fixed.push(label);
  };
  // **項目が無いだけなら触らない。** 設定が増える前に書き出した古いファイルには
  // 新しい項目が入っていない。読み込み側が既定値とマージするので、それで足りる。
  // ここで拾うと、正しいファイルにまで警告が出る(実測で誤検知した)
  const missing = (key: keyof ProjectSettings) => s[key] === undefined;

  /**
   * 画像の置き場所を持つ設定のキーが**丸ごと落ちている**ときだけ、いまの値を残す。
   *
   * 実測(2026-09-14): Gemini にルビだけ直させたところ、`settings.titleBg` の
   * キーが丸ごと消えて返ってきた。titleBg が無いのは「大扉は本文と同じ背景」という
   * 正当な状態にも読めるので、`missing()` と同じ理屈で見逃すと、利用者が設定した
   * 大扉の絵(と濃さ・フチの上書き)が黙って既定に落ちる。
   *
   * AI 用の JSON は**文章を直してもらうためのもの**で、この手の画像の置き場所を
   * 自分から書き換える理由が AI には無い。だから「無い」を「もともと無い」ではなく
   * 「消えた」とみなして、いま開いているプロジェクトの値を残す。
   *
   * ただし別の本の JSON を読んだとき(otherBook)は当てない。当ててしまうと、
   * 別の本を読み込んだはずなのに、いま開いている本の大扉の絵が紛れ込む
   * (画像の埋め直しを別の本では行わないのと同じ理屈。fromProjectFile の otherBook を参照)
   */
  if (keepMissing) {
    const keepIfMissing = (key: keyof ProjectSettings, label: string) => {
      if (missing(key) && cur[key] !== undefined) keep(label, key);
    };
    keepIfMissing('bodyBg', '本文の背景');
    keepIfMissing('titleBg', '大扉の背景');
    keepIfMissing('tocBg', '目次の背景');
    keepIfMissing('colophonBg', '奥付の背景');
    keepIfMissing('chapterBg', '章ごとの背景');
    // 書名の向き(2026-10-03): AI が本文だけを直して返した JSON に項目が無くても、横書きにした本が黙って縦へ戻らない
    keepIfMissing('titleWritingMode', '書名の向き');
    // 大扉の書体(2026-10-12 希望 5): 同じ理由。表紙とそろえた大扉が、AI の JSON を読んだだけで本文の書体へ戻らない
    keepIfMissing('titlepageTitleFont', '大扉の書名の書体');
    keepIfMissing('titlepageAuthorFont', '大扉の著者名の書体');
    // 綴じ方(2026-10-03): 同じ理由。AI が本文だけを直して返した JSON に項目が無くても、中綴じの本が黙って無線へ戻らない
    keepIfMissing('binding', '綴じ方');
    keepIfMissing('saddleCover', '中綴じの表紙の入れ方');
  }
  /*
   * **絵を置く欄は、形と src を確かめる。**(2026-10-13 修正リスト 25・33。運用の見直し 12 の B2)
   * bodyBg(生の文字列)と各面の背景の src を見ていなかった。`bodyBg: {…}`・`titleBg.src: 5` のような .json を読むと
   * 画面がエラーになり、その値が自動保存に残って、**開き直しても入口にすら戻れなかった**(9/25 の見直し S1-3 と同じ形)。
   * https の場所も、読み込むと外のサイトへ取りに行くので外す。合わない値は外して知らせる(いまの本の絵は入れない。
   * 読めなかった絵の代わりに別の絵が入るより、無いほうが気づける)。
   * 自動保存から開くとき(useProject の hydrate)もここを通るので、すでに悪い値が残っている人もこれで入れる
   */
  const fixBgSpec = (v: unknown): { spec: BgSpec | null | undefined; bad: boolean } => {
    // null は無いのと同じに扱われる(resolveBg・mapImages は ?. で読む)ので触らない
    if (v === undefined || v === null) return { spec: v, bad: false };
    if (typeof v !== 'object' || Array.isArray(v)) return { spec: undefined, bad: true };
    const o = v as BgSpec;
    if (o.src === undefined || isImageSrcOrPlaceholder(o.src)) return { spec: o, bad: false };
    // 絵を外すときは、同梱の絵の印(AI の申告・高解像度版の差し替えに使う)も一緒に外す
    const next: BgSpec = { ...o };
    delete next.src;
    delete next.fromPreset;
    delete next.presetId;
    return { spec: next, bad: true };
  };
  if (s.bodyBg !== undefined && !isImageSrcOrPlaceholder(s.bodyBg)) {
    delete s.bodyBg;
    delete s.bodyBgFromPreset;
    delete s.bodyBgPresetId;
    fixed.push('本文の背景の画像');
  }
  for (const [key, label] of [
    ['titleBg', '大扉の背景の画像'],
    ['tocBg', '目次の背景の画像'],
    ['colophonBg', '奥付の背景の画像'],
  ] as const) {
    const r = fixBgSpec(s[key]);
    if (!r.bad) continue;
    if (r.spec) s[key] = r.spec;
    else delete s[key];
    fixed.push(label);
  }
  if (s.chapterBg !== undefined && s.chapterBg !== null) {
    const src = s.chapterBg as unknown;
    if (typeof src !== 'object' || Array.isArray(src)) {
      delete s.chapterBg;
      fixed.push('章ごとの背景の画像');
    } else {
      let bad = false;
      const next: Record<number, BgSpec> = {};
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        const r = fixBgSpec(v);
        if (r.bad) bad = true;
        if (r.spec) next[Number(k)] = r.spec;
        else if (r.spec === null) (next as Record<number, unknown>)[Number(k)] = null;
      }
      if (bad) {
        s.chapterBg = next;
        fixed.push('章ごとの背景の画像');
      }
    }
  }
  const num = (key: keyof ProjectSettings, label: string, lo: number, hi: number) => {
    if (missing(key)) return;
    const v = s[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) keep(label, key);
  };
  const oneOf = (key: keyof ProjectSettings, label: string, allowed: readonly string[]) => {
    if (missing(key)) return;
    if (!allowed.includes(String(s[key]))) keep(label, key);
  };

  oneOf('trim', '判型', Object.keys(TRIM_SIZES));
  oneOf('writingMode', '組み方向', ['vertical', 'horizontal']);
  oneOf('titleWritingMode', '書名の向き', ['vertical', 'horizontal']);
  oneOf('binding', '綴じ方', ['perfect', 'saddle']);
  oneOf('saddleCover', '中綴じの表紙の入れ方', ['separate', 'self']);
  oneOf('ink', '刷り色', ['mono', 'color']);
  // **テーマは必ず検査する。**(2026-09-04 レビュー指摘)
  // AI が存在しない値(例 "modern")を書くと、THEME_BODY_FONT[不正値] が undefined になり、
  // 後日［すべてリセット］で bodyFont が undefined → 描画中に TypeError で画面が真っ白になりうる
  oneOf('theme', 'テーマ', Object.keys(THEME_BODY_FONT));
  oneOf('bodyFont', '本文の書体', Object.keys(BODY_FONTS));
  oneOf('epubTarget', 'EPUB の出し先', ['kdp', 'reader']);
  /*
   * **この版に無い紙の出し先(別の版で選んだ会社)は、「その他の印刷所」へ切り替えて知らせる。**(2026-10-10)
   * 版によって選べる出し先が違う(src/edition の printTargets)。別の版で選んだ会社の id は、この版では読めない値と
   * 同じに見えるが、下の oneOf で「いまの設定」に戻すと、新しく開いた本(控え・自動保存・別の本)では KDP に戻り、
   * 塗り足しもノドも黙って KDP の決まりに変わる。会社の出し先は印刷所なので、印刷所の一般の扱い(printshop)に倒し、
   * 決まりの数字を持っていなければ既定の決まり(DEFAULT_PRINT_RULES。四辺 3mm・ノド 15mm、200ページをこえたら 20mm)を入れる。
   * AI 用の JSON を同じ本へ読み戻すとき(keepMissing)は、いままでどおり下の oneOf で、いま開いている本の出し先を残す
   */
  const loadedTarget = s.printTarget as unknown;
  if (
    !keepMissing &&
    typeof loadedTarget === 'string' &&
    /^[a-z][a-z0-9_-]{0,31}$/.test(loadedTarget) &&
    !Object.keys(PRINT_TARGETS).includes(loadedTarget)
  ) {
    s.printTarget = 'printshop';
    if (s.printRules === undefined) s.printRules = { ...DEFAULT_PRINT_RULES };
    notices.push(PRINT_TARGET_SWITCHED_NOTICE);
  }
  // テーマと同じ理由で必ず検査する。AI が "amazon" のような値を書くと、
  // ［本のかたちを決める］の PRINT_TARGETS[不正値].hint が TypeError になり画面が真っ白になる
  oneOf('printTarget', '紙の出し先', Object.keys(PRINT_TARGETS));
  oneOf('sceneBreak', '場面転換の見た目', Object.keys(SCENE_BREAKS));
  /*
   * **印刷所の決まり(塗り足し・ノドの下限)は、項目ごとに型を見て、保存する値を丸めておく。**(2026-10-01)
   * AI が文字列や巨大な数を書くと、用紙の寸法が NaN や 1000mm になり、組版も書き出しも壊れる。
   * - **型が違う項目**(数でない・NaN・Infinity・真偽でない・項目が無い)だけ既定(DEFAULT_PRINT_RULES)に戻して知らせる。
   *   ほかの項目は利用者の値のまま残す。オブジェクトでなければ(文字列・配列・数・null)、
   *   キーが無いときと同じく、別の本でなければいま開いている本の決まりを残す(下の分岐)。残すものが無ければ捨てる
   * - **範囲外の数や、ページ数で下がる並びは、読む時点で丸める**(normalizePrintRules。使うときの
   *   printRulesOf と同じ関数)。これまでは読むときに既定へ戻し、使うときに範囲へ収めていたので、
   *   `{bleedMm:-1, gutterMinMm:1e9}` で保存値(3/15)と組版の値(0/50)が食い違った。
   *   値を黙って丸めるのは、欄が同じ丸めを通した値を出す前提(画面と組版が一致する)
   * - **キーごと落ちているのは「消えた」とみなす**(titleBg などの keepIfMissing と同じ理由。
   *   AI は文章を直す道具で、印刷所の数字を自分から消す理由が無い)。いま開いている本の値を残して知らせる。
   *   消えたままだと用紙とノドが黙って KDP の決まりに戻り、利用者が入れた数字が失われる。
   *   別の本を読むとき(otherBook)は残さない(いま開いている本の数字が別の本に紛れ込む)。
   *   いま開いている本にも無いなら、もともと無い(決まりをまだ入れていない本)ので触らない
   */
  if (s.printRules === undefined) {
    if (keepMissing && cur.printRules !== undefined) keep('印刷所の決まり', 'printRules');
  } else {
    const src = s.printRules as unknown;
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      // 型が違う(文字列・数・配列・null)。**キーが無いときと同じ扱い**: 別の本でなければ、いま開いている本の決まりを残す
      // (2026-10-01 読み直しで発見: 捨てると、用紙とノドが黙って KDP の決まりに戻り、入れた数字が消えた)。
      // いま開いている本にも決まりが無ければ、残すものが無いので捨てて知らせる
      if (!otherBook && cur.printRules !== undefined) {
        keep('印刷所の決まり', 'printRules');
      } else {
        delete s.printRules;
        fixed.push('印刷所の決まり');
      }
    } else {
      const r = src as Record<string, unknown>;
      const d = DEFAULT_PRINT_RULES;
      const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
      // 型の検査は、読めない項目を既定に差し替えて知らせるところまで。丸めは normalizePrintRules に任せる
      const typed: Record<string, unknown> = { ...r };
      const fixType = (key: 'bleedMm' | 'gutterMinMm', label: string) => {
        if (!isNum(r[key])) {
          typed[key] = d[key];
          fixed.push(label);
        }
      };
      fixType('bleedMm', '印刷所の決まり(塗り足しの幅)');
      fixType('gutterMinMm', '印刷所の決まり(ノドの下限)');
      if (typeof r.bleedGutter !== 'boolean') {
        typed.bleedGutter = d.bleedGutter;
        fixed.push('印刷所の決まり(ノド側の塗り足し)');
      }
      // 「◯ページをこえたら◯mm」は組で意味を持つ。null(決まりが無い)は正しい値。
      // 片方だけ null は、両方 null(決まりが無い)に直して知らせる。読めない値は既定に戻す
      const pagesNull = r.thickPages === null;
      const mmNull = r.thickGutterMm === null;
      if (pagesNull || mmNull) {
        if (pagesNull !== mmNull) fixed.push('印刷所の決まり(「◯ページをこえたら」)');
      } else {
        if (!isNum(r.thickPages)) {
          typed.thickPages = d.thickPages;
          fixed.push('印刷所の決まり(「◯ページをこえたら」)');
        }
        if (!isNum(r.thickGutterMm)) {
          typed.thickGutterMm = d.thickGutterMm;
          fixed.push('印刷所の決まり(「そのときのノドの下限」)');
        }
      }
      s.printRules = normalizePrintRules(typed);
    }
  }
  /*
   * **書体の欄は全部、表にある名前か確かめる。**(2026-09-25 見直し S1-3)
   * 本文の書体(bodyFont)しか見ていなかった。AI に「明朝に」と頼むと "mincho" のような表に無い名前を
   * 書くことがあり、組版の BODY_FONTS[不正値].stack で画面が落ちたうえ、その値が自動保存されて
   * 開き直しても毎回落ちた。無い名前の欄は外す(既定の書体に戻る)
   */
  // `v in BODY_FONTS` は toString・constructor などにも true になり、すり抜けていた(2026-10-13 修正リスト 26)。
  // 表の自分のキーかで見る isBodyFontId に寄せる
  const isBodyFont = (v: unknown): v is BodyFontId => isBodyFontId(v);
  const dropFont = (key: 'nombreFont' | 'runningHeadFont', label: string) => {
    if (s[key] !== undefined && !isBodyFont(s[key])) {
      delete s[key];
      fixed.push(label);
    }
  };
  dropFont('nombreFont', 'ノンブルの書体');
  dropFont('runningHeadFont', '柱の書体');
  // 大扉の書名・著者名の書体(2026-10-12 今後の改修の希望 5)。表にある書体か 'cover'(表紙とつながる)だけ。
  // それ以外は外す(未指定 = 本文の書体に戻る)。項目の無い古いファイルは触らない
  const dropTitlepageFont = (key: 'titlepageTitleFont' | 'titlepageAuthorFont', label: string) => {
    const v = s[key];
    if (v !== undefined && v !== 'cover' && !isBodyFontId(v)) {
      delete s[key];
      fixed.push(label);
    }
  };
  dropTitlepageFont('titlepageTitleFont', '大扉の書名の書体');
  dropTitlepageFont('titlepageAuthorFont', '大扉の著者名の書体');
  if (s.chapterFont !== undefined) {
    const src = s.chapterFont as unknown;
    const next: Record<number, BodyFontId> = {};
    let bad = !src || typeof src !== 'object';
    if (!bad) {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (isBodyFont(v)) next[Number(k)] = v;
        else bad = true;
      }
    }
    if (bad) {
      s.chapterFont = next;
      fixed.push('章ごとの書体');
    }
  }
  for (const [key, label] of [
    ['colophonType', '奥付の書体'],
    ['profileType', '著者紹介の書体'],
  ] as const) {
    const m = s[key] as unknown;
    if (m === undefined) continue;
    if (!m || typeof m !== 'object') {
      delete s[key];
      fixed.push(label);
      continue;
    }
    const next = { ...(m as Record<string, unknown>) };
    let bad = false;
    for (const f of ['bodyFont', 'headingFont']) {
      if (next[f] !== undefined && !isBodyFont(next[f])) {
        delete next[f];
        bad = true;
      }
    }
    if (bad) {
      s[key] = next;
      fixed.push(label);
    }
  }
  // **項目が無いファイルは、この設定より前に書き出されたもの。** そのころの見た目(罫)に倒す。
  // 読み込み側は既定値とマージするだけなので、ここで書かないと新しい既定(1行アキ)が入り、
  // **開いた瞬間に組み直される**(罫は2行・1行アキは1行を占めるので、総ページ数まで動きうる)。
  // hydrate 側の同じ手当ては models/project.ts の migrateSceneBreak が持つ
  if (s.sceneBreak === undefined) s.sceneBreak = migrateSceneBreak({});
  num('fontPt', '本文サイズ', 4, 30);
  num('lineFeedPt', '行送り', 5, 60);
  num('columns', '段数', 1, 4);
  num('columnGapLines', '段間', 0, 8);
  num('bgOpacity', '背景の濃さ', 0, 1);
  num('textOutline', '文字のフチ', 0, 1);
  num('textPlate', '本文の帯', 0, 1);
  if (!missing('toc') && typeof s.toc !== 'boolean') keep('目次の有無', 'toc');
  // 作るもの(2026-09-23)。true/false 以外は読まない — 画面の出し分けにしか使わないが、
  // "no" のような文字を真に受けると、作るはずのものの欄が消える
  if (!missing('makePaper') && typeof s.makePaper !== 'boolean') keep('紙の本を作るか', 'makePaper');
  if (!missing('makeEbook') && typeof s.makeEbook !== 'boolean') keep('電子書籍を作るか', 'makeEbook');
  // 電子書籍の色(2026-09-24 に epubMono から名前を変えた)。古いファイルは前に効いていた値へ移す
  // (hydrate 側の同じ手当ては models/project.ts の migrateBgSettings → migrateEbookMono)
  {
    const moved = migrateEbookMono(s as unknown as Record<string, unknown>);
    if (moved !== undefined) s.ebookMono = moved;
  }
  if (!missing('ebookMono') && typeof s.ebookMono !== 'boolean') {
    keep('電子書籍の色', 'ebookMono');
  }

  const m = s.margins as unknown as Record<string, unknown> | undefined;
  if (!m || (['top', 'bottom', 'fore', 'gutter'] as const).some((k) => typeof m[k] !== 'number')) {
    keep('余白', 'margins');
  }

  // 挿絵。大きさが未知なら全面に、位置が範囲外なら巻末に寄せる
  if (!Array.isArray(s.plates)) {
    keep('挿絵ページ', 'plates');
  } else {
    const chapters = Array.isArray(loaded.manuscript?.chapters) ? loaded.manuscript.chapters.length : 0;
    let touched = false;
    const all = s.plates;
    s.plates = all
      // src は文字列で、data URI か目印か同梱の場所だけ(https の場所は外す。2026-10-13 修正リスト 25・33)
      .filter((p) => p && typeof p === 'object' && isImageSrcOrPlaceholder(p.src))
      .map((p) => {
        // id は一覧の行・並べ替え・消去の目印。無いと画面が落ちるので、無ければ振る
        if (typeof p.id !== 'string' || !p.id) {
          p = { ...p, id: crypto.randomUUID() };
          touched = true;
        }
        const size = ownKey(PLATE_SIZES, p.size) ? p.size : 'full';
        const before =
          typeof p.beforeChapter === 'number' && p.beforeChapter >= 0 && p.beforeChapter <= chapters
            ? p.beforeChapter
            : chapters;
        if (size !== p.size || before !== p.beforeChapter) touched = true;
        return { ...p, size, beforeChapter: before };
      });
    if (touched) fixed.push('挿絵ページの位置か大きさ');
    const lost = all.length - s.plates.length;
    if (lost) removed.push(`挿絵ページ ${lost}枚（画像の場所が読めない）`);
  }

  // コラムページ。挿絵と同じく、位置が範囲外なら巻末に寄せる。
  // 組み方向は知らない値なら落として「本文の逆」に戻す(既定に倒しても害がない項目)
  if (s.columnPages !== undefined && !Array.isArray(s.columnPages)) {
    keep('コラムページ', 'columnPages');
  } else if (Array.isArray(s.columnPages)) {
    const chapters = Array.isArray(loaded.manuscript?.chapters) ? loaded.manuscript.chapters.length : 0;
    let touched = false;
    let badColumnBg = false;
    const all = s.columnPages;
    /**
     * **見出しと本文は、字にできるものは字にして残す。**(2026-09-25 見直し S1-5)
     * AI は数字だけの見出しを数値で返したり、本文を行ごとの配列で返したりする。
     * 前は型が違う1項目だけで、そのページごと黙って捨てていた
     */
    const asText = (v: unknown): string | null =>
      typeof v === 'string'
        ? v
        : typeof v === 'number'
          ? String(v)
          : v == null
            ? ''
            : Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')
              ? v.join('\n')
              : null;
    s.columnPages = all
      .filter((c) => c && typeof c === 'object' && asText(c.title) !== null && asText(c.text) !== null)
      .map((raw) => {
        let c = raw;
        const title = asText(c.title) as string;
        const text = asText(c.text) as string;
        if (title !== c.title || text !== c.text) {
          c = { ...c, title, text };
          touched = true;
        }
        if (typeof c.id !== 'string' || !c.id) {
          c = { ...c, id: crypto.randomUUID() };
          touched = true;
        }
        for (const f of ['bodyFont', 'headingFont'] as const) {
          if (c[f] !== undefined && !isBodyFont(c[f])) {
            c = { ...c };
            delete c[f];
            touched = true;
          }
        }
        // ページの地の絵(2026-10-13 修正リスト 25・33)。各面の背景と同じ確かめ。ページは残し、読めない絵だけ外す
        const bg = fixBgSpec(c.bg);
        if (bg.bad) {
          c = { ...c };
          if (bg.spec) c.bg = bg.spec;
          else delete c.bg;
          badColumnBg = true;
        }
        const before =
          typeof c.beforeChapter === 'number' && c.beforeChapter >= 0 && c.beforeChapter <= chapters
            ? c.beforeChapter
            : chapters;
        const wm =
          c.writingMode === 'vertical' || c.writingMode === 'horizontal' ? c.writingMode : undefined;
        if (before !== c.beforeChapter || wm !== c.writingMode) touched = true;
        const next = { ...c, beforeChapter: before };
        if (wm) next.writingMode = wm;
        else delete next.writingMode;
        return next;
      });
    if (touched) fixed.push('コラムページの位置・組み方向・書体・見出しか本文の形');
    if (badColumnBg) fixed.push('コラムページの地の画像');
    const lost = all.length - s.columnPages.length;
    if (lost) removed.push(`コラムページ ${lost}枚（中身が読めない）`);
  }

  /**
   * **段落の字は字にする。**(2026-09-25 見直し S1-3) 本文の段落の text が数値、箇条書きの items が
   * 文字列1つ、のような形で来ると、組版の文字列処理で画面が落ちた(開き直しても落ちる)
   */
  let blockFixes = 0;
  let imageFixes = 0;
  const fixBlock = (b: unknown): Manuscript['chapters'][number]['blocks'][number] => {
    if (!b || typeof b !== 'object') {
      blockFixes++;
      return { type: 'p', text: b == null ? '' : String(b) };
    }
    const o = b as Record<string, unknown>;
    let out = o;
    if ('text' in o && typeof o.text !== 'string') {
      out = { ...out, text: o.text == null ? '' : String(o.text) };
      blockFixes++;
    }
    if (o.type === 'list' && !Array.isArray(o.items)) {
      out = { ...out, items: o.items == null ? [] : [String(o.items)] };
      blockFixes++;
    } else if (o.type === 'list' && (o.items as unknown[]).some((x) => typeof x !== 'string')) {
      out = { ...out, items: (o.items as unknown[]).map((x) => (x == null ? '' : String(x))) };
      blockFixes++;
    }
    // 番号つきの最初の番号(2026-10-02 に足した。無い保存は 1 から数える)。
    // AI は "4" のように字で書くことがあるので、数字だけの字は数に直す。それ以外の形は捨てて 1 から数える
    if (o.type === 'list' && 'start' in o && listStart(o.start) !== o.start) {
      const n = typeof o.start === 'string' && /^\d+$/.test(o.start.trim()) ? Number(o.start) : NaN;
      out = { ...out, start: listStart(n) };
      if (listStart(n) === 1) delete out.start;
      blockFixes++;
    }
    // 本文中の画像(2026-10-13 修正リスト 25・33)。読めない src(文字列でない・https の場所)は空の枠にする
    // (絵をまだ選んでいない枠と同じ。組版には出ない)。説明文・キャプションは字にする(全角スペースの戻しが字として読む)
    if (o.type === 'image') {
      if (!isImageSrcOrPlaceholder(o.src)) {
        out = { ...out, src: '' };
        delete out.fromPreset;
        delete out.presetId;
        imageFixes++;
      }
      for (const f of ['alt', 'caption'] as const) {
        if (o[f] !== undefined && typeof o[f] !== 'string') {
          out = { ...out, [f]: o[f] == null ? '' : String(o[f]) };
          blockFixes++;
        }
      }
    }
    return out as unknown as Manuscript['chapters'][number]['blocks'][number];
  };
  // 原稿。章が配列でなければ丸ごと手元のものを使う(ここが壊れると組版に入れない)
  let manuscript = loaded.manuscript;
  if (!manuscript || !Array.isArray(manuscript.chapters)) {
    manuscript = current.manuscript;
    fixed.push('原稿の章立て');
  } else {
    manuscript = {
      ...manuscript,
      chapters: manuscript.chapters.map((ch) => ({
        ...ch,
        title: typeof ch.title === 'string' ? ch.title : '',
        ...(ch.no !== undefined ? { no: typeof ch.no === 'string' ? ch.no : String(ch.no) } : {}),
        blocks: Array.isArray(ch.blocks) ? ch.blocks.map(fixBlock) : [],
      })),
    };
    if (blockFixes) fixed.push('本文の段落の形');
    if (imageFixes) fixed.push('本文中の画像');
  }

  // 表紙の地・裏の地・まるごと1枚の絵。**render.ts は settings.background.kind を無条件に読む**ので、
  // AI が null や壊れた形を書くと描画中に TypeError で画面が真っ白になる(2026-09-04 レビュー指摘)。
  // 形が合わないものは、いま開いている表紙の同じ欄へ倒す(既定ではなく現値に倒すのは設定の他項目と同じ方針)
  const isCoverBg = (v: unknown): v is CoverBackground => {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    if (o.kind === 'solid') return typeof o.color === 'string';
    if (o.kind === 'preset') return typeof o.id === 'string';
    // https の場所は通さない(2026-10-13 修正リスト 33。外のサイトへ取りに行く)
    if (o.kind === 'image') return isImageSrcOrPlaceholder(o.src);
    return false;
  };
  const isCoverWrap = (v: unknown): v is CoverWrap => {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    if (o.kind === 'preset') return typeof o.id === 'string';
    if (o.kind === 'image') return isImageSrcOrPlaceholder(o.src);
    return false;
  };
  let cover = loaded.cover;
  if (!cover || typeof cover !== 'object') {
    cover = current.cover;
    fixed.push('表紙の設定');
  } else {
    const c: CoverSettings = { ...cover };
    if (!isCoverBg(c.background)) { c.background = current.cover.background; fixed.push('表紙(表1)の地'); }
    if (!isCoverBg(c.backCover)) { c.backCover = current.cover.backCover; fixed.push('表紙(表4)の地'); }
    // wrap / wrapSaved は「無い」が正常。あるのに形が壊れているときだけ落とす
    if (c.wrap !== undefined && !isCoverWrap(c.wrap)) { delete c.wrap; fixed.push('まるごと1枚の画像'); }
    if (c.wrapSaved !== undefined && !isCoverWrap(c.wrapSaved)) delete c.wrapSaved;
    // モードの控え(飾りの束)も「無い」が正常。**切り替えた瞬間に settings へ流し込まれる**ので、
    // 壊れた欄はここで漉しておく(漉した結果が空でも、切り替えが「動かさない」になるだけで無害)
    if (c.modeStash !== undefined) {
      const st = sanitizeCoverModeLook(c.modeStash);
      if (st) c.modeStash = st;
      else delete c.modeStash;
    }
    // 作り方のモード。知らない値なら落とす(無ければ wrap の有無から推定される)
    if (c.mode !== undefined && c.mode !== 'faces' && c.mode !== 'wrap') delete c.mode;
    // **表紙の書体と用紙も表にある名前か確かめる。**(2026-09-25 見直し S1-3)
    // 「あらすじを明朝に」と頼まれた AI が "mincho" と書くと、表紙の工程と書き出しの画面が落ちた
    for (const [key, label] of [
      ['titleFont', '書名の書体'],
      ['authorFont', '著者名の書体'],
      ['blurbFont', 'あらすじの書体'],
      ['spineFont', '背文字の書体'],
    ] as const) {
      // 項目が無いだけ(背文字の書体が入る前、8/22 より前の保存など)は黙って補う。警告は出さない
      // (設定側の missing() と同じ理屈。2026-10-09 全体確認: 正しい古いファイルに「AI が正しくない値を書いた可能性」と出ていた)
      if (c[key] === undefined) {
        c[key] = current.cover[key];
        continue;
      }
      if (!ownKey(COVER_FONTS, c[key])) {
        c[key] = current.cover[key];
        fixed.push(label);
      }
    }
    if (c.paper === undefined) {
      c.paper = current.cover.paper;
    } else if (!ownKey(PAPER_TYPES, c.paper)) {
      c.paper = current.cover.paper;
      fixed.push('本文用紙');
    }
    // 印刷所から知らされた背幅(mm)。数でない・0以下・ありえない太さは捨てる(目安の背幅に戻るだけ)
    if (
      c.spineMmFromPrinter !== undefined &&
      !(typeof c.spineMmFromPrinter === 'number' && Number.isFinite(c.spineMmFromPrinter) && c.spineMmFromPrinter > 0 && c.spineMmFromPrinter < 200)
    ) {
      delete c.spineMmFromPrinter;
      fixed.push('印刷所の背幅');
    }
    if (c.spineMmPages !== undefined && !(Number.isInteger(c.spineMmPages) && (c.spineMmPages as number) > 0)) {
      delete c.spineMmPages;
    }
    // 会社の用紙(用紙の一覧を持つ会社)。文字でなければ捨てる(一覧の先頭に戻るだけ)。一覧に無い id は printerPapersOf が先頭に丸める
    for (const key of ['printerBodyPaper', 'printerCoverPaper'] as const) {
      if (c[key] !== undefined && typeof c[key] !== 'string') delete c[key];
    }
    cover = c;
  }

  // 同梱のプリセットの id(2026-10-12 改修の希望 2)。id の形でないものは黙って外す(古いファイルは無くてよい)
  // 表紙の高解像度版(kind: 'image' の presetId)も同じ
  const settingsOut = stripBadPresetIds(s) as ProjectSettings;
  manuscript = stripBadPresetIds(manuscript) as Manuscript;
  cover = stripBadPresetIds(cover) as CoverSettings;
  return { project: { ...loaded, settings: settingsOut, cover, manuscript }, fixed, removed, notices };
}

/**
 * `presetId` / `bodyBgPresetId` のうち、同梱のプリセットの id の形(isPresetId)でないものを外した写しを返す。(2026-10-12 改修の希望 2)
 * 絵を置ける場所(各面の背景・挿絵ページ・コラムの地・本文中の画像)は深さがまちまちなので、
 * 場所を並べずに全体をたどる。外すものが無い枝は同じオブジェクトのまま返す(大きな data URI の文字列は写さない)
 */
export function stripBadPresetIds(v: unknown): unknown {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = stripBadPresetIds(x);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [k, x] of Object.entries(o)) {
    if ((k === 'presetId' || k === 'bodyBgPresetId') && x !== undefined && !isPresetId(x)) {
      out ??= { ...o };
      delete out[k];
      continue;
    }
    const y = stripBadPresetIds(x);
    if (y !== x) {
      out ??= { ...o };
      out[k] = y;
    }
  }
  return out ?? o;
}

/** 本文をひとつなぎにする(取りこぼしの検査用) */
function bodyText(p: ProjectSnapshot): string {
  return p.manuscript.chapters
    .map((ch) => (ch.no ?? '') + ch.title + ch.blocks.map((b) => ('text' in b ? b.text : '')).join(''))
    .join('');
}

/**
 * AI に通した原稿の取りこぼしを見つける。
 *
 * **AI は案内を読んでも守るとは限らない。** 実際に Gemini へ章の入れ替えを頼んだところ、
 * 頼んでいない**全角スペース36個が全部半角に化けた**(2026-08-17 実測)。
 * 本人は申告しないので、こちらで気づけるようにしておく。
 *
 * 狙うのは、チャット経由でよく起きる2つだけ:
 *   1. 出力が途中で打ち切られて本文が減る
 *   2. 文字を勝手に正規化される(全角スペースが半角に変わるのが典型)
 */
function inspect(loaded: ProjectSnapshot, current: ProjectSnapshot): string[] {
  const warn: string[] = [];
  const before = bodyText(current);
  const after = bodyText(loaded);
  if (!before) return warn;

  const lost = before.length - after.length;
  if (lost > before.length * 0.02) {
    warn.push(
      `本文が ${lost.toLocaleString()} 字ぶん減っています` +
        `（${before.length.toLocaleString()} → ${after.length.toLocaleString()} 字）。` +
        'AI の出力が途中で切れていないか確かめてください',
    );
  }

  const count = (s: string, ch: string) => s.split(ch).length - 1;
  // ここまで来て全角スペースが減っているのは、repairSpacing でも戻せなかったぶん
  // (= AI がその文章自体も書き換えている)。自動で直せないので伝える
  const wideBefore = count(before, '　');
  const wideAfter = count(after, '　');
  if (wideBefore >= 3 && wideAfter < wideBefore / 2) {
    warn.push(
      `全角スペースが ${wideBefore} 個から ${wideAfter} 個に減っています。` +
        'AI が書き換えた文章の中は自動で戻せません（字間が変わるので紙面が崩れます）',
    );
  }

  // 強調(`**〜**`)は記号なので、文字数の減りとしては小さく出る。
  // 全部消えても1%程度にしかならず、上の検査をすり抜ける。
  // **Google ドキュメントを経由すると Markdown として解釈され、装飾に化けて記号が消える**
  // (Gemini の Canvas から .docx で受け取ったファイルで、140組すべてが失われた。2026-08-17 実測)
  const emBefore = count(before, '**');
  const emAfter = count(after, '**');
  if (emBefore >= 2 && emAfter < emBefore / 2) {
    warn.push(
      `強調の記号（**）が ${emBefore} 個から ${emAfter} 個に減っています。` +
        'Google ドキュメントや Word を経由すると、太字に化けて記号が消えます。' +
        'JSON はテキストのまま受け取ってください',
    );
  }
  return warn;
}

export interface LoadResult {
  project: ProjectSnapshot;
  /** 読めたが、確かめたほうがよいこと */
  warnings: string[];
}

/**
 * 読み込む。**バックアップ・AI 用のどちらでも受ける。**
 * 画像が入っていなければ、いま開いているプロジェクトの絵で埋め直す。
 *
 * @param current いま開いているプロジェクト(画像の供給元 / 取りこぼしの比較元)
 */
export function fromProjectFile(text: string, current: ProjectSnapshot): LoadResult {
  let file: Partial<ProjectFile>;
  try {
    file = JSON.parse(text) as Partial<ProjectFile>;
  } catch {
    throw new Error('ファイルの中身を読めませんでした（JSON として壊れています）');
  }
  if (file.format !== PROJECT_FORMAT) {
    throw new Error('ひっちゃか本づくりスタジオのプロジェクトファイルではありません');
  }
  if (!file.settings || !file.manuscript || !file.cover) {
    throw new Error('プロジェクトの中身が足りません（設定・原稿・表紙のどれかがありません）');
  }

  /**
   * 別の本の JSON かどうか。**画像の埋め直しにも、設定の欠けキー修復にも使う**ので、
   * sanitize より先に決めておく。
   *
   * 1. ファイルが画像を持っていれば、それが正しい(バックアップ)
   * 2. 持っていなければ手元のプロジェクトから拾う(AI 往復のための埋め直し)
   *
   * ただし 2 は**同じ本のときだけ正しい。** 数冊を並行して作っていると、
   * 別の本の JSON を読んだ瞬間に手元の絵が混ざる(2026-08-19 ユーザー指摘)。
   *
   * ### id が無いファイルでも混ざっていた(2026-08-21 実測)
   *
   * 2026-08-19 の直しは「id が両方にあって食い違うときだけ埋め直さない」だった。
   * だが **id を持つようになったのは 2026-08-19 から**で、それより前に書き出した
   * AI 用の JSON には id が無い。**古いファイルを読むと、いま開いている本の絵が
   * そのまま流し込まれる**(利用者の「新規・続けて・サンプルのどれを押しても
   * 前のデータが残る」の、［続けて作る］側の正体)。
   *
   * そこで id が無いときは**書名で見分ける。** 埋め直しが要るのは
   * 「いま開いている本を AI に渡して、直ったものを読み戻す」場面だけなので、
   * そのときは書名がまだ一致している。一致しないなら別の本として扱う
   * (絵は空になるが、警告が出るので黙って消えることはない)
   */
  const fileBook = file.settings.bookId;
  const currentBook = current.settings.bookId;
  // 書名が文字でない(壊れた控え・手で直した .json)ときも落ちないように、文字にしてから比べる(2026-10-13 見直し)
  const sameTitle =
    String(file.manuscript.title ?? '').trim() === String(current.manuscript.title ?? '').trim();
  const otherBook =
    !!fileBook && !!currentBook ? fileBook !== currentBook : !sameTitle;

  const parsed: ProjectSnapshot = {
    settings: file.settings,
    cover: file.cover,
    manuscript: file.manuscript,
    source: file.source ?? null,
  };
  // **いちばん先に形を整える。** この後の画像の埋め直しは配列を辿るので、
  // 章や挿絵が配列でないまま渡すとそこで落ちる
  // ［保存する］の控え(画像込み。旧形式の images 配列も)か。控えに無いキーは「もともと未設定」なので、
  // 無いキーをいまの本の値で補うのは AI 用の JSON のときだけ(sanitize の keepMissing)
  const backup = file.withImages === true || file.images !== undefined;
  const { project: loaded, fixed, removed, notices } = sanitize(parsed, current, otherBook, !otherBook && !backup);

  // 画像の実体をどこから取るか。旧形式(#img0)と新形式(#img:titleBg)を両対応する —
  // 利用者の手元にはすでに旧形式で書き出した AI 用 JSON がある(後方互換)。
  //
  // `file.images` が配列なら旧形式のバックアップ(番号 → 添字)。
  // オブジェクトなら新形式のバックアップ(名前 → 実体)。
  // 無ければ AI 往復の埋め直しで、いま開いているプロジェクトから拾う
  // (別の本のときは拾わない。上の otherBook のコメントを参照)
  const oldSupply: string[] = Array.isArray(file.images)
    ? file.images
    : otherBook
      ? []
      : collectImages(current);
  const newSupply: Map<string, string> = Array.isArray(file.images)
    ? new Map()
    : file.images
      ? new Map(Object.entries(file.images))
      : otherBook
        ? new Map()
        : collectImagesByPlace(current);

  // 埋められなかった目印。**黙って絵を消さない**ため数えておく。
  // AI 用のファイルを、絵を持っていないプロジェクトへ読み込むと起きる
  // (別のPCで開いた、先に原稿を差し替えた、など)。
  // 新形式では「知らない名前(古いバージョンが作った置き場所が無くなった等)」も
  // ここに数える — 黙って画像を諦めるのではなく、利用者に「N枚戻せなかった」と伝えるため
  const unresolved = new Set<string>();
  /**
   * 実体はあるが読めないもの(文字列でない・https の場所)。(2026-10-13 修正リスト 25・33)
   * ファイル末尾の images は sanitize を通らないので、ここで見る。数や {} を組版へ渡すと画面が落ち、
   * 自動保存に残って開き直しても落ちる。https の場所は外のサイトへ取りに行く
   */
  const unusable = new Set<string>();
  const supply = (found: unknown, src: string): string => {
    if (typeof found === 'string' && found !== '' && isLoadableImageSrc(found)) return found;
    if (found === undefined || found === null || found === '') unresolved.add(src);
    else unusable.add(src);
    return ''; // 壊れた src を組版へ渡さない
  };
  const withImages = mapImages(loaded, (src) => {
    const oldMatch = OLD_PLACEHOLDER.exec(src);
    if (oldMatch) return supply(oldSupply[Number(oldMatch[1])], src);
    const newMatch = NEW_PLACEHOLDER.exec(src);
    if (newMatch) return supply(newSupply.get(newMatch[1]), src);
    return src; // プレースホルダではない(通常はここに来ない)
  });
  if (unusable.size) removed.push(`画像 ${unusable.size}枚（画像のデータではないか、別のサイトの画像だった）`);

  // AI が半角に変えた全角スペースを戻してから、残りを検査する
  const { project, repaired } = repairSpacing(withImages, current);
  const warnings = inspect(project, current);
  warnings.unshift(...notices);
  if (fixed.length) {
    warnings.unshift(
      `読めない値があったので、いまの設定か既定に戻しました：${fixed.join('・')}。` +
        'AI が正しくない値を書いた可能性があります',
    );
  }
  if (removed.length) {
    warnings.unshift(
      `読めなかったので外したものがあります：${removed.join('・')}。` +
        '元のファイルか、読み込む前のバックアップから戻してください',
    );
  }
  if (unresolved.size) {
    warnings.unshift(
      otherBook
        ? `画像 ${unresolved.size} 枚は入っていません。` +
          'このファイルは、いま開いているのとは別の本で、画像なしで書き出されたものです。' +
          '画像まで戻すには、その本の［保存する］で作ったファイル（画像込み）を読み込んでください'
        : `画像 ${unresolved.size} 枚を戻せませんでした。` +
          'このファイルには画像が入っておらず、いま開いているプロジェクトにも元の画像がありません。' +
          'バックアップから読み込むか、画像を選び直してください',
    );
  }
  if (repaired) {
    warnings.unshift(
      `半角に変わっていた全角スペースを ${repaired} 箇所、元に戻しました（AI がよく置き換える文字です）`,
    );
  }
  return { project, warnings };
}

/**
 * 書名をファイル名の一部に使えるよう整える。**OS が禁じる文字を _ に倒す。**
 * 「第2話: 帰路」「雨/宿り」のような書名でも、EPUB・PDF・.json すべてで
 * 同じ規則の名前になるよう、ダウンロード名はこの関数を通すこと(2026-09-04)
 */
export function safeFileStem(title: string, fallback = '無題'): string {
  // 書名の記法(｜親《よみ》・** など)はファイル名に持ち込まない(2026-09-25 見直し S3-9)
  return (plainText(title) || fallback).replace(/[\\/:*?"<>|]/g, '_').trim() || fallback;
}

/** 書き出すファイル名。世代を残せるよう日時を付ける */
export function projectFileName(title: string, withImages: boolean, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}`;
  const name = safeFileStem(title);
  return `${name}_${stamp}${withImages ? '' : '_AI用'}.json`;
}
