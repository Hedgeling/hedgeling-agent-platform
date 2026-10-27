import { query, withTransaction } from "./db.js";
import { fail, fingerprint } from "./workspace-actions.js";
import { agentInstructions } from "./agent-skills.js";
import { reserveUsage, recordUsageEvent, geminiTokenMeasurements } from "./usage.js";
import { requireChatAccess } from "./chat-access.js";
import { metaRequest, generateMetaResponse } from "./agent-meta.js";

export function providerConfiguration() {
  const provider = process.env.HEDGELING_AGENT_PROVIDER || "gemini";
  if (!["gemini", "meta", "fixture"].includes(provider)) throw fail(503, "The configured assistant provider is not supported.", "agent_provider_unconfigured");
  const fixture = provider === "fixture";
  if (fixture && !(process.env.NODE_ENV !== "production" && process.env.HEDGELING_AUTH_MODE === "local")) throw fail(503, "The demo provider is restricted to local troubleshooting");
  if (provider === "meta") {
    const model = process.env.HEDGELING_AGENT_META_MODEL?.trim() || "";
    const key = process.env.HEDGELING_META_API_KEY?.trim() || "";
    return { provider, fixture: false, model, key, ready: Boolean(model && key) };
  }
  const model = process.env.HEDGELING_AGENT_GEMINI_MODEL || process.env.HEDGELING_GEMINI_MODEL || "";
  const key = process.env.HEDGELING_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
  return { provider, fixture, model, key, ready: fixture || Boolean(model && key) };
}
function fixtureTurn(history, organizationId) {
  const last = history.at(-1);
  const response = last?.parts?.find((p) => p.functionResponse)?.functionResponse;
  // Only the server-written confirmation checkpoint carries this flag; user
  // text that merely mimics the sentinel is treated as an ordinary message.
  const confirmation = last?.confirmation ? last.parts?.find((p) => p.text?.startsWith("Confirmed result: ")) : null;
  const part = (name, args) => ({ role: "model", parts: [{ functionCall: { name, args } }] });
  if (confirmation) {
    const result = JSON.parse(confirmation.text.slice("Confirmed result: ".length));
    if (result.addedLocales) return { role: 'model', parts: [{ text: `Added ${result.addedLocales.join(', ')} to your project after confirmation. Choose a translation action when you’re ready.` }] };
    if (result.extraction) return part('console_get_extraction', { projectSlug: result.extraction.projectSlug, extractionId: result.extraction.id });
    if (result.import) return { role: 'model', parts: [{ text: 'Your source strings were imported after confirmation. Existing translations were preserved.' }] };
    if (result.uiTarget?.action?.endsWith(".update")) return { role: "model", parts: [{ text: "Saved your confirmed changes. You can see the updated item in Projects." }] };
    if (result.organization) return part("console_propose_business_unit", { organizationId: result.organization.id, name: "Product" });
    if (result.businessUnit) return part("console_propose_project", { businessUnitId: result.businessUnit.id, name: "Website", sourceLocale: "en", targetLocales: ["fr", "de"] });
    if (result.project) return part("console_propose_localization_job", { projectSlug: result.project.slug, name: "Website launch", targetLocales: ["fr", "de"], steps: ["machine_translation", "review"] });
    if (result.job) return { role: "model", parts: [{ text: "Your organization, Product business unit, Website project and localization-job draft are ready. The project has no source content yet. Import content before starting translation; no paid work has started." }] };
  }
  const rename = !response?.name?.endsWith("_update") && fixtureRename(history, organizationId, part);
  if (rename) return rename;
  // Explicit synthetic prompts for local browser/MCP tests. Production Meta
  // follows the extraction skill using these same authenticated tools.
  const lastUser = history.findLast(item => item.role === 'user' && !item.confirmation && item.parts?.some(p => p.text));
  const extractionPrompt = /^Extract source from project "([^"]+)" at "([^"]+)" in "([^"]+)"\.?$/.exec(lastUser?.parts?.map(p => p.text || '').join(' ') || '');
  if (response?.name === 'console_list_source_connections' && extractionPrompt) {
    const connections = response.response.connections || [];
    if (connections.length !== 1) return { role: 'model', parts: [{ text: 'Choose one connected repository before extracting.' }] };
    return part('console_propose_extraction', { projectSlug: extractionPrompt[1], connectionId: connections[0].connectionId, ref: extractionPrompt[2], scanRoots: [extractionPrompt[3]] });
  }
  const languagePrompt = /^Add locales "([^"]+)" to project "([^"]+)"\.?$/.exec(lastUser?.parts?.map(p => p.text || '').join(' ') || '');
  if (languagePrompt && !confirmation) {
    if (!response) return part('console_get_project_locales', { projectSlug: languagePrompt[2] });
    if (response.name === 'console_get_project_locales' && !response.response.error) return part('console_propose_project_locales', { projectSlug: languagePrompt[2], targetLocales: languagePrompt[1].split(',').map(value => value.trim()) });
  }
  if (!response && !confirmation && extractionPrompt) return part('console_list_source_connections', { projectSlug: extractionPrompt[1] });
  const importPrompt = /^Review importing extraction ([a-f0-9-]{36}) into project ([\w-]+)\./.exec(lastUser?.parts?.map(p => p.text || '').join(' ') || '');
  if (!response && !confirmation && importPrompt) return part('console_propose_extraction_import', { projectSlug: importPrompt[2], extractionId: importPrompt[1] });
  if (response?.name === "console_report_workspace" && response.response.metrics) {
    const m = response.response.metrics;
    return { role: "model", parts: [{ text: `Across the projects you can access: ${m.projects} projects, ${m.businessUnits} business units, and ${m.jobs} localization-job drafts. These totals cover all permitted matches, not just the first page. Translation execution is not included.` }] };
  }
  if (response?.name === "console_report_jobs" && response.response.totals) return { role: "model", parts: [{ text: `There are ${response.response.totals.jobs} matching job drafts across ${response.response.totals.projectsWithJobs} projects you can access. ${response.response.page.hasMore ? "More breakdown groups are available." : "This breakdown includes all groups."}` }] };
  if (response) return { role: "model", parts: [{ text: response.response?.error ? response.response.error : "Here is the current workspace information. Use the workspace page to inspect it." }] };
  const message = last?.parts?.map((p) => p.text || "").join(" ") || "";
  if (organizationId && /(?:report|summary|overview|how many)/i.test(message)) return /jobs?/i.test(message)
    ? part("console_report_jobs", { organizationId, groupBy: "status" }) : part("console_report_workspace", { organizationId });
  if (/set up (?:a )?demo workspace/i.test(message)) return part("console_propose_organization", { name: "Demo organization" });
  return organizationId ? part("console_list_projects", {}) : part("console_list_organizations", {});
}

// A deliberately narrow local demo path. Real Gemini uses the same tools and
// management skill for broader editing requests. Discovery still uses real MCP.
function fixtureRename(history, organizationId, call) {
  const messageIndex = history.findLastIndex((item) => item.role === "user" && !item.confirmation && item.parts?.some((p) => p.text));
  const message = history[messageIndex]?.parts?.map((p) => p.text || "").join(" ") || "";
  const match = /^rename (organization|business unit|project|job)\s+"([^"]+)"\s+to\s+"([^"]+)"[.!]?$/i.exec(message.trim());
  if (!match) return null;
  const answer = (text) => ({ role: "model", parts: [{ text }] });
  if (!organizationId) return answer("Choose the organization in Working in first, then ask me to rename the item.");
  const [, kind, currentName, name] = match;
  const spec = {
    organization: ["console_list_organizations", "organizations", "console_propose_organization_update", "organizationId", { search: currentName, limit: 100 }],
    "business unit": ["console_get_workspace", "businessUnits", "console_propose_business_unit_update", "businessUnitId", { organizationId, limit: 100 }],
    project: ["console_list_projects", "projects", "console_propose_project_update", "projectSlug", { organizationId, search: currentName, limit: 100 }],
    job: ["console_list_localization_jobs", "jobs", "console_propose_localization_job_update", "jobId", { organizationId, search: currentName, limit: 100 }],
  }[kind.toLowerCase()];
  const [tool, collection, update, idField, input] = spec;
  const replies = history.slice(messageIndex + 1).flatMap((item) => item.parts || []).filter((part) => part.functionResponse?.name === tool).map((part) => part.functionResponse.response);
  if (!replies.length) return call(tool, input);
  const last = replies.at(-1);
  if (last.error) return answer(last.error);
  const page = collection === "businessUnits" ? last.pages.businessUnits : last.page;
  if (page.hasMore) return call(tool, { ...input, [collection === "businessUnits" ? "businessUnitCursor" : "cursor"]: page.nextCursor });
  const matches = replies.flatMap((reply) => reply[collection] || []).filter((row) => row.name.toLowerCase() === currentName.toLowerCase());
  if (matches.length !== 1) return answer(matches.length ? `Several items are named “${currentName}”. Please use the item's Edit control in Projects to choose the right one.` : `I couldn't find “${currentName}” in this organization. Check the name in Projects and try again.`);
  return call(update, { [idField]: idField === "projectSlug" ? matches[0].slug : matches[0].id, name });
}
export async function nextAgentTurn({ run, auth, history, tools, signal }, { checkAccess = requireChatAccess } = {}) {
  const chat = await checkAccess(run.organization_id);
  const config = providerConfiguration();
  if (!config.ready) throw fail(503, "The assistant is unavailable. You can continue using the console manually.", "agent_provider_unconfigured");
  if (config.fixture) return fixtureTurn(history, run.organization_id);
  const body = config.provider === "meta" ? metaRequest({ model: config.model, history, tools, instructions: agentInstructions(run.organization_id) }) : {
    systemInstruction: { parts: [{ text: agentInstructions(run.organization_id) }] },
    // Strip the server-side confirmation marker; it is not part of the API.
    contents: history.map(({ role, parts }) => ({ role, parts })),
    tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }],
    generationConfig: { maxOutputTokens: 2048 },
  };
  const serialized = JSON.stringify(body);
  const estimate = Buffer.byteLength(serialized) + 2048;
  if (estimate > 100000) throw fail(400, "This conversation is full. Start a new conversation to continue.");
  const usage = await withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-budget:${auth.user.id}`]);
    const used = (await client.query("select coalesce(sum(coalesce(actual_tokens,reserved_tokens)),0)::bigint as tokens from agent_model_usage where user_id=$1 and created_at >= date_trunc('day',now())", [auth.user.id])).rows[0];
    if (Number(used.tokens) + estimate > Math.min(Number(chat.limits?.dailyUserTokens) || 500000, 500000)) throw fail(429, "Your daily included chat allowance has been reached. You can continue manually and chat again tomorrow.");
    return (await client.query("insert into agent_model_usage(run_id,user_id,organization_id,model,reserved_tokens) values($1,$2,$3,$4,$5) returning id", [run.id, auth.user.id, run.organization_id, config.model, estimate])).rows[0];
  });
  const scope = { organizationId: run.organization_id, operation: "agent_chat", idempotencyKey: `agent-chat:${usage.id}`, idempotencyFingerprint: fingerprint(body), actor: { actorType: "user", actorUserId: auth.user.id } };
  let reservation;
  let raw;
  let dispatched = false;
  let succeeded = false;
  try {
    if (run.organization_id) reservation = await reserveUsage({ ...scope, measurements: { agent_chat_tokens: estimate },
      planLimits: { usage: { agent_chat_tokens: { limit: Number(chat.limits?.periodOrganizationTokens) || 2000000, warningPercent: 80, enforcement: "block" } } } });
    signal.throwIfAborted();
    dispatched = true;
    raw = await (config.provider === "meta" ? generateMetaResponse : generateGeminiResponse)({ config, body, signal });
    const content = raw.candidates?.[0]?.content;
    if (!Array.isArray(content?.parts) || !content.parts.length) throw fail(502, "The assistant did not return a usable answer. Try rephrasing your request.");
    succeeded = true;
    return content;
  } finally {
    // Unknown provider outcomes retain a conservative charge instead of
    // releasing a reservation for a request that may already have been billed.
    const actual = raw?.usageMetadata ? geminiTokenMeasurements(raw.usageMetadata) : { llm_total_tokens: dispatched ? estimate : 0 };
    const outcome = succeeded ? "succeeded" : raw ? "unusable_response" : dispatched ? "unknown" : "not_dispatched";
    try {
      await query("update agent_model_usage set actual_tokens=$2,outcome=$3 where id=$1", [usage.id, actual.llm_total_tokens, outcome]);
      if (reservation) await recordUsageEvent({ ...scope, reservationId: reservation.id, attemptNumber: reservation.attemptNumber,
        outcome: succeeded ? "succeeded" : "failed", measurements: { ...actual, agent_chat_tokens: actual.llm_total_tokens }, metadata: { runId: run.id, provider: config.provider, model: config.model, outcome, billingCategory: "included_chat", customerCharge: 0, estimated: !raw?.usageMetadata } });
    } catch (recordError) {
      // A successful turn must not be returned without its usage recorded, but
      // a bookkeeping failure must never mask the original provider error.
      if (succeeded) throw recordError;
      console.error("Failed to record agent usage after a provider error", recordError);
    }
  }
}

// The HTTP boundary is isolated so provider protocol and cancellation can be
// verified without credentials or paid inference. Preserve complete model parts
// (including thought signatures) in private server-side conversation history.
export async function generateGeminiResponse({ config, body, signal, fetchImpl = fetch }) {
  signal.throwIfAborted();
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": config.key }, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]), redirect: "error",
  });
  if (!response.ok) throw fail(502, `The model service could not complete this turn (${response.status}). Try again.`, "agent_provider_failed");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 524288) { await reader.cancel(); throw fail(502, "The model response exceeded its size limit"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
