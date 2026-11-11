import test from "node:test";
import assert from "node:assert/strict";
import { createCapturedClaimDossier } from "../src/claim-dossier.ts";
import { createKnowledgeState, reviseKnowledge } from "../src/index.ts";
import { createEvidenceLinksState } from "../src/evidence-links.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {tenantId:"fiction", projectId:"dossier", actor:{id:"human",kind:"human",roles:["researcher"]},purpose:"review",requestId:"synthetic",now:"2026-01-01T00:00:00Z"};
function fixture() {
  let knowledge = reviseKnowledge(c, createKnowledgeState(c), {id:"event",expectedRevision:0,value:{type:"event",label:"Fictional date",description:"Unverified",time:{earliest:null,latest:null},entityRefs:[]}});
  knowledge = reviseKnowledge(c, knowledge, {id:"claim",expectedRevision:0,value:{type:"claim",text:"Literal <script> assertion",subjectRefs:[knowledge.records[0]!.ref],time:{earliest:null,latest:null},accountType:"document_assertion",limitations:["Not verified"],assessment:null,proceduralPosture:null,editorialApproval:null}});
  const claim = knowledge.records[1]!.ref;
  const links = {...createEvidenceLinksState(c), records:[{ref:{...claim,kind:"knowledge-evidence-links"},supersedes:null,claim,visibility:"private" as const,actorId:c.actor.id,actorKind:c.actor.kind,createdAt:c.now,requestId:c.requestId,purpose:c.purpose,links:["supports","challenges","quotes"].map((relation,i)=>({id:"link"+i,relation:relation as "supports"|"challenges"|"quotes",selector:{kind:"whole",evidence:{...claim,kind:"evidence",id:"source"+i},sha256:"a".repeat(64)},family:{familyId:"copy-family",roots:["shared-root"],basisDigest:"b".repeat(64)},fingerprint:"c".repeat(64)}))}]};
  return {knowledge,links,selected:{claim,links:links.records[0]!.ref}};
}
test("captured dossier retains all contrary links, exact metadata and unknown independent tracks",()=>{
  const f=fixture(); const d=createCapturedClaimDossier(c,JSON.stringify({knowledge:f.knowledge,links:f.links}),f.selected);
  assert.deepEqual(d.citations,f.links.records[0]); assert.deepEqual(d.claim,f.knowledge.records[1]);
  assert.deepEqual(d.citations.links.map(l=>l.relation),["supports","challenges","quotes"]);
  assert.equal(d.claim.value.type,"claim"); assert.equal(d.subjects[0]!.status,"same-edition");
  assert.deepEqual(d.basis,{knowledgeRecordCount:2,linksRecordCount:1,...f.selected});
  assert.equal(d.unloaded.includes("current-source-permissions"),true);
  assert.equal(Object.hasOwn(d,"allowed"),false);
});
test("corrected date flags the exact historical subject without substituting the revised value",()=>{
  const f=fixture();f.knowledge=reviseKnowledge(c,f.knowledge,{id:"event",expectedRevision:1,value:{type:"event",label:"Corrected date",description:"Synthetic correction",time:{earliest:"2026-01-02T00:00:00Z",latest:null},entityRefs:[]}});
  const d=createCapturedClaimDossier(c,JSON.stringify({knowledge:f.knowledge,links:f.links}),f.selected);
  assert.equal(d.subjects[0]!.status,"changed-in-capture");assert.equal(d.subjects[0]!.record.ref.revision,1);assert.equal(d.subjects[0]!.latestObserved.revision,2);
  assert.equal(d.subjects[0]!.record.value.type,"event"); assert.equal(d.basis.knowledgeRecordCount,3);
  (d.subjects[0]!.record as any).value.label="mutated";assert.equal((f.knowledge.records[0]!.value as any).label,"Fictional date");
});
test("wrong roles, actor kind, purpose, selected edition, scope and authority fields deny",()=>{
  const f=fixture(), text=JSON.stringify({knowledge:f.knowledge,links:f.links});
  for(const ctx of [{...c,actor:{...c.actor,roles:[]}},{...c,actor:{...c.actor,kind:"service" as const}},{...c,purpose:"other"},{...c,projectId:"foreign"}])assert.throws(()=>createCapturedClaimDossier(ctx,text,f.selected));
  assert.throws(()=>createCapturedClaimDossier(c,text,{...f.selected,claim:{...f.selected.claim,revision:2}}));
  assert.throws(()=>createCapturedClaimDossier(c,JSON.stringify({knowledge:f.knowledge,links:f.links,allowed:true}),f.selected));
  (f.links.records[0]!.links[1] as any).approved=true;assert.throws(()=>createCapturedClaimDossier(c,JSON.stringify({knowledge:f.knowledge,links:f.links}),f.selected));
});
