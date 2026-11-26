'use strict';
// Computers that play by the trained model. Two halves are tested here, each in a stand-in browser:
//   - the script the server adds to every game page (BOT in open_server.py), which asks the server for the
//     model's card and steps aside whenever there is no model or no answer;
//   - the Gong Zhu page, where the player may pick the model (in its normal or its weaker way) instead of the
//     page's own computer; it then plays the card it is given, keeps to its own computer whenever there is none,
//     and marks in the round's record which cards a model chose.
// What the page asks is then handed to the server's own code (the PageRequests part of tests/test_model_bot.py).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const clone = value => (value == null ? null : JSON.parse(JSON.stringify(value)));
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const MODEL = { id: 'a'.repeat(40), saved: '2026-11-21T03:12:00+08:00', rounds: 236, decisions: 2400, accuracy: 0.59, chance: 0.29, finished: true, name: '' };
// Several models of one game, the way the server lists them: the newest name first, the first one is the default.
const MODELS = [['20261123_b', 'b'], ['20261123_a', 'c'], ['20261122', 'd']].map(([name, id]) => ({ ...MODEL, name, id: id.repeat(40) }));
// The menu train_out/gongzhu/choices.json sets up for them.
const MENU = [{ label: '遊戲設定(65)', play: 'builtin' }, { label: '模型A(100)', play: 'normal:20261123_b' },
    { label: '模型B(100)', play: 'normal:20261123_a' }, { label: '舊模型(90)', play: 'normal:20261122' }];

// ---------------------------------------------------------------- the script the server adds

const SCRIPT = execFileSync('python3', ['-c', 'import sys, open_server; sys.stdout.write(open_server.BOT)'],
    { cwd: ROOT, encoding: 'utf8' }).replace(/^<script>|<\/script>\s*$/g, '');

// One page load: the network, the clock and the timers are the test's.
function page(game = 'gongzhu') {
    const requests = [], timers = [], aborted = [], errors = [];
    const clock = { now: new Date(2026, 10, 21, 20, 0, 0).getTime() };
    class FakeDate extends Date { static now() { return clock.now; } }
    class FakeAbort { constructor() { this.signal = { of: this }; } abort() { aborted.push(this); } }
    const sandbox = {
        Date: FakeDate, JSON, Promise, AbortController: FakeAbort, console: { error: (...args) => errors.push(args) },
        setTimeout: (fn, delay) => { timers.push({ fn, delay, id: timers.length + 1 }); return timers.length; },
        clearTimeout: id => { const timer = timers.find(t => t.id === id); if (timer) timer.cleared = true; },
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({
            url, options, body: options.body ? JSON.parse(options.body) : undefined,
            answer: (status, body) => resolve({ status, json: () => Promise.resolve(body) }),
            html: status => resolve({ status, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }),
            drop: () => reject(new TypeError('Failed to fetch'))
        }))
    };
    sandbox.window = sandbox;
    vm.runInNewContext(SCRIPT.replace('__GAME__', game), sandbox);
    const changes = [];
    sandbox.GameBot.watch(() => changes.push(clone(sandbox.GameBot.model())));
    return {
        bot: sandbox.GameBot, requests, timers, aborted, errors, clock, changes,
        pending: () => timers.filter(t => !t.cleared && !t.fired),
        fire(delay) { const timer = timers.find(t => t.delay === delay && !t.cleared && !t.fired); timer.fired = true; timer.fn(); },
        async known(model = MODEL) {    // the page has asked and the server has a model
            const asking = this.bot.refresh();
            requests.shift().answer(200, { model, why: null });
            await asking;
        }
    };
}

test('the script: nothing is asked before the page knows of a model', async () => {
    const p = page();
    assert.equal(p.bot.model(), null);
    assert.equal(await p.bot.choose({ tricks: [] }, 'east', 'normal'), null);
    assert.equal(p.requests.length, 0);
});

test('the script: refresh() learns what model the server has and tells the page when that changes', async () => {
    const p = page('gongzhu');
    let asking = p.bot.refresh();
    assert.equal(p.requests.length, 1);
    assert.equal(p.requests[0].url, '/api/bot/gongzhu');
    assert.equal(p.requests[0].options.method, 'GET');
    p.requests.shift().answer(200, { model: MODEL, why: null });
    await asking;
    assert.deepEqual(clone(p.bot.model()), MODEL);
    assert.equal(p.bot.why(), null);
    assert.deepEqual(p.changes, [MODEL]);
    assert.equal(p.pending().length, 0, 'the wait for the answer is over');

    asking = p.bot.refresh();
    p.requests.shift().answer(200, { model: MODEL, why: null });
    await asking;
    assert.deepEqual(p.changes, [MODEL], 'the same model again is no news');

    asking = p.bot.refresh();
    p.requests.shift().answer(200, { model: null, why: '要重新訓練' });
    await asking;
    assert.equal(p.bot.model(), null);
    assert.equal(p.bot.why(), '要重新訓練');
    assert.deepEqual(p.changes, [MODEL, null]);
});

