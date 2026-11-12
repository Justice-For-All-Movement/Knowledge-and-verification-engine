import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceFixture,c} from './dossier-source-fixture.ts';
import {CurrentEvidenceUse} from '../src/consent-links.ts';
import {scoped} from '@accountability/evidence-sql/database';

test('actual four-database dossier retains historical removed challenge and checks every disclosed source',async t=>{
 const f=await sourceFixture(t),reader=f.makeReader();
 const result=await reader.read({...c,actor:{...c.actor,roles:[]}},f.selected);
 assert.equal(result.dossier.citations.links.length,1);assert.equal(result.dossier.historicalChallenges.length,1);
 assert.equal(result.dossier.historicalChallenges[0]!.link.id,'contrary');assert.equal(result.sourceObligations.length,2);
 assert.equal(f.count(),1);assert.equal(f.signal()?.aborted,true);
 await scoped(f.evidence,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='evidence.selectors.review_checked').length,1));
 (result.dossier.historicalChallenges as unknown[]).length=0;
 assert.equal((await reader.read(c,f.selected)).dossier.historicalChallenges.length,1);
});
test('missing historical mapping and withdrawn historical Consent deny before ANY source credential',async t=>{
 const f=await sourceFixture(t);
 const latestOnly=new CurrentEvidenceUse(f.membership,f.permissions,{...f.config,bindings:f.config.bindings.slice(1)},()=>f.time.now);
 await assert.rejects(f.makeReader(latestOnly).read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),0);
 await f.permissions.withdraw(c,'consent','consent',1,'withdraw-historical');
 await assert.rejects(f.makeReader().read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),0);
});
test('historical Evidence quarantine is denied even though latest citations remain usable',async t=>{
 const f=await sourceFixture(t);
 const old=await f.service.inspect(f.req,f.source.ref);
 await f.service.quarantine(f.req,f.source.ref,old.revision,'quarantine-old');
 await assert.rejects(f.makeReader().read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),1);assert.equal(f.signal()?.aborted,true);
});
test('Consent withdrawal during authenticated Evidence work is denied by the post-observation use check',async t=>{
 const f=await sourceFixture(t);
 const transaction=f.evidence.transaction.bind(f.evidence);let withdraw=true;
 f.evidence.transaction=fn=>transaction(fn).then(async value=>{if(withdraw){withdraw=false;await f.permissions.withdraw(c,'consent','consent',1,'withdraw-after-evidence');}return value;});
 await assert.rejects(f.makeReader().read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),1);assert.equal(f.signal()?.aborted,true);
});

import {CurrentClaimDossierReader} from '../src/dossier-source.ts';
import {IdentityClaimDossierReader} from '../src/dossier-identity.ts';
import {KnowledgeRepository,EVIDENCE_LINKS_KIND,EVIDENCE_LINKS_KEY} from '../src/repository.ts';
import {reviseEvidenceLinks} from '../src/evidence-links.ts';
import type {Database} from '@accountability/evidence-sql/database';
import type {EvidenceState} from '@accountability/evidence';

