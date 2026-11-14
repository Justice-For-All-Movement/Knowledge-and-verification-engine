import test from "node:test";
import assert from "node:assert/strict";
import { createCapturedClaimDossier } from "../src/claim-dossier.ts";
import { createKnowledgeState, reviseKnowledge } from "../src/index.ts";
import { createEvidenceLinksState } from "../src/evidence-links.ts";
import type { EvidenceSelector } from "@accountability/evidence";
import type { EvidenceLinksState } from "../src/evidence-links.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "dossier",
  actor: { id: "human", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "synthetic",
  now: "2026-01-01T00:00:00Z",
};
function fixture() {
  let knowledge = reviseKnowledge(c, createKnowledgeState(c), {
    id: "event",
    expectedRevision: 0,
    value: {
      type: "event",
      label: "Fictional date",
      description: "Unverified",
      time: { earliest: null, latest: null },
      entityRefs: [],
    },
  });
  knowledge = reviseKnowledge(c, knowledge, {
    id: "claim",
    expectedRevision: 0,
    value: {
      type: "claim",
      text: "Literal <script> assertion",
      subjectRefs: [knowledge.records[0]!.ref],
      time: { earliest: null, latest: null },
      accountType: "document_assertion",
      limitations: ["Not verified"],
      assessment: null,
      proceduralPosture: null,
      editorialApproval: null,
    },
  });
  const claim = knowledge.records[1]!.ref;
  const links: EvidenceLinksState = {
    ...createEvidenceLinksState(c),
    records: [
      {
        ref: { ...claim, kind: "knowledge-evidence-links" },
        supersedes: null,
        claim,
        visibility: "private" as const,
        actorId: c.actor.id,
        actorKind: c.actor.kind,
        createdAt: c.now,
        requestId: c.requestId,
        purpose: c.purpose,
        links: ["supports", "challenges", "quotes"].map((relation, i) => ({
          id: "link" + i,
          relation: relation as "supports" | "challenges" | "quotes",
          selector: {
            kind: "whole",
            evidence: { ...claim, kind: "evidence", id: "source" + i },
            sha256: "a".repeat(64),
          },
          family: {
            familyId: "copy-family",
            roots: ["shared-root"],
            basisDigest: "b".repeat(64),
          },
          fingerprint: "c".repeat(64),
        })),
      },
    ],
  };
  return {
    knowledge,
    links,
    selected: { claim, links: links.records[0]!.ref },
  };
}
test("captured dossier retains all contrary links, exact metadata and unknown independent tracks", () => {
  const f = fixture();
  const d = createCapturedClaimDossier(
    c,
    JSON.stringify({ knowledge: f.knowledge, links: f.links }),
    f.selected,
  );
  assert.deepEqual(d.citations, f.links.records[0]);
  assert.deepEqual(d.claim, f.knowledge.records[1]);
  assert.deepEqual(
    d.citations.links.map((l) => l.relation),
    ["supports", "challenges", "quotes"],
  );
  assert.equal(d.claim.value.type, "claim");
  assert.equal(d.subjects[0]!.status, "same-edition");
  assert.deepEqual(d.basis, {
    knowledgeRecordCount: 2,
    linksRecordCount: 1,
    ...f.selected,
  });
  assert.equal(d.unloaded.includes("current-source-permissions"), true);
  assert.equal(Object.hasOwn(d, "allowed"), false);
});
test("corrected date flags the exact historical subject without substituting the revised value", () => {
  const f = fixture();
  f.knowledge = reviseKnowledge(c, f.knowledge, {
    id: "event",
    expectedRevision: 1,
    value: {
      type: "event",
      label: "Corrected date",
      description: "Synthetic correction",
      time: { earliest: "2026-01-02T00:00:00Z", latest: null },
      entityRefs: [],
    },
  });
  const d = createCapturedClaimDossier(
    c,
    JSON.stringify({ knowledge: f.knowledge, links: f.links }),
    f.selected,
  );
  assert.equal(d.subjects[0]!.status, "changed-in-capture");
  assert.equal(d.subjects[0]!.record.ref.revision, 1);
  assert.equal(d.subjects[0]!.latestObserved.revision, 2);
  assert.equal(d.subjects[0]!.record.value.type, "event");
  assert.equal(d.basis.knowledgeRecordCount, 3);
  (d.subjects[0]!.record as any).value.label = "mutated";
  assert.equal((f.knowledge.records[0]!.value as any).label, "Fictional date");
});
test("wrong roles, actor kind, purpose, selected edition, scope and authority fields deny", () => {
  const f = fixture(),
    text = JSON.stringify({ knowledge: f.knowledge, links: f.links });
  for (const ctx of [
    { ...c, actor: { ...c.actor, roles: [] } },
    { ...c, actor: { ...c.actor, kind: "service" as const } },
    { ...c, purpose: "other" },
    { ...c, projectId: "foreign" },
  ])
    assert.throws(() => createCapturedClaimDossier(ctx, text, f.selected));
  assert.throws(() =>
    createCapturedClaimDossier(c, text, {
      ...f.selected,
      claim: { ...f.selected.claim, revision: 2 },
    }),
  );
  assert.throws(() =>
    createCapturedClaimDossier(
      c,
      JSON.stringify({ knowledge: f.knowledge, links: f.links, allowed: true }),
      f.selected,
    ),
  );
  (f.links.records[0]!.links[1] as any).approved = true;
  assert.throws(() =>
    createCapturedClaimDossier(
      c,
      JSON.stringify({ knowledge: f.knowledge, links: f.links }),
      f.selected,
    ),
  );
});

