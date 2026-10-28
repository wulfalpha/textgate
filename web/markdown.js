import { marked } from 'marked';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

// YAML front matter is not Markdown; return where the document body starts.
// Only --- closes it, matching comrak's front_matter_delimiter.
export function frontMatterEnd(text) {
  return /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(text)?.[0].length ?? 0;
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

// Only what GitHub-flavored Markdown produces. Form controls, dialogs and media
// are dropped: preview content must never be interactive or control the app.
const allowedTags = ['a', 'abbr', 'b', 'blockquote', 'br', 'cite', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  'q', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul', 'var'];
const allowedAttributes = ['align', 'alt', 'checked', 'class', 'colspan', 'dir', 'disabled', 'height', 'href', 'id',
  'lang', 'open', 'rowspan', 'src', 'start', 'title', 'type', 'width'];

export function sanitize(html, purifier) {
  const fragment = purifier.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttributes,
    ALLOW_DATA_ATTR: false,
    // Prefix ids so document content can never shadow the app's own elements.
    SANITIZE_NAMED_PROPS: true,
    // http(s), mailto, #anchors and relative paths; no other schemes.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
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
