import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocumentDownload } from '../src/public/document-files.js';

const exported = { filename: 'hot-dog-fr.csv', bytes: 124,
  href: '/api/documents/jobs/00000000-0000-4000-8000-000000000001/download?locale=fr&format=csv&status=drafts&version=example' };

test('exported translations remain downloadable, including empty files', () => {
  assert.equal(isDocumentDownload(exported), true);
  assert.equal(isDocumentDownload({ ...exported, bytes: 0 }), true);
});

test('repository listings and incomplete saved file events are not downloads', () => {
  for (const file of [null, {}, { path: 'src/HotDog.tsx', bytes: 124 },
    { filename: 'HotDog.tsx', bytes: 124 }, { ...exported, filename: '' },
    { ...exported, bytes: undefined }, { ...exported, bytes: -1 }]) {
    assert.equal(isDocumentDownload(file), false);
  }
});

test('only document export routes create download cards', () => {
  for (const href of ['https://example.invalid/file', '//example.invalid/file',
    'javascript:alert(1)', '/api/documents/jobs/../private',
    '/api/documents/jobs/job/download-unavailable']) {
    assert.equal(isDocumentDownload({ ...exported, href }), false);
  }
});
