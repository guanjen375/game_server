'use strict';

// Loads the actual standalone page, with no DOM, packages, or private hidden identities.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const BASELINE = '8e50d139bb7887cb2b1ae8efa7ea118c217d3440';
const R = { king: 1, guard: 2, elephant: 3, rook: 4, horse: 5, cannon: 6, pawn: 7 };
const B = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v + 7]));
const sq = s => (4 - Number(s[1])) * 8 + s.charCodeAt(0) - 97;
const name = n => String.fromCharCode(97 + n % 8) + (4 - (n >> 3));
const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

function load({ ref, sourcePath, seed = 1, ms = 1000, depth = 12, nodes, fixed = false, ablate, production = false, minimumIteration = true } = {}) {
    const html = ref ? execFileSync('git', ['show', `${ref}:games/banqi.html`], { cwd: ROOT, encoding: 'utf8' })
        : fs.readFileSync(sourcePath || path.join(ROOT, 'games/banqi.html'), 'utf8');
    let source = html.slice(html.indexOf('        const ROWS'), html.indexOf('        // 電腦對手角色'));
    // Baseline-only instrumentation: counts do not affect wall-clock benchmark search policy.
    const legacy = !source.includes('ctx.qnodes');
    if (legacy) {
        source = source.replace('qsearch(st, side, alpha, beta, ply, qdepth, ctx) {',
            'qsearch(st, side, alpha, beta, ply, qdepth, ctx) { ctx.qnodes++; ctx.maxPly = Math.max(ctx.maxPly, ply);');
        source = source.replace('search(st, side, depth, alpha, beta, ply, prevPass, ctx) {',
            'search(st, side, depth, alpha, beta, ply, prevPass, ctx) { ctx.maxPly = Math.max(ctx.maxPly, ply);');
        source = source.replace('if (prevPass) {', 'ctx.passNodes++; if (prevPass) {');
        if (nodes) source = source.replaceAll('if (ctx.aborted) return 0;',
            'if (ctx.nodes >= ctx.nodeLimit) ctx.aborted = true; if (ctx.aborted) return 0;');
    }
    const randomMath = Object.create(Math);
    randomMath.random = rng(seed);
    const clock = { now: 0 };
    const context = vm.createContext({ Math: randomMath, performance: fixed || nodes ? { now: () => clock.now } : performance });
    vm.runInContext(source + '\nglobalThis.api = { Engine, BanqiAI, WIN_SCORE, INF, positionKey, CAN_EAT, CAPTURE_POINTS, NEIGHBORS };', context);
    const { Engine, BanqiAI } = context.api;
    if (ablate === 'no-pressure') Engine.pressureScore = () => 0;
    const originalContext = BanqiAI.getContext;
    BanqiAI.getContext = function (time) {
        const ctx = originalContext.call(this, time);
        ctx.qnodes = 0; ctx.passNodes = 0; ctx.maxPly = 0;
        ctx.nodeLimit = nodes || Infinity;
        ctx.rounds = []; ctx.flipMs = 0; ctx.moveMs = 0;
        return ctx;
    };
    for (const method of ['evaluateFlips', 'searchMoves']) {
        const fn = Engine[method];
        Engine[method] = function (...args) {
            const ctx = args[method === 'searchMoves' ? 4 : 3];
            const before = performance.now(), count = ctx.nodes;
            // Equal minimum-work policy for both engines in node-budget matches. The legacy
            // engine has no legal fallback if its first round is interrupted. Report actual
            // nodes even if this mandatory minimum round exceeds the nominal target.
            const limit = ctx.nodeLimit;
            if (nodes && minimumIteration && args[2] === (method === 'searchMoves' ? 1 : 0)) ctx.nodeLimit = Infinity;
            let result;
            try { result = fn.apply(this, args); } finally { ctx.nodeLimit = limit; }
            const elapsed = performance.now() - before;
            ctx[method === 'searchMoves' ? 'moveMs' : 'flipMs'] += elapsed;
            ctx.rounds.push({ kind: method, depth: args[2] + (method === 'evaluateFlips' ? 1 : 0),
                complete: !!result, nodes: ctx.nodes - count, ms: +elapsed.toFixed(2) });
            return result;
        };
    }
    BanqiAI.LEVELS.hard = { ...BanqiAI.LEVELS.hard, timeMs: ms, moveDepth: depth,
        ...(production ? {} : { noise: 0, margin: 0 }), nodeLimit: nodes || Infinity };
    return { ...context.api, clock, legacy, sourceHash: createHash('sha256').update(html).digest('hex') };
}

