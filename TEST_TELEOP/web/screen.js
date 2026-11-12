// Screening monitor overlay: shows the phase, instructions, timer and progress from the
// simulator's status (the 'teleop-status' events of main.js), and runs the hand control (a
// webcam watches the candidate's hand; or a phone's camera does, on its own page).
import { preload, HandControl, openCamera, HAND_BOX } from '/test-static/hand/core.js';
import { drawHand, drawBox, Checklist, COLORS, chipLabel, clutchDemo, GRIP_TEXT, OPEN_TEXT } from '/test-static/hand/ui.js';
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
  $('trackerState').textContent = 'Hand tracker failed to load: ' + e.message + '. Check your internet and reload.';
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
// ---- the repositioning drill (like lifting a mouse off the desk): the candidate does it once,
// guided part by part, with the picture beside it. Tracked from the hand in the camera picture
// (the robot doesn't move during the setup): the wrist's position across the picture.
const DRILL_PARTS = ['Open hand: move it to one side', 'Make a fist', 'Keep the fist: move your hand back',
                     'Open your hand: move it to the side again'];
const DRILL = `<ol class="drill">${DRILL_PARTS.map((t, i) => `<li data-i="${i}"><b>${i + 1}</b><span>${t}</span></li>`).join('')}</ol>${clutchDemo()}`;
const drill = { part: 0, x0: null, dir: 0, xf: null, x1: null, hint: '' };
const MOVE_OPEN = 0.14, MOVE_BACK = 0.11, MOVE_AGAIN = 0.1;    // [picture widths]
function drillTick(st) {
  if (!st?.tracked || !st.lm) { drill.hint = 'Show your hand to the camera'; return; }
  const x = st.lm[0].x, g = st.gesture, d = drill;
  d.hint = '';
  if (d.part === 0) {                                  // open, moving to one side
    if (g !== 'open') { d.x0 = null; d.hint = 'Start with your hand open'; return; }
    d.x0 ??= x;
    if (Math.abs(x - d.x0) > MOVE_OPEN) { d.dir = Math.sign(x - d.x0); d.part = 1; }
  } else if (d.part === 1) {                           // a fist
    if (g === 'fist') { d.xf = x; d.part = 2; } else d.hint = 'Now close your hand into a fist';
  } else if (d.part === 2) {                           // the fist back the other way
    if (g !== 'fist') { d.hint = 'Keep the fist while you move your hand back'; return; }
    if ((d.xf - x) * d.dir > MOVE_BACK) d.part = 3;
    else if ((x - d.xf) * d.dir > 0.03) d.xf = x;     // (still going the first way: measure from the turn)
  } else if (d.part === 3) {                           // open again and on
    if (g !== 'open') { d.x1 = null; d.hint = 'Open your hand'; return; }
    d.x1 ??= x;
    if ((x - d.x1) * d.dir > MOVE_AGAIN) d.part = 4;
  }
}
window.__drill = { tick: drillTick, state: drill };               // (the browser console, tests)
function drillRender() {
  document.querySelectorAll('#checklist .drill li').forEach((li, i) => {
    li.classList.toggle('done', i < drill.part);
    li.classList.toggle('now', i === drill.part);
  });
}
const boxHint = (st) => !st?.tracked ? 'Show your palm to the camera'
  : st.box.out || !st.box.inside ? 'Whole hand into the box'
  : st.box.fit === 'far' ? 'Closer to the camera'
  : st.box.fit === 'close' ? 'A bit further back'
  : st.box.near ? 'More toward the middle' : true;
