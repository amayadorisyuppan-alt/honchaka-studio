// 測った結果を、検査スクリプト(scripts/check-typeset.py)へ返す道。
//
// **headless Chrome の `--dump-dom` は使えない。** 実測すると、非同期の測定が
// 終わる前に DOM を吐いて出ていく(`--virtual-time-budget=60000` を付けても
// title が PROBE-RUNNING のまま出た)。組版もフォントの読み込みも本物の時間で走るので、
// 仮想時間では待てない。
//
// そこで**測り終わった側から知らせる。** 検査スクリプトが小さな受け口を立てておき、
// 測り終えたらそこへ POST する。`mode: 'no-cors'` + text/plain なので
// 事前確認(preflight)は飛ばず、受け口は body を受け取るだけでよい。

/**
 * 結果を画面に出し、`?report=` があればそこへ返す。
 * @param ok 検査として通ったか(document.title に出す。人が直に開いたときの目印)
 */
export function reportProbe(result: unknown, ok: boolean): void {
  const el = document.getElementById('probe-result');
  if (el) el.textContent = JSON.stringify(result, null, 1);
  document.title = ok ? 'PROBE-DONE' : 'PROBE-FAIL';
  const url = new URLSearchParams(location.search).get('report');
  if (!url) return;
  void fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(result),
  }).catch(() => {
    /* 受け口が無くても、画面には出ているので測定そのものは無駄にならない */
  });
}
