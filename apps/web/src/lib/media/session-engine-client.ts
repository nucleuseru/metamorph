import {
  AudioCodec,
  FrameFlags,
  Track,
  VideoCodec,
  audioCodecFromName,
  packFrame,
  unpackFrame,
  videoCodecFromName,
  type AudioStartConfig,
  type BootstrapStatus,
  type EngineWsClientMessage,
  type VideoCodecName,
  type VideoStartConfig,
} from "@metamorph/shared";

import {
  mintSessionToken,
  type ExtendedEngineWsServerMessage,
  type SessionDetail,
} from "@/lib/api-client";

import { AudioPipeline } from "./audio-pipeline";
import { VideoPipeline } from "./video-pipeline";

export type EngineStreamPhase =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "starting"
  | "streaming"
  | "reconnecting"
  | "error";

export type VideoActivityState =
  | "editing"
  | "waiting_face"
  | "no_person"
  | "pe_running"
  | "session_reset"
  | null;

export interface RealtimeTelemetry {
  readonly syncActive: boolean;
  readonly videoLatencyMs: number;
  readonly audioLatencyMs: number;
  readonly targetLatencyMs: number;
  readonly offsetMs: number;
  readonly audioHoldMs: number;
  readonly videoHoldMs: number;
  readonly rttMs: number | null;
  readonly framesInVideo: number;
  readonly framesOutVideo: number;
  readonly framesInAudio: number;
  readonly framesOutAudio: number;
}

export interface RealtimeSessionCallbacks {
  onPhaseChange?: (phase: EngineStreamPhase) => void;
  onConnectionModeChange?: (mode: "direct" | "relay") => void;
  onVideoActivityChange?: (activity: VideoActivityState, reason?: string | null) => void;
  onPromptEnhanced?: (enhancedPrompt: string) => void;
  onDroppedFrame?: () => void;
  onTelemetry?: (telemetry: RealtimeTelemetry) => void;
  onBootstrapUpdate?: (assets: BootstrapStatus) => void;
  onInputLevel?: (rms: number) => void;
  onOutputLevel?: (rms: number) => void;
  onSpeechActive?: (active: boolean) => void;
  onError?: (message: string) => void;
  onStopped?: (reason?: string) => void;
}

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 6_000] as const;
const DIRECT_OPEN_TIMEOUT_MS = 6_000;

export class RealtimeSessionClient {
  private ws: WebSocket | null = null;
  private audioPipeline: AudioPipeline | null = null;
  private videoPipeline: VideoPipeline | null = null;
  private pingTimer: number | null = null;
  private refreshTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private connectTimeoutTimer: number | null = null;
  private videoSeq = 0;
  private audioSeq = 0;
  private rttMs: number | null = null;
  private session: SessionDetail;
  private callbacks: RealtimeSessionCallbacks;
  private videoEl: HTMLVideoElement | null = null;
  private renderCanvas: HTMLCanvasElement | null = null;
  private micDeviceId?: string;
  private speakerDeviceId?: string;
  private micMuted = false;
  private camPaused = false;
  private monitorMuted = true;
  private preferredVideoCodec: VideoCodecName = "mjpeg";
  private initialOverrides: {
    prompt?: string | null;
    ref_image_url?: string | null;
    ref_audio_url?: string | null;
    video?: VideoStartConfig | null;
    audio?: AudioStartConfig | null;
  } = {};

  private hasSentInitialStart = false;
  private hasAuthenticatedOnce = false;
  private triedRelayFallback = false;
  private intentionalStop = false;
  private reconnectAttempts = 0;
  private activeConnectionMode: "direct" | "relay" = "relay";

  constructor(session: SessionDetail, callbacks: RealtimeSessionCallbacks) {
    this.session = session;
    this.callbacks = callbacks;
  }

