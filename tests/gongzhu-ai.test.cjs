'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileFunction } = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../games/gongzhu.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const load = compileFunction(script + '\nreturn { game, ai: GongZhuAI };', ['window', 'Math', 'document']);
const name = card => card.suit + card.label;

// Replay the public tricks in play order. The bot only gets its own remaining hand.
function position({ history = [], trick, hand, totals = [0, 0, 0, 0], leader = 1, seed = 1 }) {
    const math = Object.create(Math);
    math.random = () => {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const { game, ai } = load({}, math);
    const deck = new Map(game.createShuffledDeck().map(c => [name(c), c]));
    const take = cards => cards.split(' ').map(key => {
        const card = deck.get(key);
        assert.ok(card, 'unknown or repeated card ' + key);
        deck.delete(key);
        return card;
    });
    const seats = game.SEAT_ORDER;
    for (let q = 0; q < seats.length; q++) game.PLAYERS[seats[q]].totalScore = totals[q];
    const plays = cards => take(cards).map((card, i) => ({ seat: seats[(leader + i) % 4], card }));
    for (const cards of history) {
        const entries = plays(cards);
        const winner = game.trickWinner(entries).seat;
        game.trickHistory.push(entries);
        game.PLAYERS[winner].captured.push(...entries.map(t => t.card).filter(c => c.isScoring));
        leader = seats.indexOf(winner);
    }
    game.currentTrick = trick ? plays(trick) : [];
    game.leadSuit = game.currentTrick[0]?.card.suit ?? null;
    game.trickNumber = history.length + 1;
    const actor = seats[(leader + game.currentTrick.length) % 4];
    game.PLAYERS[actor].hand = take(hand);
    assert.equal(game.PLAYERS[actor].hand.length, 13 - history.length);
    return samples => {
        ai.MIN_SAMPLES = ai.MAX_SAMPLES = samples;
        return name(game.chooseBestCardForAI(actor));
    };
}

test('first trick: a running heart hand gives the sheep to the transformer holder', () => {
    for (const seed of [1, 19, 73]) {
        const pick = position({
            trick: 'C2 C10 CA', hand: 'HA HK HQ HJ H10 H8 H4 DJ D7 SQ D3 SA DA', seed
        });
        assert.equal(pick(32), 'DJ');
    }
    const weak = position({ trick: 'C2 C10 CA', hand: 'H9 H7 H5 H4 H2 DJ SQ D2 SK D4 DQ S4 S5' });
    assert.notEqual(weak(32), 'DJ');
});

test('after a single heart, the simulation already breaks the possible sweep whatever the standings', () => {
    const early = {
        history: ['C2 CA C3 H4'], trick: 'H8 H2 H3', hand: 'H5 H9 S2 S4 S7 S8 D2 D4 D6 D8 C4 C6'
    };
    // An empty sample set exercises the same policy that plays every simulated turn.
    assert.equal(position(early)(0), 'H9');
    // The player collecting hearts is 1,300 behind us. That is no reason to let the sweep run.
    assert.equal(position({ ...early, totals: [70, 100, -1200, 80] })(0), 'H9');
});

// After four tricks all hearts are out. Moving just the first heart to a second
// player changes the value of the sheep and pig for the entire table.
const swept = ['C2 CA C10 H2', 'HA H3 H4 H5', 'HK H6 H7 H8', 'HQ H9 H10 HJ'];
const split = ['C2 C10 CA H2', 'H3 H4 H5 HA', 'HK H6 H7 H8', 'HQ H9 H10 HJ'];
test('with no clubs, discard the flipped sheep or the ordinary pig onto a known winner', () => {
    for (const [history, expected] of [[swept, 'DJ'], [split, 'SQ']]) {
        const pick = position({
            history, trick: 'C5 CK', hand: 'SQ DJ S2 S4 D3 D5 DK SA D8', totals: [0, -100, -600, 200]
        });
        assert.equal(pick(0), expected);
        assert.equal(pick(32), expected);
    }
});

test('duck a flipped sheep already on the table and take it when hearts are split', () => {
    for (const [history, expected] of [[swept, 'D3'], [split, 'DA']]) {
        const pick = position({ history, trick: 'D8 DJ', hand: 'D3 DA SQ S2 S4 S6 S8 SJ SK' });
        assert.equal(pick(0), expected);
        assert.equal(pick(32), expected);
    }
});

test('take a flipped pig already on the table and duck it when hearts are split', () => {
    for (const [history, expected] of [[swept, 'SA'], [split, 'S3']]) {
        const pick = position({ history, trick: 'S8 SQ', hand: 'S3 SA DJ D2 D4 D6 D8 DQ DK' });
        assert.equal(pick(0), expected);
        assert.equal(pick(32), expected);
    }
});

// With only H2 left to score, the bot can duck with C3 or take
// with CA. Only the owners of scoring cards in the opening tricks differ.
const ending = [
    'HA H3 H4 H5', 'HK H6 H7 H8', 'HQ H9 H10 HJ', 'SK S2 S5 S6',
    'S7 S8 S9 SJ', 'DK D7 D8 D9', 'CJ C7 D10 C6', 'S10 C8 DQ C9'
];
test('allow or break the same opponent sweep according to the final score margin', () => {
    for (const [opening, expected] of [
        [['C2 C5 CQ C10', 'SA SQ S3 S4', 'D5 DJ DA D6'], 'C3'],
        [['C2 C5 C10 CQ', 'SQ SA S3 S4', 'DA D6 D5 DJ'], 'CA']
    ]) {
        const pick = position({ leader: 2, history: opening.concat(ending), trick: 'C4 CK H2', hand: 'C3 CA' });
        assert.equal(pick(0), expected);
        assert.equal(pick(32), expected);
    }
});

test('keep the flipped sheep when giving it away would complete an opponent grand slam', () => {
    const history = ['C2 C10 H2 SQ', ...swept.slice(1)];
    const pick = position({ history, trick: 'DA D2', hand: 'DJ D3 D4 S3 S5 S8 S9 SJ SK' });
    assert.notEqual(pick(0), 'DJ');
    assert.notEqual(pick(32), 'DJ');
});

test('a last-place player is stopped one card short of a slam, however far behind', () => {
    const history = [
        'C2 CQ C5 C10', 'SA S3 S4 SQ', 'DA D6 D5 DJ',
        'HK H3 H4 H5', 'HQ H6 H7 H8', 'HJ H9 H10 H2', 'SK S2 S5 S7', 'S6 S8 S9 SJ', ...ending.slice(5)
    ];
    for (const totals of [[100, 80, -1200, 60], [100, 80, -100, 60], [100, 80, -800, 60], [100, 1500, -400, 0]]) {
        const pick = position({ history, trick: 'C4 CK HA', hand: 'C3 CA', totals });
        assert.equal(pick(0), 'CA');
        assert.equal(pick(32), 'CA');
    }
});

test('a penalty is worth the same on every opponent, and cumulative totals do not change the comparison', () => {
    const { ai } = load({}, Math);
    const totals = [130, -50, 60, -340]; // Seat 2 is second, 70 behind seat 0.
    const worth = (q, scores = totals) => ai.standingValue(2, scores, q, scores[q] - 100) - ai.standingValue(2, scores);
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b);
    close(worth(0), worth(1));
    close(worth(0), worth(3));
    close(worth(0), worth(0, [0, 0, 0, 0]));
    assert.ok(worth(2) < -2 * worth(0)); // Eating the pig costs three times what giving it away gains.
});

