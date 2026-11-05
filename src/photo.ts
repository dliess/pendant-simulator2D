/** Keep the photographed pendant and its interactive display in image coordinates. */
export function createPhotoOverlay(
  container: HTMLElement,
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  canvasToDisplayRatio: number,
  onLayoutChange: () => void,
) {
  const doc = container.ownerDocument;
  const stage = doc.createElement('div');
  stage.className = 'pendant-simulator__photo-stage';
  const display = doc.createElement('div');
  display.className = 'pendant-simulator__photo-display';
  stage.append(display);
  root.style.setProperty('--pendant-photo-canvas-width', `${canvasToDisplayRatio * 100}%`);
  const imageAttributes = ['width', 'height', 'alt', 'loading', 'decoding', 'fetchpriority', 'sizes', 'srcset', 'src'];
  let image: HTMLImageElement | null = null;
  let sourceKey = '';
  let failedSource = '';
  let geometryKey = '';
  let removeImageListener = () => {};

  function releaseImage() {
    removeImageListener();
    removeImageListener = () => {};
    image?.removeAttribute('srcset');
    image?.removeAttribute('src');
    image?.remove();
    image = null;
    sourceKey = '';
  }

  function showSimulator() {
    if (stage.parentElement === root) root.insertBefore(canvas, stage);
    stage.remove();
    root.dataset.displayMode = 'simulator';
  }

  function update() {
    const template = container.querySelector<HTMLTemplateElement>(':scope > template[data-pendant-simulator-photo]');
    const source = template?.content.querySelector('img');
    const wantsPhoto = container.dataset.displayMode === 'photo';
    const key = wantsPhoto && source?.getAttribute('src')
      ? JSON.stringify(imageAttributes.map(attribute => source.getAttribute(attribute))) : '';
    const percent = (value: string | undefined, fallback: number, min: number) => {
      const number = value?.trim() ? Number(value) : NaN;
      return Number.isFinite(number) ? Math.max(min, Math.min(100, number)) : fallback;
    };
    const x = percent(container.dataset.photoCenterX, 50, 0);
    const y = percent(container.dataset.photoCenterY, 60, 0);
    const diameter = percent(container.dataset.photoDiameter, 30, 5);
    root.style.setProperty('--pendant-photo-x', `${x}%`);
    root.style.setProperty('--pendant-photo-y', `${y}%`);
    root.style.setProperty('--pendant-photo-diameter', `${diameter}%`);

    if (!wantsPhoto) failedSource = '';
    if (!key || key === failedSource) {
      showSimulator();
      releaseImage();
    } else {
      if (key !== sourceKey) {
        releaseImage();
        const nextImage = doc.createElement('img');
        nextImage.className = 'pendant-simulator__photo';
        nextImage.alt = '';
        const onError = () => {
          if (image !== nextImage) return;
          failedSource = key;
          update();
        };
        nextImage.addEventListener('error', onError);
        removeImageListener = () => nextImage.removeEventListener('error', onError);
        // Responsive candidates and intrinsic dimensions precede src, avoiding
        // a needless initial download and reserving the photo's full aspect ratio.
        for (const attribute of imageAttributes) {
          const value = source!.getAttribute(attribute);
          if (value !== null) nextImage.setAttribute(attribute, value);
        }
        image = nextImage;
        sourceKey = key;
        stage.prepend(nextImage);
      }
      if (stage.parentElement !== root) root.insertBefore(stage, canvas);
      if (canvas.parentElement !== display) display.append(canvas);
      root.dataset.displayMode = 'photo';
    }
    const nextGeometry = `${root.dataset.displayMode}:${key}:${x}:${y}:${diameter}`;
    if (nextGeometry !== geometryKey) {
      geometryKey = nextGeometry;
      onLayoutChange();
    }
  }

  return {
    update,
    dispose() {
      releaseImage();
      stage.remove();
    },
  };
}
