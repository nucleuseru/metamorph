import { AudioCodec, type AudioCodec as AudioCodecType } from "@metamorph/shared";

const CAPTURE_WORKLET_SOURCE = `
class MetamorphCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetSampleRate = opts.targetSampleRate || 22050;
    this.chunkSamples = opts.chunkSamples || Math.round(this.targetSampleRate * 0.04);
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
        const pcm = new Int16Array(this.chunkSamples);
        let sumSq = 0;
        for (let i = 0; i < this.chunkSamples; i++) {
          const s = Math.max(-1, Math.min(1, this.buffer[i]));
          sumSq += s * s;
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const rms = Math.sqrt(sumSq / this.chunkSamples);
        this.port.postMessage({ pcmBuffer: pcm.buffer, rms }, [pcm.buffer]);
        this.writeIndex = 0;
      }
      this.resamplePos += ratio;
    }
    this.resamplePos -= channel.length;
    return true;
  }
}
registerProcessor("metamorph-capture-processor", MetamorphCaptureProcessor);
`;

const PLAYBACK_WORKLET_SOURCE = `
class MetamorphPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = Math.round(sampleRate * 2);
    this.targetBufferSamples = Math.round(sampleRate * 0.08);
    this.maxBufferSamples = Math.round(sampleRate * 0.25);
    this.ring = new Float32Array(this.capacity);
    this.readPtr = 0;
    this.writePtr = 0;
    this.available = 0;
    this.priming = true;
    this.muted = false;
    this.levelCounter = 0;
    this.levelSum = 0;

    this.port.onmessage = (ev) => {
      const data = ev.data;
      if (data.type === "mute") {
        this.muted = Boolean(data.muted);
        return;
      }
      if (data.type === "clear") {
        this.readPtr = 0;
        this.writePtr = 0;
        this.available = 0;
        this.priming = true;
        return;
      }
      if (data.type === "samples" && data.samples) {
        const samples = data.samples;
        for (let i = 0; i < samples.length; i++) {
          if (this.available >= this.capacity) {
            this.readPtr = (this.readPtr + 1) % this.capacity;
            this.available--;
          }
          this.ring[this.writePtr] = samples[i];
          this.writePtr = (this.writePtr + 1) % this.capacity;
          this.available++;
        }
        if (this.priming && this.available >= this.targetBufferSamples) {
          this.priming = false;
        }
        // Adaptive drift cap: drop oldest excess samples down to targetBufferSamples
        if (this.available > this.maxBufferSamples) {
          const drop = this.available - this.targetBufferSamples;
          this.readPtr = (this.readPtr + drop) % this.capacity;
          this.available -= drop;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const monitorOut = outputs[0];
    const recordOut = outputs[1];
    if (!monitorOut || !monitorOut[0]) return true;
    const channel = monitorOut[0];
    const recChannel = recordOut && recordOut[0] ? recordOut[0] : null;

    if (this.priming) {
      channel.fill(0);
      if (recChannel) recChannel.fill(0);
    } else {
      for (let i = 0; i < channel.length; i++) {
        let sample = 0;
        if (this.available > 0) {
          sample = this.ring[this.readPtr];
          this.readPtr = (this.readPtr + 1) % this.capacity;
          this.available--;
        } else {
          this.priming = true;
        }
        this.levelSum += sample * sample;
        this.levelCounter++;
        channel[i] = this.muted ? 0 : sample;
        if (recChannel) {
          recChannel[i] = sample;
        }
      }
    }

    for (let c = 1; c < monitorOut.length; c++) {
      monitorOut[c].set(channel);
    }

    if (this.levelCounter >= 1024) {
      const rms = Math.sqrt(this.levelSum / this.levelCounter);
      this.port.postMessage({ type: "level", rms });
      this.levelCounter = 0;
      this.levelSum = 0;
    }

    return true;
  }
}
registerProcessor("metamorph-playback-processor", MetamorphPlaybackProcessor);
`;

const MUTE_FLUSH_TAIL_CHUNKS = 5; // ~200ms at 40ms/chunk
const CHUNK_DURATION_S = 0.04;

export interface AudioPipelineCallbacks {
  onCapturedChunk: (pcmBytes: Uint8Array, ptsUs: bigint, rms: number, isSilence: boolean) => void;
  onInputLevel?: (rms: number) => void;
  onOutputLevel?: (rms: number) => void;
}

