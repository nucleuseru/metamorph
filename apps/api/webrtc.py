import asyncio
from typing import Dict, Any, Optional
from aiortc import MediaStreamTrack
from av import VideoFrame
import numpy as np
from config import settings
from ml_pipeline import run_inference
from interpolation import interpolate_frames


class VideoTransformTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, track, session_data: Dict[str, Any]):
        super().__init__()
        self.track = track
        self.session_data = session_data
        self.queue = asyncio.Queue(maxsize=30)
        self._processing_task = asyncio.create_task(self._process_frames())
        self._empty_frame: Optional[VideoFrame] = None
        self._last_pts = 0
        self._last_time_base = None

    def _make_empty_frame(self, width=640, height=480) -> VideoFrame:
        if self._empty_frame is None:
            black_img = np.zeros((height, width, 3), dtype=np.uint8)
            self._empty_frame = VideoFrame.from_ndarray(black_img, format="bgr24")

        frame = self._empty_frame
        frame.pts = self._last_pts + 1
        frame.time_base = self._last_time_base or "1/30"
        self._last_pts = frame.pts
        return frame

    async def _process_frames(self):
        frame_counter = 0
        last_inference: Optional[VideoFrame] = None
        n_frames = settings.inference_interval

        try:
            while True:
                frame = await self.track.recv()
                self._last_time_base = frame.time_base

                if frame_counter % n_frames == 0:
                    curr_inference = await asyncio.to_thread(
                        run_inference, frame, self.session_data
                    )

                    if last_inference is not None:
                        interpolated_list = interpolate_frames(
                            last_inference, curr_inference, count=n_frames
                        )
                        start_pts = frame.pts - n_frames

                        for i, interp in enumerate(interpolated_list):
                            interp.pts = start_pts + i
                            interp.time_base = frame.time_base

                            try:
                                self.queue.put_nowait(interp)
                            except asyncio.QueueFull:
                                break

                    last_inference = curr_inference

                frame_counter += 1
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"Processing loop error: {e}")

    async def recv(self):
        try:
            frame = self.queue.get_nowait()
            self._last_pts = frame.pts
            return frame
        except asyncio.QueueEmpty:
            return self._make_empty_frame()

    def stop(self):
        super().stop()
        self._processing_task.cancel()
