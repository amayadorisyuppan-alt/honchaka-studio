// 工程レール。作業の順番そのものを横一列に置く。
//
// **ウィザードではない。** どのステップにもいつでも飛べるし、レールは常に見えている。
// 本づくりは行ったり来たりする作業なので、一方通行に縛ると必ず邪魔になる。
// レールが担うのは順路の提示と、いまどこにいるかの表示だけ。

/**
 * レールに載るのは**工程だけ**。載せないものが2種類ある。
 *
 * 1. **原稿の出し入れ**(旧 01) … 取り込む・続きを開く・サンプルを見る。
 *    本を作る手順ではなくその手前の分岐なので、入口画面(StartScreen)が受け持つ。
 *    工程として並べていたころは、作業中に 01 を押した人が別画面へ飛ばされて驚いた。
 * 2. **版面の道具**(旧 02 見た目) … 書体・サイズ・行送り・段組み・色・フチ・帯。
 *    一度決めて次へ進むものではなく、絵を入れながら、奥付を書きながら、
 *    そのつど戻って変えたくなる。画面下の帯(FormatBar)に常駐させる。
 *
 * どちらも 2026-08-19 のユーザー判断。**工程は「順番に片づくもの」だけ。**
 *
 * **ただし「本のかたち」は工程に戻した。**(2026-08-19 ユーザーの提案)
 * 帯に移したとき、判型・組み方向・目次・刷り色・用紙・ノンブル・柱までまとめて
 * 「道具」に入れたが、これらは決め切るもので、往復するのは書体と文字まわりだけだった。
 * 決め切るものを先頭の工程に戻すと、レールがそのまま制作の順路になる。
 */
export type StepId = 'shape' | 'art' | 'colophon' | 'cover' | 'ai' | 'export';

/**
 * ステップのしるし。
 * - done      決まっている
 * - attention 出力はできるが、直したほうがよいことがある
 * - todo      まだ触っていない / 空
 */
import { useEffect, useRef, useState } from 'react';
import { FrogPeek } from './FrogMark';
import { pickMurmur } from './frogLines';

export type StepState = 'todo' | 'done' | 'attention';

/**
 * **番号は振らない。** ラベルを「絵」「奥付」のような名詞にしていたころは、
 * どこで何をするのか読めず、順番だけが手がかりだった(だから番号が要った)。
 * ラベル自体を**やること**にしたので、番号は意味を持たない
 * (2026-08-19 ユーザー判断)。並び順は矢印が示す。
 */
/**
 * 工程ごとの色。**レールと帯を同じ色で結ぶための目印。**
 *
 * 帯(FormatBar)は工程によって中身が入れ替わるのに、見た目が同じだったので
 * 「変わったことに初見では気づけない」と言われた(2026-08-19 ユーザー指摘)。
 * いま開いている工程の色を、レールの選択と帯の左端の両方に出す。
 * 2か所に同じ色が出ていれば、帯がどの工程のものかが色だけで読める。
 *
 * 明度はそろえてある。地の上で読める範囲で、隣どうしが混ざらない色相を選んだ。
 *
 * **色の実体は app.css の `--step-*` にある。**(2026-08-20)
 * 明るいテーマを足したので、6色とも地に合わせて2組が要る。ここに16進を書くと
 * テーマの数だけ TypeScript 側にも分岐が生まれるので、値は CSS の1か所に置き、
 * こちらは名前だけを渡す。渡し先は `--step-accent`(レールの下線・帯の上端)。
 */
export const STEP_ACCENT: Record<StepId, string> = {
  shape: 'var(--step-shape)', // 青  … 器を決める
  art: 'var(--step-art)', // 青緑 … 絵を入れる
  colophon: 'var(--step-colophon)', // 金  … 奥付
  cover: 'var(--step-cover)', // 紫  … 表紙
  ai: 'var(--step-ai)', // 橙  … AI
  export: 'var(--step-export)', // 緑  … 書き出す
};

