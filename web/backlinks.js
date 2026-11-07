// Coalesce edits and periodic reconciliation. A result may only paint the
// snapshot it queried, never a newer buffer, another tab or another workspace.
export async function openBacklink(entry, { findOpen, show, open }) {
  const existing = entry.document == null ? null : await findOpen(entry.document);
  if (existing) show(existing);
  else await open(entry.path);
}

export function createBacklinks({ capture, query, render, visible, timers = globalThis, delay = 300, interval = 5000 }) {
  let epoch = 0, pending = false, timer = null, disposed = false;
  const schedule = (wait) => {
    timers.clearTimeout(timer);
    if (!disposed && visible()) timer = timers.setTimeout(() => { void refresh(); }, wait);
  };
  async function refresh() {
    if (disposed || !visible()) return;
    if (pending) { schedule(delay); return; }
    pending = true;
    const revision = epoch;
    let snapshot;
    try {
      snapshot = capture();
      render({ busy: true, quiet: true });
      const result = await query(snapshot);
      if (!disposed && visible() && epoch === revision && snapshot.unchanged()) render({ result });
    } catch (error) {
      if (!disposed && visible() && epoch === revision && (!snapshot || snapshot.unchanged())) render({ error: error?.message ?? String(error) });
    } finally {
      pending = false;
      schedule(epoch === revision ? interval : delay);
    }
  }
  return {
    invalidate() { epoch++; timers.clearTimeout(timer); if (visible()) { render({ busy: true }); schedule(delay); } },
    refresh() { epoch++; schedule(0); },
    dispose() { disposed = true; epoch++; timers.clearTimeout(timer); },
  };
}

export function renderBacklinks({ document, container, status, warning, open }, { busy, quiet, result, error }) {
  if (busy) {
    container.setAttribute('aria-busy', 'true');
    for (const button of container.querySelectorAll('button')) button.disabled = true;
    if (!quiet || !container.dataset.backlinks) status.textContent = 'Updating backlinks…';
    return;
  }
  container.setAttribute('aria-busy', 'false');
  const fingerprint = JSON.stringify([result?.entries, result?.warnings, result?.scanned, error]);
  const unchanged = container.dataset.backlinks === fingerprint;
  container.dataset.backlinks = fingerprint;
  if (!unchanged) container.replaceChildren();
  else for (const button of container.querySelectorAll('button')) button.disabled = false;
  const warningText = result?.warnings?.length ? `Partial results: ${result.warnings.join(' ')}` : '';
  if (warning.textContent !== warningText) warning.textContent = warningText;
  const notes = new Set(result?.entries.map((entry) => entry.path)).size;
  const statusText = error ?? (result.entries.length
    ? `${result.warnings.length ? 'At least ' : ''}${notes} ${notes === 1 ? 'note' : 'notes'} · ${result.entries.length} ${result.entries.length === 1 ? 'link' : 'links'}`
    : result.warnings.length ? 'No backlinks found in the notes checked.' : 'No backlinks to this note.');
  if (status.textContent !== statusText) status.textContent = statusText;
  if (unchanged) return;
  for (const entry of result?.entries ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    const title = document.createElement('span');
    const context = document.createElement('span');
    title.textContent = `${entry.label ?? entry.path.split(/[\\/]/).at(-1)}:${entry.line}`;
    context.textContent = entry.context;
    button.title = entry.path;
    button.append(title, context);
    button.onclick = () => open(entry);
    container.append(button);
  }
}
