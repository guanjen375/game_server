'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { load, snapshot, rng, ROOT } = require('./banqi/harness.cjs');
const { replay } = require('./banqi/replay.cjs');

function controller() {
    const html = fs.readFileSync(process.env.BANQI_SOURCE || path.join(ROOT, 'games/banqi.html'), 'utf8');
    const source = html.slice(html.indexOf('        class SoundManager'), html.indexOf('    </script>', html.indexOf('        class SoundManager')));
    const math = Object.create(Math); math.random = rng(741);
    const context = vm.createContext({ window: {}, Math: math, performance: { now: () => 0 }, setTimeout: () => 1, clearTimeout() {} });
    vm.runInContext(source + '\nglobalThis.api = { game, BanqiAI, Engine };', context);
    const { game, BanqiAI } = context.api;
    game.renderAll = game.showCenterBanner = game.scheduleAI = () => {};
    game.sound.enabled = false;
    game.settings.difficulty = 'hard';
    BanqiAI.LEVELS.hard.moveDepth = 1;
    return context.api;
}

test('real controller exports replayable public actions, with per-turn difficulty and search statistics', () => {
    const { game, BanqiAI } = controller(), api = load();
    for (let i = 0; i < 12; i++) {
        if (game.turn === 'north') game.executeAITurn();
        else {
            const sq = [...game.state.board].indexOf(15);
            game.performAction(game.turn, { type: 'flip', sq });
        }
        const record = game.getPublicRecord(), replayed = replay(record, { api });
        assert.equal(snapshot(replayed.st), snapshot(game.state));
        assert.equal(replayed.nextSeat, game.turn);
        assert.equal(record.state.board.filter(p => p === 15).length, record.state.hidden);
        assert.equal(record.state.pool.reduce((a, b) => a + b, 0), record.state.hidden);
    }
    const record = game.getPublicRecord(), ai = record.moves.filter(e => e.seat === 'north');
    assert.ok(ai.length > 0 && ai.every(e => e.analysis.level === 'hard'));
    assert.ok(ai.some(e => e.analysis.completedDepth >= 1 && e.analysis.nodes > 0));
    assert.equal(record.aiVersion, BanqiAI.VERSION);
    const original = JSON.stringify(record.moves.at(-1).analysis);
    BanqiAI.lastSearch = { nodes: 123456 }; // A later hint/decision cannot rewrite the played move.
    assert.equal(JSON.stringify(game.getPublicRecord().moves.at(-1).analysis), original);
    const before = snapshot(game.state);
    record.state.board.fill(1); record.moves.length = 0;
    assert.equal(snapshot(game.state), before);
    assert.equal(game.moveLog.length, 12);
});

test('replay prefix never reads future reveals or the final state', () => {
    const { game } = controller();
    game.performAction('south', { type: 'flip', sq: 0 });
    const record = game.getPublicRecord(), expected = snapshot(game.state);
    record.moves.push({ get kind() { throw Error('Future reveal accessed'); } });
    Object.defineProperty(record, 'state', { get() { throw Error('Future board accessed'); } });
    assert.equal(snapshot(replay(record, { plies: 1 }).st), expected);
});

test('undo removes abandoned actions and diagnostics before exporting', () => {
    const { game } = controller();
    game.performAction('south', { type: 'flip', sq: 0 });
    const before = snapshot(game.state);
    game.executeAITurn();
    const sq = [...game.state.board].indexOf(15);
    const saved = snapshot(game.state);
    game.performAction('south', { type: 'flip', sq });
    game.executeAITurn();
    game.undo();
    const record = game.getPublicRecord();
    assert.equal(record.moves.length, 2);
    assert.equal(snapshot(game.state), saved);
    assert.equal(snapshot(replay(record).st), saved);
    assert.notEqual(saved, before);
});

test('a first random reveal does not inherit statistics from an earlier search', () => {
    const { game, BanqiAI } = controller();
    BanqiAI.lastSearch = { nodes: 99999 };
    game.turn = 'north'; game.executeAITurn();
    const entry = game.getPublicRecord().moves[0];
    assert.equal(entry.analysis.level, 'hard');
    assert.equal(entry.analysis.nodes, undefined);
    assert.equal(entry.kind, 'flip');
});
