"""The screening lobby: the one web server candidates connect to (through a tunnel such as
Cloudflare Tunnel for remote candidates). One public link: a candidate enters name + email and
agrees to the recording, once per email. It runs one simulator per candidate
(TEST_TELEOP.worker --task screen, on a local port), relays the candidate's monitor page and
phone to it, and shows the results to you.

    python -m TEST_TELEOP.lobby serve --tunnel             # start (or: start_screening.bat)

Candidate:  /                 name + email, consent (one attempt per email; a cookie lets the
                              same browser come back to a test in progress)
            /play/<code>      the monitor page: the robot, the instructions, a QR code
            /m/<code>         the phone controller (Chrome on Android, WebXR motion tracking)
You:        /admin            results, ranking, pass / fail, allow a retake (this PC only)
            /t/<token>        a test run of your own (link on the admin page)

The test itself (phases, objects, scoring, pass mark): config/screening.toml (see
TEST_TELEOP/config.py). Data: data/screening/screening.db (SQLite: one row per attempt with its
hidden code, email, name, status),
data/screening/settings.json (how many at a time, idle timeout), and per candidate
data/screening/<batch>/<code>/screen/attempt/ (results.json, the configuration it ran with,
one episode file per phase, the simulator's log).
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import html
import io
import json
import os
import secrets
import re
import socket
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path

import aiohttp
from aiohttp import WSMsgType, web

from vrteleop import scene as S

from . import config as C
from . import recommend as R
from . import tracker

ROOT = S.ROOT
WEB_DIR = ROOT / "vrteleop" / "web"                  # the 3D viewer (main.js) and three.js
TEST_WEB = Path(__file__).resolve().parent / "web"   # this test's pages
DATA = ROOT / "data" / "screening"
CANDIDATES = DATA / "candidates.json"                 # (before the database: moved into it once)
DB = DATA / "screening.db"
SETTINGS = DATA / "settings.json"
# accepting: new candidates may start (off: "closed for a short update", for a deploy: tests
# already running go on). The environment can set the starting values (a container: MAX_CONCURRENT)
DEFAULT_SETTINGS = {"max_concurrent": int(os.environ.get("MAX_CONCURRENT", 15)), "idle_timeout_min": 20, "accepting": True}
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"     # no 0/O, 1/I


# ---------------------------------------------------------------- storage
def set_data_dir(path: Path):
    global DATA, CANDIDATES, DB, SETTINGS
    DATA = path.resolve()
    CANDIDATES = DATA / "candidates.json"
    DB = DATA / "screening.db"
    SETTINGS = DATA / "settings.json"


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _load(path: Path, default):
    try:                        # utf-8-sig: also files saved by Notepad / PowerShell (with a BOM)
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        print(f"[lobby] can't read {path}: {e}")
        return default


def _save(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    tmp.replace(path)


def settings() -> dict:
    st = _load(SETTINGS, {})
    return {k: st.get(k, v) for k, v in DEFAULT_SETTINGS.items()}


def cfg() -> C.Config:
    """The test's configuration (read again when the file changes). If it was edited into a
    broken state, the last good one is used and the problems are shown on the admin page."""
    try:
        c = C.cached()
        _cfg_state.update(good=c, error=None)
    except C.ConfigError as e:
        if _cfg_state["error"] != str(e):
            print(f"[lobby] {e}")
        _cfg_state["error"] = str(e)
        if _cfg_state["good"] is None:
            raise
    return _cfg_state["good"]


_cfg_state = {"good": None, "error": None}


FIELDS = ("email", "name", "batch", "created", "status", "started", "finished", "only")
_db_ready: set[Path] = set()


def _db() -> sqlite3.Connection:
    """The candidates database (one row per attempt; the code is the attempt's hidden id). Made,
    and an old candidates.json moved into it, the first time it is opened."""
    first = DB not in _db_ready
    if first:
        DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=10)
    con.row_factory = sqlite3.Row
    if first:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript("""
            CREATE TABLE IF NOT EXISTS candidates (
                code TEXT PRIMARY KEY, email TEXT, name TEXT NOT NULL DEFAULT '', batch TEXT NOT NULL,
                created TEXT, status TEXT NOT NULL, started TEXT, finished TEXT, only TEXT);
            CREATE INDEX IF NOT EXISTS candidates_email ON candidates(email);
            -- one attempt per email; an admin's "Allow retake" marks the old one 'reset'
            CREATE UNIQUE INDEX IF NOT EXISTS candidates_email_live ON candidates(email)
                WHERE email IS NOT NULL AND status != 'reset';
            -- the people invited (imported from Ashby on the admin page): matched to attempts by email
            CREATE TABLE IF NOT EXISTS invites (
                email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', job TEXT NOT NULL DEFAULT '',
                invited_at TEXT, imported_at TEXT);""")
        _migrate_json(con)
        _db_ready.add(DB)
    return con


def _migrate_json(con: sqlite3.Connection):
    """The invite-code era kept candidates in candidates.json: copy them in once, keep the file
    as candidates.json.bak."""
    if not CANDIDATES.exists():
        return
    old = _load(CANDIDATES, None)
    if not isinstance(old, dict):
        return
    with con:
        for code, c in old.items():
            con.execute("INSERT OR IGNORE INTO candidates (code, email, name, batch, created, status, started, "
                        "finished, only) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)",
                        (code, c.get("name") or "", c.get("batch") or "batch", c.get("created"),
                         c.get("status") or "new", c.get("started"), c.get("finished"), c.get("only")))
    CANDIDATES.replace(CANDIDATES.with_name("candidates.json.bak"))
    print(f"[lobby] moved {len(old)} candidates from {_rel(CANDIDATES)} into {_rel(DB)} (old file: candidates.json.bak)")


def candidates() -> dict:
    """code -> record (email, name, batch, created, status, started, finished, only)."""
    with closing(_db()) as con:
        return {r["code"]: {k: r[k] for k in FIELDS} for r in con.execute("SELECT * FROM candidates ORDER BY created")}


def candidate(code: str) -> dict | None:
    with closing(_db()) as con:
        r = con.execute("SELECT * FROM candidates WHERE code = ?", (code,)).fetchone()
    return {k: r[k] for k in FIELDS} if r else None


def attempt_of(email: str) -> tuple[str, dict] | None:
    """The email's current attempt (not one an admin reset), if any."""
    with closing(_db()) as con:
        r = con.execute("SELECT * FROM candidates WHERE email = ? AND status != 'reset'", (email,)).fetchone()
    return (r["code"], {k: r[k] for k in FIELDS}) if r else None


def update_candidate(code: str, **fields):
    assert set(fields) <= set(FIELDS)
    with closing(_db()) as con, con:
        con.execute(f"UPDATE candidates SET {', '.join(f'{k} = ?' for k in fields)} WHERE code = ?",
                    (*fields.values(), code))


def delete_candidate(code: str):
    with closing(_db()) as con, con:
        con.execute("DELETE FROM candidates WHERE code = ?", (code,))


def new_candidate(batch: str, name: str = "", email: str | None = None, only: str | None = None,
                  status: str = "playing") -> str:
    """A new attempt with a fresh hidden code. only: a phase key (e.g. "tilt"): a test run of just
    that part. Raises sqlite3.IntegrityError if the email already has an attempt."""
    if only and only not in [p.key for p in cfg().task_phases]:
        raise ValueError(f"no task phase '{only}'")
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with closing(_db()) as con, con:
        while True:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
            if con.execute("SELECT 1 FROM candidates WHERE code = ?", (code,)).fetchone() is None:
                break
        con.execute("INSERT INTO candidates (code, email, name, batch, created, status, started, finished, only) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                    (code, email, name, batch, now, status, now if status == "playing" else None, only or None))
    return code


def invites() -> dict:
    """email -> {name, job, invited_at, imported_at}."""
    with closing(_db()) as con:
        return {r["email"]: dict(name=r["name"], job=r["job"], invited_at=r["invited_at"], imported_at=r["imported_at"])
                for r in con.execute("SELECT * FROM invites")}


def save_invites(people: list[dict]) -> tuple[int, int]:
    """Add or update invited people (email, name, job, invited_at). Returns (added, updated)."""
    now = time.strftime("%Y-%m-%d %H:%M")
    added = updated = 0
    with closing(_db()) as con, con:
        for p in people:
            old = con.execute("SELECT 1 FROM invites WHERE email = ?", (p["email"],)).fetchone()
            con.execute("INSERT INTO invites (email, name, job, invited_at, imported_at) VALUES (?, ?, ?, ?, ?) "
                        "ON CONFLICT(email) DO UPDATE SET name = excluded.name, job = excluded.job, "
                        "invited_at = excluded.invited_at, imported_at = excluded.imported_at",
                        (p["email"], p.get("name", ""), p.get("job", ""), p.get("invited_at"), now))
            added += old is None
            updated += old is not None
    return added, updated


def delete_invite(email: str):
    with closing(_db()) as con, con:
        con.execute("DELETE FROM invites WHERE email = ?", (email,))


_DATE_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ",
                 "%Y-%m-%d", "%d.%m.%Y %H:%M", "%d.%m.%Y", "%d/%m/%Y %H:%M", "%d/%m/%Y", "%m/%d/%Y %H:%M", "%m/%d/%Y",
                 "%b %d, %Y", "%d %b %Y", "%B %d, %Y")


def _date(s: str) -> str | None:
    """A date as Ashby (or a person) writes it -> 'YYYY-MM-DD HH:MM'; None if it isn't one."""
    import datetime as dt
    s = (s or "").strip()
    for f in _DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, f).strftime("%Y-%m-%d %H:%M")
        except ValueError:
            pass
    return None


