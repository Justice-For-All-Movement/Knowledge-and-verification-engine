import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceFixture, c } from "./current-proposal-fixture.ts";
import { digest } from "../src/contracts.ts";
import { CurrentProposalAcceptanceWriter } from "../src/proposal-acceptance-writer.ts";
import { KnowledgeRepository } from "../src/repository.ts";
import { IdentityKnowledgeRepository } from "../src/identity-repository.ts";
import { scoped } from "@accountability/evidence-sql/database";
import type { EvidenceState } from "@accountability/evidence";
function redigest<T extends {digest:string}>(bundle:T) { const {digest:ignored,...payload}=bundle;return {...payload,digest:digest(payload)}; }
test("current same-human source/use acceptance accepts role-stripped context, stores quote only and replays original refs after unrelated history", async t => {
  const f = await acceptanceFixture(t), principal = { ...c, actor: { ...c.actor, roles: [] } };
  const ack = await f.writer.accept(principal, f.bundle, f.input, "first");
  assert.equal(ack.claim.id, "accepted");
  assert.equal(((await f.repo.load(c)).state.records.at(-1)!.value as any).assessment, null);
  assert.equal((await f.repo.loadEvidenceLinks(c)).state.records.at(-1)!.links[0]!.relation, "quotes");
  await f.repo.append(c, 2, { id: "other", expectedRevision: 0, value: { type: "entity", category: "unknown", label: "Other", description: "Fictional" } }, "other");
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
