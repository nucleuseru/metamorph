from fastapi import HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from config import settings

API_KEY_NAME = "X-API-Key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def get_api_key(api_key: str = Security(api_key_header)):
    if api_key == settings.api_key:
        return api_key
    raise HTTPException(status_code=403, detail="Could not validate credentials")
