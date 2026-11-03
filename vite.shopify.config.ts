import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/shopify',
    emptyOutDir: true,
    target: ['es2020', 'safari14'],
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: 'src/shopify.ts',
      name: 'PendantSimulator',
      formats: ['iife'],
      fileName: () => 'pendant-simulator.js',
      cssFileName: 'pendant-simulator',
    },
  },
});
