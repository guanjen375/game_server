'use strict';
// Optional check of the automatic recording in a real browser. Every game is played through the server:
// rounds are finished, left half-way (back to the lobby, a reload, the game's own restart) and taken back,
// and each file that lands in the data folder is compared with what the game handed over. A last part
// takes the server away while rounds end, and checks that they arrive once it is back.
//
//   node tests/records-browser-check.cjs [game ...]          against a private copy of the server, in a temporary
//                                                             folder and on a spare port; gaming_data/ is not touched
//   node tests/records-browser-check.cjs --live [game ...]   against the server running from this directory;
//                                                             the records the check creates there are deleted again
//
// Puppeteer and Chrome are test tools, not something the games need: point GAME_PUPPETEER at an existing
// puppeteer installation and GAME_CHROME at a Chrome binary when they are not found by default.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createHash } = require('node:crypto');
const puppeteer = require(process.env.GAME_PUPPETEER || process.env.BANQI_PUPPETEER || 'puppeteer');
const CHROME = process.env.GAME_CHROME || process.env.BANQI_CHROME || undefined;
const ROOT = path.resolve(__dirname, '..');
const LIVE = process.argv.includes('--live');
const ONLY = process.argv.slice(2).filter(arg => arg !== '--live');
let PROJECT, HOST, PORT, BASE, DATA;    // where the served files are, where the server listens and where it saves
const ENVELOPE = ['game', 'id', 'status', 'started', 'ended', 'saved', 'ip', 'ua', 'session', 'seq', 'build'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const problems = [];

let server = null, serverLog = '';
function startServer() {
    server = spawn('python3', ['-u', path.join(PROJECT, 'open_server.py'), 'run', '--host', '127.0.0.1', '--port', String(PORT), '--data-dir', DATA]);
    server.stdout.on('data', chunk => { serverLog += chunk; });
    server.stderr.on('data', chunk => { serverLog += chunk; });
    return waitFor(() => serverLog.includes('遊戲伺服器已啟動') && fetch(BASE + '/').then(r => r.ok, () => false), 'server start');
}
async function stopServer() {
    const gone = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await gone;
    serverLog = '';
}
async function waitFor(check, what, ms = 15000) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
}
function files() {
    const found = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push(path.relative(DATA, full));
        }
    };
    if (fs.existsSync(DATA)) walk(DATA);
    return found.sort();
}
const read = name => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));

// Runs inside every page before anything else: speeds the games up and notes what each one hands to the recorder.
function instrument() {
    const realTimeout = window.setTimeout;
    window.__sleep = ms => new Promise(resolve => realTimeout(resolve, ms));
    window.setTimeout = (fn, delay, ...rest) => realTimeout(fn, (delay || 0) / 30, ...rest);
    let fakeNow = Date.now(), fakePerf = 0;
    Date.now = () => (fakeNow += 40);            // the card computers stop sampling once their time budget is "spent"
    performance.now = () => (fakePerf += 50);    // and so do the board computers
    window.__ended = [];
    let recorder, snapshot = null;
    Object.defineProperty(window, 'GameRecorder', {
        get: () => recorder,
        set(real) {
            recorder = {
                begin(fn) { snapshot = fn; real.begin(fn); },
                end() {
                    if (snapshot) { const record = snapshot(); if (record) window.__ended.push(JSON.stringify(record)); }
                    snapshot = null;
                    real.end();
                },
                peek: () => (snapshot ? snapshot() : null)
            };
        }
    });
}

