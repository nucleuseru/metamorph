import { AudioStartConfig, Modality, VideoStartConfig } from "@metamorph/shared";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { AuthMiddleware } from "../middleware/auth.ts";
import { BadRequest, NotFound, UnprocessableEntity } from "./errors.ts";

const CreatePersonaRequest = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  modalities: Schema.NonEmptyArray(Modality),
  prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refImageAssetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refAudioAssetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  videoConfig: Schema.optionalKey(Schema.NullOr(VideoStartConfig)),
  audioConfig: Schema.optionalKey(Schema.NullOr(AudioStartConfig)),
});

const UpdatePersonaRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.NonEmptyString),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  modalities: Schema.optionalKey(Schema.NonEmptyArray(Modality)),
  prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refImageAssetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refAudioAssetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  videoConfig: Schema.optionalKey(Schema.NullOr(VideoStartConfig)),
  audioConfig: Schema.optionalKey(Schema.NullOr(AudioStartConfig)),
});

export const PersonaResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  modalities: Schema.Array(Modality),
  prompt: Schema.NullOr(Schema.String),
  refImageAssetId: Schema.NullOr(Schema.String),
  refImageUrl: Schema.NullOr(Schema.String),
  refAudioAssetId: Schema.NullOr(Schema.String),
  refAudioUrl: Schema.NullOr(Schema.String),
  videoConfig: Schema.NullOr(VideoStartConfig),
  audioConfig: Schema.NullOr(AudioStartConfig),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PersonaResponse = typeof PersonaResponse.Type;

const PersonaListResponse = Schema.Struct({
  personas: Schema.Array(PersonaResponse),
});

export class PersonasGroup extends HttpApiGroup.make("personas")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: CreatePersonaRequest,
      success: PersonaResponse.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, UnprocessableEntity],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/", {
      success: PersonaListResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schema.String },
      success: PersonaResponse,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/:id", {
      params: { id: Schema.String },
      payload: UpdatePersonaRequest,
      success: PersonaResponse,
      error: [BadRequest, NotFound, UnprocessableEntity],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }),
  )
  .prefix("/personas")
  .middleware(AuthMiddleware) {}
