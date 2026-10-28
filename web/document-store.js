// Keep the exact disk bytes separate from the normalized editor text. In
// particular, BOMs and mixed line endings must not trigger false conflicts.
export function createDocumentStore({ invoke, confirmOverwrite }) {
  let baselinePath = null;
  let baseline = null;
  return {
    async read(path) {
      const bytes = await invoke('document_snapshot', { path });
      if (bytes === null) throw new Error('The file no longer exists.');
      return new Uint8Array(bytes);
    },
    remember(path, bytes) {
      baselinePath = path;
      baseline = bytes === null ? null : Array.from(bytes);
    },
    async save(path, contents) {
      let expected = path === baselinePath
        ? baseline : await invoke('document_snapshot', { path });
      while (true) {
        try {
          await invoke('save_document', { path, contents, expected });
          baselinePath = path;
          baseline = Array.from(new TextEncoder().encode(contents));
          return true;
        } catch (error) {
          if (error?.kind !== 'conflict') throw error;
          // Read before asking: the retry approves exactly this disk version.
          // A further external edit produces another conflict, never a force-save.
          expected = await invoke('document_snapshot', { path });
          if (!await confirmOverwrite(path, expected === null)) return false;
        }
      }
    },
  };
}
