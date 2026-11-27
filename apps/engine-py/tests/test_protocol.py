"""Tests for the 16-byte multiplexed binary framing protocol."""

from __future__ import annotations

import pytest
from metamorph_engine.protocol import (
    HEADER_SIZE,
    AudioCodec,
    FrameFlags,
    ProtocolError,
    Track,
    VideoCodec,
    pack_frame,
    unpack_frame,
)


def test_pack_unpack_video_roundtrip() -> None:
    payload = b"\xff\xd8\xff\xe0jpeg"
    wire = pack_frame(
        Track.VIDEO,
        VideoCodec.MJPEG,
        seq=42,
        pts_us=1_234_567_890,
        payload=payload,
        flags=FrameFlags.KEYFRAME | FrameFlags.END_OF_CHUNK,
    )
    assert len(wire) == HEADER_SIZE + len(payload)

    header, view = unpack_frame(wire)
    assert header.version == 1
    assert header.track == Track.VIDEO
    assert header.codec == VideoCodec.MJPEG
    assert header.flags == (FrameFlags.KEYFRAME | FrameFlags.END_OF_CHUNK)
    assert header.seq == 42
    assert header.pts_us == 1_234_567_890
    assert bytes(view) == payload


def test_pack_unpack_audio_roundtrip() -> None:
    payload = b"\x01\x02\x03\x04" * 16
    wire = pack_frame(
        Track.AUDIO,
        AudioCodec.PCM_S16LE,
        seq=99,
        pts_us=500_000,
        payload=memoryview(payload),
        flags=FrameFlags.SPEECH_ACTIVE,
    )
    header, view = unpack_frame(wire)
    assert header.track == Track.AUDIO
    assert header.codec == AudioCodec.PCM_S16LE
    assert header.flags == FrameFlags.SPEECH_ACTIVE
    assert header.seq == 99
    assert header.pts_us == 500_000
    assert bytes(view) == payload


def test_unpack_rejects_malformed_frames() -> None:
    with pytest.raises(ProtocolError, match="shorter"):
        unpack_frame(b"short")

    # Bad version (2 instead of 1)
    bad_ver = b"\x02\x11\x00\x00\x00\x00\x00\x01" + b"\x00" * 8
    with pytest.raises(ProtocolError, match="version"):
        unpack_frame(bad_ver)

    # Unknown track (9)
    bad_track = b"\x01\x91\x00\x00\x00\x00\x00\x01" + b"\x00" * 8
    with pytest.raises(ProtocolError, match="track"):
        unpack_frame(bad_track)

    # Unknown video codec (9)
    bad_codec = b"\x01\x19\x00\x00\x00\x00\x00\x01" + b"\x00" * 8
    with pytest.raises(ProtocolError, match="codec"):
        unpack_frame(bad_codec)


def test_pack_rejects_overflow_fields() -> None:
    with pytest.raises(ProtocolError, match="seq"):
        pack_frame(Track.AUDIO, AudioCodec.PCM_S16LE, seq=-1, pts_us=0, payload=b"")
    with pytest.raises(ProtocolError, match="pts_us"):
        pack_frame(Track.AUDIO, AudioCodec.PCM_S16LE, seq=1, pts_us=-5, payload=b"")
