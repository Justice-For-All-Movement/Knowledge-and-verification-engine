import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceService } from "@accountability/evidence/service";
import type { Identity } from "@accountability/evidence/service";
import { PrivateObjectStore } from "@accountability/evidence/objects";
import { createHash } from "node:crypto";
import { CurrentEvidenceKnowledgeReview } from "../src/current-evidence.ts";
import type { EvidenceState } from "@accountability/evidence";
import { createEvidenceState } from "@accountability/evidence";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import {
  KnowledgeRepository,
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
} from "../src/repository.ts";
import {
  IdentityKnowledgeRepository,
  KNOWLEDGE_RESOURCE_ID,
} from "../src/identity-repository.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "knowledge",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const q = {
  id: "entity",
  expectedRevision: 0,
  value: {
    type: "entity" as const,
    label: "Fictional person",
    category: "person" as const,
    description: "Unresolved",
  },
};
async function fixture(t: test.TestContext) {
  const hooks: { identity: (() => void) | null } = { identity: null };
  async function database(name: string): Promise<Database> {
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
      `CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO ${name}; SET SESSION AUTHORIZATION ${name}`,
    );
    t.after(() => pg.close());
    return {
      transaction: (fn) =>
        pg
          .transaction((query) =>
            fn({
              query: async <T>(s: string, v?: unknown[]) => ({
                rows: (await query.query(s, v)).rows as T[],
              }),
            }),
          )
          .then((x) => {
            if (name === "identity_login") hooks.identity?.();
            return x;
          }),
      close: () => pg.close(),
    };
  }
  const identity = await database("identity_login"),
    knowledge = await database("knowledge_login");
  const membership = new MembershipRegistry(
    identity,
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      bootstrapOwnerIds: ["owner"],
    },
    () => c.now,
  );
  await membership.initialize(c, "init");
  const policy = {
    resourceId: KNOWLEDGE_RESOURCE_ID,
    memberIds: ["owner"],
    purposes: [c.purpose],
    actions: ["investigate" as const],
  };
  const repo = new KnowledgeRepository(knowledge, {
    tenantId: c.tenantId,
    projectId: c.projectId,
    humanIds: ["owner"],
    purpose: c.purpose,
  });
  const fixed = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
  };
  return {
    database,
    identity,
    knowledge,
    membership,
    policy,
    repo,
    hooks,
    facade: new IdentityKnowledgeRepository(repo, membership, fixed),
    fixed,
  };
}

