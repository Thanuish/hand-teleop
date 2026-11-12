// The hand's full 3D pose (position and pitch / yaw / roll) from one camera, and the forearm's
// direction as a second opinion. Following OAT (Optimization-based hAnd pose retargeting and wrisT
// pose estimation, ICRA 2026: the palm's rigid points matched in 3D and in the image) and
// AnyTeleop (RSS 2023: the orientation from the palm's keypoints):
//
//   1. a rigid model of the palm (the wrist, the thumb's base, the four knuckles: points that don't
//      move when the fingers do), learned from this person's hand while it faces the camera
//   2. each frame: the model turned onto MediaPipe's 3D points (Horn / Kabsch fit): a rotation that
//      is never mirrored, but whose tilt wobbles by degrees (MediaPipe guesses depth)
//   3. then refined against the 2D image points (a PnP: where the model's points must be in the
//      image), which are far sharper, with step 2 as a prior: the tilt from the palm's
//      foreshortening, the distance from its size *at that tilt* (a tilted palm looks smaller: the
//      old size-only estimate took that for the hand moving away)
//   4. the forearm (MediaPipe Pose: elbow -> wrist) as a long, steady axis: when the palm turns
//      edge-on to the camera (where 2 and 3 are unreliable and the tracker often loses the hand)
//      the rotation is carried by the forearm and the last known wrist bend
//
// Frames: the camera's (x right in the image, y down, z away from the camera), metres.

// ------------------------------------------------------------ small math
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const mulMV = (M, v) => M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export const mulMM = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
export const T = (M) => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];

