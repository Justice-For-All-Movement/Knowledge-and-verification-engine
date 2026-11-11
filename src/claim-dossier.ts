import {
  canonical,
  invariant,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Ref } from "./contracts.ts";
import { inspectKnowledge } from "./index.ts";
import type { KnowledgeRevision, KnowledgeState } from "./index.ts";
import { selectCurrentEvidenceLinks } from "./evidence-links.ts";
import type {
  EvidenceLink,
  EvidenceLinksRevision,
  EvidenceLinksState,
} from "./evidence-links.ts";

export type CapturedClaimDossier = Readonly<{
  schemaVersion: 1;
  profile: "captured-claim-dossier-v1";
  tenantId: string;
  projectId: string;
  visibility: "private";
  purpose: string;
  basis: Readonly<{
    knowledgeRecordCount: number;
    linksRecordCount: number;
    claim: Ref;
    links: Ref;
  }>;
  claim: KnowledgeRevision;
  citations: EvidenceLinksRevision;
  historicalChallenges: readonly Readonly<{
    citationSet: Ref;
    claim: Ref;
    link: EvidenceLink;
  }>[];
  subjects: readonly Readonly<{
    record: KnowledgeRevision;
    latestObserved: Ref;
    status: "same-edition" | "changed-in-capture";
  }>[];
  unloaded: readonly [
    "evidence-bytes",
    "current-source-permissions",
    "verification-reviews",
    "raw-audit-events",
  ];
}>;

function exact(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  invariant(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      fields.every((k) => Object.hasOwn(value, k)),
    "invalid_dossier",
    "Exact dossier input fields required",
  );
}
const same = (a: Ref, b: Ref) => canonical(a) === canonical(b);

/** Pure private metadata assembly. Host-authorized captures and Context are not authentication. */
export function createCapturedClaimDossier(
  context: Context,
  captureJson: string,
  selection: Readonly<{ claim: Ref; links: Ref }>,
): CapturedClaimDossier {
  // Text-only ingress prevents getters/custom iterators from rewriting the supplied history.
  invariant(
    typeof captureJson === "string" &&
      captureJson.length <= 5 * 1024 * 1024 &&
      Buffer.byteLength(captureJson, "utf8") <= 5 * 1024 * 1024,
    "dossier_full",
    "Captured input exceeds private metadata budget",
  );
  let capture: unknown;
  try {
    capture = JSON.parse(captureJson);
  } catch {
    invariant(false, "invalid_dossier", "Captured JSON required");
  }
  exact(capture, ["knowledge", "links"]);
  const c = structuredClone(context);
  invariant(
    c.actor.kind === "human",
    "forbidden",
    "Host-authorized human research context required",
  );
  const q = structuredClone(selection);
  exact(q, ["claim", "links"]);
  for (const [r, kind] of [
    [q.claim, "claim"],
    [q.links, "knowledge-evidence-links"],
  ] as const) {
    validateRef(r);
    requireScope(c, r);
    invariant(
      r.kind === kind,
      "invalid_reference",
      "Exact dossier reference kind required",
    );
  }
  const knowledge = capture.knowledge as KnowledgeState;
  const links = capture.links as EvidenceLinksState;
  const records = inspectKnowledge(c, knowledge);
  const citation = selectCurrentEvidenceLinks(c, knowledge, links, q.links);
  invariant(
    same(citation.claim, q.claim),
    "stale_claim",
    "Selected claim must equal complete citation basis",
  );
  const claim = records.find((r) => same(r.ref, q.claim));
  invariant(
    claim?.value.type === "claim",
    "missing_reference",
    "Exact selected claim required",
  );
  invariant(
    claim.purpose === c.purpose,
    "purpose_denied",
    "Claim capture purpose differs",
  );
  const historicalChallenges = links.records
    .filter(
      (r) =>
        r.ref.id === citation.ref.id && r.ref.revision < citation.ref.revision,
    )
    .flatMap((r) => {
      invariant(
        r.purpose === c.purpose,
        "purpose_denied",
        "Historical citation purpose differs",
      );
      invariant(
        records.some((k) => same(k.ref, r.claim)),
        "missing_reference",
        "Historical citation claim must exist in captured Knowledge",
      );
      return r.links
        .filter((link) => link.relation === "challenges")
        .map((link) => ({ citationSet: r.ref, claim: r.claim, link }));
    });
  const subjects = claim.value.subjectRefs.map((selected) => {
    const record = records.find((r) => same(r.ref, selected));
    invariant(record, "missing_reference", "Exact captured subject required");
    invariant(
      record.purpose === c.purpose,
      "purpose_denied",
      "Captured subject purpose differs",
    );
    const latest = records
      .filter((r) => r.ref.kind === selected.kind && r.ref.id === selected.id)
      .at(-1)!;
    return {
      record,
      latestObserved: latest.ref,
      status: same(latest.ref, selected)
        ? ("same-edition" as const)
        : ("changed-in-capture" as const),
    };
  });
  const dossier: CapturedClaimDossier = {
    schemaVersion: 1,
    profile: "captured-claim-dossier-v1",
    tenantId: c.tenantId,
    projectId: c.projectId,
    visibility: "private",
    purpose: c.purpose,
    basis: {
      knowledgeRecordCount: records.length,
      linksRecordCount: links.records.length,
      claim: claim.ref,
      links: citation.ref,
    },
    claim,
    citations: citation,
    historicalChallenges,
    subjects,
    unloaded: [
      "evidence-bytes",
      "current-source-permissions",
      "verification-reviews",
      "raw-audit-events",
    ],
  };
  // Whole-output bound: never silently truncate contrary material or claim limitations.
  invariant(
    Buffer.byteLength(canonical(dossier)) <= 512 * 1024,
    "dossier_full",
    "Complete dossier exceeds private output budget",
  );
  return structuredClone(dossier);
}
