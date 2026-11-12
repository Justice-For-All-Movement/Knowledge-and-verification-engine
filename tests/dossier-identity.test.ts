import test from 'node:test';
import assert from 'node:assert/strict';
import {ready,fixture,c} from './dossier-identity-fixture.ts';
import {IdentityClaimDossierReader} from '../src/dossier-identity.ts';
import {KnowledgeRepository} from '../src/repository.ts';
import {KNOWLEDGE_RESOURCE_ID} from '../src/identity-repository.ts';
import {MembershipRegistry} from '@accountability/identity-policy/membership';
import {scoped} from '@accountability/evidence-sql/database';
import type {Database} from '@accountability/evidence-sql/database';
async function setup(t:test.TestContext) {
 const f=await ready(t),identity=await fixture(t);let identityCalls=0;
 const db:Database={close:async()=>{},transaction:fn=>{identityCalls++;return identity.db.transaction(fn);}};
 const owner={...c,actor:{...c.actor,roles:['owner']}};
 const membership=new MembershipRegistry(db,{tenantId:c.tenantId,projectId:c.projectId,bootstrapOwnerIds:[c.actor.id]},()=>c.now);
 await membership.initialize(owner,'init');
 const policy={resourceId:KNOWLEDGE_RESOURCE_ID,memberIds:[c.actor.id],purposes:[c.purpose],actions:['investigate' as const]};
 await membership.setResourcePolicy(owner,0,policy,'allow');
 const fixed={tenantId:c.tenantId,projectId:c.projectId,purpose:c.purpose};
 const selected={claim:f.d.knowledge.records[0]!.ref,links:f.input.linkRef};
 return {...f,owningPolicy:f.policy,identity,membership,owner,policy,fixed,selected,count:()=>identityCalls,reader:new IdentityClaimDossierReader(f.repo,membership,fixed)};
}
test('actual stored Identity permits empty caller roles; current withdrawal denies subsequent dossier read',async t=>{
 const f=await setup(t),incoming={...c,actor:{...c.actor,roles:[]}};
 const result=await f.reader.read(incoming,f.selected);assert.equal(result.sourceObligations.length,2);
 await f.membership.setResourcePolicy(f.owner,1,{...f.policy,memberIds:[]},'withdraw');
 await assert.rejects(f.reader.read({...incoming,actor:{...incoming.actor,roles:['owner']}},f.selected),{code:'dossier_unavailable'});
});
test('policy withdrawal during actual owning SQL read is rechecked after read and withholds private copy',async t=>{
 const f=await setup(t);let withdraw=true;
 const wrapped:Database={close:async()=>{},transaction:fn=>f.db.transaction(async tx=>fn({query:async<T>(sql:string,values?:unknown[])=>{
  const result=await tx.query<T>(sql,values);
  if(withdraw&&sql.includes('INSERT INTO public.evidence_audit')){withdraw=false;await f.membership.setResourcePolicy(f.owner,1,{...f.policy,memberIds:[]},'withdraw');}
  return result;
 }}))};
 const reader=new IdentityClaimDossierReader(new KnowledgeRepository(wrapped,f.owningPolicy),f.membership,f.fixed);
 await assert.rejects(reader.read(c,f.selected),{code:'dossier_unavailable'});
 await scoped(f.db,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,1));
});
test('actual owning lost COMMIT is sanitized unknown read; explicit later read has unchanged storage',async t=>{
 const f=await setup(t);f.hooks.lost=true;
 await assert.rejects(f.reader.read(c,f.selected),e=>{assert.equal((e as {code:string}).code,'dossier_unavailable');assert.ok(!String(e).includes('COMMIT'));return true;});
 const result=await f.reader.read(c,f.selected);assert.equal(result.knowledgeStorage.revision,1);assert.equal(result.linksStorage.revision,1);
 await scoped(f.db,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,2));
});
test('foreign scope, purpose, reference kind and cancellation deny before Identity SQL',async t=>{
 const f=await setup(t),before=f.count(),ac=new AbortController();ac.abort();
 for(const run of [()=>f.reader.read(c,f.selected,ac.signal),()=>f.reader.read({...c,projectId:'foreign'},f.selected),()=>f.reader.read({...c,purpose:'other'},f.selected),()=>f.reader.read(c,{...f.selected,claim:{...f.selected.claim,kind:'entity'}})])
  await assert.rejects(run(),{code:'dossier_unavailable'});
 assert.equal(f.count(),before);
});
test('prototype binding ignores actual instance overrides and owning admission requires synchronous void',async t=>{
 const f=await setup(t);
 f.repo.prepareClaimDossier=async()=>{throw Error('instance override must not run');};
 f.membership.resolveResource=async()=>{throw Error('instance override must not run');};
 const reader=new IdentityClaimDossierReader(f.repo,f.membership,f.fixed);
 assert.equal((await reader.read(c,f.selected)).sourceObligations.length,2);
 await assert.rejects(reader.read(c,f.selected,undefined,(()=>Promise.reject(Error('private callback'))) as never),{code:'dossier_unavailable'});
 await assert.rejects(reader.read(c,f.selected,undefined,(()=>true) as never),{code:'dossier_unavailable'});
});
