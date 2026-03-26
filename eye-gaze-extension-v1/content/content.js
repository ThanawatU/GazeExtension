(function() {
  'use strict';

  const WS_URL = 'ws://localhost:8765';
  const RECONNECT_DELAY_MS = 2000;

  // ─── Settings state ───────────────────────────────────────────────────────────

  let settings = {
    enabled: false,
    dwellTime: 800,
    zoomScale: 1.8,
    doZoom: true,
    doGlow: true,
    doTooltip: true,
    doOpenOnDwell: false,
    doButtonHoldSpeech: true,
    speechMode: 'ctrl',
    glowColor: '#a855f7',
    showGazeDot: true,
    nightShift: false,
    nightShiftWarmth: 30,
    nightShiftBrightness: 95,
    nightShiftStart: '20:00',
    nightShiftEnd: '07:00',





    cursorSize: 32,        // เพิ่ม: ขนาด cursor (px)
    cursorColor: '#a855f7', // เพิ่ม: สี cursor
  };

  // ─── Runtime state ────────────────────────────────────────────────────────────

  let ws = null;
  let wsConnected = false;
  let reconnectTimer = null;
  let gazeX = -9999, gazeY = -9999;
  let currentTarget = null;
  let dwellTimer = null, dwellStartTime = null;
  let currentDistance = 50;
  let fontScaled = false, alertShown = false;
  let lastGazeX = null, lastGazeY = null;
  let altHoldTimer = null, altHoldTriggered = false;
  let nightShiftCheckTimer = null;

  // ─── Drowsiness state ─────────────────────────────────────────────────────────

  const DROWSY_STAGE_1 = 20;
  const DROWSY_STAGE_2 = 40;
  const DROWSY_STAGE_3 = 70;

  let drowsyCount = 0;
  let currentBreakStage = 0;
  let breakScreenVisible = false;

  function saveDrowsyState() {
    chrome.storage.local.set({ gazelink_drowsy: { count: drowsyCount, stage: currentBreakStage } });
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────────

  function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try { ws = new WebSocket(WS_URL); }
    catch { scheduleReconnect(); return; }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ role: 'consumer' }));
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      console.log('[GazeLink] WS connected');
      wsConnected = true;
      chrome.runtime.sendMessage({ type: 'WS_STATUS', status: 'connected' }).catch(() => { });
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!settings.enabled) return;

      if (msg.type === 'GAZE_RESULT') {
        const d = msg.data;
        if (d.normPog) handleGaze(d.normPog, d.gazeState);
        if (d.distanceCm !== undefined) {
          currentDistance = d.distanceCm / 1000;
          updateOverlay();
        }
        if (d.is_drowsy !== undefined) {
          handleDrowsy(d.is_drowsy);
        }
      }
    });

    ws.addEventListener('close', () => {
      ws = null; wsConnected = false;
      chrome.runtime.sendMessage({ type: 'WS_STATUS', status: 'disconnected' }).catch(() => { });
      if (settings.enabled) scheduleReconnect();
    });

    ws.addEventListener('error', () => { });
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

  // ─── Gaze smoothing ───────────────────────────────────────────────────────────

  function smoothGaze(x, y, alpha = 0.2) {
    if (lastGazeX === null) { lastGazeX = x; lastGazeY = y; return { x, y }; }
    lastGazeX += alpha * (x - lastGazeX);
    lastGazeY += alpha * (y - lastGazeY);
    return { x: lastGazeX, y: lastGazeY };
  }

  // ─── DOM: Gaze dot ────────────────────────────────────────────────────────────

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

  // ─── DOM: Tooltip ─────────────────────────────────────────────────────────────

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

  // ─── DOM: Dwell ring ──────────────────────────────────────────────────────────

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

  // ─── DOM: Distance overlay (top-right) ───────────────────────────────────────

  const overlay = document.createElement('div');
  overlay.id = '__gazelink_overlay__';
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

  // ─── DOM: Drowsy counter (bottom-right) ───────────────────────────────────────

  const drowsyOverlay = document.createElement('div');
  drowsyOverlay.id = '__gazelink_drowsy__';
  Object.assign(drowsyOverlay.style, {
    position: 'fixed', right: '10px', bottom: '10px', padding: '6px 12px',
    background: 'rgba(0,0,0,0.65)', color: '#22c55e',
    fontSize: '12px', fontFamily: 'monospace',
    zIndex: '2147483641', borderRadius: '6px',
    border: '1px solid #22c55e',
    pointerEvents: 'none', display: 'none',
    transition: 'color 0.3s ease, border-color 0.3s ease',
  });
  document.documentElement.appendChild(drowsyOverlay);

  function updateDrowsyOverlay() {
    let color = '#22c55e', label = 'Alert';
    if (drowsyCount >= DROWSY_STAGE_3) { color = '#7c3aed'; label = 'Sleep!'; }
    else if (drowsyCount >= DROWSY_STAGE_2) { color = '#ef4444'; label = 'Very Tired'; }
    else if (drowsyCount >= DROWSY_STAGE_1) { color = '#f59e0b'; label = 'Tired'; }
    drowsyOverlay.style.color = color;
    drowsyOverlay.style.borderColor = color;
    drowsyOverlay.textContent = `😴 ${label} · ${drowsyCount}`;
  }

  // ─── Distance-based font scaling ──────────────────────────────────────────────

  const BASE_DISTANCE = 60, MIN_DISTANCE = 20, MAX_DISTANCE = 80;
  let lastAppliedScale = null;

  function distanceToFontScale(d) {
    return Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, d)) / BASE_DISTANCE;
  }

  function handleDistanceEffects(distance) {
    const scale = distanceToFontScale(distance);
    document.querySelectorAll('p, span, li, h1, h2, h3, h4, h5, h6, a, button').forEach(el => {
      const computed = parseFloat(window.getComputedStyle(el).fontSize) || 16;
      if (!el.dataset.gazelinkOrigFont) el.dataset.gazelinkOrigFont = computed;
      el.style.transition = 'font-size 0.3s ease';
      el.style.fontSize = (parseFloat(el.dataset.gazelinkOrigFont) * scale).toFixed(1) + 'px';
    });
    fontScaled = scale !== 1;
    if (distance >= 100 && !alertShown) { alertShown = true; showNotification("You're too far from the screen!"); }
    else if (distance < 100) alertShown = false;
  }

  function resetDistanceScaling() {
    document.querySelectorAll('p, span, li, h1, h2, h3, h4, h5, h6, a, button').forEach(el => {
      el.style.fontSize = el.dataset.gazelinkOrigFont ? el.dataset.gazelinkOrigFont + 'px' : '';
      el.style.transition = '';
      delete el.dataset.gazelinkOrigFont;
    });
    fontScaled = false; lastAppliedScale = null;
  }

  // ─── Alt-hold 1s to toggle font scale ────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !altHoldTimer && !altHoldTriggered) {
      altHoldTimer = setTimeout(() => {
        altHoldTriggered = true;
        if (fontScaled) { resetDistanceScaling(); showNotification('🔤 Font size reset'); }
        else { handleDistanceEffects(currentDistance); showNotification(`🔍 Font scaled for ${currentDistance.toFixed(0)}cm`); }
      }, 1000);
    }

    if (e.key === 'Alt') return;

    // ไม่พูดปุ่ม Control 
    if (e.key === 'Control' || e.key === 'Ctrl') return;

    if (!settings.enabled) return;

    const currentKey = e.key;
    if (lastSpokenKey === currentKey) {
      if (keySpeechTimeout) clearTimeout(keySpeechTimeout);
      keySpeechTimeout = setTimeout(() => { lastSpokenKey = null; }, 200);
      return;
    }

    lastSpokenKey = currentKey;
    keySpeechTimeout = setTimeout(() => { lastSpokenKey = null; }, 500);

    // เพิ่มการพูดคีย์บอร์ด - ตรวจสอบ doKeyboardSpeech
    if (settings.doKeyboardSpeech && e.key !== 'Control' && e.key !== 'Ctrl') {
      // ไม่พูดปุ่ม Control 
      if (e.key === 'Control' || e.key === 'Ctrl') return;

      const thaiName = getKeyNameThai(e.key, e.code);
      speakThai(thaiName);
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') { clearTimeout(altHoldTimer); altHoldTimer = null; altHoldTriggered = false; }
  });

  // ─── Coordinate mapping ───────────────────────────────────────────────────────

  function normPogToScreen(nx, ny) {
    return { sx: (nx + 0.5) * window.innerWidth, sy: (ny + 0.5) * window.innerHeight };
  }

  // ─── Link effects ─────────────────────────────────────────────────────────────

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
      tooltip.textContent = el.href || el.getAttribute('href') || el.title || el.textContent.trim().slice(0, 60);
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

    if (settings.showGazeDot) { dot.style.display = 'block'; dot.style.left = sx + 'px'; dot.style.top = sy + 'px'; }
    else dot.style.display = 'none';

    const target = findTarget(sx, sy);
    if (target !== currentTarget) {
      if (currentTarget) { clearEffects(currentTarget); clearDwell(); }
      currentTarget = target;
      if (target) { applyEffects(target); if (settings.doOpenOnDwell) startDwell(target); }
    }
    if (settings.doTooltip && currentTarget) positionTooltip(sx, sy);
  }

  // ─── Night Shift ──────────────────────────────────────────────────────────────

  function isNightShiftActive() {
    if (!settings.nightShift) return false;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = (settings.nightShiftStart || '20:00').split(':').map(Number);
    const [eh, em] = (settings.nightShiftEnd || '07:00').split(':').map(Number);
    const s = sh * 60 + sm, e = eh * 60 + em;
    return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
  }

  function applyNightShift() {
    if (isNightShiftActive()) {
      const w = (settings.nightShiftWarmth ?? 30) / 100;
      const b = (settings.nightShiftBrightness ?? 95) / 100;
      document.documentElement.style.filter = `sepia(${w}) saturate(${1 - w * 0.15}) brightness(${b})`;
    } else {
      document.documentElement.style.filter = '';
    }
  }

  function startNightShiftWatch() {
    applyNightShift();
    if (nightShiftCheckTimer) clearInterval(nightShiftCheckTimer);
    nightShiftCheckTimer = setInterval(applyNightShift, 60000);
  }

  function stopNightShiftWatch() {
    document.documentElement.style.filter = '';
    if (nightShiftCheckTimer) { clearInterval(nightShiftCheckTimer); nightShiftCheckTimer = null; }
  }

  // ─── Break screen ─────────────────────────────────────────────────────────────

  const BREAK_CONFIGS = [
    {
      emoji: '😴', color: '#f59e0b',
      title: 'Time for a Short Break',
      message: "You've been showing signs of drowsiness. Rest your eyes for a few minutes.",
      sub: 'Look away from the screen and focus on something distant.',
      btn: "I'll take a break ✓", escapable: true,
    },
    {
      emoji: '😵', color: '#ef4444',
      title: 'You Really Need a Break',
      message: "You've been drowsy for a while. Step away from the screen.",
      sub: 'Stretch, drink some water, and rest your eyes properly.',
      btn: 'Taking a break now ✓', escapable: true,
    },
    {
      emoji: '🛌', color: '#7c3aed',
      title: 'Time to Sleep',
      message: 'Your body needs rest. Please stop using the screen and go to bed.',
      sub: 'No screen is worth your health. Good night. 🌙',
      btn: 'Going to sleep ✓', escapable: false,
    },
  ];

  const breakScreen = document.createElement('div');
  breakScreen.id = '__gazelink_break__';
  Object.assign(breakScreen.style, {
    position: 'fixed', inset: '0', zIndex: '2147483645',
    display: 'none', alignItems: 'center', justifyContent: 'center',
    backdropFilter: 'blur(12px)', webkitBackdropFilter: 'blur(12px)',
    background: 'rgba(5,5,15,0.75)', opacity: '0',
    transition: 'opacity 0.4s ease',
  });
  const breakCard = document.createElement('div');
  Object.assign(breakCard.style, {
    background: 'rgba(15,15,25,0.97)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '20px', padding: '48px 40px', maxWidth: '440px', width: '90%',
    textAlign: 'center', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
    transform: 'translateY(20px)', transition: 'transform 0.4s ease',
  });
  breakScreen.appendChild(breakCard);
  document.documentElement.appendChild(breakScreen);

  function showBreakScreen(stage) {
    const cfg = BREAK_CONFIGS[stage - 1];
    if (!cfg || breakScreenVisible) return;
    breakScreenVisible = true;

    breakCard.innerHTML = `
      <div style="font-size:64px;margin-bottom:16px;line-height:1">${cfg.emoji}</div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${cfg.color};font-weight:700;margin-bottom:12px">
        GazeLink · Eye Health Alert
      </div>
      <h2 style="color:#f0f0ff;font-size:22px;font-weight:700;margin-bottom:14px;line-height:1.3">${cfg.title}</h2>
      <p style="color:#aaa;font-size:14px;line-height:1.7;margin-bottom:10px">${cfg.message}</p>
      <p style="color:#666;font-size:12px;line-height:1.6;margin-bottom:32px">${cfg.sub}</p>
      <div style="width:100%;height:4px;background:rgba(255,255,255,0.08);border-radius:4px;margin-bottom:28px;overflow:hidden">
        <div style="height:100%;width:${(stage / 3) * 100}%;background:${cfg.color};border-radius:4px"></div>
      </div>
      <button id="__gazelink_break_btn__" style="
        background:${cfg.color};color:white;border:none;padding:13px 32px;
        border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;
        width:100%;letter-spacing:0.3px
      ">${cfg.btn}</button>
      ${cfg.escapable ? `<p style="color:#444;font-size:11px;margin-top:14px">or press Escape to dismiss</p>` : ''}
    `;

    breakScreen.style.display = 'flex';
    requestAnimationFrame(() => {
      breakScreen.style.opacity = '1';
      breakCard.style.transform = 'translateY(0)';
    });

    document.getElementById('__gazelink_break_btn__').addEventListener('click', dismissBreakScreen);
    if (cfg.escapable) document.addEventListener('keydown', escDismiss);
  }

  function escDismiss(e) { if (e.key === 'Escape') dismissBreakScreen(); }

  function dismissBreakScreen() {
    breakScreen.style.opacity = '0';
    breakCard.style.transform = 'translateY(20px)';
    setTimeout(() => { breakScreen.style.display = 'none'; }, 400);
    breakScreenVisible = false;
    document.removeEventListener('keydown', escDismiss);

    if (currentBreakStage >= 3) {
      drowsyCount = 0;
      currentBreakStage = 0;
    }

    updateDrowsyOverlay();
    saveDrowsyState();
  }

  // ─── Drowsiness handler ───────────────────────────────────────────────────────

  function handleDrowsy(isDrowsy) {
    if (!isDrowsy) return;
    if (breakScreenVisible) return;
    drowsyCount++;
    updateDrowsyOverlay();
    saveDrowsyState();

    if (drowsyCount >= DROWSY_STAGE_3 && currentBreakStage < 3) { currentBreakStage = 3; showBreakScreen(3); }
    else if (drowsyCount >= DROWSY_STAGE_2 && currentBreakStage < 2) { currentBreakStage = 2; showBreakScreen(2); }
    else if (drowsyCount >= DROWSY_STAGE_1 && currentBreakStage < 1) { currentBreakStage = 1; showBreakScreen(1); }
  }

  // ─── Notification ─────────────────────────────────────────────────────────────

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

  // ─── Helpers: show/hide all HUD elements ─────────────────────────────────────

  function showHUD() {
    overlay.style.display = 'block';
    drowsyOverlay.style.display = 'block';
    updateOverlay();
    updateDrowsyOverlay();
  }

  function hideHUD() {
    overlay.style.display = 'none';
    drowsyOverlay.style.display = 'none';
  }

  function fullStop() {
    disconnectWS();
    hideHUD();
    if (currentTarget) { clearEffects(currentTarget); currentTarget = null; }
    clearDwell();
    resetDistanceScaling();
    dot.style.display = 'none';
    tooltip.style.display = 'none';
    drowsyCount = 0;
    currentBreakStage = 0;
    updateDrowsyOverlay();
    stopHourlyBreakReminder();
    stopButtonHoldListener();
    resetCursorSize();
  }

  // ─── Hourly Break Reminder ─────────────────────────────────────────────────────────

  let lastBreakReminder = null;
  let breakReminderInterval = null;
  let breakReminderScreenVisible = false;
  const ONE_HOUR_MS = 10 * 1000;

  const hourBreakScreen = document.createElement('div');
  hourBreakScreen.id = '__gazelink_hour_break__';
  Object.assign(hourBreakScreen.style, {
    position: 'fixed', inset: '0', zIndex: '2147483644',
    display: 'none', alignItems: 'center', justifyContent: 'center',
    backdropFilter: 'blur(12px)', webkitBackdropFilter: 'blur(12px)',
    background: 'rgba(0,0,0,0.75)', opacity: '0',
    transition: 'opacity 0.4s ease',
  });

  const hourBreakCard = document.createElement('div');
  Object.assign(hourBreakCard.style, {
    background: 'rgba(20,20,35,0.98)', border: '1px solid rgba(168,85,247,0.5)',
    borderRadius: '20px', padding: '48px 40px', maxWidth: '440px', width: '90%',
    textAlign: 'center', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
    transform: 'translateY(20px)', transition: 'transform 0.4s ease',
  });

  hourBreakScreen.appendChild(hourBreakCard);
  document.documentElement.appendChild(hourBreakScreen);

  function showHourBreakReminder() {
    if (breakReminderScreenVisible) return;
    if (!settings.enabled) return;

    breakReminderScreenVisible = true;

    hourBreakCard.innerHTML = `
    <div style="font-size:64px;margin-bottom:16px;line-height:1">⏰</div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#a855f7;font-weight:700;margin-bottom:12px">
      GazeLink · Eye Health Reminder
    </div>
    <h2 style="color:#f0f0ff;font-size:22px;font-weight:700;margin-bottom:14px;line-height:1.3">Time for a Break!</h2>
    <p style="color:#aaa;font-size:14px;line-height:1.7;margin-bottom:10px">
      You've been using the screen for 20 minutes continuously.
    </p>
    <p style="color:#666;font-size:12px;line-height:1.6;margin-bottom:32px">
        Give your eyes a break every 20 minutes. Look at something 6 meters away from the screen for 20 seconds. 👁️
    </p>
    <button id="__gazelink_hour_break_btn__" style="
      background:#a855f7;color:white;border:none;padding:13px 32px;
      border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;
      width:100%;letter-spacing:0.3px;margin-bottom:12px
    ">I'll take a break ✓</button>
    <button id="__gazelink_hour_break_snooze__" style="
      background:transparent;color:#888;border:1px solid #444;
      padding:10px 24px;border-radius:12px;font-size:12px;
      cursor:pointer;width:100%
    ">Snooze (15 min)</button>
  `;

    hourBreakScreen.style.display = 'flex';
    requestAnimationFrame(() => {
      hourBreakScreen.style.opacity = '1';
      hourBreakCard.style.transform = 'translateY(0)';
    });

    document.getElementById('__gazelink_hour_break_btn__').addEventListener('click', () => {
      dismissHourBreakReminder();

    });

    document.getElementById('__gazelink_hour_break_snooze__').addEventListener('click', () => {
      dismissHourBreakReminder();
      if (breakReminderInterval) clearInterval(breakReminderInterval);
      lastBreakReminder = Date.now();
      breakReminderInterval = setInterval(() => {
        checkHourlyBreak();
      }, 15 * 60 * 1000);
    });
  }

  function dismissHourBreakReminder() {
    hourBreakScreen.style.opacity = '0';
    hourBreakCard.style.transform = 'translateY(20px)';
    setTimeout(() => {
      hourBreakScreen.style.display = 'none';
      breakReminderScreenVisible = false;
    }, 400);
  }

  function checkHourlyBreak() {
    if (!settings.enabled) return;
    if (breakReminderScreenVisible) return;
    if (breakScreenVisible) return;

    const now = Date.now();
    if (!lastBreakReminder) {
      lastBreakReminder = now;
      return;
    }
    console.log(now, lastBreakReminder, ONE_HOUR_MS);
    if (now - lastBreakReminder >= ONE_HOUR_MS) {
      showHourBreakReminder();
      lastBreakReminder = now;
    }
  }

  function startHourlyBreakReminder() {
    if (!settings.doHourlyBreak) return;

    if (breakReminderInterval) clearInterval(breakReminderInterval);
    lastBreakReminder = Date.now();
    breakReminderInterval = setInterval(() => {
      checkHourlyBreak();
    }, ONE_HOUR_MS);
  }

  function stopHourlyBreakReminder() {
    if (breakReminderInterval) {
      clearInterval(breakReminderInterval);
      breakReminderInterval = null;
    }
    if (hourBreakScreen.style.display !== 'none') {
      dismissHourBreakReminder();
    }
  }

  // ─── Keyboard speech (Thai voice) ──────────────────────────────────────────────

  let lastSpokenKey = null;
  let keySpeechTimeout = null;

  function speakThai(text) {
    if (!settings.enabled) return;
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'th-TH';
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    utterance.volume = 0.8;

    let voices = [];
    const setVoice = () => {
      voices = speechSynthesis.getVoices();
      const thaiVoice = voices.find(voice =>
        voice.lang === 'th-TH' ||
        voice.lang === 'th' ||
        voice.name.includes('Thai') ||
        voice.name.includes('Kanya')
      );
      if (thaiVoice) utterance.voice = thaiVoice;
      speechSynthesis.speak(utterance);
    };

    if (speechSynthesis.getVoices().length > 0) {
      setVoice();
    } else {
      speechSynthesis.onvoiceschanged = setVoice;
    }
  }

  function getKeyNameThai(key, code) {
    if (key.length === 1 && /[A-Za-z]/.test(key)) {
      const thaiMap = {
        'A': 'เอ', 'B': 'บี', 'C': 'ซี', 'D': 'ดี', 'E': 'อี',
        'F': 'เอฟ', 'G': 'จี', 'H': 'เอช', 'I': 'ไอ', 'J': 'เจ',
        'K': 'เค', 'L': 'แอล', 'M': 'เอ็ม', 'N': 'เอ็น', 'O': 'โอ',
        'P': 'พี', 'Q': 'คิว', 'R': 'อาร์', 'S': 'เอส', 'T': 'ที',
        'U': 'ยู', 'V': 'วี', 'W': 'ดับเบิลยู', 'X': 'เอกซ์', 'Y': 'วาย', 'Z': 'แซด'
      };
      return thaiMap[key.toUpperCase()] || key;
    }

    if (/[0-9]/.test(key)) {
      const numMap = {
        '0': 'ศูนย์', '1': 'หนึ่ง', '2': 'สอง', '3': 'สาม', '4': 'สี่',
        '5': 'ห้า', '6': 'หก', '7': 'เจ็ด', '8': 'แปด', '9': 'เก้า'
      };
      return numMap[key] || key;
    }

    const specialKeys = {
      'Enter': 'Enter',
      'Space': 'สเปซบาร์',
      'Backspace': 'แบ็คสเปซ',
      'Delete': 'ดีลีท',
      'Tab': 'แท็บ',
      'Escape': 'เอสเคป',
      'ArrowUp': 'ลูกศรขึ้น',
      'ArrowDown': 'ลูกศรลง',
      'ArrowLeft': 'ลูกศรซ้าย',
      'ArrowRight': 'ลูกศรขวา',
      'Shift': 'ชิฟต์',
      'Control': 'คอนโทรล',
      'Alt': 'อัลท์',
      'Meta': 'วินโดวส์',
      'CapsLock': 'แคปล็อก',
      'Home': 'โฮม',
      'End': 'เอนด์',
      'PageUp': 'เพจอัพ',
      'PageDown': 'เพจดาวน์',
      'Insert': 'อินเสิร์ท',
      'F1': 'เอฟหนึ่ง',
      'F2': 'เอฟสอง',
      'F3': 'เอฟสาม',
      'F4': 'เอฟสี่',
      'F5': 'เอฟห้า',
      'F6': 'เอฟหก',
      'F7': 'เอฟเจ็ด',
      'F8': 'เอฟแปด',
      'F9': 'เอฟเก้า',
      'F10': 'เอฟสิบ',
      'F11': 'เอฟสิบเอ็ด',
      'F12': 'เอฟสิบสอง',
    };

    return specialKeys[key] || key;
  }

  // ─── Text-to-Speech with Button Hold (Ctrl) + Highlight ──────────────────────

  let isCtrlPressed = false;
  let ctrlHoldTimer = null;
  let lastSpokenHoldText = null;
  let holdSpeechTimeout = null;
  let isSpeakingHoldText = false;
  let currentHoldTarget = null;
  let currentUtterance = null;
  let ctrlIndicator = null;

  // สร้าง element สำหรับ highlight
  const highlightSpan = document.createElement('span');
  highlightSpan.id = '__gazelink_highlight__';
  Object.assign(highlightSpan.style, {
    position: 'absolute',
    backgroundColor: 'rgba(168, 85, 247, 0.4)',
    borderBottom: `2px solid ${settings.glowColor}`,
    borderRadius: '2px',
    pointerEvents: 'none',
    zIndex: '2147483646',
    transition: 'all 0.05s linear',
    boxShadow: '0 0 4px rgba(168,85,247,0.5)',
    display: 'none'
  });
  document.documentElement.appendChild(highlightSpan);

  function getElementText(element) {
    if (element.hasAttribute('data-gazelink-speech')) {
      return element.getAttribute('data-gazelink-speech');
    } else if (element.hasAttribute('title')) {
      return element.getAttribute('title');
    } else if (element.hasAttribute('alt')) {
      return element.getAttribute('alt');
    } else if (element.hasAttribute('aria-label')) {
      return element.getAttribute('aria-label');
    } else {
      let rawText = element.textContent || element.innerText || '';
      rawText = rawText.trim();
      if (rawText.length > 1000) {
        rawText = rawText.slice(0, 1000) + '...';
      }
      return rawText;
    }
  }

  function splitIntoWords(text) {
    const thaiWordPattern = /[\u0E00-\u0E7F]+/g;
    const englishWordPattern = /[a-zA-Z]+/g;
    const numberPattern = /[0-9]+/g;

    let matches = [];
    let match;

    while ((match = thaiWordPattern.exec(text)) !== null) {
      matches.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
    while ((match = englishWordPattern.exec(text)) !== null) {
      matches.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
    while ((match = numberPattern.exec(text)) !== null) {
      matches.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }

    matches.sort((a, b) => a.start - b.start);

    let merged = [];
    for (let i = 0; i < matches.length; i++) {
      if (merged.length === 0) {
        merged.push(matches[i]);
      } else {
        let last = merged[merged.length - 1];
        if (matches[i].start - last.end <= 2 &&
          /[\u0E00-\u0E7F]/.test(last.text) &&
          /[\u0E00-\u0E7F]/.test(matches[i].text)) {
          last.end = matches[i].end;
          last.text = text.substring(last.start, last.end);
        } else {
          merged.push(matches[i]);
        }
      }
    }

    return merged;
  }

  function findTextNodeAtPosition(element, position) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          if (node.textContent.trim().length === 0) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.tagName === 'SCRIPT' || node.parentElement?.tagName === 'STYLE') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let currentNode;
    let currentPos = 0;

    while (currentNode = walker.nextNode()) {
      const nodeText = currentNode.textContent;
      const nodeLength = nodeText.length;

      if (position >= currentPos && position < currentPos + nodeLength) {
        const offset = position - currentPos;
        return { node: currentNode, start: offset, end: offset + 1 };
      }

      currentPos += nodeLength;
    }

    return null;
  }

  function highlightWordRange(element, start, end) {
    try {
      const range = document.createRange();
      const textNodeInfo = findTextNodeAtPosition(element, start);

      if (textNodeInfo && textNodeInfo.node) {
        range.setStart(textNodeInfo.node, textNodeInfo.start);
        range.setEnd(textNodeInfo.node, textNodeInfo.end);

        const rects = range.getClientRects();
        if (rects.length > 0) {
          const rect = rects[0];
          highlightSpan.style.display = 'block';
          highlightSpan.style.left = rect.left + 'px';
          highlightSpan.style.top = rect.top + 'px';
          highlightSpan.style.width = rect.width + 'px';
          highlightSpan.style.height = rect.height + 'px';

          if (rect.top < 100 || rect.bottom > window.innerHeight - 100) {
            rect.element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
    } catch (e) { }
  }

  function highlightWord(word, element, fullText) {
    if (!word || !element) return;
    try {
      const textContent = element.textContent || element.innerText;
      const wordIndex = textContent.indexOf(word);
      if (wordIndex !== -1) {
        highlightWordRange(element, wordIndex, wordIndex + word.length);
      }
    } catch (e) { }
  }

  function hideHighlight() {
    highlightSpan.style.display = 'none';
  }

  function speakWithHighlight(text, element) {
    if (!text || !element) return;

    if (currentUtterance) {
      speechSynthesis.cancel();
      hideHighlight();
    }

    const words = splitIntoWords(text);

    if (words.length === 0) {
      const utterance = new SpeechSynthesisUtterance(text);
      setupUtterance(utterance, element);
      speechSynthesis.speak(utterance);
      return;
    }

    let currentWordPos = 0;

    function speakNextWord() {
      if (currentWordPos >= words.length) {
        hideHighlight();
        currentUtterance = null;
        return;
      }

      const wordObj = words[currentWordPos];
      const wordText = wordObj.text;

      highlightWord(wordText, element, text);

      const utterance = new SpeechSynthesisUtterance(wordText);

      utterance.onstart = () => {
        currentUtterance = utterance;
      };

      utterance.onend = () => {
        currentWordPos++;
        setTimeout(() => {
          if (currentUtterance === utterance) {
            speakNextWord();
          }
        }, 50);
      };

      utterance.onerror = () => {
        currentWordPos++;
        speakNextWord();
      };

      setupUtterance(utterance, element);
      speechSynthesis.speak(utterance);
    }

    speakNextWord();
  }

  function detectLang(text) {
    const thaiChars = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
    const engChars = (text.match(/[a-zA-Z]/g) || []).length;
    if (thaiChars === 0 && engChars === 0) return 'th-TH'; // numbers/symbols → Thai voice
    return thaiChars >= engChars ? 'th-TH' : 'en-US';
  }

  function setupUtterance(utterance, element) {
    const lang = detectLang(utterance.text || '');
    utterance.lang = lang;
    utterance.rate = lang === 'th-TH' ? 0.8 : 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 0.9;

    const voices = speechSynthesis.getVoices();

    if (lang === 'th-TH') {
      const thaiVoice = voices.find(v =>
        v.lang === 'th-TH' ||
        v.lang === 'th' ||
        v.name.includes('Thai') ||
        v.name.includes('Kanya')
      );
      if (thaiVoice) utterance.voice = thaiVoice;
    } else {
      // Prefer a natural English voice; fall back to any en-US/en-GB voice
      const engVoice = voices.find(v =>
        v.lang === 'en-US' && (v.name.includes('Samantha') || v.name.includes('Google') || v.name.includes('Natural'))
      ) || voices.find(v => v.lang === 'en-US' || v.lang === 'en-GB' || v.lang.startsWith('en'));
      if (engVoice) utterance.voice = engVoice;
    }
  }

  function showMiniToast(text) {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '6px 12px',
      borderRadius: '20px', fontSize: '12px', fontFamily: 'sans-serif',
      zIndex: '2147483647', pointerEvents: 'none', whiteSpace: 'nowrap',
      maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis',
      backdropFilter: 'blur(4px)'
    });
    toast.textContent = text;
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 1500);
  }

  function speakTextOnHold(element) {
    if (!settings.enabled) return;
    if (!settings.doButtonHoldSpeech) return;
    if (!isCtrlPressed) return;

    const textToSpeak = getElementText(element);
    if (!textToSpeak || textToSpeak.length === 0) return;

    if (currentHoldTarget === element && lastSpokenHoldText === textToSpeak) {
      return;
    }

    currentHoldTarget = element;
    lastSpokenHoldText = textToSpeak;

    if (holdSpeechTimeout) clearTimeout(holdSpeechTimeout);

    holdSpeechTimeout = setTimeout(() => {
      speakWithHighlight(textToSpeak, element);
      showMiniToast('🔊 ' + textToSpeak.slice(0, 40));
    }, 150);
  }

  function handleF2Press() {
    if (!settings.enabled) return;
    if (!settings.doButtonHoldSpeech) return;

    const mouseX = window.event?.clientX || 0;
    const mouseY = window.event?.clientY || 0;
    const elementAtCursor = document.elementFromPoint(mouseX, mouseY);

    if (elementAtCursor) {
      let target = elementAtCursor;
      while (target && target !== document.body) {
        const text = getElementText(target);
        if (text && text.length > 0) {
          speakWithHighlight(text, target);
          showMiniToast('🔊 ' + text.slice(0, 40));
          break;
        }
        target = target.parentElement;
      }
    }
  }

  function showCtrlIndicator(show) {
    if (show) {
      if (!ctrlIndicator) {
        ctrlIndicator = document.createElement('div');
        ctrlIndicator.id = '__gazelink_ctrl_indicator__';
        Object.assign(ctrlIndicator.style, {
          position: 'fixed', bottom: '20px', left: '20px',
          background: 'rgba(168,85,247,0.9)', color: 'white',
          padding: '8px 16px', borderRadius: '8px',
          fontSize: '13px', fontFamily: 'monospace',
          zIndex: '2147483647', fontWeight: 'bold',
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          backdropFilter: 'blur(8px)',
          pointerEvents: 'none'
        });
        ctrlIndicator.textContent = '🔊 Hold Ctrl to read text';
        document.documentElement.appendChild(ctrlIndicator);
      }
      ctrlIndicator.style.display = 'block';
    } else {
      if (ctrlIndicator) {
        ctrlIndicator.style.display = 'none';
      }
    }
  }

  function handleKeyDown(e) {
    if (!settings.enabled) return;
    if (!settings.doButtonHoldSpeech) return;

    if (e.key === 'Control' || e.key === 'Ctrl') {
      if (!isCtrlPressed) {
        isCtrlPressed = true;
        showCtrlIndicator(true);
        document.body.style.cursor = 'help';
      }
    }

    // เพิ่มการพูดคีย์บอร์ด - ตรวจสอบ doKeyboardSpeech
    if (settings.doKeyboardSpeech && e.key !== 'Control' && e.key !== 'Ctrl') {
      // ไม่พูดปุ่ม Control 
      if (e.key === 'Control' || e.key === 'Ctrl') return;

      const currentKey = e.key;
      if (lastSpokenKey === currentKey) {
        if (keySpeechTimeout) clearTimeout(keySpeechTimeout);
        keySpeechTimeout = setTimeout(() => { lastSpokenKey = null; }, 200);
        return;
      }

      lastSpokenKey = currentKey;
      keySpeechTimeout = setTimeout(() => { lastSpokenKey = null; }, 500);

      const thaiName = getKeyNameThai(e.key, e.code);
      speakThai(thaiName);
    }
  }

  function handleKeyUp(e) {
    if (e.key === 'Control' || e.key === 'Ctrl') {
      isCtrlPressed = false;
      showCtrlIndicator(false);
      document.body.style.cursor = '';

      if (holdSpeechTimeout) {
        clearTimeout(holdSpeechTimeout);
        holdSpeechTimeout = null;
      }

      currentHoldTarget = null;
      lastSpokenHoldText = null;
    }
  }

  function handleMouseMoveForHold(e) {
    if (!settings.enabled) return;
    if (!settings.doButtonHoldSpeech) return;
    if (!isCtrlPressed) return;

    let target = e.target;

    while (target && target !== document.body) {
      const text = getElementText(target);
      if (text && text.length > 0) {
        speakTextOnHold(target);
        break;
      }
      target = target.parentElement;
    }
  }

  function startButtonHoldListener() {
    if (!settings.doButtonHoldSpeech) return;

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('mousemove', handleMouseMoveForHold);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault();
        handleF2Press();
      }
    });

    showNotification('💡 Hold Ctrl + hover to read with highlight | Press F2 to read at cursor');
  }

  function stopButtonHoldListener() {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keyup', handleKeyUp);
    document.removeEventListener('mousemove', handleMouseMoveForHold);

    if (holdSpeechTimeout) {
      clearTimeout(holdSpeechTimeout);
      holdSpeechTimeout = null;
    }

    if (ctrlIndicator) {
      ctrlIndicator.remove();
      ctrlIndicator = null;
    }

    currentHoldTarget = null;
    lastSpokenHoldText = null;
    isCtrlPressed = false;
    document.body.style.cursor = '';
    hideHighlight();
  }

  // ─── Message listener

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_WS_STATUS') {
      sendResponse({ connected: wsConnected });
      return false;
    }
    if (msg.type === 'SETTINGS_UPDATE') {
      settings = { ...settings, ...msg.settings };
      if (settings.enabled) {
        applyCursorSize()
        connectWS();
        showHUD();
        startHourlyBreakReminder();
        if (settings.doButtonHoldSpeech) {
          startButtonHoldListener();
        } else {
          stopButtonHoldListener();
        }


        // จัดการ Hourly Break Reminder
        if (settings.doHourlyBreak) {
          startHourlyBreakReminder();
        } else {
          stopHourlyBreakReminder();
        }

        // จัดการ Button Hold Speech
        if (settings.doButtonHoldSpeech) {
          startButtonHoldListener();
        } else {
          stopButtonHoldListener();
        }





      }
      else fullStop();
      if (settings.nightShift) startNightShiftWatch(); else stopNightShiftWatch();
    }
    if (msg.type === 'STOP_TRACKING') {
      settings.enabled = false;
      fullStop();
    }
    if (msg.type === 'NIGHT_SHIFT_UPDATE') {
      const { nightShift, nightShiftStart, nightShiftEnd, nightShiftWarmth, nightShiftBrightness } = msg;
      if (nightShift !== undefined) settings.nightShift = nightShift;
      if (nightShiftStart !== undefined) settings.nightShiftStart = nightShiftStart;
      if (nightShiftEnd !== undefined) settings.nightShiftEnd = nightShiftEnd;
      if (nightShiftWarmth !== undefined) settings.nightShiftWarmth = nightShiftWarmth;
      if (nightShiftBrightness !== undefined) settings.nightShiftBrightness = nightShiftBrightness;
      if (settings.nightShift) startNightShiftWatch(); else stopNightShiftWatch();
    }
  });












  ///////////////////////////////////////////mouse cursor size ///////////////////////////
  //// ─── Cursor size control ───────────────────────────────────────────────────────

  let cursorStyleElement = null;

  function applyCursorSize() {
    if (!settings.enabled) return;

    // ลบ cursor เก่า
    if (cursorStyleElement) {
      if (cursorStyleElement._mouseMoveHandler) {
        document.removeEventListener('mousemove', cursorStyleElement._mouseMoveHandler);
      }

      if (cursorStyleElement._styleElement) {
        cursorStyleElement._styleElement.remove();
      }

      cursorStyleElement.remove();
      cursorStyleElement = null;
    }

    if (!settings.cursorSize || settings.cursorSize <= 0 || !settings.enableCustomCursor) {
      return;
    }

    const customCursor = document.createElement('div');
    customCursor.id = '__gazelink_custom_cursor__';

    const size = settings.cursorSize;
    const color = settings.cursorColor;

    // SVG cursor
    const svg = `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path 
    d="M3 2 L3 22 L8 17 L11 23 L14 22 L11 16 L17 16 Z"
    fill="${color}"
    stroke="white"
    stroke-width="1.5"
    stroke-linejoin="round"
  />
</svg>
`;

    const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
    const svgUrl = URL.createObjectURL(svgBlob);

    // คำนวณ hotspot จากตำแหน่งปลายลูกศรใน SVG (3,2) ของ viewBox 24x24
    const hotspotX = (3 / 24) * size;
    const hotspotY = (2 / 24) * size;

    Object.assign(customCursor.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: size + 'px',
      height: size + 'px',
      background: `url('${svgUrl}') no-repeat center center`,
      backgroundSize: 'contain',
      pointerEvents: 'none',
      zIndex: '2147483647',

      // offset ให้ปลาย cursor ตรงตำแหน่งเมาส์จริง
      transform: `translate(${-hotspotX}px, ${-hotspotY}px)`,

      transition: 'transform 0.02s linear',
      display: 'none',
      filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.3))'
    });

    document.documentElement.appendChild(customCursor);

    // ซ่อน cursor จริง
    const style = document.createElement('style');
    style.textContent = `
    * {
      cursor: none !important;
    }
  `;
    document.documentElement.appendChild(style);

    // ติดตามเมาส์
    const mouseMoveHandler = (e) => {
      customCursor.style.left = e.clientX + 'px';
      customCursor.style.top = e.clientY + 'px';
      customCursor.style.display = 'block';
    };

    document.addEventListener('mousemove', mouseMoveHandler);

    // เก็บ reference สำหรับ cleanup
    customCursor._mouseMoveHandler = mouseMoveHandler;
    customCursor._styleElement = style;

    cursorStyleElement = customCursor;
  }

  function resetCursorSize() {
    if (cursorStyleElement) {
      // ลบ event listener
      if (cursorStyleElement._mouseMoveHandler) {
        document.removeEventListener('mousemove', cursorStyleElement._mouseMoveHandler);
      }
      // ลบ style ที่ซ่อน cursor
      if (cursorStyleElement._styleElement) {
        cursorStyleElement._styleElement.remove();
      }
      cursorStyleElement.remove();
      cursorStyleElement = null;
    }
  }

  function resetCursorSize() {
    if (cursorStyleElement) {
      cursorStyleElement.remove();
      cursorStyleElement = null;
    }
  }
  ////////////////////////////////////////////////////////











  // ─── Init ─────────────────────────────────────────────────────────────────────

  chrome.storage.local.get(['gazeSettings', 'gazelink_drowsy'], (result) => {
    if (result.gazeSettings) settings = { ...settings, ...result.gazeSettings };

    if (result.gazelink_drowsy) {
      drowsyCount = result.gazelink_drowsy.count ?? 0;
      currentBreakStage = result.gazelink_drowsy.stage ?? 0;
    }

    if (settings.enabled) {
      connectWS();
      showHUD();
      startHourlyBreakReminder();
      applyCursorSize();
      if (settings.doButtonHoldSpeech) {
        startButtonHoldListener();
      }
    }
    if (settings.nightShift) startNightShiftWatch();
  });

})();
