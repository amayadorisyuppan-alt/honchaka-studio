// 色を変えたあとの PDF を、PDF/X-4(ISO 15930-7:2010。PDF 1.6 が土台)の形に整える。と、合っているかを点検する。
//
// なぜ自分で整えるか: Ghostscript の -dPDFX と -dHaveTransparency=false は、この WASM 版ではスタジオの実際の PDF で落ちる
// (2026-09-27 試作)。試作では OutputIntent を pdfmark で足すところまでしか確かめておらず、独立の検証で
// 「TrimBox が無い・Trapped が無い・透明のグループの色空間が DeviceRGB のまま」と指摘された。
// pdf-lib で、決まりを1つずつ満たし、1つずつ点検する(checkPdfx4)。
//
// **無料で PDF/X への適合を確かめる道具は見つからなかった。** 規格の原文(ISO 15930-7)は有料で、手元で読めていない。
// だから下の一覧は、公開の資料(出どころを付けた)から拾った決まりと、それをこのファイルでどう満たすか。
// 最後は受け取る印刷所のチェックで確かめてもらう。「何を根拠に・何を満たしたか」が後から読めるように残す。
//
// ── 決まりの一覧(2026-10-01 に調べた) ──────────────────────────────────────────
//  出どころの略号:
//   [AN] NPES「Application Notes for PDF/X Standards Version 4」2006-09(printtechnologies.org。X-4 の最終規格より前の版の
//        解説。X-1a/X-3 と共通の部分に使った)  [PT] prepressure.com「What is PDF/X-4」 [MV] Matthias Valvekens の
//        PDF/X の解説(mvalvekens.be/blog/2023/itext-pdfx)  [TX] LaTeX pdfx パッケージの pdfx.xmp(X-4 の XMP の雛形そのもの)
//   [GS] Ghostscript の文書 VectorDevices と lib/PDFX_def.ps  [CR] ICC 登録簿 registry.color.org
//   [PR] 無料の検査の道具(duon.zendesk.com の pdfToolbox の説明、GravityPDF/mpdf の X-4 の修正の記録)
//   [自] 出どころが見つからず、リーダーの理解・check-press.py・自分の判断で決めたもの(自信が低い)
//
//  1. ヘッダは %PDF-1.6 以下。Catalog の /Version も 1.6 以下。暗号化なし。 [GS: X-4 は PDF 1.6 で書く][AN: 暗号化は不可]
//     → savePdfx4 がヘッダを 1.6 にする(pdf-lib は 1.7 と書く)
//  2. trailer に /ID(2つの文字列)。 [AN 2.22: ID の一意性][自: 必須とするのは check-press と PR の記録による]
//     → 無ければ作る(pdf-lib 製の表紙には無い。Chrome の本文にも無い。Ghostscript の出力には在る)
//  3. Catalog の /OutputIntents に /S /GTS_PDFX を1つ以上。複数あるなら同じ印刷条件。 [AN 2.16][PT][MV]
//     OutputConditionIdentifier は必須。登録された条件でなければ /Info と /DestOutputProfile を付ける。
//     プロファイルは出力機器(prtr)の ICC。/N が色空間の成分数と同じ(CMYK なら 4)。
//     → ICC を Flate で詰めて埋め込む。識別子は登録簿の参照名 JCS2011(Japan Color 2011 Coated。JC200103 は 2001 の別物)、
//       /RegistryName (http://www.color.org)。埋め込むので、登録簿を見られない受け取り側でも成り立つ [CR]
//  4. X-4 の版の印は XMP の pdfxid:GTS_PDFXVersion = PDF/X-4。**Info の /GTS_PDFXVersion は、資料が割れている。**
//     Info の側は X-1a・X-3 の印で、X-4 では「置いてよいが、要らない」と読める資料と、「在るとエラー」と読める資料がある(2026-10-01):
//      - 書く側(置いてよい・無いとエラーにする点検の設定が在る): PDF/X-4 を書き出す道具の大半がこの重複を書いている。
//        pdf-aktuell.ch「Missing PDF/X entry in PDF/X-4 files from QuarkXPress」は、X-4 では置いてよいが要らないと注釈し、
//        PDFX-ready の設定は無いとエラーにする。Acrobat のプリフライトは在っても通す [PT][TX]
//      - 書かない側(在るとエラー): callas 系の点検に「PDF/X entry in Document info present (must only be present in XMP metadata)
//        [PDF/X-4]」があるという検索結果(duon.zendesk.com。ページ本文は 403 で読めず、題だけ)。InDesign の X-4 の出力はこの形(Info に置かない)
//     受け取る印刷所の点検がどちらか分からないので、いまは**書く**(WRITE_INFO_PDFX_VERSION = true)。印刷所から「Info に置くと
//     落ちる」と言われたら、この定数を false にするだけで「書かない・在れば違反」に切り替わる(点検・check-press.py も同じ向きに従う)。
//     [AN: X-1a/X-3 は Info][PT][TX]
//     → 書く側: Info の GTS_PDFXVersion は (PDF/X-4) にする。書かない側: 消す。GTS_PDFXConformance(X-1a・X-3 だけの項目)は常に消す
//  5. XMP(Catalog の /Metadata。/Type /Metadata /Subtype /XML。圧縮しない):
//     pdfxid:GTS_PDFXVersion、dc:title、xmp:CreateDate・ModifyDate・MetadataDate、pdf:Trapped(True か False)、
//     xmpMM:DocumentID・VersionID・RenditionClass。 [PT][MV][TX: VersionID=1・RenditionClass=default][PR]
//     Info の Title・CreationDate・ModDate・Trapped は XMP と食い違わせない。 [PR][自: check-press も同じ]
//     → 作り直す。Producer は Info と XMP で同じ文字。Trapped は /False [AN 2.17: 名前で書く。Unknown は不可。
//       未トラップで受け取り側に任せるなら False]。Info の Title・CreationDate・ModDate・Trapped も必ず書く
//  6. 箱: MediaBox は必須。TrimBox か ArtBox の**どちらか一方**(両方は不可)。BleedBox が在れば TrimBox・ArtBox は
//     その外に出ない。CropBox が在れば TrimBox・ArtBox はその外に出ない。 [AN 2.10]
//     → TrimBox だけ書き、BleedBox は MediaBox と同じ、CropBox・ArtBox は消す(親の Pages が持つ CropBox も)
//  7. 色: デバイスに依らない色か、出力の条件と同じ種類のデバイスの色。CMYK の出力条件では DeviceCMYK・DeviceGray は可、
//     DeviceRGB は不可。透明の合成グループの /CS も同じ。 [MV][PR: mpdf の記録][AN 2.16]
//     → 合成グループの RGB を opts.blend に直す。**スタジオの方針として、CalRGB・ICCBased(3成分)も「RGB の残り」にする**
//       (X-4 の規格はこれらを許す。入稿の色は全部 CMYK/K にしたいので、残っていたら知らせる)
//  8. フォントは全部埋め込み(Type3 は字形を PDF が持つので可)。Symbol・ZapfDingbats も埋め込みが要る。 [PT][MV][PR]
//  9. 注釈: ほとんどの種類は BleedBox の外に置く。PrinterMark は BleedBox の中でも TrimBox の外なら可。TrapNet も可。 [AN 2.28]
//     JavaScript・フォーム・動画・音は不可。 [PT][PR]
//     → PrinterMark・TrapNet 以外の注釈を全部外す(BleedBox = MediaBox なので「外に置く」ことができない)。AcroForm も外す
// 10. 動作(Action): JavaScript・Launch・Sound・Movie・ResetForm・ImportData・Hide・SetOCGState・Rendition・Trans・GoTo3DView は不可。
//     /OpenAction・/AA(追加の動作)、/Names の /JavaScript・/EmbeddedFiles は置かない。埋め込みファイルは X-4p だけ。 [PR][PT][自]
//     (check-press.py は URI・GoTo も咎める。スタジオの PDF にはどちらも無いので、同じ結果になる)
// 11. ExtGState の /TR は不可(/Identity は可)、/TR2 は /Default だけ、/HTP は不可。ハーフトーンは Type 1 か 5 だけで
//     HalftoneName・TransferFunction は不可。OPI(/OPI)・代替画像(/Alternates)・参照 XObject(/Ref)・
//     PostScript の XObject(/Subtype /PS)は不可。 [GS: pdf_check_forbidden_*][AN 2.24][自: 同じ並びが check-press に在る]
// 12. LZW(LZWDecode)は不可。JPEG2000(JPXDecode)は X-4 では制限つきで許される(色空間・SMaskInData)。
//     スタジオの変換は JPX を作らないので、在れば「点検の対象外」として落とす。 [AN 2.7][自]
// 13. レイヤー(OCG)は X-4 で使える。決まり: 設定(/OCProperties の /D と /Configs)に /AS を置かない。
//     スタジオの PDF には無い(Chrome は OCG を作らない)。ほかの道具が作った PDF には在りうるので、消す(2026-10-01)。
//     /AS は「開く・見る・印刷」の事象で層を自動で切り替える仕掛けで、消しても層の見え方(/D の /ON・/OFF)は変わらない。 [PR: mpdf の記録][自: 低い]
//
//  リーダーの理解と違った点・確かめきれなかった点は、報告に書いた(RegistryName の名前・Info の GTS_PDFXVersion・
//  CropBox の入れ子・JPX・OCG)。
//
// Node 24 でそのまま動く書き方にしてある(scripts/press/pdfx.test.ts が node で回す)。ブラウザ専用の物は使わない。
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFHeader,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import { contentHolders, deflate, operations, readStream } from './content.ts';
import type { PaperMismatch, PdfxReport, PressBoxes } from './types.ts';

