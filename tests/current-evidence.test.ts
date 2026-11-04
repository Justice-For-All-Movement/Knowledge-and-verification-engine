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
