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

async function ready(
  t: test.TestContext,
  representationText = "Neutral unverified fixture",
) {
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
          text: representationText,
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

async function sourceWriterFixture(
  t: test.TestContext,
  representationText?: string,
) {
  const f = await ready(t, representationText);
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
async function consentWriterFixture(
  t: test.TestContext,
  representationText?: string,
) {
  const f = await sourceWriterFixture(t, representationText),
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
  const terms = { ...f.terms, actions: ["reproduce" as const] };
  await f.permissions.grantRights(
    c,
    {
      ...terms,
      id: "reproduce",
      holderId: "fictional-owner",
      attribution: null,
      noDerivatives: false,
    },
    "reproduce-rights",
  );
  await f.permissions.recordConsent(
    c,
    { ...terms, id: "reproduce", subjectId: "subject" },
    "reproduce-consent",
  );
  f.config.bindings[0]!.rights.push("reproduce");
  f.config.bindings[0]!.consents.push("reproduce");
  const ack = await f.makeWriter().record(c, 1, command, "literal-copy");
  assert.equal(ack.record.revision, 2);
  assert.equal(
    (await f.facade.loadEvidenceLinks(c)).state.records.at(-1)?.links[0]
      ?.selector.kind,
    "text",
  );
});

test("explicit current Identity resource policy and current Consent withdrawal during actual capture deny before Knowledge write", async (t) => {
  const f = await consentWriterFixture(t);
  await f.membership.setResourcePolicy(
    c,
    2,
    { ...f.usePolicy, memberIds: [] },
    "deny-use",
  );
  await assert.rejects(
    f.makeWriter().record(c, 1, f.command, "denied-resource"),
    { code: "use_unavailable" },
  );
  assert.equal(f.signal(), undefined);
  await f.membership.setResourcePolicy(c, 3, f.usePolicy, "restore-use");
  const capture = f.service.captureSelectorLinks.bind(f.service);
  const source = {
    captureSelectorLinks: async (...args: Parameters<typeof capture>) => {
      const result = await capture(...args);
      await f.permissions.withdraw(
        c,
        "consent",
        "consent",
        1,
        "withdraw-during-capture",
      );
      return result;
    },
  } as EvidenceService;
  await assert.rejects(
    f.makeWriter(undefined, source).record(c, 1, f.command, "withdrawn-source"),
    { code: "use_denied" },
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  assert.equal(f.signal()!.aborted, true);
});

test("guarded historical replay requires fresh current rights and lost actual Knowledge COMMIT remains unknown", async (t) => {
  const f = await consentWriterFixture(t);
  let lose = true;
  const db: Database = {
    close: async () => {},
    transaction: async (fn) => {
      let wrote = false;
      const value = await f.knowledge.transaction((tx) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const r = await tx.query<T>(sql, values);
            if (sql.startsWith("INSERT INTO public.evidence_outbox"))
              wrote = true;
            return r;
          },
        }),
      );
      if (wrote && lose) {
        lose = false;
        throw Error("lost actual guarded Knowledge COMMIT");
      }
      return value;
    },
  };
  const repo = new KnowledgeRepository(db, { ...f.fixed, humanIds: ["owner"] });
  const facade = new IdentityKnowledgeRepository(repo, f.membership, f.fixed);
  await assert.rejects(
    f
      .makeWriter(undefined, f.service, facade)
      .record(c, 1, f.command, "lost-guarded"),
    /lost actual guarded Knowledge COMMIT/,
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 2);
  const historical = await f
    .makeWriter()
    .record(c, 1, f.command, "lost-guarded");
  assert.equal(historical.record.revision, 2);
  await f.permissions.withdraw(
    c,
    "rights-grant",
    "rights",
    1,
    "withdraw-rights",
  );
  await assert.rejects(f.makeWriter().record(c, 1, f.command, "lost-guarded"), {
    code: "use_denied",
  });
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 2);
});

test("exact mapping, purpose, digest and foreign selector fail closed before credentials; expiry and empty sets stay explicit", async (t) => {
  const f = await consentWriterFixture(t);
  assert.throws(
    () =>
      new CurrentEvidenceUse(
        f.membership,
        f.permissions,
        {
          ...f.config,
          bindings: [
            { ...f.config.bindings[0]!, attribution: "Required credit" },
          ],
        } as never,
        () => c.now,
      ),
    { code: "invalid_policy" },
  );
  const missing = new CurrentEvidenceUse(
    f.membership,
    f.permissions,
    { ...f.fixed, bindings: [] },
    () => c.now,
  );
  await assert.rejects(
    f.makeWriter(missing).record(c, 1, f.command, "missing-map"),
    { code: "use_denied" },
  );
  const changed = new CurrentEvidenceUse(
    f.membership,
    f.permissions,
    {
      ...f.config,
      bindings: [
        {
          ...f.config.bindings[0]!,
          resource: { ...f.terms.resource, digest: "0".repeat(64) },
        },
      ],
    },
    () => c.now,
  );
  await assert.rejects(
    f.makeWriter(changed).record(c, 1, f.command, "wrong-hash"),
    { code: "use_denied" },
  );
  await assert.rejects(
    f.makeWriter().record(
      c,
      1,
      {
        ...f.command,
        links: [
          {
            ...f.command.links[0]!,
            selector: {
              ...f.selector,
              evidence: { ...f.source.ref, tenantId: "foreign" },
            },
          },
        ],
      },
      "foreign",
    ),
  );
  await assert.rejects(
    f
      .makeWriter()
      .record({ ...c, purpose: "other" }, 1, f.command, "other-purpose"),
  );
  assert.equal(f.signal(), undefined);
  f.time.now = f.terms.expiresAt;
  await assert.rejects(f.makeWriter().record(c, 1, f.command, "expired"), {
    code: "use_denied",
  });
  const before = await scoped(f.consentDb, c, (tx) => tx.audits());
  const empty = await f
    .makeWriter(missing)
    .record(c, 1, { ...f.command, links: [] }, "empty-without-source-use");
  assert.equal(empty.record.revision, 2);
  assert.equal(f.signal(), undefined);
  assert.deepEqual(await scoped(f.consentDb, c, (tx) => tx.audits()), before);
});