export const STEPS: { id: StepId; label: string }[] = [
  // 器を決めてから中身に入る。ここだけは順番に意味がある
  { id: 'shape', label: '本のかたちを決める' },
  { id: 'art', label: '本文に画像とコラムを入れる' },
  { id: 'colophon', label: '奥付と著者紹介を入れる' },
  { id: 'cover', label: '表紙をつくる' },
  // ひととおり作ってから、書き出す前に見てもらう。飛ばしてよい工程
  { id: 'ai', label: 'AI に手直ししてもらう' },
  { id: 'export', label: '完成データを書き出す' },
];

interface Props {
  current: StepId;
  states: Record<StepId, StepState>;
  onSelect: (id: StepId) => void;
}

/** 工程を切り替えたとき、カエルがつぶやく確率。**毎回は出さない**(「ときどき」がユーザーの言葉) */
const MURMUR_CHANCE = 0.35;
/** 吹き出しを出しておく時間 */
const MURMUR_MS = 5200;

export function StepRail({ current, states, onSelect }: Props) {
  // ---- カエルのつぶやき(2026-10-07 ユーザー要望「ときどきカエルのつぶやきがランダムに出るといい」) ----
  // 工程を切り替えたときに MURMUR_CHANCE の確率で、カエルを押したときは必ず、吹き出しが数秒出る。
  // レールは横にはみ出すと巻き取る(overflow-x: auto)ので、吹き出しを中に置くと切れる。
  // **カエルの位置を測って、画面に固定(position: fixed)で出す**
  const frogRef = useRef<HTMLButtonElement>(null);
  const [murmur, setMurmur] = useState<{ text: string; top: number; right: number } | null>(null);
  const lastRef = useRef<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const firstRef = useRef(true);
  const say = (step: StepId) => {
    const el = frogRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const text = pickMurmur(step, lastRef.current);
    lastRef.current = text;
    setMurmur({ text, top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right - 4) });
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setMurmur(null), MURMUR_MS);
  };
  useEffect(() => {
    // 開いた直後(最初の工程が決まっただけ)はつぶやかない
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    if (Math.random() < MURMUR_CHANCE) say(current);
    else setMurmur(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return (
    <nav className="rail" aria-label="作業の順番">
      {STEPS.map((s, i) => {
        const isCurrent = current === s.id;
        // **✓(決まっている)と○(未着手)の印はやめた。**(2026-09-04 外部レビュー
        // 「✓マークに意味がない」)。サンプル入りで始まるアプリなので、ほぼ全工程が
        // 最初から✓になり、印が情報を運んでいなかった。残すのは意味を持つ
        // 「!」(出力はできるが確かめてほしい)だけ。「いまここ」はボタンの塗りと
        // 下線(.on + --step-accent)が引き受ける
        return (
          <div className="rail-cell" key={s.id}>
            {i > 0 && (
              <span className="rail-arrow" aria-hidden="true">
                ›
              </span>
            )}
            <button
              className={`rail-step ${isCurrent ? 'on' : ''}`}
              style={isCurrent ? { ['--step-accent' as string]: STEP_ACCENT[s.id] } : undefined}
              aria-current={isCurrent ? 'step' : undefined}
              onClick={() => onSelect(s.id)}
            >
              {states[s.id] === 'attention' && (
                <span className="rail-no attention" title="確かめてください">
                  !
                </span>
              )}
              {s.label}
            </button>
          </div>
        );
      })}
      {/* 作業画面のかくれカエル(1画面1匹)。「書き出す」の先=ゴールで待っている。
          押すとひと言つぶやく(見つけた人へのおまけ) */}
      <button
        ref={frogRef}
        className="rail-frog"
        aria-label="カエルのひと言"
        onClick={() => say(current)}
      >
        <FrogPeek width={30} />
      </button>
      {murmur && (
        <span
          className="frog-murmur"
          role="status"
          style={{ top: murmur.top, right: murmur.right }}
          onClick={() => setMurmur(null)}
        >
          {murmur.text}
        </span>
      )}
    </nav>
  );
}
