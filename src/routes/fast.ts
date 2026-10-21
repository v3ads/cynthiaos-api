import {Router} from 'express';
import postgres from 'postgres';
import {actorFrom, type AuthedRequest} from '../auth';
import {readFast,validateFast,writeFast} from '../lib/fast';
import {resetFast,validateReset,ResetError} from '../lib/fastReset';

export function createFastRouter(getDb:()=>postgres.Sql){
 const router=Router();
 router.use((req:AuthedRequest,res,next)=>{if(!req.auth){res.status(401).json({error:'Authentication required.'});return;}next();});
 router.get('/fast',async (_req,res)=>{
  let sql:postgres.Sql|null=null;try{sql=getDb();res.setHeader('Cache-Control','no-store');res.json({success:true,data:await readFast(sql)});}
  catch{res.status(503).json({error:'Fast could not be loaded. Please retry.'});}finally{if(sql)await sql.end();}
 });
 router.put('/fast/:category/:furnishing',async(req:AuthedRequest,res)=>{
  let cell;try{cell=validateFast(req.params.category,req.params.furnishing,req.body?.unit_numbers,req.body?.revision);}
  catch(e){res.status(400).json({error:e instanceof Error?e.message:'Invalid cell.'});return;}
  let sql:postgres.Sql|null=null;try{sql=getDb();
   const result=await writeFast(sql,cell,actorFrom(req));
   res.setHeader('Cache-Control','no-store');
   if(result.saved)res.json({success:true,data:result.saved});
   else res.status(409).json({error:'This cell changed elsewhere. Your input has been kept.',current:result.current});
  }catch{res.status(503).json({error:'Save could not be confirmed. Your input has been kept. Retry to check the latest version.'});}
  finally{if(sql)await sql.end();}
 });
 router.post('/fast/reset',async(req:AuthedRequest,res)=>{
  let expected;try{expected=validateReset(req.body?.revisions);}catch(e){res.status(400).json({error:(e as Error).message});return;}
  let sql:postgres.Sql|null=null;
  try{sql=getDb();const result=await resetFast(sql,expected,actorFrom(req));res.setHeader('Cache-Control','no-store');res.json({success:true,...result});}
  catch(e){res.status(e instanceof ResetError?e.status:503).json({error:e instanceof ResetError?e.message:'Reset could not be confirmed. Your displayed values were kept. Reload to check saved values before retrying.'});}
  finally{if(sql)await sql.end();}
 });
 return router;
}
