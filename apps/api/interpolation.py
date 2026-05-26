import os
import sys
import torch
from typing import List
from av import VideoFrame
from config import settings
import torch.nn.functional as F

rife_model = None


def get_rife_model():
    global rife_model
    if rife_model is None:
        api_dir = os.path.dirname(os.path.abspath(__file__))
        rife_dir = os.path.join(api_dir, "rife")
        if rife_dir not in sys.path:
            sys.path.insert(0, rife_dir)

        try:
            from train_log.RIFE_HDv3 import Model
        except Exception as e:
            print(
                f"Notice: RIFE_HDv3 not found in train_log ({e}). Trying fallback imports."
            )
            try:
                from model.RIFE_HDv3 import Model
            except Exception:
                try:
                    from model.RIFE_HD import Model
                except Exception:
                    from model.RIFE import Model

        rife_model = Model()
        model_dir = os.path.join(rife_dir, "train_log")
        rife_model.load_model(model_dir, -1)
        rife_model.eval()
        rife_model.device()

        if settings.use_rife_fp16 and torch.cuda.is_available():
            rife_model.flownet.half()

        if settings.enable_torch_compile and torch.cuda.is_available():
            rife_model.flownet = torch.compile(
                rife_model.flownet, mode="reduce-overhead"
            )

    return rife_model


def fallback_static_interpolation(
    frame1: VideoFrame, _frame2: VideoFrame, count: int = 5
) -> List[VideoFrame]:
    frames = []
    img1 = frame1.to_ndarray(format="bgr24")
    for _ in range(count):
        f = VideoFrame.from_ndarray(img1, format="bgr24")
        frames.append(f)
    return frames


def interpolate_frames(
    frame1: VideoFrame, frame2: VideoFrame, count: int = 5
) -> List[VideoFrame]:
    try:
        model = get_rife_model()

        img1 = frame1.to_ndarray(format="rgb24")
        img2 = frame2.to_ndarray(format="rgb24")

        h, w, _ = img1.shape
        device = "cuda" if torch.cuda.is_available() else "cpu"

        I0 = (
            torch.from_numpy(img1.transpose(2, 0, 1))
            .to(device, non_blocking=True)
            .unsqueeze(0)
            / 255.0
        )
        I1 = (
            torch.from_numpy(img2.transpose(2, 0, 1))
            .to(device, non_blocking=True)
            .unsqueeze(0)
            / 255.0
        )

        if settings.use_rife_fp16 and device == "cuda":
            I0 = I0.half()
            I1 = I1.half()
        else:
            I0 = I0.float()
            I1 = I1.float()

        pad_h = (64 - h % 64) % 64
        pad_w = (64 - w % 64) % 64

        if pad_h > 0 or pad_w > 0:
            I0_padded = F.pad(I0, (0, pad_w, 0, pad_h), mode="replicate")
            I1_padded = F.pad(I1, (0, pad_w, 0, pad_h), mode="replicate")
        else:
            I0_padded = I0
            I1_padded = I1

        # Check model version for direct multi-ratio or recursive bisection
        version = getattr(model, "version", 0)
        intermediate_tensors = []

        if count > 1:
            with torch.no_grad():
                if version >= 3.9:
                    for i in range(count - 1):
                        ratio = (i + 1) * 1.0 / count
                        mid = model.inference(I0_padded, I1_padded, ratio)
                        intermediate_tensors.append(mid)
                else:

                    def make_inference(I0_t, I1_t, n):
                        # Default timestep is 0.5 for bisection
                        middle = model.inference(I0_t, I1_t)
                        if n == 1:
                            return [middle]
                        first_half = make_inference(I0_t, middle, n // 2)
                        second_half = make_inference(middle, I1_t, n // 2)
                        if n % 2:
                            return [*first_half, middle, *second_half]
                        else:
                            return [*first_half, *second_half]

                    intermediate_tensors = make_inference(
                        I0_padded, I1_padded, count - 1
                    )
        else:
            intermediate_tensors = []

        frames = []

        def tensor_to_frame(tensor_padded):
            if pad_h > 0 or pad_w > 0:
                tensor = tensor_padded[:, :, :h, :w]
            else:
                tensor = tensor_padded
            img_np = (
                (tensor[0].clamp(0.0, 1.0) * 255.0)
                .byte()
                .cpu()
                .numpy()
                .transpose(1, 2, 0)
            )
            return VideoFrame.from_ndarray(img_np, format="rgb24")

        frames.append(VideoFrame.from_ndarray(img1, format="rgb24"))

        for t in intermediate_tensors:
            frames.append(tensor_to_frame(t))

        return frames

    except Exception as e:
        print(f"Error during RIFE frame interpolation: {e}")
        return fallback_static_interpolation(frame1, frame2, count)
