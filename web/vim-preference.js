const key = 'textgate.vim';

export function readVimEnabled(storage) {
  try { return storage?.getItem(key) === 'on'; } catch { return false; }
}

export function storeVimEnabled(storage, enabled) {
  try { storage?.setItem(key, enabled ? 'on' : 'off'); } catch { /* keep the session setting */ }
}
