'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load,state,transform,decide,apply,terminal,moves,snapshot,sq,R,B} = require('./banqi/harness.cjs');
const {positions} = require('./banqi/positions.cjs');
const engine = options => load({ref:process.env.BANQI_REF,sourcePath:process.env.BANQI_SOURCE,nodes:250000,depth:3,...options});

for (const side of [0,1]) for (const mirror of [false,true]) {
    test(`keep a forced points win instead of resetting for a pawn: color=${side}, mirror=${mirror}`, () => {
        const api = engine({depth:2});
        const st = transform(state({b2:R.guard,a1:R.rook,h1:R.rook,c1:R.horse,b3:B.king,h4:B.horse,c2:B.pawn},[],[],47),side,mirror);
        const d=decide(api,st,side);
        assert.equal(d.action.type,'move');
        apply(api,st,side,d.action);assert.equal(st.quiet,48);
        // Every legal opponent reply is checked on the real board. No static evaluation
        // or assumption that the opponent cooperates is used to declare this a win.
        for(const m of moves(api,st,1-side)) {
            const next=api.Engine.cloneState(st);
            apply(api,next,1-side,{type:next.board[m&31]?'capture':'move',from:m>>5,to:m&31});
            assert.equal(next.quiet,49,'The opponent cannot reset the clock by capturing');
            apply(api,next,side,decide(api,next,side).action);
            assert.deepEqual(terminal(api,next,1-side),{winner:side,reason:'points'});
        }
    });
}

test('a quiet evasion at the leaf uses the actual 50-ply points result', () => {
    const api = engine();
    const st = state({b2:R.guard,a1:R.rook,h1:R.rook,b3:B.king,h4:B.horse},[],[],49);
    assert.ok(api.Engine.isAttackedBy(st,sq('b2'),1));
    assert.ok(api.Engine.capturedPoints(st,0)>api.Engine.capturedPoints(st,1));
    assert.equal(moves(api,st,0).filter(m=>st.board[m&31]).length,0);
    const before=snapshot(st), ctx=api.BanqiAI.getContext(1000);
    assert.equal(api.Engine.qsearch(st,0,-api.INF,api.INF,0,4,ctx),api.WIN_SCORE-1);
    assert.equal(snapshot(st),before);
    apply(api,st,0,decide(api,st,0).action);
    assert.deepEqual(terminal(api,st,1),{winner:0,reason:'points'});
});

test('quiet clock extensions restore the board on completion and abort', () => {
    const api=engine();
    const st=state({a1:R.king,a3:R.pawn,b2:R.rook,a4:B.cannon,h4:B.guard},[],[],49);
    for(const limit of [1,2,5,16,32]) {
        const before=snapshot(st),ctx=api.BanqiAI.getContext(1000);ctx.nodeLimit=limit;
        api.Engine.qsearch(st,0,-api.INF,api.INF,0,4,ctx);
        assert.equal(snapshot(st),before);
        if(limit>1)assert.ok(ctx.nodes>1,'The added quiet extension was actually reached');
    }
});

test('reveal candidate sets are invariant under color swaps and both reflections', () => {
    const api=engine();
    for(const make of Object.values(positions)) {
        const original=make(), selected=Array.from(api.Engine.flipSquares(original,false));
        for(const side of [0,1]) for(const mirror of [false,true]) for(const vertical of [false,true]) {
            const mask=(mirror?7:0)^(vertical?24:0);
            const st=transform(original,side,mirror,vertical);
            assert.deepEqual([...api.Engine.flipSquares(st,false)].sort((a,b)=>a-b),selected.map(s=>s^mask).sort((a,b)=>a-b));
        }
    }
});