async function ready(t: test.TestContext) {
  const f = await fixture(t);
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const evidence = await f.database("evidence_login");
  const root = await mkdtemp(join(tmpdir(), "current-evidence-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = randomBytes(32).toString("hex");
  const identities: Identity[] = [
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      actor: { id: "owner", kind: "human", roles: ["owner"] },
      tokenHash: createHash("sha256").update(token).digest("hex"),
      disabled: false,
      epoch: 1,
    },
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      actor: {
        id: "scanner",
        kind: "service",
        roles: ["operator", "evidence_scanner"],
      },
      tokenHash: createHash("sha256").update("w".repeat(32)).digest("hex"),
      disabled: false,
      epoch: 1,
    },
  ];
  const service = new EvidenceService({
    database: evidence,
    objects: new PrivateObjectStore(root, randomBytes(32), "fixture-key"),
    identities: async () => identities,
    now: () => c.now,
    scanner: {
      version: "synthetic-fixture",
      scan: async (x) => ({
        attemptId: x.attemptId,
        sha256: x.sha256,
        engineVersion: "synthetic-fixture",
        verdict: "clean",
        representation: {
          sourceSha256: x.sha256,
          text: "Neutral unverified fixture",
          pages: null,
          durationMs: null,
          toolVersion: "synthetic-fixture",
        },
      }),
    },
  });
  const req = { token, purpose: c.purpose, requestId: "fixture" };
  const source = await service.acquire(req, {
    id: "source",
    acquisitionId: "fixture-source",
    bytes: Buffer.from("Neutral original fixture"),
    mediaType: "text/plain",
    capturedAt: c.now,
    originalLanguage: "und",
    supersedes: null,
    expectedRevision: 0,
    idempotencyKey: "acquire",
  });
  await service.runNextScan({ ...req, token: "w".repeat(32) });
  const metadata = await service.inspect(req, source.ref);
  const stored = await scoped(evidence, c, (tx) =>
    tx.get<{ domain: EvidenceState }>("evidence.aggregate", "project"),
  );
  const claim = {
    id: "claim",
    expectedRevision: 0,
    value: {
      type: "claim" as const,
      text: "Neutral unverified claim",
      subjectRefs: [],
      time: { earliest: null, latest: null },
      accountType: "observation" as const,
      limitations: [],
      assessment: null,
      proceduralPosture: null,
      editorialApproval: null,
    },
  };
  const claimAck = await f.facade.append(c, 0, claim, "claim");
  const selector = {
    kind: "whole" as const,
    evidence: source.ref,
    sha256: metadata.version.sha256,
  };
  const linkCommand = {
    claim: claimAck.record,
    expectedRevision: 0,
    links: [
      { id: "support", relation: "supports" as const, selector },
      { id: "contrary", relation: "challenges" as const, selector },
    ],
  };
  const link = await f.facade.recordEvidenceLinks(
    c,
    0,
    stored!.value.domain,
    linkCommand,
    "links",
  );
  let received: AbortSignal | undefined;
  const credential = async (context: Context, signal: AbortSignal) => {
    assert.deepEqual(context.actor.roles, []);
    received = signal;
    return token;
  };
  return {
    ...f,
    evidence,
    service,
    identities,
    req,
    source,
    metadata,
    claim,
    link,
    selector,
    linkCommand,
    credential,
    signal: () => received,
  };
}
test("current Evidence review uses actual separate Identity Knowledge Evidence services and separates relation analyses", async (t) => {
  const f = await ready(t),
    client = new CurrentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
    );
  const before = await f.facade.loadEvidenceLinks(c),
    r = await client.review(c, f.link.record);
  assert.equal(r.knowledgeRevision, 1);
  assert.equal(r.linksRevision, 1);
  assert.equal(r.evidenceRevision, f.metadata.revision);
  assert.equal(r.sources.supports!.sourceGroupCount, 1);
  assert.equal(r.sources.challenges!.sourceGroupCount, 1);
  assert.equal(r.sources.quotes, null);
  assert.equal(r.sources.supports!.independentFamilyCount, null);
  assert.equal(f.signal()!.aborted, true);
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), before);
  await scoped(f.knowledge, c, async (tx) =>
    assert.equal(await tx.get("evidence.aggregate", "project"), null),
  );
  await scoped(f.evidence, c, async (tx) =>
    assert.equal(await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY), null),
  );
  await scoped(f.identity, c, async (tx) =>
    assert.equal(await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY), null),
  );
  Object.assign(r.revision.links[0]!, { id: "detached" });
  assert.equal(
    (await client.review(c, f.link.record)).revision.links[0]!.id,
    "support",
  );
});
test("actual source quarantine and current Knowledge resource revocation deny without snapshot fallback", async (t) => {
  const f = await ready(t),
    client = new CurrentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
    );
  await f.service.quarantine(
    f.req,
    f.source.ref,
    f.metadata.revision,
    "quarantine",
  );
  await assert.rejects(client.review(c, f.link.record), {
    code: "source_unavailable",
  });
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, memberIds: [] },
    "revoke",
  );
  await assert.rejects(client.review(c, f.link.record), {
    code: "identity_unavailable",
  });
});
test("Knowledge reauthorization after actual Evidence read detects revocation and changed claim editions", async (t) => {
  const f = await ready(t);
  let revoked = false;
  const client = new CurrentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    async () => {
      if (!revoked) {
        revoked = true;
        await f.membership.setResourcePolicy(
          c,
          1,
          { ...f.policy, memberIds: [] },
          "revoke-after-basis",
        );
      }
      return f.req.token;
    },
  );
  await assert.rejects(client.review(c, f.link.record), {
    code: "identity_unavailable",
  });
  await f.membership.setResourcePolicy(c, 2, f.policy, "restore");
  let changed = false;
  const stale = new CurrentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    async () => {
      if (!changed) {
        changed = true;
        await f.facade.append(
          c,
          1,
          { ...f.claim, expectedRevision: 1 },
          "changed-claim",
        );
      }
      return f.req.token;
    },
  );
  await assert.rejects(stale.review(c, f.link.record), { code: "stale_claim" });
});