test("lost or late begun Consent SQL and cancellation cannot become permission or reach Knowledge writes", async (t) => {
  const f = await consentWriterFixture(t);
  let lose = true,
    block = false;
  const db: Database = {
    close: async () => {},
    transaction: async (fn) => {
      const value = await f.consentDb.transaction(fn);
      if (lose) {
        lose = false;
        throw Error("private lost Consent read COMMIT diagnostic");
      }
      if (block) {
        const until = performance.now() + 1300;
        while (performance.now() < until) {}
      }
      return value;
    },
  };
  const registry = new PermissionRegistry(db, f.registryPolicy);
  await assert.rejects(
    f.makeWriter(f.makeGuard(registry)).record(c, 1, f.command, "lost-consent"),
    {
      code: "use_unavailable",
      message: "Current evidence use observation unavailable",
    },
  );
  block = true;
  await assert.rejects(
    f
      .makeWriter(f.makeGuard(registry, 1000))
      .record(c, 1, f.command, "late-consent"),
    { code: "use_unavailable" },
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  assert.equal(f.signal(), undefined);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.makeWriter().record(c, 1, f.command, "cancelled", aborted.signal),
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
});

test("consent-guarded owning review uses actual stored selectors and current permissions without revising Knowledge", async (t) => {
  const f = await consentWriterFixture(t);
  const client = new ConsentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    f.credential,
    f.makeGuard(),
  );
  const before = await f.facade.loadEvidenceLinks(c);
  const reviewed = await client.review(
    { ...c, actor: { ...c.actor, roles: ["forged"] } },
    f.link.record,
  );
  assert.equal(reviewed.linksRevision, 1);
  assert.equal(reviewed.sources.supports!.sourceGroupCount, 1);
  assert.equal(reviewed.sources.challenges!.sourceGroupCount, 1);
  assert.equal(reviewed.sources.quotes, null);
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), before);
  const original = structuredClone(reviewed);
  Object.assign(reviewed.revision.links[0]!, { id: "detached" });
  assert.deepEqual(await client.review(c, f.link.record), original);
  await f.permissions.withdraw(
    c,
    "consent",
    "consent",
    1,
    "withdraw-before-review",
  );
  await assert.rejects(client.review(c, f.link.record), { code: "use_denied" });
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), before);
});

test("consent-guarded review withholds actual source results after withdrawal during observation and keeps empty sets explicit", async (t) => {
  const f = await consentWriterFixture(t),
    review = f.service.reviewSelectors.bind(f.service);
  let withdrew = false;
  const service = {
    reviewSelectors: async (...args: Parameters<typeof review>) => {
      const result = await review(...args);
      if (!withdrew) {
        withdrew = true;
        await f.permissions.withdraw(
          c,
          "rights-grant",
          "rights",
          1,
          "withdraw-during-review",
        );
      }
      return result;
    },
  } as EvidenceService;
  const client = new ConsentEvidenceKnowledgeReview(
    f.facade,
    service,
    f.credential,
    f.makeGuard(),
  );
  await assert.rejects(client.review(c, f.link.record), { code: "use_denied" });
  assert.equal(f.signal()!.aborted, true);
  assert.equal((await f.facade.loadEvidenceLinks(c)).revision, 1);
  const empty = await f
    .makeWriter()
    .record(c, 1, { ...f.command, links: [] }, "explicit-empty");
  const missing = new CurrentEvidenceUse(
    f.membership,
    f.permissions,
    { ...f.fixed, bindings: [] },
    () => c.now,
  );
  const noCredential = async () => {
    throw Error("must not obtain credentials for empty links");
  };
  const emptyClient = new ConsentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    noCredential,
    missing,
  );
  const result = await emptyClient.review(c, empty.record);
  assert.equal(result.evidenceRevision, null);
  assert.deepEqual(result.sources, {
    supports: null,
    challenges: null,
    quotes: null,
  });
});

