import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FluidSimulation } from '../src/fluid.ts';

function measure(sim) {
  const occupied = new Set();
  let x = 0;
  let y = 0;
  let speed = 0;
  for (const p of sim.particles) {
    assert.ok([p.x, p.y, p.vx, p.vy].every(Number.isFinite));
    assert.ok(Math.hypot(p.x, p.y) <= sim.radius + 1e-10);
    const i = Math.floor((p.x + sim.radius) / sim.dx);
    const j = Math.floor((p.y + sim.radius) / sim.dx);
    // Particle and grid boundaries must agree: markers cannot enter solid cells.
    const cx = -sim.radius + (i + 0.5) * sim.dx;
    const cy = -sim.radius + (j + 0.5) * sim.dx;
    assert.ok(Math.hypot(cx, cy) <= sim.radius);
    occupied.add(i + j * sim.n);
    x += p.x;
    y += p.y;
    speed += Math.hypot(p.vx, p.vy);
  }
  const count = sim.particles.length;
  return { cells: occupied.size, x: x / count, y: y / count, speed: speed / count };
}

function advance(sim, steps) {
  for (let step = 0; step < steps; step++) sim.update(1 / 120);
}

test('liquid retains volume and settles instead of collapsing against the wall', () => {
  const sim = new FluidSimulation();
  const initial = measure(sim);
  advance(sim, 1200);
  const settled = measure(sim);
  assert.equal(sim.particles.length, 2000);
  assert.ok(settled.cells > initial.cells * 0.9, JSON.stringify(settled));
  assert.ok(settled.cells < initial.cells * 1.2, JSON.stringify(settled));
  assert.ok(Math.abs(settled.y - initial.y) < 0.06, JSON.stringify(settled));
  assert.ok(Math.abs(settled.x) < 0.05, JSON.stringify(settled));
  assert.ok(settled.speed < 0.3, JSON.stringify(settled));
});

test('gravity changes move the pool while preserving volume and containing particles', () => {
  const sim = new FluidSimulation();
  const initial = measure(sim);
  for (const [gx, gy] of [[14, 0], [0, -14], [-14, 0], [0, 14]]) {
    sim.setGravity(gx, gy);
    advance(sim, 600);
    const state = measure(sim);
    assert.ok((state.x * gx + state.y * gy) / 14 > 0.5, JSON.stringify(state));
    assert.ok(state.cells > initial.cells * 0.85, JSON.stringify(state));
    assert.ok(state.cells < initial.cells * 1.25, JSON.stringify(state));
    assert.ok(state.speed < 0.5, JSON.stringify(state));
    const strays = sim.particles.filter(p => (p.x * gx + p.y * gy) / 14 < 0.15);
    assert.equal(strays.length, 0, 'detached drops must fall back into the pool');
  }
});

test('empty and full fills initialize without rejection-sampling hangs', () => {
  for (const radius of [0.5, 1, 2]) {
    assert.equal(new FluidSimulation(radius, 100, 0).particles.length, 0);
    assert.equal(new FluidSimulation(radius, 0, 0.3).particles.length, 0);
    const full = new FluidSimulation(radius, 100, 1);
    assert.equal(full.particles.length, 100);
    measure(full);
    const empty = new FluidSimulation(radius, 0, 0);
    empty.update(1 / 60);
    assert.equal(empty.particles.length, 0);
  }
});

test('an isolated marker follows gravity without generating its own pressure', () => {
  const sim = new FluidSimulation(1, 1);
  sim.setGravity(3, -4);
  sim.update(1 / 120);
  assert.ok(Math.abs(sim.particles[0].vx - 3 / 120) < 1e-6);
  assert.ok(Math.abs(sim.particles[0].vy + 4 / 120) < 1e-6);
});

test('an isolated drop leaves the upper wall in free fall without sideways grid forces', () => {
  const sim = new FluidSimulation(1, 1);
  Object.assign(sim.particles[0], { x: 0, y: -0.975, vx: 0, vy: 0 });
  const steps = 15;
  advance(sim, steps);
  const drop = sim.particles[0];
  const dt = 1 / 120;
  const expectedY = -0.975 + sim.gravityY * dt * dt * steps * (steps + 1) / 2;
  assert.ok(Math.abs(drop.x) < 1e-12, JSON.stringify(drop));
  assert.ok(Math.abs(drop.vx) < 1e-12, JSON.stringify(drop));
  assert.ok(Math.abs(drop.vy - sim.gravityY * steps * dt) < 1e-12, JSON.stringify(drop));
  assert.ok(Math.abs(drop.y - expectedY) < 1e-12, JSON.stringify(drop));
});

test('small detached clusters follow gravity without pressure kicks or particle loss', () => {
  const sim = new FluidSimulation();
  const initial = Array.from({ length: 6 }, (_, k) => ({
    x: -0.01 + k * 0.004, y: -0.5 + (k % 2) * 0.002, vx: 0, vy: 0,
  }));
  initial.forEach((drop, k) => Object.assign(sim.particles[k], drop));
  sim.setGravity(4, 9.8);
  const steps = 15;
  advance(sim, steps);
  const dt = 1 / 120;
  const positionFactor = dt * dt * steps * (steps + 1) / 2;
  initial.forEach((start, k) => {
    const drop = sim.particles[k];
    assert.ok(Math.abs(drop.x - start.x - sim.gravityX * positionFactor) < 1e-12);
    assert.ok(Math.abs(drop.y - start.y - sim.gravityY * positionFactor) < 1e-12);
  });
  assert.equal(sim.particles.length, 2000);
});

test('non-unit containers use the correct grid coordinates and boundaries', () => {
  for (const radius of [0.5, 2]) {
    const sim = new FluidSimulation(radius);
    const initial = measure(sim);
    advance(sim, 360);
    const state = measure(sim);
    assert.ok(state.cells > initial.cells * 0.85, JSON.stringify({ radius, ...state }));
    assert.ok(state.y / radius > 0.5, JSON.stringify({ radius, ...state }));
  }
});

test('large timesteps are subdivided and invalid timesteps leave particles unchanged', () => {
  const sim = new FluidSimulation();
  const snapshot = structuredClone(sim.particles);
  for (const dt of [0, -1, NaN, Infinity, 1e-10]) sim.update(dt);
  assert.deepEqual(sim.particles, snapshot);

  const reference = new FluidSimulation();
  sim.update(1 / 30);
  advance(reference, 4);
  assert.deepEqual(sim.particles, reference.particles);

  // A background-tab pause must not feed a huge timestep to the pressure solve.
  sim.update(10);
  measure(sim);
});

test('invalid constructor and gravity inputs fail before corrupting the simulation', () => {
  for (const args of [[0], [-1], [NaN], [1, -1], [1, 1.5], [1, 10, -0.1], [1, 10, 1.1]]) {
    assert.throws(() => new FluidSimulation(...args), RangeError);
  }
  const sim = new FluidSimulation(1, 0);
  assert.throws(() => sim.setGravity(NaN, 1), RangeError);
  assert.throws(() => sim.setGravity(0, Infinity), RangeError);
  assert.equal(sim.gravityX, 0);
  assert.equal(sim.gravityY, 9.8);
});
