import { Effect } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpApiBuilder } from "effect/http-api";

import { Api, NotFound, type PersonaResponse } from "../api/index.ts";
import { CurrentSession } from "../middleware/auth.ts";
import { AssetRepository, PersonaRepository, type PersonaRecord } from "../repositories/index.ts";
import { ObjectStorage } from "../services/storage.ts";
import { assertOwnedAsset } from "./helpers.ts";

export const PersonasHandlers = HttpApiBuilder.group(
  Api,
  "personas",
  Effect.fn(function* (handlers) {
    const personas = yield* PersonaRepository;
    const assets = yield* AssetRepository;
    const storage = yield* ObjectStorage;

    const resolveAssetUrl = Effect.fnUntraced(function* (assetId: string | null, userId: string) {
      if (!assetId) return null;
      const asset = yield* assets.getByIdForUser(assetId, userId).pipe(Effect.orDie);
      if (!asset) return null;
      return yield* storage
        .getSignedDownloadUrl({ assetId: asset.id, storageKey: asset.storageKey })
        .pipe(Effect.orElseSucceed(() => null));
    });

    const formatPersona = Effect.fnUntraced(function* (
      record: PersonaRecord,
    ): Effect.fn.Return<PersonaResponse> {
      const [refImageUrl, refAudioUrl] = yield* Effect.all([
        resolveAssetUrl(record.refImageAssetId, record.userId),
        resolveAssetUrl(record.refAudioAssetId, record.userId),
      ]);
      return {
        id: record.id,
        name: record.name,
        description: record.description,
        modalities: [...record.modalities],
        prompt: record.prompt,
        refImageAssetId: record.refImageAssetId,
        refImageUrl,
        refAudioAssetId: record.refAudioAssetId,
        refAudioUrl,
        videoConfig: record.videoConfig,
        audioConfig: record.audioConfig,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      };
    });

    const validateAssetOwnership = (
      userId: string,
      assetId: string | null | undefined,
      expectedKind: "ref_image" | "ref_audio",
    ) =>
      assetId
        ? assertOwnedAsset(assets, userId, assetId, expectedKind).pipe(Effect.asVoid)
        : Effect.void;

    return handlers.handleAll({
      create: ({ payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;

          yield* validateAssetOwnership(user.id, payload.refImageAssetId, "ref_image");
          yield* validateAssetOwnership(user.id, payload.refAudioAssetId, "ref_audio");

          const created = yield* personas
            .create({
              id: SecureRandom.uuidV4Unsafe(),
              userId: user.id,
              name: payload.name,
              description: payload.description ?? null,
              modalities: payload.modalities,
              prompt: payload.prompt ?? null,
              refImageAssetId: payload.refImageAssetId ?? null,
              refAudioAssetId: payload.refAudioAssetId ?? null,
              videoConfig: payload.videoConfig ?? null,
              audioConfig: payload.audioConfig ?? null,
            })
            .pipe(Effect.orDie);

          return yield* formatPersona(created);
        }),

      list: () =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const rows = yield* personas.listByUser(user.id).pipe(Effect.orDie);
          const formatted = yield* Effect.forEach(rows, formatPersona, { concurrency: 8 });
          return { personas: formatted };
        }),

      get: ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const found = yield* personas.getByIdForUser(params.id, user.id).pipe(Effect.orDie);
          if (!found) {
            return yield* new NotFound({ message: `Persona '${params.id}' not found.` });
          }
          return yield* formatPersona(found);
        }),

      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          if (payload.refImageAssetId !== undefined) {
            yield* validateAssetOwnership(user.id, payload.refImageAssetId, "ref_image");
          }
          if (payload.refAudioAssetId !== undefined) {
            yield* validateAssetOwnership(user.id, payload.refAudioAssetId, "ref_audio");
          }

          const updated = yield* personas
            .updateForUser(params.id, user.id, {
              name: payload.name,
              description: payload.description,
              modalities: payload.modalities,
              prompt: payload.prompt,
              refImageAssetId: payload.refImageAssetId,
              refAudioAssetId: payload.refAudioAssetId,
              videoConfig: payload.videoConfig,
              audioConfig: payload.audioConfig,
            })
            .pipe(Effect.orDie);

          if (!updated) {
            return yield* new NotFound({ message: `Persona '${params.id}' not found.` });
          }
          return yield* formatPersona(updated);
        }),

      remove: ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const deleted = yield* personas.deleteForUser(params.id, user.id).pipe(Effect.orDie);
          if (!deleted) {
            return yield* new NotFound({ message: `Persona '${params.id}' not found.` });
          }
        }),
    });
  }),
);
