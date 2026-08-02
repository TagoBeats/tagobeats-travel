import type { Beat, Photo } from './types';

const FADE_MS = 1500;
const FADE_LEAD = 1.8;     // Sekunden vor Ende startet der Crossfade
const WARM_LEAD = 12;      // Sekunden vor Ende wird der naechste Beat vorgepuffert

function shuffle<T>(list: T[]): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * iOS ignoriert Schreibzugriffe auf HTMLAudioElement.volume. Wir testen das einmal
 * und schalten den Crossfade dort auf einen harten Schnitt um, statt auf Web Audio
 * auszuweichen (MediaElementSource ist auf iOS zu wackelig, um den Ton zu riskieren).
 */
function volumeIsWritable(el: HTMLAudioElement): boolean {
  const before = el.volume;
  el.volume = 0.42;
  const writable = Math.abs(el.volume - 0.42) < 0.01;
  el.volume = before;
  return writable;
}

export interface Player {
  start(): void;
  ready(): Promise<void>;
  setArtwork(photo: Photo): void;
}

export function createPlayer(beats: Beat[]): Player {
  const root = document.getElementById('tv-sound') as HTMLElement;
  const button = document.getElementById('tv-sound-btn') as HTMLButtonElement;
  const label = document.getElementById('tv-now') as HTMLAnchorElement;

  if (!beats.length) {
    return { start() {}, ready: () => Promise.resolve(), setArtwork() {} };
  }

  root.hidden = false;

  const queue = shuffle(beats);
  let cursor = 0;
  let muted = false;
  let started = false;
  let fading = false;
  let warmed = false;
  let artwork: MediaImage[] = [];

  const make = () => {
    const el = new Audio();
    el.preload = 'none';
    return el;
  };

  let current = make();
  let spare = make();
  const canFade = volumeIsWritable(current);

  // Vor dem Enter-Tap nur Metadaten holen. Mit preload="auto" saugt der erste Beat
  // zwei Megabyte, blockiert die Bilder und schiebt den LCP auf Mobilfunk um Sekunden
  // nach hinten. Ab dem Tap wird gestreamt.
  current.src = queue[0].src;
  current.preload = 'metadata';

  /* --------------------------------------------------------------- Fade */

  function ramp(el: HTMLAudioElement, to: number, ms: number, done?: () => void) {
    if (!canFade) {
      el.volume = to;
      done?.();
      return;
    }
    const from = el.volume;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      el.volume = from + (to - from) * k;
      if (k < 1) requestAnimationFrame(step);
      else done?.();
    };
    requestAnimationFrame(step);
  }

  /* -------------------------------------------------------------- Titel */

  function paintTitle(beat: Beat) {
    label.textContent = beat.title;
    if (beat.link) {
      label.href = beat.link;
      label.title = 'Auf BeatStars anhören';
    } else {
      label.removeAttribute('href');
      label.removeAttribute('title');
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: beat.title,
        artist: 'TagoBeats',
        album: 'Travel',
        artwork,
      });
    }
  }

  /* ---------------------------------------------------------- Playback */

  function play(el: HTMLAudioElement) {
    const p = el.play();
    if (p) p.catch(() => { /* Autoplay blockiert, der Enter-Tap holt das nach */ });
  }

  /** Naechsten Beat still vorpuffern, damit der Crossfade nicht in eine Leerstelle faellt. */
  function warmNext() {
    if (warmed) return;
    warmed = true;
    const beat = queue[(cursor + 1) % queue.length];
    if (!spare.src.endsWith(beat.src)) spare.src = beat.src;
    spare.preload = 'auto';
    spare.load();
  }

  function advance() {
    cursor = (cursor + 1) % queue.length;
    const beat = queue[cursor];
    warmed = false;

    const outgoing = current;
    current = spare;
    spare = outgoing;

    // Handler des abgeloesten Elements loesen, sonst feuert dessen 'ended' spaeter
    // ein zweites advance()
    outgoing.onended = null;
    outgoing.ontimeupdate = null;

    // Wenn warmNext() schon gegriffen hat, steht die Quelle bereits und ist gepuffert
    if (!current.src.endsWith(beat.src)) current.src = beat.src;
    current.preload = 'auto';
    current.volume = canFade ? 0 : 1;
    current.muted = muted;
    current.currentTime = 0;
    play(current);
    paintTitle(beat);

    if (canFade) {
      fading = true;
      ramp(current, 1, FADE_MS, () => { fading = false; });
      ramp(outgoing, 0, FADE_MS, () => {
        outgoing.pause();
        outgoing.removeAttribute('src');
        outgoing.load();
      });
    } else {
      outgoing.pause();
      outgoing.removeAttribute('src');
    }

    attach(current);
  }

  function attach(el: HTMLAudioElement) {
    el.onended = () => advance();
    el.ontimeupdate = () => {
      if (fading || !el.duration) return;
      const left = el.duration - el.currentTime;
      if (left <= WARM_LEAD) warmNext();
      // Ohne Crossfade (iOS) uebernimmt 'ended' den Wechsel
      if (canFade && left <= FADE_LEAD) advance();
    };
  }

  attach(current);

  /* ------------------------------------------------------------- Mute */

  function setMuted(next: boolean) {
    muted = next;
    root.classList.toggle('is-muted', muted);
    button.setAttribute('aria-pressed', String(muted));
    if (muted) {
      current.pause();
      spare.pause();
    } else if (started) {
      play(current);
      if (fading) play(spare);
    }
  }

  button.addEventListener('click', () => setMuted(!muted));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      current.pause();
      spare.pause();
    } else if (started && !muted) {
      play(current);
    }
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => setMuted(false));
    navigator.mediaSession.setActionHandler('pause', () => setMuted(true));
    navigator.mediaSession.setActionHandler('nexttrack', () => advance());
  }

  return {
    start() {
      if (started) return;
      started = true;
      current.preload = 'auto';
      current.volume = 1;
      play(current);
      paintTitle(queue[0]);
    },
    ready() {
      return new Promise<void>((resolve) => {
        if (current.readyState >= 1) return resolve();
        current.addEventListener('loadedmetadata', () => resolve(), { once: true });
        current.addEventListener('error', () => resolve(), { once: true });
        current.load();
      });
    },
    setArtwork(photo: Photo) {
      // bewusst aus den WebP-Breiten, die gibt es nicht in allen Groessen
      const w = photo.webpWidths[photo.webpWidths.length - 1];
      if (!w) return;
      artwork = [{ src: `${photo.base}-${w}.webp`, sizes: `${w}x${Math.round((w * photo.h) / photo.w)}`, type: 'image/webp' }];
      if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
        navigator.mediaSession.metadata.artwork = artwork;
      }
    },
  };
}
