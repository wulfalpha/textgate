import { parser, GFM } from '@lezer/markdown';
import { wikiLinks } from './note-links.js';
const markdown = parser.configure([...GFM, wikiLinks]);
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

// Native code owns file snapshots and resolves targets. This worker only
// identifies exact destination spans; no Markdown is reserialized.
export async function renameCandidates(sources) {
  const files = [];
  let count = 0;
  for (const source of sources) {
    const bom = source.text.startsWith('\ufeff') ? 1 : 0;
    const text = source.text.slice(bom);
    const parse = markdown.startParse(text);
    let tree;
    while (!tree) {
      const deadline = performance.now() + 6;
      do { tree = parse.advance(); } while (!tree && performance.now() < deadline);
      if (!tree) await pause();
    }
    const front = /^---(?:\r\n?|\n)[\s\S]*?(?:\r\n?|\n)---[ \t]*(?:(?:\r\n?|\n)|$)/.exec(text)?.[0].length ?? 0;
    const spans = [];
    tree.iterate({ enter(node) {
      if (node.to <= front || ['Image', 'FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag'].includes(node.name)) return false;
      if (node.from < front) return;
      const wiki = node.name === 'WikiLink';
      if (!wiki && !['Link', 'LinkReference'].includes(node.name)) return;
      const target = node.node.getChild(wiki ? 'WikiLinkTarget' : 'URL');
      if (!target) return;
      let from = target.from, to = target.to;
      if (!wiki && text[from] === '<' && text[to - 1] === '>') { from++; to--; }
      while (from < to && /\s/.test(text[from])) from++;
      while (to > from && /\s/.test(text[to - 1])) to--;
      if (++count > 100_000) throw new Error('Too many link destinations for a complete rename preview.');
      spans.push({ from: from + bom, to: to + bom, wiki, reference: node.name === 'LinkReference' });
      return false;
    } });
    files.push({ key: source.key, spans });
    await pause();
  }
  return files;
}

export async function scanRenameCandidates(sources) {
  if (typeof Worker === 'undefined') return renameCandidates(sources);
  const worker = new Worker(new URL('./rename-worker.js', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.files);
      worker.onerror = (event) => reject(new Error(event.message || 'Could not parse rename destinations.'));
      worker.postMessage(sources);
    });
  } finally { worker.terminate(); }
}
