// Screening monitor overlay: shows the phase, instructions, timer and progress from the
// simulator's status (the 'teleop-status' events of main.js), and runs the hand control (a
// webcam watches the candidate's hand; or a phone's camera does, on its own page).
import { preload, HandControl, openCamera, HAND_BOX } from '/test-static/hand/core.js';
import { drawHand, drawBox, Checklist, COLORS, chipLabel, GRIP_TEXT, OPEN_TEXT } from '/test-static/hand/ui.js';
const $ = (id) => document.getElementById(id);
const code = window.TELEOP_BASE.split('/').pop();

let lastMsg = '', toastTimer = 0;
function toast(text) {
  $('toast').textContent = text;
  $('toast').style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').style.opacity = 0; }, 3500);
}

function fmt(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------ depth cues
// Seen on a flat screen, it's hard to judge how high the gripper is and where it would come down.
// So: a ring on the table straight below the gripper (where it would land), a thin line down to
// it, and both turn green when the fingertips are low enough to grab something ([depth_cues]).
const CFG = window.SCREEN_CONFIG, CUES = CFG.depth_cues;
const GRIP = CFG.gripper_prefix || `${CFG.arm}_gripper_`;   // the gripper's names (on the arm, or floating)
const TABLE_Z = CFG.table_z, GRAB_HEIGHT = CUES.grab_height;
const CUE_COLOUR = parseInt(CUES.color.slice(1), 16), GRAB_COLOUR = parseInt(CUES.grab_color.slice(1), 16);
let cues = null;
function makeCues() {
  const T = window.__teleop, THREE = T.THREE;
  if (cues) cues.grp.parent && cues.grp.parent.remove(cues.grp);
  const grp = new THREE.Group();
  T.mjRoot.add(grp);                                   // MuJoCo coordinates (z up)
  const mat = (opacity) => new THREE.MeshBasicMaterial({ color: CUE_COLOUR, transparent: true, opacity,
                                                         depthTest: false, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.028, 48), mat(0.9));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.005, 20), mat(0.9));
  const lineGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: CUE_COLOUR, transparent: true, opacity: 0.7,
                                                                      depthTest: false, depthWrite: false }));
  for (const o of [ring, dot, line]) { o.renderOrder = 10; o.frustumCulled = false; grp.add(o); }
  cues = { grp, ring, dot, line, colour: null };
}
function updateCues() {
  requestAnimationFrame(updateCues);
  const T = window.__teleop;
  if (!CUES.enabled || !T || !T.body) return;
  if (!cues) makeCues();
  const r = T.body(`${GRIP}right_pad`), l = T.body(`${GRIP}left_pad`);
  if (!r || !l) { cues.grp.visible = false; return; }
  const THREE = T.THREE, p = new THREE.Vector3(), q = new THREE.Vector3();
  r.getWorldPosition(p); l.getWorldPosition(q);
  p.add(q).multiplyScalar(0.5);                        // between the finger pads
  T.mjRoot.worldToLocal(p);
  const h = p.z - TABLE_Z;
  cues.grp.visible = h > -0.01 && h < 0.6;
  cues.ring.position.set(p.x, p.y, TABLE_Z + 0.0015);
  cues.dot.position.set(p.x, p.y, TABLE_Z + 0.0016);
  const pos = cues.line.geometry.attributes.position;
  pos.setXYZ(0, p.x, p.y, p.z); pos.setXYZ(1, p.x, p.y, TABLE_Z + 0.002);
  pos.needsUpdate = true;
  const colour = h < GRAB_HEIGHT ? GRAB_COLOUR : CUE_COLOUR;
  if (colour !== cues.colour) {
    for (const o of [cues.ring, cues.dot, cues.line]) o.material.color.setHex(colour);
    cues.colour = colour;
  }
}
window.addEventListener('teleop-scene', () => {      // (scene reloaded: rebuild)
  if (cues && cues.grp.parent) cues.grp.parent.remove(cues.grp);
  cues = null;
});
requestAnimationFrame(updateCues);