test('the script: a server from before this feature simply has no model', async () => {
    const p = page();
    const asking = p.bot.refresh();
    p.requests.shift().html(404);    // the "no such game" page
    await asking;
    assert.equal(p.bot.model(), null);
    assert.equal(p.bot.resting(), false);
    assert.deepEqual(p.changes, []);
});

test('the script: choose() sends the round so far, the seat and the mode, and hands back the answer', async () => {
    const p = page('gongzhu');
    await p.known();
    const record = { seats: ['south', 'east', 'north', 'west'], tricks: [[{ seat: 'south', card: 'C2' }]] };
    const asking = p.bot.choose(record, 'east', 'weak');
    assert.equal(p.requests.length, 1);
    const request = p.requests.shift();
    assert.equal(request.url, '/api/bot/gongzhu');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(request.body, { record, seat: 'east', mode: 'weak' });
    assert.ok(request.options.signal, 'the request can be given up');
    const answer = { play: { seat: 'east', card: 'C14' }, mode: 'weak', model: MODEL.id };
    request.answer(200, answer);
    assert.deepEqual(clone(await asking), answer);
    assert.equal(p.requests.length, 0);
    assert.equal(p.bot.resting(), false);
});

test('the script: with several models, models() lists them and choose() asks the one it names', async () => {
    const p = page('gongzhu');
    assert.deepEqual(clone(p.bot.models()), []);
    let asking = p.bot.refresh();
    p.requests.shift().answer(200, { model: MODELS[0], why: null, models: MODELS });
    await asking;
    assert.deepEqual(clone(p.bot.model()), MODELS[0]);
    assert.deepEqual(clone(p.bot.models()), MODELS);

    const record = { tricks: [] };
    let choosing = p.bot.choose(record, 'east', 'weak', '20261122');
    let request = p.requests.shift();
    assert.deepEqual(request.body, { record, seat: 'east', mode: 'weak', model: '20261122' });
    request.answer(200, { play: { seat: 'east', card: 'C14' }, mode: 'weak', model: MODELS[2].id });
    assert.equal((await choosing).model, MODELS[2].id);
    assert.equal(p.requests.length, 0, 'the answer came from the model that was named: nothing to look up');

    choosing = p.bot.choose(record, 'east', 'normal', '20261123_a');
    p.requests.shift().answer(200, { play: { seat: 'east', card: 'C14' }, mode: 'normal', model: 'e'.repeat(40) });
    await choosing;
    assert.equal(p.requests.length, 1, 'another file under that name: the models are looked up again');
    assert.equal(p.requests[0].options.method, 'GET');

    asking = p.bot.refresh();
    p.requests.shift();    // (the lookup started above)
    p.requests.shift().answer(200, { model: MODEL, why: null });    // a server that only knows of one model
    await asking;
    assert.deepEqual(clone(p.bot.models()), [MODEL]);
});

test('the script: strength() hands over how strong the server measured each choice', async () => {
    const p = page('gongzhu');
    assert.deepEqual(clone(p.bot.strength()), {});
    const strength = { builtin: 56, 'normal:20261123_b': 100, 'weak:20261123_b': 97 };
    let asking = p.bot.refresh();
    p.requests.shift().answer(200, { model: MODELS[0], why: null, models: MODELS, strength });
    await asking;
    assert.deepEqual(clone(p.bot.strength()), strength);
    assert.equal(p.changes.length, 1);

    asking = p.bot.refresh();
    p.requests.shift().answer(200, { model: MODELS[0], why: null, models: MODELS, strength: {} });
    await asking;
    assert.deepEqual(clone(p.bot.strength()), {});
    assert.equal(p.changes.length, 2, 'a change of strength is news to the page');

    asking = p.bot.refresh();
    p.requests.shift().answer(200, { model: null, why: null, models: [], strength });
    await asking;
    assert.deepEqual(clone(p.bot.strength()), {}, 'no model, nothing to rate');
});

test('the script: choices() hands over the menu the server was set up with', async () => {
    const p = page('gongzhu');
    assert.deepEqual(clone(p.bot.choices()), []);
    let asking = p.bot.refresh();
    p.requests.shift().answer(200, { model: MODELS[0], why: null, models: MODELS, choices: MENU });
    await asking;
    assert.deepEqual(clone(p.bot.choices()), MENU);
    asking = p.bot.refresh();
    p.requests.shift().answer(200, { model: MODELS[0], why: null, models: MODELS });
    await asking;
    assert.deepEqual(clone(p.bot.choices()), [], 'a server without a menu');
    assert.equal(p.changes.length, 2);
});

test('the script: a model that has been taken away is forgotten', async () => {
    const p = page();
    await p.known();
    const asking = p.bot.choose({}, 'east', 'normal');
    p.requests.shift().answer(404, { error: 'no model' });
    assert.equal(await asking, null);
    assert.equal(p.bot.model(), null);
    assert.deepEqual(p.changes, [MODEL, null]);
    assert.equal(await p.bot.choose({}, 'east', 'normal'), null);
    assert.equal(p.requests.length, 0, 'and not asked again until a refresh finds one');
});

