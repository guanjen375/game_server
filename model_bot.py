"""用訓練好的模型替電腦出牌（遊戲伺服器用，不需要 PyTorch，也不需要 GPU）

train_gpu.py 練出來的 train_out/<遊戲>/model.pt 放著就能用：玩家在遊戲裡把「電腦的打法」選成模型之後，
遊戲頁面輪到電腦時問伺服器「這一手該出什麼」（POST /api/bot/<遊戲>，見 open_server.py），伺服器交給這裡算。

模型有兩種打法，在遊戲頁面上選：
    normal  正常：完全照模型，每次都出模型分數最高的那個動作。
    weak    較弱：照模型估的機率抽一個，所以有時會出它的第二、第三選擇；機率不到 WEAK_FLOOR 的不出。
            同一個局面每次抽到的都一樣（悔牌重來不會換一張）。

看牌用的是訓練時的同一段程式（train_gpu.py 的 Game），模型在這裡看到的和訓練時一模一樣。
模型檔換了（重新訓練、git pull）不用重開伺服器，下一手就會用新的。
"""

import array
import collections
import hashlib
import io
import math
import pickle
import random
import sys
import threading
import zipfile
from pathlib import Path

import train_gpu

MODEL_DIR = train_gpu.OUT_DIR
MODES = ("normal", "weak")
WEAK_FLOOR = 0.10           # 較弱：模型估的機率低於這個的動作不出（它幾乎不會選的，出了只像亂打）
WEAK_TEMPERATURE = 1.0      # 較弱：1＝照模型估的機率抽；調大會更常出次要的選擇（更弱）
# 弱多少是量出來的。2026-11-21 用 246 局拱豬練的模型讓四家自己對打（每組 2,400 局）：三家「較弱」中間坐一家
# 「正常」，正常的那一家平均每局比另外三家多幾分（四家都正常時是 0；誤差約 ±3）——
#   FLOOR 0.10、TEMPERATURE 1：約 17 分（有得選的時候，三成出的不是第一選擇）  ← 現在用的
#   FLOOR 0.10、TEMPERATURE 2：約 23 分        FLOOR 0.05、TEMPERATURE 1：約 23 分
#   FLOOR 0.05、TEMPERATURE 2：約 29 分        FLOOR 0.02、TEMPERATURE 3：約 41 分（一半以上不是第一選擇）
MODEL_MAX_BYTES = 200_000_000


class Unusable(Exception):
    """模型檔不能用：讀不出來，或和現在的程式對不上。訊息是給人看的原因。"""


class Refused(Exception):
    """問的內容不對（紀錄對不起來、不是輪到那一家、沒有這種打法）。訊息是原因。"""


# ===================== 讀 model.pt =====================
# torch.save 存的檔案是一個 zip：data.pkl 是 pickle，數字另外放在 data/<編號>。
# 這裡只認訓練程式會寫進去的東西（陣列、字典、清單、字串、數字），其他的一律不收。

STORAGES = {"FloatStorage": "f", "DoubleStorage": "d", "LongStorage": "q", "IntStorage": "i",
            "ShortStorage": "h", "CharStorage": "b", "ByteStorage": "B", "BoolStorage": "B"}


def nest(values, shape):
    """排成一長條的數字照 shape 疊成一層一層的清單。"""
    if not shape:
        return values[0]
    if len(shape) == 1:
        return list(values)
    step = len(values) // shape[0] if shape[0] else 0
    return [nest(values[row * step:(row + 1) * step], shape[1:]) for row in range(shape[0])]