/** rotation vector (axis x angle) -> matrix */
export function expSO3(w) {
  const th = len(w);
  if (th < 1e-12) return [[1, -w[2], w[1]], [w[2], 1, -w[0]], [-w[1], w[0], 1]];
  const [x, y, z] = scale(w, 1 / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
          [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
          [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
/** matrix -> rotation vector */
export function logSO3(R) {
  const c = Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2));
  const th = Math.acos(c);
  const v = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
  if (th < 1e-6) return scale(v, 0.5);
  if (th > Math.PI - 1e-4) {                         // (near 180 deg: from the diagonal)
    const a = [Math.sqrt(Math.max(0, (R[0][0] + 1) / 2)), Math.sqrt(Math.max(0, (R[1][1] + 1) / 2)), Math.sqrt(Math.max(0, (R[2][2] + 1) / 2))];
    if (R[0][1] < 0) a[1] = -a[1];
    if (R[0][2] < 0) a[2] = -a[2];
    return scale(norm(a), th);
  }
  return scale(v, th / (2 * Math.sin(th)));
}
export const angleBetween = (A, B) => len(logSO3(mulMM(T(A), B)));
/** the rotation a fraction k of the way from A to B */
export const slerpM = (A, B, k) => mulMM(A, expSO3(scale(logSO3(mulMM(T(A), B)), k)));

/** Orthonormal again (after averaging): Gram-Schmidt on the first two columns. */
export function orthonormal(R) {
  const a = norm([R[0][0], R[1][0], R[2][0]]);
  let b = [R[0][1], R[1][1], R[2][1]];
  b = norm(sub(b, scale(a, dot(a, b))));
  const c = cross(a, b);
  return [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
}

/** The rotation R (and translation) that best turns points A onto points B (weights w):
 *  Horn's closed form (quaternions, 1987), never a mirror. Returns {R, ca, cb} with
 *  B ~ R (A - ca) + cb. */
export function fitRotation(A, B, w) {
  const W = w.reduce((s, x) => s + x, 0);
  const ca = A.reduce((s, p, i) => add(s, scale(p, w[i] / W)), [0, 0, 0]);
  const cb = B.reduce((s, p, i) => add(s, scale(p, w[i] / W)), [0, 0, 0]);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  A.forEach((p, i) => {
    const a = sub(p, ca), b = sub(B[i], cb);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += w[i] * a[r] * b[c];
  });
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [[xx + yy + zz, yz - zy, zx - xz, xy - yx],
             [yz - zy, xx - yy - zz, xy + yx, zx + xz],
             [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
             [xy - yx, zx + xz, yz + zy, -xx - yy + zz]];
  const q = topEigenvector4(N);
  return { R: quatToMat(q), ca, cb };
}

function topEigenvector4(N) {          // symmetric 4x4: Jacobi rotations
  const a = N.map(r => r.slice()), V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 4; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 4; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  const q = [V[0][best], V[1][best], V[2][best], V[3][best]];
  const n = Math.hypot(...q);
  return q.map(x => x / n);
}

export function quatToMat([w, x, y, z]) {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}

/** Solve A x = b (6x6, symmetric positive definite): Gaussian elimination with pivoting. */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / d;
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

// ------------------------------------------------------------ the palm model
// MediaPipe's points that are rigid with the palm: wrist, thumb base (CMC: moves a little with the
// thumb, so it counts half), the knuckles (MCP) of the index, middle, ring and pinky fingers
export const PALM_IDS = [0, 1, 5, 9, 13, 17];
export const PALM_W = [1, 0.5, 1, 1, 1, 1];

/** The palm's own frame from its points: origin at their mean, x = wrist -> middle knuckle
 *  (toward the fingers), y = index -> pinky knuckle, z = x cross y (the palm's normal). */
export function palmFrame(P) {
  const c = P.reduce((s, p, i) => add(s, scale(p, PALM_W[i])), [0, 0, 0]).map(v => v / PALM_W.reduce((s, x) => s + x, 0));
  const a = norm(sub(P[3], P[0]));
  let b = sub(P[5], P[2]);
  b = norm(sub(b, scale(a, dot(a, b))));
  const n = cross(a, b);
  return { c, R: [[a[0], b[0], n[0]], [a[1], b[1], n[1]], [a[2], b[2], n[2]]] };
}

/** A rigid palm model learned from frames of this person's hand (in the palm's own frame).
 *  Each frame's points are put in their palm frame and averaged; out of the camera's view plane
 *  (the palm's thickness) the 3D points are trusted, in it the image's (sharper) when the palm
 *  faces the camera. Until it has enough frames, MediaPipe's 3D points stand in. */
export class PalmModel {
  constructor() { this.reset(); }
  reset() { this.sum = PALM_IDS.map(() => [0, 0, 0]); this.n = 0; this.pts = null; }
  get ready() { return this.n >= 15; }
  /** wl: 21 3D points [m]; img: the same 6 palm points from the image, already in metres at the
   *  hand's distance (or null); facing: |palm normal . camera axis| */
  add(wl, img, facing) {
    const P = PALM_IDS.map(i => [wl[i].x, wl[i].y, wl[i].z]);
    let local;
    if (img && facing > 0.95) {
      // the outline from the image (scaled to the 3D points' size), the depth offsets from 3D
      const f3 = palmFrame(P);
      const s = scaleMatch(P, img);
      const I = img.map(p => scale(p, s));
      const fi = fitRotation(I, P, PALM_W);             // (the image points turned like the 3D ones)
      local = I.map((p, k) => {
        const q = add(mulMV(fi.R, sub(p, fi.ca)), fi.cb);
        const l3 = mulMV(T(f3.R), sub(P[k], f3.c)), li = mulMV(T(f3.R), sub(q, f3.c));
        return [li[0], li[1], l3[2]];
      });
    } else if (!this.ready) {
      const f = palmFrame(P);
      local = P.map(p => mulMV(T(f.R), sub(p, f.c)));
    } else return;
    this.sum = this.sum.map((s, k) => add(s, local[k]));
    this.n++;
    if (this.n > 60) { this.sum = this.sum.map(s => scale(s, 60 / this.n)); this.n = 60; }   // (a running mean)
    this.pts = this.sum.map(s => scale(s, 1 / this.n));
  }
}

function scaleMatch(A, B) {            // the scale that makes B's spread equal A's
  const spread = (P) => {
    const c = P.reduce((s, p) => add(s, p), [0, 0, 0]).map(v => v / P.length);
    return Math.sqrt(P.reduce((s, p) => s + dot(sub(p, c), sub(p, c)), 0));
  };
  return spread(A) / Math.max(1e-9, spread(B));
}

// ------------------------------------------------------------ the hand's pose
/** One frame. lm: 21 image points (0..1), wl: 21 3D points [m], W x H the image, f the focal
 *  length (in image widths), model: a PalmModel, prev: last frame's {R, t} (or null).
 *  Returns {R (palm frame -> camera), t (the palm's centre in the camera frame [m]), wrist (the
 *  wrist's point there), R3 (from the
 *  3D points alone), facing (|palm normal . camera axis|: 1 = facing the camera), err (image
 *  residual, px)}. */
export function solveHandPose(lm, wl, W, H, f, model, prev = null, opts = {}) {
  const sigPx = opts.sigPx ?? 1.5;                     // [px] the image points' noise
  const sigRot = (opts.sigRotDeg ?? 6) * Math.PI / 180;  // the 3D points' rotation noise
  const P3 = PALM_IDS.map(i => [wl[i].x, wl[i].y, wl[i].z]);
  const M = model?.pts || (() => { const fr = palmFrame(P3); return P3.map(p => mulMV(T(fr.R), sub(p, fr.c))); })();
  const fit = fitRotation(M, P3, PALM_W);
  const R3 = fit.R;
  // the image points, as rays (normalized image coordinates: x / z, y / z)
  const u = PALM_IDS.map(i => [(lm[i].x - 0.5) / f, (lm[i].y - 0.5) * (H / W) / f]);
  // a first distance: the model's size against its size in the image (at the 3D rotation)
  let t;
  if (prev && prev.t) t = prev.t.slice();
  else {
    const Q = M.map(p => mulMV(R3, sub(p, fit.ca)));
    let real = 0, img = 0;
    for (let k = 1; k < Q.length; k++) {
      real += Math.hypot(Q[k][0] - Q[0][0], Q[k][1] - Q[0][1]);
      img += Math.hypot(u[k][0] - u[0][0], u[k][1] - u[0][1]);
    }
    const Z = real / Math.max(1e-6, img);
    const uc = u.reduce((s, p, k) => [s[0] + p[0] * PALM_W[k], s[1] + p[1] * PALM_W[k]], [0, 0]).map(v => v / 5.5);
    t = [uc[0] * Z, uc[1] * Z, Z];
  }
  let R = prev && prev.R && angleBetween(prev.R, R3) < 0.6 ? prev.R : R3;
  const sU = 1 / (sigPx / (W * f));                    // (1 / noise, in normalized image units)
  const resid = (Rx, tx) => {
    const r = [];
    M.forEach((p, k) => {
      const X = add(mulMV(Rx, sub(p, fit.ca)), tx);
      const z = Math.max(0.05, X[2]), wk = Math.sqrt(PALM_W[k]) * sU;
      r.push((X[0] / z - u[k][0]) * wk, (X[1] / z - u[k][1]) * wk);
    });
    const e = logSO3(mulMM(Rx, T(R3)));
    r.push(e[0] / sigRot, e[1] / sigRot, e[2] / sigRot);
    return r;
  };
  // Gauss-Newton (with a little damping) on the rotation (left-multiplied) and the position
  for (let it = 0; it < 6; it++) {
    const r0 = resid(R, t), J = [];
    const h = 1e-6;
    for (let j = 0; j < 6; j++) {
      const d = [0, 0, 0, 0, 0, 0]; d[j] = h;
      const Rj = j < 3 ? mulMM(expSO3(d.slice(0, 3)), R) : R;
      const tj = j < 3 ? t : add(t, d.slice(3));
      const rj = resid(Rj, tj);
      J.push(rj.map((v, i) => (v - r0[i]) / h));
    }
    const A = [...Array(6)].map((_, a) => [...Array(6)].map((_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0) + (a === b ? 1e-3 : 0)));
    const g = [...Array(6)].map((_, a) => -J[a].reduce((s, v, i) => s + v * r0[i], 0));
    const dx = solve(A, g);
    R = mulMM(expSO3(dx.slice(0, 3)), R);
    t = add(t, dx.slice(3));
    if (Math.hypot(...dx) < 1e-7) break;
  }
  R = orthonormal(R);
  const rr = resid(R, t);
  let err = 0;
  for (let k = 0; k < M.length; k++) err += Math.hypot(rr[2 * k], rr[2 * k + 1]) / sU * W * f;
  // the palm's centre (the model's origin, not the fit's weighted mean) in the camera frame
  const centre = add(mulMV(R, scale(fit.ca, -1)), t);
  // the wrist (the point the hand turns about: turning the hand doesn't move it)
  const wrist = add(mulMV(R, sub(M[0], fit.ca)), t);
  return { R, t, centre, wrist, R3, facing: Math.abs(R[2][2]), err: err / M.length };
}

// ------------------------------------------------------------ the forearm
// MediaPipe Pose's points: 13 / 14 left / right elbow, 15 / 16 wrists
/** The forearm (elbow -> wrist) of the arm whose wrist is at the hand's wrist in the image.
 *  pose: {lm, wl} (33 points each, or null), handWrist: the hand's point 0 in the image (0..1),
 *  depth: the hand's distance [m]. Returns {dir (camera frame, unit), conf (0..1)} or null. */
export function forearm(pose, handWrist, W, H, f, depth) {
  if (!pose?.lm || !pose?.wl) return null;
  let best = null;
  for (const [e, w] of [[13, 15], [14, 16]]) {
    const pw = pose.lm[w], pe = pose.lm[e];
    if (!pw || !pe) continue;
    const dist = Math.hypot((pw.x - handWrist.x) * W, (pw.y - handWrist.y) * H) / W;
    if (dist < 0.12 && (!best || dist < best.dist)) best = { e, w, dist };
  }
  if (!best) return null;
  const { e, w } = best, pe = pose.lm[e], pw = pose.lm[w];
  const vis = Math.min(pe.visibility ?? 1, pw.visibility ?? 1);
  // across the image: from the sharp 2D points (at the hand's distance); toward / away from the
  // camera: from Pose's 3D points (rough, but the only measure of it)
  const dx = (pw.x - pe.x) / f * depth, dy = (pw.y - pe.y) * (H / W) / f * depth;
  const dz = pose.wl[w].z - pose.wl[e].z;
  const dir = norm([dx, dy, dz]);
  const across = Math.hypot(dx, dy) / Math.max(1e-6, len([dx, dy, dz]));   // (pointing at the camera: little to see)
  return { dir, conf: Math.max(0, Math.min(1, (vis - 0.5) / 0.3)) * Math.max(0, Math.min(1, (across - 0.3) / 0.3)) };
}

/** The forearm's frame: x along it, the palm's normal (made square to it) as z: it turns with
 *  the forearm and with the palm's roll about it, not with the wrist bending. */
export function forearmFrame(dir, R) {
  const n = [R[0][2], R[1][2], R[2][2]];
  let z = sub(n, scale(dir, dot(n, dir)));
  if (len(z) < 0.2) return null;                       // (the palm's normal along the forearm: undefined)
  z = norm(z);
  const y = cross(z, dir);
  return [[dir[0], y[0], z[0]], [dir[1], y[1], z[1]], [dir[2], y[2], z[2]]];
}

/** Hand rotation fused with the forearm. While the palm faces the camera, the hand's own rotation
 *  is used and the wrist's bend (forearm frame -> palm) is learned; when the palm turns edge-on
 *  (or its fit is poor), the forearm frame times the last known bend takes over, gradually. */
export class ForearmFusion {
  constructor({ learn = 1.0, edgeLo = 0.15, edgeHi = 0.4, maxWeight = 0.7 } = {}) {
    this.maxWeight = maxWeight;
    this.learn = learn; this.edgeLo = edgeLo; this.edgeHi = edgeHi; this.bend = null; this.weight = 0;
  }
  reset() { this.bend = null; this.weight = 0; }
  /** R: the hand's rotation, facing: its facing value, fa: forearm() or null, dt [s] */
  update(R, facing, fa, dt) {
    const F = fa && fa.conf > 0 ? forearmFrame(fa.dir, R) : null;
    // how much the hand's own rotation can be trusted: by how squarely the palm faces the camera
    const trust = Math.max(0, Math.min(1, (facing - this.edgeLo) / (this.edgeHi - this.edgeLo)));
    if (F) {
      const bend = mulMM(T(F), R);
      if (this.bend === null) this.bend = bend;
      else if (trust > 0.5) this.bend = slerpM(this.bend, bend, 1 - Math.exp(-dt / this.learn));
    }
    this.weight = F && this.bend ? this.maxWeight * (1 - trust) * fa.conf : 0;
    if (this.weight <= 0) return R;
    return slerpM(R, mulMM(F, this.bend), this.weight);
  }
}

// ------------------------------------------------------------ filters on rotations
/** The One Euro filter (Casiez et al., CHI 2012) for a rotation: the step from the filtered
 *  rotation toward the new one is a rotation vector, filtered by its speed (steady when still,
 *  little lag when turning). */
export class OneEuroRot {
  constructor({ minCutoff, beta, dCutoff }) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.reset(); }
  reset() { this.R = null; this.w = [0, 0, 0]; this.t = null; }
  filter(R, t) {
    if (this.R === null || t - this.t > 0.5) { this.R = R; this.w = [0, 0, 0]; this.t = t; return R; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const e = logSO3(mulMM(R, T(this.R)));            // (in the camera frame)
    const ad = alpha(this.dCutoff, dt);
    this.w = this.w.map((v, i) => v + ad * (e[i] / dt - v));
    const a = alpha(this.minCutoff + this.beta * len(this.w), dt);
    this.R = orthonormal(mulMM(expSO3(scale(e, a)), this.R));
    return this.R;
  }
}
const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

/** A dead band for a rotation: it turns only past `deg`, and then just enough to stay `deg` behind. */
export class BacklashRot {
  constructor(deg) { this.rad = deg * Math.PI / 180; this.R = null; }
  reset() { this.R = null; }
  filter(R) {
    if (this.R === null) { this.R = R; return R; }
    const e = logSO3(mulMM(R, T(this.R))), a = len(e);
    if (a > this.rad) this.R = orthonormal(mulMM(expSO3(scale(e, 1 - this.rad / a)), this.R));
    return this.R;
  }
}

// ------------------------------------------------------------ OAT: the wrist's position from all 21 joints
// OAT (Chen et al., ICRA 2026), eq. 2: the hand's 3D points v_i (MediaPipe's world landmarks:
// metres, the camera's axes, relative to the hand) shifted by p must project onto the image points
// u_i; a speed penalty keeps p near the last frame's:
//     min_p  sum_i |u_i - pi(v_i + p)|^2 / sigma_u^2  +  |p - p_prev|^2 / sigma_v^2
// pi(X) = (X0 / X2, X1 / X2) (normalized image coordinates, x / z and y / z). All 21 joints count,
// not just the palm's: the position is far steadier (the palm-only solve leans on 6 points).
// A few Gauss-Newton steps with the analytic Jacobian (3 unknowns: microseconds).
const toNormalized = (lm, W, H, f) => lm.map(p => [(p.x - 0.5) / f, (p.y - 0.5) * (H / W) / f]);

/** lm: 21 image points (0..1), wl: 21 3D points [m], W x H the image, f the focal length (image
 *  widths), p0: the starting translation (e.g. the palm solution's wrist - wl[0]), pPrev: last
 *  frame's (or null: no speed penalty). Returns {p, wrist (= v_0 + p), err (image residual, px)}. */
export function solveWristPosition(lm, wl, W, H, f, p0, pPrev = null, opts = {}) {
  const sigPx = opts.sigPx ?? 1.5, sigV = opts.sigV ?? 0.02;     // [px], [m per frame]
  const u = toNormalized(lm, W, H, f);
  const v = wl.map(q => [q.x, q.y, q.z]);
  const su = W * f / sigPx;                                       // (1 / the image noise, normalized units)
  const wv = pPrev ? 1 / sigV : 0;
  let p = p0.slice();
  for (let it = 0; it < (opts.iters ?? 4); it++) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
    for (let i = 0; i < v.length; i++) {
      const X = add(v[i], p), z = Math.max(0.03, X[2]);
      const r = [(X[0] / z - u[i][0]) * su, (X[1] / z - u[i][1]) * su];
      const J = [[su / z, 0, -su * X[0] / (z * z)], [0, su / z, -su * X[1] / (z * z)]];
      for (let a = 0; a < 3; a++) {
        g[a] -= J[0][a] * r[0] + J[1][a] * r[1];
        for (let b = 0; b < 3; b++) A[a][b] += J[0][a] * J[0][b] + J[1][a] * J[1][b];
      }
    }
    if (wv) for (let a = 0; a < 3; a++) { A[a][a] += wv * wv; g[a] -= wv * wv * (p[a] - pPrev[a]); }
    const dp = solve(A, g);
    p = add(p, dp);
    if (Math.hypot(...dp) < 1e-7) break;
  }
  let err = 0;
  for (let i = 0; i < v.length; i++) {
    const X = add(v[i], p);
    err += Math.hypot(X[0] / X[2] - u[i][0], X[1] / X[2] - u[i][1]) * W * f;
  }
  return { p, wrist: add(v[0], p), err: err / v.length };
}

/** OAT's camera self-calibration: the focal length estimated jointly with p from one frame (the
 *  hand's depth extent makes the perspective, and so f, observable; weakly: hence the prior on
 *  it, hfov ~ priorHfov, and the median over many frames). Returns {f, p}. */
export function solveWristAndFocal(lm, wl, W, H, p0, opts = {}) {
  const sigPx = opts.sigPx ?? 1.5;
  const f0 = 0.5 / Math.tan((opts.priorHfov ?? 60) / 2 * Math.PI / 180);
  const sigLogF = opts.sigLogF ?? 0.5;                            // (weak: a factor ~1.6 either way)
  // image points in image widths from the centre; the model: a_i = f * pi(v_i + p)
  const a = lm.map(q => [q.x - 0.5, (q.y - 0.5) * (H / W)]);
  const v = wl.map(q => [q.x, q.y, q.z]);
  const s = W / sigPx;
  let p = p0.slice(), lf = Math.log(opts.f ?? f0);
  for (let it = 0; it < (opts.iters ?? 8); it++) {
    const f = Math.exp(lf);
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], g = [0, 0, 0, 0];
    const acc = (J, r) => {
      for (let i = 0; i < 4; i++) { g[i] -= J[i] * r; for (let j = 0; j < 4; j++) A[i][j] += J[i] * J[j]; }
    };
    for (let i = 0; i < v.length; i++) {
      const X = add(v[i], p), z = Math.max(0.03, X[2]);
      const px = X[0] / z, py = X[1] / z;
      // d(f px)/dp = f [1/z, 0, -x/z^2], d(f px)/d(log f) = f px
      acc([s * f / z, 0, -s * f * X[0] / (z * z), s * f * px], (f * px - a[i][0]) * s);
      acc([0, s * f / z, -s * f * X[1] / (z * z), s * f * py], (f * py - a[i][1]) * s);
    }
    acc([0, 0, 0, 1 / sigLogF], (lf - Math.log(f0)) / sigLogF);
    for (let i = 0; i < 4; i++) A[i][i] += 1e-9;
    const d = solve(A, g);
    p = add(p, d.slice(0, 3));
    lf += Math.max(-0.3, Math.min(0.3, d[3]));
    if (Math.hypot(...d) < 1e-7) break;
  }
  return { f: Math.exp(lf), p };
}
export const hfovOf = (f) => 2 * Math.atan(0.5 / f) * 180 / Math.PI;

/** The focal length from many frames of the hand (the checklist's), OAT's self-calibration made
 *  steadier: one frame's 3D points are too noisy (their depth noise flattens the perspective that
 *  reveals f, and biases it: synthetic hfov 70 came out 47 that way). So the hand's shape is first
 *  averaged over the frames (in the palm's frame), each frame poses that average with a 3D fit (a
 *  rotation that doesn't depend on f), and one f is searched (golden section) that best explains
 *  every frame's image points with each frame's wrist position solved (eq. 2).
 *  frames: [{lm, wl}] (an open hand). Returns the horizontal field of view [deg]. ~5 ms. */
export function estimateHfov(frames, W, H, { lo = 30, hi = 110 } = {}) {
  const locs = frames.map(fr => {
    const P = PALM_IDS.map(i => [fr.wl[i].x, fr.wl[i].y, fr.wl[i].z]), pf = palmFrame(P);
    return fr.wl.map(q => mulMV(T(pf.R), sub([q.x, q.y, q.z], pf.c)));
  });
  const S = locs[0].map((_, i) => scale(locs.reduce((s, L) => add(s, L[i]), [0, 0, 0]), 1 / locs.length));
  const V = frames.map(fr => {
    const ft = fitRotation(S, fr.wl.map(q => [q.x, q.y, q.z]), S.map(() => 1));
    return S.map(x => add(mulMV(ft.R, sub(x, ft.ca)), ft.cb)).map(q => ({ x: q[0], y: q[1], z: q[2] }));
  });
  const P0 = frames.map(() => [0, 0, 0.4]);
  const cost = (hf) => {
    const f = focalOf(hf);
    let c = 0;
    frames.forEach((fr, k) => { const r = solveWristPosition(fr.lm, V[k], W, H, f, P0[k], null, { iters: 6 }); P0[k] = r.p; c += r.err ** 2; });
    return c;
  };
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi, x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = cost(x1), f2 = cost(x2);
  for (let it = 0; it < 25; it++) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = cost(x1); }
    else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = cost(x2); }
  }
  return (a + b) / 2;
}

