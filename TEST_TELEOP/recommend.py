"""The recommendation for each candidate: invite to interview, trainable, not a fit now, or
retest, with the reasons in plain words. For the admin page and its report (lobby.py).

Inputs: the attempt's results.json (scores and metrics, screen_game.py) and the quality of its
hand tracking (quality(): from hand_tracking.jsonl, the browser's raw tracking log).

    skill        the overall score (grading.py), 0-100
    learning     does the candidate get better during the test? The time between successful
                 grasps, per task with at least MIN_GRASPS such gaps (not the tower: it gets
                 harder block by block), its later gaps against its earlier ones; and the grab
                 attempts per grasp over the whole test (both games, the tower too: aiming
                 doesn't get harder), the second half of the grasps against the first.
                 Weighted 60 / 40. 0-100: 50 = no change,
                 100 = 40 % faster or better, 0 = 40 % slower. None: not enough grasps to tell
    consistency  how far apart the task scores are (the spread, max - min)
    technical    the tracking: pictures per second, latency, how much of the time the hand
                 was lost, server tracking used, setup time

Verdict (the thresholds: [recommendation] in config/screening.toml, defaults below). With a
pass rule (passed: True / False, lobby.passed(): every must_complete game completed), it decides
the invitation: passed -> invite; not passed -> at most trainable, from the rules below.
    retest      technical trouble (too few pictures a second, the hand lost too often, too
                much latency) and not passed (or the skill below the invite mark): judge the
                person, not the webcam (an admin can allow a retake)
    invite      passed; without a pass rule: skill >= invite_skill, or skill >=
                invite_skill_learner with learning >= invite_learning (a strong learner)
    trainable   skill >= trainable_skill with learning >= trainable_learning, or skill >=
                consider_skill (solid, not (yet) improving), or skill >= trainable_skill_learner
                with learning >= trainable_learning_strong (low, but learning fast)
    not_now     otherwise
    incomplete  the test wasn't finished (no verdict)
Skipped tasks count with what was done (as in the scores); the report says which.
"""
from __future__ import annotations

import json
import statistics as st
from pathlib import Path

MIN_GRASPS = 2                   # (a game has 3 objects: 2 gaps between grasps)
QUALITY_VERSION = 2              # (bump when quality() measures differently: its caches are made again)

DEFAULTS = dict(invite_skill=70.0, invite_skill_learner=55.0, invite_learning=65.0,
                trainable_skill=40.0, trainable_learning=55.0, consider_skill=55.0,
                trainable_skill_learner=35.0, trainable_learning_strong=65.0,
                retest_fps=12.0, retest_lost=0.30, retest_latency_ms=300.0)

VERDICTS = {
    "invite": "Invite to interview",
    "trainable": "Trainable: consider",
    "not_now": "Not a fit now",
    "retest": "Retest suggested",
    "incomplete": "Incomplete",
}


# ---------------------------------------------------------------- learning
def curve(metrics: dict, task_keys: list[str], titles: dict) -> list[dict]:
    """Every successful grasp in order through the test: {task, title, i (grasp no. in the
    task), t (s into the task), cycle (s since the previous grasp or the task's start),
    attempts (grab attempts that led to it, when logged)}."""
    out = []
    for k in task_keys:
        ev = metrics.get(k, {}).get("events", [])
        prev, tries = 0.0, 0
        logged = any(e[1] == "attempt" for e in ev)
        i = 0
        for e in ev:
            if e[1] == "attempt":
                tries += 1
            elif e[1] == "grasp":
                i += 1
                out.append(dict(task=k, title=titles.get(k, k), i=i, t=e[0], cycle=round(e[0] - prev, 2),
                                attempts=max(1, tries) if logged else None))
                prev, tries = e[0], 0
    return out


