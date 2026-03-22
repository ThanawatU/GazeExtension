###########################import libary######################################
import pathlib  # ใช้จัดการ path (เปิดรูป test_image/1.jpg)

import cv2  # OpenCV สำหรับอ่านและประมวลผลรูปภาพ
import numpy as np  # เอาไว้คิดเลข
import yaml  # อ่านไฟล์ configuration เพราะ เป็น .yaml

from webeyetrack import WebEyeTrack, WebEyeTrackConfig  # คลาสหลักสำหรับการตรวจจับการมอง
from webeyetrack.data_protocols import (
    TrackingStatus,
)  # Enum สำหรับสถานะการตรวจจับ (SUCCESS, FAILURE)

#################################################################


# Load ไฟล์ configuration
CWD = pathlib.Path(__file__).parent.resolve()
# __file__ คือ path ปัจจุบัน(test.py)
# .parent คือ ถอยไป 1 (../)
# .resolve() แก้ไขพาธให้เป็น absolute path = path เต็ม ตั้งแต่ /Users/jengcharat/

with open(CWD / "config.yml", "r") as f:
    # CWD / "config.yml": รวมพาธให้เป็น /path/to/demo/config.yml
    config = yaml.safe_load(
        f
    )  # yaml.safe_load(): อ่านและแปลง YAML เป็น dictionary Python

# Screen dimensions (from constants.py)
SCREEN_WIDTH_PX = 1920
SCREEN_HEIGHT_PX = 1080
SCREEN_WIDTH_MM = 530
SCREEN_HEIGHT_MM = 300


def test_single_image(image_path):
    """
    Test WebEyeTrack with a single image

    Args:
        image_path (str): Path to the image file

    Returns:
        tuple: (gaze_result, detection, success)
    """
    print(f"\n{'='*50}")
    print(f"Testing image: {image_path}")
    print(f"{'='*50}")

    # Read image
    frame = cv2.imread(
        image_path
    )  # อ่านฟล์รูปภาพ คืนค่า numpy array (height, width, channels)
    if frame is None:  # ถ้า None แปลว่าอ่านไม่สำเร็จ
        print(f"❌ Failed to read image: {image_path}")
        return None, None, False

    print(f"Image size: {frame.shape}")  # frame.shape() แสดงขนาดรูป

    # Initialize WebEyeTrack
    #    สร้าง config object ด้วยขนาดหน้าจอ (พิกเซลและเซนติเมตร)
    #    SCREEN_WIDTH_MM / 10: แปลง mm เป็น cm
    #    verbose=config["verbose"]: เปิด/ปิดการแสดง log ตาม config
    #    WebEyeTrack(config): สร้าง pipeline สำหรับตรวจจับการมอง

    # wet = web eye track
    wet = WebEyeTrack(
        WebEyeTrackConfig(
            screen_px_dimensions=(SCREEN_WIDTH_PX, SCREEN_HEIGHT_PX),
            screen_cm_dimensions=(SCREEN_WIDTH_MM / 10, SCREEN_HEIGHT_MM / 10),
            verbose=config["verbose"],
        )
    )

    # Process frame
    print("Processing image...")
    status, gaze_result, detection = wet.process_frame(frame)
    # process_frame(): รับรูปภาพและคืนค่า:

    # status: สถานะการตรวจจับ (TrackingStatus.SUCCESS, FAILURE, ฯลฯ)
    # gaze_result: ข้อมูลการมอง (norm_pog, gaze_state, durations)
    # detection: ข้อมูลการตรวจจับใบหน้า (face_landmarks)

    ########################## Display results ##########################################
    print("\n=== Test Results ===")
    print(f"Status: {status}")

    success = False

    if gaze_result is not None:
        print(f"\nGaze Result:")
        print(f"  - Gaze State: {gaze_result.gaze_state}")
        print(
            f"  - Normalized POG: ({gaze_result.norm_pog[0]:.4f}, {gaze_result.norm_pog[1]:.4f})"
        )
        print(
            f"  - Eye Patch Shape: {gaze_result.eye_patch.shape if gaze_result.eye_patch is not None else 'None'}"
        )
        print(f"  - Durations: {gaze_result.durations}")
        success = True

    if detection is not None:
        print(f"\nFace Detection:")

        # Extract landmarks (handle nested list structure)
        if hasattr(detection, "face_landmarks") and detection.face_landmarks:
            print(f"  - Number of face landmarks: {len(detection.face_landmarks)}")

            # Get actual landmarks (may be nested in first element)
            if len(detection.face_landmarks) > 0:
                first_element = detection.face_landmarks[0]
                if isinstance(first_element, list):
                    landmarks = first_element
                    print(f"  - Actual landmarks count: {len(landmarks)}")
                else:
                    landmarks = detection.face_landmarks
                    print(f"  - Landmarks count: {len(landmarks)}")

                # Show important facial landmarks (corrected MediaPipe indices)
                important_indices = {
                    # nose
                    "nose_tip": 4,
                    "nose_bridge": 6,
                    # left eye region
                    "left_eye_left_corner": 33,  # left corner of left eye
                    "left_eye_right_corner": 133,  # right corner of left eye
                    "left_eye_center": 468,  # center of left eye (from blendshapes)
                    # right eye region
                    "right_eye_left_corner": 362,  # left corner of right eye
                    "right_eye_right_corner": 263,  # right corner of right eye
                    "right_eye_center": 473,  # center of right eye (from blendshapes)
                    # eyebrows
                    "left_eyebrow_inner": 46,
                    "left_eyebrow_outer": 70,
                    "right_eyebrow_inner": 276,
                    "right_eyebrow_outer": 300,
                    # mouth
                    "mouth_left": 61,
                    "mouth_right": 291,
                    "mouth_top": 13,
                    "mouth_bottom": 14,
                    # chin and cheeks
                    "chin": 152,
                    "left_cheek": 117,
                    "right_cheek": 347,
                    # jawline
                    "jaw": 199,
                }

                print("\n  - Important facial landmarks:")
                for name, idx in important_indices.items():
                    if idx < len(landmarks):
                        lm = landmarks[idx]
                        if hasattr(lm, "x"):
                            print(
                                f"    {name}: x={lm.x:.3f}, y={lm.y:.3f}, z={lm.z:.3f}"
                            )
                        elif isinstance(lm, (list, np.ndarray)) and len(lm) >= 3:
                            print(
                                f"    {name}: x={lm[0]:.3f}, y={lm[1]:.3f}, z={lm[2]:.3f}"
                            )

                # Show first 5 landmarks
                print("\n  - First 5 face landmarks:")
                for i in range(min(5, len(landmarks))):
                    lm = landmarks[i]
                    if hasattr(lm, "x"):
                        print(
                            f"    Landmark {i}: x={lm.x:.3f}, y={lm.y:.3f}, z={lm.z:.3f}"
                        )
                    elif isinstance(lm, (list, np.ndarray)) and len(lm) >= 3:
                        print(
                            f"    Landmark {i}: x={lm[0]:.3f}, y={lm[1]:.3f}, z={lm[2]:.3f}"
                        )
        else:
            print("  - No face landmarks found")

    print(f"\n{'='*50}")
    if success:
        print(f" Test completed successfully!")
    else:
        print(f" Test failed!")
    print(f"{'='*50}")

    return gaze_result, detection, success


