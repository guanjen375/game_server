'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { load, state, snapshot, moves, apply, terminal, transform, decide, rng, sq, R, B } = require('./banqi/harness.cjs');
const { positions } = require('./banqi/positions.cjs');
const engine = (options = {}) => load({ ref: process.env.BANQI_REF, sourcePath: process.env.BANQI_SOURCE, fixed: true, depth: 6, nodes: 60000, ...options });
const move = (from, to, type = 'move') => ({ type, from: sq(from), to: sq(to) });
const sameMove = (a, from, to) => a.from === sq(from) && a.to === sq(to);

for (const side of [0, 1]) for (const mirror of [false, true]) for (const vertical of [false, true]) {
    const at = s => { const n = sq(s); return (vertical ? 3 - (n >> 3) : n >> 3) * 8 + (mirror ? 7 - (n & 7) : n & 7); };
    test(`confined-guard pressure: color=${side}, mirror=${mirror}, vertical=${vertical}`, () => {
        const api = engine({ depth: 4 }), st = transform(positions.safe_pressure(), side, mirror, vertical);
        const { action } = decide(api, st, side);
        assert.equal(action.type, 'move');
        assert.equal(action.from, at('b2')); assert.equal(action.to, at('b3'));
        apply(api, st, side, action);
        assert.ok(api.Engine.isAttackedBy(st, at('a3'), side));
        assert.ok(!api.Engine.isAttackedBy(st, at('b3'), 1 - side));
        // The guard's only adjacent empty square is occupied by the stronger king.
        assert.ok(!moves(api, st, 1 - side).some(m => m >> 5 === at('a3')));
    });
    test(`save last cannon: color=${side}, mirror=${mirror}, vertical=${vertical}`, () => {
        const api = engine(), st = transform(positions.last_counter(), side, mirror, vertical);
        const { action } = decide(api, st, side);
        assert.equal(action.type, 'move'); assert.equal(action.from, at('b3'));
        assert.ok([at('a3'), at('b4')].includes(action.to));
        apply(api, st, side, action);
        assert.ok(!api.Engine.isAttackedBy(st, action.to, 1 - side));
    });
}

for (const id of ['pawn_danger', 'cannon_danger', 'recapture_danger']) for (const side of [0, 1]) {
    test(`avoid known threat ${id}, color=${side}`, () => {
        const api = engine(), st = transform(positions[id](), side);
        const { action } = decide(api, st, side);
        assert.ok(!sameMove(action, 'b2', 'b3'));
        // Show why the tempting advance is unsafe using legal replies, not evaluation scores.
        apply(api, st, side, move('b2', 'b3'));
        assert.ok(moves(api, st, 1 - side).some(m => (m & 31) === sq('b3')));
    });
}

for (const [att, victim] of [[R.king, B.guard], [R.guard, B.elephant], [R.rook, B.horse]]) {
    test(`pressure generalizes to rank ${att} vs ${victim}`, () => {
        const api = engine({ depth: 4 });
        const st = state({ b2: att, a3: victim }, ['a2', 'a4'], [R.rook, B.pawn], 15);
        assert.ok(sameMove(decide(api, st, 0).action, 'b2', 'b3'));
    });
}

test('after a defensive pawn reveal, retreat when taking the guard would trap the king', () => {
    const api = engine({ depth: 4 }), st = positions.pressure();
    apply(api, st, 0, move('b2', 'b3'));
    const beforePawn = Array.from(st.pool).slice(0, B.pawn).reduce((a, b) => a + b, 0);
    apply(api, st, 1, { type: 'flip', sq: sq('b4') }, () => (beforePawn + 0.5) / st.hidden);
    assert.equal(st.board[sq('b4')], B.pawn);
    const { action } = decide(api, st, 0);
    assert.ok(sameMove(action, 'b3', 'c3'));
    apply(api, st, 0, action);
    assert.ok(!api.Engine.isAttackedBy(st, action.to, 1));
    const trap = positions.pressure();
    apply(api, trap, 0, move('b2', 'b3'));
    apply(api, trap, 1, {type:'flip', sq:sq('b4')}, () => 0.99);
    apply(api, trap, 0, move('b3', 'a3', 'capture'));
    apply(api, trap, 1, move('b4', 'b3'));
    assert.ok(!moves(api, trap, 0).some(m => m >> 5 === sq('a3')), 'The greedy king has no legal escape');
    assert.ok(api.Engine.isAttackedBy(trap, sq('a3'), 1));
});

