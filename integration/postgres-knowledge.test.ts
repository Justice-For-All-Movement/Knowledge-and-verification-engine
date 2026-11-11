import { fixture as capturedAcceptance } from "../tests/proposal-acceptance-fixture.ts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  postgresDatabase,
  scoped,
  verifyAudit,
} from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import { createEvidenceState } from "@accountability/evidence";
import {
  KnowledgeRepository,
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
} from "../src/repository.ts";
import type { KnowledgeAppend } from "../src/repository.ts";
import type { VerificationChecks } from "../src/verification-review.ts";
import type { Context, Ref } from "../src/contracts.ts";
// Intentionally refuses arbitrary or persistent database targets. CI owns this empty fixture only.
const supplied = process.env.KVE_TEST_ADMIN_URL;
assert.ok(
  process.env.KVE_TEST_DISPOSABLE_POSTGRES === "1" && supplied,
  "Explicit disposable PostgreSQL fixture configuration required",
);
const url = new URL(supplied);
assert.ok(
  ["postgres:", "postgresql:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname === "/knowledge_ci" &&
    url.username === "postgres" &&
    !url.search &&
    !url.hash,
  "Only the designated empty loopback fixture is accepted",
);
const admin = postgresDatabase(url.toString());
before(async () => {
  await admin.transaction(async (q) => {
    assert.equal(
      (
        await q.query<{ fresh: boolean }>(
          "SELECT to_regclass('public.evidence_project') IS NULL AS fresh",
        )
      ).rows[0]!.fresh,
      true,
      "Fixture must be empty; never reset a database here",
    );
    const migration = await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence-sql/database"),
      ),
      "utf8",
    );
    assert.equal(migration.match(/^BEGIN;$/gm)?.length, 1);
    assert.equal(migration.match(/^COMMIT;$/gm)?.length, 1);
    // The SDK transaction owns BEGIN/COMMIT; every actual migration statement is unchanged.
    await q.query(migration.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, ""));
    await q.query(
      "CREATE ROLE knowledge_network_login LOGIN PASSWORD 'fixture-runtime-only' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO knowledge_network_login",
    );
  });
});
after(() => admin.close());

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function fixture(t: test.TestContext, id: string) {
  const context: Context = {
    tenantId: "fiction",
    projectId: id,
    actor: { id: "owner", kind: "human", roles: ["owner"] },
    purpose: "review",
    requestId: "fixture",
    now: "2026-01-01T00:00:00Z",
  };
  const policy = {
    tenantId: context.tenantId,
    projectId: id,
    purpose: context.purpose,
    humanIds: ["owner"],
  };
  function connect(label: string) {
    const u = new URL(url);
    u.username = "knowledge_network_login";
    u.password = "fixture-runtime-only";
    u.searchParams.set("application_name", id + "-" + label);
    const raw = postgresDatabase(u.toString());
    let closed = false;
    const db: Database = {
      transaction: raw.transaction.bind(raw),
      close: async () => {
        if (!closed) {
          closed = true;
          await raw.close();
        }
      },
    };
    t.after(() => db.close());
    return db;
  }
  const a = connect("a"),
    b = connect("b");
  const sessions = await Promise.all(
    [a, b].map((db) =>
      db.transaction((q) =>
        q.query<{ pid: number; login: string }>(
          "SELECT pg_backend_pid() AS pid, session_user AS login",
        ),
      ),
    ),
  );
  assert.notEqual(sessions[0]!.rows[0]!.pid, sessions[1]!.rows[0]!.pid);
  assert.ok(
    sessions.every((s) => s.rows[0]!.login === "knowledge_network_login"),
  );
  return {
    context,
    policy,
    a,
    b,
    connect,
    sa: new KnowledgeRepository(a, policy),
    sb: new KnowledgeRepository(b, policy),
    id,
  };
}
const entity: KnowledgeAppend = {
  id: "entity",
  expectedRevision: 0,
  value: {
    type: "entity",
    label: "Fictional entity",
    category: "person",
    description: "Unresolved fixture",
  },
};
const claim: KnowledgeAppend = {
  id: "claim",
  expectedRevision: 0,
  value: {
    type: "claim",
    text: "Fictional unverified account",
    subjectRefs: [],
    time: { earliest: null, latest: null },
    accountType: "observation",
    limitations: [],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  },
};
async function observedWait(id: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await admin.transaction((q) =>
      q.query<{ blocked: boolean }>(
        "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS blocked",
        [id + "-b"],
      ),
    );
    if (r.rows[0]!.blocked) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(
    "Independent observer must see actual PostgreSQL Lock and nonempty blocking PIDs before COMMIT",
  );
}
function held(
  db: Database,
  locked: ReturnType<typeof gate>,
  release: ReturnType<typeof gate>,
): Database {
  return {
    close: async () => {},
    transaction: (fn) =>
      db.transaction(async (q) => {
        const result = await fn(q);
        locked.resolve();
        await release.promise;
        return result;
      }),
  };
}
test(
  "independent append contenders preserve one owning storage edition and effect",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "knowledge-contenders");
    const r = await Promise.allSettled([
      f.sa.append(f.context, 0, entity, "a"),
      f.sb.append(f.context, 0, { ...entity, id: "other" }, "b"),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    const loser = r.find(
      (x) => x.status === "rejected",
    ) as PromiseRejectedResult;
    assert.equal(loser.reason.code, "revision_conflict");
    assert.equal((await f.sb.load(f.context)).revision, 1);
    await scoped(f.b, f.context, async (tx) => {
      const audits = await tx.audits();
      assert.ok(verifyAudit(audits));
      assert.equal(
        audits.filter((a) => a.type === "knowledge.appended").length,
        1,
      );
      const first = await tx.claim("fixture");
      assert.ok(first);
      await tx.acknowledge(first);
      assert.equal(await tx.claim("fixture"), null);
    });
  },
);
test(
  "lost actual append COMMIT acknowledgement replays original refs through a fresh pool without another effect",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "knowledge-lost-ack");
    let lost = false;
    const db: Database = {
      close: async () => {},
      transaction: async (fn) => {
        const result = await f.a.transaction(fn);
        lost = true;
        throw Error("fixture lost COMMIT acknowledgement");
      },
    };
    await assert.rejects(
      new KnowledgeRepository(db, f.policy).append(
        f.context,
        0,
        entity,
        "append",
      ),
      /lost COMMIT/,
    );
    assert.equal(lost, true);
    await f.a.close();
    const fresh = f.connect("fresh"),
      repo = new KnowledgeRepository(fresh, f.policy);
    const ack = await repo.append(f.context, 0, entity, "append");
    assert.equal(ack.storage.revision, 1);
    assert.equal((await repo.load(f.context)).state.records.length, 1);
    await scoped(fresh, f.context, async (tx) => {
      assert.ok(verifyAudit(await tx.audits()));
      assert.equal(
        (await tx.audits()).filter((a) => a.type === "knowledge.appended")
          .length,
        1,
      );
      const entry = await tx.claim("fixture");
      assert.ok(entry);
      await tx.acknowledge(entry);
      assert.equal(await tx.claim("fixture"), null);
    });
  },
);
for (const mode of ["claim", "links"] as const)
  test(
    `owning review observes committed ${mode} change after independently observed lock wait`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, "knowledge-review-" + mode),
        original = await f.sa.append(f.context, 0, claim, "claim"),
        evidence = createEvidenceState(f.context);
      const command = {
        claim: original.record,
        expectedRevision: 0,
        links: [],
      };
      const links = await f.sa.recordEvidenceLinks(
        f.context,
        0,
        evidence,
        command,
        "links",
      );
      const baseline = await f.sb.reviewEvidenceLinks(
        f.context,
        evidence,
        links.record,
      );
      assert.equal(baseline.linksRevision, 1);
      assert.equal(baseline.knowledgeRevision, 1);
      assert.equal(baseline.review.revision.links.length, 0);
      const locked = gate(),
        release = gate(),
        writer = new KnowledgeRepository(held(f.a, locked, release), f.policy);
      const writing =
        mode === "claim"
          ? writer.append(
              f.context,
              1,
              { ...claim, expectedRevision: 1 },
              "revise-claim",
            )
          : writer.recordEvidenceLinks(
              f.context,
              1,
              evidence,
              { ...command, expectedRevision: 1 },
              "revise-links",
            );
      let pending: Promise<unknown> | undefined;
      try {
        await Promise.race([locked.promise, writing]);
        pending = f.sb.reviewEvidenceLinks(f.context, evidence, links.record);
        const result = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await observedWait(f.id);
        release.resolve();
        await writing;
        const outcome = await result;
        assert.ok("error" in outcome);
        const code = mode === "claim" ? "stale_claim" : "stale_links";
        assert.equal((outcome.error as { code: string }).code, code);
        await f.b.close();
        const fresh = f.connect("fresh"),
          repo = new KnowledgeRepository(fresh, f.policy);
        await assert.rejects(
          repo.reviewEvidenceLinks(f.context, evidence, links.record),
          { code },
        );
        assert.equal(
          (await repo.load(f.context)).revision,
          mode === "claim" ? 2 : 1,
        );
        assert.equal(
          (await repo.loadEvidenceLinks(f.context)).revision,
          mode === "links" ? 2 : 1,
        );
        await scoped(fresh, f.context, async (tx) => {
          const audits = await tx.audits();
          assert.ok(verifyAudit(audits));
          assert.equal(
            audits.filter(
              (a) => a.type === "knowledge.evidence-links.review_checked",
            ).length,
            1,
            "Only baseline review committed; denied checked audits roll back",
          );
        });
      } finally {
        release.resolve();
        await writing;
        await pending?.catch(() => {});
      }
    },
  );
