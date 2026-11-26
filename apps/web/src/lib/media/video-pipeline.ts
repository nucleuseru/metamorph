import { FrameFlags, VideoCodec, type VideoCodec as VideoCodecType } from "@metamorph/shared";

export async function isWebCodecsH264Supported(): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    typeof VideoEncoder === "undefined" ||
    typeof VideoDecoder === "undefined"
  ) {
    return false;
  }
  try {
    const encSupport = await VideoEncoder.isConfigSupported({
      codec: "avc1.42001f",
      width: 840,
      height: 480,
      bitrate: 1_500_000,
      framerate: 24,
      avc: { format: "annexb" },
    });
    const decSupport = await VideoDecoder.isConfigSupported({
      codec: "avc1.42001f",
    });
    return Boolean(encSupport.supported && decSupport.supported);
  } catch {
    return false;
  }
}

function drawVideoCover(
  ctx: CanvasRenderingContext2D,
  videoEl: HTMLVideoElement,
  targetW: number,
  targetH: number,
): void {
  const srcW = videoEl.videoWidth || targetW;
  const srcH = videoEl.videoHeight || targetH;
  const srcAspect = srcW / srcH;
  const dstAspect = targetW / targetH;

  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;

  if (srcAspect > dstAspect) {
    sw = srcH * dstAspect;
    sx = (srcW - sw) / 2;
  } else if (srcAspect < dstAspect) {
    sh = srcW / dstAspect;
    sy = (srcH - sh) / 2;
  }

  ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, targetW, targetH);
}

function isAnnexBKeyframe(payload: Uint8Array): boolean {
  for (let i = 0; i < payload.byteLength - 4; i++) {
    if (payload[i] === 0 && payload[i + 1] === 0) {
      let headerIdx = -1;
      if (payload[i + 2] === 1) {
        headerIdx = i + 3;
      } else if (payload[i + 2] === 0 && payload[i + 3] === 1 && i + 4 < payload.byteLength) {
        headerIdx = i + 4;
      }
      if (headerIdx !== -1 && headerIdx < payload.byteLength) {
        const nalType = (payload[headerIdx] ?? 0) & 0x1f;
        if (nalType === 5 || nalType === 7) {
          return true;
        }
      }
    }
  }
  return false;
}

export interface VideoPipelineCallbacks {
  onEncodedFrame: (bytes: Uint8Array, codec: VideoCodecType, ptsUs: bigint, flags: number) => void;
  onDecodedFrame?: () => void;
}

export class VideoPipeline {
  private captureTimer: number | null = null;
  private backpressureResetTimer: number | null = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private captureCtx: CanvasRenderingContext2D | null = null;
  private renderCanvas: HTMLCanvasElement | null = null;
  private renderCtx: CanvasRenderingContext2D | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private encoder: VideoEncoder | null = null;
  private decoder: VideoDecoder | null = null;
  private awaitingKeyframe = true;
  private encodingInFlight = false;
  private paused = false;
  private inputCodec: VideoCodecType = VideoCodec.MJPEG;
  private outputCodec: VideoCodecType = VideoCodec.MJPEG;
  private width = 840;
  private height = 480;
  private baseFps = 24;
  private effectiveFps = 24;
  private jpegQuality = 0.8;
  private frameCounter = 0;
  private callbacks: VideoPipelineCallbacks;

  constructor(callbacks: VideoPipelineCallbacks) {
    this.callbacks = callbacks;
  }

  async start(options: {
    videoEl: HTMLVideoElement;
    renderCanvas: HTMLCanvasElement;
    width: number;
    height: number;
    fps: number;
    inputCodec: VideoCodecType;
    outputCodec: VideoCodecType;
    captureQuality?: number;
    paused?: boolean;
  }): Promise<void> {
    this.videoEl = options.videoEl;
    this.renderCanvas = options.renderCanvas;
    this.renderCanvas.width = options.width;
    this.renderCanvas.height = options.height;
    this.renderCtx = this.renderCanvas.getContext("2d");

    this.width = options.width;
    this.height = options.height;
    this.baseFps = Math.max(1, options.fps);
    this.effectiveFps = this.baseFps;
    this.inputCodec = options.inputCodec;
    this.outputCodec = options.outputCodec;
    this.jpegQuality = Math.max(0.5, Math.min(0.95, options.captureQuality ?? 0.8));
    this.paused = options.paused ?? false;
    this.frameCounter = 0;
    this.awaitingKeyframe = true;

    this.captureCanvas = document.createElement("canvas");
    this.captureCanvas.width = this.width;
    this.captureCanvas.height = this.height;
    this.captureCtx = this.captureCanvas.getContext("2d");

    if (this.inputCodec === VideoCodec.H264_ANNEXB) {
      this.setupH264Encoder();
    }
    if (this.outputCodec === VideoCodec.H264_ANNEXB) {
      this.setupH264Decoder();
    }

    this.restartCaptureTimer();
  }

