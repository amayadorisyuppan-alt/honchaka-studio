// 入稿用の変換の本体。部品(neutral・Ghostscript・inkLimit・pdfx・inspect)を順に通す。
//
// **ブラウザにも Node にも依らない。** Ghostscript と ICC の読み込みは外から渡す(deps)。
// 製品では Worker(gsWorker.ts)が、検査では Node(scripts/press/run.ts)が、同じこの関数を呼ぶ。
//
// 変換は3種類(2026-10-01 利用者と決めた: PDF/X-4・Japan Color 2011 Coated・インク 300% 以下・無彩色は K だけ・画像は劣化させない):
//   body-gray  白黒の本の本文 … Ghostscript(Gray)→ グレーの濃さを直す → X-4 の形 → 点検
//   body-cmyk  カラーの本の本文 … 無彩色をグレーへ → Ghostscript(CMYK)→ グレーの濃さを直す → インクを抑える → X-4 の形 → 点検
//   cover-cmyk 表紙 … Ghostscript(CMYK)→ インクを抑える → X-4 の形 → 点検
//
// 段は load → prepare → convert → finish → check の順に1度ずつ(戻らない)。道具(Ghostscript・ICC)の読み込みは最初の load で終える。
//
// **失敗は「何が原因か」を持つ(PressError.origin)。** 画面は、ファイルが原因のときだけ「選んだファイルを確かめてください」と言う。
// 利用者に出る message は日本語だけ。英語の生のエラー(wasm・動的 import・Ghostscript の括弧)は log に回してコンソールへ出す。
//
// メモリ(2026-10-01 Node の RSS 最大で実測): 文字だけ 260 ページ(入力 32.6MB)で約 1.4〜1.6GB、画像の多い 260 ページ(入力 95MB)で約 2.1〜2.5GB、
// color-a5(32 ページ)で約 370MB(幅は測り方の違い: 別の人が刻んで測った値 1.4GB・2.1GB と、run.ts が resourceUsage().maxRSS で測った値 1.6GB・2.5GB)。
// 「260 ページで 600MB」という以前の見積もりは、この実測と合わなかった。
// ブラウザの Worker でも、どちらの 260 ページも落ちずに通った(74 秒・201 秒)。同時に持つ PDF を減らすため、
// 入力の PDF は読んだらすぐ参照を切り、Ghostscript の出力を読んだら仮想ファイルを消してモジュールを手放してから、pdf-lib で開く
// (Worker ごと使い捨てるので、残りは終わりに返る)。
import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { applyGrayTone } from './grayTone.ts';
import { inspectPress } from './inspect.ts';
import { limitInk } from './inkLimit.ts';
import { neutralize } from './neutral.ts';
import { paperSizeText } from './paper.ts';
import { applyPdfx4, findPaperMismatch, isPdfx, savePdfx4 } from './pdfx.ts';
import { repairTruncatedStreams } from './repair.ts';
import type { GrayToneReport, InkReport, NeutralReport, PaperMismatch, PdfxReport, PressBoxes } from './types.ts';

export type PressKind = 'body-gray' | 'body-cmyk' | 'cover-cmyk';
export type PressPhase = 'load' | 'prepare' | 'convert' | 'finish' | 'check';

export interface PressJob {
  kind: PressKind;
  /** 入力の PDF。使い終わったら、この job の pdf は空にする(メモリを早く返すため) */
  pdf: Uint8Array;
  boxes: PressBoxes;
  /** 書名（PDF の Title に入る） */
  title: string;
  /** インクの総量の上限（%）。カラーのときだけ使う。有限の正の数でなければ、変換を始めずに失敗にする */
  inkLimit: number;
  /**
   * グレーの濃さの直し(grayTone.ts)をするか。省いたら true(今までどおり直す)。
   * オフセット印刷向けにこちらの判断で入れた直しなので、KDP(トナー機)の白黒を K1色で試すときなど、呼ぶ側が切れるようにした(2026-10-02)。
   * 表紙は、もともと直さない
   */
  grayTone?: boolean;
  now: Date;
}

/** Ghostscript の Emscripten モジュールのうち、使うところだけ */
export interface GsModule {
  callMain(args: string[]): number;
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, d: Uint8Array): void;
    readFile(p: string): Uint8Array;
    /** 仮想ファイルを消す(メモリを早く返す)。無くてもよい */
    unlink?(p: string): void;
  };
}

