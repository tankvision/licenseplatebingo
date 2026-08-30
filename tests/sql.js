/* Structural checks on the SQL files.

   These exist because of a real incident: a patch script built the schema with
   String.replace(from, to), and in a JavaScript *replacement string* `$$` is an
   escape meaning "one literal $". Every dollar-quote delimiter it inserted
   silently collapsed from `$$` to `$`, producing a file that looked correct in
   every grep and failed at the first line Postgres tried to parse:

       ERROR: 42601: syntax error at or near "$"

   Nothing else caught it. dom.js checked that game_grace() existed and returned
   the right interval — both true of the broken file. The lesson is that
   "the text I searched for is present" is not the same as "this parses".

   Run:  node tests/sql.js
   An optional path argument lets negtest.js point it at a mutated copy.

   NOTE the limit: there is no Postgres here, so this cannot truly parse the
   SQL. It checks the structural properties that have actually broken. Real
   verification is supabase/verify.sql, run against the database. */
const fs=require('fs'), path=require('path');
const ROOT=path.join(__dirname,'..');
const SCHEMA=process.argv[2]||path.join(ROOT,'supabase','schema.sql');
const VERIFY=process.argv[3]||path.join(ROOT,'supabase','verify.sql');
let bad=0, checks=0;
const fail=(...a)=>{console.log('  FAIL ',...a);bad++;};
const ok=m=>{console.log('  ok    '+m);checks++;};

/* ── schema.sql ──────────────────────────────────────────────────────── */
const SQL=fs.readFileSync(SCHEMA,'utf8');

/* Every function body is delimited by a matched pair of dollar quotes, so the
   delimiter count must be exactly twice the number of function definitions.
   This is the check that would have caught the collapse. */
const fns=[...SQL.matchAll(/create or replace function\s+([a-z_]+)\s*\(/g)].map(m=>m[1]);
/* anonymous DO blocks are dollar-quoted too — schema.sql ends with one that
   adds the realtime publications — so they count toward the total */
const dos=(SQL.match(/^do \$\$/gm)||[]).length;
const opens=(SQL.match(/\$\$/g)||[]).length;
const want=(fns.length+dos)*2;
console.log(`  ${fns.length} functions: ${fns.join(', ')}`);
console.log(`  ${dos} anonymous do block(s)`);
if(opens!==want)
  fail(`dollar-quote delimiters unbalanced: found ${opens} "$$", expected ${want} `
      +`(2 per function, 2 per do block). A collapsed "$$"→"$" will not parse.`);
else ok(`${opens} dollar-quote delimiters across ${fns.length} functions and ${dos} do block(s) — balanced`);

/* A lone `$` is only legal inside a quoted string (we have one, an anchor in a
   plate-code regex). Anywhere else it is a broken delimiter. */
const strays=[];
SQL.split('\n').forEach((line,i)=>{
  if(/^\s*--/.test(line)) return;                 // comment
  const withoutStrings=line.replace(/'[^']*'/g,"''");
  const withoutTags=withoutStrings.replace(/\$[A-Za-z_]*\$/g,'');
  if(withoutTags.includes('$')) strays.push((i+1)+': '+line.trim());
});
if(strays.length) fail('stray "$" outside a string or a dollar-quote tag:\n         '+strays.join('\n         '));
else ok('no stray "$" outside strings and tags');

/* each function must actually open and close its own body — a global count
   alone could hide two errors cancelling out */
let perFn=0;
for(const fn of fns){
  const start=SQL.indexOf('create or replace function '+fn+'(');
  /* bound the slice at whatever comes next: another function, or a do block */
  const nexts=[SQL.indexOf('create or replace function ', start+10),
               SQL.indexOf('\ndo $$', start)].filter(i=>i>0);
  const end=nexts.length?Math.min(...nexts):SQL.length;
  const n=(SQL.slice(start,end).match(/\$\$/g)||[]).length;
  if(n!==2){ fail(`${fn}() has ${n} dollar-quote delimiters, expected exactly 2`); perFn++; }
}
if(!perFn) ok('every function opens and closes its own body');

/* Presence checks run against a comment-stripped copy. Commenting a grant out
   still leaves its text in the file, so a naive substring search would happily
   confirm a permission that no longer exists — the same trap that let a guard
   pass on deleted code once already. */
const NC=SQL.replace(/^\s*--.*$/gm,'');
const need=[
  [/create or replace function game_grace\(\)/,          'game_grace() is defined'],
  [/select interval '1 hour'/,                           'the grace window is 1 hour'],
  [/v_when := least\(coalesce\(p_spotted_at, now\(\)\), now\(\)\)/, 'add_spot clamps the client timestamp'],
  [/values \(p_entry, v_game, v_code, p_pts, v_when\)/,  'and stores the value it checked'],
  [/create or replace function entry_spots\(p_entry uuid\)/, 'entry_spots() is defined'],
  [/grant execute on function entry_spots\(uuid\)/,      'entry_spots() is granted to anon'],
  [/revoke execute on function game_grace\(\)/,          'game_grace() is not'],
];
for(const [re,msg] of need){ if(!re.test(NC)) fail('missing: '+msg); else ok(msg); }

/* ── verify.sql ──────────────────────────────────────────────────────── */
const V=fs.readFileSync(VERIFY,'utf8');
const vtags=(V.match(/\$v\$/g)||[]).length;
if(vtags!==2) fail(`verify.sql has ${vtags} "$v$" tags, expected 2`);
else ok('verify.sql DO block is balanced');

/* it must undo itself: the schema has no delete_game, so a committed test run
   would strand throwaway games in the table permanently */
if(!/^begin;/m.test(V))    fail('verify.sql does not open a transaction');
else if(!/^rollback;/m.test(V)) fail('verify.sql never rolls back — it would leave VERIFY games behind');
else ok('verify.sql is wrapped in begin/rollback');

/* and it must not touch anything it did not create */
const VC=V.replace(/^\s*--.*$/gm,'');
for(const kw of ['drop ','truncate ','alter table']){
  if(new RegExp('^\\s*'+kw,'im').test(VC)) fail(`verify.sql contains "${kw.trim()}" — it must only create and roll back`);
}
if(/delete\s+from/i.test(VC)) fail('verify.sql deletes directly — it should only go through the app functions');
else ok('verify.sql never deletes, drops or alters');

/* One direct write is allowed and necessary: an already-ended game cannot be
   created (create_game calls join_game, which refuses a finished game), so the
   end-of-game paths are only reachable by creating a live game and moving its
   deadline backwards. That update must be narrow — this column, on a game the
   script made — or it stops being a test and becomes a liability. */
const updates=[...VC.matchAll(/^\s*update\s+.*$/gim)].map(m=>m[0].trim());
let aging=0;
for(const u of updates){
  if(/^update games set ends_at = now\(\) [-+] interval '[^']+' where id = g_\w+;$/.test(u)) aging++;
  else fail('unexpected direct write in verify.sql: '+u);
}
if(updates.length&&aging===updates.length)
  ok(`${aging} deadline-aging update(s), each scoped to one game this script created`);

console.log(bad?`\n${bad} problem(s)\n`:`\n${checks} checks passed\n`);
process.exit(bad?1:0);
