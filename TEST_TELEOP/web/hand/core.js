// Hand control: a camera (a computer's webcam or any phone's) watches the candidate's hand, and
// the hand drives the robot arm. MediaPipe's Hand Landmarker (Google, Apache 2.0) finds the hand's
// 21 points in each frame, in a background thread of this browser; the video never leaves the
// device, only the hand's pose is sent, as the same controller input as a VR controller or the
// phone (so the server, the arm and the tasks don't change).
//
//   open hand   drives the robot (the clutch is held): the gripper follows the hand's motion
//   twist       the hand turned like a doorknob (palm still toward the camera) turns the gripper
//               left / right: measured in the flat image, where it is steady
//   tilt        in tasks with full rotation the hand's whole orientation counts (pose3d.js: the
//               palm's rigid points fitted in 3D and in the image, the forearm from MediaPipe Pose
//               when the palm turns edge-on): fingertips toward / away from the screen tilt the
//               gripper forward / back, the palm turned left / right tilts it sideways, the twist
//               still turns it. setTilt() (W/S, A/D) adds to that from the keyboard
//   steady      (SETTINGS.handRotation false, the default) the hand only moves the robot: its
//               turn and tilt are ignored (a hand's tremor and MediaPipe's guessed depth made the
//               gripper wobble), and the keys turn (Q/E) and tilt (W/S, A/D) it: setTilt() here,
//               or the computer's keys through the status (rot_keys) when a phone is the camera
//   fist        pauses: move the hand without moving the robot (like lifting a mouse), open again
//   pinch       (thumb and index finger together) closes the gripper; open the pinch to let go
//               (gripMode 'pinch'); with gripMode 'key' a key toggles the gripper instead
//               (toggleGrip(): the computer's SPACE bar); with gripMode 'pinchToggle' a pinch
//               toggles it: the first closes the gripper, the next opens it. While the fingers
//               are pinched the robot holds still (the pinch bends the hand); it drives again once
//               the hand is open, the gripper staying as the pinch left it
//
// Two camera placements (opts.camera):
//   'front'  the camera looks at the person from in front (the computer's webcam, or a phone
//            standing up): camera x = right in its image (the person's left), y = down, z = away
//            from the camera. MuJoCo: x forward (into the screen), y left, z up.
//   'below'  a phone lying flat on the desk, front camera up, the hand 25-40 cm above it, palm
//            down, fingers toward the computer screen (OAT's best view: bottom-up). The camera's
//            frame is fixed in the room: up = camera +z; forward = the palm's wrist -> middle
//            knuckle axis in the image plane, averaged while the checklist is done; left = up x
//            forward. G (rows forward, left, up) turns camera vectors into the robot's: position
//            G p, rotation G R G^T. No forearm here (the elbow isn't in view).
// Following OAT (Chen et al., ICRA 2026): the wrist's position from all 21 joints (pose3d.js
// solveWristPosition), grasp stabilization (GraspStabilizer), and the camera's focal length
// estimated from the hand during the checklist, then fixed.
export const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
export const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
// MediaPipe Pose (the light model): the elbow and wrist, for the forearm's direction
export const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
import { solveHandPose, PalmModel, PALM_IDS, forearm, ForearmFusion, OneEuroRot, BacklashRot, solveWristPosition,
         estimateHfov, HandShape, fingerShape, GraspStabilizer, hfovOf, focalOf } from './pose3d.js';

/** The part of the camera picture the hand must stay in (image 0..1): near its edges MediaPipe
 *  loses fingers and the pose jumps. The hand within `margin` of the edge is "near" (a warning);
 *  more than `outPoints` of its 21 points outside is "out" (the robot pauses, like a fist).
 *  palm: the wrist -> middle knuckle length as a share of the picture's width, the right range
 *  for an arm's length from the camera (shorter: too far, longer: too close). */
export const HAND_BOX = { x0: 0.1, y0: 0.06, x1: 0.9, y1: 0.94, margin: 0.04, outPoints: 3, palm: [0.09, 0.24] };

/** where the hand is against HAND_BOX: {inside, near, out, palm (its size), fit: 'far' | 'close' | 'ok'} */
export function boxState(lm, W, H) {
  const B = HAND_BOX;
  let outside = 0, near = false;
  for (const p of lm) {
    if (p.x < B.x0 || p.x > B.x1 || p.y < B.y0 || p.y > B.y1) outside++;
    else if (p.x < B.x0 + B.margin || p.x > B.x1 - B.margin || p.y < B.y0 + B.margin || p.y > B.y1 - B.margin) near = true;
  }
  const palm = Math.hypot(lm[9].x - lm[0].x, (lm[9].y - lm[0].y) * H / W);
  return { inside: outside === 0, near: near || outside > 0, out: outside > B.outPoints, palm,
           fit: palm < B.palm[0] ? 'far' : palm > B.palm[1] ? 'close' : 'ok' };
}

