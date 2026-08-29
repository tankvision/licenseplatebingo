/* Runs the REAL phase() and toggle() out of index.html.

   The point is narrow: once a game is over the board must stop accepting taps.
   Without the guard the row still slides out and the local score still climbs
   while the write is refused and dropped — deck and scoreboard disagreeing with
   nothing on screen to explain it.

   Run:  node tests/freeze.js */
const fs=require('fs'), path=require('path');
const H=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const slice=(from,to,label)=>{
  const a=H.indexOf(from); if(a<0) throw new Error('missing '+label);
  const b=H.indexOf(to,a);  if(b<0) throw new Error('missing end of '+label);
  return H.slice(a,b);
};

const src =
  slice('function toggle(code){','/* ── share ── */','toggle') + '\n' +
  slice('const phase=()=>{','const inviteURL=','phase') + `
module.exports={toggle,phase,setGame:v=>{game=v}};`;

/* --- ambient: everything toggle() reaches for, stubbed to record --- */
const log=[];
global.claimed=new Map();
global.INDEX={MT:{name:'Montana',tier:'legend',pts:10}};
global.SHOUT={legend:{burn:true}};
global.game=null;
global.snack=m=>log.push('snack:'+m);
global.queue=(op,c)=>log.push('queue:'+op+':'+c);
for(const f of ['hideUndo','render','unlockCheck','holdDeck','renderProgress',
                'renderStats','save','burn','shout','showUndo','renderLists'])
  global[f]=()=>log.push(f);
global.document={querySelector:()=>null};

const M=new module.constructor();
M._compile(src,'lpb-freeze-extracted.js');
const S=M.exports;

let pass=0,fail=0;
const t=(name,got,want)=>{
  const ok=JSON.stringify(got)===JSON.stringify(want);
  ok?pass++:fail++;
  console.log((ok?'  ok  ':'  FAIL')+'  '+name+(ok?'':`\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
};
const at=ms=>new Date(Date.now()+ms).toISOString();
const setPhase=(startMs,endMs)=>S.setGame({id:'g',name:'T',starts_at:at(startMs),ends_at:at(endMs)});
const run=fn=>{ log.length=0; fn(); return log; };

console.log('\n── phase() reads the clock, not a flag ───────────────');
S.setGame(null);
t('no game at all',            S.phase(), 'none');
setPhase(3600e3, 7200e3);
t('before the start: lobby',   S.phase(), 'lobby');
setPhase(-3600e3, 3600e3);
t('inside the window: live',   S.phase(), 'live');
setPhase(-7200e3, -1);
t('past the end: over',        S.phase(), 'over');

console.log('\n── it flips on its own as the clock passes ends_at ───');
/* nothing fires a "game over" event; the 60s heartbeat just re-renders and
   phase() answers differently. Prove it changes with no state mutation. */
S.setGame({id:'g',name:'T',starts_at:at(-7200e3),ends_at:new Date(Date.now()+40).toISOString()});
t('still live a moment before', S.phase(), 'live');
const spun=Date.now()+60; while(Date.now()<spun);
t('over a moment later',        S.phase(), 'over');

console.log('\n── live: spotting works normally ─────────────────────');
setPhase(-3600e3, 3600e3);
global.claimed.clear();
let out=run(()=>S.toggle('MT'));
t('the plate is claimed',       global.claimed.has('MT'), true);
t('and it is queued',           out.filter(x=>x.startsWith('queue:')), ['queue:add:MT']);

console.log('\n── live: un-spotting works too ───────────────────────');
out=run(()=>S.toggle('MT'));
t('the plate is released',      global.claimed.has('MT'), false);
t('and the delete is queued',   out.filter(x=>x.startsWith('queue:')), ['queue:del:MT']);

console.log('\n── lobby is NOT frozen ───────────────────────────────');
/* deliberate: the server refuses a lobby spot and reconcile() rescues it once
   the game starts. Freezing here would break that rescue. */
setPhase(3600e3, 7200e3);
global.claimed.clear();
out=run(()=>S.toggle('MT'));
t('lobby spotting still works', global.claimed.has('MT'), true);

console.log('\n── over: the board is frozen ─────────────────────────');
setPhase(-7200e3, -3600e3);
global.claimed.clear();
out=run(()=>S.toggle('MT'));
t('nothing is claimed',         global.claimed.has('MT'), false);
t('nothing is queued',          out.filter(x=>x.startsWith('queue:')), []);
t('no celebration fires',       out.filter(x=>x==='shout'||x==='burn'), []);
t('the score is not touched',   out.filter(x=>x==='renderStats'), []);
t('it says why',                out.filter(x=>x.startsWith('snack:')).length, 1);

console.log('\n── over: un-spotting is frozen too ───────────────────');
/* the guard sits ABOVE the claimed.has() branch on purpose: remove_spot is
   refused after the grace just like add_spot, so a local delete would desync */
global.claimed.set('MT',Date.now());
out=run(()=>S.toggle('MT'));
t('the plate stays claimed',    global.claimed.has('MT'), true);
t('nothing is queued',          out.filter(x=>x.startsWith('queue:')), []);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
