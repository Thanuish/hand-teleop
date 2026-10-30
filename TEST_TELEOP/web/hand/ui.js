// What the hand-control pages show: the camera image (mirrored, like a mirror) with the hand's
// skeleton, coloured by what the hand does, and the short start checklist.
import { BONES } from './core.js';

export const COLORS = { open: '#3ee08f', fist: '#ffc24a', pinch: '#ff5f6d', none: '#9aa3b2' };
export const LABELS = { open: 'DRIVING', fist: 'PAUSED', pinch: 'GRIPPING', none: 'NO HAND' };

/** The status chip's text for a frame state: what the hand does, and whether the gripper is closed. */
export function chipLabel(st) {
  if (!st?.tracked) return 'NO HAND';
  const g = st.gesture;
  if (g === 'open' && !st.driving) return st.gripping ? 'READY · GRIP CLOSED' : 'READY';
  if (g === 'pinch') return st.gripping ? 'GRIP CLOSED' : 'GRIP OPEN';
  return st.gripping ? `${LABELS[g]} · GRIP CLOSED` : LABELS[g];
}

/** Draw the camera image and the hand (state from HandControl's onFrame) into a canvas. */
export function drawHand(canvas, video, state, { mirror = true, dim = 0.25 } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.save();
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  if (video && video.videoWidth) {
    // cover the canvas (crop, keep the aspect)
    const vr = video.videoWidth / video.videoHeight, cr = w / h;
    let sw = video.videoWidth, sh = video.videoHeight, sx = 0, sy = 0;
    if (vr > cr) { sw = sh * cr; sx = (video.videoWidth - sw) / 2; } else { sh = sw / cr; sy = (video.videoHeight - sh) / 2; }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    ctx.fillStyle = `rgba(10,12,18,${dim})`;
    ctx.fillRect(0, 0, w, h);
    const lm = state?.lm;
    if (lm) {
      const map = (p) => [((p.x * video.videoWidth) - sx) / sw * w, ((p.y * video.videoHeight) - sy) / sh * h];
      const col = state.driving === false && state.gesture === 'open' ? '#7fb4ff' : COLORS[state.gesture] || COLORS.none;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2, w / 160);
      ctx.strokeStyle = col;
      ctx.shadowColor = col; ctx.shadowBlur = 10;
      ctx.beginPath();
      for (const [a, b] of BONES) { const [x1, y1] = map(lm[a]), [x2, y2] = map(lm[b]); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      for (const p of lm) { const [x, y] = map(p); ctx.beginPath(); ctx.arc(x, y, Math.max(2, w / 220), 0, 7); ctx.fill(); }
      if (state.axes) {                                    // the hand's 3D orientation: its three axes
        const [ox, oy] = map(state.axes.o);
        ['#ff6b6b', '#5ee08f', '#6fa8ff'].forEach((c, j) => {
          const [x, y] = map(state.axes.axes[j]);
          ctx.strokeStyle = c; ctx.lineWidth = Math.max(2, w / 200);
          ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke();
        });
      }
      if (state.gesture === 'pinch') {                      // a ring at the pinch
        const [x1, y1] = map(lm[4]), [x2, y2] = map(lm[8]);
        ctx.strokeStyle = COLORS.pinch; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc((x1 + x2) / 2, (y1 + y2) / 2, w / 28, 0, 7); ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = '#0d1016'; ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

// the checklist's grip steps for gripMode 'pinchToggle' (pass as gripText, openText)
export const GRIP_TEXT = 'Open it, then pinch 🤏 thumb and index finger once: the gripper <b>closes</b>';
export const OPEN_TEXT = 'Pinch 🤏 again: it <b>opens</b>. Then open your hand ✋: now it <b>drives</b> the robot';

/** The start checklist: each step ticks off when done, in order; then onDone(). The default
 *  steps: camera on, hand seen, a fist (that pauses), a pinch (that grips), open the hand (go).
 *  opts.steps replaces them: [key, html, check?, {hold, anim}?] where check(state, ctx) returns
 *  true (done), false, or a string (not yet: a hint shown under the step, e.g. "move closer");
 *  hold: frames it must hold (default 6, the camera 1); anim: a short looping picture (HTML)
 *  shown beside the step while it is the current one. */
export class Checklist {
  constructor(el, onDone, { gripText, openText, again, steps } = {}) {
    this.el = el;
    this.onDone = onDone;
    // again: done before on this page (a refresh): only the camera, the hand and open
    this.steps = steps || (again ? [
      ['camera', 'Camera on'],
      ['hand', 'Welcome back: show your hand, the whole hand in view'],
      ['open', 'Open your hand ✋: it <b>drives</b> the robot again'],
    ] : [
      ['camera', 'Camera on'],
      ['hand', 'Show your hand: palm toward the camera, the whole hand in view'],
      ['fist', 'Make a fist ✊: that <b>pauses</b> the robot'],
      ['pinch', gripText || 'Open it, then pinch 🤏 thumb and index finger: that <b>grips</b>'],
      ['open', openText || 'Open your hand ✋: now it <b>drives</b> the robot'],
    ]);
    this.i = 0;
    this.held = 0;
    el.innerHTML = this.steps.map(([k, t, , o]) => `<li data-k="${k}"><span class="tick"></span><span class="txt"><span>${t}</span>`
      + `<span class="hint"></span></span>${o?.anim ? `<span class="anim${o.wide ? ' wide' : ''}">${o.anim}</span>` : ''}</li>`).join('');
    this.since = performance.now();                  // (when the current step began: minTime)
    this._render();
  }
  _render() {
    [...this.el.children].forEach((li, j) => {
      li.classList.toggle('done', j < this.i);
      li.classList.toggle('now', j === this.i);
    });
  }
  /** camera: is it on; state: HandControl's frame state; ctx: anything the checks need */
  update(camera, state, ctx = {}) {
    if (this.i >= this.steps.length) return;
    const [k, , check, o] = this.steps[this.i];
    const g = state?.gesture;
    const r = check ? check(state, { camera, ...ctx })
      : k === 'camera' ? camera
      : k === 'hand' ? !!state?.tracked
      : k === 'fist' ? g === 'fist'
      : k === 'pinch' ? g === 'pinch'
      : g === 'open' && !state?.gripping;
    // minTime [ms]: the step can't be done sooner (its picture is worth watching once)
    const early = o?.minTime && performance.now() - this.since < o.minTime;
    const ok = r === true && !early;
    const hint = this.el.children[this.i].querySelector('.hint');
    if (hint) hint.textContent = typeof r === 'string' ? r : early && r === true ? (o.earlyHint || '') : '';
    this.held = ok ? this.held + 1 : 0;
    if (this.held >= (o?.hold ?? (k === 'camera' ? 1 : 6))) {   // (held for a few frames: not a flicker)
      if (hint) hint.textContent = '';
      this.i++;
      this.held = 0;
      this.since = performance.now();
      this._render();
      if (this.i >= this.steps.length) this.onDone?.();
    }
  }
  /** skip the current step (a check that may be passed by, e.g. a slow device after a warning) */
  skip() {
    if (this.i >= this.steps.length) return;
    this.i++; this.held = 0; this.since = performance.now(); this._render();
    if (this.i >= this.steps.length) this.onDone?.();
  }
  get current() { return this.steps[this.i]?.[0] ?? null; }
  get done() { return this.i >= this.steps.length; }
}

/** How to reposition the hand (like lifting a mouse off the desk), as a short looping picture
 *  (8 s; the styles: .demo in screen.html): the camera's view on top, the hand box dashed; the
 *  table below. 1 the open hand moves, the gripper follows (smaller); 2 a fist: PAUSED; 3 the
 *  fist moves back, the gripper stays; 4 the hand opens and moves on, the gripper carries on
 *  from where it was. */
export function clutchDemo() {
  const hand = `<g class="d-open">
      <rect x="-12" y="-27" width="6" height="21" rx="3"/><rect x="-5" y="-31" width="6" height="25" rx="3"/>
      <rect x="2" y="-29" width="6" height="23" rx="3"/><rect x="9" y="-24" width="5.5" height="18" rx="2.75"/>
      <rect x="-24" y="-6" width="6" height="17" rx="3" transform="rotate(-38 -21 2)"/>
      <rect x="-13" y="-10" width="28" height="27" rx="9"/></g>
    <g class="d-fist">
      <rect x="-14" y="-15" width="29" height="31" rx="10"/>
      <path d="M-8 -9 v5 M-1 -10 v5 M6 -9 v5" class="d-crease"/>
      <rect x="-15" y="2" width="20" height="8" rx="4" class="d-thumb"/></g>`;
  const grip = `<ellipse cx="0" cy="24" rx="18" ry="4" class="d-shadow"/>
    <rect x="-13" y="-16" width="26" height="11" rx="3" class="d-metal"/>
    <rect x="-9" y="-6" width="18" height="6" rx="2" class="d-dark"/>
    <rect x="-12" y="0" width="6" height="17" rx="2" class="d-metal"/><rect x="6" y="0" width="6" height="17" rx="2" class="d-metal"/>`;
  return `<div class="demo" aria-label="Open hand moves the robot; a fist pauses it; move your hand back; open it and carry on">
<svg viewBox="0 0 360 214" xmlns="http://www.w3.org/2000/svg">
  <g class="d-all">
    <rect x="8" y="8" width="344" height="100" rx="12" class="d-panel"/>
    <text x="20" y="25" class="d-lbl">YOUR CAMERA</text>
    <rect x="34" y="30" width="292" height="70" rx="6" class="d-box"/>
    <g class="d-chip"><rect x="250" y="13" width="92" height="18" rx="9" class="d-chip-go"/><rect x="250" y="13" width="92" height="18" rx="9" class="d-chip-pause"/>
      <text x="296" y="26" class="d-chip-t d-t-go">● DRIVING</text><text x="296" y="26" class="d-chip-t d-t-pause">● PAUSED</text></g>
    <g transform="translate(100 70)"><g class="d-hand">${hand}</g></g>
    <rect x="8" y="116" width="344" height="68" rx="12" class="d-panel"/>
    <text x="20" y="133" class="d-lbl">THE ROBOT</text>
    <rect x="20" y="168" width="320" height="6" rx="3" class="d-table"/>
    <g transform="translate(100 148)"><g class="d-grip">${grip}</g></g>
    <text x="180" y="204" class="d-cap d-c1">1 · Open hand: the robot follows</text>
    <text x="180" y="204" class="d-cap d-c2">2 · Out of room? Make a fist: it pauses</text>
    <text x="180" y="204" class="d-cap d-c3">3 · Move the fist back: the robot stays</text>
    <text x="180" y="204" class="d-cap d-c4">4 · Open again: it carries on from there</text>
  </g>
</svg></div>`;
}

/** Draw the hand box on a camera canvas: green when the hand is well inside, amber near the
 *  edge, red when it is out (state.box from HandControl: {inside, near}). */
export function drawBox(canvas, video, state, box) {
  if (!video?.videoWidth) return;
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const vr = video.videoWidth / video.videoHeight, cr = w / h;
  let sw = 1, sh = 1, sx = 0, sy = 0;                              // (the same crop as drawHand, in 0..1)
  if (vr > cr) { sw = cr / vr; sx = (1 - sw) / 2; } else { sh = vr / cr; sy = (1 - sh) / 2; }
  const X = (x) => (1 - (x - sx) / sw) * w, Y = (y) => (y - sy) / sh * h;   // (mirrored)
  const b = state?.box;
  const col = !state?.tracked ? 'rgba(255,255,255,.35)' : !b?.inside ? '#ff5f6d' : b.near ? '#ffc24a' : '#3ee08f';
  ctx.save();
  ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, w / 240); ctx.setLineDash([w / 40, w / 60]);
  const x0 = X(box.x1), x1 = X(box.x0), y0 = Y(box.y0), y1 = Y(box.y1);
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}
