/* Runs the REAL sync module out of index.html against a fake server.

   Deliberately does not touch the live project: the schema has no delete_game
   (it would be a write surface anyone with a link could reach), so every live
   test run would strand a junk game in the table forever. supabase/verify.sql
   covers the server side against the real database, inside a rollback.

   Run:  node tests/sync3.js */
const fs=require('fs'), path=require('path');
const H=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const slice=(from,to,label)=>{
  const a=H.indexOf(from); if(a<0) throw new Error('missing '+label);
  const b=H.indexOf(to,a);  if(b<0) throw new Error('missing end of '+label);
  return H.slice(a,b);
};

/* the sync module, minus the two lines that reach for the DOM */
const src =
  slice('const SB_URL=','const gameEl=','keys') + '\n' +
  slice('const esc=s=>','async function getGame(','sync core') + `
module.exports={queue,reconcile,flush,rpc,
  state:()=>({outbox,synced:[...synced].sort()}),
  setMe:v=>{me=v}, setGame:v=>{game=v},
  spot:(c)=>claimed.set(c,Date.now()), unspot:(c)=>claimed.delete(c),
  setOutbox:v=>{outbox=v}, setSynced:v=>{synced=new Set(v)}};`;

/* --- ambient the module expects --- */
const mem={};
global.store={get:k=>k in mem?mem[k]:null,set:(k,v)=>{mem[k]=v}};
global.readJSON=(k,fb)=>{const r=mem[k];if(!r)return fb;try{return JSON.parse(r)}catch(e){return fb}};
global.INDEX={MD:{name:'Maryland',pts:1},GU:{name:'Guam',pts:40},
              WY:{name:'Wyoming',pts:10},MT:{name:'Montana',pts:10}};
global.live=c=>!!global.INDEX[c];
global.claimed=new Map();
global.totals=()=>({bonus:0});
global.renderGame=()=>{};
/* flush() reports late drops through snack(); capture them */
global.__snacks=[];
global.snack=m=>{global.__snacks.push(m)};
global.navigator={onLine:true};
global.game=null; global.me=null; global.outbox=[]; global.board=null;
global.synced=new Set();

/* --- fake server --- */
const server={spots:new Set(),calls:[],mode:'ok',burned:false};
global.fetch=async(url,opt)=>{
  const fn=String(url).split('/rpc/')[1]||String(url);
  const body=opt&&opt.body?JSON.parse(opt.body):{};
  server.calls.push(fn+':'+(body.p_code||''));
  if(server.mode==='offline') throw new TypeError('network');
  if(server.mode==='refuse'&&(fn==='add_spot'||fn==='remove_spot'))
    return {ok:false,status:403,text:async()=>JSON.stringify({message:'game has not started'})};
  if(server.mode==='refuse-ended'&&fn==='add_spot')
    return {ok:false,status:403,text:async()=>JSON.stringify({message:'game has ended'})};
  if(server.mode==='refuse-first'&&fn==='add_spot'&&!server.burned){
    server.burned=true;
    return {ok:false,status:403,text:async()=>JSON.stringify({message:'game has ended'})};
  }
  if(fn==='add_spot')    server.spots.add(body.p_code);
  if(fn==='remove_spot') server.spots.delete(body.p_code);
  const payload=fn==='scoreboard'?[]:fn==='recent_activity'?[]:{};
  return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
};

const M=new module.constructor();
M._compile(src,'lpb-sync-extracted.js');
const S=M.exports;

