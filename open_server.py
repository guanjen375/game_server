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

每一局打完（或打到一半離開）會自動記錄下來，存在 gaming_data/<遊戲>/<年-月>/ 底下，一局一個 JSON 檔；
--data-dir 可以改存放位置。

train_out/<遊戲>/model.pt（train_gpu.py 練出來的模型）放著就能用：那個遊戲裡「電腦的打法」多了模型可以選
（正常、較弱兩種），選了之後電腦每一手都照模型出牌。模型檔換了不用重開伺服器；--model-dir 可以改放模型的資料夾。
用 status 可以看現在哪些遊戲有模型可以選。

這個程式不會設定開機自動啟動；重新開機後要再執行一次。
"""

import argparse
import errno
import gzip
import hashlib
import html
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

try:
    import model_bot
except Exception as error:      # 訓練程式出問題時伺服器照常開，只是遊戲裡沒有模型可以選
    model_bot = None
    print(f"照模型出牌的功能沒有開（{type(error).__name__}：{error}）", flush=True)

DEFAULT_PORT = 8686
SCRIPT_PATH = Path(__file__).resolve()
BASE_DIR = SCRIPT_PATH.parent
GAMES_DIR = BASE_DIR / "games"
PID_FILE = BASE_DIR / "server.pid"
LOG_FILE = BASE_DIR / "server.log"
LOG_MAX_BYTES = 1_000_000

# 對局紀錄：預設存在專案裡的 gaming_data/（不進 git），--data-dir 可以改
DATA_DIR = BASE_DIR / "gaming_data"
RECORD_MAX_BYTES = 2_000_000    # 一局紀錄的大小上限（實際上一局只有幾 KB 到幾十 KB）
RECORD_ID_RE = re.compile(r"\d{8}-\d{6}-[a-z0-9]{6}")    # 開局時間＋亂碼，例如 20261120-164512-k3f9x2
RECORD_LOCK = threading.Lock()

# 沒有模型可以選時 GET /api/bot/<遊戲> 的回答（格式見 model_bot.Bots.info）
NO_MODEL = {"model": None, "why": None, "models": [], "strength": {}, "choices": []}

# 已知遊戲的顯示資料；games/ 裡其他的 .html 會用網頁標題列在「其他」
CATALOG = {
    "banqi": {
        "name": "暗棋", "category": "棋類", "icon": "暗", "seats": 2,
        "desc": "翻出暗藏的棋子，以大吃小、隔子跳吃。",
        "aliases": ["暗棋"],
    },
    "xiangqi": {
        "name": "中國象棋", "category": "棋類", "icon": "帥", "seats": 2,
        "desc": "隔河對弈，調兵遣將，步步逼近敵帥。",
        "aliases": ["象棋"],
    },
    "reversi": {
        "name": "黑白棋", "category": "棋類", "icon": "黑", "seats": 2,
        "desc": "夾住對手的棋子翻面，搶下四角與多數。",
        "aliases": ["黑白棋"],
    },
    "mahjong": {
        "name": "台灣十六張麻將", "category": "麻將", "icon": "中", "seats": 4,
        "desc": "十六張起手，吃碰槓胡，依台數計分。",
        "aliases": ["麻將", "majhong"],
    },
    "mahjong-me": {
        "name": "台灣麻將（自我模式）", "category": "麻將", "icon": "發", "seats": 4,
        "desc": "三家電腦只胡您打出的牌，也不會自摸。",
        "aliases": [],
    },
    "gongzhu": {
        "name": "拱豬", "category": "撲克", "icon": "♠Q", "seats": 4,
        "desc": "跟花吃墩，避開黑桃 Q，搶下方塊 J。",
        "aliases": ["拱豬", "gongzhu_argon"],
    },
    "bigtwo": {
        "name": "大老二", "category": "撲克", "icon": "♠2", "seats": 4,
        "desc": "梅花 3 開局，比牌型、拚點數，搶先出完手牌。",
        "aliases": ["大老二"],
    },
}
CATEGORY_ORDER = ["棋類", "麻將", "撲克", "其他"]
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")

ASSETS_DIR = GAMES_DIR / "assets"
ASSET_TYPES = {".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"}

# 插在每個遊戲頁面最後：點左上角的遊戲圖示回到大廳（手機「加入主畫面」後沒有上一頁按鈕）
HOME_BUTTON = """<script>
(() => {
    const mark = document.querySelector('[data-game-mark], header > div:first-child > .rounded-xl, header .brand-mark');
    if (!mark) return;
    const link = document.createElement('a');
    link.className = 'table-home';
    link.href = '/';
    link.title = '回遊戲大廳';
    link.setAttribute('aria-label', link.title);
    mark.replaceWith(link);
    link.append(mark);
    link.addEventListener('click', event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!confirm('離開牌桌，回到遊戲大廳？')) event.preventDefault();
    });
})();
</script>
"""

# 插在每個遊戲頁面的 <head>：自動記錄對局（__GAME__、__BUILD__ 由 add_lobby_links 填入）。
# 遊戲在每一局開始時呼叫 GameRecorder.begin(fn)，一局結束、或還沒打完就要換掉這一局之前呼叫 GameRecorder.end()；
# fn() 回傳這一局目前的紀錄。這裡負責編號和送到伺服器，送不出去的先留在瀏覽器，連得上時再送
RECORDER = """<script>
/* 遊戲伺服器加入：自動記錄對局 */
window.GameRecorder = (function () {
    var API = '/api/records/', GAME = '__GAME__', BUILD = '__BUILD__';
    var PREFIX = 'game_record:';    // 還沒送到伺服器的紀錄放在 localStorage 的 game_record:<遊戲>:<編號>
    var RETRY_MS = 60000;
    var session = token(8), current = null, memory = {}, failed = {}, beaconed = {}, busy = false, timer = null;

    function token(length) {
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789', text = '';
        for (var i = 0; i < length; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
        return text;
    }

    // 玩家裝置上的時間，例如 2026-11-20T16:45:12+08:00
    function clock() {
        var d = new Date(), offset = -d.getTimezoneOffset(), minutes = Math.abs(offset);
        function pad(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
            + (offset < 0 ? '-' : '+') + pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
    }

    // 瀏覽器不給用 localStorage（無痕模式、空間滿了）時改放在記憶體，這個頁面開著的期間照樣會送
    function read(key) {
        if (key in memory) return memory[key];
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function keep(key, text) {
        try { localStorage.setItem(key, text); delete memory[key]; } catch (e) { memory[key] = text; }
    }
    function drop(key) {
        delete memory[key];
        delete beaconed[key];
        try { localStorage.removeItem(key); } catch (e) {}
    }

    // 還沒送到伺服器的紀錄（包含之前開頁面時留下的），舊的排前面
    function waiting() {
        var keys = Object.keys(memory);
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var key = localStorage.key(i);
                if (key && key.indexOf(PREFIX) === 0 && keys.indexOf(key) < 0) keys.push(key);
            }
        } catch (e) {}
        return keys.sort(function (a, b) {
            a = a.slice(a.lastIndexOf(':'));
            b = b.slice(b.lastIndexOf(':'));
            return a < b ? -1 : a > b ? 1 : 0;
        });
    }

    // 之前沒送成功的全部再試一次
    function retry() {
        failed = {};
        send();
    }

    // 一次送一筆。伺服器收下了，或明講這一筆永遠不收（格式不對、沒有這個遊戲、太大），就從瀏覽器刪掉；
    // 其他情況（連不上、伺服器出錯）先跳過，一分鐘後（或網路恢復、回到這個頁面時）再試
    function send() {
        if (busy) return;
        var key = waiting().filter(function (k) { return !failed[k]; })[0];
        if (!key) return;
        var body = read(key), game = key.split(':')[1];
        if (!body || !game) { drop(key); send(); return; }
        busy = true;
        function done(received) {
            busy = false;
            if (!received) {
                failed[key] = true;
                if (!timer) timer = setTimeout(function () { timer = null; retry(); }, RETRY_MS);
            } else if (read(key) === body) {
                drop(key);      // 送的途中這一局又有新的進度時先不刪，下一輪送新的
            }
            send();
        }
        try {
            fetch(API + game, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
                .then(function (response) {
                    done(response.ok || response.status === 400 || response.status === 404 || response.status === 413);
                }, function () { done(false); });
        } catch (e) {
            done(false);
        }
    }

    // 把這一局目前的樣子存下來準備送出；內容和上次一樣就不用再送
    function save() {
        if (!current) return;
        var record = current.snapshot();
        if (!record) return;
        var text = JSON.stringify(record);
        if (text === current.saved) return;
        current.saved = text;
        var out = {
            id: current.id, seq: ++current.seq, session: session, build: BUILD,
            status: record.finished ? 'finished' : 'unfinished', started: current.started, ended: clock()
        };
        for (var name in record) {
            if (name !== 'finished' && !(name in out)) out[name] = record[name];
        }
        var key = PREFIX + GAME + ':' + current.id;
        keep(key, JSON.stringify(out));
        delete failed[key];
    }

    // 離開頁面（關掉、切到別的 App、回大廳）：先存下打到一半的這一局，再用 sendBeacon 送，頁面關掉了也送得出去。
    // sendBeacon 不知道伺服器有沒有收到，所以紀錄先留在瀏覽器，下次開頁面時 send() 確認過才刪
    function leave() {
        save();
        var queued = !!navigator.sendBeacon;
        if (queued) {
            waiting().slice(-5).forEach(function (key) {
                var body = read(key);
                if (!body || beaconed[key] === body) return;
                if (navigator.sendBeacon(API + key.split(':')[1], body)) beaconed[key] = body;
                else queued = false;    // 太大或瀏覽器排不進去
            });
        }
        if (!queued) send();
    }

    // 記錄出錯不可以影響遊戲
    function quiet(fn) {
        return function (arg) {
            try { fn(arg); } catch (e) { if (window.console) console.error('GameRecorder', e); }
        };
    }

    document.addEventListener('visibilitychange', quiet(function () {
        if (document.visibilityState === 'hidden') leave(); else retry();
    }));
    window.addEventListener('pagehide', quiet(leave));
    window.addEventListener('online', quiet(retry));
    quiet(send)();

    return {
        // 新的一局開始。snapshot() 回傳這一局目前的紀錄；還沒有值得記的內容時回傳 null
        begin: quiet(function (snapshot) {
            var started = clock();
            current = {
                id: started.slice(0, 19).replace(/[-:]/g, '').replace('T', '-') + '-' + token(6),
                started: started, seq: 0, saved: '', snapshot: snapshot
            };
        }),
        // 這一局結束，或還沒打完就要換掉：記下最後的樣子，之後不再更新這一局
        end: quiet(function () {
            try { save(); } finally { current = null; }
            send();
        })
    };
})();
</script>
"""

# 插在每個遊戲頁面的 <head>：讓電腦照訓練好的模型出牌（__GAME__ 由 add_lobby_links 填入）。
# 玩家在遊戲裡選了模型的話，遊戲輪到電腦時呼叫 GameBot.choose(這一局到目前為止的紀錄, 輪到的座位, 打法)，
# 拿到的是模型選的那一手；伺服器上沒有模型、連不上、太久沒回答時拿到 null，遊戲就用自己原本的電腦。
# 遊戲頁面不用它也沒關係
BOT = """<script>
/* 遊戲伺服器加入：電腦照訓練好的模型出牌 */
window.GameBot = (function () {
    var API = '/api/bot/__GAME__';
    var WAIT_MS = 2500;     // 等伺服器回答最久多久，超過就當作連不上
    var REST_MS = 30000;    // 連不上之後隔多久才再問；這段時間電腦用遊戲自己的打法，不會每一手都卡住
    var model = null, models = [], strength = {}, choices = [], why = null, restUntil = 0, watchers = [];

    function changed() {
        watchers.forEach(function (fn) {
            try { fn(); } catch (e) { if (window.console) console.error('GameBot', e); }
        });
    }
    function learn(next, reason, all, rated, listed) {
        var before = JSON.stringify([model, why, models, strength, choices]);
        model = next || null;
        why = reason || null;
        models = model ? (Array.isArray(all) && all.length ? all : [model]) : [];
        strength = model && rated && typeof rated === 'object' ? rated : {};
        choices = model && Array.isArray(listed) ? listed : [];
        if (JSON.stringify([model, why, models, strength, choices]) !== before) changed();
    }
    function rest() {
        restUntil = Date.now() + REST_MS;
        setTimeout(changed, REST_MS + 50);
        changed();
    }

    // 問伺服器一次。回傳 Promise：{ status, body }；連不上、太久沒回答、回的不是 JSON 都是 null
    function ask(options) {
        return new Promise(function (resolve) {
            var settled = false, abort = window.AbortController ? new AbortController() : null;
            function settle(value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }
            var timer = setTimeout(function () {
                settle(null);
                if (abort) abort.abort();
            }, WAIT_MS);
            if (abort) options.signal = abort.signal;
            try {
                fetch(API, options).then(function (response) {
                    return response.json().then(function (body) { settle({ status: response.status, body: body }); });
                }).catch(function () { settle(null); });
            } catch (e) {
                settle(null);
            }
        });
    }

    var api = {
        // 伺服器上這個遊戲的模型（沒指定模型時用的那一個）：{ name, id, saved, rounds, decisions, accuracy, chance,
        // finished }；沒有可以用的是 null
        model: function () { return model; },
        // 伺服器上這個遊戲的每個模型，格式同 model()，name 是模型的名稱（例如 '20261123_b'，沒有名稱的是 ''）
        models: function () { return models; },
        // 「電腦的打法」每個選項量出來的強度 { 'builtin': 56, 'normal:20261123_b': 100, ... }，最強的是 100；沒量過是 {}
        strength: function () { return strength; },
        // 伺服器設定好的「電腦的打法」選單 [{ label: 選單上的字, play: 'builtin' 或 '<打法>:<模型名稱>' }]；沒設定是 []
        choices: function () { return choices; },
        // 有模型檔卻不能用的原因；沒有這種情況是 null
        why: function () { return why; },
        // 剛剛連不上伺服器，暫時不問
        resting: function () { return Date.now() < restUntil; },
        // 模型換了、沒了，或連不上、恢復的時候呼叫 fn()
        watch: function (fn) { watchers.push(fn); },
        // 問伺服器現在有沒有模型。遊戲每一局開始時要問一次（沒問過就當作沒有模型）；模型換了不用重新整理頁面
        refresh: function () {
            return ask({ method: 'GET' }).then(function (answer) {
                if (answer && answer.body) {
                    var ok = answer.status === 200;
                    learn(ok && answer.body.model, answer.body.why, ok && answer.body.models, ok && answer.body.strength,
                        ok && answer.body.choices);
                }
            });
        },
        // 這一手模型出什麼。record：這一局到目前為止的紀錄；seat：輪到的那一家；mode：'normal'（正常）或 'weak'（較弱）；
        // name：問哪一個模型（models() 裡的 name，不給就是 model() 那一個）。
        // 回傳 Promise：{ play: 寫進紀錄的那一筆, mode, model: 模型的編號 }；沒有模型、連不上、伺服器不收時是 null
        choose: function (record, seat, mode, name) {
            if (!model || api.resting()) return Promise.resolve(null);
            var asked = typeof name === 'string' ? models.filter(function (m) { return m.name === name; })[0] : model;
            var body;
            try {
                body = JSON.stringify(typeof name === 'string'
                    ? { record: record, seat: seat, mode: mode, model: name } : { record: record, seat: seat, mode: mode });
            } catch (e) {
                return Promise.resolve(null);
            }
            var options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body };
            return ask(options).then(function (answer) {
                if (!answer || answer.status >= 500) { rest(); return null; }
                if (answer.status === 404) { learn(null, null); return null; }      // 模型被拿掉了
                if (answer.status !== 200 || !answer.body || !answer.body.play) return null;
                if (!asked || answer.body.model !== asked.id) api.refresh();         // 模型換了一個：更新說明
                return answer.body;
            });
        }
    };
    return api;
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
            info = {"name": name, "category": "其他", "icon": name[:1],
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
    """瀏覽器分頁用的小圖示（桌遊室印記）。"""
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
           "<rect width='64' height='64' rx='16' fill='#254c3d'/>"
           "<text x='32' y='45' font-size='38' font-weight='900' text-anchor='middle' "
           f"font-family='serif' fill='#fff6dc'>{html.escape(char)}</text></svg>")
    return "data:image/svg+xml," + quote(svg)


def page_shell(title, body):
    return f"""<!DOCTYPE html>
<html lang="zh-Hant" class="lobby">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-title" content="棋聚桌遊室">
<meta name="theme-color" content="#f8f7f2">
<title>{html.escape(title)} · 棋聚桌遊室</title>
<link rel="icon" href="{icon_uri("棋")}">
<link rel="stylesheet" href="/assets/palette.css">
<link rel="stylesheet" href="/assets/lobby.css">
<script src="/assets/interface.js"></script>
</head>
<body>
<a class="skip-link" href="#main">跳至主要內容</a>
<header class="masthead"><div class="shell mast-inner">
  <a class="wordmark" href="/"><span class="club-mark" aria-hidden="true">⚄</span>棋聚桌遊室</a>
  <nav aria-label="主選單"><a class="nav-link" href="/#library">遊戲大廳</a></nav>
  <label class="appearance" data-theme-picker hidden>
    <i class="ui-icon i-palette" aria-hidden="true"></i>
    <select aria-label="大廳主題"></select><i class="ui-icon i-chevron-down" aria-hidden="true"></i>
  </label>
</div></header>
{body}
</body></html>"""


def game_card(game, modelled=False):
    slug, category = game["slug"], html.escape(game["category"], quote=True)
    name = html.escape(game["name"])
    if (ASSETS_DIR / f"{slug}.webp").is_file():
        cover = f'<img src="/assets/{slug}.webp" alt="" width="680" height="383" loading="lazy" decoding="async">'
    else:
        cover = f'<span class="cover-letter" aria-hidden="true">{html.escape(game["icon"])}</span>'
    players = (f'<span class="players"><i class="ui-icon i-people" aria-hidden="true"></i>{game["seats"]} 人</span>'
               if game.get("seats") else "")
    model = '<span class="model">可以和模型對打</span>' if modelled else ""
    return f"""<a class="game-card" data-category="{category}" href="/{slug}">
  <div class="cover">{cover}{model}</div>
  <div class="card-body">
    <div class="card-meta"><span>{category}</span>{players}</div>
    <h2>{name}</h2><p>{html.escape(game["desc"])}</p>
    <span class="card-arrow" aria-hidden="true"><i class="ui-icon i-arrow-up-right"></i></span>
  </div>
</a>"""


def lobby_page(address, bots=None):
    games = find_games()
    categories = list(dict.fromkeys(game["category"] for game in games))
    filters = "".join(
        f'<button type="button" data-filter="{html.escape(category)}" aria-pressed="false">{html.escape(category)}</button>'
        for category in categories
    )
    cards = "".join(game_card(game, bool(bots and bots.info(game["slug"])["model"])) for game in games)
    filter_bar = f"""<div class="filters" role="group" aria-label="依遊戲類型篩選" hidden>
      <button type="button" data-filter="" aria-pressed="true"><i class="ui-icon i-grid" aria-hidden="true"></i>全部</button>{filters}
    </div>""" if len(categories) > 1 else ""
    content = f'<div class="library-grid">{cards}</div>' if cards else '<p class="empty">目前沒有遊戲。將遊戲 HTML 放入 games 資料夾後，就會出現在這裡。</p>'
    body = f"""<main class="shell lobby-main" id="main">
<section class="library" id="library" aria-labelledby="library-title">
  <div class="library-head">
    <div class="library-title"><h1 id="library-title">遊戲收藏</h1><span id="game-count" aria-live="polite">{len(games)} 款遊戲</span></div>
    {filter_bar}
  </div>
  {content}
</section>
</main>
<footer class="shell lobby-footer">
  <p><i class="ui-icon i-hdd-network" aria-hidden="true"></i>Tailscale 內網<span class="address">{html.escape(address)}</span></p>
  <details><summary>加入主畫面<i class="ui-icon i-chevron-down" aria-hidden="true"></i></summary>
    <p>在 iPhone 或 iPad 上用 Safari 打開大廳，從分享選單選擇「加入主畫面」。</p></details>
</footer>"""
    return page_shell("遊戲大廳", body)


def not_found_page():
    return page_shell("找不到遊戲", """<main class="shell missing" id="main">
  <p>404</p><h1>找不到這個遊戲</h1>
  <a class="play" href="/">回遊戲大廳<i class="ui-icon i-arrow-right" aria-hidden="true"></i></a>
</main>""")


def insert_before(page, marker, extra, last):
    lower = page.lower()
    index = lower.rfind(marker) if last else lower.find(marker)
    return page if index < 0 else page[:index] + extra + page[index:]


def page_version(page):
    """遊戲檔的版本編號，記在每一局的紀錄裡（build），之後分得出這一局是哪一版的規則和電腦打的。

    用的是 git 的 blob 編號：`git log --all --find-object=<編號>` 可以查到是哪一次 commit 的檔案。
    """
    return hashlib.sha1(b"blob %d\0" % len(page) + page).hexdigest()


def add_lobby_links(page, game):
    """組裝伺服器提供的外觀與功能。對局版本始終取自原始遊戲 HTML。"""
    recorder = RECORDER.replace("__GAME__", game["slug"]).replace("__BUILD__", page_version(page))
    head = (f'<meta name="apple-mobile-web-app-title" content="{html.escape(game["name"])}">'
            f'<link rel="icon" href="{icon_uri(game["icon"])}">{recorder}{BOT.replace("__GAME__", game["slug"])}')
    if game["slug"] in CATALOG:
        # 原始檔與 assets 同層；伺服器上的別名與帶尾斜線的網址一律從 /assets 載入。
        page = page.replace(b'href="assets/', b'href="/assets/').replace(b'src="assets/', b'src="/assets/')
    page = insert_before(page, b"</head>", head.encode(), last=False)
    return insert_before(page, b"</body>", HOME_BUTTON.encode(), last=True)


def dump_record(record):
    """紀錄寫成 JSON：一個欄位一行；欄位內容是一串動作（或四家的手牌）時一筆一行，直接打開就看得懂。"""
    def compact(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    lines = []
    for key, value in record.items():
        if isinstance(value, list) and value and all(isinstance(item, (dict, list)) for item in value):
            text = "[\n" + ",\n".join("  " + compact(item) for item in value) + "\n ]"
        else:
            text = compact(value)
        lines.append(f" {compact(key)}: {text}")
    return "{\n" + ",\n".join(lines) + "\n}\n"


def reject_constant(name):
    """紀錄裡不收 NaN、Infinity（不是標準 JSON，存下來別的程式讀不了）。"""
    raise ValueError(name)


def store_record(data_dir, game, record, address, agent):
    """把遊戲頁面送來的一局存成 <data_dir>/<遊戲>/<年-月>/<編號>.json。

    同一局可能送來不只一次（打到一半離開頁面時先存一次進度，回來打完再存一次），只留 seq 最大的那一份。
    回傳這次有沒有寫入；內容不合格式時丟出 ValueError。
    """
    if not isinstance(record, dict):
        raise ValueError("not an object")
    record_id, seq = record.get("id"), record.get("seq")
    if not isinstance(record_id, str) or not RECORD_ID_RE.fullmatch(record_id):
        raise ValueError("id")
    datetime.strptime(record_id[:15], "%Y%m%d-%H%M%S")    # 編號開頭要是真的日期時間（也決定存進哪個月的資料夾）
    if type(seq) is not int or seq < 0:
        raise ValueError("seq")

    # 這幾欄由伺服器決定，排在最前面；其餘照遊戲頁面送來的內容
    saved = {
        "game": game, "id": record_id,
        "status": "finished" if record.get("status") == "finished" else "unfinished",
        "started": record.get("started"), "ended": record.get("ended"),
        "saved": datetime.now().astimezone().isoformat(timespec="seconds"),
        "ip": address, "ua": agent,
    }
    saved.update((key, value) for key, value in record.items() if key not in saved)

    path = data_dir / game / f"{record_id[:4]}-{record_id[4:6]}" / f"{record_id}.json"
    with RECORD_LOCK:
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(previous, dict) and type(previous.get("seq")) is int and previous["seq"] >= seq:
                return False
        except (OSError, ValueError):
            pass    # 還沒存過這一局（或舊檔讀不出來）：直接寫
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(dump_record(saved), encoding="utf-8")
        os.replace(temporary, path)    # 寫完整份才換上去，不會留下寫到一半的檔案
    return True


class GameHandler(BaseHTTPRequestHandler):
    server_version = "GameServer/1.0"
    timeout = 60

    def version_string(self):
        return self.server_version

    def do_GET(self):
        self.respond(send_body=True)

    def do_HEAD(self):
        self.respond(send_body=False)

    def do_POST(self):
        path = unquote(urlsplit(self.path).path)
        if path.startswith("/api/records/"):
            return self.receive_record(path[len("/api/records/"):])
        if path.startswith("/api/bot/"):
            return self.bot_play(path[len("/api/bot/"):])
        self.send_text(HTTPStatus.NOT_FOUND, "not found")

    def read_body(self):
        """遊戲頁面 POST 過來的內容。不收的（沒寫長度、太大、別的網站的網頁送來的）回應原因後回傳 None。"""
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.send_text(HTTPStatus.LENGTH_REQUIRED, "Content-Length required")
        if length > 10 * RECORD_MAX_BYTES:    # 大得離譜的不收，直接斷線
            self.close_connection = True
            return self.send_text(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "record too large")
        body = self.rfile.read(max(length, 0))    # 先把內容收完再回應，對方才收得到被拒絕的原因
        if length > RECORD_MAX_BYTES:
            return self.send_text(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "record too large")
        # 只收遊戲頁面自己送來的：別的網站的網頁不能叫瀏覽器往這裡寫資料
        origin = self.headers.get("Origin")
        if origin is not None and urlsplit(origin).netloc != self.headers.get("Host"):
            return self.send_text(HTTPStatus.FORBIDDEN, "cross-site request")
        return body

    def receive_record(self, name):
        """遊戲頁面送來的一局紀錄（POST /api/records/<遊戲>）：存進對局紀錄資料夾。"""
        body = self.read_body()
        if body is None:
            return
        game = find_game(name)
        if game is None:
            return self.send_text(HTTPStatus.NOT_FOUND, "unknown game")
        try:
            record = json.loads(body, parse_constant=reject_constant)
            written = store_record(self.server.data_dir, game["slug"], record,
                                   self.client_address[0], self.headers.get("User-Agent", ""))
        except (ValueError, RecursionError) as e:
            return self.send_text(HTTPStatus.BAD_REQUEST, f"bad record: {e}")
        except OSError as e:
            print(f"[{now()}] 對局紀錄寫入失敗：{e}", flush=True)
            return self.send_text(HTTPStatus.INTERNAL_SERVER_ERROR, "cannot save the record")
        self.send_text(HTTPStatus.OK, "saved" if written else "already saved")

    def bot_info(self, name, send_body=True):
        """這個遊戲現在有沒有模型可以用（GET /api/bot/<遊戲>）：{"model": 沒指定時用的模型的說明或 null,
        "why": 不能用的原因, "models": 每個能用的模型的說明}（見 model_bot.Bots.info）。"""
        game = find_game(name)
        if game is None:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "unknown game"}, send_body)
        bots = self.server.bots
        self.send_json(HTTPStatus.OK, bots.info(game["slug"]) if bots else NO_MODEL, send_body)

    def bot_play(self, name):
        """輪到電腦，問模型這一手出什麼（POST /api/bot/<遊戲>，內容是 {"record": 這一局到目前為止的紀錄,
        "seat": 輪到的座位, "mode": "normal" 或 "weak", "model": 模型的名稱（可以不給）}）。
        這個遊戲沒有模型時回 404，遊戲頁面就用自己的電腦。"""
        body = self.read_body()
        if body is None:
            return
        game, bots = find_game(name), self.server.bots
        if game is None:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "unknown game"})
        if not bots:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "no model"})
        try:
            asked = json.loads(body, parse_constant=reject_constant)
            if not isinstance(asked, dict):
                raise ValueError("not an object")
            answer = bots.play(game["slug"], asked.get("record"), asked.get("seat"), asked.get("mode", "normal"),
                               asked.get("model"))
        except (ValueError, RecursionError) as e:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"bad request: {e}"})
        except model_bot.Refused as e:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
        except Exception:       # 模型算到一半出錯：記下來，遊戲頁面會改用自己的電腦
            print(f"[{now()}] 模型出牌失敗（{game['slug']}）：\n{traceback.format_exc()}", flush=True)
            return self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "the model failed"})
        if not answer:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "no model"})
        self.send_json(HTTPStatus.OK, answer)

    def send_json(self, status, value, send_body=True):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def send_text(self, status, text):
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_asset(self, name, send_body):
        # 僅公開 assets 裡的前端檔案。請求路徑不能包含子目錄。
        media = ASSET_TYPES.get(Path(name).suffix)
        if not media or not re.fullmatch(r"[a-z0-9-]+\.[a-z0-9]+", name):
            return self.send_page(HTTPStatus.NOT_FOUND, not_found_page(), send_body)
        try:
            file = ASSETS_DIR / name
            with file.open("rb") as stream:
                stat = os.fstat(stream.fileno())
                etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
                cached = self.headers.get("If-None-Match") == etag
                body = stream.read() if send_body and not cached else None
        except OSError:
            return self.send_page(HTTPStatus.NOT_FOUND, not_found_page(), send_body)
        self.send_response(HTTPStatus.NOT_MODIFIED if cached else HTTPStatus.OK)
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        if not cached:
            self.send_header("Content-Type", media)
            self.send_header("Content-Length", str(stat.st_size))
            self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if body is not None:
            self.wfile.write(body)

    def respond(self, send_body):
        path = unquote(urlsplit(self.path).path)
        if path.startswith("/assets/"):
            return self.send_asset(path[len("/assets/"):], send_body)
        if path in ("/", "/index.html"):
            return self.send_page(HTTPStatus.OK, lobby_page(self.headers.get("Host", ""), self.server.bots), send_body)
        if path.startswith("/api/bot/"):
            return self.bot_info(path[len("/api/bot/"):], send_body)
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

    def log_request(self, code="-", size="-"):
        # 電腦每出一張牌就問一次模型：問成功的不記（不然紀錄檔全是這個），出錯的照記
        if getattr(self, "path", "").startswith("/api/bot/") and getattr(code, "value", code) == HTTPStatus.OK:
            return
        super().log_request(code, size)

    def log_message(self, format, *args):
        print(f"[{now()}] {self.client_address[0]} {format % args}", flush=True)


class GameServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_port = False  # 同一個 port 不能被第二個伺服器搶走
    data_dir = DATA_DIR       # 對局紀錄存放的資料夾
    bots = None               # 訓練好的模型（model_bot.Bots）；None＝沒有模型可以選，電腦都用遊戲頁面自己的打法

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


def describe_model(model):
    """一個模型寫成一行人看的話（model 是 GET /api/bot/<遊戲> 的 models 裡的一個）。"""
    text = f"用 {model.get('rounds')} 局練的模型"
    if model.get("saved"):
        text += f"（{str(model['saved'])[:16].replace('T', ' ')} 存檔）"
    if model.get("accuracy") is not None:
        text += f"，沒練過的對局裡猜中 {model['accuracy']:.1%}"
    if model.get("search"):     # 只有載入了推算程式（gongzhu_search）的伺服器才會回報這一項
        text += "，出牌前會先推算"
    return text + ("" if model.get("finished") else "，還沒練完")


def model_lines(game_name, info):
    """一個遊戲的模型，一個一行（info 是 GET /api/bot/<遊戲> 的內容）；沒有模型檔時是空的。"""
    models = info.get("models") or ([info["model"]] if info.get("model") else [])    # 舊版的伺服器只回一個
    lines = [f"{game_name}{' ' + model['name'] if model.get('name') else ''}：{describe_model(model)}" for model in models]
    if info.get("why"):
        lines.append(f"{game_name}：有模型檔但不能用：{info['why']}")
    return lines


