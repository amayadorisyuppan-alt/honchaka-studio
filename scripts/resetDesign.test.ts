// 帯の本全体の［すべてリセット］(resetDesign)が戻す範囲の検査。
//
// ## なぜ在るか
//
// 本全体の［すべてリセット］は、本全体の値と章ごとの指定を戻すが、コラムだけ・大扉だけ・目次だけ・奥付だけで
// 変えた濃さ・フチ・色は残っていた。10/12 に「それらも全部戻す」と決めた(修正リスト 2-3)。
// 戻すのは帯が書き込む見た目の値だけで、コラムの文章・敷いた絵・各ページの絵・書名などの中身は残す。
// その境目を、状態を直に見て確かめる。
//
// ## 回し方(ブラウザも dev サーバーも要らない)
//
//   node scripts/private/run-tests.mjs public    (または partner)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { resetPageDesigns } from '../src/store/designReset';
import { defaultSettings, type ColumnPage, type ProjectSettings } from '../src/models/project';

let failed = 0;
let passed = 0;
function ok(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}
const j = JSON.stringify;

const IMG = 'data:image/png;base64,AAAA';

const column: ColumnPage = {
  id: 'c1',
  title: 'コラムの見出し',
  text: 'コラムの本文',
  beforeChapter: 1,
  writingMode: 'horizontal',
  order: 3,
  bodyFont: 'gothic' as never,
  fontPt: 11,
  lineFeedPt: 20,
  color: '#cc0000',
  headingFont: 'gothic' as never,
  headingPt: 14,
  headingColor: '#0055aa',
  outline: 0.09,
  outlineColor: '#ffffff',
  plate: 0.95,
  plateColor: '#000000',
  padXPct: 5,
  padYPct: 4,
  bg: { src: IMG, opacity: 0.3 },
};
const column2: ColumnPage = { id: 'c2', title: '', text: 'x', beforeChapter: 0, bg: { opacity: 0.2 } };

// 帯のあらゆる向き先で、既定から変えた状態を作る
const dirty: ProjectSettings = {
  ...defaultSettings(),
  bgOpacity: 0.5,
  textOutline: 0.09,
  chapterFont: { 0: 'gothic' as never },
  chapterBg: { 0: { src: IMG, opacity: 0.4, outline: 0.09, outlineColor: '#ff0000' } },
  columnPages: [column, column2],
  titleBg: { src: IMG, opacity: 0.6, outline: 0.05, outlineColor: '#00ff00' },
  tocBg: { opacity: 0.7, outline: 0.09 },
  colophonBg: { base: 'plain', opacity: 0.8, outlineColor: '#0000ff' },
  colophonType: { bodyFont: 'gothic' as never, fontPt: 8 } as never,
  profileType: { fontPt: 9 } as never,
  titlepageTitleFont: 'gothic' as never,
  titlepageAuthorFont: 'cover',
};

// 本全体の［すべてリセット］(store の resetDesign)が、本全体・章の分に重ねて呼ぶ部分。差分を重ねて見る
const reset = (x: ProjectSettings): ProjectSettings => ({ ...x, ...resetPageDesigns(x) });
const s = reset(dirty);

// ---- コラム ----
const c1 = s.columnPages?.find((c) => c.id === 'c1');
const c2 = s.columnPages?.find((c) => c.id === 'c2');
ok(!!c1 && !!c2 && s.columnPages?.length === 2, 'コラムは消えない(2つのまま)');
const COL_KEYS = [
  'bodyFont', 'fontPt', 'lineFeedPt', 'color', 'headingFont', 'headingPt', 'headingColor',
  'outline', 'outlineColor', 'plate', 'plateColor', 'padXPct', 'padYPct',
] as const;
ok(!!c1 && COL_KEYS.every((k) => c1[k] === undefined), 'コラムの見た目の欄(書体・サイズ・色・フチ・帯・余白)が戻る', j(c1));
ok(c1?.title === 'コラムの見出し' && c1?.text === 'コラムの本文', 'コラムの見出し・本文は残る');
ok(c1?.beforeChapter === 1 && c1?.writingMode === 'horizontal' && c1?.order === 3, 'コラムの位置・組み方向は残る');
ok(c1?.bg?.src === IMG && c1?.bg?.opacity === undefined, 'コラムに敷いた絵は残り、濃さだけ戻る', j(c1?.bg));
ok(c2 !== undefined && c2.bg === undefined && !('bg' in c2), '濃さだけだったコラムの bg は空になって消える', j(c2));

// ---- 大扉・目次・奥付 ----
ok(s.titleBg?.src === IMG && s.titleBg?.opacity === undefined && s.titleBg?.outline === undefined && s.titleBg?.outlineColor === undefined, '大扉の絵は残り、濃さ・フチが戻る', j(s.titleBg));
ok(s.tocBg === undefined, '濃さとフチだけだった目次の背景の指定は空になる', j(s.tocBg));
ok(j(s.colophonBg) === j({ base: 'plain' }), '奥付の背景は「無地」の指定を残し、濃さ・フチ色が戻る', j(s.colophonBg));
ok(s.colophonType === undefined && s.profileType === undefined, '奥付・著者紹介の書体・サイズ・色が戻る');
ok(s.titlepageTitleFont === undefined && s.titlepageAuthorFont === undefined, '大扉の書名・著者名の書体が戻る(省略 = 本文の書体)');

// ---- 本全体・章のぶんには触れない(それは店の resetDesign の元からの範囲) ----
ok(s.bgOpacity === dirty.bgOpacity && s.chapterFont === dirty.chapterFont && s.chapterBg === dirty.chapterBg, '本全体・章の指定には触れない');

// ---- もう一度押しても壊れない / 何も無い本でも落ちない ----
ok(j(reset(s).columnPages) === j(s.columnPages) && j(reset(s).titleBg) === j(s.titleBg), '二度押しても同じ');
let threw = false;
let s0: ProjectSettings = defaultSettings();
try {
  s0 = reset(defaultSettings());
} catch {
  threw = true;
}
ok(!threw, 'コラムも大扉の指定も無い本で押しても落ちない');
ok(s0.columnPages === undefined || s0.columnPages.length === 0, 'コラムが無い本にコラムは増えない');
ok(s0.titleBg === undefined && s0.tocBg === undefined, '無い指定は増えない(大扉・目次)', j({ t: s0.titleBg, c: s0.tocBg }));

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
