"""Demo data for the admin page: invented candidates with realistic results, in a folder of their
own (the real candidates are not touched). Each one is simulated from a random skill, learning and
tracking quality, then scored with the test's own grading and recommendation code, so the page
shows what a real round would look like: invited people who haven't started, tests in progress,
passes, fails, retests, skipped games.

    python scripts/demo_admin.py                      # 40 candidates into data/demo
    python -m TEST_TELEOP.lobby serve --data data/demo --port 8101
    then open http://localhost:8101/admin

Options: --n 60, --seed 7, --data <folder> (made afresh: anything in it is deleted).
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from TEST_TELEOP import grading as G        # noqa: E402
from TEST_TELEOP import lobby as L          # noqa: E402

FIRST = ["Anna", "Ben", "Chloe", "David", "Elif", "Felix", "Greta", "Hamza", "Ines", "Jonas", "Kaan", "Lea", "Mats",
         "Nora", "Omar", "Paula", "Quentin", "Rosa", "Samir", "Tara", "Umut", "Vera", "Wei", "Yara", "Zoe", "Luca",
         "Mila", "Noah", "Priya", "Tim", "Sofia", "Erik", "Aylin", "Jan", "Maja", "Ravi", "Lina", "Max", "Ida", "Can"]
LAST = ["Schmidt", "Weber", "Yilmaz", "Novak", "Rossi", "Kaya", "Fischer", "Meyer", "Haddad", "Wagner", "Becker",
        "Kowalski", "Hoffmann", "Sato", "Silva", "Klein", "Wolf", "Nguyen", "Braun", "Kumar"]
JOBS = ["Teleoperator", "Teleoperator", "Teleoperator (night shift)", "Robot operator"]


def simulate_game(key, phase, skill, learn, rng):
    """One game's metrics as screen_game.py writes them. skill 0..1: how fast and clean; learn
    -0.3..0.5: how much faster the later grasps get."""
    n = 3                                                     # 3 objects or 3 blocks
    limit, t, events = phase.limit, 0.0, []
    attempts = grasps = drops = wrong = falls = 0
    done = 0
    path = 0.0
    for i in range(n):
        speedup = 1 - learn * i / (n - 1)                    # later grasps quicker for a learner
        tries = 1 + int(rng.expovariate(0.35 + 2.0 * skill))  # grab attempts before one holds
        for _ in range(tries):
            t += max(2.0, rng.gauss(30 - 22 * skill, 6) * speedup)
            events.append([round(t, 2), "attempt"])
            attempts += 1
        if t > limit:
            break
        t += 0.8
        events.append([round(t, 2), "grasp", f"{key}_{i}"])
        grasps += 1
        path += rng.uniform(0.6, 1.6) * (1.6 - 0.8 * skill)
        t += max(3.0, rng.gauss(26 - 16 * skill, 5) * speedup)        # carry and place
        if rng.random() < 0.35 * (1 - skill):                         # dropped on the way
            drops += 1
            t += rng.uniform(5, 15)
        if key == "sort" and rng.random() < 0.15 * (1 - skill):
            wrong += 1
            continue
        if key == "tower" and i > 0 and rng.random() < 0.45 * (1 - skill):
            falls += 1
            t += rng.uniform(10, 30)                                  # picking it up again
        if t <= limit:
            done += 1
    completed = done == n and t <= limit
    m = dict(time_s=round(min(t, limit), 2), completed=completed, timed_out=not completed, steps_done=done,
             steps_total=n, grasp_attempts=attempts, grasps=grasps, drops=drops, path_m=round(path, 2),
             turn_deg=round(rng.uniform(20, 200)), clutches=rng.randint(1, 12), wrong_bin=wrong,
             episode="episode_0001.hdf5", tracking_glitches=rng.randint(0, 6), controller="hand", events=events)
    if key == "tower":
        block = 0.05
        m.update(height=round(done * block, 3), best_height=round(done * block, 3), falls=falls, blocks_used=n,
                 target_height=0.14, steps_done=round(min(1.0, done * block / 0.14), 3), steps_total=1)
    return m


def tracking_log(path: Path, fps, lost, latency, rng, seconds=120):
    """A hand_tracking.jsonl the quality check reads (no points: the shape only)."""
    with path.open("w", encoding="utf-8") as f:
        t = 10.0
        while t < 10 + seconds:
            hand = rng.random() > lost
            f.write(json.dumps({"t": round(t, 3), "lat": max(5, int(rng.gauss(latency, latency / 5))), "path": "worker",
                                "dg": "GPU", "cam": "front", "g": "open" if hand else "none", "d": 1,
                                "lm": [[0.5, 0.5]] if hand else None}) + "\n")
            t += 1 / fps


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--data", default=str(ROOT / "data" / "demo"))
    a = ap.parse_args()
    rng = random.Random(a.seed)
    data = Path(a.data).resolve()
    if data.exists():
        shutil.rmtree(data)
    L.set_data_dir(data)
    c = L.cfg()
    scored = c.scored_phases
    batch = time.strftime("%Y-%m")
    names = rng.sample([(f, l) for f in FIRST for l in LAST], a.n)
    invites, counts = [], {}
    for i, (first, last) in enumerate(names):
        name, email = f"{first} {last}", f"{first.lower()}.{last.lower()}@example.com"
        day = time.strftime("%Y-%m-%d", time.localtime(time.time() - rng.randint(1, 20) * 86400))
        kind = rng.choices(["not_started", "playing", "done", "unlisted"], [0.15, 0.07, 0.66, 0.12])[0]
        if kind != "unlisted":
            invites.append(dict(email=email, name=name, job=rng.choice(JOBS), invited_at=f"{day} 09:{rng.randint(10, 59)}"))
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "not_started":
            continue
        code = L.new_candidate(batch, name=name, email=email)
        if kind == "playing":
            continue
        # a person: skill, learning, and their computer's tracking
        skill = min(1.0, max(0.0, rng.betavariate(2.2, 2.2)))
        learn = rng.uniform(-0.3, 0.5)
        bad_pc = rng.random() < 0.12
        fps = rng.uniform(6, 11) if bad_pc else rng.uniform(18, 30)
        lost = rng.uniform(0.3, 0.5) if bad_pc and rng.random() < 0.5 else rng.uniform(0.02, 0.15)
        eff = skill * (0.45 if bad_pc else 1.0)
        metrics = {}
        for p in scored:
            m = simulate_game(p.key, p, eff, learn, rng)
            if rng.random() < 0.06 and not m["completed"]:
                m["ended_by"] = "skip"
            metrics[p.key] = m
        breakdown = {p.key: G.grade_task(metrics[p.key], p.limit, p.par_time, p.par_path, c.scoring) for p in scored}
        scores = {k: v["score"] for k, v in breakdown.items()}
        scores["breakdown"] = breakdown
        scores.update(G.summarize(breakdown, {p.key: p.weight for p in scored}, c.scoring["grades"]))
        folder = L.session_dir(code, L.candidate(code)) / "screen" / "attempt"
        folder.mkdir(parents=True, exist_ok=True)
        started = f"{day} {rng.randint(9, 18):02d}:{rng.randint(0, 59):02d}:00"
        finished = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.mktime(time.strptime(started, "%Y-%m-%d %H:%M:%S"))
                                                                        + 600 + sum(m["time_s"] for m in metrics.values())))
        res = dict(candidate=code, started_at=started, only=None, finished=True, phase="done", finished_at=finished,
                   config_sha="demo", scores=scores, metrics=metrics)
        (folder / "results.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
        tracking_log(folder / "hand_tracking.jsonl", fps, lost, rng.uniform(25, 60) if not bad_pc else rng.uniform(120, 380), rng)
        L.update_candidate(code, status="done", started=started, finished=finished)
    L.save_invites(invites)
    print(f"{a.n} demo candidates in {data}: " + ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in counts.items()))
    print(f"  python -m TEST_TELEOP.lobby serve --data \"{data}\" --port 8101   then   http://localhost:8101/admin")


if __name__ == "__main__":
    main()