test('the script: when the server cannot be reached the page is left alone for half a minute, then asked again', async () => {
    const p = page();
    await p.known();
    let asking = p.bot.choose({}, 'east', 'normal');
    p.requests.shift().drop();
    assert.equal(await asking, null);
    assert.equal(p.bot.resting(), true);
    assert.deepEqual(clone(p.bot.model()), MODEL, 'the model is still believed to be there');
    assert.equal(p.changes.length, 2, 'the page is told');

    assert.equal(await p.bot.choose({}, 'north', 'normal'), null);
    assert.equal(p.requests.length, 0, 'no question while resting: the computers must not stall on every card');

    p.clock.now += 30001;
    assert.equal(p.bot.resting(), false);
    p.fire(30050);
    assert.equal(p.changes.length, 3, 'and told again when the rest is over');
    asking = p.bot.choose({}, 'north', 'normal');
    assert.equal(p.requests.length, 1);
    p.requests.shift().answer(200, { play: { seat: 'north', card: 'S3' }, mode: 'normal', model: MODEL.id });
    assert.deepEqual(clone(await asking).play, { seat: 'north', card: 'S3' });
});

test('the script: an answer that takes too long counts as no answer', async () => {
    const p = page();
    await p.known();
    const asking = p.bot.choose({}, 'east', 'normal');
    const request = p.requests.shift();
    p.fire(2500);
    assert.equal(await asking, null);
    assert.equal(p.aborted.length, 1, 'the request is given up');
    assert.equal(p.bot.resting(), true);
    request.answer(200, { play: { seat: 'east', card: 'S3' }, mode: 'normal', model: MODEL.id });
    await settle();    // too late: nothing happens
    assert.equal(p.errors.length, 0);
});

test('the script: a question the server refuses is not a broken connection, a failing server is', async () => {
    const p = page();
    await p.known();
    let asking = p.bot.choose({}, 'east', 'normal');
    p.requests.shift().answer(400, { error: '出牌的順序不對' });
    assert.equal(await asking, null);
    assert.equal(p.bot.resting(), false);
    assert.deepEqual(clone(p.bot.model()), MODEL);

    asking = p.bot.choose({}, 'east', 'normal');
    p.requests.shift().answer(200, { mode: 'normal' });    // no card in it
    assert.equal(await asking, null);
    assert.equal(p.bot.resting(), false);

    asking = p.bot.choose({}, 'east', 'normal');
    p.requests.shift().answer(500, { error: 'the model failed' });
    assert.equal(await asking, null);
    assert.equal(p.bot.resting(), true);
});

test('the script: an answer from another model makes the page look up the new one', async () => {
    const p = page();
    await p.known();
    const asking = p.bot.choose({}, 'east', 'normal');
    p.requests.shift().answer(200, { play: { seat: 'east', card: 'S3' }, mode: 'normal', model: 'b'.repeat(40) });
    assert.ok(await asking);
    assert.equal(p.requests.length, 1);
    assert.equal(p.requests[0].options.method, 'GET');
    p.requests.shift().answer(200, { model: { ...MODEL, id: 'b'.repeat(40), rounds: 300 }, why: null });
    await settle();
    assert.equal(p.bot.model().rounds, 300);
    assert.equal(p.changes.length, 2);
});

test('the script: a page that breaks while being told does not break the others', async () => {
    const p = page();
    p.bot.watch(() => { throw new Error('page bug'); });
    let told = 0;
    p.bot.watch(() => { told++; });
    await p.known();
    assert.equal(told, 1);
    assert.equal(p.errors.length, 1);
});

// ---------------------------------------------------------------- the Gong Zhu page

// Stands in for every DOM object: any property is another stand-in and any call returns one.
function nothing() {
    const kept = {};
    const self = new Proxy(function () {}, {
        get(_, key) {
            if (key === Symbol.toPrimitive) return hint => (hint === 'number' ? 0 : '');
            if (key === Symbol.iterator) return function* () {};
            if (key === 'then' || key === 'toJSON') return undefined;
            if (key === 'length') return 0;
            return key in kept ? kept[key] : self;
        },
        set(_, key, value) { kept[key] = value; return true; },
        apply: () => self,
        construct: () => self
    });
    return self;
}

// What the server's script is to the page, with the answers in the test's hands.
function fakeBot(model = MODEL, list = null) {
    return {
        info: model, list, off: false, asked: [], watchers: [], refreshed: 0, looking: null,
        model() { return this.info; },
        models() { return this.info ? this.list || [this.info] : []; },
        rated: {},
        strength() { return this.info ? this.rated : {}; },
        listed: [],
        choices() { return this.info ? this.listed : []; },
        why() { return null; },
        resting() { return this.off; },
        watch(fn) { this.watchers.push(fn); },
        refresh() { this.refreshed++; return this.looking || Promise.resolve(); },   // `looking`: a lookup the test ends itself
        choose(record, seat, mode, name) { return new Promise(resolve => this.asked.push({ record: clone(record), seat, mode, name, resolve })); }
    };
}