class Reader(pickle.Unpickler):
    def __init__(self, file, archive, prefix):
        super().__init__(file)
        self.archive, self.prefix, self.storages = archive, prefix, {}
        try:
            self.swap = archive.read(prefix + "byteorder").decode().strip() != sys.byteorder
        except KeyError:
            self.swap = sys.byteorder != "little"

    def find_class(self, module, name):
        if (module, name) == ("collections", "OrderedDict"):
            return collections.OrderedDict
        if (module, name) == ("torch._utils", "_rebuild_tensor_v2"):
            return self.tensor
        if module == "torch" and name in STORAGES:
            return name
        raise pickle.UnpicklingError(f"不認得 {module}.{name}")

    def persistent_load(self, saved):
        kind, storage, key = saved[0], saved[1], str(saved[2])
        if kind != "storage" or storage not in STORAGES:
            raise pickle.UnpicklingError("不認得的資料")
        if key not in self.storages:
            values = array.array(STORAGES[storage])
            values.frombytes(self.archive.read(f"{self.prefix}data/{key}"))
            if self.swap:
                values.byteswap()
            self.storages[key] = [bool(value) for value in values] if storage == "BoolStorage" else values.tolist()
        return self.storages[key]

    def tensor(self, storage, offset, size, stride, *_):
        count, straight = 1, []
        for length in reversed(size):
            straight.insert(0, count)
            count *= length
        if tuple(stride) != tuple(straight) or offset < 0 or offset + count > len(storage):
            raise pickle.UnpicklingError("陣列的排法不對")
        return nest(storage[offset:offset + count], tuple(size))


def read_model(source):
    """讀 train_gpu.py 存的 model.pt（檔案的路徑或內容），回傳裡面那個字典（見 train_gpu.py 的 model_file()）；
    state 裡的每個陣列是一層一層的清單。讀不出來、不是模型檔就丟 Unusable。"""
    try:
        with zipfile.ZipFile(io.BytesIO(source) if isinstance(source, bytes) else source) as archive:
            names = [name for name in archive.namelist() if name.endswith("/data.pkl")]
            if len(names) != 1:
                raise ValueError("裡面沒有 data.pkl")
            with archive.open(names[0]) as file:
                saved = Reader(file, archive, names[0][:-len("data.pkl")]).load()
    except (OSError, ValueError, KeyError, IndexError, TypeError, EOFError, MemoryError,
            zipfile.BadZipFile, pickle.UnpicklingError) as error:
        raise Unusable(f"模型檔讀不出來（{type(error).__name__}：{error}）") from None
    if not isinstance(saved, dict) or saved.get("format") != "game-policy-1":
        raise Unusable("不是 train_gpu.py 訓練出來的模型")
    return saved


# ===================== 算分數 =====================

def linear(rows, bias, values):
    return [sum(map(float.__mul__, row, values)) + extra for row, extra in zip(rows, bias)]


def normalise(values, weight, bias):
    mean = sum(values) / len(values)
    spread = math.sqrt(sum((value - mean) ** 2 for value in values) / len(values) + 1e-5)
    return [(value - mean) / spread * scale + shift for value, scale, shift in zip(values, weight, bias)]


def gelu(values):
    return [0.5 * value * (1.0 + math.erf(value * 0.7071067811865476)) for value in values]


