import type { Photo } from './types';
import type { Gallery } from './gallery';

/*
 * Kapitel sind die Orte. Der Media-Build sortiert die Fotos so, dass jeder Ort ein
 * zusammenhaengender Block ist, hier wird daraus nur noch die Sprungmarke abgeleitet.
 *
 * Zwei Wege hinein: die Pfeile in der Kopfzeile gehen einen Ort vor oder zurueck,
 * der Knopf daneben oeffnet die vollstaendige Liste.
 */

interface Chapter {
  place: string;
  label: string;
  start: number;
  count: number;
}

function collect(photos: Photo[]): Chapter[] {
  const out: Chapter[] = [];
  photos.forEach((photo, i) => {
    const place = photo.place || photo.album;
    const last = out[out.length - 1];
    if (last && last.place === place) {
      last.count++;
      return;
    }
    out.push({
      place,
      label: photo.region ? `${place}, ${photo.region}` : place,
      start: i,
      count: 1,
    });
  });
  return out;
}

export function createChapters(photos: Photo[], gallery: Gallery) {
  const prev = document.getElementById('tv-place-prev') as HTMLButtonElement | null;
  const next = document.getElementById('tv-place-next') as HTMLButtonElement | null;
  const open = document.getElementById('tv-place-menu') as HTMLButtonElement | null;
  const sheet = document.getElementById('tv-sheet') as HTMLElement | null;
  const list = document.getElementById('tv-sheet-list') as HTMLElement | null;
  const close = document.getElementById('tv-sheet-close') as HTMLButtonElement | null;
  if (!prev || !next || !open || !sheet || !list || !close) return;

  const chapters = collect(photos);

  // Ein einziges Kapitel braucht keine Navigation
  if (chapters.length < 2) {
    (document.querySelector('.tv-chapters') as HTMLElement | null)?.remove();
    return;
  }

  const rows: HTMLButtonElement[] = [];
  let current = 0;

  for (const [i, chapter] of chapters.entries()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tv-place';
    row.innerHTML =
      `<span>${chapter.label}</span>` +
      `<span class="tv-place-n">${chapter.count}</span>`;
    row.addEventListener('click', () => {
      hide();
      gallery.goTo(chapter.start, false);
    });
    list.appendChild(row);
    rows.push(row);
    if (i === 0) row.classList.add('is-here');
  }

  function indexOfPhoto(i: number): number {
    let found = 0;
    for (let c = 0; c < chapters.length; c++) {
      if (chapters[c].start <= i) found = c;
      else break;
    }
    return found;
  }

  function paint(i: number) {
    const at = indexOfPhoto(i);
    if (at !== current) {
      rows[current]?.classList.remove('is-here');
      rows[at]?.classList.add('is-here');
      current = at;
    }
    prev!.disabled = at === 0;
    next!.disabled = at === chapters.length - 1;
  }

  function show() {
    sheet!.hidden = false;
    open!.setAttribute('aria-expanded', 'true');
    rows[current]?.scrollIntoView({ block: 'nearest' });
    close!.focus();
  }

  function hide() {
    sheet!.hidden = true;
    open!.setAttribute('aria-expanded', 'false');
  }

  /*
   * Ein Sprung zurueck fuehrt an den Anfang des aktuellen Kapitels, nicht sofort ins
   * vorige. Steht man schon dort, geht es eine Station weiter zurueck. Das entspricht
   * dem, was Titelsprung-Knoepfe in Musik-Apps tun.
   */
  prev.addEventListener('click', () => {
    const at = indexOfPhoto(gallery.index);
    const target = gallery.index > chapters[at].start ? at : at - 1;
    if (target >= 0) gallery.goTo(chapters[target].start, false);
  });

  next.addEventListener('click', () => {
    const at = indexOfPhoto(gallery.index);
    if (at + 1 < chapters.length) gallery.goTo(chapters[at + 1].start, false);
  });

  open.addEventListener('click', show);
  close.addEventListener('click', hide);

  // Tap auf den Hintergrund schliesst, ein Tap auf eine Zeile nicht
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target === list) hide();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) hide();
  });

  document.addEventListener('tv:photo', () => paint(gallery.index));
  paint(0);
}
