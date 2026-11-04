import { decodeDocument } from './document-format.js';

// Dialogs and native launches open files through here. Each file gets its own
// tab, so opening never replaces unsaved work and needs no discard prompt.
//
// - `existing(path)`: the tab showing exactly this path, if any.
// - `holder(id)`: the tab whose Rust document has this id (the same file
//   reached through another path, such as a linked folder).
// - `show(tab, { focus })`: switch to a tab that already has the file.
// - `place(opened, { focus })`: show a newly read file, in a new tab or a blank
//   Untitled one. `focus: false` leaves keyboard focus where it is.
export function createDocumentOpener({ documents, existing, holder, show, place }) {
  return async (path, { create = false, focus = true } = {}) => {
    const open = existing(path);
    if (open) { show(open, { focus }); return { tab: open, already: true }; }
    // Read through a fresh document so a failure leaves every tab untouched.
    const file = documents.create();
    try {
      const { text, format } = decodeDocument(await file.read(path, { create }));
      await file.remember(path);
      return { tab: place({ text, path, format, file }, { focus }), format, already: false };
    } catch (error) {
      await file.close();
      const tab = error?.kind === 'alreadyOpen' ? await holder(error.document) : null;
      if (!tab) throw error;
      show(tab, { focus });
      return { tab, already: true };
    }
  };
}
