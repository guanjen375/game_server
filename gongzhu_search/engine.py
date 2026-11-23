"""Contiguous batch interface to the player_special simulator and search."""

import ctypes as ct
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np

SOURCE = Path(__file__).with_name("engine.cpp")
FEATURES = 1347
PACKED = 64


def library():
    source_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()[:20]
    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "gongzhu-search"
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / (source_hash + (".dylib" if sys.platform == "darwin" else ".so"))
    if not dest.exists():
        fd, name = tempfile.mkstemp(dir=cache)
        os.close(fd)
        try:
            compiler = os.environ.get("CXX", "c++")
            flags = ["-O3", "-std=c++17", "-shared", "-fPIC"]
            # OpenMP only parallelizes batches. Serving one table is single-threaded.
            cmd = [compiler, *flags, str(SOURCE), "-o", name]
            if subprocess.run([*cmd, "-fopenmp"], capture_output=True).returncode:
                subprocess.run(cmd, check=True)
            os.replace(name, dest)
        finally:
            Path(name).unlink(missing_ok=True)
    return ct.CDLL(str(dest))


LIB = library()


def call(name, *args):
    fun = getattr(LIB, name)
    converted = []
    for arg in args:
        if isinstance(arg, np.ndarray):
            if not arg.flags.c_contiguous:
                raise ValueError(f"{name} requires contiguous buffers")
            converted.append(ct.c_void_p(arg.ctypes.data))
        else:
            converted.append(arg)
    return fun(*converted)


class Batch:
    def __init__(self, decks):
        decks = np.ascontiguousarray(decks, dtype=np.uint8)
        self.n = len(decks)
        if decks.shape != (self.n, 52) or not np.all(np.sort(decks, axis=1) == np.arange(52)):
            raise ValueError("invalid decks")
        state = np.empty((self.n, LIB.gz_size()), np.uint8)
        self._buffers(state, 0)
        call("gz_init", self.n, decks, self.state)

    @classmethod
    def from_state(cls, state, step):
        self = cls.__new__(cls)
        self._buffers(state, step)
        return self

    def _buffers(self, state, step):
        self.state = state
        self.n = len(state)
        self.step = step
        self.x = np.empty((self.n, FEATURES), np.uint8)
        self.mask = np.empty((self.n, 52), np.uint8)
        self.seats = np.empty(self.n, np.uint8)
        self.openers = np.empty_like(self.seats)

    def observe(self):
        if self.step == 52:
            raise ValueError("round is over")
        call("gz_obs", self.n, self.state, self.x, self.mask, self.seats, self.openers)
        return self.x, self.mask, self.seats, self.openers

    def play(self, cards):
        cards = np.ascontiguousarray(cards, dtype=np.uint8)
        if (
            cards.shape != (self.n,)
            or self.step >= 52
            or call("gz_play", self.n, self.state, cards)
        ):
            raise ValueError("illegal action")
        self.step += 1

    def pack(self):
        z = np.empty((self.n, PACKED), np.uint8)
        bank = np.empty((self.n, 4), np.int16)
        refs = np.empty(self.n, np.uint8)
        call("gz_pack", self.n, self.state, z, bank, refs)
        return z, bank, refs

    def result(self):
        if self.step != 52:
            raise ValueError("round is unfinished")
        scores = np.empty((self.n, 4), np.int16)
        owners = np.empty((self.n, 16), np.uint8)
        call("gz_scores", self.n, self.state, scores, owners)
        return scores, owners
