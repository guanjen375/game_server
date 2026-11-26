// A review starts from a settled deal. Cards use the live AI's SHCD numbering.
class GongZhuReview {
    static deck = Array.from({ length: 52 }, (_, c) => {
        const suit = 'SHCD'[Math.floor(c / 13)], rank = c % 13 + 2;
        return { suit, rank, id: suit + rank, label: ['J', 'Q', 'K', 'A'][rank - 11] || String(rank) };
    });

    static card(id) {
        return GongZhuAI.SUIT_INDEX[id[0]] * 13 + Number(id.slice(1)) - 2;
    }

    constructor(record) {
        if (!record.finished || !record.result) throw new Error('本局尚未結算');
        this.record = record;
        this.me = record.seats.indexOf('south');
        this.totals = record.seats.map(seat => record.totals[seat]);
        this.moves = record.tricks.flat().map(t => GongZhuReview.card(t.card));
        this.decisions = [];
        this.atPly = new Map();
        this.replies = new Map();
        this.positions = new Map();
        this.ranges = new WeakMap();

        const hands = record.seats.map(seat => record.hands[seat].map(GongZhuReview.card));
        let state = { hands, p: hands.findIndex(h => h.includes(GongZhuAI.SPADE_SEVEN)), trick: [],
            history: [], piles: [[], [], [], []], taken: 0, path: '', recorded: true };
        for (const entry of record.tricks.flat()) {
            const card = GongZhuReview.card(entry.card);
            const legal = this.legal(state);
            if (record.seats[state.p] !== entry.seat || !legal.includes(card) || state.taken === 16) {
                throw new Error('出牌紀錄與手牌不符');
            }
            if (state.p === this.me && legal.length > 1) {
                this.atPly.set(state.path.length, this.decisions.length);
                this.decisions.push({ state, legal, actual: card });
            }
            state = this.play(state, card);
        }
        if (state.taken !== 16 || this.score(state) !== record.result.south.score) {
            throw new Error('出牌紀錄與本局結算不符');
        }
    }

    legal(s) {
        const hand = s.hands[s.p];
        if (!s.trick.length) return hand;
        const suit = Math.floor(s.trick[0].c / 13);
        const follow = hand.filter(c => Math.floor(c / 13) === suit);
        return follow.length ? follow : hand;
    }

    play(s, c) {
        const hands = s.hands.slice();
        hands[s.p] = hands[s.p].filter(card => card !== c);
        const trick = [...s.trick, { p: s.p, c }];
        const next = { ...s, hands, trick, p: (s.p + 1) % 4, path: s.path + String.fromCharCode(65 + c),
            recorded: s.recorded && this.moves[s.path.length] === c };
        if (trick.length === 4) {
            next.p = GongZhuAI.winner(trick).p;
            next.trick = [];
            next.history = [...s.history, trick];
            const scoring = trick.map(t => t.c).filter(c => GongZhuAI.isScoring(c));
            if (scoring.length) {
                next.piles = s.piles.slice();
                next.piles[next.p] = s.piles[next.p].concat(scoring);
                next.taken += scoring.length;
            }
        }
        return next;
    }

    score(s) {
        const caps = s.piles.map(pile => GongZhuAI.newCap(pile));
        return GongZhuAI.score(caps[this.me], caps.some(cap => cap.hearts === 13));
    }

    followLine(state, line) {
        return line.reduce((position, card) => this.play(position, card), state);
    }

