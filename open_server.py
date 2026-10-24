#!/usr/bin/env python3
"""Tailscale 內網遊戲伺服器

在這台機器上執行：
    python3 open_server.py            在背景開啟伺服器（關掉終端機、登出後仍會繼續執行）
    python3 open_server.py status     查看伺服器狀態與網址
    python3 open_server.py stop       關閉伺服器
    python3 open_server.py restart    重新啟動
    python3 open_server.py run        在前景執行（Ctrl+C 結束），除錯用

需要先安裝並登入 Tailscale：伺服器會自動抓這台的 Tailscale IP（tailscale ip -4），只在這個位址上監聽，
所以只有同一個 Tailscale 內網的裝置連得到。
Tailscale 內網的裝置用瀏覽器打開 http://<這台的 Tailscale IP>:8686/ 就會看到遊戲大廳。
每個遊戲有自己的路徑：games/<名稱>.html 對應 http://<IP>:8686/<名稱>。
新增遊戲只要把 .html 放進 games/，不用重開伺服器。

這個程式不會設定開機自動啟動；重新開機後要再執行一次。
"""

import argparse
import errno
import gzip
import html
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

DEFAULT_PORT = 8686
SCRIPT_PATH = Path(__file__).resolve()
BASE_DIR = SCRIPT_PATH.parent
GAMES_DIR = BASE_DIR / "games"
PID_FILE = BASE_DIR / "server.pid"
LOG_FILE = BASE_DIR / "server.log"
LOG_MAX_BYTES = 1_000_000

# 已知遊戲的顯示資料；games/ 裡其他的 .html 會用網頁標題列在「其他」
CATALOG = {
    "banqi": {
        "name": "暗棋", "category": "棋類", "icon": "暗", "style": "piece dark",
        "desc": "翻開棋子、以大吃小，不允許連吃",
        "aliases": ["暗棋"],
    },
    "xiangqi": {
        "name": "中國象棋", "category": "棋類", "icon": "帥", "style": "piece",
        "desc": "標準規則，可悔棋、提示，也能兩人對下",
        "aliases": ["象棋"],
    },
    "mahjong": {
        "name": "台灣十六張麻將", "category": "牌類", "icon": "中", "style": "tile",
        "desc": "花牌、吃碰槓、台數計算，和三家電腦對打",
        "aliases": ["麻將", "majhong"],
    },
    "gongzhu": {
        "name": "拱豬", "category": "牌類", "icon": "♠Q", "style": "cardface",
        "desc": "四人撲克吃墩，避開豬（♠Q）、搶到羊（♦J）",
        "aliases": ["拱豬", "gongzhu_argon"],
    },
    "bigtwo": {
        "name": "大老二", "category": "牌類", "icon": "♠2", "style": "cardface",
        "desc": "四人撲克，♣3 開局，最先出完手牌的人獲勝",
        "aliases": ["大老二"],
    },
}
CATEGORY_ORDER = ["棋類", "牌類", "其他"]
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")

FONT_LINKS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;900'
    '&amp;family=Noto+Serif+TC:wght@700;900&amp;display=swap" rel="stylesheet">'
)