let pass=0,fail=0;
const t=(name,got,want)=>{
  const ok=JSON.stringify(got)===JSON.stringify(want);
  ok?pass++:fail++;
  console.log((ok?'  ok  ':'  FAIL')+'  '+name+(ok?'':`\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
};
const settle=()=>new Promise(r=>setTimeout(r,30));
const reset=()=>{ server.spots.clear(); server.calls.length=0; server.mode='ok'; server.burned=false;
  global.__snacks.length=0;
  global.claimed.clear(); S.setOutbox([]); S.setSynced([]);
  S.setMe({id:'e1',secret:'s1',name:'Me',game_id:'g1'});
  S.setGame({id:'g1',name:'T',starts_at:'2020-01-01',ends_at:'2030-01-01'}); };

(async()=>{
console.log('\n── happy path ────────────────────────────────────────');
reset();
S.spot('MT'); S.queue('add','MT',10); await settle();
t('spot reaches the server',        [...server.spots], ['MT']);
t('outbox drains',                  S.state().outbox.length, 0);
t('synced records it',              S.state().synced, ['MT']);

console.log('\n── un-spotting ───────────────────────────────────────');
S.unspot('MT'); S.queue('del','MT'); await settle();
t('the delete reaches the server',  [...server.spots], []);
t('outbox drains again',            S.state().outbox.length, 0);
t('synced forgets it',              S.state().synced, []);

console.log('\n── no signal: nothing is lost ────────────────────────');
reset();
server.mode='offline';
S.spot('MT'); S.queue('add','MT',10); await settle();
t('the spot waits in the outbox',   S.state().outbox.map(o=>o.code), ['MT']);
t('and never reached the server',   [...server.spots], []);

console.log('\n── signal returns ────────────────────────────────────');
server.mode='ok';
await S.flush(); await settle();
t('it flushes on the next try',     [...server.spots], ['MT']);
t('outbox is empty',                S.state().outbox.length, 0);

console.log('\n── a refusal is dropped, not retried forever ─────────');
/* refused means the server understood and said no; waiting cannot fix it, so
   it must leave the queue rather than block everything behind it */
reset();
server.mode='refuse';
S.spot('MT'); S.queue('add','MT',10); await settle();
t('the refused item leaves the queue', S.state().outbox.length, 0);
t('and is not marked synced',          S.state().synced, []);

console.log('\n── …and reconcile brings it back later ───────────────');
server.mode='ok';
S.reconcile(); await settle();
t('the plate lands once it can',    [...server.spots], ['MT']);

console.log('\n── a refusal cannot block the item behind it ─────────');
reset();
server.mode='refuse-first';
S.spot('MT'); S.queue('add','MT',10);
S.spot('WY'); S.queue('add','WY',10);
await settle();
t('the good one still gets through', [...server.spots], ['WY']);
t('nothing is left stuck',           S.state().outbox.length, 0);

console.log('\n── reconcile fixes a server-side ghost ───────────────');
/* synced says the server has it, the board says we removed it */
reset();
S.setSynced(['MT']);
S.reconcile();
t('it queues the delete',           S.state().outbox.map(o=>o.op+':'+o.code), ['del:MT']);
await settle();
t('synced is corrected',            S.state().synced, []);

console.log('\n── one pending op per plate ──────────────────────────');
reset();
server.mode='offline';
S.spot('MT');   S.queue('add','MT',10);
S.unspot('MT'); S.queue('del','MT');
t('last write wins, no pile-up',    S.state().outbox.map(o=>o.op+':'+o.code), ['del:MT']);
await settle();

console.log('\n── reconcile does not duplicate pending work ─────────');
reset();
server.mode='offline';
S.spot('WY'); S.queue('add','WY',10);
S.reconcile();
t('already-queued plate is not re-queued', S.state().outbox.map(o=>o.code), ['WY']);
await settle();   // let the offline flush finish, or it holds the `flushing` lock

console.log('\n── every board plate is now sync-eligible ────────────');
reset();
for(const c of ['MT','GU','WY','MD']) S.spot(c);
S.reconcile(); await settle();
t('states AND optional plates all sync', [...server.spots].sort(), ['GU','MD','MT','WY']);

console.log('\n── solo play never touches the network ───────────────');
reset(); S.setMe(null); S.setGame(null);
server.calls.length=0;
S.spot('MT'); S.queue('add','MT',10); S.reconcile(); await settle();
t('no calls made without an entry', server.calls, []);

console.log('\n── the end cutoff: reconcile stops asking ────────────');
/* a spot made AFTER the deadline can never be accepted, so re-queueing it
   every 60s forever just burns requests against a server that says no */
reset();
const ENDED={id:'g1',name:'T',starts_at:'2020-01-01',ends_at:new Date(Date.now()-5*60000).toISOString()};
S.setGame(ENDED);
global.claimed.set('MT',Date.now()-9*60000);   // 4 min before the end
global.claimed.set('WY',Date.now()-60000);     // 4 min after it
S.reconcile();
t('pre-deadline spot is still queued',   S.state().outbox.map(o=>o.code), ['MT']);
await settle();
t('and it still reaches the server',     [...server.spots], ['MT']);

console.log('\n── past the grace, nothing is queued at all ──────────');
reset();
S.setGame({id:'g1',name:'T',starts_at:'2020-01-01',
           ends_at:new Date(Date.now()-2*3600*1000).toISOString()});   // 2h ago > 1h grace
global.claimed.set('MT',Date.now()-3*3600*1000);   // made well inside the window
S.reconcile();
t('grace expired: reconcile is a no-op', S.state().outbox.length, 0);

console.log('\n── a legacy board (no timestamps) ────────────────────');
reset();
S.setGame(ENDED);
global.claimed.set('MT',null);          // saved before timestamps existed
S.reconcile();
t('null timestamp stays eligible',      S.state().outbox.map(o=>o.code), ['MT']);
await settle();

console.log('\n── the join cutoff ───────────────────────────────────');
/* joining used to push your whole history up: three months of solo hunting
   arriving as a head start. Only what you find from the join on counts. */
reset();
S.setMe({id:'e1',secret:'s1',name:'Me',game_id:'g1',joined_at:Date.now()-3600*1000});
global.claimed.set('MD',Date.now()-90*86400*1000);  // found in April
global.claimed.set('MT',Date.now()-1800*1000);      // found since joining
S.reconcile(); await settle();
t('pre-join history stays out',         [...server.spots], ['MT']);

console.log('\n── …but lobby spots still count ──────────────────────');
/* the cutoff is JOIN time, not game start: a spot made after you joined but
   before the game began is the documented lobby case and must survive */
reset();
const soon=Date.now()+3600*1000;
S.setMe({id:'e1',secret:'s1',name:'Me',game_id:'g1',joined_at:Date.now()-1800*1000});
S.setGame({id:'g1',name:'T',starts_at:new Date(soon).toISOString(),
           ends_at:new Date(soon+86400000).toISOString()});
global.claimed.set('WY',Date.now()-600*1000);   // after joining, before the start
S.reconcile();
t('lobby spot is queued, not discarded', S.state().outbox.map(o=>o.code), ['WY']);
await settle();

console.log('\n── a legacy board joining a game ─────────────────────');
reset();
S.setMe({id:'e1',secret:'s1',name:'Me',game_id:'g1',joined_at:Date.now()-3600*1000});
global.claimed.set('MD',null);          // no timestamp: definitely older than the join
S.reconcile();
t('untimed plates are pre-join history', S.state().outbox.length, 0);

console.log('\n── a late refusal is reported, not swallowed ─────────');
reset();
server.mode='refuse-ended';
S.spot('MT'); S.queue('add','MT',10);
S.spot('WY'); S.queue('add','WY',10);
await settle();
t('both refusals drop from the queue',  S.state().outbox.length, 0);
t('counted once for the whole flush',   global.__snacks.length, 1);
t('and it names the number',            global.__snacks[0], '2 plates missed the deadline');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
})();
