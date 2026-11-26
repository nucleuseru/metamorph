import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AudioCodec,
  FrameFlags,
  HEADER_SIZE,
  PROTOCOL_VERSION,
  ProtocolError,
  Track,
  VideoCodec,
  audioCodecFromName,
  packFrame,
  unpackFrame,
  videoCodecFromName,
} from "./protocol.ts";

describe("16-byte binary engine wire protocol (!BBHIQ)", () => {
  test("packs and unpacks video frame with exact big-endian header bytes", () => {
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]);
    const ptsUs = 1_700_000_123_456n;
    const packed = packFrame({
      track: Track.VIDEO,
      codec: VideoCodec.H264_ANNEXB,
      flags: FrameFlags.KEYFRAME | FrameFlags.END_OF_CHUNK,
      seq: 0x01020304,
      ptsUs,
      payload,
    });

    assert.equal(packed.byteLength, HEADER_SIZE + payload.byteLength);
    // version = 1
    assert.equal(packed[0], PROTOCOL_VERSION);
    // track = 1 (high nibble), codec = 1 (low nibble) => 0x11
    assert.equal(packed[1], 0x11);
    // flags = 0x0003 big-endian
    assert.equal(packed[2], 0x00);
    assert.equal(packed[3], 0x03);
    // seq = 0x01020304 big-endian
    assert.deepEqual([...packed.subarray(4, 8)], [0x01, 0x02, 0x03, 0x04]);

    const { header, payload: unpackedPayload } = unpackFrame(packed);
    assert.equal(header.version, PROTOCOL_VERSION);
    assert.equal(header.track, Track.VIDEO);
    assert.equal(header.codec, VideoCodec.H264_ANNEXB);
    assert.equal(header.flags, FrameFlags.KEYFRAME | FrameFlags.END_OF_CHUNK);
    assert.equal(header.seq, 0x01020304);
    assert.equal(header.ptsUs, ptsUs);
    assert.deepEqual([...unpackedPayload], [...payload]);
    // Zero-copy view
    assert.equal(unpackedPayload.buffer, packed.buffer);
  });

  test("packs and unpacks audio frame with uint64 ptsUs and speech flag", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const ptsUs = 0x0102030405060708n;
    const packed = packFrame({
      track: Track.AUDIO,
      codec: AudioCodec.PCM_F32LE,
      flags: FrameFlags.SPEECH_ACTIVE,
      seq: 42,
      ptsUs,
      payload,
    });

    assert.equal(packed[1], 0x22);
    const { header, payload: decoded } = unpackFrame(packed);
    assert.equal(header.track, Track.AUDIO);
    assert.equal(header.codec, AudioCodec.PCM_F32LE);
    assert.equal(header.flags, FrameFlags.SPEECH_ACTIVE);
    assert.equal(header.seq, 42);
    assert.equal(header.ptsUs, ptsUs);
    assert.deepEqual([...decoded], [...payload]);
  });

  test("maps codec string names accurately", () => {
    assert.equal(videoCodecFromName("h264"), VideoCodec.H264_ANNEXB);
    assert.equal(videoCodecFromName("mjpeg"), VideoCodec.MJPEG);
    assert.equal(audioCodecFromName("pcm_s16le"), AudioCodec.PCM_S16LE);
    assert.equal(audioCodecFromName("pcm_f32le"), AudioCodec.PCM_F32LE);
  });

  test("rejects malformed frames with ProtocolError", () => {
    assert.throws(() => unpackFrame(new Uint8Array(15)), ProtocolError);

    const badVersion = new Uint8Array(16);
    badVersion[0] = 2;
    badVersion[1] = 0x11;
    assert.throws(() => unpackFrame(badVersion), ProtocolError);

    const badTrack = new Uint8Array(16);
    badTrack[0] = 1;
    badTrack[1] = 0x31;
    assert.throws(() => unpackFrame(badTrack), ProtocolError);

    const badVideoCodec = new Uint8Array(16);
    badVideoCodec[0] = 1;
    badVideoCodec[1] = 0x19;
    assert.throws(() => unpackFrame(badVideoCodec), ProtocolError);

    const badAudioCodec = new Uint8Array(16);
    badAudioCodec[0] = 1;
    badAudioCodec[1] = 0x29;
    assert.throws(() => unpackFrame(badAudioCodec), ProtocolError);

    assert.throws(
      () =>
        packFrame({
          track: Track.VIDEO,
          codec: VideoCodec.H264_ANNEXB,
          seq: -1,
          ptsUs: 0,
          payload: new Uint8Array(),
        }),
      ProtocolError,
    );

    assert.throws(
      () =>
        packFrame({
          track: Track.VIDEO,
          codec: AudioCodec.PCM_S16LE as never,
          seq: 0,
          ptsUs: -1n,
          payload: new Uint8Array(),
        }),
      ProtocolError,
    );
  });
});