import { inspectClaimProposals } from "../src/claim-proposal-review.ts";
import { ClaimProposalReader } from "../src/claim-proposals.ts";
async function proposalFixture(
  t: test.TestContext,
  representationText?: string,
) {
  const f = await consentWriterFixture(t, representationText);
  // Owning representation discovery is fixture setup only; runtime uses only the authenticated guarded API.
  const stored = await scoped(f.evidence, c, (tx) =>
    tx.get<{ domain: EvidenceState }>("evidence.aggregate", "project"),
  );
  const rep = await f.service.representation(
    f.req,
    f.source.ref,
    stored!.value.domain.representations[0]!.id,
  );
  const selector = {
    ...f.selector,
    kind: "text" as const,
    representationId: rep.id,
    representationDigest: rep.digest,
    page: null,
    start: 0,
    end: rep.text!.length,
    quote: rep.text!,
  };
  const terms = { ...f.terms, actions: ["reproduce" as const] };
  await f.permissions.grantRights(
    c,
    {
      ...terms,
      id: "text-rights",
      holderId: "fictional-owner",
      attribution: null,
      noDerivatives: false,
    },
    "text-rights",
  );
  await f.permissions.recordConsent(
    c,
    { ...terms, id: "text-consent", subjectId: "subject" },
    "text-consent",
  );
  const guard = new CurrentEvidenceUse(
    f.membership,
    f.permissions,
    {
      ...f.fixed,
      bindings: [
        {
          resource: terms.resource,
          rights: ["text-rights"],
          consents: ["text-consent"],
          attribution: null,
        },
      ],
    },
    () => f.time.now,
  );
  const link = await f.makeWriter(guard).record(
    c,
    1,
    {
      ...f.command,
      links: [{ id: "passage", relation: "quotes", selector }],
    },
    "text-link",
  );
  const review = new ConsentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    f.credential,
    guard,
  );
  const candidate = {
    id: "proposal",
    assertion: "An unverified fictional assertion",
    linkId: "passage",
    start: 0,
    end: 7,
    quote: "Neutral",
  };
  return {
    ...f,
    guard,
    review,
    reader: new ClaimProposalReader(review),
    selected: link.record,
    candidate,
  };
}
test("claim proposals bind exact authenticated text spans and retain independent null assessment tracks without writes", async (t) => {
  const f = await proposalFixture(t),
    before = await f.facade.loadEvidenceLinks(c),
    knowledge = await f.facade.load(c);
  const p = await f.reader.propose(
    { ...c, actor: { ...c.actor, roles: ["forged"] } },
    f.selected,
    [f.candidate],
  );
  assert.equal(p.proposals[0]!.citation.excerpt.quote, "Neutral");
  assert.equal(p.proposals[0]!.citation.excerpt.start, 0);
  assert.equal(
    p.proposals[0]!.citation.selector.quote,
    "Neutral unverified fixture",
  );
  const storedLink = before.state.records.at(-1)!.links[0]!;
  assert.deepEqual(p.proposals[0]!.citation.selector, storedLink.selector);
  assert.equal(
    p.proposals[0]!.citation.selectorFingerprint,
    storedLink.fingerprint,
  );
  assert.equal(p.proposals[0]!.assessment, null);
  assert.equal(p.proposals[0]!.editorialApproval, null);
  assert.equal(p.visibility, "private");
  assert.deepEqual(inspectClaimProposals(c, p), p);
  assert.equal(p.basis.linkRef.revision, 2);
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), before);
  assert.deepEqual(await f.facade.load(c), knowledge);
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
  const whole = await f
    .makeWriter()
    .record(c, 2, { ...f.command, expectedRevision: 2 }, "whole-current");
  const metadata = new ClaimProposalReader(
    new ConsentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
      f.makeGuard(),
    ),
  );
  await assert.rejects(
    metadata.propose(c, whole.record, [{ ...f.candidate, linkId: "support" }]),
    { code: "invalid_proposal" },
  );
  assert.equal((await f.facade.loadEvidenceLinks(c)).revision, 3);
});
test("proposal return is withheld after actual source-time withdrawal without domain writes", async (t) => {
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

test("proposal deadline rejects a late actual owning read and closes captured signals", async (t) => {
  const f = await proposalFixture(t),
    review = f.service.reviewSelectors.bind(f.service);
  const service = {
    reviewSelectors: async (...args: Parameters<typeof review>) => {
      const result = await review(...args);
      const until = performance.now() + 1050;
      while (performance.now() < until) {}
      return result;
    },
  } as EvidenceService;
  const client = new ClaimProposalReader(
    new ConsentEvidenceKnowledgeReview(
      f.facade,
      service,
      f.credential,
      f.guard,
    ),
    1000,
  );
  await assert.rejects(client.propose(c, f.selected, [f.candidate]), {
    code: "proposal_unavailable",
  });
  assert.equal((await f.facade.loadEvidenceLinks(c)).revision, 2);
  assert.equal(f.signal()!.aborted, true);
});

test("complete proposal response budget includes its digest at the exact UTF8 boundary", async (t) => {
  const { canonical, digest } = await import("../src/contracts.ts");
  const f = await proposalFixture(t, "Neutral " + "x".repeat(6992));
  const probe = await f.reader.propose(c, f.selected, [
    { ...f.candidate, assertion: "A" },
  ]);
  const { digest: ignored, ...body } = probe;
  const candidates = Array.from({ length: 32 }, (_, i) => ({
    ...f.candidate,
    id: `candidate-${i}`,
    assertion: "A",
  }));
  const proposals = candidates.map((q) => ({
    ...probe.proposals[0]!,
    id: q.id,
    assertion: q.assertion,
  }));
  const expected = () => ({
    ...body,
    proposals,
    digest: digest({ ...body, proposals }),
  });
  let remaining = 256 * 1024 + 1 - Buffer.byteLength(canonical(expected()));
  assert.ok(remaining > 0 && remaining < 32 * 3999);
  for (let i = 0; i < candidates.length && remaining > 0; i++) {
    const n = Math.min(3999, remaining);
    candidates[i]!.assertion += "x".repeat(n);
    proposals[i]!.assertion = candidates[i]!.assertion;
    remaining -= n;
  }
  assert.equal(Buffer.byteLength(canonical(expected())), 256 * 1024 + 1);
  await assert.rejects(f.reader.propose(c, f.selected, candidates), {
    code: "proposal_full",
  });
  const index = candidates.findIndex((q) => q.assertion.length > 1);
  candidates[index]!.assertion = candidates[index]!.assertion.slice(0, -1);
  const accepted = await f.reader.propose(c, f.selected, candidates);
  assert.equal(Buffer.byteLength(canonical(accepted)), 256 * 1024);
  assert.deepEqual(inspectClaimProposals(c, accepted), accepted);
});

import { HumanConsentEvidenceLinksWriter } from "../src/consent-links.ts";
test("human-bound guarded writes use the actual same human Evidence principal and never the legacy capture method", async t => {
  const f = await consentWriterFixture(t);
  const writer = new HumanConsentEvidenceLinksWriter(f.facade, f.service, f.credential, f.makeGuard());
  Object.assign(f.service, { captureSelectorLinks: async () => { throw Error("legacy capture forbidden"); } });
  const before = await scoped(f.consentDb, c, tx => tx.audits());
  const ack = await writer.record({ ...c, actor: { ...c.actor, roles: ["forged"] } }, 1, f.command, "human-capture");
  assert.equal(ack.record.revision, 2);
  const rows = await f.facade.loadEvidenceLinks(c);
  assert.deepEqual(rows.state.records.at(-1)!.links.map(x => x.relation), ["supports", "challenges"]);
  const decisions = (await scoped(f.consentDb, c, tx => tx.audits())).slice(before.length).filter(x => x.type === "permission.evaluated");
  assert.equal(decisions.length, 2);
  assert.equal(JSON.stringify(rows).includes("token"), false);
  assert.equal(f.signal()!.aborted, true);
});
test("human-bound guarded writes deny another human and same-ID service or agent without a Knowledge effect or legacy fallback", async t => {
  const f = await consentWriterFixture(t);
  let legacy = 0;
  Object.assign(f.service, { captureSelectorLinks: async () => { legacy++; throw Error("legacy fallback"); } });
  const writer = new HumanConsentEvidenceLinksWriter(f.facade, f.service, f.credential, f.makeGuard());
  for (const actor of [{id:"different",kind:"human"}, {id:"owner",kind:"service"}, {id:"owner",kind:"agent"}]) {
    Object.assign(f.identities[0]!.actor, actor);
    await assert.rejects(writer.record(c, 1, f.command, "mismatch-" + actor.kind), {code:"source_unavailable",message:"Current Evidence capture unavailable"});
    assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  }
  assert.equal(legacy, 0);
  const audits = await scoped(f.knowledge, c, tx => tx.audits());
  assert.equal(audits.some(x => x.type === "knowledge.evidence_links.recorded"), false);
});
test("human-bound guarded writes still withhold a source result after actual consent withdrawal during capture", async t => {
  const f = await consentWriterFixture(t);
  const capture = f.service.captureSelectorLinksForHuman.bind(f.service);
  let expectedHuman: string | undefined;
  const port = { captureSelectorLinksForHuman: async (...args: Parameters<typeof capture>) => {
    expectedHuman = args[2];
    const result = await capture(...args);
    await f.permissions.withdraw(c, "consent", "consent", 1, "withdraw-human-capture");
    return result;
  }} as EvidenceService;
  const writer = new HumanConsentEvidenceLinksWriter(f.facade, port, f.credential, f.makeGuard());
  await assert.rejects(writer.record(c, 1, f.command, "withdrawn-human"), {code:"use_denied"});
  assert.equal(expectedHuman, "owner");
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  assert.equal(f.signal()!.aborted, true);
});
test("human-bound guarded construction requires the owning guard and method; empty links never request credentials", async t => {
  const f = await consentWriterFixture(t);
  assert.throws(() => new HumanConsentEvidenceLinksWriter(f.facade, f.service, f.credential, undefined as any), {code:"invalid_policy"});
  assert.throws(() => new HumanConsentEvidenceLinksWriter(f.facade, {} as EvidenceService, f.credential, f.makeGuard()), {code:"invalid_policy"});
  let credentials = 0;
  const writer = new HumanConsentEvidenceLinksWriter(f.facade, f.service, async () => { credentials++; throw Error("not for empty links"); }, f.makeGuard());
  const ack = await writer.record(c, 1, { ...f.command, links: [] }, "human-empty");
  assert.equal(ack.record.revision, 2);
  assert.equal(credentials, 0);
  assert.deepEqual((await f.repo.loadEvidenceLinks(c)).state.records.at(-1)!.links, []);
});
test("human-bound guarded replay rechecks the credential before returning a legacy historical acknowledgement without another effect", async t => {
  const f = await consentWriterFixture(t);
  const original = await f.makeWriter().record(c, 1, f.command, "shared-profile-command");
  const writer = new HumanConsentEvidenceLinksWriter(f.facade, f.service, f.credential, f.makeGuard());
  Object.assign(f.identities[0]!.actor, {kind:"service"});
  await assert.rejects(writer.record(c, 1, f.command, "shared-profile-command"), {code:"source_unavailable"});
  Object.assign(f.identities[0]!.actor, {kind:"human"});
  const replay = await writer.record(c, 1, f.command, "shared-profile-command");
  assert.deepEqual(replay, original);
  const rows = await f.facade.loadEvidenceLinks(c);
  assert.equal(rows.revision, 2);
  assert.equal(rows.state.records.length, 2);
});

import { HumanConsentEvidenceKnowledgeReview } from "../src/consent-links.ts";

test("human-bound review uses the actual principal with current guards and a captured method, without Knowledge writes", async (t) => {
  const f = await consentWriterFixture(t);
  Object.assign(f.service, { reviewSelectors: async () => { throw Error("legacy review forbidden"); } });
  const client = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, f.makeGuard());
  // The configured owning receiver/method is captured, rather than looked up after admission.
  Object.assign(f.service, { reviewSelectorsForHuman: async () => { throw Error("late method replacement"); } });
  const before = await f.facade.loadEvidenceLinks(c), knowledge = await f.facade.load(c);
  const audits = await scoped(f.consentDb, c, tx => tx.audits());
  const result = await client.review({ ...c, actor: { ...c.actor, roles: ["forged"] } }, f.link.record);
  assert.equal(result.linksRevision, 1);
  assert.equal(result.sources.supports!.sourceGroupCount, 1);
  assert.equal(result.sources.challenges!.sourceGroupCount, 1);
  assert.equal(result.sources.supports!.independentFamilyCount, null);
  assert.equal(result.sources.quotes, null);
  assert.equal((await scoped(f.consentDb, c, tx => tx.audits())).slice(audits.length).filter(x => x.type === "permission.evaluated").length, 2);
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), before);
  assert.deepEqual(await f.facade.load(c), knowledge);
  assert.equal(f.signal()!.aborted, true);
  const original = structuredClone(result);
  Object.assign(result.revision.links[0]!, { id: "detached" });
  assert.deepEqual(await client.review(c, f.link.record), original);
});

