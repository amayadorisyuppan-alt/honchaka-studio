// 色を選ぶ欄。**丸をドラッグしているあいだは、描き直しを間引く。**
//
// ブラウザの色の欄は、丸を少し動かすたびに input を出す。1回ごとに表紙(大きなキャンバス)や
// 本文の組み直しが走るので、知らせが積もってぎくしゃくし、手を止めたあとで「どどっと」動いた
// (2026-09-27 ユーザー報告。実測: 16ms おきに 40 回の input で、くっきりの帯 3.4 秒・ぼかしの帯 16 秒かかった)。
//
// 見本の色(この欄そのもの)はすぐ変え、呼び出し側へ渡すのは INTERVAL ms に1回までにする。
// 最後の色は必ず渡す(間引いたぶんの末尾・欄から離れたとき・画面から消えるとき)。
// 呼び出し側は今までの <input type="color"> と同じく e.target.value を読めばよい
//
// **絵の色の一覧(2026-10-03)。** 表1の絵の色を表4で使いたいとき、スポイトは「マスクがかかっていて色が取れない」。
// そこで、絵から数えた色(images/palette.ts)を、欄の右下の小さな ▾ から開く札に並べる。押すとその色が入る
// (欄をいじったときと同じ流れ。Ctrl+Z で戻せる)。並びは、まわりを包む <ColorPaletteProvider> が渡す
// (表紙の画面は表紙の絵、本文の画面は本の絵)。**並びが無いときは、今までどおり色の欄だけ。**
// 白黒の本では、並べる色もグレーに落とす(刷り上がりの見え方と同じ。typeset/css.ts の toGray)
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { toGray } from '../typeset/css';

interface PaletteValue {
  colors: readonly string[];
  /** 札の見出し。「この表紙の絵の色」など */
  label: string;
  /** 白黒の本。並べる色をグレーに落とす */
  mono: boolean;
}
const PaletteCtx = createContext<PaletteValue | null>(null);

/** 中の色の欄すべてに、絵の色の並びを渡す。入れ子にしたときは内側が勝つ */
export function ColorPaletteProvider({
  colors,
  label,
  mono = false,
  children,
}: {
  colors: readonly string[];
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ colors, label, mono }), [colors, label, mono]);
  return <PaletteCtx.Provider value={value}>{children}</PaletteCtx.Provider>;
}

/** 白黒の本なら、グレーに落として同じ灰色をまとめる */
function shownColors(colors: readonly string[], mono: boolean): string[] {
  if (!mono) return [...colors];
  return [...new Set(colors.map((c) => toGray(c)))];
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  /** この欄だけ別の並びを使いたいとき(ふつうは Provider から来る) */
  palette?: readonly string[];
};

/**
 * 呼び出し側へ渡すまで待つ時間(ms)。そのあいだに来た色は、最新の1つにまとめる。
 * **「前に渡したとき」から数えてはいけない。** 描き直しがこれより長くかかると、待ちが0になって
 * 1回ずつ渡り、間引きが効かなかった(2026-09-27 実測)。色が来てから数えれば、
 * 描き直しのあいだに積もった色は、描き終わったあとの 1 回にまとまる
 */
const INTERVAL = 120;

export function ColorInput({ value, onChange, onBlur, palette, ...rest }: Props) {
  const ctx = useContext(PaletteCtx);
  const [draft, setDraft] = useState(value);
  /** まだ渡していない色。null なら渡し済み */
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const flush = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    const v = pending.current;
    if (v === null) return;
    pending.current = null;
    onChangeRef.current({ target: { value: v } });
  };

  // 外から値が変わったら(元に戻す・別の本を開く)見本も合わせる。動かしている最中は上書きしない
  useEffect(() => {
    if (pending.current === null) setDraft(value);
  }, [value]);
  // 画面から消えるときも、最後の色は渡す
  useEffect(() => () => flush(), []);

  const colors = useMemo(
    () => shownColors(palette ?? ctx?.colors ?? [], ctx?.mono ?? false),
    [palette, ctx],
  );
  const input = (
    <input
      {...rest}
      type="color"
      value={draft}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        pending.current = v;
        if (timer.current === undefined) timer.current = window.setTimeout(flush, INTERVAL);
      }}
      onBlur={(e) => {
        flush();
        onBlur?.(e);
      }}
    />
  );
  // **外側の入れ物はいつも同じ `<span>`**にする。色の一覧が届いたときに入れ物が裸の <input> から
  // <span> に変わると、入力が作り直されて、開いている色の選び窓が閉じてしまう(2026-10-03 監査)。▾だけを出し入れする
  const showPalette = colors.length > 0 && !rest.disabled;
  return (
    <span className="colorpal">
      {input}
      {showPalette && (
      <PaletteButton
        colors={colors}
        label={ctx?.label ?? 'この画像の色'}
        current={draft}
        onPick={(c) => {
          // 動かしている途中の色は捨てて、選んだ色を1回で渡す
          if (timer.current !== undefined) {
            window.clearTimeout(timer.current);
            timer.current = undefined;
          }
          pending.current = null;
          setDraft(c);
          onChangeRef.current({ target: { value: c } });
        }}
      />
      )}
    </span>
  );
}

/** 欄の右下の ▾ と、押すと開く色の札。札は画面の外へはみ出さないよう body の直下に置く(帯は横にスクロールするので) */
function PaletteButton({
  colors,
  label,
  current,
  onPick,
}: {
  colors: readonly string[];
  label: string;
  current: string;
  onPick: (c: string) => void;
}) {
  const [at, setAt] = useState<{ x: number; top?: number; bottom?: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || btn.current?.contains(t)) return;
      close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [at]);
  const open = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    // 札の幅は 8 色で約 220px。右の端からはみ出さない。下に余白が足りない(帯は画面の下にある)ときは上に出す
    const x = Math.max(8, Math.min(r.left, window.innerWidth - 232));
    setAt(
      window.innerHeight - r.bottom < 110
        ? { x, bottom: window.innerHeight - r.top + 4 }
        : { x, top: r.bottom + 4 },
    );
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="colorpal-btn"
        title={`${label}から選ぶ`}
        aria-label={`${label}から選ぶ`}
        aria-expanded={!!at}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (at) setAt(null);
          else open();
        }}
      >
        ▾
      </button>
      {at &&
        createPortal(
          <div
            ref={pop}
            className="colorpal-pop"
            role="listbox"
            aria-label={label}
            style={{ left: at.x, top: at.top, bottom: at.bottom }}
          >
            <span className="colorpal-name">{label}</span>
            <span className="colorpal-row">
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="option"
                  aria-selected={c.toLowerCase() === current.toLowerCase()}
                  className={c.toLowerCase() === current.toLowerCase() ? 'colorpal-sw on' : 'colorpal-sw'}
                  style={{ background: c }}
                  title={c}
                  aria-label={c}
                  onClick={() => {
                    onPick(c);
                    setAt(null);
                  }}
                />
              ))}
            </span>
          </div>,
          document.body,
        )}
    </>
  );
}