test(
  "Knowledge network adapters reject admin and lowered-admin sessions and preserve actual RLS scope",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "knowledge-isolation");
    await f.sa.append(f.context, 0, entity, "one");
    const foreign = { ...f.context, projectId: "knowledge-other" },
      otherPolicy = { ...f.policy, projectId: foreign.projectId };
    const other = new KnowledgeRepository(f.b, otherPolicy);
    await other.append(
      foreign,
      0,
      {
        ...entity,
        value: {
          ...entity.value,
          label: "Other fictional entity",
        } as typeof entity.value,
      },
      "one",
    );
    await assert.rejects(
      new KnowledgeRepository(admin, f.policy).load(f.context),
      { code: "unsafe_database_role" },
    );
    const lowered: Database = {
      close: async () => {},
      transaction: (fn) =>
        admin.transaction(async (q) => {
          await q.query("SET LOCAL ROLE evidence_runtime");
          return fn(q);
        }),
    };
    await assert.rejects(
      new KnowledgeRepository(lowered, f.policy).load(f.context),
      { code: "unsafe_database_role" },
    );
    for (const sql of [
      "CREATE TABLE public.knowledge_forbidden(id integer)",
      "SET ROLE postgres",
    ])
      await assert.rejects(
        f.b.transaction((q) => q.query(sql)),
        { code: "42501" },
      );
    assert.equal(
      (
        await f.b.transaction(async (q) => {
          await q.query("SET LOCAL ROLE evidence_runtime");
          return q.query("SELECT * FROM public.evidence_record");
        })
      ).rows.length,
      0,
    );
    await scoped(f.a, f.context, async (tx) => {
      const own = await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY);
      assert.ok(own);
      assert.ok(verifyAudit(await tx.audits()));
    });
    await scoped(f.b, { ...f.context, projectId: "absent" }, async (tx) =>
      assert.equal(await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY), null),
    );
    assert.notDeepEqual(
      (await f.sb.load(f.context)).state,
      (await other.load(foreign)).state,
    );
  },
);

