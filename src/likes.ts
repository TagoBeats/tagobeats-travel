import type { Photo } from './types';

/*
 * Herz unter dem Foto. Der Zustand liegt lokal im Browser, gezaehlt wird serverseitig
 * in /api/like. Faellt der Endpunkt aus oder gibt es ihn gar nicht, merkt der Besucher
 * davon nichts: das Herz bleibt trotzdem gefuellt.
 */

const STORE = 'tv:liked';

/*
 * Album und Dateiname, nicht photo.id: in der ID steckt ein Content-Hash, der sich beim
 * Neubearbeiten eines Fotos aendert. Der Zaehler soll das ueberleben.
 */
const keyOf = (photo: Photo) => `${photo.albumId}/${photo.file}`;

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set(); // privater Modus oder voller Speicher
  }
}

function save(liked: Set<string>) {
  try {
    localStorage.setItem(STORE, JSON.stringify([...liked]));
  } catch {
    /* nicht schlimm, dann haelt der Zustand eben nur diese Sitzung */
  }
}

function report(photo: string, on: boolean) {
  try {
    /*
     * Praefix des Deployments davor, sonst landet der Aufruf auf der Hauptdomain:
     * die Galerie haengt unter tagobeats.com/travel, und tagobeats.com/api gehoert
     * der Website mit ihren eigenen Funktionen.
     *
     * keepalive, damit der Aufruf auch beim Weiterwischen oder Schliessen rausgeht.
     */
    fetch(`${import.meta.env.BASE_URL}api/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo, on }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* egal, das Herz zaehlt fuer den Besucher trotzdem */
  }
}

/**
 * `first` ist das beim Start sichtbare Foto. Ohne das greift der allererste Klick ins
 * Leere, weil `tv:photo` erst beim Blaettern feuert. Der Player loest das genauso.
 */
export function createLikes(first: Photo | null = null) {
  const btn = document.getElementById('tv-like') as HTMLButtonElement | null;
  if (!btn) return;

  const liked = load();
  let current: Photo | null = first;

  function render() {
    const on = Boolean(current && liked.has(keyOf(current)));
    btn!.classList.toggle('is-on', on);
    btn!.setAttribute('aria-pressed', String(on));
    btn!.setAttribute('aria-label', on ? 'Gefaellt mir nicht mehr' : 'Gefaellt mir');
  }

  btn.addEventListener('click', () => {
    if (!current) return;
    const key = keyOf(current);
    const on = !liked.has(key);

    if (on) liked.add(key);
    else liked.delete(key);
    save(liked);
    render();

    if (on) {
      // Neustart der Animation erzwingen, sonst laeuft sie beim zweiten Mal nicht
      btn.classList.remove('is-pop');
      void btn.offsetWidth;
      btn.classList.add('is-pop');
    }

    report(key, on);
  });

  btn.addEventListener('animationend', () => btn.classList.remove('is-pop'));

  document.addEventListener('tv:photo', (e) => {
    current = (e as CustomEvent<Photo>).detail;
    btn.classList.remove('is-pop');
    render();
  });

  render();
}
