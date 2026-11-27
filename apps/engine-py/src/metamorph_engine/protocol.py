"""Binary wire protocol and JSON control schemas for metamorph-engine."""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum, IntFlag
from typing import Literal

from pydantic import BaseModel, Field

PROTOCOL_VERSION = 1
HEADER_STRUCT = struct.Struct("!BBHIQ")
HEADER_SIZE = HEADER_STRUCT.size  # 16 bytes

Modality = Literal["voice", "video"]
VideoCodecName = Literal["mjpeg"]
AudioCodecName = Literal["pcm_s16le"]


class Track(IntEnum):
    """Media track identifier carried in the binary frame header."""

    VIDEO = 1
    AUDIO = 2


class VideoCodec(IntEnum):
    """Video payload encoding carried over binary frames."""

    MJPEG = 2


class AudioCodec(IntEnum):
    """Audio payload encoding carried over binary frames."""

    PCM_S16LE = 1


class FrameFlags(IntFlag):
    """Bitflags carried in the 16-bit flags field of the binary frame header."""

    NONE = 0
    KEYFRAME = 0x0001
    END_OF_CHUNK = 0x0002
    SILENCE = 0x0004
    PASSTHROUGH = 0x0008
    SPEECH_ACTIVE = 0x0010


class ProtocolError(ValueError):
    """Raised when an incoming binary media frame violates the wire format."""


@dataclass(frozen=True, slots=True)
class MediaFrameHeader:
    """Decoded 16-byte binary header for multiplexed video/audio frames."""

    version: int
    track: Track
    codec: int
    flags: FrameFlags
    seq: int
    pts_us: int


def pack_frame(
    track: Track,
    codec: int,
    seq: int,
    pts_us: int,
    payload: bytes | bytearray | memoryview,
    flags: FrameFlags = FrameFlags.NONE,
) -> bytes:
    """Serialize a 16-byte header + raw media payload into a single bytes buffer."""
    if seq < 0 or seq > 0xFFFFFFFF:
        raise ProtocolError(f"seq out of uint32 range: {seq}")
    if pts_us < 0 or pts_us > 0xFFFFFFFFFFFFFFFF:
        raise ProtocolError(f"pts_us out of uint64 range: {pts_us}")
    track_codec = ((int(track) & 0x0F) << 4) | (int(codec) & 0x0F)
    header = HEADER_STRUCT.pack(
        PROTOCOL_VERSION,
        track_codec,
        int(flags) & 0xFFFF,
        seq,
        pts_us,
    )
    if isinstance(payload, bytes):
        return header + payload
    return header + bytes(payload)


def unpack_frame(data: bytes | bytearray | memoryview) -> tuple[MediaFrameHeader, memoryview]:
    """Parse a 16-byte binary header and return `(header, payload_memoryview)`."""
    view = memoryview(data)
    if len(view) < HEADER_SIZE:
        raise ProtocolError(f"Frame shorter than {HEADER_SIZE} bytes: {len(view)}")
    version, track_codec, raw_flags, seq, pts_us = HEADER_STRUCT.unpack_from(view, 0)
    if version != PROTOCOL_VERSION:
        raise ProtocolError(f"Unsupported protocol version: {version}")
    raw_track = (track_codec >> 4) & 0x0F
    raw_codec = track_codec & 0x0F
    try:
        track = Track(raw_track)
    except ValueError as exc:
        raise ProtocolError(f"Unknown track id: {raw_track}") from exc
    if track == Track.VIDEO:
        try:
            VideoCodec(raw_codec)
        except ValueError as exc:
            raise ProtocolError(f"Unknown video codec id: {raw_codec}") from exc
    else:
        try:
            AudioCodec(raw_codec)
        except ValueError as exc:
            raise ProtocolError(f"Unknown audio codec id: {raw_codec}") from exc
    header = MediaFrameHeader(
        version=version,
        track=track,
        codec=raw_codec,
        flags=FrameFlags(raw_flags),
        seq=seq,
        pts_us=pts_us,
    )
    return header, view[HEADER_SIZE:]


