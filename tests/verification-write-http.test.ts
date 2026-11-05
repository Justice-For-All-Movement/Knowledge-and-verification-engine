import test from "node:test";
import assert from "node:assert/strict";
import { createVerificationWriteHandler } from "../src/verification-write-http.ts";
import { CurrentVerificationReviewWriter } from "../src/verification-writer.ts";
import { HumanConsentEvidenceKnowledgeReview } from "../src/consent-links.ts";
import {
  writeFixture,
  verificationInput,
  c,
} from "./verification-write-fixture.ts";

async function setup(t: test.TestContext) {
  const f = await writeFixture(t);
  const writer = new CurrentVerificationReviewWriter(
    f.facade,
    new HumanConsentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
      f.makeGuard(),
    ),
  );
  const signals: AbortSignal[] = [];
  const handler = createVerificationWriteHandler(
    writer,
    f.membership,
    {
      authenticate: async (_m, s) => {
        signals.push(s);
        return {
          actorId: "owner",
          requestId: "http",
          csrfToken: "s".repeat(32),
        };
      },
    },
    { ...f.fixed, origin: "https://private.invalid" },
    () => c.now,
  );
  const command = {
    commandId: "record",
    expectedStorageRevision: 0,
    input: verificationInput(f),
  };
  const request = (
    body: unknown = command,
    headers: Record<string, string> = {},
  ) =>
    new Request("https://private.invalid/private/verification-write/record", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://private.invalid",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": "s".repeat(32),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { ...f, writer, handler, signals, command, request };
}
test("protected write records one unresolved observation and exact replay requires current Consent", async (t) => {
  const f = await setup(t);
  const first = await f.handler(f.request());
  assert.equal(first.status, 200);
  const ack = await first.json();
  assert.equal(ack.record.kind, "knowledge-verification-review");
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  assert.deepEqual(await (await f.handler(f.request())).json(), ack);
  await f.permissions.withdraw(c, "consent", "consent", 1, "withdraw");
  const denied = await f.handler(f.request());
  assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), {
    error: "verification_write_unknown",
  });
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  assert.ok(f.signals.every((s) => s.aborted));
});
test("HTTP admission denies forged authority, CSRF and extra commands before any review effect", async (t) => {
  const f = await setup(t);
  for (const request of [
    f.request(f.command, { origin: "https://foreign.invalid" }),
    f.request(f.command, { "x-csrf-token": "wrong" }),
    f.request({ ...f.command, roles: ["owner"] }),
    f.request({
      ...f.command,
      input: { ...f.command.input, assessment: "verified" },
    }),
  ]) {
    assert.notEqual((await f.handler(request)).status, 200);
  }
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
  const session = await f.handler(
    new Request("https://private.invalid/private/verification-write/session"),
  );
  assert.equal(session.status, 200);
});
test("writer's synchronous outer admission cannot be bypassed by async/value hooks before SQL", async (t) => {
  const f = await setup(t);
  for (const admit of [
    () => true,
    async () => {},
    () => {
      throw Error("private diagnostic");
    },
  ])
    await assert.rejects(
      f.writer.record(
        c,
        0,
        f.command.input,
        "bad",
        undefined,
        admit as () => void,
      ),
    );
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
});
