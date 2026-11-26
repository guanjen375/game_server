'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { compileFunction } = require('node:vm');
const load = compileFunction(require('./gongzhu/source.cjs') + '\nreturn { game, Review: GongZhuReview, ai: GongZhuAI };',
    ['window', 'Math', 'fetch']);

function round(seed, early = false, fetch) {
    const math = Object.create(Math);
    math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const { game, Review, ai } = load({}, math, fetch);
    const seats = game.SEAT_ORDER;
    const deck = new Map(game.createShuffledDeck().map(c => [c.id, c]));
    const hands = early ? [
        'S9 S4 H14 H13 H7 H4 C14 C13 C11 C8 D11 D8 D6', 'S12 S10 S5 S3 H8 H3 C7 C4 C3 C2 D14 D9 D7',
        'S13 S8 S2 H9 H6 H5 H2 C9 C6 D10 D4 D3 D2', 'S14 S11 S7 S6 H12 H11 H10 C12 C10 C5 D13 D12 D5'
    ].map(hand => hand.split(' ').map(id => deck.get(id))) : game.dealHands();
    seats.forEach((seat, p) => { game.PLAYERS[seat].hand = game.sortCards(hands[p]); });
    let seat = seats[hands.findIndex(hand => hand.some(c => c.id === 'S7'))];
    const decisions = [];
    while (!game.allScoringCardsCaptured()) {
        const legal = game.getLegalCards(seat);
        const card = early ? legal.find(c => c.isScoring) || legal[0]
            : seat === 'south' ? legal[Math.floor(math.random() * legal.length)] : legal.at(-1);
        if (seat === 'south' && legal.length > 1) decisions.push([game.trickHistory.length, game.currentTrick.length, legal.map(c => c.id), card.id]);
        const player = game.PLAYERS[seat];
        player.hand.splice(player.hand.indexOf(card), 1);
        if (!game.currentTrick.length) game.leadSuit = card.suit;
        game.currentTrick.push({ seat, card });
        if (game.currentTrick.length === 4) {
            seat = game.trickWinner(game.currentTrick).seat;
            game.PLAYERS[seat].captured.push(...game.currentTrick.map(t => t.card).filter(c => c.isScoring));
            game.trickHistory.push(game.currentTrick);
            game.currentTrick = [];
            game.leadSuit = null;
        } else seat = seats[(seats.indexOf(seat) + 1) % 4];
    }
    game.roundOver = true;
    seats.forEach(seat => { game.PLAYERS[seat].totalBeforeSettlement = 100 + seats.indexOf(seat); });
    const record = game.roundSoFar(true);
    return { game, Review, ai, record, decisions, review: new Review(record), deck };
}

// Independent replay and exhaustive oracle. Use card objects, the table's trick
// winner and settlement; never call the review engine's move generator or bounds.
function oracle({ record, game, deck }) {
    const { seats } = record;
    const hands = seats.map(seat => record.hands[seat].map(id => deck.get(id)));
    const start = { p: hands.findIndex(h => h.some(c => c.id === 'S7')), hands, table: [], piles: seats.map(() => []), n: 0 };
    const legal = s => {
        const follow = s.hands[s.p].filter(c => c.suit === s.table[0]?.card.suit);
        return follow.length ? follow : s.hands[s.p];
    };
    const play = (s, card) => {
        assert.ok(s.n < 16 && legal(s).includes(card), 'each line follows suit and stops at settlement');
        const hands = s.hands.slice(), table = [...s.table, { seat: seats[s.p], card }];
        hands[s.p] = hands[s.p].filter(c => c !== card);
        if (table.length < 4) return { ...s, hands, table, p: (s.p + 1) % 4 };
        const p = seats.indexOf(game.trickWinner(table).seat), piles = s.piles.slice();
        const scoring = table.map(t => t.card).filter(c => c.isScoring);
        piles[p] = [...piles[p], ...scoring];
        return { p, hands, table: [], piles, n: s.n + scoring.length };
    };
    const score = s => game.calculateRoundScores(Object.fromEntries(seats.map((seat, p) => [seat, s.piles[p]]))).south.score;
    const best = (s, mode) => {
        if (s.n === 16) return score(s);
        let moves = legal(s);
        if (mode === 'bot' && seats[s.p] !== 'south') moves = moves.slice(-1);
        const values = moves.map(c => best(play(s, c), mode));
        return seats[s.p] === 'south' || mode === 'bot' ? Math.max(...values) : Math.min(...values);
    };
    return { start, legal, play, score, best };
}