test('actual human credential mismatch and lost Evidence COMMIT withhold data without automatic retry',async t=>{
 const f=await sourceFixture(t),reader=f.makeReader();
 f.identities[0]={...f.identities[0]!,actor:{...f.identities[0]!.actor,id:'other-human'}};
 await assert.rejects(reader.read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),1);
 f.identities[0]={...f.identities[0]!,actor:{...f.identities[0]!.actor,id:c.actor.id}};
 const transaction=f.evidence.transaction.bind(f.evidence);let lost=true;
 f.evidence.transaction=fn=>transaction(fn).then(value=>{if(lost){lost=false;throw Error('private lost Evidence COMMIT');}return value;});
 await assert.rejects(reader.read(c,f.selected),e=>{assert.ok(!String(e).includes('COMMIT'));return (e as {code:string}).code==='dossier_unavailable';});
 assert.equal(f.count(),2);assert.equal(f.signal()?.aborted,true);
 assert.equal((await reader.read(c,f.selected)).sourceObligations.length,2);assert.equal(f.count(),3);
 await scoped(f.evidence,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='evidence.selectors.review_checked').length,2));
});
test('complete history change during credentials denies final owning read even when selected claim and citations stay current',async t=>{
 const f=await sourceFixture(t);
 f.hooks.credential=async()=>{await f.facade.append(c,1,{...f.claim,id:'other-claim'},'other-claim');};
 await assert.rejects(f.makeReader().read(c,f.selected),{code:'dossier_unavailable'});
 assert.equal(f.count(),1);f.hooks.credential=null;
 const result=await f.makeReader().read(c,f.selected);assert.equal(result.knowledgeStorage.revision,2);
 assert.equal(result.dossier.basis.knowledgeRecordCount,2);assert.equal(result.dossier.historicalChallenges.length,1);
});
test('prototype bindings ignore instance replacements; cancellation and blocked late credentials cannot disclose',async t=>{
 const f=await sourceFixture(t),guard=f.makeUse();
 assert.throws(()=>new CurrentClaimDossierReader({read:async()=>null} as never,f.service,f.credential,guard),{code:"invalid_policy"});
 f.identityReader.read=async()=>{throw Error('shadow reader');};
 f.service.reviewSelectorsForHuman=async()=>{throw Error('shadow Evidence');};
 guard.authorize=async()=>{throw Error('shadow use');};
 const reader=f.makeReader(guard);assert.equal((await reader.read(c,f.selected)).sourceObligations.length,2);
 const before=f.count(),ac=new AbortController();ac.abort();
 await assert.rejects(reader.read(c,f.selected,ac.signal),{code:'dossier_unavailable'});assert.equal(f.count(),before);
 f.hooks.credential=async()=>{const until=performance.now()+1200;while(performance.now()<until){};};
 const short=f.makeReader(f.makeUse(),1000);
 await assert.rejects(short.read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.signal()?.aborted,true);
});
// Fixture-only bulk seed uses actual domain revisions in actual owning SQL, not an admin API or work proof.
async function history(f:Awaited<ReturnType<typeof sourceFixture>>,challenges:number) {
 const knowledge=(await f.repo.load(c)).state;
 const source=await scoped(f.evidence,c,tx=>tx.get<{domain:EvidenceState}>('evidence.aggregate','project'));
 let links=(await f.repo.loadEvidenceLinks(c)).state;
 await scoped(f.knowledge,c,async tx=>{
  let stored=await tx.get(EVIDENCE_LINKS_KIND,EVIDENCE_LINKS_KEY);
  for(let i=1;i<challenges;i++){
   links=reviseEvidenceLinks(c,knowledge,source!.value.domain,links,{
    claim:f.linkCommand.claim,expectedRevision:links.records.at(-1)!.ref.revision,links:[f.linkCommand.links[1]!],
   });
   stored=await tx.put(EVIDENCE_LINKS_KIND,EVIDENCE_LINKS_KEY,stored!.revision,links);
  }
  links=reviseEvidenceLinks(c,knowledge,source!.value.domain,links,{...f.command,expectedRevision:links.records.at(-1)!.ref.revision});
  await tx.put(EVIDENCE_LINKS_KIND,EVIDENCE_LINKS_KEY,stored!.revision,links);
 });
 return {claim:f.selected.claim,links:links.records.at(-1)!.ref};
}
test('65 disclosed observations span actual same-human Evidence batches; aggregate change between batches denies',async t=>{
 const f=await sourceFixture(t),selected=await history(f,64);
 const result=await f.makeReader().read(c,selected);
 assert.equal(result.sourceObligations.length,65);assert.equal(result.dossier.historicalChallenges.length,64);assert.equal(f.count(),2);
 let calls=0;f.hooks.credential=async()=>{
  if(++calls===2){const stored=await f.service.inspect(f.req,f.next.ref);
   await f.service.acquire(f.req,{id:'unrelated',acquisitionId:'unrelated',bytes:Buffer.from('Neutral unrelated bytes'),mediaType:'text/plain',
    capturedAt:c.now,originalLanguage:'und',supersedes:null,expectedRevision:stored.revision,idempotencyKey:'unrelated'});
  }
 };
 await assert.rejects(f.makeReader().read(c,selected),{code:'dossier_unavailable'});assert.equal(calls,2);
});
test('more than256 disclosed observations fail wholly before credentials and retain all contrary history',async t=>{
 const f=await sourceFixture(t),selected=await history(f,256);
 const initial=await f.identityReader.read(c,selected);assert.equal(initial.dossier.historicalChallenges.length,256);
 await assert.rejects(f.makeReader().read(c,selected),{code:'dossier_unavailable'});assert.equal(f.count(),0);
 assert.equal((await f.identityReader.read(c,selected)).sourceObligations.length,257);
});
test('outer deadline at final actual owning lock rolls back its checked audit; no partially reviewed dossier escapes',async t=>{
 const f=await sourceFixture(t);let audits=0,slow=false;
 const db:Database={close:async()=>{},transaction:fn=>f.knowledge.transaction(async tx=>fn({query:async<T>(sql:string,args?:unknown[])=>{
  const value=await tx.query<T>(sql,args);
  if(sql.includes('INSERT INTO public.evidence_audit')&&++audits===2&&slow){const until=performance.now()+1200;while(performance.now()<until){};}
  return value;
 }}))};
 const own=new KnowledgeRepository(db,{...f.fixed,humanIds:[c.actor.id]});
 const identity=new IdentityClaimDossierReader(own,f.membership,f.fixed);
 const reader=new CurrentClaimDossierReader(identity,f.service,f.credential,f.makeUse(),1000);
 slow=true;await assert.rejects(reader.read(c,f.selected),{code:'dossier_unavailable'});assert.equal(audits,2);
 await scoped(f.knowledge,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,1));
});
test('historical claim edition remains exact after claim revision; empty latest citations still require historical source authority',async t=>{
 const f=await sourceFixture(t);
 const claim=await f.facade.append(c,1,{...f.claim,expectedRevision:1,value:{...f.claim.value,text:'Corrected neutral unassessed claim'}},'revise-claim');
 const evidence=await scoped(f.evidence,c,tx=>tx.get<{domain:EvidenceState}>('evidence.aggregate','project'));
 const links=await f.facade.recordEvidenceLinks(c,2,evidence!.value.domain,{claim:claim.record,expectedRevision:2,links:[]},'empty-current');
 const selected={claim:claim.record,links:links.record};
 const result=await f.makeReader().read(c,selected);
 assert.equal(result.dossier.claim.ref.revision,2);assert.equal(result.dossier.citations.links.length,0);
 assert.equal(result.dossier.historicalChallenges[0]!.claim.revision,1);assert.equal(result.sourceObligations.length,1);
 await f.permissions.withdraw(c,'rights-grant','rights',1,'withdraw-old-rights');
 const before=f.count();await assert.rejects(f.makeReader().read(c,selected),{code:'dossier_unavailable'});assert.equal(f.count(),before);
 const emptyClaim=await f.facade.append(c,2,{...f.claim,id:'empty-claim'},'empty-claim');
 const emptyLinks=await f.facade.recordEvidenceLinks(c,3,evidence!.value.domain,{claim:emptyClaim.record,expectedRevision:0,links:[]},'empty-links');
 const empty=await f.makeReader().read(c,{claim:emptyClaim.record,links:emptyLinks.record});
 assert.equal(empty.sourceObligations.length,0);assert.equal(f.count(),before);
});

