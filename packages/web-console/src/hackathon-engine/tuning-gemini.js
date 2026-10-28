// SPDX-License-Identifier: Apache-2.0
import { AgentError } from './errors.js';

// One dispatch, bounded through the entire response body. No API-version,
// model or credential fallback can create an unpreviewed inference request.
export async function generateGeminiTuning({ system, user, apiKey, model, maxOutputTokens, fetchImpl = fetch }) {
  if (!apiKey || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new AgentError(503, 'Configure the Gemini tuning model and organization key.', 'tuning_provider_unconfigured');
  const signal = AbortSignal.timeout(45000);
  try {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens, temperature: 0.1, responseMimeType: 'application/json' } }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('provider_failed'); }
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 262144) { await reader.cancel(); throw new Error('response_limit'); }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { reader.releaseLock(); }
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const candidate = raw.candidates?.[0];
    const text = (candidate?.content?.parts || []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
    if (candidate?.finishReason !== 'STOP' || !text) throw new Error('incomplete_response');
    return { text, raw, model };
  } catch { throw new AgentError(502, 'Gemini tuning did not return a complete result. Check provider access before requesting a new run.', 'tuning_model_failed'); }
}