test("actual Evidence edition change between support and challenge reads rejects a mixed observation", async (t) => {
  const f = await ready(t),
    actual = f.service.reviewSelectors.bind(f.service);
  let changed = false;
  f.service.reviewSelectors = async (req, selectors) => {
    const r = await actual(req, selectors);
    if (!changed) {
      changed = true;
      await f.service.acquire(f.req, {
        id: "unrelated",
        acquisitionId: "unrelated",
        bytes: Buffer.from("Another neutral original"),
        mediaType: "text/plain",
        capturedAt: c.now,
        originalLanguage: "und",
        supersedes: null,
        expectedRevision: r.revision,
        idempotencyKey: "change-edition",
      });
    }
    return r;
  };
  const client = new CurrentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    f.credential,
  );
  await assert.rejects(client.review(c, f.link.record), {
    code: "source_changed",
  });
  assert.equal((await f.facade.loadEvidenceLinks(c)).revision, 1);
});
test("current source boundary rejects malformed/foreign/changed bindings and a late acknowledged SQL result", async (t) => {
  const f = await ready(t),
    actual = f.service.reviewSelectors.bind(f.service);
  for (const modify of [
    (r: Awaited<ReturnType<typeof actual>>) => ({ ...r, projectId: "foreign" }),
    (r: Awaited<ReturnType<typeof actual>>) => ({ ...r, selectors: [] }),
    (r: Awaited<ReturnType<typeof actual>>) => ({
      ...r,
      sources: { ...r.sources, groups: [] },
    }),
    (r: Awaited<ReturnType<typeof actual>>) => ({
      ...r,
      sources: { ...r.sources, allGroupsIndependentlyAssessed: true },
    }),
  ]) {
    f.service.reviewSelectors = async (req, selectors) =>
      modify(await actual(req, selectors));
    await assert.rejects(
      new CurrentEvidenceKnowledgeReview(
        f.facade,
        f.service,
        f.credential,
      ).review(c, f.link.record),
      { code: "source_unavailable" },
    );
  }
  f.service.reviewSelectors = async (req, selectors) => {
    const r = await actual(req, selectors);
    return {
      ...r,
      selectors: r.selectors.map((s) => ({
        ...s,
        fingerprint: "0".repeat(64),
      })),
    };
  };
  await assert.rejects(
    new CurrentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
    ).review(c, f.link.record),
    { code: "stale_evidence_links" },
  );
  let began = false;
  f.service.reviewSelectors = async (req, selectors) => {
    const r = await actual(req, selectors);
    began = true;
    const until = performance.now() + 600;
    while (performance.now() < until) {}
    return r;
  };
  await assert.rejects(
    new CurrentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
      500,
    ).review(c, f.link.record),
    { code: "source_unavailable" },
  );
  assert.equal(began, true);
  assert.equal(f.signal()!.aborted, true);

  f.service.reviewSelectors = actual;
  const clone = globalThis.structuredClone;
  let copied = false;
  globalThis.structuredClone = ((
    value: unknown,
    options?: StructuredSerializeOptions,
  ) => {
    const result = clone(value, options);
    if (
      value &&
      typeof value === "object" &&
      Object.hasOwn(value, "evidenceRevision") &&
      Object.hasOwn(value, "sources")
    ) {
      copied = true;
      const until = performance.now() + 600;
      while (performance.now() < until) {}
    }
    return result;
  }) as typeof structuredClone;
  try {
    await assert.rejects(
      new CurrentEvidenceKnowledgeReview(
        f.facade,
        f.service,
        f.credential,
        500,
      ).review(c, f.link.record),
      { code: "source_unavailable" },
    );
    assert.equal(copied, true);
  } finally {
    globalThis.structuredClone = clone;
  }
});
test("credential cancellation errors and receiver capture cannot bypass current source admission", async (t) => {
  const f = await ready(t),
    controller = new AbortController();
  let owned: AbortSignal | undefined;
  const hung = new CurrentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    async (_c, signal) => {
      owned = signal;
      controller.abort();
      return new Promise<string>(() => {});
    },
  );
  await assert.rejects(hung.review(c, f.link.record, controller.signal), {
    code: "source_unavailable",
  });
  assert.equal(owned!.aborted, true);
  const failed = new CurrentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    async () => {
      throw Error("private credential detail");
    },
  );
  await assert.rejects(failed.review(c, f.link.record), {
    code: "source_unavailable",
    message: "Current source credential unavailable",
  });
  const client = new CurrentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    f.credential,
  );
  f.service.reviewSelectors = async () => {
    throw Error("replacement must not run");
  };
  assert.equal(
    (await client.review(c, f.link.record)).evidenceRevision,
    f.metadata.revision,
  );
});
test("fresh own storage observations reject unrelated revisions and empty links require no Evidence credential", async (t) => {
  const f = await ready(t);
  let changed = false;
  const client = new CurrentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    async () => {
      if (!changed) {
        changed = true;
        await f.facade.append(c, 1, q, "unrelated-entity");
      }
      return f.req.token;
    },
  );
  await assert.rejects(client.review(c, f.link.record), {
    code: "knowledge_changed",
  });
  const state = await scoped(f.evidence, c, (tx) =>
    tx.get<{ domain: EvidenceState }>("evidence.aggregate", "project"),
  );
  const empty = await f.facade.recordEvidenceLinks(
    c,
    1,
    state!.value.domain,
    { ...f.linkCommand, expectedRevision: 1, links: [] },
    "empty",
  );
  const noCredential = new CurrentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    async () => {
      throw Error("must not request source credentials for an empty set");
    },
  );
  const result = await noCredential.review(c, empty.record);
  assert.equal(result.evidenceRevision, null);
  assert.deepEqual(result.sources, {
    supports: null,
    challenges: null,
    quotes: null,
  });
});

