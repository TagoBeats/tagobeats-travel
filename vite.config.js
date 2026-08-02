import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 2048,
    reportCompressedSize: true,
  },
  server: {
    host: true, // damit das iPhone im WLAN per lokaler IP draufkommt
    port: 5311,
  },
});
