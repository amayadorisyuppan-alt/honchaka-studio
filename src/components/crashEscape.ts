// エラーの画面(ErrorBoundary)の逃げ道。**控えを取ってから、ブラウザの中の作りかけを空にして、最初の画面に戻る。**
// (2026-10-13 修正リスト 25。運用の見直し 12 の B2)
//
// 読み込んだ .json の悪い値が自動保存に残ると、再読み込みしても同じエラーの画面になり、入口にすら戻れなかった。
// 抜け出すにはサイトのデータを消すしかなく、利用者には無理だった。読み込みの確かめ(project/file.ts の sanitize)で
// 知っている形は外すようにしたが、知らない形で落ちたときのために、画面から抜ける道を1つ残す。
//
// **消す前に必ず控えを取る。** 控えが作れなかったら(例外)、何も消さずに知らせて止める。
// 画面(React)から切り離してあるのは、手順だけを単体の検査で確かめるため(scripts/fileSanitizeTypes.test.ts)

import { rescueProjectFile, safeFileStem } from '../project/file';

export interface CrashEscapeDeps {
  /** 確かめの窓。false なら何もしない */
  confirm: (message: string) => boolean;
  /** 自動保存(IndexedDB の 'current')をそのまま読む。空にするのはこれなので、控えもこれから作る */
  readSaved: () => Promise<unknown>;
  /** 画面が持っている本(自動保存が無いときの控えに使う) */
  current: () => unknown;
  /** 控えを .json で渡す(ダウンロード) */
  download: (text: string, fileName: string) => void;
  /** 自動保存を空にする(書き込みも止める) */
  clearSaved: () => Promise<void>;
  /** 最初の画面を開き直す(ページの読み直し) */
  reload: () => void;
  alert: (message: string) => void;
  /** ダウンロードが始まるのを待つ(すぐ読み直すと、ダウンロードが取り消されることがある) */
  wait: (ms: number) => Promise<void>;
}

export type CrashEscapeResult = 'cancelled' | 'backup-failed' | 'clear-failed' | 'done';

// 画面に出す文(下書き。2026-10-13)
export const CRASH_ESCAPE_CONFIRM =
  'いまの本を控え（.json）として保存してから、ブラウザの中の作りかけを消して、最初の画面に戻ります。\n' +
  '控えは［読み込む］で開き直せます。よろしいですか？';
export const CRASH_ESCAPE_BACKUP_FAILED =
  '控えを保存できなかったので、何も消していません。お手数ですが、この画面のまま開発元にお知らせください。\n';
export const CRASH_ESCAPE_CLEAR_FAILED =
  '控えは保存できましたが、ブラウザの中の作りかけを消せませんでした。お手数ですが、この画面のまま開発元にお知らせください。\n';

const hasBook = (v: unknown): boolean =>
  !!v && typeof v === 'object' && 'settings' in v && !!(v as { settings?: unknown }).settings;

/** 控えのファイル名。書名が読めなくても落ちない */
function rescueName(snap: unknown): string {
  let title = '';
  try {
    const t = (snap as { manuscript?: { title?: unknown } }).manuscript?.title;
    title = typeof t === 'string' ? t : '';
  } catch {
    /* 書名が無いときは「無題」 */
  }
  return `${safeFileStem(title)}_復旧.json`;
}

/** ①控えを取る ②自動保存を空にする ③最初の画面を開き直す。①が失敗したら②③をしない */
export async function backupThenReset(d: CrashEscapeDeps): Promise<CrashEscapeResult> {
  if (!d.confirm(CRASH_ESCAPE_CONFIRM)) return 'cancelled';
  try {
    const saved = await d.readSaved();
    const snap = hasBook(saved) ? saved : d.current();
    d.download(rescueProjectFile(snap), rescueName(snap));
  } catch (e) {
    d.alert(CRASH_ESCAPE_BACKUP_FAILED + String(e));
    return 'backup-failed';
  }
  try {
    await d.clearSaved();
  } catch (e) {
    d.alert(CRASH_ESCAPE_CLEAR_FAILED + String(e));
    return 'clear-failed';
  }
  await d.wait(1500);
  d.reload();
  return 'done';
}
