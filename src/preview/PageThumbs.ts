// プレビュー横のページサムネイル。
//
// 画像を作るのではなく、組み上がったページのDOMをそのまま複製して縮小する。
// 誌面のデザイン(背景・挿絵・書体)がそのまま小さく見え、組版と食い違わない。
//
// 組み上がるのを待たず、出来たページから順に足していく(sync)。
// 全部そろってから作ると、長い本では十数秒なにも出ない。
//
// 見えている範囲だけ複製する。判定は IntersectionObserver ではなくスクロール位置の計算で行う
// (描画が走らない環境では IO のコールバックが発火せず、永久に空のままになる。実測で確認)。
//
// ## 並べ替え(2026-08-19 ユーザー要望)
//
// **動かせるのは差し込んだページだけ。** 挿絵ページ・コラムページ・クッションページは
// 「何章の前に挟むか」で位置を持っているので、章の切れ目にしか置けない。
// 本文のページ(章の途中の絵を含む)は原稿の並びそのものなので動かない。
// 章の途中の絵を動かすのは［挿絵］の一覧の［場所を選び直す］(段落を選ぶ)。
//
// **できないことを手で分からせる。** 動かせるページにだけ取っ手を出し、
// 動かせないページをつかんだら理由と行き先を札で出す。
// 落とせる場所は、ドラッグ中に章の切れ目だけを光らせる
// (「章をひっくり返したいからドラッグ」を必ずやる人がいる、というユーザーの読み)。

/** サムネイルの幅(px)。CSS の .thumb と合わせる */
const THUMB_W = 92;
/** 画面外でも先に用意しておく余裕(px)。スクロールしたとき空白が見えないように */
const AHEAD = 400;

/** 差し込んだページの種類。設定側の入れものが別なので分けて持つ */
export type InsertKind = 'plate' | 'colpage';

/** そのページが何なのか。動かせるか、動かせないなら何と言うか */
export interface PageRole {
  /** 差し込んだページなら、その素性 */
  insert?: { kind: InsertKind; id: string };
  /** 章の起こしページか(= ここが落とし場所になる) */
  chapterStart?: number;
  /** 奥付のページか(= 本文の最後の落とし場所) */
  colophon?: boolean;
  /**
   * 組版が自分で挟んだ白ページか。
   * **原稿にも設定にも無いページ**なので、動かす先としても数えない
   */
  autoBlank?: boolean;
  /**
   * 見開きの絵の2ページ目か(1ページ目と1組。typeset/spread.ts)。
   * 差し込みとしては数えない(動かすのは1ページ目)が、**落とし場所を数えるときは1ページ目の一部**として扱う
   * (2026-10-03 レビュー: 2ページ目で数えが止まり、見開きの後ろに落とすと見開きの前に入っていた)
   */
  spreadTail?: boolean;
  /** 動かせないときに出す一言 */
  why: string;
}

/** その切れ目に何を足すか */
export type AddKind = 'plate' | 'colpage' | 'blank';

export interface ThumbHooks {
  /**
   * 章の切れ目に新しいページを足す。
   *
   * **左の欄から足すと必ず本の最後に付く。**(2026-08-19 ユーザー指摘
   * 「どのプレビューページを見ていても一番後ろに入ってしまうので探し回る」)
   * 見ている場所に足せれば、そのあと動かす手間そのものが要らない
   */
  onAdd?: (kind: AddKind, beforeChapter: number) => void;
  /**
   * いま足してよいページの種類。**開くたびに訊く**(作るものは途中で変わるので)。
   * 電子書籍だけを作る本にはクッションを出さない — 白ページは EPUB に入らず、
   * ［本文に画像とコラムを入れる］にもクッションの面が無いので、足しても見えない1枚になる
   * (2026-09-23 レビューで発見)。渡さなければ全部
   */
  addKinds?: () => AddKind[];
  /**
   * 差し込んだページを動かす。
   * `at` は**動かすものを抜いたあとの列で、何枚目に置くか**(0始まり)。
   * 同じ切れ目に挿絵とコラムが並ぶことがあり、その中の順番も入れ替えたい
   * (2026-08-20 ユーザー指摘「P15,P16は章末にあるからひっくり返せるのでは」)。
   *
   * **「抜いたあとの列で」と決めたのが肝。** 画面に並んでいるままの数で渡すと、
   * 同じ切れ目の自分より後ろへ落としたときに1つ行き過ぎる
   * (3枚並んだ切れ目で「A を C の前へ」が [B,C,A] になっていた)。
   * ずれの直しは PageThumbs 側でやる — ここに来る前に確定させておく
   */
  onMove?: (kind: InsertKind, id: string, beforeChapter: number, at: number) => void;
  /** 差し込んだページを消す */
  onDelete?: (kind: InsertKind, id: string) => void;
  /** 差し込んだページを複製する(同じ場所にもう1枚) */
  onCopy?: (kind: InsertKind, id: string) => void;
}

