// 印刷所の入稿ガイドの数字を、利用者の AI に読んでもらい、返ってきた数行をスタジオが読む。
// (2026-10-01 ユーザーと決定)
//
// ## なぜ本まるごとの JSON を往復させないか
//
// 欲しいのは5つの数字だけ(塗り足し・綴じる側にも付けるか・ノドの下限・厚い本のノド・背の縁のアキ)。
// 本全体を AI に渡して書き換えさせると、頼んでいない所まで壊れる危険のほうが大きい。
// 渡すのは**頼み方(PRINT_GUIDE_PROMPT)と印刷所のガイドだけ**。返ってくるのも数行。
//
// ## AI の返事は揺れる
//
// 「塗り足し: 3mm」と頼んでも、全角コロン・番号や「・」の付いた行・コードの囲み・表・
// 「3mm以上」「約3ミリ」「0.3cm」・前置きとまとめ付き、で返ることがある。
// **決まりは次のとおり**(scripts/printGuide.test.ts が揺れを30通り以上で確かめる):
//
//  - 前処理: 囲み行(```)・BOM・ゼロ幅文字を除き、NFKC で全角を半角へ。「根拠」だけは原文のまま見せる
//  - 行頭の飾り(- * ・ 1. 1) ※ > #)と太字の記号を剥ぐ。表の行は | で分ける
//  - ラベルは別名つきの前置一致。「綴じる側の塗り足し」を「塗り足し」より先に照合する
//    (区切り文字で切ると、区切りの無い「塗り足し 3mm」を落とす)
//  - **「不明」を真偽・数字より先に判定する。** 「記載なし」を「塗り足しなし」と読まないため。
//    不明の項目は**変えない**(= 「なし」とは別。厚い本: なし → 決まり無し、不明 → 触らない)
//  - 数字は先頭の1つ。cm・センチは×10、mm・ミリ・単位なしは mm。pt・インチ・漢数字は読めない行にする
//  - あり/なしは**否定を先に**見る(「必要ありません」の「あり」、「不要」の「要」の取り違え)
//  - 範囲外の数は入れない(理由を言う)。同じラベルが2回あれば最初
//
// **このファイルは何も import しない。** Node でそのまま検査できるようにするため。
// 範囲は引数で受ける(models/project.ts の PRINT_RULE_LIMITS がほんとうの持ち主)。

/** 返事に出てくる5つの項目 */
export type GuideItem = 'bleed' | 'bleedGutter' | 'gutterMin' | 'thick' | 'spineInset';

/** 画面と同じ呼び名(欄の名前と一字も違えない) */
export const GUIDE_ITEM_LABEL: Record<GuideItem, string> = {
  bleed: '塗り足し',
  bleedGutter: '綴じる側の塗り足し',
  gutterMin: 'ノドの下限',
  thick: '厚い本のノド',
  spineInset: '背の縁のアキ',
};

/** 数の範囲 [最小, 最大] */
export interface GuideLimits {
  bleedMm: readonly [number, number];
  gutterMinMm: readonly [number, number];
  thickPages: readonly [number, number];
  thickGutterMm: readonly [number, number];
  spineInsetMm: readonly [number, number];
}

/** いまの決まり(画面の欄の値)。印刷所の決まり5つ + 背の縁のアキ */
export interface GuideValues {
  bleedMm: number;
  bleedGutter: boolean;
  gutterMinMm: number;
  thickPages: number | null;
  thickGutterMm: number | null;
  spineInsetMm: number;
}

/** 読めなかった行。why は「単位が pt です」のような、分かる範囲の理由 */
export interface SkippedLine {
  line: string;
  why: string;
}

export interface ParsedGuide {
  /** 読めた値。**無い項目は「読めなかった」か「不明」** */
  bleedMm?: number;
  bleedGutter?: boolean;
  gutterMinMm?: number;
  /** 厚い本。null は「決まり無し」(= なし)。undefined は触らない */
  thick?: { pages: number; mm: number } | null;
  spineInsetMm?: number;
  /** 「不明」と書かれた項目(変えない) */
  unknown: GuideItem[];
  /** 範囲外などで入れなかったもの(文で言う) */
  rejected: string[];
  /** 項目の行らしいのに、数が読めなかった行(原文と、分かる範囲の理由) */
  skipped: SkippedLine[];
  /** 注意(同じ項目が2回・ほかの数字は読んでいません・段が複数、など) */
  notes: string[];
  /** 根拠。原文のまま */
  basis: string[];
  /** 項目の行として読めた数(不明も数える)。0 なら何も読めていない */
  found: number;
}

/**
 * 印刷所の入稿ガイドを読んでもらう頼み方。[頼み方をコピー] でコピーする。
 *
 * - 前置き・説明・コード囲み・太字・箇条書きの記号を付けさせない(読む側の揺れを減らす)
 * - **見本の数字に既定値(3・15・200・20)を書かない。** AI がそのまま写すと、既定と同じなので気づけなくなる
 * - 書かれていない項目は推測させず「不明」。不明は変えない
 * - **背幅は聞かない。** 背幅は紙の厚みとページ数で変わるので、ガイドの数字ではなく印刷所の見積もりで決まる
 */
