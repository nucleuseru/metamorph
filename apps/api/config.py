import secrets
import logging
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("config")


class Settings(BaseSettings):
    # API Security
    api_key: str = ""

    # CORS Configuration
    cors_origins: List[str] = ["http://localhost:3000"]

    # Server configuration
    host: str = "127.0.0.1"
    port: int = 8000

    # ML Models Configuration
    model_id: str = "black-forest-labs/FLUX.2-klein-9b-kv-fp8"
    vae_model_id: str = "black-forest-labs/FLUX.2-small-decoder"
    lora_model_id: str = "dx8152/Flux2-Klein-9B-Consistency"

    # Hyperparameters
    inference_interval: int = 16
    inference_resolution: int = 512
    rife_scale: float = 1.0
    lora_scale: float = 0.8

    # Optimizations
    enable_torch_compile: bool = True
    use_channels_last: bool = True
    use_tf32: bool = True
    use_rife_fp16: bool = True

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )


settings = Settings()

# Secure fallback for API Key
if not settings.api_key:
    logger.warning(
        "API_KEY environment variable is not set. Generating a secure ephemeral key for testing."
    )
    settings.api_key = secrets.token_hex(32)
    logger.info(f"Ephemeral API_KEY generated: {settings.api_key}")
