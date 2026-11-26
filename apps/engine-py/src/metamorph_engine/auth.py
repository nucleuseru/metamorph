"""Asymmetric EdDSA (Ed25519) JWT authentication for HTTP and WebSocket routes."""

from __future__ import annotations

from typing import Annotated, Any

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from fastapi import Depends, HTTPException, Request
from jwt.exceptions import InvalidTokenError, PyJWKClientError, PyJWKError
from pydantic import BaseModel

from metamorph_engine.config import EngineSettings
from metamorph_engine.protocol import Modality


class AuthError(Exception):
    """Authentication or authorization failure with HTTP and WS close codes."""

    def __init__(self, status_code: int, ws_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.ws_code = ws_code
        self.detail = detail


class JWTClaims(BaseModel):
    """Validated claims extracted from an EdDSA token minted by apps/api."""

    sub: str
    aud: str | None = None
    iss: str | None = None
    exp: int
    iat: int | None = None
    jti: str | None = None
    modalities: tuple[Modality, ...]


def _load_ed25519_key(pem: str) -> Ed25519PublicKey | None:
    if not pem:
        return None
    loaded = load_pem_public_key(pem.encode("utf-8"))
    if not isinstance(loaded, Ed25519PublicKey):
        raise ValueError("ENGINE_JWT_PUBLIC_KEY must be an Ed25519 public key in PEM format.")
    return loaded


class JWTAuthenticator:
    """Verifies EdDSA JWTs against instance identity, user binding, and modalities."""

    def __init__(
        self,
        settings: EngineSettings,
        *,
        jwk_client: jwt.PyJWKClient | None = None,
    ) -> None:
        self._settings = settings
        self._public_key: Ed25519PublicKey | None = _load_ed25519_key(
            settings.normalized_jwt_public_key
        )
        self._jwk_client: jwt.PyJWKClient | None = jwk_client
        if self._jwk_client is None and settings.jwt_jwks_url:
            self._jwk_client = jwt.PyJWKClient(
                settings.jwt_jwks_url,
                cache_keys=True,
                lifespan=settings.jwt_jwks_cache_ttl_s,
            )
        self._bound_user_id: str | None = settings.user_id

    @staticmethod
    def extract_bearer(authorization: str | None) -> str | None:
        """Extract raw JWT from an `Authorization: Bearer <token>` header."""
        if not authorization:
            return None
        scheme, _, token = authorization.strip().partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            return None
        return token.strip()

    def verify_token(self, token: str) -> JWTClaims:
        """Decode and validate an EdDSA JWT, returning parsed `JWTClaims`."""
        if self._jwk_client is None and self._public_key is None:
            raise AuthError(401, 4001, "JWT verification is not configured on this instance.")
        if not token or not token.strip():
            raise AuthError(401, 4001, "Missing JWT token.")
        token = token.strip()
        signing_key = self._resolve_signing_key(token)

        required = ["sub", "exp"] if self._settings.enforce_token_expiry else ["sub"]
        decode_kwargs: dict[str, Any] = {
            "algorithms": ["EdDSA"],
            "leeway": self._settings.jwt_leeway_s,
            "options": {
                "require": required,
                "verify_exp": self._settings.enforce_token_expiry,
            },
        }
        if self._settings.jwt_audience:
            decode_kwargs["audience"] = self._settings.jwt_audience
        elif self._jwk_client is None and self._settings.instance_id:
            decode_kwargs["audience"] = self._settings.instance_id
        else:
            decode_kwargs["options"]["verify_aud"] = False
        if self._settings.jwt_issuer:
            decode_kwargs["issuer"] = self._settings.jwt_issuer

        try:
            payload = jwt.decode(token, key=signing_key, **decode_kwargs)
        except InvalidTokenError as exc:
            raise AuthError(401, 4001, f"Invalid JWT: {exc}") from exc

        sub = payload.get("sub")
        if not isinstance(sub, str) or not sub.strip():
            raise AuthError(401, 4001, "JWT missing valid 'sub' claim.")
        sub = sub.strip()

        if self._bound_user_id is not None and sub != self._bound_user_id:
            raise AuthError(403, 4003, "Token subject does not match dedicated instance user.")

        raw_aud = payload.get("aud")
        aud: str | None = None
        if isinstance(raw_aud, str):
            aud = raw_aud
        elif isinstance(raw_aud, list) and raw_aud:
            aud = str(raw_aud[0])

        modalities = self._validate_modalities(payload.get("modalities"))

        if self._bound_user_id is None:
            self._bound_user_id = sub

        return JWTClaims(
            sub=sub,
            aud=aud,
            iss=str(payload["iss"]) if payload.get("iss") is not None else None,
            exp=int(payload.get("exp", 0)),
            iat=int(payload["iat"]) if payload.get("iat") is not None else None,
            jti=str(payload["jti"]) if payload.get("jti") is not None else None,
            modalities=modalities,
        )

    def _resolve_signing_key(self, token: str) -> Any:
        """Pick the verification key: JWKS (by `kid`) when configured, else static PEM."""
        if self._jwk_client is None:
            return self._public_key
        try:
            return self._jwk_client.get_signing_key_from_jwt(token).key
        except (PyJWKClientError, PyJWKError, InvalidTokenError) as exc:
            raise AuthError(401, 4001, f"Invalid JWT: {exc}") from exc

    def _validate_modalities(self, raw_modalities: object) -> tuple[Modality, ...]:
        enabled = set(self._settings.enabled_modalities)
        if raw_modalities is None:
            return self._settings.enabled_modalities
        if not isinstance(raw_modalities, list) or not raw_modalities:
            raise AuthError(403, 4003, "JWT 'modalities' claim must be a non-empty list.")

        validated: list[Modality] = []
        for item in raw_modalities:
            if item not in ("voice", "video"):
                raise AuthError(403, 4003, f"Unsupported modality in JWT: {item!r}")
            modality: Modality = "voice" if item == "voice" else "video"
            if modality not in enabled:
                raise AuthError(
                    403,
                    4003,
                    f"Modality '{modality}' is not enabled on this instance.",
                )
            if modality not in validated:
                validated.append(modality)
        return tuple(validated)


def require_http_auth(request: Request) -> JWTClaims:
    """FastAPI dependency that enforces Bearer EdDSA JWT on HTTP routes."""
    authenticator: JWTAuthenticator = request.app.state.authenticator
    token = JWTAuthenticator.extract_bearer(request.headers.get("authorization"))
    if token is None:
        raise HTTPException(status_code=401, detail="Missing Authorization: Bearer token.")
    try:
        return authenticator.verify_token(token)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


RequireAuthDep = Annotated[JWTClaims, Depends(require_http_auth)]
