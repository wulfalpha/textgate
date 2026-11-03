import { ViewPlugin } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';

// The Vim plugin shrinks its block cursor to half height while a command is
// pending (`d`, `c`, `y`, a count, a register) and to a fifth in Replace mode,
// keeping the bottom edge fixed and the letter hidden. In an editor where the
// status bar already names the mode this reads as the cursor glitching, so
// restore the full block. The plugin owns the cursor layer and rewrites its
// inline styles whenever its measurement changes; correct them right after,
// before the browser paints.

// The plugin's own height factors (measureCursor in @replit/codemirror-vim).
export function cursorScale(cm) {
  if (!cm?.state.vim) return 1;
  if (cm.state.overwrite) return 0.2;
  return cm.state.vim.status ? 0.5 : 1;
}

const px = (value) => Number.parseFloat(value);

// Undo a partial cursor's reduction. Partial cursors are the only ones drawn
// with an inline transparent letter.
export function restoreFullCursor(element, scale) {
  if (element.style.color !== 'transparent' || !(scale > 0 && scale < 1)) return false;
  const height = px(element.style.height);
  const top = px(element.style.top);
  if (!Number.isFinite(height) || !Number.isFinite(top)) return false;
  const full = height / scale;
  element.style.top = `${top + height - full}px`;
  element.style.height = `${full}px`;
  element.style.lineHeight = `${full}px`;
  // Fall back to the stylesheet's letter colour, as for ordinary block cursors.
  element.style.color = '';
  return true;
}

// At a line end or on an empty line the block holds a space, which is only a
// few pixels wide in Live mode's proportional font. Give it a usable width.
export function widenBlankCursor(element) {
  const width = element.textContent === '\u00a0' ? '0.6em' : '';
  if (element.style.minWidth === width) return false;
  element.style.minWidth = width;
  return true;
}

export const fullHeightVimCursor = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.layer = null;
    this.cursors = new MutationObserver(() => this.fix());
    // The Vim plugin may create its layer before or after this plugin starts.
    this.layers = new MutationObserver(() => this.attach());
    this.layers.observe(view.scrollDOM, { childList: true });
    this.attach();
  }
  attach() {
    const layer = this.view.scrollDOM.querySelector(':scope > .cm-vimCursorLayer');
    if (layer === this.layer) return;
    this.cursors.disconnect();
    this.layer = layer;
    if (!layer) return;
    this.cursors.observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    this.fix();
  }
  fix() {
    if (!this.layer) return;
    const scale = cursorScale(getCM(this.view));
    for (const element of this.layer.querySelectorAll('.cm-fat-cursor')) {
      restoreFullCursor(element, scale);
      widenBlankCursor(element);
    }
    // Drop the records produced by our own corrections.
    this.cursors.takeRecords();
  }
  destroy() {
    this.cursors.disconnect();
    this.layers.disconnect();
  }
});