/**
 * ページの実寸(px)。
 * Vivliostyle は表示中の見開き以外のページを display:none にするため、
 * offsetWidth/offsetHeight は 0 になる。寸法はインラインに書かれているのでそれを読む。
 */
function pageSize(el: HTMLElement): { w: number; h: number } {
  const cs = getComputedStyle(el);
  const w = parseFloat(el.style.width) || parseFloat(cs.width) || el.offsetWidth || 1;
  const h = parseFloat(el.style.height) || parseFloat(cs.height) || el.offsetHeight || 1;
  return { w, h };
}

/** そのページが何なのかを、組み上がった DOM から読む */
function readRole(page: HTMLElement): PageRole {
  const plate = page.querySelector('[data-plate]')?.getAttribute('data-plate');
  if (plate) return { insert: { kind: 'plate', id: plate }, why: '' };
  // 見開きの絵の2ページ目(1ページ目と1組。typeset/spread.ts)。1ページ目といっしょに動く・消える
  if (page.querySelector('[data-plate-b]')) {
    return {
      spreadTail: true,
      why: '見開きの画像の2ページ目です。動かす・消すときは、1ページ目をつかんでください（2ページはいっしょに動きます）',
    };
  }
  const col = page.querySelector('[data-colpage]')?.getAttribute('data-colpage');
  if (col) return { insert: { kind: 'colpage', id: col }, why: '' };

  if (page.querySelector('section.titlepage')) return { why: '大扉はいちばん最初と決まっています' };
  if (page.querySelector('section.toc')) return { why: '目次は扉の次と決まっています' };
  if (page.querySelector('section.colophon')) {
    return { colophon: true, why: '奥付はいちばん最後と決まっています' };
  }

  /**
   * 組版が自分で挟んだ白ページ。
   *
   * `section.chapter.first { break-before: recto }`(css.ts)で本文の1ページ目を
   * 奇数ページから起こしているので、その手前が偶数で終わると1枚だけ白紙が入る。
   * **原稿にも設定にも無いページ**なので、掴んでも動かせないし、
   * その後ろに何かを置くこともできない。
   *
   * 見分けかたは「中身がまるごと空」。組版はページをまたぐときも `section` の
   * 入れ子ごと複製するので、本文の途中のページには必ず `section` が残る。
   * 実測(文庫サンプル36ページ): `section` を持たないのは4ページ目のこの1枚だけだった。
   *
   * **ここを本文のページと同じ扱いにしていたのが、今回の分かりにくさの一因。**
   * 「原稿の並びそのものです」と言われても、原稿に書いた覚えのないページなので
   * 話が噛み合わない(2026-08-20 ユーザー報告「P3をP4の後ろにずらせない」)
   */
  if (!page.querySelector('section')) {
    return {
      autoBlank: true,
      why: 'この白ページは組版が自動で入れています。本文の1ページ目を奇数ページから、見開きの画像を偶数ページから起こすための1枚なので、動かしたり、その後ろにページを置いたりはできません',
    };
  }

  // 章の起こし。id は html.ts が ch1 から順に振っている
  let chapterStart: number | undefined;
  page.querySelectorAll('section.chapter[id]').forEach((sec) => {
    const n = Number(/^ch(\d+)$/.exec(sec.id)?.[1]);
    if (Number.isFinite(n) && sec.querySelector('header.chapter-title')) chapterStart = n - 1;
  });
  return {
    chapterStart,
    why: '本文のページは動かせません。並びは原稿そのものです',
  };
}

/** 落とし場所(ページの並びから決まる。画面の線を出す位置・差し込みの何枚目か) */
export interface DropGap {
  /** この番号のページの「前」。roles.length ならいちばん後ろ */
  index: number;
  /** 何章の前か */
  before: number;
  /** その切れ目の中で何枚目か(0始まり) */
  at: number;
}

