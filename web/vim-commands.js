// Vim's file and tab commands, routed through the app's own Save/Save As/close
// paths so they get the same conflict checks, busy handling and unsaved-change
// rules as the menus. Each tab is one document, as a Vim tab page with one window.
//
// `:w`/`:write`, `:sav`/`:saveas`, `:wq`/`:x`/`:xit`, `:q`/`:quit` and their `!`
// forms act on the current tab; closing the last tab closes the window.
// `:qa`/`:qall` close every tab. As in Vim, `:q` with unsaved changes refuses
// with E37 instead of asking, and `:qa` refuses if any tab has them; `!`
// discards. `:w!` and `:wq!` save as usual: the app still asks before
// replacing a file that changed on disk.
//
// Tabs: `gt`/`gT` (with a count, `3gt` goes to tab 3 and `2gT` back two),
// `:tabnext`/`:tabn` [N], `:tabprevious`/`:tabp`/`:tabNext`/`:tabN` [N],
// `:tabnew`/`:tabedit` (an empty tab; file names are not supported) and
// `:tabclose`/`:tabc`, which is `:q` for the current tab.
// Normal-mode / opens the workspace note switcher; Insert-mode / stays text.

const bang = (params) => params.argString?.trim().startsWith('!') ?? false;
// Text after the command (apart from `!`), such as a file name.
const argument = (params) => params.argString?.trim().replace(/^!\s*/, '') ?? '';

const E37 = 'E37: No write since last change (add ! to override)';
const count = (params) => {
  const value = Number.parseInt(argument(params), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export function defineVimFileCommands(Vim, { run, save, saveAs, quickSearch, isDirty, close, message, tabs }) {
  Vim.defineAction('textgateQuickSearch', () => run(() => quickSearch()));
  Vim.mapCommand('/', 'action', 'textgateQuickSearch', {}, { context: 'normal' });
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
    if (!bang(params) && isDirty()) { message(E37); return; }
    run(() => close());
  };
  const quitAll = (cm, params) => {
    if (!bang(params) && tabs.anyDirty()) { message(E37); return; }
    run(() => tabs.closeAll());
  };
  // Counts are tab positions for gt and :tabnext, and steps back for gT and :tabprevious.
  const next = (repeat) => (repeat ? tabs.go(repeat) : tabs.step(1));
  Vim.defineAction('textgateTabNext', (cm, args) => next(args.repeatIsExplicit ? args.repeat : null));
  Vim.defineAction('textgateTabPrevious', (cm, args) => tabs.step(-args.repeat));
  Vim.mapCommand('gt', 'action', 'textgateTabNext', {}, { context: 'normal' });
  Vim.mapCommand('gT', 'action', 'textgateTabPrevious', {}, { context: 'normal' });
  Vim.defineEx('tabnext', 'tabn', (cm, params) => next(count(params)));
  const previous = (cm, params) => tabs.step(-(count(params) ?? 1));
  Vim.defineEx('tabprevious', 'tabp', previous);
  Vim.defineEx('tabNext', 'tabN', previous);
  Vim.defineEx('tabnew', 'tabnew', () => tabs.add());
  Vim.defineEx('tabedit', 'tabe', (cm, params) => {
    if (argument(params)) { message(':tabedit takes no file name here. Use File → Open.'); return; }
    tabs.add();
  });
  Vim.defineEx('tabclose', 'tabc', quit);
  Vim.defineEx('write', 'w', write);
  Vim.defineEx('saveas', 'sav', () => run(() => saveAs()));
  Vim.defineEx('wq', 'wq', writeQuit);
  Vim.defineEx('xit', 'x', writeQuit);
  Vim.defineEx('quit', 'q', quit);
  Vim.defineEx('qall', 'qa', quitAll);
}
