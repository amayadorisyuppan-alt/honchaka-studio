# -*- coding: utf-8 -*-
"""紙の表紙を、300dpi の座標のまま k 倍の画素で書き出す(出し先の目安が 350ppi のとき)のを、実際に描いて測る(2026-10-03)。

測ること・理由は scripts/scale-probe.ts の冒頭を参照。

**開発サーバーは立てない。** probe を vite でビルドして(静的なファイル)、小さな HTTP サーバーで配り、
headless Chrome で開く。結果は同じサーバーへ POST で返る(scripts/probe-report.ts)。

    python scripts/check-cover-scale.py
    python scripts/check-cover-scale.py --chrome "C:\\path\\to\\chrome.exe"

終了コードは 0=通った / 1=落ちた。
"""

from __future__ import annotations

import argparse
import functools
import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location('check_spine', ROOT / 'scripts' / 'check-spine.py')
_cs = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(_cs)

TIMEOUT_S = 120


class _Handler(http.server.SimpleHTTPRequestHandler):
    received: list[str] = []

    def do_POST(self):  # noqa: N802 (http.server の決まった名前)
        n = int(self.headers.get('Content-Length') or 0)
        _Handler.received.append(self.rfile.read(n).decode('utf-8', 'replace'))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_a):
        pass


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser(description='表紙の書き出しの倍率を測る')
    ap.add_argument('--chrome')
    a = ap.parse_args()
    chrome = _cs.find_chrome(a.chrome)
    if not chrome:
        print('Chrome が見つかりません。--chrome で渡してください', file=sys.stderr)
        return 1
    work = Path(tempfile.mkdtemp(prefix='cover-scale-'))
    out = work / 'site'
    httpd = None
    try:
        p = subprocess.run(
            ['npx', 'vite', 'build', '--config', 'scripts/scale-probe.vite.config.ts',
             '--outDir', str(out), '--emptyOutDir', '--logLevel', 'error'],
            cwd=str(ROOT), shell=(os.name == 'nt'))
        if p.returncode != 0:
            print('probe の組み上げに失敗しました')
            return 1
        page = out / 'scripts' / 'scale-probe.html'
        if not page.exists():
            print(f'組み上げた {page} が見つかりません')
            return 1
        _Handler.received.clear()
        handler = functools.partial(_Handler, directory=str(out))
        httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        report = f'http://127.0.0.1:{port}/result'
        url = f'http://127.0.0.1:{port}/scripts/scale-probe.html?report={urllib.parse.quote(report)}'
        proc = subprocess.Popen(
            [chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
             '--disable-extensions', f'--user-data-dir={work / "chrome-profile"}', url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.time() + TIMEOUT_S
        while not _Handler.received and time.time() < end:
            time.sleep(0.3)
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        if not _Handler.received:
            print(f'{TIMEOUT_S}秒たっても結果が返りませんでした')
            return 1
        res = json.loads(_Handler.received[-1])
        for r in res.get('rows', []):
            print('  ' + json.dumps(r, ensure_ascii=False))
        if res.get('fails'):
            print('\n落ちた検査:')
            for f in res['fails']:
                print('  NG ' + f)
            return 1
        print('\n通りました')
        return 0
    finally:
        if httpd:
            httpd.shutdown()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
