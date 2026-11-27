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
    this.prevSample = 0;
    this.filtered = new Float32Array(128);

    // 2nd-order Butterworth low-pass anti-aliasing filter when downsampling
    this.useLpf = sampleRate > this.targetSampleRate * 1.01;
    this.z1 = 0;
    this.z2 = 0;
    if (this.useLpf) {
      const fc = Math.min(this.targetSampleRate * 0.45, sampleRate * 0.45);
      const w0 = (2 * Math.PI * fc) / sampleRate;
      const cosW0 = Math.cos(w0);
      const sinW0 = Math.sin(w0);
      const alpha = sinW0 / Math.SQRT2;
      const a0 = 1 + alpha;
      this.b0 = ((1 - cosW0) * 0.5) / a0;
      this.b1 = (1 - cosW0) / a0;
      this.b2 = ((1 - cosW0) * 0.5) / a0;
      this.a1 = (-2 * cosW0) / a0;
      this.a2 = (1 - alpha) / a0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const channel = input[0];
    const len = channel.length;
    const ratio = sampleRate / this.targetSampleRate;

    if (this.filtered.length < len) {
      this.filtered = new Float32Array(len);
    }

    if (this.useLpf) {
      let z1 = this.z1;
      let z2 = this.z2;
      const b0 = this.b0;
      const b1 = this.b1;
      const b2 = this.b2;
      const a1 = this.a1;
      const a2 = this.a2;
      for (let i = 0; i < len; i++) {
        const x = channel[i];
        const y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        this.filtered[i] = y;
      }
      this.z1 = z1;
      this.z2 = z2;
    } else {
      this.filtered.set(channel);
    }

    while (this.resamplePos < len - 1) {
      const idx = Math.floor(this.resamplePos);
      const frac = this.resamplePos - idx;
      const s0 = idx < 0 ? this.prevSample : this.filtered[idx];
      const s1 = this.filtered[idx + 1];
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
    this.prevSample = this.filtered[len - 1];
    this.resamplePos -= len;
    return true;
  }
}
registerProcessor("metamorph-capture-processor", MetamorphCaptureProcessor);
`;

const PLAYBACK_WORKLET_SOURCE = `
class MetamorphPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.capacity = Math.round(sampleRate * 4);
    this.ring = new Float32Array(this.capacity);
    this.readPtr = 0;
    this.writePtr = 0;
    this.available = 0;
    this.priming = true;
    this.muted = false;
    this.levelCounter = 0;
    this.levelSum = 0;

    this.trimFadeSamples = Math.max(1, Math.round(sampleRate * 0.01));
    this.edgeFadeSamples = Math.max(1, Math.round(sampleRate * 0.005));
    this.fadeInRemaining = 0;
    this.underrunDecayRemaining = 0;
    this.lastOutputSample = 0;

    this.configureBuffer(opts.blockTimeS || 0.25);

    this.port.onmessage = (ev) => {
      const data = ev.data;
      if (data.type === "mute") {
        this.muted = Boolean(data.muted);
        return;
      }
      if (data.type === "configure") {
        this.configureBuffer(data.blockTimeS);
        return;
      }
      if (data.type === "clear") {
        this.readPtr = 0;
        this.writePtr = 0;
        this.available = 0;
        this.priming = true;
        this.fadeInRemaining = 0;
        this.underrunDecayRemaining = 0;
        this.lastOutputSample = 0;
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
        if (this.priming && this.available >= this.primeSamples) {
          this.priming = false;
          this.fadeInRemaining = this.edgeFadeSamples;
          this.underrunDecayRemaining = 0;
        }
        // Adaptive drift cap sized well above block duration; crossfade on trim to avoid clicks.
        if (this.available > this.maxBufferSamples) {
          const drop = this.available - this.trimTargetSamples;
          const oldReadPtr = this.readPtr;
          const newReadPtr = (this.readPtr + drop) % this.capacity;
          if (!this.priming) {
            const fadeLen = Math.min(this.trimFadeSamples, this.trimTargetSamples, drop);
            for (let i = 0; i < fadeLen; i++) {
              const alpha = i / fadeLen;
              const oldIdx = (oldReadPtr + i) % this.capacity;
              const newIdx = (newReadPtr + i) % this.capacity;
              this.ring[newIdx] = this.ring[oldIdx] * (1 - alpha) + this.ring[newIdx] * alpha;
            }
          }
          this.readPtr = newReadPtr;
          this.available -= drop;
        }
      }
    };
  }

  configureBuffer(blockTimeS) {
    const safeBlockS =
      typeof blockTimeS === "number" && Number.isFinite(blockTimeS) && blockTimeS > 0.02
        ? blockTimeS
        : 0.25;
    // Hold ~1 block of jitter cushion before un-priming (capped at 450ms for large blocks)
    // and never trigger drift trimming until >4.5 blocks have accumulated.
    this.primeSamples = Math.round(sampleRate * Math.min(0.45, Math.max(0.16, safeBlockS * 1.15)));
    this.trimTargetSamples = Math.round(sampleRate * Math.max(0.32, safeBlockS * 1.5));
    this.maxBufferSamples = Math.round(sampleRate * Math.max(1.0, safeBlockS * 4.5));

    const minCapacity = Math.max(Math.round(sampleRate * 4), this.maxBufferSamples * 2);
    if (minCapacity > this.capacity) {
      const nextRing = new Float32Array(minCapacity);
      for (let i = 0; i < this.available; i++) {
        nextRing[i] = this.ring[(this.readPtr + i) % this.capacity];
      }
      this.ring = nextRing;
      this.capacity = minCapacity;
      this.readPtr = 0;
      this.writePtr = this.available % this.capacity;
    }
  }

  process(_inputs, outputs) {
    const monitorOut = outputs[0];
    const recordOut = outputs[1];
    if (!monitorOut || !monitorOut[0]) return true;
    const channel = monitorOut[0];
    const recChannel = recordOut && recordOut[0] ? recordOut[0] : null;

    if (this.priming) {
      for (let i = 0; i < channel.length; i++) {
        let sample = 0;
        if (this.underrunDecayRemaining > 0) {
          this.underrunDecayRemaining--;
          sample = this.lastOutputSample * (this.underrunDecayRemaining / this.edgeFadeSamples);
        }
        channel[i] = this.muted ? 0 : sample;
        if (recChannel) recChannel[i] = sample;
      }
      if (this.underrunDecayRemaining === 0) {
        this.lastOutputSample = 0;
      }
    } else {
      for (let i = 0; i < channel.length; i++) {
        let sample = 0;
        if (this.available > 0) {
          sample = this.ring[this.readPtr];
          this.readPtr = (this.readPtr + 1) % this.capacity;
          this.available--;
          if (this.fadeInRemaining > 0) {
            const gain = 1 - this.fadeInRemaining / this.edgeFadeSamples;
            sample *= gain;
            this.fadeInRemaining--;
          }
          this.lastOutputSample = sample;
        } else {
          if (!this.priming) {
            this.priming = true;
            this.underrunDecayRemaining =
              Math.abs(this.lastOutputSample) > 1e-5 ? this.edgeFadeSamples : 0;
          }
          if (this.underrunDecayRemaining > 0) {
            this.underrunDecayRemaining--;
            sample = this.lastOutputSample * (this.underrunDecayRemaining / this.edgeFadeSamples);
          } else {
            this.lastOutputSample = 0;
          }
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
  private blockTimeS = 0.25;
  private chunkSamples = 882;
  private outputResampler: StreamingResampler | null = null;
  private callbacks: AudioPipelineCallbacks;

  constructor(callbacks: AudioPipelineCallbacks) {
    this.callbacks = callbacks;
  }

  async start(options: {
    inputSampleRate: number;
    outputSampleRate: number;
    blockTimeS?: number;
    micDeviceId?: string;
    speakerDeviceId?: string;
    micMuted?: boolean;
    monitorMuted?: boolean;
  }): Promise<void> {
    this.inputSampleRate = options.inputSampleRate;
    this.outputSampleRate = options.outputSampleRate;
    this.blockTimeS =
      typeof options.blockTimeS === "number" &&
      Number.isFinite(options.blockTimeS) &&
      options.blockTimeS > 0.02
        ? options.blockTimeS
        : 0.25;
    this.chunkSamples = Math.round(this.inputSampleRate * CHUNK_DURATION_S);
    this.micMuted = options.micMuted ?? false;
    this.muteFlushRemaining = 0;
    this.monitorMuted = options.monitorMuted ?? true;
    this.outputResampler = null;

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
      processorOptions: {
        blockTimeS: this.blockTimeS,
      },
    });
    this.outputResampler = new StreamingResampler(
      this.outputSampleRate,
      this.playbackCtx.sampleRate,
    );
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
    if (
      !this.outputResampler ||
      this.outputResampler.fromRate !== this.outputSampleRate ||
      this.outputResampler.toRate !== targetRate
    ) {
      this.outputResampler = new StreamingResampler(this.outputSampleRate, targetRate);
    }
    const resampled = this.outputResampler.process(floatSamples);
    if (resampled.length === 0) return;
    this.playbackNode.port.postMessage({ type: "samples", samples: resampled }, [resampled.buffer]);
  }

  setBlockTimeS(blockTimeS: number): void {
    if (!Number.isFinite(blockTimeS) || blockTimeS <= 0.02) return;
    this.blockTimeS = blockTimeS;
    this.playbackNode?.port.postMessage({ type: "configure", blockTimeS }, []);
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
    this.outputResampler = null;
  }
}

/**
 * Stateful Catmull-Rom cubic streaming resampler that preserves phase and
 * boundary sample history across consecutive WebSocket audio blocks.
 */
class StreamingResampler {
  readonly fromRate: number;
  readonly toRate: number;
  private readonly ratio: number;
  private h0 = 0;
  private h1 = 0;
  private h2 = 0;
  private pos = 0;
  private initialized = false;

  constructor(fromRate: number, toRate: number) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.ratio = fromRate / toRate;
  }

  process(input: Float32Array): Float32Array {
    const n = input.length;
    if (n === 0) {
      return new Float32Array(0);
    }
    if (this.fromRate === this.toRate) {
      return new Float32Array(input);
    }

    if (!this.initialized) {
      const first = input[0] ?? 0;
      this.h0 = first;
      this.h1 = first;
      this.h2 = first;
      this.pos = 3.0;
      this.initialized = true;
    }

    const h0 = this.h0;
    const h1 = this.h1;
    const h2 = this.h2;
    const ratio = this.ratio;
    const limit = n + 1;

    const estOut = Math.max(0, Math.ceil((limit - this.pos) / ratio) + 1);
    const out = new Float32Array(estOut);
    let outIdx = 0;
    let pos = this.pos;

    const getSample = (index: number): number => {
      if (index <= 0) return h0;
      if (index === 1) return h1;
      if (index === 2) return h2;
      return input[index - 3] ?? 0;
    };

    while (pos < limit) {
      const idx = Math.floor(pos);
      const t = pos - idx;
      const y0 = getSample(idx - 1);
      const y1 = getSample(idx);
      const y2 = getSample(idx + 1);
      const y3 = getSample(idx + 2);

      const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
      const a1 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
      const a2 = -0.5 * y0 + 0.5 * y2;
      const a3 = y1;
      const sample = ((a0 * t + a1) * t + a2) * t + a3;

      if (outIdx < out.length) {
        out[outIdx++] = sample;
      }
      pos += ratio;
    }

    this.h0 = getSample(n);
    this.h1 = getSample(n + 1);
    this.h2 = getSample(n + 2);
    this.pos = pos - n;

    return outIdx === out.length ? out : out.slice(0, outIdx);
  }
}
