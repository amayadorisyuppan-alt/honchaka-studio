// 画像のフォルダの高解像度版への差し替え(models/hiresSwap.ts)の検査。(2026-10-12 改修の希望 2 の続き)
//
// ## なぜ在るか
//
// 細かさの知らせが同梱のプリセットの絵に出ているとき、フォルダに高解像度版があれば、
// 入稿前チェックの［まとめて差し替える］で、挿絵・章の途中の絵・背景の絵の src をまとめて替える。
// 何を替えるか(知らせの出ている絵だけ・presetId のある絵だけ)と、何を残すか(fromPreset・presetId・濃さ)を
// 設定と原稿を触らずに確かめる。画面の部分(ボタン・読み込み)は司令官が画面で確かめる。
//
// ## 回し方
//
//   node scripts/private/run-tests.mjs public    (partner でも同じ)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import { countSwapUnits, swapPresetArt, type SwapFilter } from '../src/models/hiresSwap';
import { defaultSettings, type ImageBlock, type Manuscript, type Plate } from '../src/models/project';
import { sampleManuscript } from '../src/sample';
import { imageKey } from '../src/models/inlineImages';

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

const OLD = 'data:image/jpeg;base64,OLD';
const OTHER = 'data:image/jpeg;base64,OTHER';
const NEW = (id: string, wide: boolean) => `data:image/jpeg;base64,NEW-${id}-${wide ? 'w' : 'n'}`;

function plate(id: string, extra: Partial<Plate> = {}): Plate {
  return { id, src: OLD, beforeChapter: 0, size: 'full', fromPreset: true, presetId: 'biz-business-01', ...extra } as Plate;
}

const settings = defaultSettings();
settings.plates = [
  plate('a'), // 知らせが出ている・同梱 → 替える
  plate('b', { size: 'spread', textOk: true }), // 見開き。textOk は消える
  plate('c', { src: OTHER }), // 知らせが出ていない → 替えない
  plate('d', { presetId: undefined, fromPreset: undefined }), // 自分の画像(presetId なし) → 対象外
];
settings.titleBg = { src: OLD, fromPreset: true, presetId: 'zine-retro-02', opacity: 0.4 } as never;
settings.bodyBg = OLD;
settings.bodyBgFromPreset = true;
settings.bodyBgPresetId = 'story-daily-03';
settings.chapterBg = { 0: { src: OLD, fromPreset: true, presetId: 'zine-retro-02' } } as never;
settings.columnPages = [
  { id: 'col1', title: '', text: '', beforeChapter: 0, bg: { src: OLD, fromPreset: true, presetId: 'zine-retro-02' } },
] as never;

const ms: Manuscript = JSON.parse(JSON.stringify(sampleManuscript()));
const imgA: ImageBlock = { type: 'image', src: OLD, fromPreset: true, presetId: 'biz-business-01', textOk: true };
const imgB: ImageBlock = { type: 'image', src: OLD, fromPreset: true, presetId: 'biz-business-01' };
ms.chapters[0].blocks = [...ms.chapters[0].blocks.filter((b) => (b as { type: string }).type !== 'image'), imgA, imgB];
const iA = ms.chapters[0].blocks.length - 2;
const iB = ms.chapters[0].blocks.length - 1;

const filter: SwapFilter = {
  plates: new Set(['plate:a', 'plate:b', 'plate:d']),
  imgs: new Set([`img:${imageKey(0, iA)}`]), // B の絵は知らせが出ていない
  bgSrcs: new Set([OLD]),
};

// 何も替えない pick で、対象だけ集める
{
  const r = swapPresetArt(settings, ms, filter, () => undefined);
  ok(!r.settings && !r.manuscript, '替えないときは、設定も原稿も変わらない');
  const kinds = r.places.map((p) => p.unit).sort();
  ok(r.places.filter((p) => p.kind === 'plate').length === 2, '挿絵は、知らせが出ていて presetId のある2枚だけ', kinds.join(','));
  ok(r.places.filter((p) => p.kind === 'img').length === 1, '章の途中の絵は、知らせが出ている1枚だけ');
  ok(r.places.some((p) => p.unit === 'plate:b' && p.wide), '見開きの挿絵は wide');
  ok(r.places.some((p) => p.unit === 'plate:a' && !p.wide), 'ふつうの挿絵は wide でない');
  // 背景: 同じ絵(OLD)を敷く面が4つ(大扉・章・コラム・本文)あるが presetId が違う。単位は絵ごと
  const bgs = r.places.filter((p) => p.kind === 'bg');
  ok(bgs.length === 4, '背景は presetId のある4か所すべてが対象', String(bgs.length));
  ok(countSwapUnits(r.places, (p) => p.kind === 'bg') === 1, '背景は同じ絵なら1枚と数える', String(countSwapUnits(r.places, (p) => p.kind === 'bg')));
  ok(countSwapUnits(r.places) === 4, '全体は 挿絵2 + 章の途中1 + 背景1 = 4 枚', String(countSwapUnits(r.places)));
}

