import {
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
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { AuthMiddleware } from "../middleware/auth.ts";
import {
  BadGateway,
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  PayloadTooLarge,
  ServiceUnavailable,
  UnprocessableEntity,
} from "./errors.ts";

const CreateSessionRequest = Schema.Struct({
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

const SessionConnectionInfo = Schema.Struct({
  mode: SessionConnectionMode,
  wsUrl: Schema.NullOr(Schema.String),
  directWsUrl: Schema.NullOr(Schema.String),
  relayWsUrl: Schema.String,
  httpUrl: Schema.NullOr(Schema.String),
  tlsSupported: Schema.Boolean,
  token: Schema.NullOr(Schema.String),
  tokenExpiresAt: Schema.NullOr(Schema.String),
});

const SessionInitialConfig = Schema.Struct({
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
  hourlyRateUsd: Schema.NullOr(Schema.Finite),
  idleTimeoutS: Schema.Int,
  disconnectTimeoutS: Schema.Int,
  maxDurationS: Schema.Int,
  failureReason: Schema.NullOr(Schema.String),
  activeSeconds: Schema.Int,
  estimatedCostUsd: Schema.Finite,
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

const SessionListResponse = Schema.Struct({
  sessions: Schema.Array(SessionDetailResponse),
});

const SessionTokenRequest = Schema.Struct({
  modalities: Schema.optionalKey(Schema.NonEmptyArray(Modality)),
  ttlSeconds: Schema.optionalKey(Schema.Int),
});

const SessionTokenResponse = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.String,
  instanceId: Schema.String,
  modalities: Schema.Array(Modality),
});

const HotSwapConfigRequest = Schema.Struct({
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

const HotSwapAssetsMultipart = Schema.Struct({
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
