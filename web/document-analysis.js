import { parser, GFM } from '@lezer/markdown';
import { frontMatterEnd, headingsFromTree } from './markdown-structure.js';
const markdownParser = parser.configure(GFM);
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

// Run in a worker in the desktop/browser app. Time slices also keep the fallback
// responsive in environments without Worker (including DOM tests).
export async function analyzeDocument(source) {
  const parse = markdownParser.startParse(source);
  let tree;
  while (!tree) {
    const deadline = performance.now() + 6;
    do { tree = parse.advance(); } while (!tree && performance.now() < deadline);
    if (!tree) await pause();
  }
  let words = 0;
  const matches = source.matchAll(/\S+/g);
  for (const _match of matches) {
    if (++words % 4096 === 0) await pause();
  }
  return { words, headings: headingsFromTree(tree, (from, to) => source.slice(from, to), frontMatterEnd(source)) };
}
