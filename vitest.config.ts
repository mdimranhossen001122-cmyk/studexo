import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src/client'),
      '@server': path.resolve(import.meta.dirname, 'src/server'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
