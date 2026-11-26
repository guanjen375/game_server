// 「午夜劇場」的牌型、計分與單人闖關。相同種子與操作可重現整場演出。
const MidnightTheatre = (() => {
    const suits = [
        { name: '黑桃', mark: '♠', red: false }, { name: '紅心', mark: '♥', red: true },
        { name: '梅花', mark: '♣', red: false }, { name: '方塊', mark: '♦', red: true }
    ];
    const rankName = rank => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] || String(rank);
    const face = card => suits[card.suit].mark + rankName(card.rank);
    // 底籌、底倍率，以及每次排練所加的籌碼與倍率。
    const hands = {
        high: ['高牌', 5, 1, 10, 1], pair: ['一對', 10, 2, 15, 1],
        twoPair: ['兩對', 20, 2, 18, 1], three: ['三條', 30, 3, 20, 2],
        straight: ['順子', 30, 4, 25, 2], flush: ['同花', 35, 4, 20, 2],
        house: ['葫蘆', 40, 4, 25, 2], four: ['四條', 60, 7, 30, 3],
        straightFlush: ['同花順', 100, 8, 35, 3], five: ['五條', 115, 12, 35, 3],
        flushHouse: ['同花葫蘆', 135, 14, 40, 3], flushFive: ['同花五條', 150, 16, 45, 3]
    };
    const jokers = [
        { name: '報幕人', price: 4, text: '每手倍率 +2。', effect: () => ['mult', 2] },
        { name: '雙簧搭檔', price: 5, text: '計分牌含同點數的兩張牌，倍率 +5。', effect: s => new Set(s.pips.map(c => c.rank)).size < s.pips.length && ['mult', 5] },
        { name: '燃心', price: 6, text: '每張計分紅心給予倍率 +3。', effect: s => ['mult', 3 * s.pips.filter(c => c.suit === 1).length] },
        { name: '夜鴉', price: 5, text: '每張計分黑牌給予籌碼 +14。', effect: s => ['chips', 14 * s.pips.filter(c => !suits[c.suit].red).length] },
        { name: '雜耍師', price: 5, text: '只打出 1 至 3 張牌，倍率 +5。', effect: s => s.count <= 3 && ['mult', 5] },
        { name: '鏡廳', price: 7, text: '打出五張同花色，倍率 ×1.8。', effect: s => s.flush && ['times', 1.8] },
        { name: '高帽客', price: 5, text: '每張計分的 J、Q、K 給予籌碼 +18。', effect: s => ['chips', 18 * s.pips.filter(c => c.rank >= 11 && c.rank <= 13).length] },
        { name: '聚光燈', price: 5, text: '每關第一手籌碼 +55。', effect: s => s.first && ['chips', 55] },
        { name: '月下安可', price: 7, text: '只剩最後一次出牌時，倍率 ×2。', effect: s => s.plays === 1 && ['times', 2] },
        { name: '連環鈴', price: 6, text: '打出順子或同花順，倍率 ×2。', effect: s => s.straight && ['times', 2] },
        { name: '票房掌櫃', price: 5, text: '每次過關多領 3 枚金幣。', tip: 3 },
        { name: '節拍器', price: 7, text: '牌型與本關上一手相同，倍率 ×1.6。', effect: s => s.previous === s.kind && ['times', 1.6] }
    ];
    const bosses = [
        { name: '短幕', text: '本關只有 3 次出牌。', plays: 3 },
        { name: '封緘', text: '本關只有 1 次棄牌。', discards: 1 },
        { name: '窄台', text: '手牌上限降為 6 張。', size: 6 },
        { name: '回音廳', text: '連續打出相同牌型，該手得分減半。', repeat: true },
        { name: '假面舞會', text: 'J、Q、K 的牌面籌碼歸零。', mute: c => c.rank >= 11 && c.rank <= 13 },
        { name: '冷光', text: '紅心與方塊的牌面籌碼歸零。', mute: c => suits[c.suit].red },
        { name: '逆光', text: '本關第一手得分減半。', opening: true },
        { name: '最後一夜', text: '只有 3 次出牌、1 次棄牌。', plays: 3, discards: 1 }
    ];
    const targets = [180, 330, 620, 1150, 2100, 3650, 5800, 8000];
    const blindNames = ['小盲注', '大盲注', '首領盲注'];
    const blindCount = targets.length * blindNames.length;
    function blind(step) {
        const act = Math.floor(step / 3), part = step % 3;
        return { act: act + 1, part, name: blindNames[part], boss: part === 2 ? bosses[act] : null,
            target: Math.ceil(targets[act] * [10, 14, 19][part] / 50) * 5 };
    }

    function evaluate(cards) {
        if (!cards.length || cards.length > 5) return null;
        const ranks = new Map();
        for (const card of cards) {
            if (!ranks.has(card.rank)) ranks.set(card.rank, []);
            ranks.get(card.rank).push(card);
        }
        const groups = [...ranks.values()].sort((a, b) => b.length - a.length || b[0].rank - a[0].rank);
        const values = [...ranks.keys()].sort((a, b) => a - b);
        const straight = values.length === 5 && (values[4] - values[0] === 4 || values.join(',') === '2,3,4,5,14');
        const flush = cards.length === 5 && cards.every(c => c.suit === cards[0].suit);
        const n = groups[0].length, m = groups[1]?.length;
        let kind, pips = cards;
        if (n === 5) kind = flush ? 'flushFive' : 'five';
        else if (n === 3 && m === 2) kind = flush ? 'flushHouse' : 'house';
        else if (straight && flush) kind = 'straightFlush';
        else if (n === 4) { kind = 'four'; pips = groups[0]; }
        else if (flush) kind = 'flush';
        else if (straight) kind = 'straight';
        else if (n === 3) { kind = 'three'; pips = groups[0]; }
        else if (n === 2 && m === 2) { kind = 'twoPair'; pips = groups[0].concat(groups[1]); }
        else if (n === 2) { kind = 'pair'; pips = groups[0]; }
        else { kind = 'high'; pips = groups[0]; }
        return { kind, pips, straight, flush };
    }

    class Run {
        constructor(seed) {
            this.seed = seed >>> 0;
            this.randomState = this.seed;
            this.step = 0;
            this.money = 4;
            this.cast = [0];
            this.levels = Object.fromEntries(Object.keys(hands).map(kind => [kind, 1]));
            this.deck = Array.from({ length: 52 }, (_, id) => ({ id, rank: id % 13 + 2, suit: Math.floor(id / 13), bonus: 0 }));
            this.actions = [];
            this.best = 0;
            this.total = 0;
            this.openBlind();
        }
        random() {
            this.randomState = (this.randomState + 0x6D2B79F5) >>> 0;
            let n = this.randomState;
            n = Math.imul(n ^ n >>> 15, n | 1);
            n ^= n + Math.imul(n ^ n >>> 7, n | 61);
            return ((n ^ n >>> 14) >>> 0) / 4294967296;
        }
        shuffle(list) {
            for (let i = list.length - 1; i > 0; i--) {
                const j = Math.floor(this.random() * (i + 1));
                [list[i], list[j]] = [list[j], list[i]];
            }
            return list;
        }
        openBlind() {
            this.blind = blind(this.step);
            this.phase = 'play';
            this.size = this.blind.boss?.size ?? 8;
            this.plays = this.blind.boss?.plays ?? 4;
            this.discards = this.blind.boss?.discards ?? 3;
            this.score = 0;
            this.last = null;
            this.reward = 0;
            this.shop = [];
            this.reroll = 2;
            this.stock = this.shuffle(this.deck.map(c => c.id));
            this.hand = [];
            this.draw();
        }
        draw() {
            while (this.hand.length < this.size && this.stock.length) this.hand.push(this.stock.pop());
        }
        preview(ids) {
            if (this.phase !== 'play' || !Array.isArray(ids) || !ids.length || ids.length > 5 ||
                new Set(ids).size !== ids.length || !ids.every(id => this.hand.includes(id))) return null;
            const info = evaluate(ids.map(id => this.deck[id]));
            const level = this.levels[info.kind] - 1;
            const [, base, rate, chipStep, multStep] = hands[info.kind];
            let chips = base + level * chipStep, mult = rate + level * multStep;
            const boss = this.blind.boss, effects = [];
            for (const c of info.pips) {
                if (!boss?.mute?.(c)) chips += (c.rank === 14 ? 11 : Math.min(10, c.rank)) + c.bonus;
            }
            const view = { ...info, count: ids.length, first: !this.last, previous: this.last?.kind, plays: this.plays };
            for (const id of this.cast) {
                const bonus = jokers[id].effect?.(view);
                if (!bonus || !bonus[1]) continue;
                const [type, amount] = bonus;
                if (type === 'chips') chips += amount;
                else if (type === 'mult') mult += amount;
                else mult *= amount;
                effects.push(jokers[id].name + (type === 'chips' ? ' 籌碼 +' : type === 'mult' ? ' 倍率 +' : ' 倍率 ×') + amount);
            }
            if ((boss?.repeat && view.previous === info.kind) || (boss?.opening && view.first)) {
                mult /= 2;
                effects.push(boss.name + ' 倍率減半');
            }
            mult = Number(mult.toFixed(6));
            return { kind: info.kind, scoring: info.pips.map(c => c.id), chips, mult, points: Math.floor(chips * mult + 1e-8), effects };
        }
        stockShop() {
            const available = this.shuffle(jokers.map((_, i) => i).filter(i => !this.cast.includes(i)));
            const card = { rank: 2 + Math.floor(this.random() * 13), suit: Math.floor(this.random() * 4), bonus: 25 };
            this.shop = [
                ...available.slice(0, 2).map(id => ({ kind: 'joker', id, price: jokers[id].price })),
                { kind: 'lesson', price: 5 }, { kind: 'card', card, price: 4 }
            ];
        }
        apply(event) {
            if (!event || typeof event !== 'object') return false;
            const { type } = event;
            let entry = { type };
            if (type === 'play' || type === 'discard') {
                const score = this.preview(event.cards);
                if (!score || (type === 'discard' && !this.discards)) return false;
                entry.cards = event.cards.slice();
                this.hand = this.hand.filter(id => !entry.cards.includes(id));
                if (type === 'play') {
                    this.plays--;
                    this.last = { ...score, cards: entry.cards };
                    this.score += score.points;
                    this.total += score.points;
                    this.best = Math.max(this.best, score.points);
                } else this.discards--;
                if (this.score >= this.blind.target) {
                    this.reward = 3 + this.blind.part + this.plays + Math.min(5, Math.floor(this.money / 5))
                        + this.cast.reduce((n, id) => n + (jokers[id].tip || 0), 0);
                    this.money += this.reward;
                    this.phase = this.step === blindCount - 1 ? 'won' : 'shop';
                    if (this.phase === 'shop') this.stockShop();
                } else {
                    this.draw();
                    if (!this.plays || !this.hand.length) this.phase = 'lost';
                }
            } else if (this.phase !== 'shop') return false;
            else if (type === 'next') {
                this.step++;
                this.openBlind();
            } else if (type === 'reroll') {
                if (this.money < this.reroll) return false;
                this.money -= this.reroll;
                this.reroll++;
                this.stockShop();
            } else if (type === 'buy') {
                const offer = Number.isInteger(event.slot) && this.shop[event.slot];
                if (!offer || this.money < offer.price) return false;
                if (offer.kind === 'joker') {
                    if (this.cast.length >= 5 || this.cast.includes(offer.id)) return false;
                    this.cast.push(offer.id);
                } else if (offer.kind === 'lesson') {
                    if (typeof event.hand !== 'string' || !Object.hasOwn(hands, event.hand)) return false;
                    this.levels[event.hand]++;
                    entry.hand = event.hand;
                } else this.deck.push({ id: this.deck.length, ...offer.card });
                this.money -= offer.price;
                this.shop[event.slot] = null;
                entry.slot = event.slot;
            } else if (type === 'sell' || type === 'move') {
                const index = this.cast.indexOf(event.joker);
                if (index < 0) return false;
                entry.joker = event.joker;
                if (type === 'sell') {
                    this.money += Math.floor(jokers[event.joker].price / 2);
                    this.cast.splice(index, 1);
                } else {
                    const to = index + event.by;
                    if (![1, -1].includes(event.by) || to < 0 || to >= this.cast.length) return false;
                    [this.cast[index], this.cast[to]] = [this.cast[to], this.cast[index]];
                    entry.by = event.by;
                }
            } else return false;
            this.actions.push(entry);
            return true;
        }
        save() { return JSON.stringify({ version: 1, seed: this.seed, actions: this.actions }); }
        static restore(text) {
            if (!text) return null;
            try {
                const data = JSON.parse(text);
                if (data.version !== 1 || !Number.isInteger(data.seed) || data.seed !== (data.seed >>> 0) || !Array.isArray(data.actions)) return null;
                const run = new Run(data.seed);
                return data.actions.every(action => run.apply(action)) ? run : null;
            } catch { return null; }
        }
    }
    return { Run, evaluate, suits, face, rankName, hands, jokers, blind, blindCount };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = MidnightTheatre;
