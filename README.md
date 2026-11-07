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
`@theme` blocks. Configure its heading, phone motion controls, background and text colors, housing,
LED color, size mode, container padding or display width/radius, fill height, particle count, gravity strength,
and **React to scrolling**. No standalone section, asset-loader snippet, layout
edit, or template edit is required. Sections that only support their own local block
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

## Align the simulator with a pendant photograph

In the Pendant simulator block, choose **Display mode → Overlay on pendant photo**
and select a **Pendant photo**. Remove the duplicate background photo from the
surrounding group; the simulator block now owns both the photograph and its display.

Calibrate three controls once:

- **Display center from left**: center position as a percentage of photo width.
- **Display center from top**: center position as a percentage of photo height.
- **Display diameter**: visible circular LED display diameter as a percentage of
  photo width, excluding the simulated housing and canvas margins.

For example, a display centered at 52% across and 60% down, with a diameter of 30%,
keeps those coordinates at desktop and phone widths. The full photo preserves its
original aspect ratio without cover cropping. Heading, instructions, and motion
controls sit outside the photo and cannot move the display within it. The simulator
adds only the circular LED display, leaving the photographed housing visible.
This assumes a front-facing circular display in the photo; perspective-distorted
or angled displays would need a different overlay shape.

The photo fills the block's available width. Legacy size mode, padding, radius,
housing, and vertical offset controls are hidden and ignored while a photo is
active. Switching to **Simulator only** restores their saved values. A missing or
failed photo falls back to the normal working simulator. Calibration and image
changes preserve the existing fluid, canvas, and phone permissions. Responsive
Shopify image candidates and lazy loading are included; no extra theme files are
required.

For a standalone embed, set `data-display-mode="photo"`, `data-photo-center-x`,
`data-photo-center-y`, and `data-photo-diameter` on the container and provide:

```html
<template data-pendant-simulator-photo>
  <img src="/pendant.jpg" width="1000" height="1400" alt="Pendant necklace">
</template>
```

Put the template inside the container before calling `mountSimulator`. For live
custom-element image changes, replace the template image and change
`data-photo-version` (for example, to the new image URL), or dispatch the existing
Shopify section-load event after updating its markup.

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
The **Particle count** dropdown offers 500 to 10,000 in 500-particle increments,
with a default of 2,000. A dropdown supports values beyond Shopify's range-slider
maximum, which must be below 10,000. Standalone mounts accept the same limits.

The default fill height is 25%, leaving headroom for splashes. The solver uses
85% FLIP and 15% PIC blending to preserve motion while retaining damping, and
stirring and grid-transfer speed limits share a value of 10 simulation units per
second. Gravity, pressure correction, and detached-drop handling keep their
existing behavior. Existing Shopify blocks retain their saved fill height; choose
25% in **Initial fill height** for the same headroom as a new block.

Background and text colors are per-instance settings. The default background is
`#101820`, with white text and a muted status message. Enable **Transparent
background** to expose the theme behind both the block panel and the canvas
outside the circular pendant. Turning it off restores the selected background
color and the original canvas background. Use a text color that contrasts with
the theme behind the transparent block. Appearance changes update in place,
preserving the current fluid state, pointer handlers, and motion permissions.

The heading is omitted entirely when empty, whitespace-only, or **Show heading**
is off, leaving no placeholder or gap. **Show phone motion controls** (on by
default) shows or hides the motion button and its status text together, without
reserving space when hidden. Turning this setting off automatically enables phone
motion, reusing access that has already been granted. If the browser requires an
initial user gesture, the hint asks the visitor to tap the pendant to grant access;
focusing the pendant and pressing Enter or Space also works. The button and status
group stay hidden. Denied access, missing sensors, and insecure pages keep useful
messages in the existing hint, and dragging remains available. Turning the controls
back on preserves any active motion input and restores the manual toggle. Heading
and control visibility changes preserve the canvas and fluid. Standalone embeds
can use an empty `data-heading` and `data-show-motion-controls="false"` for the same
behavior. Automatic mode also resumes after returning from a page-history cache.

**Show gray housing** (on by default) controls the metallic ring. Turning it off
makes the ring transparent while keeping the dark LED display visible. To expose
the theme behind the ring, also enable **Transparent background**; otherwise the
block's background shows through. **LED color** selects blue (default) or green,
including the LED glow. LEDs switch fully on or off based on local fluid density.
Lit cores use a brighter, fixed blue or green color. A strong, soft glow combines
a tight halo and a wider bloom that add light where they overlap. The glow stays
inside the circular display. Unlit LED cores remain dark even beside lit LEDs.
Cached glow sprites keep the blur work out of the animation loop, and all halos
render before the crisp cores, preserving the full on/off behavior.
Each LED is a rounded capsule, 14 units tall and 7 units wide, with a matching
glow. Both scale with the pendant.
The display has 148 LEDs in 14 centered rows. From bottom to top, the row counts
are 4, 8, 10, 12, 12, 14, 14, 14, 14, 12, 12, 10, 8, 4. The LED proportions and
slightly lower placement follow the `Futuristic Blue LED Pendant.png` reference,
with the grid spread outward for tighter border gaps. LED centers are 22 units
apart horizontally and 21 vertically, and the grid sits 3 units below the circle's
center. At the default 400-unit canvas size, the LED edges leave 17.5 units above
the top row, 11.5 below the bottom row, and 11.5 at either side of the dark display.
All LED cores fit inside the circle. These gaps scale with the pendant. The
explicit row counts take precedence over the AI reference's different LED count.