  async connect(options: {
    videoEl: HTMLVideoElement | null;
    renderCanvas: HTMLCanvasElement | null;
    micDeviceId?: string;
    speakerDeviceId?: string;
    micMuted?: boolean;
    camPaused?: boolean;
    monitorMuted?: boolean;
    preferredVideoCodec?: VideoCodecName;
    initialOverrides?: {
      prompt?: string | null;
      ref_image_url?: string | null;
      ref_audio_url?: string | null;
      video?: VideoStartConfig | null;
      audio?: AudioStartConfig | null;
    };
  }): Promise<void> {
    this.videoEl = options.videoEl;
    this.renderCanvas = options.renderCanvas;
    this.micDeviceId = options.micDeviceId;
    this.speakerDeviceId = options.speakerDeviceId;
    this.micMuted = options.micMuted ?? false;
    this.camPaused = options.camPaused ?? false;
    this.monitorMuted = options.monitorMuted ?? true;
    this.preferredVideoCodec = options.preferredVideoCodec ?? "mjpeg";
    this.initialOverrides = options.initialOverrides ?? {};

    this.intentionalStop = false;
    this.triedRelayFallback = false;
    this.hasAuthenticatedOnce = false;
    this.reconnectAttempts = 0;

    await this.openSocket({ preferDirect: true, isReconnect: false });
  }

