// 版面の読み値。
//
// これは**操作ではなく結果**なので、設定を並べた列の中にいるべきものではない。
// 実測でサイドバーの「版面(自動計算)」は 381px あり、コントロールは1つも無かった。
// プレビューの下端に置けば、どのステップにいても見えていて、操作の邪魔をしない。
//
// 畳んだ1行に出すのは、設定を触りながら目で追いたい値だけ。
// 用紙寸法・塗り足し・画像の推奨ピクセルは［詳しく］の中へ。

import { useState } from 'react';
import { PRINT_TARGETS, fmtMm, type ProjectSettings } from '../models/project';
import { fitWithin } from '../models/imageResolution';
import { PRINT_MAX_SIDE, WRAP_MAX_SIDE } from '../images/optimize';
import {
  bleedSummary,
  fullPagePx,
  gutterFloorLabel,
  gutterFloorMm,
  layoutSummary,
  mmToPx,
  paperSummary,
  plateAreaMm,
  printAreaMm,
  type PageLayout,
} from '../typeset/grid';

interface Props {
  layout: PageLayout;
  trimLabel: string;
  totalChars: number;
  chapters: number;
  /** 組み上がった実ページ数。まだ組めていなければ 0 */
  pageCount: number;
  /** 実ページ数が出るまでのつなぎ */
  estPages: number;
  /**
   * **まだ数えている最中か。**(2026-08-22)
   * 長い本は組み上がるまで何十秒もかかる。そのあいだ「120ページ（概算）」と
   * 出ていたが、背幅も入稿値もこの数から作るので、当てにならない数は出さない
   */
  counting?: boolean;
  /**
   * 紙の本を作るか。**作らない本には、字数・章数・組み方向だけを出す。**(2026-09-24)
   * 判型・字詰め・ページ数・ノド・画像の推奨サイズは紙の話で、電子書籍には無い
   */
  paper?: boolean;
  /**
   * 紙の出し先と印刷所の決まり。**ノドの下限・塗り足しの言い方が出し先で変わる**(2026-10-01)。
   * 省略は KDP(いままでの文)
   */
  print?: Pick<ProjectSettings, 'printTarget' | 'printRules' | 'binding'>;
}

