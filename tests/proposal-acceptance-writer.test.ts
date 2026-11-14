import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceFixture, c } from "./current-proposal-fixture.ts";
import { digest } from "../src/contracts.ts";
import { CurrentProposalAcceptanceWriter } from "../src/proposal-acceptance-writer.ts";
import { KnowledgeRepository } from "../src/repository.ts";
import { IdentityKnowledgeRepository } from "../src/identity-repository.ts";
import { scoped } from "@accountability/evidence-sql/database";
import type { EvidenceState } from "@accountability/evidence";
import { HumanConsentEvidenceKnowledgeReview } from "../src/consent-links.ts";
import { captureClaimProposalBundle, inspectClaimProposals } from "../src/claim-proposal-review.ts";
function redigest<T extends {digest:string}>(bundle:T) { const {digest:ignored,...payload}=bundle;return {...payload,digest:digest(payload)}; }
test("current same-human source/use acceptance accepts role-stripped context, stores quote only and replays original refs after unrelated history", async t => {
  const f = await acceptanceFixture(t), principal = { ...c, actor: { ...c.actor, roles: [] } };
  const ack = await f.writer.accept(principal, f.bundle, f.input, "first");
  assert.equal(ack.claim.id, "accepted");
  assert.equal(((await f.repo.load(c)).state.records.at(-1)!.value as any).assessment, null);
  assert.equal((await f.repo.loadEvidenceLinks(c)).state.records.at(-1)!.links[0]!.relation, "quotes");
  await f.repo.append(c, 2, { id: "other", expectedRevision: 0, value: { type: "entity", category: "unknown", label: "Other", description: "Fictional" } }, "other");
  const before = await f.review.review(c, f.bundle.basis.linkRef);
  await f.service.acquire(f.req, { id: "unrelated-source", acquisitionId: "unrelated-fixture", bytes: Buffer.from("Unrelated fictional bytes"),
    mediaType: "text/plain", capturedAt: c.now, originalLanguage: "und", supersedes: null, expectedRevision: before.evidenceRevision!, idempotencyKey: "unrelated-source" });
  const current = await f.review.review(c, f.bundle.basis.linkRef);
  assert.ok(current.evidenceRevision! > f.bundle.basis.evidenceRevision!);
  assert.deepEqual(await f.writer.accept(principal, f.bundle, f.input, "first"), ack);
  assert.equal((await f.repo.load(c)).revision, 3);
});
test("current withdrawal denies historical replay and cannot create a second acceptance", async t => {
  const f = await acceptanceFixture(t);
  const ack = await f.writer.accept(c, f.bundle, f.input, "before-withdrawal");
  await f.permissions.withdraw(c, "consent", "text-consent", 1, "withdraw");
  await assert.rejects(f.writer.accept(c, f.bundle, f.input, "before-withdrawal"), { code: "proposal_acceptance_unavailable" });
  assert.equal((await f.repo.load(c)).revision, 2);
  assert.equal(ack.acceptance.revision, 1);
});
test("recomputed fingerprint and observation editions cannot authenticate a new acceptance", async t => {
  const f = await acceptanceFixture(t), wrong = structuredClone(f.bundle);
  wrong.proposals[0]!.citation.selectorFingerprint = "f".repeat(64);
  await assert.rejects(f.writer.accept(c, redigest(wrong), f.input, "forged"), { code: "proposal_acceptance_unavailable" });
  const edition = structuredClone(f.bundle); edition.basis.evidenceRevision!++;
  await assert.rejects(f.writer.accept(c, redigest(edition), f.input, "wrong-edition"), { code: "proposal_acceptance_unknown" });
  assert.equal((await f.repo.load(c)).revision, 1);
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 2);
});
test("actual alternate writer database with colliding refs/counts cannot accept a different unreviewed selector", async t => {
  const f = await acceptanceFixture(t), db = await f.database("alternate_login");
  const repo = new KnowledgeRepository(db, { ...f.fixed, humanIds: [c.actor.id] });
  await repo.append(c, 0, f.claim, "parent");
  const stored = await scoped(f.evidence, c, tx => tx.get<{domain:EvidenceState}>("evidence.aggregate", "project"));
  await repo.recordEvidenceLinks(c, 0, stored!.value.domain, f.linkCommand, "whole");
  const otherSelector = { ...f.selector, start: 1, quote: f.selector.quote.slice(1) };
  await repo.recordEvidenceLinks(c, 1, stored!.value.domain, { ...f.command, links: [{ id: "passage", relation: "quotes", selector: otherSelector }] }, "different-selector");
  const facade = new IdentityKnowledgeRepository(repo, f.membership, f.fixed);
  const writer = new CurrentProposalAcceptanceWriter(facade, f.review);
  await assert.rejects(writer.accept(c, f.bundle, f.input, "colliding"), { code: "proposal_acceptance_unknown" });
  assert.equal((await repo.load(c)).revision, 1); assert.equal((await repo.loadEvidenceLinks(c)).revision, 2);
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("lost owning COMMIT stays unknown, exact current replay has one effect, and acknowledged commit survives cancellation", async t => {
  const f = await acceptanceFixture(t), original = f.knowledge.transaction.bind(f.knowledge);
  const controller = new AbortController(); let lose = true, cancel = false;
  f.knowledge.transaction = fn => {
    let effect = false;
    return original(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => {
      const result = await tx.query<T>(sql, values);
      if (sql.includes("INSERT INTO public.evidence_outbox") && values?.includes("knowledge.proposal-acceptance.recorded")) effect = true;
      return result;
    } })).then(value => {
      if (effect && lose) { lose = false; throw Error("lost actual COMMIT acknowledgement"); }
      if (effect && cancel) controller.abort();
      return value;
    });
  };
  await assert.rejects(f.writer.accept(c, f.bundle, f.input, "lost"), { code: "proposal_acceptance_unknown" });
  assert.equal((await f.repo.load(c)).revision, 2);
  const ack = await f.writer.accept(c, f.bundle, f.input, "lost");
  assert.equal(ack.acceptance.revision, 1); assert.equal((await f.repo.load(c)).revision, 2);
  const bundle = await f.reader.propose(c, f.bundle.basis.linkRef, [f.candidate]);
  cancel = true;
  const acknowledged = await f.writer.accept(c, bundle, { ...f.input, claimId: "second",
    expectedKnowledgeRevision: bundle.basis.knowledgeRevision, expectedLinksRevision: bundle.basis.linksRevision }, "cancelled-after-commit", controller.signal);
  assert.equal(controller.signal.aborted, true); assert.equal(acknowledged.claim.id, "second");
  assert.equal((await f.repo.load(c)).revision, 3);
});
test("malformed/accessor inputs, cancelled calls and async outer admission cannot reach credentials", async t => {
  const f = await acceptanceFixture(t); let credentials = 0;
  const credential = async (...args: Parameters<typeof f.credential>) => { credentials++; return f.credential(...args); };
  const review = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, credential, f.guard);
  const writer = new CurrentProposalAcceptanceWriter(f.facade, review);
  const bundle = { ...f.bundle }; let getterReads = 0;
  Object.defineProperty(bundle, "proposals", { enumerable: true, get() { getterReads++; return f.bundle.proposals; } });
  await assert.rejects(writer.accept(c, bundle, f.input, "accessor"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(writer.accept(c, f.bundle, f.input, "cancelled", controller.signal));
  await assert.rejects(writer.accept(c, f.bundle, f.input, "async", undefined, (() => Promise.reject(Error("private"))) as any));
  assert.equal(credentials, 0); assert.equal(getterReads, 0);
  assert.throws(() => inspectClaimProposals({ ...c, actor: { ...c.actor, roles: [] } }, f.bundle), { code: "forbidden" });
  assert.equal(captureClaimProposalBundle({ ...c, actor: { ...c.actor, roles: [] } }, f.bundle).digest, f.bundle.digest);
});
test("deadline includes blocked source credential and locked new/cache admission; signals close without acceptance effects", async t => {
  const f = await acceptanceFixture(t); let signal: AbortSignal | undefined;
  const credential = async (context: typeof c, s: AbortSignal) => {
    signal = s; const until = performance.now() + 100; while (performance.now() < until) {}
    return f.credential(context, s);
  };
  const writer = new CurrentProposalAcceptanceWriter(f.facade,
    new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, credential, f.guard), 50);
  await assert.rejects(writer.accept(c, f.bundle, f.input, "late"), { code: "proposal_acceptance_unavailable" });
  assert.equal(signal!.aborted, true); assert.equal((await f.repo.load(c)).revision, 1);
  const original = f.knowledge.transaction.bind(f.knowledge); let sourceDone = false, locked = false, writing = false;
  const capture = f.service.reviewSelectorsForHuman.bind(f.service);
  f.service.reviewSelectorsForHuman = async (...args: Parameters<typeof capture>) => {
    const result = await capture(...args); sourceDone = true; return result;
  };
  const current = new CurrentProposalAcceptanceWriter(f.facade,
    new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, f.guard));
  f.knowledge.transaction = fn => original(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => {
    const result = await tx.query<T>(sql, values);
    if (sql.includes("INSERT INTO public.evidence_audit") && values?.includes("knowledge.proposal-acceptance.checked")) writing = true;
    if (writing && sql.includes("SELECT") && values?.includes("knowledge-evidence-links-history")) locked = true;
    return result;
  } }));
  const admit = () => { if (locked) throw Error("outer admission closed"); };
  await assert.rejects(current.accept(c, f.bundle, f.input, "locked", undefined, admit), { code: "proposal_acceptance_unknown" });
  assert.equal(sourceDone, true); assert.equal(locked, true); assert.equal((await f.repo.load(c)).revision, 1);
  locked = false; writing = false;
  await current.accept(c, f.bundle, f.input, "locked");
  locked = false; writing = false;
  await assert.rejects(current.accept(c, f.bundle, f.input, "locked", undefined, admit), { code: "proposal_acceptance_unknown" });
  assert.equal(locked, true); assert.equal((await f.repo.load(c)).revision, 2);
});
test("same-ID service credentials and withdrawal during actual source observation cannot become human acceptance", async t => {
  const f = await acceptanceFixture(t);
  const identity = f.identities.find(i => i.actor.id === c.actor.id)!;
  const actor = identity.actor;
  identity.actor = { ...actor, kind: "service" };
  await assert.rejects(f.writer.accept(c, f.bundle, f.input, "service"), { code: "proposal_acceptance_unavailable" });
  identity.actor = actor;
  const observe = f.service.reviewSelectorsForHuman.bind(f.service);
  f.service.reviewSelectorsForHuman = async (...args: Parameters<typeof observe>) => {
    const result = await observe(...args);
    await f.permissions.withdraw(c, "consent", "text-consent", 1, "withdraw-during-review");
    return result;
  };
  const writer = new CurrentProposalAcceptanceWriter(f.facade,
    new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, f.guard));
  await assert.rejects(writer.accept(c, f.bundle, f.input, "withdrawn-during-review"), { code: "proposal_acceptance_unavailable" });
  assert.equal((await f.repo.load(c)).revision, 1);
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 2);
});
test("coordinator binds owning review and Identity implementations instead of shadowed instance methods", async t => {
  const f = await acceptanceFixture(t); let shadow = false;
  (f.review as any).review = async () => { shadow = true; throw Error("shadow review"); };
  (f.facade as any).acceptCapturedProposal = async () => { shadow = true; throw Error("shadow write"); };
  const writer = new CurrentProposalAcceptanceWriter(f.facade, f.review);
  const ack = await writer.accept(c, f.bundle, f.input, "prototype-bound");
  assert.equal(shadow, false); assert.equal(ack.claim.id, "accepted");
});
