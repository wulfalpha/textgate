// Register first, then drain startup requests. The Rust queue is authoritative;
// events are wake-ups only, so requests arriving before JS starts are retained.
export async function setupExternalOpen({ desktop, listen, invoke, run, openPath, report }) {
  if (!desktop) return () => {};
  let draining = false, requested = false, disposed = false;
  async function drain() {
    requested = true;
    if (draining || disposed) return;
    draining = true;
    try {
      while (requested && !disposed) {
        requested = false;
        const requests = await invoke('take_open_requests');
        for (const request of requests) {
          if (disposed) break;
          await run.enqueue(async () => {
            if (request.kind === 'error') throw new Error(request.message);
            if (request.kind === 'file') await openPath(request.path, { create: request.create });
          });
        }
      }
    } catch (error) { report(error); }
    finally { draining = false; }
  }
  const unlisten = await listen('open-request', () => { void drain(); });
  await drain();
  return () => { disposed = true; unlisten(); };
}
