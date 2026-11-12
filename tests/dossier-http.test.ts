import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceFixture,c} from './dossier-source-fixture.ts';
import {createDossierReadHandler} from '../src/dossier-http.ts';
import {scoped} from '@accountability/evidence-sql/database';
const origin='https://private.invalid',base=origin+'/private/dossier',csrf='s'.repeat(32);
const headers={'content-type':'application/json',origin,'sec-fetch-site':'same-origin','x-csrf-token':csrf};
async function setup(t:test.TestContext){
 const f=await sourceFixture(t),signals:AbortSignal[]=[];
 const provider={authenticate:async(_request:unknown,signal:AbortSignal)=>{signals.push(signal);return {actorId:c.actor.id,requestId:'http-dossier',csrfToken:csrf};}};
 const reader=f.makeReader(),handler=createDossierReadHandler(reader,f.membership,provider,{...f.fixed,origin},()=>c.now);
 const request=(selected:unknown=f.selected,extra:Record<string,string>={})=>new Request(base+'/read',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({selected})});
 return {...f,provider,reader,handler,request,signals};
}
test('private actual fourDB HTTP dossier read retains historical challenges and returns only session identity and CSRF',async t=>{
 const f=await setup(t);
 const session=await f.handler(new Request(base+'/session'));assert.equal(session.status,200);
 assert.deepEqual(await session.json(),{actorId:c.actor.id,csrfToken:csrf});
 const response=await f.handler(f.request());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const result=await response.json();assert.equal(result.dossier.historicalChallenges.length,1);assert.equal(result.sourceObligations.length,2);
 assert.equal(result.dossier.claim.value.assessment,null);assert(f.signals.every(s=>s.aborted));
});
test('HTTP route Origin metadata exact fields positive refs and UTF8 byte/chunk admission all precede authentication',async t=>{
 const f=await setup(t),count=f.signals.length;
 for(const request of [new Request(base+'/write',{method:'POST'}),f.request(f.selected,{origin:'https://foreign.invalid'}),
  f.request({...f.selected,extra:true}),f.request({...f.selected,claim:{...f.selected.claim,revision:0}}),
  f.request({...f.selected,links:{...f.selected.links,projectId:'foreign'}}),
  new Request(base+'/read',{method:'POST',headers,body:new Uint8Array([255])}),
  new Request(base+'/read',{method:'POST',headers,body:'x'.repeat(1025)})])
  assert.notEqual((await f.handler(request)).status,200);
 const body=new ReadableStream<Uint8Array>({start(q){for(let i=0;i<4097;i++)q.enqueue(new Uint8Array());q.close();}});
 assert.equal((await f.handler(new Request(base+'/read',{method:'POST',headers,body,duplex:'half'} as RequestInit))).status,503);
 assert.equal(f.signals.length,count);assert.equal(f.count(),0);
 assert.equal((await f.handler(f.request(f.selected,{'x-csrf-token':'wrong'}))).status,403);assert.equal(f.count(),0);
});
test('current withdrawn historical Consent denies HTTP data; session success never grants source use',async t=>{
 const f=await setup(t);await f.permissions.withdraw(c,'consent','consent',1,'withdraw-historical');
 assert.equal((await f.handler(new Request(base+'/session'))).status,200);
 const response=await f.handler(f.request());assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'dossier_unavailable'});assert.equal(f.count(),0);
});
test('lost actual owning read COMMIT yields sanitized unknown; explicit subsequent HTTP read retains audits and history',async t=>{
 const f=await setup(t),transaction=f.knowledge.transaction.bind(f.knowledge);let lose=true;
 f.knowledge.transaction=fn=>transaction(fn).then(value=>{if(lose){lose=false;throw Error('private lost COMMIT credential diagnostic');}return value;});
 assert.equal((await f.handler(f.request())).status,503);
 const response=await f.handler(f.request());assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.knowledgeStorage.revision,1);assert.equal(data.linksStorage.revision,2);
 await scoped(f.knowledge,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,3));
});
test('overall HTTP deadline is checked inside actual owning audit despite blocked timers and instance shadows',async t=>{
 const f=await setup(t),transaction=f.knowledge.transaction.bind(f.knowledge);let blocked=false;
 f.knowledge.transaction=fn=>transaction(q=>fn({query:async<T>(sql:string,args?:unknown[])=>{
  const result=await q.query<T>(sql,args);
  if(sql.includes('INSERT INTO public.evidence_audit')){blocked=true;const until=performance.now()+1100;while(performance.now()<until){};}
  return result;
 }}));
 f.reader.read=async()=>{throw Error('instance shadow must be ignored');};
 const handler=createDossierReadHandler(f.reader,f.membership,f.provider,{...f.fixed,origin,timeoutMs:1000},()=>c.now);
 const result=await handler(f.request());assert.equal(result.status,503);assert(blocked);assert.equal(f.count(),0);
 await scoped(f.knowledge,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,0));
});
test('stalled body is finished before fresh authentication and current resource recheck; cancellation and late providers close signals',async t=>{
 const f=await setup(t);let stream!:ReadableStreamDefaultController<Uint8Array>;
 const body=new ReadableStream<Uint8Array>({start(q){stream=q;}});
 const pending=f.handler(new Request(base+'/read',{method:'POST',headers,body,duplex:'half'} as RequestInit));
 await f.membership.setResourcePolicy(c,3,{...f.policy,memberIds:[]},'withdraw-during-body');assert.equal(f.signals.length,0);
 stream.enqueue(Buffer.from(JSON.stringify({selected:f.selected})));stream.close();
 assert.equal((await pending).status,503);assert.equal(f.signals.length,1);assert.equal(f.count(),0);
 const captured:AbortSignal[]=[];
 const late=createDossierReadHandler(f.reader,f.membership,{authenticate:async(_request,signal)=>{
  captured.push(signal);const until=performance.now()+50;while(performance.now()<until){};
  return {actorId:c.actor.id,requestId:'late',csrfToken:csrf};
 }},{...f.fixed,origin,timeoutMs:10},()=>c.now);
 assert.equal((await late(new Request(base+'/session'))).status,503);assert(captured.every(s=>s.aborted));
 let cancelled=false;
 const hung=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
 assert.equal((await late(new Request(base+'/read',{method:'POST',headers,body:hung,duplex:'half'} as RequestInit))).status,503);assert(cancelled);
 const ac=new AbortController();ac.abort();const before=f.signals.length;
 assert.equal((await f.handler(new Request(base+'/session',{signal:ac.signal}))).status,503);assert.equal(f.signals.length,before);
});
