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

# Expected results for each test image
EXPECTED_RESULTS = {
    "1.jpg": {
        "gaze_state": "open",
        "norm_pog_x": 0.05,
        "norm_pog_y": 0.05,
        "tolerance": 0.05,
        "description": "Looking straight ahead",
    },
    "2.jpg": {
        "gaze_state": "open",
        "norm_pog_x": 0.10,
        "norm_pog_y": -0.15,
        "tolerance": 0.05,
        "description": "Looking slightly right and down",
    },
    "3.jpg": {
        "gaze_state": "open",
        "norm_pog_x": 0.00,
        "norm_pog_y": 0.00,
        "tolerance": 0.05,
        "description": "Looking straight ahead",
    },
    # Add more expected results as needed
}


def compare_with_expected(result_name, actual_value, expected_value, tolerance):
    """
    Compare actual value with expected value within tolerance

    Args:
        result_name (str): Name of the result being compared
        actual_value (float): Actual value from test
        expected_value (float): Expected value
        tolerance (float): Allowed difference

    Returns:
        tuple: (is_match, difference, status_icon)
    """
    difference = abs(actual_value - expected_value)
    is_match = difference <= tolerance
    status_icon = "✅" if is_match else "❌"
    return is_match, difference, status_icon


def test_single_image(image_path):
    """
    Test WebEyeTrack with a single image

    Args:
        image_path (str): Path to the image file

    Returns:
        tuple: (gaze_result, detection, success, test_passed)
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
        return None, None, False, False

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
    test_passed = False

    # Get expected results for this image
    filename = pathlib.Path(image_path).name
    expected = EXPECTED_RESULTS.get(filename)

    if expected:
        print(f"\n--- Expected Results ---")
        print(f"  Description: {expected.get('description', 'No description')}")
        print(f"  Gaze State: {expected.get('gaze_state', 'N/A')}")
        print(
            f"  Expected POG: ({expected.get('norm_pog_x', 0):.4f}, {expected.get('norm_pog_y', 0):.4f})"
        )
        print(f"  Tolerance: ±{expected.get('tolerance', 0.05)}")
    else:
        print(f"\n--- No expected results defined for {filename} ---")

    if gaze_result is not None:
        print(f"\n--- Actual Results ---")
        print(f"Gaze Result:")
        print(f"  - Gaze State: {gaze_result.gaze_state}")
        print(
            f"  - Normalized POG: ({gaze_result.norm_pog[0]:.4f}, {gaze_result.norm_pog[1]:.4f})"
        )
        print(
            f"  - Eye Patch Shape: {gaze_result.eye_patch.shape if gaze_result.eye_patch is not None else 'None'}"
        )
        print(f"  - Durations: {gaze_result.durations}")
        success = True

        # Compare with expected results if available
        if expected:
            print(f"\n--- Comparison with Expected ---")

            # Compare gaze state
            expected_state = expected.get("gaze_state")
            if expected_state:
                state_match = gaze_result.gaze_state == expected_state
                state_icon = "✅" if state_match else "❌"
                print(
                    f"  Gaze State: {state_icon} Actual='{gaze_result.gaze_state}', Expected='{expected_state}'"
                )
                test_passed = state_match

            # Compare POG X
            tolerance = expected.get("tolerance", 0.05)
            expected_x = expected.get("norm_pog_x")
            if expected_x is not None:
                x_match, x_diff, x_icon = compare_with_expected(
                    "POG X", gaze_result.norm_pog[0], expected_x, tolerance
                )
                print(
                    f"  POG X: {x_icon} Actual={gaze_result.norm_pog[0]:.4f}, Expected={expected_x:.4f}, Diff={x_diff:.4f} (tolerance={tolerance})"
                )
                if not x_match:
                    test_passed = False
                elif test_passed is False:
                    test_passed = x_match
                else:
                    test_passed = True

            # Compare POG Y
            expected_y = expected.get("norm_pog_y")
            if expected_y is not None:
                y_match, y_diff, y_icon = compare_with_expected(
                    "POG Y", gaze_result.norm_pog[1], expected_y, tolerance
                )
                print(
                    f"  POG Y: {y_icon} Actual={gaze_result.norm_pog[1]:.4f}, Expected={expected_y:.4f}, Diff={y_diff:.4f} (tolerance={tolerance})"
                )
                if not y_match:
                    test_passed = False
                elif test_passed is False:
                    test_passed = y_match
                else:
                    test_passed = True

            # Overall test result
            print(f"\n  Overall: {'✅ PASSED' if test_passed else '❌ FAILED'}")
        else:
            test_passed = True  # No expected results, consider passed

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
        if expected:
            if test_passed:
                print(f"✅ Test completed successfully! (Matches expected)")
            else:
                print(f"⚠️ Test completed but does NOT match expected results!")
        else:
            print(f"✅ Test completed successfully! (No expected results defined)")
    else:
        print(f"❌ Test failed!")
    print(f"{'='*50}")

    return gaze_result, detection, success, test_passed


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

    # Display expected results summary
    print("\n--- Expected Results Summary ---")
    for img_path in sorted(image_files):
        # Convert string to Path object if needed
        if isinstance(img_path, str):
            img_path = pathlib.Path(img_path)
        filename = img_path.name
        if filename in EXPECTED_RESULTS:
            exp = EXPECTED_RESULTS[filename]
            print(f"  {filename}: {exp.get('description', 'No description')}")
            print(
                f"    Expected: ({exp.get('norm_pog_x', 0):.4f}, {exp.get('norm_pog_y', 0):.4f}) ±{exp.get('tolerance', 0.05)}"
            )
        else:
            print(f"  {filename}: No expected results defined")
    print("=" * 60)

    # ทดสอบแต่ละรูปโดยเรียก test_single_image ซ้ำๆ
    results = []
    successful_tests = 0
    passed_tests = 0

    for img_path in sorted(image_files):
        gaze, detection, success, test_passed = test_single_image(str(img_path))
        results.append(
            {
                "path": img_path,
                "success": success,
                "gaze": gaze,
                "test_passed": test_passed,
            }
        )
        if success:
            successful_tests += 1
        if test_passed:
            passed_tests += 1

    # สรุปผล
    print("\n" + "=" * 60)
    print("FINAL SUMMARY")
    print("=" * 60)
    print(f"Total images tested: {len(image_files)}")
    print(f"Successfully processed: {successful_tests}")
    print(f"Failed to process: {len(image_files) - successful_tests}")
    print(f"Tests passed (match expected): {passed_tests}")
    print(f"Tests failed (mismatch expected): {successful_tests - passed_tests}")

    # แสดงรายการรูปที่ล้มเหลว
    failed_tests = [r for r in results if not r["success"]]
    if failed_tests:
        print("\nFailed to process images:")
        for r in failed_tests:
            # Convert to Path object if string
            path = (
                r["path"]
                if isinstance(r["path"], pathlib.Path)
                else pathlib.Path(r["path"])
            )
            print(f"  - {path.name}")

    # แสดงรายการรูปที่ทดสอบไม่ผ่าน (ไม่ตรงกับ expected)
    mismatch_tests = [r for r in results if r["success"] and not r["test_passed"]]
    if mismatch_tests:
        print("\nTests that passed processing but didn't match expected results:")
        for r in mismatch_tests:
            path = (
                r["path"]
                if isinstance(r["path"], pathlib.Path)
                else pathlib.Path(r["path"])
            )
            print(f"  - {path.name}")

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
