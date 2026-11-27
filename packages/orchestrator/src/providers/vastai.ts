import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { NoCapacityError, ProviderUnavailableError } from "../errors.ts";
import type {
  GpuProvider,
  ManagedProviderInstance,
  ProviderInstanceStatus,
  ProvisionRequest,
  ProvisionedInstance,
} from "../provider.ts";

export interface VastAiConfig {
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly maxPricePerHrUsd?: number | undefined;
  readonly minReliability?: number | undefined;
  readonly verifiedOnly?: boolean | undefined;
  /** Optional HTTPS/WSS reverse proxy base URL if Vast instances sit behind a TLS gateway. */
  readonly tlsProxyBaseUrl?: string | undefined;
}

const VastOffer = Schema.Struct({
  id: Schema.Int,
  gpu_name: Schema.optionalKey(Schema.String),
  gpu_ram: Schema.optionalKey(Schema.Finite),
  dph_total: Schema.optionalKey(Schema.Finite),
});

const VastSearchResponse = Schema.Struct({
  offers: Schema.Array(VastOffer),
});

const VastCreateResponse = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  new_contract: Schema.Int,
});

const VastPortMapping = Schema.Struct({
  HostIp: Schema.optionalKey(Schema.String),
  HostPort: Schema.Union([Schema.String, Schema.Int]),
});

const VastInstance = Schema.Struct({
  id: Schema.Int,
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  actual_status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  public_ipaddr: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dph_total: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  start_date: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  ports: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Array(VastPortMapping))),
  ),
});

const VastShowInstanceResponse = Schema.Union([
  VastInstance,
  Schema.Struct({ instances: VastInstance }),
]);

const VastListInstancesResponse = Schema.Struct({
  instances: Schema.Array(VastInstance),
});

const decodeVastSearch = Schema.decodeUnknownEffect(VastSearchResponse);
const decodeVastCreate = Schema.decodeUnknownEffect(VastCreateResponse);
const decodeVastShow = Schema.decodeUnknownEffect(VastShowInstanceResponse);
const decodeVastList = Schema.decodeUnknownEffect(VastListInstancesResponse);

const METAMORPH_LABEL_PREFIX = "metamorph-";

const mapVastStatus = (rawStatus: string | null | undefined): ProviderInstanceStatus["status"] => {
  const s = rawStatus?.toLowerCase();
  if (s === "running") return "running";
  if (s === "stopped") return "stopped";
  if (s === "exited" || s === "offline" || s === "unknown") return "failed";
  return "provisioning";
};

