import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import numpy as np
import cv2

BLINK_THRESH = 0.35   # blendshape score below this = eye closing
FRAME_CHECK = 20      # consecutive frames before drowsy alert

class DrowsinessDetector:
    def __init__(self, task_path='face_landmarker_v2_with_blendshapes.task'):
        options = vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=task_path),
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=False,
            num_faces=1
        )
        self.landmarker = vision.FaceLandmarker.create_from_options(options)
        self.flag = 0
        self.is_drowsy = False
        print("[Drowsiness] MediaPipe blendshape detector ready.")

    def process_frame(self, frame):
        """
        Returns (is_drowsy, left_blink_score, right_blink_score)
        """
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self.landmarker.detect(mp_image)

        if not result.face_blendshapes:
            return False, None, None  # no face detected

        # Extract blink scores from blendshapes
        blendshapes = {b.category_name: b.score for b in result.face_blendshapes[0]}
        left_blink  = blendshapes.get('eyeBlinkLeft', 1.0)
        right_blink = blendshapes.get('eyeBlinkRight', 1.0)
        avg_blink = (left_blink + right_blink) / 2.0

        # Higher score = more closed (opposite of EAR)
        if avg_blink > BLINK_THRESH:
            self.flag += 1
            if self.flag >= FRAME_CHECK:
                self.is_drowsy = True
        else:
            self.flag = 0
            self.is_drowsy = False

        return self.is_drowsy, left_blink, right_blink