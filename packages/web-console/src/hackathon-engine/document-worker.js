// SPDX-License-Identifier: Apache-2.0
import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument } from './document-parser.js';
try { parentPort.postMessage({ document: await parseDocument(workerData) }); }
catch (error) { parentPort.postMessage({ error: error.code === 'document_invalid' ? error.message : 'The document could not be processed.' }); }
