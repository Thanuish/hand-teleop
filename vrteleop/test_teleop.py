"""Checks for the clutch mapping (teleop.py) and the target smoothing (arms.py):
    python -m vrteleop.test_teleop

1. a long turn with rot_scale 0.5 (Q held 4 s at 90 deg/s: the hand side turns 360 deg): the
   gripper turns steadily to 180 deg, never jumping back (the turn since the anchor, taken the
   shortest way, flipped sides past 180 deg: the gripper jumped half round)
2. the critically damped smoother: a target in 33 ms steps comes out without steps (the speed
   changes gradually), without overshoot, and settles on the target
"""
import mujoco
import numpy as np

from vrteleop.arms import _smooth_damp
from vrteleop.teleop import ArmTeleop

failed = 0


def check(ok, what):
    global failed
    print(f"  {'ok  ' if ok else 'FAIL'}  {what}")
    failed += not ok


def yaw_quat(a):
    return [np.cos(a / 2), 0, 0, np.sin(a / 2)]


def yaw_of(q):
    w, x, y, z = q
    return np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


print("1. a 360 deg turn of the hand at rot_scale 0.5")
tel = ArmTeleop()
tel.rot_scale = 0.5
tel.reset([0.4, 0, 1.0], [1, 0, 0, 0])
yaws, t = [], 0.0
for k in range(121):                                     # 4 s at 30 samples a second
    a = np.radians(90) * k / 30
    tel.update({"pose": [0.4, 0, 1.0, *yaw_quat(a)], "grip": 1, "epoch": 1, "t": t}, 1 / 30)
    t += 1 / 30
    yaws.append(yaw_of(tel.target_quat))
unwrapped = np.unwrap(yaws)
steps = np.degrees(np.diff(unwrapped))
check(abs(np.degrees(unwrapped[-1]) - 180) < 1, f"the gripper turned {np.degrees(unwrapped[-1]):.1f} deg (want 180)")
check(steps.min() > 0 and steps.max() < 2, f"every step forward and small ({steps.min():.2f} to {steps.max():.2f} deg)")

print("2. the smoother on a target in 33 ms steps (10 cm/s), 100 control ticks a second")
x, v, xs = np.zeros(1), np.zeros(1), []
for k in range(300):
    target = np.array([0.1 * (k // 3.333) * (1 / 30) if k < 150 else 0.1 * (150 // 3.333) / 30])
    x, v = _smooth_damp(x, target, v, 0.05, 0.01)
    xs.append(float(x[0]))
vel = np.diff(xs) / 0.01
acc = np.diff(vel) / 0.01
final = 0.1 * (150 // 3.333) / 30
check(np.abs(acc[20:140]).max() < 4, f"while moving, the speed changes gradually (max accel {np.abs(acc[20:140]).max():.1f} m/s^2; "
                                      "the first-order lag it replaced: 7.9)")
check(max(xs) <= final + 1e-4, f"no overshoot ({(max(xs) - final) * 1000:.2f} mm past the target)")
check(abs(xs[-1] - final) < 1e-4, "settles on the target")

print(f"\n{failed} FAILED" if failed else "\nall passed")
raise SystemExit(1 if failed else 0)
