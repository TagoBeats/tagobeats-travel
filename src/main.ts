import './styles.css';
import { createGallery } from './gallery';
import { createPlayer } from './audio';
import { createLoader } from './loader';
import { createZoom, lockPageScale } from './zoom';
import { createLikes } from './likes';
import type { Manifest, Photo } from './types';

const EMPTY: Manifest = { generated: '', albums: [], photos: [], beats: [] };

async function loadManifest(): Promise<Manifest> {
  try {
    const res = await fetch('/m/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as Manifest;
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

async function boot() {
  const loader = createLoader();
  const root = document.getElementById('tv') as HTMLElement;
  lockPageScale();

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

  const player = createPlayer(manifest.beats);
  loader.track(player.ready(), 4000);
  player.setArtwork(manifest.photos[0]);
  document.addEventListener('tv:photo', (e) => {
    player.setArtwork((e as CustomEvent<Photo>).detail);
  });

  await loader.run();

  // ab hier ist der Enter-Tap passiert, also darf Audio starten
  player.start();
  root.removeAttribute('inert');
  root.classList.add('is-live');
  gallery.goTo(0, false);
}

boot();
