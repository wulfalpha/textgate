// One native scan at a time. Typing, refreshing and closing invalidate older
// responses; no stale result can become an Enter/click target.
export function askQuickSearch(document, { query, delay = 150, interval = 5000 }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('quick-search-dialog'), input = $('quick-search-input'), list = $('quick-search-results');
  const previousFocus = document.activeElement;
  let timer, revision = 0, running = false, queued = false, settled = false, busy = true, entries = [], selected = 0;
  input.value = ''; list.replaceChildren(); input.removeAttribute('aria-activedescendant');
  $('quick-search-warning').textContent = '';
  return new Promise((resolve) => {
    const finish = (entry = null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      input.oninput = input.onkeydown = null;
      $('quick-search-cancel').onclick = $('quick-search-refresh').onclick = null;
      dialog.removeEventListener('cancel', cancel); dialog.removeEventListener('close', closed);
      if (dialog.open) dialog.close(); previousFocus?.focus(); resolve(entry);
    };
    const cancel = (event) => { event.preventDefault(); finish(); };
    const closed = () => finish();
    const select = (index) => {
      selected = index;
      [...list.children].forEach((row, i) => row.setAttribute('aria-selected', String(i === selected)));
      if (entries.length) {
        input.setAttribute('aria-activedescendant', `quick-note-${selected}`);
        list.children[selected]?.scrollIntoView?.({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    };
    const choose = (index) => { if (!busy && entries[index]) finish(entries[index]); };
    const schedule = (wait) => { clearTimeout(timer); if (!settled) timer = setTimeout(scan, wait); };
    const invalidate = () => {
      revision++; busy = true; entries = []; list.replaceChildren(); input.removeAttribute('aria-activedescendant');
      list.setAttribute('aria-busy', 'true'); $('quick-search-status').textContent = 'Searching notes…';
      $('quick-search-warning').textContent = ''; schedule(delay);
    };
    async function scan() {
      if (settled) return;
      if (running) { queued = true; return; }
      running = true; queued = false;
      const version = revision, text = input.value;
      try {
        const result = await query(text);
        if (settled || version !== revision || input.value !== text) return;
        // Selection can change while a periodic scan is running. Preserve the
        // currently highlighted path, not the one highlighted when it started.
        const previous = entries[selected]?.path;
        entries = result.entries; busy = false; list.replaceChildren();
        $('quick-search-warning').textContent = result.warnings.length ? `Partial results: ${result.warnings.join(' ')}` : '';
        $('quick-search-status').textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'note' : 'notes'}. ↑/↓ to select, Enter to open.`
          : result.warnings.length ? 'No matches in the notes checked.' : 'No matching notes.';
        entries.forEach((entry, i) => {
          const row = document.createElement('div'); row.id = `quick-note-${i}`; row.setAttribute('role', 'option');
          row.textContent = entry.label; row.title = entry.path;
          row.onmousedown = (event) => event.preventDefault();
          row.onclick = () => choose(i); list.append(row);
        });
        select(Math.max(0, entries.findIndex((entry) => entry.path === previous)));
      } catch (error) {
        if (!settled && version === revision) {
          busy = true; entries = []; list.replaceChildren(); input.removeAttribute('aria-activedescendant');
          $('quick-search-status').textContent = error?.message ?? String(error);
        }
      } finally {
        running = false;
        if (!settled) { list.setAttribute('aria-busy', String(busy)); schedule(queued || version !== revision ? 0 : interval); }
      }
    }
    input.oninput = invalidate;
    input.onkeydown = (event) => {
      if (event.isComposing) return;
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) event.preventDefault();
      if (event.key === 'Escape') finish();
      else if (event.key === 'Enter') choose(selected);
      else if (!busy && entries.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) select((selected + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length);
    };
    $('quick-search-refresh').onclick = invalidate;
    $('quick-search-cancel').onclick = () => finish();
    dialog.addEventListener('cancel', cancel); dialog.addEventListener('close', closed);
    dialog.showModal(); input.focus(); invalidate();
  });
}
