let gazeEnabled = false;
let currentElement = null;
let currentDistance = 50;
const BASE_FONT_SIZE = 16;
let fontScaled = false;
let alertShown = false;

// onnx initial functions
async function init_onnx(){
  try{
    const ortReady = new Promise((resolve, reject)=>{
      const ortScript = document.createElement("script");
      ortScript.src = chrome.runtime.getURL('node_modules/onnxruntime-web/dist/ort.min.js');
      // Load onnxjs script
      ortScript.onload = () => {
        setTimeout(() => {
          if (typeof window.ort !== 'undefined'){
            ort = window.ort
            console.log("ONNX Runtime initialized");
            resolve();
          } else {
            reject(new Error("ONNX Runtime failed to initialize"));
          }
        }, 100); // wait for 100 ticks
      }
      ortScript.onerror = () => reject(new Error("Failed to load ONNX Runtime script"));
      document.head.appendChild(ortScript);
    })
    await ortReady;
    return true;

  } catch(error){
    console.error("Error initializing ONNX Runtime:", error);
    return false;
  }
}


const options = {
    executionProviders: ['wasm', 'wasm-simd', 'wasm-simd-threaded'],
    graphOptimizationLevel: 'all'
};
//load the onnx inference model
async function loadSession(){
    try {
        if (typeof ort === 'undefined') {
            throw new Error('ONNX Runtime not initialized');
        }
        const modelPath = chrome.runtime.getURL('model_merged.onnx');
        console.log('Loading model from:', modelPath);
        const session = await ort.InferenceSession.create(modelPath, options);
        console.log('model loaded successfully');
        return session;
    } catch (error) {
        console.error('Error loading the model:', error);
        throw error;
    }
}

// initialize onnx and load model

async function init() {
  try {
    console.log("Initializing ONNX Runtime...");
    const init_onnx_success = await init_onnx();
    if (!init_onnx_success) {
      throw new Error("ONNX Runtime initialization failed");
    }
    const session = await loadSession();
    console.log("ONNX model session initialized");
    return session;

  } catch (error) {
    console.error("Initialization error:", error);
    throw error;
  }
}

// --- smoothing เพื่อลด jitter ---
let lastX = null, lastY = null;
function smoothGaze(x, y, alpha = 0.2) {
  if (lastX === null || lastY === null) {
    lastX = x; lastY = y;
    return { x, y };
  }
  lastX = lastX + alpha * (x - lastX);
  lastY = lastY + alpha * (y - lastY);
  return { x: lastX, y: lastY };
}

// --- วงกลม gaze แสดงตำแหน่ง ---
const gazeCircle = document.createElement("div");
gazeCircle.style.position = "fixed";
gazeCircle.style.width = "120px";
gazeCircle.style.height = "120px";
gazeCircle.style.borderRadius = "50%";
gazeCircle.style.background = "rgba(0,150,255,0.3)";
gazeCircle.style.pointerEvents = "none";
gazeCircle.style.zIndex = 9999;
gazeCircle.style.transition = "left 0.05s ease, top 0.05s ease";
document.body.appendChild(gazeCircle);

// --- ฟัง message จาก popup ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ENABLE_GAZE") {
    init().then(() => {
      gazeEnabled = true;
      startWebSocketConnection();
      startGazeTracking();
      startAgeEstimation();
    }).catch((error) => {
      console.error("Failed to enable gaze tracking:", error);
    });
    // gazeEnabled = true;
    // startWebSocketConnection();
    // startGazeTracking();
    // startAgeEstimation();
  }
  if (msg.type === "DISABLE_GAZE") {
    gazeEnabled = false;
    if (currentElement) resetElement(currentElement);
    resetAllScaling(); // รีเซ็ตการขยายทั้งหมดเมื่อปิดการทำงาน
  }
  if (msg.type === "CALIBRATE") {
    setupCalibration();
  }
});

// --- ตรวจ mirror ของ video ---
function getCorrectedX(x) {
  const video = document.querySelector('video');
  if (!video) return x;
  const isMirrored = video.style.transform.includes('scaleX(-1)');
  return isMirrored ? window.innerWidth - x : x;
}

