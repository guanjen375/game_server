'use strict';
// Automatic recording: every game hands each round to the server's GameRecorder.
// The real pages are loaded with a stand-in DOM, clock and recorder, whole rounds are played,
// and every record is then replayed from nothing but its own contents: a record that cannot
// rebuild the round (the deal and every decision, in order) is useless as training data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const clone = value => (value == null ? null : JSON.parse(JSON.stringify(value)));
const sorted = list => list.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

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

// Loads games/<name>.html the way a browser would, minus the screen. Time only moves when step() runs a timer.
function open(name, seed = 1) {
    const html = fs.readFileSync(path.join(ROOT, 'games', `${name}.html`), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    const timers = [];
    let now = 0, ids = 0, clock = Date.UTC(2026, 10, 20), ticks = 0;
    const tick = () => (clock += 40);
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [tick()])); }
        static now() { return tick(); }
    }
    const recorder = {
        current: null, rounds: [], begun: 0,
        begin(snapshot) { this.current = snapshot; this.begun++; },
        end() {
            if (!this.current) return;
            const record = clone(this.current());
            this.current = null;
            if (record) this.rounds.push(record);
        },
        peek() { return this.current ? clone(this.current()) : null; }    // what leaving the page now would save
    };
    const sandbox = {
        document: nothing(), console, navigator: { userAgent: 'node' },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        Math: Object.assign(Object.create(Math), { random: rng(seed) }),
        Date: FakeDate, performance: { now: () => (ticks += 50) },
        setTimeout(fn, delay) { timers.push({ id: ++ids, at: now + (delay || 0), fn }); return ids; },
        clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
        requestAnimationFrame: () => 0, matchMedia: () => nothing(), ResizeObserver: class { observe() {} },
        addEventListener() {}, GameRecorder: recorder
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    scripts.forEach((code, i) => vm.runInContext(code, context, { filename: `${name}.html#${i}` }));
    if (typeof sandbox.onload === 'function') sandbox.onload();
    const env = {
        name, recorder, random: rng(seed * 7919 + 13),
        api: expression => vm.runInContext(expression, context),
        step() {
            if (!timers.length) return false;
            timers.sort((a, b) => a.at - b.at || a.id - b.id);
            const timer = timers.shift();
            now = timer.at;
            timer.fn();
            return true;
        }
    };
    env.game = env.api('game');
    env.pick = list => list[Math.floor(env.random() * list.length)];
    env.driver = DRIVERS[name === 'mahjong-me' ? 'mahjong' : name];
    env.driver.setup(env);
    return env;
}

// Lets the computers move until the player has to decide; false when the round is over.
function wait(env) {
    for (let guard = 0; !env.driver.over(env.game); guard++) {
        assert.ok(guard < 5000, `${env.name}: the computers never finish their turn`);
        if (env.driver.ready(env.game)) return true;
        assert.ok(env.step(), `${env.name}: nothing is scheduled but the round is not over`);
    }
    return false;
}

// The round as the page holds it now, to compare with what a record rebuilds (copied out of the page's own realm).
const stateOf = env => clone(env.driver.state(env.game));

function playRound(env, hintChance = 0.25) {
    for (let guard = 0; wait(env); guard++) {
        assert.ok(guard < 3000, `${env.name}: the round does not end`);
        if (env.random() < hintChance) env.driver.hint(env.game);
        env.driver.act(env);
    }
}

