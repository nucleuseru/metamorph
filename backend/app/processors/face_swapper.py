import os
import threading

import insightface
from insightface.model_zoo import inswapper
from processors.utils import EXECUTION_PROVIDERS, IMAGE, MODELS_DIR, Face

THREAD_LOCK = threading.Lock()
FACE_SWAPPER = None


def get_face_swapper() -> inswapper.INSwapper:
    global FACE_SWAPPER

    with THREAD_LOCK:
        if FACE_SWAPPER is None:
            model_name = "inswapper_128.onnx"

            if "CUDAExecutionProvider" in EXECUTION_PROVIDERS:
                model_name = "inswapper_128_fp16.onnx"

            model_path = os.path.join(MODELS_DIR, model_name)
            FACE_SWAPPER = insightface.model_zoo.get_model(
                model_path, providers=EXECUTION_PROVIDERS
            )

    return FACE_SWAPPER  # pyright: ignore[reportReturnType]


def swap_face(source_face: Face, target_face: Face, temp_img: IMAGE):
    face_swapper = get_face_swapper()
    temp_img = face_swapper.get(
        temp_img, target_face, source_face, paste_back=True
    )  # pyright: ignore[reportAssignmentType]
    return temp_img