// Loads games/gongzhu.html the way a browser would, minus the screen. Time only moves when step() runs a timer.
// `mode` is what the player picks for the computers right away ('normal', 'weak'); `disk` is the browser's
// localStorage, which outlives the page.
function open(seed, bot, mode = null, disk = new Map()) {
    const timers = [];
    let now = 0, ids = 0, clock = Date.UTC(2026, 10, 21), ticks = 0;
    const tick = () => (clock += 40);
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [tick()])); }
        static now() { return tick(); }
    }
    const recorder = {
        current: null, rounds: [],
        begin(snapshot) { this.current = snapshot; },
        end() {
            if (!this.current) return;
            const record = clone(this.current());
            this.current = null;
            if (record) this.rounds.push(record);
        },
        peek() { return this.current ? clone(this.current()) : null; }
    };
    const sandbox = {
        document: nothing(), console, navigator: { userAgent: 'node' },
        localStorage: disk === null ? { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } } : {
            getItem: key => (disk.has(key) ? disk.get(key) : null),
            setItem(key, value) { disk.set(key, String(value)); },
            removeItem(key) { disk.delete(key); }
        },
        Math: Object.assign(Object.create(Math), { random: rng(seed) }),
        Date: FakeDate, performance: { now: () => (ticks += 50) },
        setTimeout(fn, delay) { timers.push({ id: ++ids, at: now + (delay || 0), fn }); return ids; },
        clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
        requestAnimationFrame: () => 0, matchMedia: () => nothing(), ResizeObserver: class { observe() {} },
        addEventListener() {}, GameRecorder: recorder
    };
    if (bot) sandbox.GameBot = bot;
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(require('./gongzhu/source.cjs'), context, { filename: 'gongzhu.html' });
    sandbox.onload();
    const game = vm.runInContext('game', context);
    game.sound.enabled = false;
    if (mode) game.setBotMode(mode);
    Object.assign(vm.runInContext('GongZhuAI', context), { MIN_SAMPLES: 2, MAX_SAMPLES: 2 });
    const random = rng(seed * 7919 + 13);
    return {
        game, recorder, bot, random, disk,
        step() {
            if (!timers.length) return false;
            timers.sort((a, b) => a.at - b.at || a.id - b.id);
            const timer = timers.shift();
            now = timer.at;
            timer.fn();
            return true;
        }
    };
}

const mine = game => !game.isProcessingTrick && game.currentTurn === 'south' && game.PLAYERS.south.hand.length > 0;
const hands = game => clone(Object.fromEntries(game.SEAT_ORDER.map(seat => [seat, game.PLAYERS[seat].hand.map(c => c.id)])));
const table = game => clone(game.currentTrick.map(t => [t.seat, t.card.id]));

// The model's stand-in: always the last card the seat may play (the page's own computer seldom agrees for long).
function lastLegal(question, env) {
    const legal = env.game.getLegalCards(question.seat);
    return { play: { seat: question.seat, card: legal[legal.length - 1].id }, mode: question.mode, model: MODEL.id };
}

// Lets the computers move until the player has to decide (false when the round is over). Every question to the
// model is answered with reply(question, env), noted in `answered`; `until` can stop the wait earlier.
async function wait(env, reply = lastLegal, answered = [], until = null) {
    for (let guard = 0; !env.game.roundOver; guard++) {
        assert.ok(guard < 5000, 'the computers never finish their turn');
        await settle();
        if (until && until()) return true;
        if (env.bot && env.bot.asked.length) {
            const question = env.bot.asked.shift();
            const answer = reply(question, env);
            answered.push({ question, answer, played: env.game.tricksSoFar().flat().length });
            question.resolve(answer);
            await settle();
            continue;
        }
        if (mine(env.game)) return true;
        assert.ok(env.step(), 'nothing is scheduled, nobody was asked, and the round is not over');
    }
    return false;
}

const act = env => {
    const legal = env.game.getLegalCards('south');
    env.game.onPlayerCardClick(legal[Math.floor(env.random() * legal.length)].id);
};

async function playRound(env, reply = lastLegal, answered = []) {
    for (let guard = 0; await wait(env, reply, answered); guard++) {
        assert.ok(guard < 60, 'the round does not end');
        act(env);
    }
    const record = env.recorder.rounds.at(-1);
    const scores = ({ card }) => card[0] === 'H' || ['S12', 'C10', 'D11'].includes(card);
    assert.equal(record.finished, true);
    assert.ok(record.tricks.every(trick => trick.length === 4));
    assert.equal(record.tricks.flat().filter(scores).length, 16);
    assert.ok(record.tricks.at(-1).some(scores), 'the round stops on the last scoring trick');
    return answered;
}

test('gongzhu: unless the player picks the model, the page keeps to its own computer and asks nothing', async () => {
    const plain = open(2), env = open(2, fakeBot());
    assert.equal(env.game.botMode, 'builtin');
    const answered = await playRound(env);
    await playRound(plain);
    assert.equal(answered.length, 0, 'a model is there, but nobody picked it');
    assert.deepEqual(env.recorder.rounds, plain.recorder.rounds, 'the round is the one the page has always played');
    assert.equal(env.bot.refreshed, 1, 'the page still finds out that a model can be picked');
});

