
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export class FluidSimulation {
  readonly particles: Particle[] = [];

  gravityX = 0;
  gravityY = 9.8;

  readonly n = 64;
  readonly dx = 2 / this.n;

  readonly flipRatio = 0.9;
  readonly pressureIterations = 40;

  private readonly dtEpsilon = 1e-8;

  // MAC grid:
  // u: (n + 1) x n, horizontal velocity
  // v: n x (n + 1), vertical velocity
  private u: Float32Array;
  private v: Float32Array;
  private oldU: Float32Array;
  private oldV: Float32Array;
  private uWeight: Float32Array;
  private vWeight: Float32Array;

  private pressure: Float32Array;
  private divergence: Float32Array;
  private fluid: Uint8Array;
  private solid: Uint8Array;

  constructor(
    public readonly radius = 1,
    particleCount = 2000,
    fillLevel = 0.3
  ) {
    const n = this.n;

    this.u = new Float32Array((n + 1) * n);
    this.v = new Float32Array(n * (n + 1));
    this.oldU = new Float32Array(this.u.length);
    this.oldV = new Float32Array(this.v.length);
    this.uWeight = new Float32Array(this.u.length);
    this.vWeight = new Float32Array(this.v.length);

    this.pressure = new Float32Array(n * n);
    this.divergence = new Float32Array(n * n);
    this.fluid = new Uint8Array(n * n);
    this.solid = new Uint8Array(n * n);

    // Mark cells outside the circular container as solid.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -1 + (i + 0.5) * this.dx;
        const y = -1 + (j + 0.5) * this.dx;

        if (Math.hypot(x, y) > radius) {
          this.solid[this.cell(i, j)] = 1;
        }
      }
    }

    // Fill a portion of the circle, independently of
    // how many particles we use.
    const surfaceY = 1 - 2 * fillLevel;

    for (let k = 0; k < particleCount; k++) {
      let x = 0;
      let y = 0;

      // Rejection sampling inside the lower circular segment.
      do {
        x = (Math.random() * 2 - 1) * radius;
        y = surfaceY +
          Math.random() * (radius - surfaceY);
      } while (
        x * x + y * y >
        (radius - 0.025) ** 2
      );

      this.particles.push({
        x, y, vx: 0, vy: 0
      });
    }
  }

  setGravity(x: number, y: number) {
    this.gravityX = x;
    this.gravityY = y;
  }

  private cell(i: number, j: number) {
    return i + j * this.n;
  }

  private ui(i: number, j: number) {
    return i + j * (this.n + 1);
  }

  private vi(i: number, j: number) {
    return i + j * this.n;
  }

  private isSolid(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) {
      return true;
    }
    return this.solid[this.cell(i, j)] !== 0;
  }

  private isFluid(i: number, j: number): boolean {
    if (this.isSolid(i, j)) return false;
    return this.fluid[this.cell(i, j)] !== 0;
  }

  // Bilinear transfer between particles and grid faces.
  private splat(
    values: Float32Array,
    weights: Float32Array,
    gx: number,
    gy: number,
    width: number,
    height: number,
    value: number
  ) {
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;

    for (let oy = 0; oy <= 1; oy++) {
      for (let ox = 0; ox <= 1; ox++) {
        const x = i + ox;
        const y = j + oy;

        if (x < 0 || y < 0 || x >= width || y >= height) {
          continue;
        }

        const w =
          (ox ? fx : 1 - fx) *
          (oy ? fy : 1 - fy);

        const index = x + y * width;

        values[index] += value * w;
        weights[index] += w;
      }
    }
  }

  private sample(
    values: Float32Array,
    gx: number,
    gy: number,
    width: number,
    height: number
  ): number {
    gx = Math.max(0, Math.min(width - 1, gx));
    gy = Math.max(0, Math.min(height - 1, gy));

    const i = Math.min(width - 2, Math.floor(gx));
    const j = Math.min(height - 2, Math.floor(gy));

    const fx = gx - i;
    const fy = gy - j;

    const a = values[i + j * width];
    const b = values[i + 1 + j * width];
    const c = values[i + (j + 1) * width];
    const d = values[i + 1 + (j + 1) * width];

    return (
      a * (1 - fx) * (1 - fy) +
      b * fx * (1 - fy) +
      c * (1 - fx) * fy +
      d * fx * fy
    );
  }

  private sampleU(values: Float32Array, x: number, y: number) {
    return this.sample(
      values,
      (x + 1) / this.dx,
      (y + 1) / this.dx - 0.5,
      this.n + 1,
      this.n
    );
  }

  private sampleV(values: Float32Array, x: number, y: number) {
    return this.sample(
      values,
      (x + 1) / this.dx - 0.5,
      (y + 1) / this.dx,
      this.n,
      this.n + 1
    );
  }

  private particleToGrid() {
    this.u.fill(0);
    this.v.fill(0);
    this.uWeight.fill(0);
    this.vWeight.fill(0);
    this.fluid.fill(0);

    for (const p of this.particles) {
      const gx = (p.x + 1) / this.dx;
      const gy = (p.y + 1) / this.dx;

      this.splat(
        this.u, this.uWeight,
        gx, gy - 0.5,
        this.n + 1, this.n, p.vx
      );

      this.splat(
        this.v, this.vWeight,
        gx - 0.5, gy,
        this.n, this.n + 1, p.vy
      );

      const i = Math.floor(gx);
      const j = Math.floor(gy);

      if (
        i >= 0 && i < this.n &&
        j >= 0 && j < this.n &&
        !this.isSolid(i, j)
      ) {
        this.fluid[this.cell(i, j)] = 1;
      }
    }

    for (let i = 0; i < this.u.length; i++) {
      if (this.uWeight[i] > 0) {
        this.u[i] /= this.uWeight[i];
      }
    }

    for (let i = 0; i < this.v.length; i++) {
      if (this.vWeight[i] > 0) {
        this.v[i] /= this.vWeight[i];
      }
    }

    // Extend velocities into nearby empty faces so that
    // particles at the free surface can sample them.
    this.extrapolate(this.u, this.uWeight, this.n + 1, this.n);
    this.extrapolate(this.v, this.vWeight, this.n, this.n + 1);
  }

  private extrapolate(
    values: Float32Array,
    weights: Float32Array,
    width: number,
    height: number
  ) {
    const valid = new Uint8Array(weights.length);

    for (let k = 0; k < weights.length; k++) {
      if (weights[k] > 0) valid[k] = 1;
    }

    for (let pass = 0; pass < 3; pass++) {
      const nextValues = values.slice();
      const nextValid = valid.slice();

      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const index = i + j * width;
          if (valid[index]) continue;

          let sum = 0;
          let count = 0;

          const adjacent = [
            [i - 1, j], [i + 1, j],
            [i, j - 1], [i, j + 1]
          ];

          for (const [x, y] of adjacent) {
            if (x < 0 || y < 0 || x >= width || y >= height) {
              continue;
            }

            const k = x + y * width;

            if (valid[k]) {
              sum += values[k];
              count++;
            }
          }

          if (count > 0) {
            nextValues[index] = sum / count;
            nextValid[index] = 1;
          }
        }
      }

      values.set(nextValues);
      valid.set(nextValid);
    }
  }

  private enforceWalls() {
    // Zero face-normal velocities at solid boundaries.
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i <= this.n; i++) {
        if (this.isSolid(i - 1, j) || this.isSolid(i, j)) {
          this.u[this.ui(i, j)] = 0;
        }
      }
    }

    for (let j = 0; j <= this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        if (this.isSolid(i, j - 1) || this.isSolid(i, j)) {
          this.v[this.vi(i, j)] = 0;
        }
      }
    }
  }

  private solvePressure(dt: number) {
    const n = this.n;
    const h = this.dx;

    this.pressure.fill(0);
    this.divergence.fill(0);

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (!this.isFluid(i, j)) continue;

        const index = this.cell(i, j);

        this.divergence[index] = (
          this.u[this.ui(i + 1, j)] -
          this.u[this.ui(i, j)] +
          this.v[this.vi(i, j + 1)] -
          this.v[this.vi(i, j)]
        ) / h;
      }
    }

    // Jacobi iterations for the pressure Poisson equation.
    let next = new Float32Array(n * n);

    for (let iteration = 0; iteration < this.pressureIterations; iteration++) {
      next.fill(0);

      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          if (!this.isFluid(i, j)) continue;

          const index = this.cell(i, j);
          let sum = 0;
          let count = 0;

          const neighbors = [
            [i - 1, j], [i + 1, j],
            [i, j - 1], [i, j + 1]
          ];

          for (const [x, y] of neighbors) {
            // Solid neighbors impose zero normal flow.
            if (this.isSolid(x, y)) continue;

            count++;

            // Air pressure is zero.
            if (this.isFluid(x, y)) {
              sum += this.pressure[this.cell(x, y)];
            }
          }

          if (count > 0) {
            next[index] = (
              sum - this.divergence[index] * h * h / dt
            ) / count;
          }
        }
      }

      const temp = this.pressure;
      this.pressure = next;
      next = temp;
    }

    // Subtract pressure gradient on horizontal faces.
    for (let j = 0; j < n; j++) {
      for (let i = 1; i < n; i++) {
        if (this.isSolid(i - 1, j) || this.isSolid(i, j)) {
          continue;
        }

        if (!this.isFluid(i - 1, j) && !this.isFluid(i, j)) {
          continue;
        }

        const left = this.isFluid(i - 1, j)
          ? this.pressure[this.cell(i - 1, j)] : 0;
        const right = this.isFluid(i, j)
          ? this.pressure[this.cell(i, j)] : 0;

        this.u[this.ui(i, j)] -= dt * (right - left) / h;
      }
    }

    // Subtract pressure gradient on vertical faces.
    for (let j = 1; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (this.isSolid(i, j - 1) || this.isSolid(i, j)) {
          continue;
        }

        if (!this.isFluid(i, j - 1) && !this.isFluid(i, j)) {
          continue;
        }

        const top = this.isFluid(i, j - 1)
          ? this.pressure[this.cell(i, j - 1)] : 0;
        const bottom = this.isFluid(i, j)
          ? this.pressure[this.cell(i, j)] : 0;

        this.v[this.vi(i, j)] -= dt * (bottom - top) / h;
      }
    }

    this.enforceWalls();
  }

  private gridToParticle() {
    const flip = this.flipRatio;

    for (const p of this.particles) {
      const picVX = this.sampleU(this.u, p.x, p.y);
      const picVY = this.sampleV(this.v, p.x, p.y);

      const deltaVX =
        picVX - this.sampleU(this.oldU, p.x, p.y);
      const deltaVY =
        picVY - this.sampleV(this.oldV, p.x, p.y);

      const flipVX = p.vx + deltaVX;
      const flipVY = p.vy + deltaVY;

      p.vx = flip * flipVX + (1 - flip) * picVX;
      p.vy = flip * flipVY + (1 - flip) * picVY;

      const speed = Math.hypot(p.vx, p.vy);
      const maxSpeed = 8;

      if (speed > maxSpeed) {
        p.vx *= maxSpeed / speed;
        p.vy *= maxSpeed / speed;
      }
    }
  }

  private advectParticles(dt: number) {
    const limit = this.radius - 0.018;

    for (const p of this.particles) {
      // Midpoint integration using the projected grid field.
      const midX = p.x + p.vx * dt * 0.5;
      const midY = p.y + p.vy * dt * 0.5;

      const gridVX = this.sampleU(this.u, midX, midY);
      const gridVY = this.sampleV(this.v, midX, midY);

      // Mix in particle velocity to retain fine FLIP motion.
      p.x += (0.7 * gridVX + 0.3 * p.vx) * dt;
      p.y += (0.7 * gridVY + 0.3 * p.vy) * dt;

      // Circular particle boundary.
      const distance = Math.hypot(p.x, p.y);

      if (distance > limit) {
        const nx = p.x / distance;
        const ny = p.y / distance;

        p.x = nx * limit;
        p.y = ny * limit;

        const outward = p.vx * nx + p.vy * ny;

        if (outward > 0) {
          p.vx -= outward * nx;
          p.vy -= outward * ny;
        }
      }
    }
  }

  update(dt: number) {
    if (dt <= this.dtEpsilon) return;

    // External acceleration is applied to particles.
    for (const p of this.particles) {
      p.vx += this.gravityX * dt;
      p.vy += this.gravityY * dt;
    }

    this.particleToGrid();
    this.enforceWalls();

    // Save the pre-projection grid for FLIP deltas.
    this.oldU.set(this.u);
    this.oldV.set(this.v);

    this.solvePressure(dt);
    this.gridToParticle();
    this.advectParticles(dt);
  }
}

