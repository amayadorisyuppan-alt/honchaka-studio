// **入口の3つのボタンが、前の本を消し切っているかを機械で測る。**
//
// ## なぜ在るか
//
// 「新規・続けて・サンプル、どのボタンを押したとしても、いまキャンバス上に残っている
// データをすべてゼロリセットしないといけないのに、それができてない」
// 「これ前もあったんだけど、エラーが直ってない」(2026-08-21 ユーザー)
//
// 目で見て「消えました」と言うかぎり、同じ取りこぼしはまた起きる。
// そこで**前の本のすべての置き場に同じ印(NEEDLE)を書き込んでから**ボタンを押し、
// 状態を丸ごと walk して印の残っている場所を**道つきで数える**。
// 置き場が1つ増えたときに拾い漏らさないよう、項目を並べるのではなく総なめにしてある。
//
// ## 使い方
//
//   npx vite --port 5199
//   http://localhost:5199/scripts/store-probe.html
//
// 測り終わると document.title が `PROBE-DONE`(全部消えた)か `PROBE-FAIL`。
// **IndexedDB を書き換える**ので、素のプロファイルで開くこと。
import { hasWorkToLose, useProject } from '../src/store/useProject';
import { fromProjectFile, toProjectFile } from '../src/project/file';
import { defaultSettings } from '../src/models/project';
import { defaultCoverSettings } from '../src/models/cover';
import { sampleManuscript } from '../src/sample';
import { reportProbe } from './probe-report';

/** 前の本にだけ書き込む印。どこかに残っていれば、そこが消し忘れ */
const NEEDLE = 'ZZ-MAE-NO-HON-ZZ';
const DIRTY_IMG = `data:image/png;base64,${NEEDLE}`;

/** 状態を総なめして、印の残っている場所を道つきで返す */
function findNeedle(value: unknown, path = '', out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.includes(NEEDLE)) out.push(path || '(root)');
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findNeedle(v, `${path}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.includes(NEEDLE)) out.push(`${path}.${k}(鍵)`);
      findNeedle(v, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

/** 検査の対象。**関数と loaded/isFirstRun 以外は全部見る** */
function snapshot() {
  const s = useProject.getState();
  return {
    settings: s.settings,
    cover: s.cover,
    manuscript: s.manuscript,
    source: s.source,
    isSample: s.isSample,
    past: s.past,
    future: s.future,
  };
}

/** 前の本を作る。**印を置ける場所には全部置く**(絵・章ごとの地・帯・表紙・差し込み・控え) */
function makeDirtyBook() {
  const st = useProject.getState();
  st.setManuscript(
    {
      title: `前の本 ${NEEDLE}`,
      author: NEEDLE,
      publisher: NEEDLE,
      authorProfile: NEEDLE,
      colophonExtra: NEEDLE,
      chapters: [
        { title: `第一章 ${NEEDLE}`, blocks: [{ type: 'p', text: `本文 ${NEEDLE}` }] },
        { title: `第二章 ${NEEDLE}`, blocks: [{ type: 'p', text: `本文 ${NEEDLE}` }] },
      ],
    },
    { name: `${NEEDLE}.txt`, kind: 'txt', data: NEEDLE },
  );
  st.setSettings({
    bodyBg: DIRTY_IMG,
    bodyBgFromPreset: false,
    titleBg: { src: DIRTY_IMG },
    tocBg: { src: DIRTY_IMG },
    colophonBg: { src: DIRTY_IMG },
    chapterBg: { 0: { src: DIRTY_IMG }, 1: { src: DIRTY_IMG } },
    chapterTextColor: { 0: `#111111` },
    plates: [
      { id: `${NEEDLE}-plate`, src: DIRTY_IMG, beforeChapter: 0, size: 'full' },
    ],
    columnPages: [
      { id: `${NEEDLE}-col`, title: NEEDLE, text: NEEDLE, beforeChapter: 1 },
    ],
  });
  st.setCover({
    wrap: { kind: 'image', src: DIRTY_IMG },
    background: { kind: 'image', src: DIRTY_IMG },
    backCover: { kind: 'image', src: DIRTY_IMG },
    titleOverride: NEEDLE,
    blurb: NEEDLE,
    spineTitle: NEEDLE,
  });
  // 取り消しの控えにも前の本が積まれる。**ここも消えていないと戻れてしまう**
  st.setSettings({ fontPt: 10 });
  st.setCover({ spineScale: 1.2 });
}

interface Case {
  name: string;
  run: () => Promise<void> | void;
  /**
   * 入れ替えた直後に「手を入れた」印が**立っているべきか。**
   *
   * 新規作成とサンプルは false(まだ誰も何もしていない。立っていると毎回訊かれる)。
   * **読み込んだ本だけは true**(2026-09-25 見直し S1-4・コミット 91f0cc1)。読み込んだ本は
   * 利用者の作業そのもので、とくに AI 用 .json の往復のあとは画像がこの端末の自動保存にしか
   * 無い。false だと［新規作成］［サンプルを見る］が断りなしにその本を消す
   */
  touchedWant: boolean;
}

const CASES: Case[] = [
  {
    name: '新規作成(startNewBook)',
    run: () => useProject.getState().startNewBook(),
    touchedWant: false,
  },
  {
    name: '続けて作る(replaceProject)',
    run: () =>
      useProject.getState().replaceProject({
        settings: { ...defaultSettings(), bookId: 'other-book' },
        cover: defaultCoverSettings(),
        manuscript: { title: '別の本', author: '', publisher: '', chapters: [] },
        source: null,
      }),
    touchedWant: true,
  },
  {
    name: 'サンプルを見る(loadSample)',
    run: () => useProject.getState().loadSample(),
    touchedWant: false,
  },
];

