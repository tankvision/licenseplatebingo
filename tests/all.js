/* Runs every harness and the inline-script syntax check.

   Run:  node tests/all.js
   Exit code is non-zero if anything fails, so it works as a pre-deploy gate. */
const cp=require('child_process'), fs=require('fs'), os=require('os'), path=require('path');
const ROOT=path.join(__dirname,'..');

let bad=0;

/* the inline <script> has to parse before any of the extraction harnesses can
   mean anything — a syntax error there would fail them all confusingly */
const H=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const blocks=[...H.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
blocks.forEach((b,i)=>{
  const f=path.join(os.tmpdir(),'lpb-chk'+i+'.js');
  fs.writeFileSync(f,b);
  const r=cp.spawnSync(process.execPath,['--check',f],{encoding:'utf8'});
  console.log((r.status?'  FAIL  ':'  ok    ')+`inline script block ${i} (${b.length} bytes)`);
  if(r.status){ console.log(r.stderr); bad++; }
  try{fs.unlinkSync(f);}catch(e){}
});
const sw=cp.spawnSync(process.execPath,['--check',path.join(ROOT,'sw.js')],{encoding:'utf8'});
console.log((sw.status?'  FAIL  ':'  ok    ')+'sw.js syntax');
if(sw.status){ console.log(sw.stderr); bad++; }

/* dom.js must run before negtest.js: negtest asserts dom.js REJECTS mutated
   copies, which proves nothing if dom.js is broken on the real file */
for(const name of ['sync3','freeze','panel','dom','sql','negtest']){
  const r=cp.spawnSync(process.execPath,[path.join(__dirname,name+'.js')],{encoding:'utf8'});
  const last=(r.stdout||'').trim().split('\n').filter(Boolean).pop()||'(no output)';
  console.log((r.status?'  FAIL  ':'  ok    ')+name.padEnd(8)+' '+last);
  if(r.status){ console.log(r.stdout); console.log(r.stderr); bad++; }
}

console.log(bad?`\n${bad} suite(s) failed\n`:'\neverything green\n');
process.exit(bad?1:0);
