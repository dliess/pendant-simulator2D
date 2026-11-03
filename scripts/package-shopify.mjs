import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { themeFiles } from './theme-files.mjs';

// A theme-file overlay, ready to copy into an existing Shopify theme. Keep the
// requested two-file browser build in dist/shopify as well.
await rm('dist/shopify-theme', { recursive: true, force: true });
for (const file of themeFiles) {
  const source = file.startsWith('assets/') ? file.replace('assets/', 'dist/shopify/') : file;
  const destination = `dist/shopify-theme/${file}`;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
console.log('Shopify theme files prepared in dist/shopify-theme/');