const DRIVERS = {
    banqi: {
        setup: ({ game }) => { game.sound.enabled = false; game.setSetting('difficulty', 'easy'); },
        over: game => game.gameOver,
        ready: game => game.isHumanTurn(),
        hint: game => { game.showHint(); return true; },
        act({ game, random }) {
            const hidden = [...game.state.board].flatMap((p, sq) => (p === 15 ? [sq] : []));
            const moves = game.getCurrentMoves();
            const k = Math.floor(random() * (hidden.length + moves.length));
            if (k < hidden.length) return game.onCellClick(hidden[k]);
            const move = moves[k - hidden.length];
            game.selectedSq = move >> 5;
            game.onCellClick(move & 31);
        },
        next: game => game.startNextRound(),
        restart: game => game.resetFullMatch(),
        undo: game => game.undo(),
        log: record => record.moves,
        human: entry => entry.seat === 'south',
        number: record => record.round,
        state: game => ({ board: [...game.state.board], winner: game.result && game.result.winner }),
        replay(record, final) {
            const { replay } = require('./banqi/replay.cjs'), { snapshot } = require('./banqi/harness.cjs');
            assert.equal(record.format, 'banqi-public-v1');
            const played = replay(record);
            assert.equal(snapshot(played.st), JSON.stringify({ b: record.state.board, p: record.state.pool,
                a: record.state.alive, h: record.state.hidden, q: record.state.quiet }));
            assert.deepEqual([...played.st.board], final.board);
            if (record.finished) assert.equal(record.result.winner, final.winner);
            assert.deepEqual(Object.keys(record.players), ['south', 'north']);
            assert.deepEqual([record.players.south.ai, record.players.north.ai], [false, true]);
        }
    },

    xiangqi: {
        setup: ({ game }) => { game.sound.enabled = false; game.setSetting('difficulty', 'easy'); },
        over: game => game.gameOver,
        ready: game => game.isHumanTurn(),
        hint: game => { game.showHint(); return true; },
        act({ game, pick }) {
            const move = pick(game.legalMovesNow());
            game.selectedSq = move >> 7;
            game.onSquareClick(move & 127);
        },
        next: game => game.startNextRound(),
        restart: game => game.resetFullMatch(),
        undo: game => game.undo(),
        log: record => record.moves,
        human: (entry, record) => entry.color === record.players.south.color,
        number: record => record.round,
        state: game => ({ board: [...game.board], winner: game.result && game.result.winnerSeat }),
        replay(record, final, env) {
            const board = [...env.api('Engine.createState().board')];
            record.moves.forEach((move, i) => {
                assert.equal(move.ply, i + 1);
                assert.equal(move.color, i % 2);    // red moves first
                assert.equal(board[move.from], (move.color << 4) | move.kind, `ply ${move.ply} moves another piece`);
                const taken = board[move.to];
                assert.deepEqual(move.captured, taken ? { color: taken >> 4, kind: taken & 15 } : null);
                if (taken) assert.notEqual(taken >> 4, move.color);
                board[move.to] = board[move.from];
                board[move.from] = 0;
                assert.equal(typeof move.text, 'string');
            });
            assert.deepEqual(board, final.board);
            assert.deepEqual(sorted([record.players.south.color, record.players.north.color]), [0, 1]);
            if (record.finished) assert.equal(record.result.winnerSeat, final.winner);
        }
    },

    reversi: {
        setup: ({ game }) => { game.sound.enabled = false; game.setSetting('difficulty', 'easy'); },
        over: game => game.gameOver,
        ready: game => game.isHumanTurn(),
        hint: game => { game.showHint(); return true; },
        act: ({ game, pick, api }) => game.onCellClick(pick(api('Engine').legalMoves(game.board, game.PLAYERS[game.turn].color))),
        next: game => game.startNextRound(),
        restart: game => game.resetFullMatch(),
        undo: game => game.undo(),
        log: record => record.moves.filter(entry => !entry.pass),
        human: entry => entry.seat === 'south',
        number: record => record.round,
        state: game => ({ board: [...game.board] }),
        replay(record, final, env) {
            const board = [...env.api('Engine.createBoard()')];
            const flipsOf = (sq, color) => {    // an independent copy of the rule: runs of the other colour closed by one's own
                const found = [];
                for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
                    const run = [];
                    let r = (sq >> 3) + dr, c = (sq & 7) + dc;
                    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === 3 - color) { run.push(r * 8 + c); r += dr; c += dc; }
                    if (run.length && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === color) found.push(...run);
                }
                return found;
            };
            const canMove = color => board.some((p, sq) => p === 0 && flipsOf(sq, color).length);
            let n = 0;
            for (const entry of record.moves) {
                assert.equal(record.players[entry.seat].color, entry.color);
                if (entry.pass) { assert.ok(!canMove(entry.color), 'a pass is recorded although a move exists'); continue; }
                assert.equal(entry.n, ++n);
                assert.equal(board[entry.sq], 0);
                const flips = flipsOf(entry.sq, entry.color);
                assert.equal(flips.length, entry.flips);
                assert.ok(flips.length > 0);
                for (const sq of [entry.sq, ...flips]) board[sq] = entry.color;
            }
            assert.deepEqual(board, final.board);
            if (record.finished) {
                assert.equal(record.result.black, board.filter(p => p === 1).length);
                assert.equal(record.result.white, board.filter(p => p === 2).length);
                assert.ok(!canMove(1) && !canMove(2));
            }
        }
    },

    gongzhu: {
        setup: ({ game, api }) => { game.sound.enabled = false; Object.assign(api('GongZhuAI'), { MIN_SAMPLES: 2, MAX_SAMPLES: 2 }); },
        over: game => game.roundOver,
        ready: game => !game.isProcessingTrick && game.currentTurn === 'south' && game.PLAYERS.south.hand.length > 0,
        hint: game => { game.showHint(); return true; },
        act: ({ game, pick }) => game.onPlayerCardClick(pick(game.getLegalCards('south')).id),
        next: game => game.startNextRound(),
        restart: game => game.resetFullMatch(),
        undo: game => game.undo(),
        log: record => record.tricks.flat(),
        human: entry => entry.seat === 'south',
        number: record => record.round,
        state: game => ({
            hands: Object.fromEntries(game.SEAT_ORDER.map(seat => [seat, sorted(game.PLAYERS[seat].hand.map(c => c.id))])),
            totals: Object.fromEntries(game.SEAT_ORDER.map(seat => [seat, game.PLAYERS[seat].totalScore]))
        }),
        replay(record, final) {
            const seats = record.seats, suit = id => id[0], rank = id => Number(id.slice(1));
            assert.deepEqual(seats, ['south', 'west', 'north', 'east']);
            assert.equal(record.settings.scoringRuleMode, 'player_special');
            const hands = Object.fromEntries(seats.map(seat => [seat, record.hands[seat].slice()]));
            assert.equal(new Set(seats.flatMap(seat => hands[seat])).size, 52);
            seats.forEach(seat => assert.equal(hands[seat].length, 13));
            const scoring = id => suit(id) === 'H' || ['S12', 'D11', 'C10'].includes(id);
            const captured = Object.fromEntries(seats.map(seat => [seat, []]));
            let leader = seats.find(seat => hands[seat].includes('S7'));
            record.tricks.forEach((trick, t) => {
                assert.ok(trick.length === 4 || (!record.finished && t === record.tricks.length - 1));
                trick.forEach((play, i) => {
                    assert.equal(play.seat, seats[(seats.indexOf(leader) + i) % 4], `trick ${t + 1} is out of turn`);
                    const hand = hands[play.seat];
                    assert.ok(hand.includes(play.card), `${play.seat} plays ${play.card} without holding it`);
                    if (i > 0 && suit(play.card) !== suit(trick[0].card)) {
                        assert.ok(!hand.some(id => suit(id) === suit(trick[0].card)), `${play.seat} fails to follow suit`);
                    }
                    hand.splice(hand.indexOf(play.card), 1);
                    if (play.hint !== undefined) assert.ok(play.hint === true && play.seat === 'south');
                });
                if (trick.length < 4) return;
                const winner = trick.filter(p => suit(p.card) === suit(trick[0].card)).sort((a, b) => rank(b.card) - rank(a.card))[0];
                captured[winner.seat].push(...trick.map(p => p.card).filter(scoring));
                leader = winner.seat;
            });
            seats.forEach(seat => assert.deepEqual(sorted(hands[seat]), final.hands[seat]));
            if (!record.finished) return assert.equal(record.result, null);
            assert.equal(record.tricks.length, 13);
            let sum = 0;
            for (const seat of seats) {
                assert.deepEqual(sorted(record.result[seat].captured), sorted(captured[seat]));
                assert.equal(record.totals[seat] + record.result[seat].score, final.totals[seat]);
                sum += record.result[seat].captured.length;
            }
            assert.equal(sum, 16);
        }
    },

    bigtwo: {
        setup: ({ game }) => { game.soundOn = false; },
        over: game => game.round.over,
        ready: game => game.round.turn === 0 && !game.round.passed[0],
        hint: game => { game.hint(); return game.hintKey !== ''; },    // no suggestion when nothing can beat the table
        act({ game, random, pick, api }) {
            const round = game.round, moves = api('BigTwo').legalMoves(round.hands[0], round.lastPlay, round.opening);
            if (!moves.length || (round.lastPlay && random() < 0.3)) return game.pass();
            game.selected = new Set(pick(moves).cards.map(card => card.id));
            game.playSelected();
        },
        next: game => game.nextRound(),
        restart: game => { game.closeDialog(); game.newRound(); },    // what the 重新開始 confirmation does
        undo: game => game.undo(),
        log: record => record.actions,
        human: entry => entry.seat === 0,
        number: record => record.round,
        state: game => ({ hands: game.round.hands.map(hand => sorted(hand.map(c => c.id))), totals: game.stats.totals.slice() }),
        replay(record, final) {
            const hands = record.hands.map(hand => hand.slice());
            assert.equal(new Set(hands.flat()).size, 52);
            hands.forEach(hand => assert.equal(hand.length, 13));
            assert.deepEqual(record.players.map(p => p.ai), [false, true, true, true]);
            let turn = hands.findIndex(hand => hand.includes('C3')), passed = [false, false, false, false], last = null;
            record.actions.forEach((action, i) => {
                assert.equal(action.seat, turn, `action ${i + 1} is out of turn`);
                if (action.pass) {
                    assert.ok(last !== null, 'a pass is recorded on a free lead');
                    passed[turn] = true;
                } else {
                    assert.ok([1, 2, 5, 13].includes(action.cards.length));
                    if (i === 0) assert.ok(action.cards.includes('C3'));
                    for (const id of action.cards) {
                        assert.ok(hands[turn].includes(id), `seat ${turn} plays ${id} without holding it`);
                        hands[turn].splice(hands[turn].indexOf(id), 1);
                    }
                    assert.equal(typeof action.type, 'string');
                    last = turn;
                }
                if (action.hint !== undefined) assert.ok(action.hint === true && action.seat === 0);
                if (!hands[turn].length) return;
                if (passed.filter(Boolean).length === 3) {    // everyone else passed: the last player leads freely
                    passed = [false, false, false, false];
                    turn = last;
                    last = null;
                } else {
                    do turn = (turn + 1) % 4; while (passed[turn]);
                }
            });
            assert.deepEqual(hands.map(sorted), final.hands);
            if (!record.finished) return assert.equal(record.result, null);
            const { winner, deltas, remaining, left } = record.result;
            assert.equal(hands[winner].length, 0);
            assert.deepEqual(left.map(sorted), final.hands);
            assert.deepEqual(remaining, hands.map(hand => hand.length));
            const owed = remaining.map(n => n * (n === 13 ? 3 : n >= 10 ? 2 : 1));
            assert.deepEqual(deltas, owed.map((n, seat) => (seat === winner ? owed.reduce((a, b) => a + b, 0) : -n)));
            assert.deepEqual(record.totals.map((n, seat) => n + deltas[seat]), final.totals);
        }
    },

    mahjong: {
        setup({ game }) {
            game.sound.enabled = false;
            game.settings.discardMode = 'single';
            // The stronger computers weigh every useful tile for every discard, which takes most of a second per hand;
            // drawing the table recomputes the waiting tiles on each change. Neither matters to what gets recorded.
            game.setSetting('difficulty', 'easy');
            for (const method of ['render', 'renderHand', 'renderActions', 'openResultModal']) game[method] = () => {};
        },
        over: game => game.phase === 'end',
        ready: game => !game.autoWin && ((game.phase === 'turn' && game.turn === 0)
            || (game.phase === 'claim' && game.claim && !!game.claim.humanOpt) || game.phase === 'rob'),
        hint: game => { game.showHint(); return game.hintShown; },    // no suggestion while deciding whether to rob a kong
        act({ game, random, pick, api, manual }) {
            if (game.phase === 'rob') return game.humanRob(random() < 0.5);
            if (game.phase === 'claim') {
                const option = game.claim.humanOpt, choices = [['pass']];
                if (option.win) choices.push(['win'], ['win'], ['win']);
                if (option.kong) choices.push(['kong']);
                if (option.pung) choices.push(['pung']);
                option.chows.forEach((_, i) => choices.push(['chow', i]));
                return game.humanClaim(...pick(choices));
            }
            const options = game.selfOptions(0);
            if (options.win && random() < 0.9) return game.humanSelfWin();
            if (options.kongs.length && random() < 0.7) {
                const kong = pick(options.kongs);
                return game.humanKong(kong.kind, kong.tile);
            }
            if (!manual && game.tingWaits().length && random() < 0.5) return game.toggleAutoWin();
            // Mostly a tile the computers would play, so that hands get somewhere; sometimes any tile.
            const tiles = game.handDisplayOrder();
            const tile = random() < 0.8 ? api('MahjongAI').chooseDiscard(game, 0, 'easy') : pick(tiles);
            game.onHandTileClick(tiles.lastIndexOf(tile));
        },
        next: game => game.nextHand(),
        restart: game => game.resetMatch(),
        undo: game => game.undo(),
        log: record => record.actions.filter(e => e.a !== 'draw' && e.a !== 'flower'),
        human: entry => entry.s === 0,
        number: record => record.round,
        state: game => ({
            players: game.players.map(p => ({
                hand: sorted(p.hand), flowers: sorted(p.flowers), discards: p.discards.slice(),
                melds: p.melds.map(m => ({ type: m.type, tiles: sorted(m.tiles), concealed: !!m.concealed })), score: p.score
            }))
        }),
        replay(record, final) {
            const { wall, dealer, actions, result } = record;
            // The wall holds every tile once, and the deal comes off its front: four tiles at a time, the dealer first.
            assert.deepEqual(sorted(wall), sorted([...Array(34).keys()].flatMap(t => [t, t, t, t]).concat([34, 35, 36, 37, 38, 39, 40, 41])));
            const dealt = [[], [], [], []];
            let head = 0, tail = wall.length - 1;
            for (let pass = 0; pass < 4; pass++) for (let k = 0; k < 4; k++) for (let n = 0; n < 4; n++) dealt[(dealer + k) % 4].push(wall[head++]);
            assert.deepEqual(record.dealt.map(sorted), dealt.map(sorted));

            const seats = record.dealt.map(hand => ({ hand: hand.slice(), flowers: [], discards: [], melds: [] }));
            const take = (seat, tile, where) => {
                const i = seats[seat].hand.indexOf(tile);
                assert.ok(i >= 0, `${where}: seat ${seat} does not hold tile ${tile}`);
                seats[seat].hand.splice(i, 1);
            };
            actions.forEach((e, i) => {
                const where = `action ${i + 1} (${e.a})`, me = seats[e.s];
                assert.ok(me, where);
                if (e.auto !== undefined || e.hint !== undefined) assert.equal(e.s, 0, `${where}: only the player's own decisions are marked`);
                if (e.a === 'draw') {
                    assert.equal(e.t, e.back ? wall[tail--] : wall[head++], `${where}: not the next tile of the wall`);
                    me.hand.push(e.t);
                } else if (e.a === 'flower') {
                    assert.ok(e.t >= 34);
                    take(e.s, e.t, where);
                    me.flowers.push(e.t);
                } else if (e.a === 'discard') {
                    take(e.s, e.t, where);
                    me.discards.push(e.t);
                } else if (e.a === 'chow' || e.a === 'pung' || e.a === 'kong') {
                    assert.equal(seats[e.from].discards.pop(), e.t, `${where}: the tile was not the last discard`);
                    const own = e.a === 'chow' ? e.using : Array(e.a === 'kong' ? 3 : 2).fill(e.t);
                    if (e.a === 'chow') {
                        assert.equal(e.s, (e.from + 1) % 4, `${where}: only the next player may chow`);
                        const run = sorted([...own, e.t]);
                        assert.ok(run[2] < 27 && run[1] === run[0] + 1 && run[2] === run[0] + 2 && Math.floor(run[0] / 9) === Math.floor(run[2] / 9));
                    }
                    own.forEach(tile => take(e.s, tile, where));
                    me.melds.push({ type: e.a, tiles: sorted([...own, e.t]), concealed: false });
                } else if (e.a === 'concealedKong') {
                    for (let k = 0; k < 4; k++) take(e.s, e.t, where);
                    me.melds.push({ type: 'kong', tiles: [e.t, e.t, e.t, e.t], concealed: true });
                } else if (e.a === 'addedKong') {
                    take(e.s, e.t, where);
                    const pung = me.melds.find(m => m.type === 'pung' && m.tiles[0] === e.t);
                    assert.ok(pung, `${where}: no pung to add to`);
                    if (e.robbed) assert.ok(result && result.type === 'win' && i === actions.length - 1);
                    else { pung.type = 'kong'; pung.tiles.push(e.t); }
                } else {
                    assert.equal(e.a, 'pass', where);
                    assert.equal(e.s, 0);
                    const last = actions[i - 1];
                    if (!e.rob) assert.deepEqual([last.a, last.s, last.t], ['discard', e.from, e.t], `${where}: nothing was offered`);
                }
            });
            if (result && result.type === 'win' && !result.selfDraw && result.winTile != null) {
                // The winning tile leaves the discarder's river (or was robbed from a kong) and joins each winner's hand.
                const robbed = actions.length && actions[actions.length - 1].robbed;
                if (!robbed) assert.equal(seats[result.payer].discards.pop(), result.winTile);
                result.winners.forEach(w => seats[w.seat].hand.push(result.winTile));
            }
            seats.forEach((seat, i) => {
                const p = final.players[i], where = `seat ${i}`;
                assert.deepEqual(sorted(seat.hand), p.hand, `${where} hand`);
                assert.deepEqual(sorted(seat.flowers), p.flowers, `${where} flowers`);
                assert.deepEqual(seat.discards, p.discards, `${where} discards`);
                assert.deepEqual(seat.melds, p.melds, `${where} melds`);
                // Sixteen tiles, counting a kong as three; one more while holding a drawn, claimed or winning tile.
                assert.ok([16, 17].includes(seat.hand.length + 3 * seat.melds.length), `${where} tile count`);
            });
            assert.deepEqual(record.players.map(p => sorted(p.hand)), final.players.map(p => p.hand));
            assert.deepEqual(record.players.map(p => p.ai), [false, true, true, true]);
            assert.deepEqual(sorted(record.players.map(p => p.wind)), [0, 1, 2, 3]);
            assert.equal(record.players[dealer].wind, 0);
            if (!result) return;
            assert.deepEqual(record.players.map((p, i) => p.score + result.delta[i]), final.players.map(p => p.score));
            assert.deepEqual(result.totals, final.players.map(p => p.score));
            assert.equal(result.delta.reduce((a, b) => a + b, 0), 0);
            if (result.type === 'draw') return assert.deepEqual(result.delta, [0, 0, 0, 0]);
            assert.ok(result.winners.length >= 1);
            result.winners.forEach(w => {
                assert.ok(result.delta[w.seat] > 0);
                assert.equal(w.items.reduce((sum, item) => sum + item.tai, 0), w.tai);
            });
        }
    }
};

