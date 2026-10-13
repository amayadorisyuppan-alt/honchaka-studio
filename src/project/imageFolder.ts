// 自分の画像のフォルダ。(2026-10-12 改修の希望 2。10/12 夜ユーザーと決定)
//
// 画像を選ぶ画面(components/PresetScreen.tsx。表紙・背景・挿絵で共通)の、プリセットの一覧の上に
// 「アップロード」の見出しで、このフォルダの画像のサムネイルを並べる。押すとその原画を読んで入れる。
//
// **自動バックアップのフォルダ(project/backup.ts)とは別に持つ。** 仕組みは同じ:
// - File System Access API の showDirectoryPicker。**Chrome と Edge だけ**(呼び出し側で isSupported() を見る)
// - 選んだフォルダのハンドルを IndexedDB にしまう(構造化複製で保存できる)。版ごとに置き場所の名前を分ける
// - ブラウザを開き直すと許可が「要求可能」に戻るので、［フォルダを開き直す］を1度押してもらう
//   (許可の要求は利用者の操作が起点でないと通らない)
// 読むだけなので、許可は 'read' で取る(バックアップは書くので 'readwrite')。
//
// サムネイルも同じ IndexedDB に覚える(鍵は images/folderScan.ts の thumbKey。場所＋大きさ＋更新日時)。

import { openDB, type IDBPDatabase } from 'idb';
import { EDITION } from '../edition';
import type { DirLike } from '../images/folderScan';

// 版ごとに名前を分ける(src/store/useProject.ts の DB_NAME・backup.ts と同じ理由)
const DB_NAME = 'book-studio-imgfolder' + EDITION.storageSuffix;
const HANDLE_STORE = 'handle';
const THUMB_STORE = 'thumbs';
const KEY = 'folder';

/** File System Access API があるか(Chrome・Edge) */
export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore(HANDLE_STORE);
      d.createObjectStore(THUMB_STORE);
    },
  });
  return dbPromise;
}

/** 型定義がまだ標準に入っていないので、使う分だけ書く */
export interface ImageDirHandle extends DirLike {
  queryPermission?(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' }): Promise<PermissionState>;
}

export interface ImageFolderState {
  /** 選んだフォルダの名前。未設定なら null */
  folder: string | null;
  /** いま読める状態か(許可が下りているか) */
  ready: boolean;
}

export const emptyImageFolder: ImageFolderState = { folder: null, ready: false };

async function stored(): Promise<ImageDirHandle | null> {
  try {
    return ((await (await db()).get(HANDLE_STORE, KEY)) as ImageDirHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

/** 許可の状態。queryPermission を持たないハンドル(試すときの偽物など)は、読めるものとして扱う */
async function permitted(h: ImageDirHandle): Promise<boolean> {
  if (!h.queryPermission) return true;
  try {
    return (await h.queryPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/** 画面を開いたときに呼ぶ。前回のフォルダが読めるかどうかだけ調べる(許可は要求しない) */
export async function resumeImageFolder(): Promise<{ state: ImageFolderState; handle: ImageDirHandle | null }> {
  const h = await stored();
  if (!h) return { state: emptyImageFolder, handle: null };
  const ready = await permitted(h);
  return { state: { folder: h.name, ready }, handle: ready ? h : null };
}

/** フォルダを選ぶ(利用者の操作から呼ぶ) */
export async function chooseImageFolder(): Promise<{ state: ImageFolderState; handle: ImageDirHandle }> {
  if (!isSupported()) throw new Error('このブラウザでは使えません（Chrome か Edge をお使いください）');
  const picker = (window as unknown as { showDirectoryPicker(o?: object): Promise<ImageDirHandle> })
    .showDirectoryPicker;
  // id は窓の開き始めの場所を覚えさせるための名前(自動バックアップの窓と分ける)
  const h = await picker({ mode: 'read', id: 'studio-images' });
  await (await db()).put(HANDLE_STORE, h, KEY);
  notify();
  return { state: { folder: h.name, ready: true }, handle: h };
}

/** 保存済みのフォルダの許可を取り直す(利用者の操作から呼ぶ) */
export async function reauthorizeImageFolder(): Promise<{ state: ImageFolderState; handle: ImageDirHandle | null }> {
  const h = await stored();
  if (!h) return { state: emptyImageFolder, handle: null };
  const p = h.requestPermission ? await h.requestPermission({ mode: 'read' }) : 'granted';
  const ready = p === 'granted';
  // 許可が下りたら知らせる(細かさの知らせの［高解像度版に差し替える］が、フォルダを数え直せるように。useFolderHires)
  if (ready) notify();
  return { state: { folder: h.name, ready }, handle: ready ? h : null };
}

/** サムネイルの覚えを引く。無ければ null */
export async function getThumb(key: string): Promise<Blob | null> {
  try {
    return ((await (await db()).get(THUMB_STORE, key)) as Blob | undefined) ?? null;
  } catch {
    return null;
  }
}

/** サムネイルを覚える。書けなくても一覧は出せるので、失敗は黙って捨てる */
export async function putThumb(key: string, blob: Blob): Promise<void> {
  try {
    await (await db()).put(THUMB_STORE, blob, key);
  } catch {
    /* 覚えられなくても次に作り直すだけ */
  }
}

/**
 * いまのフォルダに無くなったサムネイルを捨てる(keep に無い鍵)。
 * ファイルを描き直すたびに鍵が変わるので、放っておくと古いものが溜まる。
 * 数えるのを上限で止めたときは呼ばない(数えていない分を消してしまう)
 */
export async function pruneThumbs(keep: ReadonlySet<string>): Promise<void> {
  try {
    const d = await db();
    const keys = (await d.getAllKeys(THUMB_STORE)) as string[];
    const tx = d.transaction(THUMB_STORE, 'readwrite');
    for (const k of keys) if (!keep.has(k)) void tx.store.delete(k);
    await tx.done;
  } catch {
    /* 捨てられなくても実害はない */
  }
}

// フォルダが変わったことを、開いている画面へ知らせる(試す口から差し込んだときに、開き直さず読み直せるように)
const listeners = new Set<() => void>();
export function onImageFolderChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

/**
 * **試すための口(開発のときだけ)。** フォルダを選ぶ窓は自動では押せないので、
 * OPFS(navigator.storage.getDirectory())などのハンドルを差し込めるようにする。
 * `import.meta.env.DEV` が false の組み立て(本番)では、この塊ごと消える。
 *
 *   const root = await navigator.storage.getDirectory();
 *   await window.__setImageFolderForTest(root);
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __setImageFolderForTest?: (h: ImageDirHandle) => Promise<void> }).__setImageFolderForTest =
    async (h: ImageDirHandle) => {
      await (await db()).put(HANDLE_STORE, h, KEY);
      notify();
    };
}
