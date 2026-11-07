import { JSDOM } from 'jsdom';

// Install a jsdom window as the globals CodeMirror expects.
export function installDom(html = '<!doctype html><html><body></body></html>') {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost' });
  for (const key of ['Window', 'Element', 'window', 'document', 'navigator', 'Node', 'HTMLElement', 'MutationObserver', 'getComputedStyle', 'DOMParser', 'CSS']) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  return dom;
}

// Let timers, analysis slices and animation frames started by the app finish
// before the window closes; work that outlives close() hits a torn-down jsdom.
export async function closeDom(dom, { turns = 20 } = {}) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  }
  dom.window.close();
}
