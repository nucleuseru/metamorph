import { Schema } from "effect";

export const Modality = Schema.Literals(["voice", "video"]);
export type Modality = typeof Modality.Type;

export const VideoCodecName = Schema.Literals(["mjpeg"]);
export type VideoCodecName = typeof VideoCodecName.Type;

export const AudioCodecName = Schema.Literals(["pcm_s16le"]);
export type AudioCodecName = typeof AudioCodecName.Type;

export const DetectionMode = Schema.Literals(["off", "near", "full"]);
export type DetectionMode = typeof DetectionMode.Type;

export const EngineLifecycleState = Schema.Literals([
  "booting",
  "ready_idle",
  "active",
  "disconnect_grace",
  "shutting_down",
]);
export type EngineLifecycleState = typeof EngineLifecycleState.Type;

export const VideoStartConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  input_codec: Schema.optionalKey(VideoCodecName),
  output_codec: Schema.optionalKey(VideoCodecName),
  width: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  height: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  fps: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  num_inference_steps: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  seed: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  output_quality: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  detection_mode: Schema.optionalKey(Schema.NullOr(DetectionMode)),
  use_pe: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  freeze_kv_on_static: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  static_diff_thresh: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  kv_reset_frames: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});
export type VideoStartConfig = typeof VideoStartConfig.Type;

export const AudioStartConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  input_codec: Schema.optionalKey(AudioCodecName),
  output_codec: Schema.optionalKey(AudioCodecName),
  input_sample_rate: Schema.optionalKey(Schema.Int),
  output_sample_rate: Schema.optionalKey(Schema.Int),
  diffusion_steps: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  cfg_rate: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  block_time_s: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  vad_threshold_db: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  passthrough: Schema.optionalKey(Schema.Boolean),
});
export type AudioStartConfig = typeof AudioStartConfig.Type;

export const SessionConfigPatch = Schema.Struct({
  prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_image_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_image_base64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  clear_ref_image: Schema.optionalKey(Schema.Boolean),
  ref_audio_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_audio_base64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  video: Schema.optionalKey(Schema.NullOr(VideoStartConfig)),
  audio: Schema.optionalKey(Schema.NullOr(AudioStartConfig)),
});
export type SessionConfigPatch = typeof SessionConfigPatch.Type;

export const BootstrapStatus = Schema.Struct({
  has_prompt: Schema.Boolean,
  prompt_preview: Schema.optionalKey(Schema.NullOr(Schema.String)),
  has_ref_image: Schema.Boolean,
  has_ref_audio: Schema.Boolean,
  voice_ready: Schema.Boolean,
  video_ready: Schema.Boolean,
});
export type BootstrapStatus = typeof BootstrapStatus.Type;

export const SyncTelemetry = Schema.Struct({
  sync_active: Schema.Boolean,
  video_latency_ms: Schema.Finite,
  audio_latency_ms: Schema.Finite,
  target_latency_ms: Schema.Finite,
  offset_ms: Schema.Finite,
  audio_hold_ms: Schema.Finite,
  video_hold_ms: Schema.Finite,
});
export type SyncTelemetry = typeof SyncTelemetry.Type;

export const EngineHealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  instance_id: Schema.String,
  backend: Schema.Literals(["gpu", "mock"]),
  enabled_modalities: Schema.Array(Modality),
});
export type EngineHealthResponse = typeof EngineHealthResponse.Type;