def parse_invites(text: str) -> tuple[list[dict], list[str]]:
    """People from a pasted list or an Ashby CSV export: one per line, comma / tab / semicolon
    separated. With a header row, its columns are found by name (name / first + last name,
    email, a date: invited / sent / date, job / role / position); without one, the email is
    whatever looks like one, the date whatever parses as one, the name the first other cell.
    Returns (people, problems)."""
    lines = [l for l in text.replace("\r\n", "\n").split("\n") if l.strip()]
    if not lines:
        return [], ["Nothing to import."]
    try:
        dialect = csv.Sniffer().sniff("\n".join(lines[:20]), delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(lines, dialect))
    head = [h.strip().lower() for h in rows[0]]
    # (a header word at a word's start: "Candidate Name" is no date column)
    col = lambda *words: next((i for i, h in enumerate(head) if any(re.search(r"\b" + w, h) for w in words)), None)
    has_header = not any(EMAIL_RE.fullmatch(c.strip().lower()) for c in rows[0]) and col("email", "e-mail", "mail") is not None
    people, problems, seen = [], [], set()
    if has_header:
        ie, i_name, i_first, i_last = col("email", "e-mail", "mail"), col("full name", "candidate name"), col("first"), col("last")
        i_name = i_name if i_name is not None else next((i for i, h in enumerate(head) if h == "name"), None)
        i_date, i_job = col("invit", "sent", "date", "created", "activity", "applied"), col("job", "role", "position", "posting")
    else:                                   # (a pasted list: each line split on its own, tabs, commas or semicolons)
        rows = [re.split(r"[\t;,]", l) for l in lines]
    for n, r in enumerate(rows[1:] if has_header else rows, start=2 if has_header else 1):
        cells = [c.strip() for c in r]
        get = lambda i: cells[i] if i is not None and i < len(cells) else ""
        if has_header:
            email = get(ie).lower()
            name = get(i_name) or " ".join(x for x in (get(i_first), get(i_last)) if x)
            when, job = _date(get(i_date)), get(i_job)
        else:
            email = next((c.lower() for c in cells if EMAIL_RE.fullmatch(c.lower())), "")
            others = [c for c in cells if c.lower() != email]
            when = next((d for d in map(_date, others) if d), None)
            name = next((c for c in others if c and not _date(c)), "")
            job = ""
        if not EMAIL_RE.fullmatch(email):
            problems.append(f"line {n}: no email address")
            continue
        if email in seen:
            continue
        seen.add(email)
        people.append(dict(email=email, name=" ".join(name.split())[:80], job=job[:80],
                           invited_at=when or time.strftime("%Y-%m-%d %H:%M")))
    return people, problems


