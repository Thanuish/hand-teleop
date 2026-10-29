// The hand control's tests, on a synthetic hand (synth.mjs) with MediaPipe-like noise:
//     node TEST_TELEOP/web/hand/test/run.mjs
// The real HandControl runs (frames in, the controller messages it would send out), with a clock
// stepped at 30 frames a second.
//   1. 'below' (a phone lying flat): moving the hand forward / left / up moves the gripper +x / +y
//      / +z; tilting the fingertips down, rolling the palm and twisting turn it about the right
//      axes, the right way; in tasks with only the turn, the doorknob twist turns it the right way
//   2. the wrist's position from all 21 joints (OAT) vs the palm only: noise while still, error
//      while the hand tilts about the wrist
//   3. grasp stabilization: a pinch or a release with the wrist still moves the output < 2 mm /
//      < 1 degree; a deliberate move with an open hand isn't frozen
//   4. the focal length estimated from the hand at hfov 70
//   5. a long session of pinches and clutches: no offset adds up, the robot never jumps
//   6. steady (the default): the hand's turn and tilt don't turn the gripper; the keys do, the right way
//   7. a 2-frame distance glitch doesn't make the robot lurch
//   8. gripMode 'pinchToggle': a pinch closes the gripper, the next opens it, the open hand drives
import { HandControl, matToQuat, SETTINGS } from '../core.js';
import { solveHandPose, PalmModel, PALM_IDS, solveWristPosition, estimateHfov, HandShape, hfovOf, quatToMat,
         logSO3, mulMM, T, len, sub, add } from '../pose3d.js';
import { camera, cols, rotX, rotY, rotZ, mulMV, focalOf } from './synth.mjs';

let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };
const deg = (r) => r * 180 / Math.PI;
const mm = (m) => (m * 1000).toFixed(1);

// ------------------------------------------------------------ a session: HandControl fed synthetic frames
function session({ mode = 'below', rotation = 'full', hfov = 60, seed = 3, grasp } = {}) {
  const cam = camera({ hfov, seed });
  let clock = 0;
  const sent = [];
  const st = { view_yaw: 0, task_game: { rotation, arm: 'right' } };
  const hc = new HandControl({ camera: mode, send: (m) => sent.push(m), status: () => st, now: () => clock });
  if (grasp) Object.assign(hc.stab, grasp);
  hc.video = { videoWidth: cam.W, videoHeight: cam.H };
  const frame = (R, t, shape, distort) => {
    clock += 1000 / 30;
    const v = cam.view(R, t, shape);
    if (distort) v.lm = distort(v.lm);
    hc._result({ lm: v.lm, wl: v.wl, t: clock, pose: null });
  };
  const last = () => { const r = sent.at(-1)?.right; return r ? { pos: r.pose.slice(0, 3), R: quatToMat(r.pose.slice(3)), epoch: r.epoch } : null; };
  return { cam, hc, frame, last, st, sent };
}
// 'below': the camera on the desk looking up (its z up); the hand 32 cm above it, palm down,
// fingers toward the image's top (= toward the computer screen), thumb to the image's right
const BELOW = cols([0, -1, 0], [1, 0, 0], [0, 0, 1]);      // hand frame (x fingers, y thumb, z back) -> camera
const WRIST = [0, 0.06, 0.32];
const ramp = (k, n) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, k / n));

/** the robot's rotation from a to b (world frame): axis (unit) and angle [deg] */
function turn(a, b) {
  const w = logSO3(mulMM(b, T(a))), ang = len(w);
  return { axis: ang > 1e-9 ? w.map(x => x / ang) : [0, 0, 0], deg: deg(ang) };
}

