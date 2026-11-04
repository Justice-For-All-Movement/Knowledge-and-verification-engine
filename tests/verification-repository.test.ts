import test from "node:test";
import assert from "node:assert/strict";
import * as e from "@accountability/evidence";
import * as k from "../src/index.ts";
import * as l from "../src/evidence-links.ts";
import * as v from "../src/verification-review.ts";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped, verifyAudit } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import {
  KnowledgeRepository,
  VERIFICATION_REVIEWS_KIND,
  VERIFICATION_REVIEWS_KEY,
} from "../src/repository.ts";
import {
  IdentityKnowledgeRepository,
  KNOWLEDGE_RESOURCE_ID,
} from "../src/identity-repository.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "verification",
  actor: { id: "human-reviewer", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "fixture",
  now: "2026-01-01T00:00:00Z",
};
const claim: k.KnowledgeValue = {
  type: "claim",
  text: "An observer described a fictional lamp.",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "attributed_testimony",
  limitations: ["Unverified fictional assertion"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function domain() {
  let evidence = e.acquireEvidence(e.createEvidenceState(c), c, {
    id: "source",
    bytes: Buffer.from("Fictional lamp statement"),
    acquisitionId: "capture",
    storageVersionRef: "private-object",
    mediaType: "text/plain",
    sourceFamilyId: null,
    capturedAt: c.now,
    originalLanguage: "und",
    allowedPurposes: [c.purpose],
    supersedes: null,
  });
  const source = evidence.versions[0]!;
  evidence = e.beginScan(evidence, c, {
    id: "scan-start",
    evidence: source.ref,
    attemptId: "scan",
    engineVersion: "synthetic-only",
  });
  evidence = e.completeScan(evidence, c, {
    id: "scan-done",
    evidence: source.ref,
    attemptId: "scan",
    sha256: source.sha256,
    status: "clean",
    reason: "Synthetic fixture; no scanner qualification",
  });
  const knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: claim,
  });
  const selector: e.EvidenceSelector = {
    kind: "whole",
    evidence: source.ref,
    sha256: source.sha256,
  };
  const links = l.reviseEvidenceLinks(
    c,
    knowledge,
    evidence,
    l.createEvidenceLinksState(c),
    {
      claim: knowledge.records[0]!.ref,
      expectedRevision: 0,
      links: [
        { id: "support", relation: "supports", selector },
        { id: "contrary", relation: "challenges", selector },
      ],
    },
  );
  const check: v.ReviewCheck = {
    status: "reviewed",
    note: "Reviewer reports a check; this is not independent proof.",
  };
  const input: v.VerificationReviewInput = {
    linkRef: links.records[0]!.ref,
    expectedRevision: 0,
    checks: {
      authenticity: check,
      sourceKnowledge: check,
      independentSupport: {
        status: "unresolved",
        note: "Copy ancestry cannot establish independent support.",
      },
      counterevidence: {
        status: "concern",
        note: "The same source also challenges the assertion.",
      },
    },
    rationale: "Contradiction remains unresolved.",
  };
  return {
    evidence,
    knowledge,
    links,
    state: v.createVerificationReviewState(c),
    input,
  };
}
async function fixture(t: test.TestContext) {
  const pg = new PGlite();
  await pg.exec(
    await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence-sql/database"),
      ),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE knowledge_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO knowledge_login; SET SESSION AUTHORIZATION knowledge_login",
  );
  const hooks = { lost: false, rollback: false };
  const db: Database = {
    transaction: (fn) =>
      pg
        .transaction(async (query) => {
          const value = await fn({
            query: async <T>(sql: string, values?: unknown[]) => {
              const result = await query.query(sql, values);
              if (
                hooks.rollback &&
                sql.includes("INSERT INTO public.evidence_outbox")
              )
                throw Error("fixture rollback");
              return { rows: result.rows as T[] };
            },
          });
          return value;
        })
        .then((value) => {
          if (hooks.lost) {
            hooks.lost = false;
            throw Error("fixture lost COMMIT acknowledgement");
          }
          return value;
        }),
    close: () => pg.close(),
  };
  t.after(() => pg.close());
  const policy = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    humanIds: [c.actor.id],
    purpose: c.purpose,
  };
  return { db, pg, policy, hooks, repo: new KnowledgeRepository(db, policy) };
}

