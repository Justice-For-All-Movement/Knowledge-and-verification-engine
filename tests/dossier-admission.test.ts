import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceFixture,c} from './dossier-source-fixture.ts';
import {scoped} from '@accountability/evidence-sql/database';

test('request admission requires synchronous void before Identity or credential work and observes native rejection',async t=>{
 const f=await sourceFixture(t),reader=f.makeReader();let transactions=0;
 const transaction=f.identity.transaction.bind(f.identity);
 f.identity.transaction=fn=>{transactions++;return transaction(fn);};
 for(const admit of [()=>true,()=>Promise.reject(Error('private admission')),()=>{throw Error('private admission');}])
  await assert.rejects(reader.read(c,f.selected,undefined,admit as never),e=>{
   assert.ok(!String(e).includes('private admission'));return (e as {code:string}).code==='dossier_unavailable';
  });
 assert.equal(transactions,0);assert.equal(f.count(),0);
 assert.equal((await reader.read(c,f.selected,undefined,()=>{})).sourceObligations.length,2);
});
test('outer live monotonic deadline is enforced at actual first owning checked lock before history release or credentials',async t=>{
 const f=await sourceFixture(t),transaction=f.knowledge.transaction.bind(f.knowledge);let deadline=Infinity,locked=false;
 f.knowledge.transaction=fn=>transaction(q=>fn({query:async<T>(sql:string,args?:unknown[])=>{
  const result=await q.query<T>(sql,args);
  if(sql.includes('INSERT INTO public.evidence_audit')){locked=true;deadline=performance.now()-1;}
  return result;
 }}));
 await assert.rejects(f.makeReader().read(c,f.selected,undefined,()=>{
  if(performance.now()>=deadline)throw Error('private outer deadline');
 }),{code:'dossier_unavailable'});
 assert(locked);assert.equal(f.count(),0);
 await scoped(f.knowledge,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,0));
});
test('external request admission withholds post-credential data and closes signals without cancelling begun transactions',async t=>{
 const f=await sourceFixture(t);let deadline=Infinity;
 f.hooks.credential=async()=>{deadline=performance.now()-1;};
 await assert.rejects(f.makeReader().read(c,f.selected,undefined,()=>{
  if(performance.now()>=deadline)throw Error('private outer deadline');
 }),{code:'dossier_unavailable'});
 assert.equal(f.count(),1);assert.equal(f.signal()?.aborted,true);
 await scoped(f.evidence,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='evidence.selectors.review_checked').length,0));
});
