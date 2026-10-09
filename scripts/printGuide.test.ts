// 印刷所の入稿ガイドを読んだ AI の返事を読む決まり(src/project/printGuide.ts)の検査。
//
//   node scripts/printGuide.test.ts
//
// 終了コード 0 = 全部通った / 1 = 落ちた。**依存を足さない**(Node の型除去でそのまま動く。
// printGuide.ts が何も import しないのは、このため)。
//
// AI の返事の揺れを30通り以上並べる: 全角・コロンなし・「- 」や「・」付き・``` の囲み・表・
// 「3mm以上」「約3ミリ」「0.3cm」・「不要」「必要ありません」・「記載なし」・順番違い・
// 余計な前置きとまとめ・英語まじり・厚い本が「20mm（200ページ超）」。
// 「不明」と「なし」を取り違えないことと、範囲外を入れないことは、とくに丁寧に。
import {
  PRINT_GUIDE_PROMPT,
  applyPrintGuide,
  parsePrintGuide,
  reportGuide,
  squashSame,
  type GuideValues,
  type ParsedGuide,
} from '../src/project/printGuide.ts';

const LIM = {
  bleedMm: [0, 10],
  gutterMinMm: [0, 50],
  thickPages: [1, 2000],
  thickGutterMm: [0, 50],
  spineInsetMm: [0, 5],
} as const;

/** 見ているのは読めた値だけ。**書かなかったキーは「読めていない」ことを確かめる**ので、取り違えが落ちる */
type Want = {
  bleedMm?: number;
  bleedGutter?: boolean;
  gutterMinMm?: number;
  thick?: { pages: number; mm: number } | null;
  spineInsetMm?: number;
  unknown?: string[];
  found?: number;
  skipped?: number;
  rejected?: number;
  basis?: string;
  notes?: RegExp;
};

let failed = 0;
let passed = 0;

function pick(p: ParsedGuide) {
  const o: Record<string, unknown> = {};
  for (const k of ['bleedMm', 'bleedGutter', 'gutterMinMm', 'thick', 'spineInsetMm'] as const) {
    if (p[k] !== undefined) o[k] = p[k];
  }
  return o;
}

function check(name: string, text: string, want: Want) {
  const p = parsePrintGuide(text, LIM);
  const errs: string[] = [];
  const got = pick(p);
  const exp: Record<string, unknown> = {};
  for (const k of ['bleedMm', 'bleedGutter', 'gutterMinMm', 'thick', 'spineInsetMm'] as const) {
    if (want[k] !== undefined) exp[k] = want[k];
  }
  if (JSON.stringify(got) !== JSON.stringify(exp)) {
    errs.push(`値 ${JSON.stringify(got)} ← 期待 ${JSON.stringify(exp)}`);
  }
  if (want.unknown !== undefined && JSON.stringify(p.unknown) !== JSON.stringify(want.unknown)) {
    errs.push(`不明 ${JSON.stringify(p.unknown)} ← 期待 ${JSON.stringify(want.unknown)}`);
  }
  if (want.found !== undefined && p.found !== want.found) errs.push(`found ${p.found} ← 期待 ${want.found}`);
  if (want.skipped !== undefined && p.skipped.length !== want.skipped) {
    errs.push(`読めなかった行 ${p.skipped.length}件 ${JSON.stringify(p.skipped)} ← 期待 ${want.skipped}件`);
  }
  if (want.rejected !== undefined && p.rejected.length !== want.rejected) {
    errs.push(`範囲外 ${p.rejected.length}件 ${JSON.stringify(p.rejected)} ← 期待 ${want.rejected}件`);
  }
  if (want.basis !== undefined && !p.basis.join(' / ').includes(want.basis)) {
    errs.push(`根拠 ${JSON.stringify(p.basis)} に「${want.basis}」が無い`);
  }
  if (want.notes && !want.notes.test(p.notes.join(' / '))) {
    errs.push(`注意 ${JSON.stringify(p.notes)} が ${want.notes} に合わない`);
  }
  if (errs.length) {
    failed++;
    console.log(`NG  ${name}\n      ${errs.join('\n      ')}`);
  } else {
    passed++;
    console.log(`ok  ${name}`);
  }
}

