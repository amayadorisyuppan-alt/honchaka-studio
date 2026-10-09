# 原稿を取り込み直しても、挿絵・コラム・背景が残っているかを実測する。
#
# ## なぜ在るか
#
# 「『文中に貼る』をやってみました。挿絵ページは残っているし、背景にも画像があったのだが、
#  コラムだけはなくなっていた」(2026-08-21 ユーザー報告)
#
# 差し込みページ(挿絵・コラム)は「何章の前か」で章に紐づいている。取り込み直すと
# **章の数が変わる**ので、範囲の外へ出たものは組版に出てこない。紙をいくら測っても
# この取りこぼしは出てこないので、ブラウザの側で store を動かして数える。
#
# 中身は scripts/import-probe.ts。ここは開発サーバーと headless Chrome を立てて
# その結果を受け取るだけ。仕組みは scripts/check-typeset.py の run_probes と同じで、
# **`--dump-dom` は使えない**(測り終わる前に DOM を吐いて出ていく)ため、
# 小さな受け口を立てて、測り終わった側から POST させる。
#
# ## 使い方
#
#     python scripts/check-import.py
#     python scripts/check-import.py --chrome "C:\\path\\to\\chrome.exe"
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

# 取り込み → 組版HTML を3通り測るので、store-probe より少し長めに待つ
PROBE_TIMEOUT_S = 180

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
        url = (f'http://localhost:{vite_port}/scripts/import-probe.html'
               f'?report={urllib.parse.quote(report)}')
        # **プロファイルは使い捨て。** probe は IndexedDB を書き換えるので、
        # ふだん使いのブラウザで開くと、その人の本が消える
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


def main() -> int:
    ap = argparse.ArgumentParser(description='取り込み直しで差し込みページが消えないかを実測する')
    ap.add_argument('--chrome', help='Chrome の実行ファイル(見つからないとき)')
    args = ap.parse_args()

    chrome = find_chrome(args.chrome)
    if not chrome:
        print('Chrome が見つかりません（--chrome で渡してください）')
        return 1

    # **後始末で落とさない。**(Windows 実測)
    # Chrome を terminate した直後はキャッシュのファイルがまだ握られていて、
    # 使い捨てプロファイルを消そうとすると WinError 32 で例外になる。
    # 測り終わっているのに結果を1行も出さずに落ちるので、消し残りは見逃す
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        result = run_probe(chrome, Path(tmp))

    for c in result.get('cases', []):
        print(f'■ {c["name"]}')
        b, a = c['before'], c['after']
        keys = [k for k in b if k in a]
        w = max(len(k) for k in keys)
        for k in keys:
            mark = '  ←減った' if isinstance(a[k], int) and a[k] < b[k] else ''
            print(f'   {k.ljust(w)}  {b[k]} → {a[k]}{mark}')
        if c.get('note'):
            print(f'   {c["note"]}')
    if 落ちた := result.get('落ちた'):
        print(f'probe が落ちました: {落ちた}')
        print(result.get('stack', ''))
    fails = result.get('fails') or []
    print()
    if fails:
        for f in fails:
            print(f'NG {f}')
        return 1
    print('OK 取り込み直しても、挿絵・コラム・背景は残っています')
    return 0


if __name__ == '__main__':
    sys.exit(main())
