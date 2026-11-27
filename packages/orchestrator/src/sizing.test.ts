import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { defaultOrchestratorConfig } from "./config.ts";
import { buildEngineEnv, escapePemForEnv, resolveHardwareProfile } from "./sizing.ts";

describe("Hardware sizing and engine env generation", () => {
  test("selects :voice target and >=16GB VRAM for voice-only profile", () => {
    const hw = resolveHardwareProfile({
      modalities: ["voice"],
      quality: "standard",
      config: defaultOrchestratorConfig,
    });
    assert.equal(hw.imageTarget, "voice");
    assert.equal(hw.image, "metamorph-engine:voice");
    assert.equal(hw.minVramGb, 16);
    assert.equal(hw.minCudaVersion, "12.8");
    assert.equal(hw.enableVoice, true);
    assert.equal(hw.enableVideo, false);
  });

  test("selects :full target and >=32GB / >=48GB VRAM for video and dual-modality profiles", () => {
    const videoStd = resolveHardwareProfile({
      modalities: ["video"],
      quality: "standard",
      config: defaultOrchestratorConfig,
    });
    assert.equal(videoStd.imageTarget, "full");
    assert.equal(videoStd.minVramGb, 32);
    assert.equal(videoStd.videoWidth, 840);
    assert.equal(videoStd.videoHeight, 480);

    const videoHigh = resolveHardwareProfile({
      modalities: ["video"],
      quality: "high",
      config: defaultOrchestratorConfig,
    });
    assert.equal(videoHigh.minVramGb, 48);
    assert.equal(videoHigh.videoWidth, 1248);
    assert.equal(videoHigh.videoHeight, 720);

    const dualStd = resolveHardwareProfile({
      modalities: ["voice", "video"],
      quality: "standard",
      config: defaultOrchestratorConfig,
    });
    assert.equal(dualStd.imageTarget, "full");
    assert.equal(dualStd.minVramGb, 48);
    assert.equal(dualStd.enableVoice, true);
    assert.equal(dualStd.enableVideo, true);
  });

  test("escapes PEM newlines and populates required ENGINE_* environment variables", () => {
    const hw = resolveHardwareProfile({
      modalities: ["voice", "video"],
      quality: "high",
      config: {
        ...defaultOrchestratorConfig,
        jwtIssuer: "https://api.example.com",
        jwtJwksUrl: "https://api.example.com/.well-known/engine-jwks.json",
        autoDownloadModels: true,
      },
    });

    const pem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA1234\n-----END PUBLIC KEY-----\n";
    assert.equal(
      escapePemForEnv(pem),
      "-----BEGIN PUBLIC KEY-----\\nMCowBQYDK2VwAyEA1234\\n-----END PUBLIC KEY-----",
    );

    const env = buildEngineEnv({
      instanceId: "inst-123",
      userId: "user-456",
      hardware: hw,
      jwtPublicKeyPem: pem,
      webhookUrl: "https://api.example.com/internal/webhooks/engine/inst-123",
      webhookSecret: "sec-789",
      config: {
        ...defaultOrchestratorConfig,
        jwtIssuer: "https://api.example.com",
        jwtJwksUrl: "https://api.example.com/.well-known/engine-jwks.json",
        autoDownloadModels: true,
      },
      idleTimeoutS: 120,
      disconnectTimeoutS: 30,
      initialPrompt: "cyberpunk neon jacket",
      initialRefImageUrl: "https://cdn.example.com/img.png",
      initialRefAudioUrl: "https://cdn.example.com/voice.wav",
    });

    assert.equal(env["ENGINE_INSTANCE_ID"], "inst-123");
    assert.equal(env["ENGINE_USER_ID"], "user-456");
    assert.equal(env["ENGINE_JWT_AUDIENCE"], "inst-123");
    assert.equal(env["ENGINE_ENABLE_VOICE"], "true");
    assert.equal(env["ENGINE_ENABLE_VIDEO"], "true");
    assert.equal(env["ENGINE_VIDEO_WIDTH"], "1248");
    assert.equal(env["ENGINE_VIDEO_HEIGHT"], "720");
    assert.equal(env["ENGINE_LIFECYCLE_WEBHOOK_SECRET"], "sec-789");
    assert.equal(env["ENGINE_INITIAL_PROMPT"], "cyberpunk neon jacket");
    assert.equal(env["AUTO_DOWNLOAD_MODELS"], "true");
  });
});
