# Running and updating a live system

How to change the screening test once people depend on it. This uses our system as the example, but the ideas
are standard (search the bold terms to learn more).

## 1. Know what the system is made of

The pieces:
- **Code:** this repository. What the system *does*.
- **Configuration:** `config/screening.toml`. The tasks, times and scoring. It changes more often than code.
- **State:** `data/` holds the candidates database, results and recordings. It cannot be recreated, so it must
  be backed up.
- **Runtime:** the lobby (one process) starts one simulator process per candidate. The browser does the
  hand tracking, or our server does it for slow computers.

**Rule of thumb:** code and configuration are *replaceable* (they're in git). State is *precious*
(it's only in `data/`). A deploy replaces the first two and never touches the third.

## 2. Environments: never try things out on the live site

| Environment | What it is | Who uses it |
|---|---|---|
| **local** | your computer, `python -m TEST_TELEOP.lobby serve` | you, while changing things |
| **staging** | a copy of the live setup with its own `data/` (e.g. `screening-staging.sereact.ai`) | you and the admin team, to check a release |
| **production** | the real site candidates use | candidates |

A change goes local → staging → production, never straight to production. Staging should run *the same
image* that will go to production; only its settings (address, data folder) differ.

## 3. Versions and releases

- Work on a **branch**, open a **pull request**, merge to `main` when it's tested.
- When `main` is ready to ship, **tag a release**: `git tag v1.3.0 && git push --tags`. Use
  **semantic versioning**:
  - patch (`1.3.1`): a fix;
  - minor (`1.4.0`): a new feature;
  - major (`2.0.0`): results aren't comparable with before, e.g. a new scoring.
- The Docker image is built from the tag and named after it (`hand-teleop:1.3.0`). You can always say
  exactly what is running, and go back to any earlier version.
- Write a short **changelog** entry per release: what changed, whether scores are still comparable.

## 4. Kinds of change, and how risky they are

| Change | Example | Risk | How |
|---|---|---|---|
| Text / help | a clearer task card | low | normal release |
| Configuration | a par time, the pass mark | low to medium | edit the toml, restart; it changes scores from then on |
| Browser code | smoothing, the setup screen | medium | test with the replay tool and a real webcam on staging |
| Simulator / scoring | physics, grading | high | run `screen_bot` and compare scores before/after; bump the version |
| Data format | a new database column | high | a **migration** (below) and a backup first |

## 5. Shipping without hurting candidates mid-test

A candidate's run lives in a simulator process. Restarting the server ends every running test. So:

1. **Drain:** stop accepting *new* joins (a "maintenance" switch: to be added with the Docker setup), let running tests finish (at most
   ~25 minutes), then restart. This is the simplest safe pattern; pick a quiet hour.
2. With several servers behind a load balancer you can do a **rolling update**: take one out of rotation,
   wait until it's empty, update it, put it back, then the next one. Candidates never notice.
3. **Blue-green:** run the new version next to the old one, send new candidates to the new one, keep the old one
   until its tests finish. Switching back is instant if something is wrong.

Candidates who were mid-test when a restart happened anyway can be given a retake from the admin page.

## 6. When something goes wrong: rollback

- Keep the previous image. A rollback is "run the previous tag again": seconds, no rebuild.
- Configuration is in git: `git revert` the change, redeploy.
- Data changes are the hard part. That's why a **migration** always comes with a backup and is written so the
  *old* code still works with the *new* data where possible (add columns, don't rename them).

## 7. Data: migrations and backups

- The candidates database is SQLite (`data/screening/screening.db`). A schema change = a small migration step
  the server runs at start-up (see `_migrate_json` in `lobby.py` for the pattern: detect the old shape,
  convert once, keep a backup copy).
- **Back up `data/` daily** (and before every release). Test a restore once: a backup you've never
  restored is a hope, not a backup.
- Recordings grow (~MBs per candidate). Decide how long you keep them (e.g. 12 months) and delete older ones;
  candidates' data has legal retention rules (GDPR).

## 8. Seeing what's happening: monitoring and logs

- **Health check:** a URL the load balancer polls (`/healthz`, coming with Docker). If it fails, the server is
  restarted or taken out of rotation.
- **Logs:**
  - the lobby's own output;
  - `simulator.log` per run;
  - `hand_tracking.jsonl` per run (the raw hand data; use `scripts/replay_hand.mjs` on it to see how smooth
    the robot was).
- **Metrics worth watching:**
  - candidates running now against capacity (about 1 CPU core each);
  - how many use the server tracker;
  - abandoned runs: a jump in them usually means something broke.
- **Alerts:** "server down", "disk 80 % full", "abandon rate doubled". Start with these three.

## 9. Before every release: the checklist

```bash
node TEST_TELEOP/web/hand/test/run.mjs      # hand control on a synthetic hand
python -m vrteleop.test_teleop              # clutch mapping, smoothing
node scripts/replay_hand.mjs                # smoothness and lag on recorded real sessions
python -m TEST_TELEOP.check_config          # the configuration is valid
python -m TEST_TELEOP.screen_bot            # a scripted run through every task (grade A)
```

Then on staging, with a real webcam:
- the setup screen;
- one full run;
- the admin page shows it.

Only then production.

## 10. Where to learn more

- *The Twelve-Factor App* (12factor.net): how to build services that deploy cleanly. Short, read it first.
- Google's *Site Reliability Engineering* book (free online): monitoring, alerting, incidents.
- *Designing Data-Intensive Applications* (Kleppmann): when you outgrow one server and one database.
- Docker's "Get started" guide, then your load balancer's docs on **sticky sessions** and **websockets**.