// ------------------------------------------------------------ 1. 'below': the mapping
console.log("1. 'below' (phone lying flat): the mapping (with the hand's rotation on: SETTINGS.handRotation)");
SETTINGS.handRotation = true;
{
  const s = session({ mode: 'below', rotation: 'full' });
  for (let k = 0; k < 40; k++) s.frame(BELOW, WRIST);       // the checklist: the hand open and still
  s.hc.arm(true);
  for (let k = 0; k < 30; k++) s.frame(BELOW, WRIST);       // (settles)
  const move = (dCam, label, want) => {
    const a = s.last();
    let p = WRIST;
    for (let k = 1; k <= 30; k++) { p = add(WRIST, dCam.map(x => x * ramp(k, 30))); s.frame(BELOW, p); }
    for (let k = 0; k < 20; k++) s.frame(BELOW, p);
    const b = s.last(), d = sub(b.pos, a.pos);
    const ax = d.map(Math.abs).indexOf(Math.max(...d.map(Math.abs)));
    check(ax === want[0] && Math.sign(d[ax]) === want[1] && b.epoch === a.epoch,
          `${label}: the gripper moved [${d.map(mm).join(', ')}] mm (want ${want[1] > 0 ? '+' : '-'}${'xyz'[want[0]]})`);
    for (let k = 1; k <= 30; k++) s.frame(BELOW, add(WRIST, dCam.map(x => x * (1 - ramp(k, 30)))));   // (back)
    for (let k = 0; k < 20; k++) s.frame(BELOW, WRIST);
  };
  move([0, -0.05, 0], 'hand 5 cm forward (toward the screen)', [0, 1]);
  move([0.05, 0, 0], 'hand 5 cm left', [1, 1]);
  move([0, 0, 0.05], 'hand 5 cm up', [2, 1]);
  const rotate = (Rh, label, wantAxis) => {
    const a = s.last();
    let R = BELOW;
    for (let k = 1; k <= 30; k++) { R = mulMM(BELOW, Rh(ramp(k, 30))); s.frame(R, WRIST); }
    for (let k = 0; k < 20; k++) s.frame(R, WRIST);
    const b = s.last(), r = turn(a.R, b.R);
    const i = r.axis.map(Math.abs).indexOf(Math.max(...r.axis.map(Math.abs)));
    check(i === wantAxis[0] && Math.sign(r.axis[i]) === wantAxis[1] && r.deg > 12,
          `${label}: the gripper turned ${r.deg.toFixed(1)} deg about [${r.axis.map(x => x.toFixed(2)).join(', ')}] (want ${wantAxis[1] > 0 ? '+' : '-'}${'xyz'[wantAxis[0]]})`);
    for (let k = 1; k <= 30; k++) s.frame(mulMM(BELOW, Rh(1 - ramp(k, 30))), WRIST);
    for (let k = 0; k < 20; k++) s.frame(BELOW, WRIST);
  };
  const a = 20 * Math.PI / 180;
  rotate((k) => rotY(a * k), 'fingertips 20 deg down', [1, 1]);     // (about the hand's left axis)
  rotate((k) => rotX(a * k), 'palm rolled 20 deg (thumb side up)', [0, 1]);
  rotate((k) => rotZ(a * k), 'twisted 20 deg (fingers to the left)', [2, 1]);
  console.log(`     (the focal length found during the checklist: hfov ${s.hc.hfov.toFixed(1)} deg; the camera's 60)`);
}
{
  const s = session({ mode: 'below', rotation: 'yaw', seed: 5 });
  for (let k = 0; k < 40; k++) s.frame(BELOW, WRIST);
  s.hc.arm(true);
  for (let k = 0; k < 30; k++) s.frame(BELOW, WRIST);
  const a = s.last();
  let R = BELOW;
  for (let k = 1; k <= 30; k++) { R = mulMM(BELOW, rotZ(25 * Math.PI / 180 * ramp(k, 30))); s.frame(R, WRIST); }
  for (let k = 0; k < 20; k++) s.frame(R, WRIST);
  const r = turn(a.R, s.last().R);
  check(r.axis[2] > 0.95 && r.deg > 15, `tasks with only the turn: the doorknob twist (25 deg, fingers left) turned the gripper ${r.deg.toFixed(1)} deg about [${r.axis.map(x => x.toFixed(2)).join(', ')}] (want +z)`);
}

