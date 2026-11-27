import {
  ActiveSessionConflictError,
  InstanceStore,
  StoreError,
  type CreateInstanceRecord,
  type EngineInstanceRecord,
  type UpdateInstanceRecord,
} from "@metamorph/orchestrator";
import { TERMINAL_SESSION_STATUSES } from "@metamorph/shared";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { engineSession } from "../db/schema.ts";
import { Database } from "../services/db.ts";

const isUniqueViolation = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const obj = err as { code?: unknown; cause?: unknown };
  if (obj.code === "23505") return true;
  if (obj.cause && obj.cause !== err) return isUniqueViolation(obj.cause);
  return false;
};

export const toEngineInstanceRecord = (
  row: typeof engineSession.$inferSelect,
): EngineInstanceRecord => ({
  id: row.id,
  userId: row.userId,
  personaId: row.personaId,
  status: row.status,
  modalities: row.modalities,
  quality: row.quality,
  provider: row.provider,
  providerInstanceId: row.providerInstanceId,
  gpuType: row.gpuType,
  image: row.image,
  httpUrl: row.httpUrl,
  wsUrl: row.wsUrl,
  tlsSupported: row.tlsSupported,
  webhookSecret: row.webhookSecret,
  hourlyRateUsd: row.hourlyRateUsd,
  idleTimeoutS: row.idleTimeoutS,
  disconnectTimeoutS: row.disconnectTimeoutS,
  maxDurationS: row.maxDurationS,
  initialPrompt: row.initialPrompt,
  refImageAssetId: row.refImageAssetId,
  refAudioAssetId: row.refAudioAssetId,
  failureReason: row.failureReason,
  readyAt: row.readyAt,
  connectedAt: row.connectedAt,
  disconnectedAt: row.disconnectedAt,
  endedAt: row.endedAt,
  activeSeconds: row.activeSeconds,
  estimatedCostUsd: row.estimatedCostUsd,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const TERMINAL_LIST = [...TERMINAL_SESSION_STATUSES];

export const DrizzleInstanceStoreLayer = Layer.effect(
  InstanceStore,
  Effect.gen(function* () {
    const db = yield* Database;

    const findActiveByUserId = (userId: string) =>
      db
        .select()
        .from(engineSession)
        .where(
          and(eq(engineSession.userId, userId), notInArray(engineSession.status, TERMINAL_LIST)),
        )
        .limit(1)
        .pipe(
          Effect.map((rows) => (rows[0] ? toEngineInstanceRecord(rows[0]) : null)),
          Effect.mapError((cause) => new StoreError({ operation: "findActiveByUserId", cause })),
        );

    return InstanceStore.of({
      create: (input: CreateInstanceRecord) =>
        db
          .insert(engineSession)
          .values({
            id: input.id,
            userId: input.userId,
            personaId: input.personaId,
            status: input.status,
            modalities: [...input.modalities],
            quality: input.quality,
            provider: input.provider,
            providerInstanceId: input.providerInstanceId,
            gpuType: input.gpuType,
            image: input.image,
            httpUrl: input.httpUrl,
            wsUrl: input.wsUrl,
            tlsSupported: input.tlsSupported,
            webhookSecret: input.webhookSecret,
            hourlyRateUsd: input.hourlyRateUsd,
            idleTimeoutS: input.idleTimeoutS,
            disconnectTimeoutS: input.disconnectTimeoutS,
            maxDurationS: input.maxDurationS,
            initialPrompt: input.initialPrompt,
            refImageAssetId: input.refImageAssetId,
            refAudioAssetId: input.refAudioAssetId,
          })
          .returning()
          .pipe(
            Effect.map((rows) => toEngineInstanceRecord(rows[0]!)),
            Effect.catch((cause) => {
              if (isUniqueViolation(cause)) {
                return findActiveByUserId(input.userId).pipe(
                  Effect.flatMap((existing) =>
                    Effect.fail(
                      new ActiveSessionConflictError({
                        userId: input.userId,
                        existingSessionId: existing?.id ?? "unknown",
                        message: `User already has active session '${existing?.id ?? "unknown"}'.`,
                      }),
                    ),
                  ),
                );
              }
              return Effect.fail(new StoreError({ operation: "create", cause }));
            }),
          ),
      getById: (id) =>
        db
          .select()
          .from(engineSession)
          .where(eq(engineSession.id, id))
          .limit(1)
          .pipe(
            Effect.map((rows) => (rows[0] ? toEngineInstanceRecord(rows[0]) : null)),
            Effect.mapError((cause) => new StoreError({ operation: "getById", cause })),
          ),
      findActiveByUserId,
      listActive: db
        .select()
        .from(engineSession)
        .where(notInArray(engineSession.status, TERMINAL_LIST))
        .pipe(
          Effect.map((rows) => rows.map(toEngineInstanceRecord)),
          Effect.mapError((cause) => new StoreError({ operation: "listActive", cause })),
        ),
      listByUserId: (userId, options) => {
        const includeEnded = options?.includeEnded ?? true;
        const limit = options?.limit ?? 50;
        const condition = includeEnded
          ? eq(engineSession.userId, userId)
          : and(eq(engineSession.userId, userId), notInArray(engineSession.status, TERMINAL_LIST));
        return db
          .select()
          .from(engineSession)
          .where(condition)
          .orderBy(desc(engineSession.createdAt))
          .limit(limit)
          .pipe(
            Effect.map((rows) => rows.map(toEngineInstanceRecord)),
            Effect.mapError((cause) => new StoreError({ operation: "listByUserId", cause })),
          );
      },
      update: (id, patch: UpdateInstanceRecord) =>
        db
          .update(engineSession)
          .set({
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.httpUrl !== undefined ? { httpUrl: patch.httpUrl } : {}),
            ...(patch.wsUrl !== undefined ? { wsUrl: patch.wsUrl } : {}),
            ...(patch.tlsSupported !== undefined ? { tlsSupported: patch.tlsSupported } : {}),
            ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
            ...(patch.readyAt !== undefined ? { readyAt: patch.readyAt } : {}),
            ...(patch.connectedAt !== undefined ? { connectedAt: patch.connectedAt } : {}),
            ...(patch.disconnectedAt !== undefined ? { disconnectedAt: patch.disconnectedAt } : {}),
            ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
            ...(patch.activeSeconds !== undefined ? { activeSeconds: patch.activeSeconds } : {}),
            ...(patch.estimatedCostUsd !== undefined
              ? { estimatedCostUsd: patch.estimatedCostUsd }
              : {}),
          })
          .where(eq(engineSession.id, id))
          .returning()
          .pipe(
            Effect.map((rows) => (rows[0] ? toEngineInstanceRecord(rows[0]) : null)),
            Effect.mapError((cause) => new StoreError({ operation: "update", cause })),
          ),
    });
  }),
);
