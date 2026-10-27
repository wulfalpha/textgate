import { setupThemes } from './themes.js';
import { setupMenus } from './menus.js';
import packageInfo from '../package.json' with { type: 'json' };
import { syntaxHighlighting } from '@codemirror/language';
import { fencedLanguage } from './source-language.js';
import { indentWithTab, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { classHighlighter, tagHighlighter, tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { vim, getCM } from '@replit/codemirror-vim';
import createDOMPurify from 'dompurify';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save, confirm } from '@tauri-apps/plugin-dialog';
import { readFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { decodeDocument, encodeDocument, defaultFormat, lineEndingLabel } from './document-format.js';
import { headings, createRenderer } from './markdown.js';
import { livePreview } from './live-preview.js';
import * as format from './markdown-commands.js';
const DOMPurify = createDOMPurify(window);
const render = createRenderer({ desktop: isTauri(), invoke, purifier: DOMPurify });

const $ = (id) => document.getElementById(id);
const initial = '# Welcome to Textgate\n\nA quiet place to write Markdown.\n\n## Start writing\n\nOpen a document or create a new one. Your preview updates as you type.\n\n- **Bold**, *italic*, and ~~strikethrough~~\n- Keyboard-friendly editing\n- Optional Vim keybindings\n- [x] Your Markdown is never rewritten\n\n## Tables\n\n| Feature | Status |\n| --- | --- |\n| Live preview | Ready |\n| GFM tables | Ready |\n\n```rust\nfn main() {\n    println!("Hello, Textgate!");\n}\n```\n';
let path = null;
let fileFormat = defaultFormat;
let savedText = initial;
let busy = false;
let vimEnabled = false;
let mode = 'live';
let nativeMenus = null;
let title = '';
let detailsTimer = null;
let previewVersion = 0;
const vimMode = new Compartment();
const liveMode = new Compartment();
const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];
const view = new EditorView({
  parent: $('editor'),
  state: EditorState.create({ doc: initial, extensions: extensions() }),
});
const source = () => view.state.doc.toString();
const dirty = () => source() !== savedText;
const name = () => path?.split(/[\\/]/).pop() ?? 'Untitled.md';
const previewVisible = () => mode === 'source' && $('toggle-preview').getAttribute('aria-pressed') === 'true';

function refresh() {
  updateEditorStatus();
  const changed = dirty();
  $('filename').textContent = name();
  $('dirty').textContent = changed ? '●' : '';
  const next = `${changed ? '• ' : ''}${name()} — Textgate`;
  if (next !== title) {
    title = document.title = next;
    if (isTauri()) getCurrentWindow().setTitle(title).catch(report);
  }
  // Outline, statistics and preview are derived views; batch them while typing.
  clearTimeout(detailsTimer);
  detailsTimer = setTimeout(refreshDetails, 120);
}
function refreshDetails() {
  clearTimeout(detailsTimer);
  $('outline').replaceChildren();
  for (const heading of headings(view.state)) {
    const button = document.createElement('button');
    button.textContent = heading.text;
    button.style.paddingLeft = `${12 + (heading.depth - 1) * 12}px`;
    button.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: heading.offset }, effects: EditorView.scrollIntoView(heading.offset, { y: 'center' }) });
      view.focus();
    });
    $('outline').append(button);
  }
  if (!$('outline').childElementCount) $('outline').textContent = 'Headings appear here.';
  const words = source().trim().split(/\s+/).filter(Boolean).length;
  $('stats').textContent = `${words} words · ${view.state.doc.lines} lines · ${lineEndingLabel(fileFormat)}`;
  return refreshPreview();
}
async function refreshPreview() {
  if (!previewVisible()) return;
  const version = ++previewVersion;
  try {
    const fragment = await render(source());
    // Renders can finish out of order; only show the newest one.
    if (version === previewVersion) $('preview').replaceChildren(fragment);
  } catch (error) { report(error); }
}
function report(error) { $('status').textContent = `Error: ${error.message ?? error}`; }
async function canDiscard() {
  return !dirty() || (isTauri()
    ? await confirm('Discard unsaved changes?', { title: 'Textgate', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Keep editing' })
    : window.confirm('Discard unsaved changes?'));
}
function replaceDocument(text, nextPath, nextFormat = defaultFormat) {
  path = nextPath;
  fileFormat = nextFormat;
  // New state intentionally clears undo history between documents.
  view.setState(EditorState.create({ doc: text, extensions: extensions() }));
  savedText = source();
  refresh();
  updateToolbar();
  view.focus();
}
function extensions() {
  return [vimMode.of(vimEnabled ? vim() : []), basicSetup,
    // classHighlighter has no class for strikethrough.
    syntaxHighlighting(classHighlighter), syntaxHighlighting(tagHighlighter([{ tag: tags.strikethrough, class: 'tok-strikethrough' }])),
    markdown({ base: markdownLanguage, codeLanguages: fencedLanguage }),
    liveMode.of(mode === 'live' ? livePreview({ render }) : []),
    keymap.of([indentWithTab,
      { key: 'Mod-b', run: (target) => { format.toggleInline(target, 'bold'); return true; } },
      { key: 'Mod-i', run: (target) => { format.toggleInline(target, 'italic'); return true; } }]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown document' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) refresh();
      if (update.docChanged || update.selectionSet) updateToolbar();
    })];
}
async function run(action) {
  if (busy) return;
  busy = true;
  try { await action(); } catch (error) { report(error); } finally { busy = false; }
}
async function openDocument() {
  if (!isTauri()) { $('status').textContent = 'Run npm run tauri dev to open and save local files.'; return; }
  const beforeOpen = source();
  if (!await canDiscard()) return;
  const selected = await open({ multiple: false, filters });
  if (!selected) return;
  const { text, format: opened } = decodeDocument(await readFile(selected));
  // Editing can continue while the dialog is open; recheck before replacing it.
  if (source() !== beforeOpen && !await canDiscard()) return;
  replaceDocument(text, selected, opened);
  $('status').textContent = opened.mixed
    ? `Opened ${name()}. It mixes line endings; saving will use ${lineEndingLabel(opened)} throughout.`
    : `Opened ${name()}`;
}
async function saveDocument(saveAs = false) {
  if (!isTauri()) { $('status').textContent = 'Run npm run tauri dev to open and save local files.'; return; }
  const destination = !path || saveAs ? await save({ defaultPath: path ?? 'Untitled.md', filters }) : path;
  if (!destination) return;
  const snapshot = source();
  await writeTextFile(destination, encodeDocument(snapshot, fileFormat));
  path = destination;
  savedText = snapshot;
  refresh();
  $('status').textContent = `Saved ${name()}`;
}
$('new').onclick = () => run(async () => { if (await canDiscard()) { replaceDocument('', null); $('status').textContent = 'New document'; } });
$('open').onclick = () => run(openDocument);
$('save').onclick = () => run(() => saveDocument());
$('save-as').onclick = () => run(() => saveDocument(true));
$('vim').onclick = () => {
  vimEnabled = !vimEnabled;
  view.dispatch({ effects: vimMode.reconfigure(vimEnabled ? vim() : []) });
  $('vim').setAttribute('aria-pressed', String(vimEnabled));
  updateEditorStatus();
  view.focus();
};
function updateEditorStatus() {
  const state = getCM(view)?.state.vim;
  const label = mode === 'live' ? 'Live' : 'Source';
  $('editor-status').textContent = !vimEnabled ? label
    : `${label} · Vim ${state?.insertMode ? 'INSERT' : state?.visualMode ? 'VISUAL' : 'NORMAL'}`;
}
// Vim mode changes may not modify the document, so update after key handling too.
view.dom.addEventListener('keydown', () => queueMicrotask(updateEditorStatus));
$('quit').onclick = () => run(async () => {
  if (!isTauri()) { $('status').textContent = 'Close this browser tab to quit.'; return; }
  if (await canDiscard()) await getCurrentWindow().destroy();
});
$('edit-undo').onclick = () => { undo(view); view.focus(); };
$('edit-redo').onclick = () => { redo(view); view.focus(); };
for (const id of ['find', 'replace']) $(id).onclick = () => {
  view.focus();
  openSearchPanel(view);
  view.dom.querySelector(id === 'replace' ? '[name="replace"]' : '[name="search"]')?.focus();
};
for (const part of ['preview', 'outline']) {
  $(`toggle-${part}`).onclick = () => {
    const button = $(`toggle-${part}`);
    const show = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(show));
    document.querySelector('main').classList.toggle(`hide-${part}`, !show);
    view.requestMeasure();
    refreshPreview();
  };
}
$('view-live').onclick = () => $('mode-live').click();
$('view-source').onclick = () => $('mode-source').click();
$('shortcuts').onclick = () => $('shortcuts-dialog').showModal();
$('about').onclick = () => $('about-dialog').showModal();
$('app-version').textContent = packageInfo.version;
window.addEventListener('keydown', (event) => {
  if (nativeMenus || document.querySelector('dialog[open]')) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (!['n', 'o', 's', 'q'].includes(key)) return;
  event.preventDefault();
  if (key === 'n') $('new').click();
  if (key === 'o') $('open').click();
  if (key === 's') run(() => saveDocument(event.shiftKey));
  if (key === 'q') $('quit').click();
}, true);
// Preview links must not navigate away from the editor; in-page anchors scroll.
$('preview').addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') ?? '';
  const target = href.startsWith('#') && $('preview').querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
  if (target) target.scrollIntoView({ block: 'start' });
  else $('status').textContent = `Link: ${href}`;
});
window.addEventListener('beforeunload', (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
if (isTauri()) {
  getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    await run(async () => { if (await canDiscard()) await getCurrentWindow().destroy(); });
  }).catch(report);
}
function setMode(next) {
  mode = next;
  view.dispatch({ effects: liveMode.reconfigure(mode === 'live' ? livePreview({ render }) : []) });
  document.querySelector('main').dataset.mode = mode;
  for (const [id, value] of [['mode-live', 'live'], ['mode-source', 'source'], ['view-live', 'live'], ['view-source', 'source']]) {
    $(id).setAttribute('aria-pressed', String(mode === value));
  }
  $('toggle-preview').disabled = mode === 'live';
  $('mode-hint').textContent = mode === 'live' ? 'Markdown styled as you write' : 'Markdown source · preview';
  refresh();
  refreshPreview();
}
const commands = {
  bold: () => format.toggleInline(view, 'bold'), italic: () => format.toggleInline(view, 'italic'),
  strike: () => format.toggleInline(view, 'strike'), code: () => format.toggleInline(view, 'code'),
  bulletList: () => format.toggleList(view, 'bullet'), orderedList: () => format.toggleList(view, 'ordered'),
  taskList: () => format.toggleList(view, 'task'), blockquote: () => format.toggleQuote(view),
  codeBlock: () => format.toggleCodeBlock(view), table: () => format.insertTable(view),
  undo: () => undo(view), redo: () => redo(view),
};
function updateToolbar() {
  const { active, heading } = format.activeFormats(view.state);
  for (const button of document.querySelectorAll('[data-command]')) {
    const command = button.dataset.command;
    if (command === 'undo') button.disabled = !undoDepth(view.state);
    else if (command === 'redo') button.disabled = !redoDepth(view.state);
    else if (command !== 'table') setPressed(button, active.has(command));
  }
  $('block-type').value = heading ? String(heading) : 'paragraph';
  setPressed($('edit-link'), active.has('link'));
}
// Only touch attributes that change: native menus observe these mutations.
function setPressed(element, pressed) {
  if (element.getAttribute('aria-pressed') !== String(pressed)) element.setAttribute('aria-pressed', String(pressed));
}
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.onclick = () => { commands[button.dataset.command](); view.focus(); };
}
$('block-type').onchange = (event) => {
  format.setHeading(view, event.target.value === 'paragraph' ? 0 : Number(event.target.value));
  view.focus();
};
$('mode-live').onclick = () => { setMode('live'); view.focus(); };
$('mode-source').onclick = () => { setMode('source'); view.focus(); };
$('edit-link').onclick = () => {
  $('link-url').value = format.linkAt(view.state)?.href ?? '';
  $('link-error').textContent = '';
  $('link-dialog').showModal();
  $('link-url').focus();
};
$('link-cancel').onclick = () => $('link-dialog').close();
$('link-remove').onclick = () => {
  format.removeLink(view);
  $('link-dialog').close();
  view.focus();
};
$('link-form').onsubmit = (event) => {
  event.preventDefault();
  const href = $('link-url').value.trim();
  if (!href || /^\s*(javascript|vbscript|data):/i.test(href)) {
    $('link-error').textContent = 'Enter a web address, mailto: link, #anchor, or relative path.';
    return;
  }
  if (!format.applyLink(view, href)) {
    $('link-error').textContent = 'This is a reference link; edit its definition in the document.';
    return;
  }
  $('link-dialog').close();
  view.focus();
};
setMode('live');
updateToolbar();

setupThemes({ document, desktop: isTauri(), invoke });
setupMenus({ document, desktop: isTauri(), onError: report }).then((menus) => { nativeMenus = menus; }).catch(report);

export { refreshDetails as flushDetails };
