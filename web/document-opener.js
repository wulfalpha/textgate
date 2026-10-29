import { decodeDocument } from './document-format.js';

// Both dialogs and native launches use this transaction. Reading/decoding must
// succeed and discard approval must cover the latest editor contents before
// the visible buffer (and then its Rust save baseline) is replaced.
export function createDocumentOpener({ documents, snapshot, canDiscard, replace, opened }) {
  return async (path, { create = false, approved } = {}) => {
    async function approveLatest() {
      while (true) {
        const current = snapshot();
        if (approved && current.eq(approved)) return true;
        if (!await canDiscard()) return false;
        if (snapshot().eq(current)) { approved = current; return true; }
        // Editing can continue while a native confirmation is on screen.
      }
    }
    if (!await approveLatest()) return false;
    const bytes = await documents.read(path, { create });
    const { text, format } = decodeDocument(bytes);
    if (!await approveLatest()) return false;
    // No await between the final check and replacing the document. A subsequent
    // IPC acknowledgement must not open a gap in which edits can be discarded.
    replace(text, path, format);
    await documents.remember(path);
    opened(path, format);
    return true;
  };
}
