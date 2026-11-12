import test from 'node:test';
import assert from 'node:assert/strict';
import {ready,c} from './dossier-owning-fixture.ts';
import {KnowledgeRepository,KNOWLEDGE_KIND,KNOWLEDGE_KEY,EVIDENCE_LINKS_KIND,EVIDENCE_LINKS_KEY} from '../src/repository.ts';
import {scoped,verifyAudit} from '@accountability/evidence-sql/database';
const select=(f:Awaited<ReturnType<typeof ready>>)=>({claim:f.d.knowledge.records[0]!.ref,links:f.input.linkRef});
test('owning dossier loads actual containing histories and every current/historical source obligation',async t=>{
 const f=await ready(t);const q=select(f);
 const result=await f.repo.prepareClaimDossier(c,q);
 assert.equal(result.knowledgeStorage.kind,KNOWLEDGE_KIND);assert.equal(result.linksStorage.kind,EVIDENCE_LINKS_KIND);
 assert.equal(result.knowledgeStorage.revision,1);assert.equal(result.linksStorage.revision,1);
 assert.equal(result.sourceObligations.length,2);assert.equal(result.dossier.claim.value.type,'claim');
 const later=await f.repo.recordEvidenceLinks(c,1,f.d.evidence,{claim:q.claim,expectedRevision:1,links:[]},'empty');
 const next=await f.repo.prepareClaimDossier(c,{...q,links:later.record});
 assert.equal(next.dossier.citations.links.length,0);assert.equal(next.sourceObligations.length,1);
 assert.equal(next.sourceObligations[0]!.linkId,'contrary');assert.deepEqual(next.sourceObligations[0]!.citationSet,q.links);
 assert.equal(next.dossier.historicalChallenges.length,1);assert.equal(next.linksStorage.revision,2);
 (next.sourceObligations[0]!.selector as {sha256:string}).sha256='f'.repeat(64);
 assert.notEqual((await f.repo.prepareClaimDossier(c,{...q,links:later.record})).sourceObligations[0]!.selector.sha256,'f'.repeat(64));
});
test('stale selections and host authority denial reveal no dossier and preserve history',async t=>{
 const f=await ready(t),q=select(f);
 await f.repo.recordEvidenceLinks(c,1,f.d.evidence,{claim:q.claim,expectedRevision:1,links:[]},'empty');
 await assert.rejects(f.repo.prepareClaimDossier(c,q));
 await assert.rejects(f.repo.prepareClaimDossier({...c,actor:{...c.actor,id:'unlisted'}},q));
 await assert.rejects(f.repo.prepareClaimDossier({...c,purpose:'other'},q));
 await assert.rejects(f.repo.prepareClaimDossier(c,{...q,claim:{...q.claim,projectId:'other'}}));
 assert.equal((await f.repo.load(c)).revision,1);
});
test('owning admission sees actual whole historical basis; mutation is detached and rejection rolls read audit back',async t=>{
 const f=await ready(t),q=select(f);let calls=0;
 const output=await f.repo.prepareClaimDossier(c,q,undefined,10000,b=>{calls++;assert.equal(b.knowledgeRevision,1);assert.equal(b.linksRevision,1);(b.dossier.citations.links as any[]).length=0;});
 assert.equal(calls,1);assert.equal(output.dossier.citations.links.length,2);
 for(const hook of [()=>true,()=>Promise.reject(Error('private callback details')),()=>{throw Error('private callback details');}])
  await assert.rejects(f.repo.prepareClaimDossier(c,q,undefined,10000,hook as any),e=>{assert.equal((e as any).code,'dossier_unavailable');assert.ok(!String(e).includes('private callback'));return true;});
 await scoped(f.db,c,async tx=>{const a=await tx.audits();assert.ok(verifyAudit(a));assert.equal(a.filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,1);});
});
test('pre-cancellation and expired locked admission deny; lost read COMMIT stays unknown with retained audit',async t=>{
 const f=await ready(t),q=select(f),ac=new AbortController();ac.abort();
 await assert.rejects(f.repo.prepareClaimDossier(c,q,ac.signal));
 await assert.rejects(f.repo.prepareClaimDossier(c,q,undefined,10,()=>{const end=performance.now()+30;while(performance.now()<end){};}));
 f.hooks.lost=true;await assert.rejects(f.repo.prepareClaimDossier(c,q));
 const fresh=new KnowledgeRepository(f.db,f.policy);assert.equal((await fresh.prepareClaimDossier(c,q)).dossier.citations.links.length,2);
 await scoped(f.db,c,async tx=>{const a=await tx.audits();assert.equal(a.filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,2);assert.equal((await tx.get(KNOWLEDGE_KIND,KNOWLEDGE_KEY))?.revision,1);assert.equal((await tx.get(EVIDENCE_LINKS_KIND,EVIDENCE_LINKS_KEY))?.revision,1);});
});
