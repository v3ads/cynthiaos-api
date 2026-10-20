const test=require('node:test'); const assert=require('node:assert/strict');const Module=require('module');
let offline=false;let minCalls=0;
const fixture=[
 {unit_id:'fixture-occupied',status:'occupied',days_vacant:'200'},
 {unit_id:'fixture-notice',status:'notice',days_vacant:'120'},
 {unit_id:'fixture-89',status:'vacant',days_vacant:'89'},
 {unit_id:'fixture-90',status:'vacant',days_vacant:'90'},
].map(r=>({...r,unit_group:null,exclude_from_occupancy:false,exclude_from_vacancy:false,exclude_from_revenue:false,building:'Madison',unit_type:'Unfurnished',has_source_status:true,vacancy_status:'Vacant Unrented',source_report_date:new Date().toISOString()}));
const sql=async strings=>{
 if(offline)throw Error('offline');const query=strings.join('');
 if(query.includes('FROM v_unit_occupancy o')){minCalls++;return fixture;}
 if(query.includes('source_rows'))return [{report_date:new Date().toISOString(),source_rows:4}];
 if(query.includes('FROM gold_units gu')){assert.match(query,/o\.unit_status/);return [{unit_id:'fixture-occupied',unit_status:'occupied'}];}
 return [];
};sql.end=async()=>{};
const originalLoad=Module._load;const originalTimeout=global.setTimeout;
process.env.DATABASE_URL='test-only-not-a-connection';
Module._load=function(name,...args){if(name==='postgres')return ()=>sql;return originalLoad.call(this,name,...args);};
global.setTimeout=()=>({unref(){}});
const router=require('../dist/routes/jasmine').default;
Module._load=originalLoad;global.setTimeout=originalTimeout;
async function call(path,query={},params={}){let code=200,body;const handler=router.stack.find(l=>l.route?.path===path).route.stack[0].handle;
 await handler({query,params},{status(n){code=n;return this;},json(v){body=v;return this;}});return {code,body};}

test('HTTP handlers share canonical counts, enforce 90 days and never revive cached lists after failure',async()=>{
 const list=await call('/jasmine/units',{status:'vacant',building:'Madison',format:'envelope'});
 assert.equal(list.body.total_count,2);assert.equal(list.body.counts_by_type.Unfurnished,2);
 const long=await call('/jasmine/long-vacancies',{min_days:90,format:'envelope'});
 assert.deepEqual(long.body.units.map(r=>r.unit_id),['fixture-90']);
 const summary=await call('/jasmine/portfolio-summary');
 assert.equal(summary.body.occupied,1);assert.equal(summary.body.vacant,2);assert.equal(summary.body.on_notice,1);
 assert.equal(summary.body.vacancy_including_notice,3);assert.equal(summary.body.occupancy_denominator,4);
 const detail=await call('/jasmine/units/:unit_id',{}, {unit_id:'fixture-occupied'});
 assert.equal(detail.body.status,'occupied');assert.equal(detail.body.available_to_lease,false);
 assert.ok(minCalls>=4);
 assert.ok(Array.isArray((await call('/jasmine/units',{status:'vacant'})).body));
 assert.ok(Array.isArray((await call('/jasmine/long-vacancies',{min_days:90})).body));
 offline=true;assert.equal((await call('/jasmine/units',{status:'vacant'})).code,503);
 assert.equal((await call('/jasmine/long-vacancies',{min_days:90})).code,503);offline=false;
 assert.equal((await call('/jasmine/long-vacancies',{min_days:'bad'})).code,400);
 assert.equal((await call('/jasmine/units',{status:'bogus'})).code,400);
});