def main():
    """Main function to run tests"""

    # หารูปภาพทั้งหมดในโฟลเดอร์ test_image
    test_image_folder = CWD / "test_image"

    if not test_image_folder.exists():
        print(f" Folder not found: {test_image_folder}")
        print("Please create a 'test_image' folder and add images to test")
        return

    # ค้นหาไฟล์รูปภาพทั้งหมด
    import glob

    image_files = []
    image_extensions = ["*.jpg", "*.jpeg", "*.png", "*.bmp"]

    for ext in image_extensions:
        image_files.extend(glob.glob(str(test_image_folder / ext)))

    if not image_files:
        print(f" No image files found in: {test_image_folder}")
        print("Please add .jpg, .jpeg, .png, or .bmp files to test")
        return

    print(f"Found {len(image_files)} image(s) to test")

    # ทดสอบแต่ละรูปโดยเรียก test_single_image ซ้ำๆ
    results = []
    successful_tests = 0

    for img_path in sorted(image_files):
        gaze, detection, success = test_single_image(str(img_path))
        results.append({"path": img_path, "success": success, "gaze": gaze})
        if success:
            successful_tests += 1

    # สรุปผล
    print("\n" + "=" * 60)
    print("FINAL SUMMARY")
    print("=" * 60)
    print(f"Total images tested: {len(image_files)}")
    print(f"Successful: {successful_tests}")
    print(f"Failed: {len(image_files) - successful_tests}")

    # แสดงรายการรูปที่ล้มเหลว
    failed_tests = [r for r in results if not r["success"]]
    if failed_tests:
        print("\nFailed images:")
        for r in failed_tests:
            print(f"  - {r['path'].name}")

    # แสดงค่าเฉลี่ย gaze position ถ้ามีข้อมูลสำเร็จ
    successful_gaze = [
        r["gaze"] for r in results if r["success"] and r["gaze"] is not None
    ]
    if successful_gaze:
        pog_x = [g.norm_pog[0] for g in successful_gaze]
        pog_y = [g.norm_pog[1] for g in successful_gaze]

        print(
            f"\nAverage Normalized POG (from {len(successful_gaze)} successful tests):"
        )
        print(f"  X: {np.mean(pog_x):.4f} (±{np.std(pog_x):.4f})")
        print(f"  Y: {np.mean(pog_y):.4f} (±{np.std(pog_y):.4f})")

    print("=" * 60)


if __name__ == "__main__":
    main()
