import { FluidSimulation } from './fluid';
import { PhoneMotion } from './motion';
import { ScrollMotion } from './scroll';
import { createPhotoOverlay } from './photo';
import type { MotionStatus } from './motion';

const CANVAS_SIZE = 400;
const CENTER = CANVAS_SIZE / 2;
const HOUSING_RADIUS = 175;
const DISPLAY_RADIUS = 158;
// Physical LED counts, ordered from the bottom of the pendant to the top.
const LED_ROWS_BOTTOM_TO_TOP = [4, 8, 10, 12, 12, 14, 14, 14, 14, 12, 12, 10, 8, 4];
// Spread the specified rows toward the display border, retaining the reference
// photo's slightly lower placement and keeping every LED inside the circle.
const LED_SPACING_X = 22;
const LED_SPACING_Y = 21;
const LED_OFFSET_Y = 3;
const LED_WIDTH = 7;
const LED_HEIGHT = 14;
const LED_CORNER_RADIUS = 3.5;
const LED_ON_DENSITY = 3;
const LED_GLOW_SIZE = 48;
const FIXED_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 6;

// Shared by repeated copies of the Shopify bundle, without a global registry
// retaining removed blocks. The cleanup lives on its owning element only.
const instanceKey = Symbol.for('pendant-simulator.cleanup');
const motionControlsKey = Symbol.for('pendant-simulator.motion-controls');
const photoKey = Symbol.for('pendant-simulator.photo');
type SimulatorContainer = HTMLElement & {
  [instanceKey]?: () => void;
  [motionControlsKey]?: () => void;
  [photoKey]?: () => void;
};