  private restartCaptureTimer(): void {
    if (this.captureTimer !== null) {
      window.clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    const intervalMs = Math.max(16, Math.round(1000 / this.effectiveFps));
    this.captureTimer = window.setInterval(() => {
      void this.captureTick();
    }, intervalMs);
  }

  private setupH264Encoder(): void {
    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        const flags = chunk.type === "key" ? FrameFlags.KEYFRAME : FrameFlags.NONE;
        const ptsUs = BigInt(Math.max(0, Math.round(chunk.timestamp)));
        this.callbacks.onEncodedFrame(bytes, VideoCodec.H264_ANNEXB, ptsUs, flags);
      },
      error: (err) => {
        console.error("VideoEncoder error:", err);
      },
    });
    this.encoder.configure({
      codec: "avc1.42001f",
      width: this.width,
      height: this.height,
      bitrate: 1_500_000,
      framerate: this.baseFps,
      latencyMode: "realtime",
      avc: { format: "annexb" },
    });
  }

  private setupH264Decoder(): void {
    this.awaitingKeyframe = true;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        if (this.renderCtx && this.renderCanvas) {
          this.renderCtx.drawImage(frame, 0, 0, this.renderCanvas.width, this.renderCanvas.height);
          this.callbacks.onDecodedFrame?.();
        }
        frame.close();
      },
      error: (err) => {
        console.error("VideoDecoder error:", err);
        this.resetDecoder();
      },
    });
    this.decoder.configure({
      codec: "avc1.42001f",
      optimizeForLatency: true,
    });
  }

  resetDecoder(): void {
    if (this.outputCodec !== VideoCodec.H264_ANNEXB) return;
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // ignore
      }
      this.decoder = null;
    }
    this.setupH264Decoder();
  }

  notifyBackpressure(): void {
    const throttled = Math.max(10, Math.round(this.baseFps * 0.75));
    if (throttled < this.effectiveFps) {
      this.effectiveFps = throttled;
      this.restartCaptureTimer();
    }
    if (this.backpressureResetTimer !== null) {
      window.clearTimeout(this.backpressureResetTimer);
    }
    this.backpressureResetTimer = window.setTimeout(() => {
      this.backpressureResetTimer = null;
      if (this.effectiveFps !== this.baseFps && this.captureTimer !== null) {
        this.effectiveFps = this.baseFps;
        this.restartCaptureTimer();
      }
    }, 3_000);
  }

  private async captureTick(): Promise<void> {
    if (this.paused || this.encodingInFlight) return;
    if (!this.videoEl || this.videoEl.readyState < 2) return;
    if (!this.captureCtx || !this.captureCanvas) return;

    this.encodingInFlight = true;
    try {
      const ptsUs = BigInt(Math.round(performance.now() * 1000));
      drawVideoCover(this.captureCtx, this.videoEl, this.width, this.height);

      if (this.inputCodec === VideoCodec.H264_ANNEXB && this.encoder) {
        if (this.encoder.encodeQueueSize > 2) return;
        const frame = new VideoFrame(this.captureCanvas, {
          timestamp: Number(ptsUs),
        });
        const isKey = this.frameCounter % (this.baseFps * 2) === 0;
        this.encoder.encode(frame, { keyFrame: isKey });
        frame.close();
        this.frameCounter++;
      } else {
        const blob = await new Promise<Blob | null>((resolve) => {
          this.captureCanvas?.toBlob((b) => resolve(b), "image/jpeg", this.jpegQuality);
        });
        if (!blob) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        this.callbacks.onEncodedFrame(bytes, VideoCodec.MJPEG, ptsUs, FrameFlags.KEYFRAME);
        this.frameCounter++;
      }
    } finally {
      this.encodingInFlight = false;
    }
  }

  async renderIncomingFrame(
    payload: Uint8Array,
    codec: VideoCodecType,
    flags: number,
    ptsUs: bigint,
  ): Promise<void> {
    if (codec === VideoCodec.H264_ANNEXB && this.decoder) {
      const isKey = (flags & FrameFlags.KEYFRAME) !== 0 || isAnnexBKeyframe(payload);
      if (this.awaitingKeyframe) {
        if (!isKey) return;
        this.awaitingKeyframe = false;
      }
      const chunk = new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: Number(ptsUs),
        data: payload,
      });
      try {
        this.decoder.decode(chunk);
      } catch {
        this.resetDecoder();
      }
      return;
    }

    if (!this.renderCtx || !this.renderCanvas) return;
    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);
    const blob = new Blob([copy], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    try {
      this.renderCtx.drawImage(bitmap, 0, 0, this.renderCanvas.width, this.renderCanvas.height);
      this.callbacks.onDecodedFrame?.();
    } finally {
      bitmap.close();
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  stop(): void {
    if (this.captureTimer !== null) {
      window.clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.backpressureResetTimer !== null) {
      window.clearTimeout(this.backpressureResetTimer);
      this.backpressureResetTimer = null;
    }
    if (this.encoder) {
      try {
        this.encoder.close();
      } catch {
        // ignore
      }
      this.encoder = null;
    }
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // ignore
      }
      this.decoder = null;
    }
    this.videoEl = null;
    this.renderCanvas = null;
    this.renderCtx = null;
    this.captureCanvas = null;
    this.captureCtx = null;
  }
}