export interface PdfxOptions {
  /** Japan Color 2011 Coated の ICC（src/press/JapanColor2011Coated.icc の中身） */
  icc: Uint8Array;
  /** 書名。空なら「無題」 */
  title: string;
  boxes: PressBoxes;
  /** 透明の合成のグループの色空間。白黒の本は 'DeviceGray'、カラーは 'DeviceCMYK' */
  blend: 'DeviceGray' | 'DeviceCMYK';
  /** 作った日時（検査で固定できるように外から渡す） */
  now: Date;
  /** 検査で値を固定したいときだけ。ふつうは渡さない(DocumentID は元の XMP の物を引き継ぎ、無ければ作る) */
  ids?: { documentId?: string; instanceId?: string };
  /** Info に /GTS_PDFXVersion を書くか。検査で両方の向きを確かめるときだけ渡す(ふつうは WRITE_INFO_PDFX_VERSION) */
  infoVersionMark?: boolean;
}

export interface PdfxCheckOptions {
  /** Info の /GTS_PDFXVersion を要るとするか(true)・在れば違反とするか(false)。ふつうは WRITE_INFO_PDFX_VERSION */
  infoVersionMark?: boolean;
  /**
   * 紙の大きさが違って箱を書かなかったページ(1 始まり)。TrimBox が無いのは紙の大きさが違うことの結果なので、「TrimBox がありません」とは言わない
   * (利用者に分からない言葉で、原因は紙の大きさ。4-1 の 4)
   */
  paperMismatchPages?: number[];
}

/** 直した中身の内訳(報告の fixed の中身。画面には出さず、検査・開発者向け) */
export interface PdfxDetail {
  /** 箱を書き換えたページ */
  boxPages: number;
  /** 透明の合成グループの色空間を直した数 */
  groups: number;
  /** SMask の下地の色(/BC)を直した数 */
  backdrops: number;
  /** 外した注釈 */
  annots: number;
  /** 消した、在ってはいけないもの(動作・埋め込みファイル・転送関数など) */
  forbidden: number;
  /** どこからも指されていなくて、捨てたオブジェクト(fixed には数えない) */
  orphans: number;
}

export interface PdfxResult extends PdfxReport {
  detail: PdfxDetail;
  /** 紙の大きさが合わなかったとき。合っていれば null(型は PdfxReport と同じで、ここでは必ず入る) */
  paperMismatch: PaperMismatch | null;
}

const PT_PER_MM = 72 / 25.4;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 元の MediaBox が名目より小さくてよい幅・大きくてよい幅(mm)。
 *
 * Chrome は用紙を px の格子に四捨五入するので、名目より**大きい側にも小さい側にも**振れる。素の Chrome(headless)で
 * A5+塗り足し 3.2mm を出すと、高さが名目より 0.161mm 小さく、幅が 0.099mm 大きかった。12 通りの寸法で、幅は −0.144〜+0.144mm、
 * 高さは −0.161〜+0.139mm(2026-10-01 実測。reports/2-1.md)。スタジオの道(Vivliostyle → 印刷)で出した実物は6辺とも大きい側
 * (+0.09〜+0.18mm)だったが、判型や塗り足しの数字しだいで小さい側に出ないとは言えない。0.05mm だと、正しい PDF を「別の本の PDF」と断った。
 * だから小さい側も 0.3mm(実測の最大 0.161mm の約 2 倍)まで許す。大きい側は 1mm のまま。
 *
 * 小さい側に振れた PDF は、MediaBox を名目の大きさで書くと、足りないぶん(最大 0.16mm)が元の紙の右と下の外に出る(中身の無い帯)。
 * 白のまま残す: 塗り足しの端が最大 0.16mm 欠けるだけで、そこは断裁で落ちる所(塗り足し 3mm の 5% 以下)なので実害は無い。
 * MediaBox を元の大きさのまま書くと、TrimBox の位置が名目とずれ、check-press.py の箱の検査(許す差 0.05mm)で落ちる
 */
const SMALLER_MM = 0.3;
const LARGER_MM = 1;
/**
 * Info の /GTS_PDFXVersion を書くか。true=書く(無ければ違反)、false=書かない(在れば違反)。冒頭の 4 に資料の割れ方を書いた。
 * 受け取る印刷所の点検に合わせて切り替える(PdfxOptions.infoVersionMark・checkPdfx4 の引数でも検査のために上書きできる)
 */
export const WRITE_INFO_PDFX_VERSION = true;
/** 箱の入れ子の比べで許す数字の丸め(pt)。PDF は小数 5 桁まで */
const NEST_TOL = 0.01;

/** OutputIntent の中身(出どころは冒頭の 3) */
const INTENT = {
  identifier: 'JCS2011',
  registry: 'http://www.color.org',
  condition: 'Japan Color 2011 Coated',
  info: 'Japan Color 2011 Coated',
};
/**
 * Producer の後ろに足す、スタジオが整えた印(Ghostscript の表記は AGPL の表示として元のまま残す)。
 * **入口で「すでに入稿用に変えた PDF」を見分けるのにも使う**(isPdfx)ので、書く所と見る所で同じ定数を使い、文字を2か所に書かない
 */
export const PRODUCER_SUFFIX = 'PDF/X-4 finish by the book studio (pdf-lib)';

const NS_PDFX = 'http://www.npes.org/pdfx/ns/id/';
const NS_PDF = 'http://ns.adobe.com/pdf/1.3/';
const NS_XMP = 'http://ns.adobe.com/xap/1.0/';
const NS_DC = 'http://purl.org/dc/elements/1.1/';
const NS_MM = 'http://ns.adobe.com/xap/1.0/mm/';

const N = (s: string) => PDFName.of(s);

// ───────────────────────── 箱 ─────────────────────────

type Rect = [number, number, number, number];

/**
 * boxes と、そのページの MediaBox から、整えたあとの箱（pt。[左, 下, 右, 上]）を出す。
 *
 * Chrome の PDF は、中身が用紙の**左上**に寄っていて、名目の用紙(仕上がり + 塗り足し)より大きいぶんが右と下に出る
 * (SPEC.md 7。color-a5.pdf は MediaBox 428.88×613.92pt に対し、全面の絵は左上から 428.60×613.42pt)。
 * だから MediaBox は「元の左上を保って、名目の大きさちょうど」に切り直す。
 * 元の MediaBox が名目より 0.3mm 以上小さい・1mm 以上大きいときは、別の本の PDF か設定と合わない PDF なので problem を返す
 * (箱は名目で計算して返すが、書き込むかどうかは呼ぶ側が problem を見て決める)。
 * そのとき紙の大きさは mismatch に値でも入れる(画面が文を探さずに判断できるように)。
 * 小さい側に振れた PDF(Chrome が格子に丸めて最大 0.16mm 小さく出す)は、名目の大きさで書くので、足りないぶんが元の紙の外に出る(SMALLER_MM の注)。
 * boxes の数が使えない(有限でない・負・仕上がりが 0 以下)ときは、箱を計算せず problem だけを返す(media・trim は元の MediaBox)
 */
export function pageBoxesPt(
  boxes: PressBoxes,
  pageIndex: number,
  media: { x: number; y: number; width: number; height: number },
): { media: Rect; trim: Rect; problem?: string; mismatch?: { actualMm: { w: number; h: number }; expectedMm: { w: number; h: number } } } {
  const bad = boxesProblem(boxes);
  if (bad) {
    const rect: Rect = [media.x, media.y, media.x + media.width, media.y + media.height];
    return { media: rect, trim: rect, problem: bad };
  }
  let nomW: number;
  let nomH: number;
  // 仕上がりの枠の、用紙の左・上からの距離(mm)と、その大きさ
  let left: number;
  let top: number;
  let trimW: number;
  let trimH: number;
  if (boxes.kind === 'body') {
    nomW = boxes.trimW + boxes.bleedFore + boxes.bleedGutter;
    nomH = boxes.trimH + boxes.bleedTop + boxes.bleedBottom;
    // 1ページ目(pageIndex 0)のノドが firstGutter の側で、以後交互
    const gutter = pageIndex % 2 === 0 ? boxes.firstGutter : boxes.firstGutter === 'left' ? 'right' : 'left';
    left = gutter === 'right' ? boxes.bleedFore : boxes.bleedGutter;
    top = boxes.bleedTop;
    trimW = boxes.trimW;
    trimH = boxes.trimH;
  } else {
    nomW = boxes.trimW + boxes.bleed * 2;
    nomH = boxes.trimH + boxes.bleed * 2;
    left = boxes.bleed;
    top = boxes.bleed;
    trimW = boxes.trimW;
    trimH = boxes.trimH;
  }
  const w = nomW * PT_PER_MM;
  const h = nomH * PT_PER_MM;
  const x0 = media.x;
  const y1 = media.y + media.height;
  const out: Rect = [round4(x0), round4(y1 - h), round4(x0 + w), round4(y1)];
  const trim: Rect = [
    round4(x0 + left * PT_PER_MM),
    round4(y1 - (top + trimH) * PT_PER_MM),
    round4(x0 + (left + trimW) * PT_PER_MM),
    round4(y1 - top * PT_PER_MM),
  ];
  const diffW = media.width / PT_PER_MM - nomW;
  const diffH = media.height / PT_PER_MM - nomH;
  let problem: string | undefined;
  let mismatch: { actualMm: { w: number; h: number }; expectedMm: { w: number; h: number } } | undefined;
  if (diffW < -SMALLER_MM || diffW > LARGER_MM || diffH < -SMALLER_MM || diffH > LARGER_MM) {
    const mm = (v: number) => Math.round(v * 100) / 100;
    const actualMm = { w: mm(media.width / PT_PER_MM), h: mm(media.height / PT_PER_MM) };
    const expectedMm = { w: mm(nomW), h: mm(nomH) };
    problem = `${pageIndex + 1}ページの紙の大きさ（${actualMm.w}×${actualMm.h}mm）が、この本の用紙（${expectedMm.w}×${expectedMm.h}mm）と違います`;
    mismatch = { actualMm, expectedMm };
  }
  return { media: out, trim, problem, mismatch };
}

