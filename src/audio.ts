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
  const btnPlay = document.getElementById('tv-play') as HTMLButtonElement;
  const btnMute = document.getElementById('tv-mute') as HTMLButtonElement;
  const btnPrev = document.getElementById('tv-track-prev') as HTMLButtonElement;
  const btnNext = document.getElementById('tv-track-next') as HTMLButtonElement;
  const label = document.getElementById('tv-now') as HTMLAnchorElement;

  if (!beats.length) {
    return { start() {}, ready: () => Promise.resolve(), setArtwork() {} };
  }

  root.hidden = false;

  const queue = shuffle(beats);
  let cursor = 0;
  let muted = false;
  let paused = false;
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

  /*
   * Weist der Browser die Wiedergabe ab, muss die Playbar das zeigen. Vorher wurde die
   * Ablehnung still verschluckt: die Leiste stand auf "laeuft", obwohl nichts lief, und
   * der erste Druck auf Play pausierte nur den Stillstand. Es brauchte also zwei Druecke.
   *
   * Der Rueckfall in den Pause-Zustand macht daraus einen: das Symbol zeigt Play, ein
   * Druck startet den Ton, und der zaehlt sicher als Geste.
   */
  function play(el: HTMLAudioElement) {
    const p = el.play();
    if (p) p.catch(() => { if (el === current) setPaused(true); });
  }

  /*
   * iOS gibt jedes Audio-Element einzeln frei, und nur innerhalb einer echten Geste.
   * Das Ersatz-Element wird erst beim Titelwechsel gebraucht, da ist die Geste laengst
   * vorbei und der Ton bliebe ab dem zweiten Beat stumm. Deshalb hier einmal kurz
   * anspielen und sofort wieder anhalten, solange der Tap noch zaehlt.
   */
  function unlock(el: HTMLAudioElement) {
    if (!el.src && queue.length > 1) el.src = queue[1].src;
    if (!el.src) return;
    el.muted = true;
    const p = el.play();
    if (p) {
      p.then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = muted;
      }).catch(() => { el.muted = muted; });
    }
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

  /**
   * Wechselt auf queue[i]. Der automatische Uebergang am Songende blendet ueber,
   * ein Tap auf Weiter/Zurueck schneidet hart: ein angeforderter Sprung soll sofort
   * hoerbar sein, nicht anderthalb Sekunden spaeter.
   */
  function goToTrack(i: number, fade: boolean) {
    cursor = ((i % queue.length) + queue.length) % queue.length;
    const beat = queue[cursor];
    warmed = false;

    const outgoing = current;
    current = spare;
    spare = outgoing;

    // Handler des abgeloesten Elements loesen, sonst feuert dessen 'ended' spaeter
    // einen zweiten Wechsel
    outgoing.onended = null;
    outgoing.ontimeupdate = null;

    // Wenn warmNext() schon gegriffen hat, steht die Quelle bereits und ist gepuffert
    if (!current.src.endsWith(beat.src)) current.src = beat.src;
    current.preload = 'auto';
    current.muted = muted;
    if (current.currentTime) current.currentTime = 0;

    const doFade = fade && canFade;
    current.volume = doFade ? 0 : 1;
    if (!paused) play(current);
    paintTitle(beat);

    if (doFade) {
      fading = true;
      ramp(current, 1, FADE_MS, () => { fading = false; });
      ramp(outgoing, 0, FADE_MS, () => {
        outgoing.pause();
        outgoing.removeAttribute('src');
        outgoing.load();
      });
    } else {
      fading = false;
      outgoing.pause();
      outgoing.removeAttribute('src');
      outgoing.load();
    }

    attach(current);
  }

  const advance = () => goToTrack(cursor + 1, true);
  const skip = (dir: number) => goToTrack(cursor + dir, false);

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

  /* ------------------------------------------------------ Pause und Mute */

  /** Stumm laesst weiterlaufen, Pause haelt an. Zwei Knoepfe, zwei Zustaende. */
  function setMuted(next: boolean) {
    muted = next;
    current.muted = muted;
    spare.muted = muted;
    root.classList.toggle('is-muted', muted);
    btnMute.setAttribute('aria-pressed', String(muted));
    btnMute.setAttribute('aria-label', muted ? 'Ton anschalten' : 'Stumm schalten');
  }

  function setPaused(next: boolean) {
    paused = next;
    root.classList.toggle('is-paused', paused);
    btnPlay.setAttribute('aria-pressed', String(paused));
    btnPlay.setAttribute('aria-label', paused ? 'Weiter abspielen' : 'Pause');
    if (paused) {
      current.pause();
      spare.pause();
    } else if (started) {
      play(current);
      if (fading) play(spare);
    }
  }

  btnMute.addEventListener('click', () => setMuted(!muted));
  btnPlay.addEventListener('click', () => setPaused(!paused));
  btnPrev.addEventListener('click', () => skip(-1));
  btnNext.addEventListener('click', () => skip(1));

  // Tabwechsel haelt nur an, wenn Robin nicht selbst schon pausiert hat
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      current.pause();
      spare.pause();
    } else if (started && !paused) {
      play(current);
    }
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => setPaused(false));
    navigator.mediaSession.setActionHandler('pause', () => setPaused(true));
    navigator.mediaSession.setActionHandler('nexttrack', () => skip(1));
    navigator.mediaSession.setActionHandler('previoustrack', () => skip(-1));
  }

  return {
    start() {
      if (started) return;
      started = true;
      current.preload = 'auto';
      current.volume = 1;
      play(current);
      unlock(spare);
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
