/* Static check that every element the script reaches for actually exists,
   either in the page markup or in one of the innerHTML templates, plus the
   structural invariants that past bugs taught us to guard. Catches the classic
   "moved a section, forgot a selector" break without needing a browser.

   Run:  node tests/dom.js
   An optional path argument lets negtest.js point it at a mutated copy, and
   lets you run it against the file the live server is actually returning. */
const fs=require('fs'), path=require('path');
const ROOT=path.join(__dirname,'..');
const H=fs.readFileSync(process.argv[2]||path.join(ROOT,'index.html'),'utf8');
let bad=0;
const fail=(...a)=>{console.log('  FAIL ',...a);bad++;};

const ids=new Set([...H.matchAll(/\bid=["']([\w-]+)["']/g)].map(m=>m[1]));
const usedIds=new Set([...H.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)].map(m=>m[1]));
for(const u of usedIds) if(!ids.has(u)) fail('getElementById target missing:',u);

/* data-* attributes: emitted vs queried */
const emitted=new Set([...H.matchAll(/\sdata-([a-z]+)=/g)].map(m=>m[1]));
const queried=new Set([...H.matchAll(/querySelector(?:All)?\(\s*[`'"]\s*\[data-([a-z]+)/g)].map(m=>m[1]));
for(const q of queried) if(!emitted.has(q)) fail('queried data attribute never emitted:',q);
for(const m of H.matchAll(/\.dataset\.([a-z]+)/g))
  if(!emitted.has(m[1])) fail('dataset read never emitted: data-'+m[1]);

/* classes queried from JS must appear in markup or a template */
const qCls=new Set([...H.matchAll(/querySelector(?:All)?\(\s*['"]\.([\w-]+)/g)].map(m=>m[1]));
for(const c of qCls){
  const re=new RegExp('class=["\'`][^"\'`]*\\b'+c+'\\b');
  if(!re.test(H)) fail('class queried but never emitted:',c);
}

/* achievements live in their own section, not inside #groups */
const achvBlock=H.slice(H.indexOf("getElementById('achv')"),H.indexOf("getElementById('achv')")+700);
for(const need of ['data-g="ach"','data-body="ach"','data-count="ach"','data-strip="ach"','grouphead','chev'])
  if(!achvBlock.includes(need)) fail('achievements block lost:',need);

const groupsBlock=H.slice(H.indexOf("getElementById('groups').innerHTML"),H.indexOf("getElementById('achv')"));
if(groupsBlock.includes('data-g="ach"')) fail('achievements still inside #groups');

/* Every render slot must be unique. querySelector takes the FIRST match in
   document order, so a duplicate key doesn't throw — it quietly renders into
   the wrong element, which is far harder to notice than a crash. */
for(const attr of ['body','count','list','strip','g']){
  const seen=new Map();
  /* whitespace-prefixed only: that's an attribute being emitted. A selector
     reads `[data-body="ach"]`, with a bracket in front, and must not count. */
  for(const m of H.matchAll(new RegExp('\\s data-'.replace(' ','')+attr+'="([\\w-]+)"','g')))
    seen.set(m[1],(seen.get(m[1])||0)+1);
  for(const [val,n] of seen)
    if(n>1) fail(`data-${attr}="${val}" appears ${n} times — querySelector will take the wrong one`);
}

/* the keydown handler must not be scoped to #groups any more */
if(/getElementById\('groups'\)\.addEventListener\('keydown'/.test(H))
  fail('keydown still bound to #groups — achievements banner loses keyboard access');
if(!/document\.body\.addEventListener\('keydown'/.test(H))
  fail('no global keydown handler found');

/* markup order: achievements after the plate groups, before the footer */
const iG=H.indexOf('<section class="groups"'), iA=H.indexOf('<section class="achv"'), iF=H.indexOf('<div class="foot">');
if(!(iG<iA&&iA<iF)) fail('achv section is not between #groups and .foot');

/* the pinned strip must live inside the sticky deck */
const deck=H.slice(H.indexOf('<div class="deck"'),H.indexOf('<div class="celebrate"'));
if(!deck.includes('id="mini"')) fail('#mini is not inside .deck — it will not pin');

/* unlock timing invariant: queue spacing > visible + out-animation */
const vis=+/setTimeout\(\(\)=>\{ el\.classList\.add\('out'\); setTimeout\(\(\)=>el\.remove\(\),(\d+)\); \},(\d+)\)/.exec(H)[2];
const out=+/setTimeout\(\(\)=>\{ el\.classList\.add\('out'\); setTimeout\(\(\)=>el\.remove\(\),(\d+)\); \},(\d+)\)/.exec(H)[1];
const gap=+/fresh\.forEach\(\(a,i\)=>setTimeout\(\(\)=>unlockBanner\(a\),\d+\+i\*(\d+)\)\)/.exec(H)[1];
console.log(`  banner visible ${vis}ms + ${out}ms out, queued every ${gap}ms`);
if(gap<=vis+out) fail(`queued unlocks would overlap (${gap} <= ${vis}+${out})`);

/* nomotion must stay scoped to the deck. As `body.nomotion *` it killed and
   restarted every running animation on the page whenever measureDeck ran. */
/* comments stripped: the code explains *why* nomotion isn't page-wide, and
   that prose would otherwise trip the very check guarding it */
const NC=H.replace(/\/\*[\s\S]*?\*\//g,'');
if(/body\.nomotion/.test(NC))
  fail('nomotion rule is page-wide again — it will restart every animation');
if(!/\.deck\.nomotion/.test(NC))
  fail('no deck-scoped nomotion rule found');
if(/body\.classList\.(add|remove)\('nomotion'\)/.test(NC))
  fail('nomotion still being applied to <body>');
/* every body.scrolled rule must target something inside .deck, or scoping
   nomotion to the deck would stop suppressing a transition that matters */
for(const m of NC.matchAll(/body\.scrolled\s+([.\w]+)/g))
  if(!['.deck','.sign','.tally','.tallyspace','.prog','.mini','.stat'].some(s=>m[1].startsWith(s)))
    fail('body.scrolled targets something outside the deck:',m[1]);

/* Any focusable text field under 16px makes iOS Safari zoom the page on focus,
   which reads as the app stuttering while you type. */
for(const m of NC.matchAll(/(input|textarea|select)[^{]*\{([^}]*)\}/g)){
  const fs=/font-size:\s*([\d.]+)px/.exec(m[2]);
  if(fs && parseFloat(fs[1])<16)
    fail(`${m[1]} styled at ${fs[1]}px — iOS will auto-zoom on focus (needs >=16px)`);
}
if(/maximum-scale|user-scalable\s*=\s*no/.test(NC))
  fail('viewport blocks zoom — modern iOS ignores it and it breaks pinch-zoom; fix the font-size instead');

/* a height-only resize (iOS URL bar) must not trigger a re-measure */
if(!/window\.innerWidth!==lastW/.test(H))
  fail('resize re-measures without checking width — the iOS URL bar will fire it mid-tap');

/* ── end of game ──────────────────────────────────────────────────────── */

/* The server refuses writes after ends_at. Without a client guard the tap
   still lands: row slides out, score climbs, write refused and dropped, deck
   and scoreboard disagreeing with nothing on screen to explain it. */
if(!/phase\(\)==='over'\)\s*return snack/.test(NC))
  fail('toggle() lost its frozen-game guard — taps would score locally and be silently refused');
if(!/classList\.toggle\('frozen'/.test(NC))
  fail('nothing sets body.frozen — the freeze would be invisible');

const rec=NC.slice(NC.indexOf('function reconcile('),NC.indexOf('let flushing='));
if(!rec) fail('reconcile() not found');
if(!/gameClosed\(\)/.test(rec))
  fail('reconcile() no longer stops once the grace expires — it will churn refused writes forever');
if(!/ts>ends/.test(rec))
  fail('reconcile() lost the deadline cutoff');
if(!/ts<from/.test(rec))
  fail('reconcile() lost the join cutoff — joining would push your whole history up again');

/* both halves, separately: the counter existing proves nothing if the line
   that increments it is gone, and counting proves nothing if it is never said */
if(!/lateDropped\+\+/.test(NC))
  fail('nothing increments lateDropped — a spot refused for lateness would vanish silently');
if(!/if\(lateDropped\)\s*snack\(/.test(NC))
  fail('lateDropped is counted but never reported to the player');

/* Your own row must not open a panel: your list is the Spotted section. */
if(!/if\(mine\) return `<div class="sbrow me/.test(H))
  fail('your own scoreboard row is no longer a plain div — it would open a panel you already have');

/* The panel is rebuilt by renderGame() on every realtime event and every 60s
   heartbeat, so anything animated in it replays on a loop. */
const panel=/\.sbpanel\{([^}]*)\}/.exec(NC);
if(!panel) fail('.sbpanel style is missing');
else if(/transition|animation/.test(panel[1]))
  fail('.sbpanel animates — renderGame() rebuilds it every 60s, so it would replay');

/* ── cross-file: the schema this client is written against ────────────── */
const SQL=fs.readFileSync(path.join(ROOT,'supabase','schema.sql'),'utf8');

const srv=/create or replace function game_grace\(\)[\s\S]{0,200}?interval '(\d+) (hour|minute)/.exec(SQL);
const cli=/const GRACE_MS=([\d*]+);/.exec(NC);
if(!srv)      fail('schema.sql has no game_grace()');
else if(!cli) fail('index.html has no GRACE_MS');
else{
  const ms=Function('return '+cli[1])();
  const want=+srv[1]*(srv[2]==='hour'?3600000:60000);
  console.log(`  grace: client ${ms/60000}min, server ${srv[1]} ${srv[2]}`);
  if(ms!==want) fail(`grace window drifted: client ${ms}ms vs server ${srv[1]} ${srv[2]}`);
}

/* The clamp keeps a wrong device clock from pinning a spot to the top of
   recent_activity forever. It must be computed before the deadline check so
   one value is both tested and stored — it does NOT change acceptance, since
   least() only lowers toward now() and the check only runs once now() is
   already past ends_at. */
const addSpot=SQL.slice(SQL.indexOf('function add_spot('),SQL.indexOf('function remove_spot('));
const iClamp=addSpot.indexOf('v_when :='), iEnd=addSpot.indexOf('if now() > g.ends_at then');
if(iClamp<0) fail('add_spot no longer clamps the client timestamp — a future date would outrank everything');
else if(iEnd>=0&&iClamp>iEnd)
  fail('add_spot clamps AFTER the deadline check — the value tested is not the value stored');
if(!/values \(p_entry, v_game, v_code, p_pts, v_when\)/.test(addSpot))
  fail('add_spot stores a different value than the one it checked');

for(const fn of ['remove_spot','set_bonus']){
  const body=SQL.slice(SQL.indexOf('function '+fn+'('),SQL.indexOf('$$;',SQL.indexOf('function '+fn+'(')));
  if(!/ends_at \+ game_grace\(\)/.test(body))
    fail(fn+' still uses a hard deadline — a late spot could not be undone or scored');
}
if(!/grant execute on function entry_spots\(uuid\)/.test(SQL))
  fail('entry_spots is never granted — the player panel would fail for everyone');
if(!/revoke execute on function game_grace\(\)/.test(SQL))
  fail('game_grace() is callable by anon — it should be internal like rand_hex()');

console.log(bad?`\n${bad} problem(s)\n`:'\nall element references resolve, structure is correct\n');
process.exit(bad?1:0);
