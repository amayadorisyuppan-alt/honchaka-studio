// 自分の画像のフォルダ(「アップロード」の段)の検査。(2026-10-12 改修の希望 2)
//
// ## なぜ在るか
//
// 画像を選ぶ画面の上に、利用者が決めたフォルダの画像を並べるようにした(components/FolderImages.tsx)。
// フォルダを選ぶ窓は自動では押せず、ブラウザの部品(IndexedDB・canvas)も node には無いので、
// **数える・見分ける・覚えの鍵・保存の読み込み**を、偽物のフォルダで確かめる。
//
// 確かめること:
//
// - 拾うのは jpg・jpeg・png だけ(大文字も。webp・gif・heic は拾わない: 2026-10-13 ユーザー決定「画像の受け入れは JPEG と PNG」)。隠しファイル・隠しフォルダは見ない
// - 直下は見出しなし、中のフォルダは4段まで(5段目は見ない。BOOTH の zip を展開して入れると3段目に絵が来る)。名前は数の順(2 が 10 より前)
// - ファイル名(拡張子を除く)が同梱のプリセットの id なら presetId が付く(大文字のファイル名も)
// - 上限で数えるのをやめ、truncated を立てる
// - サムネイルの覚えの鍵は、大きさか更新日時が変われば変わる
// - 保存の .json の読み込みで、presetId は id の形の文字列だけ通る(古いファイル=無いのはそのまま)
//
// ## 回し方
//
//   node scripts/private/run-tests.mjs public    (partner でも同じ)
//
// 終了コード 0 = 全部通った / 1 = 落ちた。
import {
  groupFolderImages,
  isFolderImageName,
  presetIdFromName,
  scanImageFolder,
  thumbKey,
  type DirLike,
  type FileLike,
} from '../src/images/folderScan';
import { bundledPresetIds, isBundledPresetId } from '../src/covers/presetIds';
import { defaultSettings, isPresetId } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import { fromProjectFile, sanitize, stripBadPresetIds, toProjectFile } from '../src/project/file';

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

// ---- 偽物のフォルダ ----
type Tree = { [name: string]: Tree | number };
function fakeFile(name: string, size: number): FileLike {
  return {
    kind: 'file',
    name,
    getFile: async () => new File([new Uint8Array(size)], name, { lastModified: 1000 + size }),
  };
}
function fakeDir(name: string, tree: Tree): DirLike {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const [k, v] of Object.entries(tree)) {
        yield typeof v === 'number' ? fakeFile(k, v) : fakeDir(k, v);
      }
    },
  };
}

const ids = bundledPresetIds();

// 1. 拾う画像
ok(['a.jpg', 'a.JPEG', 'a.png', 'a.PNG'].every(isFolderImageName), '拾う: jpg・jpeg・png(大文字も)');
ok(
  !['a.webp', 'a.WebP', 'a.heic', 'a.gif', 'a.svg', 'a.txt', 'a.psd', '.a.jpg', 'jpg'].some(isFolderImageName),
  '拾わない: webp・heic・gif・svg・txt・psd・隠しファイル・拡張子なし',
);

// 2. 同梱のプリセットの id
ok(ids.size >= 100, '前提: 同梱のプリセットの id が読める', String(ids.size));
ok([...ids].every(isPresetId), '同梱の id はすべて id の形(isPresetId)');
ok(presetIdFromName('biz-business-01.jpg', ids) === 'biz-business-01', 'ファイル名が id → presetId');
ok(presetIdFromName('BIZ-BUSINESS-01.PNG', ids) === 'biz-business-01', '大文字のファイル名も同じ id');
ok(presetIdFromName('biz-business-01 (1).jpg', ids) === undefined, '名前が違えば付かない(コピーの「 (1)」)');
ok(presetIdFromName('my-photo.jpg', ids) === undefined, '自分の画像には付かない');
ok(isBundledPresetId('story-bungei-08') && !isBundledPresetId('mine-foo-01'), '同梱だけを同梱と見る(開発用の mine-* は違う)');