// ------------------------------------------------------------ the ghost gripper (predictive display)
// The robot is drawn from the simulator's state: the hand's motion reaches it over the network and
// back (~100-300 ms). The ghost, a see-through gripper, is drawn from the hand's input right here,
// the way the server will map it (vrteleop/teleop.py: from the moment of engaging, the input's
// motion x hand_motion_scale, its turn x hand_rotation_scale, about the point between the
// fingers), so the candidate sees at once where the robot is going; the robot follows it.
// Only when this computer's camera tracks the hand (with a phone, the input doesn't pass here).
const MOVE = CFG.hand_motion_scale ?? 0.5, TURN = CFG.hand_rotation_scale ?? 0.5;
const GHOST_COLOUR = 0x7fd4ff;
let ghost = null;
const gst = { on: false, epoch: null, c0p: null, c0q: null, p0: null, q0: null, off: null, pg: null, qg: null };
function makeGhost() {
  const T = window.__teleop, THREE = T.THREE;
  const mat = new THREE.MeshBasicMaterial({ color: GHOST_COLOUR, transparent: true, opacity: 0.35, depthWrite: false });
  const parts = T.mjRoot.children.filter(o => o.name && o.name.startsWith(GRIP)).map(b => {
    const c = b.clone(true);
    c.traverse(o => { if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 5; } });
    c.visible = false;
    T.mjRoot.add(c);
    return { real: b, ghost: c };
  });
  ghost = { parts, base: parts.find(x => x.real.name === `${GRIP}base_mount`) };
}
window.addEventListener('teleop-scene', () => {
  if (ghost) for (const x of ghost.parts) x.ghost.parent && x.ghost.parent.remove(x.ghost);
  ghost = null;
  gst.on = false;
});
/** the pinch point (between the finger pads) and the gripper's base, as drawn now (MuJoCo frame) */
function gripperNow() {
  const T = window.__teleop;
  const r = T.body(`${GRIP}right_pad`), l = T.body(`${GRIP}left_pad`), b = ghost?.base?.real;
  if (!r || !l || !b) return null;
  return { pivot: r.position.clone().add(l.position).multiplyScalar(0.5), bp: b.position.clone(), bq: b.quaternion.clone() };
}
/** each controller message this page sends: the ghost follows it the way the server will */
function ghostInput(m) {
  const T = window.__teleop, c = m?.[CFG.arm];
  if (!T?.THREE || !T.body) return;
  if (!ghost) makeGhost();
  const THREE = T.THREE;
  if (!(c && c.pose && c.grip > 0.6)) { gst.on = false; return; }
  const cp = new THREE.Vector3(c.pose[0], c.pose[1], c.pose[2]);
  const cq = new THREE.Quaternion(c.pose[4], c.pose[5], c.pose[6], c.pose[3]).normalize();
  if (!gst.on) {                                     // (engaged now: from the robot as drawn)
    const g = gripperNow();
    if (!g) return;
    gst.p0 = g.pivot; gst.q0 = g.bq;
    gst.off = g.bp.clone().sub(g.pivot).applyQuaternion(g.bq.clone().invert());   // (the base from the pivot, in its own frame)
    gst.c0p = cp.clone(); gst.cqPrev = cq.clone(); gst.qg = gst.q0.clone(); gst.epoch = c.epoch; gst.on = true;
  } else if (c.epoch !== gst.epoch) {                // (re-anchored: carries on from the ghost)
    gst.p0 = gst.pg.clone();
    gst.c0p = cp.clone(); gst.cqPrev = cq.clone(); gst.epoch = c.epoch;
  }
  gst.pg = gst.p0.clone().add(cp.clone().sub(gst.c0p).multiplyScalar(MOVE));
  // the turn added up message by message, as the server does (vrteleop/teleop.py: the turn since
  // engaging taken the shortest way flipped sides past 180 deg)
  const d = cq.clone().multiply(gst.cqPrev.clone().invert());       // (the world-frame step)
  if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
  const ang = 2 * Math.acos(Math.min(1, d.w));
  if (ang > 1e-6) gst.qg = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(d.x, d.y, d.z).normalize(), ang * TURN).multiply(gst.qg);
  gst.cqPrev = cq.clone();
}
function updateGhost() {
  requestAnimationFrame(updateGhost);
  if (!ghost) return;
  const show = gst.on && gst.pg && ghost.base;
  const g = show ? gripperNow() : null;
  // hidden when not driving, and once the robot has caught up (within 5 mm and 3 deg: it would only
  // double it); shown again past 10 mm / 6 deg (hysteresis: no flicker at the edge)
  const k = gst.shown ? 1 : 2;
  const behind = g && (g.pivot.distanceTo(gst.pg) > 0.005 * k || 2 * Math.acos(Math.min(1, Math.abs(g.bq.dot(gst.qg)))) > 3 * k * Math.PI / 180);
  const visible = gst.shown = !!(show && behind);
  for (const x of ghost.parts) x.ghost.visible = visible;
  if (!visible) return;
  // the base where the ghost is; the fingers as the real ones are now (open / closed), relative to it
  const bq = gst.qg, bp = gst.pg.clone().add(gst.off.clone().applyQuaternion(bq));
  const rb = ghost.base.real, inv = rb.quaternion.clone().invert();
  for (const x of ghost.parts) {
    const rel = x.real.position.clone().sub(rb.position).applyQuaternion(inv);
    x.ghost.position.copy(bp).add(rel.applyQuaternion(bq));
    x.ghost.quaternion.copy(bq).multiply(inv.clone().multiply(x.real.quaternion));
  }
}
requestAnimationFrame(updateGhost);
window.__ghost = { input: ghostInput, state: gst, get parts() { return ghost?.parts; } };   // (the browser console, tests)

