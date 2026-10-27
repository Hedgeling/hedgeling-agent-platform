// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';
import { requestJson, serverUrl } from './http.js';

// Operator/server verification only. This is not an end-user authorization layer.
// Write methods are intentionally absent until the authenticated approval flow lands.
export function engineReader({ url, token, fetchImpl = fetch }) {
  const base = serverUrl(url, 'HEDGELING_ENGINE_URL');
  if (!token) throw new AgentError(503, 'HEDGELING_ENGINE_TOKEN is required.');
  base.pathname = base.pathname.replace(/\/$/, '') + '/';
  const read = (path, signal) => requestJson(new URL(path, base), { token, signal, fetchImpl });
  return Object.freeze({
    capabilities: signal => read('v1/capabilities', signal),
    connections: ({ limit = 25, offset = 0, signal } = {}) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new AgentError(400, 'Invalid connection page.');
      }
      return read(`v1/connections?limit=${limit}&offset=${offset}`, signal);
    },
  });
}
