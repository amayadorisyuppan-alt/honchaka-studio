// ローカルフォルダへの自動バックアップ。
//
// **これが無いとバックアップが存在しない。** 本文も表紙も IndexedDB にしか無いので、
// ブラウザのデータを消すと数週間ぶんの原稿が消え、PC を替えても持ち出せない。
//
// File System Access API を使う。フォルダを1度選ばせると、その**ハンドルを IndexedDB に
// しまっておける**ので、次からは自動で書き込める(構造化複製で保存できる数少ない特殊オブジェクト)。
//
// **Chrome と Edge だけ**。Firefox / Safari には無い。使えない環境では
// 手動の書き出しに案内する(呼び出し側で `isSupported()` を見ること)。
// ブラウザを再起動すると許可が「要求可能」に戻るので、1度だけ押し直してもらう
// (許可の要求は利用者の操作が起点でないと通らない仕様)。

import { openDB, type IDBPDatabase } from 'idb';
import { EDITION } from '../edition';
import { safeFileStem, toProjectFile, type ProjectSnapshot } from './file';

// 版ごとに名前を分ける(src/store/useProject.ts の DB_NAME と同じ理由)
const DB_NAME = 'book-studio-backup' + EDITION.storageSuffix;
const STORE = 'handle';
const KEY = 'folder';

/** 残す世代の数。これを超えた古いものから消す */
const KEEP = 20;

/** File System Access API があるか */
export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore(STORE);
    },
  });
  return dbPromise;
}

/** 型定義がまだ標準に入っていないので、使う分だけ書く */
interface DirHandle {
  name: string;
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
  getFileHandle(name: string, o?: { create: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}
interface FileHandle {
  createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
}

export interface BackupState {
  /** 選んだフォルダの名前。未設定なら null */
  folder: string | null;
  /** いま書き込める状態か(許可が下りているか) */
  ready: boolean;
  /** 最後に書けた時刻 */
  savedAt: Date | null;
  error: string;
}

export const emptyBackup: BackupState = { folder: null, ready: false, savedAt: null, error: '' };

async function stored(): Promise<DirHandle | null> {
  try {
    return ((await (await db()).get(STORE, KEY)) as DirHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

/** 起動時に呼ぶ。前回のフォルダが使えるかどうかだけ調べる(許可は要求しない) */
export async function resume(): Promise<BackupState> {
  const h = await stored();
  if (!h) return emptyBackup;
  try {
    const p = await h.queryPermission({ mode: 'readwrite' });
    return { folder: h.name, ready: p === 'granted', savedAt: null, error: '' };
  } catch {
    return emptyBackup;
  }
}

/** フォルダを選ぶ。すでに選んであるなら、許可を取り直すだけでよい */
export async function choose(): Promise<BackupState> {
  if (!isSupported()) {
    throw new Error('このブラウザには対応していません（Chrome か Edge をお使いください）');
  }
  const picker = (window as unknown as { showDirectoryPicker(o?: object): Promise<DirHandle> })
    .showDirectoryPicker;
  const h = await picker({ mode: 'readwrite' });
  await (await db()).put(STORE, h, KEY);
  return { folder: h.name, ready: true, savedAt: null, error: '' };
}

/** 保存済みのフォルダに対して、許可を requestPermission で取り直す */
export async function reauthorize(): Promise<BackupState> {
  const h = await stored();
  if (!h) return emptyBackup;
  const p = await h.requestPermission({ mode: 'readwrite' });
  return { folder: h.name, ready: p === 'granted', savedAt: null, error: '' };
}

export async function forget(): Promise<BackupState> {
  try {
    await (await db()).delete(STORE, KEY);
  } catch {
    /* 消せなくても実害はない */
  }
  return emptyBackup;
}

/**
 * このアプリが書いた自動保存だけにマッチする名前か。`<書名>_自動保存_YYYYMMDD-HHMM.json`。
 * **これを満たさないファイルには一切触らない** — 選んだフォルダに、利用者の
 * 手動保存や他アプリの .json が同居していても消さないため(2026-09-04 レビュー指摘。
 * 以前は `.json` 全部を間引き対象にしており、無関係なファイルを消していた)。
 *
 * **名前に「_自動保存」を入れて、手動の［保存する］と見分ける。**(2026-09-25 見直し S2-20)
 * 前は手動保存と同じ `<書名>_YYYYMMDD-HHMM.json` だったので、同じフォルダにある手動の控えも
 * 21世代目から間引きで消し(ごみ箱にも入らない)、同じ分に重なると上書きしていた。
 * 前の形の自動保存はもう間引かない(手動保存と見分けられないので、触らないほうに倒す)
 */
const BACKUP_RE = /^(.+)_自動保存_(\d{8}-\d{4})\.json$/;

/** 自動保存のファイル名。手動の［保存する］(projectFileName)とは別の形にする(上の BACKUP_RE) */
function backupFileName(title: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}`;
  return `${safeFileStem(title)}_自動保存_${stamp}.json`;
}

/**
 * 古い世代を間引く。**本(書名)ごとに** KEEP 世代を残す。
 * 名前は `書名_日時` なので、書名でグループ分けしてから日時で新しい順に残す
 * (1つのフォルダで2冊を作っても、片方のバックアップが全滅しないように)。
 */
async function prune(h: DirHandle): Promise<void> {
  const byBook = new Map<string, string[]>();
  for await (const name of h.keys()) {
    const m = BACKUP_RE.exec(name);
    if (!m) continue; // 自分のバックアップ以外(手動保存・他アプリ・_AI用)は対象外
    const book = m[1];
    (byBook.get(book) ?? byBook.set(book, []).get(book)!).push(name);
  }
  for (const names of byBook.values()) {
    names.sort(); // 日時の昇順(古い→新しい)
    for (const name of names.slice(0, Math.max(0, names.length - KEEP))) {
      await h.removeEntry(name).catch(() => undefined);
    }
  }
}

/**
 * 1世代書き込む。**画像込みの完全なもの**を書く(欠けていたら復元にならない)。
 * 許可が下りていなければ何もせず false を返す — ここで許可を要求しないのは、
 * 利用者の操作が起点でない要求はブラウザが弾くため。
 */
export async function writeSnapshot(p: ProjectSnapshot): Promise<boolean> {
  const h = await stored();
  if (!h) return false;
  if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') return false;

  const name = backupFileName(p.manuscript.title);
  const file = await h.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await w.write(toProjectFile(p, true));
  await w.close();
  await prune(h);
  return true;
}
