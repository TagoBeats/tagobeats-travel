# TagoBeats Travel

Reisefoto-Galerie mit eigenen Beats im Hintergrund. Statische Seite, kein Framework,
mobile zuerst gebaut.

## Der Alltag: neue Fotos oder Beats hochziehen

1. Bilder in einen Unterordner von `media/photos/` ziehen. Der Ordnername wird zur
   Headline auf der Seite, also `media/photos/New Orleans/` heisst auf der Seite
   NEW ORLEANS. Originale in voller Aufloesung sind genau richtig.
2. Beats flach in `media/beats/` ziehen. Der Dateiname wird zum Titel.
3. Im Projektordner:

```
npm run media
npm run dev
```

`npm run media` rechnet alles klein und schreibt `public/m/manifest.json`.
Bereits verarbeitete Dateien werden uebersprungen, der Befehl laeuft also schnell,
auch wenn nur ein Bild dazugekommen ist. `npm run media:force` rechnet alles neu.

Details zu Reihenfolge, Bildunterschriften und BeatStars-Links stehen in
`media/photos/README.md` und `media/beats/README.md`.

**Im Browser immer ueber `http://localhost` testen, nie die HTML-Datei direkt oeffnen.**
Fuers Handy im gleichen WLAN gibt `npm run dev` eine Network-Adresse aus, die geht direkt.

## Was das Media-Script macht

Pro Foto: AVIF und WebP in bis zu vier Breiten (480/960/1600/2400), ein JPEG als
Rueckfalloption, ein Thumbnail fuer den Filmstreifen und ein 24 Pixel breiter
Blur-Platzhalter, der als Base64 direkt im Manifest liegt. Dazu Aufnahmedatum,
Kamera, GPS und die dominante Bildfarbe fuer den Glow hinter dem Foto.

Pro Beat: Transkodierung nach 128 kbps AAC mit Lautheitsangleichung auf -16 LUFS,
damit kein Beat rausspringt. Braucht `ffmpeg` im Pfad.

Die Dateinamen der Derivate tragen einen Hash des Originalinhalts. Dadurch koennen sie
ein Jahr lang unveraendert gecached werden, und ein nachbearbeitetes Foto bekommt
automatisch eine neue URL. Derivate, auf die nichts mehr zeigt, raeumt das Script weg.

## Aufbau

```
media/photos/   Originale, liegen nicht im Git
media/beats/    Originale, liegen nicht im Git
public/m/       generierte Derivate plus manifest.json, liegen im Git
src/
  main.ts       Ablauf: Manifest laden, Loader, Enter-Tap, Galerie, Audio
  loader.ts     Ladebalken und Enter-Screen
  gallery.ts    Slides, Filmstreifen, Navigation, Lazy-Fenster
  audio.ts      Playlist, Crossfade, Mute, Lockscreen-Metadaten
  styles.css    Design-Tokens und Layout
```

## Entscheidungen, die nicht offensichtlich sind

- **Kein `dc-runtime`.** Das Runtime der Hauptseite frisst Boolean-Attribute, killt
  direkt gebundene Listener nach der Hydration und kostet 60 KB. Fuer eine Galerie
  mit Wisch-Gesten waere das nur Aerger.
- **Der Ton startet erst nach dem Tap auf den Enter-Screen.** iOS blockt Autoplay,
  daran fuehrt kein Weg vorbei. Der Tap ist die Geste, die den Ton freischaltet.
- **Vor dem Tap wird vom Beat nur der Header geladen.** Mit `preload="auto"` zieht der
  erste Beat zwei Megabyte, blockiert die Bilder und schiebt den LCP auf Mobilfunk um
  Sekunden nach hinten.
- **Touch wird nirgends abgefangen.** Gewischt wird ueber natives `scroll-snap`.
  Ein eigener Touch-Handler hat den Instagram-Webview schon einmal einfrieren lassen.
- **Der Blur-Platzhalter liegt als `background-size: contain` auf dem Slide**, nicht als
  Kasten mit `aspect-ratio`. Bei einem Kasten klemmt `max-width` nur die Breite, die
  Hoehe bleibt stehen, und das Bild wird verzerrt.
- **Kein Crossfade auf iOS.** Dort ist `volume` schreibgeschuetzt. Das Script erkennt
  das und schneidet stattdessen hart. Web Audio waere die Alternative, riskiert aber
  auf iOS den Ton komplett.
- **`?enter` in der URL** ueberspringt den Tap. Nur fuer Screenshots und Debugging,
  ohne echte Geste bleibt es stumm.

## Deploy

Statische Seite, `npm run build` erzeugt `dist/`. Auf Vercel als Projekt ohne Framework
anlegen, Build Command `npm run build`, Output `dist`. `vercel.json` setzt die
Cache-Header: ein Jahr fuer Medien, Fonts und Assets, Revalidierung fuer HTML und
Manifest. Die Domain ist noch nicht entschieden.

## Messwerte

Lighthouse gegen `npm run preview`, Stand 02.08.2026 mit 13 Demo-Bildern:
Mobile 99, Desktop 100, CLS 0, LCP 2,0 s simuliertes Slow-4G, 254 KB Gesamtgewicht.
JS-Bundle 3,8 KB gzip.
