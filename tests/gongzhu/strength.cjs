'use strict';
// 拱豬「電腦的打法」每個選項有多強：讓它們實際對打，最強的是 100。在專案根目錄執行：
//
//   node tests/gongzhu/strength.cjs               大約 15 分鐘（60 核心）；選項或模型換了就重跑一次
//   node tests/gongzhu/strength.cjs --tables 1    每種同桌組合只打一副牌，先試跑
//
// 選項是原本的電腦（頁面的 GongZhuAI，每一手都算滿 400 次），加上 train_out/gongzhu/ 每個模型的「正常」「較弱」。
// 每次挑四個選項同桌，所有組合都打 --tables 副牌；每副牌讓這四個選項輪流坐四個座位（坐的順序每副牌隨機），
// 所以每個選項拿到的牌和碰到的對手都一樣多。模型的牌由這裡在 127.0.0.1 開的 open_server.py 回答
// （--servers 個，每個一條執行緒），問法和遊戲頁面一樣；原本的電腦在這裡照頁面的程式算。
//
// 每局記下四家的實際牌分。估計每個選項的強度 s 時，用最小平方法擬合
// 每家的牌分減同桌平均 ≈ 自己的 s 減同桌四家 s 的平均。
// 強度 = 100 −（最強的 s − 自己的 s）：強度差 1，就是和同樣的對手打，平均每局少拿 1 分。
// 結果寫進 train_out/gongzhu/strength.json（伺服器讀這個檔，在「電腦的打法」顯示強度），
// 每一局的結果寫進 reports/gongzhu/strength-games.jsonl.gz。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { compileFunction } = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SAMPLES = 400;            // 原本的電腦每一手模擬幾次（頁面上最多就是這麼多）
const SEATS = 4;
const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (isMainThread) main().catch(error => { console.error(error); process.exit(1); });
else worker();

// ---------------------------------------------------------------- one table (in a worker thread)

function worker() {
    const script = require('./source.cjs');
    const load = compileFunction(script + '\nreturn { game, ai: GongZhuAI };', ['window', 'Math', 'document']);

    async function ask(record, seat, mode, model) {
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await fetch(workerData.url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ record, seat, mode, model })
                });
                const body = await response.json();
                if (response.status === 200 && body.play && body.play.seat === seat) return body.play.card;
                throw new Error(`${response.status} ${JSON.stringify(body)}`);
            } catch (error) {
                if (attempt >= 2) throw error;
                await sleep(500);
            }
        }
    }

    // One round of the deal with these options at the seats (in the page's seat order); returns the four scores.
    async function play(dealSeed, seating, gameSeed) {
        // All four rotations use the page's dealer with the same seed, then play with independent random choices.
        const math = Object.assign(Object.create(Math), { random: rng(dealSeed) });
        const { game, ai } = load({}, math);
        const hands = game.dealHands();
        math.random = rng(gameSeed);
        Object.assign(ai, { BUDGET_MS: Infinity, MIN_SAMPLES: SAMPLES, MAX_SAMPLES: SAMPLES });
        const seats = game.SEAT_ORDER;
        seats.forEach((seat, i) => Object.assign(game.PLAYERS[seat], {
            hand: game.sortCards(hands[i]), captured: [], totalScore: 0, isAI: true }));
        Object.assign(game, { trickHistory: [], currentTrick: [], leadSuit: null, trickNumber: 1, roundNumber: 1, roundOver: false });
        let leader = seats.find(seat => game.PLAYERS[seat].hand.some(card => card.id === 'S7'));
        while (!game.allScoringCardsCaptured()) {
            const seat = seats[(seats.indexOf(leader) + game.currentTrick.length) % SEATS];
            const legal = game.getLegalCards(seat);
            const option = seating[seats.indexOf(seat)];
            let card;
            if (option === 'builtin') {
                card = game.chooseBestCardForAI(seat);
            } else {
                const cut = option.indexOf(':');
                const id = await ask(game.roundSoFar(), seat, option.slice(0, cut), option.slice(cut + 1));
                card = legal.find(c => c.id === id);
            }
            if (!card || !legal.includes(card)) throw new Error(`${option} played a card ${seat} may not play`);
            const player = game.PLAYERS[seat];
            player.hand = player.hand.filter(c => c !== card);
            game.currentTrick.push({ seat, card });
            if (!game.leadSuit) game.leadSuit = card.suit;
            if (game.currentTrick.length === SEATS) {
                const winner = game.trickWinner(game.currentTrick).seat;
                game.PLAYERS[winner].captured.push(...game.currentTrick.map(t => t.card).filter(c => c.isScoring));
                game.trickHistory.push(game.currentTrick);
                Object.assign(game, { currentTrick: [], leadSuit: null, trickNumber: game.trickNumber + 1 });
                leader = winner;
            }
        }
        const scores = game.calculateRoundScores();
        return seats.map(seat => scores[seat].score);
    }

    parentPort.on('message', async job => {
        if (!job) return process.exit(0);
        try {
            const games = [];
            for (let turn = 0; turn < SEATS; turn++) {     // every option sits at every seat once
                const seating = job.order.map((_, seat) => job.order[(seat + turn) % SEATS]);
                const scores = await play(job.dealSeed, seating, job.dealSeed * 8 + turn);
                games.push({ deal: job.deal, seats: seating, scores });
            }
            parentPort.postMessage({ games });
        } catch (error) {
            parentPort.postMessage({ error: String(error.stack || error) });
        }
    });
    parentPort.postMessage({ ready: true });
}

