import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Script } from 'node:vm';

const files = ['pendant-simulator.css', 'pendant-simulator.js'];
assert.deepEqual(readdirSync('dist/shopify').sort(), files);
const js = readFileSync('dist/shopify/pendant-simulator.js', 'utf8');
new Script(js); // A classic browser script, with no ESM-only imports or exports.
assert.doesNotMatch(js, /localhost|127\.0\.0\.1|@vite\/client|import\.meta|\beval\s*\(|new Function\s*\(/);
for (const filename of files) {
  assert.deepEqual(readFileSync(`dist/shopify/${filename}`), readFileSync(`dist/shopify-theme/assets/${filename}`));
}
for (const directory of ['blocks', 'sections']) {
  assert.deepEqual(readFileSync(`${directory}/pendant-simulator.liquid`),
    readFileSync(`dist/shopify-theme/${directory}/pendant-simulator.liquid`));
}
assert.deepEqual(readFileSync('snippets/pendant-simulator-assets.liquid'),
  readFileSync('dist/shopify-theme/snippets/pendant-simulator-assets.liquid'));
console.log('Shopify build verified: classic JS, fixed filenames, no dev URLs/eval, matching theme files.');
