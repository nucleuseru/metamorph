import { createHash } from "node:crypto";

import { AssetKind } from "@metamorph/shared";
import { Effect, Schema, Stream } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import {
  Api,
  BadRequest,
  NotFound,
  PayloadTooLarge,
  UnprocessableEntity,
  type MediaAssetResponse,
} from "../api/index.ts";
import { CurrentSession } from "../middleware/auth.ts";
import { AssetRepository, type MediaAssetRecord } from "../repositories/index.ts";
import { ObjectStorage } from "../services/storage.ts";
import { mapMultipartError } from "./helpers.ts";

const MAX_REF_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REF_AUDIO_BYTES = 25 * 1024 * 1024;

const ALLOWED_IMAGE_MIME: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

const ALLOWED_AUDIO_MIME: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/flac",
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
]);

const MIME_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/webm": "webm",
};

const decodeAssetKind = Schema.decodeUnknownEffect(AssetKind);

const formatAssetResponse = (
  record: MediaAssetRecord,
  downloadUrl: string,
): MediaAssetResponse => ({
  id: record.id,
  kind: record.kind,
  name: record.name,
  mimeType: record.mimeType,
  byteSize: record.byteSize,
  sha256: record.sha256,
  downloadUrl,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const normalizeMime = (raw: string): string => raw.split(";")[0]?.trim().toLowerCase() ?? "";

export const AssetsHandlers = HttpApiBuilder.group(
  Api,
  "assets",
  Effect.fn(function* (handlers) {
    const assets = yield* AssetRepository;
    const storage = yield* ObjectStorage;

    return handlers.handleAll({
      upload: ({ payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;

          let kindValue: string | undefined;
          let customName: string | undefined;
          let fileName: string | undefined;
          let fileMime = "";
          let fileBytes: Uint8Array | undefined;

          yield* Stream.runForEach(payload, (part) =>
            Effect.gen(function* () {
              if (part._tag === "Field") {
                if (part.key === "kind") kindValue = part.value.trim();
                if (part.key === "name") customName = part.value.trim();
                return;
              }
              if (part.key === "file") {
                fileName = part.name;
                fileMime = normalizeMime(part.contentType);
                fileBytes = yield* part.contentEffect;
              }
            }),
          ).pipe(Effect.mapError((err) => mapMultipartError(err, "Asset upload too large")));

          if (!kindValue) {
            return yield* new BadRequest({ message: "Missing required multipart field 'kind'." });
          }

          const kind = yield* decodeAssetKind(kindValue).pipe(
            Effect.mapError(
              () =>
                new UnprocessableEntity({
                  message: `Invalid asset kind '${kindValue}'. Expected 'ref_image' or 'ref_audio'.`,
                }),
            ),
          );

          if (!fileBytes || fileBytes.byteLength === 0) {
            return yield* new BadRequest({ message: "Missing or empty 'file' upload part." });
          }

          const maxBytes = kind === "ref_image" ? MAX_REF_IMAGE_BYTES : MAX_REF_AUDIO_BYTES;
          if (fileBytes.byteLength > maxBytes) {
            return yield* new PayloadTooLarge({
              message: `File exceeds maximum allowed size of ${maxBytes} bytes for '${kind}'.`,
            });
          }

          const allowed = kind === "ref_image" ? ALLOWED_IMAGE_MIME : ALLOWED_AUDIO_MIME;
          if (!allowed.has(fileMime)) {
            return yield* new UnprocessableEntity({
              message: `Unsupported MIME type '${fileMime || "unknown"}' for '${kind}'.`,
            });
          }

          const assetId = SecureRandom.uuidV4Unsafe();
          const ext = MIME_EXT[fileMime] ?? "bin";
          const storageKey = `${user.id}/${kind}/${assetId}.${ext}`;
          const sha256 = createHash("sha256").update(fileBytes).digest("hex");
          const displayName =
            customName && customName.length > 0
              ? customName
              : fileName && fileName.length > 0
                ? fileName
                : `${kind}-${assetId}.${ext}`;

          yield* storage
            .put({ key: storageKey, bytes: fileBytes, contentType: fileMime })
            .pipe(Effect.orDie);

          const created = yield* assets
            .create({
              id: assetId,
              userId: user.id,
              kind,
              name: displayName,
              mimeType: fileMime,
              byteSize: fileBytes.byteLength,
              storageKey,
              sha256,
            })
            .pipe(
              Effect.onError(() => storage.delete(storageKey).pipe(Effect.ignore)),
              Effect.orDie,
            );

          const downloadUrl = yield* storage
            .getSignedDownloadUrl({
              assetId: created.id,
              storageKey: created.storageKey,
            })
            .pipe(Effect.orDie);

          return formatAssetResponse(created, downloadUrl);
        }),

      list: ({ query }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const rows = yield* assets.listByUser(user.id, query.kind).pipe(Effect.orDie);
          const result = yield* Effect.forEach(
            rows,
            (row) =>
              storage
                .getSignedDownloadUrl({ assetId: row.id, storageKey: row.storageKey })
                .pipe(Effect.map((url) => formatAssetResponse(row, url))),
            { concurrency: 8 },
          ).pipe(Effect.orDie);
          return { assets: result };
        }),

      get: ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const found = yield* assets.getByIdForUser(params.id, user.id).pipe(Effect.orDie);
          if (!found) {
            return yield* new NotFound({ message: `Asset '${params.id}' not found.` });
          }
          const downloadUrl = yield* storage
            .getSignedDownloadUrl({ assetId: found.id, storageKey: found.storageKey })
            .pipe(Effect.orDie);
          return formatAssetResponse(found, downloadUrl);
        }),

      remove: ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const deleted = yield* assets.deleteForUser(params.id, user.id).pipe(Effect.orDie);
          if (!deleted) {
            return yield* new NotFound({ message: `Asset '${params.id}' not found.` });
          }
          yield* storage.delete(deleted.storageKey).pipe(Effect.ignore);
        }),
    });
  }),
);

