// 本文テキストの整形(docs/typesetting-rules.md §2, §3, §5)。
// 縦中横・数字の全角化は目視に頼らず機械的に検出して適用する(v0.2 決定事項)。

import { plainText } from '../models/inlineImages';

const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

export function escapeHtml(s: string): string {
  // XML に入れられない制御文字(垂直タブ・改ページ・NUL など)は落とす(2026-09-25 見直し S2-4:
  // .txt に垂直タブが1つあるだけで、EPUB が XML として壊れていた。画面にも紙にも見えない字)
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[&<>"]/g, (c) => escapeMap[c]);
}

/** 閉じタグの要らない要素 */
const VOID_TAGS = new Set(['br', 'img', 'wbr', 'hr']);

/**
 * **段落の中のタグを、必ず対になる形に直す。**(2026-09-25 見直し S2-4)
 *
 * 原稿の `<u>` を段落の外で閉じる、`*斜体の中で<u>下線*が</u>` のように食い違わせる、`<b>` という字を
 * 地の文に書く、と、タグが対にならない。紙の下見は HTML として読むので崩れて見えないが、EPUB は XML なので
 * **壊れたファイルを黙って書き出していた**(読む機械や入稿の検査で弾かれる種類の壊れ方)。
 * ブラウザと同じ考え方で直す: 食い違って閉じたら、間のタグを閉じてから開き直す。対の無い閉じは捨てる。
 * 段落の終わりで開いたままのものは閉じる
 */
export function balanceInline(html: string): string {
  const out: string[] = [];
  const stack: { name: string; open: string }[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push(html.slice(last, m.index));
    last = re.lastIndex;
    const [tag, close, rawName, rest] = m;
    const name = rawName.toLowerCase();
    if (VOID_TAGS.has(name) || rest.trim().endsWith('/')) {
      out.push(tag);
      continue;
    }
    if (!close) {
      stack.push({ name, open: tag });
      out.push(tag);
      continue;
    }
    const at = stack.map((e) => e.name).lastIndexOf(name);
    if (at < 0) continue;
    const reopen = stack.slice(at + 1);
    for (let k = stack.length - 1; k > at; k--) out.push(`</${stack[k].name}>`);
    out.push(`</${name}>`);
    stack.length = at;
    for (const r of reopen) {
      out.push(r.open);
      stack.push(r);
    }
  }
  out.push(html.slice(last));
  for (let k = stack.length - 1; k >= 0; k--) out.push(`</${stack[k].name}>`);
  return out.join('');
}

/** 半角数字→全角 */
function toFullwidthDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
}

/** 半角の ! ? → 全角 */
function toFullwidthBangs(s: string): string {
  return s.replace(/!/g, '！').replace(/\?/g, '？');
}

/**
 * 半角ハイフンの連続を和文の2倍ダッシュ「――」に寄せる。
 * 半角ハイフンは縦組みで横倒しになり、短い点が並んだようにしか見えない(実測)。
 * 和文では 2倍ダッシュが標準なので、2つ以上の連続をそこへ正規化する。
 * 単独の「-」は A-B のような意味を持つので触らない。
 */
export function normalizeDashes(s: string): string {
  // **打つのは少なく、出るのは和文の1組。** `--` と `...` を打てば、
  // それぞれ2倍ダッシュ「――」と三点リーダ「……」になる。
  // 和文ではどちらも2つで1組と決まっているので、こちらで組にしてしまうほうが楽
  // (2026-08-19 ユーザー判断)。**そのぶん画面ではっきり説明すること。**
  //
  // 半角ハイフン2つ以上 → 全角ダッシュ2つ。**U+2015(HORIZONTAL BAR)を使う。**
  // 実測で 1em ちょうどの字幅を持ち、並べても切れ目なく1本につながる
  // (U+2014 EM DASH は 0.85em ぶんしかなく、2つ並べると 1.69em になって隙間が出る)
  s = s.replace(/-{2,}/g, '――');
  // 半角ピリオド3つ以上 → 三点リーダ2つ(実測でこちらも 1em ずつ)
  s = s.replace(/\.{3,}/g, '……');
  return s;
}

