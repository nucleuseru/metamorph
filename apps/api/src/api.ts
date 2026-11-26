import {
  AssetKind,
  AudioStartConfig,
  EngineConfigUpdateResponse,
  EngineSessionStatusResponse,
  Modality,
  OrchestratedSessionStatus,
  ProviderName,
  QualityTier,
  SessionConnectionMode,
  SessionEvent,
  VideoStartConfig,
} from "@metamorph/shared";
import { Schema } from "effect";
import { Multipart } from "effect/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";

import { AuthMiddleware } from "./middleware/auth.ts";

// --- HTTP Errors ---

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String, existingSessionId: Schema.optionalKey(Schema.String) },
  { httpApiStatus: 409 },
) {}

export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
  "PayloadTooLarge",
  { message: Schema.String },
  { httpApiStatus: 413 },
) {}

export class UnprocessableEntity extends Schema.TaggedError<UnprocessableEntity>()(
  "UnprocessableEntity",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

export class BadGateway extends Schema.TaggedError<BadGateway>()(
  "BadGateway",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  "ServiceUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

// --- System & Account Schemas ---

export const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
});

export const CurrentUserResponse = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  emailVerified: Schema.Boolean,
  image: Schema.NullOr(Schema.String),
});

export const PublicJwkEntry = Schema.Struct({
  kty: Schema.String,
  crv: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  kid: Schema.optionalKey(Schema.String),
  alg: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
});

export const EngineJwksResponse = Schema.Struct({
  keys: Schema.Array(PublicJwkEntry),
});

// --- Asset Schemas ---

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

export const AssetListResponse = Schema.Struct({
  assets: Schema.Array(MediaAssetResponse),
});

export const UploadAssetMultipart = Schema.Struct({
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

// --- Persona Schemas ---

export const CreatePersonaRequest = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  modalities: Schema.NonEmptyArray(Modality),
  prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refImageAssetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refAudioAssetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  videoConfig: Schema.optionalKey(Schema.NullOr(VideoStartConfig)),
  audioConfig: Schema.optionalKey(Schema.NullOr(AudioStartConfig)),
});

export const UpdatePersonaRequest = Schema.Struct({
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

export const PersonaListResponse = Schema.Struct({
  personas: Schema.Array(PersonaResponse),
});

// --- Session Schemas ---

export const CreateSessionRequest = Schema.Struct({
  modalities: Schema.optionalKey(Schema.NonEmptyArray(Modality)),
  quality: Schema.optionalKey(QualityTier),
  personaId: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  refImageAssetId: Schema.optionalKey(Schema.String),
  refAudioAssetId: Schema.optionalKey(Schema.String),
  refImageUrl: Schema.optionalKey(Schema.String),
  refAudioUrl: Schema.optionalKey(Schema.String),
  video: Schema.optionalKey(VideoStartConfig),
  audio: Schema.optionalKey(AudioStartConfig),
  providerOverride: Schema.optionalKey(ProviderName),
  gpuTypeOverride: Schema.optionalKey(Schema.String),
});

export const SessionConnectionInfo = Schema.Struct({
  mode: SessionConnectionMode,
  wsUrl: Schema.NullOr(Schema.String),
  directWsUrl: Schema.NullOr(Schema.String),
  relayWsUrl: Schema.String,
  httpUrl: Schema.NullOr(Schema.String),
  tlsSupported: Schema.Boolean,
  token: Schema.NullOr(Schema.String),
  tokenExpiresAt: Schema.NullOr(Schema.String),
});

export const SessionInitialConfig = Schema.Struct({
  prompt: Schema.NullOr(Schema.String),
  refImageUrl: Schema.NullOr(Schema.String),
  refAudioUrl: Schema.NullOr(Schema.String),
  video: Schema.NullOr(VideoStartConfig),
  audio: Schema.NullOr(AudioStartConfig),
});

export const SessionDetailResponse = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  personaId: Schema.NullOr(Schema.String),
  status: OrchestratedSessionStatus,
  modalities: Schema.Array(Modality),
  quality: QualityTier,
  provider: ProviderName,
  gpuType: Schema.String,
  image: Schema.String,
  hourlyRateUsd: Schema.NullOr(Schema.Number),
  idleTimeoutS: Schema.Int,
  disconnectTimeoutS: Schema.Int,
  maxDurationS: Schema.Int,
  failureReason: Schema.NullOr(Schema.String),
  activeSeconds: Schema.Int,
  estimatedCostUsd: Schema.Number,
  readyAt: Schema.NullOr(Schema.String),
  connectedAt: Schema.NullOr(Schema.String),
  disconnectedAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  connection: SessionConnectionInfo,
  initialConfig: SessionInitialConfig,
});
export type SessionDetailResponse = typeof SessionDetailResponse.Type;

export const SessionListResponse = Schema.Struct({
  sessions: Schema.Array(SessionDetailResponse),
});

