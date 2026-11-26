import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { NoCapacityError, ProviderUnavailableError } from "../errors.ts";
import type {
  GpuProvider,
  ManagedProviderInstance,
  ProviderInstanceStatus,
  ProvisionRequest,
  ProvisionedInstance,
} from "../provider.ts";

export interface RunPodConfig {
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly cloud?: "SECURE" | "COMMUNITY" | undefined;
  readonly dataCenterIds?: ReadonlyArray<string> | undefined;
  readonly networkVolumeId?: string | undefined;
}

const RunPodGpuInfo = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.Int),
});

const RunPodPod = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  desiredStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
  runtimeStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
  runtimeStatusReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  costPerHr: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  createdAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  gpu: Schema.optionalKey(Schema.NullOr(RunPodGpuInfo)),
});

const RunPodListResponse = Schema.Union([
  Schema.Array(RunPodPod),
  Schema.Struct({ pods: Schema.Array(RunPodPod) }),
]);

const decodeRunPodPod = Schema.decodeUnknownEffect(RunPodPod);
const decodeRunPodList = Schema.decodeUnknownEffect(RunPodListResponse);

const METAMORPH_NAME_PREFIX = "metamorph-";

const mapRunPodStatus = (pod: typeof RunPodPod.Type): ProviderInstanceStatus["status"] => {
  const rt = pod.runtimeStatus?.toLowerCase();
  if (rt === "running") return "running";
  if (rt === "initializing") return "provisioning";
  if (rt === "stopped") return "stopped";
  if (rt === "terminated") return "terminated";

  const desired = pod.desiredStatus?.toUpperCase();
  if (desired === "TERMINATED") return "terminated";
  if (desired === "EXITED" || desired === "STOPPED") return "stopped";
  return "provisioning";
};

const runpodProxyUrls = (podId: string) => ({
  httpUrl: `https://${podId}-8000.proxy.runpod.net`,
  wsUrl: `wss://${podId}-8000.proxy.runpod.net/ws/session`,
});

const extractInstanceIdFromName = (name: string | null | undefined): string | null => {
  if (!name || !name.startsWith(METAMORPH_NAME_PREFIX)) return null;
  const suffix = name.slice(METAMORPH_NAME_PREFIX.length).trim();
  return suffix === "" ? null : suffix;
};

