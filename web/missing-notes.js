// Confirmation is separate from lookup and performs no writes until submit.
export async function askMissingNote(document, proposal, submit) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('missing-note-dialog');
  const choice = $('missing-note-id');
  choice.checked = proposal.canId;
  $('missing-note-choice').hidden = !proposal.canId || Boolean(proposal.filenameError);
  $('missing-note-description').textContent = proposal.filenameError
    ? `No matching note was found. ${proposal.filenameError}`
    : 'No matching note was found. Create it?';
  $('missing-note-error').textContent = '';
  const showPath = () => {
    $('missing-note-path').textContent = choice.checked
      ? `Create ${proposal.title ? `ID ${proposal.title}.md` : 'ID.md'} in the open folder. Update this wiki link to its ID; the source stays unsaved.`
      : `Create ${proposal.path}. Keep the link unchanged.`;
  };
  choice.onchange = showPath;
  showPath();
  return new Promise((resolve) => {
    let busy = false, settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', cancel);
      dialog.removeEventListener('cancel', preventBusyCancel);
      $('missing-note-form').onsubmit = $('missing-note-cancel').onclick = choice.onchange = null;
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const cancel = () => { if (!busy) done(null); };
    const preventBusyCancel = (event) => { if (busy) event.preventDefault(); };
    $('missing-note-cancel').onclick = cancel;
    $('missing-note-form').onsubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      $('missing-note-create').disabled = $('missing-note-cancel').disabled = choice.disabled = true;
      try { done(await submit(choice.checked)); }
      catch (error) { $('missing-note-error').textContent = error?.message ?? String(error); }
      finally { busy = false; $('missing-note-create').disabled = $('missing-note-cancel').disabled = choice.disabled = false; }
    };
    dialog.addEventListener('close', cancel);
    dialog.addEventListener('cancel', preventBusyCancel);
    dialog.showModal();
    $('missing-note-cancel').focus();
  });
}