test("human-bound review denies another human and same-ID service or agent without legacy fallback", async (t) => {
  const f = await consentWriterFixture(t);
  let legacy = 0;
  Object.assign(f.service, { reviewSelectors: async () => { legacy++; throw Error("forbidden fallback"); } });
  const client = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, f.makeGuard());
  const before = await f.facade.loadEvidenceLinks(c);
  for (const actor of [{ id: "different", kind: "human" }, { id: "owner", kind: "service" }, { id: "owner", kind: "agent" }]) {
    Object.assign(f.identities[0]!.actor, actor);
    await assert.rejects(client.review(c, f.link.record), { code: "source_unavailable", message: "Current Evidence observation unavailable" });
    assert.equal(f.signal()!.aborted, true);
  }
  assert.equal(legacy, 0);
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), before);
  Object.assign(f.identities[0]!.actor, { id: "owner", kind: "human" });
  assert.equal((await client.review(c, f.link.record)).linksRevision, 1);
});

test("human-bound review still withholds actual source results after current Consent withdrawal", async (t) => {
  const f = await consentWriterFixture(t), actual = f.service.reviewSelectorsForHuman.bind(f.service);
  let expected: string | undefined, withdrawn = false;
  const port = { reviewSelectorsForHuman: async (...args: Parameters<typeof actual>) => {
    expected = args[2];
    const result = await actual(...args);
    if (!withdrawn) {
      withdrawn = true;
      await f.permissions.withdraw(c, "consent", "consent", 1, "human-review-withdrawal");
    }
    return result;
  } } as EvidenceService;
  const client = new HumanConsentEvidenceKnowledgeReview(f.facade, port, f.credential, f.makeGuard());
  await assert.rejects(client.review(c, f.link.record), { code: "use_denied" });
  assert.equal(expected, "owner");
  assert.equal(f.signal()!.aborted, true);
  assert.equal((await f.facade.loadEvidenceLinks(c)).revision, 1);
  let credentials = 0;
  const denied = new HumanConsentEvidenceKnowledgeReview(f.facade, port, async () => { credentials++; return f.req.token; }, f.makeGuard());
  await assert.rejects(denied.review(c, f.link.record), { code: "use_denied" });
  assert.equal(credentials, 0);
});

