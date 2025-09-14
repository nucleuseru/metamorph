import uuid

import cv2
import numpy as np
from aiortc import (
    MediaStreamTrack,
    RTCPeerConnection,
    RTCSessionDescription,
    VideoStreamTrack,
)
from av import VideoFrame
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from processors.face_swapper import swap_face
from processors.utils import IMAGE, Face, get_one_face


class Room:
    def __init__(self, face: Face):  # source face
        self.face = face
        self.audioTrack: MediaStreamTrack | None = None
        self.videoTrack: MediaStreamTrack | None = None
        self.producer: RTCPeerConnection | None = None
        self.consumer: RTCPeerConnection | None = None


class ProcessedVideo(VideoStreamTrack):
    def __init__(self, room_id: str, track):
        super().__init__()
        self.track = track
        self.room_id = room_id

    async def recv(self):
        frame = await self.track.recv()
        pts = frame.pts
        time_base = frame.time_base
        frame = frame.to_ndarray(format="bgr24")

        try:
            target_face = get_one_face(frame)
        except:
            frame = VideoFrame.from_ndarray(frame, format="bgr24")
            frame.pts = pts
            frame.time_base = time_base

            self.prev_frame = frame

            return frame

        try:
            frame = swap_face(rooms[self.room_id].face, target_face, frame)
        except:
            self.prev_frame.pts = pts
            self.prev_frame.time_base = time_base
            return self.prev_frame

        frame = VideoFrame.from_ndarray(frame, format="bgr24")  # type: ignore
        frame.pts = pts
        frame.time_base = time_base

        self.prev_frame = frame

        return frame


rooms: dict[str, Room] = dict()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)


@app.post("/setup")
async def setup(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        img = np.frombuffer(contents, np.uint8)
        img: IMAGE = cv2.imdecode(
            img, cv2.IMREAD_COLOR
        )  # pyright: ignore[reportAssignmentType]
        face = get_one_face(img)

        room_id = str(uuid.uuid4())
        rooms[room_id] = Room(face)

        return {"success": True, "data": {"room_id": room_id}}

    except Exception as e:
        return {"success": False}


@app.websocket("/ws")
async def websocket(ws: WebSocket, room_id: str, producer: bool):
    await ws.accept()

    pc = RTCPeerConnection()
    room = rooms.get(room_id)

    if room is None:
        await ws.send_json({"event": "exception", "exception": "Invalid room id"})
        await ws.close()
        return

    if producer:
        room.producer = pc

        @pc.on("track")
        def on_track(track: MediaStreamTrack):
            if not room:
                return

            if track.kind == "video":
                room.videoTrack = track
            elif track.kind == "audio":
                room.audioTrack = track

    else:
        room.consumer = pc

        if room.videoTrack:
            # pc.addTrack(ProcessedVideo(room_id, room.videoTrack))
            pc.addTrack(room.videoTrack)
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
        room = rooms.get(room_id)

        if not room:
            return

        if producer and room.producer:
            await room.producer.close()

            if room.consumer:
                await room.consumer.close()

            del rooms[room_id]

        elif room.consumer:
            await room.consumer.close()
            room.consumer = None
