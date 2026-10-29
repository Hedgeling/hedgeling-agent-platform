// SPDX-License-Identifier: Apache-2.0
import { Worker } from 'node:worker_threads';
import { fail } from './errors.js';
// Binary parsing stays off the HTTP thread and is bounded independently of chat.
export function processDocument(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-worker.js', import.meta.url), { workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => { reject(fail(400, 'Document processing timed out. Split it into smaller files.', 'document_invalid')); void worker.terminate(); }, 20000);
    const finish = (error, result) => { clearTimeout(timer); void worker.terminate(); error ? reject(error) : resolve(result); };
    worker.once('message', result => finish(result.error ? fail(400, result.error, 'document_invalid') : null, result.document));
    worker.once('error', () => finish(fail(400, 'Document processing exceeded its limits or failed.', 'document_invalid')));
    worker.once('exit', code => { if (code !== 0) finish(fail(400, 'Document processing stopped.', 'document_invalid')); });
  });
}
