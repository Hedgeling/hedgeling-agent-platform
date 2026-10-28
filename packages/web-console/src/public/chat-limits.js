// SPDX-License-Identifier: Apache-2.0
// Application bounds, distinct from a provider's native context window and
// an organization's separately metered included-chat allowances.
export const CHAT_LIMITS = Object.freeze({
  requestBytes: 750000,
  historyEntries: 1000,
  messageCharacters: 24000,
  outputTokens: 4096,
  displayedReplyCharacters: 24000,
  stepsPerTurn: 16,
  toolCallsPerStep: 8,
  providerTimeoutMs: 90000,
  providerResponseBytes: 524288,
  eventPageSize: 250,
});

export function chatRequestBudget(body) {
  const requestBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (requestBytes > CHAT_LIMITS.requestBytes) {
    throw Object.assign(new Error('This conversation reached its 750 KB request limit, including tool results. Start a new conversation; your saved work is still available.'), { status: 400, code: 'agent_context_limit' });
  }
  // Reserve conservatively, then reconcile against provider-reported tokens.
  // Serialized bytes are a bound, not a claim about actual tokenization.
  return { requestBytes, reservedTokens: requestBytes + CHAT_LIMITS.outputTokens };
}
