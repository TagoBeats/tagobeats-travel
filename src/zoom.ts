/**
 * Pinch-Zoom auf dem aktiven Foto.
 *
 * Wichtigste Randbedingung: der Einfinger-Wisch bleibt komplett nativ. Der Rahmen
 * traegt im Normalzustand touch-action:pan-x, das Blaettern macht also weiter
 * scroll-snap und wir fassen es nicht an. Angefasst wird nur, was mit zwei Fingern
 * passiert, plus das Schieben im bereits gezoomten Bild. Grund fuer die Vorsicht ist
 * der eingefrorene Instagram-Webview vom 15.07., der kam von selbstgebautem Scrolling.
 */

const MAX_SCALE = 4;
const TAP_MS = 250;
const TAP_SLOP = 14;
const DOUBLE_TAP_MS = 300;

interface Zoom { s: number; tx: number; ty: number; }

const IDENTITY: Zoom = { s: 1, tx: 0, ty: 0 };

export function createZoom(track: HTMLElement) {
  const zooms = new WeakMap<HTMLElement, Zoom>();
  const pointers = new Map<number, { x: number; y: number }>();

  let frame: HTMLElement | null = null;
  let pinchDist = 0;
  let pinchStart: Zoom = IDENTITY;
  let pinchMid = { x: 0, y: 0 };
  let panLast: { x: number; y: number } | null = null;
  let lockedLeft = 0;

  let downAt = 0;
  let downPos = { x: 0, y: 0 };
  let lastTapAt = 0;
  let lastTapPos = { x: 0, y: 0 };

  const get = (f: HTMLElement) => zooms.get(f) ?? IDENTITY;

  /** Punkt relativ zur Rahmenmitte. Der Rahmen selbst wird nie transformiert. */
  function rel(f: HTMLElement, x: number, y: number) {
    const r = f.getBoundingClientRect();
    return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) };
  }

  function clamp(f: HTMLElement, z: Zoom): Zoom {
    const s = Math.min(MAX_SCALE, Math.max(1, z.s));
    if (s === 1) return { s: 1, tx: 0, ty: 0 };
    const r = f.getBoundingClientRect();
    const mx = ((s - 1) * r.width) / 2;
    const my = ((s - 1) * r.height) / 2;
    return {
      s,
      tx: Math.max(-mx, Math.min(mx, z.tx)),
      ty: Math.max(-my, Math.min(my, z.ty)),
    };
  }

  /**
   * Ausgeliefert wird normalerweise die Breite, die auf den Bildschirm passt. Beim
   * Reinzoomen ist die zu weich, also das sizes-Attribut hochdrehen: der Browser
   * waehlt daraufhin die naechstgroessere Stufe aus dem srcset.
   */
  function setDetail(f: HTMLElement, on: boolean) {
    if ((f.dataset.detail === '1') === on) return;
    f.dataset.detail = on ? '1' : '';
    const width = Math.round(f.getBoundingClientRect().width * MAX_SCALE);
    for (const s of f.querySelectorAll('source')) {
      if (!s.dataset.sizes) s.dataset.sizes = s.sizes;
      s.sizes = on ? `${width}px` : s.dataset.sizes;
    }
  }

  function apply(f: HTMLElement, z: Zoom) {
    zooms.set(f, z);
    const pic = f.querySelector('picture') as HTMLElement | null;
    if (pic) pic.style.transform = z.s === 1 ? '' : `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
    // touch-action:none greift erst beim naechsten Gestenstart, deshalb setzen wir es
    // ueber die Klasse mit, sobald gezoomt ist: das Schieben gehoert dann uns
    const zoomed = z.s > 1.01;
    f.classList.toggle('is-zoomed', zoomed);
    setDetail(f, zoomed);
  }

  function reset(f: HTMLElement | null) {
    if (!f) return;
    if (get(f).s !== 1) apply(f, IDENTITY);
  }

  /** Skaliert um einen Ankerpunkt, sodass der Bildpunkt darunter liegen bleibt. */
  function scaleAround(f: HTMLElement, from: Zoom, anchor: { x: number; y: number }, at: { x: number; y: number }, s: number) {
    const cx = (anchor.x - from.tx) / from.s;
    const cy = (anchor.y - from.ty) / from.s;
    return clamp(f, { s, tx: at.x - s * cx, ty: at.y - s * cy });
  }

  /* ---------------------------------------------------------------- Zeiger */

  track.addEventListener('pointerdown', (e) => {
    const f = (e.target as HTMLElement).closest('.tv-frame') as HTMLElement | null;
    if (!f) return;
    if (frame && f !== frame) reset(frame);
    frame = f;

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      downAt = performance.now();
      downPos = { x: e.clientX, y: e.clientY };
      panLast = get(f).s > 1 ? { x: e.clientX, y: e.clientY } : null;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pinchStart = get(f);
      pinchMid = rel(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
      panLast = null;
      // Der Track hat beim Gestenstart noch pan-x erlaubt und koennte mitwandern.
      // Wir merken uns die Position und halten sie waehrend der Geste fest.
      lockedLeft = track.scrollLeft;
    }
  });

  track.addEventListener(
    'pointermove',
    (e) => {
      if (!frame || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = rel(frame, (a.x + b.x) / 2, (a.y + b.y) / 2);
        apply(frame, scaleAround(frame, pinchStart, pinchMid, mid, pinchStart.s * (dist / pinchDist)));
        if (track.scrollLeft !== lockedLeft) track.scrollLeft = lockedLeft;
        e.preventDefault();
        return;
      }

      const z = get(frame);
      if (z.s > 1 && panLast) {
        apply(frame, clamp(frame, { s: z.s, tx: z.tx + (e.clientX - panLast.x), ty: z.ty + (e.clientY - panLast.y) }));
        panLast = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    },
    { passive: false }
  );

  function release(e: PointerEvent) {
    if (!pointers.delete(e.pointerId)) return;
    const f = frame;

    if (pointers.size === 1 && f) {
      const p = [...pointers.values()][0];
      panLast = get(f).s > 1 ? { x: p.x, y: p.y } : null;
      pinchDist = 0;
      return;
    }
    if (pointers.size > 0) return;

    panLast = null;
    if (!f) return;

    // Unter 1.02 zurueckfedern, sonst bleibt ein unsichtbarer Zoom-Zustand haengen
    const z = get(f);
    if (z.s <= 1.02 && z.s !== 1) apply(f, IDENTITY);

    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    const isTap = performance.now() - downAt < TAP_MS && moved < TAP_SLOP;
    if (!isTap) return;

    const now = performance.now();
    const near = Math.hypot(e.clientX - lastTapPos.x, e.clientY - lastTapPos.y) < 30;
    if (now - lastTapAt < DOUBLE_TAP_MS && near) {
      lastTapAt = 0;
      const cur = get(f);
      if (cur.s > 1) apply(f, IDENTITY);
      else {
        const at = rel(f, e.clientX, e.clientY);
        apply(f, scaleAround(f, IDENTITY, at, at, 2.5));
      }
    } else {
      lastTapAt = now;
      lastTapPos = { x: e.clientX, y: e.clientY };
    }
  }

  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) panLast = null;
  });

  // Beim Blaettern faellt der Zoom weg, sonst landet man auf dem naechsten Foto
  // in einem Ausschnitt, den man nie gewaehlt hat
  document.addEventListener('tv:photo', () => {
    reset(frame);
    frame = null;
    pointers.clear();
    panLast = null;
  });

  return { reset: () => reset(frame) };
}

/**
 * Die Seite selbst bleibt bei 100 Prozent. maximum-scale reicht dafuer nicht,
 * iOS Safari ignoriert es seit Jahren, deshalb zusaetzlich die gesture-Events
 * abfangen. Einfinger-Gesten bleiben unberuehrt.
 */
export function lockPageScale() {
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
}
