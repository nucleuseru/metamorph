import { Effect, Schema } from "effect";

export const PROTOCOL_VERSION = 1 as const;
export const HEADER_SIZE = 16 as const;

export const Track = {
  VIDEO: 1,
  AUDIO: 2,
} as const;
export type Track = (typeof Track)[keyof typeof Track];

export const VideoCodec = {
  H264_ANNEXB: 1,
  MJPEG: 2,
} as const;
export type VideoCodec = (typeof VideoCodec)[keyof typeof VideoCodec];

export const AudioCodec = {
  PCM_S16LE: 1,
  PCM_F32LE: 2,
} as const;
export type AudioCodec = (typeof AudioCodec)[keyof typeof AudioCodec];

export const FrameFlags = {
  NONE: 0,
  KEYFRAME: 0x0001,
  END_OF_CHUNK: 0x0002,
  SILENCE: 0x0004,
  PASSTHROUGH: 0x0008,
  SPEECH_ACTIVE: 0x0010,
} as const;
export type FrameFlags = number;

export class ProtocolError extends Schema.TaggedError<
  ProtocolError,
  { readonly brand: unique symbol }
>()("ProtocolError", {
  message: Schema.String,
}) {}

export interface MediaFrameHeader {
  readonly version: number;
  readonly track: Track;
  readonly codec: VideoCodec | AudioCodec;
  readonly flags: FrameFlags;
  readonly seq: number;
  readonly ptsUs: bigint;
}

export interface PackFrameInput {
  readonly track: Track;
  readonly codec: VideoCodec | AudioCodec;
  readonly seq: number;
  readonly ptsUs: bigint | number;
  readonly payload: Uint8Array;
  readonly flags?: FrameFlags | undefined;
}

export interface UnpackedFrame {
  readonly header: MediaFrameHeader;
  readonly payload: Uint8Array;
}

const MAX_UINT32 = 0xffffffff;
const MAX_UINT64 = 0xffffffffffffffffn;

const isValidTrack = (value: number): value is Track =>
  value === Track.VIDEO || value === Track.AUDIO;

const isValidVideoCodec = (value: number): value is VideoCodec =>
  value === VideoCodec.H264_ANNEXB || value === VideoCodec.MJPEG;

const isValidAudioCodec = (value: number): value is AudioCodec =>
  value === AudioCodec.PCM_S16LE || value === AudioCodec.PCM_F32LE;

/**
 * Serialize a 16-byte big-endian `!BBHIQ` header and raw media payload into a single Uint8Array.
 * Matches `apps/engine-py/src/metamorph_engine/protocol.py:pack_frame`.
 */
export function packFrame(input: PackFrameInput): Uint8Array {
  const { track, codec, seq, payload } = input;
  const flags = input.flags ?? FrameFlags.NONE;

  if (!isValidTrack(track)) {
    throw new ProtocolError({ message: `Unknown track id: ${String(track)}` });
  }
  if (track === Track.VIDEO && !isValidVideoCodec(codec)) {
    throw new ProtocolError({ message: `Unknown video codec id: ${String(codec)}` });
  }
  if (track === Track.AUDIO && !isValidAudioCodec(codec)) {
    throw new ProtocolError({ message: `Unknown audio codec id: ${String(codec)}` });
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_UINT32) {
    throw new ProtocolError({ message: `seq out of uint32 range: ${String(seq)}` });
  }

  let ptsUs: bigint;
  if (typeof input.ptsUs === "bigint") {
    ptsUs = input.ptsUs;
  } else {
    if (!Number.isInteger(input.ptsUs) || input.ptsUs < 0) {
      throw new ProtocolError({ message: `ptsUs out of uint64 range: ${String(input.ptsUs)}` });
    }
    ptsUs = BigInt(input.ptsUs);
  }
  if (ptsUs < 0n || ptsUs > MAX_UINT64) {
    throw new ProtocolError({ message: `ptsUs out of uint64 range: ${ptsUs.toString()}` });
  }

  const out = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, HEADER_SIZE);
  const trackCodec = ((track & 0x0f) << 4) | (codec & 0x0f);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, trackCodec);
  view.setUint16(2, flags & 0xffff, false);
  view.setUint32(4, seq >>> 0, false);
  view.setBigUint64(8, ptsUs, false);
  out.set(payload, HEADER_SIZE);
  return out;
}

/**
 * Parse a 16-byte big-endian `!BBHIQ` header and return `{ header, payload }` with a zero-copy payload view.
 * Matches `apps/engine-py/src/metamorph_engine/protocol.py:unpack_frame`.
 */
export function unpackFrame(data: Uint8Array): UnpackedFrame {
  if (data.byteLength < HEADER_SIZE) {
    throw new ProtocolError({
      message: `Frame shorter than ${HEADER_SIZE} bytes: ${data.byteLength}`,
    });
  }

  const view = new DataView(data.buffer, data.byteOffset, HEADER_SIZE);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError({ message: `Unsupported protocol version: ${version}` });
  }

  const trackCodec = view.getUint8(1);
  const rawTrack = (trackCodec >> 4) & 0x0f;
  const rawCodec = trackCodec & 0x0f;

  if (!isValidTrack(rawTrack)) {
    throw new ProtocolError({ message: `Unknown track id: ${rawTrack}` });
  }
  if (rawTrack === Track.VIDEO && !isValidVideoCodec(rawCodec)) {
    throw new ProtocolError({ message: `Unknown video codec id: ${rawCodec}` });
  }
  if (rawTrack === Track.AUDIO && !isValidAudioCodec(rawCodec)) {
    throw new ProtocolError({ message: `Unknown audio codec id: ${rawCodec}` });
  }

  const flags = view.getUint16(2, false);
  const seq = view.getUint32(4, false);
  const ptsUs = view.getBigUint64(8, false);

  return {
    header: {
      version,
      track: rawTrack,
      codec: rawCodec as VideoCodec | AudioCodec,
      flags,
      seq,
      ptsUs,
    },
    payload: data.subarray(HEADER_SIZE),
  };
}

export const packFrameEffect = (input: PackFrameInput): Effect.Effect<Uint8Array, ProtocolError> =>
  Effect.try({
    try: () => packFrame(input),
    catch: (cause) =>
      cause instanceof ProtocolError ? cause : new ProtocolError({ message: String(cause) }),
  });

export const unpackFrameEffect = (data: Uint8Array): Effect.Effect<UnpackedFrame, ProtocolError> =>
  Effect.try({
    try: () => unpackFrame(data),
    catch: (cause) =>
      cause instanceof ProtocolError ? cause : new ProtocolError({ message: String(cause) }),
  });

export const videoCodecFromName = (name: "h264" | "mjpeg"): VideoCodec =>
  name === "h264" ? VideoCodec.H264_ANNEXB : VideoCodec.MJPEG;

export const audioCodecFromName = (name: "pcm_s16le" | "pcm_f32le"): AudioCodec =>
  name === "pcm_s16le" ? AudioCodec.PCM_S16LE : AudioCodec.PCM_F32LE;
