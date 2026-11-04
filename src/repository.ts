import { selectCurrentEvidenceLinks } from "./evidence-links.ts";
import type { EvidenceState } from "@accountability/evidence";
import {
  createEvidenceLinksState,
  assertEvidenceLinksState,
  reviseEvidenceLinks,
  reviseEvidenceLinksFromCapture,
  reviewEvidenceLinks as reviewLinks,
} from "./evidence-links.ts";
import type {
  EvidenceLinksState,
  EvidenceLinksCommand,
} from "./evidence-links.ts";
import {
  createEntityIdentityState,
  assertEntityIdentityState,
  recordEntityIdentity,
} from "./entity-identity.ts";
import type {
  EntityIdentityState,
  EntityIdentityInput,
} from "./entity-identity.ts";
import { scoped } from "@accountability/evidence-sql/database";
import type {
  Database,
  UnitOfWork,
} from "@accountability/evidence-sql/database";
import {
  canonical,
  digest,
  invariant,
  nonempty,
  requireScope,
} from "./contracts.ts";
import type { Context, Json, Ref, Scope } from "./contracts.ts";
import {
  createKnowledgeState,
  inspectKnowledge,
  reviseKnowledge,
} from "./index.ts";
import type { KnowledgeState, KnowledgeValue } from "./index.ts";
export const EVIDENCE_LINKS_KIND = "knowledge-evidence-links-history";
export const EVIDENCE_LINKS_KEY = digest({ aggregate: EVIDENCE_LINKS_KIND });
export const KNOWLEDGE_KIND = "knowledge-history";
export const ENTITY_IDENTITY_KIND = "knowledge-entity-identity-history";
export const ENTITY_IDENTITY_KEY = digest({ aggregate: ENTITY_IDENTITY_KIND });
export const KNOWLEDGE_KEY = digest({ aggregate: KNOWLEDGE_KIND });
export type KnowledgeAppend = Readonly<{
  id: string;
  expectedRevision: number;
  value: KnowledgeValue;
}>;
export type KnowledgeSnapshot = Readonly<{
  revision: number;
  state: KnowledgeState;
}>;
export type KnowledgeAcknowledgement = Readonly<{ storage: Ref; record: Ref }>;
const json = (v: unknown): Json => JSON.parse(canonical(v));
/** Host-authenticated human research facade over its OWN operational database. */
export class KnowledgeRepository {
  readonly #db: Database;
  readonly #policy: Scope &
    Readonly<{ humanIds: readonly string[]; purpose: string }>;
  constructor(
    db: Database,
    policy: Scope & Readonly<{ humanIds: readonly string[]; purpose: string }>,
  ) {
    this.#db = db;
    this.#policy = structuredClone(policy);
    nonempty(this.#policy.tenantId, "Tenant", 128);
    nonempty(this.#policy.projectId, "Project", 128);
    nonempty(this.#policy.purpose, "Purpose", 200);
    invariant(
      Array.isArray(this.#policy.humanIds) &&
        this.#policy.humanIds.length > 0 &&
        this.#policy.humanIds.length <= 128 &&
        new Set(this.#policy.humanIds).size === this.#policy.humanIds.length,
      "invalid_policy",
      "Bounded distinct humans required",
    );
    for (const id of this.#policy.humanIds) nonempty(id, "Human", 128);
  }
  #context(context: Context) {
    const c = structuredClone(context);
    requireScope(this.#policy, c);
    inspectKnowledge(c, createKnowledgeState(c));
    invariant(
      c.actor.kind === "human" &&
        this.#policy.humanIds.includes(c.actor.id) &&
        c.purpose === this.#policy.purpose,
      "forbidden",
      "Listed human research authority and fixed purpose required",
    );
    return c;
  }
  async #load(tx: UnitOfWork, c: Context): Promise<KnowledgeSnapshot> {
    const stored = await tx.get<KnowledgeState>(KNOWLEDGE_KIND, KNOWLEDGE_KEY);
    if (!stored) return { revision: 0, state: createKnowledgeState(c) };
    requireScope(c, stored.value);
    inspectKnowledge(c, stored.value);
    invariant(
      stored.revision === stored.value.records.length,
      "invalid_knowledge",
      "Storage and history sequence mismatch",
    );
    return { revision: stored.revision, state: stored.value };
  }
  async load(context: Context): Promise<KnowledgeSnapshot> {
    const c = this.#context(context);
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("knowledge.read_checked", {});
      return structuredClone(await this.#load(tx, c));
    });
  }
  async append(
    context: Context,
    expectedStorageRevision: number,
    command: KnowledgeAppend,
    commandId: string,
  ): Promise<KnowledgeAcknowledgement> {
    const c = this.#context(context),
      q = structuredClone(command);
    nonempty(commandId, "Command", 128);
    invariant(
      Number.isSafeInteger(expectedStorageRevision) &&
        expectedStorageRevision >= 0,
      "invalid_revision",
      "Expected storage revision required",
    );
    return scoped(this.#db, c, async (tx) => {
      // Acquire the owning project lock BEFORE loading current state or cached acknowledgement.
      await tx.audit("knowledge.append_checked", {
        actorKind: c.actor.kind,
        purpose: c.purpose,
      });
      const current = await this.#load(tx, c);
      return (await tx.idempotent(
        commandId,
        json({
          actorKind: c.actor.kind,
          purpose: c.purpose,
          expectedStorageRevision,
          command: q,
        }),
        async () => {
          invariant(
            current.revision === expectedStorageRevision,
            "revision_conflict",
            "Knowledge storage edition changed",
          );
          const state = reviseKnowledge(c, current.state, q);
          const stored = await tx.put(
            KNOWLEDGE_KIND,
            KNOWLEDGE_KEY,
            current.revision,
            state,
          );
          const result = {
            storage: {
              tenantId: c.tenantId,
              projectId: c.projectId,
              kind: KNOWLEDGE_KIND,
              id: KNOWLEDGE_KEY,
              revision: stored.revision,
            },
            record: state.records.at(-1)!.ref,
          };
          await tx.audit("knowledge.appended", json(result));
          await tx.enqueue("knowledge.revised", json(result));
          return json(result);
        },
      )) as KnowledgeAcknowledgement;
    });
  }
  async #identities(tx: UnitOfWork, c: Context) {
    const stored = await tx.get<EntityIdentityState>(
      ENTITY_IDENTITY_KIND,
      ENTITY_IDENTITY_KEY,
    );
    if (!stored) return { revision: 0, state: createEntityIdentityState(c) };
    requireScope(c, stored.value);
    assertEntityIdentityState(stored.value);
    invariant(
      stored.revision === stored.value.records.length,
      "invalid_identity",
      "Storage and pair history sequence mismatch",
    );
    return { revision: stored.revision, state: stored.value };
  }
  async loadEntityIdentities(context: Context) {
    const c = this.#context(context);
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("knowledge.entity-identity.read_checked", {});
      const knowledge = await this.#load(tx, c),
        pairs = await this.#identities(tx, c);
      return structuredClone({
        ...pairs,
        knowledgeRevision: knowledge.revision,
      });
    });
  }
  async recordEntityIdentity(
    context: Context,
    expectedStorageRevision: number,
    input: EntityIdentityInput,
    commandId: string,
  ): Promise<KnowledgeAcknowledgement> {
    const c = this.#context(context),
      q = structuredClone(input);
    nonempty(commandId, "Command", 128);
    invariant(
      Number.isSafeInteger(expectedStorageRevision) &&
        expectedStorageRevision >= 0,
      "invalid_revision",
      "Expected pair storage revision required",
    );
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("knowledge.entity-identity.append_checked", {});
      const knowledge = await this.#load(tx, c),
        pairs = await this.#identities(tx, c);
      return (await tx.idempotent(
        commandId,
        json({
          operation: "entity-identity",
          actorKind: c.actor.kind,
          purpose: c.purpose,
          expectedStorageRevision,
          input: q,
        }),
        async () => {
          invariant(
            pairs.revision === expectedStorageRevision,
            "revision_conflict",
            "Pair storage edition changed",
          );
          const state = recordEntityIdentity(
            c,
            knowledge.state,
            pairs.state,
            q,
          );
          const stored = await tx.put(
            ENTITY_IDENTITY_KIND,
            ENTITY_IDENTITY_KEY,
            pairs.revision,
            state,
          );
          const result = {
            storage: {
              tenantId: c.tenantId,
              projectId: c.projectId,
              kind: ENTITY_IDENTITY_KIND,
              id: ENTITY_IDENTITY_KEY,
              revision: stored.revision,
            },
            record: state.records.at(-1)!.ref,
          };
          await tx.audit(
            "knowledge.entity-identity.recorded",
            json({ ...result, knowledgeRevision: knowledge.revision }),
          );
          await tx.enqueue("knowledge.entity-identity.revised", json(result));
          return json(result);
        },
      )) as KnowledgeAcknowledgement;
    });
  }
  async #links(tx: UnitOfWork, c: Context) {
    const stored = await tx.get<EvidenceLinksState>(
      EVIDENCE_LINKS_KIND,
      EVIDENCE_LINKS_KEY,
    );
    if (!stored) return { revision: 0, state: createEvidenceLinksState(c) };
    requireScope(c, stored.value);
    assertEvidenceLinksState(stored.value);
    invariant(
      stored.revision === stored.value.records.length,
      "invalid_links",
      "Storage and link history sequence mismatch",
    );
    return { revision: stored.revision, state: stored.value };
  }
  async loadEvidenceLinks(context: Context) {
    const c = this.#context(context);
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("knowledge.evidence-links.read_checked", {});
      const knowledge = await this.#load(tx, c),
        links = await this.#links(tx, c);
      return structuredClone({
        ...links,
        knowledgeRevision: knowledge.revision,
      });
    });
  }
  async prepareEvidenceReview(context: Context, selected: Ref) {
    const c = this.#context(context),
      choice = structuredClone(selected);
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("knowledge.evidence-links.basis_checked", {});
      const knowledge = await this.#load(tx, c),
        links = await this.#links(tx, c);
      return structuredClone({
        knowledgeRevision: knowledge.revision,
        linksRevision: links.revision,
        revision: selectCurrentEvidenceLinks(
          c,
          knowledge.state,
          links.state,
          choice,
        ),
      });
    });
  }
  /** Checked read over actual owning histories; supplied Evidence remains host-trusted. */
  async reviewEvidenceLinks(
    context: Context,
    evidence: EvidenceState,
    selected: Ref,
  ) {
    const c = this.#context(context),
      source = structuredClone(evidence),
      choice = structuredClone(selected);
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("knowledge.evidence-links.review_checked", {});
      const knowledge = await this.#load(tx, c),
        links = await this.#links(tx, c);
      const review = reviewLinks(
        c,
        knowledge.state,
        source,
        links.state,
        choice,
      );
      return structuredClone({
        knowledgeRevision: knowledge.revision,
        linksRevision: links.revision,
        review,
      });
    });
  }
  async recordEvidenceLinks(
    context: Context,
    expectedStorageRevision: number,
    evidence: EvidenceState,
    command: EvidenceLinksCommand,
    commandId: string,
  ): Promise<KnowledgeAcknowledgement> {
    const c = this.#context(context),
      q = structuredClone(command),
      source = structuredClone(evidence);
    nonempty(commandId, "Command", 128);
    invariant(
      Number.isSafeInteger(expectedStorageRevision) &&
        expectedStorageRevision >= 0,
      "invalid_revision",
      "Expected link storage revision required",
    );
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("knowledge.evidence-links.append_checked", {});
      const knowledge = await this.#load(tx, c),
        links = await this.#links(tx, c);
      return (await tx.idempotent(
        commandId,
        json({
          operation: "evidence-links",
          actorKind: c.actor.kind,
          purpose: c.purpose,
          expectedStorageRevision,
          command: q,
        }),
        async () => {
          invariant(
            links.revision === expectedStorageRevision,
            "revision_conflict",
            "Link storage edition changed",
          );
          const state = reviseEvidenceLinks(
            c,
            knowledge.state,
            source,
            links.state,
            q,
          );
          const stored = await tx.put(
            EVIDENCE_LINKS_KIND,
            EVIDENCE_LINKS_KEY,
            links.revision,
            state,
          );
          const result = {
            storage: {
              tenantId: c.tenantId,
              projectId: c.projectId,
              kind: EVIDENCE_LINKS_KIND,
              id: EVIDENCE_LINKS_KEY,
              revision: stored.revision,
            },
            record: state.records.at(-1)!.ref,
          };
          await tx.audit(
            "knowledge.evidence-links.recorded",
            json({ ...result, knowledgeRevision: knowledge.revision }),
          );
          await tx.enqueue("knowledge.evidence-links.revised", json(result));
          return json(result);
        },
      )) as KnowledgeAcknowledgement;
    });
  }
  async recordCapturedEvidenceLinks(
    context: Context,
    expectedStorageRevision: number,
    capture:
      | import("@accountability/evidence/service").SelectorLinkCapture
      | null,
    command: EvidenceLinksCommand,
    commandId: string,
    admit?: () => void,
  ): Promise<KnowledgeAcknowledgement> {
    const c = this.#context(context),
      q = structuredClone(command),
      source = structuredClone(capture);
    nonempty(commandId, "Command", 128);
    invariant(
      Number.isSafeInteger(expectedStorageRevision) &&
        expectedStorageRevision >= 0,
      "invalid_revision",
      "Expected link storage revision required",
    );
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("knowledge.evidence-links.capture_append_checked", {});
      const knowledge = await this.#load(tx, c),
        links = await this.#links(tx, c);
      admit?.();
      return (await tx.idempotent(
        commandId,
        json({
          operation: "evidence-link-capture",
          actorKind: c.actor.kind,
          purpose: c.purpose,
          expectedStorageRevision,
          command: q,
        }),
        async () => {
          invariant(
            links.revision === expectedStorageRevision,
            "revision_conflict",
            "Link storage edition changed",
          );
          const state = reviseEvidenceLinksFromCapture(
            c,
            knowledge.state,
            links.state,
            q,
            source,
          );
          admit?.();
          const stored = await tx.put(
            EVIDENCE_LINKS_KIND,
            EVIDENCE_LINKS_KEY,
            links.revision,
            state,
          );
          const result = {
            storage: {
              tenantId: c.tenantId,
              projectId: c.projectId,
              kind: EVIDENCE_LINKS_KIND,
              id: EVIDENCE_LINKS_KEY,
              revision: stored.revision,
            },
            record: state.records.at(-1)!.ref,
          };
          await tx.audit(
            "knowledge.evidence-links.recorded",
            json({
              ...result,
              knowledgeRevision: knowledge.revision,
              evidenceRevision: source?.revision ?? null,
            }),
          );
          await tx.enqueue("knowledge.evidence-links.revised", json(result));
          return json(result);
        },
      )) as KnowledgeAcknowledgement;
    });
  }
}
