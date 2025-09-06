import os
import cv2
from typing import Any
from processors.utils import get_one_face
from processors.face_swapper import process_img

if __name__ == "__main__":
    media_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media"
    )

    source_img: Any = cv2.imread(os.path.join(media_dir, "image-one.jpeg"))
    target_img: Any = cv2.imread(os.path.join(media_dir, "image-two.jpeg"))

    source_face = get_one_face(source_img)
    result = process_img(source_face, target_img)
    cv2.imwrite(os.path.join(media_dir, "image-result.jpeg"), result)
