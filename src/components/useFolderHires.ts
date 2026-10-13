// 画像のフォルダにある、同梱のプリセットの高解像度版を、アプリ全体で引けるようにする。
// (2026-10-12 改修の希望 2 の続き・修正リスト 21 の続き。10/12 夜ユーザー「プリセットも気配りできてていい」)
//
// 細かさの知らせが同梱のプリセットに出ているとき(enabled)だけ、前回のフォルダを数える。
// 数えるのはフォルダの中の名前だけ(画像は読まない)。ファイル名(拡張子を除く)が同梱のプリセットの id と
// 同じ画像を、その高解像度版として覚える。許可が切れている(ブラウザを開き直した直後など)・フォルダが無い・
// 高解像度版が無いときは何も覚えない = 今までどおり BOOTH の案内になる。
// 許可の取り直しは利用者の操作が要るので、ここからは要求しない(画像を選ぶ画面の［フォルダを開き直す］)。

import { useEffect, useMemo, useRef, useState } from 'react';
import { optimizeImageDataUri } from '../images/optimize';
import { readImageFileAsDataUri } from '../images/imageFile';
import { scanImageFolder, type FolderImage } from '../images/folderScan';
import { bundledPresetIds } from '../covers/presetIds';
import { onImageFolderChange, resumeImageFolder } from '../project/imageFolder';
import type { FolderHires } from './ResolutionNote';

// フォルダの中の高解像度版も、JPEG・PNG かを頭の数バイトで確かめてから入れる(2026-10-13 修正リスト 27)
const fileToDataUri = readImageFileAsDataUri;

const depthOf = (im: FolderImage) => im.path.split('/').length;

/** 同じ id の画像が複数あるときは、浅い所(直下に近い所)のものを使う */
export function hiresByPresetId(images: readonly FolderImage[]): Map<string, FolderImage> {
  const out = new Map<string, FolderImage>();
  for (const im of images) {
    if (!im.presetId) continue;
    const cur = out.get(im.presetId);
    if (!cur || depthOf(im) < depthOf(cur)) out.set(im.presetId, im);
  }
  return out;
}

function sameFiles(a: ReadonlyMap<string, FolderImage>, b: ReadonlyMap<string, FolderImage>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k)?.path !== v.path) return false;
  return true;
}

/**
 * @param enabled 同梱のプリセットに細かさの知らせが出ているか。出ていないときは、フォルダに触らない
 */
export function useFolderHires(enabled: boolean): FolderHires {
  const [files, setFiles] = useState<ReadonlyMap<string, FolderImage>>(() => new Map());
  // 差し替えた絵(新しい src)。差し替えてもまだ足りないときに、同じ案内を繰り返さないため(この画面を開いているあいだだけ)
  const swapped = useRef(new Set<string>());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let seq = 0;
    const scan = async () => {
      const my = ++seq;
      let next = new Map<string, FolderImage>();
      try {
        const r = await resumeImageFolder();
        if (r.handle) next = hiresByPresetId((await scanImageFolder(r.handle, bundledPresetIds())).images);
      } catch {
        next = new Map(); // 読めなければ「無い」として BOOTH の案内に戻る
      }
      if (alive && my === seq) setFiles((prev) => (sameFiles(prev, next) ? prev : next));
    };
    void scan();
    // フォルダを決め直した・許可を取り直したとき、ブラウザに戻ってきたとき(別の窓でファイルを足したかもしれない)に数え直す
    const off = onImageFolderChange(() => void scan());
    const onFocus = () => void scan();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      off();
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);

  return useMemo<FolderHires>(
    () => ({
      has: (presetId) => files.has(presetId),
      load: async (presetId, maxSide) => {
        const im = files.get(presetId);
        if (!im) throw new Error('フォルダに高解像度版がありません');
        const file = await im.handle.getFile();
        return optimizeImageDataUri(await fileToDataUri(file), maxSide);
      },
      isSwapped: (src) => swapped.current.has(src),
      markSwapped: (src) => {
        swapped.current.add(src);
        setVersion((v) => v + 1);
      },
    }),
    // version: 差し替え済みの印が増えたら、引き直させる
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, version],
  );
}