test('the default normal level also escapes the pawn trap at its two-ply horizon', () => {
    const api = engine(), st = positions.pressure();
    apply(api, st, 0, move('b2', 'b3'));
    apply(api, st, 1, {type:'flip', sq:sq('b4')}, () => 0.99);
    const action = api.BanqiAI.chooseAction(st, 0, 'normal');
    assert.equal(action.from, sq('b3'));
    assert.ok(!sameMove(action, 'b3', 'a3'));
    apply(api, st, 0, action);
    assert.ok(!api.Engine.isAttackedBy(st, action.to, 1));
});

for (const side of [0, 1]) {
    test(`trade with a hidden backup cannon, color=${side}`, () => {
        const api = engine(), st = transform(positions.hidden_backup(), side);
        const { action } = decide(api, st, side);
        assert.ok(sameMove(action, 'b3', 'd3')); assert.equal(action.type, 'capture');
        apply(api, st, side, action); apply(api, st, 1 - side, move('d2', 'd3', 'capture'));
        assert.equal(st.pool[R.cannon + side * 7], 1);
        assert.equal(st.alive[R.cannon + side * 7], 1);
    });
    test(`trade away last counter when its final target is removed, color=${side}`, () => {
        const api = engine(), st = transform(positions.last_target_trade(), side);
        const { action } = decide(api, st, side);
        assert.ok(sameMove(action, 'b3', 'd3'));
        apply(api, st, side, action); apply(api, st, 1 - side, move('d2', 'd3', 'capture'));
        assert.equal(st.alive[B.guard - side * 7], 0);
        assert.equal(st.alive[R.elephant + side * 7], 1);
    });
}

test('save a last king counter from a pawn recapture', () => {
    const api = engine(), st = positions.last_king();
    assert.ok(!sameMove(decide(api, st, 0).action, 'b2', 'c2'));
});
test('when preservation is impossible, make the only legal capture', () => {
    const api = engine(), st = positions.forced_trade();
    assert.equal(moves(api, st, 0).length, 1);
    assert.ok(sameMove(decide(api, st, 0).action, 'b2', 'd2'));
});
test('a last-cannon trade can keep a points route instead of losing immediately at 50', () => {
    const api = engine(), st = positions.score_trade();
    assert.ok(api.Engine.capturedPoints(st, 0) < api.Engine.capturedPoints(st, 1));
    const { action } = decide(api, st, 0);
    assert.ok(sameMove(action, 'b3', 'd3'));
    apply(api, st, 0, action); apply(api, st, 1, move('d2', 'd3', 'capture'));
    assert.equal(st.alive[R.cannon], 0);
    assert.ok(api.Engine.capturedPoints(st, 0) > api.Engine.capturedPoints(st, 1));
    assert.equal(terminal(api, st, 0), null, 'A points route is not a premature declaration of victory');
});

for (const [id, from, to] of [['cannon_shot','a1','d1'], ['cannon_screen','b2','b1'], ['major_exchange','b2','c2'], ['pawn_king','a1','b1']]) {
    for (const side of [0, 1]) test(`tactical baseline ${id}, color=${side}`, () => {
        const api = engine(), st = transform(positions[id](), side);
        assert.ok(sameMove(decide(api, st, side).action, from, to));
    });
}
test('cannon screen construction wins a guard against every legal reply', () => {
    const api = engine({ depth: 4 }), st = positions.cannon_screen();
    apply(api, st, 0, decide(api, st, 0).action);
    for (const reply of moves(api, st, 1)) {
        const next = api.Engine.cloneState(st);
        apply(api, next, 1, { type: next.board[reply & 31] ? 'capture' : 'move', from: reply >> 5, to: reply & 31 });
        const { action } = decide(api, next, 0);
        assert.equal(next.board[action.to], B.guard, 'Capture the guard wherever it retreats');
        apply(api, next, 0, action);
        assert.equal(next.alive[B.guard], 0);
    }
});
test('cannons require exactly one screen; adjacent or two-screen captures are illegal', () => {
    const api = engine();
    for (const [pieces, legal] of [
        [{ a1:R.cannon,c1:B.guard }, false], [{ a1:R.cannon,b1:B.guard }, false],
        [{ a1:R.cannon,b1:R.pawn,d1:B.guard }, true], [{ a1:R.cannon,b1:R.pawn,c1:R.pawn,d1:B.guard }, false]
    ]) {
        const st = state(pieces);
        assert.equal(moves(api, st, 0).some(m => st.board[m & 31] === B.guard), legal);
    }
});

