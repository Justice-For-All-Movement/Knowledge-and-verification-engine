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
export const c: Context = {
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
export async function fixture(t: test.TestContext) {
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

export async function ready(t: test.TestContext) {
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