const STEPS = again ? [
  ['camera', 'Camera on'],
  ['box', 'Hand in the box', boxHint, { hold: 15 }],
  ['open', 'Open hand ✋ to <b>drive</b>', (st) => st?.gesture === 'open' && !st.gripping || (st?.gripping ? 'Pinch 🤏 to open the gripper' : false)],
] : [
  ['camera', 'Turn on your camera'],
  ['light', 'Enough light', (st, c) => c.light === null ? false
    : c.light < 55 ? 'Too dark: turn on a light' : c.light > 225 ? 'Too bright: no window or lamp behind you' : true, { hold: 3 }],
  ['speed', 'Tracking speed', (st, c) => {
    if (!st) return false;
    // (a camera sending few frames while the tracking is quick: usually a dim room, the camera
    // exposing longer. Said for a few seconds, then on: it works, only less smoothly)
    if (st.fps >= 15 && st.fps < 24 && st.ms < 25 && !c.camOk)
      return `Your camera sends only ${st.fps} pictures a second. More light on you makes the robot smoother.`;
    if (st.fps >= 15) return true;
    return c.slow ? `Slow (${st.fps} fps): close other tabs, plug in the charger, or continue anyway.`
      : 'Measuring…';
  }, { hold: 20 }],
  ['box', 'Hand in the box, palm to the camera', boxHint, { hold: 20 }],
  ['fist', 'Fist ✊ <b>pauses</b> the robot', (st) => st?.gesture === 'fist', { anim: anim('✋', '✊') }],
  ['drill', '<b>Out of room?</b> Fist, move back, open. Like lifting a mouse. Try it:',
   () => drill.part >= 4 || drill.hint || false, { anim: DRILL, wide: true, hold: 1 }],
  ['pinch', GRIP_TEXT, (st) => st?.gripping === true, { anim: anim('✋', '🤏') }],
  ['open', OPEN_TEXT, (st) => (st?.gesture === 'open' && !st.gripping) || (st?.gripping ? 'Pinch 🤏 again to open' : false),
   { anim: anim('🤏', '✋') }],
  ['keys', '<b>Q</b> / <b>E</b> turn the gripper', (st, c) => c.keys.has('KeyQ') && c.keys.has('KeyE')
    || (c.keys.size ? `Now ${c.keys.has('KeyQ') ? 'E' : 'Q'}` : false), { hold: 1, anim: '<span class="key">Q</span><span class="key">E</span>' }],
  ['view', '<b>Drag</b> to look around, <b>scroll</b> to zoom. <b>R</b> resets.',
   (st, c) => (c.view.dragged && c.view.zoomed) || (c.view.dragged ? 'Now scroll' : c.view.zoomed ? 'Now drag' : false),
   { hold: 1, anim: anim('🖱️', '🔍') }],
];
// the look-around step: a real drag (not a click) and a scroll / pinch on the 3D view
const view = { dragged: false, zoomed: false };
function watchView() {
  const cv = window.__teleop?.renderer?.domElement;
  if (!cv || cv.dataset.watched) return;
  cv.dataset.watched = '1';
  let down = null;
  cv.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  cv.addEventListener('pointermove', (e) => {
    if (down && e.buttons && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 40) view.dragged = true;
  });
  window.addEventListener('pointerup', () => { down = null; });
  cv.addEventListener('wheel', () => { view.zoomed = true; }, { passive: true });
}
window.addEventListener('teleop-scene', watchView);
setTimeout(watchView, 0);
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
    toast('Server tracking unavailable: continue anyway.');
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
    setup.speedSince ??= performance.now();
    const camOk = performance.now() - setup.speedSince > 6000;
    $('slowBox').classList.toggle('hidden', !slow && hand?.path !== 'server');
    checklist.update(true, st, { light: setup.light, keys: setup.keys, slow, camOk });
  } else {
    $('slowBox').classList.add('hidden');
    checklist.update(true, st, { light: setup.light, keys: setup.keys, view });
  }
  // the look-around step: the setup becomes a side panel, the 3D view free to try
  $('start').classList.toggle('peek', checklist.current === 'view');
  if (checklist.current === 'drill') { drillTick(st); drillRender(); }
}
/** during the test: a banner when the hand is near the box's edge or out of it (the robot pauses),
 *  or far from the camera for a while (there the distance is guessed from a small hand: moving
 *  sideways can push the robot forward or back) */