test('50-ply scoring win remains valid without a guard counter', () => {
    const api = engine(), st = positions.points_win();
    apply(api, st, 0, decide(api, st, 0).action);
    assert.deepEqual(terminal(api, st, 1), { winner: 0, reason: 'points' });
});
test('capture resets the clock instead of accepting a points loss', () => {
    const api = engine(), st = positions.points_reset();
    const { action } = decide(api, st, 0);
    assert.ok(sameMove(action, 'a1', 'b1'));
    apply(api, st, 0, action); assert.equal(st.quiet, 0); assert.equal(terminal(api, st, 1), null);
});
test('equal capture points are a real draw, even with an unfavorable static evaluation', () => {
    const api = engine(), st = state({ a1:R.rook, b1:R.pawn, c1:R.pawn, h4:B.cannon }, [], [], 50);
    assert.equal(api.Engine.capturedPoints(st, 0), api.Engine.capturedPoints(st, 1));
    const ctx = api.BanqiAI.getContext(1000);
    ctx.drawValue = () => -1234; // legacy used this to change a legal draw into a fictitious loss
    assert.equal(api.Engine.search(st, 0, 3, -api.INF, api.INF, 0, 1, ctx), 0);
});
test('lack of a counter is not an immediate game over', () => {
    const api = engine(), st = state({ a1:R.horse, h4:B.guard });
    assert.equal(terminal(api, st, 0), null);
    const score = api.Engine.search(st, 0, 3, -api.INF, api.INF, 0, 1, api.BanqiAI.getContext(1000));
    assert.ok(score > -api.WIN_SCORE + 100);
});

test('only public state affects decisions; future reveal identities are never accessed', () => {
    const a = engine(), b = engine(), s1 = positions.pressure(), s2 = positions.pressure();
    Object.defineProperty(s1, 'hiddenIdentities', { get() { throw Error('Private identities read'); } });
    s2.hiddenIdentities = [R.king];
    assert.equal(decide(a, s1, 0).notation, decide(b, s2, 0).notation);
});

for (const limit of [1, 2, 37, 128, 1024, 8192]) {
    test(`interrupted search fully restores public state at node ${limit}`, () => {
        const api = engine(), st = positions.middlegame(), before = snapshot(st);
        const ctx = api.BanqiAI.getContext(1000); ctx.nodeLimit = limit; ctx.revealLimit = 2;
        api.Engine.search(st, 0, 6, -api.INF, api.INF, 0, 2, ctx);
        assert.equal(ctx.aborted, true); assert.equal(snapshot(st), before);
        const ctx2 = api.BanqiAI.getContext(1000); ctx2.nodeLimit = limit; ctx2.revealLimit = 2;
        assert.equal(api.Engine.evaluateFlips(st, 0, 5, ctx2), null);
        assert.equal(snapshot(st), before);
    });
}
test('wall-clock abort and incomplete root rounds retain a legal fallback and restore state', () => {
    const api = engine(), st = positions.pressure(), before = snapshot(st);
    const ctx = api.BanqiAI.getContext(1); ctx.checkTime = true; ctx.nodes = 1023; api.clock.now = 2;
    assert.equal(api.Engine.evaluateFlips(st, 0, 4, ctx), null);
    assert.equal(snapshot(st), before);
    api.BanqiAI.LEVELS.hard.nodeLimit = 1;
    decide(api, st, 0);
});

// Independent, unpruned tree: all legal moves, all remaining squares, all pool outcomes.
// The small fixtures have <=4 hidden squares so production's selective square policy is exact.
function oracle(api, st, side, depth, ply, reveals) {
    if (!api.Engine.hasAnyAction(st, side)) return -api.WIN_SCORE + ply;
    if (st.quiet >= 50) {
        const lead = api.Engine.capturedPoints(st, side) - api.Engine.capturedPoints(st, 1-side);
        return Math.sign(lead) * (api.WIN_SCORE - ply);
    }
    if (!depth) return api.Engine.qsearch(st, side, -api.INF, api.INF, ply, 4, api.BanqiAI.getContext(1000));
    let best = -api.INF;
    for (const m of moves(api, st, side)) {
        const next = api.Engine.cloneState(st), cap = next.board[m & 31];
        apply(api, next, side, { type: cap ? 'capture' : 'move', from: m >> 5, to: m & 31 });
        best = Math.max(best, !api.Engine.aliveOf(next, 1-side) ? api.WIN_SCORE-ply : -oracle(api, next, 1-side, depth-1, ply+1, reveals));
    }
    if (st.hidden && reveals) for (let sq = 0; sq < 32; sq++) if (st.board[sq] === 15) {
        let expected = 0;
        for (let code = 1; code <= 14; code++) if (st.pool[code]) {
            const next = api.Engine.cloneState(st);
            next.board[sq] = code; next.pool[code]--; next.hidden--; next.quiet = 0;
            expected -= st.pool[code] / st.hidden * oracle(api, next, 1-side, depth-1, ply+1, reveals-1);
        }
        best = Math.max(best, expected);
    }
    return best === -api.INF ? api.Engine.evaluate(st, side) : best;
}
test('chance branches and TT bounds match an independent exhaustive tree (including conditional second flips)', () => {
    const api = engine();
    const st = state({ b2:R.king, a3:B.guard, g1:R.cannon }, ['a2','a4','b4'], [B.pawn,B.pawn,R.horse], 48);
    const before = snapshot(st);
    const expected = oracle(api, st, 0, 3, 0, 2);
    for (const [alpha,beta] of [[-api.INF,api.INF],[expected-1,expected+1],[expected+1,expected+2],[expected-2,expected-1]]) {
        const ctx = api.BanqiAI.getContext(1000);
        const actual = api.Engine.search(st, 0, 3, alpha, beta, 0, 2, ctx);
        if (expected <= alpha) assert.ok(actual <= alpha && actual >= expected - 1e-8);
        else if (expected >= beta) assert.ok(actual >= beta && actual <= expected + 1e-8);
        else assert.ok(Math.abs(actual-expected) < 1e-8, `${actual} != ${expected}`);
        assert.equal(snapshot(st), before);
    }
});
test('every committed root iteration compares moves and flips at the same depth', () => {
    const api = engine(), st = positions.pressure(); decide(api, st, 0);
    assert.ok(api.BanqiAI.lastSearch);
    for (const iteration of api.BanqiAI.lastSearch.iterations) {
        assert.ok(iteration.moves > 0 && iteration.flips > 0);
        const rounds = api.BanqiAI._ctx.rounds.filter(r => r.complete && r.depth === iteration.depth);
        assert.equal(rounds.length, 2);
    }
});