/** 箱の数が使えない理由(使えるなら null)。NaN の TrimBox を書くと、点検が「BleedBox が MediaBox の外」と的外れなことを言う(2-1 の 6) */
function boxesProblem(boxes: PressBoxes): string | null {
  const vals = boxes.kind === 'body' ? [boxes.bleedTop, boxes.bleedBottom, boxes.bleedFore, boxes.bleedGutter] : [boxes.bleed];
  const ok = Number.isFinite(boxes.trimW) && boxes.trimW > 0 && Number.isFinite(boxes.trimH) && boxes.trimH > 0 && vals.every((v) => Number.isFinite(v) && v >= 0);
  return ok ? null : '箱の大きさ(仕上がり・塗り足し)の数値が使えません。書き出しの設定を確かめて、もう一度書き出してください';
}

// ───────────────────────── pdf-lib の小道具 ─────────────────────────

function dictOf(v: unknown): PDFDict | null {
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return null;
}

function nameOf(v: unknown): string | null {
  return v instanceof PDFName ? v.decodeText() : null;
}

function numsOf(v: unknown): number[] | null {
  if (!(v instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) {
    const x = v.lookup(i);
    if (!(x instanceof PDFNumber)) return null;
    out.push(x.asNumber());
  }
  return out;
}

function rectOf(v: unknown): Rect | null {
  const a = numsOf(v);
  if (!a || a.length !== 4) return null;
  return [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
}

/** ページの辞書から Parent をたどって、継ぐ項目(MediaBox・CropBox・Rotate・Resources)を探す */
function inherited(node: PDFDict, key: PDFName): PDFObject | undefined {
  const seen = new Set<PDFDict>();
  let cur: PDFDict | null = node;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const v = cur.lookup(key);
    if (v !== undefined) return v;
    cur = dictOf(cur.lookup(N('Parent')));
  }
  return undefined;
}

type Node = PDFDict | PDFArray;

/** 参照はたどらず、直に入っている辞書と配列を全部渡す(参照先は別の番号で必ず来る) */
function walkDirect(root: unknown, fn: (n: Node) => void): void {
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFStream) stack.push(v.dict);
    else if (v instanceof PDFDict) {
      fn(v);
      for (const [, x] of v.entries()) stack.push(x);
    } else if (v instanceof PDFArray) {
      fn(v);
      for (const x of v.asArray()) stack.push(x);
    }
  }
}

/** 文書の中のオブジェクトを、番号と一緒に総なめする(どこからも指されていないものも) */
function eachObject(doc: PDFDocument, fn: (ref: PDFRef, top: PDFObject) => void): void {
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) fn(ref, obj);
}

type Family = 'gray' | 'rgb' | 'cmyk' | 'lab' | 'other';

/** 色空間が、何の色か。名前でも配列でも、参照でも */
function family(doc: PDFDocument, cs: unknown, depth = 0): Family {
  if (depth > 6) return 'other';
  const v = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (v instanceof PDFName) {
    switch (v.decodeText()) {
      case 'DeviceGray':
      case 'G':
      case 'CalGray':
        return 'gray';
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
        return 'rgb';
      case 'DeviceCMYK':
      case 'CMYK':
        return 'cmyk';
      default:
        return 'other';
    }
  }
  if (!(v instanceof PDFArray) || v.size() === 0) return 'other';
  switch (nameOf(v.lookup(0))) {
    case 'CalGray':
      return 'gray';
    case 'CalRGB':
      return 'rgb';
    case 'Lab':
      return 'lab';
    case 'ICCBased': {
      const s = v.lookup(1);
      const n = s instanceof PDFStream ? s.dict.lookup(N('N')) : null;
      const c = n instanceof PDFNumber ? n.asNumber() : 0;
      return c === 1 ? 'gray' : c === 3 ? 'rgb' : c === 4 ? 'cmyk' : 'other';
    }
    case 'Indexed':
    case 'I':
    case 'Pattern':
      return v.size() > 1 ? family(doc, v.get(1), depth + 1) : 'other';
    case 'Separation':
    case 'DeviceN':
      return v.size() > 2 ? family(doc, v.get(2), depth + 1) : 'other';
    default:
      return family(doc, v.lookup(0), depth + 1);
  }
}

const COMPONENTS: Record<Family, number> = { gray: 1, rgb: 3, cmyk: 4, lab: 3, other: 0 };

// ───────────────────────── ICC ─────────────────────────

/** ICC の頭(128 バイト)から、PDF/X の出力機器のプロファイルとして使えるかを見る。使えないなら理由 */
function iccProblem(icc: Uint8Array): string | null {
  if (icc.length < 128) return 'ICC プロファイルが短すぎます';
  const tag = (o: number) => String.fromCharCode(icc[o], icc[o + 1], icc[o + 2], icc[o + 3]);
  if (tag(36) !== 'acsp') return 'ICC プロファイルとして読めません';
  if (tag(12) !== 'prtr') return `印刷機のプロファイル(prtr)ではありません(${tag(12)})`;
  if (tag(16) !== 'CMYK') return `CMYK のプロファイルではありません(${tag(16)})`;
  if (icc[8] !== 2 && icc[8] !== 4) return `ICC の版が 2 でも 4 でもありません(${icc[8]})`;
  return null;
}

// ───────────────────────── 日付・XMP ─────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0');

/** PDF の日付文字列を読む。ISO 8601 の同じ時刻と、PDF の書き方(元の文字をそのまま保つ)を返す */
function parsePdfDate(s: string): { pdf: string; iso: string; ms: number } | null {
  const m = /^D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?(?:([Zz])|([+-])(\d\d)?'?(\d\d)?'?)?/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2] ?? '01', m[3] ?? '01', m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'];
  const sign = m[8];
  const tzMin = sign ? (sign === '-' ? -1 : 1) * (Number(m[9] ?? 0) * 60 + Number(m[10] ?? 0)) : 0;
  const tz = sign ? `${sign}${m[9] ?? '00'}:${m[10] ?? '00'}` : 'Z';
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)) - tzMin * 60000;
  if (!Number.isFinite(ms)) return null;
  return { pdf: s.trim(), iso: `${y}-${mo}-${d}T${h}:${mi}:${se}${tz}`, ms };
}

function dateFor(date: Date): { pdf: string; iso: string; ms: number } {
  const iso = date.toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    pdf: `D:${date.getUTCFullYear()}${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())}Z`,
    iso,
    ms: Math.floor(date.getTime() / 1000) * 1000,
  };
}

/** 書名の長さの上限(字)。PDF の文字列は 32767 バイトまでで、20000 字の書名は Info の /Title が 80KB になった(2026-10-01) */
const TITLE_MAX = 200;

/**
 * 書名を1回だけ整える。**Info にも XMP にも、この結果を入れる**(別々に直すと食い違い、点検が嘘をつく。2-1 の 3・4)。
 *  - 改行・タブ・制御文字(NUL・\u0001〜\u001f・\u007f〜\u009f)は空白にする。\r や \r\n を残すと、XML として読むと \n に畳まれ Info と食い違う
 *  - U+FFFE・U+FFFF と、対になっていないサロゲートは除く(XML に書けない文字。lxml が「Char 0xFFFE out of allowed range」で読めなかった)
 *  - 前後の空白を取り、200 字(コードポイント。サロゲートの途中では切らない)で切って、切ったあとの末尾の空白も取る
 *  - 空になったら「無題」
 */
export function cleanTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let t = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  // 対になったサロゲートは残し、孤立したもの(上位だけ・下位だけ)は除く。u フラグ無しなので、1 文字ずつ(UTF-16 の単位で)読む
  t = t.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').replace(/[\ufffe\uffff]/g, '');
  t = t.trim();
  const cps = [...t];
  if (cps.length > TITLE_MAX) t = cps.slice(0, TITLE_MAX).join('').trim();
  return t || '無題';
}

/** Producer・CreatorTool など、書名以外の1行の文字。XML に書けない文字を空白にする(Info と XMP を同じ文字にそろえるため) */
// eslint-disable-next-line no-control-regex
const cleanLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/g, ' ').trim();

const xmlEscape = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const xmlUnescape = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * XMP の値を読む(XML の読み手が Node には無いので、書き方の決まった範囲だけ)。名前空間は接頭辞ではなく URI で引く。
 * 要素(<p:x>…</p:x>。rdf:Alt・Seq の中の最初の rdf:li も)でも、属性(p:x="…")でも読める
 * (Ghostscript は属性で書く。どちらも正しい XMP)
 */
