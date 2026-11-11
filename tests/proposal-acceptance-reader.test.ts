import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceFixture, c } from "./current-proposal-fixture.ts";
import { CurrentProposalAcceptanceReader } from "../src/proposal-acceptance-reader.ts";
import { KnowledgeRepository, KNOWLEDGE_KIND, KNOWLEDGE_KEY, EVIDENCE_LINKS_KIND, EVIDENCE_LINKS_KEY } from "../src/repository.ts";
import { IdentityKnowledgeRepository } from "../src/identity-repository.ts";
import { scoped, verifyAudit } from "@accountability/evidence-sql/database";
import type { Json } from "../src/contracts.ts";

test("selected owning/current read retains original metadata and actual containing revisions without an effect", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  const principal = { ...c, actor: { ...c.actor, roles: [] } };
  const reader = new CurrentProposalAcceptanceReader(f.facade, f.review);
  const first = await reader.read(principal, ack.acceptance);
  assert.deepEqual(first.record.claim, ack.claim); assert.deepEqual(first.citation.ref, ack.links);
  assert.equal(first.citation.links[0]!.relation, "quotes");
  assert.equal(first.record.bundleDigest, f.bundle.digest); assert.equal(first.record.excerpt.quote, "Neutral");
  assert.equal(first.knowledgeStorage.revision, 2); assert.equal(first.linksStorage.revision, 3);
  await f.repo.append(c, 2, { id: "other", expectedRevision: 0, value: { type: "entity", category: "unknown", label: "Other", description: "Fictional" } }, "other");
  const second = await reader.read(principal, ack.acceptance);
  assert.deepEqual(second.record, first.record); assert.equal(second.knowledgeStorage.revision, 3);
  (second.record.excerpt as any).quote = "changed caller copy";
  assert.equal((await reader.read(principal, ack.acceptance)).record.excerpt.quote, "Neutral");
  await scoped(f.knowledge, c, async tx => {
    const audit = await tx.audits(); assert(verifyAudit(audit));
    assert.equal(audit.filter(e => e.type === "knowledge.proposal-acceptance.recorded").length, 1);
  });
});
test("owning read validates actual immutable receipt and histories, retaining corrupt/orphan state on denial", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  const good = await f.repo.prepareProposalAcceptance(c, ack.acceptance);
  const k = await f.repo.load(c), l = await f.repo.loadEvidenceLinks(c);
  const mutations = [
    (r: any) => { r.parentKnowledgeRevision++; },
    (r: any) => { r.parentLinksRevision--; },
    (r: any) => { r.actorId = "another"; },
    (r: any) => { r.parentRelation = "supports"; },
    (r: any) => { r.excerpt.quote = "invented"; },
    (r: any) => { r.claim.id = "absent"; },
    (r: any) => { r.extra = "authority"; },
  ];
  for (let i = -1; i < mutations.length; i++) {
    const db = await f.database("corrupt_login"), receipt = structuredClone(good.record);
    if (i >= 0) mutations[i]!(receipt);
    const { digest } = await import("../src/contracts.ts");
    const ref = { ...ack.acceptance, id: digest({ claim: receipt.claim }) };
    await scoped(db, c, async tx => {
      await tx.audit("fixture.imported-history", {});
      for (let n = 0; n < k.revision; n++) await tx.put(KNOWLEDGE_KIND, KNOWLEDGE_KEY, n,
        { ...k.state, records: k.state.records.slice(0, n + 1) });
      for (let n = 0; n < l.revision; n++) await tx.put(EVIDENCE_LINKS_KIND, EVIDENCE_LINKS_KEY, n,
        { ...l.state, records: l.state.records.slice(0, n + 1) });
      await tx.put(ref.kind, ref.id, 0, receipt as unknown as Json);
    });
    const repo = new KnowledgeRepository(db, { ...f.fixed, humanIds: [c.actor.id] });
    if (i < 0) assert.deepEqual((await repo.prepareProposalAcceptance(c, ref)).record, good.record);
    else await assert.rejects(repo.prepareProposalAcceptance(c, ref), { code: "invalid_acceptance" });
    assert.deepEqual(await scoped(db, c, tx => tx.get(ref.kind, ref.id)).then(r => r!.value), receipt);
  }
  await scoped(f.knowledge, c, async tx => { await tx.audit("fixture.changed-edition", {}); await tx.put(ack.acceptance.kind, ack.acceptance.id, 1, good.record); });
  await assert.rejects(f.repo.prepareProposalAcceptance(c, ack.acceptance));
  assert.equal((await f.repo.load(c)).revision, 2);
});
test("current withdrawal and Identity revocation deny private reads despite supplied owner roles", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  const reader = new CurrentProposalAcceptanceReader(f.facade, f.review);
  await f.permissions.withdraw(c, "consent", "text-consent", 1, "withdraw");
  await assert.rejects(reader.read(c, ack.acceptance), { code: "proposal_acceptance_unavailable" });
  await f.membership.setResourcePolicy(c, 2, { ...f.policy, memberIds: [] }, "revoke");
  await assert.rejects(f.facade.prepareProposalAcceptance(c, ack.acceptance), { code: "identity_unavailable" });
  assert.equal((await f.repo.load(c)).revision, 2);
});
test("owning selected read gate precedes release and rejects asynchronous admission; updated accepted claim denies", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  let observed = 0;
  await assert.rejects(f.repo.prepareProposalAcceptance(c, ack.acceptance, b => { observed = b.linksRevision; throw Error("gate"); }), /gate/);
  assert.equal(observed, 3);
  await assert.rejects(f.repo.prepareProposalAcceptance(c, ack.acceptance, (() => Promise.reject(Error("private"))) as any), { code: "invalid_policy" });
  const value = (await f.repo.load(c)).state.records.at(-1)!.value;
  await f.repo.append(c, 2, { id: "accepted", expectedRevision: 1, value }, "new-claim-edition");
  await assert.rejects(new CurrentProposalAcceptanceReader(f.facade, f.review).read(c, ack.acceptance), { code: "proposal_acceptance_unavailable" });
});