class Policy:
    """model.pt 裡的模型。scores(x, mask) 算出每個可以選的動作的分數，算法和 train_gpu.py 的
    build_model() 一樣（出牌的時候不遮欄位、不 dropout）；兩邊算出來一不一樣由 tests/test_model_bot.py 對。"""

    def __init__(self, saved):
        encoder, state = saved["encoder"], saved["state"]
        self.features, self.actions, self.each = encoder["features"], encoder["actions"], encoder["each"]
        about, scale = encoder["about"], state["scale"]
        self.own = self.features - self.each * self.actions     # x 裡「每個動作各一格」的欄位從哪裡開始
        self.scale = scale

        # 局面那一段。x 大多是 0，所以第一層先轉成一欄一欄的（順便乘上欄位的倍率），算的時候只加不是 0 的那幾欄
        enter = state["enter.weight"]
        self.columns = [[row[column] * (scale[column] if column < self.features else 1.0) for row in enter]
                        for column in range(self.features + self.actions)]
        self.enter_bias = state["enter.bias"]
        self.blocks = [tuple(state[f"blocks.{block}.{name}"] for name in
                             ("norm.weight", "norm.bias", "one.weight", "one.bias", "two.weight", "two.bias"))
                       for block in range(saved["arch"]["depth"])]
        self.norm = state["norm.weight"], state["norm.bias"]
        self.situation = state["situation.weight"], state["situation.bias"]

        # 每個動作那一段。動作不會變的描述（about()）和「可以選」那一格先算好
        action, bias = state["action.weight"], state["action.bias"]
        self.fixed = [[sum(row[k] * described[k] for k in range(about)) + row[about + self.each] + extra
                       for row, extra in zip(action, bias)] for described in state["static"]]
        self.varying = [[row[about + field] for row in action] for field in range(self.each)]
        self.score = state["score.2.weight"], state["score.2.bias"]
        self.last, self.last_bias = state["score.4.weight"][0], state["score.4.bias"][0]

    def scores(self, x, mask):
        """x：Game 交出來的那一串 0～255；mask：每個動作可不可以選。回傳 {動作: 分數}，只有可以選的動作。"""
        legal = [action for action, allowed in enumerate(mask) if allowed]
        hidden = self.enter_bias
        for column, value in enumerate(x):
            if value:
                hidden = [total + value * weight for total, weight in zip(hidden, self.columns[column])]
        for action in legal:
            hidden = [total + weight for total, weight in zip(hidden, self.columns[self.features + action])]
        for norm, shift, one, one_bias, two, two_bias in self.blocks:
            inner = linear(two, two_bias, gelu(linear(one, one_bias, normalise(hidden, norm, shift))))
            hidden = [total + extra for total, extra in zip(hidden, inner)]
        situation = linear(*self.situation, normalise(hidden, *self.norm))

        scores = {}
        for action in legal:
            inner = [here + there for here, there in zip(self.fixed[action], situation)]
            for field in range(self.each):
                at = self.own + field * self.actions + action
                if x[at]:
                    value = x[at] * self.scale[at]
                    inner = [total + value * weight for total, weight in zip(inner, self.varying[field])]
            inner = gelu(linear(*self.score, gelu(inner)))
            scores[action] = sum(map(float.__mul__, self.last, inner)) + self.last_bias
        return scores


def chances(scores):
    """模型估每個動作被選的機率（分數的 softmax）。"""
    top = max(scores.values())
    odds = {action: math.exp(score - top) for action, score in scores.items()}
    total = sum(odds.values())
    return {action: odd / total for action, odd in odds.items()}


def pick(scores, mode, key=""):
    """從模型的分數挑一個動作。normal：分數最高的（同分取編號小的）。
    weak：照機率抽，機率不到 WEAK_FLOOR 的不抽；key 一樣（同一個局面）每次抽到的都一樣。"""
    best = max(scores, key=lambda action: (scores[action], -action))
    if mode != "weak" or len(scores) < 2:
        return best
    kept = [(action, chance) for action, chance in sorted(chances(scores).items())
            if action == best or chance >= WEAK_FLOOR]
    weights = [chance ** (1 / WEAK_TEMPERATURE) for _, chance in kept]
    spot = random.Random(key).random() * sum(weights)
    for (action, _), weight in zip(kept, weights):
        spot -= weight
        if spot < 0:
            return action
    return best


# ===================== 一個資料夾裡各個遊戲的模型 =====================

