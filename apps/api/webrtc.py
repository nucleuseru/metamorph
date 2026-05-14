import asyncio
from typing import Dict, Any, Optional, List
from aiortc import MediaStreamTrack
from av import VideoFrame
import numpy as np

# --- ML Processing Placeholders ---

def run_inference(frame: VideoFrame, session_data: Dict[str, Any]) -> VideoFrame:
    """Placeholder for slow ML inference."""
    return frame

def interpolate_frames(frame1: VideoFrame, frame2: VideoFrame, count: int = 5) -> List[VideoFrame]:
    """
    Placeholder for frame interpolation.
    Returns a list of 'count' frames starting with frame1 and ending with frame2
    (if count > 1).
    """
    # For now, just return a list containing frame1 repeated 'count' times
    # In a real implementation, this would generate intermediate frames
    return [frame1 for _ in range(count)]

# --- WebRTC Components ---

class VideoTransformTrack(MediaStreamTrack):
    """
    A video track that processes frames in a background loop and uses a queue.
    Interpolates frames for every inference. Returns a black frame if the queue is empty.
    """
    kind = "video"

    def __init__(self, track, session_data: Dict[str, Any]):
        super().__init__()
        self.track = track
        self.session_data = session_data
        
        self.queue = asyncio.Queue(maxsize=30)
        self._processing_task = asyncio.create_task(self._process_frames())
        
        # Cache for empty frame generation
        self._empty_frame: Optional[VideoFrame] = None
        self._last_pts = 0
        self._last_time_base = None

    def _make_empty_frame(self, width=640, height=480) -> VideoFrame:
        """Generates a black frame."""
        if self._empty_frame is None:
            black_img = np.zeros((height, width, 3), dtype=np.uint8)
            self._empty_frame = VideoFrame.from_ndarray(black_img, format="bgr24")
        
        frame = self._empty_frame
        frame.pts = self._last_pts + 1
        frame.time_base = self._last_time_base or "1/30"
        self._last_pts = frame.pts
        return frame

    async def _process_frames(self):
        """Background loop to consume frames, run inference, and interpolate."""
        frame_counter = 0
        last_inference: Optional[VideoFrame] = None
        
        try:
            while True:
                frame = await self.track.recv()
                self._last_time_base = frame.time_base
                
                # Run inference every 5th frame
                if frame_counter % 5 == 0:
                    curr_inference = run_inference(frame, self.session_data)
                    
                    if last_inference is not None:
                        # Generate a list of frames including last and current inference
                        interpolated_list = interpolate_frames(last_inference, curr_inference, count=5)
                        
                        # Calculate PTS starting from the previous marker
                        start_pts = frame.pts - 5
                        
                        for i, interp in enumerate(interpolated_list):
                            # Set PTS and time_base for each frame in the batch
                            interp.pts = start_pts + i
                            interp.time_base = frame.time_base
                            
                            try:
                                self.queue.put_nowait(interp)
                            except asyncio.QueueFull:
                                # If the queue is full, we drop the rest of this batch
                                # to keep up with the real-time stream
                                break 
                                
                    last_inference = curr_inference
                
                frame_counter += 1
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"Processing loop error: {e}")

    async def recv(self):
        """WebRTC consumer method."""
        try:
            frame = self.queue.get_nowait()
            self._last_pts = frame.pts
            return frame
        except asyncio.QueueEmpty:
            return self._make_empty_frame()

    def stop(self):
        super().stop()
        self._processing_task.cancel()