// Some checks need a deal in which the round lasts a few moves and a suggestion is available each time.
// Such a check calls suits(false) when the deal at hand is no good, and is then tried on the next deal.
class Unsuitable extends Error {}
const suits = ok => { if (!ok) throw new Unsuitable(); };
function onFirstSuitableDeal(scenario) {
    for (let seed = 1; seed <= 20; seed++) {
        try {
            return scenario(seed);
        } catch (error) {
            if (!(error instanceof Unsuitable)) throw error;
        }
    }
    assert.fail('none of twenty deals let the check run');
}

const GAMES = ['banqi', 'xiangqi', 'reversi', 'gongzhu', 'bigtwo', 'mahjong', 'mahjong-me'];
const ROUNDS = { banqi: 2, xiangqi: 2, reversi: 3, gongzhu: 3, bigtwo: 4, mahjong: 5, 'mahjong-me': 5 };

for (const name of GAMES) {
    test(`${name}: every finished round is recorded once and replays from its own record`, () => {
        const env = open(name, 3);
        for (let round = 1; round <= ROUNDS[name]; round++) {
            playRound(env);
            assert.equal(env.recorder.rounds.length, round, 'one record per finished round');
            assert.equal(env.recorder.begun, round, 'one begin() per round');
            assert.equal(env.recorder.peek(), null, 'a finished round is closed: nothing more is saved for it');
            const record = env.recorder.rounds[round - 1];
            assert.equal(record.finished, true);
            assert.equal(env.driver.number(record), round);
            assert.ok(record.result, 'a finished round has a result');
            env.driver.replay(record, stateOf(env), env);
            env.driver.next(env.game);
        }
        const decisions = env.recorder.rounds.flatMap(record => env.driver.log(record).map(entry => [entry, record]));
        const human = decisions.filter(([entry, record]) => env.driver.human(entry, record));
        assert.ok(human.length > 5, 'the player made decisions');
        assert.ok(human.some(([entry]) => entry.hint === true), 'some decisions followed the hint button');
        assert.ok(human.some(([entry]) => entry.hint === undefined), 'some decisions did not');
        for (const [entry, record] of decisions) {
            if (!env.driver.human(entry, record)) assert.equal(entry.hint, undefined, 'the computers never carry the mark');
        }
    });

    test(`${name}: an unfinished round is kept when the player leaves or restarts, and replays too`, () => onFirstSuitableDeal(seed => {
        const env = open(name, seed);
        suits(wait(env));
        assert.equal(env.recorder.peek(), null, 'nothing to save before the player has done anything');
        playRound(env, 0);
        env.driver.next(env.game);    // give up the second round, so that a restart has scores and a round number to wipe
        suits(wait(env));
        assert.equal(env.recorder.peek(), null, 'nor at the start of a later round');
        for (let i = 0; i < 4; i++) {
            env.driver.act(env);
            suits(wait(env));
        }
        const left = env.recorder.peek();
        assert.ok(left, 'leaving the page saves the round so far');
        assert.equal(left.finished, false);
        assert.equal(left.result, null);
        assert.equal(env.driver.number(left), 2);
        env.driver.replay(left, stateOf(env), env);
        assert.equal(env.recorder.rounds.length, 1);

        env.driver.restart(env.game);
        assert.equal(env.recorder.rounds.length, 2, 'restarting keeps the round that was given up');
        assert.deepEqual(env.recorder.rounds[1], left, 'as it stood before the restart');
        assert.equal(env.recorder.begun, 3);
        assert.ok(wait(env));
        assert.equal(env.recorder.peek(), null, 'the new round starts empty');
        playRound(env, 0);
        assert.equal(env.recorder.rounds.length, 3);
        assert.equal(env.recorder.rounds[2].finished, true);
        env.driver.replay(env.recorder.rounds[2], stateOf(env), env);
    }));

    test(`${name}: only a decision made right after the hint button is marked, and taking a move back leaves no trace`, () => onFirstSuitableDeal(seed => {
        const env = open(name, seed);
        env.manual = true;
        const mine = () => {
            const record = env.recorder.peek();
            return record ? env.driver.log(record).filter(entry => env.driver.human(entry, record)) : [];
        };
        const going = () => suits(wait(env));
        going();
        suits(env.driver.hint(env.game));
        env.driver.act(env);
        going();
        assert.deepEqual(mine().map(entry => entry.hint), [true]);
        env.driver.act(env);
        going();
        assert.deepEqual(mine().map(entry => entry.hint), [true, undefined]);

        const before = env.recorder.peek(), state = stateOf(env);
        suits(env.driver.hint(env.game));
        env.driver.act(env);
        going();
        assert.deepEqual(mine().map(entry => entry.hint), [true, undefined, true]);
        env.driver.undo(env.game);
        going();
        assert.deepEqual(stateOf(env), state, 'the move is taken back');
        assert.deepEqual(env.recorder.peek(), before, 'and so is its record');
        env.driver.act(env);    // the hint asked for before the move was taken back no longer counts
        going();
        assert.deepEqual(mine().map(entry => entry.hint), [true, undefined, undefined]);
    }));
}