let farSince = null;
function boxBanner(st) {
  const el = $('boxWarn');
  const far = hand?.armed && st.tracked && st.box?.fit === 'far';
  farSince = far ? (farSince ?? performance.now()) : null;
  const tooFar = far && performance.now() - farSince > 1500;
  const show = hand?.armed && st.tracked && (st.outOfBox || st.box?.near || tooFar);
  el.classList.toggle('hidden', !show);
  if (!show) return;
  el.classList.toggle('out', !!st.outOfBox);
  el.textContent = st.outOfBox ? 'Paused: hand back into the box'
    : st.box?.near ? 'Near the edge: move toward the middle'
    : 'Too far: come closer to the camera';
}
// a pinch (thumb and index finger together) closes the gripper, the next opens it; the hand only
// moves the robot: Q/E turn the gripper (the games need no tilting: no tilt keys). Used
// here (this computer's camera) and sent to the robot (a phone as the camera reads them from its
// status); resent while held, so a lost page leaves no key stuck
const turnKeys = { KeyQ: 0, KeyE: 0 };
function updateTurn() {
  const k = { pitch: 0, roll: 0, turn: turnKeys.KeyQ - turnKeys.KeyE };
  hand?.setTilt(k.pitch, k.roll, k.turn);
  window.__teleop?.send?.({ type: 'keys', ...k });
}
setInterval(() => { if (Object.values(turnKeys).some(v => v)) updateTurn(); }, 250);
window.addEventListener('keydown', (e) => {
  if (e.code in turnKeys && !(e.target instanceof HTMLInputElement)) { turnKeys[e.code] = 1; updateTurn(); }
});
// C: the camera picture bigger / smaller
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC' && !e.repeat && !(e.target instanceof HTMLInputElement)) $('handBox').classList.toggle('big');
});
// The 3D view starts sharp (a full 1080p screen at its own resolution, or a 4K one at half). The
// tracker slow (under 22 pictures a second for 3 s, the camera giving more): the view draws fewer
// pixels and frames, step by step (it shares the graphics chip), but never below ~1.2 MP (it
// went down to 0.4 MP, too blurry to tell the shapes apart). Tracking on the server: no need.
// While the start screen covers it, it hardly draws at all.
const RENDER_STEPS = [{ maxPixels: 4.2e6, maxFps: 60 }, { maxPixels: 2.6e6, maxFps: 45 }, { maxPixels: 1.8e6, maxFps: 40 },
                      { maxPixels: 1.2e6, maxFps: 30 }];
let renderStep = 0, slowSince = null;
function adaptRender(st) {
  const T = window.__teleop;
  if (!T?.setBudget) return;
  const covered = !$('start').classList.contains('hidden') && !$('start').classList.contains('peek');
  const want = covered ? { maxPixels: RENDER_STEPS[renderStep].maxPixels, maxFps: 5 } : RENDER_STEPS[renderStep];
  if (T.budget.maxFps !== want.maxFps || T.budget.maxPixels !== want.maxPixels) T.setBudget(want);
  const now = performance.now();
  // (only when the tracking itself is slow: a camera that sends few frames, ~15 a second in a dim
  // room, isn't helped by a coarser 3D view, it only made the robot look choppier)
  if (st.fps < 22 && st.ms > 25 && hand?.path !== 'server' && renderStep < RENDER_STEPS.length - 1) {
    if (slowSince === null) slowSince = now;
    else if (now - slowSince > 3000) { renderStep++; slowSince = null; console.info('render budget lowered', RENDER_STEPS[renderStep]); }
  } else slowSince = null;
}
window.addEventListener('keyup', (e) => { if (e.code in turnKeys) { turnKeys[e.code] = 0; updateTurn(); } });
window.addEventListener('blur', () => { for (const k in turnKeys) turnKeys[k] = 0; updateTurn(); });
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
      send: (m) => window.__teleop?.send?.(m),
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
    $('trackerState').textContent = 'Camera failed: ' + (e.message || e) + '. Allow the camera, or use your phone.';
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
// ---- the task's description card: 'reading' (full screen, before the task: Start), 'info' (over
// the scene during the task: Close; the clock keeps running)
let lastTask = null, cardMode = null, cardPhase = null, readySent = null;   // (Start pressed: {phase, at})
function showTaskCard(g, mode) {
  if (cardMode === mode && cardPhase === g.phase) return;             // (already up: don't redraw)
  cardMode = mode; cardPhase = g.phase;
  $('taskTag').textContent = g.scored ? 'Scored' : 'Practice · not scored';
  $('taskTitle').textContent = g.title;
  $('taskText').textContent = g.text;
  // the practice: how to reposition the hand once more (the move a beginner finds hardest)
  $('taskDemo').innerHTML = g.scored ? '' : '<p class="demoNote"><b>Out of room?</b> Fist, move back, open.</p>' + clutchDemo();
  const ctrls = ['✋ move', '✊ pause', '🤏 grip / let go', 'Q E turn', 'H home', '🖱 drag: look around', 'scroll: zoom'];
  $('taskCtrls').innerHTML = ctrls.map(c => `<span>${c}</span>`).join('');
  $('taskMeta').textContent = mode === 'reading'
    ? `${fmt(g.limit)} · starts after a 3-second countdown`
    : `${fmt(g.limit)} · the clock keeps running`;
  const c = $('taskCard');
  c.classList.remove('hidden', 'reading', 'info');
  c.classList.add(mode);
}
function hideTaskCard() { cardMode = null; $('taskCard').classList.add('hidden'); }
$('taskStart').addEventListener('click', (e) => {
  e.currentTarget.blur();
  readySent = { phase: cardPhase, at: performance.now() };
  hideTaskCard();
  window.__teleop?.send?.({ type: 'task_ready' });
});
$('taskClose').addEventListener('click', (e) => { e.currentTarget.blur(); hideTaskCard(); });
$('infoBtn').addEventListener('click', (e) => { e.currentTarget.blur(); if (lastTask) showTaskCard(lastTask, 'info'); });

