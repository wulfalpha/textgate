import { isolateHistory } from '@codemirror/commands';

export function renameTransaction(state, edits) {
  for (const edit of edits) {
    const before = edit.before.replace(/\r\n?/g, '\n');
    if (state.doc.sliceString(edit.from, edit.to) !== before) throw new Error('A source changed before its editor patch. Remaining updates stopped.');
  }
  return state.update({ changes: edits.map(({ from, to, insert }) => ({ from, to, insert: insert.replace(/\r\n?/g, '\n') })),
    userEvent: 'input.rename', annotations: isolateHistory.of('full') });
}

export function askRenamePreview(document, initial, { apply, acknowledge, review }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('rename-preview-dialog');
  let preview = initial, result = null, busy = false, stopped = false, settled = false;
  const show = () => {
    $('rename-preview-title').textContent = preview.retry ? 'Review remaining link updates' : 'Rename note and update links?';
    $('rename-preview-name').textContent = `${preview.from} → ${preview.to}`;
    $('rename-preview-warning').textContent = preview.issues.join('\n');
    $('rename-preview-status').textContent = `${preview.files.length} affected ${preview.files.length === 1 ? 'note' : 'notes'}. Open notes stay unsaved; closed notes are written to disk. ID links stay unchanged. Rename Only may leave name-based links broken.`;
    $('rename-update').disabled = preview.issues.length > 0;
    $('rename-only').disabled = false;
    $('rename-only').textContent = preview.retry ? 'Keep Rename Only' : 'Rename Only';
    $('rename-update').hidden = $('rename-only').hidden = false;
    $('rename-preview-cancel').textContent = 'Cancel';
    $('rename-stop').hidden = $('rename-review').hidden = true;
    $('rename-preview-error').textContent = '';
    const changes = preview.files.flatMap((file) => file.edits.map((edit) => ({ file, edit })));
    const container = $('rename-preview-changes');
    container.replaceChildren();
    let count = 0;
    const more = document.createElement('button'); more.type = 'button';
    const append = () => {
      more.remove();
      for (const { file, edit } of changes.slice(count, count + 100)) {
        const item = document.createElement('section');
        const title = document.createElement('h4');
        title.textContent = `${file.label}:${edit.line} · ${file.editor ? 'Editor only (unsaved)' : 'Disk write'} · ${file.edits.length} ${file.edits.length === 1 ? 'replacement' : 'replacements'}`;
        const before = document.createElement('pre'), after = document.createElement('pre');
        before.textContent = `Before: ${edit.context}`; after.textContent = `After:  ${edit.after_context}`;
        item.append(title, before, after); container.append(item);
      }
      count += 100;
      if (count < changes.length) { more.textContent = `Show next changes (${changes.length - count} remaining)`; container.append(more); }
    };
    more.onclick = append; append();
    if (!changes.length) container.textContent = 'No name-based links need changes in the notes scanned.';
  };
  show();
  return new Promise((resolve) => {
    const done = (value) => {
      if (settled) return; settled = true;
      dialog.removeEventListener('cancel', escape);
      dialog.removeEventListener('close', closed);
      for (const id of ['rename-update', 'rename-only', 'rename-preview-cancel', 'rename-stop', 'rename-review']) $(id).onclick = null;
      if (dialog.open) dialog.close(); resolve(value);
    };
    const finish = async () => {
      if (busy || settled) return;
      busy = true;
      $('rename-preview-cancel').disabled = $('rename-review').disabled = true;
      try {
        if (result) await acknowledge(result);
        done(result);
      } catch (error) { $('rename-preview-error').textContent = error?.message ?? String(error); }
      finally { busy = false; $('rename-preview-cancel').disabled = $('rename-review').disabled = false; }
    };
    const escape = (event) => { event.preventDefault(); if (!busy) void finish(); };
    const closed = () => { if (!settled && !busy) done(result); };
    const execute = async (update) => {
      if (busy) return; busy = true; stopped = false;
      $('rename-update').disabled = $('rename-only').disabled = $('rename-preview-cancel').disabled = true;
      $('rename-stop').hidden = false; $('rename-stop').disabled = false;
      $('rename-review').hidden = true;
      try {
        result = await apply(preview, update, {
          stopped: () => stopped,
          progress: (message) => { $('rename-preview-status').textContent = message; },
        });
        $('rename-preview-title').textContent = result.rename_done ? 'Rename result' : 'Rename did not complete';
        const editors = result.editor_files?.length ?? 0;
        $('rename-preview-status').textContent = `${result.rename_done ? 'The note was renamed. ' : ''}${editors} open ${editors === 1 ? 'note' : 'notes'} updated and unsaved; ${result.written} closed ${result.written === 1 ? 'file' : 'files'} written; ${result.pending} pending.`;
        $('rename-preview-error').textContent = result.error ?? '';
        const detail = [];
        for (const [title, files] of [['Editor changes (unsaved)', result.editor_files], ['Written', result.written_files], ['Pending (unchanged)', result.pending_files]]) {
          if (files?.length) detail.push(`${title}:\n${files.join('\n')}`);
        }
        $('rename-preview-changes').textContent = detail.join('\n\n') || 'No source contents were changed.';
        $('rename-update').hidden = $('rename-only').hidden = true;
        $('rename-review').hidden = !result.error && !result.pending;
        $('rename-preview-cancel').textContent = 'Acknowledge and Close';
      } catch (error) {
        $('rename-preview-error').textContent = `${error?.message ?? error} Cancel and start again for a fresh preview.`;
        $('rename-preview-cancel').textContent = 'Cancel';
      } finally {
        busy = false; $('rename-preview-cancel').disabled = false; $('rename-stop').hidden = true;
      }
    };
    $('rename-update').onclick = () => { void execute(true); };
    $('rename-only').onclick = () => { void execute(false); };
    $('rename-preview-cancel').onclick = () => { void finish(); };
    $('rename-stop').onclick = () => { stopped = true; $('rename-stop').disabled = true; $('rename-preview-status').textContent = 'Stopping after the current step. Completed changes will be retained.'; };
    $('rename-review').onclick = async () => {
      if (busy || !result) return; busy = true;
      try { preview = await review(result); result = null; show(); }
      catch (error) { $('rename-preview-error').textContent = error?.message ?? String(error); }
      finally { busy = false; }
    };
    dialog.addEventListener('cancel', escape);
    dialog.addEventListener('close', closed);
    dialog.showModal(); $('rename-preview-cancel').focus();
  });
}
