import {
  ActiveSessionConflictError,
  InstanceStore,
  StoreError,
  type CreateInstanceRecord,
  type EngineInstanceRecord,
  type UpdateInstanceRecord,
} from "@metamorph/orchestrator";
import {
  TERMINAL_SESSION_STATUSES,
  type AssetKind,
  type AudioStartConfig,
  type Modality,
  type ProviderName,
  type VideoStartConfig,
} from "@metamorph/shared";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";

import { engineSession, mediaAsset, persona } from "../db/schema.ts";
import { Database } from "./db.ts";

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface MediaAssetRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly storageKey: string;
  readonly sha256: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateMediaAssetInput {
  readonly id: string;
  readonly userId: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly storageKey: string;
  readonly sha256: string;
}

export interface AssetRepositoryShape {
  readonly create: (
    input: CreateMediaAssetInput,
  ) => Effect.Effect<MediaAssetRecord, RepositoryError>;
  readonly getById: (id: string) => Effect.Effect<MediaAssetRecord | null, RepositoryError>;
  readonly getByIdForUser: (
    id: string,
    userId: string,
  ) => Effect.Effect<MediaAssetRecord | null, RepositoryError>;
  readonly listByUser: (
    userId: string,
    kind?: AssetKind | undefined,
  ) => Effect.Effect<ReadonlyArray<MediaAssetRecord>, RepositoryError>;
  readonly deleteForUser: (
    id: string,
    userId: string,
  ) => Effect.Effect<MediaAssetRecord | null, RepositoryError>;
}

