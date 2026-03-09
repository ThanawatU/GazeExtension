import { WebCamClient, WebEyeTrackProxy } from '.libs/webeyetrack';

let proxy = null;
let stream = null;
let settings = {
    enabled : true,
    dwellTime : 800,
    zoomScale : 1.8,
    doZoom : true,
    doGlow : true,
    doTooltip : true,
    doOpenOnDwell : false,
    glowColor : '#a855f7',
    showGazeDot : true,
    showCamera : true
}
let tracker = null;

chrome.runtime.onMessage.addListener(async (msg) => {
    switch (msg.type) {
        case 'INIT_TRACKER':
          initTracker();
          break;
    
        case 'STOP_TRACKER':
          stopTracker();
          break;
    
        case 'SETTINGS_UPDATE':
            settings = { ...settings, ...msg.settings };
            if (!settings.enabled && proxy) {
                stopTracker();
            }
            if (settings.enabled && !proxy) {
                initTracker();
            }
            break;
    }
});

async function initTracker() {
    if (proxy) return; // Already running
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video : {
                width : { ideal : 640},
                height : { ideal : 480},
                facingMode : 'user'
            },
            audio : false
        }); 

        const video = document.getElementById('video');
        video.srcObject = stream;
        await video.play();

        const webcamClient = new WebCamClient(video);
        tracker = new WebEyeTrackProxy(webcamClient);
        
        tracker.onGazeResults = (gazeResult) => {
            chrome.runtime.sendMessage({
                type : 'GAZE_RESULT',
                data : {
                    normPog : gazeResult.normPos,
                    gazeState : gazeResult.state,
                    headVector : gazeResult.headVector,
                    timestamp : gazeResult.timestamp,
                    settings,
                }
            });
        };

        console.log("WebEyeTrack initialized.");
    }
    catch (err) {
        console.error('[GazeLink Offscreen] Camera/tracker error:', err);
        chrome.runtime.sendMessage({
                type : 'CAMERA_ERROR',
                error : err.message || String(err)
        });
    }

}

function stopTracker() {
    proxy = null;
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
    const video = document.getElementById('video');
    if (video) {
        video.pause();
        video.srcObject = null;
    }
    console.log("WebEyeTrack stopped.");
}