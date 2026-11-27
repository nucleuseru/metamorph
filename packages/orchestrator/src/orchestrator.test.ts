import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Effect, Layer, Stream } from "effect";
import { Mac, SecureRandom } from "effect/crypto";
import { HttpClient, HttpClientResponse } from "effect/http";

import { OrchestratorConfig, defaultOrchestratorConfig } from "./config.ts";
import { EngineClient } from "./engine-client.ts";
import { OrchestratorEventBus } from "./events.ts";
import { EngineOrchestrator } from "./orchestrator.ts";
import { ProviderRegistry, type GpuProvider, type ManagedProviderInstance } from "./provider.ts";
import { InstanceStore } from "./store.ts";
import { signWebhookPayload } from "./webhooks.ts";

describe("EngineOrchestrator lifecycle, webhooks, conflicts, and reconciliation", () => {
  test("provisions session, watches readiness, enforces 1-active-session, verifies webhooks, and stops cleanly", async () => {
    const terminated: Array<string> = [];
    const provider: GpuProvider = {
      name: "local",
      provision: (req) =>
        Effect.succeed({
          provider: "local",
          providerInstanceId: `pod-${req.instanceId}`,
          gpuType: "RTX 5090",
          hourlyRateUsd: 1.5,
          httpUrl: "http://engine.local:8000",
          wsUrl: "ws://engine.local:8000/ws/session",
          tlsSupported: true,
        }),
      getStatus: () =>
        Effect.succeed({
          status: "running",
          httpUrl: "http://engine.local:8000",
          wsUrl: "ws://engine.local:8000/ws/session",
          tlsSupported: true,
        }),
      terminate: (id) =>
        Effect.sync(() => {
          terminated.push(id);
        }),
      listManaged: Effect.succeed([]),
    };

    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((req) =>
        Effect.sync(() => {
          if (req.url.endsWith("/ready")) {
            return HttpClientResponse.fromWeb(
              req,
              new Response(
                JSON.stringify({
                  status: "ready",
                  lifecycle_state: "ready_idle",
                  instance_id: "inst-1",
                  enabled_modalities: ["voice", "video"],
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }
          if (req.url.endsWith("/session/shutdown")) {
            return HttpClientResponse.fromWeb(
              req,
              new Response(JSON.stringify({ status: "shutting_down", reason: "api_requested" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return HttpClientResponse.fromWeb(req, new Response("{}", { status: 404 }));
        }),
      ),
    );

    const testLayer = EngineOrchestrator.layer.pipe(
      Layer.provideMerge(
        OrchestratorConfig.layerFrom({
          ...defaultOrchestratorConfig,
          readinessPollIntervalMs: 20,
          webhookBaseUrl: "https://api.example.com",
        }),
      ),
      Layer.provideMerge(InstanceStore.layerMemory),
      Layer.provideMerge(ProviderRegistry.layerFrom([provider])),
      Layer.provideMerge(EngineClient.layer.pipe(Layer.provide(httpLayer))),
      Layer.provideMerge(OrchestratorEventBus.layer),
      Layer.provideMerge(Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const orchestrator = yield* EngineOrchestrator;
        const eventBus = yield* OrchestratorEventBus;

        const session = yield* orchestrator.provisionSession({
          userId: "user-1",
          modalities: ["voice", "video"],
          quality: "standard",
          jwtPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----",
          instanceId: "inst-1",
        });

        assert.equal(session.status, "provisioning");
        assert.equal(session.gpuType, "RTX 5090");

        // Wait for background watcher to mark ready
        const readyEvent = yield* eventBus.subscribe("inst-1").pipe(
          Stream.filter((evt) => evt.type === "session_ready"),
          Stream.take(1),
          Stream.runCollect,
        );
        assert.equal(readyEvent.length, 1);

        // Enforce 1 active session per user
        const conflict = yield* orchestrator
          .provisionSession({
            userId: "user-1",
            modalities: ["voice"],
            quality: "standard",
            jwtPublicKeyPem: "PEM",
          })
          .pipe(Effect.flip);
        assert.equal(conflict._tag, "ActiveSessionConflictError");

        // Invalid signature rejected
        const bodyBytes = new TextEncoder().encode(
          JSON.stringify({
            event: "connected",
            instance_id: "inst-1",
            timestamp: 123,
            user_id: "user-1",
          }),
        );
        const badSigErr = yield* orchestrator
          .handleWebhook("inst-1", bodyBytes, "sha256=deadbeef")
          .pipe(Effect.flip);
        assert.equal(badSigErr._tag, "WebhookVerificationError");

        // Valid signed webhook transitions state
        const validSig = yield* signWebhookPayload(bodyBytes, session.webhookSecret);
        const active = yield* orchestrator.handleWebhook("inst-1", bodyBytes, validSig);
        assert.equal(active.status, "active");

        // Late 'ready' webhook must not revert active or disconnect_grace back to ready
        const lateReadyBytes = new TextEncoder().encode(
          JSON.stringify({
            event: "ready",
            instance_id: "inst-1",
            timestamp: 123.5,
            enabled_modalities: ["voice", "video"],
          }),
        );
        const lateReadySig = yield* signWebhookPayload(lateReadyBytes, session.webhookSecret);
        const stillActive = yield* orchestrator.handleWebhook(
          "inst-1",
          lateReadyBytes,
          lateReadySig,
        );
        assert.equal(stillActive.status, "active");

        const disconnectBytes = new TextEncoder().encode(
          JSON.stringify({
            event: "disconnected",
            instance_id: "inst-1",
            timestamp: 124,
            user_id: "user-1",
            reason: "client_disconnected",
            disconnect_timeout_s: 30,
          }),
        );
        const discSig = yield* signWebhookPayload(disconnectBytes, session.webhookSecret);
        const graced = yield* orchestrator.handleWebhook("inst-1", disconnectBytes, discSig);
        assert.equal(graced.status, "disconnect_grace");

        const stillGraced = yield* orchestrator.handleWebhook(
          "inst-1",
          lateReadyBytes,
          lateReadySig,
        );
        assert.equal(stillGraced.status, "disconnect_grace");

        // Shutting down webhook stops & terminates provider pod
        const shutdownBytes = new TextEncoder().encode(
          JSON.stringify({
            event: "shutting_down",
            instance_id: "inst-1",
            timestamp: 125,
            user_id: "user-1",
            reason: "disconnect_grace_timeout",
          }),
        );
        const shutSig = yield* signWebhookPayload(shutdownBytes, session.webhookSecret);
        const stopped = yield* orchestrator.handleWebhook("inst-1", shutdownBytes, shutSig);
        assert.equal(stopped.status, "stopped");
        assert.deepEqual(terminated, ["pod-inst-1"]);
      }).pipe(Effect.provide(testLayer)),
    );
  });

  test("marks session failed when engine reports startup_failed shutting_down webhook", async () => {
    const terminated: Array<string> = [];
    const provider: GpuProvider = {
      name: "runpod",
      provision: (req) =>
        Effect.succeed({
          provider: "runpod",
          providerInstanceId: `pod-${req.instanceId}`,
          gpuType: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
          hourlyRateUsd: 2.79,
          httpUrl: "https://pod-8000.proxy.runpod.net",
          wsUrl: "wss://pod-8000.proxy.runpod.net/ws/session",
          tlsSupported: true,
        }),
      getStatus: () =>
        Effect.succeed({
          status: "running",
          httpUrl: "https://pod-8000.proxy.runpod.net",
          wsUrl: "wss://pod-8000.proxy.runpod.net/ws/session",
          tlsSupported: true,
        }),
      terminate: (id) =>
        Effect.sync(() => {
          terminated.push(id);
        }),
      listManaged: Effect.succeed([]),
    };

    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify({
                status: "warming",
                lifecycle_state: "booting",
                instance_id: "inst-fail",
                enabled_modalities: ["voice", "video"],
              }),
              { status: 503, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
    );

    const testLayer = EngineOrchestrator.layer.pipe(
      Layer.provideMerge(
        OrchestratorConfig.layerFrom({
          ...defaultOrchestratorConfig,
          readinessPollIntervalMs: 500,
          webhookBaseUrl: "https://api.example.com",
        }),
      ),
      Layer.provideMerge(InstanceStore.layerMemory),
      Layer.provideMerge(ProviderRegistry.layerFrom([provider])),
      Layer.provideMerge(EngineClient.layer.pipe(Layer.provide(httpLayer))),
      Layer.provideMerge(OrchestratorEventBus.layer),
      Layer.provideMerge(Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const orchestrator = yield* EngineOrchestrator;
        const session = yield* orchestrator.provisionSession({
          userId: "user-fail",
          modalities: ["voice", "video"],
          quality: "standard",
          jwtPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----",
          instanceId: "inst-fail",
        });

        const bodyBytes = new TextEncoder().encode(
          JSON.stringify({
            event: "shutting_down",
            instance_id: "inst-fail",
            timestamp: 126,
            reason: "startup_failed: Missing required JoyAI video checkpoints",
          }),
        );
        const sig = yield* signWebhookPayload(bodyBytes, session.webhookSecret);
        const failed = yield* orchestrator.handleWebhook("inst-fail", bodyBytes, sig);
        assert.equal(failed.status, "failed");
        assert.equal(
          failed.failureReason,
          "startup_failed: Missing required JoyAI video checkpoints",
        );
        assert.deepEqual(terminated, ["pod-inst-fail"]);
      }).pipe(Effect.provide(testLayer)),
    );
  });

  test("reconcileOnce terminates orphaned provider instances not tracked as active", async () => {
    const terminated: Array<string> = [];
    const orphan: ManagedProviderInstance = {
      provider: "runpod",
      providerInstanceId: "orphan-pod-99",
      instanceId: "missing-session",
      status: "running",
      createdAtMs: Date.now() - 300_000,
    };

    const provider: GpuProvider = {
      name: "runpod",
      provision: () => Effect.die("unused"),
      getStatus: () =>
        Effect.succeed({ status: "running", httpUrl: null, wsUrl: null, tlsSupported: true }),
      terminate: (id) =>
        Effect.sync(() => {
          terminated.push(id);
        }),
      listManaged: Effect.succeed([orphan]),
    };

    const testLayer = EngineOrchestrator.layer.pipe(
      Layer.provideMerge(
        OrchestratorConfig.layerFrom({
          ...defaultOrchestratorConfig,
          orphanGracePeriodS: 60,
        }),
      ),
      Layer.provideMerge(InstanceStore.layerMemory),
      Layer.provideMerge(ProviderRegistry.layerFrom([provider])),
      Layer.provideMerge(
        EngineClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((req) =>
                Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}"))),
              ),
            ),
          ),
        ),
      ),
      Layer.provideMerge(OrchestratorEventBus.layer),
      Layer.provideMerge(Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const orchestrator = yield* EngineOrchestrator;
        yield* orchestrator.reconcileOnce;
        assert.deepEqual(terminated, ["orphan-pod-99"]);
      }).pipe(Effect.provide(testLayer)),
    );
  });
});