test("human-bound review construction requires the owning guard and method; empty observations need no credential", async (t) => {
  const f = await consentWriterFixture(t);
  assert.throws(() => new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, undefined as never), { code: "invalid_policy" });
  assert.throws(() => new HumanConsentEvidenceKnowledgeReview(f.facade, {} as EvidenceService, f.credential, f.makeGuard()), { code: "invalid_policy" });
  assert.throws(() => new ConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, f.makeGuard(), 10000, "invented" as never), { code: "invalid_policy" });
  // A source-only reviewer cannot enter the proposal path, even when it selects the human method.
  const unguarded = new CurrentEvidenceKnowledgeReview(f.facade, f.service, f.credential, 10000, undefined, "same-human");
  assert.throws(() => new ClaimProposalReader(unguarded as never), { code: "invalid_policy" });
  const empty = await f.makeWriter().record(c, 1, { ...f.command, links: [] }, "human-review-empty");
  let credentials = 0;
  const missing = new CurrentEvidenceUse(f.membership, f.permissions, { ...f.fixed, bindings: [] }, () => c.now);
  const client = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, async () => { credentials++; throw Error("empty is not source use"); }, missing);
  const result = await client.review(c, empty.record);
  assert.equal(result.evidenceRevision, null);
  assert.deepEqual(result.sources, { supports: null, challenges: null, quotes: null });
  assert.equal(credentials, 0);
});