// East leads S6, South throws HJ and West plays SA. North is last, holding the pig and five lower spades.
test('the pig goes under a spade ace already on the table whoever leads the match', () => {
    const tucked = {
        history: ['C2 CA CK C5', 'D8 D5 D7 D2', 'S10 SK S5 SJ'], trick: 'S6 HJ SA',
        hand: 'SQ S9 S8 S4 S3 S2 C8 C7 C3 D3'
    };
    // South first with North second, West (the ace) first, all level, South far ahead, North first.
    for (const totals of [[130, -50, 60, -340], [-50, 130, 60, -340], [0, 0, 0, 0], [600, -50, 60, -340], [60, -50, 130, -340]]) {
        assert.equal(position({ ...tucked, totals })(0), 'SQ');
        for (const seed of [1, 19, 73]) assert.equal(position({ ...tucked, totals, seed })(32), 'SQ');
    }
});

test('the score projections match game settlement for ordinary hands, flipped specials and slams', () => {
    const { game, ai } = load({}, Math);
    const deck = game.createShuffledDeck();
    const hearts = deck.filter(c => c.suit === 'H').sort((a, b) => a.rank - b.rank);
    const specials = ['SQ', 'DJ', 'C10'].map(key => deck.find(c => name(c) === key));
    // Bits select the pig, sheep and transformer in that order.
    const sweepScores = [200, 300, 100, 500, 500, 500, 500, 1000];
    for (const [mask, expected] of sweepScores.entries()) {
        const kept = specials.filter((_, i) => mask & (1 << i));
        const full = game.calculatePlayerScore(kept.concat(hearts));
        assert.equal(full.cardPoints, expected);
        assert.equal(full.score, expected, 'a seat scored on its own, outside a round, has no base');
        assert.equal(game.calculatePlayerScore(kept.concat(hearts), false, -37.5).score, expected - 37.5,
            'the base comes on top of a fixed award, it is not part of it');
        assert.equal(full.isGrandSlam, mask === 7);
        if (expected === 500) assert.match(full.formula, /特殊規則.*\+500/);
        for (const count of [0, 1, 12, 13]) {
            const cards = kept.concat(hearts.slice(0, count));
            const cap = ai.newCap(cards.map(c => ai.toInt(c)));
            // The computers weigh card points only: the base is the same for all four seats.
            const settled = game.calculatePlayerScore(cards, count === 13);
            assert.equal(ai.score(cap, count === 13), settled.cardPoints);
            assert.equal(settled.score, settled.cardPoints);
            assert.equal(ai.score(cap, true, true), expected);
        }
    }
});