// How to play each game from inside its page: is it the player's turn, make one move, is the round over, and so on.
const DRIVERS = {
    banqi: () => ({
        setup() { game.sound.enabled = false; },
        over: () => game.gameOver, ready: () => game.isHumanTurn(), hint: () => game.showHint(),
        act() {
            const hidden = [...game.state.board].flatMap((p, sq) => (p === 15 ? [sq] : [])), moves = game.getCurrentMoves();
            const k = Math.floor(Math.random() * (hidden.length + moves.length));
            if (k < hidden.length) return game.onCellClick(hidden[k]);
            game.selectedSq = moves[k - hidden.length] >> 5;
            game.onCellClick(moves[k - hidden.length] & 31);
        },
        next: () => game.startNextRound(), restart: () => { game.confirmRestartMatch(); game.resetFullMatch(); }, undo: () => game.undo()
    }),
    xiangqi: () => ({
        setup() { game.sound.enabled = false; },
        over: () => game.gameOver, ready: () => game.isHumanTurn(), hint: () => game.showHint(),
        act() {
            const moves = game.legalMovesNow(), move = moves[Math.floor(Math.random() * moves.length)];
            game.selectedSq = move >> 7;
            game.onSquareClick(move & 127);
        },
        next: () => game.startNextRound(), restart: () => { game.confirmRestartMatch(); game.resetFullMatch(); }, undo: () => game.undo()
    }),
    reversi: () => ({
        setup() { game.sound.enabled = false; },
        over: () => game.gameOver, ready: () => game.isHumanTurn(), hint: () => game.showHint(),
        act() {
            const moves = Engine.legalMoves(game.board, game.PLAYERS[game.turn].color);
            game.onCellClick(moves[Math.floor(Math.random() * moves.length)]);
        },
        next: () => game.startNextRound(), restart: () => { game.confirmRestartMatch(); game.resetFullMatch(); }, undo: () => game.undo()
    }),
    gongzhu: () => ({
        setup() { game.sound.enabled = false; },
        over: () => game.roundOver,
        ready: () => !game.isProcessingTrick && game.currentTurn === 'south' && game.PLAYERS.south.hand.length > 0,
        hint: () => game.showHint(),
        act() {
            const legal = game.getLegalCards('south');
            game.onPlayerCardClick(legal[Math.floor(Math.random() * legal.length)].id);
        },
        next: () => game.startNextRound(), restart: () => { game.confirmRestartMatch(); game.resetFullMatch(); }, undo: () => game.undo()
    }),
    bigtwo: () => ({
        setup() { game.soundOn = false; },
        over: () => game.round.over, ready: () => !game.modal && game.round.turn === 0 && !game.round.passed[0],
        hint: () => game.hint(),
        act() {
            const round = game.round, moves = BigTwo.legalMoves(round.hands[0], round.lastPlay, round.opening);
            if (!moves.length || (round.lastPlay && Math.random() < 0.3)) return document.getElementById('passBtn').click();
            document.getElementById('clearBtn').click();
            for (const card of moves[Math.floor(Math.random() * moves.length)].cards) document.querySelector(`#hand .card[data-card="${card.id}"]`).click();
            document.getElementById('playBtn').click();
        },
        next: () => document.getElementById('nextBtn').click(),
        restart: () => { document.getElementById('restartBtn').click(); document.getElementById('confirmRestartBtn').click(); },
        undo: () => document.getElementById('undoBtn').click()
    }),
    mahjong: () => ({
        setup() { game.sound.enabled = false; game.settings.discardMode = 'single'; game.settings.difficulty = 'easy'; },
        over: () => game.phase === 'end',
        ready: () => !game.autoWin && ((game.phase === 'turn' && game.turn === 0)
            || (game.phase === 'claim' && game.claim && !!game.claim.humanOpt) || game.phase === 'rob'),
        hint: () => game.showHint(),
        act() {
            const pick = list => list[Math.floor(Math.random() * list.length)];
            if (game.phase === 'rob') return game.humanRob(Math.random() < 0.5);
            if (game.phase === 'claim') {
                const option = game.claim.humanOpt, choices = [['pass']];
                if (option.win) choices.push(['win'], ['win'], ['win']);
                if (option.kong) choices.push(['kong']);
                if (option.pung) choices.push(['pung']);
                option.chows.forEach((_, i) => choices.push(['chow', i]));
                return game.humanClaim(...pick(choices));
            }
            const options = game.selfOptions(0);
            if (options.win && Math.random() < 0.9) return game.humanSelfWin();
            if (options.kongs.length && Math.random() < 0.7) { const kong = pick(options.kongs); return game.humanKong(kong.kind, kong.tile); }
            if (game.tingWaits().length && Math.random() < 0.5) return game.toggleAutoWin();
            const tiles = game.handDisplayOrder();
            const tile = Math.random() < 0.8 ? MahjongAI.chooseDiscard(game, 0, 'easy') : pick(tiles);
            game.onHandTileClick(tiles.lastIndexOf(tile));
        },
        next: () => game.nextHand(), restart: () => { game.confirmRestartMatch(); game.resetMatch(); }, undo: () => game.undo()
    })
};
DRIVERS['mahjong-me'] = DRIVERS.mahjong;

