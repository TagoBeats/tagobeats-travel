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
    if (stillThere.every(Boolean)) return { entry: cached.entry, skipped: true };
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

  let exif = null;
  try {
    exif = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'Model', 'Make', 'latitude', 'longitude'] });
  } catch {
    /* EXIF fehlt oder ist kaputt, kein Grund abzubrechen */
  }
  const taken = exif?.DateTimeOriginal || exif?.CreateDate || null;

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
    date: taken ? new Date(taken).toISOString() : null,
    cam: [exif?.Make, exif?.Model].filter(Boolean).join(' ').trim() || null,
    gps: exif?.latitude && exif?.longitude ? [+exif.latitude.toFixed(5), +exif.longitude.toFixed(5)] : null,
    caption: null,
    bytes,
  };

  cache[rel] = { fp, recipe: RECIPE, entry };
  return { entry, skipped: false };
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
  const albums = await collectAlbums();
  const photos = [];
  const albumMeta = [];
  let skippedPhotos = 0;
  let totalBytes = 0;

  for (const album of albums) {
    const albumSlug = slugify(album.name);
    const order = await readOrder(album.dir);
    const captions = await readCaptions(album.dir);
    const used = new Set();

    console.log(`\n  ${album.name} (${album.files.length} Bilder)`);

    const jobs = album.files.map((file) => {
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
        return res.entry;
      } catch (err) {
        console.error(`    FEHLER bei ${path.basename(file)}: ${err.message}`);
        return null;
      }
    });

    const entries = results.filter(Boolean);

    // Sortierung: order.txt gewinnt, danach Aufnahmedatum, danach Dateiname
    const orderIndex = new Map(order.map((name, i) => [name, i]));
    entries.sort((a, b) => {
      const ia = orderIndex.has(a.file) ? orderIndex.get(a.file) : Infinity;
      const ib = orderIndex.has(b.file) ? orderIndex.get(b.file) : Infinity;
      if (ia !== ib) return ia - ib;
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.file.localeCompare(b.file, 'de');
    });

    for (const e of entries) {
      totalBytes += e.bytes || 0; // bereits gecachte Eintraege tragen keine Byte-Zahl mehr
      delete e.bytes;
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
    `\nFertig: ${photos.length} Fotos (${skippedPhotos} unveraendert), ${beats.length} Beats (${skippedBeats} unveraendert), ${prettyBytes(totalBytes)} neu geschrieben` +
      (removed ? `, ${removed} verwaiste Dateien geloescht` : '')
  );
  if (!photos.length) console.log('Hinweis: noch keine Bilder in media/photos/ gefunden.');
  if (!beats.length) console.log('Hinweis: noch keine Beats in media/beats/ gefunden.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