export const SETTINGS = {
  hfov: 60,                    // [deg] the camera's field of view until it is estimated (an error only scales the motion a little)
  hfovRange: [45, 90],         // [deg] the estimate is kept within this (OAT's self-calibration: rough)
  // estimate the field of view from the hand during the checklist (OAT): off. It worked on the
  // synthetic hand (within 12 %) but on a real webcam it ran to the bottom of its range every time
  // (30 deg; the real points don't fit its hand model well enough), and the wrong focal length made
  // the robot shakier. hfov above is used instead
  focalFromHand: false,
  // thumb-index tips / palm length: closed below pinchOn, open above pinchOff (hysteresis: no
  // flicker). On real sessions many pinches stopped at 0.32-0.38 (MediaPipe's tips don't quite
  // meet) and were missed: of the hand's dips below 0.36, three in four were followed by a
  // recognised pinch within 2 s (the person trying again); above 0.40 they were mostly noise
  pinchOn: 0.38, pinchOff: 0.5,
  pinchFrames: 3,              // gripMode 'pinchToggle': a pinch counts once seen this many frames in a row
  // One Euro filter (adaptive: steady when the hand is still, little lag when it moves)
  // (2026-11: both opened up: the robot lagged the hand by 0.17 s over all recordings and felt
  // sluggish; now 0.14 s, with the grasp roll-back gone (see grasp below) and the roughness while
  // moving down too. The dead band holds a still hand. depthMedian stays 5: at 3, two wrong frames
  // in a row won the median and the robot lurched 12 mm)
  pos: { minCutoff: 1.5, beta: 10, dCutoff: 1.0 },    // position [m]
  // distance from the camera (the noisiest) [m]. A calm speed estimate (dCutoff 0.5): with a fast
  // one the depth noise itself opened the filter up
  depth: { minCutoff: 0.6, beta: 4, dCutoff: 0.5 },
  rot: { minCutoff: 0.5, beta: 0.4, dCutoff: 1.0 },    // orientation (per rad/s)
  refDepth: { minCutoff: 0.15, beta: 0.5, dCutoff: 1.0 },   // the reference distance that scales left/right and up/down
  // a dead band ("backlash") after the filters: while the hand stays within this of where the
  // output is, nothing moves (a still hand holds the robot perfectly still); beyond it the output
  // follows from the band's edge (smoothly, no jump)
  deadPos: [0.003, 0.003, 0.012],   // [m] camera x (left/right), y (up/down), z (toward/away: the noisiest)
  deadCatchUp: 0.1,            // [s] once the hand really moves, the dead band's gap closes this fast (no trailing lag)
  deadRot: 2.0,                // [deg]
  twist: { minCutoff: 0.6, beta: 0.6, dCutoff: 1.0 },   // the doorknob turn (per rad/s)
  tiltRate: 60,                // [deg/s] how fast the tilt keys tilt the gripper
  turnRate: 90,                // [deg/s] how fast the turn keys (Q/E) turn it (the server halves both: hand_rotation_scale)
  handRotation: false,         // the hand's own turn and tilt drive the gripper; false: only the keys (steady)
  // after a fist (or a lost hand) the robot drives again only once the hand has been open this
  // many frames (~0.25 s): opening the hand changes its estimated centre, size and twist, and
  // the filters would carry that change into the robot; at that moment they start afresh
  settleFrames: 12,
  // the hand lost for a moment (under this long, while driving): the robot holds where it is and
  // carries on as soon as the hand is back (re-anchored there: no jump), instead of stopping and
  // settling again (on a real session the hand was lost on a third of the frames, mostly briefly)
  holdLost: 0.3,               // [s]
  // [s] the position output this far ahead along the hand's speed (makes up for the filters' lag).
  // Off: on real sessions it amplified the tracking noise (a third of the roughness while moving)
  lead: 0,
  depthMedian: 5,              // [frames] the distance: the median of this many (a wrong frame or two ignored)
  depthSpeed: 0.8,             // [m/s] ... and changing at most this fast (a hand toward / away from the camera)
  // the distance: this share from the hand's size in the picture (handPose), the rest from the 3D
  // palm solution. Far from the camera (a small hand) the palm solution trades distance for tilt,
  // and on a real session moving the hand sideways moved the robot forward / back nearly as much;
  // the size alone erred elsewhere. Their mean: the errors partly cancel (replayed, the forward
  // motion that came with sideways motion far away: 100 % of it -> 60 %) ...
  depthMix: 0.5,
  // ... and far from the camera, a change of distance that comes with a larger sideways motion is
  // mostly let go (it is that error, not the hand): the share kept is vz^2 / (vz^2 + (ratio x
  // sideways speed)^2), from none of this at the reference distance `near` [m] to all of it at
  // `far` (both together: 100 % -> 24 %; at a normal distance, 0.4-0.6 m, nothing changes)
  farGate: { near: 0.7, far: 1.1, ratio: 2.5, smooth: 0.25 },
  // the distance's motion is scaled by this before it goes out (forward / back on the robot): the
  // distance is the noisiest number, and the tasks need less reach forward than sideways
  depthGain: 0.75,
  leadSmooth: 0.4,             // (the speed for it: a running mean, this share of each new frame)
  // frames are scaled to this long side for the tracker. The tracker looks at the hand in a
  // 224 x 224 crop of the frame: a hand ~150 px tall in a 640 px frame is blown up (blurry
  // points); at 1280 it has the detail. (The models' cost doesn't depend on this.)
  maxFrame: 1280,
  // the hand's full orientation (tasks with full rotation): its filter and dead band
  rot3d: { minCutoff: 0.3, beta: 0.5, dCutoff: 1.0 },
  deadRot3d: 2.5,              // [deg]
  forearm: true,               // track the forearm too (MediaPipe Pose, a second model: a little slower)
  poseEvery: 3,                // run it on every n-th frame (the forearm moves slowly)
  // closing or opening the hand bends the palm (its arch) and moves the estimated wrist: OAT's
  // grasp stabilization holds the pose while the hand's shape changes (pose3d.js GraspStabilizer;
  // the threshold from synthetic tests: a still hand stays below 3.0, a 0.3 s pinch peaks above 4.7;
  // on a real session: an open hand p99 3.2, closing into a fist up to 3.8, pinches 2.5-5.5)
  // rollback: on tripping it went back to the pose from before the change (8 frames). Off
  // (2026-11): mid-motion that threw the robot back a few cm and it caught up again, the
  // jerkiness candidates felt; now it holds where it is (replayed: roughness while moving -27 %
  // over all recordings, -42 % on the newest; a still hand unchanged)
  grasp: { threshold: 3.4, window: 8, still: 10, smooth: 0.35, rollback: false },
  // the wrist's position: 'palm' (the palm solution) or 'oat' (all 21 joints, OAT eq. 2). 'palm':
  // replayed on a real session, 'oat' was a little shakier (1.9 vs 1.7 mm median; synthetic tests
  // had it on par)
  wristFrom: 'palm',
  wristSigV: 0.02,             // [m per frame] OAT's wrist position: its speed penalty
  shapeAvg: 0.1,               // the hand's shape for it: a running mean, this share of each new frame
  belowFrames: 15,             // 'below': frames that set the forward direction (after a switch)
  logEvery: 2.0,               // [s] with opts.log: the raw tracking (points only) sent this often
};
// the hand's frame (the camera's, palm toward it) -> the gripper's (pointing down): the palm's
// normal toward the camera is the gripper's down, the fingers (up) its forward. So the doorknob
// twist turns the gripper about the vertical, as in the tasks with only that turn
const HAND_TO_MJ = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];

// ------------------------------------------------------------ small math
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mulMV = (M, v) => M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const mulMM = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
export const CAM_TO_MJ = [[0, 0, -1], [1, 0, 0], [0, -1, 0]];   // MuJoCo vector = this x camera vector
export function matToQuat(R) {        // -> [w, x, y, z]
  const tr = R[0][0] + R[1][1] + R[2][2];
  let w, x, y, z;
  if (tr > 0) { const s = 2 * Math.sqrt(tr + 1); w = s / 4; x = (R[2][1] - R[1][2]) / s; y = (R[0][2] - R[2][0]) / s; z = (R[1][0] - R[0][1]) / s; }
  else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) { const s = 2 * Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]); w = (R[2][1] - R[1][2]) / s; x = s / 4; y = (R[0][1] + R[1][0]) / s; z = (R[0][2] + R[2][0]) / s; }
  else if (R[1][1] > R[2][2]) { const s = 2 * Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]); w = (R[0][2] - R[2][0]) / s; x = (R[0][1] + R[1][0]) / s; y = s / 4; z = (R[1][2] + R[2][1]) / s; }
  else { const s = 2 * Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]); w = (R[1][0] - R[0][1]) / s; x = (R[0][2] + R[2][0]) / s; y = (R[1][2] + R[2][1]) / s; z = s / 4; }
  return [w, x, y, z];
}

// ------------------------------------------------------------ One Euro filter (Casiez et al. 2012)
const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };
export class OneEuro {
  constructor({ minCutoff, beta, dCutoff }) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.reset(); }
  reset() { this.x = null; this.dx = null; this.t = null; }
  /** x: an array (a vector); speed(dx): its speed, for the adaptive cutoff */
  filter(x, t, speed = (d) => Math.hypot(...d)) {
    if (this.x === null || t - this.t > 0.5) { this.x = x.slice(); this.dx = x.map(() => 0); this.t = t; return this.x; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const a_d = alpha(this.dCutoff, dt);
    this.dx = x.map((v, i) => this.dx[i] + a_d * ((v - this.x[i]) / dt - this.dx[i]));
    const a = alpha(this.minCutoff + this.beta * speed(this.dx), dt);
    this.x = x.map((v, i) => this.x[i] + a * (v - this.x[i]));
    return this.x;
  }
}

