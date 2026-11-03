
import './style.css';
import { FluidSimulation } from './fluid';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="simulator">
    <h1>Fluid Pendant Simulator</h1>
    <canvas id="display" width="400" height="400"></canvas>
    <p>Drag across the pendant to change gravity</p>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#display')!;
const ctx = canvas.getContext('2d')!;

const fluid = new FluidSimulation(1, 90);

const center = 200;
const displayRadius = 158;
const gridSize = 16;
const spacing = 19;
const ledRadius = 6;

// Build the LED positions once.
const leds: { x: number; y: number }[] = [];

for (let y = 0; y < gridSize; y++) {
  for (let x = 0; x < gridSize; x++) {
    const dx = x - (gridSize - 1) / 2;
    const dy = y - (gridSize - 1) / 2;

    if (Math.hypot(dx, dy) > 7.6) continue;

    leds.push({
      x: dx * spacing / displayRadius,
      y: dy * spacing / displayRadius
    });
  }
}

// Pointer controls.
canvas.style.touchAction = 'none';

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  updateGravity(event);
});

canvas.addEventListener('pointermove', (event) => {
  if (event.buttons === 0) return;
  updateGravity(event);
});

function updateGravity(event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();

  const x = (event.clientX - rect.left) / rect.width - 0.5;
  const y = (event.clientY - rect.top) / rect.height - 0.5;

  const length = Math.hypot(x, y);

  if (length < 0.01) return;

  fluid.setGravity(
    x / length * 14,
    y / length * 14
  );
}

function sampleDensity(x: number, y: number): number {
  let density = 0;

  const influenceRadius = 0.14;
  const radiusSquared = influenceRadius * influenceRadius;

  for (const p of fluid.particles) {
    const dx = p.x - x;
    const dy = p.y - y;
    const r2 = dx * dx + dy * dy;

    if (r2 >= radiusSquared) continue;

    const q = 1 - r2 / radiusSquared;
    density += q * q;
  }

  return density;
}

function render() {
  ctx.fillStyle = '#080c12';
  ctx.fillRect(0, 0, 400, 400);

  // Pendant housing.
  ctx.beginPath();
  ctx.arc(center, center, 175, 0, Math.PI * 2);
  ctx.fillStyle = '#596574';
  ctx.fill();

  // Dark display.
  ctx.beginPath();
  ctx.arc(center, center, displayRadius, 0, Math.PI * 2);
  ctx.fillStyle = '#02070b';
  ctx.fill();

  // LEDs.
  for (const led of leds) {
    const density = sampleDensity(led.x, led.y);

    // Smooth density-to-brightness mapping.
    const brightness = 1 - Math.exp(-density * 0.7);

    const px = center + led.x * displayRadius;
    const py = center + led.y * displayRadius;

    // Subtle glow.
    if (brightness > 0.15) {
      ctx.beginPath();
      ctx.arc(px, py, ledRadius * 1.8, 0, Math.PI * 2);
      ctx.fillStyle =
        `rgba(0, 140, 255, ${brightness * 0.12})`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(px, py, ledRadius, 0, Math.PI * 2);

    ctx.fillStyle =
      `rgba(0, 190, 255, ${0.025 + brightness * 0.975})`;

    ctx.fill();
  }
}

// Fixed-timestep simulation.
const fixedDt = 1 / 120;
let accumulator = 0;
let lastTime = performance.now();

function animate(now: number) {
  const frameDt = Math.min(
    (now - lastTime) / 1000,
    0.05
  );

  lastTime = now;
  accumulator += frameDt;

  let steps = 0;

  while (accumulator >= fixedDt && steps < 6) {
    fluid.update(fixedDt);
    accumulator -= fixedDt;
    steps++;
  }

  // Avoid accumulating a large backlog.
  if (steps === 6) {
    accumulator = 0;
  }

  render();
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);