test('gongzhu: once the model is picked the computers play the card the model answers, and the record says so', async () => {
    const env = open(3, fakeBot(), 'normal');
    const answered = await playRound(env);
    assert.equal(env.recorder.rounds.length, 1);
    const record = env.recorder.rounds[0];
    assert.equal(record.finished, true);
    const plays = record.tricks.flat();
    const computers = plays.filter(play => play.seat !== 'south');
    assert.equal(computers.length, 3 * record.tricks.length);
    assert.equal(answered.length, computers.length, 'one question for every card of a computer');
    answered.forEach(({ question, answer, played }, i) => {
        assert.deepEqual(computers[i], { seat: question.seat, card: answer.play.card, bot: 'normal' }, `card ${i + 1} of the computers`);
        assert.equal(question.mode, 'normal');
        assert.equal(question.record.finished, false);
        assert.equal(question.record.result, null);
        assert.deepEqual(question.record.seats, ['south', 'west', 'north', 'east']);
        assert.deepEqual(question.record.tricks.flat().map(play => play.card), plays.slice(0, played).map(play => play.card),
            'the question carries the round up to that card');
        assert.deepEqual(question.record.hands, record.hands, 'and the deal');
        assert.deepEqual(question.record.totals, record.totals);
        assert.equal(question.record.players[question.seat].ai, true);
    });
    for (const play of plays.filter(play => play.seat === 'south')) assert.equal(play.bot, undefined, 'the player is never marked');
    assert.equal(record.model, MODEL.id, 'which model it was');
    assert.equal(env.bot.refreshed, 1, 'the page looks for a new model when a round starts');
    assert.equal(env.bot.watchers.length, 1);

    env.game.startNextRound();
    assert.equal(env.bot.refreshed, 2);
});

test('gongzhu: the computers wait until the page knows whether there is a model, so none of their cards slips past it', async () => {
    for (let seed = 81; seed < 85; seed++) {
        const bot = fakeBot(null);
        let found;
        bot.looking = new Promise(resolve => { found = resolve; });
        const env = open(seed, bot, 'normal');
        const game = env.game;
        while (env.step());    // every wait of the page runs out, and still:
        await settle();
        if (mine(game)) continue;    // The player holds the seven of spades and leads.
        assert.equal(game.tricksSoFar().flat().length, 0, 'no computer has played');
        assert.equal(bot.asked.length, 0);
        bot.info = MODEL;    // the server answers: there is a model
        found();
        await settle();
        assert.equal(bot.asked.length, 1, 'now the model is asked for the first card');
        assert.equal(game.tricksSoFar().flat().length, 0);
        const answered = await playRound(env);
        const tricks = env.recorder.rounds[0].tricks;
        assert.equal(answered.length, 3 * tricks.length);
        assert.equal(tricks.flat().filter(play => play.bot === 'normal').length, answered.length);
        return;
    }
    assert.fail('a computer never had the lead');
});

test('gongzhu: the weaker way of playing is asked for by name and marked as such', async () => {
    const env = open(4, fakeBot(), 'weak');
    const answered = [];
    assert.ok(await wait(env, lastLegal, answered));
    act(env);
    assert.ok(await wait(env, lastLegal, answered));
    assert.ok(answered.length > 0);
    assert.ok(answered.every(({ question }) => question.mode === 'weak'));
    const soFar = env.recorder.peek().tricks.flat().filter(play => play.seat !== 'south');
    assert.ok(soFar.length > 0 && soFar.every(play => play.bot === 'weak'));

    env.game.setBotMode('normal');
    const before = answered.length;
    act(env);
    await wait(env, lastLegal, answered);
    assert.ok(answered.length > before);
    assert.ok(answered.slice(before).every(({ question }) => question.mode === 'normal'), 'switching takes effect with the next card');
    env.game.setBotMode('strongest');
    assert.equal(env.game.botMode, 'builtin', 'the model has only the two ways; anything else is the page\'s own computer');
    const asked = answered.length;
    act(env);
    await wait(env, lastLegal, answered);
    assert.equal(answered.length, asked, 'which asks nothing');
});

test('gongzhu: the way picked for the computers is remembered on the device', async () => {
    const disk = new Map();
    const first = open(91, fakeBot(), null, disk);
    assert.equal(first.game.botMode, 'builtin');
    first.game.setBotMode('weak');
    const second = open(92, fakeBot(), null, disk);    // the page is opened again
    assert.equal(second.game.botMode, 'weak');
    const answered = [];
    assert.ok(await wait(second, lastLegal, answered));
    act(second);
    await wait(second, lastLegal, answered);
    assert.ok(answered.length > 0 && answered.every(({ question }) => question.mode === 'weak'));
    second.game.setBotMode('builtin');
    assert.equal(open(93, fakeBot(), null, disk).game.botMode, 'builtin');

    disk.set('game_setting:gongzhu:bot', 'strongest');
    assert.equal(open(94, fakeBot(), null, disk).game.botMode, 'builtin', 'nonsense is not a choice');
    const locked = open(95, fakeBot(), null, null);    // a browser that keeps nothing
    assert.equal(locked.game.botMode, 'builtin');
    locked.game.setBotMode('normal');
    assert.equal(locked.game.botMode, 'normal', 'the choice still holds while the page is open');
});