SETTINGS.handRotation = false;
// ------------------------------------------------------------ 2. the wrist's position
console.log('2. the wrist position: all 21 joints (OAT eq. 2) vs the palm only');
for (const [label, Rh0, W0] of [["'below' (32 cm)", BELOW, WRIST], ["'front' (webcam, 45 cm)", cols([0, -1, 0], [1, 0, 0], [0, 0, 1]), [0.02, 0.05, 0.45]]]) {
  const cam = camera({ seed: 11 });
  const pm = new PalmModel(), shape = new HandShape(0.1);
  let sol = null, pA = null, pB = null;
  const est = (R, t) => {
    const v = cam.view(R, t);
    sol = solveHandPose(v.lm, v.wl, cam.W, cam.H, cam.f, pm, sol);
    if (!pm.ready) pm.add(v.wl, null, sol.facing);
    // OAT as in the paper: MediaPipe's 3D points of this frame
    const v0 = [v.wl[0].x, v.wl[0].y, v.wl[0].z];
    const a = solveWristPosition(v.lm, v.wl, cam.W, cam.H, cam.f, pA || sub(sol.wrist, v0), pA); pA = a.p;
    // as used: their shape averaged (HandShape), posed by the palm's rotation
    const vv = shape.update(v.wl, sol.R), w0 = [vv[0].x, vv[0].y, vv[0].z];
    const b = solveWristPosition(v.lm, vv, cam.W, cam.H, cam.f, pB || sub(sol.wrist, w0), pB); pB = b.p;
    return { palm: sol.wrist, raw: a.wrist, oat: b.wrist, truth: v.truth[0] };
  };
  for (let k = 0; k < 60; k++) est(Rh0, W0);                 // (the palm model and the shape learned)
  const still = { palm: [], raw: [], oat: [] }, tilt = { palm: [], raw: [], oat: [] };
  for (let k = 0; k < 300; k++) { const e = est(Rh0, W0); for (const m in still) still[m].push(e[m]); }
  for (let k = 0; k < 180; k++) {                            // tilting +-30 deg about the wrist, 3 s a cycle
    const e = est(mulMM(Rh0, rotY(30 * Math.PI / 180 * Math.sin(2 * Math.PI * k / 90))), W0);
    for (const m in tilt) tilt[m].push(len(sub(e[m], e.truth)));
  }
  const sd = (P) => { const c = P.reduce((s, x) => add(s, x), [0, 0, 0]).map(x => x / P.length); return Math.sqrt(P.reduce((s, x) => s + len(sub(x, c)) ** 2, 0) / P.length); };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const row = (m) => `still ${mm(sd(still[m]))} mm rms, tilting ${mm(mean(tilt[m]))} mm mean / ${mm(Math.max(...tilt[m]))} max`;
  console.log(`     ${label}:\n       palm only                        ${row('palm')}\n       all joints, this frame's 3D (paper)  ${row('raw')}\n       all joints, 3D shape averaged (used) ${row('oat')}`);
  check(mean(tilt.oat) <= mean(tilt.palm) * 1.05 && sd(still.oat) < 2 * sd(still.palm) && sd(still.oat) < sd(still.raw) / 2,
        `${label}: all joints (averaged shape) at least on par with the palm only while tilting, far steadier than the paper's per-frame version`);
}