export interface PressDeps {
  /** Ghostscript を1つ作る（1回の変換ごとに作り直す）。onLine には標準出力の1行ずつが来る */
  createGs(onLine: (line: string) => void): Promise<GsModule>;
  /** Japan Color 2011 Coated の ICC */
  loadIcc(): Promise<Uint8Array>;
  /** JPEG をほどく道具（ブラウザだけ。neutral.ts に渡す） */
  decodeImage?: (bytes: Uint8Array, filter: string) => Promise<{ width: number; height: number; rgba: Uint8Array } | null>;
  onPhase?(phase: PressPhase): void;
  onProgress?(page: number, total: number | null): void;
}

export interface PressResult {
  pdf: Uint8Array;
  pages: number;
  /** 整える**前**の 1ページ目の用紙の寸法（mm）。別の本の PDF を選んでいないかを画面で確かめるのに使う */
  pageMm: { w: number; h: number } | null;
  neutral: NeutralReport | null;
  ink: InkReport | null;
  /** paperMismatch は、紙の大きさが、この本の用紙と違ったときに値が入る(画面は保存せずに書き出し直しを案内する) */
  pdfx: PdfxReport;
  /** グレーの濃さの直し(grayTone.ts)。表紙は、色が絵の中にしか無いので直さない(null) */
  tone: GrayToneReport | null;
  /** グレーの濃さの直しを掛けたか。表紙、または呼ぶ側が切ったときは false(そのとき tone は null) */
  toneApplied: boolean;
  /** 入稿の前に知らせること（利用者向けの文。空なら問題なし）: 色の残り・抑えられなかったインク・X-4 に合わない所・読めなかった所 */
  issues: string[];
  /** C・M・Y が乗るページ（1 始まり）。白黒の本では空のはず */
  colorPages: number[];
  ms: number;
}

/**
 * 失敗の原因。画面が、言う助言を変えるために使う。
 *   file     選んだファイルが原因(PDF でない・暗号化・壊れている・途中で切れている)。「選んだファイルを確かめてください」と言ってよい
 *   tool     変換の道具(Ghostscript・ICC)を読み込めなかった。通信かページの読み込み直し
 *   internal 変換の途中で止まった・想定外。ページの読み込み直し
 */
export type PressErrorOrigin = 'file' | 'tool' | 'internal';

/**
 * 変換の失敗。message は利用者向けの日本語。log は開発者向け(英語の生のエラー・Ghostscript の出力の末尾)で、画面には出さずコンソールへ。
 *   complete       message だけで、利用者が次にすることまで言えている。画面は「選んだファイルが…確かめてください」を足さない
 *                  (足すと「外して保存し直して」と「確かめて」が重なる。4-2)
 *   paperMismatch  紙の大きさが、この本の用紙と違った(値)。画面は、書き出し直しの案内を付けて言う。文の中身を探して見分けない
 */
export class PressError extends Error {
  log: string;
  origin: PressErrorOrigin;
  complete: boolean;
  paperMismatch?: PaperMismatch;
  constructor(message: string, log: string, origin: PressErrorOrigin = 'internal', extra: { complete?: boolean; paperMismatch?: PaperMismatch } = {}) {
    super(message);
    this.name = 'PressError';
    this.log = log;
    this.origin = origin;
    this.complete = extra.complete === true;
    this.paperMismatch = extra.paperMismatch;
  }
}

const PT_TO_MM = 25.4 / 72;
const WORK_ICC = '/work/JapanColor2011Coated.icc';

const MSG_NOT_PDF = 'PDF ではないファイルです';
// 暗号化の文は、次にすることまで言い切る(「外して保存し直して」と、画面が足す「選んだファイルを確かめて」が重なっていた)。
// スタジオが印刷の画面で保存した PDF には制限が無いので、「外す」より「元の PDF を選ぶ」を言う
const MSG_ENCRYPTED = 'パスワードや編集の制限がかかっています。印刷の画面で保存した、元の本文 PDF を選んでください';
const MSG_ALREADY = 'すでに入稿用に変えた PDF です。印刷の画面で保存した、元の本文 PDF を選んでください';
const MSG_UNREADABLE = 'PDF として読めませんでした。壊れているか、途中で切れている可能性があります';
const MSG_TOOL = '変換の道具を読み込めませんでした。通信を確かめて、ページを読み込み直してください';
const MSG_INTERNAL = '変換の途中で、うまくいかないことがありました';

