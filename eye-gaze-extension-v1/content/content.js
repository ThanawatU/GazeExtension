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
    glowColor: '#a855f7',
    showGazeDot: true,
    nightShift: false,
    nightShiftWarmth: 30,
    nightShiftBrightness: 95,
    nightShiftStart: '20:00',
    nightShiftEnd: '07:00',
    doTextToSpeech: true,
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
  // Thresholds in "drowsy frames received". At 25fps with ~50% drowsy detection
  // rate, stage1≈12s, stage2≈24s, stage3≈42s. Tune these to taste.

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




    // ไม่พูดถ้าเป็น Alt (เพราะ Alt มี function ของมันอยู่)
    if (e.key === 'Alt') return;
    if (!settings.enabled) return;

    // ป้องกันการพูดซ้ำถ้ากดค้าง
    const currentKey = e.key;
    if (lastSpokenKey === currentKey) {
      if (keySpeechTimeout) clearTimeout(keySpeechTimeout);
      keySpeechTimeout = setTimeout(() => { lastSpokenKey = null; }, 200);
      return;
    }

    lastSpokenKey = currentKey;
    keySpeechTimeout = setTimeout(() => { lastSpokenKey = null; }, 500);

    // อ่านเสียง - จะยกเลิกเสียงเก่าและพูดใหม่ทันที
    const thaiName = getKeyNameThai(e.key, e.code);
    speakThai(thaiName);







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















    // TTS: อ่านข้อความเมื่อเริ่มจ้อง
    if (settings.doTextToSpeech) {
      speakGazeText(el);
    }

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





    // ยกเลิก TTS ที่ค้างอยู่ (ไม่จำเป็นต้องพูดข้อความเดิมอีก)
    if (gazeSpeechTimeout) {
      clearTimeout(gazeSpeechTimeout);
      gazeSpeechTimeout = null;
    }

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
      // Final stage — user acknowledged, full reset
      drowsyCount = 0;
      currentBreakStage = 0;
    }
    // Stages 1 & 2: do nothing — count stays where it is and
    // keeps climbing toward the next stage naturally.

    updateDrowsyOverlay();
    saveDrowsyState();
  }

  // ─── Drowsiness handler ───────────────────────────────────────────────────────

  function handleDrowsy(isDrowsy) {
    if (!isDrowsy) return;
    if (breakScreenVisible) return; // don't keep counting while break screen is shown
    drowsyCount++;
    updateDrowsyOverlay();
    saveDrowsyState();

    if (drowsyCount >= DROWSY_STAGE_3 && currentBreakStage < 3) { currentBreakStage = 3; showBreakScreen(3); }
    else if (drowsyCount >= DROWSY_STAGE_2 && currentBreakStage < 2) { currentBreakStage = 2; showBreakScreen(2); }
    else if (drowsyCount >= DROWSY_STAGE_1 && currentBreakStage < 1) { currentBreakStage = 1; showBreakScreen(1); }
  }

  // ─── Calibration ─────────────────────────────────────────────────────────────

  // function setupCalibration() {
  //   const grid = 3, points = [];
  //   for (let i = 0; i < grid; i++)
  //     for (let j = 0; j < grid; j++)
  //       points.push([i / (grid - 1), j / (grid - 1)]);

  //   let index = 0, sampleCount = 0;
  //   const maxSamples = 5;

  //   const calDot = document.createElement('div');
  //   Object.assign(calDot.style, {
  //     position: 'fixed', width: '40px', height: '40px', borderRadius: '50%',
  //     background: settings.glowColor, zIndex: '2147483647', cursor: 'pointer',
  //     transition: 'all 0.2s ease', boxShadow: `0 0 16px 4px ${settings.glowColor}`,
  //   });
  //   const calLabel = document.createElement('div');
  //   Object.assign(calLabel.style, {
  //     position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
  //     color: 'white', fontFamily: 'monospace', fontSize: '14px', zIndex: '2147483647',
  //     background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: '8px', pointerEvents: 'none',
  //   });
  //   calLabel.textContent = 'Click each dot to calibrate (5 clicks each)';
  //   document.documentElement.appendChild(calLabel);
  //   document.documentElement.appendChild(calDot);

  //   function showNext() {
  //     if (index >= points.length) { calDot.remove(); calLabel.remove(); showNotification('✅ Calibration complete!'); return; }
  //     const [px, py] = points[index];
  //     calDot.style.left = (px * (window.innerWidth - 40)) + 'px';
  //     calDot.style.top  = (py * (window.innerHeight - 40)) + 'px';
  //     sampleCount = 0;
  //   }
  //   calDot.addEventListener('click', () => {
  //     sampleCount++;
  //     calDot.style.background = sampleCount % 2 === 0 ? settings.glowColor : '#fff';
  //     calLabel.textContent = `Point ${index + 1}/${points.length} — click ${maxSamples - sampleCount} more`;
  //     if (sampleCount >= maxSamples) { index++; showNext(); }
  //   });
  //   showNext();
  // }

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
  }






  ////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // ─── Hourly Break Reminder ─────────────────────────────────────────────────────────

  let lastBreakReminder = null;
  let breakReminderInterval = null;
  let breakReminderScreenVisible = false;
  const ONE_HOUR_MS = 60 * 60 * 1000; // 1 ชั่วโมงเป็นมิลลิวินาที

  // สร้าง element สำหรับเตือนพัก
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
      You've been using the screen for 1 hour continuously.
    </p>
    <p style="color:#666;font-size:12px;line-height:1.6;margin-bottom:32px">
      Give your eyes a 5-minute break. Look away from the screen and rest your eyes. 👁️
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
      // Snooze: reset timer ให้เริ่มนับใหม่หลังจาก 15 นาที
      if (breakReminderInterval) clearInterval(breakReminderInterval);
      lastBreakReminder = Date.now();
      breakReminderInterval = setInterval(() => {
        checkHourlyBreak();
      }, 60000); // ตรวจสอบทุกนาที
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
    if (breakScreenVisible) return; // ไม่เตือนซ้ำถ้ากำลังแสดง break screen จากการ drowsy

    const now = Date.now();
    if (!lastBreakReminder) {
      lastBreakReminder = now;
      return;
    }

    if (now - lastBreakReminder >= ONE_HOUR_MS) {
      showHourBreakReminder();
      lastBreakReminder = now; // reset หลังจากแสดงเตือน
    }
  }

  function startHourlyBreakReminder() {
    if (breakReminderInterval) clearInterval(breakReminderInterval);
    lastBreakReminder = Date.now(); // reset timer เมื่อเริ่มใช้งาน
    breakReminderInterval = setInterval(() => {
      checkHourlyBreak();
    }, 60000); // ตรวจสอบทุกนาที
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

  ////////////////////////////////////////////////////////////////////////////////////////////////////////////



  ////////////////////////////////////////////////////////////////////
  // ─── Keyboard speech (Thai voice) ──────────────────────────────────────────────

  let lastSpokenKey = null;
  let keySpeechTimeout = null;




  let lastSpokenText = null;
  let gazeSpeechTimeout = null;
  let isSpeakingGazeText = false;

  function speakThai(text) {
    if (!settings.enabled) return;

    // ยกเลิกการพูดที่กำลังดำเนินอยู่ทันที
    speechSynthesis.cancel();

    // สร้าง utterance ใหม่
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'th-TH';
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    utterance.volume = 0.8;

    // พยายามเลือกเสียงภาษาไทย
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

    // ถ้า voices โหลดแล้ว ให้ใช้เลย ถ้ายังให้รอ
    if (speechSynthesis.getVoices().length > 0) {
      setVoice();
    } else {
      speechSynthesis.onvoiceschanged = setVoice;
    }
  }

  // แปลงชื่อคีย์เป็นภาษาไทย
  function getKeyNameThai(key, code) {
    // ตัวอักษร A-Z
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

    // ตัวเลข
    if (/[0-9]/.test(key)) {
      const numMap = {
        '0': 'ศูนย์', '1': 'หนึ่ง', '2': 'สอง', '3': 'สาม', '4': 'สี่',
        '5': 'ห้า', '6': 'หก', '7': 'เจ็ด', '8': 'แปด', '9': 'เก้า'
      };
      return numMap[key] || key;
    }

    // ปุ่มพิเศษ
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




  // ฟังก์ชันอ่านข้อความจาก element ที่ gaze
  function speakGazeText(element) {
    if (!settings.enabled) return;
    if (!settings.doTextToSpeech) return; // ต้องเปิด setting นี้ก่อน

    // ดึงข้อความจาก element
    let textToSpeak = '';

    // ลำดับการดึงข้อความ: data-gazelink-speech > title > alt > aria-label > textContent
    if (element.hasAttribute('data-gazelink-speech')) {
      textToSpeak = element.getAttribute('data-gazelink-speech');
    } else if (element.hasAttribute('title')) {
      textToSpeak = element.getAttribute('title');
    } else if (element.hasAttribute('alt')) {
      textToSpeak = element.getAttribute('alt');
    } else if (element.hasAttribute('aria-label')) {
      textToSpeak = element.getAttribute('aria-label');
    } else {
      // ดึงข้อความภายใน element (แต่จำกัดความยาว)
      let rawText = element.textContent || element.innerText || '';
      textToSpeak = rawText.trim().slice(0, 100); // จำกัด 100 ตัวอักษร
    }

    if (!textToSpeak || textToSpeak.length === 0) return;

    // ป้องกันการพูดข้อความเดิมซ้ำ
    if (lastSpokenText === textToSpeak) {
      // ถ้าเป็นข้อความเดิม ให้พูดแค่ครั้งเดียว
      return;
    }

    lastSpokenText = textToSpeak;

    // หน่วงเวลาก่อนพูด เพื่อให้แน่ใจว่า gaze จริงๆ
    if (gazeSpeechTimeout) clearTimeout(gazeSpeechTimeout);

    gazeSpeechTimeout = setTimeout(() => {
      // ยกเลิกการพูดที่กำลังดำเนินอยู่
      if (isSpeakingGazeText) {
        speechSynthesis.cancel();
      }

      isSpeakingGazeText = true;

      const utterance = new SpeechSynthesisUtterance(textToSpeak);
      utterance.lang = 'th-TH';
      utterance.rate = 0.85;
      utterance.pitch = 1.0;

      // เลือกเสียงภาษาไทย
      const voices = speechSynthesis.getVoices();
      const thaiVoice = voices.find(voice =>
        voice.lang === 'th-TH' ||
        voice.lang === 'th' ||
        voice.name.includes('Thai') ||
        voice.name.includes('Kanya')
      );
      if (thaiVoice) utterance.voice = thaiVoice;

      utterance.onend = () => {
        isSpeakingGazeText = false;
        // ล้างข้อความจำหลังจากพูดจบ 2 วินาที
        setTimeout(() => {
          if (lastSpokenText === textToSpeak) {
            lastSpokenText = null;
          }
        }, 2000);
      };

      utterance.onerror = () => {
        isSpeakingGazeText = false;
      };

      speechSynthesis.speak(utterance);
    }, 400); // หน่วง 400ms ก่อนพูด
  }
  ////////////////////////////////////////////////////////////












  // ─── Message listener (popup → content) ──────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_WS_STATUS') {
      sendResponse({ connected: wsConnected });
      return false;
    }
    if (msg.type === 'SETTINGS_UPDATE') {
      settings = { ...settings, ...msg.settings };
      if (settings.enabled) { connectWS(); showHUD(); startHourlyBreakReminder(); }
      else fullStop();
      if (settings.nightShift) startNightShiftWatch(); else stopNightShiftWatch();
    }
    if (msg.type === 'STOP_TRACKING') {
      settings.enabled = false;
      fullStop();
    }
    if (msg.type === 'CALIBRATE') {
      setupCalibration();
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

  // ─── Init ─────────────────────────────────────────────────────────────────────

  chrome.storage.local.get(['gazeSettings', 'gazelink_drowsy'], (result) => {
    if (result.gazeSettings) settings = { ...settings, ...result.gazeSettings };

    if (result.gazelink_drowsy) {
      drowsyCount = result.gazelink_drowsy.count ?? 0;
      currentBreakStage = result.gazelink_drowsy.stage ?? 0;
    }

    if (settings.enabled) { connectWS(); showHUD(); startHourlyBreakReminder(); }
    if (settings.nightShift) startNightShiftWatch();
  });

})();
