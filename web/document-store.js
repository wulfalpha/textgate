// The Rust side keeps the exact disk bytes of the open document and checks
// them before each save, so BOMs and mixed line endings never cause false
// conflicts and large files are not sent back and forth to compare.
export function createDocumentStore({ invoke, confirmOverwrite }) {
  return {
    async read(path, { create = false } = {}) {
      return new Uint8Array(await invoke('open_document', { path, allowMissing: create }));
    },
    // Call once the editor shows the opened document; opening can still be cancelled.
    remember(path) {
      return invoke('keep_document', { path });
    },
    // `chosen` means the native Save dialog picked the path and confirmed replacing it.
    async save(path, contents, { chosen = false } = {}) {
      let mode = chosen ? 'replace' : 'save';
      while (true) {
        try {
          await invoke('save_document', { path, contents, mode });
          return true;
        } catch (error) {
          if (error?.kind !== 'conflict') throw error;
          // Approval covers the disk version seen by this conflict only; a further
          // outside edit produces another conflict, never a forced save.
          if (!await confirmOverwrite(path, error.missing)) return false;
          mode = 'overwrite';
        }
      }
    },
  };
}
