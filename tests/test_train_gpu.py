"""train_gpu.py 的測試：python3 tests/test_train_gpu.py

紀錄和模型都放在暫存資料夾，不會碰到正式的 gaming_data/ 和 train_out/。
訓練的部分要有 PyTorch 才會跑（用 CPU，不需要 GPU）；沒裝的話只測讀紀錄的部分。
PageRecords 那一組讀的是真的遊戲頁面打出來的紀錄，由 node --test tests/records.test.cjs 打幾局之後
用 TRAIN_GPU_RECORDS 帶進來；單獨執行這個檔案時會跳過。
"""

import contextlib
import csv
import importlib.util
import io
import json
import os
import random
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import train_gpu  # noqa: E402

SCRIPT = str(ROOT / "train_gpu.py")
HAVE_TORCH = importlib.util.find_spec("torch") is not None
PAGE_RECORDS = os.environ.get("TRAIN_GPU_RECORDS")
SEATS = ["south", "east", "north", "west"]
SMALL = ["--width", "32", "--depth", "1", "--batch-size", "64"]      # a model small enough to train in a second


def rank(card):
    return int(card[1:])


def gongzhu_round(rng, number, habit=True, hint_every=0):
    """One legal round of Gong Zhu as the server stores it. The player (south) always plays the lowest
    card allowed when `habit` is set, so there is something to learn; the other three play at random."""
    deck = [suit + str(n) for suit in "SHCD" for n in range(2, 15)]
    rng.shuffle(deck)
    hands = {seat: deck[i * 13:(i + 1) * 13] for i, seat in enumerate(SEATS)}
    left = {seat: list(cards) for seat, cards in hands.items()}
    leader = next(seat for seat in SEATS if "C2" in left[seat])
    tricks, captured = [], {seat: [] for seat in SEATS}
    for number_of_trick in range(13):
        trick = []
        for turn in range(4):
            seat = SEATS[(SEATS.index(leader) + turn) % 4]
            if not trick:
                legal = ["C2"] if number_of_trick == 0 else list(left[seat])
            else:
                legal = [card for card in left[seat] if card[0] == trick[0]["card"][0]] or list(left[seat])
            if seat == "south" and habit:
                card = min(legal, key=lambda c: (rank(c), "SHCD".index(c[0])))
            else:
                card = rng.choice(legal)
            left[seat].remove(card)
            play = {"seat": seat, "card": card}
            if seat == "south" and hint_every and (number_of_trick + 1) % hint_every == 0:
                play["hint"] = True
            trick.append(play)
        winner = max((p for p in trick if p["card"][0] == trick[0]["card"][0]), key=lambda p: rank(p["card"]))["seat"]
        captured[winner] += [p["card"] for p in trick if p["card"][0] == "H" or p["card"] in ("S12", "D11", "C10")]
        leader = winner
        tricks.append(trick)
    name = f"20261101-{number:06d}-test{number % 100:02d}"
    return {
        "game": "gongzhu", "id": name, "status": "finished", "started": "2026-11-01T10:00:00+08:00",
        "ended": "2026-11-01T10:02:00+08:00", "saved": "2026-11-01T10:02:01+08:00",
        "ip": "100.64.0.9" if number % 7 == 0 else "100.64.0.1", "ua": "unittest", "seq": 1, "session": "s", "build": "0" * 40,
        "round": number, "settings": {"scoringRuleMode": "classic"}, "seats": SEATS,
        "players": {seat: {"name": seat, "ai": seat != "south"} for seat in SEATS},
        "hands": hands, "totals": {seat: 0 for seat in SEATS}, "tricks": tricks,
        "result": {seat: {"score": 0, "formula": "", "captured": captured[seat]} for seat in SEATS},
    }


def store(folder, records):
    for record in records:
        path = Path(folder) / record["game"] / "2026-11" / f"{record['id']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")


def rounds(count, seed=7, first=1, **how):
    rng = random.Random(seed)
    return [gongzhu_round(rng, first + i, **how) for i in range(count)]


def dataset(records, game=None, **config):
    game = game or train_gpu.GAMES[records[0]["game"]]()
    return train_gpu.Dataset(game, records, [], dict(train_gpu.OPTIONS, **config))


def run(*args):
    """Runs train_gpu.py's main() in this process: (exit code, what it printed)."""
    printed, argv, stdin = io.StringIO(), sys.argv, sys.stdin
    sys.argv = ["train_gpu.py", *map(str, args)]
    sys.stdin = io.StringIO()       # not a terminal, even when the tests themselves are started from one
    try:
        with contextlib.redirect_stdout(printed):
            code = train_gpu.main()
    finally:
        sys.argv, sys.stdin = argv, stdin
    return code, printed.getvalue()