export const SessionTokenRequest = Schema.Struct({
  modalities: Schema.optionalKey(Schema.NonEmptyArray(Modality)),
  ttlSeconds: Schema.optionalKey(Schema.Int),
});

export const SessionTokenResponse = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.String,
  instanceId: Schema.String,
  modalities: Schema.Array(Modality),
});

export const HotSwapConfigRequest = Schema.Struct({
  personaId: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refImageAssetId: Schema.optionalKey(Schema.String),
  refAudioAssetId: Schema.optionalKey(Schema.String),
  refImageUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refImageBase64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  clearRefImage: Schema.optionalKey(Schema.Boolean),
  refAudioUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refAudioBase64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  video: Schema.optionalKey(Schema.NullOr(VideoStartConfig)),
  audio: Schema.optionalKey(Schema.NullOr(AudioStartConfig)),
});

export const HotSwapAssetsMultipart = Schema.Struct({
  prompt: Schema.optionalKey(Schema.String),
  clear_ref_image: Schema.optionalKey(Schema.String),
  ref_image: Schema.optionalKey(Multipart.SingleFileSchema),
  ref_audio: Schema.optionalKey(Multipart.SingleFileSchema),
}).pipe(
  HttpApiSchema.asMultipartStream({
    maxFileSize: "26 MiB",
    maxTotalSize: "45 MiB",
    maxParts: 8,
  }),
);

// --- Usage Schemas ---

export const UsageBucket = Schema.Struct({
  sessions: Schema.Int,
  activeSeconds: Schema.Int,
  estimatedCostUsd: Schema.Number,
});

export const UsageSummaryResponse = Schema.Struct({
  totalSessions: Schema.Int,
  activeSessionCount: Schema.Int,
  totalActiveSeconds: Schema.Int,
  totalEstimatedCostUsd: Schema.Number,
  byProvider: Schema.Record(Schema.String, UsageBucket),
  byModality: Schema.Record(Schema.String, UsageBucket),
});

// --- API Groups ---

export class SystemGroup extends HttpApiGroup.make("system", { topLevel: true })
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: HealthResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("engineJwks", "/.well-known/engine-jwks.json", {
      success: EngineJwksResponse,
    }),
  ) {}

export class AccountGroup extends HttpApiGroup.make("account", { topLevel: true })
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: CurrentUserResponse,
    }),
  )
  .middleware(AuthMiddleware) {}

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

export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: CreateSessionRequest,
      success: SessionDetailResponse.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Forbidden, Conflict, NotFound, ServiceUnavailable, UnprocessableEntity],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: {
        includeEnded: Schema.optionalKey(Schema.Boolean),
        limit: Schema.optionalKey(Schema.Int),
      },
      success: SessionListResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("active", "/active", {
      success: Schema.NullOr(SessionDetailResponse),
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/:id", {
      params: { id: Schema.String },
      success: SessionDetailResponse,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("mintToken", "/:id/token", {
      params: { id: Schema.String },
      payload: Schema.optional(SessionTokenRequest),
      success: SessionTokenResponse,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    }),
  )
  .add(
    HttpApiEndpoint.get("engineStatus", "/:id/status", {
      params: { id: Schema.String },
      success: EngineSessionStatusResponse,
      error: [Forbidden, NotFound, Conflict, UnprocessableEntity, BadGateway],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateConfig", "/:id/config", {
      params: { id: Schema.String },
      payload: HotSwapConfigRequest,
      success: EngineConfigUpdateResponse,
      error: [BadRequest, Forbidden, NotFound, Conflict, UnprocessableEntity, BadGateway],
    }),
  )
  .add(
    HttpApiEndpoint.post("uploadAssets", "/:id/assets", {
      params: { id: Schema.String },
      payload: HotSwapAssetsMultipart,
      success: EngineConfigUpdateResponse,
      error: [
        BadRequest,
        Forbidden,
        NotFound,
        Conflict,
        PayloadTooLarge,
        UnprocessableEntity,
        BadGateway,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("stop", "/:id", {
      params: { id: Schema.String },
      success: SessionDetailResponse,
      error: [NotFound, BadGateway],
    }),
  )
  .add(
    HttpApiEndpoint.get("events", "/:id/events", {
      params: { id: Schema.String },
      success: HttpApiSchema.StreamSse({
        data: SessionEvent,
        keepAlive: "15 seconds",
      }),
      error: NotFound,
    }),
  )
  .prefix("/sessions")
  .middleware(AuthMiddleware) {}

export class UsageGroup extends HttpApiGroup.make("usage")
  .add(
    HttpApiEndpoint.get("summary", "/summary", {
      success: UsageSummaryResponse,
    }),
  )
  .prefix("/usage")
  .middleware(AuthMiddleware) {}

export class Api extends HttpApi.make("metamorph-api")
  .add(SystemGroup)
  .add(AccountGroup)
  .add(AssetsGroup)
  .add(PersonasGroup)
  .add(SessionsGroup)
  .add(UsageGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Metamorph API",
      version: "0.2.0",
    }),
  ) {}