// ------------------------------------------------------------ view aids ([view], [side_view])
// See-through arm: the shoulder, upper arm and forearm are drawn faint so they don't hide the
// work. Table grid: faint lines every few cm, for judging distances. Side view: a second small
// view from the side at table height, following the gripper, so its height is seen directly.
const VIEW = CFG.view, SIDE = VIEW.side;
let sideCam = null, sideFrame = null, sideLook = null;
function setupViewAids() {
  const T = window.__teleop, THREE = T.THREE;
  if (VIEW.arm_opacity < 1) {
    for (const link of ['shoulder_link', 'upper_arm_link', 'forearm_link']) {
      const b = T.body(`${CFG.arm}_${link}`);
      if (!b) continue;
      b.traverse(o => {
        if (!o.isMesh) return;
        o.material = o.material.clone();               // (materials are shared with other parts)
        Object.assign(o.material, { transparent: true, opacity: VIEW.arm_opacity, depthWrite: true });  // (hides its own inside)
        o.renderOrder = 5;
        o.castShadow = false;
      });
    }
  }
  const old = T.mjRoot.getObjectByName('screen_grid');
  if (old) T.mjRoot.remove(old);                       // (scene reloaded)
  if (VIEW.table_grid > 0) {
    const step = VIEW.table_grid, pts = [];
    const x0 = -0.15, x1 = 0.95, y0 = -0.75, y1 = 0.75, z = TABLE_Z + 0.0008;   // the table top
    for (let x = Math.ceil(x0 / step) * step; x <= x1 + 1e-9; x += step) pts.push(x, y0, z, x, y1, z);
    for (let y = Math.ceil(y0 / step) * step; y <= y1 + 1e-9; y += step) pts.push(x0, y, z, x1, y, z);
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x5a6070, transparent: true, opacity: 0.22 }));
    grid.name = 'screen_grid';
    T.mjRoot.add(grid);
  }
  if (SIDE.enabled) {
    sideCam = new THREE.PerspectiveCamera(SIDE.fov, 1.5, 0.02, 10);
    if (!sideFrame) {
      sideFrame = document.createElement('div');
      sideFrame.id = 'sideView';
      sideFrame.innerHTML = '<span>SIDE VIEW</span>';
      document.body.appendChild(sideFrame);
    }
    if (!T.afterRender.includes(drawSideView)) T.afterRender.push(drawSideView);
  }
}
function sideRect() {                                  // [x, y from the bottom, w, h] in CSS pixels
  const w = Math.round(window.innerWidth * SIDE.size), h = Math.round(w / 1.5);
  const top = 120;
  return [window.innerWidth - w - 18, window.innerHeight - top - h, w, h];
}
function drawSideView(renderer, scene) {
  const T = window.__teleop, THREE = T.THREE;
  const r = T.body(`${GRIP}right_pad`), l = T.body(`${GRIP}left_pad`);
  if (!r || !l) { sideFrame.style.display = 'none'; return; }
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  r.getWorldPosition(p); l.getWorldPosition(q);
  p.add(q).multiplyScalar(0.5);
  T.mjRoot.worldToLocal(p);                            // the gripper, MuJoCo frame
  const target = new THREE.Vector3(p.x, p.y, TABLE_Z + SIDE.height);
  if (!sideLook) sideLook = target.clone();
  sideLook.lerp(target, 0.12);                         // follows smoothly (no shaking)
  const dir = SIDE.side === 'left' ? 1 : -1;
  const eye = sideLook.clone().add(new THREE.Vector3(0, dir * SIDE.distance, 0.02));
  sideCam.position.copy(T.mjRoot.localToWorld(eye.clone()));
  sideCam.lookAt(T.mjRoot.localToWorld(sideLook.clone()));
  const [x, y, w, h] = sideRect();
  sideCam.aspect = w / h;
  // only what's within ~15 cm of the gripper (across the view) is shown: things nearer the side
  // camera (another object, the book holder) are cut away instead of hiding the gripper
  sideCam.near = Math.max(0.02, SIDE.distance - 0.15);
  sideCam.updateProjectionMatrix();
  Object.assign(sideFrame.style, { display: 'block', left: `${x}px`, bottom: `${y}px`, width: `${w}px`, height: `${h}px` });
  renderer.setScissorTest(true);
  renderer.setScissor(x, y, w, h);
  renderer.setViewport(x, y, w, h);
  renderer.render(scene, sideCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
}
window.addEventListener('teleop-scene', setupViewAids);
if (window.__teleop) setupViewAids();

let wasHoming = false;
// ------------------------------------------------------------ hand control
// The tracker starts loading now (a few seconds the first time), the camera when the candidate
// presses the button; the checklist (hand, fist, pinch, open) must be done before the hand
// drives the robot. A phone can be the camera instead (/h/<code>): then this page only watches.
let lastStatus = null, cam = null, hand = null, handState = null;
const tracker = preload();
tracker.then(({ delegate }) => {
  $('trackerState').textContent = `Hand tracker ready (${delegate === 'GPU' ? 'graphics chip' : 'processor'})`;
  $('trackerState').className = 'ok';
}).catch((e) => {
  $('trackerState').textContent = 'The hand tracker could not load: ' + e.message + '. Check the internet connection and reload.';
  $('trackerState').className = 'bad';
});
// done once in this tab: after a refresh only a short check, and the camera starts by itself when
// it is allowed already (sessionStorage: this tab only; it may be unavailable, then the full check)
const DONE_KEY = `checklist-done:${window.TELEOP_BASE}`;
const store = (f) => { try { return f(window.sessionStorage); } catch (e) { return null; } };
const again = store(s => s.getItem(DONE_KEY)) === '1';
// SPACE: close the gripper / open it again (as a pinch does)
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.target instanceof HTMLInputElement) return;
  e.preventDefault();                                     // (no page scroll, no button press)
  hand?.toggleGrip();
});
// ---- the setup wizard: each step checks itself and says what to fix (hint), with a short
// looping picture of the gesture. Then "Start": the hand drives and the practice begins.
const setup = { light: null, keys: new Set(), slowSince: null, slowAsked: false };
const anim = (a, b) => `<span class="flip"><i>${a}</i><i>${b}</i></span>`;
const boxHint = (st) => !st?.tracked ? 'Show your hand to the camera, palm toward it'
  : st.box.out || !st.box.inside ? 'Move your whole hand into the box'
  : st.box.fit === 'far' ? 'Move your hand closer to the camera'
  : st.box.fit === 'close' ? 'Move your hand back a little'
  : st.box.near ? 'A little more toward the middle of the box' : true;
