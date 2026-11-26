'use strict';

// 兩種麻將共用同一位教練。牌型、合法動作及可見張數都取自當局的規則引擎。
const MahjongCoach = {
    includeSpecialWaits(rows, counts, need, visible) {
        // 嚦咕嚦咕在聽牌時至少已有七對。接近這種牌型時，用正式胡牌規則補算進張。
        if (need !== 5 || counts.reduce((n, c) => n + Math.floor(c / 2), 0) < 7) return;
        for (const row of rows) {
            counts[row.t]--;
            const waits = Hand.waits(counts, need);
            counts[row.t]++;
            if (waits.length) {
                row.sh = 0;
                row.ukeire = waits.reduce((sum, t) => sum + 4 - visible[t], 0);
            }
        }
    },

    win(player, tile, action, selfDraw = false) {
        const counts = countsOf(player.hand);
        if (!selfDraw) counts[tile]++;
        const shape = Hand.isLiguLigu(counts, 5 - player.melds.length) ? '嚦咕嚦咕（七對加一刻）' : '五組面子和一對將';
        return [`${action}　${tileName(tile)}`, `這張牌讓您湊齊${shape}，現在就可以胡牌。`];
    },

    claim(game, player) {
        const { tile, humanOpt } = game.claim;
        if (game.phase === 'rob') return this.win(player, tile, '搶槓胡');
        if (humanOpt.win) return this.win(player, tile, '胡');
        const decision = MahjongAI.decideClaim(game, 0, humanOpt, tile, 'hard');
        const counts = countsOf(player.hand), need = 5 - player.melds.length;
        const before = Hand.shanten(counts, need);
        if (decision === 'pass') return ['過', `目前標準牌型為 ${before} 向聽，這次可用的副露無法縮短向聽數。`];
        const kong = decision === 'kong';
        const tiles = decision.combo || Array(kong ? 3 : 2).fill(tile);
        for (const t of tiles) counts[t]--;
        const after = kong ? Hand.shanten(counts, need - 1) : MahjongAI.bestAfterDiscard(counts, need - 1);
        const verb = kong ? '槓' : decision === 'pung' ? '碰' : '吃';
        const group = sortTiles([...tiles, tile]).map(tileName).join('、');
        const change = after === before ? `維持 ${before} 向聽` : `從 ${before} 向聽降到 ${after} 向聽`;
        let reason = `${kong ? '槓完補牌前' : '副露後再選擇打牌'}，標準牌型可${change}。`;
        if (!decision.combo && MahjongAI.isValueTile(game, 0, tile)) {
            reason += `胡牌時，這組牌可計 ${isDragon(tile) ? 1 : game.windTai(0, tile)} 台。`;
        }
        return [`${verb}　${group}`, reason];
    },

    discard(game, player) {
        const analysis = {};
        const t = MahjongAI.chooseDiscard(game, 0, 'hard', analysis);
        const [first, other] = analysis.ranked;
        const counts = countsOf(player.hand);
        counts[t]--;
        const waits = Hand.waits(counts, 5 - player.melds.length);
        let reason;
        if (waits.length) {
            const visible = MahjongAI.visibleCounts(game, 0);
            const unseen = waits.reduce((sum, x) => sum + 4 - visible[x], 0);
            reason = `打出後聽${waits.map(tileName).join('、')}，合計 ${unseen} 張未見。`;
        } else {
            reason = `打出後標準牌型為 ${first.sh} 向聽，能改善向聽的牌還有 ${first.ukeire} 張未見。`;
        }
        if (analysis.defending) reason += '依對手副露數和牌牆進度，這手優先比較放槍風險估值。';
        if (other) reason += `若改打${tileName(other.t)}，則為 ${other.sh} 向聽、${other.ukeire} 張有效牌未見。`;
        game.hintTile = t;
        game.selectedIndex = game.handDisplayOrder().lastIndexOf(t);
        game.renderHand();
        game.renderActions();
        return [`打${tileName(t)}`, reason];
    },

    onTurn(game, player) {
        const options = game.selfOptions(0);
        if (options.win) return this.win(player, player.drawn, '自摸', true);
        if (options.kongs.length) {
            const choice = MahjongAI.decideSelf(game, 0, 'hard');
            if (choice?.action === 'kong') {
                const kind = choice.kind === 'concealed' ? '暗槓' : '加槓';
                const tiles = choice.kind === 'concealed' ? '手中四張相同' : '摸到手上明刻的第四張';
                return [`${kind}　${tileName(choice.tile)}`, `${tiles}，可以開槓。引擎比較過直接打牌的向聽數，開槓後、補牌前的標準牌型至少一樣接近聽牌。`];
            }
        }
        return this.discard(game, player);
    },

    show(game) {
        if (game.autoWin && game.phase !== 'end') {
            game.showCenterBanner('自動胡牌中，想自己打可按「取消自動」', 'bg-violet-500 text-white');
            return;
        }
        const claim = game.phase === 'rob' || (game.phase === 'claim' && game.claim?.humanOpt);
        if (!claim && !(game.phase === 'turn' && game.turn === 0)) {
            game.showCenterBanner(game.phase === 'end' ? '本局已結束' : '輪到您作決定時可以請教教練', 'bg-slate-800 text-amber-300');
            return;
        }
        const player = game.players[0];
        const [move, reason] = claim ? this.claim(game, player) : this.onTurn(game, player);
        game.hintShown = true;
        document.getElementById('coachAdvice').textContent = `教練建議　${move}\n${reason}`;
    }
};
