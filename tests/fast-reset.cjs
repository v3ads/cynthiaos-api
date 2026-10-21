const assert=require('node:assert/strict');const {PGlite}=require(process.env.PGLITE_MODULE);
const {FAST_SCHEMA,readFast,writeFast,validateFast}=require('../dist/lib/fast');
const {selectFastUnits,validateReset,resetFast,fastKeys}=require('../dist/lib/fastReset');
const candidate=(unit_id,days_vacant,extra={})=>({unit_id,days_vacant,unit_type:'Martinique - Furnished',status:'vacant',has_source_status:true,leasing_excluded:false,...extra});
(async()=>{
 const rows=[candidate('109',293),candidate('102',0),candidate('110',293),candidate('001',null),candidate('002',999,{status:'occupied'}),candidate('003',999,{status:'notice'}),candidate('004',999,{leasing_excluded:true}),candidate('005',999,{has_source_status:false}),candidate('006',999,{unit_type:'Other - Furnished'}),candidate('320',446,{unit_type:'Martinique - UnFurnished'}),candidate('814',142,{unit_type:'Barcelona - UnFurnished'}),candidate('412',142,{unit_type:'Barcelona - UnFurnished'})];
 const selected=selectFastUnits(rows);assert.equal(selected[0].unit_numbers,'109');assert.equal(selected[1].unit_numbers,'320');assert.equal(selected[2].unit_numbers,'');assert.equal(selected[3].unit_numbers,'412');assert.equal(selectFastUnits([candidate('001',null)])[0].unit_numbers,'');assert.equal(selectFastUnits([candidate('002',0)])[0].unit_numbers,'002');
 assert.throws(()=>validateReset([]));assert.throws(()=>validateReset(fastKeys.map(()=>({...fastKeys[0],revision:0}))));
 const db=new PGlite();await db.exec(FAST_SCHEMA);let freshness='current',failAt=0,writes=0;
 const sql=async(strings,...values)=>{let q=strings[0];values.forEach((_,i)=>q+=`$${i+1}`+strings[i+1]);
  if(q.includes('AS source_rows'))return [{report_date:freshness==='unknown'?null:freshness==='stale'?'2020-01-01':new Date().toISOString().slice(0,10),source_rows:rows.length}];
  if(q.includes('WITH latest AS'))return rows.map(r=>({...r,source_report_date:new Date().toISOString().slice(0,10),unit_group:null,exclude_from_vacancy:r.leasing_excluded,exclude_from_occupancy:false,vacancy_status:'Vacant-Unrented'}));

  if(q.includes('UPDATE fast_unit_assignments')&&failAt&&++writes===failAt)throw Error('injected write failure');
  return(await db.query(q,values)).rows;
 };sql.begin=async(options,fn)=>{assert.match(options,/repeatable read/);await db.exec('BEGIN');try{const result=await fn(sql);await db.exec('COMMIT');return result;}catch(e){await db.exec('ROLLBACK');throw e;}};
 const initial=validateReset(fastKeys.map(k=>({...k,revision:0})));
 const first=await resetFast(sql,initial,'fixture');assert.equal(first.data.length,6);assert.equal((await readFast(sql)).length,6);
 const vector=()=>validateReset(first.data);const before=JSON.stringify(await readFast(sql));
 await assert.rejects(resetFast(sql,initial,'fixture'),/changed elsewhere/);assert.equal(JSON.stringify(await readFast(sql)),before);
 for(const state of ['stale','unknown']){freshness=state;await assert.rejects(resetFast(sql,vector(),'fixture'),/stale or unknown/);assert.equal(JSON.stringify(await readFast(sql)),before);}freshness='current';
 failAt=3;await assert.rejects(resetFast(sql,vector(),'fixture'),/injected/);assert.equal(JSON.stringify(await readFast(sql)),before);failAt=0;
 await writeFast(sql,validateFast('premium','unfurnished','999',1),'staff');await assert.rejects(resetFast(sql,vector(),'fixture'),/changed elsewhere/);assert.equal((await readFast(sql)).find(r=>r.category==='premium'&&r.furnishing==='unfurnished').unit_numbers,'999');
 await db.close();console.log('PASS Reset selection/ties/unknown duration/exclusions; six-row atomic persistence; stale/unknown rejection; competing revision rejection; rollback on partial failure.');
})().catch(e=>{console.error(e);process.exitCode=1});