// the graphics chip reset (main.js now draws lightly): say so; the adaptive steps start from the lightest
window.addEventListener('teleop-context-lost', () => { renderStep = RENDER_STEPS.length - 1; toast('Reloading the 3D view…'); });
window.addEventListener('teleop-context-restored', () => toast('3D view back'));
// Home (H or the button): the gripper glides back to its start position; the page says so
function goHome() {
  if (!hand?.armed) return;
  window.__teleop?.send?.({ type: 'home' });              // (the server's status says when it glides: the toast below)
}
window.addEventListener('keydown', (e) => { if (e.code === 'KeyH' && !e.repeat) goHome(); });
$('homeBtn').addEventListener('click', (e) => { e.currentTarget.blur(); goHome(); });
// Skip / Finish: end the running task now (what was done so far counts), after a confirmation
function askEndTask(how) {
  const skip = how === 'skip';
  $('confirmTitle').textContent = skip ? 'Skip this task?' : 'Finish this task?';
  $('confirmText').textContent = 'What you did so far counts. You can’t come back.';
  $('confirmYes').textContent = skip ? 'Skip task' : 'Finish task';
  $('confirmYes').onclick = () => { $('confirmBox').classList.add('hidden'); window.__teleop?.send?.({ type: 'end_task', how }); };
  $('confirmBox').classList.remove('hidden');
}
$('confirmNo').addEventListener('click', () => $('confirmBox').classList.add('hidden'));
$('skipBtn').addEventListener('click', (e) => { e.currentTarget.blur(); askEndTask('skip'); });
$('finishBtn').addEventListener('click', (e) => { e.currentTarget.blur(); askEndTask('finish'); });
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
  // tower: blocks stacked now (of the goal), falls
  const tw = g.tower;
  $('taskHud').classList.toggle('hidden', !tw);
  steps.classList.toggle('hidden', !!tw || !!g.wire);
  if (tw) {
    $('taskHud').innerHTML = `Tower <b>${Math.min(tw.blocks, tw.goal)} of ${tw.goal}</b> blocks stacked` +
      (tw.falls ? `  ·  falls ${tw.falls}` : '');
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
  // the task's description: first on its own (the 3D scene hidden, the clock stopped) until the
  // candidate presses Start; during the task the info button opens it again over the scene
  lastTask = g;
  if (g.kind === 'task' && g.waiting) {
    if (readySent?.phase !== g.phase) showTaskCard(g, 'reading');
    else if (performance.now() - readySent.at > 2000) { readySent.at = performance.now(); window.__teleop?.send?.({ type: 'task_ready' }); }
  }
  else if (cardMode === 'reading') hideTaskCard();
  else if (cardMode === 'info' && (g.kind !== 'task' || g.phase !== cardPhase)) hideTaskCard();
  $('count').textContent = g.intro > 0 ? Math.ceil(g.intro) : '';
  // while a task runs: task info, Home, Skip and Finish
  $('taskBar').classList.toggle('hidden', !(g.kind === 'task' && !g.waiting && g.intro === 0 && !g.finished && hand?.armed));
  if (g.homing && !wasHoming) toast('🏠 Going home…');
  wasHoming = !!g.homing;
  if (g.message && g.message !== lastMsg) toast(g.message);
  lastMsg = g.message;
});
