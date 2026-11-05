import { timingSafeEqual } from "node:crypto";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import { createMembershipSessionAuthentication } from "@accountability/identity-policy/membership-session";
import type { HumanSessionProvider } from "@accountability/identity-policy/membership-session";
import { CurrentVerificationReviewWriter } from "./verification-writer.ts";
import { invariant, requireScope, nonempty } from "./contracts.ts";
import type { Scope } from "./contracts.ts";
import { captureVerificationReviewInput } from "./verification-review.ts";
import type { VerificationReviewInput } from "./verification-review.ts";

/** Private unresolved-observation write adapter. Host provides independently authenticated human sessions and TLS. */
export function createVerificationWriteHandler(
  writer: CurrentVerificationReviewWriter,
  membership: MembershipRegistry,
  provider: HumanSessionProvider,
  configuration: Scope & {
    origin: string;
    purpose: string;
    timeoutMs?: number;
  },
  clock: () => string,
) {
  invariant(
    writer instanceof CurrentVerificationReviewWriter &&
      membership instanceof MembershipRegistry,
    "invalid_policy",
    "Owning verification writer and membership registry required",
  );
  const policy = structuredClone(configuration),
    origin = new URL(policy.origin);
  invariant(
    origin.protocol === "https:" && origin.origin === policy.origin,
    "invalid_policy",
    "Exact HTTPS origin required",
  );
  const timeout = policy.timeoutMs ?? 10000;
  invariant(
    Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 30000,
    "invalid_policy",
    "Bounded verification HTTP deadline required",
  );
  const auth = createMembershipSessionAuthentication(
    membership,
    provider,
    { ...policy, action: "investigate", timeoutMs: timeout },
    clock,
  );
  const record = CurrentVerificationReviewWriter.prototype.record.bind(writer);
  const base = "/private/verification-write";
  const response = (status: number, value: unknown) => {
    const body = JSON.stringify(value);
    invariant(
      Buffer.byteLength(body) <= 16 * 1024,
      "verification_unavailable",
      "Response exceeds budget",
    );
    return new Response(body, {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  };
  return async (request: Request): Promise<Response> => {
    const started = performance.now(),
      owned = new AbortController(),
      abort = () => owned.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, timeout);
    const gate = () =>
      invariant(
        !owned.signal.aborted && performance.now() - started < timeout,
        "verification_unavailable",
        "Verification HTTP unavailable",
      );
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      gate();
      const url = new URL(request.url),
        method = request.method;
      if (
        url.origin !== policy.origin ||
        url.search ||
        url.hash ||
        !(
          (method === "GET" && url.pathname === base + "/session") ||
          (method === "POST" && url.pathname === base + "/record")
        )
      )
        return response(404, { error: "not_found" });
      const metadata = {
        url: url.href,
        method,
        headers: new Headers(request.headers),
      };
      const site = metadata.headers.get("sec-fetch-site");
      if (
        site &&
        site !== "same-origin" &&
        !(method === "GET" && site === "none")
      )
        return response(403, { error: "request_denied" });
      if (
        (metadata.headers.has("origin") &&
          metadata.headers.get("origin") !== policy.origin) ||
        (method === "POST" && metadata.headers.get("origin") !== policy.origin)
      )
        return response(403, { error: "request_denied" });
      let command:
        | {
            commandId: string;
            expectedStorageRevision: number;
            input: VerificationReviewInput;
          }
        | undefined;

      if (method === "POST") {
        if (metadata.headers.get("content-type") !== "application/json")
          return response(400, { error: "invalid_request" });
        const length = metadata.headers.get("content-length");
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) > 128 * 1024)
        )
          return response(400, { error: "invalid_request" });
        const pieces: Uint8Array[] = [];
        let bytes = 0,
          chunks = 0;
        stream = request.body?.getReader();
        if (!stream) return response(400, { error: "invalid_request" });
        while (true) {
          gate();
          const item = await new Promise<ReadableStreamReadResult<Uint8Array>>(
            (resolve, reject) => {
              const interrupted = () => reject(Error("cancelled"));
              owned.signal.addEventListener("abort", interrupted, {
                once: true,
              });
              if (owned.signal.aborted) interrupted();
              stream!
                .read()
                .then(resolve, reject)
                .finally(() =>
                  owned.signal.removeEventListener("abort", interrupted),
                );
            },
          );
          gate();
          if (item.done) break;
          bytes += item.value.byteLength;
          invariant(
            ++chunks <= 4096 && bytes <= 128 * 1024,
            "invalid_request",
            "Body exceeds budget",
          );
          pieces.push(Uint8Array.from(item.value));
        }
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const piece of pieces) {
          data.set(piece, offset);
          offset += piece.length;
        }
        const input = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(data),
        );
        gate();
        invariant(
          input &&
            typeof input === "object" &&
            !Array.isArray(input) &&
            Object.keys(input).length === 3 &&
            ["commandId", "expectedStorageRevision", "input"].every((k) =>
              Object.hasOwn(input, k),
            ),
          "invalid_request",
          "Exact command required",
        );
        nonempty(input.commandId, "Command", 128);
        invariant(
          Number.isSafeInteger(input.expectedStorageRevision) &&
            input.expectedStorageRevision >= 0 &&
            input.expectedStorageRevision < Number.MAX_SAFE_INTEGER,
          "invalid_request",
          "Safe storage revision required",
        );
        command = {
          commandId: input.commandId,
          expectedStorageRevision: input.expectedStorageRevision,
          input: captureVerificationReviewInput(policy, input.input),
        };
      }
      gate();
      // Body admission precedes fresh stored membership observation. Begun Identity SQL is awaited.
      const session = await auth.authenticate(metadata, owned.signal);
      gate();
      if (!session) return response(401, { error: "authentication_required" });
      requireScope(policy, session.context);
      if (method === "GET") {
        const result = response(200, {
          actorId: session.context.actor.id,
          csrfToken: session.csrfToken,
        });
        gate();
        return result;
      }
      const token = metadata.headers.get("x-csrf-token");
      if (!token || token.length > 256)
        return response(403, { error: "request_denied" });
      const supplied = Buffer.from(token),
        expected = Buffer.from(session.csrfToken);
      if (
        !supplied.length ||
        supplied.length > 256 ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return response(403, { error: "request_denied" });
      gate();
      const value = await record(
        session.context,
        command!.expectedStorageRevision,
        command!.input,
        command!.commandId,
        owned.signal,
        gate,
      );
      // Acknowledged SQL commit remains acknowledged even when cancellation arrives during settlement.
      return response(200, value);
    } catch {
      return response(503, { error: "verification_write_unknown" });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      owned.abort();
      if (stream) void stream.cancel().catch(() => {});
    }
  };
}
