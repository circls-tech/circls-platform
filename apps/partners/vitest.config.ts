import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The `@/…` alias tsconfig gives the app. Without it a test can only import
  // modules whose whole import graph avoids it, which quietly rules out
  // testing anything that touches shared lib code.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.{ts,tsx}'],
  },
});