def print_models(infos, folder=None):
    """哪些遊戲有模型可以選。infos：{遊戲的顯示名稱: GET /api/bot/<遊戲> 的內容}。"""
    lines = [f"  {line}" for name, info in infos.items() for line in model_lines(name, info)]
    where = f"（{folder}）" if folder else ""
    if lines:
        print(f"可以選模型當電腦的遊戲{where}（在遊戲的規則說明或計分板裡選「電腦的打法」）：", flush=True)
        for line in lines:
            print(line, flush=True)
    else:
        print(f"還沒有訓練好的模型{where}：電腦都是遊戲內建的打法。"
              "train_out/<遊戲>/model.pt 放進來，遊戲裡就能選模型當電腦。", flush=True)


def ask_models(host, port):
    """問執行中的伺服器它現在用哪些模型（它自己最清楚用的是哪個資料夾）；問不到（例如還是舊版）回傳 None。"""
    infos = {}
    for game in find_games():
        try:
            with urllib.request.urlopen(f"http://{host}:{port}/api/bot/{quote(game['slug'])}", timeout=3) as response:
                infos[game["name"]] = json.load(response)
        except (OSError, ValueError):
            return None
    return infos


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


def run(host, port, data_dir=DATA_DIR, model_dir=None):
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

    server.data_dir = data_dir
    server.bots = model_bot.Bots(model_dir) if model_bot else None
    PID_FILE.write_text(f"{os.getpid()} {host} {port}\n")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(f"[{now()}] 遊戲伺服器已啟動", flush=True)
    print_urls(host, port)
    print(f"對局紀錄存放在：{data_dir}", flush=True)
    if server.bots:
        print_models({game["name"]: server.bots.info(game["slug"]) for game in find_games()}, server.bots.folder)
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