async function openGame(browser, name) {
    const page = await browser.newPage();
    page.on('pageerror', error => problems.push(`${name}: page error: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('GameRecorder')) problems.push(`${name}: ${message.text()}`); });
    page.on('dialog', dialog => dialog.accept());
    await page.evaluateOnNewDocument(instrument);
    await page.evaluateOnNewDocument(`window.__makeDriver = ${DRIVERS[name].toString()};`);
    await load(page, name);
    return page;
}
async function load(page, name) {
    await page.goto(`${BASE}/${name}`, { waitUntil: 'load' });
    await page.evaluate(() => { window.__driver = window.__makeDriver(); window.__driver.setup(); });
}
// Plays until the round is over (moves === Infinity) or until the player has made `moves` decisions.
const play = (page, moves = Infinity, hintChance = 0.2) => page.evaluate(async (limit, chance) => {
    const d = window.__driver;
    let made = 0;
    for (let idle = 0; !d.over() && made < limit;) {
        if (d.ready()) {
            if (Math.random() < chance) d.hint();
            const before = JSON.stringify(window.GameRecorder.peek());
            d.act();
            if (!d.over() && JSON.stringify(window.GameRecorder.peek()) === before && !(window.game.autoWin)) throw new Error('a scripted move had no effect');
            made++;
            idle = 0;
        } else {
            await window.__sleep(4);
            if (++idle > 5000) throw new Error('the computers never finish their turn');
        }
    }
    // let the computers answer, so that the round is waiting for the player (or over) when we return
    for (let idle = 0; !d.over() && !d.ready(); idle++) {
        await window.__sleep(4);
        if (idle > 5000) throw new Error('the computers never finish their turn');
    }
    return { over: d.over(), made };
}, moves === Infinity ? 1e9 : moves, hintChance);
const delivered = page => waitFor(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('game_record:')).length === 0), 'records to reach the server');
const ended = page => page.evaluate(() => window.__ended.splice(0).map(text => JSON.parse(text)));
const strip = record => Object.fromEntries(Object.entries(record).filter(([key]) => !ENVELOPE.includes(key) && key !== 'finished'));
const version = name => { const data = fs.readFileSync(path.join(PROJECT, 'games', `${name}.html`)); return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'); };

function checkFile(name, file, expected, status) {
    const saved = read(file);
    assert.equal(file, `${name}/${saved.id.slice(0, 4)}-${saved.id.slice(4, 6)}/${saved.id}.json`);
    assert.match(saved.id, /^\d{8}-\d{6}-[a-z0-9]{6}$/);
    assert.deepEqual([saved.game, saved.status, saved.ip, saved.build], [name, status, HOST, version(name)]);
    assert.match(saved.ua, /Chrome/);
    assert.match(saved.started, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    assert.ok(saved.ended >= saved.started);
    assert.match(saved.saved, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    assert.deepEqual(Object.keys(saved).slice(0, 8), ['game', 'id', 'status', 'started', 'ended', 'saved', 'ip', 'ua']);
    assert.deepEqual(strip(saved), strip(expected), `${file} differs from what the game handed over`);
    assert.equal(expected.finished, status === 'finished');
    return saved;
}

async function exercise(browser, name) {
    const before = files();
    const fresh = () => files().filter(file => !before.includes(file));
    let page = await openGame(browser, name);

    // 1. Two rounds played to the end: two files, same session.
    const finished = [];
    for (let round = 0; round < 2; round++) {
        assert.equal((await play(page)).over, true);
        await delivered(page);
        const records = await ended(page);
        assert.equal(records.length, 1);
        const file = fresh().filter(f => !finished.some(done => done.file === f));
        assert.equal(file.length, 1, `${name}: one new file per round, got ${file}`);
        finished.push({ file: file[0], saved: checkFile(name, file[0], records[0], 'finished') });
        await page.evaluate(() => window.__driver.next());
    }
    assert.equal(finished[0].saved.session, finished[1].saved.session);
    assert.notEqual(finished[0].saved.id, finished[1].saved.id);
    let known = fresh();
    // Plays the player's next `moves` decisions and stops in the middle of a round. A round that happens to end
    // on the way is accounted for (its file is expected) and the next one is started.
    const midRound = async (moves, hintChance = 0) => {
        for (let attempt = 0; attempt < 8; attempt++) {
            const result = await play(page, moves, hintChance);
            if (!result.over) {
                if (await page.evaluate(() => window.GameRecorder.peek() !== null)) return;
                continue;
            }
            await delivered(page);
            const records = await ended(page);
            const file = fresh().filter(f => !known.includes(f));
            assert.equal(file.length, 1, `${name}: a round ended on the way: ${file}`);
            checkFile(name, file[0], records[records.length - 1], 'finished');
            known = fresh();
            await page.evaluate(() => window.__driver.next());
        }
        throw new Error(`${name}: never got to the middle of a round`);
    };
    const newFile = what => waitFor(() => {
        const now = fresh().filter(f => !known.includes(f));
        return now.length ? now : null;
    }, `${name}: ${what}`).then(now => { assert.equal(now.length, 1, `${what}: ${now}`); known = fresh(); return now[0]; });
    const peek = () => page.evaluate(() => JSON.parse(JSON.stringify(window.GameRecorder.peek())));

    // 2. A few moves into the next round, back to the lobby through the icon in the corner: the progress is kept.
    await midRound(3);
    let snapshot = await peek();
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.evaluate(() => {
        window.__sleep(20).then(() => document.querySelector('header > div:first-child > div:first-child').click());
    })]);
    assert.equal(new URL(page.url()).pathname, '/');
    checkFile(name, await newFile('the unfinished round after leaving for the lobby'), snapshot, 'unfinished');

    // 3. Back in the game (a new page load), a few moves, then the page is reloaded: kept as well, in a new session.
    await load(page, name);
    await delivered(page);    // this page first confirms what the closing one sent
    await midRound(3);
    snapshot = await peek();
    await load(page, name);
    const reloaded = await newFile('the unfinished round after a reload');
    const saved = checkFile(name, reloaded, snapshot, 'unfinished');
    assert.notEqual(saved.session, finished[0].saved.session);
    await delivered(page);
    assert.equal(read(reloaded).seq, saved.seq, 'confirming a copy the server already has changes nothing');

    // 4. A move taken back, more moves, then the game's own restart in the middle of a round.
    await midRound(4, 0.5);
    await page.evaluate(() => window.__driver.undo());
    await midRound(2);
    await ended(page);
    snapshot = await peek();
    await page.evaluate(() => window.__driver.restart());
    const given = await ended(page);
    assert.equal(given.length, 1, `${name}: restarting hands over the round that was given up`);
    assert.deepEqual(given[0], snapshot);
    await delivered(page);
    checkFile(name, await newFile('the round given up by restarting'), given[0], 'unfinished');

    // 5. And the round after the restart is recorded to the end as usual.
    assert.equal((await play(page)).over, true);
    await delivered(page);
    const last = await ended(page);
    checkFile(name, await newFile('the round after the restart'), last[last.length - 1], 'finished');

    await page.close();
    const all = fresh();
    assert.ok(all.every(f => f.startsWith(`${name}/`) && f.endsWith('.json')), `${name}: stray files ${all}`);
    return all.length;
}

// The server goes away while a page is open: the round waits in the browser and arrives once the server is back,
// even if the page was closed in between and a different game is opened afterwards.
async function outage(browser) {
    const before = files();
    const fresh = () => files().filter(file => !before.includes(file));
    const page = await openGame(browser, 'gongzhu');
    await stopServer();
    assert.equal((await play(page)).over, true);
    const [first] = await ended(page);
    await sleep(300);
    assert.deepEqual(fresh(), []);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('game_record:')).length), 1);
    await startServer();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await delivered(page);
    assert.equal(fresh().length, 1);
    checkFile('gongzhu', fresh()[0], first, 'finished');

    await page.evaluate(() => window.__driver.next());
    await stopServer();
    assert.equal((await play(page)).over, true);
    const [second] = await ended(page);
    await sleep(300);
    await page.close();    // closed while the server is still away
    await startServer();
    assert.equal(fresh().length, 1);
    const other = await openGame(browser, 'reversi');
    await delivered(other);
    const now = fresh();
    assert.equal(now.length, 2, `the round left behind was delivered: ${now}`);
    checkFile('gongzhu', now.find(f => read(f).round === second.round), second, 'finished');
    await other.close();
    return 2;
}

// The live server, as its PID file and command line describe it.
function liveServer() {
    const [pid, host, port] = fs.readFileSync(path.join(ROOT, 'server.pid'), 'utf8').split(/\s+/);
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const at = args.indexOf('--data-dir');
    return { host, port, data: at >= 0 ? args[at + 1] : path.join(ROOT, 'gaming_data') };
}

// A copy of the server and the games in a temporary folder: its PID file, log and records stay out of the project.
function privateCopy() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'game-records-check-'));
    fs.copyFileSync(path.join(ROOT, 'open_server.py'), path.join(folder, 'open_server.py'));
    fs.cpSync(path.join(ROOT, 'games'), path.join(folder, 'games'), { recursive: true });
    return folder;
}

const sparePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

(async () => {
    if (LIVE) {
        const live = liveServer();
        [PROJECT, HOST, PORT, DATA] = [ROOT, live.host, live.port, live.data];
    } else {
        PROJECT = privateCopy();
        [HOST, PORT, DATA] = ['127.0.0.1', await sparePort(), path.join(PROJECT, 'data')];
    }
    BASE = `http://${HOST}:${PORT}`;
    const initial = files();
    if (!LIVE) await startServer();
    const browser = await puppeteer.launch({
        headless: true, executablePath: CHROME, protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${HOST}`]
    });
    let failed = false;
    try {
        const names = ONLY.length ? ONLY.filter(n => n !== 'outage') : Object.keys(DRIVERS);
        for (const name of names) {
            const started = Date.now();
            try {
                const count = await exercise(browser, name);
                console.log(`ok   ${name.padEnd(11)} ${count} files  ${((Date.now() - started) / 1000).toFixed(1)}s`);
            } catch (error) {
                failed = true;
                console.log(`FAIL ${name}: ${error.stack}`);
            }
        }
        if (!LIVE && (!ONLY.length || ONLY.includes('outage'))) {
            try {
                console.log(`ok   outage      ${await outage(browser)} files`);
            } catch (error) {
                failed = true;
                console.log(`FAIL outage: ${error.stack}`);
            }
        }
    } finally {
        await browser.close();
        if (server && server.exitCode === null) await stopServer();
    }
    const all = files();
    console.log(`${all.length} files under ${DATA}`);
    if (LIVE) {
        // Only what this run created: new since the start, sent from this machine by a headless browser.
        const mine = all.filter(file => !initial.includes(file) && /HeadlessChrome/.test(read(file).ua) && read(file).ip === HOST);
        for (const file of mine) fs.unlinkSync(path.join(DATA, file));
        for (const dir of [...new Set(mine.map(file => path.dirname(file)))].sort().reverse()) {
            for (let d = dir; d !== '.'; d = path.dirname(d)) {
                try { fs.rmdirSync(path.join(DATA, d)); } catch (error) { break; }    // not empty: someone else's records
            }
        }
        console.log(`removed the ${mine.length} test records; ${files().length} files remain`);
    }
    if (!LIVE) fs.rmSync(PROJECT, { recursive: true, force: true });
    console.log(`problems: ${problems.length ? '\n  ' + problems.join('\n  ') : 'none'}`);
    process.exit(failed || problems.length ? 1 : 0);
})().catch(error => {
    console.error(error);
    if (server) server.kill();
    if (!LIVE && PROJECT) fs.rmSync(PROJECT, { recursive: true, force: true });
    process.exit(1);
});
