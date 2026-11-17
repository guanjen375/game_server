'use strict';
const fs = require('node:fs');
const { load, decide, transform, BASELINE } = require('./harness.cjs');
const { positions } = require('./positions.cjs');
const args = process.argv.slice(2);
const opt = (k, fallback) => args.includes(k) ? args[args.indexOf(k) + 1] : fallback;
const ms = Number(opt('--ms', 1000)), depth = Number(opt('--depth', 12));
const nodes = Number(opt('--nodes', 0)) || undefined;
const refs = opt('--refs', 'baseline,current').split(',');
const names = opt('--positions', Object.keys(positions).join(',')).split(',');
const result = { config: { ms, depth, nodes, baseline: BASELINE, seed: 1, noise: 0, margin: 0, nodeVersion: process.version }, sources: {}, rows: [] };
for (const ref of refs) {
    const api = load({ ref: ref === 'current' ? undefined : ref === 'baseline' ? BASELINE : ref, ms, depth, nodes, fixed: !!nodes, ablate: opt('--ablate') });
    result.sources[ref] = api.sourceHash;
    for (const id of names) for (const side of args.includes('--colors') ? [0, 1] : [0]) {
        const st = transform(positions[id](), side);
        const r = { ref, id, side, hidden: st.hidden, pieces: api.Engine.aliveOf(st, 0) + api.Engine.aliveOf(st, 1), ...decide(api, st, side) };
        result.rows.push(r);
        console.log(`${ref.padEnd(8)} ${id.padEnd(18)} ${side} ${r.notation.padEnd(9)} depth ${r.moveDepth}/${r.flipDepth} nodes ${r.nodes} q ${r.qnodes} ms ${r.ms}`);
    }
}
if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(result, null, 2) + '\n');
