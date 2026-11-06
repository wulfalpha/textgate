// Capture inside the file-operation queue, so snapshots use the current tab
// list and cannot race a save, rename or close in that queue.
export function createSessionRecovery({ invoke, enqueue, capture, report,
  delay = 500, maxDelay = 3000, timers = globalThis }) {
  let active = false;
  let stopped = false;
  let quietTimer = null;
  let deadlineTimer = null;
  let pending = null;
  let changedWhilePending = false;

  function clearTimers() {
    timers.clearTimeout(quietTimer);
    timers.clearTimeout(deadlineTimer);
    quietTimer = deadlineTimer = null;
  }
  async function write(closed, snapshot = capture) {
    try {
      const checkpoint = await snapshot();
      await invoke('checkpoint_session', { checkpoint: { ...checkpoint, closed } });
      report('');
      return true;
    } catch (error) {
      report(`Recovery checkpoint failed: ${error?.message ?? error}. Save your documents to keep their latest edits.`);
      return false;
    }
  }
  function schedule() {
    if (!active || stopped) return;
    if (pending) { changedWhilePending = true; return; }
    timers.clearTimeout(quietTimer);
    quietTimer = timers.setTimeout(() => { void flush(); }, delay);
    deadlineTimer ??= timers.setTimeout(() => { void flush(); }, maxDelay);
  }
  function flush() {
    clearTimers();
    if (!active || stopped) return Promise.resolve(true);
    if (pending) return pending;
    pending = Promise.resolve().then(() => enqueue(async () => {
      if (!stopped) await write(false);
    })).finally(() => {
      pending = null;
      if (changedWhilePending) { changedWhilePending = false; schedule(); }
    });
    return pending;
  }
  return {
    restore: () => invoke('restore_session'),
    start() { active = true; stopped = false; schedule(); },
    schedule,
    flush,
    // Durable removal of an explicitly closed tab, inside its file action.
    commit: (snapshot = capture) => active ? write(false, snapshot) : Promise.resolve(true),
    // Called inside a file action: never enqueue or wait for another queued
    // action here. Older queued checkpoints see `stopped` and cannot revive
    // discarded work after this clean-close record.
    async finish() {
      stopped = true;
      clearTimers();
      if (!active) return true;
      const saved = await write(true);
      if (!saved) { stopped = false; schedule(); }
      return saved;
    },
    async resume() { stopped = false; return active ? write(false) : true; },
  };
}
