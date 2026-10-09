// 章の途中に置く絵(本文の画像ブロック)を扱う道具。
//
// 2026-09-23 まで、章の途中の絵は Word 原稿に貼って取り込むしか入れる道が無かった。
// 組版は最初から「段落のあいだの絵」を組めたので(typeset/html.ts)、足りなかったのは
// **スタジオの画面で「どの段落のあとか」を選ぶ手段**だけだった。ここはその手段の中身。
//
// 位置は章の blocks 配列の並びで持つ。ページ番号は持たない(判型を変えると陳腐化するため)。

import type { Block, Chapter, ImageBlock, PlateSize } from './project';

/** 大きさの選び方。挿絵ページの4つに「本文の中」を足した5つ */
export type ImageSizeChoice = 'flow' | Exclude<PlateSize, 'spread'>;

export const IMAGE_SIZES: Record<ImageSizeChoice, { label: string; hint: string }> = {
  flow: {
    label: '本文の中',
    // 1段の縦組みは絵をページの上に寄せるので、空きは残らない(typeset/css.ts の pageFloatFig)。
    // 横組みと段組みは置いた場所で組むので、入りきらないと次のページへ送られ、前のページに空きが残る
    // (figure.fig の break-inside: avoid)。置いた段落しだいで起きるので、起きうることを先に言う
    hint: '本文と一緒に流れます。縦組み（1段）では、画像をその段落のあるページの上に寄せ、本文が下に回り込みます（そのページに入りきらない画像は、次のページの上に置きます）。横組みと段組みでは、入りきらないと次のページへ送られ、前のページに空きが出ることがあります',
  },
  full: {
    label: '全面（1ページ）',
    hint: 'そのページを紙の端まで画像にします。断裁で外周が少し切れます',
  },
  wide: {
    label: '余白すこし（1ページ）',
    hint: 'そのページに画像だけを置き、仕上がりの外周4%を空けて収めます',
  },
  narrow: {
    label: '余白おおめ（1ページ）',
    hint: 'そのページに画像だけを置き、仕上がりの外周20%を空けて収めます',
  },
  print: {
    label: '版面いっぱい（1ページ）',
    hint: 'そのページに画像だけを置き、本文と同じ余白の内側に収めます。文字の入った図表はこれにしてください（余白に文字が出ると KDP で刷れません）',
  },
};

export function imageSizeOf(b: ImageBlock): ImageSizeChoice {
  if (b.full) return 'full';
  return b.size ?? 'flow';
}

/** 大きさを付け替える。`full` と `size` のどちらか一方だけが立つようにする */
export function withImageSize(b: ImageBlock, size: ImageSizeChoice): ImageBlock {
  const next: ImageBlock = { ...b };
  delete next.full;
  delete next.size;
  if (size === 'full') next.full = true;
  else if (size !== 'flow') next.size = size;
  return next;
}

/**
 * 組み上がったページから絵を探すための目印(`data-img`)。**章の番号と、章の中の並び。**
 * 絵を動かすと変わるが、動かせば組み直すので、そのたびに読み直せば食い違わない
 */
export function imageKey(chapter: number, block: number): string {
  return `${chapter}:${block}`;
}

/**
 * 原稿の記法を外して、読むための字だけにする。
 * 段落を選ぶ一覧の見出しと、取り込み直したときの照合に使う
 */
