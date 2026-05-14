from typing import List
from pydantic import BaseModel

class SetupResponse(BaseModel):
    session_id: str

class Offer(BaseModel):
    sdp: str
    type: str
    session_id: str
