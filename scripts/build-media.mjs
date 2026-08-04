#!/usr/bin/env node
/**
 * Media-Build fuer TagoBeats Travel.
 *
 * Liest media/photos/<Album>/*.jpg und media/beats/*.mp3, erzeugt daraus
 * responsive Derivate in public/m/ plus public/m/manifest.json.
 *
 * Idempotent: bereits verarbeitete Dateien werden uebersprungen (Hash aus
 * Pfad + Groesse + mtime). Mit --force wird alles neu gerechnet.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import os from 'node:os';

import sharp from 'sharp';
import exifr from 'exifr';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHOTO_SRC = path.join(ROOT, 'media', 'photos');
const BEAT_SRC = path.join(ROOT, 'media', 'beats');
const OUT_IMG = path.join(ROOT, 'public', 'm', 'img');
const OUT_AUDIO = path.join(ROOT, 'public', 'm', 'audio');
const OUT_MANIFEST = path.join(ROOT, 'public', 'm', 'manifest.json');
const OUT_GRAIN = path.join(ROOT, 'public', 'm', 'grain.png');
const CACHE_FILE = path.join(ROOT, 'scripts', '.media-cache.json');

/*
 * AVIF traegt alle Groessen. WebP gibt es nur klein, als Rueckfalloption fuer Safari
 * unter Version 16 auf dem Handy. Das JPEG ist das letzte Netz fuer alte Webviews,
 * bewusst klein gehalten. WebP in allen Groessen neben AVIF hat bei 164 Fotos
 * allein 55 MB gekostet, ohne dass es je ein Browser angefasst haette.
 */
const WIDTHS = [480, 960, 1600, 2400];
const WEBP_WIDTHS = [480, 960];
const THUMB_WIDTH = 160;
const LQIP_WIDTH = 24;
const AVIF_QUALITY = 55;
const WEBP_QUALITY = 76;
const JPEG_QUALITY = 72;
const JPEG_FALLBACK_WIDTH = 1024;
const DEFAULT_ALBUM = 'Travel';

/** Aendert sich, wenn sich das Ausgabeformat aendert. Erzwingt dann ein Neurechnen. */
const RECIPE = 'v2';

/*
 * Aendert sich, wenn aus dem EXIF andere Felder gelesen werden. Anders als RECIPE
 * loest das kein Neu-Encoding aus, gecachte Eintraege lesen nur ihr EXIF neu ein.
 */
const EXIF_PASS = 2;

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.heic', '.heif']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aif', '.aiff', '.flac', '.ogg']);

const FORCE = process.argv.includes('--force');

sharp.cache(false);
sharp.concurrency(Math.max(1, Math.min(4, os.cpus().length)));

/* ------------------------------------------------------------------ utils */

function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ss/gi, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

function prettyBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function hex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function listFiles(dir, extSet) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && extSet.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b, 'de'));
}

/**
 * Hash ueber den Dateiinhalt, nicht ueber mtime. Der Hash landet im Dateinamen der
 * Derivate, damit sie mit max-age=1y ausgeliefert werden koennen: bearbeitest du ein
 * Foto und legst es unter demselben Namen wieder ab, aendert sich die URL mit.
 */
