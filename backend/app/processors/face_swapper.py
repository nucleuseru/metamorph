import os
import cv2
import threading
import insightface
from typing import Any
from insightface.model_zoo import inswapper
from processors.utils import Face, IMAGE, get_one_face, EXECUTION_PROVIDERS, MODELS_DIR


THREAD_LOCK = threading.Lock()
FACE_SWAPPER: Any = None


def get_face_swapper() -> inswapper.INSwapper:
    global FACE_SWAPPER

    with THREAD_LOCK:
        if FACE_SWAPPER == None:
            model_name = "inswapper_128.onnx"

            if "CUDAExecutionProvider" in EXECUTION_PROVIDERS:
                model_name = "inswapper_128_fp16.onnx"

            model_path = os.path.join(MODELS_DIR, model_name)
            FACE_SWAPPER = insightface.model_zoo.get_model(
                model_path, providers=EXECUTION_PROVIDERS
            )

    return FACE_SWAPPER


def swap_face(source_face: Face, target_face: Face, temp_img: IMAGE) -> IMAGE:
    face_swapper = get_face_swapper()
    swapped_img: Any = face_swapper.get(
        temp_img, target_face, source_face, paste_back=True
    )
    return swapped_img


def process_img(source_face: Face, temp_img: IMAGE):
    target_face = get_one_face(temp_img)
    result = swap_face(source_face, target_face, temp_img)
    return result
