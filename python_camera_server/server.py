import cv2, cvzone, numpy as np
from cvzone.FaceMeshModule import FaceMeshDetector
import asyncio
import websockets
import json

cap = cv2.VideoCapture(0)
detector = FaceMeshDetector(maxFaces=1)

async def send_distance(websocket):
    while True:
        success, img = cap.read()
        if not success or img is None:
            print("⚠️ Failed to grab frame")
            continue
        img, faces = detector.findFaceMesh(img, draw=False)
        if faces:
            face = faces[0]
            w, _ = detector.findDistance(face[145], face[374])
            W = 6.3
            f = 840
            d = (W * f) / w
            await websocket.send(json.dumps({"distance": d}))
        await asyncio.sleep(0.03)

async def main():
    async with websockets.serve(send_distance, "localhost", 8765):
        print("✅ WebSocket server running on ws://localhost:8765")
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