    // Bounds allow every outstanding scoring card to go to any seat. Within an
    // ordinary hand the heart penalty decreases monotonically as more are taken.
    bounds(piles) {
        if (this.ranges.has(piles)) return this.ranges.get(piles);
        const caps = piles.map(pile => GongZhuAI.newCap(pile)), mine = caps[this.me];
        const others = caps.filter((_, p) => p !== this.me);
        const remaining = 13 - caps.reduce((n, cap) => n + cap.hearts, 0);
        const points = HEART_POINTS.reduce((a, b) => a + b) - caps.reduce((n, cap) => n + cap.heartSum, 0);
        const possible = key => mine[key] ? [true] : others.some(cap => cap[key]) ? [false] : [false, true];
        const alreadySwept = caps.some(cap => cap.hearts === 13);
        const otherCanSweep = !mine.hearts && others.filter(cap => cap.hearts).length <= 1;
        let low = Infinity, high = -Infinity;
        const include = value => { low = Math.min(low, value); high = Math.max(high, value); };
        for (const pig of possible('pig')) for (const sheep of possible('sheep')) for (const trans of possible('trans')) {
            const cap = { ...mine, pig, sheep, trans };
            if (!alreadySwept) {
                include(GongZhuAI.score(cap, false, false));
                include(GongZhuAI.score({ ...cap, hearts: mine.hearts + remaining, heartSum: mine.heartSum + points }, false, false));
            }
            if (otherCanSweep) include(GongZhuAI.score(cap, true, false));
            if (mine.hearts + remaining === 13) include(GongZhuAI.score(cap, true, true));
        }
        // At a trick boundary the remaining hands also determine which scoring
        // cards are out. Opponents' piles only matter if one can still sweep.
        const collectors = caps.flatMap((cap, p) => cap.hearts ? [p] : []);
        const specials = Number(mine.pig) + 2 * mine.sheep + 4 * mine.trans;
        const signature = [mine.hearts, mine.heartSum, specials, collectors.length === 1 ? collectors[0] : -1].join('.');
        const range = { low, high, signature };
        this.ranges.set(piles, range);
        return range;
    }

    initialResults() {
        return this.decisions.map(({ state }, i) => {
            const score = this.record.result.south.score;
            // Compare South's choice and the reply before opening the review.
            // Small endgames can already be solved in full.
            const depth = state.hands[this.me].length <= 3 ? Infinity : 2;
            const job = { mode: 'guard', nodes: 0, limited: false };
            const search = this.guardChoice(i, depth, job);
            let step = search.next();
            while (!step.done) step = search.next();
            return {
                bot: { score, exact: score === this.bounds(state.piles).high, line: this.moves.slice(state.path.length) },
                guard: { ...step.value, depth, exact: !job.limited }
            };
        });
    }

    *guardChoice(i, depth, job) {
        const { state, actual } = this.decisions[i];
        const best = yield* this.search(state, depth, -Infinity, Infinity, job, true);
        const suggested = best.line[0];
        if (suggested === actual || this.distinct(state, [actual, suggested]).length === 1) return best;
        // Give the played card the same continuation depth and a fresh alpha/beta
        // window. A later mistake in the actual record must not count against it.
        const played = yield* this.search(this.play(state, actual), depth - 1, -Infinity, Infinity, job);
        if (played.score >= best.score) return best;
        return { ...best, played: { score: played.score, line: [actual, ...played.line] } };
    }