/**
 * 文字の飾りを組版の要素にする。エスケープ後に適用すること。
 *
 * **利用者は Obsidian や Word の書式ボタンを使う。** その結果どうなるかが分かれ道:
 *
 * - **.md(Obsidian)** … 記号がファイルに残るので、ここで解釈すれば効く。
 *   下線・取り消し線は Obsidian が `<u>` `<s>` の**タグ**を書き込むので、それも読む
 * - **.docx(Word)** … 取込が段落の textContent しか読まない(importers/docx.ts)ので、
 *   書式は**全部落ちる**。Word の人は記号で書くしかない
 *
 * 記法の割り当て:
 *
 * | 書き方 | 出るもの |
 * |---|---|
 * | `**〜**` | 太字 |
 * | `*〜*` | 斜体(Markdown の標準。Obsidian の I ボタンと同じ) |
 * | `~~〜~~` | 取り消し線 |
 * | `<u>〜</u>` | 下線(Obsidian の U ボタンが書くタグ) |
 * | `《《〜》》` | 傍点・圏点(和文の記法) |
 *
 * **傍点に `*〜*` を使わない。** 一度そうしたが、Obsidian で斜体を書いた人の文が
 * 全部 傍点になってしまう(2026-08-19 ユーザー指摘)。和文の傍点には和文の記法を当てる。
 *
 * **順番が大事。**
 * 1. 傍点を先に食わせる。`《《〜》》` を残すと、あとのルビ規則が内側の `《〜》` を拾う
 * 2. `**` を `*` より先に。逆だと `**強調**` の内側を1つずつ拾って壊れる
 */
export function convertEmphasis(s: string): string {
  // 1. 傍点(和文)。ルビより先。
  //    **1字ずつ別の span に割る。** 紙の組版はゴマ点を各字の ::after で行間に浮かせる
  //    (typeset/css.ts。text-emphasis は行箱を太らせて行グリッドを乱すので使えない)ため、
  //    字単位の箱が要る。EPUB は .boten への text-emphasis で打つが、
  //    マークは字ごとに付くものなので、span が字単位でも出るものは変わらない。
  //    入れ子にしない(外側に包む span を足すと、wrapDropCap の先頭タグ検出が
  //    非貪欲マッチで入れ子の途中まで拾い、壊れたHTMLを作る)。
  //    寸法はルビと同じ仕組みで、親1字・注釈1字ぶんの既定値を CSS 側が持つ
  s = s.replace(/《《([^》]+)》》/g, (_m, inner: string) =>
    [...inner].map((c) => `<span class="boten">${c}</span>`).join(''),
  );
  // 2. 太字 → 斜体 の順
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<em>$1</em>');
  s = s.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  // 3. 取り消し線
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  // 4. Obsidian が書き込むタグ。escapeHtml 済みなので実体参照で拾う
  const TAG_MAP: Record<string, string> = {
    u: 'u',
    s: 's',
    del: 's',
    strong: 'em',
    b: 'em',
    i: 'i',
    em: 'i',
  };
  s = s.replace(/&lt;(\/?)([a-zA-Z]+)&gt;/g, (m, close: string, tag: string) => {
    const name = TAG_MAP[tag.toLowerCase()];
    return name ? `<${close}${name}>` : m;
  });
  // 5. 残ったタグ(色や大きさを指定する <span style> など)は**印だけ落として中身を残す**。
  //    紙面の色や大きさは組版側で決めるものなので、原稿の指定は持ち込まない
  // 属性の中には &quot; などの実体参照が入るので、`[^&]` では止まってしまう。
  // 「&gt; が来るまで」で数える
  s = s.replace(/&lt;\/?(?:span|font|div|p|br|mark)(?:\s(?:(?!&gt;)[\s\S])*?)?\/?&gt;/gi, '');
  // 6. リンク。**電子書籍でだけ意味を持つ。**
  //    紙では飛べないので、組版CSS側で見た目を本文に戻す(色も下線も付けない)。
  //    href は escapeHtml 済みの文字列から取るので、そのまま属性に入れて正しい
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${url}">${label}</a>`;
  });
  // 7. Obsidian のハイライト ==〜== も印だけ落とす(紙に蛍光ペンは引けない)
  s = s.replace(/==([^=\n]+)==/g, '$1');
  return s;
}

/**
 * convertEmphasis が飾りに変える記法を外して、字だけにする。**柱(章題の data-plain)に使う。**(2026-10-13)
 *
 * 章題そのものは paragraphHtml で組むので `**雨**` は太字になるが、柱は CSS の string-set が属性の字を
 * そのまま刷るので、記法を外さないと `**` が柱に刷られた(Google ドキュメントの Markdown の見出し
 * `# **第1章　雨の日の図書室**`)。外すのは convertEmphasis が変えるものと同じ(太字・斜体・取り消し線・
 * 下線などのタグ・色や大きさのタグ・リンク・==)。章題に字として刷られるもの(対になっていない `*` など)は残す。
 * **記法の無い字は1字も変えない**(ふつうの本の柱は変わらない)。傍点とルビは呼び出し側で先に外す
 */
export function stripInlineMarks(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/<\/?(?:u|s|del|strong|b|i|em)>/gi, '')
    .replace(/<\/?(?:span|font|div|p|br|mark)(?:\s[^>]*?)?\/?>/gi, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/==([^=\n]+)==/g, '$1');
}

