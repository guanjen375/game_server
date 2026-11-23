"""CPU inference for a searched checkpoint. PyTorch is only needed for training."""

import numpy as np

from .engine import call
from .planning import CPUValue, DenseCPU, search, Settings


def gelu(x):
    x = np.ascontiguousarray(x, dtype=np.float32)
    call("gz_gelu", x.size, x)
    return x


class CPUPrior(DenseCPU):
    """Batch implementation of train_gpu.build_model, including the saved static card features."""

    def __init__(self, saved):
        super().__init__(saved["state"])
        self.depth = saved["arch"]["depth"]
        about = saved["encoder"]["about"]
        self.fixed = self.w["static"] @ self.w["action.weight"][:, :about].T
        self.fixed += self.w["action.bias"] + self.w["action.weight"][:, -1]
        self.dynamic = self.w["action.weight"][:, about:-1].T.copy()

    def __call__(self, x, mask):
        values = x * self.w["scale"]
        h = self.linear("enter", np.concatenate((values, mask), axis=1))
        for i in range(self.depth):
            k = f"blocks.{i}."
            h += self.linear(k + "two", gelu(self.linear(k + "one", self.norm(k + "norm", h))))
        local = values[:, -14 * 52 :].reshape(-1, 14, 52).transpose(0, 2, 1)
        row, card = np.nonzero(mask)
        actions = (
            local[row, card] @ self.dynamic
            + self.fixed[card]
            + self.linear("situation", self.norm("norm", h))[row]
        )
        score = self.linear("score.4", gelu(self.linear("score.2", gelu(actions))))[:, 0]
        out = np.full((len(x), 52), -1e9, np.float32)
        out[row, card] = score
        return out


class CPUBelief(DenseCPU):
    def __init__(self, saved):
        super().__init__(saved["state"])
        self.depth = saved["depth"]
        self.seats = np.eye(4, dtype=np.float32)

    def __call__(self, x, opener):
        h = self.linear(
            "enter", np.concatenate((x[:, :619] * self.w["scale"], self.seats[opener]), axis=1)
        )
        for i in range(self.depth):
            name = f"blocks.{i}."
            part = self.linear(name + "1", self.norm(name + "0", h))
            part = part / (1 + np.exp(-np.clip(part, -80, 80)))
            h += self.linear(name + "3", part)
        return self.linear("head", self.norm("norm", h)).reshape(-1, 52, 3)


class LivePolicy:
    def __init__(self, saved):
        desc = saved["search"]
        if desc["version"] != 1 or desc["rules"] != "player_special":
            raise ValueError("unsupported search format or rules")
        self.config = Settings(**desc["settings"])
        self.prior = CPUPrior(saved)
        self.belief = CPUBelief(saved["belief"]) if self.config.belief_strength else None
        self.value = CPUValue(saved["leaf"]["state"], saved["leaf"]["depth"])

    def for_turn(self, x, mask, opener):
        x = np.frombuffer(bytes(x), np.uint8)[None, :]
        mask = np.frombuffer(bytes(mask), np.uint8)[None, :]
        prior = self.prior(x, mask)
        values = search(
            x,
            mask,
            np.array([opener], np.uint8),
            prior,
            self.value,
            self.config,
            self.prior,
            self.belief,
        )
        legal = np.flatnonzero(mask[0])
        scores = {int(c): float(values[0, c] / self.config.score_temperature) for c in legal}
        generated = self.config.worlds * len(legal) if len(legal) > 1 else 0
        return scores, {
            "worlds": self.config.worlds if generated else 0,
            "root_successors": generated,
            "legal_actions": len(legal),
            "prior_choice": int(prior[0].argmax()),
        }
