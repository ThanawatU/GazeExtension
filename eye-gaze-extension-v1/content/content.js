// content.js — GazeLink (merged)
// WebSocket connects DIRECTLY here — no routing through background.
// Brings: link zoom/glow/dwell from new + distance scaling/calibration/overlay from old.

(function () {
  'use strict';

  const WS_URL = 'ws://localhost:8765';
  const RECONNECT_DELAY_MS = 2000;

  // ─── State ────────────────────────────────────────────────────────────────────

  let settings = {
    enabled: false,
    dwellTime: 800,
    zoomScale: 1.8,
    doZoom: true,
    doGlow: true,
    doTooltip: true,
    doOpenOnDwell: false,
    glowColor: '#a855f7',
    showGazeDot: true,
  };

  let ws = null;
  let reconnectTimer = null;
  let gazeX = -9999;
  let gazeY = -9999;
  let currentTarget = null;
  let dwellTimer = null;
  let dwellStartTime = null;
  let currentDistance = 50;
  let fontScaled = false;
  let alertShown = false;
  let lastGazeX = null;
  let lastGazeY = null;

  // ─── WebSocket (direct from content script — same pattern as old extension) ───

  function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    try { ws = new WebSocket(WS_URL); }
    catch { scheduleReconnect(); return; }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ role: 'consumer' }));
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      console.log('[GazeLink] Connected to ws server');
      wsConnected = true;
      chrome.runtime.sendMessage({ type: 'WS_STATUS', status: 'connected' }).catch(() => {});
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (!settings.enabled) return;

      if (msg.type === 'GAZE_RESULT') {
        const d = msg.data;
        // console.log('[GazeLink] raw data:', JSON.stringify(d));
        // Handle gaze position
        if (d.normPog) handleGaze(d.normPog, d.gazeState);
        // Handle distance if sent by Python server
        if (d.distanceCm !== undefined) {
          currentDistance = d.distanceCm /1000;
          // handleDistanceEffects(currentDistance);
          updateOverlay();
        }
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      wsConnected = false;
      chrome.runtime.sendMessage({ type: 'WS_STATUS', status: 'disconnected' }).catch(() => {});
      if (settings.enabled) scheduleReconnect();
    });

    ws.addEventListener('error', () => {});
  }

  function disconnectWS() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.close(); ws = null; }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (settings.enabled) connectWS();
    }, RECONNECT_DELAY_MS);
  }

  // ─── Gaze smoothing (from old extension) ─────────────────────────────────────

  function smoothGaze(x, y, alpha = 0.2) {
    if (lastGazeX === null) { lastGazeX = x; lastGazeY = y; return { x, y }; }
    lastGazeX = lastGazeX + alpha * (x - lastGazeX);
    lastGazeY = lastGazeY + alpha * (y - lastGazeY);
    return { x: lastGazeX, y: lastGazeY };
  }

  // ─── Gaze dot ─────────────────────────────────────────────────────────────────

  const dot = document.createElement('div');
  dot.id = '__gazelink_dot__';
  Object.assign(dot.style, {
    position: 'fixed', width: '14px', height: '14px', borderRadius: '50%',
    background: 'rgba(236,72,153,0.85)', border: '2px solid rgba(255,255,255,0.7)',
    pointerEvents: 'none', zIndex: '2147483647',
    transform: 'translate(-50%,-50%)',
    transition: 'left 0.04s linear, top 0.04s linear',
    boxShadow: '0 0 8px rgba(236,72,153,0.6)', display: 'none',
  });
  document.documentElement.appendChild(dot);

  // ─── Tooltip ──────────────────────────────────────────────────────────────────

  const tooltip = document.createElement('div');
  tooltip.id = '__gazelink_tooltip__';
  Object.assign(tooltip.style, {
    position: 'fixed', background: 'rgba(15,15,20,0.92)', color: '#e8e8f0',
    padding: '4px 9px', borderRadius: '5px', fontSize: '11px', fontFamily: 'monospace',
    pointerEvents: 'none', zIndex: '2147483646', maxWidth: '280px',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    border: '1px solid #3a3a4a', display: 'none',
  });
  document.documentElement.appendChild(tooltip);

  // ─── Dwell ring ───────────────────────────────────────────────────────────────

  const ring = document.createElement('canvas');
  ring.width = 40; ring.height = 40;
  Object.assign(ring.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
    transform: 'translate(-50%,-50%)', display: 'none',
  });
  document.documentElement.appendChild(ring);
  const ringCtx = ring.getContext('2d');

  function drawRing(progress) {
    ringCtx.clearRect(0, 0, 40, 40);
    ringCtx.beginPath(); ringCtx.arc(20, 20, 16, 0, Math.PI * 2);
    ringCtx.strokeStyle = 'rgba(255,255,255,0.15)'; ringCtx.lineWidth = 3; ringCtx.stroke();
    ringCtx.beginPath();
    ringCtx.arc(20, 20, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ringCtx.strokeStyle = settings.glowColor; ringCtx.lineWidth = 3; ringCtx.stroke();
  }

  // ─── Distance overlay (from old extension) ───────────────────────────────────

  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed', right: '10px', top: '10px', padding: '5px 10px',
    background: 'rgba(0,0,0,0.6)', color: 'white', fontSize: '13px',
    fontFamily: 'monospace', zIndex: '2147483640', borderRadius: '5px',
    pointerEvents: 'none', display: 'none',
  });
  document.documentElement.appendChild(overlay);

  function updateOverlay() {
    overlay.textContent = `${window.innerWidth}×${window.innerHeight} | ${currentDistance.toFixed(1)} cm`;
  }

  window.addEventListener('resize', updateOverlay);

  // ─── Distance-based font scaling (from old extension) ────────────────────────
  const BASE_DISTANCE = 60;   
  const BASE_FONT_SCALE = 1;  
  const MIN_DISTANCE = 20;    
  const MAX_DISTANCE = 80;   
  let lastAppliedScale = null;

  function distanceToFontScale(distance) {
    const clamped = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance));
    return clamped / BASE_DISTANCE;
  }

  function handleDistanceEffects(distance) {
    const scale = distanceToFontScale(distance);

    // if (lastAppliedScale !== null && Math.abs(scale - lastAppliedScale) < 0.02) return;
    // lastAppliedScale = scale;
    
  const els = document.querySelectorAll('p, span, li, h1, h2, h3, h4, h5, h6, a, button');
    els.forEach(el => {
      const computed = parseFloat(window.getComputedStyle(el).fontSize) || 16;
      // Store original font size once
      if (!el.dataset.gazelinkOrigFont) {
        el.dataset.gazelinkOrigFont = computed;
      }
      const orig = parseFloat(el.dataset.gazelinkOrigFont);
      el.style.transition = 'font-size 0.3s ease';
      el.style.fontSize = (orig * scale).toFixed(1) + 'px';
  });

  fontScaled = scale !== 1;

  // Warning
  if (distance >= 100 && !alertShown) {
    alertShown = true;
    showNotification("You're too far from the screen!!!!");
  } else if (distance < 100) {
    alertShown = false;
  }
  }

