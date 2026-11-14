import test from "node:test";
import assert from "node:assert/strict";
import { ready, fixture, c } from "./dossier-identity-fixture.ts";
import { IdentityKnowledgeCorrectionImpactReader } from "../src/correction-impact-identity.ts";
import { KnowledgeRepository } from "../src/repository.ts";
import { KNOWLEDGE_RESOURCE_ID } from "../src/identity-repository.ts";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import { scoped } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
export async function setup(t: test.TestContext) {
  const f = await ready(t),
    identity = await fixture(t);
  let identityCalls = 0;
  const identityHooks: { after: (() => void) | null } = { after: null };
  const db: Database = {
    close: async () => {},
    transaction: async (fn) => {
      identityCalls++;
      const result = await identity.db.transaction(fn);
      identityHooks.after?.();
      return result;
    },
  };
  const owner = { ...c, actor: { ...c.actor, roles: ["owner"] } };
  const membership = new MembershipRegistry(
    db,
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      bootstrapOwnerIds: [c.actor.id],
    },
    () => c.now,
  );
  await membership.initialize(owner, "init");
  const policy = {
    resourceId: KNOWLEDGE_RESOURCE_ID,
    memberIds: [c.actor.id],
    purposes: [c.purpose],
    actions: ["investigate" as const],
  };
  await membership.setResourcePolicy(owner, 0, policy, "allow");
  const fixed = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
  };
  const before = f.d.knowledge.records[0]!.ref;
  const after = await f.repo.append(
    c,
    1,
    {
      id: before.id,
      expectedRevision: 1,
      value: f.d.knowledge.records[0]!.value,
    },
    "impact-correction",
  );
  const selected = { before, after: after.record };
  return {
    ...f,
    owningPolicy: f.policy,
    identityHooks,
    identity,
    membership,
    owner,
    policy,
    fixed,
    selected,
    count: () => identityCalls,
    reader: new IdentityKnowledgeCorrectionImpactReader(
      f.repo,
      membership,
      fixed,
    ),
  };
}

export { c };