export class AssetRepository extends Context.Service<AssetRepository, AssetRepositoryShape>()(
  "@metamorph/api/services/AssetRepository",
) {
  static readonly layerMemory = Layer.effect(
    AssetRepository,
    Effect.gen(function* () {
      const ref = yield* Ref.make(new Map<string, MediaAssetRecord>());
      return AssetRepository.of({
        create: (input) =>
          Effect.gen(function* () {
            const now = new Date(yield* Clock.currentTimeMillis);
            const record: MediaAssetRecord = { ...input, createdAt: now, updatedAt: now };
            yield* Ref.update(ref, (m) => new Map(m).set(record.id, record));
            return record;
          }),
        getById: (id) => Ref.get(ref).pipe(Effect.map((m) => m.get(id) ?? null)),
        getByIdForUser: (id, userId) =>
          Ref.get(ref).pipe(
            Effect.map((m) => {
              const found = m.get(id);
              return found && found.userId === userId ? found : null;
            }),
          ),
        listByUser: (userId, kind) =>
          Ref.get(ref).pipe(
            Effect.map((m) =>
              [...m.values()]
                .filter((r) => r.userId === userId && (kind === undefined || r.kind === kind))
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
            ),
          ),
        deleteForUser: (id, userId) =>
          Ref.modify(ref, (m) => {
            const existing = m.get(id);
            if (!existing || existing.userId !== userId) return [null, m] as const;
            const next = new Map(m);
            next.delete(id);
            return [existing, next] as const;
          }),
      });
    }),
  );

  static readonly layer = Layer.effect(
    AssetRepository,
    Effect.gen(function* () {
      const db = yield* Database;

      return AssetRepository.of({
        create: (input) =>
          db
            .insert(mediaAsset)
            .values({
              id: input.id,
              userId: input.userId,
              kind: input.kind,
              name: input.name,
              mimeType: input.mimeType,
              byteSize: input.byteSize,
              storageKey: input.storageKey,
              sha256: input.sha256,
            })
            .returning()
            .pipe(
              Effect.map((rows) => rows[0]!),
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
        getById: (id) =>
          db
            .select()
            .from(mediaAsset)
            .where(eq(mediaAsset.id, id))
            .limit(1)
            .pipe(
              Effect.map((rows) => rows[0] ?? null),
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
        getByIdForUser: (id, userId) =>
          db
            .select()
            .from(mediaAsset)
            .where(and(eq(mediaAsset.id, id), eq(mediaAsset.userId, userId)))
            .limit(1)
            .pipe(
              Effect.map((rows) => rows[0] ?? null),
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
        listByUser: (userId, kind) =>
          db
            .select()
            .from(mediaAsset)
            .where(
              kind
                ? and(eq(mediaAsset.userId, userId), eq(mediaAsset.kind, kind))
                : eq(mediaAsset.userId, userId),
            )
            .orderBy(desc(mediaAsset.createdAt))
            .pipe(
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
        deleteForUser: (id, userId) =>
          db
            .delete(mediaAsset)
            .where(and(eq(mediaAsset.id, id), eq(mediaAsset.userId, userId)))
            .returning()
            .pipe(
              Effect.map((rows) => rows[0] ?? null),
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
      });
    }),
  );
}

export interface PersonaRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string | null;
  readonly modalities: ReadonlyArray<Modality>;
  readonly prompt: string | null;
  readonly refImageAssetId: string | null;
  readonly refAudioAssetId: string | null;
  readonly videoConfig: VideoStartConfig | null;
  readonly audioConfig: AudioStartConfig | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePersonaInput {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string | null;
  readonly modalities: ReadonlyArray<Modality>;
  readonly prompt: string | null;
  readonly refImageAssetId: string | null;
  readonly refAudioAssetId: string | null;
  readonly videoConfig: VideoStartConfig | null;
  readonly audioConfig: AudioStartConfig | null;
}

export interface UpdatePersonaInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly modalities?: ReadonlyArray<Modality> | undefined;
  readonly prompt?: string | null | undefined;
  readonly refImageAssetId?: string | null | undefined;
  readonly refAudioAssetId?: string | null | undefined;
  readonly videoConfig?: VideoStartConfig | null | undefined;
  readonly audioConfig?: AudioStartConfig | null | undefined;
}

export interface PersonaRepositoryShape {
  readonly create: (input: CreatePersonaInput) => Effect.Effect<PersonaRecord, RepositoryError>;
  readonly getByIdForUser: (
    id: string,
    userId: string,
  ) => Effect.Effect<PersonaRecord | null, RepositoryError>;
  readonly listByUser: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<PersonaRecord>, RepositoryError>;
  readonly updateForUser: (
    id: string,
    userId: string,
    patch: UpdatePersonaInput,
  ) => Effect.Effect<PersonaRecord | null, RepositoryError>;
  readonly deleteForUser: (id: string, userId: string) => Effect.Effect<boolean, RepositoryError>;
}

export class PersonaRepository extends Context.Service<PersonaRepository, PersonaRepositoryShape>()(
  "@metamorph/api/services/PersonaRepository",
) {
  static readonly layerMemory = Layer.effect(
    PersonaRepository,
    Effect.gen(function* () {
      const ref = yield* Ref.make(new Map<string, PersonaRecord>());
      return PersonaRepository.of({
        create: (input) =>
          Effect.gen(function* () {
            const now = new Date(yield* Clock.currentTimeMillis);
            const record: PersonaRecord = { ...input, createdAt: now, updatedAt: now };
            yield* Ref.update(ref, (m) => new Map(m).set(record.id, record));
            return record;
          }),
        getByIdForUser: (id, userId) =>
          Ref.get(ref).pipe(
            Effect.map((m) => {
              const found = m.get(id);
              return found && found.userId === userId ? found : null;
            }),
          ),
        listByUser: (userId) =>
          Ref.get(ref).pipe(
            Effect.map((m) =>
              [...m.values()]
                .filter((r) => r.userId === userId)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
            ),
          ),
        updateForUser: (id, userId, patch) =>
          Effect.gen(function* () {
            const now = new Date(yield* Clock.currentTimeMillis);
            return yield* Ref.modify(ref, (m) => {
              const existing = m.get(id);
              if (!existing || existing.userId !== userId) return [null, m] as const;
              const updated: PersonaRecord = {
                ...existing,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.description !== undefined ? { description: patch.description } : {}),
                ...(patch.modalities !== undefined ? { modalities: patch.modalities } : {}),
                ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
                ...(patch.refImageAssetId !== undefined
                  ? { refImageAssetId: patch.refImageAssetId }
                  : {}),
                ...(patch.refAudioAssetId !== undefined
                  ? { refAudioAssetId: patch.refAudioAssetId }
                  : {}),
                ...(patch.videoConfig !== undefined ? { videoConfig: patch.videoConfig } : {}),
                ...(patch.audioConfig !== undefined ? { audioConfig: patch.audioConfig } : {}),
                updatedAt: now,
              };
              const next = new Map(m);
              next.set(id, updated);
              return [updated, next] as const;
            });
          }),
        deleteForUser: (id, userId) =>
          Ref.modify(ref, (m) => {
            const existing = m.get(id);
            if (!existing || existing.userId !== userId) return [false, m] as const;
            const next = new Map(m);
            next.delete(id);
            return [true, next] as const;
          }),
      });
    }),
  );

  static readonly layer = Layer.effect(
    PersonaRepository,
    Effect.gen(function* () {
      const db = yield* Database;

      return PersonaRepository.of({
        create: (input) =>
          db
            .insert(persona)
            .values({
              id: input.id,
              userId: input.userId,
              name: input.name,
              description: input.description,
              modalities: [...input.modalities],
              prompt: input.prompt,
              refImageAssetId: input.refImageAssetId,
              refAudioAssetId: input.refAudioAssetId,
              videoConfig: input.videoConfig,
              audioConfig: input.audioConfig,
            })
            .returning()
            .pipe(
              Effect.map((rows) => rows[0]!),
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
        getByIdForUser: (id, userId) =>
          db
            .select()
            .from(persona)
            .where(and(eq(persona.id, id), eq(persona.userId, userId)))
            .limit(1)
            .pipe(
              Effect.map((rows) => rows[0] ?? null),
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
        listByUser: (userId) =>
          db
            .select()
            .from(persona)
            .where(eq(persona.userId, userId))
            .orderBy(desc(persona.createdAt))
            .pipe(
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
        updateForUser: (id, userId, patch) =>
          db
            .update(persona)
            .set({
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.modalities !== undefined ? { modalities: [...patch.modalities] } : {}),
              ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
              ...(patch.refImageAssetId !== undefined
                ? { refImageAssetId: patch.refImageAssetId }
                : {}),
              ...(patch.refAudioAssetId !== undefined
                ? { refAudioAssetId: patch.refAudioAssetId }
                : {}),
              ...(patch.videoConfig !== undefined ? { videoConfig: patch.videoConfig } : {}),
              ...(patch.audioConfig !== undefined ? { audioConfig: patch.audioConfig } : {}),
            })
            .where(and(eq(persona.id, id), eq(persona.userId, userId)))
            .returning()
            .pipe(
              Effect.map((rows) => rows[0] ?? null),
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
        deleteForUser: (id, userId) =>
          db
            .delete(persona)
            .where(and(eq(persona.id, id), eq(persona.userId, userId)))
            .returning({ id: persona.id })
            .pipe(
              Effect.map((rows) => rows.length > 0),
              Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
            ),
      });
    }),
  );
}

const isUniqueViolation = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const obj = err as { code?: unknown; cause?: unknown };
  if (obj.code === "23505") return true;
  if (obj.cause && obj.cause !== err) return isUniqueViolation(obj.cause);
  return false;
};

const toEngineInstanceRecord = (row: typeof engineSession.$inferSelect): EngineInstanceRecord => ({
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
      listActive: () =>
        db
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

export interface UsageSummaryResult {
  readonly totalSessions: number;
  readonly activeSessionCount: number;
  readonly totalActiveSeconds: number;
  readonly totalEstimatedCostUsd: number;
  readonly byProvider: Record<
    string,
    { readonly sessions: number; readonly activeSeconds: number; readonly estimatedCostUsd: number }
  >;
  readonly byModality: Record<
    string,
    { readonly sessions: number; readonly activeSeconds: number; readonly estimatedCostUsd: number }
  >;
}

function aggregateUsageSummary(
  sessions: ReadonlyArray<EngineInstanceRecord>,
  nowMs: number,
): UsageSummaryResult {
  let activeSessionCount = 0;
  let totalActiveSeconds = 0;
  let totalEstimatedCostUsd = 0;
  const byProvider: Record<
    string,
    { sessions: number; activeSeconds: number; estimatedCostUsd: number }
  > = {};
  const byModality: Record<
    string,
    { sessions: number; activeSeconds: number; estimatedCostUsd: number }
  > = {};

  for (const s of sessions) {
    const isTerminal = TERMINAL_SESSION_STATUSES.has(s.status);
    if (!isTerminal) activeSessionCount += 1;

    const seconds = isTerminal
      ? s.activeSeconds
      : Math.max(0, Math.round((nowMs - s.createdAt.getTime()) / 1000));
    const cost = isTerminal
      ? s.estimatedCostUsd
      : Number(((seconds / 3600) * (s.hourlyRateUsd ?? 0)).toFixed(6));

    totalActiveSeconds += seconds;
    totalEstimatedCostUsd = Number((totalEstimatedCostUsd + cost).toFixed(6));

    const pBucket = (byProvider[s.provider] ??= {
      sessions: 0,
      activeSeconds: 0,
      estimatedCostUsd: 0,
    });
    pBucket.sessions += 1;
    pBucket.activeSeconds += seconds;
    pBucket.estimatedCostUsd = Number((pBucket.estimatedCostUsd + cost).toFixed(6));

    for (const m of s.modalities) {
      const mBucket = (byModality[m] ??= {
        sessions: 0,
        activeSeconds: 0,
        estimatedCostUsd: 0,
      });
      mBucket.sessions += 1;
      mBucket.activeSeconds += seconds;
      mBucket.estimatedCostUsd = Number((mBucket.estimatedCostUsd + cost).toFixed(6));
    }
  }

  return {
    totalSessions: sessions.length,
    activeSessionCount,
    totalActiveSeconds,
    totalEstimatedCostUsd,
    byProvider,
    byModality,
  };
}

export class UsageRepository extends Context.Service<
  UsageRepository,
  {
    readonly getSummary: (userId: string) => Effect.Effect<UsageSummaryResult, RepositoryError>;
  }
>()("@metamorph/api/services/UsageRepository") {
  static readonly layerFromStore = Layer.effect(
    UsageRepository,
    Effect.gen(function* () {
      const store = yield* InstanceStore;
      return UsageRepository.of({
        getSummary: (userId) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const rows = yield* store
              .listByUserId(userId, { includeEnded: true, limit: 1000 })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new RepositoryError({
                      message: `Failed to query usage: ${cause.message}`,
                      cause,
                    }),
                ),
              );
            return aggregateUsageSummary(rows, nowMs);
          }),
      });
    }),
  );

  static readonly layer = Layer.effect(
    UsageRepository,
    Effect.gen(function* () {
      const db = yield* Database;
      return UsageRepository.of({
        getSummary: (userId) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const rows = yield* db
              .select()
              .from(engineSession)
              .where(eq(engineSession.userId, userId))
              .pipe(
                Effect.mapError((cause) => new RepositoryError({ message: cause.message, cause })),
              );
            return aggregateUsageSummary(rows.map(toEngineInstanceRecord), nowMs);
          }),
      });
    }),
  );
}

export type { ProviderName };