async function ready(t: test.TestContext) {
  const f = await fixture(t),
    d = domain();
  const initial = await f.repo.append(
    c,
    0,
    { id: "claim", expectedRevision: 0, value: claim },
    "claim",
  );
  const links = await f.repo.recordEvidenceLinks(
    c,
    0,
    d.evidence,
    {
      claim: initial.record,
      expectedRevision: 0,
      links: d.links.records[0]!.links.map(({ id, relation, selector }) => ({
        id,
        relation,
        selector,
      })),
    },
    "links",
  );
  assert.deepEqual(links.record, d.input.linkRef);
  return { ...f, d, input: d.input };
}

test("own verification history persists exact unresolved contrary observations atomically without revising claim or links", async (t) => {
  const f = await ready(t),
    before = await f.repo.load(c),
    links = await f.repo.loadEvidenceLinks(c);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
  const ack = await f.repo.recordVerificationReview(c, 0, f.input, "review");
  assert.equal(ack.storage.kind, VERIFICATION_REVIEWS_KIND);
  assert.equal(ack.record.kind, "knowledge-verification-review");
  const rows = await new KnowledgeRepository(
    f.db,
    f.policy,
  ).loadVerificationReviews(c);
  assert.equal(rows.revision, 1);
  assert.equal(rows.knowledgeRevision, 1);
  assert.equal(rows.linksRevision, 1);
  assert.equal(rows.latest[0]!.basisStatus, "current-editions");
  assert.equal(rows.state.records[0]!.resolution, "unresolved");
  assert.equal(rows.state.records[0]!.assessment, null);
  assert.deepEqual(rows.state.records[0]!.challengeLinkIds, ["contrary"]);
  assert.deepEqual(await f.repo.load(c), before);
  assert.deepEqual(await f.repo.loadEvidenceLinks(c), links);
  const audit = await scoped(f.db, c, (tx) => tx.audits());
  assert.ok(verifyAudit(audit));
  assert.equal(
    audit.filter((x) => x.type === "knowledge.verification-review.recorded")
      .length,
    1,
  );
  const outboxCount = await f.db.transaction((query) =>
    scoped(
      { transaction: (fn) => fn(query), close: async () => {} },
      c,
      async () =>
        (
          await query.query<{ n: number }>(
            "SELECT count(*)::int n FROM public.evidence_outbox WHERE topic='knowledge.verification-review.revised'",
          )
        ).rows[0]!.n,
    ),
  );
  assert.equal(outboxCount, 1);
  Object.assign(rows.state.records[0]!, { rationale: "detached" });
  assert.notEqual(
    (await f.repo.loadVerificationReviews(c)).state.records[0]!.rationale,
    "detached",
  );
});

test("verification correction serializes storage and logical CAS while retaining history and removed contrary IDs", async (t) => {
  const f = await ready(t);
  await f.repo.recordVerificationReview(c, 0, f.input, "first");
  await f.repo.recordEvidenceLinks(
    c,
    1,
    f.d.evidence,
    { claim: f.d.knowledge.records[0]!.ref, expectedRevision: 1, links: [] },
    "empty",
  );
  const next = {
    ...f.input,
    linkRef: { ...f.input.linkRef, revision: 2 },
    expectedRevision: 1,
  };
  const contenders = await Promise.allSettled(
    ["second", "contender"].map((id) =>
      f.repo.recordVerificationReview(c, 1, next, id),
    ),
  );
  assert.equal(contenders.filter((x) => x.status === "fulfilled").length, 1);
  const rows = await f.repo.loadVerificationReviews(c);
  assert.equal(rows.revision, 2);
  assert.deepEqual(rows.state.records[0]!.challengeLinkIds, ["contrary"]);
  assert.deepEqual(rows.state.records[1]!.challengeLinkIds, []);
  assert.deepEqual(
    rows.state.records[1]!.supersedes,
    rows.state.records[0]!.ref,
  );
  await assert.rejects(
    f.repo.recordVerificationReview(c, 2, next, "wrong-logical"),
    { code: "revision_conflict" },
  );
});

