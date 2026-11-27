import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";

import { NodeCrypto, NodeHttpServer, NodeWS } from "@effect/platform-node";
import {
  EngineClient,
  EngineOrchestrator,
  InstanceStore,
  OrchestratorConfig,
  OrchestratorEventBus,
  ProviderRegistry,
  defaultOrchestratorConfig,
  signWebhookPayload,
  type GpuProvider,
} from "@metamorph/orchestrator";
import { FrameFlags, Track, VideoCodec, packFrame, unpackFrame } from "@metamorph/shared";
import { Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";

import { AssetRepository, PersonaRepository, UsageRepository } from "./repositories/index.ts";
import { AppRoutes } from "./server.ts";
import { Auth, type AuthShape } from "./services/auth.ts";
import { EngineTokenService } from "./services/engine-tokens.ts";
import { ObjectStorage } from "./services/storage.ts";

interface MockEngineState {
  readonly configPatches: Array<{ readonly auth: string | undefined; readonly body: unknown }>;
  readonly multipartUploads: Array<{
    readonly auth: string | undefined;
    readonly bodyText: string;
  }>;
  shutdownCalls: number;
  readonly wsTextReceived: Array<string>;
  readonly wsBinarySeqs: Array<number>;
}

const TEST_USERS: Readonly<
  Record<string, { readonly id: string; readonly email: string; readonly name: string }>
> = {
  "user-1": { id: "user-1", email: "ada@example.com", name: "Ada" },
  "user-2": { id: "user-2", email: "bob@example.com", name: "Bob" },
};

function makeTestAuthLayer() {
  const shape: AuthShape = {
    instance: {} as never,
    handler: () => Effect.succeed(new Response("unused", { status: 404 })),
    getSession: (headers: Headers) => {
      const uid = headers.get("x-test-user");
      if (!uid || !(uid in TEST_USERS)) {
        return Effect.succeed(null);
      }
      const u = TEST_USERS[uid]!;
      const now = new Date();
      return Effect.succeed({
        user: {
          id: u.id,
          email: u.email,
          name: u.name,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
        session: {
          id: `sess-${u.id}`,
          userId: u.id,
          token: `tok-${u.id}`,
          expiresAt: new Date(now.getTime() + 3600_000),
          ipAddress: null,
          userAgent: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    },
  };
  return Layer.succeed(Auth, Auth.of(shape));
}

async function readNodeBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe("Engine API, Orchestrator, Assets, Personas, SSE & WS Relay", () => {
  const mockState: MockEngineState = {
    configPatches: [],
    multipartUploads: [],
    shutdownCalls: 0,
    wsTextReceived: [],
    wsBinarySeqs: [],
  };

  let tokenServiceRef: EngineTokenService["Service"] | undefined;
  let mockEnginePort = 0;
  let apiPort = 0;
  let nextTlsSupported = true;
  const terminatedPods: Array<string> = [];

  const mockEngineServer: Server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;

    const verifyToken = async (): Promise<boolean> => {
      if (!bearer || !tokenServiceRef) return false;
      const result = await Effect.runPromise(
        tokenServiceRef.verifySessionToken(bearer).pipe(Effect.result),
      );
      return result._tag === "Success";
    };

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          instance_id: "mock-engine",
          backend: "mock",
          enabled_modalities: ["voice", "video"],
        }),
      );
      return;
    }

    if (req.method === "GET" && url === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          lifecycle_state: "ready_idle",
          instance_id: "mock-engine",
          enabled_modalities: ["voice", "video"],
        }),
      );
      return;
    }

    if (!(await verifyToken())) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Unauthorized" }));
      return;
    }

    if (req.method === "GET" && url === "/session/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          instance_id: "mock-engine",
          user_id: "user-1",
          lifecycle_state: "ready_idle",
          enabled_modalities: ["voice", "video"],
          connected: false,
          active_session_id: null,
          disconnect_countdown_s: null,
          idle_countdown_s: 110,
          assets: {
            has_prompt: true,
            prompt_preview: "cyberpunk",
            has_ref_image: true,
            has_ref_audio: true,
            voice_ready: true,
            video_ready: true,
          },
          sync: {
            sync_active: false,
            video_latency_ms: 0,
            audio_latency_ms: 0,
            target_latency_ms: 0,
            offset_ms: 0,
            audio_hold_ms: 0,
            video_hold_ms: 0,
          },
        }),
      );
      return;
    }

    if (req.method === "POST" && url === "/session/config") {
      const body = JSON.parse((await readNodeBody(req)).toString("utf8")) as unknown;
      mockState.configPatches.push({ auth: authHeader, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          hot_swapped: true,
          assets: {
            has_prompt: true,
            prompt_preview: "updated",
            has_ref_image: true,
            has_ref_audio: true,
            voice_ready: true,
            video_ready: true,
          },
        }),
      );
      return;
    }

    if (req.method === "POST" && url === "/session/assets") {
      const bodyText = (await readNodeBody(req)).toString("utf8");
      mockState.multipartUploads.push({ auth: authHeader, bodyText });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          hot_swapped: true,
          assets: {
            has_prompt: true,
            prompt_preview: "multipart",
            has_ref_image: true,
            has_ref_audio: false,
            voice_ready: true,
            video_ready: true,
          },
        }),
      );
      return;
    }

    if (req.method === "POST" && url === "/session/shutdown") {
      mockState.shutdownCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "shutting_down", reason: "api_requested" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const mockWss = new NodeWS.WebSocketServer({ noServer: true });
  mockEngineServer.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").startsWith("/ws/session")) {
      mockWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", async (data, isBinary) => {
          if (!isBinary) {
            const text = data.toString("utf8");
            mockState.wsTextReceived.push(text);
            const msg = JSON.parse(text) as { type?: string; token?: string };
            if (msg.type === "auth" && msg.token && tokenServiceRef) {
              const verified = await Effect.runPromise(
                tokenServiceRef.verifySessionToken(msg.token).pipe(Effect.result),
              );
              if (verified._tag === "Success") {
                ws.send(
                  JSON.stringify({
                    type: "auth_ok",
                    user_id: verified.success.sub,
                    instance_id: verified.success.aud,
                    authorized_modalities: verified.success.modalities,
                    enabled_modalities: ["voice", "video"],
                    assets: {
                      has_prompt: true,
                      has_ref_image: false,
                      has_ref_audio: false,
                      voice_ready: true,
                      video_ready: true,
                    },
                  }),
                );
                return;
              }
            }
            ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
            return;
          }

          const raw =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : Array.isArray(data)
                ? new Uint8Array(Buffer.concat(data))
                : new Uint8Array(data);
          const { header, payload } = unpackFrame(raw);
          mockState.wsBinarySeqs.push(header.seq);
          const echoed = packFrame({
            track: header.track,
            codec: header.codec,
            flags: header.flags,
            seq: header.seq + 1,
            ptsUs: header.ptsUs,
            payload,
          });
          ws.send(echoed, { binary: true });
        });
      });
    } else {
      socket.destroy();
    }
  });

  const apiHttpServer = createServer();
  let appScope: Scope.Closeable | undefined;
  let instanceStoreRef: InstanceStore["Service"] | undefined;

  const setupDone = (async () => {
    await new Promise<void>((resolve) => {
      mockEngineServer.listen(0, "127.0.0.1", () => resolve());
    });
    mockEnginePort = (mockEngineServer.address() as AddressInfo).port;

    const testProvider: GpuProvider = {
      name: "local",
      provision: (req) =>
        Effect.succeed({
          provider: "local",
          providerInstanceId: `mock-pod-${req.instanceId}`,
          gpuType: "NVIDIA RTX 5090",
          hourlyRateUsd: 1.5,
          httpUrl: `http://127.0.0.1:${mockEnginePort}`,
          wsUrl: `ws://127.0.0.1:${mockEnginePort}/ws/session`,
          tlsSupported: nextTlsSupported,
        }),
      getStatus: () =>
        Effect.succeed({
          status: "running",
          httpUrl: `http://127.0.0.1:${mockEnginePort}`,
          wsUrl: `ws://127.0.0.1:${mockEnginePort}/ws/session`,
          tlsSupported: nextTlsSupported,
        }),
      terminate: (id) =>
        Effect.sync(() => {
          terminatedPods.push(id);
        }),
      listManaged: Effect.succeed([]),
    };

    const infraLayer = Layer.mergeAll(
      NodeCrypto.layer,
      FetchHttpClient.layer,
      NodeWS.layerWebSocketConstructor,
    );
    const baseServices = Layer.mergeAll(
      makeTestAuthLayer(),
      ObjectStorage.layerMemory({ baseUrl: "http://127.0.0.1:3001" }),
      EngineTokenService.layerEphemeral(),
      AssetRepository.layerMemory,
      PersonaRepository.layerMemory,
      InstanceStore.layerMemory,
    ).pipe(Layer.provideMerge(infraLayer));
    const usageAndServices = UsageRepository.layerFromStore.pipe(Layer.provideMerge(baseServices));
    const orchestratorServices = EngineOrchestrator.layer.pipe(
      Layer.provideMerge(
        OrchestratorConfig.layerFrom({
          ...defaultOrchestratorConfig,
          readinessPollIntervalMs: 20,
          allowOverrides: false,
        }),
      ),
      Layer.provideMerge(ProviderRegistry.layerFrom([testProvider])),
      Layer.provideMerge(EngineClient.layer),
      Layer.provideMerge(OrchestratorEventBus.layer),
      Layer.provideMerge(usageAndServices),
    );

    const captureHandles = Layer.effectDiscard(
      Effect.gen(function* () {
        tokenServiceRef = yield* EngineTokenService;
        instanceStoreRef = yield* InstanceStore;
      }),
    );

    const serverLayer = HttpRouter.serve(AppRoutes).pipe(
      Layer.provideMerge(captureHandles),
      Layer.provide(orchestratorServices),
      Layer.provide(NodeHttpServer.layer(() => apiHttpServer, { host: "127.0.0.1", port: 0 })),
    );

    appScope = Scope.makeUnsafe();
    await Effect.runPromise(Layer.buildWithScope(serverLayer, appScope));
    apiPort = (apiHttpServer.address() as AddressInfo).port;
  })();

  after(async () => {
    await setupDone.catch(() => {});
    if (appScope) {
      await Effect.runPromise(Scope.close(appScope, Exit.void)).catch(() => {});
    }
    mockWss.close();
    await new Promise<void>((resolve) => mockEngineServer.close(() => resolve()));
  });

  const apiUrl = (path: string) => `http://127.0.0.1:${apiPort}${path}`;

  let uploadedImageId = "";
  let uploadedAudioId = "";
  let createdPersonaId = "";
  let activeSessionId = "";
  let activeSessionToken = "";

  test("1. Assets API: upload, MIME validation, list, signed download & tamper rejection, delete", async () => {
    await setupDone;

    // Unauthenticated rejected
    const unauth = await fetch(apiUrl("/assets"));
    assert.equal(unauth.status, 401);

    // Upload ref_image
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const imgForm = new FormData();
    imgForm.set("kind", "ref_image");
    imgForm.set("name", "Avatar Face");
    imgForm.set("file", new Blob([pngBytes], { type: "image/png" }), "avatar.png");

    const imgRes = await fetch(apiUrl("/assets"), {
      method: "POST",
      headers: { "x-test-user": "user-1" },
      body: imgForm,
    });
    assert.equal(imgRes.status, 201);
    const imgJson = (await imgRes.json()) as {
      id: string;
      kind: string;
      name: string;
      byteSize: number;
      downloadUrl: string;
    };
    assert.equal(imgJson.kind, "ref_image");
    assert.equal(imgJson.name, "Avatar Face");
    assert.equal(imgJson.byteSize, pngBytes.byteLength);
    uploadedImageId = imgJson.id;

    // Upload ref_audio
    const wavBytes = new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);
    const audForm = new FormData();
    audForm.set("kind", "ref_audio");
    audForm.set("file", new Blob([wavBytes], { type: "audio/wav" }), "voice.wav");

    const audRes = await fetch(apiUrl("/assets"), {
      method: "POST",
      headers: { "x-test-user": "user-1" },
      body: audForm,
    });
    assert.equal(audRes.status, 201);
    const audJson = (await audRes.json()) as { id: string; kind: string };
    assert.equal(audJson.kind, "ref_audio");
    uploadedAudioId = audJson.id;

    // Reject unsupported MIME type
    const badForm = new FormData();
    badForm.set("kind", "ref_image");
    badForm.set(
      "file",
      new Blob([new TextEncoder().encode("hi")], { type: "text/plain" }),
      "a.txt",
    );
    const badRes = await fetch(apiUrl("/assets"), {
      method: "POST",
      headers: { "x-test-user": "user-1" },
      body: badForm,
    });
    assert.equal(badRes.status, 422);

    // Filter list by kind
    const listRes = await fetch(apiUrl("/assets?kind=ref_image"), {
      headers: { "x-test-user": "user-1" },
    });
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as { assets: Array<{ id: string }> };
    assert.equal(listJson.assets.length, 1);
    assert.equal(listJson.assets[0]!.id, uploadedImageId);

    // Signed download URL works
    const signedUrl = new URL(imgJson.downloadUrl);
    const dlRes = await fetch(apiUrl(`${signedUrl.pathname}${signedUrl.search}`));
    assert.equal(dlRes.status, 200);
    const dlBytes = new Uint8Array(await dlRes.arrayBuffer());
    assert.deepEqual([...dlBytes], [...pngBytes]);

    // Tampered signature rejected
    const badSigUrl = new URL(signedUrl.toString());
    badSigUrl.searchParams.set("sig", "0".repeat(64));
    const tamperRes = await fetch(apiUrl(`${badSigUrl.pathname}${badSigUrl.search}`));
    assert.equal(tamperRes.status, 403);

    // User isolation
    const otherRes = await fetch(apiUrl(`/assets/${uploadedImageId}`), {
      headers: { "x-test-user": "user-2" },
    });
    assert.equal(otherRes.status, 404);

    // Upload and delete temporary asset
    const tmpForm = new FormData();
    tmpForm.set("kind", "ref_image");
    tmpForm.set("file", new Blob([pngBytes], { type: "image/png" }), "tmp.png");
    const tmpCreated = (await (
      await fetch(apiUrl("/assets"), {
        method: "POST",
        headers: { "x-test-user": "user-1" },
        body: tmpForm,
      })
    ).json()) as { id: string };

    const delRes = await fetch(apiUrl(`/assets/${tmpCreated.id}`), {
      method: "DELETE",
      headers: { "x-test-user": "user-1" },
    });
    assert.equal(delRes.status, 204);
    const afterDel = await fetch(apiUrl(`/assets/${tmpCreated.id}`), {
      headers: { "x-test-user": "user-1" },
    });
    assert.equal(afterDel.status, 404);
  });

  test("2. Personas API: CRUD and asset kind/ownership validation", async () => {
    await setupDone;

    // Mismatched kind rejected (audio asset passed as refImageAssetId)
    const badKindRes = await fetch(apiUrl("/personas"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({
        name: "Invalid",
        modalities: ["voice", "video"],
        refImageAssetId: uploadedAudioId,
      }),
    });
    assert.equal(badKindRes.status, 422);

    // Missing asset rejected
    const missingAssetRes = await fetch(apiUrl("/personas"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({
        name: "Missing",
        modalities: ["video"],
        refImageAssetId: "non-existent",
      }),
    });
    assert.equal(missingAssetRes.status, 404);

    // Create valid persona
    const createRes = await fetch(apiUrl("/personas"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({
        name: "Cyber Punk",
        description: "Neon avatar",
        modalities: ["voice", "video"],
        prompt: "Neon cyberpunk jacket",
        refImageAssetId: uploadedImageId,
        refAudioAssetId: uploadedAudioId,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      id: string;
      refImageUrl: string | null;
      refAudioUrl: string | null;
      prompt: string | null;
    };
    assert.ok(created.refImageUrl?.includes(uploadedImageId));
    assert.ok(created.refAudioUrl?.includes(uploadedAudioId));
    createdPersonaId = created.id;

    // Update persona
    const patchRes = await fetch(apiUrl(`/personas/${createdPersonaId}`), {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({ prompt: "Updated cyberpunk suit" }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as { prompt: string };
    assert.equal(patched.prompt, "Updated cyberpunk suit");

    // List personas
    const listRes = await fetch(apiUrl("/personas"), {
      headers: { "x-test-user": "user-1" },
    });
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as { personas: Array<{ id: string }> };
    assert.equal(listJson.personas.length, 1);
  });

  test("3. Sessions, JWKS, override gating, 1-active-session conflict, and SSE readiness", async () => {
    await setupDone;

    // Public engine JWKS
    const jwksRes = await fetch(apiUrl("/.well-known/engine-jwks.json"));
    assert.equal(jwksRes.status, 200);
    const jwks = (await jwksRes.json()) as { keys: Array<{ kty: string; crv?: string }> };
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0]!.kty, "OKP");
    assert.equal(jwks.keys[0]!.crv, "Ed25519");

    // Overrides disabled -> 403
    const overrideRes = await fetch(apiUrl("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({
        modalities: ["voice"],
        providerOverride: "vastai",
      }),
    });
    assert.equal(overrideRes.status, 403);

    // Create session from persona
    const createRes = await fetch(apiUrl("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({
        personaId: createdPersonaId,
        quality: "high",
      }),
    });
    assert.equal(createRes.status, 201);
    const session = (await createRes.json()) as {
      id: string;
      status: string;
      modalities: Array<string>;
      connection: { mode: string; wsUrl: string | null; token: string | null };
      initialConfig: { prompt: string | null; refImageUrl: string | null };
    };
    assert.deepEqual(session.modalities, ["voice", "video"]);
    assert.equal(session.connection.mode, "direct");
    assert.ok(session.connection.token);
    assert.equal(session.initialConfig.prompt, "Updated cyberpunk suit");
    assert.ok(session.initialConfig.refImageUrl?.includes(uploadedImageId));
    activeSessionId = session.id;
    activeSessionToken = session.connection.token!;

    // Verify minted EdDSA JWT claims
    const claims = await Effect.runPromise(
      tokenServiceRef!.verifySessionToken(activeSessionToken, activeSessionId),
    );
    assert.equal(claims.sub, "user-1");
    assert.equal(claims.aud, activeSessionId);
    assert.deepEqual(claims.modalities, ["voice", "video"]);

    // Second concurrent session for same user -> 409 Conflict
    const conflictRes = await fetch(apiUrl("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({ modalities: ["voice"] }),
    });
    assert.equal(conflictRes.status, 409);

    // SSE stream delivers session_ready event
    const sseRes = await fetch(apiUrl(`/sessions/${activeSessionId}/events`), {
      headers: { "x-test-user": "user-1", accept: "text/event-stream" },
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      if (sseBuffer.includes("session_ready")) break;
    }
    await reader.cancel();
    assert.match(sseBuffer, /"type":"session_ready"/);

    // GET /sessions/active shows ready
    const activeRes = await fetch(apiUrl("/sessions/active"), {
      headers: { "x-test-user": "user-1" },
    });
    assert.equal(activeRes.status, 200);
    const activeJson = (await activeRes.json()) as { status: string };
    assert.equal(activeJson.status, "ready");
  });

  test("4. Engine HTTP proxying: status, PATCH /config, and POST /assets multipart hot-swap", async () => {
    await setupDone;

    // GET /sessions/:id/status
    const statusRes = await fetch(apiUrl(`/sessions/${activeSessionId}/status`), {
      headers: { "x-test-user": "user-1" },
    });
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as { lifecycle_state: string };
    assert.equal(statusJson.lifecycle_state, "ready_idle");

    // PATCH /sessions/:id/config resolving asset ID -> signed URL
    const cfgRes = await fetch(apiUrl(`/sessions/${activeSessionId}/config`), {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({
        prompt: "Anime cel shading",
        refImageAssetId: uploadedImageId,
      }),
    });
    assert.equal(cfgRes.status, 200);
    const cfgJson = (await cfgRes.json()) as { ok: boolean; hot_swapped: boolean };
    assert.equal(cfgJson.ok, true);
    assert.equal(cfgJson.hot_swapped, true);
    assert.equal(mockState.configPatches.length, 1);
    const forwarded = mockState.configPatches[0]!.body as {
      prompt?: string;
      ref_image_url?: string;
    };
    assert.equal(forwarded.prompt, "Anime cel shading");
    assert.ok(forwarded.ref_image_url?.includes(uploadedImageId));

    // PATCH /sessions/:id/config with personaId + clearRefImage / refImageBase64 omits ref_image_url
    const clearPatchRes = await fetch(apiUrl(`/sessions/${activeSessionId}/config`), {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({
        personaId: createdPersonaId,
        clearRefImage: true,
      }),
    });
    assert.equal(clearPatchRes.status, 200);
    const clearForwarded = mockState.configPatches.at(-1)!.body as {
      clear_ref_image?: boolean;
      ref_image_url?: string;
    };
    assert.equal(clearForwarded.clear_ref_image, true);
    assert.equal(clearForwarded.ref_image_url, undefined);

    const b64PatchRes = await fetch(apiUrl(`/sessions/${activeSessionId}/config`), {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "user-1" },
      body: JSON.stringify({
        personaId: createdPersonaId,
        refImageBase64: "AQID",
      }),
    });
    assert.equal(b64PatchRes.status, 200);
    const b64Forwarded = mockState.configPatches.at(-1)!.body as {
      ref_image_base64?: string;
      ref_image_url?: string;
    };
    assert.equal(b64Forwarded.ref_image_base64, "AQID");
    assert.equal(b64Forwarded.ref_image_url, undefined);

    // POST /sessions/:id/assets multipart hot-swap
    const form = new FormData();
    form.set("prompt", "Studio portrait");
    form.set("ref_image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "face.png");
    const upRes = await fetch(apiUrl(`/sessions/${activeSessionId}/assets`), {
      method: "POST",
      headers: { "x-test-user": "user-1" },
      body: form,
    });
    assert.equal(upRes.status, 200);
    const upJson = (await upRes.json()) as { hot_swapped: boolean };
    assert.equal(upJson.hot_swapped, true);
    assert.equal(mockState.multipartUploads.length, 1);
    assert.match(mockState.multipartUploads[0]!.bodyText, /Studio portrait/);
  });

  test("5. WebSocket relay (/sessions/:id/ws) preserves text JSON & binary !BBHIQ frames", async () => {
    await setupDone;

    const wsUrl = `ws://127.0.0.1:${apiPort}/sessions/${activeSessionId}/ws?token=${encodeURIComponent(activeSessionToken)}`;
    const ws = new NodeWS.WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // Send JSON auth message (text frame)
    const authReplyPromise = new Promise<{ text: string; isBinary: boolean }>((resolve) => {
      ws.once("message", (data, isBinary) => {
        resolve({ text: data.toString("utf8"), isBinary });
      });
    });
    ws.send(JSON.stringify({ type: "auth", token: activeSessionToken }));
    const authReply = await authReplyPromise;
    assert.equal(authReply.isBinary, false);
    const authJson = JSON.parse(authReply.text) as { type: string; user_id: string };
    assert.equal(authJson.type, "auth_ok");
    assert.equal(authJson.user_id, "user-1");

    // Send 16-byte binary media frame
    const mediaPayload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const packed = packFrame({
      track: Track.VIDEO,
      codec: VideoCodec.H264_ANNEXB,
      flags: FrameFlags.KEYFRAME,
      seq: 7,
      ptsUs: 90_000n,
      payload: mediaPayload,
    });

    const binaryReplyPromise = new Promise<{ data: Uint8Array; isBinary: boolean }>((resolve) => {
      ws.once("message", (data, isBinary) => {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : Array.isArray(data)
              ? new Uint8Array(Buffer.concat(data))
              : new Uint8Array(data);
        resolve({ data: bytes, isBinary });
      });
    });
    ws.send(packed, { binary: true });
    const binaryReply = await binaryReplyPromise;
    assert.equal(binaryReply.isBinary, true);
    const unpacked = unpackFrame(binaryReply.data);
    assert.equal(unpacked.header.seq, 8);
    assert.equal(unpacked.header.ptsUs, 90_000n);
    assert.deepEqual([...unpacked.payload], [...mediaPayload]);
    assert.deepEqual(mockState.wsBinarySeqs, [7]);

    ws.close(1000, "done");
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  test("6. Signed lifecycle webhooks, stop, relay connection mode & usage summary", async () => {
    await setupDone;
    const record = await Effect.runPromise(instanceStoreRef!.getById(activeSessionId));
    assert.ok(record);

    // Unsigned webhook rejected
    const noSig = await fetch(apiUrl(`/internal/webhooks/engine/${activeSessionId}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "connected", instance_id: activeSessionId, timestamp: 1 }),
    });
    assert.equal(noSig.status, 401);

    // Valid signed 'connected' webhook -> active
    const connBody = new TextEncoder().encode(
      JSON.stringify({
        event: "connected",
        instance_id: activeSessionId,
        timestamp: 2,
        user_id: "user-1",
      }),
    );
    const connSig = await Effect.runPromise(
      signWebhookPayload(connBody, record.webhookSecret).pipe(Effect.provide(NodeCrypto.layer)),
    );
    const connRes = await fetch(apiUrl(`/internal/webhooks/engine/${activeSessionId}`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-metamorph-signature": connSig },
      body: connBody,
    });
    assert.equal(connRes.status, 200);
    const connJson = (await connRes.json()) as { status: string };
    assert.equal(connJson.status, "active");

    // DELETE /sessions/:id calls shutdown + terminates provider
    const stopRes = await fetch(apiUrl(`/sessions/${activeSessionId}`), {
      method: "DELETE",
      headers: { "x-test-user": "user-1" },
    });
    assert.equal(stopRes.status, 200);
    const stopJson = (await stopRes.json()) as { status: string };
    assert.equal(stopJson.status, "stopped");
    assert.equal(mockState.shutdownCalls, 1);
    assert.ok(terminatedPods.includes(`mock-pod-${activeSessionId}`));

    // Usage summary reflects stopped session
    const usageRes = await fetch(apiUrl("/usage/summary"), {
      headers: { "x-test-user": "user-1" },
    });
    assert.equal(usageRes.status, 200);
    const usageJson = (await usageRes.json()) as {
      totalSessions: number;
      activeSessionCount: number;
      byProvider: Record<string, { sessions: number }>;
    };
    assert.equal(usageJson.totalSessions, 1);
    assert.equal(usageJson.activeSessionCount, 0);
    assert.equal(usageJson.byProvider["local"]?.sessions, 1);

    // Verify relay mode when tlsSupported=false (e.g. Vast.ai direct IP)
    // and verify voice-only session with dual-modality persona omits video initialConfig
    nextTlsSupported = false;
    const voicePersonaRes = await fetch(apiUrl("/personas"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-2" },
      body: JSON.stringify({
        name: "Dual For User2",
        modalities: ["voice", "video"],
        prompt: "Neon suit",
      }),
    });
    assert.equal(voicePersonaRes.status, 201);
    const voicePersona = (await voicePersonaRes.json()) as { id: string };

    const relayCreate = await fetch(apiUrl("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-2" },
      body: JSON.stringify({ modalities: ["voice"], personaId: voicePersona.id }),
    });
    assert.equal(relayCreate.status, 201);
    const relaySession = (await relayCreate.json()) as {
      id: string;
      connection: { mode: string; wsUrl: string; relayWsUrl: string };
      initialConfig: { prompt: string | null; refImageUrl: string | null };
    };
    assert.equal(relaySession.connection.mode, "relay");
    assert.equal(relaySession.connection.wsUrl, relaySession.connection.relayWsUrl);
    assert.equal(relaySession.initialConfig.prompt, null);
    assert.equal(relaySession.initialConfig.refImageUrl, null);

    // Mint restricted-modality token rejection check
    const badModToken = await fetch(apiUrl(`/sessions/${relaySession.id}/token`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "user-2" },
      body: JSON.stringify({ modalities: ["video"] }),
    });
    assert.equal(badModToken.status, 403);

    // Clean up user-2 session via shutting_down webhook
    const rec2 = await Effect.runPromise(instanceStoreRef!.getById(relaySession.id));
    const shutBody = new TextEncoder().encode(
      JSON.stringify({
        event: "shutting_down",
        instance_id: relaySession.id,
        timestamp: 3,
        user_id: "user-2",
        reason: "idle",
      }),
    );
    const shutSig = await Effect.runPromise(
      signWebhookPayload(shutBody, rec2!.webhookSecret).pipe(Effect.provide(NodeCrypto.layer)),
    );
    const shutRes = await fetch(apiUrl(`/internal/webhooks/engine/${relaySession.id}`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-metamorph-signature": shutSig },
      body: shutBody,
    });
    assert.equal(shutRes.status, 200);
    assert.equal(((await shutRes.json()) as { status: string }).status, "stopped");
  });
});