def learning(points: list[dict], skip: set = frozenset()) -> dict:
    """The learning measure from curve(): per task, the second half against the first. skip:
    tasks that get harder as they go (the tower: each block higher up needs more care), where
    slowing down isn't a sign of anything (left out of the time part only)."""
    tasks = {}
    for p in points:
        if p["task"] not in skip:
            tasks.setdefault(p["task"], []).append(p)
    # time: the gaps between grasps (not the first one, from the task's start: only a reach to the
    # first object, while every later gap also places the one before, so it would always look
    # faster); a task needs MIN_GRASPS such gaps
    per, wsum, isum = {}, 0, 0.0
    for k, ps in tasks.items():
        gaps = [p["cycle"] for p in ps[1:]]
        if len(gaps) < MIN_GRASPS:
            continue
        h = len(gaps) // 2
        c0, c1 = st.median(gaps[:h]), st.median(gaps[h:])
        imp = (c0 - c1) / c0 if c0 > 0 else 0.0
        per[k] = dict(grasps=len(ps), early_cycle=round(c0, 1), late_cycle=round(c1, 1), improvement=round(imp, 3))
        wsum += len(gaps)
        isum += imp * len(gaps)
    time_imp = isum / wsum if wsum else None
    # tries: grab attempts per successful grasp, the test's first half of grasps against its second
    # (where logged); fewer tries later = better aim
    tried = [p["attempts"] for p in points if p["attempts"]]
    tries_imp = None
    if len(tried) >= 2 * MIN_GRASPS:
        h = len(tried) // 2
        a0, a1 = st.mean(tried[:h]), st.mean(tried[h:])
        tries_imp = (a0 - a1) / a0 if a0 > 0 else 0.0
    parts = [(0.6, time_imp), (0.4, tries_imp)]
    have = [(w, v) for w, v in parts if v is not None]
    if not have:
        return dict(score=None, improvement=None, tasks=per, time=None, tries=None)
    imp = sum(w * v for w, v in have) / sum(w for w, _ in have)
    return dict(score=round(max(0.0, min(100.0, 50 + 125 * imp)), 1), improvement=round(imp, 3), tasks=per,
                time=None if time_imp is None else round(time_imp, 3), tries=None if tries_imp is None else round(tries_imp, 3))


# ---------------------------------------------------------------- technical quality
def quality(jsonl: Path) -> dict | None:
    """The hand tracking's quality from the browser's raw log, cached next to it (quality.json,
    made again when the log changes)."""
    if not jsonl.exists():
        return None
    stamp = [jsonl.stat().st_size, int(jsonl.stat().st_mtime), QUALITY_VERSION]
    cache = jsonl.with_name("quality.json")
    try:
        c = json.loads(cache.read_text(encoding="utf-8"))
        if c.get("stamp") == stamp:
            return c
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    ts, lats, lost, total, server, paths, first_drive, last_drive = [], [], 0, 0, 0, {}, None, None
    for line in jsonl.open(encoding="utf-8", errors="replace"):
        try:
            f = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = f.get("t")
        if t is None:
            continue
        ts.append(t)
        paths[f.get("dg") or f.get("path") or "?"] = paths.get(f.get("dg") or f.get("path") or "?", 0) + 1
        if f.get("d"):
            first_drive = t if first_drive is None else first_drive
            last_drive = t
        # while driving the robot (and up to 3 s after: a hand lost mid-move counts; reading a
        # task's card or a break, the hand away on purpose, doesn't)
        if last_drive is not None and (f.get("d") or t - last_drive < 3.0):
            total += 1
            lost += f.get("lm") is None
            server += f.get("path") == "server"
            if f.get("lat") is not None and f.get("lm") is not None:
                lats.append(f["lat"])
    if len(ts) < 10:
        return None
    gaps = [b - a for a, b in zip(ts, ts[1:]) if 0 < b - a < 1.0]
    q = dict(stamp=stamp, frames=len(ts), duration_s=round(ts[-1] - ts[0], 1),
             fps=round(1 / st.median(gaps), 1) if gaps else None,
             latency_ms=round(st.median(lats)) if lats else None,
             lost=round(lost / total, 3) if total else None,
             server=round(server / total, 3) if total else 0.0,
             setup_s=round(first_drive - ts[0], 1) if first_drive is not None else None,
             device=max(paths, key=paths.get) if paths else None)
    try:
        cache.write_text(json.dumps(q), encoding="utf-8")
    except OSError:
        pass
    return q


def technical(q: dict | None, th: dict) -> list[str]:
    """The technical problems worth a retest (empty: none)."""
    if not q:
        return []
    out = []
    if q.get("fps") is not None and q["fps"] < th["retest_fps"]:
        out.append(f"the hand was tracked only {q['fps']:g} times a second (slow computer)")
    if q.get("lost") is not None and q["lost"] > th["retest_lost"]:
        out.append(f"the hand was lost {round(100 * q['lost'])} % of the time (light, camera, or out of view)")
    if q.get("latency_ms") is not None and q["latency_ms"] > th["retest_latency_ms"]:
        out.append(f"tracking delay {q['latency_ms']} ms")
    return out


