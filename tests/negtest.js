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

/* The same idea for schema.sql, checked by sql.js. The first case here is the
   exact bug that shipped: a patch script used String.replace(from, to), where
   `$$` in a replacement string is an escape for one literal `$`. Every
   delimiter it inserted collapsed, and the file failed at the first line
   Postgres parsed. Every grep still passed. */
const SCHEMA=path.join(ROOT,'supabase','schema.sql');
const S=fs.readFileSync(SCHEMA,'utf8');
const TMPSQL=path.join(os.tmpdir(),'lpb-negtest.sql');

const sqlCases=[
  ['a dollar-quote delimiter collapsed to a single $',
   s=>s.replace("returns interval language sql immutable as $$","returns interval language sql immutable as $")],
  ['a function body never closes',
   s=>s.replace("  select interval '1 hour';\n$$;","  select interval '1 hour';")],
  ['the grace window drifts in the schema',
   s=>s.replace("select interval '1 hour'","select interval '48 hours'")],
  ['add_spot stops clamping the client timestamp',
   s=>s.replace('v_when := least(coalesce(p_spotted_at, now()), now());',
                'v_when := coalesce(p_spotted_at, now());')],
  ['add_spot stores something other than what it checked',
   s=>s.replace('values (p_entry, v_game, v_code, p_pts, v_when)',
                'values (p_entry, v_game, v_code, p_pts, coalesce(p_spotted_at, now()))')],
  ['entry_spots is never granted, so the panel 404s for everyone',
   s=>s.replace('grant execute on function entry_spots(uuid)','-- grant execute on function entry_spots(uuid)')],
  ['game_grace becomes callable by anon',
   s=>s.replace('revoke execute on function game_grace()','-- revoke execute on function game_grace()')],
];

let ok=0,bad=0;
const run=(label,file,checker,args)=>{
  const r=cp.spawnSync(process.execPath,[path.join(__dirname,checker),...args],{encoding:'utf8'});
  const caught=r.status!==0;
  console.log((caught?'  ok    caught: ':'  FAIL  MISSED: ')+label);
  caught?ok++:bad++;
};

console.log('── index.html, checked by dom.js ─────────────────────');
for(const [name,mutate] of cases){
  const out=mutate(H);
  if(out===H){ console.log('  SKIP  '+name+' — mutation did not apply, check the anchor'); bad++; continue; }
  fs.writeFileSync(TMP,out);
  run(name,TMP,'dom.js',[TMP]);
}

console.log('\n── schema.sql, checked by sql.js ─────────────────────');
for(const [name,mutate] of sqlCases){
  const out=mutate(S);
  if(out===S){ console.log('  SKIP  '+name+' — mutation did not apply, check the anchor'); bad++; continue; }
  fs.writeFileSync(TMPSQL,out);
  run(name,TMPSQL,'sql.js',[TMPSQL]);
}

/* verify.sql needs one direct write — aging a game's deadline, since an
   already-ended game cannot be created. That write has to stay narrow. */
const VERIFY=path.join(ROOT,'supabase','verify.sql');
const Vsrc=fs.readFileSync(VERIFY,'utf8');
const TMPV=path.join(os.tmpdir(),'lpb-negtest-verify.sql');
const verifyCases=[
  ['the deadline-aging update loses its WHERE clause',
   s=>s.replace("update games set ends_at = now() - interval '10 minutes' where id = g_grace;",
                "update games set ends_at = now() - interval '10 minutes';")],
  ['verify.sql stops rolling back, stranding VERIFY games',
   s=>s.replace(/^rollback;$/m,'commit;')],
  ['verify.sql starts deleting directly',
   s=>s.replace('select n, check_name, ok, detail from vres order by n;',
                "delete from spots where code = 'MT';\nselect n, check_name, ok, detail from vres order by n;")],
];

console.log('\n── verify.sql, checked by sql.js ─────────────────────');
for(const [name,mutate] of verifyCases){
  const out=mutate(Vsrc);
  if(out===Vsrc){ console.log('  SKIP  '+name+' — mutation did not apply, check the anchor'); bad++; continue; }
  fs.writeFileSync(TMPV,out);
  run(name,TMPV,'sql.js',[SCHEMA,TMPV]);
}

for(const f of [TMP,TMPSQL,TMPV]){ try{fs.unlinkSync(f);}catch(e){} }
console.log(`\n${ok} guards fire, ${bad} do not\n`);
process.exit(bad?1:0);
