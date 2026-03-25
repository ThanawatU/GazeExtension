// popup.js — GazeLink

const DEFAULTS = {
  enabled: false,
  dwellTime: 800,
  zoomScale: 1.8,
  doZoom: true,
  doGlow: true,
  doTooltip: true,
  doOpenOnDwell: false,
  glowColor: '#a855f7',
  showGazeDot: true,
  nightShift: false,
  nightShiftWarmth: 30,
  nightShiftBrightness: 95,
  nightShiftStart: '20:00',
  nightShiftEnd: '07:00',
  doButtonHoldSpeech: true,
  doKeyboardSpeech: true,
  doHourlyBreak: true,
  enableCustomCursor: true,  // เพิ่ม
  cursorSize: 32,            // เพิ่ม
  cursorColor: '#a855f7',
};

let settings = { ...DEFAULTS };

function saveAndBroadcast() {
  chrome.storage.local.set({ gazeSettings: settings });
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATE', settings });
}

function updateStatusUI(wsConnected = false) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const notice = document.getElementById('notice');
  if (!settings.enabled) {
    dot.className = 'status-dot';
    text.textContent = 'Inactive — toggle to start';
    notice.classList.remove('show');
  } else if (wsConnected) {
    dot.className = 'status-dot active';
    text.textContent = 'Tracking active';
    notice.classList.remove('show');
  } else {
    dot.className = 'status-dot warning';
    text.textContent = 'Connecting to server…';
    notice.classList.add('show');
  }
}

// Listen for WS status updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WS_STATUS') {
    updateStatusUI(msg.status === 'connected');
  }
});

function applySettingsToUI() {
  document.getElementById('enableToggle').checked = settings.enabled;
  document.getElementById('dwellTime').value = settings.dwellTime;
  document.getElementById('dwellTimeVal').textContent = (settings.dwellTime / 1000).toFixed(1) + 's';
  document.getElementById('zoomScale').value = settings.zoomScale;
  document.getElementById('zoomScaleVal').textContent = settings.zoomScale.toFixed(1) + '×';
  document.getElementById('doZoom').checked = settings.doZoom;
  document.getElementById('doGlow').checked = settings.doGlow;
  document.getElementById('doTooltip').checked = settings.doTooltip;
  document.getElementById('doOpenOnDwell').checked = settings.doOpenOnDwell;
  document.getElementById('showGazeDot').checked = settings.showGazeDot;
  document.getElementById('nightShift').checked = settings.nightShift;
  document.getElementById('nightShiftStart').value = settings.nightShiftStart || '20:00';
  document.getElementById('nightShiftEnd').value = settings.nightShiftEnd || '07:00';
  document.getElementById('nightShiftWarmth').value = settings.nightShiftWarmth ?? 30;
  document.getElementById('nightShiftWarmthVal').textContent = (settings.nightShiftWarmth ?? 30) + '%';
  document.getElementById('nightShiftBrightness').value = settings.nightShiftBrightness ?? 95;
  document.getElementById('nightShiftBrightnessVal').textContent = (settings.nightShiftBrightness ?? 95) + '%';

  /////////////////////////////////////////////////
  document.getElementById('enableCustomCursor').checked = settings.enableCustomCursor;
  document.getElementById('cursorSize').value = settings.cursorSize;
  document.getElementById('cursorSizeVal').textContent = settings.cursorSize + 'px';
  document.getElementById('cursorColor').value = settings.cursorColor;
  /////////////////////////////////////////////////

  document.getElementById('doButtonHoldSpeech').checked = settings.doButtonHoldSpeech;
  document.getElementById('doKeyboardSpeech').checked = settings.doKeyboardSpeech;
  document.getElementById('doHourlyBreak').checked = settings.doHourlyBreak;


  document.getElementById('doButtonHoldSpeech').addEventListener('change', (e) => {
    settings.doButtonHoldSpeech = e.target.checked;
    saveAndBroadcast();
  });

  document.getElementById('doKeyboardSpeech').addEventListener('change', (e) => {
    settings.doKeyboardSpeech = e.target.checked;
    saveAndBroadcast();
  });

  document.getElementById('doHourlyBreak').addEventListener('change', (e) => {
    settings.doHourlyBreak = e.target.checked;
    saveAndBroadcast();
  });


  /////////////////////////////////////////////////
  // Cursor size slider
  document.getElementById('cursorSize').addEventListener('input', (e) => {
    settings.cursorSize = parseInt(e.target.value);
    document.getElementById('cursorSizeVal').textContent = settings.cursorSize + 'px';
    saveAndBroadcast();
  });

  // Cursor color picker
  document.getElementById('cursorColor').addEventListener('input', (e) => {
    settings.cursorColor = e.target.value;
    saveAndBroadcast();
  });

  // Enable custom cursor toggle
  document.getElementById('enableCustomCursor').addEventListener('change', (e) => {
    settings.enableCustomCursor = e.target.checked;
    saveAndBroadcast();
  });
  ///////////////////////////////////////////////////


  toggleNightShiftTimes(settings.nightShift);
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.color === settings.glowColor);
  });
  updateStatusUI();
}