export const PRINT_GUIDE_PROMPT = `添付した（または貼った）印刷所の入稿ガイドを読んで、紙の本の「本文」を入稿するときの数字を、下の6行だけで答えてください。
前置き・説明・まとめ・コードブロック・太字・箇条書きの記号は付けないでください。
数字は半角のアラビア数字にして、mm に直してください（cm や pt は換算してください）。
ガイドに書かれていない項目は、推測せず「不明」と書いてください。
塗り足し: ◯mm（仕上がりの外側に足す幅。ガイドでは「ドブ」「裁ち落とし」「ブリード」とも）
綴じる側の塗り足し: あり または なし（綴じる側にも塗り足しを付けるか）
ノドの下限: ◯mm（綴じる側の余白の最小。ガイドでは「綴じしろ」「ノド」とも）
厚い本: ◯ページをこえたら ◯mm（ページ数でノドが広がる決まりがなければ「なし」。境目が複数あれば、いちばん小さい1つだけ）
背の縁のアキ: ◯mm（表紙の背の縁から文字を離す幅）
根拠: 各数字がガイドのどこに書いてあったか（ページ・見出し）を1行で。長い引用はしないでください`;

// ---------------------------------------------------------------------------
// 前処理
// ---------------------------------------------------------------------------

/** 行の頭に付く飾り。**1つずつ剥ぐ**(「- 1. 塗り足し」のように重なることがある) */
const LEAD_DECOR = /^(?:[-*+•・●○■□◆◇▶▷>※★☆→▪▫◦‣]+|#{1,6}|\d{1,2}[.)、]|\(\d{1,2}\))\s*/;

/** 区切り(ラベルと値のあいだ・値の頭)。引用符も区切りとして落とす */
const SEP_HEAD = /^[\s:=,、，;"'「」『』“”‘’|｜]+/;

function normalizeLine(raw: string): string {
  // ①〜⑳ は NFKC で "1" になり、「1塗り足し」と区切りの無い形になる。先に落とす
  let s = raw.replace(/^\s*[①-⑳⑴-⒇❶-❿]\s*/, '');
  s = s.normalize('NFKC');
  // 太字・コード・下線の記号(行のどこにあっても)
  s = s.replace(/\*\*|__|`/g, '');
  // 行頭の飾りを、なくなるまで
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^\s+/, '').replace(LEAD_DECOR, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/^\s+|\s+$/g, '');
}

/** 箇所ごとの表(| 塗り足し | 3mm | p.2 |)の仕切り行 */
const TABLE_RULE = /^[\s|:\-ー–—=]+$/;
/** 水平線 */
const HR = /^[-=_*~—–]{3,}$/;

/** コードの囲み行(```json など)と、BOM・ゼロ幅文字を除いた行の並び */
function splitLines(text: string): { raw: string; norm: string }[] {
  const out: { raw: string; norm: string }[] = [];
  const cleaned = text.replace(/[﻿​-‍⁠]/g, '');
  for (const raw of cleaned.split(/\r\n|\r|\n/)) {
    const t = raw.trim();
    if (t === '') continue;
    if (/^(?:```|~~~)/.test(t)) continue;
    if (HR.test(t) || TABLE_RULE.test(t.normalize('NFKC'))) continue;
    out.push({ raw: t, norm: normalizeLine(t) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ラベル
// ---------------------------------------------------------------------------

/** 「ノド側」「綴じる側」などの、綴じる側を指す言い方 */
const GUTTER_SIDE = '(?:綴じる側|綴じ側|ノド側|ノド|内側|背側|綴じ代|綴じしろ|綴じ)';
/** 塗り足しの別名。ガイドでは「ドブ」「裁ち落とし」とも呼ばれる */
const BLEED_WORD = '(?:塗り足し|塗足し|塗りたし|裁ち落とし|裁ち落し|裁落とし|裁落し|断ち落とし|ドブ|ブリード)';

const LABELS: { item: GuideItem | 'basis'; re: RegExp }[] = [
  { item: 'basis', re: /^(?:根拠|出典|参照元|参照|理由|ソース|source|basis|reference)/i },
  // **綴じる側の塗り足しを、塗り足しより先に照合する**
  {
    item: 'bleedGutter',
    re: new RegExp(`^(?:${GUTTER_SIDE}(?:の|にも|には|に|へも|へ)?${BLEED_WORD}|(?:gutter|binding[- ]side|inside|inner)\\s*bleed)`, 'i'),
  },
  { item: 'bleed', re: new RegExp(`^(?:${BLEED_WORD}|bleed)`, 'i') },
  {
    item: 'thick',
    re: /^(?:厚い本のノド|厚い本の場合|厚い本|厚い場合|厚い冊子|厚めの本|厚みのある本|ページ数が多い場合|ページ数が多い本|ページ数の多い本|ページが多い場合|ページ数による(?:ノド|加算|違い)?|thick(?:\s*books?)?)/i,
  },
  {
    item: 'spineInset',
    re: /^(?:背の縁のアキ|背の縁の空き|背の縁のあき|背の縁|背のアキ|背のあき|背の空き|背アキ|背縁|背の余白|背からのアキ|背からの余白|spine(?:\s*inset|\s*margin)?)/i,
  },
  {
    item: 'gutterMin',
    re: /^(?:(?:ノド|綴じ代|綴じしろ|綴じ側|綴じる側|内側|綴じ|gutter|binding margin|inside margin)(?:の|側の|側)?(?:下限値|下限|最小値|最低値|最小|最低|余白|マージン|幅|アキ|あき|空き|綴じ代|margin)?)/i,
  },
];

/** 「塗り足しの根拠: …」のように、項目名のあとに根拠が続く行 */
const BASIS_AFTER = /^(?:の|は)?(?:根拠|出典|理由|参照元?)/;

function matchLabel(norm: string): { item: GuideItem | 'basis'; rest: string } | null {
  for (const { item, re } of LABELS) {
    const m = re.exec(norm);
    if (m) return { item, rest: norm.slice(m[0].length) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 値の読み取り
// ---------------------------------------------------------------------------

/** 値の頭に付く説明(「（仕上がりの外側に足す幅）: 3mm」の括弧)を落とす。**中身が空になるなら落とさない** */
function stripLeadParen(rest: string): string {
  const m = /^\s*[（(][^）)]*[）)]\s*(.*)$/.exec(rest);
  if (!m) return rest;
  // 括弧のあとに区切りか値が続くときだけ、説明とみなす
  return m[1].replace(SEP_HEAD, '') === '' ? rest : m[1];
}

/** ラベルと値のあいだの「は」「の幅は」「…」などを落とす */
function cleanRest(rest: string): string {
  let s = rest.replace(SEP_HEAD, '');
  s = stripLeadParen(s).replace(SEP_HEAD, '');
  s = s.replace(/^(?:の?(?:幅|量|サイズ|大きさ|下限|最小|最低))?(?:は|が|も)?/, '');
  return s.replace(SEP_HEAD, '').replace(/^…+|^\.{3,}/, '').replace(SEP_HEAD, '');
}

/** 「不明」。**真偽・数字より先に判定する**(「記載なし」を「塗り足しなし」と読まない) */
const UNKNOWN =
  /^(?:ガイド(?:に|には|内に)?(?:は)?)?(?:不明|不詳|分からない|わからない|分かりません|わかりません|判断できない|判断できません|確認できない|確認できません|見つからない|見当たらない|記載(?:は)?(?:なし|なし|ない|ありません|されていません|がない|がありません|が見当たりません|なかった)|書かれていない|書かれていません|言及(?:なし|なし|ありません)|未記載|未定|unknown|n\/?a\b|not\s+(?:specified|stated|found|mentioned|provided|given))/i;

function isUnknown(rest: string): boolean {
  const head = rest.replace(/^[\s:=,、，;"'「」『』“”‘’|｜]+/, '');
  if (/^[-—–ー?？…]+\s*$/.test(head)) return true;
  return UNKNOWN.test(cleanRest(rest));
}

type Tok = { value: number; unit: string; pos: number; end: number };

/** 数と、その直後の単位。「3〜5mm」「0.3〜0.5cm」は範囲の終わりの単位を、始めの数にも与える */
function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  const unitRe =
    /^\s*(mm|ミリメートル|ミリ|cm|センチメートル|センチ|ページ|頁|pages?|p\b|pt|ポイント|inch|inches|in\b|インチ|px|ピクセル|%|％)/i;
  const numRe = /\d+(?:[.,]\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(s))) {
    const value = Number(m[0].replace(',', '.'));
    const after = s.slice(m.index + m[0].length);
    let unit = unitRe.exec(after)?.[1]?.toLowerCase() ?? '';
    if (!unit) {
      // 範囲: 3〜5mm
      const r = /^\s*[~〜～\-–−ー]\s*\d+(?:[.,]\d+)?\s*(mm|ミリメートル|ミリ|cm|センチメートル|センチ|ページ|頁|pages?|p\b)/i.exec(
        after,
      );
      if (r) unit = r[1].toLowerCase();
    }
    out.push({ value, unit, pos: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 長さの単位を mm の倍率にする。長さでなければ null */
function mmFactor(unit: string): number | null {
  if (unit === '' || unit === 'mm' || unit === 'ミリ' || unit === 'ミリメートル') return 1;
  if (unit === 'cm' || unit === 'センチ' || unit === 'センチメートル') return 10;
  return null;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** 「なし」「不要」。長さの欄では 0 と読む */
const NONE = /^(?:なし|なし|ない|不要|ありません|必要(?:は)?(?:ありません|なし|ない)|設定なし|付けない|付けません|none\b|no\b(?!\s*[.．]?\s*\d))/i;

type Len = { mm: number; extra: boolean } | { none: true } | { bad: string };

/**
 * 数字の直前にあると、その数字が**番号**(ページ・表・図・章・注)だと分かる語。
 * 「P.5の図参照」「表2のとおり」「第2章」「No.3」。「値0」の「値」も入れる(「値N」と書いた雛形の写し)
 */
const REF_BEFORE_ASCII = /(?:^|[^A-Za-z0-9])(?:pp?|figs?|figure|table|tbl|no|nos|vol|ver|sec|ch)\s*[.．:：]?\s*$/i;
const REF_BEFORE_CJK = /(?:表|図|第|注|項|条|章|節|付録|別表|別紙|№|＃|#|値)\s*[.．:：]?\s*$/;
const isRefBefore = (before: string): boolean => REF_BEFORE_ASCII.test(before) || REF_BEFORE_CJK.test(before);

/** 数字の直前に文字(漢字・かな・英字)が隙間なく続くとき、それが「約」「各」などの寸法の前置きなら読む */
const ADJACENT_LETTER = /[A-Za-z぀-ヿ㐀-鿿]$/;
const APPROX_BEFORE = /(?:約|およそ|だいたい|大体|ほぼ|概ね|おおむね|最低|最小|最大|最高|各|計|合計|なら|は|が|も|で|に|を|とも)$/;
/** 単位の無い数字のあとに続いてよいもの(行末・空白・句読点・括弧・範囲の記号・「以上」「程度」「前後」など) */
const OK_AFTER = /^(?:\s|[。、，,;；:：)）\]】」』（(~〜～\-–−ー]|以上|以下|以内|未満|程度|前後|ほど|くらい|ぐらい|です|だ|とする|にする)/;

/**
 * 長さとして読めない数字なら、その理由。読んでよければ null。
 * 単位(mm・cm・ミリ・センチ)が付いている数字は長さ。付いていない数字は、前後が寸法らしいときだけ読む
 */
function notLengthReason(s: string, t: Tok): string | null {
  const before = s.slice(0, t.pos);
  if (isRefBefore(before)) return '番号に見えます（ページ・表・図など）';
  if (t.unit !== '') return null;
  if (ADJACENT_LETTER.test(before) && !APPROX_BEFORE.test(before)) return '数字の前に文字が続いていて、寸法か分かりません';
  const tail = s.slice(t.end);
  if (tail !== '' && !OK_AFTER.test(tail)) return '数字のあとに文字が続いていて、寸法か分かりません';
  return null;
}

/** 言い切っていない答え(長さ・厚い本)。読まない */
const HEDGE_VALUE = /(?:たぶん|多分|おそらく|恐らく|かもしれ|推測|思われ|と思い)/;
const HEDGE_REASON = '言い切っていない答えです（「たぶん」など）';

/** 単位の名前(読めない単位の理由に出す) */
function unitName(unit: string): string {
  if (/^(?:pt|ポイント)$/.test(unit)) return 'pt';
  if (/^(?:inch|inches|in|インチ)$/.test(unit)) return 'インチ';
  if (/^(?:px|ピクセル)$/.test(unit)) return 'px';
  return unit;
}

/** 塗り足し・ノドの下限・背の縁のアキの値 */
function readLength(rest: string): Len {
  const s = cleanRest(rest);
  if (NONE.test(s)) return { none: true };
  // 負の数は、長さではない
  if (/^[-−–—]\s*\d/.test(s)) return { bad: '負の数は読めません' };
  // 漢数字(三ミリ)は読めない
  if (!/\d/.test(s) && /[一二三四五六七八九十〇]+\s*(?:ミリ|mm|センチ|cm)/i.test(s)) {
    return { bad: '漢数字は読めません' };
  }
  if (HEDGE_VALUE.test(s)) return { bad: HEDGE_REASON };
  const toks = tokens(s);
  if (toks.length === 0) return { bad: '数字が見つかりません' };
  const t = toks[0];
  const f = mmFactor(t.unit);
  if (f === null) {
    return {
      bad: /^(?:ページ|頁|pages?|p)$/.test(t.unit)
        ? 'ページ数で、長さではありません'
        : `単位が ${unitName(t.unit)} です（mm か cm だけ読めます）`,
    };
  }
  const why = notLengthReason(s, t);
  if (why) return { bad: why };
  // ほかに長さの数字があれば、「読んでいません」と言う
  const extra = toks.slice(1).some((x) => x.unit !== '' && mmFactor(x.unit) !== null);
  return { mm: round3(t.value * f), extra };
}

/** あり/なし。**否定を先に見る**(「必要ありません」の「あり」・「不要」の「要」の取り違え) */
const NEG =
  /(?:なし|なし|ない|ありません|不要|不可|いいえ|付けず|付けな|つけな|しない|しません|\bno\b|false|×|✕|✗|三方|3方|3辺|三辺|天地小口|天・地・小口)/i;
const POS = /(?:あり|有り|あります|必要|付ける|付けます|付け|つける|はい|\byes\b|true|○|〇|◯|四辺|四方|4方|4辺|する)/i;

/** あり/なしの答えに、条件や推測が付いているもの。言い切っていないので、あり/なしに読まない */
const HEDGE_YESNO =
  /(?:たぶん|多分|おそらく|恐らく|かもしれ|推測|思われ|と思い|ただし|但し|ただ[、,\s]|条件|場合による|状況による|次第|ケースバイケース|要確認|未確認|不確か|はず|可能性|でしょう|あるいは)/;

type YesNo = { value: boolean; widthMm?: number } | { bad: string };

function readYesNo(rest: string): YesNo {
  const s = cleanRest(rest);
  if (HEDGE_YESNO.test(s)) return { bad: '言い切っていない答えです（「たぶん」「ただし」など）' };
  // 「あり または なし」のように、選び方がそのまま返ってきたときは、どちらとも読まない
  if (
    /(?:あり|有り|はい|yes).*(?:または|もしくは|か|\bor\b|\/|／).*(?:なし|なし|いいえ|no\b)/i.test(s) ||
    /(?:なし|なし|いいえ|no\b).*(?:または|もしくは|か|\bor\b|\/|／).*(?:あり|有り|はい|yes)/i.test(s)
  ) {
    return { bad: 'あり か なし のどちらか分かりません' };
  }
  if (NEG.test(s)) return { value: false };
  if (POS.test(s)) return { value: true };
  // 幅で答えてきたとき(「ノド側の塗り足し: 3mm」= あり、0 = なし)
  const len = readLength(rest);
  if ('mm' in len) return len.mm > 0 ? { value: true, widthMm: len.mm } : { value: false };
  if ('none' in len) return { value: false };
  // 幅としても読めない理由が「番号に見える」「単位が違う」ならそれを言う(「あり か なし で読めません」より手がかりになる)
  return { bad: /数字が見つかりません/.test(len.bad) ? 'あり か なし で読めません' : len.bad };
}

type Thick = { pages: number; mm: number; multi: boolean } | { none: true } | { bad: string };

/**
 * 厚い本。**順不同**(「20mm（200ページ超）」も「200ページをこえたら20mm」も読む)。
 * 超・こえ・越は「その数」、以上は「その数 - 1」をしきい値にする(このスタジオは「◯ページをこえたら」で持つ)
 */
function readThick(rest: string): Thick {
  const s = cleanRest(rest);
  const allToks = tokens(s);
  // 「p.3」「表2」のような番号は、ページ数でも mm でもない
  const toks = allToks.filter((t) => !isRefBefore(s.slice(0, t.pos)));
  if (HEDGE_VALUE.test(s)) return { bad: HEDGE_REASON };
  const isPage = (t: Tok) => /^(?:ページ|頁|pages?|p)$/.test(t.unit);
  const isLen = (t: Tok) => t.unit !== '' && mmFactor(t.unit) !== null;

  // ページ数のしきい値
  let pages: number | null = null;
  let pagesTok: Tok | undefined;
  // 範囲「151〜300ページ」は、始まりのページ数から先の段(= 始まり - 1 をこえたら)
  const range = /(\d+)\s*[~〜～\-–−ー]\s*(\d+)\s*(?:ページ|頁|pages?|p\b)/i.exec(s);
  if (range) {
    pages = Number(range[1]) - 1;
    pagesTok = toks.find((t) => t.pos === range.index);
  } else {
    pagesTok = toks.find(isPage);
    if (!pagesTok) {
      // 「200を超える」のように、ページの語が無いとき
      pagesTok = toks.find((t) => {
        const tail = s.slice(t.pos, t.pos + 12);
        return t.unit === '' && /^\d+(?:[.,]\d+)?\s*(?:を)?(?:超|こえ|越|以上|より多|より大)/.test(tail);
      });
    }
    if (pagesTok) {
      const tail = s.slice(pagesTok.pos, pagesTok.pos + 14);
      const isOrMore = /(?:以上)/.test(tail) && !/(?:超|こえ|越)/.test(tail);
      pages = isOrMore ? pagesTok.value - 1 : pagesTok.value;
    }
  }
  // mm の数
  const lens = toks.filter(isLen);
  let mmTok: Tok | undefined = lens[0];
  if (!mmTok && pagesTok) {
    // 「200ページ超: 20」のように単位が無い数が1つだけ残るとき
    const rest2 = toks.filter((t) => t !== pagesTok && t.unit === '');
    if (rest2.length === 1) mmTok = rest2[0];
  }
  if (pages !== null && mmTok) {
    const f = mmFactor(mmTok.unit) ?? 1;
    return { pages: Math.round(pages), mm: round3(mmTok.value * f), multi: lens.length > 1 };
  }
  if (NONE.test(s) || /(?:なし|なし|ありません|不要|設定なし|規定なし|決まりなし|ない)/.test(s)) {
    return { none: true };
  }
  if (toks.length === 0) {
    return { bad: allToks.length === 0 ? '数字が見つかりません' : '番号に見えます（ページ・表・図など）' };
  }
  return { bad: 'ページ数と mm の両方が読めません' };
}

// ---------------------------------------------------------------------------
// 返事を読む
// ---------------------------------------------------------------------------

/** 長さの欄の共通の読み方。範囲外は入れない */
function putLength(
  key: 'bleed' | 'gutterMin' | 'spineInset',
  len: Len,
  lim: readonly [number, number],
  out: ParsedGuide,
  line: string,
) {
  const name = GUIDE_ITEM_LABEL[key];
  if ('bad' in len) {
    out.skipped.push({ line, why: len.bad });
    return;
  }
  const mm = 'none' in len ? 0 : len.mm;
  if ('mm' in len && len.extra) addNote(out, `${name}の行に、ほかの数字もありました。最初の数字だけを読んでいます`);
  if (mm < lim[0] || mm > lim[1]) {
    out.rejected.push(`${name} ${fmt(mm)}mm は、このスタジオで入れられる範囲（${lim[0]}〜${lim[1]}mm）の外なので、入れていません`);
    return;
  }
  if (key === 'bleed') out.bleedMm = mm;
  else if (key === 'gutterMin') out.gutterMinMm = mm;
  else out.spineInsetMm = mm;
}

/** 同じ注意は1回だけ(同じ項目の行が何十回あっても、注意は1つ) */
function addNote(out: ParsedGuide, msg: string) {
  if (!out.notes.includes(msg)) out.notes.push(msg);
}

function fmt(v: number): string {
  return `${Number(v.toFixed(2))}`;
}

/** 返事のうち、項目の行として読めた数(同じ項目が2回なら後のぶんは数えない) */
export function parsePrintGuide(text: string, lim: GuideLimits): ParsedGuide {
  const out: ParsedGuide = {
    unknown: [],
    rejected: [],
    skipped: [],
    notes: [],
    basis: [],
    found: 0,
  };
  const seen = new Set<GuideItem>();
  const lines = splitLines(text);

  for (let i = 0; i < lines.length; i++) {
    const { raw, norm } = lines[i];
    // 表の行(| 塗り足し | 3mm | p.2 |)は、先頭の枠を落として、セルを空白でつなぐ
    let body = norm;
    if (body.includes('|')) {
      body = body
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c !== '')
        .join(' : ');
    }
    // 引用符の頭を落としてからラベルを探す
    const labelled = matchLabel(body.replace(/^["'「」『』“”‘’]+/, ''));
    if (!labelled) {
      // ラベルの無い行。数字を含むものだけ、読めなかった行として見せる(前置き・まとめは黙って捨てる)
      if (/\d/.test(body) && body.length <= 200) out.skipped.push({ line: raw, why: 'どの項目の行か分かりません' });
      continue;
    }
    const { item, rest } = labelled;

    if (item === 'basis') {
      const text0 = cleanRestForBasis(rawAfterLabel(raw));
      if (text0 !== '') {
        out.basis.push(text0);
      } else {
        // 「根拠:」だけの行。以降は根拠の箇条書き(上限10行)
        for (let j = i + 1; j < lines.length && out.basis.length < 10; j++) out.basis.push(stripDecorRaw(lines[j].raw));
        break;
      }
      continue;
    }
    // 「塗り足しの根拠: …」は根拠の行
    if (BASIS_AFTER.test(rest.replace(/^\s+/, ''))) {
      const m = /(?:根拠|出典|理由|参照元?)\s*[:：]?\s*(.*)$/.exec(raw.normalize('NFKC'));
      if (m && m[1].trim() !== '') out.basis.push(m[1].trim());
      continue;
    }
    if (seen.has(item)) {
      addNote(out, `「${GUIDE_ITEM_LABEL[item]}」が2回ありました。最初の行だけを読んでいます`);
      continue;
    }
    seen.add(item);
    out.found++;

    if (isUnknown(rest)) {
      out.unknown.push(item);
      continue;
    }

    if (item === 'bleed') putLength('bleed', readLength(rest), lim.bleedMm, out, raw);
    else if (item === 'gutterMin') putLength('gutterMin', readLength(rest), lim.gutterMinMm, out, raw);
    else if (item === 'spineInset') putLength('spineInset', readLength(rest), lim.spineInsetMm, out, raw);
    else if (item === 'bleedGutter') {
      const r = readYesNo(rest);
      if ('bad' in r) out.skipped.push({ line: raw, why: r.bad });
      else {
        out.bleedGutter = r.value;
        if (r.widthMm !== undefined) {
          addNote(
            out,
            `「綴じる側の塗り足し」は幅（${fmt(r.widthMm)}mm）で書かれていました。スタジオは四辺を同じ幅にするので、「あり」と読んでいます`,
          );
        }
      }
    } else {
      // thick
      const r = readThick(rest);
      if ('bad' in r) out.skipped.push({ line: raw, why: r.bad });
      else if ('none' in r) out.thick = null;
      else {
        if (r.multi) addNote(out, '「厚い本」に段が複数ありました。このスタジオは1段だけ持てるので、最初の1段だけを読んでいます');
        if (r.pages < lim.thickPages[0] || r.pages > lim.thickPages[1]) {
          out.rejected.push(`厚い本の ${r.pages}ページは、入れられる範囲（${lim.thickPages[0]}〜${lim.thickPages[1]}ページ）の外なので、入れていません`);
        } else if (r.mm < lim.thickGutterMm[0] || r.mm > lim.thickGutterMm[1]) {
          out.rejected.push(`厚い本のノド ${fmt(r.mm)}mm は、入れられる範囲（${lim.thickGutterMm[0]}〜${lim.thickGutterMm[1]}mm）の外なので、入れていません`);
        } else {
          out.thick = { pages: r.pages, mm: r.mm };
        }
      }
    }
  }
  return out;
}

/** 根拠の行から、ラベルと区切りを落とした本文(原文のまま。NFKC をかけない) */
function rawAfterLabel(raw: string): string {
  const s = stripDecorRaw(raw);
  const m = /^(?:根拠|出典|参照元|参照|理由|ソース|source|basis|reference)\s*[:：=＝\-ー—／/]?\s*/i.exec(
    s.replace(/^["'「」『』“”‘’]+/, ''),
  );
  return m ? s.replace(/^["'「」『』“”‘’]+/, '').slice(m[0].length) : s;
}

function stripDecorRaw(raw: string): string {
  let s = raw.replace(/\*\*|__|`/g, '').trim();
  s = s.replace(/^\s*[①-⑳]\s*/, '');
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^\s+/, '').replace(/^(?:[-*+•・●○■□◆◇▶▷>※★☆→＊－]+|#{1,6}|[0-9０-９]{1,2}[.)、．）]|[(（][0-9０-９]{1,2}[)）])\s*/, '');
    if (next === s) break;
    s = next;
  }
  // 表の行は、| でつなぎ直す
  if (s.includes('|') || s.includes('｜')) {
    s = s
      .split(/[|｜]/)
      .map((c) => c.trim())
      .filter((c) => c !== '')
      .join(' ／ ');
  }
  return s.trim();
}

function cleanRestForBasis(s: string): string {
  // 頭の区切りだけを落とす。**末尾の「」は根拠の一部**(「余白のルール」)なので落とさない。
  // 引用符で全体を囲まれているとき(JSON のような返事)だけ、その引用符を外す
  let t = s.replace(/^[\s:：=＝,、，;]+/, '').replace(/[\s,、，;]+$/, '').trim();
  const q = /^(["'“‘])(.*)(["'”’])$/.exec(t);
  if (q) t = q[2].trim();
  return t;
}

// ---------------------------------------------------------------------------
// いまの決まりに重ねる
// ---------------------------------------------------------------------------

export interface GuideChange {
  /** 欄の名前 */
  name: string;
  /** 「15 → 18mm」のように、変わり方 */
  text: string;
}

export interface GuideApplied {
  /** 重ねたあとの決まり(厚い本のノドがノドの下限より小さければ、下限に切り上げてある) */
  next: GuideValues;
  /** 変わったところ(「綴じる側の塗り足し あり → なし」) */
  changed: string[];
  /** 読めたが、いまと同じ数字だったところ(「塗り足し 3mm」) */
  same: string[];
  /** 切り上げなど、読んだ値のとおりに入らなかった説明 */
  adjusted: string[];
}

const yn = (v: boolean) => (v ? 'あり' : 'なし');
const thickText = (p: number | null, g: number | null) =>
  p === null || g === null ? '決まりなし' : `${p}ページ超で ${fmt(g)}mm`;

/**
 * 読めた値を、いまの決まりに重ねる。**変わるところだけ**を文にして返す。
 * 「不明」「読めなかった」「範囲外」の項目は、いまの値のまま
 */
export function applyPrintGuide(cur: GuideValues, parsed: ParsedGuide): GuideApplied {
  const next: GuideValues = { ...cur };
  const changed: string[] = [];
  const same: string[] = [];
  const adjusted: string[] = [];

  if (parsed.bleedMm !== undefined) {
    if (parsed.bleedMm === cur.bleedMm) same.push(`塗り足し ${fmt(cur.bleedMm)}mm`);
    else {
      next.bleedMm = parsed.bleedMm;
      changed.push(`塗り足し ${fmt(cur.bleedMm)} → ${fmt(parsed.bleedMm)}mm`);
    }
  }
  if (parsed.bleedGutter !== undefined) {
    if (parsed.bleedGutter === cur.bleedGutter) same.push(`綴じる側の塗り足し ${yn(cur.bleedGutter)}`);
    else {
      next.bleedGutter = parsed.bleedGutter;
      changed.push(`綴じる側の塗り足し ${yn(cur.bleedGutter)} → ${yn(parsed.bleedGutter)}`);
    }
  }
  if (parsed.gutterMinMm !== undefined) {
    if (parsed.gutterMinMm === cur.gutterMinMm) same.push(`ノドの下限 ${fmt(cur.gutterMinMm)}mm`);
    else {
      next.gutterMinMm = parsed.gutterMinMm;
      changed.push(`ノドの下限 ${fmt(cur.gutterMinMm)} → ${fmt(parsed.gutterMinMm)}mm`);
    }
  }
  if (parsed.thick !== undefined) {
    const np = parsed.thick === null ? null : parsed.thick.pages;
    const ng = parsed.thick === null ? null : parsed.thick.mm;
    if (np === cur.thickPages && ng === cur.thickGutterMm) {
      same.push(`厚い本のノド ${thickText(cur.thickPages, cur.thickGutterMm)}`);
    } else {
      next.thickPages = np;
      next.thickGutterMm = ng;
      changed.push(`厚い本のノド ${thickText(cur.thickPages, cur.thickGutterMm)} → ${thickText(np, ng)}`);
    }
  }
  if (parsed.spineInsetMm !== undefined) {
    if (parsed.spineInsetMm === cur.spineInsetMm) same.push(`背の縁のアキ ${fmt(cur.spineInsetMm)}mm`);
    else {
      next.spineInsetMm = parsed.spineInsetMm;
      changed.push(`背の縁のアキ ${fmt(cur.spineInsetMm)} → ${fmt(parsed.spineInsetMm)}mm`);
    }
  }
  // 厚い本のノドは、ノドの下限より小さくできない(小さいほうは効かない。printRulesOf が切り上げる)
  if (next.thickGutterMm !== null && next.thickGutterMm < next.gutterMinMm) {
    adjusted.push(
      `厚い本のノド ${fmt(next.thickGutterMm)}mm は、ノドの下限 ${fmt(next.gutterMinMm)}mm より小さいので、${fmt(next.gutterMinMm)}mm として扱います`,
    );
    next.thickGutterMm = next.gutterMinMm;
  }
  return { next, changed, same, adjusted };
}

/** 返事の読み取り結果を、画面に出す文にする(順序: 変わったところ・同じだったところ・不明・読めなかった・範囲外・注意) */
export interface GuideReport {
  /** 何も読めなかった / 何も変えなかったときの一言。変えたときは空 */
  headline: string;
  changed: string[];
  same: string[];
  unknown: string[];
  /** 読めなかった行。同じ行は「（ほか ◯ 件）」にまとめ、多すぎれば先頭だけ(残りは skippedMore) */
  skipped: SkippedLine[];
  /** skipped に出しきれなかった行の数 */
  skippedMore: number;
  rejected: string[];
  notes: string[];
  basis: string[];
  /** 値を入れてよいか(変わったところがあるか) */
  willChange: boolean;
}

/** 読めなかった行を、何行まで見せるか(それ以上は「ほか ◯ 件」) */
const SKIPPED_SHOWN = 6;

/** 同じ文はまとめる。「…（ほか 2 件）」。順番は最初に出た順 */
export function squashSame(list: string[]): string[] {
  const order: string[] = [];
  const count = new Map<string, number>();
  for (const t of list) {
    if (!count.has(t)) order.push(t);
    count.set(t, (count.get(t) ?? 0) + 1);
  }
  return order.map((t) => ((count.get(t) ?? 1) > 1 ? `${t}（ほか ${(count.get(t) ?? 1) - 1} 件）` : t));
}

function squashSkipped(list: SkippedLine[]): { shown: SkippedLine[]; more: number } {
  const order: string[] = [];
  const groups = new Map<string, { item: SkippedLine; n: number }>();
  for (const it of list) {
    const key = `${it.line}|${it.why}`;
    const g = groups.get(key);
    if (g) g.n++;
    else {
      groups.set(key, { item: it, n: 1 });
      order.push(key);
    }
  }
  const all = order.map((k) => groups.get(k)!);
  const shown = all.slice(0, SKIPPED_SHOWN).map(({ item, n }) => ({
    line: n > 1 ? `${item.line}（ほか ${n - 1} 件）` : item.line,
    why: item.why,
  }));
  const more = all.slice(SKIPPED_SHOWN).reduce((a, g) => a + g.n, 0);
  return { shown, more };
}

export function reportGuide(parsed: ParsedGuide, applied: GuideApplied): GuideReport {
  const willChange = applied.changed.length > 0;
  let headline = '';
  if (parsed.found === 0) {
    headline = '読み取れる行がありませんでした。何も変えていません。頼み方の形（「塗り足し: 3mm」のような行）で返してもらってください';
  } else if (!willChange) {
    const anyValue = applied.same.length > 0;
    headline = anyValue
      ? '読めた数字は、どれもいまの欄と同じでした。何も変えていません'
      : '読める数字がありませんでした。何も変えていません';
  }
  const sk = squashSkipped(parsed.skipped);
  return {
    headline,
    changed: applied.changed,
    same: applied.same,
    unknown: parsed.unknown.map((k) => GUIDE_ITEM_LABEL[k]),
    skipped: sk.shown,
    skippedMore: sk.more,
    rejected: squashSame(parsed.rejected),
    notes: squashSame([...parsed.notes, ...applied.adjusted]),
    basis: parsed.basis,
    willChange,
  };
}
