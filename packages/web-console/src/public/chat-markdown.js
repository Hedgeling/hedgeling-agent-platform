// SPDX-License-Identifier: Apache-2.0
// Deliberately small Markdown subset. Model text is never interpreted as HTML.
export function appendInline(parent, text, document = parent.ownerDocument, depth = 0) {
  if (depth > 8) { parent.append(document.createTextNode(text)); return; }
  const pattern = /(`+)([^`\n]+)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    const tag = match[1] ? 'code' : match[3] || match[4] ? 'strong' : 'em';
    const node = document.createElement(tag);
    const value = match[2] || match[3] || match[4] || match[5] || match[6];
    if (tag === 'code') node.textContent = value; else appendInline(node, value, document, depth + 1);
    parent.append(node); start = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}

export function renderChatMarkdown(text, document = globalThis.document) {
  const fragment = document.createDocumentFragment();
  let paragraph = null, list = null, code = null;
  for (const line of String(text).replaceAll('\r\n', '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) code = null;
      else { const pre = document.createElement('pre'); code = document.createElement('code'); pre.append(code); fragment.append(pre); }
      paragraph = list = null; continue;
    }
    if (code) { code.append(document.createTextNode(`${line}\n`)); continue; }
    if (!line.trim()) { paragraph = list = null; continue; }
    const heading = /^#{1,6}\s+(.+)/.exec(line);
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)/.exec(line);
    if (heading) {
      const node = document.createElement('h3'); appendInline(node, heading[1], document); fragment.append(node); paragraph = list = null;
    } else if (item) {
      const type = item[1] ? 'ul' : 'ol';
      if (!list || list.localName !== type) { list = document.createElement(type); fragment.append(list); }
      const node = document.createElement('li'); appendInline(node, item[2], document); list.append(node); paragraph = null;
    } else {
      list = null;
      if (!paragraph) { paragraph = document.createElement('p'); fragment.append(paragraph); }
      else paragraph.append(document.createElement('br'));
      appendInline(paragraph, line, document);
    }
  }
  return fragment;
}
