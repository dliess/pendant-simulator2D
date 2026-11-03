import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScrollMotion } from '../src/scroll.ts';

function fixture(hz = 120, pixelsPerUnit = 158) {
  const motion = new ScrollMotion(14);
  const dt = 1 / hz;
  let x = 0, y = 0;
  const tick = (vx = 0, vy = 0, scrolled = true) => {
    x += vx * dt * pixelsPerUnit;
    y += vy * dt * pixelsPerUnit;
    return motion.sample({ x, y }, pixelsPerUnit, dt, scrolled);
  };
  tick();
  return { motion, tick, dt };
}

test('scroll acceleration pushes opposite to container movement on both axes', () => {
  for (const [vx, vy] of [[0, -4], [0, 4], [-4, 0], [4, 0]]) {
    const { tick } = fixture();
    const force = tick(vx, vy);
    assert.ok(force.x * vx + force.y * vy < 0);
    assert.equal(vx === 0 ? force.x : force.y, 0);
  }
});

test('steady velocity stops applying force and stopping gives an opposite rebound', () => {
  const { tick } = fixture();
  let force;
  for (let i = 0; i < 240; i++) force = tick(0, -4);
  assert.ok(Math.abs(force.y) < 1e-6, JSON.stringify(force));
  assert.ok(tick(0, 0, false).y < 0, 'stopping an upward-moving pendant lifts the liquid');
  for (let i = 0; i < 360; i++) force = tick(0, 0, false);
  assert.ok(Math.hypot(force.x, force.y) < 1e-8);
});

test('reversing scroll direction reverses the inertial force', () => {
  const { tick } = fixture();
  for (let i = 0; i < 30; i++) tick(0, -3);
  let force;
  for (let i = 0; i < 12; i++) force = tick(0, 3);
  assert.ok(force.y < 0);
});

test('stationary sticky/fixed pendants and layout shifts without scrolling get no force', () => {
  const { tick } = fixture();
  for (let i = 0; i < 60; i++) assert.deepEqual(tick(0, 0, true), { x: 0, y: 0 });
  assert.deepEqual(tick(10, -100, false), { x: 0, y: 0 });
  assert.deepEqual(tick(0, 0, true), { x: 0, y: 0 });
});

test('spikes stay finite and bounded, including diagonal movement', () => {
  const { tick } = fixture();
  for (let i = 0; i < 100; i++) {
    const force = tick(i % 2 ? 1e8 : -1e8, 1e8);
    assert.ok(Number.isFinite(force.x) && Number.isFinite(force.y));
    assert.ok(Math.hypot(force.x, force.y) <= 28 + 1e-10);
  }
});

test('reset, resize, missing geometry, and long pauses discard stale impulses', () => {
  for (const invalid of [
    { x: 0, y: 0, scale: 158, dt: 10 },
    { x: 0, y: 0, scale: 158, dt: 0 },
    { x: NaN, y: 0, scale: 158, dt: 1 / 60 },
    { x: 0, y: 0, scale: 0, dt: 1 / 60 },
    { x: 0, y: 0, scale: 80, dt: 1 / 60 },
  ]) {
    const { motion, tick } = fixture();
    tick(0, -4);
    assert.deepEqual(motion.sample(invalid, invalid.scale, invalid.dt), { x: 0, y: 0 });
    motion.reset();
    assert.deepEqual(motion.sample({ x: 1000, y: -5000 }, 158, 1 / 60), { x: 0, y: 0 });
    assert.deepEqual(motion.sample({ x: 1000, y: -5000 }, 158, 1 / 60), { x: 0, y: 0 });
  }
});

test('response scales with displayed size and is consistent across frame rates', () => {
  const normal = fixture(120, 158), mobile = fixture(120, 100);
  for (let i = 0; i < 120; i++) {
    assert.ok(Math.abs(normal.tick(0, -2).y - mobile.tick(0, -2).y) < 1e-10);
  }
  function impulse(hz) {
    const { tick, dt } = fixture(hz);
    let sum = 0;
    for (let i = 0; i < hz * 2; i++) sum += tick(0, -1).y * dt;
    return sum;
  }
  const impulses = [30, 60, 120].map(impulse);
  for (const value of impulses) assert.ok(Math.abs(value - 1) < 0.02, String(impulses));
});

test('separate instances retain independent motion histories', () => {
  const a = fixture(), b = fixture();
  assert.ok(a.tick(0, -3).y > 0);
  assert.deepEqual(b.tick(), { x: 0, y: 0 });
  a.motion.reset();
  assert.ok(b.tick(0, 3).y < 0);
  assert.deepEqual(a.tick(), { x: 0, y: 0 });
});
