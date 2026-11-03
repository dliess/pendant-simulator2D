# Pendant simulator

The same FLIP physics, LED renderer, drag stirring, and phone motion controls run
in standalone development and Shopify. `src/fluid.ts` is unchanged by the Shopify
packaging refactor. No npm packages are needed at runtime in the storefront.

## Development and builds

```sh
npm install
npm run dev
npm test
npm run test:browser
npm run build
npm run build:shopify
```

`npm run dev` serves the standalone application. `npm run build` produces it in
`dist/standalone`, and `npm run preview` serves that directory. Keeping this output
separate means a standalone build does not erase the Shopify assets.

`npm run build:shopify` creates:

```text
dist/shopify/
  pendant-simulator.js
  pendant-simulator.css

dist/shopify-theme/
  assets/pendant-simulator.js
  assets/pendant-simulator.css
  blocks/pendant-simulator.liquid
  sections/pendant-simulator.liquid
  snippets/pendant-simulator-assets.liquid
```

The JS is a self-contained IIFE exposing `window.PendantSimulator.mountSimulator`.
There are no imports from a dev server, external runtime dependencies, injected
inline scripts, or `eval` requirements. CSS is scoped to the simulator; standalone
page styling is in `src/dev.css` and is excluded from the Shopify build.

`npm run check:shopify` rebuilds and checks the browser assets and packaged copies.
The tests use Node's built-in TypeScript support (Node 22.18+).
`npm run test:browser` builds both variants and runs headless Chrome integration
checks under a strict CSP. Install Chrome or set `CHROME_PATH` to its executable.

## Install into a Shopify theme

1. Run `npm run build:shopify`.
2. Copy the five files from `dist/shopify-theme` into the matching `assets`,
   `blocks`, `sections`, and `snippets` directories of your existing theme. This directory
   contains additions to a theme, not a complete standalone Shopify theme.
3. In `layout/theme.liquid`, add the following before `</head>` so the editor
   loads the component even on a page that initially has no simulator blocks:

   ```liquid
   {% if request.design_mode %}
     {% render 'pendant-simulator-assets' %}
   {% endif %}
   ```

   This is a Liquid include of external assets, with no inline JavaScript.
   You can also render the snippet unconditionally once in the layout if your
   storefront inserts simulator blocks dynamically outside the theme editor.
4. In **Online Store → Themes → Customize**, open the desired **product template**.
5. If its product section supports native theme blocks, use **Add block → Pendant
   simulator** there. Otherwise, use **Add section → Pendant simulator**: the
   supplied product-page section already contains the simulator block.
6. Configure the heading, heading visibility, maximum display width, initial fill
   height, particle count, and gravity strength. Save the template.

Copy new JS and CSS assets again after changing the simulator. Use Shopify's
asset URLs as supplied by the Liquid block; there is no localhost dependency.
The block loads its own external stylesheet and deferred script, and can appear
multiple times on a page. Repeated asset execution does not duplicate mounts or
editor event listeners.

Native theme blocks are available in sections that accept `@theme` blocks and
render `{% content_for 'blocks' %}`. An older theme's local product blocks cannot
automatically accept an arbitrary file from `blocks/`; the included section is
the alternative. See [Shopify theme blocks](https://shopify.dev/docs/storefronts/themes/architecture/blocks/theme-blocks)
and [editor lifecycle events](https://shopify.dev/docs/storefronts/themes/best-practices/editor/integrate-sections-and-blocks).

## Mount API and lifecycle

```ts
import { mountSimulator } from './src/simulator';

const cleanup = mountSimulator(container);
// When your application removes the embed:
cleanup();
```

Supply an `HTMLElement`; the mount function appends only its own UI and queries
only that UI. Repeated calls for the same element return the existing cleanup.
Different elements have independent fluid state, canvas, drag capture, animation,
and motion permission/status controls. Optional `data-*` settings use the same
values as the Liquid block; `data-fill-level` is a percentage of initial fill
height, not an area fraction.

The `pendant-simulator` custom element mounts on connection and cleans up on
disconnection. Attribute updates remount only that instance. Shopify section
load/unload events also mount and dispose the affected elements. This handles
editor block removal, replacement, and reordering, including when HTML is replaced
without an editor event.

Cleanup cancels animation, disconnects the visibility observer, removes event
listeners, releases pointer capture, disables sensor listeners and pending
permission requests, releases the canvas buffer, and removes the instance UI.
Offscreen blocks and hidden tabs do no animation or simulation work. Resuming
resets the clock so there is no catch-up burst. Browsers without
`IntersectionObserver` still pause when the page is hidden.

## Phone motion

Tap **Enable phone motion**, then allow the browser's motion permission. Tilt,
shaking, portrait/landscape mapping, status messages, and disabling motion work
independently for each instance. Drag stirring remains available.

Sensor APIs require HTTPS (Shopify storefronts supply this) and permission from a
user gesture. Embedded cross-origin iframes may also need an appropriate
accelerometer/gyroscope Permissions Policy; this package embeds directly in the
theme rather than using an iframe. See the [device motion standard](https://www.w3.org/TR/orientation-event/).
Hardware behavior still needs verification on the target phones and storefront.
