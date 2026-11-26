import {
  EngineClient,
  EngineOrchestrator,
  OrchestratorConfig,
  OrchestratorEventBus,
  assertSessionControllable,
  toStatusEvent,
  type EngineInstanceRecord,
} from "@metamorph/orchestrator";
import {
  TERMINAL_SESSION_STATUSES,
  type AudioStartConfig,
  type Modality,
  type SessionConfigPatch,
  type SessionEvent,
  type VideoStartConfig,
} from "@metamorph/shared";
import { Config, Effect, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import {
  Api,
  BadGateway,
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  PayloadTooLarge,
  ServiceUnavailable,
  UnprocessableEntity,
  type SessionDetailResponse,
} from "../api.ts";
import { CurrentSession } from "../middleware/auth.ts";
import { EngineTokenService } from "../services/engine-tokens.ts";
import { AssetRepository, PersonaRepository, UsageRepository } from "../services/repositories.ts";
import { ObjectStorage } from "../services/storage.ts";

const MAX_REF_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REF_AUDIO_BYTES = 25 * 1024 * 1024;

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

const mapEngineClientError = (err: {
  readonly status?: number | undefined;
  readonly message: string;
}) => {
  if (err.status === 403) return new Forbidden({ message: err.message });
  if (err.status === 422) return new UnprocessableEntity({ message: err.message });
  if (err.status === 503) return new Conflict({ message: err.message });
  return new BadGateway({ message: err.message });
};

export const SessionsHandlers = HttpApiBuilder.group(
  Api,
  "sessions",
  Effect.fn(function* (handlers) {
    const orchestratorConfig = yield* OrchestratorConfig;
    const orchestrator = yield* EngineOrchestrator;
    const engineClient = yield* EngineClient;
    const eventBus = yield* OrchestratorEventBus;
    const tokenService = yield* EngineTokenService;
    const assets = yield* AssetRepository;
    const personas = yield* PersonaRepository;
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
      const found = yield* assets.getByIdForUser(assetId, userId).pipe(Effect.orDie);
      if (!found) {
        return yield* new NotFound({
          message: `Referenced ${expectedKind} asset '${assetId}' not found.`,
        });
      }
      if (found.kind !== expectedKind) {
        return yield* new UnprocessableEntity({
          message: `Asset '${assetId}' has kind '${found.kind}', expected '${expectedKind}'.`,
        });
      }
      return yield* storage
        .getSignedDownloadUrl({ assetId: found.id, storageKey: found.storageKey })
        .pipe(Effect.orDie);
    });

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
        options?.explicitRefImageUrl !== undefined
          ? Effect.succeed(options.explicitRefImageUrl)
          : record.refImageAssetId
            ? assets.getByIdForUser(record.refImageAssetId, record.userId).pipe(
                Effect.flatMap((a) =>
                  a
                    ? storage.getSignedDownloadUrl({ assetId: a.id, storageKey: a.storageKey })
                    : Effect.succeed(null),
                ),
                Effect.orElseSucceed(() => null),
              )
            : Effect.succeed(null),
        options?.explicitRefAudioUrl !== undefined
          ? Effect.succeed(options.explicitRefAudioUrl)
          : record.refAudioAssetId
            ? assets.getByIdForUser(record.refAudioAssetId, record.userId).pipe(
                Effect.flatMap((a) =>
                  a
                    ? storage.getSignedDownloadUrl({ assetId: a.id, storageKey: a.storageKey })
                    : Effect.succeed(null),
                ),
                Effect.orElseSucceed(() => null),
              )
            : Effect.succeed(null),
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

    return handlers.handleAll({
      create: ({ payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;

          if (
            (payload.providerOverride !== undefined || payload.gpuTypeOverride !== undefined) &&
            !orchestratorConfig.allowOverrides
          ) {
            return yield* new Forbidden({
              message: "Provider and GPU overrides are disabled on this server.",
            });
          }

          const personaRecord = payload.personaId
            ? yield* personas.getByIdForUser(payload.personaId, user.id).pipe(Effect.orDie)
            : null;
          if (payload.personaId && !personaRecord) {
            return yield* new NotFound({
              message: `Persona '${payload.personaId}' not found.`,
            });
          }

          const resolvedModalities: ReadonlyArray<Modality> = payload.modalities ??
            personaRecord?.modalities ?? ["voice", "video"];
          if (resolvedModalities.length === 0) {
            return yield* new BadRequest({
              message: "At least one modality ('voice' or 'video') must be enabled.",
            });
          }

          const refImageAssetId =
            payload.refImageUrl !== undefined
              ? null
              : (payload.refImageAssetId ?? personaRecord?.refImageAssetId ?? null);
          const refAudioAssetId =
            payload.refAudioUrl !== undefined
              ? null
              : (payload.refAudioAssetId ?? personaRecord?.refAudioAssetId ?? null);

          const [signedImgUrl, signedAudUrl] = yield* Effect.all([
            resolveSignedAssetUrl(user.id, refImageAssetId, "ref_image"),
            resolveSignedAssetUrl(user.id, refAudioAssetId, "ref_audio"),
          ]);

          const initialRefImageUrl = payload.refImageUrl ?? signedImgUrl;
          const initialRefAudioUrl = payload.refAudioUrl ?? signedAudUrl;
          const initialPrompt = payload.prompt ?? personaRecord?.prompt ?? null;

          const record = yield* orchestrator
            .provisionSession({
              userId: user.id,
              modalities: resolvedModalities,
              quality: payload.quality ?? "standard",
              personaId: personaRecord?.id ?? null,
              initialPrompt,
              initialRefImageUrl,
              initialRefAudioUrl,
              refImageAssetId,
              refAudioAssetId,
              jwtPublicKeyPem: tokenService.publicKeyPem,
              providerOverride: payload.providerOverride,
              gpuTypeOverride: payload.gpuTypeOverride,
            })
            .pipe(
              Effect.catchTags({
                ActiveSessionConflictError: (err) =>
                  Effect.fail(
                    new Conflict({
                      message: err.message,
                      existingSessionId: err.existingSessionId,
                    }),
                  ),
                NoCapacityError: (err) =>
                  Effect.fail(new ServiceUnavailable({ message: err.message })),
                ProviderUnavailableError: (err) =>
                  Effect.fail(new ServiceUnavailable({ message: err.message })),
                StoreError: (err) => Effect.die(err),
              }),
            );

          return yield* formatSession(record, {
            includeToken: true,
            video: payload.video ?? personaRecord?.videoConfig ?? null,
            audio: payload.audio ?? personaRecord?.audioConfig ?? null,
            explicitRefImageUrl: initialRefImageUrl,
            explicitRefAudioUrl: initialRefAudioUrl,
          });
        }),

      list: ({ query }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const rows = yield* orchestrator
            .listUserSessions(user.id, {
              includeEnded: query.includeEnded ?? true,
              limit: Math.min(100, Math.max(1, query.limit ?? 25)),
            })
            .pipe(Effect.orDie);
          const sessions = yield* Effect.forEach(
            rows,
            (row) => formatSession(row, { includeToken: false }),
            { concurrency: 6 },
          );
          return { sessions };
        }),

      active: () =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const found = yield* orchestrator.getActiveSessionForUser(user.id).pipe(Effect.orDie);
          if (!found) return null;
          return yield* formatSession(found, { includeToken: true });
        }),

      get: ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const found = yield* orchestrator.getSessionForUser(params.id, user.id).pipe(
            Effect.catchTags({
              InstanceNotFoundError: (err) =>
                Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
              StoreError: (err) => Effect.die(err),
            }),
          );
          return yield* formatSession(found, { includeToken: true });
        }),

      mintToken: ({ params, payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const found = yield* orchestrator.getSessionForUser(params.id, user.id).pipe(
            Effect.catchTags({
              InstanceNotFoundError: (err) =>
                Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
              StoreError: (err) => Effect.die(err),
            }),
          );

          if (TERMINAL_SESSION_STATUSES.has(found.status) || found.status === "stopping") {
            return yield* new Conflict({
              message: `Cannot mint token for session '${found.id}' in status '${found.status}'.`,
            });
          }

          const requestedModalities = payload?.modalities ?? found.modalities;
          for (const mod of requestedModalities) {
            if (!found.modalities.includes(mod)) {
              return yield* new Forbidden({
                message: `Modality '${mod}' is not enabled on session '${found.id}'.`,
              });
            }
          }

          if (
            payload?.ttlSeconds !== undefined &&
            (payload.ttlSeconds < 60 || payload.ttlSeconds > 3600)
          ) {
            return yield* new BadRequest({
              message: "ttlSeconds must be between 60 and 3600 seconds.",
            });
          }

          return yield* tokenService
            .mintSessionToken({
              userId: user.id,
              instanceId: found.id,
              modalities: requestedModalities,
              ttlSeconds: payload?.ttlSeconds,
            })
            .pipe(Effect.orDie);
        }),

      engineStatus: ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const record = yield* orchestrator.getSessionForUser(params.id, user.id).pipe(
            Effect.catchTags({
              InstanceNotFoundError: (err) =>
                Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
              StoreError: (err) => Effect.die(err),
            }),
          );
          const ready = yield* assertSessionControllable(record).pipe(
            Effect.mapError(mapOrchestratorAccessError),
          );
          const { token } = yield* tokenService
            .mintSessionToken({
              userId: user.id,
              instanceId: ready.id,
              modalities: ready.modalities,
              ttlSeconds: 120,
            })
            .pipe(Effect.orDie);

          return yield* engineClient
            .getStatus(ready.httpUrl, ready.id, token)
            .pipe(Effect.mapError(mapEngineClientError));
        }),

      updateConfig: ({ params, payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const record = yield* orchestrator.getSessionForUser(params.id, user.id).pipe(
            Effect.catchTags({
              InstanceNotFoundError: (err) =>
                Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
              StoreError: (err) => Effect.die(err),
            }),
          );
          const ready = yield* assertSessionControllable(record).pipe(
            Effect.mapError(mapOrchestratorAccessError),
          );

          const personaRecord = payload.personaId
            ? yield* personas.getByIdForUser(payload.personaId, user.id).pipe(Effect.orDie)
            : null;
          if (payload.personaId && !personaRecord) {
            return yield* new NotFound({
              message: `Persona '${payload.personaId}' not found.`,
            });
          }

          const [signedImgUrl, signedAudUrl] = yield* Effect.all([
            resolveSignedAssetUrl(
              user.id,
              payload.refImageAssetId ?? personaRecord?.refImageAssetId,
              "ref_image",
            ),
            resolveSignedAssetUrl(
              user.id,
              payload.refAudioAssetId ?? personaRecord?.refAudioAssetId,
              "ref_audio",
            ),
          ]);

          const patchPrompt =
            payload.prompt !== undefined ? payload.prompt : (personaRecord?.prompt ?? undefined);
          const patchRefImageUrl =
            payload.refImageUrl !== undefined ? payload.refImageUrl : (signedImgUrl ?? undefined);
          const patchRefAudioUrl =
            payload.refAudioUrl !== undefined ? payload.refAudioUrl : (signedAudUrl ?? undefined);
          const patchVideo =
            payload.video !== undefined ? payload.video : (personaRecord?.videoConfig ?? undefined);
          const patchAudio =
            payload.audio !== undefined ? payload.audio : (personaRecord?.audioConfig ?? undefined);

          const patch: SessionConfigPatch = {
            ...(patchPrompt !== undefined ? { prompt: patchPrompt } : {}),
            ...(patchRefImageUrl !== undefined ? { ref_image_url: patchRefImageUrl } : {}),
            ...(payload.refImageBase64 !== undefined
              ? { ref_image_base64: payload.refImageBase64 }
              : {}),
            ...(payload.clearRefImage !== undefined
              ? { clear_ref_image: payload.clearRefImage }
              : {}),
            ...(patchRefAudioUrl !== undefined ? { ref_audio_url: patchRefAudioUrl } : {}),
            ...(payload.refAudioBase64 !== undefined
              ? { ref_audio_base64: payload.refAudioBase64 }
              : {}),
            ...(patchVideo !== undefined ? { video: patchVideo } : {}),
            ...(patchAudio !== undefined ? { audio: patchAudio } : {}),
          };

          const { token } = yield* tokenService
            .mintSessionToken({
              userId: user.id,
              instanceId: ready.id,
              modalities: ready.modalities,
              ttlSeconds: 120,
            })
            .pipe(Effect.orDie);

          const res = yield* engineClient
            .updateConfig(ready.httpUrl, ready.id, token, patch)
            .pipe(Effect.mapError(mapEngineClientError));

          yield* eventBus.publish({
            type: "session_config_updated",
            sessionId: ready.id,
            result: res,
            timestamp: new Date().toISOString(),
          });

          return res;
        }),

      uploadAssets: ({ params, payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const record = yield* orchestrator.getSessionForUser(params.id, user.id).pipe(
            Effect.catchTags({
              InstanceNotFoundError: (err) =>
                Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
              StoreError: (err) => Effect.die(err),
            }),
          );
          const ready = yield* assertSessionControllable(record).pipe(
            Effect.mapError(mapOrchestratorAccessError),
          );

          let prompt: string | undefined;
          let clearRefImage: boolean | undefined;
          let refImage:
            | { readonly bytes: Uint8Array; readonly filename: string; readonly mimeType: string }
            | undefined;
          let refAudio:
            | { readonly bytes: Uint8Array; readonly filename: string; readonly mimeType: string }
            | undefined;

          yield* Stream.runForEach(payload, (part) =>
            Effect.gen(function* () {
              if (part._tag === "Field") {
                if (part.key === "prompt") prompt = part.value;
                if (part.key === "clear_ref_image") {
                  clearRefImage = part.value.trim().toLowerCase() === "true";
                }
                return;
              }
              if (part.key === "ref_image") {
                const bytes = yield* part.contentEffect;
                refImage = { bytes, filename: part.name, mimeType: part.contentType };
              } else if (part.key === "ref_audio") {
                const bytes = yield* part.contentEffect;
                refAudio = { bytes, filename: part.name, mimeType: part.contentType };
              }
            }),
          ).pipe(
            Effect.mapError((err) => {
              if (
                err._tag === "MultipartError" &&
                (err.reason._tag === "FileTooLarge" || err.reason._tag === "BodyTooLarge")
              ) {
                return new PayloadTooLarge({ message: `Upload too large: ${err.message}` });
              }
              return new BadRequest({ message: `Invalid multipart upload: ${err.message}` });
            }),
          );

          if (refImage && refImage.bytes.byteLength > MAX_REF_IMAGE_BYTES) {
            return yield* new PayloadTooLarge({
              message: `ref_image exceeds ${MAX_REF_IMAGE_BYTES} bytes.`,
            });
          }
          if (refAudio && refAudio.bytes.byteLength > MAX_REF_AUDIO_BYTES) {
            return yield* new PayloadTooLarge({
              message: `ref_audio exceeds ${MAX_REF_AUDIO_BYTES} bytes.`,
            });
          }

          const { token } = yield* tokenService
            .mintSessionToken({
              userId: user.id,
              instanceId: ready.id,
              modalities: ready.modalities,
              ttlSeconds: 120,
            })
            .pipe(Effect.orDie);

          const res = yield* engineClient
            .uploadAssets(ready.httpUrl, ready.id, token, {
              prompt,
              clearRefImage,
              refImage,
              refAudio,
            })
            .pipe(Effect.mapError(mapEngineClientError));

          yield* eventBus.publish({
            type: "session_config_updated",
            sessionId: ready.id,
            result: res,
            timestamp: new Date().toISOString(),
          });

          return res;
        }),

      stop: ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const record = yield* orchestrator.getSessionForUser(params.id, user.id).pipe(
            Effect.catchTags({
              InstanceNotFoundError: (err) =>
                Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
              StoreError: (err) => Effect.die(err),
            }),
          );

          const minted =
            record.httpUrl && !TERMINAL_SESSION_STATUSES.has(record.status)
              ? yield* tokenService
                  .mintSessionToken({
                    userId: user.id,
                    instanceId: record.id,
                    modalities: record.modalities,
                    ttlSeconds: 120,
                  })
                  .pipe(Effect.orElseSucceed(() => null))
              : null;

          const stopped = yield* orchestrator
            .stopSession(record.id, user.id, {
              engineToken: minted?.token,
              reason: "user_requested_stop",
            })
            .pipe(
              Effect.catchTags({
                InstanceNotFoundError: (err) =>
                  Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
                ProviderUnavailableError: (err) =>
                  Effect.fail(new BadGateway({ message: err.message })),
                StoreError: (err) => Effect.die(err),
              }),
            );

          return yield* formatSession(stopped, { includeToken: false });
        }),

      events: ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const record = yield* orchestrator.getSessionForUser(params.id, user.id).pipe(
            Effect.catchTags({
              InstanceNotFoundError: (err) =>
                Effect.fail(new NotFound({ message: `Session '${err.instanceId}' not found.` })),
              StoreError: (err) => Effect.die(err),
            }),
          );

          const snapshot: SessionEvent =
            record.status === "stopped"
              ? {
                  type: "session_stopped",
                  sessionId: record.id,
                  reason: record.failureReason,
                  activeSeconds: record.activeSeconds,
                  estimatedCostUsd: record.estimatedCostUsd,
                  timestamp: (record.endedAt ?? record.updatedAt).toISOString(),
                }
              : record.status === "failed"
                ? {
                    type: "session_failed",
                    sessionId: record.id,
                    reason: record.failureReason ?? "failed",
                    activeSeconds: record.activeSeconds,
                    estimatedCostUsd: record.estimatedCostUsd,
                    timestamp: (record.endedAt ?? record.updatedAt).toISOString(),
                  }
                : record.status === "ready" && record.httpUrl && record.wsUrl
                  ? {
                      type: "session_ready",
                      sessionId: record.id,
                      status: record.status,
                      httpUrl: record.httpUrl,
                      wsUrl: record.wsUrl,
                      tlsSupported: record.tlsSupported,
                      timestamp: (record.readyAt ?? record.updatedAt).toISOString(),
                    }
                  : toStatusEvent(record);

          if (TERMINAL_SESSION_STATUSES.has(record.status)) {
            return Stream.succeed(snapshot);
          }

          return Stream.concat(
            Stream.succeed(snapshot),
            eventBus
              .subscribe(record.id)
              .pipe(
                Stream.takeUntil(
                  (evt) => evt.type === "session_stopped" || evt.type === "session_failed",
                ),
              ),
          );
        }),
    });
  }),
);

export const UsageHandlers = HttpApiBuilder.group(
  Api,
  "usage",
  Effect.fn(function* (handlers) {
    const usage = yield* UsageRepository;
    return handlers.handleAll({
      summary: () =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          return yield* usage.getSummary(user.id).pipe(Effect.orDie);
        }),
    });
  }),
);
