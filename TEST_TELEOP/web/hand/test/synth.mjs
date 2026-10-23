// A synthetic hand for the hand-control tests: MediaPipe's 21 points of a right hand, posed in
// front of (or above) a camera, seen as MediaPipe would report them, with its kind of noise:
//   image points  1.5 px
//   3D points     3 mm across, 6 mm in depth, plus a 2-3 degree wobble of the whole 3D hand
//                 (smooth from frame to frame, as MediaPipe's is)
// The hand's own frame H: x toward the fingers, y toward the thumb (left on a right hand, palm
// down), z out of the back of the hand; the palm side is -z. The wrist is at H's origin.
import { add, sub, scale, mulMV, mulMM, expSO3, len, norm } from '../pose3d.js';

// ------------------------------------------------------------ a seeded random generator
export function rng(seed = 1) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

// ------------------------------------------------------------ the hand
const MCP = { index: [0.090, 0.022, 0], middle: [0.095, 0.000, 0], ring: [0.090, -0.020, 0], pinky: [0.080, -0.038, 0] };
const SEG = { index: [0.040, 0.025, 0.020], middle: [0.045, 0.028, 0.022], ring: [0.042, 0.026, 0.020], pinky: [0.032, 0.020, 0.018] };
const finger = (base, segs, angles) => {          // a chain along +x, each joint bending toward the palm (-z)
  const pts = [base];
  let p = base, a = 0;
  for (let k = 0; k < 3; k++) {
    a += angles[k];
    p = add(p, [segs[k] * Math.cos(a), 0, -segs[k] * Math.sin(a)]);
    pts.push(p);
  }
  return pts;
};

/** The 21 points in H [m]. pinch 0..1 (thumb and index tips together at 1), curl 0..1 (a fist).
 *  The palm arches a little as the hand closes (the ring and pinky knuckles and the thumb's base
 *  drop toward the palm side): that moves the palm's points, as on a real hand. */
export function handPoints({ pinch = 0, curl = 0 } = {}) {
  const arch = Math.max(pinch * 0.6, curl);
  const mcp = { ...MCP, ring: add(MCP.ring, [0, 0, -0.004 * arch]), pinky: add(MCP.pinky, [0, 0.003 * arch, -0.007 * arch]) };
  const bend = (k) => [0.25 + 1.2 * k, 0.15 + 1.4 * k, 0.1 + 0.9 * k];
  const idx = finger(mcp.index, SEG.index, bend(Math.max(0.45 * pinch, curl)).map((x, i) => x * (i === 0 ? 1 : 1)));
  const mid = finger(mcp.middle, SEG.middle, bend(Math.max(0.2 * pinch, curl)));
  const rin = finger(mcp.ring, SEG.ring, bend(Math.max(0.2 * pinch, curl)));
  const pin = finger(mcp.pinky, SEG.pinky, bend(Math.max(0.25 * pinch, curl)));
  // the thumb: open, it points forward-left; pinching, its tip meets the index tip
  const cmc = add([0.025, 0.030, -0.010], [0, -0.004 * arch, -0.004 * arch]);
  const open = [add(cmc, [0.030, 0.025, -0.008]), add(cmc, [0.055, 0.040, -0.014]), add(cmc, [0.075, 0.052, -0.018])];
  const meet = add(idx[3], [0.004, 0.006, -0.006]);
  const k = Math.min(1, pinch);
  const th = [add(open[0], scale(sub(add(cmc, scale(sub(meet, cmc), 0.4)), open[0]), k)),
              add(open[1], scale(sub(add(cmc, scale(sub(meet, cmc), 0.72)), open[1]), k)),
              add(open[2], scale(sub(meet, open[2]), k))];
  return [[0, 0, 0], cmc, ...th, ...idx, ...mid, ...rin, ...pin];
}

// ------------------------------------------------------------ the camera and MediaPipe's view
export const focalOf = (hfov) => 0.5 / Math.tan(hfov / 2 * Math.PI / 180);

/** A camera W x H with a horizontal field of view hfov, and MediaPipe's noise. view(R, t, shape):
 *  R = hand frame -> camera frame, t = the wrist in the camera frame [m]; returns {lm, wl} as
 *  MediaPipe gives them (lm: image 0..1, wl: metres, the camera's axes, relative to the hand). */
export function camera({ W = 1280, H = 720, hfov = 60, px = 1.5, mmXY = 3, mmZ = 6, wobbleDeg = 2.5, seed = 7 } = {}) {
  const f = focalOf(hfov), r = rng(seed);
  let wob = [0, 0, 0];
  return {
    W, H, f,
    view(R, t, shape = {}) {
      const P = handPoints(shape).map(p => add(mulMV(R, p), t));
      const lm = P.map(X => ({ x: 0.5 + f * X[0] / X[2] + r.n() * px / W, y: 0.5 + f * X[1] / X[2] * (W / H) + r.n() * px / H }));
      // the 3D points: around their centre, with noise and a slow wobble of the whole hand
      const c = P.reduce((s, p) => add(s, p), [0, 0, 0]).map(x => x / P.length);
      const k = wobbleDeg * Math.PI / 180;
      wob = wob.map(w => 0.85 * w + Math.sqrt(1 - 0.85 * 0.85) * k * r.n());
      const Wb = expSO3(wob);
      const wl = P.map(X => {
        const q = add(mulMV(Wb, sub(X, c)), [r.n() * mmXY / 1000, r.n() * mmXY / 1000, r.n() * mmZ / 1000]);
        return { x: q[0], y: q[1], z: q[2] };
      });
      return { lm, wl, truth: P };
    },
  };
}

// ------------------------------------------------------------ poses
export const rotX = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
export const rotY = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
export const rotZ = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
/** rows a, b, c -> the matrix whose columns are a, b, c */
export const cols = (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
export { add, sub, scale, mulMV, mulMM, len, norm };
