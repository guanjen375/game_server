'use strict';
// Optional browser check. GAME_PUPPETEER and GAME_CHROME work as in poker-layout-check.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require(process.env.GAME_PUPPETEER || 'puppeteer');

const choice = '[data-game-choice="true"]:not(:disabled)';
const activeMatches = (page, selector) => page.evaluate(s => document.activeElement.matches(s), selector);
const activeCell = page => page.evaluate(() => Number(document.activeElement.dataset.keyCell));
const cell = n => `[data-key-cell="${n}"]`;

async function navigateTo(page, selector, key = 'ArrowRight', limit) {
    const count = limit ?? await page.$$eval(choice, items => items.length);
    for (let i = 0; i <= count; i++) {
        if (await activeMatches(page, selector)) return;
        await page.keyboard.press(key);
    }
    assert.fail(`Could not reach ${selector} with the arrow keys`);
}

// Open settings and return to the same play using just arrows and Enter.
async function checkToolbar(page, original) {
    await page.keyboard.press('ArrowUp');
    if (await activeMatches(page, '.mj-info-button')) {
        await page.keyboard.press('Enter');
        assert.ok(await activeMatches(page, '#tileInfoDialog[open] button'));
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowUp');
    }
    assert.ok(await activeMatches(page, '.table-tools > button:enabled, .table-menu summary'));
    if (await page.$('#playerHand')) await page.evaluate(() => game.renderHand());
    await navigateTo(page, '.table-menu summary', 'ArrowRight', 3);
    await page.keyboard.press('ArrowRight');
    assert.ok(await activeMatches(page, '.table-menu summary'));
    await page.keyboard.press('Enter');
    assert.ok(await activeMatches(page, '.table-menu[open] .menu-panel button:first-child'));
    await page.keyboard.press('ArrowLeft');
    assert.ok(await activeMatches(page, '.table-menu:not([open]) summary'));
    await page.keyboard.press('Enter');
    await navigateTo(page, '.menu-panel button[onclick*="openRules"], #rulesBtn', 'ArrowDown', 8);
    await page.keyboard.press('Enter');
    await navigateTo(page, '.game-theme-setting select', 'ArrowRight', 4);
    const old = await page.$eval('.game-theme-setting select', el => el.selectedIndex);
    await page.keyboard.press(old ? 'ArrowUp' : 'ArrowDown');
    assert.equal(await page.$eval('.game-theme-setting select', el => el.selectedIndex), old ? old - 1 : 1);
    assert.ok(await activeMatches(page, '.game-theme-setting select'));
    await page.keyboard.press('ArrowLeft');
    assert.ok(await activeMatches(page, '#rulesModal button[aria-label="關閉視窗"], #rulesDialog .close'));
    await page.keyboard.press('Enter');
    assert.ok(await activeMatches(page, '.table-menu:not([open]) summary'));
    await page.keyboard.press('ArrowDown');
    assert.ok(await activeMatches(page, original), 'return to the same legal card or square');
}

async function checkHandContrast(page) {
    const samples = await page.evaluate(() => {
        const focused = document.activeElement;
        const tile = focused.querySelector('.mj-tile');
        const root = document.documentElement, saved = root.dataset.theme;
        const themes = document.querySelector('.game-theme-setting select').options;
        const samples = [];
        for (const {value: theme} of themes) {
            root.dataset.theme = theme;
            const face = getComputedStyle(tile || focused);
            samples.push({theme, face: face.backgroundColor, image: face.backgroundImage,
                ring: getComputedStyle(focused).outlineColor,
                ink: tile ? null : getComputedStyle(focused.querySelector('.gz-card-idx')).color,
                artwork: tile ? getComputedStyle(tile.querySelector('svg')).filter : null});
        }
        root.dataset.theme = saved;
        return samples;
    });
    const luminance = rgb => {
        const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(value => {
            const v = Number(value) / 255;
            return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
        });
        return .2126 * r + .7152 * g + .0722 * b;
    };
    for (const {theme, face, image, ring, ink, artwork} of samples) {
        assert.equal(image, 'none', theme);
        assert.ok((luminance(ring) + .05) / (luminance(face) + .05) >= 7, `${theme} focus ring`);
        if (ink) assert.ok((luminance(ink) + .05) / (luminance(face) + .05) >= 7, `${theme} rank and suit`);
        if (artwork) assert.notEqual(artwork, 'none', `${theme} tile artwork`);
    }
}

