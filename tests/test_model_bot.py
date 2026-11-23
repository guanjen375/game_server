"""model_bot.py 和伺服器「電腦照模型出牌」的測試：python3 tests/test_model_bot.py

模型都放在暫存資料夾，不會碰到正式的 train_out/；伺服器只聽 127.0.0.1。
多數測試用 tests/fixtures/models/gongzhu/ 裡一個很小的模型檔（真的 PyTorch 存出來的）和 PyTorch 當時算的分數，
所以沒裝 PyTorch 的電腦也測得到「不靠 PyTorch 讀模型、算分數」。裝了 PyTorch 時另外現練一個模型，直接和 PyTorch 對。
改了模型的算法或看牌的欄位之後那個小模型要重做，在有 PyTorch 的電腦上執行：
    python3 tests/test_model_bot.py --write-fixture
PageRequests 那一組讀的是真的遊戲頁面問伺服器的內容，由 node --test tests/model-bot.test.cjs 用
MODEL_BOT_REQUESTS 帶進來；單獨執行這個檔案時會跳過。
"""

import contextlib
import hashlib
import http.client
import importlib.util
import io
import json
import os
import pickle
import random
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
import zipfile
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import model_bot  # noqa: E402
import open_server  # noqa: E402
import train_gpu  # noqa: E402
import test_train_gpu as made  # noqa: E402  (its rounds of Gong Zhu and its way of running the trainer)

FIXTURE = ROOT / "tests" / "fixtures" / "models"
MODEL = FIXTURE / "gongzhu" / "model.pt"
EXPECTED = FIXTURE / "gongzhu" / "expected.json"
PAGE_REQUESTS = os.environ.get("MODEL_BOT_REQUESTS")
GAME = train_gpu.GongZhu()


def asked(record, count):
    """What a page sends when `count` cards of the round have been played."""
    plays = [dict(play) for trick in record["tricks"] for play in trick][:count]
    return {"finished": False, "round": record["round"], "settings": record["settings"], "seats": record["seats"],
            "players": record["players"], "hands": record["hands"], "totals": record["totals"],
            "tricks": [plays[i:i + 4] for i in range(0, len(plays), 4)], "result": None}


def digest(state):
    """One number for every array of a model, the same whether it was read by PyTorch or without it."""
    total = hashlib.sha256()
    for name in sorted(state):
        values = state[name]
        if hasattr(values, "flatten"):
            values = values.flatten().tolist()
        flat, stack = [], [values]
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(reversed(item))
            else:
                flat.append(item)
        kind = "?" if isinstance(flat[0], bool) else "f"
        total.update(name.encode() + struct.pack(f"<{len(flat)}{kind}", *flat))
    return total.hexdigest()


def expected():
    return json.loads(EXPECTED.read_text(encoding="utf-8"))


class NextDecision(unittest.TestCase):
    def test_the_card_about_to_be_played_is_seen_exactly_as_training_saw_it(self):
        for record in made.rounds(3, seed=5):
            plays = [play for trick in record["tricks"] for play in trick]
            decisions = list(GAME.decisions(record))
            self.assertEqual(len(decisions), 52)
            for count, play in enumerate(plays):
                seat, x, mask, entry = GAME.upcoming(dict(asked(record, count), status="unfinished"))
                _, _, [(seen, allowed, chosen)] = decisions[count]
                self.assertEqual(seat, play["seat"])
                self.assertEqual((bytes(x), bytes(mask)), (bytes(seen), bytes(allowed)), f"card {count + 1}")
                self.assertEqual(entry(chosen), {"seat": play["seat"], "card": play["card"]})

    def test_a_round_that_is_over_has_no_next_card(self):
        record = made.rounds(1)[0]
        for over in (dict(asked(record, 52), status="unfinished"), record):
            with self.assertRaisesRegex(train_gpu.Skip, "已經打完"):
                GAME.upcoming(over)

    def test_a_round_that_does_not_add_up_is_refused(self):
        record = made.rounds(1)[0]
        short = dict(asked(record, 6), status="unfinished")
        short["hands"] = dict(short["hands"], south=short["hands"]["south"][1:])
        with self.assertRaises(train_gpu.Skip):
            GAME.upcoming(short)
        swapped = dict(asked(record, 6), status="unfinished")
        swapped["tricks"] = [swapped["tricks"][0][::-1], swapped["tricks"][1]]
        with self.assertRaises(train_gpu.Skip):
            GAME.upcoming(swapped)

    def test_the_other_games_say_they_are_not_connected_yet(self):
        for slug, kind in train_gpu.GAMES.items():
            if slug != "gongzhu":
                with self.assertRaisesRegex(train_gpu.Skip, "還沒有接上"):
                    kind().upcoming({})


