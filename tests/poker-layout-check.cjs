'use strict';
// Optional real-browser check. Use the same GAME_PUPPETEER and GAME_CHROME settings as records-browser-check.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const puppeteer = require(process.env.GAME_PUPPETEER || 'puppeteer');
const gameURL = name => pathToFileURL(path.resolve(__dirname, '../games', name + '.html')).href;

async function checkTable(page, stage) {
    for (const [width, height] of [[1472, 782], [1366, 768], [1024, 600], [390, 844], [320, 480], [568, 320]]) {
        await page.setViewport({width, height});
        await page.waitForFunction(() => Math.abs(document.body.getBoundingClientRect().height - innerHeight) < 1);
        const problems = await page.evaluate(() => {
            const failures = [];
            const root = document.documentElement;
            if (root.scrollHeight > innerHeight || root.scrollWidth > innerWidth) failures.push('page scrolls');
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            if (rect('#playBtn').bottom > innerHeight || rect('#panel-south').top < rect('.gz-mat').bottom - 1) {
                failures.push('table or actions clipped');
            }
            for (const card of document.querySelectorAll('#hand button')) {
                const r = card.getBoundingClientRect();
                if (document.elementFromPoint(r.left + 6, r.top + 18)?.closest('button') !== card) failures.push(card.dataset.card);
            }
            return failures;
        });
        assert.deepEqual(problems, [], `${stage} at ${width} × ${height}: ${problems.join(', ')}`);
    }
}

async function run() {
    const browser = await puppeteer.launch({headless: true, executablePath: process.env.GAME_CHROME,
        args: ['--no-sandbox', '--disable-dev-shm-usage']});
    try {
        const page = await browser.newPage();
        await page.emulateMediaFeatures([{name: 'prefers-reduced-motion', value: 'reduce'}]);
        await page.goto(gameURL('bigtwo'));
        await page.evaluate(() => {
            clearTimeout(game.timer);
            game.scheduleAI = () => {};
            game.soundOn = false;
            const deck = BigTwo.createDeck();
            const mine = 'C3 D3 C4 H5 D6 S7 C8 H8 H9 S10 DJ CK S2'.split(' ');
            const others = deck.filter(card => !mine.includes(card.id));
            const hands = [deck.filter(card => mine.includes(card.id)), others.slice(0, 13), others.slice(13, 26), others.slice(26)];
            game.round = new BigTwo.Round({hands});
            game.render();
        });
        await checkTable(page, 'opening');
        for (const id of ['C4', 'H5', 'D6', 'S7', 'C3']) {
            await page.$eval(`#hand button[data-card="${id}"]`, button => button.click());
        }
        await page.click('#playBtn');
        assert.deepEqual(await page.$$eval('#pile [data-card]', cards => cards.map(card => card.dataset.card)),
            ['C3', 'C4', 'H5', 'D6', 'S7']);
        await checkTable(page, 'five cards');

        await page.goto(gameURL('gongzhu'));
        const faces = await page.evaluate(() => ['H8', 'H10', 'H13', 'S12', 'D11', 'C10'].map(id => {
            const rank = Number(id.slice(1));
            const card = {id, suit: id[0], rank, label: ({11: 'J', 12: 'Q', 13: 'K'})[rank] || String(rank)};
            return game.createCardElement(card).textContent;
        }));
        assert.deepEqual(faces, ['8♥♥', '10♥♥', 'K♥♥', 'Q♠🐷', 'J♦🐑', '10♣⚡']);
        console.log('Poker table layout, five-card selection and card faces passed.');
    } finally {
        await browser.close();
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
