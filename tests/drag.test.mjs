import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FluidSimulation } from '../src/fluid.ts';

test('a swipe pushes particles along its entire path without moving distant particles or gravity', () => {
  const sim = new FluidSimulation(1, 3);
  sim.setGravity(0, 14);
  Object.assign(sim.particles[0], { x: -0.3, y: 0.5 });
  Object.assign(sim.particles[1], { x: 0.3, y: 0.5 });
  Object.assign(sim.particles[2], { x: 0, y: -0.5 });
  const positions = sim.particles.map(p => [p.x, p.y]);
  const distant = { ...sim.particles[2] };

  sim.dragParticles(-0.6, 0.5, 0.6, 0.5, 1 / 60);

  for (const p of sim.particles.slice(0, 2)) {
    assert.ok(p.vx > 0);
    assert.equal(p.vy, 0);
  }
  assert.deepEqual(sim.particles[2], distant);
  assert.deepEqual(sim.particles.map(p => [p.x, p.y]), positions);
  assert.equal(sim.gravityX, 0);
  assert.equal(sim.gravityY, 14);
});

test('drag velocity follows each swipe direction and stays bounded across repeated swipes', () => {
  for (const [x, y] of [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1]]) {
    const sim = new FluidSimulation(1, 1);
    const p = sim.particles[0];
    Object.assign(p, { x: 0, y: 0 });
    for (let i = 0; i < 50; i++) sim.dragParticles(-x, -y, x, y, 1 / 60);
    assert.ok(p.vx * x + p.vy * y > 0);
    assert.ok(Math.abs(p.vx * y - p.vy * x) < 1e-12);
    assert.ok(Math.hypot(p.vx, p.vy) > 9.9);
    assert.ok(Math.hypot(p.vx, p.vy) <= 10 + 1e-12);
  }
});

test('holding the pointer still gives no impulse', () => {
  const sim = new FluidSimulation();
  const before = structuredClone(sim.particles);
  sim.dragParticles(0, 0.6, 0, 0.6, 1 / 60);
  assert.deepEqual(sim.particles, before);
});

test('released particles retain drag momentum while gravity pulls downward', () => {
  const sim = new FluidSimulation(1, 1);
  sim.setGravity(0, 14);
  const p = sim.particles[0];
  Object.assign(p, { x: 0, y: 0 });
  sim.dragParticles(-0.2, 0, 0.2, 0, 1 / 60);
  const releasedVX = p.vx;

  sim.update(1 / 120);

  assert.ok(p.x > 0);
  assert.ok(p.y > 0);
  assert.equal(p.vx, releasedVX);
  assert.ok(p.vy > 0);
  assert.equal(sim.gravityX, 0);
  assert.equal(sim.gravityY, 14);
});