function state(pieces = {}, hidden = [], pool = [], quiet = 0) {
    assert.equal(hidden.length, pool.length);
    const st = { board: new Int8Array(32), pool: new Int8Array(15), alive: new Int8Array(15), hidden: hidden.length, quiet };
    for (const [s, code] of Object.entries(pieces)) {
        assert.equal(st.board[sq(s)], 0); st.board[sq(s)] = code; st.alive[code]++;
    }
    for (const s of hidden) { assert.equal(st.board[sq(s)], 0); st.board[sq(s)] = 15; }
    for (const code of pool) { st.pool[code]++; st.alive[code]++; }
    validate(st);
    return st;
}
function validate(st) {
    const seen = Array(15).fill(0);
    let hidden = 0;
    for (const p of st.board) { if (p === 15) hidden++; else if (p) seen[p]++; }
    assert.equal(hidden, st.hidden);
    assert.equal(Array.from(st.pool).reduce((a, b) => a + b, 0), hidden);
    for (let p = 1; p <= 14; p++) {
        assert.equal(seen[p] + st.pool[p], st.alive[p]);
        assert.ok(st.pool[p] >= 0 && st.alive[p] <= [1, 2, 2, 2, 2, 2, 5][(p - 1) % 7]);
    }
}
const snapshot = st => JSON.stringify({ b: [...st.board], p: [...st.pool], a: [...st.alive], h: st.hidden, q: st.quiet });
function moves(api, st, side) {
    const buf = new Int16Array(192);
    return Array.from(buf.subarray(0, api.Engine.genMoves(st, side, buf)));
}
function legal(api, st, side, a) {
    assert.ok(a, 'A non-terminal state needs an action');
    if (a.type === 'flip') assert.equal(st.board[a.sq], 15);
    else {
        assert.ok(moves(api, st, side).includes(a.from * 32 + a.to), `Illegal action ${describe(a)}`);
        assert.equal(a.type, st.board[a.to] ? 'capture' : 'move');
    }
}
function apply(api, st, side, a, random = rng(42)) {
    legal(api, st, side, a);
    const entry = { kind: a.type, color: side };
    if (a.type === 'flip') {
        let r = Math.floor(random() * st.hidden), code = 1;
        for (; code <= 14; code++) { r -= st.pool[code]; if (r < 0) break; }
        st.board[a.sq] = code; st.pool[code]--; st.hidden--; st.quiet = 0;
        Object.assign(entry, { sq: a.sq, code });
    } else {
        const captured = st.board[a.to], code = st.board[a.from];
        st.board[a.to] = code; st.board[a.from] = 0;
        if (captured) { st.alive[captured]--; st.quiet = 0; } else st.quiet++;
        Object.assign(entry, { from: a.from, to: a.to, code, captured });
    }
    validate(st);
    return entry;
}
function terminal(api, st, next) {
    if (!api.Engine.aliveOf(st, next) || !api.Engine.hasAnyAction(st, next)) return { winner: 1 - next, reason: 'eliminate/stalemate' };
    if (st.quiet >= 50) {
        const diff = api.Engine.capturedPoints(st, 0) - api.Engine.capturedPoints(st, 1);
        return { winner: diff > 0 ? 0 : diff < 0 ? 1 : null, reason: 'points' };
    }
    return null;
}
const describe = a => !a ? 'none' : a.type === 'flip' ? `flip ${name(a.sq)}` : `${name(a.from)}${a.type === 'capture' ? 'x' : '-'}${name(a.to)}`;
function transform(st, side = 0, mirror = false, vertical = false) {
    const out = { board: new Int8Array(32), pool: new Int8Array(15), alive: new Int8Array(15), hidden: st.hidden, quiet: st.quiet };
    const code = p => side && p > 0 && p < 15 ? (p <= 7 ? p + 7 : p - 7) : p;
    for (let i = 0; i < 32; i++) out.board[(vertical ? 3 - (i >> 3) : i >> 3) * 8 + (mirror ? 7 - (i & 7) : i & 7)] = code(st.board[i]);
    for (let i = 1; i <= 14; i++) { out.pool[code(i)] = st.pool[i]; out.alive[code(i)] = st.alive[i]; }
    return out;
}
function decide(api, st, side, history) {
    const before = snapshot(st), start = performance.now();
    const action = api.BanqiAI.chooseAction(st, side, 'hard', history);
    const ms = performance.now() - start;
    assert.equal(snapshot(st), before, 'Search changed the live position');
    legal(api, st, side, action);
    const ctx = api.BanqiAI._ctx;
    const rounds = ctx.rounds;
    const completed = api.BanqiAI.lastSearch?.completedDepth;
    const computedMoveDepth = Math.max(0, ...rounds.filter(r => r.kind === 'searchMoves' && r.complete).map(r => r.depth));
    const computedFlipDepth = Math.max(0, ...rounds.filter(r => r.kind === 'evaluateFlips' && r.complete).map(r => r.depth));
    return { action, notation: describe(action), ms: +ms.toFixed(2), nodes: ctx.nodes, qnodes: ctx.qnodes,
        passNodes: ctx.passNodes, chanceNodes: ctx.chanceNodes || 0, aborted: ctx.aborted,
        moveDepth: completed === undefined ? computedMoveDepth : moves(api, st, side).length ? completed : 0,
        // Legacy can finish flips and then abort moves in the same round. Those fresh flip
        // values are discarded with that round, not used for the chosen action.
        flipDepth: completed === undefined ? (computedMoveDepth ? Math.min(computedMoveDepth, computedFlipDepth) : computedFlipDepth) : st.hidden ? completed : 0,
        computedFlipDepth,
        maxPly: ctx.maxPly, maxReveals: ctx.maxReveals, quietExtensions: ctx.quietExtensions,
        chanceStops: ctx.chanceStops, ttHits: ctx.ttHits,
        flipMs: +ctx.flipMs.toFixed(2), moveMs: +ctx.moveMs.toFixed(2), rounds };
}
module.exports = { load, state, validate, snapshot, moves, legal, apply, terminal, describe, transform, decide, rng, sq, name, R, B, BASELINE, ROOT };