PAGE_CSS = """
* { box-sizing: border-box; }
html { background: #072b18; -webkit-text-size-adjust: 100%; }
body {
    margin: 0; min-height: 100vh; min-height: 100dvh; color: #ecfdf5;
    font-family: 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif;
    -webkit-tap-highlight-color: transparent;
}
/* 和遊戲一樣的綠色絨布牌桌背景 */
body::before {
    content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background: radial-gradient(circle at 50% 35%, #196c3e 0%, #0e4b28 60%, #072915 100%);
    box-shadow: inset 0 0 80px rgba(0, 0, 0, 0.75);
}
.wrap {
    max-width: 880px; margin: 0 auto;
    padding: max(28px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
             max(28px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
}
.top { display: flex; align-items: center; gap: 14px; }
.logo {
    flex: none; width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center;
    background: linear-gradient(135deg, #fbbf24, #d97706); color: #881337;
    font: 900 28px 'Noto Serif TC', serif; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
}
h1 { margin: 0; font-size: 26px; font-weight: 900; letter-spacing: 0.08em; color: #fcd34d; }
.sub { margin: 2px 0 0; font-size: 13px; color: #9fd3b4; }
h2 {
    display: flex; align-items: center; gap: 10px; margin: 30px 0 12px;
    font-size: 14px; font-weight: 700; letter-spacing: 0.2em; color: #9fd3b4;
}
h2::after { content: ""; flex: 1; height: 1px; background: rgba(251, 191, 36, 0.22); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.card {
    display: flex; align-items: center; gap: 16px; min-height: 92px; padding: 14px 16px;
    border-radius: 18px; border: 1px solid rgba(251, 191, 36, 0.22); background: rgba(0, 0, 0, 0.28);
    color: inherit; text-decoration: none;
    transition: transform 0.15s, background-color 0.15s, border-color 0.15s;
}
.card:hover { background: rgba(0, 0, 0, 0.4); border-color: rgba(251, 191, 36, 0.6); transform: translateY(-2px); }
.card:active { transform: scale(0.98); }
.card:focus-visible { outline: 2px solid #fbbf24; outline-offset: 3px; }
.icon {
    flex: none; position: relative; width: 56px; height: 56px; display: grid; place-items: center;
    font: 900 27px 'Noto Serif TC', serif;
}
/* 棋子：象牙色圓盤＋內圈；暗棋用深色棋背 */
.piece {
    border-radius: 50%; color: #b91c1c;
    background: radial-gradient(circle at 35% 30%, #fffaf0 0%, #f3dfb4 55%, #d6b075 100%);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.45), inset 0 -3px 0 rgba(0, 0, 0, 0.15);
}
.piece::before { content: ""; position: absolute; inset: 5px; border-radius: 50%; border: 2px solid currentColor; opacity: 0.5; }
.piece.dark { color: #fcd34d; background: radial-gradient(circle at 35% 30%, #8a5a2b 0%, #5c3417 60%, #3a1f0c 100%); }
/* 麻將牌：象牙牌面＋綠色牌背厚度 */
.tile {
    width: 44px; height: 58px; margin: 0 6px 6px; border-radius: 8px; color: #b91c1c;
    background: linear-gradient(180deg, #fffef8 0%, #f3ecd9 100%);
    box-shadow: 0 5px 0 #22885a, 0 8px 12px rgba(0, 0, 0, 0.45);
}
/* 撲克牌：白色牌面 */
.cardface {
    width: 42px; height: 58px; margin: 0 7px; border-radius: 7px; color: #111827;
    background: linear-gradient(180deg, #ffffff 0%, #eef2f7 100%);
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.25), 0 6px 12px rgba(0, 0, 0, 0.45);
    font: 900 19px 'Noto Serif TC', serif; letter-spacing: -1px;
}
.info { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.name { font-size: 18px; font-weight: 900; color: #fef3c7; }
.desc { font-size: 13px; line-height: 1.5; color: #a7d3b8; }
.path {
    align-self: flex-start; margin-top: 3px; padding: 1px 8px; border-radius: 6px;
    font: 600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #fcd34d; background: rgba(251, 191, 36, 0.12);
}
.empty { color: #a7d3b8; }
/* 中文在標點處換行，不把「不允許」這類詞拆開 */
.desc, footer { word-break: keep-all; overflow-wrap: anywhere; }
footer {
    margin-top: 36px; padding-top: 14px; border-top: 1px solid rgba(251, 191, 36, 0.22);
    font-size: 12.5px; line-height: 1.8; color: #8fbfa3;
}
.missing { text-align: center; padding-top: 18vh; }
.missing p { color: #a7d3b8; }
.back {
    display: inline-block; margin-top: 10px; padding: 10px 22px; border-radius: 12px;
    background: linear-gradient(135deg, #fbbf24, #d97706); color: #3b0a16; font-weight: 900; text-decoration: none;
}
@media (prefers-reduced-motion: reduce) { .card { transition: none; } }
"""

