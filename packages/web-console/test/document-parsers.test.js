import test from 'node:test';
import assert from 'node:assert/strict';
import { processDocument } from '../src/hackathon-engine/document-processing.js';
import { textPdf, wordDocument } from '../test-support/document-fixtures.mjs';
test('the deployed worker parses PDF and DOCX using installed production dependencies', async () => {
  const pdf = await processDocument({ filename: 'example.pdf', bytes: textPdf('Synthetic PDF text') });
  assert.equal(pdf.segments[0].text, 'Synthetic PDF text');
  const docx = await processDocument({ filename: 'example.docx', bytes: wordDocument('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Word text</w:t></w:r></w:p></w:body></w:document>') });
  assert.equal(docx.segments[0].text, 'Synthetic Word text');
  await assert.rejects(processDocument({ filename: 'scan.pdf', bytes: textPdf('') }), /no readable text/);
});