class ReadingTheModel(unittest.TestCase):
    def test_every_array_is_what_pytorch_saved(self):
        saved = model_bot.read_model(MODEL)
        self.assertEqual(saved["format"], "game-policy-1")
        self.assertEqual(saved["game"], "gongzhu")
        self.assertEqual(digest(saved["state"]), expected()["arrays"])
        self.assertEqual(model_bot.read_model(MODEL.read_bytes())["state"], saved["state"], "from its contents too")

    def test_the_scores_are_the_ones_pytorch_computes(self):
        want = expected()
        self.assertEqual(want["encoder"], train_gpu.encoder_of(GAME),
                         "the little model was made for other features: python3 tests/test_model_bot.py --write-fixture")
        policy = model_bot.Policy(model_bot.read_model(MODEL))
        seen = 0
        for record, scores in zip(want["rounds"], want["scores"]):
            for (_, _, [(x, mask, _)]), theirs in zip(GAME.decisions(record), scores):
                ours = policy.scores(x, mask)
                self.assertEqual(sorted(ours), sorted(map(int, theirs)), "one score for every card that may be played")
                for action, score in theirs.items():
                    self.assertAlmostEqual(ours[int(action)], score, delta=1e-4)
                best = max(theirs, key=lambda action: (theirs[action], -int(action)))
                self.assertEqual(model_bot.pick(ours, "normal"), int(best))
                seen += 1
        self.assertGreater(seen, 100)

    def test_a_file_that_wants_to_run_something_is_refused_and_nothing_runs(self):
        with tempfile.TemporaryDirectory() as folder:
            trap = Path(folder) / "ran"

            class Run:
                def __reduce__(self):
                    return (os.system, (f"touch {trap}",))

            path = Path(folder) / "model.pt"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("archive/data.pkl", pickle.dumps({"format": "game-policy-1", "state": Run()}, protocol=2))
            with self.assertRaisesRegex(model_bot.Unusable, "讀不出來"):
                model_bot.read_model(path)
            self.assertFalse(trap.exists())

    def test_whatever_is_not_a_model_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "model.pt"
            for content in (b"", b"not a model", MODEL.read_bytes()[:2000]):
                path.write_bytes(content)
                with self.assertRaises(model_bot.Unusable):
                    model_bot.read_model(path)
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("archive/version", "3")
            with self.assertRaisesRegex(model_bot.Unusable, "data.pkl"):
                model_bot.read_model(path)
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("archive/data.pkl", pickle.dumps({"format": 1, "model": None}, protocol=2))
            with self.assertRaisesRegex(model_bot.Unusable, "不是 train_gpu.py"):
                model_bot.read_model(path)
            with self.assertRaises(model_bot.Unusable):
                model_bot.read_model(Path(folder) / "missing.pt")


class Choosing(unittest.TestCase):
    SCORES = {3: 2.0, 7: 2.0 + 0.6931471805599453, 20: 0.0, 41: -3.0}     # chances: 0.306, 0.611, 0.041, 0.002... of 1

    def test_normal_takes_the_highest_score_and_the_lower_card_of_equals(self):
        self.assertEqual(model_bot.pick(self.SCORES, "normal"), 7)
        self.assertEqual(model_bot.pick({9: 1.5, 4: 1.5, 30: 1.0}, "normal"), 4)
        self.assertEqual(model_bot.pick({9: 1.5, 4: 1.5, 30: 1.0}, "normal", "any key"), 4)

    def test_weak_draws_by_the_models_chances_but_never_what_it_would_hardly_ever_play(self):
        chances = model_bot.chances(self.SCORES)
        self.assertAlmostEqual(sum(chances.values()), 1.0)
        self.assertLess(chances[20], model_bot.WEAK_FLOOR)
        drawn = [model_bot.pick(self.SCORES, "weak", f"position {n}") for n in range(4000)]
        self.assertEqual(set(drawn), {3, 7})
        share = drawn.count(3) / len(drawn)
        self.assertAlmostEqual(share, chances[3] / (chances[3] + chances[7]), delta=0.03)

    def test_weak_gives_the_same_card_whenever_the_position_is_the_same(self):
        even = {a: 0.0 for a in range(8)}
        first = [model_bot.pick(even, "weak", f"position {n}") for n in range(50)]
        self.assertEqual(first, [model_bot.pick(even, "weak", f"position {n}") for n in range(50)])
        self.assertGreater(len(set(first)), 4, "while different positions draw differently")

    def test_weak_keeps_the_first_choice_when_nothing_else_is_likely_enough(self):
        sure = {5: 9.0, 6: 0.0, 7: 0.0}
        self.assertEqual({model_bot.pick(sure, "weak", f"k{n}") for n in range(200)}, {5})
        self.assertEqual(model_bot.pick({12: -4.0}, "weak", "only one card"), 12)