/** 落とし場所を数えるとき、前後の差し込みの一部として読み飛ばすページ(見開きの2ページ目・組版の白ページ) */
const isFiller = (r: PageRole | undefined): boolean => !!r && (!!r.spreadTail || !!r.autoBlank);

/**
 * 置ける場所を全部出す。置けるのは、章の起こしの前・奥付の前・差し込みページの前後だけ。
 *
 * `at` は「その切れ目の中で、差し込みが何枚並んでいるか」。**見開きの2ページ目と組版の白ページは
 * 数えず、読み飛ばして数え続ける**(見開きは1ページ目だけが差し込みで、2ページ目は無印。
 * 白ページは見開きを偶数ページから起こすために組版が挟む。ここで数えが止まると、見開きの後ろに落としても
 * 見開きの前に入ってしまう。2026-10-03 レビュー)
 */
export function buildDropGaps(roles: readonly PageRole[]): DropGap[] {
  const gaps: DropGap[] = [];
  const chapters = roles.filter((r) => r.chapterStart !== undefined).length;
  roles.forEach((role, i) => {
    const isEdge = role.chapterStart !== undefined || role.colophon || role.insert !== undefined;
    if (!isEdge) return;
    let before = chapters;
    for (let j = i; j < roles.length; j++) {
      const cs = roles[j].chapterStart;
      if (cs !== undefined) {
        before = cs;
        break;
      }
    }
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (roles[j].insert) at++;
      else if (!isFiller(roles[j])) break;
    }
    gaps.push({ index: i, before, at });
  });
  return gaps;
}

/**
 * ページ i の上半分／下半分から、いちばん近い落とし場所を選ぶ(上半分なら「その前」、下半分なら「その後ろ」)。
 * 見開きは2ページで1組、組版の白ページは前後の差し込みの一部として扱う:
 *  - 見開きの2ページ目の上半分 = 見開きの前 / 1ページ目の下半分 = 見開きの後ろ
 *  - 白ページ・2ページ目をまたいで、次の落とし場所まで進める
 */
export function resolveDropGap(
  gaps: readonly DropGap[],
  roles: readonly PageRole[],
  i: number,
  topHalf: boolean,
): DropGap | null {
  const at = (index: number) => gaps.find((g) => g.index === index) ?? null;
  // start から先へ、白ページ・2ページ目だけを読み飛ばして最初の落とし場所を探す
  const forward = (start: number): DropGap | null => {
    for (let j = start; j < roles.length; j++) {
      const g = at(j);
      if (g) return g;
      if (!isFiller(roles[j])) return null;
    }
    return at(roles.length);
  };
  if (topHalf && roles[i]?.spreadTail) return at(i - 1);
  return forward(topHalf ? i : i + 1);
}

export interface ThumbStrip {
  /** 出来ているページに合わせてサムネイルを増やす。何度呼んでもよい */
  sync: (pages: HTMLElement[]) => void;
  /** 現在ページ(0始まり)の見た目を更新する */
  setActive: (index: number) => void;
  /** 作っている最中かどうか。中なら「ページを作っています」を出す */
  setBusy: (busy: boolean) => void;
  /**
   * そのページを光らせる。**増えたことを目で分からせる。**
   * 左の欄とページ一覧は画面の反対側にあるので、片方で足しても
   * もう片方で何が起きたか読めなかった(2026-08-19 ユーザー指摘)
   */
  flash: (index: number) => void;
  /** 一覧の中に一言出す。**操作した場所のそばで言う** */
  notify: (text: string) => void;
  destroy: () => void;
}

