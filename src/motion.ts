interface Vector {
  x: number;
  y: number;
}

interface SensorAPI {
  readonly prototype: object;
  requestPermission?: () => Promise<PermissionState>;
}

type SensorWindow = Window & {
  DeviceMotionEvent?: SensorAPI;
  DeviceOrientationEvent?: SensorAPI;
  orientation?: number;
};

export type MotionStatus =
  'off' | 'requesting' | 'permission-required' | 'waiting' | 'active' | 'no-data' |
  'denied' | 'unavailable' | 'insecure' | 'error';

const EARTH_GRAVITY = 9.80665;

function hasXY(value: { x: number | null; y: number | null } | null | undefined):
  value is Vector {
  return value !== null && value !== undefined && Number.isFinite(value.x) && Number.isFinite(value.y);
}

// Sensor axes stay in the device's natural orientation when the display rotates.
// The input vector uses canvas axes: right is +x and down is +y.
export function rotateToScreen(x: number, y: number, angle: number): Vector {
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos + y * sin, y: -x * sin + y * cos };
}

export class PhoneMotion {
  private readonly host: SensorWindow;
  private readonly strength: number;
  private readonly onStatus: (status: MotionStatus) => void;
  private currentStatus: MotionStatus;
  private listening = false;
  private generation = 0;
  private waitTimer: number | undefined;
  private tilt: Vector | null = null;
  private combined: Vector | null = null;
  private linear: Vector | null = null;
  private lastMotion = -Infinity;
  private filtered: Vector;

  constructor(host: SensorWindow, strength: number, onStatus: (status: MotionStatus) => void) {
    this.host = host;
    this.strength = strength;
    this.onStatus = onStatus;
    this.filtered = { x: 0, y: strength };
    this.currentStatus = !host.isSecureContext ? 'insecure' :
      !host.DeviceMotionEvent && !host.DeviceOrientationEvent ? 'unavailable' : 'off';
  }

  get status() { return this.currentStatus; }
  get enabled() { return this.listening; }

  async enable() {
    if (this.listening || this.currentStatus === 'requesting' ||
        this.currentStatus === 'insecure' || this.currentStatus === 'unavailable') return;
    const generation = ++this.generation;
    this.setStatus('requesting');

    const request = async (api: SensorAPI | undefined) => {
      if (!api) return false;
      return !api.requestPermission || await api.requestPermission() === 'granted';
    };
    // Start both permission requests synchronously in the click handler. Awaiting
    // one first can lose the user activation required for the second request.
    const [motion, orientation] = await Promise.allSettled([
      request(this.host.DeviceMotionEvent),
      request(this.host.DeviceOrientationEvent),
    ]);
    if (generation !== this.generation) return;
    const useMotion = motion.status === 'fulfilled' && motion.value;
    const useOrientation = orientation.status === 'fulfilled' && orientation.value;
    if (!useMotion && !useOrientation) {
      const failures = [motion, orientation].filter(result => result.status === 'rejected');
      const needsGesture = failures.length > 0 && failures.every(result =>
        result.reason?.name === 'NotAllowedError');
      this.setStatus(needsGesture ? 'permission-required' : failures.length > 0 ? 'error' : 'denied');
      return;
    }

    this.listening = true;
    if (useMotion) this.host.addEventListener('devicemotion', this.handleMotion);
    if (useOrientation) this.host.addEventListener('deviceorientation', this.handleOrientation);
    this.host.document.addEventListener('visibilitychange', this.handleVisibility);
    this.setStatus('waiting');
    this.waitTimer = this.host.setTimeout(() => {
      if (this.currentStatus === 'waiting') this.setStatus('no-data');
    }, 3000);
  }

  disable() {
    this.generation++;
    this.listening = false;
    this.host.removeEventListener('devicemotion', this.handleMotion);
    this.host.removeEventListener('deviceorientation', this.handleOrientation);
    this.host.document.removeEventListener('visibilitychange', this.handleVisibility);
    this.host.clearTimeout(this.waitTimer);
    this.tilt = this.combined = this.linear = null;
    this.lastMotion = -Infinity;
    this.filtered = { x: 0, y: this.strength };
    if (this.currentStatus !== 'insecure' && this.currentStatus !== 'unavailable') this.setStatus('off');
  }

  sample(dt: number): Vector {
    if (!this.listening || this.host.document.hidden) return { x: 0, y: this.strength };
    const freshMotion = this.host.performance.now() - this.lastMotion < 350;
    const screenAngle = this.host.screen.orientation?.angle ?? this.host.orientation ?? 0;
    let target = this.tilt ? rotateToScreen(this.tilt.x, this.tilt.y, screenAngle)
      : { x: 0, y: EARTH_GRAVITY };
    if (freshMotion && this.combined) {
      // Proper acceleration already includes gravity. Its negative is the
      // liquid's apparent force, so adding tilt again would double gravity.
      target = rotateToScreen(this.combined.x, this.combined.y, screenAngle);
    } else if (freshMotion && this.linear) {
      const inertia = rotateToScreen(this.linear.x, this.linear.y, screenAngle);
      target.x += inertia.x;
      target.y += inertia.y;
    }

    const scale = this.strength / EARTH_GRAVITY;
    target.x *= scale;
    target.y *= scale;
    const magnitude = Math.hypot(target.x, target.y);
    // Limit sensor spikes before they reach the solver; keep zero in-plane
    // gravity when the phone lies flat instead of normalizing noise to 1 g.
    const limit = magnitude > this.strength * 3 ? this.strength * 3 / magnitude : 1;
    target.x *= limit;
    target.y *= limit;
    const blend = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) / 0.045);
    this.filtered.x += (target.x - this.filtered.x) * blend;
    this.filtered.y += (target.y - this.filtered.y) * blend;
    return { ...this.filtered };
  }

  private readonly handleMotion = (event: DeviceMotionEvent) => {
    const combined = event.accelerationIncludingGravity;
    const linear = event.acceleration;
    this.combined = hasXY(combined) ? { x: -combined.x, y: combined.y } : null;
    this.linear = hasXY(linear) ? { x: -linear.x, y: linear.y } : null;
    if (!this.combined && !this.linear) return;
    this.lastMotion = this.host.performance.now();
    this.receivedReading();
  };

  private readonly handleOrientation = (event: DeviceOrientationEvent) => {
    if (event.beta === null || event.gamma === null ||
        !Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return;
    const beta = event.beta * Math.PI / 180;
    const gamma = event.gamma * Math.PI / 180;
    // Project world gravity into the phone's screen plane; alpha is yaw and
    // does not change gravity. See https://www.w3.org/TR/orientation-event/.
    this.tilt = {
      x: EARTH_GRAVITY * Math.sin(gamma) * Math.cos(beta),
      y: EARTH_GRAVITY * Math.sin(beta),
    };
    this.receivedReading();
  };

  private readonly handleVisibility = () => {
    if (!this.host.document.hidden) return;
    // Do not replay the last shake after returning from a background tab.
    this.combined = this.linear = null;
    this.lastMotion = -Infinity;
    this.filtered = { x: 0, y: this.strength };
  };

  private receivedReading() {
    this.host.clearTimeout(this.waitTimer);
    if (this.currentStatus !== 'active') this.setStatus('active');
  }

  private setStatus(status: MotionStatus) {
    this.currentStatus = status;
    this.onStatus(status);
  }
}
