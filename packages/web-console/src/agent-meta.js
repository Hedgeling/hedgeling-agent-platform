import { CHAT_LIMITS } from './hackathon-engine/chat-limits.js';
import { fail } from "./workspace-actions.js";

// The stored conversation envelope is shared with the existing runtime. Meta's
// opaque replay items stay server-side and are never rendered as chat messages.
export function metaRequest({ model, history, tools, instructions }) {
  const input = [];
  const pending = new Map();
  const remember = (name, id) => pending.set(name, [...(pending.get(name) || []), id]);
  for (const [turn, content] of history.entries()) {
    if (content.role === "model" && content.providerState?.provider === "meta") {
      input.push(...content.providerState.output);
      for (const item of content.providerState.output) if (item.type === "function_call") remember(item.name, item.call_id);
      continue;
    }
    const text = (content.parts || []).filter((part) => typeof part.text === "string" && !part.thought).map((part) => part.text).join("\n");
    if (text) input.push({ role: content.role === "model" ? "assistant" : "user", content: [{ type: content.role === "model" ? "output_text" : "input_text", text }] });
    for (const [index, part] of (content.parts || []).entries()) {
      if (part.functionCall) {
        const call = part.functionCall;
        const id = call.id || `legacy_${turn}_${index}`;
        remember(call.name, id);
        input.push({ type: "function_call", call_id: id, name: call.name, arguments: JSON.stringify(call.args || {}) });
      }
      if (part.functionResponse) {
        const response = part.functionResponse;
        const ids = pending.get(response.name) || [];
        const id = response.id || ids[0];
        if (!id || !ids.includes(id)) throw fail(409, "This conversation cannot be resumed with the configured provider. Start a new conversation.");
        pending.set(response.name, ids.filter((candidate) => candidate !== id));
        input.push({ type: "function_call_output", call_id: id, output: JSON.stringify(response.response) });
      }
    }
  }
  return {
    model, instructions, input, store: false,
    include: ["reasoning.encrypted_content"], reasoning: { effort: "low" },
    max_output_tokens: CHAT_LIMITS.outputTokens,
    tools: tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
    parallel_tool_calls: false,
  };
}

export function normalizeMetaResponse(raw) {
  if (raw.status !== "completed" || !Array.isArray(raw.output)) throw fail(502, "The assistant did not finish its answer. Try a shorter request.", "agent_provider_incomplete");
  const parts = [];
  const output = [];
  const ids = new Set();
  for (const item of raw.output) {
    if (item.type === "reasoning") {
      if (typeof item.encrypted_content === "string") output.push({ ...item, summary: item.summary || [] });
    } else if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      output.push(item);
      for (const block of item.content) {
        if (block.type === "output_text" && typeof block.text === "string") parts.push({ text: block.text });
        else if (block.type === "refusal" && typeof block.refusal === "string") parts.push({ text: block.refusal });
      }
    } else if (item.type === "function_call") {
      let args;
      try { args = JSON.parse(item.arguments); } catch { throw fail(502, "The assistant returned an invalid tool request."); }
      if (!item.call_id || ids.has(item.call_id) || typeof item.name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) throw fail(502, "The assistant returned an invalid tool request.");
      ids.add(item.call_id);
      output.push(item);
      parts.push({ functionCall: { id: item.call_id, name: item.name, args } });
    }
  }
  if (!parts.length) throw fail(502, "The assistant did not return a usable answer. Try rephrasing your request.");
  const usage = raw.usage;
  const valid = (n) => Number.isSafeInteger(n) && n >= 0;
  const measured = usage && valid(usage.input_tokens) && valid(usage.output_tokens) && valid(usage.total_tokens)
    && usage.total_tokens >= usage.input_tokens + usage.output_tokens;
  return {
    candidates: [{ content: { role: "model", parts, providerState: { provider: "meta", output } } }],
    ...(measured ? { usageMetadata: {
      promptTokenCount: usage.input_tokens, candidatesTokenCount: usage.output_tokens, totalTokenCount: usage.total_tokens,
      cachedContentTokenCount: usage.input_tokens_details?.cached_tokens,
      thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens,
    } } : {}),
  };
}

export async function generateMetaResponse({ config, body, signal, fetchImpl = fetch }) {
  signal.throwIfAborted();
  const response = await fetchImpl("https://api.meta.ai/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(CHAT_LIMITS.providerTimeoutMs)]), redirect: "error",
  });
  if (!response.ok) throw fail(502, `The model service could not complete this turn (${response.status}). Try again.`, "agent_provider_failed");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CHAT_LIMITS.providerResponseBytes) { await reader.cancel(); throw fail(502, "The model response exceeded its size limit"); }
    chunks.push(value);
  }
  let raw;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail(502, "The model service returned an invalid response."); }
  return normalizeMetaResponse(raw);
}
