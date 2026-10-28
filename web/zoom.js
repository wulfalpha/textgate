// Zoom scales the whole window, as browsers do, so every pane, menu and dialog
// grows together. The level is a per-device preference kept in local storage.
export const zoomLevels = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const key = 'textgate.zoom';

function read(storage) {
  try {
    const value = Number(storage?.getItem(key));
    return zoomLevels.includes(value) ? value : 1;
  } catch { return 1; }
}

export function createZoom({ setZoom, storage, onChange = () => {} }) {
  let level = read(storage);
  async function apply(next) {
    await setZoom(next);
    level = next;
    try { storage?.setItem(key, String(next)); } catch { /* private mode: keep it for this session */ }
    onChange(level);
    return level;
  }
  return {
    get level() { return level; },
    restore: () => (level === 1 ? Promise.resolve(level) : apply(level)),
    in: () => apply(zoomLevels.find((value) => value > level) ?? level),
    out: () => apply(zoomLevels.findLast((value) => value < level) ?? level),
    reset: () => apply(1),
  };
}
