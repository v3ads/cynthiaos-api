const {PGlite}=require(process.env.PGLITE_MODULE);const fs=require('fs');const assert=require('node:assert/strict');
const {FAST_SCHEMA,validateFast,readFast,writeFast}=require('../dist/lib/fast');
const {createFastRouter}=require('../dist/routes/fast');
(async()=>{
 const db=new PGlite();await db.exec(FAST_SCHEMA);
 const migration=fs.readFileSync('migrations/20261020_fast_unit_assignments.sql','utf8').replace(/^--.*\n/gm,'').trim();assert.equal(migration,FAST_SCHEMA.trim());
 const sql=async(strings,...values)=>{let q=strings[0];values.forEach((_,i)=>q+=`$${i+1}`+strings[i+1]);return (await db.query(q,values)).rows;};sql.end=async()=>{};
 assert.equal((await readFast(sql)).length,0);
 for(const bad of [['wrong','furnished','103',0],['basic','furnished',103,0],['basic','furnished','<script>',0],['basic','furnished','https://example.com',0],['basic','furnished','103',-1]])assert.throws(()=>validateFast(...bad));
 const saved=await writeFast(sql,validateFast('basic','furnished','001,120-a',0),'fixture');assert.equal(saved.saved.unit_numbers,'001, 120-a');
 const conflict=await writeFast(sql,validateFast('basic','furnished','999',0),'fixture');assert.equal(conflict.current.unit_numbers,'001, 120-a');
 const cleared=await writeFast(sql,validateFast('basic','furnished','',1),'fixture');assert.equal(cleared.saved.unit_numbers,'');assert.equal(cleared.saved.revision,2);
 await db.exec(FAST_SCHEMA);assert.equal((await readFast(sql))[0].revision,2);
 const concurrent=await Promise.all([writeFast(sql,validateFast('basic','furnished','102',2),'fixture'),writeFast(sql,validateFast('basic','furnished','103',2),'fixture')]);assert.equal(concurrent.filter(r=>r.saved).length,1);
 const router=createFastRouter(()=>sql);async function call(method,path,body,params={}){let code=200,result;await router.stack.find(l=>l.route?.path===path&&l.route.methods[method]).route.stack[0].handle({body,params,auth:{sub:'fixture'}},{setHeader(){},status(n){code=n;return this;},json(v){result=v;return this;}});return{code,result};}
 const read=await call('get','/fast');assert.equal(read.code,200);assert.equal(read.result.data.length,1);
 const invalid=await call('put','/fast/:category/:furnishing',{unit_numbers:'<bad>',revision:0},{category:'premium',furnishing:'furnished'});assert.equal(invalid.code,400);
 let authCode;router.stack[0].handle({}, {status(n){authCode=n;return this;},json(){}},()=>assert.fail('Unauthenticated request reached the database'));assert.equal(authCode,401);
 const offline=createFastRouter(()=>{const fail=async()=>{throw Error('offline')};fail.end=async()=>{};return fail;});let status;await offline.stack.find(l=>l.route?.path==='/fast').route.stack[0].handle({},{setHeader(){},status(n){status=n;return this;},json(){}});assert.equal(status,503);
 await db.close();console.log('PASS Fast SQL persistence, empty migration, string validation, CAS conflict/races, API validation and failed reads.');
})().catch(e=>{console.error(e);process.exitCode=1});
