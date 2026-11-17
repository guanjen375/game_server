'use strict';
// Freeze reachable positions before changing the engine. The generation engine, seeds,
// node budget and complete public history are recorded; future draws are not stored.
const fs = require('node:fs');
const { gzipSync } = require('node:zlib');
const { load, decide, apply, terminal, snapshot, rng, transform } = require('./harness.cjs');
const args = process.argv.slice(2);
const opt = (k, fallback) => args.includes(k) ? args[args.indexOf(k) + 1] : fallback;
const ref = opt('--ref', '27136d6c5567806758ef28f690c40335ebc3ad17');
const seeds = opt('--seeds', '11,23,47,101,203,307,401,509').split(',').map(Number);
const nodes = Number(opt('--nodes', 6000));
const result = { config: { ref, seeds, nodes, checkpoints: [0,12,24,36,48], production: true }, positions: [] };
for (const seed of seeds) {
    const api = load({ref, nodes, seed, production: true});
    const random = rng(seed ^ 0x891ff3);
    let st = api.Engine.createState();
    const first = apply(api, st, 0, {type:'flip',sq:Math.floor(random()*32)}, random);
    // The player who revealed the first piece owns it. Normalize that player to black,
    // so red is next in every saved checkpoint; no initial assignment advantage is hidden.
    if (first.code <= 7) st = transform(st, 1);
    const history = {positions:[api.positionKey(st.board,0)],log:[]};
    for (let ply = 0; ply <= 48; ply++) {
        if (result.config.checkpoints.includes(ply)) result.positions.push({
            id:`s${seed}-p${ply}`, seed, ply, stage: ply===0?'opening':ply<=12?'early':ply<=36?'middle':'late',
            state:JSON.parse(snapshot(st)), history:JSON.parse(JSON.stringify(history))
        });
        if (ply === 48) break;
        const side = ply % 2;
        const d = decide(api, st, side, history);
        const entry = apply(api, st, side, d.action, random);
        history.log.push(entry); history.positions.push(api.positionKey(st.board,1-side));
        if (terminal(api, st, 1-side)) break;
    }
    console.log(`seed ${seed}: ${result.positions.filter(p=>p.seed===seed).length} positions`);
}
fs.writeFileSync(opt('--out','/tmp/banqi-corpus.json.gz'), gzipSync(JSON.stringify(result)+'\n'));