test('card values, doubling and table-wide color changes are applied to their holders', () => {
    const { game } = load({}, Math);
    const deck = game.createShuffledDeck();
    const hearts = deck.filter(c => c.suit === 'H').sort((a, b) => a.rank - b.rank);
    const [pig, sheep, transformer] = ['SQ', 'DJ', 'C10'].map(key => deck.find(c => name(c) === key));
    assert.deepEqual(hearts.map(card => game.calculatePlayerScore([card]).cardPoints),
        [-2, -3, -10, -5, -6, -7, -8, -9, -10, -20, -30, -40, -50]);
    for (const [piles, expected] of [
        [{}, [0, 0, 0, 0]],
        [{ south: [pig, transformer], west: [sheep] }, [-200, 100, 0, 0]],
        [{ south: [transformer], east: [pig] }, [50, 0, 0, -100]],
        [{ south: hearts, west: [pig], north: [sheep, transformer] }, [200, 100, -200, 0]],
        [{ south: [...hearts, transformer], west: [pig], north: [sheep] }, [500, 100, -100, 0]],
        [{ south: [...hearts, pig, sheep], east: [transformer] }, [500, 0, 0, 50]],
        [{ south: [...hearts.slice(1), pig, sheep, transformer], east: [hearts[0]] }, [-396, 0, 0, -2]]
    ]) {
        const round = game.calculateRoundScores(piles);
        assert.deepEqual(game.SEAT_ORDER.map(seat => round[seat].cardPoints), expected);
        const base = -expected.reduce((sum, points) => sum + points, 0) / 4;
        assert.deepEqual(game.SEAT_ORDER.map(seat => round[seat].score), expected.map(points => base + points));
    }
});