/** 注釈の基本の大きさ(親文字に対する比)。和文組版の慣習どおり親文字の半分 */
const RT_SIZE = 0.5;
/**
 * 注釈をこれより小さくはしない(親文字に対する比)。ここまで縮めても収まらない読みは、
 * さらに縮めるより多少はみ出させるほうがまし。
 * **0.3 まで許すと字が小さすぎた**(2026-09-14 ユーザー報告「万が一、というルビが極端に小さい」)。
 * そこまで縮むのは `万が一《まんがいち》` のように**記法が間違っている**ときだけなので、
 * 読める大きさで止めて、はみ出しは受け入れる(正しい書き方は AI に渡す説明にも載せた)
 */
const RT_MIN = 0.4;

/**
 * 青空文庫ルビ記法を <ruby> に変換する。
 * - ｜親文字《るび》
 * - 漢字連続《るび》(直前の漢字列が親文字)
 * エスケープ後の文字列に対して適用すること。
 *
 * **1回で左から順に読む。** 以前は ｜形 → 漢字連続形 の2回に分けて置換していたが、
 * **隣もルビかどうか**で注釈の大きさを決めるようになった(下の rubyHtml)ので、
 * ルビの並びを順番に見られる形にした。
 */
export function convertAozoraRuby(s: string): string {
  const ms = [...s.matchAll(RUBY_RE)];
  if (!ms.length) return s;
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    const start = m.index ?? 0;
    out.push(s.slice(at, start));
    const prev = ms[i - 1];
    const next = ms[i + 1];
    // 隣のルビと**字が地続き**なら、そちらへはみ出す余地は無い
    const leftFree = !(prev && (prev.index ?? 0) + prev[0].length === start);
    const rightFree = !(next && (next.index ?? 0) === start + m[0].length);
    out.push(rubyHtml(m[1] ?? m[3] ?? '', m[2] ?? m[4] ?? '', leftFree, rightFree));
    at = start + m[0].length;
  }
  out.push(s.slice(at));
  return out.join('');
}

/** ｜明示形 と 漢字連続形(々・〆・ヶなどを含む)。左から順に、先に書いたほうを優先して拾う */
const RUBY_RE = /[｜|]([^《｜|]+)《([^》]+)》|([一-鿿々〆ヶ仝]+)《([^》]+)》/g;

/** タグと実体参照を1字と数えた字数(ルビの親文字・注釈の長さ) */
function charCount(html: string): number {
  return Array.from(html.replace(/<[^>]+>/g, '').replace(/&[a-zA-Z#0-9]+;/g, 'x')).length;
}

/**
 * ルビ1組の HTML。**紙面に置くのに要る寸法を、ここで計算して CSS 変数で渡す。**
 *
 * 組版CSS(typeset/css.ts)は注釈を「大きさ0の箱」として行の中に置き、そこから
 * ずらして描く。そのずらし幅と、注釈を縮めるかどうかを決めるのがここ。
 *
 * - `--off` … 注釈の頭を置く位置。親文字の末尾から戻す量(注釈の字で数えた数)
 * - `--k`  … 注釈の拡大率(1 が既定の 0.5em)。長すぎる読みのときだけ 1 を下回る
 *
 * **なぜ縮めるか。**(2026-09-14 ユーザー報告「P12 ルビが長くて次のルビと被る」)
 * 読みが親文字より長いルビは、和文組版では隣の字へはみ出させるのが普通で、
 * 隣が仮名なら何も起きない。ところが**総ルビ**(全部の漢字にルビを振る)では
 * 隣の字にもルビが乗っているので、はみ出したぶんが隣のルビとぶつかる。
 * そこで、**隣にルビが無い側にだけ半字ぶんのはみ出しを許し**、収まらない読みは
 * 収まるところまで縮め(下限 RT_MIN)、**出してよい側へ寄せて**置く。
 * 隣が仮名の普通の本では、縮みも寄せも起きない(中央のまま)。
 *
 * 総ルビで目立つのは `万が一《まんがいち》` のような書き方で、青空文庫記法では
 * 漢字の並びだけが親文字になるので**親文字は「一」の1字**、読みは5字になる。
 * 本来は `｜万が一《まんがいち》` と書くべきところだが、機械的に総ルビを振ると必ず出る形なので、
 * 組版側でも破綻しないようにしておく
 *
 * **縮めるのは font-size ではなく transform。** font-size を変えると `--off` と
 * 行間側の寄せ(--anno-shift)の単位(注釈の em)まで一緒に変わってしまい、
 * 文脈ごとの寄せが狂う。拡大率なら箱の座標系は 0.5em のままでいられる。
 */
function rubyHtml(base: string, rt: string, leftFree: boolean, rightFree: boolean): string {
  const n = charCount(base);
  const m = charCount(rt);
  // はみ出してよい幅。隣にルビがある側へは出さない(出すと隣のルビとぶつかる)
  const left = leftFree ? 0.5 : 0;
  const right = rightFree ? 0.5 : 0;
  const size = Math.max(RT_MIN, Math.min(RT_SIZE, (n + left + right) / m));
  const len = m * size;
  // 置ける範囲に収まるなら中央、はみ出すなら**出してよい側へ寄せる**。
  // 範囲より長い読み(下限まで縮めても収まらないとき)は、あきらめて中央に置く
  const lo = -left;
  const hi = n + right - len;
  const mid = (n - len) / 2;
  const start = hi < lo ? mid : Math.min(Math.max(mid, lo), hi);
  const v = (x: number) => String(Math.round(x * 1000) / 1000);
  const k = size / RT_SIZE;
  return (
    `<ruby style="--off:${v(2 * (n - start))}${k < 1 ? `;--k:${v(k)}` : ''}">` +
    `${base}<rt>${rt}</rt></ruby>`
  );
}

/**
 * 縦書き用: 縦中横の付与と数字の処理(単一パスで適用)。
 * - 「!?」「!!」「??」 → 縦中横
 * - 半角数字 1〜2 桁 → 縦中横
 * - 3 桁以上 → 全角化して1字ずつ正立
 * - 単独の半角 ! ? → 全角化
 * タグ(<ruby> 等)の中身を壊さないよう、タグ外のテキストにだけ適用する。
 */
export function applyTcy(html: string): string {
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith('<')) return part;
      return part.replace(/!\?|!!|\?\?|[0-9]+|[!?]/g, (m) => {
        if (m === '!') return '！';
        if (m === '?') return '？';
        if (m === '!?' || m === '!!' || m === '??') {
          // 半角のまま合成すると 1em の 62〜86% しか埋まらず、字面が痩せて右に寄って見える。
          // 全角に直すと 2em→1em に圧縮されて枠いっぱいになり、数字の縦中横と字面が揃う
          return `<span class="tcy">${toFullwidthBangs(m)}</span>`;
        }
        return m.length <= 2
          ? `<span class="tcy">${m}</span>`
          : toFullwidthDigits(m);
      });
    })
    .join('');
}

