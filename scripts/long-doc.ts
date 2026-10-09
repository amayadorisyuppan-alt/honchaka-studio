// **長い本**を1か所で作る。`scripts/long-probe.ts` と検査から使う。
//
// ユーザーの原稿(297ページの Word)はリポジトリの外の非公開の資料フォルダにあり、実原稿なので git に上げられない。
// 検査は**誰の手元でも同じ結果になる**必要があるので、**サンプル原稿を積んで長くする。**
// 章の中身をそのまま繰り返すだけなので、字数もページ割りも実原稿と同じ性質を持つ
// (実測: 9倍に積んだ本は 288ページ。ユーザーの原稿を取り込んだ 348ページと同じ厚み)。
//
// **差し込みページ(挿絵・コラム)は積まない。** 増えるのは本文だけで、
// front matter(大扉・目次)は1つのまま。目次だけは章の数ぶん伸びる — 実物と同じ。
import { defaultSettings } from '../src/models/project';
import type { Chapter, Manuscript, ProjectSettings } from '../src/models/project';
import { collectFontFaceCss } from '../src/typeset/fontface';
import { BODY_FONTS, HEADING_FONT_STACK, THEME_BODY_FONT } from '../src/models/project';

export interface LongDocOptions {
  /** サンプル原稿を何回ぶん積むか。1 = 34ページ、3 = 98ページ、9 = 288ページ */
  scale: number;
  /** 横組みで組む(既定は縦組み) */
  yoko?: boolean;
}

/**
 * サンプル原稿を `scale` 回ぶん積んだ原稿を作る。
 *
 * **章の題は重複させない。** 目次のリーダー罫は組版のいちばん重い後処理で、
 * 同じ題が並ぶと「本当に章の数ぶん出ているか」を目で確かめられない。
 * 「第一章(2巡目)」のように巡目を足して、数えられるようにする
 */
export function stackManuscript(base: Manuscript, scale: number): Manuscript {
  const n = Math.max(1, Math.round(scale));
  const chapters: Chapter[] = [];
  for (let round = 0; round < n; round++) {
    for (const ch of base.chapters) {
      chapters.push({
        ...ch,
        title: round === 0 ? ch.title : `${ch.title}（${round + 1}巡目）`,
        // blocks は読むだけなので共有してよい(組版は破壊しない)
        blocks: ch.blocks,
      });
    }
  }
  return { ...base, chapters };
}

/** 取り込んだ直後の設定。アプリが `handleFile` のあとに持っているものと同じ */
export function longSettings(opt: { yoko?: boolean } = {}): ProjectSettings {
  return {
    ...defaultSettings(),
    ...(opt.yoko ? { writingMode: 'horizontal' as const } : {}),
  };
}

/**
 * 本に出てくる文字を集める。**アプリの `bookText` と同じ集め方。**
 * @font-face をその字を含むサブセットに絞るのに使う
 */
export function bookTextOf(ms: Manuscript, s: ProjectSettings): string {
  const parts: string[] = [ms.title, ms.author, ms.publisher, ms.authorProfile ?? ''];
  for (const ch of ms.chapters) {
    parts.push(ch.no ?? '', ch.title);
    for (const b of ch.blocks) {
      if (b.type === 'p' || b.type === 'h3' || b.type === 'quote') parts.push(b.text);
      else if (b.type === 'list') parts.push(b.items.join(''));
      else if (b.type === 'image') parts.push(b.caption ?? b.alt ?? '');
    }
  }
  for (const c of s.columnPages ?? []) parts.push(c.title, c.text);
  return [...new Set(parts.join(''))].join('');
}

/**
 * 組版HTMLに同梱する @font-face を集める。**アプリの `fontFaceCss` と同じ引数。**
 *
 * ここを渡さずに測ると、**書体をまるごと持たない本**を測ることになる
 */
export function longFontFaceCss(ms: Manuscript, s: ProjectSettings): string {
  const currentFont = BODY_FONTS[s.bodyFont] ?? BODY_FONTS[THEME_BODY_FONT[s.theme]];
  return collectFontFaceCss(
    [currentFont.stack, HEADING_FONT_STACK].filter(Boolean),
    bookTextOf(ms, s),
  );
}