test('every round the four seats get the same base, so that their scores add up to 0; doubling and fixed awards leave it alone', () => {
    const { game } = load({}, Math);
    const deck = game.createShuffledDeck();
    const hearts = deck.filter(c => c.suit === 'H');
    const [pig, sheep, transformer] = ['SQ', 'DJ', 'C10'].map(key => deck.find(c => name(c) === key));
    const scores = round => game.SEAT_ORDER.map(seat => round[seat].score);
    assert.deepEqual(scores(game.calculateRoundScores()), [0, 0, 0, 0], 'before anyone has taken a card');
    for (const [piles, base, expected] of [
        [{ south: [pig, transformer], west: [sheep] }, '+25', [25 - 200, 25 + 100, 25, 25]],         // (-100) x 2, not (25 - 100) x 2
        [{ south: [transformer], east: [pig] }, '+12.5', [12.5 + 50, 12.5, 12.5, 12.5 - 100]],     // the lone transformer is worth 50 of its own
        [{ south: [...hearts, transformer], west: [pig] }, '-150', [-150 + 500, -150 + 100, -150, -150]],    // the special sweep is 500 plus the base
        [{ north: [...hearts, pig, sheep, transformer] }, '-250', [-250, -250, -250 + 1000, -250]]
    ]) {
        const round = game.calculateRoundScores(piles);
        assert.deepEqual(scores(round), expected);
        assert.equal(expected.reduce((sum, score) => sum + score, 0), 0, 'the round adds up to 0');
        for (const seat of game.SEAT_ORDER) assert.ok(round[seat].formula.startsWith(`底分(${base}) `), round[seat].formula);
    }
    assert.match(game.calculatePlayerScore([hearts[0], transformer]).formula, /牌分 × 2$/, 'the formula says what is doubled');
});

test('settlement credits a grand slam and a special sweep only once and records each round', () => {
    const document = { getElementById: id => id.startsWith('trick-slot-') ? {} : null };
    const { game } = load({}, Math, document);
    game.sound.enabled = false;
    game.renderAllPlayers = game.showCenterBanner = game.openScoreModal = () => {};
    const totals = () => game.SEAT_ORDER.map(seat => game.PLAYERS[seat].totalScore);
    game.PLAYERS.east.captured = game.createShuffledDeck().filter(c => c.isScoring);
    game.finishRound();
    game.finishRound();
    assert.equal(game.roundHistory.length, 1);
    assert.deepEqual(totals(), [-250, -250, -250, 750], 'the round is credited once, however often it is settled');

    game.closeScoreModal = game.updateHeaderInfo = game.later = () => {};
    game.startNextRound();
    assert.deepEqual(totals(), [-250, -250, -250, 750]);
    const opener = game.currentTurn;
    assert.ok(game.PLAYERS[opener].hand.some(c => c.id === 'S7'));
    assert.deepEqual(game.getLegalCards(opener), game.PLAYERS[opener].hand);
    const deck = game.createShuffledDeck();
    game.PLAYERS.south.captured = deck.filter(c => c.suit === 'H' || c.id === 'C10');
    game.PLAYERS.west.captured = [deck.find(c => c.id === 'S12')];
    game.PLAYERS.north.captured = [deck.find(c => c.id === 'D11')];
    game.finishRound();
    game.finishRound();
    // card points 500, +100 (the pig turned), -100 (the sheep turned), 0: the base is -125
    assert.deepEqual(totals(), [-250 + 375, -250 - 25, -250 - 225, 750 - 125]);
    assert.equal(totals().reduce((sum, total) => sum + total, 0), 0, 'the totals keep an average of 0');
    assert.deepEqual(game.roundHistory.map(round => round.scores.south), [375, -250]);
    const record = game.getRecord();
    assert.equal(record.result.south.score, 375);
    assert.match(record.result.south.formula, /^底分\(-125\) 特殊規則/);
    assert.equal(record.totals.east, 750);
    assert.deepEqual(record.settings, { scoringRuleMode: 'player_special', roundBase: 'zero-sum' }, 'the record says how its scores were based');
});

test('avoid doubling a pig, use another winner if forced, and double a sheep when it pays', () => {
    const small = 'C3 C10 D2 D4 D6 D8 D10 S2 S4 S6 H2 H4 H6';
    for (const [trick, hand, expected] of [
        ['C2 C7 SQ', small, 'C3'],
        ['C2 C7 SQ', small.replace('C3', 'CA'), 'CA'],
        ['C2 C7 DJ', small, 'C10']
    ]) {
        const pick = position({ trick, hand });
        assert.equal(pick(0), expected);
        assert.equal(pick(32), expected);
    }
});

test('do not lead the transformer into more penalties after taking HA and HJ', () => {
    const state = {
        leader: 0, history: ['C2 C6 CK CQ', 'H3 HA HJ C9'], trick: '',
        hand: 'SA SK S8 H10 H4 CJ C10 C4 C3 D3 D2'
    };
    for (const seed of [1, 19, 73]) assert.notEqual(position({ ...state, seed })(32), 'C10');
});

