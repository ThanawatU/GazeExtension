"""
ws_bridge.py — Drop-in gaze broadcaster for your WebEyeTrack demo
==================================================================
Import this in your demo's main.py and call start_bridge() once.
Then wrap your onGazeResults callback with send_gaze().

Usage in main.py:
─────────────────
    from ws_bridge import start_bridge, send_gaze

    # Call once at startup (non-blocking — runs in background thread)
    start_bridge()

    # Inside your existing gaze callback:
    def my_gaze_callback(gaze_result):
        send_gaze(gaze_result)          # ← add this line
        # ... rest of your existing code unchanged

GazeResult fields used (adjust attribute names to match your actual object):
    gaze_result.norm_pos      → [x, y]  normalised POG  (−0.5 … +0.5)
    gaze_result.state         → str     e.g. "open" / "closed"
    gaze_result.head_vector   → [x,y,z] optional
    gaze_result.timestamp     → float   optional
"""

import asyncio
import json
import logging
import threading
import time

import websockets

WS_URL = "ws://localhost:8765"
log = logging.getLogger("gazelink.bridge")

_loop: asyncio.AbstractEventLoop | None = None
_ws = None
_lock = threading.Lock()
_reconnect_delay = 2  # seconds between reconnect attempts


# ── Internal async worker ────────────────────────────────────────────────────

async def _run():
    global _ws
    while True:
        try:
            async with websockets.connect(WS_URL) as ws:
                # Identify as producer
                await ws.send(json.dumps({"role": "producer"}))
                log.info(f"ws_bridge connected to {WS_URL}")
                _ws = ws
                # Keep alive — ws_server will detect close
                await ws.wait_closed()
        except Exception as e:
            log.warning(f"ws_bridge: connection failed ({e}), retrying in {_reconnect_delay}s…")
        finally:
            _ws = None
        await asyncio.sleep(_reconnect_delay)


def _thread_main():
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    _loop.run_until_complete(_run())


# ── Public API ───────────────────────────────────────────────────────────────

def start_bridge():
    """Start the background WebSocket thread. Call once at startup."""
    t = threading.Thread(target=_thread_main, daemon=True, name="gazelink-ws")
    t.start()
    log.info("ws_bridge thread started")


def send_gaze(gaze_result):
    """
    Send a gaze result to all connected Chrome extension consumers.
    Safe to call from any thread (including the GUI/tracker thread).
    
    Adapt the attribute names below to match your actual GazeResult object.
    """
    global _ws, _loop
    if _ws is None or _loop is None:
        return  # Not connected yet — silently drop

    # ── Build payload ────────────────────────────────────────────────────────
    # Adjust these attribute names to match your GazeResult dataclass/object:
    try:
        norm_pos = list(gaze_result.norm_pos)          # [x, y]
    except AttributeError:
        norm_pos = [0.0, 0.0]

    try:
        state = gaze_result.state                       # "open" / "closed"
    except AttributeError:
        state = "open"

    try:
        head_vector = list(gaze_result.head_vector)     # [x, y, z]
    except AttributeError:
        head_vector = [0.0, 0.0, 0.0]

    try:
        timestamp = float(gaze_result.timestamp)
    except AttributeError:
        timestamp = time.time()

    payload = json.dumps({
        "type": "GAZE_RESULT",
        "data": {
            "normPog": norm_pos,
            "gazeState": state,
            "headVector": head_vector,
            "timestamp": timestamp,
        }
    })

    # ── Fire-and-forget onto the async loop ─────────────────────────────────
    try:
        asyncio.run_coroutine_threadsafe(_ws.send(payload), _loop)
    except Exception as e:
        log.debug(f"ws_bridge send error: {e}")