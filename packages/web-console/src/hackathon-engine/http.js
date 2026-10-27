// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';

export function serverUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new AgentError(503, `${label} must be configured with an HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new AgentError(503, `${label} requires HTTPS without embedded credentials, query parameters, or fragments.`);
  }
  return url;
}

export async function requestJson(url, { token, body, signal = new AbortController().signal,
  fetchImpl = fetch, maxBytes = 524288 } = {}) {
  signal.throwIfAborted();
  if (!token || /[\r\n]/.test(token)) throw new AgentError(503, 'A server credential is required.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  try {
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: deadline, redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AgentError(502, `Upstream request failed (${response.status}).`, 'upstream_failed');
    }
    if (!response.body) throw new AgentError(502, 'Upstream returned an empty response.');
    const reader = response.body.getReader();
    const collected = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new AgentError(502, 'Upstream response exceeded its size limit.', 'response_limit');
        }
        collected.push(Buffer.from(chunk.value));
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(collected).toString('utf8')); }
    catch { throw new AgentError(502, 'Upstream returned invalid JSON.'); }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AgentError) throw error;
    if (deadline.aborted) throw new AgentError(504, 'Upstream request timed out.');
    // Do not expose a private hostname, provider response, or credential in an error.
    throw new AgentError(502, 'Upstream could not be reached.', 'upstream_unavailable');
  }
}
