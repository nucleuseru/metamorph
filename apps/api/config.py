import secrets
import logging
from typing import List
from pydantic_settings import BaseSettings


logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    api_key: str = ""
    metered_api_key: str = ""
    cors_origins: List[str] = ["http://localhost:3000"]

    host: str = "127.0.0.1"
    port: int = 8000

    model_id: str = "black-forest-labs/FLUX.2-klein-9b-kv"
    vae_model_id: str = "black-forest-labs/FLUX.2-small-decoder"
    lora_model_id: str = "dx8152/Flux2-Klein-9B-Consistency"
    hf_token: str = ""

    inference_interval: int = 16
    inference_resolution: int = 480
    rife_scale: float = 1.0
    lora_scale: float = 0.8

    enable_torch_compile: bool = False
    use_channels_last: bool = False
    use_tf32: bool = False
    use_rife_fp16: bool = False


settings = Settings()

if not settings.api_key:
    logger.warning(
        "API_KEY environment variable is not set. Generating a secure ephemeral key for testing."
    )
    settings.api_key = secrets.token_hex(32)
    logger.info(f"Ephemeral API_KEY generated: {settings.api_key}")
