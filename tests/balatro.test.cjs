'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Run, evaluate, blind, blindCount } = require('../games/assets/balatro.js');

function cards(text) {
    return text.split(' ').map((code, id) => ({
        id, suit: 'SHCD'.indexOf(code[0]), rank: '23456789TJQKA'.indexOf(code[1]) + 2, bonus: 0
    }));
}
function deal(run, text) {
    run.hand = cards(text).map(c => c.suit * 13 + c.rank - 2);
    run.stock = run.stock.filter(id => !run.hand.includes(id));
    return run.hand.slice();
}

test('recognizes each hand and counts only the cards that form it', () => {
    for (const [holding, kind, scoring] of [
        ['H2 DT CK', 'high', [2]], ['DA HQ SA', 'pair', [0, 2]],
        ['S2 C2 D8 H8 SA', 'twoPair', [0, 1, 2, 3]], ['HT DA CT DT', 'three', [0, 2, 3]],
        ['SA D2 C3 H4 S5', 'straight', [0, 1, 2, 3, 4]], ['ST HJ CQ SK DA', 'straight', [0, 1, 2, 3, 4]],
        ['SA S3 S7 S9 SJ', 'flush', [0, 1, 2, 3, 4]], ['D2 H2 S2 C3 D3', 'house', [0, 1, 2, 3, 4]],
        ['D2 H2 S2 C2 D3', 'four', [0, 1, 2, 3]], ['H6 H7 H8 H9 HT', 'straightFlush', [0, 1, 2, 3, 4]],
        ['CQ CQ SQ DQ HQ', 'five', [0, 1, 2, 3, 4]], ['H2 H2 H2 H3 H3', 'flushHouse', [0, 1, 2, 3, 4]],
        ['ST ST ST ST ST', 'flushFive', [0, 1, 2, 3, 4]], ['SQ HK DA C2 S3', 'high', [2]],
        ['S2 S3 S4 S5', 'high', [3]]
    ]) {
        const result = evaluate(cards(holding));
        assert.equal(result.kind, kind, holding);
        assert.deepEqual(result.pips.map(c => c.id).sort((a, b) => a - b), scoring, holding);
    }
});

test('joker order, permanent silver chips and hand levels all affect the shown score', () => {
    const run = new Run(9), selected = deal(run, 'S2 S5 S8 ST SK');
    run.cast = [0, 5];
    assert.equal(run.preview(selected).points, 756);
    run.cast.reverse();
    assert.equal(run.preview(selected).points, 644);
    run.deck[selected[1]].bonus = 25;
    run.levels.flush++;
    const score = run.preview(selected);
    assert.deepEqual([score.chips, score.mult, score.points], [115, 12.8, 1472]);
    assert.ok(run.apply({type: 'play', cards: selected}));
    assert.deepEqual(run.last, {...score, cards: selected});
    assert.equal(run.score, score.points);
});

test('discards, invalid inputs and concurrent stale cards never consume the wrong resources', () => {
    const run = new Run(0);
    const initial = run.save(), held = run.hand.slice();
    for (const invalid of [[], [held[0], held[0]], [run.stock[0]], held.slice(0, 6), null]) {
        assert.equal(run.preview(invalid), null);
        assert.equal(run.apply({type: 'play', cards: invalid}), false);
    }
    assert.equal(run.apply({type: 'next'}), false);
    assert.equal(run.save(), initial);
    assert.ok(run.apply({type: 'discard', cards: held.slice(0, 5)}));
    assert.deepEqual([run.plays, run.discards, run.stock.length, run.hand.length], [4, 2, 39, 8]);
    assert.ok(!run.hand.some(id => held.slice(0, 5).includes(id)));
    assert.equal(run.apply({type: 'play', cards: [held[0]]}), false);
    for (let i = 0; i < 2; i++) run.apply({type: 'discard', cards: [run.hand[0]]});
    assert.equal(run.apply({type: 'discard', cards: [run.hand[0]]}), false);
    assert.equal(new Set([...run.hand, ...run.stock]).size, run.hand.length + run.stock.length);
});

