"""Public-information search shared by the training arena and the live bot."""

from dataclasses import asdict, dataclass

import numpy as np

from .engine import Batch, FEATURES, LIB, PACKED, call


@dataclass(frozen=True)
class Settings:
    worlds: int = 24
    horizon: int = 1  # zero completes the current trick
    prior_points: float = 15.0
    rollout_weight: float = 0.12
    belief_strength: float = 0.0
    neural_plies: int = 0  # root move included; 52 rolls the neural policy to settlement
    exact_cards: int = 8
    score_temperature: float = 6.0  # only affects sampling in the weaker game mode

    def __post_init__(self):
        if type(self.worlds) is not int or not 1 <= self.worlds <= 256:
            raise ValueError("invalid sampled-deal budget")
        if type(self.horizon) is not int or not 0 <= self.horizon <= 12:
            raise ValueError("invalid lookahead")
        if not 0 <= self.belief_strength <= 2:
            raise ValueError("invalid hand belief strength")
        if type(self.neural_plies) is not int or not 0 <= self.neural_plies <= 52:
            raise ValueError("invalid neural lookahead")
        if self.exact_cards not in (0, 4, 8) or not 0 <= self.prior_points <= 200:
            raise ValueError("invalid endgame or policy settings")
        if not 0 <= self.rollout_weight <= 1 or not 0 < self.score_temperature <= 100:
            raise ValueError("invalid search weighting")

    def saved(self):
        return asdict(self)


def neural_leaves(x, openers, offset, weights, step, leaf, actor, cfg):
    size = int(offset[-1])
    states = np.empty((size, LIB.gz_size()), np.uint8)
    if call("gz_forks", len(x), x, openers, offset, weights, cfg.worlds, states):
        raise ValueError("no consistent hidden deal for the public position")
    value = np.empty(size, np.float32)
    stop = min(52, step + cfg.neural_plies)
    # Terminal max-n is deterministic. Skip redundant neural decisions in an
    # endgame we are about to solve exactly.
    if stop >= 52 - cfg.exact_cards:
        stop = max(step + 1, 52 - cfg.exact_cards)
    for begin in range(0, size, 2048):
        end = min(size, begin + 2048)
        batch = Batch.from_state(states[begin:end], step + 1)
        while batch.step < stop:
            obs, mask, _, _ = batch.observe()
            played = actor(obs, mask).argmax(1)
            batch.play(played)
        terminal = 52 - batch.step <= cfg.exact_cards
        if terminal or cfg.rollout_weight:
            mc = np.empty(batch.n, np.float32)
            call("gz_finish", batch.n, batch.state, cfg.exact_cards, mc)
        if terminal:
            value[begin:end] = mc
        else:
            z, bank, ref = batch.pack()
            sc = leaf(z, bank)
            margin = (4 * sc[np.arange(batch.n), (-ref.astype(np.int16)) % 4] - sc.sum(1)) / 3
            value[begin:end] = (1 - cfg.rollout_weight) * margin
            if cfg.rollout_weight:
                value[begin:end] += cfg.rollout_weight * mc
    return value


