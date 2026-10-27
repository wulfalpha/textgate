// Themes are appended as text, never interpreted as HTML. The desktop CSP still
// applies to CSS resources; local config files do not become public asset URLs.
export function applyTheme(document, css) {
  let sheet = document.getElementById('custom-theme');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = 'custom-theme';
    document.head.append(sheet);
  }
  sheet.textContent = css;
}

export function setupThemes({ document, desktop, invoke }) {
  const $ = (id) => document.getElementById(id);
  const picker = $('theme-select');
  const reload = $('theme-reload');
  let selected = '';
  let running = false;
  let resetQueued = false;
  async function update(selection = null, announce = true) {
    if (running) {
      if (selection === '') resetQueued = true;
      return;
    }
    running = true;
    picker.disabled = reload.disabled = true;
    try {
      const state = await invoke('theme_state', { selection });
      const options = [['', 'Default'], ...state.themes.map((name) => [name, name])];
      picker.replaceChildren(...options.map(([value, label]) => {
        const option = document.createElement('option');
        option.value = value; option.textContent = label; return option;
      }));
      selected = state.selected;
      picker.value = selected;
      applyTheme(document, state.css);
      $('theme-directory').textContent = state.directory;
      if (state.warning || announce) $('status').textContent = state.warning ?? `Theme: ${selected || 'Default'}`;
    } catch (error) {
      picker.value = selected;
      $('status').textContent = `Theme error: ${error.message ?? error}`;
    } finally {
      running = false;
      picker.disabled = reload.disabled = false;
      if (resetQueued) { resetQueued = false; await update(''); }
    }
  }
  picker.onchange = () => update(picker.value);
  reload.onclick = () => update();
  $('theme-info').onclick = () => $('theme-dialog').showModal();
  $('theme-close').onclick = () => $('theme-dialog').close();
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === 'Digit0') {
      event.preventDefault();
      // Recovery works even when custom CSS has hidden the controls.
      applyTheme(document, '');
      if (desktop) update('');
    }
  });
  if (!desktop) {
    picker.disabled = reload.disabled = true;
    $('theme-directory').textContent = 'CSS theme files are available in the desktop app (npm run tauri dev).';
    return Promise.resolve();
  }
  return update(null, false);
}
