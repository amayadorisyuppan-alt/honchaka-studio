// 組版HTMLに同梱する @font-face を、動いているページのスタイルシートから集める。
//
// なぜ要るか: manuscriptHtml() が作るのは独立した1枚のHTMLで、
// 印刷経路(printHTML が作る iframe)や CLI ではアプリ本体のCSSが届かない。
// @font-face が無いと font-family の指定だけが残り、閲覧環境の游明朝などに
// 黙って置き換わる。選んだ書体がPDFに入らないので、必ず持たせる。
//
// URL は絶対化する。iframe の baseURI は about:srcdoc などになり、
// 相対パスだと解決先が変わってしまうため。

/** font-family の値から実際のファミリー名だけを取り出す(総称ファミリーは捨てる) */
export function familyNames(stack: string): string[] {
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy']);
  return stack
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s && !generic.has(s));
}

export function absolutize(cssText: string, base: string): string {
  return cssText.replace(/url\((['"]?)([^)'"]+)\1\)/g, (m, _quote, url: string) => {
    if (/^(data:|https?:|blob:)/.test(url)) return m;
    try {
      return `url("${new URL(url, base).href}")`;
    } catch {
      return m;
    }
  });
}

/** @font-face の unicode-range を読み、そのどれかが text に出てくるか判定する */
function rangeUsed(rule: CSSFontFaceRule, used: Set<number>): boolean {
  return unicodeRangeHits(rule.style.getPropertyValue('unicode-range'), used);
}

/** unicode-range の値(「U+3000-303F, U+4E00」など)のどれかが used の字に掛かるか。空(範囲指定なし)は常に掛かる */
export function unicodeRangeHits(rangeText: string, used: Set<number>): boolean {
  const raw = rangeText.trim();
  if (!raw) return true; // 範囲指定なしは常に要る
  for (const part of raw.split(',')) {
    const t = part.trim().toLowerCase().replace(/^u\+/, '');
    if (t.includes('-')) {
      const [a, b] = t.split('-');
      const lo = parseInt(a, 16);
      const hi = parseInt(b, 16);
      for (const c of used) if (c >= lo && c <= hi) return true;
    } else if (t.includes('?')) {
      const lo = parseInt(t.replace(/\?/g, '0'), 16);
      const hi = parseInt(t.replace(/\?/g, 'f'), 16);
      for (const c of used) if (c >= lo && c <= hi) return true;
    } else {
      if (used.has(parseInt(t, 16))) return true;
    }
  }
  return false;
}

/**
 * 指定したファミリーの @font-face を集めて1つのCSSにする。
 * 同一オリジンのスタイルシートしか読めないが、書体はすべて自前で配信しているので足りる。
 *
 * @param text 本に出てくる文字。渡すと、その字を含むサブセットの @font-face だけに絞る。
 *   日本語の書体は1ウェイト約120サブセットに分かれており、全部書くとCSSだけで
 *   50万字を超える。設定を触るたびにこれを組み立て直して Vivliostyle に読ませ直すので、
 *   絞らないとアプリ全体がもたつく(実測: HTML 66万字のうち 57万字が @font-face だった)
 */
export function collectFontFaceCss(stacks: string[], text = ''): string {
  if (typeof document === 'undefined') return '';
  const want = new Set(stacks.flatMap(familyNames).map((f) => f.toLowerCase()));
  if (!want.size) return '';

  const used = new Set<number>();
  for (const ch of text) used.add(ch.codePointAt(0) ?? 0);
  // 本文が空のうちは絞り込めないので、そのときだけ全部入れる
  const filter = used.size > 0;

  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 別オリジンのスタイルシートは読めない(この構成では出ないはず)
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const fam = rule.style
        .getPropertyValue('font-family')
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase();
      if (!want.has(fam)) continue;
      if (filter && !rangeUsed(rule, used)) continue;
      out.push(absolutize(rule.cssText, sheet.href ?? document.baseURI));
    }
  }
  return out.join('\n');
}