test('lost final actual owning COMMIT retains checked history but withholds output; explicit later read never repeats effects',async t=>{
 const f=await sourceFixture(t),transaction=f.knowledge.transaction.bind(f.knowledge);let count=0,effects=0;
 f.knowledge.transaction=fn=>transaction(q=>fn({query:async<T>(sql:string,args?:unknown[])=>{
  if(sql.includes('INSERT INTO public.evidence_outbox')||sql.includes('INSERT INTO public.evidence_record')||sql.includes('INSERT INTO public.evidence_head')||sql.includes('INSERT INTO public.evidence_idempotency'))effects++;
  return q.query<T>(sql,args);
 }})).then(value=>{if(++count===2)throw Error('private final lost COMMIT');return value;});
 await assert.rejects(f.makeReader().read(c,f.selected),e=>{assert.ok(!String(e).includes('COMMIT'));return (e as {code:string}).code==='dossier_unavailable';});
 assert.equal(count,2);assert.equal(f.count(),1);
 const result=await f.makeReader().read(c,f.selected);assert.equal(result.knowledgeStorage.revision,1);assert.equal(result.linksStorage.revision,2);
 await scoped(f.knowledge,c,async tx=>{
  assert.equal((await tx.audits()).filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,4);
  assert.equal(effects,0);
 });
});
