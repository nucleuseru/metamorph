import { Config, Context, Effect, Layer, Option } from "effect";

export interface OrchestratorConfigShape {
  readonly imageRepo: string;
  readonly imageTagFull: string;
  readonly imageTagVoice: string;
  readonly imageTagMock: string;
  readonly startupTimeoutS: number;
  readonly readinessPollIntervalMs: number;
  readonly idleTimeoutS: number;
  readonly disconnectTimeoutS: number;
  readonly maxSessionDurationS: number;
  readonly reconcileIntervalS: number;
  readonly orphanGracePeriodS: number;
  readonly allowOverrides: boolean;
  readonly webhookBaseUrl: string | undefined;
  readonly jwtIssuer: string | undefined;
  readonly jwtJwksUrl: string | undefined;
  readonly allowedAssetHosts: string | undefined;
  readonly autoDownloadModels: boolean;
  readonly modelVolumeDir: string | undefined;
  readonly videoCompileMode: string | undefined;
  readonly voiceGpuIds: ReadonlyArray<string> | undefined;
  readonly videoStandardGpuIds: ReadonlyArray<string> | undefined;
  readonly videoHighGpuIds: ReadonlyArray<string> | undefined;
  readonly dualStandardGpuIds: ReadonlyArray<string> | undefined;
  readonly dualHighGpuIds: ReadonlyArray<string> | undefined;
}

const parseCsvOption = (opt: Option.Option<string>): ReadonlyArray<string> | undefined => {
  if (Option.isNone(opt)) return undefined;
  const items = opt.value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return items.length > 0 ? items : undefined;
};

const cleanOpt = (opt: Option.Option<string>): string | undefined => {
  if (Option.isNone(opt)) return undefined;
  const trimmed = opt.value.trim();
  return trimmed === "" ? undefined : trimmed;
};

export const defaultOrchestratorConfig: OrchestratorConfigShape = {
  imageRepo: "metamorph-engine",
  imageTagFull: "full",
  imageTagVoice: "voice",
  imageTagMock: "mock",
  startupTimeoutS: 600,
  readinessPollIntervalMs: 2500,
  idleTimeoutS: 120,
  disconnectTimeoutS: 30,
  maxSessionDurationS: 7200,
  reconcileIntervalS: 30,
  orphanGracePeriodS: 90,
  allowOverrides: false,
  webhookBaseUrl: undefined,
  jwtIssuer: undefined,
  jwtJwksUrl: undefined,
  allowedAssetHosts: undefined,
  autoDownloadModels: false,
  modelVolumeDir: undefined,
  videoCompileMode: undefined,
  voiceGpuIds: undefined,
  videoStandardGpuIds: undefined,
  videoHighGpuIds: undefined,
  dualStandardGpuIds: undefined,
  dualHighGpuIds: undefined,
};

export class OrchestratorConfig extends Context.Service<
  OrchestratorConfig,
  OrchestratorConfigShape