interface CaseResult {
  name: string;
  /** 印の残っていた場所。空なら消し切れている */
  leftovers: string[];
  /** 取り消しの控えが残っていないか */
  undo: number;
  redo: number;
  /** 入れ替えた直後の「手を入れた」印 */
  touched: boolean;
  /** その印がどうあるべきか(Case の touchedWant)。食い違えば落ちる */
  touchedWant: boolean;
}

/**
 * **消える前に断りを出すか。**
 *
 * 「サンプルを見ているだけ」を「捨ててよい」と読み替えていたのが
 * 2026-08-21 の報告(「アラートがなく、データが展開」)。
 * サンプルに絵を1枚足しただけで訊くようになったかを確かめる
 */
async function askBeforeDiscardCase() {
  const st = () => useProject.getState();
  await st().loadSample();
  const pristine = hasWorkToLose();
  // サンプルに絵を1枚足す(利用者が「追加画像」を入れた状態)
  st().setSettings({
    plates: [{ id: 'probe-plate', src: DIRTY_IMG, beforeChapter: 0, size: 'full' }],
  });
  const afterAddingArt = hasWorkToLose();
  return { 触っていないサンプル: pristine, 絵を足したサンプル: afterAddingArt };
}

/**
 * 画像の埋め直しが**別の本へ流れ込まないか。**
 *
 * 本の id を持たない古い AI 用ファイル(2026-08-19 より前に書き出したもの)を
 * 読み込むと、いま開いている本の絵がそのまま入っていた
 */
function crossBookImageCase() {
  useProject.getState().setSettings({
    plates: [{ id: 'probe-plate', src: DIRTY_IMG, beforeChapter: 0, size: 'full' }],
  });
  // **書き込んだあとに読み直す。** getState() が返すのはそのときの写しなので、
  // 先に取っておくと絵を足す前の状態を見ることになる
  const st = useProject.getState();
  const snapshot = {
    settings: st.settings,
    cover: st.cover,
    manuscript: st.manuscript,
    source: st.source,
  };
  /**
   * 画像を持たない AI 用のファイルを作り、**2026-08-19 より前の書き出し**に見せかける
   * (本の id が無く、書名も別の本)
   */
  const ai = JSON.parse(toProjectFile(snapshot, false)) as Record<string, never>;
  const file = ai as unknown as {
    settings: { bookId?: string };
    manuscript: { title: string };
  };
  delete file.settings.bookId;
  file.manuscript.title = '別の本';
  const { project, warnings } = fromProjectFile(JSON.stringify(ai), snapshot);
  return { leftovers: findNeedle(project), warnings: warnings.length };
}

/**
 * 保存されたサンプルが古いままだと、画面だけが古い本を映す。
 *
 * 署名の行末寄せ(`>>`)を足したとき、**紙は sample.ts を読み直すので直ったが、
 * 画面は IndexedDB に残った古い写しを映していた**(2026-08-21 の報告の正体)。
 * hydrate がサンプルを組み直しているかを、保存を作ってから確かめる。
 */
async function staleSampleCase(): Promise<{ before: boolean; after: boolean }> {
  const st = useProject.getState();
  await st.loadSample();
  const fresh = sampleManuscript();
  // 記法を足す前の写し(署名が行末寄せになっていない)を保存として置く
  const stale = {
    ...fresh,
    chapters: fresh.chapters.map((ch) => ({
      ...ch,
      blocks: ch.blocks.map((b) => {
        if (b.type !== 'p' || b.align !== 'end') return b;
        const { align: _drop, ...rest } = b;
        return rest;
      }),
    })),
  };
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('book-studio', 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise<void>((res, rej) => {
    const t = db.transaction('project', 'readwrite');
    t.objectStore('project').put(
      {
        settings: useProject.getState().settings,
        cover: useProject.getState().cover,
        manuscript: stale,
        source: null,
        isSample: true,
      },
      'current',
    );
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
  const hasAlign = (ms: { chapters: { blocks: { align?: string }[] }[] }) =>
    ms.chapters.some((ch) => ch.blocks.some((b) => b.align === 'end'));
  const before = hasAlign(stale);
  await useProject.getState().hydrate();
  return { before, after: hasAlign(useProject.getState().manuscript) };
}

async function main() {
  const results: CaseResult[] = [];
  for (const c of CASES) {
    makeDirtyBook();
    await c.run();
    // loadSample は絵を非同期で流し込む。**流し込み終わってから数える**
    await new Promise((r) => setTimeout(r, 1500));
    const st = useProject.getState();
    results.push({
      name: c.name,
      leftovers: findNeedle(snapshot()),
      undo: st.past.length,
      redo: st.future.length,
      touched: st.touched,
      touchedWant: c.touchedWant,
    });
  }

  const crossBook = crossBookImageCase();
  const ask = await askBeforeDiscardCase();
  const stale = await staleSampleCase();

  const ok =
    results.every(
      (r) =>
        r.leftovers.length === 0 && r.undo === 0 && r.redo === 0 && r.touched === r.touchedWant,
    ) &&
    crossBook.leftovers.length === 0 &&
    ask.触っていないサンプル === false &&
    ask.絵を足したサンプル === true &&
    stale.before === false &&
    stale.after === true;
  reportProbe(
    {
      ok,
      cases: results,
      別の本への画像の流れ込み: crossBook,
      消える前の断り: ask,
      古い写しのサンプル: stale,
    },
    ok,
  );
}

void main().catch((e) => {
  reportProbe({ ok: false, 落ちた: String(e), stack: (e as Error)?.stack ?? '' }, false);
});