function xmpValue(xml: string, ns: string, local: string): string | null {
  const prefixes: string[] = [];
  const re = /xmlns:([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) if (m[2] === ns) prefixes.push(m[1]);
  for (const p of prefixes) {
    const name = `${p}:${local}`;
    const attr = new RegExp(`[\\s<]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xml);
    if (attr) return xmlUnescape(attr[1] ?? attr[2] ?? '').trim();
    const el = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
    if (el) {
      const li = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/.exec(el[1]);
      return xmlUnescape((li ? li[1] : el[1]).trim());
    }
  }
  return null;
}

function metadataXml(doc: PDFDocument): string | null {
  const meta = doc.catalog.lookup(N('Metadata'));
  if (!(meta instanceof PDFRawStream)) return null;
  // XMP は圧縮しない決まり。圧縮されていても読めないので null(点検が咎める)
  if (meta.dict.get(N('Filter'))) return null;
  return new TextDecoder('utf-8').decode(meta.contents);
}

interface XmpFields {
  title: string;
  producer: string;
  creatorTool: string;
  create: string;
  modify: string;
  documentId: string;
  instanceId: string;
  versionId: string;
}

function buildXmp(f: XmpFields): Uint8Array {
  const t = xmlEscape;
  const lines = [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="pdf-lib">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `<rdf:Description rdf:about="" xmlns:pdfxid="${NS_PDFX}" xmlns:pdf="${NS_PDF}" xmlns:xmp="${NS_XMP}" xmlns:dc="${NS_DC}" xmlns:xmpMM="${NS_MM}">`,
    '<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>',
    '<dc:format>application/pdf</dc:format>',
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${t(f.title)}</rdf:li></rdf:Alt></dc:title>`,
    `<pdf:Producer>${t(f.producer)}</pdf:Producer>`,
    '<pdf:Trapped>False</pdf:Trapped>',
    ...(f.creatorTool ? [`<xmp:CreatorTool>${t(f.creatorTool)}</xmp:CreatorTool>`] : []),
    `<xmp:CreateDate>${f.create}</xmp:CreateDate>`,
    `<xmp:ModifyDate>${f.modify}</xmp:ModifyDate>`,
    `<xmp:MetadataDate>${f.modify}</xmp:MetadataDate>`,
    `<xmpMM:DocumentID>${t(f.documentId)}</xmpMM:DocumentID>`,
    `<xmpMM:InstanceID>${t(f.instanceId)}</xmpMM:InstanceID>`,
    `<xmpMM:VersionID>${t(f.versionId)}</xmpMM:VersionID>`,
    '<xmpMM:RenditionClass>default</xmpMM:RenditionClass>',
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    // あとから別の道具が書き足せるように、空きを少し残すのが XMP の慣習
    ...Array.from({ length: 8 }, () => ' '.repeat(100)),
    '<?xpacket end="w"?>',
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

function textOf(v: unknown): string {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return '';
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ───────────────────────── 整える ─────────────────────────

/** 動作の種類のうち、PDF/X-4 で置いてはいけないもの(冒頭の 10) */
const FORBIDDEN_ACTIONS = new Set([
  'JavaScript', 'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide', 'SetOCGState', 'Rendition', 'Trans',
  'GoTo3DView', 'SubmitForm', 'GoToE',
]);

/** 辞書にそのまま在ってはいけない鍵(冒頭の 9・10・11)。値の中身を見ずに消す・咎める */
const FORBIDDEN_KEYS: Record<string, string> = {
  JS: 'JavaScript',
  AA: '追加の動作(AA)',
  OpenAction: '開いたときの動作',
  EmbeddedFiles: '埋め込みファイル',
  EF: '埋め込みファイル',
  Movie: '動画',
  Sound: '音',
  Rendition: 'レンディション',
  RichMedia: 'リッチメディア',
  '3D': '3D',
  Trans: 'ページ切り替え効果',
  OPI: 'OPI',
  Alternates: '代替画像',
  Ref: '参照 XObject',
  XFA: 'XFA',
  AcroForm: 'フォーム',
};

const KEEP_ANNOTS = new Set(['PrinterMark', 'TrapNet']);

/**
 * doc を PDF/X-4 の形に整える（doc を直に書き換える）。整えたあと checkPdfx4 をかけて、残ったものを violations に入れて返す。
 *
 * doc は `PDFDocument.load(bytes, { updateMetadata: false })` で開いたもの(既定の true だと、読み込んだ時点で
 * Producer・日付を pdf-lib が書き換える。ここで Info を書き直すので害は無いが、元の CreationDate を保てなくなる)
 */
export async function applyPdfx4(doc: PDFDocument, opts: PdfxOptions): Promise<PdfxResult> {
  const ctx = doc.context;
  const problem = iccProblem(opts.icc);
  if (problem) throw new Error(`色の基準(ICC)が使えません: ${problem}`);
  const detail: PdfxDetail = { boxPages: 0, groups: 0, backdrops: 0, annots: 0, forbidden: 0, orphans: 0 };
  const violations: string[] = [];
  const blendComps = COMPONENTS[opts.blend === 'DeviceGray' ? 'gray' : 'cmyk'];

  // 1. 箱(全ページ)
  const pages = doc.getPages();
  const cropOnAncestors = new Set<PDFDict>();
  const sizeProblems: string[] = [];
  // 紙の大きさが合わなかったページ(1 始まり)と、最初の1枚の実寸・期待の大きさ(値で返す。画面は violations の文を探さない)
  const mismatchPages: number[] = [];
  const mismatchSizes: Pick<PaperMismatch, 'actualMm' | 'expectedMm'>[] = [];
  // 箱の入力そのものが使えないときは、全ページで箱を書かない(1回だけ知らせる)
  const boxInputProblem = boxesProblem(opts.boxes);
  if (boxInputProblem) violations.push(boxInputProblem);
  pages.forEach((page, i) => {
    if (boxInputProblem) return;
    const node = page.node;
    const rot = inherited(node, N('Rotate'));
    if (rot instanceof PDFNumber && rot.asNumber() % 360 !== 0) {
      violations.push(`${i + 1}ページは回転(/Rotate ${rot.asNumber()})がかかっています。箱の位置を決められないので、PDF の向きを直してください`);
      return;
    }
    if (node.has(N('UserUnit'))) {
      violations.push(`${i + 1}ページは用紙の単位(/UserUnit)が変えてあります。箱の大きさを決められないので、保存し直してください`);
      return;
    }
    const mb = rectOf(inherited(node, N('MediaBox')));
    if (!mb || mb[2] <= mb[0] || mb[3] <= mb[1]) {
      violations.push(`${i + 1}ページに用紙の大きさ(MediaBox)がありません`);
      return;
    }
    const b = pageBoxesPt(opts.boxes, i, { x: mb[0], y: mb[1], width: mb[2] - mb[0], height: mb[3] - mb[1] });
    if (b.problem) {
      sizeProblems.push(b.problem);
      mismatchPages.push(i + 1);
      if (b.mismatch) mismatchSizes.push(b.mismatch);
      return;
    }
    // 親の Pages が CropBox を持っていると、子が継ぐ。ページの側では消せないので、親からも消す
    for (let p = dictOf(node.lookup(N('Parent'))); p && !cropOnAncestors.has(p); p = dictOf(p.lookup(N('Parent')))) {
      cropOnAncestors.add(p);
      p.delete(N('CropBox'));
    }
    const same = (k: string, want: Rect) => {
      const r = rectOf(node.lookup(N(k)));
      return !!r && r.every((v, j) => Math.abs(v - want[j]) < 0.00005);
    };
    const unchanged =
      same('MediaBox', b.media) && same('TrimBox', b.trim) && same('BleedBox', b.media) && !node.has(N('CropBox')) && !node.has(N('ArtBox'));
    if (!unchanged) {
      node.set(N('MediaBox'), ctx.obj(b.media));
      node.set(N('TrimBox'), ctx.obj(b.trim));
      node.set(N('BleedBox'), ctx.obj(b.media));
      node.delete(N('CropBox'));
      node.delete(N('ArtBox'));
      detail.boxPages++;
    }
  });
  // 大きさの違うページは、1ページずつ並べると長くなるので、先頭だけ見せて数を添える
  if (sizeProblems.length) {
    violations.push(sizeProblems[0] + (sizeProblems.length > 1 ? `(ほか ${sizeProblems.length - 1} ページも同じ)` : ''));
  }

  // 2. 透明の合成の色空間と、SMask の下地の色
  const setBlend = (g: PDFDict) => {
    if (nameOf(g.lookup(N('S'))) !== 'Transparency') return;
    const cs = g.get(N('CS'));
    if (cs === undefined) return;
    const fam = family(doc, cs);
    if (fam === 'rgb' || fam === 'lab') {
      g.set(N('CS'), N(opts.blend));
      detail.groups++;
    }
  };
  const fixBackdrops: PDFDict[] = [];
  eachObject(doc, (_ref, top) => {
    walkDirect(top, (n) => {
      if (!(n instanceof PDFDict)) return;
      setBlend(n);
      if (nameOf(n.lookup(N('S'))) === 'Luminosity' && n.lookup(N('BC')) instanceof PDFArray) fixBackdrops.push(n);
    });
  });
  // グループの色空間を直したあとで、下地の色の成分数を合わせる(合わせる先は、その SMask のグループの色空間)
  for (const sm of fixBackdrops) {
    const bc = numsOf(sm.lookup(N('BC')));
    if (!bc) continue;
    const g = dictOf(sm.lookup(N('G')));
    const gcs = g?.get(N('CS'));
    const want = gcs !== undefined ? COMPONENTS[family(doc, gcs)] || blendComps : blendComps;
    if (bc.length === want) continue;
    const lum =
      bc.length === 3
        ? 0.3 * bc[0] + 0.59 * bc[1] + 0.11 * bc[2]
        : bc.length === 4
          ? 1 - Math.min(1, 0.3 * bc[0] + 0.59 * bc[1] + 0.11 * bc[2] + bc[3])
          : bc.length === 1
            ? bc[0]
            : null;
    if (lum === null) continue;
    const v = Math.round(lum * 1000) / 1000;
    sm.set(N('BC'), ctx.obj(want === 1 ? [v] : want === 4 ? [0, 0, 0, Math.round((1 - v) * 1000) / 1000] : [v, v, v]));
    detail.backdrops++;
  }

  // 5. 注釈(PrinterMark・TrapNet は残す。空の /Annots [] も消す)
  for (const page of pages) {
    const raw = page.node.lookup(N('Annots'));
    if (!(raw instanceof PDFArray)) continue;
    const keep: PDFObject[] = [];
    for (const item of raw.asArray()) {
      const d = dictOf(item instanceof PDFRef ? ctx.lookup(item) : item);
      if (d && KEEP_ANNOTS.has(nameOf(d.lookup(N('Subtype'))) ?? '')) keep.push(item);
      else detail.annots++;
    }
    if (keep.length === 0) page.node.delete(N('Annots'));
    else if (keep.length !== raw.size()) page.node.set(N('Annots'), ctx.obj(keep));
  }

  // 6. 在ってはいけないもの
  const cat = doc.catalog;
  // レイヤーの設定の /AS(冒頭の 13)。層の見え方(/D の /ON・/OFF)は変わらない
  const ocProps = dictOf(cat.lookup(N('OCProperties')));
  if (ocProps) {
    const cfgs: (PDFDict | null)[] = [dictOf(ocProps.lookup(N('D')))];
    const more = ocProps.lookup(N('Configs'));
    if (more instanceof PDFArray) for (let i = 0; i < more.size(); i++) cfgs.push(dictOf(more.lookup(i)));
    for (const c of cfgs) {
      if (c?.has(N('AS'))) {
        c.delete(N('AS'));
        detail.forbidden++;
      }
    }
  }
  for (const k of ['OpenAction', 'AA', 'AcroForm']) {
    if (cat.has(N(k))) {
      cat.delete(N(k));
      detail.forbidden++;
    }
  }
  const names = dictOf(cat.lookup(N('Names')));
  if (names) {
    for (const k of ['JavaScript', 'EmbeddedFiles']) {
      if (names.has(N(k))) {
        names.delete(N(k));
        detail.forbidden++;
      }
    }
    if (names.keys().length === 0) cat.delete(N('Names'));
  }
  if (cat.has(N('Version'))) {
    // Catalog の /Version はヘッダより優先される。1.6 より大きければ消して、ヘッダ(1.6)に任せる
    const v = nameOf(cat.lookup(N('Version')));
    const m = v ? /^(\d)\.(\d)/.exec(v) : null;
    if (!m || Number(m[1]) * 10 + Number(m[2]) > 16) cat.delete(N('Version'));
  }
  eachObject(doc, (_ref, top) => {
    walkDirect(top, (n) => {
      if (!(n instanceof PDFDict)) return;
      for (const k of ['AA', 'Trans', 'Alternates', 'OPI', 'PresSteps']) {
        if (n.has(N(k))) {
          n.delete(N(k));
          detail.forbidden++;
        }
      }
      if (n.has(N('TR')) && nameOf(n.lookup(N('TR'))) !== 'Identity') {
        n.delete(N('TR'));
        detail.forbidden++;
      }
      if (n.has(N('TR2')) && nameOf(n.lookup(N('TR2'))) !== 'Default') {
        n.delete(N('TR2'));
        detail.forbidden++;
      }
      if (n.has(N('HTP'))) {
        n.delete(N('HTP'));
        detail.forbidden++;
      }
      const ht = n.lookup(N('HT'));
      if (ht instanceof PDFDict && badHalftone(ht)) {
        n.delete(N('HT'));
        detail.forbidden++;
      }
    });
  });

  // 3. OutputIntent(同じ ICC が既に入っていれば、そのストリームを使い回す。2回かけても二重にならない)
  let profileRef: PDFRef | null = null;
  const oldIntents = cat.lookup(N('OutputIntents'));
  if (oldIntents instanceof PDFArray) {
    for (const x of oldIntents.asArray()) {
      const d = dictOf(x instanceof PDFRef ? ctx.lookup(x) : x);
      const pref = d?.get(N('DestOutputProfile'));
      if (!(pref instanceof PDFRef)) continue;
      const s = ctx.lookup(pref);
      if (!(s instanceof PDFRawStream)) continue;
      try {
        const data = await readStream(s);
        if (data && Buffer_equal(data, opts.icc)) {
          profileRef = pref;
          break;
        }
      } catch {
        /* 壊れた古いプロファイルは使わない */
      }
    }
  }
  if (!profileRef) {
    profileRef = ctx.register(ctx.stream(await deflate(opts.icc), { Filter: 'FlateDecode', N: 4, Alternate: 'DeviceCMYK' }));
  }
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFX',
    OutputConditionIdentifier: PDFString.of(INTENT.identifier),
    RegistryName: PDFString.of(INTENT.registry),
    OutputCondition: PDFString.of(INTENT.condition),
    Info: PDFString.of(INTENT.info),
    DestOutputProfile: profileRef,
  });
  cat.set(N('OutputIntents'), ctx.obj([ctx.register(intent)]));

  // 4. Info と XMP
  const title = cleanTitle(opts.title);
  const infoRef0 = ctx.trailerInfo.Info;
  let info = dictOf(infoRef0 instanceof PDFRef ? ctx.lookup(infoRef0) : infoRef0);
  if (!info) {
    const ref = ctx.register(ctx.obj({}));
    ctx.trailerInfo.Info = ref;
    info = ctx.lookup(ref) as PDFDict;
  }
  const now = dateFor(opts.now);
  const created = parsePdfDate(textOf(info.lookup(N('CreationDate'))));
  const creation = created && created.ms <= now.ms ? created : now;
  const oldProducer = cleanLine(textOf(info.lookup(N('Producer'))));
  const producer = oldProducer.includes(PRODUCER_SUFFIX) ? oldProducer : oldProducer ? `${oldProducer}; ${PRODUCER_SUFFIX}` : PRODUCER_SUFFIX;
  const creator = cleanLine(textOf(info.lookup(N('Creator'))));
  const oldXmp = metadataXml(doc);
  const oldId = oldXmp ? xmpValue(oldXmp, NS_MM, 'DocumentID') : null;
  const oldVersion = oldXmp && xmpValue(oldXmp, NS_PDFX, 'GTS_PDFXVersion') === 'PDF/X-4' ? Number(xmpValue(oldXmp, NS_MM, 'VersionID')) : 0;
  const documentId = opts.ids?.documentId ?? (oldId && /^uuid:[0-9a-f-]{36}$/i.test(oldId) ? oldId : `uuid:${crypto.randomUUID()}`);
  const instanceId = opts.ids?.instanceId ?? `uuid:${crypto.randomUUID()}`;
  info.set(N('Title'), PDFHexString.fromText(title));
  info.set(N('CreationDate'), PDFString.of(creation.pdf));
  info.set(N('ModDate'), PDFString.of(now.pdf));
  info.set(N('Trapped'), N('False'));
  info.set(N('Producer'), PDFString.of(producer));
  if (opts.infoVersionMark ?? WRITE_INFO_PDFX_VERSION) info.set(N('GTS_PDFXVersion'), PDFString.of('PDF/X-4'));
  else info.delete(N('GTS_PDFXVersion'));
  info.delete(N('GTS_PDFXConformance'));
  const xmp = buildXmp({
    title,
    producer,
    creatorTool: creator,
    create: creation.iso,
    modify: now.iso,
    documentId,
    instanceId,
    versionId: String(Number.isFinite(oldVersion) && oldVersion > 0 ? oldVersion + 1 : 1),
  });
  const metaStream = ctx.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  const oldMeta = cat.get(N('Metadata'));
  if (oldMeta instanceof PDFRef) ctx.assign(oldMeta, metaStream);
  else cat.set(N('Metadata'), ctx.register(metaStream));

  // ヘッダと /ID。ヘッダは書き出すときに pdf-lib が 1.7 にするので savePdfx4 で直す(ここは点検を通すための印)
  ctx.header = PDFHeader.forVersion(1, 6);
  ensureId(doc);

  detail.orphans = dropUnreachable(doc);
  violations.push(...(await checkPdfx4(doc, { infoVersionMark: opts.infoVersionMark, paperMismatchPages: mismatchPages })));
  const fixed = detail.boxPages + detail.groups + detail.backdrops + detail.annots + detail.forbidden;
  const paperMismatch: PaperMismatch | null =
    mismatchPages.length && mismatchSizes.length ? { pages: mismatchPages, actualMm: mismatchSizes[0].actualMm, expectedMm: mismatchSizes[0].expectedMm } : null;
  return { fixed, violations, detail, paperMismatch };
}

function Buffer_equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** ハーフトーンの辞書が X-4 の決まりに合わないか(冒頭の 11) */
function badHalftone(ht: PDFDict): boolean {
  const type = ht.lookup(N('HalftoneType'));
  const t = type instanceof PDFNumber ? type.asNumber() : 0;
  return ht.has(N('HalftoneName')) || ht.has(N('TransferFunction')) || (t !== 1 && t !== 5);
}

/** trailer の /ID を、無ければ作る(同じ16バイトを2つ。Ghostscript もそう書く) */
function ensureId(doc: PDFDocument): void {
  const id = doc.context.trailerInfo.ID;
  if (id instanceof PDFArray && id.size() === 2 && id.asArray().every((x) => x instanceof PDFHexString || x instanceof PDFString)) return;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const h = PDFHexString.of(hex(bytes));
  doc.context.trailerInfo.ID = doc.context.obj([h, h]);
}

/**
 * Root・Info から指されていないオブジェクトを捨てる。pdf-lib は指されていないものも書き出すので、
 * 外した注釈・消した埋め込みファイル・古い ICC が、見えないまま文書に残ってしまう
 * (残ると「リンクの動作が在る」と、入稿の点検の道具は言う)
 */
function dropUnreachable(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: unknown[] = [];
  const push = (v: unknown) => {
    if (v) stack.push(v);
  };
  push(ctx.trailerInfo.Root);
  push(ctx.trailerInfo.Info);
  push(ctx.trailerInfo.Encrypt);
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFRef) {
      const key = v.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(ctx.lookup(v));
    } else if (v instanceof PDFStream) stack.push(v.dict);
    else if (v instanceof PDFDict) for (const [, x] of v.entries()) stack.push(x);
    else if (v instanceof PDFArray) for (const x of v.asArray()) stack.push(x);
  }
  const drop: PDFRef[] = [];
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) drop.push(ref);
  for (const r of drop) ctx.delete(r);
  return drop.length;
}

