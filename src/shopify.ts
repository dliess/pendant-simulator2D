import './style.css';
import { mountSimulator, unmountSimulator, updateSimulatorAppearance } from './simulator';

export { mountSimulator };

const tag = 'pendant-simulator';

// A block can load this asset more than once. Register editor listeners and
// the custom element once; the shared mount key also prevents duplicate UIs.
if (!customElements.get(tag)) {
  class PendantSimulatorElement extends HTMLElement {
    static get observedAttributes() {
      return ['data-heading', 'data-show-heading', 'data-display-width',
        'data-particle-count', 'data-fill-level', 'data-gravity-strength',
        'data-background-color', 'data-text-color', 'data-transparent-background',
        'data-react-to-scrolling', 'data-show-housing', 'data-led-color', 'data-radius-scale',
        'data-show-motion-controls', 'data-size-mode', 'data-container-padding', 'data-vertical-offset',
        'data-display-mode', 'data-photo-version', 'data-photo-center-x', 'data-photo-center-y', 'data-photo-diameter'];
    }

    connectedCallback() { mountSimulator(this); }
    disconnectedCallback() { unmountSimulator(this); }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
      if (!this.isConnected || oldValue === newValue) return;
      // The frame loop reads this input setting live, preserving fluid and sensors.
      if (name === 'data-react-to-scrolling') return;
      if (name === 'data-photo-version') {
        // Editor morphs can update attributes before replacing the image template.
        queueMicrotask(() => { if (this.isConnected) updateSimulatorAppearance(this); });
        return;
      }
      if (name === 'data-background-color' || name === 'data-text-color' || name === 'data-transparent-background'
        || name === 'data-show-housing' || name === 'data-led-color' || name === 'data-radius-scale'
        || name === 'data-heading' || name === 'data-show-heading' || name === 'data-show-motion-controls'
        || name === 'data-size-mode' || name === 'data-container-padding' || name === 'data-vertical-offset'
        || name === 'data-display-mode' || name === 'data-photo-center-x' || name === 'data-photo-center-y'
        || name === 'data-photo-diameter') {
        updateSimulatorAppearance(this);
        return;
      }
      unmountSimulator(this);
      mountSimulator(this);
    }
  }

  customElements.define(tag, PendantSimulatorElement);

  function visit(event: Event, action: (container: HTMLElement) => void) {
    const root = event.target;
    if (!(root instanceof HTMLElement)) return;
    if (root.matches(tag)) action(root);
    root.querySelectorAll<HTMLElement>(tag).forEach(action);
  }

  document.addEventListener('shopify:section:unload', event => visit(event, unmountSimulator));
  document.addEventListener('shopify:section:load', event => visit(event, container => {
    mountSimulator(container);
    updateSimulatorAppearance(container);
  }));
  // Custom-element connection callbacks also cover individual block replacement,
  // removal, reordering, and Section Rendering API updates without editor events.
}
