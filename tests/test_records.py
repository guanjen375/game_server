"""遊戲伺服器收對局紀錄的測試：python3 tests/test_records.py

開一個只聽 127.0.0.1 的伺服器，遊戲檔和紀錄都放在暫存資料夾，不會碰到正式的 games/ 和 gaming_data/。
"""

import hashlib
import http.client
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import open_server  # noqa: E402

PAGE = "<!DOCTYPE html><html><head><title>暗棋 - 測試</title></head><body><header></header></body></html>"
ROUND = "20261120-164512-k3f9x2"


def record(**changes):
    base = {
        "id": ROUND, "seq": 1, "session": "abcd1234", "build": "0" * 40, "status": "finished",
        "started": "2026-11-20T16:45:12+08:00", "ended": "2026-11-20T16:58:40+08:00",
        "round": 3, "players": {"south": {"name": "您（玩家）", "ai": False}},
        "moves": [{"n": 1, "seat": "south", "kind": "flip", "sq": 5, "code": 3},
                  {"n": 2, "seat": "north", "kind": "flip", "sq": 9, "code": 12}],
        "result": {"winner": "south", "reasonText": "吃光對方所有棋子"},
    }
    base.update(changes)
    return base


class RecordServerTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        games = Path(folder.name) / "games"
        games.mkdir()
        (games / "banqi.html").write_text(PAGE, encoding="utf-8")
        self.page = PAGE.encode()
        self.data = Path(folder.name) / "data"

        for name, value in (("GAMES_DIR", games), ("RECORD_MAX_BYTES", 20_000)):
            self.addCleanup(setattr, open_server, name, getattr(open_server, name))
            setattr(open_server, name, value)
        self.addCleanup(setattr, open_server.GameHandler, "log_message", open_server.GameHandler.log_message)
        open_server.GameHandler.log_message = lambda *args: None

        self.server = open_server.GameServer(("127.0.0.1", 0), open_server.GameHandler)
        self.server.data_dir = self.data
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        self.addCleanup(connection.close)
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        connection.request(method, quote(path), body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.read().decode()

    def post(self, body, game="banqi", **headers):
        return self.request("POST", f"/api/records/{game}", body, {"User-Agent": "unittest", **headers})

    def files(self):
        return sorted(str(path.relative_to(self.data)) for path in self.data.rglob("*") if path.is_file())

    def saved(self, name=f"banqi/2026-11/{ROUND}.json"):
        return json.loads((self.data / name).read_text(encoding="utf-8"))

    def test_one_json_file_per_round_under_game_and_month(self):
        self.assertEqual(self.post(record()), (200, "saved"))
        self.assertEqual(self.files(), [f"banqi/2026-11/{ROUND}.json"])
        saved = self.saved()
        self.assertEqual([saved[key] for key in ("game", "id", "status", "ip", "ua")],
                         ["banqi", ROUND, "finished", "127.0.0.1", "unittest"])
        self.assertRegex(saved["saved"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$")    # the server's clock
        for key, value in record().items():
            self.assertEqual(saved[key], value, key)
        # The server's own columns come first, and a page cannot overwrite them.
        self.assertEqual(list(saved)[:8], ["game", "id", "status", "started", "ended", "saved", "ip", "ua"])
        self.post(record(id="20261120-170000-zzzzzz", game="xiangqi", ip="1.2.3.4", ua="spoof", saved="x", status="?"))
        spoofed = self.saved("banqi/2026-11/20261120-170000-zzzzzz.json")
        self.assertEqual([spoofed["game"], spoofed["ip"], spoofed["ua"], spoofed["status"]],
                         ["banqi", "127.0.0.1", "unittest", "unfinished"])
        self.assertNotEqual(spoofed["saved"], "x")

    def test_a_round_sent_again_keeps_only_the_newest_copy(self):
        self.assertEqual(self.post(record(status="unfinished", result=None))[1], "saved")
        self.assertEqual(self.saved()["status"], "unfinished")
        self.assertEqual(self.post(record(seq=2))[1], "saved")
        self.assertEqual(self.post(record(seq=1, status="unfinished", result=None)), (200, "already saved"))
        self.assertEqual(self.post(record(seq=2, round=99)), (200, "already saved"))
        saved = self.saved()
        self.assertEqual([saved["status"], saved["seq"], saved["round"]], ["finished", 2, 3])
        self.assertEqual(self.files(), [f"banqi/2026-11/{ROUND}.json"])    # no temporary file is left behind

    def test_file_is_plain_json_with_one_move_per_line(self):
        self.post(record())
        text = (self.data / f"banqi/2026-11/{ROUND}.json").read_text(encoding="utf-8")
        lines = text.splitlines()
        self.assertIn('  {"n":1,"seat":"south","kind":"flip","sq":5,"code":3},', lines)
        self.assertIn(' "players": {"south":{"name":"您（玩家）","ai":false}},', lines)
        self.assertEqual(lines[0] + lines[-1], "{}")
        tricky = {"空": [], "nested": [[1, 2], [3]], "mixed": [1, {"a": None}], "text": '"quoted"\n', "n": -1.5}
        self.assertEqual(json.loads(open_server.dump_record(tricky)), tricky)

    def test_bad_records_are_refused_and_nothing_is_written(self):
        bad = [
            record(id="../../../etc/passwd"), record(id="20261120-164512-K3F9X2"), record(id=ROUND + "x"),
            record(id="20261340-164512-k3f9x2"), record(id=None), record(seq=None), record(seq=-1),
            record(seq=1.5), record(seq=True), [record()], "text", b"{not json", b"", b'{"id": NaN}',
            b"[" * 5000,
        ]
        for body in bad:
            status, text = self.post(body)
            self.assertEqual(status, 400, (body, text))
        self.assertEqual(self.files(), [])

    def test_only_known_games_and_only_the_record_address(self):
        self.assertEqual(self.post(record(), game="nosuch")[0], 404)
        self.assertEqual(self.post(record(), game="../banqi")[0], 404)
        self.assertEqual(self.request("POST", "/banqi", record())[0], 404)
        self.assertEqual(self.request("POST", "/api/other", record())[0], 404)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.post(record(), game="暗棋"), (200, "saved"))    # a catalogue alias of banqi
        self.assertEqual(self.files(), [f"banqi/2026-11/{ROUND}.json"])
        self.assertEqual(self.request("GET", "/api/records/banqi")[0], 404)    # records cannot be read back

    def test_pages_from_other_sites_cannot_write(self):
        host = f"127.0.0.1:{self.server.server_address[1]}"
        self.assertEqual(self.post(record(), Origin="http://evil.example")[0], 403)
        self.assertEqual(self.post(record(), Origin="null")[0], 403)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.post(record(), Origin=f"http://{host}"), (200, "saved"))

    def test_oversized_records_are_refused(self):
        status, text = self.post(record(padding="x" * 30_000))
        self.assertEqual((status, text), (413, "record too large"))
        self.assertEqual(self.post(b"x" * 10, **{"Content-Length": "999999999"})[0], 413)
        self.assertEqual(self.files(), [])

    def test_alias_and_trailing_slash_load_the_same_local_styles(self):
        page = PAGE.replace("</head>", '<link rel="stylesheet" href="assets/layout.css"></head>')
        (open_server.GAMES_DIR / "banqi.html").write_text(page, encoding="utf-8")
        for route in ("/banqi", "/banqi/", "/暗棋/"):
            status, body = self.request("GET", route)
            self.assertEqual(status, 200)
            self.assertIn('href="/assets/layout.css"', body)

        connection = http.client.HTTPConnection(*self.server.server_address, timeout=10)
        self.addCleanup(connection.close)
        connection.request("GET", "/assets/layout.css")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/css; charset=utf-8")
        size, etag = len(response.read()), response.getheader("ETag")
        self.assertGreater(size, 0)
        connection.request("HEAD", "/assets/layout.css")
        response = connection.getresponse()
        self.assertEqual(int(response.getheader("Content-Length")), size)
        self.assertEqual(response.read(), b"")
        connection.request("GET", "/assets/layout.css", headers={"If-None-Match": etag})
        self.assertEqual(connection.getresponse().status, 304)

    def test_new_game_gets_a_lobby_card_without_cover_art(self):
        (open_server.GAMES_DIR / "new-game.html").write_text(
            "<title>新遊戲 &amp; 測試</title>", encoding="utf-8")
        status, lobby = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn('data-category="其他" href="/new-game"', lobby)
        self.assertIn('<h3>新遊戲 &amp; 測試</h3>', lobby)
        self.assertNotIn('src="/assets/new-game.webp"', lobby)

    def test_game_pages_carry_the_recorder_and_their_version(self):
        status, page = self.request("GET", "/banqi")
        self.assertEqual(status, 200)
        head = page[:page.index("</head>")]
        self.assertIn("window.GameRecorder = (function () {", head)
        self.assertIn("GAME = 'banqi'", head)
        version = hashlib.sha1(b"blob %d\0" % len(self.page) + self.page).hexdigest()
        self.assertIn(f"BUILD = '{version}'", head)
        self.assertNotIn("__GAME__", page)
        self.assertNotIn("__BUILD__", page)
        self.assertIn("回遊戲大廳", page[page.index("</head>"):])
        if shutil.which("git"):    # the version really is git's blob id of the game file
            blob = subprocess.run(["git", "hash-object", "--stdin"], input=self.page, capture_output=True, check=True)
            self.assertEqual(blob.stdout.decode().strip(), version)
        self.assertNotIn("GameRecorder", self.request("GET", "/")[1])


class DefaultFolderTest(unittest.TestCase):
    def test_records_go_to_gaming_data_inside_the_project(self):
        self.assertEqual(open_server.DATA_DIR, ROOT / "gaming_data")
        self.assertEqual(open_server.GameServer.data_dir, ROOT / "gaming_data")

    def test_gaming_data_is_not_tracked_by_git(self):
        if not shutil.which("git") or not (ROOT / ".git").exists():
            self.skipTest("not a git checkout")
        ignored = subprocess.run(["git", "check-ignore", "-q", "gaming_data/banqi/2026-11/x.json"], cwd=ROOT)
        self.assertEqual(ignored.returncode, 0, "gaming_data/ must be listed in .gitignore")
        tracked = subprocess.run(["git", "ls-files", "gaming_data"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(tracked.stdout, "")


if __name__ == "__main__":
    unittest.main()
