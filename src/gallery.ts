import type { Photo } from './types';

/** Wieviele Nachbarn links und rechts in voller Aufloesung vorgehalten werden. */
const WINDOW = 2;
const SIZES = '(min-width: 900px) 58vw, 100vw';

const pad2 = (n: number) => String(n).padStart(2, '0');

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });

function srcset(photo: Photo, ext: string, widths: readonly number[]): string {
  return widths.map((w) => `${photo.base}-${w}.${ext} ${w}w`).join(', ');
}

function subLine(photo: Photo): string {
  const bits: string[] = [];
  if (photo.caption) bits.push(photo.caption);
  else if (photo.date) bits.push(dateFmt.format(new Date(photo.date)));
  if (photo.cam) bits.push(photo.cam);
  return bits.join(' · ');
}

export interface Gallery {
  index: number;
  goTo(i: number, smooth?: boolean): void;
  ready(): Promise<void>;
}

export function createGallery(photos: Photo[]): Gallery {
  const track = document.getElementById('tv-track') as HTMLDivElement;
  const strip = document.getElementById('tv-strip') as HTMLElement;
  const elIdx = document.getElementById('tv-idx') as HTMLElement;
  const elTotal = document.getElementById('tv-total') as HTMLElement;
  const elAlbum = document.getElementById('tv-album') as HTMLElement;
  const elSub = document.getElementById('tv-sub') as HTMLElement;
  const glow = document.querySelector('.tv-glow') as HTMLElement;
  const prev = document.getElementById('tv-prev') as HTMLButtonElement;
  const next = document.getElementById('tv-next') as HTMLButtonElement;

  const slides: HTMLElement[] = [];
  const thumbs: HTMLButtonElement[] = [];
  let index = 0;
  let currentAlbum = '';

  /* ------------------------------------------------------------ Aufbau */

  const trackFrag = document.createDocumentFragment();
  const stripFrag = document.createDocumentFragment();

  photos.forEach((photo, i) => {
    const slide = document.createElement('div');
    slide.className = 'tv-slide';
    slide.style.setProperty('--lqip', `url("${photo.lqip}")`);
    trackFrag.appendChild(slide);
    slides.push(slide);

    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'tv-thumb';
    thumb.setAttribute('aria-label', `Foto ${i + 1}: ${photo.album}`);
    thumb.innerHTML =
      `<img src="${photo.thumb}" alt="" width="76" height="76" loading="lazy" decoding="async">` +
      `<span class="tv-thumb-label">${pad2(i + 1)}</span>`;
    thumb.addEventListener('click', () => goTo(i, true));
    stripFrag.appendChild(thumb);
    thumbs.push(thumb);
  });

  track.appendChild(trackFrag);
  strip.appendChild(stripFrag);
  elTotal.textContent = pad2(photos.length);

  /* --------------------------------------------------- Bilder nachziehen */

  function hydrate(i: number): HTMLImageElement | null {
    const slide = slides[i];
    if (!slide || slide.dataset.hydrated) return slide?.querySelector('img') ?? null;
    slide.dataset.hydrated = '1';

    const photo = photos[i];
    const picture = document.createElement('picture');
    for (const [ext, widths] of [['avif', photo.widths], ['webp', photo.webpWidths]] as const) {
      if (!widths?.length) continue;
      const source = document.createElement('source');
      source.type = `image/${ext}`;
      source.srcset = srcset(photo, ext, widths);
      source.sizes = SIZES;
      picture.appendChild(source);
    }

    const img = document.createElement('img');
    img.src = photo.fallback;
    img.alt = photo.caption || photo.album;
    img.width = photo.w;
    img.height = photo.h;
    img.decoding = 'async';
    // Kein loading="lazy": das Fenster von plus/minus zwei Slides IST schon die
    // Sparmassnahme. Mit lazy wuerden die Nachbarn erst beim Wischen anfangen zu laden.
    img.fetchPriority = i === 0 ? 'high' : 'low';

    const reveal = () => slide.classList.add('is-loaded');
    if (img.complete) reveal();
    else img.addEventListener('load', reveal, { once: true });

    picture.appendChild(img);
    slide.appendChild(picture);
    return img;
  }

  function hydrateWindow(center: number) {
    for (let i = center - WINDOW; i <= center + WINDOW; i++) {
      if (i >= 0 && i < photos.length) hydrate(i);
    }
  }

  /* ------------------------------------------------------------- Anzeige */

  function swapText(el: HTMLElement, value: string) {
    if (el.textContent === value) return;
    el.style.opacity = '0';
    window.setTimeout(() => {
      el.textContent = value;
      el.style.opacity = '';
    }, 160);
  }

  function paint(i: number) {
    const photo = photos[i];
    if (!photo) return;

    elIdx.textContent = pad2(i + 1);
    elSub.textContent = subLine(photo);
    if (photo.album !== currentAlbum) {
      currentAlbum = photo.album;
      swapText(elAlbum, photo.album);
    }
    glow.style.setProperty('--glow', photo.color);

    thumbs.forEach((t, n) => t.classList.toggle('is-active', n === i));
    const active = thumbs[i];
    if (active) {
      const left = active.offsetLeft - strip.clientWidth / 2 + active.offsetWidth / 2;
      strip.scrollTo({ left, behavior: 'smooth' });
    }

    prev.disabled = i === 0;
    next.disabled = i === photos.length - 1;

    document.dispatchEvent(new CustomEvent('tv:photo', { detail: photo }));
  }

  function setIndex(i: number) {
    if (i === index) return;
    index = i;
    hydrateWindow(i);
    paint(i);
  }

  function goTo(i: number, smooth = false) {
    const clamped = Math.max(0, Math.min(photos.length - 1, i));
    track.scrollTo({
      left: clamped * track.clientWidth,
      // behavior explizit setzen: 'auto' wuerde ein geerbtes scroll-behavior:smooth mitnehmen
      behavior: smooth ? 'smooth' : 'auto',
    });
    setIndex(clamped);
  }

  /* ----------------------------------------------------------- Steuerung */

  let scrollTick = 0;
  track.addEventListener(
    'scroll',
    () => {
      if (scrollTick) return;
      scrollTick = requestAnimationFrame(() => {
        scrollTick = 0;
        const w = track.clientWidth;
        if (!w) return;
        setIndex(Math.round(track.scrollLeft / w));
      });
    },
    { passive: true }
  );

  prev.addEventListener('click', () => goTo(index - 1, true));
  next.addEventListener('click', () => goTo(index + 1, true));

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowLeft') { goTo(index - 1, true); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { goTo(index + 1, true); e.preventDefault(); }
    else if (e.key === 'Home') { goTo(0, true); e.preventDefault(); }
    else if (e.key === 'End') { goTo(photos.length - 1, true); e.preventDefault(); }
  });

  // Mausrad blaettert, aber nur mit echtem Zeiger. Touch bleibt komplett unangetastet,
  // sonst friert der Instagram-Webview wieder ein.
  if (window.matchMedia('(pointer: fine)').matches) {
    let wheelLock = 0;
    track.addEventListener(
      'wheel',
      (e) => {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (Math.abs(delta) < 8) return;
        const now = performance.now();
        if (now - wheelLock < 420) return;
        wheelLock = now;
        goTo(index + Math.sign(delta), true);
      },
      { passive: true }
    );
  }

  let resizeTick = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTick);
    resizeTick = window.setTimeout(() => {
      track.scrollTo({ left: index * track.clientWidth, behavior: 'auto' });
    }, 120);
  });

  /* -------------------------------------------------------------- Start */

  hydrateWindow(0);
  paint(0);

  function ready(): Promise<void> {
    const img = slides[0]?.querySelector('img') as HTMLImageElement | undefined;
    if (!img) return Promise.resolve();
    if (img.complete) return img.decode().catch(() => undefined);
    return new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  }

  return {
    get index() { return index; },
    goTo,
    ready,
  };
}
