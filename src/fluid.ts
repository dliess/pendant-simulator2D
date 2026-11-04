
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
  readonly radius: number;
  readonly dx: number;

  // Preserve more splash momentum while retaining some PIC damping for noise.
  readonly flipRatio = 0.85;
  readonly pressureIterations = 60;

  private readonly dtEpsilon = 1e-8;
  private readonly densityRelaxationRate = 80;
  private readonly maxParticleSpeed = 10;

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
  private particleDensity: Float32Array;
  private readonly restDensity: number;
  private readonly particleLimit: number;
  private readonly uBlocked: Uint8Array;
  private readonly vBlocked: Uint8Array;
  private readonly cellParticleCounts: Uint32Array;
  private readonly ballistic: Uint8Array;
  private readonly componentCells: Uint16Array;
  private readonly componentQueue: Int32Array;

  constructor(
    radius = 1,
    particleCount = 2000,
    fillLevel = 0.25
  ) {
    if (!Number.isFinite(radius) || radius <= 0 ||
        !Number.isInteger(particleCount) || particleCount < 0 ||
        !Number.isFinite(fillLevel) || fillLevel < 0 || fillLevel > 1) {
      throw new RangeError('Invalid fluid radius, particle count, or fill level');
    }

    this.radius = radius;
    this.dx = 2 * radius / this.n;
    // Keep particles in cells whose centers are inside the circular wall.
    this.particleLimit = radius - 0.8 * this.dx;
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
    this.particleDensity = new Float32Array(n * n);
    this.uBlocked = new Uint8Array(this.u.length);
    this.vBlocked = new Uint8Array(this.v.length);
    this.cellParticleCounts = new Uint32Array(n * n);
    this.ballistic = new Uint8Array(particleCount);
    this.componentCells = new Uint16Array(n * n);
    this.componentQueue = new Int32Array(n * n);

    // Mark cells outside the circular container as solid.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -radius + (i + 0.5) * this.dx;
        const y = -radius + (j + 0.5) * this.dx;

        if (Math.hypot(x, y) > radius) {
          this.solid[this.cell(i, j)] = 1;
        }
      }
    }

    for (let j = 0; j < n; j++) {
      for (let i = 0; i <= n; i++) {
        this.uBlocked[this.ui(i, j)] = Number(
          this.isSolid(i - 1, j) || this.isSolid(i, j)
        );
      }
    }
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i < n; i++) {
        this.vBlocked[this.vi(i, j)] = Number(
          this.isSolid(i, j - 1) || this.isSolid(i, j)
        );
      }
    }

    // Fill a portion of the circle, independently of
    // how many particles we use.
    const limit = this.particleLimit;
    const surfaceY = limit * (1 - 2 * fillLevel);
    const area = limit * limit * Math.acos(surfaceY / limit) -
      surfaceY * Math.sqrt(Math.max(0, limit * limit - surfaceY * surfaceY));
    // A marker cannot represent less than one occupied grid cell. This floor
    // also prevents isolated particles from generating pressure against themselves.
    this.restDensity = area > 0 && particleCount > 0
      ? Math.max(1, particleCount * this.dx * this.dx / area) : 0;
    if (fillLevel === 0) return;

    // A uniform lattice avoids empty interior cells and large initial density
    // spikes, both of which inject noise into a particle/grid pressure solve.
    if (particleCount === 0) return;
    let spacing = Math.sqrt(2 * area / (Math.sqrt(3) * particleCount));
    let positions: { x: number; y: number }[] = [];
    do {
      positions = [];
      const rowHeight = spacing * Math.sqrt(3) / 2;
      let row = 0;
      for (let y = surfaceY + rowHeight * 0.5; y < limit; y += rowHeight, row++) {
        for (let x = -limit + spacing * (0.5 + (row % 2) * 0.5); x < limit; x += spacing) {
          if (x * x + y * y <= limit * limit) positions.push({ x, y });
        }
      }
      spacing *= 0.98;
    } while (positions.length < particleCount);

    for (let k = 0; k < particleCount; k++) {
      const p = positions[Math.floor((k + 0.5) * positions.length / particleCount)];
      this.particles.push({ x: p.x, y: p.y, vx: 0, vy: 0 });
    }
  }

  setGravity(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RangeError('Gravity must be finite');
    }
    this.gravityX = x;
    this.gravityY = y;
  }

  dragParticles(
    fromX: number, fromY: number,
    toX: number, toY: number,
    dt: number,
    influenceRadius = 0.18 * this.radius
  ) {
    if (![fromX, fromY, toX, toY, dt, influenceRadius].every(Number.isFinite) ||
        dt <= 0 || influenceRadius <= 0) return;

    const dx = toX - fromX;
    const dy = toY - fromY;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-16) return;

    const elapsed = Math.min(dt, 0.05);
    const speedScale = Math.min(1 / elapsed, this.maxParticleSpeed / Math.sqrt(lengthSquared));
    const vx = dx * speedScale;
    const vy = dy * speedScale;
    const radiusSquared = influenceRadius * influenceRadius;

    for (const p of this.particles) {
      // Sweep the whole drag segment so fast pointer moves cannot skip liquid.
      const t = Math.max(0, Math.min(1,
        ((p.x - fromX) * dx + (p.y - fromY) * dy) / lengthSquared
      ));
      const offsetX = p.x - (fromX + t * dx);
      const offsetY = p.y - (fromY + t * dy);
      const distanceSquared = offsetX * offsetX + offsetY * offsetY;
      if (distanceSquared >= radiusSquared) continue;

      const falloff = 1 - distanceSquared / radiusSquared;
      // Couple toward the pointer velocity with soft edges and a response that
      // scales with elapsed time rather than the number of pointer events.
      const blend = 1 - Math.exp(-60 * elapsed * falloff * falloff);
      p.vx += (vx - p.vx) * blend;
      p.vy += (vy - p.vy) * blend;
    }
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
    weights: Float32Array | null,
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
        if (weights) weights[index] += w;
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
      (x + this.radius) / this.dx,
      (y + this.radius) / this.dx - 0.5,
      this.n + 1,
      this.n
    );
  }

  private sampleV(values: Float32Array, x: number, y: number) {
    return this.sample(
      values,
      (x + this.radius) / this.dx - 0.5,
      (y + this.radius) / this.dx,
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
    this.particleDensity.fill(0);

    this.cellParticleCounts.fill(0);
    for (const p of this.particles) {
      const i = Math.floor((p.x + this.radius) / this.dx);
      const j = Math.floor((p.y + this.radius) / this.dx);
      this.cellParticleCounts[this.cell(i, j)]++;
    }

    // A tightly packed drop can have many markers but still occupy too few
    // cells to resolve a pressure field. Count face-connected occupied cells,
    // rather than mistaking marker density alone for a supported liquid volume.
    this.componentCells.fill(0);
    for (let seed = 0; seed < this.componentCells.length; seed++) {
      if (!this.cellParticleCounts[seed] || this.solid[seed] || this.componentCells[seed]) continue;
      let size = 1;
      this.componentQueue[0] = seed;
      this.componentCells[seed] = 0xffff;
      for (let head = 0; head < size; head++) {
        const index = this.componentQueue[head];
        const i = index % this.n;
        const j = Math.floor(index / this.n);
        for (let direction = 0; direction < 4; direction++) {
          const neighbor = direction === 0 ? (i > 0 ? index - 1 : -1) :
            direction === 1 ? (i + 1 < this.n ? index + 1 : -1) :
            direction === 2 ? (j > 0 ? index - this.n : -1) :
            (j + 1 < this.n ? index + this.n : -1);
          if (neighbor < 0 || !this.cellParticleCounts[neighbor] || this.solid[neighbor]
            || this.componentCells[neighbor]) continue;
          this.componentCells[neighbor] = 0xffff;
          this.componentQueue[size++] = neighbor;
        }
      }
      for (let k = 0; k < size; k++) this.componentCells[this.componentQueue[k]] = size;
    }

    // A few detached markers do not resolve a liquid volume on this grid.
    // Let these drops follow gravity instead of giving them grid pressure and
    // interpolated wall support. They rejoin the pressure solve in the pool.
    const minNeighbors = Math.max(4, Math.floor(4 * this.restDensity));
    for (let k = 0; k < this.particles.length; k++) {
      const p = this.particles[k];
      const gx = (p.x + this.radius) / this.dx;
      const gy = (p.y + this.radius) / this.dx;
      const i = Math.floor(gx);
      const j = Math.floor(gy);
      let count = 0;
      for (let y = Math.max(0, j - 1); y <= Math.min(this.n - 1, j + 1); y++) {
        for (let x = Math.max(0, i - 1); x <= Math.min(this.n - 1, i + 1); x++) {
          count += this.cellParticleCounts[this.cell(x, y)];
        }
      }
      this.ballistic[k] = Number(count < minNeighbors || this.componentCells[this.cell(i, j)] < 9);
      if (this.ballistic[k]) continue;

      this.splat(
        this.particleDensity, null,
        gx - 0.5, gy - 0.5, this.n, this.n, 1
      );

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

    // Only faces adjacent to liquid provide velocity data. Air faces are
    // extrapolated from these same seeds before and after projection.
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i <= this.n; i++) {
        const k = this.ui(i, j);
        if (this.uBlocked[k] || (!this.isFluid(i - 1, j) && !this.isFluid(i, j))) {
          this.uWeight[k] = 0;
          this.u[k] = 0;
        }
      }
    }
    for (let j = 0; j <= this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const k = this.vi(i, j);
        if (this.vBlocked[k] || (!this.isFluid(i, j - 1) && !this.isFluid(i, j))) {
          this.vWeight[k] = 0;
          this.v[k] = 0;
        }
      }
    }

    // Extend velocities into nearby empty faces so that
    // particles at the free surface can sample them.
    this.extrapolateVelocities();
  }

  private extrapolateVelocities() {
    this.extrapolate(this.u, this.uWeight, this.uBlocked, this.n + 1, this.n);
    this.extrapolate(this.v, this.vWeight, this.vBlocked, this.n, this.n + 1);
  }

  private extrapolate(
    values: Float32Array,
    weights: Float32Array,
    blocked: Uint8Array,
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
          if (valid[index] || blocked[index]) continue;

          let sum = 0;
          let count = 0;

          if (i > 0 && valid[index - 1]) {
            sum += values[index - 1];
            count++;
          }
          if (i + 1 < width && valid[index + 1]) {
            sum += values[index + 1];
            count++;
          }
          if (j > 0 && valid[index - width]) {
            sum += values[index - width];
            count++;
          }
          if (j + 1 < height && valid[index + width]) {
            sum += values[index + width];
            count++;
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

        // Correct accumulated compression as well as instantaneous divergence.
        // Without this feedback, small transfer errors steadily drain volume.
        if (this.restDensity > 0) {
          const compression = Math.max(0,
            this.particleDensity[index] / this.restDensity - 1
          );
          // Use a rate per second so CFL substeps do not amplify the feedback.
          this.divergence[index] -= this.densityRelaxationRate * compression;
        }
      }
    }

    // Successive over-relaxation propagates wall pressure through the pool
    // much faster than Jacobi, which left significant compression each step.
    for (let iteration = 0; iteration < this.pressureIterations; iteration++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          if (!this.isFluid(i, j)) continue;

          const index = this.cell(i, j);
          let sum = 0;
          let count = 0;

          // Air has zero pressure; solid neighbors impose zero normal flow.
          if (!this.isSolid(i - 1, j)) {
            count++;
            sum += this.pressure[index - 1];
          }
          if (!this.isSolid(i + 1, j)) {
            count++;
            sum += this.pressure[index + 1];
          }
          if (!this.isSolid(i, j - 1)) {
            count++;
            sum += this.pressure[index - n];
          }
          if (!this.isSolid(i, j + 1)) {
            count++;
            sum += this.pressure[index + n];
          }

          if (count > 0) {
            const projected = (
              sum - this.divergence[index] * h * h / dt
            ) / count;
            // With air at zero pressure, negative liquid pressure would create
            // suction that holds drops against the wall as gravity turns away.
            this.pressure[index] = Math.max(0,
              this.pressure[index] + 1.8 * (projected - this.pressure[index])
            );
          }
        }
      }
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

    for (let k = 0; k < this.particles.length; k++) {
      if (this.ballistic[k]) continue;
      const p = this.particles[k];
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
      const maxSpeed = this.maxParticleSpeed;

      if (speed > maxSpeed) {
        p.vx *= maxSpeed / speed;
        p.vy *= maxSpeed / speed;
      }
    }
  }

  private advectParticles(dt: number) {
    const limit = this.particleLimit;

    for (const p of this.particles) {
      // The transfer already updated particle velocity. Advect with that same
      // velocity so an extrapolated grid field cannot independently move drops.
      p.x += p.vx * dt;
      p.y += p.vy * dt;

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
    if (!Number.isFinite(dt) || dt <= this.dtEpsilon || this.particles.length === 0) return;

    // Bound both acceleration and travel per substep, including after a pause.
    let remaining = Math.min(dt, 0.05);
    while (remaining > this.dtEpsilon) {
      let maxSpeed = 0;
      for (const p of this.particles) {
        maxSpeed = Math.max(maxSpeed, Math.hypot(p.vx, p.vy));
      }
      const acceleration = Math.hypot(this.gravityX, this.gravityY);
      const step = Math.min(remaining, 1 / 120,
        0.5 * this.dx / Math.max(maxSpeed + acceleration / 120, this.dtEpsilon));
      this.step(step);
      remaining -= step;
    }
  }

  private step(dt: number) {
    this.particleToGrid();
    this.enforceWalls();

    for (let k = 0; k < this.particles.length; k++) {
      if (!this.ballistic[k]) continue;
      this.particles[k].vx += this.gravityX * dt;
      this.particles[k].vy += this.gravityY * dt;
    }

    // Include gravity and wall response in the FLIP delta. Applying gravity to
    // particles first leaves unprojected acceleration trapped near the wall.
    this.oldU.set(this.u);
    this.oldV.set(this.v);

    for (let i = 0; i < this.u.length; i++) {
      if (!this.uBlocked[i]) this.u[i] += this.gravityX * dt;
    }
    for (let i = 0; i < this.v.length; i++) {
      if (!this.vBlocked[i]) this.v[i] += this.gravityY * dt;
    }

    this.solvePressure(dt);
    this.extrapolateVelocities();
    this.gridToParticle();
    this.advectParticles(dt);
  }
}