function expect(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok  ${name}`);
  } else {
    failed++;
    console.log(`NG  ${name} ${detail}`);
  }
}

// ---- 頼んだ形そのまま ----
check(
  '01 頼んだ形そのまま(6行)',
  `塗り足し: 3mm
綴じる側の塗り足し: あり
ノドの下限: 15mm
厚い本: 200ページをこえたら 20mm
背の縁のアキ: 1mm
根拠: 入稿ガイド 2ページ「余白のルール」`,
  {
    bleedMm: 3,
    bleedGutter: true,
    gutterMinMm: 15,
    thick: { pages: 200, mm: 20 },
    spineInsetMm: 1,
    basis: '入稿ガイド 2ページ「余白のルール」',
    found: 5,
  },
);

// ---- 全角・区切りの揺れ ----
check(
  '02 全角の数字・コロン・㎜',
  `塗り足し：３㎜
綴じる側の塗り足し：なし
ノドの下限：１５ｍｍ
厚い本：なし
背の縁のアキ：１．５ｍｍ`,
  { bleedMm: 3, bleedGutter: false, gutterMinMm: 15, thick: null, spineInsetMm: 1.5 },
);
check('03 コロンなし(空白だけ)', `塗り足し 3mm\nノドの下限 18mm`, { bleedMm: 3, gutterMinMm: 18 });
check('04 「- 」の箇条書き', `- 塗り足し: 5mm\n- ノドの下限: 12mm`, { bleedMm: 5, gutterMinMm: 12 });
check('05 「・」と番号つき', `・塗り足し: 3mm\n1. ノドの下限: 15mm\n2) 背の縁のアキ: 2mm`, {
  bleedMm: 3,
  gutterMinMm: 15,
  spineInsetMm: 2,
});
check('06 太字と丸数字', `**塗り足し**: **3mm**\n① ノドの下限: 15mm\n② 綴じる側の塗り足し: あり`, {
  bleedMm: 3,
  gutterMinMm: 15,
  bleedGutter: true,
});
check(
  '07 コードの囲みの中',
  '```\n塗り足し: 3mm\nノドの下限: 15mm\n厚い本: なし\n```',
  { bleedMm: 3, gutterMinMm: 15, thick: null },
);
check(
  '08 言語つきのコード囲み',
  '```text\n塗り足し: 4mm\n綴じる側の塗り足し: なし\n```',
  { bleedMm: 4, bleedGutter: false },
);
check(
  '09 表(マークダウン)',
  `| 項目 | 値 | 根拠 |
