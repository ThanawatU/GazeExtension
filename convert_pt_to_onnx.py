from ultralytics import YOLO

model = YOLO("models/yolov12n-face.pt")
model.export(format="onnx")
