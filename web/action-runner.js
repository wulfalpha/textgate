// User menu actions still reject overlaps visibly. Native file-open requests
// queue behind dialogs/writes so a second launch cannot silently lose its file.
export function createActionRunner({ onBusy, onError, onQueued = () => {} }) {
  let busy = false;
  const pending = [];
  async function execute(action) {
    busy = true;
    try { await action(); }
    catch (error) { onError(error); }
    finally {
      busy = false;
      const next = pending.shift();
      if (next) void execute(next.action).finally(next.resolve);
    }
  }
  const run = async (action) => {
    if (busy) { onBusy(); return; }
    await execute(action);
  };
  run.enqueue = (action, { silent = false } = {}) => new Promise((resolve) => {
    if (busy) { pending.push({ action, resolve }); if (!silent) onQueued(); }
    else void execute(action).finally(resolve);
  });
  return run;
}