|---|---|---|
| 塗り足し | 3mm | p.2 |
| 綴じる側の塗り足し | あり | p.2 |
| ノドの下限 | 15mm | p.3 |
| 厚い本 | 200ページ超 20mm | p.3 |
| 背の縁のアキ | 不明 | - |`,
  { bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thick: { pages: 200, mm: 20 }, unknown: ['spineInset'] },
);

// ---- 単位・修飾 ----
check('10 「3mm以上」', `塗り足し: 3mm以上\nノドの下限: 15mm以上`, { bleedMm: 3, gutterMinMm: 15 });
check('11 「約3ミリ」', `塗り足し: 約3ミリ\nノドの下限: 約15ミリ`, { bleedMm: 3, gutterMinMm: 15 });
check('12 「0.3cm」は 3mm', `塗り足し: 0.3cm\nノドの下限: 1.5cm\n背の縁のアキ: 0.1cm`, {
  bleedMm: 3,
  gutterMinMm: 15,
  spineInsetMm: 1,
});
check('13 「3センチ」は 30mm(範囲外は入れない)', `塗り足し: 3センチ`, { rejected: 1 });
check('14 単位なしは mm', `塗り足し: 3\nノドの下限: 15`, { bleedMm: 3, gutterMinMm: 15 });
check('15 pt は読めない行', `塗り足し: 8.5pt\nノドの下限: 15mm`, { gutterMinMm: 15, skipped: 1 });
check('16 漢数字は読めない行', `塗り足し: 三ミリ\nノドの下限: 15mm`, { gutterMinMm: 15, skipped: 1 });
check('17 数字が複数の行は最初を読み、注意を出す', `塗り足し: 3mm（天・地・小口）、ノド側は 5mm`, {
  bleedMm: 3,
  notes: /ほかの数字/,
});
check('18 範囲「3〜5mm」は最初', `塗り足し: 3〜5mm`, { bleedMm: 3, notes: undefined });
check('19 小数点の「,」', `塗り足し: 3,2mm`, { bleedMm: 3.2 });

// ---- なし・不要・不明 ----
check('20 「不要」', `綴じる側の塗り足し: 不要\n厚い本: 不要`, { bleedGutter: false, thick: null });
check('21 「必要ありません」(「あり」を取り違えない)', `綴じる側の塗り足し: 必要ありません`, { bleedGutter: false });
check('22 「必要です」', `綴じる側の塗り足し: 必要です`, { bleedGutter: true });
check('23 「記載なし」は不明(なしではない)', `塗り足し: 記載なし\n綴じる側の塗り足し: 記載なし\n厚い本: 記載なし`, {
  unknown: ['bleed', 'bleedGutter', 'thick'],
  found: 3,
});
check('24 「不明」と「ガイドに記載なし」', `ノドの下限: 不明\n背の縁のアキ: ガイドに記載なし`, {
  unknown: ['gutterMin', 'spineInset'],
});
check('25 「-」「—」は不明', `塗り足し: -\nノドの下限: —\n背の縁のアキ: ？`, {
  unknown: ['bleed', 'gutterMin', 'spineInset'],
});
check('26 塗り足し「なし」は 0mm', `塗り足し: なし`, { bleedMm: 0 });
check('27 ノドの下限「なし」は 0mm', `ノドの下限: 不要`, { gutterMinMm: 0 });
check('28 英語まじり', `Bleed: 3mm\nGutter: 15mm\nthick: none\nSpine inset: unknown`, {
  bleedMm: 3,
  gutterMinMm: 15,
  thick: null,
  unknown: ['spineInset'],
});
check('29 「yes / no」', `綴じる側の塗り足し: yes`, { bleedGutter: true });
check('30 「no」', `綴じる側の塗り足し: no`, { bleedGutter: false });
check('31 「三方」は綴じる側なし', `綴じる側の塗り足し: 三方（天・地・小口）のみ`, { bleedGutter: false });
check('32 「四辺」は綴じる側あり', `綴じる側の塗り足し: 四辺に付ける`, { bleedGutter: true });

// ---- ラベルの別名 ----
check('33 ドブ・裁ち落とし・綴じしろ', `ドブ: 3mm\n綴じしろ: 15mm`, { bleedMm: 3, gutterMinMm: 15 });
check('34 「裁ち落とし(ブリード)」', `裁ち落とし（ブリード）: 3mm`, { bleedMm: 3 });
check('35 「ノド側の塗り足し」は綴じる側(塗り足しではない)', `ノド側の塗り足し: なし\n塗り足し: 3mm`, {
  bleedGutter: false,
  bleedMm: 3,
});
check('36 説明の括弧つきラベル', `塗り足し（仕上がりの外側に足す幅）: 3mm\nノドの下限（綴じる側の余白の最小）: 15mm`, {
  bleedMm: 3,
  gutterMinMm: 15,
});
check('37 「は」「です」の文', `塗り足しは3mmです。\nノドの下限は15mmです。`, { bleedMm: 3, gutterMinMm: 15 });

// ---- 厚い本 ----
check('38 厚い本「20mm（200ページ超）」', `厚い本: 20mm（200ページ超）`, { thick: { pages: 200, mm: 20 } });
check('39 厚い本「200ページ以上は 20mm」は 199', `厚い本: 200ページ以上は 20mm`, { thick: { pages: 199, mm: 20 } });
check('40 厚い本「201ページ以上」は 200', `厚い本: 201ページ以上 20mm`, { thick: { pages: 200, mm: 20 } });
check('41 厚い本「ページ数 200 を超えるとノド 25mm」', `厚い本: ページ数が 200 を超えると 25mm`, {
  thick: { pages: 200, mm: 25 },
});
check('42 厚い本の段が複数', `厚い本: 151〜300ページ 12.7mm、301ページ〜 15.9mm`, {
  thick: { pages: 150, mm: 12.7 },
  notes: /段が複数/,
});
check('43 厚い本「300ページをこえたら 1.8cm」', `厚い本: 300ページをこえたら 1.8cm`, { thick: { pages: 300, mm: 18 } });
check('44 厚い本の ページ数だけ(mm なし)は読めない', `厚い本: 200ページ超`, { skipped: 1 });

// ---- 範囲外・重複 ----
check('45 塗り足し 12mm は範囲外', `塗り足し: 12mm\nノドの下限: 15mm`, { gutterMinMm: 15, rejected: 1 });
check('46 ノドの下限 60mm は範囲外', `ノドの下限: 60mm`, { rejected: 1 });
check('47 背の縁のアキ 8mm は範囲外', `背の縁のアキ: 8mm`, { rejected: 1 });
check('48 厚い本 3000ページ は範囲外', `厚い本: 3000ページ超 20mm`, { rejected: 1 });
check('49 同じラベルが2回なら最初', `塗り足し: 3mm\n塗り足し: 5mm`, { bleedMm: 3, notes: /2回/ });
check('50 負の数は「-」で始まる行にならず読めない', `塗り足し: -3mm`, { skipped: 1 });

// ---- 前置き・まとめ・順番 ----
check(
  '51 前置きとまとめ付き',
  `ガイドを読みました。以下のとおりです。