// 数える検査は await を使うので、まとめて main の中で回す(組み立ての対象が最上位の await を持てないため)
async function main() {
  // 3. 数える
  const tree: Tree = {
    'b.png': 30,
    'a10.jpg': 10,
    'a2.jpg': 20,
    'memo.txt': 5,
    '.hidden': { 'x.jpg': 1 },
    sub1: {
      'c.png': 40,
      'w.webp': 41,
      'h.heic': 42,
      deep: { 'd.jpg': 50, deeper: { 'e.jpg': 60, deepest: { 'f.jpg': 65, toodeep: { 'g.jpg': 66 } } } },
    },
    sub0: { 'biz-business-01.jpg': 70 },
  };
  const root = fakeDir('images', tree);
  {
    const r = await scanImageFolder(root, ids);
    const paths = r.images.map((i) => i.path);
    ok(
      JSON.stringify(paths) ===
        JSON.stringify([
          'a2.jpg', 'a10.jpg', 'b.png', 'sub0/biz-business-01.jpg', 'sub1/c.png', 'sub1/deep/d.jpg',
          'sub1/deep/deeper/e.jpg', 'sub1/deep/deeper/deepest/f.jpg',
        ]),
      '並び: 直下(数の順)→ 中のフォルダ(名前の順)。txt・隠しフォルダ・5段目は入らない',
      JSON.stringify(paths),
    );
    ok(!r.truncated, '上限の手前なら truncated は立たない');
    const groups = groupFolderImages(r.images).map((g) => `${g.group}:${g.images.length}`);
    ok(
      JSON.stringify(groups) ===
        JSON.stringify([':3', 'sub0:1', 'sub1:1', 'sub1 / deep:1', 'sub1 / deep / deeper:1', 'sub1 / deep / deeper / deepest:1']),
      '小見出し: 直下は見出しなし、2段目は「sub1 / deep」、4段目まで',
      JSON.stringify(groups),
    );
    const hi = r.images.find((i) => i.name === 'biz-business-01.jpg');
    ok(hi?.presetId === 'biz-business-01', '中のフォルダにある高解像度版にも presetId');
    ok(r.images.filter((i) => i.presetId).length === 1, 'ほかの画像には presetId が付かない');
  }
  {
    const r = await scanImageFolder(root, ids, { limit: 4 });
    ok(r.truncated && r.images.length === 4, '上限で止めて truncated を立てる', `${r.truncated} ${r.images.length}`);
  }
  {
    const r = await scanImageFolder(root, ids, { maxDepth: 0 });
    ok(r.images.length === 3, '段数 0 なら直下だけ', String(r.images.length));
  }

  // 4. サムネイルの覚えの鍵
  {
    const k1 = thumbKey('images', 'a.jpg', 100, 5);
    ok(k1 === thumbKey('images', 'a.jpg', 100, 5), '鍵: 同じファイルなら同じ');
    ok(k1 !== thumbKey('images', 'a.jpg', 101, 5), '鍵: 大きさが変われば変わる');
    ok(k1 !== thumbKey('images', 'a.jpg', 100, 6), '鍵: 更新日時が変われば変わる');
    ok(k1 !== thumbKey('images', 'sub/a.jpg', 100, 5), '鍵: 場所が違えば変わる');
  }

  // 5. 保存の .json の読み込み(presetId は id の形だけ通す)
  {
    ok(isPresetId('biz-business-01') && !isPresetId('../x') && !isPresetId('A B') && !isPresetId(12) && !isPresetId(''), 'isPresetId の形');
    const good = { src: 'x', fromPreset: true, presetId: 'biz-business-01' };
    const input = { titleBg: good, tocBg: { src: 'y', presetId: '../../evil' }, plates: [{ id: 'p', presetId: 12 }], bodyBgPresetId: 'Bad Id' };
    const out = stripBadPresetIds(input) as typeof input;
    ok(out.titleBg === good, '正しい id の枝は同じもののまま(写さない)');
    ok(!('presetId' in out.tocBg) && !('presetId' in out.plates[0]) && !('bodyBgPresetId' in out), '形の違う presetId は外す', JSON.stringify(out));
    ok(input.tocBg.presetId === '../../evil', '読み込んだもとのオブジェクトは書き換えない');
    const plain = { a: { b: [1, 2] } };
    ok(stripBadPresetIds(plain) === plain, '外すものが無ければ同じオブジェクト');
  }
  {
    const ms = sampleManuscript();
    const PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const manuscript = {
      ...ms,
      chapters: ms.chapters.map((ch, i) =>
        i === 0
          ? { ...ch, blocks: [...ch.blocks, { type: 'image', src: PNG, presetId: 'story-bungei-08', fromPreset: true }, { type: 'image', src: PNG, presetId: 'NO GOOD' }] }
          : ch,
      ),
    };
    const settings = {
      ...defaultSettings(),
      titleBg: { src: PNG, fromPreset: true, presetId: 'story-bungei-01' },
      bodyBg: PNG,
      bodyBgFromPreset: true,
      bodyBgPresetId: 'zine-retro-02',
      plates: [{ id: 'p1', src: PNG, beforeChapter: 0, size: 'full', fromPreset: true, presetId: 'bad/id' }],
    };
    const snap = { settings, cover: defaultCoverSettings(), manuscript, source: null } as never;
    const r = fromProjectFile(toProjectFile(snap, true), snap);
    const s = r.project.settings;
    ok(s.titleBg?.presetId === 'story-bungei-01', '控えの往復: 大扉の presetId が残る', JSON.stringify(s.titleBg?.presetId));
    ok(s.bodyBgPresetId === 'zine-retro-02', '控えの往復: 本文全体の presetId が残る');
    ok(s.plates[0] && !('presetId' in s.plates[0]) && s.plates[0].fromPreset === true, '控えの往復: 形の違う presetId だけ外す(目印は残す)', JSON.stringify(s.plates[0]?.presetId));
    const imgs = r.project.manuscript.chapters[0].blocks.filter((b) => b.type === 'image') as { presetId?: string }[];
    const last2 = imgs.slice(-2);
    ok(last2[0]?.presetId === 'story-bungei-08' && last2[1] && !('presetId' in last2[1]), '控えの往復: 本文中の画像も同じ', JSON.stringify(last2.map((b) => b.presetId)));
    // 古いファイル(presetId が無い)はそのまま
    const old = sanitize({ settings: defaultSettings(), cover: defaultCoverSettings(), manuscript: ms, source: null } as never, snap, true);
    ok(old.fixed.length === 0 && old.removed.length === 0, '古いファイル: presetId が無くても何も言わない', JSON.stringify(old));
  }

  console.log(`\n${passed} 通過 / ${failed} 失敗`);
  process.exit(failed ? 1 : 0);
}
void main();
