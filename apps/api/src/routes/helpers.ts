import type { AssetKind } from "@metamorph/shared";
import { Effect } from "effect";

import { BadRequest, NotFound, PayloadTooLarge, UnprocessableEntity } from "../api/index.ts";
import type { AssetRepository, MediaAssetRecord } from "../repositories/index.ts";

/** Maps a multipart stream error to `PayloadTooLarge` (413) or `BadRequest` (400). */
export function mapMultipartError(
  err: {
    readonly _tag: string;
    readonly message: string;
    readonly reason?: { readonly _tag: string };
  },
  tooLargePrefix: string,
): PayloadTooLarge | BadRequest {
  if (
    err._tag === "MultipartError" &&
    (err.reason?._tag === "FileTooLarge" || err.reason?._tag === "BodyTooLarge")
  ) {
    return new PayloadTooLarge({ message: `${tooLargePrefix}: ${err.message}` });
  }
  return new BadRequest({ message: `Invalid multipart upload: ${err.message}` });
}

/** Verifies an asset exists, belongs to `userId`, and matches `expectedKind`. */
export const assertOwnedAsset = (
  assets: AssetRepository["Service"],
  userId: string,
  assetId: string,
  expectedKind: AssetKind,
): Effect.Effect<MediaAssetRecord, NotFound | UnprocessableEntity> =>
  Effect.gen(function* () {
    const found = yield* assets.getByIdForUser(assetId, userId).pipe(Effect.orDie);
    if (!found) {
      return yield* new NotFound({
        message: `Referenced ${expectedKind} asset '${assetId}' not found.`,
      });
    }
    if (found.kind !== expectedKind) {
      return yield* new UnprocessableEntity({
        message: `Asset '${assetId}' has kind '${found.kind}', expected '${expectedKind}'.`,
      });
    }
    return found;
  });
