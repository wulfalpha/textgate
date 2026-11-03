import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Cargo builds into target/ inside the project root. On Windows the
    // executable being built is locked, and watching it crashes the dev server
    // with EBUSY. Nothing there is frontend source.
    watch: { ignored: ['**/target/**'] },
  },
});
