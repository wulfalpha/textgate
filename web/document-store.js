// The Rust side keeps the exact disk bytes of each open document and checks
// them before each save, so BOMs and mixed line endings never cause false
// conflicts and large files are not sent back and forth to compare.
//
// Each tab gets a handle bound to its own Rust document. The Rust id is
// created on the first file operation, so an Untitled tab that never touches
// the disk needs none.
export function createDocumentStore({ invoke, confirmOverwrite }) {
  return {
    create({ document: restoredId = null } = {}) {
      let id = restoredId === null ? null : Promise.resolve(restoredId);
      let closed = false;
      const document = () => {
        if (closed) return Promise.reject(new Error('This document is no longer open.'));
        id ??= invoke('new_document');
        return id;
      };
      return {
        // The Rust id, or null before the first file operation.
        async id() { return id && await id; },
        // Recovery includes Untitled buffers, which may not have touched disk.
        async ensureId() { return document(); },
        async read(path, { create = false } = {}) {
          return new Uint8Array(await invoke('open_document', { document: await document(), path, allowMissing: create }));
        },
        // Call once the editor shows the opened document; opening can still be cancelled.
        async remember(path) {
          return invoke('keep_document', { document: await document(), path });
        },
        // `chosen` means the native Save dialog picked the path and confirmed replacing it.
        async save(path, contents, { chosen = false } = {}) {
          let mode = chosen ? 'replace' : 'save';
          while (true) {
            try {
              await invoke('save_document', { document: await document(), path, contents, mode });
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
        // Releases the file so another tab may open it.
        async close() {
          closed = true;
          if (id) await invoke('close_document', { document: await id });
        },
      };
    },
  };
}
