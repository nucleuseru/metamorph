"""Reference asset loading, validation, and decoding (images & audio)."""

from __future__ import annotations

import asyncio
import base64
import binascii
import importlib
import io
import wave
from typing import Any
from urllib.parse import urlparse

import httpx
import numpy as np
from PIL import Image, UnidentifiedImageError

from metamorph_engine.config import EngineSettings


class AssetError(ValueError):
    """Raised when a reference image or audio asset is invalid or fails to load."""


def _linear_resample(audio: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    """Resample 1D float32 audio using scipy/librosa when available, else linear interp."""
    if orig_sr == target_sr or audio.size == 0:
        return audio.astype(np.float32, copy=False)
    try:
        scipy_signal = importlib.import_module("scipy.signal")
        from math import gcd

        divisor = gcd(orig_sr, target_sr)
        up = target_sr // divisor
        down = orig_sr // divisor
        return scipy_signal.resample_poly(audio, up, down).astype(np.float32, copy=False)
    except Exception:
        pass
    out_len = max(1, round(len(audio) * target_sr / orig_sr))
    x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=out_len, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


def _decode_wav_bytes_stdlib(data: bytes) -> tuple[np.ndarray, int]:
    """Decode uncompressed PCM WAV bytes using Python's stdlib `wave` module."""
    with wave.open(io.BytesIO(data), "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if channels <= 0 or framerate <= 0:
        raise AssetError("Invalid WAV header metadata.")

    if sampwidth == 1:
        pcm = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sampwidth == 2:
        pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sampwidth == 3:
        raw_u8 = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        signed = (
            raw_u8[:, 0].astype(np.int32)
            | (raw_u8[:, 1].astype(np.int32) << 8)
            | (raw_u8[:, 2].astype(np.int32) << 16)
        )
        signed = np.where(signed & 0x800000, signed - 0x1000000, signed)
        pcm = signed.astype(np.float32) / 8388608.0
    elif sampwidth == 4:
        pcm = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise AssetError(f"Unsupported WAV sample width: {sampwidth} bytes.")

    if channels > 1:
        usable = (pcm.size // channels) * channels
        pcm = pcm[:usable].reshape(-1, channels).mean(axis=1)
    return np.clip(pcm, -1.0, 1.0).astype(np.float32, copy=False), framerate


def _decode_audio_sync(data: bytes, target_sr: int) -> np.ndarray:
    """Decode encoded audio bytes (WAV, MP3, FLAC, OGG, M4A) to mono float32."""
    if not data:
        raise AssetError("Empty reference audio payload.")

    # Fast path for standard RIFF/WAVE PCM without heavy deps
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        try:
            audio, sr = _decode_wav_bytes_stdlib(data)
            return _linear_resample(audio, sr, target_sr)
        except wave.Error:
            pass

    # Optional soundfile path (handles float WAV, FLAC, OGG)
    try:
        soundfile = importlib.import_module("soundfile")
        audio, sr = soundfile.read(io.BytesIO(data), dtype="float32", always_2d=True)
        mono = audio.mean(axis=1).astype(np.float32, copy=False)
        return _linear_resample(mono, int(sr), target_sr)
    except ModuleNotFoundError:
        pass
    except Exception:
        pass

    # Optional PyAV path (handles MP3, AAC, M4A, Opus, WebM)
    try:
        av = importlib.import_module("av")
        chunks: list[np.ndarray] = []
        sr = target_sr
        with av.open(io.BytesIO(data)) as container:
            audio_streams = [s for s in container.streams if s.type == "audio"]
            if not audio_streams:
                raise AssetError("No audio stream found in uploaded reference audio.")
            resampler = av.audio.resampler.AudioResampler(
                format="fltp",
                layout="mono",
                rate=target_sr,
            )
            for frame in container.decode(audio_streams[0]):
                for resampled in resampler.resample(frame):
                    chunks.append(resampled.to_ndarray().reshape(-1).astype(np.float32))
            for resampled in resampler.resample(None):
                chunks.append(resampled.to_ndarray().reshape(-1).astype(np.float32))
        if not chunks:
            raise AssetError("Decoded reference audio is empty.")
        return np.clip(np.concatenate(chunks), -1.0, 1.0).astype(np.float32, copy=False)
    except ModuleNotFoundError:
        pass
    except AssetError:
        raise
    except Exception as exc:
        raise AssetError(f"Failed to decode reference audio via PyAV: {exc}") from exc

    # Last fallback: librosa
    try:
        librosa = importlib.import_module("librosa")
        mono, _ = librosa.load(io.BytesIO(data), sr=target_sr, mono=True)
        return np.clip(mono, -1.0, 1.0).astype(np.float32, copy=False)
    except Exception as exc:
        raise AssetError(f"Unable to decode reference audio bytes: {exc}") from exc


def _decode_image_sync(data: bytes) -> Image.Image:
    if not data:
        raise AssetError("Empty reference image payload.")
    try:
        with Image.open(io.BytesIO(data)) as img:
            return img.convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise AssetError(f"Invalid reference image: {exc}") from exc


class AssetLoader:
    """Async loader & validator for URL, base64, and multipart reference assets."""

    def __init__(
        self,
        settings: EngineSettings,
        *,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._http_transport = http_transport

    def validate_url(self, url: str) -> str:
        """Verify URL uses http/https and satisfies `allowed_asset_hosts` when configured."""
        parsed = urlparse(url.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.hostname:
            raise AssetError(f"Invalid asset URL scheme or host: {url!r}")
        allowlist = self._settings.allowed_asset_hosts_set
        if allowlist and parsed.hostname.lower() not in allowlist:
            raise AssetError(
                f"Asset host {parsed.hostname!r} is not in ENGINE_ALLOWED_ASSET_HOSTS."
            )
        return url.strip()

    async def fetch_url(self, url: str, max_bytes: int) -> bytes:
        """Download an HTTP/HTTPS asset enforcing timeout and strict max byte size."""
        valid_url = self.validate_url(url)
        client_kwargs: dict[str, Any] = {
            "timeout": self._settings.asset_download_timeout_s,
            "follow_redirects": True,
        }
        if self._http_transport is not None:
            client_kwargs["transport"] = self._http_transport

        chunks: list[bytes] = []
        total = 0
        try:
            async with (
                httpx.AsyncClient(**client_kwargs) as client,
                client.stream("GET", valid_url) as response,
            ):
                response.raise_for_status()
                content_length = response.headers.get("content-length")
                if content_length is not None and int(content_length) > max_bytes:
                    raise AssetError(
                        f"Asset exceeds max allowed size ({content_length} > {max_bytes} bytes)."
                    )
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise AssetError(f"Asset exceeds max allowed size ({max_bytes} bytes).")
                    chunks.append(chunk)
        except AssetError:
            raise
        except httpx.HTTPError as exc:
            raise AssetError(f"Failed to fetch reference asset from URL: {exc}") from exc
        return b"".join(chunks)

    @staticmethod
    def decode_base64_payload(value: str, max_bytes: int) -> bytes:
        """Decode raw or data-URI base64 bytes while enforcing max payload size."""
        raw_b64 = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
        raw_b64 = raw_b64.strip()
        # Base64 expands 3 bytes into 4 chars.
        if (len(raw_b64) * 3) // 4 > max_bytes + 4:
            raise AssetError(f"Base64 payload exceeds max allowed size ({max_bytes} bytes).")
        try:
            decoded = base64.b64decode(raw_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise AssetError(f"Invalid base64 asset payload: {exc}") from exc
        if len(decoded) > max_bytes:
            raise AssetError(f"Decoded asset exceeds max allowed size ({max_bytes} bytes).")
        return decoded

    async def load_ref_image(
        self,
        *,
        url: str | None = None,
        b64: str | None = None,
        raw_bytes: bytes | None = None,
    ) -> Image.Image:
        """Load and decode a reference image into an RGB PIL Image."""
        max_bytes = self._settings.max_ref_image_bytes
        if raw_bytes is not None:
            if len(raw_bytes) > max_bytes:
                raise AssetError(f"Reference image exceeds max size ({max_bytes} bytes).")
            data = raw_bytes
        elif b64 is not None:
            data = self.decode_base64_payload(b64, max_bytes)
        elif url is not None:
            data = await self.fetch_url(url, max_bytes)
        else:
            raise AssetError("No reference image source provided.")
        return await asyncio.to_thread(_decode_image_sync, data)

    async def load_ref_audio(
        self,
        *,
        target_sr: int,
        url: str | None = None,
        b64: str | None = None,
        raw_bytes: bytes | None = None,
    ) -> np.ndarray:
        """Load and decode reference audio into mono float32 PCM at `target_sr`."""
        max_bytes = self._settings.max_ref_audio_bytes
        if raw_bytes is not None:
            if len(raw_bytes) > max_bytes:
                raise AssetError(f"Reference audio exceeds max size ({max_bytes} bytes).")
            data = raw_bytes
        elif b64 is not None:
            data = self.decode_base64_payload(b64, max_bytes)
        elif url is not None:
            data = await self.fetch_url(url, max_bytes)
        else:
            raise AssetError("No reference audio source provided.")
        return await asyncio.to_thread(_decode_audio_sync, data, target_sr)
