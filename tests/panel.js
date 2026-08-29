/* Runs the REAL entryPanel() / boardHTML() out of index.html.

   `spots` was always world-readable, so this drill-in exposes nothing new —
   but it does render other people's data, so escaping and unknown-code
   handling matter, and your own row must stay inert.

   Run:  node tests/panel.js */
const fs=require('fs'), path=require('path');
const H=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const a=H.indexOf('let openEntry=null;'), b=H.indexOf('function actHTML(');
if(a<0||b<0) throw new Error('panel block not found');
const src=H.slice(a,b)+`
module.exports={entryPanel,boardHTML,toggleEntry,loadEntry,entryCache,
  open:()=>openEntry, setOpen:v=>{openEntry=v}};`;

/* --- ambient --- */
global.TIER={
  common:{color:'C1',label:'Common'}, uncommon:{color:'C2',label:'Uncommon'},
  rare:{color:'C3',label:'Rare'},     legend:{color:'C4',label:'Legendary'}};
global.ORDER=['common','uncommon','rare','legend'];
global.INDEX={
  MD:{name:'Maryland',tier:'common',pts:1},  DE:{name:'Delaware',tier:'common',pts:1},
  CA:{name:'California',tier:'uncommon',pts:2}, FL:{name:'Florida',tier:'uncommon',pts:2},
  AL:{name:'Alabama',tier:'rare',pts:5},     MT:{name:'Montana',tier:'legend',pts:10},
  ID:{name:'Idaho',tier:'legend',pts:10}};
global.live=c=>!!global.INDEX[c];
global.byName=(x,y)=>global.INDEX[x].name.localeCompare(global.INDEX[y].name);
global.esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
global.me={id:'me'};
global.board=null;
global.renderGame=()=>{};
let rpcMode='ok', rpcRows=[];
global.rpc=async()=>{
  if(rpcMode==='fail') throw new Error('network');
  return rpcRows;
};

const M=new module.constructor();
M._compile(src,'lpb-panel-extracted.js');
const S=M.exports;

let pass=0,fail=0;
const t=(name,got,want)=>{
  const ok=JSON.stringify(got)===JSON.stringify(want);
  ok?pass++:fail++;
  console.log((ok?'  ok  ':'  FAIL')+'  '+name+(ok?'':`\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
};
const settle=()=>new Promise(r=>setTimeout(r,20));
const R={entry_id:'e2',name:'Ellie',found:3,score:22};
const chips=h=>[...h.matchAll(/<s style="--rc:[^"]*">([A-Z0-9]+)<\/s>/g)].map(m=>m[1]);
const tiers=h=>[...h.matchAll(/<b>([A-Za-z]+)<\/b>/g)].map(m=>m[1]);

(async()=>{
console.log('\n── panel states ──────────────────────────────────────');
S.entryCache.clear();
t('nothing cached yet: loading', /Loading/.test(S.entryPanel(R)), true);
S.entryCache.set('e2',{err:true});
t('offline says so, not an error', /No signal/.test(S.entryPanel(R)), true);
S.entryCache.set('e2',{codes:[]});
t('empty board reads as empty',  /Nothing spotted/.test(S.entryPanel(R)), true);

console.log('\n── grouping: legendary first ─────────────────────────');
S.entryCache.set('e2',{codes:['MD','MT','CA','AL','ID','FL','DE']});
let h=S.entryPanel(R);
t('tier order is rarest first',  tiers(h), ['Legendary','Rare','Uncommon','Common']);
t('chips sorted by name inside', chips(h), ['ID','MT','AL','CA','FL','DE','MD']);
t('every plate appears once',    chips(h).length, 7);

console.log('\n── a code this build has never heard of ──────────────');
/* a plate added in a future version must not throw for someone on old code */
S.entryCache.set('e2',{codes:['MT','ZZ','QQ','MD']});
h=S.entryPanel(R);
t('unknown codes are dropped',   chips(h), ['MT','MD']);

console.log('\n── a board of nothing BUT unknown codes ──────────────');
S.entryCache.set('e2',{codes:['ZZ','QQ']});
t('degrades to the empty line',  /Nothing spotted/.test(S.entryPanel(R)), true);

console.log('\n── the scoreboard rows ───────────────────────────────');
global.board={rows:[
  {entry_id:'e2',name:'Ellie',found:3,score:22},
  {entry_id:'me',name:'Me',found:2,score:11},
  {entry_id:'e3',name:'<script>x</script>',found:1,score:4}]};
S.setOpen(null);
h=S.boardHTML();
t('others are buttons',          (h.match(/<button class="sbrow/g)||[]).length, 2);
t('you are not',                 /<div class="sbrow me/.test(h), true);
t('your row carries no data-entry', /class="sbrow me[^"]*"[^>]*data-entry/.test(h), false);
t('names are escaped',           /&lt;script&gt;/.test(h), true);
t('raw script never reaches the DOM', /<script>x<\/script>/.test(h), false);
t('nothing is expanded yet',     /aria-expanded="true"/.test(h), false);
t('and no panel is rendered',    /sbpanel/.test(h), false);

console.log('\n── opening one row ───────────────────────────────────');
S.setOpen('e2');
S.entryCache.set('e2',{codes:['MT','MD']});
h=S.boardHTML();
t('exactly one panel appears',   (h.match(/sbpanel/g)||[]).length, 1);
t('on the row that was opened',  /data-entry="e2" aria-expanded="true"/.test(h), true);
t('the other stays closed',      /data-entry="e3" aria-expanded="false"/.test(h), true);

console.log('\n── the panel carries no animation ────────────────────');
/* renderGame() rebuilds this markup on every realtime event and every 60s
   heartbeat; anything animated here would replay each time */
t('no inline transition',        /sbpanel[^>]*(transition|animation)/.test(h), false);

console.log('\n── toggling ──────────────────────────────────────────');
rpcRows=[{code:'MT'},{code:'MD'}];
S.setOpen(null); S.entryCache.clear();
S.toggleEntry('e2');
t('opens the tapped row',        S.open(), 'e2');
await settle();
t('and fetches their plates',    S.entryCache.get('e2').codes, ['MT','MD']);
S.toggleEntry('e2');
t('tapping again closes it',     S.open(), null);
S.toggleEntry('e3');
t('tapping another switches',    S.open(), 'e3');

console.log('\n── a failed refresh keeps what we had ────────────────');
S.entryCache.set('e2',{codes:['MT','MD']});
rpcMode='fail';
await S.loadEntry('e2');
t('the good list survives',      S.entryCache.get('e2').codes, ['MT','MD']);
S.entryCache.delete('e2');
await S.loadEntry('e2');
t('but a first failure marks it', S.entryCache.get('e2').err, true);
rpcMode='ok';

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
})();