test('bigtwo: a pass that hands the lead back keeps its hint mark', () => {
    // The third pass in a row also resets the trick; the mark belongs on the pass, not on that reset.
    for (let seed = 1; seed <= 30; seed++) {
        const env = open('bigtwo', seed);
        while (wait(env)) {
            const round = env.game.round;
            if (round.lastPlay && round.passes === 2 && env.driver.hint(env.game)) {
                env.game.pass();
                const actions = env.recorder.peek().actions;
                assert.deepEqual(actions[actions.length - 1], { seat: 0, pass: true, hint: true });
                assert.equal(env.game.round.lastPlay, null, 'the trick was reset');
                return;
            }
            env.driver.act(env);
        }
    }
    assert.fail('the player was never the third to pass with a playable hand');
});

// Endings that random play almost never reaches are set up by hand (so these hands are not replayed from the deal).
for (const name of ['mahjong', 'mahjong-me']) {
    test(`${name}: robbing a kong, and declining to, are both recorded`, () => {
        const X = 0, waitingOnX = [1, 2, 9, 10, 11, 12, 13, 14, 18, 19, 20, 21, 22, 23, 27, 27];
        const arrange = () => {
            const env = open(name, 1);
            assert.ok(wait(env));
            const game = env.game;
            game.players[0].hand = waitingOnX.slice();
            game.players[1].melds = [{ type: 'pung', tiles: [X, X, X], concealed: false, from: 2, claimed: X }];
            game.players[1].hand = [X, 3, 4, 5, 6, 7, 8, 15, 16, 17, 24, 25, 26, 28];
            for (const seat of [2, 3]) game.players[seat].hand = [28, 28, 29, 29, 30, 30, 31, 31, 32, 32, 33, 33, 5, 7, 15, 17];
            Object.assign(game, { turn: 1, phase: 'turn', turnFlags: { drew: true } });
            game.declareKong(1, 'added', X);    // what the computer does when it adds the fourth tile to its pung
            assert.equal(game.phase, 'rob');
            return env;
        };

        let env = arrange(), game = env.game, logged = game.actionLog.length;
        game.humanRob(false);
        assert.deepEqual(clone(game.actionLog.slice(logged)), [{ s: 0, a: 'pass', t: X, from: 1, rob: true }, { s: 1, a: 'addedKong', t: X }]);
        assert.deepEqual(clone(game.players[1].melds[0].tiles), [X, X, X, X]);
        game.undo();    // back to the choice; neither entry stays
        assert.equal(game.phase, 'rob');
        assert.equal(game.actionLog.length, logged);

        game.humanRob(true);
        assert.equal(game.phase, 'end');
        const record = env.recorder.rounds[env.recorder.rounds.length - 1];
        assert.deepEqual(record.actions[record.actions.length - 1], { s: 1, a: 'addedKong', t: X, robbed: true });
        assert.equal(record.finished, true);
        assert.deepEqual([record.result.type, record.result.payer, record.result.selfDraw, record.result.winTile], ['win', 1, false, X]);
        assert.deepEqual(record.result.winners.map(w => w.seat), [0]);
        assert.ok(record.result.winners[0].items.some(item => item.name.includes('搶槓')));
        assert.deepEqual(clone(game.players[1].melds[0].tiles), [X, X, X], 'the kong never happened');
        assert.ok(record.players[0].hand.includes(X));

        // With 自動胡牌 on the player robs without being asked; that is a win, not a decision, so nothing is marked.
        env = arrange();
        env.game.phase = 'turn';
        env.game.autoWin = true;
        env.game.declareKong(1, 'added', X);
        assert.equal(env.game.phase, 'end');
        const automatic = env.recorder.rounds[env.recorder.rounds.length - 1];
        assert.deepEqual(automatic.actions[automatic.actions.length - 1], { s: 1, a: 'addedKong', t: X, robbed: true });
    });

    test(`${name}: hands won on flowers alone are recorded`, () => {
        const seven = [34, 35, 36, 37, 38, 39, 40];
        for (const [holder, special, payer] of [[0, '八仙過海', null], [2, '七搶一', 0]]) {
            if (name === 'mahjong-me' && holder !== 0 && payer !== 0) continue;
            const env = open(name, 1);
            assert.ok(wait(env));
            const game = env.game;
            game.players.forEach(p => { p.flowers = p.seat === holder ? seven.slice() : []; });
            assert.equal(game.revealFlower(0, 41), false, 'the hand ends');
            const record = env.recorder.rounds[0];
            assert.deepEqual(record.actions[record.actions.length - 1], { s: 0, a: 'flower', t: 41 });
            assert.deepEqual(record.result.winners, [{ seat: holder, tai: 8, items: [{ name: special, tai: 8 }] }]);
            assert.deepEqual([record.result.special, record.result.payer, record.result.selfDraw, record.result.winTile],
                [special, payer, payer === null, null]);
            assert.equal(record.result.delta.reduce((a, b) => a + b, 0), 0);
            assert.ok(record.result.delta[holder] > 0);
        }
    });
}

