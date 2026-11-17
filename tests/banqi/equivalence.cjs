'use strict';
// Semantic/performance check for the evaluation optimization. Identical scores
// alone are not a strength test; matches and action-based fixtures are separate.
const fs = require('node:fs'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { load, rng, apply, moves, terminal, snapshot } = require('./harness.cjs');
const { positions } = require('./positions.cjs');
const args = process.argv.slice(2), opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const old = load({ ref: opt('--ref', '27136d6'), fixed: true });
const current = load({ sourcePath: opt('--source'), fixed: true });
const samples = Object.values(positions).map(f => f()), random = rng(2938);
for (let g = 0; g < 20; g++) {
    const st = old.Engine.createState();
    for (let ply = 0; ply < 200; ply++) {
        const side = ply % 2, legal = moves(old, st, side);
        const hidden = [...st.board].flatMap((p, i) => p === 15 ? [i] : []);
        if (!legal.length && !hidden.length) break;
        let action;
        if (hidden.length && (!legal.length || random() < 0.5)) action = { type: 'flip', sq: hidden[Math.floor(random() * hidden.length)] };
        else {
            const m = legal[Math.floor(random() * legal.length)];
            action = { type: st.board[m & 31] ? 'capture' : 'move', from: m >> 5, to: m & 31 };
        }
        apply(old, st, side, action, random);
        samples.push(old.Engine.cloneState(st));
        if (terminal(old, st, 1 - side)) break;
    }
}
for (const st of samples) {
    const before = snapshot(st), vals = old.Engine.computeValues(st, new Float64Array(15));
    assert.equal(old.Engine.pressureScore(st, vals), current.Engine.pressureScore(st, vals));
    assert.deepEqual([...old.Engine._unsafe], [...current.Engine._unsafe]);
    for (const side of [0, 1]) assert.equal(old.Engine.evaluate(st, side), current.Engine.evaluate(st, side));
    assert.equal(snapshot(st), before);
}
const timing = [];
// Warm-up above; alternate the order to avoid always giving one engine the warm CPU.
for (let round = 0; round < 6; round++) for (const api of round % 2 ? [current, old] : [old, current]) {
    api.Engine._evalCache = api.Engine._valueCache = null;
    const start = performance.now();
    let checksum = 0;
    for (const st of samples) checksum += api.Engine.evaluate(st, 0);
    timing.push({ round, engine: api === current ? 'current' : 'previous', ms: performance.now() - start, checksum });
}
const search = [];
for (const [id, make] of Object.entries(positions)) {
    const st = make();
    if (st.quiet > 40) continue; // The deliberate 50-ply correction is a behavior change.
    const results = [old, current].map(api => {
        const ctx = api.BanqiAI.getContext(1000), before = snapshot(st);
        const score = api.Engine.search(st, 0, 3, -api.INF, api.INF, 0, 1, ctx);
        assert.equal(snapshot(st), before);
        return { score, nodes: ctx.nodes };
    });
    assert.deepEqual(results[0], results[1], id);
    search.push({ id, ...results[0] });
}
const result = { previousHash: old.sourceHash, currentHash: current.sourceHash,
    positions: samples.length, exactScores: true, exactDangerMasks: true, search, timing };
fs.writeFileSync(opt('--out', '/tmp/banqi-equivalence.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ positions: samples.length, identicalSearches: search.length, timing }));