def start(host, port, data_dir=DATA_DIR, model_dir=None):
    """在背景開啟伺服器（新的 session，關掉終端機也不會停）。"""
    running = read_pid_file()
    if running:
        print(f"遊戲伺服器已經在執行（PID {running[0]}）。")
        print_urls(running[1], running[2])
        return 0

    rotate_log()
    with LOG_FILE.open("ab") as log:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(SCRIPT_PATH), "run", "--host", host, "--port", str(port),
             "--data-dir", str(data_dir), *(["--model-dir", str(model_dir)] if model_dir else [])],
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
            print(f"對局紀錄存放在：{data_dir}")
            infos = ask_models(host, port)
            if infos is not None:
                print_models(infos)
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
    infos = ask_models(running[1], running[2])
    if infos is None:
        print(f"問不到這個伺服器有哪些模型。它如果是更新之前開的，要重新啟動才能選模型：python3 {SCRIPT_PATH.name} restart")
    else:
        print_models(infos)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Tailscale 內網遊戲伺服器")
    parser.add_argument("command", nargs="?", default="start",
                        choices=["start", "stop", "status", "restart", "run"],
                        help="start（預設，背景執行）、stop、status、restart、run（前景執行）")
    parser.add_argument("--port", type=int, help=f"port（預設 {DEFAULT_PORT}）")
    parser.add_argument("--host", help="監聽的位址（預設：自動抓這台的 Tailscale IP，只有 Tailscale 內網連得到）")
    parser.add_argument("--data-dir", help="對局紀錄存放的資料夾（預設：這個程式旁邊的 gaming_data/）")
    parser.add_argument("--model-dir", help="訓練好的模型放在哪個資料夾（預設：這個程式旁邊的 train_out/）")
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
    data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else DATA_DIR
    model_dir = Path(args.model_dir).expanduser().resolve() if args.model_dir else None    # None：train_out/
    if args.command == "run":
        return run(host, port, data_dir, model_dir)
    return start(host, port, data_dir, model_dir)


if __name__ == "__main__":
    sys.exit(main())
