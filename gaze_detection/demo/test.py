import pathlib

import cv2
import numpy as np
import yaml

from webeyetrack import WebEyeTrack, WebEyeTrackConfig
from webeyetrack.data_protocols import TrackingStatus

# Load configuration
CWD = pathlib.Path(__file__).parent.resolve()
with open(CWD / "config.yml", "r") as f:
    config = yaml.safe_load(f)

# Screen dimensions (from constants.py)
SCREEN_WIDTH_PX = 1920
SCREEN_HEIGHT_PX = 1080
SCREEN_WIDTH_MM = 530
SCREEN_HEIGHT_MM = 300


def test_single_image(image_path, save_output=True):
    """
    Test WebEyeTrack with a single image

    Args:
        image_path (str): Path to the image file
        save_output (bool): Whether to save the output image with landmarks

    Returns:
        tuple: (gaze_result, detection)
    """
    print(f"Testing image: {image_path}")

    # Read image
    frame = cv2.imread(image_path)
    if frame is None:
        print(f"Failed to read image: {image_path}")
        return None, None

    print(f"Image size: {frame.shape}")

    # Initialize WebEyeTrack
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

    # Display results
    print("\n=== Test Results ===")
    print(f"Status: {status}")

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

                # Show important facial landmarks
                important_indices = {
                    "nose_tip": 4,
                    "left_eye_center": 33,
                    "right_eye_center": 263,
                    "left_eye_outer": 33,
                    "right_eye_outer": 263,
                    "mouth_left": 61,
                    "mouth_right": 291,
                    "chin": 152,
                    "left_eyebrow": 70,
                    "right_eyebrow": 300,
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

    # Save output image with landmarks
    if save_output and detection is not None and status == TrackingStatus.SUCCESS:
        try:
            from webeyetrack import vis

            output_frame = vis.draw_landmarks_on_image(frame, detection)

            # Save output
            import os

            base, ext = os.path.splitext(image_path)
            output_path = f"{base}_output{ext}"
            cv2.imwrite(output_path, output_frame)
            print(f"\nSaved output image with landmarks: {output_path}")
        except Exception as e:
            print(f"\nFailed to save output image: {e}")

    return gaze_result, detection


def test_multiple_images(image_folder):
    """
    Test WebEyeTrack with multiple images in a folder

    Args:
        image_folder (str): Path to folder containing images

    Returns:
        list: Results for each image
    """
    import glob
    import os

    # Find all image files
    image_extensions = ["*.jpg", "*.jpeg", "*.png", "*.bmp"]
    image_files = []

    for ext in image_extensions:
        image_files.extend(glob.glob(os.path.join(image_folder, ext)))

    if not image_files:
        print(f"No image files found in: {image_folder}")
        return []

    print(f"Found {len(image_files)} images")

    # Initialize WebEyeTrack
    print("\nInitializing WebEyeTrack...")
    wet = WebEyeTrack(
        WebEyeTrackConfig(
            screen_px_dimensions=(SCREEN_WIDTH_PX, SCREEN_HEIGHT_PX),
            screen_cm_dimensions=(SCREEN_WIDTH_MM / 10, SCREEN_HEIGHT_MM / 10),
            verbose=config["verbose"],
        )
    )

    # Test each image
    results = []
    successful_gaze = []

    for img_path in sorted(image_files):
        print(f"\nTesting: {os.path.basename(img_path)}")

        frame = cv2.imread(img_path)
        if frame is None:
            print(f"  ❌ Failed to read image")
            results.append(
                {"path": img_path, "success": False, "status": None, "gaze": None}
            )
            continue

        status, gaze_result, detection = wet.process_frame(frame)
        success = status == TrackingStatus.SUCCESS and gaze_result is not None

        if success:
            print(f"  ✅ Status: {status}")
            print(f"     Gaze State: {gaze_result.gaze_state}")
            print(
                f"     Normalized POG: ({gaze_result.norm_pog[0]:.4f}, {gaze_result.norm_pog[1]:.4f})"
            )
            successful_gaze.append(gaze_result)
        else:
            print(f"  ❌ Status: {status}")

        results.append(
            {
                "path": img_path,
                "success": success,
                "status": status,
                "gaze": gaze_result,
            }
        )

    # Summary
    print("\n" + "=" * 50)
    print("Test Summary:")
    print("=" * 50)

    successful = [r for r in results if r["success"]]
    failed = [r for r in results if not r["success"]]

    print(f"Successful: {len(successful)} images")
    print(f"Failed: {len(failed)} images")

    if failed:
        print("\nFailed images:")
        for r in failed:
            print(f"  - {os.path.basename(r['path'])}: {r['status']}")

    # Show average gaze position if there are successful results
    if successful_gaze:
        pog_x = [g.norm_pog[0] for g in successful_gaze]
        pog_y = [g.norm_pog[1] for g in successful_gaze]

        print(f"\nAverage Normalized POG:")
        print(f"  X: {np.mean(pog_x):.4f} (±{np.std(pog_x):.4f})")
        print(f"  Y: {np.mean(pog_y):.4f} (±{np.std(pog_y):.4f})")

    return results


def main():
    """Main function to run tests"""

    # Test single image
    print("=== Test Single Image ===")
    test_image_path = CWD / "test_image" / "1.jpg"

    if test_image_path.exists():
        gaze, detection = test_single_image(str(test_image_path))
        if gaze is not None:
            print("\n✅ Test successful!")
        else:
            print("\n❌ Test failed")
    else:
        print(f"File not found: {test_image_path}")
        print("Please make sure the image file exists in test_image/ folder")

    # Optional: Test multiple images if there are more
    print("\n\n=== Test Multiple Images (if available) ===")
    test_image_folder = CWD / "test_image"
    if test_image_folder.exists():
        import glob

        image_files = glob.glob(str(test_image_folder / "*.jpg")) + glob.glob(
            str(test_image_folder / "*.png")
        )

        if len(image_files) > 1:
            test_multiple_images(str(test_image_folder))
        else:
            print("Only one image found, skipping multiple image test")
    else:
        print(f"Folder not found: {test_image_folder}")


if __name__ == "__main__":
    main()