function verificationInput(linkRef: Ref) {
  const check = {
    status: "unresolved" as const,
    note: "No independent source/rights check is asserted by this fixture.",
  };
  const checks: VerificationChecks = {
    authenticity: check,
    sourceKnowledge: check,
    independentSupport: check,
    counterevidence: check,
  };
  return {
    linkRef,
    expectedRevision: 0,
    checks,
    rationale: "Fictional unresolved review observation",
  };
}
for (const mode of ["pairs", "links", "verification"] as const)
  test(
    `${mode} history contenders and lost winning COMMIT acknowledgement preserve one edition`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, "knowledge-history-" + mode),
        evidence = createEvidenceState(f.context);
      const left = (
        await f.sa.append(
          f.context,
          0,
          mode === "pairs" ? entity : claim,
          "basis",
        )
      ).record;
      const right =
        mode === "pairs"
          ? (
              await f.sa.append(
                f.context,
                1,
                { ...entity, id: "right" },
                "right",
              )
            ).record
          : left;
      const pair = {
          left,
          right,
          expectedRevision: 0,
          decision: "unresolved" as const,
          rationale: "Fictional unresolved judgment",
        },
        links = { claim: left, expectedRevision: 0, links: [] };
      const verification =
        mode === "verification"
          ? verificationInput(
              (
                await f.sa.recordEvidenceLinks(
                  f.context,
                  0,
                  evidence,
                  links,
                  "citation-basis",
                )
              ).record,
            )
          : null;
      const write = (repo: KnowledgeRepository, id: string) =>
        mode === "pairs"
          ? repo.recordEntityIdentity(f.context, 0, pair, id)
          : mode === "links"
            ? repo.recordEvidenceLinks(f.context, 0, evidence, links, id)
            : repo.recordVerificationReview(f.context, 0, verification!, id);
      const locked = gate(),
        release = gate(),
        holding = held(f.a, locked, release);
      const losingAck: Database = {
        close: async () => {},
        transaction: async (fn) => {
          await holding.transaction(fn);
          throw Error("fixture lost history COMMIT acknowledgement");
        },
      };
      const winning = write(
          new KnowledgeRepository(losingAck, f.policy),
          "winner",
        ),
        result = winning.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      let pending: Promise<unknown> | undefined;
      try {
        await Promise.race([locked.promise, winning]);
        pending = write(f.sb, "contender");
        const contender = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await observedWait(f.id);
        release.resolve();
        const won = await result;
        assert.ok("error" in won);
        assert.match(String(won.error), /lost history COMMIT/);
        const lost = await contender;
        assert.ok("error" in lost);
        assert.equal(
          (lost.error as { code: string }).code,
          "revision_conflict",
        );
        await f.b.close();
        const fresh = f.connect("fresh"),
          repo = new KnowledgeRepository(fresh, f.policy),
          ack = await write(repo, "winner");
        assert.equal(ack.storage.revision, 1);
        const snapshot =
          mode === "pairs"
            ? await repo.loadEntityIdentities(f.context)
            : mode === "links"
              ? await repo.loadEvidenceLinks(f.context)
              : await repo.loadVerificationReviews(f.context);
        assert.equal(snapshot.revision, 1);
        assert.equal(snapshot.state.records.length, 1);
        assert.equal(snapshot.knowledgeRevision, mode === "pairs" ? 2 : 1);
        await scoped(fresh, f.context, async (tx) => {
          const audits = await tx.audits();
          assert.ok(verifyAudit(audits));
          assert.equal(
            audits.filter(
              (a) =>
                a.type ===
                (mode === "pairs"
                  ? "knowledge.entity-identity.recorded"
                  : mode === "links"
                    ? "knowledge.evidence-links.recorded"
                    : "knowledge.verification-review.recorded"),
            ).length,
            1,
          );
          const topics: string[] = [];
          for (;;) {
            const e = await tx.claim("fixture");
            if (!e) break;
            topics.push(e.topic);
            await tx.acknowledge(e);
          }
          assert.equal(
            topics.filter(
              (s) =>
                s ===
                (mode === "pairs"
                  ? "knowledge.entity-identity.revised"
                  : mode === "links"
                    ? "knowledge.evidence-links.revised"
                    : "knowledge.verification-review.revised"),
            ).length,
            1,
          );
        });
      } finally {
        release.resolve();
        await result;
        await pending?.catch(() => {});
      }
    },
  );