async function sourceWriterFixture(t: test.TestContext) {
  const f = await ready(t);
  const { SourceEvidenceLinksWriter } = await import("../src/source-links.ts");
  return {
    ...f,
    Writer: SourceEvidenceLinksWriter,
    command: { ...f.linkCommand, expectedRevision: 1 },
  };
}
test("source-backed writer captures actual Evidence family metadata and commits private link history with current authority", async (t) => {
  const f = await sourceWriterFixture(t),
    writer = new f.Writer(f.facade, f.service, f.credential);
  const ack = await writer.record(c, 1, f.command, "captured-links");
  assert.equal(ack.storage.revision, 2);
  assert.equal(ack.record.revision, 2);
  const links = await f.facade.loadEvidenceLinks(c),
    r = links.state.records.at(-1)!;
  const capture = await f.service.captureSelectorLinks(
    f.req,
    f.command.links.map((l) => l.selector),
  );
  assert.deepEqual(
    r.links.map((l) => l.family),
    capture.selectors.map((s) => s.family),
  );
  assert.deepEqual(
    r.links.map((l) => l.fingerprint),
    capture.selectors.map((s) => s.fingerprint),
  );
  assert.equal(links.state.records.length, 2);
  assert.equal(f.signal()!.aborted, true);
  const audits = await scoped(f.knowledge, c, (tx) => tx.audits());
  const recorded = audits.findLast(
    (a) => a.type === "knowledge.evidence-links.recorded",
  )!;
  assert.equal(
    (recorded.payload as { evidenceRevision: number }).evidenceRevision,
    capture.revision,
  );
  assert.ok(!JSON.stringify(audits).includes(f.req.token));
  let credentials = 0;
  const empty = new f.Writer(f.facade, f.service, async () => {
    credentials++;
    throw Error("must not request");
  });
  await empty.record(
    c,
    2,
    { ...f.command, expectedRevision: 2, links: [] },
    "empty-capture",
  );
  assert.equal(credentials, 0);
  assert.equal(
    (await f.facade.loadEvidenceLinks(c)).state.records.at(-1)!.links.length,
    0,
  );
});
test("source-backed writes deny quarantined source and fresh Knowledge revocation after actual source capture", async (t) => {
  const f = await sourceWriterFixture(t);
  const capture = f.service.captureSelectorLinks.bind(f.service);
  const port = {
    captureSelectorLinks: async (...args: Parameters<typeof capture>) => {
      const r = await capture(...args);
      await f.membership.setResourcePolicy(
        c,
        1,
        { ...f.policy, actions: [] },
        "revoke-after-capture",
      );
      return r;
    },
  } as EvidenceService;
  await assert.rejects(
    new f.Writer(f.facade, port, f.credential).record(
      c,
      1,
      f.command,
      "denied",
    ),
    { code: "identity_unavailable" },
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  await f.membership.setResourcePolicy(c, 2, f.policy, "allow-again");
  const observed = await f.service.inspect(f.req, f.source.ref);
  await f.service.quarantine(
    f.req,
    f.source.ref,
    observed.revision,
    "fixture-quarantine",
  );
  await assert.rejects(
    new f.Writer(f.facade, f.service, f.credential).record(
      c,
      1,
      f.command,
      "quarantined",
    ),
    { code: "source_unavailable" },
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
});
test("source-backed writes validate fresh stored claim and both storage and logical CAS without accepting malformed captures", async (t) => {
  const f = await sourceWriterFixture(t),
    capture = f.service.captureSelectorLinks.bind(f.service);
  const port = {
    captureSelectorLinks: async (...args: Parameters<typeof capture>) => ({
      ...(await capture(...args)),
      projectId: "foreign",
    }),
  } as EvidenceService;
  await assert.rejects(
    new f.Writer(f.facade, port, f.credential).record(
      c,
      1,
      f.command,
      "foreign",
    ),
  );
  await assert.rejects(
    new f.Writer(f.facade, f.service, f.credential).record(
      c,
      0,
      f.command,
      "wrong-storage",
    ),
    { code: "revision_conflict" },
  );
  await assert.rejects(
    new f.Writer(f.facade, f.service, f.credential).record(
      c,
      1,
      { ...f.command, expectedRevision: 0 },
      "wrong-logical",
    ),
    { code: "revision_conflict" },
  );
  const stale = {
    captureSelectorLinks: async (...args: Parameters<typeof capture>) => {
      const r = await capture(...args);
      await f.facade.append(
        c,
        1,
        { ...f.claim, expectedRevision: 1 },
        "new-claim",
      );
      return r;
    },
  } as EvidenceService;
  await assert.rejects(
    new f.Writer(f.facade, stale, f.credential).record(
      c,
      1,
      f.command,
      "stale",
    ),
    { code: "stale_claim" },
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
});
test("lost source-backed Knowledge COMMIT replays only original acknowledgement and new commands retain atomic history", async (t) => {
  const f = await sourceWriterFixture(t);
  let lose = true;
  const db: Database = {
    close: async () => {},
    transaction: async (fn) => {
      let wrote = false;
      const result = await f.knowledge.transaction((tx) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const r = await tx.query<T>(sql, values);
            if (sql.startsWith("INSERT INTO public.evidence_outbox"))
              wrote = true;
            return r;
          },
        }),
      );
      if (lose && wrote) {
        lose = false;
        throw Error("lost real Knowledge COMMIT");
      }
      return result;
    },
  };
  const repo = new KnowledgeRepository(db, { ...f.fixed, humanIds: ["owner"] });
  const facade = new IdentityKnowledgeRepository(repo, f.membership, f.fixed);
  await assert.rejects(
    new f.Writer(facade, f.service, f.credential).record(
      c,
      1,
      f.command,
      "lost-captured",
    ),
    /lost real Knowledge COMMIT/,
  );
  const writer = new f.Writer(f.facade, f.service, f.credential),
    ack = await writer.record(c, 1, f.command, "lost-captured");
  assert.equal(ack.storage.revision, 2);
  await writer.record(
    c,
    2,
    { ...f.command, expectedRevision: 2, links: [] },
    "subsequent-empty",
  );
  assert.deepEqual(await writer.record(c, 1, f.command, "lost-captured"), ack);
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 3);
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, actions: [] },
    "revoke-replay",
  );
  await assert.rejects(writer.record(c, 1, f.command, "lost-captured"), {
    code: "identity_unavailable",
  });
});
test("source-backed write rollback and post-lock deadline deny commits but preserve acknowledged results after cancellation", async (t) => {
  const f = await sourceWriterFixture(t);
  let fail = true;
  const db: Database = {
    close: async () => {},
    transaction: (fn) =>
      f.knowledge.transaction((tx) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            if (fail && sql.startsWith("INSERT INTO public.evidence_outbox")) {
              fail = false;
              throw Error("rollback capture outbox");
            }
            return tx.query<T>(sql, values);
          },
        }),
      ),
  };
  const repo = new KnowledgeRepository(db, { ...f.fixed, humanIds: ["owner"] }),
    facade = new IdentityKnowledgeRepository(repo, f.membership, f.fixed);
  await assert.rejects(
    new f.Writer(facade, f.service, f.credential).record(
      c,
      1,
      f.command,
      "rollback",
    ),
    /rollback capture outbox/,
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  let slow = false;
  const delayed: Database = {
    close: async () => {},
    transaction: (fn) =>
      f.knowledge.transaction((tx) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const r = await tx.query<T>(sql, values);
            if (
              slow &&
              sql.includes("FROM public.evidence_project") &&
              sql.includes("FOR UPDATE")
            ) {
              slow = false;
              const end = performance.now() + 650;
              while (performance.now() < end) {}
            }
            return r;
          },
        }),
      ),
  };
  const delayedRepo = new KnowledgeRepository(delayed, {
      ...f.fixed,
      humanIds: ["owner"],
    }),
    delayedFacade = new IdentityKnowledgeRepository(
      delayedRepo,
      f.membership,
      f.fixed,
    );
  const capture = f.service.captureSelectorLinks.bind(f.service);
  const slowPort = {
    captureSelectorLinks: async (...args: Parameters<typeof capture>) => {
      const r = await capture(...args);
      slow = true;
      return r;
    },
  } as EvidenceService;
  await assert.rejects(
    new f.Writer(delayedFacade, slowPort, f.credential, 500).record(
      c,
      1,
      f.command,
      "post-lock-expired",
    ),
    { code: "source_unavailable" },
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  const control = new AbortController();
  const acknowledged: Database = {
    close: async () => {},
    transaction: async (fn) => {
      let wrote = false;
      const r = await f.knowledge.transaction((tx) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const r = await tx.query<T>(sql, values);
            if (sql.startsWith("INSERT INTO public.evidence_outbox"))
              wrote = true;
            return r;
          },
        }),
      );
      if (wrote) control.abort();
      return r;
    },
  };
  const ackRepo = new KnowledgeRepository(acknowledged, {
      ...f.fixed,
      humanIds: ["owner"],
    }),
    ackFacade = new IdentityKnowledgeRepository(ackRepo, f.membership, f.fixed);
  const ack = await new f.Writer(ackFacade, f.service, f.credential).record(
    c,
    1,
    f.command,
    "ack-cancel",
    control.signal,
  );
  assert.equal(ack.record.revision, 2);
  assert.equal(control.signal.aborted, true);
});
test("source-backed writer bounds credential cancellation and source admission without forwarding roles or foreign selectors", async (t) => {
  const f = await sourceWriterFixture(t);
  let calls = 0,
    signal: AbortSignal | undefined;
  const foreign = structuredClone(f.command);
  Object.assign(foreign.links[0]!.selector.evidence, { projectId: "foreign" });
  const credentials = async (context: Context, s: AbortSignal) => {
    assert.deepEqual(context.actor.roles, []);
    calls++;
    signal = s;
    return f.req.token;
  };
  await assert.rejects(
    new f.Writer(f.facade, f.service, credentials).record(
      c,
      1,
      foreign,
      "foreign",
    ),
  );
  assert.equal(calls, 0);
  const bounded = new f.Writer(
    f.facade,
    f.service,
    async (_c, s) => {
      signal = s;
      return new Promise<string>(() => {});
    },
    100,
  );
  await assert.rejects(bounded.record(c, 1, f.command, "hung"), {
    code: "source_unavailable",
  });
  assert.equal(signal!.aborted, true);
  const capture = f.service.captureSelectorLinks.bind(f.service);
  const late = {
    captureSelectorLinks: async (...args: Parameters<typeof capture>) => {
      const r = await capture(...args);
      const end = performance.now() + 150;
      while (performance.now() < end) {}
      return r;
    },
  } as EvidenceService;
  await assert.rejects(
    new f.Writer(f.facade, late, credentials, 100).record(
      c,
      1,
      f.command,
      "late",
    ),
    { code: "source_unavailable" },
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  assert.equal(signal!.aborted, true);
});

import { PermissionRegistry } from "@accountability/consent-rights/registry";
import {
  CurrentEvidenceUse,
  ConsentEvidenceKnowledgeReview,
  ConsentEvidenceLinksWriter,
  evidenceUseResourceId,
} from "../src/consent-links.ts";
async function consentWriterFixture(t: test.TestContext) {
  const f = await sourceWriterFixture(t),
    consentDb = await f.database("consent_login");
  const registryPolicy = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    managerIds: ["owner"],
    participantActors: {},
  };
  const permissions = new PermissionRegistry(consentDb, registryPolicy);
  const resource = {
    ref: f.source.ref,
    digest: f.selector.sha256,
    requiredConsentSubjects: ["subject"],
  };
  await permissions.registerResource(c, resource, 0);
  const terms = {
    resource: { ref: resource.ref, digest: resource.digest },
    actions: ["metadata-citation" as const],
    purposes: [c.purpose],
    audiences: ["private"],
    validFrom: c.now,
    expiresAt: "2026-02-01T00:00:00Z",
    evidence: {
      ...resource.ref,
      kind: "permission-statement",
      id: "fictional-statement",
    },
  };
  await permissions.grantRights(
    c,
    {
      ...terms,
      id: "rights",
      holderId: "fictional-owner",
      attribution: null,
      noDerivatives: false,
    },
    "rights",
  );
  await permissions.recordConsent(
    c,
    { ...terms, id: "consent", subjectId: "subject" },
    "consent",
  );
  const usePolicy = {
    ...f.policy,
    resourceId: evidenceUseResourceId(resource.ref),
  };
  await f.membership.setResourcePolicy(c, 1, usePolicy, "use-policy");
  const config = {
    ...f.fixed,
    bindings: [
      {
        resource: terms.resource,
        rights: ["rights"],
        consents: ["consent"],
        attribution: null,
      },
    ],
  };
  const time = { now: c.now };
  const makeGuard = (registry = permissions, timeoutMs = 10000) =>
    new CurrentEvidenceUse(
      f.membership,
      registry,
      config,
      () => time.now,
      timeoutMs,
    );
  const makeWriter = (
    guard = makeGuard(),
    evidence = f.service,
    facade = f.facade,
  ) => new ConsentEvidenceLinksWriter(facade, evidence, f.credential, guard);
  return {
    ...f,
    consentDb,
    permissions,
    registryPolicy,
    resource,
    terms,
    usePolicy,
    config,
    time,
    makeGuard,
    makeWriter,
  };
}