// ------------------------------------------------------------ 3. grasp stabilization
// The same frames twice, noise and all (the synthetic camera's noise doesn't depend on the hand's
// shape): once with a pinch and a release, once with the hand open throughout; their outputs'
// difference is what the pinch did. The noise alone also moves the output (steps within its dead
// bands, ~1 deg / a few mm over seconds), differently in the two runs while one is held: so it is
// measured over 10 noise sequences, and the median of the pinch's effect must stay < 2 mm / 1 deg.
console.log('3. grasp stabilization (a pinch run against the same frames with the hand open, 10 noise sequences)');
const pinchEffect = (seed, on) => {
  const run = (pinching) => {
    const s = session({ mode: 'below', rotation: 'full', seed, grasp: on ? {} : { threshold: Infinity } });
    for (let k = 0; k < 40; k++) s.frame(BELOW, WRIST);
    s.hc.arm(true);
    for (let k = 0; k < 40; k++) s.frame(BELOW, WRIST);
    const out = [];
    const shape = (k) => !pinching ? {} : k <= 9 ? { pinch: k / 9 } : k <= 39 ? { pinch: 1 } : k <= 48 ? { pinch: 1 - (k - 39) / 9 } : {};
    for (let k = 1; k <= 80; k++) { s.frame(BELOW, WRIST, shape(k)); out.push(s.last()); }   // pinch 0.3 s, hold 1 s, release 0.3 s, 1 s more
    return { out, s };
  };
  const P = run(true), C = run(false);
  const at = (k) => ({ mm: len(sub(P.out[k].pos, C.out[k].pos)) * 1000, deg: turn(C.out[k].R, P.out[k].R).deg });
  const peak = P.out.reduce((m, o, k) => ({ mm: Math.max(m.mm, at(k).mm), deg: Math.max(m.deg, at(k).deg) }), { mm: 0, deg: 0 });
  return { held: at(38), after: at(79), peak, s: P.s };
};
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
for (const on of [true, false]) {
  const r = [...Array(10)].map((_, i) => pinchEffect(101 + i, on));
  const show = (k) => `${med(r.map(x => x[k].mm)).toFixed(1)} mm / ${med(r.map(x => x[k].deg)).toFixed(2)} deg (worst ${Math.max(...r.map(x => x[k].mm)).toFixed(1)} mm / ${Math.max(...r.map(x => x[k].deg)).toFixed(2)} deg)`;
  console.log(`     ${on ? 'with' : 'without'} stabilization, the pinch's effect (median of 10): pinched and held ${show('held')}; released ${show('after')}; peak on the way ${show('peak')}`);
  if (on) {
    check(med(r.map(x => x.held.mm)) < 2 && med(r.map(x => x.held.deg)) < 1,
          'a pinch with the wrist still (pinched and holding): the output moves < 2 mm / < 1 deg (median)');
    check(med(r.map(x => x.after.mm)) < 2 && med(r.map(x => x.after.deg)) < 1,
          'a release with the wrist still: the output moves < 2 mm / < 1 deg (median)');
    // a deliberate move with the hand open: followed, not frozen
    const s = r[0].s;
    let frozen = 0, p = WRIST;
    const c = s.last();
    for (let k = 1; k <= 15; k++) { p = add(WRIST, [0, -0.05 * ramp(k, 15), 0]); s.frame(BELOW, p); if (s.hc.stab.frozen) frozen++; }
    for (let k = 0; k < 15; k++) s.frame(BELOW, p);
    const d = sub(s.last().pos, c.pos);
    check(frozen === 0 && d[0] > 0.035, `a deliberate 5 cm move in 0.5 s with the hand open: followed (${mm(d[0])} mm forward), frozen on ${frozen} frames`);
  }
}

// ------------------------------------------------------------ 4. the focal length
console.log("4. the camera's focal length from the hand (OAT self-calibration, from the checklist's frames)");
for (const truth of [70, 50, 85]) {
  const got = [];
  for (const seed of [31, 32, 33]) {
    const cam = camera({ hfov: truth, seed });
    const frames = [];
    for (let k = 0; k < 60; k++) {                            // the checklist: the hand shown, moving a little
      const R = mulMM(BELOW, mulMM(rotY(0.25 * Math.sin(k / 9)), rotX(0.2 * Math.cos(k / 7))));
      const t = add(WRIST, [0.04 * Math.sin(k / 11), 0.03 * Math.cos(k / 13), 0.04 * Math.sin(k / 17)]);
      const v = cam.view(R, t);
      frames.push({ lm: v.lm, wl: v.wl });
    }
    got.push(estimateHfov(frames, cam.W, cam.H));
  }
  console.log(`     a camera with hfov ${truth}: estimated ${got.map(x => x.toFixed(1)).join(', ')} deg`);
  check(got.every(h => Math.abs(h - truth) / truth < 0.12), `hfov ${truth}: every estimate within 12 % (OAT reports ~15 % on real images)`);
}