test("lost verification COMMIT acknowledges only the original historical edition on replay; outbox failure rolls back all effects", async (t) => {
  const f = await ready(t);
  f.hooks.lost = true;
  await assert.rejects(
    f.repo.recordVerificationReview(c, 0, f.input, "lost"),
    /lost COMMIT/,
  );
  const rows = await f.repo.loadVerificationReviews(c);
  assert.equal(rows.revision, 1);
  const ack = await new KnowledgeRepository(
    f.db,
    f.policy,
  ).recordVerificationReview(c, 0, f.input, "lost");
  assert.deepEqual(ack.record, rows.state.records[0]!.ref);
  f.hooks.rollback = true;
  await assert.rejects(
    f.repo.recordVerificationReview(
      c,
      1,
      { ...f.input, expectedRevision: 1 },
      "rollback",
    ),
    /fixture rollback/,
  );
  f.hooks.rollback = false;
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  const audits = await scoped(f.db, c, (tx) => tx.audits());
  assert.ok(verifyAudit(audits));
  assert.equal(
    audits.filter((x) => x.type === "knowledge.verification-review.recorded")
      .length,
    1,
  );
  await f.repo.recordVerificationReview(
    c,
    1,
    { ...f.input, expectedRevision: 1 },
    "rollback",
  );
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 2);
});

test("current own claim and citation editions gate new verification writes; historical acknowledgements are not fresh reviews", async (t) => {
  const f = await ready(t),
    original = await f.repo.recordVerificationReview(c, 0, f.input, "history");
  await f.repo.append(
    c,
    1,
    {
      id: "claim",
      expectedRevision: 1,
      value: { ...claim, text: "A later unresolved assertion" },
    },
    "changed-claim",
  );
  assert.equal(
    (await f.repo.loadVerificationReviews(c)).latest[0]!.basisStatus,
    "needs-review",
  );
  await assert.rejects(
    f.repo.recordVerificationReview(
      c,
      1,
      { ...f.input, expectedRevision: 1 },
      "stale",
    ),
    { code: "stale_claim" },
  );
  assert.deepEqual(
    await f.repo.recordVerificationReview(c, 0, f.input, "history"),
    original,
  );
  for (const bad of [
    { ...c, projectId: "foreign" },
    { ...c, purpose: "other" },
    { ...c, actor: { ...c.actor, kind: "service" as const } },
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
  ]) {
    await assert.rejects(f.repo.loadVerificationReviews(bad));
    await assert.rejects(
      f.repo.recordVerificationReview(bad, 0, f.input, "history"),
    );
  }
});

test("verification state sequence or captured contrary corruption denies reads and cached responses without repair", async (t) => {
  const f = await ready(t);
  await f.repo.recordVerificationReview(c, 0, f.input, "review");
  const rows = await f.repo.loadVerificationReviews(c);
  await scoped(f.db, c, async (tx) => {
    await tx.put(
      VERIFICATION_REVIEWS_KIND,
      VERIFICATION_REVIEWS_KEY,
      1,
      rows.state,
    );
  });
  await assert.rejects(f.repo.loadVerificationReviews(c), {
    code: "invalid_review",
  });
  await assert.rejects(
    f.repo.recordVerificationReview(c, 0, f.input, "review"),
    { code: "invalid_review" },
  );
  const g = await ready(t);
  await g.repo.recordVerificationReview(c, 0, g.input, "review");
  const tampered = await g.repo.loadVerificationReviews(c);
  Object.assign(tampered.state.records[0]!, { challengeLinkIds: [] });
  // Deliberately appended contradictory domain history is an SDK fixture, never an import/repair API.
  await scoped(g.db, c, (tx) =>
    tx.put(
      VERIFICATION_REVIEWS_KIND,
      VERIFICATION_REVIEWS_KEY,
      1,
      tampered.state,
    ),
  );
  await assert.rejects(g.repo.loadVerificationReviews(c), {
    code: "invalid_review",
    message: "Captured challenge history conflicts with exact cited edition",
  });
  await assert.rejects(
    g.repo.recordVerificationReview(c, 0, g.input, "review"),
    { code: "invalid_review" },
  );
});

test("verification input and policy are captured before awaits and exact profiles cannot add authority", async (t) => {
  const f = await ready(t),
    input = structuredClone(f.input),
    pending = f.repo.recordVerificationReview(c, 0, input, "captured");
  Object.assign(input, { rationale: "caller changed after invocation" });
  await pending;
  assert.equal(
    (await f.repo.loadVerificationReviews(c)).state.records[0]!.rationale,
    f.input.rationale,
  );
  await assert.rejects(
    f.repo.recordVerificationReview(
      c,
      1,
      { ...f.input, expectedRevision: 1, assessment: "verified" } as never,
      "injected",
    ),
    { code: "invalid_review" },
  );
  await assert.rejects(
    f.repo.recordVerificationReview(
      c,
      1,
      { ...f.input, expectedRevision: 1, rationale: "x".repeat(4001) },
      "large",
    ),
  );
  const repo = new KnowledgeRepository(f.db, f.policy);
  f.policy.humanIds.length = 0;
  assert.equal((await repo.loadVerificationReviews(c)).revision, 1);
});

