// **原稿を取り込み直しても、挿絵・コラム・背景が残っているかを機械で測る。**
//
// ## なぜ在るか
//
// 「『文中に貼る』をやってみました。挿絵ページは残っているし、背景にも画像があったのだが、
//  コラムだけはなくなっていた」(2026-08-21 ユーザー報告)
//
// 差し込みページは章の切れ目に「何章の前か」(`beforeChapter`)で紐づいている。
// 取り込み直すと**章の数が変わる**ので、範囲の外へ出たものは組版に出てこない。
// 目で見て「残っています」と言うかぎり、同じ取りこぼしはまた起きる。
// そこで**取り込みの前と後で、設定に持っている数と、紙に出た数の両方を数える。**
//
// 測るのは4つ:
//
//   0. 手元の .docx  … `public/_probe.docx` を置いたときだけ(実原稿は git に上げない)
//   1. 絵を置いたまま取り込み直す … ［挿絵］で章の途中に置いた絵が、同じ段落のあとへ
//                      付け直されること(2026-09-23。それまでは Word へ出して取り込み直す往復を
//                      測っていたが、Word 書き出しは撤去した)
//   2. 章が減る取込  … 2章だけの原稿を取り込む(巻末に寄せて、消えないこと)
//   3. 章が同じ取込  … 5章の原稿を取り込む(何も動かないはず)
//
// ## 使い方
//
//   python scripts/check-import.py
//
// あるいは手で:
//   npx vite --port 5199
//   http://localhost:5199/scripts/import-probe.html
//
// 測り終わると document.title が `PROBE-DONE`(全部残った)か `PROBE-FAIL`。
// **IndexedDB を書き換える**ので、素のプロファイルで開くこと。
import { useProject } from '../src/store/useProject';
import { manuscriptHtml } from '../src/typeset/html';
import { parseDocx } from '../src/importers/docx';
import type { Manuscript } from '../src/models/project';
import { reportProbe } from './probe-report';

/** 設定に持っている数と、組版HTMLに実際に出た数 */
interface Counts {
  章: number;
  /** settings に持っている数 */
  挿絵: number;
  コラム: number;
  章ごとの背景: number;
  /** 組版HTMLに出た数(ここが本番。持っていても出ないことがある) */
  紙の挿絵: number;
  紙のコラム: number;
  紙の章ごとの背景: number;
  /** 範囲の外へ出て、黙って消えたもの */
  範囲外の挿絵: number;
  範囲外のコラム: number;
  /** 本文の流れの中に入った画像(章の途中の絵)。**取り込み直しで減ってはいけない** */
  本文中の画像: number;
  /** 組版HTMLに出た章の途中の絵(data-img) */
  紙の本文中の画像: number;
  /** 組版HTMLの長さ。中身がまるごと入れ替わったことの目安 */
  HTMLの長さ: number;
}

function countAll(): Counts {
  const s = useProject.getState().settings;
  const ms = useProject.getState().manuscript;
  const n = ms.chapters.length;
  const plates = s.plates ?? [];
  const cols = s.columnPages ?? [];
  const chapterBg = Object.keys(s.chapterBg ?? {});
  const html = manuscriptHtml(ms, s);
  const count = (re: RegExp) => (html.match(re) ?? []).length;
  return {
    章: n,
    挿絵: plates.length,
    コラム: cols.length,
    章ごとの背景: chapterBg.length,
    紙の挿絵: count(/data-plate=/g),
    紙のコラム: count(/data-colpage=/g),
    本文中の画像: ms.chapters.reduce(
      (n, ch) => n + ch.blocks.filter((b) => b.type === 'image').length,
      0,
    ),
    紙の本文中の画像: count(/data-img=/g),
    HTMLの長さ: html.length,
    紙の章ごとの背景: count(/class="chapter[^"]* chapbg\d/g),
    範囲外の挿絵: plates.filter((p) => p.beforeChapter > n).length,
    範囲外のコラム: cols.filter((c) => c.beforeChapter > n).length,
  };
}

