import type { AssetKind } from "@metamorph/shared";
import { and, desc, eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Ref } from "effect";

import { mediaAsset } from "../db/schema.ts";
import { Database } from "../services/db.ts";
import {
  RepositoryError,
  firstOrNull,
  getForUserInMemory,
  listByUserInMemory,
  toRepoError,
} from "./shared.ts";

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

interface CreateMediaAssetInput {
  readonly id: string;
  readonly userId: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly storageKey: string;
  readonly sha256: string;
}

interface AssetRepositoryShape {
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
    kind?: AssetKind,
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
        getByIdForUser: (id, userId) => getForUserInMemory(ref, id, userId),
        listByUser: (userId, kind) =>
          listByUserInMemory(ref, userId, kind === undefined ? undefined : (r) => r.kind === kind),
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
          firstOrNull(db.select().from(mediaAsset).where(eq(mediaAsset.id, id)).limit(1)),
        getByIdForUser: (id, userId) =>
          firstOrNull(
            db
              .select()
              .from(mediaAsset)
              .where(and(eq(mediaAsset.id, id), eq(mediaAsset.userId, userId)))
              .limit(1),
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
            .pipe(Effect.mapError(toRepoError)),
        deleteForUser: (id, userId) =>
          firstOrNull(
            db
              .delete(mediaAsset)
              .where(and(eq(mediaAsset.id, id), eq(mediaAsset.userId, userId)))
              .returning(),
          ),
      });
    }),
  );
}