// The model's stand-in when there are several: the last card the seat may play, from the model that was named.
function lastLegalFromNamed(question, env) {
    return { ...lastLegal(question, env), model: MODELS.find(model => model.name === question.name).id };
}

// Plays on until the computers have been asked at least once (the player may hold the seven of spades and lead).
async function untilAsked(env, answered) {
    while (!answered.length && await wait(env, lastLegalFromNamed, answered)) act(env);
}

test('gongzhu: with several models each one can be picked, is asked for by name, and the record says which', async () => {
    const env = open(5, fakeBot(MODELS[0], MODELS), 'weak:20261123_a');
    assert.equal(env.game.botMode, 'weak');
    assert.equal(env.game.botModel, '20261123_a');
    const answered = await playRound(env, lastLegalFromNamed);
    const record = env.recorder.rounds[0];
    assert.equal(answered.length, 3 * record.tricks.length);
    assert.ok(answered.every(({ question }) => question.mode === 'weak' && question.name === '20261123_a'));
    assert.equal(record.model, MODELS[1].id, 'the record names the model by its file');
    assert.ok(record.tricks.flat().filter(play => play.seat !== 'south').every(play => play.bot === 'weak'));

    env.game.startNextRound();
    env.game.setBotMode('normal:20261122');
    const next = [];
    await untilAsked(env, next);
    assert.deepEqual([next[0].question.mode, next[0].question.name], ['normal', '20261122']);
});

test('gongzhu: the model picked is remembered, and the first one stands in for a model that is no longer there', async () => {
    const disk = new Map();
    open(11, fakeBot(MODELS[0], MODELS), 'normal:20261123_a', disk);
    const again = open(12, fakeBot(MODELS[0], MODELS), null, disk);
    assert.deepEqual([again.game.botMode, again.game.botModel], ['normal', '20261123_a']);

    const gone = open(13, fakeBot(MODELS[0], [MODELS[0], MODELS[2]]), null, disk);
    const answered = [];
    await untilAsked(gone, answered);
    assert.equal(answered[0].question.name, '20261123_b');
    assert.equal(gone.game.botModel, '20261123_a', 'the pick is kept for when that model comes back');

    gone.game.setBotMode('builtin');
    assert.equal(gone.game.botModel, null);
    assert.equal(disk.has('game_setting:gongzhu:bot_model'), false);
});

test('gongzhu: each choice carries the strength the server measured, when it measured one', async () => {
    const bot = fakeBot(MODELS[0], MODELS);
    const env = open(15, bot);
    const labels = () => clone(env.game.botChoices()).map(([value, text]) => `${value}=${text}`);
    assert.deepEqual(labels(), ['builtin=原本的電腦（遊戲內建的算法）',
        'normal:20261123_b=模型 20261123_b・正常', 'weak:20261123_b=模型 20261123_b・較弱',
        'normal:20261123_a=模型 20261123_a・正常', 'weak:20261123_a=模型 20261123_a・較弱',
        'normal:20261122=模型 20261122・正常', 'weak:20261122=模型 20261122・較弱'], 'seven choices for three models');
    bot.rated = { builtin: 56, 'normal:20261123_b': 100, 'weak:20261123_b': 97, 'normal:20261122': 61 };
    assert.deepEqual(labels().slice(0, 3), ['builtin=原本的電腦（遊戲內建的算法，強度 56）',
        'normal:20261123_b=模型 20261123_b・正常（強度 100）', 'weak:20261123_b=模型 20261123_b・較弱（強度 97）']);
    assert.equal(labels()[3], 'normal:20261123_a=模型 20261123_a・正常', 'not measured: no number');
    assert.equal(labels()[5], 'normal:20261122=模型 20261122・正常（強度 61）');
    assert.deepEqual(clone(open(16, fakeBot(MODEL)).game.botChoices()).map(([value]) => value), ['builtin', 'normal:', 'weak:'],
        'a single model.pt has no name');
});

test('gongzhu: a menu set up on the server is listed as it is, and each choice asks its own model', async () => {
    const menuBot = list => Object.assign(fakeBot(MODELS[0], MODELS), { listed: list });
    const env = open(17, menuBot(MENU), 'normal:20261123_a');
    assert.deepEqual(clone(env.game.botChoices()), [['builtin', '遊戲設定(65)'], ['normal:20261123_b', '模型A(100)'],
        ['normal:20261123_a', '模型B(100)'], ['normal:20261122', '舊模型(90)']]);
    const answered = [];
    await untilAsked(env, answered);
    assert.deepEqual([answered[0].question.mode, answered[0].question.name], ['normal', '20261123_a'], '模型B is 20261123_a');
    assert.deepEqual(clone(open(18, menuBot(MENU.slice(1))).game.botChoices())[0], ['builtin', '原本的電腦（遊戲內建的算法）'],
        'the page\'s own computer is always there');
});