function solve(review, rows, i, mode, depth = Infinity) {
    const job = { rows, mode, nodes: 0, limited: false, improved() {} };
    const it = review.search(review.decisions[i].state, depth, -Infinity, Infinity, job, true);
    let step = it.next();
    while (!step.done) step = it.next(step.value ? review.legal(step.value).at(-1) : undefined);
    return { ...step.value, limited: job.limited };
}

test('all and only real South choices are reconstructed from the settled prefix, including an early finish', () => {
    const { Review, record, review, decisions } = round(4, true);
    const id = c => Review.deck[c].id;
    assert.equal(record.tricks.length, 6);
    assert.equal(new Set(Object.values(record.hands).flat()).size, 52);
    assert.deepEqual(review.decisions.map(({ state, legal, actual }) => [state.history.length, state.trick.length, legal.map(id), id(actual)]), decisions);
    assert.ok(review.decisions.some(({ state }) => state.trick.length > 0));
    assert.equal(review.decisions.at(-1).state.hands[review.me].length, 8);
    assert.throws(() => new Review({ ...record, finished: false }), /尚未結算/);
});

test('both optima and every principal variation agree with exhaustive independent endgame play', () => {
    let compared = 0, different = 0, limited = 0;
    for (let seed = 1; seed <= 22; seed++) {
        const fixture = round(seed), { review, record, Review, deck } = fixture;
        const ref = oracle(fixture), rows = review.initialResults();
        const played = record.tricks.flat().map(t => deck.get(t.card));
        for (const [i, { state }] of review.decisions.entries()) {
            if (state.hands[review.me].length > 3) continue;
            const position = played.slice(0, state.path.length).reduce(ref.play, ref.start);
            const scores = [];
            for (const mode of ['guard', 'bot']) {
                const computed = solve(review, rows, i, mode);
                const expected = ref.best(position, mode);
                assert.equal(computed.score, expected, `seed ${seed}, ${mode}, trick ${state.history.length + 1}`);
                const checkLine = line => line.reduce((s, c) => {
                    const card = deck.get(Review.deck[c].id);
                    if (mode === 'bot' && record.seats[s.p] !== 'south') assert.equal(card, ref.legal(s).at(-1));
                    return ref.play(s, card);
                }, position);
                const final = checkLine(computed.line);
                assert.equal(final.n, 16);
                assert.equal(ref.score(final), expected);
                assert.equal(computed.limited, false);
                const estimate = solve(review, rows, i, mode, 1);
                assert.equal(ref.score(checkLine(estimate.line)), estimate.score);
                if (estimate.limited) limited++;
                if (mode === 'bot') assert.ok(estimate.score <= expected && estimate.score >= record.result.south.score);
                scores.push(expected);
            }
            if (scores[0] < scores[1]) different++;
            compared++;
        }
    }
    assert.ok(compared >= 15);
    assert.ok(different >= 1, 'perfect defence can cost South points that the fixed BOT concedes');
    assert.ok(limited > 0);
});

