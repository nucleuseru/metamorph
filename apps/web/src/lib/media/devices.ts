export interface MediaDeviceOption {
  readonly deviceId: string;
  readonly label: string;
  readonly kind: MediaDeviceKind;
}

export interface EnumeratedMediaDevices {
  readonly cameras: MediaDeviceOption[];
  readonly microphones: MediaDeviceOption[];
  readonly speakers: MediaDeviceOption[];
}

export async function enumerateMediaDevices(): Promise<EnumeratedMediaDevices> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return { cameras: [], microphones: [], speakers: [] };
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras: MediaDeviceOption[] = [];
  const microphones: MediaDeviceOption[] = [];
  const speakers: MediaDeviceOption[] = [];

  for (const d of devices) {
    if (d.kind === "videoinput") {
      cameras.push({
        deviceId: d.deviceId,
        label: d.label || `Camera ${cameras.length + 1}`,
        kind: d.kind,
      });
    } else if (d.kind === "audioinput") {
      microphones.push({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${microphones.length + 1}`,
        kind: d.kind,
      });
    } else if (d.kind === "audiooutput") {
      speakers.push({
        deviceId: d.deviceId,
        label: d.label || `Speaker ${speakers.length + 1}`,
        kind: d.kind,
      });
    }
  }

  return { cameras, microphones, speakers };
}

export async function captureWebcamSnapshot(videoEl: HTMLVideoElement): Promise<File> {
  const width = videoEl.videoWidth || 840;
  const height = videoEl.videoHeight || 480;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not initialize 2D canvas context for snapshot.");
  }
  ctx.drawImage(videoEl, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92);
  });
  if (!blob) {
    throw new Error("Failed to encode webcam snapshot.");
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([blob], `webcam-snapshot-${timestamp}.jpg`, { type: "image/jpeg" });
}

export async function captureCanvasSnapshot(canvas: HTMLCanvasElement): Promise<File> {
  if (canvas.width === 0 || canvas.height === 0) {
    throw new Error("No video frame is available to capture yet.");
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.94);
  });
  if (!blob) {
    throw new Error("Failed to encode transformed frame snapshot.");
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([blob], `metamorph-frame-${timestamp}.jpg`, { type: "image/jpeg" });
}

/** Encode mono Float32 PCM samples into a standard RIFF/WAVE PCM16 LE file buffer. */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (Mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate = SampleRate * 1 * 2
  view.setUint16(32, 2, true); // BlockAlign = 2
  view.setUint16(34, 16, true); // BitsPerSample = 16
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

const WAV_RECORDER_WORKLET_SOURCE = `
class MetamorphWavCollectorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetSampleRate = opts.targetSampleRate || 22050;
    this.chunkSamples = 1024;
    this.buffer = new Float32Array(this.chunkSamples);
    this.writeIndex = 0;
    this.resamplePos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    const ratio = sampleRate / this.targetSampleRate;

    while (this.resamplePos < channel.length) {
      const idx = Math.floor(this.resamplePos);
      const frac = this.resamplePos - idx;
      const s0 = channel[idx] || 0;
      const s1 = idx + 1 < channel.length ? channel[idx + 1] : s0;
      const sample = s0 + (s1 - s0) * frac;

      this.buffer[this.writeIndex++] = sample;
      if (this.writeIndex >= this.chunkSamples) {
        const out = new Float32Array(this.buffer);
        let sumSq = 0;
        for (let i = 0; i < out.length; i++) {
          sumSq += out[i] * out[i];
        }
        const rms = Math.sqrt(sumSq / out.length);
        this.port.postMessage({ buffer: out.buffer, rms }, [out.buffer]);
        this.writeIndex = 0;
      }
      this.resamplePos += ratio;
    }
    this.resamplePos -= channel.length;
    return true;
  }
}
registerProcessor("metamorph-wav-collector", MetamorphWavCollectorProcessor);
`;

export interface AudioClipRecorderCallbacks {
  onLevel?: (rms: number) => void;
  onDurationMs?: (ms: number) => void;
}

const TARGET_RECORDING_SAMPLE_RATE = 22050;
const MAX_RECORDING_SAMPLES = TARGET_RECORDING_SAMPLE_RATE * 60;

/** Records mono microphone audio directly into an uncompressed 22.05 kHz PCM16 WAV File. */
export class AudioClipRecorder {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletUrl: string | null = null;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private active = false;

  async start(deviceId?: string, callbacks?: AudioClipRecorderCallbacks): Promise<void> {
    if (this.active) {
      throw new Error("Recorder is already active.");
    }

    const audioConstraint: MediaTrackConstraints | boolean = deviceId
      ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true };

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    this.chunks = [];
    this.totalSamples = 0;

    try {
      this.audioCtx = new AudioContext();
      if (this.audioCtx.state === "suspended") {
        await this.audioCtx.resume();
      }
      const blob = new Blob([WAV_RECORDER_WORKLET_SOURCE], { type: "application/javascript" });
      this.workletUrl = URL.createObjectURL(blob);
      await this.audioCtx.audioWorklet.addModule(this.workletUrl);

      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(this.audioCtx, "metamorph-wav-collector", {
        processorOptions: { targetSampleRate: TARGET_RECORDING_SAMPLE_RATE },
      });

      this.workletNode.port.addEventListener("message", (ev) => {
        if (!this.active) return;
        const { buffer, rms } = ev.data as { buffer: ArrayBuffer; rms: number };
        const samples = new Float32Array(buffer);
        if (this.totalSamples < MAX_RECORDING_SAMPLES) {
          const remaining = MAX_RECORDING_SAMPLES - this.totalSamples;
          const slice = samples.length > remaining ? samples.subarray(0, remaining) : samples;
          this.chunks.push(slice);
          this.totalSamples += slice.length;
        }
        callbacks?.onLevel?.(Math.min(1, rms * 4));
        callbacks?.onDurationMs?.(
          Math.round((this.totalSamples / TARGET_RECORDING_SAMPLE_RATE) * 1000),
        );
      });
      this.workletNode.port.start();

      source.connect(this.workletNode);
      this.active = true;
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  async stop(): Promise<File> {
    if (!this.active) {
      throw new Error("Recorder is not active.");
    }
    this.active = false;

    const merged = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    this.cleanup();

    const wavBytes = encodePcm16Wav(merged, TARGET_RECORDING_SAMPLE_RATE);
    const copy = new Uint8Array(wavBytes.byteLength);
    copy.set(wavBytes);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([copy], `voice-sample-${timestamp}.wav`, { type: "audio/wav" });
  }

  cancel(): void {
    this.active = false;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    this.chunks = [];
    this.totalSamples = 0;
  }
}

/** Lightweight pre-launch microphone level meter for Studio preview. */
export class MicLevelMonitor {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private timer: number | null = null;

  async start(deviceId: string | undefined, onLevel: (rms: number) => void): Promise<void> {
    this.stop();
    const audioConstraint: MediaTrackConstraints | boolean = deviceId
      ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true };

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    this.timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = buf[i] ?? 0;
        sum += s * s;
      }
      onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
    }, 50);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }
}

/** Records live transformed video canvas and/or cloned audio output stream into a WebM file. */
export class LiveOutputRecorder {
  private recorder: MediaRecorder | null = null;
  private canvasStream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private isVideo = false;

  start(options: {
    canvas?: HTMLCanvasElement | null;
    audioStream?: MediaStream | null;
    fps?: number;
  }): void {
    if (this.recorder) {
      throw new Error("Output recording is already in progress.");
    }

    const tracks: MediaStreamTrack[] = [];
    if (options.canvas && options.canvas.width > 0 && options.canvas.height > 0) {
      this.canvasStream = options.canvas.captureStream(options.fps ?? 24);
      for (const track of this.canvasStream.getVideoTracks()) {
        tracks.push(track);
      }
      this.isVideo = tracks.length > 0;
    } else {
      this.isVideo = false;
    }

    if (options.audioStream) {
      for (const track of options.audioStream.getAudioTracks()) {
        tracks.push(track);
      }
    }

    if (tracks.length === 0) {
      throw new Error("No active video or audio output stream is available to record.");
    }

    const combined = new MediaStream(tracks);
    const candidates = this.isVideo
      ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      : ["audio/webm;codecs=opus", "audio/webm"];
    const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t));

    this.chunks = [];
    this.recorder = mimeType
      ? new MediaRecorder(combined, { mimeType })
      : new MediaRecorder(combined);

    this.recorder.addEventListener("dataavailable", (ev) => {
      if (ev.data.size > 0) {
        this.chunks.push(ev.data);
      }
    });

    this.recorder.start(250);
  }

  async stop(): Promise<{ blob: Blob; filename: string }> {
    const recorder = this.recorder;
    if (!recorder) {
      throw new Error("No active output recording.");
    }

    const blob = await new Promise<Blob>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          const fallbackType = this.isVideo ? "video/webm" : "audio/webm";
          resolve(new Blob(this.chunks, { type: recorder.mimeType || fallbackType }));
        },
        { once: true },
      );
      recorder.stop();
    });

    this.cleanup();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return {
      blob,
      filename: `metamorph-session-${timestamp}.webm`,
    };
  }

  cancel(): void {
    try {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.stop();
      }
    } catch {
      // ignore
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.canvasStream) {
      for (const track of this.canvasStream.getTracks()) {
        track.stop();
      }
      this.canvasStream = null;
    }
    this.recorder = null;
    this.chunks = [];
  }
}