test("consent-guarded source writes use actual four owning databases and private exact current decisions before and after capture", async (t) => {
  const f = await consentWriterFixture(t),
    guard = f.makeGuard();
  // Construction captures fixed mappings, including original permission IDs.
  f.config.bindings[0]!.rights.length = 0;
  const before = await scoped(f.consentDb, c, (tx) => tx.audits());
  const ack = await f
    .makeWriter(guard)
    .record(
      { ...c, actor: { ...c.actor, roles: ["forged"] } },
      1,
      f.command,
      "consent-backed",
    );
  assert.equal(ack.record.revision, 2);
  const rows = await f.facade.loadEvidenceLinks(c);
  assert.equal(rows.state.records.at(-1)?.visibility, "private");
  const audits = await scoped(f.consentDb, c, (tx) => tx.audits());
  const decisions = audits
    .slice(before.length)
    .filter((a) => a.type === "permission.evaluated");
  assert.equal(
    decisions.length,
    2,
    "Same resource/action deduplicates within each of two observations",
  );
  assert.ok(
    decisions.every(
      (a) => (a.payload as { allowed: boolean }).allowed === true,
    ),
  );
  for (const db of [f.identity, f.knowledge, f.evidence])
    await scoped(db, c, async (tx) => {
      assert.equal((await tx.list("consent")).length, 0);
      assert.equal((await tx.list("rights-grant")).length, 0);
    });
  await scoped(f.consentDb, c, async (tx) => {
    assert.equal(await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY), null);
    assert.equal(await tx.get("evidence.aggregate", "project"), null);
  });
  assert.equal(JSON.stringify(rows).includes("fictional-owner"), false);
  assert.equal(f.signal()!.aborted, true);
});