test('gongzhu: a device that picked the model when there was only one asks the first of several by name', async () => {
    const disk = new Map([['game_setting:gongzhu:bot', 'normal']]);
    const env = open(14, fakeBot(MODELS[0], MODELS), null, disk);
    assert.deepEqual([env.game.botMode, env.game.botModel], ['normal', null]);
    const answered = [];
    await untilAsked(env, answered);
    assert.deepEqual([answered[0].question.mode, answered[0].question.name], ['normal', '20261123_b']);
});

test('gongzhu: without an answer, or with one that cannot be played, the page plays its own card and marks nothing', async () => {
    const replies = [
        () => null,                                                                             // no model, no connection
        question => ({ play: { seat: question.seat, card: 'S99' }, mode: 'normal', model: MODEL.id }),   // no such card
        (question, env) => {                                                                    // a card the seat does not hold
            const other = env.game.SEAT_ORDER.find(seat => seat !== question.seat && env.game.PLAYERS[seat].hand.length);
            const card = other ? env.game.PLAYERS[other].hand[0].id : question.record.tricks[0][0].card;
            return { play: { seat: question.seat, card }, mode: 'normal', model: MODEL.id };
        },
        (question, env) => ({ ...lastLegal(question, env), play: { seat: 'south', card: lastLegal(question, env).play.card } }),   // another seat's turn
        () => ({ mode: 'normal', model: MODEL.id })                                             // no card at all
    ];
    for (const [i, reply] of replies.entries()) {
        const env = open(5 + i, fakeBot(), 'normal');
        const answered = await playRound(env, reply);
        const record = env.recorder.rounds[0];
        assert.equal(answered.length, 3 * record.tricks.length, `reply ${i}: the model was still asked every time`);
        assert.ok(record.tricks.flat().every(play => play.bot === undefined), `reply ${i}: nothing is marked`);
        assert.equal('model' in record, false, `reply ${i}: and no model is named`);
    }
});

test('gongzhu: a card that breaks the rules is not played even when the model asks for it', async () => {
    const env = open(11, fakeBot(), 'normal');
    let refused = 0;
    const offSuit = (question, env) => {
        const game = env.game, hand = game.PLAYERS[question.seat].hand, legal = game.getLegalCards(question.seat);
        const illegal = hand.find(card => !legal.some(c => c.id === card.id));
        if (!illegal) return lastLegal(question, env);
        refused++;
        return { play: { seat: question.seat, card: illegal.id }, mode: 'normal', model: MODEL.id };
    };
    await playRound(env, offSuit);
    assert.ok(refused > 5, 'the stand-in did ask for cards that may not be played');
    const record = env.recorder.rounds[0];
    record.tricks.forEach((trick, t) => trick.forEach((play, i) => {
        if (t === 0 && i === 0) assert.ok(record.hands[play.seat].includes('S7'));
        if (i === 0) return;
        const led = trick[0].card[0];
        const held = record.hands[play.seat].filter(card => !record.tricks.slice(0, t).flat().some(p => p.card === card));
        if (play.card[0] !== led) assert.ok(!held.some(card => card[0] === led), `${play.seat} fails to follow suit in trick ${t + 1}`);
    }));
    assert.equal(record.tricks.flat().filter(play => play.bot).length, 3 * record.tricks.length - refused, 'only the cards that were the model\'s are marked');
});

test('gongzhu: an answer that comes back after the player took the move back is not played', async () => {
    let checked = 0;
    for (let seed = 21; seed < 27; seed++) {
        const env = open(seed, fakeBot(), 'normal');
        const game = env.game;
        assert.ok(await wait(env));
        act(env);
        assert.ok(await wait(env));
        const before = { hands: hands(game), table: table(game), record: env.recorder.peek() };

        act(env);
        // stop as soon as a computer has asked the model, before it is answered
        await wait(env, lastLegal, [], () => env.bot.asked.length > 0);
        if (!env.bot.asked.length) continue;    // the player took the lead and is to play again: try another deal
        const stale = env.bot.asked.shift();
        game.undo();
        assert.deepEqual({ hands: hands(game), table: table(game), record: env.recorder.peek() }, before, 'the move is taken back');

        stale.resolve(lastLegal(stale, env));
        await settle();
        assert.deepEqual({ hands: hands(game), table: table(game), record: env.recorder.peek() }, before, 'the late answer changes nothing');
        while (env.step());    // whatever is still scheduled (a banner going away) leaves the round alone
        assert.deepEqual({ hands: hands(game), table: table(game), record: env.recorder.peek() }, before);
        assert.ok(mine(game), 'and it is still the player\'s turn');

        act(env);
        const answered = [];
        await wait(env, lastLegal, answered);
        await playRound(env, lastLegal, answered);
        assert.ok(answered.length > 0, 'the computers ask anew and carry on');
        const record = env.recorder.rounds[0];
        assert.ok(record.tricks.flat().filter(play => play.seat !== 'south').every(play => play.bot === 'normal'));
        checked++;
    }
    assert.ok(checked >= 3, 'the check ran on several deals');
});

