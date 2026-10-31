import { defineConfig } from 'vite';
/** Standalone offline viewer: no development server or external model provider. */
export default defineConfig({
  build: { outDir: 'dist-field-lab', rollupOptions: { input: 'benchmarks/field-lab/runtime.html' } },
});
