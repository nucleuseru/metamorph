import { InstanceStore, type EngineInstanceRecord } from "@metamorph/orchestrator";
import { TERMINAL_SESSION_STATUSES } from "@metamorph/shared";
import { eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";

import { engineSession } from "../db/schema.ts";
import { Database } from "../services/db.ts";
import { toEngineInstanceRecord } from "./instances.ts";
import { RepositoryError } from "./shared.ts";

interface UsageBucket {
  readonly sessions: number;
  readonly activeSeconds: number;
  readonly estimatedCostUsd: number;
}

interface UsageSummaryResult {
  readonly totalSessions: number;
  readonly activeSessionCount: number;
  readonly totalActiveSeconds: number;
  readonly totalEstimatedCostUsd: number;
  readonly byProvider: Record<string, UsageBucket>;
  readonly byModality: Record<string, UsageBucket>;
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
