// Word(.docx)を mammoth に渡す前の下ごしらえ。
//
// **mammoth は、読み方を知らない要素を中身の字ごと捨てる。**(2026-09-25 見直し S1-7、
// 2026-09-26 ユーザーの実原稿で再現「Word のルビ機能を付けた語が本文ごと消えた」)
// node_modules/mammoth/lib/docx/body-reader.js の readXmlElement は、対応表に無い要素を
// 「An unrecognised element was ignored」の警告だけ残して、子要素(＝本文の字)をたどらない。
// ルビ(w:ruby)は日本語の原稿でよく使われるので、ルビを振った語がそのまま消えていた
// (「吾輩は薔薇の檸檬の香りがする。」→「はのの香りがする。」)。
//
// そこで、mammoth に渡す前に XML を直す:
// - **ルビは、スタジオのルビの記号 `｜親《よみ》` に置き換える。** 字が残るだけでなく、ルビも生きる
// - 字を包んでいるだけの要素(フィールド・独自 XML・文字の向き・変更履歴の「移動先」)はほどいて、
//   中の字を残す
// - 変更履歴の「移動元」(w:moveFrom)は、移したあとには無い字なので外す
// - 字を持たないのに mammoth が知らない要素は、知っている形に直すか外す
//   (行送り w:cr → 改行 w:br、位置タブ w:ptab → タブ w:tab、独自 XML の設定 w:customXmlPr は外す)。
//   残すと、字が落ちていないのに「読めない部分がありました」と断ることになる
// 本文・脚注・文末脚注の3つを直す。どれも無いファイルは、そのまま返す(開き直さない)

import JSZip from 'jszip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const PARTS = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'];
/** 字を包んでいるだけの要素。ほどいて中身を残す */
const UNWRAP = ['fldSimple', 'customXml', 'dir', 'bdo', 'moveTo'];
/** この中に1つも無ければ、XML を読み直さない */
const TOUCH = /<w:(ruby|fldSimple|customXml|dir|bdo|moveTo|moveFrom|cr|ptab)\b/;
/** 同じ意味で mammoth が読める要素へ置き換えるもの(どちらも字を持たない) */
const RENAME: Record<string, string> = { cr: 'br', ptab: 'tab' };

export interface DocxPrep {
  buffer: ArrayBuffer;
  /** ルビの記号に置き換えた数 */
  ruby: number;
}

/** その要素の中の字(w:t)を、並び順につなげる */
function textIn(el: Element | undefined): string {
  if (!el) return '';
  return Array.from(el.getElementsByTagNameNS(W, 't'))
    .map((t) => t.textContent ?? '')
    .join('');
}

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

export async function prepareDocx(buffer: ArrayBuffer): Promise<DocxPrep> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    // ZIP として開けないものは mammoth にそのまま渡し、あちらの断りに任せる
    return { buffer, ruby: 0 };
  }
  let ruby = 0;
  let changed = false;
  for (const name of PARTS) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    if (!TOUCH.test(xml)) continue;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) continue;

    for (const r of Array.from(doc.getElementsByTagNameNS(W, 'ruby'))) {
      const base = textIn(r.getElementsByTagNameNS(W, 'rubyBase')[0]);
      const reading = textIn(r.getElementsByTagNameNS(W, 'rt')[0]);
      const t = doc.createElementNS(W, 'w:t');
      t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      // 親字か読みの片方しか無いときは、親字だけを残す(読みだけを本文に出さない)
      t.textContent = base && reading ? `｜${base}《${reading}》` : base;
      r.parentNode?.replaceChild(t, r);
      ruby++;
    }
    for (const tag of UNWRAP) {
      for (const el of Array.from(doc.getElementsByTagNameNS(W, tag))) unwrap(el);
    }
    for (const tag of ['moveFrom', 'customXmlPr']) {
      for (const el of Array.from(doc.getElementsByTagNameNS(W, tag))) el.parentNode?.removeChild(el);
    }
    for (const [from, to] of Object.entries(RENAME)) {
      for (const el of Array.from(doc.getElementsByTagNameNS(W, from))) {
        el.parentNode?.replaceChild(doc.createElementNS(W, `w:${to}`), el);
      }
    }
    zip.file(name, new XMLSerializer().serializeToString(doc));
    changed = true;
  }
  if (!changed) return { buffer, ruby };
  return { buffer: await zip.generateAsync({ type: 'arraybuffer' }), ruby };
}

/**
 * mammoth が読み飛ばした要素のうち、**字を持っていたもの**の種類の数。
 * 字を持たない要素(設定・しるし)を飛ばしても本文は欠けないので、断りの数に入れない。
 * `names` は mammoth の警告に出る名前(`w:xxx`)。下ごしらえ後のファイルで調べる
 */
export async function droppedTextKinds(buffer: ArrayBuffer, names: string[]): Promise<number> {
  if (!names.length) return 0;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return names.length;
  }
  const docs: Document[] = [];
  for (const name of PARTS) {
    const file = zip.file(name);
    if (file) docs.push(new DOMParser().parseFromString(await file.async('string'), 'application/xml'));
  }
  let kinds = 0;
  for (const qname of names) {
    const local = qname.replace(/^w:/, '');
    const hasText = docs.some((d) =>
      Array.from(d.getElementsByTagNameNS(W, local)).some(
        (el) => el.getElementsByTagNameNS(W, 't').length > 0,
      ),
    );
    if (hasText) kinds++;
  }
  return kinds;
}