function resetDistanceScaling() {
  document.querySelectorAll('p, span, li, h1, h2, h3, h4, h5, h6, a, button').forEach(el => {
    el.style.fontSize = el.dataset.gazelinkOrigFont ? el.dataset.gazelinkOrigFont + 'px' : '';
    el.style.transition = '';
    delete el.dataset.gazelinkOrigFont;
  });
  fontScaled = false;
  lastAppliedScale = null;
}

  // ─── Coordinate mapping ───────────────────────────────────────────────────────

  function normPogToScreen(nx, ny) {
    return {
      sx: (nx + 0.5) * window.innerWidth,
      sy: (ny + 0.5) * window.innerHeight,
    };
  }

// ─── Hold Alt/Option for 1 second to toggle font scale ───────────────────────
// ─── This function works for distance-based scaling and allows quick reset without needing to look at the overlay or open the popup. ───
  let altHoldTimer = null;
  let altHoldTriggered = false;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !altHoldTimer && !altHoldTriggered) {
      altHoldTimer = setTimeout(() => {
        altHoldTriggered = true;

        if (fontScaled) {
          resetDistanceScaling();
          showNotification('🔤 Font size reset');
        } else {
          handleDistanceEffects(currentDistance);
          showNotification(`🔍 Font scaled for ${currentDistance.toFixed(0)}cm distance`);
        }
      }, 1000); // 1 second 
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      clearTimeout(altHoldTimer);
      altHoldTimer = null;
      altHoldTriggered = false; // reset so next hold works
    }
  });

  // ─── Link effects (from new extension) ───────────────────────────────────────

  function applyEffects(el) {
    if (!el) return;
    if (settings.doZoom) {
      el.style.transition = 'transform 0.15s ease, box-shadow 0.15s ease';
      el.style.transform = `scale(${settings.zoomScale})`;
      el.style.transformOrigin = 'center center';
      el.style.zIndex = '9999';
      el.style.position = el.style.position || 'relative';
    }
    if (settings.doGlow) {
      el.style.boxShadow = `0 0 12px 4px ${settings.glowColor}`;
      el.style.outline = `2px solid ${settings.glowColor}`;
      el.style.borderRadius = '3px';
    }
    if (settings.doTooltip) {
      const href = el.href || el.getAttribute('href') || el.title || el.textContent.trim().slice(0, 60);
      tooltip.textContent = href;
      tooltip.style.display = 'block';
    }
  }

  function clearEffects(el) {
    if (!el) return;
    el.style.transform = ''; el.style.zIndex = '';
    el.style.boxShadow = ''; el.style.outline = '';
    tooltip.style.display = 'none';
  }

  // ─── Target detection ─────────────────────────────────────────────────────────

  function findTarget(x, y) {
    dot.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (settings.showGazeDot) dot.style.display = 'block';
    if (!el) return null;
    let node = el;
    while (node && node !== document.body) {
      if (node.tagName === 'A' || node.tagName === 'BUTTON' ||
          node.getAttribute?.('role') === 'button' ||
          node.getAttribute?.('role') === 'link' || node.onclick) return node;
      node = node.parentElement;
    }
    return null;
  }

  // ─── Dwell ────────────────────────────────────────────────────────────────────

  function startDwell(el) {
    dwellStartTime = Date.now();
    dwellTimer = setInterval(() => {
      const progress = Math.min((Date.now() - dwellStartTime) / settings.dwellTime, 1);
      ring.style.left = gazeX + 'px'; ring.style.top = gazeY + 'px';
      ring.style.display = 'block'; drawRing(progress);
      if (progress >= 1) { clearDwell(); if (settings.doOpenOnDwell && el?.href) window.location.href = el.href; }
    }, 30);
  }

  function clearDwell() {
    if (dwellTimer) { clearInterval(dwellTimer); dwellTimer = null; }
    dwellStartTime = null; ring.style.display = 'none';
  }

  function positionTooltip(x, y) {
    const tw = tooltip.offsetWidth;
    tooltip.style.left = Math.max(4, Math.min(x - tw / 2, window.innerWidth - tw - 4)) + 'px';
    tooltip.style.top = Math.max(4, y - 28) + 'px';
  }

  // ─── Main gaze handler ────────────────────────────────────────────────────────

  function handleGaze(normPog, gazeState) {
    if (gazeState === 'closed') {
      if (currentTarget) { clearEffects(currentTarget); currentTarget = null; }
      clearDwell(); dot.style.display = 'none'; return;
    }

    let { sx, sy } = normPogToScreen(normPog[0], normPog[1]);
    const smoothed = smoothGaze(sx, sy);
    sx = smoothed.x; sy = smoothed.y;
    gazeX = sx; gazeY = sy;

    if (settings.showGazeDot) {
      dot.style.display = 'block';
      dot.style.left = sx + 'px'; dot.style.top = sy + 'px';
    } else {
      dot.style.display = 'none';
    }

    const target = findTarget(sx, sy);
    if (target !== currentTarget) {
      if (currentTarget) { clearEffects(currentTarget); clearDwell(); }
      currentTarget = target;
      if (target) { applyEffects(target); if (settings.doOpenOnDwell) startDwell(target); }
    }
    if (settings.doTooltip && currentTarget) positionTooltip(sx, sy);
  }

  // ─── Calibration (from old extension) ────────────────────────────────────────

  function setupCalibration() {
    const grid = 3;
    const points = [];
    for (let i = 0; i < grid; i++)
      for (let j = 0; j < grid; j++)
        points.push([i / (grid - 1), j / (grid - 1)]);

    let index = 0, sampleCount = 0;
    const maxSamples = 5;

    const calDot = document.createElement('div');
    Object.assign(calDot.style, {
      position: 'fixed', width: '40px', height: '40px', borderRadius: '50%',
      background: settings.glowColor, zIndex: '2147483647', cursor: 'pointer',
      transition: 'all 0.2s ease', boxShadow: `0 0 16px 4px ${settings.glowColor}`,
    });

    const calLabel = document.createElement('div');
    Object.assign(calLabel.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      color: 'white', fontFamily: 'monospace', fontSize: '14px', zIndex: '2147483647',
      background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: '8px',
      pointerEvents: 'none',
    });
    calLabel.textContent = 'Click each dot to calibrate (5 clicks each)';
    document.documentElement.appendChild(calLabel);
    document.documentElement.appendChild(calDot);

    function showNext() {
      if (index >= points.length) {
        calDot.remove(); calLabel.remove();
        showNotification('✅ Calibration complete!');
        return;
      }
      const [px, py] = points[index];
      calDot.style.left = (px * (window.innerWidth - 40)) + 'px';
      calDot.style.top = (py * (window.innerHeight - 40)) + 'px';
      sampleCount = 0;
    }

    calDot.addEventListener('click', () => {
      sampleCount++;
      calDot.style.background = sampleCount % 2 === 0 ? settings.glowColor : '#fff';
      calLabel.textContent = `Point ${index + 1}/${points.length} — click ${maxSamples - sampleCount} more`;
      if (sampleCount >= maxSamples) { index++; showNext(); }
    });

    showNext();
  }

  // ─── Notification helper ──────────────────────────────────────────────────────

  function showNotification(text) {
    const n = document.createElement('div');
    Object.assign(n.style, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(15,15,20,0.95)', color: '#e8e8f0', padding: '10px 20px',
      borderRadius: '8px', fontFamily: 'monospace', fontSize: '13px',
      zIndex: '2147483647', border: `1px solid ${settings.glowColor}`,
      boxShadow: `0 0 12px ${settings.glowColor}`,
    });
    n.textContent = text;
    document.documentElement.appendChild(n);
    setTimeout(() => n.remove(), 3000);
  }

  // ─── Night Shift ──────────────────────────────────────────────────────────────

