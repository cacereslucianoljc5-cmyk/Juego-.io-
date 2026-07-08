import { defineConfig } from 'vite';
import typegpu from 'unplugin-typegpu/vite';

// Base relativa para que funcione bajo subdirectorios (GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [typegpu()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
