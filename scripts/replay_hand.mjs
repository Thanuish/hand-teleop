// Replays recorded real hand tracking (hand_tracking.jsonl, written by the test: MediaPipe's
// points per frame) through the hand control, and measures what the robot would do:
//     node scripts/replay_hand.mjs [log.jsonl ...] [--set '{"depth":{"beta":6}}']
// Without logs: every data/**/hand_tracking.jsonl. --set overrides SETTINGS (core.js) for tuning.
//
//   still     the hand held still (the unfiltered replay smoothed over 0.5 s: < 4 mm/s on the robot):
//             the robot's motion there, mm per frame (rms) and its wander (95th percentile
//             distance from the window's mean)
//   rough     the hand moving: how unevenly the robot moves, the rms of the change of its
//             per-frame step (mm): a glide has steps that change gradually
//   lag       the robot behind the hand: the time shift that best lines up the robot's motion
//             with the same replay unfiltered (then smoothed over 0.2 s without delay)
// All in the robot's frame, scaled by hand_motion_scale (what the robot does, in mm).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HandControl, SETTINGS } from '../TEST_TELEOP/web/hand/core.js';

const args = process.argv.slice(2);
const setAt = args.indexOf('--set');
const over = setAt >= 0 ? JSON.parse(args.splice(setAt, 2)[1]) : {};
const apply = (o) => { for (const [k, v] of Object.entries(o)) SETTINGS[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...SETTINGS[k], ...v } : v; };
const BASE = structuredClone(SETTINGS);
// (the reference for the lag: no filters, no dead band, no lead)
const RAW = { pos: { minCutoff: 1e3, beta: 0 }, depth: { minCutoff: 1e3, beta: 0 }, refDepth: { minCutoff: 1e3, beta: 0 },
              deadPos: [1e-6, 1e-6, 1e-6], depthMedian: 1, depthSpeed: 1e3, lead: 0 };
const TOML = readFileSync(new URL('../config/screening.toml', import.meta.url), 'utf8');
const SCALE = Number(/hand_motion_scale\s*=\s*([\d.]+)/.exec(TOML)?.[1] ?? 0.35);
// the server's smoothing of the target (vrteleop/arms.py _smooth_damp, 100 ticks a second): what
// the robot really follows. --server 0: the browser's output alone
const sAt = args.indexOf('--server');
const SMOOTH = sAt >= 0 ? Number(args.splice(sAt, 2)[1]) : Number(/hand_smoothing_s\s*=\s*([\d.]+)/.exec(TOML)?.[1] ?? 0.05);
const foAt = args.indexOf('--first-order');                 // (the smoother before: a first-order lag)
const FIRST_ORDER = foAt >= 0 && !!args.splice(foAt, 1);
function smoothDamp(x, target, v, T, dt) {
  const w = 2 / T, k = w * dt, e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
  const d = x.map((xi, i) => xi - target[i]), tmp = v.map((vi, i) => (vi + w * d[i]) * dt);
  return [target.map((ti, i) => ti + (d[i] + tmp[i]) * e), v.map((vi, i) => (vi - w * tmp[i]) * e)];
}
/** rows' out through the server's smoother (the latest output held between frames, 100 Hz ticks) */
function serverSide(rows) {
  if (!SMOOTH) return rows;
  let x = null, v = [0, 0, 0], t = null, ep = null;
  return rows.map((r) => {
    if (!r.out) { x = null; return r; }
    if (x === null || r.epoch !== ep) { x = r.out.slice(); v = [0, 0, 0]; t = r.t; ep = r.epoch; prevOut = r.out; return { ...r, out: x.slice() }; }
    for (; t + 0.01 <= r.t; t += 0.01) {
      if (FIRST_ORDER) { const a = 1 - Math.exp(-0.01 / SMOOTH); x = x.map((xi, i) => xi + (prevOut[i] - xi) * a); }
      else [x, v] = smoothDamp(x, prevOut, v, SMOOTH, 0.01);
    }
    prevOut = r.out;
    return { ...r, out: x.slice() };
  });
}
let prevOut = null;

function findLogs(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...findLogs(p));
    else if (n === 'hand_tracking.jsonl') out.push(p);
  }
  return out;
}
const logs = args.length ? args : findLogs(new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** one log through a HandControl: per frame {t, out (robot mm, while driving), raw (hand mm, camera)} */
function replay(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  let clock = 0;
  const sent = [];
  const st = { view_yaw: 0, task_game: { rotation: 'yaw', arm: 'right' } };
  const hc = new HandControl({ camera: 'front', send: (m) => sent.push(m), status: () => st, now: () => clock, gripMode: 'pinchToggle' });
  const rows = [];
  let tracked = 0, t0 = null;
  for (const L of lines) {
    if (L.cam && L.cam !== 'front') continue;
    t0 ??= L.t;
    clock = (L.t - t0) * 1000;
    hc.video = { videoWidth: L.W || 1280, videoHeight: L.H || 720 };
    const lm = L.lm && L.lm.map(([x, y]) => ({ x, y }));
    const wl = L.wl && L.wl.map(([x, y, z]) => ({ x, y, z }));
    const n = sent.length;
    hc._result({ lm, wl, t: clock, pose: null, ms: L.ms });
    if (lm) tracked++;
    if (!hc.armed && tracked > 60) hc.arm(true);
    const m = sent.length > n ? sent.at(-1).right : null;
    const s = hc.lastState;
    rows.push({ i: rows.length, t: clock / 1000, out: m && m.grip && s?.gesture === 'open' && !s.held ? m.pose.slice(0, 3).map(x => x * SCALE * 1000) : null,
                epoch: m?.epoch, raw: lm ? [lm[0].x * 1000, lm[0].y * 1000] : null });
  }
  return rows;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const rms = (a) => Math.sqrt(mean(a.map(x => x * x)));
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));

