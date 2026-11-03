// Vim's file commands, routed through the app's own Save/Save As/quit paths so
// they get the same conflict checks, busy handling and unsaved-change rules as
// the menus. Textgate edits one document per window, so quitting closes it.
//
// `:w`/`:write`, `:sav`/`:saveas`, `:wq`/`:x`/`:xit`, `:q`/`:quit`, `:qa`/`:qall`
// and their `!` forms. As in Vim, `:q` with unsaved changes refuses with E37
// instead of asking; `:q!` discards them. `:w!` and `:wq!` save as usual: the
// app still asks before replacing a file that changed on disk.

const bang = (params) => params.argString?.trim().startsWith('!') ?? false;
// Text after the command (apart from `!`), such as a file name.
const argument = (params) => params.argString?.trim().replace(/^!\s*/, '') ?? '';

export function defineVimFileCommands(Vim, { run, save, saveAs, isDirty, close, message }) {
  function plain(params, name) {
    if (!argument(params)) return true;
    message(`:${name} takes no file name here. Use :saveas to choose a new file.`);
    return false;
  }
  const write = (cm, params) => { if (plain(params, 'write')) run(() => save()); };
  const writeQuit = (cm, params) => {
    if (!plain(params, params.commandName)) return;
    run(async () => { if (await save()) await close(); });
  };
  const quit = (cm, params) => {
    if (!bang(params) && isDirty()) {
      message('E37: No write since last change (add ! to override)');
      return;
    }
    run(() => close());
  };
  Vim.defineEx('write', 'w', write);
  Vim.defineEx('saveas', 'sav', () => run(() => saveAs()));
  Vim.defineEx('wq', 'wq', writeQuit);
  Vim.defineEx('xit', 'x', writeQuit);
  Vim.defineEx('quit', 'q', quit);
  Vim.defineEx('qall', 'qa', quit);
}
