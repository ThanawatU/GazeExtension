"""
ws_server.py — GazeLink WebSocket Bridge Server
================================================
Run this alongside your Python WebEyeTrack demo.

    python ws_server.py

The demo connects as a "producer" and sends gaze JSON.
The Chrome extension background connects as a "consumer" and receives it.

Protocol (JSON messages over WebSocket):
  Producer → server:  { "role": "producer" }   (handshake)
  Consumer → server:  { "role": "consumer" }   (handshake)
  Producer → server:  { "type": "GAZE_RESULT", "data": { ... } }
  server   → all consumers: same message forwarded verbatim
"""

import asyncio
import json
import logging
import websockets
from websockets.server import WebSocketServerProtocol

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("gazelink")

HOST = "localhost"
PORT = 8765

producers: set[WebSocketServerProtocol] = set()
consumers: set[WebSocketServerProtocol] = set()


async def handler(ws: WebSocketServerProtocol):
    global producers, consumers
    role = None
    remote = ws.remote_address

    try:
        # ── Handshake: first message must declare role ──────────────────────
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        msg = json.loads(raw)
        role = msg.get("role")

        if role == "producer":
            producers.add(ws)
            log.info(f"Producer connected  {remote}  (total: {len(producers)})")
        elif role == "consumer":
            consumers.add(ws)
            log.info(f"Consumer connected  {remote}  (total: {len(consumers)})")
        else:
            log.warning(f"Unknown role '{role}' from {remote} — closing")
            await ws.close(1008, "unknown role")
            return

        # ── Main loop ───────────────────────────────────────────────────────
        async for raw in ws:
            if role == "producer":
                # Forward to all connected consumers
                # Test producer gaze results
            #     try:
            #     payload = json.loads(raw)
            #     log.info(f"GAZE PAYLOAD: {json.dumps(payload, indent=2)}")
            # except Exception:
            #     log.info(f"RAW MESSAGE: {raw}")
                if consumers:
                    dead = set()
                    for consumer in consumers:
                        try:
                            await consumer.send(raw)
                        except websockets.ConnectionClosed:
                            dead.add(consumer)
                    consumers -= dead
                    if dead:
                        log.info(f"Removed {len(dead)} dead consumer(s)")

    except asyncio.TimeoutError:
        log.warning(f"Handshake timeout from {remote}")
    except websockets.ConnectionClosedOK:
        pass
    except websockets.ConnectionClosedError as e:
        log.warning(f"Connection error from {remote}: {e}")
    except json.JSONDecodeError as e:
        log.warning(f"Bad JSON from {remote}: {e}")
    finally:
        if role == "producer":
            producers.discard(ws)
            log.info(f"Producer disconnected  {remote}  (total: {len(producers)})")
        elif role == "consumer":
            consumers.discard(ws)
            log.info(f"Consumer disconnected  {remote}  (total: {len(consumers)})")


async def main():
    log.info(f"GazeLink WS bridge starting on ws://{HOST}:{PORT}")
    async with websockets.serve(handler, HOST, PORT):
        log.info("Ready. Waiting for producer (demo) and consumers (extension)…")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Server stopped.")