test('gongzhu: an old answer that arrives while the same computer is being asked again does not get in first', async () => {
    let checked = 0;
    for (let seed = 71; seed < 90 && checked < 3; seed++) {
        const env = open(seed, fakeBot(), 'normal');
        const game = env.game;
        assert.ok(await wait(env));
        act(env);
        await wait(env, lastLegal, [], () => env.bot.asked.length > 0);
        if (!env.bot.asked.length) continue;
        const stale = env.bot.asked.shift();
        game.undo();
        act(env);
        await wait(env, lastLegal, [], () => env.bot.asked.length > 0);
        if (!env.bot.asked.length) continue;
        const fresh = env.bot.asked.shift(), legal = game.getLegalCards(fresh.seat);
        if (fresh.seat !== stale.seat || legal.length < 2) continue;    // needs two cards to tell the answers apart
        const cards = game.tricksSoFar().flat().length;
        stale.resolve({ play: { seat: stale.seat, card: legal[0].id }, mode: 'normal', model: MODEL.id });
        await settle();
        assert.equal(game.tricksSoFar().flat().length, cards, 'the old answer is not played');
        fresh.resolve(lastLegal(fresh, env));
        await settle();
        const played = game.tricksSoFar().flat();
        assert.equal(played.length, cards + 1);
        assert.equal(played[cards].card.id, legal[legal.length - 1].id, 'the new one is');
        checked++;
    }
    assert.equal(checked, 3, 'the check ran on three deals');
});

test('gongzhu: an answer for a round that was restarted in the meantime is not played either', async () => {
    const env = open(22, fakeBot(), 'normal');
    const game = env.game;
    assert.ok(await wait(env));
    act(env);
    await wait(env, lastLegal, [], () => env.bot.asked.length > 0);
    assert.ok(env.bot.asked.length > 0);
    const stale = env.bot.asked.shift();
    game.resetFullMatch();
    const dealt = hands(game);
    stale.resolve({ play: { seat: stale.seat, card: game.PLAYERS[stale.seat].hand[0].id }, mode: 'normal', model: MODEL.id });
    await settle();
    assert.deepEqual(hands(game), dealt, 'nobody has played a card of the new deal');
    await playRound(env);
});

test('gongzhu: the model is picked but the server has none, or cannot be reached: nothing is asked and nothing is marked', async () => {
    for (const setup of [bot => { bot.info = null; }, bot => { bot.off = true; }]) {
        const env = open(31, fakeBot(), 'normal');
        setup(env.bot);
        const answered = await playRound(env);
        assert.equal(answered.length, 0);
        const record = env.recorder.rounds[0];
        assert.deepEqual(Object.keys(record), ['finished', 'round', 'settings', 'seats', 'players', 'hands', 'totals', 'tricks', 'result'],
            'the record looks as it always did');
        assert.ok(record.tricks.flat().every(play => Object.keys(play).every(key => ['seat', 'card', 'hint'].includes(key))));
    }
});

test('gongzhu: the same deal is played the same way with and without the server\'s script when there is no model', async () => {
    const plain = open(41), scripted = open(41, fakeBot(null), 'normal');
    await playRound(plain);
    await playRound(scripted);
    assert.deepEqual(scripted.recorder.rounds, plain.recorder.rounds);
});

test('gongzhu: the hint button is the page\'s own advice and never asks the model', async () => {
    const env = open(51, fakeBot(), 'normal');
    assert.ok(await wait(env));
    const asked = env.bot.asked.length;
    env.game.showHint();
    await settle();
    assert.equal(env.bot.asked.length, asked);
    assert.notEqual(env.game.hintCardId, null);
});

// The server answers these questions with train_gpu.py's own reading of a round. Whatever the page asks has to be
// something that reading accepts, so a few rounds' worth of real questions are put to the server's code.
test('the server understands every question the page asks', async () => {
    const questions = [];
    for (const [seed, mode] of [[61, 'normal'], [62, 'weak']]) {
        const env = open(seed, fakeBot(), mode);
        const answered = await playRound(env);
        assert.equal(answered.length, 3 * env.recorder.rounds[0].tricks.length);
        questions.push(...answered.map(({ question }) => ({ record: question.record, seat: question.seat, mode: question.mode })));
    }
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'game-bot-'));
    try {
        const file = path.join(folder, 'questions.json');
        fs.writeFileSync(file, JSON.stringify(questions));
        const run = spawnSync('python3', [path.join(ROOT, 'tests', 'test_model_bot.py'), 'PageRequests'],
            { env: { ...process.env, MODEL_BOT_REQUESTS: file }, encoding: 'utf8' });
        assert.equal(run.status, 0, `tests/test_model_bot.py PageRequests failed:\n${run.stdout}${run.stderr}`);
        assert.match(run.stderr, /Ran 1 test/);
        assert.doesNotMatch(run.stderr, /skipped/, 'the check really ran');
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