test("actual owning Identity resource authority is reloaded for verification reads writes and historical replay", async (t) => {
  const f = await ready(t),
    identity = await fixture(t);
  const owner: Context = { ...c, actor: { ...c.actor, roles: ["owner"] } };
  const membership = new MembershipRegistry(
    identity.db,
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      bootstrapOwnerIds: [c.actor.id],
    },
    () => c.now,
  );
  await membership.initialize(owner, "identity-init");
  const policy = {
    resourceId: KNOWLEDGE_RESOURCE_ID,
    memberIds: [c.actor.id],
    purposes: [c.purpose],
    actions: ["investigate" as const],
  };
  await membership.setResourcePolicy(owner, 0, policy, "allow");
  const facade = new IdentityKnowledgeRepository(f.repo, membership, {
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
  });
  const incoming = { ...c, actor: { ...c.actor, roles: ["forged"] } };
  const ack = await facade.recordVerificationReview(
    incoming,
    0,
    f.input,
    "identity-review",
  );
  assert.equal((await facade.loadVerificationReviews(incoming)).revision, 1);
  await membership.setResourcePolicy(
    owner,
    1,
    { ...policy, memberIds: [] },
    "revoke",
  );
  await assert.rejects(facade.loadVerificationReviews(owner), {
    code: "identity_unavailable",
  });
  await assert.rejects(
    facade.recordVerificationReview(owner, 0, f.input, "identity-review"),
    { code: "identity_unavailable" },
  );
  await membership.setResourcePolicy(owner, 2, policy, "restore");
  assert.deepEqual(
    await facade.recordVerificationReview(
      incoming,
      0,
      f.input,
      "identity-review",
    ),
    ack,
  );
  await scoped(identity.db, c, async (tx) =>
    assert.equal(
      await tx.get(VERIFICATION_REVIEWS_KIND, VERIFICATION_REVIEWS_KEY),
      null,
    ),
  );
  await scoped(identity.db, c, async (tx) =>
    assert.equal((await tx.list("identity-membership")).length, 1),
  );
  await scoped(f.db, c, async (tx) =>
    assert.equal((await tx.list("identity-membership")).length, 0),
  );
  const signal = new AbortController();
  signal.abort();
  await assert.rejects(
    facade.loadVerificationReviews(incoming, signal.signal),
    { code: "identity_unavailable" },
  );
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
});

test("own verification checked lock precedes all actual claim citation review reads and cached response admission", async (t) => {
  const f = await ready(t),
    queries: { sql: string; values: unknown[] }[] = [];
  await f.repo.recordVerificationReview(c, 0, f.input, "cached");
  const db: Database = {
    close: async () => {},
    transaction: (fn) =>
      f.db.transaction((query) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            queries.push({ sql, values: values ?? [] });
            return query.query<T>(sql, values);
          },
        }),
      ),
  };
  const repo = new KnowledgeRepository(db, f.policy);
  await repo.recordVerificationReview(c, 0, f.input, "cached");
  const lock = queries.findIndex((x) =>
    x.sql.includes("INSERT INTO public.evidence_audit"),
  );
  assert.ok(lock >= 0);
  for (const kind of [
    "knowledge-history",
    "knowledge-evidence-links-history",
    VERIFICATION_REVIEWS_KIND,
  ]) {
    const read = queries.findIndex(
      (x) =>
        x.sql.includes("SELECT") &&
        x.sql.includes("public.evidence_record") &&
        x.values.includes(kind),
    );
    assert.ok(
      read > lock,
      `${kind} must be read after the checked owning lock`,
    );
  }
  const cache = queries.findIndex(
    (x) =>
      x.sql.includes("SELECT") && x.sql.includes("public.evidence_idempotency"),
  );
  const reviewRead = queries.findIndex(
    (x) =>
      x.sql.includes("SELECT") &&
      x.sql.includes("public.evidence_record") &&
      x.values.includes(VERIFICATION_REVIEWS_KIND),
  );
  assert.ok(
    cache > reviewRead,
    "Cached acknowledgement must follow current stored history validation",
  );
});
