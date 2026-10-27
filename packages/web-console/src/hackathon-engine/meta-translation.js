// SPDX-License-Identifier: Apache-2.0
import { fail } from './errors.js';
import { requestJson, serverUrl } from './http.js';

// Endpoint and model are operator configuration, never supplied by a browser.
export function metaTranslationConfiguration(env = process.env) {
  const endpoint = serverUrl(env.HEDGELING_META_RESPONSES_URL, 'HEDGELING_META_RESPONSES_URL');
  if (!endpoint.pathname.endsWith('/responses')) throw fail(503, 'Configure the Meta Responses endpoint.');
  const model = env.HEDGELING_META_TRANSLATION_MODEL?.trim();
  if (!model || !/^[A-Za-z0-9._-]{1,128}$/.test(model)) throw fail(503, 'HEDGELING_META_TRANSLATION_MODEL is required.');
  return { endpoint: endpoint.href, model };
}

export async function validateMetaKey(key, config = metaTranslationConfiguration(), fetchImpl = fetch) {
  const endpoint = serverUrl(config.endpoint, 'HEDGELING_META_RESPONSES_URL');
  const url = new URL(`models/${encodeURIComponent(config.model)}`, endpoint);
  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10000) });
  } catch { throw fail(502, 'Meta could not be reached. Try testing the key again.', 'provider_validation_failed'); }
  await response.body?.cancel();
  if (!response.ok) throw fail(422, 'Meta could not verify access to the configured translation model. Check the key and its permissions.', 'provider_key_invalid');
  return { checkedAt: new Date().toISOString(), model: config.model };
}

export async function generateMetaText({ system, user, apiKey, maxOutputTokens = 2048,
  config = metaTranslationConfiguration(), fetchImpl = fetch }) {
  const endpoint = serverUrl(config.endpoint, 'HEDGELING_META_RESPONSES_URL');
  const raw = await requestJson(endpoint, { token: apiKey, fetchImpl, body: {
    model: config.model, instructions: system, input: user, store: false,
    reasoning: { effort: 'low' }, max_output_tokens: maxOutputTokens,
  } });
  const blocks = (Array.isArray(raw.output) ? raw.output : [])
    .filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => item.content || []);
  const text = blocks.filter(block => block.type === 'output_text').map(block => typeof block.text === 'string' ? block.text : '').join('').trim();
  if (raw.status !== 'completed' || !text || blocks.some(block => block.type === 'refusal')) {
    throw fail(502, 'Meta did not return a complete translation. Try again.', 'translation_provider_incomplete');
  }
  const usage = raw.usage;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const measured = usage && count(usage.input_tokens) && count(usage.output_tokens) && count(usage.total_tokens)
    && usage.total_tokens >= usage.input_tokens + usage.output_tokens;
  const reasoning = count(usage?.output_tokens_details?.reasoning_tokens)
    ? Math.min(usage.output_tokens_details.reasoning_tokens, usage.output_tokens) : 0;
  // Host counters separate visible output and reasoning. Meta output includes both.
  const usageMetadata = measured ? { promptTokenCount: usage.input_tokens,
    candidatesTokenCount: usage.output_tokens - reasoning, thoughtsTokenCount: reasoning,
    cachedContentTokenCount: count(usage.input_tokens_details?.cached_tokens)
      ? Math.min(usage.input_tokens_details.cached_tokens, usage.input_tokens) : 0,
    totalTokenCount: usage.total_tokens } : {};
  return { text, model: config.model, apiVersion: 'responses-v1', raw: {
    responseId: typeof raw.id === 'string' ? raw.id : null, usageMetadata,
    candidates: [{ finishReason: 'STOP' }],
  } };
}
