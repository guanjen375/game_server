const HEART_POINTS = [-2, -3, -10, -5, -6, -7, -8, -9, -10, -20, -30, -40, -50]; // ♥2 到 ♥A

/**
 * 拱豬電腦 AI：記牌（每張出過的牌、誰缺哪一門），把還沒出現的牌依缺門隨機發給其他三家，
 * 每張能出的牌都把這一局模擬打完許多次，用正式計分（豬、羊、變壓器、收全紅、全吃）算出四家分數，
 * 選「自己的分數減掉另外三家平均」最高的那張。三家對手一樣重要，累計名次不影響出牌。
 * 牌以整數表示：花色 S=0 H=1 C=2 D=3，c = 花色 * 13 + (點數 - 2)
 */
const GongZhuAI = {
    SUIT_INDEX: { S: 0, H: 1, C: 2, D: 3 },
    SPADE_SEVEN: 5, PIG: 10, SHEEP: 48, TRANS: 34,
    BUDGET_MS: 160, MIN_SAMPLES: 24, MAX_SAMPLES: 400,
    // 電腦估「自己收全紅」原本太樂觀，沒收成就抱著紅心連豬和變壓器一起賠。拿 538 局實際對局對過之後修了兩處：
    //  1. sweepForecast：已經吃到的紅心張數原本直接當成機率（吃到 8 張就當成六成），實際上電腦說六成多的時候
    //     只收成兩成、說八成多的時候只收成三成。現在張數只算 OWN_SWEEP_SHARE，手上有大紅心可領才往上加。
    //  2. playout：模擬裡有一半的對手只顧閃分、不會去擋，模擬出來的收成比例（35%）比實際（23%）高出一半。
    //     現在被吃走的紅心全在自己手上時，模擬裡的對手都照分差打，會去擋（改完是 26%）。
    // 只修「自己收」。別家在收的機率照舊，寧可高估，才會去擋。
    OWN_SWEEP_SHARE: 0.3,
    RANK_COUNT: (() => {
        const count = new Uint8Array(1 << 13);
        for (let mask = 1; mask < count.length; mask++) count[mask] = 1 + count[mask & (mask - 1)];
        return count;
    })(),

    toInt(card) { return this.SUIT_INDEX[card.suit] * 13 + card.rank - 2; },

    randomFrom(seed) {
        return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    },

    /**
     * view：{ me, legal, hand, trick: [{ p, card }], history: [[{ p, card } x4]], captured: [[card] x4], totals }
     * 座位以出牌順序 0~3 表示；回傳 legal 裡的一張牌
     */
    choose(view, analysis, random = Math.random) {
        const legal = view.legal;
        if (analysis) analysis.legalCount = legal.length;
        if (legal.length <= 1) return legal[0];
        const me = view.me;
        const match = { totals: view.totals ?? [0, 0, 0, 0] };
        const hand = view.hand.map(c => this.toInt(c));
        const trick = view.trick.map(t => ({ p: t.p, c: this.toInt(t.card) }));
        // 每家已出的張數、缺門
        const played = new Array(4).fill(0);
        const voids = [0, 0, 0, 0];             // bit s = 這家沒有花色 s
        const seen = new Uint8Array(52);          // 自己的牌 + 出過的牌
        const live = [8191, 8191, 8191, 8191];    // 每門尚未打出的 13 個點數，包含自己的牌
        const cap = view.captured.map(list => this.newCap(list.map(c => this.toInt(c))));
        const pastCap = [0, 1, 2, 3].map(() => this.newCap([]));
        const shown = [[], [], [], []];
        const clues = [[], [], [], []];
        for (const c of hand) seen[c] = 1;
        const noteTrick = tr => {
            const lead = Math.floor(tr[0].c / 13);
            for (let i = 0; i < tr.length; i++) {
                const t = tr[i];
                // 末家看得到計分墩會落到誰手上。他當時選擇吃或閃，可以協助推測剩下的牌。
                if (i === 3 && t.p !== me && tr.some(x => this.isScoring(x.c))) {
                    const recent = clues[t.p];
                    recent.push({ p: t.p, card: t.c, start: shown[t.p].length, trick: tr.slice(0, i),
                        cap: pastCap.map(c => ({ ...c })), live: live.slice(), voids: voids.slice() });
                    if (recent.length > 2) recent.shift();
                }
                shown[t.p].push(t.c);
                seen[t.c] = 1;
                live[Math.floor(t.c / 13)] &= ~(1 << (t.c % 13));
                played[t.p]++;
                if (Math.floor(t.c / 13) !== lead) voids[t.p] |= 1 << lead;
            }
            if (tr.length === 4) {
                const w = this.winner(tr).p;
                const before = pastCap[w].hearts;
                for (const t of tr) this.addCap(pastCap[w], t.c);
                if (pastCap[w].hearts > before) {
                    pastCap[w].heartTricks++;
                    cap[w].heartTricks++;
                }
            }
        };
        for (const tr of view.history) noteTrick(tr.map(t => ({ p: t.p, c: this.toInt(t.card) })));
        if (trick.length) noteTrick(trick);
        // 首家公開持有 ♠7。它還沒出現時，只把其餘未知牌分給三家。
        const opener = view.history[0]?.[0].p ?? trick[0]?.p ?? me;
        const reserveSeven = !seen[this.SPADE_SEVEN];
        if (reserveSeven) seen[this.SPADE_SEVEN] = 1;
        const unseen = [];
        for (let c = 0; c < 52; c++) if (!seen[c]) unseen.push(c);
        const need = [0, 1, 2, 3].map(p => (p === me ? 0 : 13 - played[p]));
        if (reserveSeven) need[opener]--;
        const estimates = [];
        const pref = this.policy(me, hand, trick, cap, live, voids, match, 0, estimates);
        // 同花色、同分值，且桌面和對手都沒有夾在中間的牌，兩張的吃墩能力相同。
        const external = live.slice();
        for (const c of hand) external[Math.floor(c / 13)] &= ~(1 << (c % 13));
        for (const { c } of trick) external[Math.floor(c / 13)] |= 1 << (c % 13);
        const groups = new Map();
        for (const card of legal) {
            const c = this.toInt(card), suit = Math.floor(c / 13);
            const lower = external[suit] & ((1 << (c % 13)) - 1);
            const points = suit === 1 ? HEART_POINTS[c - 13] : 0;
            const key = c === this.PIG || c === this.SHEEP || c === this.TRANS ? c : [suit, lower, points].join('/');
            if (!groups.has(key) || c === pref) groups.set(key, card);
        }
        const options = Array.from(groups.values());
        if (analysis) analysis.options = options.length;
        if (options.length === 1) return options[0];
        const cands = options.map(c => this.toInt(c));
        const evidence = clues.flat();
        for (const e of evidence) e.known = shown[e.p].slice(e.start);
        const reference = Math.max(0, cands.indexOf(pref));
        const sums = new Float64Array(cands.length);
        const squares = new Float64Array(cands.length);
        let hands = [[], [], [], []];
        const layouts = hand.length === 2 && this.MAX_SAMPLES > 0 ? this.lastDeals(unseen, need, voids, me, hand) : null;
        const endings = hand.length === 3 ? new Map() : null;
        const t0 = Date.now();
        let totalWeight = 0, squaredWeight = 0, deals = 0;
        const sampled = new Float64Array(cands.length);
        for (let n = 0; n < (layouts ? layouts.length : this.MAX_SAMPLES); n++) {
            if (layouts) {
                hands = layouts[n];
            } else {
                if (n >= this.MIN_SAMPLES && Date.now() - t0 > this.BUDGET_MS) break;
                if (!this.deal(unseen, need, voids, me, hands, random)) break;
                hands[me] = hand;
            }
            if (reserveSeven) hands[opener].push(this.SPADE_SEVEN);
            const weight = this.dealWeight(hands, evidence, match);
            deals++;
            totalWeight += weight;
            squaredWeight += weight * weight;
            let values = sampled;
            if (layouts || endings) {
                const key = endings && hands.map(h => h.slice().sort((a, b) => a - b).join(',')).join('/');
                values = endings?.get(key);
                if (!values) {
                    values = this.endgame(hands, trick, cands, me, cap, match).map(row => row[me]);
                    if (endings) endings.set(key, values);
                }
            } else {
                // 每份假想牌局固定三位對手的打法，讓所有候選牌面對相同的回應風格。
                // 每八次發牌輪過三家偏重閃分或偏重分差的全部組合。
                const caution = [0, 0, 0, 0];
                for (let i = 0; i < 3; i++) {
                    if (n & (1 << i)) caution[(me + i + 1) % 4] = 0.75;
                }
                for (let i = 0; i < cands.length; i++) {
                    values[i] = this.playout(hands, trick, cands[i], me, cap, live, voids, match, caution);
                }
            }
            for (let i = 0; i < cands.length; i++) {
                const diff = values[i] - values[reference];
                sums[i] += weight * diff;
                squares[i] += weight * diff * diff;
            }
        }
        if (!totalWeight) return options[reference];
        // 兩張牌都在同一批發牌上比較。模擬只領先一點、而公牌明顯不利時，
        // 用兩者分差的一個標準誤調低估計；完整算到結算的殘局直接用實得分。
        const samples = totalWeight * totalWeight / squaredWeight;
        let best = reference, bestScore = 0;
        for (let i = 0; i < cands.length; i++) {
            let value = sums[i] / totalWeight;
            if (hand.length > 3 && samples > 1) {
                const variance = Math.max(0, squares[i] / totalWeight - value * value);
                const error = Math.sqrt(variance / (samples - 1));
                const publicGap = Math.max(0, estimates[cands[reference]] - estimates[cands[i]]);
                value -= Math.min(error, publicGap);
            }
            if (value > bestScore) { bestScore = value; best = i; }
        }
        if (analysis) {
            let other = best === 0 ? 1 : 0;
            for (let i = 0; i < sums.length; i++) {
                if (i !== best && sums[i] > sums[other]) other = i;
            }
            Object.assign(analysis, { deals, enumerated: !!layouts, other: options[other],
                gap: (sums[best] - sums[other]) / totalWeight });
        }
        return options[best];
    },

    newCap(list) {
        const c = { pig: false, sheep: false, trans: false, hearts: 0, heartSum: 0, heartTricks: 0 };
        for (const x of list) this.addCap(c, x);
        return c;
    },
    isScoring(c) { return (c >= 13 && c < 26) || c === this.PIG || c === this.SHEEP || c === this.TRANS; },

    dealWeight(hands, evidence, match) {
        let likelihood = 1;
        const values = [];
        for (const e of evidence) {
            const then = e.known.concat(hands[e.p]);
            const best = this.policy(e.p, then, e.trick, e.cap, e.live, e.voids, match, 0, values);
            if (best === e.card) continue;
            const cost = Math.max(0, values[best] - values[e.card]);
            likelihood *= 35 / (35 + cost);
        }
        // 玩家可能刻意讓分或保留贏張，每份符合跟牌紀錄的發牌都保留權重。
        return 0.2 + 0.8 * likelihood;
    },
    addCap(c, x) {
        if (x === this.PIG) c.pig = true;
        else if (x === this.SHEEP) c.sheep = true;
        else if (x === this.TRANS) c.trans = true;
        else if (x >= 13 && x < 26) { c.hearts++; c.heartSum += HEART_POINTS[x - 13]; }
    },
    // 正式結算以實收張數判斷全紅。估牌時也可以試算指定一家收齊剩餘紅心的分數。
    score(pile, roundAllHearts, allHearts = pile.hearts === 13, details = null) {
        if (allHearts) {
            const pigAndSheep = pile.pig && pile.sheep;
            if (pigAndSheep && pile.trans) {
                details?.push('16 張計分牌全吃 (+1000)');
                return 1000;
            }
            if (pigAndSheep || pile.trans) {
                details?.push(pile.trans ? '特殊規則 · 全紅加 ♣10 (+500)' : '特殊規則 · 全紅加豬羊 (+500)');
                return 500;
            }
        }
        if (pile.trans && !allHearts && !pile.hearts && !pile.pig && !pile.sheep) {
            details?.push('單吃 ♣10 (+50)');
            return 50;
        }

        const flipped = allHearts || roundAllHearts;
        const hearts = allHearts ? 200 : pile.heartSum;
        const pig = pile.pig ? (flipped ? 100 : -100) : 0;
        const sheep = pile.sheep ? (flipped ? -100 : 100) : 0;
        if (details) {
            if (allHearts) details.push('收全紅(+200)');
            else if (pile.hearts) details.push(`紅心×${pile.hearts}(${hearts})`);
            if (pig) details.push(flipped ? '豬變色(+100)' : '豬(-100)');
            if (sheep) details.push(flipped ? '羊變色(-100)' : '羊(+100)');
            if (!details.length) details.push('無計分牌 (0)');
            if (pile.trans) details.push('牌分 × 2');
        }
        return (hearts + pig + sheep) * (pile.trans ? 2 : 1);
    },

    winner(trick) {
        let w = trick[0];
        const lead = Math.floor(w.c / 13);
        for (const t of trick) if (Math.floor(t.c / 13) === lead && t.c > w.c) w = t;
        return w;
    },

    // 自己的分數減掉另外三家的平均。三家對手一樣重要，不看誰領先：罰分不會特地留給第一名，
    // 也不會只擋第一名收全紅。四家各加上累計總分後，每張候選牌的評分都差同一個常數，
    // 所以累計名次不影響出牌。
    standingValue(me, scores, taker = me, after = scores[taker]) {
        const own = me === taker ? after : scores[me];
        let sum = 0;
        for (let q = 0; q < 4; q++) {
            if (q === me) continue;
            sum += q === taker ? after : scores[q];
        }
        return own - sum / 3;
    },

    finalTotals(cap, match) {
        const allHearts = cap.some(c => c.hearts === 13);
        return cap.map((c, q) => match.totals[q] + this.score(c, allHearts));
    },

    // 各剩兩張牌時，三家最多只有 90 種分配，可以把符合缺門的發牌全部列出。
    lastDeals(unseen, need, voids, me, hand) {
        const layouts = [], hands = [[], [], [], []];
        hands[me] = hand;
        const assign = i => {
            if (i === unseen.length) {
                layouts.push(hands.map(h => h.slice()));
                return;
            }
            const c = unseen[i], suit = Math.floor(c / 13);
            for (let q = 0; q < 4; q++) {
                if (hands[q].length >= need[q] || (voids[q] & (1 << suit))) continue;
                hands[q].push(c);
                assign(i + 1);
                hands[q].pop();
            }
        };
        assign(0);
        return layouts;
    },

    // 最後三墩對每份可能的發牌逐手算到結算，每家都挑對自己分差最有利的續著。
    endgame(hands, trick, candidates, me, cap, match) {
        const finish = () => {
            const scores = this.finalTotals(cap, match);
            return scores.map((_, q) => this.standingValue(q, scores));
        };
        const lastTrick = w => {
            const suit = Math.floor(hands[w][0] / 13);
            for (let q = 0; q < 4; q++) {
                const c = hands[q][0];
                if (Math.floor(c / 13) === suit && c > hands[w][0]) w = q;
            }
            const previous = cap[w];
            cap[w] = { ...previous };
            for (const h of hands) this.addCap(cap[w], h[0]);
            const result = finish();
            cap[w] = previous;
            return result;
        };
        const search = (p, table) => {
            const h = hands[p];
            const suit = table.length ? Math.floor(table[0].c / 13) : -1;
            const mustFollow = suit >= 0 && h.some(c => Math.floor(c / 13) === suit);
            let best = null, bestCard = -1;
            for (let i = 0; i < h.length; i++) {
                if (mustFollow && Math.floor(h[i] / 13) !== suit) continue;
                const outcome = play(p, i, table);
                if (!best || outcome[p] > best[p] || (outcome[p] === best[p] && h[i] < bestCard)) {
                    best = outcome;
                    bestCard = h[i];
                }
            }
            return best;
        };
        const play = (p, i, table) => {
            const h = hands[p];
            const [card] = h.splice(i, 1);
            table.push({ p, c: card });
            let outcome;
            if (table.length === 4) {
                const w = this.winner(table).p;
                const previous = cap[w];
                cap[w] = { ...previous };
                for (const t of table) this.addCap(cap[w], t.c);
                if (h.length === 1) outcome = lastTrick(w);
                else if (h.length) outcome = search(w, []);
                else outcome = finish();
                cap[w] = previous;
            } else {
                outcome = search((p + 1) % 4, table);
            }
            table.pop();
            h.splice(i, 0, card);
            return outcome;
        };
        return candidates.map(card => play(me, hands[me].indexOf(card), trick));
    },

    /**
     * 依缺門把沒看到的牌隨機發給其他三家（限制最多的花色先發）；發不出來就回傳 false
     */
    deal(unseen, need, voids, me, hands, random = Math.random) {
        const order = unseen.slice();
        for (let attempt = 0; attempt < 30; attempt++) {
            for (let i = order.length - 1; i > 0; i--) {
                const j = Math.floor(random() * (i + 1));
                const x = order[i]; order[i] = order[j]; order[j] = x;
            }
            const elig = s => { let k = 0; for (let p = 0; p < 4; p++) if (p !== me && !(voids[p] >> s & 1)) k++; return k; };
            const e = [elig(0), elig(1), elig(2), elig(3)];
            order.sort((a, b) => e[Math.floor(a / 13)] - e[Math.floor(b / 13)]);
            const left = need.slice();
            for (let p = 0; p < 4; p++) hands[p] = [];
            let ok = true;
            for (const c of order) {
                const s = Math.floor(c / 13);
                let total = 0;
                for (let p = 0; p < 4; p++) if (p !== me && left[p] > 0 && !(voids[p] >> s & 1)) total += left[p];
                if (!total) { ok = false; break; }
                let r = random() * total;
                for (let p = 0; p < 4; p++) {
                    if (p === me || left[p] <= 0 || (voids[p] >> s & 1)) continue;
                    r -= left[p];
                    if (r < 0) { hands[p].push(c); left[p]--; break; }
                }
            }
            if (ok) return true;
        }
        return false;
    },

    /**
     * 從目前這一墩接著把整局打完（me 先出 first），比較結算後的四家累計總分。
     */
    playout(hands0, trick0, first, me, cap0, live0, voids0, match, caution) {
        const hands = hands0.map(h => h.slice());
        const cap = cap0.map(c => ({ ...c }));
        const live = live0.slice();
        const voids = voids0.slice();
        let trick = trick0.slice();
        let p = me;
        let card = first;
        for (;;) {
            const h = hands[p];
            h.splice(h.indexOf(card), 1);
            if (trick.length) {
                const lead = Math.floor(trick[0].c / 13);
                if (Math.floor(card / 13) !== lead) voids[p] |= 1 << lead;
            }
            trick.push({ p, c: card });
            live[Math.floor(card / 13)] &= ~(1 << (card % 13));
            if (trick.length === 4) {
                const w = this.winner(trick);
                const pile = cap[w.p];
                const before = pile.hearts;
                for (const t of trick) this.addCap(pile, t.c);
                if (pile.hearts > before) pile.heartTricks++;
                trick = [];
                p = w.p;
                if (!hands[p].length) break;
            } else {
                p = (p + 1) % 4;
            }
            if (!trick.length && hands[p].length === 2) {
                const lines = this.endgame(hands, trick, hands[p].slice(), p, cap, match);
                let best = lines[0];
                for (const line of lines) if (line[p] > best[p]) best = line;
                return best[me];
            }
            // 被吃走的紅心全在 me 手上時，偏重閃分的對手也改照分差打：真的對手不會放著 me 收全紅不擋
            // （數字見 OWN_SWEEP_SHARE 的說明）。別家在收的時候不動，各家照原本排好的打法。
            const alert = p !== me && cap[me].hearts > 0 && cap.every((c, q) => q === me || !c.hearts);
            card = this.policy(p, hands[p], trick, cap, live, voids, match, alert ? 0 : caution[p]);
        }
        return this.standingValue(me, this.finalTotals(cap, match));
    },

    // 同一家從第一張紅心起就可能收全紅。分散到兩家後，這局的豬羊牌值已確定。
    sweepForecast(p, held, outside, cap, voids, entryTrick) {
        let seat = -1;
        for (let q = 0; q < 4; q++) {
            if (!cap[q].hearts) continue;
            if (seat >= 0) return null;
            seat = q;
        }
        if (seat >= 0 && cap[seat].hearts === 13) return { seat, chance: 1, credit: 1 };

        // 自己有幾張連續最大的紅心可領，以及其餘三家一共有幾張紅心要跟。
        const masters = this.RANK_COUNT[held[1] >>> (32 - Math.clz32(outside[1]))];
        const otherHearts = this.RANK_COUNT[outside[1]];
        if (seat < 0) {
            if (!masters) return null;
            seat = p;
        }
        const pile = cap[seat];
        // 不同墩持續由同一家吃紅心，比一墩剛好吃到多張更值得留意。
        const repeats = Math.max(0, pile.heartTricks - 1);
        let chance = (pile.hearts + repeats) / (13 + repeats);
        let control = 0;
        if (masters) {
            // 大紅心能帶出幾張外面的紅心，取決於還有幾家能跟。還要取得並保持領牌權。
            const heartSeats = Math.max(1, voids.filter((mask, q) => q !== p && !(mask & (1 << 1))).length);
            const draws = masters * heartSeats;
            const exposed = Math.max(0, otherHearts - masters) + 1;
            control = (draws / (draws + exposed)) ** 2;
            // 評估實際出牌及回看歷史時，另算能否以旁門大牌上手，連收全部紅心。
            // 假設外面每張紅心等機會落到未缺門的各家，估計有一家比連續大牌更長的機率上界。
            if (entryTrick) {
                let blocked = heartSeats;
                for (let i = 0; i <= masters; i++) {
                    blocked *= (otherHearts - i) / ((i + 1) * heartSeats);
                }
                let entry = 1;
                if (entryTrick.length) {
                    const high = this.winner(entryTrick).c, suit = Math.floor(high / 13);
                    const higher = held[suit] >>> Math.max(high % 13 + 1, 32 - Math.clz32(outside[suit]));
                    if (!higher) {
                        let entrances = 0;
                        for (const s of [0, 2, 3]) {
                            if (outside[s] && held[s] >>> (32 - Math.clz32(outside[s]))) entrances++;
                        }
                        entry = 1 - 0.5 ** entrances;
                    }
                }
                control += (1 - control) * entry * Math.max(0, 1 - blocked);
            }
        }
        // 別家在收：照吃到的張數算，自己有大紅心能擋就調低。這裡不打折，寧可高估，
        // 才會去擋，也才會顧好自己的豬羊和變壓器。
        if (seat !== p) return { seat, chance: chance * (1 - control), credit: 1 };
        // 自己在收：外面的紅心只要被別家吃走一張就破局，所以吃到的張數要打折（credit）。
        // 手上沒有大紅心可領時只算 OWN_SWEEP_SHARE；大紅心領得動全部時照算。
        const credit = this.OWN_SWEEP_SHARE + (1 - this.OWN_SWEEP_SHARE) * control;
        chance *= this.OWN_SWEEP_SHARE;
        return { seat, chance: chance + (1 - chance) * control, credit };
    },

    // 各家模擬時只看自己的手牌及公牌，分別試算「紅心拆開」和「這家全紅」兩種分差。
    policy(p, hand, trick, cap, live, voids, match, caution = 0, values = null) {
        if (hand.length === 1) return hand[0];
        const lead = trick.length ? Math.floor(trick[0].c / 13) : -1;
        const follow = lead < 0 ? hand : hand.filter(c => Math.floor(c / 13) === lead);
        const legal = follow.length ? follow : hand;
        if (legal.length === 1) return legal[0];
        const held = [0, 0, 0, 0];
        for (const c of hand) held[Math.floor(c / 13)] |= 1 << (c % 13);
        const outside = live.map((mask, s) => mask & ~held[s]);
        const pigOut = Boolean(outside[0] & (1 << 10));
        const pref = this.normalPlay(hand, trick, pigOut);
        const sweep = this.sweepForecast(p, held, outside, cap, voids, values ? trick : null);
        const { totals } = match;
        const seat = sweep?.seat ?? -1;
        const chance = sweep?.chance ?? 0;
        if (caution > chance) return pref;
        const count = this.RANK_COUNT;
        const pigLive = Boolean(live[0] & (1 << 10));
        const sheepLive = Boolean(live[3] & (1 << 9));
        let heartPoints = 0;
        for (let r = 0; r < 13; r++) if (live[1] & (1 << r)) heartPoints += HEART_POINTS[r];
        const transformerSeat = cap.findIndex(c => c.trans);
        // 變壓器會再乘到後面的分數。按尚未分配的牌估計多出的一份得失，
        // 單吃的 +50 也要看其餘計分墩全部由別家吃走的機會。
        const outlook = (pile, flipped, collector, card) => {
            const now = this.score(pile, flipped, collector);
            // 收全紅又持有 ♣10 的分數已是固定獎勵。
            if (!pile.trans || collector) return now;
            const heart = card >= 13 && card < 26;
            const pig = Number(pigLive && card !== this.PIG);
            const sheep = Number(sheepLive && card !== this.SHEEP);
            const pointsLeft = flipped ? (pig - sheep) * 100
                : (sheep - pig) * 100 + heartPoints - (heart ? HEART_POINTS[card - 13] : 0);
            let value = now + pointsLeft / 4;
            if (!pile.hearts && !pile.pig && !pile.sheep) {
                const heartTricks = flipped ? 0 : (count[live[1]] - Number(heart)) / 3;
                value -= 50 * (1 - 0.75 ** (pig + sheep + heartTricks));
            }
            return value;
        };
        const ordinaryTotals = cap.map((c, q) => totals[q] + this.score(c, false, false));
        const sweepTotals = sweep && cap.map((c, q) => totals[q] + this.score(c, true, q === seat));
        const followers = 3 - trick.length;
        const suitSeats = live.map((_, s) => voids.filter((mask, q) => q !== p && !(mask & (1 << s))).length);
        // 後手已經缺門時，估計他能墊出的最大負分牌。只用外面還沒出現的牌。
        const risks = [];
        const discardRisk = s => {
            if (risks[s]) return risks[s];
            let ordinary = 0, flipped = 0;
            for (let i = 1; i <= followers; i++) {
                const q = (p + i) % 4;
                if (!(voids[q] & (1 << s))) continue;
                let loss = 0;
                if (s !== 1 && !(voids[q] & (1 << 1))) {
                    const share = 1 / suitSeats[1];
                    let noneHigher = 1;
                    for (let r = 12; r >= 0; r--) if (outside[1] & (1 << r)) {
                        loss += noneHigher * share * HEART_POINTS[r];
                        noneHigher *= 1 - share;
                    }
                }
                if (s !== 0 && pigOut && !(voids[q] & 1)) loss += (-100 - loss) / suitSeats[0];
                if (s !== 3 && (outside[3] & (1 << 9)) && !(voids[q] & (1 << 3))) flipped -= 100 / suitSeats[3];
                ordinary += loss;
            }
            risks[s] = { ordinary, flipped };
            return risks[s];
        };
        const withTable = cap.map(pile => {
            const after = { ...pile };
            for (const t of trick) this.addCap(after, t.c);
            return after;
        });
        const payoff = (taker, card, observer = p) => {
            const after = { ...withTable[taker] };
            this.addCap(after, card);
            const risk = discardRisk(lead < 0 ? Math.floor(card / 13) : lead);
            const multiplier = after.trans ? 2 : 1;
            const ordinary = this.standingValue(observer, ordinaryTotals, taker,
                totals[taker] + outlook(after, false, false, card) + risk.ordinary * multiplier);
            if (!sweep) return ordinary;
            let weight = chance;
            const heartsInTrick = after.hearts - cap[taker].hearts;
            if (heartsInTrick) {
                if (taker !== seat) return ordinary;
                // 這一墩吃下還沒收到的紅心裡的幾成，機率就往 1 靠近幾成。自己在收的時候同樣要打折
                // （sweepForecast 的 credit），除非這一墩就把 13 張收齊。
                const part = heartsInTrick / (13 - cap[seat].hearts);
                weight += (1 - weight) * (part < 1 ? sweep.credit : 1) * part;
            }
            // 保有領牌權可以繼續收紅心；是否有利仍由四家的分差決定。
            if (taker === seat && after.hearts < 13) weight += 0.1 * weight * (1 - weight);
            const collector = taker === seat;
            // 收全紅者已有豬或 ♣10，再吃羊只會維持或提高固定分數。
            const sheepRisk = collector && (after.pig || after.trans) ? 0 : risk.flipped * multiplier;
            const flipped = this.standingValue(observer, sweepTotals, taker,
                totals[taker] + outlook(after, true, collector, card) + sheepRisk);
            return ordinary + weight * (flipped - ordinary);
        };

        const winner = trick.length ? this.winner(trick) : null;
        const trickValue = card => {
            const wins = !winner || (Math.floor(card / 13) === lead && card > winner.c);
            const taker = wins ? p : winner.p;
            const unbeaten = payoff(taker, card);
            if (!followers) return unbeaten;
            const high = wins ? card : winner.c;
            const suit = Math.floor(high / 13);
            const overcards = this.RANK_COUNT[outside[suit] >>> (high % 13 + 1)];
            if (!overcards || !suitSeats[suit]) return unbeaten;

            // 後手只有大牌時得蓋，能閃時則看搶下和放過對他自己的分差。
            const undercards = count[outside[suit] & ((1 << (high % 13)) - 1)];
            const miss = 1 - 1 / suitSeats[suit];
            const noDuck = miss ** undercards;
            let pressure = 0, overtaken = 0;
            for (let i = 1; i <= followers; i++) {
                const q = (p + i) % 4;
                if (voids[q] & (1 << suit)) continue;
                const gain = payoff(q, card, q) - payoff(taker, card, q);
                const wants = 0.5 + 0.5 * gain / (30 + Math.abs(gain));
                const take = noDuck + (1 - noDuck) * wants;
                pressure += take;
                overtaken += take * payoff(q, card);
            }
            if (!pressure) return unbeaten;
            const holds = (1 - pressure / suitSeats[suit]) ** overcards;
            return holds * unbeaten + (1 - holds) * overtaken / pressure;
        };
        const ordinaryPool = heartPoints + 100 * (Number(sheepLive) - Number(pigLive));
        const flippedPool = 100 * (Number(pigLive) - Number(sheepLive)) + (p === seat ? 200 * count[live[1]] / 13 : 0);
        const nextTrick = ((1 - chance) * ordinaryPool + chance * flippedPool) / hand.length;
        const sheepOut = Boolean(outside[3] & (1 << 9));
        const hasPenalty = held[1] || (held[0] & (1 << 10));
        let best = pref, bestValue = -Infinity;
        for (const card of legal) {
            if (transformerSeat >= 0) {
                const q = transformerSeat;
                ordinaryTotals[q] = totals[q] + outlook(cap[q], false, false, card);
                if (sweep) sweepTotals[q] = totals[q] + outlook(cap[q], true, q === seat, card);
            }
            let value = trickValue(card);
            if (card === this.PIG || card === this.SHEEP) {
                // 留在手中還有機會自己吃；在全紅假設下也要算進變壓器與大滿貫。
                const kept = { ...cap[p] };
                this.addCap(kept, card);
                const ordinaryGain = totals[p] + outlook(kept, false, false, card) - ordinaryTotals[p];
                const flippedGain = sweep ? totals[p] + outlook(kept, true, p === seat, card) - sweepTotals[p] : 0;
                value -= ((1 - chance) * ordinaryGain + chance * flippedGain) / 4;
            }
            // 保留有機會吃正分的贏張；還有負分牌時，先清掉短門就有機會墊牌。
            const s = Math.floor(card / 13), bit = 1 << (card % 13);
            const unheld = count[outside[s]];
            if (unheld) {
                const strength = count[outside[s] & (bit - 1)] / unheld;
                let prize = 0;
                if (s === 3 && sheepOut && card > this.SHEEP) prize = 100;
                if (s === 0 && pigOut && card > this.PIG) prize = -100;
                value -= strength * (nextTrick + (1 - 2 * chance) * prize / (1 + unheld / 3));
                if (held[s] === bit && hasPenalty) value += (1 - chance) * 12 * unheld / (unheld + 3);
            }
            if (card === pref) value += 1;
            if (values) values[card] = value;
            if (value > bestValue) { bestValue = value; best = card; }
        }
        return best;
    },

    /**
     * 平常的出牌策略：能閃就閃，豬和有分的紅心先墊出去
     */
    normalPlay(hand, trick, pigOut) {
        if (!trick.length) return this.lead(hand, pigOut);
        const lead = Math.floor(trick[0].c / 13);
        let lo = -1, hi = -1;
        for (const c of hand) if (Math.floor(c / 13) === lead) { if (lo < 0 || c < lo) lo = c; if (c > hi) hi = c; }
        if (lo < 0) return this.discard(hand, pigOut);
        if (lo === hi) return lo;
        let win = trick[0].c, pts = 0, hasPig = false, hasSheep = false;
        for (const t of trick) {
            if (Math.floor(t.c / 13) === lead && t.c > win) win = t.c;
            if (t.c === this.PIG) hasPig = true;
            else if (t.c === this.SHEEP) hasSheep = true;
            else if (t.c >= 13 && t.c < 26) pts += HEART_POINTS[t.c - 13];
        }
        const last = trick.length === 3;
        // 手上有豬、桌上已有比豬大的黑桃：送豬
        if (lead === 0 && hand.includes(this.PIG) && win > this.PIG) return this.PIG;
        // 羊在桌上而且沒有豬、紅心不多：用最大的牌搶
        if (hasSheep && !hasPig && pts > -60 && hi > win) return hi;
        // 能閃就出不會贏的最大牌
        let duck = -1;
        for (const c of hand) if (Math.floor(c / 13) === lead && c < win && c > duck) duck = c;
        if (duck >= 0) return duck;
        // 閃不掉：最後一家而且沒有分數，就用最大的牌收下（豬除外）
        if (last && !hasPig && pts === 0) {
            for (let c = hi; c >= lo; c--) if (hand.includes(c) && c !== this.PIG) return c;
        }
        // 否則出最小的（期待後面的人蓋過）
        if (lo === this.PIG) { for (const c of hand) if (Math.floor(c / 13) === lead && c !== this.PIG) return c; }
        return lo;
    },

    lead(hand, pigOut) {
        let best = hand[0], bs = Infinity;
        for (const c of hand) {
            const s = Math.floor(c / 13), r = c % 13;
            let v = r;
            if (s === 1) v += 6;                                  // 紅心盡量晚出
            if (s === 0 && pigOut && r >= 10) v += 20;            // 豬還在外面：別領 ♠Q 以上
            if (c === this.PIG) v += 25;
            if (c === this.SHEEP) v += 15;
            if (c === this.TRANS) v += 4;
            if (v < bs) { bs = v; best = c; }
        }
        return best;
    },

    discard(hand, pigOut) {
        if (hand.includes(this.PIG)) return this.PIG;
        let best = hand[0], bs = -Infinity;
        for (const c of hand) {
            const s = Math.floor(c / 13), r = c % 13;
            let v = r;
            if (s === 1) v += 8 - HEART_POINTS[r] / 2;            // 優先墊高扣分的紅心
            if (s === 0 && r >= 11 && pigOut) v += 12;            // ♠K、♠A 在豬還沒出時很危險
            if (c === this.SHEEP) v -= 30;                        // 羊留給自己
            if (v > bs) { bs = v; best = c; }
        }
        return best;
    }
};