// --- เริ่ม gaze tracking ---
function startGazeTracking() {
  if (window.webgazerInitialized) return;
  window.webgazerInitialized = true;

  webgazer.showVideo(true);
  webgazer.showFaceOverlay(true);
  webgazer.showFaceFeedbackBox(false);
  webgazer.showPredictionPoints(false);

  webgazer.setGazeListener((data) => {
    if (!gazeEnabled || !data) return;
    let { x, y } = smoothGaze(data.x, data.y);
    x = getCorrectedX(x);

    gazeCircle.style.left = `${x - 60}px`;
    gazeCircle.style.top = `${y - 60}px`;

    document.querySelectorAll("img, p, span, h1, h2, h3, h4, h5, h6").forEach(el => {
      enlargeElementByGaze(el, x, y);
    });
  }).begin();
}

// --- ขยาย element ตาม gaze ---
function enlargeElementByGaze(el, gazeX, gazeY) {
  const rect = el.getBoundingClientRect();
  if (
    gazeX >= rect.left && gazeX <= rect.right &&
    gazeY >= rect.top && gazeY <= rect.bottom
  ) {
    if (currentElement && currentElement !== el) resetElement(currentElement);

    const offsetX = ((gazeX - rect.left) / rect.width) * 100;
    const offsetY = ((gazeY - rect.top) / rect.height) * 100;

    el.style.transition = `transform 0.2s ease`;
    el.style.transformOrigin = `${offsetX}% ${offsetY}%`;
    el.style.transform = `scale(1.2)`;
    el.style.zIndex = 999;

    currentElement = el;
  } else if (currentElement === el) {
    resetElement(el);
  }
}

function resetElement(el) {
  el.style.transform = 'scale(1)';
  el.style.transformOrigin = 'center center';
  el.style.zIndex = '';
  el.style.transition = `transform 0.2s ease`;
  if (currentElement === el) currentElement = null;
}

// --- WebSocket จาก Python ---
function startWebSocketConnection() {
  const ws = new WebSocket("ws://localhost:8765");
  ws.onopen = () => console.log("🟢 Connected to Python FaceMesh server");

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    currentDistance = data.distance;
    console.log(`📏 Distance: ${currentDistance.toFixed(1)} cm`);

    handleDistanceEffects(currentDistance);
    updateScreenSizeOverlay();
  };

  ws.onclose = () => {
    console.warn("🔴 Disconnected from Python server. Retrying...");
    setTimeout(startWebSocketConnection, 2000);
  };
}

// --- ฟังก์ชันรีเซ็ตการขยายทั้งหมด ---
function resetAllScaling() {
  const elementsToReset = document.querySelectorAll('div, h1, h2, h3, h4, h5, h6, a');
  elementsToReset.forEach(element => {
    element.style.fontSize = "";
    element.style.transform = "";
    element.style.transition = "";
  });
  fontScaled = false;
  console.log("🔠 Reset all scaling to normal");
}

// --- ปรับ font-size ตามระยะ (แก้ไขแล้ว) ---
// --- ปรับ font-size ตามระยะ (แบบกำหนดขนาดตายตัว) ---
function handleDistanceEffects(distance) {
  const elementsToScale = document.querySelectorAll('div, h1, h2, h3, h4, h5, h6, a, p, span, li, button');
  
  if (distance > 70) {
    if (!fontScaled) {
      // กำหนดขนาดฟอนต์ตายตัวเมื่อระยะเกิน 70cm
      elementsToScale.forEach(element => {
        element.style.transition = "font-size 0.5s ease";
        element.style.fontSize = "24px"; // ขนาดฟอนต์ใหญ่
      });
      console.log("🔠 Font size increased to 24px (distance > 70 cm)");
      fontScaled = true;
    }
  } else {
    // รีเซ็ตเป็นค่าเดิมเมื่อระยะน้อยกว่าหรือเท่ากับ 70cm
    if (fontScaled) {
      elementsToScale.forEach(element => {
        element.style.transition = "font-size 0.5s ease";
        element.style.fontSize = ""; // คืนค่าดั้งเดิม
      });
      console.log("🔠 Font size reset to normal");
      fontScaled = false;
    }
  }

  // การแจ้งเตือน
  if (distance >= 100 && !alertShown) {
    alert("😅 I can't see your face!");
    alertShown = true;
  } else if (distance < 100) {
    alertShown = false;
  }
}