def test_token() -> str:
    """The secret of the permanent test link (/t/<token>), kept in the data folder (never in the
    repo), made the first time it is needed."""
    path = DATA / "test_link.json"
    tok = _load(path, {}).get("token")
    if not tok:
        tok = secrets.token_urlsafe(12)
        DATA.mkdir(parents=True, exist_ok=True)
        _save(path, {"token": tok})
    return tok


def session_dir(code: str, c: dict) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "-_ " else "_" for ch in c["batch"]).strip() or "batch"
    return DATA / safe / code


def results_of(code: str, c: dict) -> dict | None:
    p = session_dir(code, c) / "screen" / "attempt" / "results.json"
    return _load(p, None)


def passed(res: dict | None) -> bool | None:
    """Overall >= the pass mark and every must_complete phase completed (config [scoring])."""
    if not res or not res.get("finished") or res.get("only"):     # (a test of one part: no verdict)
        return None
    sc, c = res.get("scores", {}), cfg()
    ok = sc.get("overall", 0) >= c.scoring["pass_mark"]
    for k in c.scoring["must_complete"]:
        ok = ok and bool(res.get("metrics", {}).get(k, {}).get("completed"))
    return ok


# ---------------------------------------------------------------- tunnel
def tunnel_file() -> Path:
    """Where a separate tunnel process writes its public address (DATA can change: --data)."""
    return DATA / "tunnel.json"


def open_tunnel(port: int):
    """Start a Cloudflare quick tunnel to the lobby: a public https:// address, no account
    needed. A quick tunnel gets a new random address every time it starts, so it runs on while
    the lobby restarts (`python -m TEST_TELEOP.lobby tunnel` in its own window)."""
    import shutil
    exe = shutil.which("cloudflared")
    if exe is None:
        print("  [tunnel] cloudflared not found. Install it:  winget install Cloudflare.cloudflared")
        return None
    return subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", f"http://localhost:{port}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")


def watch_tunnel(proc, on_url):
    """Read cloudflared's log until it ends; report the public address once it appears."""
    import re
    seen = False
    for line in proc.stderr:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m and not seen:
            seen = True
            on_url(m.group(0))
            print(f"\n  [tunnel] candidates open:  {m.group(0)}\n", flush=True)


def run_tunnel(port: int):
    """The tunnel as its own process: writes its address to data/screening/tunnel.json, which the
    lobby shows; the lobby can then be restarted without the address changing."""
    proc = open_tunnel(port)
    if proc is None:
        sys.exit(1)
    try:
        watch_tunnel(proc, lambda u: _save(tunnel_file(), {"url": u, "since": time.strftime("%Y-%m-%d %H:%M:%S")}))
    finally:
        proc.terminate()
        tunnel_file().unlink(missing_ok=True)


