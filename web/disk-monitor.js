// One queued scan at a time. Focus requests coalesce, and periodic scans cannot
// accumulate behind an open save/discard dialog.
export function createDiskMonitor({ enqueue, invoke, update, refreshTree, report,
  folders = () => [], timers = globalThis, interval = 1000 }) {
  let running = false;
  let pending = null;
  let forced = false;
  let timer = null;
  function schedule() {
    if (running) timer = timers.setTimeout(() => { void scan(); }, interval);
  }
  function scan(force = false) {
    forced ||= force;
    if (pending) return pending;
    timers.clearTimeout(timer);
    pending = Promise.resolve().then(() => enqueue(async () => {
      const requested = forced;
      forced = false;
      try {
        const result = await invoke('poll_disk_changes', { force: requested, folders: folders() });
        report(result.warning ?? '');
        if (result.scan) {
          await update(result.documents);
          await refreshTree();
        }
      } catch (error) {
        report(`File-change checks failed: ${error?.message ?? error}. Save still checks for conflicts.`);
      }
    })).finally(() => {
      pending = null;
      if (forced && running) void scan();
      else schedule();
    });
    return pending;
  }
  return {
    scan,
    start() { if (running) return; running = true; void scan(true); },
    stop() { running = false; forced = false; timers.clearTimeout(timer); },
  };
}

// Reading stages a native baseline. Commit it only after the editor has
// synchronously accepted the bytes, so typing during a read cannot be lost.
export async function reloadDiskTab({ tab, snapshot, unchanged, decode, apply }) {
  const before = snapshot(tab);
  const path = tab.path;
  const opened = decode(await tab.file.read(path));
  if (tab.path !== path || !unchanged(tab, before)) return false;
  apply(tab, opened);
  try { await tab.file.remember(path); }
  catch (error) {
    tab.recovered = true;
    throw error;
  }
  return true;
}