// ------------------------------------------------------------ dead band (backlash)
/** A vector that moves only when the input leaves a band around it (half-widths per axis: an
 *  ellipsoid), and then just enough to keep the input on the band's edge: tiny wobbles are
 *  ignored, motion is kept. catchUp [s] (with dt): once the input has left the band (a real
 *  move) the output also closes the band's gap with this time constant, so a moving hand isn't
 *  trailed a band's width behind and a stopped one isn't stopped short; caught up, it holds again. */
export class Backlash {
  constructor(widths, catchUp = 0) { this.w = widths; this.catchUp = catchUp; this.x = null; this.moving = false; }
  reset() { this.x = null; this.moving = false; }
  filter(v, dt = 0) {
    if (this.x === null) { this.x = v.slice(); return this.x; }
    let d = v.map((u, i) => u - this.x[i]);
    let n = Math.hypot(...d.map((u, i) => u / this.w[i]));       // (1 = on the band's edge)
    if (n > 1) { this.x = this.x.map((u, i) => u + d[i] * (1 - 1 / n)); this.moving = true; d = d.map(u => u / n); n = 1; }
    if (this.moving && this.catchUp > 0 && dt > 0) {
      const a = 1 - Math.exp(-dt / this.catchUp);
      this.x = this.x.map((u, i) => u + d[i] * a);
      if (n * (1 - a) < 0.25) this.moving = false;                 // (caught up: hold here)
    }
    return this.x;
  }
}
/** The same for an orientation (quaternion w, x, y, z): it turns only past `deg`. */
export class BacklashQuat {
  constructor(deg) { this.rad = deg * Math.PI / 180; this.q = null; }
  reset() { this.q = null; }
  filter(q) {
    if (this.q === null) { this.q = q.slice(); return this.q; }
    let dot = q[0] * this.q[0] + q[1] * this.q[1] + q[2] * this.q[2] + q[3] * this.q[3];
    if (dot < 0) { q = q.map(x => -x); dot = -dot; }
    const ang = 2 * Math.acos(Math.min(1, dot));
    if (ang > this.rad) {                                   // (slerp toward q, keeping `rad` behind it)
      const f = 1 - this.rad / ang, th = ang / 2;
      const a = Math.sin((1 - f) * th) / Math.sin(th), b = Math.sin(f * th) / Math.sin(th);
      const r = this.q.map((x, i) => a * x + b * q[i]);
      const n = Math.hypot(...r);
      this.q = r.map(x => x / n);
    }
    return this.q;
  }
}

// ------------------------------------------------------------ the hand's pose and gesture
// the bones of the palm: their real length (MediaPipe's 3D hand, metres) against their length in
// the image gives the hand's distance from the camera
const PALM = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 17]];
export const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
                      [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

/** One frame: lm (21 image points 0..1), wl (21 3D points [m]), W x H the image, f the focal
 *  length in image widths. In the camera frame: pos (the palm's centre [m]), D (its distance),
 *  R (hand axes as columns: a = wrist -> middle knuckle, b = index -> pinky knuckle, n = palm
 *  normal), pinch (thumb-index tips / palm length), curled (how many of middle, ring, pinky are
 *  folded in: 3 = a fist). */
export function handPose(lm, wl, W, H, f) {
  const P = (i) => [lm[i].x, lm[i].y * H / W];
  const Q = (i) => [wl[i].x, wl[i].y, wl[i].z];
  let real = 0, img = 0;
  for (const [a, b] of PALM) {
    real += len(sub(Q(b), Q(a)));
    img += Math.hypot(P(b)[0] - P(a)[0], P(b)[1] - P(a)[1]);
  }
  const D = f * real / Math.max(img, 1e-4);
  const c = [0, 5, 9, 13, 17].map(P).reduce((s, p) => [s[0] + p[0] / 5, s[1] + p[1] / 5], [0, 0]);
  const pos = [(c[0] - 0.5) * D / f, (c[1] - 0.5 * H / W) * D / f, D];
  const a = norm(sub(Q(9), Q(0)));
  let b = norm(sub(Q(17), Q(5)));
  const n = norm(cross(a, b));
  b = cross(n, a);
  const R = [[a[0], b[0], n[0]], [a[1], b[1], n[1]], [a[2], b[2], n[2]]];
  const palm = Math.max(len(sub(Q(9), Q(0))), 1e-3);
  const pinch = len(sub(Q(4), Q(8))) / palm;
  // a finger is folded in when its tip is closer to the wrist than its knuckle is (plus a little)
  const folded = (tip, knuckle) => len(sub(Q(tip), Q(0))) < 1.15 * len(sub(Q(knuckle), Q(0)));
  let curled = 0;
  for (const [tip, knuckle] of [[12, 9], [16, 13], [20, 17]]) if (folded(tip, knuckle)) curled++;
  const indexFolded = folded(8, 5);
  return { pos, D, R, a, n, pinch, curled, indexFolded };
}

// ------------------------------------------------------------ the tracker (background thread)
let shared = null;                   // one tracker per page, loaded once (preload() at page open)

/** The hand model's bytes (7.8 MB), kept in this browser's storage: its server lets browsers reuse
 *  it for an hour only, so a refresh fetched it again. null: no storage (then by its address). */
let modelBytes = null;
function loadModel() {
  return modelBytes ??= (async () => {
    try {
      const c = await caches.open('hand-model-v1');
      let r = await c.match(MODEL);
      if (!r) {
        r = await fetch(MODEL);
        if (!r.ok) return null;
        await c.put(MODEL, r.clone());
      }
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) { return null; }
  })();
}
/** Start loading the tracker now (the ~17 MB engine and model take a few seconds the first time;
 *  afterwards the browser has them). Resolves with {delegate} or rejects. */
export function preload({ forearm = SETTINGS.forearm } = {}) {
  if (shared) return shared.ready;
  const worker = new Worker(new URL('./worker.js', import.meta.url));
  const s = shared = { worker, busy: false, onResult: null, delegate: null };
  s.ready = new Promise((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') { s.delegate = m.delegate; resolve(m); }
      else if (m.type === 'result') { s.busy = false; s.onResult?.(m); }
      else if (m.type === 'error') { s.busy = false; if (!s.delegate) reject(new Error(m.message)); else console.warn('hand tracker:', m.message); }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'the hand tracker could not start'));
  });
  loadModel().then((bytes) => worker.postMessage({ type: 'init', mp: MP, model: MODEL, modelBuffer: bytes ? bytes.slice() : null,
                                                    poseModel: forearm ? POSE_MODEL : null }));
  return s.ready;
}

