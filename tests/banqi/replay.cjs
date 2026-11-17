'use strict';
// Reconstruct only the requested prefix. A decision before move N never receives
// the recorded reveal at N or any later move, nor the final board in the file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { load, apply, validate, terminal, decide, snapshot } = require('./harness.cjs');

function replay(record, { plies = record.moves.length, api = load() } = {}) {
    assert.equal(record.format, 'banqi-public-v1');
    assert.ok(Number.isInteger(plies) && plies >= 0 && plies <= record.moves.length);
    const st = api.Engine.createState(), colors = { south: null, north: null };
    const history = { positions: [], log: [] };
    let nextSeat = null, result = null;
    for (let i = 0; i < plies; i++) {
        const e = record.moves[i];
        assert.equal(result, null, 'No move may follow a terminal position');
        assert.equal(e.n, i + 1);
        assert.ok(e.seat === 'south' || e.seat === 'north');
        if (nextSeat !== null) assert.equal(e.seat, nextSeat);
        nextSeat = e.seat === 'south' ? 'north' : 'south';
        if (colors[e.seat] === null) {
            assert.equal(e.kind, 'flip');
            colors[e.seat] = e.code <= 7 ? 0 : 1;
            colors[nextSeat] = 1 - colors[e.seat];
        }
        assert.equal(e.color, colors[e.seat]);
        const action = e.kind === 'flip' ? { type: 'flip', sq: e.sq }
            : { type: e.kind, from: e.from, to: e.to };
        let draw;
        if (e.kind === 'flip') {
            assert.ok(Number.isInteger(e.code) && e.code >= 1 && e.code <= 14 && st.pool[e.code] > 0);
            const index = [...st.pool].slice(0, e.code).reduce((a, b) => a + b, 0);
            draw = () => (index + 0.5) / st.hidden;
        } else {
            assert.equal(st.board[e.from], e.code);
            assert.equal(st.board[e.to], e.captured);
        }
        const entry = apply(api, st, colors[e.seat], action, draw);
        if (e.kind === 'flip') assert.equal(entry.code, e.code);
        history.log.push(entry);
        history.positions.push(api.positionKey(st.board, colors[nextSeat]));
        result = terminal(api, st, colors[nextSeat]);
    }
    validate(st);
    return { st, colors, nextSeat, history, result };
}

if (require.main === module) {
    const args = process.argv.slice(2), opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
    const record = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const before = Number(opt('--before', record.moves.length + 1));
    assert.ok(before >= 1, '--before uses move numbers starting at 1');
    const api = load({ ref: opt('--ref'), sourcePath: opt('--source'), ms: Number(opt('--ms', 1000)), production: true });
    const r = replay(record, { api, plies: before - 1 });
    if (before === record.moves.length + 1) {
        assert.equal(snapshot(r.st), JSON.stringify({ b: record.state.board, p: record.state.pool,
            a: record.state.alive, h: record.state.hidden, q: record.state.quiet }));
    }
    const next = r.nextSeat === null ? null : r.colors[r.nextSeat];
    const decision = args.includes('--analyze') && !r.result && next !== null ? decide(api, r.st, next, r.history) : null;
    console.log(JSON.stringify({ before, nextSeat: r.nextSeat, result: r.result, publicState: JSON.parse(snapshot(r.st)), decision }, null, 2));
}
module.exports = { replay };
