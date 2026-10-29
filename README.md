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

## Controls

| | |
|---|---|
| ✋ open hand | moves the robot (it follows your hand, at half scale) |
| ✊ fist | pause: move your hand without moving the robot, open it to carry on |
| 🤏 pinch | close the gripper; open your hand and it drives with the gripper closed; pinch again to open it (the robot holds still while you pinch) |
| **SPACE** | close the gripper / open it again (same as a pinch) |
| **Q / E** | turn the gripper |
| **W / S, A / D** | tilt it (tasks that need it) |
| **H** | the gripper back home |

A see-through **ghost gripper** shows at once where the robot is going (drawn from your hand in
your browser), so the network's delay doesn't make it feel laggy.

## Run it

```bash
python -m venv .venv && . .venv/bin/activate        # Windows: setup_windows.bat
pip install -r requirements.txt
python setup_assets.py                               # only if assets/ is missing
python -m TEST_TELEOP.lobby serve --port 8100        # the lobby: http://localhost:8100 (admin: /admin)
python -m TEST_TELEOP.lobby tunnel --port 8100       # a public https:// link (Cloudflare quick tunnel)
```

Make invite codes on the admin page (or `POST /admin/batch {"name": "...", "n": 5}` from the
same machine). For your own testing there is a permanent link, `/t/<token>`: every visit is a
new run, no code needed (the token is made on first use in `data/screening/test_link.json`).
Results and recordings go to `data/` (not in git).

## Code

| Folder | What |
|---|---|
| `TEST_TELEOP/web/hand/` | the hand control: tracking (`worker.js`, `core.js`), the 3D hand pose (`pose3d.js`), the checklist UI (`ui.js`) |
| `TEST_TELEOP/web/` | the candidate's pages: the computer (`screen.*`), a phone as the camera (`hand*`), the admin page |
| `TEST_TELEOP/` | the lobby (codes, one simulator per candidate), the tasks and scoring (`screen_game.py`, `screen_scene.py`), the configuration loader |
| `vrteleop/` | the simulator server: MuJoCo, the clutch mapping (`teleop.py`), arms / floating gripper (`arms.py`), IK, recording, the 3D viewer |
| `config/screening.toml` | tasks, time limits, scoring, controls (all editable) |

The full guide to the tasks, scoring and running a round: [TEST_TELEOP/README.md](TEST_TELEOP/README.md)
(written for the phone-as-controller version; the hand control replaces the phone's motion).

## Tests

```bash
node TEST_TELEOP/web/hand/test/run.mjs     # the hand control, on a synthetic hand with MediaPipe-like noise
python -m TEST_TELEOP.screen_bot            # a scripted run through every task (overall ~93)
```