// ───────────────────────── 入口の見分け(変換の前に、doc を読むだけ) ─────────────────────────

/**
 * すでに入稿用(PDF/X)に変えた PDF か。入口で断るのに使う。**変換を2度かけると、グレーが2度濃くなる**(4-1 の 1。
 * 濃さの直しは「直したあとの PDF か」を PDF から見分けられず、1回だけ呼ぶ決まりのため)。
 * 次のどれかが在れば「入稿用」と見る(スタジオの出力は全部に当たる。ほかの道具が作った PDF/X も、どれかに当たれば同じ扱い):
 *   - Producer に、スタジオが足した印(PRODUCER_SUFFIX)
 *   - XMP の pdfxid:GTS_PDFXVersion(版は問わない)
 *   - Info の /GTS_PDFXVersion
 *   - Catalog の /OutputIntents に /S /GTS_PDFX
 * Chrome の印刷で保存した PDF・Ghostscript の素の出力には、どれも無い(実物 3 本・変換前の出力で確かめた)
 */
export function isPdfx(doc: PDFDocument): boolean {
  const ctx = doc.context;
  const infoRaw = ctx.trailerInfo.Info;
  const info = dictOf(infoRaw instanceof PDFRef ? ctx.lookup(infoRaw) : infoRaw);
  if (info) {
    if (textOf(info.lookup(N('Producer'))).includes(PRODUCER_SUFFIX)) return true;
    if (textOf(info.lookup(N('GTS_PDFXVersion'))).trim() !== '') return true;
  }
  const xml = metadataXml(doc);
  if (xml !== null && xmpValue(xml, NS_PDFX, 'GTS_PDFXVersion') !== null) return true;
  const intents = doc.catalog.lookup(N('OutputIntents'));
  if (intents instanceof PDFArray) {
    for (const x of intents.asArray()) {
      const d = dictOf(x instanceof PDFRef ? ctx.lookup(x) : x);
      if (d && nameOf(d.lookup(N('S'))) === 'GTS_PDFX') return true;
    }
  }
  return false;
}

