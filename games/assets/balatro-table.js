(() => {
    const { Run, hands, jokers, suits, rankName, face, blind, blindCount } = MidnightTheatre;
    const el = id => document.getElementById(id);
    const fmt = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 6 });
    const number = n => fmt.format(n);
    const saveKey = 'game_run:midnight-theatre:v1';
    const pipPositions = {
        2: '21 27', 3: '21 24 27', 4: '11 31 17 37', 5: '11 31 24 17 37',
        6: '11 31 14 34 17 37', 7: '11 31 22 14 34 17 37', 8: '11 31 22 14 34 26 17 37',
        9: '11 31 13 33 24 15 35 17 37', 10: '11 31 22 13 33 15 35 26 17 37'
    };
    function make(tag, cls, text) {
        const element = document.createElement(tag);
        if (cls) element.className = cls;
        if (text !== undefined) element.textContent = text;
        return element;
    }
    function freshRun() {
        const seed = window.crypto?.getRandomValues(new Uint32Array(1))[0] ?? Math.floor(Math.random() * 2 ** 32);
        return new Run(seed);
    }
    function readSave() {
        try { return localStorage.getItem(saveKey); }
        catch { return null; }
    }
    let saved = readSave();
    let run = Run.restore(saved) || freshRun();
    let sort = 'rank', lesson = 'pair', activeJoker = null;
    const selected = new Set();

    function save() {
        const data = run.save();
        try { localStorage.setItem(saveKey, data); saved = data; }
        catch { el('notice').textContent += ' 此瀏覽器暫時無法保存進度。'; }
    }
    function startRecording() {
        if (run.phase === 'lost' || run.phase === 'won') return;
        const current = run, offset = current.actions.length;
        window.GameRecorder?.begin(() => {
            if (current.actions.length === offset) return null;
            return {
                finished: current.phase === 'lost' || current.phase === 'won', version: 1,
                seed: current.seed, actionOffset: offset, actions: current.actions,
                blind: current.step + 1, phase: current.phase, score: current.score, best: current.best, total: current.total
            };
        });
    }
    function syncSave() {
        const raw = readSave();
        if (raw === saved) return false;
        const other = Run.restore(raw);
        saved = raw;
        if (!other) return false;
        window.GameRecorder?.end();
        run = other;
        selected.clear();
        if (el('jokerDialog').open) el('jokerDialog').close();
        if (el('restartDialog').open) el('restartDialog').close();
        startRecording();
        render('已接續其他分頁的進度。');
        return true;
    }
    function newGame() {
        if (syncSave()) return;
        window.GameRecorder?.end();
        run = freshRun();
        selected.clear();
        lesson = 'pair';
        startRecording();
        render();
        save();
    }

    function paintPortrait(target, id) {
        target.style.backgroundPosition = (id % 4) * 100 / 3 + '% ' + Math.floor(id / 4) * 50 + '%';
        target.setAttribute('aria-hidden', 'true');
    }
    function cardLabel(card) {
        return suits[card.suit].name + rankName(card.rank) + (card.bonus ? '，銀箔加 ' + card.bonus + ' 籌碼' : '');
    }
    function cardFace(card, playable) {
        const suit = suits[card.suit], rank = rankName(card.rank);
        const cardEl = make(playable ? 'button' : 'span', 'playing-card');
        cardEl.classList.toggle('red', suit.red);
        cardEl.classList.toggle('silver', Boolean(card.bonus));
        cardEl.setAttribute('aria-label', cardLabel(card));
        if (playable) {
            cardEl.type = 'button';
            cardEl.dataset.card = card.id;
            cardEl.dataset.gameChoice = 'true';
            cardEl.addEventListener('click', () => toggle(card.id));
        } else cardEl.setAttribute('role', 'img');
        const corner = make('span', 'corner', rank);
        corner.append(make('i', '', suit.mark));
        const bottom = corner.cloneNode(true);
        bottom.classList.add('bottom');
        let middle;
        if (card.rank === 14) middle = make('span', 'ace', suit.mark);
        else if (card.rank > 10) middle = make('span', 'court', ['♞', '♛', '♚'][card.rank - 11]);
        else {
            middle = make('span', 'pips');
            for (const [column, row] of pipPositions[card.rank].split(' ')) {
                const pip = make('i', Number(row) > 4 ? 'invert' : '', suit.mark);
                pip.style.gridColumn = column;
                pip.style.gridRow = row;
                middle.append(pip);
            }
        }
        cardEl.append(corner, middle, bottom);
        return cardEl;
    }
    function drawTicket() {
        const { act, part, name, boss, target } = run.blind;
        el('actNumber').textContent = '第 ' + act + ' 幕 ／ ' + blindCount / 3 + ' 幕';
        el('blindName').textContent = boss?.name || name;
        el('goal').textContent = number(target);
        el('score').textContent = number(run.score);
        el('goalMeter').max = target;
        el('goalMeter').value = Math.min(run.score, target);
        document.querySelectorAll('.route li').forEach((node, i) => {
            node.classList.toggle('passed', i < part);
            if (i === part) node.setAttribute('aria-current', 'step');
            else node.removeAttribute('aria-current');
        });
        el('bossRule').hidden = !boss;
        el('bossRule').textContent = boss?.text || '';
        for (const id of ['plays', 'discards', 'money']) el(id).textContent = number(run[id]);
        el('stock').textContent = number(run.stock.length);
    }
    function drawCast() {
        el('castCount').textContent = run.cast.length + ' / 5 席';
        const seats = run.cast.map(id => {
            const joker = jokers[id], button = make('button', 'cast-card');
            button.type = 'button';
            button.dataset.joker = id;
            button.title = joker.text;
            button.setAttribute('aria-label', joker.name + '，' + joker.text);
            const art = make('span', 'portrait');
            paintPortrait(art, id);
            button.append(art, make('b', '', joker.name));
            button.addEventListener('click', () => {
                activeJoker = id;
                drawJoker();
                el('jokerDialog').showModal();
            });
            return button;
        });
        while (seats.length < 5) {
            const empty = make('span', 'vacant');
            empty.setAttribute('aria-hidden', 'true');
            seats.push(empty);
        }
        el('cast').replaceChildren(...seats);
    }
    function drawJoker() {
        const id = activeJoker, joker = jokers[id], index = run.cast.indexOf(id);
        el('jokerTitle').textContent = joker.name;
        paintPortrait(el('jokerPortrait'), id);
        el('jokerText').textContent = joker.text;
        el('jokerTools').hidden = run.phase !== 'shop';
        el('moveLeft').disabled = index <= 0;
        el('moveRight').disabled = index === run.cast.length - 1;
        el('sellButton').textContent = '出售 ＋' + Math.floor(joker.price / 2) + ' 金幣';
    }
    function drawHand() {
        const cards = run.hand.map(id => run.deck[id]);
        cards.sort((a, b) => sort === 'rank'
            ? b.rank - a.rank || a.suit - b.suit || a.id - b.id
            : a.suit - b.suit || b.rank - a.rank || a.id - b.id);
        el('hand').replaceChildren(...cards.map(card => cardFace(card, true)));
        el('rankSort').setAttribute('aria-pressed', String(sort === 'rank'));
        el('suitSort').setAttribute('aria-pressed', String(sort === 'suit'));
        drawPreview();
    }
    function toggle(id) {
        if (selected.has(id)) selected.delete(id);
        else if (selected.size < 5) selected.add(id);
        else {
            el('notice').textContent = '每次最多出 5 張，點已選的牌可收回。';
            return;
        }
        drawPreview();
    }
    function drawPreview() {
        const score = run.preview([...selected]);
        for (const button of el('hand').children) {
            const id = Number(button.dataset.card);
            button.setAttribute('aria-pressed', String(selected.has(id)));
            button.classList.toggle('kicker', selected.has(id) && !score?.scoring.includes(id));
        }
        el('choice').textContent = score ? hands[score.kind][0] + ' · Lv.' + run.levels[score.kind] : '選 1 至 5 張牌';
        el('equation').textContent = score ? number(score.chips) + ' 籌碼 × ' + number(score.mult) + ' 倍 → ' + number(score.points) + ' 分' : '';
        const effects = score?.effects.slice() || [];
        if (score && score.scoring.length < selected.size) effects.unshift(score.scoring.map(id => face(run.deck[id])).join('、') + ' 計分');
        el('triggers').textContent = effects.join(' · ');
        el('triggers').hidden = !effects.length;
        el('playButton').disabled = !score;
        el('discardButton').disabled = !score || !run.discards;
    }
    function drawShop() {
        el('reward').textContent = '過關獎金 ＋' + run.reward + ' 金幣';
        const tiles = run.shop.map((offer, slot) => {
            if (!offer) return make('div', 'sold', '已售出');
            const tile = make('article', 'offer');
            let name, desc, art, picker;
            if (offer.kind === 'joker') {
                ({ name, text: desc } = jokers[offer.id]);
                art = make('span', 'offer-art portrait');
                paintPortrait(art, offer.id);
            } else if (offer.kind === 'lesson') {
                name = '牌型排練';
                desc = '選一種牌型升 1 級，提高底籌與倍率。';
                art = make('span', 'offer-art lesson-art', '劇');
                art.setAttribute('aria-hidden', 'true');
                picker = make('select');
                picker.setAttribute('aria-label', '要升級的牌型');
                for (const [kind, [label]] of Object.entries(hands)) picker.add(new Option(label + ' · Lv.' + run.levels[kind], kind));
                picker.value = lesson;
                picker.addEventListener('change', () => { lesson = picker.value; });
            } else {
                name = '銀箔 ' + face(offer.card);
                desc = '加入牌組，這張牌計分時多加 25 籌碼。';
                art = cardFace(offer.card, false);
                art.classList.add('offer-art');
            }
            tile.append(art, make('h3', '', name), make('p', '', desc));
            if (picker) tile.append(picker);
            const full = offer.kind === 'joker' && run.cast.length >= 5;
            const buy = make('button', 'action buy', full ? '席位已滿' : '購買 · ' + offer.price + ' 金幣');
            buy.disabled = full || run.money < offer.price;
            buy.type = 'button';
            buy.dataset.gameChoice = 'true';
            buy.dataset.slot = slot;
            buy.setAttribute('aria-label', name + '，' + buy.textContent);
            buy.addEventListener('click', () => {
                const message = offer.kind === 'lesson' ? hands[lesson][0] + ' 升到 Lv.' + (run.levels[lesson] + 1) : '已購入' + name;
                act({ type: 'buy', slot, hand: lesson }, message + '。');
            });
            tile.append(buy);
            return tile;
        });
        el('offers').replaceChildren(...tiles);
        el('rerollButton').textContent = '換貨 · ' + run.reroll + ' 金幣';
        el('rerollButton').disabled = run.money < run.reroll;
        const next = blind(run.step + 1);
        el('nextBlind').textContent = '下一關 · 第 ' + next.act + ' 幕' + next.name + (next.boss ? '「' + next.boss.name + '」' : '')
            + ' · 目標 ' + number(next.target) + ' 籌碼' + (next.boss ? '。' + next.boss.text : '');
        el('nextButton').textContent = '進入' + (next.boss?.name || next.name) + ' →';
    }
    function drawGuide() {
        el('guideHands').replaceChildren(...Object.entries(hands).map(([kind, [label, chips, mult, chipGain, multGain]]) => {
            const row = make('tr'), lv = run.levels[kind];
            row.append(make('td', '', label), make('td', '', String(lv)), make('td', '', number(chips + (lv - 1) * chipGain) + ' × ' + number(mult + (lv - 1) * multGain)));
            return row;
        }));
    }
    function handResult() {
        return run.last ? hands[run.last.kind][0] + '拿下 ' + number(run.last.points) + ' 分。' : '';
    }
    function render(message = '') {
        drawTicket();
        drawCast();
        const play = run.phase === 'play', shop = run.phase === 'shop';
        el('playPanel').hidden = !play;
        el('shopPanel').hidden = !shop;
        el('endPanel').hidden = play || shop;
        if (play) drawHand();
        else if (shop) drawShop();
        else {
            const won = run.phase === 'won';
            el('endHeading').textContent = won ? '八幕謝幕，通關！' : '本場落幕';
            el('endResult').textContent = (won ? '已闖過全部 ' + blindCount + ' 關。' : '第 ' + run.blind.act + ' 幕' + run.blind.name + '，距過關還差 ' + number(run.blind.target - run.score) + ' 分。')
                + '最高單手 ' + number(run.best) + ' 分，累計 ' + number(run.total) + ' 分。';
        }
        el('notice').textContent = message || handResult();
        if (el('rulesDialog').open) drawGuide();
    }
    function act(event, message = '') {
        if (syncSave() || !run.apply(event)) return;
        selected.clear();
        if (event.type === 'play' && run.phase === 'shop') lesson = run.last.kind;
        if (run.phase === 'won' || run.phase === 'lost') window.GameRecorder?.end();
        render(message);
        save();
        if (event.type === 'play' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
            const gain = el('gain');
            gain.textContent = '＋' + number(run.last.points);
            gain.animate?.([{ opacity: 1 }, { opacity: 1, offset: .6 }, { opacity: 0, transform: 'translateY(-8px)' }], 950);
        }
        if (document.documentElement.hasAttribute('data-keyboard-mode')) {
            if (event.type === 'play' && run.phase === 'shop') el('nextButton').focus();
            else if (run.phase === 'won' || run.phase === 'lost') el('againButton').focus();
        }
    }

    el('playButton').addEventListener('click', () => act({ type: 'play', cards: [...selected] }));
    el('discardButton').addEventListener('click', () => act({ type: 'discard', cards: [...selected] }, '已換掉 ' + selected.size + ' 張牌。'));
    el('rankSort').addEventListener('click', () => { sort = 'rank'; drawHand(); });
    el('suitSort').addEventListener('click', () => { sort = 'suit'; drawHand(); });
    el('nextButton').addEventListener('click', () => act({ type: 'next' }));
    el('rerollButton').addEventListener('click', () => act({ type: 'reroll' }, '商店已換貨。'));
    el('sellButton').addEventListener('click', () => {
        el('jokerDialog').close();
        act({ type: 'sell', joker: activeJoker }, '已出售' + jokers[activeJoker].name + '。');
    });
    for (const [id, by] of [['moveLeft', -1], ['moveRight', 1]]) {
        el(id).addEventListener('click', () => {
            act({ type: 'move', joker: activeJoker, by }, '已調整小丑觸發順序。');
            if (el('jokerDialog').open) drawJoker();
        });
    }
    el('rulesButton').addEventListener('click', () => { drawGuide(); el('rulesDialog').showModal(); });
    el('restartButton').addEventListener('click', () => el('restartDialog').showModal());
    el('confirmRestart').addEventListener('click', () => { el('restartDialog').close(); newGame(); });
    el('againButton').addEventListener('click', newGame);
    window.addEventListener('storage', event => { if (event.key === saveKey || event.key === null) syncSave(); });
    window.addEventListener('pageshow', () => syncSave());
    startRecording();
    render();
    if (saved !== run.save()) save();
})();
