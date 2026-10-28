// YAML front matter is not Markdown. Match comrak's --- closing fence.
export function frontMatterEnd(text) {
  return /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(text)?.[0].length ?? 0;
}

export function headingsFromTree(tree, slice, start) {
  const result = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const match = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
    if (!match || node.from < start) continue;
    const marks = node.getChildren('HeaderMark');
    let from = node.from, to = node.to;
    if (match[1] === 'ATX') {
      if (marks[0]) from = marks[0].to;
      if (marks.length > 1) to = marks.at(-1).from;
    } else if (marks.length) to = marks.at(-1).from;
    result.push({ text: slice(from, to).replace(/\s+/g, ' ').trim(), depth: Number(match[2]), offset: node.from });
  }
  return result;
}