test("human-bound review composes with the protected proposal reader and exact Unicode excerpts without an override bypass", async (t) => {
  const f = await proposalFixture(t, "Neutral 🧭 quoted passage");
  Object.assign(f.service, { reviewSelectors: async () => { throw Error("legacy proposal review forbidden"); } });
  const review = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, f.guard);
  assert.ok(review instanceof ConsentEvidenceKnowledgeReview);
  Object.assign(review, { review: async () => { throw Error("instance override must not run"); } });
  const reader = new ClaimProposalReader(review), before = await f.facade.loadEvidenceLinks(c), knowledge = await f.facade.load(c);
  const candidate = { ...f.candidate, start: 8, end: 10, quote: "🧭" };
  const result = await reader.propose(c, f.selected, [candidate]);
  assert.equal(result.proposals[0]!.citation.excerpt.quote, "🧭");
  assert.equal(result.proposals[0]!.citation.excerpt.start, 8);
  assert.equal(result.proposals[0]!.assessment, null);
  assert.equal(result.proposals[0]!.editorialApproval, null);
  inspectClaimProposals(c, result);
  Object.assign(f.identities[0]!.actor, { kind: "service" });
  await assert.rejects(reader.propose(c, f.selected, [candidate]), { code: "proposal_unavailable" });
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), before);
  assert.deepEqual(await f.facade.load(c), knowledge);
});

test("human-bound review awaits lost or cancelled actual Evidence SQL and never accepts its late result", async (t) => {
  const f = await consentWriterFixture(t), transaction = f.evidence.transaction.bind(f.evidence);
  let lose = true, cancel: AbortController | undefined;
  Object.assign(f.evidence, { transaction: async <T>(fn: Parameters<Database["transaction"]>[0]): Promise<T> => {
    const value = await transaction(fn);
    if (lose) {
      lose = false;
      throw Error("private lost actual Evidence read COMMIT");
    }
    cancel?.abort();
    return value as T;
  } });
  const client = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, f.makeGuard());
  const before = await f.facade.loadEvidenceLinks(c);
  await assert.rejects(client.review(c, f.link.record), { code: "source_unavailable", message: "Current Evidence observation unavailable" });
  assert.equal(f.signal()!.aborted, true);
  // The audit committed even though its acknowledgement was lost; failure does not imply rollback.
  assert.ok((await scoped(f.evidence, c, tx => tx.audits())).some(x => x.type === "evidence.selectors.review_checked"));
  cancel = new AbortController();
  await assert.rejects(client.review(c, f.link.record, cancel.signal), { code: "source_unavailable" });
  assert.equal(cancel.signal.aborted, true);
  assert.equal(f.signal()!.aborted, true);
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), before);
});

import { CurrentVerificationReviewWriter } from "../src/verification-writer.ts";
import { captureVerificationReviewInput } from "../src/verification-review.ts";
import { VERIFICATION_REVIEWS_KIND } from "../src/repository.ts";
function verificationInput(
  f: Awaited<ReturnType<typeof consentWriterFixture>>,
) {
  const check = {
    status: "reviewed" as const,
    note: "A fictional human assertion, not independent proof",
  };
  return {
    linkRef: f.link.record,
    expectedRevision: 0,
    checks: {
      authenticity: check,
      sourceKnowledge: check,
      independentSupport: check,
      counterevidence: check,
    },
    rationale: "Unresolved fictional verification observation",
  };
}
function verificationWriter(
  f: Awaited<ReturnType<typeof consentWriterFixture>>,
  timeout = 10000,
  service = f.service,
) {
  return new CurrentVerificationReviewWriter(
    f.facade,
    new HumanConsentEvidenceKnowledgeReview(
      f.facade,
      service,
      f.credential,
      f.makeGuard(),
    ),
    timeout,
  );
}

test("current verification writer composes actual same-human source Consent and Identity before an unresolved own-DB record", async (t) => {
  const f = await consentWriterFixture(t),
    q = verificationInput(f),
    review = new HumanConsentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
      f.makeGuard(),
    );
  Object.assign(review, {
    review: async () => {
      throw Error("must use owning implementation");
    },
  });
  Object.assign(f.facade, {
    recordVerificationReview: async () => {
      throw Error("must use owning implementation");
    },
  });
  const writer = new CurrentVerificationReviewWriter(f.facade, review),
    claims = await f.facade.load(c),
    links = await f.facade.loadEvidenceLinks(c);
  const ack = await writer.record(
    { ...c, actor: { ...c.actor, roles: ["forged"] } },
    0,
    q,
    "current-verification",
  );
  assert.equal(ack.storage.kind, VERIFICATION_REVIEWS_KIND);
  const rows = await f.facade.loadVerificationReviews(c);
  assert.equal(rows.revision, 1);
  assert.deepEqual(rows.state.records[0]!.challengeLinkIds, ["contrary"]);
  assert.equal(rows.state.records[0]!.resolution, "unresolved");
  assert.equal(rows.state.records[0]!.assessment, null);
  assert.deepEqual(await f.facade.load(c), claims);
  assert.deepEqual(await f.facade.loadEvidenceLinks(c), links);
  assert.equal(f.signal()!.aborted, true);
});

