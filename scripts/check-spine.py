# 背文字の［ぎりぎりまで大きく］が、本当にぎりぎりになるかを実測する。
#
# ## なぜ在るか
#
# 「KDPの制限におさまるぎりぎりのサイズがボタン一つで指定できるといいんだけどなあ」
# (2026-08-21 ユーザー要望)
#
# 背文字の大きさには縛りが2つある(背幅・天地の字数)。画面は長らく背幅しか見ておらず、
# **字数の多い本では描画が縮めた実寸と食い違って**いた。ボタンを付けるなら、
# 押した後が本当に上限であることを数字で押さえないと「押したのに小さく出る」が戻ってくる。
#
# 中身は scripts/spine-probe.ts。ここは開発サーバーと headless Chrome を立てて
# その結果を受け取るだけ。仕組みは scripts/check-import.py と同じで、
# **`--dump-dom` は使えない**(測り終わる前に DOM を吐いて出ていく)ため、
# 小さな受け口を立てて、測り終わった側から POST させる。
#
# ## 使い方
#
#     python scripts/check-spine.py
#     python scripts/check-spine.py --chrome "C:\\path\\to\\chrome.exe"
#
# 終了コード 0 で通過。**5173 は使わない**(開発サーバーとぶつかる)。

from __future__ import annotations

import argparse
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 7通りを描いて画素を数えるだけなので、取り込みの検査より短くてよい
PROBE_TIMEOUT_S = 120

CHROME_CANDIDATES = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
]


def find_chrome(given: str | None) -> str | None:
    if given:
        return given
    for c in CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    return shutil.which('chrome') or shutil.which('google-chrome')


def free_port() -> int:
    """空いているポートを1つ借りる。**5173 は使わない**(開発サーバーとぶつかる)"""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return int(s.getsockname()[1])


class _Sink(http.server.BaseHTTPRequestHandler):
    """測定結果の受け口。POST の body をそのまま預かるだけ"""

    received: list[str] = []

    def do_POST(self):  # noqa: N802 (http.server の決まった名前)
        n = int(self.headers.get('Content-Length') or 0)
        _Sink.received.append(self.rfile.read(n).decode('utf-8', 'replace'))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args):
        pass  # 検査の出力を汚さない


def wait_for_http(url: str, timeout: float) -> bool:
    """開発サーバーが応えるまで待つ。

    **127.0.0.1 で待ってはいけない。** vite は `localhost` に bind し、この環境では
    localhost が ::1 にしか解決しない。名前で引かせれば、どちらに bind していても届く
    """
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.3)
    return False


def run_probe(chrome: str, work: Path) -> dict:
    vite_port = free_port()
    sink_port = free_port()
    _Sink.received.clear()
    httpd = http.server.HTTPServer(('127.0.0.1', sink_port), _Sink)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    env = dict(os.environ)
    env['PORT'] = str(vite_port)
    vite = subprocess.Popen(
        ['npx', 'vite', '--port', str(vite_port), '--strictPort', '--logLevel', 'error'],
        cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        shell=(os.name == 'nt'))
    try:
        if not wait_for_http(f'http://localhost:{vite_port}/', 90):
            return {'ok': False, 'fails': [f'開発サーバーが {vite_port} で上がりませんでした']}
        report = f'http://127.0.0.1:{sink_port}/result'
        url = (f'http://localhost:{vite_port}/scripts/spine-probe.html'
               f'?report={urllib.parse.quote(report)}')
        proc = subprocess.Popen(
            [chrome, '--headless=new', '--disable-gpu', '--no-first-run',
             '--no-default-browser-check', '--disable-extensions',
             f'--user-data-dir={work / "chrome-profile"}', url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.time() + PROBE_TIMEOUT_S
        while not _Sink.received and time.time() < end:
            time.sleep(0.3)
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        if not _Sink.received:
            return {'ok': False,
                    'fails': [f'{PROBE_TIMEOUT_S}秒たっても結果が返りませんでした']}
        return json.loads(_Sink.received[-1])
    finally:
        vite.terminate()
        httpd.shutdown()


def show_case(c: dict) -> None:
    print(f'■ {c["name"]}  背幅 {c["背幅"]}')
    rows = [('押す前', c['押す前']), ('押した後', c['押した後']),
            ('さらに5%', c['さらに5パーセント上げる'])]
    print('           書名     著者   版元   上限     頭打ち  余地    切った字  背の外')
    for label, s in rows:
        ink = s['ink']
        outside = ink['left'] + ink['right']
        limited = '背幅' if s['limitedBy'] == 'width' else '字数'
        print(f'   {label.ljust(8)} {str(s["titlePt"]).rjust(6)}pt {str(s["authorPt"]).rjust(5)} '
              f'{str(s["publisherPt"]).rjust(5)} {str(s["limitPt"]).rjust(6)}pt {limited.ljust(4)} '
              f'{str(s["headroom"]).rjust(6)} {str(s["dropped"]).rjust(6)}字 '
              f'{str(outside).rjust(6)}画素')
    # **画面が背幅しか見なかったころの答え**と並べる。
    # 字数の多い本ではここが食い違う ＝ 画面が嘘をついていた場所。
    # 0.3pt 未満のずれは mm と画素の丸め(300dpi で1画素 = 0.24pt)なので黙る
    b = c['押す前']
    if abs(b['widthOnlyPt'] - b['titlePt']) > 0.3:
        print(f'   ＊背幅だけを見ていたころの画面は {b["widthOnlyPt"]}pt と出していた。'
              f'実際に刷るのは {b["titlePt"]}pt（ここが画面の嘘だった）')
    print(f'   倍率 書名 {c["倍率"]["書名"]} / 著者 {c["倍率"]["著者"]} / 版元 {c["倍率"]["版元"]}')


def main() -> int:
    ap = argparse.ArgumentParser(
        description='背文字の［ぎりぎりまで大きく］が本当にぎりぎりになるかを実測する')
    ap.add_argument('--chrome', help='Chrome の実行ファイル(見つからないとき)')
    args = ap.parse_args()

    chrome = find_chrome(args.chrome)
    if not chrome:
        print('Chrome が見つかりません（--chrome で渡してください）')
        return 1

    # **後始末で落とさない。**(Windows 実測) Chrome を terminate した直後は
    # キャッシュのファイルがまだ握られていて、消そうとすると WinError 32 で例外になる
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        result = run_probe(chrome, Path(tmp))

    for c in result.get('cases', []):
        show_case(c)
        print()
    m = result.get('migration')
    if m:
        print(f'■ {m["name"]}')
        print(f'   {m["移した倍率"]}')
        print()
    if 落ちた := result.get('落ちた'):
        print(f'probe が落ちました: {落ちた}')
        print(result.get('stack', ''))
    fails = result.get('fails') or []
    if fails:
        for f in fails:
            print(f'NG {f}')
        return 1
    print('OK ［ぎりぎりまで大きく］は、押すと本当にぎりぎりになります'
          '（切れ0字・背の外0画素・さらに上げても大きくならない）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