async function fingerprint(file) {
  const buf = await fs.readFile(file);
  return createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

/* ---------------------------------------------------------------- Doppel */

/*
 * Zwei Stufen, weil zwei Arten von Doppeln vorkommen. "Foto 2.jpg" neben "Foto.jpg"
 * ist meist byte-identisch, das faellt ueber den Datei-Hash und kostet kein Encoding.
 * Manche Kopien unterscheiden sich aber nur in ein paar EXIF-Bytes und haben deshalb
 * einen anderen Datei-Hash, obwohl die Pixel gleich sind. Dafuer die zweite Stufe.
 */

/** Bei gleichem Inhalt gewinnt der kuerzere Dateiname, also das Original ohne " 2". */
const preferOriginal = (a, b) => {
  const na = path.basename(a);
  const nb = path.basename(b);
  return na.length - nb.length || na.localeCompare(nb, 'de');
};

function pickWinners(groups, nameOf) {
  const winners = new Set();
  const dropped = [];
  for (const list of groups.values()) {
    const sorted = list.slice().sort((a, b) => preferOriginal(nameOf(a), nameOf(b)));
    winners.add(sorted[0]);
    for (const loser of sorted.slice(1)) dropped.push([nameOf(loser), nameOf(sorted[0])]);
  }
  return { winners, dropped };
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** Stufe 1: byte-identische Dateien raus, bevor irgendwas encodiert wird. */
async function dropByteDupes(files) {
  const fps = await pool(files, 8, (file) => fingerprint(file));
  const groups = groupBy(
    files.map((file, i) => ({ file, fp: fps[i] })),
    (r) => r.fp
  );
  const { winners, dropped } = pickWinners(groups, (r) => r.file);
  const keepSet = new Set([...winners].map((r) => r.file));
  return { keep: files.filter((f) => keepSet.has(f)), dropped };
}

/** Signatur ueber die dekodierten Pixel, unabhaengig von Metadaten und Kompression. */
async function pixelSig(input) {
  const raw = await sharp(input, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer();
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ----------------------------------------------------------- album helpers */

/** order.txt: eine Datei pro Zeile, bestimmt die Reihenfolge im Album. */
async function readOrder(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'order.txt'), 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** captions.txt: "Dateiname = Text" pro Zeile. */
async function readCaptions(dir) {
  const map = new Map();
  try {
    const raw = await fs.readFile(path.join(dir, 'captions.txt'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
    }
  } catch {
    /* keine captions.txt, alles gut */
  }
  return map;
}

async function collectAlbums() {
  const albums = [];
  let entries;
  try {
    entries = await fs.readdir(PHOTO_SRC, { withFileTypes: true });
  } catch {
    return albums;
  }

  const loose = await listFiles(PHOTO_SRC, PHOTO_EXT);
  if (loose.length) {
    albums.push({ name: DEFAULT_ALBUM, dir: PHOTO_SRC, files: loose });
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(PHOTO_SRC, entry.name);
    const files = await listFiles(dir, PHOTO_EXT);
    if (files.length) albums.push({ name: entry.name, dir, files });
  }

  return albums;
}

/* -------------------------------------------------------------------- exif */

/*
 * Die Aufnahmezeit wird als Wanduhrzeit des Aufnahmeorts gespeichert, ohne Zonen-
 * Suffix ("2026-07-26T17:49:49"). exifr wuerde den EXIF-String sonst in der Zeitzone
 * der bauenden Maschine aufloesen: derselbe Build ergaebe in Texas und in Deutschland
 * verschiedene Zeitstempel, und ein Abendfoto rutschte im Browser auf den Folgetag.
 */
function wallClock(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
  }
  if (value instanceof Date && !isNaN(value)) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}T${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  }
  return null;
}

/*
 * Die Drohne schreibt eine falsche Uhrzeit ins EXIF, der Dateiname traegt die richtige
 * (dji_fly_20260729_134128_...). Weicht beides um mehr als eine Stunde ab, gewinnt der
 * Dateiname: sonst sortieren die Drohnenbilder an die falsche Stelle des Tages und
 * verziehen die zeitbasierte Ortszuordnung ihrer Nachbarn.
 */
function droneClock(file, taken) {
  const m = path.basename(file).match(/dji_fly_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i);
  if (!m) return taken;
  const fromName = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (!taken) return fromName;
  const diff = Math.abs(new Date(`${fromName}Z`) - new Date(`${taken}Z`));
  return diff > 60 * 60 * 1000 ? fromName : taken;
}

/** Aufnahmezeit, Kamera und Koordinaten. Liest nur die Header, nicht die Pixel. */
async function readExif(file) {
  let tags = null;
  try {
    // reviveValues: false laesst die Datumsangaben als Rohstring durch, siehe wallClock()
    tags = await exifr.parse(file, {
      reviveValues: false,
      pick: ['DateTimeOriginal', 'CreateDate', 'Model', 'Make'],
    });
  } catch {
    /* EXIF fehlt oder ist kaputt, kein Grund abzubrechen */
  }

  // Der GPS-Block haengt an einem eigenen IFD und kommt ueber pick() nicht mit
  let gps = null;
  try {
    const g = await exifr.gps(file);
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
      gps = [+g.latitude.toFixed(5), +g.longitude.toFixed(5)];
    }
  } catch {
    /* kein GPS im Bild */
  }

  const taken = wallClock(tags?.DateTimeOriginal) || wallClock(tags?.CreateDate);

  return {
    date: droneClock(file, taken),
    cam: [tags?.Make, tags?.Model].filter(Boolean).join(' ').trim() || null,
    gps,
    ex: EXIF_PASS,
  };
}

/* -------------------------------------------------------------- kamera-uhr */

/*
 * Verschiebt die Aufnahmezeit von Kameras, die falsch gestellt waren. Gerechnet wird
 * immer vom EXIF-Rohwert in dateRaw, damit wiederholte Laeufe und gecachte Eintraege
 * nicht mehrfach verschieben. Faellt der passende Eintrag in clock.json weg, steht
 * wieder der Rohwert da.
 */
function applyClockFixes(entries, config) {
  const fixes = config.fixes || [];
  let shifted = 0;

  for (const e of entries) {
    if (!e.dateRaw) e.dateRaw = e.date;
    if (!e.dateRaw) continue;

    const fix = fixes.find((f) => {
      if (f.cam && !(e.cam || '').toLowerCase().includes(String(f.cam).toLowerCase())) return false;
      const from = normWindow(f.from);
      const to = normWindow(f.to);
      return (!from || e.dateRaw >= from) && (!to || e.dateRaw < to);
    });

    if (!fix || !fix.hours) {
      e.date = e.dateRaw;
      continue;
    }

    const d = new Date(`${e.dateRaw}Z`);
    d.setUTCMinutes(d.getUTCMinutes() + Math.round(fix.hours * 60));
    e.date = d.toISOString().slice(0, 19);
    shifted++;
  }

  return shifted;
}

/* ------------------------------------------------------------------- places */

/** Ein Reisetag beginnt um 05:00. Was davor liegt, gehoert noch zum Vorabend. */
const DAY_START_HOUR = 5;

function travelDay(date) {
  if (!date) return null;
  const d = new Date(`${date}Z`);
  d.setUTCHours(d.getUTCHours() - DAY_START_HOUR);
  return d.toISOString().slice(0, 10);
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** "2026-07-27 14:00" -> "2026-07-27T14:00", damit sich Fenster per String vergleichen lassen. */
const normWindow = (s) => String(s || '').trim().replace(' ', 'T');

/*
 * Setzt place und region auf allen Eintraegen eines Albums.
 *
 * Reihenfolge: files schlaegt windows, windows schlaegt GPS, GPS schlaegt die
 * zeitliche Vererbung. Fotos ohne eigenes GPS erben vom zeitlich naechsten Foto,
 * das eins hatte, bevorzugt vom selben Reisetag.
 */
function resolvePlaces(entries, config) {
  const points = config.places || [];
  const windows = (config.windows || []).map((w) => ({
    ...w,
    from: normWindow(w.from),
    to: normWindow(w.to),
  }));
  const files = config.files || {};
  const byName = new Map(points.map((p) => [p.name, p]));
  const unmatched = [];

  const apply = (entry, name) => {
    entry.place = name;
    entry.region = byName.get(name)?.region || null;
  };

  for (const e of entries) {
    e.place = null;
    e.region = null;
    let byGps = false;

    if (e.gps && points.length) {
      let best = null;
      let bestDist = Infinity;
      for (const p of points) {
        const d = distanceKm(e.gps[0], e.gps[1], p.lat, p.lon);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      if (best && bestDist <= (best.km ?? 25)) {
        apply(e, best.name);
        byGps = true;
      } else if (best) {
        unmatched.push({ file: e.file, gps: e.gps, near: best.name, dist: bestDist });
      }
    }

    // Zeitfenster fuellen nur Luecken. Wo echte Koordinaten im Bild stehen, gewinnen die:
    // ein Fenster ist eine Schaetzung fuer Strecken ohne GPS, keine Korrektur fuer Messwerte.
    // Fuer wirklich falsches GPS gibt es "files" als letzte Instanz.
    const win = e.date && windows.find((w) => e.date >= w.from && e.date < w.to);
    if (win && !byGps) apply(e, win.place);

    const forced = files[e.file];
    if (forced) apply(e, forced);
  }

  // Vererbung: alles was jetzt noch offen ist, haengt sich an den naechsten Nachbarn
  const anchors = entries.filter((e) => e.place && e.date);
  if (anchors.length) {
    for (const e of entries) {
      if (e.place || !e.date) continue;
      const day = travelDay(e.date);
      const sameDay = anchors.filter((a) => travelDay(a.date) === day);
      const pool = sameDay.length ? sameDay : anchors;
      const t = new Date(`${e.date}Z`);
      let near = pool[0];
      let bestGap = Infinity;
      for (const a of pool) {
        const gap = Math.abs(new Date(`${a.date}Z`) - t);
        if (gap < bestGap) {
          bestGap = gap;
          near = a;
        }
      }
      apply(e, near.place);
    }
  }

  return unmatched;
}

/* ------------------------------------------------------------------ photos */

async function processPhoto(file, album, albumSlug, name, cache) {
  const rel = path.relative(ROOT, file);
  const fp = await fingerprint(file);
  const slug = `${name}-${fp}`;
  const outDir = path.join(OUT_IMG, albumSlug);
  const cached = cache[rel];

  if (!FORCE && cached && cached.fp === fp && cached.recipe === RECIPE) {
    const stillThere = await Promise.all(
      cached.entry.widths.map((w) => exists(path.join(outDir, `${slug}-${w}.avif`)))
    );
    if (stillThere.every(Boolean)) {
      // Aelterer Cache kennt die Pixel-Signatur noch nicht: einmal nachziehen.
      // Kostet nur einen Decode, kein erneutes Encoding.
      if (!cached.sig) cached.sig = await pixelSig(file);
      // Dasselbe fuer EXIF-Felder, die es beim Anlegen des Caches noch nicht gab
      if (cached.entry.ex !== EXIF_PASS) Object.assign(cached.entry, await readExif(file));
      return { entry: cached.entry, sig: cached.sig, skipped: true };
    }
  }

  await fs.mkdir(outDir, { recursive: true });

  const input = sharp(file, { failOn: 'none' }).rotate(); // rotate() = EXIF-Orientierung anwenden
  const meta = await input.metadata();
  // Nach .rotate() koennen Breite/Hoehe getauscht sein, metadata() liefert die Rohwerte
  const swapped = (meta.orientation || 1) >= 5;
  const srcW = swapped ? meta.height : meta.width;
  const srcH = swapped ? meta.width : meta.height;
  if (!srcW || !srcH) throw new Error(`keine Bildmasse lesbar: ${rel}`);

  // Alle Stufen bis zur Originalbreite, plus die Originalbreite selbst wenn sie
  // zwischen zwei Stufen liegt. Sonst haette ein 800px-Bild nur eine 480px-Variante.
  const widths = WIDTHS.filter((w) => w <= srcW);
  if (srcW < WIDTHS[WIDTHS.length - 1] && !widths.includes(srcW)) widths.push(srcW);
  if (!widths.length) widths.push(srcW);
  widths.sort((a, b) => a - b);

  // Einmal in den Speicher dekodieren, dann alle Groessen daraus ableiten
  const base = await input.toBuffer();
  const sig = await pixelSig(base);

  const webpWidths = widths.filter((w) => WEBP_WIDTHS.includes(w));

  let bytes = 0;
  for (const w of widths) {
    const resized = () => sharp(base).resize({ width: w, withoutEnlargement: true });
    const jobs = [resized().avif({ quality: AVIF_QUALITY, effort: 4 }).toFile(path.join(outDir, `${slug}-${w}.avif`))];
    if (webpWidths.includes(w)) {
      jobs.push(resized().webp({ quality: WEBP_QUALITY }).toFile(path.join(outDir, `${slug}-${w}.webp`)));
    }
    for (const res of await Promise.all(jobs)) bytes += res.size;
  }

  // JPEG-Fallback fuer alles, was weder AVIF noch WebP kann
  const jpegWidth = Math.min(JPEG_FALLBACK_WIDTH, srcW);
  const jpg = await sharp(base)
    .resize({ width: jpegWidth, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
    .toFile(path.join(outDir, `${slug}-fallback.jpg`));
  bytes += jpg.size;

  const thumb = await sharp(base)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 70 })
    .toFile(path.join(outDir, `${slug}-thumb.webp`));
  bytes += thumb.size;

  const lqipBuf = await sharp(base)
    .resize({ width: LQIP_WIDTH })
    .webp({ quality: 40, alphaQuality: 40 })
    .toBuffer();

  const stats = await sharp(base).stats();
  const dom = stats.dominant || { r: 26, g: 24, b: 21 };

  const exif = await readExif(file);

  const entry = {
    id: `${albumSlug}/${slug}`,
    album: album.name,
    albumId: albumSlug,
    base: `/m/img/${albumSlug}/${slug}`,
    widths,
    webpWidths,
    thumb: `/m/img/${albumSlug}/${slug}-thumb.webp`,
    fallback: `/m/img/${albumSlug}/${slug}-fallback.jpg`,
    w: srcW,
    h: srcH,
    lqip: `data:image/webp;base64,${lqipBuf.toString('base64')}`,
    color: hex(dom.r, dom.g, dom.b),
    ...exif,
    place: null,
    region: null,
    caption: null,
    bytes,
  };

  cache[rel] = { fp, recipe: RECIPE, sig, entry };
  return { entry, sig, skipped: false };
}

/* ------------------------------------------------------------------- beats */

async function probeDuration(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const dur = parseFloat(stdout.trim());
    return Number.isFinite(dur) ? +dur.toFixed(2) : null;
  } catch {
    return null;
  }
}

async function processBeat(file, name, cache, links) {
  const rel = path.relative(ROOT, file);
  const fp = await fingerprint(file);
  const slug = `${name}-${fp}`;
  const outFile = path.join(OUT_AUDIO, `${slug}.m4a`);
  const cached = cache[rel];

  if (!FORCE && cached && cached.fp === fp && (await exists(outFile))) {
    return { entry: cached.entry, skipped: true };
  }

  await fs.mkdir(OUT_AUDIO, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', file,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart',
    outFile,
  ]);

  const title = path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').trim();
  const entry = {
    id: name,
    title,
    src: `/m/audio/${slug}.m4a`,
    dur: await probeDuration(outFile),
    link: links[title] || links[path.basename(file)] || null,
    bytes: (await fs.stat(outFile)).size,
  };

  cache[rel] = { fp, entry };
  return { entry, skipped: false };
}

/* ------------------------------------------------------------------- prune */

/**
 * Loescht Derivate, auf die kein Manifest-Eintrag mehr zeigt: geloeschte Fotos,
 * umbenannte Alben, alte Staende bearbeiteter Bilder. Betrifft ausschliesslich
 * public/m/img und public/m/audio, also rein generierte Ordner.
 */
async function prune(photos, beats) {
  let removed = 0;

  const keep = new Map();
  for (const p of photos) {
    const dir = path.join(OUT_IMG, p.albumId);
    const stem = p.base.split('/').pop();
    const set = keep.get(dir) || new Set();
    for (const w of p.widths) set.add(`${stem}-${w}.avif`);
    for (const w of p.webpWidths) set.add(`${stem}-${w}.webp`);
    set.add(`${stem}-fallback.jpg`);
    set.add(`${stem}-thumb.webp`);
    keep.set(dir, set);
  }

  let albumDirs = [];
  try {
    albumDirs = (await fs.readdir(OUT_IMG, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(OUT_IMG, e.name));
  } catch {
    albumDirs = [];
  }

  for (const dir of albumDirs) {
    const set = keep.get(dir);
    if (!set) {
      const files = await fs.readdir(dir).catch(() => []);
      removed += files.length;
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }
    for (const file of await fs.readdir(dir).catch(() => [])) {
      if (set.has(file)) continue;
      await fs.rm(path.join(dir, file), { force: true });
      removed++;
    }
  }

  const keepAudio = new Set(beats.map((b) => b.src.split('/').pop()));
  for (const file of await fs.readdir(OUT_AUDIO).catch(() => [])) {
    if (keepAudio.has(file)) continue;
    await fs.rm(path.join(OUT_AUDIO, file), { force: true });
    removed++;
  }

  return removed;
}

/* ------------------------------------------------------------------- grain */

async function ensureGrain() {
  if (await exists(OUT_GRAIN)) return;
  await fs.mkdir(path.dirname(OUT_GRAIN), { recursive: true });
  await sharp({
    create: {
      width: 128,
      height: 128,
      channels: 3,
      noise: { type: 'gaussian', mean: 128, sigma: 26 },
    },
  })
    .greyscale()
    .png({ compressionLevel: 9, palette: true })
    .toFile(OUT_GRAIN);
  console.log('  Grain-Tile erzeugt: public/m/grain.png');
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(`TagoBeats Travel - Media-Build${FORCE ? ' (--force)' : ''}`);

  const cache = FORCE ? {} : await readJson(CACHE_FILE, {});
  await fs.mkdir(OUT_IMG, { recursive: true });
  await fs.mkdir(OUT_AUDIO, { recursive: true });
  await ensureGrain();

  /* --- Fotos --- */
  const placeConfig = await readJson(path.join(ROOT, 'media', 'places.json'), {});
  const clockConfig = await readJson(path.join(ROOT, 'media', 'clock.json'), {});
  const albums = await collectAlbums();
  const photos = [];
  const albumMeta = [];
  let skippedPhotos = 0;
  let droppedDupes = 0;
  let totalBytes = 0;

  for (const album of albums) {
    const albumSlug = slugify(album.name);
    const order = await readOrder(album.dir);
    const captions = await readCaptions(album.dir);
    const used = new Set();

    console.log(`\n  ${album.name} (${album.files.length} Bilder)`);

    const { keep: files, dropped: byteDupes } = await dropByteDupes(album.files);
    for (const [loser, winner] of byteDupes) {
      console.log(`    Doppel uebersprungen: ${path.basename(loser)} = ${path.basename(winner)}`);
      droppedDupes++;
    }

    const jobs = files.map((file) => {
      let slug = slugify(path.basename(file, path.extname(file)));
      let n = 2;
      while (used.has(slug)) slug = `${slugify(path.basename(file, path.extname(file)))}-${n++}`;
      used.add(slug);
      return { file, slug };
    });

    const results = await pool(jobs, 4, async ({ file, slug }) => {
      try {
        const res = await processPhoto(file, album, albumSlug, slug, cache);
        res.entry.caption = captions.get(path.basename(file)) || null;
        res.entry.file = path.basename(file);
        if (res.skipped) {
          skippedPhotos++;
        } else {
          console.log(`    ${path.basename(file)} -> ${res.entry.widths.join('/')} px, ${prettyBytes(res.entry.bytes)}`);
        }
        return res;
      } catch (err) {
        console.error(`    FEHLER bei ${path.basename(file)}: ${err.message}`);
        return null;
      }
    });

    // Stufe 2: gleiche Pixel, anderer Datei-Hash. Die Derivate der Verlierer raeumt
    // prune() am Ende weg, weil sie im Manifest nicht mehr auftauchen.
    const processed = results.filter(Boolean);
    const sigGroups = groupBy(processed, (r) => r.sig);
    const { winners: sigWinners, dropped: pixelDupes } = pickWinners(sigGroups, (r) => r.entry.file);
    for (const [loser, winner] of pixelDupes) {
      console.log(`    Doppel verworfen (gleiche Pixel): ${loser} = ${winner}`);
      droppedDupes++;
    }

    const entries = processed
      .filter((r) => !r.sig || sigWinners.has(r))
      .map((r) => r.entry);

    // Falsch gestellte Kamera-Uhren geradeziehen, bevor nach Datum sortiert wird
    const shifted = applyClockFixes(entries, clockConfig);
    if (shifted) console.log(`    Uhrzeit korrigiert: ${shifted} Fotos (siehe media/clock.json)`);

    // Sortierung: order.txt gewinnt, danach Aufnahmedatum, danach Dateiname
    const orderIndex = new Map(order.map((name, i) => [name, i]));
    entries.sort((a, b) => {
      const ia = orderIndex.has(a.file) ? orderIndex.get(a.file) : Infinity;
      const ib = orderIndex.has(b.file) ? orderIndex.get(b.file) : Infinity;
      if (ia !== ib) return ia - ib;
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.file.localeCompare(b.file, 'de');
    });

    const unmatched = resolvePlaces(entries, placeConfig);
    for (const u of unmatched) {
      console.log(
        `    Ort unbekannt: ${u.file} bei ${u.gps[0]}, ${u.gps[1]} ` +
          `(naechster: ${u.near}, ${u.dist.toFixed(0)} km) -> in media/places.json nachtragen`
      );
    }
    const places = new Map();
    for (const e of entries) places.set(e.place, (places.get(e.place) || 0) + 1);
    for (const [place, n] of places) console.log(`    Ort: ${place || '(offen)'} -> ${n} Fotos`);

    for (const e of entries) {
      totalBytes += e.bytes || 0; // bereits gecachte Eintraege tragen keine Byte-Zahl mehr
      delete e.bytes;
      // dateRaw bleibt nur stehen, wo wirklich verschoben wurde. Es muss im Cache
      // ueberleben, sonst wuerde der naechste Lauf die korrigierte Zeit erneut schieben.
      if (e.dateRaw === e.date) delete e.dateRaw;
      photos.push(e);
    }

    if (entries.length) {
      const dates = entries.map((e) => e.date).filter(Boolean).sort();
      albumMeta.push({
        id: albumSlug,
        name: album.name,
        count: entries.length,
        from: dates[0] || null,
        to: dates[dates.length - 1] || null,
      });
    }
  }

  /* --- Beats --- */
  const beatFiles = await listFiles(BEAT_SRC, AUDIO_EXT);
  const links = await readJson(path.join(BEAT_SRC, 'links.json'), {});
  const beats = [];
  let skippedBeats = 0;

  if (beatFiles.length) console.log(`\n  Beats (${beatFiles.length})`);

  const beatSlugs = new Set();
  for (const file of beatFiles) {
    let slug = slugify(path.basename(file, path.extname(file)));
    let n = 2;
    while (beatSlugs.has(slug)) slug = `${slug}-${n++}`;
    beatSlugs.add(slug);
    try {
      const res = await processBeat(file, slug, cache, links);
      if (res.skipped) {
        skippedBeats++;
      } else {
        console.log(`    ${path.basename(file)} -> ${prettyBytes(res.entry.bytes)}${res.entry.dur ? `, ${Math.round(res.entry.dur)} s` : ''}`);
        totalBytes += res.entry.bytes || 0;
      }
      const { bytes, ...entry } = res.entry;
      beats.push(entry);
    } catch (err) {
      console.error(`    FEHLER bei ${path.basename(file)}: ${err.message}`);
    }
  }

  /* --- Manifest --- */
  const manifest = {
    generated: new Date().toISOString(),
    albums: albumMeta,
    photos,
    beats,
  };
  await fs.writeFile(OUT_MANIFEST, JSON.stringify(manifest), 'utf8');
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');

  const removed = await prune(photos, beats);

  console.log(
    `\nFertig: ${photos.length} Fotos (${skippedPhotos} unveraendert${droppedDupes ? `, ${droppedDupes} Doppel aussortiert` : ''}), ${beats.length} Beats (${skippedBeats} unveraendert), ${prettyBytes(totalBytes)} neu geschrieben` +
      (removed ? `, ${removed} verwaiste Dateien geloescht` : '')
  );
  if (!photos.length) console.log('Hinweis: noch keine Bilder in media/photos/ gefunden.');
  if (!beats.length) console.log('Hinweis: noch keine Beats in media/beats/ gefunden.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
