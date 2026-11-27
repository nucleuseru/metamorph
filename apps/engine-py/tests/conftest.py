"""Shared test fixtures, Ed25519 JWT helpers, and synthetic media builders."""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import time
import wave
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt
import numpy as np
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from metamorph_engine.config import EngineSettings
from PIL import Image


def generate_ed25519_keypair() -> tuple[Ed25519PrivateKey, str]:
    """Generate an ephemeral Ed25519 private key and its PEM public key."""
    private_key = Ed25519PrivateKey.generate()
    public_pem = (
        private_key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("utf-8")
    )
    return private_key, public_pem


def jwks_for(private_key: Ed25519PrivateKey, kid: str = "key-1") -> dict[str, Any]:
    """Build a JWKS payload containing the Ed25519 public key for `kid`."""
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    x = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    return {"keys": [{"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "kid": kid, "x": x}]}


@pytest.fixture
def jwks_signer(monkeypatch: pytest.MonkeyPatch) -> Ed25519PrivateKey:
    """Generate an Ed25519 keypair and serve its public JWK via PyJWKClient."""
    private_key, _ = generate_ed25519_keypair()
    jwks = jwks_for(private_key, "key-1")
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", lambda self: jwks)
    return private_key


def mint_jwt(
    private_key: Ed25519PrivateKey,
    *,
    kid: str | None = "key-1",
    sub: str = "user-1",
    aud: str | None = "inst-1",
    iss: str | None = None,
    modalities: list[str] | None = None,
    exp_offset_s: int = 300,
) -> str:
    """Mint an EdDSA JWT matching the apps/api contract."""
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": sub,
        "iat": now,
        "exp": now + exp_offset_s,
    }
    if aud is not None:
        payload["aud"] = aud
    if iss is not None:
        payload["iss"] = iss
    if modalities is not None:
        payload["modalities"] = modalities
    headers = {"kid": kid} if kid is not None else None
    return jwt.encode(payload, private_key, algorithm="EdDSA", headers=headers)


def make_wav_bytes(
    *,
    freq_hz: float = 440.0,
    duration_s: float = 0.25,
    sr: int = 22050,
    amplitude: float = 0.5,
    channels: int = 1,
) -> bytes:
    """Create a valid PCM16 WAV file in memory."""
    n = int(sr * duration_s)
    t = np.arange(n, dtype=np.float32) / float(sr)
    mono = (amplitude * np.sin(2.0 * np.pi * freq_hz * t)).astype(np.float32)
    interleaved = np.repeat(mono[:, None], channels, axis=1).reshape(-1) if channels > 1 else mono
    pcm16 = (np.clip(interleaved, -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def make_pcm16_chunk(
    *,
    freq_hz: float = 440.0,
    duration_s: float = 0.25,
    sr: int = 22050,
    amplitude: float = 0.5,
) -> bytes:
    """Create raw PCM16 LE mono samples."""
    n = int(sr * duration_s)
    t = np.arange(n, dtype=np.float32) / float(sr)
    wave_f32 = amplitude * np.sin(2.0 * np.pi * freq_hz * t)
    return (np.clip(wave_f32, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def make_jpeg_bytes(
    *,
    width: int = 64,
    height: int = 48,
    color: tuple[int, int, int] = (100, 140, 220),
) -> bytes:
    """Create an in-memory JPEG image."""
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


@dataclass
class RecordedWebhook:
    """Captured lifecycle webhook call."""

    url: str
    headers: dict[str, str]
    body: bytes
    payload: dict[str, Any]


@dataclass
class WebhookRecorder(httpx.AsyncBaseTransport):
    """Fake httpx transport capturing signed lifecycle webhooks."""

    secret: str | None = None
    events: list[RecordedWebhook] = field(default_factory=list)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = request.content
        headers = {k.lower(): v for k, v in request.headers.items()}
        payload = json.loads(body.decode("utf-8"))
        if self.secret is not None:
            sig = headers.get("x-metamorph-signature")
            expected = (
                "sha256=" + hmac.new(self.secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
            )
            assert sig == expected, f"Invalid webhook signature: {sig} != {expected}"
        self.events.append(
            RecordedWebhook(
                url=str(request.url),
                headers=headers,
                body=body,
                payload=payload,
            )
        )
        return httpx.Response(200, json={"ok": True})


class StaticAssetTransport(httpx.AsyncBaseTransport):
    """Fake httpx transport serving fixed binary assets by URL."""

    def __init__(self, assets: dict[str, bytes]) -> None:
        self._assets = assets

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url not in self._assets:
            return httpx.Response(404)
        data = self._assets[url]
        return httpx.Response(
            200,
            content=data,
            headers={"content-length": str(len(data))},
        )


def build_test_settings(**overrides: Any) -> EngineSettings:
    """Build fast CPU mock settings for unit & integration tests."""
    defaults: dict[str, Any] = {
        "backend": "mock",
        "instance_id": "inst-1",
        "user_id": "user-1",
        "jwt_jwks_url": "https://api.example.test/.well-known/engine-jwks.json",
        "enable_voice": True,
        "enable_video": True,
        "startup_idle_timeout_s": 10.0,
        "disconnect_timeout_s": 5.0,
        "ws_auth_timeout_s": 1.0,
        "mock_video_chunk_frames": 2,
        "mock_video_latency_ms": 5.0,
        "mock_audio_latency_ms": 2.0,
        "av_sync_stats_interval_s": 0.2,
    }
    defaults.update(overrides)
    return EngineSettings(**defaults)
