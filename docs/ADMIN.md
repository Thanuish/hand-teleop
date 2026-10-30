# Running the screening test: admin handbook

For the people who run rounds of the test and read the results. (How the system is built and changed:
[RUNNING_AND_UPDATING.md](RUNNING_AND_UPDATING.md).)

## What a candidate goes through

1. **The link.** Everyone gets the same link (the site's address). They enter their name and email, and
   tick the consent box. Each email can take the test **once**. If their connection drops, opening the link
   again in the same browser brings them back to their run.
2. **The setup screen** (about 2 minutes), which checks, in order:
   - camera on;
   - enough light;
   - the computer tracks fast enough (if not, it offers tracking on the server, or "continue anyway");
   - the hand inside the box at the right distance;
   - a fist (pause);
   - a pinch (close the gripper), then a pinch again (open it);
   - Q and E.
3. **The practice** (not scored): pick up a cube and put it in a square.
4. **The scored tasks:** shapes, sort by colour, rings on pegs, tower. Each starts with a card
   (what to do, which controls, the time limit) for 7 s, then a 3-second countdown.
5. **Done:** a thank-you page. The results are saved straight away.

The candidate never sees scores. Candidates who are stuck go to `/help` (linked from every page).

## The admin page

`/admin`. For now it opens only on the machine that runs the server; with Docker it gets a Google sign-in
for @sereact.ai accounts.

| Column | Meaning |
|---|---|
| Name, email | as the candidate typed them (email lowercased) |
| Status | `playing` (running now ●), `done`, `abandoned` (left without finishing), `reset` (retake allowed) |
| Task columns | each task's score 0–100 and steps done; **hover** for its four parts |
| Overall | the weighted mean of the tasks |
| Grade | A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F below |
| Skills C · S · P · E | completion, speed, precision, economy of motion, 0–100 over all tasks |
| Result | PASS / FAIL against the pass mark (set at the top of the page) |

**Download CSV** gives the same table for a spreadsheet.

### Reading the skill profile

The grade tells you *how good*; the profile tells you *why*:

- **High completion, low speed:** careful but slow. They often improve with practice.
- **High speed, low precision:** rushes, fumbles grasps, drops things.
- **Low economy:** wanders around and re-grabs, a sign they haven't really got the hand-to-robot mapping.
  That's the clearest single signal for teleoperation.
- **Low everything with high economy:** probably gave up early (they moved little).

### Retakes

**Allow retake** on a row lets that email take the test again. The old attempt is kept in its folder
(nothing is deleted); the new one gets a new row.

### Your own test runs

`/t/<token>` starts a fresh run each time without an email (the token is in
`data/screening/test_link.json`). Use it to try changes; those rows show as batch "Test runs".

## Tuning the scoring

All in `config/screening.toml`. The admin page saves the pass mark there itself.

- `par_time_s` per task: the time a good operator takes; at or under it, full speed marks. **Set these from
  real candidates:** after the first 10–20, take roughly the time of your good ones.
- `par_path_m` per task: the robot's path a clean operator needs. The same: set it from good candidates
  (their `path_m` is in each `results.json`).
- `weight` per task: its share of the overall score.
- `[scoring]` has the part weights (50/20/20/10), the penalties per drop, fall and wrong bin, `pass_mark`
  and the grade bands.

Changing these changes how new results compare with earlier ones. Each result records which configuration it
ran with (`screening.toml` is copied next to it), so you can always tell.

## Where things are

- `data/screening/screening.db`: the candidates (name, email, status, times).
- `data/screening/<batch>/<code>/`: one folder per run.
  - `results.json`: all metrics and scores.
  - `screening.toml`: the config it ran with.
  - `simulator.log`
  - `hand_tracking.jsonl`: the raw hand points, used to tune the smoothing.
  - the recorded episodes (`.hdf5`).
- Back up `data/` like any important folder: it is the only state.
