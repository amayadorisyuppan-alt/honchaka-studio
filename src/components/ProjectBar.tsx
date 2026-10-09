// トップバーのプロジェクト操作。バックアップと、AI との受け渡し。
//
// 工程レールには載せない。**本を作る手順ではなく、本そのものの出し入れ**だから。
// 04 書き出しに置くと「入稿するファイル」と混ざる。

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  choose,
  emptyBackup,
  forget,
  isSupported,
  reauthorize,
  resume,
  writeSnapshot,
  type BackupState,
} from '../project/backup';
import { fromProjectFile, projectFileName, toProjectFile, type ProjectSnapshot } from '../project/file';
import { downloadBlob } from '../exporters/download';
import { useProject } from '../store/useProject';

/**
 * 変更が落ち着いてから書く。画像込みだと1世代が数MBになるので、打鍵のたびには書かない。
 * これを短くするより、**中身が変わっていないときに書かない**ほうが効く(下記 sameAsWritten)
 */
const DEBOUNCE_MS = 60_000;

interface Props {
  snapshot: ProjectSnapshot;
  /**
   * サンプルを表示しているあいだは true。**自動バックアップを書かない。**
   *
   * サンプルは作品ではなく見本なので、控える意味がない。それでも書くと、
   * 起動して眺めただけの人のフォルダに**サンプルの控えが世代20まで溜まる**。
   * 絵の入ったサンプルは1件が数MBあるので無視できない(2026-08-17 ユーザー指摘)。
   * IndexedDB への自動保存は止めない(触った状態が残らないと不便なため)
   */
  sample: boolean;
  /**
   * ［保存する］を目立たせる。入口画面の「新規作成」で、この操作を指して
   * 説明しているあいだだけ立てる。指す先が光っていないと、どのボタンの話か伝わらない
   */
  highlightSave?: boolean;
  onLoad: (p: ProjectSnapshot) => void;
  /**
   * ［読み込む］が失敗したときの理由。**入口画面ではトップバーが隠れていて、下のフラッシュが見えない**ので、
   * 入口のカードの下にも出せるよう App へ渡す(2026-10-09 全体確認: 壊れた .json を選んでも何も起きないように見えた)
   */
  onLoadError?: (message: string) => void;
}

/**
 * 入口画面からも読み込みを始められるようにするための口。
 *
 * 2回目以降の利用者にとって最初の一手は**続きを開くこと**なのに、その導線が
 * トップバーにしか無かった。あそこは画面の枠に見えるので、工程の中には無いのと同じ。
 * 読み込みの処理(警告の出し方・フラッシュ)はここに1つだけ持ち、押す場所を増やす。
 */
export interface ProjectBarHandle {
  openProjectFile(): void;
  /**
   * 画像を落とした軽い JSON を書き出す。
   * **ボタンは「AI に手直ししてもらう」工程にある。** ここに置いていたころは
   * ボタン1つぶんの幅しかなく、何が起きるのか説明できなかった(2026-08-19)
   */
  exportForAi(): void;
}

/** 押した結果を出す秒数。成功は消える、失敗は次の操作まで残す */
const FLASH_MS = 10_000;

