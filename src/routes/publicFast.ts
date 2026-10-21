import {Router} from 'express';
import postgres from 'postgres';
import {FAST_PLANS,fastKeys} from '../lib/fastReset';
import {FAST_BASELINE_MONTHLY_USD} from '../lib/fastPricing';

// Baseline category prices must be verified against the authoritative price
// configuration. Unit market rent or discounted unit quotes are not baselines.
type Assignment={category:string;furnishing:string;unit_numbers:string};
export function publicFastProjection(rows:Assignment[]){
 return {currency:'USD',period:'month',cells:fastKeys.map(({category,furnishing})=>{
  const value=rows.find(r=>r.category===category&&r.furnishing===furnishing)?.unit_numbers??'';
  const ids=typeof value==='string'&&value.length<=1000?value.trim().split(/[\s,;]+/).filter(Boolean):[];
  const unit_ids=ids.length<=50&&ids.every(id=>/^\d[a-zA-Z0-9-]{0,19}$/.test(id))?[...new Set(ids)]:[];
  const monthly_price=FAST_BASELINE_MONTHLY_USD[`${category}/${furnishing}`]??null;
  return {category,floor_plan:FAST_PLANS[category as keyof typeof FAST_PLANS],furnishing,monthly_price,price_status:monthly_price===null?'unverified':'verified',unit_ids};
 })};
}
export function createPublicFastRouter(getDb:()=>postgres.Sql){
 const router=Router();
 router.get('/api/public/fast',async(_req,res)=>{
  let sql:postgres.Sql|null=null;
  res.setHeader('Cache-Control','no-store');
  try{sql=getDb();const rows=await sql<Assignment[]>`SELECT category,furnishing,unit_numbers FROM fast_unit_assignments ORDER BY category,furnishing`;
   res.json(publicFastProjection(rows));
  }catch{res.status(503).json({error:'Fast selections are temporarily unavailable.'});}
  finally{if(sql)await sql.end();}
 });
 return router;
}