export function plainText(text: string): string {
  return text
    .replace(/《《([^》]*)》》/g, '$1') // 傍点
    .replace(/《[^》]*》/g, '') // ルビの読み
    .replace(/[｜|]/g, '')
    .replace(/<\/?u>/g, '')
    .replace(/\*\*|~~/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // リンクは字だけ
    .replace(/^[>＞]{1,2}[ 　]?/, '');
}

/** その段落の字。**字を持たないもの(空行・場面転換・絵)は null** */
function textOf(b: Block): string | null {
  if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') return b.text;
  if (b.type === 'list') return b.items.join('');
  return null;
}

/** 照合用の鍵。空白の違いでは外さない */
function keyOf(text: string): string {
  return plainText(text).replace(/[\s　]/g, '');
}

/**
 * **取り込み直したとき、前の原稿の各章が新しい原稿のどの章に当たるか。**(-1 は無くなった章)
 *
 * 前は「同じ番号の章」とみなしていた。章を並べ替える・先頭にプロローグを足す・途中の章を消すと、
 * 挿絵ページ・コラムページ・章ごとの背景や書体が、**別の章へ付け替わった**うえ、画面は
 * 「無くなった章の指定が効かなくなりました」と違う説明をしていた(2026-09-25 見直し S1-6)。
 *
 * 当て方の順:
 * 1. 題(章番号＋章題)が、前後どちらの原稿でも1つだけで一致する
 * 2. 本文の段落がよく重なる(段落の頭24字の集合の重なりが3割以上。いちばん重なる組から決める)
 * 3. 残った章は同じ番号どうし。ただし題の無い章どうしか、章の数が変わっていないときだけ
 *    (章を消した原稿で、消えた章の指定を隣の章へ押し付けないため)
 */
export function matchChapters(oldChapters: Chapter[], newChapters: Chapter[]): number[] {
  const titleKey = (ch: Chapter) => keyOf([ch.no, ch.title].filter(Boolean).join(''));
  const oldT = oldChapters.map(titleKey);
  const newT = newChapters.map(titleKey);
  const count = (arr: string[], k: string) => arr.filter((x) => x === k).length;
  const out = oldChapters.map(() => -1);
  const taken = new Set<number>();

  oldT.forEach((k, oi) => {
    if (!k || count(oldT, k) !== 1 || count(newT, k) !== 1) return;
    const ni = newT.indexOf(k);
    out[oi] = ni;
    taken.add(ni);
  });

  const sig = (ch: Chapter) =>
    new Set(
      ch.blocks
        .map(textOf)
        .filter((t): t is string => !!t)
        .map((t) => keyOf(t).slice(0, 24))
        .filter((k) => k.length >= 6),
    );
  const oldS = oldChapters.map(sig);
  const newS = newChapters.map(sig);
  const overlap = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let n = 0;
    a.forEach((x) => {
      if (b.has(x)) n++;
    });
    return n / (a.size + b.size - n);
  };
  const pairs: [number, number, number][] = [];
  oldChapters.forEach((_, oi) => {
    if (out[oi] >= 0) return;
    newChapters.forEach((__, ni) => {
      if (taken.has(ni)) return;
      const v = overlap(oldS[oi], newS[ni]);
      if (v >= 0.3) pairs.push([v, oi, ni]);
    });
  });
  pairs.sort((a, b) => b[0] - a[0]);
  for (const [, oi, ni] of pairs) {
    if (out[oi] >= 0 || taken.has(ni)) continue;
    out[oi] = ni;
    taken.add(ni);
  }

  const sameCount = oldChapters.length === newChapters.length;
  oldChapters.forEach((_, oi) => {
    if (out[oi] >= 0 || oi >= newChapters.length || taken.has(oi)) return;
    if (sameCount || (!oldT[oi] && !newT[oi])) {
      out[oi] = oi;
      taken.add(oi);
    }
  });
  return out;
}

/**
 * 段落を選ぶ一覧に出す1行。**冒頭だけを見せる**(どの段落かが分かれば足りる)。
 * 空行は選ばせない(直前の段落のあとと同じ場所になるので、行が増えて探しにくいだけ)
 */
