import asyncio
import numpy as np
from av import VideoFrame
from config import settings
from aiortc import MediaStreamTrack
from ml_pipeline import run_inference
from typing import Dict, Any, Optional
from interpolation import interpolate_frames


class VideoTransformTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, track, session_data: Dict[str, Any]):
        super().__init__()
        self.track = track
        self.session_data = session_data
        self.queue = asyncio.Queue(maxsize=30)
        self._processing_task = asyncio.create_task(self._process_frames())
        self._last_pts = 0
        self._last_time_base = None

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
        frame = await self.queue.get()
        self._last_pts = frame.pts
        return frame

    def stop(self):
        super().stop()
        self._processing_task.cancel()
