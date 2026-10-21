import { defineConfig } from 'vite';

// GitHub Pages ではリポジトリ名のサブパスで配信されるため、BASE_PATH で切り替える
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: 'index.html',
        gallery: 'model-gallery.html',
      },
    },
  },
  server: { host: true, port: 5173 },
});