# 插在每個遊戲頁面最後：點左上角的遊戲圖示回到大廳（手機「加入主畫面」後沒有上一頁按鈕）
HOME_BUTTON = """<script>
/* 遊戲伺服器加入：點左上角的圖示回到遊戲大廳 */
(function () {
    var logo = document.querySelector('header > div:first-child > div:first-child');
    if (!logo || !(logo.classList.contains('rounded-xl') || logo.classList.contains('brand-mark'))) return;
    logo.title = '回遊戲大廳';
    logo.setAttribute('role', 'link');
    logo.setAttribute('aria-label', '回遊戲大廳');
    logo.tabIndex = 0;
    logo.style.position = 'relative';
    logo.style.cursor = 'pointer';
    var badge = document.createElement('span');
    badge.setAttribute('aria-hidden', 'true');
    badge.style.cssText = 'position:absolute;left:-5px;bottom:-5px;width:17px;height:17px;border-radius:50%;'
        + 'display:flex;align-items:center;justify-content:center;background:#0e4b28;border:1.5px solid #fbbf24;';
    badge.innerHTML = '<svg viewBox="0 0 16 16" width="9" height="9" fill="#fcd34d"><path d="M8 1.5 1 7.5h2.2V14h3.6v-4h2.4v4h3.6V7.5H15z"/></svg>';
    logo.appendChild(badge);
    function goHome() {
        if (confirm('回到遊戲大廳？目前這一局不會保存。')) location.href = '/';
    }
    logo.addEventListener('click', goHome);
    logo.addEventListener('keydown', function (e) { if (e.key === 'Enter') goHome(); });
})();
</script>
"""


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def tailscale_ip():
    """這台在 Tailscale 內網的 IPv4 位址；Tailscale 沒連線時回傳 None。"""
    try:
        result = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    addresses = result.stdout.split()
    return addresses[0] if result.returncode == 0 and addresses else None


def read_title(path):
    """讀出網頁的 <title>，例如「台灣麻將 Mahjong - 網頁十六張麻將遊戲」取「台灣麻將 Mahjong」。"""
    try:
        with path.open("rb") as f:
            head = f.read(65536).decode("utf-8", "replace")
    except OSError:
        return None
    match = re.search(r"<title[^>]*>(.*?)</title>", head, re.I | re.S)
    if not match:
        return None
    return html.unescape(match.group(1)).split(" - ")[0].strip() or None


def find_games():
    """games/ 裡的遊戲，依分類與 CATALOG 的順序排列。"""
    games = []
    for path in GAMES_DIR.glob("*.html"):
        slug = path.stem.lower()
        if not path.is_file() or not SLUG_RE.fullmatch(slug):
            continue
        info = CATALOG.get(slug)
        if info is None:
            name = read_title(path) or path.stem
            info = {"name": name, "category": "其他", "icon": name[:1], "style": "piece",
                    "desc": path.name, "aliases": []}
        games.append({"slug": slug, "path": path, **info})

    known = list(CATALOG)

    def order(game):
        category = game["category"]
        rank = CATEGORY_ORDER.index(category) if category in CATEGORY_ORDER else len(CATEGORY_ORDER)
        position = known.index(game["slug"]) if game["slug"] in known else len(known)
        return rank, category, position, game["slug"]

    return sorted(games, key=order)


def find_game(name):
    """網址路徑（去掉斜線）對應的遊戲，例如 "mahjong" 或 "麻將"。"""
    name = name.lower()
    for game in find_games():
        if name == game["slug"] or name in game["aliases"]:
            return game
    return None


def icon_uri(char):
    """瀏覽器分頁用的小圖示（金色方塊上的一個字）。"""
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
           "<rect width='64' height='64' rx='16' fill='#f59e0b'/>"
           "<text x='32' y='45' font-size='38' font-weight='900' text-anchor='middle' "
           f"font-family='serif' fill='#881337'>{html.escape(char)}</text></svg>")
    return "data:image/svg+xml," + quote(svg)


def page_shell(title, icon, body):
    return f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-title" content="遊戲大廳">
<meta name="theme-color" content="#072b18">
<title>{html.escape(title)}</title>
<link rel="icon" href="{icon_uri(icon)}">
{FONT_LINKS}
<style>{PAGE_CSS}</style>
</head>
<body>
<main class="wrap">
{body}
</main>
</body>
</html>"""


def game_card(game):
    return (f'<a class="card" href="/{game["slug"]}">'
            f'<span class="icon {game["style"]}">{html.escape(game["icon"])}</span>'
            f'<span class="info"><span class="name">{html.escape(game["name"])}</span>'
            f'<span class="desc">{html.escape(game["desc"])}</span>'
            f'<span class="path">/{game["slug"]}</span></span></a>')


def lobby_page(address):
    games = find_games()
    sections = []
    for category in dict.fromkeys(game["category"] for game in games):
        cards = "".join(game_card(game) for game in games if game["category"] == category)
        sections.append(f'<section><h2>{html.escape(category)}</h2><div class="grid">{cards}</div></section>')
    content = "".join(sections) or '<p class="empty">games/ 資料夾裡還沒有遊戲。</p>'
    body = f"""<header class="top">
  <div class="logo">遊</div>
  <div>
    <h1>遊戲大廳</h1>
    <p class="sub">Tailscale 內網 · {html.escape(address)}</p>
  </div>