    // Adjacent ordinary ranks held by one seat have identical futures against
    // perfect defence. A BOT may react to the printed rank, so keep both there.
    distinct(s, legal) {
        const outside = s.hands.flatMap((hand, p) => p === s.p ? [] : hand).concat(s.trick.map(t => t.c));
        const seen = new Set();
        return legal.filter(c => {
            if (GongZhuAI.isScoring(c)) return true;
            const suit = Math.floor(c / 13);
            const key = suit + '/' + outside.filter(x => Math.floor(x / 13) === suit && x < c).length;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    preferred(s, legal, bot) {
        if (bot && s.recorded) return this.moves[s.path.length];
        const pigOut = !s.piles.some(pile => pile.includes(GongZhuAI.PIG));
        const card = GongZhuAI.normalPlay(s.hands[s.p], s.trick, pigOut);
        return legal.includes(card) ? card : legal[0];
    }

    // A search yields expensive BOT queries and periodically yields CPU time.
    // Depth counts real choices only. At the horizon play continues legally to
    // settlement, so even an estimated value has a complete, replayable line.
    *search(s, depth, alpha, beta, job, root = false) {
        if (++job.nodes % 256 === 0) yield null;
        if (s.taken === 16) return { score: this.score(s), line: [] };
        const bot = job.mode === 'bot', maximize = s.p === this.me || bot;
        const { low, high, signature } = this.bounds(s.piles);
        if (!root && bot && high <= alpha) return null;
        // A fail-low/high bound cannot become part of the full-window root's
        // principal variation. Only in-window values are cached with a line.
        if (!bot && high <= alpha) return { score: high, line: [] };
        if (!bot && low >= beta) return { score: low, line: [] };

        let key;
        if (!bot && !s.trick.length) {
            key = [depth, s.p, ...s.hands.map(h => h.join('.')), signature].join('/');
            if (this.positions.has(key)) {
                if (depth !== Infinity) job.limited = true;
                return this.positions.get(key);
            }
        }
        const originalAlpha = alpha, originalBeta = beta;
        let best = null;
        if (bot && s.recorded && this.atPly.has(s.path.length)) {
            const known = job.rows[this.atPly.get(s.path.length)].bot;
            if (known.exact || known.score === high) return known;
            best = known;
            alpha = Math.max(alpha, best.score);
        }
        let legal = this.legal(s);
        if (bot && s.p !== this.me && legal.length > 1) {
            const reply = s.recorded ? this.moves[s.path.length] : this.replies.get(s.path) ?? (yield s);
            legal = [reply];
        } else if (!bot && legal.length > 1) {
            legal = this.distinct(s, legal);
        }
        const branches = legal.length > 1;
        if (branches) {
            const guide = bot && s.recorded && job.rows[this.atPly.get(s.path.length)]?.guard?.line?.[0];
            const pref = legal.includes(guide) ? guide : this.preferred(s, legal, bot);
            if (depth === 0 || low === high) {
                if (low !== high) job.limited = true;
                legal = [pref];
            } else {
                legal = [pref, ...legal.filter(c => c !== pref)];
            }
        }
        for (const c of legal) {
            const child = yield* this.search(this.play(s, c), branches ? Math.max(0, depth - 1) : depth, alpha, beta, job);
            if (child && (!best || (maximize ? child.score > best.score : child.score < best.score))) {
                best = { score: child.score, line: [c, ...child.line] };
                if (root && bot) job.improved(best);
            }
            if (!best) continue;
            if (maximize) alpha = Math.max(alpha, best.score);
            else beta = Math.min(beta, best.score);
            if (alpha >= beta || (maximize ? best.score === high : best.score === low)) break;
        }
        if (key && best.score > originalAlpha && best.score < originalBeta) {
            if (this.positions.size >= 40000) this.positions.clear();
            this.positions.set(key, best);
        }
        return best;
    }

    // Only the prefix before the counterfactual turn is sent to the serving API.
    modelRecord(s) {
        const { seats, hands, totals, settings, players, round } = this.record;
        const tricks = s.trick.length ? [...s.history, s.trick] : s.history;
        return { seats, hands, totals, settings, players, round, finished: false, result: null,
            tricks: tricks.map(trick => trick.map(({ p, c }) => ({ seat: seats[p], card: GongZhuReview.deck[c].id }))) };
    }

    async botReply(s, signal) {
        const r = this.record, seat = r.seats[s.p];
        // After an actual early settlement extend each seat's last policy.
        const trick = r.tricks[Math.min(s.history.length, r.tricks.length - 1)];
        const policy = trick.find(play => play.seat === seat);
        const legal = this.legal(s);
        let card;
        if (policy.bot) {
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(abort, 5000);
            try {
                const response = await fetch('/api/bot/gongzhu', { method: 'POST', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                        record: this.modelRecord(s), seat, mode: policy.bot, model: policy.modelName
                    }) });
                if (!response.ok) throw new Error();
                const answer = await response.json();
                if (answer.mode !== policy.bot || answer.model !== (policy.model || r.model) || answer.play?.seat !== seat) throw new Error();
                card = GongZhuReview.card(answer.play.card);
                if (!legal.includes(card)) throw new Error();
            } catch {
                throw new Error('本局使用的模型無法回應或版本已更換');
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
            }
        } else {
            const deck = GongZhuReview.deck;
            const viewTrick = entries => entries.map(({ p, c }) => ({ p, card: deck[c] }));
            const ai = Object.create(GongZhuAI);
            // Repeat a sampled public-information policy. A forced historical
            // turn has no sample count, so use the live bot's minimum budget.
            ai.MIN_SAMPLES = ai.MAX_SAMPLES = policy.samples || ai.MIN_SAMPLES;
            ai.BUDGET_MS = Infinity;
            const seed = policy.seed ?? s.hands[s.p].concat(Array.from(s.path, ch => ch.charCodeAt(0)))
                .reduce((hash, n) => Math.imul(hash ^ n, 16777619) >>> 0, 2166136261);
            const pick = ai.choose({ me: s.p, legal: legal.map(c => deck[c]), hand: s.hands[s.p].map(c => deck[c]),
                history: s.history.map(viewTrick), trick: viewTrick(s.trick),
                captured: s.piles.map(pile => pile.map(c => deck[c])), totals: this.totals }, null, ai.randomFrom(seed));
            card = GongZhuAI.toInt(pick);
        }
        if (this.replies.size >= 20000) this.replies.clear();
        this.replies.set(s.path, card);
        return card;
    }

    // An earlier decision can follow the actual plays to a later improvement.
    // Share that attainable score immediately, even while its own search runs.
    publishBot(rows, i, value, report) {
        const old = rows[i].bot;
        const best = value.score > old.score ? value : old;
        const store = (j, result) => {
            const high = this.bounds(this.decisions[j].state.piles).high;
            rows[j].bot = { ...rows[j].bot, ...result, exact: rows[j].bot.exact || !!result.exact || result.score === high };
            report(j, 'bot', rows[j].bot);
        };
        store(i, { ...value, score: best.score, line: best.line });
        if (best.score <= old.score) return;
        const end = this.decisions[i].state.path.length;
        for (let j = i - 1; j >= 0; j--) {
            if (rows[j].bot.score >= best.score) continue;
            const prefix = this.moves.slice(this.decisions[j].state.path.length, end);
            store(j, { score: best.score, line: prefix.concat(best.line) });
        }
    }

    // Deepen each decision independently. Short slices keep the other positions
    // progressing while the opener is searched or a model request is pending.
    async run(rows, report, control) {
        const runMode = async mode => {
            const update = (i, value) => {
                if (mode === 'bot') this.publishBot(rows, i, value, report);
                else { rows[i].guard = value; report(i, mode, value); }
            };
            const jobs = [];
            const enqueue = i => {
                const old = rows[i][mode], state = this.decisions[i].state;
                if (old?.exact || old?.error) return;
                const next = old?.depth ? old.depth * 2 : mode === 'bot' ? 1 : 2;
                const depth = state.hands[this.me].length <= 3 || next > 8 ? Infinity : next;
                const job = { i, mode, rows, depth, nodes: 0, limited: false, improved: value => update(i, value) };
                job.iterator = mode === 'guard' ? this.guardChoice(i, depth, job)
                    : this.search(state, depth, -Infinity, Infinity, job, true);
                jobs.push(job);
            };
            for (let i = rows.length - 1; i >= 0; i--) enqueue(i);
            let turn = 0;
            while (jobs.length && !control.signal.aborted) {
                const priority = turn++ % 2 ? jobs.findIndex(job => job.i === control.priority) : -1;
                const job = jobs.splice(priority < 0 ? 0 : priority, 1)[0];
                if (rows[job.i][mode]?.exact) continue;
                const start = performance.now();
                try {
                    let step;
                    do {
                        step = job.iterator.next(job.reply);
                        job.reply = undefined;
                        if (step.done || step.value) break;
                    } while (performance.now() - start < 12);
                    if (step.done) {
                        const value = step.value, range = this.bounds(this.decisions[job.i].state.piles);
                        const exact = !job.limited || range.low === range.high || (mode === 'bot' && value.score === range.high);
                        update(job.i, { ...value, exact, depth: job.depth });
                        enqueue(job.i);
                    } else {
                        if (step.value) job.reply = await this.botReply(step.value, control.signal);
                        jobs.push(job);
                    }
                } catch (error) {
                    if (control.signal.aborted) return;
                    update(job.i, { ...rows[job.i][mode], error: error.message });
                }
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        };
        await Promise.all([runMode('guard'), runMode('bot')]);
    }
}
