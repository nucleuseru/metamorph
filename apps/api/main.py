import asyncio
import os
import uuid
from typing import List, Dict, Any
from fastapi import FastAPI, HTTPException, Depends, Security, File, UploadFile, Form
from fastapi.security.api_key import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import VideoFrame

app = FastAPI(title="WebRTC ML Processing API")

# Security
API_KEY_NAME = "X-API-Key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)
VALID_API_KEYS = {os.getenv("API_KEY", "default-secret-key")}

# In-memory session storage
# Maps session_id -> {"prompt": str, "images": List[bytes]}
sessions: Dict[str, Dict[str, Any]] = {}
pcs = set()

async def get_api_key(api_key: str = Security(api_key_header)):
    if api_key in VALID_API_KEYS:
        return api_key
    raise HTTPException(status_code=403, detail="Could not validate credentials")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SetupResponse(BaseModel):
    session_id: str

class VideoTransformTrack(MediaStreamTrack):
    """
    A video stream track that transforms frames using session-specific ML data.
    """
    kind = "video"

    def __init__(self, track, session_data: Dict[str, Any]):
        super().__init__()
        self.track = track
        self.session_data = session_data

    async def recv(self):
        frame = await self.track.recv()
        
        # ML PROCESSING WITH SESSION DATA
        # prompt = self.session_data.get("prompt")
        # ref_images = self.session_data.get("images")  # List of bytes
        
        # Example workflow:
        # img = frame.to_ndarray(format="bgr24")
        # processed_img = my_ml_engine.run(img, prompt, ref_images)
        # new_frame = VideoFrame.from_ndarray(processed_img, format="bgr24")
        
        new_frame = frame
        new_frame.pts = frame.pts
        new_frame.time_base = frame.time_base
        return new_frame

class Offer(BaseModel):
    sdp: str
    type: str
    session_id: str

@app.post("/setup", response_model=SetupResponse)
async def setup(
    prompt: str = Form(...),
    images: List[UploadFile] = File(...),
    api_key: str = Depends(get_api_key)
):
    session_id = str(uuid.uuid4())
    
    # Process uploaded files
    image_contents = []
    for image in images:
        content = await image.read()
        image_contents.append(content)
        
    sessions[session_id] = {
        "prompt": prompt,
        "images": image_contents
    }
    return SetupResponse(session_id=session_id)

@app.post("/offer")
async def offer(params: Offer, api_key: str = Depends(get_api_key)):
    if params.session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found. Call /setup first.")
    
    session_data = sessions[params.session_id]
    offer = RTCSessionDescription(sdp=params.sdp, type=params.type)
    pc = RTCPeerConnection()
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        if pc.connectionState == "failed":
            await pc.close()
            pcs.discard(pc)

    @pc.on("track")
    def on_track(track):
        if track.kind == "video":
            # Pass the session-specific data to the transformation track
            local_track = VideoTransformTrack(track, session_data)
            pc.addTrack(local_track)
        
        @track.on("ended")
        async def on_ended():
            print(f"Track {track.kind} ended")

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return {
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    }

@app.on_event("shutdown")
async def on_shutdown():
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()
    sessions.clear()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