export class AudioPipeline {
  private captureCtx: AudioContext | null = null;
  private playbackCtx: AudioContext | null = null;
  private captureWorkletUrl: string | null = null;
  private playbackWorkletUrl: string | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private playbackNode: AudioWorkletNode | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private micStream: MediaStream | null = null;
  private micMuted = false;
  private muteFlushRemaining = 0;
  private monitorMuted = true;
  private inputSampleRate = 22050;
  private outputSampleRate = 22050;
  private chunkSamples = 882;
  private callbacks: AudioPipelineCallbacks;

  constructor(callbacks: AudioPipelineCallbacks) {
    this.callbacks = callbacks;
  }

  async start(options: {
    inputSampleRate: number;
    outputSampleRate: number;
    micDeviceId?: string;
    speakerDeviceId?: string;
    micMuted?: boolean;
    monitorMuted?: boolean;
  }): Promise<void> {
    this.inputSampleRate = options.inputSampleRate;
    this.outputSampleRate = options.outputSampleRate;
    this.chunkSamples = Math.round(this.inputSampleRate * CHUNK_DURATION_S);
    this.micMuted = options.micMuted ?? false;
    this.muteFlushRemaining = 0;
    this.monitorMuted = options.monitorMuted ?? true;

    await Promise.all([
      this.startCapture(options.micDeviceId),
      this.startPlayback(options.speakerDeviceId),
    ]);
  }

  private async startCapture(micDeviceId?: string): Promise<void> {
    const audioConstraint: MediaTrackConstraints | boolean = micDeviceId
      ? {
          deviceId: { exact: micDeviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      : {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };

    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    this.captureCtx = new AudioContext();
    if (this.captureCtx.state === "suspended") {
      await this.captureCtx.resume();
    }

    const blob = new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" });
    this.captureWorkletUrl = URL.createObjectURL(blob);
    await this.captureCtx.audioWorklet.addModule(this.captureWorkletUrl);

    this.captureSource = this.captureCtx.createMediaStreamSource(this.micStream);
    this.captureNode = new AudioWorkletNode(this.captureCtx, "metamorph-capture-processor", {
      processorOptions: {
        targetSampleRate: this.inputSampleRate,
        chunkSamples: this.chunkSamples,
      },
    });

    const chunkDurationMs = CHUNK_DURATION_S * 1000;
    this.captureNode.port.addEventListener("message", (ev) => {
      const { pcmBuffer, rms } = ev.data as { pcmBuffer: ArrayBuffer; rms: number };
      const ptsUs = BigInt(Math.max(0, Math.round((performance.now() - chunkDurationMs) * 1000)));

      if (this.micMuted) {
        this.callbacks.onInputLevel?.(0);
        if (this.muteFlushRemaining > 0) {
          this.muteFlushRemaining--;
          const silenceBytes = new Uint8Array(this.chunkSamples * 2);
          this.callbacks.onCapturedChunk(silenceBytes, ptsUs, 0, true);
        }
        return;
      }

      const normalizedRms = Math.min(1, rms * 4);
      this.callbacks.onInputLevel?.(normalizedRms);
      this.callbacks.onCapturedChunk(new Uint8Array(pcmBuffer), ptsUs, normalizedRms, false);
    });
    this.captureNode.port.start();

    this.captureSource.connect(this.captureNode);
  }

  private async startPlayback(speakerDeviceId?: string): Promise<void> {
    this.playbackCtx = new AudioContext();
    if (this.playbackCtx.state === "suspended") {
      await this.playbackCtx.resume();
    }

    if (
      speakerDeviceId &&
      "setSinkId" in this.playbackCtx &&
      typeof (this.playbackCtx as AudioContext & { setSinkId: (id: string) => Promise<void> })
        .setSinkId === "function"
    ) {
      try {
        await (
          this.playbackCtx as AudioContext & { setSinkId: (id: string) => Promise<void> }
        ).setSinkId(speakerDeviceId);
      } catch {
        // ignore unsupported sinkId
      }
    }

    const blob = new Blob([PLAYBACK_WORKLET_SOURCE], { type: "application/javascript" });
    this.playbackWorkletUrl = URL.createObjectURL(blob);
    await this.playbackCtx.audioWorklet.addModule(this.playbackWorkletUrl);

    this.playbackNode = new AudioWorkletNode(this.playbackCtx, "metamorph-playback-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });
    this.playbackNode.port.postMessage({ type: "mute", muted: this.monitorMuted }, []);
    this.playbackNode.port.addEventListener("message", (ev) => {
      const data = ev.data as { type: string; rms?: number };
      if (data.type === "level" && typeof data.rms === "number") {
        this.callbacks.onOutputLevel?.(Math.min(1, data.rms * 4));
      }
    });
    this.playbackNode.port.start();

    this.playbackNode.connect(this.playbackCtx.destination, 0);
    this.recordDest = this.playbackCtx.createMediaStreamDestination();
    this.playbackNode.connect(this.recordDest, 1);
  }

  enqueueOutput(payload: Uint8Array, codec: AudioCodecType): void {
    if (!this.playbackNode || !this.playbackCtx || payload.byteLength === 0) return;

    let floatSamples: Float32Array;
    if (codec === AudioCodec.PCM_F32LE) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const count = Math.floor(payload.byteLength / 4);
      floatSamples = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        floatSamples[i] = view.getFloat32(i * 4, true);
      }
    } else {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const count = Math.floor(payload.byteLength / 2);
      floatSamples = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        floatSamples[i] = view.getInt16(i * 2, true) / 32768;
      }
    }

    const targetRate = this.playbackCtx.sampleRate;
    const resampled = resampleLinear(floatSamples, this.outputSampleRate, targetRate);
    this.playbackNode.port.postMessage({ type: "samples", samples: resampled }, [resampled.buffer]);
  }