  private async openSocket(opts: { preferDirect: boolean; isReconnect: boolean }): Promise<void> {
    if (this.intentionalStop) return;
    this.callbacks.onPhaseChange?.(opts.isReconnect ? "reconnecting" : "connecting");

    let token = !opts.isReconnect ? this.session.connection.token : null;
    let tokenExpiresAt = !opts.isReconnect ? this.session.connection.tokenExpiresAt : null;
    if (!token) {
      const minted = await mintSessionToken(this.session.id);
      token = minted.token;
      tokenExpiresAt = minted.expiresAt;
    }

    if (this.intentionalStop) return;

    const { url, mode } = this.resolveWsUrl(token, opts.preferDirect);
    this.activeConnectionMode = mode;
    this.callbacks.onConnectionModeChange?.(mode);

    this.hasSentInitialStart = false;
    let receivedAuthOkOnThisSocket = false;
    let didFallback = false;

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    if (mode === "direct") {
      this.clearConnectTimeout();
      this.connectTimeoutTimer = window.setTimeout(() => {
        if (!receivedAuthOkOnThisSocket && !this.intentionalStop && !this.triedRelayFallback) {
          didFallback = true;
          this.triedRelayFallback = true;
          try {
            ws.close(4000, "Direct WS timeout; falling back to relay");
          } catch {
            // ignore
          }
          void this.openSocket({ preferDirect: false, isReconnect: opts.isReconnect });
        }
      }, DIRECT_OPEN_TIMEOUT_MS);
    }

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.callbacks.onPhaseChange?.("authenticating");
      this.sendJson({ type: "auth", token });
      this.scheduleTokenRefresh(tokenExpiresAt);
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === "string") {
        let parsed: ExtendedEngineWsServerMessage | null = null;
        try {
          parsed = JSON.parse(event.data) as ExtendedEngineWsServerMessage;
        } catch {
          return;
        }
        if (parsed.type === "auth_ok") {
          receivedAuthOkOnThisSocket = true;
          this.hasAuthenticatedOnce = true;
          this.reconnectAttempts = 0;
          this.clearConnectTimeout();
        }
        this.handleTextMessage(parsed);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(new Uint8Array(event.data));
      }
    });

    ws.addEventListener("error", () => {
      if (this.ws !== ws || didFallback || this.intentionalStop) return;
      if (!receivedAuthOkOnThisSocket && mode === "direct" && !this.triedRelayFallback) {
        return; // let close handler execute immediate relay fallback
      }
      this.callbacks.onError?.("WebSocket connection error.");
    });

    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.clearConnectTimeout();
      this.teardownPipelines();
      this.ws = null;

      if (this.intentionalStop || didFallback) {
        return;
      }

      // Direct WS failed before handshake -> immediate transparent relay fallback
      if (!receivedAuthOkOnThisSocket && mode === "direct" && !this.triedRelayFallback) {
        this.triedRelayFallback = true;
        void this.openSocket({ preferDirect: false, isReconnect: opts.isReconnect });
        return;
      }

      if (ev.code === 4009) {
        this.callbacks.onError?.("Session superseded by another connection.");
        this.callbacks.onPhaseChange?.("error");
        return;
      }

      if (ev.code === 4001 || ev.code === 4003) {
        this.callbacks.onError?.(ev.reason || "Session authentication rejected.");
        this.callbacks.onPhaseChange?.("error");
        return;
      }

      // Unexpected drop after establishing a session -> attempt disconnect_grace reconnect
      if (this.hasAuthenticatedOnce && this.reconnectAttempts < RECONNECT_BACKOFF_MS.length) {
        const delayMs = RECONNECT_BACKOFF_MS[this.reconnectAttempts] ?? 6_000;
        this.reconnectAttempts++;
        this.callbacks.onPhaseChange?.("reconnecting");
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          void this.openSocket({ preferDirect: !this.triedRelayFallback, isReconnect: true });
        }, delayMs);
        return;
      }

      this.callbacks.onPhaseChange?.("disconnected");
    });
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer !== null) {
      window.clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  private resolveWsUrl(
    token: string,
    preferDirect: boolean,
  ): { url: string; mode: "direct" | "relay" } {
    const conn = this.session.connection;
    const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
    const canUseDirect =
      preferDirect &&
      conn.mode === "direct" &&
      Boolean(conn.directWsUrl) &&
      (!isHttps || conn.tlsSupported || Boolean(conn.directWsUrl?.startsWith("wss://")));

    if (canUseDirect && conn.directWsUrl) {
      return { url: conn.directWsUrl, mode: "direct" };
    }

    const sep = conn.relayWsUrl.includes("?") ? "&" : "?";
    return {
      url: `${conn.relayWsUrl}${sep}token=${encodeURIComponent(token)}`,
      mode: "relay",
    };
  }

  private scheduleTokenRefresh(expiresAtIso: string | null): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const expiresMs = expiresAtIso ? Date.parse(expiresAtIso) : Date.now() + 15 * 60_000;
    const delayMs = Math.max(30_000, expiresMs - Date.now() - 120_000);
    this.refreshTimer = window.setTimeout(async () => {
      try {
        const minted = await mintSessionToken(this.session.id);
        this.sendJson({ type: "auth_refresh", token: minted.token });
        this.scheduleTokenRefresh(minted.expiresAt);
      } catch (err) {
        this.callbacks.onError?.(
          err instanceof Error ? err.message : "Failed to refresh session token.",
        );
      }
    }, delayMs);
  }

  private sendJson(msg: EngineWsClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleTextMessage(msg: ExtendedEngineWsServerMessage): void {
    switch (msg.type) {
      case "auth_ok": {
        this.callbacks.onBootstrapUpdate?.(msg.assets);
        // Critical fix: auth_refresh also replies with auth_ok; never re-send start if already sent!
        if (this.hasSentInitialStart) {
          return;
        }
        this.hasSentInitialStart = true;
        this.callbacks.onPhaseChange?.("starting");
        const hasVideo = this.session.modalities.includes("video");
        const hasVoice = this.session.modalities.includes("voice");

        const refImageUrl =
          this.initialOverrides.ref_image_url ??
          (!msg.assets.has_ref_image ? this.session.initialConfig.refImageUrl : null) ??
          undefined;
        const refAudioUrl =
          this.initialOverrides.ref_audio_url ??
          (!msg.assets.has_ref_audio ? this.session.initialConfig.refAudioUrl : null) ??
          undefined;
        const prompt =
          this.initialOverrides.prompt ??
          (!msg.assets.has_prompt ? this.session.initialConfig.prompt : null) ??
          undefined;

        this.sendJson({
          type: "start",
          session_id: this.session.id,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(refImageUrl !== undefined ? { ref_image_url: refImageUrl } : {}),
          ...(refAudioUrl !== undefined ? { ref_audio_url: refAudioUrl } : {}),
          video: hasVideo
            ? {
                enabled: true,
                input_codec: this.preferredVideoCodec,
                output_codec: this.preferredVideoCodec,
                ...this.session.initialConfig.video,
                ...this.initialOverrides.video,
              }
            : { enabled: false },
          audio: hasVoice
            ? {
                enabled: true,
                input_codec: "pcm_s16le",
                output_codec: "pcm_s16le",
                ...this.session.initialConfig.audio,
                ...this.initialOverrides.audio,
              }
            : { enabled: false },
        });
        break;
      }

      case "started": {
        this.callbacks.onBootstrapUpdate?.(msg.assets);
        this.callbacks.onPhaseChange?.("streaming");
        void this.startMediaPipelines(msg);
        this.startPingLoop();
        break;
      }

      case "config_updated": {
        this.callbacks.onBootstrapUpdate?.(msg.assets);
        break;
      }

      case "pong": {
        if (typeof msg.t === "number") {
          this.rttMs = Math.max(0, Math.round(performance.now() - msg.t));
        }
        break;
      }

      case "sync_stats": {
        this.callbacks.onTelemetry?.({
          syncActive: msg.sync_active,
          videoLatencyMs: msg.video_latency_ms,
          audioLatencyMs: msg.audio_latency_ms,
          targetLatencyMs: msg.target_latency_ms,
          offsetMs: msg.offset_ms,
          audioHoldMs: msg.audio_hold_ms,
          videoHoldMs: msg.video_hold_ms,
          rttMs: this.rttMs,
          framesInVideo: msg.frames_in_video,
          framesOutVideo: msg.frames_out_video,
          framesInAudio: msg.frames_in_audio,
          framesOutAudio: msg.frames_out_audio,
        });
        break;
      }

      case "waiting_face": {
        this.callbacks.onVideoActivityChange?.("waiting_face", msg.reason);
        break;
      }

      case "no_person": {
        this.callbacks.onVideoActivityChange?.("no_person", msg.reason);
        break;
      }

      case "editing": {
        this.callbacks.onVideoActivityChange?.("editing", msg.reason);
        break;
      }

      case "pe_running": {
        this.callbacks.onVideoActivityChange?.("pe_running", msg.reason);
        break;
      }

      case "prompt_enhanced": {
        if (msg.enhanced_prompt) {
          this.callbacks.onPromptEnhanced?.(msg.enhanced_prompt);
        }
        break;
      }

      case "session_reset": {
        this.videoPipeline?.resetDecoder();
        this.callbacks.onVideoActivityChange?.("session_reset", msg.reason);
        break;
      }

      case "dropped": {
        this.videoPipeline?.notifyBackpressure();
        this.callbacks.onDroppedFrame?.();
        break;
      }

      case "session_superseded": {
        this.callbacks.onError?.(msg.message);
        break;
      }

      case "stopped": {
        this.intentionalStop = true;
        this.teardownPipelines();
        this.callbacks.onPhaseChange?.("disconnected");
        this.callbacks.onStopped?.("Session stopped");
        break;
      }

      case "error": {
        this.callbacks.onError?.(msg.message);
        break;
      }
    }
  }

  private async startMediaPipelines(
    started: Extract<ExtendedEngineWsServerMessage, { type: "started" }>,
  ): Promise<void> {
    this.teardownPipelines();

    if (started.video_active && started.video_config && this.videoEl && this.renderCanvas) {
      const vCfg = started.video_config;
      const requestedQuality = this.initialOverrides.video?.output_quality;
      this.videoPipeline = new VideoPipeline({
        onEncodedFrame: (bytes, codec, ptsUs, flags) => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          const packed = packFrame({
            track: Track.VIDEO,
            codec,
            seq: this.videoSeq++,
            ptsUs,
            payload: bytes,
            flags,
          });
          this.ws.send(packed.buffer as ArrayBuffer);
        },
      });

      await this.videoPipeline.start({
        videoEl: this.videoEl,
        renderCanvas: this.renderCanvas,
        width: vCfg.width,
        height: vCfg.height,
        fps: vCfg.fps,
        inputCodec: videoCodecFromName(vCfg.input_codec),
        outputCodec: videoCodecFromName(vCfg.output_codec),
        captureQuality: requestedQuality ? requestedQuality / 100 : 0.8,
        paused: this.camPaused,
      });
    }

    if (started.voice_active && started.audio_config) {
      const aCfg = started.audio_config;
      const inCodec = audioCodecFromName(aCfg.input_codec);
      this.audioPipeline = new AudioPipeline({
        onCapturedChunk: (pcmBytes, ptsUs, rms, isSilence) => {
          this.callbacks.onInputLevel?.(rms);
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          const packed = packFrame({
            track: Track.AUDIO,
            codec: inCodec,
            seq: this.audioSeq++,
            ptsUs,
            payload: pcmBytes,
            flags: isSilence ? FrameFlags.SILENCE : FrameFlags.NONE,
          });
          this.ws.send(packed.buffer as ArrayBuffer);
        },
        onInputLevel: (rms) => {
          this.callbacks.onInputLevel?.(rms);
        },
        onOutputLevel: (rms) => {
          this.callbacks.onOutputLevel?.(rms);
        },
      });

      await this.audioPipeline.start({
        inputSampleRate: aCfg.input_sample_rate,
        outputSampleRate: aCfg.output_sample_rate,
        micDeviceId: this.micDeviceId,
        speakerDeviceId: this.speakerDeviceId,
        micMuted: this.micMuted,
        monitorMuted: this.monitorMuted,
      });
    }
  }

  private handleBinaryMessage(bytes: Uint8Array): void {
    try {
      const { header, payload } = unpackFrame(bytes);
      if (header.track === Track.VIDEO) {
        void this.videoPipeline?.renderIncomingFrame(
          payload,
          header.codec as VideoCodec,
          header.flags,
          header.ptsUs,
        );
      } else if (header.track === Track.AUDIO) {
        const speechActive = (header.flags & FrameFlags.SPEECH_ACTIVE) !== 0;
        this.callbacks.onSpeechActive?.(speechActive);
        this.audioPipeline?.enqueueOutput(payload, header.codec as AudioCodec);
      }
    } catch {
      // ignore malformed frame
    }
  }

  private startPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
    }
    this.pingTimer = window.setInterval(() => {
      this.sendJson({ type: "ping", t: performance.now() });
    }, 5_000);
  }

  updateConfig(patch: {
    prompt?: string | null;
    ref_image_url?: string | null;
    ref_image_base64?: string | null;
    clear_ref_image?: boolean;
    ref_audio_url?: string | null;
    ref_audio_base64?: string | null;
    video?: VideoStartConfig | null;
    audio?: AudioStartConfig | null;
  }): void {
    this.sendJson({ type: "update_config", ...patch });
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    this.audioPipeline?.setMicMuted(muted);
  }

  setCamPaused(paused: boolean): void {
    this.camPaused = paused;
    this.videoPipeline?.setPaused(paused);
  }

  setMonitorMuted(muted: boolean): void {
    this.monitorMuted = muted;
    this.audioPipeline?.setMonitorMuted(muted);
  }

  async setMicDevice(deviceId?: string): Promise<void> {
    this.micDeviceId = deviceId;
    await this.audioPipeline?.setMicDevice(deviceId);
  }

  async setSpeakerDevice(deviceId: string): Promise<void> {
    this.speakerDeviceId = deviceId;
    await this.audioPipeline?.setSpeakerDevice(deviceId);
  }

  getOutputAudioStream(): MediaStream | null {
    return this.audioPipeline?.getOutputMediaStream() ?? null;
  }

  getConnectionMode(): "direct" | "relay" {
    return this.activeConnectionMode;
  }

  stop(): void {
    this.intentionalStop = true;
    this.clearConnectTimeout();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sendJson({ type: "stop" });
    this.teardownPipelines();
    if (this.ws) {
      try {
        this.ws.close(1000, "Client stopped");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.callbacks.onPhaseChange?.("disconnected");
  }

  private teardownPipelines(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.videoPipeline?.stop();
    this.videoPipeline = null;
    this.audioPipeline?.stop();
    this.audioPipeline = null;
  }
}