/**
 * 全ページの紙の大きさ(MediaBox)を、この本の用紙と比べる(許す差は pageBoxesPt と同じ)。合わなければ値で返す(合っていれば null)。
 * **変換を始める前に、紙の大きさの違う PDF を断るのに使う**(Ghostscript を回すと、39 ページで 15 秒・300 ページ超で数分、待ってから断られていた。4-2 の 2)。
 * applyPdfx4 と同じ見方: 箱の数が使えないとき・回転(/Rotate)や用紙の単位(/UserUnit)・MediaBox が無いページは、ここでは比べない
 * (それぞれ別の違反として applyPdfx4 が言う)
 */
export function findPaperMismatch(doc: PDFDocument, boxes: PressBoxes): PaperMismatch | null {
  if (boxesProblem(boxes)) return null;
  const pages: number[] = [];
  const sizes: Pick<PaperMismatch, 'actualMm' | 'expectedMm'>[] = [];
  doc.getPages().forEach((page, i) => {
    const node = page.node;
    const rot = inherited(node, N('Rotate'));
    if (rot instanceof PDFNumber && rot.asNumber() % 360 !== 0) return;
    if (node.has(N('UserUnit'))) return;
    const mb = rectOf(inherited(node, N('MediaBox')));
    if (!mb || mb[2] <= mb[0] || mb[3] <= mb[1]) return;
    const b = pageBoxesPt(boxes, i, { x: mb[0], y: mb[1], width: mb[2] - mb[0], height: mb[3] - mb[1] });
    if (b.mismatch) {
      pages.push(i + 1);
      sizes.push(b.mismatch);
    }
  });
  return pages.length > 0 ? { pages, actualMm: sizes[0].actualMm, expectedMm: sizes[0].expectedMm } : null;
}

// ───────────────────────── 点検 ─────────────────────────

/** 「3, 4, 5, 9」→「3〜5, 9」。長いときは先頭だけ見せて数を添える */
function pagesText(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}〜${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  // 7まとまり以上は先頭6つだけ見せて、全部の数を添える。
  // 以前は「1, 2, … ほか 20 ページのうちページ」と崩れていた(2026-10-07 Gemini の校正で見つかった)
  const head = parts.slice(0, 6).join(', ');
  return parts.length > 6 ? `${head} ページほか（全 ${sorted.length} ページ）` : `${head}ページ`;
}

/** オブジェクトの番号の一覧。長いときは先頭だけ */
function refsText(refs: string[]): string {
  const u = [...new Set(refs)];
  return u.slice(0, 4).join(', ') + (u.length > 4 ? ` ほか ${u.length - 4} 個` : '');
}

/** 動作の辞書か(S が禁止の動作名で、動作らしい Type か、Type が無い) */
function forbiddenAction(n: PDFDict): string | null {
  const s = nameOf(n.lookup(N('S')));
  if (!s || !FORBIDDEN_ACTIONS.has(s)) return null;
  const t = nameOf(n.lookup(N('Type')));
  return t === null || t === 'Action' ? s : null;
}

