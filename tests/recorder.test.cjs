'use strict';
// The script the server adds to every game page (RECORDER in open_server.py): it numbers each round,
// sends it to the server, and keeps whatever could not be delivered until it can be.
// Run here in a stand-in browser: storage, network, clock and page events are all under the test's control.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = execFileSync('python3', ['-c', 'import sys, open_server; sys.stdout.write(open_server.RECORDER)'],
    { cwd: ROOT, encoding: 'utf8' }).replace(/^<script>|<\/script>\s*$/g, '');
const BUILD = 'b'.repeat(40);
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// One page load. `disk` is the browser's localStorage and outlives the page, like the real thing.
function page(game, disk = new Map(), { beacon = true, storage = true } = {}) {
    const requests = [], beacons = [], timers = [], errors = [], events = {};
    const clock = { now: new Date(2026, 10, 20, 16, 45, 12).getTime() };
    class FakeDate extends Date { constructor() { super(clock.now); } }
    const sandbox = {
        Date: FakeDate, Math, JSON, Object,
        console: { error: (...args) => errors.push(args) },
        localStorage: {
            get length() { return disk.size; },
            key: i => [...disk.keys()][i],
            getItem: key => (disk.has(key) ? disk.get(key) : null),
            setItem(key, value) { if (!storage) throw new Error('QuotaExceededError'); disk.set(key, String(value)); },
            removeItem: key => { disk.delete(key); }
        },
        document: { visibilityState: 'visible', addEventListener: (type, fn) => { events[type] = fn; } },
        navigator: beacon ? { sendBeacon(url, body) { beacons.push({ url, record: JSON.parse(body) }); return beacon !== 'full'; } } : {},
        addEventListener: (type, fn) => { events[type] = fn; },
        setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({
            url, options, record: JSON.parse(options.body),
            answer: status => resolve({ status, ok: status >= 200 && status < 300 }), drop: () => reject(new TypeError('Failed to fetch'))
        }))
    };
    sandbox.window = sandbox;
    vm.runInNewContext(SCRIPT.replace('__GAME__', game).replace('__BUILD__', BUILD), sandbox);
    return {
        recorder: sandbox.GameRecorder, requests, beacons, timers, errors, disk, clock,
        hide() { sandbox.document.visibilityState = 'hidden'; events.visibilitychange(); },
        show() { sandbox.document.visibilityState = 'visible'; events.visibilitychange(); },
        close() { events.pagehide(); },
        online() { events.online(); },
        waiting: () => [...disk.keys()].filter(key => key.startsWith('game_record:'))
    };
}

test('a finished round is sent once, numbered and described, and forgotten when the server has it', async () => {
    const p = page('banqi');
    assert.equal(p.requests.length, 0);
    const game = { finished: false, round: 2, moves: [] };
    p.recorder.begin(() => game);
    p.clock.now += 61_000;
    Object.assign(game, { finished: true, moves: [{ n: 1 }], result: { winner: 'south' }, id: 'mine', seq: 99, status: 'x', session: 'y' });
    p.recorder.end();
    assert.equal(p.requests.length, 1);
    const { url, options, record } = p.requests[0];
    assert.equal(url, '/api/records/banqi');
    assert.equal(options.method, 'POST');
    const offset = -new Date(2026, 10, 20).getTimezoneOffset(), zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    assert.match(record.id, /^20261120-164512-[a-z0-9]{6}$/);
    assert.match(record.session, /^[a-z0-9]{8}$/);
    // The recorder's own columns come first and a game cannot overwrite them; `finished` becomes the status.
    assert.deepEqual(record, {
        id: record.id, seq: 1, session: record.session, build: BUILD, status: 'finished',
        started: `2026-11-20T16:45:12${zone}`, ended: `2026-11-20T16:46:13${zone}`,
        round: 2, moves: [{ n: 1 }], result: { winner: 'south' }
    });
    assert.deepEqual(p.waiting(), [`game_record:banqi:${record.id}`], 'kept until the server answers');
    p.requests[0].answer(200);
    await settle();
    assert.deepEqual(p.waiting(), []);
    assert.equal(p.requests.length, 1);

    p.hide();
    p.close();
    assert.equal(p.beacons.length, 0, 'a finished round is closed');
    assert.equal(p.requests.length, 1);
    assert.deepEqual(p.errors, []);
});

