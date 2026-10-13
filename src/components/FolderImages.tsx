// 画像を選ぶ画面(PresetScreen)の、プリセットの一覧の上に出す「アップロード」の段。(2026-10-12 改修の希望 2)
//
// 利用者が決めた画像のフォルダ(project/imageFolder.ts)の画像を、サムネイルで並べる。押すとその原画を読んで、
// 呼び出し側の取り込み(BackgroundPicker / CoverEditor の今の取り込みと同じ道。optimizeImageDataUri)へ渡す。
// 本の保存ファイルには今までどおり画像が入る(別のパソコンでも開ける)。
//
// - Chrome・Edge だけ。ほかのブラウザでは一言だけ出す(今までのファイル選び・プリセットはそのまま使える)
// - サムネイルは1枚ずつ作って IndexedDB に覚える(画面が固まらないように、1枚ごとに一息入れる)
// - ファイル名が同梱のプリセットの id と同じ画像は、その高解像度版(presetId を付けて渡す)

import { useEffect, useRef, useState } from 'react';
import {
  chooseImageFolder,
  getThumb,
  isSupported,
  onImageFolderChange,
  pruneThumbs,
  putThumb,
  reauthorizeImageFolder,
  resumeImageFolder,
  type ImageDirHandle,
  type ImageFolderState,
  emptyImageFolder,
} from '../project/imageFolder';
import {
  FOLDER_IMAGE_LIMIT,
  groupFolderImages,
  scanImageFolder,
  thumbKey,
  type FolderImage,
  type FolderScan,
} from '../images/folderScan';
import { makeThumb } from '../images/thumbs';
import { bundledPresetIds } from '../covers/presetIds';

/** 画面に覚えた一覧を出し直す間隔(ms)。1枚ごとに描き直すと、2000 枚で画面が重くなる */
const FLUSH_MS = 250;

interface Props {
  /** 読み込み中(呼び出し側の取り込みが動いている)。押せなくする */
  busy: boolean;
  /** 押された画像の原画。presetId は同梱のプリセットの高解像度版のときだけ */
  onPick: (file: File, presetId: string | undefined) => Promise<void> | void;
}