test('coaching charges only the move loss at this trick and omits tied alternatives', () => {
    let mistakes = 0, ties = 0;
    for (let seed = 1; seed <= 25; seed++) {
        const fixture = round(seed), { review, Review, record, deck } = fixture;
        const ref = oracle(fixture), rows = review.initialResults();
        for (const [i, { state, actual }] of review.decisions.entries()) {
            const position = record.tricks.flat().slice(0, state.path.length)
                .reduce((s, t) => ref.play(s, deck.get(t.card)), ref.start);
            const check = value => {
                const replay = line => line.reduce((s, c) => ref.play(s, deck.get(Review.deck[c].id)), position);
                const best = replay(value.line);
                assert.equal(best.n, 16);
                assert.equal(ref.score(best), value.score);
                if (value.played) {
                    assert.notEqual(value.line[0], actual);
                    assert.equal(value.played.line[0], actual);
                    const played = replay(value.played.line);
                    assert.equal(played.n, 16);
                    assert.equal(ref.score(played), value.played.score);
                    assert.ok(value.score > value.played.score);
                }
            };
            check(rows[i].guard);
            if (state.hands[review.me].length > 3) continue;
            const it = review.guardChoice(i, Infinity, { mode: 'guard', nodes: 0, limited: false });
            let step = it.next();
            while (!step.done) step = it.next();
            const result = step.value;
            check(result);
            const best = ref.best(position, 'guard');
            const afterActual = ref.best(ref.play(position, deck.get(Review.deck[actual].id)), 'guard');
            assert.equal(result.score, best);
            if (best === afterActual) {
                assert.equal(result.played, undefined);
                ties++;
            } else {
                assert.equal(result.played.score, afterActual);
                mistakes++;
            }
        }
    }
    assert.ok(mistakes > 0 && ties > 0);
});

test('a hypothetical BOT turn gets the historical model and mode and only the simulated prefix', async () => {
    let request, reply;
    const fetch = async (url, opts) => {
        assert.equal(url, '/api/bot/gongzhu');
        request = JSON.parse(opts.body);
        return { ok: true, json: async () => reply };
    };
    const { review, Review, record } = round(7, false, fetch);
    let s = review.decisions[0].state;
    const alternative = review.legal(s).find(c => c !== review.moves[s.path.length]);
    s = review.play(s, alternative);
    while (s.p === review.me || review.legal(s).length === 1) s = review.play(s, review.legal(s)[0]);
    const seat = record.seats[s.p], choice = review.legal(s).at(-1);
    const policy = record.tricks[s.history.length].find(t => t.seat === seat);
    Object.assign(policy, { bot: 'weak', modelName: 'first', model: 'previous-version' });
    record.model = 'different-final-model';
    reply = { mode: 'weak', model: 'previous-version', play: { seat, card: Review.deck[choice].id } };
    assert.equal(await review.botReply(s), choice);
    assert.equal(request.mode, 'weak');
    assert.equal(request.model, 'first');
    assert.equal(request.record.finished, false);
    assert.equal(request.record.result, null);
    assert.deepEqual(request.record.tricks.flat().map(t => Review.card(t.card)), Array.from(s.path, ch => ch.charCodeAt(0) - 65));
    assert.equal(request.record.tricks.flat()[review.decisions[0].state.path.length].card, Review.deck[alternative].id);
    assert.deepEqual(request.record.totals, record.totals);
    reply = { ...reply, model: 'replaced' };
    await assert.rejects(review.botReply(s), /版本已更換/);
});

test('the sampled built-in BOT sees only its own cards and gives a repeatable reply', async () => {
    const { review, Review, ai } = round(8);
    const root = review.decisions[0].state;
    let s = review.play(root, review.legal(root).find(c => c !== review.moves[root.path.length]));
    while (s.p === review.me || review.legal(s).length === 1) s = review.play(s, review.legal(s)[0]);
    const choose = ai.choose;
    let called = 0;
    ai.choose = function (view, analysis, random) {
        called++;
        assert.deepEqual(Object.keys(view).sort(), ['captured', 'hand', 'history', 'legal', 'me', 'totals', 'trick']);
        assert.deepEqual(view.hand, s.hands[s.p].map(c => Review.deck[c]));
        return choose.call(this, view, analysis, random);
    };
    const card = await review.botReply(s);
    review.replies.clear();
    assert.equal(await review.botReply(s), card);
    assert.equal(called, 2);
    assert.ok(review.legal(s).includes(card));
});