/**
 * ドロップキャップ用に、段落の**先頭のひとかたまり**を包む。
 *
 * **`::first-letter` では足りない。** 章が数字で始まると縦中横(`<span class="tcy">19</span>`)に
 * なり、その中の1桁だけを大きくすることになって効かなかった
 * (2026-08-19 ユーザー報告「第二章だけ大きくなっていない」)。
 * 実測でも `initial-letter` はインライン要素には効かず、素通しになった。
 *
 * そこで**包む範囲をこちらで決める**: 縦中横とルビは**ひとかたまりで**大きくし、
 * それ以外は先頭の1文字。太字などで始まる段落は、包むと強調ごと巨大になるので**あきらめる**。
 * 見た目は CSS 側の `.dropcap`(float)が作る。
 */
export function wrapDropCap(html: string): string {
  const m = /^<(span|ruby)\b[^>]*>[\s\S]*?<\/\1>/.exec(html);
  // 先頭がタグで、しかも縦中横でもルビでもないなら触らない
  if (!m && /^</.test(html)) return html;
  const head = m ? m[0] : Array.from(html)[0] ?? '';
  if (!head) return html;
  return `<span class="dropcap">${head}</span>${html.slice(head.length)}`;
}

/** 会話文(「『( で始まる段落)は字下げなし(rules §3・決定済み) */
export function isDialogueStart(text: string): boolean {
  return /^[「『(（〈《]/.test(text);
}

/**
 * 書名が「日本語の字を1字も含まない」か(英字・数字・記号だけ)。(2026-10-03)
 * 縦組みの本で書名が英字だけのとき、横書きを勧める一言を出すために使う。
 * ルビ・強調の記法を外した文に掛ける(｜や《》が混ざっても判定が狂わない)。空の書名は偽
 */
export function isLatinOnlyTitle(title: string): boolean {
  const t = plainText(title).replace(/\s/g, '');
  if (!t) return false;
  // 仮名・漢字・ハングル・全角の約物と記号(日本語の文の中の字)があれば日本語とみなす
  return !/[　-ヿ㐀-鿿가-힯豈-﫿＀-￯]/.test(t);
}

/**
 * 段落テキスト(生原稿)→ 本文用 HTML。
 * 変換順: エスケープ → ダッシュ正規化 → 強調 → ルビ → (縦書きなら)縦中横。
 */
export function paragraphHtml(raw: string, vertical: boolean): string {
  let s = escapeHtml(raw);
  s = normalizeDashes(s);
  s = convertEmphasis(s);
  s = convertAozoraRuby(s);
  if (vertical) s = applyTcy(s);
  return balanceInline(s);
}