塗り足し: 3mm
綴じる側の塗り足し: あり
ノドの下限: 15mm

以上です。ご不明な点があればお知らせください。`,
  { bleedMm: 3, bleedGutter: true, gutterMinMm: 15 },
);
check(
  '52 順番違い・根拠が先頭',
  `根拠: 入稿の手引き p.5
背の縁のアキ: 1mm
ノドの下限: 15mm
塗り足し: 3mm`,
  { spineInsetMm: 1, gutterMinMm: 15, bleedMm: 3, basis: '入稿の手引き p.5' },
);
check(
  '53 根拠が複数行の箇条書き',
  `塗り足し: 3mm
ノドの下限: 15mm
根拠:
- 塗り足し: 入稿ガイド 2ページ
- ノド: 入稿ガイド 3ページ`,
  { bleedMm: 3, gutterMinMm: 15, basis: '入稿ガイド 3ページ' },
);
check(
  '54 「塗り足しの根拠: …」は根拠の行(数字として読まない)',
  `塗り足し: 3mm
塗り足しの根拠: 入稿ガイド 2ページ`,
  { bleedMm: 3, basis: '入稿ガイド 2ページ' },
);
check('55 根拠は原文のまま(全角を残す)', `塗り足し: 3mm\n根拠: ガイド２ページ「余白のルール」`, {
  bleedMm: 3,
  basis: 'ガイド２ページ「余白のルール」',
});
check('56 引用符つき(JSON のような)', `"塗り足し": "3mm",\n"ノドの下限": "15mm"`, { bleedMm: 3, gutterMinMm: 15 });
check('57 BOM・ゼロ幅文字', `﻿塗り足し: 3mm\n​ノドの下限: 15mm`, { bleedMm: 3, gutterMinMm: 15 });
check('58 CRLF', `塗り足し: 3mm\r\nノドの下限: 15mm\r\n`, { bleedMm: 3, gutterMinMm: 15 });
check('59 見出し記号つき', `## 塗り足し: 3mm\n## ノドの下限: 15mm`, { bleedMm: 3, gutterMinMm: 15 });
check('60 幅で答えた綴じる側の塗り足し', `綴じる側の塗り足し: 3mm`, { bleedGutter: true, notes: /幅/ });

