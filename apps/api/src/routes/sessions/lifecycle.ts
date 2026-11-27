import {
  EngineOrchestrator,
  OrchestratorConfig,
  OrchestratorEventBus,
  toStatusEvent,
} from "@metamorph/orchestrator";
import { TERMINAL_SESSION_STATUSES, type Modality, type SessionEvent } from "@metamorph/shared";
import { Effect, Stream } from "effect";
import type { HttpApiBuilder } from "effect/http-api";

import {
  BadGateway,
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  ServiceUnavailable,
} from "../../api/index.ts";
import type { SessionsGroup } from "../../api/sessions.ts";
import { CurrentSession } from "../../middleware/auth.ts";
import { PersonaRepository } from "../../repositories/index.ts";
import { EngineTokenService } from "../../services/engine-tokens.ts";
import type { SessionHelpers } from "./helpers.ts";

export const makeSessionLifecycleHandlers = (
  handlers: HttpApiBuilder.Handlers<never, typeof SessionsGroup.endpoints, never>,
  helpers: SessionHelpers,
) =>
  Effect.gen(function* () {
    const orchestratorConfig = yield* OrchestratorConfig;
    const orchestrator = yield* EngineOrchestrator;
    const eventBus = yield* OrchestratorEventBus;
    const tokenService = yield* EngineTokenService;
    const personas = yield* PersonaRepository;

    const { resolveSignedAssetUrl, getOwnedSession, formatSession } = helpers;

    return handlers
      .handle("create", ({ payload }) =>
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
      )
      .handle("list", ({ query }) =>
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
      )
      .handle("active", () =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const found = yield* orchestrator.getActiveSessionForUser(user.id).pipe(Effect.orDie);
          if (!found) return null;
          return yield* formatSession(found, { includeToken: true });
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const found = yield* getOwnedSession(params.id, user.id);
          return yield* formatSession(found, { includeToken: true });
        }),
      )
      .handle("stop", ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const record = yield* getOwnedSession(params.id, user.id);

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
      )
      .handle("events", ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const record = yield* getOwnedSession(params.id, user.id);

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
      );
  });
