const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceFreshness, occupancyList, loadOccupancy, getOccupancyFreshness } = require('../dist/lib/occupancy');

const row = (unit_id, status, days_vacant, extra={}) => ({unit_id, status, days_vacant, unit_type:'Furnished', building:'Madison',
  unit_group:null, exclude_from_occupancy:false, exclude_from_vacancy:false, exclude_from_revenue:false,
  has_source_status:true, source_report_date:new Date().toISOString(), market_rent:'1,500', monthly_rent:null, vacancy_status:'Vacant Unrented', ...extra});

test('fresh, stale, absent and invalid report dates are distinct from retrieval', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(sourceFreshness('2026-10-20',now).freshness,'current');
  assert.equal(sourceFreshness('2026-10-17',now).freshness,'stale');
  assert.equal(sourceFreshness(null,now).freshness,'unknown');
  assert.equal(sourceFreshness('bad',now).freshness,'unknown');
  assert.equal(sourceFreshness('2026-10-21',now).freshness,'unknown');
  assert.equal(sourceFreshness('2026-10-20',now).retrieved_at,now.toISOString());
});

test('90-day lists exclude occupied, notice, held units and 89-day vacancies; counts derive from rows', () => {
  const rows=[row('a','vacant',90),row('b','vacant',89),row('c','occupied',200),row('d','notice',100),row('e','vacant',120,{leasing_excluded:true})];
  const result=occupancyList(rows,'vacant','Madison',90);
  assert.deepEqual(result.units.map(r=>r.unit_id),['a']);
  assert.equal(result.total_count,1);assert.deepEqual(result.counts_by_type,{Furnished:1});
  assert.equal(occupancyList(rows,'notice').notice,1);
  assert.equal(occupancyList(rows,'vacant','Other').total_count,0);
  assert.equal(occupancyList(rows,'vacant','',undefined,'Furnished').total_count,2);
  assert.equal(occupancyList(rows,'vacant','',undefined,'Other type').total_count,0);
});

test('canonical source is re-read every time; leasing overrides and missing evidence are conservative', async () => {
  let calls=0;
  const sql=async strings=>{calls++;assert.match(strings.join(''),/FROM v_unit_occupancy/);return [
    row('315','occupied','200'),row('test-vacant','vacant','90'),
    row('held','vacant','100',{unit_group:'picinich_family'}),
    row('excluded','vacant','100',{exclude_from_vacancy:true}),
    row('unknown','vacant','100',{has_source_status:false})];};
  const first=await loadOccupancy(sql); const second=await loadOccupancy(sql);
  assert.equal(calls,2);assert.equal(first[0].available_to_lease,false);
  assert.equal(first[1].market_rent,1500);assert.equal(first[1].available_to_lease,true);
  assert.equal(first[2].leasing_excluded,true);assert.equal(first[3].available_to_lease,false);
  assert.equal(first[4].available_to_lease,false);assert.ok(first[4].status_warning);
  assert.equal(occupancyList(second,'vacant','',90).total_count,2);
  await assert.rejects(()=>loadOccupancy(async()=>{throw Error('offline');}),/offline/);
});

test('a recent but empty report is unknown, never fresh availability', async () => {
 const fresh=await getOccupancyFreshness(async()=>[{report_date:new Date().toISOString(),source_rows:0}]);
 assert.equal(fresh.freshness,'unknown');assert.ok(fresh.warnings.length);
});