test("current verification writer refuses wrong humans and same-ID service agents before any review record", async (t) => {
  const f = await consentWriterFixture(t),
    writer = verificationWriter(f),
    q = verificationInput(f);
  for (const actor of [
    { id: "other", kind: "human" },
    { id: "owner", kind: "service" },
    { id: "owner", kind: "agent" },
  ]) {
    Object.assign(f.identities[0]!.actor, actor);
    await assert.rejects(writer.record(c, 0, q, "principal-" + actor.kind), {
      code: "verification_unavailable",
      message: "Current verification admission unavailable",
    });
  }
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 0);
  Object.assign(f.identities[0]!.actor, { id: "owner", kind: "human" });
  await f.permissions.withdraw(
    c,
    "consent",
    "consent",
    1,
    "withdraw-before-verification",
  );
  await assert.rejects(writer.record(c, 0, q, "withdrawn"), {
    code: "verification_unavailable",
  });
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 0);
});

test("current verification writer withholds an actual owning source result after Consent withdrawal during observation", async (t) => {
  const f = await consentWriterFixture(t),
    actual = f.service.reviewSelectorsForHuman.bind(f.service);
  let withdrew = false;
  const port = {
    reviewSelectorsForHuman: async (...args: Parameters<typeof actual>) => {
      const result = await actual(...args);
      if (!withdrew) {
        withdrew = true;
        await f.permissions.withdraw(
          c,
          "rights-grant",
          "rights",
          1,
          "withdraw-during-verification",
        );
      }
      return result;
    },
  } as EvidenceService;
  const writer = verificationWriter(f, 10000, port);
  await assert.rejects(
    writer.record(c, 0, verificationInput(f), "withdrawn-result"),
    { code: "verification_unavailable" },
  );
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 0);
  assert.equal(f.signal()!.aborted, true);
});

test("current verification writer preserves unknown lost COMMIT, exact guarded replay and acknowledged commits after cancellation", async (t) => {
  const f = await consentWriterFixture(t),
    transaction = f.knowledge.transaction.bind(f.knowledge),
    q = verificationInput(f);
  let lose = true,
    cancel: AbortController | undefined;
  Object.assign(f.knowledge, {
    transaction: async <T>(
      fn: Parameters<Database["transaction"]>[0],
    ): Promise<T> => {
      let wrote = false;
      const value = await transaction((query) =>
        fn({
          query: async <R>(sql: string, values?: unknown[]) => {
            if (
              sql.includes("INSERT INTO public.evidence_record") &&
              values?.includes(VERIFICATION_REVIEWS_KIND)
            )
              wrote = true;
            return query.query<R>(sql, values);
          },
        }),
      );
      if (wrote && lose) {
        lose = false;
        throw Error("private lost actual verification COMMIT");
      }
      if (wrote) cancel?.abort();
      return value as T;
    },
  });
  const writer = verificationWriter(f);
  await assert.rejects(writer.record(c, 0, q, "lost-verification"), {
    code: "verification_commit_unknown",
  });
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 1);
  const ack = await writer.record(c, 0, q, "lost-verification");
  assert.equal(ack.record.revision, 1);
  Object.assign(f.identities[0]!.actor, { kind: "service" });
  await assert.rejects(writer.record(c, 0, q, "lost-verification"), {
    code: "verification_unavailable",
  });
  Object.assign(f.identities[0]!.actor, { kind: "human" });
  cancel = new AbortController();
  const next = await writer.record(
    c,
    1,
    { ...q, expectedRevision: 1 },
    "ack-after-cancel",
    cancel.signal,
  );
  assert.equal(cancel.signal.aborted, true);
  assert.equal(next.record.revision, 2);
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 2);
});

test("current verification writer gates new and cached admission after actual own history reads even when JS blocks the timer", async (t) => {
  const f = await consentWriterFixture(t),
    transaction = f.knowledge.transaction.bind(f.knowledge),
    q = verificationInput(f);
  let block = true;
  Object.assign(f.knowledge, {
    transaction: <T>(fn: Parameters<Database["transaction"]>[0]): Promise<T> =>
      transaction((query) =>
        fn({
          query: async <R>(sql: string, values?: unknown[]) => {
            const result = await query.query<R>(sql, values);
            if (
              block &&
              sql.includes("SELECT") &&
              values?.includes(VERIFICATION_REVIEWS_KIND)
            ) {
              block = false;
              const until = performance.now() + 1300;
              while (performance.now() < until) {}
            }
            return result;
          },
        }),
      ) as Promise<T>,
  });
  await assert.rejects(
    verificationWriter(f, 1000).record(c, 0, q, "expired-new"),
    { code: "verification_commit_unknown" },
  );
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 0);
  const ack = await f.repo.recordVerificationReview(
    c,
    0,
    q,
    "legacy-historical",
  );
  block = true;
  await assert.rejects(
    verificationWriter(f, 1000).record(c, 0, q, "legacy-historical"),
    { code: "verification_commit_unknown" },
  );
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 1);
  assert.deepEqual(
    await verificationWriter(f).record(c, 0, q, "legacy-historical"),
    ack,
  );
});