// ------------------------------------------------------------ 5. a long session: pinches and clutches
// (on a real session the stabilizer's bias added up over the pinches, half a metre in depth, and
// the robot shot off by metres: it starts from zero at each clutch, where the robot re-anchors)
console.log('5. a long session: 40 pinches, each moved while held, then a clutch (fist)');
{
  const s = session({ mode: 'front', rotation: 'yaw', seed: 11 });
  const FRONT = cols([0, -1, 0], [-1, 0, 0], [0, 0, -1]);         // palm toward the webcam, fingers up
  const W0 = [0.02, 0.0, 0.45];
  for (let k = 0; k < 40; k++) s.frame(FRONT, W0);
  s.hc.arm(true);
  let maxB = 0, maxStep = 0, fists = 0, prev = null;
  const step = () => { const o = s.last(); if (o && prev && o.epoch === prev.epoch && s.sent.at(-1).right.grip) maxStep = Math.max(maxStep, len(o.pos.map((x, i) => x - prev.pos[i]))); prev = o; maxB = Math.max(maxB, len(s.hc.stab.b.slice(0, 3))); };
  let w = W0;
  for (let c = 0; c < 40; c++) {
    for (let k = 0; k < 25; k++) { s.frame(FRONT, w); step(); }
    for (let k = 1; k <= 4; k++) { s.frame(FRONT, w, { pinch: k / 4 }); step(); }          // a quick pinch
    for (let k = 0; k < 20; k++) { w = add(w, [0, 0.0015, 0.001]); s.frame(FRONT, w, { pinch: 1 }); step(); }   // carried 3 cm up, 2 cm back
    for (let k = 3; k >= 0; k--) { s.frame(FRONT, w, { pinch: k / 4 }); step(); }
    for (let k = 0; k < 15; k++) { s.frame(FRONT, w, { curl: 1 }); step(); if (s.hc.fist) fists++; }   // the clutch
    w = W0;                                                                                   // (the hand back where it started)
  }
  console.log(`     the stabilizer's offset at most ${mm(maxB)} mm; the robot's biggest step in one frame ${mm(maxStep)} mm; fist frames ${fists}`);
  check(fists > 0 && maxB < 0.08 && maxStep < 0.03, "the offset doesn't add up over the session (< 8 cm: one pinch-and-lift's worth; it was 85 cm) and the robot never jumps (< 3 cm in a frame)");
}

// ------------------------------------------------------------ 6. steady: the keys turn and tilt
console.log("6. steady (the default): the hand only moves the robot, the keys turn and tilt it");
{
  const s = session({ mode: 'below', rotation: 'full', seed: 13 });
  for (let k = 0; k < 40; k++) s.frame(BELOW, WRIST);
  s.hc.arm(true);
  for (let k = 0; k < 30; k++) s.frame(BELOW, WRIST);
  const a20 = 20 * Math.PI / 180;
  for (const [Rh, label] of [[rotY, 'fingertips down'], [rotX, 'palm rolled'], [rotZ, 'twisted']]) {
    const a = s.last();
    let R = BELOW;
    for (let k = 1; k <= 30; k++) { R = mulMM(BELOW, Rh(a20 * ramp(k, 30))); s.frame(R, WRIST); }
    for (let k = 0; k < 20; k++) s.frame(R, WRIST);
    const r = turn(a.R, s.last().R);
    check(r.deg < 1, `the hand ${label} 20 deg: the gripper turned ${r.deg.toFixed(2)} deg (want none)`);
    for (let k = 0; k < 30; k++) s.frame(BELOW, WRIST);
  }
  // the computer's keys, through the status (a phone as the camera), then this page's own (setTilt)
  const press = (keys, label, wantAxis, local = false) => {
    const a = s.last();
    if (local) s.hc.setTilt(keys.pitch || 0, keys.roll || 0, keys.turn || 0); else s.st.rot_keys = keys;
    for (let k = 0; k < 15; k++) s.frame(BELOW, WRIST);                       // (0.5 s held)
    if (local) s.hc.setTilt(0, 0, 0); else s.st.rot_keys = {};
    for (let k = 0; k < 5; k++) s.frame(BELOW, WRIST);
    const r = turn(a.R, s.last().R);
    const i = r.axis.map(Math.abs).indexOf(Math.max(...r.axis.map(Math.abs)));
    check(i === wantAxis[0] && Math.sign(r.axis[i]) === wantAxis[1] && r.deg > 20 && s.last().epoch === a.epoch,
          `${label}: the gripper turned ${r.deg.toFixed(1)} deg about [${r.axis.map(x => x.toFixed(2)).join(', ')}] (want ${wantAxis[1] > 0 ? '+' : '-'}${'xyz'[wantAxis[0]]})`);
  };
  press({ turn: 1 }, 'Q held 0.5 s (from the computer, a phone as the camera)', [2, 1]);
  press({ turn: -1 }, 'E held 0.5 s', [2, -1]);
  press({ pitch: 1 }, 'W held 0.5 s (tilt forward)', [1, 1]);
  press({ roll: 1 }, 'D held 0.5 s (tilt right)', [0, 1]);
  press({ turn: 1 }, 'Q held 0.5 s on this computer (its own camera)', [2, 1], true);
}

