/**
 * Ladebalken: 0 bis 90 Prozent zuegig, danach kriecht er asymptotisch weiter.
 * Die Obergrenze des Kriechens haengt am echten Ladefortschritt, damit die
 * letzten zehn Prozent nicht gelogen sind. 100 ist erst erreicht, wenn alle
 * angemeldeten Aufgaben durch sind.
 */

const FAST_MS = 600;
const FAST_TARGET = 0.9;
const HARD_TIMEOUT = 9000;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    p.then(() => { window.clearTimeout(timer); resolve(); },
           () => { window.clearTimeout(timer); resolve(); });
  });
}

export function createLoader() {
  const bar = document.getElementById('tv-bar') as HTMLElement;
  const boot = document.getElementById('tv-boot') as HTMLElement;
  const enter = document.getElementById('tv-enter') as HTMLButtonElement;

  let total = 0;
  let done = 0;
  const jobs: Promise<void>[] = [];

  function track(promise: Promise<unknown>, timeout = 6000) {
    total++;
    jobs.push(withTimeout(promise, timeout).then(() => { done++; }));
  }

  /** Laeuft bis 100 Prozent, zeigt dann den Enter-Screen und wartet auf den Tap. */
  function run(): Promise<void> {
    const t0 = performance.now();
    let p = 0;
    let allDone = false;

    Promise.race([
      Promise.all(jobs),
      new Promise((r) => window.setTimeout(r, HARD_TIMEOUT)),
    ]).then(() => { allDone = true; });

    return new Promise<void>((resolve) => {
      const step = () => {
        const elapsed = performance.now() - t0;

        if (elapsed < FAST_MS && !allDone) {
          p = FAST_TARGET * easeOut(elapsed / FAST_MS);
        } else {
          // Kriechen: Decke steigt mit jedem erledigten Job
          const progress = total ? done / total : 1;
          const ceiling = allDone ? 1 : FAST_TARGET + 0.09 * progress;
          p += (ceiling - p) * (allDone ? 0.2 : 0.045);
        }

        bar.style.width = `${Math.min(100, p * 100).toFixed(2)}%`;

        if (allDone && p > 0.995) {
          bar.style.width = '100%';
          finish(resolve);
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function finish(resolve: () => void) {
    enter.classList.add('is-on');
    let entered = false;
    const go = () => {
      if (entered) return;
      entered = true;
      boot.classList.add('is-gone');
      window.setTimeout(() => boot.remove(), 700);
      resolve();
    };
    // Der ganze Screen ist die Trefferflaeche, nicht nur die Schrift
    boot.addEventListener('click', go);

    // ?enter ueberspringt den Tap. Nur fuer Screenshots und Debugging,
    // ohne echte Geste bleibt der Ton stumm.
    if (new URLSearchParams(location.search).has('enter')) window.setTimeout(go, 60);
  }

  return { track, run };
}
