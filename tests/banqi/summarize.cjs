'use strict';
const fs = require('node:fs');
const { gunzipSync } = require('node:zlib');
const mean = a => +(a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(2);
for (const filename of process.argv.slice(2)) {
    const bytes = fs.readFileSync(filename);
    const data = JSON.parse((filename.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
    console.log(filename, JSON.stringify(data.config));
    if (!data.games) {
        for (const row of data.rows) console.log([row.ref, row.id, row.side, row.notation, `${row.moveDepth}/${row.flipDepth}`, row.nodes, row.ms, row.flipMs].join('\t'));
        continue;
    }
    const tally = {}, ids = {}, metrics = { current: {}, baseline: {} };
    for (const g of data.games) {
        const winner = g.outcome.engine || g.outcome.reason;
        tally[winner] = (tally[winner] || 0) + 1;
        (ids[g.id] ||= []).push({ currentSide: g.currentSide, winner, plies: g.moves.length, first: g.moves[0].notation });
        for (const side of [0,1]) {
            const out = metrics[side === g.currentSide ? 'current' : 'baseline'];
            for (const key of ['counterLostInTradeWhileBehind','newUncoveredTypes','nonwinningCycles','scoringCycles','captures','flips']) {
                out[key] = (out[key] || 0) + g.metrics[key][side];
            }
        }
    }
    console.log(JSON.stringify({ tally, ids, metrics }, null, 2));
    const turns = data.games.flatMap(g => g.moves);
    for (const engine of ['baseline','current']) {
        const t = turns.filter(t => t.engine === engine);
        console.log(engine, JSON.stringify({ turns: t.length, meanMs: mean(t.map(t => t.ms)), meanNodes: mean(t.map(t => t.nodes)),
            meanMoveDepth: mean(t.map(t => t.moveDepth)), meanFlipDepth: mean(t.filter(t=>t.flipDepth).map(t=>t.flipDepth)), maxMs: Math.max(...t.map(t=>t.ms)) }));
    }
}
