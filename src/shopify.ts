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
        'data-react-to-scrolling'];
    }

    connectedCallback() { mountSimulator(this); }
    disconnectedCallback() { unmountSimulator(this); }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
      if (!this.isConnected || oldValue === newValue) return;
      // The frame loop reads this input setting live, preserving fluid and sensors.
      if (name === 'data-react-to-scrolling') return;
      if (name === 'data-background-color' || name === 'data-text-color' || name === 'data-transparent-background') {
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
  document.addEventListener('shopify:section:load', event => visit(event, mountSimulator));
  // Custom-element connection callbacks also cover individual block replacement,
  // removal, reordering, and Section Rendering API updates without editor events.
}