test('cash the club ace on an empty trick or duck if the last player has shown a club void', () => {
    for (const [lastCard, expected] of [['C7', 'CA'], ['H2', 'C3']]) {
        const pick = position({
            leader: 0, history: ['C2 CK C5 ' + lastCard, 'H9 H4 H6 H3', 'H10 H7 H5 HJ'],
            trick: 'C4 C6', hand: 'C3 CA S2 S5 S8 S9 D2 D4 D6 H8'
        });
        assert.equal(pick(0), expected);
        assert.equal(pick(32), expected);
    }
});

test('with two tricks left, lead the diamond king while the sheep is still out', () => {
    const state = {
        leader: 2, history: ['C2 CK CQ C8', 'H2 H7 H3 HK', 'C10 C9 C4 C6', 'CJ C7 CA C3',
            'D10 D6 D5 D4', 'D3 D2 D9 DQ', 'H8 H5 H9 H4', 'HJ D7 H6 HQ', 'S9 S2 S8 S6',
            'SJ SK S10 S5', 'H10 SA C5 HA'], trick: '', hand: 'S3 DK'
    };
    for (const seed of [1, 19, 73]) assert.equal(position({ ...state, seed })(24), 'DK');
});

test('place an ordinary sheep with the known ace winner when keeping it risks the transformer holder taking it', () => {
    const pick = position({
        leader: 3, history: ['C2 CA C4 CQ', 'S2 S3 SJ S10', 'H7 H2 HA HQ', 'D5 DQ D8 D10',
            'H6 H4 HJ H8', 'C5 C9 C8 C7', 'S5 S8 SA S6', 'H3 H5 D9 C6', 'C10 D3 C3 HK',
            'S7 S4 S9 H10', 'SQ H9 D7 SK'], trick: 'DA CK', hand: 'DJ D4'
    });
    assert.equal(pick(24), 'DJ');
});

test('endgame hypotheses respect public voids and an expensive voluntary capture is soft evidence', () => {
    const { ai } = load({}, Math);
    const unseen = [5, 6, 40, 41, 16, 17], need = [0, 2, 2, 2];
    const all = ai.lastDeals(unseen, need, [0, 0, 0, 0], 0, [0, 1]);
    const limited = ai.lastDeals(unseen, need, [0, 1, 0, 0], 0, [0, 1]);
    assert.equal(new Set(all.map(h => JSON.stringify(h))).size, 90);
    assert.equal(limited.length, 36);
    assert.ok(limited.every(h => h[1].every(c => c >= 13)));

    const trick = [{ p: 0, c: 31 }, { p: 1, c: ai.PIG }, { p: 2, c: 30 }]; // C7, SQ, C6
    const cap = [[13], [], [14], []].map(cards => ai.newCap(cards));
    const live = [8191, 8191, 8191, 8191];
    for (const c of [13, 14, ...trick.map(t => t.c)]) live[Math.floor(c / 13)] &= ~(1 << (c % 13));
    const clue = { p: 3, card: 37, known: [37], trick, cap, live, voids: [0, 4, 0, 0] }; // CK took the pig.
    const weight = held => ai.dealWeight([[], [], [], held], [clue], { totals: [0, 0, 0, 0] });
    assert.ok(weight([27, 39]) < weight([38, 39])); // A C3 could have ducked. A CA could not.
    assert.ok(weight([27, 39]) > 0);
});

// South took eight hearts in two tricks but holds none. High hearts are still outside,
// and one of them landing in another pile ends the sweep. Over 538 recorded rounds the computers
// completed about one such attempt in five, and paid for the pig and the transformer in the rest.
const stranded = ['H5 H6 H9 H7', 'D4 D9 DK D8', 'H2 H4 H10 H8'];
test('without the top hearts, eight hearts in the pile are no reason to take the pig or the transformer', () => {
    for (const [history, trick, hand, expected] of [
        [['C2 CA C7 C5', ...stranded, 'C3 C6 C9 C4'], 'S5 SQ', 'SA S3 D2 D5 D7 C8 CJ DQ', 'S3'],
        [['S7 SA S2 S5', ...stranded.slice(0, 2), 'H2 H4 HJ H8', 'S3 S6 S9 S4'], 'C5 C10', 'CA C3 D2 D5 D7 S8 SJ DQ', 'C3']
    ]) {
        assert.equal(position({ history, trick, hand })(0), expected);
        for (const seed of [1, 19, 73]) assert.equal(position({ history, trick, hand, seed })(32), expected);
    }
});

