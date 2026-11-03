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
npm run deploy:theme
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

Run this from `pendant-simulator2D`:

```sh
npm run deploy:theme
```

It builds the Shopify production bundle and deploys exactly these three files into
`../my-shopify-theme`, creating only their missing destination directories:

```text
assets/pendant-simulator.js
assets/pendant-simulator.css
blocks/pendant-simulator.liquid
```

To choose a different local destination, use:

```sh
npm run deploy:theme -- ../another-theme
npm run deploy:theme -- /path/to/my-shopify-theme
```

The default and relative arguments resolve from this project's directory. To build
without deploying, run `npm run build:shopify`; the same three files are packaged
under `dist/shopify-theme` for manual copying.

Open the desired product template in **Online Store → Themes → Customize**, then
choose **Add block → Pendant simulator** in an existing section that accepts native
`@theme` blocks. Configure its heading, display width, fill height, particle count,
and gravity strength. No standalone section, asset-loader snippet, layout edit,
or template edit is required. Sections that only support their own local block
types cannot accept an arbitrary native theme block; this deployment does not
modify existing sections to add support.

The CSS and JS asset-loading tags live directly in the block, inside an inert
`<template>`. Shopify's `{% javascript %}` hook is delivered once per block file
in its external `block-scripts.js`; it activates one stylesheet and one simulator
script per URL. Repeated instances, editor reloads, or dynamically added blocks
reuse those assets. This works when the first block is added to an initially empty
editor page, without inline JavaScript or `unsafe-eval`.
See [Shopify's bundled block JavaScript](https://shopify.dev/docs/storefronts/themes/best-practices/javascript-and-stylesheet-tags).

Deployment replaces only the three simulator-owned paths above. As a migration
from the previous integration, it also removes exactly these two obsolete files
when present:

```text
snippets/pendant-simulator-assets.liquid
sections/pendant-simulator.liquid
```

Other assets, sections, snippets, layouts, templates, merchant settings, locales,
and Git metadata remain untouched. Cleanup does not delete directories or search
for other files to remove. Repeated deployments are safe, and a failed build
prevents both copying and migration cleanup. Symlinked destinations are rejected.
Both repositories stay independent; nothing is uploaded or published to Shopify.

Run `npm run deploy:theme` after future simulator changes, then review and commit
changes separately in each repository. Shopify CDN URLs are supplied by the block;
there is no localhost dependency.

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