// --- Calibration ---
function setupCalibration() {
  webgazer.showVideo(true);
  webgazer.showFaceOverlay(true);
  webgazer.showPredictionPoints(false);

  const grid = 3;
  const points = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      points.push([i / (grid - 1), j / (grid - 1)]);
    }
  }

  let index = 0, sampleCount = 0, maxSamples = 5;

  const calibrationDot = document.createElement("div");
  calibrationDot.style.position = "fixed";
  calibrationDot.style.width = "40px";
  calibrationDot.style.height = "40px";
  calibrationDot.style.borderRadius = "50%";
  calibrationDot.style.background = "red";
  calibrationDot.style.zIndex = 9999;
  calibrationDot.style.cursor = "pointer";
  calibrationDot.style.transition = "all 0.2s ease";
  document.body.appendChild(calibrationDot);

  function showNextDot() {
    if (index >= points.length) {
      calibrationDot.remove();
      alert("✅ Calibration เสร็จสมบูรณ์");
      return;
    }
    const [px, py] = points[index];
    calibrationDot.style.left = (px * window.innerWidth - 20) + "px";
    calibrationDot.style.top = (py * window.innerHeight - 20) + "px";
    sampleCount = 0;
  }

  calibrationDot.addEventListener("click", () => {
    const [px, py] = points[index];
    webgazer.recordScreenPosition(px * window.innerWidth, py * window.innerHeight, "click");
    sampleCount++;
    if (sampleCount < maxSamples) {
      calibrationDot.style.background = sampleCount % 2 === 0 ? "red" : "orange";
    } else {
      index++;
      showNextDot();
    }
  });

  showNextDot();
}

// --- Overlay ---
const screenSizeOverlay = document.createElement("div");
screenSizeOverlay.style.position = "fixed";
screenSizeOverlay.style.right = "10px";
screenSizeOverlay.style.top = "10px";
screenSizeOverlay.style.padding = "5px 10px";
screenSizeOverlay.style.background = "rgba(0,0,0,0.6)";
screenSizeOverlay.style.color = "white";
screenSizeOverlay.style.fontSize = "14px";
screenSizeOverlay.style.fontFamily = "monospace";
screenSizeOverlay.style.zIndex = 10000;
screenSizeOverlay.style.borderRadius = "5px";
screenSizeOverlay.style.pointerEvents = "none";
document.body.appendChild(screenSizeOverlay);

const ageOverlay = document.createElement("div");
ageOverlay.style.position = "fixed";
ageOverlay.style.right = "10px";
ageOverlay.style.top = "35px";
ageOverlay.style.padding = "5px 10px";
ageOverlay.style.background = "rgba(0,0,0,0.6)";
ageOverlay.style.color = "white";
ageOverlay.style.fontSize = "14px";
ageOverlay.style.fontFamily = "monospace";
ageOverlay.style.zIndex = 10000;
ageOverlay.style.borderRadius = "5px";
ageOverlay.style.pointerEvents = "none";
document.body.appendChild(ageOverlay);

function updateScreenSizeOverlay() {
  screenSizeOverlay.textContent =
    `${window.innerWidth} x ${window.innerHeight} | ${currentDistance.toFixed(1)} cm`;
}

updateScreenSizeOverlay();
window.addEventListener("resize", updateScreenSizeOverlay);

// --- Age/Gender estimation ---
async function startAgeEstimation() {
  const video = document.querySelector('video');
  if (!video) return;

  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.ageGenderNet.loadFromUri(MODEL_URL);

  async function detect() {
    const detections = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
      .withAgeAndGender();

    if (detections) {
      const age = Math.round(detections.age);
      const gender = detections.gender;
      ageOverlay.textContent = `ประมาณอายุ: ${age} ปี | เพศ: ${gender}`;
    } else {
      ageOverlay.textContent = "ไม่พบใบหน้า";
    }
    requestAnimationFrame(detect);
  }

  detect();
}
