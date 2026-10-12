// 紙に刷るときの、絵ごとの刷り色。(2026-10-12 1.1.0。修正リストの 4-1・4-6)
//
// **カラーの本でも、絵ごとに「白黒で刷る」を選べる**(10/10 ユーザー決定)。ページごとに単価を数える印刷所では、
// 白黒で刷る絵だけのページは白黒の単価になる(「1つだけカラーの絵にして、ほかは白黒で刷りたい」)。
// 白黒の本は、絵をすべて白黒で刷る(4-1。前は CSS の filter で、PDF で 300dpi に描き直されていた)。
//
// 白黒で刷る絵は、組む直前に**灰色の写し**(src/images/grayCopy.ts)へ差し替える。下見と紙の PDF が同じ絵になる。
// EPUB と表紙は元の絵のまま(ここを通さない)。差し替えたものは保存しない(組むためだけの写し)。
//
// ここは画面に依存しない(node の検査でも回せる)。写しを引く関数は呼ぶ側が渡す。
import { isRenderableImage } from './project';
import type { BgSpec, ImageBlock, Manuscript, Plate, ProjectSettings } from './project';

/** 灰色の写しを引く。無ければ undefined(差し替えない) */
export type GrayLookup = (src: string) => string | undefined;

const isMonoBook = (s: ProjectSettings) => s.ink === 'mono';

/** 絵を置く場所の名前(知らせ・一覧で使う)と、その絵 */
export interface PrintImage {
  src: string;
  /** 白黒で刷る印が付いているか(白黒の本では、画面で選ぶ絵はすべて白黒) */
  mono: boolean;
  kind: 'plate' | 'figure' | 'background';
}

/** 背景の面(大扉・目次・奥付・章・コラム)。本文の地(bodyBg)は別に持つ */
function bgSpecs(s: ProjectSettings): BgSpec[] {
  return [
    s.titleBg,
    s.tocBg,
    s.colophonBg,
    ...Object.values(s.chapterBg ?? {}),
    ...(s.columnPages ?? []).map((c) => c.bg),
  ].filter((b): b is BgSpec => Boolean(b?.src));
}

function figureBlocks(m: Manuscript): ImageBlock[] {
  const out: ImageBlock[] = [];
  for (const ch of m.chapters) for (const b of ch.blocks) if (b.type === 'image' && b.src) out.push(b);
  return out;
}

/**
 * 紙に刷る絵の一覧(刷り色の印つき)。白ページ・絵の無い枠は入れない。
 * 白黒の本の背景は、前から CSS の合成(luminosity)で灰色にしており、細かさも落ちないので写しにしない(mono は false で返す)
 */
export function printImages(s: ProjectSettings, m: Manuscript): PrintImage[] {
  const monoBook = isMonoBook(s);
  const out: PrintImage[] = [];
  for (const p of s.plates ?? []) {
    if (p.blank || !p.src) continue;
    out.push({ src: p.src, mono: monoBook || Boolean(p.printMono), kind: 'plate' });
  }
  for (const b of figureBlocks(m)) out.push({ src: b.src, mono: monoBook || Boolean(b.printMono), kind: 'figure' });
  if (!monoBook) {
    if (s.bodyBg) out.push({ src: s.bodyBg, mono: Boolean(s.bodyBgPrintMono), kind: 'background' });
    for (const b of bgSpecs(s)) out.push({ src: b.src as string, mono: Boolean(b.printMono), kind: 'background' });
  }
  return out;
}

// ───────────── 白黒に見える絵・ごく淡い色の絵(知らせるだけ。黙って白黒にはしない) ─────────────

/** 絵の色のずれ(images/chroma.ts が測る。画素ごとの R・G・B の最大−最小の、平均と 99.9% 点) */
export interface ChromaLike {
  mean: number;
  p999: number;
  /** 入稿用の変換が無彩色と見る(K だけで刷られる)絵か。そうなら知らせない */
  neutral?: boolean;
}

/**
 * 'gray' = 白黒に見えるのに色の情報を持つ / 'pale' = セピアのような、ごく淡い色 / null = どちらでもない。
 * 境目(2026-10-12。長い辺 1024px に縮めて、同梱の絵 101 枚と生成AIの千鳥で測った):
 *   白黒に見える … 平均 2 以下・99.9% 点 16 以下。生成AIの白黒の千鳥(0.5〜0.8・6〜8)・灰色の帯(0.2・4)など。
 *                  差し色のある絵(平均 1.8 でも 99.9% 点 46)は入らない(わざと色を残している)
 *   ごく淡い色   … 平均 12 以下・99.9% 点 32 以下。うっすら色がかった絵(5.7・10 など)。
 *                  はっきり色のある絵(クリームの紙 27・117、カラーの千鳥)は入らない
 * **最大で切らない**(生成AIの白黒の絵は、ところどころに強い色の点がある)
 */
export function colorLookOf(c: ChromaLike | undefined): 'gray' | 'pale' | null {
  // 変換が無彩色と見る絵(灰色ちょうどの絵)は、何もしなくても K だけで刷られる
  if (!c || c.neutral) return null;
  if (c.mean <= 2 && c.p999 <= 16) return 'gray';
  if (c.mean <= 12 && c.p999 <= 32) return 'pale';
  return null;
}