test("actual pinned Evidence source/representation/family captures retain exact text-page-time-whole citations", async () => {
  const e = await import("@accountability/evidence");
  const { reviseEvidenceLinks } = await import("../src/evidence-links.ts");
  const f = fixture();
  let evidence = e.addSourceFamily(e.createEvidenceState(c), c, {
    id: "source-family",
    label: "Fictional family",
    parentIds: [],
    reason: "Synthetic ancestry",
  });
  evidence = e.acquireEvidence(evidence, c, {
    id: "source",
    bytes: Buffer.from("A😀B fixture"),
    acquisitionId: "synthetic-acq",
    storageVersionRef: "synthetic-object",
    mediaType: "text/plain",
    sourceFamilyId: "source-family",
    capturedAt: c.now,
    originalLanguage: "und",
    allowedPurposes: [c.purpose],
    supersedes: null,
  });
  const v = evidence.versions[0]!;
  evidence = e.beginScan(evidence, c, {
    id: "scan-start",
    evidence: v.ref,
    attemptId: "scan",
    engineVersion: "synthetic-only",
  });
  evidence = e.completeScan(evidence, c, {
    id: "scan-end",
    evidence: v.ref,
    attemptId: "scan",
    sha256: v.sha256,
    status: "clean",
    reason: "Synthetic scanner result, not production qualification",
  });
  evidence = e.addRepresentation(evidence, c, {
    id: "rep",
    evidence: v.ref,
    sourceSha256: v.sha256,
    text: "A😀B fixture",
    pages: ["A😀B fixture"],
    durationMs: 1000,
    toolVersion: "synthetic-parser",
  });
  const r = evidence.representations[0]!,
    base = { evidence: v.ref, sha256: v.sha256 },
    anchor = {
      ...base,
      representationId: r.id,
      representationDigest: r.digest,
    };
  const selectors: EvidenceSelector[] = [
    { ...anchor, kind: "text", page: null, start: 1, end: 3, quote: "😀" },
    { ...anchor, kind: "page", fromPage: 1, toPage: 1 },
    { ...anchor, kind: "time", startMs: 0, endMs: 900 },
    { ...base, kind: "whole" },
  ];
  const links = reviseEvidenceLinks(
    c,
    f.knowledge,
    evidence,
    createEvidenceLinksState(c),
    {
      claim: f.selected.claim,
      expectedRevision: 0,
      links: selectors.map((selector, i) => ({
        id: "actual" + i,
        relation: i === 1 ? "challenges" : "quotes",
        selector,
      })),
    },
  );
  const d = createCapturedClaimDossier(
    c,
    JSON.stringify({ knowledge: f.knowledge, links }),
    { claim: f.selected.claim, links: links.records[0]!.ref },
  );
  for (const l of d.citations.links) {
    assert.equal(
      l.fingerprint,
      e.evidenceDependencyFingerprint(evidence, c, l.selector),
    );
    assert.deepEqual(
      l.family,
      e.getFamilySnapshot(evidence, c, l.selector.evidence),
    );
  }
  assert.deepEqual(
    d.citations.links.map((l) => l.selector),
    selectors,
  );
  assert.equal(d.citations.links[0]!.selector.kind, "text");
  assert.equal(d.citations.links[1]!.relation, "challenges");
  // This pure capture deliberately does not re-observe later source policy; operational use must.
  assert.equal(d.unloaded.includes("current-source-permissions"), true);
});

test("stale claim or citation selection fails rather than dropping or silently rebasing contrary history", () => {
  const f = fixture(),
    old = structuredClone(f.links.records[0]!);
  const next = {
    ...structuredClone(old),
    ref: { ...old.ref, revision: 2 },
    supersedes: old.ref,
    links: old.links.filter((l) => l.relation !== "challenges"),
  };
  f.links = { ...f.links, records: [...f.links.records, next] };
  assert.throws(
    () =>
      createCapturedClaimDossier(
        c,
        JSON.stringify({ knowledge: f.knowledge, links: f.links }),
        f.selected,
      ),
    { code: "stale_links" },
  );
  const d = createCapturedClaimDossier(
    c,
    JSON.stringify({ knowledge: f.knowledge, links: f.links }),
    { ...f.selected, links: next.ref },
  );
  assert.equal(d.citations.links.length, 2);
  assert.equal(d.basis.linksRecordCount, 2);
  assert.equal(d.historicalChallenges.length, 1);
  assert.deepEqual(d.historicalChallenges[0], {
    citationSet: old.ref,
    claim: old.claim,
    link: old.links[1],
  });
  // A later explicit citation edition may remove a link; earlier history is neither erased nor proof of deletion at source.
  assert.equal(f.links.records[0]!.links.length, 3);
  f.knowledge = reviseKnowledge(c, f.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: { ...f.knowledge.records[1]!.value } as any,
  });
  assert.throws(
    () =>
      createCapturedClaimDossier(
        c,
        JSON.stringify({ knowledge: f.knowledge, links: f.links }),
        { ...f.selected, links: next.ref },
      ),
    { code: "stale_claim" },
  );
});