**Size mode → Set display size** is the default and preserves the existing
width/radius settings and 16px block padding. **Pendant radius** scales the pendant
and LEDs from 50% to 150% in 5% steps,
defaulting to 100%. It scales relative to **Maximum display width**: at 400px,
the canvas is 200px, 400px, or 600px wide at 50%, 100%, or 150%, respectively,
when space permits. It always fits within its container without clipping; heading
and controls retain their size. Pointer stirring and scroll input use the actual
displayed size. Standalone embeds use `data-show-housing="false"`,
`data-led-color="green"`, and `data-radius-scale="150"` on their container.

**Size mode → Adapt to container** fills the surrounding section or column's
available width while keeping the canvas square. **Container padding** appears
in this mode and sets space inside the block on all sides, from 0% to 40% in 1%
steps (4% by default). Each side is a percentage of the block's width, including
top and bottom padding, following CSS percentage padding. The canvas uses the width
left after padding, so a 600px block with 5% padding displays a 540px square canvas.
Previously saved padding numbers now represent percentages rather than pixels.
The canvas height follows its width; the parent does not need a fixed height.
Heading and controls retain their
normal text size. Maximum display width and Pendant radius are hidden and ignored
in this mode; switching back restores their saved values. Size mode and padding
update without resetting fluid or phone motion. Standalone embeds can use
`data-size-mode="container"` and `data-container-padding="5"`.

**Vertical center offset** moves only the pendant up or down, from -10% to +10%
of the enclosing simulator block's full height in 1% steps (0% by default).
Negative values move up; positive values move down. The heading, instructions,
controls, and block's layout height stay in place. The offset applies in either
size mode and is recalculated as the block resizes. It moves the canvas itself,
so the pendant stays intact and stirring follows its displayed position.
Standalone embeds use `data-vertical-offset="-5"`.

The `pendant-simulator` custom element mounts on connection and cleans up on
disconnection. Appearance updates change rendering and styles in place; scroll
reaction updates in place too. Other attribute updates
remount only that instance. Shopify section
load/unload events also mount and dispose the affected elements. This handles
editor block removal, replacement, and reordering, including when HTML is replaced
without an editor event.

Cleanup cancels animation, disconnects the visibility observer, removes event
listeners, releases pointer capture, disables sensor listeners and pending
permission requests, releases the canvas buffer, and removes the instance UI.
Offscreen blocks and hidden tabs do no animation or simulation work. Resuming
resets the clock so there is no catch-up burst. Browsers without
`IntersectionObserver` still pause when the page is hidden.

## Scroll motion

The block's **React to scrolling** checkbox turns scroll inertia on or off for
that instance (on by default). Changing it preserves the fluid, canvas, and phone
motion permissions. Turning it off clears pending scroll forces; the liquid keeps
its existing momentum and responds to gravity, dragging, and enabled phone motion.
Standalone embeds can opt out with `data-react-to-scrolling="false"` on their
container; omitting the attribute enables scroll inertia.

The force follows changes in the pendant's actual viewport
velocity, including movement inside nested scroll areas. Starting a downward
page scroll moves a normal pendant upward, pushing the liquid downward; stopping
produces an upward rebound. Steady scrolling produces no sustained extra force.
Sticky or fixed pendants react only while their position on screen changes.

Scroll input is smoothed, scaled to the displayed pendant size, and limited to
twice the configured gravity strength. It adds to downward gravity or enabled
phone motion; drag stirring continues to work. Layout shifts without scrolling
do not create impulses. Resizing, hiding, or moving the block offscreen resets
the scroll history, preventing a catch-up jolt when it becomes visible again.
No sensor permission or HTTPS is needed for scroll input.

## Phone motion

Tap **Enable phone motion**, then allow the browser's motion permission. Tilt,
shaking, portrait/landscape mapping, status messages, and disabling motion work
independently for each instance. Drag stirring remains available.

Sensor APIs require HTTPS (Shopify storefronts supply this) and permission from a
user gesture. Embedded cross-origin iframes may also need an appropriate
accelerometer/gyroscope Permissions Policy; this package embeds directly in the
theme rather than using an iframe. See the [device motion standard](https://www.w3.org/TR/orientation-event/).
Hardware behavior still needs verification on the target phones and storefront.