/**
 * 白黒に見える絵・ごく淡い色の絵の行(カラーの本だけ。「白黒で刷る」にした絵は外す)。
 * 鍵は、挿絵ページ plate:id・章の途中の絵 img:章:並び(PlateEditor の行と同じ)・背景 bg:面の名前
 * (body・title・toc・colophon・chapter-章・col-コラムの id)
 */
export function colorLookRows(
  s: ProjectSettings,
  m: Manuscript,
  chroma: (src: string) => ChromaLike | undefined,
): Map<string, 'gray' | 'pale'> {
  const rows = new Map<string, 'gray' | 'pale'>();
  if (isMonoBook(s)) return rows;
  const add = (key: string, src: string | undefined, mono: boolean | undefined) => {
    if (!src || mono || !isRenderableImage(src)) return;
    const look = colorLookOf(chroma(src));
    if (look) rows.set(key, look);
  };
  for (const p of s.plates ?? []) if (!p.blank) add(`plate:${p.id}`, p.src, p.printMono);
  m.chapters.forEach((ch, ci) =>
    ch.blocks.forEach((b, bi) => {
      if (b.type === 'image') add(`img:${ci}:${bi}`, b.src, b.printMono);
    }),
  );
  add('bg:body', s.bodyBg, s.bodyBgPrintMono);
  add('bg:title', s.titleBg?.src, s.titleBg?.printMono);
  add('bg:toc', s.tocBg?.src, s.tocBg?.printMono);
  add('bg:colophon', s.colophonBg?.src, s.colophonBg?.printMono);
  for (const [k, b] of Object.entries(s.chapterBg ?? {})) add(`bg:chapter-${k}`, b?.src, b?.printMono);
  for (const c of s.columnPages ?? []) add(`bg:col-${c.id}`, c.bg?.src, c.bg?.printMono);
  return rows;
}

/** 色のずれを測る絵(カラーの本で、白黒で刷る印の無い絵) */
export function chromaSources(s: ProjectSettings, m: Manuscript): string[] {
  if (isMonoBook(s)) return [];
  return [...new Set(printImages(s, m).filter((i) => !i.mono && isRenderableImage(i.src)).map((i) => i.src))];
}

/** 灰色の写しが要る絵(重ねない。表示できない形式は組版に出ないので外す) */
export function grayCopySources(s: ProjectSettings, m: Manuscript): string[] {
  return [...new Set(printImages(s, m).filter((i) => i.mono && isRenderableImage(i.src)).map((i) => i.src))];
}

/**
 * 白黒で刷る絵を、灰色の写しに差し替えた設定と原稿を返す。**差し替えるものが無ければ、渡されたものをそのまま返す**
 * (同じ参照を返すので、組版の useMemo が組み直さない)。
 * 差し替えた挿絵ページ・章の途中の絵には grayCopy の印を付ける(組版の CSS が filter を掛けないように。css.ts)
 */
export function withGrayCopies(
  s: ProjectSettings,
  m: Manuscript,
  gray: GrayLookup,
): { settings: ProjectSettings; manuscript: Manuscript } {
  const monoBook = isMonoBook(s);
  const swap = (src: string | undefined, mono: boolean | undefined) =>
    src && (monoBook || mono) ? gray(src) : undefined;

  let settings = s;
  const touch = () => {
    if (settings === s) settings = { ...s };
    return settings;
  };

  // 挿絵ページ
  if ((s.plates ?? []).some((p) => !p.blank && swap(p.src, p.printMono))) {
    touch().plates = (s.plates ?? []).map((p): Plate => {
      const g = p.blank ? undefined : swap(p.src, p.printMono);
      return g ? { ...p, src: g, grayCopy: true } : p;
    });
  }
  // 背景(カラーの本で白黒を選んだものだけ。白黒の本の背景は合成で灰色にしている)
  if (!monoBook) {
    const bg = (b: BgSpec | undefined): BgSpec | undefined => {
      const g = b?.printMono ? swap(b.src, true) : undefined;
      return g && b ? { ...b, src: g } : b;
    };
    const g = s.bodyBgPrintMono ? swap(s.bodyBg, true) : undefined;
    if (g) touch().bodyBg = g;
    for (const k of ['titleBg', 'tocBg', 'colophonBg'] as const) {
      const next = bg(s[k]);
      if (next !== s[k]) touch()[k] = next;
    }
    if (s.chapterBg) {
      const entries = Object.entries(s.chapterBg).map(([k, v]) => [k, bg(v)] as const);
      if (entries.some(([k, v]) => v !== s.chapterBg?.[Number(k)])) {
        touch().chapterBg = Object.fromEntries(entries) as ProjectSettings['chapterBg'];
      }
    }
    if ((s.columnPages ?? []).some((c) => bg(c.bg) !== c.bg)) {
      touch().columnPages = (s.columnPages ?? []).map((c) => {
        const next = bg(c.bg);
        return next === c.bg ? c : { ...c, bg: next };
      });
    }
  }

  // 章の途中の絵
  let manuscript = m;
  if (figureBlocks(m).some((b) => swap(b.src, b.printMono))) {
    manuscript = {
      ...m,
      chapters: m.chapters.map((ch) => {
        if (!ch.blocks.some((b) => b.type === 'image' && swap(b.src, b.printMono))) return ch;
        return {
          ...ch,
          blocks: ch.blocks.map((b) => {
            if (b.type !== 'image') return b;
            const g = swap(b.src, b.printMono);
            return g ? { ...b, src: g, grayCopy: true } : b;
          }),
        };
      }),
    };
  }
  return { settings, manuscript };
}
