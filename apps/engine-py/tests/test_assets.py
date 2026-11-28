"""Tests for reference image and audio decoding, resampling, and SSRF/size guards."""

from __future__ import annotations

import base64

import httpx
import pytest
from metamorph_engine.assets import AssetError, AssetLoader
from tests.conftest import (
    StaticAssetTransport,
    build_test_settings,
    make_jpeg_bytes,
    make_wav_bytes,
)


@pytest.mark.asyncio
async def test_asset_loader_decodes_and_resamples() -> None:
    wav_48k_stereo = make_wav_bytes(freq_hz=440.0, duration_s=0.2, sr=48000, channels=2)
    jpeg = make_jpeg_bytes(width=80, height=60, color=(200, 100, 50))
    transport = StaticAssetTransport(
        {
            "https://assets.example.com/ref.wav": wav_48k_stereo,
            "https://assets.example.com/ref.jpg": jpeg,
        }
    )
    settings = build_test_settings(allowed_asset_hosts="assets.example.com")
    loader = AssetLoader(settings, http_transport=transport)

    img = await loader.load_ref_image(url="https://assets.example.com/ref.jpg")
    assert img.mode == "RGB"
    assert img.size == (80, 60)

    audio = await loader.load_ref_audio(
        target_sr=22050,
        url="https://assets.example.com/ref.wav",
    )
    # 0.2s at 22050 Hz ~= 4410 samples
    assert audio.dtype.name == "float32"
    assert 4380 <= audio.shape[0] <= 4440

    # Data URI base64 image decode
    b64_uri = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
    img_b64 = await loader.load_ref_image(b64=b64_uri)
    assert img_b64.size == (80, 60)


@pytest.mark.asyncio
async def test_asset_loader_enforces_allowlist_and_limits() -> None:
    settings = build_test_settings(
        allowed_asset_hosts="cdn.example.com",
        max_ref_image_bytes=2048,
    )
    loader = AssetLoader(settings)

    with pytest.raises(AssetError, match="scheme"):
        await loader.load_ref_image(url="file:///etc/passwd")

    with pytest.raises(AssetError, match="ENGINE_ALLOWED_ASSET_HOSTS"):
        await loader.load_ref_image(url="https://evil.example.org/avatar.png")

    oversized_b64 = base64.b64encode(b"x" * 3000).decode("ascii")
    with pytest.raises(AssetError, match="max allowed size"):
        await loader.load_ref_image(b64=oversized_b64)

    with pytest.raises(AssetError, match="Invalid reference image"):
        await loader.load_ref_image(raw_bytes=b"not-an-image")


@pytest.mark.asyncio
async def test_asset_loader_blocks_ssrf_redirects_and_bad_content_length() -> None:
    jpeg = make_jpeg_bytes(width=32, height=32, color=(10, 200, 30))

    async def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn.example.com" and request.url.path == "/redirect-ssrf":
            return httpx.Response(
                302,
                headers={"Location": "http://169.254.169.254/latest/meta-data/"},
            )
        if request.url.host == "cdn.example.com" and request.url.path == "/loop":
            return httpx.Response(302, headers={"Location": "https://cdn.example.com/loop"})
        if request.url.host == "cdn.example.com" and request.url.path == "/bad-cl":
            return httpx.Response(200, headers={"Content-Length": "not-an-int"}, content=jpeg)
        if request.url.host == "cdn.example.com" and request.url.path == "/neg-cl":
            return httpx.Response(200, headers={"Content-Length": "-5"}, content=jpeg)
        if request.url.host == "cdn.example.com" and request.url.path == "/ok-redirect":
            return httpx.Response(302, headers={"Location": "/final.jpg"})
        if request.url.host == "cdn.example.com" and request.url.path == "/final.jpg":
            return httpx.Response(200, content=jpeg)
        return httpx.Response(404)

    settings = build_test_settings(allowed_asset_hosts="cdn.example.com")
    loader = AssetLoader(settings, http_transport=httpx.MockTransport(_handler))

    with pytest.raises(AssetError, match="ENGINE_ALLOWED_ASSET_HOSTS"):
        await loader.load_ref_image(url="https://cdn.example.com/redirect-ssrf")

    with pytest.raises(AssetError, match="Too many redirects"):
        await loader.load_ref_image(url="https://cdn.example.com/loop")

    with pytest.raises(AssetError, match="Content-Length"):
        await loader.load_ref_image(url="https://cdn.example.com/bad-cl")

    with pytest.raises(AssetError, match="Content-Length"):
        await loader.load_ref_image(url="https://cdn.example.com/neg-cl")

    ok = await loader.load_ref_image(url="https://cdn.example.com/ok-redirect")
    assert ok.size == (32, 32)
