import os
import cv2
import insightface
from typing import List
from insightface.app.common import Face


EXECUTION_PROVIDERS: List[str] = ["CPUExecutionProvider"]
MODELS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "models",
)

FACE_ANALYSER = None
IMAGE = cv2.typing.MatLike


def get_face_analyser():
    global FACE_ANALYSER

    if FACE_ANALYSER is None:
        FACE_ANALYSER = insightface.app.FaceAnalysis(
            name="buffalo_l", providers=EXECUTION_PROVIDERS
        )

        FACE_ANALYSER.prepare(ctx_id=0, det_size=(640, 640))

    return FACE_ANALYSER


def get_one_face(img: IMAGE) -> Face:
    face = get_face_analyser().get(img)
    return min(face, key=lambda x: x.bbox[0])
