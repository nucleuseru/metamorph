import os
import uuid
import asyncio
import logging
import requests
from typing import List
from config import settings
from security import get_api_key
from sessions import sessions, pcs
from webrtc import VideoTransformTrack
from models import SetupResponse, Offer
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, HTTPException, Depends, File, UploadFile, Form
from aiortc import (
    RTCPeerConnection,
    RTCSessionDescription,
    RTCConfiguration,
    RTCIceServer,
)


logger = logging.getLogger(__name__)
app = FastAPI(title="WebRTC ML Processing API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/setup", response_model=SetupResponse)
async def setup(
    prompt: str = Form(...),
    images: List[UploadFile] = File(...),
    api_key: str = Depends(get_api_key),
):
    session_id = str(uuid.uuid4())
    image_contents = []
    for image in images:
        content = await image.read()
        image_contents.append(content)

    sessions[session_id] = {"prompt": prompt, "images": image_contents}
    return SetupResponse(session_id=session_id)


async def fetch_ice_servers() -> List[RTCIceServer]:
    if not settings.metered_api_key:
        logger.warning(
            "METERED_API_KEY is not set. Falling back to public STUN server only."
        )
        return [RTCIceServer(urls="stun:stun.l.google.com:19302")]

    metered_url = "https://metamorph.metered.live/api/v1/turn/credentials"
    try:
        response = await asyncio.to_thread(
            requests.get,
            metered_url,
            params={"apiKey": settings.metered_api_key},
            timeout=10,
        )
        response.raise_for_status()
        servers = response.json()

        return [
            RTCIceServer(
                urls=s.get("urls"),
                username=s.get("username"),
                credential=s.get("credential"),
            )
            for s in servers
        ]
    except Exception as e:
        logger.error("Failed to fetch Metered TURN credentials: %s", e)
        return [RTCIceServer(urls="stun:stun.l.google.com:19302")]


@app.get("/ice-servers")
async def get_ice_servers(api_key: str = Depends(get_api_key)):
    ice_servers = await fetch_ice_servers()

    return [
        {
            "urls": s.urls,
            **(  # only include auth fields when present
                {"username": s.username, "credential": s.credential}
                if s.username
                else {}
            ),
        }
        for s in ice_servers
    ]


@app.post("/offer")
async def offer_handler(params: Offer, _api_key: str = Depends(get_api_key)):
    if params.session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session_data = sessions[params.session_id]
    offer = RTCSessionDescription(sdp=params.sdp, type=params.type)

    ice_servers = await fetch_ice_servers()
    config = RTCConfiguration(iceServers=ice_servers)
    pc = RTCPeerConnection(configuration=config)
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

    return {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}


@app.get("/", response_class=HTMLResponse)
async def index():
    api_dir = os.path.dirname(os.path.abspath(__file__))
    html_path = os.path.join(api_dir, "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        html_content = f.read()
    html_content = html_content.replace('value=""', f'value="{settings.api_key}"')
    return HTMLResponse(content=html_content)


@app.on_event("startup")
async def on_startup():
    import threading
    from ml_pipeline import get_pipeline

    def load_pipeline():
        try:
            logger.info("Initializing ML pipeline pre-loading in background thread...")
            get_pipeline()
            logger.info("ML pipeline successfully pre-loaded and ready.")
        except Exception as e:
            logger.error(f"Error pre-loading ML pipeline on startup: {e}")

    threading.Thread(target=load_pipeline, daemon=True).start()


@app.on_event("shutdown")
async def on_shutdown():
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    sessions.clear()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