export const ProjectBar = forwardRef<ProjectBarHandle, Props>(function ProjectBar(
  { snapshot, sample, highlightSave = false, onLoad, onLoadError },
  ref,
) {
  const [backup, setBackup] = useState<BackupState>(emptyBackup);
  const [busy, setBusy] = useState(false);
  // この端末への自動保存(IndexedDB)が失敗しているか。store が失敗のたびに立てる
  const autosaveError = useProject((s) => s.autosaveError);
  /** 前回の保存を開いたときに直したもの。一度だけ知らせる(store の restoreFixes) */
  const restoreFixes = useProject((s) => s.restoreFixes);
  /**
   * 押した結果を**このバーの中に**出す。
   * 左パネルの通知に流していたが、押した場所(右上)と出る場所(左下)が離れていて
   * 気づけなかった。表紙ステップではパネルごと隠れるので、そもそも出なかった
   * (2026-08-17 ユーザー報告)
   */
  const [flash, setFlash] = useState<{ text: string; bad: boolean; detail?: string[]; failed?: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!restoreFixes.length) return;
    setFlash({ text: '前回の保存を開くとき、読めないところを直しました', bad: true, detail: restoreFixes });
    useProject.setState({ restoreFixes: [] });
  }, [restoreFixes]);
  /**
   * 詳細を開いているか。**中身はここで見せる。**
   * 以前は左パネル(工程の中)へ流していたので、読み込んだ瞬間に開いていた工程
   * ——たとえば「AI に手直ししてもらう」——の説明文の中に赤い警告が挟まった
   * (2026-08-19 ユーザー報告)。読み込みの結果は、読み込んだ場所で見せる
   */
  const [detailOpen, setDetailOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // 入口画面の［続けて作る］からも同じファイル選択を開けるようにする(処理はここに1つだけ持つ)
  useImperativeHandle(
    ref,
    () => ({ openProjectFile: () => fileRef.current?.click(), exportForAi }),
    [],
  );
  // 書き込みは最新の内容で行いたいが、内容が変わるたびにタイマーを張り直したくない
  const latest = useRef(snapshot);
  latest.current = snapshot;

  useEffect(() => {
    void resume().then(setBackup);
  }, []);

  /**
   * 最後に書いた中身。**参照で比べる。**
   * ストアは変更のたびにオブジェクトを作り直すので、参照が同じなら中身も同じ。
   * 9MB を JSON 文字列にして毎回比べるのは高くつく
   */
  const written = useRef<ProjectSnapshot | null>(null);
  const sameAsWritten = (p: ProjectSnapshot) => {
    const w = written.current;
    return (
      !!w &&
      w.settings === p.settings &&
      w.cover === p.cover &&
      w.manuscript === p.manuscript &&
      w.source === p.source
    );
  };

  // 内容が変わったら、落ち着いた頃に1世代書く。
  // **変わっていなければタイマーも張らない。** これが無いと、App が再描画されるたびに
  // 「変わった」と見なして書き続け、同じ中身の9MBが1分おきに増えていく(2026-08-17 に実際に起きた)
  useEffect(() => {
    if (!backup.ready || sample || sameAsWritten(snapshot)) return;
    const t = setTimeout(() => {
      const target = latest.current;
      void writeSnapshot(target)
        .then((ok) => {
          if (!ok) {
            // **許可が外れた(false)ときも黙って止めない。**(2026-09-04 レビュー指摘)
            // ready を落とすと「自動保存を再開する」ボタンが出て、押し直しへ導ける。
            // これが無いと「HH:MM に保存」の古い表示が残ったまま何週間も止まりうる
            setBackup((b) => (b.ready ? { ...b, ready: false } : b));
            return;
          }
          written.current = target;
          setBackup((b) => ({ ...b, savedAt: new Date(), error: '' }));
        })
        .catch((e) => setBackup((b) => ({ ...b, error: e instanceof Error ? e.message : String(e) })));
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [snapshot, sample, backup.ready]);

  // 成功は放っておくと消える。失敗は次の操作まで残す
  useEffect(() => {
    if (!flash || flash.bad) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setFlash(null);
    try {
      await fn();
    } catch (e) {
      // フォルダ選択の取り消しは失敗ではない
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setFlash({
        text: `${label}に失敗しました`,
        bad: true,
        detail: [e instanceof Error ? e.message : String(e)],
        failed: true,
      });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 画像込みの完全な控えをダウンロードする。
   *
   * 自動バックアップ(File System Access API)は Chrome / Edge でしか動かない。
   * Firefox / Safari の利用者には**これが唯一の保存手段**になる。
   * `toProjectFile` の第2引数を true にするだけで、自動バックアップと同じ完全な中身が作れる
   */
  function saveProject() {
    setFlash(null);
    // **唯一の保存手段(Firefox/Safari)なので、失敗を黙らせない。**(2026-09-04 レビュー低#9)
    // 巨大な本では JSON.stringify が RangeError を投げうる。そのとき無反応だと、
    // 利用者は保存できたと思い込む
    try {
      const text = toProjectFile(snapshot, true);
      downloadBlob(
        new Blob([text], { type: 'application/json' }),
        projectFileName(snapshot.manuscript.title, true),
      );
      setFlash({ text: '保存しました。［読み込む］で開き直せます', bad: false });
    } catch (e) {
      setFlash({
        text: '保存に失敗しました',
        bad: true,
        detail: [
          e instanceof Error ? e.message : String(e),
          '本が大きすぎる可能性があります。画像を減らすか、［AI に手直ししてもらう］の軽い書き出しをお試しください。',
        ],
      });
    }
  }

  function exportForAi() {
    setFlash(null);
    /**
     * **`snapshot` ではなく `latest.current` を読む。**(2026-09-14 ユーザー報告
     * 「本文に入れたのに、AI用に書き出すとサンプルの文章が落ちてくる」)
     *
     * この関数は下の useImperativeHandle が**依存配列を空にして**外へ渡している。
     * そのため ref が持っているのは**最初の描画のときの exportForAi** で、
     * その中の `snapshot` は**起動直後の本＝サンプル**のまま固まっている。
     * AI タブの［AI用に書き出す］はこの ref 越しに呼ぶので、いつまでもサンプルが出ていた。
     * (バーの中のボタンは描画のたびに新しい関数を見るので正しく出る。
     *  ProjectBar が作り直される場面——バックアップ先を選ぶと key が変わる——を
     *  通った本だけ、たまたま正しく書き出せていた)
     *
     * ref は使い回したい(描画のたびに張り替えたくない)ので、依存配列は空のまま、
     * **中身の読み口を latest に変える**。latest は自動保存が同じ理由で持っている箱で、
     * 描画のたびに最新の1冊が入る
     */
    const now = latest.current;
    const text = toProjectFile(now, false);
    downloadBlob(
      new Blob([text], { type: 'application/json' }),
      projectFileName(now.manuscript.title, false),
    );
    setFlash({ text: '書き出しました（画像なし）。直したら［読み込む］で戻せます', bad: false });
  }

  async function importFile(file: File) {
    // 画像を戻す元になる「いまの本」。ここも latest から取る(上の exportForAi と同じ理由。
    // いまは描画のたびに作られる onChange から呼ばれているので snapshot でも正しいが、
    // ref 越しの呼び口が増えたときに同じ穴を踏まないようにそろえておく)
    const { project, warnings } = fromProjectFile(await file.text(), latest.current);
    onLoad(project);
    if (warnings.length) {
      // 読めてはいるので止めない。ただし黙って通すと気づけないので、消えない出し方にする
      setFlash({
        text: `読み込みました（${warnings.length}件 確かめてください）`,
        bad: true,
        detail: warnings,
      });
    } else {
      setFlash({ text: '読み込みました', bad: false });
    }
  }

  /**
   * 自動保存の状態。**主役ではない。**
   *
   * 保存の主導線は［プロジェクトを保存］(どのブラウザでも動く)で、自動保存は
   * Chrome / Edge のときだけ付く便利機能、という位置づけにする。
   * 以前は自動保存をバーの先頭に置いていたので、非対応ブラウザの人には
   * 「できません」という否定だけが最初に目に入っていた(2026-08-17 ユーザー指摘)
   */
  const status = !isSupported()
    ? '自動保存は Chrome / Edge のみ'
    : !backup.folder
      ? '自動保存おすすめ（フォルダを決めるだけ）'
      : backup.error
        ? // **失敗は黙って古い表示を残さない。**(2026-09-04 レビュー指摘)
          `${backup.folder}（自動保存に失敗しています）`
        : !backup.ready
          ? // 「許可」というボタンは画面に無い。隣にある実物のボタンを名指しする
            `${backup.folder}（自動保存が止まっています。［自動保存を再開する］を押してください）`
          : // 書いていないのに「自動で保存します」と出ていると、控えがあると思い込まれる
            sample
            ? `${backup.folder}（サンプルは保存しません）`
            : backup.savedAt
              ? `${backup.folder} / ${backup.savedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に保存`
              : `${backup.folder}（変更があれば自動で保存します）`;
  /** フォルダ・バックアップが失敗しているか(ドットを消し、状態を赤くする) */
  const backupFailed = !!backup.error;

  /** 省略されたときのために、状態の全文はここに持たせる */
  const statusFull = !isSupported()
    ? '自動保存はこのブラウザでは動きません（Chrome / Edge のみ）。［保存する］でファイルを書き出して、なくさない場所に置いてください'
    : !backup.folder
      ? 'フォルダを1度決めておくと、変更のたびに控えが自動で残ります（Chrome / Edge）'
      : status;

  return (
    <div className="projectbar">
      {/* **端末への自動保存が失敗しているときの赤い帯。**(2026-09-04 レビュー指摘)
          これは「開き直せば続きから」を支える最後のとりで。黙って死ぬと、
          利用者は控えがあると信じてタブを閉じ、次に開くと巻き戻っている。
          ［保存する］を隣に添えて、その場で控えを取れるようにする */}
      {autosaveError && (
        <span className="projectbar-alert" role="alert">
          ⚠ {autosaveError}
          <button className="pulse" disabled={busy} onClick={saveProject}>
            いま保存する
          </button>
        </span>
      )}
      {/* 押した結果があるあいだは、そちらを優先して同じ場所に出す。
          バーを横に伸ばさずに済み、視線も動かなくて済む */}
      {/* **詳しい話はここで開く。** 工程の説明文の中に赤い警告が挟まると、
          その工程の一部だと読める(2026-08-19 ユーザー報告) */}
      {flash &&
        (flash.detail?.length ? (
          <button
            className={`projectbar-flash ${flash.bad ? 'bad' : ''}`}
            onClick={() => setDetailOpen(true)}
          >
            {flash.text} <span aria-hidden="true">›</span>
          </button>
        ) : (
          <span className={`projectbar-flash ${flash.bad ? 'bad' : ''}`}>{flash.text}</span>
        ))}

      {/* **保存を先頭に置く。** どのブラウザでも動く手動保存が主導線で、
          自動保存は Chrome / Edge のときだけ付く便利機能。
          以前は逆に並べていたので、非対応ブラウザの人には否定文が最初に目に入っていた。
          「AI に渡す」だけだと何が起きるか読めなかったので、ひとつの名詞(プロジェクト)に
          動詞をぶら下げて短いまま意味が通るようにしている */}
      <span className="projectbar-label">プロジェクト</span>
      <button
        className={highlightSave ? 'pulse' : undefined}
        disabled={busy}
        onClick={saveProject}
      >
        保存する
      </button>
      <button className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
        読み込む
      </button>

      <span className="projectbar-sep" />

      {/* ボタンに title を付けない。ネイティブのツールチップは**カーソルの位置に出る**ので、
          いま押そうとしているボタンを覆って読めない(2026-08-17 ユーザー報告)。
          説明が要るなら、それはラベルが足りていないということ */}
      <span className={`backup-dot ${backup.ready && !backupFailed ? 'on' : ''} ${backupFailed ? 'bad' : ''}`} />
      <span className={`backup-status ${backupFailed ? 'bad' : ''}`} title={backup.error || statusFull}>
        {status}
      </span>
      {isSupported() &&
        (!backup.folder ? (
          <button className="ghost" disabled={busy} onClick={() => void run('保存先の設定', async () => setBackup(await choose()))}>
            フォルダを決める
          </button>
        ) : !backup.ready ? (
          <button disabled={busy} onClick={() => void run('許可の取得', async () => setBackup(await reauthorize()))}>
            自動保存を再開する
          </button>
        ) : (
          <button className="ghost" disabled={busy} onClick={() => void run('保存先の変更', async () => setBackup(await choose()))}>
            保存先を変える
          </button>
        ))}
      {backup.folder && (
        <button className="ghost" disabled={busy} onClick={() => void run('解除', async () => setBackup(await forget()))}>
          やめる
        </button>
      )}
      {detailOpen && flash?.detail && (
        <div className="about-backdrop" onClick={() => setDetailOpen(false)}>
          <div
            className="about"
            role="dialog"
            aria-label="読み込みの結果"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="about-close" aria-label="閉じる" onClick={() => setDetailOpen(false)}>
              ×
            </button>
            <h2>{flash.text}</h2>
            <ul className="help-list">
              {flash.detail.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            {/* 失敗したときは読めていないので「読めてはいます」とは言わない */}
            <p className="hint">
              {flash.failed ? 'いま開いている本の内容はそのまま残っています。' : '読めてはいます。気になるところだけ直してください'}
            </p>
          </div>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f)
            void run('読み込み', async () => {
              try {
                await importFile(f);
              } catch (err) {
                // 取り消し(AbortError)は失敗ではない。投げ直すので、トップバーのフラッシュは今までどおり出る
                if (!(err instanceof DOMException && err.name === 'AbortError')) {
                  onLoadError?.(err instanceof Error ? err.message : String(err));
                }
                throw err;
              }
            });
          e.target.value = '';
        }}
      />
    </div>
  );
});