/**
 * Ghostscript に渡す引数。入力は /work/in.pdf、出力は /work/out.pdf、ICC は /work/JapanColor2011Coated.icc に置く。
 *
 * - `-dSAFER` のまま外の ICC を読ませる。`--permit-file-read` で ICC の1つだけを許す(`-dNOSAFER` は製品では使わない。
 *   Ghostscript が PostScript の中から任意のファイルを読み書きできるようになってしまうため。
 *   入口で `%PDF-` で始まらないファイルを断る(下の looksLikePdf)のも、PostScript を実行させないため)
 * - `ColorConversionStrategy` … 字も線も絵も背景の塗りも、全部を出力の色空間(グレー=K、または CMYK)に落とす。
 *   カラーは `-dOverrideICC=true` と `-sOutputICCProfile` で Japan Color 2011 Coated を通す
 * - `-dDeviceGrayToK=true`(カラーだけ)… グレーを K 版だけに入れる。これが無いと、グレーが C・M・Y・K の掛け合わせになる
 * - **画像を劣化させない。** 既定では画像を JPEG に圧縮し直す(試作で PNG 8MB が JPEG 0.9MB になった)。
 *   「紙はくっきり、電子は軽く」(2026-09-25 ユーザー了承)なので、可逆の Flate にして、縮めもしない
 * - `-dPassThroughJPEGImages=false` … 色を変える必要の無い JPEG(もとからグレーの JPEG)を、Ghostscript は圧縮したまま素通しにする。
 *   素通しの JPEG は中の画素を読めないので、グレーの濃さの直し(grayTone.ts)が効かず、その絵だけ画面より明るく刷られる。
 *   ほどいて Flate に詰め直させる(ほどいた画素をそのまま詰めるので、これ以上は劣化しない。2026-10-01)
 * - `-dAutoRotatePages=/None` … 既定の /PageByPage は、欧文だけが寝かせて組まれた縦組みのページ(書名が「long」だけの大扉など)に
 *   /Rotate 270 を付ける。回ったページは TrimBox・BleedBox が付かず、X-4 から外れる。変換前の PDF は回っていないので、回させない(2026-10-02)
 * - `-dCompatibilityLevel=1.6` … PDF/X-4 は PDF 1.6 が土台
 * - `-q` は付けない。「Page 12」と1ページずつ出る行を、進み具合に使う
 * - **`-dNODISPLAY` は付けない。** pdfwrite と一緒に付けると、エラーも出さずに何も書き出さない(2026-09-27 試作の検証で判明)
 * - `-dPDFX` と `-dHaveTransparency=false` は、この WASM 版ではスタジオの実際の PDF で落ちる(同)ので使わない。X-4 の形は pdfx.ts が整える
 * - `-dBlackText` / `-dBlackVector` は色のついた文字まで黒にする。`-dUseFastColor` は黒が C=M=Y=100%・K=0 になる。どれも使わない
 */
export function gsArgs(kind: PressKind): string[] {
  const common = [
    '-dBATCH',
    '-dNOPAUSE',
    '-dSAFER',
    `--permit-file-read=${WORK_ICC}`,
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.6',
    '-dAutoRotatePages=/None',
  ];
  const color =
    kind === 'body-gray'
      ? ['-sColorConversionStrategy=Gray', '-sProcessColorModel=DeviceGray', '-dOverrideICC=true']
      : [
          '-sColorConversionStrategy=CMYK',
          '-sProcessColorModel=DeviceCMYK',
          '-dOverrideICC=true',
          `-sOutputICCProfile=${WORK_ICC}`,
          '-dDeviceGrayToK=true',
        ];
  const images = [
    '-dAutoFilterColorImages=false',
    '-dAutoFilterGrayImages=false',
    '-dColorImageFilter=/FlateEncode',
    '-dGrayImageFilter=/FlateEncode',
    '-dDownsampleColorImages=false',
    '-dDownsampleGrayImages=false',
    '-dDownsampleMonoImages=false',
    '-dPassThroughJPEGImages=false',
  ];
  return [...common, ...color, ...images, '-sOutputFile=/work/out.pdf', '/work/in.pdf'];
}

/** 失敗の文に添える、Ghostscript の出力の末尾の行数 */
const LOG_TAIL = 30;

