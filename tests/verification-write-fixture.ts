import { createVerificationReadHandler } from "../src/verification-http.ts";
import { CurrentVerificationReviewReader } from "../src/verification-reader.ts";
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
export const c: Context = {
  tenantId: "fiction",
  projectId: "knowledge",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
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
import { PermissionRegistry } from "@accountability/consent-rights/registry";
import {
  CurrentEvidenceUse,
  ConsentEvidenceKnowledgeReview,
  ConsentEvidenceLinksWriter,
  evidenceUseResourceId,
} from "../src/consent-links.ts";
export async function writeFixture(
  t: test.TestContext,
  representationText?: string,
) {
  const f = await ready(t, representationText),
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
  };
}

export function verificationInput(f: Awaited<ReturnType<typeof writeFixture>>) {
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