test('holding the four top hearts the sweep is on: take the pig for the lead, in the simulation as well', () => {
    const state = {
        history: ['C2 CA C7 C5', 'H5 H6 H9 H7', 'D4 D9 DK D8'], trick: 'S5 SQ', hand: 'SA S3 HA HK HQ HJ D2 D5 C8 CJ'
    };
    assert.equal(position(state)(0), 'SA');
    for (const seed of [1, 19, 73]) assert.equal(position({ ...state, seed })(32), 'SA');
});

test('only a seat\'s own sweep is discounted: the same pile in an opponent\'s hands is feared in full', () => {
    const { ai } = load({}, Math);
    // Seat 0 took eight hearts in two tricks. H3, HJ, HQ, HK and HA are still out and neither seat asked holds one.
    const cap = [[13, 15, 16, 17, 18, 19, 20, 21], [], [], []].map(cards => ai.newCap(cards));
    cap[0].heartTricks = 2;
    const outside = [8191, 0b1111000000010, 8191, 8191];
    const share = 9 / 14;
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b);
    const own = ai.sweepForecast(0, [0, 0, 0, 0], outside, cap, [0, 0, 0, 0], null);
    const feared = ai.sweepForecast(1, [0, 0, 0, 0], outside, cap, [0, 0, 0, 0], null);
    assert.equal(own.seat, 0);
    assert.equal(feared.seat, 0);
    close(feared.chance, share);
    close(feared.credit, 1);
    close(own.chance, ai.OWN_SWEEP_SHARE * share);
    close(own.credit, ai.OWN_SWEEP_SHARE);
    assert.ok(ai.OWN_SWEEP_SHARE > 0 && ai.OWN_SWEEP_SHARE < 0.5);

    // With the four top hearts in hand and one small heart out, the same seat counts its hearts almost in full.
    const sure = ai.sweepForecast(0, [0, 0b1111000000000, 0, 0], [8191, 0b10, 8191, 8191], cap, [0, 0, 0, 0], null);
    assert.ok(sure.credit > 0.85 && sure.chance > 0.85, JSON.stringify(sure));
});

// In the recorded rounds the simulation ended with all thirteen hearts half again as often as really happened:
// half of the simulated opponents only avoid penalties and never step in.
test('simulated opponents do not sit back while the seat that is deciding holds every heart taken so far', () => {
    const { ai } = load({}, Math);
    const hands = [[12, 39, 42, 32], [0, 40, 43, 27], [1, 41, 44, 28], [2, 45, 46, 29]];
    const live = [0, 0, 0, 0];
    for (const c of hands.flat()) live[Math.floor(c / 13)] |= 1 << (c % 13);
    const match = { totals: [0, 0, 0, 0] };
    const styles = piles => {
        const cap = piles.map(cards => ai.newCap(cards));
        const seen = [];
        const policy = ai.policy;
        ai.policy = function (p, hand, trick, taken, left, voids, game, caution) {
            if (p !== 0) seen.push(caution);
            return policy.apply(this, arguments);
        };
        ai.playout(hands, [], 39, 0, cap, live, [0, 0, 0, 0], match, [0, 0.75, 0.75, 0.75]);
        ai.policy = policy;
        assert.ok(seen.length >= 3);
        return new Set(seen);
    };
    assert.deepEqual([...styles([[13, 15, 16], [], [], []])], [0]);        // seat 0 alone holds hearts: everyone watches it
    assert.deepEqual([...styles([[13, 15, 16], [14], [], []])], [0.75]);   // hearts already split: styles as dealt out
    assert.deepEqual([...styles([[], [14, 15], [], []])], [0.75]);         // someone else is collecting: styles as dealt out
});
