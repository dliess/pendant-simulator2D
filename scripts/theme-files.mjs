// Only these simulator-owned paths may be installed into another repository.
export const themeFiles = Object.freeze([
  'assets/pendant-simulator.js',
  'assets/pendant-simulator.css',
  'blocks/pendant-simulator.liquid',
]);

// Exact, simulator-owned legacy paths to remove during the block-only migration.
// Never delete a directory or infer obsolete files from its other contents.
export const obsoleteThemeFiles = Object.freeze([
  'snippets/pendant-simulator-assets.liquid',
  'sections/pendant-simulator.liquid',
]);
