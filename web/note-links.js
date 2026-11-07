import { syntaxTree } from '@codemirror/language';
import { frontMatterEnd } from './markdown-structure.js';

const wikiPattern = /^\[\[([^\[\]\n|]+)(?:\|([^\[\]\n|]+))?\]\]/;
export const wikiLinks = {
  defineNodes: ['WikiLink', 'WikiLinkMark', 'WikiLinkTarget', 'WikiLinkLabel'],
  parseInline: [{ name: 'WikiLink', before: 'Link', parse(cx, next, pos) {
    if (next !== 91 || cx.char(pos + 1) !== 91 || cx.char(pos - 1) === 33 || cx.hasOpenLink) return -1;
    const match = wikiPattern.exec(cx.slice(pos, Math.min(cx.end, pos + 4096)));
    if (!match || !match[1].trim()) return -1;
    const end = pos + match[0].length;
    const targetEnd = pos + 2 + match[1].length;
    return cx.addElement(cx.elt('WikiLink', pos, end, [
      cx.elt('WikiLinkMark', pos, pos + 2), cx.elt('WikiLinkTarget', pos + 2, targetEnd),
      ...(match[2] ? [cx.elt('WikiLinkMark', targetEnd, targetEnd + 1), cx.elt('WikiLinkLabel', targetEnd + 1, end - 2)] : []),
      cx.elt('WikiLinkMark', end - 2, end),
    ]));
  } }],
};
const escapeHTML = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const markedWikiLinks = {
  name: 'wikiLink', level: 'inline',
  start: (source) => /!?\[\[/.exec(source)?.index,
  tokenizer(source) {
    const embed = source.startsWith('!');
    const match = wikiPattern.exec(embed ? source.slice(1) : source);
    if (match?.[1].trim()) return { type: 'wikiLink', raw: (embed ? '!' : '') + match[0], embed,
      href: match[1].trim(), label: match[2] ?? match[1] };
  },
  renderer: (token) => token.embed ? escapeHTML(token.raw) : `<a href="${escapeHTML(token.href)}" data-wikilink="true">${escapeHTML(token.label)}</a>`,
};

export function noteLinkAt(state, position = state.selection.main.head) {
  if (position < frontMatterEnd(state.doc.sliceString(0, Math.min(state.doc.length, 65536)))) return null;
  for (const side of [1, -1]) {
    for (let node = syntaxTree(state).resolveInner(position, side); node; node = node.parent) {
      if (node.name === 'WikiLink') {
        const target = node.getChild('WikiLinkTarget');
        return { href: state.sliceDoc(target.from, target.to).trim(), wiki: true };
      }
      if (node.name === 'Link' || node.name === 'Autolink') {
        const url = node.getChild('URL');
        if (!url) return null;
        let href = state.sliceDoc(url.from, url.to);
        if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
        href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
        return { href, wiki: false };
      }
    }
  }
  return null;
}

export function splitNoteLink(href) {
  if (/^[a-z][a-z\d+.-]*:|^[\\/]|\?/i.test(href)) return null;
  const index = href.indexOf('#');
  try {
    return { path: decodeURIComponent(index < 0 ? href : href.slice(0, index)),
      fragment: index < 0 ? '' : decodeURIComponent(href.slice(index + 1)) };
  } catch { throw new Error('This link contains an invalid URL escape.'); }
}