/** PDF/X-4 の決まりに合わないところを、利用者に見せられる日本語で返す（空なら合っている）。doc は書き換えない */
export async function checkPdfx4(doc: PDFDocument, opts: PdfxCheckOptions = {}): Promise<string[]> {
  const infoMark = opts.infoVersionMark ?? WRITE_INFO_PDFX_VERSION;
  const out: string[] = [];
  const ctx = doc.context;
  const cat = doc.catalog;

  // ヘッダ・暗号・ID(冒頭の 1・2)
  const hm = /%PDF-(\d)\.(\d)/.exec(ctx.header.toString());
  const major = hm ? Number(hm[1]) : 0;
  const minor = hm ? Number(hm[2]) : 0;
  if (major * 10 + minor > 16) out.push(`PDF の版が 1.6 より新しくなっています(%PDF-${major}.${minor})。PDF/X-4 は 1.6 までです`);
  const catVersion = nameOf(cat.lookup(N('Version')));
  if (catVersion) {
    const m = /^(\d)\.(\d)/.exec(catVersion);
    if (m && Number(m[1]) * 10 + Number(m[2]) > 16) out.push(`文書の版(/Version ${catVersion})が 1.6 より新しくなっています`);
  }
  if (ctx.trailerInfo.Encrypt) out.push('PDF にパスワードや編集の制限がかかっています(暗号化)。PDF/X では使えないので、制限を外して保存し直してください');
  const id = ctx.trailerInfo.ID;
  if (!(id instanceof PDFArray) || id.size() !== 2 || !id.asArray().every((x) => (x instanceof PDFHexString || x instanceof PDFString) && textOf(x) !== '')) {
    out.push('PDF の識別番号(trailer の /ID)がありません');
  }

  // OutputIntent(冒頭の 3)
  const intentsRaw = cat.lookup(N('OutputIntents'));
  const intents: PDFDict[] = [];
  if (intentsRaw instanceof PDFArray) {
    for (const x of intentsRaw.asArray()) {
      const d = dictOf(x instanceof PDFRef ? ctx.lookup(x) : x);
      if (d && nameOf(d.lookup(N('S'))) === 'GTS_PDFX') intents.push(d);
    }
  }
  if (intents.length === 0) out.push('印刷の条件(OutputIntent。色の基準)が入っていません');
  const intentKey = new Set<string>();
  for (const d of intents) {
    const ident = textOf(d.lookup(N('OutputConditionIdentifier'))).trim();
    if (!ident) out.push('印刷の条件(OutputIntent)に、条件の名前(OutputConditionIdentifier)がありません');
    intentKey.add(`${ident}|${String(d.get(N('DestOutputProfile')))}`);
    if (!d.has(N('RegistryName')) && !textOf(d.lookup(N('Info'))).trim()) {
      out.push('印刷の条件(OutputIntent)に、説明(/Info)がありません。登録された条件の名前でなければ、説明が要ります');
    }
    const s = d.lookup(N('DestOutputProfile'));
    if (!(s instanceof PDFRawStream)) {
      out.push('印刷の条件(OutputIntent)に、色の基準(ICC プロファイル)が埋め込まれていません');
      continue;
    }
    const n = s.dict.lookup(N('N'));
    if (!(n instanceof PDFNumber) || n.asNumber() !== 4) out.push(`色の基準(ICC)の成分数(/N)が 4 ではありません(${String(n)})`);
    try {
      const data = await readStream(s);
      const why = data ? iccProblem(data) : '圧縮の形式が読めません';
      if (why) out.push(`埋め込まれた色の基準(ICC)が使えません: ${why}`);
    } catch {
      out.push('埋め込まれた色の基準(ICC)の中身が壊れていて読めません');
    }
  }
  if (intents.length > 1 && intentKey.size > 1) out.push('印刷の条件(OutputIntent)が複数あり、同じものを指していません');

  // Info と XMP(冒頭の 4・5)
  const infoRaw = ctx.trailerInfo.Info;
  const info = dictOf(infoRaw instanceof PDFRef ? ctx.lookup(infoRaw) : infoRaw);
  const xml = metadataXml(doc);
  const metaObj = cat.lookup(N('Metadata'));
  if (!(metaObj instanceof PDFRawStream)) out.push('XMP(メタデータ。Catalog の /Metadata)がありません');
  else {
    if (metaObj.dict.has(N('Filter'))) out.push('XMP(メタデータ)が圧縮されています。圧縮しない決まりです');
    if (nameOf(metaObj.dict.lookup(N('Type'))) !== 'Metadata' || nameOf(metaObj.dict.lookup(N('Subtype'))) !== 'XML') {
      out.push('XMP(メタデータ)の種類(/Type /Metadata /Subtype /XML)が正しくありません');
    }
  }
  if (xml !== null) {
    const get = (ns: string, k: string) => xmpValue(xml, ns, k);
    const v = get(NS_PDFX, 'GTS_PDFXVersion');
    if (v !== 'PDF/X-4') out.push(`XMP の PDF/X の版(pdfxid:GTS_PDFXVersion)が PDF/X-4 になっていません(${v ?? 'なし'})`);
    const tr = get(NS_PDF, 'Trapped');
    if (tr !== 'True' && tr !== 'False') out.push(`XMP のトラッピングの印(pdf:Trapped)が True か False ではありません(${tr ?? 'なし'})`);
    for (const [ns, k, label] of [
      [NS_XMP, 'CreateDate', 'xmp:CreateDate(作成日)'],
      [NS_XMP, 'ModifyDate', 'xmp:ModifyDate(更新日)'],
      [NS_XMP, 'MetadataDate', 'xmp:MetadataDate(メタデータ更新日)'],
    ] as const) {
      const d = get(ns, k);
      if (!d || !Number.isFinite(Date.parse(d))) out.push(`XMP の ${label}がありません・日付として読めません`);
    }
    for (const [ns, k, label] of [
      [NS_DC, 'title', 'dc:title(書名)'],
      [NS_MM, 'DocumentID', 'xmpMM:DocumentID'],
      [NS_MM, 'VersionID', 'xmpMM:VersionID'],
      [NS_MM, 'RenditionClass', 'xmpMM:RenditionClass'],
    ] as const) {
      if (!get(ns, k)) out.push(`XMP の ${label}がありません`);
    }
    if (info) {
      const iTitle = textOf(info.lookup(N('Title'))).trim();
      const xTitle = get(NS_DC, 'title');
      if (!iTitle) out.push('書名(Info の /Title)がありません');
      else if (xTitle !== null && xTitle !== iTitle) out.push(`書名が Info と XMP で食い違っています(Info「${iTitle.slice(0, 30)}」XMP「${xTitle.slice(0, 30)}」)`);
      const iTrap = nameOf(info.lookup(N('Trapped')));
      if (iTrap !== 'True' && iTrap !== 'False') out.push(`Info の /Trapped が /True か /False ではありません(${iTrap ?? 'なし'}。Unknown やなしは PDF/X-4 では不可)`);
      else if (tr && tr !== iTrap) out.push(`トラッピングの印が Info(${iTrap})と XMP(${tr})で食い違っています`);
      for (const [ik, ns, xk, label] of [
        ['CreationDate', NS_XMP, 'CreateDate', '作成日'],
        ['ModDate', NS_XMP, 'ModifyDate', '更新日'],
      ] as const) {
        const di = parsePdfDate(textOf(info.lookup(N(ik))));
        if (!di) {
          out.push(`Info の${label}(/${ik})がありません・日付として読めません`);
          continue;
        }
        const dx = get(ns, xk);
        if (dx && Number.isFinite(Date.parse(dx)) && Math.abs(Date.parse(dx) - di.ms) > 1000) out.push(`${label}が Info と XMP で食い違っています`);
      }
      const iProd = textOf(info.lookup(N('Producer'))).trim();
      const xProd = get(NS_PDF, 'Producer');
      if (xProd !== null && iProd !== xProd) out.push('Producer(作った道具の名前)が Info と XMP で食い違っています');
    }
  }
  if (!info) out.push('文書の情報(Info)がありません');
  else {
    // Info の版の印(冒頭の 4。資料が割れているので WRITE_INFO_PDFX_VERSION で向きを切り替える)
    const iv = textOf(info.lookup(N('GTS_PDFXVersion'))).trim();
    if (infoMark) {
      // 書く側: XMP と同じ値で書く。無い・違うものは、無いとエラーにする点検で止まる
      if (iv !== 'PDF/X-4') out.push(`Info の PDF/X の版(/GTS_PDFXVersion)が PDF/X-4 になっていません(${iv || 'なし'})`);
    } else if (info.has(N('GTS_PDFXVersion'))) {
      // 書かない側: 在るとエラーにする点検(callas 系)で止まる
      out.push('Info の /GTS_PDFXVersion が残っています(PDF/X-4 では XMP だけに置く設定です)');
    }
    if (info.has(N('GTS_PDFXConformance'))) out.push('Info に /GTS_PDFXConformance が残っています(PDF/X-1a・X-3 だけの項目です)');
  }

  // 箱(冒頭の 6)
  const noTrim: number[] = [];
  const both: number[] = [];
  const badNest: string[] = [];
  const noMedia: number[] = [];
  const inside = (a: Rect, b: Rect) => a[0] >= b[0] - NEST_TOL && a[1] >= b[1] - NEST_TOL && a[2] <= b[2] + NEST_TOL && a[3] <= b[3] + NEST_TOL;
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const no = i + 1;
    const mb = rectOf(inherited(page.node, N('MediaBox')));
    if (!mb || mb[2] <= mb[0] || mb[3] <= mb[1]) {
      noMedia.push(no);
      return;
    }
    const tb = rectOf(page.node.lookup(N('TrimBox')));
    const ab = rectOf(page.node.lookup(N('ArtBox')));
    const bb = rectOf(page.node.lookup(N('BleedBox')));
    const cb = rectOf(inherited(page.node, N('CropBox')));
    if (!tb && !ab && !opts.paperMismatchPages?.includes(no)) noTrim.push(no);
    if (tb && ab) both.push(no);
    const inner = tb ?? ab;
    if (bb && !inside(bb, mb)) badNest.push(`${no}ページの BleedBox が MediaBox の外に出ています`);
    if (cb && !inside(cb, mb)) badNest.push(`${no}ページの CropBox が MediaBox の外に出ています`);
    if (inner && bb && !inside(inner, bb)) badNest.push(`${no}ページの仕上がりの枠(${tb ? 'TrimBox' : 'ArtBox'})が BleedBox の外に出ています`);
    if (inner && cb && !inside(inner, cb)) badNest.push(`${no}ページの仕上がりの枠(${tb ? 'TrimBox' : 'ArtBox'})が CropBox の外に出ています`);
  });
  if (noMedia.length) out.push(`${pagesText(noMedia)}に用紙の大きさ(MediaBox)がありません`);
  if (noTrim.length) out.push(`${pagesText(noTrim)}に仕上がりの枠(TrimBox)がありません`);
  if (both.length) out.push(`${pagesText(both)}に TrimBox と ArtBox の両方があります。どちらか一方だけにする決まりです`);
  if (badNest.length) out.push(badNest[0] + (badNest.length > 1 ? `(ほか ${badNest.length - 1} 件)` : ''));

  // 注釈(冒頭の 9)
  const annotPages: Record<string, number[]> = {};
  pages.forEach((page, i) => {
    const raw = page.node.lookup(N('Annots'));
    if (!(raw instanceof PDFArray)) return;
    for (const item of raw.asArray()) {
      const d = dictOf(item instanceof PDFRef ? ctx.lookup(item) : item);
      const st = (d && nameOf(d.lookup(N('Subtype')))) || '不明';
      if (!KEEP_ANNOTS.has(st)) (annotPages[st] ??= []).push(i + 1);
    }
  });
  for (const [st, ps] of Object.entries(annotPages)) out.push(`注釈(${st})が ${pagesText(ps)}にあります。印刷には要らないので外してください`);

  // 総なめ(辞書の鍵・動作・色空間・フォント・フィルタ・ハーフトーン)
  const keyHits: Record<string, string[]> = {};
  const actionHits: Record<string, string[]> = {};
  const rgbHits: Record<string, string[]> = { group: [], image: [], space: [], shading: [], name: [] };
  const fontHits: { ref: string; base: string }[] = [];
  const filterHits: Record<string, string[]> = {};
  const transferHits: string[] = [];
  const psHits: string[] = [];
  const externalHits: string[] = [];
  const ocgHits: string[] = [];
  const namesDict = dictOf(cat.lookup(N('Names')));
  for (const k of ['JavaScript', 'EmbeddedFiles']) if (namesDict?.has(N(k))) (keyHits[k] ??= []).push('Catalog');
  for (const k of ['OpenAction', 'AA', 'AcroForm']) if (cat.has(N(k))) (keyHits[k] ??= []).push('Catalog');
  const ocp = dictOf(cat.lookup(N('OCProperties')));
  if (ocp) {
    const cfgs = [dictOf(ocp.lookup(N('D')))];
    const more = ocp.lookup(N('Configs'));
    if (more instanceof PDFArray) for (let i = 0; i < more.size(); i++) cfgs.push(dictOf(more.lookup(i)));
    if (cfgs.some((c) => c?.has(N('AS')))) ocgHits.push('OCProperties');
  }
  eachObject(doc, (ref, top) => {
    const where = ref.toString();
    if (top instanceof PDFStream) {
      const sub = nameOf(top.dict.lookup(N('Subtype')));
      if (sub === 'PS') psHits.push(where);
      if (top.dict.has(N('F'))) externalHits.push(where);
    }
    walkDirect(top, (n) => {
      if (n instanceof PDFArray) {
        // 色空間の配列: [/CalRGB …]・[/ICCBased 3成分]・[/Indexed /DeviceRGB …]・[/Separation … /DeviceRGB …]
        const head = nameOf(n.lookup(0));
        if (head && /^(CalRGB|ICCBased|Indexed|I|Separation|DeviceN|Pattern)$/.test(head) && family(doc, n) === 'rgb') rgbHits.space.push(where);
        return;
      }
      for (const k of Object.keys(FORBIDDEN_KEYS)) if (n.has(N(k)) && k !== 'AA') (keyHits[k] ??= []).push(where);
      if (n.has(N('AA'))) (keyHits.AA ??= []).push(where);
      const act = forbiddenAction(n);
      if (act) (actionHits[act] ??= []).push(where);
      if (nameOf(n.lookup(N('Subtype2'))) === 'PS') psHits.push(where);
      const sub = nameOf(n.lookup(N('Subtype')));
      const type = nameOf(n.lookup(N('Type')));
      if (nameOf(n.lookup(N('S'))) === 'Transparency') {
        const cs = n.get(N('CS'));
        if (cs !== undefined && (family(doc, cs) === 'rgb' || family(doc, cs) === 'lab')) rgbHits.group.push(where);
      }
      if (sub === 'Image') {
        const cs = n.get(N('ColorSpace'));
        const mask = n.lookup(N('ImageMask'));
        if (cs !== undefined && !(mask && String(mask) === 'true') && family(doc, cs) === 'rgb') rgbHits.image.push(where);
      }
      if (n.has(N('ShadingType')) && n.has(N('ColorSpace')) && family(doc, n.get(N('ColorSpace'))) === 'rgb') rgbHits.shading.push(where);
      // 名前そのまま(/ColorSpace /DeviceRGB など)は上で数えた。それ以外の所に直に書かれた DeviceRGB
      for (const [k, v] of n.entries()) {
        if (k === N('ColorSpace') || k === N('CS') || k === N('Alternate') || k === N('DefaultRGB')) continue;
        if (v instanceof PDFName && (v.decodeText() === 'DeviceRGB' || v.decodeText() === 'CalRGB')) rgbHits.name.push(where);
      }
      // 色空間の資源(/ColorSpace << /Cs1 /DeviceRGB … >>)の値も、その名前で見る
      const csRes = n.get(N('ColorSpace'));
      if (csRes instanceof PDFDict) {
        for (const [, v] of csRes.entries()) if (v instanceof PDFName && family(doc, v) === 'rgb') rgbHits.space.push(where);
      }
      // フォント(冒頭の 8)
      if (type === 'Font' && (sub === 'Type1' || sub === 'TrueType' || sub === 'MMType1' || sub === 'Type0')) {
        const base = textOfName(n.lookup(N('BaseFont')));
        if (!fontEmbedded(n, sub)) fontHits.push({ ref: where, base });
      }
      // フィルタ(冒頭の 12)。配列でも名前でも
      const fv = n.lookup(N('Filter'));
      const names: string[] = fv instanceof PDFName ? [fv.decodeText()] : fv instanceof PDFArray ? fv.asArray().map((x) => nameOf(x instanceof PDFRef ? ctx.lookup(x) : x) ?? '') : [];
      for (const f of names) if (f === 'LZWDecode' || f === 'LZW' || f === 'JPXDecode' || f === 'Crypt') (filterHits[f === 'LZW' ? 'LZWDecode' : f] ??= []).push(where);
      // 転送関数・ハーフトーン(冒頭の 11)
      if (n.has(N('TR')) && nameOf(n.lookup(N('TR'))) !== 'Identity') transferHits.push(`${where}(/TR)`);
      if (n.has(N('TR2')) && nameOf(n.lookup(N('TR2'))) !== 'Default') transferHits.push(`${where}(/TR2)`);
      if (n.has(N('HTP'))) transferHits.push(`${where}(/HTP)`);
      const ht = n.lookup(N('HT'));
      if (ht instanceof PDFDict && badHalftone(ht)) transferHits.push(`${where}(ハーフトーン)`);
      if (type === 'Halftone' && (n.has(N('HalftoneName')) || n.has(N('TransferFunction')))) transferHits.push(`${where}(ハーフトーン)`);
      // 細部: OCG の /AS は上で Catalog から見た
    });
  });
  for (const [k, refs] of Object.entries(keyHits)) out.push(`PDF/X-4 では置けないもの「${FORBIDDEN_KEYS[k] ?? k}」があります(${refsText(refs)})`);
  for (const [act, refs] of Object.entries(actionHits)) out.push(`PDF/X-4 では置けない動作(${act})があります(${refsText(refs)})`);
  if (ocgHits.length) out.push('レイヤー(OCG)の設定に /AS(自動の切り替え)があります。PDF/X-4 では置けません');
  if (psHits.length) out.push(`PostScript の部品(/Subtype /PS)があります(${refsText(psHits)})`);
  if (externalHits.length) out.push(`PDF の外のファイルを指すデータがあります(${refsText(externalHits)})`);
  for (const [f, refs] of Object.entries(filterHits)) {
    if (f === 'LZWDecode') out.push(`LZW 圧縮のデータがあります(${refsText(refs)})。PDF/X では使えません`);
    else if (f === 'JPXDecode') out.push(`JPEG2000 の画像があります(${refsText(refs)})。PDF/X-4 は制限つきで許しますが、スタジオでは点検できません`);
    else out.push(`暗号化のフィルタ(Crypt)があります(${refsText(refs)})`);
  }
  if (transferHits.length) out.push(`転送関数・ハーフトーンの指定があります(${refsText(transferHits)})。PDF/X-4 では置けません`);
  if (fontHits.length) {
    const names = [...new Set(fontHits.map((f) => f.base || f.ref))];
    out.push(`書体が埋め込まれていません: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` ほか ${names.length - 4} 書体` : ''}(${fontHits.length}個)`);
  }

  // RGB の残り(冒頭の 7)。描く命令は、ページ・フォーム・パターン・Type3 の字形を全部開いて見る
  const skipped: string[] = [];
  const holders = await contentHolders(doc, skipped);
  const opPages: number[] = [];
  const opWhere: string[] = [];
  let opCount = 0;
  for (const h of holders) {
    let hits = 0;
    for (const o of operations(h.bytes)) {
      if (o.op === 'rg' || o.op === 'RG') hits++;
      else if ((o.op === 'cs' || o.op === 'CS') && o.operands.length === 1 && o.operands[0].type === 'name') {
        const nm = o.operands[0].text as string;
        if (nm === 'DeviceRGB' || nm === 'CalRGB') hits++;
      } else if (o.op === 'BI') {
        const d = o.operands;
        for (let k = 0; k + 1 < d.length; k++) {
          if (d[k].type === 'name' && (d[k].text === 'CS' || d[k].text === 'ColorSpace') && d[k + 1].type === 'name' && /^(RGB|DeviceRGB|CalRGB)$/.test(d[k + 1].text as string)) hits++;
        }
      }
    }
    if (hits) {
      opCount += hits;
      if (h.kind === 'page' && h.pageIndex !== undefined) opPages.push(h.pageIndex + 1);
      else opWhere.push(h.label);
    }
  }
  const rgbParts: string[] = [];
  if (rgbHits.group.length) rgbParts.push(`透明の合成グループの色空間 ${new Set(rgbHits.group).size} か所(${refsText(rgbHits.group)})`);
  if (rgbHits.image.length) rgbParts.push(`RGB の画像 ${new Set(rgbHits.image).size} 枚(${refsText(rgbHits.image)})`);
  if (rgbHits.shading.length) rgbParts.push(`RGB の影の指定 ${new Set(rgbHits.shading).size} か所(${refsText(rgbHits.shading)})`);
  if (rgbHits.space.length || rgbHits.name.length) {
    const all = [...rgbHits.space, ...rgbHits.name];
    rgbParts.push(`RGB の色空間の指定 ${new Set(all).size} か所(${refsText(all)})`);
  }
  if (opCount) rgbParts.push(`描く命令の RGB の色 ${opCount} か所(${[opPages.length ? pagesText(opPages) : '', ...opWhere.slice(0, 2)].filter(Boolean).join(', ')})`);
  if (rgbParts.length) out.push(`RGB の色が残っています: ${rgbParts.join('、')}`);
  if (skipped.length) {
    out.push(`中身を読めなかったものがあり、色を点検できていません: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ` ほか ${skipped.length - 3} 個` : ''}`);
  }
  return out;
}

