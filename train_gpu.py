#!/usr/bin/env python3
"""用對局紀錄訓練「照玩家的習慣出牌」的模型（要有 NVIDIA GPU）

    python3 train_gpu.py gongzhu           用 gaming_data/gongzhu/ 的紀錄訓練，模型放在 train_out/gongzhu/
    python3 train_gpu.py gongzhu pause     暫停放在背景執行的訓練（在視窗裡執行的直接按 p 就好）
    python3 train_gpu.py gongzhu status    看練到哪裡
    python3 train_gpu.py                   列出每個遊戲有幾局紀錄、練到哪裡

其他遊戲一樣，把 gongzhu 換成 mahjong、bigtwo……（就是 gaming_data/ 底下的資料夾名稱）。

暫停模式：GPU 要讓給別的事情用的時候，在訓練的視窗按 p，訓練會把進度存好、把 GPU 完全讓出來，視窗停在暫停；
按 Enter 就從暫停的地方接著練。按 q（或 Ctrl+C）是存檔後離開，之後再執行一次同一個指令一樣接著練。
訓練途中也會定時存檔，所以被強制關掉、當機或 GPU 出錯時，最多少掉最後一次存檔之後的進度。
放在背景或排程執行（沒有視窗可以按鍵）的時候，用 Ctrl+C、kill 或另外執行 pause 來暫停。

需要 PyTorch（要裝支援 CUDA 的版本）。找不到 NVIDIA GPU 時直接顯示錯誤並結束，不會改用 CPU。

學的是什麼：把每一局重排一遍，在玩家每一次要做決定的時候，記下「當時他看得到的東西」和「他選了什麼」，
讓模型學著猜他會怎麼選。電腦對手的出牌、按過「提示」才出的、自動胡牌替他打的，預設都不學。
"""

import argparse
import csv
import difflib
import hashlib
import io
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
import zlib
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "gaming_data"
OUT_DIR = BASE_DIR / "train_out"
RUN = ("python" if os.name == "nt" else "python3") + " train_gpu.py"     # 提示使用者下指令時怎麼寫

# 結束代碼：0 練完了（或本來就是最新的）、1 出錯、2 指令或資料有問題、3 找不到 NVIDIA GPU（或沒裝 PyTorch）、
# 4 暫停中（還沒練完）、5 GPU 出錯而中斷（進度留在上一次存檔）
EXIT_DONE, EXIT_ERROR, EXIT_USAGE, EXIT_NO_GPU, EXIT_PAUSED, EXIT_GPU = 0, 1, 2, 3, 4, 5

# 可以調的訓練設定和預設值
OPTIONS = {
    "epochs": 300,          # 最多練幾輪（整份資料看過一遍算一輪）
    "patience": 30,         # 驗證成績連續幾輪沒有進步就停
    "batch_size": 256,
    "lr": 0.001,
    "weight_decay": 0.01,
    "width": 128,           # 模型每一層多寬
    "depth": 1,             # 模型幾層
    "dropout": 0.3,
    "seed": 1,
    "players": "human",     # human：只學真人的決定；all：電腦的也學
    "ip": [],               # 只用這幾台裝置（來源 IP）的紀錄；空的＝全部
    "with_hints": False,    # 按過提示才做的、自動胡牌替玩家打的也學
}
RESUMABLE = ("epochs", "patience")     # 接著練的時候可以改的設定；其他的要用 --restart 從頭來
VALIDATION_PERCENT = 10                # 留大約一成的對局不練，用來檢查學得怎麼樣
LR_PATIENCE = 10                       # 驗證成績每連續這麼多輪沒進步，學習率減半
NO_VALIDATION_EPOCHS = 40              # 對局太少、留不出驗證用的對局時，固定只練這麼多輪
STATUS_EVERY = 5                       # 每隔幾秒更新一次 status.json
DETAIL_DROPOUT = 0.8                   # 模型讀「細節」欄位時隨機遮掉多少（見 Game）


def say(*parts):
    print(*parts, flush=True)


class Problem(Exception):
    """沒辦法繼續的狀況：把訊息顯示給使用者看，用指定的代碼結束。"""

    def __init__(self, message, code=EXIT_ERROR):
        super().__init__(message)
        self.code = code


# ===================== 對局紀錄 → 一個一個的決定 =====================

class Skip(Exception):
    """這一局的紀錄讀不懂，或前後對不起來：整局不拿來訓練。"""


def need(ok, why):
    if not ok:
        raise Skip(why)


def level(value, low, high):
    """把數字換成 0～255（low 以下是 0、high 以上是 255）：分數這類不是 0/1 的欄位用。"""
    return max(0, min(255, round(255 * (value - low) / (high - low))))


class Game:
    """一個遊戲的紀錄怎麼變成訓練資料。

    decisions(record) 把一局從頭重排一遍，交出每一個決定：(是不是真人做的, 記號, 步驟)。
    記號是 hint（按過提示）、auto（自動胡牌替玩家打的）或空字串。
    一個決定是一步或幾步（例如象棋先選哪一顆、再選走到哪）；每一步是 (x, mask, y)：
    x 是做決定的那一家當時看得到的東西（別家的手牌不能放進去），mask 是可以選的動作，y 是實際選的。
    紀錄前後對不起來（例如出了手上沒有的牌）就丟 Skip，那一局整局不用。

    x 的每一格是 0～255 的整數，多半是 0/1，分兩種欄位：
      整個局面的：在 define() 裡用 add() 排出來。
      每個動作各一格的（EACH）：描述「選這個動作」本身，例如拱豬的「出這張會不會吃下這一墩」。排在 x 的最後面，
      第 k 種的第 a 個動作在 self.each[名稱] + a。模型用同一套算法替每個動作打分數，所以這種欄位學到的道理每個動作通用。
    about(a) 是動作 a 不會變的描述（例如哪個花色、幾點），用法和 EACH 一樣。

    SUMMARY 列出整個局面的欄位裡哪幾個是「大方向」（第幾墩、誰最大、外面還有幾張……）；其餘的是細節
    （哪一張牌在哪裡）。模型讀細節的時候會隨機遮掉一部分，逼它主要靠大方向和每個動作自己的描述下判斷：
    對局不多的時候，這樣比較不會把看過的牌局死背下來。
    """
    slug = title = ""
    version = 1         # x 的欄位或動作的編法改了就加一：舊的訓練進度和模型不會被拿來接著用
    actions = 0         # 動作一共幾種（mask 和模型輸出的長度）
    EACH = ()           # 每個動作各一格的欄位：(名稱, 倍率)
    SUMMARY = ()        # 「大方向」的欄位名稱

    def __init__(self):
        self.size = 0
        self.fields = {}
        self.scale = []
        self.define()
        self.each = {name: self.add("each." + name, self.actions, scale) for name, scale in self.EACH}
        self.static = [[float(value) for value in self.about(action)] for action in range(self.actions)]
        self.detail = [True] * self.size
        for name in self.SUMMARY:
            start, count = self.fields[name]
            self.detail[start:start + count] = [False] * count

    def add(self, name, count, scale=1.0):
        self.fields[name] = [self.size, count]
        self.scale += [scale] * count
        self.size += count
        return self.size - count

    def about(self, action):
        raise NotImplementedError

    def blank(self):
        return bytearray(self.size)

    def choice(self, legal):
        mask = bytearray(self.actions)
        for action in legal:
            mask[action] = 1
        return mask

    def define(self):
        raise NotImplementedError

    def decisions(self, record):
        raise NotImplementedError

    def upcoming(self, record):
        """還沒做的下一個決定，讓模型替電腦出牌用（見 model_bot.py）：
        (輪到的座位, x, mask, 把選的動作寫成一筆紀錄的函式)。x、mask 和 decisions() 交出來的是同一種東西。
        這一局已經打完、或紀錄前後對不起來就丟 Skip。還沒有接上的遊戲一律丟 Skip。"""
        raise Skip(f"{self.title}還沒有接上：模型還不能替電腦出牌")


