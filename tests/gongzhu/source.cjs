'use strict';
const fs = require('node:fs'), path = require('node:path');
const games = path.resolve(__dirname, '../../games');
const page = fs.readFileSync(path.join(games, 'gongzhu.html'), 'utf8');
module.exports = [...page.matchAll(/<script(?: src="(assets\/[\w-]+\.js)")?>([\s\S]*?)<\/script>/g)]
    .filter(match => match[1] !== 'assets/interface.js')
    .map(match => match[1] ? fs.readFileSync(path.join(games, match[1]), 'utf8') : match[2]).join('\n');