def video_codec_from_name(name: VideoCodecName) -> VideoCodec:
    """Map string video codec name to enum."""
    return VideoCodec.MJPEG


def audio_codec_from_name(name: AudioCodecName) -> AudioCodec:
    """Map string audio codec name to enum."""
    return AudioCodec.PCM_S16LE


class VideoStartConfig(BaseModel):
    """Per-session video pipeline parameters."""

    enabled: bool = True
    input_codec: VideoCodecName = "mjpeg"
    output_codec: VideoCodecName = "mjpeg"
    width: int | None = Field(default=None, ge=64, le=4096)
    height: int | None = Field(default=None, ge=64, le=4096)
    fps: int | None = Field(default=None, ge=1, le=120)
    num_inference_steps: int | None = Field(default=None, ge=1, le=50)
    seed: int | None = None
    output_quality: int | None = Field(default=None, ge=1, le=100)
    freeze_kv_on_static: bool | None = None
    static_diff_thresh: float | None = Field(default=None, ge=0.0)


class AudioStartConfig(BaseModel):
    """Per-session voice pipeline parameters."""

    enabled: bool = True
    input_codec: AudioCodecName = "pcm_s16le"
    output_codec: AudioCodecName = "pcm_s16le"
    input_sample_rate: int = Field(default=22050, ge=8000, le=96000)
    output_sample_rate: int = Field(default=22050, ge=8000, le=96000)
    diffusion_steps: int | None = Field(default=None, ge=1, le=50)
    cfg_rate: float | None = Field(default=None, ge=0.0, le=2.0)
    block_time_s: float | None = Field(default=None, gt=0.02, le=2.0)
    vad_threshold_db: float | None = Field(default=None, ge=-90.0, le=0.0)
    passthrough: bool = False


class SessionConfigPatch(BaseModel):
    """Configuration & reference asset update payload for HTTP and WS control."""

    prompt: str | None = None
    ref_image_url: str | None = None
    ref_image_base64: str | None = None
    clear_ref_image: bool = False
    ref_audio_url: str | None = None
    ref_audio_base64: str | None = None
    video: VideoStartConfig | None = None
    audio: AudioStartConfig | None = None


class HealthResponse(BaseModel):
    """Liveness response for orchestrators and load balancers."""

    status: Literal["ok"] = "ok"
    instance_id: str
    backend: Literal["gpu", "mock"]
    enabled_modalities: list[Modality]


class ReadyResponse(BaseModel):
    """Readiness response reflecting startup warmup and shutdown status."""

    status: Literal["warming", "ready", "shutting_down"]
    lifecycle_state: str
    instance_id: str
    enabled_modalities: list[Modality]
    reason: str | None = None


class BootstrapStatus(BaseModel):
    """Summary of currently staged reference assets and pipeline state."""

    has_prompt: bool
    prompt_preview: str | None = None
    has_ref_image: bool
    has_ref_audio: bool
    voice_ready: bool
    video_ready: bool


class SyncTelemetry(BaseModel):
    """Real-time audio/video synchronization metrics."""

    sync_active: bool
    video_latency_ms: float
    audio_latency_ms: float
    target_latency_ms: float
    offset_ms: float
    audio_hold_ms: float
    video_hold_ms: float


class SessionStatusResponse(BaseModel):
    """Authenticated instance & active stream status."""

    instance_id: str
    user_id: str | None = None
    lifecycle_state: str
    enabled_modalities: list[Modality]
    connected: bool
    active_session_id: str | None = None
    disconnect_countdown_s: float | None = None
    idle_countdown_s: float | None = None
    assets: BootstrapStatus
    sync: SyncTelemetry


class ConfigUpdateResponse(BaseModel):
    """Response returned after updating session prompt, assets, or parameters."""

    ok: bool = True
    hot_swapped: bool
    assets: BootstrapStatus


class ShutdownResponse(BaseModel):
    """Response returned when explicit graceful shutdown is initiated."""

    status: Literal["shutting_down"] = "shutting_down"
    reason: str
