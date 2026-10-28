// Node/jsdom microbenchmark, not native typing latency. Parse fully before timing
// so both versions face the same tree; report medians to reduce warm-up noise.
import { performance } from 'node:perf_hooks';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, forceParsing } from '@codemirror/language';
import { installDom } from '../web/test-dom.js';
const { livePreview } = await import(process.argv[2] || '../web/live-preview.js');
const dom = installDom();
const sample = '# Heading\n\nSome **bold** and [link](https://example.com) text.\n\n- item\n- [ ] task\n\n';
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);
for (const size of [100_000, 1_000_000, 5_000_000]) {
  const doc = sample.repeat(Math.ceil(size / sample.length));
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), livePreview()] });
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(view.state, view.state.doc.length, 30000);
  forceParsing(view, view.state.doc.length, 30000);
  const cursor = [], typing = [];
  for (let i = 0; i < 15; i++) {
    let start = performance.now();
    view.dispatch({ selection: { anchor: 20 + i } });
    cursor.push(performance.now() - start);
    start = performance.now();
    view.dispatch({ changes: { from: 20, insert: 'a' } });
    typing.push(performance.now() - start);
  }
  console.log(JSON.stringify({ characters: doc.length, cursorMedianMs: median(cursor.slice(3)), editMedianMs: median(typing.slice(3)) }));
  view.destroy();
}
dom.window.close();