export function createThumbs(
  strip: HTMLElement,
  onJump: (index: number) => void,
  hooks: ThumbHooks = {},
): ThumbStrip {
  strip.textContent = '';

  // 札。まだ1枚も出ていないときの手がかりになる(専門用語は使わない)
  const busyEl = document.createElement('p');
  busyEl.className = 'thumbs-busy';
  busyEl.textContent = 'ページを作っています…';
  strip.appendChild(busyEl);

  const list = document.createElement('div');
  list.className = 'thumb-list';
  strip.appendChild(list);

  /** できないことを伝える札。**掴んだその場に出す**(下まで探しに行かせない) */
  const toast = document.createElement('p');
  toast.className = 'thumb-toast';
  strip.appendChild(toast);
  let toastTimer = 0;
  /**
   * 札を出す。**出しておく長さは文の長さで決める。**
   *
   * 一律4秒だった。一覧の幅は116pxしかなく、60字を超える札は10行以上になるので、
   * 読み終わる前に消えていた(理由と行き先まで書く札ほど長い = いちばん読ませたい札ほど
   * 読めない)。1字あたり0.12秒を足して、上限12秒で止める
   */
  const say = (text: string) => {
    toast.textContent = text;
    toast.classList.add('on');
    window.clearTimeout(toastTimer);
    const hold = Math.min(12000, 4000 + text.length * 120);
    toastTimer = window.setTimeout(() => toast.classList.remove('on'), hold);
  };

  const cells: HTMLElement[] = [];
  const roles: PageRole[] = [];
  let sources: HTMLElement[] = [];
  let active = -1;
  /**
   * いま掴んでいる差し込みページ。
   *
   * **HTML5 の drag は使わない。**(2026-08-20 ユーザー報告
   * 「P15と16が入れ替えられない」— 実機のマウスで動かなかった)
   * dragstart が飛ぶかどうかが環境と要素の種類に左右されるうえ、
   * dragover で preventDefault を呼び忘れた場所は静かに「置けない」になる。
   * pointerdown/move/up なら、どこで何が起きているかが全部こちらの手にある
   */
  let dragging: { kind: InsertKind; id: string; from: number } | null = null;
  /** 掴んでから動いた距離。**押しただけ**とドラッグを分ける */
  let press: { x: number; y: number; index: number } | null = null;
  /** ドラッグの直後に来る click を1回だけ捨てる(ページが飛ばないように) */
  let swallowClick = false;

  const fill = () => {
    const top = strip.scrollTop - AHEAD;
    const bottom = strip.scrollTop + strip.clientHeight + AHEAD;
    cells.forEach((cell, i) => {
      if (cell.dataset.filled) return;
      if (cell.offsetTop + cell.offsetHeight < top || cell.offsetTop > bottom) return;
      const src = sources[i];
      if (!src) return;
      cell.dataset.filled = '1';
      const { w } = pageSize(src);
      const clone = src.cloneNode(true) as HTMLElement;
      clone.removeAttribute('id');
      // 元ページが隠されていても、サムネイルでは必ず見せる
      clone.style.display = 'block';
      clone.style.visibility = 'visible';
      clone.style.position = 'absolute';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.margin = '0';
      clone.style.transformOrigin = 'top left';
      clone.style.transform = `scale(${THUMB_W / w})`;
      cell.insertBefore(clone, cell.firstChild);
    });
  };

  strip.addEventListener('scroll', fill, { passive: true });

  /**
   * ドラッグ本体。**pointermove/up は window で受ける。**
   * セルの上だけで受けると、少し外へ出た瞬間に糸が切れて
   * 「掴んだのに動かない」になる
   */
  const onMove = (e: PointerEvent) => {
    if (!press && !dragging) return;
    if (!dragging) {
      if (!press) return;
      if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < 6) return;
      const i = press.index;
      const ins = roles[i]?.insert;
      if (!ins || !hooks.onMove) {
        // 動かせないページ。**その場で理由を出して、掴むのをやめる**
        const why = roles[i]?.why || '';
        press = null;
        if (why) {
          say(
            why.startsWith('本文')
              ? `${why}。章の順番を変えるなら［AI に手直ししてもらう］か、原稿を並べ替えて取り込み直してください`
              : why,
          );
        }
        return;
      }
      dragging = { ...ins, from: i };
      swallowClick = true;
      strip.classList.add('dragging');
      cells[i]?.classList.add('lifting');
      buildGaps();
      showGaps(true);
      say('薄い線のところに置けます。そこで指を離してください');
    }
    // どのページの上か。**上半分なら「その前」、下半分なら「その後ろ」**
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const cell = el?.closest?.('.thumb') as HTMLElement | null;
    const i = cell ? cells.indexOf(cell) : -1;
    if (i < 0) {
      showHover(null);
    } else {
      const r = cell!.getBoundingClientRect();
      showHover(gapAt(i, e.clientY < r.top + r.height / 2));
    }
    // 一覧の端に近づいたら送る(長い本では、掴んだまま端まで運べないと届かない)
    const s = strip.getBoundingClientRect();
    if (e.clientY < s.top + 40) strip.scrollTop -= 12;
    else if (e.clientY > s.bottom - 40) strip.scrollTop += 12;
    e.preventDefault();
  };

  /**
   * 離したときに何が起きたか。**黙って終わらせない。**
   *
   * (2026-08-20 ユーザー報告「P3をP4の後ろにずらそうとしたけど、どうしてもうまくいかなかった」)
   * 実測すると、掴めてはいた(`.thumbs.dragging` も `.lifting` も付いていた)。
   * 落とした先が**いまと同じ場所**だったので、並びが1つも変わらず、
   * ページが光っただけで終わっていた。置けない場所で離したときも同じで、
   * `hover` が無いまま黙って戻るだけだった。どちらも**理由がどこにも出ない**。
   */
  const onUp = () => {
    press = null;
    if (!dragging) return;
    const target = hover;
    cells[dragging.from]?.classList.remove('lifting');
    strip.classList.remove('dragging');
    const now = dragging;
    dragging = null;
    showHover(null);
    showGaps(false);

    // 置けない場所で離した。**行き先まで言う**(どこなら置けるのかが分からないため)
    if (!target) {
      say(
        'ここには置けません。差し込んだページは、章の起こしの前か奥付の前にしか置けません。' +
          '本文の途中に画像を入れたいときは、［本文に画像とコラムを入れる］の［挿絵］で' +
          '［章の途中に、画像を入れる］から段落を選んでください',
      );
      return;
    }

    /**
     * **いまと同じ場所なら、動かさずにそう言う。**
     *
     * `at` は「その切れ目の中で何枚目か」を並んでいるまま数えた数なので、
     * 動かすもの自身より後ろの切れ目へ落とすときは、自分を抜いたぶん1つ手前になる。
     * ここでそろえてから渡す(受け取る moveInsert は、動かすものを抜いた列に差し込む)。
     * 3枚並んだ切れ目で「A を C の前へ」が [B,C,A] になっていたのがこのずれ。
     */
    const own = gaps.find((g) => g.index === now.from) ?? null;
    const same = !!own && own.before === target.before;
    const at = same && own.at < target.at ? target.at - 1 : target.at;
    if (same && own.at === at) {
      // あいだにあるのが組版の白ページだけなら、動かない理由はそれ。
      // 「4ページ目の後ろへ」は、本のつくりの上では「第一章の前」＝いまと同じ場所になる
      const between =
        target.index > now.from
          ? roles.slice(now.from + 1, target.index)
          : roles.slice(target.index, now.from);
      const onlyBlank =
        between.length > 0 && between.some((r) => r.autoBlank) && between.every((r) => r.autoBlank || r.spreadTail);
      say(
        onlyBlank
          ? 'そこはいまと同じ場所です。あいだの白ページは、本文の1ページ目を奇数ページから、見開きの画像を偶数ページから起こすために組版が入れた1枚なので、その後ろには置けません'
          : 'そこはいまと同じ場所なので、並びは変わりません。別の薄い線のところで離してください',
      );
      return;
    }
    hooks.onMove?.(now.kind, now.id, target.before, at);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  /**
   * 落とし場所(数え方は上の buildDropGaps / resolveDropGap)。**ページそのものを落とし場所にする。**
   *
   * もとは隙間に 6px の帯を差し込んでいた。ドラッグ中に `preventDefault` を
   * 呼ぶのがその帯だけだったので、**帯を外すと「置けない」扱いになって
   * 何も起きなかった**(2026-08-20 ユーザー報告「P15と16が入れ替えられない」)。
   * 6px を狙わせるのがそもそも無理で、しかも帯を差し込むぶんページがずれる。
   *
   * いまはページの**上半分／下半分**で「この前／この後ろ」を決める。
   * 当たり判定がページ1枚ぶん(約130px)になり、線は目印としてページの縁に出す。
   */
  type Gap = DropGap;
  let gaps: Gap[] = [];

  /** 置ける場所を全部見せる。**掴んだ瞬間から出す**(どこへ運べばよいか分からないため) */
  const showGaps = (on: boolean) => {
    cells.forEach((c) => c.classList.remove('drop-ok'));
    if (!on) return;
    gaps.forEach((g) => cells[g.index]?.classList.add('drop-ok'));
  };

  const buildGaps = () => {
    gaps = buildDropGaps(roles);
  };

  /** いま指している落とし場所。線を出す位置でもある */
  let hover: Gap | null = null;
  /**
   * 切れ目に置く「＋」。**ドラッグしていなくても出す。**
   * ここに足せることが分かっていれば、左の欄へ行って足してから探し回らずに済む
   */
  const adders: HTMLElement[] = [];
  const showHover = (g: Gap | null) => {
    if (hover?.index === g?.index) return;
    cells.forEach((c) => c.classList.remove('drop-above'));
    hover = g;
    if (g) cells[g.index]?.classList.add('drop-above');
  };

  /** ページ i の上半分／下半分から、いちばん近い落とし場所を選ぶ */
  const gapAt = (i: number, topHalf: boolean): Gap | null => resolveDropGap(gaps, roles, i, topHalf);

  /**
   * 切れ目ごとの「＋」を引き直す。**サムネイルを作り直すたびに呼ぶ。**
   * 位置(何章の前か)はページの並びから読むので、組み直しのたびに変わる
   */
  const buildAdders = () => {
    adders.forEach((el) => el.remove());
    adders.length = 0;
    if (!hooks.onAdd) return;
    const chapters = roles.filter((r) => r.chapterStart !== undefined).length;
    roles.forEach((role, i) => {
      const before =
        role.chapterStart !== undefined ? role.chapterStart : role.colophon ? chapters : null;
      if (before === null) return;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'thumb-add';
      el.title = 'ここにページを足す';
      el.textContent = '＋';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        openAddMenu(r.right + 6, r.top, before);
      });
      list.insertBefore(el, cells[i]);
      adders.push(el);
    });
  };

  /** 右クリックの小さな献立。差し込んだページにだけ出す */
  let menu: HTMLElement | null = null;
  const closeMenu = () => {
    menu?.remove();
    menu = null;
  };
  /**
   * 献立の外を押したら閉じる。**destroy で必ず外すこと。**
   * サムネイルは組み直しのたびに作り直される(VivliostylePreview が destroy →
   * createThumbs)ので、無名関数のまま足すと document に聞き耳が1本ずつ溜まる
   * (実測 2026-08-22: 実原稿を11冊組んで11本。window に付ける4本と scroll は
   *  外していたのに、ここだけ外し忘れていた)
   */
  const onDocDown = (e: MouseEvent) => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener('mousedown', onDocDown);

  const openMenu = (x: number, y: number, ins: { kind: InsertKind; id: string }) => {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'thumb-menu';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const item = (label: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        closeMenu();
        run();
      });
      el.appendChild(b);
    };
    item('このページを複製する', () => hooks.onCopy?.(ins.kind, ins.id));
    item('このページを削除する', () => hooks.onDelete?.(ins.kind, ins.id));
    document.body.appendChild(el);
    menu = el;
    // 画面の右端・下端からはみ出さないところまで戻す
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) el.style.left = `${window.innerWidth - r.width - 8}px`;
    if (r.bottom > window.innerHeight - 8) el.style.top = `${window.innerHeight - r.height - 8}px`;
  };

  /** 「＋」を押したときの献立。足せるものを3つ並べる */
  const openAddMenu = (x: number, y: number, beforeChapter: number) => {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'thumb-menu';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const item = (label: string, kind: AddKind) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        closeMenu();
        hooks.onAdd?.(kind, beforeChapter);
      });
      el.appendChild(b);
    };
    const kinds = hooks.addKinds?.() ?? ['plate', 'colpage', 'blank'];
    if (kinds.includes('plate')) item('挿絵ページを足す', 'plate');
    if (kinds.includes('colpage')) item('コラムページを足す', 'colpage');
    if (kinds.includes('blank')) item('クッションページを足す', 'blank');
    document.body.appendChild(el);
    menu = el;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) el.style.left = `${window.innerWidth - r.width - 8}px`;
    if (r.bottom > window.innerHeight - 8) el.style.top = `${window.innerHeight - r.height - 8}px`;
  };

  return {
    sync(pages) {
      sources = pages;
      // 増えたぶんだけ足す(作り直すと、複製済みのサムネイルまで捨ててしまう)
      for (let i = cells.length; i < pages.length; i++) {
        const p = pages[i];
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'thumb';
        cell.title = `${i + 1}ページ目へ`;
        const { w, h } = pageSize(p);
        cell.style.height = `${Math.round((h / w) * THUMB_W)}px`;
        const no = document.createElement('span');
        no.className = 'thumb-no';
        no.textContent = String(i + 1);
        cell.appendChild(no);
        cell.addEventListener('click', () => onJump(i));
        list.appendChild(cell);
        cells.push(cell);
      }
      // 組み直しでページが減ったら、余ったサムネイルを落とす
      while (cells.length > pages.length) cells.pop()?.remove();

      // 素性を読み直す。組み直しのたびにページの中身は変わる
      roles.length = 0;
      pages.forEach((p, i) => {
        const role = readRole(p);
        roles[i] = role;
        const cell = cells[i];
        if (!cell) return;
        const ins = role.insert;
        cell.classList.toggle('movable', !!ins);
        cell.dataset.why = role.why;
        cell.title = ins
          ? `${i + 1}ページ目へ（つまんで動かせます／右クリックで複製・削除）`
          : // 白紙が1枚だけ挟まっていると「自分が作ってしまったのか」と読める。
            // 触れば分かるところに素性を書いておく
            role.autoBlank
            ? `${i + 1}ページ目へ（組版が自動で入れた白ページ）`
            : `${i + 1}ページ目へ`;
        if (ins && !cell.dataset.grip) {
          cell.dataset.grip = '1';
          // 取っ手。**動かせることを見た目で言う**(点の並びは掴む場所の万国共通の印)
          const grip = document.createElement('span');
          grip.className = 'thumb-grip';
          grip.textContent = '⠿';
          cell.appendChild(grip);
        }
        /**
         * **ブラウザのネイティブ・ドラッグを止める。**(2026-08-20 実測で判明)
         * サムネイルは組み上がったページの複製なので、中の <img> が
         * 既定でドラッグできてしまう。それが始まると pointerup が飛ばなくなり、
         * 離しても何も起きなかった(実測: pointerdown → pointermove の直後に
         * dragstart が出て、以降 pointerup が来ない)
         */
        cell.draggable = false;
        if (!cell.dataset.wired) {
          cell.dataset.wired = '1';
          cell.addEventListener('dragstart', (e) => e.preventDefault());
          cell.addEventListener('contextmenu', (e) => {
            const now = roles[cells.indexOf(cell)]?.insert;
            if (!now || (!hooks.onCopy && !hooks.onDelete)) return;
            e.preventDefault();
            openMenu(e.clientX, e.clientY, now);
          });
          cell.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            press = { x: e.clientX, y: e.clientY, index: cells.indexOf(cell) };
          });
          // **ドラッグの直後の click は捨てる。** 拾うとページまで飛んでしまう
          cell.addEventListener(
            'click',
            (e) => {
              if (!swallowClick) return;
              swallowClick = false;
              e.stopPropagation();
              e.preventDefault();
            },
            true,
          );
        }
      });
      buildAdders();
      fill();
    },

    setActive(index) {
      if (index === active) return;
      cells[active]?.classList.remove('active');
      const cell = cells[index];
      if (!cell) return;
      cell.classList.add('active');
      active = index;
      // 選んだページが列の外にあるときだけ寄せる(利用者のスクロールを奪わない)
      const r = cell.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      if (r.top < s.top || r.bottom > s.bottom) cell.scrollIntoView({ block: 'nearest' });
      fill();
    },

    setBusy(busy) {
      busyEl.textContent = busy ? 'ページを作っています…' : '';
      busyEl.classList.toggle('on', busy);
    },

    flash(index) {
      const cell = cells[index];
      if (!cell) return;
      cell.scrollIntoView({ block: 'center' });
      fill();
      // 一度外してから付け直す。続けて同じページを光らせたときも animation が走る
      cell.classList.remove('flash');
      void cell.offsetWidth;
      cell.classList.add('flash');
      window.setTimeout(() => cell.classList.remove('flash'), 2400);
    },

    notify(text) {
      say(text);
    },

    destroy() {
      strip.removeEventListener('scroll', fill);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.removeEventListener('mousedown', onDocDown);
      window.clearTimeout(toastTimer);
      closeMenu();
      strip.textContent = '';
      cells.length = 0;
      roles.length = 0;
      adders.length = 0;
      gaps = [];
      sources = [];
    },
  };
}
