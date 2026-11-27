import type { AudioStartConfig, Modality, VideoStartConfig } from "@metamorph/shared";
import { and, desc, eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Ref } from "effect";

import { persona } from "../db/schema.ts";
import { Database } from "../services/db.ts";
import {
  RepositoryError,
  firstOrNull,
  getForUserInMemory,
  listByUserInMemory,
  toRepoError,
} from "./shared.ts";

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

interface CreatePersonaInput {
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

interface UpdatePersonaInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly modalities?: ReadonlyArray<Modality> | undefined;
  readonly prompt?: string | null | undefined;
  readonly refImageAssetId?: string | null | undefined;
  readonly refAudioAssetId?: string | null | undefined;
  readonly videoConfig?: VideoStartConfig | null | undefined;
  readonly audioConfig?: AudioStartConfig | null | undefined;
}

const buildPersonaPatch = (patch: UpdatePersonaInput) => ({
  ...(patch.name !== undefined ? { name: patch.name } : {}),
  ...(patch.description !== undefined ? { description: patch.description } : {}),
  ...(patch.modalities !== undefined ? { modalities: [...patch.modalities] } : {}),
  ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
  ...(patch.refImageAssetId !== undefined ? { refImageAssetId: patch.refImageAssetId } : {}),
  ...(patch.refAudioAssetId !== undefined ? { refAudioAssetId: patch.refAudioAssetId } : {}),
  ...(patch.videoConfig !== undefined ? { videoConfig: patch.videoConfig } : {}),
  ...(patch.audioConfig !== undefined ? { audioConfig: patch.audioConfig } : {}),
});

interface PersonaRepositoryShape {
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
        getByIdForUser: (id, userId) => getForUserInMemory(ref, id, userId),
        listByUser: (userId) => listByUserInMemory(ref, userId),
        updateForUser: (id, userId, patch) =>
          Effect.gen(function* () {
            const now = new Date(yield* Clock.currentTimeMillis);
            return yield* Ref.modify(ref, (m) => {
              const existing = m.get(id);
              if (!existing || existing.userId !== userId) return [null, m] as const;
              const updated: PersonaRecord = {
                ...existing,
                ...buildPersonaPatch(patch),
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
          firstOrNull(
            db
              .select()
              .from(persona)
              .where(and(eq(persona.id, id), eq(persona.userId, userId)))
              .limit(1),
          ),
        listByUser: (userId) =>
          db
            .select()
            .from(persona)
            .where(eq(persona.userId, userId))
            .orderBy(desc(persona.createdAt))
            .pipe(Effect.mapError(toRepoError)),
        updateForUser: (id, userId, patch) =>
          firstOrNull(
            db
              .update(persona)
              .set(buildPersonaPatch(patch))
              .where(and(eq(persona.id, id), eq(persona.userId, userId)))
              .returning(),
          ),
        deleteForUser: (id, userId) =>
          db
            .delete(persona)
            .where(and(eq(persona.id, id), eq(persona.userId, userId)))
            .returning({ id: persona.id })
            .pipe(
              Effect.map((rows) => rows.length > 0),
              Effect.mapError(toRepoError),
            ),
      });
    }),
  );
}
