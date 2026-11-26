import { EngineWebhookEvent } from "@metamorph/shared";
import { Effect, Result, Schema } from "effect";
import { Mac } from "effect/crypto";
import { Hex } from "effect/encoding";

import { WebhookVerificationError } from "./errors.ts";

const decodeWebhookEvent = Schema.decodeUnknownEffect(EngineWebhookEvent);

/**
 * Verifies `X-Metamorph-Signature: sha256=<hex>` using constant-time HMAC-SHA256
 * over the exact raw request payload bytes.
 */
export const verifyWebhookSignature = Effect.fn("verifyWebhookSignature")(function* (
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return yield* new WebhookVerificationError({
      message: "Missing or malformed X-Metamorph-Signature header.",
    });
  }
  const hexTag = signatureHeader.slice("sha256=".length).trim().toLowerCase();
  const decodedTag = Hex.decode(hexTag);
  if (Result.isFailure(decodedTag) || decodedTag.success.byteLength !== 32) {
    return yield* new WebhookVerificationError({
      message: "Malformed HMAC signature digest.",
    });
  }

  const mac = yield* Mac.Mac;
  const keyBytes = new TextEncoder().encode(secret);
  const hmacKey = yield* Mac.key(Mac.hmacSha256, keyBytes).pipe(
    Effect.mapError(
      (cause) =>
        new WebhookVerificationError({
          message: `Failed to import webhook HMAC key: ${cause.message}`,
        }),
    ),
  );
  const valid = yield* mac.verify(hmacKey, decodedTag.success, rawBody).pipe(
    Effect.mapError(
      (cause) =>
        new WebhookVerificationError({
          message: `Webhook HMAC verification failed: ${cause.message}`,
        }),
    ),
  );

  if (!valid) {
    return yield* new WebhookVerificationError({
      message: "Invalid webhook signature.",
    });
  }
});

/** Signs a raw payload using the same `sha256=<hex>` format emitted by `apps/engine-py`. */
export const signWebhookPayload = Effect.fn("signWebhookPayload")(function* (
  rawBody: Uint8Array,
  secret: string,
) {
  const mac = yield* Mac.Mac;
  const hmacKey = yield* Mac.key(Mac.hmacSha256, new TextEncoder().encode(secret));
  const tag = yield* mac.sign(hmacKey, rawBody);
  return `sha256=${Hex.encode(tag)}`;
});

/** Parses and validates a raw webhook JSON payload into an `EngineWebhookEvent`. */
export const parseWebhookEvent = Effect.fn("parseWebhookEvent")(function* (rawBody: Uint8Array) {
  const text = new TextDecoder().decode(rawBody);
  const json = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () =>
      new WebhookVerificationError({
        message: "Webhook body is not valid JSON.",
      }),
  });
  return yield* decodeWebhookEvent(json).pipe(
    Effect.mapError(
      (cause) =>
        new WebhookVerificationError({
          message: `Invalid webhook event schema: ${cause.message}`,
        }),
    ),
  );
});