for (const name of ['mahjong', 'mahjong-me']) {
    test(`${name}: tiles played by 自動胡牌 are marked auto, and declined claims are recorded`, () => {
        let auto = 0, passes = 0, robs = 0, kongs = 0, flowers = 0, claims = 0;
        for (const seed of [2, 4, 6]) {
            const env = open(name, seed);
            for (let hand = 0; hand < 8; hand++) {
                playRound(env, 0);
                env.driver.replay(env.recorder.rounds[hand], stateOf(env), env);
                env.driver.next(env.game);
            }
            for (const record of env.recorder.rounds) {
                for (const e of record.actions) {
                    if (e.auto) { auto++; assert.equal(e.a, 'discard'); assert.equal(e.hint, undefined); }
                    if (e.a === 'pass') e.rob ? robs++ : passes++;
                    if (e.a === 'concealedKong' || e.a === 'addedKong' || e.a === 'kong') kongs++;
                    if (e.a === 'flower') flowers++;
                    if (e.s === 0 && (e.a === 'chow' || e.a === 'pung')) claims++;
                }
            }
        }
        assert.ok(auto > 0, 'no automatic discard was played');
        assert.ok(passes > 0, 'no declined claim was recorded');
        assert.ok(claims > 0 && kongs > 0 && flowers > 0, 'claims, kongs and flowers all occur');
    });
}