class Window:
    """train_gpu.py started in a terminal of its own (a pseudo-terminal), to read its screen and press its keys."""

    def __init__(self, command, env=None):
        import pty
        self.screen, self.read_to = "", 0
        self.pid, self.terminal = pty.fork()
        if self.pid == 0:
            os.execve(command[0], [str(word) for word in command],
                      {**os.environ, "PYTHONIOENCODING": "utf-8", **(env or {})})

    def more(self, wait=0.2):
        """Reads what has been printed meanwhile; False once the program has ended and all of it was read."""
        if select.select([self.terminal], [], [], wait)[0]:
            try:
                chunk = os.read(self.terminal, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                return False
            self.screen += chunk.decode("utf-8", "replace")
        return True

    def see(self, text, limit=120):
        """Waits for `text` to show up after everything looked at so far."""
        deadline = time.monotonic() + limit
        while text not in self.screen[self.read_to:]:
            if time.monotonic() > deadline or not self.more():
                raise AssertionError(f"the window never showed {text!r}:\n{self.screen}")
        self.read_to = self.screen.index(text, self.read_to) + len(text)

    def press(self, key):
        os.write(self.terminal, key)

    def echoes(self):
        """Whether the terminal shows what is typed, as a shell expects to find it."""
        import termios
        return bool(termios.tcgetattr(self.terminal)[3] & termios.ECHO)

    def ended(self, limit=120):
        """Waits for the program to end; its exit code."""
        deadline = time.monotonic() + limit
        while self.more():
            if time.monotonic() > deadline:
                raise AssertionError(f"the program does not end:\n{self.screen}")
        return os.waitstatus_to_exitcode(os.waitpid(self.pid, 0)[1])

    def close(self):
        try:
            os.killpg(self.pid, signal.SIGKILL)     # the program and the training it started
            os.waitpid(self.pid, 0)
        except OSError:
            pass
        os.close(self.terminal)


# ---------- a second deal that looks the same to the player: what they cannot see is moved around ----------

def gongzhu_twin(record, cut, rng):
    """The round cut off after its first `cut` plays, with the cards the other three still hold dealt
    among them differently (never a suit one of them has shown to be out of). None if nothing can move."""
    seats = record["seats"]
    plays = [play for trick in record["tricks"] for play in trick][:cut]
    played = {seat: [p["card"] for p in plays if p["seat"] == seat] for seat in seats}
    me = plays[-1]["seat"]
    out_of = {seat: set() for seat in seats}
    for start in range(0, len(plays), 4):
        for play in plays[start + 1:start + 4]:
            if play["card"][0] != plays[start]["card"][0]:
                out_of[play["seat"]].add(plays[start]["card"][0])
    others = [seat for seat in seats if seat != me]
    remaining = {seat: [c for c in record["hands"][seat] if c not in played[seat]] for seat in seats}
    pool = [card for seat in others for card in remaining[seat]]
    opener = plays[0]["seat"]
    seven_is_public = record["settings"]["scoringRuleMode"] == "player_special" and "S7" in pool
    for _ in range(300):
        rng.shuffle(pool)
        dealt, at = {}, 0
        for seat in others:
            dealt[seat] = pool[at:at + len(remaining[seat])]
            at += len(remaining[seat])
        if seven_is_public and "S7" not in dealt[opener]:
            continue
        if all(card[0] not in out_of[seat] for seat in others for card in dealt[seat]) \
                and any(set(dealt[seat]) != set(remaining[seat]) for seat in others):
            twin = json.loads(json.dumps(record))
            twin.update(status="unfinished", result=None, tricks=[plays[i:i + 4] for i in range(0, len(plays), 4)])
            for seat in others:
                twin["hands"][seat] = played[seat] + dealt[seat]
            return twin
    return None


def bigtwo_twin(record, rng):
    """Two of the other players swap a card neither of them ever played."""
    played = {name for action in record["actions"] for name in action.get("cards", [])}
    left = {seat: [c for c in hand if c not in played] for seat, hand in enumerate(record["hands"])}
    holders = [seat for seat in (1, 2, 3) if left[seat]]
    if len(holders) < 2:
        return None
    a, b = rng.sample(holders, 2)
    one, two = rng.choice(left[a]), rng.choice(left[b])
    twin = json.loads(json.dumps(record))
    swap = {one: two, two: one}
    for seat in (a, b):
        twin["hands"][seat] = [swap.get(c, c) for c in twin["hands"][seat]]
        if twin.get("result"):
            twin["result"]["left"][seat] = [swap.get(c, c) for c in twin["result"]["left"][seat]]
    return twin


def mahjong_twin(record, rng):
    """Two tiles nobody ever showed swap places in the wall: one in another player's hand, and one in a
    third player's hand or still in the wall. Everything the player saw stays as it was."""
    wall, dealer = record["wall"], record["dealer"]
    held = [[] for _ in range(4)]       # per seat: (tile, where in the wall it came from)
    head, tail = 0, len(wall) - 1
    for _ in range(4):
        for k in range(4):
            for _ in range(4):
                held[(dealer + k) % 4].append((wall[head], head))
                head += 1
    drawn = {}      # where in the wall -> which action drew it

    def drop(seat, tile, times=1):
        for _ in range(times):
            held[seat].remove(next(pair for pair in held[seat] if pair[0] == tile))

    for index, e in enumerate(record["actions"]):
        seat, kind, tile = e["s"], e["a"], e["t"]
        if kind == "draw":
            at = tail if e.get("back") else head
            tail, head = (tail - 1, head) if e.get("back") else (tail, head + 1)
            held[seat].append((tile, at))
            drawn[at] = index
        elif kind in ("flower", "discard", "addedKong"):
            drop(seat, tile)
        elif kind == "concealedKong":
            drop(seat, tile, 4)
        elif kind == "chow":
            for used in e["using"]:
                drop(seat, used)
        elif kind in ("pung", "kong"):
            drop(seat, tile, 2 if kind == "pung" else 3)
    result = record.get("result")
    winners = {w["seat"] for w in result["winners"]} if result else set()
    hidden = [(seat, tile, at) for seat in (1, 2, 3) if seat not in winners for tile, at in held[seat]]
    hidden += [(None, wall[at], at) for at in range(head, tail + 1) if wall[at] < 34]
    for _ in range(100):
        (seat_a, tile_a, at_a), (seat_b, tile_b, at_b) = rng.sample(hidden, 2)
        if tile_a == tile_b or seat_a == seat_b or seat_a is None:
            continue
        twin = json.loads(json.dumps(record))
        twin["wall"][at_a], twin["wall"][at_b] = tile_b, tile_a
        for at, tile in ((at_a, tile_b), (at_b, tile_a)):
            if at in drawn:
                twin["actions"][drawn[at]]["t"] = tile
        for seat, old, new in ((seat_a, tile_a, tile_b), (seat_b, tile_b, tile_a)):
            if seat is not None:
                hand = twin["players"][seat]["hand"]
                hand[hand.index(old)] = new
        twin["dealt"] = [[] for _ in range(4)]
        for at in range(64):
            twin["dealt"][(dealer + at // 4 % 4) % 4].append(twin["wall"][at])
        return twin
    return None


def field(game, x, name):
    start, count = game.fields[name]
    return list(x[start:start + count])


def of_player(game, record):
    """What the trainer makes of the player's own decisions in this round."""
    return [(bytes(x), bytes(mask), y) for human, _, steps in game.decisions(record) if human for x, mask, y in steps]


class ReadingRecords(unittest.TestCase):
    def test_every_play_of_a_round_becomes_a_decision_and_only_the_players_are_learnt(self):
        records = rounds(12)
        data = dataset(records)
        self.assertEqual((data.total, data.skipped), (12, []))
        self.assertEqual((data.human, data.computer), (12 * 13, 12 * 39))
        self.assertEqual(sum(data.decisions) + data.forced, 12 * 13)       # nothing but the player's, minus forced plays
        self.assertGreater(data.forced, 0)
        game = data.game
        for part in (0, 1):
            for x, mask, y in zip(data.x[part], data.mask[part], data.y[part]):
                self.assertEqual((len(x), len(mask)), (game.size, game.actions))
                self.assertEqual(mask[y], 1, "the card played is among the cards allowed")
                self.assertGreater(sum(mask), 1)
                self.assertEqual(x[game.HAND + y], 1, "and was in the hand")
        everyone = dataset(records, players="all")
        self.assertEqual(sum(everyone.decisions) + everyone.forced, 12 * 52)

    def test_the_cards_other_players_hold_never_reach_the_features(self):
        game, rng, compared = train_gpu.GongZhu(), random.Random(3), 0
        for record in rounds(6, seed=11):
            plays = [play for trick in record["tricks"] for play in trick]
            for cut in range(2, 52):
                if plays[cut - 1]["seat"] != "south":
                    continue
                twin = gongzhu_twin(record, cut, rng)
                if twin is None:
                    continue
                self.assertNotEqual(twin["hands"], record["hands"])
                seen = list(game.decisions(record))[cut - 1]
                same = list(game.decisions(twin))[cut - 1]
                self.assertEqual(seen[2][0][2], same[2][0][2])
                self.assertEqual(bytes(seen[2][0][0]), bytes(same[2][0][0]), f"round {record['id']}, play {cut}")
                self.assertEqual(bytes(seen[2][0][1]), bytes(same[2][0][1]))
                compared += 1
        self.assertGreater(compared, 40)

    def test_a_round_that_does_not_add_up_is_left_out_with_its_reason(self):
        good = rounds(4)
        wrong_card, wrong_order, short, alien = (json.loads(json.dumps(r)) for r in rounds(4, seed=9, first=50))
        play = wrong_card["tricks"][5][2]
        play["card"] = next(c for c in wrong_card["hands"]["south"] if c not in [p["card"] for p in wrong_card["tricks"][5]]
                            and all(c != p["card"] for t in wrong_card["tricks"] for p in t if p["seat"] == play["seat"]))
        wrong_order["tricks"][3].reverse()
        del short["hands"]["west"][0]
        alien["game"] = "bigtwo"
        data = dataset(good + [wrong_card, wrong_order, short, alien, {"id": "x", "game": "gongzhu", "status": "finished"}])
        self.assertEqual(data.total, 9)
        self.assertEqual(sorted(name for name, _ in data.skipped),
                         sorted([wrong_card["id"], wrong_order["id"], short["id"], alien["id"], "x"]))
        self.assertEqual(sum(data.rounds), 4, "the good rounds are still used")
        for name, why in data.skipped:
            self.assertTrue(why, name)

    def test_hinted_plays_are_left_out_unless_asked_for(self):
        records = rounds(6, hint_every=4)       # the 4th, 8th and 12th trick of every round
        plain, with_hints = dataset(records), dataset(records, with_hints=True)
        self.assertEqual(plain.marked, 6 * 3)
        self.assertEqual(with_hints.marked, 0)
        self.assertGreater(sum(with_hints.decisions), sum(plain.decisions))

    def test_only_the_chosen_devices_when_asked(self):
        records = rounds(21)        # every 7th round comes from another device
        one = dataset(records, ip=["100.64.0.9"])
        self.assertEqual((sum(one.rounds), one.other_devices), (3, 18))
        self.assertEqual(sum(dataset(records).rounds), 21)

    def test_a_round_stays_on_its_side_when_more_rounds_arrive(self):
        first, more = rounds(40), rounds(40, seed=8, first=1000)
        before, after = dataset(first), dataset(first + more)
        self.assertGreater(before.rounds[1], 0)
        self.assertGreater(before.rounds[0], before.rounds[1])
        self.assertNotEqual(before.fingerprint, after.fingerprint)
        self.assertEqual(before.fingerprint, dataset(list(reversed(first))[::-1]).fingerprint)
        kept = set(before.x[1])
        self.assertTrue(kept <= set(after.x[1]), "validation rounds are still validation rounds")
        self.assertFalse(kept & set(after.x[0]))

    def test_what_gongzhu_tells_about_each_card_in_hand(self):
        game = train_gpu.GongZhu()
        card, level = game.card, train_gpu.level
        hand = {card("S3"), card("S9"), card("H2")}
        table = [(2, card("S5")), (3, card("H14"))]         # spades led; the next player threw away the ace of hearts
        played = [set(), {card("S2")}, set(), {card("S4")}]
        void = [[False] * 4 for _ in range(4)]
        void[3][0] = True
        x = game.view(0, hand, table, played, [set() for _ in range(4)], void, [1, 0, 0, 0], 4, [0, 40, -40, 0], "classic")

        def each(name):
            return {c: x[game.each[name] + c] for c in hand}

        s3, s9, h2 = card("S3"), card("S9"), card("H2")
        self.assertEqual(field(game, x, "lead"), [1, 0, 0, 0, 0])
        self.assertEqual(field(game, x, "winning")[:3], [0, 1, 0], "the five of spades is winning, not the bigger heart")
        self.assertEqual(field(game, x, "winning")[3:].index(1), 3)
        self.assertEqual((each("win"), each("duck"), each("off")),
                         ({s3: 0, s9: 1, h2: 0}, {s3: 1, s9: 0, h2: 0}, {s3: 0, s9: 0, h2: 1}))
        self.assertEqual((each("lowest"), each("highest")), ({s3: 1, s9: 0, h2: 1}, {s3: 0, s9: 1, h2: 1}))
        self.assertEqual(each("boss"), {s3: 0, s9: 0, h2: 0})
        self.assertEqual(each("bottom"), {s3: 1, s9: 0, h2: 1}, "the two and four of spades are gone")
        self.assertEqual(each("higher"), {s3: level(8, 0, 12), s9: level(5, 0, 12), h2: level(11, 0, 12)})
        self.assertEqual(each("lower"), {s3: 0, s9: level(3, 0, 12), h2: 0})
        self.assertEqual(each("length"), {s3: level(2, 0, 13), s9: level(2, 0, 13), h2: level(1, 0, 13)})
        self.assertEqual(each("voids"), {s3: level(1, 0, 3), s9: level(1, 0, 3), h2: 0})
        self.assertEqual(each("led"), {s3: level(1, 0, 4), s9: level(1, 0, 4), h2: 0})
        self.assertEqual(field(game, x, "special"), [0, 0, 0, 1, 1, 1, 1, 0], "a heart on the table; pig, sheep and transformer still out")
        self.assertEqual(field(game, x, "void"), [0] * 8 + [1, 0, 0, 0])
        self.assertEqual(field(game, x, "trick").index(1), 4)
        self.assertEqual(field(game, x, "totals"), [level(0, -1500, 1500), level(40, -1500, 1500), level(-40, -1500, 1500), level(0, -1500, 1500)])
        self.assertEqual(game.about(card("S12"))[17:], [True, False, False, 0])
        self.assertEqual(game.about(card("H14"))[17:], [False, False, False, 1.0])
        penalties = [2, 3, 10, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50]
        self.assertEqual([game.about(card(f"H{rank}"))[20] for rank in range(2, 15)], [p / 50 for p in penalties])
        self.assertEqual((field(game, x, "hearts"), field(game, x, "sweep"), field(game, x, "big")), ([0] * 4, [0] * 4, [0] * 12))
        self.assertEqual((each("keeps"), each("splits")), ({s3: 0, s9: 0, h2: 0}, {s3: 0, s9: 0, h2: 0}), "nobody is collecting hearts")

    def test_gongzhu_tells_who_is_collecting_the_hearts_and_what_each_card_would_do_about_it(self):
        # The player plays differently once one opponent holds every heart taken so far (throws fewer hearts on
        # that player's tricks, takes more heart tricks). Training mostly hides the card-by-card "taken" field,
        # so the model is told plainly who is collecting, and for each card where the hearts of this trick would go.
        game = train_gpu.GongZhu()
        card, level = game.card, train_gpu.level
        nobody = [set() for _ in range(4)]

        def scoring(*names):
            return {game.SCORING[card(name)] for name in names}

        def view(me, hand, table, taken):
            return game.view(me, {card(c) for c in hand}, [(seat, card(c)) for seat, c in table], nobody, taken,
                             [[False] * 4 for _ in range(4)], [0, 0, 0, 0], 6, [0, 0, 0, 0], "classic")

        def marks(x, hand):
            return {c: "keeps" * x[game.each["keeps"] + card(c)] + "splits" * x[game.each["splits"] + card(c)] for c in hand}

        # seat 2 has taken every heart so far (five of them) and the pig; seat 1 has the sheep
        taken = [set(), scoring("D11"), scoring("H13", "H12", "H6", "H4", "H2", "S12"), set()]
        hand = ["H9", "S3"]
        x = view(0, hand, [(2, "C13"), (3, "C3")], taken)       # clubs led, seat 2 is winning, the player has none
        self.assertEqual(field(game, x, "hearts"), [0, 0, level(5, 0, 13), 0], "self, next, opposite, previous")
        self.assertEqual(field(game, x, "sweep"), [0, 0, 1, 0])
        self.assertEqual(field(game, x, "big"), [0, 0, 0,  0, 1, 0,  1, 0, 0,  0, 0, 0])
        self.assertEqual(marks(x, hand), {"H9": "keeps", "S3": ""}, "a heart thrown now goes to the collector")
        x = view(0, hand, [(2, "C3"), (3, "C13")], taken)       # ... but seat 3 is winning
        self.assertEqual(marks(x, hand), {"H9": "splits", "S3": ""}, "thrown on somebody else it breaks the collection")
        hand = ["C14", "C4", "S3"]
        x = view(0, hand, [(1, "C5"), (2, "C13"), (3, "H7")], taken)       # seat 3 has thrown a heart on the collector's king
        self.assertEqual(marks(x, hand), {"C14": "splits", "C4": "keeps", "S3": "keeps"},
                         "with a heart in the trick already, only taking the trick keeps it from the collector")
        hand = ["H9", "S3"]

        x = view(3, hand, [(2, "C13")], taken)                  # the same table seen by seat 3
        self.assertEqual(field(game, x, "sweep"), [0, 0, 0, 1], "seat 2 plays just before seat 3")
        self.assertEqual(field(game, x, "hearts"), [0, 0, 0, level(5, 0, 13)])
        self.assertEqual(field(game, x, "big"), [0, 0, 0,  0, 0, 0,  0, 1, 0,  1, 0, 0])

        hand = ["H11", "H3", "S3"]
        x = view(0, hand, [(2, "H10")], taken)                  # the collector leads a heart
        self.assertEqual(marks(x, hand), {"H11": "splits", "H3": "keeps", "S3": "keeps"}, "taking the trick stops it, ducking does not")

        hand = ["H14", "H5", "S3"]                              # leading: only a card nothing can beat is sure to take its trick
        x = view(0, hand, [], taken)
        self.assertEqual(marks(x, hand), {"H14": "splits", "H5": "", "S3": ""})
        mine = [scoring("H13", "H12", "H6"), set(), set(), set()]
        x = view(0, hand, [], mine)
        self.assertEqual(field(game, x, "sweep"), [1, 0, 0, 0])
        self.assertEqual(marks(x, hand), {"H14": "keeps", "H5": "", "S3": ""}, "collecting oneself, the same lead keeps it going")
        x = view(0, hand, [(2, "H10")], mine)
        self.assertEqual(marks(x, hand), {"H14": "keeps", "H5": "splits", "S3": "splits"})

        split = [scoring("H3"), set(), scoring("H13", "H12", "H6", "H4", "H2"), set()]
        x = view(0, ["H9", "S3"], [(2, "C13"), (3, "C3")], split)
        self.assertEqual(field(game, x, "hearts"), [level(1, 0, 13), 0, level(5, 0, 13), 0])
        self.assertEqual(field(game, x, "sweep"), [0, 0, 0, 0], "the hearts are split already")
        self.assertEqual(marks(x, ["H9", "S3"]), {"H9": "", "S3": ""})
        x = view(0, ["H9", "S3"], [(2, "C13"), (3, "C3")], nobody)
        self.assertEqual((field(game, x, "hearts"), field(game, x, "sweep")), ([0] * 4, [0] * 4), "no heart has been taken yet")
        self.assertEqual(marks(x, ["H9", "S3"]), {"H9": "", "S3": ""})

        for name in ("hearts", "sweep", "big"):                 # told plainly; "taken" stays among the mostly hidden details
            start, count = game.fields[name]
            self.assertFalse(any(game.detail[start:start + count]), name)
        start, count = game.fields["taken"]
        self.assertTrue(all(game.detail[start:start + count]))

    def test_a_concealed_kong_shows_its_tiles_only_to_its_owner(self):
        game = train_gpu.Mahjong()
        record = {"dealer": 0, "roundWind": 0, "dealerStreak": 0, "players": [{"wind": seat, "score": 0} for seat in range(4)]}

        def seen(owner, tile):
            hands = [[1, 2, 3, 9, 10, 11, 18, 19, 20, 27, 27, 28, 28] for _ in range(4)]
            melds = [[] for _ in range(4)]
            melds[owner] = [{"type": "kong", "tiles": [tile] * 4, "concealed": True}]
            empty = [[] for _ in range(4)]
            return bytes(game.view(0, record, hands, melds, empty, empty, [None] * 4, 0, 1, None, 40, 3))

        self.assertEqual(seen(1, 5), seen(1, 14), "another player's concealed kong is face down")
        self.assertNotEqual(seen(0, 5), seen(0, 14), "one's own is known")
        self.assertNotEqual(seen(1, 5), seen(2, 5), "who has one is plain to see")

    def test_gongzhu_and_bigtwo_allow_what_the_rules_allow(self):
        game = train_gpu.GongZhu()
        card = game.card
        hand = {card("S7"), card("S12"), card("H3"), card("C2")}
        self.assertEqual(game.legal(hand, [], 0), hand, "the seven of spades holder can lead any card")
        self.assertEqual(game.legal(hand, [], 0, "classic"), {card("C2")}, "older recordings open with the two of clubs")
        self.assertEqual(game.legal(hand, [], 3), hand)
        self.assertEqual(game.legal(hand, [(1, card("S9"))], 3), {card("S7"), card("S12")}, "follow suit")
        self.assertEqual(game.legal(hand, [(1, card("D9"))], 3), hand, "anything when out of the suit")

        game = train_gpu.BigTwo()
        hand = {game.card(name) for name in ("C3", "D3", "H7", "S7", "CK", "S2")}
        pair = (2, sorted([game.card("C5"), game.card("D5")]), "pair")
        self.assertEqual(game.legal(hand, [], None, True), {0}, "the first play of a round starts with the three of clubs")
        self.assertEqual(game.legal(hand, [], None, False), hand, "leading: some card must be picked")
        self.assertEqual(game.legal(hand, [], pair, False), hand | {game.END}, "over a play one may pass")
        first = game.card("H7")
        self.assertEqual(game.legal(hand, [first], pair, False), {c for c in hand if c > first}, "a single cannot answer a pair")
        self.assertIn(game.END, game.legal(hand, [first, game.card("S7")], pair, False))
        self.assertIn(game.END, game.legal(hand, [first], None, False))

    def test_mahjong_offers_the_claims_the_table_would(self):
        game = train_gpu.Mahjong()
        hand = [0, 1, 3, 4, 4, 4, 9, 9, 27, 27, 27, 27, 30, 31, 32, 33]
        self.assertEqual(game.claim_choices(hand, 0, (3, 2), 10), {game.PASS, game.CHOW, game.CHOW + 1, game.CHOW + 2})
        self.assertEqual(game.claim_choices(hand, 0, (2, 2), 10), {game.PASS}, "only the next player may chow")
        self.assertEqual(game.claim_choices(hand, 0, (2, 9), 10), {game.PASS, game.PUNG})
        self.assertEqual(game.claim_choices(hand, 0, (2, 4), 10), {game.PASS, game.PUNG, game.KONG})
        self.assertEqual(game.claim_choices(hand, 0, (2, 4), 0), {game.PASS, game.PUNG}, "no kong when the wall is spent")
        self.assertEqual(game.claim_choices([7, 8, 9, 10], 0, (3, 9), 10), {game.PASS}, "a run stays within its suit")
        melds = [{"type": "pung", "tiles": [3, 3, 3], "concealed": False}]
        own = game.own_choices(hand, melds, True)
        self.assertEqual(own, set(hand) | {game.CONCEALED + 27, game.ADDED + 3})
        self.assertEqual(game.own_choices(hand, melds, False), set(hand), "no kong right after a claim")

    def test_the_board_games_move_as_their_rules_say(self):
        game = train_gpu.Xiangqi()      # as the player sees it: own pieces 1-7 at the bottom, the other side's 9-15

        def moves(pieces, row, col):
            board = [0] * 90
            for (r, c), piece in pieces.items():
                board[r * 9 + c] = piece
            return {(to // 9, to % 9) for to in game.moves(board, row * 9 + col)}

        theirs = 8
        self.assertEqual(moves({(9, 4): game.KING}, 9, 4), {(8, 4), (9, 3), (9, 5)}, "the king stays in the palace")
        self.assertEqual(moves({(7, 3): game.ADVISOR}, 7, 3), {(8, 4)}, "and so does the advisor")
        self.assertEqual(moves({(9, 2): game.ELEPHANT}, 9, 2), {(7, 0), (7, 4)})
        self.assertEqual(moves({(9, 2): game.ELEPHANT, (8, 3): theirs + game.PAWN}, 9, 2), {(7, 0)}, "a blocked eye")
        self.assertEqual(moves({(5, 2): game.ELEPHANT}, 5, 2), {(7, 0), (7, 4)}, "the elephant does not cross the river")
        self.assertEqual(moves({(9, 1): game.HORSE}, 9, 1), {(7, 0), (7, 2), (8, 3)})
        self.assertEqual(moves({(9, 1): game.HORSE, (8, 1): game.PAWN}, 9, 1), {(8, 3)}, "a hobbled horse")
        rook = moves({(5, 0): game.ROOK, (5, 3): game.PAWN, (2, 0): theirs + game.HORSE}, 5, 0)
        self.assertEqual(rook, {(5, 1), (5, 2), (4, 0), (3, 0), (2, 0), (6, 0), (7, 0), (8, 0), (9, 0)})
        cannon = {(7, 7): game.CANNON, (7, 4): theirs + game.PAWN, (7, 1): theirs + game.ROOK, (9, 7): game.ROOK}
        self.assertEqual({to for to in moves(cannon, 7, 7) if to[0] == 7}, {(7, 5), (7, 6), (7, 8), (7, 1)},
                         "the cannon takes over exactly one piece, never the piece next in line")
        self.assertEqual({to for to in moves(cannon, 7, 7) if to[1] == 7}, {(r, 7) for r in range(9) if r != 7},
                         "and does not take its own")
        self.assertEqual(moves({(6, 0): game.PAWN}, 6, 0), {(5, 0)}, "a pawn on its own side only goes forward")
        self.assertEqual(moves({(4, 8): game.PAWN}, 4, 8), {(3, 8), (4, 7)}, "and sideways too once across the river")

        game = train_gpu.Banqi()
        board = [0] * 32
        red, black = (lambda kind: 1 + kind), (lambda kind: 8 + kind)
        board[9], board[10], board[11], board[12] = red(game.CANNON), black(game.PAWN), game.HIDDEN, black(game.KING)
        board[1], board[17], board[25] = black(6), game.HIDDEN, black(1)
        self.assertEqual(game.moves(board, 9, 0), {8, 25}, "a cannon steps to an empty square or jumps one piece to take")
        board[0], board[8] = red(game.KING), black(game.PAWN)
        self.assertEqual(game.moves(board, 0, 0), set(), "the king cannot take a pawn; the pawn next to it is in the way")
        board[2], board[3] = black(game.KING), red(game.PAWN)
        self.assertEqual(game.moves(board, 3, 0), {2, 4}, "a pawn takes the king")
        board[4] = black(3)
        self.assertEqual(game.moves(board, 3, 0), {2}, "but nothing bigger than itself otherwise")

        game = train_gpu.Reversi()
        board = [0] * 64
        board[27] = board[36] = 2
        board[28] = board[35] = 1
        self.assertEqual({k for k in range(64) if not board[k] and game.flips(board, k, 1)}, {19, 26, 37, 44})
        board[26], board[27] = 1, 1
        board[18] = 2
        self.assertEqual(sorted(game.flips(board, 34, 2)), [26, 35],
                         "runs closed at the far end are turned; the one through 27 runs into an empty square and is not")

    def test_every_game_describes_its_actions(self):
        for slug, kind in train_gpu.GAMES.items():
            game = kind()
            self.assertEqual(game.slug, slug)
            self.assertEqual(len(game.scale), game.size)
            self.assertEqual(len(game.static), game.actions)
            self.assertEqual(len({len(row) for row in game.static}), 1)
            first = min(game.each.values())
            self.assertEqual(first + len(game.EACH) * game.actions, game.size, "the per-action columns come last")


class CommandLine(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.data, self.out = Path(folder.name) / "data", Path(folder.name) / "out"
        store(self.data, rounds(8))
        self.where = ["--data-dir", self.data, "--out-dir", self.out]

    def script(self, *args, **env):
        done = subprocess.run([sys.executable, SCRIPT, *map(str, args)], capture_output=True, text=True,
                              stdin=subprocess.DEVNULL, encoding="utf-8",
                              env={**os.environ, "PYTHONIOENCODING": "utf-8", **env})
        return done.returncode, done.stdout + done.stderr

    def test_a_wrong_name_is_refused_with_a_suggestion(self):
        code, text = run("gongzeg", *self.where)
        self.assertEqual(code, train_gpu.EXIT_USAGE)
        self.assertIn("gongzhu", text)
        self.assertFalse(self.out.exists())

    def test_no_records_is_an_error(self):
        code, text = self.script("mahjong", "--cpu", *self.where) if HAVE_TORCH else (None, "")
        if HAVE_TORCH:
            self.assertEqual(code, train_gpu.EXIT_USAGE)
            self.assertIn("找不到 mahjong 的對局紀錄", text)
            self.assertFalse(self.out.exists())

    @unittest.skipIf(os.name == "nt", "the stand-in for nvidia-smi is a shell script")
    def test_without_pytorch_it_says_what_is_missing(self):
        stub = tempfile.TemporaryDirectory()
        self.addCleanup(stub.cleanup)
        Path(stub.name, "torch.py").write_text("raise ImportError('no torch here')\n", encoding="utf-8")
        tools = Path(stub.name, "bin")
        tools.mkdir()
        code, text = self.script("gongzhu", *self.where, PYTHONPATH=stub.name, PATH=str(tools))    # no nvidia-smi either
        self.assertEqual(code, train_gpu.EXIT_NO_GPU)
        self.assertIn("找不到 NVIDIA GPU", text)
        self.assertIn("沒有安裝 PyTorch", text)
        self.assertNotIn("Traceback", text)

        driver = tools / "nvidia-smi"       # a machine whose driver does report a card
        driver.write_text("#!/bin/sh\necho 'GPU 0: Pretend RTX (UUID: GPU-0000)'\n", encoding="utf-8")
        driver.chmod(0o755)
        code, text = self.script("gongzhu", *self.where, PYTHONPATH=stub.name, PATH=str(tools))
        self.assertEqual(code, train_gpu.EXIT_NO_GPU)
        self.assertNotIn("找不到 NVIDIA GPU", text)
        self.assertIn("沒有安裝 PyTorch", text)
        self.assertIn("Pretend RTX", text)
        self.assertFalse(self.out.exists())

    @unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
    def test_without_an_nvidia_gpu_it_says_so_and_does_nothing(self):
        code, text = self.script("gongzhu", *self.where, CUDA_VISIBLE_DEVICES="")
        self.assertEqual(code, train_gpu.EXIT_NO_GPU)
        self.assertIn("找不到 NVIDIA GPU", text)
        self.assertNotIn("Traceback", text)
        self.assertFalse(self.out.exists(), "nothing is trained on the CPU instead")

    def test_overview_and_status_before_any_training(self):
        code, text = run(*self.where)
        self.assertEqual(code, 0)
        self.assertRegex(text, r"gongzhu\s+8 局")
        self.assertRegex(text, r"mahjong\s+0 局")
        code, text = run("gongzhu", "status", *self.where)
        self.assertEqual(code, 0)
        self.assertIn("還沒有訓練過", text)
        self.assertEqual(run("gongzhu", "pause", *self.where)[0], train_gpu.EXIT_ERROR)
        self.assertFalse(self.out.exists())


class WhatGoesIntoGit(unittest.TestCase):
    def test_the_model_is_shared_and_the_working_files_stay_on_the_machine(self):
        if not shutil.which("git") or not (ROOT / ".git").exists():
            self.skipTest("not a git checkout")

        def ignored(name):
            return subprocess.run(["git", "check-ignore", "-q", f"train_out/gongzhu/{name}"], cwd=ROOT).returncode == 0

        for name in ("model.pt", "log.csv"):
            self.assertFalse(ignored(name), f"{name} is what other people come for")
        for name in ("checkpoint.pt", "checkpoint.broken.pt", "model.previous.pt", "status.json", "error.log",
                     "train.lock", "PAUSE", "model.pt.tmp", "checkpoint.pt.tmp", "status.json.tmp", "log.csv.tmp"):
            self.assertTrue(ignored(name), f"{name} only matters where the training runs")
        self.assertTrue(subprocess.run(["git", "check-ignore", "-q", "gaming_data/gongzhu/2026-11/x.json"], cwd=ROOT).returncode == 0)


@unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
class Training(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.data = Path(cls.folder.name) / "data"
        store(cls.data, rounds(60))

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.out = Path(folder.name)

    def train(self, *args, out=None, data=None):
        return run("gongzhu", "--cpu", "--data-dir", data or self.data, "--out-dir", out or self.out, *SMALL, *args)

    def start(self, *args):
        """A training in a process of its own, to be paused or interrupted from here."""
        process = subprocess.Popen(
            [sys.executable, SCRIPT, "gongzhu", "--cpu", "--data-dir", str(self.data), "--out-dir", str(self.out),
             *SMALL, "--epochs", "1000000", "--patience", "1000000", *args],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.addCleanup(lambda: (process.kill(), process.wait(), process.stdout.close()))
        deadline = time.monotonic() + 120
        while True:     # until this very process is under way (an earlier one may have left its status behind)
            status = self.status() or {}
            if status.get("pid") == process.pid and status.get("step", 0) >= 3:
                return process
            self.assertIsNone(process.poll(), "the training stopped by itself")
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.1)

    def status(self):
        return train_gpu.read_json(self.out / "gongzhu" / "status.json")

    def saved(self, out=None, name="model.pt"):
        import torch
        return torch.load((out or self.out) / "gongzhu" / name, map_location="cpu", weights_only=True)

    def log(self, out=None):
        with open((out or self.out) / "gongzhu" / "log.csv", encoding="utf-8", newline="") as file:
            return [{k: v for k, v in row.items() if k != "seconds"} for row in csv.DictReader(file)]

    def assert_same_model(self, one, two):
        import torch
        a, b = self.saved(one), self.saved(two)
        self.assertEqual(sorted(a["state"]), sorted(b["state"]))
        for name in a["state"]:
            self.assertTrue(torch.equal(a["state"][name], b["state"][name]), f"{name} differs")
        self.assertEqual(a["result"], b["result"])
        self.assertEqual(self.log(one), self.log(two))

    def test_it_learns_the_players_habit_and_writes_a_model_that_can_be_read_back(self):
        code, text = self.train("--epochs", "60")
        self.assertEqual(code, 0, text)
        self.assertIn("訓練完成", text)
        folder = self.out / "gongzhu"
        self.assertEqual(sorted(p.name for p in folder.iterdir()),
                         ["checkpoint.pt", "log.csv", "model.pt", "status.json", "train.lock"])
        shared = json.dumps({k: v for k, v in train_gpu.load_model(folder / "model.pt")[1].items() if k != "state"},
                            ensure_ascii=False) + (folder / "log.csv").read_text(encoding="utf-8")
        self.assertNotIn(str(self.out), shared, "nothing about this machine in what gets shared")
        self.assertNotIn("100.64", shared)
        status = self.status()
        self.assertEqual(status["state"], "finished")
        self.assertGreater(status["best"]["val_acc"], 0.8, "always playing the lowest card is easy to pick up")
        self.assertLess(status["data"]["chance"], 0.4)

        import torch
        model, saved = train_gpu.load_model(folder / "model.pt")
        self.assertTrue(saved["result"]["finished"])
        self.assertEqual(saved["game"], "gongzhu")
        self.assertNotIn("100.64", json.dumps(saved["config"]) + json.dumps(saved["data"]))
        data = dataset([json.loads(p.read_text(encoding="utf-8")) for p in sorted(self.data.rglob("*.json"))])
        x, mask, y, _ = data.tensors(torch, "cpu")[1]
        with torch.no_grad():
            scores = model(x, mask)
        self.assertTrue(bool(mask.gather(1, scores.argmax(1, keepdim=True)).all()), "it only ever picks an allowed card")
        self.assertLess(scores[~mask].max().item(), scores[mask].min().item(), "whatever is not allowed scores below all that is")
        self.assertAlmostEqual((scores.argmax(1) == y).float().mean().item(), saved["result"]["validation_accuracy"], places=5)

    def test_the_model_that_gets_shared_does_not_name_the_devices(self):
        code, text = self.train("--epochs", "2", "--ip", "100.64.0.1")
        self.assertEqual(code, 0, text)
        folder = self.out / "gongzhu"
        about = {k: v for k, v in train_gpu.load_model(folder / "model.pt")[1].items() if k != "state"}
        self.assertEqual(about["config"]["ip"], 1, "only how many devices were picked")
        self.assertNotIn("100.64", json.dumps(about, ensure_ascii=False) + (folder / "log.csv").read_text(encoding="utf-8"))
        self.assertIn("100.64.0.1", (folder / "status.json").read_text(encoding="utf-8"), "which is why that file stays local")

    def test_pausing_and_carrying_on_gives_exactly_what_an_unbroken_run_gives(self):
        whole, broken = self.out / "whole", self.out / "broken"
        code, text = self.train("--epochs", "5", out=whole)
        self.assertEqual(code, 0, text)
        steps = int(self.log(whole)[-1]["step"])
        per_epoch = steps // 5
        self.assertGreater(per_epoch, 3)
        for step in (1, per_epoch, 2 * per_epoch + 2, steps - 1):      # also exactly at the end of a round
            # saving after every step on this side: when the files are written must not matter either
            code, text = self.train("--epochs", "5", "--pause-at-step", step, "--save-every", "0", out=broken)
            self.assertEqual(code, train_gpu.EXIT_PAUSED, text)
            self.assertIn("已暫停", text)
            status = train_gpu.read_json(broken / "gongzhu" / "status.json")
            self.assertEqual((status["state"], status["step"]), ("paused", step))
        code, text = self.train("resume", "--save-every", "0", out=broken)     # no settings: the paused run's own are used
        self.assertEqual(code, 0, text)
        self.assertIn("接著上次的進度", text)
        self.assert_same_model(whole, broken)

    def test_a_training_that_is_killed_carries_on_from_its_last_save(self):
        whole = self.out / "whole"
        self.assertEqual(self.train("--epochs", "4", out=whole)[0], 0)
        for save_every, out in (("0", self.out / "often"), ("3600", self.out / "rarely")):
            killed = subprocess.run(
                [sys.executable, SCRIPT, "gongzhu", "--cpu", "--data-dir", str(self.data), "--out-dir", str(out), *SMALL,
                 "--epochs", "4", "--save-every", save_every, "--die-at-step", "9"],
                stdin=subprocess.DEVNULL, capture_output=True)
            self.assertEqual(killed.returncode, 9)
            status = train_gpu.read_json(out / "gongzhu" / "status.json")
            self.assertEqual(status["step"], 9 if save_every == "0" else 0)
            code, text = run("gongzhu", "status", "--out-dir", out, "--data-dir", self.data)
            self.assertIn("沒有正常結束", text)
            code, text = self.train(out=out)
            self.assertEqual(code, 0, text)
            self.assert_same_model(whole, out)

    def test_the_pause_command_stops_a_running_training_which_then_carries_on(self):
        process = self.start()
        code, text = self.train("--epochs", "1")       # (were it let in, one round would be the end of it)
        self.assertEqual(code, train_gpu.EXIT_ERROR)
        self.assertIn("已經有一個訓練在跑", text)
        self.assertIn("訓練中", run("gongzhu", "status", "--out-dir", self.out, "--data-dir", self.data)[1])

        code, text = run("gongzhu", "pause", "--out-dir", self.out, "--data-dir", self.data)
        self.assertEqual(code, 0, text)
        self.assertIn("暫停中", text)
        self.assertEqual(process.wait(timeout=60), train_gpu.EXIT_PAUSED)
        self.assertIn("已暫停（pause 指令）", process.stdout.read())
        self.assertFalse((self.out / "gongzhu" / "PAUSE").exists())
        paused = self.status()
        self.assertEqual(paused["state"], "paused")
        self.assertGreater(paused["step"], 0)
        self.assertEqual(run("gongzhu", "pause", "--out-dir", self.out, "--data-dir", self.data)[0], train_gpu.EXIT_ERROR)

        code, text = self.train("--epochs", paused["epoch"] + 2, "--pause-at-step", paused["step"] + 3)
        self.assertEqual(code, train_gpu.EXIT_PAUSED, text)
        self.assertEqual(self.status()["step"], paused["step"] + 3, "it carried on from where it was paused")

    @unittest.skipIf(os.name == "nt", "signals work differently on Windows")
    def test_ctrl_c_pauses_and_saves(self):
        for number in (signal.SIGINT, signal.SIGTERM):
            process = self.start()
            process.send_signal(number)
            self.assertEqual(process.wait(timeout=60), train_gpu.EXIT_PAUSED)
            self.assertIn("已暫停", process.stdout.read())
            status = self.status()
            self.assertEqual(status["state"], "paused")
            self.assertEqual(self.saved(name="checkpoint.pt")["progress"]["step"], status["step"])
            self.train("--restart", "--epochs", "1")

    def test_a_finished_training_is_not_repeated_until_the_records_change(self):
        data = self.out / "data"
        store(data, rounds(30))
        self.assertEqual(self.train("--epochs", "3", data=data)[0], 0)
        model = self.out / "gongzhu" / "model.pt"
        written = model.stat().st_mtime_ns
        code, text = self.train("--epochs", "3", data=data)
        self.assertEqual(code, 0)
        self.assertIn("已經練好了", text)
        self.assertEqual(model.stat().st_mtime_ns, written)

        store(data, rounds(5, seed=99, first=500))
        code, text = self.train("--epochs", "3", data=data)
        self.assertEqual(code, 0, text)
        self.assertIn("資料和上次練完時不一樣了（那時 30 局，現在 35 局）", text)
        self.assertTrue((self.out / "gongzhu" / "model.previous.pt").exists(), "the earlier model is kept")
        self.assertEqual(self.saved()["data"]["rounds"], 35)
        self.assertEqual(self.saved(name="model.previous.pt")["data"]["rounds"], 30)
        code, text = self.train("--epochs", "4", data=data)
        self.assertIn("設定和上次不一樣", text)

    def test_carrying_on_keeps_the_settings_and_restart_starts_over(self):
        self.assertEqual(self.train("--epochs", "9", "--lr", "0.002", "--pause-at-step", "4")[0], train_gpu.EXIT_PAUSED)
        code, text = self.train("--lr", "0.01")
        self.assertEqual(code, train_gpu.EXIT_USAGE)
        self.assertIn("--lr", text)
        self.assertEqual(self.status()["step"], 4, "nothing was touched")
        code, text = self.train("--epochs", "2", "--pause-at-step", "6")       # how long to train may change
        self.assertEqual(code, train_gpu.EXIT_PAUSED, text)
        self.assertEqual((self.status()["config"]["lr"], self.status()["config"]["epochs"]), (0.002, 2))
        code, text = self.train("--restart", "--epochs", "1")
        self.assertEqual(code, 0, text)
        self.assertIn("從頭開始訓練", text)
        self.assertEqual(self.status()["config"]["lr"], train_gpu.OPTIONS["lr"])

    def test_trouble_with_the_gpu_is_reported_and_the_last_save_is_left_alone(self):
        self.assertEqual(self.train("--epochs", "3", "--pause-at-step", "4")[0], train_gpu.EXIT_PAUSED)
        folder = self.out / "gongzhu"
        saved = (folder / "checkpoint.pt").read_bytes()

        class Gpu:      # there is none here: only how the trouble is handled can be tried
            type = "cuda"

        trouble = RuntimeError("CUDA error: unspecified launch failure\nCompile with TORCH_USE_CUDA_DSA to ...")
        with mock.patch.object(train_gpu, "pick_device", lambda torch, args: Gpu()), \
                mock.patch.object(train_gpu, "prepare", side_effect=trouble):
            code, text = self.train()
        self.assertEqual(code, train_gpu.EXIT_GPU)
        self.assertIn("GPU 出問題", text)
        self.assertIn("CUDA error: unspecified launch failure", text)
        self.assertNotIn("TORCH_USE_CUDA_DSA", text)
        self.assertIn("TORCH_USE_CUDA_DSA", (folder / "error.log").read_text(encoding="utf-8"))
        self.assertEqual(self.status()["state"], "stopped")
        self.assertEqual((folder / "checkpoint.pt").read_bytes(), saved)
        self.assertIn("上次中斷了", run("gongzhu", "status", "--out-dir", self.out, "--data-dir", self.data)[1])
        code, text = self.train()
        self.assertEqual(code, 0, text)
        self.assertIn("接著上次的進度", text)

    def test_carrying_on_with_new_records_uses_them(self):
        data = self.out / "data"
        store(data, rounds(30))
        self.assertEqual(self.train("--epochs", "3", "--pause-at-step", "5", data=data)[0], train_gpu.EXIT_PAUSED)
        store(data, rounds(10, seed=5, first=700))
        code, text = self.train(data=data)
        self.assertEqual(code, 0, text)
        self.assertIn("資料和暫停的時候不一樣了（那時 30 局，現在 40 局）", text)
        self.assertEqual(self.saved()["data"]["rounds"], 40)


@unittest.skipUnless(HAVE_TORCH and os.name != "nt", "needs PyTorch and a pseudo-terminal")
class SameWindow(unittest.TestCase):
    """Started at a terminal, the training is paused, carried on and left with keys in that same window."""

    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.data = Path(cls.folder.name) / "data"
        store(cls.data, rounds(60))

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.out = Path(folder.name) / "out"
        self.where = ["gongzhu", "--data-dir", self.data, "--out-dir", self.out, *SMALL]

    def window(self, *args, env=None, cpu=True):
        window = Window([sys.executable, SCRIPT, *self.where, *(["--cpu"] if cpu else []), *args], env)
        self.addCleanup(window.close)
        return window

    def long(self):
        """A training that goes on until it is stopped, slowly enough to be caught at it."""
        window = self.window("--epochs", "1000000", "--patience", "1000000", "--step-delay", "0.02", "--save-every", "0.2")
        window.see("按 p 暫停")
        self.under_way(3)
        return window

    def status(self):
        return train_gpu.read_json(self.out / "gongzhu" / "status.json") or {}

    def under_way(self, step):
        deadline = time.monotonic() + 120
        while not (self.status().get("state") == "training" and self.status().get("step", 0) >= step):
            self.assertLess(time.monotonic(), deadline, "the training does not get anywhere")
            time.sleep(0.05)

    def whole(self, *args):
        """The same training run in one go without a window: (where it is, what its model file holds)."""
        import torch
        out = self.out.parent / "whole"
        code, text = run(*self.where[:3], "--out-dir", out, *SMALL, "--cpu", *args)
        self.assertEqual(code, 0, text)
        return torch.load(out / "gongzhu" / "model.pt", map_location="cpu", weights_only=True)

    def assert_same_as(self, whole):
        import torch
        mine = torch.load(self.out / "gongzhu" / "model.pt", map_location="cpu", weights_only=True)
        for name in whole["state"]:
            self.assertTrue(torch.equal(whole["state"][name], mine["state"][name]), f"{name} differs")
        self.assertEqual(whole["result"], mine["result"])

    def test_p_pauses_and_lets_go_of_everything_and_p_again_carries_on_to_the_same_result(self):
        whole = self.whole("--epochs", "20")        # long enough that both pauses come well before the end
        window = self.window("--epochs", "20", "--step-delay", "0.05", "--save-every", "0.2")
        window.see("按 p 暫停")
        self.under_way(3)
        for key in (b"p", b"\r"):       # carrying on works with p as well as with Enter
            window.press(b"p")
            window.see("已暫停")
            window.see("繼續訓練，按 q 離開")
            paused = self.status()
            self.assertEqual(paused["state"], "paused")
            self.assertFalse(train_gpu.is_training(self.out / "gongzhu"), "no training process is left holding the GPU")
            time.sleep(0.5)
            self.assertEqual(self.status()["step"], paused["step"], "nothing moves while paused")
            window.press(key)
            window.see("接著上次的進度")
            self.under_way(paused["step"] + 2)
        self.assertEqual(window.ended(), 0)
        self.assertIn("訓練完成", window.screen)
        self.assertEqual(window.screen.count("資料："), 1, "the opening lines are shown once, not after every pause")
        self.assertEqual(window.screen.count("從頭開始訓練"), 1)
        self.assert_same_as(whole)

    def test_q_saves_and_leaves_and_the_same_command_carries_on(self):
        window = self.long()
        self.assertFalse(window.echoes(), "keys pressed during the training are not shown")
        window.press(b"q")
        self.assertEqual(window.ended(), train_gpu.EXIT_PAUSED)
        self.assertTrue(window.echoes(), "the terminal is handed back as it was")
        self.assertIn("已暫停", window.screen)
        self.assertIn("已離開。要接著練", window.screen)
        left = self.status()
        self.assertEqual(left["state"], "paused")
        self.assertFalse(train_gpu.is_training(self.out / "gongzhu"))
        # (two more steps may run into the next round, so that one has to be allowed as well)
        code, text = run(*self.where, "--cpu", "--epochs", left["epoch"] + 2, "--pause-at-step", left["step"] + 2)
        self.assertEqual(code, train_gpu.EXIT_PAUSED, text)
        self.assertIn("接著上次的進度", text)
        self.assertEqual(self.status()["step"], left["step"] + 2)

    def test_q_while_paused_leaves_too(self):
        window = self.long()
        window.press(b"p")
        window.see("繼續訓練，按 q 離開")
        window.press(b"x")       # any other key does nothing
        time.sleep(0.3)
        window.press(b"q")
        self.assertEqual(window.ended(), train_gpu.EXIT_PAUSED)
        self.assertIn("已離開。要接著練", window.screen)
        self.assertEqual(self.status()["state"], "paused")

    def test_ctrl_c_in_the_window_saves_and_leaves(self):
        window = self.long()
        window.press(b"\x03")
        self.assertEqual(window.ended(), train_gpu.EXIT_PAUSED)
        self.assertIn("已暫停（Ctrl+C）", window.screen)
        self.assertIn("要接著練", window.screen)
        import torch
        saved = torch.load(self.out / "gongzhu" / "checkpoint.pt", map_location="cpu", weights_only=True)
        self.assertEqual(saved["progress"]["step"], self.status()["step"])
        self.assertGreater(saved["progress"]["step"], 0)

    def test_restart_is_not_repeated_when_carrying_on(self):
        self.assertEqual(run(*self.where, "--cpu", "--epochs", "8", "--pause-at-step", "3")[0], train_gpu.EXIT_PAUSED)
        window = self.window("--restart", "--epochs", "8", "--step-delay", "0.05", "--save-every", "0.2")
        window.see("從頭開始訓練")
        self.under_way(3)
        window.press(b"p")
        window.see("繼續訓練，按 q 離開")
        window.press(b"\n")
        window.see("接著上次的進度")
        self.assertEqual(window.ended(), 0)
        self.assertEqual(window.screen.count("從頭開始訓練"), 1)

    def test_without_a_gpu_the_window_just_says_so(self):
        window = self.window(cpu=False, env={"CUDA_VISIBLE_DEVICES": ""})
        self.assertEqual(window.ended(), train_gpu.EXIT_NO_GPU)
        self.assertIn("找不到 NVIDIA GPU", window.screen)
        self.assertNotIn("Enter", window.screen)
        self.assertFalse(self.out.exists())

    def test_trouble_with_the_gpu_waits_in_the_window_and_carries_on_from_the_last_save(self):
        whole = self.whole("--epochs", "6")
        window = self.window("--epochs", "6", "--trouble-at-step", "7", "--save-every", "0")
        window.see("GPU 出問題")
        window.see("從上一次存檔的地方接著練；按 q 離開")
        self.assertEqual(self.status()["state"], "stopped")
        self.assertFalse(train_gpu.is_training(self.out / "gongzhu"))
        window.press(b"\r")
        window.see("接著上次的進度")
        self.assertEqual(window.ended(), 0)
        self.assert_same_as(whole)

    def stopped(self):
        deadline = time.monotonic() + 60
        while train_gpu.is_training(self.out / "gongzhu"):
            self.assertLess(time.monotonic(), deadline, "the training goes on with nobody at the window")
            time.sleep(0.1)
        self.assertEqual(self.status()["state"], "paused")

    def test_a_terminal_that_is_closed_does_not_leave_a_training_behind(self):
        window = self.long()
        os.kill(window.pid, signal.SIGKILL)     # the terminal's own program dies: everything in it is told to hang up
        self.stopped()

    def test_a_training_whose_window_program_is_gone_saves_and_stops(self):
        # Started from a shell, so that the terminal stays when the program listening to the keys is killed:
        # nothing tells the training, it has to notice by itself that nobody is at the other end any more.
        words = [sys.executable, SCRIPT, *self.where, "--cpu", "--epochs", "1000000", "--patience", "1000000",
                 "--step-delay", "0.02", "--save-every", "0.2"]
        window = Window(["/bin/sh", "-c", " ".join(shlex.quote(str(word)) for word in words) + "; sleep 60"])
        self.addCleanup(window.close)
        window.see("按 p 暫停")
        self.under_way(3)
        training = self.status()["pid"]
        listening = int(subprocess.run(["ps", "-o", "ppid=", "-p", str(training)], capture_output=True, text=True).stdout)
        self.assertNotIn(listening, (window.pid, os.getpid()))
        os.kill(listening, signal.SIGKILL)
        window.see("已暫停（視窗關掉了）")
        self.stopped()

    def test_keys_can_be_turned_off(self):
        window = self.window("--no-keys", "--epochs", "1000000", "--patience", "1000000", "--step-delay", "0.02",
                             "--save-every", "0.2")
        window.see("要暫停：按 Ctrl+C")
        self.under_way(3)
        window.press(b"p")
        time.sleep(1)
        self.assertEqual(self.status()["state"], "training", "p means nothing now")
        window.press(b"\x03")
        self.assertEqual(window.ended(), train_gpu.EXIT_PAUSED)
        self.assertIn("要接著練", window.screen)


@unittest.skipUnless(PAGE_RECORDS, "run through node --test tests/records.test.cjs")
class PageRecords(unittest.TestCase):
    """What the real pages record (handed over by tests/records.test.cjs) is what the trainer can read."""

    def records(self, slug):
        records, broken = train_gpu.read_records(Path(PAGE_RECORDS) / slug)
        self.assertEqual(broken, [])
        self.assertGreaterEqual(len(records), 3, slug)
        return records

    def players_entries(self, slug, record):
        """How many decisions of the player the round holds, counted straight from the record."""
        players = record["players"]
        if slug == "gongzhu":
            return sum(1 for trick in record["tricks"] for play in trick if not players[play["seat"]]["ai"])
        if slug == "bigtwo":
            return sum(1 for action in record["actions"] if not players[action["seat"]]["ai"])
        if slug.startswith("mahjong"):
            return sum(1 for e in record["actions"] if e["s"] == 0 and e["a"] not in ("draw", "flower") and not e.get("rob"))
        if slug == "xiangqi":
            mine = {p["color"] for p in players.values() if not p["ai"]}
            return sum(1 for move in record["moves"] if move["color"] in mine)
        return sum(1 for move in record["moves"] if not move.get("pass") and not players[move["seat"]]["ai"])

    def test_every_round_of_every_game_is_read_and_every_decision_of_the_player_is_found(self):
        for slug, kind in train_gpu.GAMES.items():
            records = self.records(slug)
            data = dataset(records, game=kind(), players="all", with_hints=True)
            self.assertEqual(data.skipped, [], slug)
            self.assertEqual(data.human, sum(self.players_entries(slug, r) for r in records), slug)
            self.assertGreater(data.human, 10, slug)
            self.assertGreater(data.computer, 10, slug)
            self.assertGreater(sum(data.decisions), 10, slug)
            unfinished = [r for r in records if r["status"] == "unfinished"]
            self.assertTrue(unfinished, f"{slug}: a round the player walked away from is among them")
            self.assertGreater(sum(dataset(unfinished, game=kind()).decisions), 0, slug)
            marked = dataset(records, game=kind())
            self.assertGreater(marked.marked, 0, f"{slug}: hinted decisions are recognised")

    def test_what_the_model_is_shown_adds_up(self):
        game = train_gpu.GongZhu()
        for record in self.records("gongzhu"):
            for _, _, steps in game.decisions(record):
                x, mask, y = steps[0]
                hand, unseen = field(game, x, "hand"), field(game, x, "unseen")
                played, table = field(game, x, "played"), field(game, x, "table")
                for card in range(52):
                    places = hand[card] + unseen[card] + sum(played[k * 52 + card] for k in range(4)) \
                        + sum(table[k * 52 + card] for k in range(3))
                    self.assertEqual(places, 1, "every card is in exactly one place")
                    self.assertLessEqual(mask[card], hand[card])
                kinds = [sum(field(game, x, "each." + name)) for name in ("win", "duck", "off")]
                self.assertEqual(sum(kinds), 0 if field(game, x, "lead")[4] else sum(hand))
                self.assertEqual(sum(field(game, x, "trick")), 1)
                # who is collecting the hearts is the same story as the card-by-card list of what each player took
                taken = field(game, x, "taken")
                hearts = [sum(taken[place * 16:place * 16 + 13]) for place in range(4)]
                self.assertEqual(field(game, x, "hearts"), [train_gpu.level(count, 0, 13) for count in hearts])
                self.assertEqual(field(game, x, "big"), [taken[place * 16 + 13 + k] for place in range(4) for k in range(3)])
                sweep = field(game, x, "sweep")
                self.assertEqual(sweep, [int(sum(hearts) > 0 and count == sum(hearts)) for count in hearts])
                keeps, splits = field(game, x, "each.keeps"), field(game, x, "each.splits")
                self.assertTrue(all(k + s <= held for k, s, held in zip(keeps, splits, hand)), "a card in hand goes one way at most")
                if not sum(sweep):
                    self.assertEqual(sum(keeps) + sum(splits), 0, "nothing to keep or split while nobody is collecting")

        game = train_gpu.BigTwo()
        for record in self.records("bigtwo"):
            for _, _, steps in game.decisions(record):
                for index, (x, mask, y) in enumerate(steps):
                    hand, unseen, played = field(game, x, "hand"), field(game, x, "unseen"), field(game, x, "played")
                    for card in range(52):
                        self.assertEqual(hand[card] + unseen[card] + sum(played[k * 52 + card] for k in range(4)), 1)
                        self.assertLessEqual(mask[card], hand[card])
                    chosen = field(game, x, "chosen")
                    self.assertEqual(sum(chosen), index, "one more card is picked at every step")
                    self.assertTrue(all(c <= h for c, h in zip(chosen, hand)))
                    self.assertEqual(field(game, x, "picked")[min(index, 5)], 1)
                    self.assertEqual(sum(played[:52]) + sum(hand), 13, "what one played and what one holds make thirteen")
                self.assertEqual(steps[-1][2], game.END)

        for slug in ("mahjong", "mahjong-me"):
            game = train_gpu.GAMES[slug]()
            for record in self.records(slug):
                for _, _, steps in game.decisions(record):
                    x, mask, y = steps[0]
                    hand, unseen = field(game, x, "hand"), field(game, x, "unseen")
                    melds, river = field(game, x, "melds"), field(game, x, "river")
                    for tile in range(34):
                        shown = sum(hand[tile * 4:tile * 4 + 4]) + sum(
                            sum(part[(seat * 34 + tile) * 4:(seat * 34 + tile) * 4 + 4]) for part in (melds, river) for seat in range(4))
                        self.assertEqual(shown + sum(unseen[tile * 4:tile * 4 + 4]), 4, "four of every tile, seen or not")
                        if mask[tile]:
                            self.assertEqual(hand[tile * 4], 1, "only a tile in the hand can be discarded")
                    moment = field(game, x, "moment")
                    self.assertEqual(sum(moment), 1)
                    self.assertEqual(sum(field(game, x, "offer")), moment[2])
                    self.assertEqual(sum(field(game, x, "drawn")), moment[0])
                    self.assertEqual(sum(hand[k * 4] + hand[k * 4 + 1] + hand[k * 4 + 2] + hand[k * 4 + 3] for k in range(34))
                                     + 3 * field(game, x, "sets")[:6].index(1), 17 if moment[0] or moment[1] else 16)

    def test_a_round_with_an_entry_missing_is_refused(self):
        log = {"gongzhu": "tricks", "bigtwo": "actions", "mahjong": "actions", "mahjong-me": "actions"}
        for slug, kind in train_gpu.GAMES.items():
            refused = 0
            for record in self.records(slug):
                broken = json.loads(json.dumps(record))
                entries = broken[log.get(slug, "moves")]
                if len(entries) < 12:
                    continue
                if slug == "gongzhu":
                    del entries[4][1]
                else:
                    del entries[len(entries) // 2]
                data = dataset([broken], game=kind(), players="all", with_hints=True)
                refused += len(data.skipped)
                self.assertEqual(sum(data.rounds), 1 - len(data.skipped))
            self.assertGreaterEqual(refused, 2, f"{slug}: a record with a hole in it is noticed")

    def test_mahjong_draws_must_follow_the_wall(self):
        game, refused = train_gpu.Mahjong(), 0
        for record in self.records("mahjong"):
            for back in (False, True):
                draws = [e for e in record["actions"] if e["a"] == "draw" and bool(e.get("back")) == back]
                places = [len(record["wall"]) - 1 - k if back else 64 + k for k in range(len(draws))]
                pair = next(((a, b) for a in range(len(draws)) for b in range(a + 1, len(draws))
                             if draws[a]["t"] != draws[b]["t"]), None)
                if pair is None:
                    continue
                self.assertEqual([record["wall"][place] for place in places], [e["t"] for e in draws])
                wrong = json.loads(json.dumps(record))
                one, two = places[pair[0]], places[pair[1]]
                wrong["wall"][one], wrong["wall"][two] = wrong["wall"][two], wrong["wall"][one]
                data = dataset([wrong], game=game)
                self.assertEqual(len(data.skipped), 1, "the wall no longer says what was drawn")
                refused += 1
        self.assertGreater(refused, 3)

    def test_hidden_cards_and_tiles_never_reach_the_features(self):
        rng = random.Random(5)
        for slug, twin_of in (("bigtwo", bigtwo_twin), ("mahjong", mahjong_twin), ("mahjong-me", mahjong_twin)):
            game, compared = train_gpu.GAMES[slug](), 0
            for record in self.records(slug):
                for _ in range(6):
                    twin = twin_of(record, rng)
                    if twin is None:
                        continue
                    self.assertNotEqual(twin, record)
                    self.assertEqual(of_player(game, twin), of_player(game, record), f"{slug} {record['id']}")
                    compared += 1
            self.assertGreater(compared, 5, slug)
        game, compared = train_gpu.GongZhu(), 0
        for record in self.records("gongzhu"):
            plays = [play for trick in record["tricks"] for play in trick]
            for cut in range(2, len(plays) + 1, 3):
                twin = gongzhu_twin(record, cut, rng)
                if twin is None:
                    continue
                seen, same = list(game.decisions(record))[cut - 1], list(game.decisions(twin))[cut - 1]
                self.assertEqual([(bytes(x), bytes(m), y) for x, m, y in seen[2]], [(bytes(x), bytes(m), y) for x, m, y in same[2]])
                compared += 1
        self.assertGreater(compared, 10)


if __name__ == "__main__":
    unittest.main()
