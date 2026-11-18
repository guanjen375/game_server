'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileFunction } = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../games/gongzhu.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const load = compileFunction(script + '\nreturn { game, ai: GongZhuAI };', ['window', 'Math']);
const name = card => card.suit + card.label;

// Replay the public tricks in play order. The bot only gets its own remaining hand.
function position({ history = [], trick, hand, totals = [0, 0, 0, 0], leader = 1, mode = 'classic', seed = 1 }) {
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
    game.scoringRuleMode = mode;
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

test('after a single zero-point heart, the simulation already weighs the possible sweep against the standings', () => {
    const early = {
        history: ['C2 CA C3 H4'], trick: 'H8 H2 H3', hand: 'H5 H9 S2 S4 S6 S8 D2 D4 D6 D8 C4 C6'
    };
    // An empty sample set exercises the same policy that plays every simulated turn.
    assert.equal(position(early)(0), 'H9');
    assert.equal(position({ ...early, totals: [70, 100, -1200, 80] })(0), 'H5');
});

// After four tricks all hearts are out. Moving just the first heart to a second
// player changes the value of the sheep and pig for the entire table.
const swept = ['C2 CA C7 H2', 'HA H3 H4 H5', 'HK H6 H7 H8', 'HQ H9 H10 HJ'];
const split = ['C2 C7 CA H2', 'H3 H4 H5 HA', 'HK H6 H7 H8', 'HQ H9 H10 HJ'];
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

// With only the zero-point H2 left to score, the bot can duck with C3 or take
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
    for (const mode of ['classic', 'strict_swap', 'super_slam']) {
        const pick = position({ history, trick: 'DA D2', hand: 'DJ D3 D4 S3 S5 S7 S9 SJ SK', mode });
        assert.notEqual(pick(0), 'DJ');
        assert.notEqual(pick(32), 'DJ');
    }
});

test('the same last-place player can be allowed a slam or stopped as the score gap and bonus change', () => {
    const history = [
        'C2 CQ C5 C10', 'SA S3 S4 SQ', 'DA D6 D5 DJ',
        'HK H3 H4 H5', 'HQ H6 H7 H8', 'HJ H9 H10 H2', ...ending.slice(3)
    ];
    for (const [totals, mode, expected] of [
        [[100, 80, -1200, 60], 'super_slam', 'C3'], // Even +1000 leaves them behind. Taking HA costs us 50.
        [[100, 80, -100, 60], 'super_slam', 'CA'],  // The same +1000 would now put them first.
        [[100, 80, -800, 60], 'classic', 'C3'],
        [[100, 80, -800, 60], 'super_slam', 'CA'],
        [[100, 1500, -400, 0], 'classic', 'CA']     // The leader is safe, but our second place is at stake.
    ]) {
        const pick = position({ history, trick: 'C4 CK HA', hand: 'C3 CA', totals, mode });
        assert.equal(pick(0), expected);
        assert.equal(pick(32), expected);
    }
});

test('the score projections match game settlement for ordinary hands, flipped specials and slams', () => {
    const { game, ai } = load({}, Math);
    const deck = game.createShuffledDeck();
    const hearts = deck.filter(c => c.suit === 'H').sort((a, b) => a.rank - b.rank);
    const specials = ['SQ', 'DJ', 'C10'].map(key => deck.find(c => name(c) === key));
    for (const mode of ['classic', 'strict_swap', 'super_slam']) {
        game.scoringRuleMode = mode;
        for (let mask = 0; mask < 8; mask++) {
            const kept = specials.filter((_, i) => mask & (1 << i));
            const fullScore = game.calculatePlayerScore(kept.concat(hearts), true).score;
            for (const count of [0, 1, 12, 13]) {
                const cards = kept.concat(hearts.slice(0, count));
                const cap = ai.newCap(cards.map(c => ai.toInt(c)));
                assert.equal(ai.score(cap, count === 13, mode), game.calculatePlayerScore(cards, count === 13).score);
                assert.equal(ai.score(cap, true, mode, true), fullScore);
                if (!count) assert.equal(ai.score(cap, true, mode), game.calculatePlayerScore(cards, true).score);
            }
        }
    }
});
