import type { Modality, QualityTier } from "@metamorph/shared";

import type { OrchestratorConfigShape } from "./config.ts";

export interface HardwareSpec {
  readonly imageTarget: "voice" | "full" | "mock";
  readonly image: string;
  readonly minVramGb: number;
  readonly minCudaVersion: string;
  readonly diskGb: number;
  readonly runpodGpuIds: ReadonlyArray<string>;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly videoFps: number;
  readonly enableVoice: boolean;
  readonly enableVideo: boolean;
}

export interface ResolveHardwareInput {
  readonly modalities: ReadonlyArray<Modality>;
  readonly quality: QualityTier;
  readonly config: OrchestratorConfigShape;
  readonly gpuTypeOverride?: string | undefined;
  readonly imageOverride?: string | undefined;
}

const DEFAULT_VOICE_GPUS: ReadonlyArray<string> = [
  "NVIDIA L4",
  "NVIDIA GeForce RTX 4090",
  "NVIDIA RTX 4000 Ada Generation",
  "NVIDIA RTX A4000",
];

const DEFAULT_VIDEO_STANDARD_GPUS: ReadonlyArray<string> = [
  "NVIDIA GeForce RTX 5090",
  "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
  "NVIDIA RTX 6000 Ada Generation",
  "NVIDIA L40S",
];

const DEFAULT_HIGH_OR_DUAL_GPUS: ReadonlyArray<string> = [
  "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
  "NVIDIA RTX 6000 Ada Generation",
  "NVIDIA L40S",
];

/** Maps requested modalities and quality tier to container target, GPU requirements, and defaults. */
export function resolveHardwareProfile(input: ResolveHardwareInput): HardwareSpec {
  const enableVoice = input.modalities.includes("voice");
  const enableVideo = input.modalities.includes("video");

  if (!enableVoice && !enableVideo) {
    throw new Error("At least one modality ('voice' or 'video') must be requested.");
  }

  const isHigh = input.quality === "high";
  const videoWidth = isHigh ? 1248 : 840;
  const videoHeight = isHigh ? 720 : 480;
  const videoFps = 24;

  let imageTarget: "voice" | "full" = "full";
  let minVramGb = 48;
  let diskGb = 40;
  let runpodGpuIds: ReadonlyArray<string> = DEFAULT_HIGH_OR_DUAL_GPUS;

  if (enableVoice && !enableVideo) {
    imageTarget = "voice";
    minVramGb = 16;
    diskGb = 25;
    runpodGpuIds = input.config.voiceGpuIds ?? DEFAULT_VOICE_GPUS;
  } else if (enableVideo && !enableVoice) {
    imageTarget = "full";
    if (isHigh) {
      minVramGb = 48;
      diskGb = 50;
      runpodGpuIds = input.config.videoHighGpuIds ?? DEFAULT_HIGH_OR_DUAL_GPUS;
    } else {
      minVramGb = 32;
      diskGb = 50;
      runpodGpuIds = input.config.videoStandardGpuIds ?? DEFAULT_VIDEO_STANDARD_GPUS;
    }
  } else {
    // Dual modality: voice + video
    imageTarget = "full";
    minVramGb = 48;
    diskGb = 60;
    runpodGpuIds = isHigh
      ? (input.config.dualHighGpuIds ?? DEFAULT_HIGH_OR_DUAL_GPUS)
      : (input.config.dualStandardGpuIds ?? DEFAULT_HIGH_OR_DUAL_GPUS);
  }

  if (input.gpuTypeOverride) {
    runpodGpuIds = [input.gpuTypeOverride];
  }

  const tag = imageTarget === "voice" ? input.config.imageTagVoice : input.config.imageTagFull;
  const image = input.imageOverride ?? `${input.config.imageRepo}:${tag}`;

  return {
    imageTarget,
    image,
    minVramGb,
    minCudaVersion: "12.8",
    diskGb,
    runpodGpuIds,
    videoWidth,
    videoHeight,
    videoFps,
    enableVoice,
    enableVideo,
  };
}

export interface BuildEngineEnvInput {
  readonly instanceId: string;
  readonly userId: string;
  readonly hardware: HardwareSpec;
  readonly jwtPublicKeyPem: string;
  readonly webhookUrl?: string | undefined;
  readonly webhookSecret?: string | undefined;
  readonly config: OrchestratorConfigShape;
  readonly idleTimeoutS: number;
  readonly disconnectTimeoutS: number;
  readonly initialPrompt?: string | undefined;
  readonly initialRefImageUrl?: string | undefined;
  readonly initialRefAudioUrl?: string | undefined;
}

/** Escape newlines inside PEM public keys for container env injection. */
export const escapePemForEnv = (pem: string): string =>
  pem.trim().replace(/\r\n/g, "\n").replace(/\n/g, "\\n");

/** Builds the `ENGINE_*` environment variables required by `apps/engine-py`. */
export function buildEngineEnv(input: BuildEngineEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    ENGINE_HOST: "0.0.0.0",
    ENGINE_PORT: "8000",
    ENGINE_INSTANCE_ID: input.instanceId,
    ENGINE_USER_ID: input.userId,
    ENGINE_ENABLE_VOICE: input.hardware.enableVoice ? "true" : "false",
    ENGINE_ENABLE_VIDEO: input.hardware.enableVideo ? "true" : "false",
    ENGINE_JWT_PUBLIC_KEY: escapePemForEnv(input.jwtPublicKeyPem),
    ENGINE_JWT_AUDIENCE: input.instanceId,
    ENGINE_STARTUP_IDLE_TIMEOUT_S: String(input.idleTimeoutS),
    ENGINE_DISCONNECT_TIMEOUT_S: String(input.disconnectTimeoutS),
    ENGINE_VIDEO_WIDTH: String(input.hardware.videoWidth),
    ENGINE_VIDEO_HEIGHT: String(input.hardware.videoHeight),
    ENGINE_VIDEO_FPS: String(input.hardware.videoFps),
  };

  if (input.config.jwtIssuer) {
    env["ENGINE_JWT_ISSUER"] = input.config.jwtIssuer;
  }
  if (input.config.jwtJwksUrl) {
    env["ENGINE_JWT_JWKS_URL"] = input.config.jwtJwksUrl;
  }
  if (input.webhookUrl) {
    env["ENGINE_LIFECYCLE_WEBHOOK_URL"] = input.webhookUrl;
  }
  if (input.webhookSecret) {
    env["ENGINE_LIFECYCLE_WEBHOOK_SECRET"] = input.webhookSecret;
  }
  if (input.config.allowedAssetHosts) {
    env["ENGINE_ALLOWED_ASSET_HOSTS"] = input.config.allowedAssetHosts;
  }
  if (input.config.autoDownloadModels) {
    env["AUTO_DOWNLOAD_MODELS"] = "true";
  }
  if (input.config.modelVolumeDir) {
    env["MODEL_VOLUME_DIR"] = input.config.modelVolumeDir;
  }
  if (input.config.videoCompileMode && input.hardware.enableVideo) {
    env["ENGINE_VIDEO_COMPILE_MODE"] = input.config.videoCompileMode;
  }
  if (input.initialPrompt) {
    env["ENGINE_INITIAL_PROMPT"] = input.initialPrompt;
  }
  if (input.initialRefImageUrl) {
    env["ENGINE_INITIAL_REF_IMAGE_URL"] = input.initialRefImageUrl;
  }
  if (input.initialRefAudioUrl) {
    env["ENGINE_INITIAL_REF_AUDIO_URL"] = input.initialRefAudioUrl;
  }

  return env;
}
