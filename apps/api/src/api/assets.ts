import { AssetKind } from "@metamorph/shared";
import { Schema } from "effect";
import { Multipart } from "effect/http";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { AuthMiddleware } from "../middleware/auth.ts";
import { BadRequest, NotFound, PayloadTooLarge, UnprocessableEntity } from "./errors.ts";

export const MediaAssetResponse = Schema.Struct({
  id: Schema.String,
  kind: AssetKind,
  name: Schema.String,
  mimeType: Schema.String,
  byteSize: Schema.Int,
  sha256: Schema.String,
  downloadUrl: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type MediaAssetResponse = typeof MediaAssetResponse.Type;

const AssetListResponse = Schema.Struct({
  assets: Schema.Array(MediaAssetResponse),
});

const UploadAssetMultipart = Schema.Struct({
  kind: AssetKind,
  name: Schema.optionalKey(Schema.String),
  file: Multipart.SingleFileSchema,
}).pipe(
  HttpApiSchema.asMultipartStream({
    maxFileSize: "26 MiB",
    maxTotalSize: "27 MiB",
    maxParts: 8,
  }),
);

export class AssetsGroup extends HttpApiGroup.make("assets")
  .add(
    HttpApiEndpoint.post("upload", "/", {
      payload: UploadAssetMultipart,
      success: MediaAssetResponse.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, PayloadTooLarge, UnprocessableEntity],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: { kind: Schema.optionalKey(AssetKind) },
      success: AssetListResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schema.String },
      success: MediaAssetResponse,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }),
  )
  .prefix("/assets")
  .middleware(AuthMiddleware) {}
