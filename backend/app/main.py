import cv2
import uuid
import numpy as np
from av import VideoFrame
from typing import Any
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect

from processors.utils import get_one_face, Face
from processors.face_swapper import process_img

from aiortc import (
    RTCSessionDescription,
    RTCPeerConnection,
    MediaStreamTrack,
    VideoStreamTrack,
    RTCIceCandidate,
)


class Room:
    def __init__(self, face: Face):  # source face
        self.face = face
        self.audioTrack: MediaStreamTrack | None = None
        self.videoTrack: MediaStreamTrack | None = None
        self.producer: RTCPeerConnection | None = None
        self.consumer: RTCPeerConnection | None = None


class ProcessedVideo(VideoStreamTrack):
    def __init__(self, room_id: str, source):
        super().__init__()
        self.source = source
        self.room_id = room_id

    async def recv(self):
        try:
            print("processing...")
            frame: VideoFrame = await self.source.recv()
            img = frame.to_ndarray(format="bgr24")
            face = rooms[self.room_id].face
            result: Any = process_img(face, img)

            new_frame = VideoFrame.from_ndarray(result, format="bgr24")
            new_frame.pts = frame.pts
            new_frame.time_base = frame.time_base

            self.prev_frame = new_frame

            return new_frame

        except Exception as e:
            return self.prev_frame

        finally:
            print("processing completed")


rooms: dict[str, Room] = dict()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)


@app.post("/setup")
async def setup(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        np_arr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        face = get_one_face(img)

        room_id = str(uuid.uuid4())
        rooms[room_id] = Room(face)

        return {"success": True, "data": {"room_id": room_id}}

    except Exception as e:
        print("set up error:", e)
        return {"success": False}


@app.websocket("/ws")
async def websocket(ws: WebSocket, room_id: str, producer: bool):
    await ws.accept()

    pc = RTCPeerConnection()
    room = rooms[room_id]

    if producer:
        room.producer = pc

        @pc.on("track")
        def on_track(track: MediaStreamTrack):
            if track.kind == "video":
                room.videoTrack = track
            elif track.kind == "audio":
                room.audioTrack = track

    else:
        room.consumer = pc

        if room.videoTrack:
            pc.addTrack(ProcessedVideo(room_id, room.videoTrack))
        if room.audioTrack:
            pc.addTrack(room.audioTrack)

    try:
        while True:
            data = await ws.receive_json()

            if data["event"] == "offer":
                offer = RTCSessionDescription(**data["offer"])
                await pc.setRemoteDescription(offer)

                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)

                await ws.send_json(
                    {"event": "answer", "answer": pc.localDescription.__dict__}
                )

    except WebSocketDisconnect:
        room = rooms[room_id]

        if producer and room.producer:
            await room.producer.close()

            if room.consumer:
                await room.consumer.close()

            del rooms[room_id]

        elif room.consumer:
            await room.consumer.close()
            room.consumer = None