// const nightShiftOverlay = document.createElement('div');
// nightShiftOverlay.id = '__gazelink_nightshift__';
// Object.assign(nightShiftOverlay.style, {
//   position: 'fixed', inset: '0', zIndex: '2147483630',
//   pointerEvents: 'none', display: 'none',
//   background: 'rgba(255, 140, 20, 0.15)',
//   mixBlendMode: 'multiply',
//   transition: 'opacity 1s ease',
// });
// document.documentElement.appendChild(nightShiftOverlay);

let nightShiftCheckTimer = null;

function isNightShiftActive() {
  if (!settings.nightShift) return false;
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = (settings.nightShiftStart || '20:00').split(':').map(Number);
  const [endH, endM] = (settings.nightShiftEnd || '07:00').split(':').map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;

  // Handle overnight range (e.g. 20:00 → 07:00)
  if (start > end) return currentMinutes >= start || currentMinutes < end;
  return currentMinutes >= start && currentMinutes < end;
}

function applyNightShift() {
  if (isNightShiftActive()) {
    const warmth = (settings.nightShiftWarmth ?? 30) / 100;
    const brightness = (settings.nightShiftBrightness ?? 95) / 100;
    document.documentElement.style.filter =
      `sepia(${warmth}) saturate(${1 - warmth * 0.15}) brightness(${brightness})`;
  } else {
    document.documentElement.style.filter = '';
  }
}