test('a clear pays once, shop transactions are atomic, and the next blind restores the whole deck', () => {
    const run = new Run(31);
    run.cast.push(10);
    run.money = 60;
    run.score = run.blind.target - 1;
    assert.ok(run.apply({type: 'play', cards: [run.hand[0]]}));
    assert.equal(run.phase, 'shop');
    assert.equal(run.reward, 3 + 3 + 5 + 3);
    const amount = run.money, joker = run.shop[0].id, cost = run.shop[0].price;
    assert.ok(run.apply({type: 'buy', slot: 0}));
    assert.equal(run.apply({type: 'buy', slot: 0}), false);
    assert.equal(run.money, amount - cost);
    assert.ok(run.apply({type: 'move', joker, by: -1}));
    assert.equal(run.cast[1], joker);
    assert.equal(run.apply({type: 'move', joker, by: 3}), false);
    assert.ok(run.apply({type: 'sell', joker}));
    assert.equal(run.money, amount - cost + Math.floor(cost / 2));
    for (const hand of ['other', ['pair'], 'constructor']) assert.equal(run.apply({type: 'buy', slot: 2, hand}), false);
    assert.ok(run.apply({type: 'buy', slot: 2, hand: 'pair'}));
    assert.equal(run.levels.pair, 2);
    const silver = {...run.shop[3].card, id: 52};
    assert.ok(run.apply({type: 'buy', slot: 3}));
    assert.deepEqual(run.deck.at(-1), silver);
    const pocket = run.money;
    assert.ok(run.apply({type: 'reroll'}));
    assert.deepEqual([run.reroll, run.money, run.shop.length], [3, pocket - 2, 4]);
    run.money = 0;
    assert.equal(run.apply({type: 'reroll'}), false);
    assert.equal(run.apply({type: 'buy', slot: 3}), false);
    run.cast = [0, 1, 2, 3, 4];
    run.money = 100;
    assert.equal(run.apply({type: 'buy', slot: 0}), false);
    assert.ok(run.apply({type: 'next'}));
    assert.deepEqual([run.phase, run.step, run.score, run.plays, run.discards, run.reroll], ['play', 1, 0, 4, 3, 2]);
    assert.equal(new Set([...run.hand, ...run.stock]).size, 53);
    assert.ok([...run.hand, ...run.stock].includes(silver.id));
});

test('the eight bosses affect play counts, hand size, pips, or score as described', () => {
    assert.equal(blindCount, 24);
    assert.equal(blind(0).target, 180);
    for (let step = 1; step < blindCount; step++) assert.ok(blind(step).target > blind(step - 1).target || step % 3 === 0);
    const run = new Run(3);
    function boss(act) { run.step = act * 3 - 1; run.openBlind(); }
    boss(1); assert.equal(run.plays, 3);
    boss(2); assert.equal(run.discards, 1);
    boss(3); assert.equal(run.hand.length, 6);
    boss(4);
    const pair = deal(run, 'S2 H2');
    const first = run.preview(pair);
    run.last = first;
    assert.equal(run.preview(pair).points, first.points / 2);
    boss(5);
    const court = deal(run, 'SQ HQ');
    run.cast = [6];
    assert.equal(run.preview(court).chips, 10 + 2 * 18);
    boss(6);
    assert.equal(run.preview(deal(run, 'DA SA')).chips, 10 + 11);
    boss(7);
    const high = deal(run, 'SA');
    assert.equal(run.preview(high).points, 8);
    run.last = {kind: 'high'};
    assert.equal(run.preview(high).points, 16);
    boss(8); assert.deepEqual([run.plays, run.discards], [3, 1]);
});

test('meeting the final target on the last hand wins, missing by one ends the run', () => {
    for (const [shortfall, phase] of [[0, 'won'], [1, 'lost']]) {
        const run = new Run(14);
        run.step = blindCount - 1;
        run.openBlind();
        run.plays = 1;
        const cards = [run.hand[0]], preview = run.preview(cards);
        run.score = run.blind.target - preview.points - shortfall;
        assert.ok(run.apply({type: 'play', cards}));
        assert.equal(run.phase, phase);
        assert.equal(run.apply({type: 'next'}), false);
        assert.equal(run.apply({type: 'play', cards: [run.hand[0]]}), false);
    }
});

test('a seed and move log restore shuffles, shop offers, purchases and a partially played next blind', () => {
    const run = new Run(2);
    function bestHand() {
        let best = {points: -1}, move;
        for (let bits = 1; bits < 2 ** run.hand.length; bits++) {
            const cards = run.hand.filter((_, i) => bits & 1 << i), value = run.preview(cards);
            if (value && value.points > best.points) { best = value; move = cards; }
        }
        return move;
    }
    while (run.phase === 'play') run.apply({type: 'play', cards: bestHand()});
    assert.equal(run.phase, 'shop');
    assert.ok(run.apply({type: 'reroll'}));
    assert.ok(run.apply({type: 'buy', slot: 0}));
    assert.ok(run.apply({type: 'move', joker: run.cast[1], by: -1}));
    assert.deepEqual(Run.restore(run.save()), run);
    run.apply({type: 'next'});
    run.apply({type: 'discard', cards: run.hand.slice(0, 3)});
    assert.deepEqual(Run.restore(run.save()), run);
    for (const invalid of ['', 'invalid', 'null', '{"version":2,"seed":0,"actions":[]}',
        '{"version":1,"seed":0,"actions":[{"type":"next"}]}']) assert.equal(Run.restore(invalid), null);
});