/** The hand's 21 points with less noise for eq. 2: their shape in the palm's frame, averaged over
 *  the last frames (a running mean: the fingers still move it), posed by the palm's rotation (from
 *  the sharp image points). With MediaPipe's per-frame 3D points as they come, the wrist was 3-5 x
 *  noisier than the palm-only solution (synthetic tests); with this, all joints are on par with it
 *  still and a little better while the hand tilts. */
export class HandShape {
  constructor(alpha = 0.1) { this.alpha = alpha; this.S = null; }
  reset() { this.S = null; }
  /** wl: 21 3D points, R: the palm's rotation (palm frame -> camera), alpha: this frame's share
   *  (higher while the fingers move: the average must keep up). Returns 21 {x, y, z}. */
  update(wl, R, alpha = this.alpha) {
    const P = PALM_IDS.map(i => [wl[i].x, wl[i].y, wl[i].z]), pf = palmFrame(P);
    const loc = wl.map(q => mulMV(T(pf.R), sub([q.x, q.y, q.z], pf.c)));
    this.S = this.S ? this.S.map((x, i) => add(x, scale(sub(loc[i], x), alpha))) : loc;
    return this.S.map(x => mulMV(R, x)).map(q => ({ x: q[0], y: q[1], z: q[2] }));
  }
}
export function focalOf(hfov) { return 0.5 / Math.tan(hfov / 2 * Math.PI / 180); }

