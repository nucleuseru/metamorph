import asyncio
import uuid
from typing import List
from fastapi import FastAPI, HTTPException, Depends, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from aiortc import RTCPeerConnection, RTCSessionDescription

from security import get_api_key
from models import SetupResponse, Offer
from sessions import sessions, pcs
from webrtc import VideoTransformTrack

app = FastAPI(title="WebRTC ML Processing API")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/setup", response_model=SetupResponse)
async def setup(
    prompt: str = Form(...),
    images: List[UploadFile] = File(...),
    api_key: str = Depends(get_api_key)
):
    session_id = str(uuid.uuid4())
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
        raise HTTPException(status_code=404, detail="Session not found")
    
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
            pc.addTrack(VideoTransformTrack(track, session_data))

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
    sessions.clear()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