</header>
{content}
<footer>
  iPhone／iPad：用 Safari 打開這頁，點「分享」→「加入主畫面」，就能像 App 一樣開啟。<br>
  進入遊戲後，點左上角的圖示可以回到大廳。
</footer>"""
    return page_shell("遊戲大廳", "遊", body)


def not_found_page():
    body = """<div class="missing">
  <h1>找不到這個遊戲</h1>
  <p>網址可能打錯了。</p>
  <a class="back" href="/">回遊戲大廳</a>
</div>"""
    return page_shell("找不到遊戲", "遊", body)


def insert_before(page, marker, extra, last):
    lower = page.lower()
    index = lower.rfind(marker) if last else lower.find(marker)
    return page if index < 0 else page[:index] + extra + page[index:]


def add_lobby_links(page, game):
    """在遊戲頁面加上主畫面名稱、分頁圖示和回大廳按鈕（不改動 games/ 裡的檔案）。"""
    head = (f'<meta name="apple-mobile-web-app-title" content="{html.escape(game["name"])}">'
            f'<link rel="icon" href="{icon_uri(game["icon"])}">')
    page = insert_before(page, b"</head>", head.encode(), last=False)
    return insert_before(page, b"</body>", HOME_BUTTON.encode(), last=True)


class GameHandler(BaseHTTPRequestHandler):
    server_version = "GameServer/1.0"
    timeout = 60

    def version_string(self):
        return self.server_version

    def do_GET(self):
        self.respond(send_body=True)

    def do_HEAD(self):
        self.respond(send_body=False)

    def respond(self, send_body):
        path = unquote(urlsplit(self.path).path)
        if path in ("/", "/index.html"):
            return self.send_page(HTTPStatus.OK, lobby_page(self.headers.get("Host", "")), send_body)
        if path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return
        game = find_game(path.strip("/"))
        if game is None:
            return self.send_page(HTTPStatus.NOT_FOUND, not_found_page(), send_body)
        try:
            page = game["path"].read_bytes()
        except OSError:
            return self.send_page(HTTPStatus.NOT_FOUND, not_found_page(), send_body)
        self.send_page(HTTPStatus.OK, add_lobby_links(page, game), send_body)

    def send_page(self, status, page, send_body):
        body = page.encode() if isinstance(page, str) else page
        compress = "gzip" in self.headers.get("Accept-Encoding", "")
        if compress:
            body = gzip.compress(body)
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if compress:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"[{now()}] {self.client_address[0]} {format % args}", flush=True)


class GameServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_port = False  # 同一個 port 不能被第二個伺服器搶走

    def handle_error(self, request, client_address):
        # 手機切換 App 或關掉分頁時常會中斷連線，不必印出錯誤
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def is_server(pid):
    try:
        return SCRIPT_PATH.name.encode() in Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False


def read_pid_file():
    """執行中的伺服器 (pid, host, port)；沒在執行時回傳 None。"""
    try:
        pid, host, port = PID_FILE.read_text().split()
        pid, port = int(pid), int(port)
    except (OSError, ValueError):
        return None
    return (pid, host, port) if is_server(pid) else None


def print_urls(host, port):
    base = f"http://{host}:{port}"
    print(f"遊戲大廳：{base}/", flush=True)
    for game in find_games():
        print(f"  {base}/{game['slug']:<12}{game['name']}", flush=True)


def rotate_log():
    try:
        if LOG_FILE.stat().st_size > LOG_MAX_BYTES:
            LOG_FILE.replace(BASE_DIR / "server.log.1")
    except FileNotFoundError:
        pass


def log_tail(lines=10):
    try:
        return "\n".join(LOG_FILE.read_text(errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


def run(host, port):
    """在前景執行伺服器，直到 Ctrl+C 或收到 SIGTERM。"""
    GAMES_DIR.mkdir(exist_ok=True)
    deadline = time.monotonic() + 60
    while True:
        try:
            server = GameServer((host, port), GameHandler)
            break
        except OSError as e:
            if e.errno == errno.EADDRNOTAVAIL and time.monotonic() < deadline:
                time.sleep(2)  # 剛開機時 Tailscale 可能還沒拿到 IP，等一下再試
                continue
            if e.errno == errno.EADDRINUSE:
                print(f"port {port} 已被占用。伺服器可能已經在執行，用 `python3 {SCRIPT_PATH.name} status` 查看。", flush=True)
            elif e.errno == errno.EADDRNOTAVAIL:
                print(f"這台沒有 {host} 這個位址，請確認 Tailscale 已連線（tailscale status）。", flush=True)
            else:
                print(f"無法開啟伺服器：{e}", flush=True)
            return 1

    PID_FILE.write_text(f"{os.getpid()} {host} {port}\n")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(f"[{now()}] 遊戲伺服器已啟動", flush=True)
    print_urls(host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            if PID_FILE.read_text().split()[:1] == [str(os.getpid())]:
                PID_FILE.unlink()
        except OSError:
            pass
        print(f"[{now()}] 遊戲伺服器已關閉", flush=True)
    return 0


def start(host, port):
    """在背景開啟伺服器（新的 session，關掉終端機也不會停）。"""
    running = read_pid_file()
    if running:
        print(f"遊戲伺服器已經在執行（PID {running[0]}）。")
        print_urls(running[1], running[2])
        return 0

    rotate_log()
    with LOG_FILE.open("ab") as log:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(SCRIPT_PATH), "run", "--host", host, "--port", str(port)],
            cwd=BASE_DIR, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            print("遊戲伺服器啟動失敗：")
            print(log_tail())
            return 1
        running = read_pid_file()
        if running and running[0] == proc.pid:
            print(f"遊戲伺服器已在背景啟動（PID {proc.pid}），紀錄檔：{LOG_FILE}")
            print_urls(host, port)
            return 0
        time.sleep(0.2)
    print(f"遊戲伺服器正在等待 Tailscale 連線（PID {proc.pid}），稍後用 `python3 {SCRIPT_PATH.name} status` 查看。")
    return 0


def stop():
    running = read_pid_file()
    if not running:
        PID_FILE.unlink(missing_ok=True)
        print("遊戲伺服器沒有在執行。")
        return 0
    pid = running[0]
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while is_server(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    if is_server(pid):
        os.kill(pid, signal.SIGKILL)
    PID_FILE.unlink(missing_ok=True)
    print("遊戲伺服器已關閉。")
    return 0


def status():
    running = read_pid_file()
    if not running:
        print(f"遊戲伺服器沒有在執行。開啟：python3 {SCRIPT_PATH.name}")
        return 1
    print(f"遊戲伺服器執行中（PID {running[0]}）")
    print_urls(running[1], running[2])
    return 0


def main():
    parser = argparse.ArgumentParser(description="Tailscale 內網遊戲伺服器")
    parser.add_argument("command", nargs="?", default="start",
                        choices=["start", "stop", "status", "restart", "run"],
                        help="start（預設，背景執行）、stop、status、restart、run（前景執行）")
    parser.add_argument("--port", type=int, help=f"port（預設 {DEFAULT_PORT}）")
    parser.add_argument("--host", help="監聽的位址（預設：自動抓這台的 Tailscale IP，只有 Tailscale 內網連得到）")
    args = parser.parse_args()

    if args.command == "status":
        return status()
    if args.command == "stop":
        return stop()

    # 先抓到要監聽的位址再動作：抓不到時 restart 也不會先把正在執行的伺服器關掉
    host = args.host or tailscale_ip()
    if not host:
        print("抓不到這台的 Tailscale IP。請先安裝並登入 Tailscale（tailscale up），"
              "用 `tailscale ip -4` 確認有 100.x.x.x 的位址；或用 --host 指定要監聽的位址。")
        return 1
    previous = read_pid_file()
    if args.command == "restart":
        stop()
    port = args.port or (previous[2] if previous else DEFAULT_PORT)
    if args.command == "run":
        return run(host, port)
    return start(host, port)


if __name__ == "__main__":
    sys.exit(main())