/** 章だけの素の原稿を作る(取込で置き換わる中身の代わり) */
function plainManuscript(chapters: number): Manuscript {
  return {
    title: 'さしかえ',
    author: '',
    publisher: '',
    chapters: Array.from({ length: chapters }, (_, i) => ({
      title: `第${i + 1}章`,
      blocks: [{ type: 'p' as const, text: 'ほんぶん' }],
    })),
  };
}

/** サンプルを読み直して、絵が流れ込むまで待つ */
async function freshSample() {
  await useProject.getState().loadSample();
  // loadSample は絵を非同期で流し込む。**流し込み終わってから数える**
  for (let i = 0; i < 60; i++) {
    if ((useProject.getState().settings.columnPages ?? []).length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
}

interface CaseResult {
  name: string;
  before: Counts;
  after: Counts;
  note?: string;
  /**
   * 章の数が変わらないはずの取り込みか。同じ原稿を入れ直したら、同じ本が同じ形で
   * 戻ってくるのが正しい(コラムが章として二重に入っていたころは 5章 → 7章 に増えていた)
   */
  章は変わらない?: boolean;
  /** 章の途中の絵の数が変わらないはずの取り込みか(スタジオで置いた絵の付け直し) */
  絵は変わらない?: boolean;
}

/**
 * **章の途中に絵を置いたまま、同じ原稿を取り込み直す。**(2026-09-23)
 *
 * 誤字を直した原稿を入れ直す、がいちばんよくある取り込み直し。原稿ファイルには
 * ［挿絵］で置いた絵が入っていないので、付け直しが効かないと絵が全部消える。
 * サンプルの2枚の絵はスタジオで置いた扱い(fromStudio)なので、これで測れる。
 * サンプルからは付け直さない決まり(自分の原稿へ他人の絵を持ち込まない)なので、
 * 自分の本として扱ってから取り込む
 */
async function reimportKeepsImages(): Promise<CaseResult> {
  await freshSample();
  useProject.setState({ isSample: false });
  const before = countAll();
  const st = useProject.getState();
  // 取り込み直した原稿には、スタジオで置いた絵は入っていない
  const ms: Manuscript = {
    ...st.manuscript,
    chapters: st.manuscript.chapters.map((ch) => ({
      ...ch,
      blocks: ch.blocks.filter((b) => !(b.type === 'image' && b.fromStudio)),
    })),
  };
  const fit = useProject.getState().setManuscript(ms, { name: 'さしかえ', kind: 'txt', data: '' });
  await new Promise((r) => setTimeout(r, 100));
  return {
    name: '章の途中の絵を置いたまま、同じ原稿を取り込み直す',
    章は変わらない: true,
    絵は変わらない: true,
    before,
    after: countAll(),
    note: `付け直した絵: ${fit.imagesKept ?? 0}枚／章の最後へ移した絵: ${fit.imagesMoved ?? 0}枚`,
  };
}

/** 章の数が変わる取込 */
async function replaceCase(chapters: number, name: string): Promise<CaseResult> {
  await freshSample();
  const before = countAll();
  useProject.getState().setManuscript(plainManuscript(chapters), {
    name: 'さしかえ',
    kind: 'txt',
    data: '',
  });
  await new Promise((r) => setTimeout(r, 100));
  return { name, before, after: countAll() };
}

/**
 * 手元の本物の .docx で測る(あるときだけ)。
 * `public/_probe.docx` に置いてから回す。実原稿は git に上げないので、
 * 無ければ黙って飛ばす
 */
async function realDocxCase(): Promise<CaseResult | null> {
  const res = await fetch('/_probe.docx').catch(() => null);
  if (!res || !res.ok) return null;
  const buf = await res.arrayBuffer();
  // ZIP でなければ(開発サーバーが index.html を返した)測らない
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] !== 0x50 || head[1] !== 0x4b) return null;
  await freshSample();
  const before = countAll();
  const { manuscript: ms, skippedColumnPages } = await parseDocx(buf, '手元の原稿');
  useProject.getState().setManuscript(ms, { name: '手元の原稿', kind: 'docx', data: '' });
  await new Promise((r) => setTimeout(r, 100));
  return {
    name: '手元の .docx を取り込む（public/_probe.docx）',
    // 手元の原稿はスタジオが書き出した Word なので、章立ては元のまま戻るのが正しい
    章は変わらない: true,
    before,
    after: countAll(),
    note: `章立て: ${ms.chapters.map((c) => c.title).join(' / ')}`
      + `／本文に入れなかった［コラム］: ${skippedColumnPages.length}件`,
  };
}