async function pointerPlay(page, selector) {
    // The left corner remains exposed when playing cards overlap.
    const [x, y] = await page.$eval(selector, el => {
        const r = el.getBoundingClientRect();
        return [r.left + 6, r.top + 15];
    });
    if (page.viewport().hasTouch) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
}

async function gongzhu(page) {
    const legal = await page.evaluate(() => {
        game.cancelTimers();
        game.later = () => {};
        game.startRound();
        game.currentTurn = 'east';
        const lead = game.PLAYERS.east.hand.find(c => game.PLAYERS.south.hand.filter(h => h.suit === c.suit).length >= 2);
        game.playCardFromSeat('east', lead.id);
        return [...document.querySelectorAll('#playerHandContainer [data-card]')].map(slot => slot.dataset.card)
            .filter(id => id[0] === lead.suit);
    });
    const face = id => `#playerHandContainer [data-card="${id}"] button`;
    await page.keyboard.press('ArrowRight');
    assert.ok(await activeMatches(page, face(legal[0])));
    await page.keyboard.press('ArrowLeft');
    assert.ok(await activeMatches(page, face(legal[0])));
    await checkHandContrast(page);
    for (const id of legal.slice(1)) {
        await page.keyboard.press('ArrowRight');
        assert.ok(await activeMatches(page, face(id)));
    }
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    assert.ok(await activeMatches(page, face(legal.at(-1))));
    await checkToolbar(page, face(legal.at(-1)));
    await page.keyboard.press('ArrowUp');
    await navigateTo(page, '.table-menu summary', 'ArrowRight', 3);
    await page.keyboard.press('Enter');
    await navigateTo(page, '.menu-panel .restart-tool', 'ArrowDown', 8);
    await page.keyboard.press('ArrowDown');
    assert.ok(await activeMatches(page, '.menu-panel .restart-tool'));
    await page.keyboard.press('Enter');
    await navigateTo(page, '#confirmModalOk', 'ArrowRight', 2);
    await page.keyboard.press('ArrowLeft');
    assert.ok(await activeMatches(page, '#confirmModal button[onclick="game.closeConfirmModal()"]'));
    await page.keyboard.press('Enter');
    assert.ok(await activeMatches(page, '.table-menu:not([open]) summary'));
    await page.keyboard.press('ArrowDown');
    assert.ok(await activeMatches(page, face(legal.at(-1))));
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    assert.equal(await page.evaluate(() => game.currentTrick.length), 1);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => game.currentTrick.at(-1).card.id), legal.at(-1));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => game.currentTrick.length), 2);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    assert.ok(await activeMatches(page, '.gz-hand'), 'return to the hand while waiting for the next turn');
    await page.keyboard.press('ArrowUp');
    await navigateTo(page, '.table-tools > button[onclick="game.undo()"]', 'ArrowRight', 3);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    assert.ok(await activeMatches(page, face(legal.at(-1))));
    await pointerPlay(page, face(legal[0]));
    assert.equal(await page.evaluate(() => game.currentTrick.at(-1).card.id), legal[0]);
}

