import { copyFile, mkdir } from 'node:fs/promises';

// A theme-file overlay, ready to copy into an existing Shopify theme. Keep the
// requested two-file browser build in dist/shopify as well.
for (const directory of ['assets', 'blocks', 'sections', 'snippets']) {
  await mkdir(`dist/shopify-theme/${directory}`, { recursive: true });
}
for (const filename of ['pendant-simulator.js', 'pendant-simulator.css']) {
  await copyFile(`dist/shopify/${filename}`, `dist/shopify-theme/assets/${filename}`);
}
for (const directory of ['blocks', 'sections']) {
  await copyFile(`${directory}/pendant-simulator.liquid`, `dist/shopify-theme/${directory}/pendant-simulator.liquid`);
}
await copyFile('snippets/pendant-simulator-assets.liquid', 'dist/shopify-theme/snippets/pendant-simulator-assets.liquid');
console.log('Shopify theme files prepared in dist/shopify-theme/');
