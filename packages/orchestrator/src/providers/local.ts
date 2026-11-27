import { EngineReadyResponse } from "@metamorph/shared";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { ProviderUnavailableError } from "../errors.ts";
import type { GpuProvider, ProvisionRequest, ProvisionedInstance } from "../provider.ts";

export interface LocalProviderConfig {
  readonly httpUrl?: string | undefined;
  readonly wsUrl?: string | undefined;
  readonly tlsSupported?: boolean | undefined;
  readonly verifyHealthOnProvision?: boolean | undefined;
  readonly gpuType?: string | undefined;
}

const decodeReady = Schema.decodeUnknownEffect(EngineReadyResponse);

const deriveWsUrl = (httpUrl: string): string =>
  `${httpUrl.replace(/\/+$/, "").replace(/^http(s?):\/\//i, "ws$1://")}/ws/session`;

const listManaged: GpuProvider["listManaged"] = Effect.succeed([]);

/**
 * Local/static dev `GpuProvider` targeting a running `apps/engine-py` server
 * (default `http://127.0.0.1:8000`).
 */
export const makeLocalProvider = Effect.fn("makeLocalProvider")(function* (
  config: LocalProviderConfig = {},
) {
  const httpUrl = (config.httpUrl ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const wsUrl = config.wsUrl ?? deriveWsUrl(httpUrl);
  const tlsSupported =
    config.tlsSupported ?? (httpUrl.startsWith("https://") || wsUrl.startsWith("wss://"));
  const gpuType = config.gpuType ?? "local-dev";
  const client = yield* HttpClient.HttpClient;

  const provision: GpuProvider["provision"] = Effect.fn("LocalProvider.provision")(function* (
    request: ProvisionRequest,
  ) {
    if (config.verifyHealthOnProvision) {
      const resp = yield* HttpClientRequest.get(`${httpUrl}/health`).pipe(
        client.execute,
        Effect.mapError(
          (cause) =>
            new ProviderUnavailableError({
              provider: "local",
              message: `Local engine unreachable at ${httpUrl}/health: ${cause.message}`,
              retryable: true,
              cause,
            }),
        ),
      );
      if (resp.status < 200 || resp.status >= 300) {
        return yield* new ProviderUnavailableError({
          provider: "local",
          message: `Local engine /health returned HTTP ${resp.status}`,
          retryable: true,
        });
      }
    }

    const result: ProvisionedInstance = {
      provider: "local",
      providerInstanceId: `local-${request.instanceId}`,
      gpuType,
      hourlyRateUsd: 0,
      httpUrl,
      wsUrl,
      tlsSupported,
    };
    return result;
  });

  const getStatus: GpuProvider["getStatus"] = Effect.fn("LocalProvider.getStatus")(function* () {
    const resp = yield* HttpClientRequest.get(`${httpUrl}/ready`).pipe(
      client.execute,
      Effect.result,
    );
    if (resp._tag === "Failure") {
      return {
        status: "failed" as const,
        httpUrl,
        wsUrl,
        tlsSupported,
        reason: resp.failure.message,
      };
    }

    const raw = yield* resp.success.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = raw !== null ? yield* decodeReady(raw).pipe(Effect.result) : null;
    if (parsed !== null && parsed._tag === "Success") {
      if (parsed.success.status === "shutting_down") {
        return { status: "stopped" as const, httpUrl, wsUrl, tlsSupported };
      }
      if (parsed.success.status === "warming") {
        return { status: "provisioning" as const, httpUrl, wsUrl, tlsSupported };
      }
      return { status: "running" as const, httpUrl, wsUrl, tlsSupported };
    }

    return {
      status: resp.success.status === 200 ? ("running" as const) : ("provisioning" as const),
      httpUrl,
      wsUrl,
      tlsSupported,
    };
  });

  const terminate: GpuProvider["terminate"] = Effect.fn("LocalProvider.terminate")(function* () {
    // Local dev instances are externally managed; engine shutdown is triggered via HTTP.
  });

  const provider: GpuProvider = {
    name: "local",
    provision,
    getStatus,
    terminate,
    listManaged,
  };
  return provider;
});