// ---------------------------------------------------------------- the whole tournament

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    });
}

function choose(items, k, start = 0, picked = [], out = []) {
    if (picked.length === k) out.push([...picked]);
    else for (let i = start; i < items.length; i++) choose(items, k, i + 1, [...picked, items[i]], out);
    return out;
}

// s for every option: each seat's score minus its table's average ≈ its s minus the table's average s.
// Least squares; the rows add up to 0, so adding 1 everywhere fixes the sum of s at 0.
function fit(games, keys) {
    const n = keys.length, index = new Map(keys.map((key, i) => [key, i]));
    const a = keys.map(() => new Array(n).fill(1)), b = new Array(n).fill(0);
    for (const game of games) {
        const at = game.seats.map(key => index.get(key));
        const mean = game.scores.reduce((sum, score) => sum + score, 0) / SEATS;
        for (let seat = 0; seat < SEATS; seat++) {
            const row = new Array(n).fill(0);
            row[at[seat]] += 1;
            for (const j of at) row[j] -= 1 / SEATS;
            const z = game.scores[seat] - mean;
            for (let i = 0; i < n; i++) {
                if (!row[i]) continue;
                b[i] += row[i] * z;
                for (let j = 0; j < n; j++) a[i][j] += row[i] * row[j];
            }
        }
    }
    for (let col = 0; col < n; col++) {     // Gaussian elimination with partial pivoting
        const pivot = a.reduce((best, row, r) => (r >= col && Math.abs(row[col]) > Math.abs(a[best][col]) ? r : best), col);
        [a[col], a[pivot]] = [a[pivot], a[col]];
        [b[col], b[pivot]] = [b[pivot], b[col]];
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = a[r][col] / a[col][col];
            for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
            b[r] -= f * b[col];
        }
    }
    return b.map((value, i) => value / a[i][i]);
}

const ratings = s => { const top = Math.max(...s); return s.map(value => 100 - (top - value)); };