for (const mode of ["claim", "links"] as const)
  test(
    `verification append observes committed ${mode} change after required independent lock observation`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, "knowledge-verification-" + mode),
        evidence = createEvidenceState(f.context);
      const original = await f.sa.append(f.context, 0, claim, "claim");
      const command = {
        claim: original.record,
        expectedRevision: 0,
        links: [],
      };
      const links = await f.sa.recordEvidenceLinks(
          f.context,
          0,
          evidence,
          command,
          "links",
        ),
        input = verificationInput(links.record);
      await f.sb.recordVerificationReview(
        f.context,
        0,
        input,
        "baseline-review",
      );
      const locked = gate(),
        release = gate(),
        writer = new KnowledgeRepository(held(f.a, locked, release), f.policy);
      const writing =
        mode === "claim"
          ? writer.append(
              f.context,
              1,
              { ...claim, expectedRevision: 1 },
              "changed-claim",
            )
          : writer.recordEvidenceLinks(
              f.context,
              1,
              evidence,
              { ...command, expectedRevision: 1 },
              "changed-links",
            );
      let pending: Promise<unknown> | undefined;
      try {
        await Promise.race([locked.promise, writing]);
        pending = f.sb.recordVerificationReview(
          f.context,
          1,
          { ...input, expectedRevision: 1 },
          "stale-review",
        );
        const result = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await observedWait(f.id);
        release.resolve();
        await writing;
        const outcome = await result;
        assert.ok("error" in outcome);
        const code = mode === "claim" ? "stale_claim" : "stale_links";
        assert.equal((outcome.error as { code: string }).code, code);
        await f.b.close();
        const fresh = f.connect("fresh"),
          repo = new KnowledgeRepository(fresh, f.policy);
        await assert.rejects(
          repo.recordVerificationReview(
            f.context,
            1,
            { ...input, expectedRevision: 1 },
            "fresh-stale",
          ),
          { code },
        );
        const reviews = await repo.loadVerificationReviews(f.context);
        assert.equal(reviews.revision, 1);
        assert.equal(reviews.latest[0]!.basisStatus, "needs-review");
        await scoped(fresh, f.context, async (tx) => {
          const audits = await tx.audits();
          assert.ok(verifyAudit(audits));
          assert.equal(
            audits.filter(
              (x) => x.type === "knowledge.verification-review.recorded",
            ).length,
            1,
          );
          assert.equal(
            audits.filter(
              (x) => x.type === "knowledge.verification-review.append_checked",
            ).length,
            1,
            "Denied checked appends roll back",
          );
        });
      } finally {
        release.resolve();
        await writing;
        await pending?.catch(() => {});
      }
    },
  );


