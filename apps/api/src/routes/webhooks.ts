import { EngineOrchestrator } from "@metamorph/orchestrator";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** Receives HMAC-SHA256 signed lifecycle webhooks from `apps/engine-py`. */
export const EngineWebhookRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const orchestrator = yield* EngineOrchestrator;

    return yield* router.add(
      "POST",
      "/internal/webhooks/engine/:instanceId",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = yield* HttpRouter.params;

        const instanceId = params["instanceId"];
        if (!instanceId) {
          return yield* HttpServerResponse.json({ error: "Missing instanceId" }, { status: 400 });
        }

        const rawBuf = yield* request.arrayBuffer;
        const rawBytes = new Uint8Array(rawBuf);
        const sigHeader = request.headers["x-metamorph-signature"];
        const sig = typeof sigHeader === "string" ? sigHeader : undefined;

        const updated = yield* orchestrator.handleWebhook(instanceId, rawBytes, sig);
        return yield* HttpServerResponse.json(
          { ok: true, instanceId: updated.id, status: updated.status },
          { status: 200 },
        );
      }).pipe(
        Effect.catchTags({
          WebhookVerificationError: (err) =>
            HttpServerResponse.json({ error: err.message }, { status: 401 }),
          InstanceNotFoundError: (err) =>
            HttpServerResponse.json(
              { error: `Instance '${err.instanceId}' not found` },
              { status: 404 },
            ),
        }),
        Effect.catch((err) =>
          Effect.logError("Engine webhook processing failed", err).pipe(
            Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })),
          ),
        ),
      ),
    );
  }),
);