test("literal text requires reproduction permission even for support links; metadata citation cannot silently authorize it", async (t) => {
  const f = await consentWriterFixture(t);
  // Owning test fixture selects the real scanner-produced ID; authenticated service reads its representation.
  const stored = await scoped(f.evidence, c, (tx) =>
    tx.get<{ domain: EvidenceState }>("evidence.aggregate", "project"),
  );
  const representation = await f.service.representation(
    f.req,
    f.source.ref,
    stored!.value.domain.representations[0]!.id,
  );
  const selector = {
    kind: "text" as const,
    evidence: f.source.ref,
    sha256: f.selector.sha256,
    representationId: representation.id,
    representationDigest: representation.digest,
    page: null,
    start: 0,
    end: 7,
    quote: "Neutral",
  };
  const command = {
    ...f.command,
    links: [{ id: "literal-support", relation: "supports" as const, selector }],
  };
  await assert.rejects(
    f.makeWriter().record(c, 1, command, "metadata-only-text"),
    { code: "use_denied" },
  );
  assert.equal(
    f.signal(),
    undefined,
    "No source credentials released after denied preflight",
  );
  const terms = { ...f.terms, actions: ["reproduce" as const] }…3375 tokens truncated…sert.deepEqual(await f.facade.load(c), knowledge);
  f.candidate.assertion = "caller changed";
  assert.notEqual(p.proposals[0]!.assertion, f.candidate.assertion);
  await f.permissions.withdraw(
    c,
    "consent",
    "text-consent",
    1,
    "proposal-withdraw",
  );
  await assert.rejects(f.reader.propose(c, f.selected, [f.candidate]), {
    code: "proposal_unavailable",
  });
});
test("invented quotes IDs offsets duplicate proposals extra authority and nontext citations cannot be accepted", async (t) => {
  const f = await proposalFixture(t);
  for (const bad of [
    { ...f.candidate, quote: "Invented" },
    { ...f.candidate, linkId: "absent" },
    { ...f.candidate, end: 999 },
    { ...f.candidate, assessment: "verified" },
  ])
    await assert.rejects(f.reader.propose(c, f.selected, [bad]));
  await assert.rejects(
    f.reader.propose(c, f.selected, [f.candidate, f.candidate]),
  );
  await assert.rejects(
    f.reader.propose(c, { ...f.selected, projectId: "foreign" }, [f.candidate]),
  );
  await assert.rejects(
    f.reader.propose(c, f.link.record, [{ ...f.candidate, linkId: "support" }]),
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.reader.propose(c, f.selected, [f.candidate], aborted.signal),
  );
  assert.equal((await f.facade.loadEvidenceLinks(c)).revision, 2);
});
test("proposal return is withheld after actual source-time withdrawal and a late noncooperative owning read", async (t) => {
  const f = await proposalFixture(t),
    review = f.service.reviewSelectors.bind(f.service);
  let revoke = true;
  const service = {
    reviewSelectors: async (...args: Parameters<typeof review>) => {
      const r = await review(...args);
      if (revoke) {
        revoke = false;
        await f.permissions.withdraw(
          c,
          "rights-grant",
          "text-rights",
          1,
          "proposal-during",
        );
      }
      return r;
    },
  } as EvidenceService;
  const client = new ClaimProposalReader(
    new ConsentEvidenceKnowledgeReview(
      f.facade,
      service,
      f.credential,
      f.guard,
    ),
  );
  await assert.rejects(client.propose(c, f.selected, [f.candidate]), {
    code: "proposal_unavailable",
  });
  assert.equal((await f.facade.loadEvidenceLinks(c)).revision, 2);
});