async function acceptance(t: test.TestContext, id: string) {
  const f = await fixture(t, id), d = capturedAcceptance(true, f.context);
  await f.sa.append(f.context, 0, { id: "parent", expectedRevision: 0, value: d.knowledge.records[0]!.value }, "parent");
  await f.sa.recordEvidenceLinks(f.context, 0, d.source, { claim: d.knowledge.records[0]!.ref,
    expectedRevision: 0, links: d.links.records[0]!.links.map(({ id, relation, selector }) => ({ id, relation, selector })) }, "parent-links");
  const ack = await f.sa.acceptCapturedProposal(f.context, d.bundle, d.command, "accept");
  return { ...f, d, ack };
}
for (const mode of ["claim", "links"] as const) test(
  `selected acceptance read observes committed accepted ${mode} revision after required independent lock wait`,
  { timeout: 20000 }, async t => {
    const f = await acceptance(t, "knowledge-acceptance-read-" + mode);
    const baseline = await f.sb.prepareProposalAcceptance(f.context, f.ack.acceptance);
    assert.equal(baseline.citation.links[0]!.relation, "quotes");
    assert.equal(baseline.record.excerpt.quote, "😀");
    const locked = gate(), release = gate(), writer = new KnowledgeRepository(held(f.a, locked, release), f.policy);
    const writing = mode === "claim"
      ? writer.append(f.context, 2, { id: "accepted", expectedRevision: 1, value: baseline.claim.value }, "changed-accepted-claim")
      : writer.recordEvidenceLinks(f.context, 2, f.d.source, { claim: f.ack.claim, expectedRevision: 1,
        links: baseline.citation.links.map(({ id, relation, selector }) => ({ id, relation, selector })) }, "changed-accepted-links");
    let pending: Promise<unknown> | undefined;
    try {
      await Promise.race([locked.promise, writing]);
      pending = f.sb.prepareProposalAcceptance(f.context, f.ack.acceptance);
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await observedWait(f.id);
      release.resolve(); await writing;
      const result = await outcome;
      assert.ok("error" in result);
      const code = mode === "claim" ? "stale_claim" : "stale_links";
      assert.equal((result.error as { code: string }).code, code);
      await f.b.close();
      const fresh = f.connect("fresh"), repo = new KnowledgeRepository(fresh, f.policy);
      await assert.rejects(repo.prepareProposalAcceptance(f.context, f.ack.acceptance), { code });
      await scoped(fresh, f.context, async tx => {
        const audits = await tx.audits(); assert(verifyAudit(audits));
        assert.equal(audits.filter(a => a.type === "knowledge.proposal-acceptance.read_checked").length, 1,
          "Only the baseline selected read commits; stale checked reads roll back");
        assert.equal(audits.filter(a => a.type === "knowledge.proposal-acceptance.recorded").length, 1);
      });
    } finally { release.resolve(); await writing; await pending?.catch(() => {}); }
  });