export function InfoBar({
  layout,
  trimLabel,
  totalChars,
  chapters,
  pageCount,
  estPages,
  counting,
  paper = true,
  print = { printTarget: 'kdp' },
}: Props) {
  const [open, setOpen] = useState(false);
  if (!paper) {
    return (
      <div className="infobar">
        <div className="infobar-line">
          <span>電子書籍</span>
          <span className="sep" />
          <span>{layout.writingMode === 'vertical' ? '縦組み' : '横組み'}</span>
          <span className="sep" />
          <span className="mono">
            {chapters} 章 / {totalChars.toLocaleString()}字
          </span>
          <span className="sep" />
          <span className="hint">ページ数・版面は読む端末が決めます</span>
        </div>
      </div>
    );
  }
  const pages = pageCount || estPages;
  /** まだ1度も数え終わっていない = 数を出さない */
  const unknown = !pageCount && !!counting;
  const imgArea = printAreaMm(layout);
  // 画像の目安の細かさは出し先で変わる(KDP・その他は 300。PRINT_TARGETS の imagePpi)
  const profile = PRINT_TARGETS[print.printTarget];
  const ppi = profile.imagePpi;
  // 取り込みは長い辺を PRINT_MAX_SIDE までに縮める。それを超える大きさは、言わない(用意しても縮められる)
  const full = fitWithin(fullPagePx(layout, ppi), PRINT_MAX_SIDE);
  const spreadMm = plateAreaMm(layout, 'spread');
  const spread = fitWithin({ w: mmToPx(spreadMm.w, ppi), h: mmToPx(spreadMm.h, ppi) }, WRAP_MAX_SIDE);

  return (
    <div className={open ? 'infobar open' : 'infobar'}>
      <div className="infobar-line">
        <span>{trimLabel}</span>
        <span className="sep" />
        <span>{layout.writingMode === 'vertical' ? '縦組み' : '横組み'}</span>
        {layout.columns > 1 && (
          <>
            <span className="sep" />
            <span>{layout.columns}段</span>
          </>
        )}
        <span className="sep" />
        <span className="mono">
          {layout.charsPerLine}字 × {layout.linesPerCol}行
        </span>
        <span className="sep" />
        <span className="mono">{totalChars.toLocaleString()}字</span>
        <span className="sep" />
        <span className="mono">
          {unknown ? (
            '数えています…'
          ) : (
            <>
              {pages}ページ
              {!pageCount && <small>（概算）</small>}
            </>
          )}
        </span>
        <span className="sep" />
        <span className="mono">ノド {layout.margins.gutter.toFixed(2)}mm</span>
        {/* 画像の推奨サイズは畳んだ行にも出す。「01 絵」の案内が情報バーを指しているので、
            開かないと見えない状態だと案内が嘘になる(2026-08-16 ユーザー指摘) */}
        <span className="sep" />
        <span className="infobar-img">
          画像
          <b className="mono">
            全面 {full.w.toLocaleString()}×{full.h.toLocaleString()}px
          </b>
          <b className="mono">
            本文内 {mmToPx(imgArea.w, ppi).toLocaleString()}×{mmToPx(imgArea.h, ppi).toLocaleString()}px
          </b>
        </span>
        <button className="infobar-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          詳しく {open ? '▴' : '▾'}
        </button>
      </div>

      {open && (
        <div className="infobar-detail">
          <div>
            <h4>版面</h4>
            <p className="mono">{layoutSummary(layout)}</p>
            <p className="hint">
              字詰・行数は判型と余白から整数で自動導出。端数はノド:小口=1.4:1、天:地=1:1.25 で配ります
            </p>
          </div>

          <div>
            <h4>入稿する用紙</h4>
            <p className="mono">{paperSummary(layout)}</p>
            <p className="hint">
              {/* 塗り足し 0 のときは「塗り足し込み」と言わない(続く bleedNote が
                  「塗り足しを付けない寸法です」と言うので、同じ段落で食い違う。2026-10-01 検証の指摘) */}
              {bleedSummary(layout.bleed) === 'なし'
                ? '塗り足しを付けない用紙で書き出します。'
                : '紙の端まで画像を出せるよう、塗り足し込みの用紙で書き出します。'}
              {profile.rulesSource === 'kdp' ? (
                <>
                  KDP の入稿画面では<b>「裁ち落としあり」</b>を選んでください
                </>
              ) : (
                profile.bleedNote(layout.bleed)
              )}
            </p>
          </div>

          <div>
            <h4>原稿</h4>
            <p className="mono">
              {chapters} 章 / {totalChars.toLocaleString()} 字
            </p>
            <p className="hint">
              {unknown
                ? `ページ数を数えています。数え終わるとノドの下限が確定します（いまのノドは ${layout.margins.gutter.toFixed(2)}mm）`
                : `${gutterFloorLabel(print).replace('の下限', 'のノド下限')}は ${gutterFloorMm(pages, print)}mm（${pages}ページのとき）${
                    layout.writingMode === 'horizontal'
                      ? '。横組みは行末の句読点が1字ぶんノドへ出るので、そのぶん足して組みます'
                      : ''
                  }。いまのノドは ${layout.margins.gutter.toFixed(2)}mm です`}
            </p>
          </div>

          <div>
            <h4>画像の推奨サイズ（{ppi}dpi）</h4>
            <p className="mono">
              本文に入れる{layout.columns > 1 ? '（1段ぶん）' : ''}
              {mmToPx(imgArea.w, ppi).toLocaleString()} × {mmToPx(imgArea.h, ppi).toLocaleString()} px
            </p>
            <p className="mono">
              ページ全面　{full.w.toLocaleString()} × {full.h.toLocaleString()} px
            </p>
            {/* 見開きの絵(挿絵の「見開き（2ページ）」)は用紙2枚ぶん。取り込みの上限は表紙の「まるごと1枚」と同じ(BackgroundPicker の maxSide) */}
            <p className="mono">
              見開き　{spread.w.toLocaleString()} × {spread.h.toLocaleString()} px
            </p>
            <p className="hint">
              {profile.rulesSource === 'kdp'
                ? `全面は塗り足し込み。断裁で外周 ${fmtMm(layout.bleed.top)}mm ほどは切り落とされます`
                : bleedSummary(layout.bleed) === 'なし'
                  ? '塗り足しは付けないので、全面は仕上がりと同じ寸法です'
                  : `全面は塗り足し込み。断裁で塗り足し ${bleedSummary(layout.bleed)} ほどは切り落とされます`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
