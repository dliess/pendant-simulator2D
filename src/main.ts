
import './style.css';
import { FluidSimulation } from './fluid';
import { PhoneMotion } from './motion';
import type { MotionStatus } from './motion';

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const CANVAS_SIZE = 400;
const CENTER = CANVAS_SIZE / 2;

const HOUSING_RADIUS = 175;
const DISPLAY_RADIUS = 158;

const GRID_SIZE = 16;
const LED_SPACING = 19;
const LED_RADIUS = 6;

const PARTICLE_COUNT = 2000;
const FILL_LEVEL = 0.3;
const GRAVITY_STRENGTH = 14;

const FIXED_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 6;

// --------------------------------------------------
// HTML setup
// --------------------------------------------------

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="simulator">
    <h1>FLIP Fluid Pendant Simulator</h1>

    <canvas
      id="display"
      width="${CANVAS_SIZE}"
      height="${CANVAS_SIZE}"
    ></canvas>

    <p>Drag through the liquid to stir it</p>
    <div class="motion-controls">
      <button id="motion-toggle" type="button" aria-pressed="false">Enable phone motion</button>
      <p id="motion-status" role="status"></p>
    </div>
  </div>
`;

const canvas =
  document.querySelector<HTMLCanvasElement>('#display')!;

const ctx = canvas.getContext('2d')!;

canvas.style.touchAction = 'none';

// --------------------------------------------------
// Fluid simulation
// --------------------------------------------------

const fluid = new FluidSimulation(
  1,
  PARTICLE_COUNT,
  FILL_LEVEL
);
fluid.setGravity(0, GRAVITY_STRENGTH);

const motionButton = document.querySelector<HTMLButtonElement>('#motion-toggle')!;
const motionStatus = document.querySelector<HTMLParagraphElement>('#motion-status')!;
const motion = new PhoneMotion(window, GRAVITY_STRENGTH, updateMotionStatus);

function updateMotionStatus(status: MotionStatus) {
  const messages: Record<MotionStatus, string> = {
    off: 'Enable phone motion to tilt and shake the liquid.',
    requesting: 'Allow motion access in your browser.',
    waiting: 'Move or tilt your phone to start.',
    active: 'Tilt and shake your phone, or drag to stir.',
    'no-data': 'No sensor readings yet. You can still drag to stir.',
    denied: 'Motion access was denied. You can still drag to stir.',
    unavailable: 'Phone motion is unavailable here. Drag to stir.',
    insecure: 'Open this page over HTTPS to use phone motion.',
    error: 'Could not enable motion. Try again, or drag to stir.',
  };
  motionButton.textContent = motion.enabled ? 'Disable phone motion' : 'Enable phone motion';
  motionButton.disabled = status === 'requesting' || status === 'unavailable' || status === 'insecure';
  motionButton.setAttribute('aria-pressed', String(motion.enabled));
  motionStatus.textContent = messages[status];
}

updateMotionStatus(motion.status);
motionButton.addEventListener('click', () => {
  if (motion.enabled) motion.disable();
  else void motion.enable();
});
window.addEventListener('pagehide', () => motion.disable());

// --------------------------------------------------
// LED positions
// --------------------------------------------------

interface LED {
  x: number;
  y: number;
}

const leds: LED[] = [];

for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    const dx = x - (GRID_SIZE - 1) / 2;
    const dy = y - (GRID_SIZE - 1) / 2;

    // Approximate the pendant's rounded display.
    if (Math.hypot(dx, dy) > 7.6) {
      continue;
    }

    leds.push({
      x: dx * LED_SPACING / DISPLAY_RADIUS,
      y: dy * LED_SPACING / DISPLAY_RADIUS
    });
  }
}

// --------------------------------------------------
// Mouse and touch stirring
// --------------------------------------------------

interface DragPoint {
  pointerId: number;
  x: number;
  y: number;
  time: number;
}

let dragPoint: DragPoint | null = null;

function pointerPosition(event: PointerEvent): DragPoint {
  const rect = canvas.getBoundingClientRect();

  return {
    pointerId: event.pointerId,
    x: ((event.clientX - rect.left) / rect.width * CANVAS_SIZE - CENTER) / DISPLAY_RADIUS,
    y: ((event.clientY - rect.top) / rect.height * CANVAS_SIZE - CENTER) / DISPLAY_RADIUS,
    time: event.timeStamp,
  };
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || dragPoint !== null) return;
  dragPoint = pointerPosition(event);
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (dragPoint?.pointerId !== event.pointerId) return;
  if ((event.buttons & 1) === 0) {
    endDrag(event);
    return;
  }

  const next = pointerPosition(event);
  fluid.dragParticles(
    dragPoint.x, dragPoint.y,
    next.x, next.y,
    Math.max(0.001, (next.time - dragPoint.time) / 1000)
  );
  dragPoint = next;
});

function endDrag(event: PointerEvent) {
  if (dragPoint?.pointerId !== event.pointerId) return;
  dragPoint = null;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', endDrag);

// --------------------------------------------------
// LED density sampling
// --------------------------------------------------

function sampleDensity(x: number, y: number): number {
  let density = 0;

  const influenceRadius = 0.14;
  const radiusSquared =
    influenceRadius * influenceRadius;

  for (const p of fluid.particles) {
    const dx = p.x - x;
    const dy = p.y - y;

    const r2 = dx * dx + dy * dy;

    if (r2 >= radiusSquared) {
      continue;
    }

    const q = 1 - r2 / radiusSquared;

    density += q * q;
  }

  return density;
}

// --------------------------------------------------
// Rendering
// --------------------------------------------------

function render() {
  // Background
  ctx.fillStyle = '#080c12';
  ctx.fillRect(
    0,
    0,
    CANVAS_SIZE,
    CANVAS_SIZE
  );

  // Metallic pendant housing
  ctx.beginPath();
  ctx.arc(
    CENTER,
    CENTER,
    HOUSING_RADIUS,
    0,
    Math.PI * 2
  );

  ctx.fillStyle = '#596574';
  ctx.fill();

  // Dark LED display
  ctx.beginPath();
  ctx.arc(
    CENTER,
    CENTER,
    DISPLAY_RADIUS,
    0,
    Math.PI * 2
  );

  ctx.fillStyle = '#02070b';
  ctx.fill();

  // Render LED matrix
  for (const led of leds) {
    const density = sampleDensity(
      led.x,
      led.y
    );

    // Lower coefficient because FLIP uses
    // many more particles than our old PBF solver.
    const brightness =
      1 - Math.exp(-density * 0.06);

    const px =
      CENTER + led.x * DISPLAY_RADIUS;

    const py =
      CENTER + led.y * DISPLAY_RADIUS;

    // LED glow
    if (brightness > 0.15) {
      ctx.beginPath();
      ctx.arc(
        px,
        py,
        LED_RADIUS * 1.8,
        0,
        Math.PI * 2
      );

      ctx.fillStyle =
        `rgba(0, 140, 255, ${brightness * 0.12})`;

      ctx.fill();
    }

    // LED core
    ctx.beginPath();
    ctx.arc(
      px,
      py,
      LED_RADIUS,
      0,
      Math.PI * 2
    );

    ctx.fillStyle =
      `rgba(0, 190, 255, ${0.025 + brightness * 0.975})`;

    ctx.fill();
  }
}

// --------------------------------------------------
// Fixed timestep animation loop
// --------------------------------------------------

let lastTime = performance.now();
let accumulator = 0;

function animate(now: number) {
  const frameDt = Math.min(
    (now - lastTime) / 1000,
    0.05
  );

  lastTime = now;
  accumulator += frameDt;

  const acceleration = motion.sample(frameDt);
  fluid.setGravity(acceleration.x, acceleration.y);

  let steps = 0;

  while (
    accumulator >= FIXED_DT &&
    steps < MAX_STEPS_PER_FRAME
  ) {
    fluid.update(FIXED_DT);

    accumulator -= FIXED_DT;
    steps++;
  }

  // Prevent a simulation backlog.
  if (steps === MAX_STEPS_PER_FRAME) {
    accumulator = 0;
  }

  render();

  requestAnimationFrame(animate);
}

// --------------------------------------------------
// Start
// --------------------------------------------------

requestAnimationFrame(animate);

