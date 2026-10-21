import postgres from 'postgres';
import {getOccupancyFreshness,loadOccupancy} from './occupancy';
import {readFast,writeFast,validateFast} from './fast';

export const FAST_PLANS={basic:'Martinique',upgraded:'Barcelona',premium:'Madison'} as const;
export const fastKeys=Object.keys(FAST_PLANS).flatMap(category=>['furnished','unfurnished'].map(furnishing=>({category,furnishing})));
type Candidate={unit_id:string;unit_type:string|null;status:string;has_source_status:boolean;leasing_excluded:boolean;days_vacant:number|null};
export function selectFastUnits(rows:Candidate[]){
 return fastKeys.map(({category,furnishing})=>{
  const type=`${FAST_PLANS[category as keyof typeof FAST_PLANS]} - ${furnishing}`.toLowerCase();
  const candidates=rows.filter(r=>r.status==='vacant'&&r.has_source_status&&!r.leasing_excluded
   &&r.unit_type?.trim().toLowerCase()===type&&r.days_vacant!==null&&Number.isFinite(r.days_vacant)&&r.days_vacant>=0
   &&/^\d[a-zA-Z0-9-]{0,19}$/.test(r.unit_id));
  candidates.sort((a,b)=>b.days_vacant!-a.days_vacant!||a.unit_id.localeCompare(b.unit_id,'en',{numeric:true})||a.unit_id.localeCompare(b.unit_id,'en'));
  return {category,furnishing,unit_numbers:candidates[0]?.unit_id??''};
 });
}
export function validateReset(value:unknown){
 if(!Array.isArray(value)||value.length!==6)throw Error('Reload Fast before resetting. Six cell revisions are required.');
 return fastKeys.map(k=>{const matches=value.filter(r=>r?.category===k.category&&r?.furnishing===k.furnishing);if(matches.length!==1)throw Error('Invalid cell revisions. Reload Fast.');return validateFast(k.category,k.furnishing,'',matches[0].revision);});
}
export class ResetError extends Error{constructor(message:string,public status:number){super(message);}}
export async function resetFast(sql:postgres.Sql,expected:ReturnType<typeof validateReset>,actor:string|null){
 return sql.begin('isolation level repeatable read',async tx=>{
  // Also excludes ordinary single-cell writes, including inserts for missing cells.
  await tx`LOCK TABLE fast_unit_assignments IN EXCLUSIVE MODE`;
  const current=await readFast(tx as unknown as postgres.Sql);
  if(expected.some(k=>(current.find(r=>r.category===k.category&&r.furnishing===k.furnishing)?.revision??0)!==k.revision))throw new ResetError('Fast changed elsewhere. Nothing was reset. Reload the page and review the latest values.',409);
  const freshness=await getOccupancyFreshness(tx as unknown as postgres.Sql);
  if(freshness.freshness!=='current')throw new ResetError('Vacancy source is stale or unknown. Nothing was reset. Retry after a fresh AppFolio report is available.',409);
  const selected=selectFastUnits(await loadOccupancy(tx as unknown as postgres.Sql));
  const data=[];
  for(const cell of selected){const revision=expected.find(k=>k.category===cell.category&&k.furnishing===cell.furnishing)!.revision;
   const result=await writeFast(tx as unknown as postgres.Sql,validateFast(cell.category,cell.furnishing,cell.unit_numbers,revision),actor);
   if(!result.saved)throw new ResetError('Fast changed elsewhere. Nothing was reset. Reload and retry.',409);data.push(result.saved);
  }
  return {data,...freshness};
 });
}