def search(x, mask, openers, priors, leaf, cfg, actor=None, belief=None):
    """Point-valued root scores, marginalized across the same deals for all actions.

    A hypothetical hand is used only below the decision being evaluated. Root
    sampling never receives the actual opponent hands or the original deal seed.
    """
    x = np.ascontiguousarray(x, dtype=np.uint8)
    mask = np.ascontiguousarray(mask, dtype=np.uint8)
    openers = np.ascontiguousarray(openers, dtype=np.uint8)
    priors = np.asarray(priors, dtype=np.float32)
    n = len(x)
    if (
        x.shape != (n, FEATURES)
        or mask.shape != (n, 52)
        or openers.shape != (n,)
        or priors.shape != (n, 52)
    ):
        raise ValueError("invalid search batch")
    legal = np.sum(mask, axis=1, dtype=np.int32)
    if np.any((legal < 1) | (legal > 13)) or np.any(openers > 3):
        raise ValueError("invalid legal actions or opener")
    out = np.where(mask, 0, -1e9).astype("f")
    active = np.flatnonzero(legal > 1)
    # Cap temporary leaf buffers independently of the game batch size.
    for ids in np.array_split(active, max(1, (len(active) + 95) // 96)):
        if not len(ids):
            continue
        counts = legal[ids]
        offset = np.empty(len(ids) + 1, np.int32)
        offset[0] = 0
        np.cumsum(counts * cfg.worlds, out=offset[1:])
        size = int(offset[-1])
        trick = x[ids, 565:578].argmax(1)
        turn = x[ids, 104:260].reshape(len(ids), 3, 52).any(2).sum(1)
        steps = trick * 4 + turn
        if cfg.neural_plies and not np.all(steps == steps[0]):
            # Live games normally supply one position, arenas advance in lockstep.
            for step in np.unique(steps):
                group = ids[steps == step]
                out[group] = search(
                    x[group], mask[group], openers[group], priors[group], leaf, cfg, actor, belief
                )
            continue
        weights = None
        if cfg.belief_strength:
            if belief is None:
                raise ValueError("checkpoint lacks the hand belief network")
            logits = belief(x[ids], openers[ids])
            logits = cfg.belief_strength * (logits - logits.max(2, keepdims=True))
            weights = np.ascontiguousarray(np.exp(np.clip(logits, -8, 0)), dtype=np.float32)
        if cfg.neural_plies and 52 - int(steps[0]) > cfg.exact_cards:
            if actor is None:
                raise ValueError("search requires the neural rollout policy")
            val = neural_leaves(
                x[ids], openers[ids], offset, weights, int(steps[0]), leaf, actor, cfg
            )
            exact = np.zeros(size, np.uint8)
        else:
            z = np.empty((size, PACKED), np.uint8)
            bank = np.empty((size, 4), np.int16)
            ref = np.empty(size, np.uint8)
            rollout = np.empty(size, np.float32)
            exact = np.empty(size, np.uint8)
            err = call(
                "gz_leaves",
                len(ids),
                x[ids],
                openers[ids],
                offset,
                weights,
                cfg.worlds,
                cfg.horizon,
                int(cfg.rollout_weight > 0),
                cfg.exact_cards,
                z,
                bank,
                ref,
                rollout,
                exact,
            )
            if err:
                raise ValueError("no consistent hidden deal for the public position")
            val = rollout.copy()
            estimate = np.flatnonzero((exact == 0) & (cfg.rollout_weight < 1))
            for chunk in np.array_split(estimate, max(1, (len(estimate) + 8191) // 8192)):
                if len(chunk):
                    sc = leaf(z[chunk], bank[chunk])
                    margin = (4 * sc[np.arange(len(chunk)), ref[chunk]] - sc.sum(1)) / 3
                    val[chunk] = (1 - cfg.rollout_weight) * margin + cfg.rollout_weight * rollout[
                        chunk
                    ]
        for j, idx in enumerate(ids):
            actions = np.flatnonzero(mask[idx])
            q = (
                val[offset[j] : offset[j + 1]]
                .reshape(cfg.worlds, len(actions))
                .mean(0, dtype=np.float64)
            )
            p = priors[idx, actions]
            # Exact endgames use the policy only to break practically equal outcomes.
            bonus = 0.0001 if exact[offset[j]] else cfg.prior_points
            out[idx, actions] = q + (p - p.max()) * bonus
    return out


class DenseCPU:
    def __init__(self, weights):
        self.w = {k: np.asarray(v, dtype=np.float32) for k, v in weights.items()}

    def linear(self, name, x):
        return x @ self.w[name + ".weight"].T + self.w[name + ".bias"]

    def norm(self, name, x):
        centered = x - x.mean(1, keepdims=True)
        inv = 1 / np.sqrt((centered * centered).mean(1, keepdims=True) + 1e-5)
        return centered * inv * self.w[name + ".weight"] + self.w[name + ".bias"]


class CPUValue(DenseCPU):
    """NumPy inference for the leaf network, with identical weights to PyTorch."""

    def __init__(self, weights, depth):
        super().__init__(weights)
        self.depth = depth
        self.card = self.w["card.weight"].T.reshape(52, 16, -1)
        self.eye = {k: np.eye(k, dtype=np.float32) for k in (4, 5, 14)}

    def __call__(self, z, bank):
        h = self.card[np.arange(52), z[:, :52]].sum(axis=1)
        void = ((z[:, 52:56, None] >> np.arange(4)) & 1).reshape(len(z), 16)
        ctx = np.concatenate(
            [
                void,
                *[self.eye[n][z[:, i]] for i, n in ((56, 4), (57, 5), (58, 14), (59, 5))],
                z[:, 60:64] / 6,
                bank / 128,
            ],
            axis=1,
        ).astype("f")
        h += self.linear("context", ctx)
        for i in range(self.depth):
            name = f"blocks.{i}."
            part = self.linear(name + "1", self.norm(name + "0", h))
            part = part / (1 + np.exp(-np.clip(part, -80, 80)))
            h += self.linear(name + "3", part)
        return self.linear("value", self.norm("norm", h)) * 128 + bank
