import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { NodeCrypto, NodeWS } from "@effect/platform-node";
import {
  EngineClient,
  EngineOrchestrator,
  InstanceStore,
  OrchestratorConfig,
  OrchestratorEventBus,
  ProviderRegistry,
  defaultOrchestratorConfig,
} from "@metamorph/orchestrator";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Context, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { Pool } from "pg";

import { createAuth, createDrizzleDatabase } from "./auth.ts";
import { schema } from "./db/schema.ts";
import { AssetRepository, PersonaRepository, UsageRepository } from "./repositories/index.ts";
import { AppRoutes } from "./server.ts";
import { Auth, makeAuthShape } from "./services/auth.ts";
import { EngineTokenService } from "./services/engine-tokens.ts";
import { ObjectStorage } from "./services/storage.ts";

describe("HTTP routes", () => {
  const instance = createAuth({
    database: memoryAdapter({}),
    secret: "test-secret-test-secret-test-secret-123456",
    baseUrl: "http://localhost:3001",
    trustedOrigins: ["http://localhost:3000"],
    googleClientId: "google-id",
    googleClientSecret: "google-secret",
    jwtIssuer: "http://localhost:3001",
    jwtAudience: "http://localhost:3001",
    jwtExpirationTime: "15m",
  });

  const infraLayer = Layer.mergeAll(
    NodeCrypto.layer,
    FetchHttpClient.layer,
    NodeWS.layerWebSocketConstructor,
    HttpServer.layerServices,
  );
  const repoAndStorageLayer = Layer.mergeAll(
    ObjectStorage.layerMemory(),
    EngineTokenService.layerEphemeral(),
    AssetRepository.layerMemory,
    PersonaRepository.layerMemory,
    InstanceStore.layerMemory,
  ).pipe(Layer.provideMerge(infraLayer));
  const usageLayer = UsageRepository.layerFromStore.pipe(Layer.provideMerge(repoAndStorageLayer));
  const orchestratorLayer = EngineOrchestrator.layer.pipe(
    Layer.provideMerge(OrchestratorConfig.layerFrom(defaultOrchestratorConfig)),
    Layer.provideMerge(ProviderRegistry.layerFrom([])),
    Layer.provideMerge(EngineClient.layer),
    Layer.provideMerge(OrchestratorEventBus.layer),
    Layer.provideMerge(usageLayer),
  );

  const services = Context.make(Auth, Auth.of(makeAuthShape(instance)));
  const { handler, dispose } = HttpRouter.toWebHandler(
    AppRoutes.pipe(
      Layer.provide(Auth.layerFromInstance(instance)),
      Layer.provide(orchestratorLayer),
    ),
    { disableLogger: true },
  );

  after(async () => {
    await dispose();
  });

  test("GET /health", async () => {
    const response = await handler(new Request("http://localhost:3001/health"), services);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  test("GET /me without a session is unauthorized", async () => {
    const response = await handler(new Request("http://localhost:3001/me"), services);
    assert.equal(response.status, 401);
  });

  test("forwards nested /api/auth/* paths to Better Auth", async () => {
    const ok = await handler(new Request("http://localhost:3001/api/auth/ok"), services);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });

    const signIn = await handler(
      new Request("http://localhost:3001/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ provider: "google", callbackURL: "http://localhost:3000/" }),
      }),
      services,
    );
    // Google is configured, so Better Auth answers with an OAuth redirect URL
    // (anything other than 404 proves the nested path reached Better Auth).
    assert.equal(signIn.status, 200);
    const body = (await signIn.json()) as { url?: string };
    assert.match(body.url ?? "", /accounts\.google\.com/);
  });

  test("rejects disabled email/password auth endpoints", async () => {
    const signUp = await handler(
      new Request("http://localhost:3001/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({
          email: "user@example.com",
          password: "password123",
          name: "Test User",
        }),
      }),
      services,
    );
    assert.equal(signUp.status, 400);
  });
});

describe("Drizzle schema and Better Auth adapter", () => {
  test("exports all Better Auth and application tables", () => {
    assert.ok(schema.user);
    assert.ok(schema.session);
    assert.ok(schema.account);
    assert.ok(schema.verification);
    assert.ok(schema.jwks);
    assert.ok(schema.engineSigningKey);
    assert.ok(schema.mediaAsset);
    assert.ok(schema.persona);
    assert.ok(schema.engineSession);
  });

  test("createDrizzleDatabase wires into createAuth without connecting eagerly", async () => {
    const pool = new Pool({ connectionString: "postgresql://invalid:invalid@127.0.0.1:1/none" });
    try {
      const instance = createAuth({
        database: createDrizzleDatabase(pool),
        secret: "test-secret-test-secret-test-secret-123456",
        baseUrl: "http://localhost:3001",
        trustedOrigins: ["http://localhost:3000"],
        jwtIssuer: "http://localhost:3001",
        jwtAudience: "http://localhost:3001",
        jwtExpirationTime: "15m",
      });
      assert.equal(typeof instance.handler, "function");
    } finally {
      await pool.end().catch(() => {});
    }
  });
});
