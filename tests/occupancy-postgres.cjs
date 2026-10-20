// Optional SQL integration: PGLITE_MODULE points at an independently installed
// @electric-sql/pglite (validated with 0.3.14). Never connects to DATABASE_URL.
const {PGlite}=require(process.env.PGLITE_MODULE);
const fs=require('fs');const assert=require('node:assert/strict');
const {loadOccupancy,occupancyList,getOccupancyFreshness}=require('../dist/lib/occupancy');
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE TABLE gold_units(unit_id text PRIMARY KEY, unit_status text, exclude_from_occupancy boolean, unit_group text, created_at timestamp);
 CREATE TABLE bronze_appfolio_reports(report_type text,report_date date,raw_data jsonb);
 CREATE TABLE jasmine_unit_overrides(unit_id text PRIMARY KEY,exclude_from_vacancy boolean,exclude_from_revenue boolean);`);
 const source=fs.readFileSync('src/index.ts','utf8');
 const ddl=source.match(/const V_UNIT_OCCUPANCY_DDL = (`[\s\S]*?`);/)[1];
 await db.exec(Function('return '+ddl)());
 const today=new Date().toISOString().slice(0,10);
 const statuses=[['a','Occupied',200],['b','Vacant',90],['c','Notice',120],['d','Vacant',89],['e','Vacant',100],['f','Vacant',100]];
 for(const [id] of statuses)await db.query('INSERT INTO gold_units VALUES ($1,$2,$3,$4,NOW())',[id,'occupied',id==='e',id==='f'?'employee':null]);
 await db.query('INSERT INTO jasmine_unit_overrides VALUES ($1,true,true)',['f']);
 await db.query('INSERT INTO bronze_appfolio_reports VALUES ($1,$2,$3::jsonb)',['unit_vacancy',today,JSON.stringify({results:statuses.map(([id,status,days])=>({Unit:id,UnitStatus:status,DaysVacant:String(days),UnitType:'Furnished',Property:'Madison',VacancyStatus:'Vacant Unrented',ComputedMarketRent:'1,500'}))})]);
 const sql=async(strings,...values)=>{let query=strings[0];values.forEach((_,i)=>query+=`$${i+1}`+strings[i+1]);return (await db.query(query,values)).rows;};
 const rows=await loadOccupancy(sql);assert.equal(rows.length,6);assert.equal(rows[0].status,'occupied');
 const long=occupancyList(rows,'vacant','Madison',90);assert.deepEqual(long.units.map(r=>r.unit_id),['b']);
 assert.equal(long.units[0].market_rent,1500);assert.equal(long.units[0].available_to_lease,true);
 const eligible=rows.filter(r=>!r.exclude_from_occupancy);
 const home=(await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE unit_status='occupied')::int AS occupied,count(*) FILTER(WHERE unit_status IN ('vacant','notice'))::int AS vacancy FROM v_unit_occupancy WHERE NOT exclude_from_occupancy`)).rows[0];
 assert.equal(home.total,eligible.length);assert.equal(home.occupied,eligible.filter(r=>r.status==='occupied').length);
 assert.equal(home.vacancy,eligible.filter(r=>['vacant','notice'].includes(r.status)).length);
 assert.equal((await getOccupancyFreshness(sql)).freshness,'current');
 await db.query('UPDATE bronze_appfolio_reports SET report_date=$1',['2020-01-01']);
 assert.equal((await getOccupancyFreshness(sql)).freshness,'stale');
 assert.equal((await loadOccupancy(sql)).filter(r=>r.available_to_lease).length,0);
 await db.close();console.log('PASS: actual canonical view + enrichment SQL; Home/Jasmine partition, exclusions, 90 days, rent, stale-source availability');
})().catch(e=>{console.error(e);process.exitCode=1;});
