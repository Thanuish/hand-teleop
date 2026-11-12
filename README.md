# Hand teleop: the Sereact teleoperation screening test

**Version 1.0.2.** Releases are in the [list of releases](https://github.com/Thanuish/hand-teleop/releases), and
the Docker image is `ghcr.io/thanuish/hand-teleop:<version>-cpu`.

An online test that screens candidates for robot teleoperation before they come onsite. A candidate
controls a simulated robot gripper with their **bare hand** in front of a webcam, in the browser.
They need no VR headset and install nothing. They do two short manipulation games, and the test
scores them on completion, speed, precision and economy of motion.

- **Robot:** a Robotiq 2F-85 gripper, simulated in [MuJoCo](https://mujoco.org). It floats on its
  own by default (`[arm] mount = "floating"` in `config/screening.toml`), or sits on a Universal
  Robots UR5e arm (`mount = "arm"`). The models come from
  [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie), and their licences are in `assets/`.
- **Hand tracking:** [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  (Apache 2.0) runs in the browser. Only the hand's 21 points are sent; the video never leaves the
  device. A computer too slow for this can track on the server instead (the candidate chooses it on
  the setup screen). Those pictures are processed in memory and never stored.

## What a candidate does (about 15–20 minutes)

| Phase | What | Time limit | Scored |
|---|---|---|---|
| Sign-up | name, email, consent to the recording (one attempt per email) | | |
| Setup | camera, light, tracking speed, hand in the box, the gestures | | |
| Practice | pick up a block and put it on its target | 3:00 | no |
| Game 1: sort by colour | red ball, blue cube and green cylinder into the bin of their colour | 5:00 | yes |
| Game 2: tower | stack 3 blocks on a platform; they appear one at a time, and a fallen block can be picked up again | 5:00 | yes |

**Pass = both games completed** (`must_complete` in `[scoring]`), and the score ranks those who
pass. The admin page shows every candidate's grade, skill profile (completion, speed, precision,
economy) and a recommendation.

### Controls

| | |
|---|---|
| ✋ open hand | moves the robot, which follows the hand at 0.9 scale (small hand movements, sitting close to the webcam) |
| ✊ fist | pause: move the hand without moving the robot, then open it to carry on |
| 🤏 pinch | close the gripper; open the hand and it drives with the gripper closed; pinch again to open it |
| **SPACE** | close / open the gripper (same as a pinch) |
| **Q / E** | turn the gripper |
| **H** | the gripper back to its start |

The hand must stay inside the **box** drawn on the camera picture; outside it, the robot pauses.
A phone can be the camera instead of the webcam: the test page shows a QR code for it (`/h/<code>`).

## Run it on your computer

```bash
python -m venv .venv && . .venv/bin/activate        # Windows: setup_windows.bat
pip install -r requirements.txt
python setup_assets.py                               # only if assets/ is missing
python -m TEST_TELEOP.lobby serve --port 8100        # http://localhost:8100, admin: /admin
python -m TEST_TELEOP.lobby tunnel --port 8100       # optional: a temporary public https:// link (Cloudflare)
```

Everyone uses the same link. Candidates enter their name and email, and the admin page can allow a
retake. Candidates' help page is `/help`. For your own testing, the admin page has a permanent
link, `/t/<token>`; every visit is a new run, and `?only=sort` runs a single game. Results and
recordings go to `data/` (not in git).

## Host it (production)

It runs as one Docker container on one server, at one address with https (for example
`assessment.sereact.ai`). `docker-compose.yml` and `Caddyfile` do all of it, including the
certificate. The admin page needs a password set on the server (`ADMIN_PASSWORD`).

- **Hosting, sizing, updating, backups:** [DEPLOY.md](DEPLOY.md)
- **Running rounds and reading results:** [docs/ADMIN.md](docs/ADMIN.md)
- **Changing the system once it is live:** [docs/RUNNING_AND_UPDATING.md](docs/RUNNING_AND_UPDATING.md)

**Releasing a new version:**
1. Change the code or the configuration on a branch.
2. Push it and open a pull request. GitHub Actions runs the tests and builds and tries out the Docker image.
3. Merge it into `main`, then tag a version (`git tag v1.0.3 && git push origin v1.0.3`). GitHub
   Actions publishes `ghcr.io/thanuish/hand-teleop:v1.0.3-cpu` (and `-gpu`) and attaches the image
   as a file to the release.
4. On the server, set `VERSION=v1.0.3` in `.env`, then run `docker compose pull && docker compose up -d`
   (after draining; see DEPLOY.md).

## Changing the test: `config/screening.toml`

One file defines the whole test, in plain units (metres, degrees, seconds), with a comment on every
setting:

| Section | What |
|---|---|
| `[arm]` | floating gripper or arm, start pose, top speed and turning speed, motor stiffness |
| `[controls]` | `hand_motion_scale`: robot motion per hand motion (0.9) |
| `[view]`, `[depth_cues]` | the starting camera; the ring and line below the gripper |
| `[timing]`, `[tolerances]` | the countdown; how close counts as "in", "touched", "at rest"... |
| `[scoring]` | the weights, par times, the pass mark, which games must be completed |
| `[objects.*]`, `[markers.*]` | every object (shape, size, colour, mass, friction, start) and zone, bin or platform |
| `[[phases]]` | the phases in order: text, time limit, scored or practice, objects, markers and the **steps** to do |

Steps are building blocks: `reach`, `place_in_zone`, `place_in_slot`, `place_in_bin`, `remove_from`,
`lay_flat`, `pour_into`, `set_upright`, `hang_on`, `follow_wire` and `stack`. A new task is a new
`[[phases]]` entry made of these; it needs no programming.

After editing, check the file with `python -m TEST_TELEOP.check_config`, which lists every problem.
Then run `python -m TEST_TELEOP.screen_bot` to see that every task can still be done. A running lobby
uses the changed file for each new candidate. To try another file without touching this one, set
`SCREEN_CONFIG=path/to/file.toml`.

## Code

| Folder | What |
|---|---|
| `TEST_TELEOP/` | the lobby (`lobby.py`: sign-up, one simulator per candidate, admin page, `/healthz`), the tasks (`screen_scene.py`, `screen_game.py`), grading (`grading.py`, `recommend.py`), server-side tracking (`tracker.py`), the configuration loader (`config.py`) |
| `TEST_TELEOP/web/` | the candidate's pages: the test (`screen.*`), the setup and hand-control UI (`hand/`), a phone as the camera (`hand.html`, `hand_phone.js`), help, the admin page |
| `TEST_TELEOP/web/hand/` | the hand control: tracking (`worker.js`, `core.js`), the 3D hand pose and pinch (`pose3d.js`), the checklist UI (`ui.js`) |
| `vrteleop/` | the simulator underneath: MuJoCo scene (`scene.py`), the per-candidate server (`server.py`), clutch mapping (`teleop.py`), gripper / arm control and IK (`arms.py`, `ik.py`), recording (`recorder.py`), the 3D viewer (`web/main.js`) |
| `buzzwire/` | the wire curve for the `follow_wire` step (not in the current test) |
| `scripts/` | `replay_hand.mjs` (smoothness, jitter and lag on recorded sessions), `replay.py` (inspect or render a recorded episode), `demo_admin.py` (an admin page filled with demo data) |
| `config/screening.toml` | the test: tasks, time limits, scoring, controls |

## Tests

These are the same checks GitHub Actions runs on every push:

```bash
python -m TEST_TELEOP.check_config          # the configuration is valid
python -m vrteleop.test_teleop              # the clutch mapping and the target smoothing
node TEST_TELEOP/web/hand/test/run.mjs      # the hand control, on a synthetic hand with MediaPipe-like noise
python -m TEST_TELEOP.screen_bot            # a scripted run through every task (grade A)
node scripts/replay_hand.mjs                # optional: smoothness, jitter and lag on your recorded sessions
```