// train_gpu.py learns from these records, so it has to understand whatever a page records. A few rounds are
// played on every real page, stored the way the server stores them, and handed to the trainer's own tests
// (the PageRecords part of tests/test_train_gpu.py): every round must be readable, every decision of the
// player found, and nothing a player cannot see may reach what the model is shown.
test('train_gpu.py reads the rounds of every game', () => {
    const os = require('node:os'), { spawnSync } = require('node:child_process');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'game-records-'));
    try {
        let serial = 0;
        const store = (name, { finished, ...round }) => {
            const id = `20261120-${String(120000 + serial).padStart(6, '0')}-${(serial++).toString(36).padStart(6, '0')}`;
            const saved = { game: name, id, status: finished ? 'finished' : 'unfinished', ip: '127.0.0.1', ua: 'node', ...round };
            fs.mkdirSync(path.join(folder, name, '2026-11'), { recursive: true });
            fs.writeFileSync(path.join(folder, name, '2026-11', `${id}.json`), JSON.stringify(saved));
        };
        for (const name of GAMES) {
            const env = open(name, 11);
            for (let round = 0; round < 3; round++) {
                playRound(env);
                store(name, env.recorder.rounds[round]);
                env.driver.next(env.game);
            }
            // ... and a round the player walks away from after a few moves.
            let left = null;
            for (let tries = 0; !left; tries++) {
                assert.ok(tries < 10, `${name}: no round lasts a few moves`);
                for (let moves = 0; moves < 5 && wait(env); moves++) env.driver.act(env);
                left = env.recorder.peek();
                if (!left) env.driver.next(env.game);
            }
            store(name, left);
        }
        const run = spawnSync('python3', [path.join(ROOT, 'tests', 'test_train_gpu.py'), 'PageRecords'],
            { env: { ...process.env, TRAIN_GPU_RECORDS: folder }, encoding: 'utf8' });
        assert.equal(run.status, 0, `tests/test_train_gpu.py PageRecords failed:\n${run.stdout}${run.stderr}`);
        assert.match(run.stderr, /Ran [1-9]\d* tests/);
        assert.doesNotMatch(run.stderr, /skipped/, 'the page checks really ran');
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