test("whole-output UTF8 budget includes every contrary citation and accepts exact512KiB but rejects one extra byte", () => {
  const f = fixture(),
    base = f.links.records[0]!.links[0]!;
  const run = (size: number) => {
    (f.links.records[0] as any).links = Array.from({ length: 64 }, (_, i) => ({
      ...structuredClone(base),
      id: "bounded" + i,
      relation: i === 63 ? "challenges" : "quotes",
      selector: {
        ...base.selector,
        kind: "text",
        evidence: { ...base.selector.evidence, id: "source" + i },
        representationId: "rep",
        representationDigest: "d".repeat(64),
        page: null,
        start: 0,
        end: size,
        quote: "x".repeat(size),
      },
    }));
    return createCapturedClaimDossier(
      c,
      JSON.stringify({ knowledge: f.knowledge, links: f.links }),
      f.selected,
    );
  };
  let low = 1,
    high = 16000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    try {
      run(mid);
      low = mid;
    } catch (e) {
      assert.equal((e as any).code, "dossier_full");
      high = mid - 1;
    }
  }
  const d = run(low),
    size = Buffer.byteLength(JSON.stringify(d));
  const l = f.links.records[0]!.links.at(-1)!.selector as any;
  l.quote += "x".repeat(512 * 1024 - size);
  l.end = l.quote.length;
  const exact = createCapturedClaimDossier(
    c,
    JSON.stringify({ knowledge: f.knowledge, links: f.links }),
    f.selected,
  );
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 512 * 1024);
  assert.equal(exact.citations.links.at(-1)!.relation, "challenges");
  l.quote += "x";
  l.end++;
  assert.throws(
    () =>
      createCapturedClaimDossier(
        c,
        JSON.stringify({ knowledge: f.knowledge, links: f.links }),
        f.selected,
      ),
    { code: "dossier_full" },
  );
  assert.throws(
    () =>
      createCapturedClaimDossier(
        c,
        " ".repeat(5 * 1024 * 1024 + 1),
        f.selected,
      ),
    { code: "dossier_full" },
  );
  assert.throws(
    () => createCapturedClaimDossier(c, "😀".repeat(1400000), f.selected),
    { code: "dossier_full" },
  );
  assert.throws(() => createCapturedClaimDossier(c, "{broken", f.selected), {
    code: "invalid_dossier",
  });
});

test("historical contrary rows stay labelled and regressing captured lineage denies", () => {
  const f = fixture(),
    old = structuredClone(f.links.records[0]!);
  f.links = {
    ...f.links,
    records: [
      old,
      {
        ...structuredClone(old),
        ref: { ...old.ref, revision: 2 },
        supersedes: old.ref,
        links: [],
      },
    ],
  };
  const selection = { ...f.selected, links: f.links.records[1]!.ref };
  const d = createCapturedClaimDossier(
    c,
    JSON.stringify({ knowledge: f.knowledge, links: f.links }),
    selection,
  );
  assert.equal(d.citations.links.length, 0);
  assert.equal(d.historicalChallenges.length, 1);
  assert.equal(d.historicalChallenges[0]!.link.relation, "challenges");
  (old.claim as any).revision = 99;
  assert.throws(
    () =>
      createCapturedClaimDossier(
        c,
        JSON.stringify({ knowledge: f.knowledge, links: f.links }),
        selection,
      ),
    { code: "invalid_revision" },
  );
});

test("included historical citations and subject records cannot cross the fixed report purpose", () => {
  const f = fixture(),
    old = structuredClone(f.links.records[0]!);
  f.links = {
    ...f.links,
    records: [
      { ...old, purpose: "other-purpose" },
      {
        ...structuredClone(old),
        ref: { ...old.ref, revision: 2 },
        supersedes: old.ref,
        links: [],
      },
    ],
  };
  const selected = { ...f.selected, links: f.links.records[1]!.ref };
  assert.throws(
    () =>
      createCapturedClaimDossier(
        c,
        JSON.stringify({ knowledge: f.knowledge, links: f.links }),
        selected,
      ),
    { code: "purpose_denied" },
  );
  const fresh = fixture();
  (fresh.knowledge.records[0] as any).purpose = "other-purpose";
  assert.throws(
    () =>
      createCapturedClaimDossier(
        c,
        JSON.stringify({ knowledge: fresh.knowledge, links: fresh.links }),
        fresh.selected,
      ),
    { code: "purpose_denied" },
  );
});
