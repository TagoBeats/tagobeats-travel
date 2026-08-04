import { defineConfig } from 'vite';

export default defineConfig({
  /*
   * Die Galerie haengt unter tagobeats.com/travel, nicht auf einer eigenen Domain.
   * Vite zieht damit die Referenzen in index.html und die url() in der CSS selbst nach.
   * Pfade, die als Zeichenkette im JavaScript oder im Manifest stehen, tut es nicht:
   * die werden ueber import.meta.env.BASE_URL zusammengesetzt, siehe main.ts.
   */
  base: '/travel/',
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
