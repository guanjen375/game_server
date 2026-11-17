'use strict';
const { state, R, B } = require('./harness.cjs');

function pursuit(danger) {
    // A defined analogue, not a reconstruction of the incomplete screenshot.
    const pieces = { b2: R.king, b1: R.horse, a3: B.guard, c4: B.elephant };
    const hidden = ['a4', 'b4', 'd4', 'd3', 'a2', 'd2', 'a1'];
    const pool = [R.guard, R.rook, R.horse, B.guard, B.rook, B.pawn, B.pawn];
    if (danger === 'pawn') { pieces.b4 = B.pawn; hidden.splice(1, 1); pool.splice(pool.indexOf(B.pawn), 1); }
    if (danger === 'cannon') pieces.e3 = B.cannon;
    if (danger === 'recapture') pieces.c3 = B.king;
    return state(pieces, hidden, pool, 15);
}
const lastPieces = { b3: R.cannon, c3: R.horse, a4: R.elephant, g2: R.horse,
    d3: B.king, d2: B.guard, h4: B.guard, b2: B.rook, f1: B.rook, h1: B.elephant };
const positions = {
    pressure: () => pursuit(),
    safe_pressure: () => state({ b2:R.king, b1:R.horse, a3:B.guard, c4:B.elephant },
        ['a2','a4','d4','d3'], [B.pawn,R.horse,R.rook,B.horse], 35),
    pawn_danger: () => pursuit('pawn'),
    cannon_danger: () => pursuit('cannon'),
    recapture_danger: () => pursuit('recapture'),
    last_counter: () => state(lastPieces),
    hidden_backup: () => state(lastPieces, ['h3'], [R.cannon]),
    last_king: () => state({ b2:R.king,b1:R.rook,g1:R.horse,a4:R.pawn,c2:B.guard,d2:B.pawn,h4:B.guard,e2:B.horse,f2:B.horse }),
    last_target_trade: () => state({ b3: R.cannon, c3: R.pawn, a4: R.elephant, g2: R.horse, d3: B.guard, d2: B.rook }),
    cannon_shot: () => state({ a1: R.cannon, b1: R.pawn, d1: B.king, h4: B.pawn }),
    cannon_screen: () => state({ a1:R.cannon,b2:R.rook,d1:B.guard,d2:B.pawn,e1:B.pawn,h4:B.horse }),
    forced_trade: () => state({ b2:R.cannon,a2:B.guard,b1:B.guard,c2:B.pawn,b3:B.pawn,d2:B.king }),
    score_trade: () => state({ b3:R.cannon,c3:R.horse,e4:R.pawn,a4:R.elephant,h1:R.elephant,a1:R.rook,g4:R.rook,f1:R.pawn,d3:B.king,d2:B.guard,h4:B.guard }, [], [], 49),
    major_exchange: () => state({ b2: R.king, c2: B.guard, d2: B.rook, a4: R.pawn, h4: B.pawn }),
    pawn_king: () => state({ a1: R.pawn, b1: B.king, h4: B.horse }),
    few_piece: () => state({ a1: R.guard, b3: R.rook, d3: B.horse, h4: B.pawn }),
    long_pursuit: () => state({ a1:R.guard,c1:R.rook,h4:B.horse,g4:B.pawn }),
    points_win: () => state({ a1: R.elephant, b1: R.elephant, h4: B.guard }, [], [], 49),
    points_reset: () => state({ a1: R.rook, b1: B.pawn, h4: B.guard }, [], [], 49),
    points_draw: () => state({ a1: R.rook, h4: B.rook }, [], [], 49),
    opening: () => state({ b2: R.horse, g3: B.pawn },
        Array.from({length:32}, (_, i) => String.fromCharCode(97 + i % 8) + (4 - (i >> 3))).filter(s => s !== 'b2' && s !== 'g3'),
        [...[R, B].flatMap(c => Object.entries(c).flatMap(([t, p], i) => Array([1,2,2,2,2,2,5][i] - (p === R.horse || p === B.pawn ? 1 : 0)).fill(p)))]),
    middlegame: () => state({ a4:R.king, c4:B.rook, e4:R.cannon, h4:B.guard, b3:R.horse, d3:B.pawn,
        g3:B.king, a2:R.guard, e2:B.cannon, g2:R.pawn, c1:B.elephant, f1:R.rook },
        ['b4','f4','a3','f3','b2','d2','h2','a1','d1','h1'],
        [R.pawn,R.pawn,R.elephant,R.cannon,R.guard,B.pawn,B.pawn,B.cannon,B.horse,B.guard])
};
module.exports = { positions, pursuit };
