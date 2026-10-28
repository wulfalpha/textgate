// Native dialogs and writes can outlive the event that started them. Reject
// overlapping file actions visibly, and always release the guard after errors.
export function createActionRunner({ onBusy, onError }) {
  let busy = false;
  return async (action) => {
    if (busy) { onBusy(); return; }
    busy = true;
    try { await action(); }
    catch (error) { onError(error); }
    finally { busy = false; }
  };
}