// ------------------------------------------------------------ 7. a distance glitch
// (on a real session the distance jumped 0.8 -> 1.3 m for a frame or two and back, the hand's size
// in the picture the same: the robot lurched 20-30 cm toward the screen and back)
console.log('7. two wrong frames (the hand seen 40 % farther for 2 frames): the robot does not lurch');
{
  const s = session({ mode: 'front', rotation: 'yaw', seed: 17 });
  const FRONT = cols([0, -1, 0], [-1, 0, 0], [0, 0, -1]);
  const W0 = [0.02, 0.0, 0.45];
  s.hc.gripMode = 'key';
  for (let k = 0; k < 40; k++) s.frame(FRONT, W0);
  s.hc.arm(true);
  for (let k = 0; k < 40; k++) s.frame(FRONT, W0);
  const a = s.last();
  let worst = 0;
  for (let k = 0; k < 30; k++) {
    // (the glitch: the points shrunk about the wrist, as if 40 % farther)
    const shrink = (lm) => lm.map(p => ({ x: lm[0].x + (p.x - lm[0].x) / 1.4, y: lm[0].y + (p.y - lm[0].y) / 1.4 }));
    s.frame(FRONT, W0, {}, k === 10 || k === 11 ? shrink : null);
    worst = Math.max(worst, len(sub(s.last().pos, a.pos)));
  }
  console.log(`     the robot moved at most ${mm(worst)} mm`);
  check(worst < 0.01, 'a 2-frame distance glitch moves the robot < 1 cm');
}

// ------------------------------------------------------------ 8. pinch to toggle the grip
console.log("8. gripMode 'pinchToggle': a pinch closes the gripper, the open hand drives it closed, the next pinch opens it");
{
  const s = session({ mode: 'front', rotation: 'yaw', seed: 19 });
  const FRONT = cols([0, -1, 0], [-1, 0, 0], [0, 0, -1]);
  const W0 = [0.02, 0.0, 0.45];
  s.hc.gripMode = 'pinchToggle';
  for (let k = 0; k < 40; k++) s.frame(FRONT, W0);
  s.hc.arm(true);
  for (let k = 0; k < 30; k++) s.frame(FRONT, W0);
  const closed = () => s.sent.at(-1).right.stick[1] > 0;
  const pinch = () => {
    for (let k = 1; k <= 4; k++) s.frame(FRONT, W0, { pinch: k / 4 });
    let drove = false;
    for (let k = 0; k < 15; k++) { s.frame(FRONT, W0, { pinch: 1 }); drove ||= !!s.sent.at(-1).right.grip; }
    for (let k = 3; k >= 0; k--) s.frame(FRONT, W0, { pinch: k / 4 });
    return drove;
  };
  check(!closed(), 'the gripper starts open');
  const drove1 = pinch();
  for (let k = 0; k < 30; k++) s.frame(FRONT, W0);
  check(closed() && !drove1, 'the first pinch closes it (the robot holds still while pinched)');
  const a = s.last();
  let w = W0;
  for (let k = 1; k <= 30; k++) { w = add(W0, [0, -0.05 * ramp(k, 30), 0]); s.frame(FRONT, w); }
  for (let k = 0; k < 20; k++) s.frame(FRONT, w);
  check(closed() && s.sent.at(-1).right.grip && s.last().pos[2] - a.pos[2] > 0.01,
        `the hand open again: it drives (moved ${mm(s.last().pos[2] - a.pos[2])} mm up), the gripper still closed`);
  for (let k = 0; k < 15; k++) s.frame(FRONT, w, { curl: 1 });     // a fist and open again: no toggle
  for (let k = 0; k < 30; k++) s.frame(FRONT, w);
  check(closed(), 'a fist (clutch) and the hand opened again: the gripper stays closed');
  for (let k = 1; k <= 4; k++) s.frame(FRONT, w, { pinch: k / 4 });
  for (let k = 0; k < 15; k++) s.frame(FRONT, w, { pinch: 1 });
  for (let k = 3; k >= 0; k--) s.frame(FRONT, w, { pinch: k / 4 });
  for (let k = 0; k < 30; k++) s.frame(FRONT, w);
  check(!closed() && s.sent.at(-1).right.grip, 'the second pinch opens it, and the open hand drives again');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
