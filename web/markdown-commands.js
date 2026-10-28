import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';

// Formatting commands edit Markdown text directly and touch only the markup
// they add or remove, so the rest of the line keeps its original spelling.

const inline = {
  bold: { node: 'StrongEmphasis', mark: 'EmphasisMark', text: '**' },
  italic: { node: 'Emphasis', mark: 'EmphasisMark', text: '*' },
  strike: { node: 'Strikethrough', mark: 'StrikethroughMark', text: '~~' },
  code: { node: 'InlineCode', mark: 'CodeMark', text: '`' },
};

function enclosing(state, pos, names, side = 1) {
  for (let node = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
    if (names.includes(node.name)) return node;
  }
  return null;
}

export function toggleInline(view, kind) {
  const { node: name, mark, text } = inline[kind];
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const node = enclosing(state, range.from, [name]);
    if (node && node.to >= range.to) {
      const marks = node.getChildren(mark);
      const changes = state.changes([{ from: marks[0].from, to: marks[0].to }, { from: marks.at(-1).from, to: marks.at(-1).to }]);
      return { changes, range: range.map(changes) };
    }
    return {
      changes: [{ from: range.from, insert: text }, { from: range.to, insert: text }],
      range: EditorSelection.range(range.from + text.length, range.to + text.length),
    };
  }), { userEvent: 'input.format', scrollIntoView: true });
}

function selectedLines(state) {
  const lines = new Map();
  for (const range of state.selection.ranges) {
    for (let number = state.doc.lineAt(range.from).number; number <= state.doc.lineAt(range.to).number; number++) {
      lines.set(number, state.doc.line(number));
    }
  }
  return [...lines.values()];
}

// Replace a prefix of each selected line: edit(text, index) returns
// [length of existing prefix to remove, replacement] or null to leave the line.
function prefixChanges(lines, edit) {
  const changes = [];
  lines.forEach((line, index) => {
    const result = edit(line.text, index);
    if (result) changes.push({ from: line.from, to: line.from + result[0], insert: result[1] });
  });
  return changes;
}

function editPrefixes(view, edit) {
  view.dispatch({ changes: prefixChanges(selectedLines(view.state), edit), userEvent: 'input.format', scrollIntoView: true });
}

// Setext headings (text underlined with === or ---) keep their style for
// levels 1 and 2; other levels drop the underline.
function setextChanges(state, node, level) {
  const underline = node.getChildren('HeaderMark').at(-1);
  if (level === 1 || level === 2) {
    return [{ from: underline.from, to: underline.to, insert: (level === 1 ? '=' : '-').repeat(underline.to - underline.from) }];
  }
  const underlineLine = state.doc.lineAt(underline.from);
  // The heading text may span several lines; join them so it stays one block.
  const changes = [...state.sliceDoc(node.from, underlineLine.from - 1).matchAll(/\n[ \t]*/g)]
    .map((match) => ({ from: node.from + match.index, to: node.from + match.index + match[0].length, insert: ' ' }));
  changes.push({ from: underlineLine.from - 1, to: underlineLine.to });
  if (level) changes.push({ from: node.from, insert: `${'#'.repeat(level)} ` });
  return changes;
}

export function setHeading(view, level) {
  const { state } = view;
  const changes = [];
  const setextLines = new Set();
  for (const range of state.selection.ranges) {
    syntaxTree(state).iterate({ from: range.from, to: range.to, enter: ({ name, node, from, to }) => {
      if (!/^SetextHeading/.test(name) || setextLines.has(state.doc.lineAt(from).number)) return;
      for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) setextLines.add(number);
      changes.push(...setextChanges(state, node, level));
      return false;
    } });
  }
  const lines = selectedLines(state).filter((line) => !setextLines.has(line.number));
  changes.push(...prefixChanges(lines, (text) => {
    if (!text.trim()) return null;
    const [, indent, existing] = /^( {0,3})(#{1,6}(?:[ \t]+|$))?/.exec(text);
    return [indent.length + (existing?.length ?? 0), level ? `${indent}${'#'.repeat(level)} ` : indent];
  }));
  view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true });
}

const listPatterns = {
  task: /^(\s*)[-*+][ \t]+\[[ xX]\][ \t]+/,
  bullet: /^(\s*)[-*+][ \t]+(?!\[[ xX]\][ \t])/,
  ordered: /^(\s*)\d{1,9}[.)][ \t]+/,
};
const anyList = /^(\s*)(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)/;

export function toggleList(view, kind) {
  const lines = selectedLines(view.state).filter((line) => line.text.trim());
  const remove = lines.length > 0 && lines.every((line) => listPatterns[kind].test(line.text));
  let number = 0;
  editPrefixes(view, (text) => {
    if (!text.trim()) return null;
    const existing = (remove ? listPatterns[kind] : anyList).exec(text);
    const indent = existing?.[1] ?? /^\s*/.exec(text)[0];
    if (remove) return [existing[0].length, indent];
    const marker = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : `${++number}. `;
    return [existing?.[0].length ?? indent.length, indent + marker];
  });
}

