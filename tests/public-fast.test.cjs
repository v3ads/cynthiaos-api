const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express');const {createPublicFastRouter,publicFastProjection}=require('../dist/routes/publicFast');const {requireAuth}=require('../dist/auth');
test('public projection always has six allowlisted cells and excludes staff metadata',()=>{
 const result=publicFastProjection([{category:'basic',furnishing:'furnished',unit_numbers:'001, 120-a, 001',revision:99,updated_by:'PRIVATE',tenant_name:'PRIVATE'}, {category:'premium',furnishing:'furnished',unit_numbers:'https://private.invalid'}]);
 assert.equal(result.cells.length,6);assert.deepEqual(result.cells[0].unit_ids,['001','120-a']);assert.equal(result.cells[0].floor_plan,'Martinique');assert.deepEqual(result.cells.map(c=>c.monthly_price),[2240,1990,2370,2020,2570,2220]);assert.ok(result.cells.every(c=>c.price_status==='verified'));assert.deepEqual(Object.keys(result.cells[0]),['category','floor_plan','furnishing','monthly_price','price_status','unit_ids']);assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('private.invalid'));assert.deepEqual(result.cells[4].unit_ids,[]);
});
test('only public GET/HEAD bypass auth; staff reads/writes/reset remain denied, failures do not leak SQL',async()=>{
 let fail=false,calls=0;const sql=async()=>{calls++;if(fail)throw Error('PRIVATE DATABASE DETAILS');return[{category:'basic',furnishing:'furnished',unit_numbers:'109',updated_by:'PRIVATE'}]};sql.end=async()=>{};
 const app=express();app.use(express.json());app.use(createPublicFastRouter(()=>sql));app.use(requireAuth());app.get('/api/v1/fast',(_q,r)=>r.json({private:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const r=await fetch(base+'/api/public/fast?include=updated_by');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.ok(!JSON.stringify(await r.json()).includes('PRIVATE'));
  assert.equal((await fetch(base+'/api/public/fast',{method:'HEAD'})).status,200);
  const before=calls;for(const [method,path] of [['POST','/api/public/fast'],['PUT','/api/public/fast'],['DELETE','/api/public/fast'],['GET','/api/v1/fast'],['PUT','/api/v1/fast/basic/furnished'],['POST','/api/v1/fast/reset'],['GET','/api/public/fast/other']])assert.equal((await fetch(base+path,{method})).status,401);
  assert.equal(calls,before);fail=true;const failed=await fetch(base+'/api/public/fast');assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('PRIVATE'));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
