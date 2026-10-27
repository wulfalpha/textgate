import { marked } from 'marked';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

// YAML front matter is not Markdown; return where the document body starts.
export function frontMatterEnd(text) {
  return /^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text)?.[0].length ?? 0;
}

// Derive the outline from the editor's own syntax tree so it always matches
// what the editor shows. Only top-level headings are listed.
export function headings(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const start = frontMatterEnd(state.doc.sliceString(0, Math.min(state.doc.length, 65536)));
  const result = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const match = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
    if (!match || node.from < start) continue;
    const marks = node.getChildren('HeaderMark');
    let from = node.from;
    let to = node.to;
    if (match[1] === 'ATX') {
      if (marks[0]) from = marks[0].to;
      if (marks.length > 1) to = marks.at(-1).from;
    } else if (marks.length) to = marks.at(-1).from;
    const text = state.doc.sliceString(from, to).replace(/\s+/g, ' ').trim();
    result.push({ text, depth: Number(match[2]), offset: node.from });
  }
  return result;
}

// The desktop app renders with comrak (a port of GitHub's cmark-gfm) in Rust.
// The browser-only dev server has no Rust backend and falls back to marked.
export function createRenderer({ desktop, invoke, purifier }) {
  const html = desktop
    ? (source) => invoke('render_markdown', { source })
    : async (source) => marked.parse(source, { gfm: true });
  return async (source) => sanitize(await html(source), purifier);
}

export function sanitize(html, purifier) {
  const fragment = purifier.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'iframe'],
    FORBID_ATTR: ['style'],
  });
  // Preview content is never interactive: show task state as symbols.
  for (const input of fragment.querySelectorAll('input')) {
    if (input.getAttribute('type') !== 'checkbox') { input.remove(); continue; }
    const checked = input.hasAttribute('checked');
    const symbol = fragment.ownerDocument.createElement('span');
    symbol.textContent = checked ? '☑' : '☐';
    symbol.setAttribute('aria-label', checked ? 'Completed task' : 'Incomplete task');
    input.replaceWith(symbol);
  }
  return fragment;
}