/**
 * 入力が PDF か。先頭 1KB 以内に `%PDF-` があること(前に空行などが付いた PDF も在る)。
 * **`%!` で始まるものは、中に `%PDF-` があっても断る。** Ghostscript は先頭が `%!` なら PostScript として実行する
 * (`{} loop` だけのファイルで、25 秒の時間切れまで戻らなかった。2026-10-01)。空・テキストもここで断る
 */
function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  if (bytes[0] === 0x25 && bytes[1] === 0x21) return false;
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

/** Ghostscript の標準出力(1行ずつ)から、進み具合と、利用者に知らせることを拾う */
interface GsNotes {
  /** 「Processing pages 1 through N」の N。1度も出なければ null */
  total: number | null;
  password: boolean;
  /** `Couldn't initialise file`・`No pages will be processed`(読めなかった PDF にも、Ghostscript は終了コード 0 で白紙を出す) */
  unreadable: boolean;
  /** `**** Error` が出たページ(出たときの直前の「Page n」。分からなければ 0) */
  errorPages: Set<number>;
  /** 代わりの書体に置き換えた書体の名前(部分埋め込みの印は除く)。名前が分からなければ空の文字列 */
  substituted: Set<string>;
}

function newGsNotes(): GsNotes {
  return { total: null, password: false, unreadable: false, errorPages: new Set(), substituted: new Set() };
}