test('nothing is sent while the game has nothing worth recording, and a round is not sent twice unchanged', async () => {
    const p = page('gongzhu');
    let record = null;
    p.recorder.begin(() => record);
    p.hide();
    p.show();
    p.recorder.end();
    assert.equal(p.requests.length + p.beacons.length, 0);
    assert.deepEqual(p.waiting(), []);
    p.recorder.end();    // no round is open: harmless
    p.hide();
    assert.equal(p.requests.length + p.beacons.length, 0);

    record = { finished: false, tricks: [[1]] };
    p.recorder.begin(() => record);
    p.hide();
    p.close();    // browsers fire both when a page goes away
    assert.equal(p.beacons.length, 1);
    p.show();
    p.hide();
    assert.equal(p.beacons.length, 1, 'same contents: not sent again');
});

test('leaving mid-round saves the progress; coming back and finishing replaces it with a newer copy', async () => {
    const p = page('mahjong');
    const game = { finished: false, actions: ['a'] };
    p.recorder.begin(() => game);
    p.hide();
    assert.equal(p.requests.length, 0, 'a closing page cannot wait for an answer: sendBeacon instead');
    assert.equal(p.beacons.length, 1);
    assert.equal(p.beacons[0].url, '/api/records/mahjong');
    const first = p.beacons[0].record;
    assert.deepEqual([first.status, first.seq, first.actions], ['unfinished', 1, ['a']]);
    assert.equal(p.waiting().length, 1, 'sendBeacon gives no answer, so the copy stays until a normal request confirms it');

    p.show();
    assert.equal(p.requests.length, 1);
    assert.deepEqual(p.requests[0].record, first);
    p.requests[0].answer(200);
    await settle();
    assert.deepEqual(p.waiting(), []);

    game.actions.push('b');
    p.hide();
    assert.deepEqual([p.beacons[1].record.id, p.beacons[1].record.seq, p.beacons[1].record.actions], [first.id, 2, ['a', 'b']]);
    p.show();
    game.finished = true;
    p.recorder.end();
    await settle();
    // The confirmation of copy 2 was on its way when copy 3 was saved: copy 3 must not be deleted with it.
    assert.equal(p.requests.length, 2);
    assert.equal(p.requests[1].record.seq, 2);
    p.requests[1].answer(200);
    await settle();
    assert.equal(p.requests.length, 3);
    assert.deepEqual([p.requests[2].record.id, p.requests[2].record.seq, p.requests[2].record.status], [first.id, 3, 'finished']);
    assert.equal(p.waiting().length, 1);
    p.requests[2].answer(200);
    await settle();
    assert.deepEqual(p.waiting(), []);
});

test('each round gets its own number, and one page load shares a session', () => {
    const p = page('reversi');
    for (let round = 1; round <= 3; round++) {
        p.recorder.begin(() => ({ finished: true, round }));
        p.clock.now += 1000;
        p.recorder.end();
    }
    const records = [...p.disk.values()].map(text => JSON.parse(text));
    assert.equal(new Set(records.map(r => r.id)).size, 3);
    assert.equal(new Set(records.map(r => r.session)).size, 1);
    assert.deepEqual(records.map(r => r.seq), [1, 1, 1]);
    assert.notEqual(page('reversi').recorder, undefined);
    const other = page('reversi');
    other.recorder.begin(() => ({ finished: true }));
    other.recorder.end();
    assert.notEqual(other.requests[0].record.session, records[0].session);
});