test("current verification writer preflight rejects authority accessors scope and missing guard before credentials or SQL", async (t) => {
  const f = await consentWriterFixture(t),
    q = verificationInput(f);
  const legacy = new ConsentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    f.credential,
    f.makeGuard(),
  );
  assert.throws(
    () => new CurrentVerificationReviewWriter(f.facade, legacy as never),
    { code: "invalid_policy" },
  );
  assert.throws(
    () =>
      new CurrentVerificationReviewWriter(
        {} as never,
        new HumanConsentEvidenceKnowledgeReview(
          f.facade,
          f.service,
          f.credential,
          f.makeGuard(),
        ),
      ),
    { code: "invalid_policy" },
  );
  let credentials = 0;
  const review = new HumanConsentEvidenceKnowledgeReview(
    f.facade,
    f.service,
    async () => {
      credentials++;
      throw Error("private callback diagnostic");
    },
    f.makeGuard(),
  );
  const writer = new CurrentVerificationReviewWriter(f.facade, review);
  for (const bad of [
    { ...q, assessment: "verified" },
    { ...q, rationale: "x".repeat(4001) },
    { ...q, linkRef: { ...q.linkRef, projectId: "foreign" } },
    Object.defineProperty({ ...q }, "rationale", {
      get() {
        throw Error("must not invoke accessor");
      },
      enumerable: true,
    }),
  ])
    await assert.rejects(writer.record(c, 0, bad, "bad-input"));
  assert.equal(credentials, 0);
  const captured = captureVerificationReviewInput(c, q);
  Object.assign(q, { rationale: "caller changed" });
  assert.notEqual(captured.rationale, q.rationale);
  await assert.rejects(writer.record(c, 0, captured, "sanitized-callback"), {
    code: "verification_unavailable",
    message: "Current verification admission unavailable",
  });
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 0);
});

test("current verification writer awaits own outbox rollback and requires explicit current guarded replay", async (t) => {
  const f = await consentWriterFixture(t),
    transaction = f.knowledge.transaction.bind(f.knowledge),
    q = verificationInput(f);
  let rollback = true;
  Object.assign(f.knowledge, {
    transaction: <T>(fn: Parameters<Database["transaction"]>[0]): Promise<T> =>
      transaction((query) =>
        fn({
          query: async <R>(sql: string, values?: unknown[]) => {
            const result = await query.query<R>(sql, values);
            if (
              rollback &&
              sql.includes("INSERT INTO public.evidence_outbox") &&
              values?.includes("knowledge.verification-review.revised")
            )
              throw Error("private verification outbox rollback");
            return result;
          },
        }),
      ) as Promise<T>,
  });
  const writer = verificationWriter(f);
  await assert.rejects(writer.record(c, 0, q, "rollback-verification"), {
    code: "verification_commit_unknown",
  });
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 0);
  rollback = false;
  assert.equal(
    (await writer.record(c, 0, q, "rollback-verification")).record.revision,
    1,
  );
});

test("current verification writer binds source admission to the actual writer database basis when scoped refs collide across configurations", async (t) => {
  const f = await consentWriterFixture(t),
    repoDb = await f.database("other_knowledge_login");
  const before = await f.service.inspect(f.req, f.source.ref);
  const other = await f.service.acquire(f.req, {
    id: "unpermitted",
    acquisitionId: "unpermitted-fictional",
    bytes: Buffer.from("A different fictional source with no Consent binding"),
    mediaType: "text/plain",
    capturedAt: c.now,
    originalLanguage: "und",
    supersedes: null,
    expectedRevision: before.revision,
    idempotencyKey: "unpermitted",
  });
  await f.service.runNextScan({ ...f.req, token: "w".repeat(32) });
  const metadata = await f.service.inspect(f.req, other.ref),
    stored = await scoped(f.evidence, c, (tx) =>
      tx.get<{ domain: EvidenceState }>("evidence.aggregate", "project"),
    );
  const repo = new KnowledgeRepository(repoDb, {
    ...f.fixed,
    humanIds: ["owner"],
  });
  const claim = await repo.append(c, 0, f.claim, "same-scoped-claim");
  const links = await repo.recordEvidenceLinks(
    c,
    0,
    stored!.value.domain,
    {
      claim: claim.record,
      expectedRevision: 0,
      links: [
        {
          id: "unpermitted",
          relation: "supports",
          selector: {
            kind: "whole",
            evidence: other.ref,
            sha256: metadata.version.sha256,
          },
        },
      ],
    },
    "same-scoped-link",
  );
  assert.deepEqual(
    links.record,
    f.link.record,
    "Scoped logical references alone can collide across configured deployments",
  );
  const otherFacade = new IdentityKnowledgeRepository(
    repo,
    f.membership,
    f.fixed,
  );
  const writer = new CurrentVerificationReviewWriter(
    otherFacade,
    new HumanConsentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
      f.makeGuard(),
    ),
  );
  await assert.rejects(
    writer.record(c, 0, verificationInput(f), "mismatched-config"),
    { code: "verification_commit_unknown" },
  );
  assert.equal((await otherFacade.loadVerificationReviews(c)).revision, 0);
  assert.equal((await f.facade.loadVerificationReviews(c)).revision, 0);
});

test("current verification writer owning admission refuses async and value-returning hooks before new or cached SQL effects", async t=>{
 const f=await consentWriterFixture(t),q=verificationInput(f);
 for(const admission of [()=>false,async()=>true,()=>Promise.reject(Error("private asynchronous admission diagnostic"))]){
  await assert.rejects(f.repo.recordVerificationReview(c,0,q,"bad-admission",admission),{code:"invalid_policy",message:"Synchronous void verification admission required"});
  assert.equal((await f.facade.loadVerificationReviews(c)).revision,0);
 }
 const ack=await f.repo.recordVerificationReview(c,0,q,"legacy-without-hook");
 await assert.rejects(f.repo.recordVerificationReview(c,0,q,"legacy-without-hook",async()=>true),{code:"invalid_policy"});
 assert.deepEqual(await f.repo.recordVerificationReview(c,0,q,"legacy-without-hook"),ack);
 assert.equal((await f.facade.loadVerificationReviews(c)).revision,1);
});