// ---- 何も読めない ----
check('61 空', ``, { found: 0 });
check('62 空白だけ', `   \n\n  `, { found: 0 });
check('63 関係ない文章', `こんにちは。入稿ガイドを添付してください。`, { found: 0, skipped: 0 });
check('64 頼み方の雛形をそのまま返した(◯・あり または なし)は、どれも読めない行', `塗り足し: ◯mm\n綴じる側の塗り足し: あり または なし\nノドの下限: ◯mm`, {
  skipped: 3,
});
check('65 背幅の行は項目ではない(数字つきは読めなかった行)', `背幅: 12.3mm\n塗り足し: 3mm`, { bleedMm: 3, skipped: 1 });

// ---- 変わったところを言葉にする ----
{
  const cur: GuideValues = { bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20, spineInsetMm: 1 };
  const p = parsePrintGuide(
    `塗り足し: 3mm\n綴じる側の塗り足し: なし\nノドの下限: 18mm\n厚い本: 300ページをこえたら 25mm\n背の縁のアキ: 不明`,
    LIM,
  );
  const a = applyPrintGuide(cur, p);
  expect(
    '70 変わったところの文',
    a.changed.join('、') ===
      '綴じる側の塗り足し あり → なし、ノドの下限 15 → 18mm、厚い本のノド 200ページ超で 20mm → 300ページ超で 25mm',
    JSON.stringify(a.changed),
  );
  expect('71 同じ数字は「変わらなかった」に入る', a.same.join('、') === '塗り足し 3mm', JSON.stringify(a.same));
  expect('72 不明の項目は変えない', a.next.spineInsetMm === 1);
  expect('73 重ねたあとの値', a.next.bleedGutter === false && a.next.gutterMinMm === 18 && a.next.thickPages === 300 && a.next.thickGutterMm === 25);
  const r = reportGuide(p, a);
  expect('74 報告: 変えるときは見出しの一言が空', r.headline === '' && r.willChange && r.unknown.join() === '背の縁のアキ');
}
{
  const cur: GuideValues = { bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20, spineInsetMm: 1 };
  const p = parsePrintGuide(`塗り足し: 3mm\nノドの下限: 15mm`, LIM);
  const r = reportGuide(p, applyPrintGuide(cur, p));
  expect('75 全部同じ数字なら何も変えない', !r.willChange && /同じ/.test(r.headline), r.headline);
}
{
  const cur: GuideValues = { bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20, spineInsetMm: 1 };
  const p = parsePrintGuide(`${''}`, LIM);
  const r = reportGuide(p, applyPrintGuide(cur, p));
  expect('76 何も読めなければ何も変えず、そう言う', !r.willChange && /読み取れる行がありません/.test(r.headline));
}
{
  const cur: GuideValues = { bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20, spineInsetMm: 1 };
  const p = parsePrintGuide(`ノドの下限: 15mm\n厚い本: 300ページをこえたら 12mm`, LIM);
  const a = applyPrintGuide(cur, p);
  expect(
    '77 厚い本のノドが下限より小さいなら、下限に切り上げて言う',
    a.next.thickGutterMm === 15 && a.adjusted.length === 1 && /小さいので/.test(a.adjusted[0]),
    JSON.stringify(a),
  );
  const q = parsePrintGuide(`厚い本: なし`, LIM);
  const b = applyPrintGuide(cur, q);
  expect('78 厚い本「なし」は決まり無しになる', b.next.thickPages === null && b.next.thickGutterMm === null && b.changed.length === 1, JSON.stringify(b));
  const u = parsePrintGuide(`厚い本: 不明`, LIM);
  const c = applyPrintGuide(cur, u);
  expect('79 厚い本「不明」は触らない', c.next.thickPages === 200 && c.changed.length === 0);
}