// ------------------------------------------------------------ the tracker (this page's thread)
// MediaPipe's own way: the video element itself, on this page's thread. On some phones the
// background thread's way (frames copied into ImageBitmaps, the graphics chip from a worker) took
// 200 ms a frame (under 4 fps) on a real phone; on some phones the processor (CPU) is faster than
// the browser's graphics chip, too. opts.tracker 'auto' times them all and keeps the fastest.
const mains = {};                    // 'main' (graphics chip, else the processor) | 'cpu' (the processor)
export function preloadMain(kind = 'main') {
  if (mains[kind]) return mains[kind].ready;
  const m = mains[kind] = { hands: null, delegate: null, lastT: 0 };
  m.ready = (async () => {
    const { HandLandmarker, FilesetResolver } = await import(`${MP}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const bytes = await loadModel();
    let err = null;
    for (const delegate of kind === 'cpu' ? ['CPU'] : ['GPU', 'CPU']) {
      try {
        m.hands = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { ...(bytes ? { modelAssetBuffer: bytes.slice() } : { modelAssetPath: MODEL }), delegate },
          runningMode: 'VIDEO', numHands: 1,
          minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4 });
        m.delegate = delegate;
        return { delegate };
      } catch (e) { err = e; }
    }
    m.failed = true;
    throw err;
  })();
  return m.ready;
}

/** Hand control. opts:
 *    send(msg)      to the simulator (the controller input)
 *    status()       the simulator's last status (arm, view_yaw, task_game.rotation)
 *    onFrame(state) after each frame: {tracked, lm, gesture: 'open' | 'fist' | 'pinch' | 'none',
 *                   driving, gripping, depth, fps, latency (camera -> result, ms)}
 *    tracker        'worker' (the default: a background thread, the 3D view never waits for it),
 *                   'main' (this page's thread), 'cpu' (this page's thread, the processor) or
 *                   'auto' (all three timed on the first frames, the fastest kept: a phone)
 *  start(video) with a playing <video>; arm(true) to start sending (after the checklist). */
export class HandControl {
  constructor(opts) {
    this.opts = opts;
    this.camera = opts.camera || 'front';         // 'front' | 'below' (see the top of this file)
    this.now = opts.now || (() => performance.now());   // (the clock: the tests run faster than real time)
    this.f = focalOf(SETTINGS.hfov);             // the focal length (image widths): estimated, then fixed
    this.ckFrames = [];                           // the checklist's frames (an open hand): the focal length from them
    this.shape = new HandShape(SETTINGS.shapeAvg);
    this.wristP = null;                           // OAT's wrist translation, last frame
    this.stab = new GraspStabilizer(SETTINGS.grasp);
    this.outHist = [];
    this.G = null;                                // 'below': camera -> robot (rows forward, left, up)
    this.fwd = [];                                // ('below': the palm's forward in the image, recent frames)
    this.gripMode = opts.gripMode || 'pinch';     // 'pinch': the pinch grips; 'key': toggleGrip() does;
                                                  // 'pinchToggle': each pinch closes / opens it
    if (this.gripMode === 'key') this.stab.threshold = Infinity;   // (no pinch: nothing for the grasp stabilization to hold)
    this.armed = false;
    this.fist = false;
    this.pinched = false;                         // the gripper closed
    this.pinchHeld = false;                       // ('pinchToggle': the fingers pinched now)
    this.pinchCount = 0;
    this.epoch = 1;
    this.lastRot = 'yaw';
    this.lastVY = 0;
    this.fPos = new OneEuro(SETTINGS.pos);
    this.fDepth = new OneEuro(SETTINGS.depth);
    this.fRot = new OneEuro(SETTINGS.rot);
    this.fRef = new OneEuro(SETTINGS.refDepth);
    this.fTwist = new OneEuro(SETTINGS.twist);
    this.twist = null;                            // the doorknob turn [rad] (unwrapped, then held in a dead band)
    this.twistRaw = null;
    this.pitch = 0; this.roll = 0;                // from the tilt keys [rad]
    this.tilt = { pitch: 0, roll: 0, turn: 0 };   // the keys held: -1, 0, +1
    this.keyYaw = 0;                              // from the turn keys [rad]
    this.lastT = null;
    this.bPos = new Backlash(SETTINGS.deadPos, SETTINGS.deadCatchUp);
    this.bRot = new BacklashQuat(SETTINGS.deadRot);
    this.frames = [];
    // the full 3D pose (pose3d.js)
    this.palm = new PalmModel();                   // this person's palm, learned while it faces the camera
    this.sol = null;                               // the last frame's solution
    this.fusion = new ForearmFusion();
    this.fRot3 = new OneEuroRot(SETTINGS.rot3d);
    this.bRot3 = new BacklashRot(SETTINGS.deadRot3d);
    this.lastPose = null;
    this.frameNo = 0;
    this.lostAt = null;                            // (the hand lost since [s], see SETTINGS.holdLost)
    this.holding = false;
    this.log = [];
    this.lastLog = null;
  }

  async start(video) {
    this.video = video;
    const want = this.opts.tracker || 'worker';
    this.path = want === 'auto' ? 'worker' : want;
    // 'auto': each way on BENCH frames (after a few to warm up), then the fastest (frame to result)
    const BENCH = 24, ORDER = ['worker', 'main', 'cpu'];
    this.bench = want === 'auto' ? { worker: [], main: [], cpu: [] } : null;
    await (this.path === 'worker' ? preload() : preloadMain(this.path));
    if (want === 'auto') for (const k of ['main', 'cpu']) preloadMain(k).catch(() => {});   // (they load meanwhile)
    const took = (ms) => {
      const b = this.bench;
      if (!b) return;
      const arr = b[this.path];
      arr.push(ms);
      if (arr.length < BENCH + 4) return;
      const next = ORDER.slice(ORDER.indexOf(this.path) + 1).find(k => mains[k]?.hands);
      if (next) { this.path = next; return; }
      if (ORDER.slice(ORDER.indexOf(this.path) + 1).some(k => mains[k] && !mains[k].hands && !mains[k].failed)) return;   // (still loading)
      const med = (a) => [...a.slice(4)].sort((x, y) => x - y)[a.length - 4 >> 1];
      this.bench = null;
      this.benchResult = Object.fromEntries(ORDER.filter(k => b[k].length > 4).map(k => [k, Math.round(med(b[k]))]));
      this.path = Object.entries(this.benchResult).sort((x, y) => x[1] - y[1])[0][0];
    };
    shared && (shared.onResult = (m) => { if (this.path === 'worker') { took(this.now() - m.t); this._result(m); } });
    this.running = true;
    const canvas = document.createElement('canvas');
    this._pump = () => {
      if (!this.running) return;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(this._pump);
      else requestAnimationFrame(this._pump);
      if (video.readyState < 2 || !video.videoWidth) return;
      if (this.path === 'server') { this._sendToServer(video); return; }
      if (this.path !== 'worker') {
        const mt = mains[this.path];
        if (!mt?.hands) return;
        const t = performance.now();
        mt.lastT = Math.max(mt.lastT + 1, Math.round(t));
        let r = null;
        try { r = mt.hands.detectForVideo(video, mt.lastT); } catch (e) { console.warn('hand tracker:', e); }
        const ms = performance.now() - t;
        took(ms);
        this._result({ t, lm: r?.landmarks?.[0] || null, wl: r?.worldLandmarks?.[0] || null, pose: null, ms });
        return;
      }
      if (!shared || shared.busy) return;                // (only the newest frame: no queue)
      shared.busy = true;
      const k = Math.min(1, (this.opts.maxFrame || SETTINGS.maxFrame) / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
      const t = performance.now();
      // (the forearm only matters when the hand's own rotation drives the gripper: otherwise the
      // Pose model would only take the graphics chip's time from the hand tracker)
      const pose = SETTINGS.forearm && SETTINGS.handRotation && this.opts.forearm !== false && this.camera === 'front'
        && (this.frameNo++ % SETTINGS.poseEvery === 0);
      const send = (bmp) => shared.worker.postMessage({ type: 'frame', bitmap: bmp, t, pose }, [bmp]);
      createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }).then(send).catch(() => {
        canvas.width = w; canvas.height = h;                 // (older browsers: through a canvas)
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        createImageBitmap(canvas).then(send).catch(() => { shared.busy = false; });
      });
    };
    this._pump();
    this._keyTimer = setInterval(() => this._keyTick(), 16);
  }

  stop() { this.running = false; clearInterval(this._keyTimer); this.srv?.ws.close(); if (shared) shared.onResult = null; }

  /** Track on the server instead (TEST_TELEOP/tracker.py): for a computer too slow to track the
   *  hand itself. The camera's pictures go to url (a websocket) as JPEGs, at most two on the way;
   *  the landmarks come back and go through _result like the browser's own. Resolves once the
   *  server answers the first picture (its tracker takes a few seconds to start). */
  useServer(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.srv = { ws, inflight: 0, canvas: null, first: resolve };
      ws.onopen = () => { this.path = 'server'; this.bench = null; };
      ws.onerror = () => reject(new Error('could not reach the server tracker'));
      ws.onclose = () => { if (this.path === 'server') this.path = 'worker'; };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        this.srv.inflight = Math.max(0, this.srv.inflight - 1);
        if (this.srv.first) { this.srv.first(); this.srv.first = null; }
        this._result({ t: m.t, lm: m.lm, wl: m.wl, pose: null, ms: m.ms });
      };
    });
  }
  _sendToServer(video) {
    const s = this.srv;
    if (!s || s.ws.readyState !== 1 || s.inflight >= 2 || s.encoding) return;
    const w = 640, h = Math.round(640 * video.videoHeight / video.videoWidth);
    s.canvas ??= typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    s.canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    const t = performance.now();
    s.encoding = true;
    const blob = s.canvas.convertToBlob ? s.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
      : new Promise(r => s.canvas.toBlob(r, 'image/jpeg', 0.75));
    blob.then(b => b.arrayBuffer()).then((jpeg) => {
      const msg = new Uint8Array(8 + jpeg.byteLength);
      new DataView(msg.buffer).setFloat64(0, t, true);
      msg.set(new Uint8Array(jpeg), 8);
      if (s.ws.readyState === 1) { s.ws.send(msg); s.inflight++; }
    }).finally(() => { s.encoding = false; });
  }
  /** the tilt keys held now: pitch +1 forward / -1 back, roll +1 right / -1 left */
  setTilt(pitch, roll, turn = 0) { this.tilt = { pitch, roll, turn }; }
  /** gripMode 'key' (or any mode but 'pinch'): close the gripper if open, open it if closed */
  toggleGrip() { this.pinched = !this.pinched; return this.pinched; }
  arm(on) {
    if (on && !this.armed) {
      // the camera's focal length, estimated from the checklist's frames (OAT's self-calibration), then fixed
      if (SETTINGS.focalFromHand && this.ckFrames.length >= 20) {
        const [lo, hi] = SETTINGS.hfovRange;
        try {
          const h = estimateHfov(this.ckFrames, this.video.videoWidth, this.video.videoHeight);
          this.f = focalOf(Math.max(lo, Math.min(hi, h)));
          this.wristP = null;
        } catch (e) { /* (keep the guess) */ }
      }
      if (this.camera === 'below') this.G = this._frameBelow();
    }
    this.armed = on;
    this.epoch++;
  }
  /** the camera's placement ('front' | 'below'); 'below' takes its forward direction anew */
  setCamera(mode) {
    if (mode === this.camera) return;
    this.camera = mode;
    this.G = null; this.fwd = [];
    this.fusion.reset(); this.pose = null;
    this.epoch++;
  }
  /** 'below': G from the palm's forward direction (the recent frames' mean, in the image plane) */
  _frameBelow() {
    let fx = 0, fy = 0;
    for (const [x, y] of this.fwd) { fx += x; fy += y; }
    const n = Math.hypot(fx, fy);
    if (n < 1e-6) { fx = 0; fy = -1; } else { fx /= n; fy /= n; }   // (none seen: the image's up)
    return [[fx, fy, 0], [-fy, fx, 0], [0, 0, 1]];                  // forward; left = up x forward; up
  }
  /** the filters' and dead bands' states (for the grasp stabilization's roll-back) */
  _snapshot() {
    const e = (f) => ({ x: f.x && f.x.slice(), dx: f.dx && f.dx.slice(), t: f.t });
    return { pos: e(this.fPos), depth: e(this.fDepth), ref: e(this.fRef), tw: e(this.fTwist),
             rot: { R: this.fRot3.R, w: this.fRot3.w.slice(), t: this.fRot3.t },
             bPos: this.bPos.x && this.bPos.x.slice(), bRot: this.bRot3.R, twist: this.twist };
  }
  _restore(o) {
    const put = (f, v) => { f.x = v.x && v.x.slice(); f.dx = v.dx && v.dx.slice(); f.t = v.t; };
    put(this.fPos, o.pos); put(this.fDepth, o.depth); put(this.fRef, o.ref); put(this.fTwist, o.tw);
    this.fRot3.R = o.rot.R; this.fRot3.w = o.rot.w.slice(); this.fRot3.t = o.rot.t;
    this.bPos.x = o.bPos && o.bPos.slice(); this.bRot3.R = o.bRot; this.twist = o.twist;
  }
  /** the focal length now and how it was set (for the screen) */
  get hfov() { return hfovOf(this.f); }

  _result(m) {
    const now = this.now(), t = now / 1000;
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    const v = this.video, W = v.videoWidth, H = v.videoHeight;
    const st = this.opts.status() || {};
    const state = { tracked: false, lm: m.lm, gesture: 'none', driving: false, gripping: this.pinched,
                    depth: null, fps: this.frames.length, latency: Math.round(now - m.t),
                    delegate: (this.path === 'worker' ? shared?.delegate : mains[this.path]?.delegate), path: this.path, ms: m.ms };
    let pose = null;
    if (m.lm && m.wl) {
      const f = this.f;
      const hp = handPose(m.lm, m.wl, W, H, f);
      state.box = boxState(m.lm, W, H);
      state.tracked = true;
      if (m.pose && this.camera === 'front') this.pose = m.pose;   // (the forearm: from the last frame it ran on)
      // the full 3D pose; a bad solution (a confused tracker) is dropped and the last one kept
      let sol = null;
      try { sol = solveHandPose(m.lm, m.wl, W, H, f, this.palm, this.sol); } catch (e) { sol = null; }
      if (sol && (!(sol.t[2] > 0.12 && sol.t[2] < 2.5) || !(sol.err < 25))) sol = null;
      if (sol) this.sol = sol;
      else if (this.sol) sol = this.sol;
      // gestures (hysteresis): a fist (the index folded in too) pauses; a pinch grips and keeps
      // driving (in a pinch the index bends toward the thumb and the others may curl: no fist)
      // (the index folded into the palm decides: then it is a fist whatever the thumb does)
      this.fist = hp.indexFolded && (this.fist ? hp.curled >= 2 : hp.curled >= 3);
      if (!this.fist && this.gripMode === 'pinch')
        this.pinched = this.pinched ? hp.pinch < SETTINGS.pinchOff : hp.pinch < SETTINGS.pinchOn;
      if (this.gripMode === 'pinchToggle') {
        // the pinch's start (held a few frames) toggles the gripper; a fist counts as pinched, so
        // the fingers passing near each other while it opens can't toggle it
        if (this.fist) { this.pinchHeld = true; this.pinchCount = 0; }
        else if (this.pinchHeld) this.pinchHeld = hp.pinch < SETTINGS.pinchOff;
        else {
          this.pinchCount = hp.pinch < SETTINGS.pinchOn ? this.pinchCount + 1 : 0;
          if (this.pinchCount >= SETTINGS.pinchFrames) { this.pinchHeld = true; this.pinchCount = 0; this.pinched = !this.pinched; }
        }
        state.gesture = this.fist ? 'fist' : this.pinchHeld ? 'pinch' : 'open';
      } else state.gesture = this.fist ? 'fist' : this.pinched ? 'pinch' : 'open';
      state.gripping = this.pinched;
      state.pinch = hp.pinch;                          // (for the pinch circle on the camera picture)
      // learn the palm (open hand only: a fist or a pinch bends it; and only while the hand's shape
      // is calm: frames halfway through opening it, the palm still arched, distorted the model)
      if (sol && state.gesture === 'open' && !this.stab.frozen && this.stab.psi < SETTINGS.grasp.threshold / 2) {
        const img = PALM_IDS.map(i => [(m.lm[i].x - 0.5) / f * sol.t[2], (m.lm[i].y - 0.5) * (H / W) / f * sol.t[2], 0]);
        this.palm.add(m.wl, img, sol.facing);
      }
      // OAT's wrist position (eq. 2): all 21 joints matched in the image, their 3D shape averaged
      // over the last frames (HandShape: MediaPipe's per-frame 3D points are too noisy for it) and
      // posed by the palm's rotation; started from the palm solution, then from the last frame's.
      // SETTINGS.wristFrom 'palm': the palm solution's wrist instead
      let ow = null;
      if (sol && SETTINGS.wristFrom === 'oat') {
        // (while the hand's shape changes, the average follows it closely: it would lag behind)
        const k = Math.min(1, this.stab.psi / SETTINGS.grasp.threshold);
        const vv = this.shape.update(m.wl, sol.R, SETTINGS.shapeAvg + (1 - SETTINGS.shapeAvg) * k);
        const v0 = [vv[0].x, vv[0].y, vv[0].z];
        const p0 = this.wristP || [sol.wrist[0] - v0[0], sol.wrist[1] - v0[1], sol.wrist[2] - v0[2]];
        try { ow = solveWristPosition(m.lm, vv, W, H, f, p0, this.wristP, { sigV: SETTINGS.wristSigV }); } catch (e) { ow = null; }
        if (ow && ow.wrist[2] > 0.08 && ow.wrist[2] < 2.5 && ow.err < 40) this.wristP = ow.p;
        else { ow = null; this.wristP = null; }
      }
      // the checklist (not driving yet): its frames, for the focal length (estimated when it ends,
      // arm()); in 'below', the palm's forward direction
      if (!this.armed && state.gesture === 'open') {
        this.ckFrames.push({ lm: m.lm, wl: m.wl });
        if (this.ckFrames.length > 90) this.ckFrames.shift();
      }
      if (this.camera === 'below' && state.gesture === 'open' && (!this.armed || !this.G)) {
        const ax = sol ? [sol.R[0][0], sol.R[1][0]] : [m.wl[9].x - m.wl[0].x, m.wl[9].y - m.wl[0].y];
        const n = Math.hypot(ax[0], ax[1]);
        if (n > 1e-6) { this.fwd.push([ax[0] / n, ax[1] / n]); if (this.fwd.length > 60) this.fwd.shift(); }
        if (this.armed && !this.G && this.fwd.length >= SETTINGS.belowFrames) { this.G = this._frameBelow(); this.epoch++; }
      }
      // settle (see SETTINGS.settleFrames): then the filters restart from the hand's pose now and
      // the clutch anchors there (a new epoch), so opening the hand can't move the robot
      const back = this.holding;                       // (back after a short loss: see SETTINGS.holdLost)
      this.lostAt = null;
      this.holding = false;
      // (a pinch pauses like a fist; so does the hand leaving the box: near the picture's edge the
      // tracking loses fingers and jumps. Back inside, it settles and re-anchors: no jump)
      const paused = this.fist || (this.gripMode === 'pinchToggle' && this.pinchHeld) || (this.opts.box !== false && state.box.out);
      state.outOfBox = this.opts.box !== false && state.box.out;
      this.openFrames = paused ? 0 : (this.openFrames || 0) + 1;
      const settled = this.openFrames >= SETTINGS.settleFrames;
      if (back && this.openFrames > 1) {               // (the filters start afresh where the hand is now, the
        for (const fl of [this.fPos, this.fDepth, this.fRef, this.fTwist]) fl.reset();
        this.prevCam = this.vCam = null;
        this.dHist = []; this.dRobust = null; this.gate = null;   //  clutch anchors there)
        this.bPos.reset();
        this.fRot3.reset(); this.bRot3.reset();
        this.stab.reset();
        this.outHist = [];
        this.twist = null;
        this.twistRaw = null;
        this.epoch++;
      }
      if (this.openFrames === 1) {                     // (the hand just opened: the filters start afresh ...
        for (const fl of [this.fPos, this.fDepth, this.fRef, this.fTwist]) fl.reset();
        this.prevCam = this.vCam = null;
        this.dHist = []; this.dRobust = null; this.gate = null;
        this.bPos.reset();
        this.fRot3.reset(); this.bRot3.reset();
        this.twist = null;
        this.twistRaw = null;
      }
      if (!settled) {                                  // (the grasp stabilization starts once it has settled:
        this.stab.reset();                             //  the fingers still opening would trip it, and its
        this.outHist = [];                             //  roll-back and catch-up shook the robot on real hands)
      }
      if (settled && !this.wasSettled) this.epoch++;    // (... and have settled when the clutch anchors)
      this.wasSettled = settled;
      const dt = this.lastT === null ? 0 : Math.min(0.1, t - this.lastT);
      this.lastT = t;
      const below = this.camera === 'below';
      // the raw pose of this frame: the wrist (the point the hand turns about: turning it doesn't
      // move the gripper), the twist (the angle of the wrist -> middle knuckle line in the image, 0
      // = fingers up; in the image the person's clockwise turn goes the other way, so this angle is
      // already the robot's turn), the hand's rotation (the forearm fused in when Pose found it)
      let pt = ow ? ow.wrist : sol ? sol.wrist : hp.pos;
      if (SETTINGS.depthMix > 0 && pt[2] > 0) {        // (the distance mixed: see SETTINGS.depthMix)
        const z = pt[2] + SETTINGS.depthMix * (hp.D - pt[2]);
        pt = pt.map(x => x * z / pt[2]);
      }
      const ang = Math.atan2((m.lm[9].x - m.lm[0].x) * W, -(m.lm[9].y - m.lm[0].y) * H);
      if (this.twistRaw === null) this.twistRaw = ang;
      this.twistRaw += Math.atan2(Math.sin(ang - this.twistRaw), Math.cos(ang - this.twistRaw));   // (unwrapped)
      const fa = sol && this.pose && !below ? forearm(this.pose, m.lm[0], W, H, f, sol.t[2]) : null;
      state.forearm = fa ? { conf: fa.conf, weight: this.fusion.weight } : null;
      const RhRaw = sol ? this.fusion.update(sol.R, sol.facing, fa, dt || 1 / 30) : null;
      // OAT's grasp stabilization, on the raw pose (before the filters, which would carry a change
      // on for a while after the fingers stop): while the hand's shape changes fast the pose is held
      // and the change goes into a bias; then it goes on from there, without a jump
      const sb = this.stab.update(fingerShape(m.wl), [...pt, this.twistRaw], RhRaw || IDENTITY, t);
      state.steadied = sb.frozen;
      if (sb.frozen && !this.wasSteadied && this.outHist.length && SETTINGS.grasp.rollback !== false) {
        // it just tripped: the filters and dead bands go back to their state from before the hand
        // began to change (they would keep the drift that leaked out before the change was seen),
        // and the pose held is exactly that state (held at the filters' own value, nothing moves;
        // a raw pose from back then would be noisy itself: millimetres, degrees)
        const o = this.outHist[0];
        this._restore(o);
        const tp = o.pos.x ? [o.pos.x[0], o.pos.x[1], o.depth.x ? o.depth.x[0] : o.pos.x[2]] : pt;
        this.stab.rebase([...tp, o.tw.x ? o.tw.x[0] : this.twistRaw], o.rot.R || RhRaw || IDENTITY);
        Object.assign(sb, { pos: this.stab.held.pos, R: this.stab.held.R });
      }
      this.wasSteadied = sb.frozen;
      const ps = sb.pos.slice(0, 3), twS = sb.pos[3], Rs = RhRaw ? sb.R : null;
      // position: left/right and up/down from the wrist's direction, scaled by a steady reference
      // distance (the per-frame distance is the noisiest number: scaling by it shook the sideways
      // motion too); the distance filtered on its own; then the dead band (a still hand: no motion)
      // the distance, robust first: the median of the last frames (one or two wrong ones, the palm's
      // solution flipping, made it jump 0.8 -> 1.3 m and back while the hand's size in the picture
      // stayed the same: the robot lurched 20-30 cm), then at most a hand's speed toward / away
      this.dHist = [...(this.dHist || []), ps[2]].slice(-SETTINGS.depthMedian);
      const dMed = [...this.dHist].sort((a, b) => a - b)[this.dHist.length >> 1];
      const dMax = SETTINGS.depthSpeed * (dt || 1 / 30);
      this.dRobust = this.dRobust == null ? dMed : this.dRobust + Math.max(-dMax, Math.min(dMax, dMed - this.dRobust));
      const Df = this.fDepth.filter([this.dRobust], t)[0];
      const Dref = this.fRef.filter([this.dRobust], t)[0];
      // (the distance filtered once, by its own filter: through the position filter too it lagged twice)
      const xy = this.fPos.filter([ps[0] / ps[2] * Dref, ps[1] / ps[2] * Dref], t);
      // far away: the distance's change that comes with a larger sideways motion mostly let go
      // (SETTINGS.farGate; the speeds a running mean: per frame the noise would decide it). The
      // robot only follows changes (the clutch), so the offset this leaves is harmless
      const g = SETTINGS.farGate, k = Math.min(1, Math.max(0, (Dref - g.near) / (g.far - g.near)));
      let D = Df, vz = 0, vs = 0;
      if (this.gate) {
        const dz = Df - this.gate.Df, ds = Math.hypot(xy[0] - this.gate.xy[0], xy[1] - this.gate.xy[1]);
        vz = this.gate.vz + g.smooth * (Math.abs(dz) - this.gate.vz);
        vs = this.gate.vs + g.smooth * (ds - this.gate.vs);
        const s = k * g.ratio * vs;
        D = this.gate.D + dz * (vz * vz / (vz * vz + s * s + 1e-12));
      }
      this.gate = { Df, D, xy, vz, vs };
      const camPos = [...xy, D * SETTINGS.depthGain];   // (the robot follows changes: scaling D is safe)
      // a little ahead (SETTINGS.lead): the filters' delay partly made up from the hand's speed
      // (smoothed; zero at rest, where the dead band below holds it still anyway)
      if (dt > 0 && this.prevCam) {
        const v = camPos.map((x, i) => (x - this.prevCam[i]) / dt);
        this.vCam = this.vCam ? this.vCam.map((x, i) => x + SETTINGS.leadSmooth * (v[i] - x)) : v;
      }
      this.prevCam = camPos;
      const ahead = this.vCam && SETTINGS.lead > 0 ? camPos.map((x, i) => x + this.vCam[i] * SETTINGS.lead) : camPos;
      const held = this.bPos.filter(ahead, dt);
      state.depth = D;
      const tw = this.fTwist.filter([twS], t)[0];
      const band = SETTINGS.deadRot * Math.PI / 180;
      if (this.twist === null) this.twist = tw;
      else if (Math.abs(tw - this.twist) > band) this.twist = tw - Math.sign(tw - this.twist) * band;
      const vy = st.view_yaw ?? 0;
      if (Math.abs(vy - this.lastVY) > 0.005) { this.lastVY = vy; this.epoch++; }
      const rotation = st.task_game?.rotation || 'yaw';
      if (rotation !== this.lastRot) { this.lastRot = rotation; this.epoch++; }   // (re-anchor: no jump)
      // the camera's frame -> the robot's ('below': G, learned; until then a provisional one)
      const G = below ? (this.G || this._frameBelow()) : null;
      const mj0 = mulMV(below ? G : CAM_TO_MJ, held);
      const cv = Math.cos(vy), sv = Math.sin(vy);
      const mj = [cv * mj0[0] - sv * mj0[1], sv * mj0[0] + cv * mj0[1], mj0[2]];
      // the keys: this page's (setTilt), else the computer's through the status (a phone as the camera)
      const lk = this.tilt, rk = st.rot_keys || {};
      const keys = lk.pitch || lk.roll || lk.turn ? lk : { pitch: rk.pitch || 0, roll: rk.roll || 0, turn: rk.turn || 0 };
      const driving = this.armed && settled;
      this._advanceKeys(keys, driving, rotation === 'full', t);
      const steady = !SETTINGS.handRotation;
      const yaw = (steady ? 0 : this.twist) + this.keyYaw + vy;
      let Rh = null, q;
      if (Rs) {
        Rh = this.bRot3.filter(this.fRot3.filter(Rs, t));
        state.axes = projectAxes(Rh, sol.centre, W, H, f);
        state.facing = sol.facing;
      }
      if (rotation === 'full' && (Rh || steady)) {
        const vk = vy + (steady ? this.keyYaw : 0);
        const cv2 = Math.cos(vk), sv2 = Math.sin(vk), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
        // the hand's orientation in the robot's frame (the screen's heading turned in), then the
        // keys' extra tilt forward/back (about the robot's left axis) and sideways (its forward axis)
        const Rz = [[cv2, -sv2, 0], [sv2, cv2, 0], [0, 0, 1]];
        const Ry = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]];
        const Rx = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]];
        // the hand's rotation in the robot's frame: 'front' through HAND_TO_MJ (the palm toward the
        // camera is the gripper's down), 'below' through G (the room's frame: world-frame deltas)
        const Rmj = steady ? IDENTITY
          : below ? mulMM(G, mulMM(Rh, transpose(G))) : mulMM(HAND_TO_MJ, mulMM(Rh, transpose(HAND_TO_MJ)));
        q = matToQuat(mulMM(Rz, mulMM(Ry, mulMM(Rx, Rmj))));
      } else {
        this.pitch = 0; this.roll = 0;
        q = [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
      }
      pose = [...mj, ...q];
      this.keyCtx = { rotation, vy, keys, side: st.task_game?.arm || 'right' };   // (the keys' re-sends between frames)
      // (the output's recent states, before the hand's shape began to change: see the roll-back above)
      if (!sb.frozen) {
        this.outHist.push(this._snapshot());
        if (this.outHist.length > SETTINGS.grasp.window + 1) this.outHist.shift();
      } else this.outHist = [];
      this.lastPose = pose;
      state.driving = this.armed && settled;
    } else {
      if (this.lostAt === null) { this.lostAt = t; this.holding = this.armed && this.wasSettled && !!this.lastPose; }
      if (this.holding && t - this.lostAt < SETTINGS.holdLost) {
        pose = this.lastPose;                         // (a short loss: the robot holds where it is)
        state.driving = true;
        state.held = true;
      } else {
        this.holding = false;
        this.fist = false;
        this.openFrames = 0;                          // (a lost hand settles again when it is back)
        this.wasSettled = false;
        this.sol = null;
        this.fusion.reset();
      }
    }
    this._log(m, state, t);
    this.lastState = state;
    this.opts.onFrame?.(state);
    if (!this.armed) return;
    const side = st.task_game?.arm || 'right';
    const right = pose ? { pose, grip: state.driving ? 1 : 0, stick: [0, this.pinched ? 1 : -1], buttons: [], epoch: this.epoch } : null;
    // (fps: the server glides between frames over a time that fits their spacing)
    this.opts.send({ type: 'input', t, head: null, left: null, right: null, [side]: right, tracker: 'hand', fps: state.fps });
  }

  /** the turn and tilt keys, added up by the clock (not per tracker frame: at 10-30 frames a
   *  second that turned the gripper in visible steps); only while driving */
  _advanceKeys(keys, driving, full, t) {
    const dt = this.keyT == null ? 0 : Math.min(0.1, Math.max(0, t - this.keyT));
    this.keyT = t;
    if (!driving) return;
    this.keyYaw += keys.turn * SETTINGS.turnRate * Math.PI / 180 * dt;
    if (full) {
      this.pitch += keys.pitch * SETTINGS.tiltRate * Math.PI / 180 * dt;
      this.roll += keys.roll * SETTINGS.tiltRate * Math.PI / 180 * dt;
    }
  }

  /** steady (the keys alone turn the gripper): between tracker frames, while a turn or tilt key is
   *  held, the last pose is sent again with the keys' rotation now (~60 a second), so the turn
   *  glides; the position stays the last frame's */
  _keyTick() {
    const c = this.keyCtx, s = this.lastState;
    if (!SETTINGS.handRotation && this.armed && c && s?.driving && !s.held && this.lastPose) {
      const lk = this.tilt, rk = (this.opts.status() || {}).rot_keys || {};
      const keys = lk.pitch || lk.roll || lk.turn ? lk : { pitch: rk.pitch || 0, roll: rk.roll || 0, turn: rk.turn || 0 };
      if (!(keys.turn || (c.rotation === 'full' && (keys.pitch || keys.roll)))) return;
      const t = this.now() / 1000;
      this._advanceKeys(keys, true, c.rotation === 'full', t);
      const pose = [...this.lastPose.slice(0, 3), ...steadyQuat(c.rotation, c.vy, this.keyYaw, this.pitch, this.roll)];
      this.lastPose = pose;
      const right = { pose, grip: 1, stick: [0, this.pinched ? 1 : -1], buttons: [], epoch: this.epoch };
      this.opts.send({ type: 'input', t, head: null, left: null, right: null, [c.side]: right, tracker: 'hand', fps: s.fps });
    }
  }
}

/** the gripper's rotation from the keys alone (steady): 'yaw' a turn about up; 'full' the turn,
 *  then the tilt forward/back (about the robot's left axis) and sideways (its forward axis) */
function steadyQuat(rotation, vy, keyYaw, pitch, roll) {
  if (rotation !== 'full') { const y = keyYaw + vy; return [Math.cos(y / 2), 0, 0, Math.sin(y / 2)]; }
  const vk = vy + keyYaw;
  const cv = Math.cos(vk), sv = Math.sin(vk), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  return matToQuat(mulMM([[cv, -sv, 0], [sv, cv, 0], [0, 0, 1]], mulMM([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]], [[1, 0, 0], [0, cr, -sr], [0, sr, cr]])));
}

/** The hand's axes drawn on the camera picture (image 0..1): fingers, across, out of the palm. */
function projectAxes(R, c, W, H, f) {
  const p = (X) => ({ x: 0.5 + f * X[0] / X[2], y: (0.5 * H / W + f * X[1] / X[2]) * W / H });
  const L = 0.06;
  return { o: p(c), axes: [0, 1, 2].map(j => p([c[0] + R[0][j] * L, c[1] + R[1][j] * L, c[2] + R[2][j] * L])) };
}
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const transpose = (M) => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];
const r4 = (v) => Math.round(v * 1e4) / 1e4;

HandControl.prototype._log = function (m, state, t) {
  // the raw tracking (points, no picture), for tuning: opts.log(frames) every SETTINGS.logEvery s
  if (!this.opts.log) return;
  const pose = m.pose ? [13, 14, 15, 16].map(i => m.pose.lm[i] ? [r4(m.pose.lm[i].x), r4(m.pose.lm[i].y), r4(m.pose.lm[i].visibility ?? 0),
    r4(m.pose.wl[i].x), r4(m.pose.wl[i].y), r4(m.pose.wl[i].z)] : null) : null;
  this.log.push({ t: r4(t), lat: state.latency, ms: m.ms === undefined ? null : Math.round(m.ms), path: this.path,
                  bench: this.benchResult && !this.benchLogged ? (this.benchLogged = true, this.benchResult) : undefined,
                  dg: state.delegate, cam: this.camera, g: state.gesture, d: state.driving ? 1 : 0,
                  lm: m.lm ? m.lm.map(p => [r4(p.x), r4(p.y)]) : null, wl: m.wl ? m.wl.map(p => [r4(p.x), r4(p.y), r4(p.z)]) : null,
                  pose, W: this.video.videoWidth, H: this.video.videoHeight });
  if (this.lastLog === null) this.lastLog = t;
  if (t - this.lastLog >= SETTINGS.logEvery) {
    this.opts.log(this.log);
    this.log = [];
    this.lastLog = t;
  }
};

function quatToMat([w, x, y, z]) {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}

/** Open a camera (the front one on a phone: it stands in front of the person like a webcam). */
export async function openCamera(facing = 'user') {
  const stream = await navigator.mediaDevices.getUserMedia({
    // (60 pictures a second where the camera can: the tracker takes the newest, more of them means
    // smaller steps between them)
    audio: false, video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } } });
  const video = document.createElement('video');
  video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
  // in the page (some browsers stop a video that isn't: "the play() request was interrupted
  // because the media was removed from the document"), invisible, and inside the window (Chrome
  // pauses muted videos it thinks nobody sees: out of view, or hidden altogether)
  Object.assign(video.style, { position: 'fixed', right: '0', bottom: '0', width: '2px', height: '2px',
                               opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
  document.body.appendChild(video);
  video.srcObject = stream;
  if (video.readyState < 1) await new Promise((ok) => video.addEventListener('loadedmetadata', ok, { once: true }));
  // (play() can be interrupted by the browser while the stream settles: try again a few times)
  for (let i = 0; ; i++) {
    try { await video.play(); break; } catch (e) {
      if (i >= 4 || (e.name !== 'AbortError' && e.name !== 'NotAllowedError')) {
        stream.getTracks().forEach(t => t.stop()); video.remove();
        throw e;
      }
      await new Promise((ok) => setTimeout(ok, 250 * (i + 1)));
    }
  }
  return { video, stream, stop: () => { stream.getTracks().forEach(t => t.stop()); video.remove(); } };
}