class GongZhu(Game):
    """拱豬。動作：出哪一張牌（52 種）。牌的編號＝花色（黑桃、紅心、梅花、方塊）× 13 ＋ 點數 − 2。"""
    slug, title, version, actions = "gongzhu", "拱豬", 1, 52
    SUITS = "SHCD"
    MODES = ("classic", "strict_swap", "super_slam")
    C2, PIG, SHEEP, TRANSFORMER = 26, 10, 48, 34    # 梅花 2、黑桃 Q、方塊 J、梅花 10
    # 計分牌：紅心 13 張是 0～12，再來是豬、羊、變壓器
    SCORING = [card - 13 if 13 <= card < 26 else {10: 13, 48: 14, 34: 15}.get(card) for card in range(52)]
    # 手上的每一張牌：出了會是這一墩最大的／跟了但比較小／墊牌；是自己這個花色裡最小的／最大的；
    # 外面沒有更大的了／沒有更小的了；外面還有幾張比它大／比它小；自己這個花色有幾張；
    # 另外三家有幾家這個花色已經沒牌；這個花色已經被帶頭出過幾墩
    EACH = (("win", 1), ("duck", 1), ("off", 1), ("lowest", 1), ("highest", 1), ("boss", 1), ("bottom", 1),
            ("higher", 1 / 255), ("lower", 1 / 255), ("length", 1 / 255), ("voids", 1 / 255), ("led", 1 / 255))
    SUMMARY = ("lead", "winning", "void", "trick", "special", "counts", "totals", "mode")

    def define(self):
        add = self.add
        self.HAND = add("hand", 52)                 # 自己手上的牌
        self.UNSEEN = add("unseen", 52)             # 還沒出現、也不在自己手上的牌
        self.TABLE = add("table", 3 * 52)           # 這一墩桌上的牌：下家、對家、上家出的
        self.LEAD = add("lead", 5)                  # 這一墩的花色（最後一格：輪到自己先出）
        self.WINNING = add("winning", 3 + 13)       # 這一墩目前誰最大、最大的那張是幾點
        self.PLAYED = add("played", 4 * 52)         # 前面幾墩誰出過哪些牌（自己、下家、對家、上家）
        self.TAKEN = add("taken", 4 * 16)           # 誰吃了哪些計分牌
        self.VOID = add("void", 3 * 4)              # 另外三家哪個花色已經跟不出來過
        self.TRICK = add("trick", 13)               # 第幾墩
        self.SPECIAL = add("special", 8)            # 豬、羊、變壓器、紅心在不在這一墩桌上；豬、羊、變壓器是不是還在別人手上；自己是不是最後一個出
        self.COUNTS = add("counts", 6, 1 / 255)     # 四個花色外面各還有幾張；桌上有幾張紅心；外面還有幾張紅心
        self.TOTALS = add("totals", 4, 1 / 255)     # 累計分數：自己比平均多多少、另外三家比自己多多少
        self.MODE = add("mode", 3)                  # 計分流派

    def about(self, card):
        """花色、點數、是不是豬羊變壓器、紅心扣幾分。"""
        suit, rank = divmod(card, 13)
        row = [0] * 21
        row[rank] = row[13 + suit] = 1
        row[17], row[18], row[19] = card == self.PIG, card == self.SHEEP, card == self.TRANSFORMER
        if suit == 1:
            row[20] = {12: 50, 11: 40, 10: 30, 9: 20}.get(rank, 10 if rank >= 3 else 0) / 50
        return row

    def card(self, name):
        rank = int(name[1:])
        need(2 <= rank <= 14, f"沒有 {name} 這張牌")
        return self.SUITS.index(name[0]) * 13 + rank - 2

    def card_name(self, card):
        return f"{self.SUITS[card // 13]}{card % 13 + 2}"

    def legal(self, hand, table, trick):
        if not table:
            return {self.C2} if trick == 0 and self.C2 in hand else set(hand)
        lead = table[0][1] // 13
        return {card for card in hand if card // 13 == lead} or set(hand)

    def view(self, me, hand, table, played, taken, void, led, trick, totals, mode):
        x, each = self.blank(), self.each
        seen = set(hand).union(*played)
        on_table = [card for _, card in table]
        seen.update(on_table)
        unseen = [card for card in range(52) if card not in seen]
        hearts = [card for card in on_table if card // 13 == 1]
        for card in hand:
            x[self.HAND + card] = 1
        for card in unseen:
            x[self.UNSEEN + card] = 1
        for seat, card in table:
            x[self.TABLE + ((seat - me) % 4 - 1) * 52 + card] = 1
        lead = top_card = None
        if table:
            lead = table[0][1] // 13
            top_seat, top_card = max((play for play in table if play[1] // 13 == lead), key=lambda play: play[1])
            x[self.LEAD + lead] = 1
            x[self.WINNING + (top_seat - me) % 4 - 1] = 1
            x[self.WINNING + 3 + top_card % 13] = 1
        else:
            x[self.LEAD + 4] = 1
        for seat in range(4):
            place = (seat - me) % 4
            for card in played[seat]:
                x[self.PLAYED + place * 52 + card] = 1
            for card in taken[seat]:
                x[self.TAKEN + place * 16 + card] = 1
            if place:
                for suit in range(4):
                    if void[seat][suit]:
                        x[self.VOID + (place - 1) * 4 + suit] = 1
            behind = totals[me] - sum(totals) / 4 if seat == me else totals[seat] - totals[me]
            x[self.TOTALS + place] = level(behind, -1500, 1500)
        x[self.TRICK + trick] = 1
        for k, card in enumerate((self.PIG, self.SHEEP, self.TRANSFORMER)):
            x[self.SPECIAL + k] = int(card in on_table)
            x[self.SPECIAL + 4 + k] = int(card in unseen)
        x[self.SPECIAL + 3] = int(bool(hearts))
        x[self.SPECIAL + 7] = int(len(table) == 3)
        for suit in range(4):
            x[self.COUNTS + suit] = level(sum(1 for card in unseen if card // 13 == suit), 0, 13)
        x[self.COUNTS + 4] = level(len(hearts), 0, 3)
        x[self.COUNTS + 5] = level(sum(1 for card in unseen if card // 13 == 1), 0, 13)
        if mode in self.MODES:
            x[self.MODE + self.MODES.index(mode)] = 1

        for card in hand:
            suit = card // 13
            mine = [other for other in hand if other // 13 == suit]
            higher = sum(1 for other in unseen if other // 13 == suit and other > card)
            lower = sum(1 for other in unseen if other // 13 == suit and other < card)
            if lead is not None:
                x[each["off" if suit != lead else "win" if card > top_card else "duck"] + card] = 1
            x[each["lowest"] + card] = int(card == min(mine))
            x[each["highest"] + card] = int(card == max(mine))
            x[each["boss"] + card] = int(not higher)
            x[each["bottom"] + card] = int(not lower)
            x[each["higher"] + card] = level(higher, 0, 12)
            x[each["lower"] + card] = level(lower, 0, 12)
            x[each["length"] + card] = level(len(mine), 0, 13)
            x[each["voids"] + card] = level(sum(1 for seat in range(4) if seat != me and void[seat][suit]), 0, 3)
            x[each["led"] + card] = level(led[suit], 0, 4)
        return x

    def decisions(self, record):
        return self.walk(record)

    def upcoming(self, record):
        (seat, x, mask), = self.walk(record, upcoming=True)
        return seat, x, mask, lambda card: {"seat": seat, "card": self.card_name(card)}

    def walk(self, record, upcoming=False):
        """把一局從頭重排一遍，交出紀錄裡的每一手（decisions() 要的那三樣）。
        upcoming 是 True 時紀錄裡的不交，走完之後只交出還沒出的下一手：(輪到的座位, x, mask)。"""
        seats = record["seats"]
        need(len(seats) == 4 and len(set(seats)) == 4, "座位不是四家")
        hands = [{self.card(name) for name in record["hands"][seat]} for seat in seats]
        need(all(len(hand) == 13 for hand in hands) and len(set().union(*hands)) == 52, "發的牌不是一副 52 張")
        human = [not record["players"][seat]["ai"] for seat in seats]
        totals = [record["totals"][seat] for seat in seats]
        mode = record["settings"]["scoringRuleMode"]
        finished = record["status"] == "finished"
        played, taken = [set() for _ in seats], [set() for _ in seats]
        void = [[False] * 4 for _ in seats]
        led = [0] * 4       # 每個花色已經被帶頭出過幾墩
        leader = next(seat for seat in range(4) if self.C2 in hands[seat])
        tricks = record["tricks"]
        table = []
        for number, trick in enumerate(tricks):
            need(len(trick) == 4 or (0 < len(trick) < 4 and number == len(tricks) - 1 and not finished), "有一墩不是四張")
            table = []
            for turn, play in enumerate(trick):
                seat = seats.index(play["seat"])
                need(seat == (leader + turn) % 4, "出牌的順序不對")
                card = self.card(play["card"])
                legal = self.legal(hands[seat], table, number)
                need(card in legal, f"{play['seat']} 出了不能出的 {play['card']}")
                if not upcoming:
                    x = self.view(seat, hands[seat], table, played, taken, void, led, number, totals, mode)
                    yield human[seat], "hint" if play.get("hint") else "", [(x, self.choice(legal), card)]
                hands[seat].remove(card)
                if table and card // 13 != table[0][1] // 13:
                    void[seat][table[0][1] // 13] = True
                table.append((seat, card))
            if len(table) == 4:
                lead = table[0][1] // 13
                led[lead] += 1
                leader = max((play for play in table if play[1] // 13 == lead), key=lambda play: play[1])[0]
                for seat, card in table:
                    played[seat].add(card)
                    if self.SCORING[card] is not None:
                        taken[leader].add(self.SCORING[card])
        if finished:
            need(len(tricks) == 13, "打完的一局不是十三墩")
            for seat, name in enumerate(seats):
                captured = {self.SCORING[self.card(card)] for card in record["result"][name]["captured"]}
                need(taken[seat] == captured, "吃到的計分牌和結果對不起來")
        if upcoming:
            if len(table) == 4:     # 上一墩收完了：輪到吃下它的那一家帶頭
                table = []
            number = len(tricks) - bool(table)
            need(not finished and number < 13, "這一局已經打完了")
            seat = (leader + len(table)) % 4
            legal = self.legal(hands[seat], table, number)
            x = self.view(seat, hands[seat], table, played, taken, void, led, number, totals, mode)
            yield seats[seat], x, self.choice(legal)


class BigTwo(Game):
    """大老二。一手牌拆成幾步：由小到大一張一張選，選完了選「結束」；一張都沒選就結束＝不出。

    動作：0～51 選那一張牌、52 結束。牌的編號＝點數（3 最小、2 最大，0～12）× 4 ＋ 花色（梅花、方塊、紅心、黑桃）。
    """
    slug, title, version, actions = "bigtwo", "大老二", 1, 53
    END = 52
    RANKS = ("3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2")
    SUITS = "CDHS"
    TYPES = ("single", "pair", "straight", "fullhouse", "four", "straightflush", "dragon")
    # 手上還可以選的每一張牌：同點數的自己有兩張／三張／四張；比桌上那一手最大的牌還大；
    # 和剛選的那張同點數／剛好大一點（湊對子、湊順子）；是手上最小的／最大的；外面還有幾張比它大
    EACH = (("pair", 1), ("triple", 1), ("four", 1), ("above", 1), ("same", 1), ("next", 1),
            ("lowest", 1), ("highest", 1), ("stronger", 1 / 255))
    SUMMARY = ("picked", "kind", "passed", "left", "opening", "totals")

    def define(self):
        add = self.add
        self.HAND = add("hand", 52)                 # 自己手上的牌
        self.UNSEEN = add("unseen", 52)             # 還沒出現、也不在自己手上的牌
        self.CHOSEN = add("chosen", 52)             # 這一手已經選了哪幾張
        self.PICKED = add("picked", 6)              # 這一手已經選了幾張（0～5 張以上）
        self.TABLE = add("table", 52)               # 要壓過的那一手的牌
        self.KIND = add("kind", 8 + 3)              # 那一手的牌型（第 8 格：沒有，自己先出）、是誰出的
        self.PASSED = add("passed", 3)              # 另外三家這一輪是不是已經不出了
        self.LEFT = add("left", 3 * 14)             # 另外三家各剩幾張
        self.PLAYED = add("played", 4 * 52)         # 誰出過哪些牌（自己、下家、對家、上家）
        self.OPENING = add("opening", 1)            # 這一局的第一手（要帶梅花 3）
        self.TOTALS = add("totals", 4, 1 / 255)     # 累計分數：自己比平均多多少、另外三家比自己多多少

    def about(self, action):
        """點數、花色；最後一格：這是「結束」不是牌。"""
        row = [0] * 18
        if action == self.END:
            row[17] = 1
        else:
            row[action // 4] = row[13 + action % 4] = 1
        return row

    def card(self, name):
        return self.RANKS.index(name[1:]) * 4 + self.SUITS.index(name[0])

    def legal(self, hand, chosen, table, opening):
        if opening and not chosen:
            return {0}      # 第一手要帶梅花 3，它最小，所以一定最先選
        legal = {card for card in hand if card > (chosen[-1] if chosen else -1)} if len(chosen) < 13 else set()
        sizes = (len(table[1]), 5, 13) if table else (1, 2, 5, 13)      # 同樣張數才能比，五張的鐵支、同花順和一條龍可以壓任何牌
        if len(chosen) in sizes or (table and not chosen):
            legal.add(self.END)
        return legal

    def view(self, me, hands, chosen, table, passed, played, opening, totals):
        x = self.blank()
        seen = hands[me].union(*played)
        for card in hands[me]:
            x[self.HAND + card] = 1
        for card in range(52):
            if card not in seen:
                x[self.UNSEEN + card] = 1
        for card in chosen:
            x[self.CHOSEN + card] = 1
        x[self.PICKED + min(len(chosen), 5)] = 1
        if table:
            who, cards, kind = table
            for card in cards:
                x[self.TABLE + card] = 1
            if kind in self.TYPES:
                x[self.KIND + self.TYPES.index(kind)] = 1
            x[self.KIND + 8 + (who - me) % 4 - 1] = 1
        else:
            x[self.KIND + 7] = 1
        for seat in range(4):
            place = (seat - me) % 4
            for card in played[seat]:
                x[self.PLAYED + place * 52 + card] = 1
            if place:
                x[self.PASSED + place - 1] = int(passed[seat])
                x[self.LEFT + (place - 1) * 14 + len(hands[seat])] = 1
            behind = totals[me] - sum(totals) / 4 if seat == me else totals[seat] - totals[me]
            x[self.TOTALS + place] = level(behind, -200, 200)
        x[self.OPENING] = int(opening)

        each, hand = self.each, hands[me]
        ranks = [0] * 13
        for card in hand:
            ranks[card // 4] += 1
        top = max(table[1]) if table else -1
        last = chosen[-1] if chosen else None
        for card in hand:
            if last is not None and card <= last:
                continue        # 由小到大選，比剛選的那張小的不能再選了
            same = ranks[card // 4]
            x[each["pair"] + card] = int(same >= 2)
            x[each["triple"] + card] = int(same >= 3)
            x[each["four"] + card] = int(same == 4)
            x[each["above"] + card] = int(card > top)
            if last is not None:
                x[each["same"] + card] = int(card // 4 == last // 4)
                x[each["next"] + card] = int(card // 4 == last // 4 + 1)
            x[each["lowest"] + card] = int(card == min(hand))
            x[each["highest"] + card] = int(card == max(hand))
            x[each["stronger"] + card] = level(sum(1 for other in range(card + 1, 52) if other not in seen), 0, 39)
        return x

    def decisions(self, record):
        hands = [{self.card(name) for name in hand} for hand in record["hands"]]
        need(len(hands) == 4 and all(len(hand) == 13 for hand in hands) and len(set().union(*hands)) == 52,
             "發的牌不是一副 52 張")
        human = [not player["ai"] for player in record["players"]]
        totals = record["totals"]
        played = [set() for _ in range(4)]
        turn = next(seat for seat in range(4) if 0 in hands[seat])
        passed, table, opening = [False] * 4, None, True    # table：要壓過的那一手（誰出的、牌、牌型）
        for action in record["actions"]:
            seat = action["seat"]
            need(seat == turn, "出牌的順序不對")
            cards = [] if action.get("pass") else sorted(self.card(name) for name in action["cards"])
            if cards:
                need(len(cards) in (1, 2, 5, 13) and len(set(cards)) == len(cards) and hands[seat].issuperset(cards),
                     "出的牌不在手上")
            else:
                need(table is not None, "輪到先出的人不能不出")
            need(table is None or table[0] != seat, "沒有人壓過，卻還要壓自己的牌")
            steps, chosen = [], []
            for card in cards + [self.END]:
                legal = self.legal(hands[seat], chosen, table, opening)
                need(card in legal, "出了不能出的牌")
                x = self.view(seat, hands, chosen, table, passed, played, opening, totals)
                steps.append((x, self.choice(legal), card))
                chosen.append(card)
            yield human[seat], "hint" if action.get("hint") else "", steps
            if cards:
                hands[seat].difference_update(cards)
                played[seat].update(cards)
                table, opening = (seat, cards, action["type"]), False
                if not hands[seat]:
                    turn = None     # 出完了，這一局結束
                    continue
            else:
                passed[seat] = True
            if sum(passed) == 3:    # 另外三家都不出：最後出牌的人重新先出
                passed, turn, table = [False] * 4, table[0], None
            else:
                turn = next(s % 4 for s in range(turn + 1, turn + 4) if not passed[s % 4])
        result = record.get("result")
        if result:
            left = [{self.card(name) for name in hand} for hand in result["left"]]
            need(left == hands and not hands[result["winner"]], "剩下的牌和結果對不起來")


class Mahjong(Game):
    """台灣十六張麻將。牌的編號和紀錄一樣：0～8 萬、9～17 筒、18～26 條、27～30 東南西北、31～33 中發白。

    動作：0～33 打那一張牌；34 過、35 碰、36 槓（別人打的牌）、37～39 吃（吃進來的牌是順子裡最小／中間／最大的那張）；
    40～73 暗槓那一種牌、74～107 加槓那一種牌。胡不胡不在裡面（能胡就胡，不用學）。
    """
    slug, title, version, actions = "mahjong", "台灣十六張麻將", 1, 108
    PASS, PUNG, KONG, CHOW, CONCEALED, ADDED = 34, 35, 36, 37, 40, 74
    RESERVE = 16        # 牌牆剩 16 張就流局
    TILES = sorted(list(range(34)) * 4 + list(range(34, 42)))
    # 「打這一張」的每一種牌：手上有兩張／三張／四張；手上有沒有它左邊一張、右邊一張、左邊隔一張、右邊隔一張（湊順子）；
    # 是不是剛摸進來的那一張；是不是自己的門風、圈風或三元牌；還有幾張沒看到；四家牌河裡已經有幾張
    EACH = (("two", 1), ("three", 1), ("four", 1), ("left", 1), ("right", 1), ("left2", 1), ("right2", 1),
            ("drawn", 1), ("valued", 1), ("unseen", 1 / 255), ("river", 1 / 255))
    SUMMARY = ("moment", "asker", "sets", "flowers", "table", "wall", "streak", "scores", "made")

    def about(self, action):
        """哪一種動作（打、過、碰、槓、吃的三種、暗槓、加槓）；牌是萬筒條風還是三元、幾號、是不是么九、是不是字牌。"""
        row = [0] * 25
        if action < 34:
            kind, tile = 0, action
        elif action < self.CONCEALED:
            kind, tile = action - 33, None
        else:
            kind, tile = (7, action - self.CONCEALED) if action < self.ADDED else (8, action - self.ADDED)
        row[kind] = 1
        if tile is not None and tile < 27:
            row[9 + tile // 9] = row[14 + tile % 9] = 1
            row[23] = tile % 9 in (0, 8)
        elif tile is not None:
            row[9 + (3 if tile < 31 else 4)] = row[24] = 1
        return row

    def define(self):
        add = self.add
        self.HAND = add("hand", 34 * 4)             # 手牌：每種牌有幾張（至少 1、2、3、4 張各一格）
        self.DRAWN = add("drawn", 34)               # 剛摸進來的那一張
        self.MOMENT = add("moment", 3)              # 摸牌後要打牌／吃碰後要打牌／別人打牌、問要不要吃碰槓
        self.OFFER = add("offer", 34)               # 別人打出來、問要不要吃碰槓的那一張
        self.ASKER = add("asker", 3)                # 那一張是誰打的（下家、對家、上家）
        self.MELDS = add("melds", 4 * 34 * 4)       # 四家亮出來的面子裡每種牌有幾張（自己的暗槓也算；別人的暗槓看不到）
        self.SETS = add("sets", 4 * 6)              # 四家各有幾組面子
        self.RIVER = add("river", 4 * 34 * 4)       # 四家牌河裡每種牌有幾張
        self.LAST = add("last", 3 * 34)             # 另外三家最近打的那一張
        self.UNSEEN = add("unseen", 34 * 4)         # 每種牌還有幾張沒看到
        self.FLOWERS = add("flowers", 4 * 9)        # 四家各有幾張花
        self.BLOOMS = add("blooms", 8)              # 自己有哪幾張花
        self.TABLE = add("table", 12)               # 莊家是誰、圈風、自己的門風
        self.WALL = add("wall", 1, 1 / 255)         # 牌牆還能摸幾張
        self.STREAK = add("streak", 1, 1 / 255)     # 連莊數
        self.SCORES = add("scores", 4, 1 / 255)     # 累計分數：自己比平均多多少、另外三家比自己多多少
        self.MADE = add("made", 1, 1 / 255)         # 自己已經打了幾張

    def own_choices(self, hand, melds, may_kong):
        legal = set(hand)       # 打哪一張
        if may_kong:
            legal.update(self.CONCEALED + tile for tile in set(hand) if hand.count(tile) == 4)
            legal.update(self.ADDED + meld["tiles"][0] for meld in melds
                         if meld["type"] == "pung" and meld["tiles"][0] in hand)
        return legal

    def claim_choices(self, hand, me, offer, live):
        who, tile = offer
        legal = {self.PASS}
        if hand.count(tile) >= 2:
            legal.add(self.PUNG)
        if hand.count(tile) >= 3 and live > 0:
            legal.add(self.KONG)
        if me == (who + 1) % 4 and tile < 27:       # 只能吃上家的牌
            for place in range(3):      # 吃進來的牌排在順子的第幾張
                low = tile - place
                run = [low, low + 1, low + 2]
                if low >= 0 and low // 9 == (low + 2) // 9 and all(t in hand for t in run if t != tile):
                    legal.add(self.CHOW + place)
        return legal

    def view(self, me, record, hands, melds, rivers, flowers, last, moment, drawn, offer, live, made):
        x = self.blank()
        seen = [0] * 34
        for tile in hands[me]:
            x[self.HAND + tile * 4 + seen[tile]] = 1
            seen[tile] += 1
        if drawn is not None:
            x[self.DRAWN + drawn] = 1
        x[self.MOMENT + moment] = 1
        if offer:
            x[self.OFFER + offer[1]] = 1
            x[self.ASKER + (offer[0] - me) % 4 - 1] = 1
        scores = [player["score"] for player in record["players"]]
        for seat in range(4):
            place = (seat - me) % 4
            for field, tiles in ((self.MELDS, [t for m in melds[seat] if seat == me or not m["concealed"] for t in m["tiles"]]),
                                 (self.RIVER, rivers[seat])):
                count = [0] * 34
                for tile in tiles:
                    x[field + (place * 34 + tile) * 4 + count[tile]] = 1
                    count[tile] += 1
                    seen[tile] += 1
            x[self.SETS + place * 6 + min(len(melds[seat]), 5)] = 1
            x[self.FLOWERS + place * 9 + min(len(flowers[seat]), 8)] = 1
            if place and last[seat] is not None:
                x[self.LAST + (place - 1) * 34 + last[seat]] = 1
            behind = scores[me] - sum(scores) / 4 if seat == me else scores[seat] - scores[me]
            x[self.SCORES + place] = level(behind, -6000, 6000)
        for flower in flowers[me]:
            x[self.BLOOMS + flower - 34] = 1
        for tile in range(34):
            for k in range(4 - seen[tile]):
                x[self.UNSEEN + tile * 4 + k] = 1
        x[self.TABLE + (record["dealer"] - me) % 4] = 1
        x[self.TABLE + 4 + record["roundWind"] % 4] = 1
        x[self.TABLE + 8 + record["players"][me]["wind"] % 4] = 1
        x[self.WALL] = level(live, 0, 80)
        x[self.STREAK] = level(record["dealerStreak"], 0, 8)
        x[self.MADE] = level(made, 0, 30)

        if moment == 2:
            return x        # 問要不要吃碰槓的時候不能打牌，「打這一張」的描述用不到
        each, hand = self.each, hands[me]
        thrown = [0] * 34
        for river in rivers:
            for tile in river:
                thrown[tile] += 1
        valued = (27 + record["players"][me]["wind"] % 4, 27 + record["roundWind"] % 4, 31, 32, 33)
        for tile in set(hand):
            held = hand.count(tile)
            x[each["two"] + tile] = int(held >= 2)
            x[each["three"] + tile] = int(held >= 3)
            x[each["four"] + tile] = int(held == 4)
            if tile < 27:
                number = tile % 9
                x[each["left"] + tile] = int(number >= 1 and tile - 1 in hand)
                x[each["right"] + tile] = int(number <= 7 and tile + 1 in hand)
                x[each["left2"] + tile] = int(number >= 2 and tile - 2 in hand)
                x[each["right2"] + tile] = int(number <= 6 and tile + 2 in hand)
            x[each["drawn"] + tile] = int(tile == drawn)
            x[each["valued"] + tile] = int(tile in valued)
            x[each["unseen"] + tile] = level(4 - seen[tile], 0, 4)
            x[each["river"] + tile] = level(thrown[tile], 0, 4)
        return x

    def decisions(self, record):
        wall, dealer, players = record["wall"], record["dealer"], record["players"]
        need(sorted(wall) == self.TILES, "牌牆不是完整的一副牌")
        head, tail = 0, len(wall) - 1
        hands = [[] for _ in range(4)]
        for _ in range(4):      # 發牌：從莊家開始每人一次拿四張，拿四輪
            for k in range(4):
                hands[(dealer + k) % 4] += wall[head:head + 4]
                head += 4
        need([sorted(hand) for hand in hands] == [sorted(hand) for hand in record["dealt"]], "發的牌和牌牆對不起來")
        human = [not player["ai"] for player in players]
        melds, flowers, rivers = [[] for _ in range(4)], [[] for _ in range(4)], [[] for _ in range(4)]
        fresh = [None] * 4      # 剛摸進來、還沒打出去的那一張（吃碰之後是 None：不能槓）
        last = [None] * 4       # 每一家最近打的那一張
        made = [0] * 4          # 每一家打過幾張
        offer = None            # 剛被打出來、還可以吃碰槓的牌：(誰打的, 哪一張)
        actions = record["actions"]

        def take(seat, tile, times=1):
            for _ in range(times):
                need(tile in hands[seat], "用了手上沒有的牌")
                hands[seat].remove(tile)

        for entry in actions:
            seat, kind, tile = entry["s"], entry["a"], entry["t"]
            need(seat in (0, 1, 2, 3) and isinstance(tile, int) and 0 <= tile < 42, "動作的座位或牌不對")
            mark = "auto" if entry.get("auto") else "hint" if entry.get("hint") else ""
            live = tail - head + 1 - self.RESERVE
            if kind == "draw":
                need(head <= tail and tile == wall[tail if entry.get("back") else head], "摸到的不是牌牆的下一張")
                if entry.get("back"):
                    tail -= 1
                else:
                    head += 1
                hands[seat].append(tile)
                fresh[seat], offer = (tile if tile < 34 else None), None
            elif kind == "flower":
                need(tile >= 34, "補花的不是花牌")
                take(seat, tile)
                flowers[seat].append(tile)
                fresh[seat] = None
            elif kind in ("discard", "concealedKong", "addedKong"):
                need(tile < 34, "花牌不能打也不能槓")
                legal = self.own_choices(hands[seat], melds[seat], fresh[seat] is not None and live > 0)
                chosen = tile + {"discard": 0, "concealedKong": self.CONCEALED, "addedKong": self.ADDED}[kind]
                need(chosen in legal, f"座位 {seat} 不能{kind}這一張")
                x = self.view(seat, record, hands, melds, rivers, flowers, last, 0 if fresh[seat] is not None else 1,
                              fresh[seat], None, live, made[seat])
                yield human[seat], mark, [(x, self.choice(legal), chosen)]
                if kind == "discard":
                    take(seat, tile)
                    rivers[seat].append(tile)
                    last[seat], offer = tile, (seat, tile)
                    made[seat] += 1
                elif kind == "concealedKong":
                    take(seat, tile, 4)
                    melds[seat].append({"type": "kong", "tiles": [tile] * 4, "concealed": True})
                else:
                    take(seat, tile)
                    if not entry.get("robbed"):     # 被搶槓的話沒槓成，那一張被胡走
                        pung = next(meld for meld in melds[seat] if meld["type"] == "pung" and meld["tiles"][0] == tile)
                        pung["type"] = "kong"
                        pung["tiles"].append(tile)
                fresh[seat] = None
            elif kind in ("chow", "pung", "kong", "pass"):
                if entry.get("rob"):
                    continue        # 可以搶槓但不搶：這是要不要胡，不學
                need(offer == (entry["from"], tile) and seat != offer[0], "沒有人打這一張給他吃碰槓")
                legal = self.claim_choices(hands[seat], seat, offer, live)
                if kind == "chow":
                    own = sorted(entry["using"])
                    need(len(own) == 2 and len(set(own + [tile])) == 3, "吃的牌不成順子")
                    chosen = self.CHOW + tile - min(own + [tile])
                else:
                    own = [tile] * {"pung": 2, "kong": 3, "pass": 0}[kind]
                    chosen = {"pung": self.PUNG, "kong": self.KONG, "pass": self.PASS}[kind]
                need(chosen in legal, f"座位 {seat} 不能{kind}這一張")
                if human[seat]:     # 電腦不要的時候沒有留紀錄，只學它要的那幾次會學偏，所以電腦的吃碰槓不學
                    x = self.view(seat, record, hands, melds, rivers, flowers, last, 2, None, offer, live, made[seat])
                    yield True, mark, [(x, self.choice(legal), chosen)]
                if kind != "pass":
                    need(rivers[offer[0]] and rivers[offer[0]].pop() == tile, "被吃碰槓的不是剛打的那一張")
                    for used in own:
                        take(seat, used)
                    melds[seat].append({"type": kind, "tiles": sorted(own + [tile]), "concealed": False})
                    fresh[seat], offer = None, None
            else:
                raise Skip(f"不認得的動作 {kind}")

        # 重排到最後，四家的牌要和紀錄存下來的一樣
        result = record.get("result")
        if result and result["type"] == "win" and not result["selfDraw"] and result["winTile"] is not None:
            if not (actions and actions[-1].get("robbed")):
                payer = rivers[result["payer"]]
                need(payer and payer.pop() == result["winTile"], "胡的不是最後打出來的那一張")
            for winner in result["winners"]:
                hands[winner["seat"]].append(result["winTile"])
        for seat, saved in enumerate(players):
            same = (sorted(hands[seat]) == sorted(saved["hand"]) and sorted(flowers[seat]) == sorted(saved["flowers"])
                    and rivers[seat] == saved["discards"]
                    and [(m["type"], sorted(m["tiles"]), m["concealed"]) for m in melds[seat]]
                    == [(m["type"], sorted(m["tiles"]), bool(m["concealed"])) for m in saved["melds"]])
            need(same, f"重排出來座位 {seat} 的牌和紀錄最後的牌對不起來")


class MahjongMe(Mahjong):
    slug, title = "mahjong-me", "台灣麻將（自我模式）"


class Xiangqi(Game):
    """中國象棋。一手拆成兩步：先選哪一顆（它在哪一點）、再選走到哪一點。動作：棋盤上的 90 個點。

    棋盤一律轉成「做決定的人在下方」（黑方的回合就把棋盤轉 180 度，和他在畫面上看到的一樣），點＝列 × 9 ＋ 行。
    """
    slug, title, version, actions = "xiangqi", "中國象棋", 1, 90
    KING, ADVISOR, ELEPHANT, HORSE, ROOK, CANNON, PAWN = 1, 2, 3, 4, 5, 6, 7
    AROUND = ((-1, 0), (1, 0), (0, -1), (0, 1))
    SLANT = ((-1, -1), (-1, 1), (1, -1), (1, 1))
    # 棋盤上的每一點：上面是自己的帥仕相傌俥炮兵哪一種、對方的哪一種；自己在這一點的子有幾種走法、能不能吃到子
    EACH = tuple((name, 1) for name in ("mine1", "mine2", "mine3", "mine4", "mine5", "mine6", "mine7",
                                        "theirs1", "theirs2", "theirs3", "theirs4", "theirs5", "theirs6", "theirs7",
                                        "takes")) + (("moves", 1 / 255),)
    SUMMARY = ("second", "check", "ply")

    def define(self):
        add = self.add
        self.FROM = add("from", 90)                 # 第二步才有：已經選了哪一顆
        self.SECOND = add("second", 1)              # 現在是第二步（選走到哪）
        self.LAST = add("last", 180)                # 對方上一手從哪一點走到哪一點
        self.CHECK = add("check", 1)                # 自己正被將軍
        self.PLY = add("ply", 2, 1 / 255)           # 第幾手、連續幾手沒有吃子

    def about(self, at):
        """第幾列、第幾行。"""
        row = [0] * 19
        row[at // 9] = row[10 + at % 9] = 1
        return row

    def start(self):
        board = [0] * 90
        for col, kind in enumerate((5, 4, 3, 2, 1, 2, 3, 4, 5)):
            board[col], board[81 + col] = 16 + kind, kind
        for col in (1, 7):
            board[18 + col], board[63 + col] = 16 + self.CANNON, self.CANNON
        for col in (0, 2, 4, 6, 8):
            board[27 + col], board[54 + col] = 16 + self.PAWN, self.PAWN
        return board

    def moves(self, board, at):
        """at 這一點上自己的子可以走到哪些點（不管走了以後自己會不會被將軍）。board：1～7 自己的子、9～15 對方的子、0 空的。"""
        kind, row, col = board[at], at // 9, at % 9
        found = set()

        def reach(r, c, rows=(0, 9), cols=(0, 8)):
            if rows[0] <= r <= rows[1] and cols[0] <= c <= cols[1] and not 1 <= board[r * 9 + c] <= 7:
                found.add(r * 9 + c)

        if kind == self.KING:
            for dr, dc in self.AROUND:
                reach(row + dr, col + dc, (7, 9), (3, 5))
        elif kind == self.ADVISOR:
            for dr, dc in self.SLANT:
                reach(row + dr, col + dc, (7, 9), (3, 5))
        elif kind == self.ELEPHANT:
            for dr, dc in self.SLANT:
                if 5 <= row + 2 * dr <= 9 and 0 <= col + 2 * dc <= 8 and not board[(row + dr) * 9 + col + dc]:
                    reach(row + 2 * dr, col + 2 * dc)
        elif kind == self.HORSE:
            for dr, dc in self.AROUND:
                if 0 <= row + dr <= 9 and 0 <= col + dc <= 8 and not board[(row + dr) * 9 + col + dc]:
                    for side in (-1, 1):
                        reach(row + 2 * dr + (side if not dr else 0), col + 2 * dc + (side if not dc else 0))
        elif kind == self.PAWN:
            reach(row - 1, col)
            if row <= 4:        # 過河以後可以橫走
                reach(row, col - 1)
                reach(row, col + 1)
        elif kind in (self.ROOK, self.CANNON):
            for dr, dc in self.AROUND:
                r, c, jumped = row + dr, col + dc, False
                while 0 <= r <= 9 and 0 <= c <= 8:
                    piece = board[r * 9 + c]
                    if not piece and not jumped:
                        found.add(r * 9 + c)
                    elif piece and (jumped or kind == self.ROOK):
                        if piece >= 9:
                            found.add(r * 9 + c)
                        break
                    elif piece:
                        jumped = True       # 炮架
                    r, c = r + dr, c + dc
        return found

    def view(self, board, reach, chosen, last, check, ply, quiet):
        x, each = self.blank(), self.each
        for at, piece in enumerate(board):
            if piece:
                x[each[f"mine{piece}" if piece <= 7 else f"theirs{piece - 8}"] + at] = 1
        for at, targets in reach.items():
            x[each["moves"] + at] = level(len(targets), 0, 17)
            x[each["takes"] + at] = int(any(board[target] for target in targets))
        if chosen is not None:
            x[self.FROM + chosen] = x[self.SECOND] = 1
        if last:
            x[self.LAST + last[0]] = x[self.LAST + 90 + last[1]] = 1
        x[self.CHECK] = int(check)
        x[self.PLY] = level(ply, 0, 200)
        x[self.PLY + 1] = level(quiet, 0, 120)
        return x

    def decisions(self, record):
        board = self.start()
        human = {player["color"]: not player["ai"] for player in record["players"].values()}
        need(sorted(human) == [0, 1], "雙方不是一紅一黑")
        last, check, quiet = None, False, 0
        for ply, move in enumerate(record["moves"]):
            color, source, target = move["color"], move["from"], move["to"]
            need(move["ply"] == ply + 1 and color == ply % 2, "手順不對")       # 紅方先走
            need(0 <= source < 90 and 0 <= target < 90 and board[source] == color * 16 + move["kind"], "要走的棋子不在那一點")
            taken = board[target]
            need(move["captured"] == ({"color": taken >> 4, "kind": taken & 15} if taken else None), "吃的子和棋盤對不起來")
            turned = (lambda at: at) if color == 0 else (lambda at: 89 - at)
            mine = [0] * 90
            for at, piece in enumerate(board):
                if piece:
                    mine[turned(at)] = (piece & 15) + (0 if piece >> 4 == color else 8)
            reach = {at: self.moves(mine, at) for at in range(90) if 1 <= mine[at] <= 7}
            starts = {at for at, targets in reach.items() if targets}
            a, b = turned(source), turned(target)
            need(b in reach[a], f"第 {ply + 1} 手 {move.get('text', '')} 不合走法")
            before = (turned(last[0]), turned(last[1])) if last else None
            steps = [(self.view(mine, reach, None, before, check, ply, quiet), self.choice(starts), a),
                     (self.view(mine, reach, a, before, check, ply, quiet), self.choice(reach[a]), b)]
            yield human[color], "hint" if move.get("hint") else "", steps
            board[target], board[source] = board[source], 0
            last, check, quiet = (source, target), bool(move.get("check")), 0 if taken else quiet + 1


class Reversi(Game):
    """黑白棋。動作：下在哪一格（64 種，格＝列 × 8 ＋ 行）。"""
    slug, title, version, actions = "reversi", "黑白棋", 1, 64
    WAYS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
    # 棋盤上的每一格：上面是自己的子、對方的子；下在這裡會翻幾子
    EACH = (("mine", 1), ("theirs", 1), ("flips", 1 / 255))
    SUMMARY = ("count",)

    def define(self):
        add = self.add
        self.LAST = add("last", 64 + 1)             # 對方上一手下在哪（最後一格：對方沒地方下，跳過）
        self.COUNT = add("count", 3, 1 / 255)       # 自己幾子、對方幾子、第幾手

    def about(self, at):
        """第幾列、第幾行；是不是角、角的斜對面（星位）、角的隔壁、邊。"""
        line, column = divmod(at, 8)
        near = (min(line, 7 - line), min(column, 7 - column))       # 離最近的邊幾格
        row = [0] * 20
        row[line] = row[8 + column] = 1
        row[16], row[17], row[18] = near == (0, 0), near == (1, 1), sorted(near) == [0, 1]
        row[19] = 0 in near
        return row

    def flips(self, board, at, color):
        """color 下在 at 會翻哪些子：八個方向上被自己的子夾住的對方的子。"""
        found = []
        for dr, dc in self.WAYS:
            run, r, c = [], at // 8 + dr, at % 8 + dc
            while 0 <= r < 8 and 0 <= c < 8 and board[r * 8 + c] == 3 - color:
                run.append(r * 8 + c)
                r, c = r + dr, c + dc
            if run and 0 <= r < 8 and 0 <= c < 8 and board[r * 8 + c] == color:
                found += run
        return found

    def decisions(self, record):
        board = [0] * 64
        board[27] = board[36] = 2       # 白
        board[28] = board[35] = 1       # 黑
        players = record["players"]
        last, number = None, 0
        for move in record["moves"]:
            color = move["color"]
            need(color in (1, 2) and players[move["seat"]]["color"] == color, "下棋的人和顏色對不起來")
            options = {at: self.flips(board, at, color) for at in range(64) if not board[at]}
            options = {at: turned for at, turned in options.items() if turned}
            if move.get("pass"):
                need(not options, "還有地方下卻跳過")
                last = 64
                continue
            number += 1
            at = move["sq"]
            need(move["n"] == number and at in options and len(options[at]) == move["flips"], "下的位置或翻的子數不對")
            x = self.blank()
            for k, piece in enumerate(board):
                if piece:
                    x[self.each["mine" if piece == color else "theirs"] + k] = 1
            for k, turned in options.items():
                x[self.each["flips"] + k] = level(len(turned), 0, 18)
            if last is not None:
                x[self.LAST + last] = 1
            x[self.COUNT] = level(board.count(color), 0, 64)
            x[self.COUNT + 1] = level(board.count(3 - color), 0, 64)
            x[self.COUNT + 2] = level(number, 0, 60)
            yield not players[move["seat"]]["ai"], "hint" if move.get("hint") else "", [(x, self.choice(options), at)]
            for k in options[at] + [at]:
                board[k] = color
            last = at
        result = record.get("result")
        if result:
            need((board.count(1), board.count(2)) == (result["black"], result["white"]), "下完的子數和結果對不起來")


class Banqi(Game):
    """暗棋。一手是一步或兩步：先選一格（沒翻開的＝翻它；自己的子＝要走它），走子的話再選走到哪一格。

    動作：棋盤上的 32 格（格＝列 × 8 ＋ 行）。棋子的編號和紀錄一樣：1～7 紅方帥仕相俥傌炮兵、8～14 黑方、15 還沒翻開。
    """
    slug, title, version, actions = "banqi", "暗棋", 1, 32
    HIDDEN = 15
    COUNTS = (1, 2, 2, 2, 2, 2, 5)          # 每一方帥仕相俥傌炮兵各幾枚
    SLOTS = (0, 1, 3, 5, 7, 9, 11)          # 上面七種在「還有幾枚」欄位裡各從第幾格開始
    KING, CANNON, PAWN = 0, 5, 6
    AROUND = ((-1, 0), (1, 0), (0, -1), (0, 1))
    # 棋盤上的每一格：上面是自己的帥仕相俥傌炮兵哪一種、對方的哪一種、還沒翻開、空的；自己在這一格的子能不能吃到子
    EACH = tuple((name, 1) for name in ("mine0", "mine1", "mine2", "mine3", "mine4", "mine5", "mine6",
                                        "theirs0", "theirs1", "theirs2", "theirs3", "theirs4", "theirs5", "theirs6",
                                        "hidden", "empty", "takes"))
    SUMMARY = ("pool", "dead", "second", "quiet", "unset")

    def about(self, at):
        """第幾列、第幾行。"""
        row = [0] * 12
        row[at // 8] = row[4 + at % 8] = 1
        return row

    def define(self):
        add = self.add
        self.POOL = add("pool", 2 * 16)             # 還沒翻開的子裡，自己的、對方的每一種還有幾枚
        self.DEAD = add("dead", 2 * 16)             # 自己的、對方的每一種被吃掉幾枚
        self.FROM = add("from", 32)                 # 第二步才有：已經選了哪一枚
        self.SECOND = add("second", 1)              # 現在是第二步（選走到哪）
        self.LAST = add("last", 64)                 # 對方上一手：從哪一格、到哪一格（翻棋只有「到哪一格」）
        self.QUIET = add("quiet", 1, 1 / 255)       # 連續幾手沒翻棋也沒吃子
        self.UNSET = add("unset", 1)                # 還沒決定誰是哪一色（第一手）

    def eats(self, attacker, victim):
        if attacker == self.CANNON or (attacker == self.KING and victim == self.PAWN):
            return False
        return (attacker == self.PAWN and victim == self.KING) or attacker <= victim

    def moves(self, board, at, color):
        """at 這一格上 color 的子可以走到哪些格：走到隔壁的空格、吃隔壁比自己小的，炮要隔一枚子跳著吃。"""
        kind, found = (board[at] - 1) % 7, set()
        for dr, dc in self.AROUND:
            line, r, c = [], at // 8 + dr, at % 8 + dc
            while 0 <= r < 4 and 0 <= c < 8:
                line.append(r * 8 + c)
                r, c = r + dr, c + dc
            if not line:
                continue
            piece = board[line[0]]
            if not piece:
                found.add(line[0])
            elif piece != self.HIDDEN and (piece <= 7) != (color == 0) and self.eats(kind, (piece - 1) % 7):
                found.add(line[0])
            if kind == self.CANNON:
                pieces = [k for k in line if board[k]]
                if len(pieces) >= 2 and board[pieces[1]] != self.HIDDEN and (board[pieces[1]] <= 7) != (color == 0):
                    found.add(pieces[1])
        return found

    def view(self, board, color, reach, pool, dead, chosen, last, quiet):
        x, each = self.blank(), self.each
        for at, piece in enumerate(board):
            if piece == self.HIDDEN:
                name = "hidden"
            elif not piece:
                name = "empty"
            else:
                name = ("mine" if (piece <= 7) == (color == 0) else "theirs") + str((piece - 1) % 7)
            x[each[name] + at] = 1
        for at, targets in reach.items():
            x[each["takes"] + at] = int(any(board[target] for target in targets))
        if color is None:
            x[self.UNSET] = 1
        else:
            for code in range(1, 15):
                slot = (0 if (code <= 7) == (color == 0) else 16) + self.SLOTS[(code - 1) % 7]
                for k in range(pool[code]):
                    x[self.POOL + slot + k] = 1
                for k in range(dead[code]):
                    x[self.DEAD + slot + k] = 1
        if chosen is not None:
            x[self.FROM + chosen] = x[self.SECOND] = 1
        if last:
            if last[0] is not None:
                x[self.LAST + last[0]] = 1
            x[self.LAST + 32 + last[1]] = 1
        x[self.QUIET] = level(quiet, 0, 50)
        return x

    def decisions(self, record):
        need(record.get("format") == "banqi-public-v1", "不認得的棋譜格式")
        board = [self.HIDDEN] * 32
        pool = [0] + list(self.COUNTS) * 2      # 每一種棋子還有幾枚沒翻開
        dead = [0] * 15
        colors = {}                             # 第一手翻出什麼顏色，翻的人就拿那一色（0 紅、1 黑）
        last, quiet, turn = None, 0, None
        for number, move in enumerate(record["moves"]):
            seat, kind = move["seat"], move["kind"]
            need(move["n"] == number + 1 and seat in ("south", "north") and turn in (None, seat), "手順不對")
            other = "north" if seat == "south" else "south"
            color = colors.get(seat)
            reach = {} if color is None else {
                at: self.moves(board, at, color) for at, piece in enumerate(board)
                if piece and piece != self.HIDDEN and (piece <= 7) == (color == 0)}
            starts = {at for at, piece in enumerate(board) if piece == self.HIDDEN}
            starts.update(at for at, targets in reach.items() if targets)
            first = self.view(board, color, reach, pool, dead, None, last, quiet)
            if kind == "flip":
                at, code = move["sq"], move["code"]
                need(board[at] == self.HIDDEN and 1 <= code <= 14 and pool[code] > 0, "翻的不是蓋著的棋，或翻出不該有的子")
                steps = [(first, self.choice(starts), at)]
            else:
                source, target = move["from"], move["to"]
                need(kind in ("move", "capture") and source in reach and target in reach[source]
                     and board[source] == move["code"] and board[target] == move["captured"], "走法不合規則")
                steps = [(first, self.choice(starts), source),
                         (self.view(board, color, reach, pool, dead, source, last, quiet), self.choice(reach[source]), target)]
            yield not record["players"][seat]["ai"], "hint" if move.get("hint") else "", steps
            if kind == "flip":
                board[at] = code
                pool[code] -= 1
                if color is None:
                    colors[seat] = 0 if code <= 7 else 1
                    colors[other] = 1 - colors[seat]
                last, quiet = (None, at), 0
            else:
                if board[target]:
                    dead[board[target]] += 1
                last, quiet = (source, target), 0 if board[target] else quiet + 1
                board[target], board[source] = board[source], 0
            need(move["color"] == colors[seat], "棋子的顏色和先前的對不起來")
            turn = other
        need(board == list(record["state"]["board"]), "重排出來的棋盤和紀錄最後的棋盤對不起來")


GAMES = {game.slug: game for game in (GongZhu, BigTwo, Mahjong, MahjongMe, Xiangqi, Reversi, Banqi)}


# ===================== 一個遊戲的全部紀錄 → 訓練資料 =====================

def read_records(folder):
    """folder 底下每一局的紀錄（依檔名，也就是依時間排）；讀不出來的檔案另外列出來。"""
    records, broken = [], []
    for path in sorted(folder.rglob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(record, dict) or not isinstance(record.get("id"), str):
                raise ValueError("不是對局紀錄")
            records.append(record)
        except (OSError, ValueError) as error:
            broken.append((path.name, str(error)))
    return records, broken




class Dataset:
    """一個遊戲的訓練資料。每一筆是一步：x（看到的）、mask（可以選的）、y（選了什麼）、group（屬於第幾個決定）。

    分成兩份：[0] 拿來練，[1] 驗證用（不練，用來檢查學得怎麼樣）。整局整局地分，同一局的決定不會兩邊都有；
    一局分到哪一邊只看它自己的編號，所以之後多了新的對局，舊的對局不會換邊。
    """

    def __init__(self, game, records, broken, config):
        self.game = game
        self.total = len(records) + len(broken)
        self.skipped = [(name, f"檔案讀不出來（{why}）") for name, why in broken]
        self.other_devices = 0      # 不是 --ip 指定的裝置玩的
        self.devices = {}           # 用到的對局各來自哪一台裝置（來源 IP）
        self.human = self.computer = self.marked = self.forced = 0
        kept = []                   # (對局編號, 這一局要學的每一個決定)
        for record in records:
            if config["ip"] and record.get("ip") not in config["ip"]:
                self.other_devices += 1
                continue
            try:
                need(record.get("game") == game.slug, f"這是 {record.get('game')} 的紀錄")
                decisions = list(game.decisions(record))
            except Skip as why:
                self.skipped.append((record["id"], str(why)))
                continue
            except (KeyError, IndexError, TypeError, ValueError, AttributeError, StopIteration) as error:
                self.skipped.append((record["id"], f"格式不對（{type(error).__name__}：{error}）"))
                continue
            chosen = []
            for human, mark, steps in decisions:
                if human:
                    self.human += 1
                else:
                    self.computer += 1
                    if config["players"] != "all":
                        continue
                if mark and not config["with_hints"]:
                    self.marked += 1
                    continue
                steps = [step for step in steps if sum(step[1]) > 1]    # 只有一種選擇的那一步沒有東西可以學
                if steps:
                    chosen.append(steps)
                else:
                    self.forced += 1
            if chosen:
                kept.append((record["id"], chosen))
                device = record.get("ip") or "不明"
                self.devices[device] = self.devices.get(device, 0) + 1

        def order(name):
            return zlib.crc32(name.encode())

        validation = {name for name, _ in kept if order(name) % 100 < VALIDATION_PERCENT}
        if not validation and len(kept) >= 5:       # 對局很少時可能剛好一局都沒分到：挑一局當驗證
            validation = {min((name for name, _ in kept), key=order)}
        self.x, self.mask, self.y, self.group = ([], []), ([], []), ([], []), ([], [])
        self.rounds, self.decisions, self.chance = [0, 0], [0, 0], [0.0, 0.0]
        digest = hashlib.sha1(f"{game.slug} v{game.version} {game.size}x{game.actions}".encode())
        for name, chosen in kept:
            part = int(name in validation)
            self.rounds[part] += 1
            for steps in chosen:
                chance = 1.0
                for x, mask, y in steps:
                    self.x[part].append(bytes(x))
                    self.mask[part].append(bytes(mask))
                    self.y[part].append(y)
                    self.group[part].append(self.decisions[part])
                    chance /= sum(mask)
                    digest.update(x)
                    digest.update(mask)
                    digest.update(bytes((y, part)))
                self.decisions[part] += 1
                self.chance[part] += chance     # 這個決定每一步都亂選一個可以選的，全部猜中的機率
        self.fingerprint = digest.hexdigest()   # 資料一樣（同樣的對局、同樣的讀法）這串字就一樣

    def summary(self):
        return {
            "rounds": self.total, "used_rounds": sum(self.rounds), "skipped_rounds": len(self.skipped),
            "train_decisions": self.decisions[0], "validation_decisions": self.decisions[1],
            "train_samples": len(self.y[0]), "validation_samples": len(self.y[1]),
            "validation_rounds": self.rounds[1],
            "chance": self.chance[1] / self.decisions[1] if self.decisions[1] else None,
            "fingerprint": self.fingerprint,
        }

    def describe(self, folder, config):
        whose = "玩家和電腦" if config["players"] == "all" else "玩家"
        made = self.human + (self.computer if config["players"] == "all" else 0)
        lines = [f"資料：{folder}，{self.total} 局"]
        if self.other_devices:
            lines.append(f"      其中 {self.other_devices} 局不是指定的裝置（--ip）玩的，不用")
        if self.skipped:
            lines.append(f"      其中 {len(self.skipped)} 局讀不懂，略過：")
            lines += [f"        {name}：{why}" for name, why in self.skipped[:5]]
            if len(self.skipped) > 5:
                lines.append(f"        ……還有 {len(self.skipped) - 5} 局")
        left_out = []
        if self.marked:
            left_out.append(f"按過提示或自動胡牌打的 {self.marked} 個")
        if self.forced:
            left_out.append(f"只有一種選擇的 {self.forced} 個")
        lines.append(f"      {whose}做的決定 {made} 個" + (f"，不學的：{'、'.join(left_out)}" if left_out else ""))
        lines.append(f"      拿來練的 {self.decisions[0]} 個（{self.rounds[0]} 局）、"
                     f"留著驗證的 {self.decisions[1]} 個（{self.rounds[1]} 局）")
        if len(self.devices) > 1 or config["ip"]:
            lines.append("      來源裝置：" + "、".join(f"{ip}（{n} 局）" for ip, n in sorted(self.devices.items())))
        return lines

    def tensors(self, torch, device):
        """搬到訓練用的裝置上：兩份 (x, mask, y, group)，先是拿來練的，再是驗證用的。"""
        parts = []
        for part in (0, 1):
            count = len(self.y[part])
            if count:
                x = torch.frombuffer(bytearray(b"".join(self.x[part])), dtype=torch.uint8)
                mask = torch.frombuffer(bytearray(b"".join(self.mask[part])), dtype=torch.uint8)
            else:
                x = mask = torch.zeros(0, dtype=torch.uint8)
            parts.append((x.reshape(count, self.game.size).to(device),
                          mask.reshape(count, self.game.actions).to(device).bool(),
                          torch.tensor(self.y[part], dtype=torch.long, device=device),
                          torch.tensor(self.group[part], dtype=torch.long, device=device)))
        return parts


# ===================== 模型 =====================

def nvidia_gpus():
    """不靠 PyTorch，直接問驅動程式這台有哪些 NVIDIA GPU；沒有 GPU 或沒裝驅動程式就是空的。"""
    try:
        asked = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return []
    return [line.strip() for line in asked.stdout.splitlines() if line.startswith("GPU ")] if asked.returncode == 0 else []


def load_torch():
    try:
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")     # 沒裝 NumPy 時 PyTorch 會警告一聲，這裡用不到 NumPy
            import torch
    except ImportError:
        install = "安裝指令見 https://pytorch.org/get-started/locally/（要選支援 CUDA 的版本）"
        gpus = nvidia_gpus()
        if not gpus:
            raise Problem("錯誤：找不到 NVIDIA GPU，無法訓練。\n"
                          f"這台電腦也沒有安裝 PyTorch：請在有 NVIDIA GPU 的電腦上執行，並先裝好 PyTorch，{install}。",
                          EXIT_NO_GPU) from None
        raise Problem(f"錯誤：這台電腦沒有安裝 PyTorch，無法訓練（NVIDIA GPU 有找到：{gpus[0]}）。\n請先裝好 PyTorch，{install}。",
                      EXIT_NO_GPU) from None
    return torch


def pick_device(torch, args):
    """訓練用的裝置。找不到 NVIDIA GPU 就明白說找不到，不改用 CPU（--cpu 是另外給測試用的）。"""
    if args.cpu:
        if not args.again:
            say("注意：這一次用 CPU 訓練（--cpu），只適合測試流程；正式訓練請拿掉 --cpu，用 NVIDIA GPU。")
        return torch.device("cpu")
    if not torch.cuda.is_available():
        if torch.version.cuda is None:
            why = f"這裡裝的 PyTorch {torch.__version__} 是不支援 GPU 的版本（CPU 版），要改裝支援 CUDA 的版本"
        else:
            why = (f"PyTorch {torch.__version__}（CUDA {torch.version.cuda}）偵測不到可以用的 NVIDIA 顯示卡，"
                   "請檢查顯示卡和驅動程式（nvidia-smi 要能正常執行）")
        raise Problem(f"錯誤：找不到 NVIDIA GPU，無法訓練。\n{why}。", EXIT_NO_GPU)
    count = torch.cuda.device_count()
    if not 0 <= args.gpu < count:
        raise Problem(f"錯誤：找不到第 {args.gpu} 張 NVIDIA GPU（這台有 {count} 張，編號從 0 開始）。", EXIT_NO_GPU)
    return torch.device("cuda", args.gpu)


def encoder_of(game):
    """模型吃的東西長什麼樣子。存在訓練進度和模型檔裡：讀法改過（不一樣）就不能混著用。"""
    return {"version": game.version, "features": game.size, "actions": game.actions,
            "each": len(game.EACH), "about": len(game.static[0]), "fields": game.fields}


def build_model(torch, encoder, width, depth, dropout, game=None):
    """模型分兩段。先把整個局面（x 和 mask）讀成一串數字，讀「細節」欄位的時候隨機遮掉一部分（見 Game）；
    再替每一個動作打分數：把那個動作的描述（x 裡每個動作各一格的欄位，加上 about()）跟局面一起交給同一個小網路。
    每個動作用的是同一個網路，所以學到的道理（例如「跟牌的時候出最小的」）每一張牌通用，資料不多也學得起來。
    不能選的動作，分數是很大的負數。

    game 是 None 的時候（讀回存好的模型），欄位的倍率、哪些是細節、動作的描述先留空，等存好的值放進來。
    """
    nn = torch.nn
    features, actions, each = encoder["features"], encoder["actions"], encoder["each"]
    narrow = max(32, width // 2)
    scale = game.scale if game else [1.0] * features
    detail = game.detail if game else [False] * features
    static = game.static if game else [[0.0] * encoder["about"]] * actions

    class Block(nn.Module):
        def __init__(self):
            super().__init__()
            self.norm = nn.LayerNorm(width)
            self.one = nn.Linear(width, width)
            self.two = nn.Linear(width, width)
            self.drop = nn.Dropout(dropout)

        def forward(self, hidden):
            return hidden + self.two(self.drop(nn.functional.gelu(self.one(self.norm(hidden)))))

    class Policy(nn.Module):
        def __init__(self):
            super().__init__()
            self.register_buffer("scale", torch.tensor(scale, dtype=torch.float32))
            self.register_buffer("detail", torch.tensor(detail, dtype=torch.bool))
            self.register_buffer("static", torch.tensor(static, dtype=torch.float32))
            self.blur = nn.Dropout(DETAIL_DROPOUT)
            self.enter = nn.Linear(features + actions, width)
            self.blocks = nn.ModuleList(Block() for _ in range(depth))
            self.norm = nn.LayerNorm(width)
            self.action = nn.Linear(encoder["about"] + each + 1, narrow)
            self.situation = nn.Linear(width, narrow)
            self.score = nn.Sequential(nn.GELU(), nn.Dropout(dropout), nn.Linear(narrow, narrow), nn.GELU(),
                                       nn.Linear(narrow, 1))

        def forward(self, x, mask):
            values, legal = x.float() * self.scale, mask.float()
            hidden = self.enter(torch.cat((torch.where(self.detail, self.blur(values), values), legal), dim=1))
            for block in self.blocks:
                hidden = block(hidden)
            own = values[:, features - each * actions:].reshape(len(x), each, actions).transpose(1, 2)
            about = torch.cat((self.static.expand(len(x), -1, -1), own, legal.unsqueeze(2)), dim=2)
            scores = self.score(self.action(about) + self.situation(self.norm(hidden)).unsqueeze(1)).squeeze(2)
            return scores.masked_fill(~mask, -1e9)

    return Policy()


def read_file(torch, path):
    try:
        return torch.load(path, map_location="cpu", weights_only=True)
    except TypeError:       # 很舊的 PyTorch 沒有 weights_only
        return torch.load(path, map_location="cpu")


def load_model(path, device="cpu"):
    """讀回訓練好的模型，回傳 (模型, 模型檔裡的說明)。

    模型吃 (x, mask)：x 是 Game.decisions() 交出來的那種 0～255 的整數（形狀：幾筆 × encoder.features），
    mask 是可以選的動作（布林，幾筆 × encoder.actions）；吐出每個動作的分數，最高的就是模型猜玩家會選的。
    """
    torch = load_torch()
    saved = read_file(torch, path)
    if not isinstance(saved, dict) or saved.get("format") != "game-policy-1":
        raise Problem(f"{path} 不是這個程式訓練出來的模型。")
    model = build_model(torch, saved["encoder"], **saved["arch"])
    model.load_state_dict(saved["state"])
    return model.to(device).eval(), saved


# ===================== 存檔 =====================

def now_text():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def swap_in(temporary, path):
    """把寫好的暫存檔換成正式的檔案（換的那一瞬間才生效：不會留下寫到一半的檔）。"""
    for attempt in range(40):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:     # Windows：正式的檔案剛好被別的程式開著（防毒、另一個視窗在看 status）
            if attempt == 39:
                raise
            time.sleep(0.25)


def write_text(path, text):
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "w", encoding="utf-8", newline="") as file:
        file.write(text)
        file.flush()
        os.fsync(file.fileno())
    swap_in(temporary, path)


def write_torch(torch, path, value):
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "wb") as file:
        torch.save(value, file)
        file.flush()
        os.fsync(file.fileno())
    swap_in(temporary, path)


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def lock_folder(out):
    """同一個遊戲同時只讓一個訓練在跑。回傳鎖（訓練結束時關掉；程式被強制關掉時系統會自己放開）；已經有一個在跑就回傳 None。"""
    handle = open(out / "train.lock", "a+")
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def mark_stopped(out, note):
    """訓練不是自己停下來的：在 status.json 記一筆原因。"""
    status = read_json(out / "status.json") or {}
    status.update(state="stopped", note=note, updated=now_text())
    write_text(out / "status.json", json.dumps(status, ensure_ascii=False, indent=1) + "\n")


def is_training(out):
    if not (out / "train.lock").exists():
        return False
    handle = lock_folder(out)
    if handle is None:
        return True
    handle.close()
    return False


# ===================== 訓練 =====================

FROM_WINDOW = []    # 互動模式下，視窗那一頭要求暫停的原因（見 listen）


def listen():
    """互動模式的訓練程序用：視窗那一頭（supervise）從標準輸入送一個字過來，就是要暫停。
    那一頭不見了（視窗被關掉，讀到結尾）也當作要暫停：不要留一個沒人管的訓練佔著 GPU。"""
    def wait():
        try:
            got = os.read(sys.stdin.fileno(), 1)
        except (OSError, ValueError):
            got = b""
        FROM_WINDOW.append("按鍵" if got else "視窗關掉了")

    threading.Thread(target=wait, daemon=True).start()


class Stop:
    """暫停的要求：視窗裡的按鍵、Ctrl+C、kill，或另一個視窗執行 pause（它會在輸出資料夾放一個 PAUSE 檔）。

    收到以後不馬上停，訓練迴圈做完手上那一步、把進度存好才結束。等不及再按一次 Ctrl+C 就直接結束（不存檔）。
    """

    def __init__(self, flag):
        self.flag = flag
        self.why = None
        self.looked = 0.0
        self.old = {}

    def on_signal(self, number, frame):
        if self.why:
            raise KeyboardInterrupt
        self.why = "Ctrl+C" if number == signal.SIGINT else "結束訊號"

    def install(self):
        for name in ("SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"):
            number = getattr(signal, name, None)
            if number is not None:
                try:
                    self.old[number] = signal.signal(number, self.on_signal)
                except (ValueError, OSError):
                    pass

    def restore(self):
        for number, handler in self.old.items():
            signal.signal(number, handler)

    def asked(self):
        if not self.why and FROM_WINDOW:
            self.why = FROM_WINDOW[0]
        if not self.why and time.monotonic() - self.looked >= 0.5:
            self.looked = time.monotonic()
            if self.flag.exists():
                self.why = "pause 指令"
        return self.why


class Diverged(Exception):
    pass


class Trouble(RuntimeError):
    """測試用：假裝 GPU 出錯。"""


def epoch_order(torch, seed, epoch, count):
    """第 epoch 輪資料的順序：只由 seed 和第幾輪決定，所以暫停後接著練，順序和沒暫停時一模一樣。"""
    generator = torch.Generator()
    generator.manual_seed((seed * 1_000_003 + epoch) % (2 ** 62))
    return torch.randperm(count, generator=generator)


class Trainer:
    def __init__(self, torch, device, game, config, dataset, out, args):
        self.torch, self.device, self.game, self.config, self.dataset, self.out = torch, device, game, config, dataset, out
        self.save_every, self.pause_at, self.die_at = args.save_every, args.pause_at_step, args.die_at_step
        self.trouble_at, self.step_delay, self.in_window = args.trouble_at_step, args.step_delay, args.worker
        self.encoder = encoder_of(game)
        self.train, self.validation = dataset.tensors(torch, device)
        self.has_validation = dataset.decisions[1] > 0
        self.limit = config["epochs"] if self.has_validation else min(config["epochs"], NO_VALIDATION_EPOCHS)
        self.stop = Stop(out / "PAUSE")
        self.history, self.best, self.final = [], None, None
        self.written = None         # model.pt 現在裝的是哪一輪的模型
        self.saved_step = None      # checkpoint.pt 存到第幾步
        self.clock = self.saved_at = self.status_at = self.printed = time.monotonic()
        self.device_name = torch.cuda.get_device_name(device) if device.type == "cuda" else "CPU"

    def build(self):
        config = self.config
        self.model = build_model(self.torch, self.encoder, config["width"], config["depth"], config["dropout"],
                                 self.game).to(self.device)
        self.optimizer = self.torch.optim.AdamW(self.model.parameters(), lr=config["lr"],
                                                weight_decay=config["weight_decay"])

    def fresh(self):
        """從頭開始。上一次練好的模型先改名留著，新的練出來之前還有得用。"""
        self.torch.manual_seed(self.config["seed"])
        self.build()
        self.progress = {"epoch": 0, "batch": 0, "step": 0, "loss_sum": 0.0, "loss_count": 0,
                         "lr": self.config["lr"], "bad": 0, "seconds": 0.0, "finished": False}
        if (self.out / "model.pt").exists():
            swap_in(self.out / "model.pt", self.out / "model.previous.pt")
            say("上一次的模型改名成 model.previous.pt 留著。")
        self.save("training")

    def resume(self, previous):
        """接著上次暫停（或被中斷前最後一次存檔）的地方：模型、學習的狀態、亂數的狀態都照原樣放回去。"""
        torch = self.torch
        self.build()
        self.model.load_state_dict(previous["model"])
        self.optimizer.load_state_dict(previous["optimizer"])
        torch.set_rng_state(previous["rng"]["cpu"])
        if self.device.type == "cuda" and previous["rng"]["gpu"] is not None:
            torch.cuda.set_rng_state(previous["rng"]["gpu"], self.device)
        self.progress, self.history, self.best = dict(previous["progress"]), list(previous["history"]), previous["best"]
        if previous["data"]["fingerprint"] != self.dataset.fingerprint:
            say(f"資料和暫停的時候不一樣了（那時 {previous['data']['rounds']} 局，現在 {self.dataset.total} 局），"
                "接下來用現在的資料練。")
            self.progress.update(batch=0, loss_sum=0.0, loss_count=0)   # 這一輪重新來

    def learn(self, rows):
        torch = self.torch
        x, mask, y, _ = self.train
        loss = torch.nn.functional.cross_entropy(self.model(x[rows], mask[rows]), y[rows])
        self.optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
        self.optimizer.step()
        value = loss.item()
        if not math.isfinite(value):
            raise Diverged
        return value

    def measure(self, data, decisions):
        """在一份資料上的誤差，和「整個決定每一步都猜對」的比例。"""
        torch = self.torch
        x, mask, y, group = data
        self.model.eval()
        total, wrong = 0.0, torch.zeros(decisions, device=self.device)
        with torch.no_grad():
            for start in range(0, len(y), 2048):
                rows = slice(start, start + 2048)
                scores = self.model(x[rows], mask[rows])
                total += torch.nn.functional.cross_entropy(scores, y[rows], reduction="sum").item()
                wrong.index_add_(0, group[rows], (scores.argmax(dim=1) != y[rows]).float())
        self.model.train()
        return total / len(y), (wrong == 0).float().mean().item()

    def loop(self):
        """練到停為止。回傳 paused（被要求暫停）或 finished（練滿了，或驗證成績很久沒進步）。"""
        torch, config, progress = self.torch, self.config, self.progress
        size, count = config["batch_size"], len(self.train[2])
        batches = math.ceil(count / size)
        self.model.train()
        while progress["epoch"] < self.limit and progress["bad"] < config["patience"]:
            order = epoch_order(torch, config["seed"], progress["epoch"], count).to(self.device)
            while progress["batch"] < batches:
                if self.stop.asked() or progress["step"] == self.pause_at:
                    return "paused"
                if progress["step"] == self.die_at:
                    os._exit(9)     # 測試用：假裝被強制關掉
                if progress["step"] == self.trouble_at and not (self.out / "troubled").exists():
                    (self.out / "troubled").write_text("")
                    raise Trouble("CUDA error: 測試用的假故障")     # 測試用：假裝 GPU 出錯（只發生一次）
                if self.step_delay:
                    time.sleep(self.step_delay)     # 測試用：練慢一點
                start = progress["batch"] * size
                progress["loss_sum"] += self.learn(order[start:start + size])
                progress["loss_count"] += 1
                progress["batch"] += 1
                progress["step"] += 1
                self.tick()
            self.end_epoch()
        return "finished"

    def end_epoch(self):
        progress = self.progress
        row = {"epoch": progress["epoch"] + 1, "step": progress["step"],
               "train_loss": progress["loss_sum"] / max(1, progress["loss_count"]),
               "val_loss": None, "val_acc": None, "lr": progress["lr"]}
        if self.has_validation:
            row["val_loss"], row["val_acc"] = self.measure(self.validation, self.dataset.decisions[1])
        row["best"] = not self.has_validation or self.best is None or row["val_loss"] < self.best["val_loss"]
        if row["best"]:
            state = {name: value.detach().to("cpu", copy=True) for name, value in self.model.state_dict().items()}
            self.best = {"epoch": row["epoch"], "val_loss": row["val_loss"], "val_acc": row["val_acc"], "state": state}
            progress["bad"] = 0
        elif self.has_validation:
            progress["bad"] += 1
            if progress["bad"] % LR_PATIENCE == 0:      # 很久沒進步：學習率減半再試
                progress["lr"] /= 2
                for group in self.optimizer.param_groups:
                    group["lr"] = progress["lr"]
        progress.update(epoch=progress["epoch"] + 1, batch=0, loss_sum=0.0, loss_count=0)
        row["seconds"] = round(progress["seconds"] + time.monotonic() - self.clock, 1)
        self.history.append(row)
        if row["epoch"] == 1 or time.monotonic() - self.printed >= 2:
            self.report(row)
        self.tick()

    def report(self, row):
        self.printed = time.monotonic()
        text = f"第 {row['epoch']:>3} 輪  訓練誤差 {row['train_loss']:.4f}"
        if row["val_loss"] is not None:
            text += (f"  驗證誤差 {row['val_loss']:.4f}  猜中 {row['val_acc']:.1%}"
                     f"  （最好的是第 {self.best['epoch']} 輪：{self.best['val_loss']:.4f}）")
        say(text)

    def tick(self):
        now = time.monotonic()
        if now - self.saved_at >= self.save_every:
            self.save("training")
        elif now - self.status_at >= STATUS_EVERY:
            self.write_status("training")

    def save(self, state):
        """把進度存起來：checkpoint.pt（接著練要用的全部狀態）、model.pt（目前最好的模型）、log.csv、status.json。"""
        torch, progress = self.torch, self.progress
        now = time.monotonic()
        progress["seconds"] += now - self.clock
        self.clock = self.saved_at = now
        done = progress["finished"]
        self.saved_step = progress["step"]
        write_torch(torch, self.out / "checkpoint.pt", {
            "format": 1, "game": self.game.slug, "encoder": self.encoder, "config": self.config,
            "data": self.dataset.summary(), "progress": dict(progress), "history": self.history,
            "best": {k: v for k, v in self.best.items() if not (done and k == "state")} if self.best else None,
            "model": None if done else self.model.state_dict(),
            "optimizer": None if done else self.optimizer.state_dict(),
            "rng": None if done else {
                "cpu": torch.get_rng_state(),
                "gpu": torch.cuda.get_rng_state(self.device) if self.device.type == "cuda" else None},
        })
        if self.best and self.written != (self.best["epoch"], done):
            write_torch(torch, self.out / "model.pt", self.model_file())
            self.written = (self.best["epoch"], done)
        self.write_log()
        self.write_status(state)

    def model_file(self):
        best, config = self.best, self.config
        return {
            "format": "game-policy-1", "game": self.game.slug, "title": self.game.title, "encoder": self.encoder,
            "arch": {name: config[name] for name in ("width", "depth", "dropout")},
            "state": best["state"],
            "result": {"finished": self.progress["finished"], "epoch": best["epoch"], "epochs": self.progress["epoch"],
                       "validation_loss": best["val_loss"], "validation_accuracy": best["val_acc"],
                       "chance": self.dataset.summary()["chance"], "final": self.final},
            "data": self.dataset.summary(),
            "config": dict(config, ip=len(config["ip"])),       # 來源 IP 不寫進模型檔，只記有幾個
            "saved": now_text(), "torch": str(self.torch.__version__),
        }

    def write_log(self):
        columns = ("epoch", "step", "train_loss", "val_loss", "val_acc", "lr", "seconds", "best")
        text = io.StringIO()
        writer = csv.writer(text, lineterminator="\n")
        writer.writerow(columns)
        for row in self.history:
            writer.writerow(["" if row[name] is None else int(row[name]) if name == "best" else row[name]
                             for name in columns])
        write_text(self.out / "log.csv", text.getvalue())

    def write_status(self, state, note=None):
        progress, best = self.progress, self.best
        self.status_at = time.monotonic()
        write_text(self.out / "status.json", json.dumps({
            "game": self.game.slug, "state": state, "note": note, "updated": now_text(), "pid": os.getpid(),
            "epoch": progress["epoch"], "epochs": self.limit, "step": progress["step"], "saved_step": self.saved_step,
            "best": best and {name: best[name] for name in ("epoch", "val_loss", "val_acc")},
            "last": self.history[-1] if self.history else None,
            "final": self.final, "seconds": round(progress["seconds"] + time.monotonic() - self.clock, 1),
            "data": self.dataset.summary(), "device": self.device_name, "config": self.config,
            "model": str(self.out / "model.pt") if (self.out / "model.pt").exists() else None,
        }, ensure_ascii=False, indent=1) + "\n")

    def where(self):
        progress = self.progress
        return f"第 {progress['epoch'] + 1} 輪（已經練了 {progress['step']} 步）"

    def run(self):
        """練到練完或暫停為止，回傳結束代碼。"""
        slug = self.game.slug
        self.stop.install()
        try:
            outcome = self.loop()
        except KeyboardInterrupt:
            mark_stopped(self.out, "被直接結束（沒有等存檔）")
            say(f"已直接結束。進度只存到上一次存檔的地方；再執行 {RUN} {slug} 會從那裡接著練。")
            return 130
        except Diverged:
            mark_stopped(self.out, "訓練發散")
            raise Problem(f"錯誤：訓練發散了（誤差變成無限大）。請用小一點的學習率從頭練，例如："
                          f"{RUN} {slug} --restart --lr {self.config['lr'] / 3:g}") from None
        finally:
            self.stop.restore()
        if outcome == "paused":
            self.save("paused")
            try:
                (self.out / "PAUSE").unlink()
            except OSError:
                pass
            why = "" if self.stop.why == "按鍵" else f"（{self.stop.why or '測試'}）"
            say(f"已暫停{why}：進度存到{self.where()}。")
            if not self.in_window:      # 互動模式下，接下來怎麼做由視窗那一頭說（見 supervise）
                say(f"要接著練：{RUN} {slug}")
            return EXIT_PAUSED
        return self.finish()

    def finish(self):
        """練完了：模型換回驗證成績最好的那一輪，存成 model.pt，再讀回來確認檔案是好的。"""
        progress, best, data = self.progress, self.best, self.dataset
        self.model.load_state_dict(best["state"])
        loss, accuracy = self.measure(self.train, data.decisions[0])
        self.final = {"train_loss": loss, "train_acc": accuracy}
        early = progress["bad"] >= self.config["patience"]
        progress["finished"] = True
        self.save("finished")

        model, saved = load_model(self.out / "model.pt", self.device)
        self.model = model
        check = self.measure(self.validation, data.decisions[1]) if self.has_validation else self.measure(self.train, data.decisions[0])
        expected = (best["val_loss"], best["val_acc"]) if self.has_validation else (loss, accuracy)
        if abs(check[0] - expected[0]) > 1e-3 or abs(check[1] - expected[1]) > 1e-6 or not saved["result"]["finished"]:
            raise Problem("錯誤：model.pt 讀回來和訓練時的成績不一樣，這個模型檔不能用。請用 --restart 重新訓練。")

        say("")
        say(f"訓練完成：練了 {progress['epoch']} 輪" + (f"（驗證成績連續 {progress['bad']} 輪沒有進步，提早結束）" if early else "")
            + (f"，最好的是第 {best['epoch']} 輪。" if self.has_validation else "。"))
        if self.has_validation:
            say(f"  沒練過的 {data.rounds[1]} 局裡，模型猜中玩家怎麼選的比例：{best['val_acc']:.1%}"
                f"（每次亂選一個可以選的：約 {data.chance[1] / data.decisions[1]:.1%}）")
        say(f"  練過的對局裡猜中的比例：{accuracy:.1%}")
        say(f"  模型：{self.out / 'model.pt'}")
        if type(self.game).upcoming is not Game.upcoming:
            say(f"  要在{self.game.title}裡和這個模型對打：把 train_out/ 推上 git，遊戲伺服器那台拉下來（不用重開伺服器），"
                "再到遊戲的「電腦的打法」選模型（見 README「讓電腦照模型出牌」）。")
        return EXIT_DONE


def read_checkpoint(torch, path):
    """上一次存的訓練進度；沒有就回傳 None。檔案壞了的話改名留著，當作沒有。"""
    if not path.exists():
        return None
    try:
        saved = read_file(torch, path)
        if not isinstance(saved, dict) or saved.get("format") != 1:
            raise ValueError("不是訓練進度檔")
        return saved
    except Exception as error:      # 檔案壞了有各式各樣的錯
        swap_in(path, path.with_name("checkpoint.broken.pt"))
        say(f"上次存的訓練進度讀不出來（{type(error).__name__}），改名成 checkpoint.broken.pt，這一次從頭開始。")
        return None


def settle(args, previous):
    """這一次訓練用的設定：指令上寫的優先；接著練的時候，沒寫的沿用暫停前的。"""
    given = {name: getattr(args, name) for name in OPTIONS if getattr(args, name) is not None}
    if "ip" in given:
        given["ip"] = sorted(set(given["ip"]))
    if previous is None or previous["progress"]["finished"]:
        return dict(OPTIONS, **given)
    old = previous["config"]
    changed = [name for name, value in given.items() if name not in RESUMABLE and old.get(name) != value]
    if changed:
        names = "、".join("--" + name.replace("_", "-") for name in changed)
        raise Problem(f"這個遊戲有練到一半的進度，{names} 和那時候的設定不一樣。\n"
                      f"要接著練：不要寫 {names}；要用新的設定從頭練：加上 --restart。", EXIT_USAGE)
    return dict(OPTIONS, **dict(old, **given))


def train(game, args):
    torch = load_torch()
    device = pick_device(torch, args)
    folder, out, slug = args.data_dir / game.slug, args.out_dir / game.slug, game.slug
    records, broken = read_records(folder) if folder.is_dir() else ([], [])
    if not records:
        raise Problem(f"找不到 {slug} 的對局紀錄（{folder}）。\n先玩幾局讓伺服器記錄下來；紀錄放在別的地方的話用 --data-dir 指定。",
                      EXIT_USAGE)
    out.mkdir(parents=True, exist_ok=True)
    lock = lock_folder(out)
    if lock is None:
        raise Problem(f"{slug} 已經有一個訓練在跑了。要暫停它：{RUN} {slug} pause")
    try:
        try:
            (out / "PAUSE").unlink()    # 拿到鎖的這一刻還在的暫停要求，是先前已經不在的訓練留下來的
        except OSError:
            pass
        return prepare(torch, device, game, args, records, broken)
    except RuntimeError as error:
        if device.type != "cuda" and not isinstance(error, Trouble):
            raise
        reason = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
        write_text(out / "error.log", f"{now_text()}\n{traceback.format_exc()}")
        mark_stopped(out, f"GPU 出錯：{reason}")
        after = "" if args.worker else f"GPU 可以用了以後，再執行 {RUN} {slug} 會從那裡接著練。"
        raise Problem(f"錯誤：GPU 出問題，訓練中斷了：{reason}\n"
                      f"（完整的錯誤訊息在 {out / 'error.log'}）\n"
                      f"進度存到上一次存檔的地方。{after}", EXIT_GPU) from None
    finally:
        lock.close()


def prepare(torch, device, game, args, records, broken):
    """決定是接著練、從頭練，還是不用練，然後開始。"""
    folder, out, slug = args.data_dir / game.slug, args.out_dir / game.slug, game.slug
    previous = None if args.restart else read_checkpoint(torch, out / "checkpoint.pt")
    if previous and (previous["game"] != slug or previous["encoder"] != encoder_of(game)):
        say("之前的訓練進度是用舊的讀法做的，不能接著用；這一次從頭開始。")
        previous = None
    config = settle(args, previous)
    dataset = Dataset(game, records, broken, config)

    first = not args.again      # 同一個視窗裡暫停後再繼續：資料、裝置這些開頭的說明不用再印一次
    if first:
        say(f"遊戲：{game.title}（{slug}）")
        for line in dataset.describe(folder, config):
            say(line)
    if not dataset.decisions[0]:
        raise Problem("沒有可以拿來練的決定。" + ("（--players all 可以連電腦的出牌一起學。）"
                                             if config["players"] != "all" and dataset.computer else ""), EXIT_USAGE)
    if first and dataset.decisions[0] < 2000:
        say("      （資料還很少，練出來的模型只能當參考；多玩幾局再練會比較準。）")
    if first and not dataset.decisions[1]:
        say(f"      （對局太少，留不出驗證用的對局：固定只練 {NO_VALIDATION_EPOCHS} 輪，也沒辦法知道學得怎麼樣。）")

    if previous and previous["progress"]["finished"]:
        why = ("設定和上次不一樣" if previous["config"] != config else
               f"資料和上次練完時不一樣了（那時 {previous['data']['rounds']} 局，現在 {dataset.total} 局）"
               if previous["data"]["fingerprint"] != dataset.fingerprint else
               "找不到上次的模型檔" if not (out / "model.pt").exists() else None)
        if why is None:
            best = previous["best"] or {}
            say(f"已經練好了：資料和設定都和上次練完時一樣，模型在 {out / 'model.pt'}"
                + (f"（猜中 {best['val_acc']:.1%}）" if best.get("val_acc") is not None else "") + "。")
            say("要重新練一次：加上 --restart。")
            return EXIT_DONE
        say(f"{why}，重新訓練。")
        previous = None

    trainer = Trainer(torch, device, game, config, dataset, out, args)
    if first:
        say(f"裝置：{trainer.device_name}")
    limit = (f"最多 {trainer.limit} 輪，驗證成績連續 {config['patience']} 輪沒有進步就停" if trainer.has_validation
             else f"練 {trainer.limit} 輪")
    if previous:
        trainer.resume(previous)
        say(f"接著上次的進度：從{trainer.where()}開始（{limit}）。")
    else:
        trainer.fresh()
        say(f"從頭開始訓練（{limit}）。")
    if first:
        parameters = sum(value.numel() for value in trainer.model.parameters())
        say(f"模型：{config['depth']} 層、每層 {config['width']}（{parameters / 1e6:.1f}M 個參數）")
    if args.worker:
        say("按 p 暫停（存檔並把 GPU 讓出來，再按一次 p 繼續），按 q 存檔後離開。")
    else:
        say(f"要暫停：按 Ctrl+C，或在另一個視窗執行 {RUN} {slug} pause；之後再執行同一個指令會接著練。")
    return trainer.run()


# ===================== 互動模式：同一個視窗裡暫停、繼續 =====================

class Keys:
    """讀這個視窗的按鍵：不用按 Enter，按了也不會顯示在畫面上。用完把視窗的設定還原。"""

    def __enter__(self):
        self.gone = False
        if os.name == "nt":
            import msvcrt
            self.windows = msvcrt
        else:
            import termios
            import tty
            self.windows, self.fd = None, sys.stdin.fileno()
            self.before = termios.tcgetattr(self.fd)
            tty.setcbreak(self.fd)
        return self

    def __exit__(self, *error):
        if not self.windows:
            import termios
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.before)

    def read(self, wait):
        """最多等 wait 秒，回傳按下的那個鍵（英文字母一律小寫）；沒按就是空字串。"""
        if self.windows:
            until = time.monotonic() + wait
            while not self.windows.kbhit():
                if time.monotonic() >= until:
                    return ""
                time.sleep(0.05)
            key = self.windows.getwch()
            if key in ("\x00", "\xe0"):     # 方向鍵、功能鍵會連送兩個字：後面那個不要當成按鍵
                self.windows.getwch()
                return ""
            return key.lower()
        import select
        if self.gone or not select.select([self.fd], [], [], wait)[0]:
            if self.gone:
                time.sleep(wait)
            return ""
        key = os.read(self.fd, 1)
        if not key:
            self.gone = True        # 視窗不在了，之後不會再有按鍵
        elif key == b"\x1b":        # 方向鍵、功能鍵是 Esc 開頭的一串字：整串丟掉，裡面的字母不要當成按鍵
            while select.select([self.fd], [], [], 0.02)[0] and os.read(self.fd, 32):
                pass
            return ""
        return key.decode("utf-8", "ignore").lower()


def supervise(game, args):
    """互動模式（直接在終端機視窗裡執行時）：這個視窗負責聽按鍵，訓練交給另外開的程序去做。

    按 p：那個程序存好檔就結束，GPU 完全讓出來，這個視窗停在暫停；按 Enter 再開一個程序，從存檔的地方接著練。
    按 q 或 Ctrl+C：存檔後離開。訓練途中 GPU 出錯也是停在暫停，GPU 好了按 Enter 接著練。回傳結束代碼。
    """
    slug = game.slug
    command = [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--worker"]
    carry_on = [word for word in command if word != "--restart"] + ["--again"]      # 接著練的時候不可以又從頭來
    leave = []      # 收到要結束的訊號：Ctrl+C（訓練程序自己也會收到）、kill、視窗被關掉

    def bye(code):
        say(f"已離開。要接著練：{RUN} {slug}")
        return code

    old = {}
    for name in ("SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"):
        if hasattr(signal, name):
            old[getattr(signal, name)] = signal.signal(getattr(signal, name), lambda number, frame: leave.append(number))
    try:
        with Keys() as keys:
            again = False
            while True:
                worker = subprocess.Popen(carry_on if again else command, stdin=subprocess.PIPE)
                told = quitting = False
                while worker.poll() is None:
                    key = keys.read(0.2)
                    quitting = quitting or key == "q" or bool(leave)
                    if (key in ("p", "q") or leave) and not told:
                        told = True
                        try:
                            worker.stdin.write(b"p")
                            worker.stdin.flush()
                        except OSError:
                            pass        # 它剛好自己結束了
                code = worker.returncode
                try:
                    worker.stdin.close()
                except OSError:
                    pass
                if code not in (EXIT_PAUSED, EXIT_GPU, EXIT_NO_GPU) or (code == EXIT_NO_GPU and not again):
                    return code     # 練完了，或是不能在這裡等的問題（一開始就找不到 GPU、沒有資料……）
                if quitting or leave:
                    return bye(code)
                say({EXIT_PAUSED: "GPU 已經讓出來。按 p（或 Enter）繼續訓練，按 q 離開。",
                     EXIT_GPU: "GPU 可以用了以後，按 p（或 Enter）從上一次存檔的地方接著練；按 q 離開。",
                     EXIT_NO_GPU: "GPU 可以用了以後，按 p（或 Enter）再試一次；按 q 離開。"}[code])
                while True:
                    key = keys.read(0.5)
                    if key == "q" or leave:
                        return bye(code)
                    if key in ("\n", "\r", "p", " "):
                        break
                again = True
    finally:
        for number, handler in old.items():
            signal.signal(number, handler)


# ===================== pause、status、總覽 =====================

def describe_status(status, running, slug):
    """status.json 的內容寫成一兩行人看的話。"""
    best, state = status.get("best") or {}, status.get("state")
    where = f"第 {status.get('epoch', 0) + 1} 輪（已經練了 {status.get('step', 0)} 步）"
    score = f"，目前最好的模型猜中 {best['val_acc']:.1%}" if best.get("val_acc") is not None else ""
    again = f"再執行 {RUN} {slug} 會從上一次存檔的地方（練了 {status.get('saved_step')} 步的時候）接著練。"
    if running:
        return f"訓練中：{where}，最多 {status.get('epochs')} 輪{score}。"
    if state == "finished":
        done = f"已經練完（練了 {status.get('epoch')} 輪，{status.get('updated', '')[:16].replace('T', ' ')}）"
        return done + (f"，模型在沒練過的對局裡猜中 {best['val_acc']:.1%}。" if best.get("val_acc") is not None else "。")
    if state == "paused":
        return f"暫停中：進度存到{where}{score}。要接著練：{RUN} {slug}"
    if state == "stopped":
        return f"上次中斷了（{status.get('note')}）。{again}"
    return f"上次訓練沒有正常結束（可能被強制關掉）。{again}"


def count_rounds(folder):
    return sum(1 for _ in folder.rglob("*.json")) if folder.is_dir() else 0


def show_status(game, args):
    slug, out = game.slug, args.out_dir / game.slug
    say(f"{game.title}（{slug}）")
    say(f"  對局紀錄：{count_rounds(args.data_dir / slug)} 局（{args.data_dir / slug}）")
    status = read_json(out / "status.json")
    if not status:
        say("  還沒有訓練過。")
        return EXIT_DONE
    say("  " + describe_status(status, is_training(out), slug))
    data = status.get("data") or {}
    say(f"  用的資料：{data.get('rounds')} 局，拿來練的決定 {data.get('train_decisions')} 個、"
        f"驗證用的 {data.get('validation_decisions')} 個")
    if status.get("model"):
        say(f"  模型：{status['model']}")
    return EXIT_DONE


def pause(game, args):
    slug, out = game.slug, args.out_dir / game.slug
    if not out.is_dir() or not is_training(out):
        status = read_json(out / "status.json")
        say(f"現在沒有在訓練 {slug}。" + (describe_status(status, False, slug) if status else ""))
        return EXIT_ERROR
    write_text(out / "PAUSE", f"{now_text()} 要求暫停\n")
    say("已經通知訓練暫停，等它把進度存好……")
    deadline = time.monotonic() + 600
    while is_training(out):
        if time.monotonic() > deadline:
            say("它還沒停下來（可能正在做一段很久的計算）。稍後用 status 看看。")
            return EXIT_ERROR
        time.sleep(0.2)
    try:
        (out / "PAUSE").unlink()
    except OSError:
        pass
    status = read_json(out / "status.json")
    say(describe_status(status, False, slug) if status else "訓練已經停了。")
    return EXIT_DONE


def overview(args):
    say(f"對局紀錄：{args.data_dir}　模型：{args.out_dir}")
    names = list(GAMES)
    if args.data_dir.is_dir():
        names += sorted(path.name for path in args.data_dir.iterdir() if path.is_dir() and path.name not in GAMES)
    for slug in names:
        rounds = count_rounds(args.data_dir / slug)
        if slug not in GAMES:
            say(f"  {slug:<11}{rounds:>5} 局  這個程式還不會讀這個遊戲的紀錄")
            continue
        status = read_json(args.out_dir / slug / "status.json")
        state = describe_status(status, is_training(args.out_dir / slug), slug) if status else "還沒有訓練過" if rounds else "還沒有紀錄"
        say(f"  {slug:<11}{rounds:>5} 局  {GAMES[slug].title}：{state}")
    say("")
    say(f"訓練：{RUN} <遊戲>　暫停：{RUN} <遊戲> pause　其他用法：{RUN} --help")
    return EXIT_DONE


def main():
    for stream in (sys.stdout, sys.stderr):     # 有些 Windows 視窗顯示不出某些字：換成問號，不要整個程式掛掉
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(
        allow_abbrev=False,
        description="用 gaming_data/ 的對局紀錄訓練照玩家習慣出牌的模型（要有 NVIDIA GPU），模型放在 train_out/<遊戲>/。",
        epilog="在終端機視窗裡執行時：訓練中按 p 暫停（存檔並把 GPU 讓出來）、按 Enter 繼續、按 q 存檔後離開。"
               "離開之後再執行同一個指令會接著練。")
    parser.add_argument("game", nargs="?", help="遊戲（gaming_data/ 底下的資料夾名稱）：" + "、".join(GAMES) + "；不寫就列出每個遊戲的狀況")
    parser.add_argument("command", nargs="?", default="train", choices=["train", "resume", "pause", "status"],
                        help="train（預設）：訓練，之前暫停過就接著練（寫 resume 也一樣）；pause：叫正在訓練的那一個存檔暫停；status：看練到哪裡")
    parser.add_argument("--restart", action="store_true", help="不接著練，丟掉之前的進度從頭開始")
    parser.add_argument("--data-dir", help="對局紀錄的資料夾（預設：這個程式旁邊的 gaming_data/）")
    parser.add_argument("--out-dir", help="模型和訓練進度放哪裡（預設：這個程式旁邊的 train_out/）")
    parser.add_argument("--gpu", type=int, default=0, metavar="編號", help="用第幾張 NVIDIA GPU（預設 0）")
    parser.add_argument("--cpu", action="store_true", help="不用 GPU，改用 CPU 跑（很慢，只拿來測試流程）")
    parser.add_argument("--save-every", type=float, default=60, metavar="秒", help="訓練中每隔幾秒存一次進度（預設 60）")
    parser.add_argument("--no-keys", action="store_true",
                        help="不要聽按鍵（放在背景、排程或接管線執行時本來就不聽）：暫停改用 Ctrl+C 或 pause")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)  # 互動模式自己用的：這是視窗另外開的訓練程序
    parser.add_argument("--again", action="store_true", help=argparse.SUPPRESS)   # 互動模式自己用的：暫停後在同一個視窗接著練
    parser.add_argument("--trouble-at-step", type=int, help=argparse.SUPPRESS)    # 測試用：練到第幾步就假裝 GPU 出錯（一次）
    parser.add_argument("--step-delay", type=float, help=argparse.SUPPRESS)       # 測試用：每一步多等幾秒
    parser.add_argument("--pause-at-step", type=int, help=argparse.SUPPRESS)      # 測試用：練到第幾步就暫停
    parser.add_argument("--die-at-step", type=int, help=argparse.SUPPRESS)        # 測試用：練到第幾步就假裝被強制關掉
    group = parser.add_argument_group("訓練設定（接著練的時候，沒寫的沿用暫停前的設定）")
    group.add_argument("--epochs", type=int, metavar="輪", help=f"最多練幾輪（預設 {OPTIONS['epochs']}）")
    group.add_argument("--patience", type=int, metavar="輪", help=f"驗證成績連續幾輪沒有進步就停（預設 {OPTIONS['patience']}）")
    group.add_argument("--batch-size", type=int, metavar="筆", help=f"一步看幾筆資料（預設 {OPTIONS['batch_size']}）")
    group.add_argument("--lr", type=float, help=f"學習率（預設 {OPTIONS['lr']}）")
    group.add_argument("--weight-decay", type=float, help=f"預設 {OPTIONS['weight_decay']}")
    group.add_argument("--width", type=int, help=f"模型每層多寬（預設 {OPTIONS['width']}）")
    group.add_argument("--depth", type=int, help=f"模型幾層（預設 {OPTIONS['depth']}）")
    group.add_argument("--dropout", type=float, help=f"預設 {OPTIONS['dropout']}")
    group.add_argument("--seed", type=int, help=f"亂數種子（預設 {OPTIONS['seed']}）")
    group.add_argument("--players", choices=["human", "all"], help="human（預設）：只學真人的決定；all：電腦的出牌也一起學")
    group.add_argument("--ip", action="append", metavar="IP", help="只用這台裝置（來源 IP）玩的紀錄；可以寫好幾次。預設全部都用")
    group.add_argument("--with-hints", action="store_true", default=None, help="按過「提示」才做的決定、自動胡牌替玩家打的牌也拿來學")
    args = parser.parse_intermixed_args()       # 選項寫在遊戲名稱和 pause／status 中間也可以
    args.data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else DATA_DIR
    args.out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else OUT_DIR

    try:
        if args.command == "resume":
            args.command = "train"
        if args.game in (None, "status") and args.command == "train":
            return overview(args)
        if args.game not in GAMES:
            close = difflib.get_close_matches(args.game, GAMES, n=1, cutoff=0.5)
            raise Problem(f"沒有 {args.game} 這個遊戲" + (f"，是不是要打 {close[0]}？" if close else "。")
                          + f"\n可以用的：{'、'.join(GAMES)}", EXIT_USAGE)
        for name, least in (("epochs", 1), ("patience", 1), ("batch_size", 1), ("width", 8), ("depth", 1)):
            if getattr(args, name) is not None and getattr(args, name) < least:
                raise Problem(f"--{name.replace('_', '-')} 至少要 {least}。", EXIT_USAGE)
        game = GAMES[args.game]()
        if args.command == "status":
            return show_status(game, args)
        if args.command == "pause":
            return pause(game, args)
        if args.worker:
            listen()
        elif not args.no_keys and sys.stdin is not None and sys.stdin.isatty() and sys.stdout.isatty():
            return supervise(game, args)
        return train(game, args)
    except Problem as problem:
        say(problem)
        return problem.code
    except KeyboardInterrupt:       # 還沒開始訓練就按了 Ctrl+C（訓練中的 Ctrl+C 是暫停，在 Trainer.run 裡處理）
        say("已中止。")
        return 130


if __name__ == "__main__":
    sys.exit(main())
