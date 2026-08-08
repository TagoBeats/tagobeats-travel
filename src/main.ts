import './styles.css';
import { createGallery } from './gallery';
import { createPlayer } from './audio';
import { createLoader } from './loader';
import { createZoom, lockPageScale } from './zoom';
import { createLikes } from './likes';
import { createChapters } from './chapters';
import { inject } from '@vercel/analytics';
import type { Manifest, Photo } from './types';

const EMPTY: Manifest = { generated: '', albums: [], photos: [], beats: [] };

/*
 * Das Manifest traegt die Pfade ohne fuehrenden Schraegstrich, damit die Galerie nicht
 * an der Wurzel einer Domain kleben muss. Hier bekommen sie einmal das Praefix des
 * Deployments vorgehaengt, danach arbeitet der Rest der Anwendung wie vorher mit
 * fertigen URLs.
 */
const BASE = import.meta.env.BASE_URL;

const asset = (p: string) => (/^(https?:)?\/\//.test(p) || p.startsWith('/') ? p : BASE + p);

function resolvePaths(manifest: Manifest): Manifest {
  for (const photo of manifest.photos) {
    photo.base = asset(photo.base);
    photo.thumb = asset(photo.thumb);
    photo.fallback = asset(photo.fallback);
  }
  for (const beat of manifest.beats) beat.src = asset(beat.src);
  return manifest;
}

async function loadManifest(): Promise<Manifest> {
  try {
    const res = await fetch(`${BASE}m/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    return resolvePaths((await res.json()) as Manifest);
  } catch (err) {
    console.error('manifest.json konnte nicht geladen werden', err);
    return EMPTY;
  }
}

function showEmptyState() {
  const album = document.getElementById('tv-album');
  const sub = document.getElementById('tv-sub');
  if (album) album.textContent = 'Noch leer';
  if (sub) sub.textContent = 'Bilder in media/photos/ legen, dann npm run media';
}

/**
 * Die Kopfzeile liegt als Overlay ueber der Buehne. Wieviel Platz sie braucht, haengt
 * am Albumnamen und daran, ob die Datumszeile umbricht. Auf einem iPhone SE tut sie das,
 * deshalb wird die Hoehe gemessen statt geschaetzt.
 */
function trackHeaderHeight() {
  const meta = document.querySelector('.tv-meta') as HTMLElement | null;
  if (!meta) return;
  const write = () => document.documentElement.style.setProperty('--head-h', `${Math.ceil(meta.offsetHeight)}px`);
  write();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(write).observe(meta);
  else window.addEventListener('resize', write);
}

/*
 * Vercel Web Analytics. Script und Sammelpunkt liegen normalerweise unter /_vercel,
 * das trifft hier aber die Hauptseite: die Galerie haengt per Rewrite unter
 * tagobeats.com/travel, und tagobeats.com/_vercel gehoert dem Website-Projekt. Beide
 * Pfade laufen deshalb ueber BASE_URL und damit durch das Rewrite ins eigene Projekt.
 */
function startAnalytics() {
  const base = import.meta.env.BASE_URL;
  inject({
    scriptSrc: `${base}_vercel/insights/script.js`,
    endpoint: `${base}_vercel/insights`,
  });
}

async function boot() {
  const loader = createLoader();
  const root = document.getElementById('tv') as HTMLElement;
  lockPageScale();
  startAnalytics();

  const manifestPromise = loadManifest();
  loader.track(manifestPromise, 5000);
  loader.track(document.fonts ? document.fonts.ready : Promise.resolve(), 2500);

  const manifest = await manifestPromise;

  if (!manifest.photos.length) {
    showEmptyState();
    await loader.run();
    root.removeAttribute('inert');
    root.classList.add('is-live');
    return;
  }

  const gallery = createGallery(manifest.photos);
  loader.track(gallery.ready(), 6000);
  trackHeaderHeight();
  createZoom(document.getElementById('tv-track') as HTMLElement);
  createLikes(manifest.photos[0]);
  createChapters(manifest.photos, gallery);

  const player = createPlayer(manifest.beats);
  loader.track(player.ready(), 4000);
  player.setArtwork(manifest.photos[0]);
  document.addEventListener('tv:photo', (e) => {
    player.setArtwork((e as CustomEvent<Photo>).detail);
  });

  // Der Ton startet im Tap-Handler selbst, siehe loader.run(). Der zweite Aufruf
  // unten ist nur das Netz fuer den ?enter-Fall und laeuft dank started-Flag leer.
  await loader.run(() => player.start());

  player.start();
  root.removeAttribute('inert');
  root.classList.add('is-live');
  gallery.goTo(0, false);
}

boot();
