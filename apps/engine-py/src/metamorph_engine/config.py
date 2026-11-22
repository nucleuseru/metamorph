"""Runtime configuration for metamorph-engine."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class EngineSettings(BaseSettings):
    """Environment-driven settings tuned for low-latency RunPod inference."""

    model_config = SettingsConfigDict(
        env_prefix="ENGINE_",
        env_file=".env",
        extra="ignore",
    )

    host: str = "0.0.0.0"
    port: int = 8000
    workers: int = 1
    access_log: bool = False
    log_level: str = "info"

    # Inference / GPU defaults
    device: str = "cuda"
    dtype: str = "bfloat16"
    warmup_on_startup: bool = True


@lru_cache(maxsize=1)
def get_settings() -> EngineSettings:
    """Return cached settings instance to avoid repeated env parsing."""
    return EngineSettings()
