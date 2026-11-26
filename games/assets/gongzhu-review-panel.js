class GongZhuReviewPanel {
    constructor(game) {
        this.game = game;
        this.modal = document.getElementById('reviewModal');
        this.visible = false;
        this.priority = -1;
    }

    dismiss() {
        this.controller?.abort();
        this.worker?.terminate();
        this.worker = null;
        this.controller = null;
        this.control = null;
        this.summary = null;
        this.review = null;
        this.visible = false;
        this.modal.classList.add('hidden');
        this.modal.classList.remove('flex');
    }

    prepare(summary) {
        if (this.summary === summary) return;
        this.dismiss();
        this.summary = summary;
        this.priority = -1;
        this.failure = '';
        try {
            this.review = new GongZhuReview(summary.reviewRecord);
        } catch (error) {
            this.failure = error.message;
            return;
        }
        const rows = summary.reviewRows ??= this.review.initialResults();
        for (const row of rows) for (const mode of ['guard', 'bot']) {
            if (row[mode]) delete row[mode].error;
        }
        if (rows.every(row => row.guard?.exact && row.bot.exact)) return;
        const controller = this.controller = new AbortController();
        const control = this.control = { signal: controller.signal, priority: -1 };
        const receive = (i, mode, value) => {
            if (controller.signal.aborted) return;
            rows[i][mode] = value;
            if (this.visible) {
                this.paintScore(i, mode);
                this.progress();
            }
        };
        const failed = message => {
            if (controller.signal.aborted) return;
            this.failure = message;
            if (this.visible) this.progress();
        };
        const local = () => this.review.run(rows, receive, control).catch(error => failed(error.message));
        // Local files may load scripts but browsers restrict file-origin workers.
        if (location.protocol === 'file:' || typeof Worker !== 'function') { local(); return; }
        try {
            const worker = this.worker = new Worker('assets/gongzhu-review-worker.js');
            worker.onmessage = ({ data }) => {
                if (controller.signal.aborted) return;
                if (data.error) failed(data.error);
                else if (!data.done) receive(data.i, data.mode, data.value);
                if (data.done || data.error) { worker.terminate(); this.worker = null; }
            };
            worker.onerror = event => {
                if (controller.signal.aborted) return;
                event.preventDefault();
                worker.terminate();
                this.worker = null;
                local();
            };
            worker.postMessage({ record: summary.reviewRecord, rows, priority: this.priority });
        } catch { local(); }
    }

    open(summary, retry = false) {
        if (retry) this.dismiss();
        this.prepare(summary);
        this.visible = true;
        const board = document.getElementById('scoreModal');
        board.classList.add('hidden');
        board.classList.remove('flex');
        this.modal.classList.remove('hidden');
        this.modal.classList.add('flex');
        const r = summary.reviewRecord;
        document.getElementById('reviewTitle').textContent = '第 ' + summary.round + ' 局複盤';
        document.getElementById('reviewSubtitle').textContent = `本局實得 ${this.game.signed(summary.scores.south)} 分 · 依四家手牌推演`;
        document.getElementById('reviewAnalysis').open = false;
        document.getElementById('reviewMore').open = false;
        const opponents = r.tricks.flat().filter(t => t.seat !== 'south').map(t => t.bot
            ? `模型${t.modelName ? ' ' + t.modelName : ''}（${t.bot === 'weak' ? '較弱' : '正常'}）` : '內建電腦');
        document.getElementById('reviewOpponents').textContent = [...new Set(opponents)].join('、');
        document.getElementById('reviewHands').innerHTML = this.review
            ? this.hands(r.seats.map(seat => r.hands[seat].map(GongZhuReview.card))) : '';
        const list = document.getElementById('reviewDecisions');
        list.replaceChildren();
        this.items = [];
        this.review?.decisions.forEach(({ state, actual, legal }, i) => {
            const item = document.createElement('details');
            item.className = 'gz-review-turn';
            item.name = 'gongzhu-decision';
            const before = state.trick.map(t => this.seat(t.p) + ' ' + this.face(t.c)).join('、') || '由您領出';
            item.innerHTML = `<summary class="gz-review-columns"><span><strong>第 ${state.history.length + 1} 墩</strong>
                <small>實出 ${this.face(actual)}</small></span><span data-score="bot"></span><span data-score="guard"></span></summary>
                <div class="gz-review-detail">
                    <p><b>當時桌面</b>　${before}</p>
                    <p><b>可出 ${legal.length} 張</b>　${legal.map(c => this.face(c)).join('　')}</p>
                    <details class="gz-review-remaining"><summary>當時四家餘牌</summary><div class="gz-review-hands">${this.hands(state.hands)}</div></details>
                    ${['bot', 'guard'].map(mode => `<details class="gz-review-line" data-line="${mode}">
                        <summary>${mode === 'bot' ? '對本局 BOT' : '對最佳防守'}的打法 <b></b></summary><ol></ol></details>`).join('')}
                </div>`;
            const lines = [...item.querySelectorAll('[data-line]')];
            for (const line of lines) line.addEventListener('toggle', () => {
                if (line.open && this.visible && this.items[i] === item) this.paintScore(i, line.dataset.line);
            });
            item.addEventListener('toggle', () => {
                if (!item.open || !this.visible || this.items[i] !== item) return;
                this.priority = i;
                if (this.control) this.control.priority = i;
                this.worker?.postMessage({ priority: i });
            });
            list.appendChild(item);
            this.items.push(item);
            this.paintScore(i, 'bot');
            this.paintScore(i, 'guard');
        });
        // Keep the advice steady while it is being read. Reopening the round
        // picks up deeper results; the expanded analysis updates live.
        this.paintCoaching();
        this.progress();
        this.modal.querySelector('.gz-review-body').scrollTop = 0;
    }

    seat(p) {
        const seat = this.summary.reviewRecord.seats[p];
        return seat === 'south' ? '南家（您）' : this.game.PLAYERS[seat].label;
    }

    face(c) {
        const { suit, label } = GongZhuReview.deck[c];
        return this.game.SUITS[suit].symbol + label;
    }

    suitName(c) {
        return this.game.SUITS[GongZhuReview.deck[c].suit].name;
    }

    plan(end) {
        const me = this.review.me, deck = GongZhuReview.deck;
        const hand = this.summary.reviewRecord.hands.south.map(GongZhuReview.card);
        const turns = end.history.map((trick, i) => {
            const at = trick.findIndex(t => t.p === me);
            return { trick, n: i + 1, card: trick[at].c, lead: trick[0].c, winner: GongZhuAI.winner(trick),
                ahead: at ? GongZhuAI.winner(trick.slice(0, at)).c : null };
        });
        const sweep = end.piles.findIndex(pile => GongZhuAI.newCap(pile).hearts === 13);
        if (sweep === me) {
            const first = turns.find(t => t.trick.some(play => deck[play.c].suit === 'H'));
            const lead = turns.find(t => t.n > first.n && t.trick[0].p === me && deck[t.lead].suit === 'H');
            return `這手可拚收全紅。先用 ${this.face(first.winner.c)} 收第一墩有紅心的牌，`
                + (lead ? `再領 ${this.face(lead.lead)} 把外面的紅心帶出來。` : '留住能贏墩的大牌，把剩下的紅心也收回來。');
        }
        const pig = GongZhuAI.PIG, sheep = GongZhuAI.SHEEP;
        const risk = sweep < 0 ? pig : sheep, prize = sweep < 0 ? sheep : pig;
        const cost = c => c === risk ? 100 : deck[c].suit === 'H' ? -HEART_POINTS[c - 13] : 0;
        const discard = turns.filter(t => t.winner.p !== me && cost(t.card) &&
            (deck[t.card].suit !== deck[t.lead].suit || (t.ahead !== null && t.ahead > t.card)))
            .sort((a, b) => cost(b.card) - cost(a.card))[0];
        const take = turns.find(t => t.winner.p === me && deck[t.lead].suit === deck[prize].suit && t.trick.some(play => play.c === prize) &&
            GongZhuAI.score(GongZhuAI.newCap(t.trick.map(play => play.c)), sweep >= 0) > 0);
        if (discard && (cost(discard.card) >= 30 || !take)) {
            const suit = this.suitName(discard.lead), face = this.face(discard.card);
            const flipped = discard.card === sheep ? `這條走法由${this.seat(sweep)}收全紅，羊會扣分。` : '';
            if (deck[discard.card].suit === deck[discard.lead].suit) {
                return flipped + `等別家的 ${this.face(discard.ahead)} 領先時再跟 ${face}，把這張扣分牌送出去。`;
            }
            const last = turns.slice(0, discard.n - 1).filter(t => deck[t.card].suit === deck[discard.lead].suit).at(-1);
            return flipped + (last ? `先出完${suit}，手上最後一張是 ${this.face(last.card)}。` : `起手就缺${suit}。`)
                + `等別家領${suit}時墊 ${face}，讓別家吃下。`;
        }
        if (take) {
            const win = this.face(take.winner.c), target = this.face(prize);
            const higher = deck.map((_, c) => c).filter(c => deck[c].suit === deck[prize].suit && c > prize && !hand.includes(c));
            const action = take.winner.c !== prize ? `把 ${win} 留給${this.suitName(prize)}，看準 ${target} 出場的那墩再搶。`
                : higher.length ? `手裡有 ${target}，記住外面的 ${higher.map(c => this.face(c)).join('、')}。等大牌出過再用 ${target} 收墩。`
                : `外面沒有比 ${target} 大的${this.suitName(prize)}，可以用它贏墩，把分數收回來。`;
            return sweep < 0 ? action : `這條走法由${this.seat(sweep)}收全紅，豬會變成加分牌。${action}`;
        }
        const bigSpade = hand.find(c => deck[c].suit === 'S' && c > pig);
        if (sweep < 0 && bigSpade !== undefined && !hand.includes(pig)) {
            return `♠Q 在別家手上。領牌時先走別門，等豬出過再用 ${this.face(bigSpade)} 搶回領牌權。`;
        }
        const short = ['S', 'C', 'D', 'H'].map(suit => hand.filter(c => deck[c].suit === suit))
            .filter(cards => cards.length && !cards.includes(prize) && !cards.includes(risk))
            .sort((a, b) => a.length - b.length)[0];
        if (!short) return `先出 ${this.face(turns[0].card)}，保留同花色的小牌，等有扣分牌上桌時用來讓墩。`;
        const suit = this.suitName(short[0]);
        const danger = hand.filter(c => !short.includes(c) && cost(c)).sort((a, b) => cost(b) - cost(a))[0];
        const clear = short.length === 1 ? `先出掉單張 ${this.face(short[0])}` : `找機會出完手上 ${short.length} 張${suit}`;
        return `${clear}。別家再領${suit}時，` + (danger === undefined ? '就能挑牌墊給別家。' : `就能墊掉 ${this.face(danger)}。`);
    }

    reason({ state, actual }, value) {
        const review = this.review, me = review.me, card = value.line[0];
        const played = review.followLine(state, value.played.line), better = review.followLine(state, value.line);
        const sweep = end => end.piles.findIndex(pile => GongZhuAI.newCap(pile).hearts === 13);
        const oldSweep = sweep(played), newSweep = sweep(better);
        if (newSweep === me && oldSweep !== me) {
            const missing = better.piles[me].find(c => GongZhuReview.deck[c].suit === 'H' && !played.piles[me].includes(c));
            return `原走法漏了 ${this.face(missing)}，改出後能連這張也收回來，湊齊 13 張紅心。`;
        }
        const top = state.trick.length ? GongZhuAI.winner(state.trick).c : null;
        let tactic = '';
        const suit = this.suitName(card), sameSuit = suit === this.suitName(actual);
        if (!sameSuit && state.hands[me].filter(c => this.suitName(c) === suit).length === 1) {
            tactic = `先出掉單張 ${this.face(card)}，下次遇到${suit}就能墊牌。`;
        } else if (top !== null) {
            if (suit !== this.suitName(top)) tactic = `手上缺${this.suitName(top)}，這墩可以墊牌。`;
            else if (card < top && actual > top) tactic = `跟在 ${this.face(top)} 之下就能讓墩。`;
            else if (actual < top && card > top) tactic = `${this.face(card)} 能壓過桌上的 ${this.face(top)}。`;
            else if (actual < card && card < top) tactic = `兩張都小於 ${this.face(top)}，先出大張可留下 ${this.face(actual)} 讓墩。`;
        }
        if (!tactic && sameSuit && card < actual && better.history.slice(state.history.length + 1).some(trick => GongZhuAI.winner(trick).c === actual)) {
            tactic = `先出小張，把 ${this.face(actual)} 留到後面贏墩。`;
        }
        if (!tactic && top === null && !sameSuit) {
            const winner = GongZhuAI.winner(better.history[state.history.length]);
            tactic = winner.p === me ? `改領${suit}能保住這墩的領牌權。` : `改領${suit}，讓${this.seat(winner.p)}接手領下一墩。`;
        }
        if (newSweep !== oldSweep && (oldSweep < 0 || newSweep < 0)) {
            const changed = newSweep < 0 ? GongZhuAI.SHEEP : GongZhuAI.PIG;
            if (better.piles[me].includes(changed) && played.piles[me].includes(changed)) {
                return tactic + (newSweep < 0 ? '拆散紅心就能保住 ♦J 的 100 分。'
                    : `${this.seat(newSweep)}收全紅，吃到的 ♠Q 會轉為加 100 分。`);
            }
        }
        // Rank cards that changed owner by their effect under the actual scoring
        // rules, including the multiplier and the special sweep settlements.
        const changes = [];
        for (const [end, other, gain] of [[better, played, true], [played, better, false]]) {
            for (const c of end.piles[me].filter(c => !other.piles[me].includes(c))) {
                const piles = end.piles.slice();
                piles[me] = piles[me].filter(k => k !== c);
                const effect = (review.score(end) - review.score({ piles })) * (gain ? 1 : -1);
                if (effect > 0) {
                    const trick = better.history.findIndex(tr => tr.some(t => t.c === c));
                    changes.push({ c, effect, gain, trick });
                }
            }
        }
        const here = state.history.length;
        const change = changes.sort((a, b) => Number(b.trick === here) - Number(a.trick === here) || b.effect - a.effect || a.trick - b.trick)[0];
        if (change) {
            const winner = GongZhuAI.winner(better.history[change.trick]);
            const when = change.trick === here ? '這墩' : `第 ${change.trick + 1} 墩`;
            if (!change.gain) {
                const multiplier = change.c === GongZhuAI.TRANS ? '，扣分也不會加倍' : '';
                return tactic + `${when}的 ${this.face(change.c)} 改由${this.seat(winner.p)}吃下${multiplier}。`;
            }
            return tactic + (winner.c === change.c ? `${when}能用 ${this.face(change.c)} 贏墩，把分數留給自己。`
                : `${when}能用 ${this.face(winner.c)} 收到 ${this.face(change.c)}。`);
        }
        if (oldSweep !== newSweep) {
            return tactic + (newSweep < 0 ? '紅心會分給不同家，豬羊照原來的牌值結算。' : `${this.seat(newSweep)}會收全紅，豬與羊的加扣分對調。`);
        }
        return tactic + `推演中，收到的計分牌合計從 ${value.played.score} 分提高到 ${value.score} 分。`;
    }

    paintCoaching() {
        const decisions = this.review?.decisions || [], rows = decisions.length ? this.summary.reviewRows : [];
        const first = rows[0]?.guard;
        const plan = document.getElementById('reviewPlan');
        plan.textContent = first?.line ? this.plan(this.review.followLine(decisions[0].state, first.line))
            : this.failure || (decisions.length ? '正在推演本局打法。' : '每墩都只有一張合法牌，依序跟牌即可。');
        const notes = rows.flatMap(({ guard }, i) => guard?.played ? [{ i, guard, gain: guard.score - guard.played.score }] : []);
        notes.sort((a, b) => b.gain - a.gain || a.i - b.i);
        const render = list => list.sort((a, b) => a.i - b.i).map(({ i, guard, gain }) => {
            const turn = decisions[i];
            return `<li><div><strong>第 ${turn.state.history.length + 1} 墩</strong>
                <span>實出 ${this.face(turn.actual)}，建議 <b>${this.face(guard.line[0])}</b></span>
                <small>${guard.exact ? '最佳防守下多' : '推估多'} ${gain} 分</small></div><p>${this.reason(turn, guard)}</p></li>`;
        }).join('');
        document.getElementById('reviewMistakes').innerHTML = render(notes.slice(0, 3));
        const more = document.getElementById('reviewMore');
        more.hidden = notes.length <= 3;
        if (!more.hidden) {
            more.querySelector('summary').textContent = `另有 ${notes.length - 3} 墩可改進`;
            more.querySelector('ol').innerHTML = render(notes.slice(3));
        }
        document.getElementById('reviewChoices').hidden = !decisions.length;
        document.getElementById('reviewEmpty').hidden = !!notes.length;
    }

    hands(hands) {
        return hands.map((hand, p) => {
            const groups = Object.keys(this.game.SUITS).map(suit => {
                const cards = hand.map(c => GongZhuReview.deck[c]).filter(c => c.suit === suit).sort((a, b) => b.rank - a.rank);
                return cards.length ? `<span class="${suit === 'H' || suit === 'D' ? 'red' : ''}">${this.game.SUITS[suit].symbol} ${cards.map(c => c.label).join(' ')}</span>` : '';
            });
            return `<div><strong>${this.seat(p)}</strong><div>${groups.join('') || '已出完'}</div></div>`;
        }).join('');
    }

    paintScore(i, mode) {
        const value = this.summary.reviewRows[i][mode], item = this.items[i];
        const cell = item.querySelector(`[data-score="${mode}"]`);
        const name = mode === 'bot' ? '對本局 BOT' : '對最佳防守';
        const score = value?.line ? this.game.signed(value.score) + ' 分' : '計算中';
        const qualifier = value?.line && !value.exact ? (mode === 'bot' ? '≥ ' : '約 ') : '';
        const status = value?.error ? '暫停' : value?.exact ? '已證最佳' : value?.line ? (mode === 'bot' ? '已找到' : '推估') : '';
        cell.innerHTML = `<strong>${qualifier}${score}</strong><small>${status}</small>`;
        cell.setAttribute('aria-label', [name, qualifier + score, status].join(' '));
        const line = item.querySelector(`[data-line="${mode}"]`);
        line.querySelector('b').textContent = value?.line ? '出 ' + this.face(value.line[0]) + ' · ' + score : score;
        if (!line.open || !value?.line) return;
        const state = this.review.decisions[i].state;
        const start = state.history.length, alreadyPlayed = state.trick.length;
        const s = this.review.followLine(state, value.line);
        line.querySelector('ol').innerHTML = s.history.slice(start).map((trick, offset) => {
            const who = t => this.seat(t.p).replace('（您）', '');
            const plays = trick.map((t, k) => {
                const previous = offset === 0 && k < alreadyPlayed;
                return `<span${previous ? ' class="gz-review-fixed" title="決策前已出"' : ''}>${who(t)} ${this.face(t.c)}</span>`;
            }).join('');
            return `<li><strong>第 ${start + offset + 1} 墩</strong><div>${plays}</div><small>${who(GongZhuAI.winner(trick))}收墩</small></li>`;
        }).join('');
    }

    progress() {
        const rows = this.summary.reviewRows || [];
        const values = rows.flatMap(row => [row.bot, row.guard]);
        const count = values.filter(v => v?.exact).length;
        const error = this.failure || values.find(v => v?.error)?.error;
        let text = rows.length ? `已證實 ${count} / ${values.length} 個分數` : '本局每次輪到您時都只有一張合法牌。';
        if (this.failure) text = this.failure;
        else if (error) text += '　' + error;
        else if (count < values.length) text += '　搜尋中，開局可能耗時較長。';
        const status = document.getElementById('reviewProgress');
        if (status.textContent !== text) status.textContent = text;
        document.getElementById('reviewRetry').hidden = !error;
    }
}
