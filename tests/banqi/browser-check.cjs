'use strict';
// Optional integration check of the real page/controller. Puppeteer is a test tool,
// not a game dependency: set BANQI_PUPPETEER to an existing installation if needed.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto'),assert=require('node:assert/strict');
const puppeteer=require(process.env.BANQI_PUPPETEER||'puppeteer');
const {positions}=require('./positions.cjs');
const {load,legal,snapshot,ROOT}=require('./harness.cjs');
const {replay}=require('./replay.cjs');
const args=process.argv.slice(2),opt=(k,f)=>args.includes(k)?args[args.indexOf(k)+1]:f;
(async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'banqi-browser-'));
    const browser=await puppeteer.launch({headless:true,executablePath:process.env.BANQI_CHROME||undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
    const result={browser:await browser.version(),sources:{},rows:[],errors:[]};
    try {
        for(const ref of ['27136d6','current']) {
            const html=ref==='current'?fs.readFileSync(opt('--source',path.join(ROOT,'games/banqi.html')),'utf8'):execFileSync('git',['show',`${ref}:games/banqi.html`],{cwd:ROOT,encoding:'utf8'});
            result.sources[ref]=createHash('sha256').update(html).digest('hex');
            const file=path.join(dir,`${ref}.html`);fs.writeFileSync(file,html);
            const page=await browser.newPage();page.on('pageerror',error=>result.errors.push(String(error)));
            await page.setRequestInterception(true);
            page.on('request',request=>request.url().startsWith('file:')?request.continue():request.abort());
            await page.goto(pathToFileURL(file).href,{waitUntil:'load'});
            await page.select('[data-setting="difficulty"]','hard');
            for(const id of ['opening','middlegame','cannon_screen','few_piece']) {
                const st=positions[id]();
                const row=await page.evaluate(({id,s})=>{
                    game.cancelAI();
                    game.state={board:Int8Array.from(s.b),pool:Int8Array.from(s.p),alive:Int8Array.from(s.a),hidden:s.h,quiet:s.q};
                    game.PLAYERS.north.color=0;game.PLAYERS.south.color=1;
                    game.PLAYERS.north.captured=[];game.PLAYERS.south.captured=[];
                    game.turn='north';game.gameOver=false;game.moveLog=[];game.positionHistory=[positionKey(game.state.board,0)];
                    let seed=827;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
                    const before=JSON.stringify(game.state),perform=game.performAction;
                    let action,restored;
                    game.performAction=function(seat,a,...rest){action=a;restored=JSON.stringify(this.state)===before;return perform.call(this,seat,a,...rest);};
                    const start=performance.now();game.executeAITurn();const ms=performance.now()-start;
                    game.performAction=perform;game.cancelAI();
                    return {id,level:game.settings.difficulty,action,restored,ms,stats:BanqiAI.lastSearch,turn:game.turn};
                },{id,s:JSON.parse(snapshot(st))});
                assert.equal(row.level,'hard');assert.equal(row.restored,true);assert.equal(row.turn,'south');
                legal(load(),st,0,row.action);
                result.rows.push({ref,...row});console.log(ref,id,row.action,Math.round(row.ms));
            }
            if(ref==='current') {
                await page.reload({waitUntil:'load'});
                const exported=await page.evaluate(async()=>{
                    game.cancelAI();game.settings.difficulty='hard';game.settings.firstMove='south';game.startRound();game.cancelAI();
                    game.performAction('south',{type:'flip',sq:0});game.cancelAI();game.executeAITurn();game.cancelAI();
                    let blob,filename;
                    const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
                    URL.createObjectURL=b=>{blob=b;return create.call(URL,b);};
                    HTMLAnchorElement.prototype.click=function(){filename=this.download;};
                    try {document.getElementById('exportRecord').click();}
                    finally {URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;}
                    return {filename,version:document.getElementById('aiVersion').textContent,record:JSON.parse(await blob.text())};
                });
                assert.equal(exported.filename,'banqi-round-1-move-2.json');
                assert.equal(exported.record.moves[1].analysis.level,'hard');
                assert.equal(exported.version,`AI ${exported.record.aiVersion}`);
                const replayed=replay(exported.record);
                assert.equal(snapshot(replayed.st),JSON.stringify({b:exported.record.state.board,p:exported.record.state.pool,a:exported.record.state.alive,h:exported.record.state.hidden,q:exported.record.state.quiet}));
                result.export=exported;
            }
            await page.close();
        }
        assert.deepEqual(result.errors,[]);
        fs.writeFileSync(opt('--out','/tmp/banqi-browser.json'),JSON.stringify(result,null,2)+'\n');
    } finally {await browser.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