export async function runPress(job: PressJob, deps: PressDeps): Promise<PressResult> {
  const t0 = performance.now();
  const log: string[] = [];
  const notes = newGsNotes();
  let lastPage = 0;
  const phase = (p: PressPhase) => deps.onPhase?.(p);
  const tail = () => log.slice(-LOG_TAIL).join('\n');
  const onLine = (line: string) => {
    log.push(line);
    if (log.length > 200) log.shift();
    // 進み具合は Ghostscript の標準出力から拾う(-q を付けないと「Page 12」と1ページずつ出す)
    const all = /Processing pages \d+ through (\d+)/.exec(line);
    if (all) notes.total = Number(all[1]);
    const page = /^Page (\d+)/.exec(line);
    if (page) {
      lastPage = Number(page[1]);
      deps.onProgress?.(lastPage, notes.total);
    }
    if (/requires a password/i.test(line)) notes.password = true;
    if (/Couldn't initialise file|No pages will be processed/.test(line)) notes.unreadable = true;
    // `**** Error: Page drawing error occurred.` など。読み込めなかった初期化の行は上で別に数える
    else if (/^\s*\*{4} Error/.test(line)) notes.errorPages.add(lastPage);
    if (/substitute font/i.test(line)) notes.substituted.add('');
    const sub = /^Loading\s+(?:CID)?[Ff]ont\s+(\S+)\s+substitute/.exec(line);
    if (sub) {
      notes.substituted.delete('');
      notes.substituted.add(sub[1].replace(/^[A-Z]{6}\+/, ''));
    }
  };
  /** 想定外の例外を、利用者向けの日本語にする(元の例外は log へ) */
  const fail = (e: unknown): PressError => {
    if (e instanceof PressError) return e;
    const raw = e instanceof Error ? (e.stack ?? e.message) : String(e);
    return new PressError(MSG_INTERNAL, `${raw}\n${tail()}`, 'internal');
  };
  /** 道具の読み込み(ICC・Ghostscript)の失敗は、通信の問題として言う */
  const tool = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PressError) throw e;
      throw new PressError(MSG_TOOL, `${what}: ${e instanceof Error ? e.message : String(e)}`, 'tool');
    }
  };

  try {
    const cmyk = job.kind !== 'body-gray';
    // インクの上限が数でないと、limitInk は「測るだけ」(上限なし)になり、問題なしと言ってしまう(2-2 の B2)
    if (cmyk && !(Number.isFinite(job.inkLimit) && job.inkLimit > 0)) {
      throw new PressError('インクの上限の指定が正しくありません', `inkLimit=${String(job.inkLimit)}`, 'internal');
    }
    // 道具を読み込む前に断る(空・テキスト・PostScript は、読み込みを待たせるまでもない)
    if (!looksLikePdf(job.pdf)) throw new PressError(MSG_NOT_PDF, '', 'file');

    const open = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
    const sizeOf = (doc: PDFDocument) => {
      const size = doc.getPageCount() > 0 ? doc.getPage(0).getSize() : null;
      return size ? { w: size.width * PT_TO_MM, h: size.height * PT_TO_MM } : null;
    };

    // ── 0. 道具の読み込み(ICC・Ghostscript)。ここで1度だけ。Ghostscript は読み込みだけなら約 60MB ──
    phase('load');
    const icc = await tool('ICC', () => deps.loadIcc());
    let gs: GsModule | null = await tool('Ghostscript', () => deps.createGs(onLine));
    gs.FS.mkdir('/work');
    if (cmyk) gs.FS.writeFile(WORK_ICC, icc);

    // ── 1. 入力の点検(全部の変換)と、下ごしらえ(カラーの本文だけ): 無彩色の RGB をグレーへ。Ghostscript に渡す前でなければ効かない ──
    // ページ数を数えるために、白黒・表紙も pdf-lib で開く(Ghostscript は読めない PDF にも終了コード 0 で白紙を出すので、
    // 入力のページ数と出力のページ数を突き合わせる)。暗号化は開く段階で分かる
    phase('prepare');
    let input = job.pdf;
    job.pdf = new Uint8Array(0);
    let pageMm: PressResult['pageMm'] = null;
    let neutral: NeutralReport | null = null;
    let inPages = 0;
    const repairFailed: string[] = [];
    {
      let doc: PDFDocument | null;
      try {
        doc = await open(input);
        // ページ木が壊れている PDF は、開くのには成功して、ページを数えるところで例外になる
        inPages = doc.getPageCount();
        pageMm = sizeOf(doc);
      } catch (e) {
        if (e instanceof EncryptedPDFError || /encrypted/i.test(String((e as Error)?.message))) {
          throw new PressError(MSG_ENCRYPTED, `pdf-lib: ${(e as Error).message}`, 'file', { complete: true });
        }
        throw new PressError(MSG_UNREADABLE, `pdf-lib: ${String((e as Error)?.message ?? e)}`, 'file');
      }
      if (inPages === 0) throw new PressError('PDF にページがありません', '', 'file');
      // すでに入稿用に変えた PDF は、Ghostscript を動かす前に断る。もう一度かけると、グレーが2度濃くなる(isPdfx の注)。
      // 表紙は画面から直に作る(選び直さない)ので、文は本文向けでよい
      if (isPdfx(doc)) throw new PressError(MSG_ALREADY, '', 'file', { complete: true });
      // 紙の大きさが違う PDF も、変換の前に断る。変換を全部走らせてから断ると、ページの多い本で数分待たせる(4-2 の 2)。
      // 変換のあとの点検(applyPdfx4 の paperMismatch)は、守りとして残してある
      const wrongPaper = findPaperMismatch(doc, job.boxes);
      if (wrongPaper) {
        throw new PressError(
          `PDF の紙の大きさ（${paperSizeText(wrongPaper.actualMm)}）が、この本の用紙（${paperSizeText(wrongPaper.expectedMm)}）と違います`,
          `paperMismatch pages=${wrongPaper.pages.slice(0, 20).join(',')}`,
          'file',
          { complete: true, paperMismatch: wrongPaper },
        );
      }
      if (job.kind === 'body-cmyk') {
        // ほかの道具が書いた PDF も、間接の /Length のストリームを pdf-lib が削ることがある(repair.ts)。書き直す前に戻す
        repairFailed.push(...repairTruncatedStreams(doc, input).failed);
        neutral = await neutralize(doc, { decodeImage: deps.decodeImage });
        input = await doc.save({ useObjectStreams: false });
      }
      doc = null;
    }

    // ── 2. Ghostscript ──
    phase('convert');
    let out: Uint8Array;
    {
      gs.FS.writeFile('/work/in.pdf', input);
      input = new Uint8Array(0);
      let code: number;
      try {
        code = gs.callMain(gsArgs(job.kind));
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        throw new PressError('変換の途中で止まりました', `callMain: ${raw}\n${tail()}`, 'internal');
      }
      if (code !== 0) throw new PressError('変換できませんでした', `終了コード ${code}\n${tail()}`, 'file');
      // Ghostscript は、読めなかった PDF にも終了コード 0 で、白紙の Letter 1ページを出す(2026-10-01 実測)。成功にしない
      if (notes.password) throw new PressError(MSG_ENCRYPTED, tail(), 'file', { complete: true });
      if (notes.unreadable || notes.total === null) throw new PressError(MSG_UNREADABLE, tail(), 'file');
      try {
        out = gs.FS.readFile('/work/out.pdf');
      } catch {
        throw new PressError('変換はエラーなく終わりましたが、PDF ができていません', tail(), 'internal');
      }
      // 読み終わった仮想ファイルを消して、Ghostscript を手放す(pdf-lib で開く前に、同時に持つものを減らす)
      try {
        gs.FS.unlink?.('/work/out.pdf');
        gs.FS.unlink?.('/work/in.pdf');
      } catch {
        // 消せなくても結果には響かない
      }
      gs = null;
    }

    // ── 3. あと始末 ──
    phase('finish');
    let doc: PDFDocument;
    try {
      doc = await open(out);
    } catch (e) {
      throw new PressError('変換のあとの PDF を開けませんでした', `pdf-lib: ${String((e as Error)?.message ?? e)}\n${tail()}`, 'internal');
    }
    // pdf-lib が Ghostscript の出力のストリームを1〜2バイト削ることがある(理由は repair.ts)。直してから手放す
    repairFailed.push(...repairTruncatedStreams(doc, out).failed);
    out = new Uint8Array(0);
    const outPages = doc.getPageCount();
    if (outPages !== inPages) {
      throw new PressError(`変換のあとのページ数（${outPages}）が、元の PDF（${inPages}）と合いません`, tail(), 'file');
    }
    if (pageMm === null) pageMm = sizeOf(doc);
    // グレーの濃さを直す(理由は grayTone.ts)。**ここで1回だけ。** 2度かけると2度濃くなる。
    // 表紙は文字も絵も1枚の CMYK の画像なので、直すグレーが無い。インクを抑える前にやる(K だけの値しか動かないので、順番で結果は変わらない)
    // 呼ぶ側が grayTone: false にしたときも直さない(省いたら直す)
    const toneApplied = job.kind !== 'cover-cmyk' && job.grayTone !== false;
    const tone: GrayToneReport | null = toneApplied ? await applyGrayTone(doc) : null;
    let ink: InkReport | null = null;
    let facts: Awaited<ReturnType<typeof limitInk>>['facts'] | undefined;
    if (cmyk) {
      const r = await limitInk(doc, job.inkLimit);
      facts = r.facts;
      ink = {
        limit: r.limit,
        maxBefore: r.maxBefore,
        maxAfter: r.maxAfter,
        images: r.images,
        ops: r.ops,
        shadings: r.shadings,
        unhandled: r.unhandled,
      };
    }
    const pdfx = await applyPdfx4(doc, {
      icc,
      title: job.title,
      boxes: job.boxes,
      blend: cmyk ? 'DeviceCMYK' : 'DeviceGray',
      now: job.now,
    });

    // ── 4. 点検と書き出し ──
    phase('check');
    const found = await inspectPress(doc, job.kind, facts);
    const bytes = await savePdfx4(doc);
    const pages = doc.getPageCount();

    const issues = issuesOf({ found, ink, violations: pdfx.violations, neutral, tone, notes, repairFailed });
    return {
      pdf: bytes,
      pages,
      pageMm,
      neutral,
      ink,
      pdfx: { fixed: pdfx.fixed, violations: pdfx.violations, paperMismatch: pdfx.paperMismatch },
      tone,
      toneApplied,
      issues,
      colorPages: found.colorPages,
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    throw fail(e);
  }
}