async function bigtwo(page) {
    await page.evaluate(() => {
        clearTimeout(game.timer);
        game.scheduleAI = () => {};
        const deck = BigTwo.createDeck();
        const ids = 'C3 D3 C4 H5 D6 S7 C8 H8 H9 S10 DJ CK S2'.split(' ');
        const others = deck.filter(c => !ids.includes(c.id));
        game.round = new BigTwo.Round({hands: [deck.filter(c => ids.includes(c.id)), others.slice(0, 13), others.slice(13, 26), others.slice(26)]});
        game.render();
    });
    await navigateTo(page, '#hand button[data-card="C3"]');
    await checkHandContrast(page);
    await checkToolbar(page, '#hand button[data-card="C3"]');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => game.round.lastPlay.cards.map(c => c.id)), ['C3']);
    await page.keyboard.press('ArrowUp');
    assert.ok(await activeMatches(page, '#undoBtn'), 'skip the disabled hint');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    assert.ok(await activeMatches(page, '#hand button[data-card="C3"]'));
    await navigateTo(page, '#hand button[data-card="D3"]');
    await checkHandContrast(page);
    await page.keyboard.press('Space');
    assert.deepEqual(await page.$$eval(`#hand ${choice}`, els => els.map(el => el.dataset.card)), ['C3', 'D3']);
    await page.keyboard.press('ArrowDown');
    assert.ok(await activeMatches(page, '#clearBtn'));
    await page.keyboard.press('ArrowUp');
    assert.ok(await activeMatches(page, '#hand button[data-card="D3"]'));
    await page.keyboard.press('ArrowRight');
    assert.ok(await activeMatches(page, '#hand button[data-card="D3"]'));
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => game.round.lastPlay.cards.map(c => c.id)), ['C3', 'D3']);
    // Let the three opponents respond until the human has a legal pass.
    await page.evaluate(() => {
        game.undo();
        game.performPlay(0, game.round.hands[0].filter(c => c.id === 'C3'));
        const response = BigTwo.legalMoves(game.round.hands[1], game.round.lastPlay, false).find(m => m.size === 1);
        game.performPlay(1, response.cards);
        game.performPass(2);
        game.performPass(3);
    });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await navigateTo(page, '#passBtn', 'ArrowRight', 3);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => game.round.actions.filter(a => a.seat === 0).at(-1).type), 'pass');
}

async function banqi(page) {
    await page.evaluate(() => {
        game.settings.mode = 'pvp';
        game.applyMode();
        game.startRound();
        // These two adjacent flips assign the colors and give red a legal capture.
        for (const [sq, code] of [[8, codeOf(RED, T_KING)], [9, codeOf(BLACK, 1)]]) {
            const i = game.hiddenLayout.indexOf(code);
            [game.hiddenLayout[sq], game.hiddenLayout[i]] = [game.hiddenLayout[i], game.hiddenLayout[sq]];
        }
    });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeCell(page), 8);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    assert.equal(await activeCell(page), 9);
    await page.keyboard.press('Enter');
    await navigateTo(page, cell(8), 'ArrowLeft');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.$$eval(choice, els => els.map(el => Number(el.dataset.keyCell))), [8, 9]);
    await checkToolbar(page, cell(8));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => game.lastMove), {type: 'capture', from: 8, to: 9});
}

async function reversi(page) {
    await page.evaluate(() => {
        game.scheduleAI = () => {};
        game.settings.showMoves = 'off';
        game.startRound();
    });
    const legal = await page.evaluate(() => Array.from(game.board, (_, sq) => sq)
        .filter(sq => Engine.isLegal(game.board, sq, game.PLAYERS[game.turn].color)));
    assert.equal(legal.length, 4);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await activeCell(page), legal.at(-1));
    await page.keyboard.press('ArrowRight');
    assert.equal(await activeCell(page), legal.at(-1));
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeCell(page), legal.at(-1));
    await navigateTo(page, cell(legal[0]), 'ArrowUp');
    assert.equal(await activeCell(page), legal[0]);
    await checkToolbar(page, cell(legal[0]));
    await page.keyboard.press('ArrowLeft');
    assert.equal(await activeCell(page), legal[0]);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => game.lastMove.sq), legal[0]);
    assert.equal(await page.$$eval(choice, els => els.length), 0);
}