// Check or uncheck the tasks on the selected lines, changing one character
// each. A mixed selection is checked first, so repeating the command unchecks.
const taskBox = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\]/;
export function toggleTask(view) {
  const tasks = selectedLines(view.state).map((line) => [line, taskBox.exec(line.text)]).filter(([, match]) => match);
  if (!tasks.length) return false;
  const mark = tasks.some(([, match]) => match[2] === ' ') ? 'x' : ' ';
  const changes = tasks.filter(([, match]) => (match[2] === ' ') !== (mark === ' '))
    .map(([line, match]) => ({ from: line.from + match[1].length, to: line.from + match[1].length + 1, insert: mark }));
  view.dispatch({ changes, userEvent: 'input.toggle' });
  return true;
}

export function toggleQuote(view) {
  const quoted = /^ {0,3}> ?/;
  // Blank lines between quoted paragraphs don't decide whether to add or remove.
  const lines = selectedLines(view.state).filter((line) => line.text.trim());
  const remove = lines.length > 0 && lines.every((line) => quoted.test(line.text));
  editPrefixes(view, (text) => {
    if (remove) return quoted.test(text) ? [quoted.exec(text)[0].length, ''] : null;
    return [0, text ? '> ' : '>'];
  });
}

export function toggleCodeBlock(view) {
  const { state } = view;
  const block = enclosing(state, state.selection.main.head, ['FencedCode'], -1) ?? enclosing(state, state.selection.main.head, ['FencedCode']);
  if (block) {
    const fences = block.getChildren('CodeMark');
    const first = state.doc.lineAt(block.from);
    const last = state.doc.lineAt(block.to);
    const changes = [{ from: first.from, to: Math.min(first.to + 1, state.doc.length) }];
    if (fences.length > 1 && last.number > first.number) changes.push({ from: last.from - 1, to: last.to });
    view.dispatch({ changes, userEvent: 'input.format' });
    return;
  }
  const lines = selectedLines(state);
  view.dispatch({
    changes: [{ from: lines[0].from, insert: '```\n' }, { from: lines.at(-1).to, insert: '\n```' }],
    userEvent: 'input.format', scrollIntoView: true,
  });
}

export function insertTable(view) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const before = line.text.trim() ? '\n\n' : '';
  const from = line.text.trim() ? line.to : line.from;
  const table = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |';
  // A blank line after the table keeps the next paragraph out of it.
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : '';
  const after = next.trim() ? '\n' : '';
  const cell = from + before.length + 2;
  view.dispatch({
    changes: { from, to: line.text.trim() ? from : line.to, insert: before + table + after },
    selection: EditorSelection.range(cell, cell + 'Column 1'.length),
    userEvent: 'input.format', scrollIntoView: true,
  });
}

export function linkAt(state) {
  const head = state.selection.main.head;
  const node = enclosing(state, head, ['Link']) ?? enclosing(state, head, ['Link'], -1);
  if (!node) return null;
  const url = node.getChild('URL');
  return { node, url, href: url ? state.sliceDoc(url.from, url.to) : '' };
}

// Unbalanced brackets would end the label early; balanced ones (such as a
// linked image) are valid and stay as written.
function escapeLabel(label) {
  let depth = 0;
  for (const [bracket] of label.matchAll(/(?<!\\)[[\]]/g)) {
    depth += bracket === '[' ? 1 : -1;
    if (depth < 0) break;
  }
  return depth === 0 ? label : label.replace(/(?<!\\)[[\]]/g, '\\$&');
}

const destination = (href) => (/[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href);

export function applyLink(view, href) {
  const { state } = view;
  const link = linkAt(state);
  const { from, to } = state.selection.main;
  if (link?.url) {
    view.dispatch({ changes: { from: link.url.from, to: link.url.to, insert: destination(href) }, userEvent: 'input.format' });
  } else if (!link) {
    const label = escapeLabel(from === to ? href : state.sliceDoc(from, to));
    view.dispatch({ changes: { from, to, insert: `[${label}](${destination(href)})` }, userEvent: 'input.format' });
  } else return false;
  return true;
}

export function removeLink(view) {
  const link = linkAt(view.state);
  if (!link) return;
  const [open, close] = link.node.getChildren('LinkMark');
  view.dispatch({ changes: { from: link.node.from, to: link.node.to, insert: view.state.sliceDoc(open.to, close.from) }, userEvent: 'input.format' });
}

const formatNodes = { StrongEmphasis: 'bold', Emphasis: 'italic', Strikethrough: 'strike', InlineCode: 'code', Blockquote: 'blockquote', FencedCode: 'codeBlock', Link: 'link' };

export function activeFormats(state) {
  const active = new Set();
  let heading = 0;
  let list = false;
  const head = state.selection.main.head;
  const side = head === state.doc.lineAt(head).from ? 1 : -1;
  for (let node = syntaxTree(state).resolveInner(head, side); node; node = node.parent) {
    if (formatNodes[node.name]) active.add(formatNodes[node.name]);
    const level = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
    if (level) heading = Number(level[1]);
    if (node.name === 'ListItem' && !list) {
      list = true;
      active.add(node.getChild('Task') ? 'taskList' : node.parent?.name === 'OrderedList' ? 'orderedList' : 'bulletList');
    }
  }
  return { active, heading };
}
