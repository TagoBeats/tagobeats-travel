# Fotos hier reinziehen

Ein Unterordner pro Ort oder Trip. Der Ordnername wird zur Headline auf der Seite.

```
media/photos/
  San Antonio/
    IMG_0412.jpg
    IMG_0455.jpg
  New Orleans/
  NYC/
```

Originale in voller Auflösung reinziehen ist genau richtig, das Script rechnet runter.
Formate: jpg, jpeg, png, heic, webp, tif.

Danach im Projektordner:

```
npm run media
```

Das erzeugt AVIF/WebP in vier Größen, Thumbnails, Blur-Platzhalter und die `manifest.json`.
Bereits verarbeitete Bilder werden übersprungen, also ruhig oft laufen lassen.

## Reihenfolge

Standard ist das Aufnahmedatum aus den EXIF-Daten. Wenn du selbst sortieren willst,
leg eine `order.txt` in den Album-Ordner, eine Dateiname pro Zeile:

```
IMG_0455.jpg
IMG_0412.jpg
```

Nicht gelistete Bilder hängen sich hinten nach Datum an.

## Bildunterschrift

Optional eine `captions.txt` im Album-Ordner, Format `Dateiname = Text`:

```
IMG_0412.jpg = Sonnenuntergang am River Walk
```
