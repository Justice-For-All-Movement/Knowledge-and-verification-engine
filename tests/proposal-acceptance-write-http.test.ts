import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceFixture,c} from './current-proposal-fixture.ts';
import {createProposalAcceptanceWriteHandler} from '../src/proposal-acceptance-write-http.ts';
import {scoped,verifyAudit} from '@accountability/evidence-sql/database';
const origin='https://private.invalid',base=origin+'/private/proposal-acceptance-write',csrf='s'.repeat(32);
const headers={'content-type':'application/json',origin,'x-csrf-token':csrf,'sec-fetch-site':'same-origin'};
async function setup(t:test.TestContext){
 const f=await acceptanceFixture(t),signals:AbortSignal[]=[];
 const provider={authenticate:async(_m:unknown,s:AbortSignal)=>{signals.push(s);return{actorId:c.actor.id,requestId:'http',csrfToken:csrf};}};
 const handler=createProposalAcceptanceWriteHandler(f.writer,f.membership,provider,{...f.fixed,origin},()=>c.now);
 const command={commandId:'accept',bundle:f.bundle,input:f.input};
 const request=(extra:Record<string,string>={})=>new Request(base+'/accept',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(command)});
 return {...f,signals,provider,handler,command,request};
}
test('acceptance HTTP creates one private unassessed quote-only acceptance; exact replay rechecks current Consent',async t=>{
 const f=await setup(t);
 const session=await f.handler(new Request(base+'/session'));assert.equal(session.status,200);assert.deepEqual(await session.json(),{actorId:c.actor.id,csrfToken:csrf});
 const first=await f.handler(f.request());assert.equal(first.status,200);const ack=await first.json();assert.equal(ack.claim.id,'accepted');
 assert.equal(first.headers.get('cache-control'),'no-store');assert.deepEqual(await (await f.handler(f.request())).json(),ack);
 assert.equal((await f.repo.load(c)).revision,2);assert.equal((await f.repo.loadEvidenceLinks(c)).state.records.at(-1)!.links[0]!.relation,'quotes');
 assert(f.signals.every(s=>s.aborted));
 await f.permissions.withdraw(c,'consent','text-consent',1,'withdraw');
 const denied=await f.handler(f.request());assert.equal(denied.status,503);assert.deepEqual(await denied.json(),{error:'proposal_acceptance_unknown'});
 await scoped(f.knowledge,c,async tx=>{const a=await tx.audits();assert(verifyAudit(a));assert.equal(a.filter(e=>e.type==='knowledge.proposal-acceptance.recorded').length,1);});
});
test('acceptance HTTP denies origins CSRF unsupported effects and malformed commands before acceptance',async t=>{
 const f=await setup(t);
 for(const extra of [{origin:'https://other.invalid'},{'sec-fetch-site':'cross-site'},{'x-csrf-token':'wrong'},{'x-csrf-token':'x'.repeat(257)}])assert.equal((await f.handler(f.request(extra))).status,403);
 for(const path of ['send','publish','resume','record'])assert.equal((await f.handler(new Request(base+'/'+path,{method:'POST'}))).status,404);
 for(const body of [new Uint8Array([0xff]),JSON.stringify({...f.command,authority:'owner'}),JSON.stringify({...f.command,input:{...f.input,expectedKnowledgeRevision:0}}),'x'.repeat(280*1024+1)]){
  assert.notEqual((await f.handler(new Request(base+'/accept',{method:'POST',headers,body}))).status,200);
 }
 assert.equal((await f.repo.load(c)).revision,1);
});
test('lost actual acceptance COMMIT returns unknown and explicit identical replay has one effect; acknowledged cancellation remains ACK',async t=>{
 const f=await setup(t),original=f.knowledge.transaction.bind(f.knowledge),controller=new AbortController();let lose=true,cancel=false;
 f.knowledge.transaction=fn=>{let effect=false;return original(tx=>fn({query:async<T>(sql:string,v?:unknown[])=>{const r=await tx.query<T>(sql,v);if(sql.includes('INSERT INTO public.evidence_outbox')&&v?.includes('knowledge.proposal-acceptance.recorded'))effect=true;return r;}})).then(value=>{if(effect&&lose){lose=false;throw Error('private lost acknowledgement');}if(effect&&cancel)controller.abort();return value;});};
 assert.equal((await f.handler(f.request())).status,503);const replay=await f.handler(f.request());assert.equal(replay.status,200);assert.equal((await f.repo.load(c)).revision,2);
 const bundle=await f.reader.propose(c,f.bundle.basis.linkRef,[f.candidate]);cancel=true;
 const body={commandId:'second',bundle,input:{...f.input,claimId:'second',expectedKnowledgeRevision:bundle.basis.knowledgeRevision,expectedLinksRevision:bundle.basis.linksRevision}};
 const ack=await f.handler(new Request(base+'/accept',{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal}));
 assert.equal(controller.signal.aborted,true);assert.equal(ack.status,200);assert.equal((await ack.json()).claim.id,'second');
});
test('stalled body is authenticated after member disable; blocked provider cannot enter writer after deadline',async t=>{
 const f=await setup(t),added=await f.membership.apply(c,1,{type:'set-member',id:'backup',kind:'human',roles:['owner']},'backup');
 let close!:()=>void;const body=new ReadableStream<Uint8Array>({start(s){s.enqueue(Buffer.from(JSON.stringify(f.command)));close=()=>s.close();}});
 const pending=f.handler(new Request(base+'/accept',{method:'POST',headers,body,duplex:'half'} as RequestInit));
 await f.membership.apply(c,added.revision,{type:'disable-member',id:c.actor.id},'disable');close();assert.notEqual((await pending).status,200);
 let signal:AbortSignal|undefined;
 const handler=createProposalAcceptanceWriteHandler(f.writer,f.membership,{authenticate:async(_m,s)=>{signal=s;const until=performance.now()+100;while(performance.now()<until){}return{actorId:c.actor.id,requestId:'late',csrfToken:csrf};}},{...f.fixed,origin,timeoutMs:50},()=>c.now);
 assert.equal((await handler(new Request(base+'/session'))).status,503);assert(signal?.aborted);assert.equal((await f.repo.load(c)).revision,1);
});
