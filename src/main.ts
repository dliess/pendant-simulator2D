
import './style.css';
import { FluidSimulation } from './fluid';

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

    <p>Drag across the pendant to change gravity</p>
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
// Mouse and touch gravity controls
// --------------------------------------------------

function updateGravity(event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();

  const x =
    (event.clientX - rect.left) / rect.width - 0.5;

  const y =
    (event.clientY - rect.top) / rect.height - 0.5;

  const length = Math.hypot(x, y);

  if (length < 0.01) return;

  fluid.setGravity(
    x / length * GRAVITY_STRENGTH,
    y / length * GRAVITY_STRENGTH
  );
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  updateGravity(event);
});

canvas.addEventListener('pointermove', (event) => {
  if (event.buttons === 0) return;
  updateGravity(event);
});

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

