import cv2
import insightface
import processors.config as config
from insightface.app.common import Face

FACE_ANALYSER = None
IMAGE = cv2.typing.MatLike


def get_face_analyser():
    global FACE_ANALYSER

    if FACE_ANALYSER is None:
        FACE_ANALYSER = insightface.app.FaceAnalysis(
            name="buffalo_l", providers=config.execution_providers
        )

        FACE_ANALYSER.prepare(ctx_id=0, det_size=(640, 640))

    return FACE_ANALYSER


def get_one_face(img: IMAGE) -> Face:
    face = get_face_analyser().get(img)
    return min(face, key=lambda x: x.bbox[0])
