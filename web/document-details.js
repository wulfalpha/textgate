import { analyzeDocument } from './document-analysis.js';

export const largeDocument = 1_000_000; // UTF-16 code units, not file bytes.
export const detailsDelay = (length) => length >= largeDocument ? 600 : length >= 100_000 ? 300 : 120;

// Reuse results for mode/visibility changes, cancel obsolete worker jobs, and
// avoid letting keystrokes queue a backlog of full-document analyses.
export function createDocumentDetails(makeWorker = () => typeof Worker === 'undefined' ? null
  : new Worker(new URL('./document-worker.js', import.meta.url), { type: 'module' })) {
  let currentDoc, pending, worker, cancel;
  return {
    invalidate(doc) {
      if (currentDoc === doc) return;
      worker?.terminate();
      worker = null;
      cancel?.();
      cancel = null;
      currentDoc = null;
      pending = null;
    },
    get(doc) {
      if (currentDoc === doc) return pending;
      this.invalidate(doc);
      currentDoc = doc;
      const source = doc.toString();
      worker = makeWorker();
      if (!worker) return pending = analyzeDocument(source);
      const job = worker;
      return pending = new Promise((resolve, reject) => {
        cancel = () => resolve(null);
        worker.onmessage = ({ data }) => {
          if (worker !== job) return;
          worker?.terminate(); worker = null; cancel = null;
          if (data.error) { currentDoc = null; reject(new Error(data.error)); }
          else resolve(data.result);
        };
        worker.onerror = (event) => {
          if (worker !== job) return;
          worker?.terminate(); worker = null; cancel = null; currentDoc = null;
          reject(new Error(event.message || 'Could not update document details.'));
        };
        worker.postMessage(source);
      });
    },
  };
}

// Retain existing buttons and their focus/scroll state. Large outlines grow only
// when requested, rather than inserting thousands of DOM nodes while typing.
export function updateOutline(container, headings, navigate, limit = Number(container.dataset.outlineLimit) || 250) {
  container.dataset.outlineLimit = String(limit);
  const shown = headings.slice(0, limit);
  const buttons = [...container.children].filter((node) => node.hasAttribute('data-heading'));
  container.querySelector('[data-outline-note]')?.remove();
  if (!buttons.length) container.textContent = '';
  shown.forEach((heading, index) => {
    let button = buttons[index];
    if (!button) {
      button = container.ownerDocument.createElement('button');
      button.setAttribute('data-heading', '');
      button.onclick = () => navigate(button.heading.offset);
      container.append(button);
    }
    if (button.textContent !== heading.text) button.textContent = heading.text;
    if (button.heading?.depth !== heading.depth) button.style.paddingLeft = `${12 + (heading.depth - 1) * 12}px`;
    button.heading = heading;
  });
  for (const button of buttons.slice(shown.length)) button.remove();
  if (headings.length > limit) {
    const more = container.ownerDocument.createElement('button');
    more.dataset.outlineNote = '';
    more.textContent = `Show more headings (${headings.length - limit} remaining)`;
    more.onclick = () => updateOutline(container, headings, navigate, limit + 250);
    container.append(more);
  } else if (!headings.length) container.textContent = 'Headings appear here.';
}