function startNightShiftWatch() {
  applyNightShift();
  if (nightShiftCheckTimer) clearInterval(nightShiftCheckTimer);
  nightShiftCheckTimer = setInterval(applyNightShift, 60000); // check every minute
}

function stopNightShiftWatch() {
  nightShiftOverlay.style.display = 'none';
  if (nightShiftCheckTimer) { clearInterval(nightShiftCheckTimer); nightShiftCheckTimer = null; }
}

  // ─── Settings from popup via background ───────────────────────────────────────

  // Store WS connected state so popup can query it
  let wsConnected = false;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_WS_STATUS') {
      sendResponse({ connected: wsConnected });
      return false;
    }
    if (msg.type === 'SETTINGS_UPDATE') {
      settings = { ...settings, ...msg.settings };
      if (settings.enabled) {
        connectWS();
        overlay.style.display = 'block';
        updateOverlay();
      } else {
        disconnectWS();
        overlay.style.display = 'none';
        if (currentTarget) { clearEffects(currentTarget); currentTarget = null; }
        clearDwell(); resetDistanceScaling();
        dot.style.display = 'none'; tooltip.style.display = 'none';
      }
    }
    if (msg.type === 'STOP_TRACKING') {
      settings.enabled = false;
      disconnectWS();
      overlay.style.display = 'none';
      if (currentTarget) { clearEffects(currentTarget); currentTarget = null; }
      clearDwell(); resetDistanceScaling();
      dot.style.display = 'none'; tooltip.style.display = 'none';
    }
    if (msg.type === 'CALIBRATE') {
      setupCalibration();
    }
  });

  // Listen for night shift 
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'NIGHT_SHIFT_UPDATE') {
      settings.nightShift = msg.nightShift;
      settings.nightShiftStart = msg.nightShiftStart;
      settings.nightShiftEnd = msg.nightShiftEnd;
      settings.nightShiftWarmth = msg.nightShiftWarmth;   
      settings.nightShiftBrightness = msg.nightShiftBrightness; 
      if (settings.nightShift) startNightShiftWatch();
      else stopNightShiftWatch();
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────────

  chrome.storage.local.get(['gazeSettings'], (result) => {
    if (result.gazeSettings) settings = { ...settings, ...result.gazeSettings };
    if (settings.enabled) {
      connectWS();
      overlay.style.display = 'block';
      updateOverlay();
    }
    if (settings.nightShift) startNightShiftWatch();

  });

})();