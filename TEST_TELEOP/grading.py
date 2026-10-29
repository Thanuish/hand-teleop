"""Grading: from a task's metrics (screen_game.py) to a score, a grade and a skill profile.

Each scored task gets four sub-scores, 0..1, weighted by [scoring] in config/screening.toml
(by default 50 / 20 / 20 / 10):

    completion  how much of the task was done: steps done / steps; a tower: its best height /
                the target height; rounds: items done / the target; buzz wire: how far along
    speed       only for a task that was completed: 1 at or under its par time (the time a
                capable operator takes: [[phases]] par_time_s), falling linearly to 0 at the time
                limit. In tasks that run until time is up (rounds, tower) the amount done
                already measures the pace: speed = completion there
    precision   grasps that lifted something / grasp attempts, times a penalty factor per
                mistake: drops (1 / drops_to_zero each), objects put in the wrong bin
                (wrong_bin_penalty each), tower falls (1 / falls_to_zero each); buzz wire:
                1 - touches / touches_to_zero
    economy     how directly the robot was moved: the par path ([[phases]] par_path_m, the
                robot's path for the whole task by a clean operator) x completion / the path
                moved; 1 at or under par. A phase without par_path_m: economy is left out and
                its weight shared out over the others

    task score = 100 x (sum of weight x sub-score) / (sum of the weights used)

The overall score is the mean of the tasks' scores, weighted by [[phases]] weight (default 1).
The skill profile is the same weighted mean of each sub-score over the tasks (0..100): it shows
what a candidate is good at (e.g. complete and precise but slow). The grade is a letter from
the overall score ([scoring] grades: A >= 85, B >= 70, C >= 55, D >= 40, else F).
"""
from __future__ import annotations

SKILLS = ("completion", "speed", "precision", "economy")
WEIGHT_KEY = {"completion": "steps", "speed": "time", "precision": "grasp", "economy": "economy"}


def _clip(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def completion(m: dict) -> float:
    if "best_height" in m:                                   # tower
        return _clip(m["best_height"] / max(1e-6, m["target_height"]))
    if "rounds" in m:                                        # rounds: over all of them
        return _clip(m["items_done"] / max(1, m["target_items"]))
    if "progress" in m:                                      # buzz wire
        return _clip(m["progress"])
    return _clip(m["steps_done"] / max(1, m["steps_total"]))


def speed(m: dict, limit: float, par: float, done: float) -> float:
    if "best_height" in m or "rounds" in m:                  # (as much as possible until time is up)
        return done
    if not m["completed"]:
        return 0.0
    t = m["time_s"]
    if t <= par:
        return 1.0
    return _clip((limit - t) / max(1e-6, limit - par))


def precision(m: dict, w: dict, done: float) -> float:
    if "touches" in m:                                       # buzz wire: a clean run
        return _clip(1 - m["touches"] / w["touches_to_zero"]) if done > 0 else 0.0
    a = m.get("grasp_attempts", 0)
    if not a:
        return 0.0
    rate = _clip(m.get("grasps", 0) / a)
    factor = (1 - m.get("drops", 0) / w["drops_to_zero"]) * (1 - m.get("wrong_bin", 0) * w["wrong_bin_penalty"])
    if "falls" in m:
        factor *= 1 - m["falls"] / w["falls_to_zero"]
    return _clip(rate * max(0.0, factor))


def economy(m: dict, par_path: float | None, done: float) -> float | None:
    if not par_path:
        return None
    path = m.get("path_m", 0.0)
    if done <= 0 or path <= 0:
        return 0.0
    return _clip(par_path * done / path)


def grade_task(m: dict, limit: float, par_time: float, par_path: float | None, w: dict) -> dict:
    """The four sub-scores (0..1) and the task's score (0..100) for one scored task."""
    done = completion(m)
    sub = {"completion": done, "speed": speed(m, limit, par_time, done),
           "precision": precision(m, w, done), "economy": economy(m, par_path, done)}
    used = {k: w[WEIGHT_KEY[k]] for k in SKILLS if sub[k] is not None}
    total = sum(used.values())
    score = 100 * sum(used[k] * sub[k] for k in used) / total if total else 0.0
    return {"score": round(score, 1), **{k: (None if v is None else round(v, 3)) for k, v in sub.items()}}


def letter(overall: float, grades: dict) -> str:
    for g in ("A", "B", "C", "D"):
        if overall >= grades[g]:
            return g
    return "F"


def summarize(tasks: dict, weights: dict, grades: dict) -> dict:
    """tasks: {key: grade_task(...)} for every scored task; weights: {key: phase weight}.
    The overall score, its grade and the skill profile (each 0..100)."""
    tw = sum(weights[k] for k in tasks) or 1.0
    overall = sum(weights[k] * tasks[k]["score"] for k in tasks) / tw
    skills = {}
    for s in SKILLS:
        have = [k for k in tasks if tasks[k][s] is not None]
        sw = sum(weights[k] for k in have)
        skills[s] = round(100 * sum(weights[k] * tasks[k][s] for k in have) / sw, 1) if sw else None
    return {"overall": round(overall, 1), "grade": letter(overall, grades), "skills": skills}
