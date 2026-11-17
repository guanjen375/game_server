'use strict';
const fs = require('node:fs');
const { gzipSync, gunzipSync } = require('node:zlib');
const { load, decide, apply, terminal, transform, snapshot, rng, BASELINE } = require('./harness.cjs');
const { positions } = require('./positions.cjs');
const args = process.argv.slice(2);
const opt = (k, fallback) => args.includes(k) ? args[args.indexOf(k) + 1] : fallback;
const ms = Number(opt('--ms', 150)), depth = Number(opt('--depth', 12));
const nodes = Number(opt('--nodes', 0)) || undefined;
const seeds = opt('--seeds', '17,91').split(',').map(Number);
const names = opt('--positions', 'opening,middlegame,pressure,last_counter,few_piece,cannon_shot,last_target_trade').split(',');
const maxPlies = Number(opt('--plies', 180));
const opponent = opt('--opponent', BASELINE);
const production = args.includes('--production');
const minimumIteration = !args.includes('--strict-nodes');
const independentReveals = args.includes('--independent-reveals');
const corpus = opt('--corpus') ? JSON.parse(gunzipSync(fs.readFileSync(opt('--corpus')))).positions : null;
const selected = corpus ? corpus.filter(p => (!opt('--stages') || opt('--stages').split(',').includes(p.stage)) && (!opt('--ids') || opt('--ids').split(',').includes(p.id))) : names.map(id=>({id}));
const result = { config: { ms, depth, nodes, seeds, maxPlies, opponent, production, minimumIteration, independentReveals, corpus:opt('--corpus'), ablate: opt('--ablate'), opponentAblate: opt('--opponent-ablate'), noise: production?0.25:0, margin: production?1:0, nodeVersion: process.version }, sources: {}, games: [] };

function uncovered(api, st, side) {
    const screen = api.Engine.aliveOf(st, 0) + api.Engine.aliveOf(st, 1) > 2;
    const result = [];
    for (let t = 0; t < 7; t++) {
        if (!st.alive[(1 - side) * 7 + t + 1]) continue;
        let count = 0;
        for (let a = 0; a < 7; a++) if (api.CAN_EAT[a][t] || a === 5 && screen) count += st.alive[side * 7 + a + 1];
        if (!count) result.push(t);
    }
    return result;
}
for (const position of selected) for (const seed of seeds) for (const currentSide of [0, 1]) {
    const {id} = position;
    const engines = [0, 1].map(side => load({ ref: side === currentSide || opponent === 'current' ? undefined : opponent,
        sourcePath: side === currentSide ? opt('--source') : undefined,
        seed: seed + side, ms, depth, nodes, production, minimumIteration, ablate: side === currentSide ? opt('--ablate') : opt('--opponent-ablate') }));
    // Same public start and reveal RNG in both legs; engine RNG never sees reveal RNG state.
    const saved = position.state;
    const st = saved ? {board:Int8Array.from(saved.b),pool:Int8Array.from(saved.p),alive:Int8Array.from(saved.a),hidden:saved.h,quiet:saved.q} : transform(positions[id](), 0, seed % 2 === 0);
    result.sources.current = engines[currentSide].sourceHash;
    result.sources.opponent = engines[1-currentSide].sourceHash;
    const positionSalt = independentReveals ? Array.from(id).reduce((h,c)=>Math.imul(h^c.charCodeAt(0),16777619)>>>0,2166136261) : 0;
    const revealSeed = (seed ^ 0x93ac51 ^ positionSalt) >>> 0;
    const random = rng(revealSeed);
    const history = position.history ? JSON.parse(JSON.stringify(position.history)) : { positions: [engines[0].positionKey(st.board, 0)], log: [] };
    const game = { id, seed, revealSeed, stage:position.stage, currentSide, start: JSON.parse(snapshot(st)), startHistory:position.history, moves: [], outcome: null, metrics: {
        newUncoveredTypes: [0, 0], counterLostInTradeWhileBehind: [0, 0], nonwinningCycles: [0, 0],
        scoringCycles: [0, 0], longestQuiet: 0, captures: [0, 0], flips: [0, 0] } };
    for (let ply = 0; ply < maxPlies; ply++) {
        const side = ply % 2, api = engines[side], enemy = 1 - side;
        const before = uncovered(api, st, enemy);
        const decision = decide(api, st, side, history);
        const entry = apply(api, st, side, decision.action, random);
        const key = api.positionKey(st.board, enemy);
        const lead = api.Engine.capturedPoints(st, side) - api.Engine.capturedPoints(st, enemy);
        const added = uncovered(api, st, enemy).filter(t => !before.includes(t));
        if (added.length) {
            game.metrics.newUncoveredTypes[enemy] += added.length;
            const previous = history.log.at(-1);
            if (previous?.kind === 'capture' && previous.to === entry.to && lead > 0) game.metrics.counterLostInTradeWhileBehind[enemy]++;
        }
        if (entry.kind === 'move' && history.positions.filter(p => p === key).length >= 2) {
            game.metrics[lead > 0 ? 'scoringCycles' : 'nonwinningCycles'][side]++;
        }
        if (entry.kind === 'capture') game.metrics.captures[side]++;
        if (entry.kind === 'flip') game.metrics.flips[side]++;
        game.metrics.longestQuiet = Math.max(game.metrics.longestQuiet, st.quiet);
        history.log.push(entry); history.positions.push(key);
        const { rounds, action, ...stats } = decision;
        game.moves.push({ ply, side, engine: side === currentSide ? 'current' : 'baseline', ...stats,
            action, revealed: entry.kind === 'flip' ? entry.code : undefined, captured: entry.captured || undefined,
            hidden: st.hidden, quiet: st.quiet, points: [api.Engine.capturedPoints(st, 0), api.Engine.capturedPoints(st, 1)], newUncovered: added });
        game.outcome = terminal(api, st, enemy);
        if (game.outcome) break;
    }
    if (!game.outcome) game.outcome = { winner: null, reason: 'unfinished' };
    game.outcome.engine = game.outcome.winner === null ? null : game.outcome.winner === currentSide ? 'current' : 'baseline';
    result.games.push(game);
    console.log(`${id} seed=${seed} current=${currentSide} ${game.outcome.engine || game.outcome.reason} ${game.moves.length} plies trades=${game.metrics.counterLostInTradeWhileBehind} cycles=${game.metrics.nonwinningCycles}`);
    if (opt('--out')) {
        const output = JSON.stringify(result, null, 2) + '\n';
        fs.writeFileSync(opt('--out'), opt('--out').endsWith('.gz') ? gzipSync(output) : output);
    }
}
const tally = result.games.reduce((r, g) => { const k = g.outcome.engine || g.outcome.reason; r[k] = (r[k] || 0) + 1; return r; }, {});
console.log(JSON.stringify(tally));
