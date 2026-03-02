import cv2
import dlib
import numpy as np
from ultralytics import YOLO
import os 
import torch 
from gaze_pred_model import GazeNN

# ---------------- CONFIG ----------------
MODEL_PATH = "models/yolov12n-face.pt"
CAMERA_ID = 0
EYE_W, EYE_H = 60, 36
LANDMARK_EVERY = 3   # run landmarks every N frames
frame_id = 0


# ---------------- LOAD MODEL ----------------
model = YOLO(MODEL_PATH)
cap = cv2.VideoCapture(CAMERA_ID)

# gaze model 
gaze_model = GazeNN()
state_dict = torch.load("models/best_gaze_model.pth", map_location="cpu")
gaze_model.load_state_dict(state_dict)

model_face_landmark = "models/shape_predictor_68_face_landmarks.dat"
assert os.path.exists(model_face_landmark)
detector = dlib.get_frontal_face_detector()
predictor = dlib.shape_predictor(model_face_landmark)


# ---------------- UTILS ----------------
def crop_eye(img, center, w=60, h=36):
    cx, cy = int(center[0]), int(center[1])

    x1 = max(cx - w // 2, 0)
    y1 = max(cy - h // 2, 0)
    x2 = min(cx + w // 2, img.shape[1])
    y2 = min(cy + h // 2, img.shape[0])

    crop = img[y1:y2, x1:x2]
    return crop

def face_landmark(frame, face_box):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = detector(gray)

    x1, y1, x2, y2 = face_box

    rect = dlib.rectangle(x1, y1, x2, y2)

    # fixed landmarker 
    landmarker = [36, 39, 42, 45, 48, 54]
    landmarks = predictor(gray, rect) if rect else None
    try:
        for i in landmarker:
            x = landmarks.part(i).x
            y = landmarks.part(i).y
            cv2.circle(frame, (x, y), 2, (0, 255, 0), -1)
    except:
        pass

def find_pupil_center(eye_img):
    gray = cv2.cvtColor(eye_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (7, 7), 0)

    _, thresh = cv2.threshold(
        gray, 0, 255,
        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )

    contours, _ = cv2.findContours(
        thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    if not contours:
        return None

    c = max(contours, key=cv2.contourArea)
    M = cv2.moments(c)

    if M["m00"] == 0:
        return None

    cx = int(M["m10"] / M["m00"])
    cy = int(M["m01"] / M["m00"])
    return (cx, cy)

def eye_to_tensor(eye_img):
    """
    eye_img: BGR image (H, W, 3)
    return: torch tensor (1, H, W)
    """
    gray = cv2.cvtColor(eye_img, cv2.COLOR_BGR2GRAY)
    gray = gray.astype(np.float32) / 255.0  # normalize [0,1]

    tensor = torch.from_numpy(gray).unsqueeze(0)  # (1, H, W)
    return tensor

def gaze_to_screen(gaze, frame_w, frame_h, scale=1):
    """
    gaze: tensor or array [gx, gy]
    returns: (x, y) screen coordinate
    """

    gx = float(gaze[0])
    gy = float(gaze[1])

    cx = frame_w // 2
    cy = frame_h // 2

    x = int(cx + gx * frame_w * scale)
    y = int(cy - gy * frame_h * scale)

    return x, y



# ---------------- MAIN LOOP ----------------
while True:
    ret, frame = cap.read()
    if not ret:
        break

    results = model(frame, imgsz=416, conf=0.5, verbose=False)

    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            w, h = x2 - x1, y2 - y1

            # ---- Face box ----
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)

            # ---- Face landmark ----
            if frame_id % LANDMARK_EVERY == 0: # ถึง jeng อันนี้เอาให้มันจับทุก 3 วินาทีลดโหลดเครื่อง
                face_landmark(frame, (x1, y1, x2, y2))


                # ---- Approx eye centers (face-based heuristic) ----
                left_eye_center = (x1 + int(0.3 * w), y1 + int(0.35 * h))
                right_eye_center = (x1 + int(0.7 * w), y1 + int(0.35 * h))

                cv2.circle(frame, left_eye_center, 3, (255, 0, 0), -1)
                cv2.circle(frame, right_eye_center, 3, (255, 0, 0), -1)

                # ---- Crop eyes ----
                left_eye = crop_eye(frame, left_eye_center)
                right_eye = crop_eye(frame, right_eye_center)

                # ===== LEFT EYE =====
                if left_eye.size != 0:
                    left_eye = cv2.resize(left_eye, (EYE_W, EYE_H))
                    pupil = find_pupil_center(left_eye)

                    if pupil:
                        # Draw on small eye window
                        cv2.circle(left_eye, pupil, 3, (0, 0, 255), -1)

                        # Convert to global coordinates
                        gx = left_eye_center[0] - EYE_W // 2 + pupil[0]
                        gy = left_eye_center[1] - EYE_H // 2 + pupil[1]

                        # Draw on big frame
                        cv2.circle(frame, (gx, gy), 4, (0, 0, 255), -1)

                        #print("Left pupil:", (gx, gy))

                    cv2.imshow("Left Eye", left_eye)

                # ===== RIGHT EYE =====
                if right_eye.size != 0:
                    right_eye = cv2.resize(right_eye, (EYE_W, EYE_H))
                    pupil = find_pupil_center(right_eye)

                    if pupil:
                        cv2.circle(right_eye, pupil, 3, (0, 0, 255), -1)

                        gx = right_eye_center[0] - EYE_W // 2 + pupil[0]
                        gy = right_eye_center[1] - EYE_H // 2 + pupil[1]

                        cv2.circle(frame, (gx, gy), 4, (0, 0, 255), -1)

                        #print("Right pupil:", (gx, gy))

                    cv2.imshow("Right Eye", right_eye)

                # ---- Gaze Prediction ----
                # gaze_model.eval()
                # gaze_input = torch.randn(1, 2, EYE_H, EYE_W)  # Dummy input
                # head_pose = torch.randn(1, 3)  # Dummy head pose
                # with torch.inference_mode():
                #     gaze_output = gaze_model(gaze_input, head_pose)
                #     print("Gaze output:", gaze_output)
                # ---- Gaze Prediction (REAL EYES) ----
                # ---- Gaze Prediction & Display ----
                if left_eye.size != 0 and right_eye.size != 0:

                    left_eye_t = eye_to_tensor(left_eye)
                    right_eye_t = eye_to_tensor(right_eye)

                    gaze_input = torch.stack(
                        [left_eye_t, right_eye_t], dim=1
                    ).squeeze(2)

                    head_pose = torch.zeros(1, 3)

                    gaze_model.eval()
                    with torch.inference_mode():
                        gaze_output = gaze_model(gaze_input, head_pose)

                    # assume output shape (1, 2)
                    gaze_xy = gaze_output[0]
                    #print("RAW GAZE:", gaze_xy.cpu().numpy())


                    # convert to screen point
                    h, w = frame.shape[:2]
                    gx, gy = gaze_to_screen(gaze_xy, w, h)
                    print("Screen GAZE:", (gx, gy))
                    # draw gaze dot
                    cv2.circle(frame, (gx, gy), 10, (0, 0, 255), -1)
                    cv2.putText(
                        frame,
                        "GAZE",
                        (gx + 12, gy),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.5,
                        (0, 0, 255),
                        1
                    )



    # ---- Show main webcam ----
    cv2.imshow("Webcam", frame)
    frame_id += 1
    if cv2.waitKey(1) & 0xFF == 27:  # ESC
        break

# ---------------- CLEANUP ----------------
cap.release()
cv2.destroyAllWindows()