// Load settings on open, then immediately check WS status
chrome.storage.local.get(['gazeSettings'], (result) => {
  if (result.gazeSettings) settings = { ...DEFAULTS, ...result.gazeSettings };
  applySettingsToUI();
  // Ask background for current connection status
  if (settings.enabled) {
    chrome.runtime.sendMessage({ type: 'GET_WS_STATUS' }, (resp) => {
      updateStatusUI(resp?.connected ?? false);
    });
  }
});

// Enable toggle
document.getElementById('enableToggle').addEventListener('change', (e) => {
  settings.enabled = e.target.checked;
  updateStatusUI();
  chrome.runtime.sendMessage({ type: settings.enabled ? 'START_TRACKING' : 'STOP_TRACKING' });
  saveAndBroadcast();
});

// Sliders
document.getElementById('dwellTime').addEventListener('input', (e) => {
  settings.dwellTime = parseInt(e.target.value);
  document.getElementById('dwellTimeVal').textContent = (settings.dwellTime / 1000).toFixed(1) + 's';
  saveAndBroadcast();
});
document.getElementById('zoomScale').addEventListener('input', (e) => {
  settings.zoomScale = parseFloat(e.target.value);
  document.getElementById('zoomScaleVal').textContent = settings.zoomScale.toFixed(1) + '×';
  saveAndBroadcast();
});

// Checkboxes
['doZoom', 'doGlow', 'doTooltip', 'doOpenOnDwell', 'showGazeDot'].forEach(id => {
  document.getElementById(id).addEventListener('change', (e) => {
    settings[id] = e.target.checked;
    saveAndBroadcast();
  });
});

// Color buttons
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.glowColor = btn.dataset.color;
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    saveAndBroadcast();
  });
});

// Calibration button
// document.getElementById('calibrateBtn').addEventListener('click', () => {
//   chrome.runtime.sendMessage({ type: 'CALIBRATE' });
//   window.close(); // close popup so user can see the calibration dots
// });

function toggleNightShiftTimes(show) {
  document.getElementById('nightShiftTimes').style.display = show ? 'flex' : 'none';
}
// Night Shift controls
document.getElementById('nightShift').addEventListener('change', (e) => {
  settings.nightShift = e.target.checked;
  toggleNightShiftTimes(settings.nightShift);
  saveAndBroadcast();
  broadcastNightShift();
});

['nightShiftStart', 'nightShiftEnd'].forEach(id => {
  // 'input' fires on every keystroke — 'change' only fires on blur,
  // which can be missed when the popup closes.
  document.getElementById(id).addEventListener('input', (e) => {
    settings[id] = e.target.value;
    saveAndBroadcast();
    broadcastNightShift();
  });
});

// Night Shift sliders
document.getElementById('nightShiftWarmth').addEventListener('input', (e) => {
  settings.nightShiftWarmth = parseInt(e.target.value);
  document.getElementById('nightShiftWarmthVal').textContent = settings.nightShiftWarmth + '%';
  saveAndBroadcast();
  broadcastNightShift();
});
// test commit 

document.getElementById('nightShiftBrightness').addEventListener('input', (e) => {
  settings.nightShiftBrightness = parseInt(e.target.value);
  document.getElementById('nightShiftBrightnessVal').textContent = settings.nightShiftBrightness + '%';
  saveAndBroadcast();
  broadcastNightShift();
});

function broadcastNightShift() {
  chrome.runtime.sendMessage({
    type: 'NIGHT_SHIFT_UPDATE',
    nightShift: settings.nightShift,
    nightShiftStart: settings.nightShiftStart,
    nightShiftEnd: settings.nightShiftEnd,
    nightShiftWarmth: settings.nightShiftWarmth,
    nightShiftBrightness: settings.nightShiftBrightness,
  });
}