>()("@metamorph/orchestrator/OrchestratorConfig") {
  static readonly layerFrom = (overrides: Partial<OrchestratorConfigShape>) =>
    Layer.succeed(
      OrchestratorConfig,
      OrchestratorConfig.of({
        ...defaultOrchestratorConfig,
        ...overrides,
      }),
    );

  static readonly layer = Layer.effect(
    OrchestratorConfig,
    Effect.gen(function* () {
      const imageRepo = yield* Config.String("ENGINE_IMAGE_REPO").pipe(
        Config.withDefault(defaultOrchestratorConfig.imageRepo),
      );
      const imageTagFull = yield* Config.String("ENGINE_IMAGE_TAG_FULL").pipe(
        Config.withDefault(defaultOrchestratorConfig.imageTagFull),
      );
      const imageTagVoice = yield* Config.String("ENGINE_IMAGE_TAG_VOICE").pipe(
        Config.withDefault(defaultOrchestratorConfig.imageTagVoice),
      );
      const imageTagMock = yield* Config.String("ENGINE_IMAGE_TAG_MOCK").pipe(
        Config.withDefault(defaultOrchestratorConfig.imageTagMock),
      );
      const startupTimeoutS = yield* Config.Int("ORCHESTRATOR_STARTUP_TIMEOUT_S").pipe(
        Config.withDefault(defaultOrchestratorConfig.startupTimeoutS),
      );
      const readinessPollIntervalMs = yield* Config.Int(
        "ORCHESTRATOR_READINESS_POLL_INTERVAL_MS",
      ).pipe(Config.withDefault(defaultOrchestratorConfig.readinessPollIntervalMs));
      const idleTimeoutS = yield* Config.Int("ENGINE_STARTUP_IDLE_TIMEOUT_S").pipe(
        Config.withDefault(defaultOrchestratorConfig.idleTimeoutS),
      );
      const disconnectTimeoutS = yield* Config.Int("ENGINE_DISCONNECT_TIMEOUT_S").pipe(
        Config.withDefault(defaultOrchestratorConfig.disconnectTimeoutS),
      );
      const maxSessionDurationS = yield* Config.Int("ORCHESTRATOR_MAX_SESSION_DURATION_S").pipe(
        Config.withDefault(defaultOrchestratorConfig.maxSessionDurationS),
      );
      const reconcileIntervalS = yield* Config.Int("ORCHESTRATOR_RECONCILE_INTERVAL_S").pipe(
        Config.withDefault(defaultOrchestratorConfig.reconcileIntervalS),
      );
      const orphanGracePeriodS = yield* Config.Int("ORCHESTRATOR_ORPHAN_GRACE_PERIOD_S").pipe(
        Config.withDefault(defaultOrchestratorConfig.orphanGracePeriodS),
      );
      const allowOverrides = yield* Config.Boolean("ORCHESTRATOR_ALLOW_OVERRIDES").pipe(
        Config.withDefault(defaultOrchestratorConfig.allowOverrides),
      );
      const webhookBaseUrlOpt = yield* Config.option(
        Config.String("ORCHESTRATOR_WEBHOOK_BASE_URL"),
      );
      const jwtIssuerOpt = yield* Config.option(Config.String("JWT_ISSUER"));
      const jwtJwksUrlOpt = yield* Config.option(Config.String("ENGINE_JWT_JWKS_URL"));
      const allowedAssetHostsOpt = yield* Config.option(
        Config.String("ENGINE_ALLOWED_ASSET_HOSTS"),
      );
      const autoDownloadModels = yield* Config.Boolean("ENGINE_AUTO_DOWNLOAD_MODELS").pipe(
        Config.withDefault(defaultOrchestratorConfig.autoDownloadModels),
      );
      const modelVolumeDirOpt = yield* Config.option(Config.String("ENGINE_MODEL_VOLUME_DIR"));
      const videoCompileModeOpt = yield* Config.option(Config.String("ENGINE_VIDEO_COMPILE_MODE"));
      const voiceGpuIdsOpt = yield* Config.option(Config.String("ORCHESTRATOR_VOICE_GPU_IDS"));
      const videoStandardGpuIdsOpt = yield* Config.option(
        Config.String("ORCHESTRATOR_VIDEO_STANDARD_GPU_IDS"),
      );
      const videoHighGpuIdsOpt = yield* Config.option(
        Config.String("ORCHESTRATOR_VIDEO_HIGH_GPU_IDS"),
      );
      const dualStandardGpuIdsOpt = yield* Config.option(
        Config.String("ORCHESTRATOR_DUAL_STANDARD_GPU_IDS"),
      );
      const dualHighGpuIdsOpt = yield* Config.option(
        Config.String("ORCHESTRATOR_DUAL_HIGH_GPU_IDS"),
      );

      const webhookBaseUrl = cleanOpt(webhookBaseUrlOpt)?.replace(/\/+$/, "");

      return OrchestratorConfig.of({
        imageRepo,
        imageTagFull,
        imageTagVoice,
        imageTagMock,
        startupTimeoutS,
        readinessPollIntervalMs,
        idleTimeoutS,
        disconnectTimeoutS,
        maxSessionDurationS,
        reconcileIntervalS,
        orphanGracePeriodS,
        allowOverrides,
        webhookBaseUrl,
        jwtIssuer: cleanOpt(jwtIssuerOpt),
        jwtJwksUrl: cleanOpt(jwtJwksUrlOpt),
        allowedAssetHosts: cleanOpt(allowedAssetHostsOpt),
        autoDownloadModels,
        modelVolumeDir: cleanOpt(modelVolumeDirOpt),
        videoCompileMode: cleanOpt(videoCompileModeOpt),
        voiceGpuIds: parseCsvOption(voiceGpuIdsOpt),
        videoStandardGpuIds: parseCsvOption(videoStandardGpuIdsOpt),
        videoHighGpuIds: parseCsvOption(videoHighGpuIdsOpt),
        dualStandardGpuIds: parseCsvOption(dualStandardGpuIdsOpt),
        dualHighGpuIds: parseCsvOption(dualHighGpuIdsOpt),
      });
    }),
  );
}