def blob_id(data):
    """檔案內容的編號，和 git 的 blob 編號一樣：`git log --all --find-object=<編號>` 查得到是哪一次 commit 的模型。"""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class Bots:
    """train_out/ 裡各個遊戲的模型。檔案換了會自動重讀；讀進來的模型留在記憶體，每一手不用重讀。"""

    def __init__(self, folder=None):
        self.folder = Path(folder or MODEL_DIR)
        self.lock = threading.Lock()
        self.loaded = {}        # 遊戲 → (檔案的時間和大小, (game, policy, 說明) 或 None, 不能用的原因)

    def load(self, slug):
        """(game, policy, 說明)；這個遊戲沒有可以用的模型時是 None。第二個值是不能用的原因（沒有模型檔時是 None）。"""
        path = self.folder / slug / "model.pt"
        with self.lock:
            try:
                size = path.stat()
                stamp = (size.st_mtime_ns, size.st_size)
            except OSError:
                self.loaded.pop(slug, None)
                return None, None
            if slug not in self.loaded or self.loaded[slug][0] != stamp:
                try:
                    self.loaded[slug] = (stamp, self.read(slug, path), None)
                except Unusable as why:
                    self.loaded[slug] = (stamp, None, str(why))
            return self.loaded[slug][1:]

    def read(self, slug, path):
        if slug not in train_gpu.GAMES:
            raise Unusable("train_gpu.py 不認得這個遊戲")
        game = train_gpu.GAMES[slug]()
        if type(game).upcoming is train_gpu.Game.upcoming:
            raise Unusable(f"{game.title}還沒有接上：模型還不能替電腦出牌")
        try:
            if path.stat().st_size > MODEL_MAX_BYTES:
                raise Unusable("模型檔太大")
            data = path.read_bytes()
        except OSError as error:
            raise Unusable(f"模型檔讀不出來（{error}）") from None
        saved = read_model(data)
        if saved.get("game") != slug:
            raise Unusable(f"這是 {saved.get('game')} 的模型")
        if saved.get("encoder") != train_gpu.encoder_of(game):
            raise Unusable("這個模型是用舊的看牌方式練的，和現在的程式對不上，要重新訓練")
        try:
            policy = Policy(saved)
            result, data_used = saved.get("result") or {}, saved.get("data") or {}
            info = {
                "id": blob_id(data), "saved": saved.get("saved"), "finished": bool(result.get("finished")),
                "rounds": data_used.get("used_rounds"),
                "decisions": (data_used.get("train_decisions") or 0) + (data_used.get("validation_decisions") or 0),
                "accuracy": result.get("validation_accuracy"), "chance": result.get("chance"),
            }
        except (KeyError, IndexError, TypeError, ValueError, AttributeError) as error:
            raise Unusable(f"模型檔的內容不完整（{type(error).__name__}：{error}）") from None
        return game, policy, info

    def info(self, slug):
        """給遊戲頁面和 status 看的：{"model": 說明或 None, "why": 有模型檔卻不能用的原因}。"""
        loaded, why = self.load(slug)
        return {"model": loaded[2] if loaded else None, "why": why}

    def play(self, slug, record, seat=None, mode="normal"):
        """這一局打到 record 這裡，輪到的那一家該出什麼。
        回傳 {"play": 寫進紀錄的那一筆, "mode": 打法, "model": 模型的編號}；這個遊戲沒有可以用的模型時回傳 None。"""
        loaded, _ = self.load(slug)
        if loaded is None:
            return None
        game, policy, info = loaded
        if mode not in MODES:
            raise Refused(f"沒有 {mode} 這種打法")
        if not isinstance(record, dict):
            raise Refused("紀錄不是一局的內容")
        try:
            turn, x, mask, entry = game.upcoming(dict(record, status="unfinished"))
        except train_gpu.Skip as why:
            raise Refused(str(why)) from None
        except (KeyError, IndexError, TypeError, ValueError, AttributeError, StopIteration, RecursionError) as error:
            raise Refused(f"格式不對（{type(error).__name__}：{error}）") from None
        if seat is not None and seat != turn:
            raise Refused(f"現在輪到的是 {turn}，不是 {seat}")
        key = hashlib.sha256(bytes(x) + bytes(mask)).hexdigest()     # 那一家看到的一樣，就算同一個局面
        return {"play": entry(pick(policy.scores(x, mask), mode, key)), "mode": mode, "model": info["id"]}