// 差し替え
{
  const before = JSON.stringify({ s: settings, m: ms });
  const r = swapPresetArt(settings, ms, filter, (p) => NEW(p.presetId, p.wide));
  ok(JSON.stringify({ s: settings, m: ms }) === before, '入力は書き換えない');
  const plates = r.settings?.plates as Plate[] | undefined;
  ok(plates?.[0].src === NEW('biz-business-01', false), '挿絵 a: src が替わる');
  ok(plates?.[0].fromPreset === true && plates?.[0].presetId === 'biz-business-01', '挿絵 a: fromPreset と presetId は残る');
  ok(plates?.[1].src === NEW('biz-business-01', true), '挿絵 b(見開き): 見開き用で読んだ絵に替わる');
  ok(plates?.[1].textOk === undefined && !('textOk' in (plates?.[1] ?? {})), '挿絵 b: 「このままにする」は消える');
  ok(plates?.[2].src === OTHER, '挿絵 c(知らせなし): 替えない');
  ok(plates?.[3].src === OLD, '挿絵 d(presetId なし): 替えない');
  const blocks = r.manuscript?.chapters?.[0].blocks as ImageBlock[] | undefined;
  ok(blocks?.[iA].src === NEW('biz-business-01', false) && !('textOk' in blocks[iA]), '章の途中の絵 A: 替わり、textOk は消える');
  ok(blocks?.[iA].fromPreset === true && blocks?.[iA].presetId === 'biz-business-01', '章の途中の絵 A: 印は残る');
  ok(blocks?.[iB].src === OLD, '章の途中の絵 B(知らせなし): 替えない');
  const t = r.settings?.titleBg;
  ok(t?.src === NEW('zine-retro-02', false) && t?.opacity === 0.4 && t?.presetId === 'zine-retro-02', '大扉の背景: src だけ替わり、濃さと presetId は残る');
  ok(r.settings?.bodyBg === NEW('story-daily-03', false), '本文全体の背景: bodyBg が替わる');
  ok(r.settings?.bodyBgPresetId === undefined, '本文全体の背景: 印は patch に入れない(元のまま残る)');
  ok(r.settings?.chapterBg?.[0]?.src === NEW('zine-retro-02', false), '章の背景が替わる');
  ok(r.settings?.columnPages?.[0].bg?.src === NEW('zine-retro-02', false), 'コラムの背景が替わる');
}

// 一部だけ読めた(フォルダに無い id は undefined)・同じ絵を返したときは替えない
{
  const r = swapPresetArt(settings, ms, filter, (p) => (p.presetId === 'biz-business-01' ? undefined : NEW(p.presetId, false)));
  ok(!r.settings?.plates, 'フォルダに無い id の挿絵は替えない');
  ok(!r.manuscript, 'フォルダに無い id の章の途中の絵は替えない');
  ok(!!r.settings?.titleBg && !!r.settings?.bodyBg, 'フォルダにある id の背景は替わる');
  const same = swapPresetArt(settings, ms, filter, (p) => p.src);
  ok(!same.settings && !same.manuscript, '同じ絵を返したら何も変わらない(元に戻す履歴を増やさない)');
}

// 背景の対象は絵(src)で引く: 知らせの出ていない絵の背景は替えない
{
  const none: SwapFilter = { plates: new Set(), imgs: new Set(), bgSrcs: new Set(['data:other']) };
  const r = swapPresetArt(settings, ms, none, (p) => NEW(p.presetId, p.wide));
  ok(r.places.length === 0 && !r.settings && !r.manuscript, '知らせの出ていない絵は、どれも対象にならない');
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
