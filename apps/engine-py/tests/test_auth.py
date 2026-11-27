"""Tests for EdDSA JWKS JWT verification, HTTP auth, WS handshake, and auth refresh."""

from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from metamorph_engine.main import create_app
from starlette.websockets import WebSocketDisconnect
from tests.conftest import build_test_settings, generate_ed25519_keypair, mint_jwt


def test_http_auth_enforces_eddsa_claims_and_modalities(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    other_priv, _ = generate_ed25519_keypair()
    settings = build_test_settings(jwt_issuer="metamorph-api", jwt_audience="inst-1")
    app = create_app(settings)

    with TestClient(app) as client:
        # Missing bearer
        assert client.get("/session/status").status_code == 401

        # Invalid signature
        bad_sig = mint_jwt(other_priv, iss="metamorph-api")
        bad_resp = client.get(
            "/session/status",
            headers={"Authorization": f"Bearer {bad_sig}"},
        )
        assert bad_resp.status_code == 401

        # Wrong user (sub)
        wrong_user = mint_jwt(jwks_signer, sub="user-999", iss="metamorph-api")
        wrong_user_resp = client.get(
            "/session/status",
            headers={"Authorization": f"Bearer {wrong_user}"},
        )
        assert wrong_user_resp.status_code == 403

        # Wrong audience (instance_id)
        wrong_aud = mint_jwt(jwks_signer, aud="inst-other", iss="metamorph-api")
        wrong_aud_resp = client.get(
            "/session/status",
            headers={"Authorization": f"Bearer {wrong_aud}"},
        )
        assert wrong_aud_resp.status_code == 401

        # Expired token
        expired = mint_jwt(jwks_signer, exp_offset_s=-60, iss="metamorph-api")
        expired_resp = client.get(
            "/session/status",
            headers={"Authorization": f"Bearer {expired}"},
        )
        assert expired_resp.status_code == 401

        # Valid voice-only token cannot patch video prompt
        voice_only = mint_jwt(jwks_signer, modalities=["voice"], iss="metamorph-api")
        resp = client.post(
            "/session/config",
            headers={"Authorization": f"Bearer {voice_only}"},
            json={"prompt": "turn into a knight"},
        )
        assert resp.status_code == 403

        # Valid full token works
        valid = mint_jwt(jwks_signer, modalities=["voice", "video"], iss="metamorph-api")
        ok_resp = client.get(
            "/session/status",
            headers={"Authorization": f"Bearer {valid}"},
        )
        assert ok_resp.status_code == 200
        assert ok_resp.json()["user_id"] == "user-1"


def test_ws_first_message_auth_and_refresh(jwks_signer: Ed25519PrivateKey) -> None:
    settings = build_test_settings(ws_auth_timeout_s=0.3)
    app = create_app(settings)

    with TestClient(app) as client:
        # First-message auth timeout when client sends nothing
        with client.websocket_connect("/ws/session") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "error"
            assert msg["code"] == "auth_timeout"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_text()
            assert exc_info.value.code == 4001

        # Reject binary frame before auth
        with client.websocket_connect("/ws/session") as ws:
            ws.send_bytes(b"\x01\x11\x00\x00\x00\x00\x00\x01" + b"\x00" * 8)
            msg = ws.receive_json()
            assert msg["code"] == "auth_required"

        # Valid first-message auth + mid-session auth_refresh
        token1 = mint_jwt(jwks_signer, modalities=["voice"])
        token2 = mint_jwt(jwks_signer, modalities=["voice", "video"])
        with client.websocket_connect("/ws/session") as ws:
            ws.send_json({"type": "auth", "token": token1})
            auth_ok = ws.receive_json()
            assert auth_ok["type"] == "auth_ok"
            assert auth_ok["authorized_modalities"] == ["voice"]

            ws.send_json({"type": "auth_refresh", "token": token2})
            refreshed = ws.receive_json()
            assert refreshed["type"] == "auth_ok"
            assert refreshed["authorized_modalities"] == ["voice", "video"]


def test_ws_bearer_header_auth(jwks_signer: Ed25519PrivateKey) -> None:
    settings = build_test_settings()
    app = create_app(settings)
    token = mint_jwt(jwks_signer, modalities=["video"])

    with (
        TestClient(app) as client,
        client.websocket_connect(
            "/ws/session",
            headers={"Authorization": f"Bearer {token}"},
        ) as ws,
    ):
        auth_ok = ws.receive_json()
        assert auth_ok["type"] == "auth_ok"
        assert auth_ok["authorized_modalities"] == ["video"]


# --- JWKS verification (Better Auth `jwt()` plugin tokens) -------------------------------------

JWKS_URL = "https://api.example.test/api/auth/jwks"
BA_ISSUER = "https://api.example.test"


def _better_auth_token(
    private_key: Ed25519PrivateKey,
    *,
    kid: str = "key-1",
    sub: str = "user-1",
    aud: str = BA_ISSUER,
    iss: str = BA_ISSUER,
    exp_offset_s: int = 300,
) -> str:
    """Mimic a Better Auth jwt() plugin token: EdDSA, `kid` header, no `modalities`."""
    now = int(time.time())
    payload = {"sub": sub, "iss": iss, "aud": aud, "iat": now, "exp": now + exp_offset_s}
    return jwt.encode(payload, private_key, algorithm="EdDSA", headers={"kid": kid})


def _jwks_app() -> Any:
    settings = build_test_settings(
        jwt_jwks_url=JWKS_URL,
        jwt_issuer=BA_ISSUER,
        jwt_audience=BA_ISSUER,
    )
    return create_app(settings)


def test_http_auth_via_jwks(jwks_signer: Ed25519PrivateKey) -> None:
    other_priv, _ = generate_ed25519_keypair()
    with TestClient(_jwks_app()) as client:
        ok = client.get(
            "/session/status",
            headers={"Authorization": f"Bearer {_better_auth_token(jwks_signer)}"},
        )
        assert ok.status_code == 200
        assert ok.json()["user_id"] == "user-1"

        def status(token: str) -> int:
            return client.get(
                "/session/status", headers={"Authorization": f"Bearer {token}"}
            ).status_code

        assert status(_better_auth_token(other_priv)) == 401  # wrong signature
        assert status(_better_auth_token(jwks_signer, kid="unknown")) == 401
        assert status(_better_auth_token(jwks_signer, aud="https://evil.test")) == 401
        assert status(_better_auth_token(jwks_signer, iss="https://evil.test")) == 401
        assert status(_better_auth_token(jwks_signer, exp_offset_s=-60)) == 401
        assert status(_better_auth_token(jwks_signer, sub="user-999")) == 403


def test_ws_auth_via_jwks_defaults_to_enabled_modalities(
    jwks_signer: Ed25519PrivateKey,
) -> None:
    with (
        TestClient(_jwks_app()) as client,
        client.websocket_connect("/ws/session") as ws,
    ):
        ws.send_json({"type": "auth", "token": _better_auth_token(jwks_signer)})
        auth_ok = ws.receive_json()
        assert auth_ok["type"] == "auth_ok"
        assert auth_ok["authorized_modalities"] == ["voice", "video"]


def test_no_verification_key_configured_rejects_tokens() -> None:
    priv, _ = generate_ed25519_keypair()
    app = create_app(build_test_settings(jwt_jwks_url=None))
    with TestClient(app) as client:
        resp = client.get(
            "/session/status",
            headers={"Authorization": f"Bearer {mint_jwt(priv)}"},
        )
        assert resp.status_code == 401