// ------------------------------------------------------------ OAT: grasp stabilization
// The 15 finger points (thumb, index ... pinky: the joints beyond the palm's), MediaPipe's numbering
export const FINGER_IDS = [2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];

/** The hand's shape: the 15 finger points in the palm's own frame, divided by the palm's length
 *  (wrist -> middle knuckle): the same whatever the hand's position, turn and size. */
export function fingerShape(wl) {
  const P = PALM_IDS.map(i => [wl[i].x, wl[i].y, wl[i].z]);
  const fr = palmFrame(P);
  const L = Math.max(1e-3, len(sub(P[3], P[0])));
  const q = [];
  for (const i of FINGER_IDS) {
    const l = mulMV(T(fr.R), sub([wl[i].x, wl[i].y, wl[i].z], fr.c));
    q.push(l[0] / L, l[1] / L, l[2] / L);
  }
  return q;
}

/** OAT's grasp stabilization (eq. 3-4). Closing or opening the hand bends the palm and changes
 *  what the tracker sees, which moves and turns the estimated wrist although the wrist stays put.
 *  While the hand's shape changes fast (its speed psi > threshold), and until `still` calm frames
 *  have followed, the output pose stays frozen and the raw pose's change goes into a bias:
 *      position  b += raw_prev - raw_now          rotation  B = B R_prev R_now^T
 *      output    raw + b,  B R_raw
 *  so when it lets go the output continues from where it was, without a jump; a deliberate move
 *  with a steady hand shape is never frozen.
 *  psi is the shape's change over the last `window` frames (per second): MediaPipe's 3D points
 *  jitter by millimetres from frame to frame, as fast as a pinch, but the jitter doesn't add up
 *  over a window and a pinch does (synthetic tests: a still hand stays below 3.0, a 0.3 s pinch
 *  peaks above 4.7). A window detects late, so when it trips, the output is rolled back to where it
 *  was `window` frames before (before the shape began to change) and held there: the drift that
 *  leaked out in the meantime is undone. Rolled back to a lightly smoothed track of the pose (~0.15
 *  s), not one frame: one raw frame is noisy itself (millimetres, a degree), and holding a noisy
 *  sample made the filters after it drift toward it. For the same reason, when it lets go the bias
 *  is set against the raw pose smoothed, not the last frame (whose noise would stay as an offset). */