PAGE = "<!DOCTYPE html><html><head><title>{} - 測試</title></head><body><header></header></body></html>"


class Server(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        games = Path(folder.name) / "games"
        games.mkdir()
        for slug, title in (("gongzhu", "拱豬"), ("banqi", "暗棋")):
            (games / f"{slug}.html").write_text(PAGE.format(title), encoding="utf-8")
        self.models = Path(folder.name) / "models"
        self.logged = []

        self.addCleanup(setattr, open_server, "GAMES_DIR", open_server.GAMES_DIR)
        open_server.GAMES_DIR = games
        self.addCleanup(setattr, open_server.GameHandler, "log_message", open_server.GameHandler.log_message)
        open_server.GameHandler.log_message = lambda handler, text, *args: self.logged.append(text % args)

        self.server = open_server.GameServer(("127.0.0.1", 0), open_server.GameHandler)
        self.server.bots = model_bot.Bots(self.models)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.record = made.rounds(1, seed=11)[0]

    def install(self, slug="gongzhu", source=MODEL):
        target = self.models / slug / "model.pt"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target.with_name("model.pt.new"))
        os.replace(target.with_name("model.pt.new"), target)
        return target

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        self.addCleanup(connection.close)
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        connection.request(method, quote(path), body=body, headers=headers or {})
        response = connection.getresponse()
        text = response.read().decode()
        return response.status, json.loads(text) if response.getheader("Content-Type", "").startswith("application/json") else text

    def ask(self, count, mode="normal", game="gongzhu", **changes):
        record = asked(self.record, count)
        seat = [play for trick in self.record["tricks"] for play in trick][count]["seat"]
        return self.request("POST", f"/api/bot/{game}", {"record": record, "seat": seat, "mode": mode, **changes})

    def test_without_a_model_the_page_is_told_to_play_by_itself(self):
        self.assertEqual(self.request("GET", "/api/bot/gongzhu"), (200, {"model": None, "why": None, "models": []}))
        self.assertEqual(self.ask(5), (404, {"error": "no model"}))
        self.server.bots = None      # the server could not load model_bot at all
        self.assertEqual(self.request("GET", "/api/bot/gongzhu"), (200, {"model": None, "why": None, "models": []}))
        self.assertEqual(self.ask(5), (404, {"error": "no model"}))

    def test_a_model_is_used_as_soon_as_its_file_is_there_and_says_what_it_is(self):
        self.install()
        status, info = self.request("GET", "/api/bot/gongzhu")
        self.assertEqual((status, info["why"]), (200, None))
        data = MODEL.read_bytes()
        self.assertEqual(info["model"]["id"], hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest(), "git's name for the file")
        saved = model_bot.read_model(MODEL)
        self.assertEqual(info["model"]["rounds"], saved["data"]["used_rounds"])
        self.assertEqual(info["model"]["saved"], saved["saved"])
        self.assertEqual(info["model"]["accuracy"], saved["result"]["validation_accuracy"])
        self.assertTrue(info["model"]["finished"])
        self.assertNotIn(str(self.models), json.dumps(info), "nothing about this machine")

        status, answer = self.ask(5)
        self.assertEqual(status, 200)
        self.assertEqual((answer["mode"], answer["model"]), ("normal", info["model"]["id"]))

    def test_normal_plays_the_models_first_choice_and_weak_one_of_its_likely_ones(self):
        self.install()
        policy = model_bot.Policy(model_bot.read_model(MODEL))
        plays = [play for trick in self.record["tricks"] for play in trick]
        others = 0
        for count in range(0, 52, 3):
            _, x, mask, entry = GAME.upcoming(dict(asked(self.record, count), status="unfinished"))
            scores = policy.scores(x, mask)
            first = entry(max(scores, key=lambda action: (scores[action], -action)))
            status, answer = self.ask(count)
            self.assertEqual((status, answer["play"]), (200, first))
            self.assertEqual(answer["play"]["seat"], plays[count]["seat"])

            status, weak = self.ask(count, "weak")
            self.assertEqual((status, weak["mode"]), (200, "weak"))
            chance = model_bot.chances(scores)[GAME.card(weak["play"]["card"])]
            self.assertTrue(weak["play"] == first or chance >= model_bot.WEAK_FLOOR, f"{weak['play']} at {chance:.3f}")
            self.assertEqual(self.ask(count, "weak")[1], weak, "asked again about the same position")
            others += weak["play"] != first
        self.assertGreater(others, 0, "weak does stray from the first choice now and then")

    def test_a_new_file_replaces_the_model_without_a_restart(self):
        target = self.install()
        first = self.request("GET", "/api/bot/gongzhu")[1]["model"]["id"]
        target.write_bytes(b"this is not a model")
        status, info = self.request("GET", "/api/bot/gongzhu")
        self.assertEqual((status, info["model"]), (200, None))
        self.assertIn("讀不出來", info["why"])
        self.assertEqual(self.ask(5), (404, {"error": "no model"}))
        self.install()
        self.assertEqual(self.request("GET", "/api/bot/gongzhu")[1]["model"]["id"], first)
        self.assertEqual(self.ask(5)[0], 200)
        target.unlink()
        self.assertEqual(self.request("GET", "/api/bot/gongzhu"), (200, {"model": None, "why": None, "models": []}))

    def test_a_model_that_does_not_fit_is_left_alone_with_the_reason(self):
        self.install("banqi")
        self.assertIn("還沒有接上", self.request("GET", "/api/bot/banqi")[1]["why"])
        self.assertEqual(self.request("POST", "/api/bot/banqi", {"record": {}, "seat": "south"}), (404, {"error": "no model"}))

        self.addCleanup(setattr, train_gpu, "encoder_of", train_gpu.encoder_of)
        real = train_gpu.encoder_of
        train_gpu.encoder_of = lambda game: dict(real(game), version=real(game)["version"] + 1)
        self.install()
        status, info = self.request("GET", "/api/bot/gongzhu")
        self.assertEqual(info["model"], None)
        self.assertIn("重新訓練", info["why"])

    def test_questions_that_do_not_add_up_are_refused(self):
        self.install()
        status, answer = self.ask(5, seat="south" if self.ask(5)[1]["play"]["seat"] != "south" else "east")
        self.assertEqual(status, 400)
        self.assertIn("輪到", answer["error"])
        self.assertEqual(self.ask(5, mode="strong")[0], 400)
        self.assertEqual(self.ask(5, record=None)[0], 400)
        self.assertEqual(self.ask(5, record={"seats": []})[0], 400)
        self.assertEqual(self.ask(5, record=asked(self.record, 52))[0], 400, "the round is over")
        broken = asked(self.record, 5)
        broken["tricks"][1][0]["card"] = broken["tricks"][0][0]["card"]
        self.assertEqual(self.ask(5, record=broken)[0], 400)
        self.assertEqual(self.request("POST", "/api/bot/gongzhu", b"[1, 2]", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/bot/gongzhu", b"{not json")[0], 400)
        self.assertEqual(self.request("POST", "/api/bot/nosuchgame", {"record": {}})[0], 404)
        self.assertEqual(self.request("GET", "/api/bot/nosuchgame")[0], 404)
        port = self.server.server_address[1]
        self.assertEqual(self.request("POST", "/api/bot/gongzhu", {"record": {}},
                                      {"Origin": "http://evil.example", "Host": f"127.0.0.1:{port}"})[0], 403)
        seat_free = self.ask(5, seat=None)
        self.assertEqual(seat_free[0], 200, "the seat is only a cross-check")

    def test_game_pages_carry_the_script_and_the_lobby_marks_the_game(self):
        status, page = self.request("GET", "/gongzhu")
        self.assertEqual(status, 200)
        self.assertIn("window.GameBot", page)
        self.assertIn("'/api/bot/gongzhu'", page)
        self.assertNotIn("__GAME__", page)
        self.assertLess(page.index("window.GameBot"), page.index("</head>"))
        self.assertNotIn("可以和模型對打</span>", self.request("GET", "/")[1])
        self.install()
        lobby = self.request("GET", "/")[1]
        self.assertEqual(lobby.count("可以和模型對打</span>"), 1)
        self.assertLess(lobby.index('href="/gongzhu"'), lobby.index("可以和模型對打</span>"))

    def test_answers_stay_out_of_the_log_but_refusals_are_logged(self):
        self.install()
        self.ask(5)
        self.request("GET", "/api/bot/gongzhu")
        self.assertEqual(self.logged, [])
        self.ask(5, mode="strong")
        self.request("GET", "/gongzhu")
        self.assertEqual(len(self.logged), 2)
        self.assertIn("/api/bot/gongzhu", self.logged[0])
        self.assertIn(" 400 ", self.logged[0])

    def test_status_tells_which_games_are_played_by_a_model(self):
        host, port = self.server.server_address

        def shown(infos):
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                open_server.print_models(infos)
            return printed.getvalue()

        infos = open_server.ask_models(host, port)
        self.assertEqual(infos, {"暗棋": {"model": None, "why": None, "models": []}, "拱豬": {"model": None, "why": None, "models": []}})
        self.assertIn("還沒有訓練好的模型", shown(infos))
        self.install()
        self.install("banqi")
        text = shown(open_server.ask_models(host, port))
        self.assertIn("可以選模型當電腦的遊戲", text)
        saved = model_bot.read_model(MODEL)
        self.assertIn(f"拱豬：用 {saved['data']['used_rounds']} 局練的模型", text)
        self.assertIn("暗棋：有模型檔但不能用", text)
        self.assertIsNone(open_server.ask_models("127.0.0.1", 1), "a server that cannot be asked")

    def install_as(self, name, comment=b""):
        """The little model as model_<name>.pt ("" is model.pt); a zip comment makes it a file of its own."""
        target = self.models / "gongzhu" / (f"model_{name}.pt" if name else "model.pt")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(MODEL, target)
        if comment:
            with zipfile.ZipFile(target, "a") as archive:
                archive.comment = comment
        return model_bot.blob_id(target.read_bytes())

    def test_several_models_are_listed_newest_first_and_each_is_asked_by_name(self):
        ids = {name: self.install_as(name, comment) for name, comment in (("", b""), ("20261122", b"old"), ("20261123_b", b"new"))}
        self.assertEqual(len(set(ids.values())), 3)
        for other in ("model.previous.pt", "model.pt.tmp", "checkpoint.pt", "model_bad name.pt", "model_.pt"):
            shutil.copyfile(MODEL, self.models / "gongzhu" / other)
        status, info = self.request("GET", "/api/bot/gongzhu")
        self.assertEqual(status, 200)
        self.assertEqual([model["name"] for model in info["models"]], ["20261123_b", "20261122", ""], "nothing else is a model")
        self.assertEqual([model["id"] for model in info["models"]], [ids["20261123_b"], ids["20261122"], ids[""]])
        self.assertEqual(info["model"], info["models"][0])
        for name, made_id in ids.items():
            status, answer = self.ask(5, model=name)
            self.assertEqual((status, answer["model"]), (200, made_id), name)
        self.assertEqual(self.ask(5)[1]["model"], ids["20261123_b"], "no name: the first one")
        self.assertEqual(self.ask(5, model="20261123_a")[0], 400, "a name the server does not have")
        self.assertEqual(self.ask(5, model=3)[0], 400)
        lines = open_server.model_lines("拱豬", info)
        self.assertEqual([line.split("：")[0] for line in lines], ["拱豬 20261123_b", "拱豬 20261122", "拱豬"])

    def test_a_model_that_cannot_be_used_is_named_and_the_others_still_play(self):
        self.install_as("20261123_b")
        (self.models / "gongzhu" / "model_20261123_a.pt").write_bytes(b"not a model")
        status, info = self.request("GET", "/api/bot/gongzhu")
        self.assertEqual([model["name"] for model in info["models"]], ["20261123_b"])
        self.assertTrue(info["why"].startswith("20261123_a："), info["why"])
        self.assertEqual(self.ask(5)[0], 200)
        self.assertIn("拱豬：有模型檔但不能用：20261123_a：", open_server.model_lines("拱豬", info)[-1])

        (self.models / "gongzhu" / "model_20261123_b.pt").unlink()    # taken away while the server runs
        status, info = self.request("GET", "/api/bot/gongzhu")
        self.assertEqual((info["model"], info["models"]), (None, []))
        self.assertEqual(self.ask(5), (404, {"error": "no model"}))


SHIPPED = ROOT / "train_out" / "gongzhu" / "model_20261123_b.pt"     # the default of the three Gong Zhu models
SEARCH_CASE = FIXTURE / "gongzhu" / "search-case.json"
PAGE_SEATS = ["south", "west", "north", "east"]     # the Gong Zhu page's playing order


def special_round(rng):
    """One round under the player's own rules (player_special), as the page records it:
    whoever holds ♠7 leads with any card. Everybody plays a random card they may play."""
    deck = [suit + str(n) for suit in "SHCD" for n in range(2, 15)]
    rng.shuffle(deck)
    hands = {seat: deck[i * 13:(i + 1) * 13] for i, seat in enumerate(PAGE_SEATS)}
    left = {seat: list(cards) for seat, cards in hands.items()}
    leader = next(seat for seat in PAGE_SEATS if "S7" in left[seat])
    tricks = []
    for _ in range(13):
        trick = []
        for turn in range(4):
            seat = PAGE_SEATS[(PAGE_SEATS.index(leader) + turn) % 4]
            legal = [card for card in left[seat] if trick and card[0] == trick[0]["card"][0]] or left[seat]
            card = rng.choice(legal)
            left[seat].remove(card)
            trick.append({"seat": seat, "card": card})
        leader = max((p for p in trick if p["card"][0] == trick[0]["card"][0]), key=lambda p: int(p["card"][1:]))["seat"]
        tricks.append(trick)
    return {"finished": True, "round": 1, "settings": {"scoringRuleMode": "player_special", "roundBase": 50},
            "seats": PAGE_SEATS, "players": {seat: {"name": seat, "ai": seat != "south"} for seat in PAGE_SEATS},
            "hands": hands, "totals": {seat: 0 for seat in PAGE_SEATS}, "tricks": tricks, "result": None}


class Searching(unittest.TestCase):
    """The Gong Zhu model in train_out/ (20261123 on) thinks ahead before every card (gongzhu_search/).
    The server then needs NumPy and a C++17 compiler; without them these tests are skipped."""

    @classmethod
    def setUpClass(cls):
        if importlib.util.find_spec("numpy") is None:
            raise unittest.SkipTest("NumPy is not installed")
        if not shutil.which(os.environ.get("CXX", "c++")):
            raise unittest.SkipTest("no C++ compiler")
        if not SHIPPED.exists() or "search" not in model_bot.read_model(SHIPPED):
            raise unittest.SkipTest("train_out/gongzhu/model.pt does not search")
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        cls.folder = Path(folder.name)
        (cls.folder / "gongzhu").mkdir()
        shutil.copyfile(SHIPPED, cls.folder / "gongzhu" / "model.pt")
        cls.shipped = sorted((ROOT / "train_out" / "gongzhu").glob("model*.pt"))
        cls.bots = model_bot.Bots(cls.folder)
        cls.info = cls.bots.info("gongzhu")
        cls.wait = int(re.search(r"WAIT_MS = (\d+)", open_server.BOT).group(1)) / 1000

    def test_it_loads_and_says_how_it_searches(self):
        self.assertIsNone(self.info["why"])
        search = self.info["model"]["search"]
        self.assertEqual(search["rules"], "player_special")
        self.assertGreater(search["settings"]["worlds"], 1)
        self.assertIn("出牌前會先推算", open_server.describe_model(self.info["model"]), "status shows the server really searches")
        plain = {k: v for k, v in self.info["model"].items() if k != "search"}
        self.assertNotIn("推算", open_server.describe_model(plain), "a server still on the old code does not")

    def test_the_position_checked_when_it_was_handed_over_gets_the_same_card(self):
        case = json.loads(SEARCH_CASE.read_text(encoding="utf-8"))
        if self.info["model"]["id"] != case["expected"]["model"]:
            self.skipTest("train_out/gongzhu/model.pt is not the 20261123 model any more")
        asked_for = case["request"]
        self.assertEqual(self.bots.play("gongzhu", asked_for["record"], asked_for["seat"], asked_for["mode"]),
                         case["expected"])

    def questions(self):
        """(record so far, seat to play) at the start, inside tricks, and in the last two tricks of two rounds."""
        rng = random.Random(20261123)
        for record in (special_round(rng) for _ in range(2)):
            plays = [play for trick in record["tricks"] for play in trick]
            for count in (0, 1, 2, 3, 4, 13, 22, 31, 40, 43, 44, 46, 49, 51):
                yield asked(record, count), plays[count]["seat"]

    def test_it_plays_cards_that_seat_may_play_and_the_same_again(self):
        worlds = self.info["model"]["search"]["settings"]["worlds"]
        for question, seat in self.questions():
            turn, x, mask, _ = GAME.upcoming(dict(question, status="unfinished"))
            self.assertEqual(turn, seat)
            legal = sum(mask)
            for mode in ("normal", "weak"):
                answer = self.bots.play("gongzhu", question, seat, mode)
                self.assertEqual((answer["play"]["seat"], answer["mode"]), (seat, mode))
                self.assertTrue(mask[GAME.card(answer["play"]["card"])], f"{answer['play']} is not allowed")
                self.assertEqual(answer["search"]["legal_actions"], legal)
                self.assertEqual(answer["search"]["root_successors"], worlds * legal if legal > 1 else 0)
                self.assertEqual(self.bots.play("gongzhu", question, seat, mode), answer, "asked again")

    def test_a_server_answers_well_before_the_page_stops_waiting(self):
        # In a fresh interpreter, loaded the way open_server.py loads it: here PyTorch may already have
        # brought in NumPy with all its threads, which a server never does (see SEARCH_THREADS).
        program = ("import json, sys, time\n"
                   "sys.path.insert(0, sys.argv[1])\n"
                   "import open_server, model_bot\n"
                   "bots = model_bot.Bots(sys.argv[2])\n"
                   "numpy_before = 'numpy' in sys.modules\n"
                   "slowest = 0.0\n"
                   "for record, seat in json.load(sys.stdin):\n"
                   "    started = time.perf_counter()\n"
                   "    bots.play('gongzhu', record, seat, 'normal')\n"
                   "    slowest = max(slowest, time.perf_counter() - started)\n"
                   "print(json.dumps({'slowest': slowest, 'numpy_before': numpy_before,\n"
                   "                  'threads': [model_bot.os.environ[n] for n in model_bot.SEARCH_THREADS]}))\n")
        env = {name: value for name, value in os.environ.items() if name not in model_bot.SEARCH_THREADS}
        run = subprocess.run([sys.executable, "-c", program, str(ROOT), str(self.folder)], env=env,
                             input=json.dumps(list(self.questions())), capture_output=True, text=True, timeout=300)
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertFalse(result["numpy_before"])
        self.assertEqual(result["threads"], ["1"] * len(model_bot.SEARCH_THREADS))
        self.assertLess(result["slowest"], self.wait / 2, "the page stops waiting after WAIT_MS")

    def test_the_three_shipped_gongzhu_models_all_answer(self):
        names = [path.name for path in self.shipped]
        self.assertEqual(names, ["model_20261122.pt", "model_20261123_a.pt", "model_20261123_b.pt"])
        bots = model_bot.Bots(ROOT / "train_out")
        info = bots.info("gongzhu")
        self.assertIsNone(info["why"])
        self.assertEqual([model["name"] for model in info["models"]], ["20261123_b", "20261123_a", "20261122"])
        self.assertEqual(info["model"]["name"], "20261123_b", "the newest is the one a plain 'model' means")
        self.assertEqual([("search" in model) for model in info["models"]], [True, True, False])
        question, seat = next(self.questions())
        for model in info["models"]:
            answer = bots.play("gongzhu", question, seat, "normal", model["name"])
            self.assertEqual(answer["model"], model["id"])
            _, _, mask, _ = GAME.upcoming(dict(question, status="unfinished"))
            self.assertTrue(mask[GAME.card(answer["play"]["card"])])

    def test_rounds_under_other_rules_are_left_to_the_page(self):
        classic = made.rounds(1, seed=3)[0]
        with self.assertRaisesRegex(model_bot.Refused, "個人特殊規則"):
            self.bots.play("gongzhu", asked(classic, 5), None, "normal")

    def test_without_numpy_or_a_compiler_the_reason_is_shown(self):
        with unittest.mock.patch.dict(sys.modules, {"gongzhu_search.serving": None}):
            info = model_bot.Bots(self.folder).info("gongzhu")
        self.assertIsNone(info["model"])
        self.assertIn("拱豬搜尋引擎無法載入", info["why"])


@unittest.skipUnless(made.HAVE_TORCH, "needs PyTorch")
class AgainstPyTorch(unittest.TestCase):
    def test_a_freshly_trained_model_reads_and_scores_the_same_without_pytorch(self):
        import torch
        with tempfile.TemporaryDirectory() as folder:
            data, out = Path(folder) / "data", Path(folder) / "out"
            made.store(data, made.rounds(40))
            code, text = made.run("gongzhu", "--cpu", "--data-dir", data, "--out-dir", out,
                                  "--width", "16", "--depth", "2", "--batch-size", "64", "--epochs", "6")
            self.assertEqual(code, 0, text)
            path = out / "gongzhu" / "model.pt"
            model, saved = train_gpu.load_model(path)
            plain = model_bot.read_model(path)
            self.assertEqual({k: v for k, v in plain.items() if k != "state"}, {k: v for k, v in saved.items() if k != "state"})
            self.assertEqual(list(plain["state"]), list(saved["state"]))
            self.assertEqual(digest(plain["state"]), digest(saved["state"]))
            policy = model_bot.Policy(plain)
            for record in made.rounds(3, seed=23):
                for _, _, [(x, mask, _)] in GAME.decisions(record):
                    with torch.no_grad():
                        theirs = model(torch.tensor([list(x)], dtype=torch.uint8), torch.tensor([list(mask)], dtype=torch.bool))[0]
                    ours = policy.scores(x, mask)
                    self.assertEqual(sorted(ours), [action for action, allowed in enumerate(mask) if allowed])
                    for action, score in ours.items():
                        self.assertAlmostEqual(score, theirs[action].item(), delta=1e-4)

    def test_the_little_model_kept_with_the_tests_still_matches_pytorch(self):
        self.assertEqual(scores_by_pytorch(MODEL, expected()["rounds"])[0], expected()["arrays"])


def scores_by_pytorch(path, records):
    """(digest of the arrays, the scores of every decision of every round) straight from PyTorch."""
    import torch
    model, saved = train_gpu.load_model(path)
    scores = []
    for record in records:
        scores.append([])
        for _, _, [(x, mask, _)] in GAME.decisions(record):
            with torch.no_grad():
                row = model(torch.tensor([list(x)], dtype=torch.uint8), torch.tensor([list(mask)], dtype=torch.bool))[0]
            scores[-1].append({str(action): row[action].item() for action, allowed in enumerate(mask) if allowed})
    return digest(saved["state"]), scores


@unittest.skipUnless(PAGE_REQUESTS, "run through node --test tests/model-bot.test.cjs")
class PageRequests(unittest.TestCase):
    """What the real Gong Zhu page asks (handed over by tests/model-bot.test.cjs) is what the server answers."""

    def test_every_question_of_the_page_gets_a_card_that_seat_may_play(self):
        requests = json.loads(Path(PAGE_REQUESTS).read_text(encoding="utf-8"))
        self.assertGreater(len(requests), 30)
        bots = model_bot.Bots(FIXTURE)
        modes = set()
        for request in requests:
            answer = bots.play("gongzhu", request["record"], request["seat"], request["mode"])
            seat, x, mask, entry = GAME.upcoming(dict(request["record"], status="unfinished"))
            self.assertEqual((answer["play"]["seat"], answer["mode"]), (request["seat"], request["mode"]))
            self.assertEqual(seat, request["seat"])
            self.assertTrue(mask[GAME.card(answer["play"]["card"])], f"{answer['play']} is not allowed")
            self.assertTrue(request["record"]["players"][seat]["ai"], "only the computers ask")
            modes.add(request["mode"])
        self.assertEqual(modes, {"normal", "weak"})


def write_fixture():
    """Trains the little model the tests keep, and notes what PyTorch makes of it."""
    if not made.HAVE_TORCH:
        sys.exit("這要在裝了 PyTorch 的電腦上執行。")
    import torch
    with tempfile.TemporaryDirectory() as folder:
        data, out = Path(folder) / "data", Path(folder) / "out"
        made.store(data, made.rounds(40))
        code, text = made.run("gongzhu", "--cpu", "--data-dir", data, "--out-dir", out,
                              "--width", "8", "--depth", "1", "--batch-size", "64", "--epochs", "40")
        if code:
            sys.exit(text)
        MODEL.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out / "gongzhu" / "model.pt", MODEL)
    records = made.rounds(3, seed=99, first=900)
    arrays, scores = scores_by_pytorch(MODEL, records)
    EXPECTED.write_text(json.dumps({
        "about": "what PyTorch makes of model.pt here; rewritten by tests/test_model_bot.py --write-fixture",
        "torch": str(torch.__version__), "encoder": train_gpu.encoder_of(GAME), "arrays": arrays,
        "rounds": records, "scores": scores}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"寫好了：{MODEL}（{MODEL.stat().st_size} bytes）、{EXPECTED}（{EXPECTED.stat().st_size} bytes）")


if __name__ == "__main__":
    if sys.argv[1:] == ["--write-fixture"]:
        write_fixture()
    else:
        unittest.main()