function numberSetting(value: string | undefined, fallback: number, min: number, max: number) {
  const number = value === undefined || value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function updateVerticalOffset(container: HTMLElement, root: HTMLElement) {
  const percent = root.dataset.displayMode === 'photo' ? 0 :
    numberSetting(container.dataset.verticalOffset, 0, -10, 10);
  // CSS translateY(%) refers to the canvas itself. Use the enclosing block's
  // untransformed border-box height instead; translation does not change layout.
  const height = percent === 0 ? 0 :
    parseFloat(root.ownerDocument.defaultView!.getComputedStyle(root).height) || root.offsetHeight;
  root.style.setProperty('--pendant-offset-y', `${height * percent / 100}px`);
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
  root.style.setProperty('--pendant-radius-scale',
    String(numberSetting(container.dataset.radiusScale, 100, 50, 150) / 100));
  const adaptToContainer = container.dataset.sizeMode === 'container';
  root.dataset.sizeMode = adaptToContainer ? 'container' : 'fixed';
  root.style.setProperty('--pendant-padding',
    adaptToContainer ? `${numberSetting(container.dataset.containerPadding, 4, 0, 40)}%` : '16px');

  const headingText = container.dataset.heading ?? 'FLIP Fluid Pendant Simulator';
  let heading = root.querySelector<HTMLHeadingElement>('.pendant-simulator__heading');
  if (container.dataset.showHeading === 'false' || headingText.trim() === '') {
    heading?.remove();
  } else {
    if (!heading) {
      heading = container.ownerDocument.createElement('h2');
      heading.className = 'pendant-simulator__heading';
      root.prepend(heading);
    }
    heading.textContent = headingText;
  }
  const motionControls = root.querySelector<HTMLElement>('.pendant-simulator__motion-controls');
  if (motionControls) motionControls.hidden = container.dataset.showMotionControls === 'false';
  (container as SimulatorContainer)[motionControlsKey]?.();
  (container as SimulatorContainer)[photoKey]?.();
  updateVerticalOffset(container, root);
}

/** Mount one independent simulator. Repeated mounts return its existing cleanup. */
export function mountSimulator(container: HTMLElement): () => void {
  const host = container as SimulatorContainer;
  if (host[instanceKey]) return host[instanceKey];
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error('The simulator needs a browser window');

  const particleCount = Math.round(numberSetting(container.dataset.particleCount, 2000, 500, 10000));
  const fillLevel = numberSetting(container.dataset.fillLevel, 25, 10, 90) / 100;
  const gravityStrength = numberSetting(container.dataset.gravityStrength, 14, 1, 30);
  const width = numberSetting(container.dataset.displayWidth, 400, 200, 800);
  const root = doc.createElement('div');
  root.className = 'pendant-simulator';
  root.style.setProperty('--pendant-display-width', `${width}px`);
  root.innerHTML = `
    <canvas class="pendant-simulator__canvas" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}"
      aria-label="Interactive LED fluid pendant. Drag through the liquid to stir it."></canvas>
    <p class="pendant-simulator__hint">Drag through the liquid to stir it</p>
    <div class="pendant-simulator__motion-controls">
      <button class="pendant-simulator__motion-toggle" type="button" aria-pressed="false">Enable phone motion</button>
      <p class="pendant-simulator__motion-status" role="status"></p>
    </div>
  `;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable');
  const ctx: CanvasRenderingContext2D = context;
  const glowCanvas = doc.createElement('canvas');
  glowCanvas.width = glowCanvas.height = LED_GLOW_SIZE;
  const glowContext = glowCanvas.getContext('2d');
  let cachedGlowColor = '';
  const motionButton = root.querySelector<HTMLButtonElement>('button')!;
  const motionStatus = root.querySelector<HTMLParagraphElement>('[role="status"]')!;
  const hint = root.querySelector<HTMLParagraphElement>('.pendant-simulator__hint')!;
  let fluid: FluidSimulation | null = new FluidSimulation(1, particleCount, fillLevel);
  fluid.setGravity(0, gravityStrength);
  const motion = new PhoneMotion(view, gravityStrength, updateMotionStatus);
  const scrollMotion = new ScrollMotion(gravityStrength);
  let scrolledSinceFrame = false;
  const removers: (() => void)[] = [];
  let destroyed = false;
  let visible = !('IntersectionObserver' in view);
  let pageActive = true;
  let frameId: number | null = null;
  let lastTime = view.performance.now();
  let accumulator = 0;
  let controlsHidden: boolean | undefined;

  // Explicit removers also work in themes that use older event-listener shims.
  function listen(target: EventTarget, type: string, handler: (event: any) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  }

  // Capture also observes nested scrolling elements. Reading geometry and doing
  // physics stays in the visible instance's existing animation loop.
  listen(doc, 'scroll', () => {
    if (active() && container.dataset.reactToScrolling !== 'false') scrolledSinceFrame = true;
  }, { capture: true, passive: true });
  listen(view, 'resize', () => {
    scrollMotion.reset();
    scrolledSinceFrame = false;
    updateVerticalOffset(container, root);
  });

  function updateMotionStatus(status: MotionStatus) {
    const messages: Record<MotionStatus, string> = {
      off: 'Enable phone motion to tilt and shake the liquid.',
      requesting: 'Allow motion access in your browser.',
      'permission-required': 'Tap Enable phone motion to allow access.',
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
    const automatic = container.dataset.showMotionControls === 'false';
    const needsTap = automatic && !motion.enabled &&
      (status === 'permission-required' || status === 'error' || status === 'denied');
    hint.textContent = !automatic || status === 'off' ? 'Drag through the liquid to stir it' :
      status === 'denied' ? 'Motion access was denied. Tap the pendant to try again, or drag to stir.' :
      needsTap ? 'Tap the pendant to allow phone motion, or drag to stir.' : messages[status];
    if (needsTap) {
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'button');
      canvas.setAttribute('aria-label', 'Allow phone motion. Tap the pendant or press Enter or Space.');
    } else {
      canvas.removeAttribute('tabindex');
      canvas.removeAttribute('role');
      canvas.setAttribute('aria-label', 'Interactive LED fluid pendant. Drag through the liquid to stir it.');
    }
  }

  function syncMotionControls(force = false) {
    if (destroyed) return;
    const hidden = container.dataset.showMotionControls === 'false';
    if (!force && controlsHidden === hidden) return;
    controlsHidden = hidden;
    updateMotionStatus(motion.status);
    if (hidden) void motion.enable();
  }

  function enableAutomaticMotion() {
    if (!destroyed && container.dataset.showMotionControls === 'false' && !motion.enabled) {
      void motion.enable();
    }
  }

  updateMotionStatus(motion.status);
  listen(motionButton, 'click', () => {
    if (motion.enabled) motion.disable();
    else void motion.enable();
  });
  // A click carries touch activation; pointerdown may be too early on phones.
  listen(canvas, 'click', enableAutomaticMotion);
  listen(canvas, 'keydown', (event: KeyboardEvent) => {
    if (container.dataset.showMotionControls !== 'false' || motion.enabled || event.repeat ||
      (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    enableAutomaticMotion();
  });

  // --------------------------------------------------
  // LED positions
  // --------------------------------------------------

  interface LED {
    x: number;
    y: number;
    on: boolean;
  }

  const leds: LED[] = [];

  for (const [row, count] of LED_ROWS_BOTTOM_TO_TOP.entries()) {
    for (let x = 0; x < count; x++) {
      const dx = x - (count - 1) / 2;
      // Canvas y increases downward, so the first row has the largest y.
      const dy = (LED_ROWS_BOTTOM_TO_TOP.length - 1) / 2 - row;

      leds.push({
        x: dx * LED_SPACING_X / DISPLAY_RADIUS,
        y: (dy * LED_SPACING_Y + LED_OFFSET_Y) / DISPLAY_RADIUS,
        on: false,
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

  function drawLED(x: number, y: number, scale: number, color: string, target = ctx) {
    const left = x - LED_WIDTH * scale / 2;
    const right = x + LED_WIDTH * scale / 2;
    const top = y - LED_HEIGHT * scale / 2;
    const bottom = y + LED_HEIGHT * scale / 2;
    const corner = LED_CORNER_RADIUS * scale;
    // Explicit curves keep rounded LEDs available in the Safari 14 build target.
    target.beginPath();
    target.moveTo(left + corner, top);
    target.lineTo(right - corner, top);
    target.quadraticCurveTo(right, top, right, top + corner);
    target.lineTo(right, bottom - corner);
    target.quadraticCurveTo(right, bottom, right - corner, bottom);
    target.lineTo(left + corner, bottom);
    target.quadraticCurveTo(left, bottom, left, bottom - corner);
    target.lineTo(left, top + corner);
    target.quadraticCurveTo(left, top, left + corner, top);
    target.closePath();
    target.fillStyle = color;
    target.fill();
  }

  function prepareGlow(color: string) {
    if (!glowContext || cachedGlowColor === color) return;
    // Blur once per color change, then reuse the small transparent sprite.
    glowContext.clearRect(0, 0, LED_GLOW_SIZE, LED_GLOW_SIZE);
    glowContext.shadowColor = `rgb(${color})`;
    glowContext.shadowBlur = 16;
    drawLED(LED_GLOW_SIZE / 2, LED_GLOW_SIZE / 2, 1.35, `rgba(${color}, 0.95)`, glowContext);
    glowContext.shadowBlur = 7;
    drawLED(LED_GLOW_SIZE / 2, LED_GLOW_SIZE / 2, 1.1, `rgba(${color}, 0.9)`, glowContext);
    cachedGlowColor = color;
  }

  function render() {
    // Clear the previous frame so transparent mode exposes the theme behind the
    // round housing without changing the housing, display, or LED colors.
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    const photoMode = root.dataset.displayMode === 'photo';
    if (!photoMode && container.dataset.transparentBackground !== 'true') {
      ctx.fillStyle = '#080c12';
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }

    // Hiding the housing clears the ring even with an opaque canvas background.
    // The display below remains opaque; the ring exposes the block behind it.
    if (!photoMode) {
      if (container.dataset.showHousing === 'false') ctx.globalCompositeOperation = 'destination-out';
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
      ctx.globalCompositeOperation = 'source-over';
    }

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

    const green = container.dataset.ledColor === 'green';
    const glowColor = green ? '0, 255, 110' : '0, 190, 255';
    const coreColor = green ? '130, 255, 175' : '100, 220, 255';
    prepareGlow(glowColor);

    ctx.save();
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, DISPLAY_RADIUS, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';

    // Draw all halos first so neighboring glows cannot dim the opaque cores.
    for (const led of leds) {
      const density = sampleDensity(
        led.x,
        led.y
      );

      // Switch the LED at a fixed occupancy threshold; empty LEDs emit no light.
      led.on = density >= LED_ON_DENSITY;
      if (!led.on) continue;

      const px =
        CENTER + led.x * DISPLAY_RADIUS;

      const py =
        CENTER + led.y * DISPLAY_RADIUS;

      if (glowContext) ctx.drawImage(glowCanvas, px - LED_GLOW_SIZE / 2, py - LED_GLOW_SIZE / 2);
      else drawLED(px, py, 1.8, `rgba(${glowColor}, 0.45)`);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const led of leds) {
      // Keep off LEDs dark even where the wider halo from a neighbor overlaps.
      drawLED(CENTER + led.x * DISPLAY_RADIUS, CENTER + led.y * DISPLAY_RADIUS,
        1, led.on ? `rgb(${coreColor})` : '#02070b');
    }
    ctx.restore();
  }


  function active() { return !destroyed && visible && pageActive && !doc.hidden; }

  function schedule() {
    if (active() && frameId === null) frameId = view!.requestAnimationFrame(animate);
  }

  function animate(now: number) {
    frameId = null;
    if (!active() || !fluid) return;
    const elapsed = (now - lastTime) / 1000;
    const frameDt = Math.max(0, Math.min(elapsed, 0.05));
    lastTime = now;
    accumulator += frameDt;
    const acceleration = motion.sample(frameDt);
    let scroll = { x: 0, y: 0 };
    if (container.dataset.reactToScrolling !== 'false') {
      const rect = canvas.getBoundingClientRect();
      scroll = scrollMotion.sample({ x: rect.left, y: rect.top },
        rect.width / CANVAS_SIZE * DISPLAY_RADIUS, elapsed, scrolledSinceFrame);
    } else {
      // Drop queued inertia as well as new input. Re-enabling starts with a fresh
      // position baseline, without replacing the canvas or resetting the fluid.
      scrollMotion.reset();
    }
    scrolledSinceFrame = false;
    fluid.setGravity(acceleration.x + scroll.x, acceleration.y + scroll.y);
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
    scrollMotion.reset();
    scrolledSinceFrame = false;
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
  const sizeObserver = 'ResizeObserver' in view ? new view.ResizeObserver(() => {
    if (!destroyed) updateVerticalOffset(container, root);
  }) : null;
  listen(doc, 'visibilitychange', reconcileVisibility);
  listen(view, 'pagehide', () => {
    pageActive = false;
    motion.disable();
    reconcileVisibility();
  });
  listen(view, 'pageshow', () => {
    const resumed = !pageActive;
    pageActive = true;
    reconcileVisibility();
    if (resumed) syncMotionControls(true);
  });

  const photo = createPhotoOverlay(container, root, canvas, CANVAS_SIZE / (DISPLAY_RADIUS * 2), () => {
    releaseDrag();
    scrollMotion.reset();
    scrolledSinceFrame = false;
    updateVerticalOffset(container, root);
    render();
  });

  function cleanup() {
    if (destroyed) return;
    destroyed = true;
    if (frameId !== null) view!.cancelAnimationFrame(frameId);
    frameId = null;
    observer?.disconnect();
    sizeObserver?.disconnect();
    removers.forEach(remove => remove());
    releaseDrag();
    motion.disable();
    photo.dispose();
    fluid = null;
    leds.length = 0;
    canvas.width = canvas.height = 0;
    glowCanvas.width = glowCanvas.height = 0;
    root.remove();
    delete host[instanceKey];
    delete host[motionControlsKey];
    delete host[photoKey];
  }

  host[instanceKey] = cleanup;
  host[motionControlsKey] = syncMotionControls;
  host[photoKey] = photo.update;
  container.append(root);
  updateSimulatorAppearance(container);
  render();
  observer?.observe(container);
  sizeObserver?.observe(root, { box: 'border-box' });
  schedule();
  return cleanup;
}

/** Used by the custom element and Shopify editor before removing a block. */
export function unmountSimulator(container: HTMLElement) {
  (container as SimulatorContainer)[instanceKey]?.();
}
