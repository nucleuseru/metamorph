import {
  TERMINAL_SESSION_STATUSES,
  type Modality,
  type ProviderName,
  type QualityTier,
  type SessionEvent,
} from "@metamorph/shared";
import { Clock, Context, Duration, Effect, Layer, Schedule } from "effect";
import { Mac, SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

import { OrchestratorConfig } from "./config.ts";
import { EngineClient } from "./engine-client.ts";
import {
  ActiveSessionConflictError,
  InstanceNotFoundError,
  InstanceStateError,
  NoCapacityError,
  ProviderUnavailableError,
  StoreError,
  WebhookVerificationError,
} from "./errors.ts";
import { OrchestratorEventBus } from "./events.ts";
import { ProviderRegistry } from "./provider.ts";
import { buildEngineEnv, resolveHardwareProfile } from "./sizing.ts";
import { InstanceStore, type EngineInstanceRecord } from "./store.ts";
import { parseWebhookEvent, verifyWebhookSignature } from "./webhooks.ts";

export interface ProvisionSessionInput {
  readonly userId: string;
  readonly modalities: ReadonlyArray<Modality>;
  readonly quality: QualityTier;
  readonly personaId?: string | null | undefined;
  readonly initialPrompt?: string | null | undefined;
  readonly initialRefImageUrl?: string | null | undefined;
  readonly initialRefAudioUrl?: string | null | undefined;
  readonly refImageAssetId?: string | null | undefined;
  readonly refAudioAssetId?: string | null | undefined;
  readonly jwtPublicKeyPem: string;
  readonly providerOverride?: ProviderName | undefined;
  readonly gpuTypeOverride?: string | undefined;
  readonly imageOverride?: string | undefined;
  readonly instanceId?: string | undefined;
}

export interface EngineOrchestratorShape {
  readonly provisionSession: (
    input: ProvisionSessionInput,
  ) => Effect.Effect<
    EngineInstanceRecord,
    ActiveSessionConflictError | NoCapacityError | ProviderUnavailableError | StoreError
  >;
  readonly getSession: (
    instanceId: string,
  ) => Effect.Effect<EngineInstanceRecord, InstanceNotFoundError | StoreError>;
  readonly getSessionForUser: (
    instanceId: string,
    userId: string,
  ) => Effect.Effect<EngineInstanceRecord, InstanceNotFoundError | StoreError>;
  readonly getActiveSessionForUser: (
    userId: string,
  ) => Effect.Effect<EngineInstanceRecord | null, StoreError>;
  readonly listUserSessions: (
    userId: string,
    options?: { readonly includeEnded?: boolean | undefined; readonly limit?: number | undefined },
  ) => Effect.Effect<ReadonlyArray<EngineInstanceRecord>, StoreError>;
  readonly stopSession: (
    instanceId: string,
    userId: string,
    options?: {
      readonly engineToken?: string | undefined;
      readonly reason?: string | undefined;
    },
  ) => Effect.Effect<
    EngineInstanceRecord,
    InstanceNotFoundError | ProviderUnavailableError | StoreError
  >;
  readonly handleWebhook: (
    instanceId: string,
    rawBody: Uint8Array,
    signatureHeader: string | undefined,
  ) => Effect.Effect<
    EngineInstanceRecord,
    InstanceNotFoundError | WebhookVerificationError | StoreError
  >;
  readonly reconcileOnce: Effect.Effect<void, never>;
}

/** Computes elapsed active seconds and USD cost from billing rate and timestamps. */
export function computeUsageCost(
  record: Pick<EngineInstanceRecord, "createdAt" | "hourlyRateUsd">,
  endedAt: Date,
): { readonly activeSeconds: number; readonly estimatedCostUsd: number } {
  const activeSeconds = Math.max(
    0,
    Math.round((endedAt.getTime() - record.createdAt.getTime()) / 1000),
  );
  const rate = record.hourlyRateUsd ?? 0;
  const estimatedCostUsd = Number(((activeSeconds / 3600) * rate).toFixed(6));
  return { activeSeconds, estimatedCostUsd };
}

export function toStatusEvent(
  record: EngineInstanceRecord,
  reason: string | null = record.failureReason,
): SessionEvent {
  return {
    type: "session_status",
    sessionId: record.id,
    status: record.status,
    httpUrl: record.httpUrl,
    wsUrl: record.wsUrl,
    tlsSupported: record.tlsSupported,
    timestamp: new Date().toISOString(),
    reason,
  };
}

export class EngineOrchestrator extends Context.Service<
  EngineOrchestrator,
  EngineOrchestratorShape
>()("@metamorph/orchestrator/EngineOrchestrator") {
  static readonly layer = Layer.effect(
    EngineOrchestrator,
    Effect.gen(function* () {
      const config = yield* OrchestratorConfig;
      const store = yield* InstanceStore;
      const registry = yield* ProviderRegistry;
      const engineClient = yield* EngineClient;
      const eventBus = yield* OrchestratorEventBus;
      const mac = yield* Mac.Mac;
      const serviceScope = yield* Effect.scope;

      const terminateProviderSafely = (providerName: ProviderName, providerInstanceId: string) =>
        Effect.gen(function* () {
          const provider = registry.get(providerName);
          if (!provider) return;
          yield* provider
            .terminate(providerInstanceId)
            .pipe(
              Effect.catch((err) =>
                Effect.logWarning(
                  `Failed to terminate ${providerName} instance '${providerInstanceId}': ${err.message}`,
                ),
              ),
            );
        });

      const failAndCleanup = Effect.fn("EngineOrchestrator.failAndCleanup")(function* (
        record: EngineInstanceRecord,
        reason: string,
      ) {
        yield* terminateProviderSafely(record.provider, record.providerInstanceId);
        const nowMillis = yield* Clock.currentTimeMillis;
        const endedAt = new Date(nowMillis);
        const usage = computeUsageCost(record, endedAt);
        const updated = yield* store.update(record.id, {
          status: "failed",
          failureReason: reason,
          endedAt,
          activeSeconds: usage.activeSeconds,
          estimatedCostUsd: usage.estimatedCostUsd,
        });
        const finalRecord = updated ?? {
          ...record,
          status: "failed" as const,
          failureReason: reason,
          endedAt,
          ...usage,
        };
        yield* eventBus.publish({
          type: "session_failed",
          sessionId: finalRecord.id,
          reason,
          activeSeconds: finalRecord.activeSeconds,
          estimatedCostUsd: finalRecord.estimatedCostUsd,
          timestamp: endedAt.toISOString(),
        });
        return finalRecord;
      });

      const stopAndCleanup = Effect.fn("EngineOrchestrator.stopAndCleanup")(function* (
        record: EngineInstanceRecord,
        reason: string,
      ) {
        yield* terminateProviderSafely(record.provider, record.providerInstanceId);
        const nowMillis = yield* Clock.currentTimeMillis;
        const endedAt = new Date(nowMillis);
        const usage = computeUsageCost(record, endedAt);
        const updated = yield* store.update(record.id, {
          status: "stopped",
          failureReason: reason,
          endedAt,
          activeSeconds: usage.activeSeconds,
          estimatedCostUsd: usage.estimatedCostUsd,
        });
        const finalRecord = updated ?? {
          ...record,
          status: "stopped" as const,
          failureReason: reason,
          endedAt,
          ...usage,
        };
        yield* eventBus.publish({
          type: "session_stopped",
          sessionId: finalRecord.id,
          reason,
          activeSeconds: finalRecord.activeSeconds,
          estimatedCostUsd: finalRecord.estimatedCostUsd,
          timestamp: endedAt.toISOString(),
        });
        return finalRecord;
      });

      const watchReadiness = (initialRecord: EngineInstanceRecord) =>
        Effect.gen(function* () {
          const startedMs = yield* Clock.currentTimeMillis;
          const deadlineMs = startedMs + config.startupTimeoutS * 1000;
          const pollInterval = Duration.millis(Math.max(50, config.readinessPollIntervalMs));
          const provider = registry.get(initialRecord.provider);
          let current = initialRecord;

          while (true) {
            const latest = yield* store.getById(current.id).pipe(Effect.orElseSucceed(() => null));
            if (
              !latest ||
              TERMINAL_SESSION_STATUSES.has(latest.status) ||
              latest.status === "stopping"
            ) {
              return;
            }
            current = latest;

            if (
              current.status === "ready" ||
              current.status === "active" ||
              current.status === "disconnect_grace"
            ) {
              return;
            }

            const nowMs = yield* Clock.currentTimeMillis;
            if (nowMs >= deadlineMs) {
              yield* failAndCleanup(
                current,
                `Instance startup timed out after ${config.startupTimeoutS}s`,
              ).pipe(Effect.ignore);
              return;
            }

            if (provider) {
              const pStatus = yield* provider
                .getStatus(current.providerInstanceId)
                .pipe(Effect.result);
              if (pStatus._tag === "Success") {
                const ps = pStatus.success;
                if (ps.status === "failed" || ps.status === "terminated") {
                  yield* failAndCleanup(
                    current,
                    `Provider reported ${ps.status}${ps.reason ? `: ${ps.reason}` : ""}`,
                  ).pipe(Effect.ignore);
                  return;
                }
                if (
                  (ps.httpUrl !== null && ps.httpUrl !== current.httpUrl) ||
                  (ps.wsUrl !== null && ps.wsUrl !== current.wsUrl) ||
                  (ps.status === "running" && current.status === "provisioning")
                ) {
                  const nextStatus =
                    ps.status === "running" && current.status === "provisioning"
                      ? ("warming" as const)
                      : current.status;
                  const updated = yield* store
                    .update(current.id, {
                      status: nextStatus,
                      httpUrl: ps.httpUrl ?? current.httpUrl,
                      wsUrl: ps.wsUrl ?? current.wsUrl,
                      tlsSupported: ps.tlsSupported,
                    })
                    .pipe(Effect.orElseSucceed(() => null));
                  if (updated) {
                    current = updated;
                    yield* eventBus.publish(toStatusEvent(current));
                  }
                }
              }
            }

            if (current.httpUrl) {
              const readyRes = yield* engineClient
                .ready(current.httpUrl, current.id)
                .pipe(Effect.result);
              if (readyRes._tag === "Success") {
                if (readyRes.success.ready && current.wsUrl) {
                  const fresh = yield* store
                    .getById(current.id)
                    .pipe(Effect.orElseSucceed(() => null));
                  if (!fresh || (fresh.status !== "provisioning" && fresh.status !== "warming")) {
                    return;
                  }
                  const readyTimeMs = yield* Clock.currentTimeMillis;
                  const readyAt = new Date(readyTimeMs);
                  const updated = yield* store
                    .update(fresh.id, {
                      status: "ready",
                      readyAt,
                    })
                    .pipe(Effect.orElseSucceed(() => null));
                  if (updated && updated.httpUrl && updated.wsUrl) {
                    yield* eventBus.publish({
                      type: "session_ready",
                      sessionId: updated.id,
                      status: updated.status,
                      httpUrl: updated.httpUrl,
                      wsUrl: updated.wsUrl,
                      tlsSupported: updated.tlsSupported,
                      timestamp: readyAt.toISOString(),
                    });
                  }
                  return;
                }
                if (
                  readyRes.success.response.status === "warming" &&
                  current.status === "provisioning"
                ) {
                  const updated = yield* store
                    .update(current.id, { status: "warming" })
                    .pipe(Effect.orElseSucceed(() => null));
                  if (updated) {
                    current = updated;
                    yield* eventBus.publish(toStatusEvent(current));
                  }
                }
                if (readyRes.success.response.status === "shutting_down") {
                  const reason =
                    readyRes.success.response.reason ?? "engine_shutting_down_during_startup";
                  yield* failAndCleanup(current, reason).pipe(Effect.ignore);
                  return;
                }
              }
            }

            yield* Effect.sleep(pollInterval);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Readiness watcher for session '${initialRecord.id}' ended abnormally`,
              cause,
            ),
          ),
        );

      const provisionSession: EngineOrchestratorShape["provisionSession"] = Effect.fn(
        "EngineOrchestrator.provisionSession",
      )(function* (input: ProvisionSessionInput) {
        const existing = yield* store.findActiveByUserId(input.userId);
        if (existing !== null) {
          return yield* new ActiveSessionConflictError({
            userId: input.userId,
            existingSessionId: existing.id,
            message: `User already has active session '${existing.id}' (${existing.status}).`,
          });
        }

        const instanceId = input.instanceId ?? SecureRandom.uuidV4Unsafe();
        const hardware = resolveHardwareProfile({
          modalities: input.modalities,
          quality: input.quality,
          config,
          gpuTypeOverride: config.allowOverrides ? input.gpuTypeOverride : undefined,
          imageOverride: config.allowOverrides ? input.imageOverride : undefined,
        });

        const secretBytes = SecureRandom.randomBytesUnsafe(32);
        const webhookSecret = Hex.encode(secretBytes);
        const webhookUrl = config.webhookBaseUrl
          ? `${config.webhookBaseUrl}/internal/webhooks/engine/${instanceId}`
          : undefined;

        const env = buildEngineEnv({
          instanceId,
          userId: input.userId,
          hardware,
          jwtPublicKeyPem: input.jwtPublicKeyPem,
          webhookUrl,
          webhookSecret,
          config,
          idleTimeoutS: config.idleTimeoutS,
          disconnectTimeoutS: config.disconnectTimeoutS,
          initialPrompt: input.initialPrompt ?? undefined,
          initialRefImageUrl: input.initialRefImageUrl ?? undefined,
          initialRefAudioUrl: input.initialRefAudioUrl ?? undefined,
        });

        const preferredProvider = config.allowOverrides ? input.providerOverride : undefined;
        const provisioned = yield* registry.provisionWithFailover(
          {
            instanceId,
            userId: input.userId,
            modalities: input.modalities,
            quality: input.quality,
            hardware,
            env,
          },
          preferredProvider,
        );

        const record = yield* store
          .create({
            id: instanceId,
            userId: input.userId,
            personaId: input.personaId ?? null,
            status: "provisioning",
            modalities: [...input.modalities],
            quality: input.quality,
            provider: provisioned.provider,
            providerInstanceId: provisioned.providerInstanceId,
            gpuType: provisioned.gpuType,
            image: hardware.image,
            httpUrl: provisioned.httpUrl,
            wsUrl: provisioned.wsUrl,
            tlsSupported: provisioned.tlsSupported,
            webhookSecret,
            hourlyRateUsd: provisioned.hourlyRateUsd,
            idleTimeoutS: config.idleTimeoutS,
            disconnectTimeoutS: config.disconnectTimeoutS,
            maxDurationS: config.maxSessionDurationS,
            initialPrompt: input.initialPrompt ?? null,
            refImageAssetId: input.refImageAssetId ?? null,
            refAudioAssetId: input.refAudioAssetId ?? null,
          })
          .pipe(
            Effect.onError(() =>
              terminateProviderSafely(provisioned.provider, provisioned.providerInstanceId),
            ),
          );

        yield* eventBus.publish(toStatusEvent(record));
        yield* Effect.forkIn(watchReadiness(record), serviceScope);

        return record;
      });

      const getSession: EngineOrchestratorShape["getSession"] = Effect.fn(
        "EngineOrchestrator.getSession",
      )(function* (instanceId: string) {
        const found = yield* store.getById(instanceId);
        if (found === null) {
          return yield* new InstanceNotFoundError({ instanceId });
        }
        return found;
      });

      const getSessionForUser: EngineOrchestratorShape["getSessionForUser"] = Effect.fn(
        "EngineOrchestrator.getSessionForUser",
      )(function* (instanceId: string, userId: string) {
        const found = yield* getSession(instanceId);
        if (found.userId !== userId) {
          return yield* new InstanceNotFoundError({ instanceId });
        }
        return found;
      });

      const getActiveSessionForUser: EngineOrchestratorShape["getActiveSessionForUser"] = (
        userId: string,
      ) => store.findActiveByUserId(userId);

      const listUserSessions: EngineOrchestratorShape["listUserSessions"] = (userId, options) =>
        store.listByUserId(userId, options);

      const stopSession: EngineOrchestratorShape["stopSession"] = Effect.fn(
        "EngineOrchestrator.stopSession",
      )(function* (
        instanceId: string,
        userId: string,
        options?: {
          readonly engineToken?: string | undefined;
          readonly reason?: string | undefined;
        },
      ) {
        const current = yield* getSessionForUser(instanceId, userId);
        if (TERMINAL_SESSION_STATUSES.has(current.status)) {
          return current;
        }

        const reason = options?.reason ?? "user_requested_stop";
        const stopping = yield* store.update(current.id, { status: "stopping" });
        const working = stopping ?? { ...current, status: "stopping" as const };
        yield* eventBus.publish(toStatusEvent(working, reason));

        if (working.httpUrl && options?.engineToken) {
          yield* engineClient
            .shutdown(working.httpUrl, working.id, options.engineToken)
            .pipe(
              Effect.catch((err) =>
                Effect.logWarning(
                  `Best-effort engine /session/shutdown failed for '${working.id}': ${err.message}`,
                ),
              ),
            );
        }

        return yield* stopAndCleanup(working, reason);
      });

      const handleWebhook: EngineOrchestratorShape["handleWebhook"] = Effect.fn(
        "EngineOrchestrator.handleWebhook",
      )(function* (instanceId: string, rawBody: Uint8Array, signatureHeader: string | undefined) {
        const record = yield* getSession(instanceId);
        yield* verifyWebhookSignature(rawBody, signatureHeader, record.webhookSecret).pipe(
          Effect.provideService(Mac.Mac, mac),
        );
        const event = yield* parseWebhookEvent(rawBody);

        if (event.instance_id !== instanceId) {
          return yield* new WebhookVerificationError({
            message: `Webhook instance_id '${event.instance_id}' does not match route '${instanceId}'.`,
          });
        }

        if (TERMINAL_SESSION_STATUSES.has(record.status)) {
          return record;
        }

        const nowMs = yield* Clock.currentTimeMillis;
        const now = new Date(nowMs);

        if (event.event === "ready") {
          const canTransitionToReady =
            record.status === "provisioning" || record.status === "warming";
          if (!canTransitionToReady) {
            return record;
          }
          const updated = yield* store.update(record.id, {
            status: "ready",
            readyAt: record.readyAt ?? now,
          });
          const res = updated ?? record;
          if (res.httpUrl && res.wsUrl && res.status === "ready") {
            yield* eventBus.publish({
              type: "session_ready",
              sessionId: res.id,
              status: res.status,
              httpUrl: res.httpUrl,
              wsUrl: res.wsUrl,
              tlsSupported: res.tlsSupported,
              timestamp: now.toISOString(),
            });
          } else {
            yield* eventBus.publish(toStatusEvent(res));
          }
          return res;
        }

        if (event.event === "connected") {
          const updated = yield* store.update(record.id, {
            status: "active",
            connectedAt: record.connectedAt ?? now,
            disconnectedAt: null,
          });
          const res = updated ?? record;
          yield* eventBus.publish(toStatusEvent(res));
          return res;
        }

        if (event.event === "disconnected") {
          if (record.status === "stopping") return record;
          const updated = yield* store.update(record.id, {
            status: "disconnect_grace",
            disconnectedAt: now,
          });
          const res = updated ?? record;
          yield* eventBus.publish(toStatusEvent(res, event.reason ?? "client_disconnected"));
          return res;
        }

        // shutting_down: surface startup failures as `failed` instead of silently stopping
        const shutdownReason = event.reason ?? "engine_shutting_down";
        if (
          record.status === "provisioning" ||
          record.status === "warming" ||
          shutdownReason.startsWith("startup_failed")
        ) {
          return yield* failAndCleanup(record, shutdownReason);
        }
        return yield* stopAndCleanup(record, shutdownReason);
      });

      const reconcileOnce: EngineOrchestratorShape["reconcileOnce"] = Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const active = yield* store.listActive.pipe(Effect.orElseSucceed(() => []));
        const knownProviderKeys = new Set<string>();

        for (const item of active) {
          knownProviderKeys.add(`${item.provider}:${item.providerInstanceId}`);
          const ageS = (nowMs - item.createdAt.getTime()) / 1000;

          if (ageS > item.maxDurationS) {
            yield* stopAndCleanup(item, "max_session_duration_exceeded").pipe(Effect.ignore);
            continue;
          }

          if (
            (item.status === "provisioning" || item.status === "warming") &&
            ageS > config.startupTimeoutS + 15
          ) {
            yield* failAndCleanup(item, "startup_timeout_reconciled").pipe(Effect.ignore);
            continue;
          }

          if (
            item.status === "disconnect_grace" &&
            item.disconnectedAt !== null &&
            (nowMs - item.disconnectedAt.getTime()) / 1000 > item.disconnectTimeoutS + 15
          ) {
            yield* stopAndCleanup(item, "disconnect_grace_timeout_reconciled").pipe(Effect.ignore);
            continue;
          }

          if (
            item.status === "ready" &&
            item.readyAt !== null &&
            (nowMs - item.readyAt.getTime()) / 1000 > item.idleTimeoutS + 15
          ) {
            yield* stopAndCleanup(item, "idle_timeout_reconciled").pipe(Effect.ignore);
            continue;
          }

          const provider = registry.get(item.provider);
          if (provider) {
            const pStatus = yield* provider.getStatus(item.providerInstanceId).pipe(Effect.result);
            if (pStatus._tag === "Success") {
              const ps = pStatus.success;
              if (ps.status === "terminated" || ps.status === "stopped") {
                yield* stopAndCleanup(item, `provider_${ps.status}`).pipe(Effect.ignore);
              } else if (ps.status === "failed") {
                yield* failAndCleanup(
                  item,
                  `provider_failed${ps.reason ? `: ${ps.reason}` : ""}`,
                ).pipe(Effect.ignore);
              } else if (
                (ps.httpUrl !== null && item.httpUrl === null) ||
                (ps.wsUrl !== null && item.wsUrl === null)
              ) {
                const updated = yield* store
                  .update(item.id, {
                    httpUrl: ps.httpUrl ?? item.httpUrl,
                    wsUrl: ps.wsUrl ?? item.wsUrl,
                    tlsSupported: ps.tlsSupported,
                  })
                  .pipe(Effect.orElseSucceed(() => null));
                if (updated) {
                  yield* eventBus.publish(toStatusEvent(updated));
                }
              }
            }
          }
        }

        // Terminate orphan provider instances tagged as metamorph-* that have no active DB session
        for (const provider of registry.list()) {
          const managed = yield* provider.listManaged.pipe(Effect.orElseSucceed(() => []));
          for (const inst of managed) {
            if (inst.status === "terminated" || inst.status === "stopped") continue;
            const key = `${inst.provider}:${inst.providerInstanceId}`;
            if (knownProviderKeys.has(key)) continue;

            if (inst.instanceId !== null) {
              const dbRecord = yield* store
                .getById(inst.instanceId)
                .pipe(Effect.orElseSucceed(() => null));
              if (dbRecord && !TERMINAL_SESSION_STATUSES.has(dbRecord.status)) {
                continue;
              }
            }

            const ageS =
              inst.createdAtMs !== null
                ? (nowMs - inst.createdAtMs) / 1000
                : config.orphanGracePeriodS + 1;
            if (ageS > config.orphanGracePeriodS) {
              yield* Effect.logWarning(
                `Terminating orphan ${inst.provider} instance '${inst.providerInstanceId}' (instanceId=${inst.instanceId ?? "unknown"})`,
              );
              yield* terminateProviderSafely(inst.provider, inst.providerInstanceId);
            }
          }
        }
      }).pipe(Effect.withSpan("EngineOrchestrator.reconcileOnce"));

      return EngineOrchestrator.of({
        provisionSession,
        getSession,
        getSessionForUser,
        getActiveSessionForUser,
        listUserSessions,
        stopSession,
        handleWebhook,
        reconcileOnce,
      });
    }),
  );
}

/** Ensures a session is currently reachable over HTTP (`ready`, `active`, or `disconnect_grace`). */
export function assertSessionControllable(
  record: EngineInstanceRecord,
): Effect.Effect<
  EngineInstanceRecord & { readonly httpUrl: string; readonly wsUrl: string },
  InstanceStateError
> {
  if (
    !record.httpUrl ||
    !record.wsUrl ||
    (record.status !== "ready" &&
      record.status !== "active" &&
      record.status !== "disconnect_grace")
  ) {
    return Effect.fail(
      new InstanceStateError({
        instanceId: record.id,
        currentStatus: record.status,
        message: `Session '${record.id}' is not ready for control (status=${record.status}).`,
      }),
    );
  }
  return Effect.succeed({
    ...record,
    httpUrl: record.httpUrl,
    wsUrl: record.wsUrl,
  });
}

/** Background layer running periodic orphan and timeout reconciliation. */
export const ReconcilerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* OrchestratorConfig;
    const orchestrator = yield* EngineOrchestrator;

    const loop = orchestrator.reconcileOnce.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Reconciler cycle error", cause)),
      Effect.repeat(Schedule.spaced(Duration.seconds(Math.max(1, config.reconcileIntervalS)))),
      Effect.forkScoped,
    );

    yield* loop;
  }),
);
