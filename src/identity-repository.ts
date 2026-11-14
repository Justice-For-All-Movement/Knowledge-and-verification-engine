import type { VerificationAdmission } from "./repository.ts";
import type { ProposalAcceptanceAdmission } from "./repository.ts";
import type { ProposalAcceptanceInput } from "./proposal-acceptance.ts";
import { copyJson } from "@accountability/consent-rights";
import type { VerificationReviewInput } from "./verification-review.ts";
import type { EvidenceState } from "@accountability/evidence";
import type { EvidenceLinksCommand } from "./evidence-links.ts";
import type { EntityIdentityInput } from "./entity-identity.ts";
import type { MembershipRegistry } from "@accountability/identity-policy/membership";
import { digest, invariant, nonempty, requireScope } from "./contracts.ts";
import type { Context, Scope, Ref } from "./contracts.ts";
import { KnowledgeRepository } from "./repository.ts";
import type { KnowledgeAppend } from "./repository.ts";
export const KNOWLEDGE_RESOURCE_ID = digest({
  kind: "knowledge-private-history-v1",
});
/** Explicit opt-in; host authenticates human kind/id. Current stored roles replace incoming roles. */
export class IdentityKnowledgeRepository {
  readonly #selectedAcceptance: KnowledgeRepository["prepareProposalAcceptance"];
  readonly #acceptProposal: KnowledgeRepository["acceptCapturedProposal"];
  readonly #selectedVerification: KnowledgeRepository["prepareVerificationReview"];
  readonly #verification: KnowledgeRepository["loadVerificationReviews"];
  readonly #recordVerification: KnowledgeRepository["recordVerificationReview"];
  readonly #resolve: MembershipRegistry["resolveResource"];
  readonly #load: KnowledgeRepository["load"];
  readonly #links: KnowledgeRepository["loadEvidenceLinks"];
  readonly #prepareReview: KnowledgeRepository["prepareEvidenceReview"];
  readonly #reviewLinks: KnowledgeRepository["reviewEvidenceLinks"];
  readonly #recordCapture: KnowledgeRepository["recordCapturedEvidenceLinks"];
  readonly #recordLinks: KnowledgeRepository["recordEvidenceLinks"];
  readonly #pairs: KnowledgeRepository["loadEntityIdentities"];
  readonly #recordPair: KnowledgeRepository["recordEntityIdentity"];
  readonly #append: KnowledgeRepository["append"];
  readonly #policy: Scope & Readonly<{ purpose: string }>;
  readonly #timeout: number;
  constructor(
    repository: KnowledgeRepository,
    membership: MembershipRegistry,
    policy: Scope & Readonly<{ purpose: string }>,
    timeoutMs = 10000,
  ) {
    this.#selectedAcceptance = KnowledgeRepository.prototype.prepareProposalAcceptance.bind(repository);
    this.#acceptProposal = KnowledgeRepository.prototype.acceptCapturedProposal.bind(repository);
    this.#selectedVerification = repository.prepareVerificationReview.bind(repository);
    this.#verification = repository.loadVerificationReviews.bind(repository);
    this.#recordVerification =
      repository.recordVerificationReview.bind(repository);
    this.#resolve = membership.resolveResource.bind(membership);
    this.#load = repository.load.bind(repository);
    this.#links = repository.loadEvidenceLinks.bind(repository);
    this.#prepareReview = repository.prepareEvidenceReview.bind(repository);
    this.#reviewLinks = repository.reviewEvidenceLinks.bind(repository);
    this.#recordCapture =
      repository.recordCapturedEvidenceLinks.bind(repository);
    this.#recordLinks = repository.recordEvidenceLinks.bind(repository);
    this.#pairs = repository.loadEntityIdentities.bind(repository);
    this.#recordPair = repository.recordEntityIdentity.bind(repository);
    this.#append = repository.append.bind(repository);
    this.#policy = structuredClone(policy);
    this.#timeout = timeoutMs;
    nonempty(this.#policy.tenantId, "Tenant", 128);
    nonempty(this.#policy.projectId, "Project", 128);
    nonempty(this.#policy.purpose, "Purpose", 128);
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded Identity acceptance budget required",
    );
  }
  async #context(context: Context, signal?: AbortSignal): Promise<Context> {
    const started = performance.now(),
      c = structuredClone(context);
    requireScope(this.#policy, c);
    invariant(
      c.actor.kind === "human" && c.purpose === this.#policy.purpose,
      "forbidden",
      "Human and fixed purpose required",
    );
    // Caller roles have no authority. Begun Identity SQL is awaited, never raced or terminated.
    const principal = { ...c, actor: { ...c.actor, roles: [] } };
    const admitted = () =>
      !signal?.aborted && performance.now() - started < this.#timeout;
    invariant(
      admitted(),
      "identity_unavailable",
      "Current Identity observation unavailable",
    );
    let resolved: Awaited<ReturnType<MembershipRegistry["resolveResource"]>>;
    try {
      resolved = structuredClone(
        await this.#resolve(principal, KNOWLEDGE_RESOURCE_ID, "investigate"),
      );
    } catch {
      invariant(
        false,
        "identity_unavailable",
        "Current Identity observation unavailable",
      );
    }
    invariant(
      admitted(),
      "identity_unavailable",
      "Current Identity observation unavailable",
    );
    const actual = resolved.context;
    requireScope(this.#policy, actual);
    invariant(
      resolved.resourceId === KNOWLEDGE_RESOURCE_ID &&
        actual.actor.kind === "human" &&
        actual.actor.id === c.actor.id &&
        actual.purpose === c.purpose &&
        actual.requestId === c.requestId,
      "identity_unavailable",
      "Current Identity binding unavailable",
    );
    return actual;
  }
  async load(context: Context, signal?: AbortSignal) {
    return this.#load(await this.#context(context, signal));
  }
  async prepareProposalAcceptance(context: Context, selected: Ref, signal?: AbortSignal, admit?: VerificationAdmission) {
    const choice = copyJson(selected);
    return this.#selectedAcceptance(await this.#context(context, signal), choice, admit);
  }
  async acceptCapturedProposal(
    context: Context,
    bundle: unknown,
    input: ProposalAcceptanceInput,
    commandId: string,
    signal?: AbortSignal,
    admission?: ProposalAcceptanceAdmission,
  ) {
    const b = copyJson(bundle), q = copyJson(input), admit = admission;
    return this.#acceptProposal(await this.#context(context, signal), b, q, commandId, admit);
  }
  async append(
    context: Context,
    expectedStorageRevision: number,
    command: KnowledgeAppend,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const q = structuredClone(command);
    return this.#append(
      await this.#context(context, signal),
      expectedStorageRevision,
      q,
      commandId,
    );
  }
  async loadEntityIdentities(context: Context, signal?: AbortSignal) {
    return this.#pairs(await this.#context(context, signal));
  }
  async recordEntityIdentity(
    context: Context,
    expectedStorageRevision: number,
    input: EntityIdentityInput,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const q = structuredClone(input);
    return this.#recordPair(
      await this.#context(context, signal),
      expectedStorageRevision,
      q,
      commandId,
    );
  }
  async loadEvidenceLinks(context: Context, signal?: AbortSignal) {
    return this.#links(await this.#context(context, signal));
  }
  async prepareEvidenceReview(
    context: Context,
    selected: Ref,
    signal?: AbortSignal,
  ) {
    const choice = structuredClone(selected);
    return this.#prepareReview(await this.#context(context, signal), choice);
  }
  async reviewEvidenceLinks(
    context: Context,
    evidence: EvidenceState,
    selected: Ref,
    signal?: AbortSignal,
  ) {
    const source = structuredClone(evidence),
      choice = structuredClone(selected);
    return this.#reviewLinks(
      await this.#context(context, signal),
      source,
      choice,
    );
  }
  async recordEvidenceLinks(
    context: Context,
    expectedStorageRevision: number,
    evidence: EvidenceState,
    command: EvidenceLinksCommand,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const source = structuredClone(evidence),
      q = structuredClone(command);
    return this.#recordLinks(
      await this.#context(context, signal),
      expectedStorageRevision,
      source,
      q,
      commandId,
    );
  }
  async recordCapturedEvidenceLinks(
    context: Context,
    expectedStorageRevision: number,
    capture:
      | import("@accountability/evidence/service").SelectorLinkCapture
      | null,
    command: EvidenceLinksCommand,
    commandId: string,
    signal?: AbortSignal,
    admit?: () => void,
  ) {
    const source = structuredClone(capture),
      q = structuredClone(command);
    return this.#recordCapture(
      await this.#context(context, signal),
      expectedStorageRevision,
      source,
      q,
      commandId,
      admit,
    );
  }
  async prepareVerificationReview(context: Context, selected: Ref, signal?: AbortSignal, admit?: VerificationAdmission) {
    const choice = structuredClone(selected), admission = admit;
    return this.#selectedVerification(await this.#context(context, signal), choice, admission);
  }
  async loadVerificationReviews(context: Context, signal?: AbortSignal) {
    return this.#verification(await this.#context(context, signal));
  }
  async recordVerificationReview(
    context: Context,
    expectedStorageRevision: number,
    input: VerificationReviewInput,
    commandId: string,
    signal?: AbortSignal,
    admit?: VerificationAdmission,
  ) {
    const q = structuredClone(input),
      admission = admit;
    return this.#recordVerification(
      await this.#context(context, signal),
      expectedStorageRevision,
      q,
      commandId,
      admission,
    );
  }
}