export const EngineReadyResponse = Schema.Struct({
  status: Schema.Literals(["warming", "ready", "shutting_down"]),
  lifecycle_state: Schema.String,
  instance_id: Schema.String,
  enabled_modalities: Schema.Array(Modality),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type EngineReadyResponse = typeof EngineReadyResponse.Type;

export const EngineSessionStatusResponse = Schema.Struct({
  instance_id: Schema.String,
  user_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lifecycle_state: Schema.String,
  enabled_modalities: Schema.Array(Modality),
  connected: Schema.Boolean,
  active_session_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  disconnect_countdown_s: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  idle_countdown_s: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  assets: BootstrapStatus,
  sync: SyncTelemetry,
});
export type EngineSessionStatusResponse = typeof EngineSessionStatusResponse.Type;

export const EngineConfigUpdateResponse = Schema.Struct({
  ok: Schema.Boolean,
  hot_swapped: Schema.Boolean,
  assets: BootstrapStatus,
});
export type EngineConfigUpdateResponse = typeof EngineConfigUpdateResponse.Type;

export const EngineShutdownResponse = Schema.Struct({
  status: Schema.Literal("shutting_down"),
  reason: Schema.String,
});
export type EngineShutdownResponse = typeof EngineShutdownResponse.Type;

export const EngineWsClientAuthMessage = Schema.Struct({
  type: Schema.Literal("auth"),
  token: Schema.String,
});

export const EngineWsClientAuthRefreshMessage = Schema.Struct({
  type: Schema.Literal("auth_refresh"),
  token: Schema.String,
});

export const EngineWsClientStartMessage = Schema.Struct({
  type: Schema.Literal("start"),
  session_id: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_image_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_image_base64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  clear_ref_image: Schema.optionalKey(Schema.Boolean),
  ref_audio_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_audio_base64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  video: Schema.optionalKey(Schema.NullOr(VideoStartConfig)),
  audio: Schema.optionalKey(Schema.NullOr(AudioStartConfig)),
});

export const EngineWsClientUpdateConfigMessage = Schema.Struct({
  type: Schema.Literal("update_config"),
  prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_image_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_image_base64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  clear_ref_image: Schema.optionalKey(Schema.Boolean),
  ref_audio_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref_audio_base64: Schema.optionalKey(Schema.NullOr(Schema.String)),
  video: Schema.optionalKey(Schema.NullOr(VideoStartConfig)),
  audio: Schema.optionalKey(Schema.NullOr(AudioStartConfig)),
});

export const EngineWsClientPingMessage = Schema.Struct({
  type: Schema.Literal("ping"),
  t: Schema.optionalKey(Schema.Unknown),
});

export const EngineWsClientStopMessage = Schema.Struct({
  type: Schema.Literal("stop"),
});

export const EngineWsClientMessage = Schema.Union([
  EngineWsClientAuthMessage,
  EngineWsClientAuthRefreshMessage,
  EngineWsClientStartMessage,
  EngineWsClientUpdateConfigMessage,
  EngineWsClientPingMessage,
  EngineWsClientStopMessage,
]);
export type EngineWsClientMessage = typeof EngineWsClientMessage.Type;

export const EngineWsServerAuthOkMessage = Schema.Struct({
  type: Schema.Literal("auth_ok"),
  user_id: Schema.String,
  instance_id: Schema.String,
  authorized_modalities: Schema.Array(Modality),
  enabled_modalities: Schema.Array(Modality),
  assets: BootstrapStatus,
});

export const EngineWsServerStartedMessage = Schema.Struct({
  type: Schema.Literal("started"),
  session_id: Schema.String,
  voice_active: Schema.Boolean,
  video_active: Schema.Boolean,
  video_config: Schema.NullOr(
    Schema.Struct({
      input_codec: VideoCodecName,
      output_codec: VideoCodecName,
      width: Schema.Int,
      height: Schema.Int,
      fps: Schema.Int,
      detection_mode: Schema.optionalKey(DetectionMode),
    }),
  ),
  audio_config: Schema.NullOr(
    Schema.Struct({
      input_codec: AudioCodecName,
      output_codec: AudioCodecName,
      input_sample_rate: Schema.Int,
      output_sample_rate: Schema.Int,
      block_time_s: Schema.Finite,
    }),
  ),
  assets: BootstrapStatus,
});

export const EngineWsServerConfigUpdatedMessage = Schema.Struct({
  type: Schema.Literal("config_updated"),
  ok: Schema.Boolean,
  hot_swapped: Schema.Boolean,
  assets: BootstrapStatus,
});

export const EngineWsServerPongMessage = Schema.Struct({
  type: Schema.Literal("pong"),
  t: Schema.optionalKey(Schema.Unknown),
  ts: Schema.Finite,
});

export const EngineWsServerSyncStatsMessage = Schema.Struct({
  type: Schema.Literal("sync_stats"),
  frames_in_video: Schema.Int,
  frames_in_audio: Schema.Int,
  frames_out_video: Schema.Int,
  frames_out_audio: Schema.Int,
  sync_active: Schema.Boolean,
  video_latency_ms: Schema.Finite,
  audio_latency_ms: Schema.Finite,
  target_latency_ms: Schema.Finite,
  offset_ms: Schema.Finite,
  audio_hold_ms: Schema.Finite,
  video_hold_ms: Schema.Finite,
});

export const EngineWsServerWaitingFaceMessage = Schema.Struct({
  type: Schema.Literal("waiting_face"),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const EngineWsServerNoPersonMessage = Schema.Struct({
  type: Schema.Literal("no_person"),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const EngineWsServerEditingMessage = Schema.Struct({
  type: Schema.Literal("editing"),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const EngineWsServerDroppedMessage = Schema.Struct({
  type: Schema.Literal("dropped"),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const EngineWsServerSessionSupersededMessage = Schema.Struct({
  type: Schema.Literal("session_superseded"),
  message: Schema.String,
});

export const EngineWsServerStoppedMessage = Schema.Struct({
  type: Schema.Literal("stopped"),
});

export const EngineWsServerErrorMessage = Schema.Struct({
  type: Schema.Literal("error"),
  code: Schema.optionalKey(Schema.String),
  message: Schema.String,
});

export const EngineWsServerMessage = Schema.Union([
  EngineWsServerAuthOkMessage,
  EngineWsServerStartedMessage,
  EngineWsServerConfigUpdatedMessage,
  EngineWsServerPongMessage,
  EngineWsServerSyncStatsMessage,
  EngineWsServerWaitingFaceMessage,
  EngineWsServerNoPersonMessage,
  EngineWsServerEditingMessage,
  EngineWsServerDroppedMessage,
  EngineWsServerSessionSupersededMessage,
  EngineWsServerStoppedMessage,
  EngineWsServerErrorMessage,
]);
export type EngineWsServerMessage = typeof EngineWsServerMessage.Type;

export const EngineWebhookReadyEvent = Schema.Struct({
  event: Schema.Literal("ready"),
  instance_id: Schema.String,
  timestamp: Schema.Finite,
  enabled_modalities: Schema.optionalKey(Schema.Array(Modality)),
});

export const EngineWebhookConnectedEvent = Schema.Struct({
  event: Schema.Literal("connected"),
  instance_id: Schema.String,
  timestamp: Schema.Finite,
  user_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const EngineWebhookDisconnectedEvent = Schema.Struct({
  event: Schema.Literal("disconnected"),
  instance_id: Schema.String,
  timestamp: Schema.Finite,
  user_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reason: Schema.optionalKey(Schema.String),
  disconnect_timeout_s: Schema.optionalKey(Schema.Finite),
});

export const EngineWebhookShuttingDownEvent = Schema.Struct({
  event: Schema.Literal("shutting_down"),
  instance_id: Schema.String,
  timestamp: Schema.Finite,
  user_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reason: Schema.optionalKey(Schema.String),
});

export const EngineWebhookEvent = Schema.Union([
  EngineWebhookReadyEvent,
  EngineWebhookConnectedEvent,
  EngineWebhookDisconnectedEvent,
  EngineWebhookShuttingDownEvent,
]);
export type EngineWebhookEvent = typeof EngineWebhookEvent.Type;
