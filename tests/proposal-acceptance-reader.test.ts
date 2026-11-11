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
  // A later parent correction does not erase the retained original ancestry or substitute its latest claim.
  await f.repo.append(c, 3, { ...f.claim, expectedRevision: 1,
    value: { ...f.claim.value, text: "Later fictional parent correction" } as typeof f.claim.value }, "parent-correction");
  const afterParent = await reader.read(principal, ack.acceptance);
  assert.deepEqual(afterParent.record.parentClaim, first.record.parentClaim);
  assert.equal(afterParent.record.parentClaim.revision, 1); assert.equal(afterParent.knowledgeStorage.revision, 4);
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
test("malformed selections and pre-cancellation reach no credentials; owning prototypes ignore instance shadows", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  let calls = 0, getter = 0, shadow = false;
  const { HumanConsentEvidenceKnowledgeReview } = await import("../src/consent-links.ts");
  const review = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, async (...args) => {
    calls++; return f.credential(...args);
  }, f.guard);
  (review as any).review = async () => { shadow = true; throw Error("shadow source"); };
  (f.facade as any).prepareProposalAcceptance = async () => { shadow = true; throw Error("shadow identity"); };
  (f.repo as any).prepareProposalAcceptance = async () => { shadow = true; throw Error("shadow repository"); };
  const facade = new IdentityKnowledgeRepository(f.repo, f.membership, f.fixed);
  const reader = new CurrentProposalAcceptanceReader(facade, review);
  const choice = { ...ack.acceptance };
  Object.defineProperty(choice, "id", { enumerable: true, get() { getter++; return ack.acceptance.id; } });
  await assert.rejects(reader.read(c, choice), { code: "proposal_acceptance_unavailable" });
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(reader.read(c, ack.acceptance, cancel.signal), { code: "proposal_acceptance_unavailable" });
  await assert.rejects(reader.read(c, { ...ack.acceptance, projectId: "foreign" }), { code: "proposal_acceptance_unavailable" });
  assert.equal(calls, 0); assert.equal(getter, 0);
  assert.equal((await reader.read(c, ack.acceptance)).record.proposalId, "candidate");
  assert.equal(shadow, false); assert(calls > 0);
});
test("lost checked-read COMMIT and cancellation after actual COMMIT withhold all private metadata without a second effect", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  const original = f.knowledge.transaction.bind(f.knowledge);
  let lose = true, cancelAt = 0, checked = 0;
  const cancelled = new AbortController();
  f.knowledge.transaction = fn => {
    let selected = false;
    return original(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => {
      const result = await tx.query<T>(sql, values);
      if (sql.includes("INSERT INTO public.evidence_audit") && values?.includes("knowledge.proposal-acceptance.read_checked")) selected = true;
      return result;
    } })).then(value => {
      if (selected && lose) { lose = false; throw Error("private lost COMMIT diagnostic"); }
      if (selected && ++checked === cancelAt) cancelled.abort();
      return value;
    });
  };
  const reader = new CurrentProposalAcceptanceReader(f.facade, f.review);
  await assert.rejects(reader.read(c, ack.acceptance), e => (e as any).code === "proposal_acceptance_unavailable" && !(e as Error).message.includes("private lost"));
  assert.equal((await reader.read(c, ack.acceptance)).acceptance.revision, 1);
  checked = 0; cancelAt = 2;
  await assert.rejects(reader.read(c, ack.acceptance, cancelled.signal), { code: "proposal_acceptance_unavailable" });
  assert.equal(cancelled.signal.aborted, true);
  await scoped(f.knowledge, c, async tx => {
    const audit = await tx.audits(); assert(verifyAudit(audit));
    assert.equal(audit.filter(e => e.type === "knowledge.proposal-acceptance.recorded").length, 1);
  });
});
test("same-ID service credentials and withdrawal during source observation cannot disclose a selected acceptance", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  const identity = f.identities.find(i => i.actor.id === c.actor.id)!, actor = identity.actor;
  identity.actor = { ...actor, kind: "service" };
  await assert.rejects(new CurrentProposalAcceptanceReader(f.facade, f.review).read(c, ack.acceptance), { code: "proposal_acceptance_unavailable" });
  identity.actor = actor;
  const observe = f.service.reviewSelectorsForHuman.bind(f.service);
  f.service.reviewSelectorsForHuman = async (...args: Parameters<typeof observe>) => {
    const result = await observe(...args);
    await f.permissions.withdraw(c, "consent", "text-consent", 1, "withdraw-during-read");
    return result;
  };
  const { HumanConsentEvidenceKnowledgeReview } = await import("../src/consent-links.ts");
  const review = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, f.guard);
  await assert.rejects(new CurrentProposalAcceptanceReader(f.facade, review).read(c, ack.acceptance), { code: "proposal_acceptance_unavailable" });
});
test("deadline includes blocked credentials and actual final locked read; source signals close on success and denial", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  const { HumanConsentEvidenceKnowledgeReview } = await import("../src/consent-links.ts");
  let captured: AbortSignal | undefined;
  const review = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, async (context, signal) => {
    captured = signal; const until = performance.now() + 200; while (performance.now() < until) {}
    return f.credential(context, signal);
  }, f.guard);
  await assert.rejects(new CurrentProposalAcceptanceReader(f.facade, review, 150).read(c, ack.acceptance), { code: "proposal_acceptance_unavailable" });
  assert(captured?.aborted);
  const original = f.knowledge.transaction.bind(f.knowledge); let reads = 0, finalLock = false;
  f.knowledge.transaction = fn => original(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => {
    const result = await tx.query<T>(sql, values);
    if (sql.includes("INSERT INTO public.evidence_audit") && values?.includes("knowledge.proposal-acceptance.read_checked")) reads++;
    if (reads === 2 && sql.includes("SELECT") && values?.includes("knowledge-proposal-acceptance")) {
      finalLock = true; const until = performance.now() + 600; while (performance.now() < until) {}
    }
    return result;
  } }));
  await assert.rejects(new CurrentProposalAcceptanceReader(f.facade, f.review, 500).read(c, ack.acceptance), { code: "proposal_acceptance_unavailable" });
  assert(finalLock);
});
test("actual fifth database with colliding refs/counts and another valid selector cannot substitute for reviewed basis", async t => {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept");
  const db = await f.database("alternate_login"), repo = new KnowledgeRepository(db, { ...f.fixed, humanIds: [c.actor.id] });
  const facade = new IdentityKnowledgeRepository(repo, f.membership, f.fixed);
  const { HumanConsentEvidenceKnowledgeReview } = await import("../src/consent-links.ts");
  const { ClaimProposalReader } = await import("../src/claim-proposals.ts");
  const { CurrentProposalAcceptanceWriter } = await import("../src/proposal-acceptance-writer.ts");
  const { HumanConsentEvidenceLinksWriter } = await import("../src/consent-links.ts");
  await repo.append(c, 0, f.claim, "parent");
  const stored = await scoped(f.evidence, c, tx => tx.get<any>("evidence.aggregate", "project"));
  await repo.recordEvidenceLinks(c, 0, stored!.value.domain, f.linkCommand, "whole");
  const selector = { ...f.selector, start: 1, quote: f.selector.quote.slice(1) };
  const link = await new HumanConsentEvidenceLinksWriter(facade, f.service, f.credential, f.guard).record(c, 1,
    { ...f.command, links: [{ id: "passage", relation: "quotes", selector }] }, "other-selector");
  const review = new HumanConsentEvidenceKnowledgeReview(facade, f.service, f.credential, f.guard);
  const bundle = await new ClaimProposalReader(review).propose(c, link.record,
    [{ ...f.candidate, start: 0, end: 6, quote: "eutral" }]);
  const other = await new CurrentProposalAcceptanceWriter(facade, review).accept(c, bundle, f.input, "alternate");
  assert.deepEqual(other.claim, ack.claim); assert.deepEqual(other.linksStorage, ack.linksStorage);
  assert.equal((await new CurrentProposalAcceptanceReader(facade, review).read(c, other.acceptance)).record.excerpt.quote, "eutral");
  await assert.rejects(new CurrentProposalAcceptanceReader(facade, f.review).read(c, other.acceptance), { code: "proposal_acceptance_unavailable" });
});