export function FolderImages({ busy, onPick }: Props) {
  const supported = isSupported();
  const [state, setState] = useState<ImageFolderState>(emptyImageFolder);
  const [handle, setHandle] = useState<ImageDirHandle | null>(null);
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [made, setMade] = useState(0);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState('');
  /** 読み直しのたびに増やす。古い読み込みのループは、これが変わったら止まる */
  const run = useRef(0);
  /** 作った object URL。読み直し・閉じるときに返す */
  const urls = useRef<string[]>([]);

  function releaseUrls() {
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current = [];
  }

  async function load(h: ImageDirHandle) {
    const my = ++run.current;
    releaseUrls();
    setError('');
    setThumbs({});
    setMade(0);
    setScan(null);
    setScanning(true);
    let result: FolderScan;
    try {
      result = await scanImageFolder(h, bundledPresetIds());
    } catch {
      if (my === run.current) {
        setScanning(false);
        setError('フォルダを読み込めませんでした。［画像フォルダを選ぶ］から選び直してください');
      }
      return;
    }
    if (my !== run.current) return;
    setScan(result);
    setScanning(false);

    // サムネイルを1枚ずつ。覚えてあればそれを、無ければ作って覚える
    const keys = new Set<string>();
    let pending: Record<string, string> = {};
    let count = 0;
    let last = performance.now();
    const flush = () => {
      const add = pending;
      pending = {};
      setThumbs((t) => ({ ...t, ...add }));
      setMade(count);
      last = performance.now();
    };
    for (const im of result.images) {
      if (my !== run.current) return;
      try {
        const file = await im.handle.getFile();
        const key = thumbKey(h.name, im.path, file.size, file.lastModified);
        keys.add(key);
        let blob = await getThumb(key);
        if (!blob) {
          blob = await makeThumb(file);
          await putThumb(key, blob);
          // 作ったときだけ一息入れる(覚えてあったものは軽い)
          await new Promise((r) => setTimeout(r, 0));
        }
        if (my !== run.current) return;
        const url = URL.createObjectURL(blob);
        urls.current.push(url);
        pending[im.path] = url;
      } catch {
        /* 読めない画像はサムネイルなし(名前だけの箱)のまま */
      }
      count++;
      if (performance.now() - last > FLUSH_MS) flush();
    }
    if (my !== run.current) return;
    flush();
    // 数えるのを上限で止めたときは、数えていない分の覚えを消してしまうので捨てない
    if (!result.truncated) void pruneThumbs(keys);
  }

  async function resume() {
    const r = await resumeImageFolder();
    setState(r.state);
    setHandle(r.handle);
    if (r.handle) void load(r.handle);
    else {
      run.current++;
      releaseUrls();
      setScan(null);
      setThumbs({});
    }
  }

  useEffect(() => {
    if (!supported) return;
    void resume();
    const off = onImageFolderChange(() => void resume());
    return () => {
      off();
      run.current++;
      releaseUrls();
    };
    // 開いたときに1度だけ。フォルダが変わったら onImageFolderChange で読み直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  async function choose() {
    setError('');
    try {
      // 読み直しは、選んだあとの知らせ(onImageFolderChange → resume)が走らせる
      const r = await chooseImageFolder();
      setState(r.state);
      setHandle(r.handle);
    } catch (e) {
      // 窓を閉じただけ(AbortError)なら何も言わない
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function reopen() {
    setError('');
    try {
      const r = await reauthorizeImageFolder();
      setState(r.state);
      setHandle(r.handle);
      // 読み直しは、許可が下りたあとの知らせ(onImageFolderChange → resume)が走らせる。ここでも読むと、フォルダを2度数える
      if (!r.handle) setError('フォルダを読む許可が得られませんでした');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function pick(im: FolderImage) {
    setError('');
    setPicking(im.path);
    try {
      const file = await im.handle.getFile();
      await onPick(file, im.presetId);
    } catch {
      setError(`「${im.name}」を読み込めませんでした。［読み直す］を押してから、もう一度選んでください`);
    } finally {
      setPicking(null);
    }
  }

  const locked = busy || picking !== null;

  return (
    <div className="folder-imgs">
      <h4 className="folder-title">アップロード</h4>

      {!supported ? (
        <p className="hint">この機能は Chrome か Edge で使えます</p>
      ) : (
        <>
          <div className="folder-bar">
            {state.folder && !state.ready ? (
              <button className="ghost" disabled={locked} onClick={() => void reopen()}>
                フォルダを開き直す
              </button>
            ) : (
              <button className="ghost" disabled={locked} onClick={() => void choose()}>
                画像フォルダを選ぶ
              </button>
            )}
            {handle && (
              <button className="ghost" disabled={locked || scanning} onClick={() => void load(handle)}>
                読み直す
              </button>
            )}
            {state.folder && <span className="folder-name" title={state.folder}>{state.folder}</span>}
          </div>

          {!state.folder && (
            <p className="hint">画像を入れたフォルダを選ぶと、ここに並びます。押すと本に入ります（画像はどこにも送りません）</p>
          )}
          {state.folder && !state.ready && (
            <p className="hint">ブラウザを開き直したため、もう一度フォルダを読む許可を出してください</p>
          )}
          {scanning && <p className="hint">フォルダを読み込んでいます…</p>}
          {scan && scan.images.length === 0 && (
            <p className="hint">このフォルダには画像がありません（jpg・png が使えます）</p>
          )}
          {scan && scan.truncated && (
            <p className="warn">
              画像が多いので、最初の {FOLDER_IMAGE_LIMIT} 枚だけを並べています。フォルダを分けると残りも見られます
            </p>
          )}
          {scan && scan.images.length > 0 && made < scan.images.length && (
            <p className="hint">
              一覧の画像を作っています（{made} / {scan.images.length}）
            </p>
          )}
          {picking && <p className="hint">本に入れています…</p>}

          {scan &&
            groupFolderImages(scan.images).map(({ group, images }) => (
              <div key={group || '.'} className="preset-theme">
                {group && <p className="hint">{group}</p>}
                <div className="preset-grid">
                  {images.map((im) => (
                    <button
                      key={im.path}
                      className={im.presetId ? 'preset-item folder-item hires' : 'preset-item folder-item'}
                      title={im.presetId ? `${im.name}（アプリに入っている画像の高解像度版）` : im.name}
                      disabled={locked}
                      onClick={() => void pick(im)}
                    >
                      {thumbs[im.path] ? (
                        <img src={thumbs[im.path]} alt={im.name} />
                      ) : (
                        <span className="folder-noimg">{im.name}</span>
                      )}
                      {/* 同梱のプリセットの高解像度版は、押す前に分かるように印を付ける(入れると AI 申告に数える) */}
                      {im.presetId && <span className="folder-badge">高解像度版</span>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
