import { Schema } from "effect";

import { EngineConfigUpdateResponse } from "./engine-schemas.ts";

export const QualityTier = Schema.Literals(["standard", "high"]);
export type QualityTier = typeof QualityTier.Type;

export const ProviderName = Schema.Literals(["runpod", "vastai", "local"]);
export type ProviderName = typeof ProviderName.Type;

export const OrchestratedSessionStatus = Schema.Literals([
  "provisioning",
  "warming",
  "ready",
  "active",
  "disconnect_grace",
  "stopping",
  "stopped",
  "failed",
]);
export type OrchestratedSessionStatus = typeof OrchestratedSessionStatus.Type;

export const AssetKind = Schema.Literals(["ref_image", "ref_audio"]);
export type AssetKind = typeof AssetKind.Type;

export const SessionConnectionMode = Schema.Literals(["direct", "relay"]);
export type SessionConnectionMode = typeof SessionConnectionMode.Type;

export const SessionStatusEvent = Schema.Struct({
  type: Schema.Literal("session_status"),
  sessionId: Schema.String,
  status: OrchestratedSessionStatus,
  httpUrl: Schema.NullOr(Schema.String),
  wsUrl: Schema.NullOr(Schema.String),
  tlsSupported: Schema.Boolean,
  timestamp: Schema.String,
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const SessionReadyEvent = Schema.Struct({
  type: Schema.Literal("session_ready"),
  sessionId: Schema.String,
  status: OrchestratedSessionStatus,
  httpUrl: Schema.String,
  wsUrl: Schema.String,
  tlsSupported: Schema.Boolean,
  timestamp: Schema.String,
});

export const SessionConfigUpdatedEvent = Schema.Struct({
  type: Schema.Literal("session_config_updated"),
  sessionId: Schema.String,
  result: EngineConfigUpdateResponse,
  timestamp: Schema.String,
});

export const SessionStoppedEvent = Schema.Struct({
  type: Schema.Literal("session_stopped"),
  sessionId: Schema.String,
  reason: Schema.NullOr(Schema.String),
  activeSeconds: Schema.Int,
  estimatedCostUsd: Schema.Finite,
  timestamp: Schema.String,
});

export const SessionFailedEvent = Schema.Struct({
  type: Schema.Literal("session_failed"),
  sessionId: Schema.String,
  reason: Schema.String,
  activeSeconds: Schema.Int,
  estimatedCostUsd: Schema.Finite,
  timestamp: Schema.String,
});

export const SessionEvent = Schema.Union([
  SessionStatusEvent,
  SessionReadyEvent,
  SessionConfigUpdatedEvent,
  SessionStoppedEvent,
  SessionFailedEvent,
]);
export type SessionEvent = typeof SessionEvent.Type;

export const TERMINAL_SESSION_STATUSES: ReadonlySet<OrchestratedSessionStatus> = new Set([
  "stopped",
  "failed",
]);
