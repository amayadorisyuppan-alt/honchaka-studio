// 画像のフォルダの中身を数える。(2026-10-12 改修の希望 2「自分の画像のフォルダを、画像を選ぶ画面に並べる」)
//
// **ここはブラウザの部品(IndexedDB・canvas)に触らない。** フォルダのハンドルは、使う分だけを
// 下の DirLike / FileLike の形で受け取るので、単体の検査(scripts/imageFolder.test.ts)では偽物で回せる。
// 本物は File System Access API の FileSystemDirectoryHandle(Chrome・Edge)と、試すときの OPFS。
//
// 決まり(10/12 夜ユーザー):
// - 直下の画像は見出しなし。中のフォルダは4段まで見て、それを小見出しにする(「旅 / 海」のように)。
//   **2段では足りない**: BOOTH の無料の高解像度版の zip を Windows の［すべて展開］で開くと「表紙プリセット高解像度版\表紙プリセット高解像度版\実用書_…\」と
//   フォルダが2重にでき、それを自分の画像のフォルダに入れると3段目に絵が来る(2026-10-12 司令官が zip の形から気づいた)
// - 拾うのは jpg・jpeg・png だけ(2026-10-13 ユーザー決定「画像の受け入れは入口で制限をかけた方がいい。JPEG と PNG」。前は webp も拾っていた)
// - ファイル名(拡張子を除く)が同梱のプリセットの id と同じなら、その高解像度版として扱う
// - 多すぎる(既定 2000 枚)ときは、そこで数えるのをやめて知らせる(画面が固まらないように)

/** フォルダのハンドルのうち、ここで使う分 */
export interface DirLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirLike | FileLike>;
}
/** ファイルのハンドルのうち、ここで使う分。getFile は中身を読まない(大きさと更新日時の写しを返すだけ) */
export interface FileLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

/** 並べる1枚 */
export interface FolderImage {
  /** フォルダの中の場所(`旅/海/a.jpg`)。サムネイルの覚えの鍵と、React の key に使う */
  path: string;
  /** ファイル名(`a.jpg`) */
  name: string;
  /** 小見出し。直下なら ''。中のフォルダなら `旅` や `旅 / 海` */
  group: string;
  /** 同梱のプリセットの高解像度版なら、その id */
  presetId?: string;
  handle: FileLike;
}

export interface FolderScan {
  /** 小見出しの順(直下 '' が先頭、あとは名前の順)に並べた画像 */
  images: FolderImage[];
  /** 上限で数えるのをやめたか */
  truncated: boolean;
}

/** 数える上限の既定。これを超えたら止めて知らせる */
export const FOLDER_IMAGE_LIMIT = 2000;
/** 中のフォルダを何段まで見るか(直下を 0 段目として)。BOOTH の zip を展開して入れると3段目に絵が来るので、余裕を見て4段 */
export const FOLDER_MAX_DEPTH = 4;

/** 拾う画像か。jpg・jpeg・png(大文字の拡張子も)。拡張子は名前だけの話で、中身は取り込むとき(images/imageFile.ts)に確かめる */
export function isFolderImageName(name: string): boolean {
  return /\.(jpe?g|png)$/i.test(name) && !name.startsWith('.');
}

/** 拡張子を除いた名前 */
export function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/**
 * ファイル名が同梱のプリセットの id と同じなら、その id を返す。
 * 大文字で書かれたファイル名(`BIZ-BUSINESS-01.JPG`)も同じものとして見る
 */
export function presetIdFromName(name: string, ids: ReadonlySet<string>): string | undefined {
  const stem = stemOf(name);
  if (ids.has(stem)) return stem;
  const lower = stem.toLowerCase();
  return ids.has(lower) ? lower : undefined;
}

/** 名前の比べ方。数字は数として(`2.jpg` が `10.jpg` より前) */
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

/**
 * フォルダの中の画像を数える。中のフォルダは maxDepth 段まで。
 * 隠しフォルダ(`.` で始まる)は見ない。読めない中のフォルダは飛ばす(全体は止めない)
 */
export async function scanImageFolder(
  root: DirLike,
  ids: ReadonlySet<string>,
  opts: { limit?: number; maxDepth?: number } = {},
): Promise<FolderScan> {
  const limit = opts.limit ?? FOLDER_IMAGE_LIMIT;
  const maxDepth = opts.maxDepth ?? FOLDER_MAX_DEPTH;
  const images: FolderImage[] = [];
  let truncated = false;

  async function walk(dir: DirLike, parts: string[]): Promise<void> {
    const files: FileLike[] = [];
    const dirs: DirLike[] = [];
    try {
      for await (const h of dir.values()) {
        if (h.kind === 'file') {
          if (isFolderImageName(h.name)) files.push(h);
        } else if (parts.length < maxDepth && !h.name.startsWith('.')) {
          dirs.push(h);
        }
      }
    } catch {
      return; // 読めないフォルダは飛ばす
    }
    files.sort((a, b) => compareNames(a.name, b.name));
    for (const f of files) {
      if (images.length >= limit) {
        truncated = true;
        return;
      }
      images.push({
        path: [...parts, f.name].join('/'),
        name: f.name,
        group: parts.join(' / '),
        presetId: presetIdFromName(f.name, ids),
        handle: f,
      });
    }
    dirs.sort((a, b) => compareNames(a.name, b.name));
    for (const d of dirs) {
      if (truncated) return;
      await walk(d, [...parts, d.name]);
    }
  }

  await walk(root, []);
  return { images, truncated };
}

/** 小見出しごとにまとめる(並びは scanImageFolder の順のまま。直下 '' が先頭) */
export function groupFolderImages(images: FolderImage[]): { group: string; images: FolderImage[] }[] {
  const out: { group: string; images: FolderImage[] }[] = [];
  const at = new Map<string, number>();
  for (const im of images) {
    let i = at.get(im.group);
    if (i === undefined) {
      i = out.length;
      at.set(im.group, i);
      out.push({ group: im.group, images: [] });
    }
    out[i].images.push(im);
  }
  return out;
}

/**
 * サムネイルの覚えの鍵。**フォルダの名前＋中の場所＋大きさ＋更新日時。**
 * 同じ場所のファイルが描き直されれば大きさか更新日時が変わるので、作り直しになる
 */
export function thumbKey(folder: string, path: string, size: number, lastModified: number): string {
  return `${folder}\u0000${path}\u0000${size}\u0000${lastModified}`;
}