# ---------------------------------------------------------------- the verdict
def recommend(res: dict | None, q: dict | None, scored: list, th: dict | None = None,
              passed: bool | None = None) -> dict:
    """res: results.json; q: quality(); scored: the config's scored phases (key, title);
    passed: the pass rule's answer (None: no pass rule, the score decides).
    {verdict, label, reasons: [...], skill, learning: {...}, consistency, technical: [...],
     curve: [...], skipped: [...]}."""
    th = {**DEFAULTS, **(th or {})}
    keys = [p.key for p in scored]
    titles = {p.key: p.title for p in scored}
    out = dict(verdict=None, label=None, reasons=[], skill=None, learning=None, consistency=None,
               technical=[], curve=[], skipped=[], quality=q)
    if not res:
        return out
    m, sc = res.get("metrics", {}), res.get("scores", {})
    pts = curve(m, keys, titles)
    lrn = learning(pts, skip={k for k in keys if "best_height" in m.get(k, {})})
    out.update(curve=pts, learning=lrn, skill=sc.get("overall"))
    out["skipped"] = [titles[k] for k in keys if m.get(k, {}).get("ended_by") == "skip"]
    scores = [sc[k] for k in keys if isinstance(sc.get(k), (int, float))]
    out["consistency"] = round(max(scores) - min(scores), 1) if len(scores) >= 2 else None
    out["technical"] = technical(q, th)
    if not res.get("finished") or res.get("only") or out["skill"] is None:
        out.update(verdict="incomplete", label=VERDICTS["incomplete"],
                   reasons=["The test was not finished." if not res.get("only") else "A test of one part only."])
        return out
    s, L = out["skill"], lrn["score"]
    why = out["reasons"]
    # skill, in words
    grade = sc.get("grade")
    why.append(f"Overall score {s:g} (grade {grade})." if grade else f"Overall score {s:g}.")
    sk = sc.get("skills") or {}
    if sk:
        best = max(sk, key=lambda k: sk[k] if sk[k] is not None else -1)
        worst = min(sk, key=lambda k: sk[k] if sk[k] is not None else 999)
        if sk.get(best) is not None and sk.get(worst) is not None and sk[best] - sk[worst] >= 15:
            why.append(f"Strongest at {best} ({sk[best]:g}), weakest at {worst} ({sk[worst]:g}).")
    # learning, in words
    if L is None:
        why.append("Not enough grasps to measure how they learned.")
    else:
        bits = []
        if lrn.get("time") is not None:
            t = round(100 * lrn["time"])
            bits.append(f"{abs(t)} % {'faster' if t >= 0 else 'slower'} between grasps later in the tasks")
        if lrn.get("tries") is not None:
            a = round(100 * lrn["tries"])
            bits.append(f"{abs(a)} % {'fewer' if a >= 0 else 'more'} grab tries per grasp in the second half of the test")
        detail = " (" + "; ".join(bits) + ")" if bits else ""
        pct = round(100 * lrn["improvement"])
        if pct >= 10:
            why.append(f"Learned during the test{detail}.")
        elif pct <= -10:
            why.append(f"Got worse as the test went on{detail}: tiring or struggling.")
        else:
            why.append(f"No clear learning trend{detail}.")
    if out["consistency"] is not None and out["consistency"] >= 45:
        why.append(f"Uneven: the task scores are {out['consistency']:g} points apart.")
    if out["skipped"]:
        why.append("Skipped: " + ", ".join(out["skipped"]) + " (what was done there still counts).")
    # the verdict
    if passed is not None:
        failed = [titles[k] for k in keys if not m.get(k, {}).get("completed")]
        why.insert(0, "Completed every game." if passed else
                   "Did not complete: " + ", ".join(failed) + "." if failed else "Below the pass mark.")
    if passed:
        v = "invite"
    elif out["technical"] and (passed is False or s < th["invite_skill"]):
        v = "retest"
        why.insert(0, "The tracking was poor: " + "; ".join(out["technical"]) + ". The score may not show their ability.")
    elif passed is None and s >= th["invite_skill"]:
        v = "invite"
    elif passed is None and s >= th["invite_skill_learner"] and L is not None and L >= th["invite_learning"]:
        v = "invite"
        why.insert(0, "A strong learner with a good score: worth an interview.")
    elif (s >= th["trainable_skill"] and L is not None and L >= th["trainable_learning"]) or s >= th["consider_skill"]:
        v = "trainable"
    elif s >= th["trainable_skill_learner"] and L is not None and L >= th["trainable_learning_strong"]:
        v = "trainable"
        why.insert(0, "A low score but learning fast: worth considering for training.")
    else:
        v = "not_now"
    out.update(verdict=v, label=VERDICTS[v])
    return out
