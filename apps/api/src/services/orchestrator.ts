import {
  EngineClient,
  EngineOrchestrator,
  OrchestratorConfig,
  OrchestratorEventBus,
  ProviderRegistry,
  makeLocalProvider,
  makeProviderRegistry,
  makeRunPodProvider,
  makeVastAiProvider,
  type GpuProvider,
} from "@metamorph/orchestrator";
import type { ProviderName } from "@metamorph/shared";
import { Config, Effect, Layer, Option, Redacted } from "effect";

const parseCsv = (raw: string): ReadonlyArray<string> =>
  raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");

const cleanOption = (opt: Option.Option<string>): string | undefined => {
  if (Option.isNone(opt)) return undefined;
  const trimmed = opt.value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Wraps `OrchestratorConfig.layer` so `webhookBaseUrl` defaults to `API_PUBLIC_URL`
 * or `BETTER_AUTH_URL` when `ORCHESTRATOR_WEBHOOK_BASE_URL` is unset.
 */
const AppOrchestratorConfigLayer = Layer.effect(
  OrchestratorConfig,
  Effect.gen(function* () {
    const base = yield* OrchestratorConfig;
    if (base.webhookBaseUrl) {
      return base;
    }
    const apiPublicUrlOpt = yield* Config.option(Config.String("API_PUBLIC_URL"));
    const betterAuthUrlOpt = yield* Config.option(Config.String("BETTER_AUTH_URL"));
    const fallback = (cleanOption(apiPublicUrlOpt) ?? cleanOption(betterAuthUrlOpt))?.replace(
      /\/+$/,
      "",
    );
    return OrchestratorConfig.of({
      ...base,
      webhookBaseUrl: fallback,
    });
  }),
).pipe(Layer.provide(OrchestratorConfig.layer));

/** Builds the ordered `ProviderRegistry` from environment configuration. */
const AppProviderRegistryLayer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const orderRaw = yield* Config.String("ORCHESTRATOR_PROVIDERS").pipe(
      Config.withDefault("runpod,vastai,local"),
    );
    const runpodKeyOpt = yield* Config.option(Config.Redacted("RUNPOD_API_KEY"));
    const runpodBaseOpt = yield* Config.option(Config.String("RUNPOD_API_URL"));
    const runpodCloud = yield* Config.String("RUNPOD_CLOUD_TYPE").pipe(
      Config.withDefault("SECURE"),
    );
    const runpodDcOpt = yield* Config.option(Config.String("RUNPOD_DATA_CENTER_IDS"));
    const runpodVolOpt = yield* Config.option(Config.String("RUNPOD_NETWORK_VOLUME_ID"));

    const vastKeyOpt = yield* Config.option(Config.Redacted("VASTAI_API_KEY"));
    const vastBaseOpt = yield* Config.option(Config.String("VASTAI_API_URL"));
    const vastMaxPriceOpt = yield* Config.option(Config.Number("VASTAI_MAX_PRICE_PER_HR"));
    const vastTlsProxyOpt = yield* Config.option(Config.String("VASTAI_TLS_PROXY_BASE_URL"));

    const localHttpUrl = yield* Config.String("LOCAL_ENGINE_URL").pipe(
      Config.withDefault("http://127.0.0.1:8000"),
    );
    const localWsUrlOpt = yield* Config.option(Config.String("LOCAL_ENGINE_WS_URL"));
    const localVerifyHealth = yield* Config.Boolean("LOCAL_ENGINE_VERIFY_HEALTH").pipe(
      Config.withDefault(false),
    );

    const providers: Array<GpuProvider> = [];
    const seen = new Set<ProviderName>();

    for (const token of parseCsv(orderRaw)) {
      if (token === "runpod" && !seen.has("runpod")) {
        if (Option.isSome(runpodKeyOpt) && Redacted.value(runpodKeyOpt.value).trim() !== "") {
          const dcRaw = cleanOption(runpodDcOpt);
          const provider = yield* makeRunPodProvider({
            apiKey: Redacted.value(runpodKeyOpt.value).trim(),
            baseUrl: cleanOption(runpodBaseOpt),
            cloud: runpodCloud === "COMMUNITY" ? "COMMUNITY" : "SECURE",
            dataCenterIds: dcRaw
              ? dcRaw
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
            networkVolumeId: cleanOption(runpodVolOpt),
          });
          providers.push(provider);
          seen.add("runpod");
        }
      } else if (token === "vastai" && !seen.has("vastai")) {
        if (Option.isSome(vastKeyOpt) && Redacted.value(vastKeyOpt.value).trim() !== "") {
          const provider = yield* makeVastAiProvider({
            apiKey: Redacted.value(vastKeyOpt.value).trim(),
            baseUrl: cleanOption(vastBaseOpt),
            maxPricePerHrUsd: Option.getOrUndefined(vastMaxPriceOpt),
            tlsProxyBaseUrl: cleanOption(vastTlsProxyOpt),
          });
          providers.push(provider);
          seen.add("vastai");
        }
      } else if (token === "local" && !seen.has("local")) {
        const provider = yield* makeLocalProvider({
          httpUrl: localHttpUrl,
          wsUrl: cleanOption(localWsUrlOpt),
          verifyHealthOnProvision: localVerifyHealth,
        });
        providers.push(provider);
        seen.add("local");
      }
    }

    return makeProviderRegistry(providers);
  }),
);

/** Composed orchestrator layer requiring `InstanceStore`, `HttpClient`, and `Mac`. */
export const AppOrchestratorLayer = EngineOrchestrator.layer.pipe(
  Layer.provideMerge(AppOrchestratorConfigLayer),
  Layer.provideMerge(AppProviderRegistryLayer),
  Layer.provideMerge(EngineClient.layer),
  Layer.provideMerge(OrchestratorEventBus.layer),
);