test('chance TT does not reuse mixed mate-distance expectations at another absolute ply', () => {
    const api = engine();
    // No legal move: half the reveals expose a pawn that immediately takes the last king;
    // the other half expose a guard and lead to a playable continuation.
    const st = state({a1:R.king}, ['a2','b1'], [B.guard,B.pawn]);
    const before = snapshot(st), ctx = api.BanqiAI.getContext(1000);
    const first = api.Engine.search(st, 0, 3, -api.INF, api.INF, 0, 2, ctx);
    const warm = api.Engine.search(st, 0, 3, -api.INF, api.INF, 4, 2, ctx);
    const cold = api.Engine.search(st, 0, 3, -api.INF, api.INF, 4, 2, api.BanqiAI.getContext(1000));
    assert.ok(first < -1000 && first > -90000, 'This is an expectation, not a proven loss');
    assert.ok(Math.abs(warm-cold) < 1e-8);
    assert.equal(snapshot(st), before);
});

test('per-piece danger masks equal actual board mutations, including captures, removed screens and bit 31', () => {
    const api = engine(), random = rng(9721);
    const samples = Object.values(positions).map(make => make());
    const played = api.Engine.createState();
    for (let ply = 0; ply < 160; ply++) {
        const side = ply % 2, legal = moves(api, played, side);
        const hidden = Array.from(played.board, (p, sq) => p === 15 ? sq : -1).filter(sq => sq >= 0);
        if (!legal.length && !hidden.length) break;
        let action;
        if (hidden.length && (!legal.length || random() < 0.4)) action = {type:'flip',sq:hidden[Math.floor(random()*hidden.length)]};
        else { const m = legal[Math.floor(random()*legal.length)]; action = {type: played.board[m & 31] ? 'capture':'move',from:m>>5,to:m&31}; }
        apply(api, played, side, action, random);
        samples.push(api.Engine.cloneState(played));
        if (terminal(api, played, 1-side)) break;
    }
    let comparisons = 0;
    for (const st of samples) {
        const before = snapshot(st);
        api.Engine.pressureScore(st, api.Engine.computeValues(st, new Float64Array(15)));
        const masks = api.Engine._unsafe.slice(), b = st.board;
        assert.equal(snapshot(st), before);
        for (let from = 0; from < 32; from++) {
            const piece = b[from];
            if (!piece || piece === 15) continue;
            const side = piece <= 7 ? 0 : 1;
            for (let to = 0; to < 32; to++) {
                const cap = b[to];
                if (to === from || cap === 15 || cap && (cap <= 7 ? 0 : 1) === side) continue;
                b[from] = 0; b[to] = piece;
                const attacked = api.Engine.isAttackedBy(st, to, 1-side);
                b[from] = piece; b[to] = cap;
                assert.equal(!!(masks[from] & (1 << to)), attacked, `Wrong danger mask for ${piece}: ${from} -> ${to}`);
                comparisons++;
            }
        }
        assert.equal(snapshot(st), before);
    }
    assert.ok(comparisons > 10000);
});
