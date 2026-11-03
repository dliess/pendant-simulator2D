import { FluidSimulation } from './fluid';
import { PhoneMotion } from './motion';
import type { MotionStatus } from './motion';

const CANVAS_SIZE = 400;
const CENTER = CANVAS_SIZE / 2;
const HOUSING_RADIUS = 175;
const DISPLAY_RADIUS = 158;
const GRID_SIZE = 16;
const LED_SPACING = 19;
const LED_RADIUS = 6;
const FIXED_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 6;

// Shared by repeated copies of the Shopify bundle, without a global registry
// retaining removed blocks. The cleanup lives on its owning element only.
const instanceKey = Symbol.for('pendant-simulator.cleanup');
type SimulatorContainer = HTMLElement & { [instanceKey]?: () => void };

function numberSetting(value: string | undefined, fallback: number, min: number, max: number) {
  const number = value === undefined || value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

/** Apply visual settings without replacing an instance or resetting its fluid. */
export function updateSimulatorAppearance(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>(':scope > .pendant-simulator');
  const view = container.ownerDocument.defaultView;
  if (!root || !view) return;
  const color = (value: string | undefined, fallback: string) =>
    value && view.CSS.supports('color', value) ? value : fallback;
  const background = container.dataset.transparentBackground === 'true'
    ? 'transparent' : color(container.dataset.backgroundColor, '#101820');
  const foreground = color(container.dataset.textColor, '#ffffff');
  root.style.setProperty('--pendant-background-color', background);
  root.style.setProperty('--pendant-text-color', foreground);
  root.style.setProperty('--pendant-status-color',
    foreground.toLowerCase() === '#ffffff' ? '#a6b4c4' : foreground);
}

/** Mount one independent simulator. Repeated mounts return its existing cleanup. */
export function mountSimulator(container: HTMLElement): () => void {
  const host = container as SimulatorContainer;
  if (host[instanceKey]) return host[instanceKey];
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error('The simulator needs a browser window');

  const particleCount = Math.round(numberSetting(container.dataset.particleCount, 2000, 500, 3000));
  const fillLevel = numberSetting(container.dataset.fillLevel, 30, 10, 90) / 100;
  const gravityStrength = numberSetting(container.dataset.gravityStrength, 14, 1, 30);
  const width = numberSetting(container.dataset.displayWidth, 400, 200, 800);
  const root = doc.createElement('div');
  root.className = 'pendant-simulator';
  root.style.setProperty('--pendant-display-width', `${width}px`);
  root.innerHTML = `
    <h2 class="pendant-simulator__heading"></h2>
    <canvas class="pendant-simulator__canvas" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}"
      aria-label="Interactive LED fluid pendant. Drag through the liquid to stir it."></canvas>
    <p class="pendant-simulator__hint">Drag through the liquid to stir it</p>
    <div class="pendant-simulator__motion-controls">
      <button class="pendant-simulator__motion-toggle" type="button" aria-pressed="false">Enable phone motion</button>
      <p class="pendant-simulator__motion-status" role="status"></p>
    </div>
  `;
  const heading = root.querySelector<HTMLHeadingElement>('.pendant-simulator__heading')!;
  heading.textContent = container.dataset.heading ?? 'FLIP Fluid Pendant Simulator';
  heading.hidden = container.dataset.showHeading === 'false' || heading.textContent === '';
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable');
  const ctx: CanvasRenderingContext2D = context;
  const motionButton = root.querySelector<HTMLButtonElement>('button')!;
  const motionStatus = root.querySelector<HTMLParagraphElement>('[role="status"]')!;
  let fluid: FluidSimulation | null = new FluidSimulation(1, particleCount, fillLevel);
  fluid.setGravity(0, gravityStrength);
  const motion = new PhoneMotion(view, gravityStrength, updateMotionStatus);
  const removers: (() => void)[] = [];
  let destroyed = false;
  let visible = !('IntersectionObserver' in view);
  let pageActive = true;
  let frameId: number | null = null;
  let lastTime = view.performance.now();
  let accumulator = 0;

  // Explicit removers also work in themes that use older event-listener shims.
  function listen(target: EventTarget, type: string, handler: (event: any) => void) {
    target.addEventListener(type, handler);
    removers.push(() => target.removeEventListener(type, handler));
  }

  function updateMotionStatus(status: MotionStatus) {
    const messages: Record<MotionStatus, string> = {
      off: 'Enable phone motion to tilt and shake the liquid.',
      requesting: 'Allow motion access in your browser.',
      waiting: 'Move or tilt your phone to start.',
      active: 'Tilt and shake your phone, or drag to stir.',
      'no-data': 'No sensor readings yet. You can still drag to stir.',
      denied: 'Motion access was denied. You can still drag to stir.',
      unavailable: 'Phone motion is unavailable here. Drag to stir.',
      insecure: 'Open this page over HTTPS to use phone motion.',
      error: 'Could not enable motion. Try again, or drag to stir.',
    };
    motionButton.textContent = motion.enabled ? 'Disable phone motion' : 'Enable phone motion';
    motionButton.disabled = status === 'requesting' || status === 'unavailable' || status === 'insecure';
    motionButton.setAttribute('aria-pressed', String(motion.enabled));
    motionStatus.textContent = messages[status];
  }

  updateMotionStatus(motion.status);
  listen(motionButton, 'click', () => {
    if (motion.enabled) motion.disable();
    else void motion.enable();
  });

  // --------------------------------------------------
  // LED positions
  // --------------------------------------------------

  interface LED {
    x: number;
    y: number;
  }

  const leds: LED[] = [];

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const dx = x - (GRID_SIZE - 1) / 2;
      const dy = y - (GRID_SIZE - 1) / 2;

      // Approximate the pendant's rounded display.
      if (Math.hypot(dx, dy) > 7.6) {
        continue;
      }

      leds.push({
        x: dx * LED_SPACING / DISPLAY_RADIUS,
        y: dy * LED_SPACING / DISPLAY_RADIUS
      });
    }
  }

  // --------------------------------------------------
  // Mouse and touch stirring
  // --------------------------------------------------

  interface DragPoint {
    pointerId: number;
    x: number;
    y: number;
    time: number;
  }

  let dragPoint: DragPoint | null = null;

  function pointerPosition(event: PointerEvent): DragPoint {
    const rect = canvas.getBoundingClientRect();

    return {
      pointerId: event.pointerId,
      x: ((event.clientX - rect.left) / rect.width * CANVAS_SIZE - CENTER) / DISPLAY_RADIUS,
      y: ((event.clientY - rect.top) / rect.height * CANVAS_SIZE - CENTER) / DISPLAY_RADIUS,
      time: event.timeStamp,
    };
  }

  listen(canvas, 'pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || dragPoint !== null) return;
    dragPoint = pointerPosition(event);
    canvas.setPointerCapture(event.pointerId);
  });

  listen(canvas, 'pointermove', (event: PointerEvent) => {
    if (!fluid || dragPoint?.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      endDrag(event);
      return;
    }

    const next = pointerPosition(event);
    fluid.dragParticles(
      dragPoint.x, dragPoint.y,
      next.x, next.y,
      Math.max(0.001, (next.time - dragPoint.time) / 1000)
    );
    dragPoint = next;
  });

  function endDrag(event: PointerEvent) {
    if (dragPoint?.pointerId !== event.pointerId) return;
    dragPoint = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  listen(canvas, 'pointerup', endDrag);
  listen(canvas, 'pointercancel', endDrag);
  listen(canvas, 'lostpointercapture', endDrag);

  // --------------------------------------------------
  // LED density sampling
  // --------------------------------------------------

  function sampleDensity(x: number, y: number): number {
    if (!fluid) return 0;
    let density = 0;

    const influenceRadius = 0.14;
    const radiusSquared =
      influenceRadius * influenceRadius;

    for (const p of fluid.particles) {
      const dx = p.x - x;
      const dy = p.y - y;

      const r2 = dx * dx + dy * dy;

      if (r2 >= radiusSquared) {
        continue;
      }

      const q = 1 - r2 / radiusSquared;

      density += q * q;
    }

    return density;
  }

  // --------------------------------------------------
  // Rendering
  // --------------------------------------------------

  function render() {
    // Clear the previous frame so transparent mode exposes the theme behind the
    // round housing without changing the housing, display, or LED colors.
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    if (container.dataset.transparentBackground !== 'true') {
      ctx.fillStyle = '#080c12';
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }

    // Metallic pendant housing
    ctx.beginPath();
    ctx.arc(
      CENTER,
      CENTER,
      HOUSING_RADIUS,
      0,
      Math.PI * 2
    );

    ctx.fillStyle = '#596574';
    ctx.fill();

    // Dark LED display
    ctx.beginPath();
    ctx.arc(
      CENTER,
      CENTER,
      DISPLAY_RADIUS,
      0,
      Math.PI * 2
    );

    ctx.fillStyle = '#02070b';
    ctx.fill();

    // Render LED matrix
    for (const led of leds) {
      const density = sampleDensity(
        led.x,
        led.y
      );

      // Lower coefficient because FLIP uses
      // many more particles than our old PBF solver.
      const brightness =
        1 - Math.exp(-density * 0.06);

      const px =
        CENTER + led.x * DISPLAY_RADIUS;

      const py =
        CENTER + led.y * DISPLAY_RADIUS;

      // LED glow
      if (brightness > 0.15) {
        ctx.beginPath();
        ctx.arc(
          px,
          py,
          LED_RADIUS * 1.8,
          0,
          Math.PI * 2
        );

        ctx.fillStyle =
          `rgba(0, 140, 255, ${brightness * 0.12})`;

        ctx.fill();
      }

      // LED core
      ctx.beginPath();
      ctx.arc(
        px,
        py,
        LED_RADIUS,
        0,
        Math.PI * 2
      );

      ctx.fillStyle =
        `rgba(0, 190, 255, ${0.025 + brightness * 0.975})`;

      ctx.fill();
    }
  }


  function active() { return !destroyed && visible && pageActive && !doc.hidden; }

  function schedule() {
    if (active() && frameId === null) frameId = view!.requestAnimationFrame(animate);
  }

  function animate(now: number) {
    frameId = null;
    if (!active() || !fluid) return;
    const frameDt = Math.max(0, Math.min((now - lastTime) / 1000, 0.05));
    lastTime = now;
    accumulator += frameDt;
    const acceleration = motion.sample(frameDt);
    fluid.setGravity(acceleration.x, acceleration.y);
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      fluid.update(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
    render();
    schedule();
  }

  function releaseDrag() {
    const pointerId = dragPoint?.pointerId;
    dragPoint = null;
    if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  }

  function reconcileVisibility() {
    lastTime = view!.performance.now();
    accumulator = 0;
    if (!active()) {
      if (frameId !== null) view!.cancelAnimationFrame(frameId);
      frameId = null;
      releaseDrag();
    } else schedule();
  }

  const observer = 'IntersectionObserver' in view ? new view.IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0);
    reconcileVisibility();
  }) : null;
  listen(doc, 'visibilitychange', reconcileVisibility);
  listen(view, 'pagehide', () => {
    pageActive = false;
    motion.disable();
    reconcileVisibility();
  });
  listen(view, 'pageshow', () => { pageActive = true; reconcileVisibility(); });

  function cleanup() {
    if (destroyed) return;
    destroyed = true;
    if (frameId !== null) view!.cancelAnimationFrame(frameId);
    frameId = null;
    observer?.disconnect();
    removers.forEach(remove => remove());
    releaseDrag();
    motion.disable();
    fluid = null;
    leds.length = 0;
    canvas.width = canvas.height = 0;
    root.remove();
    delete host[instanceKey];
  }

  host[instanceKey] = cleanup;
  container.append(root);
  updateSimulatorAppearance(container);
  render();
  observer?.observe(container);
  schedule();
  return cleanup;
}

/** Used by the custom element and Shopify editor before removing a block. */
export function unmountSimulator(container: HTMLElement) {
  (container as SimulatorContainer)[instanceKey]?.();
}
