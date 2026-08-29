/* Proves the guards in dom.js actually fire.

   A passing static check is worthless if it would also pass on broken code, so
   each case here reintroduces one bug this app has already been bitten by and
   asserts dom.js rejects it. Every entry is a real regression, not a
   hypothetical — the comments in index.html explain what each one did.

   Run:  node tests/negtest.js */
const fs=require('fs'), cp=require('child_process'), os=require('os'), path=require('path');
const ROOT=path.join(__dirname,'..');
const SRC=path.join(ROOT,'index.html');
const H=fs.readFileSync(SRC,'utf8');
/* the mutated copy goes to the temp dir, never into the repo */
const TMP=path.join(os.tmpdir(),'lpb-negtest.html');

const cases=[
  /* the shake bugs */
  ['nomotion back to page-wide',
   s=>s.replace('.deck.nomotion, .deck.nomotion *{','body.nomotion *{')],
  ['nomotion applied to <body> again',
   s=>s.replace("deckEl.classList.add('nomotion')","document.body.classList.add('nomotion')")],
  ['resize re-measures without a width check',
   s=>s.replace('if(window.innerWidth!==lastW){ lastW=window.innerWidth; measureDeck(); }','measureDeck();')],

  /* layout and access */
  ['achievements moved back inside #groups',
   s=>s.replace('<div class="body" data-body="spotted"></div>',
                '<div class="body" data-body="ach"></div><div class="body" data-body="spotted"></div>')],
  ['keydown re-scoped to #groups',
   s=>s.replace("document.body.addEventListener('keydown'","document.getElementById('groups').addEventListener('keydown'")],
  ['unlock banners queued too close together',
   s=>s.replace('900+i*4700','900+i*2000')],

  /* iOS auto-zoom */
  ['input font-size back under 16px (iOS auto-zoom)',
   s=>s.replace('font-family:var(--sign);font-size:16px;text-align:left;',
                'font-family:var(--sign);font-size:15px;text-align:left;')],
  ['viewport zoom disabled instead of fixing the font-size',
   s=>s.replace('initial-scale=1,','initial-scale=1, maximum-scale=1,')],

  /* end-of-game behaviour */
  ['board still tappable after the game ends',
   s=>s.replace(/\n\s*if\(phase\(\)==='over'\) return snack\([^\n]*\n/,'\n')],
  ['nothing marks the frozen state visually',
   s=>s.replace("document.body.classList.toggle('frozen',p==='over');",'')],
  ['reconcile churns forever against a closed game',
   s=>s.replace('  if(gameClosed()) return;','')],
  ['reconcile re-queues spots the server will always refuse',
   s=>s.replace('    if(ts>ends) continue;','')],
  ['joining leaks your whole board again',
   s=>s.replace('    if(from&&ts<from) continue;','')],
  ['late drops go back to being silent',
   s=>s.replace("if(o.op==='add'&&/ended/i.test(err.message||'')) lateDropped++;",'')],
  ['late drops counted but never mentioned',
   s=>s.replace(/\n\s*if\(lateDropped\) snack\([^\n]*\n/,'\n')],
  ['client grace drifts away from the server',
   s=>s.replace('const GRACE_MS=3600*1000;','const GRACE_MS=48*3600*1000;')],

  /* the player panel */
  ['your own row opens a panel duplicating the Spotted list',
   s=>s.replace('if(mine) return `<div class="sbrow me','if(mine) return `<button class="sbrow me')],
  ['the panel animates, so it replays every 60s refresh',
   s=>s.replace('.sbpanel{margin:0 0 0 11px;','.sbpanel{transition:max-height .3s ease;margin:0 0 0 11px;')],
];

let ok=0,bad=0;
for(const [name,mutate] of cases){
  const out=mutate(H);
  if(out===H){ console.log('  SKIP  '+name+' — mutation did not apply, check the anchor'); bad++; continue; }
  fs.writeFileSync(TMP,out);
  const r=cp.spawnSync(process.execPath,[path.join(__dirname,'dom.js'),TMP],{encoding:'utf8'});
  const caught=r.status!==0;
  console.log((caught?'  ok    caught: ':'  FAIL  MISSED: ')+name);
  caught?ok++:bad++;
}
try{fs.unlinkSync(TMP);}catch(e){}
console.log(`\n${ok} guards fire, ${bad} do not\n`);
process.exit(bad?1:0);