/** Signed content-serving route for in-memory test `ObjectStorage` URLs (`GET /assets/:id/content`). */
export const AssetContentRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    const assets = yield* AssetRepository;

    return yield* router.add(
      "GET",
      "/assets/:id/content",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = yield* HttpRouter.params;

        const id = params["id"];
        if (!id) {
          return HttpServerResponse.text("Missing asset id", { status: 400 });
        }

        const url = HttpServerRequest.toURL(request);
        if (url._tag === "None") {
          return HttpServerResponse.text("Invalid request URL", { status: 400 });
        }
        const expiresRaw = url.value.searchParams.get("expires");
        const sig = url.value.searchParams.get("sig");
        const expires = expiresRaw ? Number.parseInt(expiresRaw, 10) : Number.NaN;
        if (!sig || !Number.isFinite(expires)) {
          return HttpServerResponse.text("Missing signed URL parameters", { status: 401 });
        }

        const valid = yield* storage.verifyLocalSignedUrl({ assetId: id, expires, sig });
        if (!valid) {
          return HttpServerResponse.text("Invalid or expired signed asset URL", { status: 403 });
        }

        const record = yield* assets.getById(id);
        if (!record) {
          return HttpServerResponse.text("Asset not found", { status: 404 });
        }

        const obj = yield* storage.get(record.storageKey);
        return HttpServerResponse.uint8Array(obj.bytes, {
          status: 200,
          contentType: record.mimeType,
          headers: {
            "cache-control": "private, max-age=60",
          },
        });
      }).pipe(
        Effect.catch((err) =>
          Effect.logError("Failed serving signed asset content", err).pipe(
            Effect.as(HttpServerResponse.text("Not found", { status: 404 })),
          ),
        ),
      ),
    );
  }),
);