const STEPS = again ? [
  ['camera', 'Camera on'],
  ['box', 'Welcome back: put your hand in the box', boxHint, { hold: 15 }],
  ['open', 'Open your hand ✋: it <b>drives</b> the robot again', (st) => st?.gesture === 'open' && !st.gripping || (st?.gripping ? 'Pinch 🤏 once to open the gripper' : false)],
] : [
  ['camera', 'Turn on your camera'],
  ['light', 'Enough light on your hand', (st, c) => c.light === null ? false
    : c.light < 55 ? 'Too dark: turn on a light or face a window' : c.light > 225 ? 'Too bright: avoid a window behind you or a light shining into the camera' : true, { hold: 3 }],
  ['speed', 'This computer tracks fast enough', (st, c) => {
    if (!st) return false;
    if (st.fps >= 15) return true;
    return c.slow ? `Only ${st.fps} pictures a second: close other apps and browser tabs, plug in the charger. Or track on our server, or continue anyway.`
      : 'Measuring…';
  }, { hold: 20 }],
  ['box', 'Put your hand in the box, palm toward the camera, about an arm\'s length away', boxHint, { hold: 20 }],
  ['fist', 'Make a fist ✊: that <b>pauses</b> the robot (move your hand without moving it)', (st) => st?.gesture === 'fist', { anim: anim('✋', '✊') }],
  ['pinch', GRIP_TEXT, (st) => st?.gripping === true, { anim: anim('✋', '🤏') }],
  ['open', OPEN_TEXT, (st) => (st?.gesture === 'open' && !st.gripping) || (st?.gripping ? 'Pinch 🤏 once more: the gripper opens' : false),
   { anim: anim('🤏', '✋') }],
  ['keys', 'Press <b>Q</b> and <b>E</b>: they turn the gripper left and right', (st, c) => c.keys.has('KeyQ') && c.keys.has('KeyE')
    || (c.keys.size ? `Now press ${c.keys.has('KeyQ') ? 'E' : 'Q'}` : false), { hold: 1, anim: '<span class="key">Q</span><span class="key">E</span>' }],
];
const checklist = new Checklist($('checklist'), () => {
  // done: a short summary, then the candidate starts when ready
  $('readyBox').classList.remove('hidden');
  $('slowBox').classList.add('hidden');
}, { steps: STEPS });
$('serverBtn').addEventListener('click', async () => {
  const b = $('serverBtn');
  b.disabled = true; b.textContent = 'Starting the server tracker…';
  try {
    await hand.useServer(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${window.TELEOP_BASE}/track`);
    b.textContent = 'Tracking on the server';
    setup.slowSince = null;                                 // (measure again, now with the server)
  } catch (e) {
    b.disabled = false; b.textContent = 'Track on our server';
    toast('The server tracker is not available right now: continue anyway, or try again later.');
  }
});
$('goBtn').addEventListener('click', () => {
  hand.arm(true);                                         // (now the hand drives: the test goes on)
  $('handBox').classList.remove('hidden');
  store(s => s.setItem(DONE_KEY, '1'));
});
$('slowBtn').addEventListener('click', () => checklist.skip());
window.addEventListener('keydown', (e) => { if (e.code === 'KeyQ' || e.code === 'KeyE') setup.keys.add(e.code); });
/** the camera picture's brightness (0-255), twice a second */
const lumaCanvas = document.createElement('canvas');
lumaCanvas.width = 32; lumaCanvas.height = 24;
setInterval(() => {
  if (!cam?.video?.videoWidth) return;
  const g = lumaCanvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(cam.video, 0, 0, 32, 24);
  const px = g.getImageData(0, 0, 32, 24).data;
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  setup.light = s / (px.length / 4);
}, 500);
/** the wizard's checks, every tracker frame: the slow-computer step offers "continue anyway" after 6 s */
function setupTick(st) {
  if (checklist.current === 'speed') {
    if (st.fps < 15) setup.slowSince ??= performance.now(); else setup.slowSince = null;
    const slow = setup.slowSince !== null && performance.now() - setup.slowSince > 6000;
    $('slowBox').classList.toggle('hidden', !slow && hand?.path !== 'server');
    checklist.update(true, st, { light: setup.light, keys: setup.keys, slow });
  } else {
    $('slowBox').classList.add('hidden');
    checklist.update(true, st, { light: setup.light, keys: setup.keys });
  }
}
/** during the test: a banner when the hand is near the box's edge or out of it (the robot pauses) */
function boxBanner(st) {
  const el = $('boxWarn');
  const show = hand?.armed && st.tracked && (st.outOfBox || st.box?.near);
  el.classList.toggle('hidden', !show);
  if (!show) return;
  el.classList.toggle('out', !!st.outOfBox);
  el.textContent = st.outOfBox ? 'Robot paused: bring your hand back into the box' : 'Near the edge of the box: move your hand toward the middle';
}
// a pinch (thumb and index finger together) closes the gripper, the next opens it; the hand only
// moves the robot: Q/E turn the gripper, W/S and A/D tilt it (in tasks with full rotation). Used
// here (this computer's camera) and sent to the robot (a phone as the camera reads them from its
// status); resent while held, so a lost page leaves no key stuck
const tiltKeys = { KeyW: 0, KeyS: 0, KeyA: 0, KeyD: 0, KeyQ: 0, KeyE: 0 };
function updateTilt() {
  const k = { pitch: tiltKeys.KeyW - tiltKeys.KeyS, roll: tiltKeys.KeyD - tiltKeys.KeyA, turn: tiltKeys.KeyQ - tiltKeys.KeyE };
  hand?.setTilt(k.pitch, k.roll, k.turn);
  window.__teleop?.send?.({ type: 'keys', ...k });
}
setInterval(() => { if (Object.values(tiltKeys).some(v => v)) updateTilt(); }, 250);
window.addEventListener('keydown', (e) => {
  if (e.code in tiltKeys && !(e.target instanceof HTMLInputElement)) { tiltKeys[e.code] = 1; updateTilt(); }
});
// C: the camera picture bigger / smaller
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC' && !e.repeat && !(e.target instanceof HTMLInputElement)) $('handBox').classList.toggle('big');
});
// The tracker slow (under 22 pictures a second for 3 s, the camera giving more): the 3D view
// draws fewer pixels and frames, step by step (it shares the graphics chip). While the start
// screen covers it, it hardly draws at all.
const RENDER_STEPS = [{ maxPixels: 1.6e6, maxFps: 40 }, { maxPixels: 1.0e6, maxFps: 30 }, { maxPixels: 0.6e6, maxFps: 30 },
                      { maxPixels: 0.4e6, maxFps: 24 }];
let renderStep = 0, slowSince = null;
function adaptRender(st) {
  const T = window.__teleop;
  if (!T?.setBudget) return;
  const covered = !$('start').classList.contains('hidden');
  const want = covered ? { maxPixels: RENDER_STEPS[renderStep].maxPixels, maxFps: 5 } : RENDER_STEPS[renderStep];
  if (T.budget.maxFps !== want.maxFps || T.budget.maxPixels !== want.maxPixels) T.setBudget(want);
  const now = performance.now();
  if (st.fps < 22 && renderStep < RENDER_STEPS.length - 1) {
    if (slowSince === null) slowSince = now;
    else if (now - slowSince > 3000) { renderStep++; slowSince = null; console.info('render budget lowered', RENDER_STEPS[renderStep]); }
  } else slowSince = null;
}
window.addEventListener('keyup', (e) => { if (e.code in tiltKeys) { tiltKeys[e.code] = 0; updateTilt(); } });
window.addEventListener('blur', () => { for (const k in tiltKeys) tiltKeys[k] = 0; updateTilt(); });
function setChip(el, state) {
  const g = state?.gesture || 'none';
  const label = chipLabel(state);
  el.style.color = !state?.tracked ? COLORS.none : (g === 'open' && !state.driving ? '#7fb4ff' : COLORS[g]);
  el.querySelector('b').textContent = label;
}
let lastDraw = 0;
function drawLoop(now) {
  requestAnimationFrame(drawLoop);
  if (!cam || now - lastDraw < 30) return;            // (the camera gives ~30 pictures a second: no more)
  lastDraw = now;
  if (!$('start').classList.contains('hidden')) {
    drawHand($('startCam'), cam.video, handState, { dim: 0.15 });
    drawBox($('startCam'), cam.video, handState, HAND_BOX);
  }
  if (!$('handBox').classList.contains('hidden')) {
    drawHand($('handPreview'), cam.video, handState, { dim: 0.2 });
    drawBox($('handPreview'), cam.video, handState, HAND_BOX);
  }
}
requestAnimationFrame(drawLoop);
$('camBtn').addEventListener('click', async () => {
  if (cam) return;
  $('camBtn').disabled = true;
  $('camBtn').textContent = 'Starting the camera…';
  try {
    cam = await openCamera('user');
    $('camOverlay').classList.add('hidden');
    $('startChip').querySelector('b').textContent = 'LOADING';
    await tracker;
    hand = new HandControl({
      camera: 'front',                     // (the webcam faces the candidate)
      send: (m) => { ghostInput(m); window.__teleop?.send?.(m); },
      status: () => lastStatus,
      gripMode: 'pinchToggle',             // (a pinch grips, the next lets go; the robot holds still while pinched)
      log: (frames) => window.__teleop?.send?.({ type: 'track_log', frames }),   // (the raw points, for tuning)
      onFrame: (st) => {
        handState = st;
        setupTick(st);
        boxBanner(st);
        setChip($('startChip'), st);
        setChip($('handChip'), st);
        $('handStats').textContent = st.tracked ? `${st.fps} fps · ${st.latency} ms` : `${st.fps} fps`;
        adaptRender(st);
      },
    });
    await hand.start(cam.video);
    $('camBtn').classList.add('hidden');
  } catch (e) {
    $('camBtn').disabled = false;
    $('camBtn').textContent = 'Start the camera';
    $('trackerState').textContent = 'Could not start the camera: ' + (e.message || e) + '. Allow the camera for this page, or use a phone as the camera.';
    $('trackerState').className = 'bad';
    if (cam) { cam.stop(); cam = null; }
  }
});
if (again) navigator.permissions?.query({ name: 'camera' }).then((p) => {
  if (p.state === 'granted') $('camBtn').click();
}).catch(() => {});
$('phoneCamBtn').addEventListener('click', (e) => {
  e.preventDefault();
  $('phoneCamQr').classList.toggle('hidden');
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyH' && hand?.armed) window.__teleop?.send?.({ type: 'home' });
});
window.addEventListener('teleop-status', (ev) => {
  lastStatus = ev.detail;
  $('robotState').textContent = 'Robot connected';
  $('robotState').className = 'ok';
});
window.addEventListener('teleop-scene-error', (ev) => {
  $('robotState').textContent = 'Connecting to the robot… (retrying)';
  $('robotState').className = 'bad';
});

window.addEventListener('teleop-status', (ev) => {
  const g = ev.detail.task_game;
  if (!g) return;
  $('phaseTitle').textContent = g.round ? `${g.title}  ·  round ${g.round}` : g.title;
  $('phaseText').textContent = g.text;
  const pairing = g.kind === 'pair';
  $('start').classList.toggle('hidden', !pairing);
  if (!pairing && cam && hand?.armed) $('handBox').classList.toggle('hidden', !!g.finished);
  $('done').classList.toggle('hidden', !g.finished);
  // steps
  const steps = $('steps');
  if (steps.children.length !== g.steps_total) {
    steps.innerHTML = '';
    for (let i = 0; i < g.steps_total; i++) steps.appendChild(document.createElement('span'));
  }
  [...steps.children].forEach((s, i) => s.classList.toggle('on', i < g.steps_done));
  // tower: its height now and the best that stood, blocks left, falls
  const tw = g.tower;
  $('taskHud').classList.toggle('hidden', !tw);
  steps.classList.toggle('hidden', !!tw || !!g.wire);
  if (tw) {
    $('taskHud').innerHTML = `Tower <b>${Math.round(tw.height * 100)} cm</b> (best ${Math.round(tw.best * 100)} cm, ` +
      `goal ${Math.round(tw.target * 100)} cm)  ·  blocks left ${tw.left}  ·  falls ${tw.falls}`;
  }
  // buzz wire: touches, how far along, a red glow while touching, a hint when the loop is off
  const w = g.wire;
  $('wireHud').classList.toggle('hidden', !w);

  $('buzzFlash').classList.toggle('on', !!(w && w.touching));
  if (w) {
    $('wireTouches').textContent = `Touches: ${w.touches}`;
    $('wireTouches').classList.toggle('hit', w.touching);
    $('wireBar').firstChild.style.width = `${Math.round(100 * w.progress)}%`;
    $('wireOff').textContent = w.off && g.intro === 0 ? 'The loop is off the wire: bring it back around the wire' : '';
  }
  // timer and countdown
  if (g.limit) {
    const left = g.intro > 0 ? g.limit : g.limit - g.time;
    $('timer').textContent = fmt(left);
    $('timer').classList.toggle('low', g.intro === 0 && left < 30);
    $('practice').textContent = g.scored ? '' : 'practice: not scored';
  } else {
    $('timer').textContent = '';
    $('practice').textContent = '';
  }
  // the task's card while it counts down: what to do, the controls that matter, the time; the
  // last 3 s the big countdown takes over
  const card = g.kind === 'task' && g.intro > 3;
  $('taskCard').classList.toggle('hidden', !card);
  if (card) {
    $('taskTag').textContent = g.scored ? 'Scored task' : 'Practice · not scored';
    $('taskTitle').textContent = g.title;
    $('taskText').textContent = g.text;
    const ctrls = ['✋ move', '✊ pause', '🤏 grip / let go', 'Q E turn'];
    if (g.rotation === 'full') ctrls.push('W S A D tilt');
    $('taskCtrls').innerHTML = ctrls.map(c => `<span>${c}</span>`).join('');
    $('taskMeta').textContent = `Time: ${fmt(g.limit)}  ·  starts in ${Math.ceil(g.intro)} s`;
  }
  $('count').textContent = g.intro > 0 && g.intro <= 3 ? Math.ceil(g.intro) : '';
  if (g.homing && !wasHoming) toast('Going home…');
  wasHoming = !!g.homing;
  if (g.message && g.message !== lastMsg) toast(g.message);
  lastMsg = g.message;
});
