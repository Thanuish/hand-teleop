"""Hand tracking on the server: the fallback for a candidate's computer that is too slow to track
the hand itself (TEST_TELEOP/web/hand/core.js, tracker 'server').

The browser sends camera pictures (JPEG, ~640 px wide) over a websocket, /s/<code>/track; each
binary message is [t: float64, the browser's clock in ms][the JPEG]. The server runs MediaPipe's
Hand Landmarker (the same model the browser runs) and answers each with JSON
{t, lm: 21 x {x, y}, wl: 21 x {x, y, z}, ms}: what core.js's HandControl._result takes, so
everything after it is the same. The pictures are processed in memory and never stored.

Each candidate using it gets a process of their own (the landmarker keeps track of the hand from
picture to picture), started on the first picture and stopped when the websocket closes. The
browser keeps at most two pictures on the way, so a slow server only lowers the frame rate.

    add_routes(app, has_worker)    the websocket route; has_worker(code): a live test run?
"""
from __future__ import annotations

import asyncio
import io
import json
import multiprocessing as mp
import struct
import time
import urllib.request
from pathlib import Path

from aiohttp import WSMsgType, web

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
MODEL = Path(__file__).resolve().parent.parent / "assets" / "models" / "hand_landmarker.task"
MAX_PICTURE = 2_000_000          # [bytes] a bigger message is refused


def ensure_model() -> Path:
    """The Hand Landmarker model, downloaded once (Docker images have it built in)."""
    if not MODEL.exists():
        MODEL.parent.mkdir(parents=True, exist_ok=True)
        tmp = MODEL.with_suffix(".part")
        urllib.request.urlretrieve(MODEL_URL, tmp)
        tmp.replace(MODEL)
    return MODEL


def _serve(conn, model: str, delegate: str):
    """The tracker process: pictures in, landmarks out, until None (or the pipe closes)."""
    import numpy as np
    from PIL import Image
    import mediapipe as mpipe
    from mediapipe.tasks.python import BaseOptions, vision

    opts = vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model,
                                 delegate=BaseOptions.Delegate.GPU if delegate == "gpu" else BaseOptions.Delegate.CPU),
        running_mode=vision.RunningMode.VIDEO, num_hands=1,
        min_hand_detection_confidence=0.5, min_hand_presence_confidence=0.4, min_tracking_confidence=0.4)
    lmk = vision.HandLandmarker.create_from_options(opts)
    last_ts = -1
    while True:
        try:
            msg = conn.recv()
        except EOFError:
            break
        if msg is None:
            break
        t, jpeg = msg
        t0 = time.perf_counter()
        try:
            rgb = np.asarray(Image.open(io.BytesIO(jpeg)).convert("RGB"))
            ts = max(last_ts + 1, int(t))                   # (the model wants rising timestamps, in ms)
            last_ts = ts
            r = lmk.detect_for_video(mpipe.Image(image_format=mpipe.ImageFormat.SRGB, data=rgb), ts)
            if r.hand_landmarks:
                lm = [{"x": p.x, "y": p.y} for p in r.hand_landmarks[0]]
                wl = [{"x": p.x, "y": p.y, "z": p.z} for p in r.hand_world_landmarks[0]]
            else:
                lm = wl = None
            conn.send({"t": t, "lm": lm, "wl": wl, "ms": round((time.perf_counter() - t0) * 1000, 1)})
        except Exception as e:                                  # (a broken picture: no hand this time)
            conn.send({"t": t, "lm": None, "wl": None, "error": str(e)[:200]})
    lmk.close()


class Tracker:
    """One candidate's tracker process."""

    def __init__(self, delegate: str = "cpu"):
        ctx = mp.get_context("spawn")
        self.conn, child = ctx.Pipe()
        self.proc = ctx.Process(target=_serve, args=(child, str(ensure_model()), delegate), daemon=True)
        self.proc.start()
        child.close()
        self.lock = asyncio.Lock()

    async def track(self, t: float, jpeg: bytes) -> dict:
        async with self.lock:                                   # (one picture at a time through the pipe)
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self.conn.send, (t, jpeg))
            return await loop.run_in_executor(None, self.conn.recv)

    def stop(self):
        try:
            self.conn.send(None)
        except (OSError, BrokenPipeError):
            pass
        self.proc.join(timeout=3)
        if self.proc.is_alive():
            self.proc.kill()


def add_routes(app: web.Application, has_worker, delegate: str = "cpu"):
    """/s/{code}/track: the websocket for a test run's server-side tracking."""

    async def track_ws(request):
        code = request.match_info["code"]
        if not has_worker(code):
            raise web.HTTPNotFound()
        ws = web.WebSocketResponse(heartbeat=15, max_msg_size=MAX_PICTURE)
        await ws.prepare(request)
        tracker = None
        try:
            async for msg in ws:
                if msg.type != WSMsgType.BINARY or len(msg.data) < 9:
                    continue
                if tracker is None:
                    tracker = await asyncio.get_running_loop().run_in_executor(None, Tracker, delegate)
                (t,) = struct.unpack("<d", msg.data[:8])
                res = await tracker.track(t, bytes(msg.data[8:]))
                await ws.send_str(json.dumps(res))
        finally:
            if tracker is not None:
                await asyncio.get_running_loop().run_in_executor(None, tracker.stop)
        return ws

    app.router.add_get("/s/{code}/track", track_ws)