export function blockSnippet(b: Block, max = 32): string | null {
  const cut = (s: string) => {
    const t = plainText(s).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  if (b.type === 'p') return cut(b.text) || null;
  if (b.type === 'h3') return `小見出し「${cut(b.text)}」`;
  if (b.type === 'quote') return `引用「${cut(b.text)}」`;
  if (b.type === 'list') return `箇条書き「${cut(b.items[0] ?? '')}」`;
  if (b.type === 'hr') return '（場面の変わり目）';
  if (b.type === 'image') return '［画像］';
  return null;
}

export interface InlineImageRef {
  chapter: number;
  block: number;
  image: ImageBlock;
}

/** 本文の絵をすべて、本の順に */
export function listInlineImages(chapters: Chapter[]): InlineImageRef[] {
  const out: InlineImageRef[] = [];
  chapters.forEach((ch, ci) =>
    ch.blocks.forEach((b, bi) => {
      if (b.type === 'image') out.push({ chapter: ci, block: bi, image: b });
    }),
  );
  return out;
}

/**
 * その絵の直前にある、字を持つ段落。**場所を言い表すのに使う**
 * (「…駅に着いた。」のあと)。かぎ括弧まで付けて返す。章のはじめなら null。
 *
 * 会話の段落は自分で「」を持っているので、もう一重は付けない
 * (「「つづきはまた明日」」と二重に出た。2026-09-23 実測)。
 * 小見出し・引用は blockSnippet が「小見出し「…」」の形で返すので、そのまま使う
 */
export function anchorSnippet(ch: Chapter, block: number): string | null {
  for (let i = block - 1; i >= 0; i--) {
    const b = ch.blocks[i];
    if (textOf(b) === null) continue;
    const s = blockSnippet(b, 20);
    if (!s) continue;
    if (b.type !== 'p' || /^[「『（(]/.test(s)) return s;
    return `「${s}」`;
  }
  return null;
}

/** `after` 番のブロックのうしろに絵を入れる。-1 なら章のいちばん最初 */
export function insertImage(
  chapters: Chapter[],
  chapter: number,
  after: number,
  image: ImageBlock,
): Chapter[] {
  return chapters.map((ch, ci) => {
    if (ci !== chapter) return ch;
    const blocks = [...ch.blocks];
    blocks.splice(after + 1, 0, image);
    return { ...ch, blocks };
  });
}

export function removeImage(chapters: Chapter[], chapter: number, block: number): Chapter[] {
  return chapters.map((ch, ci) =>
    ci === chapter ? { ...ch, blocks: ch.blocks.filter((_, bi) => bi !== block) } : ch,
  );
}

export function patchImage(
  chapters: Chapter[],
  chapter: number,
  block: number,
  patch: (b: ImageBlock) => ImageBlock,
): Chapter[] {
  return chapters.map((ch, ci) =>
    ci !== chapter
      ? ch
      : {
          ...ch,
          blocks: ch.blocks.map((b, bi) => (bi === block && b.type === 'image' ? patch(b) : b)),
        },
  );
}

/**
 * 絵を別の段落のあとへ動かす。`after` は**動かす前の**並びで数えた番号
 * (選ぶ一覧は動かす前の原稿を見せているので)。
 * 動いた先の番号を返す(動いた絵へ飛ぶ・光らせるのに使う)
 */
export function moveImage(
  chapters: Chapter[],
  from: { chapter: number; block: number },
  to: { chapter: number; after: number },
): { chapters: Chapter[]; at: { chapter: number; block: number } } {
  const img = chapters[from.chapter]?.blocks[from.block];
  if (!img || img.type !== 'image') return { chapters, at: from };
  const removed = removeImage(chapters, from.chapter, from.block);
  // 同じ章の中で後ろへ動かすときは、取り除いたぶん番号が1つ詰まる
  const after =
    to.chapter === from.chapter && from.block <= to.after ? to.after - 1 : to.after;
  return {
    chapters: insertImage(removed, to.chapter, after, img),
    at: { chapter: to.chapter, block: after + 1 },
  };
}

/**
 * **原稿を取り込み直したとき、スタジオで置いた絵を同じ場所へ付け直す。**
 *
 * 原稿ファイルを読むと章は毎回まっさらに作り直される(importers)。Word に貼った絵は
 * 原稿の側から戻ってくるが、スタジオで置いた絵(fromStudio)は原稿に無いので、
 * 何もしなければ取り込み直した瞬間に消える。誤字を直して入れ直すたびに
 * 絵を置き直させるわけにはいかない。
 *
 * 手がかりは**絵の直前にあった段落の字**。同じ字の段落が新しい原稿にあれば、そのあとへ戻す。
 * 段落を直していても、書き出しか終わりが同じなら同じ段落とみなす(比べる字数は findIn)。
 * 探すのはまず同じ名前の章(無ければ同じ番号の章)、見つからなければ本全体。
 *
 * **見つからなかった絵は捨てない。** その章の最後(章が無くなっていれば最後の章の最後)へ
 * 絵のまま移し、数を返す(画面で断る) — 挿絵ページを巻末へ寄せる fitInsertsToChapters と同じ考え方。
 * 絵をまだ選んでいない枠は、失っても惜しくないので付け直さない
 */
export function carryStudioImages(
  oldChapters: Chapter[],
  newChapters: Chapter[],
): { chapters: Chapter[]; kept: number; moved: number } {
  // 章の当て方は差し込みページ・章ごとの指定と同じ(matchChapters)。別々に決めると、
  // 章の途中の絵だけが別の章へ行く
  const match = matchChapters(oldChapters, newChapters);

  /**
   * 新しい原稿の各章で、どの段落のあとに何を足すか。-1 は章のはじめ、
   * `END` は章の最後(段落が見つからなかった絵の置き場)
   */
  const END = Number.MAX_SAFE_INTEGER;
  const adds = new Map<number, { after: number; image: ImageBlock }[]>();
  const add = (chapter: number, after: number, image: ImageBlock) => {
    const list = adds.get(chapter) ?? [];
    list.push({ after, image });
    adds.set(chapter, list);
  };
  let kept = 0;
  let moved = 0;

  /**
   * その章で、鍵に当たる段落の番号。無ければ -1。
   *
   * 1. 字がまるごと同じ段落
   * 2. 書き出しが同じ段落 → 3. 終わりが同じ段落(直した段落を拾う)
   *
   * 2・3 で比べる字数は**段落の長さに合わせる**(長ければ16字、短ければ3字だけ残して削る)。
   * 16字に固定していたら、13字の「ホームには誰もいなかった。」を「…いなかった、と思った。」へ
   * 直しただけで拾えず、絵が章の最後へ飛ばされた(2026-09-23 実測)。
   * 5字に満たない段落(「うん」など)は、同じ字が本のあちこちにあるので丸ごと一致だけにする。
   * 当たりが何か所もあるときは、**もとの位置(hint)にいちばん近いもの**を採る
   */
  const findIn = (ci: number, key: string, hint: number): number => {
    const blocks = newChapters[ci]?.blocks ?? [];
    const keys = blocks.map((b) => {
      const t = textOf(b);
      return t === null ? null : keyOf(t);
    });
    const nearest = (ok: (k: string) => boolean): number => {
      let best = -1;
      keys.forEach((k, i) => {
        if (k === null || !ok(k)) return;
        if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
      });
      return best;
    };
    let i = nearest((k) => k === key);
    if (i >= 0 || key.length < 6) return i;
    const n = Math.min(16, Math.max(5, key.length - 3));
    const head = key.slice(0, n);
    const tail = key.slice(-n);
    i = nearest((k) => k.length >= n && k.startsWith(head));
    if (i >= 0) return i;
    return nearest((k) => k.length >= n && k.endsWith(tail));
  };

  oldChapters.forEach((och, oi) => {
    const home = match[oi];

    let anchor: string | null = null;
    /**
     * その段落の、**スタジオで置いた絵を抜いた並びでの**番号(当たりが何か所もあるときの目安)。
     * 新しい原稿にはスタジオの絵が無いので、もとの並びの番号のまま比べると、前に置いた絵の
     * 枚数ぶんずれて、同じ字の別の段落のほうを近いと判断していた(2026-09-23 レビューで発見)
     */
    let anchorAt = -1;
    let plainIndex = 0;
    och.blocks.forEach((b) => {
      if (b.type === 'image' && b.fromStudio) {
        if (!b.src) return; // 絵をまだ選んでいない枠は付け直さない
        let at: { chapter: number; after: number } | null = null;
        if (anchor === null) {
          if (home >= 0) at = { chapter: home, after: -1 };
        } else {
          if (home >= 0) {
            const i = findIn(home, anchor, anchorAt);
            if (i >= 0) at = { chapter: home, after: i };
          }
          for (let ci = 0; !at && ci < newChapters.length; ci++) {
            if (ci === home) continue;
            const i = findIn(ci, anchor, anchorAt);
            if (i >= 0) at = { chapter: ci, after: i };
          }
        }
        if (at) {
          add(at.chapter, at.after, b);
          kept++;
        } else if (newChapters.length) {
          // **見つからなかった絵も、絵のまま残す。** その章の最後(章が無くなっていれば
          // 最後の章の最後)へ。以前は挿絵ページに変えていたが、それだとキャプションが
          // 運べずに消えた(2026-09-23 レビューで発見)。絵のままならキャプションも大きさも残る
          add(home >= 0 ? home : newChapters.length - 1, END, b);
          moved++;
        }
        return;
      }
      const t = textOf(b);
      if (t !== null) {
        const k = keyOf(t);
        if (k) {
          anchor = k;
          anchorAt = plainIndex;
        }
      }
      plainIndex++;
    });
  });

  if (!kept && !moved) return { chapters: newChapters, kept, moved };

  const chapters = newChapters.map((ch, ci) => {
    const list = adds.get(ci);
    if (!list) return ch;
    const blocks: Block[] = [];
    // 同じ段落のあとに何枚か付くときは、もとの並び(配列に積んだ順)を保つ
    for (const a of list) if (a.after === -1) blocks.push(a.image);
    ch.blocks.forEach((b, bi) => {
      blocks.push(b);
      for (const a of list) if (a.after === bi) blocks.push(a.image);
    });
    for (const a of list) if (a.after === END) blocks.push(a.image);
    return { ...ch, blocks };
  });
  return { chapters, kept, moved };
}
