"""End-to-end WebSocket & HTTP asset tests for voice-only, video-only, and dual A/V modes."""

from __future__ import annotations

import base64
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from metamorph_engine.main import create_app
from metamorph_engine.protocol import (
    AudioCodec,
    FrameFlags,
    Track,
    VideoCodec,
    pack_frame,
    unpack_frame,
)
from tests.conftest import (
    StaticAssetTransport,
    build_test_settings,
    make_jpeg_bytes,
    make_pcm16_chunk,
    make_wav_bytes,
    mint_jwt,
)


def _receive_binary_until(ws, *, count: int, timeout_s: float = 2.0):
    frames = []
    texts = []
    deadline = time.monotonic() + timeout_s
    while len(frames) < count and time.monotonic() < deadline:
        msg = ws.receive()
        if msg.get("bytes") is not None:
            frames.append(unpack_frame(msg["bytes"]))
        elif msg.get("text") is not None:
            import json

            texts.append(json.loads(msg["text"]))
    return frames, texts


def test_voice_only_pod_streams_and_hot_swaps_reference_audio(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    settings = build_test_settings(
        enable_voice=True,
        enable_video=False,
    )
    app = create_app(settings)
    token = mint_jwt(jwks_signer, modalities=["voice"])
    ref_wav = make_wav_bytes(freq_hz=330.0, duration_s=0.3, sr=22050, amplitude=0.7)

    with TestClient(app) as client:
        # Multipart upload reference audio before connecting
        upload_resp = client.post(
            "/session/assets",
            headers={"Authorization": f"Bearer {token}"},
            files={"ref_audio": ("voice.wav", ref_wav, "audio/wav")},
        )
        assert upload_resp.status_code == 200
        assert upload_resp.json()["assets"]["has_ref_audio"] is True
        assert upload_resp.json()["assets"]["video_ready"] is False

        with client.websocket_connect("/ws/session") as ws:
            ws.send_json({"type": "auth", "token": token})
            assert ws.receive_json()["type"] == "auth_ok"

            ws.send_json(
                {
                    "type": "start",
                    "audio": {
                        "enabled": True,
                        "input_codec": "pcm_s16le",
                        "output_codec": "pcm_s16le",
                        "input_sample_rate": 22050,
                        "output_sample_rate": 22050,
                    },
                }
            )
            started = ws.receive_json()
            assert started["type"] == "started"
            assert started["voice_active"] is True
            assert started["video_active"] is False

            # Send 320ms (16 * 441 = 7056 samples) voiced PCM chunk matching 20ms semantic hop
            voiced = make_pcm16_chunk(freq_hz=440.0, duration_s=0.32, sr=22050, amplitude=0.6)
            ws.send_bytes(
                pack_frame(Track.AUDIO, AudioCodec.PCM_S16LE, seq=1, pts_us=200_000, payload=voiced)
            )
            frames, _ = _receive_binary_until(ws, count=1)
            assert len(frames) == 1
            hdr, payload = frames[0]
            assert hdr.track == Track.AUDIO
            assert hdr.flags & FrameFlags.SPEECH_ACTIVE
            assert len(payload) == len(voiced)

            # Send silent chunks past 0.5s hangover (0.32s * 3 = 0.96s) -> VAD marks SILENCE
            silent = b"\x00\x00" * 7056
            ws.send_bytes(
                pack_frame(Track.AUDIO, AudioCodec.PCM_S16LE, seq=2, pts_us=900_000, payload=silent)
            )
            ws.send_bytes(
                pack_frame(
                    Track.AUDIO, AudioCodec.PCM_S16LE, seq=3, pts_us=1_220_000, payload=silent
                )
            )
            ws.send_bytes(
                pack_frame(
                    Track.AUDIO, AudioCodec.PCM_S16LE, seq=4, pts_us=1_540_000, payload=silent
                )
            )
            frames2, _ = _receive_binary_until(ws, count=3)
            assert frames2[-1][0].flags & FrameFlags.SILENCE

            # Odd-byte PCM payload emits protocol_error JSON without dropping WS session
            ws.send_bytes(
                pack_frame(
                    Track.AUDIO,
                    AudioCodec.PCM_S16LE,
                    seq=5,
                    pts_us=1_860_000,
                    payload=b"\x01",
                )
            )
            odd_err = ws.receive_json()
            assert odd_err["type"] == "error"
            assert odd_err["code"] == "protocol_error"

            # Attempting to send video frame on voice-only instance returns clean JSON error
            ws.send_bytes(
                pack_frame(
                    Track.VIDEO,
                    VideoCodec.MJPEG,
                    seq=1,
                    pts_us=0,
                    payload=make_jpeg_bytes(),
                )
            )
            err = ws.receive_json()
            assert err["type"] == "error"

            # Hot-swap ref audio via HTTP while WS is active
            ref_wav2 = make_wav_bytes(freq_hz=550.0, duration_s=0.2)
            ref_b64 = base64.b64encode(ref_wav2).decode("ascii")
            swap = client.post(
                "/session/config",
                headers={"Authorization": f"Bearer {token}"},
                json={"ref_audio_base64": ref_b64},
            )
            assert swap.status_code == 200
            assert swap.json()["hot_swapped"] is True


def test_video_only_pod_rv2v_and_hot_swap(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    settings = build_test_settings(
        enable_voice=False,
        enable_video=True,
        mock_video_chunk_frames=2,
    )
    app = create_app(settings)
    token = mint_jwt(jwks_signer, modalities=["video"])
    ref_img = make_jpeg_bytes(width=96, height=96, color=(20, 220, 90))
    frame_jpg = make_jpeg_bytes(width=64, height=48, color=(80, 80, 200))

    with TestClient(app) as client, client.websocket_connect("/ws/session") as ws:
        ws.send_json({"type": "auth", "token": token})
        assert ws.receive_json()["type"] == "auth_ok"

        ws.send_json(
            {
                "type": "start",
                "prompt": "Wear a futuristic silver jacket",
                "ref_image_base64": base64.b64encode(ref_img).decode("ascii"),
                "video": {
                    "enabled": True,
                    "input_codec": "mjpeg",
                    "output_codec": "mjpeg",
                },
            }
        )
        started = ws.receive_json()
        assert started["type"] == "started"
        assert started["video_active"] is True
        assert started["voice_active"] is False
        assert started["assets"]["has_ref_image"] is True

        # Chunk 0 takes 1 frame; chunk 1 takes 2 frames
        ws.send_bytes(
            pack_frame(Track.VIDEO, VideoCodec.MJPEG, seq=1, pts_us=33_333, payload=frame_jpg)
        )
        frames, _ = _receive_binary_until(ws, count=1)
        assert frames[0][0].track == Track.VIDEO
        assert frames[0][0].codec == VideoCodec.MJPEG
        assert frames[0][0].pts_us == 33_333
        assert bytes(frames[0][1])[:3] == b"\xff\xd8\xff"

        # Hot-swap prompt and clear ref image via WS update_config
        ws.send_json(
            {
                "type": "update_config",
                "prompt": "Swap into cyberpunk armor",
                "clear_ref_image": True,
                "video": {"enabled": True, "input_codec": "mjpeg", "output_codec": "mjpeg"},
            }
        )
        updated = ws.receive_json()
        assert updated["type"] == "config_updated"
        assert updated["hot_swapped"] is True
        assert updated["assets"]["has_ref_image"] is False
        assert updated["assets"]["has_prompt"] is True

        # Reset prompt back to default using empty string
        ws.send_json(
            {
                "type": "update_config",
                "prompt": "",
                "video": {"enabled": True, "input_codec": "mjpeg", "output_codec": "mjpeg"},
            }
        )
        reset_prompt = ws.receive_json()
        assert reset_prompt["type"] == "config_updated"
        assert reset_prompt["assets"]["has_prompt"] is False

        # Send 2 more frames (chunk 1 size=2)
        ws.send_bytes(
            pack_frame(Track.VIDEO, VideoCodec.MJPEG, seq=2, pts_us=66_666, payload=frame_jpg)
        )
        ws.send_bytes(
            pack_frame(Track.VIDEO, VideoCodec.MJPEG, seq=3, pts_us=100_000, payload=frame_jpg)
        )
        mjpeg_frames, _ = _receive_binary_until(ws, count=2)
        assert [f[0].pts_us for f in mjpeg_frames] == [66_666, 100_000]
        assert mjpeg_frames[0][0].codec == VideoCodec.MJPEG
        assert bytes(mjpeg_frames[0][1])[:3] == b"\xff\xd8\xff"


def test_dual_modality_hybrid_bootstrap_and_synced_stream(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    ref_img = make_jpeg_bytes(width=64, height=64, color=(255, 0, 128))
    ref_wav = make_wav_bytes(freq_hz=260.0, duration_s=0.3, sr=22050)
    asset_transport = StaticAssetTransport(
        {
            "https://cdn.example.com/avatar.jpg": ref_img,
            "https://cdn.example.com/voice.wav": ref_wav,
        }
    )

    settings = build_test_settings(
        enable_voice=True,
        enable_video=True,
        initial_prompt="Cyberpunk presenter",
        initial_ref_image_url="https://cdn.example.com/avatar.jpg",
        initial_ref_audio_url="https://cdn.example.com/voice.wav",
        mock_video_chunk_frames=1,
        mock_video_latency_ms=45.0,
        mock_audio_latency_ms=5.0,
    )
    app = create_app(settings, asset_transport=asset_transport)
    token = mint_jwt(jwks_signer, modalities=["voice", "video"])

    with TestClient(app) as client:
        status_resp = client.get(
            "/session/status",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert status_resp.status_code == 200
        assets = status_resp.json()["assets"]
        assert assets["has_prompt"] is True
        assert assets["has_ref_image"] is True
        assert assets["has_ref_audio"] is True

        with client.websocket_connect("/ws/session") as ws:
            ws.send_json({"type": "auth", "token": token})
            assert ws.receive_json()["type"] == "auth_ok"

            ws.send_json(
                {
                    "type": "start",
                    "video": {"enabled": True, "input_codec": "mjpeg", "output_codec": "mjpeg"},
                    "audio": {
                        "enabled": True,
                        "input_codec": "pcm_s16le",
                        "output_codec": "pcm_s16le",
                    },
                }
            )
            started = ws.receive_json()
            assert started["type"] == "started"
            assert started["voice_active"] is True
            assert started["video_active"] is True

            # Send ping/pong check
            ws.send_json({"type": "ping", "t": 1234.5})
            pong = ws.receive_json()
            assert pong["type"] == "pong"
            assert pong["t"] == 1234.5

            # Stream interleaved video + audio frames
            pcm_s16 = make_pcm16_chunk(freq_hz=440.0, duration_s=0.32, sr=22050, amplitude=0.5)
            mjpeg_frame = make_jpeg_bytes(width=64, height=48, color=(120, 80, 200))

            ws.send_bytes(
                pack_frame(
                    Track.VIDEO, VideoCodec.MJPEG, seq=1, pts_us=100_000, payload=mjpeg_frame
                )
            )
            ws.send_bytes(
                pack_frame(
                    Track.AUDIO, AudioCodec.PCM_S16LE, seq=1, pts_us=100_000, payload=pcm_s16
                )
            )
            ws.send_bytes(
                pack_frame(
                    Track.VIDEO, VideoCodec.MJPEG, seq=2, pts_us=350_000, payload=mjpeg_frame
                )
            )
            ws.send_bytes(
                pack_frame(
                    Track.AUDIO, AudioCodec.PCM_S16LE, seq=2, pts_us=350_000, payload=pcm_s16
                )
            )

            out_frames, _ = _receive_binary_until(ws, count=4, timeout_s=3.0)
            tracks = [hdr.track for hdr, _ in out_frames]
            assert Track.VIDEO in tracks
            assert Track.AUDIO in tracks

            ws.send_json({"type": "stop"})
            # Drain until stopped
            deadline = time.monotonic() + 2.0
            stopped = False
            while time.monotonic() < deadline:
                msg = ws.receive()
                if msg.get("text") and '"stopped"' in msg["text"]:
                    stopped = True
                    break
            assert stopped is True


def test_live_hotswap_sets_ref_audio_once_and_start_skips_redundant_hotswap(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    settings = build_test_settings(enable_voice=True, enable_video=False)
    app = create_app(settings)
    token = mint_jwt(jwks_signer, modalities=["voice"])
    ref_wav = make_wav_bytes(freq_hz=330.0, duration_s=0.25, sr=22050)
    ref_b64 = base64.b64encode(ref_wav).decode("ascii")

    with TestClient(app) as client:
        manager = app.state.session_manager
        voice_pipe = manager.voice_pipeline
        assert voice_pipe is not None

        set_ref_calls: list[int] = []
        orig_set_ref = voice_pipe.set_reference_audio

        def _spy_set_ref(audio_f32, sr: int) -> None:
            set_ref_calls.append(sr)
            orig_set_ref(audio_f32, sr)

        voice_pipe.set_reference_audio = _spy_set_ref

        with client.websocket_connect("/ws/session") as ws:
            ws.send_json({"type": "auth", "token": token})
            assert ws.receive_json()["type"] == "auth_ok"

            ws.send_json(
                {
                    "type": "start",
                    "audio": {
                        "enabled": True,
                        "input_codec": "pcm_s16le",
                        "output_codec": "pcm_s16le",
                    },
                }
            )
            assert ws.receive_json()["type"] == "started"
            assert set_ref_calls == []

            # Live hot-swap via HTTP must update reference audio exactly once
            resp = client.post(
                "/session/config",
                headers={"Authorization": f"Bearer {token}"},
                json={"ref_audio_base64": ref_b64},
            )
            assert resp.status_code == 200
            assert resp.json()["hot_swapped"] is True
            assert len(set_ref_calls) == 1

            # Issuing start again must NOT hot-swap the old stream before tearing it down
            old_stream = manager.active_stream
            assert old_stream is not None
            old_hotswap_calls = 0
            orig_hot_swap = old_stream.hot_swap

            async def _spy_old_hot_swap(**kwargs) -> None:
                nonlocal old_hotswap_calls
                old_hotswap_calls += 1
                await orig_hot_swap(**kwargs)

            old_stream.hot_swap = _spy_old_hot_swap
            ws.send_json(
                {
                    "type": "start",
                    "ref_audio_base64": ref_b64,
                    "audio": {
                        "enabled": True,
                        "input_codec": "pcm_s16le",
                        "output_codec": "pcm_s16le",
                    },
                }
            )
            assert ws.receive_json()["type"] == "started"
            assert old_hotswap_calls == 0
            # Re-staging during start runs once on the pipeline
            assert len(set_ref_calls) == 2


def test_partial_config_patches_preserve_earlier_overrides(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    settings = build_test_settings(enable_voice=True, enable_video=True)
    app = create_app(settings)
    token = mint_jwt(jwks_signer, modalities=["voice", "video"])

    with TestClient(app) as client:
        r1 = client.post(
            "/session/config",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "video": {"enabled": True, "width": 1280, "height": 720},
                "audio": {"enabled": True, "input_sample_rate": 48000, "diffusion_steps": 24},
            },
        )
        assert r1.status_code == 200

        # Subsequent partial patch must not clobber width/height or input_sample_rate
        r2 = client.post(
            "/session/config",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "video": {"fps": 30},
                "audio": {"cfg_rate": 0.45},
            },
        )
        assert r2.status_code == 200

        with client.websocket_connect("/ws/session") as ws:
            ws.send_json({"type": "auth", "token": token})
            assert ws.receive_json()["type"] == "auth_ok"
            ws.send_json({"type": "start"})
            assert ws.receive_json()["type"] == "started"

            stream = app.state.session_manager.active_stream
            assert stream is not None
            assert stream.video_config is not None
            assert stream.video_config.width == 1280
            assert stream.video_config.height == 720
            assert stream.video_config.fps == 30
            assert stream.voice_config is not None
            assert stream.voice_config.input_sample_rate == 48000
            assert stream.voice_config.diffusion_steps == 24
            assert stream.voice_config.cfg_rate == 0.45


def test_oversized_multipart_asset_upload_returns_422(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    settings = build_test_settings(
        enable_voice=True,
        enable_video=True,
        max_ref_image_bytes=1024,
        max_ref_audio_bytes=1024,
    )
    app = create_app(settings)
    token = mint_jwt(jwks_signer, modalities=["voice", "video"])

    with TestClient(app) as client:
        resp_img = client.post(
            "/session/assets",
            headers={"Authorization": f"Bearer {token}"},
            files={"ref_image": ("big.jpg", b"x" * 2048, "image/jpeg")},
        )
        assert resp_img.status_code == 422
        assert "max allowed size" in resp_img.json()["detail"]

        resp_aud = client.post(
            "/session/assets",
            headers={"Authorization": f"Bearer {token}"},
            files={"ref_audio": ("big.wav", b"y" * 2048, "audio/wav")},
        )
        assert resp_aud.status_code == 422
        assert "max allowed size" in resp_aud.json()["detail"]