test('score bounds include split hearts, flipped specials, transformer alone and both sweep bonuses', () => {
    const { review, ai } = round(9);
    const heights = new Set(), hearts = Array.from({ length: 13 }, (_, i) => i + 13);
    for (const p of [0, 1]) for (const count of [11, 13]) for (const split of [false, true]) {
        const piles = [[], [], [], []];
        for (const [i, c] of hearts.slice(0, count).entries()) piles[split && i === 0 ? p + 1 : p].push(c);
        const rest = [...hearts.slice(count), ai.PIG, ai.SHEEP, ai.TRANS];
        const { low, high } = review.bounds(piles);
        const finish = i => {
            if (i === rest.length) {
                const caps = piles.map(cards => ai.newCap(cards));
                const score = ai.score(caps[0], caps.some(cap => cap.hearts === 13));
                heights.add(score);
                assert.ok(low <= score && score <= high);
                return;
            }
            for (const pile of piles) { pile.push(rest[i]); finish(i + 1); pile.pop(); }
        };
        finish(0);
    }
    for (const n of [1000, 500, 50, -100, 100, -200]) assert.ok(heights.has(n), String(n));
});

test('an improvement is attainable from every earlier actual prefix and survives an older search result', () => {
    for (let seed = 1; seed <= 30; seed++) {
        const fixture = round(seed), { review, Review, record, deck } = fixture;
        const ref = oracle(fixture), rows = review.initialResults();
        const i = review.decisions.findLastIndex(({ state }) => state.hands[review.me].length <= 3);
        if (i <= 0) continue;
        const initial = rows[i].bot, best = solve(review, rows, i, 'bot');
        if (best.score === initial.score) continue;
        review.publishBot(rows, i, { ...best, exact: true }, () => {});
        review.publishBot(rows, i - 1, { ...initial, exact: false, depth: 1 }, () => {});
        for (let j = 0; j <= i; j++) {
            const start = review.decisions[j].state.path.length;
            const path = [...record.tricks.flat().slice(0, start).map(t => deck.get(t.card)), ...rows[j].bot.line.map(c => deck.get(Review.deck[c].id))];
            assert.equal(rows[j].bot.score, best.score);
            assert.equal(ref.score(path.reduce(ref.play, ref.start)), best.score);
        }
        return;
    }
    assert.fail('no improvable endgame was exercised');
});

test('a model outage preserves the attained BOT line while defence continues and the job can be stopped', async () => {
    const { review } = round(42);
    const rows = review.initialResults(), controller = new AbortController();
    review.botReply = async () => { throw new Error('模型已離線'); };
    await review.run(rows, () => {
        if (rows.every(row => row.guard?.line) && rows.some(row => row.bot.error)) controller.abort();
    }, { signal: controller.signal, priority: -1 });
    assert.ok(controller.signal.aborted);
    assert.ok(rows.every(row => row.guard.line.length && row.bot.line.length));
    assert.ok(rows.some(row => row.bot.error === '模型已離線' && !row.bot.exact));
});

test('the live built-in turn saves the draws and sample budget needed to reproduce its actual choice', async () => {
    const { game, review, record, Review, ai } = round(17);
    ai.MIN_SAMPLES = ai.MAX_SAMPLES = 4;
    game.roundOver = false;
    for (const { state } of review.decisions) {
        const s = review.play(state, review.moves[state.path.length]);
        if (s.taken === 16 || s.p === review.me || review.legal(s).length < 2) continue;
        const entries = trick => trick.map(t => ({ seat: record.seats[t.p], card: Review.deck[t.c] }));
        for (const [p, seat] of record.seats.entries()) {
            Object.assign(game.PLAYERS[seat], { hand: s.hands[p].map(c => Review.deck[c]), captured: s.piles[p].map(c => Review.deck[c]),
                totalScore: record.totals[seat] });
        }
        game.trickHistory = s.history.map(entries);
        game.currentTrick = entries(s.trick);
        game.leadSuit = game.currentTrick[0]?.card.suit;
        game.currentTurn = record.seats[s.p];
        let picked;
        game.playCardFromSeat = (seat, id, hinted, mode, settings) => { picked = { id, settings }; };
        game.playComputerCard(game.currentTurn, null);
        if (picked.settings.samples !== 4) continue;
        assert.ok(Number.isInteger(picked.settings.seed));
        Object.assign(record.tricks[s.history.length].find(t => t.seat === game.currentTurn), picked.settings);
        ai.MIN_SAMPLES = 1;
        assert.equal(Review.deck[await review.botReply(s)].id, picked.id);
        return;
    }
    assert.fail('no sampled live turn was exercised');
});
