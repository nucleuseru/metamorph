import {
  TERMINAL_SESSION_STATUSES,
  type Modality,
  type OrchestratedSessionStatus,
  type ProviderName,
  type QualityTier,
} from "@metamorph/shared";
import { Context, Effect, Layer, Ref } from "effect";

import { ActiveSessionConflictError, StoreError } from "./errors.ts";

export interface EngineInstanceRecord {
  readonly id: string;
  readonly userId: string;
  readonly personaId: string | null;
  readonly status: OrchestratedSessionStatus;
  readonly modalities: ReadonlyArray<Modality>;
  readonly quality: QualityTier;
  readonly provider: ProviderName;
  readonly providerInstanceId: string;
  readonly gpuType: string;
  readonly image: string;
  readonly httpUrl: string | null;
  readonly wsUrl: string | null;
  readonly tlsSupported: boolean;
  readonly webhookSecret: string;
  readonly hourlyRateUsd: number | null;
  readonly idleTimeoutS: number;
  readonly disconnectTimeoutS: number;
  readonly maxDurationS: number;
  readonly initialPrompt: string | null;
  readonly refImageAssetId: string | null;
  readonly refAudioAssetId: string | null;
  readonly failureReason: string | null;
  readonly readyAt: Date | null;
  readonly connectedAt: Date | null;
  readonly disconnectedAt: Date | null;
  readonly endedAt: Date | null;
  readonly activeSeconds: number;
  readonly estimatedCostUsd: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateInstanceRecord {
  readonly id: string;
  readonly userId: string;
  readonly personaId: string | null;
  readonly status: OrchestratedSessionStatus;
  readonly modalities: ReadonlyArray<Modality>;
  readonly quality: QualityTier;
  readonly provider: ProviderName;
  readonly providerInstanceId: string;
  readonly gpuType: string;
  readonly image: string;
  readonly httpUrl: string | null;
  readonly wsUrl: string | null;
  readonly tlsSupported: boolean;
  readonly webhookSecret: string;
  readonly hourlyRateUsd: number | null;
  readonly idleTimeoutS: number;
  readonly disconnectTimeoutS: number;
  readonly maxDurationS: number;
  readonly initialPrompt: string | null;
  readonly refImageAssetId: string | null;
  readonly refAudioAssetId: string | null;
}

export interface UpdateInstanceRecord {
  readonly status?: OrchestratedSessionStatus | undefined;
  readonly httpUrl?: string | null | undefined;
  readonly wsUrl?: string | null | undefined;
  readonly tlsSupported?: boolean | undefined;
  readonly failureReason?: string | null | undefined;
  readonly readyAt?: Date | null | undefined;
  readonly connectedAt?: Date | null | undefined;
  readonly disconnectedAt?: Date | null | undefined;
  readonly endedAt?: Date | null | undefined;
  readonly activeSeconds?: number | undefined;
  readonly estimatedCostUsd?: number | undefined;
}

export interface InstanceStoreShape {
  readonly create: (
    record: CreateInstanceRecord,
  ) => Effect.Effect<EngineInstanceRecord, ActiveSessionConflictError | StoreError>;
  readonly getById: (id: string) => Effect.Effect<EngineInstanceRecord | null, StoreError>;
  readonly findActiveByUserId: (
    userId: string,
  ) => Effect.Effect<EngineInstanceRecord | null, StoreError>;
  readonly listActive: Effect.Effect<ReadonlyArray<EngineInstanceRecord>, StoreError>;
  readonly listByUserId: (
    userId: string,
    options?: { readonly includeEnded?: boolean | undefined; readonly limit?: number | undefined },
  ) => Effect.Effect<ReadonlyArray<EngineInstanceRecord>, StoreError>;
  readonly update: (
    id: string,
    patch: UpdateInstanceRecord,
  ) => Effect.Effect<EngineInstanceRecord | null, StoreError>;
}

export class InstanceStore extends Context.Service<InstanceStore, InstanceStoreShape>()(
  "@metamorph/orchestrator/InstanceStore",
) {
  static readonly layerMemory = Layer.effect(
    InstanceStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make(new Map<string, EngineInstanceRecord>());

      const create: InstanceStoreShape["create"] = Effect.fn("InstanceStore.memory.create")(
        function* (input: CreateInstanceRecord) {
          const now = new Date();
          const record: EngineInstanceRecord = {
            ...input,
            failureReason: null,
            readyAt: null,
            connectedAt: null,
            disconnectedAt: null,
            endedAt: null,
            activeSeconds: 0,
            estimatedCostUsd: 0,
            createdAt: now,
            updatedAt: now,
          };

          const existingConflict = yield* Ref.modify(ref, (map) => {
            for (const item of map.values()) {
              if (item.userId === input.userId && !TERMINAL_SESSION_STATUSES.has(item.status)) {
                return [item.id, map] as const;
              }
            }
            const next = new Map(map);
            next.set(record.id, record);
            return [null, next] as const;
          });

          if (existingConflict !== null) {
            return yield* new ActiveSessionConflictError({
              userId: input.userId,
              existingSessionId: existingConflict,
              message: `User already has active session '${existingConflict}'.`,
            });
          }
          return record;
        },
      );

      const getById: InstanceStoreShape["getById"] = (id) =>
        Ref.get(ref).pipe(Effect.map((map) => map.get(id) ?? null));

      const findActiveByUserId: InstanceStoreShape["findActiveByUserId"] = (userId) =>
        Ref.get(ref).pipe(
          Effect.map((map) => {
            for (const item of map.values()) {
              if (item.userId === userId && !TERMINAL_SESSION_STATUSES.has(item.status)) {
                return item;
              }
            }
            return null;
          }),
        );

      const listActive: InstanceStoreShape["listActive"] = Ref.get(ref).pipe(
        Effect.map((map) =>
          [...map.values()].filter((item) => !TERMINAL_SESSION_STATUSES.has(item.status)),
        ),
      );

      const listByUserId: InstanceStoreShape["listByUserId"] = (userId, options) =>
        Ref.get(ref).pipe(
          Effect.map((map) => {
            const includeEnded = options?.includeEnded ?? true;
            const limit = options?.limit ?? 50;
            return [...map.values()]
              .filter(
                (item) =>
                  item.userId === userId &&
                  (includeEnded || !TERMINAL_SESSION_STATUSES.has(item.status)),
              )
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
              .slice(0, limit);
          }),
        );

      const update: InstanceStoreShape["update"] = (id, patch) =>
        Ref.modify(ref, (map) => {
          const existing = map.get(id);
          if (!existing) return [null, map] as const;
          const updated: EngineInstanceRecord = {
            ...existing,
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
            updatedAt: new Date(),
          };
          const next = new Map(map);
          next.set(id, updated);
          return [updated, next] as const;
        });

      return InstanceStore.of({
        create,
        getById,
        findActiveByUserId,
        listActive,
        listByUserId,
        update,
      });
    }),
  );
}