test("lost selected acceptance read COMMIT is not a new effect; fresh pool returns actual retained receipt", { timeout: 20000 }, async t => {
  const f = await acceptance(t, "knowledge-acceptance-read-lost");
  let lost = false;
  const wrapped: Database = { close: async () => {}, transaction: fn => f.a.transaction(fn).then(value => {
    lost = true; throw Error("fixture lost selected read COMMIT acknowledgement");
  }) };
  await assert.rejects(new KnowledgeRepository(wrapped, f.policy).prepareProposalAcceptance(f.context, f.ack.acceptance), /lost selected read COMMIT/);
  assert(lost); await f.a.close();
  const fresh = f.connect("fresh"), repo = new KnowledgeRepository(fresh, f.policy);
  const selected = await repo.prepareProposalAcceptance(f.context, f.ack.acceptance);
  assert.deepEqual(selected.record.claim, f.ack.claim);
  assert.equal(selected.knowledgeStorage.revision, 2); assert.equal(selected.linksStorage.revision, 2);
  assert.equal(selected.record.parentRelation, "challenges"); assert.equal(selected.citation.links[0]!.relation, "quotes");
  await scoped(fresh, f.context, async tx => {
    const audits = await tx.audits(); assert(verifyAudit(audits));
    assert.equal(audits.filter(a => a.type === "knowledge.proposal-acceptance.recorded").length, 1);
    assert.equal(audits.filter(a => a.type === "knowledge.proposal-acceptance.read_checked").length, 2);
  });
});