async function main() {
  const cases: CaseResult[] = [];
  const real = await realDocxCase();
  if (real) cases.push(real);
  cases.push(await reimportKeepsImages());
  cases.push(await replaceCase(2, '章が 5 → 2 に減る原稿を取り込む'));
  cases.push(await replaceCase(5, '章が 5 のままの原稿を取り込む'));

  /**
   * **落とす条件は「持っている数」ではなく「紙に出た数」。**
   * settings に残っていても、範囲の外にいるページは組版に出てこない
   * (それが 2026-08-21 の報告の正体)。
   */
  const fails: string[] = [];
  for (const c of cases) {
    if (c.after.紙のコラム < c.before.紙のコラム) {
      fails.push(`${c.name}: 紙に出たコラムが ${c.before.紙のコラム} → ${c.after.紙のコラム} 枚に減った`);
    }
    if (c.after.紙の挿絵 < c.before.紙の挿絵) {
      fails.push(`${c.name}: 紙に出た挿絵が ${c.before.紙の挿絵} → ${c.after.紙の挿絵} 枚に減った`);
    }
    if (c.after.コラム < c.before.コラム) {
      fails.push(`${c.name}: 設定のコラムが ${c.before.コラム} → ${c.after.コラム} 枚に減った`);
    }
    if (c.after.挿絵 < c.before.挿絵) {
      fails.push(`${c.name}: 設定の挿絵が ${c.before.挿絵} → ${c.after.挿絵} 枚に減った`);
    }
    if (c.after.範囲外の挿絵 || c.after.範囲外のコラム) {
      fails.push(
        `${c.name}: 章の範囲の外に 挿絵${c.after.範囲外の挿絵}枚 / コラム${c.after.範囲外のコラム}枚 が残った`,
      );
    }
    // **同じ原稿の入れ直しで章が増えてはいけない。** 増えると、そのぶん差し込みページが
    // 別の切れ目へずれる(コラムが章として二重に入っていたころの壊れ方)
    if (c.章は変わらない && c.after.章 !== c.before.章) {
      fails.push(`${c.name}: 章が ${c.before.章} → ${c.after.章} に変わった（入れ直しで増減してはいけない）`);
    }
    // スタジオで置いた章の途中の絵は、取り込み直しても減らない(紙にも出る)
    if (
      c.絵は変わらない &&
      (c.after.本文中の画像 !== c.before.本文中の画像 ||
        c.after.紙の本文中の画像 !== c.before.紙の本文中の画像)
    ) {
      fails.push(
        `${c.name}: 章の途中の絵が ${c.before.本文中の画像} → ${c.after.本文中の画像} 枚` +
          `(紙 ${c.before.紙の本文中の画像} → ${c.after.紙の本文中の画像})に変わった`,
      );
    }
  }

  reportProbe({ ok: fails.length === 0, fails, cases }, fails.length === 0);
}

void main().catch((e) => {
  reportProbe({ ok: false, 落ちた: String(e), stack: (e as Error)?.stack ?? '' }, false);
});
