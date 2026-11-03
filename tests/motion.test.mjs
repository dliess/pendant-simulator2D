import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhoneMotion } from '../src/motion.ts';

const G = 9.80665;

function eventSource() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener(event); },
  };
}

function fixture() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const host = {
    ...eventSource(),
    isSecureContext: true,
    DeviceMotionEvent: { prototype: {} },
    DeviceOrientationEvent: { prototype: {} },
    screen: { orientation: { angle: 0 } },
    document: { ...eventSource(), hidden: false },
    performance: { now: () => now },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const statuses = [];
  const motion = new PhoneMotion(host, 14, status => statuses.push(status));
  return { host, motion, statuses, timers, advance: ms => { now += ms; } };
}

function settle(motion) {
  let force;
  for (let i = 0; i < 90; i++) force = motion.sample(1 / 60);
  return force;
}

function close(actual, x, y) {
  assert.ok(Math.abs(actual.x - x) < 1e-8, JSON.stringify(actual));
  assert.ok(Math.abs(actual.y - y) < 1e-8, JSON.stringify(actual));
}

test('orientation projects gravity correctly in portrait, landscape, upside down, and flat', async () => {
  for (const [beta, gamma, angle, x, y] of [
    [90, 0, 0, 0, 14], [-90, 0, 0, 0, -14],
    [0, 90, 0, 14, 0], [0, -90, 0, -14, 0],
    [0, -90, 90, 0, 14], [0, 90, 270, 0, 14],
    [0, 0, 0, 0, 0],
  ]) {
    const { host, motion } = fixture();
    host.screen.orientation.angle = angle;
    await motion.enable();
    host.emit('deviceorientation', { beta, gamma });
    close(settle(motion), x, y);
  }
});

test('accelerometer supplies tilt and shake without applying gravity twice', async () => {
  const { host, motion } = fixture();
  await motion.enable();
  host.emit('deviceorientation', { beta: 90, gamma: 0 });
  host.emit('devicemotion', {
    accelerationIncludingGravity: { x: 4, y: G, z: 0 },
    acceleration: { x: 4, y: 0, z: 0 },
  });
  // Accelerating the container right pushes the fluid left; gravity stays down.
  close(settle(motion), -4 * 14 / G, 14);
  host.screen.orientation.angle = 90;
  host.emit('devicemotion', { accelerationIncludingGravity: { x: G, y: 0, z: 0 } });
  close(settle(motion), 0, 14);
});

test('linear acceleration works when combined acceleration is unavailable', async () => {
  const { host, motion } = fixture();
  await motion.enable();
  host.emit('deviceorientation', { beta: 90, gamma: 0 });
  host.emit('devicemotion', { acceleration: { x: 4, y: 0 } });
  close(settle(motion), -4 * 14 / G, 14);
});

test('missing readings keep gravity down in landscape and null sensor fields are ignored', async () => {
  const { host, motion } = fixture();
  host.screen.orientation.angle = 90;
  await motion.enable();
  host.emit('deviceorientation', { beta: null, gamma: null });
  host.emit('devicemotion', {
    accelerationIncludingGravity: { x: null, y: null },
    acceleration: null,
  });
  close(settle(motion), 0, 14);
  assert.equal(motion.status, 'waiting');
});

test('permission requests both start within the click and partial access still enables tilt', async () => {
  const { host, motion } = fixture();
  const calls = [];
  let grantOrientation;
  host.DeviceMotionEvent.requestPermission = () => { calls.push('motion'); return Promise.resolve('denied'); };
  host.DeviceOrientationEvent.requestPermission = () => {
    calls.push('orientation');
    return new Promise(resolve => { grantOrientation = resolve; });
  };
  const enabling = motion.enable();
  assert.deepEqual(calls, ['motion', 'orientation']);
  assert.equal(motion.status, 'requesting');
  grantOrientation('granted');
  await enabling;
  assert.equal(motion.enabled, true);
  assert.equal(host.listeners.get('devicemotion')?.size ?? 0, 0);
  host.emit('deviceorientation', { beta: 90, gamma: 0 });
  close(settle(motion), 0, 14);
  assert.equal(motion.status, 'active');
});

test('denied or failed permissions leave drag-only gravity available', async () => {
  for (const throws of [false, true]) {
    const { host, motion } = fixture();
    const request = () => throws ? Promise.reject(new Error('blocked')) : Promise.resolve('denied');
    host.DeviceMotionEvent.requestPermission = request;
    host.DeviceOrientationEvent.requestPermission = request;
    await motion.enable();
    assert.equal(motion.enabled, false);
    assert.equal(motion.status, throws ? 'error' : 'denied');
    close(motion.sample(1 / 60), 0, 14);
  }
});

test('disabling clears sensor forces and listeners, including pending permission requests', async () => {
  const { host, motion, timers } = fixture();
  await motion.enable();
  host.emit('deviceorientation', { beta: 0, gamma: 90 });
  close(settle(motion), 14, 0);
  motion.disable();
  close(motion.sample(1 / 60), 0, 14);
  assert.equal(motion.status, 'off');
  for (const listeners of host.listeners.values()) assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);

  let grant;
  host.DeviceMotionEvent.requestPermission = () => new Promise(resolve => { grant = resolve; });
  const pending = motion.enable();
  motion.disable();
  grant('granted');
  await pending;
  assert.equal(motion.enabled, false);
  assert.equal(motion.status, 'off');
});

test('stale readings and background tabs cannot replay a shake indefinitely', async () => {
  const { host, motion, advance } = fixture();
  await motion.enable();
  host.emit('deviceorientation', { beta: 90, gamma: 0 });
  host.emit('devicemotion', { accelerationIncludingGravity: { x: 8, y: G } });
  assert.ok(settle(motion).x < -10);
  advance(400);
  close(settle(motion), 0, 14);
  host.emit('devicemotion', { accelerationIncludingGravity: { x: 8, y: G } });
  host.document.hidden = true;
  host.document.emit('visibilitychange');
  close(motion.sample(1 / 60), 0, 14);
  host.document.hidden = false;
  close(settle(motion), 0, 14);
});

test('sensor spikes are bounded and missing hardware gets a useful status', async () => {
  const { host, motion, timers } = fixture();
  await motion.enable();
  for (const timeout of timers.values()) timeout();
  assert.equal(motion.status, 'no-data');
  host.emit('devicemotion', { accelerationIncludingGravity: { x: 1e6, y: -1e6 } });
  assert.ok(Math.hypot(...Object.values(settle(motion))) <= 42 + 1e-10);
  assert.equal(motion.status, 'active');

  for (const secure of [true, false]) {
    host.isSecureContext = secure;
    host.DeviceMotionEvent = host.DeviceOrientationEvent = undefined;
    const unavailable = new PhoneMotion(host, 14, () => {});
    await unavailable.enable();
    assert.equal(unavailable.status, secure ? 'unavailable' : 'insecure');
    close(unavailable.sample(1 / 60), 0, 14);
  }
});
