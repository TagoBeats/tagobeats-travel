# Beats hier reinziehen

Einfach die Dateien in diesen Ordner legen, flach, keine Unterordner nötig.
Formate: mp3, wav, m4a, aiff, flac.

Der Dateiname wird zum angezeigten Titel:

```
media/beats/
  Night Drive.mp3
  Gulf Coast.wav
```

Danach:

```
npm run media
```

Das transkodiert nach 128 kbps AAC (schont Datenvolumen auf dem Handy) und gleicht
die Lautheit auf -16 LUFS an, damit kein Beat rausspringt.

## BeatStars-Links

Optional eine `links.json` in diesem Ordner. Dann wird der Titel auf der Seite klickbar:

```json
{
  "Night Drive": "https://www.beatstars.com/beat/....",
  "Gulf Coast": "https://www.beatstars.com/beat/...."
}
```

Schlüssel ist der Dateiname ohne Endung.
