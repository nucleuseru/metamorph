import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { defaultOrchestratorConfig } from "./config.ts";
import { makeProviderRegistry } from "./provider.ts";
import { makeRunPodProvider } from "./providers/runpod.ts";
import { makeVastAiProvider } from "./providers/vastai.ts";
import { resolveHardwareProfile } from "./sizing.ts";

const makeEffectMockHttpClient = (
  handler: (req: {
    readonly method: string;
    readonly url: string;
    readonly bodyText: string;
  }) => Promise<Response> | Response,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.promise(async () => {
        let bodyText = "";
        if (request.body._tag === "Uint8Array") {
          bodyText = new TextDecoder().decode(request.body.body);
        }
        const res = await handler({ method: request.method, url: request.url, bodyText });
        return HttpClientResponse.fromWeb(request, res);
      }),
    ),
  );

describe("GPU providers & failover", () => {
  test("RunPod v2 provider creates pods with nested gpu.minCudaVersion, reads runtimeStatus, and lists managed pods", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const clientLayer = makeEffectMockHttpClient(({ method, url, bodyText }) => {
      const body = bodyText ? (JSON.parse(bodyText) as unknown) : null;
      requests.push({ method, url, body });

      if (method === "POST" && url.endsWith("/pods")) {
        const parsed = body as { gpu?: { id?: string } };
        if (parsed.gpu?.id === "NVIDIA GeForce RTX 3070") {
          return new Response(JSON.stringify({ error: "out of stock" }), { status: 422 });
        }
        return new Response(
          JSON.stringify({
            id: "pod-3080-1",
            name: "metamorph-inst-1",
            status: "PROVISIONING",
            cost: 0.25,
            gpu: { id: parsed.gpu?.id, count: 1 },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }

      if (method === "GET" && url.endsWith("/pods/pod-3080-1")) {
        return new Response(
          JSON.stringify({
            id: "pod-3080-1",
            name: "metamorph-inst-1",
            status: "RUNNING",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (method === "GET" && url.endsWith("/pods")) {
        return new Response(
          JSON.stringify({
            pods: [
              {
                id: "pod-3080-1",
                name: "metamorph-inst-1",
                status: "RUNNING",
                createdAt: "2026-11-24T10:00:00.000Z",
              },
              {
                id: "unrelated-pod",
                name: "other-workload",
                status: "RUNNING",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (method === "DELETE" && url.endsWith("/pods/pod-3080-1")) {
        return new Response(null, { status: 204 });
      }

      return new Response("not found", { status: 404 });
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const runpod = yield* makeRunPodProvider({
          apiKey: "rp_test",
          cloud: "SECURE",
          dataCenterIds: ["US-GA-1"],
          networkVolumeId: "vol_123",
        });
        const hw = resolveHardwareProfile({
          modalities: ["voice"],
          quality: "standard",
          config: defaultOrchestratorConfig,
        });

        const provisioned = yield* runpod.provision({
          instanceId: "inst-1",
          userId: "user-1",
          modalities: ["voice"],
          quality: "standard",
          hardware: hw,
          env: { ENGINE_INSTANCE_ID: "inst-1" },
        });

        assert.equal(provisioned.provider, "runpod");
        assert.equal(provisioned.providerInstanceId, "pod-3080-1");
        assert.equal(provisioned.gpuType, "NVIDIA GeForce RTX 3080");
        assert.equal(provisioned.hourlyRateUsd, 0.25);
        assert.equal(provisioned.httpUrl, "https://pod-3080-1-8000.proxy.runpod.net");
        assert.equal(provisioned.wsUrl, "wss://pod-3080-1-8000.proxy.runpod.net/ws/session");
        assert.equal(provisioned.tlsSupported, true);

        const secondReq = requests[1]!.body as {
          cloud?: string;
          dataCenterIds?: string[];
          networkVolumes?: unknown;
          mounts?: {
            network?: Array<{ volumeId: string; path: string }>;
            global?: Array<{ volumeId: string; path: string }>;
          };
          gpu?: { minCudaVersion?: string };
        };
        assert.equal(secondReq.cloud, "SECURE");
        assert.deepEqual(secondReq.dataCenterIds, ["US-GA-1"]);
        assert.equal(secondReq.networkVolumes, undefined);
        assert.deepEqual(secondReq.mounts, {
          network: [{ volumeId: "vol_123", path: "/models" }],
        });
        assert.equal(secondReq.gpu?.minCudaVersion, "12.8");

        const runpodGlobal = yield* makeRunPodProvider({
          apiKey: "rp_test",
          cloud: "SECURE",
          globalVolumeId: "gsb_123",
        });
        yield* runpodGlobal.provision({
          instanceId: "inst-global",
          userId: "user-1",
          modalities: ["voice"],
          quality: "standard",
          hardware: hw,
          env: { ENGINE_INSTANCE_ID: "inst-global" },
        });
        const globalReq = requests[requests.length - 1]!.body as {
          mounts?: {
            network?: Array<{ volumeId: string; path: string }>;
            global?: Array<{ volumeId: string; path: string }>;
          };
        };
        assert.deepEqual(globalReq.mounts, {
          global: [{ volumeId: "gsb_123", path: "/models" }],
        });

        const status = yield* runpod.getStatus("pod-3080-1");
        assert.equal(status.status, "running");

        const managed = yield* runpod.listManaged;
        assert.equal(managed.length, 1);
        assert.equal(managed[0]!.instanceId, "inst-1");

        yield* runpod.terminate("pod-3080-1");
      }).pipe(Effect.provide(clientLayer)),
    );
  });

  test("Vast.ai provider searches bundles, rents ask, resolves dynamic HostPort, and supports failover", async () => {
    const clientLayer = makeEffectMockHttpClient(({ method, url }) => {
      if (url.includes("runpod.io")) {
        return new Response(JSON.stringify({ error: "no stock" }), { status: 422 });
      }
      if (method === "POST" && url.endsWith("/bundles/")) {
        return new Response(
          JSON.stringify({
            offers: [{ id: 901, gpu_name: "RTX PRO 6000", gpu_ram: 96000, dph_total: 1.85 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "PUT" && url.endsWith("/asks/901/")) {
        return new Response(JSON.stringify({ success: true, new_contract: 77711 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.endsWith("/instances/77711/")) {
        return new Response(
          JSON.stringify({
            instances: {
              id: 77711,
              label: "metamorph-inst-2",
              actual_status: "running",
              public_ipaddr: "203.0.113.10",
              ports: {
                "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "45123" }],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const runpod = yield* makeRunPodProvider({ apiKey: "rp_test" });
        const vastai = yield* makeVastAiProvider({ apiKey: "vast_test" });
        const registry = makeProviderRegistry([runpod, vastai]);
        const hw = resolveHardwareProfile({
          modalities: ["voice", "video"],
          quality: "high",
          config: defaultOrchestratorConfig,
        });

        const provisioned = yield* registry.provisionWithFailover({
          instanceId: "inst-2",
          userId: "user-2",
          modalities: ["voice", "video"],
          quality: "high",
          hardware: hw,
          env: {},
        });

        assert.equal(provisioned.provider, "vastai");
        assert.equal(provisioned.providerInstanceId, "77711");
        assert.equal(provisioned.hourlyRateUsd, 1.85);
        assert.equal(provisioned.tlsSupported, false);
        assert.equal(provisioned.httpUrl, null);

        const status = yield* vastai.getStatus("77711");
        assert.equal(status.status, "running");
        assert.equal(status.httpUrl, "http://203.0.113.10:45123");
        assert.equal(status.wsUrl, "ws://203.0.113.10:45123/ws/session");
        assert.equal(status.tlsSupported, false);
      }).pipe(Effect.provide(clientLayer)),
    );
  });
});
