import type { Modality, ProviderName, QualityTier } from "@metamorph/shared";
import { Context, Effect, Layer } from "effect";

import { NoCapacityError, ProviderUnavailableError } from "./errors.ts";
import type { HardwareSpec } from "./sizing.ts";

export interface ProvisionRequest {
  readonly instanceId: string;
  readonly userId: string;
  readonly modalities: ReadonlyArray<Modality>;
  readonly quality: QualityTier;
  readonly hardware: HardwareSpec;
  readonly env: Readonly<Record<string, string>>;
}

export interface ProvisionedInstance {
  readonly provider: ProviderName;
  readonly providerInstanceId: string;
  readonly gpuType: string;
  readonly hourlyRateUsd: number | null;
  readonly httpUrl: string | null;
  readonly wsUrl: string | null;
  readonly tlsSupported: boolean;
}

export interface ProviderInstanceStatus {
  readonly status: "provisioning" | "running" | "stopped" | "terminated" | "failed";
  readonly httpUrl: string | null;
  readonly wsUrl: string | null;
  readonly tlsSupported: boolean;
  readonly reason?: string | undefined;
}

export interface ManagedProviderInstance {
  readonly provider: ProviderName;
  readonly providerInstanceId: string;
  readonly instanceId: string | null;
  readonly status: "provisioning" | "running" | "stopped" | "terminated" | "failed";
  readonly createdAtMs: number | null;
}

export interface GpuProvider {
  readonly name: ProviderName;
  readonly provision: (
    request: ProvisionRequest,
  ) => Effect.Effect<ProvisionedInstance, NoCapacityError | ProviderUnavailableError>;
  readonly getStatus: (
    providerInstanceId: string,
  ) => Effect.Effect<ProviderInstanceStatus, ProviderUnavailableError>;
  readonly terminate: (providerInstanceId: string) => Effect.Effect<void, ProviderUnavailableError>;
  readonly listManaged: Effect.Effect<
    ReadonlyArray<ManagedProviderInstance>,
    ProviderUnavailableError
  >;
}

export interface ProviderRegistryShape {
  readonly list: () => ReadonlyArray<GpuProvider>;
  readonly get: (name: ProviderName) => GpuProvider | undefined;
  readonly provisionWithFailover: (
    request: ProvisionRequest,
    preferredProvider?: ProviderName,
  ) => Effect.Effect<ProvisionedInstance, NoCapacityError | ProviderUnavailableError>;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "@metamorph/orchestrator/ProviderRegistry",
) {
  static readonly layerFrom = (providers: ReadonlyArray<GpuProvider>) =>
    Layer.succeed(ProviderRegistry, makeProviderRegistry(providers));
}

export function makeProviderRegistry(providers: ReadonlyArray<GpuProvider>): ProviderRegistryShape {
  const byName = new Map<ProviderName, GpuProvider>();
  for (const provider of providers) {
    byName.set(provider.name, provider);
  }

  return ProviderRegistry.of({
    list: () => providers,
    get: (name) => byName.get(name),
    provisionWithFailover: Effect.fn("ProviderRegistry.provisionWithFailover")(function* (
      request: ProvisionRequest,
      preferredProvider?: ProviderName,
    ) {
      if (preferredProvider !== undefined) {
        const provider = byName.get(preferredProvider);
        if (!provider) {
          return yield* new ProviderUnavailableError({
            provider: preferredProvider,
            message: `Requested GPU provider '${preferredProvider}' is not configured.`,
            retryable: false,
          });
        }
        return yield* provider.provision(request);
      }

      if (providers.length === 0) {
        return yield* new NoCapacityError({
          modalities: [...request.modalities],
          quality: request.quality,
          attemptedProviders: [],
          message: "No GPU providers are configured.",
        });
      }

      const attempted: Array<string> = [];
      let lastFailure: NoCapacityError | ProviderUnavailableError | undefined;

      for (const provider of providers) {
        attempted.push(provider.name);
        const attempt = yield* Effect.result(provider.provision(request));
        if (attempt._tag === "Success") {
          return attempt.success;
        }
        const err = attempt.failure;
        lastFailure = err;
        if (err._tag === "ProviderUnavailableError" && !err.retryable) {
          yield* Effect.logWarning(
            `Provider '${provider.name}' failed non-retryably; failing over if another provider exists`,
            err.message,
          );
        }
      }

      return yield* new NoCapacityError({
        modalities: [...request.modalities],
        quality: request.quality,
        attemptedProviders: attempted,
        message:
          lastFailure?.message ??
          `No GPU capacity available across providers: ${attempted.join(", ")}`,
      });
    }),
  });
}
