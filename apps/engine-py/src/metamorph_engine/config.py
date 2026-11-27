"""Runtime configuration for metamorph-engine."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_vendor_dir() -> Path:
    """Resolve the repository vendor/ directory relative to this package."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "vendor"
        if candidate.is_dir():
            return candidate
    return Path.cwd() / "vendor"


class EngineSettings(BaseSettings):
    """Environment-driven settings tuned for single-user GPU inference instances."""

    model_config = SettingsConfigDict(
        env_prefix="ENGINE_",
        env_file=".env",
        extra="ignore",
    )

    # Server
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)
    access_log: bool = False
    log_level: str = "info"
    cors_origins: str = "*"
    ws_max_size_bytes: int = Field(default=32 * 1024 * 1024, ge=65536)

    # Instance identity & modality selection
    instance_id: str = "local-instance"
    user_id: str | None = None
    enable_voice: bool = True
    enable_video: bool = True
    backend: Literal["gpu", "mock"] = "gpu"

    # Authentication (EdDSA / Ed25519 JWT via static SPKI PEM and/or JWKS)
    jwt_public_key: str | None = None
    jwt_jwks_url: str | None = None
    jwt_jwks_cache_ttl_s: int = Field(default=300, ge=1)
    jwt_audience: str | None = None
    jwt_issuer: str | None = None
    jwt_leeway_s: int = Field(default=10, ge=0)
    ws_auth_timeout_s: float = Field(default=5.0, gt=0.0)
    enforce_token_expiry: bool = True

    # Lifecycle & shutdown
    startup_idle_timeout_s: float = Field(default=120.0, gt=0.0)
    disconnect_timeout_s: float = Field(default=30.0, gt=0.0)
    shutdown_grace_s: float = Field(default=5.0, gt=0.0)
    lifecycle_webhook_url: str | None = None
    lifecycle_webhook_secret: str | None = None
    lifecycle_webhook_timeout_s: float = Field(default=5.0, gt=0.0)

    # Hybrid reference asset bootstrap & limits
    initial_prompt: str | None = None
    initial_ref_image_url: str | None = None
    initial_ref_audio_url: str | None = None
    asset_download_timeout_s: float = Field(default=15.0, gt=0.0)
    max_ref_image_bytes: int = Field(default=15 * 1024 * 1024, ge=1024)
    max_ref_audio_bytes: int = Field(default=25 * 1024 * 1024, ge=1024)
    allowed_asset_hosts: str = ""

    # GPU / runtime defaults
    device: str = "cuda"
    dtype: str = "bfloat16"
    warmup_on_startup: bool = True
    async_startup: bool | None = None
    vendor_dir: str | None = None

    # Voice pipeline (Seed-VC v1 real-time)
    voice_sample_rate: int = Field(default=22050, ge=8000, le=96000)
    voice_block_time_s: float = Field(default=0.25, gt=0.02, le=2.0)
    voice_crossfade_s: float = Field(default=0.04, gt=0.0, le=0.5)
    voice_extra_context_left_s: float = Field(default=2.5, ge=0.1, le=15.0)
    voice_extra_dit_context_left_s: float = Field(default=0.5, ge=0.05, le=10.0)
    voice_extra_context_right_s: float = Field(default=0.04, ge=0.0, le=2.0)
    voice_diffusion_steps: int = Field(default=10, ge=1, le=50)
    voice_cfg_rate: float = Field(default=0.7, ge=0.0, le=2.0)
    voice_max_prompt_length_s: float = Field(default=3.0, ge=0.5, le=30.0)
    voice_vad_backend: Literal["rms", "none"] = "rms"
    voice_vad_threshold_db: float = Field(default=-45.0, ge=-90.0, le=0.0)
    voice_vad_hangover_s: float = Field(default=0.3, ge=0.0, le=5.0)
    voice_vad_adaptive_noise_floor: bool = True
    voice_vad_noise_margin_db: float = Field(default=10.0, ge=0.0, le=40.0)
    voice_checkpoint_path: str | None = None
    voice_config_path: str | None = None
    voice_cache_dir: str | None = None

    # Video pipeline (JoyAI-Video-Edit RV2V/V2V)
    video_width: int = Field(default=840, ge=64, le=4096)
    video_height: int = Field(default=480, ge=64, le=4096)
    video_fps: int = Field(default=24, ge=1, le=120)
    video_num_inference_steps: int = Field(default=2, ge=1, le=50)
    video_seed: int = 42
    video_output_quality: int = Field(default=60, ge=1, le=100)
    video_max_inflight_chunks: int = Field(default=2, ge=0, le=16)
    video_freeze_kv_on_static: bool = True
    video_static_diff_thresh: float = Field(default=0.5, ge=0.0)
    video_max_temporal_ids: int | None = Field(default=8, ge=1)
    video_dit_ckpt: str | None = None
    video_vae_ckpt: str | None = None
    video_text_encoder_ckpt: str | None = None
    video_session_close_timeout_s: float = Field(default=5.0, gt=0.0)

    # A/V Synchronization
    av_sync_enabled: bool = True
    av_sync_max_hold_s: float = Field(default=1.0, gt=0.0, le=10.0)
    av_sync_safety_margin_ms: float = Field(default=15.0, ge=0.0, le=500.0)
    av_sync_stale_track_s: float = Field(default=2.0, gt=0.1, le=30.0)
    av_sync_stats_interval_s: float = Field(default=1.0, gt=0.1, le=60.0)

    # Mock backend timing knobs (CPU tests / local dev)
    mock_video_chunk_frames: int = Field(default=8, ge=1, le=64)
    mock_video_latency_ms: float = Field(default=40.0, ge=0.0, le=5000.0)
    mock_audio_latency_ms: float = Field(default=10.0, ge=0.0, le=5000.0)

    @model_validator(mode="after")
    def _validate_modalities(self) -> "EngineSettings":
        if not self.enable_voice and not self.enable_video:
            raise ValueError(
                "At least one modality (enable_voice or enable_video) must be enabled."
            )
        return self

    @property
    def enabled_modalities(self) -> tuple[Literal["voice", "video"], ...]:
        """Return tuple of enabled modalities on this instance."""
        modalities: list[Literal["voice", "video"]] = []
        if self.enable_voice:
            modalities.append("voice")
        if self.enable_video:
            modalities.append("video")
        return tuple(modalities)

    @property
    def cors_origins_list(self) -> list[str]:
        """Parse comma-separated CORS origins."""
        items = [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]
        return items or ["*"]

    @property
    def allowed_asset_hosts_set(self) -> set[str]:
        """Parse comma-separated asset host allowlist."""
        return {
            host.strip().lower() for host in self.allowed_asset_hosts.split(",") if host.strip()
        }

    @property
    def resolved_vendor_dir(self) -> Path:
        """Return vendor directory Path."""
        return Path(self.vendor_dir).resolve() if self.vendor_dir else _default_vendor_dir()

    @property
    def use_async_startup(self) -> bool:
        """Return True when warmup runs in the background after HTTP/WS port bind."""
        if self.async_startup is not None:
            return self.async_startup
        return self.backend == "gpu"


@lru_cache(maxsize=1)
def get_settings() -> EngineSettings:
    """Return cached settings instance to avoid repeated env parsing."""
    return EngineSettings()