// ---- 寸法でない数字・言い切っていない答え・読めなかった行の理由・まとめ(2026-10-01 読み直しで発見) ----
/** 読めなかった行の理由(why)を、行ごとに並べて返す */
const whys = (text: string) => parsePrintGuide(text, LIM).skipped.map((s) => s.why);
check('84 「P.5の図参照」は寸法ではない', `塗り足し: P.5の図参照\nノドの下限: 15mm`, { gutterMinMm: 15, skipped: 1 });
check('85 「表2のとおり」は寸法ではない', `ノドの下限: 表2のとおり`, { skipped: 1 });
check('86 「第2章を見てください」は寸法ではない', `塗り足し: 第2章を見てください`, { skipped: 1 });
check('87 「値0」は 0mm と読まない', `塗り足し: 値0`, { skipped: 1 });
check('88 「No.3 を参照」「p.4」「図 5」「注1」', `塗り足し: No.3 を参照\nノドの下限: p.4\n背の縁のアキ: 図 5`, { skipped: 3 });
check('89 数字のあとに文字が続く単位なしは読めない(「3を参照」「3つ」)', `塗り足し: 3を参照\nノドの下限: 15つ`, { skipped: 2 });
check('90 単位なしでも「3」「約3」「3以上」「3程度」「3前後」は読む', `塗り足し: 約3\nノドの下限: 15以上\n背の縁のアキ: 1程度`, {
  bleedMm: 3,
  gutterMinMm: 15,
  spineInsetMm: 1,
});
check('91 単位つきの数字は、前に文字があっても読む(「四辺とも3mm」「片側3mm」)', `塗り足し: 四辺とも3mm\n背の縁のアキ: 片側1mm`, {
  bleedMm: 3,
  spineInsetMm: 1,
});
check('92 数字が長さで、あとに番号があるだけなら読む(「3mm（P.5 参照）」)', `塗り足し: 3mm（P.5 参照）\nノドの下限: 15mm (p.3)`, {
  bleedMm: 3,
  gutterMinMm: 15,
});
check('93 「たぶんあり」は あり に読まない', `綴じる側の塗り足し: たぶんあり`, { skipped: 1 });
check('94 「あり（ただし…）」は あり に読まない', `綴じる側の塗り足し: あり（ただし条件による）`, { skipped: 1 });
check('95 「なし（場合による）」も読まない', `綴じる側の塗り足し: なし（場合による）`, { skipped: 1 });
check('96 言い切った「あり」「なし」は今までどおり読む', `綴じる側の塗り足し: あり\n厚い本: なし`, { bleedGutter: true, thick: null });
check('97 「たぶん3mm」は長さに読まない', `塗り足し: たぶん3mm`, { skipped: 1 });
check('98 厚い本の「p.3」「表2」は、ページ数にも mm にも数えない', `厚い本: 200ページ超 20（p.3）`, { thick: { pages: 200, mm: 20 } });
expect(
  '99 理由: pt・インチ・数字なし・番号・言い切っていない',
  (() => {
    const w = whys('塗り足し: 8.5pt\nノドの下限: 0.5インチ\n背の縁のアキ: 少し\n綴じる側の塗り足し: たぶんあり');
    return w.length === 4 && /pt/.test(w[0]) && /インチ/.test(w[1]) && /数字が見つかりません/.test(w[2]) && /言い切って/.test(w[3]);
  })(),
  JSON.stringify(whys('塗り足し: 8.5pt\nノドの下限: 0.5インチ\n背の縁のアキ: 少し\n綴じる側の塗り足し: たぶんあり')),
);
expect(
  '100 理由: 番号に見える・数字の前後に文字・ページ数・項目が分からない',
  (() => {
    const w = whys('塗り足し: P.5の図参照\nノドの下限: 15つ\n背の縁のアキ: 3ページ参照\n120ページです');
    return w.length === 4 && /番号/.test(w[0]) && /あとに文字/.test(w[1]) && /ページ数/.test(w[2]) && /どの項目/.test(w[3]);
  })(),
  JSON.stringify(whys('塗り足し: P.5の図参照\nノドの下限: 15つ\n背の縁のアキ: 3ページ参照\n120ページです')),
);
{
  // 100行の「塗り足し: 値N」: 同じ注意が99個並ばない(React の「同じキー」の警告の元でもあった)
  const junk = Array.from({ length: 100 }, (_, i) => `塗り足し: 値${i}`).join('\n');
  const p = parsePrintGuide(junk, LIM);
  expect('101 同じ項目が何十行あっても、注意は1つ', p.notes.length === 1 && /2回/.test(p.notes[0]), JSON.stringify(p.notes));
  const cur: GuideValues = { bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20, spineInsetMm: 1 };
  const a = applyPrintGuide(cur, p);
  expect('102 「値N」は塗り足しを変えない', a.changed.length === 0 && a.next.bleedMm === 3);
  const r = reportGuide(p, a);
  expect('103 読めなかった行は1行(「ほか 99 件」はなく、読んだのは最初の1行だけ)', r.skipped.length === 1 && r.skippedMore === 0, JSON.stringify(r.skipped));
}
{
  // 項目の無い数字つきの行が何十行も来たとき: 同じ行は「ほか ◯ 件」、違う行は先頭だけ見せて残りを数える
  const same = Array.from({ length: 30 }, () => `120ページです`).join('\n');
  const r1 = reportGuide(parsePrintGuide(same, LIM), applyPrintGuide({ bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20, spineInsetMm: 1 }, parsePrintGuide(same, LIM)));
  expect('104 同じ行はまとめる(ほか 29 件)', r1.skipped.length === 1 && /ほか 29 件/.test(r1.skipped[0].line), JSON.stringify(r1.skipped));
  const many = Array.from({ length: 20 }, (_, i) => `${i + 1}ページ目の注意`).join('\n');
  const pm = parsePrintGuide(many, LIM);
  const r2 = reportGuide(pm, applyPrintGuide({ bleedMm: 3, bleedGutter: true, gutterMinMm: 15, thickPages: 200, thickGutterMm: 20, spineInsetMm: 1 }, pm));
  expect('105 違う行が多いときは先頭だけ見せて「ほか」を数える', r2.skipped.length === 6 && r2.skippedMore === 14, `${r2.skipped.length}/${r2.skippedMore}`);
  expect('106 squashSame: 同じ文は「ほか ◯ 件」', JSON.stringify(squashSame(['a', 'b', 'a', 'a'])) === JSON.stringify(['a（ほか 2 件）', 'b']));
}

// ---- 頼み方 ----
expect('80頼み方に既定値(3・15・200・20)の見本を書いていない', !/[:：]\s*(?:3|15|200|20)\s*mm/.test(PRINT_GUIDE_PROMPT));
expect('81 頼み方は背幅を聞かない', !/背幅/.test(PRINT_GUIDE_PROMPT));
expect('82 頼み方に「不明」と「根拠」を書いている', /不明/.test(PRINT_GUIDE_PROMPT) && /根拠/.test(PRINT_GUIDE_PROMPT));
expect(
  '83 頼み方の6行の見出しを、返事の読み手がラベルとして読める',
  (() => {
    const lines = PRINT_GUIDE_PROMPT.split('\n').filter((l) => /^(塗り足し|綴じる側の塗り足し|ノドの下限|厚い本|背の縁のアキ|根拠):/.test(l));
    return lines.length === 6;
  })(),
);

console.log(`\n${passed} 通り / ${failed} 落ち`);
process.exit(failed ? 1 : 0);
