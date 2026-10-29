// A phone as the hand camera: it tracks the candidate's hand and sends its pose to the simulator;
// the computer shows the robot. Works on any phone with a camera and a modern browser (no AR, no
// app). Two placements (core.js 'camera'):
//   lying flat   (the default, 'below': OAT's best view) the phone on the desk, screen up, the hand
//                25-40 cm above it, palm down, fingers toward the computer screen
//   standing up  ('front') the phone stands in front of the candidate like a webcam
import { preload, HandControl, openCamera } from '/test-static/hand/core.js';
import { drawHand, Checklist, COLORS, chipLabel, GRIP_TEXT, OPEN_TEXT } from '/test-static/hand/ui.js';
const $ = (id) => document.getElementById(id);
const BASE = window.TELEOP_BASE;

// ---- the simulator
let ws = null, wsOpen = false, status = {};
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { wsOpen = true; };
  ws.onclose = () => { wsOpen = false; setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const m = JSON.parse(ev.data);
    if (m.type !== 'status') return;
    status = m;
    const g = m.task_game;
    if (g) $('phase').textContent = g.finished ? 'Finished, thank you!' : (g.round ? `${g.title} · round ${g.round}` : g.title);
  };
}
connect();
const send = (m) => { if (wsOpen) ws.send(JSON.stringify(m)); };

// ---- the tracker: loading starts now
// (no forearm model on a phone: it ran the tracker at under 4 fps on a real phone)
const tracker = preload({ forearm: false });
tracker.catch((e) => { $('msg').textContent = 'The hand tracker could not load: ' + e.message; $('msg').className = 'bad'; });

let cam = null, hand = null, state = null, facing = 'user';
let placement = 'below';                    // 'below' (lying flat) | 'front' (standing up)
function setPlacement(m) {
  placement = m;
  for (const b of $('placement').querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === m);
  $('howBelow').classList.toggle('hidden', m !== 'below');
  $('howFront').classList.toggle('hidden', m !== 'front');
  hand?.setCamera(m);                       // (switched while running: it takes its directions anew)
}
for (const b of $('placement').querySelectorAll('button')) b.addEventListener('click', () => setPlacement(b.dataset.m));
const checklist = new Checklist($('checklist'), () => { hand.arm(true); $('homeBtn').classList.remove('hidden'); },
                                { gripText: GRIP_TEXT, openText: OPEN_TEXT });
function loop() {
  requestAnimationFrame(loop);
  if (!cam) return;
  const c = $('view');
  const r = c.getBoundingClientRect();
  const w = Math.round(r.width * Math.min(2, devicePixelRatio)), h = Math.round(r.height * Math.min(2, devicePixelRatio));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  drawHand(c, cam.video, state, { mirror: facing === 'user', dim: 0.15 });
}
requestAnimationFrame(loop);

async function startCamera() {
  if (cam) { cam.stop(); cam = null; }
  cam = await openCamera(facing);
  $('overlay').classList.add('hidden');
  if (!hand) {
    await tracker;
    hand = new HandControl({
      camera: placement,
      forearm: false, maxFrame: 640,          // (a phone's frames, smaller: the tracker crops the hand to 224 px anyway)
      tracker: 'auto',                        // (this thread or a background one: whichever is faster on this phone)
      gripMode: 'pinchToggle',                // (a pinch grips, the next lets go)
      send, status: () => status,
      log: (frames) => send({ type: 'track_log', frames }),   // (the raw points, for tuning)
      onFrame: (st) => {
        state = st;
        checklist.update(true, st);
        const g = st.gesture || 'none';
        const ready = g === 'open' && !st.driving;
        $('chip').style.color = !st.tracked ? COLORS.none : ready ? '#7fb4ff' : COLORS[g];
        $('chip').querySelector('b').textContent = chipLabel(st);
        $('stats').textContent = `${st.fps} fps · ${st.ms === undefined ? st.latency : Math.round(st.ms)} ms · ${st.delegate || ''}${st.path === 'worker' ? ' (bg)' : ''}`;
      },
    });
  }
  await hand.start(cam.video);
}

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Starting…';
  try {
    await startCamera();
    $('startBtn').classList.add('hidden');
    $('flipBtn').classList.remove('hidden');
    $('msg').textContent = '';
  } catch (e) {
    $('startBtn').disabled = false;
    $('startBtn').textContent = 'Start';
    $('msg').textContent = 'Could not start the camera: ' + (e.message || e) + '. Allow the camera for this page.';
    $('msg').className = 'bad';
  }
});
$('flipBtn').addEventListener('click', async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  hand?.stop();
  try { await startCamera(); } catch (e) { $('msg').textContent = 'Could not switch the camera: ' + (e.message || e); }
});
$('homeBtn').addEventListener('click', () => { send({ type: 'home' }); navigator.vibrate?.(20); });
