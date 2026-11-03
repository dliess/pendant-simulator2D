
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export class FluidSimulation {
  readonly radius: number;
  particles: Particle[] = [];

  gravityX = 0;
  gravityY = 9.8;

  private readonly h = 0.18;
  private readonly particleRadius = 0.016;
  private readonly restDensity = 5.0;
  private readonly iterations = 5;
  private readonly epsilon = 0.01;

  private grid = new Map<string, number[]>();

  constructor(
    radius = 1,
    particleCount = 500
  ) {
    this.radius = radius;
    // Start in a compact, slightly jittered lattice.
    const spacing = 0.035;
    const columns = 14;

    for (let i = 0; i < particleCount; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);

      this.particles.push({
        x: (col - (columns - 1) / 2) * spacing
          + (Math.random() - 0.5) * 0.008,
        y: 0.05 + row * spacing,
        vx: 0,
        vy: 0
      });
    }

    for (const p of this.particles) {
      this.constrainBoundary(p);
    }
  }

  setGravity(x: number, y: number) {
    this.gravityX = x;
    this.gravityY = y;
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.h)},${Math.floor(y / this.h)}`;
  }

  private buildGrid() {
    this.grid.clear();

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const key = this.key(p.x, p.y);

      let cell = this.grid.get(key);

      if (!cell) {
        cell = [];
        this.grid.set(key, cell);
      }

      cell.push(i);
    }
  }

  private neighbors(index: number): number[] {
    const p = this.particles[index];
    const cx = Math.floor(p.x / this.h);
    const cy = Math.floor(p.y / this.h);

    const result: number[] = [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.grid.get(
          `${cx + dx},${cy + dy}`
        );

        if (cell) result.push(...cell);
      }
    }

    return result;
  }

  // Compact-support density kernel.
  private kernel(r2: number): number {
    const h2 = this.h * this.h;

    if (r2 >= h2) return 0;

    const q = 1 - r2 / h2;
    return q * q * q;
  }

  private gradient(dx: number, dy: number) {
    const r2 = dx * dx + dy * dy;
    const h2 = this.h * this.h;

    if (r2 >= h2) return { x: 0, y: 0 };

    const q = 1 - r2 / h2;
    const scale = -6 * q * q / h2;

    return {
      x: scale * dx,
      y: scale * dy
    };
  }

  private constrainBoundary(p: Particle) {
    const limit = this.radius - this.particleRadius;
    const distance = Math.hypot(p.x, p.y);

    if (distance > limit) {
      const scale = limit / distance;
      p.x *= scale;
      p.y *= scale;
    }
  }

  update(dt: number) {
    dt = Math.min(dt, 1 / 60);

    const n = this.particles.length;
    const oldX = new Float64Array(n);
    const oldY = new Float64Array(n);

    // 1. Predict particle positions.
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];

      oldX[i] = p.x;
      oldY[i] = p.y;

      p.vx += this.gravityX * dt;
      p.vy += this.gravityY * dt;

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      this.constrainBoundary(p);
    }

    const lambdas = new Float64Array(n);
    const deltaX = new Float64Array(n);
    const deltaY = new Float64Array(n);

    // 2. Iteratively enforce density constraints.
    for (let iteration = 0; iteration < this.iterations; iteration++) {
      this.buildGrid();

      // Compute constraint multipliers.
      for (let i = 0; i < n; i++) {
        const p = this.particles[i];
        const nearby = this.neighbors(i);

        let density = 0;
        let gradientSum = 0;
        let gradIX = 0;
        let gradIY = 0;

        for (const j of nearby) {
          const other = this.particles[j];

          const dx = p.x - other.x;
          const dy = p.y - other.y;
          const r2 = dx * dx + dy * dy;

          density += this.kernel(r2);

          if (i === j || r2 >= this.h * this.h) {
            continue;
          }

          const grad = this.gradient(dx, dy);

          const gx = grad.x / this.restDensity;
          const gy = grad.y / this.restDensity;

          gradientSum += gx * gx + gy * gy;

          gradIX += gx;
          gradIY += gy;
        }

        gradientSum += gradIX * gradIX + gradIY * gradIY;

        // Only resist compression, not empty space.
        const constraint = Math.max(
          0,
          density / this.restDensity - 1
        );

        lambdas[i] = -constraint /
          (gradientSum + this.epsilon);
      }

      // Calculate corrections without modifying positions yet.
      for (let i = 0; i < n; i++) {
        const p = this.particles[i];
        const nearby = this.neighbors(i);

        let dxTotal = 0;
        let dyTotal = 0;

        for (const j of nearby) {
          if (i === j) continue;

          const other = this.particles[j];

          const dx = p.x - other.x;
          const dy = p.y - other.y;
          const r2 = dx * dx + dy * dy;

          if (r2 >= this.h * this.h) continue;

          const grad = this.gradient(dx, dy);

          // Small artificial-pressure term.
          const w = this.kernel(r2);
          const sCorr = -0.02 * Math.pow(w, 4);

          const correction =
            (lambdas[i] + lambdas[j] + sCorr) /
            this.restDensity;

          dxTotal += correction * grad.x;
          dyTotal += correction * grad.y;
        }

        deltaX[i] = dxTotal;
        deltaY[i] = dyTotal;
      }

      // Apply corrections simultaneously.
      for (let i = 0; i < n; i++) {
        const p = this.particles[i];

        p.x += deltaX[i];
        p.y += deltaY[i];

        this.constrainBoundary(p);
      }
    }

    // 3. Reconstruct velocities from corrected positions.
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];

      p.vx = (p.x - oldX[i]) / dt;
      p.vy = (p.y - oldY[i]) / dt;
    }

    // 4. Apply neighborhood velocity smoothing (XSPH).
    this.buildGrid();

    const smoothX = new Float64Array(n);
    const smoothY = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      const nearby = this.neighbors(i);

      let sumX = 0;
      let sumY = 0;
      let weightSum = 0;

      for (const j of nearby) {
        if (i === j) continue;

        const other = this.particles[j];
        const dx = p.x - other.x;
        const dy = p.y - other.y;

        const w = this.kernel(dx * dx + dy * dy);

        sumX += (other.vx - p.vx) * w;
        sumY += (other.vy - p.vy) * w;
        weightSum += w;
      }

      const viscosity = 0.01;

      if (weightSum > 0) {
        smoothX[i] = viscosity * sumX / weightSum;
        smoothY[i] = viscosity * sumY / weightSum;
      }
    }

    // 5. Damping and velocity limiting.
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];

      p.vx = (p.vx + smoothX[i]) * 0.999;
      p.vy = (p.vy + smoothY[i]) * 0.999;

      const speed = Math.hypot(p.vx, p.vy);
      const maxSpeed = 5;

      if (speed > maxSpeed) {
        p.vx *= maxSpeed / speed;
        p.vy *= maxSpeed / speed;
      }

      // Prevent outward velocity at the wall.
      const limit = this.radius - this.particleRadius;
      const dist = Math.hypot(p.x, p.y);

      if (dist >= limit - 0.001 && dist > 0) {
        const nx = p.x / dist;
        const ny = p.y / dist;
        const outward = p.vx * nx + p.vy * ny;

        if (outward > 0) {
          p.vx -= outward * nx;
          p.vy -= outward * ny;
        }
      }
    }
  }
}

