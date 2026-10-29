// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { fail } from './errors.js';

export const DOCUMENT_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, expandedBytes: 10 * 1024 * 1024,
  textCharacters: 120000, segments: 200, segmentCharacters: 3000, pages: 30, timeoutMs: 20000 });
const reject = message => { throw fail(400, message, 'document_invalid'); };
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function segmentsFrom(blocks) {
  const segments = [];
  let characters = 0;
  for (const block of blocks) {
    let text = block.text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    characters += text.length;
    if (characters > DOCUMENT_LIMITS.textCharacters) reject('This document has too much text. Split it into smaller documents.');
    while (text) {
      let end = Math.min(text.length, DOCUMENT_LIMITS.segmentCharacters);
      if (end < text.length) {
        const boundary = text.lastIndexOf(' ', end);
        if (boundary > end / 2) end = boundary;
        else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      }
      segments.push({ index: segments.length, text: text.slice(0, end), location: block.location });
      if (segments.length > DOCUMENT_LIMITS.segments) reject('This document exceeds 200 text sections. Split it into smaller documents.');
      text = text.slice(end).trimStart();
    }
  }
  if (!segments.length) reject('No readable text was found. Scanned PDFs need OCR before upload.');
  return segments;
}

function markdown(bytes) {
  const text = decode(bytes);
  if (text.includes('\u0000')) reject('Upload a UTF-8 Markdown or text document.');
  // Text-oriented import: no HTML execution, Markdown rendering, or link fetches.
  return text.split(/\n\s*\n/).map((text, i) => ({ text, location: `Block ${i + 1}` }));
}

function docx(bytes) {
  let expanded = 0, entries = 0;
  const archive = unzipSync(bytes, { filter(entry) {
    if (++entries > 2000 || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0
      || (expanded += entry.originalSize) > DOCUMENT_LIMITS.expandedBytes) reject('The DOCX archive is too large when expanded.');
    return entry.name === 'word/document.xml';
  } });
  if (!archive['word/document.xml']) reject('This file is not a supported DOCX document.');
  const xml = decode(archive['word/document.xml']);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) reject('Documents with XML entities are not supported.');
  const document = new DOMParser({ onError: level => { if (level !== 'warning') reject('The DOCX content is malformed.'); } }).parseFromString(xml, 'text/xml');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return [...document.getElementsByTagNameNS(ns, 'p')].map((p, i) => {
    const parts = [];
    const visit = n => {
      if (n !== p && n.namespaceURI === ns && n.localName === 'p') return;
      if (n.namespaceURI === ns && n.localName === 'del') return;
      if (n.namespaceURI === ns && ['t', 'tab', 'br'].includes(n.localName)) parts.push(n.localName === 't' ? n.textContent : ' ');
      else for (const child of n.childNodes || []) visit(child);
    };
    visit(p);
    return { text: parts.join(''), location: `Paragraph ${i + 1}` };
  });
}

async function pdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false,
    useSystemFonts: false, disableFontFace: true, enableXfa: false, verbosity: 0, stopAtErrors: true });
  try {
    const document = await task.promise;
    if (document.numPages > DOCUMENT_LIMITS.pages) reject('PDFs are limited to 30 pages. Split this document first.');
    const blocks = [], emptyPages = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n), content = await page.getTextContent();
      const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
      if (!text) emptyPages.push(n);
      blocks.push({ text, location: `Page ${n}` });
      page.cleanup();
    }
    if (emptyPages.length) reject(`PDF page(s) ${emptyPages.join(', ')} contain no readable text. Use OCR or remove blank pages before uploading; no pages were silently skipped.`);
    return blocks;
  } finally { await task.destroy(); }
}

export async function parseDocument({ filename, bytes }) {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 180 || /[\x00-\x1f/\\]/.test(filename)) reject('Choose a document with a simple filename of up to 180 characters.');
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > DOCUMENT_LIMITS.bytes) reject('Choose a nonempty document no larger than 5 MiB.');
  const extension = filename.split('.').pop().toLowerCase();
  if (!['md', 'markdown', 'txt', 'docx', 'pdf'].includes(extension)) reject('Supported files: Markdown, TXT, DOCX, and PDFs with selectable text.');
  try {
    const blocks = extension === 'docx' ? docx(bytes) : extension === 'pdf' ? await pdf(bytes) : markdown(bytes);
    const segments = segmentsFrom(blocks);
    return { filename, format: extension === 'markdown' ? 'md' : extension, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), segments,
      warnings: [extension === 'docx' ? 'Body paragraphs and table-cell text only. Headers, footers, comments, images and original Word layout are not included.'
        : extension === 'pdf' ? 'Selectable text only, in parser reading order. Images, scans and original page layout are not translated.'
          : 'Text sections are translated as content. Markdown syntax, code, links and formatting are not guaranteed to round-trip.',
      'Downloads are translated plain text or a bilingual review CSV. Review the extracted sections before creating a job.'] };
  } catch (error) {
    if (error.code === 'document_invalid') throw error;
    reject(extension === 'pdf' ? 'This PDF could not be read. Remove password protection or export a selectable-text PDF.' : 'This document could not be read. Check its format and UTF-8 encoding.');
  }
}
