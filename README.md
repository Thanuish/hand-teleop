# Hand teleop

Control a simulated robot gripper with your **bare hand** in front of a webcam (or a phone's
camera), in the browser. No VR headset, no app, nothing to install for the person using it.
Built as an online screening test for robot teleoperation: a candidate does short manipulation
tasks from home and gets scored on time, steps and efficiency.

- **Robot:** a Robotiq 2F-85 gripper, floating (`[arm] mount = "floating"` in
  `config/screening.toml`) or on a Universal Robots UR5e arm (`mount = "arm"`), simulated in
  [MuJoCo](https://mujoco.org). Models from [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie)
  (their licenses are in `assets/`).
- **Hand tracking:** [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  (Apache 2.0) in the browser; the video never leaves the device, only the hand's pose is sent.
  A computer too slow for it can track on the server instead (`TEST_TELEOP/tracker.py`, the
  candidate chooses it on the setup screen).

## Controls

| | |
|---|---|
| ✋ open hand | moves the robot (it follows your hand, at 0.35 scale: calmer, more precise) |
| ✊ fist | pause: move your hand without moving the robot, open it to carry on |
| 🤏 pinch | close the gripper; open your hand and it drives with the gripper closed; pinch again to open it (the robot holds still while you pinch) |
| **SPACE** | close the gripper / open it again (same as a pinch) |
| **Q / E** | turn the gripper |
| **W / S, A / D** | tilt it (tasks that need it) |
| **H** | the gripper back home |

A see-through **ghost gripper** shows at once where the robot is going (drawn from your hand in
your browser), so the network's delay doesn't make it feel laggy. The hand must stay inside the
**box** drawn on the camera picture: outside it, the robot pauses (near the picture's edge the
tracking loses fingers).

## Run it

```bash
python -m venv .venv && . .venv/bin/activate        # Windows: setup_windows.bat
pip install -r requirements.txt
python setup_assets.py                               # only if assets/ is missing
python -m TEST_TELEOP.lobby serve --port 8100        # the lobby: http://localhost:8100 (admin: /admin)
python -m TEST_TELEOP.lobby tunnel --port 8100       # a public https:// link (Cloudflare quick tunnel)
```

Candidates all use the same link: they enter their name and email (one attempt per email; the
admin page can allow a retake), then a setup screen checks the camera, light, speed, the hand in
its box and the gestures. Help for candidates: `/help`. For your own testing there is a permanent
link, `/t/<token>`: every visit is a new run (the token is made on first use in
`data/screening/test_link.json`). Results and recordings go to `data/` (not in git).

- Running rounds and reading results: [docs/ADMIN.md](docs/ADMIN.md)
- Changing the system once it is live: [docs/RUNNING_AND_UPDATING.md](docs/RUNNING_AND_UPDATING.md)

## Code

| Folder | What |
|---|---|
| `TEST_TELEOP/web/hand/` | the hand control: tracking (`worker.js`, `core.js`), the 3D hand pose (`pose3d.js`), the checklist UI (`ui.js`) |
| `TEST_TELEOP/web/` | the candidate's pages: the computer (`screen.*`), a phone as the camera (`hand*`), the admin page |
| `TEST_TELEOP/` | the lobby (sign-up, one simulator per candidate), the tasks (`screen_game.py`, `screen_scene.py`), grading (`grading.py`), server tracking (`tracker.py`), the configuration loader |
| `vrteleop/` | the simulator server: MuJoCo, the clutch mapping (`teleop.py`), arms / floating gripper (`arms.py`), IK, recording, the 3D viewer |
| `config/screening.toml` | tasks, time limits, scoring, controls (all editable) |

The full guide to the tasks, scoring and running a round: [TEST_TELEOP/README.md](TEST_TELEOP/README.md)
(written for the phone-as-controller version; the hand control replaces the phone's motion).

## Tests

```bash
node TEST_TELEOP/web/hand/test/run.mjs     # the hand control, on a synthetic hand with MediaPipe-like noise
python -m vrteleop.test_teleop              # the clutch mapping (no 180 deg flip) and the target smoothing
node scripts/replay_hand.mjs                # smoothness, jitter and lag on recorded real sessions (data/**/hand_tracking.jsonl)
python -m TEST_TELEOP.screen_bot            # a scripted run through every task (overall ~93, grade A)
```