# ---------------------------------------------------------------- workers
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Worker:
    """One simulator process (TEST_TELEOP.worker --task screen) for one candidate."""

    def __init__(self, code: str, c: dict):
        self.code = code
        self.port = _free_port()
        self.dir = session_dir(code, c)
        self.dir.mkdir(parents=True, exist_ok=True)
        log = open(self.dir / "simulator.log", "ab")
        env = dict(os.environ, SCREEN_ONLY=c.get("only") or "")      # a test code: one part only
        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "TEST_TELEOP.worker", "--http", "--host", "127.0.0.1",
             "--port", str(self.port), "--task", "screen", "--no-preview", "--stream-cams", "",
             # 60 pose updates a second (~100 KB/s per candidate): less delay on top of the
             # internet's (the monitor shows the arm one update behind, interpolated)
             "--stream-hz", "60", "--data-dir", str(self.dir), "--session", "attempt",
             "--operator", c.get("name") or code, "--exit-when-idle", "25"],
            cwd=str(ROOT), stdout=log, stderr=subprocess.STDOUT, env=env)
        self.clients = 0
        self.last_seen = time.time()
        self.started = time.time()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def alive(self) -> bool:
        return self.proc.poll() is None

    async def ready(self, session: aiohttp.ClientSession, timeout=60.0) -> bool:
        t_end = time.time() + timeout
        while time.time() < t_end and self.alive():
            try:
                async with session.get(self.url + "/api/status", timeout=aiohttp.ClientTimeout(total=2)) as r:
                    if r.status == 200:
                        return True
            except (aiohttp.ClientError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(0.5)
        return False

    def stop(self):
        if self.alive():
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# ---------------------------------------------------------------- pages
PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title>
<link rel="stylesheet" href="/test-static/brand.css"><link rel="icon" type="image/png" href="/test-static/sereact-logo.png">
<style>
 body {{ margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; box-sizing:border-box;
        padding:16px; color:var(--sr-text); font:16px/1.6 var(--sr-font);
        background: radial-gradient(1000px 640px at 15% 0%, rgba(47,107,255,.24), transparent 60%),
                    radial-gradient(900px 600px at 100% 100%, rgba(123,92,255,.22), transparent 60%), var(--sr-navy); }}
 .card {{ background:var(--sr-glass); border:1px solid var(--sr-line); border-radius:22px; padding:30px 34px; max-width:560px;
         width:100%; box-sizing:border-box; box-shadow:var(--sr-shadow); backdrop-filter:blur(14px); }}
 .card > .sr-brand {{ margin-bottom:22px; }}
 h1 {{ font-size:26px; margin:0 0 12px; }} p {{ color:#cbd3e6; }}
 input[type=text], input[type=email] {{ width:100%; box-sizing:border-box; padding:12px 14px; margin:6px 0 16px; font:inherit;
        background:rgba(7,11,24,.7); color:#eef1f8; border:1px solid var(--sr-line); border-radius:12px; outline:none; }}
 input[type=text]:focus, input[type=email]:focus {{ border-color:var(--sr-violet-2); box-shadow:0 0 0 4px rgba(123,92,255,.18); }}
 button {{ background:var(--sr-grad); color:#fff; border:0; border-radius:14px; padding:13px 26px; font:600 16px var(--sr-font);
          cursor:pointer; box-shadow:0 10px 28px rgba(64,90,255,.35); }}
 button:hover {{ filter:brightness(1.08); }}
 .err {{ color:var(--sr-bad); }} label {{ color:#cbd3e6; font-size:14px; font-weight:500; }} small {{ color:var(--sr-faint); }}
 .foot {{ margin-top:18px; font-size:12px; color:var(--sr-faint); }}
</style></head><body><div class="card">
<span class="sr-brand"><span class="sr-logo" aria-hidden="true"></span><span class="sr-mark">sere<b>act</b></span><span class="sr-divider"></span><span class="sr-product">Teleoperation assessment</span></span>
{body}</div><div class="foot">© Sereact GmbH</div></body></html>"""


def page(title, body, status=200):
    return web.Response(text=PAGE.format(title=html.escape(title), body=body), content_type="text/html",
                        status=status, headers={"Cache-Control": "no-store"})


JOIN_FORM = """<h1>Robot teleoperation test</h1>
<p>You will control a robot gripper in a simulation with your <b>bare hand</b> in front of your
webcam, and do a few short manipulation tasks after a practice round. It takes about 20 minutes.</p>
<p><b>You need:</b> a computer with a webcam, Chrome or Edge, good light on your hand. A short setup
checks everything before you start. <a href="/help" target="_blank" rel="noopener">Help: what you need, camera, controls</a></p>
<p>You can take the test once. Use the email address you applied with.</p>
{error}
<form method="post" action="/join">
 <label>Your name</label><input type="text" name="name" value="{name}" autocomplete="name" maxlength="80" required>
 <label>Your email</label><input type="email" name="email" value="{email}" autocomplete="email" maxlength="254" required>
 <p><label><input type="checkbox" name="consent" required> I agree that my control of the robot
 is recorded and scored for this application. The recording is used only to evaluate the test.</label></p>
 <button type="submit">Start</button>
</form>"""

ALREADY_TAKEN = """<h1>You've already taken the test</h1>
<p>There is already an attempt for this email address, and each person can take the test once.</p>
<p>If something went wrong (for example the connection dropped), contact the person who sent you
this link: they can allow a retake.</p>"""

CLOSED = """<h1>Back in a few minutes</h1>
<p>The test is closed for a short update. Please try again in a few minutes: your invitation is still valid.</p>"""

ATTEMPT_COOKIE = "screening_attempt"
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def make_app(args) -> web.Application:
    workers: dict[str, Worker] = {}
    @web.middleware
    async def no_cache_scripts(request, handler):
        """Pages and scripts are revalidated on every load, so a fix reaches phones at once
        (only three.js, which never changes, may be cached)."""
        resp = await handler(request)
        if request.path.startswith(("/test-static/", "/static/")) and "/vendor/" not in request.path:
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    app = web.Application(middlewares=[no_cache_scripts])
    http: dict = {}

    async def on_startup(_):
        http["s"] = aiohttp.ClientSession()
        app["reaper"] = asyncio.create_task(reaper())
        if args.tunnel:
            start_tunnel()

    async def on_cleanup(_):
        app["reaper"].cancel()
        for w in workers.values():
            w.stop()
        if app.get("tunnel") is not None:
            app["tunnel"].terminate()
        await http["s"].close()

    tunnel_state = {"url": None}           # the in-process tunnel's public address, once known

    def start_tunnel():
        import threading
        proc = open_tunnel(args.port)
        if proc is None:
            return
        app["tunnel"] = proc
        threading.Thread(target=lambda: watch_tunnel(proc, lambda u: tunnel_state.update(url=u)),
                         daemon=True).start()

    def public_url():
        """The site's public address: PUBLIC_URL (hosted: e.g. https://teleop.sereact.ai), else
        the in-process tunnel's, else the one a separate `tunnel` process wrote."""
        if os.environ.get("PUBLIC_URL"):
            return os.environ["PUBLIC_URL"].rstrip("/")
        if tunnel_state["url"]:
            return tunnel_state["url"]
        info = _load(tunnel_file(), None)
        return info.get("url") if info else None

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    ADMIN_USER, ADMIN_PASSWORD = os.environ.get("ADMIN_USER", "admin"), os.environ.get("ADMIN_PASSWORD", "")
    # ADMIN_LOCAL_OPEN=0 (the container): always the sign-in, also from this machine (a proxy on the
    # same server forwarding to 127.0.0.1 would otherwise look local)
    LOCAL_OPEN = os.environ.get("ADMIN_LOCAL_OPEN", "1") != "0"

    def local_only(handler):
        """The admin pages: open on this computer (a request from itself, not through a proxy or
        tunnel); from anywhere else only with ADMIN_USER / ADMIN_PASSWORD (the browser's sign-in
        box, HTTP Basic: the site is https); without a password set, not from anywhere else."""
        async def wrapped(request):
            local = LOCAL_OPEN and request.remote in ("127.0.0.1", "::1") and "cf-connecting-ip" not in request.headers \
                and "x-forwarded-for" not in request.headers
            if not local:
                if not ADMIN_PASSWORD:
                    return web.Response(status=403, text="The admin pages are closed here: set ADMIN_PASSWORD to open them.")
                ok = False
                auth = request.headers.get("Authorization", "")
                if auth.startswith("Basic "):
                    import base64
                    try:
                        user, _, pw = base64.b64decode(auth[6:]).decode("utf-8").partition(":")
                        ok = secrets.compare_digest(user, ADMIN_USER) & secrets.compare_digest(pw, ADMIN_PASSWORD)
                    except (ValueError, UnicodeDecodeError):
                        ok = False
                if not ok:
                    return web.Response(status=401, text="Sign in to the screening admin.",
                                        headers={"WWW-Authenticate": 'Basic realm="Sereact screening admin", charset="UTF-8"'})
            return await handler(request)
        return wrapped

    async def healthz(_):
        """For the load balancer / Docker: alive, and how full."""
        busy = sum(1 for w in workers.values() if w.alive())
        st = settings()
        return web.json_response({"ok": True, "running": busy, "capacity": st["max_concurrent"], "accepting": st["accepting"]})

    def public_base(request) -> str:
        proto = request.headers.get("X-Forwarded-Proto", request.scheme)
        return f"{proto}://{request.host}"

    def lookup(code: str):
        code = (code or "").strip().upper()
        return code, candidate(code)

    async def ensure_worker(code: str, c: dict) -> Worker:
        w = workers.get(code)
        if w is not None and w.alive():
            return w
        st = settings()
        busy = sum(1 for x in workers.values() if x.alive())
        if busy >= st["max_concurrent"]:
            raise web.HTTPServiceUnavailable(text="All test places are busy right now. Please try again in a few minutes.")
        w = Worker(code, c)
        workers[code] = w
        if not await w.ready(http["s"]):
            raise web.HTTPInternalServerError(text="The simulator didn't start. Please tell the organiser.")
        return w

    async def reaper():
        """Stop simulators of finished or abandoned tests."""
        while True:
            await asyncio.sleep(10)
            st = settings()
            cands = candidates()
            for code, w in list(workers.items()):
                c = cands.get(code)
                res = results_of(code, c) if c else None
                if res and res.get("finished") and c.get("status") == "playing":
                    c["status"], c["finished"] = "done", res.get("finished_at")
                    update_candidate(code, status="done", finished=c["finished"])
                idle = w.clients == 0 and time.time() - w.last_seen > 60 * st["idle_timeout_min"]
                done_idle = res and res.get("finished") and w.clients == 0 and time.time() - w.last_seen > 30
                if not w.alive() or idle or done_idle:
                    w.stop()
                    del workers[code]
                    if c and c.get("status") == "playing" and not (res and res.get("finished")):
                        update_candidate(code, status="abandoned")

    # ---- candidate pages
    async def index(request):
        if not settings()["accepting"]:
            return page("Sereact · Teleoperation test", CLOSED)
        return page("Sereact · Teleoperation test", JOIN_FORM.format(error="", name="", email=""))

    def to_play(request, code):
        """Off to the test, with the attempt's code in a cookie: the same browser may come back."""
        resp = web.Response(status=302, headers={"Location": f"/play/{code}", "Cache-Control": "no-store"})
        https = request.headers.get("X-Forwarded-Proto", request.scheme) == "https"
        resp.set_cookie(ATTEMPT_COOKIE, code, max_age=7 * 24 * 3600, path="/", httponly=True,
                        samesite="Lax", secure=https)
        return resp

    async def join(request):
        form = await request.post()
        name = " ".join((form.get("name") or "").split())[:80]
        email = (form.get("email") or "").strip().lower()

        def again(msg):
            return page("Sereact · Teleoperation test", JOIN_FORM.format(error=f'<p class="err">{html.escape(msg)}</p>',
                                                              name=html.escape(name), email=html.escape(email)))
        if not name:
            return again("Please enter your name.")
        if len(email) > 254 or not EMAIL_RE.fullmatch(email):
            return again("Please enter a valid email address.")
        if not form.get("consent"):
            return again("Please agree to the recording to take the test.")
        prev = attempt_of(email)
        if prev is not None:
            code, c = prev
            if c["status"] == "playing" and secrets.compare_digest(request.cookies.get(ATTEMPT_COOKIE, ""), code):
                await ensure_worker(code, c)          # the same browser coming back to its test
                return to_play(request, code)
            return page("Sereact · Teleoperation test", ALREADY_TAKEN)
        if not settings()["accepting"]:                # (paused for an update: no new tests)
            return page("Sereact · Teleoperation test", CLOSED)
        try:
            code = new_candidate(time.strftime("%Y-%m"), name=name, email=email)
        except sqlite3.IntegrityError:                # (the same email, a moment ago)
            return page("Sereact · Teleoperation test", ALREADY_TAKEN)
        try:
            await ensure_worker(code, candidate(code))
        except web.HTTPException:
            if code in workers:
                workers.pop(code).stop()
            delete_candidate(code)                   # (busy / didn't start: the attempt never began)
            raise
        return to_play(request, code)

    def static_page(file, code):
        text = (TEST_WEB / file).read_text(encoding="utf-8")
        text = (text.replace("__CODE__", code).replace("__BOOT__", str(app["boot"]))
                .replace("__CONFIG__", json.dumps(cfg().public())))
        return web.Response(text=text, content_type="text/html", headers={"Cache-Control": "no-store"})

    async def test_run(request):
        """The permanent test link: every visit is a new run with its own code and data folder
        (batch "Test runs"), straight into the test (no form): for testing the test itself."""
        if not secrets.compare_digest(request.match_info["token"], test_token()):
            raise web.HTTPNotFound()
        try:
            code = new_candidate("Test runs", name="test run", only=request.query.get("only") or None)
        except ValueError as e:
            raise web.HTTPBadRequest(text=str(e))
        await ensure_worker(code, candidate(code))
        raise web.HTTPFound(f"/play/{code}")

    async def play(request):
        code, c = lookup(request.match_info["code"])
        if c is None or c["status"] not in ("playing",):
            raise web.HTTPFound("/")
        await ensure_worker(code, c)
        return static_page("screen.html", code)

    async def phone(request):
        code, c = lookup(request.match_info["code"])
        if c is None or c["status"] != "playing":
            return page("Sereact · Teleoperation test", "<h1>Link not active</h1><p>Open the test on your computer first.</p>")
        return static_page("phone.html", code)

    async def hand_camera(request):
        """A phone as the hand camera (any phone: only its camera and browser are needed)."""
        code, c = lookup(request.match_info["code"])
        if c is None or c["status"] != "playing":
            return page("Sereact · Teleoperation test", "<h1>Link not active</h1><p>Open the test on your computer first.</p>")
        return static_page("hand.html", code)

    async def qr_hand(request):
        import segno
        code, c = lookup(request.match_info["code"])
        if c is None:
            raise web.HTTPNotFound()
        buf = io.BytesIO()
        segno.make(f"{public_base(request)}/h/{code}", error="m").save(buf, kind="svg", scale=8, border=2,
                                                                        dark="#000", light="#fff")
        return web.Response(body=buf.getvalue(), content_type="image/svg+xml")

    async def qr(request):
        import segno
        code, c = lookup(request.match_info["code"])
        if c is None:
            raise web.HTTPNotFound()
        buf = io.BytesIO()
        segno.make(f"{public_base(request)}/m/{code}", error="m").save(buf, kind="svg", scale=8, border=2,
                                                                        dark="#000", light="#fff")
        return web.Response(body=buf.getvalue(), content_type="image/svg+xml")

    async def phone_url(request):
        code, _ = lookup(request.match_info["code"])
        return web.json_response({"url": f"{public_base(request)}/m/{code}"})

    # ---- relay to the candidate's simulator
    async def scene_json(request):
        code, c = lookup(request.match_info["code"])
        w = workers.get(code)
        if c is None or w is None:
            raise web.HTTPNotFound()
        async with http["s"].get(w.url + "/scene.json", auto_decompress=False) as r:
            body = await r.read()
            enc = r.headers.get("Content-Encoding", "")
        # (a fingerprint: a refresh gets "not modified" instead of the whole scene again, ~1 MB)
        tag = '"' + hashlib.sha1(body).hexdigest()[:20] + '"'
        if tag in request.headers.get("If-None-Match", ""):
            return web.Response(status=304, headers={"ETag": tag, "Cache-Control": "no-cache"})
        return web.Response(body=body, headers={"Content-Type": "application/json", "Content-Encoding": enc,
                                                "ETag": tag, "Cache-Control": "no-cache"})

    async def ws_relay(request):
        code, c = lookup(request.match_info["code"])
        w = workers.get(code)
        if c is None or w is None or not w.alive():
            raise web.HTTPNotFound()
        down = web.WebSocketResponse(heartbeat=15, max_msg_size=1 << 20)
        await down.prepare(request)
        w.clients += 1
        try:
            async with http["s"].ws_connect(w.url + "/ws", max_msg_size=0, heartbeat=15) as up:
                async def to_sim():
                    async for msg in down:
                        if msg.type == WSMsgType.TEXT:
                            await up.send_str(msg.data)
                        elif msg.type == WSMsgType.BINARY:
                            await up.send_bytes(msg.data)
                async def to_browser():
                    async for msg in up:
                        if msg.type == WSMsgType.TEXT:
                            await down.send_str(msg.data)
                        elif msg.type == WSMsgType.BINARY:
                            await down.send_bytes(msg.data)
                tasks = [asyncio.create_task(to_sim()), asyncio.create_task(to_browser())]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in tasks:
                    t.cancel()
        except (aiohttp.ClientError, ConnectionResetError):
            pass
        finally:
            w.clients -= 1
            w.last_seen = time.time()
        return down

    # ---- admin (this PC only)
    async def admin(_):
        return web.FileResponse(TEST_WEB / "admin.html", headers={"Cache-Control": "no-store"})

    rec_cache: dict[str, tuple] = {}

    def recommendation(code: str, cand: dict, res: dict | None) -> dict:
        """recommend.py's verdict for an attempt (cached until its results change; a test still
        running gets none yet)."""
        if res is None or cand["status"] == "playing":
            return {}
        folder = session_dir(code, cand) / "screen" / "attempt"
        rp = folder / "results.json"
        key = (rp.stat().st_mtime if rp.exists() else 0, id(cfg()))
        hit = rec_cache.get(code)
        if hit and hit[0] == key:
            return hit[1]
        c = cfg()
        r = R.recommend(res, R.quality(folder / "hand_tracking.jsonl"), c.scored_phases, c.recommendation)
        rec_cache[code] = (key, r)
        return r

    def rows():
        """One row per person: an invite (imported from Ashby) and/or their attempts (the latest
        one's results; earlier ones an admin reset are counted); a test run is a row of its own."""
        c = cfg()
        inv = invites()
        by_email: dict[str, list] = {}
        out = []
        for code, cand in candidates().items():
            if cand.get("email"):
                by_email.setdefault(cand["email"], []).append((code, cand))
            else:
                out.append(row(code, cand, [(code, cand)], None, c))
        for email in set(inv) | set(by_email):
            att = by_email.get(email, [])
            live = [a for a in att if a[1]["status"] != "reset"]
            latest = max(live or att, key=lambda a: a[1]["created"] or "") if att else None
            out.append(row(*(latest or (None, None)), att, inv.get(email), c, email=email))
        return out

    def row(code, cand, attempts, invite, c, email=None):
        r = {"id": email or code, "code": code, "email": email or "", "test_run": email is None,
             "invited": invite is not None, "name": (invite or {}).get("name") or (cand or {}).get("name", ""),
             "job": (invite or {}).get("job", ""), "invited_at": (invite or {}).get("invited_at"),
             "attempts": len(attempts), "status": cand["status"] if cand else "invited"}
        if cand is None:
            return r
        res = results_of(code, cand)
        sc, mt = (res or {}).get("scores", {}), (res or {}).get("metrics", {})
        rec = recommendation(code, cand, res)
        q = rec.get("quality") or {}
        r.update({"started": cand.get("started"), "finished": cand.get("finished") or (res or {}).get("finished_at"),
                  "phase": (res or {}).get("phase"), "only": cand.get("only"), "batch": cand["batch"],
                  "running": code in workers and workers[code].alive(),
                  "overall": sc.get("overall"), "grade": sc.get("grade"), "pass": passed(res),
                  "verdict": rec.get("verdict"), "verdict_label": rec.get("label"),
                  "learning": (rec.get("learning") or {}).get("score"), "tech": rec.get("technical") or [],
                  "summary": (rec.get("reasons") or [""])[0], "fps": q.get("fps"),
                  "skipped": len(rec.get("skipped") or [])})
        for k in ("completion", "speed", "precision", "economy"):
            r[k] = (sc.get("skills") or {}).get(k)
        for p in c.scored_phases:
            r[p.key] = sc.get(p.key)
        return r

    async def admin_api(_):
        c = cfg()
        return web.json_response({"settings": settings(), "candidates": rows(), "config": c.public(),
                                  "config_path": _rel(c.path), "config_error": _cfg_state["error"],
                                  "public_url": public_url(), "tunnel": bool(args.tunnel),
                                  "test_path": f"/t/{test_token()}", "verdicts": R.VERDICTS})

    async def admin_csv(_):
        buf = io.StringIO()
        cols = ["name", "email", "job", "invited", "invited_at", "status", "attempts", "started", "finished", "overall", "grade",
                "verdict_label", "learning", "completion", "speed", "precision", "economy", "fps", "skipped", "summary"]
        cols += [p.key for p in cfg().scored_phases]
        wr = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        wr.writeheader()
        wr.writerows(r for r in rows() if not r["test_run"])
        return web.Response(text=buf.getvalue(), content_type="text/csv",
                            headers={"Content-Disposition": 'attachment; filename="screening_results.csv"'})

    async def admin_report_page(_):
        return web.FileResponse(TEST_WEB / "admin_report.html", headers={"Cache-Control": "no-store"})

    async def admin_report(request):
        """Everything about one attempt: the person, all their attempts, the scores per task, the
        recommendation with its reasons and learning curve, the tracking quality, the files."""
        code, cand = lookup(request.match_info["code"])
        if cand is None:
            raise web.HTTPNotFound()
        c = cfg()
        res = results_of(code, cand)
        rec = recommendation(code, cand, res) if res else {}
        inv = invites().get(cand["email"]) if cand.get("email") else None
        others = [dict(code=k, status=v["status"], started=v["started"], finished=v["finished"],
                       overall=((results_of(k, v) or {}).get("scores") or {}).get("overall"))
                  for k, v in candidates().items() if cand.get("email") and v.get("email") == cand["email"]]
        folder = session_dir(code, cand)
        files = sorted((dict(path=str(p.relative_to(folder)).replace("\\", "/"), size=p.stat().st_size)
                        for p in folder.rglob("*") if p.is_file() and p.name != "quality.json"),
                       key=lambda f: f["path"]) if folder.exists() else []
        tasks = []
        m, sc = (res or {}).get("metrics", {}), (res or {}).get("scores", {})
        for p in c.task_phases:
            if p.key in m:
                mt = m[p.key]
                tasks.append(dict(key=p.key, title=p.title, scored=p.scored, score=sc.get(p.key),
                                  parts=(sc.get("breakdown") or {}).get(p.key), time_s=mt.get("time_s"), limit=p.limit,
                                  steps=f"{round(mt.get('steps_done') or 0, 2):g}/{mt.get('steps_total')}", completed=mt.get("completed"),
                                  ended_by=mt.get("ended_by"), grasps=mt.get("grasps"), attempts=mt.get("grasp_attempts"),
                                  drops=mt.get("drops"), path_m=round(mt.get("path_m") or 0, 2), homes=mt.get("homes", 0)))
        return web.json_response({
            "code": code, "candidate": cand, "invite": inv, "attempts": others, "results_at": (res or {}).get("finished_at"),
            "scores": {k: v for k, v in sc.items() if k != "breakdown"}, "tasks": tasks, "pass": passed(res),
            "recommendation": {k: v for k, v in rec.items() if k != "quality"}, "quality": rec.get("quality"),
            "files": files, "running": code in workers and workers[code].alive(), "thresholds": c.recommendation})

    async def admin_file(request):
        """A file of an attempt's folder (results, recordings, logs), for download."""
        code, cand = lookup(request.match_info["code"])
        if cand is None:
            raise web.HTTPNotFound()
        folder = session_dir(code, cand).resolve()
        p = (folder / request.match_info["path"]).resolve()
        if folder not in p.parents or not p.is_file():          # (nothing outside the attempt's folder)
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers={"Content-Disposition": f'attachment; filename="{code}_{p.name}"'})

    async def admin_invites(request):
        """Import invited people: {text} (a pasted list or an Ashby CSV export). {dry: true}
        only reads them (the page shows what would be imported)."""
        body = await request.json()
        people, problems = parse_invites(str(body.get("text", "")))
        if body.get("dry"):
            return web.json_response({"people": people, "problems": problems})
        added, updated = save_invites(people)
        return web.json_response({"added": added, "updated": updated, "problems": problems})

    async def admin_invite_delete(request):
        delete_invite(request.match_info["email"].lower())
        return web.json_response({"ok": True})

    async def admin_settings(request):
        """Lobby settings (settings.json) and the pass rule, which lives in the test's
        configuration ([scoring] pass_mark, must_complete: saved into the file, comments kept)."""
        body = await request.json()
        st = settings()
        for k in DEFAULT_SETTINGS:
            if k in body:
                st[k] = type(DEFAULT_SETTINGS[k])(body[k])
        _save(SETTINGS, st)
        upd = {}
        if "pass_mark" in body:
            v = float(body["pass_mark"])
            upd[("scoring", "pass_mark")] = int(v) if v.is_integer() else v
        if "must_complete" in body:
            upd[("scoring", "must_complete")] = [str(x) for x in body["must_complete"]]
        if upd:
            try:
                C.set_values(upd, cfg().path)
            except C.ConfigError as e:
                raise web.HTTPBadRequest(text="\n".join(e.problems))
        return web.json_response({"settings": st, "config": cfg().public()})

    async def admin_reset(request):
        """Let a candidate take the test again: the attempt (its row and folder) is kept, marked
        'reset', and the email may join again (a new attempt with a new code)."""
        code, c = lookup(request.match_info["code"])
        if c is None:
            raise web.HTTPNotFound()
        if code in workers:
            workers.pop(code).stop()
        update_candidate(code, status="reset")
        return web.json_response({"ok": True})

    app["boot"] = int(time.time())
    app.router.add_get("/", index)
    app.router.add_post("/join", join)
    app.router.add_get("/play/{code}", play)
    app.router.add_get("/t/{token}", test_run)
    app.router.add_get("/m/{code}", phone)
    app.router.add_get("/qr/{code}.svg", qr)
    app.router.add_get("/h/{code}", hand_camera)
    app.router.add_get("/qrh/{code}.svg", qr_hand)
    app.router.add_get("/phone-url/{code}", phone_url)
    app.router.add_get("/s/{code}/scene.json", scene_json)
    app.router.add_get("/s/{code}/ws", ws_relay)
    # hand tracking on the server for a computer too slow to do it (tracker.py: a process per user)
    tracker.add_routes(app, lambda code: code in workers and workers[code].alive(),
                       delegate=os.environ.get("TRACKER_DELEGATE", "cpu"))
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/help", lambda _: web.FileResponse(TEST_WEB / "help.html", headers={"Cache-Control": "no-cache"}))
    app.router.add_get("/admin", local_only(admin))
    app.router.add_get("/admin/api", local_only(admin_api))
    app.router.add_get("/admin/results.csv", local_only(admin_csv))
    app.router.add_post("/admin/settings", local_only(admin_settings))
    app.router.add_post("/admin/reset/{code}", local_only(admin_reset))
    app.router.add_get("/admin/report/{code}", local_only(admin_report_page))
    app.router.add_get("/admin/api/report/{code}", local_only(admin_report))
    app.router.add_get("/admin/file/{code}/{path:.+}", local_only(admin_file))
    app.router.add_post("/admin/invites", local_only(admin_invites))
    app.router.add_post("/admin/invites/delete/{email}", local_only(admin_invite_delete))
    app.router.add_static("/static/", WEB_DIR)
    app.router.add_static("/test-static/", TEST_WEB)
    return app


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="start the lobby")
    # (the environment gives the defaults: a container sets HOST=0.0.0.0, PORT, DATA_DIR)
    s.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    s.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"),
                   help="127.0.0.1 (default): reachable through a tunnel only; 0.0.0.0: also on the local network")
    s.add_argument("--tunnel", action="store_true",
                   help="also start a Cloudflare quick tunnel (needs cloudflared) and show its public address")
    tn = sub.add_parser("tunnel", help="run the public tunnel on its own (its address survives lobby restarts)")
    tn.add_argument("--port", type=int, default=8000)
    for p in (s, tn):
        p.add_argument("--data", default=os.environ.get("DATA_DIR", str(DATA)),
                       help="folder for the candidates database, settings and results (env DATA_DIR)")
    a = ap.parse_args(argv)
    set_data_dir(Path(a.data))
    if a.cmd == "tunnel":
        print(f"  Public tunnel to http://localhost:{a.port} (keep this window open)...", flush=True)
        run_tunnel(a.port)
        return
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.winmm.timeBeginPeriod(1)
    if not SETTINGS.exists():
        _save(SETTINGS, DEFAULT_SETTINGS)
    try:
        c = cfg()
    except C.ConfigError as e:
        print(f"\n  The test's configuration has problems; fix them and start again:\n{e}\n")
        sys.exit(1)
    _db().close()                          # (made, and an old candidates.json moved in, now)
    print(f"  Test configuration: {_rel(c.path)} ({len(c.task_phases)} phases)")
    print(f"\n  Screening lobby: http://localhost:{a.port}   (results: http://localhost:{a.port}/admin)")
    if os.environ.get("PUBLIC_URL"):
        print(f"  Public address: {os.environ['PUBLIC_URL']}   (admin: /admin, "
              f"{'sign-in: ADMIN_USER / ADMIN_PASSWORD' if os.environ.get('ADMIN_PASSWORD') else 'closed: no ADMIN_PASSWORD set'})\n")
    elif a.tunnel:
        print("  Starting the public tunnel (its address appears below and on the admin page)...")
    else:
        print("  Candidates need a public https:// address: the tunnel (a separate window:")
        print("     python -m TEST_TELEOP.lobby tunnel), or start this with --tunnel\n")
    web.run_app(make_app(a), host=a.host, port=a.port, print=None)


if __name__ == "__main__":
    main()
