import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped, verifyAudit } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import { IdentityKnowledgeRepository, KNOWLEDGE_RESOURCE_ID } from "../src/identity-repository.ts";
import { KnowledgeRepository, PROPOSAL_ACCEPTANCE_KIND } from "../src/repository.ts";
import { c, fixture as domain } from "./proposal-acceptance-fixture.ts";
import { digest } from "../src/contracts.ts";

async function setup(t: test.TestContext, identity = false) {
  const d = domain(true), pg = new PGlite();
  const migration = await readFile(new URL("../migrations/001_foundation.sql", import.meta.resolve("@accountability/evidence-sql/database")), "utf8");
  await pg.exec(migration);
  await pg.exec("CREATE ROLE acceptance_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO acceptance_login; SET SESSION AUTHORIZATION acceptance_login");
  t.after(() => pg.close());
  const hooks = { lost: false, rollback: "" };
  const db: Database = {
    transaction: fn => pg.transaction(async query => fn({ query: async <T>(sql: string, values?: unknown[]) => {
      const result = await query.query(sql, values);
      if (hooks.rollback === "outbox" && sql.includes("INSERT INTO public.evidence_outbox")) throw Error("fixture rollback");
      if (hooks.rollback === "acceptance" && sql.includes("INSERT") && values?.includes(PROPOSAL_ACCEPTANCE_KIND)) throw Error("fixture rollback");
      return { rows: result.rows as T[] };
    } })).then(value => {
      if (hooks.lost) { hooks.lost = false; throw Error("lost COMMIT acknowledgement"); }
      return value;
    }), close: () => pg.close(),
  };
  const policy = { tenantId: c.tenantId, projectId: c.projectId, humanIds: [c.actor.id], purpose: c.purpose };
  const repo = new KnowledgeRepository(db, policy);
  await repo.append(c, 0, { id: "parent", expectedRevision: 0, value: d.knowledge.records[0]!.value }, "parent");
  await repo.recordEvidenceLinks(c, 0, d.source, { claim: d.knowledge.records[0]!.ref, expectedRevision: 0, links: d.links.records[0]!.links.map(({ id, relation, selector }) => ({ id, relation, selector })) }, "parent-links");
  let membership: MembershipRegistry | undefined;
  if (identity) {
    const ipg = new PGlite(); await ipg.exec(migration);
    await ipg.exec("CREATE ROLE identity_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO identity_login; SET SESSION AUTHORIZATION identity_login");
    t.after(() => ipg.close());
    const idb: Database = { transaction: fn => ipg.transaction(q => fn({ query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await q.query(sql, values)).rows as T[] }) })), close: () => ipg.close() };
    membership = new MembershipRegistry(idb, { ...policy, bootstrapOwnerIds: [c.actor.id] }, () => c.now);
    await membership.initialize({ ...c, actor: { ...c.actor, roles: ["owner"] } }, "init");
  }
  return { d, pg, db, repo, hooks, policy, membership,
    facade: membership ? new IdentityKnowledgeRepository(repo, membership, policy) : null };
}
test("own restricted transaction atomically stores unassessed claim, original quote citation, immutable acceptance and audited outbox", async t => {
  const f = await setup(t);
  const ack = await f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "accept");
  assert.equal(ack.knowledgeStorage.revision, 2); assert.equal(ack.linksStorage.revision, 2);
  assert.equal(ack.acceptance.revision, 1); assert.equal(ack.claim.revision, 1);
  const fresh = new KnowledgeRepository(f.db, f.policy);
  const k = await fresh.load(c), l = await fresh.loadEvidenceLinks(c);
  assert.equal((k.state.records[1]!.value as any).assessment, null);
  assert.equal(l.state.records[1]!.links[0]!.relation, "quotes");
  assert.deepEqual(l.state.records[1]!.links[0]!.family, f.d.links.records[0]!.links[0]!.family);
  await scoped(f.db, c, async tx => {
    const stored = await tx.get<any>(ack.acceptance.kind, ack.acceptance.id);
    assert.equal(stored!.revision, 1); assert.deepEqual(stored!.value.excerpt, { start: 1, end: 3, quote: "😀" });
    assert.deepEqual(stored!.value.claim, ack.claim);
    const events = await tx.audits(); assert(verifyAudit(events));
    assert.equal(events.filter(e => e.type === "knowledge.proposal-acceptance.recorded").length, 1);
  });
});
test("lost COMMIT replay returns only original refs after later history without another acceptance effect", async t => {
  const f = await setup(t); f.hooks.lost = true;
  await assert.rejects(f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "lost"), /lost COMMIT/);
  const fresh = new KnowledgeRepository(f.db, f.policy);
  const replay = await fresh.acceptCapturedProposal(c, f.d.bundle, f.d.command, "lost");
  await fresh.append(c, 2, { id: "other", expectedRevision: 0, value: { type: "entity", category: "unknown", label: "Other", description: "Fictional" } }, "other");
  assert.deepEqual(await fresh.acceptCapturedProposal(c, f.d.bundle, f.d.command, "lost"), replay);
  assert.equal((await fresh.load(c)).revision, 3); assert.equal((await fresh.loadEvidenceLinks(c)).revision, 2);
  await assert.rejects(fresh.acceptCapturedProposal(c, f.d.bundle, { ...f.d.command, claimId: "different" }, "lost"));
});
test("acceptance-record and outbox failures roll back both histories and acceptance metadata", async t => {
  const f = await setup(t);
  for (const phase of ["acceptance", "outbox"]) {
    f.hooks.rollback = phase;
    await assert.rejects(f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "rollback-" + phase), /fixture rollback/);
    f.hooks.rollback = "";
    assert.equal((await f.repo.load(c)).revision, 1); assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  }
  assert.equal((await f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "rollback-outbox")).acceptance.revision, 1);
});
test("current Identity default denial and withdrawal deny new commands and historical replay despite forged incoming roles", async t => {
  const f = await setup(t, true), facade = f.facade!;
  await assert.rejects(facade.acceptCapturedProposal(c, f.d.bundle, f.d.command, "default-denied"), { code: "identity_unavailable" });
  await f.membership!.setResourcePolicy(c, 0, { resourceId: KNOWLEDGE_RESOURCE_ID, memberIds: [c.actor.id], purposes: [c.purpose], actions: ["investigate"] }, "allow");
  const ack = await facade.acceptCapturedProposal(c, f.d.bundle, f.d.command, "authorized");
  await f.membership!.setResourcePolicy(c, 1, { resourceId: KNOWLEDGE_RESOURCE_ID, memberIds: [], purposes: [c.purpose], actions: ["investigate"] }, "deny");
  const forged = { ...c, actor: { ...c.actor, roles: ["owner"] } };
  await assert.rejects(facade.acceptCapturedProposal(forged, f.d.bundle, f.d.command, "authorized"), { code: "identity_unavailable" });
  await assert.rejects(facade.acceptCapturedProposal(forged, f.d.bundle, { ...f.d.command, claimId: "next" }, "next"), { code: "identity_unavailable" });
  assert.equal((await f.repo.load(c)).revision, 2); assert.equal(ack.acceptance.revision, 1);
});
test("replay behind a changed parent claim is denied before cached acknowledgement without another effect", async t => {
  const f = await setup(t);
  await f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "cached-parent");
  await f.repo.append(c, 2, { id: "parent", expectedRevision: 1, value: { ...(f.d.knowledge.records[0]!.value as any), text: "Changed parent" } }, "parent-new");
  await assert.rejects(f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "cached-parent"), { code: "stale_claim" });
  assert.equal((await f.repo.load(c)).revision, 3);
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 2);
});
test("captured command and bundle cannot mutate across owning SQL awaits and malformed replay cannot change stored assertions", async t => {
  const f = await setup(t), original = f.d.bundle.proposals[0]!.assertion;
  const pending = f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "captured");
  f.d.bundle.proposals[0]!.assertion = "Caller changed after invocation";
  f.d.command.claimId = "changed-after-call";
  const ack = await pending;
  assert.equal(ack.claim.id, "accepted");
  assert.equal(((await f.repo.load(c)).state.records[1]!.value as any).text, original);
  await assert.rejects(f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "captured"));
  for (const context of [{ ...c, purpose: "other" }, { ...c, projectId: "other" }, { ...c, actor: { ...c.actor, id: "unlisted" } }])
    await assert.rejects(f.repo.acceptCapturedProposal(context, f.d.bundle, f.d.command, "forbidden"));
});
test("own locked basis admission precedes cached acknowledgements and rejects late or async admission without effects", async t => {
  const f = await setup(t);
  await f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "cached");
  let observed = 0;
  await assert.rejects(f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "cached", basis => {
    observed = basis.knowledgeRevision; throw Error("current admission denied");
  }), /current admission denied/);
  assert.equal(observed, 2);
  await assert.rejects(f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "cached", (() => Promise.reject(Error("private"))) as any), { code: "invalid_policy" });
  assert.equal((await f.repo.load(c)).revision, 2);
});
test("preexisting acceptance metadata is never overwritten or deleted to force a new acceptance", async t => {
  const f = await setup(t);
  const claim = { tenantId: c.tenantId, projectId: c.projectId, kind: "claim", id: "accepted", revision: 1 };
  const id = digest({ claim });
  await scoped(f.db, c, async tx => {
    await tx.audit("fixture.orphan-seeded", {});
    await tx.put(PROPOSAL_ACCEPTANCE_KIND, id, 0, { retained: "legacy orphan fixture; no inferred acceptance" });
  });
  await assert.rejects(f.repo.acceptCapturedProposal(c, f.d.bundle, f.d.command, "orphan"));
  assert.equal((await f.repo.load(c)).revision, 1);
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  await scoped(f.db, c, async tx => {
    const stored = await tx.get<any>(PROPOSAL_ACCEPTANCE_KIND, id);
    assert.equal(stored!.revision, 1);
    assert.equal(stored!.value.retained, "legacy orphan fixture; no inferred acceptance");
  });
});
test("new Identity acceptance binds the owning repository prototype instead of a shadowed instance method", async t => {
  const f = await setup(t, true);
  await f.membership!.setResourcePolicy(c, 0, { resourceId: KNOWLEDGE_RESOURCE_ID, memberIds: [c.actor.id], purposes: [c.purpose], actions: ["investigate"] }, "allow-shadow-test");
  let called = false;
  (f.repo as any).acceptCapturedProposal = async () => { called = true; throw Error("shadowed method"); };
  const facade = new IdentityKnowledgeRepository(f.repo, f.membership!, f.policy);
  const ack = await facade.acceptCapturedProposal(c, f.d.bundle, f.d.command, "bound-prototype");
  assert.equal(called, false); assert.equal(ack.claim.id, "accepted");
  assert.equal((await f.repo.load(c)).revision, 2);
});