function measure(rows, ref) {
  // runs of consecutive driven frames in one epoch
  const runs = [];
  let cur = [];
  for (const r of rows) {
    if (r.out && cur.length && r.epoch === cur[0].epoch && r.t - cur.at(-1).t < 0.2) cur.push(r);
    else { if (cur.length > 15) runs.push(cur); cur = r.out ? [r] : []; }
  }
  if (cur.length > 15) runs.push(cur);
  const still = [], wander = [], rough = [], lags = [];
  for (const run of runs) {
    // the raw hand smoothed without delay (centred 0.5 s mean of the wrist in the picture), its speed
    // the hand's speed in all three directions: the unfiltered replay (the robot's mm), smoothed
    // over 0.5 s without delay (the picture alone missed motion toward / away from the camera)
    const H = Math.round(0.25 / Math.max(1e-3, (run.at(-1).t - run[0].t) / run.length));
    const sm = run.map((_, i) => {
      const w = run.slice(Math.max(0, i - H), i + H + 1).map(x => ref[x.i]?.out).filter(Boolean);
      return w.length ? [0, 1, 2].map(k => mean(w.map(p => p[k]))) : null;
    });
    const spd = sm.map((p, i) => (i && p && sm[i - 1]) ? dist(p, sm[i - 1]) / Math.max(1e-3, run[i].t - run[i - 1].t) : null);
    // still: under 4 mm/s on the robot (~1 cm/s of hand); moving: over 15 mm/s
    let w = [];
    const flush = () => {
      if (w.length > 15) {
        const c = [0, 1, 2].map(k => mean(w.map(r => r.out[k])));
        for (let i = 1; i < w.length; i++) still.push(w[i].out.map((x, k) => x - w[i - 1].out[k]));
        wander.push(pct(w.map(r => dist(r.out, c)), 0.95));
      }
      w = [];
    };
    run.forEach((r, i) => { if (spd[i] !== null && spd[i] < 4) w.push(r); else flush(); });
    flush();
    // moving: the change of the per-frame step
    for (let i = 2; i < run.length; i++) {
      if (spd[i] === null || spd[i] < 15) continue;
      const a = run[i].out.map((x, k) => x - run[i - 1].out[k]), b = run[i - 1].out.map((x, k) => x - run[i - 2].out[k]);
      rough.push(a.map((x, k) => x - b[k]));
    }
    // lag: the shift (frames) that best lines up the robot's motion with the unfiltered replay's
    // (smoothed over 0.2 s, centred: no delay of its own); only runs that really move
    const rr = run.map(r => ref[r.i]?.out);
    if (run.length > 60 && rr.every(Boolean)) {
      const K = Math.max(1, Math.round(0.1 / Math.max(1e-3, (run.at(-1).t - run[0].t) / run.length)));
      // (both smoothed the same centred way: differencing raw noise makes neighbouring steps
      // anti-correlated, which pulled the best shift away from the true one)
      const cs = (P) => P.map((_, i) => { const w = P.slice(Math.max(0, i - K), i + K + 1); return [0, 1, 2].map(k => mean(w.map(p => p[k]))); });
      const rs = cs(rr), os = cs(run.map(r => r.out));
      const vo = os.map((p, i) => i ? p.map((x, k) => x - os[i - 1][k]) : [0, 0, 0]);
      const vr = rs.map((p, i) => i ? p.map((x, k) => x - rs[i - 1][k]) : [0, 0, 0]);
      if (dist(rs.at(-1), rs[0]) > 0 && vr.reduce((s, v) => s + Math.hypot(...v), 0) > 30) {
        let best = 0, bestC = -Infinity;
        for (let s = 0; s <= 15; s++) {
          let c = 0;
          for (let i = s; i < run.length; i++) c += vo[i][0] * vr[i - s][0] + vo[i][1] * vr[i - s][1] + vo[i][2] * vr[i - s][2];
          if (c > bestC) { bestC = c; best = s; }
        }
        lags.push(best * (run.at(-1).t - run[0].t) / run.length * 1000);
      }
    }
  }
  return { still, wander, rough, lags };
}

const all = { still: [], wander: [], rough: [], lags: [] };
for (const p of logs) {
  apply(BASE); apply(RAW);
  const ref = replay(p);
  apply(BASE); apply(over);
  const m = measure(serverSide(replay(p)), ref);
  for (const k in all) all[k].push(...m[k]);
}
const f = (x, d = 2) => x === undefined || Number.isNaN(x) ? '-' : x.toFixed(d);
console.log(`${logs.length} log(s); robot motion (mm, x${SCALE}; server smoothing ${SMOOTH} s):`);
// per axis: forward/back (toward/away from the camera), left/right, up/down
const ax = (V) => [0, 1, 2].map(k => f(rms(V.map(v => v[k])))).join(' / ');
console.log(`  still   step rms ${f(rms(all.still.map(v => Math.hypot(...v))))} mm/frame (fwd / side / up: ${ax(all.still)}), wander p95 ${f(mean(all.wander))} mm   (${all.still.length} frames)`);
console.log(`  moving  roughness rms ${f(rms(all.rough.map(v => Math.hypot(...v))))} mm (fwd / side / up: ${ax(all.rough)})   (${all.rough.length} frames)`);
console.log(`  lag     ${f(pct(all.lags, 0.5), 0)} ms median                               (${all.lags.length} runs)`);
