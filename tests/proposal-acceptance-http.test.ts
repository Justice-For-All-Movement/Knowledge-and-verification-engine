import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceFixture, c } from "./current-proposal-fixture.ts";
import { CurrentProposalAcceptanceReader } from "../src/proposal-acceptance-reader.ts";
import { createProposalAcceptanceReadHandler } from "../src/proposal-acceptance-http.ts";
import { scoped, verifyAudit } from "@accountability/evidence-sql/database";
import type { Ref } from "../src/contracts.ts";
const origin = "https://private.invalid", csrf = "s".repeat(32), base = origin + "/private/proposal-acceptance";
const headers = { "content-type": "application/json", origin, "x-csrf-token": csrf, "sec-fetch-site": "same-origin" };
function request(selected: Ref, extra: Record<string,string> = {}) {
  return new Request(base + "/read", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ selected }) });
}
async function setup(t: test.TestContext) {
  const f = await acceptanceFixture(t), ack = await f.writer.accept(c, f.bundle, f.input, "accept"), signals: AbortSignal[] = [];
  const reader = new CurrentProposalAcceptanceReader(f.facade, f.review);
  const provider = { authenticate: async (_request: unknown, signal: AbortSignal) => {
    signals.push(signal); return { actorId: c.actor.id, requestId: "http-read", csrfToken: csrf };
  } };
  const handler = createProposalAcceptanceReadHandler(reader, f.membership, provider, { ...f.fixed, origin }, () => c.now);
  return { ...f, ack, signals, reader, provider, handler };
}
test("acceptance HTTP releases only an exact selected private current receipt with original metadata and checked audits", async t => {
  const f = await setup(t);
  const session = await f.handler(new Request(base + "/session"));
  assert.equal(session.status, 200); assert.deepEqual(await session.json(), { actorId: c.actor.id, csrfToken: csrf });
  const response = await f.handler(request(f.ack.acceptance));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = await response.json(); assert.deepEqual(body.acceptance, f.ack.acceptance);
  assert.equal(body.record.bundleDigest, f.bundle.digest); assert.equal(body.record.excerpt.quote, "Neutral");
  assert.equal(body.citation.links[0].relation, "quotes"); assert.equal(body.claim.value.assessment, null);
  assert(!JSON.stringify(body).includes(csrf)); assert(f.signals.every(s => s.aborted));
  await scoped(f.knowledge, c, async tx => {
    const audit = await tx.audits(); assert(verifyAudit(audit));
    assert.equal(audit.filter(e => e.type === "knowledge.proposal-acceptance.recorded").length, 1);
  });
});
test("acceptance HTTP denies alternate effects, origins, CSRF and forged reference profiles; withdrawal prevents another read", async t => {
  const f = await setup(t);
  for (const extra of [{ origin: "https://other.invalid" }, { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "none" }, { "x-csrf-token": "wrong" }, { "x-csrf-token": "x".repeat(257) }])
    assert.equal((await f.handler(request(f.ack.acceptance, extra))).status, 403);
  for (const path of ["accept", "record", "send", "publish", "read?x=1"])
    assert.equal((await f.handler(new Request(base + "/" + path, { method: "POST" }))).status, 404);
  for (const selected of [{ ...f.ack.acceptance, revision: 2 }, { ...f.ack.acceptance, kind: "claim" }, { ...f.ack.acceptance, projectId: "other" }])
    assert.equal((await f.handler(request(selected))).status, 503);
  await f.permissions.withdraw(c, "consent", "text-consent", 1, "withdraw");
  const denied = await f.handler(request(f.ack.acceptance)); assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), { error: "proposal_acceptance_unavailable" });
});
test("acceptance HTTP completes bounded UTF8/body/field/chunk admission before authentication", async t => {
  const f = await setup(t); let auth = 0;
  const handler = createProposalAcceptanceReadHandler(f.reader, f.membership,
    { authenticate: async (...args) => { auth++; return f.provider.authenticate(...args); } }, { ...f.fixed, origin, timeoutMs: 1000 }, () => c.now);
  const bodies: BodyInit[] = [new Uint8Array([0xff]), JSON.stringify({ selected: f.ack.acceptance, command: "accept" }),
    "x".repeat(1025), JSON.stringify({ selected: { ...f.ack.acceptance, authority: "owner" } })];
  for (const body of bodies) assert.notEqual((await handler(new Request(base + "/read", { method: "POST", headers, body }))).status, 200);
  const chunks = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from(JSON.stringify({ selected: f.ack.acceptance })));
    for (let n = 0; n < 4096; n++) controller.enqueue(new Uint8Array());
    controller.close();
  } });
  assert.equal((await handler(new Request(base + "/read", { method: "POST", headers, body: chunks, duplex: "half" } as RequestInit))).status, 503);
  assert.equal(auth, 0);
});
test("acceptance HTTP rechecks membership after a stalled body, not the roles or session seen earlier", async t => {
  const f = await setup(t);
  const added = await f.membership.apply(c, 1, { type: "set-member", id: "backup", kind: "human", roles: ["owner"] }, "backup");
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from(JSON.stringify({ selected: f.ack.acceptance }))); close = () => controller.close();
  } });
  const pending = f.handler(new Request(base + "/read", { method: "POST", headers, body, duplex: "half" } as RequestInit));
  await f.membership.apply(c, added.revision, { type: "disable-member", id: c.actor.id }, "disable");
  close(); assert.notEqual((await pending).status, 200);
});
test("acceptance HTTP fences blocked providers and cancelled/hung bodies while closing owned signals", async t => {
  const f = await setup(t); let captured: AbortSignal | undefined, cancelled = false;
  const late = createProposalAcceptanceReadHandler(f.reader, f.membership, { authenticate: async (_request, signal) => {
    captured = signal; const until = performance.now() + 100; while (performance.now() < until) {}
    return { actorId: c.actor.id, requestId: "late", csrfToken: csrf };
  } }, { ...f.fixed, origin, timeoutMs: 50 }, () => c.now);
  assert.equal((await late(new Request(base + "/session"))).status, 503); assert(captured?.aborted);
  const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  assert.equal((await late(new Request(base + "/read", { method: "POST", headers, body, duplex: "half" } as RequestInit))).status, 503);
  assert(cancelled);
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.handler(new Request(base + "/session", { signal: controller.signal }))).status, 503);
});
test("lost actual owning read COMMIT is a sanitized unavailable HTTP response; explicit later read adds no acceptance", async t => {
  const f = await setup(t), original = f.knowledge.transaction.bind(f.knowledge); let lose = true;
  f.knowledge.transaction = fn => {
    let selected = false;
    return original(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => {
      const result = await tx.query<T>(sql, values);
      if (sql.includes("INSERT INTO public.evidence_audit") && values?.includes("knowledge.proposal-acceptance.read_checked")) selected = true;
      return result;
    } })).then(value => { if (selected && lose) { lose = false; throw Error("private commit credential diagnostic"); } return value; });
  };
  const result = await f.handler(request(f.ack.acceptance)); assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "proposal_acceptance_unavailable" });
  assert.equal((await f.handler(request(f.ack.acceptance))).status, 200);
  await scoped(f.knowledge, c, async tx => { assert.equal((await tx.audits()).filter(a => a.type === "knowledge.proposal-acceptance.recorded").length, 1); });
});