/** 場所の一覧を、先頭3つだけ見せて残りは「ほか」にまとめる */
function listed(items: string[]): string {
  return items.slice(0, 3).join('、') + (items.length > 3 ? ' ほか' : '');
}

/** inkLimit.ts が、読めなかったストリームについて付ける言い方の尾(点検・X-4 と同じ原因を1つにまとめるのに使う) */
const INK_UNREADABLE_TAIL = '。読めないので、インクの量は測れない';
/** pdfx.ts の、読めなかったものがあって色を点検できていない、という違反の頭 */
const X4_UNREADABLE = '中身を読めなかったものがあり';

interface IssueInput {
  found: Awaited<ReturnType<typeof inspectPress>>;
  ink: InkReport | null;
  violations: string[];
  neutral: NeutralReport | null;
  tone: GrayToneReport | null;
  notes: GsNotes;
  repairFailed: string[];
}

/** 点検の結果を、利用者に知らせる文にする。空なら問題なし */
function issuesOf(i: IssueInput): string[] {
  const { found, ink, notes } = i;
  const issues: string[] = [];

  // Ghostscript が絵や文字を読み損ねた・書体を置き換えた(ログにだけ出ていた)
  if (notes.errorPages.size > 0) {
    const known = [...notes.errorPages].filter((p) => p > 0).sort((a, b) => a - b);
    const unknown = notes.errorPages.has(0);
    const where =
      known.length === 0
        ? '一部のページ'
        : // 6ページ以上・場所の分からないページもあるときは「…ページほか」。
          // 以前は「1, 2, 3, 4, 5 ほかページ」と崩れていた(2026-10-07 Gemini の校正で見つかった)
          `${known.slice(0, 5).join(', ')}ページ${known.length > 5 || unknown ? 'ほか' : ''}`;
    issues.push(`${where}の画像や文字を、正しく読めなかったかもしれません`);
  }
  if (notes.substituted.size > 0) {
    const names = [...notes.substituted].filter((n) => n);
    issues.push(`埋め込まれていない書体が、別の書体に置き換わりました${names.length > 0 ? `（${listed(names)}）` : ''}`);
  }
  if (i.repairFailed.length > 0) {
    issues.push(`PDF の中身が一部欠けていて、元に戻せなかった所が ${i.repairFailed.length} か所あります（${listed(i.repairFailed)}）`);
  }

  // 読めなかった所は、点検・インク・X-4 の3か所が同じ原因を別々に言うので、1つにまとめる
  const unreadable: string[] = [];
  const addUnreadable = (s: string) => {
    if (!unreadable.includes(s)) unreadable.push(s);
  };
  for (const s of found.unchecked) addUnreadable(s);
  const inkOther: string[] = [];
  for (const s of ink?.unhandled ?? []) {
    if (s.endsWith(INK_UNREADABLE_TAIL)) addUnreadable(s.slice(0, -INK_UNREADABLE_TAIL.length));
    else inkOther.push(s);
  }
  const x4 = i.violations.filter((v) => !v.includes(X4_UNREADABLE));
  if (unreadable.length > 0) {
    issues.push(`読めなくて、色やインクを調べられなかった所が ${unreadable.length} か所あります（${listed(unreadable)}）`);
  }

  if (found.rgb.length > 0) {
    issues.push(`RGB の色の指定が ${found.rgb.length} か所に残りました（${listed(found.rgb)}）`);
  }
  if (found.notGray.length > 0) {
    issues.push(`K 以外の色の指定が ${found.notGray.length} か所に残りました（${listed(found.notGray)}）`);
  }
  if (ink) {
    if (ink.unhandled.length > 0) {
      if (inkOther.length > 0) {
        issues.push(
          `インクの総量を ${ink.limit}% 以下に抑えられなかったかもしれない所が ${inkOther.length} か所あります（${listed(inkOther)}）`,
        );
      }
    } else if (ink.maxAfter > ink.limit + 0.01) {
      issues.push(`インクの総量の最大が ${ink.maxAfter.toFixed(1)}% で、上限 ${ink.limit}% を超えています`);
    }
  }

  // 黒い字やグレーを黒インクだけに直せなかった所(その結果、4色の黒のまま Ghostscript を通り、カラーのページに数えられる)。
  // 読めなかった所として上で言ったものは、ここでは数えない
  const neutralOps = (i.neutral?.opsSkipped ?? [])
    .filter((s) => !unreadable.includes(s.replace(/^描く命令 /, '')));
  if (neutralOps.length > 0) {
    issues.push(`黒い字やグレーを、黒インクだけに直せなかった所が ${neutralOps.length} か所あります（そのページはカラーに数えられます）`);
  }

  // グレーの濃さを直せなかった絵や塗り(JPEG のまま残ったグレーの絵など)。そこだけ、画面より明るく刷られる
  const toneSkipped = (i.tone?.skipped ?? []).filter((s) => !unreadable.some((u) => s.includes(u)));
  if (toneSkipped.length > 0) {
    issues.push(`グレーの濃さを直せなかった所が ${toneSkipped.length} か所あります（そこは、画面より明るく刷られます。${listed(toneSkipped)}）`);
  }

  if (x4.length > 0) {
    issues.push(`PDF/X-4 の決まりに合わない所が ${x4.length} か所あります（${listed(x4)}）`);
  }
  return issues;
}
