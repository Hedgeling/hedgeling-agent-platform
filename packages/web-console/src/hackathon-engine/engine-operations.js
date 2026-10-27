// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';
import { requestJson, serverUrl } from './http.js';
import { engineReader } from './engine-client.js';

// Server adapter for the authenticated workflow, not the verification harness.
export function engineOperations({ url, token, fetchImpl = fetch }) {
  const base = serverUrl(url, 'HEDGELING_ENGINE_URL');
  base.pathname = base.pathname.replace(/\/$/, '') + '/';
  const call = (route, options = {}) => requestJson(new URL(route, base), { token, fetchImpl, ...options });
  const jobPath = id => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '')) throw new AgentError(400, 'Invalid extraction ID.');
    return 'v1/jobs/' + id;
  };
  return Object.freeze({ ...engineReader({ url, token, fetchImpl }),
    create: (body, idempotencyKey) => call('v1/jobs', { body, idempotencyKey }),
    job: id => call(jobPath(id)),
    artifact: id => call(jobPath(id) + '/artifact', { maxBytes: 21 * 1024 * 1024 }),
  });
}