async function main() {
    const args = process.argv.slice(2);
    const opt = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
    const cores = os.cpus().length;
    const tables = Number(opt('--tables', 64));
    const servers = Number(opt('--servers', Math.max(1, Math.floor(cores / 4))));
    const workers = Number(opt('--workers', Math.max(1, cores - servers)));
    const seed = Number(opt('--seed', 20261124));
    const out = path.resolve(opt('--out', path.join(ROOT, 'train_out', 'gongzhu', 'strength.json')));
    const gamesOut = path.resolve(opt('--games', path.join(ROOT, 'reports', 'gongzhu', 'strength-games.jsonl.gz')));

    // the model servers, one thread each (see SEARCH_THREADS in model_bot.py)
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gongzhu-strength-'));
    const env = { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' };
    const urls = [], children = [];
    const stop = () => children.forEach(child => { try { child.kill(); } catch (e) {} });
    process.on('exit', stop);
    process.on('SIGINT', () => process.exit(130));
    for (let i = 0; i < servers; i++) {
        const port = await freePort();
        children.push(spawn('python3', [path.join(ROOT, 'open_server.py'), 'run', '--host', '127.0.0.1', '--port', String(port),
            '--data-dir', data], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }));
        urls.push(`http://127.0.0.1:${port}/api/bot/gongzhu`);
    }
    let info = null;
    for (const url of urls) {
        for (let tries = 0; ; tries++) {
            try {
                info = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
                break;
            } catch (error) {
                if (tries > 120) throw new Error(`${url} never answered`);
                await sleep(500);
            }
        }
    }
    if (!info.models || !info.models.length) throw new Error(`no Gong Zhu model: ${info.why || 'train_out/gongzhu/ is empty'}`);
    const keys = ['builtin', ...info.models.flatMap(model => [`normal:${model.name}`, `weak:${model.name}`])];
    const tablesOf = choose(keys, SEATS);
    const jobs = [];
    const order = rng(seed);
    for (let t = 0; t < tables; t++) {
        for (const table of tablesOf) {
            const shuffled = [...table];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(order() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            jobs.push({ deal: jobs.length, dealSeed: (seed * 1000003 + jobs.length) >>> 0, order: shuffled });
        }
    }
    console.log(`${keys.length} 個選項，${tablesOf.length} 種同桌組合 × ${tables} 副牌 × 4 個座位 = ${jobs.length * SEATS} 局；`
        + `${servers} 個模型伺服器、${workers} 條執行緒`);

    const games = [];
    const started = Date.now();
    await new Promise((resolve, reject) => {
        let next = 0, running = 0, failed = false;
        const pool = [];
        for (let w = 0; w < Math.min(workers, jobs.length); w++) {
            const thread = new Worker(__filename, { workerData: { url: urls[w % urls.length] } });
            pool.push(thread);
            running++;
            const feed = () => {
                if (failed) return;
                if (next < jobs.length) thread.postMessage(jobs[next++]);
                else { thread.postMessage(null); }
            };
            thread.on('message', message => {
                if (message.error) { failed = true; pool.forEach(t => t.terminate()); return reject(new Error(message.error)); }
                if (message.games) {
                    games.push(...message.games);
                    const done = games.length / SEATS;
                    if (done % 50 === 0 || done === jobs.length) {
                        const seconds = (Date.now() - started) / 1000;
                        console.log(`  ${done}/${jobs.length} 副牌，${Math.round(seconds)} 秒`);
                    }
                }
                feed();
            });
            thread.on('error', error => { failed = true; reject(error); });
            thread.on('exit', () => { if (--running === 0 && !failed) resolve(); });
        }
    });
    stop();

    // strength, and how much it moves when the deals are drawn again (bootstrap over deals)
    const s = fit(games, keys);
    const strength = ratings(s);
    const byDeal = new Map();
    for (const game of games) (byDeal.get(game.deal) || byDeal.set(game.deal, []).get(game.deal)).push(game);
    const deals = [...byDeal.values()];
    const redraw = rng(seed ^ 0x5bd1e995);
    const samples = keys.map(() => []);
    for (let round = 0; round < 200; round++) {
        const picked = [];
        for (let i = 0; i < deals.length; i++) picked.push(...deals[Math.floor(redraw() * deals.length)]);
        ratings(fit(picked, keys)).forEach((value, i) => samples[i].push(value));
    }
    const range = samples.map(values => {
        values.sort((x, y) => x - y);
        return [values[Math.floor(values.length * 0.025)], values[Math.ceil(values.length * 0.975) - 1]].map(Math.round);
    });

    const result = {
        about: '拱豬「電腦的打法」每個選項的強度：最強的是 100，強度差 1，就是和同樣的對手打，平均每局少拿 1 分。'
            + '由 tests/gongzhu/strength.cjs 讓它們實際對打量的（量法寫在那個檔的開頭）；模型換了要重量',
        measured: new Date().toLocaleDateString('sv'),     // 這台的日期，例如 2026-11-24
        deals: jobs.length, games: games.length, tables, seed, builtinSamples: SAMPLES,
        models: Object.fromEntries(info.models.map(model => [model.name, model.id])),
        strength: Object.fromEntries(keys.map((key, i) => [key, Math.round(strength[i])])),
        range: Object.fromEntries(keys.map((key, i) => [key, range[i]])),
        points: Object.fromEntries(keys.map((key, i) => [key, Math.round(s[i] * 10) / 10]))
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
    fs.mkdirSync(path.dirname(gamesOut), { recursive: true });
    fs.writeFileSync(gamesOut, zlib.gzipSync(games.map(game => JSON.stringify(game)).join('\n') + '\n'));

    console.log(`\n強度（最強的是 100；括號裡是重抽牌時 95% 會落在的範圍），${Math.round((Date.now() - started) / 60000)} 分鐘：`);
    keys.map((key, i) => [key, i]).sort((x, y) => s[y[1]] - s[x[1]]).forEach(([key, i]) => {
        console.log(`  ${String(Math.round(strength[i])).padStart(3)}（${range[i][0]}～${range[i][1]}）  ${key}`
            + `  和同一桌比平均每局 ${s[i] >= 0 ? '+' : ''}${s[i].toFixed(1)} 分`);
    });
    console.log(`寫好了：${path.relative(ROOT, out)}、${path.relative(ROOT, gamesOut)}`);
}
