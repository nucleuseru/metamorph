import {
  EngineOrchestrator,
  assertSessionControllable,
  type EngineInstanceRecord,
} from "@metamorph/orchestrator";
import {
  TERMINAL_SESSION_STATUSES,
  type AudioStartConfig,
  type VideoStartConfig,
} from "@metamorph/shared";
import { Config, Effect } from "effect";

import {
  BadGateway,
  Conflict,
  Forbidden,
  NotFound,
  UnprocessableEntity,
  type SessionDetailResponse,
} from "../../api/index.ts";
import { AssetRepository } from "../../repositories/index.ts";
import { EngineTokenService } from "../../services/engine-tokens.ts";
import { ObjectStorage } from "../../services/storage.ts";
import { assertOwnedAsset } from "../helpers.ts";

const toWsBaseUrl = (httpBase: string): string =>
  httpBase.replace(/\/+$/, "").replace(/^http(s?):\/\//i, "ws$1://");

const mapOrchestratorAccessError = (err: {
  readonly _tag: string;
  readonly message?: string;
  readonly instanceId?: string;
}) => {
  if (err._tag === "InstanceNotFoundError") {
    return new NotFound({ message: `Session '${err.instanceId ?? "unknown"}' not found.` });
  }
  return new Conflict({ message: err.message ?? "Session is not ready." });
};

export const mapEngineClientError = (err: {
  readonly status?: number | undefined;
  readonly message: string;
}) => {
  if (err.status === 403) return new Forbidden({ message: err.message });
  if (err.status === 422) return new UnprocessableEntity({ message: err.message });
  if (err.status === 503) return new Conflict({ message: err.message });
  return new BadGateway({ message: err.message });
};

export const makeSessionHelpers = Effect.gen(function* () {
  const orchestrator = yield* EngineOrchestrator;
  const tokenService = yield* EngineTokenService;
  const assets = yield* AssetRepository;
  const storage = yield* ObjectStorage;

  const apiPublicBase = yield* Config.String("API_PUBLIC_URL").pipe(
    Config.orElse(() => Config.String("BETTER_AUTH_URL")),
    Config.withDefault("http://localhost:3001"),
  );
  const wsRelayBase = toWsBaseUrl(apiPublicBase);

  const resolveSignedAssetUrl = Effect.fnUntraced(function* (
    userId: string,
    assetId: string | null | undefined,
    expectedKind: "ref_image" | "ref_audio",
  ) {
    if (!assetId) return null;
    const found = yield* assertOwnedAsset(assets, userId, assetId, expectedKind);
    return yield* storage
      .getSignedDownloadUrl({ assetId: found.id, storageKey: found.storageKey })
      .pipe(Effect.orDie);
  });

  const resolveOptionalSignedUrl = (
    assetId: string | null,
    userId: string,
    explicitUrl: string | null | undefined,
  ) => {
    if (explicitUrl !== undefined) return Effect.succeed(explicitUrl);
    if (!assetId) return Effect.succeed(null);
    return assets.getByIdForUser(assetId, userId).pipe(
      Effect.flatMap((a) =>
        a
          ? storage.getSignedDownloadUrl({ assetId: a.id, storageKey: a.storageKey })
          : Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    );
  };

  const getOwnedSession = (sessionId: string, userId: string) =>
    orchestrator.getSessionForUser(sessionId, userId).pipe(
      Effect.catchTags({
        InstanceNotFoundError: (err) =>
          Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
        StoreError: (err) => Effect.die(err),
      }),
    );

  const getControllableSession = (sessionId: string, userId: string) =>
    getOwnedSession(sessionId, userId).pipe(
      Effect.flatMap((record) =>
        assertSessionControllable(record).pipe(Effect.mapError(mapOrchestratorAccessError)),
      ),
    );

  const formatSession = Effect.fnUntraced(function* (
    record: EngineInstanceRecord,
    options?: {
      readonly includeToken?: boolean | undefined;
      readonly video?: VideoStartConfig | null | undefined;
      readonly audio?: AudioStartConfig | null | undefined;
      readonly explicitRefImageUrl?: string | null | undefined;
      readonly explicitRefAudioUrl?: string | null | undefined;
    },
  ): Effect.fn.Return<SessionDetailResponse> {
    const [refImageUrl, refAudioUrl] = yield* Effect.all([
      resolveOptionalSignedUrl(record.refImageAssetId, record.userId, options?.explicitRefImageUrl),
      resolveOptionalSignedUrl(record.refAudioAssetId, record.userId, options?.explicitRefAudioUrl),
    ]);

    const shouldMintToken =
      options?.includeToken !== false && !TERMINAL_SESSION_STATUSES.has(record.status);
    const minted = shouldMintToken
      ? yield* tokenService
          .mintSessionToken({
            userId: record.userId,
            instanceId: record.id,
            modalities: record.modalities,
          })
          .pipe(Effect.orElseSucceed(() => null))
      : null;

    const relayWsUrl = `${wsRelayBase}/sessions/${encodeURIComponent(record.id)}/ws`;
    const mode = record.tlsSupported && record.wsUrl ? ("direct" as const) : ("relay" as const);
    const effectiveWsUrl = mode === "direct" ? record.wsUrl : relayWsUrl;

    return {
      id: record.id,
      userId: record.userId,
      personaId: record.personaId,
      status: record.status,
      modalities: [...record.modalities],
      quality: record.quality,
      provider: record.provider,
      gpuType: record.gpuType,
      image: record.image,
      hourlyRateUsd: record.hourlyRateUsd,
      idleTimeoutS: record.idleTimeoutS,
      disconnectTimeoutS: record.disconnectTimeoutS,
      maxDurationS: record.maxDurationS,
      failureReason: record.failureReason,
      activeSeconds: record.activeSeconds,
      estimatedCostUsd: record.estimatedCostUsd,
      readyAt: record.readyAt ? record.readyAt.toISOString() : null,
      connectedAt: record.connectedAt ? record.connectedAt.toISOString() : null,
      disconnectedAt: record.disconnectedAt ? record.disconnectedAt.toISOString() : null,
      endedAt: record.endedAt ? record.endedAt.toISOString() : null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      connection: {
        mode,
        wsUrl: effectiveWsUrl,
        directWsUrl: record.wsUrl,
        relayWsUrl,
        httpUrl: record.httpUrl,
        tlsSupported: record.tlsSupported,
        token: minted?.token ?? null,
        tokenExpiresAt: minted?.expiresAt ?? null,
      },
      initialConfig: {
        prompt: record.initialPrompt,
        refImageUrl,
        refAudioUrl,
        video: options?.video ?? null,
        audio: options?.audio ?? null,
      },
    };
  });

  const mintShortLivedToken = (userId: string, record: EngineInstanceRecord) =>
    tokenService
      .mintSessionToken({
        userId,
        instanceId: record.id,
        modalities: record.modalities,
        ttlSeconds: 120,
      })
      .pipe(Effect.orDie);

  return {
    resolveSignedAssetUrl,
    getOwnedSession,
    getControllableSession,
    formatSession,
    mintShortLivedToken,
  };
});

export type SessionHelpers = Effect.Success<typeof makeSessionHelpers>;
