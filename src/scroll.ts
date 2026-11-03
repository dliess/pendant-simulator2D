interface Position { x: number; y: number }

/** Inertia opposite to the pendant's viewport acceleration, in simulation units. */
export class ScrollMotion {
  private previous: Position | null = null;
  private scale = 0;
  private velocity: Position = { x: 0, y: 0 };
  private force: Position = { x: 0, y: 0 };
  private readonly limit: number;

  constructor(gravityStrength: number) {
    this.limit = gravityStrength * 2;
  }

  reset() {
    this.previous = null;
    this.velocity = { x: 0, y: 0 };
    this.force = { x: 0, y: 0 };
  }

  sample(position: Position, pixelsPerUnit: number, dt: number, scrolled = true): Position {
    // A resumed tab, resized canvas, or missing geometry needs a fresh baseline,
    // rather than interpreting the whole gap as one scroll impulse.
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)
      || !Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0
      || !Number.isFinite(dt) || dt <= 0 || dt > 0.1) {
      this.reset();
      return { x: 0, y: 0 };
    }
    if (!this.previous || Math.abs(this.scale - pixelsPerUnit) > 0.001) {
      this.reset();
      this.previous = { ...position };
      this.scale = pixelsPerUnit;
      return { x: 0, y: 0 };
    }

    // Without a scroll event, layout shifts and unrelated transforms only update
    // the baseline. Still sample zero velocity so stopping produces a rebound.
    let vx = scrolled ? (position.x - this.previous.x) / pixelsPerUnit / dt : 0;
    let vy = scrolled ? (position.y - this.previous.y) / pixelsPerUnit / dt : 0;
    this.previous = { ...position };
    const speed = Math.hypot(vx, vy);
    if (speed > 12) { vx *= 12 / speed; vy *= 12 / speed; }

    const velocityBlend = 1 - Math.exp(-dt / 0.08);
    const nextX = this.velocity.x + (vx - this.velocity.x) * velocityBlend;
    const nextY = this.velocity.y + (vy - this.velocity.y) * velocityBlend;
    let ax = -(nextX - this.velocity.x) / dt;
    let ay = -(nextY - this.velocity.y) / dt;
    this.velocity = { x: nextX, y: nextY };
    const magnitude = Math.hypot(ax, ay);
    if (magnitude > this.limit) {
      ax *= this.limit / magnitude;
      ay *= this.limit / magnitude;
    }

    // A second short filter softens discrete wheel/touch events. Constant scroll
    // velocity converges to zero force; gravity itself is never rotated.
    const forceBlend = 1 - Math.exp(-dt / 0.04);
    this.force.x += (ax - this.force.x) * forceBlend;
    this.force.y += (ay - this.force.y) * forceBlend;
    return { ...this.force };
  }
}