test('a round that cannot be delivered waits in the browser, is retried, and survives closing the page', async () => {
    const disk = new Map();
    const p = page('bigtwo', disk);
    p.recorder.begin(() => ({ finished: true, round: 1 }));
    p.recorder.end();
    p.clock.now += 5000;
    p.recorder.begin(() => ({ finished: true, round: 2 }));
    p.recorder.end();
    assert.equal(p.requests.length, 1, 'one at a time');
    p.requests[0].drop();    // the network is gone
    await settle();
    assert.equal(p.requests.length, 2, 'the next round is still tried');
    p.requests[1].answer(503);
    await settle();
    assert.equal(p.waiting().length, 2);
    assert.equal(p.requests.length, 2, 'both failed: wait before trying again');
    assert.deepEqual(p.timers.map(t => t.delay), [60000]);

    p.timers[0].fn();
    assert.equal(p.requests.length, 3);
    assert.equal(p.requests[2].record.round, 1, 'oldest first');
    p.requests[2].answer(200);
    await settle();
    assert.equal(p.requests[3].record.round, 2);
    p.requests[3].drop();
    await settle();
    assert.equal(p.waiting().length, 1);

    // The page is closed. Next time any game page is opened, what was left behind goes to the game it belongs to.
    const later = page('mahjong', disk);
    assert.equal(later.requests.length, 1);
    assert.equal(later.requests[0].url, '/api/records/bigtwo');
    assert.equal(later.requests[0].record.round, 2);
    later.requests[0].answer(200);
    await settle();
    assert.deepEqual(later.waiting(), []);
    assert.equal(later.requests.length, 1);
});

test('a record the server refuses is dropped; coming back online retries at once', async () => {
    const p = page('xiangqi');
    p.recorder.begin(() => ({ finished: true, round: 1 }));
    p.recorder.end();
    p.requests[0].answer(400);    // the server will never accept this one
    await settle();
    assert.deepEqual(p.waiting(), []);
    assert.equal(p.timers.length, 0);
    for (const [status, kept] of [[404, 0], [413, 0], [403, 1], [500, 1], [501, 1], [302, 1]]) {
        const q = page('xiangqi');
        q.recorder.begin(() => ({ finished: true }));
        q.recorder.end();
        q.requests[0].answer(status);
        await settle();
        assert.equal(q.waiting().length, kept, `after an answer of ${status}`);
    }

    p.recorder.begin(() => ({ finished: true, round: 2 }));
    p.recorder.end();
    p.requests[1].drop();
    await settle();
    assert.equal(p.requests.length, 2, 'not retried in a loop');
    p.online();    // no need to wait for the minute to pass
    assert.equal(p.requests.length, 3);
    p.requests[2].drop();
    await settle();
    p.hide();
    p.show();      // nor when the player comes back to the page
    assert.equal(p.requests.length, 4);
    p.requests[3].answer(200);
    await settle();
    assert.deepEqual(p.waiting(), []);
    p.online();
    assert.equal(p.requests.length, 4, 'nothing left to send');
});

test('without localStorage, or without sendBeacon, rounds are still sent while the page is open', async () => {
    const p = page('banqi', new Map(), { storage: false });
    p.recorder.begin(() => ({ finished: true, round: 1 }));
    p.recorder.end();
    assert.equal(p.requests.length, 1);
    assert.equal(p.disk.size, 0);
    p.requests[0].drop();
    await settle();
    p.timers[0].fn();
    assert.equal(p.requests.length, 2, 'retried from memory');
    p.requests[1].answer(200);
    await settle();
    p.online();
    assert.equal(p.requests.length, 2);

    for (const beacon of [false, 'full']) {    // no sendBeacon at all, or the browser refuses to queue it
        const q = page('banqi', new Map(), { beacon });
        q.recorder.begin(() => ({ finished: false, moves: [1] }));
        q.hide();
        assert.equal(q.requests.length, 1, 'falls back to an ordinary request');
        assert.equal(q.requests[0].record.status, 'unfinished');
    }
});

test('a fault while recording never reaches the game', () => {
    const p = page('banqi');
    p.recorder.begin(() => { throw new Error('broken snapshot'); });
    assert.doesNotThrow(() => p.recorder.end());
    assert.doesNotThrow(() => p.hide());
    assert.equal(p.errors.length, 1);
    assert.equal(p.requests.length + p.beacons.length, 0);
    const cyclic = {};
    cyclic.self = cyclic;
    p.recorder.begin(() => cyclic);
    assert.doesNotThrow(() => p.recorder.end());
    p.recorder.begin(() => ({ finished: true }));
    p.recorder.end();
    assert.equal(p.requests.length, 1, 'and the next round is recorded as usual');
});