/** Builds a RunPod REST v2 `GpuProvider` using the provided Effect `HttpClient`. */
export const makeRunPodProvider = Effect.fn("makeRunPodProvider")(function* (config: RunPodConfig) {
  const baseUrl = (config.baseUrl ?? "https://api.runpod.io/v2").replace(/\/+$/, "");
  const baseClient = yield* HttpClient.HttpClient;
  const client = baseClient.pipe(
    HttpClient.mapRequest((req) =>
      req.pipe(
        HttpClientRequest.prependUrl(baseUrl),
        HttpClientRequest.bearerToken(config.apiKey),
        HttpClientRequest.acceptJson,
      ),
    ),
  );

  const provision: GpuProvider["provision"] = Effect.fn("RunPodProvider.provision")(function* (
    request: ProvisionRequest,
  ) {
    const gpuCandidates = request.hardware.runpodGpuIds;
    if (gpuCandidates.length === 0) {
      return yield* new NoCapacityError({
        modalities: [...request.modalities],
        quality: request.quality,
        attemptedProviders: ["runpod"],
        message: "No RunPod GPU candidates configured for requested profile.",
      });
    }

    let lastCapacityMessage = "No RunPod GPU capacity available.";
    for (const gpuId of gpuCandidates) {
      const body: Record<string, unknown> = {
        name: `${METAMORPH_NAME_PREFIX}${request.instanceId}`,
        image: request.hardware.image,
        disk: request.hardware.diskGb,
        cloud: config.cloud ?? "SECURE",
        gpu: {
          id: gpuId,
          count: 1,
          minCudaVersion: request.hardware.minCudaVersion,
        },
        ports: ["8000/http"],
        env: request.env,
      };
      if (config.dataCenterIds && config.dataCenterIds.length > 0) {
        body["dataCenterIds"] = [...config.dataCenterIds];
      }
      if (config.networkVolumeId) {
        body["networkVolumes"] = [config.networkVolumeId];
      }

      const response = yield* HttpClientRequest.post("/pods").pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
        client.execute,
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "runpod",
              message: `RunPod POST /pods transport failed: ${cause.message}`,
              retryable: true,
              cause,
            }),
        ),
      );

      if (response.status === 401 || response.status === 403) {
        return yield* new ProviderUnavailableError({
          provider: "runpod",
          message: `RunPod authentication failed with HTTP ${response.status}`,
          retryable: false,
        });
      }

      if (
        response.status === 404 ||
        response.status === 409 ||
        response.status === 422 ||
        response.status === 400
      ) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        lastCapacityMessage = `RunPod declined GPU '${gpuId}' (HTTP ${response.status}): ${text}`;
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* new ProviderUnavailableError({
          provider: "runpod",
          message: `RunPod API unavailable (HTTP ${response.status}): ${text}`,
          retryable: true,
        });
      }

      const json = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "runpod",
              message: "Invalid JSON response from RunPod POST /pods",
              retryable: true,
              cause,
            }),
        ),
      );

      const pod = yield* decodeRunPodPod(json).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "runpod",
              message: `Unexpected RunPod pod payload: ${cause.message}`,
              retryable: false,
              cause,
            }),
        ),
      );

      const urls = runpodProxyUrls(pod.id);
      const result: ProvisionedInstance = {
        provider: "runpod",
        providerInstanceId: pod.id,
        gpuType: pod.gpu?.id ?? gpuId,
        hourlyRateUsd: pod.costPerHr ?? null,
        httpUrl: urls.httpUrl,
        wsUrl: urls.wsUrl,
        tlsSupported: true,
      };
      return result;
    }

    return yield* new NoCapacityError({
      modalities: [...request.modalities],
      quality: request.quality,
      attemptedProviders: ["runpod"],
      message: lastCapacityMessage,
    });
  });

  const getStatus: GpuProvider["getStatus"] = Effect.fn("RunPodProvider.getStatus")(function* (
    providerInstanceId: string,
  ) {
    const response = yield* client.get(`/pods/${encodeURIComponent(providerInstanceId)}`).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "runpod",
            message: `RunPod GET /pods/${providerInstanceId} failed: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );

    if (response.status === 404) {
      return {
        status: "terminated" as const,
        httpUrl: null,
        wsUrl: null,
        tlsSupported: true,
        reason: "not_found",
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* new ProviderUnavailableError({
        provider: "runpod",
        message: `RunPod GET /pods/${providerInstanceId} returned HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const pod = yield* HttpClientResponse.schemaBodyJson(RunPodPod)(response).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "runpod",
            message: `Invalid RunPod pod status payload: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );

    const status = mapRunPodStatus(pod);
    const urls = runpodProxyUrls(pod.id);
    return {
      status,
      httpUrl: status === "terminated" ? null : urls.httpUrl,
      wsUrl: status === "terminated" ? null : urls.wsUrl,
      tlsSupported: true,
      reason: pod.runtimeStatusReason ?? undefined,
    };
  });

  const terminate: GpuProvider["terminate"] = Effect.fn("RunPodProvider.terminate")(function* (
    providerInstanceId: string,
  ) {
    const response = yield* client.del(`/pods/${encodeURIComponent(providerInstanceId)}`).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "runpod",
            message: `RunPod DELETE /pods/${providerInstanceId} failed: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );

    if (response.status === 404 || (response.status >= 200 && response.status < 300)) {
      return;
    }

    return yield* new ProviderUnavailableError({
      provider: "runpod",
      message: `RunPod DELETE /pods/${providerInstanceId} returned HTTP ${response.status}`,
      retryable: response.status === 429 || response.status >= 500,
    });
  });

  const listManaged: GpuProvider["listManaged"] = Effect.fn("RunPodProvider.listManaged")(
    function* () {
      const response = yield* client.get("/pods").pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "runpod",
              message: `RunPod GET /pods failed: ${cause.message}`,
              retryable: true,
              cause,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new ProviderUnavailableError({
          provider: "runpod",
          message: `RunPod GET /pods returned HTTP ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      const rawJson = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "runpod",
              message: `Invalid JSON from RunPod GET /pods: ${cause.message}`,
              retryable: true,
              cause,
            }),
        ),
      );
      const parsed = yield* decodeRunPodList(rawJson).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "runpod",
              message: `Unexpected RunPod list schema: ${cause.message}`,
              retryable: false,
              cause,
            }),
        ),
      );

      const pods = "pods" in parsed ? parsed.pods : parsed;
      const managed: Array<ManagedProviderInstance> = [];
      for (const pod of pods) {
        const instanceId = extractInstanceIdFromName(pod.name);
        if (instanceId === null) continue;
        const createdAtMs =
          pod.createdAt && !Number.isNaN(Date.parse(pod.createdAt))
            ? Date.parse(pod.createdAt)
            : null;
        managed.push({
          provider: "runpod",
          providerInstanceId: pod.id,
          instanceId,
          status: mapRunPodStatus(pod),
          createdAtMs,
        });
      }
      return managed;
    },
  );

  const provider: GpuProvider = {
    name: "runpod",
    provision,
    getStatus,
    terminate,
    listManaged,
  };
  return provider;
});
