import { copyJson } from "@accountability/consent-rights";
import { captureEvidenceLinksCommand } from "./evidence-links.ts";
import {
  canonical,
  digest,
  invariant,
  nonempty,
  requireScope,
  validateRef,
  validTime,
} from "./contracts.ts";
import type { Context, Ref } from "./contracts.ts";
import type { ClaimProposalReader } from "./claim-proposals.ts";
export type ClaimProposalBundle = Awaited<
  ReturnType<ClaimProposalReader["propose"]>
>;
function exact(v: object, keys: string[]) {
  invariant(
    v &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "invalid_proposal_bundle",
    "Exact proposal bundle fields required",
  );
}
function boundary(text: string, i: number) {
  return !(
    i > 0 &&
    i < text.length &&
    /[\uD800-\uDBFF]/.test(text[i - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[i]!)
  );
}
/** Syntax and captured binding inspection ONLY. A recomputable digest never authenticates a bundle. */
export function inspectClaimProposals(
  context: Context,
  input: unknown,
): ClaimProposalBundle {
  const c = structuredClone(context),
    b = copyJson(input) as ClaimProposalBundle;
  nonempty(c.tenantId, "Tenant", 128);
  nonempty(c.projectId, "Project", 128);
  nonempty(c.purpose, "Purpose", 128);
  nonempty(c.actor.id, "Actor", 128);
  nonempty(c.requestId, "Request", 128);
  validTime(c.now);
  invariant(
    c.actor.kind === "human" &&
      Array.isArray(c.actor.roles) &&
      c.actor.roles.some((r) => r === "owner" || r === "researcher"),
    "forbidden",
    "Host-authorized human research context required",
  );
  exact(b, [
    "schemaVersion",
    "tenantId",
    "projectId",
    "visibility",
    "purpose",
    "basis",
    "proposals",
    "digest",
  ]);
  requireScope(c, b);
  invariant(
    b.schemaVersion === 1 &&
      b.visibility === "private" &&
      b.purpose === c.purpose &&
      Buffer.byteLength(canonical(b)) <= 256 * 1024,
    "invalid_proposal_bundle",
    "Bounded private exact-purpose bundle required",
  );
  exact(b.basis, [
    "knowledgeRevision",
    "linksRevision",
    "evidenceRevision",
    "linkRef",
    "claimRef",
  ]);
  for (const n of [
    b.basis.knowledgeRevision,
    b.basis.linksRevision,
    b.basis.evidenceRevision,
  ])
    invariant(
      Number.isSafeInteger(n) && n! > 0,
      "invalid_proposal_bundle",
      "Actual positive containing revisions required",
    );
  const ref = (r: Ref, kind: string) => {
    exact(r, ["tenantId", "projectId", "kind", "id", "revision"]);
    validateRef(r);
    requireScope(c, r);
    invariant(
      r.kind === kind,
      "invalid_proposal_bundle",
      "Exact owning reference kind required",
    );
  };
  ref(b.basis.claimRef, "claim");
  ref(b.basis.linkRef, "knowledge-evidence-links");
  invariant(
    b.basis.claimRef.id === b.basis.linkRef.id &&
      b.basis.knowledgeRevision >= b.basis.claimRef.revision &&
      b.basis.linksRevision >= b.basis.linkRef.revision,
    "invalid_proposal_bundle",
    "Containing history cannot precede logical editions",
  );
  invariant(
    Array.isArray(b.proposals) &&
      b.proposals.length > 0 &&
      b.proposals.length <= 32,
    "invalid_proposal_bundle",
    "Bounded nonempty proposal list required",
  );
  const ids = new Set<string>();
  for (const p of b.proposals) {
    exact(p, [
      "id",
      "assertion",
      "assessment",
      "proceduralPosture",
      "editorialApproval",
      "citation",
      "limitations",
    ]);
    nonempty(p.id, "Proposal ID", 128);
    nonempty(p.assertion, "Assertion", 4000);
    invariant(
      !ids.has(p.id) &&
        p.assessment === null &&
        p.proceduralPosture === null &&
        p.editorialApproval === null,
      "invalid_proposal_bundle",
      "Distinct unassessed proposals required",
    );
    ids.add(p.id);
    exact(p.citation, [
      "linkId",
      "relation",
      "selector",
      "excerpt",
      "selectorFingerprint",
    ]);
    const s = p.citation.selector,
      e = p.citation.excerpt;
    captureEvidenceLinksCommand(c, {
      claim: b.basis.claimRef,
      expectedRevision: 0,
      links: [
        { id: p.citation.linkId, relation: p.citation.relation, selector: s },
      ],
    });
    exact(e, ["start", "end", "quote"]);
    nonempty(e.quote, "Excerpt", 16000);
    invariant(
      s.kind === "text" &&
        s.end - s.start === s.quote.length &&
        Buffer.from(s.quote, "utf8").toString("utf8") === s.quote &&
        Number.isSafeInteger(e.start) &&
        Number.isSafeInteger(e.end) &&
        e.start >= s.start &&
        e.end <= s.end &&
        e.start < e.end &&
        boundary(s.quote, e.start - s.start) &&
        boundary(s.quote, e.end - s.start) &&
        s.quote.slice(e.start - s.start, e.end - s.start) === e.quote,
      "invalid_proposal_bundle",
      "Excerpt must resolve within its unchanged original text selector",
    );
    invariant(
      typeof p.citation.selectorFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(p.citation.selectorFingerprint) &&
        canonical(p.limitations) ===
          canonical([
            "Untrusted assertion proposal; an exact quotation is not verification or corroboration.",
          ]),
      "invalid_proposal_bundle",
      "Original fingerprint profile and unassessed notice required",
    );
  }
  const { digest: hash, ...payload } = b;
  invariant(
    typeof hash === "string" &&
      /^[a-f0-9]{64}$/.test(hash) &&
      hash === digest(payload),
    "invalid_proposal_bundle",
    "Captured bundle digest differs",
  );
  return b;
}