function textOfName(v: unknown): string {
  return v instanceof PDFName ? v.decodeText() : '';
}

/** 書体が埋め込まれているか。Type0 は子孫の書体で見る(Type3 はここに来ない) */
function fontEmbedded(font: PDFDict, sub: string | null): boolean {
  let target: PDFDict | null = font;
  if (sub === 'Type0') {
    const d = font.lookup(N('DescendantFonts'));
    target = d instanceof PDFArray && d.size() > 0 ? dictOf(d.lookup(0)) : null;
    if (!target) return false;
  }
  const fd = dictOf(target.lookup(N('FontDescriptor')));
  return !!fd && (fd.has(N('FontFile')) || fd.has(N('FontFile2')) || fd.has(N('FontFile3')));
}

// ───────────────────────── 書き出し ─────────────────────────

/**
 * X-4 の形のまま書き出す。
 *
 * - ヘッダの版: **pdf-lib は書き出すとき、読み込んだ版に関わらず必ず `%PDF-1.7` と書く**(PDFWriter が決め打ち。2026-10-01 実測)。
 *   同じ長さなので、先頭を `%PDF-1.6` に差し替える
 * - 相互参照は古い形の表(`useObjectStreams: false`。印刷所の RIP に合わせる。gsWorker.ts と同じ理由)
 * - trailer の /ID: pdf-lib は読み込んだ /ID を保って書く(実測)。無い PDF(Chrome の本文・pdf-lib 製の表紙)は作る
 */
export async function savePdfx4(doc: PDFDocument): Promise<Uint8Array> {
  ensureId(doc);
  doc.context.header = PDFHeader.forVersion(1, 6);
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (head !== '%PDF-1.7' && head !== '%PDF-1.6') throw new Error(`PDF の先頭が想定と違います(${head})`);
  bytes.set(new TextEncoder().encode('%PDF-1.6'), 0);
  return bytes;
}