async function xiangqi(page) {
    for (const side of ['red', 'black']) {
        const move = await page.evaluate(side => {
            game.settings.side = side;
            game.settings.mode = 'pvp';
            game.applyMode();
            game.startRound();
            // Exercise both an empty marker and a capture on a flipped board.
            const m = game.legalMovesNow().find(m => (game.board[m & 127] === EMPTY) === (side === 'red'));
            const display = sq => { const [r, c] = game.toDisplay(sq); return r * 9 + c; };
            return {from: m >> 7, to: m & 127, source: display(m >> 7), destination: display(m & 127)};
        }, side);
        await navigateTo(page, cell(move.source));
        await page.keyboard.down('Enter');
        await page.keyboard.down('Enter'); // A held key must not deselect the piece.
        await page.keyboard.up('Enter');
        assert.equal(await page.evaluate(() => game.selectedSq), move.from);
        const top = await page.$$eval(choice, items => Math.min(...items.map(el => Number(el.dataset.keyCell))));
        await navigateTo(page, cell(top), 'ArrowLeft');
        await checkToolbar(page, cell(top));
        assert.equal(await page.evaluate(() => game.selectedSq), move.from);
        await navigateTo(page, cell(move.destination), top < move.destination ? 'ArrowRight' : 'ArrowLeft');
        await page.keyboard.press('Enter');
        assert.deepEqual(await page.evaluate(() => game.lastMove), {from: move.from, to: move.to});
    }
}

async function mahjong(page) {
    await page.evaluate(() => {
        clearTimeout(game.timer);
        game.schedule = () => {};
        game.dealer = 0;
        game.startHand();
        game.initialFlowers();
        game.drawFor(0);
        game.settings.discardMode = 'double';
    });
    const last = await page.evaluate(() => game.handDisplayOrder().length - 1);
    const lastTile = `#playerHand [data-i="${last}"]`;
    await navigateTo(page, lastTile);
    await page.keyboard.press('ArrowRight');
    assert.ok(await activeMatches(page, lastTile));
    const tile = '#playerHand [data-i="1"]';
    await navigateTo(page, tile, 'ArrowLeft');
    await checkHandContrast(page);
    await checkToolbar(page, tile);
    const value = await page.$eval(tile, el => Number(el.firstElementChild.dataset.tile));
    await page.evaluate(() => game.renderHand());
    assert.ok(await activeMatches(page, tile));
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => game.players[0].discards), [value]);
    await page.evaluate(() => game.undo());
    await pointerPlay(page, tile);
    assert.equal(await page.evaluate(() => game.selectedIndex), 1);
    assert.deepEqual(await page.evaluate(() => game.players[0].discards), []);
    await pointerPlay(page, tile);
    assert.deepEqual(await page.evaluate(() => game.players[0].discards), [value]);
    await page.evaluate(() => { game.undo(); game.settings.discardMode = 'single'; });
    await pointerPlay(page, tile);
    assert.deepEqual(await page.evaluate(() => game.players[0].discards), [value]);
    await page.evaluate(() => {
        game.undo();
        game.players[0].hand = [0, 1, 2, 2, 3, 5, 6, 9, 12, 14, 18, 20, 23, 27, 29, 31];
        game.players[0].drawn = null;
        game.players[3].discards.push(2);
        game.claim = {seat: 3, tile: 2, humanOpt: game.claimOptions(0, 3, 2), order: [0, 1, 2], responses: new Map()};
        game.phase = 'claim';
        game.render();
    });
    assert.equal(await page.$$eval(`#playerHand ${choice}`, els => els.length), 0);
    await navigateTo(page, '#actionBar button[onclick*="chow"]');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => game.players[0].melds.at(-1).type), 'chow');
    assert.equal(await page.evaluate(() => game.turn), 0);
}

async function run() {
    const browser = await puppeteer.launch({headless: true, executablePath: process.env.GAME_CHROME,
        args: ['--no-sandbox', '--disable-dev-shm-usage']});
    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            let seed = 827;
            Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
        });
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        for (const viewport of [{width: 1366, height: 768}, {width: 820, height: 1180, isMobile: true, hasTouch: true},
            {width: 390, height: 844, isMobile: true, hasTouch: true}]) {
            await page.setViewport(viewport);
            for (const [name, check] of Object.entries({gongzhu, bigtwo, banqi, reversi, xiangqi, mahjong, 'mahjong-me': mahjong})) {
                await page.goto(pathToFileURL(path.resolve(__dirname, '../games', name + '.html')).href);
                await check(page);
                assert.deepEqual(errors, []);
                console.log(`${name} passed at ${viewport.width} × ${viewport.height}`);
            }
        }
    } finally {
        await browser.close();
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