export class GraspStabilizer {
  constructor({ threshold = 3.8, window = 8, still = 10, smooth = 0.35, track = 0.2, rollback = true } = {}) {
    this.threshold = threshold; this.window = window; this.still = still; this.smooth = smooth; this.track = track;
    this.rollback = rollback;
    this.b = [0, 0, 0]; this.B = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    this.reset();
  }
  /** forget the shape, the last poses and the bias (a new start: after a clutch, where the robot
   *  re-anchors anyway; a bias kept across them added up over a session, half a metre on a real
   *  hand, and the position divides by the depth) */
  reset() { this.b = [0, 0, 0]; this.B = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; this.q = null; this.qs = []; this.outs = []; this.sm = null; this.raw = null; this.held = null; this.prev = null; this.calm = this.still; this.psi = 0; this.t = null; }
  get frozen() { return this.calm < this.still; }
  /** From now on the output is `pos`, `R` (the bias set so: the caller's own steady estimate of
   *  where the pose was, e.g. its filters' state from before the change). */
  rebase(pos, R) {
    if (!this.prev) return;
    this.b = pos.map((x, i) => x - this.prev.pos[i]);
    this.B = orthonormal(mulMM(R, T(this.prev.R)));
    this.held = { pos: pos.slice(), R };
  }
  /** q: fingerShape(), pos [n] (a position; the core adds the twist angle), R [3x3] (the raw pose),
   *  t [s]. Returns {pos, R, frozen, psi}. */
  update(q, pos, R, t) {
    if (q) {
      if (this.q === null || t - this.t > 0.5) { this.q = q.slice(); this.qs = []; }
      else this.q = this.q.map((x, i) => x + this.smooth * (q[i] - x));      // (lightly low-passed)
      this.qs.push({ q: this.q, t });
      if (this.qs.length > this.window + 1) this.qs.shift();
      const o = this.qs[0];
      this.psi = this.qs.length > this.window
        ? Math.sqrt(this.q.reduce((s, x, i) => s + (x - o.q[i]) ** 2, 0)) / Math.max(1e-3, t - o.t) : 0;
      this.t = t;
    }
    const wasFrozen = this.frozen;
    if (this.psi > this.threshold) this.calm = 0;
    else if (this.calm < this.still) this.calm++;
    // the raw pose, lightly smoothed (for setting the bias when it lets go)
    this.raw = this.raw === null || this.raw.pos.length !== pos.length ? { pos: pos.slice(), R }
      : { pos: this.raw.pos.map((x, i) => x + this.track * (pos[i] - x)), R: slerpM(this.raw.R, R, this.track) };
    if (this.frozen && !wasFrozen && this.outs.length && this.rollback) {
      // it just tripped: back to the output from before the shape began to change, held there
      const o = this.outs[0];
      this.b = o.pos.map((x, i) => x - pos[i]);
      this.B = orthonormal(mulMM(o.R, T(R)));
    } else if (this.frozen && this.prev) {             // (frozen: the raw change goes into the bias)
      this.b = this.b.map((x, i) => x + this.prev.pos[i] - pos[i]);
      this.B = orthonormal(mulMM(this.B, mulMM(this.prev.R, T(R))));
    } else if (wasFrozen && this.held) {               // (it lets go: the bias against the smoothed raw pose)
      this.b = this.held.pos.map((x, i) => x - this.raw.pos[i]);
      this.B = orthonormal(mulMM(this.held.R, T(this.raw.R)));
    }
    this.prev = { pos: pos.slice(), R };
    if (this.b.length !== pos.length) this.b = pos.map(() => 0);
    const out = { pos: pos.map((x, i) => x + this.b[i]), R: orthonormal(mulMM(this.B, R)), frozen: this.frozen, psi: this.psi };
    if (!this.frozen) {                                 // (the recent outputs, smoothed, for a roll-back)
      this.sm = this.sm === null ? { pos: out.pos.slice(), R: out.R }
        : { pos: this.sm.pos.map((x, i) => x + this.track * (out.pos[i] - x)), R: slerpM(this.sm.R, out.R, this.track) };
      this.outs.push(this.sm);
      if (this.outs.length > this.window + 1) this.outs.shift();
    } else { this.outs = []; this.held = { pos: out.pos.slice(), R: out.R }; this.sm = this.held; }
    return out;
  }
}
