// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';
import { requestJson, serverUrl } from './http.js';
import { engineReader } from './engine-client.js';

// Server adapter for the authenticated workflow, not the verification harness.
export function engineOperations({ url, token, fetchImpl = fetch, allowLoopbackHttp = false }) {
  const base = serverUrl(url, 'HEDGELING_ENGINE_URL', { allowLoopbackHttp });
  base.pathname = base.pathname.replace(/\/$/, '') + '/';
  const call = (route, options = {}) => requestJson(new URL(route, base), { token, fetchImpl, ...options });
  const jobPath = id => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '')) throw new AgentError(400, 'Invalid extraction ID.');
    return 'v1/jobs/' + id;
  };
  return Object.freeze({ ...engineReader({ url, token, fetchImpl, allowLoopbackHttp }),
    configuration: (connectionId, ref, path) => call('v1/connections/' + encodeURIComponent(connectionId) + '/config?' + new URLSearchParams({ ref, path })),
    create: (body, idempotencyKey) => call('v1/jobs', { body, idempotencyKey }),
    snapshot: (body, idempotencyKey) => call('v1/snapshot-jobs', { body, idempotencyKey }),
    job: id => call(jobPath(id)),
    cancel: id => call(jobPath(id) + '/cancel', { body: {} }),
    modelRequests: id => call(jobPath(id) + '/model-requests'),
    modelResult: (id, requestId, body) => call(jobPath(id) + '/model-requests/' + jobPath(requestId).split('/').at(-1), { body }),
    artifact: id => call(jobPath(id) + '/artifact', { maxBytes: 21 * 1024 * 1024 }),
  });
}
