import { inspectKnowledge } from "./index.ts";
import type { KnowledgeState, KnowledgeRevision } from "./index.ts";
import {
  canonical,
  invariant,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Ref } from "./contracts.ts";

export type KnowledgeImpactEdge = Readonly<{
  from: Ref;
  to: Ref;
  kind:
    "claim-subject" | "event-entity" | "relationship-from" | "relationship-to";
}>;
export type CapturedKnowledgeCorrectionImpact = Readonly<{
  profile: "captured-knowledge-correction-impact-v1";
  visibility: "private";
  tenantId: string;
  projectId: string;
  purpose: string;
  before: Ref;
  after: Ref;
  knowledgeRecordCount: number;
  nodes: readonly Readonly<{
    ref: Ref;
    latestRef: Ref;
    status: "current-edition" | "changed-edition";
    impact: "review-required" | "no-captured-dependency";
  }>[];
  edges: readonly KnowledgeImpactEdge[];
  claims: readonly Readonly<{
    claim: Ref;
    latestClaim: Ref;
    status: "review-required" | "no-captured-dependency";
  }>[];
  unloaded: readonly [
    "evidence-links",
    "verification-reviews",
    "current-source-permissions",
    "investigation-plans",
    "findings",
    "draft-outputs",
    "raw-audit-events",
  ];
}>;
const exact = (r: Ref) => canonical(r),
  logical = (r: Ref) => canonical([r.kind, r.id]);
function children(r: KnowledgeRevision): KnowledgeImpactEdge[] {
  const v = r.value;
  if (v.type === "entity") return [];
  if (v.type === "claim")
    return v.subjectRefs.map((to) => ({
      from: r.ref,
      to,
      kind: "claim-subject",
    }));
  if (v.type === "event")
    return v.entityRefs.map((to) => ({
      from: r.ref,
      to,
      kind: "event-entity",
    }));
  return [
    { from: r.ref, to: v.from, kind: "relationship-from" },
    { from: r.ref, to: v.to, kind: "relationship-to" },
  ];
}
/** Complete captured Knowledge graph only. No owning SQL, current policy, invalidation or truth/closure authority. */
export function inspectCapturedKnowledgeCorrectionImpact(
  context: Context,
  captureJson: string,
  before: Ref,
  after: Ref,
): CapturedKnowledgeCorrectionImpact {
  invariant(
    typeof captureJson === "string" &&
      captureJson.length <= 5 * 1024 * 1024 &&
      Buffer.byteLength(captureJson) <= 5 * 1024 * 1024,
    "impact_full",
    "Whole captured input exceeds budget",
  );
  let state: KnowledgeState;
  try {
    state = JSON.parse(captureJson);
  } catch {
    invariant(false, "invalid_impact", "Captured Knowledge JSON required");
  }
  const c = structuredClone(context),
    prior = structuredClone(before),
    next = structuredClone(after);
  invariant(
    c.actor.kind === "human",
    "forbidden",
    "Host-authorized human context required",
  );
  for (const r of [prior, next]) {
    validateRef(r);
    requireScope(c, r);
    invariant(
      Object.keys(r).sort().join(",") ===
        "id,kind,projectId,revision,tenantId" &&
        Number.isSafeInteger(r.revision) &&
        r.revision > 0,
      "invalid_reference",
      "Exact positive scoped reference required",
    );
  }
  invariant(
    logical(prior) === logical(next) && next.revision === prior.revision + 1,
    "invalid_impact",
    "Consecutive editions of one Knowledge record required",
  );
  const records = inspectKnowledge(c, state!),
    byExact = new Map(records.map((r) => [exact(r.ref), r])),
    latest = new Map<string, Ref>();
  invariant(
    records.every((r) => r.purpose === c.purpose),
    "purpose_denied",
    "Whole captured purpose differs",
  );
  for (const r of records) latest.set(logical(r.ref), r.ref);
  const oldRecord = byExact.get(exact(prior)),
    newRecord = byExact.get(exact(next));
  invariant(
    oldRecord &&
      newRecord &&
      newRecord.supersedes &&
      exact(newRecord.supersedes) === exact(prior),
    "missing_reference",
    "Actual predecessor and successor required",
  );
  invariant(
    exact(latest.get(logical(next))!) === exact(next),
    "stale_reference",
    "Latest successor in capture required",
  );
  const edges: KnowledgeImpactEdge[] = [],
    reverse = new Map<string, string[]>();
  // Retain each actual historical edition's children. Never replace them with latest children.
  for (const r of records)
    for (const edge of children(r)) {
      invariant(
        edges.length < 8192,
        "impact_full",
        "Whole graph edge budget exceeded",
      );
      const from = exact(edge.from),
        to = exact(edge.to);
      invariant(
        byExact.has(to),
        "missing_reference",
        "Complete captured dependency required",
      );
      edges.push(edge);
      reverse.set(to, [...(reverse.get(to) ?? []), from]);
    }
  // Start at ALL older observed editions, not only the immediate predecessor.
  // A reverse queue visits each node once; unrelated and successor-only graphs remain separate.
  const affected = new Set<string>(),
    queue: string[] = [];
  for (const r of records)
    if (logical(r.ref) === logical(prior) && r.ref.revision <= prior.revision) {
      const k = exact(r.ref);
      affected.add(k);
      queue.push(k);
    }
  for (let i = 0; i < queue.length; i++)
    for (const parent of reverse.get(queue[i]!) ?? [])
      if (!affected.has(parent)) {
        affected.add(parent);
        queue.push(parent);
      }
  const nodes: CapturedKnowledgeCorrectionImpact["nodes"] = records.map(
    (r) => ({
      ref: r.ref,
      latestRef: latest.get(logical(r.ref))!,
      status:
        exact(r.ref) === exact(latest.get(logical(r.ref))!)
          ? "current-edition"
          : "changed-edition",
      impact: affected.has(exact(r.ref))
        ? "review-required"
        : "no-captured-dependency",
    }),
  );
  const claims: CapturedKnowledgeCorrectionImpact["claims"] = records
    .filter((r) => r.ref.kind === "claim")
    .map((r) => ({
      claim: r.ref,
      latestClaim: latest.get(logical(r.ref))!,
      status: affected.has(exact(r.ref))
        ? "review-required"
        : "no-captured-dependency",
    }));
  const output: CapturedKnowledgeCorrectionImpact = {
    profile: "captured-knowledge-correction-impact-v1",
    visibility: "private",
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
    before: prior,
    after: next,
    knowledgeRecordCount: records.length,
    nodes,
    edges,
    claims,
    unloaded: [
      "evidence-links",
      "verification-reviews",
      "current-source-permissions",
      "investigation-plans",
      "findings",
      "draft-outputs",
      "raw-audit-events",
    ],
  };
  invariant(
    Buffer.byteLength(canonical(output)) <= 512 * 1024,
    "impact_full",
    "Complete captured impact exceeds budget",
  );
  return structuredClone(output);
}