  getOutputMediaStream(): MediaStream | null {
    return this.recordDest?.stream ?? null;
  }

  setMicMuted(muted: boolean): void {
    if (muted && !this.micMuted) {
      this.muteFlushRemaining = MUTE_FLUSH_TAIL_CHUNKS;
    } else if (!muted) {
      this.muteFlushRemaining = 0;
    }
    this.micMuted = muted;
  }

  setMonitorMuted(muted: boolean): void {
    this.monitorMuted = muted;
    this.playbackNode?.port.postMessage({ type: "mute", muted }, []);
  }

  async setMicDevice(micDeviceId?: string): Promise<void> {
    if (!this.captureCtx || !this.captureNode) return;
    const audioConstraint: MediaTrackConstraints | boolean = micDeviceId
      ? {
          deviceId: { exact: micDeviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      : {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };

    const nextStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    if (this.captureSource) {
      this.captureSource.disconnect();
      this.captureSource = null;
    }
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.stop();
    }
    this.micStream = nextStream;
    this.captureSource = this.captureCtx.createMediaStreamSource(nextStream);
    this.captureSource.connect(this.captureNode);
  }

  async setSpeakerDevice(deviceId: string): Promise<void> {
    if (
      this.playbackCtx &&
      "setSinkId" in this.playbackCtx &&
      typeof (this.playbackCtx as AudioContext & { setSinkId: (id: string) => Promise<void> })
        .setSinkId === "function"
    ) {
      await (
        this.playbackCtx as AudioContext & { setSinkId: (id: string) => Promise<void> }
      ).setSinkId(deviceId);
    }
  }

  stop(): void {
    if (this.captureSource) {
      this.captureSource.disconnect();
      this.captureSource = null;
    }
    if (this.captureNode) {
      this.captureNode.disconnect();
      this.captureNode = null;
    }
    if (this.playbackNode) {
      this.playbackNode.disconnect();
      this.playbackNode = null;
    }
    if (this.recordDest) {
      this.recordDest.disconnect();
      this.recordDest = null;
    }
    if (this.captureCtx) {
      void this.captureCtx.close().catch(() => {});
      this.captureCtx = null;
    }
    if (this.playbackCtx) {
      void this.playbackCtx.close().catch(() => {});
      this.playbackCtx = null;
    }
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.stop();
      this.micStream = null;
    }
    if (this.captureWorkletUrl) {
      URL.revokeObjectURL(this.captureWorkletUrl);
      this.captureWorkletUrl = null;
    }
    if (this.playbackWorkletUrl) {
      URL.revokeObjectURL(this.playbackWorkletUrl);
      this.playbackWorkletUrl = null;
    }
  }
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return new Float32Array(input);
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = idx + 1 < input.length ? (input[idx + 1] ?? s0) : s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}
