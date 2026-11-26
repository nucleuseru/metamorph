import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { NodeCrypto, NodeWS } from "@effect/platform-node";
import { renderPasswordResetEmail, renderVerificationEmail } from "@metamorph/email";
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
import { AppRoutes } from "./server.ts";
import { Auth, makeAuthShape } from "./services/auth.ts";
import { createSesEmailSender } from "./services/email.ts";
import { EngineTokenService } from "./services/engine-tokens.ts";
import { AssetRepository, PersonaRepository, UsageRepository } from "./services/repositories.ts";
import { ObjectStorage } from "./services/storage.ts";

describe("SES email sender", () => {
  test("builds a SendEmail command", async () => {
    const sent: Array<SendEmailCommand> = [];
    const send = createSesEmailSender({
      fromEmail: "noreply@example.com",
      client: {
        send: async (command: unknown) => {
          sent.push(command as SendEmailCommand);
          return {} as never;
        },
      } as never,
    });

    await send({ to: "a@b.co", subject: "Hi", text: "plain", html: "<b>html</b>" });

    assert.equal(sent.length, 1);
    const input = sent[0]!.input;
    assert.equal(input.FromEmailAddress, "noreply@example.com");
    assert.deepEqual(input.Destination?.ToAddresses, ["a@b.co"]);
    assert.equal(input.Content?.Simple?.Subject?.Data, "Hi");
    assert.equal(input.Content?.Simple?.Body?.Text?.Data, "plain");
    assert.equal(input.Content?.Simple?.Body?.Html?.Data, "<b>html</b>");
  });

  test("React Email templates render HTML and plain text with escaped props", async () => {
    const verify = await renderVerificationEmail({
      name: "<Eve>",
      url: "https://example.com/verify?a=1&b=2",
    });
    assert.equal(verify.subject, "Verify your Metamorph email address");
    assert.match(verify.html, /<!DOCTYPE html/);
    assert.match(verify.html, /&lt;Eve&gt;/);
    assert.match(verify.html, /https:\/\/example\.com\/verify\?a=1(&amp;|&)b=2/);
    assert.match(verify.text, /https:\/\/example\.com\/verify\?a=1&b=2/);

    const reset = await renderPasswordResetEmail({
      name: "Ada",
      url: "https://example.com/reset",
    });
    assert.equal(reset.subject, "Reset your Metamorph password");
    assert.match(reset.html, /<!DOCTYPE html/);
    assert.match(reset.text, /https:\/\/example\.com\/reset/);
  });
});

describe("HTTP routes", () => {
  const instance = createAuth({
    database: memoryAdapter({}),
    secret: "test-secret-test-secret-test-secret-123456",
    baseUrl: "http://localhost:3001",
    trustedOrigins: ["http://localhost:3000"],
    sendEmail: async () => {},
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
        sendEmail: async () => {},
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