const extractVastEndpoints = (
  inst: typeof VastInstance.Type,
  tlsProxyBaseUrl: string | undefined,
): {
  readonly httpUrl: string | null;
  readonly wsUrl: string | null;
  readonly tlsSupported: boolean;
} => {
  if (tlsProxyBaseUrl) {
    const cleanBase = tlsProxyBaseUrl.replace(/\/+$/, "");
    const wsBase = cleanBase.replace(/^http(s?):\/\//i, "ws$1://");
    return {
      httpUrl: `${cleanBase}/${inst.id}`,
      wsUrl: `${wsBase}/${inst.id}/ws/session`,
      tlsSupported: true,
    };
  }
  const ip = inst.public_ipaddr?.trim();
  const portEntry = inst.ports?.["8000/tcp"]?.[0];
  if (!ip || !portEntry) {
    return { httpUrl: null, wsUrl: null, tlsSupported: false };
  }
  const hostPort = String(portEntry.HostPort);
  return {
    httpUrl: `http://${ip}:${hostPort}`,
    wsUrl: `ws://${ip}:${hostPort}/ws/session`,
    tlsSupported: false,
  };
};

const extractInstanceIdFromLabel = (label: string | null | undefined): string | null => {
  if (!label || !label.startsWith(METAMORPH_LABEL_PREFIX)) return null;
  const suffix = label.slice(METAMORPH_LABEL_PREFIX.length).trim();
  return suffix === "" ? null : suffix;
};

/** Builds a Vast.ai REST v0 `GpuProvider` using the provided Effect `HttpClient`. */
export const makeVastAiProvider = Effect.fn("makeVastAiProvider")(function* (config: VastAiConfig) {
  const baseUrl = (config.baseUrl ?? "https://console.vast.ai/api/v0").replace(/\/+$/, "");
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

  const provision: GpuProvider["provision"] = Effect.fn("VastAiProvider.provision")(function* (
    request: ProvisionRequest,
  ) {
    const searchQuery: Record<string, unknown> = {
      limit: 20,
      type: "on-demand",
      order: [["dph_total", "asc"]],
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_ram: { gte: request.hardware.minVramGb * 1000 },
      cuda_max_good: { gte: Number(request.hardware.minCudaVersion) },
      direct_port_count: { gte: 1 },
      disk_space: { gte: request.hardware.diskGb },
      reliability: { gte: config.minReliability ?? 0.95 },
    };
    if (config.verifiedOnly ?? true) {
      searchQuery["verified"] = { eq: true };
    }
    if (config.maxPricePerHrUsd !== undefined) {
      searchQuery["dph_total"] = { lte: config.maxPricePerHrUsd };
    }

    const searchResp = yield* HttpClientRequest.post("/bundles/").pipe(
      HttpClientRequest.bodyJsonUnsafe(searchQuery),
      client.execute,
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Vast.ai POST /bundles/ failed: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );

    if (searchResp.status === 401 || searchResp.status === 403) {
      return yield* new ProviderUnavailableError({
        provider: "vastai",
        message: `Vast.ai authentication failed with HTTP ${searchResp.status}`,
        retryable: false,
      });
    }
    if (searchResp.status < 200 || searchResp.status >= 300) {
      return yield* new ProviderUnavailableError({
        provider: "vastai",
        message: `Vast.ai POST /bundles/ returned HTTP ${searchResp.status}`,
        retryable: searchResp.status === 429 || searchResp.status >= 500,
      });
    }

    const searchJson = yield* searchResp.json.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Invalid Vast.ai bundles JSON: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );
    const searchData = yield* decodeVastSearch(searchJson).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Unexpected Vast.ai bundles schema: ${cause.message}`,
            retryable: false,
            cause,
          }),
      ),
    );

    if (searchData.offers.length === 0) {
      return yield* new NoCapacityError({
        modalities: [...request.modalities],
        quality: request.quality,
        attemptedProviders: ["vastai"],
        message: `No Vast.ai offers found with >=${request.hardware.minVramGb}GB VRAM and CUDA >=${request.hardware.minCudaVersion}.`,
      });
    }

    const envMap: Record<string, string> = {
      "-p 8000:8000": "1",
      ...request.env,
    };

    let lastMsg = "Failed to rent any Vast.ai offer.";
    for (const offer of searchData.offers.slice(0, 3)) {
      const createResp = yield* HttpClientRequest.put(`/asks/${offer.id}/`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          image: request.hardware.image,
          disk: request.hardware.diskGb,
          runtype: "args",
          label: `${METAMORPH_LABEL_PREFIX}${request.instanceId}`,
          cancel_unavail: true,
          env: envMap,
        }),
        client.execute,
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "vastai",
              message: `Vast.ai PUT /asks/${offer.id}/ failed: ${cause.message}`,
              retryable: true,
              cause,
            }),
        ),
      );

      if (createResp.status === 400 || createResp.status === 404 || createResp.status === 409) {
        const text = yield* createResp.text.pipe(Effect.orElseSucceed(() => ""));
        lastMsg = `Vast.ai offer ${offer.id} unavailable (HTTP ${createResp.status}): ${text}`;
        continue;
      }

      if (createResp.status < 200 || createResp.status >= 300) {
        return yield* new ProviderUnavailableError({
          provider: "vastai",
          message: `Vast.ai PUT /asks/${offer.id}/ returned HTTP ${createResp.status}`,
          retryable: createResp.status === 429 || createResp.status >= 500,
        });
      }

      const createJson = yield* createResp.json.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "vastai",
              message: `Invalid Vast.ai create JSON: ${cause.message}`,
              retryable: true,
              cause,
            }),
        ),
      );
      const created = yield* decodeVastCreate(createJson).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "vastai",
              message: `Unexpected Vast.ai create response: ${cause.message}`,
              retryable: false,
              cause,
            }),
        ),
      );

      const contractId = String(created.new_contract);
      const result: ProvisionedInstance = {
        provider: "vastai",
        providerInstanceId: contractId,
        gpuType: offer.gpu_name ?? "vastai-gpu",
        hourlyRateUsd: offer.dph_total ?? null,
        httpUrl: config.tlsProxyBaseUrl
          ? `${config.tlsProxyBaseUrl.replace(/\/+$/, "")}/${contractId}`
          : null,
        wsUrl: config.tlsProxyBaseUrl
          ? `${config.tlsProxyBaseUrl.replace(/\/+$/, "").replace(/^http(s?):\/\//i, "ws$1://")}/${contractId}/ws/session`
          : null,
        tlsSupported: Boolean(config.tlsProxyBaseUrl),
      };
      return result;
    }

    return yield* new NoCapacityError({
      modalities: [...request.modalities],
      quality: request.quality,
      attemptedProviders: ["vastai"],
      message: lastMsg,
    });
  });

  const getStatus: GpuProvider["getStatus"] = Effect.fn("VastAiProvider.getStatus")(function* (
    providerInstanceId: string,
  ) {
    const resp = yield* client.get(`/instances/${encodeURIComponent(providerInstanceId)}/`).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Vast.ai GET /instances/${providerInstanceId}/ failed: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );

    if (resp.status === 404) {
      return {
        status: "terminated" as const,
        httpUrl: null,
        wsUrl: null,
        tlsSupported: Boolean(config.tlsProxyBaseUrl),
        reason: "not_found",
      };
    }

    if (resp.status < 200 || resp.status >= 300) {
      return yield* new ProviderUnavailableError({
        provider: "vastai",
        message: `Vast.ai GET /instances/${providerInstanceId}/ returned HTTP ${resp.status}`,
        retryable: resp.status === 429 || resp.status >= 500,
      });
    }

    const json = yield* resp.json.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Invalid Vast.ai instance JSON: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );
    const parsed = yield* decodeVastShow(json).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Unexpected Vast.ai instance schema: ${cause.message}`,
            retryable: false,
            cause,
          }),
      ),
    );
    const inst = "instances" in parsed ? parsed.instances : parsed;
    const status = mapVastStatus(inst.actual_status);
    const endpoints = extractVastEndpoints(inst, config.tlsProxyBaseUrl);

    return {
      status,
      httpUrl: status === "terminated" ? null : endpoints.httpUrl,
      wsUrl: status === "terminated" ? null : endpoints.wsUrl,
      tlsSupported: endpoints.tlsSupported,
      reason: inst.actual_status ?? undefined,
    };
  });

  const terminate: GpuProvider["terminate"] = Effect.fn("VastAiProvider.terminate")(function* (
    providerInstanceId: string,
  ) {
    const resp = yield* client.del(`/instances/${encodeURIComponent(providerInstanceId)}/`).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Vast.ai DELETE /instances/${providerInstanceId}/ failed: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );
    if (resp.status === 404 || (resp.status >= 200 && resp.status < 300)) {
      return;
    }
    return yield* new ProviderUnavailableError({
      provider: "vastai",
      message: `Vast.ai DELETE /instances/${providerInstanceId}/ returned HTTP ${resp.status}`,
      retryable: resp.status === 429 || resp.status >= 500,
    });
  });

  const listManaged: GpuProvider["listManaged"] = Effect.gen(function* () {
    const resp = yield* client.get("/instances/").pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Vast.ai GET /instances/ failed: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );
    if (resp.status < 200 || resp.status >= 300) {
      return yield* new ProviderUnavailableError({
        provider: "vastai",
        message: `Vast.ai GET /instances/ returned HTTP ${resp.status}`,
        retryable: responseStatusMessage(resp.status),
      });
    }

    const json = yield* resp.json.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Invalid Vast.ai instances list JSON: ${cause.message}`,
            retryable: true,
            cause,
          }),
      ),
    );
    const parsed = yield* decodeVastList(json).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderUnavailableError({
            provider: "vastai",
            message: `Unexpected Vast.ai instances list schema: ${cause.message}`,
            retryable: false,
            cause,
          }),
      ),
    );

    const managed: Array<ManagedProviderInstance> = [];
    for (const inst of parsed.instances) {
      const instanceId = extractInstanceIdFromLabel(inst.label);
      if (instanceId === null) continue;
      managed.push({
        provider: "vastai",
        providerInstanceId: String(inst.id),
        instanceId,
        status: mapVastStatus(inst.actual_status),
        createdAtMs: inst.start_date != null ? Math.round(inst.start_date * 1000) : null,
      });
    }
    return managed;
  }).pipe(Effect.withSpan("VastAiProvider.listManaged"));

  const provider: GpuProvider = {
    name: "vastai",
    provision,
    getStatus,
    terminate,
    listManaged,
  };
  return provider;
});

const responseStatusMessage = (status: number): boolean => status === 429 || status >= 500;
