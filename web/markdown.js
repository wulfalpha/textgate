import { syntaxTree } from '@codemirror/language';
import { frontMatterEnd, headingsFromTree } from './markdown-structure.js';
export { frontMatterEnd } from './markdown-structure.js';

// Read the available tree without forcing synchronous full-document parsing.
// The complete app outline is computed independently in the details worker.
export function headings(state) {
  return headingsFromTree(syntaxTree(state), (from, to) => state.doc.sliceString(from, to),
    frontMatterEnd(state.doc.sliceString(0, Math.min(state.doc.length, 65536))));
}

// The desktop app renders with comrak (a port of GitHub's cmark-gfm) in Rust.
// The browser-only dev server has no Rust backend and falls back to marked.
export function createRenderer({ desktop, invoke, purifier }) {
  const html = desktop
    ? (source) => invoke('render_markdown', { source })
    : async (source) => (await import('marked')).marked.parse(source, { gfm: true });
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
    // A labelled image role, since screen readers ignore aria-label on a plain span.
    symbol.setAttribute('role', 'img');
    symbol.setAttribute('aria-label', checked ? 'Completed task' : 'Incomplete task');
    input.replaceWith(symbol);
  }
  // Right-to-left paragraphs (Arabic, Hebrew) take their direction from their text.
  for (const block of fragment.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, summary')) {
    if (!block.hasAttribute('dir')) block.setAttribute('dir', 'auto');
  }
  return fragment;
}
