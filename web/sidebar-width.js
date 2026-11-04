// The sidebar's width: dragged by its edge or set with the arrow keys on that
// edge (a focusable separator), reset by double-click, and remembered per device.
export const sidebarWidths = { min: 140, max: 480, step: 16, fallback: 190 };
const key = 'textgate.sidebar-width';

export function clampWidth(value, available = Infinity) {
  // Leave room for the editor even in a narrow window.
  const max = Math.max(sidebarWidths.min, Math.min(sidebarWidths.max, available * 0.45));
  return Math.round(Math.min(max, Math.max(sidebarWidths.min, value)));
}

export function setupSidebarWidth({ handle, main, storage, window }) {
  const read = () => {
    try { const value = Number(storage?.getItem(key)); return Number.isFinite(value) && value > 0 ? value : null; } catch { return null; }
  };
  let width = read();
  const current = () => width ?? main.querySelector('aside')?.getBoundingClientRect().width ?? sidebarWidths.fallback;
  function apply(value, { save = true } = {}) {
    width = value === null ? null : clampWidth(value, window.innerWidth);
    if (width === null) main.style.removeProperty('--sidebar-width');
    else main.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(current())));
    if (!save) return;
    try { width === null ? storage?.removeItem(key) : storage?.setItem(key, String(width)); } catch { /* keep it for this session */ }
  }
  handle.setAttribute('aria-valuemin', String(sidebarWidths.min));
  handle.setAttribute('aria-valuemax', String(sidebarWidths.max));
  apply(width, { save: false });

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX - current();
    handle.setPointerCapture?.(event.pointerId);
    main.classList.add('resizing');
    const move = (next) => apply(next.clientX - start, { save: false });
    const done = () => {
      handle.removeEventListener('pointermove', move);
      main.classList.remove('resizing');
      apply(current());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done, { once: true });
    handle.addEventListener('pointercancel', done, { once: true });
  });
  handle.addEventListener('dblclick', () => apply(null));
  handle.addEventListener('keydown', (event) => {
    const change = { ArrowLeft: -sidebarWidths.step, ArrowRight: sidebarWidths.step }[event.key];
    if (change) apply(current() + change);
    else if (event.key === 'Home') apply(sidebarWidths.min);
    else if (event.key === 'End') apply(sidebarWidths.max);
    else if (event.key === 'Enter') apply(null);
    else return;
    event.preventDefault();
  });
  // A smaller window may no longer fit a width chosen in a larger one.
  window.addEventListener('resize', () => { if (width !== null) apply(width, { save: false }); });
}
