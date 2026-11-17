'use strict';
const fs=require('node:fs'),{gunzipSync}=require('node:zlib');
const {load,decide}=require('./harness.cjs');
const args=process.argv.slice(2),opt=(k,f)=>args.includes(k)?args[args.indexOf(k)+1]:f;
const corpus=JSON.parse(gunzipSync(fs.readFileSync(opt('--corpus'))));
const config={ms:Number(opt('--ms',1000)),nodes:Number(opt('--nodes',0))||undefined,production:true,seed:827,refs:opt('--refs','27136d6,current').split(',')};
const result={config,sources:{},rows:[]};
for(const ref of config.refs) {
    const api=load({...config,ref:ref==='current'?undefined:ref,sourcePath:ref==='current'?opt('--source'):undefined});result.sources[ref]=api.sourceHash;
    for(const p of corpus.positions) {
        if(opt('--ids')&&!opt('--ids').split(',').includes(p.id))continue;
        const s=p.state,st={board:Int8Array.from(s.b),pool:Int8Array.from(s.p),alive:Int8Array.from(s.a),hidden:s.h,quiet:s.q};
        const row={ref,id:p.id,stage:p.stage,hidden:s.h,pieces:s.a.reduce((a,b)=>a+b,0),...decide(api,st,0,p.history)};
        result.rows.push(row);
        console.log(ref,p.id,row.notation,`depth=${row.moveDepth}/${row.flipDepth} max=${row.maxPly} reveals=${row.maxReveals}`,row.ms);
    }
}
fs.writeFileSync(opt('--out','/tmp/banqi-phase-bench.json'),JSON.stringify(result,null,2)+'\n');
